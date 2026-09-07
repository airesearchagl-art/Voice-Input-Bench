import { describe, expect, it } from 'vitest';
import {
  CRITICAL_INFO_ALGORITHM,
  CRITICAL_INFO_MATCHING,
  CRITICAL_INFO_NUMBER_GRAMMAR,
  CRITICAL_INFO_SCOPE,
  CRITICAL_INFO_SEPARATOR_POLICY,
  CRITICAL_INFO_UNIT_ALIASES,
  CriticalInfoError,
  MAX_SUPPORTED_INTEGER,
  SEPARATOR_CHARS,
  UNIT_ALIASES,
  analyzeCriticalInfo,
  extractCritical,
  extractCriticalEntities,
  parseNumeral,
} from './criticalInfo';

/**
 * critical-info-v1.
 *
 * Two lists carry this file: things that must read as the same fact however
 * they were spelled, and things that must never be folded together no matter
 * how similar they look. Around them sit the golden tests that pin the named
 * contracts, so widening the grammar or the unit table cannot happen quietly.
 */

function keys(text: string): string[] {
  return extractCriticalEntities(text).map((entity) => entity.canonical_key);
}

function raws(text: string): string[] {
  return extractCriticalEntities(text).map((entity) => entity.raw);
}

describe('golden contract: unit-alias-v1', () => {
  it('recognizes exactly these units and these spellings', () => {
    // Changing this table changes what a preservation rate means. A new
    // spelling is a new contract version, not an edit.
    expect(UNIT_ALIASES).toEqual({
      millimetre: ['mm', 'ミリ', 'ミリメートル'],
      'square-metre': ['㎡', 'm²', 'm2', '平米', '平方メートル'],
      'cubic-metre-per-hour': ['㎥/h', 'm³/h', 'm3/h', '立方メートル毎時', '立方メートル/時'],
      'metre-per-second': ['m/s', 'メートル毎秒'],
    });
    expect(Object.keys(UNIT_ALIASES)).toHaveLength(4);
  });

  it('does not recognize units outside the approved set', () => {
    for (const text of [
      '3cm',
      '3m',
      '3km',
      '3m3',
      '3kg',
      '3g',
      '3%',
      '3h',
      '3min',
      '一階',
      '三人',
      '千円',
      '3㎜',
      '3ｍｍ',
      '3センチ',
      '3メートル',
      '3立方メートル',
    ]) {
      expect(keys(text)).toEqual([]);
    }
  });
});

describe('golden contract: number-grammar-v1', () => {
  it('reads every approved standalone numeral character', () => {
    // 万 is the one that cannot stand alone: it scales a section, and there is
    // no section in front of it here.
    const standalone: Record<string, number> = {
      '〇': 0,
      零: 0,
      一: 1,
      二: 2,
      三: 3,
      四: 4,
      五: 5,
      六: 6,
      七: 7,
      八: 8,
      九: 9,
      十: 10,
      百: 100,
      千: 1000,
    };
    for (const [char, value] of Object.entries(standalone)) {
      expect(parseNumeral(char)).toBe(value);
    }
    expect(parseNumeral('万')).toBeNull();
  });

  it('recognizes no numeral character outside the approved set', () => {
    for (const char of ['億', '兆', '壱', '弐', '参', '拾', 'Ⅲ', '½']) {
      expect(parseNumeral(char)).toBeNull();
    }
  });

  it('reads at most 99,999,999', () => {
    expect(MAX_SUPPORTED_INTEGER).toBe(99_999_999);
    expect(parseNumeral('99999999')).toBe(99_999_999);
    expect(parseNumeral('100000000')).toBeNull();
  });
});

describe('golden contract: space-fullwidth-space-v1', () => {
  it('allows exactly an ASCII space and a full-width space as the separator', () => {
    expect(SEPARATOR_CHARS).toEqual([' ', '　']);
    expect(keys('2700 mm')).toEqual(['measurement:2700:millimetre']);
    expect(keys('2700　mm')).toEqual(['measurement:2700:millimetre']);
    expect(keys('2700　 　mm')).toEqual(['measurement:2700:millimetre']);
  });

  it('does not cross a line break or a tab', () => {
    expect(keys('2700\nmm')).toEqual([]);
    expect(keys('2700\tmm')).toEqual([]);
  });
});

