import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TARGET_MAX_CHARS,
  SPLIT_STRATEGY,
  SplitterError,
  countCodePoints,
  isSafeCutPoint,
  splitCanonicalText,
} from './splitter';
import { BENCHMARK_CASES } from './cases';

/** Repeat `unit` until the result has at least `chars` code points. */
function grow(unit: string, chars: number): string {
  let out = '';
  while (countCodePoints(out) < chars) out += unit;
  return out;
}

describe('strategy identity', () => {
  it('names the strategy and target that the manifest records', () => {
    expect(SPLIT_STRATEGY).toBe('sentence-v1');
    expect(DEFAULT_TARGET_MAX_CHARS).toBe(450);
  });
});

describe('lossless invariant', () => {
  const INPUTS: Array<[string, string]> = [
    ['empty', ''],
    ['short', 'これは短い文です。'],
    ['exactly at target', grow('あ', DEFAULT_TARGET_MAX_CHARS).slice(0, DEFAULT_TARGET_MAX_CHARS)],
    ['long sentences', grow('これは長い文章のテストです。', 2000)],
    ['long with newlines', grow('段落の一行目です。\n二行目です。\n\n', 2000)],
    ['no punctuation at all', grow('あ', 2000)],
    ['spaces only between words', grow('word ', 2000)],
    ['mixed scripts', grow('BIM モデルを Revit で更新して、GitHub に PR を出す。', 2000)],
    ['leading and trailing spaces', `   ${grow('文章です。', 1500)}   `],
  ];

  for (const [label, input] of INPUTS) {
    it(`joins back to the exact input: ${label}`, () => {
      const segments = splitCanonicalText(input);
      expect(segments.join('')).toBe(input);
    });
  }

  for (const [label, input] of INPUTS) {
    it(`keeps every segment within the target: ${label}`, () => {
      for (const segment of splitCanonicalText(input)) {
        expect(countCodePoints(segment)).toBeLessThanOrEqual(DEFAULT_TARGET_MAX_CHARS);
      }
    });
  }

  it('never emits an empty segment', () => {
    for (const segment of splitCanonicalText(grow('文章です。', 3000))) {
      expect(segment.length).toBeGreaterThan(0);
    }
  });

  it('returns no segments for empty text', () => {
    expect(splitCanonicalText('')).toEqual([]);
  });

  it('returns the text unchanged when it fits', () => {
    const text = 'これは一つのセグメントに収まります。';
    expect(splitCanonicalText(text)).toEqual([text]);
  });
});

describe('determinism', () => {
  const TEXT = grow('建築の設計方針について説明します。天井高は二千七百ミリです。\n', 3000);

  it('produces identical segments on repeated calls', () => {
    const first = splitCanonicalText(TEXT);
    for (let i = 0; i < 5; i += 1) {
      expect(splitCanonicalText(TEXT)).toEqual(first);
    }
  });

  it('produces identical segments for an independently built equal string', () => {
    const copy = Array.from(TEXT).join('');
    expect(copy).toBe(TEXT);
    expect(splitCanonicalText(copy)).toEqual(splitCanonicalText(TEXT));
  });

  it('is stable across different target sizes only through the target argument', () => {
    expect(splitCanonicalText(TEXT, 200)).toEqual(splitCanonicalText(TEXT, 200));
    expect(splitCanonicalText(TEXT, 200)).not.toEqual(splitCanonicalText(TEXT, 450));
  });

  it('rejects a nonsensical target instead of guessing', () => {
    expect(() => splitCanonicalText(TEXT, 0)).toThrow(RangeError);
    expect(() => splitCanonicalText(TEXT, 1.5)).toThrow(RangeError);
  });
});

describe('boundary priority', () => {
  it('prefers a newline over a later sentence end', () => {
    // Newline at 300, sentence end at 440: the newline is higher priority and
    // still long enough, so it wins.
    const text = `${'あ'.repeat(299)}\n${'い'.repeat(139)}。${'う'.repeat(400)}`;
    const [first] = splitCanonicalText(text, 450);
    expect(first!.endsWith('\n')).toBe(true);
    expect(countCodePoints(first!)).toBe(300);
  });

  it('prefers a sentence end over a later clause separator', () => {
    const text = `${'あ'.repeat(299)}。${'い'.repeat(139)}、${'う'.repeat(400)}`;
    const [first] = splitCanonicalText(text, 450);
    expect(first!.endsWith('。')).toBe(true);
    expect(countCodePoints(first!)).toBe(300);
  });

  it('prefers a clause separator over a bare space', () => {
    const text = `${'あ'.repeat(299)}、${'い'.repeat(139)} ${'う'.repeat(400)}`;
    const [first] = splitCanonicalText(text, 450);
    expect(first!.endsWith('、')).toBe(true);
  });

  it('falls back to a safe whitespace break when there is no punctuation', () => {
    const text = `${'a'.repeat(299)} ${'b'.repeat(600)}`;
    const [first] = splitCanonicalText(text, 450);
    expect(first!.endsWith(' ')).toBe(true);
  });

  it('hard splits when the window has no boundary at all', () => {
    const text = 'あ'.repeat(1000);
    const segments = splitCanonicalText(text, 450);
    expect(segments[0]).toBe('あ'.repeat(450));
    expect(segments.join('')).toBe(text);
  });

  it('ignores a high-priority boundary that would leave a tiny segment', () => {
    // A newline 5 characters in would win on priority alone, but it is below
    // the minimum segment size, so the later sentence end is used instead.
    const text = `${'あ'.repeat(4)}\n${'い'.repeat(394)}。${'う'.repeat(500)}`;
    const [first] = splitCanonicalText(text, 450);
    expect(first!.endsWith('。')).toBe(true);
    expect(countCodePoints(first!)).toBe(400);
  });

  it('keeps the delimiter with the segment it ends', () => {
    const text = `${'あ'.repeat(299)}。${'い'.repeat(600)}`;
    const segments = splitCanonicalText(text, 450);
    expect(segments[0]!.endsWith('。')).toBe(true);
    expect(segments[1]!.startsWith('。')).toBe(false);
  });
});

