import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AivisSpeechProvider, type FetchLike } from '@/tts/AivisSpeechProvider';
import { LocalRunStore } from '@/storage/LocalRunStore';
import { BenchmarkError, generateBenchmarkRun } from './generateBenchmark';
import { MANUAL_TEST_ID } from './cases';
import type { RunManifestV1 } from './manifest';

/**
 * The provider is a real AivisSpeechProvider with an injected fetch, so these
 * tests exercise the actual `/speakers` and `/aivm_models` parsing rather than
 * a stand-in. No AivisSpeech Engine is contacted.
 */

const RUN_ID = '20260906T011343123Z-aabbccdd';
const NOW = new Date('2026-09-06T01:13:43.123Z');

const SPEAKER_UUID = 'e756b8e4-b606-4e15-99b1-3f9c6a1b2e1a';
const MODEL_UUID = 'a1b2c3d4-0000-0000-0000-000000000000';
const STYLE_ID = 888753760;

const SPEAKERS = [
  {
    name: 'Anneli',
    speaker_uuid: SPEAKER_UUID,
    styles: [
      { name: 'ノーマル', id: STYLE_ID, type: 'talk' },
      { name: 'テンション高め', id: STYLE_ID + 1, type: 'talk' },
    ],
    version: '1.0.0',
  },
];

const AIVM_MODELS = {
  [MODEL_UUID]: {
    manifest: {
      name: 'Anneli',
      version: '1.0.0',
      speakers: [{ name: 'Anneli', uuid: SPEAKER_UUID }],
    },
    is_loaded: true,
  },
};

const AUDIO_QUERY = {
  accent_phrases: [],
  speedScale: 1.0,
  pitchScale: 0.0,
  intonationScale: 1.0,
  tempoDynamicsScale: 1.0,
  volumeScale: 1.0,
  outputSamplingRate: 24000,
  outputStereo: true,
  kana: 'テスト',
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function wavBody(payloadLength = 32): ArrayBuffer {
  const bytes = new Uint8Array(12 + payloadLength);
  bytes.set([0x52, 0x49, 0x46, 0x46], 0); // "RIFF"
  new DataView(bytes.buffer).setUint32(4, 4 + payloadLength, true);
  bytes.set([0x57, 0x41, 0x56, 0x45], 8); // "WAVE"
  for (let i = 12; i < bytes.length; i += 1) bytes[i] = i & 0xff;
  return bytes.buffer;
}

interface RecordedCall {
  url: string;
  method: string;
  body?: string;
}

type Routes = Record<string, () => Response>;

function createDeps(routeOverrides: Routes = {}) {
  const calls: RecordedCall[] = [];
  const routes: Routes = {
    '/speakers': () => jsonResponse(SPEAKERS),
    '/version': () => jsonResponse('1.1.0'),
    '/aivm_models': () => jsonResponse(AIVM_MODELS),
    '/audio_query': () => jsonResponse(AUDIO_QUERY),
    '/synthesis': () =>
      new Response(wavBody(), { status: 200, headers: { 'Content-Type': 'audio/wav' } }),
    ...routeOverrides,
  };

  const fetchImpl: FetchLike = async (input, init) => {
    calls.push({ url: input, method: init?.method ?? 'GET', body: init?.body });
    const pathname = new URL(input).pathname;
    const handler = routes[pathname];
    if (!handler) throw new Error(`unexpected request: ${input}`);
    return handler();
  };

  return {
    calls,
    provider: new AivisSpeechProvider({ baseUrl: 'http://127.0.0.1:10101', fetchImpl }),
  };
}

function paths(calls: RecordedCall[]): string[] {
  return calls.map((call) => new URL(call.url).pathname);
}

let root: string;
let store: LocalRunStore;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'vib-bench-'));
  store = new LocalRunStore(root);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const INPUT = {
  testId: MANUAL_TEST_ID,
  rawText: 'テストです。',
  styleId: STYLE_ID,
  speedScale: 1.25,
  volumeScale: 0.75,
};

