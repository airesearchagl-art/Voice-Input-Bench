import { NextResponse } from 'next/server';
import { createResultStore, createRunStore, createSessionStore } from '@/lib/engineConfig';
import { badRequest, toErrorResponse } from '@/lib/apiError';
import { createBenchmarkSession } from '@/sessions/createSession';
import { listVerifiedSessions } from '@/sessions/comparisonMatrix';
import { SESSION_TARGET_TOOLS } from '@/sessions/sessionSchema';

export const dynamic = 'force-dynamic';

function deps() {
  return {
    runStore: createRunStore(),
    resultStore: createResultStore(),
    sessionStore: createSessionStore(),
  };
}

interface PostSessionBody {
  name?: unknown;
  runIds?: unknown;
  targetTools?: unknown;
}

/**
 * `GET /api/sessions` — verified Benchmark Sessions, newest first.
 *
 * Every entry has passed the same verification opening one performs, so the
 * picker never offers a Session whose evidence no longer holds.
 */
export async function GET() {
  try {
    return NextResponse.json({ ok: true, sessions: await listVerifiedSessions(deps()) } as const);
  } catch (caught) {
    return toErrorResponse(caught);
  }
}

/**
 * `POST /api/sessions` — plan one experiment.
 *
 * The body carries a name, Run IDs and target tools. `test_id`,
 * `source_sha256` and `audio_sha256` are resolved server-side from a fresh
 * verification of each Run; anything the caller says about a Run is ignored.
 */
export async function POST(request: Request) {
  let body: PostSessionBody;
  try {
    body = (await request.json()) as PostSessionBody;
  } catch {
    return badRequest('リクエストボディが JSON として解釈できません。');
  }

  if (typeof body.name !== 'string') {
    return badRequest('name が文字列ではありません。');
  }
  if (!Array.isArray(body.runIds)) {
    return badRequest('runIds が配列ではありません。');
  }
  if (!Array.isArray(body.targetTools)) {
    return badRequest(
      `targetTools は ${SESSION_TARGET_TOOLS.join(' / ')} の配列である必要があります。`,
    );
  }

  try {
    const outcome = await createBenchmarkSession(
      { name: body.name, runIds: body.runIds, targetTools: body.targetTools },
      deps(),
    );
    return NextResponse.json(
      { ok: true, sessionId: outcome.sessionId, session: outcome.session } as const,
      { status: 201, headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (caught) {
    return toErrorResponse(caught);
  }
}
