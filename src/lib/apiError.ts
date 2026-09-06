import { NextResponse } from 'next/server';
import { TTSProviderError, type TTSErrorKind } from '@/tts/TTSProvider';
import { BenchmarkError, type BenchmarkErrorKind } from '@/benchmark/generateBenchmark';
import { RunStoreError, type RunStoreErrorKind } from '@/storage/LocalRunStore';

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
  VOICE_NOT_FOUND: 409,
  MODEL_EVIDENCE_UNAVAILABLE: 502,
  MODEL_NOT_FOUND: 409,
  MODEL_AMBIGUOUS: 409,
  MODEL_IDENTITY_INCOMPLETE: 409,
};

const STATUS_BY_STORE_KIND: Record<RunStoreErrorKind, number> = {
  RUN_ALREADY_EXISTS: 409,
  INVALID_RUN_ID: 400,
  PATH_ESCAPES_ROOT: 400,
  RUN_NOT_FOUND: 404,
  WRITE_FAILED: 500,
};

export interface ApiErrorBody {
  ok: false;
  error: {
    kind: TTSErrorKind | BenchmarkErrorKind | RunStoreErrorKind | 'BAD_REQUEST' | 'UNEXPECTED';
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
