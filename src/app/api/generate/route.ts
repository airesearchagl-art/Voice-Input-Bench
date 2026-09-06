import { NextResponse } from 'next/server';
import { createAivisProvider, createRunStore } from '@/lib/engineConfig';
import { badRequest, toErrorResponse } from '@/lib/apiError';
import { AIVIS_SPEED_RANGE, AIVIS_VOLUME_RANGE } from '@/tts/AivisSpeechProvider';
import { isBlankText, toCanonicalText } from '@/lib/canonicalText';
import { generateBenchmarkRun } from '@/benchmark/generateBenchmark';

export const dynamic = 'force-dynamic';

interface GenerateRequestBody {
  text?: unknown;
  styleId?: unknown;
  speedScale?: unknown;
  volumeScale?: unknown;
}

function parseScale(
  value: unknown,
  range: { min: number; max: number; default: number },
): number | null {
  if (value === undefined || value === null) return range.default;
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed < range.min || parsed > range.max) return null;
  return parsed;
}

/**
 * `POST /api/generate` — text → one immutable Run.
 *
 * The response is Run metadata, not audio: the audio of record is the stored
 * `audio.wav`, served from `/api/runs/<run-id>/audio`. Returning the bytes here
 * too would let the page play something that was never persisted.
 *
 * Only `styleId`, `speedScale` and `volumeScale` are taken from the client.
 * Speaker name, model identity and engine version are resolved server-side from
 * fresh engine evidence in `generateBenchmarkRun`.
 */
export async function POST(request: Request) {
  let body: GenerateRequestBody;
  try {
    body = (await request.json()) as GenerateRequestBody;
  } catch {
    return badRequest('リクエストボディが JSON として解釈できません。');
  }

  const rawText = typeof body.text === 'string' ? body.text : '';
  // trim() decides emptiness only. The untrimmed canonical text is what gets
  // stored, hashed and synthesized.
  if (isBlankText(toCanonicalText(rawText))) {
    return badRequest('text が空です。合成するテキストを入力してください。');
  }

  const styleId = typeof body.styleId === 'number' ? body.styleId : Number(body.styleId);
  if (!Number.isInteger(styleId)) {
    return badRequest('styleId が整数ではありません。Voice / Style を選択してください。');
  }

  const speedScale = parseScale(body.speedScale, AIVIS_SPEED_RANGE);
  if (speedScale === null) {
    return badRequest(
      `speedScale は ${AIVIS_SPEED_RANGE.min} 〜 ${AIVIS_SPEED_RANGE.max} の数値である必要があります。`,
    );
  }

  const volumeScale = parseScale(body.volumeScale, AIVIS_VOLUME_RANGE);
  if (volumeScale === null) {
    return badRequest(
      `volumeScale は ${AIVIS_VOLUME_RANGE.min} 〜 ${AIVIS_VOLUME_RANGE.max} の数値である必要があります。`,
    );
  }

  try {
    const result = await generateBenchmarkRun(
      { rawText, styleId, speedScale, volumeScale },
      { provider: createAivisProvider(), store: createRunStore() },
    );

    return NextResponse.json(
      {
        ok: true,
        runId: result.runId,
        audioUrl: `/api/runs/${result.runId}/audio`,
        manifest: result.manifest,
      } as const,
      { status: 201, headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (caught) {
    return toErrorResponse(caught);
  }
}
