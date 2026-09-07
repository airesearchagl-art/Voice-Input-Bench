import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LocalRunStore } from '@/storage/LocalRunStore';
import { GET as getSessions, POST as postSession } from './sessions/route';
import { GET as getSession } from './sessions/[sessionId]/route';
import { POST as postResult } from './results/route';

/**
 * HTTP-boundary checks for Benchmark Sessions. No AivisSpeech Engine is
 * contacted; Runs are written directly with the Phase 1 store.
 */

const SHORT_RUN = '20260907T010000000Z-aaaaaaaa';
const NUMBERS_RUN = '20260907T010001000Z-bbbbbbbb';
const SHORT_RUN_REGENERATED = '20260907T010003000Z-dddddddd';
const NOW = '2026-09-07T02:00:00.000Z';

const PROVIDER_QUERY = Buffer.from('{"schema_version":1,"segments":[]}\n', 'utf8');

function sha(bytes: Uint8Array | string): string {
  return createHash('sha256')
    .update(typeof bytes === 'string' ? Buffer.from(bytes, 'utf8') : bytes)
    .digest('hex');
}

interface RunSpec {
  runId: string;
  testId: string;
  seed: number;
  schemaVersion?: number;
}

const SPECS: Record<string, RunSpec> = {
  [SHORT_RUN]: { runId: SHORT_RUN, testId: 'architecture-short-001', seed: 1 },
  [NUMBERS_RUN]: { runId: NUMBERS_RUN, testId: 'numbers-units-001', seed: 2 },
  [SHORT_RUN_REGENERATED]: {
    runId: SHORT_RUN_REGENERATED,
    testId: 'architecture-short-001',
    seed: 4,
  },
};

const sourceFor = (spec: RunSpec) => `${spec.testId} の本文（seed ${spec.seed}）`;

function audioFor(spec: RunSpec): Uint8Array {
  const bytes = new Uint8Array(16);
  bytes.set([0x52, 0x49, 0x46, 0x46], 0);
  bytes.set([0x57, 0x41, 0x56, 0x45], 8);
  bytes[12] = spec.seed;
  return bytes;
}

function manifestFor(spec: RunSpec): Record<string, unknown> {
  return {
    schema_version: spec.schemaVersion ?? 2,
    run_id: spec.runId,
    test_id: spec.testId,
    generated_at: NOW,
    source: {
      file: 'source.txt',
      encoding: 'utf-8',
      line_endings: 'lf',
      sha256: sha(sourceFor(spec)),
    },
    provider: {
      id: 'aivisspeech',
      engine_name: 'AivisSpeech',
      engine_version: '1.1.0-dev',
      engine_url: 'http://127.0.0.1:10101',
    },
    model: { uuid: 'm', name: 'まお', version: '1.2.0' },
    voice: { speaker_uuid: 's', speaker_name: 'まお', style_id: 1, style_name: 'ノーマル' },
    settings: { speed_scale: 1, volume_scale: 1, sample_rate: 44100, stereo: false },
    segmentation: { strategy: 'none', target_max_chars: 450, segment_count: 1 },
    provider_query: { file: 'provider-query.json', sha256: sha(PROVIDER_QUERY) },
    audio: {
      file: 'audio.wav',
      content_type: 'audio/wav',
      sha256: sha(audioFor(spec)),
      bytes: audioFor(spec).byteLength,
    },
    reproducibility: { canonical_artifact: true, bit_exact_regeneration_expected: false },
  };
}

let runsRoot: string;
let resultsRoot: string;
let sessionsRoot: string;

async function writeRun(runId: string, schemaVersion?: number): Promise<void> {
  const spec = { ...SPECS[runId]!, ...(schemaVersion ? { schemaVersion } : {}) };
  await new LocalRunStore(runsRoot).saveRun(spec.runId, {
    sourceText: sourceFor(spec),
    audio: audioFor(spec),
    providerQueryJson: PROVIDER_QUERY,
    manifestJson: Buffer.from(`${JSON.stringify(manifestFor(spec), null, 2)}\n`, 'utf8'),
  });
}

