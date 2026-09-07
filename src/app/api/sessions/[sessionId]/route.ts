import { NextResponse } from 'next/server';
import { createResultStore, createRunStore, createSessionStore } from '@/lib/engineConfig';
import { toErrorResponse } from '@/lib/apiError';
import { buildSessionComparison } from '@/sessions/comparisonMatrix';

export const dynamic = 'force-dynamic';

/**
 * `GET /api/sessions/<session-id>` — one verified Session with its coverage matrix.
 *
 * The Session is verified (shape, then every Case against a fresh reading of the
 * Run it pins) before the matrix is built. The matrix reports coverage only:
 * which Cases have observations from which tools, with the verified transcripts
 * attached for reading. No score, no ranking, no winner.
 */
export async function GET(
  _request: Request,
  context: { params: Promise<{ sessionId: string }> },
) {
  const { sessionId } = await context.params;

  try {
    const comparison = await buildSessionComparison(
      {
        runStore: createRunStore(),
        resultStore: createResultStore(),
        sessionStore: createSessionStore(),
      },
      sessionId,
    );
    return NextResponse.json({ ok: true, ...comparison } as const);
  } catch (caught) {
    return toErrorResponse(caught);
  }
}
