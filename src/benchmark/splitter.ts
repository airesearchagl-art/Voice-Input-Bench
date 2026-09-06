/**
 * Deterministic long-text splitter, strategy `sentence-v1`.
 *
 * Splitting has to be reproducible: the same canonical text must always yield
 * the same segments, on any machine, forever. So this is a fixed rule set — no
 * model, no locale data, no ICU segmentation whose behaviour moves with the
 * runtime's Unicode version.
 *
 * The text is never edited. Segments are slices, and
 * `segments.join('') === canonicalText` always holds: no character is added,
 * dropped, trimmed or substituted, and delimiters stay with the segment they
 * ended.
 */

export const SPLIT_STRATEGY = 'sentence-v1';

/** Target upper bound per segment, in Unicode code points. */
export const DEFAULT_TARGET_MAX_CHARS = 450;

/**
 * A boundary is only accepted if it leaves at least this fraction of the target
 * in the segment. Without it, a newline five characters into a window would win
 * on priority and produce a five-character segment.
 */
const MIN_SEGMENT_RATIO = 0.4;

/** Sentence-ending punctuation, both full-width and ASCII. */
const SENTENCE_ENDERS = new Set(['。', '！', '？', '!', '?']);

/** Clause separator. */
const CLAUSE_SEPARATORS = new Set(['、']);

/** Lower-priority but still safe places to break. */
const SAFE_BREAK_CHARS = new Set([
  ' ',
  '\t',
  '　', // ideographic space
  '，',
  ',',
  '；',
  ';',
  '：',
  ':',
  '）',
  ')',
  '」',
  '』',
  '】',
  '〉',
  '》',
  '］',
  ']',
  '｝',
  '}',
  '・',
  '…',
  '—',
  '―',
  '/',
  '／',
]);

const ZWJ = 0x200d;
const KEYCAP = 0x20e3;
const COMBINING_MARK = /\p{M}/u;

function codePointAt(cps: readonly string[], index: number): number {
  return cps[index]!.codePointAt(0)!;
}

function isVariationSelector(cp: number): boolean {
  return (cp >= 0xfe00 && cp <= 0xfe0f) || (cp >= 0xe0100 && cp <= 0xe01ef);
}

function isSkinToneModifier(cp: number): boolean {
  return cp >= 0x1f3fb && cp <= 0x1f3ff;
}

function isRegionalIndicator(cp: number): boolean {
  return cp >= 0x1f1e6 && cp <= 0x1f1ff;
}

/**
 * May the text be cut between `index - 1` and `index`?
 *
 * Because the array holds code points, surrogate pairs can never be split. This
 * additionally refuses to cut inside a grapheme cluster: combining marks, ZWJ
 * emoji sequences, variation selectors, skin-tone modifiers, keycaps, and
 * regional-indicator (flag) pairs all stay whole.
 */
export function isSafeCutPoint(cps: readonly string[], index: number): boolean {
  if (index <= 0 || index >= cps.length) return false;

  const next = codePointAt(cps, index);
  if (
    COMBINING_MARK.test(cps[index]!) ||
    next === ZWJ ||
    next === KEYCAP ||
    isVariationSelector(next) ||
    isSkinToneModifier(next)
  ) {
    return false;
  }

  const previous = codePointAt(cps, index - 1);
  if (previous === ZWJ) return false;

  // A flag is a pair of regional indicators. Cutting is only safe on an even
  // offset into the run, so count the run backwards from here.
  if (isRegionalIndicator(next)) {
    let runStart = index;
    while (runStart > 0 && isRegionalIndicator(codePointAt(cps, runStart - 1))) runStart -= 1;
    if ((index - runStart) % 2 !== 0) return false;
  }

  return true;
}

/** Boundary classes, highest priority first. The cut goes AFTER the matched character. */
const BOUNDARY_CLASSES: ReadonlyArray<(character: string) => boolean> = [
  (character) => character === '\n',
  (character) => SENTENCE_ENDERS.has(character),
  (character) => CLAUSE_SEPARATORS.has(character),
  (character) => SAFE_BREAK_CHARS.has(character),
];

/**
 * Find the last safe cut index at or before `limit` for one boundary class.
 * Returns 0 when the class has no usable boundary in the window.
 */
function lastBoundary(
  cps: readonly string[],
  start: number,
  limit: number,
  matches: (character: string) => boolean,
): number {
  for (let index = limit; index > start; index -= 1) {
    if (matches(cps[index - 1]!) && isSafeCutPoint(cps, index)) return index;
  }
  return 0;
}

/** Last safe cut index at or before `limit`, ignoring boundary classes. */
function lastSafeCut(cps: readonly string[], start: number, limit: number): number {
  for (let index = limit; index > start; index -= 1) {
    if (isSafeCutPoint(cps, index)) return index;
  }
  return 0;
}

/** First safe cut index after `limit`, used only when a window is unbreakable. */
function firstSafeCutAfter(cps: readonly string[], limit: number): number {
  for (let index = limit + 1; index < cps.length; index += 1) {
    if (isSafeCutPoint(cps, index)) return index;
  }
  return cps.length;
}

function chooseCut(cps: readonly string[], start: number, limit: number, minChars: number): number {
  const candidates: number[] = [];

  for (const matches of BOUNDARY_CLASSES) {
    const index = lastBoundary(cps, start, limit, matches);
    if (index === 0) continue;
    // Priority first: the highest-priority class that still yields a segment of
    // a reasonable size wins outright.
    if (index - start >= minChars) return index;
    candidates.push(index);
  }

  // No class produced a long-enough segment. Take the longest boundary of any
  // class rather than cutting mid-word.
  if (candidates.length > 0) return Math.max(...candidates);

  // No boundary at all in the window: hard split at the last safe point.
  const hard = lastSafeCut(cps, start, limit);
  if (hard > 0) return hard;

  // The whole window is one unbreakable grapheme cluster. Text integrity wins
  // over the target length, so extend to the next safe point.
  return firstSafeCutAfter(cps, limit);
}

/**
 * Split canonical text into segments of at most `targetMaxChars` code points.
 *
 * The only case where a segment can exceed the target is a single grapheme
 * cluster longer than the target, which cannot be cut without corrupting it.
 */
export function splitCanonicalText(
  canonicalText: string,
  targetMaxChars: number = DEFAULT_TARGET_MAX_CHARS,
): string[] {
  if (canonicalText.length === 0) return [];
  if (!Number.isInteger(targetMaxChars) || targetMaxChars < 1) {
    throw new RangeError(`targetMaxChars must be a positive integer, got ${targetMaxChars}`);
  }

  const cps = Array.from(canonicalText);
  if (cps.length <= targetMaxChars) return [canonicalText];

  const minChars = Math.max(1, Math.floor(targetMaxChars * MIN_SEGMENT_RATIO));
  const segments: string[] = [];

  let start = 0;
  while (start < cps.length) {
    if (cps.length - start <= targetMaxChars) {
      segments.push(cps.slice(start).join(''));
      break;
    }
    const cut = chooseCut(cps, start, start + targetMaxChars, minChars);
    segments.push(cps.slice(start, cut).join(''));
    start = cut;
  }

  return segments;
}

/** Code point count, as used by the segment length limit. */
export function countCodePoints(text: string): number {
  return Array.from(text).length;
}