describe('character preservation', () => {
  it('preserves runs of spaces across a boundary', () => {
    const text = `${'あ'.repeat(300)}。   ${'い'.repeat(600)}`;
    expect(splitCanonicalText(text, 450).join('')).toBe(text);
  });

  it('preserves punctuation exactly', () => {
    const text = grow('、。「」！？…‥ー－—,.!? ', 2000);
    expect(splitCanonicalText(text, 450).join('')).toBe(text);
  });

  it('never splits a surrogate pair', () => {
    const text = grow('𠮷', 2000);
    for (const segment of splitCanonicalText(text, 450)) {
      // A lone surrogate would round-trip differently.
      expect(Array.from(segment).every((cp) => cp.length === 2)).toBe(true);
    }
    expect(splitCanonicalText(text, 450).join('')).toBe(text);
  });

  it('never splits a ZWJ emoji sequence', () => {
    const family = '\u{1F468}‍\u{1F469}‍\u{1F467}';
    const text = grow(`${family}あ`, 2000);
    for (const segment of splitCanonicalText(text, 450)) {
      expect(segment.startsWith('‍')).toBe(false);
      expect(segment.endsWith('‍')).toBe(false);
      // A ZWJ sequence that survived intact still contains the whole family.
      expect((segment.match(/‍/gu) ?? []).length % 2).toBe(0);
    }
    expect(splitCanonicalText(text, 450).join('')).toBe(text);
  });

  it('never splits an emoji from its variation selector or skin tone', () => {
    const text = grow('\u{1F44D}\u{1F3FB}❤️', 2000);
    for (const segment of splitCanonicalText(text, 450)) {
      const firstCp = Array.from(segment)[0]!.codePointAt(0)!;
      expect(firstCp >= 0xfe00 && firstCp <= 0xfe0f).toBe(false);
      expect(firstCp >= 0x1f3fb && firstCp <= 0x1f3ff).toBe(false);
    }
    expect(splitCanonicalText(text, 450).join('')).toBe(text);
  });

  it('never splits a flag into two regional indicators', () => {
    const text = grow('\u{1F1EF}\u{1F1F5}', 2000);
    for (const segment of splitCanonicalText(text, 450)) {
      expect(Array.from(segment).length % 2).toBe(0);
    }
    expect(splitCanonicalText(text, 450).join('')).toBe(text);
  });

  it('never splits a combining mark from its base', () => {
    const text = grow('が', 2000);
    for (const segment of splitCanonicalText(text, 450)) {
      expect(segment.startsWith('゙')).toBe(false);
    }
    expect(splitCanonicalText(text, 450).join('')).toBe(text);
  });
});

describe('isSafeCutPoint', () => {
  it('refuses cuts at the ends of the array', () => {
    const cps = Array.from('あい');
    expect(isSafeCutPoint(cps, 0)).toBe(false);
    expect(isSafeCutPoint(cps, cps.length)).toBe(false);
  });

  it('allows a cut between two plain characters', () => {
    expect(isSafeCutPoint(Array.from('あい'), 1)).toBe(true);
  });
});

describe('built-in cases', () => {
  it('splits architecture-long-001 into multiple segments', () => {
    const longCase = BENCHMARK_CASES.find((c) => c.id === 'architecture-long-001')!;
    const segments = splitCanonicalText(longCase.text);
    expect(segments.length).toBeGreaterThan(1);
    expect(segments.join('')).toBe(longCase.text);
    for (const segment of segments) {
      expect(countCodePoints(segment)).toBeLessThanOrEqual(DEFAULT_TARGET_MAX_CHARS);
    }
  });

  it('keeps architecture-short-001 in a single segment', () => {
    const shortCase = BENCHMARK_CASES.find((c) => c.id === 'architecture-short-001')!;
    expect(splitCanonicalText(shortCase.text)).toEqual([shortCase.text]);
  });

  it('round-trips every built-in case', () => {
    for (const benchmarkCase of BENCHMARK_CASES) {
      expect(splitCanonicalText(benchmarkCase.text).join('')).toBe(benchmarkCase.text);
    }
  });
});

describe('strict segment bound', () => {
  it('fails closed instead of emitting an oversized segment', () => {
    // One base character followed by 600 combining marks: a single grapheme
    // cluster longer than the target, with no safe cut inside the window.
    const oneHugeGrapheme = `あ${'\u0301'.repeat(600)}あ`;

    let caught: unknown;
    try {
      splitCanonicalText(oneHugeGrapheme, 450);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(SplitterError);
    expect((caught as SplitterError).kind).toBe('UNBREAKABLE_TEXT');
  });

  it('never returns a segment longer than the target for splittable text', () => {
    const text = grow('これは長い文章のテストです。', 5000);
    for (const segment of splitCanonicalText(text, 450)) {
      expect(countCodePoints(segment)).toBeLessThanOrEqual(450);
    }
  });

  it('still splits text where the huge cluster is preceded by a safe cut', () => {
    // The cluster starts within the first window, so the boundary before it is
    // usable and the cluster lands whole at the start of the next segment.
    const text = `${'あ'.repeat(200)}。か${'\u0301'.repeat(100)}${'い'.repeat(600)}`;
    const segments = splitCanonicalText(text, 450);
    expect(segments.join('')).toBe(text);
    for (const segment of segments) {
      expect(countCodePoints(segment)).toBeLessThanOrEqual(450);
    }
  });
});
