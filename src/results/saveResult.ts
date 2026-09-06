import { sha256OfText } from '@/lib/hash';
import { createResultId } from '@/lib/resultId';
import { LocalResultStore } from '@/storage/LocalResultStore';
import { LocalRunStore } from '@/storage/LocalRunStore';
import { isBlankTranscript, toCanonicalTranscript } from './canonicalTranscript';
import { RESULT_SCHEMA_VERSION, type ResultV1 } from './resultSchema';
import { verifyRunEvidence } from './runEvidence';
import { resolveDeliveryPath, resolveTool } from './tools';
import { assertRootIsolation } from '@/storage/rootIsolation';
import { ResultVerificationError, verifyStoredResult } from './verifyStoredResult';

/**
 * One manual STT observation → one immutable Result.
 *
 * The Run is verified from disk first, so the Result's `run_evidence` describes
 * audio that actually exists and still hashes to what its manifest recorded.
 * The transcript is stored exactly as pasted, modulo line endings.
 *
 * The Phase 1 Run is only read. Nothing here writes to `data/runs/`.
 */

export type SaveResultErrorKind =
  /** The pasted transcript was empty. */
  'EMPTY_TRANSCRIPT';

export class SaveResultError extends Error {
  readonly kind: SaveResultErrorKind;

  constructor(kind: SaveResultErrorKind, message: string) {
    super(message);
    this.name = 'SaveResultError';
    this.kind = kind;
  }
}

export interface SaveResultInput {
  runId: string;
  toolId: unknown;
  customToolName?: string | null;
  toolVersion?: string | null;
  deliveryPath: unknown;
  /** Raw text as pasted. Canonicalized here, once. */
  rawTranscript: string;
}

export interface SaveResultDeps {
  runStore: LocalRunStore;
  resultStore: LocalResultStore;
  /** Injected in tests so result IDs and timestamps are deterministic. */
  now?: () => Date;
  resultId?: string;
}

export interface SaveResultOutcome {
  resultId: string;
  resultDir: string;
  result: ResultV1;
}

export async function saveManualSttResult(
  input: SaveResultInput,
  deps: SaveResultDeps,
): Promise<SaveResultOutcome> {
  const now = deps.now ?? (() => new Date());

  // 0. Refuse a configuration where a Result could land inside the Run tree.
  //    Checked before anything is written, and before the Run is even read.
  assertRootIsolation(deps.runStore.rootDir, deps.resultStore.rootDir);

  // 1. Tool and delivery path. Built-in tool names come from the registry, not
  //    from the request.
  const tool = resolveTool({
    toolId: input.toolId,
    customToolName: input.customToolName,
    toolVersion: input.toolVersion,
  });
  const deliveryPath = resolveDeliveryPath(input.deliveryPath);

  // 2. Canonical transcript, produced once and reused for storage and hashing.
  const transcript = toCanonicalTranscript(input.rawTranscript);
  if (isBlankTranscript(transcript)) {
    throw new SaveResultError('EMPTY_TRANSCRIPT', 'transcript が空です。');
  }

  // 3. Verify the Run from disk. Anything unverified stops here, before a
  //    Result exists.
  const evidence = await verifyRunEvidence(deps.runStore, input.runId);

  const capturedAt = now().toISOString();
  const resultId = deps.resultId ?? createResultId(now());
  const transcriptBytes = Buffer.from(transcript, 'utf8');

  const result: ResultV1 = {
    schema_version: RESULT_SCHEMA_VERSION,
    result_id: resultId,
    run_id: evidence.runId,
    captured_at: capturedAt,
    tool: {
      id: tool.id,
      name: tool.name,
      version: tool.version,
    },
    capture: {
      method: 'manual-paste',
      delivery_path: deliveryPath,
    },
    run_evidence: {
      manifest_schema_version: evidence.manifestSchemaVersion,
      test_id: evidence.testId,
      source_sha256: evidence.sourceSha256,
      audio_sha256: evidence.audioSha256,
    },
    transcript: {
      file: 'transcript.txt',
      encoding: 'utf-8',
      line_endings: 'lf',
      sha256: sha256OfText(transcript),
      bytes: transcriptBytes.byteLength,
    },
  };

  // 4. Transactional write. Nothing under `resultId` exists until this succeeds.
  const stored = await deps.resultStore.saveResult(resultId, {
    transcriptText: transcript,
    resultJson: Buffer.from(`${JSON.stringify(result, null, 2)}\n`, 'utf8'),
  });

  return { resultId: stored.resultId, resultDir: stored.resultDir, result };
}

/**
 * A stored Result as the UI lists it.
 *
 * A Result that fails verification is reported as `rejected` rather than
 * silently dropped: a tampered or stale Result is something the operator needs
 * to see, and surfacing it is not the same as presenting it as an observation.
 */
export type ResultListEntry =
  | { status: 'verified'; resultId: string; result: ResultV1; transcript: string }
  | { status: 'rejected'; resultId: string; reason: string; message: string; detail?: string };

/**
 * Results attached to one Run, oldest first.
 *
 * The Run is verified once, freshly, before any Result is considered. Each
 * Result is then re-checked against its directory, its transcript on disk, and
 * that fresh Run evidence. Filtering happens on the stored `run_id`, not on a
 * directory layout, so a Result can never be listed under a Run it does not
 * cite.
 *
 * If the Run itself cannot be verified the whole listing fails: no Result about
 * a Run whose artifacts no longer match its manifest can be trusted.
 */
export async function listResultsForRun(
  deps: { runStore: LocalRunStore; resultStore: LocalResultStore },
  runId: string,
): Promise<ResultListEntry[]> {
  const { runStore, resultStore } = deps;

  assertRootIsolation(runStore.rootDir, resultStore.rootDir);

  const runEvidence = await verifyRunEvidence(runStore, runId);
  const entries: ResultListEntry[] = [];

  for (const resultId of await resultStore.listResultIds()) {
    let stored: unknown;
    try {
      stored = await resultStore.readResult(resultId);
    } catch {
      // A directory that is not a readable Result is skipped rather than
      // breaking the whole listing.
      continue;
    }

    // Only Results that claim this Run are this listing's business. A claim
    // about another Run is not a failure here, so it is skipped quietly.
    if (!isPlainObject(stored) || stored.run_id !== runId) continue;

    const transcript = await resultStore.readTranscript(resultId).catch(() => null);
    if (transcript === null) {
      entries.push({
        status: 'rejected',
        resultId,
        reason: 'RESULT_TRANSCRIPT_MISSING',
        message: 'transcript.txt を読み込めません。',
      });
      continue;
    }

    try {
      const result = verifyStoredResult({
        resultId,
        stored,
        transcript,
        transcriptBytes: Buffer.byteLength(transcript, 'utf8'),
        requestedRunId: runId,
        runEvidence,
      });
      entries.push({ status: 'verified', resultId, result, transcript });
    } catch (caught) {
      if (caught instanceof ResultVerificationError) {
        entries.push({
          status: 'rejected',
          resultId,
          reason: caught.kind,
          message: caught.message,
          detail: caught.detail,
        });
        continue;
      }
      throw caught;
    }
  }

  return entries.sort((a, b) => a.resultId.localeCompare(b.resultId));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