function postRequest(url: string, body: unknown): Request {
  return new Request(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const BOTH_TOOLS = ['windows-standard-voice-input', 'aqua-voice'];

function sessionBody(runIds: string[], overrides: Record<string, unknown> = {}) {
  return { name: 'route test session', runIds, targetTools: BOTH_TOOLS, ...overrides };
}

async function createSession(runIds: string[], overrides: Record<string, unknown> = {}) {
  const response = await postSession(
    postRequest('http://localhost/api/sessions', sessionBody(runIds, overrides)),
  );
  return { response, body: (await response.clone().json()) as { sessionId?: string } };
}

function getSessionById(sessionId: string) {
  return getSession(new Request(`http://localhost/api/sessions/${sessionId}`), {
    params: Promise.resolve({ sessionId }),
  });
}

beforeEach(async () => {
  runsRoot = await mkdtemp(path.join(tmpdir(), 'vib-sr-runs-'));
  resultsRoot = await mkdtemp(path.join(tmpdir(), 'vib-sr-results-'));
  sessionsRoot = await mkdtemp(path.join(tmpdir(), 'vib-sr-sessions-'));
  process.env.VIB_RUNS_DIR = runsRoot;
  process.env.VIB_RESULTS_DIR = resultsRoot;
  process.env.VIB_SESSIONS_DIR = sessionsRoot;
});

afterEach(async () => {
  delete process.env.VIB_RUNS_DIR;
  delete process.env.VIB_RESULTS_DIR;
  delete process.env.VIB_SESSIONS_DIR;
  for (const root of [runsRoot, resultsRoot, sessionsRoot]) {
    await rm(root, { recursive: true, force: true });
  }
});

describe('POST /api/sessions', () => {
  it('creates a Session from verified Run evidence', async () => {
    await writeRun(SHORT_RUN);
    await writeRun(NUMBERS_RUN);

    const { response, body } = await createSession([SHORT_RUN, NUMBERS_RUN]);
    expect(response.status).toBe(201);

    const full = (await response.json()) as {
      session: { cases: Array<{ test_id: string; audio_sha256: string }> };
    };
    expect(body.sessionId).toMatch(/^\d{8}T\d{9}Z-[0-9a-f]{8}$/);
    expect(full.session.cases.map((entry) => entry.test_id)).toEqual([
      'architecture-short-001',
      'numbers-units-001',
    ]);
    expect(full.session.cases[0]!.audio_sha256).toBe(sha(audioFor(SPECS[SHORT_RUN]!)));
  });

  const BAD_BODIES: Array<[string, unknown]> = [
    ['a non-string name', { name: 42, runIds: [SHORT_RUN], targetTools: BOTH_TOOLS }],
    ['a non-array runIds', { name: 'x', runIds: SHORT_RUN, targetTools: BOTH_TOOLS }],
    ['a non-array targetTools', { name: 'x', runIds: [SHORT_RUN], targetTools: 'aqua-voice' }],
  ];

  for (const [label, body] of BAD_BODIES) {
    it(`rejects ${label}`, async () => {
      await writeRun(SHORT_RUN);
      const response = await postSession(postRequest('http://localhost/api/sessions', body));
      expect(response.status).toBe(400);
    });
  }

  it('rejects a malformed body', async () => {
    const response = await postSession(
      new Request('http://localhost/api/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'not json',
      }),
    );
    expect(response.status).toBe(400);
  });

  it('returns 404 for an unknown Run', async () => {
    const { response } = await createSession([SHORT_RUN]);
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: { kind: 'RUN_NOT_FOUND' } });
  });

  it('returns 409 for a manifest schema v1 Run', async () => {
    await writeRun(SHORT_RUN, 1);
    const { response } = await createSession([SHORT_RUN]);
    expect(response.status).toBe(409);
  });

  it('returns 400 for two Runs of the same Benchmark Case', async () => {
    await writeRun(SHORT_RUN);
    await writeRun(SHORT_RUN_REGENERATED);

    const { response } = await createSession([SHORT_RUN, SHORT_RUN_REGENERATED]);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { kind: 'SESSION_DUPLICATE_TEST_ID' },
    });
  });

  it('returns 400 for an unknown target tool', async () => {
    await writeRun(SHORT_RUN);
    const { response } = await createSession([SHORT_RUN], { targetTools: ['other'] });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { kind: 'SESSION_UNKNOWN_TARGET_TOOL' },
    });
  });

  it('leaves the Run tree untouched', async () => {
    await writeRun(SHORT_RUN);
    const before = (await readdir(path.join(runsRoot, SHORT_RUN))).sort();
    await createSession([SHORT_RUN]);
    expect((await readdir(path.join(runsRoot, SHORT_RUN))).sort()).toEqual(before);
  });
});

