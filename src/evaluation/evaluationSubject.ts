import { readFile } from 'node:fs/promises';
import { sha256OfText } from '@/lib/hash';
import { isValidResultId } from '@/lib/resultId';
import { LocalRunStore, SOURCE_FILE } from '@/storage/LocalRunStore';
import type { LocalResultStore } from '@/storage/LocalResultStore';
import type { ResultV2 } from '@/results/resultSchema';
import { isSealedResult } from '@/results/resultSchema';
import { verifyRunEvidence, type VerifiedRunEvidence } from '@/results/runEvidence';
import {
  verifyStoredResultMetadata,
  verifyTranscriptAgainstResult,
} from '@/results/verifyStoredResult';

/**
 * What an Evaluation is about, resolved from disk.
 *
 * Nothing here comes from a request body. The caller names a Result; everything
 * else — which Run, which audio, which canonical text, which tool — is read out
 * of the stored Result and re-verified against the Run as it stands now. A CER
 * computed against a Run the client merely claimed would not be a measurement
 * of anything.
 *
 * Both create and readback go through this, so an Evaluation is re-derived from
 * the same evidence chain that produced it rather than compared against itself.
 */

export type EvaluationSubjectErrorKind =
  /** The named Result is missing, unparseable, or not a Result at all. */
  | 'EVALUATION_RESULT_UNREADABLE'
  /**
   * The Result is readable but unsealed — a legacy v1 Result.
   *
   * It is a real observation and stays visible in P2-A, but nothing proves its
   * `tool` section is the one it was written with. A per-tool CER built on that
   * would attach a number to a tool that may not have produced the transcript.
   */
  | 'EVALUATION_RESULT_NOT_SEALED'
  /** The Run's `source.txt` could not be read. */
  | 'EVALUATION_SOURCE_UNREADABLE'
  /** The Run's `source.txt` no longer hashes to what its manifest recorded. */
  | 'EVALUATION_SOURCE_HASH_MISMATCH';

export class EvaluationSubjectError extends Error {
  readonly kind: EvaluationSubjectErrorKind;
  readonly detail?: string;

  constructor(kind: EvaluationSubjectErrorKind, message: string, detail?: string) {
    super(message);
    this.name = 'EvaluationSubjectError';
    this.kind = kind;
    this.detail = detail;
  }
}

export interface EvaluationSubject {
  runId: string;
  resultId: string;
  runEvidence: VerifiedRunEvidence;
  /** Sealed, and re-verified against the Run just now. */
  result: ResultV2;
  /** The Run's canonical `source.txt`, exactly as stored. */
  referenceText: string;
  /** The Result's `transcript.txt`, exactly as stored. */
  hypothesisText: string;
}

export interface EvaluationSubjectDeps {
  runStore: LocalRunStore;
  resultStore: LocalResultStore;
}

/**
 * Where a subject's evidence comes from.
 *
 * On disk, for creation and for every listing. A Report re-check supplies a
 * reader over the exact bytes its ReportSource froze instead, so readback there
 * can never reach a file the report did not pin. The checks made on what is
 * read are the same either way: they live in `resolveEvaluationSubjectWith`.
 */
export interface EvaluationSubjectReader {
  readResult(resultId: string): Promise<unknown>;
  readTranscript(resultId: string): Promise<string>;
  readSource(runId: string): Promise<string>;
  verifyRun(runId: string): Promise<VerifiedRunEvidence>;
}

export function diskSubjectReader(deps: EvaluationSubjectDeps): EvaluationSubjectReader {
  return {
    readResult: (resultId) => deps.resultStore.readResult(resultId),
    readTranscript: (resultId) => deps.resultStore.readTranscript(resultId),
    readSource: (runId) => readFile(deps.runStore.resolveRunFile(runId, SOURCE_FILE), 'utf8'),
    verifyRun: (runId) => verifyRunEvidence(deps.runStore, runId),
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Read and verify everything one Evaluation compares.
 *
 * Order matters: the Result names its Run, the Run is verified first, and the
 * Result is then checked against that fresh verification. Anything short of a
 * fully verified pair throws — a partial answer here would become a stored
 * number that looks exactly like a measured one.
 */
export async function resolveEvaluationSubject(
  deps: EvaluationSubjectDeps,
  resultId: string,
): Promise<EvaluationSubject> {
  return resolveEvaluationSubjectWith(diskSubjectReader(deps), resultId);
}

/** `resolveEvaluationSubject`, reading through `reader`. Same checks, same order. */
export async function resolveEvaluationSubjectWith(
  reader: EvaluationSubjectReader,
  resultId: string,
): Promise<EvaluationSubject> {
  if (!isValidResultId(resultId)) {
    throw new EvaluationSubjectError(
      'EVALUATION_RESULT_UNREADABLE',
      `result id の形式が不正です: ${JSON.stringify(resultId)}`,
    );
  }

  let stored: unknown;
  try {
    stored = await reader.readResult(resultId);
  } catch (cause) {
    throw new EvaluationSubjectError(
      'EVALUATION_RESULT_UNREADABLE',
      `Result ${resultId} を読み込めません。`,
      cause instanceof Error ? cause.message : String(cause),
    );
  }

  if (!isPlainObject(stored) || typeof stored.run_id !== 'string') {
    throw new EvaluationSubjectError(
      'EVALUATION_RESULT_UNREADABLE',
      'result.json が run_id を持つオブジェクトではありません。',
    );
  }

  // The Result names its Run. Verify that Run from disk before believing
  // anything else the Result says about it.
  const runId = stored.run_id;
  const runEvidence = await reader.verifyRun(runId);

  const { result, integrityTrust } = verifyStoredResultMetadata({
    resultId,
    stored,
    requestedRunId: runId,
    runEvidence,
  });

  if (integrityTrust !== 'sealed' || !isSealedResult(result)) {
    throw new EvaluationSubjectError(
      'EVALUATION_RESULT_NOT_SEALED',
      `Result ${resultId} は integrity 署名を持たない legacy (schema v${result.schema_version}) です。raw-char-v1 の strict evaluation の対象外です。`,
      `integrity_trust=${integrityTrust} schema_version=${result.schema_version}`,
    );
  }

  const hypothesisText = await reader.readTranscript(resultId);
  verifyTranscriptAgainstResult({
    resultId,
    result,
    transcript: hypothesisText,
    transcriptBytes: Buffer.byteLength(hypothesisText, 'utf8'),
  });

  // The canonical text, read as its own bytes rather than taken on trust from
  // the Run verification that just passed. These are the exact characters the
  // comparison will run over.
  let referenceText: string;
  try {
    referenceText = await reader.readSource(runId);
  } catch (cause) {
    throw new EvaluationSubjectError(
      'EVALUATION_SOURCE_UNREADABLE',
      `Run ${runId} の source.txt を読み込めません。`,
      cause instanceof Error ? cause.message : String(cause),
    );
  }

  const referenceSha = sha256OfText(referenceText);
  if (referenceSha !== runEvidence.sourceSha256) {
    throw new EvaluationSubjectError(
      'EVALUATION_SOURCE_HASH_MISMATCH',
      'source.txt が Run manifest の SHA-256 と一致しません。',
      `expected=${runEvidence.sourceSha256} actual=${referenceSha}`,
    );
  }

  return { runId, resultId, runEvidence, result, referenceText, hypothesisText };
}
