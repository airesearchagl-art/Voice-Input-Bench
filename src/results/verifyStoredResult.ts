import { sha256OfText } from '@/lib/hash';
import { isValidResultId } from '@/lib/resultId';
import {
  LEGACY_RESULT_SCHEMA_VERSION,
  RESULT_SCHEMA_VERSION,
  computeResultSemanticSha256,
  type IntegrityTrust,
  type ResultPayloadV2,
  type StoredResult,
} from './resultSchema';
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
 * The checks come in two steps on purpose:
 *
 *   1. {@link verifyStoredResultMetadata} — everything `result.json` asserts.
 *      Establishes *whose* observation this is and whether that claim can be
 *      trusted, without needing the transcript file at all.
 *   2. {@link verifyTranscriptAgainstResult} — the transcript bytes on disk.
 *
 * The order matters. A transcript that has gone missing is still a failure of a
 * *known* tool when the metadata is sealed and intact; establishing ownership
 * first keeps that gap attributable instead of anonymous.
 */

export type ResultVerificationErrorKind =
  /** `result.json` is not an object, or not a schema version this app reads. */
  | 'RESULT_SCHEMA_UNSUPPORTED'
  /** A field the schema requires is missing or the wrong type. */
  | 'RESULT_MALFORMED'
  /** `result_id` does not match the directory the Result is stored in. */
  | 'RESULT_ID_MISMATCH'
  /** `run_id` is not the Run this listing is for. */
  | 'RESULT_RUN_ID_MISMATCH'
  /** A sealed Result carries no readable integrity record. */
  | 'RESULT_INTEGRITY_MISSING'
  /** A sealed Result's metadata no longer hashes to what was recorded. */
  | 'RESULT_INTEGRITY_MISMATCH'
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

const SHA256_PATTERN = /^[0-9a-f]{64}$/;

export interface VerifiedResultMetadata {
  result: StoredResult;
  /** `sealed` for v2 whose hash still matches; `legacy-unsealed` for v1. */
  integrityTrust: IntegrityTrust;
}

/**
 * Check everything `result.json` asserts, against its own directory and against
 * the Run as it stands right now.
 *
 * `runEvidence` is a fresh verification of the cited Run, not the snapshot the
 * Result carries — comparing the Result against itself would prove nothing.
 */
