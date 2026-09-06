import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { BENCHMARK_CASES, getBenchmarkCase } from './cases';
import { DEFAULT_TARGET_MAX_CHARS, SPLIT_STRATEGY, countCodePoints, splitCanonicalText } from './splitter';

/**
 * Versioned-contract goldens.
 *
 * Two things must not drift once they are merged:
 *
 *   1. Benchmark Case bodies. Editing `-001` would change the Text SHA-256 of
 *      every future Run of that ID, so Runs before and after the edit would
 *      claim the same `test_id` while containing different words. A revised
 *      wording ships as a new ID instead.
 *
 *   2. Where `sentence-v1` cuts. Moving a boundary changes the audio of every
 *      future Run of an existing case while the manifest still says
 *      `sentence-v1`. A deliberate rule change ships as `sentence-v2`.
 *
 * If a change here is intentional, it belongs in a new case ID or a new
 * strategy — not in an updated golden.
 */

function sha256(text: string): string {
  return createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');
}

/** SHA-256 of each Benchmark Case body, as merged. */
const CASE_BODY_SHA256: Record<string, string> = {
  'architecture-short-001': '78fcd282689ce06467ffa2c82e4acbf5200fa4f273a60798c6bba311078fffc3',
  'architecture-long-001': '544bf2593d22e99d80dfce045c3164a8773c504746e53acb937a90fe38775801',
  'filler-001': '3a3f70883817defdc57acb37613b61fdcac9646e12376da9b1cfdc7ec328a62f',
  'correction-001': '53ef290525cf00c20ab325d012911bc5f85d5ffb97abacbe59d9fdd27de85260',
  'numbers-units-001': '5011798a31841d9df88cc204c69a17400b7a39f864c25ef09e2396ec86d47998',
  'coding-001': '1c566cf5592a69ca15b83d192a30afec84e6bafec52358fb199fc3c20fd7d5f7',
};

/** `sentence-v1` applied to `architecture-long-001`, segment by segment. */
const LONG_CASE_SEGMENTS: Array<{ chars: number; sha256: string }> = [
  { chars: 415, sha256: '7fb0e85a2d31ddeff8cdbb1562356cd9788346e20248809f5d09a2cd2061bcda' },
  { chars: 390, sha256: 'a4bd3973b7e6c125bedb2e24ee3f84897172ef1e9689f3b3eadec138aa7dc841' },
  { chars: 308, sha256: 'fd6b8d17f65b6c6807cc4a5d7692fcd7d60f99d64e0f8499dc7b11ef0ec9ffdf' },
];

describe('Benchmark Case corpus is versioned', () => {
  it('covers every shipped case with a golden', () => {
    expect(Object.keys(CASE_BODY_SHA256).sort()).toEqual(
      BENCHMARK_CASES.map((benchmarkCase) => benchmarkCase.id).sort(),
    );
  });

  for (const [id, expected] of Object.entries(CASE_BODY_SHA256)) {
    it(`${id} body is unchanged`, () => {
      const benchmarkCase = getBenchmarkCase(id);
      expect(benchmarkCase, `case ${id} was removed or renamed`).toBeDefined();
      expect(
        sha256(benchmarkCase!.text),
        `case ${id} body changed. Ship the new wording as a new case ID instead of editing ${id}.`,
      ).toBe(expected);
    });
  }

  it('freezes the registry array as well as its entries', () => {
    expect(Object.isFrozen(BENCHMARK_CASES)).toBe(true);
    expect(BENCHMARK_CASES.every((benchmarkCase) => Object.isFrozen(benchmarkCase))).toBe(true);
  });
});

describe('sentence-v1 cut positions are versioned', () => {
  const longCase = getBenchmarkCase('architecture-long-001')!;

  it('still names itself sentence-v1 at target 450', () => {
    expect(SPLIT_STRATEGY).toBe('sentence-v1');
    expect(DEFAULT_TARGET_MAX_CHARS).toBe(450);
  });

  it('splits architecture-long-001 into exactly 3 segments', () => {
    expect(splitCanonicalText(longCase.text)).toHaveLength(3);
  });

  it('cuts architecture-long-001 at exactly the recorded positions', () => {
    const segments = splitCanonicalText(longCase.text);

    expect(segments.map((segment) => countCodePoints(segment))).toEqual(
      LONG_CASE_SEGMENTS.map((golden) => golden.chars),
    );
    expect(segments.map((segment) => sha256(segment))).toEqual(
      LONG_CASE_SEGMENTS.map((golden) => golden.sha256),
    );
  });

  it('still reassembles into the recorded case body', () => {
    expect(splitCanonicalText(longCase.text).join('')).toBe(longCase.text);
    expect(sha256(longCase.text)).toBe(CASE_BODY_SHA256['architecture-long-001']);
  });

  it('keeps every other case in a single segment', () => {
    for (const benchmarkCase of BENCHMARK_CASES) {
      if (benchmarkCase.id === 'architecture-long-001') continue;
      expect(splitCanonicalText(benchmarkCase.text), benchmarkCase.id).toEqual([
        benchmarkCase.text,
      ]);
    }
  });
});