describe('golden contract: evaluator field values', () => {
  it('names each versioned contract', () => {
    expect(CRITICAL_INFO_ALGORITHM).toBe('critical-info-v1');
    expect(CRITICAL_INFO_SCOPE).toBe('numeric-unit-time');
    expect(CRITICAL_INFO_NUMBER_GRAMMAR).toBe('number-grammar-v1');
    expect(CRITICAL_INFO_UNIT_ALIASES).toBe('unit-alias-v1');
    expect(CRITICAL_INFO_MATCHING).toBe('canonical-multiset-v1');
    expect(CRITICAL_INFO_SEPARATOR_POLICY).toBe('space-fullwidth-space-v1');
  });
});

describe('numeral reading', () => {
  it('reads ASCII integers', () => {
    expect(parseNumeral('2700')).toBe(2700);
    expect(parseNumeral('0')).toBe(0);
    expect(parseNumeral('320')).toBe(320);
  });

  it('reads full-width integers', () => {
    expect(parseNumeral('２７００')).toBe(2700);
    expect(parseNumeral('０')).toBe(0);
  });

  it('reads positional Japanese integers', () => {
    expect(parseNumeral('二千七百')).toBe(2700);
    expect(parseNumeral('三百二十')).toBe(320);
    expect(parseNumeral('五百九十')).toBe(590);
    expect(parseNumeral('三')).toBe(3);
    expect(parseNumeral('十')).toBe(10);
    expect(parseNumeral('一万二千三百四十五')).toBe(12345);
    expect(parseNumeral('四千二百')).toBe(4200);
    expect(parseNumeral('九千九百九十九万九千九百九十九')).toBe(99_999_999);
  });

  it('reads a lone 〇 or 零 as zero', () => {
    expect(parseNumeral('〇')).toBe(0);
    expect(parseNumeral('零')).toBe(0);
  });

  it('refuses a malformed Japanese numeral rather than guessing a value', () => {
    for (const malformed of ['十百', '百百', '二三十', '二万三万', '万', '〇一', '二〇二六']) {
      expect(parseNumeral(malformed)).toBeNull();
    }
  });

  it('refuses a mixed grammar', () => {
    // Readable to a person, but accepting it would mean the evaluator picked a
    // grammar nobody approved.
    for (const mixed of ['2千7百', '２千7百', '二千700', '27００', '2七00']) {
      expect(parseNumeral(mixed)).toBeNull();
    }
  });
});

describe('required equivalences', () => {
  const EQUIVALENT: Array<[string, string]> = [
    ['2700mm', '二千七百ミリ'],
    ['320㎡', '三百二十平米'],
    ['590㎥/h', '五百九十立方メートル毎時'],
    ['3m/s', '三メートル毎秒'],
    ['午前10時', '午前十時'],
  ];

  for (const [a, b] of EQUIVALENT) {
    it(`${a} reads as the same fact as ${b}`, () => {
      expect(keys(a)).toHaveLength(1);
      expect(keys(b)).toHaveLength(1);
      expect(keys(a)).toEqual(keys(b));
    });

    it(`${a} against ${b} preserves everything`, () => {
      const analysis = analyzeCriticalInfo(a, b);
      expect(analysis.metrics).toMatchObject({
        reference_entities: 1,
        hypothesis_entities: 1,
        matched: 1,
        missing: 0,
        extra: 0,
        preservation_rate: 1,
        exact_entity_multiset_match: true,
      });
      expect(analysis.matches[0]!.reference.raw).toBe(a);
      expect(analysis.matches[0]!.hypothesis.raw).toBe(b);
    });
  }
});

