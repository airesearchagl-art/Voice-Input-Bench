/**
 * critical-info-v1 — did the numbers survive?
 *
 * raw-char-v1 says how far a transcript drifted, character by character. It
 * cannot say whether the drift mattered. Writing 「2700mm」 where the source
 * said 「二千七百ミリ」 is a large character distance and **no loss at all**;
 * writing 「2600mm」 is a small distance and a wrong building.
 *
 * So this evaluator ignores spelling and looks only at the facts a
 * specification cannot afford to lose: quantities with their units, and clock
 * times. Entities are extracted from both texts, reduced to a canonical key,
 * and matched one-to-one as multisets.
 *
 * Deliberately narrow. Recognition is driven by a **fixed alias table**, not by
 * inference: no general NER, no arbitrary unit conversion, no decimals,
 * fractions or signed values, no semantic similarity. Anything the table does
 * not name is simply not an entity, which is a visible gap rather than a
 * guess — and a guess here would be a number nobody wrote.
 */

export const CRITICAL_INFO_ALGORITHM = 'critical-info-v1' as const;
export type CriticalInfoAlgorithm = typeof CRITICAL_INFO_ALGORITHM;

/** What this evaluator counts: extracted entities, not characters. */
export const CRITICAL_INFO_UNIT = 'critical-entity' as const;
export type CriticalInfoUnit = typeof CRITICAL_INFO_UNIT;

/**
 * How much it is allowed to change before comparing.
 *
 * Not "none": numerals and units are folded to a canonical form. What it is
 * *not* is open-ended — every fold comes from the table below, so the set of
 * things treated as equal is finite and readable.
 */
export const CRITICAL_INFO_NORMALIZATION = 'fixed-alias-table' as const;
export type CriticalInfoNormalization = typeof CRITICAL_INFO_NORMALIZATION;

export type CriticalInfoErrorKind =
  /** The reference contains no entity, so a preservation rate has no meaning. */
  'CRITICAL_INFO_NO_REFERENCE_ENTITY';

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
// Numerals
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

/** Multipliers inside one myriad section. Must appear in decreasing order. */
const JAPANESE_SMALL_MULTIPLIERS: Readonly<Record<string, number>> = {
  十: 10,
  百: 100,
  千: 1000,
};

/** 万 closes a section and scales it. Integers only; nothing above 万. */
const JAPANESE_LARGE_MULTIPLIER = '万';

function digitValue(char: string): number | null {
  const ascii = ASCII_DIGITS.indexOf(char);
  if (ascii >= 0) return ascii;
  const fullwidth = FULLWIDTH_DIGITS.indexOf(char);
  if (fullwidth >= 0) return fullwidth;
  const japanese = JAPANESE_DIGITS[char];
  return japanese === undefined ? null : japanese;
}

function isNumeralChar(char: string): boolean {
  return (
    digitValue(char) !== null ||
    JAPANESE_SMALL_MULTIPLIERS[char] !== undefined ||
    char === JAPANESE_LARGE_MULTIPLIER
  );
}

/**
 * Read one run of numeral characters as a non-negative integer.
 *
 * Two readings share the same character set and are told apart by what is
 * present: a run containing 十/百/千/万 is positional (二千七百 = 2700), and a
 * run without them is a digit string (二〇二六 = 2026, 2700 = 2700).
 *
 * Returns `null` for a run that is not a well-formed integer — 十百 or 二三十,
 * for instance. An unreadable run is left out rather than resolved to a number
 * nobody wrote; if it was in the reference it then shows up as missing, which
 * is the honest outcome.
 */