describe('successful Run', () => {
  it('writes the four-file bundle and returns a schema v1 manifest', async () => {
    const { provider } = createDeps();

    const result = await generateBenchmarkRun(INPUT, {
      provider,
      store,
      now: () => NOW,
      runId: RUN_ID,
    });

    expect(result.runId).toBe(RUN_ID);
    expect((await readdir(result.runDir)).sort()).toEqual(
      ['audio.wav', 'manifest.json', 'provider-query.json', 'source.txt'].sort(),
    );

    const manifest = result.manifest;
    expect(manifest.schema_version).toBe(2);
    expect(manifest.run_id).toBe(RUN_ID);
    expect(manifest.test_id).toBe('manual');
    expect(manifest.generated_at).toBe(NOW.toISOString());
    expect(manifest.settings).toEqual({
      speed_scale: 1.25,
      volume_scale: 0.75,
      sample_rate: 44100,
      stereo: false,
    });
    expect(manifest.segmentation).toEqual({
      strategy: 'none',
      target_max_chars: 450,
      segment_count: 1,
    });
    expect(manifest.reproducibility).toEqual({
      canonical_artifact: true,
      bit_exact_regeneration_expected: false,
    });
    expect(manifest.source).toMatchObject({
      file: 'source.txt',
      encoding: 'utf-8',
      line_endings: 'lf',
    });
  });

  it('records manifest hashes that match the bytes actually on disk', async () => {
    const { provider } = createDeps();
    const result = await generateBenchmarkRun(INPUT, {
      provider,
      store,
      now: () => NOW,
      runId: RUN_ID,
    });

    const sha = async (file: string) =>
      createHash('sha256')
        .update(await readFile(path.join(result.runDir, file)))
        .digest('hex');

    expect(await sha('source.txt')).toBe(result.manifest.source.sha256);
    expect(await sha('audio.wav')).toBe(result.manifest.audio.sha256);
    expect(await sha('provider-query.json')).toBe(result.manifest.provider_query.sha256);

    const audioBytes = await readFile(path.join(result.runDir, 'audio.wav'));
    expect(result.manifest.audio.bytes).toBe(audioBytes.byteLength);
    expect(result.manifest.audio.content_type).toBe('audio/wav');
  });

  it('writes a manifest.json whose parsed content equals the returned manifest', async () => {
    const { provider } = createDeps();
    const result = await generateBenchmarkRun(INPUT, {
      provider,
      store,
      now: () => NOW,
      runId: RUN_ID,
    });

    const onDisk = JSON.parse(
      await readFile(path.join(result.runDir, 'manifest.json'), 'utf8'),
    ) as RunManifestV1;
    expect(onDisk).toEqual(result.manifest);
  });

  it('records provider evidence from the engine, not from the caller', async () => {
    const { provider } = createDeps();
    const result = await generateBenchmarkRun(INPUT, {
      provider,
      store,
      now: () => NOW,
      runId: RUN_ID,
    });

    expect(result.manifest.provider).toEqual({
      id: 'aivisspeech',
      engine_name: 'AivisSpeech',
      engine_version: '1.1.0',
      engine_url: 'http://127.0.0.1:10101',
    });
  });
});

