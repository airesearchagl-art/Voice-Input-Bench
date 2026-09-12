'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { loadReportPackage, type ReportExportState } from './reportExportLoad';

/**
 * Report Export — the operator-exported Report package for one Run.
 *
 * One request builds both files of the package on the server from the same
 * evidence; this component turns that single response into two downloads and
 * never asks again for the second file, so the JSON and the Markdown always
 * describe the same generation. Nothing is stored by the app: the package
 * exists once the operator saves it.
 */

const EXPORT_NOTE =
  'この Report は保存済み artifact ではなく、現在の Evidence から生成した export package です。' +
  'ReportSource JSON と report.md の 2 ファイルを保存してください。アプリ側には何も保存されません。';

interface Downloads {
  source: string;
  markdown: string;
}

export default function ReportExport({ runId }: { runId: string }) {
  const [state, setState] = useState<ReportExportState>({ status: 'idle' });
  const [downloads, setDownloads] = useState<Downloads | null>(null);
  const inFlight = useRef<AbortController | null>(null);

  // Another Run, or unmount: drop the old package and any request for it.
  useEffect(() => {
    setState({ status: 'idle' });
    return () => inFlight.current?.abort();
  }, [runId]);

  // Object URLs for the current package only; revoked when it is replaced.
  useEffect(() => {
    if (state.status !== 'ready') {
      setDownloads(null);
      return;
    }
    const source = URL.createObjectURL(
      new Blob([state.report.report_source_json], { type: 'application/json;charset=utf-8' }),
    );
    const markdown = URL.createObjectURL(
      new Blob([state.report.markdown], { type: 'text/markdown;charset=utf-8' }),
    );
    setDownloads({ source, markdown });
    return () => {
      URL.revokeObjectURL(source);
      URL.revokeObjectURL(markdown);
    };
  }, [state]);

  const generate = useCallback(() => {
    inFlight.current?.abort();
    const controller = new AbortController();
    inFlight.current = controller;
    setState({ status: 'loading' });
    void loadReportPackage(runId, controller.signal).then((next) => {
      if (next !== null && !controller.signal.aborted) setState(next);
    });
  }, [runId]);

  const report = state.status === 'ready' && state.report.report_source.run_id === runId ? state.report : null;

  return (
    <div className="cmp-aux report-export">
      <h3>Report Export</h3>
      <p className="fixed-note">{EXPORT_NOTE}</p>
      <button type="button" className="secondary" onClick={generate} disabled={state.status === 'loading'}>
        {state.status === 'loading' ? 'Report package を生成中…' : 'Report package を生成'}
      </button>

      {state.status === 'failed' && (
        <div className="alert error" role="alert">
          <span className="kind">Report: {state.error.kind}</span>
          <p>{state.error.message}</p>
          {state.error.detail && <div className="meta">{state.error.detail}</div>}
        </div>
      )}

      {report && downloads && (
        <dl className="kv compact report-export-result">
          <dt>content SHA-256</dt>
          <dd className="mono">{report.content_sha256}</dd>
          <dt>generated_at</dt>
          <dd>
            {report.generated_at}
            <span className="cmp-note">（表示用。content identity には含まれません）</span>
          </dd>
          <dt>ReportSource</dt>
          <dd>
            <a href={downloads.source} download={report.filenames.source}>
              {report.filenames.source}
            </a>
          </dd>
          <dt>Markdown</dt>
          <dd>
            <a href={downloads.markdown} download={report.filenames.markdown}>
              {report.filenames.markdown}
            </a>
          </dd>
        </dl>
      )}
    </div>
  );
}