export function parseNumeralRun(run: string): number | null {
  const chars = Array.from(run);
  if (chars.length === 0) return null;

  const hasMultiplier = chars.some(
    (char) =>
      JAPANESE_SMALL_MULTIPLIERS[char] !== undefined || char === JAPANESE_LARGE_MULTIPLIER,
  );

  if (!hasMultiplier) {
    let value = 0;
    for (const char of chars) {
      const digit = digitValue(char);
      if (digit === null) return null;
      value = value * 10 + digit;
      if (!Number.isSafeInteger(value)) return null;
    }
    return value;
  }

  let total = 0;
  let section = 0;
  let pending: number | null = null;
  let lastSmall = Number.POSITIVE_INFINITY;

  for (const char of chars) {
    const digit = digitValue(char);
    if (digit !== null) {
      // Digits may accumulate before a multiplier (2千 and 二千 both work), but
      // a bare digit string cannot sit inside a positional numeral.
      pending = (pending ?? 0) * 10 + digit;
      continue;
    }

    const small = JAPANESE_SMALL_MULTIPLIERS[char];
    if (small !== undefined) {
      // 千 then 百 then 十, never the other way round.
      if (small >= lastSmall) return null;
      lastSmall = small;
      section += (pending ?? 1) * small;
      pending = null;
      continue;
    }

    if (char === JAPANESE_LARGE_MULTIPLIER) {
      section += pending ?? 0;
      if (section === 0) return null;
      total += section * 10000;
      section = 0;
      pending = null;
      lastSmall = Number.POSITIVE_INFINITY;
      continue;
    }

    return null;
  }

  total += section + (pending ?? 0);
  return Number.isSafeInteger(total) ? total : null;
}

// ---------------------------------------------------------------------------
// Units
// ---------------------------------------------------------------------------

/**
 * Every unit this evaluator recognizes, and every spelling it accepts for it.
 *
 * The table is the whole contract. `2700mm` and `二千七百ミリ` are the same
 * quantity because `mm` and `ミリ` are listed together here, not because
 * anything inferred it. Adding a unit is a deliberate edit to this table.
 *
 * No conversion happens: `1m` and `1000mm` are different entities. Converting
 * would mean deciding that a transcript which changed the unit still preserved
 * the fact, which is not a call this evaluator is entitled to make.
 */
export const UNIT_ALIASES: Readonly<Record<string, readonly string[]>> = {
  mm: ['mm', 'ｍｍ', '㎜', 'ミリメートル', 'ミリ'],
  cm: ['cm', 'ｃｍ', '㎝', 'センチメートル', 'センチ'],
  m: ['m', 'ｍ', 'メートル'],
  km: ['km', 'ｋｍ', '㎞', 'キロメートル'],
  m2: ['m2', 'm²', '㎡', '平方メートル', '平米'],
  m3: ['m3', 'm³', '㎥', '立方メートル', '立米'],
  'm/s': ['m/s', 'メートル毎秒', 'メートル／秒', 'メートル/秒'],
  'm3/h': ['m3/h', 'm³/h', '㎥/h', '㎥／h', '㎥/時', '立方メートル毎時', '立米毎時'],
  kg: ['kg', '㎏', 'キログラム'],
  g: ['g', 'グラム'],
  '%': ['%', '％', 'パーセント'],
  h: ['h', '時間'],
  min: ['min', '分間', '分'],
  floor: ['階', 'F', 'Ｆ'],
  person: ['人'],
  yen: ['円'],
};

/** Aliases longest-first, so `m/s` wins over `m` and `ミリメートル` over `ミリ`. */
const UNIT_LOOKUP: ReadonlyArray<{ alias: string; canonical: string; length: number }> = Object
  .entries(UNIT_ALIASES)
  .flatMap(([canonical, aliases]) =>
    aliases.map((alias) => ({ alias, canonical, length: Array.from(alias).length })),
  )
  .sort((a, b) => b.length - a.length || a.alias.localeCompare(b.alias));

/** Spaces allowed between a number and its unit. Never a line break. */
const INLINE_SPACES = new Set([' ', '　']);

// ---------------------------------------------------------------------------
// Entities
// ---------------------------------------------------------------------------

export type CriticalEntityKind = 'number' | 'time';

