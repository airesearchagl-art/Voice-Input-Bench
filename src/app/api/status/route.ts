import { NextResponse } from 'next/server';
import { createAivisProvider, getAivisEngineUrl } from '@/lib/engineConfig';
import { toErrorResponse } from '@/lib/apiError';

export const dynamic = 'force-dynamic';

/**
 * `GET /api/status` — AivisSpeech connection status + engine version.
 *
 * Reports `/aivm_models` as a nested probe result so a missing or changed
 * AivisSpeech-only endpoint is visible as its own fact, not mistaken for the
 * engine being down.
 */
export async function GET() {
  try {
    const provider = createAivisProvider();
    const runtime = await provider.getRuntimeInfo();

    return NextResponse.json({
      ok: true,
      engineName: runtime.engineName,
      engineVersion: runtime.engineVersion,
      engineUrl: runtime.engineUrl,
      providerId: runtime.providerId,
      aivmModels: runtime.providerDetails.aivmModels,
    } as const);
  } catch (caught) {
    const response = toErrorResponse(caught);
    response.headers.set('X-VIB-Engine-Url', getAivisEngineUrl());
    return response;
  }
}
