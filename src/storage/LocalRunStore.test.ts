import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Failure injection for the transaction tests. Hoisted so the module factory
// below can see it; both hooks default to pass-through.
const hooks = vi.hoisted(() => ({
  failRename: false,
  failWriteEndingWith: null as string | null,
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    rename: async (from: Parameters<typeof actual.rename>[0], to: Parameters<typeof actual.rename>[1]) => {
      if (hooks.failRename) throw new Error('simulated rename failure');
      return actual.rename(from, to);
    },
    writeFile: async (
      file: Parameters<typeof actual.writeFile>[0],
      data: Parameters<typeof actual.writeFile>[1],
    ) => {
      if (hooks.failWriteEndingWith && String(file).endsWith(hooks.failWriteEndingWith)) {
        throw new Error(`simulated write failure for ${hooks.failWriteEndingWith}`);
      }
      return actual.writeFile(file, data);
    },
  };
});

const {
  AUDIO_FILE,
  LocalRunStore,
  MANIFEST_FILE,
  PROVIDER_QUERY_FILE,
  RunStoreError,
  SOURCE_FILE,
} = await import('./LocalRunStore');

const RUN_ID = '20260906T011343123Z-aabbccdd';
const OTHER_RUN_ID = '20260906T011344000Z-11223344';

function bundle(overrides: Partial<Parameters<InstanceType<typeof LocalRunStore>['saveRun']>[1]> = {}) {
  return {
    sourceText: 'これはテストです。\n二行目',
    audio: new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x41, 0x56, 0x45]),
    providerQueryJson: Buffer.from('{"speedScale":1}\n', 'utf8'),
    manifestJson: Buffer.from('{"schema_version":1}\n', 'utf8'),
    ...overrides,
  };
}

let root: string;

