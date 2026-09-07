import {
  TIMESTAMP_ID_PATTERN,
  createTimestampId,
  isValidTimestampId,
} from './timestampId';

/**
 * Session IDs are generated server-side only, in the same shape as Run and
 * Result IDs. They live in their own root (`data/sessions/`), so the shared
 * format never puts two different kinds of artifact in the same path.
 */
export const SESSION_ID_PATTERN = TIMESTAMP_ID_PATTERN;

export function createSessionId(now: Date = new Date()): string {
  return createTimestampId(now);
}

export function isValidSessionId(value: unknown): value is string {
  return isValidTimestampId(value);
}
