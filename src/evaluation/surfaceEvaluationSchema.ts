import { sha256OfText } from '@/lib/hash';
import {
  SURFACE_CHAR_ALGORITHM,
  SURFACE_NORMALIZE_PROFILE,
  type SurfaceCharAlgorithm,
  type SurfaceNormalizeProfile,
} from './surfaceNormalize';
import { RAW_CHAR_UNIT, type RawCharMetrics, type RawCharUnit } from './rawChar';
import type { EvaluationIntegrityV1, EvaluationPayloadV1 } from './evaluationSchema';

/**
 * Surface-normalized character Evaluation — schema v3.
 *
 * A third schema version rather than a flag on v1, because it answers a third
 * question about the same two texts. v1 asks how far the characters drifted,
 * v2 asks which facts survived, and v3 asks how far the characters drifted once
 * typography is set aside. Sharing a shape would invite reading one as another,
 * and the three numbers are not interchangeable.
 *
 * P3-A's v1 and P3-B's v2 are untouched by this file. Neither is migrated, both
 * still read back through their own verifiers, and all three live side by side
 * in `data/evaluations/`, told apart by `schema_version`.
 *
 * The normalized texts are stored by hash and length, not by copy. Readback
 * re-runs surface-normalize-v1 over the actual `source.txt` and
 * `transcript.txt` bytes and requires the hashes, the lengths and every metric
 * to come out identical — so a stored CER cannot drift away from the profile it
 * claims to have been measured under.
 */

export const SURFACE_EVALUATION_SCHEMA_VERSION = 3 as const;

/**
 * Self-describing evaluator contract.
 *
 * Same three fields as raw-char-v1, and deliberately so: this *is* raw-char-v1's
 * comparison, run over text that one named profile has already touched. The
 * only thing that differs is what `normalization` says, which is exactly the
 * difference a reader needs to see when the two CERs sit next to each other.
 *
 * Server-fixed. No part of it is ever taken from a request.
 */
export interface SurfaceEvaluatorV3 {
  id: SurfaceCharAlgorithm;
  unit: RawCharUnit;
  normalization: SurfaceNormalizeProfile;
}

export const SURFACE_CHAR_EVALUATOR: SurfaceEvaluatorV3 = {
  id: SURFACE_CHAR_ALGORITHM,
  unit: RAW_CHAR_UNIT,
  normalization: SURFACE_NORMALIZE_PROFILE,
};

export const SURFACE_EVALUATOR_FIELDS = [
  'id',
  'unit',
  'normalization',
] as const satisfies ReadonlyArray<keyof SurfaceEvaluatorV3>;

/** What one side of the comparison looked like after normalization. */
export interface NormalizedSide {
  sha256: string;
  /** Unicode code points, which is what the metrics count. */
  chars: number;
}

export interface SurfaceEvaluationPayloadV3 {
  schema_version: 3;
  evaluation_id: string;
  created_at: string;
  evaluator: SurfaceEvaluatorV3;

  /** Resolved server-side from the Result on disk, never from the request. */
  run_id: string;
  result_id: string;

  subject: EvaluationPayloadV1['subject'];
  /** The raw inputs, hashed as stored on disk. */
  reference: EvaluationPayloadV1['reference'];
  hypothesis: EvaluationPayloadV1['hypothesis'];
  run_evidence: EvaluationPayloadV1['run_evidence'];

  /**
   * The same two texts after the profile ran.
   *
   * Kept next to the raw hashes on purpose: together they say which bytes were
   * read and what they became, which is what makes the metrics reproducible
   * rather than merely plausible.
   */
  normalized: {
    profile: SurfaceNormalizeProfile;
    reference: NormalizedSide;
    hypothesis: NormalizedSide;
  };

  /** Levenshtein over the normalized texts. Same shape as raw-char-v1's. */
  metrics: RawCharMetrics;
}

export interface SurfaceEvaluationV3 extends SurfaceEvaluationPayloadV3 {
  integrity: EvaluationIntegrityV1;
}

/**
 * Serialize a surface Evaluation's meaning in a fixed shape.
 *
 * Property order is written out explicitly rather than taken from the stored
 * object, so re-indenting `evaluation.json` or reordering its keys does not
 * change the hash — only changing what the Evaluation *says* does.
 */
export function canonicalSurfaceEvaluationPayload(payload: SurfaceEvaluationPayloadV3): string {
  return JSON.stringify({
    schema_version: payload.schema_version,
    evaluation_id: payload.evaluation_id,
    created_at: payload.created_at,
    evaluator: {
      id: payload.evaluator.id,
      unit: payload.evaluator.unit,
      normalization: payload.evaluator.normalization,
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
      profile: payload.normalized.profile,
      reference: {
        sha256: payload.normalized.reference.sha256,
        chars: payload.normalized.reference.chars,
      },
      hypothesis: {
        sha256: payload.normalized.hypothesis.sha256,
        chars: payload.normalized.hypothesis.chars,
      },
    },
    metrics: {
      exact_match: payload.metrics.exact_match,
      reference_chars: payload.metrics.reference_chars,
      hypothesis_chars: payload.metrics.hypothesis_chars,
      substitutions: payload.metrics.substitutions,
      deletions: payload.metrics.deletions,
      insertions: payload.metrics.insertions,
      edit_distance: payload.metrics.edit_distance,
      cer: payload.metrics.cer,
    },
  });
}

/** SHA-256 of {@link canonicalSurfaceEvaluationPayload}, over its UTF-8 bytes. */
export function computeSurfaceEvaluationSemanticSha256(
  payload: SurfaceEvaluationPayloadV3,
): string {
  return sha256OfText(canonicalSurfaceEvaluationPayload(payload));
}

/** Strip the integrity record, leaving exactly what the hash covers. */
export function surfaceEvaluationPayloadOf(
  evaluation: SurfaceEvaluationV3,
): SurfaceEvaluationPayloadV3 {
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
    metrics: evaluation.metrics,
  };
}

/** Does this stored evaluator record describe surface-normalized-char-v1 exactly? */
export function isSurfaceCharEvaluator(value: unknown): value is SurfaceEvaluatorV3 {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const evaluator = value as Record<string, unknown>;
  // Extra fields are refused too: a record naming a contract this build has
  // never heard of describes semantics it cannot reproduce.
  if (Object.keys(evaluator).length !== SURFACE_EVALUATOR_FIELDS.length) return false;
  return SURFACE_EVALUATOR_FIELDS.every(
    (field) => evaluator[field] === SURFACE_CHAR_EVALUATOR[field],
  );
}