beforeEach(async () => {
  hooks.failRename = false;
  hooks.failWriteEndingWith = null;
  root = await mkdtemp(path.join(tmpdir(), 'vib-runs-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** Temp directories the store creates are named `.tmp-*` under the runs root. */
async function leftoverTempDirs(rootDir: string): Promise<string[]> {
  const entries = await readdir(rootDir).catch(() => [] as string[]);
  return entries.filter((entry) => entry.startsWith('.tmp-'));
}

describe('saveRun', () => {
  it('writes the four-file Run Bundle and leaves no temp directory', async () => {
    const store = new LocalRunStore(root);
    const stored = await store.saveRun(RUN_ID, bundle());

    expect(stored.runId).toBe(RUN_ID);
    expect(stored.runDir).toBe(path.join(root, RUN_ID));

    const entries = await readdir(stored.runDir);
    expect(entries.sort()).toEqual(
      [SOURCE_FILE, AUDIO_FILE, PROVIDER_QUERY_FILE, MANIFEST_FILE].sort(),
    );
    expect(await leftoverTempDirs(root)).toEqual([]);
  });

  it('writes source.txt as UTF-8 with no BOM and no appended newline', async () => {
    const store = new LocalRunStore(root);
    const sourceText = '  先頭に空白\nそして\t末尾に空白  ';
    await store.saveRun(RUN_ID, bundle({ sourceText }));

    const bytes = await readFile(path.join(root, RUN_ID, SOURCE_FILE));
    expect(bytes.equals(Buffer.from(sourceText, 'utf8'))).toBe(true);
    expect(bytes[0]).not.toBe(0xef); // no UTF-8 BOM
    expect(bytes.toString('utf8')).toBe(sourceText);
    expect(bytes.toString('utf8').endsWith('  ')).toBe(true);
  });

  it('writes audio.wav as the exact provider bytes', async () => {
    const store = new LocalRunStore(root);
    const audio = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x2a, 0x00, 0xff, 0x7f]);
    await store.saveRun(RUN_ID, bundle({ audio }));

    const bytes = await readFile(path.join(root, RUN_ID, AUDIO_FILE));
    expect(new Uint8Array(bytes)).toEqual(audio);
  });

  it('creates the runs root when it does not exist yet', async () => {
    const nested = path.join(root, 'deeper', 'runs');
    const store = new LocalRunStore(nested);
    await store.saveRun(RUN_ID, bundle());
    expect(await readdir(path.join(nested, RUN_ID))).toHaveLength(4);
  });

  it('refuses to overwrite an existing Run', async () => {
    const store = new LocalRunStore(root);
    await store.saveRun(RUN_ID, bundle({ sourceText: 'first' }));

    await expect(store.saveRun(RUN_ID, bundle({ sourceText: 'second' }))).rejects.toMatchObject({
      kind: 'RUN_ALREADY_EXISTS',
    });

    // The original Run is untouched.
    const bytes = await readFile(path.join(root, RUN_ID, SOURCE_FILE));
    expect(bytes.toString('utf8')).toBe('first');
    expect(await leftoverTempDirs(root)).toEqual([]);
  });

  it('keeps separate Runs side by side', async () => {
    const store = new LocalRunStore(root);
    await store.saveRun(RUN_ID, bundle({ sourceText: 'one' }));
    await store.saveRun(OTHER_RUN_ID, bundle({ sourceText: 'two' }));

    expect((await readdir(root)).sort()).toEqual([RUN_ID, OTHER_RUN_ID].sort());
  });

  it('leaves no official Run and no temp directory when a file write fails', async () => {
    hooks.failWriteEndingWith = AUDIO_FILE;
    const store = new LocalRunStore(root);

    await expect(store.saveRun(RUN_ID, bundle())).rejects.toMatchObject({ kind: 'WRITE_FAILED' });

    expect(await readdir(root)).toEqual([]);
    expect(await leftoverTempDirs(root)).toEqual([]);
  });

  it('leaves no official Run and no temp directory when the commit rename fails', async () => {
    hooks.failRename = true;
    const store = new LocalRunStore(root);

    await expect(store.saveRun(RUN_ID, bundle())).rejects.toMatchObject({ kind: 'WRITE_FAILED' });

    expect(await readdir(root)).toEqual([]);
    expect(await leftoverTempDirs(root)).toEqual([]);
  });

  it('rejects an invalid run id before touching the filesystem', async () => {
    const store = new LocalRunStore(root);
    await expect(store.saveRun('../escape', bundle())).rejects.toMatchObject({
      kind: 'INVALID_RUN_ID',
    });
    expect(await readdir(root)).toEqual([]);
  });
});

describe('resolveRunDir / resolveRunFile', () => {
  const store = new LocalRunStore(path.join(tmpdir(), 'vib-resolve-root'));

  it('resolves a valid run id inside the runs root', () => {
    const resolved = store.resolveRunDir(RUN_ID);
    expect(resolved).toBe(path.join(store.rootDir, RUN_ID));
    expect(resolved.startsWith(store.rootDir + path.sep)).toBe(true);
  });

  it('resolves each bundle file inside the Run directory', () => {
    expect(store.resolveRunFile(RUN_ID, AUDIO_FILE)).toBe(
      path.join(store.rootDir, RUN_ID, AUDIO_FILE),
    );
  });

  const TRAVERSAL: Array<[string, string]> = [
    ['parent segment', '..'],
    ['relative traversal', '../../etc/passwd'],
    ['windows traversal', '..\\..\\Windows\\System32'],
    ['embedded traversal', `${RUN_ID}/../../secret`],
    ['absolute posix path', '/etc/passwd'],
    ['absolute windows path', 'C:\\Windows\\System32'],
    ['url encoded traversal', '%2e%2e%2fsecret'],
    ['null byte', `${RUN_ID}\u0000`],
    ['empty', ''],
  ];

  for (const [label, value] of TRAVERSAL) {
    it(`rejects ${label}`, () => {
      expect(() => store.resolveRunDir(value)).toThrow(RunStoreError);
      expect(() => store.resolveRunDir(value)).toThrowError(/run id/);
    });
  }
});

describe('hasRun', () => {
  it('reports false for a missing Run and true once stored', async () => {
    const store = new LocalRunStore(root);
    expect(await store.hasRun(RUN_ID)).toBe(false);
    await store.saveRun(RUN_ID, bundle());
    expect(await store.hasRun(RUN_ID)).toBe(true);
  });

  it('does not treat an unrelated sibling file as a Run', async () => {
    const store = new LocalRunStore(root);
    await writeFile(path.join(root, 'notes.txt'), 'x');
    expect(await store.hasRun(RUN_ID)).toBe(false);
  });
});
