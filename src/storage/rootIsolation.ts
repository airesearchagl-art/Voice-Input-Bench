import path from 'node:path';

/**
 * The Phase 1 Run tree and the Phase 2 Result tree must be separate trees.
 *
 * Phase 1 Runs are immutable. If the results root were the runs root — or sat
 * inside it — saving a Result would create directories and files inside
 * `data/runs/`, and a Result could land inside an existing Run's own directory.
 * The immutability guarantee would be gone without anything failing.
 *
 * The inverse nesting is refused for the same reason from the other side: a
 * runs root inside the results root means generating a Run writes into the
 * Result tree.
 *
 * This is a configuration error, not a request error, so it is checked before
 * any write rather than reported per-request after the fact.
 */

export type StorageBoundaryErrorKind = 'ROOT_ISOLATION_VIOLATED';

export class StorageBoundaryError extends Error {
  readonly kind: StorageBoundaryErrorKind;
  readonly detail?: string;

  constructor(kind: StorageBoundaryErrorKind, message: string, detail?: string) {
    super(message);
    this.name = 'StorageBoundaryError';
    this.kind = kind;
    this.detail = detail;
  }
}

/** Is `inner` the same directory as `outer`, or somewhere beneath it? */
export function isSameOrInside(inner: string, outer: string): boolean {
  const a = path.resolve(inner);
  const b = path.resolve(outer);
  if (a === b) return true;
  const relative = path.relative(b, a);
  // `relative` escapes with `..` (or is absolute) exactly when `a` is outside `b`.
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

/**
 * Refuse a configuration where the two roots are the same tree, or one contains
 * the other. Throws before anything is written.
 */
export function assertRootIsolation(runsRoot: string, resultsRoot: string): void {
  const runs = path.resolve(runsRoot);
  const results = path.resolve(resultsRoot);

  if (runs === results) {
    throw new StorageBoundaryError(
      'ROOT_ISOLATION_VIOLATED',
      'runs root と results root が同じディレクトリです。Result は Run tree の中に置けません。',
      `runs=${runs} results=${results}`,
    );
  }

  if (isSameOrInside(results, runs)) {
    throw new StorageBoundaryError(
      'ROOT_ISOLATION_VIOLATED',
      'results root が runs root の内側にあります。Result は Run tree の中に置けません。',
      `runs=${runs} results=${results}`,
    );
  }

  if (isSameOrInside(runs, results)) {
    throw new StorageBoundaryError(
      'ROOT_ISOLATION_VIOLATED',
      'runs root が results root の内側にあります。Run は Result tree の中に置けません。',
      `runs=${runs} results=${results}`,
    );
  }
}