describe('canonical text is one string everywhere', () => {
  const RAW = '  先頭に空白\r\n二行目\rそして末尾に空白  ';
  const CANONICAL = '  先頭に空白\n二行目\nそして末尾に空白  ';

  it('stores, hashes and synthesizes the identical canonical string', async () => {
    const { provider, calls } = createDeps();

    const result = await generateBenchmarkRun(
      { ...INPUT, rawText: RAW },
      { provider, store, now: () => NOW, runId: RUN_ID },
    );

    // 1. what went to the engine
    const audioQueryCall = calls.find((call) => new URL(call.url).pathname === '/audio_query')!;
    const sentText = new URL(audioQueryCall.url).searchParams.get('text');
    expect(sentText).toBe(CANONICAL);

    // 2. what was stored
    const stored = await readFile(path.join(result.runDir, 'source.txt'), 'utf8');
    expect(stored).toBe(CANONICAL);

    // 3. what was hashed
    expect(result.manifest.source.sha256).toBe(
      createHash('sha256').update(Buffer.from(CANONICAL, 'utf8')).digest('hex'),
    );

    // and they are all the same string
    expect(sentText).toBe(stored);
  });

  it('does not trim the text it stores or synthesizes', async () => {
    const { provider, calls } = createDeps();
    const result = await generateBenchmarkRun(
      { ...INPUT, rawText: '   パディング   ' },
      { provider, store, now: () => NOW, runId: RUN_ID },
    );

    const audioQueryCall = calls.find((call) => new URL(call.url).pathname === '/audio_query')!;
    expect(new URL(audioQueryCall.url).searchParams.get('text')).toBe('   パディング   ');
    expect(await readFile(path.join(result.runDir, 'source.txt'), 'utf8')).toBe('   パディング   ');
  });
});

describe('voice identity comes from fresh /speakers evidence', () => {
  it('resolves speaker and style from the engine for the given style id', async () => {
    const { provider, calls } = createDeps();
    const result = await generateBenchmarkRun(
      { ...INPUT, styleId: STYLE_ID + 1 },
      { provider, store, now: () => NOW, runId: RUN_ID },
    );

    expect(result.manifest.voice).toEqual({
      speaker_uuid: SPEAKER_UUID,
      speaker_name: 'Anneli',
      style_id: STYLE_ID + 1,
      style_name: 'テンション高め',
    });
    expect(paths(calls)).toContain('/speakers');
  });

  it('fails closed when the style id is not in the current /speakers', async () => {
    const { provider, calls } = createDeps();

    const error = await generateBenchmarkRun(
      { ...INPUT, styleId: 424242 },
      { provider, store, now: () => NOW, runId: RUN_ID },
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(BenchmarkError);
    expect((error as BenchmarkError).kind).toBe('VOICE_NOT_FOUND');
    expect(paths(calls)).not.toContain('/synthesis');
    expect(await readdir(root)).toEqual([]);
  });
});

describe('model identity is resolved from provider-owned evidence', () => {
  it('records the AIVM model that uniquely provides the speaker', async () => {
    const { provider } = createDeps();
    const result = await generateBenchmarkRun(INPUT, {
      provider,
      store,
      now: () => NOW,
      runId: RUN_ID,
    });

    expect(result.manifest.model).toEqual({
      uuid: MODEL_UUID,
      name: 'Anneli',
      version: '1.0.0',
    });
  });

  it('ignores models that do not claim this speaker', async () => {
    const { provider } = createDeps({
      '/aivm_models': () =>
        jsonResponse({
          'other-model': {
            manifest: { name: 'Other', version: '9.9.9', speakers: [{ uuid: 'someone-else' }] },
          },
          ...AIVM_MODELS,
        }),
    });

    const result = await generateBenchmarkRun(INPUT, {
      provider,
      store,
      now: () => NOW,
      runId: RUN_ID,
    });
    expect(result.manifest.model.uuid).toBe(MODEL_UUID);
  });

  const FAIL_CLOSED: Array<[string, Routes, string]> = [
    [
      'no model claims the speaker',
      { '/aivm_models': () => jsonResponse({}) },
      'MODEL_NOT_FOUND',
    ],
    [
      'several models claim the speaker',
      {
        '/aivm_models': () =>
          jsonResponse({
            'model-a': { manifest: { name: 'A', version: '1.0.0', speakers: [{ uuid: SPEAKER_UUID }] } },
            'model-b': { manifest: { name: 'B', version: '2.0.0', speakers: [{ uuid: SPEAKER_UUID }] } },
          }),
      },
      'MODEL_AMBIGUOUS',
    ],
    [
      'the model version is unknown',
      {
        '/aivm_models': () =>
          jsonResponse({
            [MODEL_UUID]: { manifest: { name: 'Anneli', speakers: [{ uuid: SPEAKER_UUID }] } },
          }),
      },
      'MODEL_IDENTITY_INCOMPLETE',
    ],
    [
      'the model name is unknown',
      {
        '/aivm_models': () =>
          jsonResponse({
            [MODEL_UUID]: { manifest: { version: '1.0.0', speakers: [{ uuid: SPEAKER_UUID }] } },
          }),
      },
      'MODEL_IDENTITY_INCOMPLETE',
    ],
    [
      'the model evidence endpoint fails',
      { '/aivm_models': () => new Response('not found', { status: 404 }) },
      'MODEL_EVIDENCE_UNAVAILABLE',
    ],
  ];

  for (const [label, routes, kind] of FAIL_CLOSED) {
    it(`writes no official Run when ${label}`, async () => {
      const { provider, calls } = createDeps(routes);

      const error = await generateBenchmarkRun(INPUT, {
        provider,
        store,
        now: () => NOW,
        runId: RUN_ID,
      }).catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(BenchmarkError);
      expect((error as BenchmarkError).kind).toBe(kind);
      // Identity is settled before synthesis, so a doomed Run costs no audio.
      expect(paths(calls)).not.toContain('/synthesis');
      expect(await readdir(root)).toEqual([]);
    });
  }
});

describe('provider failure leaves no official Run', () => {
  const PROVIDER_FAILURES: Array<[string, Routes]> = [
    ['/speakers fails', { '/speakers': () => new Response('boom', { status: 500 }) }],
    ['/version fails', { '/version': () => new Response('boom', { status: 500 }) }],
    ['/audio_query fails', { '/audio_query': () => new Response('boom', { status: 422 }) }],
    ['/synthesis fails', { '/synthesis': () => new Response('boom', { status: 500 }) }],
    [
      '/synthesis returns a non-WAV body',
      {
        '/synthesis': () =>
          new Response(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]).buffer as ArrayBuffer, {
            status: 200,
          }),
      },
    ],
  ];

  for (const [label, routes] of PROVIDER_FAILURES) {
    it(`creates nothing under the runs root when ${label}`, async () => {
      const { provider } = createDeps(routes);

      await expect(
        generateBenchmarkRun(INPUT, { provider, store, now: () => NOW, runId: RUN_ID }),
      ).rejects.toThrow();

      expect(await readdir(root)).toEqual([]);
    });
  }
});

