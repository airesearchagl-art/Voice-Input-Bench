/**
 * critical-info-v1 — did the facts survive?
 *
 * raw-char-v1 says how far a transcript drifted, character by character. It
 * cannot say whether the drift mattered. Writing 「2700mm」 where the source
 * said 「二千七百ミリ」 is a large character distance and **no loss at all**;
 * writing 「2600mm」 is a small distance and a wrong building.
 *
 * So this evaluator ignores spelling and looks only at the facts a
 * specification cannot afford to lose. In v1 that is exactly two things:
 *
 *   - a **measurement**: an integer with one of four approved units
 *   - a **clock-hour**: an hour, optionally with 午前 / 午後
 *
 * Nothing else. A bare number with no unit is not a critical fact — it is a
 * number, and reporting it as preserved or lost would say nothing about the
 * specification. Anything the tables below do not name is not recognized.
 *
 * The narrowness is the design. Every widening — another unit, decimals, a
 * minute field — changes what a preservation rate means, so each one has to be
 * a deliberate, versioned edit rather than something the extractor infers.
 */

export const CRITICAL_INFO_ALGORITHM = 'critical-info-v1' as const;
export type CriticalInfoAlgorithm = typeof CRITICAL_INFO_ALGORITHM;

/** What v1 looks for. Numbers with units, and clock hours — nothing else. */
export const CRITICAL_INFO_SCOPE = 'numeric-unit-time' as const;
export type CriticalInfoScope = typeof CRITICAL_INFO_SCOPE;

/** Which numeral forms are readable. See {@link parseNumeral}. */
export const CRITICAL_INFO_NUMBER_GRAMMAR = 'number-grammar-v1' as const;
export type CriticalInfoNumberGrammar = typeof CRITICAL_INFO_NUMBER_GRAMMAR;

/** Which unit spellings are recognized. See {@link UNIT_ALIASES}. */
export const CRITICAL_INFO_UNIT_ALIASES = 'unit-alias-v1' as const;
export type CriticalInfoUnitAliases = typeof CRITICAL_INFO_UNIT_ALIASES;

/** How the two entity lists are compared. See {@link analyzeCriticalInfo}. */
export const CRITICAL_INFO_MATCHING = 'canonical-multiset-v1' as const;
export type CriticalInfoMatching = typeof CRITICAL_INFO_MATCHING;

/**
 * What may sit between a number and its unit: an ASCII space or a full-width
 * space, any number of them, never a line break.
 */
export const CRITICAL_INFO_SEPARATOR_POLICY = 'space-fullwidth-space-v1' as const;
export type CriticalInfoSeparatorPolicy = typeof CRITICAL_INFO_SEPARATOR_POLICY;

export type CriticalInfoErrorKind =
  /** The reference contains no entity, so a preservation rate has no meaning. */
  | 'CRITICAL_INFO_NO_REFERENCE_ENTITY'
  /**
   * The reference writes a number this grammar cannot read, attached to a unit
   * or clock this evaluator does recognize.
   *
   * `2.7mm` is the shape of a fact, written in a syntax v1 does not support.
   * Reading it as a bare `2` plus a `7mm` measurement would invent a fact
   * nobody wrote, and silently dropping it would understate what the reference
   * asked the transcript to preserve. Neither is acceptable, so no artifact is
   * produced at all.
   */
  | 'CRITICAL_INFO_UNSUPPORTED_REFERENCE_NUMERIC_SYNTAX';

export class CriticalInfoError extends Error {
  readonly kind: CriticalInfoErrorKind;
  readonly detail?: string;

  constructor(kind: CriticalInfoErrorKind, message: string, detail?: string) {
    super(message);
    this.name = 'CriticalInfoError';
    this.kind = kind;
    this.detail = detail;
  }
}

// ---------------------------------------------------------------------------
// number-grammar-v1
// ---------------------------------------------------------------------------

const ASCII_DIGITS = '0123456789';
const FULLWIDTH_DIGITS = '０１２３４５６７８９';

/** 〇 and 零 both read as zero; the rest are the ordinary numerals. */
const JAPANESE_DIGITS: Readonly<Record<string, number>> = {
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
};

