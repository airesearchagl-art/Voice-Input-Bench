import { describe, expect, it } from 'vitest';
import type { ComparisonRun } from '@/comparisons/runComparison';
import { loadRunComparison, type ComparisonLoadState } from './runComparisonLoad';

/**
 * A Run the operator has left must never write into the Run now on screen.
 *
 * No renderer is involved: the harness below does exactly what the component's
 * effect does — abort the previous request on every selection, start the next
 * one, and apply only a non-null answer from a controller that is still live.
 * The fakes settle however the test says, independently of the abort, which is
 * how a network failure can arrive just after the selection changed.
 */

const RUN_A = '20260910T010000000Z-aaaaaaaa';
const RUN_B = '20260910T010000000Z-bbbbbbbb';

function comparisonFor(runId: string): ComparisonRun {
  return { run_id: runId } as unknown as ComparisonRun;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** One pending response per request, settled by the test, deaf to aborts. */
function controlledFetch() {
  const pending = new Map<string, Deferred<Response>>();
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const next = deferred<Response>();
    pending.set(url, next);
    return next.promise;
  };
  const settle = (runId: string) => {
    const entry = pending.get(`/api/comparisons/run/${runId}`);
    if (!entry) throw new Error(`no request for ${runId}`);
    return entry;
  };
  return { fetchImpl, settle, calls };
}

/** The component's effect, without React. */
function selectionHarness(fetchImpl: ReturnType<typeof controlledFetch>['fetchImpl']) {
  let state: ComparisonLoadState = { status: 'loading' };
  let current: AbortController | null = null;
  const settled: Array<Promise<void>> = [];
  return {
    get state() {
      return state;
    },
    /** Returns when this selection's own request has settled. */
    select(runId: string): Promise<void> {
      current?.abort();
      const controller = new AbortController();
      current = controller;
      state = { status: 'loading' };
      const done = loadRunComparison(runId, controller.signal, fetchImpl).then((next) => {
        if (next !== null && !controller.signal.aborted) state = next;
      });
      settled.push(done);
      return done;
    },
    async drain() {
      await Promise.all(settled);
    },
  };
}

describe('RunComparison loading across a Run change', () => {
  it('keeps Run B when Run A later fails with a non-abort error', async () => {
    const network = controlledFetch();
    const view = selectionHarness(network.fetchImpl);

    const a = view.select(RUN_A);
    const b = view.select(RUN_B);
    network.settle(RUN_B).resolve(json(comparisonFor(RUN_B)));
    await b;
    expect(view.state).toEqual({ status: 'loaded', comparison: comparisonFor(RUN_B) });

    // A, left pending, now fails with something that is not an AbortError.
    network.settle(RUN_A).reject(new TypeError('Failed to fetch'));
    await a;

    expect(view.state).toEqual({ status: 'loaded', comparison: comparisonFor(RUN_B) });
  });

  it('does not show Run A’s failure while Run B is still loading', async () => {
    const network = controlledFetch();
    const view = selectionHarness(network.fetchImpl);

    const a = view.select(RUN_A);
    const b = view.select(RUN_B);
    network.settle(RUN_A).reject(new TypeError('Failed to fetch'));
    await a;

    expect(view.state).toEqual({ status: 'loading' });

    network.settle(RUN_B).resolve(json(comparisonFor(RUN_B)));
    await b;
    expect(view.state).toEqual({ status: 'loaded', comparison: comparisonFor(RUN_B) });
  });

  it('ignores Run A’s error response and Run A’s data once Run B is selected', async () => {
    for (const late of [
      json({ ok: false, error: { kind: 'RUN_HASH_MISMATCH', message: 'A no longer verifies' } }, 409),
      json(comparisonFor(RUN_A)),
    ]) {
      const network = controlledFetch();
      const view = selectionHarness(network.fetchImpl);

      view.select(RUN_A);
      view.select(RUN_B);
      network.settle(RUN_B).resolve(json(comparisonFor(RUN_B)));
      network.settle(RUN_A).resolve(late);
      await view.drain();

      expect(view.state).toEqual({ status: 'loaded', comparison: comparisonFor(RUN_B) });
    }
  });
});

describe('loadRunComparison', () => {
  it('answers null for an aborted request, however it settles', async () => {
    const outcomes: Array<() => Promise<Response>> = [
      () => Promise.reject(new TypeError('Failed to fetch')),
      () => Promise.reject(new DOMException('aborted', 'AbortError')),
      async () => json({ ok: false, error: { kind: 'RUN_NOT_FOUND', message: 'gone' } }, 404),
      async () => json(comparisonFor(RUN_A)),
      async () => new Response('not json', { status: 200 }),
    ];
    for (const outcome of outcomes) {
      const controller = new AbortController();
      const pending = loadRunComparison(RUN_A, controller.signal, () => {
        controller.abort();
        return outcome();
      });
      expect(await pending).toBeNull();
    }
  });

  it('reports a live request’s outcome', async () => {
    const live = () => new AbortController().signal;

    expect(await loadRunComparison(RUN_A, live(), async () => json(comparisonFor(RUN_A)))).toEqual({
      status: 'loaded',
      comparison: comparisonFor(RUN_A),
    });
    expect(
      await loadRunComparison(RUN_A, live(), async () =>
        json({ ok: false, error: { kind: 'RUN_HASH_MISMATCH', message: 'm', detail: 'd' } }, 409),
      ),
    ).toEqual({
      status: 'failed',
      error: { kind: 'RUN_HASH_MISMATCH', message: 'm', detail: 'd' },
    });
    expect(
      await loadRunComparison(RUN_A, live(), () => Promise.reject(new TypeError('Failed to fetch'))),
    ).toEqual({ status: 'failed', error: { kind: 'UNEXPECTED', message: 'Failed to fetch' } });
    expect(
      await loadRunComparison(RUN_A, live(), async () => new Response('<html>', { status: 502 })),
    ).toEqual({
      status: 'failed',
      error: { kind: 'UNEXPECTED', message: 'サーバーが HTTP 502 を返しました。' },
    });
  });

  it('asks for the one Run, uncached, under the caller’s signal', async () => {
    const network = controlledFetch();
    const controller = new AbortController();
    const pending = loadRunComparison('a/b c', controller.signal, network.fetchImpl);
    network.settle('a%2Fb%20c').resolve(json(comparisonFor('a/b c')));
    await pending;

    expect(network.calls).toHaveLength(1);
    expect(network.calls[0]!.url).toBe('/api/comparisons/run/a%2Fb%20c');
    expect(network.calls[0]!.init.cache).toBe('no-store');
    expect(network.calls[0]!.init.signal).toBe(controller.signal);
  });
});
