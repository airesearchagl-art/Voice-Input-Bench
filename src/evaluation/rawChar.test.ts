import { describe, expect, it } from 'vitest';
import { RawCharError, evaluateRawChar, toCodePoints } from './rawChar';

/**
 * raw-char-v1.
 *
 * The whole value of this baseline is what it refuses to do. Every "no
 * normalization" case below is a difference some later profile might choose to
 * forgive; none of them are forgiven here, and that is what makes this the
 * reference point the forgiving profiles get measured against.
 */

describe('raw-char-v1 counts code points, not UTF-16 units', () => {
  it('counts an astral character once', () => {
    expect(toCodePoints('a😀b')).toHaveLength(3);
    expect(evaluateRawChar('a😀b', 'a😀b').reference_chars).toBe(3);
  });

  it('treats an emoji as one character to substitute', () => {
    const metrics = evaluateRawChar('😀', '😁');
    expect(metrics).toMatchObject({
      reference_chars: 1,
      hypothesis_chars: 1,
      substitutions: 1,
      deletions: 0,
      insertions: 0,
      edit_distance: 1,
      cer: 1,
    });
  });

  it('counts a deleted astral character once, not twice', () => {
    const metrics = evaluateRawChar('a😀b', 'ab');
    expect(metrics).toMatchObject({
      reference_chars: 3,
      hypothesis_chars: 2,
      deletions: 1,
      substitutions: 0,
      insertions: 0,
      edit_distance: 1,
    });
  });
});

describe('the three operations', () => {
  it('reports an exact match as all zeros', () => {
    expect(evaluateRawChar('基準階の会議室', '基準階の会議室')).toEqual({
      exact_match: true,
      reference_chars: 7,
      hypothesis_chars: 7,
      substitutions: 0,
      deletions: 0,
      insertions: 0,
      edit_distance: 0,
      cer: 0,
    });
  });

  it('counts a replaced character as one substitution', () => {
    expect(evaluateRawChar('abc', 'axc')).toMatchObject({
      exact_match: false,
      substitutions: 1,
      deletions: 0,
      insertions: 0,
      edit_distance: 1,
      cer: 1 / 3,
    });
  });

  it('counts a missing character as one deletion', () => {
    expect(evaluateRawChar('abc', 'ac')).toMatchObject({
      substitutions: 0,
      deletions: 1,
      insertions: 0,
      edit_distance: 1,
      cer: 1 / 3,
    });
  });

  it('counts an extra character as one insertion', () => {
    expect(evaluateRawChar('ac', 'abc')).toMatchObject({
      substitutions: 0,
      deletions: 0,
      insertions: 1,
      edit_distance: 1,
      cer: 1 / 2,
    });
  });

  it('swapping reference and hypothesis swaps deletions and insertions', () => {
    const deleted = evaluateRawChar('abc', 'ac');
    const inserted = evaluateRawChar('ac', 'abc');
    expect(deleted.deletions).toBe(inserted.insertions);
    expect(deleted.insertions).toBe(inserted.deletions);
    expect(deleted.edit_distance).toBe(inserted.edit_distance);
  });

  it('reports an empty hypothesis as all deletions, CER 1', () => {
    expect(evaluateRawChar('abc', '')).toMatchObject({
      exact_match: false,
      reference_chars: 3,
      hypothesis_chars: 0,
      substitutions: 0,
      deletions: 3,
      insertions: 0,
      edit_distance: 3,
      cer: 1,
    });
  });
});

