import { NextResponse } from 'next/server';
import {
  createEvaluationStore,
  createResultStore,
  createRunStore,
  createSessionStore,
} from '@/lib/engineConfig';
import { badRequest, toErrorResponse } from '@/lib/apiError';
import {
  EVALUATOR_IDS,
  createEvaluation,
  isEvaluatorId,
  listEvaluationsForRun,
} from '@/evaluation/createEvaluation';
import { RAW_CHAR_ALGORITHM } from '@/evaluation/rawChar';

export const dynamic = 'force-dynamic';

function deps() {
  return {
    runStore: createRunStore(),
    resultStore: createResultStore(),
    sessionStore: createSessionStore(),
    evaluationStore: createEvaluationStore(),
  };
}

/**
 * `GET /api/evaluations?runId=<run-id>` — raw character Evaluations for one Run.
 *
 * `runId` is required for the same reason it is on `/api/results`: a CER means
 * nothing without the canonical text it was measured against.
 *
 * Every entry is re-derived on read — the Run and Result are re-verified, and
 * raw-char-v1 is recomputed from the actual bytes and compared to the stored
 * metrics. An entry that no longer reproduces comes back marked `rejected`.
 */
export async function GET(request: Request) {
  const runId = new URL(request.url).searchParams.get('runId');
  if (!runId) {
    return badRequest('runId クエリパラメータが必要です。');
  }

  try {
    return NextResponse.json({
      ok: true,
      runId,
      evaluations: await listEvaluationsForRun(deps(), runId),
    } as const);
  } catch (caught) {
    return toErrorResponse(caught);
  }
}

interface PostEvaluationBody {
  resultId?: unknown;
  evaluatorId?: unknown;
}

/**
 * `POST /api/evaluations` — evaluate one sealed Result.
 *
 * The client sends a Result ID and which evaluator to run. That is all it gets
 * to send: which Run, which canonical text, which tool, and every hash are
 * resolved server-side from disk, because a measurement built from
 * client-supplied metadata would not be a measurement of anything in particular.
 *
 * `evaluatorId` is optional and defaults to `raw-char-v1`, so the P3-A request
 * shape keeps working unchanged. An unrecognized name is refused rather than
 * defaulted — quietly running a different measurement than the one asked for
 * would store a number under the wrong heading.
 */
export async function POST(request: Request) {
  let body: PostEvaluationBody;
  try {
    body = (await request.json()) as PostEvaluationBody;
  } catch {
    return badRequest('リクエストボディが JSON として解釈できません。');
  }

  if (typeof body.resultId !== 'string' || body.resultId.length === 0) {
    return badRequest('resultId が必要です。');
  }

  const evaluatorId = body.evaluatorId ?? RAW_CHAR_ALGORITHM;
  if (!isEvaluatorId(evaluatorId)) {
    return badRequest(`evaluatorId は ${EVALUATOR_IDS.join(' / ')} のいずれかである必要があります。`);
  }

  try {
    const outcome = await createEvaluation({ resultId: body.resultId, evaluatorId }, deps());
    return NextResponse.json(
      {
        ok: true,
        evaluationId: outcome.evaluationId,
        evaluation: outcome.evaluation,
        referenceText: outcome.referenceText,
        hypothesisText: outcome.hypothesisText,
      } as const,
      { status: 201, headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (caught) {
    return toErrorResponse(caught);
  }
}
