import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const hooks = vi.hoisted(() => ({
  failRename: false,
  failWrite: false,
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    rename: async (
      from: Parameters<typeof actual.rename>[0],
      to: Parameters<typeof actual.rename>[1],
    ) => {
      if (hooks.failRename) throw new Error('simulated rename failure');
      return actual.rename(from, to);
    },
    writeFile: async (
      file: Parameters<typeof actual.writeFile>[0],
      data: Parameters<typeof actual.writeFile>[1],
    ) => {
      if (hooks.failWrite) throw new Error('simulated write failure');
      return actual.writeFile(file, data);
    },
  };
});

const { LocalSessionStore, SESSION_FILE, SessionStoreError } = await import('./LocalSessionStore');

const SESSION_ID = '20260907T010000000Z-aabbccdd';
const OTHER_SESSION_ID = '20260907T010001000Z-11223344';

const BODY = Buffer.from('{"schema_version":1}\n', 'utf8');

let root: string;

beforeEach(async () => {
  hooks.failRename = false;
  hooks.failWrite = false;
  root = await mkdtemp(path.join(tmpdir(), 'vib-sessions-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function leftoverTempDirs(rootDir: string): Promise<string[]> {
  const entries = await readdir(rootDir).catch(() => [] as string[]);
  return entries.filter((entry) => entry.startsWith('.tmp-'));
}

describe('saveSession', () => {
  it('writes session.json and leaves no temp directory', async () => {
    const store = new LocalSessionStore(root);
    const stored = await store.saveSession(SESSION_ID, BODY);

    expect(stored.sessionId).toBe(SESSION_ID);
    expect(await readdir(stored.sessionDir)).toEqual([SESSION_FILE]);
    expect(await leftoverTempDirs(root)).toEqual([]);
  });

  it('creates the sessions root when it does not exist yet', async () => {
    const nested = path.join(root, 'deeper', 'sessions');
    await new LocalSessionStore(nested).saveSession(SESSION_ID, BODY);
    expect(await readdir(path.join(nested, SESSION_ID))).toEqual([SESSION_FILE]);
  });

  it('refuses to overwrite an existing Session', async () => {
    const store = new LocalSessionStore(root);
    await store.saveSession(SESSION_ID, Buffer.from('{"name":"first"}\n', 'utf8'));

    await expect(
      store.saveSession(SESSION_ID, Buffer.from('{"name":"second"}\n', 'utf8')),
    ).rejects.toMatchObject({ kind: 'SESSION_ALREADY_EXISTS' });

    const bytes = await readFile(path.join(root, SESSION_ID, SESSION_FILE), 'utf8');
    expect(bytes).toContain('first');
    expect(await leftoverTempDirs(root)).toEqual([]);
  });

  it('keeps separate Sessions side by side', async () => {
    const store = new LocalSessionStore(root);
    await store.saveSession(SESSION_ID, BODY);
    await store.saveSession(OTHER_SESSION_ID, BODY);
    expect((await readdir(root)).sort()).toEqual([SESSION_ID, OTHER_SESSION_ID].sort());
  });

  it('leaves no official Session and no temp directory when the write fails', async () => {
    hooks.failWrite = true;
    const store = new LocalSessionStore(root);

    await expect(store.saveSession(SESSION_ID, BODY)).rejects.toMatchObject({
      kind: 'SESSION_WRITE_FAILED',
    });

    expect(await readdir(root)).toEqual([]);
    expect(await leftoverTempDirs(root)).toEqual([]);
  });

  it('leaves no official Session and no temp directory when the commit rename fails', async () => {
    hooks.failRename = true;
    const store = new LocalSessionStore(root);

    await expect(store.saveSession(SESSION_ID, BODY)).rejects.toMatchObject({
      kind: 'SESSION_WRITE_FAILED',
    });

    expect(await readdir(root)).toEqual([]);
    expect(await leftoverTempDirs(root)).toEqual([]);
  });

  it('rejects an invalid session id before touching the filesystem', async () => {
    const store = new LocalSessionStore(root);
    await expect(store.saveSession('../escape', BODY)).rejects.toMatchObject({
      kind: 'INVALID_SESSION_ID',
    });
    expect(await readdir(root)).toEqual([]);
  });
});

describe('resolveSessionDir', () => {
  const store = new LocalSessionStore(path.join(tmpdir(), 'vib-sessions-resolve'));

  it('resolves a valid session id inside the sessions root', () => {
    const resolved = store.resolveSessionDir(SESSION_ID);
    expect(resolved).toBe(path.join(store.rootDir, SESSION_ID));
    expect(resolved.startsWith(store.rootDir + path.sep)).toBe(true);
  });

  const TRAVERSAL: Array<[string, string]> = [
    ['parent segment', '..'],
    ['relative traversal', '../../etc/passwd'],
    ['windows traversal', '..\\..\\Windows\\System32'],
    ['embedded traversal', `${SESSION_ID}/../../secret`],
    ['escape into the runs root', '../runs/20260907T010000000Z-aabbccdd'],
    ['escape into the results root', '../results/20260907T010000000Z-aabbccdd'],
    ['absolute posix path', '/etc/passwd'],
    ['absolute windows path', 'C:\\Windows\\System32'],
    ['url encoded traversal', '%2e%2e%2fsecret'],
    ['null byte', `${SESSION_ID}\u0000`],
    ['empty', ''],
  ];

  for (const [label, value] of TRAVERSAL) {
    it(`rejects ${label}`, () => {
      expect(() => store.resolveSessionDir(value)).toThrow(SessionStoreError);
      expect(() => store.resolveSessionDir(value)).toThrowError(/session id/);
    });
  }
});

describe('reading Sessions back', () => {
  it('reports false for a missing Session and true once stored', async () => {
    const store = new LocalSessionStore(root);
    expect(await store.hasSession(SESSION_ID)).toBe(false);
    await store.saveSession(SESSION_ID, BODY);
    expect(await store.hasSession(SESSION_ID)).toBe(true);
  });

  it('lists only server-generated session IDs, oldest first', async () => {
    const store = new LocalSessionStore(root);
    await store.saveSession(OTHER_SESSION_ID, BODY);
    await store.saveSession(SESSION_ID, BODY);
    await writeFile(path.join(root, 'notes.txt'), 'x');

    expect(await store.listSessionIds()).toEqual([SESSION_ID, OTHER_SESSION_ID]);
  });

  it('returns an empty listing when the root does not exist', async () => {
    const store = new LocalSessionStore(path.join(root, 'never-created'));
    expect(await store.listSessionIds()).toEqual([]);
  });

  it('reads back session.json', async () => {
    const store = new LocalSessionStore(root);
    await store.saveSession(SESSION_ID, BODY);
    expect(await store.readSession(SESSION_ID)).toEqual({ schema_version: 1 });
  });

  it('reports a missing Session rather than returning nothing', async () => {
    const store = new LocalSessionStore(root);
    await expect(store.readSession(SESSION_ID)).rejects.toMatchObject({
      kind: 'SESSION_NOT_FOUND',
    });
  });

  it('reports an unparseable session.json', async () => {
    const store = new LocalSessionStore(root);
    await store.saveSession(SESSION_ID, Buffer.from('not json', 'utf8'));
    await expect(store.readSession(SESSION_ID)).rejects.toMatchObject({
      kind: 'SESSION_UNREADABLE',
    });
  });
});
