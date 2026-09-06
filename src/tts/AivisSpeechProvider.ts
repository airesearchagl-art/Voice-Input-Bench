import {
  TTSProviderError,
  type GenerateSpeechInput,
  type GenerateSpeechResult,
  type TTSCapabilities,
  type TTSErrorKind,
  type TTSProvider,
  type TTSRuntimeInfo,
  type TTSVoice,
} from './TTSProvider';

/**
 * AivisSpeech-specific adapter.
 *
 * The AivisSpeech Engine exposes a VOICEVOX-shaped HTTP API, but it is NOT the
 * same contract (see docs/architecture/phase-1-plan.md §3). Notably:
 *
 *   - `intonationScale` means "emotion strength", not overall pitch
 *   - `tempoDynamicsScale` is AivisSpeech-only
 *   - `pauseLength` / `pauseLengthScale` exist for compatibility but are ignored
 *   - `pitch` / `consonant_length` / `vowel_length` return dummy values
 *   - `/aivm_models` is AivisSpeech-only
 *
 * Therefore the AudioQuery returned by `/audio_query` is treated as an OPAQUE
 * object. We never remap it into a house-defined common type; we only overwrite
 * the four fields the app actually owns, and hand the rest straight back to
 * `/synthesis`. The running engine's Swagger (`/docs`) is the source of truth.
 */

export const AIVIS_PROVIDER_ID = 'aivisspeech';

/** Phase 1 fixes these so Runs stay comparable across sessions. */
export const AIVIS_FIXED_OUTPUT_SAMPLING_RATE = 44100;
export const AIVIS_FIXED_OUTPUT_STEREO = false;

export const AIVIS_SPEED_RANGE = { min: 0.5, max: 2, step: 0.05, default: 1 } as const;
export const AIVIS_VOLUME_RANGE = { min: 0, max: 2, step: 0.05, default: 1 } as const;

const DEFAULT_TIMEOUT_MS = 30_000;
const DETAIL_MAX_LENGTH = 600;

/** Minimal WAV sanity check: "RIFF" .... "WAVE". */
const RIFF_MAGIC = [0x52, 0x49, 0x46, 0x46];
const WAVE_MAGIC = [0x57, 0x41, 0x56, 0x45];

export type FetchLike = (
  input: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
) => Promise<Response>;

export interface AivisSpeechProviderOptions {
  baseUrl: string;
  timeoutMs?: number;
  /** Injected for tests; defaults to global fetch. */
  fetchImpl?: FetchLike;
}

/**
 * One installed AIVM voice model, as reported by `/aivm_models`.
 *
 * `name` and `version` are optional because the engine is the source of truth
 * for them and a missing value is evidence in its own right — callers that need
 * model identity must fail closed on it rather than substitute a placeholder.
 */
export interface AivmModelSummary {
  uuid: string;
  name?: string;
  version?: string;
  speakerCount: number;
  /** Speaker UUIDs this model provides, used to resolve a voice back to a model. */
  speakerUuids: string[];
}

/**
 * Result of probing `/aivm_models`.
 *
 * This endpoint is AivisSpeech-only and is informational for P1-A, so a failure
 * here does not fail the whole status call — but it is reported explicitly with
 * its own cause instead of being silently dropped.
 */
export interface AivmModelsProbe {
  status: 'ok' | 'failed';
  models: AivmModelSummary[];
  error?: { kind: TTSErrorKind; message: string; httpStatus?: number };
}

export interface AivisRuntimeDetails {
  /** Raw `/version` payload, kept as contract evidence. */
  rawVersion: unknown;
  aivmModels: AivmModelsProbe;
}

export type AivisRuntimeInfo = TTSRuntimeInfo & { providerDetails: AivisRuntimeDetails };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function truncate(text: string): string {
  return text.length > DETAIL_MAX_LENGTH ? `${text.slice(0, DETAIL_MAX_LENGTH)}…` : text;
}

function startsWithBytes(bytes: Uint8Array, offset: number, magic: number[]): boolean {
  return magic.every((byte, index) => bytes[offset + index] === byte);
}

export function normalizeBaseUrl(rawUrl: string): string {
  return rawUrl.trim().replace(/\/+$/, '');
}

export class AivisSpeechProvider implements TTSProvider {
  readonly id = AIVIS_PROVIDER_ID;

  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: FetchLike;