describe('required mismatches', () => {
  const DIFFERENT: Array<[string, string, string]> = [
    ['2700mm', '2600mm', 'a different value'],
    ['320㎡', '320mm', 'a different unit'],
    ['午前10時', '午後10時', 'a different meridiem'],
    ['590㎥/h', '590m/s', 'a different compound unit'],
  ];

  for (const [a, b, why] of DIFFERENT) {
    it(`${a} is not ${b} — ${why}`, () => {
      expect(keys(a)).not.toEqual(keys(b));
    });

    it(`${a} against ${b} is one missing and one extra`, () => {
      const analysis = analyzeCriticalInfo(a, b);
      expect(analysis.metrics).toMatchObject({
        matched: 0,
        missing: 1,
        extra: 1,
        preservation_rate: 0,
        exact_entity_multiset_match: false,
      });
      expect(analysis.missing[0]!.raw).toBe(a);
      expect(analysis.extra[0]!.raw).toBe(b);
    });
  }
});

describe('scope is measurements and clock hours only', () => {
  it('does not treat a bare number as a critical fact', () => {
    expect(keys('320')).toEqual([]);
    expect(keys('三百二十')).toEqual([]);
    expect(keys('会議室は 12 室あります。')).toEqual([]);
  });

  it('does not treat a number with an unapproved unit as a critical fact', () => {
    expect(keys('天井高は2700センチです。')).toEqual([]);
  });

  it('does not convert between units', () => {
    // 1m and 1000mm would be the same length. Deciding they are interchangeable
    // is not this evaluator's call — and `m` is not even a recognized unit here.
    expect(keys('1000mm')).toEqual(['measurement:1000:millimetre']);
    expect(keys('1m')).toEqual([]);
  });

  it('prefers the longest alias', () => {
    expect(keys('3メートル毎秒')).toEqual(['measurement:3:metre-per-second']);
    expect(keys('2700ミリメートル')).toEqual(['measurement:2700:millimetre']);
    expect(keys('320平方メートル')).toEqual(['measurement:320:square-metre']);
    expect(keys('590立方メートル毎時')).toEqual(['measurement:590:cubic-metre-per-hour']);
  });
});

describe('clock hours', () => {
  it('keeps the meridiem out of the hour', () => {
    expect(keys('午前10時')).toEqual(['clock-time:am:10']);
    expect(keys('午後10時')).toEqual(['clock-time:pm:10']);
    expect(keys('10時')).toEqual(['clock-time:none:10']);
  });

  it('treats a dropped meridiem as a different fact', () => {
    const analysis = analyzeCriticalInfo('午後10時', '10時');
    expect(analysis.metrics).toMatchObject({ matched: 0, missing: 1, extra: 1 });
  });

  it('ignores 午前 with no hour after it', () => {
    expect(keys('午前中に確認します')).toEqual([]);
  });

  it('does not read a duration as a clock hour', () => {
    expect(keys('3時間かかります')).toEqual([]);
  });

  it('refuses a clock reading with minutes rather than dropping them', () => {
    // Reporting 10時30分 as 10:00 would lose the 30 without saying so.
    const extraction = extractCritical('午前10時30分');
    expect(extraction.entities).toEqual([]);
    expect(extraction.unsupported).toHaveLength(1);
    expect(extraction.unsupported[0]!.raw).toBe('午前10時30分');
  });
});

