import {
  TIMESTAMP_ID_PATTERN,
  createTimestampId,
  isValidTimestampId,
} from './timestampId';

/**
 * Result IDs are generated server-side only, in the same shape as Run IDs.
 * They live in a different root (`data/results/`), so the two never collide in
 * a path even though the format is shared.
 */
export const RESULT_ID_PATTERN = TIMESTAMP_ID_PATTERN;

export function createResultId(now: Date = new Date()): string {
  return createTimestampId(now);
}

export function isValidResultId(value: unknown): value is string {
  return isValidTimestampId(value);
}
