import { describe, expect, it } from 'vitest';
import {
  CriticalInfoError,
  analyzeCriticalInfo,
  extractCriticalEntities,
  parseNumeralRun,
} from './criticalInfo';

/**
 * critical-info-v1.
 *
 * The point of this evaluator is the pair of lists below: things that must read
 * as the same fact however they were spelled, and things that must never be
 * folded together no matter how similar they look.
 */

function keys(text: string): string[] {
  return extractCriticalEntities(text).map((entity) => entity.key);
}

function surfaces(text: string): string[] {
  return extractCriticalEntities(text).map((entity) => entity.surface);
}

describe('numeral reading', () => {
  it('reads ASCII and full-width digits as the same number', () => {
    expect(parseNumeralRun('2700')).toBe(2700);
    expect(parseNumeralRun('２７００')).toBe(2700);
    expect(parseNumeralRun('0')).toBe(0);
  });

  it('reads positional Japanese integers', () => {
    expect(parseNumeralRun('二千七百')).toBe(2700);
    expect(parseNumeralRun('三百二十')).toBe(320);
    expect(parseNumeralRun('五百九十')).toBe(590);
    expect(parseNumeralRun('四千二百')).toBe(4200);
    expect(parseNumeralRun('三百')).toBe(300);
    expect(parseNumeralRun('三')).toBe(3);
    expect(parseNumeralRun('十')).toBe(10);
    expect(parseNumeralRun('二万三千')).toBe(23000);
    expect(parseNumeralRun('一万')).toBe(10000);
  });

  it('reads a digit string of Japanese numerals', () => {
    expect(parseNumeralRun('二〇二六')).toBe(2026);
    expect(parseNumeralRun('〇')).toBe(0);
    expect(parseNumeralRun('零')).toBe(0);
  });

  it('accepts digits as the multiplier in a positional numeral', () => {
    expect(parseNumeralRun('2千7百')).toBe(2700);
  });

  it('refuses a malformed numeral rather than guessing a value', () => {
    // Multipliers must decrease within a section.
    expect(parseNumeralRun('十百')).toBeNull();
    expect(parseNumeralRun('百百')).toBeNull();
    expect(parseNumeralRun('万')).toBeNull();
    expect(parseNumeralRun('')).toBeNull();
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
      // The surfaces are kept as written, so the operator can see both.
      expect(analysis.matches[0]!.referenceSurface).toBe(a);
      expect(analysis.matches[0]!.hypothesisSurface).toBe(b);
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
      expect(analysis.missing[0]!.surface).toBe(a);
      expect(analysis.extra[0]!.surface).toBe(b);
    });
  }
});

describe('unit aliases are a fixed table, not a conversion', () => {
  it('accepts every spelling listed for a unit', () => {
    expect(keys('2700mm')).toEqual(keys('2700ミリ'));
    expect(keys('2700mm')).toEqual(keys('2700ミリメートル'));
    expect(keys('2700mm')).toEqual(keys('2700㎜'));
    expect(keys('320㎡')).toEqual(keys('320平方メートル'));
    expect(keys('320㎡')).toEqual(keys('320m2'));
    expect(keys('590㎥/h')).toEqual(keys('590立米毎時'));
  });

  it('does not convert between units', () => {
    // 1m and 1000mm are the same length and different entities. Deciding they
    // are interchangeable is not this evaluator's call to make.
    expect(keys('1m')).not.toEqual(keys('1000mm'));
    expect(keys('1km')).not.toEqual(keys('1000m'));
  });

  it('prefers the longest alias', () => {
    expect(keys('3メートル毎秒')).toEqual(['number:3:m/s']);
    expect(keys('3メートル')).toEqual(['number:3:m']);
    expect(keys('2700ミリメートル')).toEqual(['number:2700:mm']);
  });

  it('reads a bare quantity with no unit', () => {
    expect(keys('320')).toEqual(['number:320:-']);
  });

  it('allows a space between the number and its unit', () => {
    expect(keys('2700 mm')).toEqual(['number:2700:mm']);
    expect(keys('320　㎡')).toEqual(['number:320:m2']);
  });

  it('does not read a unit across a line break', () => {
    expect(keys('2700\nmm')).toEqual(['number:2700:-']);
  });
});