  constructor(options: AivisSpeechProviderOptions) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl);
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
  }

  /** Base URL this provider talks to, with any trailing slash removed. */
  get engineUrl(): string {
    return this.baseUrl;
  }

  buildUrl(path: string, query?: Record<string, string>): string {
    const search = query ? `?${new URLSearchParams(query).toString()}` : '';
    return `${this.baseUrl}${path}${search}`;
  }

  private error(
    kind: TTSErrorKind,
    message: string,
    options: { endpoint?: string; httpStatus?: number; detail?: string; cause?: unknown } = {},
  ): TTSProviderError {
    return new TTSProviderError(kind, this.id, message, options);
  }

  /**
   * Perform one engine call.
   *
   * A rejected fetch (engine down, DNS, refused, timeout) always maps to
   * ENGINE_CONNECTION_FAILED. A non-2xx response maps to the endpoint-specific
   * kind supplied by the caller, so callers can tell `/speakers` failures apart
   * from `/synthesis` failures.
   */
  private async request(
    path: string,
    init: {
      method?: string;
      query?: Record<string, string>;
      headers?: Record<string, string>;
      body?: string;
    },
    failureKind: TTSErrorKind,
  ): Promise<Response> {
    const url = this.buildUrl(path, init.query);
    let response: Response;

    try {
      response = await this.fetchImpl(url, {
        method: init.method ?? 'GET',
        headers: init.headers,
        body: init.body,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (cause) {
      const reason = cause instanceof Error ? cause.message : String(cause);
      throw this.error(
        'ENGINE_CONNECTION_FAILED',
        `AivisSpeech Engine に接続できませんでした (${this.baseUrl}${path}): ${reason}`,
        { endpoint: path, cause },
      );
    }

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw this.error(
        failureKind,
        `AivisSpeech Engine が ${path} で HTTP ${response.status} を返しました。`,
        { endpoint: path, httpStatus: response.status, detail: truncate(detail) },
      );
    }

    return response;
  }

  private async readJson(response: Response, endpoint: string): Promise<unknown> {
    const text = await response.text();
    try {
      return JSON.parse(text) as unknown;
    } catch (cause) {
      throw this.error(
        'MALFORMED_RESPONSE',
        `${endpoint} のレスポンスが JSON として解釈できません。`,
        { endpoint, httpStatus: response.status, detail: truncate(text), cause },
      );
    }
  }

  /**
   * `GET /version`
   *
   * AivisSpeech returns a bare JSON string (e.g. `"1.1.0"`). We also accept an
   * object carrying a `version` field rather than hard-failing on a shape the
   * running engine might legitimately use; anything else is MALFORMED_RESPONSE.
   */
  async getVersion(): Promise<{ version: string; raw: unknown }> {
    const response = await this.request('/version', {}, 'MALFORMED_RESPONSE');
    const raw = await this.readJson(response, '/version');

    if (typeof raw === 'string' && raw.trim().length > 0) {
      return { version: raw.trim(), raw };
    }
    if (isPlainObject(raw) && typeof raw.version === 'string' && raw.version.trim().length > 0) {
      return { version: raw.version.trim(), raw };
    }

    throw this.error('MALFORMED_RESPONSE', '/version が想定外の形式を返しました。', {
      endpoint: '/version',
      detail: truncate(JSON.stringify(raw)),
    });
  }

  /**
   * `GET /aivm_models` — AivisSpeech-only.
   *
   * Informational for P1-A. Returns a probe result rather than throwing so that
   * a status check still reports the engine version when this endpoint is
   * absent, but the failure cause is carried explicitly and never dropped.
   */
  async probeAivmModels(): Promise<AivmModelsProbe> {
    try {
      const response = await this.request('/aivm_models', {}, 'MALFORMED_RESPONSE');
      const raw = await this.readJson(response, '/aivm_models');

      if (!isPlainObject(raw)) {
        throw this.error(
          'MALFORMED_RESPONSE',
          '/aivm_models が想定外の形式 (オブジェクト以外) を返しました。',
          { endpoint: '/aivm_models', detail: truncate(JSON.stringify(raw)) },
        );
      }

      const models: AivmModelSummary[] = Object.entries(raw).map(([uuid, entry]) => {
        const manifest = isPlainObject(entry) && isPlainObject(entry.manifest) ? entry.manifest : {};
        // Observed against AivisSpeech Engine 1.1.0-dev: the same speaker shows
        // up in two places with two shapes —
        //   entry.speakers[]    = { speaker: { speaker_uuid, ... }, speaker_info }
        //   manifest.speakers[] = { uuid, local_id, ... }
        // Read both and dedupe, so voice-to-model resolution does not depend on
        // which of the two an engine build happens to populate.
        const speakerEntries = [
          ...(isPlainObject(entry) && Array.isArray(entry.speakers) ? entry.speakers : []),
          ...(Array.isArray(manifest.speakers) ? manifest.speakers : []),
        ];
        const speakerUuids = [
          ...new Set(
            speakerEntries.flatMap((item) => {
              if (!isPlainObject(item)) return [];
              const nested = isPlainObject(item.speaker) ? item.speaker : undefined;
              const found = [item.uuid, item.speaker_uuid, nested?.uuid, nested?.speaker_uuid].find(
                isNonEmptyString,
              );
              return found ? [found] : [];
            }),
          ),
        ];

        return {
          uuid,
          name: isNonEmptyString(manifest.name) ? manifest.name : undefined,
          version: isNonEmptyString(manifest.version) ? manifest.version : undefined,
          // Distinct speakers, not raw entry count: the two lists overlap.
          speakerCount: speakerUuids.length,
          speakerUuids,
        };
      });

      return { status: 'ok', models };
    } catch (caught) {
      const error =
        caught instanceof TTSProviderError
          ? caught
          : this.error('MALFORMED_RESPONSE', String(caught), { endpoint: '/aivm_models' });
      return {
        status: 'failed',
        models: [],
        error: { kind: error.kind, message: error.message, httpStatus: error.httpStatus },
      };
    }
  }

  async getRuntimeInfo(): Promise<AivisRuntimeInfo> {
    const { version, raw } = await this.getVersion();
    const aivmModels = await this.probeAivmModels();

    return {
      providerId: this.id,
      engineName: 'AivisSpeech',
      engineVersion: version,
      engineUrl: this.baseUrl,
      providerDetails: { rawVersion: raw, aivmModels },
    };
  }

  /**
   * `GET /speakers` → internal voice list.
   *
   * One AivisSpeech speaker carries several styles; each style has its own
   * engine-side ID, and that ID is what `/audio_query` and `/synthesis` take.
   * So we flatten to (speaker, style) pairs.
   *
   * Voice identity is validated fail-closed. The AivisSpeech contract requires
   * `speaker.name`, `speaker.speaker_uuid`, `speaker.styles`, `style.name` and
   * `style.id`, so a missing or malformed one is a MALFORMED_RESPONSE — never a
   * voice with a blank name. A voice that cannot be identified cannot be cited
   * later as "the voice this Run used", which is the whole point of recording it.
   *
   * An empty engine response yields an empty list — the caller is responsible
   * for surfacing "no voices installed" explicitly rather than rendering it as
   * a normal, empty selector.
   */
  async listVoices(): Promise<TTSVoice[]> {
    const response = await this.request('/speakers', {}, 'SPEAKERS_FAILED');
    const raw = await this.readJson(response, '/speakers');

    if (!Array.isArray(raw)) {
      throw this.error('MALFORMED_RESPONSE', '/speakers が配列を返しませんでした。', {
        endpoint: '/speakers',
        detail: truncate(JSON.stringify(raw)),
      });
    }

    const voices: TTSVoice[] = [];

    for (const speaker of raw) {
      if (!isPlainObject(speaker)) {
        throw this.error('MALFORMED_RESPONSE', '/speakers の要素がオブジェクトではありません。', {
          endpoint: '/speakers',
          detail: truncate(JSON.stringify(speaker)),
        });
      }

      if (!isNonEmptyString(speaker.name)) {
        throw this.error(
          'MALFORMED_RESPONSE',
          '/speakers の speaker に有効な name がありません。',
          { endpoint: '/speakers', detail: truncate(JSON.stringify(speaker)) },
        );
      }
      if (!isNonEmptyString(speaker.speaker_uuid)) {
        throw this.error(
          'MALFORMED_RESPONSE',
          '/speakers の speaker に有効な speaker_uuid がありません。',
          { endpoint: '/speakers', detail: truncate(JSON.stringify(speaker)) },
        );
      }

      const speakerName = speaker.name;
      const speakerUuid = speaker.speaker_uuid;
      const styles = speaker.styles;

      if (!Array.isArray(styles)) {
        throw this.error('MALFORMED_RESPONSE', '/speakers の styles が配列ではありません。', {
          endpoint: '/speakers',
          detail: truncate(JSON.stringify(speaker)),
        });
      }

      for (const style of styles) {
        if (!isPlainObject(style)) {
          throw this.error('MALFORMED_RESPONSE', '/speakers の style がオブジェクトではありません。', {
            endpoint: '/speakers',
            detail: truncate(JSON.stringify(style)),
          });
        }

        const styleId = style.id;
        if (typeof styleId !== 'number' || !Number.isInteger(styleId)) {
          throw this.error('MALFORMED_RESPONSE', '/speakers の style に有効な id がありません。', {
            endpoint: '/speakers',
            detail: truncate(JSON.stringify(style)),
          });
        }

        if (!isNonEmptyString(style.name)) {
          throw this.error('MALFORMED_RESPONSE', '/speakers の style に有効な name がありません。', {
            endpoint: '/speakers',
            detail: truncate(JSON.stringify(style)),
          });
        }

        voices.push({
          styleId,
          speakerName,
          speakerUuid,
          styleName: style.name,
          label: `${speakerName} / ${style.name}`,
        });
      }
    }

    return voices;
  }

  getCapabilities(): Promise<TTSCapabilities> {
    return Promise.resolve({
      providerId: this.id,
      outputFormat: 'wav',
      fixedSampleRate: AIVIS_FIXED_OUTPUT_SAMPLING_RATE,
      fixedStereo: AIVIS_FIXED_OUTPUT_STEREO,
      speed: { ...AIVIS_SPEED_RANGE },
      volume: { ...AIVIS_VOLUME_RANGE },
    });
  }

  /**
   * `POST /audio_query?text=&speaker=`
   *
   * The returned AudioQuery is deliberately typed as `unknown` and never
   * remapped. Callers pass it straight through to {@link synthesize}.
   */
  async createAudioQuery(text: string, styleId: number): Promise<unknown> {
    const response = await this.request(
      '/audio_query',
      {
        method: 'POST',
        query: { text, speaker: String(styleId) },
        headers: { Accept: 'application/json' },
      },
      'AUDIO_QUERY_FAILED',
    );
    const raw = await this.readJson(response, '/audio_query');

    if (!isPlainObject(raw)) {
      throw this.error(
        'MALFORMED_RESPONSE',
        '/audio_query が AudioQuery オブジェクトを返しませんでした。',
        { endpoint: '/audio_query', detail: truncate(JSON.stringify(raw)) },
      );
    }

    return raw;
  }

  /**
   * Overwrite only the fields the app owns, leaving every other AudioQuery
   * field exactly as the engine produced it.
   *
   * `pitchScale`, `intonationScale`, `tempoDynamicsScale`, `prePhonemeLength`
   * and `postPhonemeLength` are intentionally NOT surfaced in the UI — and are
   * equally intentionally NOT stripped or rebuilt here. Hiding a knob is not
   * the same as destroying the engine's contract.
   */
  applyAudioSettings(
    audioQuery: unknown,
    settings: { speedScale: number; volumeScale: number },
  ): Record<string, unknown> {
    if (!isPlainObject(audioQuery)) {
      throw this.error('MALFORMED_RESPONSE', 'AudioQuery がオブジェクトではありません。', {
        endpoint: '/audio_query',
        detail: truncate(JSON.stringify(audioQuery)),
      });
    }

    return {
      ...audioQuery,
      speedScale: settings.speedScale,
      volumeScale: settings.volumeScale,
      outputSamplingRate: AIVIS_FIXED_OUTPUT_SAMPLING_RATE,
      outputStereo: AIVIS_FIXED_OUTPUT_STEREO,
    };
  }

  /**
   * `POST /synthesis?speaker=` with the AudioQuery as the body → WAV bytes.
   *
   * An empty body, or one lacking a RIFF/WAVE header, is a MALFORMED_RESPONSE.
   * A zero-byte "success" is never passed off as valid audio.
   */
  async synthesize(
    audioQuery: unknown,
    styleId: number,
  ): Promise<{ audio: ArrayBuffer; contentType: string }> {
    const response = await this.request(
      '/synthesis',
      {
        method: 'POST',
        query: { speaker: String(styleId) },
        headers: { 'Content-Type': 'application/json', Accept: 'audio/wav' },
        body: JSON.stringify(audioQuery),
      },
      'SYNTHESIS_FAILED',
    );

    const audio = await response.arrayBuffer();

    if (audio.byteLength === 0) {
      throw this.error('MALFORMED_RESPONSE', '/synthesis が空のレスポンスを返しました。', {
        endpoint: '/synthesis',
        httpStatus: response.status,
      });
    }

    const bytes = new Uint8Array(audio);
    if (
      bytes.byteLength < 12 ||
      !startsWithBytes(bytes, 0, RIFF_MAGIC) ||
      !startsWithBytes(bytes, 8, WAVE_MAGIC)
    ) {
      throw this.error(
        'MALFORMED_RESPONSE',
        '/synthesis のレスポンスが WAV (RIFF/WAVE) ではありません。',
        {
          endpoint: '/synthesis',
          httpStatus: response.status,
          detail: `byteLength=${bytes.byteLength}`,
        },
      );
    }

    return {
      audio,
      contentType: response.headers.get('content-type') ?? 'audio/wav',
    };
  }

  /**
   * Full P1-A flow: `/audio_query` → apply owned settings → `/synthesis`.
   */
  async generateSpeech(input: GenerateSpeechInput): Promise<GenerateSpeechResult> {
    const requestedAt = new Date().toISOString();
    const audioQuery = await this.createAudioQuery(input.text, input.styleId);
    const providerQuery = this.applyAudioSettings(audioQuery, {
      speedScale: input.speedScale,
      volumeScale: input.volumeScale,
    });
    const { audio, contentType } = await this.synthesize(providerQuery, input.styleId);

    return {
      audio,
      contentType,
      byteLength: audio.byteLength,
      styleId: input.styleId,
      providerQuery,
      requestedAt,
    };
  }
}
