/**
 * Canonical source text.
 *
 * A Run's stored text, its Text SHA-256 input, and the text handed to the TTS
 * engine must be the SAME string. If they diverge by even one character, the
 * manifest hash stops describing what was actually spoken and the Run is no
 * longer evidence of anything.
 *
 * The only transformation applied is line-ending normalization:
 *
 *   raw UI text  →  CRLF / CR → LF  →  canonical text
 *
 * Line endings are normalized because they carry input-path noise (OS, editor,
 * paste source) rather than input content. Everything else — leading and
 * trailing spaces, repeated spaces, full-width characters, punctuation,
 * typos — IS the content under test and must survive untouched.
 *
 * See docs/architecture/phase-1-plan.md §6.1.
 */

/**
 * Normalize CRLF and bare CR to LF. Nothing else is changed: no trim, no
 * Unicode normalization, no width conversion, no punctuation rewriting, no
 * whitespace collapsing, no typo correction, no AI reformatting.
 */
export function toCanonicalText(raw: string): string {
  return raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

/**
 * Emptiness check for request validation only.
 *
 * `trim()` is used to decide whether the user typed anything at all — never to
 * produce the string that gets stored, hashed, or synthesized. Callers must
 * pass the untrimmed canonical text everywhere else.
 */
export function isBlankText(canonical: string): boolean {
  return canonical.trim().length === 0;
}
