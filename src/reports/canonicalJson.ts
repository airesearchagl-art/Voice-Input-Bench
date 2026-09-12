/**
 * canonical-json-v1 — the byte form Report content identity is computed over.
 *
 * Stated as a contract rather than left to whatever `JSON.stringify` happens to
 * do with an object's insertion order:
 *
 * - Objects: keys sorted by UTF-16 code unit (`<` on strings), never by locale.
 * - Arrays: order preserved. Order is meaningful and was fixed upstream.
 * - Strings: JSON string escaping as ECMAScript `JSON.stringify` defines it.
 * - Numbers: finite only, written as ECMAScript `Number#toString` writes them
 *   (the shortest round-trip form), which is platform independent by spec.
 * - `true`, `false`, `null` as themselves.
 * - No whitespace. No newline anywhere, so no platform newline can leak in.
 * - `undefined`, functions, symbols, bigints, NaN and ±Infinity are refused
 *   rather than silently dropped or coerced: a value that cannot be written
 *   exactly is not written at all.
 * - Hashed as UTF-8.
 */

export const CANONICAL_JSON_ID = 'canonical-json-v1';

export class CanonicalJsonError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CanonicalJsonError';
  }
}

function compareKeys(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function write(value: unknown, path: string, indent: string | null, depth: number): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'string':
      return JSON.stringify(value);
    case 'number':
      if (!Number.isFinite(value)) {
        throw new CanonicalJsonError(`${path}: 有限でない数値は書けません。`);
      }
      return JSON.stringify(value);
    case 'object':
      break;
    default:
      throw new CanonicalJsonError(`${path}: ${typeof value} は JSON に書けません。`);
  }

  const open = indent === null ? '' : `\n${indent.repeat(depth + 1)}`;
  const close = indent === null ? '' : `\n${indent.repeat(depth)}`;
  const separator = indent === null ? ',' : `,${open}`;
  const colon = indent === null ? ':' : ': ';

  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    const items = value.map((item, index) => write(item, `${path}[${index}]`, indent, depth + 1));
    return `[${open}${items.join(separator)}${close}]`;
  }

  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) {
    throw new CanonicalJsonError(`${path}: plain object 以外は書けません。`);
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort(compareKeys);
  if (keys.length === 0) return '{}';
  const members = keys.map((key) => {
    const member = record[key];
    if (member === undefined) {
      throw new CanonicalJsonError(`${path}.${key}: undefined は書けません。`);
    }
    return `${JSON.stringify(key)}${colon}${write(member, `${path}.${key}`, indent, depth + 1)}`;
  });
  return `{${open}${members.join(separator)}${close}}`;
}

/** The exact canonical-json-v1 text: compact, keys sorted, arrays as given. */
export function canonicalJson(value: unknown): string {
  return write(value, '$', null, 0);
}

/**
 * The same canonical order, indented two spaces and ending in one LF.
 *
 * Used for the exported `*.source.json` file so it is readable and still
 * byte-identical for identical content. Not the identity form — that is
 * `canonicalJson`.
 */
export function canonicalJsonPretty(value: unknown): string {
  return `${write(value, '$', '  ', 0)}\n`;
}
