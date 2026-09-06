import { mkdir, mkdtemp, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { isValidRunId } from '@/lib/runId';

/**
 * Local, immutable Run storage.
 *
 * A Run is written to a sibling temporary directory first and only moved into
 * place once every file is on disk. The rename is the commit point: either a
 * Run directory exists with all four files, or it does not exist at all. A
 * half-written directory is never left behind under an official Run ID.
 *
 *   data/runs/
 *   ├─ .tmp-<random>/          ← written here first, removed on any failure
 *   └─ <run-id>/               ← appears atomically, never modified afterwards
 *      ├─ source.txt
 *      ├─ audio.wav
 *      ├─ provider-query.json
 *      └─ manifest.json
 *
 * The temp directory is a sibling of the final directory on purpose: same
 * filesystem, so the rename is a real atomic move rather than a copy.
 *
 * This module owns filesystem persistence. The TTS Provider does not — see
 * docs/architecture/phase-1-plan.md §2.3.
 */

export const SOURCE_FILE = 'source.txt';
export const AUDIO_FILE = 'audio.wav';
export const PROVIDER_QUERY_FILE = 'provider-query.json';
export const MANIFEST_FILE = 'manifest.json';

export type RunStoreErrorKind =
  /** A Run directory with this ID already exists; Runs are never overwritten. */
  | 'RUN_ALREADY_EXISTS'
  /** The run ID does not match the server-generated pattern. */
  | 'INVALID_RUN_ID'
  /** The resolved path escaped the runs root. */
  | 'PATH_ESCAPES_ROOT'
  /** No Run directory with this ID. */
  | 'RUN_NOT_FOUND'
  /** Writing the bundle failed; the temp directory has been removed. */
  | 'WRITE_FAILED';

export class RunStoreError extends Error {
  readonly kind: RunStoreErrorKind;

  constructor(kind: RunStoreErrorKind, message: string, options: { cause?: unknown } = {}) {
    super(message, { cause: options.cause });
    this.name = 'RunStoreError';
    this.kind = kind;
  }
}

/** The four files that make up a Run Bundle. */
export interface RunBundleInput {
  /**
   * Canonical source text. Written as UTF-8 with no BOM and with no trailing
   * newline appended — the bytes on disk are exactly the canonical string's
   * bytes, because that is what Text SHA-256 was computed over.
   */
  sourceText: string;
  /** Exact WAV bytes as returned by the provider. Never re-encoded. */
  audio: Uint8Array;
  /** Serialized provider-query.json bytes. Hashed as written. */
  providerQueryJson: Uint8Array;
  /** Serialized manifest.json bytes. Written last. */
  manifestJson: Uint8Array;
}

export interface StoredRun {
  runId: string;
  runDir: string;
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

export class LocalRunStore {
  /** Absolute path of the runs root, e.g. `<project>/data/runs`. */
  readonly rootDir: string;

  constructor(rootDir: string) {
    this.rootDir = path.resolve(rootDir);
  }

  /**
   * Resolve a Run directory, refusing anything that is not a server-generated
   * run ID or that resolves outside the runs root.
   *
   * Both checks are kept: the pattern rejects the obvious traversal attempts,
   * and the containment check is the backstop that does not depend on the
   * pattern being exhaustive.
   */
  resolveRunDir(runId: string): string {
    if (!isValidRunId(runId)) {
      throw new RunStoreError('INVALID_RUN_ID', `run id の形式が不正です: ${JSON.stringify(runId)}`);
    }

    const resolved = path.resolve(this.rootDir, runId);
    const withSeparator = this.rootDir.endsWith(path.sep) ? this.rootDir : this.rootDir + path.sep;
    if (!resolved.startsWith(withSeparator)) {
      throw new RunStoreError('PATH_ESCAPES_ROOT', `run id が runs root の外を指しています: ${runId}`);
    }

    return resolved;
  }

  /** Absolute path of one file inside a Run, with the same safety checks. */
  resolveRunFile(runId: string, fileName: typeof SOURCE_FILE | typeof AUDIO_FILE | typeof PROVIDER_QUERY_FILE | typeof MANIFEST_FILE): string {
    return path.join(this.resolveRunDir(runId), fileName);
  }

  async hasRun(runId: string): Promise<boolean> {
    return pathExists(this.resolveRunDir(runId));
  }

  /**
   * Write a Run Bundle transactionally.
   *
   * On success the Run directory exists with all four files. On any failure the
   * temp directory is removed and no directory appears under `runId`.
   */
  async saveRun(runId: string, bundle: RunBundleInput): Promise<StoredRun> {
    const runDir = this.resolveRunDir(runId);

    await mkdir(this.rootDir, { recursive: true });

    if (await pathExists(runDir)) {
      throw new RunStoreError(
        'RUN_ALREADY_EXISTS',
        `Run ${runId} は既に存在します。Run は上書きされません。`,
      );
    }

    // Sibling of the final directory, so the commit below is an atomic rename
    // rather than a cross-device copy.
    const tempDir = await mkdtemp(path.join(this.rootDir, '.tmp-'));

    try {
      // manifest.json is written last: while it is absent the bundle is
      // visibly incomplete, and it can only describe files that already exist.
      await writeFile(path.join(tempDir, SOURCE_FILE), Buffer.from(bundle.sourceText, 'utf8'));
      await writeFile(path.join(tempDir, PROVIDER_QUERY_FILE), bundle.providerQueryJson);
      await writeFile(path.join(tempDir, AUDIO_FILE), bundle.audio);
      await writeFile(path.join(tempDir, MANIFEST_FILE), bundle.manifestJson);

      await rename(tempDir, runDir);
    } catch (cause) {
      await rm(tempDir, { recursive: true, force: true }).catch(() => {});
      if (cause instanceof RunStoreError) throw cause;
      throw new RunStoreError(
        'WRITE_FAILED',
        `Run ${runId} の書き込みに失敗しました: ${cause instanceof Error ? cause.message : String(cause)}`,
        { cause },
      );
    }

    return { runId, runDir };
  }
}
