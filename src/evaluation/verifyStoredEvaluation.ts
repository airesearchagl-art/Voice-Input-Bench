import { sha256OfText } from '@/lib/hash';
import { isValidEvaluationId } from '@/lib/evaluationId';
import { assertRawEvaluationShape } from './rawEvaluationShape';
import { computeResultSemanticSha256, resultPayloadOf } from '@/results/resultSchema';
import {
  EVALUATION_SCHEMA_VERSION,
  RAW_CHAR_EVALUATOR,
  computeEvaluationSemanticSha256,
  isRawCharEvaluator,
  type EvaluationPayloadV1,
  type EvaluationV1,
} from './evaluationSchema';
import type { EvaluationSubject } from './evaluationSubject';
import { evaluateRawChar, toCodePoints } from './rawChar';

/**
 * Verification of an Evaluation read back from disk.
 *
 * Two independent checks have to agree, and both have to pass:
 *
 *   1. **The seal.** The stored metadata still hashes to what was recorded, so
 *      an edited CER — even an arithmetically consistent one — is visible.
 *   2. **The recomputation.** raw-char-v1 is run again over the actual
 *      `source.txt` and `transcript.txt` bytes, and every metric must match
 *      exactly.
 *
 * The seal alone would be defeated by anyone who re-sealed after editing. The
 * recomputation alone would accept an Evaluation whose subject had been swapped
 * for a different but equally consistent pair. Together they say: these numbers
 * describe these bytes, and nobody has touched either since.
 */

export type EvaluationVerificationErrorKind =
  /** `evaluation.json` is not an object, or not a schema this app reads. */
  | 'EVALUATION_SCHEMA_UNSUPPORTED'
  /** A field the schema requires is missing or the wrong type. */
  | 'EVALUATION_MALFORMED'
  /** `evaluation_id` does not match the directory it is stored in. */
  | 'EVALUATION_ID_MISMATCH'
  /**
   * The evaluator record is missing, or names semantics this app does not
   * implement — a different id, unit, or normalization.
   */
  | 'EVALUATION_EVALUATOR_MISMATCH'
  /** No readable integrity record. */
  | 'EVALUATION_INTEGRITY_MISSING'
  /** The metadata no longer hashes to what was recorded. */
  | 'EVALUATION_INTEGRITY_MISMATCH'
  /** The Run, Result or input texts are no longer the ones evaluated. */
  | 'EVALUATION_SUBJECT_MISMATCH'
  /** Recomputing the evaluator does not reproduce the stored metrics. */
  | 'EVALUATION_METRICS_MISMATCH'
  /**
   * Recomputing does not reproduce the stored entities, matches, or leftovers.
   *
   * Only critical-info-v1 stores that working; raw-char-v1 has none to check.
   */
  | 'EVALUATION_ENTITIES_MISMATCH'
  /**
   * Re-running the normalization profile does not reproduce the stored
   * normalized hashes or lengths.
   *
   * Only surface-normalized-char-v1 normalizes before comparing, so only it has
   * this to check — and without it a stored CER could belong to a profile other
   * than the one the artifact names.
   */
  | 'EVALUATION_NORMALIZATION_MISMATCH'
  /**
   * Recomputing critical-info-v1 does not reproduce the stored guard.
   *
   * Only semantic-h3-v1 runs the extractor as a veto. That veto is the one
   * decision the pipeline reaches without asking anything else, so the working
   * behind it is recomputed from the actual bytes rather than believed.
   */
  | 'EVALUATION_CRITICAL_GUARD_MISMATCH'
  /**
   * The record of *whether and how* the model ran does not hold together — a
   * veto artifact carrying model runs, or a completed one missing the transport
   * record that says what it talked to.
   */
  | 'EVALUATION_EXECUTION_MISMATCH'
  /** The stored runtime, model or request contract is not the pinned one. */
  | 'EVALUATION_MODEL_CONTRACT_MISMATCH'
  /** The stored prompt is not the approved rubric. */
  | 'EVALUATION_PROMPT_MISMATCH'
  /**
   * A stored model response does not survive being re-read: its hash, its
   * length, or the parsed verdict sitting next to it does not follow from the
   * raw text it claims to have come from.
   */
  | 'EVALUATION_RESPONSE_MISMATCH'
  /**
   * Re-deriving the vote and the H3 policy does not reproduce the stored
   * decision — or the artifact records a decision H3 cannot reach at all.
   */
  | 'EVALUATION_DECISION_MISMATCH';

export class EvaluationVerificationError extends Error {
  readonly kind: EvaluationVerificationErrorKind;
  readonly evaluationId: string;
  readonly detail?: string;

