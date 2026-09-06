import { NextResponse } from 'next/server';
import { createRunStore } from '@/lib/engineConfig';
import { toErrorResponse } from '@/lib/apiError';
import { listVerifiableRuns } from '@/results/runEvidence';

export const dynamic = 'force-dynamic';

/**
 * `GET /api/runs` — Phase 1 Runs a manual STT Result can be attached to.
 *
 * Read-only. Every entry has already passed the same verification a save
 * performs, so the picker never offers a Run that would be rejected. Runs on an
 * older manifest schema are simply absent rather than migrated.
 */
export async function GET() {
  try {
    return NextResponse.json({
      ok: true,
      runs: await listVerifiableRuns(createRunStore()),
    } as const);
  } catch (caught) {
    return toErrorResponse(caught);
  }
}
