import { NextResponse } from 'next/server';
import {
  createEvaluationStore,
  createResultStore,
  createRunStore,
  createSessionStore,
} from '@/lib/engineConfig';
import { toErrorResponse } from '@/lib/apiError';
import { ReportError } from '@/reports/reportErrors';
import { rerenderReport } from '@/reports/rerenderReport';

export const dynamic = 'force-dynamic';

/** Far above any real ReportSource; a guard against being handed something that is not one. */
const MAX_BODY_BYTES = 8 * 1024 * 1024;

/**
 * `POST /api/reports/rerender` — re-check an exported ReportSource.
 *
 * The body is the ReportSource JSON, exactly as exported. It is untrusted: it
 * is validated before any id in it is used, and it can only name ids — never a
 * path. Only the artifacts it names are read; nothing is listed, nothing is
 * written, no model is called.
 *
 * 200 with `status: 'reproduced' | 'changed'` and separate `evidence_changed`
 * and `verification_changed` findings. A moved Run basis, or a Run the current
 * verifier rejects, fails as a whole (409).
 */
export async function POST(request: Request) {
  try {
    const text = await request.text();
    if (Buffer.byteLength(text, 'utf8') > MAX_BODY_BYTES) {
      throw new ReportError('REPORT_SOURCE_TOO_LARGE', 'ReportSource が大きすぎます。');
    }
    let input: unknown;
    try {
      input = JSON.parse(text) as unknown;
    } catch {
      throw new ReportError('REPORT_SOURCE_INVALID', 'ReportSource が JSON として読めません。');
    }

    const outcome = await rerenderReport(
      {
        runStore: createRunStore(),
        resultStore: createResultStore(),
        sessionStore: createSessionStore(),
        evaluationStore: createEvaluationStore(),
      },
      input,
    );
    return NextResponse.json({ ok: true, ...outcome } as const, {
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (caught) {
    return toErrorResponse(caught);
  }
}
