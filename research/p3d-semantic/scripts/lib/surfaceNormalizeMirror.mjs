/**
 * A runnable mirror of production `surfaceNormalize()` (surface-normalize-v1).
 *
 * The research scripts are plain `.mjs` and cannot import the TypeScript
 * evaluator, but one of the questions this spike has to answer is whether a
 * semantic method should read raw text or surface-normalized text. Answering it
 * with an approximation of the profile would answer a different question.
 *
 * So this is a line-for-line mirror, and `surfaceNormalizeMirror.test.mjs`
 * asserts it agrees with the production function on every probe in the corpus
 * plus the profile's own edge cases. If production ever changes, that test
 * fails rather than this file quietly drifting.
 */

const FULLWIDTH_ASCII_START = 0xff01;
const FULLWIDTH_ASCII_END = 0xff5e;
const FULLWIDTH_ASCII_OFFSET = 0xfee0;

const IDEOGRAPHIC_SPACE = '　';
const IDEOGRAPHIC_FULL_STOP = '。';
const IDEOGRAPHIC_COMMA = '、';

export function surfaceNormalizeMirror(text) {
  const out = [];
  let pendingSpace = false;

  for (const char of text) {
    const code = char.codePointAt(0);

    let mapped =
      code >= FULLWIDTH_ASCII_START && code <= FULLWIDTH_ASCII_END
        ? String.fromCodePoint(code - FULLWIDTH_ASCII_OFFSET)
        : char;

    if (mapped === IDEOGRAPHIC_SPACE) mapped = ' ';
    if (mapped >= 'A' && mapped <= 'Z') mapped = mapped.toLowerCase();
    if (mapped === IDEOGRAPHIC_FULL_STOP) mapped = '.';
    else if (mapped === IDEOGRAPHIC_COMMA) mapped = ',';

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

  return out.join('');
}