describe('GET /api/sessions', () => {
  it('lists verified Sessions', async () => {
    await writeRun(SHORT_RUN);
    await createSession([SHORT_RUN]);

    const body = (await (await getSessions()).json()) as {
      sessions: Array<{ sessionId: string; name: string; caseCount: number }>;
    };
    expect(body.sessions).toHaveLength(1);
    expect(body.sessions[0]).toMatchObject({ name: 'route test session', caseCount: 1 });
  });

  it('omits a Session whose file was hand-edited', async () => {
    await writeRun(SHORT_RUN);
    const { body } = await createSession([SHORT_RUN]);
    const file = path.join(sessionsRoot, body.sessionId!, 'session.json');
    const session = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
    (session.cases as Array<Record<string, unknown>>)[0]!.audio_sha256 = 'f'.repeat(64);
    await writeFile(file, JSON.stringify(session, null, 2));

    const listed = (await (await getSessions()).json()) as { sessions: unknown[] };
    expect(listed.sessions).toEqual([]);
  });

  it('returns an empty list when there are no Sessions', async () => {
    const body = (await (await getSessions()).json()) as { sessions: unknown[] };
    expect(body.sessions).toEqual([]);
  });
});

describe('GET /api/sessions/[sessionId]', () => {
  it('returns the Session with its coverage matrix', async () => {
    await writeRun(SHORT_RUN);
    await writeRun(NUMBERS_RUN);
    const { body } = await createSession([SHORT_RUN, NUMBERS_RUN]);

    await postResult(
      postRequest('http://localhost/api/results', {
        runId: SHORT_RUN,
        toolId: 'windows-standard-voice-input',
        deliveryPath: 'speaker-to-mic',
        rawTranscript: 'Windows の観測',
      }),
    );

    const response = await getSessionById(body.sessionId!);
    expect(response.status).toBe(200);

    const comparison = (await response.json()) as {
      session: { session_id: string };
      rows: Array<{
        testId: string;
        cells: Array<{ tool: string; status: string; verifiedCount: number }>;
      }>;
    };

    expect(comparison.session.session_id).toBe(body.sessionId);
    const shortRow = comparison.rows.find((row) => row.testId === 'architecture-short-001')!;
    expect(shortRow.cells.find((cell) => cell.tool === 'windows-standard-voice-input')).toMatchObject(
      { status: 'covered', verifiedCount: 1 },
    );
    expect(shortRow.cells.find((cell) => cell.tool === 'aqua-voice')!.status).toBe('missing');

    const numbersRow = comparison.rows.find((row) => row.testId === 'numbers-units-001')!;
    expect(numbersRow.cells.every((cell) => cell.status === 'missing')).toBe(true);
  });

  it('returns 404 for a Session that does not exist', async () => {
    const response = await getSessionById('20260907T020000000Z-11111111');
    expect(response.status).toBe(404);
  });

  it('returns 400 for a malformed session id', async () => {
    for (const sessionId of ['..', '../../etc/passwd', 'not-a-session']) {
      const response = await getSessionById(sessionId);
      expect([400, 404]).toContain(response.status);
    }
  });

  it('returns 409 for a Session whose evidence no longer holds', async () => {
    await writeRun(SHORT_RUN);
    const { body } = await createSession([SHORT_RUN]);
    await writeFile(path.join(runsRoot, SHORT_RUN, 'audio.wav'), '差し替え');

    const response = await getSessionById(body.sessionId!);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { kind: 'RUN_HASH_MISMATCH' } });
  });

  it('reflects a Result added after creation without changing session.json', async () => {
    await writeRun(SHORT_RUN);
    const { body } = await createSession([SHORT_RUN]);
    const file = path.join(sessionsRoot, body.sessionId!, 'session.json');
    const before = await readFile(file, 'utf8');

    await postResult(
      postRequest('http://localhost/api/results', {
        runId: SHORT_RUN,
        toolId: 'aqua-voice',
        deliveryPath: 'virtual-audio',
        rawTranscript: '後から追加した観測',
      }),
    );

    const comparison = (await (await getSessionById(body.sessionId!)).json()) as {
      rows: Array<{ cells: Array<{ tool: string; status: string }> }>;
    };
    expect(
      comparison.rows[0]!.cells.find((cell) => cell.tool === 'aqua-voice')!.status,
    ).toBe('covered');
    expect(await readFile(file, 'utf8')).toBe(before);
  });
});
