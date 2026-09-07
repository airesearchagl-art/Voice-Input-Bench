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

/** Fullwidth ASCII block: U+FF01 (！) … U+FF5E (～). */
const FULLWIDTH_ASCII_START = 0xff01;
const FULLWIDTH_ASCII_END = 0xff5e;
/** Distance from a fullwidth form to its ASCII counterpart. */
const FULLWIDTH_ASCII_OFFSET = 0xfee0;

/** U+3000, the ideographic space. */
const IDEOGRAPHIC_SPACE = '　';
/** U+3002, the ideographic full stop. */
const IDEOGRAPHIC_FULL_STOP = '。';
/** U+3001, the ideographic comma. */
const IDEOGRAPHIC_COMMA = '、';

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
