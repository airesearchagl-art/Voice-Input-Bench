import { NextResponse } from 'next/server';
import { createAivisProvider } from '@/lib/engineConfig';
import { badRequest, toErrorResponse } from '@/lib/apiError';
import { AIVIS_SPEED_RANGE, AIVIS_VOLUME_RANGE } from '@/tts/AivisSpeechProvider';

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
 * `POST /api/generate` — text → WAV.
 *
 * On success the WAV bytes are streamed back as `audio/wav` so the browser can
 * play them directly. P1-A intentionally does not persist anything; Run Bundle
 * persistence is P1-B.
 *
 * On failure a structured JSON error is returned with the cause category, so
 * the UI can say which stage broke rather than showing a generic failure.
 */
export async function POST(request: Request) {
  let body: GenerateRequestBody;
  try {
    body = (await request.json()) as GenerateRequestBody;
  } catch {
    return badRequest('リクエストボディが JSON として解釈できません。');
  }

  const text = typeof body.text === 'string' ? body.text : '';
  if (text.trim().length === 0) {
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
    const provider = createAivisProvider();
    const result = await provider.generateSpeech({ text, styleId, speedScale, volumeScale });

    return new NextResponse(result.audio, {
      status: 200,
      headers: {
        'Content-Type': result.contentType,
        'Content-Length': String(result.byteLength),
        'Cache-Control': 'no-store',
        'X-VIB-Style-Id': String(result.styleId),
        'X-VIB-Requested-At': result.requestedAt,
      },
    });
  } catch (caught) {
    return toErrorResponse(caught);
  }
}
