import { NextResponse } from 'next/server';
import { createResultStore, createRunStore } from '@/lib/engineConfig';
import { badRequest, toErrorResponse } from '@/lib/apiError';
import { listResultsForRun, saveManualSttResult } from '@/results/saveResult';
import { DELIVERY_PATHS, STT_TOOL_IDS } from '@/results/tools';

export const dynamic = 'force-dynamic';

interface PostResultBody {
  runId?: unknown;
  toolId?: unknown;
  customToolName?: unknown;
  toolVersion?: unknown;
  deliveryPath?: unknown;
  rawTranscript?: unknown;
}

/**
 * `GET /api/results?runId=<run-id>` — manual STT Results for one Run.
 *
 * `runId` is required: a Result only means something next to the audio it
 * describes, so there is no "all results" listing to browse out of context.
 *
 * Every entry is re-verified on read — against its own directory, its
 * transcript on disk, and a fresh reading of the Run. An entry that fails comes
 * back marked `rejected` rather than as an observation.
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
      results: await listResultsForRun(
        { runStore: createRunStore(), resultStore: createResultStore() },
        runId,
      ),
    } as const);
  } catch (caught) {
    return toErrorResponse(caught);
  }
}

/**
 * `POST /api/results` — record one manual STT observation.
 *
 * The client sends which Run, which tool, how the audio was delivered, and the
 * transcript it pasted. Everything about the Run itself is re-derived
 * server-side from disk in `saveManualSttResult`; nothing the caller claims
 * about the Run is stored.
 */
export async function POST(request: Request) {
  let body: PostResultBody;
  try {
    body = (await request.json()) as PostResultBody;
  } catch {
    return badRequest('リクエストボディが JSON として解釈できません。');
  }

  if (typeof body.runId !== 'string' || body.runId.length === 0) {
    return badRequest('runId が必要です。');
  }
  if (typeof body.rawTranscript !== 'string') {
    return badRequest('rawTranscript が文字列ではありません。');
  }
  if (typeof body.toolId !== 'string') {
    return badRequest(`toolId は ${STT_TOOL_IDS.join(' / ')} のいずれかである必要があります。`);
  }
  if (typeof body.deliveryPath !== 'string') {
    return badRequest(`deliveryPath は ${DELIVERY_PATHS.join(' / ')} のいずれかである必要があります。`);
  }

  const customToolName = typeof body.customToolName === 'string' ? body.customToolName : null;
  const toolVersion = typeof body.toolVersion === 'string' ? body.toolVersion : null;

  try {
    const outcome = await saveManualSttResult(
      {
        runId: body.runId,
        toolId: body.toolId,
        customToolName,
        toolVersion,
        deliveryPath: body.deliveryPath,
        rawTranscript: body.rawTranscript,
      },
      { runStore: createRunStore(), resultStore: createResultStore() },
    );

    return NextResponse.json(
      { ok: true, resultId: outcome.resultId, result: outcome.result } as const,
      { status: 201, headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (caught) {
    return toErrorResponse(caught);
  }
}
