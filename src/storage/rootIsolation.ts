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
 * Result tree. The Session and Evaluation trees join the same rule: every pair
 * of roots must be disjoint, in both directions.
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

/**
 * Is `inner` the same directory as `outer`, or somewhere beneath it?
 *
 * The escape is a `..` **path segment**, not the two characters. A directory
 * named `..evaluations` is an ordinary child: `path.relative` returns it
 * verbatim, and treating it as an escape would refuse a perfectly legal layout
 * — the same mistake as reading `runs-archive` as being inside `runs`.
 */
export function isSameOrInside(inner: string, outer: string): boolean {
  const a = path.resolve(inner);
  const b = path.resolve(outer);
  if (a === b) return true;

  const relative = path.relative(b, a);
  if (relative === '') return true;
  // A different drive or root: `path.relative` gives up and returns an
  // absolute path, which means `a` is nowhere under `b`.
  if (path.isAbsolute(relative)) return false;
  // Exactly `..`, or a path whose first segment is `..`.
  if (relative === '..' || relative.startsWith(`..${path.sep}`)) return false;
  return true;
}

/** One named storage root. */
interface NamedRoot {
  label: string;
  dir: string;
}

/** Refuse one pair of roots that are the same tree, or nested either way. */
function assertPairIsolated(a: NamedRoot, b: NamedRoot): void {
  const detail = `${a.label}=${a.dir} ${b.label}=${b.dir}`;

  if (a.dir === b.dir) {
    throw new StorageBoundaryError(
      'ROOT_ISOLATION_VIOLATED',
      `${a.label} root と ${b.label} root が同じディレクトリです。別々の tree でなければなりません。`,
      detail,
    );
  }
  if (isSameOrInside(b.dir, a.dir)) {
    throw new StorageBoundaryError(
      'ROOT_ISOLATION_VIOLATED',
      `${b.label} root が ${a.label} root の内側にあります。別々の tree でなければなりません。`,
      detail,
    );
  }
  if (isSameOrInside(a.dir, b.dir)) {
    throw new StorageBoundaryError(
      'ROOT_ISOLATION_VIOLATED',
      `${a.label} root が ${b.label} root の内側にあります。別々の tree でなければなりません。`,
      detail,
    );
  }
}

/**
 * Refuse a configuration where the two roots are the same tree, or one contains
 * the other. Throws before anything is written.
 */
export function assertRootIsolation(runsRoot: string, resultsRoot: string): void {
  assertPairIsolated(
    { label: 'runs', dir: path.resolve(runsRoot) },
    { label: 'results', dir: path.resolve(resultsRoot) },
  );
}

/**
 * The artifact trees the app writes to.
 *
 * `evaluations` is optional only because the Session flow has no evaluation
 * store to hand: it cannot write there, so it has nothing to check. Every
 * caller that reads or writes an Evaluation passes all four, which is where the
 * fourth root could actually do damage.
 */
export interface StorageRoots {
  runs: string;
  results: string;
  sessions: string;
  evaluations?: string;
}

/**
 * Refuse a configuration where any two roots share a tree.
 *
 * Checked pairwise in both directions, so an Evaluation root inside
 * `data/runs/` fails just as a runs root inside `data/evaluations/` does.
 */
export function assertStorageRootsIsolated(roots: StorageRoots): void {
  const named: NamedRoot[] = [
    { label: 'runs', dir: path.resolve(roots.runs) },
    { label: 'results', dir: path.resolve(roots.results) },
    { label: 'sessions', dir: path.resolve(roots.sessions) },
  ];
  if (roots.evaluations !== undefined) {
    named.push({ label: 'evaluations', dir: path.resolve(roots.evaluations) });
  }

  for (let i = 0; i < named.length; i += 1) {
    for (let j = i + 1; j < named.length; j += 1) {
      assertPairIsolated(named[i]!, named[j]!);
    }
  }
}
