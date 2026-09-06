import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { isBlankTranscript, toCanonicalTranscript } from './canonicalTranscript';
import { sha256OfText } from '@/lib/hash';

describe('toCanonicalTranscript', () => {
  it('normalizes CRLF and bare CR to LF', () => {
    expect(toCanonicalTranscript('a\r\nb\rc\nd')).toBe('a\nb\nc\nd');
  });

  it('leaves LF-only text untouched', () => {
    const text = 'STT が返した行\n二行目\n';
    expect(toCanonicalTranscript(text)).toBe(text);
  });

  it('preserves leading, trailing and repeated spaces', () => {
    // An STT tool that emitted stray spacing is evidence of exactly that.
    const text = '   前後に空白   ';
    expect(toCanonicalTranscript(text)).toBe(text);
    expect(toCanonicalTranscript('a  b   c')).toBe('a  b   c');
    expect(toCanonicalTranscript('\t tab \t')).toBe('\t tab \t');
  });

  it('does not apply Unicode normalization', () => {
    const nfd = '\u304B\u3099';
    expect(toCanonicalTranscript(nfd)).toBe(nfd);
    expect(toCanonicalTranscript(nfd)).not.toBe('\u304C');
  });

  it('does not convert between full-width and half-width', () => {
    expect(toCanonicalTranscript('ＡＢＣ１２３ｱｲｳ')).toBe('ＡＢＣ１２３ｱｲｳ');
  });

  it('does not repair punctuation', () => {
    const text = '、。「」！？…‥ー－—,.!?';
    expect(toCanonicalTranscript(text)).toBe(text);
  });

  it('does not correct a misrecognition', () => {
    // The whole point of the Result is that the tool got this wrong.
    const text = '天井高は二千六百ミリで、こんんいちわ';
    expect(toCanonicalTranscript(text)).toBe(text);
  });

  it('preserves emoji and surrogate pairs', () => {
    const text = '音声🎙️テスト𠮷';
    expect(toCanonicalTranscript(text)).toBe(text);
  });

  it('only ever changes CR characters', () => {
    const text = ' 　\tあaＡ、.\u304B\u3099🎙️ ';
    expect(toCanonicalTranscript(text)).toBe(text);
  });
});

describe('transcript hash', () => {
  it('hashes the UTF-8 bytes of the canonical transcript', () => {
    const canonical = toCanonicalTranscript('これは\r\nSTT 出力です。');
    expect(sha256OfText(canonical)).toBe(
      createHash('sha256').update(Buffer.from(canonical, 'utf8')).digest('hex'),
    );
  });

  it('distinguishes CRLF input from LF input only before canonicalization', () => {
    expect(sha256OfText('a\r\nb')).not.toBe(sha256OfText('a\nb'));
    expect(sha256OfText(toCanonicalTranscript('a\r\nb'))).toBe(sha256OfText('a\nb'));
  });

  it('distinguishes untrimmed from trimmed text', () => {
    expect(sha256OfText('  a  ')).not.toBe(sha256OfText('a'));
  });
});

describe('isBlankTranscript', () => {
  it('treats only a genuinely empty string as blank', () => {
    expect(isBlankTranscript('')).toBe(true);
    // Whitespace is a real observation, not an empty box.
    expect(isBlankTranscript('   ')).toBe(false);
    expect(isBlankTranscript('\n')).toBe(false);
  });
});
