import { NextResponse } from 'next/server';
import { BENCHMARK_CASES, MANUAL_TEST_ID } from '@/benchmark/cases';
import { DEFAULT_TARGET_MAX_CHARS, countCodePoints, splitCanonicalText } from '@/benchmark/splitter';

export const dynamic = 'force-dynamic';

/**
 * `GET /api/cases` — the built-in Benchmark Cases.
 *
 * The body is included so the page can show the operator what will be spoken.
 * It is display only: `POST /api/generate` re-reads the case server-side and
 * ignores any text the client sends with a case ID.
 */
export function GET() {
  return NextResponse.json({
    ok: true,
    manualTestId: MANUAL_TEST_ID,
    targetMaxChars: DEFAULT_TARGET_MAX_CHARS,
    cases: BENCHMARK_CASES.map((benchmarkCase) => ({
      id: benchmarkCase.id,
      title: benchmarkCase.title,
      intent: benchmarkCase.intent,
      text: benchmarkCase.text,
      charCount: countCodePoints(benchmarkCase.text),
      expectedSegmentCount: splitCanonicalText(benchmarkCase.text).length,
    })),
  });
}
