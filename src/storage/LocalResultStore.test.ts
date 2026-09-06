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
      if (hooks.failWriteEndingWith && String(file).endsWith(hooks.failWriteEndingWith)) {
        throw new Error(`simulated write failure for ${hooks.failWriteEndingWith}`);
      }
      return actual.writeFile(file, data);
    },
  };
});

const { LocalResultStore, RESULT_FILE, ResultStoreError, TRANSCRIPT_FILE } = await import(
  './LocalResultStore'
);

const RESULT_ID = '20260906T011343123Z-aabbccdd';
const OTHER_RESULT_ID = '20260906T011344000Z-11223344';

function bundle(
  overrides: Partial<Parameters<InstanceType<typeof LocalResultStore>['saveResult']>[1]> = {},
) {
  return {
    transcriptText: 'これは STT の出力です。\n二行目',
    resultJson: Buffer.from('{"schema_version":1}\n', 'utf8'),
    ...overrides,
  };
}

let root: string;

beforeEach(async () => {
  hooks.failRename = false;
  hooks.failWriteEndingWith = null;
  root = await mkdtemp(path.join(tmpdir(), 'vib-results-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function leftoverTempDirs(rootDir: string): Promise<string[]> {
  const entries = await readdir(rootDir).catch(() => [] as string[]);
  return entries.filter((entry) => entry.startsWith('.tmp-'));
}

describe('saveResult', () => {
  it('writes the two-file Result bundle and leaves no temp directory', async () => {
    const store = new LocalResultStore(root);
    const stored = await store.saveResult(RESULT_ID, bundle());

    expect(stored.resultId).toBe(RESULT_ID);
    expect(stored.resultDir).toBe(path.join(root, RESULT_ID));
    expect((await readdir(stored.resultDir)).sort()).toEqual(
      [TRANSCRIPT_FILE, RESULT_FILE].sort(),
    );
    expect(await leftoverTempDirs(root)).toEqual([]);
  });

  it('writes transcript.txt as UTF-8 with no BOM and no appended newline', async () => {
    const store = new LocalResultStore(root);
    const transcriptText = '  先頭に空白\nそして\t末尾に空白  ';
    await store.saveResult(RESULT_ID, bundle({ transcriptText }));

    const bytes = await readFile(path.join(root, RESULT_ID, TRANSCRIPT_FILE));
    expect(bytes.equals(Buffer.from(transcriptText, 'utf8'))).toBe(true);
    expect(bytes[0]).not.toBe(0xef);
    expect(bytes.toString('utf8')).toBe(transcriptText);
    expect(bytes.toString('utf8').endsWith('  ')).toBe(true);
  });

  it('creates the results root when it does not exist yet', async () => {
    const nested = path.join(root, 'deeper', 'results');
    const store = new LocalResultStore(nested);
    await store.saveResult(RESULT_ID, bundle());
    expect(await readdir(path.join(nested, RESULT_ID))).toHaveLength(2);
  });

  it('refuses to overwrite an existing Result', async () => {
    const store = new LocalResultStore(root);
    await store.saveResult(RESULT_ID, bundle({ transcriptText: 'first' }));

    await expect(
      store.saveResult(RESULT_ID, bundle({ transcriptText: 'second' })),
    ).rejects.toMatchObject({ kind: 'RESULT_ALREADY_EXISTS' });

    const bytes = await readFile(path.join(root, RESULT_ID, TRANSCRIPT_FILE));
    expect(bytes.toString('utf8')).toBe('first');
    expect(await leftoverTempDirs(root)).toEqual([]);
  });

  it('keeps separate Results side by side', async () => {
    const store = new LocalResultStore(root);
    await store.saveResult(RESULT_ID, bundle({ transcriptText: 'one' }));
    await store.saveResult(OTHER_RESULT_ID, bundle({ transcriptText: 'two' }));
    expect((await readdir(root)).sort()).toEqual([RESULT_ID, OTHER_RESULT_ID].sort());
  });

  it('leaves no official Result and no temp directory when a file write fails', async () => {
    hooks.failWriteEndingWith = RESULT_FILE;
    const store = new LocalResultStore(root);

    await expect(store.saveResult(RESULT_ID, bundle())).rejects.toMatchObject({
      kind: 'RESULT_WRITE_FAILED',
    });

    expect(await readdir(root)).toEqual([]);
    expect(await leftoverTempDirs(root)).toEqual([]);
  });

  it('leaves no official Result and no temp directory when the commit rename fails', async () => {
    hooks.failRename = true;
    const store = new LocalResultStore(root);

    await expect(store.saveResult(RESULT_ID, bundle())).rejects.toMatchObject({
      kind: 'RESULT_WRITE_FAILED',
    });

    expect(await readdir(root)).toEqual([]);
    expect(await leftoverTempDirs(root)).toEqual([]);
  });

  it('rejects an invalid result id before touching the filesystem', async () => {
    const store = new LocalResultStore(root);
    await expect(store.saveResult('../escape', bundle())).rejects.toMatchObject({
      kind: 'INVALID_RESULT_ID',
    });
    expect(await readdir(root)).toEqual([]);
  });
});

describe('resolveResultDir / resolveResultFile', () => {
  const store = new LocalResultStore(path.join(tmpdir(), 'vib-results-resolve'));

  it('resolves a valid result id inside the results root', () => {
    const resolved = store.resolveResultDir(RESULT_ID);
    expect(resolved).toBe(path.join(store.rootDir, RESULT_ID));
    expect(resolved.startsWith(store.rootDir + path.sep)).toBe(true);
  });

  it('resolves each bundle file inside the Result directory', () => {
    expect(store.resolveResultFile(RESULT_ID, TRANSCRIPT_FILE)).toBe(
      path.join(store.rootDir, RESULT_ID, TRANSCRIPT_FILE),
    );
  });

  const TRAVERSAL: Array<[string, string]> = [
    ['parent segment', '..'],
    ['relative traversal', '../../etc/passwd'],
    ['windows traversal', '..\\..\\Windows\\System32'],
    ['embedded traversal', `${RESULT_ID}/../../secret`],
    ['escape into the runs root', '../runs/20260906T011343123Z-aabbccdd'],
    ['absolute posix path', '/etc/passwd'],
    ['absolute windows path', 'C:\\Windows\\System32'],
    ['url encoded traversal', '%2e%2e%2fsecret'],
    ['null byte', `${RESULT_ID}\u0000`],
    ['empty', ''],
  ];

  for (const [label, value] of TRAVERSAL) {
    it(`rejects ${label}`, () => {
      expect(() => store.resolveResultDir(value)).toThrow(ResultStoreError);
      expect(() => store.resolveResultDir(value)).toThrowError(/result id/);
    });
  }
});

describe('reading Results back', () => {
  it('reports false for a missing Result and true once stored', async () => {
    const store = new LocalResultStore(root);
    expect(await store.hasResult(RESULT_ID)).toBe(false);
    await store.saveResult(RESULT_ID, bundle());
    expect(await store.hasResult(RESULT_ID)).toBe(true);
  });

  it('lists only server-generated result IDs, oldest first', async () => {
    const store = new LocalResultStore(root);
    await store.saveResult(OTHER_RESULT_ID, bundle());
    await store.saveResult(RESULT_ID, bundle());
    await writeFile(path.join(root, 'notes.txt'), 'x');

    expect(await store.listResultIds()).toEqual([RESULT_ID, OTHER_RESULT_ID]);
  });

  it('returns an empty listing when the root does not exist', async () => {
    const store = new LocalResultStore(path.join(root, 'never-created'));
    expect(await store.listResultIds()).toEqual([]);
  });

  it('reads back result.json and the transcript', async () => {
    const store = new LocalResultStore(root);
    await store.saveResult(RESULT_ID, bundle({ transcriptText: '読み戻し' }));

    expect(await store.readResult(RESULT_ID)).toEqual({ schema_version: 1 });
    expect(await store.readTranscript(RESULT_ID)).toBe('読み戻し');
  });

  it('reports a missing Result rather than returning nothing', async () => {
    const store = new LocalResultStore(root);
    await expect(store.readResult(RESULT_ID)).rejects.toMatchObject({ kind: 'RESULT_NOT_FOUND' });
    await expect(store.readTranscript(RESULT_ID)).rejects.toMatchObject({
      kind: 'RESULT_NOT_FOUND',
    });
  });

  it('reports an unparseable result.json', async () => {
    const store = new LocalResultStore(root);
    await store.saveResult(RESULT_ID, bundle({ resultJson: Buffer.from('not json', 'utf8') }));
    await expect(store.readResult(RESULT_ID)).rejects.toMatchObject({ kind: 'RESULT_UNREADABLE' });
  });
});
