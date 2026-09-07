/**
 * surface-normalize-v1 — forgive the typography, nothing else.
 *
 * raw-char-v1 counts every difference, which makes 「ＰＲ」 against 「pr」 look
 * like a two-character failure when nothing was misheard. This profile folds
 * away the differences that are about *how text was typed* — width, case, the
 * shape of a full stop, runs of spaces — and leaves everything else exactly
 * where it was.
 *
 * The line it will not cross is meaning. 「二千七百ミリ」 and 「2700mm」 stay
 * different here, because deciding they are the same is a claim about numbers
 * and units, not about surface form; critical-info-v1 is the evaluator entitled
 * to make that call. 「北側」 and 「north side」 stay different for the same
 * reason, and so do 「梁貫通する」 and 「梁貫通しない」.
 *
 * That is why the pipeline is a short, explicit list rather than a Unicode
 * normalization form. NFKC would quietly turn 「㎡」 into 「m2」 and 「m²」 into
 * 「m2」 as well, folding two unit spellings together as a side effect of
 * compatibility decomposition — a semantic change nobody asked for, arriving
 * through a function call that looks like formatting.
 */

export const SURFACE_NORMALIZE_PROFILE = 'surface-normalize-v1' as const;
export type SurfaceNormalizeProfile = typeof SURFACE_NORMALIZE_PROFILE;

export const SURFACE_CHAR_ALGORITHM = 'surface-normalized-char-v1' as const;
export type SurfaceCharAlgorithm = typeof SURFACE_CHAR_ALGORITHM;

/**
 * The named sub-contracts the profile is made of.
 *
 * A profile name alone says "some typography was folded". These say which:
 * which width mapping, which case fold, which punctuation aliases, what happens
 * to spaces and line breaks, and how the two normalized texts are then
 * compared. Each is versioned so that widening one is a new name rather than a
 * quiet edit that leaves old artifacts claiming semantics they were never
 * measured under.
 */
export const SURFACE_WIDTH_MAPPING = 'fullwidth-ascii-range-v1' as const;
export type SurfaceWidthMapping = typeof SURFACE_WIDTH_MAPPING;

export const SURFACE_CASE_FOLD = 'ascii-lower-v1' as const;
export type SurfaceCaseFold = typeof SURFACE_CASE_FOLD;

export const SURFACE_PUNCTUATION_ALIASES = 'punctuation-alias-v1' as const;
export type SurfacePunctuationAliases = typeof SURFACE_PUNCTUATION_ALIASES;

export const SURFACE_SPACE_POLICY = 'ascii-space-trim-collapse-v1' as const;
export type SurfaceSpacePolicy = typeof SURFACE_SPACE_POLICY;

export const SURFACE_LINE_BREAK_POLICY = 'preserve-lf-v1' as const;
export type SurfaceLineBreakPolicy = typeof SURFACE_LINE_BREAK_POLICY;

/** The comparison applied after normalization — raw-char-v1's, unchanged. */
export const SURFACE_DISTANCE = 'levenshtein-code-point-sdi-v1' as const;
export type SurfaceDistance = typeof SURFACE_DISTANCE;

/**
 * fullwidth-ascii-range-v1: exactly U+FF01 (！) … U+FF5E (～), mapped by
 * subtracting U+FEE0. Nothing outside that block is touched, so halfwidth
 * katakana and every other compatibility form is left alone.
 */
export const FULLWIDTH_ASCII_RANGE = {
  start: 0xff01,
  end: 0xff5e,
  offset: 0xfee0,
} as const;

const FULLWIDTH_ASCII_START = FULLWIDTH_ASCII_RANGE.start;
const FULLWIDTH_ASCII_END = FULLWIDTH_ASCII_RANGE.end;
const FULLWIDTH_ASCII_OFFSET = FULLWIDTH_ASCII_RANGE.offset;

