import { describe, expect, it } from 'vitest';
import {
  FULLWIDTH_ASCII_RANGE,
  PRESERVED_WHITESPACE,
  PUNCTUATION_ALIASES,
  SPACE_POLICY_CHARS,
  SURFACE_CASE_FOLD,
  SURFACE_CHAR_ALGORITHM,
  SURFACE_DISTANCE,
  SURFACE_LINE_BREAK_POLICY,
  SURFACE_NORMALIZE_PROFILE,
  SURFACE_NORMALIZE_STEPS,
  SURFACE_PUNCTUATION_ALIASES,
  SURFACE_SPACE_POLICY,
  SURFACE_WIDTH_MAPPING,
  surfaceNormalize,
  surfaceNormalizedLength,
} from './surfaceNormalize';
import {
  SURFACE_CHAR_EVALUATOR,
  SURFACE_EVALUATOR_FIELDS,
  isSurfaceCharEvaluator,
} from './surfaceEvaluationSchema';
import { evaluateRawChar } from './rawChar';

/**
 * surface-normalize-v1.
 *
 * Two lists carry this file: what must fold together because it is typography,
 * and what must stay apart because it is meaning. The second list is the
 * important one — every entry in it is something a Unicode normalization form
 * would have quietly merged.
 */

/** Do these two texts compare as identical after normalization? */
function same(a: string, b: string): boolean {
  return surfaceNormalize(a) === surfaceNormalize(b);
}

describe('golden contract: surface-normalize-v1', () => {
  it('is exactly this pipeline, in this order', () => {
    // This list is the version. Adding a step is a new profile, not an edit:
    // artifacts already on disk claim `surface-normalize-v1` and have to keep
    // meaning what they meant.
    expect(SURFACE_NORMALIZE_STEPS).toEqual([
      'fullwidth-ascii-to-ascii',
      'ideographic-space-to-ascii-space',
      'ascii-uppercase-to-lowercase',
      'ideographic-full-stop-to-period',
      'ideographic-comma-to-comma',
      'collapse-consecutive-ascii-spaces',
      'trim-leading-trailing-ascii-spaces',
      'preserve-lf-and-tab',
    ]);
  });

  it('names the profile and the evaluator', () => {
    expect(SURFACE_NORMALIZE_PROFILE).toBe('surface-normalize-v1');
    expect(SURFACE_CHAR_ALGORITHM).toBe('surface-normalized-char-v1');
  });
});

describe('golden contract: the nine evaluator fields', () => {
  it('names each versioned sub-contract', () => {
    expect(SURFACE_CHAR_EVALUATOR).toEqual({
      id: 'surface-normalized-char-v1',
      unit: 'unicode-code-point',
      normalization_profile: 'surface-normalize-v1',
      width_mapping: 'fullwidth-ascii-range-v1',
      case_fold: 'ascii-lower-v1',
      punctuation_aliases: 'punctuation-alias-v1',
      space_policy: 'ascii-space-trim-collapse-v1',
      line_break_policy: 'preserve-lf-v1',
      distance: 'levenshtein-code-point-sdi-v1',
    });
  });

  it('is exactly nine fields, in this order', () => {
    expect(SURFACE_EVALUATOR_FIELDS).toEqual([
      'id',
      'unit',
      'normalization_profile',
      'width_mapping',
      'case_fold',
      'punctuation_aliases',
      'space_policy',
      'line_break_policy',
      'distance',
    ]);
    expect(Object.keys(SURFACE_CHAR_EVALUATOR)).toHaveLength(9);
    expect(Object.keys(SURFACE_CHAR_EVALUATOR).sort()).toEqual(
      [...SURFACE_EVALUATOR_FIELDS].sort(),
    );
  });

  it('exports each name as its own constant', () => {
    expect(SURFACE_WIDTH_MAPPING).toBe('fullwidth-ascii-range-v1');
    expect(SURFACE_CASE_FOLD).toBe('ascii-lower-v1');
    expect(SURFACE_PUNCTUATION_ALIASES).toBe('punctuation-alias-v1');
    expect(SURFACE_SPACE_POLICY).toBe('ascii-space-trim-collapse-v1');
    expect(SURFACE_LINE_BREAK_POLICY).toBe('preserve-lf-v1');
    expect(SURFACE_DISTANCE).toBe('levenshtein-code-point-sdi-v1');
  });

  it('accepts only the exact record', () => {
    expect(isSurfaceCharEvaluator(SURFACE_CHAR_EVALUATOR)).toBe(true);
    expect(isSurfaceCharEvaluator({ ...SURFACE_CHAR_EVALUATOR, case_fold: 'unicode-lower-v1' })).toBe(
      false,
    );
    // An extra field describes semantics this build has never heard of.
    expect(isSurfaceCharEvaluator({ ...SURFACE_CHAR_EVALUATOR, rounding: 'nearest-v1' })).toBe(false);
    const { distance: _distance, ...missingOne } = SURFACE_CHAR_EVALUATOR;
    expect(isSurfaceCharEvaluator(missingOne)).toBe(false);
    expect(isSurfaceCharEvaluator(null)).toBe(false);
    expect(isSurfaceCharEvaluator([])).toBe(false);
  });
});