describe('unsupported numeric syntax attached to a supported unit', () => {
  const UNSUPPORTED = ['2.7mm', '-3m/s', '1/2㎡', '1e3mm', '1,200mm', '2千7百ミリ', '十百ミリ'];

  for (const text of UNSUPPORTED) {
    it(`refuses ${text} whole rather than splitting it`, () => {
      const extraction = extractCritical(text);
      expect(extraction.entities).toEqual([]);
      expect(extraction.unsupported).toHaveLength(1);
      expect(extraction.unsupported[0]!.raw).toBe(text);
    });
  }

  it('never leaves a fragment behind as its own measurement', () => {
    // The failure this guards: reading only the `2` of `2.7mm` and then picking
    // up `7mm` as a measurement that appears nowhere in the text.
    expect(keys('2.7mm')).toEqual([]);
    expect(keys('天井高は2.7mmです')).toEqual([]);
  });

  it('stops the whole evaluation when the reference is the one that is unreadable', () => {
    const error = (() => {
      try {
        analyzeCriticalInfo('天井高は2.7mmです', '天井高は2700mmです');
        return null;
      } catch (caught) {
        return caught;
      }
    })();

    expect(error).toBeInstanceOf(CriticalInfoError);
    expect((error as CriticalInfoError).kind).toBe(
      'CRITICAL_INFO_UNSUPPORTED_REFERENCE_NUMERIC_SYNTAX',
    );
  });

  it('skips unreadable hypothesis text without inventing a partial entity', () => {
    const analysis = analyzeCriticalInfo('天井高は2700mmです', '天井高は2.7mmです');
    expect(analysis.metrics).toMatchObject({
      reference_entities: 1,
      hypothesis_entities: 0,
      matched: 0,
      missing: 1,
      extra: 0,
      preservation_rate: 0,
    });
  });

  it('leaves an unsupported number alone when no unit follows it', () => {
    // Not fact-shaped, so nothing to fail closed about.
    const extraction = extractCritical('進捗は2.7でした');
    expect(extraction.entities).toEqual([]);
    expect(extraction.unsupported).toEqual([]);
  });
});

describe('code point spans', () => {
  function assertSpans(text: string): void {
    const chars = Array.from(text);
    for (const entity of extractCriticalEntities(text)) {
      expect(chars.slice(entity.start_code_point, entity.end_code_point).join('')).toBe(entity.raw);
      expect(entity.end_code_point).toBeGreaterThan(entity.start_code_point);
    }
  }

  it('points back into the text after an ASCII prefix', () => {
    const text = 'ceiling height is 2700mm here';
    assertSpans(text);
    const entity = extractCriticalEntities(text)[0]!;
    expect(entity.start_code_point).toBe(18);
    expect(entity.end_code_point).toBe(24);
    expect(entity.raw).toBe('2700mm');
  });

  it('points back into the text after a Japanese prefix', () => {
    const text = '天井高は2700mmです';
    assertSpans(text);
    const entity = extractCriticalEntities(text)[0]!;
    expect(entity.start_code_point).toBe(4);
    expect(entity.raw).toBe('2700mm');
  });

  it('counts an astral character once, not twice', () => {
    // A UTF-16 offset would be one too high from here on.
    const text = '😀天井高は2700mmです';
    assertSpans(text);
    const entity = extractCriticalEntities(text)[0]!;
    expect(entity.start_code_point).toBe(5);
    expect(entity.end_code_point).toBe(11);
    expect(text.indexOf('2700mm')).toBe(6);
  });

  it('covers a full-width space inside the raw span', () => {
    const text = '天井高は2700　mmです';
    assertSpans(text);
    const entity = extractCriticalEntities(text)[0]!;
    expect(entity.raw).toBe('2700　mm');
    expect(entity.end_code_point - entity.start_code_point).toBe(7);
  });

  it('holds the invariant across a whole sentence of entities', () => {
    assertSpans(
      '😀 天井高は 2700mm を確保。面積は 320㎡、風量は 590㎥/h、風速は 3m/s、定例は 午前10時 から。',
    );
  });
});

