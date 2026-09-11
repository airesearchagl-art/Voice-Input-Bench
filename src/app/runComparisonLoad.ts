import type { ComparisonRun } from '@/comparisons/runComparison';

/**
 * Loading one Run's comparison, with no way for a superseded request to land.
 *
 * Pulled out of the component so the rule can be tested without a renderer, as
 * `selectionLoad.ts` is. The component aborts the previous request whenever
 * the Run changes; this function then answers `null` for that request however
 * it settles — success, an error response, a body that fails to parse, or a
 * rejection that is not an `AbortError` at all (a network failure raised just
 * as the abort lands). `null` means "write nothing", so a Run the operator has
 * left can never put its failure, or its data, on the Run now on screen.
 */

export interface ComparisonApiError {
  kind: string;
  message: string;
  detail?: string;
}

export type ComparisonLoadState =
  | { status: 'loading' }
  | { status: 'failed'; error: ComparisonApiError }
  | { status: 'loaded'; comparison: ComparisonRun };

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

async function readApiError(response: Response): Promise<ComparisonApiError> {
  try {
    const body = (await response.json()) as { error?: ComparisonApiError };
    if (body.error && typeof body.error.kind === 'string') return body.error;
  } catch {
    // Fall through to the generic shape below.
  }
  return { kind: 'UNEXPECTED', message: `サーバーが HTTP ${response.status} を返しました。` };
}

/**
 * The state to show for `runId`, or `null` when `signal` was aborted before the
 * request settled. Never throws.
 */
export async function loadRunComparison(
  runId: string,
  signal: AbortSignal,
  fetchImpl?: FetchLike,
): Promise<ComparisonLoadState | null> {
  const url = `/api/comparisons/run/${encodeURIComponent(runId)}`;
  const init: RequestInit = { cache: 'no-store', signal };
  try {
    const response = await (fetchImpl ? fetchImpl(url, init) : fetch(url, init));
    if (!response.ok) {
      const error = await readApiError(response);
      return signal.aborted ? null : { status: 'failed', error };
    }
    const comparison = (await response.json()) as ComparisonRun;
    return signal.aborted ? null : { status: 'loaded', comparison };
  } catch (caught) {
    // Whatever was thrown, a request that has been superseded writes nothing.
    if (signal.aborted) return null;
    return {
      status: 'failed',
      error: {
        kind: 'UNEXPECTED',
        message: caught instanceof Error ? caught.message : String(caught),
      },
    };
  }
}
