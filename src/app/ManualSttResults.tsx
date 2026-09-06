'use client';

import { useCallback, useEffect, useState } from 'react';
import type { RunCatalogEntry } from '@/results/runEvidence';
import type { ResultV1 } from '@/results/resultSchema';
import { DELIVERY_PATHS, STT_TOOL_IDS, type DeliveryPath, type SttToolId } from '@/results/tools';

/**
 * Manual STT Results.
 *
 * P2-A records observations; it does not drive any STT tool. The operator plays
 * a Run's canonical audio into Windows voice input or Aqua Voice themselves and
 * pastes what came back. Nothing here scores anything — two transcripts of the
 * same Run are put side by side so a human can read them.
 */

interface ApiErrorShape {
  kind: string;
  message: string;
  detail?: string;
}

interface ResultEntry {
  result: ResultV1;
  transcript: string;
}

const DELIVERY_PATH_LABELS: Record<DeliveryPath, string> = {
  'speaker-to-mic': 'スピーカー → マイク（実音響）',
  'virtual-audio': '仮想オーディオデバイス',
  other: 'その他',
  unknown: '不明',
};

const TOOL_LABELS: Record<SttToolId, string> = {
  'windows-standard-voice-input': 'Windows 標準音声入力',
  'aqua-voice': 'Aqua Voice',
  other: 'その他（名前を入力）',
};

async function readApiError(response: Response): Promise<ApiErrorShape> {
  try {
    const body: unknown = await response.json();
    if (
      typeof body === 'object' &&
      body !== null &&
      'error' in body &&
      typeof (body as { error: unknown }).error === 'object' &&
      (body as { error: unknown }).error !== null
    ) {
      return (body as { error: ApiErrorShape }).error;
    }
  } catch {
    // fall through
  }
  return { kind: 'UNEXPECTED', message: `サーバーが HTTP ${response.status} を返しました。` };
}

function ErrorBox({ title, error }: { title: string; error: ApiErrorShape }) {
  return (
    <div className="alert error" role="alert">
      <span className="kind">
        {title}: {error.kind}
      </span>
      <p>{error.message}</p>
      {error.detail && <div className="meta">{error.detail}</div>}
    </div>
  );
}

