import {
  TIMESTAMP_ID_PATTERN,
  createTimestampId,
  isValidTimestampId,
} from './timestampId';

/**
 * Run IDs are generated server-side only. See {@link TIMESTAMP_ID_PATTERN} for
 * the shape and why it is safe to put in a path.
 */
export const RUN_ID_PATTERN = TIMESTAMP_ID_PATTERN;

export function createRunId(now: Date = new Date()): string {
  return createTimestampId(now);
}

export function isValidRunId(value: unknown): value is string {
  return isValidTimestampId(value);
}