/** Multipliers inside one myriad section. Must appear strictly decreasing. */
const JAPANESE_SMALL_MULTIPLIERS: Readonly<Record<string, number>> = {
  十: 10,
  百: 100,
  千: 1000,
};

/** 万 closes a section and scales it. At most one per numeral. */
const JAPANESE_LARGE_MULTIPLIER = '万';

/** The largest integer v1 reads: 99,999,999. */
export const MAX_SUPPORTED_INTEGER = 99_999_999;

export function isNumeralChar(char: string): boolean {
  return (
    ASCII_DIGITS.includes(char) ||
    FULLWIDTH_DIGITS.includes(char) ||
    JAPANESE_DIGITS[char] !== undefined ||
    JAPANESE_SMALL_MULTIPLIERS[char] !== undefined ||
    char === JAPANESE_LARGE_MULTIPLIER
  );
}

function parseDigitRun(run: string, digits: string): number | null {
  let value = 0;
  for (const char of run) {
    const digit = digits.indexOf(char);
    if (digit < 0) return null;
    value = value * 10 + digit;
    if (value > MAX_SUPPORTED_INTEGER) return null;
  }
  return value;
}

/**
 * Read a positional Japanese integer: 二千七百 = 2700, 一万二千三百四十五 = 12345.
 *
 * Strict on purpose. One digit per multiplier, multipliers strictly decreasing
 * within a section, at most one 万. 十百, 百百, 二三十 and 二万三万 are all
 * refused rather than resolved to whatever the arithmetic happens to produce —
 * a number nobody wrote is worse than no number.
 */
function parseJapaneseNumeral(chars: string[]): number | null {
  // 〇 and 零 stand alone. They cannot take a multiplier, and a longer digit
  // string like 二〇二六 is a different reading system that v1 does not accept.
  if (chars.length === 1 && JAPANESE_DIGITS[chars[0]!] === 0) return 0;

  let total = 0;
  let section = 0;
  let pending: number | null = null;
  let lastSmall = Number.POSITIVE_INFINITY;
  let seenLarge = false;

  for (const char of chars) {
    const digit = JAPANESE_DIGITS[char];
    if (digit !== undefined) {
      // Two digits in a row is 二三十, not a positional numeral.
      if (pending !== null) return null;
      if (digit === 0) return null;
      pending = digit;
      continue;
    }

    const small = JAPANESE_SMALL_MULTIPLIERS[char];
    if (small !== undefined) {
      if (small >= lastSmall) return null;
      lastSmall = small;
      section += (pending ?? 1) * small;
      pending = null;
      continue;
    }

    if (char === JAPANESE_LARGE_MULTIPLIER) {
      if (seenLarge) return null;
      seenLarge = true;
      section += pending ?? 0;
      if (section === 0 || section >= 10000) return null;
      total = section * 10000;
      section = 0;
      pending = null;
      lastSmall = Number.POSITIVE_INFINITY;
      continue;
    }

    return null;
  }

  total += section + (pending ?? 0);
  if (total > MAX_SUPPORTED_INTEGER) return null;
  return total;
}

/**
 * Read one numeral under number-grammar-v1.
 *
 * Three grammars, and a numeral must be written entirely in one of them:
 *
 *   A. ASCII integer      — `2700`
 *   B. full-width integer — `２７００`
 *   C. Japanese integer   — `二千七百`
 *
 * Mixed forms such as `2千7百` are refused. They are readable to a person, but
 * accepting them would mean this evaluator decided on a grammar nobody
 * approved, and the whole point of a versioned grammar is that it does not
 * drift on its own.
 *
 * Returns `null` for anything outside the three grammars, including values
 * above {@link MAX_SUPPORTED_INTEGER}.
 */