describe('golden contract: what each sub-contract name means', () => {
  it('fullwidth-ascii-range-v1 is U+FF01..U+FF5E offset by U+FEE0', () => {
    expect(FULLWIDTH_ASCII_RANGE).toEqual({ start: 0xff01, end: 0xff5e, offset: 0xfee0 });
    // The whole range maps, and nothing on either side of it does.
    for (let code = FULLWIDTH_ASCII_RANGE.start; code <= FULLWIDTH_ASCII_RANGE.end; code += 1) {
      const expected = String.fromCodePoint(code - FULLWIDTH_ASCII_RANGE.offset).toLowerCase();
      expect(surfaceNormalize(String.fromCodePoint(code))).toBe(expected);
    }
    expect(surfaceNormalize('＀')).toBe('＀');
    expect(surfaceNormalize('｟')).toBe('｟');
  });

  it('ascii-lower-v1 folds only ASCII A-Z', () => {
    expect(surfaceNormalize('ABCXYZ')).toBe('abcxyz');
    for (const outside of ['Ä', 'Σ', 'Б', 'İ']) {
      expect(surfaceNormalize(outside)).toBe(outside);
    }
  });

  it('punctuation-alias-v1 is exactly two replacements and no deletions', () => {
    expect(PUNCTUATION_ALIASES).toEqual({ '。': '.', '、': ',' });
    expect(Object.keys(PUNCTUATION_ALIASES)).toHaveLength(2);
    for (const [from, to] of Object.entries(PUNCTUATION_ALIASES)) {
      expect(surfaceNormalize(from)).toBe(to);
    }
    // Other Japanese punctuation is left alone rather than folded or dropped.
    for (const kept of ['・', '「', '」', '！', '？'.normalize()]) {
      expect(surfaceNormalize(kept).length).toBeGreaterThan(0);
    }
    expect(surfaceNormalize('・')).toBe('・');
  });

  it('ascii-space-trim-collapse-v1 acts on U+0020 only', () => {
    expect(SPACE_POLICY_CHARS).toEqual([' ']);
    expect(surfaceNormalize('  a   b  ')).toBe('a b');
    // U+3000 becomes U+0020 first, so it participates.
    expect(surfaceNormalize('　a　　b　')).toBe('a b');
    // A tab does not.
    expect(surfaceNormalize('\ta\t\tb\t')).toBe('\ta\t\tb\t');
  });

  it('preserve-lf-v1 passes LF and tab through untouched', () => {
    expect(PRESERVED_WHITESPACE).toEqual(['\n', '\t']);
    expect(surfaceNormalize('a\n\n\tb')).toBe('a\n\n\tb');
    // A CR is not an ASCII space and is not a line feed: it passes through.
    expect(surfaceNormalize('a\r\nb')).toBe('a\r\nb');
  });

  it('levenshtein-code-point-sdi-v1 is raw-char-v1 over the normalized pair', () => {
    const metrics = evaluateRawChar(surfaceNormalize('ＡＢ'), surfaceNormalize('ab'));
    expect(metrics.exact_match).toBe(true);
    // Same S/D/I shape and the same unclamped CER as raw-char-v1.
    const over = evaluateRawChar(surfaceNormalize('Ａ'), surfaceNormalize('xyz'));
    expect(over.cer).toBeGreaterThan(1);
    expect(over.substitutions + over.deletions + over.insertions).toBe(over.edit_distance);
  });
});

