import { NextResponse } from 'next/server';
import { TTSProviderError, type TTSErrorKind } from '@/tts/TTSProvider';
import { BenchmarkError, type BenchmarkErrorKind } from '@/benchmark/generateBenchmark';
import { RunStoreError, type RunStoreErrorKind } from '@/storage/LocalRunStore';
import { WavError, type WavErrorKind } from '@/audio/wav';
import { SplitterError, type SplitterErrorKind } from '@/benchmark/splitter';
import { ResultStoreError, type ResultStoreErrorKind } from '@/storage/LocalResultStore';
import { RunEvidenceError, type RunEvidenceErrorKind } from '@/results/runEvidence';
import { ToolResolutionError, type ToolResolutionErrorKind } from '@/results/tools';
import { SaveResultError, type SaveResultErrorKind } from '@/results/saveResult';

/**
 * HTTP status per error cause.
 *
 * 503 for "engine unreachable" (the app is fine, the dependency is not),
 * 502 for "the engine answered but the call failed or the contract is off".
 */
const STATUS_BY_PROVIDER_KIND: Record<TTSErrorKind, number> = {
  ENGINE_CONNECTION_FAILED: 503,
  SPEAKERS_FAILED: 502,
  AUDIO_QUERY_FAILED: 502,
  SYNTHESIS_FAILED: 502,
  MALFORMED_RESPONSE: 502,
};

/**
 * 409 where the client's selection no longer matches what the engine reports,
 * 502 where the engine failed to supply the evidence at all.
 */
const STATUS_BY_BENCHMARK_KIND: Record<BenchmarkErrorKind, number> = {
  CASE_NOT_FOUND: 404,
  NO_SEGMENTS: 400,
  VOICE_NOT_FOUND: 409,
  MODEL_EVIDENCE_UNAVAILABLE: 502,
  MODEL_NOT_FOUND: 409,
  MODEL_AMBIGUOUS: 409,
  MODEL_IDENTITY_INCOMPLETE: 409,
};

/**
 * A Result that cannot cite a verified Run is the caller pointing at something
 * that is not there (404) or no longer matches its manifest (409). Neither is a
 * server fault, and neither may produce a Result.
 */
const STATUS_BY_RUN_EVIDENCE_KIND: Record<RunEvidenceErrorKind, number> = {
  RUN_NOT_FOUND: 404,
  RUN_MANIFEST_UNREADABLE: 409,
  RUN_MANIFEST_SCHEMA_UNSUPPORTED: 409,
  RUN_MANIFEST_INCOMPLETE: 409,
  RUN_FILE_MISSING: 409,
  RUN_HASH_MISMATCH: 409,
};

const STATUS_BY_RESULT_STORE_KIND: Record<ResultStoreErrorKind, number> = {
  RESULT_ALREADY_EXISTS: 409,
  INVALID_RESULT_ID: 400,
  RESULT_PATH_ESCAPES_ROOT: 400,
  RESULT_NOT_FOUND: 404,
  RESULT_WRITE_FAILED: 500,
  RESULT_UNREADABLE: 500,
};

const STATUS_BY_STORE_KIND: Record<RunStoreErrorKind, number> = {
  RUN_ALREADY_EXISTS: 409,
  INVALID_RUN_ID: 400,
  PATH_ESCAPES_ROOT: 400,
  RUN_NOT_FOUND: 404,
  WRITE_FAILED: 500,
};

/**
 * WAV assembly problems are the app's own integrity checks failing, not the
 * engine misbehaving — 500, and the Run is never written.
 */
const STATUS_BY_WAV_KIND: Record<WavErrorKind, number> = {
  NOT_RIFF_WAVE: 502,
  TRUNCATED_CHUNK: 502,
  MISSING_FMT: 502,
  MISSING_DATA: 502,
  DATA_NOT_FRAME_ALIGNED: 502,
  // The engine answered, but not with the audio Phase 1 asked for.
  UNSUPPORTED_AUDIO_FORMAT: 502,
  UNEXPECTED_SAMPLE_RATE: 502,
  UNEXPECTED_CHANNEL_COUNT: 502,
  FORMAT_MISMATCH: 500,
  NO_SEGMENT_WAVS: 500,
};

export interface ApiErrorBody {
  ok: false;
  error: {
    kind:
      | TTSErrorKind
      | BenchmarkErrorKind
      | RunStoreErrorKind
      | WavErrorKind
      | SplitterErrorKind
      | RunEvidenceErrorKind
      | ResultStoreErrorKind
      | ToolResolutionErrorKind
      | SaveResultErrorKind
      | 'BAD_REQUEST'
      | 'UNEXPECTED';
    message: string;
    endpoint?: string;
    httpStatus?: number;
    detail?: string;
  };
}

export function badRequest(message: string): NextResponse<ApiErrorBody> {
  return NextResponse.json({ ok: false, error: { kind: 'BAD_REQUEST', message } } as const, {
    status: 400,
  });
}

/**
 * Convert a thrown value into a structured response. Unknown throwables are
 * reported as UNEXPECTED rather than being flattened into a generic 500 with no
 * cause — an error is never swallowed on the way out.
 */
export function toErrorResponse(caught: unknown): NextResponse<ApiErrorBody> {
  if (caught instanceof TTSProviderError) {
    return NextResponse.json({ ok: false, error: caught.toJSON() } as const, {
      status: STATUS_BY_PROVIDER_KIND[caught.kind],
    });
  }

  if (caught instanceof BenchmarkError) {
    return NextResponse.json(
      {
        ok: false,
        error: { kind: caught.kind, message: caught.message, detail: caught.detail },
      } as const,
      { status: STATUS_BY_BENCHMARK_KIND[caught.kind] },
    );
  }

  if (caught instanceof RunEvidenceError) {
    return NextResponse.json(
      {
        ok: false,
        error: { kind: caught.kind, message: caught.message, detail: caught.detail },
      } as const,
      { status: STATUS_BY_RUN_EVIDENCE_KIND[caught.kind] },
    );
  }

  if (caught instanceof ResultStoreError) {
    return NextResponse.json(
      { ok: false, error: { kind: caught.kind, message: caught.message } } as const,
      { status: STATUS_BY_RESULT_STORE_KIND[caught.kind] },
    );
  }

  if (caught instanceof ToolResolutionError || caught instanceof SaveResultError) {
    // The request described a tool, delivery path or transcript the registry
    // does not accept: a bad request, not a failed one.
    return NextResponse.json(
      { ok: false, error: { kind: caught.kind, message: caught.message } } as const,
      { status: 400 },
    );
  }

  if (caught instanceof SplitterError) {
    // The text itself cannot be split within the contract: a property of the
    // input, not a server fault.
    return NextResponse.json(
      {
        ok: false,
        error: { kind: caught.kind, message: caught.message, detail: caught.detail },
      } as const,
      { status: 422 },
    );
  }

  if (caught instanceof WavError) {
    return NextResponse.json(
      {
        ok: false,
        error: { kind: caught.kind, message: caught.message, detail: caught.detail },
      } as const,
      { status: STATUS_BY_WAV_KIND[caught.kind] },
    );
  }

  if (caught instanceof RunStoreError) {
    return NextResponse.json(
      { ok: false, error: { kind: caught.kind, message: caught.message } } as const,
      { status: STATUS_BY_STORE_KIND[caught.kind] },
    );
  }

  const message = caught instanceof Error ? caught.message : String(caught);
  return NextResponse.json({ ok: false, error: { kind: 'UNEXPECTED', message } } as const, {
    status: 500,
  });
}
