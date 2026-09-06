import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { isValidResultId } from '@/lib/resultId';

/**
 * Local, immutable storage for manual STT Results.
 *
 * Same transaction shape as the Phase 1 Run store, in its own root:
 *
 *   data/results/
 *   ├─ .tmp-<random>/          ← written here first, removed on any failure
 *   └─ <result-id>/            ← appears atomically, never modified afterwards
 *      ├─ transcript.txt
 *      └─ result.json
 *
 * It is deliberately a separate class rather than a shared generic with
 * `LocalRunStore`: the two roots have different vocabularies and different
 * error kinds, and Phase 1's storage is merged and reviewed. Sharing an
 * abstraction between them would mean editing the Run store to serve Results.
 *
 * The Run store is never written through this class. `data/runs/` stays exactly
 * as Phase 1 left it.
 */

export const TRANSCRIPT_FILE = 'transcript.txt';
export const RESULT_FILE = 'result.json';

export type ResultStoreErrorKind =
  /** A Result directory with this ID already exists; Results are never overwritten. */
  | 'RESULT_ALREADY_EXISTS'
  /** The result ID does not match the server-generated pattern. */
  | 'INVALID_RESULT_ID'
  /** The resolved path escaped the results root. */
  | 'RESULT_PATH_ESCAPES_ROOT'
  /** No Result directory with this ID. */
  | 'RESULT_NOT_FOUND'
  /** Writing the bundle failed; the temp directory has been removed. */
  | 'RESULT_WRITE_FAILED'
  /** A stored `result.json` could not be read or parsed. */
  | 'RESULT_UNREADABLE';

export class ResultStoreError extends Error {
  readonly kind: ResultStoreErrorKind;

  constructor(kind: ResultStoreErrorKind, message: string, options: { cause?: unknown } = {}) {
    super(message, { cause: options.cause });
    this.name = 'ResultStoreError';
    this.kind = kind;
  }
}

/** The two files that make up a Result. */
export interface ResultBundleInput {
  /**
   * Canonical transcript. Written as UTF-8 with no BOM and with no trailing
   * newline appended — the bytes on disk are exactly the canonical string's
   * bytes, because that is what the transcript SHA-256 was computed over.
   */
  transcriptText: string;
  /** Serialized `result.json` bytes. Written last. */
  resultJson: Uint8Array;
}

export interface StoredResult {
  resultId: string;
  resultDir: string;
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

export class LocalResultStore {
  /** Absolute path of the results root, e.g. `<project>/data/results`. */
  readonly rootDir: string;

  constructor(rootDir: string) {
    this.rootDir = path.resolve(rootDir);
  }

  /**
   * Resolve a Result directory, refusing anything that is not a
   * server-generated result ID or that resolves outside the results root.
   *
   * Both checks are kept: the pattern rejects the obvious traversal attempts,
   * and the containment check is the backstop that does not depend on the
   * pattern being exhaustive.
   */
  resolveResultDir(resultId: string): string {
    if (!isValidResultId(resultId)) {
      throw new ResultStoreError(
        'INVALID_RESULT_ID',
        `result id の形式が不正です: ${JSON.stringify(resultId)}`,
      );
    }

    const resolved = path.resolve(this.rootDir, resultId);
    const withSeparator = this.rootDir.endsWith(path.sep) ? this.rootDir : this.rootDir + path.sep;
    if (!resolved.startsWith(withSeparator)) {
      throw new ResultStoreError(
        'RESULT_PATH_ESCAPES_ROOT',
        `result id が results root の外を指しています: ${resultId}`,
      );
    }

    return resolved;
  }

  /** Absolute path of one file inside a Result, with the same safety checks. */
  resolveResultFile(
    resultId: string,
    fileName: typeof TRANSCRIPT_FILE | typeof RESULT_FILE,
  ): string {
    return path.join(this.resolveResultDir(resultId), fileName);
  }

  async hasResult(resultId: string): Promise<boolean> {
    return pathExists(this.resolveResultDir(resultId));
  }

  /**
   * Write a Result transactionally.
   *
   * On success the Result directory exists with both files. On any failure the
   * temp directory is removed and no directory appears under `resultId`.
   */
  async saveResult(resultId: string, bundle: ResultBundleInput): Promise<StoredResult> {
    const resultDir = this.resolveResultDir(resultId);

    await mkdir(this.rootDir, { recursive: true });

    if (await pathExists(resultDir)) {
      throw new ResultStoreError(
        'RESULT_ALREADY_EXISTS',
        `Result ${resultId} は既に存在します。Result は上書きされません。`,
      );
    }

    // Sibling of the final directory, so the commit below is an atomic rename
    // rather than a cross-device copy.
    const tempDir = await mkdtemp(path.join(this.rootDir, '.tmp-'));

    try {
      // result.json is written last: while it is absent the bundle is visibly
      // incomplete, and it can only describe a transcript that already exists.
      await writeFile(
        path.join(tempDir, TRANSCRIPT_FILE),
        Buffer.from(bundle.transcriptText, 'utf8'),
      );
      await writeFile(path.join(tempDir, RESULT_FILE), bundle.resultJson);

      await rename(tempDir, resultDir);
    } catch (cause) {
      await rm(tempDir, { recursive: true, force: true }).catch(() => {});
      if (cause instanceof ResultStoreError) throw cause;
      throw new ResultStoreError(
        'RESULT_WRITE_FAILED',
        `Result ${resultId} の書き込みに失敗しました: ${cause instanceof Error ? cause.message : String(cause)}`,
        { cause },
      );
    }

    return { resultId, resultDir };
  }

  /** Result IDs currently on disk, oldest first. Temp directories are skipped. */
  async listResultIds(): Promise<string[]> {
    const entries = await readdir(this.rootDir).catch(() => [] as string[]);
    return entries.filter((entry) => isValidResultId(entry)).sort();
  }

  /** Read one stored `result.json`. */
  async readResult(resultId: string): Promise<unknown> {
    const file = this.resolveResultFile(resultId, RESULT_FILE);
    let text: string;
    try {
      text = await readFile(file, 'utf8');
    } catch (cause) {
      throw new ResultStoreError('RESULT_NOT_FOUND', `Result ${resultId} が見つかりません。`, {
        cause,
      });
    }
    try {
      return JSON.parse(text) as unknown;
    } catch (cause) {
      throw new ResultStoreError(
        'RESULT_UNREADABLE',
        `Result ${resultId} の result.json が JSON として解釈できません。`,
        { cause },
      );
    }
  }

  /** Read one stored transcript. */
  async readTranscript(resultId: string): Promise<string> {
    const file = this.resolveResultFile(resultId, TRANSCRIPT_FILE);
    try {
      return await readFile(file, 'utf8');
    } catch (cause) {
      throw new ResultStoreError(
        'RESULT_NOT_FOUND',
        `Result ${resultId} の transcript が見つかりません。`,
        { cause },
      );
    }
  }
}
