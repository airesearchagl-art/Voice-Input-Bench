import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LocalRunStore } from '@/storage/LocalRunStore';
import { GET as getResults, POST as postResult } from './results/route';
import { GET as getRuns } from './runs/route';

/**
 * HTTP-boundary checks for the manual STT Result surface. No AivisSpeech Engine
 * is contacted; the Runs are written directly with the Phase 1 store.
 */

const RUN_ID = '20260906T011343123Z-aabbccdd';
const NOW = '2026-09-06T02:00:00.000Z';

const SOURCE_TEXT = 'テスト本文です。';
const AUDIO = new Uint8Array([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x41, 0x56, 0x45]);
const PROVIDER_QUERY = Buffer.from('{"schema_version":1,"segments":[]}\n', 'utf8');

function sha(bytes: Uint8Array | string): string {
  return createHash('sha256')
    .update(typeof bytes === 'string' ? Buffer.from(bytes, 'utf8') : bytes)
    .digest('hex');
}

function manifest(runId: string, schemaVersion = 2): Record<string, unknown> {
  return {
    schema_version: schemaVersion,
    run_id: runId,
    test_id: 'architecture-short-001',
    generated_at: NOW,
    source: { file: 'source.txt', encoding: 'utf-8', line_endings: 'lf', sha256: sha(SOURCE_TEXT) },
    provider: { id: 'aivisspeech', engine_name: 'AivisSpeech', engine_version: '1.1.0-dev', engine_url: 'http://127.0.0.1:10101' },
    model: { uuid: 'm', name: 'まお', version: '1.2.0' },
    voice: { speaker_uuid: 's', speaker_name: 'まお', style_id: 1, style_name: 'ノーマル' },
    settings: { speed_scale: 1, volume_scale: 1, sample_rate: 44100, stereo: false },
    segmentation: { strategy: 'none', target_max_chars: 450, segment_count: 1 },
    provider_query: { file: 'provider-query.json', sha256: sha(PROVIDER_QUERY) },
    audio: { file: 'audio.wav', content_type: 'audio/wav', sha256: sha(AUDIO), bytes: AUDIO.byteLength },
    reproducibility: { canonical_artifact: true, bit_exact_regeneration_expected: false },
  };
}

let runsRoot: string;
let resultsRoot: string;

async function writeRun(runId = RUN_ID, schemaVersion = 2): Promise<void> {
  await new LocalRunStore(runsRoot).saveRun(runId, {
    sourceText: SOURCE_TEXT,
    audio: AUDIO,
    providerQueryJson: PROVIDER_QUERY,
    manifestJson: Buffer.from(`${JSON.stringify(manifest(runId, schemaVersion), null, 2)}\n`, 'utf8'),
  });
}