describe('nothing is normalized away', () => {
  it('does not fold NFC and NFD to the same text', () => {
    // U+304C vs U+304B U+3099 — the same grapheme, different code points.
    const metrics = evaluateRawChar('が', 'が');
    expect(metrics.exact_match).toBe(false);
    expect(metrics.reference_chars).toBe(1);
    expect(metrics.hypothesis_chars).toBe(2);
    expect(metrics.edit_distance).toBe(2);
  });

  it('does not convert full-width to half-width', () => {
    expect(evaluateRawChar('ＡＢＣ', 'ABC')).toMatchObject({
      substitutions: 3,
      edit_distance: 3,
    });
  });

  it('does not fold case', () => {
    expect(evaluateRawChar('abc', 'ABC')).toMatchObject({
      substitutions: 3,
      edit_distance: 3,
    });
  });

  it('does not trim leading or trailing whitespace', () => {
    expect(evaluateRawChar('abc', ' abc ')).toMatchObject({
      insertions: 2,
      deletions: 0,
      substitutions: 0,
      edit_distance: 2,
    });
  });

  it('does not collapse internal whitespace', () => {
    expect(evaluateRawChar('a b', 'ab')).toMatchObject({
      deletions: 1,
      edit_distance: 1,
    });
  });

  it('does not ignore a trailing newline', () => {
    expect(evaluateRawChar('abc\n', 'abc')).toMatchObject({
      reference_chars: 4,
      hypothesis_chars: 3,
      deletions: 1,
      edit_distance: 1,
    });
  });

  it('does not ignore punctuation', () => {
    expect(evaluateRawChar('です。', 'です')).toMatchObject({
      deletions: 1,
      edit_distance: 1,
    });
  });

  it('does not read 2700 and 二千七百 as the same number', () => {
    // The difference a normalization profile might later choose to forgive.
    // Here it is four substitutions and nothing else.
    expect(evaluateRawChar('二千七百ミリ', '2700ミリ')).toMatchObject({
      reference_chars: 6,
      hypothesis_chars: 6,
      substitutions: 4,
      deletions: 0,
      insertions: 0,
      edit_distance: 4,
      cer: 4 / 6,
    });
  });
});

describe('CER', () => {
  it('divides by the reference length in code points', () => {
    const metrics = evaluateRawChar('abcd', 'abxd');
    expect(metrics.cer).toBe(1 / 4);
  });

  it('is not clamped when the hypothesis runs long', () => {
    const metrics = evaluateRawChar('a', 'xyz');
    expect(metrics.edit_distance).toBe(3);
    expect(metrics.cer).toBe(3);
    expect(metrics.cer).toBeGreaterThan(1);
  });

  it('fails closed on an empty reference rather than inventing a denominator', () => {
    const error = (() => {
      try {
        evaluateRawChar('', 'なにか');
        return null;
      } catch (caught) {
        return caught;
      }
    })();

    expect(error).toBeInstanceOf(RawCharError);
    expect((error as RawCharError).kind).toBe('RAW_CHAR_EMPTY_REFERENCE');
  });

  it('fails closed on an empty reference even with an empty hypothesis', () => {
    expect(() => evaluateRawChar('', '')).toThrow(RawCharError);
  });
});

describe('determinism', () => {
  const PAIRS: Array<[string, string]> = [
    ['基準階の会議室は north side に寄せてください。', '基準階の会議室はノースサイドに寄せて下さい'],
    ['abcdef', 'badcfe'],
    ['ああああ', 'あ'],
    ['あ', 'ああああ'],
    ['天井高は二千七百ミリ', '天井高は2700mm'],
    ['a', 'b'],
  ];

  it('returns the same numbers every time', () => {
    for (const [reference, hypothesis] of PAIRS) {
      const first = evaluateRawChar(reference, hypothesis);
      const second = evaluateRawChar(reference, hypothesis);
      expect(second).toEqual(first);
    }
  });

  it('keeps edit_distance equal to S + D + I', () => {
    for (const [reference, hypothesis] of PAIRS) {
      const m = evaluateRawChar(reference, hypothesis);
      expect(m.substitutions + m.deletions + m.insertions).toBe(m.edit_distance);
    }
  });

  it('breaks a tie toward substitution, then deletion, then insertion', () => {
    // 'a' → 'xyz' has minimal-cost alignments that split three edits
    // differently. The fixed precedence picks the substitution-first one, so
    // the split is stable rather than an accident of iteration order.
    expect(evaluateRawChar('a', 'xyz')).toMatchObject({
      substitutions: 1,
      deletions: 0,
      insertions: 2,
      edit_distance: 3,
    });
  });

  it('handles a long text against itself', () => {
    const long = 'あ'.repeat(600) + '基準階の会議室は north side に寄せてください。';
    const metrics = evaluateRawChar(long, long);
    expect(metrics.exact_match).toBe(true);
    expect(metrics.edit_distance).toBe(0);
    expect(metrics.reference_chars).toBe(toCodePoints(long).length);
  });
});
