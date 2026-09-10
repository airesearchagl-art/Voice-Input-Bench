import {
  isRec,
  rejectUnknownFields,
  requireObject,
  type Rec,
  type ShapeFail,
} from './evaluationShapeGuards';

/**
 * The shape of a stored raw character Evaluation (schema v1), checked before
 * `computeEvaluationSemanticSha256` walks it.
 *
 * Every list below mirrors `canonicalEvaluationPayload` field for field. They
 * are written out rather than derived so that a reviewer can compare the two by
 * eye: if the canonicalizer starts hashing something new, this file has to say
 * so too, and a diff that changes one without the other is visible.
 *
 * `evaluator` is only required to be an object here. Which contract it names is
 * EVALUATION_EVALUATOR_MISMATCH's question, and answering it from a shape check
 * would turn a wrong evaluator into a malformed file.
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

/** The seal record, which the payload hash does not cover. */
const INTEGRITY_FIELDS = ['algorithm', 'semantic_sha256'] as const;

/**
 * Confirm a v1 artifact can be canonicalized, and carries nothing unhashed.
 *
 * `fail` raises EVALUATION_MALFORMED; required *values* keep their own owners,
 * so a missing `semantic_sha256` still reaches EVALUATION_INTEGRITY_MISSING and
 * a metric that does not recompute still reaches EVALUATION_METRICS_MISMATCH.
 */
export function assertRawEvaluationShape(stored: Rec, fail: ShapeFail): void {
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
