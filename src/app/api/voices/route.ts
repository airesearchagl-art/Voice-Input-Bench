import { NextResponse } from 'next/server';
import { createAivisProvider } from '@/lib/engineConfig';
import { toErrorResponse } from '@/lib/apiError';

export const dynamic = 'force-dynamic';

/**
 * `GET /api/voices` — voice / style list plus fixed-vs-adjustable capabilities.
 *
 * An engine with no installed voice models returns `[]`. That is a real engine
 * state, not a success, so it is flagged as `NO_VOICES_INSTALLED` for the UI to
 * surface — an empty selector must never look like a working one.
 */
export async function GET() {
  try {
    const provider = createAivisProvider();
    const [voices, capabilities] = await Promise.all([
      provider.listVoices(),
      provider.getCapabilities(),
    ]);

    return NextResponse.json({
      ok: true,
      voices,
      capabilities,
      warning: voices.length === 0 ? ('NO_VOICES_INSTALLED' as const) : null,
    });
  } catch (caught) {
    return toErrorResponse(caught);
  }
}
