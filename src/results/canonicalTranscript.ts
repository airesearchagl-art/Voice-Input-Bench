import { toCanonicalText } from '@/lib/canonicalText';

/**
 * Canonical transcript text.
 *
 * An STT transcript is evidence of what a tool heard. Correcting it — even
 * "obviously" — destroys the thing being measured, so the only transformation
 * applied is line-ending normalization, exactly as for Phase 1 source text:
 *
 *   raw pasted transcript  →  CRLF / CR → LF  →  canonical transcript
 *
 * No trim, no width conversion, no Unicode normalization, no punctuation
 * repair, no whitespace collapsing, no typo correction, no LLM tidying.
 *
 * `transcript.txt` and the Result's SHA-256 are both taken from this same
 * string, so the hash always describes the bytes on disk.
 */
export function toCanonicalTranscript(raw: string): string {
  return toCanonicalText(raw);
}

/**
 * Emptiness check for request validation only.
 *
 * `trim()` decides whether the operator pasted anything at all — never what
 * gets stored or hashed. A transcript of only spaces is still a real
 * observation, but an empty box is a mistake.
 */
export function isBlankTranscript(canonical: string): boolean {
  return canonical.length === 0;
}