describe('clock times', () => {
  it('keeps the meridiem out of the hour', () => {
    expect(keys('午前10時')).toEqual(['time:am:10:00']);
    expect(keys('午後10時')).toEqual(['time:pm:10:00']);
    expect(keys('10時')).toEqual(['time:none:10:00']);
  });

  it('treats a dropped meridiem as a different fact', () => {
    // A transcript that lost 午後 lost something worth reporting.
    const analysis = analyzeCriticalInfo('午後10時', '10時');
    expect(analysis.metrics.matched).toBe(0);
    expect(analysis.metrics.missing).toBe(1);
    expect(analysis.metrics.extra).toBe(1);
  });

  it('reads minutes when they are there', () => {
    expect(keys('午前10時30分')).toEqual(['time:am:10:30']);
    expect(keys('10時05分')).toEqual(['time:none:10:05']);
    expect(keys('午前十時三十分')).toEqual(['time:am:10:30']);
  });

  it('matches a padded and an unpadded minute', () => {
    expect(keys('10時5分')).toEqual(keys('10時05分'));
  });

  it('reads a duration as a quantity, not a clock reading', () => {
    expect(keys('3時間')).toEqual(['number:3:h']);
    expect(keys('30分間')).toEqual(['number:30:min']);
  });

  it('ignores 午前 with no hour after it', () => {
    expect(keys('午前中に確認します')).toEqual([]);
  });
});

describe('extraction over real sentences', () => {
  const NUMBERS_UNITS =
    '天井高は 2700mm を確保してください。基準階の専有面積は 320㎡ です。外気処理空調機の風量は 590㎥/h で計画しています。エントランス前の設計風速は 3m/s を想定します。次回の定例は 午前10時 から開始します。';

  it('finds every entity in the numbers-units case, in order', () => {
    expect(keys(NUMBERS_UNITS)).toEqual([
      'number:2700:mm',
      'number:320:m2',
      'number:590:m3/h',
      'number:3:m/s',
      'time:am:10:00',
    ]);
    expect(surfaces(NUMBERS_UNITS)).toEqual(['2700mm', '320㎡', '590㎥/h', '3m/s', '午前10時']);
  });

  it('reads a fully spelled-out transcript as the same facts', () => {
    const spelled =
      '天井高は二千七百ミリを確保してください。基準階の専有面積は三百二十平米です。外気処理空調機の風量は五百九十立方メートル毎時で計画しています。エントランス前の設計風速は三メートル毎秒を想定します。次回の定例は午前十時から開始します。';
    const analysis = analyzeCriticalInfo(NUMBERS_UNITS, spelled);
    expect(analysis.metrics).toMatchObject({
      reference_entities: 5,
      hypothesis_entities: 5,
      matched: 5,
      missing: 0,
      extra: 0,
      preservation_rate: 1,
      exact_entity_multiset_match: true,
    });
  });

  it('reports the one fact a transcript got wrong', () => {
    const wrong =
      '天井高は 2600mm を確保してください。基準階の専有面積は 320㎡ です。外気処理空調機の風量は 590㎥/h で計画しています。エントランス前の設計風速は 3m/s を想定します。次回の定例は 午前10時 から開始します。';
    const analysis = analyzeCriticalInfo(NUMBERS_UNITS, wrong);
    expect(analysis.metrics).toMatchObject({
      reference_entities: 5,
      matched: 4,
      missing: 1,
      extra: 1,
      preservation_rate: 4 / 5,
      exact_entity_multiset_match: false,
    });
    expect(analysis.missing[0]!.surface).toBe('2700mm');
    expect(analysis.extra[0]!.surface).toBe('2600mm');
  });

  it('reports a dropped fact as missing with nothing extra', () => {
    const dropped = '天井高を確保してください。基準階の専有面積は 320㎡ です。';
    const analysis = analyzeCriticalInfo(NUMBERS_UNITS, dropped);
    expect(analysis.metrics).toMatchObject({
      reference_entities: 5,
      hypothesis_entities: 1,
      matched: 1,
      missing: 4,
      extra: 0,
      preservation_rate: 1 / 5,
    });
  });

  it('finds the single entity in the architecture-short case', () => {
    const source =
      '基準階の会議室は north side に寄せて、コア側に water closet をまとめる方針で進めます。天井高は二千七百ミリを確保してください。';
    expect(keys(source)).toEqual(['number:2700:mm']);

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

describe('multiset matching', () => {
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
    const analysis = analyzeCriticalInfo('2700mm と 320㎡', '320㎡ と 2700mm');
    expect(analysis.metrics).toMatchObject({ matched: 2, missing: 0, extra: 0 });
  });

  it('is deterministic across repeated runs', () => {
    const first = analyzeCriticalInfo('2700mm 320㎡ 2700mm', '2700mm 2700mm 320mm');
    const second = analyzeCriticalInfo('2700mm 320㎡ 2700mm', '2700mm 2700mm 320mm');
    expect(second).toEqual(first);
  });

  it('pairs the earliest unconsumed counterpart', () => {
    const analysis = analyzeCriticalInfo('2700mm 2700mm', '2700mm 二千七百ミリ');
    expect(analysis.matches.map((match) => match.hypothesisSurface)).toEqual([
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

  it('refuses even when the hypothesis is empty too', () => {
    expect(() => analyzeCriticalInfo('north side', '')).toThrow(CriticalInfoError);
  });
});
