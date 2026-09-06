import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { sha256OfBytes, sha256OfText } from './hash';

describe('sha256OfText', () => {
  it('hashes the UTF-8 bytes of the string', () => {
    // Known vector: SHA-256 of the empty string.
    expect(sha256OfText('')).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
    expect(sha256OfText('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('hashes multibyte text as UTF-8', () => {
    const text = 'こんにちは';
    expect(sha256OfText(text)).toBe(
      createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex'),
    );
  });

  it('distinguishes CRLF from LF, so canonicalization changes the hash', () => {
    expect(sha256OfText('a\r\nb')).not.toBe(sha256OfText('a\nb'));
  });

  it('distinguishes untrimmed text from trimmed text', () => {
    expect(sha256OfText('  a  ')).not.toBe(sha256OfText('a'));
  });
});

describe('sha256OfBytes', () => {
  it('hashes exact bytes', () => {
    const bytes = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x00, 0xff]);
    expect(sha256OfBytes(bytes)).toBe(createHash('sha256').update(bytes).digest('hex'));
  });

  it('agrees with sha256OfText for the same UTF-8 bytes', () => {
    const text = 'テスト';
    expect(sha256OfBytes(Buffer.from(text, 'utf8'))).toBe(sha256OfText(text));
  });
});
