import { describe, expect, it } from 'vitest';
import { RESULT_ID_PATTERN, createResultId, isValidResultId } from './resultId';
import { createRunId } from './runId';

describe('createResultId', () => {
  it('produces a sortable, pattern-matching id', () => {
    const resultId = createResultId(new Date('2026-09-06T02:00:00.000Z'));
    expect(resultId).toMatch(/^20260906T020000000Z-[0-9a-f]{8}$/);
    expect(RESULT_ID_PATTERN.test(resultId)).toBe(true);
  });

  it('sorts lexicographically in time order', () => {
    const earlier = createResultId(new Date('2026-09-06T02:00:00.000Z'));
    const later = createResultId(new Date('2026-09-06T02:00:01.000Z'));
    expect(earlier < later).toBe(true);
  });

  it('does not collide across successive calls at the same instant', () => {
    const at = new Date('2026-09-06T02:00:00.000Z');
    expect(new Set(Array.from({ length: 200 }, () => createResultId(at))).size).toBe(200);
  });

  it('contains no character that means anything to a path parser', () => {
    expect(createResultId()).not.toMatch(/[/\\.:]/);
  });

  it('shares its shape with run IDs, but the two live in different roots', () => {
    // Same format on purpose: one generator, one validation rule. They never
    // collide in a path because Runs and Results have separate roots.
    expect(RESULT_ID_PATTERN.test(createRunId())).toBe(true);
  });
});

describe('isValidResultId', () => {
  it('accepts a server-generated id', () => {
    expect(isValidResultId(createResultId())).toBe(true);
  });

  const REJECTED: Array<[string, unknown]> = [
    ['empty', ''],
    ['dot', '.'],
    ['parent', '..'],
    ['relative traversal', '../../etc/passwd'],
    ['windows traversal', '..\\..\\windows\\system32'],
    ['embedded traversal', '20260906T020000000Z-aabbccdd/../../secret'],
    ['escape into the runs root', '../runs/20260906T020000000Z-aabbccdd'],
    ['absolute posix path', '/etc/passwd'],
    ['absolute windows path', 'C:\\Windows'],
    ['url encoded traversal', '%2e%2e%2f'],
    ['trailing slash', '20260906T020000000Z-aabbccdd/'],
    ['null byte', '20260906T020000000Z-aabbccdd\u0000'],
    ['uppercase hex', '20260906T020000000Z-AABBCCDD'],
    ['short suffix', '20260906T020000000Z-aabbcc'],
    ['not a string', 12345],
    ['null', null],
    ['undefined', undefined],
  ];

  for (const [label, value] of REJECTED) {
    it(`rejects ${label}`, () => {
      expect(isValidResultId(value)).toBe(false);
    });
  }
});
