'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { RunCatalogEntry } from '@/results/runEvidence';
import type { MatrixRow, SessionComparison, SessionSummary } from '@/sessions/comparisonMatrix';
import { SESSION_TARGET_TOOLS, type SessionTargetTool } from '@/sessions/sessionSchema';
import {
  applyFailed,
  applyLoaded,
  idleSelection,
  selectTarget,
  type SelectionLoadState,
} from '@/lib/selectionLoad';

/**
 * Benchmark Sessions and the comparison matrix.
 *
 * A Session pins each Benchmark Case to one exact Run, so the transcripts shown
 * side by side are transcripts of the same canonical WAV. The matrix reports
 * coverage — which Cases have been observed with which tool — not accuracy.
 * There is no score here, and no winner.
 */

interface ApiErrorShape {
  kind: string;
  message: string;
  detail?: string;
}

const TOOL_LABELS: Record<SessionTargetTool, string> = {
  'windows-standard-voice-input': 'Windows 標準音声入力',
  'aqua-voice': 'Aqua Voice',
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

function CoverageCell({ row, tool }: { row: MatrixRow; tool: SessionTargetTool }) {
  const cell = row.cells.find((candidate) => candidate.tool === tool);
  if (!cell) return <td>—</td>;

  const parts: string[] = [];
  if (cell.verifiedCount > 0) parts.push(`verified ${cell.verifiedCount}`);
  if (cell.rejectedCount > 0) parts.push(`rejected ${cell.rejectedCount}`);

  return (
    <td className={`coverage ${cell.status}`}>
      {parts.length > 0 ? parts.join(' / ') : 'missing'}
    </td>
  );
}

export default function BenchmarkSessions() {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [sessionsError, setSessionsError] = useState<ApiErrorShape | null>(null);

  const [runs, setRuns] = useState<RunCatalogEntry[]>([]);
  const [selectedRunIds, setSelectedRunIds] = useState<string[]>([]);
  const [name, setName] = useState('');
  const [targetTools, setTargetTools] = useState<SessionTargetTool[]>([...SESSION_TARGET_TOOLS]);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<ApiErrorShape | null>(null);

  // The selection guard: a late response for a previously selected Session must
  // never land on the Session now on screen.
  const [comparison, setComparison] = useState<SelectionLoadState<SessionComparison>>(
    idleSelection<SessionComparison>,
  );
  const comparisonRef = useRef(comparison);
  comparisonRef.current = comparison;
  const inFlight = useRef<AbortController | null>(null);

  const loadSessions = useCallback(async () => {
    setSessionsError(null);
    setSessions([]);
    try {
      const response = await fetch('/api/sessions', { cache: 'no-store' });
      if (!response.ok) {
        setSessionsError(await readApiError(response));
        return;
      }
      const body = (await response.json()) as { sessions: SessionSummary[] };
      setSessions(body.sessions);
    } catch (caught) {
      setSessionsError({
        kind: 'UNEXPECTED',
        message: caught instanceof Error ? caught.message : String(caught),
      });
    }
  }, []);

  const loadRuns = useCallback(async () => {
    setRuns([]);
    try {
      const response = await fetch('/api/runs', { cache: 'no-store' });
      if (!response.ok) return;
      const body = (await response.json()) as { runs: RunCatalogEntry[] };
      setRuns(body.runs);
    } catch {
      setRuns([]);
    }
  }, []);

  useEffect(() => {
    void loadSessions();
    void loadRuns();
  }, [loadRuns, loadSessions]);

  const selectSession = useCallback((sessionId: string) => {
    // Abort the previous request and mint a new generation. Even if the old
    // response still arrives, `applyLoaded` will drop it.
    inFlight.current?.abort();
    const controller = new AbortController();
    inFlight.current = controller;

    const next = selectTarget(comparisonRef.current, sessionId === '' ? null : sessionId);
    comparisonRef.current = next;
    setComparison(next);

    const { requestId, selected } = next;
    if (selected === null) return;

    void (async () => {
      try {
        const response = await fetch(`/api/sessions/${encodeURIComponent(selected)}`, {
          cache: 'no-store',
          signal: controller.signal,
        });
        if (!response.ok) {
          const error = await readApiError(response);
          setComparison((state) => applyFailed(state, { requestId, selected, error: error.message }));
          return;
        }
        const value = (await response.json()) as SessionComparison;
        setComparison((state) => applyLoaded(state, { requestId, selected, value }));
      } catch (caught) {
        if (caught instanceof DOMException && caught.name === 'AbortError') return;
        setComparison((state) =>
          applyFailed(state, {
            requestId,
            selected,
            error: caught instanceof Error ? caught.message : String(caught),
          }),
        );
      }
    })();
  }, []);

  const toggleRun = useCallback((runId: string) => {
    setSelectedRunIds((current) =>
      current.includes(runId) ? current.filter((id) => id !== runId) : [...current, runId],
    );
  }, []);

  const toggleTool = useCallback((tool: SessionTargetTool) => {
    setTargetTools((current) =>
      current.includes(tool) ? current.filter((id) => id !== tool) : [...current, tool],
    );
  }, []);

  // One Run per Benchmark Case. The server enforces this too; blocking it here
  // just avoids a request that is certain to fail.
  const selectedTestIds = selectedRunIds.map(
    (runId) => runs.find((entry) => entry.runId === runId)?.testId ?? runId,
  );
  const duplicateTestId = selectedTestIds.length !== new Set(selectedTestIds).size;
  const canCreate =
    name.trim().length > 0 &&
    selectedRunIds.length > 0 &&
    targetTools.length > 0 &&
    !duplicateTestId &&
    !creating;

  const createSession = useCallback(async () => {
    setCreating(true);
    setCreateError(null);
    try {
      const response = await fetch('/api/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, runIds: selectedRunIds, targetTools }),
      });
      if (!response.ok) {
        setCreateError(await readApiError(response));
        return;
      }
      const body = (await response.json()) as { sessionId: string };
      setName('');
      setSelectedRunIds([]);
      await loadSessions();
      selectSession(body.sessionId);
    } catch (caught) {
      setCreateError({
        kind: 'UNEXPECTED',
        message: caught instanceof Error ? caught.message : String(caught),
      });
    } finally {
      setCreating(false);
    }
  }, [loadSessions, name, selectSession, selectedRunIds, targetTools]);

  const loaded = comparison.status === 'loaded' ? comparison.value : null;

  return (
    <section className="panel">
      <h2>Benchmark Sessions</h2>
      <p className="fixed-note">
        Benchmark Case ごとに 1 つの Run を固定した実験セットです。同じ canonical WAV
        に対する Windows / Aqua Voice の観測状況を Case 横断で見ます。表示は
        <strong>カバレッジ（実施状況）であって精度スコアではありません</strong>。
      </p>

      <div style={{ height: 16 }} />
      <h3 className="subhead">Create Session</h3>

      <div className="field">
        <label htmlFor="sessionName">Session Name</label>
        <input
          id="sessionName"
          type="text"
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="例: 2026-09 建築ドメイン比較"
        />
      </div>

      <div className="field">
        <label>
          Runs<span className="hint">1 Benchmark Case につき 1 Run</span>
        </label>
        {runs.length === 0 ? (
          <p className="fixed-note">選択できる Run がありません。</p>
        ) : (
          <ul className="run-picker">
            {runs.map((entry) => (
              <li key={entry.runId}>
                <label>
                  <input
                    type="checkbox"
                    checked={selectedRunIds.includes(entry.runId)}
                    onChange={() => toggleRun(entry.runId)}
                  />
                  <span>
                    {entry.testId} — {entry.runId}（{entry.segmentCount} segment）
                  </span>
                </label>
              </li>
            ))}
          </ul>
        )}
        {duplicateTestId && (
          <div className="alert warn" role="status">
            <span className="kind">DUPLICATE_TEST_ID</span>
            <p>同じ Benchmark Case の Run が複数選択されています。1 Case につき 1 Run にしてください。</p>
          </div>
        )}
      </div>

      <div className="field">
        <label>Target Tools</label>
        <ul className="run-picker">
          {SESSION_TARGET_TOOLS.map((tool) => (
            <li key={tool}>
              <label>
                <input
                  type="checkbox"
                  checked={targetTools.includes(tool)}
                  onChange={() => toggleTool(tool)}
                />
                <span>{TOOL_LABELS[tool]}</span>
              </label>
            </li>
          ))}
        </ul>
      </div>

      <button type="button" onClick={() => void createSession()} disabled={!canCreate}>
        {creating ? '作成中…' : 'Create Session'}
      </button>
      <p className="fixed-note">Session は作成後に編集できません。</p>

      {createError && (
        <>
          <div style={{ height: 12 }} />
          <ErrorBox title="Create Session" error={createError} />
        </>
      )}

      <div style={{ height: 20 }} />
      <h3 className="subhead">Comparison Matrix</h3>

      <div className="field">
        <label htmlFor="sessionSelect">Session</label>
        <select
          id="sessionSelect"
          value={comparison.selected ?? ''}
          onChange={(event) => selectSession(event.target.value)}
          disabled={sessions.length === 0}
        >
          <option value="">
            {sessions.length === 0 ? '（Session がありません）' : '— Session を選択 —'}
          </option>
          {sessions.map((session) => (
            <option key={session.sessionId} value={session.sessionId}>
              {session.name}（{session.caseCount} case / {session.createdAt}）
            </option>
          ))}
        </select>
      </div>

      {sessionsError && <ErrorBox title="Sessions" error={sessionsError} />}

      {comparison.status === 'loading' && <p className="fixed-note">読み込み中…</p>}

      {comparison.status === 'failed' && comparison.error && (
        <ErrorBox
          title="Session"
          error={{ kind: 'SESSION_UNAVAILABLE', message: comparison.error }}
        />
      )}

      {loaded && (
        <>
          <dl className="kv">
            <dt>Session ID</dt>
            <dd>{loaded.session.session_id}</dd>
            <dt>Created At</dt>
            <dd>{loaded.session.created_at}</dd>
            <dt>Target Tools</dt>
            <dd>{loaded.session.target_tools.join(', ')}</dd>
          </dl>

          <div style={{ height: 12 }} />
          <div className="matrix-wrap">
            <table className="matrix">
              <thead>
                <tr>
                  <th>Case</th>
                  <th>Run / Audio SHA-256</th>
                  {loaded.session.target_tools.map((tool) => (
                    <th key={tool}>{TOOL_LABELS[tool]}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {loaded.rows.map((row) => (
                  <tr key={row.testId}>
                    <td>
                      {row.testId}
                      {row.unattributedRejected.length > 0 && (
                        <div className="unattributed-flag">
                          ⚠ 未帰属の rejected {row.unattributedRejected.length} 件
                        </div>
                      )}
                      {row.legacyUnsealed.length > 0 && (
                        <div className="unattributed-flag">
                          ⚠ 未署名 (legacy v1) {row.legacyUnsealed.length} 件
                        </div>
                      )}
                    </td>
                    <td className="mono">
                      {row.runId}
                      <br />
                      {row.audioSha256.slice(0, 32)}…
                    </td>
                    {loaded.session.target_tools.map((tool) => (
                      <CoverageCell key={tool} row={row} tool={tool} />
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="fixed-note">
            coverage は実施状況の表示です。精度スコア・順位・勝敗判定は行いません。
          </p>

          <div style={{ height: 16 }} />
          {loaded.rows.map((row) => (
            <article key={row.testId} className="case-block">
              <h3 className="subhead">{row.testId}</h3>

              {row.unattributedRejected.length > 0 && (
                <>
                  <p className="fixed-note">
                    以下の Result は tool identity を検証できなかったため、どの tool の
                    coverage にも計上していません。
                  </p>
                  {row.unattributedRejected.map((rejection) => (
                    <ErrorBox
                      key={rejection.resultId}
                      title={rejection.resultId}
                      error={{
                        kind: rejection.reason,
                        message: rejection.message,
                        detail: rejection.detail,
                      }}
                    />
                  ))}
                  <div style={{ height: 12 }} />
                </>
              )}

              {row.legacyUnsealed.length > 0 && (
                <>
                  <p className="fixed-note">
                    以下の Result は integrity 署名を持たない legacy (schema v1) です。観測
                    としては読めますが、tool identity が保存後に編集されていないことを証明
                    できないため、どの tool の coverage にも計上していません。
                  </p>
                  <ul className="legacy-list">
                    {row.legacyUnsealed.map((legacy) => (
                      <li key={legacy.resultId} className="mono">
                        {legacy.resultId} / {legacy.toolId ?? 'tool 不明'} / {legacy.status}
                        {legacy.reason ? ` / ${legacy.reason}` : ''}
                      </li>
                    ))}
                  </ul>
                  <div style={{ height: 12 }} />
                </>
              )}

              <div className="transcripts">
                {row.cells.map((cell) => (
                  <div key={cell.tool} className="transcript-card">
                    <h3>{TOOL_LABELS[cell.tool]}</h3>
                    {cell.verified.length === 0 && cell.rejected.length === 0 && (
                      <p className="fixed-note">未実施</p>
                    )}
                    {cell.verified.map((observation) => (
                      <div key={observation.resultId}>
                        <dl className="kv compact">
                          <dt>Result ID</dt>
                          <dd>{observation.resultId}</dd>
                          <dt>Version</dt>
                          <dd>{observation.toolVersion ?? '—'}</dd>
                          <dt>Delivery</dt>
                          <dd>{observation.deliveryPath}</dd>
                        </dl>
                        <pre className="transcript">{observation.transcript}</pre>
                      </div>
                    ))}
                    {cell.rejected.map((rejection) => (
                      <ErrorBox
                        key={rejection.resultId}
                        title={rejection.resultId}
                        error={{
                          kind: rejection.reason,
                          message: rejection.message,
                          detail: rejection.detail,
                        }}
                      />
                    ))}
                  </div>
                ))}
              </div>
            </article>
          ))}
        </>
      )}
    </section>
  );
}