describe('required equivalences', () => {
  const EQUIVALENT: Array<[string, string, string]> = [
    ['GitHub', 'github', 'case'],
    ['ＰＲ', 'pr', 'fullwidth letters and case'],
    ['ＡＢＣ１２３', 'abc123', 'fullwidth letters and digits'],
    ['hello　 world', 'hello world', 'ideographic space then collapse'],
    ['a  b', 'a b', 'collapsed spaces'],
    ['です。', 'です.', 'ideographic full stop'],
    ['項目、確認', '項目,確認', 'ideographic comma'],
  ];

  for (const [a, b, why] of EQUIVALENT) {
    it(`${JSON.stringify(a)} folds onto ${JSON.stringify(b)} — ${why}`, () => {
      expect(surfaceNormalize(a)).toBe(surfaceNormalize(b));
    });

    it(`${JSON.stringify(a)} against ${JSON.stringify(b)} is an exact surface match`, () => {
      const metrics = evaluateRawChar(surfaceNormalize(a), surfaceNormalize(b));
      expect(metrics.exact_match).toBe(true);
      expect(metrics.edit_distance).toBe(0);
      expect(metrics.cer).toBe(0);
    });
  }
});

describe('required non-equivalences', () => {
  const DIFFERENT: Array<[string, string, string]> = [
    ['二千七百ミリ', '2700mm', 'numeral and unit spelling is not typography'],
    ['320㎡', '320m2', 'a compatibility character is not a unit conversion'],
    ['m²', 'm2', 'a superscript is not a digit'],
    ['north side', 'south side', 'different content'],
    ['north side', '北側', 'a translation is not a normalization'],
    ['a\nb', 'a b', 'a line break is not a space'],
    ['梁貫通しない', '梁貫通する', 'negation'],
  ];

  for (const [a, b, why] of DIFFERENT) {
    it(`${JSON.stringify(a)} stays different from ${JSON.stringify(b)} — ${why}`, () => {
      expect(same(a, b)).toBe(false);
      expect(evaluateRawChar(surfaceNormalize(a), surfaceNormalize(b)).edit_distance).toBeGreaterThan(
        0,
      );
    });
  }
});

describe('the profile is not a Unicode normalization form', () => {
  it('does not apply NFKC to compatibility characters', () => {
    // NFKC would turn ㎡ into m2 and ㎥ into m3, folding unit spellings together
    // as a side effect. That is critical-info-v1's call to make, not this one's.
    expect(surfaceNormalize('㎡')).toBe('㎡');
    expect(surfaceNormalize('㎥/h')).toBe('㎥/h');
    expect(surfaceNormalize('㎜')).toBe('㎜');
    expect(surfaceNormalize('m²')).toBe('m²');
  });

  it('does not apply NFC or NFD to combining marks', () => {
    const composed = 'が';
    const decomposed = 'が';
    expect(surfaceNormalize(composed)).toBe(composed);
    expect(surfaceNormalize(decomposed)).toBe(decomposed);
    expect(same(composed, decomposed)).toBe(false);
  });

  it('does not normalize kana width or form', () => {
    // Halfwidth katakana lives outside U+FF01–U+FF5E and is left alone.
    expect(surfaceNormalize('ﾐﾘ')).toBe('ﾐﾘ');
    expect(same('ﾐﾘ', 'ミリ')).toBe(false);
    expect(same('ミリ', 'みり')).toBe(false);
  });

  it('does not transliterate or translate', () => {
    expect(same('北側', 'きたがわ')).toBe(false);
    expect(same('北側', 'kitagawa')).toBe(false);
  });

  it('does not rewrite Japanese numerals as digits', () => {
    expect(surfaceNormalize('二千七百')).toBe('二千七百');
    expect(same('二千七百', '2700')).toBe(false);
  });

  it('does not map unit spellings onto each other', () => {
    expect(same('ミリ', 'mm')).toBe(false);
    expect(same('平米', 'm2')).toBe(false);
    expect(same('立方メートル毎時', 'm3/h')).toBe(false);
  });
});

