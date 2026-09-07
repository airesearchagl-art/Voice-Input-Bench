import { sha256OfText } from '@/lib/hash';
import { isValidResultId } from '@/lib/resultId';
import type { ResultV1 } from './resultSchema';
import { RESULT_SCHEMA_VERSION } from './resultSchema';
import type { VerifiedRunEvidence } from './runEvidence';
import {
  ToolIdentityError,
  verifyStoredToolIdentity,
  type ToolIdentityErrorKind,
} from './verifyToolIdentity';

/**
 * Verification of a Result read back from disk.
 *
 * A stored Result is only useful if it still describes what it claims to. It is
 * re-checked on every read rather than trusted because it was written by this
 * app: the file may have been edited, moved between directories, or left behind
 * while the Run it cites changed underneath it.
 *
 * A Result that fails any of these checks is never shown as an observation.
 */

export type ResultVerificationErrorKind =
  /** `result.json` is not an object, or not schema v1. */
  | 'RESULT_SCHEMA_UNSUPPORTED'
  /** A field the schema requires is missing or the wrong type. */
  | 'RESULT_MALFORMED'
  /** `result_id` does not match the directory the Result is stored in. */
  | 'RESULT_ID_MISMATCH'
  /** `run_id` is not the Run this listing is for. */
  | 'RESULT_RUN_ID_MISMATCH'
  /** The transcript section names a different file or encoding contract. */
  | 'RESULT_TRANSCRIPT_CONTRACT_MISMATCH'
  /** The transcript on disk no longer hashes to the recorded value. */
  | 'RESULT_TRANSCRIPT_HASH_MISMATCH'
  /** The transcript on disk is a different length than recorded. */
  | 'RESULT_TRANSCRIPT_BYTES_MISMATCH'
  /** The Result's run evidence disagrees with the Run as it is now. */
  | 'RESULT_RUN_EVIDENCE_MISMATCH'
  /** The tool, capture or timestamp contract no longer holds. */
  | ToolIdentityErrorKind;

export class ResultVerificationError extends Error {
  readonly kind: ResultVerificationErrorKind;
  readonly resultId: string;
  readonly detail?: string;

  constructor(
    kind: ResultVerificationErrorKind,
    resultId: string,
    message: string,
    detail?: string,
  ) {
    super(message);
    this.name = 'ResultVerificationError';
    this.kind = kind;
    this.resultId = resultId;
    this.detail = detail;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Check a stored Result against its directory, its transcript on disk, and the
 * Run as it stands right now.
 *
 * `runEvidence` is a fresh verification of the cited Run, not the snapshot the
 * Result carries — comparing the Result against itself would prove nothing.
 */
export function verifyStoredResult(input: {
  resultId: string;
  stored: unknown;
  transcript: string;
  transcriptBytes: number;
  requestedRunId: string;
  runEvidence: VerifiedRunEvidence;
}): ResultV1 {
  const { resultId, stored, transcript, transcriptBytes, requestedRunId, runEvidence } = input;
  const fail = (kind: ResultVerificationErrorKind, message: string, detail?: string): never => {
    throw new ResultVerificationError(kind, resultId, message, detail);
  };

  if (!isValidResultId(resultId)) {
    fail('RESULT_ID_MISMATCH', `result id の形式が不正です: ${JSON.stringify(resultId)}`);
  }
  if (!isPlainObject(stored)) {
    fail('RESULT_MALFORMED', 'result.json がオブジェクトではありません。');
  }

  const raw = stored as Record<string, unknown>;

  if (raw.schema_version !== RESULT_SCHEMA_VERSION) {
    fail(
      'RESULT_SCHEMA_UNSUPPORTED',
      `Result schema v${String(raw.schema_version)} は対象外です（v${RESULT_SCHEMA_VERSION} のみ）。`,
      `schema_version=${String(raw.schema_version)}`,
    );
  }

  if (raw.result_id !== resultId) {
    fail(
      'RESULT_ID_MISMATCH',
      `result.json の result_id が保存先ディレクトリと一致しません。`,
      `directory=${resultId} result_id=${String(raw.result_id)}`,
    );
  }

  if (raw.run_id !== requestedRunId) {
    fail(
      'RESULT_RUN_ID_MISMATCH',
      `result.json の run_id が対象の Run と一致しません。`,
      `expected=${requestedRunId} actual=${String(raw.run_id)}`,
    );
  }

  const evidence = raw.run_evidence;
  const transcriptNode = raw.transcript;
  if (!isPlainObject(evidence) || !isPlainObject(transcriptNode)) {
    fail('RESULT_MALFORMED', 'result.json に必要なセクションがありません。');
  }

  // Tool identity, capture method and timestamp. These decide which column of a
  // comparison the observation belongs in, so they are re-derived rather than
  // read as given.
  try {
    verifyStoredToolIdentity(raw);
  } catch (caught) {
    if (caught instanceof ToolIdentityError) {
      fail(caught.kind, caught.message, caught.detail);
    }
    throw caught;
  }

  const transcriptSection = transcriptNode as Record<string, unknown>;
  if (
    transcriptSection.file !== 'transcript.txt' ||
    transcriptSection.encoding !== 'utf-8' ||
    transcriptSection.line_endings !== 'lf'
  ) {
    fail(
      'RESULT_TRANSCRIPT_CONTRACT_MISMATCH',
      'transcript の file / encoding / line_endings が契約と一致しません。',
      `file=${String(transcriptSection.file)} encoding=${String(transcriptSection.encoding)} line_endings=${String(transcriptSection.line_endings)}`,
    );
  }

  // The recorded line-ending contract is only true if the bytes on disk keep it.
  if (transcript.includes('\r')) {
    fail(
      'RESULT_TRANSCRIPT_CONTRACT_MISMATCH',
      'transcript.txt に CR が含まれており、line_endings: lf と矛盾します。',
    );
  }

  const actualSha = sha256OfText(transcript);
  if (transcriptSection.sha256 !== actualSha) {
    fail(
      'RESULT_TRANSCRIPT_HASH_MISMATCH',
      'transcript.txt が result.json の SHA-256 と一致しません。',
      `expected=${String(transcriptSection.sha256)} actual=${actualSha}`,
    );
  }

  if (transcriptSection.bytes !== transcriptBytes) {
    fail(
      'RESULT_TRANSCRIPT_BYTES_MISMATCH',
      'transcript.txt のバイト数が result.json と一致しません。',
      `expected=${String(transcriptSection.bytes)} actual=${transcriptBytes}`,
    );
  }

  // The Run as it stands now must still match the snapshot this Result took.
  const evidenceSection = evidence as Record<string, unknown>;
  const evidenceChecks: Array<[string, unknown, unknown]> = [
    ['manifest_schema_version', evidenceSection.manifest_schema_version, runEvidence.manifestSchemaVersion],
    ['test_id', evidenceSection.test_id, runEvidence.testId],
    ['source_sha256', evidenceSection.source_sha256, runEvidence.sourceSha256],
    ['audio_sha256', evidenceSection.audio_sha256, runEvidence.audioSha256],
  ];
  for (const [field, recorded, current] of evidenceChecks) {
    if (recorded !== current) {
      fail(
        'RESULT_RUN_EVIDENCE_MISMATCH',
        `run_evidence.${field} が現在の Run と一致しません。`,
        `recorded=${String(recorded)} current=${String(current)}`,
      );
    }
  }

  return raw as unknown as ResultV1;
}
