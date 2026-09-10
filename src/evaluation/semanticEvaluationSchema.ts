import { sha256OfText } from '@/lib/hash';
import type { CriticalInfoMetrics } from './criticalInfo';
import type { StoredCriticalEntity, StoredCriticalMatch } from './criticalEvaluationSchema';
import type { EvaluationIntegrityV1, EvaluationPayloadV1 } from './evaluationSchema';
import type { NormalizedSide } from './surfaceEvaluationSchema';
import { SURFACE_NORMALIZE_PROFILE, type SurfaceNormalizeProfile } from './surfaceNormalize';
import {
  SEMANTIC_DECISION_POLICY,
  SEMANTIC_VOTE_POLICY,
  type SemanticDecisionSource,
  type SemanticDecisionValue,
} from './semanticDecision';
import { SEMANTIC_RUBRIC_V1_ID } from './semanticPrompt';
import {
  SEMANTIC_PROVIDER_CONTRACT,
  SEMANTIC_PROVIDER_PROTOCOL,
  SEMANTIC_REQUEST_NUM_PREDICT,
  SEMANTIC_REQUEST_REPEATS,
  SEMANTIC_REQUEST_SEED,
  SEMANTIC_REQUEST_TEMPERATURE,
  SEMANTIC_REQUEST_TOP_P,
  SEMANTIC_RUNTIME_NAME,
} from './semanticProvider';
import type { SemanticVerdict } from './semanticRubric';

/**
 * Semantic Evaluation, schema v4.
 *
 * A per-evaluator schema, like v1, v2 and v3 before it — not a generic envelope
 * with an `output: any` inside. The whole value of these artifacts is that a
 * reader can tell, from the record alone, exactly what was measured and whether
 * it still holds; a container that accepts any shape cannot make that claim
 * about anything it holds.
 *
 * What a v4 artifact claims is narrower than what v1–v3 claim, and the
 * difference matters. A raw or surface CER is recomputable from the input text:
 * read the bytes, run the function, get the same number. A model verdict is
 * not. So v4 claims two things instead:
 *
 *   1. **historical model execution evidence** — these exact bytes were sent to
 *      this exact model under this exact runtime, and this exact text came back;
 *   2. **a deterministically verified decision derivation** — from that stored
 *      response, the parse, the vote and the H3 decision re-derive exactly.
 *
 * It does not claim the model would say the same thing again. Nothing here
 * should ever be read as if it did.
 */

export const SEMANTIC_EVALUATION_SCHEMA_VERSION = 4 as const;

export const SEMANTIC_H3_ALGORITHM = 'semantic-h3-v1';
export type SemanticH3Algorithm = typeof SEMANTIC_H3_ALGORITHM;

/**
 * critical-info-v1, used as a hard veto rather than as a score.
 *
 * The name says how it is used, not just which extractor ran. A supported
 * numeric mismatch ends the evaluation at `changed` before the model is asked
 * anything, so calling it a "guard" and calling it a "veto" are the same claim
 * here, and the artifact should not be ambiguous about which one it means.
 */
export const SEMANTIC_CRITICAL_GUARD = 'critical-info-v1-hard-veto';
export type SemanticCriticalGuard = typeof SEMANTIC_CRITICAL_GUARD;

/**
 * The guard reads the raw texts, not the surface-normalized ones.
 *
 * This is the composition P3-D-A actually measured and adopted: surface
 * normalization is the *model's* input profile, and critical-info-v1 was scored
 * against raw reference and hypothesis. Feeding the guard normalized text would
 * be a different evaluator, and not a harmless one — folding `2700ｍｍ` to
 * `2700mm` is what lets the extractor see a measurement it otherwise cannot
 * read, so the same pair can veto under one composition and reach the model
 * under the other. The profile is named in the artifact so no reader has to
 * infer which one produced the stored working.
 */
export const SEMANTIC_CRITICAL_INPUT_PROFILE = 'raw-v1';
export type SemanticCriticalInputProfile = typeof SEMANTIC_CRITICAL_INPUT_PROFILE;

/**
 * Self-describing evaluator contract. Server-fixed, never from a request.
 *
 * Each field names a versioned sub-contract instead of describing it, so
 * widening any one of them is a rename: old artifacts keep claiming the exact
 * semantics they were produced under rather than silently inheriting new ones.
 * The list is closed — an artifact naming a field this build has never heard of
 * describes semantics it cannot reproduce, and readback refuses it.
 */