describe('what the pipeline does, step by step', () => {
  it('maps the whole fullwidth ASCII block', () => {
    expect(surfaceNormalize('！＃＄％＆（）＋＝？＠［］＿｛｝～')).toBe('!#$%&()+=?@[]_{}~');
    expect(surfaceNormalize('ＡＺａｚ')).toBe('azaz');
    expect(surfaceNormalize('０９')).toBe('09');
  });

  it('lowercases only ASCII A-Z', () => {
    expect(surfaceNormalize('GitHub PR')).toBe('github pr');
    // Non-ASCII letters with case are left alone: lowercasing them would be a
    // language-aware transform, not a surface one.
    expect(surfaceNormalize('Ä')).toBe('Ä');
  });

  it('replaces the ideographic full stop and comma without deleting anything', () => {
    expect(surfaceNormalize('です。')).toBe('です.');
    expect(surfaceNormalize('項目、確認')).toBe('項目,確認');
    // Punctuation is replaced, never removed.
    expect(surfaceNormalize('です。').endsWith('.')).toBe(true);
  });

  it('collapses runs of ASCII spaces to one', () => {
    expect(surfaceNormalize('a   b')).toBe('a b');
    expect(surfaceNormalize('a　　b')).toBe('a b');
    expect(surfaceNormalize('a 　 b')).toBe('a b');
  });

  it('trims leading and trailing ASCII spaces', () => {
    expect(surfaceNormalize('  a b  ')).toBe('a b');
    expect(surfaceNormalize('　a　')).toBe('a');
    expect(surfaceNormalize('   ')).toBe('');
  });

  it('preserves line feeds and tabs', () => {
    expect(surfaceNormalize('a\nb')).toBe('a\nb');
    expect(surfaceNormalize('a\tb')).toBe('a\tb');
    expect(surfaceNormalize('a\n\nb')).toBe('a\n\nb');
    // A tab is not an ASCII space, so it is neither collapsed nor trimmed.
    expect(surfaceNormalize('\ta\t')).toBe('\ta\t');
  });

  it('does not join lines', () => {
    const twoLines = '一行目\n二行目';
    expect(surfaceNormalize(twoLines)).toBe(twoLines);
    expect(same(twoLines, '一行目 二行目')).toBe(false);
  });

  it('counts an astral character once', () => {
    expect(surfaceNormalizedLength('😀ab')).toBe(3);
    expect(surfaceNormalize('😀AB')).toBe('😀ab');
  });

  it('is idempotent', () => {
    for (const text of ['ＧitHub　 PR', '  です。  ', 'a\n b ', '㎡ m² 二千七百']) {
      expect(surfaceNormalize(surfaceNormalize(text))).toBe(surfaceNormalize(text));
    }
  });
});

describe('surface reading against raw reading', () => {
  it('forgives a formatting-only difference the raw reading counts', () => {
    const reference = 'BIM モデルの更新は Revit 側で行ってから、GitHub に PR を出してください。';
    const hypothesis = 'ＢＩＭ モデルの更新は Ｒｅｖｉｔ 側で行ってから、ｇｉｔｈｕｂ に ＰＲ を出してください。';

    const raw = evaluateRawChar(reference, hypothesis);
    const surface = evaluateRawChar(surfaceNormalize(reference), surfaceNormalize(hypothesis));

    expect(raw.edit_distance).toBeGreaterThan(0);
    expect(surface.exact_match).toBe(true);
    expect(surface.edit_distance).toBe(0);
  });

  it('keeps a content difference in both readings', () => {
    const reference = '会議室は north side に寄せてください。';
    const hypothesis = '会議室は south side に寄せてください。';

    expect(evaluateRawChar(reference, hypothesis).edit_distance).toBeGreaterThan(0);
    expect(
      evaluateRawChar(surfaceNormalize(reference), surfaceNormalize(hypothesis)).edit_distance,
    ).toBeGreaterThan(0);
  });

  it('keeps the numeral difference the critical evaluator would forgive', () => {
    // 二千七百ミリ and 2700mm are the same fact under critical-info-v1 and two
    // different texts here. Both readings are correct about different questions.
    const surface = evaluateRawChar(surfaceNormalize('二千七百ミリ'), surfaceNormalize('2700mm'));
    expect(surface.edit_distance).toBeGreaterThan(0);
    expect(surface.exact_match).toBe(false);
  });
});
