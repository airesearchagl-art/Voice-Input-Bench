import { sha256OfText } from '@/lib/hash';
import { createResultId } from '@/lib/resultId';
import { LocalResultStore } from '@/storage/LocalResultStore';
import { LocalRunStore } from '@/storage/LocalRunStore';
import { isBlankTranscript, toCanonicalTranscript } from './canonicalTranscript';
import { RESULT_SCHEMA_VERSION, type ResultV1 } from './resultSchema';
import { verifyRunEvidence } from './runEvidence';
import { resolveDeliveryPath, resolveTool } from './tools';

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

/** A stored Result plus its transcript, as the UI lists them. */
export interface ResultListEntry {
  result: ResultV1;
  transcript: string;
}

/**
 * Results attached to one Run, oldest first.
 *
 * Filtering happens on the stored `run_id`, not on a directory layout, so a
 * Result can never be listed under a Run it does not cite.
 */
export async function listResultsForRun(
  resultStore: LocalResultStore,
  runId: string,
): Promise<ResultListEntry[]> {
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
    if (typeof stored !== 'object' || stored === null) continue;

    const result = stored as ResultV1;
    if (result.run_id !== runId) continue;

    const transcript = await resultStore.readTranscript(resultId).catch(() => null);
    if (transcript === null) continue;

    entries.push({ result, transcript });
  }

  return entries.sort((a, b) => a.result.result_id.localeCompare(b.result.result_id));
}
