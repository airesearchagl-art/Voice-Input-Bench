/**
 * The two checks every Evaluation schema needs before its canonicalizer runs.
 *
 * Each canonical serializer names every property by hand, which is what keeps a
 * seal independent of key order and indentation. The cost is twofold, and both
 * halves are covered here:
 *
 *   1. it dereferences whatever the file contains, so a nested value that is
 *      not an object throws a raw `TypeError` out of the hash function;
 *   2. it hashes only the fields it names, so a field it has never heard of
 *      costs the seal nothing and rides along inside a `verified` artifact.
 *
 * These helpers are deliberately thin, and they take a `fail` callback rather
 * than importing an error class. That keeps them free of any schema's module
 * graph — v1's verifier owns the error type, so a shared module that imported
 * it would close a cycle — and it leaves each schema in charge of which error
 * kind its own failure is.
 *
 * What is *not* here is any notion of a shared schema. The allowed-field lists
 * stay with the schema they describe, spelled out and reviewable next to the
 * canonicalizer they have to match. v1, v2, v3 and v4 mean different things,
 * and a single validator that accepted all of them would be the generic
 * envelope this bench has repeatedly decided against.
 */

export type Rec = Record<string, unknown>;

/** Raise this schema's own verification error. Never returns. */
export type ShapeFail = (message: string, detail: string) => never;

export function isRec(value: unknown): value is Rec {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The canonicalizer is about to step into this value, so it must be an object.
 */
export function requireObject(value: unknown, path: string, fail: ShapeFail): Rec {
  if (!isRec(value)) {
    fail(
      `evaluation.json の ${path} がオブジェクトではありません。`,
      `path=${path} actual=${JSON.stringify(value) ?? String(value)}`,
    );
  }
  return value;
}

/**
 * Refuse a field this build has never heard of.
 *
 * Not tidiness. A verified Evaluation should make no claim that the seal does
 * not cover, and an unknown field is exactly that: unhashed, so it survives any
 * number of re-seals, and still sitting there when a reader takes the artifact
 * at its word.
 */
export function rejectUnknownFields(
  value: Rec,
  path: string,
  allowed: readonly string[],
  fail: ShapeFail,
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      fail(
        `evaluation.json の ${path} に未知の field があります: ${key}`,
        `path=${path}.${key} allowed=${allowed.join(' / ')}`,
      );
    }
  }
}
