/**
 * A runnable mirror of production critical-info-v1.
 *
 * The hybrid study needs to know, for each probe, whether the shipped critical
 * information evaluator would report a mismatch — that is the veto signal being
 * evaluated. The research scripts are plain `.mjs` and cannot import the
 * TypeScript evaluator, and approximating it would make the hybrid numbers
 * describe a method that does not exist.
 *
 * So this mirrors the v1 extractor and matcher, and
 * `criticalInfoMirror.test.mjs` asserts it agrees with the production functions
 * on every probe in the corpus. If production changes, that test fails rather
 * than this file quietly drifting.
 *
 * Scope, exactly as production: measurements with one of four approved units,
 * and clock hours. No bare numbers, no minutes, no unit conversion.
 */

const ASCII_DIGITS = '0123456789';
const FULLWIDTH_DIGITS = '０１２３４５６７８９';

const JAPANESE_DIGITS = {
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

const JAPANESE_SMALL_MULTIPLIERS = { 十: 10, 百: 100, 千: 1000 };
const JAPANESE_LARGE_MULTIPLIER = '万';
const MAX_SUPPORTED_INTEGER = 99_999_999;

export const UNIT_ALIASES = {
  millimetre: ['mm', 'ミリ', 'ミリメートル'],
  'square-metre': ['㎡', 'm²', 'm2', '平米', '平方メートル'],
  'cubic-metre-per-hour': ['㎥/h', 'm³/h', 'm3/h', '立方メートル毎時', '立方メートル/時'],
  'metre-per-second': ['m/s', 'メートル毎秒'],
};

const UNIT_LOOKUP = Object.entries(UNIT_ALIASES)
  .flatMap(([unit, aliases]) => aliases.map((alias) => ({ alias: Array.from(alias), unit })))
  .sort((a, b) => b.alias.length - a.alias.length || a.alias.join('').localeCompare(b.alias.join('')));

const SEPARATORS = new Set([' ', '　']);
const SIGNS = new Set(['-', '+', '−', '＋', '－']);
const DECIMAL_POINTS = new Set(['.', '．']);
const GROUPING = new Set([',', '，']);
const FRACTION_SLASHES = new Set(['/', '／']);

const MERIDIEM_PREFIXES = [
  { token: Array.from('午前'), meridiem: 'am' },
  { token: Array.from('午後'), meridiem: 'pm' },
];

function isNumeralChar(char) {
  return (
    ASCII_DIGITS.includes(char) ||
    FULLWIDTH_DIGITS.includes(char) ||
    JAPANESE_DIGITS[char] !== undefined ||
    JAPANESE_SMALL_MULTIPLIERS[char] !== undefined ||
    char === JAPANESE_LARGE_MULTIPLIER
  );
}

function parseDigitRun(run, digits) {
  let value = 0;
  for (const char of run) {
    const digit = digits.indexOf(char);
    if (digit < 0) return null;
    value = value * 10 + digit;
    if (value > MAX_SUPPORTED_INTEGER) return null;
  }
  return value;
}

function parseJapaneseNumeral(chars) {
  if (chars.length === 1 && JAPANESE_DIGITS[chars[0]] === 0) return 0;

  let total = 0;
  let section = 0;
  let pending = null;
  let lastSmall = Number.POSITIVE_INFINITY;
  let seenLarge = false;

  for (const char of chars) {
    const digit = JAPANESE_DIGITS[char];
    if (digit !== undefined) {
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
  return total > MAX_SUPPORTED_INTEGER ? null : total;
}

export function parseNumeral(text) {
  const chars = Array.from(text);
  if (chars.length === 0) return null;

  if (chars.every((char) => ASCII_DIGITS.includes(char))) return parseDigitRun(text, ASCII_DIGITS);
  if (chars.every((char) => FULLWIDTH_DIGITS.includes(char))) {
    return parseDigitRun(text, FULLWIDTH_DIGITS);
  }
  const allJapanese = chars.every(
    (char) =>
      JAPANESE_DIGITS[char] !== undefined ||
      JAPANESE_SMALL_MULTIPLIERS[char] !== undefined ||
      char === JAPANESE_LARGE_MULTIPLIER,
  );
  return allJapanese ? parseJapaneseNumeral(chars) : null;
}

function matchesAt(chars, index, token) {
  for (let i = 0; i < token.length; i += 1) {
    if (chars[index + i] !== token[i]) return false;
  }
  return true;
}

function skipSeparators(chars, from) {
  let index = from;
  while (index < chars.length && SEPARATORS.has(chars[index])) index += 1;
  return index;
}

function readNumericExpression(chars, from) {
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
    const char = chars[index];
    if (isNumeralChar(char)) {
      index += 1;
      continue;
    }
    const next = chars[index + 1] ?? '';
    if (
      (DECIMAL_POINTS.has(char) || GROUPING.has(char) || FRACTION_SLASHES.has(char)) &&
      isNumeralChar(next)
    ) {
      wellFormed = false;
      index += 2;
      continue;
    }
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

function readCandidate(chars, index) {
  let cursor = index;
  let meridiem = 'none';

  for (const prefix of MERIDIEM_PREFIXES) {
    if (!matchesAt(chars, cursor, prefix.token)) continue;
    const afterPrefix = skipSeparators(chars, cursor + prefix.token.length);
    if (!isNumeralChar(chars[afterPrefix] ?? '') && !SIGNS.has(chars[afterPrefix] ?? '')) continue;
    meridiem = prefix.meridiem;
    cursor = afterPrefix;
    break;
  }

  const numeric = readNumericExpression(chars, cursor);
  if (numeric === null) return null;

  const afterNumber = skipSeparators(chars, numeric.end);
  const value = numeric.signed || !numeric.wellFormed ? null : parseNumeral(numeric.text);

  if (chars[afterNumber] === '時' && chars[afterNumber + 1] !== '間') {
    const end = afterNumber + 1;
    const minuteStart = skipSeparators(chars, end);
    const minutes = readNumericExpression(chars, minuteStart);
    if (minutes !== null) {
      const afterMinutes = skipSeparators(chars, minutes.end);
      if (chars[afterMinutes] === '分' && chars[afterMinutes + 1] !== '間') {
        return { outcome: 'unsupported', end: afterMinutes + 1 };
      }
    }
    if (value === null) return { outcome: 'unsupported', end };
    return {
      outcome: 'entity',
      entity: {
        kind: 'clock-time',
        raw: chars.slice(index, end).join(''),
        canonical_key: `clock-time:${meridiem}:${String(value).padStart(2, '0')}`,
      },
      end,
    };
  }

  for (const entry of UNIT_LOOKUP) {
    if (!matchesAt(chars, afterNumber, entry.alias)) continue;
    const end = afterNumber + entry.alias.length;
    if (value === null) return { outcome: 'unsupported', end };
    return {
      outcome: 'entity',
      entity: {
        kind: 'measurement',
        raw: chars.slice(index, end).join(''),
        canonical_key: `measurement:${value}:${entry.unit}`,
      },
      end,
    };
  }

  return { outcome: 'skip', end: numeric.end };
}

export function extractCritical(text) {
  const chars = Array.from(text);
  const entities = [];
  let unsupported = 0;
  let index = 0;

  while (index < chars.length) {
    const char = chars[index];
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
    else if (candidate.outcome === 'unsupported') unsupported += 1;
    index = Math.max(candidate.end, index + 1);
  }

  return { entities, unsupported };
}

/**
 * The veto signal the hybrid is built on.
 *
 * `applicable` is false when the reference names no critical fact — there is
 * nothing for this evaluator to have an opinion about, and pretending otherwise
 * would let a silent evaluator look like agreement.
 */
export function criticalSignal(reference, hypothesis) {
  const ref = extractCritical(reference);
  const hyp = extractCritical(hypothesis);

  if (ref.unsupported > 0) {
    return { applicable: false, reason: 'reference numeric syntax unsupported by v1' };
  }
  if (ref.entities.length === 0) {
    return { applicable: false, reason: 'reference has no critical entity' };
  }

  const available = new Map();
  hyp.entities.forEach((entity, position) => {
    const bucket = available.get(entity.canonical_key);
    if (bucket) bucket.push(position);
    else available.set(entity.canonical_key, [position]);
  });

  const consumed = new Set();
  let matched = 0;
  const missing = [];
  for (const entity of ref.entities) {
    const position = available.get(entity.canonical_key)?.shift();
    if (position === undefined) {
      missing.push(entity.raw);
      continue;
    }
    consumed.add(position);
    matched += 1;
  }
  const extra = hyp.entities.filter((_, position) => !consumed.has(position)).map((e) => e.raw);

  return {
    applicable: true,
    reference_entities: ref.entities.length,
    hypothesis_entities: hyp.entities.length,
    matched,
    missing,
    extra,
    mismatch: missing.length > 0 || extra.length > 0,
  };
}
