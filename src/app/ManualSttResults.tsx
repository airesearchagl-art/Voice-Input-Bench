'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { RunCatalogEntry } from '@/results/runEvidence';
import type { IntegrityTrust, StoredResult } from '@/results/resultSchema';
import type { EvaluationV1 } from '@/evaluation/evaluationSchema';
import { DELIVERY_PATHS, STT_TOOL_IDS, type DeliveryPath, type SttToolId } from '@/results/tools';
import {
  applyFailed,
  applyLoaded,
  idleSelection,
  isStillSelected,
  selectTarget,
  type SelectionLoadState,
} from '@/lib/selectionLoad';

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

type ResultEntry =
  | {
      status: 'verified';
      resultId: string;
      result: StoredResult;
      transcript: string;
      integrityTrust: IntegrityTrust;
    }
  | {
      status: 'rejected';
      resultId: string;
      reason: string;
      message: string;
      detail?: string;
      integrityTrust?: IntegrityTrust;
    };

type EvaluationEntry =
  | {
      status: 'verified';
      evaluationId: string;
      evaluation: EvaluationV1;
      referenceText: string;
      hypothesisText: string;
    }
  | {
      status: 'rejected';
      evaluationId: string;
      resultId?: string;
      reason: string;
      message: string;
      detail?: string;
    };