export function parseNumeral(text: string): number | null {
  const chars = Array.from(text);
  if (chars.length === 0) return null;

  const allAscii = chars.every((char) => ASCII_DIGITS.includes(char));
  if (allAscii) return parseDigitRun(text, ASCII_DIGITS);

  const allFullwidth = chars.every((char) => FULLWIDTH_DIGITS.includes(char));
  if (allFullwidth) return parseDigitRun(text, FULLWIDTH_DIGITS);

  const allJapanese = chars.every(
    (char) =>
      JAPANESE_DIGITS[char] !== undefined ||
      JAPANESE_SMALL_MULTIPLIERS[char] !== undefined ||
      char === JAPANESE_LARGE_MULTIPLIER,
  );
  if (allJapanese) return parseJapaneseNumeral(chars);

  return null;
}

// ---------------------------------------------------------------------------
// unit-alias-v1
// ---------------------------------------------------------------------------

/**
 * Every unit critical-info-v1 recognizes, and every spelling it accepts.
 *
 * The table is the whole contract. `2700mm` and `二千七百ミリ` are the same
 * quantity because `mm` and `ミリ` are listed together here, not because
 * anything inferred it. A spelling that is not in this table is not a unit, and
 * the number in front of it is therefore not a measurement.
 *
 * No conversion happens: this table maps spellings to one unit, never one unit
 * to another. Deciding that a transcript which changed the unit still preserved
 * the fact is not a call this evaluator is entitled to make.
 */
export const UNIT_ALIASES = {
  millimetre: ['mm', 'ミリ', 'ミリメートル'],
  'square-metre': ['㎡', 'm²', 'm2', '平米', '平方メートル'],
  'cubic-metre-per-hour': ['㎥/h', 'm³/h', 'm3/h', '立方メートル毎時', '立方メートル/時'],
  'metre-per-second': ['m/s', 'メートル毎秒'],
} as const satisfies Record<string, readonly string[]>;

export type CriticalUnit = keyof typeof UNIT_ALIASES;

/** Aliases longest-first, so `ミリメートル` wins over `ミリ` and `m3/h` over `m2`. */
const UNIT_LOOKUP: ReadonlyArray<{ alias: string[]; unit: CriticalUnit }> = Object.entries(
  UNIT_ALIASES,
)
  .flatMap(([unit, aliases]) =>
    (aliases as readonly string[]).map((alias) => ({
      alias: Array.from(alias),
      unit: unit as CriticalUnit,
    })),
  )
  .sort((a, b) => b.alias.length - a.alias.length || a.alias.join('').localeCompare(b.alias.join('')));

// ---------------------------------------------------------------------------
// space-fullwidth-space-v1
// ---------------------------------------------------------------------------

/** Separators allowed between a number and its unit. Never a line break. */
export const SEPARATOR_CHARS = [' ', '　'] as const;
const SEPARATORS = new Set<string>(SEPARATOR_CHARS);

// ---------------------------------------------------------------------------
// Entities
// ---------------------------------------------------------------------------

export type CriticalEntityKind = 'measurement' | 'clock-time';

/**
 * One extracted fact, addressable back into the text it came from.
 *
 * The span is in **Unicode code points**, not UTF-16 units, and the end is
 * exclusive. That makes the record auditable:
 *
 *     Array.from(text).slice(start_code_point, end_code_point).join('') === raw
 *
 * Anyone reading the artifact can put the claim back against the bytes and see
 * that it points where it says it does — including when an emoji sits earlier
 * in the line, which is exactly where a UTF-16 offset would quietly slip.
 */
export interface CriticalEntity {
  kind: CriticalEntityKind;
  /** The exact substring this was read from. */
  raw: string;
  start_code_point: number;
  /** Exclusive. */
  end_code_point: number;
  /** What equality is decided on. Two entities match iff these are equal. */
  canonical_key: string;
}

const MERIDIEM_PREFIXES: ReadonlyArray<{ token: string[]; meridiem: string }> = [
  { token: Array.from('午前'), meridiem: 'am' },
  { token: Array.from('午後'), meridiem: 'pm' },
];

/** `measurement:<value>:<unit>` — e.g. `measurement:2700:millimetre`. */
export function measurementKey(value: number, unit: CriticalUnit): string {
  return `measurement:${value}:${unit}`;
}

/**
 * `clock-time:<meridiem>:<hh>`.
 *
 * The meridiem is kept rather than folded into a 24-hour clock, so 「10時」 and
 * 「午後10時」 stay different: a transcript that dropped 午後 lost something.
 */
