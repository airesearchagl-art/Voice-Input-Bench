import { describe, expect, it } from 'vitest';
import { GET } from './cases/route';
import { POST } from './generate/route';
import { BENCHMARK_CASES, getBenchmarkCase } from '@/benchmark/cases';
import { splitCanonicalText } from '@/benchmark/splitter';

/**
 * HTTP-boundary checks for the Benchmark Case surface.
 *
 * The `POST /api/generate` tests here only cover validation that happens before
 * any engine call, so no AivisSpeech Engine is contacted.
 */

interface CasesBody {
  ok: true;
  manualTestId: string;
  targetMaxChars: number;
  cases: Array<{
    id: string;
    title: string;
    intent: string;
    text: string;
    charCount: number;
    expectedSegmentCount: number;
  }>;
}

function generateRequest(body: unknown): Request {
  return new Request('http://localhost/api/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('GET /api/cases', () => {
  it('lists every built-in case with its server-side body', async () => {
    const body = (await (await GET()).json()) as CasesBody;

    expect(body.ok).toBe(true);
    expect(body.manualTestId).toBe('manual');
    expect(body.targetMaxChars).toBe(450);
    expect(body.cases.map((entry) => entry.id)).toEqual(
      BENCHMARK_CASES.map((benchmarkCase) => benchmarkCase.id),
    );

    for (const entry of body.cases) {
      expect(entry.text).toBe(getBenchmarkCase(entry.id)!.text);
    }
  });

  it('reports the segment count the splitter will actually produce', async () => {
    const body = (await (await GET()).json()) as CasesBody;

    for (const entry of body.cases) {
      expect(entry.expectedSegmentCount).toBe(splitCanonicalText(entry.text).length);
    }

    const longCase = body.cases.find((entry) => entry.id === 'architecture-long-001')!;
    const shortCase = body.cases.find((entry) => entry.id === 'architecture-short-001')!;
    expect(longCase.expectedSegmentCount).toBeGreaterThan(1);
    expect(shortCase.expectedSegmentCount).toBe(1);
  });
});

describe('POST /api/generate — test selection', () => {
  it('rejects an unknown testId before contacting the engine', async () => {
    const response = await POST(generateRequest({ testId: 'no-such-case', styleId: 1 }));

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      ok: false,
      error: { kind: 'BAD_REQUEST' },
    });
  });

  it('still requires text for a manual Run', async () => {
    const response = await POST(generateRequest({ testId: 'manual', text: '   ', styleId: 1 }));

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { message: string } };
    expect(body.error.message).toContain('text');
  });

  it('does not require text when a Benchmark Case supplies it', async () => {
    // Empty text plus a valid case must get past text validation. The styleId is
    // deliberately invalid so the request stops at the next check rather than
    // reaching the engine.
    const response = await POST(
      generateRequest({ testId: 'architecture-short-001', text: '', styleId: 'not-a-number' }),
    );

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { message: string } };
    expect(body.error.message).toContain('styleId');
  });

  it('rejects a malformed body', async () => {
    const response = await POST(
      new Request('http://localhost/api/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'not json',
      }),
    );
    expect(response.status).toBe(400);
  });
});
