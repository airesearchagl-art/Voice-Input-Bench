import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { sha256OfBytes } from '@/lib/hash';
import { isValidRunId } from '@/lib/runId';
import {
  AUDIO_FILE,
  LocalRunStore,
  MANIFEST_FILE,
  PROVIDER_QUERY_FILE,
  SOURCE_FILE,
} from '@/storage/LocalRunStore';
import { MANIFEST_SCHEMA_VERSION } from '@/benchmark/manifest';

/**
 * Server-side verification of the Phase 1 Run a Result is about to cite.
 *
 * Nothing the client says about a Run is trusted. Before a Result is written,
 * the Run is read from disk, its manifest is parsed, and every artifact is
 * re-hashed and compared against what the manifest claims. A Result whose
 * `run_evidence` came from the request body would not connect the transcript to
 * any particular audio.
 *
 * Hash agreement alone is not enough: a Bundle copied into another Run's
 * directory hashes perfectly against its own manifest. The manifest must also
 * name the directory it sits in, and name this Bundle's own files.
 *
 * This module only reads. `data/runs/` is Phase 1's, and stays exactly as it
 * was written.
 */

export type RunEvidenceErrorKind =
  /** The run ID is malformed, or no such Run directory exists. */
  | 'RUN_NOT_FOUND'
  /** `manifest.json` is missing, unreadable, or not JSON. */
  | 'RUN_MANIFEST_UNREADABLE'
  /** The manifest is a schema this phase does not handle (e.g. P1-B's v1). */
  | 'RUN_MANIFEST_SCHEMA_UNSUPPORTED'
  /** The manifest is v2 but a field it must carry is missing or malformed. */
  | 'RUN_MANIFEST_INCOMPLETE'
  /** The manifest names a different Run than the directory it sits in. */
  | 'RUN_ID_MISMATCH'
  /** The manifest names artifact files other than the Run Bundle's own. */
  | 'RUN_MANIFEST_FILE_MISMATCH'
  /** A Run Bundle file named by the manifest is not on disk. */
  | 'RUN_FILE_MISSING'
  /** A Run Bundle file no longer hashes to what the manifest recorded. */
  | 'RUN_HASH_MISMATCH';

export class RunEvidenceError extends Error {
  readonly kind: RunEvidenceErrorKind;
  readonly detail?: string;

  constructor(kind: RunEvidenceErrorKind, message: string, detail?: string) {
    super(message);
    this.name = 'RunEvidenceError';
    this.kind = kind;
    this.detail = detail;
  }
}