function postRequest(body: unknown): Request {
  return new Request('http://localhost/api/results', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function getRequest(query: string): Request {
  return new Request(`http://localhost/api/results${query}`);
}

const VALID_BODY = {
  runId: RUN_ID,
  toolId: 'windows-standard-voice-input',
  deliveryPath: 'speaker-to-mic',
  rawTranscript: 'STT が返したテキスト',
};

beforeEach(async () => {
  runsRoot = await mkdtemp(path.join(tmpdir(), 'vib-route-runs-'));
  resultsRoot = await mkdtemp(path.join(tmpdir(), 'vib-route-results-'));
  process.env.VIB_RUNS_DIR = runsRoot;
  process.env.VIB_RESULTS_DIR = resultsRoot;
});

afterEach(async () => {
  delete process.env.VIB_RUNS_DIR;
  delete process.env.VIB_RESULTS_DIR;
  await rm(runsRoot, { recursive: true, force: true });
  await rm(resultsRoot, { recursive: true, force: true });
});

describe('GET /api/runs', () => {
  it('lists schema v2 Runs', async () => {
    await writeRun();
    const body = (await (await getRuns()).json()) as {
      ok: true;
      runs: Array<{ runId: string; testId: string; audioSha256: string }>;
    };

    expect(body.ok).toBe(true);
    expect(body.runs).toHaveLength(1);
    expect(body.runs[0]).toMatchObject({
      runId: RUN_ID,
      testId: 'architecture-short-001',
      audioSha256: sha(AUDIO),
    });
  });

  it('omits a schema v1 Run rather than migrating it', async () => {
    await writeRun(RUN_ID, 1);
    const body = (await (await getRuns()).json()) as { runs: unknown[] };
    expect(body.runs).toEqual([]);
  });

  it('returns an empty list when there are no Runs', async () => {
    const body = (await (await getRuns()).json()) as { runs: unknown[] };
    expect(body.runs).toEqual([]);
  });
});

describe('POST /api/results', () => {
  it('saves a Result and returns it', async () => {
    await writeRun();
    const response = await postResult(postRequest(VALID_BODY));

    expect(response.status).toBe(201);
    const body = (await response.json()) as {
      ok: true;
      resultId: string;
      result: { run_id: string; tool: { name: string }; run_evidence: { audio_sha256: string } };
    };
    expect(body.ok).toBe(true);
    expect(body.resultId).toMatch(/^\d{8}T\d{9}Z-[0-9a-f]{8}$/);
    expect(body.result.run_id).toBe(RUN_ID);
    expect(body.result.tool.name).toBe('Windows 標準音声入力');
    expect(body.result.run_evidence.audio_sha256).toBe(sha(AUDIO));
  });

  const BAD_REQUESTS: Array<[string, unknown, number]> = [
    ['a missing runId', { ...VALID_BODY, runId: undefined }, 400],
    ['a non-string transcript', { ...VALID_BODY, rawTranscript: 42 }, 400],
    ['a missing toolId', { ...VALID_BODY, toolId: undefined }, 400],
    ['an unknown toolId', { ...VALID_BODY, toolId: 'whisper' }, 400],
    ['a missing deliveryPath', { ...VALID_BODY, deliveryPath: undefined }, 400],
    ['an unknown deliveryPath', { ...VALID_BODY, deliveryPath: 'bluetooth' }, 400],
    ['other without a name', { ...VALID_BODY, toolId: 'other' }, 400],
    [
      'a custom name on a built-in tool',
      { ...VALID_BODY, customToolName: 'なりすまし' },
      400,
    ],
    ['an empty transcript', { ...VALID_BODY, rawTranscript: '' }, 400],
  ];

  for (const [label, body, status] of BAD_REQUESTS) {
    it(`rejects ${label}`, async () => {
      await writeRun();
      const response = await postResult(postRequest(body));
      expect(response.status).toBe(status);
      expect(await response.json()).toMatchObject({ ok: false });
    });
  }

  it('rejects a malformed body', async () => {
    const response = await postResult(
      new Request('http://localhost/api/results', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'not json',
      }),
    );
    expect(response.status).toBe(400);
  });

  it('returns 404 for a Run that does not exist', async () => {
    const response = await postResult(postRequest(VALID_BODY));
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: { kind: 'RUN_NOT_FOUND' } });
  });

  it('returns 409 for a Run on an unsupported manifest schema', async () => {
    await writeRun(RUN_ID, 1);
    const response = await postResult(postRequest(VALID_BODY));
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: { kind: 'RUN_MANIFEST_SCHEMA_UNSUPPORTED' },
    });
  });

  const TRAVERSAL = ['..', '../../etc/passwd', '..\\..\\Windows', '/etc/passwd', ''];

  for (const runId of TRAVERSAL) {
    it(`refuses runId ${JSON.stringify(runId)}`, async () => {
      await writeRun();
      const response = await postResult(postRequest({ ...VALID_BODY, runId }));
      expect([400, 404]).toContain(response.status);
    });
  }
});

describe('GET /api/results', () => {
  it('requires a runId', async () => {
    const response = await getResults(getRequest(''));
    expect(response.status).toBe(400);
  });

  it('lists the Results of one Run and nothing else', async () => {
    await writeRun();
    await postResult(postRequest({ ...VALID_BODY, rawTranscript: 'Windows の出力' }));
    await postResult(
      postRequest({ ...VALID_BODY, toolId: 'aqua-voice', rawTranscript: 'Aqua の出力' }),
    );

    const body = (await (
      await getResults(getRequest(`?runId=${RUN_ID}`))
    ).json()) as {
      runId: string;
      results: Array<{ result: { tool: { id: string } }; transcript: string }>;
    };

    expect(body.runId).toBe(RUN_ID);
    expect(body.results.map((entry) => entry.result.tool.id).sort()).toEqual([
      'aqua-voice',
      'windows-standard-voice-input',
    ]);
    expect(body.results.map((entry) => entry.transcript).sort()).toEqual(
      ['Aqua の出力', 'Windows の出力'].sort(),
    );
  });

  it('returns an empty list for a Run with no Results', async () => {
    const body = (await (
      await getResults(getRequest('?runId=20260906T999999999Z-00000000'))
    ).json()) as { results: unknown[] };
    expect(body.results).toEqual([]);
  });
});
