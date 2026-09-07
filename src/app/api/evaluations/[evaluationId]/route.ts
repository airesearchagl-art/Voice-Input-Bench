import { NextResponse } from 'next/server';
import {
  createEvaluationStore,
  createResultStore,
  createRunStore,
  createSessionStore,
} from '@/lib/engineConfig';
import { toErrorResponse } from '@/lib/apiError';
import { loadVerifiedEvaluation } from '@/evaluation/createEvaluation';

export const dynamic = 'force-dynamic';

/**
 * `GET /api/evaluations/<evaluation-id>` — one verified Evaluation.
 *
 * The Run and Result are re-verified and raw-char-v1 is recomputed from their
 * actual bytes before anything is returned. The two texts come back with it, so
 * the numbers can be read next to what produced them rather than on their own.
 */
export async function GET(
  _request: Request,
  context: { params: Promise<{ evaluationId: string }> },
) {
  const { evaluationId } = await context.params;

  try {
    const verified = await loadVerifiedEvaluation(
      {
        runStore: createRunStore(),
        resultStore: createResultStore(),
        sessionStore: createSessionStore(),
        evaluationStore: createEvaluationStore(),
      },
      evaluationId,
    );
    return NextResponse.json({ ok: true, ...verified } as const);
  } catch (caught) {
    return toErrorResponse(caught);
  }
}
