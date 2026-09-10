import { EvaluationVerificationError } from './verifyStoredEvaluation';

/**
 * Structural validation of a stored Critical Evaluation, before it is sealed.
 *
 * `canonicalCriticalEvaluationPayload` names every property by hand — including
 * `entities.reference.map(canonicalEntity)` and `matches.map(canonicalMatch)` —
 * which is what keeps the seal independent of key order and indentation. The
 * cost is that it dereferences whatever the file actually contains, so an
 * artifact written before the entity model was settled reached it and threw
 * `TypeError: Cannot read properties of undefined (reading 'kind')`: its matches
 * carry `reference_surface` and `reference_offset` rather than a `reference`
 * object, so `canonicalEntity(match.reference)` was handed `undefined`.
 *
 * That surfaced as `UNEXPECTED`, which names neither the artifact nor the field.
 *
 * **This checks structure only, and deliberately not fields.** The failure being
 * fixed is a dereference, so what has to hold is exactly that: every object the
 * canonicalizer steps into is an object, and every array it maps over is an
 * array. Whether an entity carries the right *fields* is a different question,
 * and one that already has an owner — recomputation compares the stored working
 * against a fresh analysis and reports EVALUATION_ENTITIES_MISMATCH. Validating
 * fields here would intercept that and relabel a mismatch as malformed, which
 * would lose the more precise answer the reader already had.
 *
 * Unknown fields are likewise not rejected. They are a real exposure and are
 * reported separately; they are not what breaks readback, and closing the v2
 * contract is a decision about artifacts already on disk rather than a fix for
 * this defect.
 */

type Rec = Record<string, unknown>;

function isRec(value: unknown): value is Rec {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Confirm the canonicalizer can walk this artifact without stepping into
 * `undefined`, or throw EVALUATION_MALFORMED naming the exact path.
 */
export function assertCriticalEvaluationShape(evaluationId: string, stored: Rec): void {
  const bad = (path: string, expected: string, actual: unknown): never => {
    throw new EvaluationVerificationError(
      'EVALUATION_MALFORMED',
      evaluationId,
      `evaluation.json の ${path} が ${expected} ではありません。`,
      `path=${path} actual=${JSON.stringify(actual) ?? String(actual)}`,
    );
  };

  const object = (value: unknown, path: string): Rec => {
    if (!isRec(value)) return bad(path, 'オブジェクト', value);
    return value;
  };

  /** An array whose every element the canonicalizer will step into. */
  const objectArray = (value: unknown, path: string): void => {
    if (!Array.isArray(value)) {
      bad(path, '配列', value);
      return;
    }
    value.forEach((item, i) => object(item, `${path}[${i}]`));
  };

  // Each of these is stepped into by name in the canonical payload.
  object(stored.evaluator, 'evaluator');
  const subject = object(stored.subject, 'subject');
  object(subject.tool, 'subject.tool');
  object(subject.capture, 'subject.capture');
  object(stored.reference, 'reference');
  object(stored.hypothesis, 'hypothesis');
  object(stored.run_evidence, 'run_evidence');
  object(stored.metrics, 'metrics');

  const entities = object(stored.entities, 'entities');
  objectArray(entities.reference, 'entities.reference');
  objectArray(entities.hypothesis, 'entities.hypothesis');

  objectArray(stored.missing, 'missing');
  objectArray(stored.extra, 'extra');

  // The one that actually broke. A match is stepped into twice more, and a
  // historical match has neither `reference` nor `hypothesis` as an object.
  if (!Array.isArray(stored.matches)) {
    bad('matches', '配列', stored.matches);
    return;
  }
  stored.matches.forEach((item, i) => {
    const path = `matches[${i}]`;
    const match = object(item, path);
    object(match.reference, `${path}.reference`);
    object(match.hypothesis, `${path}.hypothesis`);
  });
}
