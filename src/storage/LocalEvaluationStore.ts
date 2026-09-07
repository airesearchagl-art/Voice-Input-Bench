import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { isValidEvaluationId } from '@/lib/evaluationId';

/**
 * Local, immutable storage for raw character Evaluations.
 *
 * Same transaction shape as the Run, Result and Session stores, in its own
 * root:
 *
 *   data/evaluations/
 *   ├─ .tmp-<random>/            ← written here first, removed on any failure
 *   └─ <evaluation-id>/          ← appears atomically, never modified afterwards
 *      └─ evaluation.json
 *
 * An Evaluation is written once. There is no edit and no delete: it records
 * what raw-char-v1 said about one exact pair of texts, and a rewritten number
 * would be indistinguishable from a measured one.
 *
 * Runs, Results and Sessions are never written through this class.
 */

export const EVALUATION_FILE = 'evaluation.json';

export type EvaluationStoreErrorKind =
  /** An Evaluation directory with this ID already exists; never overwritten. */
  | 'EVALUATION_ALREADY_EXISTS'
  /** The evaluation ID does not match the server-generated pattern. */
  | 'INVALID_EVALUATION_ID'
  /** The resolved path escaped the evaluations root. */
  | 'EVALUATION_PATH_ESCAPES_ROOT'
  /** No Evaluation directory with this ID. */
  | 'EVALUATION_NOT_FOUND'
  /** Writing the Evaluation failed; the temp directory has been removed. */
  | 'EVALUATION_WRITE_FAILED'
  /** A stored `evaluation.json` could not be read or parsed. */
  | 'EVALUATION_UNREADABLE';

export class EvaluationStoreError extends Error {
  readonly kind: EvaluationStoreErrorKind;

  constructor(kind: EvaluationStoreErrorKind, message: string, options: { cause?: unknown } = {}) {
    super(message, { cause: options.cause });
    this.name = 'EvaluationStoreError';
    this.kind = kind;
  }
}

export interface StoredEvaluation {
  evaluationId: string;
  evaluationDir: string;
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

export class LocalEvaluationStore {
  /** Absolute path of the evaluations root, e.g. `<project>/data/evaluations`. */
  readonly rootDir: string;

  constructor(rootDir: string) {
    this.rootDir = path.resolve(rootDir);
  }

  /**
   * Resolve an Evaluation directory, refusing anything that is not a
   * server-generated evaluation ID or that resolves outside the root.
   */
  resolveEvaluationDir(evaluationId: string): string {
    if (!isValidEvaluationId(evaluationId)) {
      throw new EvaluationStoreError(
        'INVALID_EVALUATION_ID',
        `evaluation id の形式が不正です: ${JSON.stringify(evaluationId)}`,
      );
    }

    const resolved = path.resolve(this.rootDir, evaluationId);
    const withSeparator = this.rootDir.endsWith(path.sep) ? this.rootDir : this.rootDir + path.sep;
    if (!resolved.startsWith(withSeparator)) {
      throw new EvaluationStoreError(
        'EVALUATION_PATH_ESCAPES_ROOT',
        `evaluation id が evaluations root の外を指しています: ${evaluationId}`,
      );
    }

    return resolved;
  }

  resolveEvaluationFile(evaluationId: string): string {
    return path.join(this.resolveEvaluationDir(evaluationId), EVALUATION_FILE);
  }

  async hasEvaluation(evaluationId: string): Promise<boolean> {
    return pathExists(this.resolveEvaluationDir(evaluationId));
  }

  /**
   * Write an Evaluation transactionally.
   *
   * On success the directory exists with its file. On any failure the temp
   * directory is removed and nothing appears under `evaluationId`.
   */
  async saveEvaluation(
    evaluationId: string,
    evaluationJson: Uint8Array,
  ): Promise<StoredEvaluation> {
    const evaluationDir = this.resolveEvaluationDir(evaluationId);

    await mkdir(this.rootDir, { recursive: true });

    if (await pathExists(evaluationDir)) {
      throw new EvaluationStoreError(
        'EVALUATION_ALREADY_EXISTS',
        `Evaluation ${evaluationId} は既に存在します。Evaluation は上書きされません。`,
      );
    }

    const tempDir = await mkdtemp(path.join(this.rootDir, '.tmp-'));

    try {
      await writeFile(path.join(tempDir, EVALUATION_FILE), evaluationJson);
      await rename(tempDir, evaluationDir);
    } catch (cause) {
      await rm(tempDir, { recursive: true, force: true }).catch(() => {});
      if (cause instanceof EvaluationStoreError) throw cause;
      throw new EvaluationStoreError(
        'EVALUATION_WRITE_FAILED',
        `Evaluation ${evaluationId} の書き込みに失敗しました: ${cause instanceof Error ? cause.message : String(cause)}`,
        { cause },
      );
    }

    return { evaluationId, evaluationDir };
  }

  /** Evaluation IDs currently on disk, oldest first. Temp directories are skipped. */
  async listEvaluationIds(): Promise<string[]> {
    const entries = await readdir(this.rootDir).catch(() => [] as string[]);
    return entries.filter((entry) => isValidEvaluationId(entry)).sort();
  }

  /** Read one stored `evaluation.json`. */
  async readEvaluation(evaluationId: string): Promise<unknown> {
    const file = this.resolveEvaluationFile(evaluationId);
    let text: string;
    try {
      text = await readFile(file, 'utf8');
    } catch (cause) {
      throw new EvaluationStoreError(
        'EVALUATION_NOT_FOUND',
        `Evaluation ${evaluationId} が見つかりません。`,
        { cause },
      );
    }
    try {
      return JSON.parse(text) as unknown;
    } catch (cause) {
      throw new EvaluationStoreError(
        'EVALUATION_UNREADABLE',
        `Evaluation ${evaluationId} の evaluation.json が JSON として解釈できません。`,
        { cause },
      );
    }
  }
}
