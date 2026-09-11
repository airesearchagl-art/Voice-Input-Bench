import type { ReportSource } from '@/reports/reportSource';

/**
 * Fetching one Report package, with no way for a superseded request to land.
 *
 * The same rule as `runComparisonLoad.ts`: once the operator has moved to
 * another Run, or asked again, the old request answers `null` however it
 * settles, and `null` writes nothing.
 */

export interface ReportExportError {
  kind: string;
  message: string;
  detail?: string;
}

/** Exactly what one GET returns: both files of the package, from one build. */
export interface ReportPackageResponse {
  report_source: ReportSource;
  report_source_json: string;
  markdown: string;
  content_sha256: string;
  generated_at: string;
  filenames: { source: string; markdown: string };
}

export type ReportExportState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'failed'; error: ReportExportError }
  | { status: 'ready'; report: ReportPackageResponse };

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

async function readApiError(response: Response): Promise<ReportExportError> {
  try {
    const body = (await response.json()) as { error?: ReportExportError };
    if (body.error && typeof body.error.kind === 'string') return body.error;
  } catch {
    // Fall through to the generic shape below.
  }
  return { kind: 'UNEXPECTED', message: `サーバーが HTTP ${response.status} を返しました。` };
}

/**
 * The state to show for `runId`'s package, or `null` when `signal` was aborted
 * before the request settled. Never throws.
 */
export async function loadReportPackage(
  runId: string,
  signal: AbortSignal,
  fetchImpl?: FetchLike,
): Promise<ReportExportState | null> {
  const url = `/api/reports/run/${encodeURIComponent(runId)}`;
  const init: RequestInit = { cache: 'no-store', signal };
  try {
    const response = await (fetchImpl ? fetchImpl(url, init) : fetch(url, init));
    if (!response.ok) {
      const error = await readApiError(response);
      return signal.aborted ? null : { status: 'failed', error };
    }
    const report = (await response.json()) as ReportPackageResponse;
    return signal.aborted ? null : { status: 'ready', report };
  } catch (caught) {
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
