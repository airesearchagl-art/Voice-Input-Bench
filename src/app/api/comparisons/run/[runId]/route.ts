import { NextResponse } from 'next/server';
import {
  createEvaluationStore,
  createResultStore,
  createRunStore,
  createSessionStore,
} from '@/lib/engineConfig';
import { toErrorResponse } from '@/lib/apiError';
import { buildRunComparison } from '@/comparisons/runComparison';

export const dynamic = 'force-dynamic';

/**
 * `GET /api/comparisons/run/<run-id>` — the evidence-aware comparison of one Run.
 *
 * Derived on every request by the one builder, from the same read path as
 * `/api/results` and `/api/evaluations`, and never stored. If the Run does not
 * verify, the whole request fails: nothing about a Run whose artifacts no
 * longer match its manifest is shown in part.
 *
 * Four evaluator readings side by side. No score, no ranking, no winner.
 */
export async function GET(
  _request: Request,
  context: { params: Promise<{ runId: string }> },
) {
  const { runId } = await context.params;

  try {
    const comparison = await buildRunComparison(
      {
        runStore: createRunStore(),
        resultStore: createResultStore(),
        sessionStore: createSessionStore(),
        evaluationStore: createEvaluationStore(),
      },
      runId,
    );
    return NextResponse.json({ ok: true, ...comparison } as const);
  } catch (caught) {
    return toErrorResponse(caught);
  }
}
