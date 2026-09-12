import { describe, expect, it } from 'vitest';
import { CanonicalJsonError, canonicalJson, canonicalJsonPretty } from './canonicalJson';

describe('canonical-json-v1', () => {
  it('sorts keys by code unit whatever the insertion order, and keeps array order', () => {
    const a = { b: 1, a: [2, { d: null, c: 'x' }], ä: true, Z: false };
    const b = { Z: false, ä: true, a: [2, { c: 'x', d: null }], b: 1 };
    expect(canonicalJson(a)).toBe('{"Z":false,"a":[2,{"c":"x","d":null}],"b":1,"ä":true}');
    expect(canonicalJson(b)).toBe(canonicalJson(a));
    expect(canonicalJson([3, 1, 2])).toBe('[3,1,2]');
  });

  it('writes strings and numbers exactly as ECMAScript JSON does, with no whitespace', () => {
    expect(canonicalJson({ s: '改行\n"引用"', n: 0.1 + 0.2, i: -0, e: 1e21 })).toBe(
      `{"e":1e+21,"i":0,"n":0.30000000000000004,"s":${JSON.stringify('改行\n"引用"')}}`,
    );
    expect(canonicalJson({ a: [], b: {} })).toBe('{"a":[],"b":{}}');
  });

  it('refuses anything it cannot write exactly', () => {
    for (const bad of [
      { a: undefined },
      { a: Number.NaN },
      { a: Number.POSITIVE_INFINITY },
      { a: () => 1 },
      { a: new Date(0) },
      { a: BigInt(1) },
    ]) {
      expect(() => canonicalJson(bad)).toThrow(CanonicalJsonError);
    }
  });

  it('pretty form keeps the canonical order, indents with LF only, and ends in one LF', () => {
    const text = canonicalJsonPretty({ b: [1, { y: 2, x: 1 }], a: 'v' });
    expect(text).toBe('{\n  "a": "v",\n  "b": [\n    1,\n    {\n      "x": 1,\n      "y": 2\n    }\n  ]\n}\n');
    expect(text).not.toContain('\r');
    expect(JSON.parse(text)).toEqual({ a: 'v', b: [1, { x: 1, y: 2 }] });
  });
});