describe('Runs are immutable', () => {
  it('refuses a second Run with the same id and keeps the first intact', async () => {
    const { provider } = createDeps();
    const first = await generateBenchmarkRun(
      { ...INPUT, rawText: '最初' },
      { provider, store, now: () => NOW, runId: RUN_ID },
    );

    await expect(
      generateBenchmarkRun(
        { ...INPUT, rawText: '二回目' },
        { provider, store, now: () => NOW, runId: RUN_ID },
      ),
    ).rejects.toMatchObject({ kind: 'RUN_ALREADY_EXISTS' });

    expect(await readFile(path.join(first.runDir, 'source.txt'), 'utf8')).toBe('最初');
  });

  it('records regeneration of the same text as a separate Run', async () => {
    const { provider } = createDeps();
    const a = await generateBenchmarkRun(INPUT, { provider, store, now: () => NOW, runId: RUN_ID });
    const b = await generateBenchmarkRun(INPUT, {
      provider,
      store,
      now: () => NOW,
      runId: '20260906T011344000Z-11223344',
    });

    expect(a.runId).not.toBe(b.runId);
    expect((await readdir(root)).sort()).toEqual([a.runId, b.runId].sort());
    // Same canonical text, so the text hash matches across Runs by design.
    expect(a.manifest.source.sha256).toBe(b.manifest.source.sha256);
  });

  it('generates its own run id when none is injected', async () => {
    const { provider } = createDeps();
    const result = await generateBenchmarkRun(INPUT, { provider, store, now: () => NOW });
    expect(result.runId).toMatch(/^20260906T011343123Z-[0-9a-f]{8}$/);
  });
});