  constructor(
    kind: EvaluationVerificationErrorKind,
    evaluationId: string,
    message: string,
    detail?: string,
  ) {
    super(message);
    this.name = 'EvaluationVerificationError';
    this.kind = kind;
    this.evaluationId = evaluationId;
    this.detail = detail;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const SHA256_PATTERN = /^[0-9a-f]{64}$/;

/**
 * Check a stored Evaluation against its directory, its seal, and a fresh
 * reading of the Run and Result it was computed from.
 *
 * `subject` is that fresh reading — resolved by
 * {@link resolveEvaluationSubject}, not taken from the Evaluation itself.
 */
export function verifyStoredEvaluation(input: {
  evaluationId: string;
  stored: unknown;
  subject: EvaluationSubject;
}): EvaluationV1 {
  const { evaluationId, stored, subject } = input;
  const fail = (
    kind: EvaluationVerificationErrorKind,
    message: string,
    detail?: string,
  ): never => {
    throw new EvaluationVerificationError(kind, evaluationId, message, detail);
  };

  if (!isValidEvaluationId(evaluationId)) {
    fail('EVALUATION_ID_MISMATCH', `evaluation id の形式が不正です: ${JSON.stringify(evaluationId)}`);
  }
  if (!isPlainObject(stored)) {
    fail('EVALUATION_MALFORMED', 'evaluation.json がオブジェクトではありません。');
  }

  const raw = stored as Record<string, unknown>;

  if (raw.schema_version !== EVALUATION_SCHEMA_VERSION) {
    fail(
      'EVALUATION_SCHEMA_UNSUPPORTED',
      `Evaluation schema v${String(raw.schema_version)} は対象外です（v${EVALUATION_SCHEMA_VERSION} のみ）。`,
      `schema_version=${String(raw.schema_version)}`,
    );
  }

  if (raw.evaluation_id !== evaluationId) {
    fail(
      'EVALUATION_ID_MISMATCH',
      'evaluation.json の evaluation_id が保存先ディレクトリと一致しません。',
      `directory=${evaluationId} evaluation_id=${String(raw.evaluation_id)}`,
    );
  }

  // The evaluator has to be *there* before the seal can be computed over it.
  // Its three values are checked after the seal, so a tampered file is
  // reported as tampered rather than as a foreign evaluator.
  if (!isPlainObject(raw.evaluator)) {
    fail(
      'EVALUATION_EVALUATOR_MISMATCH',
      'evaluator が記録として読めません。',
      `recorded=${JSON.stringify(raw.evaluator)} expected=${JSON.stringify(RAW_CHAR_EVALUATOR)}`,
    );
  }

  if (typeof raw.created_at !== 'string' || Number.isNaN(Date.parse(raw.created_at))) {
    fail('EVALUATION_MALFORMED', 'created_at が有効な timestamp ではありません。');
  }

  // Everything the canonicalizer is about to walk, and everything it will not
  // hash. Without the first, a missing `subject.tool` threw a TypeError out of
  // the seal computation and arrived as UNEXPECTED; without the second, a field
  // this build has never heard of rode along inside a verified artifact.
  assertRawEvaluationShape(raw, (message, detail) =>
    fail('EVALUATION_MALFORMED', message, detail),
  );

  const subjectNode = raw.subject as Record<string, unknown>;
  const referenceNode = raw.reference as Record<string, unknown>;
  const hypothesisNode = raw.hypothesis as Record<string, unknown>;
  const evidenceNode = raw.run_evidence as Record<string, unknown>;
  const metricsNode = raw.metrics as Record<string, unknown>;

  // --- The seal -----------------------------------------------------------
  const integrity = raw.integrity;
  if (
    !isPlainObject(integrity) ||
    integrity.algorithm !== 'sha256' ||
    typeof integrity.semantic_sha256 !== 'string' ||
    !SHA256_PATTERN.test(integrity.semantic_sha256)
  ) {
    fail('EVALUATION_INTEGRITY_MISSING', 'integrity が sha256 の記録として読めません。');
  }

  const recordedSeal = (integrity as Record<string, unknown>).semantic_sha256 as string;
  const actualSeal = computeEvaluationSemanticSha256(raw as unknown as EvaluationPayloadV1);
  if (recordedSeal !== actualSeal) {
    fail(
      'EVALUATION_INTEGRITY_MISMATCH',
      'Evaluation の metadata が記録された semantic hash と一致しません。保存後に編集された可能性があります。',
      `recorded=${recordedSeal} actual=${actualSeal}`,
    );
  }

  // --- The evaluator ------------------------------------------------------
  // All three fields, not just the name. A validly sealed Evaluation that
  // counted a different unit, or normalized before comparing, is not a slightly
  // different reading of the same thing — it is a measurement this code cannot
  // reproduce, and reproducing it is the only reason readback exists.
  if (!isRawCharEvaluator(raw.evaluator)) {
    fail(
      'EVALUATION_EVALUATOR_MISMATCH',
      'evaluator が raw-char-v1 / unicode-code-point / none と一致しません。',
      `recorded=${JSON.stringify(raw.evaluator)} expected=${JSON.stringify(RAW_CHAR_EVALUATOR)}`,
    );
  }

  // --- The subject --------------------------------------------------------
  // What the Evaluation says it measured has to be what is on disk right now.
  const subjectSection = subjectNode as Record<string, unknown>;
  const referenceSection = referenceNode as Record<string, unknown>;
  const hypothesisSection = hypothesisNode as Record<string, unknown>;
  const evidenceSection = evidenceNode as Record<string, unknown>;

  const referenceSha = sha256OfText(subject.referenceText);
  const hypothesisSha = sha256OfText(subject.hypothesisText);
  const resultSeal = computeResultSemanticSha256(resultPayloadOf(subject.result));

  const subjectChecks: Array<[string, unknown, unknown]> = [
    ['run_id', raw.run_id, subject.runId],
    ['result_id', raw.result_id, subject.resultId],
    ['subject.result_schema_version', subjectSection.result_schema_version, 2],
    ['subject.result_semantic_sha256', subjectSection.result_semantic_sha256, resultSeal],
    ['reference.file', referenceSection.file, 'run/source.txt'],
    ['reference.sha256', referenceSection.sha256, referenceSha],
    ['hypothesis.file', hypothesisSection.file, 'result/transcript.txt'],
    ['hypothesis.sha256', hypothesisSection.sha256, hypothesisSha],
    [
      'run_evidence.manifest_schema_version',
      evidenceSection.manifest_schema_version,
      subject.runEvidence.manifestSchemaVersion,
    ],
    ['run_evidence.test_id', evidenceSection.test_id, subject.runEvidence.testId],
    ['run_evidence.source_sha256', evidenceSection.source_sha256, subject.runEvidence.sourceSha256],
    ['run_evidence.audio_sha256', evidenceSection.audio_sha256, subject.runEvidence.audioSha256],
  ];
  for (const [field, recorded, current] of subjectChecks) {
    if (recorded !== current) {
      fail(
        'EVALUATION_SUBJECT_MISMATCH',
        `${field} が現在の Run / Result と一致しません。`,
        `recorded=${String(recorded)} current=${String(current)}`,
      );
    }
  }

  const tool = subjectSection.tool;
  if (
    !isPlainObject(tool) ||
    tool.id !== subject.result.tool.id ||
    tool.name !== subject.result.tool.name ||
    tool.version !== subject.result.tool.version
  ) {
    fail(
      'EVALUATION_SUBJECT_MISMATCH',
      'subject.tool が Result の tool と一致しません。',
      `recorded=${JSON.stringify(tool)} current=${JSON.stringify(subject.result.tool)}`,
    );
  }

  const capture = subjectSection.capture;
  if (
    !isPlainObject(capture) ||
    capture.method !== subject.result.capture.method ||
    capture.delivery_path !== subject.result.capture.delivery_path
  ) {
    fail(
      'EVALUATION_SUBJECT_MISMATCH',
      'subject.capture が Result の capture と一致しません。',
      `recorded=${JSON.stringify(capture)} current=${JSON.stringify(subject.result.capture)}`,
    );
  }

  // --- The numbers --------------------------------------------------------
  // Recomputed from the bytes, not read back and trusted.
  const recomputed = evaluateRawChar(subject.referenceText, subject.hypothesisText);
  const metricsSection = metricsNode as Record<string, unknown>;

  const metricChecks: Array<[string, unknown, unknown]> = [
    ['exact_match', metricsSection.exact_match, recomputed.exact_match],
    ['reference_chars', metricsSection.reference_chars, recomputed.reference_chars],
    ['hypothesis_chars', metricsSection.hypothesis_chars, recomputed.hypothesis_chars],
    ['substitutions', metricsSection.substitutions, recomputed.substitutions],
    ['deletions', metricsSection.deletions, recomputed.deletions],
    ['insertions', metricsSection.insertions, recomputed.insertions],
    ['edit_distance', metricsSection.edit_distance, recomputed.edit_distance],
    ['cer', metricsSection.cer, recomputed.cer],
  ];
  for (const [field, recorded, current] of metricChecks) {
    if (recorded !== current) {
      fail(
        'EVALUATION_METRICS_MISMATCH',
        `metrics.${field} を再計算すると記録と一致しません。`,
        `recorded=${String(recorded)} recomputed=${String(current)}`,
      );
    }
  }

  // The recorded code point counts are what the metrics divide by, so they are
  // checked against the texts as well as against each other.
  if (
    referenceSection.chars !== toCodePoints(subject.referenceText).length ||
    hypothesisSection.chars !== toCodePoints(subject.hypothesisText).length
  ) {
    fail(
      'EVALUATION_SUBJECT_MISMATCH',
      'reference / hypothesis の code point 数が実際のテキストと一致しません。',
      `reference=${String(referenceSection.chars)} hypothesis=${String(hypothesisSection.chars)}`,
    );
  }

  return raw as unknown as EvaluationV1;
}