export interface CriticalEntity {
  kind: CriticalEntityKind;
  /** The exact substring this was read from, for showing the operator. */
  surface: string;
  /** What equality is decided on. Two entities match iff these are equal. */
  key: string;
  /** Code point offset into the text. */
  offset: number;
}

const MERIDIEM_PREFIXES: ReadonlyArray<{ token: string; meridiem: string }> = [
  { token: '午前', meridiem: 'am' },
  { token: '午後', meridiem: 'pm' },
];

function pad2(value: number): string {
  return value.toString().padStart(2, '0');
}

/** `number:<value>:<unit>`, with `-` for a bare quantity. */
export function numberKey(value: number, unit: string | null): string {
  return `number:${value}:${unit ?? '-'}`;
}

/**
 * `time:<meridiem>:<hh>:<mm>`.
 *
 * The meridiem is kept rather than folded into a 24-hour clock, so 「10時」 and
 * 「午後10時」 stay different. A transcript that dropped 午後 lost something.
 */
export function timeKey(meridiem: string, hour: number, minute: number): string {
  return `time:${meridiem}:${pad2(hour)}:${pad2(minute)}`;
}

interface Scanner {
  chars: string[];
  index: number;
}

function matchLiteral(scanner: Scanner, literal: string): number | null {
  const literalChars = Array.from(literal);
  for (let i = 0; i < literalChars.length; i += 1) {
    if (scanner.chars[scanner.index + i] !== literalChars[i]) return null;
  }
  return scanner.index + literalChars.length;
}

function skipInlineSpaces(chars: string[], from: number): number {
  let index = from;
  while (index < chars.length && INLINE_SPACES.has(chars[index]!)) index += 1;
  return index;
}

/** Read a maximal numeral run starting at `from`, or `null` if none starts there. */
function readNumeralRun(
  chars: string[],
  from: number,
): { value: number; end: number } | null {
  let end = from;
  while (end < chars.length && isNumeralChar(chars[end]!)) end += 1;
  if (end === from) return null;
  const value = parseNumeralRun(chars.slice(from, end).join(''));
  return value === null ? null : { value, end };
}

/** Longest matching unit alias at `from`, after optional inline spaces. */
function readUnit(chars: string[], from: number): { canonical: string; end: number } | null {
  const start = skipInlineSpaces(chars, from);
  for (const entry of UNIT_LOOKUP) {
    const aliasChars = Array.from(entry.alias);
    let matches = true;
    for (let i = 0; i < aliasChars.length; i += 1) {
      if (chars[start + i] !== aliasChars[i]) {
        matches = false;
        break;
      }
    }
    if (matches) return { canonical: entry.canonical, end: start + aliasChars.length };
  }
  return null;
}

/**
 * Read a clock time at `from`: an optional 午前/午後, an hour before 時, and an
 * optional minute before 分.
 *
 * 「3時間」 is a duration, not a clock reading, so a 時 followed by 間 is left
 * for the unit table to pick up.
 */
function readTime(
  chars: string[],
  from: number,
): { meridiem: string; hour: number; minute: number; end: number } | null {
  const scanner: Scanner = { chars, index: from };
  let meridiem = 'none';
  let index = from;

  for (const prefix of MERIDIEM_PREFIXES) {
    const after = matchLiteral(scanner, prefix.token);
    if (after !== null) {
      meridiem = prefix.meridiem;
      index = skipInlineSpaces(chars, after);
      break;
    }
  }

  const hour = readNumeralRun(chars, index);
  if (hour === null) return null;

  let cursor = skipInlineSpaces(chars, hour.end);
  if (chars[cursor] !== '時' || chars[cursor + 1] === '間') return null;
  cursor += 1;

  let minute = 0;
  const minuteStart = skipInlineSpaces(chars, cursor);
  const minuteRun = readNumeralRun(chars, minuteStart);
  if (minuteRun !== null) {
    const afterMinute = skipInlineSpaces(chars, minuteRun.end);
    // Only 分 makes it a minute; 分間 is a duration and belongs to the number
    // that follows, not to this clock reading.
    if (chars[afterMinute] === '分' && chars[afterMinute + 1] !== '間') {
      minute = minuteRun.value;
      cursor = afterMinute + 1;
    }
  }

  return { meridiem, hour: hour.value, minute, end: cursor };
}

