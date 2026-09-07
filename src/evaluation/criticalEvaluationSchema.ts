import { sha256OfText } from '@/lib/hash';
import {
  CRITICAL_INFO_ALGORITHM,
  CRITICAL_INFO_MATCHING,
  CRITICAL_INFO_NUMBER_GRAMMAR,
  CRITICAL_INFO_SCOPE,
  CRITICAL_INFO_SEPARATOR_POLICY,
  CRITICAL_INFO_UNIT_ALIASES,
  type CriticalEntity,
  type CriticalEntityKind,
  type CriticalInfoAlgorithm,
  type CriticalInfoMatching,
  type CriticalInfoMetrics,
  type CriticalInfoNumberGrammar,
  type CriticalInfoScope,
  type CriticalInfoSeparatorPolicy,
  type CriticalInfoUnitAliases,
  type CriticalMatch,
} from './criticalInfo';
import type { EvaluationIntegrityV1, EvaluationPayloadV1 } from './evaluationSchema';

/**
 * Critical information Evaluation — schema v2.
 *
 * A separate schema version rather than an extra field on v1, because it is a
 * different measurement: v1 records how far the characters drifted, v2 records
 * which facts survived. Sharing a shape would invite reading one as the other.
 *
 * P3-A's v1 is untouched by this file. It is still written for raw-char-v1, is
 * never migrated, and reads back exactly as it did before — the two live side
 * by side in `data/evaluations/` and are told apart by `schema_version`.
 *
 * What v2 adds is the working: the entities found in each text, the pairs they
 * were matched into, and what was left over. Those are stored so readback can
 * recompute all of it and demand an exact match, rather than re-deriving only a
 * summary number and trusting the rest.
 */

export const CRITICAL_EVALUATION_SCHEMA_VERSION = 2 as const;

/**
 * Self-describing evaluator contract.
 *
 * A name alone does not pin a measurement down, and for this evaluator a name
 * plus a unit does not either. What a preservation rate means depends on which
 * numerals are readable, which unit spellings count as the same unit, what may
 * sit between a number and its unit, and how the two lists are matched. All of
 * it travels with every measurement, under the seal, so a stored rate says what
 * it is a rate *of* long after the code has moved on.
 *
 * Each field names a versioned contract rather than describing it: widening the
 * unit table or the grammar has to mean a new version here, not a quiet edit
 * that leaves old artifacts claiming semantics they were never measured under.
 * Golden tests pin each named version to its exact content.
 *
 * Server-fixed. No part of it is ever taken from a request.
 */
export interface CriticalEvaluatorV2 {
  id: CriticalInfoAlgorithm;
  scope: CriticalInfoScope;
  number_grammar: CriticalInfoNumberGrammar;
  unit_aliases: CriticalInfoUnitAliases;
  matching: CriticalInfoMatching;
  separator_policy: CriticalInfoSeparatorPolicy;
}

export const CRITICAL_INFO_EVALUATOR: CriticalEvaluatorV2 = {
  id: CRITICAL_INFO_ALGORITHM,
  scope: CRITICAL_INFO_SCOPE,
  number_grammar: CRITICAL_INFO_NUMBER_GRAMMAR,
  unit_aliases: CRITICAL_INFO_UNIT_ALIASES,
  matching: CRITICAL_INFO_MATCHING,
  separator_policy: CRITICAL_INFO_SEPARATOR_POLICY,
};

/** The order the evaluator's fields are hashed and compared in. */
export const CRITICAL_EVALUATOR_FIELDS = [
  'id',
  'scope',
  'number_grammar',
  'unit_aliases',
  'matching',
  'separator_policy',
] as const satisfies ReadonlyArray<keyof CriticalEvaluatorV2>;

/**
 * One extracted fact, as stored.
 *
 * Identical in shape to {@link CriticalEntity}, span and all, so the artifact
 * can be audited against the text it came from:
 *
 *     Array.from(text).slice(start_code_point, end_code_point).join('') === raw
 */
export interface StoredCriticalEntity {
  kind: CriticalEntityKind;
  raw: string;
  start_code_point: number;
  /** Exclusive. */
  end_code_point: number;
  canonical_key: string;
}

/** One reference fact paired with the hypothesis fact that preserved it. */
export interface StoredCriticalMatch {
  canonical_key: string;
  reference: StoredCriticalEntity;
  hypothesis: StoredCriticalEntity;
}

export interface CriticalEvaluationPayloadV2 {
  schema_version: 2;
  evaluation_id: string;
  created_at: string;
  evaluator: CriticalEvaluatorV2;

  /** Resolved server-side from the Result on disk, never from the request. */
  run_id: string;
  result_id: string;

  subject: EvaluationPayloadV1['subject'];
  reference: EvaluationPayloadV1['reference'];
  hypothesis: EvaluationPayloadV1['hypothesis'];
  run_evidence: EvaluationPayloadV1['run_evidence'];

  entities: {
    reference: StoredCriticalEntity[];
    hypothesis: StoredCriticalEntity[];
  };
  matches: StoredCriticalMatch[];
  /** Reference facts with no counterpart — what the transcript lost. */
  missing: StoredCriticalEntity[];
  /** Hypothesis facts with no counterpart — facts nobody stated. */
  extra: StoredCriticalEntity[];

  metrics: CriticalInfoMetrics;
}

export interface CriticalEvaluationV2 extends CriticalEvaluationPayloadV2 {
  integrity: EvaluationIntegrityV1;
}

export function toStoredEntity(entity: CriticalEntity): StoredCriticalEntity {
  return {
    kind: entity.kind,
    raw: entity.raw,
    start_code_point: entity.start_code_point,
    end_code_point: entity.end_code_point,
    canonical_key: entity.canonical_key,
  };
}

