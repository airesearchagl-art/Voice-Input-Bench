import {
  isRec,
  rejectUnknownFields,
  requireObject,
  type Rec,
  type ShapeFail,
} from './evaluationShapeGuards';

/**
 * The shape of a stored surface-normalized Evaluation (schema v3), checked
 * before `computeSurfaceEvaluationSemanticSha256` walks it.
 *
 * Same discipline as v1, and a different field list, because v3 measures a
 * different thing: it carries the `normalized` block recording the two folded
 * texts the comparison actually ran on. That block is the reason this is its
 * own file rather than a parameter to a shared one.
 *
 * `evaluator` is only required to be an object. v3 already holds its evaluator
 * to an exact field count of its own, and EVALUATION_EVALUATOR_MISMATCH keeps
 * that question.
 */

const ROOT_FIELDS = [
  'schema_version',
  'evaluation_id',
  'created_at',
  'evaluator',
  'run_id',
  'result_id',
  'subject',
  'reference',
  'hypothesis',
  'run_evidence',
  'normalized',
  'metrics',
  'integrity',
] as const;

const SUBJECT_FIELDS = [
  'result_schema_version',
  'tool',
  'capture',
  'result_semantic_sha256',
] as const;

const TOOL_FIELDS = ['id', 'name', 'version'] as const;
const CAPTURE_FIELDS = ['method', 'delivery_path'] as const;
const TEXT_FIELDS = ['file', 'sha256', 'chars'] as const;

const RUN_EVIDENCE_FIELDS = [
  'manifest_schema_version',
  'test_id',
  'source_sha256',
  'audio_sha256',
] as const;

/** What the normalized pair records: a hash and a length, per side. */
const NORMALIZED_SIDE_FIELDS = ['sha256', 'chars'] as const;

const METRICS_FIELDS = [
  'exact_match',
  'reference_chars',
  'hypothesis_chars',
  'substitutions',
  'deletions',
  'insertions',
  'edit_distance',
  'cer',
] as const;

const INTEGRITY_FIELDS = ['algorithm', 'semantic_sha256'] as const;

/**
 * Confirm a v3 artifact can be canonicalized, and carries nothing unhashed.
 *
 * Value semantics keep their owners: a normalized hash that does not recompute
 * still reaches EVALUATION_NORMALIZATION_MISMATCH, and metrics still reach
 * EVALUATION_METRICS_MISMATCH.
 */
export function assertSurfaceEvaluationShape(stored: Rec, fail: ShapeFail): void {
  rejectUnknownFields(stored, 'root', ROOT_FIELDS, fail);

  requireObject(stored.evaluator, 'evaluator', fail);

  const subject = requireObject(stored.subject, 'subject', fail);
  rejectUnknownFields(subject, 'subject', SUBJECT_FIELDS, fail);
  rejectUnknownFields(
    requireObject(subject.tool, 'subject.tool', fail),
    'subject.tool',
    TOOL_FIELDS,
    fail,
  );
  rejectUnknownFields(
    requireObject(subject.capture, 'subject.capture', fail),
    'subject.capture',
    CAPTURE_FIELDS,
    fail,
  );

  for (const side of ['reference', 'hypothesis'] as const) {
    rejectUnknownFields(requireObject(stored[side], side, fail), side, TEXT_FIELDS, fail);
  }

  rejectUnknownFields(
    requireObject(stored.run_evidence, 'run_evidence', fail),
    'run_evidence',
    RUN_EVIDENCE_FIELDS,
    fail,
  );

  // The normalized pair: the container and both sides are walked by name.
  const normalized = requireObject(stored.normalized, 'normalized', fail);
  rejectUnknownFields(normalized, 'normalized', ['reference', 'hypothesis'], fail);
  for (const side of ['reference', 'hypothesis'] as const) {
    rejectUnknownFields(
      requireObject(normalized[side], `normalized.${side}`, fail),
      `normalized.${side}`,
      NORMALIZED_SIDE_FIELDS,
      fail,
    );
  }

  rejectUnknownFields(
    requireObject(stored.metrics, 'metrics', fail),
    'metrics',
    METRICS_FIELDS,
    fail,
  );

  // Unknown fields only, and only once it is an object at all. The seal record
  // is not part of the payload hash, so an extra field here is free — but
  // whether it is present and well formed has always been
  // EVALUATION_INTEGRITY_MISSING's question, and a shape check that answered it
  // first would relabel an error that was already right.
  if (isRec(stored.integrity)) {
    rejectUnknownFields(stored.integrity, 'integrity', INTEGRITY_FIELDS, fail);
  }
}
