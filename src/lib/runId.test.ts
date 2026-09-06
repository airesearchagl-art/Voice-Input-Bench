import { describe, expect, it } from 'vitest';
import { RUN_ID_PATTERN, createRunId, isValidRunId } from './runId';

describe('createRunId', () => {
  it('produces a sortable, pattern-matching id', () => {
    const runId = createRunId(new Date('2026-09-06T01:13:43.123Z'));
    expect(runId).toMatch(/^20260906T011343123Z-[0-9a-f]{8}$/);
    expect(RUN_ID_PATTERN.test(runId)).toBe(true);
  });

  it('sorts lexicographically in time order', () => {
    const earlier = createRunId(new Date('2026-09-06T01:13:43.123Z'));
    const later = createRunId(new Date('2026-09-06T01:13:44.000Z'));
    expect(earlier < later).toBe(true);
  });

  it('does not collide across successive calls at the same instant', () => {
    const at = new Date('2026-09-06T01:13:43.123Z');
    const ids = new Set(Array.from({ length: 200 }, () => createRunId(at)));
    expect(ids.size).toBe(200);
  });

  it('contains no character that means anything to a path parser', () => {
    const runId = createRunId();
    expect(runId).not.toMatch(/[/\\.:]/);
  });
});

describe('isValidRunId', () => {
  it('accepts a server-generated id', () => {
    expect(isValidRunId(createRunId())).toBe(true);
  });

  const REJECTED: Array<[string, unknown]> = [
    ['empty', ''],
    ['dot', '.'],
    ['parent', '..'],
    ['relative traversal', '../../etc/passwd'],
    ['windows traversal', '..\\..\\windows\\system32'],
    ['embedded traversal', '20260906T011343123Z-aabbccdd/../../secret'],
    ['absolute posix path', '/etc/passwd'],
    ['absolute windows path', 'C:\\Windows'],
    ['url encoded traversal', '%2e%2e%2f'],
    ['trailing slash', '20260906T011343123Z-aabbccdd/'],
    ['null byte', '20260906T011343123Z-aabbccdd\u0000'],
    ['uppercase hex', '20260906T011343123Z-AABBCCDD'],
    ['short suffix', '20260906T011343123Z-aabbcc'],
    ['missing suffix', '20260906T011343123Z'],
    ['wrong separator', '20260906T011343123Z_aabbccdd'],
    ['not a string', 12345],
    ['null', null],
    ['undefined', undefined],
  ];

  for (const [label, value] of REJECTED) {
    it(`rejects ${label}`, () => {
      expect(isValidRunId(value)).toBe(false);
    });
  }
});
