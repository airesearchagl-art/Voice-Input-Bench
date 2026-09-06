/**
 * TTS Provider boundary.
 *
 * A Provider's single responsibility is:
 *
 *   > send a request to a TTS engine and obtain engine info, voice info, and WAV bytes.
 *
 * Providers must NOT do any of the following (see docs/architecture/phase-1-plan.md):
 *   - filesystem persistence
 *   - Manifest generation
 *   - Benchmark Case management
 *   - hash (SHA-256) management
 *   - long-text Run management / splitting
 *   - UI state
 */

/**
 * Error categories. These are deliberately distinguished so that a caller can
 * tell "the engine is unreachable" apart from "the engine answered, but the
 * contract is not what we expected". During the Contract Spike that distinction
 * is itself a deliverable.
 */
export type TTSErrorKind =
  /** Could not reach the engine at all (not running / wrong URL / network). */
  | 'ENGINE_CONNECTION_FAILED'
  /** The engine answered, but listing voices failed. */
  | 'SPEAKERS_FAILED'
  /** The engine answered, but building the audio query failed. */
  | 'AUDIO_QUERY_FAILED'
  /** The engine answered, but synthesis failed. */
  | 'SYNTHESIS_FAILED'
  /** The engine answered, but the payload is not the shape we expect. */
  | 'MALFORMED_RESPONSE';

export interface TTSProviderErrorOptions {
  /** Engine endpoint path involved, e.g. `/audio_query`. */
  endpoint?: string;
  /** HTTP status, when the engine actually produced a response. */
  httpStatus?: number;
  /** Raw engine response body (truncated), kept as evidence. */
  detail?: string;
  cause?: unknown;
}

/**
 * Provider-level error carrying an explicit cause category.
 *
 * Errors are never swallowed: every failure path throws one of these instead of
 * degrading into an empty voice list or empty audio buffer.
 */
export class TTSProviderError extends Error {
  readonly kind: TTSErrorKind;
  readonly providerId: string;
  readonly endpoint?: string;
  readonly httpStatus?: number;
  readonly detail?: string;

  constructor(
    kind: TTSErrorKind,
    providerId: string,
    message: string,
    options: TTSProviderErrorOptions = {},
  ) {
    super(message, { cause: options.cause });
    this.name = 'TTSProviderError';
    this.kind = kind;
    this.providerId = providerId;
    this.endpoint = options.endpoint;
    this.httpStatus = options.httpStatus;
    this.detail = options.detail;
  }

  /** Serializable form for API responses. */
  toJSON(): {
    kind: TTSErrorKind;
    providerId: string;
    message: string;
    endpoint?: string;
    httpStatus?: number;
    detail?: string;
  } {
    return {
      kind: this.kind,
      providerId: this.providerId,
      message: this.message,
      endpoint: this.endpoint,
      httpStatus: this.httpStatus,
      detail: this.detail,
    };
  }
}

export function isTTSProviderError(value: unknown): value is TTSProviderError {
  return value instanceof TTSProviderError;
}

/** Runtime information about the engine backing this provider. */
export interface TTSRuntimeInfo {
  providerId: string;
  /** Human-facing engine name, e.g. "AivisSpeech". */
  engineName: string;
  /** Version string as reported by the engine. */
  engineVersion: string;
  /** Base URL the provider is talking to. */
  engineUrl: string;
  /**
   * Provider-specific runtime details. Opaque at the boundary so that a
   * provider can report engine-specific facts without forcing every other
   * provider to model them.
   */
  providerDetails: unknown;
}

/** A selectable voice. For AivisSpeech this is a (speaker, style) pair. */
export interface TTSVoice {
  /** Engine-side style ID. This is what `/audio_query` and `/synthesis` take. */
  styleId: number;
  speakerName: string;
  speakerUuid: string;
  styleName: string;
  /** Display label, e.g. "Speaker / Style". */
  label: string;
}

export interface TTSValueRange {
  min: number;
  max: number;
  step: number;
  default: number;
}

/** What the provider allows the caller to vary, and what is fixed. */
export interface TTSCapabilities {
  providerId: string;
  outputFormat: 'wav';
  /** Fixed for Phase 1 so that Runs stay comparable. */
  fixedSampleRate: number;
  /** Fixed for Phase 1. */
  fixedStereo: boolean;
  speed: TTSValueRange;
  volume: TTSValueRange;
}

export interface GenerateSpeechInput {
  text: string;
  /** Engine-side style ID obtained from {@link TTSProvider.listVoices}. */
  styleId: number;
  speedScale: number;
  volumeScale: number;
}

export interface GenerateSpeechResult {
  /** Raw WAV bytes as returned by the engine. */
  audio: ArrayBuffer;
  contentType: string;
  byteLength: number;
  styleId: number;
  /**
   * The exact payload sent to the engine's synthesis endpoint, kept opaque.
   *
   * P1-A only returns it in-process. P1-B persists it as `provider-query.json`.
   */
  providerQuery: unknown;
  requestedAt: string;
}

export interface TTSProvider {
  readonly id: string;

  getRuntimeInfo(): Promise<TTSRuntimeInfo>;

  listVoices(): Promise<TTSVoice[]>;

  getCapabilities(): Promise<TTSCapabilities>;

  generateSpeech(input: GenerateSpeechInput): Promise<GenerateSpeechResult>;
}
