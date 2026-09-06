import { describe, expect, it } from 'vitest';
import {
  AIVIS_FIXED_OUTPUT_SAMPLING_RATE,
  AIVIS_FIXED_OUTPUT_STEREO,
  AivisSpeechProvider,
  normalizeBaseUrl,
  type FetchLike,
} from './AivisSpeechProvider';
import { TTSProviderError } from './TTSProvider';

/**
 * These tests never touch a real AivisSpeech Engine: `fetchImpl` is injected, so
 * the whole suite runs with the engine stopped. Live-engine checks live in
 * `scripts/aivis-smoke.mjs` as a separate manual integration smoke.
 */

const BASE_URL = 'http://127.0.0.1:10101';

interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

interface RouteHandler {
  (call: RecordedCall): Response | Promise<Response>;
}

/** Build a fake fetch that routes by pathname and records every call. */
function fakeFetch(routes: Record<string, RouteHandler>): {
  fetchImpl: FetchLike;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const fetchImpl: FetchLike = async (input, init) => {
    const call: RecordedCall = {
      url: input,
      method: init?.method ?? 'GET',
      headers: init?.headers ?? {},
      body: init?.body,
    };
    calls.push(call);

    const pathname = new URL(input).pathname;
    const handler = routes[pathname];
    if (!handler) {
      throw new Error(`unexpected request: ${input}`);
    }
    return handler(call);
  };
  return { fetchImpl, calls };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** `BodyInit` in the Next-augmented lib set does not accept a bare Uint8Array. */
function toBody(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

/** Minimal but structurally valid WAV: "RIFF" <size> "WAVE" + payload. */
function wavBytes(payloadLength = 16): Uint8Array {
  const bytes = new Uint8Array(12 + payloadLength);
  bytes.set([0x52, 0x49, 0x46, 0x46], 0); // "RIFF"
  new DataView(bytes.buffer).setUint32(4, 4 + payloadLength, true);
  bytes.set([0x57, 0x41, 0x56, 0x45], 8); // "WAVE"
  return bytes;
}

function wavResponse(payloadLength = 16): Response {
  return new Response(toBody(wavBytes(payloadLength)), {
    status: 200,
    headers: { 'Content-Type': 'audio/wav' },
  });
}

const SPEAKERS_FIXTURE = [
  {
    name: 'Anneli',
    speaker_uuid: 'e756b8e4-b606-4e15-99b1-3f9c6a1b2e1a',
    styles: [
      { name: 'ノーマル', id: 888753760, type: 'talk' },
      { name: 'テンション高め', id: 888753761, type: 'talk' },
    ],
    version: '1.0.0',
    supported_features: { permitted_synthesis_morphing: 'NOTHING' },
  },
  {
    name: 'Test Speaker',
    speaker_uuid: '11111111-2222-3333-4444-555555555555',
    styles: [{ name: 'ノーマル', id: 1, type: 'talk' }],
    version: '0.1.0',
    supported_features: {},
  },
];

/**
 * Deliberately carries fields the app does NOT own — including AivisSpeech-only
 * `tempoDynamicsScale` and an unknown `futureField`. Pass-through is asserted
 * against these.
 */
const AUDIO_QUERY_FIXTURE = {
  accent_phrases: [{ moras: [], accent: 1, pause_mora: null, is_interrogative: false }],
  speedScale: 1.0,
  pitchScale: 0.0,
  intonationScale: 1.0,
  tempoDynamicsScale: 1.0,
  volumeScale: 1.0,
  prePhonemeLength: 0.1,
  postPhonemeLength: 0.1,
  pauseLength: null,
  pauseLengthScale: 1.0,
  outputSamplingRate: 24000,
  outputStereo: true,
  kana: 'テスト',
  futureField: 'unknown-but-must-survive',
};

function createProvider(routes: Record<string, RouteHandler>, baseUrl = BASE_URL) {
  const { fetchImpl, calls } = fakeFetch(routes);
  return { provider: new AivisSpeechProvider({ baseUrl, fetchImpl }), calls };
}

async function expectProviderError(promise: Promise<unknown>): Promise<TTSProviderError> {
  try {
    await promise;
  } catch (caught) {
    expect(caught).toBeInstanceOf(TTSProviderError);
    return caught as TTSProviderError;
  }
  throw new Error('expected the call to reject with a TTSProviderError');
}

describe('normalizeBaseUrl', () => {
  it('strips trailing slashes and surrounding whitespace', () => {
    expect(normalizeBaseUrl('  http://127.0.0.1:10101///  ')).toBe('http://127.0.0.1:10101');
  });
});

describe('URL / request construction', () => {
  it('builds endpoint URLs against the normalized base URL', () => {
    const { provider } = createProvider({}, 'http://127.0.0.1:10101/');
    expect(provider.engineUrl).toBe('http://127.0.0.1:10101');
    expect(provider.buildUrl('/speakers')).toBe('http://127.0.0.1:10101/speakers');
    expect(provider.buildUrl('/audio_query', { text: 'あ い', speaker: '3' })).toBe(
      'http://127.0.0.1:10101/audio_query?text=%E3%81%82+%E3%81%84&speaker=3',
    );
  });

  it('POSTs /audio_query with text + speaker as query params', async () => {
    const { provider, calls } = createProvider({
      '/audio_query': () => jsonResponse(AUDIO_QUERY_FIXTURE),
    });

    await provider.createAudioQuery('こんにちは', 888753760);

    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.method).toBe('POST');
    const url = new URL(call.url);
    expect(url.pathname).toBe('/audio_query');
    expect(url.searchParams.get('text')).toBe('こんにちは');
    expect(url.searchParams.get('speaker')).toBe('888753760');
  });

  it('POSTs /synthesis with the audio query as the JSON body and speaker as a query param', async () => {
    const { provider, calls } = createProvider({
      '/audio_query': () => jsonResponse(AUDIO_QUERY_FIXTURE),
      '/synthesis': () => wavResponse(),
    });

    await provider.generateSpeech({
      text: 'こんにちは',
      styleId: 888753760,
      speedScale: 1.25,
      volumeScale: 0.8,
    });

    const synthesisCall = calls.find((call) => new URL(call.url).pathname === '/synthesis')!;
    expect(synthesisCall.method).toBe('POST');
    expect(synthesisCall.headers['Content-Type']).toBe('application/json');
    expect(new URL(synthesisCall.url).searchParams.get('speaker')).toBe('888753760');
    expect(JSON.parse(synthesisCall.body!)).toMatchObject({
      speedScale: 1.25,
      volumeScale: 0.8,
    });
  });
});

describe('/speakers → internal voice mapping', () => {
  it('flattens (speaker, style) pairs and keeps the engine-side style id', async () => {
    const { provider } = createProvider({ '/speakers': () => jsonResponse(SPEAKERS_FIXTURE) });

    const voices = await provider.listVoices();

    expect(voices).toHaveLength(3);
    expect(voices[0]).toEqual({
      styleId: 888753760,
      speakerName: 'Anneli',
      speakerUuid: 'e756b8e4-b606-4e15-99b1-3f9c6a1b2e1a',
      styleName: 'ノーマル',
      label: 'Anneli / ノーマル',
    });
    expect(voices.map((voice) => voice.styleId)).toEqual([888753760, 888753761, 1]);
  });

  it('returns an empty list when the engine has no voice models, without inventing one', async () => {
    const { provider } = createProvider({ '/speakers': () => jsonResponse([]) });
    await expect(provider.listVoices()).resolves.toEqual([]);
  });

  it('propagates a /speakers HTTP failure as SPEAKERS_FAILED', async () => {
    const { provider } = createProvider({
      '/speakers': () => new Response('internal error', { status: 500 }),
    });

    const error = await expectProviderError(provider.listVoices());
    expect(error.kind).toBe('SPEAKERS_FAILED');
    expect(error.endpoint).toBe('/speakers');
    expect(error.httpStatus).toBe(500);
    expect(error.detail).toContain('internal error');
  });
});

describe('/speakers voice identity is fail-closed', () => {
  const VALID_STYLE = { name: 'ノーマル', id: 888753760, type: 'talk' };
  const VALID_SPEAKER = {
    name: 'Anneli',
    speaker_uuid: 'e756b8e4-b606-4e15-99b1-3f9c6a1b2e1a',
    styles: [VALID_STYLE],
    version: '1.0.0',
  };

  /** Build a /speakers payload from one speaker, with fields overridden or dropped. */
  function speakersPayload(
    speakerOverrides: Record<string, unknown> = {},
    styleOverrides: Record<string, unknown> = {},
  ) {
    const style: Record<string, unknown> = { ...VALID_STYLE, ...styleOverrides };
    for (const [key, value] of Object.entries(styleOverrides)) {
      if (value === undefined) delete style[key];
    }
    const speaker: Record<string, unknown> = {
      ...VALID_SPEAKER,
      styles: [style],
      ...speakerOverrides,
    };
    for (const [key, value] of Object.entries(speakerOverrides)) {
      if (value === undefined) delete speaker[key];
    }
    return [speaker];
  }

  async function expectMalformed(payload: unknown) {
    const { provider } = createProvider({ '/speakers': () => jsonResponse(payload) });
    const error = await expectProviderError(provider.listVoices());
    expect(error.kind).toBe('MALFORMED_RESPONSE');
    expect(error.endpoint).toBe('/speakers');
    return error;
  }

  it('maps a fully valid speaker', async () => {
    const { provider } = createProvider({ '/speakers': () => jsonResponse(speakersPayload()) });

    await expect(provider.listVoices()).resolves.toEqual([
      {
        styleId: 888753760,
        speakerName: 'Anneli',
        speakerUuid: 'e756b8e4-b606-4e15-99b1-3f9c6a1b2e1a',
        styleName: 'ノーマル',
        label: 'Anneli / ノーマル',
      },
    ]);
  });

  const INVALID_NAMES: Array<[string, unknown]> = [
    ['missing', undefined],
    ['null', null],
    ['empty string', ''],
    ['whitespace only', '   '],
    ['not a string', 123],
  ];

  describe('speaker.name', () => {
    for (const [label, value] of INVALID_NAMES) {
      it(`fails when speaker.name is ${label}`, async () => {
        const error = await expectMalformed(speakersPayload({ name: value }));
        expect(error.message).toContain('name');
      });
    }
  });

  describe('speaker.speaker_uuid', () => {
    for (const [label, value] of INVALID_NAMES) {
      it(`fails when speaker.speaker_uuid is ${label}`, async () => {
        const error = await expectMalformed(speakersPayload({ speaker_uuid: value }));
        expect(error.message).toContain('speaker_uuid');
      });
    }
  });

  describe('speaker.styles', () => {
    it('fails when styles is missing', async () => {
      await expectMalformed(speakersPayload({ styles: undefined }));
    });

    it('fails when styles is not an array', async () => {
      await expectMalformed(speakersPayload({ styles: { id: 1 } }));
    });

    it('fails when a style is not an object', async () => {
      await expectMalformed([{ ...VALID_SPEAKER, styles: ['ノーマル'] }]);
    });
  });

  describe('style.name', () => {
    for (const [label, value] of INVALID_NAMES) {
      it(`fails when style.name is ${label}`, async () => {
        const error = await expectMalformed(speakersPayload({}, { name: value }));
        expect(error.message).toContain('name');
      });
    }
  });

  describe('style.id', () => {
    const INVALID_IDS: Array<[string, unknown]> = [
      ['missing', undefined],
      ['null', null],
      ['a string', '888753760'],
      ['not an integer', 1.5],
      ['NaN', Number.NaN],
    ];

    for (const [label, value] of INVALID_IDS) {
      it(`fails when style.id is ${label}`, async () => {
        const error = await expectMalformed(speakersPayload({}, { id: value }));
        expect(error.message).toContain('id');
      });
    }
  });

  it('fails the whole call when any one speaker in the list is invalid', async () => {
    await expectMalformed([
      VALID_SPEAKER,
      { name: 'Broken', speaker_uuid: '', styles: [VALID_STYLE] },
    ]);
  });

  it('never emits a voice with a blank name, uuid or style name', async () => {
    const { provider } = createProvider({
      '/speakers': () => jsonResponse([VALID_SPEAKER]),
    });

    for (const voice of await provider.listVoices()) {
      expect(voice.speakerName.trim()).not.toBe('');
      expect(voice.speakerUuid.trim()).not.toBe('');
      expect(voice.styleName.trim()).not.toBe('');
      expect(Number.isInteger(voice.styleId)).toBe(true);
    }
  });
});

describe('/version', () => {
  it('accepts the bare JSON string AivisSpeech returns', async () => {
    const { provider } = createProvider({ '/version': () => jsonResponse('1.1.0') });
    await expect(provider.getVersion()).resolves.toEqual({ version: '1.1.0', raw: '1.1.0' });
  });

  it('also accepts an object carrying a version field', async () => {
    const { provider } = createProvider({ '/version': () => jsonResponse({ version: '2.0.0' }) });
    const result = await provider.getVersion();
    expect(result.version).toBe('2.0.0');
  });

  it('rejects an unexpected /version shape as MALFORMED_RESPONSE', async () => {
    const { provider } = createProvider({ '/version': () => jsonResponse(42) });
    const error = await expectProviderError(provider.getVersion());
    expect(error.kind).toBe('MALFORMED_RESPONSE');
    expect(error.endpoint).toBe('/version');
  });
});

describe('/aivm_models probe', () => {
  it('summarizes installed models keyed by aivm uuid', async () => {
    const { provider } = createProvider({
      '/aivm_models': () =>
        jsonResponse({
          'a1b2c3d4-0000-0000-0000-000000000000': {
            manifest: {
              name: 'Anneli',
              version: '1.0.0',
              speakers: [{ name: 'Anneli' }],
            },
            is_loaded: true,
          },
        }),
    });

    const probe = await provider.probeAivmModels();
    expect(probe.status).toBe('ok');
    expect(probe.models).toEqual([
      {
        uuid: 'a1b2c3d4-0000-0000-0000-000000000000',
        name: 'Anneli',
        version: '1.0.0',
        speakerCount: 1,
      },
    ]);
  });

  it('reports the failure cause instead of silently returning an empty list', async () => {
    const { provider } = createProvider({
      '/aivm_models': () => new Response('not found', { status: 404 }),
    });

    const probe = await provider.probeAivmModels();
    expect(probe.status).toBe('failed');
    expect(probe.models).toEqual([]);
    expect(probe.error?.httpStatus).toBe(404);
  });

  it('does not let an /aivm_models failure hide the engine version', async () => {
    const { provider } = createProvider({
      '/version': () => jsonResponse('1.1.0'),
      '/aivm_models': () => new Response('nope', { status: 404 }),
    });

    const runtime = await provider.getRuntimeInfo();
    expect(runtime.engineVersion).toBe('1.1.0');
    expect(runtime.engineName).toBe('AivisSpeech');
    expect(runtime.providerDetails.aivmModels.status).toBe('failed');
  });
});

describe('/audio_query error propagation', () => {
  it('maps an HTTP failure to AUDIO_QUERY_FAILED with the engine detail attached', async () => {
    const { provider } = createProvider({
      '/audio_query': () =>
        new Response(JSON.stringify({ detail: 'speaker not found' }), { status: 422 }),
    });

    const error = await expectProviderError(provider.createAudioQuery('テスト', 999));
    expect(error.kind).toBe('AUDIO_QUERY_FAILED');
    expect(error.endpoint).toBe('/audio_query');
    expect(error.httpStatus).toBe(422);
    expect(error.detail).toContain('speaker not found');
  });

  it('stops before /synthesis when /audio_query fails', async () => {
    const { provider, calls } = createProvider({
      '/audio_query': () => new Response('bad request', { status: 400 }),
      '/synthesis': () => wavResponse(),
    });

    const error = await expectProviderError(
      provider.generateSpeech({ text: 'テスト', styleId: 1, speedScale: 1, volumeScale: 1 }),
    );
    expect(error.kind).toBe('AUDIO_QUERY_FAILED');
    expect(calls.map((call) => new URL(call.url).pathname)).toEqual(['/audio_query']);
  });
});

describe('/synthesis error propagation', () => {
  it('maps an HTTP failure to SYNTHESIS_FAILED', async () => {
    const { provider } = createProvider({
      '/audio_query': () => jsonResponse(AUDIO_QUERY_FIXTURE),
      '/synthesis': () => new Response('synthesis crashed', { status: 500 }),
    });

    const error = await expectProviderError(
      provider.generateSpeech({ text: 'テスト', styleId: 1, speedScale: 1, volumeScale: 1 }),
    );
    expect(error.kind).toBe('SYNTHESIS_FAILED');
    expect(error.endpoint).toBe('/synthesis');
    expect(error.httpStatus).toBe(500);
  });
});

describe('WAV response handling', () => {
  it('returns the raw WAV bytes together with the query actually sent', async () => {
    const { provider } = createProvider({
      '/audio_query': () => jsonResponse(AUDIO_QUERY_FIXTURE),
      '/synthesis': () => wavResponse(64),
    });

    const result = await provider.generateSpeech({
      text: 'テスト',
      styleId: 1,
      speedScale: 1.5,
      volumeScale: 0.5,
    });

    expect(result.byteLength).toBe(12 + 64);
    expect(result.audio.byteLength).toBe(12 + 64);
    expect(result.contentType).toBe('audio/wav');
    expect(result.styleId).toBe(1);
    expect(new Uint8Array(result.audio).slice(0, 4)).toEqual(
      new Uint8Array([0x52, 0x49, 0x46, 0x46]),
    );
    expect(Date.parse(result.requestedAt)).not.toBeNaN();
  });
});

describe('AudioQuery pass-through', () => {
  it('overwrites only the owned fields and preserves everything else', () => {
    const { provider } = createProvider({});

    const applied = provider.applyAudioSettings(AUDIO_QUERY_FIXTURE, {
      speedScale: 1.4,
      volumeScale: 0.6,
    });

    // owned by the app
    expect(applied.speedScale).toBe(1.4);
    expect(applied.volumeScale).toBe(0.6);
    expect(applied.outputSamplingRate).toBe(AIVIS_FIXED_OUTPUT_SAMPLING_RATE);
    expect(applied.outputStereo).toBe(AIVIS_FIXED_OUTPUT_STEREO);

    // not surfaced in the UI, and equally not destroyed
    expect(applied.pitchScale).toBe(AUDIO_QUERY_FIXTURE.pitchScale);
    expect(applied.intonationScale).toBe(AUDIO_QUERY_FIXTURE.intonationScale);
    expect(applied.tempoDynamicsScale).toBe(AUDIO_QUERY_FIXTURE.tempoDynamicsScale);
    expect(applied.prePhonemeLength).toBe(AUDIO_QUERY_FIXTURE.prePhonemeLength);
    expect(applied.postPhonemeLength).toBe(AUDIO_QUERY_FIXTURE.postPhonemeLength);
    expect(applied.pauseLength).toBe(AUDIO_QUERY_FIXTURE.pauseLength);
    expect(applied.pauseLengthScale).toBe(AUDIO_QUERY_FIXTURE.pauseLengthScale);
    expect(applied.accent_phrases).toBe(AUDIO_QUERY_FIXTURE.accent_phrases);
    expect(applied.kana).toBe(AUDIO_QUERY_FIXTURE.kana);

    // fields we have never heard of must survive too
    expect(applied.futureField).toBe('unknown-but-must-survive');
  });

  it('does not mutate the AudioQuery the engine returned', () => {
    const { provider } = createProvider({});
    const original = { ...AUDIO_QUERY_FIXTURE };

    provider.applyAudioSettings(original, { speedScale: 2, volumeScale: 2 });

    expect(original.speedScale).toBe(1.0);
    expect(original.outputSamplingRate).toBe(24000);
    expect(original.outputStereo).toBe(true);
  });
});

describe('malformed response handling', () => {
  it('rejects a non-array /speakers payload', async () => {
    const { provider } = createProvider({ '/speakers': () => jsonResponse({ speakers: [] }) });
    const error = await expectProviderError(provider.listVoices());
    expect(error.kind).toBe('MALFORMED_RESPONSE');
    expect(error.endpoint).toBe('/speakers');
  });

  it('rejects a style without a numeric id', async () => {
    const { provider } = createProvider({
      '/speakers': () =>
        jsonResponse([{ name: 'X', speaker_uuid: 'u', styles: [{ name: 'ノーマル' }] }]),
    });
    const error = await expectProviderError(provider.listVoices());
    expect(error.kind).toBe('MALFORMED_RESPONSE');
  });

  it('rejects non-JSON where JSON is expected', async () => {
    const { provider } = createProvider({
      '/speakers': () => new Response('<html>not json</html>', { status: 200 }),
    });
    const error = await expectProviderError(provider.listVoices());
    expect(error.kind).toBe('MALFORMED_RESPONSE');
  });

  it('rejects an /audio_query payload that is not an object', async () => {
    const { provider } = createProvider({ '/audio_query': () => jsonResponse([1, 2, 3]) });
    const error = await expectProviderError(provider.createAudioQuery('テスト', 1));
    expect(error.kind).toBe('MALFORMED_RESPONSE');
    expect(error.endpoint).toBe('/audio_query');
  });

  it('never treats an empty /synthesis body as valid audio', async () => {
    const { provider } = createProvider({
      '/audio_query': () => jsonResponse(AUDIO_QUERY_FIXTURE),
      '/synthesis': () => new Response(toBody(new Uint8Array(0)), { status: 200 }),
    });

    const error = await expectProviderError(
      provider.generateSpeech({ text: 'テスト', styleId: 1, speedScale: 1, volumeScale: 1 }),
    );
    expect(error.kind).toBe('MALFORMED_RESPONSE');
    expect(error.endpoint).toBe('/synthesis');
  });

  it('rejects a /synthesis body that is not RIFF/WAVE', async () => {
    const { provider } = createProvider({
      '/audio_query': () => jsonResponse(AUDIO_QUERY_FIXTURE),
      '/synthesis': () =>
        new Response(toBody(new Uint8Array([0x4f, 0x67, 0x67, 0x53, 0, 0, 0, 0, 0, 0, 0, 0])), {
          status: 200,
        }),
    });

    const error = await expectProviderError(
      provider.generateSpeech({ text: 'テスト', styleId: 1, speedScale: 1, volumeScale: 1 }),
    );
    expect(error.kind).toBe('MALFORMED_RESPONSE');
    expect(error.detail).toContain('byteLength=12');
  });
});

describe('engine connection failure', () => {
  it('maps a rejected fetch to ENGINE_CONNECTION_FAILED', async () => {
    const fetchImpl: FetchLike = () => Promise.reject(new Error('connect ECONNREFUSED'));
    const provider = new AivisSpeechProvider({ baseUrl: BASE_URL, fetchImpl });

    const error = await expectProviderError(provider.listVoices());
    expect(error.kind).toBe('ENGINE_CONNECTION_FAILED');
    expect(error.endpoint).toBe('/speakers');
    expect(error.message).toContain('ECONNREFUSED');
  });

  it('reports a connection failure for every endpoint, not just /speakers', async () => {
    const fetchImpl: FetchLike = () => Promise.reject(new Error('fetch failed'));
    const provider = new AivisSpeechProvider({ baseUrl: BASE_URL, fetchImpl });

    for (const call of [
      provider.getVersion(),
      provider.createAudioQuery('テスト', 1),
      provider.synthesize({}, 1),
    ]) {
      const error = await expectProviderError(call);
      expect(error.kind).toBe('ENGINE_CONNECTION_FAILED');
    }
  });
});

describe('capabilities', () => {
  it('declares WAV / 44100 / mono as fixed for Phase 1', async () => {
    const { provider } = createProvider({});
    const capabilities = await provider.getCapabilities();

    expect(capabilities.providerId).toBe('aivisspeech');
    expect(capabilities.outputFormat).toBe('wav');
    expect(capabilities.fixedSampleRate).toBe(44100);
    expect(capabilities.fixedStereo).toBe(false);
    expect(capabilities.speed.default).toBe(1);
    expect(capabilities.volume.default).toBe(1);
  });
});