export function clockTimeKey(meridiem: string, hour: number): string {
  return `clock-time:${meridiem}:${hour.toString().padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------
// Scanning
// ---------------------------------------------------------------------------

const SIGNS = new Set(['-', '+', '−', '＋', '－']);
/** Characters that continue a numeric expression rather than ending it. */
const DECIMAL_POINTS = new Set(['.', '．']);
const GROUPING = new Set([',', '，']);
const FRACTION_SLASHES = new Set(['/', '／']);

function matchesAt(chars: string[], index: number, token: string[]): boolean {
  for (let i = 0; i < token.length; i += 1) {
    if (chars[index + i] !== token[i]) return false;
  }
  return true;
}

function skipSeparators(chars: string[], from: number): number {
  let index = from;
  while (index < chars.length && SEPARATORS.has(chars[index]!)) index += 1;
  return index;
}

/**
 * Read the whole numeric expression starting at `from`, whether or not v1 can
 * make sense of it.
 *
 * The point is to take it *whole*. `2.7` has to be consumed as one expression,
 * because reading only the `2` would leave `7mm` behind to be picked up as a
 * measurement that appears nowhere in the text.
 */
function readNumericExpression(
  chars: string[],
  from: number,
): { end: number; text: string; signed: boolean; wellFormed: boolean } | null {
  let index = from;
  let signed = false;

  if (SIGNS.has(chars[index] ?? '')) {
    if (!isNumeralChar(chars[index + 1] ?? '')) return null;
    signed = true;
    index += 1;
  }

  if (!isNumeralChar(chars[index] ?? '')) return null;

  const start = index;
  let wellFormed = true;

  while (index < chars.length) {
    const char = chars[index]!;
    if (isNumeralChar(char)) {
      index += 1;
      continue;
    }

    // A separator only continues the expression when a numeral follows it, so a
    // sentence-ending 。 or a trailing / is not swallowed.
    const next = chars[index + 1] ?? '';
    if (
      (DECIMAL_POINTS.has(char) || GROUPING.has(char) || FRACTION_SLASHES.has(char)) &&
      isNumeralChar(next)
    ) {
      wellFormed = false;
      index += 2;
      continue;
    }

    // Scientific notation: 1e3, 1e-3.
    if ((char === 'e' || char === 'E') && ASCII_DIGITS.includes(chars[index - 1] ?? '')) {
      if (isNumeralChar(next)) {
        wellFormed = false;
        index += 2;
        continue;
      }
      if (SIGNS.has(next) && isNumeralChar(chars[index + 2] ?? '')) {
        wellFormed = false;
        index += 3;
        continue;
      }
    }

    break;
  }

  return { end: index, text: chars.slice(start, index).join(''), signed, wellFormed };
}

type Candidate =
  | { outcome: 'entity'; entity: CriticalEntity; end: number }
  /** Shaped like a fact, written in a syntax v1 does not read. */
  | { outcome: 'unsupported'; raw: string; end: number; reason: string }
  /** Not a critical fact at all — a bare number, or a unit v1 does not know. */
  | { outcome: 'skip'; end: number }
  | null;

/**
 * Read one candidate fact starting at `index`.
 *
 * Returning `skip` and returning `unsupported` are different answers on
 * purpose. A bare `320` is simply not a critical fact and nobody needs to hear
 * about it; a `2.7mm` *is* a fact, written in a way v1 cannot read, and letting
 * that pass as "no entity here" would quietly shrink what the reference claimed.
 */
function readCandidate(chars: string[], index: number): Candidate {
  let cursor = index;
  let meridiem = 'none';

  for (const prefix of MERIDIEM_PREFIXES) {
    if (!matchesAt(chars, cursor, prefix.token)) continue;
    const afterPrefix = skipSeparators(chars, cursor + prefix.token.length);
    // 午前中 is not a clock reading. Only commit to the prefix when a number
    // actually follows it.
    if (!isNumeralChar(chars[afterPrefix] ?? '') && !SIGNS.has(chars[afterPrefix] ?? '')) {
      continue;
    }
    meridiem = prefix.meridiem;
    cursor = afterPrefix;
    break;
  }

  const numeric = readNumericExpression(chars, cursor);
  if (numeric === null) return null;

  const afterNumber = skipSeparators(chars, numeric.end);
  const value = numeric.signed || !numeric.wellFormed ? null : parseNumeral(numeric.text);

  // A clock hour: <number>時, not followed by 間 (which makes it a duration).
  if (chars[afterNumber] === '時' && chars[afterNumber + 1] !== '間') {
    const end = afterNumber + 1;

    // Minutes are not part of v1. 10時30分 is a clock reading this evaluator
    // cannot represent, and reporting it as 10:00 would drop the 30 without
    // saying so.
    const minuteStart = skipSeparators(chars, end);
    const minutes = readNumericExpression(chars, minuteStart);
    if (minutes !== null) {
      const afterMinutes = skipSeparators(chars, minutes.end);
      if (chars[afterMinutes] === '分' && chars[afterMinutes + 1] !== '間') {
        return {
          outcome: 'unsupported',
          raw: chars.slice(index, afterMinutes + 1).join(''),
          end: afterMinutes + 1,
          reason: 'minutes are not part of critical-info-v1',
        };
      }
    }

    if (value === null) {
      return {
        outcome: 'unsupported',
        raw: chars.slice(index, end).join(''),
        end,
        reason: 'unreadable hour',
      };
    }

    return {
      outcome: 'entity',
      entity: {
        kind: 'clock-time',
        raw: chars.slice(index, end).join(''),
        start_code_point: index,
        end_code_point: end,
        canonical_key: clockTimeKey(meridiem, value),
      },
      end,
    };
  }

  for (const entry of UNIT_LOOKUP) {
    if (!matchesAt(chars, afterNumber, entry.alias)) continue;
    const end = afterNumber + entry.alias.length;

    if (value === null) {
      return {
        outcome: 'unsupported',
        raw: chars.slice(index, end).join(''),
        end,
        reason: 'unreadable quantity',
      };
    }

    return {
      outcome: 'entity',
      entity: {
        kind: 'measurement',
        raw: chars.slice(index, end).join(''),
        start_code_point: index,
        end_code_point: end,
        canonical_key: measurementKey(value, entry.unit),
      },
      end,
    };
  }

  // No approved unit and no clock marker: not a critical fact. The whole
  // numeric expression is consumed so nothing inside it is re-read.
  return { outcome: 'skip', end: numeric.end };
}

export interface CriticalExtraction {
  entities: CriticalEntity[];
  /** Fact-shaped text v1 could not read. Surfaced, never turned into entities. */
  unsupported: Array<{ raw: string; start_code_point: number; reason: string }>;
}

/**
 * Every critical entity in a text, left to right, with whatever v1 could not
 * read reported alongside.
 *
 * One pass, no overlaps, and the same text always yields the same lists in the
 * same order.
 */
export function extractCritical(text: string): CriticalExtraction {
  const chars = Array.from(text);
  const entities: CriticalEntity[] = [];
  const unsupported: CriticalExtraction['unsupported'] = [];
  let index = 0;

  while (index < chars.length) {
    const char = chars[index]!;
    const couldStart =
      isNumeralChar(char) ||
      SIGNS.has(char) ||
      MERIDIEM_PREFIXES.some((prefix) => prefix.token[0] === char);

    if (!couldStart) {
      index += 1;
      continue;
    }

    const candidate = readCandidate(chars, index);
    if (candidate === null) {
      index += 1;
      continue;
    }

    if (candidate.outcome === 'entity') entities.push(candidate.entity);
    else if (candidate.outcome === 'unsupported') {
      unsupported.push({
        raw: candidate.raw,
        start_code_point: index,
        reason: candidate.reason,
      });
    }

    index = Math.max(candidate.end, index + 1);
  }

  return { entities, unsupported };
}

/** Just the entities, for callers that do not need the unsupported list. */
export function extractCriticalEntities(text: string): CriticalEntity[] {
  return extractCritical(text).entities;
}

// ---------------------------------------------------------------------------
// canonical-multiset-v1
// ---------------------------------------------------------------------------

export interface CriticalMatch {
  canonical_key: string;
  reference: CriticalEntity;
  hypothesis: CriticalEntity;
}

export interface CriticalInfoMetrics {
  reference_entities: number;
  hypothesis_entities: number;
  matched: number;
  /** Reference entities with no counterpart. Facts the transcript lost. */
  missing: number;
  /** Hypothesis entities with no counterpart. Facts nobody stated. */
  extra: number;
  /** `matched / reference_entities`. */
  preservation_rate: number;
  /** True only when nothing is missing and nothing is extra. */
  exact_entity_multiset_match: boolean;
}

export interface CriticalInfoAnalysis {
  referenceEntities: CriticalEntity[];
  hypothesisEntities: CriticalEntity[];
  matches: CriticalMatch[];
  missing: CriticalEntity[];
  extra: CriticalEntity[];
  metrics: CriticalInfoMetrics;
}

/**
 * Match the two entity lists one-to-one on canonical key.
 *
 * Equality is exact key equality, so a greedy pass in reading order — take the
 * earliest unconsumed hypothesis entity with the same key — already produces a
 * maximum matching, and produces the same one every time. There is no partial
 * credit: a fact either survived or it did not.
 *
 * The reference is held to a stricter standard than the hypothesis. Text the
 * grammar cannot read stops the whole evaluation when it is in the reference,
 * because the reference defines what was asked for; in the hypothesis it is
 * skipped whole, which shows up as the reference fact going missing.
 */
export function analyzeCriticalInfo(
  reference: string,
  hypothesis: string,
): CriticalInfoAnalysis {
  const referenceExtraction = extractCritical(reference);

  if (referenceExtraction.unsupported.length > 0) {
    const first = referenceExtraction.unsupported[0]!;
    throw new CriticalInfoError(
      'CRITICAL_INFO_UNSUPPORTED_REFERENCE_NUMERIC_SYNTAX',
      `reference の ${JSON.stringify(first.raw)} は critical-info-v1 が読めない数値表現です。`,
      `raw=${first.raw} start_code_point=${first.start_code_point} reason=${first.reason}`,
    );
  }

  const referenceEntities = referenceExtraction.entities;
  // Whatever the hypothesis could not be read as is left out entirely. It never
  // becomes a partial entity, so it can neither match nor count as extra.
  const hypothesisEntities = extractCritical(hypothesis).entities;

  if (referenceEntities.length === 0) {
    // There is nothing to preserve, so every rate would be an invention —
    // 100% least of all.
    throw new CriticalInfoError(
      'CRITICAL_INFO_NO_REFERENCE_ENTITY',
      'reference に critical entity が 1 件も無いため preservation rate を計算できません。',
      `hypothesis_entities=${hypothesisEntities.length}`,
    );
  }

  const availableByKey = new Map<string, number[]>();
  hypothesisEntities.forEach((entity, position) => {
    const bucket = availableByKey.get(entity.canonical_key);
    if (bucket) bucket.push(position);
    else availableByKey.set(entity.canonical_key, [position]);
  });

  const consumed = new Set<number>();
  const matches: CriticalMatch[] = [];
  const missing: CriticalEntity[] = [];

  for (const entity of referenceEntities) {
    const position = availableByKey.get(entity.canonical_key)?.shift();
    if (position === undefined) {
      missing.push(entity);
      continue;
    }
    consumed.add(position);
    matches.push({
      canonical_key: entity.canonical_key,
      reference: entity,
      hypothesis: hypothesisEntities[position]!,
    });
  }

  const extra = hypothesisEntities.filter((_, position) => !consumed.has(position));

  return {
    referenceEntities,
    hypothesisEntities,
    matches,
    missing,
    extra,
    metrics: {
      reference_entities: referenceEntities.length,
      hypothesis_entities: hypothesisEntities.length,
      matched: matches.length,
      missing: missing.length,
      extra: extra.length,
      preservation_rate: matches.length / referenceEntities.length,
      exact_entity_multiset_match: missing.length === 0 && extra.length === 0,
    },
  };
}
