import { randomBytes } from 'node:crypto';

/**
 * Server-generated identifiers for stored artifacts.
 *
 * A client never chooses one, and a client-supplied ID is only ever matched
 * against {@link TIMESTAMP_ID_PATTERN} before it is allowed anywhere near the
 * filesystem.
 *
 * Shape: `<YYYYMMDD>T<HHmmssSSS>Z-<8 hex>` — sortable by time, unique in
 * practice, and containing no character that means anything to a path parser.
 */
export const TIMESTAMP_ID_PATTERN = /^\d{8}T\d{9}Z-[0-9a-f]{8}$/;

export function createTimestampId(now: Date = new Date()): string {
  // 2026-09-06T01:13:43.123Z -> 20260906T011343123Z
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.(\d{3})Z$/, '$1Z');
  return `${stamp}-${randomBytes(4).toString('hex')}`;
}

export function isValidTimestampId(value: unknown): value is string {
  return typeof value === 'string' && TIMESTAMP_ID_PATTERN.test(value);
}