export interface SemanticEvaluatorV4 {
  id: SemanticH3Algorithm;
  /** What the model is shown. */
  llm_input_profile: SurfaceNormalizeProfile;
  /** What the deterministic guard reads. Not the same texts. */
  critical_input_profile: SemanticCriticalInputProfile;
  critical_guard: SemanticCriticalGuard;
  decision_policy: typeof SEMANTIC_DECISION_POLICY;
  vote_policy: typeof SEMANTIC_VOTE_POLICY;
  rubric: typeof SEMANTIC_RUBRIC_V1_ID;
  provider_contract: typeof SEMANTIC_PROVIDER_CONTRACT;
}

export const SEMANTIC_H3_EVALUATOR: SemanticEvaluatorV4 = {
  id: SEMANTIC_H3_ALGORITHM,
  llm_input_profile: SURFACE_NORMALIZE_PROFILE,
  critical_input_profile: SEMANTIC_CRITICAL_INPUT_PROFILE,
  critical_guard: SEMANTIC_CRITICAL_GUARD,
  decision_policy: SEMANTIC_DECISION_POLICY,
  vote_policy: SEMANTIC_VOTE_POLICY,
  rubric: SEMANTIC_RUBRIC_V1_ID,
  provider_contract: SEMANTIC_PROVIDER_CONTRACT,
};

/** The order the evaluator's fields are hashed and compared in. */
export const SEMANTIC_EVALUATOR_FIELDS = [
  'id',
  'llm_input_profile',
  'critical_input_profile',
  'critical_guard',
  'decision_policy',
  'vote_policy',
  'rubric',
  'provider_contract',
] as const satisfies ReadonlyArray<keyof SemanticEvaluatorV4>;

/**
 * What the deterministic guard was able to say.
 *
 * Three outcomes, kept distinct because collapsing them would be a lie in one
 * direction or the other. `applied` means critical-info-v1 read both texts and
 * compared them. The other two mean it could not, and neither of them is
 * evidence that the facts survived — they only mean this guard had nothing to
 * say, and the decision falls through to a route that cannot conclude
 * `preserved` anyway.
 */
export type SemanticCriticalStatus =
  | 'applied'
  | 'not_applicable_no_reference_entity'
  | 'unsupported_reference_syntax';

export interface SemanticCriticalGuardV4 {
  status: SemanticCriticalStatus;
  /** Did critical-info-v1 actually compare the two texts? */
  applicable: boolean;
  /** A supported mismatch. True here is the veto. */
  mismatch: boolean;

  /**
   * The full critical-info-v1 working, so the veto is auditable rather than
   * asserted. Null exactly when the guard did not apply.
   */
  entities: { reference: StoredCriticalEntity[]; hypothesis: StoredCriticalEntity[] } | null;
  matches: StoredCriticalMatch[] | null;
  missing: StoredCriticalEntity[] | null;
  extra: StoredCriticalEntity[] | null;
  metrics: CriticalInfoMetrics | null;

  /** Why it did not apply, in the guard's own words. Null when it applied. */
  unavailable_reason: string | null;
}

/**
 * Did the model run at all?
 *
 * `skipped_by_critical_veto` is a closed status, not an absence. A veto path
 * artifact has no runtime block, no model block and no runs, and the reader
 * needs to be able to tell "nothing was contacted, deliberately" from "the
 * evidence is missing".
 */
export type SemanticExecutionStatus = 'completed' | 'skipped_by_critical_veto';

/** Exactly what was asked of the runtime. Server-fixed. */
export interface SemanticRequestContractV4 {
  repeats: number;
  temperature: number;
  num_predict: number;
  /** Recorded as unset rather than omitted, so nobody has to guess. */
  top_p: string;
  seed: string;
  stream: false;
}

export const SEMANTIC_REQUEST_CONTRACT: SemanticRequestContractV4 = {
  repeats: SEMANTIC_REQUEST_REPEATS,
  temperature: SEMANTIC_REQUEST_TEMPERATURE,
  num_predict: SEMANTIC_REQUEST_NUM_PREDICT,
  top_p: SEMANTIC_REQUEST_TOP_P,
  seed: SEMANTIC_REQUEST_SEED,
  stream: false,
};

