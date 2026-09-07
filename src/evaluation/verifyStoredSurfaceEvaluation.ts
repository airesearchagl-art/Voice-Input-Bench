import { sha256OfText } from '@/lib/hash';
import { isValidEvaluationId } from '@/lib/evaluationId';
import { computeResultSemanticSha256, resultPayloadOf } from '@/results/resultSchema';
import {
  SURFACE_CHAR_EVALUATOR,
  SURFACE_EVALUATION_SCHEMA_VERSION,
  computeSurfaceEvaluationSemanticSha256,
  isSurfaceCharEvaluator,
  type SurfaceEvaluationPayloadV3,
  type SurfaceEvaluationV3,
} from './surfaceEvaluationSchema';
import {
  SURFACE_NORMALIZE_PROFILE,
  surfaceNormalize,
} from './surfaceNormalize';
import { evaluateRawChar, toCodePoints } from './rawChar';
import type { EvaluationSubject } from './evaluationSubject';
import {
  EvaluationVerificationError,
  type EvaluationVerificationErrorKind,
} from './verifyStoredEvaluation';

/**
 * Verification of a surface-normalized Evaluation read back from disk.
 *
 * Three things have to agree, and all three are re-derived rather than trusted:
 *
 *   1. **The seal** — the stored metadata still hashes to what was recorded.
 *   2. **The normalization** — surface-normalize-v1 is run again over the actual
 *      `source.txt` and `transcript.txt` bytes, and the normalized hashes and
 *      lengths must match. This is what stops a stored CER from quietly
 *      belonging to a different profile than the one it names.
 *   3. **The metrics** — the Levenshtein comparison is run again over those
 *      normalized texts, and every number must come out identical.
 *
 * Checking only the metrics would accept an artifact whose normalized hashes
 * described text nobody produced; checking only the hashes would accept a CER
 * that never came from them.
 */

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const SHA256_PATTERN = /^[0-9a-f]{64}$/;

export function verifyStoredSurfaceEvaluation(input: {
  evaluationId: string;
  stored: unknown;
  subject: EvaluationSubject;
}): SurfaceEvaluationV3 {
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

  if (raw.schema_version !== SURFACE_EVALUATION_SCHEMA_VERSION) {
    fail(
      'EVALUATION_SCHEMA_UNSUPPORTED',
      `Evaluation schema v${String(raw.schema_version)} は surface-normalized-char-v1 の対象外です。`,
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

  if (typeof raw.created_at !== 'string' || Number.isNaN(Date.parse(raw.created_at))) {
    fail('EVALUATION_MALFORMED', 'created_at が有効な timestamp ではありません。');
  }

  const sections = [
    raw.subject,
    raw.reference,
    raw.hypothesis,
    raw.run_evidence,
    raw.normalized,
    raw.metrics,
  ];
  if (!sections.every(isPlainObject)) {
    fail('EVALUATION_MALFORMED', 'evaluation.json に必要なセクションがありません。');
  }

  const normalizedSection = raw.normalized as Record<string, unknown>;
  if (
    !isPlainObject(normalizedSection.reference) ||
    !isPlainObject(normalizedSection.hypothesis)
  ) {
    fail('EVALUATION_MALFORMED', 'normalized.reference / normalized.hypothesis がありません。');
  }

  // The evaluator has to be there before the seal can be computed over it. Its
  // values are checked after the seal, so a tampered file reads as tampered.
  if (!isPlainObject(raw.evaluator)) {
    fail(
      'EVALUATION_EVALUATOR_MISMATCH',
      'evaluator が記録として読めません。',
      `recorded=${JSON.stringify(raw.evaluator)} expected=${JSON.stringify(SURFACE_CHAR_EVALUATOR)}`,
    );
  }

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
  const actualSeal = computeSurfaceEvaluationSemanticSha256(
    raw as unknown as SurfaceEvaluationPayloadV3,
  );
  if (recordedSeal !== actualSeal) {
    fail(
      'EVALUATION_INTEGRITY_MISMATCH',
      'Evaluation の metadata が記録された semantic hash と一致しません。保存後に編集された可能性があります。',
      `recorded=${recordedSeal} actual=${actualSeal}`,
    );
  }

  // --- The evaluator ------------------------------------------------------
  if (!isSurfaceCharEvaluator(raw.evaluator)) {
    fail(
      'EVALUATION_EVALUATOR_MISMATCH',
      'evaluator が surface-normalized-char-v1 / unicode-code-point / surface-normalize-v1 と一致しません。',
      `recorded=${JSON.stringify(raw.evaluator)} expected=${JSON.stringify(SURFACE_CHAR_EVALUATOR)}`,
    );
  }

  // --- The subject --------------------------------------------------------
  const subjectSection = raw.subject as Record<string, unknown>;
  const referenceSection = raw.reference as Record<string, unknown>;
  const hypothesisSection = raw.hypothesis as Record<string, unknown>;
  const evidenceSection = raw.run_evidence as Record<string, unknown>;

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
    ['reference.chars', referenceSection.chars, toCodePoints(subject.referenceText).length],
    ['hypothesis.file', hypothesisSection.file, 'result/transcript.txt'],
    ['hypothesis.sha256', hypothesisSection.sha256, hypothesisSha],
    ['hypothesis.chars', hypothesisSection.chars, toCodePoints(subject.hypothesisText).length],
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

  // --- The normalization --------------------------------------------------
  // Re-run the profile over the bytes. If these do not match, the metrics below
  // describe text that this build of the profile does not produce.
  const normalizedReference = surfaceNormalize(subject.referenceText);
  const normalizedHypothesis = surfaceNormalize(subject.hypothesisText);
  const referenceSide = normalizedSection.reference as Record<string, unknown>;
  const hypothesisSide = normalizedSection.hypothesis as Record<string, unknown>;

  const normalizationChecks: Array<[string, unknown, unknown]> = [
    ['normalized.profile', normalizedSection.profile, SURFACE_NORMALIZE_PROFILE],
    ['normalized.reference.sha256', referenceSide.sha256, sha256OfText(normalizedReference)],
    [
      'normalized.reference.chars',
      referenceSide.chars,
      toCodePoints(normalizedReference).length,
    ],
    ['normalized.hypothesis.sha256', hypothesisSide.sha256, sha256OfText(normalizedHypothesis)],
    [
      'normalized.hypothesis.chars',
      hypothesisSide.chars,
      toCodePoints(normalizedHypothesis).length,
    ],
  ];
  for (const [field, recorded, current] of normalizationChecks) {
    if (recorded !== current) {
      fail(
        'EVALUATION_NORMALIZATION_MISMATCH',
        `${field} を再計算すると記録と一致しません。`,
        `recorded=${String(recorded)} recomputed=${String(current)}`,
      );
    }
  }

  // --- The metrics --------------------------------------------------------
  const recomputed = evaluateRawChar(normalizedReference, normalizedHypothesis);
  const metricsSection = raw.metrics as Record<string, unknown>;

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

  return raw as unknown as SurfaceEvaluationV3;
}
