import { describe, expect, it } from 'vitest';
import { loadReportPackage, type ReportPackageResponse } from './reportExportLoad';

/**
 * The Report Export button must never show a package for a Run the operator
 * has left, nor a failure from a request that was superseded.
 */

const RUN_A = '20260911T010000000Z-aaaaaaaa';

function packageFor(runId: string): ReportPackageResponse {
  return {
    report_source: { run_id: runId } as ReportPackageResponse['report_source'],
    report_source_json: '{}\n',
    markdown: '# Voice Input Bench Report\n',
    content_sha256: 'a'.repeat(64),
    generated_at: '2026-09-11T00:00:00.000Z',
    filenames: { source: 'x.source.json', markdown: 'x.md' },
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('loadReportPackage', () => {
  it('answers null for an aborted request, however it settles', async () => {
    const outcomes: Array<() => Promise<Response>> = [
      () => Promise.reject(new TypeError('Failed to fetch')),
      async () => json({ ok: false, error: { kind: 'RUN_HASH_MISMATCH', message: 'm' } }, 409),
      async () => json(packageFor(RUN_A)),
      async () => new Response('not json', { status: 200 }),
    ];
    for (const outcome of outcomes) {
      const controller = new AbortController();
      const pending = loadReportPackage(RUN_A, controller.signal, () => {
        controller.abort();
        return outcome();
      });
      expect(await pending).toBeNull();
    }
  });

  it('reports a live request’s package or error', async () => {
    const live = () => new AbortController().signal;
    expect(await loadReportPackage(RUN_A, live(), async () => json(packageFor(RUN_A)))).toEqual({
      status: 'ready',
      report: packageFor(RUN_A),
    });
    expect(
      await loadReportPackage(RUN_A, live(), async () =>
        json({ ok: false, error: { kind: 'REPORT_EVIDENCE_CHANGED_DURING_BUILD', message: 'm' } }, 409),
      ),
    ).toEqual({ status: 'failed', error: { kind: 'REPORT_EVIDENCE_CHANGED_DURING_BUILD', message: 'm' } });
  });

  it('asks once, for the one Run, uncached, under the caller’s signal', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const controller = new AbortController();
    await loadReportPackage('a/b', controller.signal, async (url, init) => {
      calls.push({ url, init });
      return json(packageFor('a/b'));
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('/api/reports/run/a%2Fb');
    expect(calls[0]!.init.cache).toBe('no-store');
    expect(calls[0]!.init.signal).toBe(controller.signal);
  });
});