/**
 * Every critical entity in a text, left to right.
 *
 * A single pass: at each position, a clock reading is tried first (it can start
 * with 午前/午後, which no number can), then a quantity. Nothing overlaps, and
 * the same text always yields the same list in the same order.
 */
export function extractCriticalEntities(text: string): CriticalEntity[] {
  const chars = Array.from(text);
  const entities: CriticalEntity[] = [];
  let index = 0;

  while (index < chars.length) {
    const char = chars[index]!;
    const couldStartTime = MERIDIEM_PREFIXES.some((prefix) => prefix.token.startsWith(char));

    if (couldStartTime || isNumeralChar(char)) {
      const time = readTime(chars, index);
      if (time !== null) {
        entities.push({
          kind: 'time',
          surface: chars.slice(index, time.end).join(''),
          key: timeKey(time.meridiem, time.hour, time.minute),
          offset: index,
        });
        index = time.end;
        continue;
      }
    }

    if (isNumeralChar(char)) {
      const run = readNumeralRun(chars, index);
      if (run !== null) {
        const unit = readUnit(chars, run.end);
        const end = unit?.end ?? run.end;
        entities.push({
          kind: 'number',
          surface: chars.slice(index, end).join(''),
          key: numberKey(run.value, unit?.canonical ?? null),
          offset: index,
        });
        index = end;
        continue;
      }
      // An unreadable numeral run: step past it whole, so its characters are
      // not re-read as a different, smaller number.
      let end = index;
      while (end < chars.length && isNumeralChar(chars[end]!)) end += 1;
      index = end;
      continue;
    }

    index += 1;
  }

  return entities;
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

export interface CriticalMatch {
  key: string;
  referenceSurface: string;
  referenceOffset: number;
  hypothesisSurface: string;
  hypothesisOffset: number;
}

export interface CriticalInfoMetrics {
  reference_entities: number;
  hypothesis_entities: number;
  matched: number;
  /** Reference entities with no counterpart. Information the transcript lost. */
  missing: number;
  /** Hypothesis entities with no counterpart. Numbers nobody said. */
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
 * credit: an entity either survived or it did not.
 */
export function analyzeCriticalInfo(
  reference: string,
  hypothesis: string,
): CriticalInfoAnalysis {
  const referenceEntities = extractCriticalEntities(reference);
  const hypothesisEntities = extractCriticalEntities(hypothesis);

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
    const bucket = availableByKey.get(entity.key);
    if (bucket) bucket.push(position);
    else availableByKey.set(entity.key, [position]);
  });

  const consumed = new Set<number>();
  const matches: CriticalMatch[] = [];
  const missing: CriticalEntity[] = [];

  for (const entity of referenceEntities) {
    const bucket = availableByKey.get(entity.key);
    const position = bucket?.shift();
    if (position === undefined) {
      missing.push(entity);
      continue;
    }
    consumed.add(position);
    const counterpart = hypothesisEntities[position]!;
    matches.push({
      key: entity.key,
      referenceSurface: entity.surface,
      referenceOffset: entity.offset,
      hypothesisSurface: counterpart.surface,
      hypothesisOffset: counterpart.offset,
    });
  }

  const extra = hypothesisEntities.filter((_, position) => !consumed.has(position));

  const metrics: CriticalInfoMetrics = {
    reference_entities: referenceEntities.length,
    hypothesis_entities: hypothesisEntities.length,
    matched: matches.length,
    missing: missing.length,
    extra: extra.length,
    preservation_rate: matches.length / referenceEntities.length,
    exact_entity_multiset_match: missing.length === 0 && extra.length === 0,
  };

  return { referenceEntities, hypothesisEntities, matches, missing, extra, metrics };
}