export default function ManualSttResults({ latestRunId }: { latestRunId: string | null }) {
  const [runs, setRuns] = useState<RunCatalogEntry[]>([]);
  const [runsError, setRunsError] = useState<ApiErrorShape | null>(null);
  const [selectedRunId, setSelectedRunId] = useState<string>('');

  const [results, setResults] = useState<ResultEntry[]>([]);
  const [resultsError, setResultsError] = useState<ApiErrorShape | null>(null);

  const [toolId, setToolId] = useState<SttToolId>('windows-standard-voice-input');
  const [customToolName, setCustomToolName] = useState('');
  const [toolVersion, setToolVersion] = useState('');
  const [deliveryPath, setDeliveryPath] = useState<DeliveryPath>('speaker-to-mic');
  const [rawTranscript, setRawTranscript] = useState('');

  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<ApiErrorShape | null>(null);

  const loadRuns = useCallback(async () => {
    // Clear first: a failed reload must not leave a stale Run list that the
    // operator could attach a Result to.
    setRunsError(null);
    setRuns([]);
    try {
      const response = await fetch('/api/runs', { cache: 'no-store' });
      if (!response.ok) {
        setRunsError(await readApiError(response));
        return;
      }
      const body = (await response.json()) as { runs: RunCatalogEntry[] };
      setRuns(body.runs);
    } catch (caught) {
      setRunsError({
        kind: 'UNEXPECTED',
        message: caught instanceof Error ? caught.message : String(caught),
      });
    }
  }, []);

  const loadResults = useCallback(async (runId: string) => {
    setResultsError(null);
    setResults([]);
    if (!runId) return;
    try {
      const response = await fetch(`/api/results?runId=${encodeURIComponent(runId)}`, {
        cache: 'no-store',
      });
      if (!response.ok) {
        setResultsError(await readApiError(response));
        return;
      }
      const body = (await response.json()) as { results: ResultEntry[] };
      setResults(body.results);
    } catch (caught) {
      setResultsError({
        kind: 'UNEXPECTED',
        message: caught instanceof Error ? caught.message : String(caught),
      });
    }
  }, []);

  useEffect(() => {
    void loadRuns();
  }, [loadRuns, latestRunId]);

  // A newly generated Run is the one the operator is about to test.
  useEffect(() => {
    if (latestRunId && runs.some((entry) => entry.runId === latestRunId)) {
      setSelectedRunId(latestRunId);
    }
  }, [latestRunId, runs]);

  useEffect(() => {
    void loadResults(selectedRunId);
  }, [loadResults, selectedRunId]);

  const selectedRun = runs.find((entry) => entry.runId === selectedRunId);
  const canSave =
    selectedRun !== undefined &&
    rawTranscript.trim().length > 0 &&
    (toolId !== 'other' || customToolName.trim().length > 0) &&
    !saving;

  const save = useCallback(async () => {
    if (!selectedRun) return;
    setSaving(true);
    setSaveError(null);
    try {
      const response = await fetch('/api/results', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          runId: selectedRun.runId,
          toolId,
          customToolName: toolId === 'other' ? customToolName : null,
          toolVersion,
          deliveryPath,
          rawTranscript,
        }),
      });
      if (!response.ok) {
        setSaveError(await readApiError(response));
        return;
      }
      setRawTranscript('');
      await loadResults(selectedRun.runId);
    } catch (caught) {
      setSaveError({
        kind: 'UNEXPECTED',
        message: caught instanceof Error ? caught.message : String(caught),
      });
    } finally {
      setSaving(false);
    }
  }, [customToolName, deliveryPath, loadResults, rawTranscript, selectedRun, toolId, toolVersion]);

  return (
    <section className="panel">
      <h2>Manual STT Results</h2>
      <p className="fixed-note">
        保存済み Run の canonical audio を STT ツールへ手動で通し、返ってきたテキストを貼り付けて
        記録します。ツールの自動操作と自動採点は行いません。
      </p>

      <div style={{ height: 12 }} />

      <div className="field">
        <label htmlFor="resultRun">
          Saved Run<span className="hint">manifest schema v2 のみ</span>
        </label>
        <select
          id="resultRun"
          value={selectedRunId}
          onChange={(event) => setSelectedRunId(event.target.value)}
          disabled={runs.length === 0}
        >
          <option value="">
            {runs.length === 0 ? '（対象の Run がありません）' : '— Run を選択 —'}
          </option>
          {runs.map((entry) => (
            <option key={entry.runId} value={entry.runId}>
              {entry.testId} — {entry.runId}（{entry.segmentCount} segment / {entry.voiceLabel}）
            </option>
          ))}
        </select>
        <button
          type="button"
          className="secondary"
          onClick={() => void loadRuns()}
          style={{ marginTop: 8 }}
        >
          Run 一覧を再取得
        </button>
      </div>

      {runsError && <ErrorBox title="Runs" error={runsError} />}

      {selectedRun && (
        <>
          <div className="field">
            <label htmlFor="resultAudio">Canonical Audio</label>
            <audio id="resultAudio" controls src={`/api/runs/${selectedRun.runId}/audio`}>
              お使いのブラウザは audio 要素に対応していません。
            </audio>
            <dl className="kv" style={{ marginTop: 10 }}>
              <dt>Test ID</dt>
              <dd>{selectedRun.testId}</dd>
              <dt>Generated At</dt>
              <dd>{selectedRun.generatedAt}</dd>
              <dt>Audio SHA-256</dt>
              <dd>{selectedRun.audioSha256}</dd>
            </dl>
          </div>

          <div className="field">
            <label htmlFor="toolId">STT Tool</label>
            <select
              id="toolId"
              value={toolId}
              onChange={(event) => setToolId(event.target.value as SttToolId)}
            >
              {STT_TOOL_IDS.map((id) => (
                <option key={id} value={id}>
                  {TOOL_LABELS[id]}
                </option>
              ))}
            </select>
          </div>

          {toolId === 'other' && (
            <div className="field">
              <label htmlFor="customToolName">Tool Name</label>
              <input
                id="customToolName"
                type="text"
                value={customToolName}
                onChange={(event) => setCustomToolName(event.target.value)}
                placeholder="使用したツール名"
              />
            </div>
          )}

          <div className="field">
            <label htmlFor="toolVersion">
              Tool Version<span className="hint">任意</span>
            </label>
            <input
              id="toolVersion"
              type="text"
              value={toolVersion}
              onChange={(event) => setToolVersion(event.target.value)}
              placeholder="例: 24H2 / 1.4.2"
            />
          </div>

          <div className="field">
            <label htmlFor="deliveryPath">Delivery Path</label>
            <select
              id="deliveryPath"
              value={deliveryPath}
              onChange={(event) => setDeliveryPath(event.target.value as DeliveryPath)}
            >
              {DELIVERY_PATHS.map((value) => (
                <option key={value} value={value}>
                  {DELIVERY_PATH_LABELS[value]}
                </option>
              ))}
            </select>
          </div>

          <div className="field">
            <label htmlFor="rawTranscript">
              Raw Transcript<span className="hint">STT 出力をそのまま貼り付け（整形しない）</span>
            </label>
            <textarea
              id="rawTranscript"
              value={rawTranscript}
              onChange={(event) => setRawTranscript(event.target.value)}
              placeholder="STT が返したテキストをそのまま貼り付けてください"
            />
          </div>

          <button type="button" onClick={() => void save()} disabled={!canSave}>
            {saving ? '保存中…' : 'Save Result'}
          </button>

          {saveError && (
            <>
              <div style={{ height: 12 }} />
              <ErrorBox title="Save Result" error={saveError} />
            </>
          )}
        </>
      )}

      <div style={{ height: 20 }} />
      <h2>Saved Results{selectedRun ? `（${results.length} 件）` : ''}</h2>

      {resultsError && <ErrorBox title="Results" error={resultsError} />}

      {!selectedRun && <p className="fixed-note">Run を選択すると Result が表示されます。</p>}

      {selectedRun && results.length === 0 && !resultsError && (
        <p className="fixed-note">この Run にはまだ Result がありません。</p>
      )}

      {results.length > 0 && (
        <div className="transcripts">
          {results.map(({ result, transcript }) => (
            <article key={result.result_id} className="transcript-card">
              <h3>{result.tool.name}</h3>
              <dl className="kv compact">
                <dt>Result ID</dt>
                <dd>{result.result_id}</dd>
                <dt>Tool</dt>
                <dd>
                  {result.tool.id}
                  {result.tool.version ? ` / ${result.tool.version}` : ''}
                </dd>
                <dt>Delivery</dt>
                <dd>{result.capture.delivery_path}</dd>
                <dt>Captured At</dt>
                <dd>{result.captured_at}</dd>
                <dt>Transcript SHA-256</dt>
                <dd>{result.transcript.sha256}</dd>
                <dt>Audio SHA-256</dt>
                <dd>{result.run_evidence.audio_sha256}</dd>
              </dl>
              <pre className="transcript">{transcript}</pre>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