export function toStoredMatch(match: CriticalMatch): StoredCriticalMatch {
  return {
    canonical_key: match.canonical_key,
    reference: toStoredEntity(match.reference),
    hypothesis: toStoredEntity(match.hypothesis),
  };
}

function canonicalEntity(entity: StoredCriticalEntity) {
  return {
    kind: entity.kind,
    raw: entity.raw,
    start_code_point: entity.start_code_point,
    end_code_point: entity.end_code_point,
    canonical_key: entity.canonical_key,
  };
}

function canonicalMatch(match: StoredCriticalMatch) {
  return {
    canonical_key: match.canonical_key,
    reference: canonicalEntity(match.reference),
    hypothesis: canonicalEntity(match.hypothesis),
  };
}

/**
 * Serialize a critical Evaluation's meaning in a fixed shape.
 *
 * Every property order is written out here rather than taken from the stored
 * object — inside the arrays too — so re-indenting `evaluation.json` or
 * reordering its keys cannot move the hash, and changing what it says always
 * does. Array *order* is meaning, not formatting: the entities are in reading
 * order, and a reordered list is a different claim about the text.
 */
export function canonicalCriticalEvaluationPayload(payload: CriticalEvaluationPayloadV2): string {
  return JSON.stringify({
    schema_version: payload.schema_version,
    evaluation_id: payload.evaluation_id,
    created_at: payload.created_at,
    evaluator: {
      id: payload.evaluator.id,
      scope: payload.evaluator.scope,
      number_grammar: payload.evaluator.number_grammar,
      unit_aliases: payload.evaluator.unit_aliases,
      matching: payload.evaluator.matching,
      separator_policy: payload.evaluator.separator_policy,
    },
    run_id: payload.run_id,
    result_id: payload.result_id,
    subject: {
      result_schema_version: payload.subject.result_schema_version,
      tool: {
        id: payload.subject.tool.id,
        name: payload.subject.tool.name,
        version: payload.subject.tool.version,
      },
      capture: {
        method: payload.subject.capture.method,
        delivery_path: payload.subject.capture.delivery_path,
      },
      result_semantic_sha256: payload.subject.result_semantic_sha256,
    },
    reference: {
      file: payload.reference.file,
      sha256: payload.reference.sha256,
      chars: payload.reference.chars,
    },
    hypothesis: {
      file: payload.hypothesis.file,
      sha256: payload.hypothesis.sha256,
      chars: payload.hypothesis.chars,
    },
    run_evidence: {
      manifest_schema_version: payload.run_evidence.manifest_schema_version,
      test_id: payload.run_evidence.test_id,
      source_sha256: payload.run_evidence.source_sha256,
      audio_sha256: payload.run_evidence.audio_sha256,
    },
    entities: {
      reference: payload.entities.reference.map(canonicalEntity),
      hypothesis: payload.entities.hypothesis.map(canonicalEntity),
    },
    matches: payload.matches.map(canonicalMatch),
    missing: payload.missing.map(canonicalEntity),
    extra: payload.extra.map(canonicalEntity),
    metrics: {
      reference_entities: payload.metrics.reference_entities,
      hypothesis_entities: payload.metrics.hypothesis_entities,
      matched: payload.metrics.matched,
      missing: payload.metrics.missing,
      extra: payload.metrics.extra,
      preservation_rate: payload.metrics.preservation_rate,
      exact_entity_multiset_match: payload.metrics.exact_entity_multiset_match,
    },
  });
}

/** SHA-256 of {@link canonicalCriticalEvaluationPayload}, over its UTF-8 bytes. */
export function computeCriticalEvaluationSemanticSha256(
  payload: CriticalEvaluationPayloadV2,
): string {
  return sha256OfText(canonicalCriticalEvaluationPayload(payload));
}

/** Strip the integrity record, leaving exactly what the hash covers. */
export function criticalEvaluationPayloadOf(
  evaluation: CriticalEvaluationV2,
): CriticalEvaluationPayloadV2 {
  return {
    schema_version: evaluation.schema_version,
    evaluation_id: evaluation.evaluation_id,
    created_at: evaluation.created_at,
    evaluator: evaluation.evaluator,
    run_id: evaluation.run_id,
    result_id: evaluation.result_id,
    subject: evaluation.subject,
    reference: evaluation.reference,
    hypothesis: evaluation.hypothesis,
    run_evidence: evaluation.run_evidence,
    entities: evaluation.entities,
    matches: evaluation.matches,
    missing: evaluation.missing,
    extra: evaluation.extra,
    metrics: evaluation.metrics,
  };
}

/**
 * Does this stored evaluator record describe critical-info-v1 exactly?
 *
 * Every field, not just the id. An artifact naming a different grammar or a
 * different alias table is not a slightly different reading of the same thing —
 * it is a measurement this code cannot reproduce, and reproducing it is the
 * only reason readback exists.
 */
export function isCriticalInfoEvaluator(value: unknown): value is CriticalEvaluatorV2 {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const evaluator = value as Record<string, unknown>;
  // Extra fields are refused too. A record naming a contract this build has
  // never heard of describes semantics it cannot reproduce, and the seal alone
  // would not catch it once the artifact has been re-sealed.
  if (Object.keys(evaluator).length !== CRITICAL_EVALUATOR_FIELDS.length) return false;
  return CRITICAL_EVALUATOR_FIELDS.every(
    (field) => evaluator[field] === CRITICAL_INFO_EVALUATOR[field],
  );
}
