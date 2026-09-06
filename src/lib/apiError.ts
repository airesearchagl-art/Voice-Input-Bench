import { NextResponse } from 'next/server';
import { TTSProviderError, type TTSErrorKind } from '@/tts/TTSProvider';

/**
 * HTTP status per error cause.
 *
 * 503 for "engine unreachable" (the app is fine, the dependency is not),
 * 502 for "the engine answered but the call failed or the contract is off".
 */
const STATUS_BY_KIND: Record<TTSErrorKind, number> = {
  ENGINE_CONNECTION_FAILED: 503,
  SPEAKERS_FAILED: 502,
  AUDIO_QUERY_FAILED: 502,
  SYNTHESIS_FAILED: 502,
  MALFORMED_RESPONSE: 502,
};

export interface ApiErrorBody {
  ok: false;
  error: {
    kind: TTSErrorKind | 'BAD_REQUEST' | 'UNEXPECTED';
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
      status: STATUS_BY_KIND[caught.kind],
    });
  }

  const message = caught instanceof Error ? caught.message : String(caught);
  return NextResponse.json(
    { ok: false, error: { kind: 'UNEXPECTED', message } } as const,
    { status: 500 },
  );
}
