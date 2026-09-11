import { NextResponse } from 'next/server';
import {
  createEvaluationStore,
  createResultStore,
  createRunStore,
  createSessionStore,
} from '@/lib/engineConfig';
import { toErrorResponse } from '@/lib/apiError';
import { buildReportPackage } from '@/reports/buildReport';

export const dynamic = 'force-dynamic';

/**
 * `GET /api/reports/run/<run-id>` — a Report package built from current evidence.
 *
 * One response carries both files of the package — the ReportSource JSON and
 * `report.md` — from a single build, so the two can never describe different
 * evidence. Nothing is stored: the package exists once the operator saves it.
 *
 * The Run is verified and every cited artifact hashed twice around a second
 * reading; a Run that does not verify, or evidence that moves mid-build, fails
 * the whole request. No model is called.
 */
export async function GET(
  _request: Request,
  context: { params: Promise<{ runId: string }> },
) {
  const { runId } = await context.params;

  try {
    const report = await buildReportPackage(
      {
        runStore: createRunStore(),
        resultStore: createResultStore(),
        sessionStore: createSessionStore(),
        evaluationStore: createEvaluationStore(),
      },
      runId,
    );
    return NextResponse.json({ ok: true, ...report } as const, {
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (caught) {
    return toErrorResponse(caught);
  }
}