/**
 * One model call, stored whole.
 *
 * The raw response text is kept rather than only its hash. This is local
 * Evaluation storage, not a Git tree, and keeping the bytes is what lets
 * readback walk the entire chain — raw response, hash check, parser, parsed
 * output, vote, decision — without a second model call. A stored hash alone
 * would prove the text was not edited while proving nothing about what it said.
 */
export interface SemanticRunV4 {
  run_index: number;
  latency_ms: number;
  /** SHA-256 of the exact request bytes; rebuildable from stored evidence. */
  request_sha256: string;
  raw_response: string;
  raw_response_sha256: string;
  /** Unicode code points, counted the same way as everywhere else. */
  raw_response_chars: number;
  parseable_schema_valid: boolean;
  exact_output_contract_valid: boolean;
  parsed_output: SemanticVerdict | null;
  error: string | null;
}

export interface SemanticExecutionV4 {
  status: SemanticExecutionStatus;
  /** Null on the veto path: nothing was contacted. */
  endpoint_class: 'loopback' | null;
  provider_protocol: typeof SEMANTIC_PROVIDER_PROTOCOL | null;
  runtime: { name: typeof SEMANTIC_RUNTIME_NAME; version: string } | null;
  model: { id: string; digest: string; quantization: string } | null;
  prompt: { id: string; sha256: string } | null;
  request_contract: SemanticRequestContractV4 | null;
  runs: SemanticRunV4[];
}

export interface SemanticDecisionV4 {
  value: SemanticDecisionValue;
  by: SemanticDecisionSource;
}

export interface SemanticEvaluationPayloadV4 {
  schema_version: 4;
  evaluation_id: string;
  created_at: string;
  evaluator: SemanticEvaluatorV4;

  /** Resolved server-side from the Result on disk, never from the request. */
  run_id: string;
  result_id: string;

  subject: EvaluationPayloadV1['subject'];
  /** The raw inputs, hashed as stored on disk. */
  reference: EvaluationPayloadV1['reference'];
  hypothesis: EvaluationPayloadV1['hypothesis'];
  run_evidence: EvaluationPayloadV1['run_evidence'];

  /**
   * The two texts the model was shown, and only the model.
   *
   * Only these enter the prompt. The guard reads the raw pair above instead, so
   * this block is not evidence about the veto. Which profile produced these is
   * not repeated here — `evaluator.llm_input_profile` is the single record of
   * that, so the two can never disagree about what was run.
   */
  normalized: {
    reference: NormalizedSide;
    hypothesis: NormalizedSide;
  };

  critical: SemanticCriticalGuardV4;
  execution: SemanticExecutionV4;
  decision: SemanticDecisionV4;
}

