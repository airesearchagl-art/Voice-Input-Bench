import { readFile } from 'node:fs/promises';
import { NextResponse } from 'next/server';
import { createRunStore } from '@/lib/engineConfig';
import { toErrorResponse } from '@/lib/apiError';
import { AUDIO_FILE, RunStoreError } from '@/storage/LocalRunStore';

export const dynamic = 'force-dynamic';

/** Parse a single-range `bytes=` header against a known length. */
export function parseByteRange(
  header: string | null,
  size: number,
): { start: number; end: number } | null | 'unsatisfiable' {
  if (!header) return null;

  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null;

  const [, rawStart, rawEnd] = match;
  if (rawStart === '' && rawEnd === '') return null;

  // `bytes=-N` asks for the last N bytes.
  if (rawStart === '') {
    const suffix = Number(rawEnd);
    if (suffix <= 0) return 'unsatisfiable';
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }

  const start = Number(rawStart);
  if (start >= size) return 'unsatisfiable';
  const end = rawEnd === '' ? size - 1 : Math.min(Number(rawEnd), size - 1);
  if (end < start) return 'unsatisfiable';

  return { start, end };
}

function toArrayBuffer(buffer: Buffer): ArrayBuffer {
  return buffer.buffer.slice(
    buffer.byteOffset,
    buffer.byteOffset + buffer.byteLength,
  ) as ArrayBuffer;
}

/**
 * `GET /api/runs/<run-id>/audio` — the stored canonical WAV for one Run.
 *
 * The run ID arrives from the URL, so it is untrusted. `resolveRunFile` applies
 * both guards before touching the filesystem: the ID must match the
 * server-generated pattern, and the resolved path must stay inside the runs
 * root. Anything else is rejected without a read.
 *
 * Range requests are honoured because that is how a browser's media element
 * fetches audio; without `Accept-Ranges` and 206 support the `<audio>` element
 * can sit in NETWORK_LOADING and never reach a playable state.
 */
export async function GET(_request: Request, context: { params: Promise<{ runId: string }> }) {
  const { runId } = await context.params;

  try {
    const store = createRunStore();
    const audioPath = store.resolveRunFile(runId, AUDIO_FILE);

    let audio: Buffer;
    try {
      audio = await readFile(audioPath);
    } catch (cause) {
      throw new RunStoreError('RUN_NOT_FOUND', `Run ${runId} の音声が見つかりません。`, { cause });
    }

    // Runs are immutable, so the bytes at this URL never change.
    const baseHeaders = {
      'Content-Type': 'audio/wav',
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'private, max-age=31536000, immutable',
      'X-VIB-Run-Id': runId,
    };

    const range = parseByteRange(_request.headers.get('range'), audio.byteLength);

    if (range === 'unsatisfiable') {
      return new NextResponse(null, {
        status: 416,
        headers: { ...baseHeaders, 'Content-Range': `bytes */${audio.byteLength}` },
      });
    }

    if (range) {
      const slice = audio.subarray(range.start, range.end + 1);
      return new NextResponse(toArrayBuffer(Buffer.from(slice)), {
        status: 206,
        headers: {
          ...baseHeaders,
          'Content-Length': String(slice.byteLength),
          'Content-Range': `bytes ${range.start}-${range.end}/${audio.byteLength}`,
        },
      });
    }

    return new NextResponse(toArrayBuffer(audio), {
      status: 200,
      headers: { ...baseHeaders, 'Content-Length': String(audio.byteLength) },
    });
  } catch (caught) {
    return toErrorResponse(caught);
  }
}
