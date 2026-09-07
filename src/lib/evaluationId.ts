import { TIMESTAMP_ID_PATTERN, createTimestampId, isValidTimestampId } from './timestampId';

/**
 * Evaluation IDs are generated server-side only, in the same shape as Run,
 * Result and Session IDs. They live in their own root (`data/evaluations/`), so
 * the shared format never puts two artifacts in the same path.
 */
export const EVALUATION_ID_PATTERN = TIMESTAMP_ID_PATTERN;

export function createEvaluationId(now: Date = new Date()): string {
  return createTimestampId(now);
}

export function isValidEvaluationId(value: unknown): value is string {
  return isValidTimestampId(value);
}