/** What a Result records about the Run it describes, all of it verified. */
export interface VerifiedRunEvidence {
  runId: string;
  manifestSchemaVersion: number;
  testId: string;
  sourceSha256: string;
  audioSha256: string;
  /** Verified as well, though the Result schema does not carry it. */
  providerQuerySha256: string;
  generatedAt: string;
  segmentation: { strategy: string; target_max_chars: number; segment_count: number };
  voice: { speaker_name: string; style_name: string; style_id: number };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireString(source: Record<string, unknown>, key: string, where: string): string {
  const value = source[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new RunEvidenceError(
      'RUN_MANIFEST_INCOMPLETE',
      `manifest の ${where}.${key} が文字列ではありません。`,
    );
  }
  return value;
}

async function readRunFile(runDir: string, fileName: string): Promise<Uint8Array> {
  try {
    return new Uint8Array(await readFile(path.join(runDir, fileName)));
  } catch (cause) {
    throw new RunEvidenceError(
      'RUN_FILE_MISSING',
      `Run Bundle の ${fileName} を読み込めません。`,
      cause instanceof Error ? cause.message : String(cause),
    );
  }
}

/**
 * Read a Run, check it is a schema this phase understands, and confirm every
 * artifact still hashes to what its manifest recorded.
 *
 * Throws rather than returning a partial answer: anything short of a fully
 * verified Run means no Result gets written.
 */
export async function verifyRunEvidence(
  store: LocalRunStore,
  runId: string,
): Promise<VerifiedRunEvidence> {
  // 1. The run ID must be a server-generated one before it touches a path.
  if (!isValidRunId(runId)) {
    throw new RunEvidenceError('RUN_NOT_FOUND', `run id の形式が不正です: ${JSON.stringify(runId)}`);
  }
  const runDir = store.resolveRunDir(runId);

  // 2-3. The Run must exist and carry a readable manifest.
  let manifestRaw: unknown;
  const manifestBytes = await readFile(path.join(runDir, MANIFEST_FILE)).catch(() => null);
  if (!manifestBytes) {
    throw new RunEvidenceError('RUN_NOT_FOUND', `Run ${runId} が見つかりません。`);
  }
  try {
    manifestRaw = JSON.parse(manifestBytes.toString('utf8')) as unknown;
  } catch (cause) {
    throw new RunEvidenceError(
      'RUN_MANIFEST_UNREADABLE',
      `Run ${runId} の manifest.json が JSON として解釈できません。`,
      cause instanceof Error ? cause.message : String(cause),
    );
  }
  if (!isPlainObject(manifestRaw)) {
    throw new RunEvidenceError(
      'RUN_MANIFEST_UNREADABLE',
      `Run ${runId} の manifest.json がオブジェクトではありません。`,
    );
  }

  // 4. P2-A handles the current manifest schema only. P1-B's v1 Runs are left
  //    alone — not migrated, not rewritten, and not cited by a Result.
  const schemaVersion = manifestRaw.schema_version;
  if (schemaVersion !== MANIFEST_SCHEMA_VERSION) {
    throw new RunEvidenceError(
      'RUN_MANIFEST_SCHEMA_UNSUPPORTED',
      `Run ${runId} の manifest schema v${String(schemaVersion)} は P2-A の対象外です（v${MANIFEST_SCHEMA_VERSION} のみ）。`,
      `schema_version=${String(schemaVersion)}`,
    );
  }

  const source = isPlainObject(manifestRaw.source) ? manifestRaw.source : null;
  const audio = isPlainObject(manifestRaw.audio) ? manifestRaw.audio : null;
  const providerQuery = isPlainObject(manifestRaw.provider_query)
    ? manifestRaw.provider_query
    : null;
  const segmentation = isPlainObject(manifestRaw.segmentation) ? manifestRaw.segmentation : null;
  const voice = isPlainObject(manifestRaw.voice) ? manifestRaw.voice : null;

  if (!source || !audio || !providerQuery || !segmentation || !voice) {
    throw new RunEvidenceError(
      'RUN_MANIFEST_INCOMPLETE',
      `Run ${runId} の manifest に必要なセクションがありません。`,
    );
  }

  // The manifest must name the Run it is stored under. Without this, a Run
  // Bundle copied wholesale into another Run's directory verifies cleanly —
  // every file hashes correctly, because they are that other Run's files — and
  // a Result would end up citing audio that is not the audio it describes.
  const manifestRunId = requireString(manifestRaw, 'run_id', 'manifest');
  if (manifestRunId !== runId) {
    throw new RunEvidenceError(
      'RUN_ID_MISMATCH',
      `Run ${runId} の manifest が別の Run (${manifestRunId}) を名乗っています。`,
      `directory=${runId} manifest.run_id=${manifestRunId}`,
    );
  }

  // The manifest must describe this Bundle's own files, not some other layout.
  const declaredFiles: Array<[string, Record<string, unknown>, string]> = [
    ['source', source, SOURCE_FILE],
    ['audio', audio, AUDIO_FILE],
    ['provider_query', providerQuery, PROVIDER_QUERY_FILE],
  ];
  for (const [section, node, expectedName] of declaredFiles) {
    const declared = requireString(node, 'file', section);
    if (declared !== expectedName) {
      throw new RunEvidenceError(
        'RUN_MANIFEST_FILE_MISMATCH',
        `manifest の ${section}.file が "${expectedName}" ではありません。`,
        `${section}.file=${declared}`,
      );
    }
  }

  const expected = {
    [SOURCE_FILE]: requireString(source, 'sha256', 'source'),
    [AUDIO_FILE]: requireString(audio, 'sha256', 'audio'),
    [PROVIDER_QUERY_FILE]: requireString(providerQuery, 'sha256', 'provider_query'),
  };
  const testId = requireString(manifestRaw, 'test_id', 'manifest');
  const generatedAt = requireString(manifestRaw, 'generated_at', 'manifest');

  // 5-6. Re-hash every artifact and compare with the manifest.
  for (const [fileName, expectedSha] of Object.entries(expected)) {
    const actual = sha256OfBytes(await readRunFile(runDir, fileName));
    if (actual !== expectedSha) {
      throw new RunEvidenceError(
        'RUN_HASH_MISMATCH',
        `Run ${runId} の ${fileName} が manifest の SHA-256 と一致しません。`,
        `expected=${expectedSha} actual=${actual}`,
      );
    }
  }

  return {
    runId,
    manifestSchemaVersion: MANIFEST_SCHEMA_VERSION,
    testId,
    sourceSha256: expected[SOURCE_FILE]!,
    audioSha256: expected[AUDIO_FILE]!,
    providerQuerySha256: expected[PROVIDER_QUERY_FILE]!,
    generatedAt,
    segmentation: {
      strategy: typeof segmentation.strategy === 'string' ? segmentation.strategy : 'unknown',
      target_max_chars:
        typeof segmentation.target_max_chars === 'number' ? segmentation.target_max_chars : 0,
      segment_count: typeof segmentation.segment_count === 'number' ? segmentation.segment_count : 0,
    },
    voice: {
      speaker_name: typeof voice.speaker_name === 'string' ? voice.speaker_name : '',
      style_name: typeof voice.style_name === 'string' ? voice.style_name : '',
      style_id: typeof voice.style_id === 'number' ? voice.style_id : -1,
    },
  };
}

/** One entry of the read-only Run catalogue the Results UI selects from. */
export interface RunCatalogEntry {
  runId: string;
  testId: string;
  generatedAt: string;
  segmentCount: number;
  strategy: string;
  voiceLabel: string;
  audioSha256: string;
  sourceSha256: string;
}

/**
 * List the Phase 1 Runs a Result may be attached to, newest first.
 *
 * Read-only, and tolerant: a directory that is not a schema v2 Run is skipped
 * rather than failing the listing. Verification still happens per Run at save
 * time — this is only the picker.
 */
export async function listVerifiableRuns(store: LocalRunStore): Promise<RunCatalogEntry[]> {
  const entries = await readdir(store.rootDir).catch(() => [] as string[]);
  const runIds = entries.filter((entry) => isValidRunId(entry)).sort().reverse();

  const catalog: RunCatalogEntry[] = [];
  for (const runId of runIds) {
    try {
      const evidence = await verifyRunEvidence(store, runId);
      catalog.push({
        runId,
        testId: evidence.testId,
        generatedAt: evidence.generatedAt,
        segmentCount: evidence.segmentation.segment_count,
        strategy: evidence.segmentation.strategy,
        voiceLabel: `${evidence.voice.speaker_name} / ${evidence.voice.style_name}`,
        audioSha256: evidence.audioSha256,
        sourceSha256: evidence.sourceSha256,
      });
    } catch {
      // Not a Run this phase can attach Results to. Skipping keeps the picker
      // honest: everything it offers has already passed verification once.
      continue;
    }
  }

  return catalog;
}