/**
 * punctuation-alias-v1: two replacements, and no deletions.
 *
 * 「です。」 becomes 「です.」, never 「です」 — a full stop that was written is
 * a full stop that stays.
 */
export const PUNCTUATION_ALIASES = {
  '。': '.',
  '、': ',',
} as const;

/** U+3000, the ideographic space. */
const IDEOGRAPHIC_SPACE = '　';
/** U+3002, the ideographic full stop. */
const IDEOGRAPHIC_FULL_STOP = '。';
/** U+3001, the ideographic comma. */
const IDEOGRAPHIC_COMMA = '、';

/**
 * ascii-space-trim-collapse-v1: runs of U+0020 collapse to one, and U+0020 at
 * the very start or end of the text is dropped. U+3000 becomes U+0020 first, so
 * it participates; a tab never does.
 */
export const SPACE_POLICY_CHARS = [' '] as const;

/** preserve-lf-v1: U+000A and U+0009 pass through untouched. */
export const PRESERVED_WHITESPACE = ['\n', '\t'] as const;

/**
 * The pipeline, in order, as a readable record.
 *
 * Exported so a test can pin it: this list *is* the version. Adding a step is a
 * new profile, not an edit — old artifacts claim `surface-normalize-v1`, and
 * they have to keep meaning what they meant.
 */
export const SURFACE_NORMALIZE_STEPS = [
  'fullwidth-ascii-to-ascii',
  'ideographic-space-to-ascii-space',
  'ascii-uppercase-to-lowercase',
  'ideographic-full-stop-to-period',
  'ideographic-comma-to-comma',
  'collapse-consecutive-ascii-spaces',
  'trim-leading-trailing-ascii-spaces',
  'preserve-lf-and-tab',
] as const;

/**
 * Apply surface-normalize-v1.
 *
 * Operates on Unicode code points, so an astral character passes through as one
 * character rather than two halves.
 *
 * Line feeds and tabs survive: a transcript that ran two lines together said
 * something different from one that did not, and collapsing that would be a
 * change of content dressed up as formatting. Only the ASCII space is
 * collapsed, and only ASCII spaces are trimmed.
 */
export function surfaceNormalize(text: string): string {
  const out: string[] = [];
  let pendingSpace = false;

  for (const char of text) {
    const code = char.codePointAt(0)!;

    // 1. Fullwidth ASCII forms become their ASCII counterparts. This covers
    //    ＰＲ, ＡＢＣ, １２３ and the fullwidth punctuation in the same block.
    let mapped =
      code >= FULLWIDTH_ASCII_START && code <= FULLWIDTH_ASCII_END
        ? String.fromCodePoint(code - FULLWIDTH_ASCII_OFFSET)
        : char;

    // 2. The ideographic space is a space.
    if (mapped === IDEOGRAPHIC_SPACE) mapped = ' ';

    // 3. Case is typography, not content.
    if (mapped >= 'A' && mapped <= 'Z') mapped = mapped.toLowerCase();

    // 4-5. Ideographic full stop and comma take their ASCII shapes. Nothing is
    //      deleted: 「です。」 becomes 「です.」, not 「です」.
    if (mapped === IDEOGRAPHIC_FULL_STOP) mapped = '.';
    else if (mapped === IDEOGRAPHIC_COMMA) mapped = ',';

    // 6. A run of ASCII spaces is one space. Held rather than emitted, so a run
    //    that reaches the end of the text can be dropped by the trim below.
    if (mapped === ' ') {
      pendingSpace = out.length > 0;
      continue;
    }

    if (pendingSpace) {
      out.push(' ');
      pendingSpace = false;
    }
    out.push(mapped);
  }

  // 7. Trailing ASCII spaces are dropped by never emitting `pendingSpace`.
  //    Leading ones were dropped by the `out.length > 0` guard.
  return out.join('');
}

/** Normalized code points, which is what the surface metrics count. */
export function surfaceNormalizedLength(text: string): number {
  return Array.from(surfaceNormalize(text)).length;
}