describe('extraction over real sentences', () => {
  const NUMBERS_UNITS =
    '天井高は 2700mm を確保してください。基準階の専有面積は 320㎡ です。外気処理空調機の風量は 590㎥/h で計画しています。エントランス前の設計風速は 3m/s を想定します。次回の定例は 午前10時 から開始します。';

  it('finds every entity in the numbers-units case, in order', () => {
    expect(keys(NUMBERS_UNITS)).toEqual([
      'measurement:2700:millimetre',
      'measurement:320:square-metre',
      'measurement:590:cubic-metre-per-hour',
      'measurement:3:metre-per-second',
      'clock-time:am:10',
    ]);
    expect(raws(NUMBERS_UNITS)).toEqual(['2700mm', '320㎡', '590㎥/h', '3m/s', '午前10時']);
  });

  it('reads a fully spelled-out transcript as the same facts', () => {
    const spelled =
      '天井高は二千七百ミリを確保してください。基準階の専有面積は三百二十平米です。外気処理空調機の風量は五百九十立方メートル毎時で計画しています。エントランス前の設計風速は三メートル毎秒を想定します。次回の定例は午前十時から開始します。';
    expect(analyzeCriticalInfo(NUMBERS_UNITS, spelled).metrics).toMatchObject({
      reference_entities: 5,
      matched: 5,
      missing: 0,
      extra: 0,
      preservation_rate: 1,
      exact_entity_multiset_match: true,
    });
  });

  it('reports the one fact a transcript got wrong', () => {
    const wrong = NUMBERS_UNITS.replace('2700mm', '2600mm');
    const analysis = analyzeCriticalInfo(NUMBERS_UNITS, wrong);
    expect(analysis.metrics).toMatchObject({
      reference_entities: 5,
      matched: 4,
      missing: 1,
      extra: 1,
      preservation_rate: 4 / 5,
    });
    expect(analysis.missing[0]!.raw).toBe('2700mm');
    expect(analysis.extra[0]!.raw).toBe('2600mm');
  });

  it('finds the single entity in the architecture-short case', () => {
    const source =
      '基準階の会議室は north side に寄せて、コア側に water closet をまとめる方針で進めます。天井高は二千七百ミリを確保してください。';
    expect(keys(source)).toEqual(['measurement:2700:millimetre']);

    const windows =
      '基準階の会議室はノースサイドに寄せて、コア側にウォータークローゼットをまとめる方針で進めます。天井高は2700ミリを確保してください。';
    expect(analyzeCriticalInfo(source, windows).metrics).toMatchObject({
      matched: 1,
      missing: 0,
      extra: 0,
      preservation_rate: 1,
    });
  });
});

describe('canonical-multiset-v1', () => {
  it('matches repeated facts one-to-one', () => {
    const analysis = analyzeCriticalInfo('320㎡ と 320㎡', '320㎡');
    expect(analysis.metrics).toMatchObject({
      reference_entities: 2,
      hypothesis_entities: 1,
      matched: 1,
      missing: 1,
      extra: 0,
      preservation_rate: 1 / 2,
    });
  });

  it('counts an unasked-for repetition as extra', () => {
    const analysis = analyzeCriticalInfo('320㎡', '320㎡ と 320㎡');
    expect(analysis.metrics).toMatchObject({
      matched: 1,
      missing: 0,
      extra: 1,
      preservation_rate: 1,
      exact_entity_multiset_match: false,
    });
  });

  it('does not care what order the facts appear in', () => {
    expect(analyzeCriticalInfo('2700mm と 320㎡', '320㎡ と 2700mm').metrics).toMatchObject({
      matched: 2,
      missing: 0,
      extra: 0,
    });
  });

  it('is deterministic across repeated runs', () => {
    const first = analyzeCriticalInfo('2700mm 320㎡ 2700mm', '2700mm 2700mm 320mm');
    const second = analyzeCriticalInfo('2700mm 320㎡ 2700mm', '2700mm 2700mm 320mm');
    expect(second).toEqual(first);
  });

  it('pairs the earliest unconsumed counterpart', () => {
    const analysis = analyzeCriticalInfo('2700mm 2700mm', '2700mm 二千七百ミリ');
    expect(analysis.matches.map((match) => match.hypothesis.raw)).toEqual([
      '2700mm',
      '二千七百ミリ',
    ]);
  });
});

describe('an empty reference fails closed', () => {
  it('refuses to report a rate when there is nothing to preserve', () => {
    const error = (() => {
      try {
        analyzeCriticalInfo('会議室は north side に寄せてください。', '2700mm');
        return null;
      } catch (caught) {
        return caught;
      }
    })();

    expect(error).toBeInstanceOf(CriticalInfoError);
    expect((error as CriticalInfoError).kind).toBe('CRITICAL_INFO_NO_REFERENCE_ENTITY');
  });

  it('refuses when the reference has only bare numbers', () => {
    expect(() => analyzeCriticalInfo('会議室は 12 室です。', '会議室は 12 室です。')).toThrow(
      CriticalInfoError,
    );
  });
});
