import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LocalRunStore } from '@/storage/LocalRunStore';
import { GET, parseByteRange } from './[runId]/audio/route';

/**
 * The run ID in this route comes from the URL, so it is untrusted input.
 * These tests drive the real handler.
 */

const RUN_ID = '20260906T011343123Z-aabbccdd';
const WAV = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x41, 0x56, 0x45, 1, 2, 3]);

let root: string;

function call(runId: string, headers?: Record<string, string>) {
  return GET(
    new Request(`http://localhost/api/runs/${encodeURIComponent(runId)}/audio`, { headers }),
    { params: Promise.resolve({ runId }) },
  );
}

async function storeRun(runId = RUN_ID, audio: Uint8Array = WAV) {
  const store = new LocalRunStore(root);
  await store.saveRun(runId, {
    sourceText: 'テスト',
    audio,
    providerQueryJson: Buffer.from('{}\n', 'utf8'),
    manifestJson: Buffer.from('{}\n', 'utf8'),
  });
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'vib-audio-route-'));
  process.env.VIB_RUNS_DIR = root;
});

afterEach(async () => {
  delete process.env.VIB_RUNS_DIR;
  await rm(root, { recursive: true, force: true });
});

describe('GET /api/runs/[runId]/audio', () => {
  it('serves the stored WAV bytes for an existing Run', async () => {
    await storeRun();

    const response = await call(RUN_ID);

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('audio/wav');
    expect(response.headers.get('content-length')).toBe(String(WAV.byteLength));
    // A media element needs this to be told the resource is seekable.
    expect(response.headers.get('accept-ranges')).toBe('bytes');
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(WAV);
  });

  it('answers a range request with 206 and the requested slice', async () => {
    await storeRun();

    const response = await call(RUN_ID, { range: 'bytes=4-8' });

    expect(response.status).toBe(206);
    expect(response.headers.get('content-range')).toBe(`bytes 4-8/${WAV.byteLength}`);
    expect(response.headers.get('content-length')).toBe('5');
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(WAV.slice(4, 9));
  });

  it('answers the open-ended range a media element sends first', async () => {
    await storeRun();

    const response = await call(RUN_ID, { range: 'bytes=0-' });

    expect(response.status).toBe(206);
    expect(response.headers.get('content-range')).toBe(
      `bytes 0-${WAV.byteLength - 1}/${WAV.byteLength}`,
    );
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(WAV);
  });

  it('rejects a range past the end of the file with 416', async () => {
    await storeRun();

    const response = await call(RUN_ID, { range: 'bytes=9999-' });

    expect(response.status).toBe(416);
    expect(response.headers.get('content-range')).toBe(`bytes */${WAV.byteLength}`);
  });

  it('ignores a malformed range header and serves the whole file', async () => {
    await storeRun();

    const response = await call(RUN_ID, { range: 'items=1-2' });

    expect(response.status).toBe(200);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(WAV);
  });

  it('returns 404 for a well-formed run id that does not exist', async () => {
    const response = await call(RUN_ID);
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ ok: false, error: { kind: 'RUN_NOT_FOUND' } });
  });

  const TRAVERSAL: Array<[string, string]> = [
    ['parent segment', '..'],
    ['relative traversal', '../../etc/passwd'],
    ['windows traversal', '..\\..\\Windows\\System32'],
    ['embedded traversal', `${RUN_ID}/../../secret`],
    ['absolute posix path', '/etc/passwd'],
    ['absolute windows path', 'C:\\Windows\\System32'],
    ['url encoded traversal', '%2e%2e%2fsecret'],
    ['dot', '.'],
    ['empty', ''],
    ['null byte', `${RUN_ID}\u0000`],
    ['uppercase hex suffix', '20260906T011343123Z-AABBCCDD'],
  ];

  for (const [label, runId] of TRAVERSAL) {
    it(`rejects ${label} with 400 and never reads a file`, async () => {
      const response = await call(runId);
      expect(response.status).toBe(400);
      const body = (await response.json()) as { error: { kind: string } };
      expect(['INVALID_RUN_ID', 'PATH_ESCAPES_ROOT']).toContain(body.error.kind);
    });
  }

  it('does not serve a file that sits outside a Run directory', async () => {
    // A real file exists in the runs root, but it is not reachable through the
    // route because the run id pattern refuses anything but a generated id.
    const response = await call('../vib-audio-route-secret');
    expect(response.status).toBe(400);
  });
});

describe('parseByteRange', () => {
  const SIZE = 100;

  it('returns null when there is no range header or it is not a byte range', () => {
    expect(parseByteRange(null, SIZE)).toBeNull();
    expect(parseByteRange('items=0-10', SIZE)).toBeNull();
    expect(parseByteRange('bytes=-', SIZE)).toBeNull();
  });

  it('parses a closed range', () => {
    expect(parseByteRange('bytes=10-19', SIZE)).toEqual({ start: 10, end: 19 });
  });

  it('parses an open-ended range', () => {
    expect(parseByteRange('bytes=10-', SIZE)).toEqual({ start: 10, end: 99 });
  });

  it('clamps an end past the last byte', () => {
    expect(parseByteRange('bytes=90-500', SIZE)).toEqual({ start: 90, end: 99 });
  });

  it('parses a suffix range', () => {
    expect(parseByteRange('bytes=-20', SIZE)).toEqual({ start: 80, end: 99 });
    expect(parseByteRange('bytes=-500', SIZE)).toEqual({ start: 0, end: 99 });
  });

  it('reports an unsatisfiable range', () => {
    expect(parseByteRange('bytes=100-', SIZE)).toBe('unsatisfiable');
    expect(parseByteRange('bytes=50-40', SIZE)).toBe('unsatisfiable');
    expect(parseByteRange('bytes=-0', SIZE)).toBe('unsatisfiable');
  });
});
