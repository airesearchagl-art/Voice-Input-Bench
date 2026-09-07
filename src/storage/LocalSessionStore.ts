import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { isValidSessionId } from '@/lib/sessionId';

/**
 * Local, immutable storage for Benchmark Sessions.
 *
 * Same transaction shape as the Run and Result stores, in its own root:
 *
 *   data/sessions/
 *   ├─ .tmp-<random>/          ← written here first, removed on any failure
 *   └─ <session-id>/           ← appears atomically, never modified afterwards
 *      └─ session.json
 *
 * A Session is written once. There is no edit and no delete: a Session records
 * which exact Runs an experiment was planned against, and rewriting that after
 * Results have been captured would silently change what the comparison means.
 *
 * Runs and Results are never written through this class.
 */

export const SESSION_FILE = 'session.json';

export type SessionStoreErrorKind =
  /** A Session directory with this ID already exists; Sessions are never overwritten. */
  | 'SESSION_ALREADY_EXISTS'
  /** The session ID does not match the server-generated pattern. */
  | 'INVALID_SESSION_ID'
  /** The resolved path escaped the sessions root. */
  | 'SESSION_PATH_ESCAPES_ROOT'
  /** No Session directory with this ID. */
  | 'SESSION_NOT_FOUND'
  /** Writing the Session failed; the temp directory has been removed. */
  | 'SESSION_WRITE_FAILED'
  /** A stored `session.json` could not be read or parsed. */
  | 'SESSION_UNREADABLE';

export class SessionStoreError extends Error {
  readonly kind: SessionStoreErrorKind;

  constructor(kind: SessionStoreErrorKind, message: string, options: { cause?: unknown } = {}) {
    super(message, { cause: options.cause });
    this.name = 'SessionStoreError';
    this.kind = kind;
  }
}

export interface StoredSession {
  sessionId: string;
  sessionDir: string;
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

export class LocalSessionStore {
  /** Absolute path of the sessions root, e.g. `<project>/data/sessions`. */
  readonly rootDir: string;

  constructor(rootDir: string) {
    this.rootDir = path.resolve(rootDir);
  }

  /**
   * Resolve a Session directory, refusing anything that is not a
   * server-generated session ID or that resolves outside the sessions root.
   */
  resolveSessionDir(sessionId: string): string {
    if (!isValidSessionId(sessionId)) {
      throw new SessionStoreError(
        'INVALID_SESSION_ID',
        `session id の形式が不正です: ${JSON.stringify(sessionId)}`,
      );
    }

    const resolved = path.resolve(this.rootDir, sessionId);
    const withSeparator = this.rootDir.endsWith(path.sep) ? this.rootDir : this.rootDir + path.sep;
    if (!resolved.startsWith(withSeparator)) {
      throw new SessionStoreError(
        'SESSION_PATH_ESCAPES_ROOT',
        `session id が sessions root の外を指しています: ${sessionId}`,
      );
    }

    return resolved;
  }

  resolveSessionFile(sessionId: string): string {
    return path.join(this.resolveSessionDir(sessionId), SESSION_FILE);
  }

  async hasSession(sessionId: string): Promise<boolean> {
    return pathExists(this.resolveSessionDir(sessionId));
  }

  /**
   * Write a Session transactionally.
   *
   * On success the Session directory exists with its file. On any failure the
   * temp directory is removed and no directory appears under `sessionId`.
   */
  async saveSession(sessionId: string, sessionJson: Uint8Array): Promise<StoredSession> {
    const sessionDir = this.resolveSessionDir(sessionId);

    await mkdir(this.rootDir, { recursive: true });

    if (await pathExists(sessionDir)) {
      throw new SessionStoreError(
        'SESSION_ALREADY_EXISTS',
        `Session ${sessionId} は既に存在します。Session は上書きされません。`,
      );
    }

    const tempDir = await mkdtemp(path.join(this.rootDir, '.tmp-'));

    try {
      await writeFile(path.join(tempDir, SESSION_FILE), sessionJson);
      await rename(tempDir, sessionDir);
    } catch (cause) {
      await rm(tempDir, { recursive: true, force: true }).catch(() => {});
      if (cause instanceof SessionStoreError) throw cause;
      throw new SessionStoreError(
        'SESSION_WRITE_FAILED',
        `Session ${sessionId} の書き込みに失敗しました: ${cause instanceof Error ? cause.message : String(cause)}`,
        { cause },
      );
    }

    return { sessionId, sessionDir };
  }

  /** Session IDs currently on disk, oldest first. Temp directories are skipped. */
  async listSessionIds(): Promise<string[]> {
    const entries = await readdir(this.rootDir).catch(() => [] as string[]);
    return entries.filter((entry) => isValidSessionId(entry)).sort();
  }

  /** Read one stored `session.json`. */
  async readSession(sessionId: string): Promise<unknown> {
    const file = this.resolveSessionFile(sessionId);
    let text: string;
    try {
      text = await readFile(file, 'utf8');
    } catch (cause) {
      throw new SessionStoreError('SESSION_NOT_FOUND', `Session ${sessionId} が見つかりません。`, {
        cause,
      });
    }
    try {
      return JSON.parse(text) as unknown;
    } catch (cause) {
      throw new SessionStoreError(
        'SESSION_UNREADABLE',
        `Session ${sessionId} の session.json が JSON として解釈できません。`,
        { cause },
      );
    }
  }
}