export interface SemanticEvaluationV4 extends SemanticEvaluationPayloadV4 {
  integrity: EvaluationIntegrityV1;
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

function canonicalVerdict(verdict: SemanticVerdict) {
  return {
    meaning_preserved: verdict.meaning_preserved,
    severity: verdict.severity,
    negation: verdict.negation,
    direction_location: verdict.direction_location,
    instruction_action: verdict.instruction_action,
    critical_fact: verdict.critical_fact,
    domain_term: verdict.domain_term,
    reason_codes: [...verdict.reason_codes],
    short_rationale: verdict.short_rationale,
  };
}

function canonicalRun(run: SemanticRunV4) {
  return {
    run_index: run.run_index,
    latency_ms: run.latency_ms,
    request_sha256: run.request_sha256,
    raw_response: run.raw_response,
    raw_response_sha256: run.raw_response_sha256,
    raw_response_chars: run.raw_response_chars,
    parseable_schema_valid: run.parseable_schema_valid,
    exact_output_contract_valid: run.exact_output_contract_valid,
    parsed_output: run.parsed_output === null ? null : canonicalVerdict(run.parsed_output),
    error: run.error,
  };
}

/**
 * Serialize a semantic Evaluation's meaning in a fixed shape.
 *
 * Every property order is written out here rather than taken from the stored
 * object — inside the runs and the critical working too — so re-indenting
 * `evaluation.json` or reordering its keys cannot move the hash, and changing
 * what it says always does. Run order is meaning: run 2 is not run 3.
 */
export function canonicalSemanticEvaluationPayload(payload: SemanticEvaluationPayloadV4): string {
  return JSON.stringify({
    schema_version: payload.schema_version,
    evaluation_id: payload.evaluation_id,
    created_at: payload.created_at,
    evaluator: {
      id: payload.evaluator.id,
      llm_input_profile: payload.evaluator.llm_input_profile,
      critical_input_profile: payload.evaluator.critical_input_profile,
      critical_guard: payload.evaluator.critical_guard,
      decision_policy: payload.evaluator.decision_policy,
      vote_policy: payload.evaluator.vote_policy,
      rubric: payload.evaluator.rubric,
      provider_contract: payload.evaluator.provider_contract,
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
    normalized: {
      reference: {
        sha256: payload.normalized.reference.sha256,
        chars: payload.normalized.reference.chars,
      },
      hypothesis: {
        sha256: payload.normalized.hypothesis.sha256,
        chars: payload.normalized.hypothesis.chars,
      },
    },
    critical: {
      status: payload.critical.status,
      applicable: payload.critical.applicable,
      mismatch: payload.critical.mismatch,
      entities:
        payload.critical.entities === null
          ? null
          : {
              reference: payload.critical.entities.reference.map(canonicalEntity),
              hypothesis: payload.critical.entities.hypothesis.map(canonicalEntity),
            },
      matches: payload.critical.matches === null ? null : payload.critical.matches.map(canonicalMatch),
      missing: payload.critical.missing === null ? null : payload.critical.missing.map(canonicalEntity),
      extra: payload.critical.extra === null ? null : payload.critical.extra.map(canonicalEntity),
      metrics:
        payload.critical.metrics === null
          ? null
          : {
              reference_entities: payload.critical.metrics.reference_entities,
              hypothesis_entities: payload.critical.metrics.hypothesis_entities,
              matched: payload.critical.metrics.matched,
              missing: payload.critical.metrics.missing,
              extra: payload.critical.metrics.extra,
              preservation_rate: payload.critical.metrics.preservation_rate,
              exact_entity_multiset_match: payload.critical.metrics.exact_entity_multiset_match,
            },
      unavailable_reason: payload.critical.unavailable_reason,
    },
    execution: {
      status: payload.execution.status,
      endpoint_class: payload.execution.endpoint_class,
      provider_protocol: payload.execution.provider_protocol,
      runtime:
        payload.execution.runtime === null
          ? null
          : { name: payload.execution.runtime.name, version: payload.execution.runtime.version },
      model:
        payload.execution.model === null
          ? null
          : {
              id: payload.execution.model.id,
              digest: payload.execution.model.digest,
              quantization: payload.execution.model.quantization,
            },
      prompt:
        payload.execution.prompt === null
          ? null
          : { id: payload.execution.prompt.id, sha256: payload.execution.prompt.sha256 },
      request_contract:
        payload.execution.request_contract === null
          ? null
          : {
              repeats: payload.execution.request_contract.repeats,
              temperature: payload.execution.request_contract.temperature,
              num_predict: payload.execution.request_contract.num_predict,
              top_p: payload.execution.request_contract.top_p,
              seed: payload.execution.request_contract.seed,
              stream: payload.execution.request_contract.stream,
            },
      runs: payload.execution.runs.map(canonicalRun),
    },
    decision: {
      value: payload.decision.value,
      by: payload.decision.by,
    },
  });
}

/** SHA-256 of {@link canonicalSemanticEvaluationPayload}, over its UTF-8 bytes. */
export function computeSemanticEvaluationSemanticSha256(
  payload: SemanticEvaluationPayloadV4,
): string {
  return sha256OfText(canonicalSemanticEvaluationPayload(payload));
}

/** Strip the integrity record, leaving exactly what the hash covers. */
export function semanticEvaluationPayloadOf(
  evaluation: SemanticEvaluationV4,
): SemanticEvaluationPayloadV4 {
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
    normalized: evaluation.normalized,
    critical: evaluation.critical,
    execution: evaluation.execution,
    decision: evaluation.decision,
  };
}

/** Does this stored evaluator record describe semantic-h3-v1 exactly? */
export function isSemanticH3Evaluator(value: unknown): value is SemanticEvaluatorV4 {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const evaluator = value as Record<string, unknown>;
  // Extra fields are refused too: a record naming a contract this build has
  // never heard of describes semantics it cannot reproduce.
  if (Object.keys(evaluator).length !== SEMANTIC_EVALUATOR_FIELDS.length) return false;
  return SEMANTIC_EVALUATOR_FIELDS.every(
    (field) => evaluator[field] === SEMANTIC_H3_EVALUATOR[field],
  );
}
