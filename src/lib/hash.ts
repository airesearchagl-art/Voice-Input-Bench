import { createHash } from 'node:crypto';

/**
 * SHA-256 helpers. Node's built-in crypto only — no extra hash dependency.
 */

/** Hash the UTF-8 bytes of a string. Used for the canonical source text. */
export function sha256OfText(text: string): string {
  return createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');
}

/** Hash exact bytes. Used for the WAV the provider returned and for provider-query.json. */
export function sha256OfBytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}
