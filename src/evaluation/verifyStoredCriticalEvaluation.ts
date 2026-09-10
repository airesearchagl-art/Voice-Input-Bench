import { sha256OfText } from '@/lib/hash';
import { isValidEvaluationId } from '@/lib/evaluationId';
import { computeResultSemanticSha256, resultPayloadOf } from '@/results/resultSchema';
import { assertCriticalEvaluationShape } from './criticalEvaluationShape';
import {
  CRITICAL_EVALUATION_SCHEMA_VERSION,
  CRITICAL_INFO_EVALUATOR,
  computeCriticalEvaluationSemanticSha256,
  isCriticalInfoEvaluator,
  toStoredEntity,
  toStoredMatch,
  type CriticalEvaluationPayloadV2,
  type CriticalEvaluationV2,
} from './criticalEvaluationSchema';
import { analyzeCriticalInfo } from './criticalInfo';
import type { EvaluationSubject } from './evaluationSubject';
import { EvaluationVerificationError, type EvaluationVerificationErrorKind } from './verifyStoredEvaluation';
import { toCodePoints } from './rawChar';

/**
 * Verification of a critical information Evaluation read back from disk.
 *
 * Same two-part standard as raw-char-v1, with more to reproduce:
 *
 *   1. **The seal** — the stored metadata still hashes to what was recorded, so
 *      an edited preservation rate is visible even when it is arithmetically
 *      consistent with the counts beside it.
 *   2. **The recomputation** — critical-info-v1 is run again over the actual
 *      `source.txt` and `transcript.txt` bytes, and the entities, the matches,
 *      the leftovers *and* the metrics must all come out identical.
 *
 * Recomputing only the summary would accept an Evaluation whose entity list had
 * been rewritten to tell a different story about the same rate. The working is
 * checked because the working is the claim.
 */

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const SHA256_PATTERN = /^[0-9a-f]{64}$/;

export function verifyStoredCriticalEvaluation(input: {
  evaluationId: string;
  stored: unknown;
  subject: EvaluationSubject;
}): CriticalEvaluationV2 {
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

  if (raw.schema_version !== CRITICAL_EVALUATION_SCHEMA_VERSION) {
    fail(
      'EVALUATION_SCHEMA_UNSUPPORTED',
      `Evaluation schema v${String(raw.schema_version)} は critical-info-v1 の対象外です。`,
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

  // The evaluator has to be there before the seal can be computed over it. Its
  // values are checked after the seal, so a tampered file reads as tampered.
  if (!isPlainObject(raw.evaluator)) {
    fail(
      'EVALUATION_EVALUATOR_MISMATCH',
      'evaluator が記録として読めません。',
      `recorded=${JSON.stringify(raw.evaluator)} expected=${JSON.stringify(CRITICAL_INFO_EVALUATOR)}`,
    );
  }

  // Everything the canonicalizer is about to walk, checked first. Sealing an
  // artifact whose entities or matches use a different vocabulary used to throw
  // a TypeError out of the canonicalizer and surface as UNEXPECTED.
  assertCriticalEvaluationShape(evaluationId, raw);

  const entitiesSection = raw.entities as Record<string, unknown>;

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
  const actualSeal = computeCriticalEvaluationSemanticSha256(
    raw as unknown as CriticalEvaluationPayloadV2,
  );
  if (recordedSeal !== actualSeal) {
    fail(
      'EVALUATION_INTEGRITY_MISMATCH',
      'Evaluation の metadata が記録された semantic hash と一致しません。保存後に編集された可能性があります。',
      `recorded=${recordedSeal} actual=${actualSeal}`,
    );
  }

  // --- The evaluator ------------------------------------------------------
  if (!isCriticalInfoEvaluator(raw.evaluator)) {
    fail(
      'EVALUATION_EVALUATOR_MISMATCH',
      'evaluator が critical-info-v1 の現行 6-field contract と一致しません。',
      `recorded=${JSON.stringify(raw.evaluator)} expected=${JSON.stringify(CRITICAL_INFO_EVALUATOR)}`,
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

  // --- The working, and then the numbers ----------------------------------
  const recomputed = analyzeCriticalInfo(subject.referenceText, subject.hypothesisText);

  const workingChecks: Array<[string, unknown, unknown]> = [
    [
      'entities.reference',
      entitiesSection.reference,
      recomputed.referenceEntities.map(toStoredEntity),
    ],
    [
      'entities.hypothesis',
      entitiesSection.hypothesis,
      recomputed.hypothesisEntities.map(toStoredEntity),
    ],
    ['matches', raw.matches, recomputed.matches.map(toStoredMatch)],
    ['missing', raw.missing, recomputed.missing.map(toStoredEntity)],
    ['extra', raw.extra, recomputed.extra.map(toStoredEntity)],
  ];
  for (const [field, recorded, current] of workingChecks) {
    if (JSON.stringify(recorded) !== JSON.stringify(current)) {
      fail(
        'EVALUATION_ENTITIES_MISMATCH',
        `${field} を再計算すると記録と一致しません。`,
        `recorded=${JSON.stringify(recorded)} recomputed=${JSON.stringify(current)}`,
      );
    }
  }

  const metricsSection = raw.metrics as Record<string, unknown>;
  const metricChecks: Array<[string, unknown, unknown]> = [
    ['reference_entities', metricsSection.reference_entities, recomputed.metrics.reference_entities],
    [
      'hypothesis_entities',
      metricsSection.hypothesis_entities,
      recomputed.metrics.hypothesis_entities,
    ],
    ['matched', metricsSection.matched, recomputed.metrics.matched],
    ['missing', metricsSection.missing, recomputed.metrics.missing],
    ['extra', metricsSection.extra, recomputed.metrics.extra],
    ['preservation_rate', metricsSection.preservation_rate, recomputed.metrics.preservation_rate],
    [
      'exact_entity_multiset_match',
      metricsSection.exact_entity_multiset_match,
      recomputed.metrics.exact_entity_multiset_match,
    ],
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

  return raw as unknown as CriticalEvaluationV2;
}
