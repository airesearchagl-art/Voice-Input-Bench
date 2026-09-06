import { describe, expect, it } from 'vitest';
import { isBlankText, toCanonicalText } from './canonicalText';

describe('toCanonicalText', () => {
  it('normalizes CRLF to LF', () => {
    expect(toCanonicalText('a\r\nb\r\nc')).toBe('a\nb\nc');
  });

  it('normalizes bare CR to LF', () => {
    expect(toCanonicalText('a\rb\rc')).toBe('a\nb\nc');
  });

  it('normalizes mixed CRLF / CR / LF consistently', () => {
    expect(toCanonicalText('a\r\nb\rc\nd')).toBe('a\nb\nc\nd');
  });

  it('leaves LF-only text untouched', () => {
    const text = 'a\nb\nc\n';
    expect(toCanonicalText(text)).toBe(text);
  });

  it('preserves leading, trailing and repeated spaces', () => {
    const text = '   前後に空白   ';
    expect(toCanonicalText(text)).toBe(text);
    expect(toCanonicalText('a  b   c')).toBe('a  b   c');
    expect(toCanonicalText('\t tab \t')).toBe('\t tab \t');
  });

  it('preserves a trailing newline and does not add one', () => {
    expect(toCanonicalText('abc')).toBe('abc');
    expect(toCanonicalText('abc\r\n')).toBe('abc\n');
  });

  it('does not apply Unicode normalization', () => {
    // NFD "が" (か + combining dakuten) must not be folded into NFC "が".
    const nfd = '\u304B\u3099';
    expect(toCanonicalText(nfd)).toBe(nfd);
    expect(toCanonicalText(nfd)).not.toBe('\u304C');
  });

  it('does not convert between full-width and half-width', () => {
    expect(toCanonicalText('ＡＢＣ１２３')).toBe('ＡＢＣ１２３');
    expect(toCanonicalText('ｱｲｳ')).toBe('ｱｲｳ');
  });

  it('does not rewrite punctuation', () => {
    const text = '、。「」！？…‥ー－—,.!?';
    expect(toCanonicalText(text)).toBe(text);
  });

  it('does not correct typos or reformat', () => {
    const text = 'こんんいちわ、  テスト です。';
    expect(toCanonicalText(text)).toBe(text);
  });

  it('preserves emoji and surrogate pairs', () => {
    const text = '音声🎙️テスト𠮷';
    expect(toCanonicalText(text)).toBe(text);
  });

  it('only ever changes CR characters', () => {
    const text = ' 　\tあaＡ、.\u304B\u3099🎙️ ';
    expect(toCanonicalText(text)).toBe(text);
  });
});

describe('isBlankText', () => {
  it('treats whitespace-only input as blank', () => {
    expect(isBlankText('')).toBe(true);
    expect(isBlankText('   ')).toBe(true);
    expect(isBlankText('\n\t ')).toBe(true);
  });

  it('treats padded real text as non-blank', () => {
    expect(isBlankText('  あ  ')).toBe(false);
  });
});