export function verifyStoredResultMetadata(input: {
  resultId: string;
  stored: unknown;
  requestedRunId: string;
  runEvidence: VerifiedRunEvidence;
}): VerifiedResultMetadata {
  const { resultId, stored, requestedRunId, runEvidence } = input;
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
  const schemaVersion = raw.schema_version;

  // v1 is still read so P2-A Results stay visible. It is never rewritten, and
  // never carries a seal.
  if (schemaVersion !== RESULT_SCHEMA_VERSION && schemaVersion !== LEGACY_RESULT_SCHEMA_VERSION) {
    fail(
      'RESULT_SCHEMA_UNSUPPORTED',
      `Result schema v${String(schemaVersion)} は対象外です（v${LEGACY_RESULT_SCHEMA_VERSION} / v${RESULT_SCHEMA_VERSION} のみ）。`,
      `schema_version=${String(schemaVersion)}`,
    );
  }
  const sealed = schemaVersion === RESULT_SCHEMA_VERSION;

  if (raw.result_id !== resultId) {
    fail(
      'RESULT_ID_MISMATCH',
      'result.json の result_id が保存先ディレクトリと一致しません。',
      `directory=${resultId} result_id=${String(raw.result_id)}`,
    );
  }

  if (raw.run_id !== requestedRunId) {
    fail(
      'RESULT_RUN_ID_MISMATCH',
      'result.json の run_id が対象の Run と一致しません。',
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
  if (
    typeof transcriptSection.sha256 !== 'string' ||
    !SHA256_PATTERN.test(transcriptSection.sha256) ||
    typeof transcriptSection.bytes !== 'number' ||
    !Number.isInteger(transcriptSection.bytes) ||
    transcriptSection.bytes < 0
  ) {
    fail(
      'RESULT_TRANSCRIPT_CONTRACT_MISMATCH',
      'transcript の sha256 / bytes が記録として読めません。',
      `sha256=${String(transcriptSection.sha256)} bytes=${String(transcriptSection.bytes)}`,
    );
  }

  // The Run as it stands now must still match the snapshot this Result took.
  const evidenceSection = evidence as Record<string, unknown>;
  const evidenceChecks: Array<[string, unknown, unknown]> = [
    [
      'manifest_schema_version',
      evidenceSection.manifest_schema_version,
      runEvidence.manifestSchemaVersion,
    ],
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

  if (!sealed) {
    // A P2-A Result. Every check above holds, but with no seal an edit that
    // swapped one valid value for another cannot be ruled out.
    return { result: raw as unknown as StoredResult, integrityTrust: 'legacy-unsealed' };
  }

  const integrity = raw.integrity;
  if (
    !isPlainObject(integrity) ||
    integrity.algorithm !== 'sha256' ||
    typeof integrity.semantic_sha256 !== 'string' ||
    !SHA256_PATTERN.test(integrity.semantic_sha256)
  ) {
    fail('RESULT_INTEGRITY_MISSING', 'integrity が sha256 の記録として読めません。');
  }

  const recorded = (integrity as Record<string, unknown>).semantic_sha256 as string;
  const actual = computeResultSemanticSha256(raw as unknown as ResultPayloadV2);
  if (recorded !== actual) {
    fail(
      'RESULT_INTEGRITY_MISMATCH',
      'Result の metadata が記録された semantic hash と一致しません。保存後に編集された可能性があります。',
      `recorded=${recorded} actual=${actual}`,
    );
  }

  return { result: raw as unknown as StoredResult, integrityTrust: 'sealed' };
}

/**
 * Check the transcript bytes on disk against what the Result recorded.
 *
 * Split out from the metadata step so a caller already knows whose observation
 * this is before it reads the file.
 */
export function verifyTranscriptAgainstResult(input: {
  resultId: string;
  result: StoredResult;
  transcript: string;
  transcriptBytes: number;
}): void {
  const { resultId, result, transcript, transcriptBytes } = input;
  const fail = (kind: ResultVerificationErrorKind, message: string, detail?: string): never => {
    throw new ResultVerificationError(kind, resultId, message, detail);
  };

  // The recorded line-ending contract is only true if the bytes on disk keep it.
  if (transcript.includes('\r')) {
    fail(
      'RESULT_TRANSCRIPT_CONTRACT_MISMATCH',
      'transcript.txt に CR が含まれており、line_endings: lf と矛盾します。',
    );
  }

  const actualSha = sha256OfText(transcript);
  if (result.transcript.sha256 !== actualSha) {
    fail(
      'RESULT_TRANSCRIPT_HASH_MISMATCH',
      'transcript.txt が result.json の SHA-256 と一致しません。',
      `expected=${result.transcript.sha256} actual=${actualSha}`,
    );
  }

  if (result.transcript.bytes !== transcriptBytes) {
    fail(
      'RESULT_TRANSCRIPT_BYTES_MISMATCH',
      'transcript.txt のバイト数が result.json と一致しません。',
      `expected=${String(result.transcript.bytes)} actual=${transcriptBytes}`,
    );
  }
}

/**
 * Metadata and transcript in one call, for callers that already hold both.
 *
 * The listing path uses the two steps separately so it can attribute a missing
 * transcript to the tool that owns it.
 */
export function verifyStoredResult(input: {
  resultId: string;
  stored: unknown;
  transcript: string;
  transcriptBytes: number;
  requestedRunId: string;
  runEvidence: VerifiedRunEvidence;
}): VerifiedResultMetadata {
  const metadata = verifyStoredResultMetadata(input);
  verifyTranscriptAgainstResult({
    resultId: input.resultId,
    result: metadata.result,
    transcript: input.transcript,
    transcriptBytes: input.transcriptBytes,
  });
  return metadata;
}