/** Everything the panel shows for one Run, loaded under one generation. */
interface RunPanelData {
  results: ResultEntry[];
  evaluations: EvaluationEntry[];
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

/** Enough digits to tell two close readings apart, without implying precision. */
function formatCer(cer: number): string {
  return cer.toFixed(4);
}

/**
 * raw-char-v1 for one Result.
 *
 * The metrics are shown next to the two texts they came from, because a CER on
 * its own says nothing about *what* differed. This is coverage of a measurement,
 * not a grade: there is no ranking here and no better or worse tool.
 */
function RawEvaluationSection({
  resultId,
  sealed,
  entries,
  busy,
  disabled,
  error,
  onCreate,
}: {
  resultId: string;
  sealed: boolean;
  entries: EvaluationEntry[];
  busy: boolean;
  disabled: boolean;
  error: ApiErrorShape | null;
  onCreate: () => void;
}) {
  if (!sealed) {
    return (
      <div className="raw-eval">
        <h4>Raw Character Evaluation</h4>
        <p className="fixed-note">
          この Result は integrity 署名を持たない legacy (schema v1) のため、
          <strong>raw-char-v1 の strict evaluation 対象外</strong>です。観測としては
          読めますが、tool identity が保存後に編集されていないことを証明できません。
        </p>
      </div>
    );
  }

  return (
    <div className="raw-eval">
      <h4>Raw Character Evaluation</h4>
      <button type="button" className="secondary" onClick={onCreate} disabled={disabled}>
        {busy ? '評価中…' : 'Raw評価を作成'}
      </button>

      {error && <ErrorBox title={`Evaluation（${resultId}）`} error={error} />}

      {entries.length === 0 && (
        <p className="fixed-note">この Result にはまだ raw-char-v1 の評価がありません。</p>
      )}

      {entries.map((entry) =>
        entry.status === 'verified' ? (
          <div key={entry.evaluationId} className="raw-eval-card">
            <dl className="kv compact">
              <dt>Evaluation ID</dt>
              <dd>{entry.evaluation.evaluation_id}</dd>
              <dt>Algorithm</dt>
              <dd>{entry.evaluation.algorithm}</dd>
              <dt>Exact Match</dt>
              <dd>{entry.evaluation.metrics.exact_match ? 'true' : 'false'}</dd>
              <dt>CER</dt>
              <dd>{formatCer(entry.evaluation.metrics.cer)}</dd>
              <dt>Edit Distance</dt>
              <dd>{entry.evaluation.metrics.edit_distance}</dd>
              <dt>S / D / I</dt>
              <dd>
                {entry.evaluation.metrics.substitutions} / {entry.evaluation.metrics.deletions} /{' '}
                {entry.evaluation.metrics.insertions}
              </dd>
              <dt>Reference chars</dt>
              <dd>{entry.evaluation.metrics.reference_chars}</dd>
              <dt>Hypothesis chars</dt>
              <dd>{entry.evaluation.metrics.hypothesis_chars}</dd>
              <dt>Created At</dt>
              <dd>{entry.evaluation.created_at}</dd>
            </dl>

            <div className="raw-eval-texts">
              <div>
                <span className="hint">canonical source（reference）</span>
                <pre className="transcript">{entry.referenceText}</pre>
              </div>
              <div>
                <span className="hint">raw transcript（hypothesis）</span>
                <pre className="transcript">{entry.hypothesisText}</pre>
              </div>
            </div>
          </div>
        ) : (
          <ErrorBox
            key={entry.evaluationId}
            title={entry.evaluationId}
            error={{ kind: entry.reason, message: entry.message, detail: entry.detail }}
          />
        ),
      )}
    </div>
  );
}

type ResultsState = SelectionLoadState<RunPanelData, ApiErrorShape>;

const EMPTY_PANEL: RunPanelData = { results: [], evaluations: [] };

export default function ManualSttResults({ latestRunId }: { latestRunId: string | null }) {
  const [runs, setRuns] = useState<RunCatalogEntry[]>([]);
  const [runsError, setRunsError] = useState<ApiErrorShape | null>(null);

  /**
   * The selected Run with its Results and Evaluations, as one piece of state.
   *
   * Keeping them together is the point: a Result list and a CER are only
   * meaningful next to the Run they were read for, so none of the three can
   * drift apart from the others while a fetch is in flight.
   */
  const [results, setResults] = useState<ResultsState>(() =>
    idleSelection<RunPanelData, ApiErrorShape>(),
  );
  /** Mirrors `results` for the synchronous reads that mint a new generation. */
  const resultsRef = useRef<ResultsState>(results);
  const inFlight = useRef<AbortController | null>(null);

  const [toolId, setToolId] = useState<SttToolId>('windows-standard-voice-input');
  const [customToolName, setCustomToolName] = useState('');
  const [toolVersion, setToolVersion] = useState('');
  const [deliveryPath, setDeliveryPath] = useState<DeliveryPath>('speaker-to-mic');
  const [rawTranscript, setRawTranscript] = useState('');

  const [saving, setSaving] = useState(false);
  /** Carries the Run it belongs to, so a late failure is never read as another Run's. */
  const [saveError, setSaveError] = useState<{ runId: string; error: ApiErrorShape } | null>(null);

  /** The Result currently being evaluated, if any. */
  const [evaluating, setEvaluating] = useState<string | null>(null);
  const [evaluationError, setEvaluationError] = useState<{
    runId: string;
    resultId: string;
    error: ApiErrorShape;
  } | null>(null);

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

  /**
   * Select a Run and load its Results, or clear the selection with `''`.
   *
   * Switching Runs mints a new generation and drops the old view immediately.
   * The in-flight request is aborted, and if its response arrives anyway —
   * abort is a request to stop, not a guarantee — it carries the old generation
   * and `applyLoaded` / `applyFailed` refuse it. Without that, Run A's
   * transcripts could land on screen under Run B's name and audio hash, which
   * is exactly the misattribution this whole page exists to avoid.
   *
   * Re-selecting the same Run is a reload: same guard, new generation.
   */
  const selectRun = useCallback((runId: string) => {
    inFlight.current?.abort();
    const controller = new AbortController();
    inFlight.current = controller;

    const next = selectTarget(resultsRef.current, runId === '' ? null : runId);
    resultsRef.current = next;
    setResults(next);
    // The save form and any evaluation failure belong to the Run on screen.
    setSaveError(null);
    setEvaluationError(null);

    const { requestId, selected } = next;
    if (selected === null) return;

    void (async () => {
      try {
        // Both lists are fetched under the same generation. Loading them
        // separately would let a Run's Evaluations sit next to another Run's
        // Results for as long as one request outlived the other.
        const query = `runId=${encodeURIComponent(selected)}`;
        const [resultsResponse, evaluationsResponse] = await Promise.all([
          fetch(`/api/results?${query}`, { cache: 'no-store', signal: controller.signal }),
          fetch(`/api/evaluations?${query}`, { cache: 'no-store', signal: controller.signal }),
        ]);

        const failed = !resultsResponse.ok ? resultsResponse : !evaluationsResponse.ok ? evaluationsResponse : null;
        if (failed) {
          const error = await readApiError(failed);
          setResults((state) => applyFailed(state, { requestId, selected, error }));
          return;
        }

        const [resultsBody, evaluationsBody] = (await Promise.all([
          resultsResponse.json(),
          evaluationsResponse.json(),
        ])) as [{ results: ResultEntry[] }, { evaluations: EvaluationEntry[] }];

        setResults((state) =>
          applyLoaded(state, {
            requestId,
            selected,
            value: { results: resultsBody.results, evaluations: evaluationsBody.evaluations },
          }),
        );
      } catch (caught) {
        if (caught instanceof DOMException && caught.name === 'AbortError') return;
        setResults((state) =>
          applyFailed(state, {
            requestId,
            selected,
            error: {
              kind: 'UNEXPECTED',
              message: caught instanceof Error ? caught.message : String(caught),
            },
          }),
        );
      }
    })();
  }, []);

  useEffect(() => {
    void loadRuns();
  }, [loadRuns, latestRunId]);

  // A newly generated Run is the one the operator is about to test.
  useEffect(() => {
    if (!latestRunId) return;
    if (resultsRef.current.selected === latestRunId) return;
    if (!runs.some((entry) => entry.runId === latestRunId)) return;
    selectRun(latestRunId);
  }, [latestRunId, runs, selectRun]);

  const selectedRunId = results.selected ?? '';
  const selectedRun = runs.find((entry) => entry.runId === selectedRunId);
  const panel = results.value ?? EMPTY_PANEL;
  const resultEntries = panel.results;
  const resultsError = results.status === 'failed' ? results.error : null;

  /** Verified Evaluations grouped by the Result they measured. */
  const evaluationsByResult = new Map<string, EvaluationEntry[]>();
  for (const entry of panel.evaluations) {
    const resultId = entry.status === 'verified' ? entry.evaluation.result_id : entry.resultId;
    if (!resultId) continue;
    const bucket = evaluationsByResult.get(resultId);
    if (bucket) bucket.push(entry);
    else evaluationsByResult.set(resultId, [entry]);
  }
  /** Rejected Evaluations that name no Result to hang them under. */
  const orphanEvaluations = panel.evaluations.filter(
    (entry) => entry.status === 'rejected' && !entry.resultId,
  );
  // Matches the server: whitespace-only is a real observation, an empty box is
  // not. Trimming here would refuse to record "the tool returned only spaces".
  const canSave =
    selectedRun !== undefined &&
    rawTranscript.length > 0 &&
    (toolId !== 'other' || customToolName.trim().length > 0) &&
    !saving;

  const save = useCallback(async () => {
    if (!selectedRun) return;
    const runId = selectedRun.runId;
    setSaving(true);
    setSaveError(null);
    try {
      const response = await fetch('/api/results', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          runId,
          toolId,
          customToolName: toolId === 'other' ? customToolName : null,
          toolVersion,
          deliveryPath,
          rawTranscript,
        }),
      });
      if (!response.ok) {
        setSaveError({ runId, error: await readApiError(response) });
        return;
      }
      // The Result is written. Everything after this point is about what the
      // operator is looking at now, which may no longer be the Run that was
      // saved — a POST can outlive the selection that started it. Reloading
      // regardless would replace the current Run's Results with this one's, and
      // clearing the box would throw away a transcript typed for another Run.
      if (!isStillSelected(resultsRef.current, runId)) return;
      setRawTranscript('');
      selectRun(runId);
    } catch (caught) {
      setSaveError({
        runId,
        error: {
          kind: 'UNEXPECTED',
          message: caught instanceof Error ? caught.message : String(caught),
        },
      });
    } finally {
      setSaving(false);
    }
  }, [customToolName, deliveryPath, rawTranscript, selectRun, selectedRun, toolId, toolVersion]);

  /**
   * Evaluate one sealed Result against its Run's canonical text.
   *
   * Only the Result ID is sent. Everything the measurement is about is resolved
   * server-side, so nothing this page believes can influence the numbers.
   */
  const createEvaluation = useCallback(
    async (resultId: string, runId: string) => {
      setEvaluating(resultId);
      setEvaluationError(null);
      try {
        const response = await fetch('/api/evaluations', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ resultId }),
        });
        if (!response.ok) {
          setEvaluationError({ runId, resultId, error: await readApiError(response) });
          return;
        }
        // Same guard as saving: the POST can outlive the selection that started
        // it, and reloading this Run now would replace whatever Run the
        // operator has moved to.
        if (!isStillSelected(resultsRef.current, runId)) return;
        selectRun(runId);
      } catch (caught) {
        setEvaluationError({
          runId,
          resultId,
          error: {
            kind: 'UNEXPECTED',
            message: caught instanceof Error ? caught.message : String(caught),
          },
        });
      } finally {
        setEvaluating(null);
      }
    },
    [selectRun],
  );

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
          onChange={(event) => selectRun(event.target.value)}
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
              <ErrorBox
                title={
                  saveError.runId === selectedRunId
                    ? 'Save Result'
                    : `Save Result（${saveError.runId}）`
                }
                error={saveError.error}
              />
            </>
          )}
        </>
      )}

      <div style={{ height: 20 }} />
      <h2>
        Saved Results
        {selectedRun && results.status === 'loaded' ? `（${resultEntries.length} 件）` : ''}
      </h2>

      {resultsError && <ErrorBox title="Results" error={resultsError} />}

      {results.status === 'idle' && (
        <p className="fixed-note">Run を選択すると Result が表示されます。</p>
      )}

      {results.status === 'loading' && <p className="fixed-note">読み込み中…</p>}

      {results.status === 'loaded' && resultEntries.length === 0 && (
        <p className="fixed-note">この Run にはまだ Result がありません。</p>
      )}

      {resultEntries.length > 0 && (
        <div className="transcripts">
          {resultEntries.map((entry) =>
            entry.status === 'verified' ? (
              <article key={entry.resultId} className="transcript-card">
                <h3>{entry.result.tool.name}</h3>
                <dl className="kv compact">
                  <dt>Result ID</dt>
                  <dd>{entry.result.result_id}</dd>
                  <dt>Tool</dt>
                  <dd>
                    {entry.result.tool.id}
                    {entry.result.tool.version ? ` / ${entry.result.tool.version}` : ''}
                  </dd>
                  <dt>Delivery</dt>
                  <dd>{entry.result.capture.delivery_path}</dd>
                  <dt>Captured At</dt>
                  <dd>{entry.result.captured_at}</dd>
                  <dt>Transcript SHA-256</dt>
                  <dd>{entry.result.transcript.sha256}</dd>
                  <dt>Audio SHA-256</dt>
                  <dd>{entry.result.run_evidence.audio_sha256}</dd>
                  <dt>Integrity</dt>
                  <dd>
                    {entry.integrityTrust === 'sealed'
                      ? `sealed (schema v${entry.result.schema_version})`
                      : `未署名 / legacy (schema v${entry.result.schema_version})`}
                  </dd>
                </dl>
                <pre className="transcript">{entry.transcript}</pre>

                <RawEvaluationSection
                  resultId={entry.resultId}
                  sealed={entry.integrityTrust === 'sealed'}
                  entries={evaluationsByResult.get(entry.resultId) ?? []}
                  busy={evaluating === entry.resultId}
                  disabled={evaluating !== null}
                  error={
                    evaluationError && evaluationError.resultId === entry.resultId
                      ? evaluationError.error
                      : null
                  }
                  onCreate={() => void createEvaluation(entry.resultId, selectedRunId)}
                />
              </article>
            ) : (
              // Verification failed. Shown as a problem, never as a transcript
              // that could be read as an observation.
              <article key={entry.resultId} className="transcript-card">
                <h3>検証に失敗した Result</h3>
                <ErrorBox
                  title={entry.resultId}
                  error={{ kind: entry.reason, message: entry.message, detail: entry.detail }}
                />
              </article>
            ),
          )}
        </div>
      )}

      {orphanEvaluations.length > 0 && (
        <>
          <div style={{ height: 12 }} />
          {orphanEvaluations.map((entry) =>
            entry.status === 'rejected' ? (
              <ErrorBox
                key={entry.evaluationId}
                title={entry.evaluationId}
                error={{ kind: entry.reason, message: entry.message, detail: entry.detail }}
              />
            ) : null,
          )}
        </>
      )}
    </section>
  );
}
