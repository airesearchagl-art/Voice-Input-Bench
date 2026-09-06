import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AivisSpeechProvider, type FetchLike } from '@/tts/AivisSpeechProvider';
import { LocalRunStore } from '@/storage/LocalRunStore';
import { WavError, parseWav } from '@/audio/wav';
import { BenchmarkError, generateBenchmarkRun } from './generateBenchmark';
import { MANUAL_TEST_ID, getBenchmarkCase } from './cases';
import { DEFAULT_TARGET_MAX_CHARS, SPLIT_STRATEGY, splitCanonicalText } from './splitter';

/**
 * P1-C orchestration: Benchmark Cases, deterministic splitting, per-segment
 * synthesis and WAV assembly.
 *
 * As in the P1-B suite the provider is a real `AivisSpeechProvider` with an
 * injected fetch, so the actual `/speakers`, `/aivm_models` and `/synthesis`
 * handling is exercised. No AivisSpeech Engine is contacted.
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
    styles: [{ name: 'ノーマル', id: STYLE_ID, type: 'talk' }],
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
  futureField: 'unknown-but-must-survive',
};

const LONG_CASE = getBenchmarkCase('architecture-long-001')!;
const SHORT_CASE = getBenchmarkCase('architecture-short-001')!;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** A structurally complete 16-bit mono 44100 Hz WAV with a distinguishable payload. */
function buildPcmWav(frames: number, seed: number): Uint8Array {
  const dataBytes = frames * 2;
  const out = new Uint8Array(44 + dataBytes);
  const view = new DataView(out.buffer);
  const writeAscii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i += 1) out[offset + i] = text.charCodeAt(i);
  };

  writeAscii(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  writeAscii(8, 'WAVE');
  writeAscii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, 44100, true);
  view.setUint32(28, 88200, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(36, 'data');
  view.setUint32(40, dataBytes, true);
  for (let i = 0; i < frames; i += 1) {
    view.setInt16(44 + i * 2, ((seed * 31 + i) % 3000) - 1500, true);
  }

  return out;
}

function wavResponse(bytes: Uint8Array): Response {
  return new Response(bytes.slice().buffer as ArrayBuffer, {
    status: 200,
    headers: { 'Content-Type': 'audio/wav' },
  });
}

interface RecordedCall {
  url: string;
  method: string;
  body?: string;
}

interface DepsOptions {
  /** Frames of audio each successive segment returns. */
  framesPerSegment?: number[];
  /** 1-based segment number that should fail, if any. */
  failAtSegment?: number;
  /** Override the WAV a given 1-based segment returns. */
  wavForSegment?: (segmentNumber: number) => Uint8Array | null;
}

function createDeps(options: DepsOptions = {}) {
  const calls: RecordedCall[] = [];
  let synthesisCount = 0;

  const fetchImpl: FetchLike = async (input, init) => {
    calls.push({ url: input, method: init?.method ?? 'GET', body: init?.body });
    const pathname = new URL(input).pathname;

    switch (pathname) {
      case '/speakers':
        return jsonResponse(SPEAKERS);
      case '/version':
        return jsonResponse('1.1.0');
      case '/aivm_models':
        return jsonResponse(AIVM_MODELS);
      case '/audio_query':
        return jsonResponse(AUDIO_QUERY);
      case '/synthesis': {
        synthesisCount += 1;
        if (options.failAtSegment === synthesisCount) {
          return new Response('segment blew up', { status: 500 });
        }
        const override = options.wavForSegment?.(synthesisCount);
        if (override) return wavResponse(override);
        const frames = options.framesPerSegment?.[synthesisCount - 1] ?? 100 + synthesisCount;
        return wavResponse(buildPcmWav(frames, synthesisCount));
      }
      default:
        throw new Error(`unexpected request: ${input}`);
    }
  };

  return {
    calls,
    synthesisCount: () => synthesisCount,
    provider: new AivisSpeechProvider({ baseUrl: 'http://127.0.0.1:10101', fetchImpl }),
  };
}

/** Text actually sent to /audio_query, in call order. */
function sentTexts(calls: RecordedCall[]): string[] {
  return calls
    .filter((call) => new URL(call.url).pathname === '/audio_query')
    .map((call) => new URL(call.url).searchParams.get('text') ?? '');
}

let root: string;
let store: LocalRunStore;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'vib-seg-'));
  store = new LocalRunStore(root);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function runCase(testId: string, overrides: Partial<{ speedScale: number; volumeScale: number; rawText: string }> = {}) {
  return {
    testId,
    rawText: overrides.rawText ?? '',
    styleId: STYLE_ID,
    speedScale: overrides.speedScale ?? 1,
    volumeScale: overrides.volumeScale ?? 1,
  };
}

describe('Benchmark Case Runs', () => {
  it('uses the server-side case body and ignores whatever text the client sent', async () => {
    const { provider, calls } = createDeps();

    const result = await generateBenchmarkRun(
      runCase(SHORT_CASE.id, { rawText: 'クライアントが送りつけた偽の本文です。' }),
      { provider, store, now: () => NOW, runId: RUN_ID },
    );

    const stored = await readFile(path.join(result.runDir, 'source.txt'), 'utf8');
    expect(stored).toBe(SHORT_CASE.text);
    expect(stored).not.toContain('偽の本文');
    expect(sentTexts(calls).join('')).toBe(SHORT_CASE.text);
    expect(result.manifest.test_id).toBe(SHORT_CASE.id);
  });

  it('records the case ID as test_id', async () => {
    const { provider } = createDeps();
    const result = await generateBenchmarkRun(runCase(LONG_CASE.id), {
      provider,
      store,
      now: () => NOW,
      runId: RUN_ID,
    });
    expect(result.manifest.test_id).toBe('architecture-long-001');
  });

  it('fails closed on an unknown case ID without calling the engine', async () => {
    const { provider, calls } = createDeps();

    const error = await generateBenchmarkRun(runCase('no-such-case', { rawText: 'x' }), {
      provider,
      store,
      now: () => NOW,
      runId: RUN_ID,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(BenchmarkError);
    expect((error as BenchmarkError).kind).toBe('CASE_NOT_FOUND');
    expect(calls).toHaveLength(0);
    expect(await readdir(root)).toEqual([]);
  });

  it('keeps a manual Run on the text the client sent', async () => {
    const { provider, calls } = createDeps();
    const result = await generateBenchmarkRun(
      runCase(MANUAL_TEST_ID, { rawText: '手入力のテキストです。' }),
      { provider, store, now: () => NOW, runId: RUN_ID },
    );
    expect(await readFile(path.join(result.runDir, 'source.txt'), 'utf8')).toBe(
      '手入力のテキストです。',
    );
    expect(sentTexts(calls)).toEqual(['手入力のテキストです。']);
    expect(result.manifest.test_id).toBe('manual');
  });
});

describe('long text is split, synthesized per segment and reassembled', () => {
  it('splits architecture-long-001 into several segments', async () => {
    const { provider, synthesisCount } = createDeps();

    const result = await generateBenchmarkRun(runCase(LONG_CASE.id), {
      provider,
      store,
      now: () => NOW,
      runId: RUN_ID,
    });

    const expected = splitCanonicalText(LONG_CASE.text);
    expect(expected.length).toBeGreaterThan(1);
    expect(result.manifest.segmentation).toEqual({
      strategy: SPLIT_STRATEGY,
      target_max_chars: DEFAULT_TARGET_MAX_CHARS,
      segment_count: expected.length,
    });
    expect(synthesisCount()).toBe(expected.length);
  });

  it('passes each segment to the provider verbatim, in order', async () => {
    const { provider, calls } = createDeps();

    await generateBenchmarkRun(runCase(LONG_CASE.id), {
      provider,
      store,
      now: () => NOW,
      runId: RUN_ID,
    });

    const expected = splitCanonicalText(LONG_CASE.text);
    expect(sentTexts(calls)).toEqual(expected);
    expect(sentTexts(calls).join('')).toBe(LONG_CASE.text);
  });

  it('synthesizes every segment on the same voice, style, speed and volume', async () => {
    const { provider, calls } = createDeps();

    await generateBenchmarkRun(runCase(LONG_CASE.id, { speedScale: 1.35, volumeScale: 0.65 }), {
      provider,
      store,
      now: () => NOW,
      runId: RUN_ID,
    });

    const queryCalls = calls.filter((call) => new URL(call.url).pathname === '/audio_query');
    const synthesisCalls = calls.filter((call) => new URL(call.url).pathname === '/synthesis');
    expect(queryCalls.length).toBe(synthesisCalls.length);
    expect(queryCalls.length).toBeGreaterThan(1);

    for (const call of queryCalls) {
      expect(new URL(call.url).searchParams.get('speaker')).toBe(String(STYLE_ID));
    }
    for (const call of synthesisCalls) {
      expect(new URL(call.url).searchParams.get('speaker')).toBe(String(STYLE_ID));
      expect(JSON.parse(call.body!)).toMatchObject({
        speedScale: 1.35,
        volumeScale: 0.65,
        outputSamplingRate: 44100,
        outputStereo: false,
      });
    }
  });

  it('stores source.txt and the text hash for the whole text, not a segment', async () => {
    const { provider } = createDeps();

    const result = await generateBenchmarkRun(runCase(LONG_CASE.id), {
      provider,
      store,
      now: () => NOW,
      runId: RUN_ID,
    });

    const stored = await readFile(path.join(result.runDir, 'source.txt'), 'utf8');
    expect(stored).toBe(LONG_CASE.text);
    expect(result.manifest.source.sha256).toBe(
      createHash('sha256').update(Buffer.from(LONG_CASE.text, 'utf8')).digest('hex'),
    );
  });

  it('concatenates the segment PCM into audio.wav with nothing inserted', async () => {
    const framesPerSegment = [100, 200, 300, 400, 500, 600, 700, 800, 900, 1000];
    const { provider } = createDeps({ framesPerSegment });

    const result = await generateBenchmarkRun(runCase(LONG_CASE.id), {
      provider,
      store,
      now: () => NOW,
      runId: RUN_ID,
    });

    const segmentCount = result.manifest.segmentation.segment_count;
    const expectedFrames = framesPerSegment
      .slice(0, segmentCount)
      .reduce((total, frames) => total + frames, 0);

    const assembled = await readFile(path.join(result.runDir, 'audio.wav'));
    const parsed = parseWav(new Uint8Array(assembled));
    expect(parsed.data.byteLength).toBe(expectedFrames * 2);
    expect(parsed.format.sampleRate).toBe(44100);
    expect(parsed.format.channels).toBe(1);
    expect(parsed.format.bitsPerSample).toBe(16);

    // Byte-exact: the payload is segment 1, then segment 2, then ...
    let offset = 0;
    for (let index = 0; index < segmentCount; index += 1) {
      const expectedSegment = parseWav(buildPcmWav(framesPerSegment[index]!, index + 1)).data;
      expect(
        new Uint8Array(parsed.data.subarray(offset, offset + expectedSegment.byteLength)),
      ).toEqual(new Uint8Array(expectedSegment));
      offset += expectedSegment.byteLength;
    }
    expect(offset).toBe(parsed.data.byteLength);
  });

  it('writes a RIFF size and data size that match the assembled file', async () => {
    const { provider } = createDeps();
    const result = await generateBenchmarkRun(runCase(LONG_CASE.id), {
      provider,
      store,
      now: () => NOW,
      runId: RUN_ID,
    });

    const assembled = await readFile(path.join(result.runDir, 'audio.wav'));
    const view = new DataView(assembled.buffer, assembled.byteOffset, assembled.byteLength);
    expect(assembled.toString('ascii', 0, 4)).toBe('RIFF');
    expect(assembled.toString('ascii', 8, 12)).toBe('WAVE');
    expect(view.getUint32(4, true)).toBe(assembled.byteLength - 8);
    expect(assembled.toString('ascii', 36, 40)).toBe('data');
    expect(view.getUint32(40, true)).toBe(assembled.byteLength - 44);
  });

  it('hashes the assembled file, not any single segment', async () => {
    const { provider } = createDeps();

    const result = await generateBenchmarkRun(runCase(LONG_CASE.id), {
      provider,
      store,
      now: () => NOW,
      runId: RUN_ID,
    });

    const assembled = await readFile(path.join(result.runDir, 'audio.wav'));
    expect(createHash('sha256').update(assembled).digest('hex')).toBe(result.manifest.audio.sha256);
    expect(result.manifest.audio.bytes).toBe(assembled.byteLength);
    expect(assembled.byteLength).toBeGreaterThan(buildPcmWav(101, 1).byteLength);
  });

  it('leaves a single-segment Run on the engine bytes untouched', async () => {
    const segmentWav = buildPcmWav(256, 9);
    const { provider } = createDeps({ wavForSegment: () => segmentWav });

    const result = await generateBenchmarkRun(runCase(SHORT_CASE.id), {
      provider,
      store,
      now: () => NOW,
      runId: RUN_ID,
    });

    expect(result.manifest.segmentation.strategy).toBe('none');
    expect(result.manifest.segmentation.segment_count).toBe(1);
    const stored = await readFile(path.join(result.runDir, 'audio.wav'));
    expect(new Uint8Array(stored)).toEqual(segmentWav);
  });
});

describe('provider-query evidence for every segment', () => {
  interface Envelope {
    schema_version: number;
    provider_id: string;
    segments: Array<{ index: number; query: Record<string, unknown> }>;
  }

  async function readEnvelope(runDir: string): Promise<Envelope> {
    return JSON.parse(await readFile(path.join(runDir, 'provider-query.json'), 'utf8')) as Envelope;
  }

  it('stores one entry per segment in a stable envelope', async () => {
    const { provider } = createDeps();

    const result = await generateBenchmarkRun(runCase(LONG_CASE.id), {
      provider,
      store,
      now: () => NOW,
      runId: RUN_ID,
    });

    const envelope = await readEnvelope(result.runDir);
    expect(envelope.schema_version).toBe(1);
    expect(envelope.provider_id).toBe('aivisspeech');
    expect(envelope.segments).toHaveLength(result.manifest.segmentation.segment_count);
    expect(envelope.segments.map((segment) => segment.index)).toEqual(
      envelope.segments.map((_, index) => index),
    );
  });

  it('uses the same envelope for a single-segment Run', async () => {
    const { provider } = createDeps();
    const result = await generateBenchmarkRun(runCase(SHORT_CASE.id), {
      provider,
      store,
      now: () => NOW,
      runId: RUN_ID,
    });

    const envelope = await readEnvelope(result.runDir);
    expect(envelope.schema_version).toBe(1);
    expect(envelope.segments).toHaveLength(1);
    expect(envelope.segments[0]!.index).toBe(0);
  });

  it('keeps every unknown AudioQuery field for every segment', async () => {
    const { provider } = createDeps();

    const result = await generateBenchmarkRun(
      runCase(LONG_CASE.id, { speedScale: 1.2, volumeScale: 0.8 }),
      { provider, store, now: () => NOW, runId: RUN_ID },
    );

    const envelope = await readEnvelope(result.runDir);
    expect(envelope.segments.length).toBeGreaterThan(1);

    for (const segment of envelope.segments) {
      // Owned by the app.
      expect(segment.query.speedScale).toBe(1.2);
      expect(segment.query.volumeScale).toBe(0.8);
      expect(segment.query.outputSamplingRate).toBe(44100);
      expect(segment.query.outputStereo).toBe(false);
      // Not surfaced in the UI, and not destroyed either.
      expect(segment.query.tempoDynamicsScale).toBe(AUDIO_QUERY.tempoDynamicsScale);
      expect(segment.query.pitchScale).toBe(AUDIO_QUERY.pitchScale);
      expect(segment.query.intonationScale).toBe(AUDIO_QUERY.intonationScale);
      expect(segment.query.kana).toBe(AUDIO_QUERY.kana);
      // Fields we have never heard of survive too.
      expect(segment.query.futureField).toBe('unknown-but-must-survive');
    }
  });

  it('hashes the envelope bytes actually written', async () => {
    const { provider } = createDeps();
    const result = await generateBenchmarkRun(runCase(LONG_CASE.id), {
      provider,
      store,
      now: () => NOW,
      runId: RUN_ID,
    });

    const bytes = await readFile(path.join(result.runDir, 'provider-query.json'));
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(
      result.manifest.provider_query.sha256,
    );
  });
});

describe('multi-segment failure is fail closed', () => {
  it('writes no official Run when a middle segment fails', async () => {
    const { provider, synthesisCount } = createDeps({ failAtSegment: 2 });

    const error = await generateBenchmarkRun(runCase(LONG_CASE.id), {
      provider,
      store,
      now: () => NOW,
      runId: RUN_ID,
    }).catch((caught: unknown) => caught);

    expect((error as { kind?: string }).kind).toBe('SYNTHESIS_FAILED');
    expect((error as Error).message).toContain('segment 2/');
    expect(synthesisCount()).toBe(2); // stopped there, did not push on
    expect(await readdir(root)).toEqual([]);
  });

  it('writes no official Run when the last segment fails', async () => {
    const segmentCount = splitCanonicalText(LONG_CASE.text).length;
    const { provider } = createDeps({ failAtSegment: segmentCount });

    await expect(
      generateBenchmarkRun(runCase(LONG_CASE.id), {
        provider,
        store,
        now: () => NOW,
        runId: RUN_ID,
      }),
    ).rejects.toThrow();

    expect(await readdir(root)).toEqual([]);
  });

  it('writes no official Run when segments disagree on audio format', async () => {
    const oddSegment = buildPcmWav(64, 2);
    // Rewrite segment 2's sample rate to 48000.
    new DataView(oddSegment.buffer).setUint32(24, 48000, true);
    const { provider } = createDeps({
      wavForSegment: (segmentNumber) => (segmentNumber === 2 ? oddSegment : null),
    });

    const error = await generateBenchmarkRun(runCase(LONG_CASE.id), {
      provider,
      store,
      now: () => NOW,
      runId: RUN_ID,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(WavError);
    expect((error as WavError).kind).toBe('FORMAT_MISMATCH');
    expect(await readdir(root)).toEqual([]);
  });

  it('writes no official Run when a segment is not a parseable WAV', async () => {
    // 12 bytes of RIFF/WAVE with no fmt or data chunk: the provider accepts the
    // magic, assembly refuses it.
    const bogus = new Uint8Array(12);
    bogus.set([0x52, 0x49, 0x46, 0x46], 0);
    bogus.set([0x57, 0x41, 0x56, 0x45], 8);
    const { provider } = createDeps({
      wavForSegment: (segmentNumber) => (segmentNumber === 1 ? bogus : null),
    });

    await expect(
      generateBenchmarkRun(runCase(LONG_CASE.id), {
        provider,
        store,
        now: () => NOW,
        runId: RUN_ID,
      }),
    ).rejects.toBeInstanceOf(WavError);

    expect(await readdir(root)).toEqual([]);
  });
});

describe('Run immutability holds for case Runs', () => {
  it('refuses a second Run with the same id and keeps the first intact', async () => {
    const { provider } = createDeps();
    const first = await generateBenchmarkRun(runCase(SHORT_CASE.id), {
      provider,
      store,
      now: () => NOW,
      runId: RUN_ID,
    });

    await expect(
      generateBenchmarkRun(runCase(LONG_CASE.id), {
        provider,
        store,
        now: () => NOW,
        runId: RUN_ID,
      }),
    ).rejects.toMatchObject({ kind: 'RUN_ALREADY_EXISTS' });

    expect(await readFile(path.join(first.runDir, 'source.txt'), 'utf8')).toBe(SHORT_CASE.text);
  });

  it('records a regenerated case as a separate Run with the same text hash', async () => {
    const { provider } = createDeps();
    const a = await generateBenchmarkRun(runCase(LONG_CASE.id), {
      provider,
      store,
      now: () => NOW,
      runId: RUN_ID,
    });
    const b = await generateBenchmarkRun(runCase(LONG_CASE.id), {
      provider,
      store,
      now: () => NOW,
      runId: '20260906T011344000Z-11223344',
    });

    expect(a.runId).not.toBe(b.runId);
    expect((await readdir(root)).sort()).toEqual([a.runId, b.runId].sort());
    expect(a.manifest.source.sha256).toBe(b.manifest.source.sha256);
    expect(a.manifest.segmentation).toEqual(b.manifest.segmentation);
  });
});
