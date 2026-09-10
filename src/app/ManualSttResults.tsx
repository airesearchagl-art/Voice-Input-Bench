'use client';

import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import type { RunCatalogEntry } from '@/results/runEvidence';
import type { IntegrityTrust, StoredResult } from '@/results/resultSchema';
import type { EvaluatorId, StoredEvaluation } from '@/evaluation/createEvaluation';
import type {
  CriticalEvaluationV2,
  StoredCriticalEntity,
} from '@/evaluation/criticalEvaluationSchema';
import type { EvaluationV1 } from '@/evaluation/evaluationSchema';
import type { SurfaceEvaluationV3 } from '@/evaluation/surfaceEvaluationSchema';
import type { SemanticEvaluationV4 } from '@/evaluation/semanticEvaluationSchema';
import { DELIVERY_PATHS, STT_TOOL_IDS, type DeliveryPath, type SttToolId } from '@/results/tools';
import {
  SEMANTIC_DECISION_RULES,
  SEMANTIC_INPUT_NOTE,
  semanticDecisionLabel,
  semanticRouteNote,
  semanticRunSummary,
} from './semanticDecisionCopy';
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
      evaluation: StoredEvaluation;
      referenceText: string;
      hypothesisText: string;
      /** Present only for an evaluator that normalized before comparing. */
      normalized?: { reference: string; hypothesis: string };
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

/** A rate reads better as a percentage, with the raw fraction kept beside it. */
function formatRate(rate: number): string {
  return `${(rate * 100).toFixed(1)}%`;
}

type VerifiedEvaluationEntry = Extract<EvaluationEntry, { status: 'verified' }>;

interface RawCharEntry extends VerifiedEvaluationEntry {
  evaluation: EvaluationV1;
}

interface CriticalEntry extends VerifiedEvaluationEntry {
  evaluation: CriticalEvaluationV2;
}

interface SurfaceEntry extends VerifiedEvaluationEntry {
  evaluation: SurfaceEvaluationV3;
}

interface SemanticEntry extends VerifiedEvaluationEntry {
  evaluation: SemanticEvaluationV4;
}

function isVerified(entry: EvaluationEntry): entry is VerifiedEvaluationEntry {
  return entry.status === 'verified';
}

function isCritical(entry: VerifiedEvaluationEntry): entry is CriticalEntry {
  return entry.evaluation.schema_version === 2;
}

function isSurface(entry: VerifiedEvaluationEntry): entry is SurfaceEntry {
  return entry.evaluation.schema_version === 3;
}

function isRawChar(entry: VerifiedEvaluationEntry): entry is RawCharEntry {
  return entry.evaluation.schema_version === 1;
}

function isSemantic(entry: VerifiedEvaluationEntry): entry is SemanticEntry {
  return entry.evaluation.schema_version === 4;
}

/**
 * The evaluator contract as the artifact records it.
 *
 * Rendered field by field from the stored record rather than from a hard-coded
 * list, so an artifact measured under an older contract shows the semantics it
 * actually carries instead of the ones this build happens to implement.
 */
function EvaluatorRows({ evaluation }: { evaluation: StoredEvaluation }) {
  return (
    <>
      <dt>Evaluation ID</dt>
      <dd>{evaluation.evaluation_id}</dd>
      {Object.entries(evaluation.evaluator).map(([field, value]) => (
        <Fragment key={field}>
          <dt>{field === 'id' ? 'Evaluator ID' : field}</dt>
          <dd>{String(value)}</dd>
        </Fragment>
      ))}
    </>
  );
}

/**
 * One entity with the span it was read from.
 *
 * The code point range is shown, not decoration: it is what makes the artifact
 * auditable against the text, so it belongs on screen next to the text it
 * points into.
 */
function EntitySpan({ entity }: { entity: StoredCriticalEntity }) {
  return (
    <>
      <span className="mono">{entity.raw}</span>
      <span className="hint">
        {' '}
        [{entity.start_code_point}–{entity.end_code_point})
      </span>
    </>
  );
}

/**
 * raw-char-v1 for one Result.
 *
 * The metrics are shown next to the two texts they came from, because a CER on
 * its own says nothing about *what* differed. This is coverage of a measurement,
 * not a grade: there is no ranking here and no better or worse tool.
 */
function RawEvaluationSection({
  entries,
  busy,
  disabled,
  onCreate,
}: {
  entries: RawCharEntry[];
  busy: boolean;
  disabled: boolean;
  onCreate: () => void;
}) {
  return (
    <div className="raw-eval">
      <h4>Raw Character Evaluation</h4>
      <button type="button" className="secondary" onClick={onCreate} disabled={disabled}>
        {busy ? '評価中…' : 'Raw評価を作成'}
      </button>

      {entries.length === 0 && (
        <p className="fixed-note">この Result にはまだ raw-char-v1 の評価がありません。</p>
      )}

      {entries.map((entry) => (
        <div key={entry.evaluationId} className="raw-eval-card">
          <dl className="kv compact">
            <EvaluatorRows evaluation={entry.evaluation} />
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
      ))}
    </div>
  );
}

/**
 * surface-normalized-char-v1 for one Result.
 *
 * The same Levenshtein reading as raw-char-v1, over text with the typography
 * folded away. Both normalized texts are shown, because a CER measured on text
 * the reader cannot see is a number they have to take on faith.
 *
 * Deliberately **not** shown: the difference between the raw CER and this one.
 * Subtracting them would produce something that looks like a "formatting error
 * score", and it is not one — the two readings use different denominators and
 * different alignments, and their difference is not a quantity of anything.
 */
function SurfaceEvaluationSection({
  entries,
  busy,
  disabled,
  onCreate,
}: {
  entries: SurfaceEntry[];
  busy: boolean;
  disabled: boolean;
  onCreate: () => void;
}) {
  return (
    <div className="raw-eval">
      <h4>Surface-Normalized Character Evaluation</h4>
      <button type="button" className="secondary" onClick={onCreate} disabled={disabled}>
        {busy ? '評価中…' : 'Surface評価を作成'}
      </button>

      {entries.length === 0 && (
        <p className="fixed-note">
          この Result にはまだ surface-normalized-char-v1 の評価がありません。
        </p>
      )}

      {entries.map((entry) => (
        <div key={entry.evaluationId} className="raw-eval-card">
          <dl className="kv compact">
            <EvaluatorRows evaluation={entry.evaluation} />
            <dt>Exact Match</dt>
            <dd>{entry.evaluation.metrics.exact_match ? 'true' : 'false'}</dd>
            <dt>Surface CER</dt>
            <dd>{formatCer(entry.evaluation.metrics.cer)}</dd>
            <dt>Edit Distance</dt>
            <dd>{entry.evaluation.metrics.edit_distance}</dd>
            <dt>S / D / I</dt>
            <dd>
              {entry.evaluation.metrics.substitutions} / {entry.evaluation.metrics.deletions} /{' '}
              {entry.evaluation.metrics.insertions}
            </dd>
            <dt>Normalized reference chars</dt>
            <dd>{entry.evaluation.normalized.reference.chars}</dd>
            <dt>Normalized hypothesis chars</dt>
            <dd>{entry.evaluation.normalized.hypothesis.chars}</dd>
            <dt>Created At</dt>
            <dd>{entry.evaluation.created_at}</dd>
          </dl>

          <p className="fixed-note">
            Raw CER との差は <strong>Formatting Error 等の score ではありません</strong>。
            2 つは別の分母と別の alignment による別の読みで、その差は何かの量ではありません。
          </p>

          <div className="raw-eval-texts">
            <div>
              <span className="hint">normalized source（reference）</span>
              <pre className="transcript">{entry.normalized?.reference ?? ''}</pre>
            </div>
            <div>
              <span className="hint">normalized transcript（hypothesis）</span>
              <pre className="transcript">{entry.normalized?.hypothesis ?? ''}</pre>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * critical-info-v1 for one Result.
 *
 * A preservation rate on its own would be the least useful number on the page,
 * so the entities are listed with it: which facts were matched, which the
 * transcript lost, and which it introduced. The surfaces are shown as written
 * on both sides, because 「2700mm」 preserving 「二千七百ミリ」 is exactly the
 * kind of thing an operator wants to see rather than take on trust.
 */
function CriticalEvaluationSection({
  entries,
  busy,
  disabled,
  onCreate,
}: {
  entries: CriticalEntry[];
  busy: boolean;
  disabled: boolean;
  onCreate: () => void;
}) {
  return (
    <div className="raw-eval">
      <h4>Critical Information Evaluation</h4>
      <button type="button" className="secondary" onClick={onCreate} disabled={disabled}>
        {busy ? '評価中…' : 'Critical情報を評価'}
      </button>

      {entries.length === 0 && (
        <p className="fixed-note">この Result にはまだ critical-info-v1 の評価がありません。</p>
      )}

      {entries.map((entry) => {
        const { metrics } = entry.evaluation;
        return (
          <div key={entry.evaluationId} className="raw-eval-card">
            <dl className="kv compact">
              <EvaluatorRows evaluation={entry.evaluation} />
              <dt>Matched / Missing / Extra</dt>
              <dd>
                {metrics.matched} / {metrics.missing} / {metrics.extra}
              </dd>
              <dt>Preservation Rate</dt>
              <dd>
                {formatRate(metrics.preservation_rate)}（{metrics.matched} /{' '}
                {metrics.reference_entities}）
              </dd>
              <dt>Reference entities</dt>
              <dd>{metrics.reference_entities}</dd>
              <dt>Hypothesis entities</dt>
              <dd>{metrics.hypothesis_entities}</dd>
              <dt>Exact multiset match</dt>
              <dd>{metrics.exact_entity_multiset_match ? 'true' : 'false'}</dd>
              <dt>Created At</dt>
              <dd>{entry.evaluation.created_at}</dd>
            </dl>

            <div className="entity-block">
              <span className="hint">matched entities（reference → hypothesis）</span>
              {entry.evaluation.matches.length === 0 ? (
                <p className="fixed-note">保持できた entity はありません。</p>
              ) : (
                <ul className="entity-list">
                  {entry.evaluation.matches.map((match) => (
                    <li key={`${match.canonical_key}-${match.reference.start_code_point}`}>
                      <EntitySpan entity={match.reference} /> →{' '}
                      <EntitySpan entity={match.hypothesis} />{' '}
                      <span className="hint">{match.canonical_key}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {entry.evaluation.missing.length > 0 && (
              <div className="entity-block">
                <span className="hint">missing（reference にあって hypothesis に無い）</span>
                <ul className="entity-list warn">
                  {entry.evaluation.missing.map((item) => (
                    <li key={`${item.canonical_key}-${item.start_code_point}`}>
                      <EntitySpan entity={item} /> <span className="hint">{item.canonical_key}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {entry.evaluation.extra.length > 0 && (
              <div className="entity-block">
                <span className="hint">extra（hypothesis にあって reference に無い）</span>
                <ul className="entity-list warn">
                  {entry.evaluation.extra.map((item) => (
                    <li key={`${item.canonical_key}-${item.start_code_point}`}>
                      <EntitySpan entity={item} /> <span className="hint">{item.canonical_key}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

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
        );
      })}
    </div>
  );
}

/** A hash is unreadable in full and useless truncated too far. */
function shortHash(value: string): string {
  return value.length <= 16 ? value : `${value.slice(0, 12)}…`;
}

/**
 * semantic-h3-v1 for one Result.
 *
 * The verdict is deliberately only ever CHANGED or REVIEW REQUIRED. There is no
 * PRESERVED, no SAFE and no PASS on this screen, because the pipeline cannot
 * earn any of those words: three agreeing answers from a local 8B model are not
 * evidence that meaning survived, and a green label would be read as if they
 * were. Semantic sits beside Raw, Surface and Critical — it does not replace
 * them and does not overrule them.
 */
function SemanticEvaluationSection({
  entries,
  busy,
  disabled,
  onCreate,
}: {
  entries: SemanticEntry[];
  busy: boolean;
  disabled: boolean;
  onCreate: () => void;
}) {
  return (
    <div className="raw-eval">
      <h4>Semantic Evaluation</h4>
      <button type="button" className="secondary" onClick={onCreate} disabled={disabled}>
        {busy ? '評価中…' : 'Semantic評価を作成'}
      </button>

      {entries.length === 0 && (
        <p className="fixed-note">この Result にはまだ semantic-h3-v1 の評価がありません。</p>
      )}

      {entries.map((entry) => (
        <div key={entry.evaluationId} className="raw-eval-card">
          <dl className="kv compact">
            <EvaluatorRows evaluation={entry.evaluation} />
            <dt>Decision</dt>
            <dd>
              <strong>
                {semanticDecisionLabel(entry.evaluation)}
              </strong>
            </dd>
            <dt>Decision source</dt>
            <dd>{entry.evaluation.decision.by}</dd>
            <dt>Critical guard</dt>
            <dd>
              {entry.evaluation.critical.status}
              {entry.evaluation.critical.applicable
                ? entry.evaluation.critical.mismatch
                  ? '（mismatch → veto）'
                  : '（mismatch なし）'
                : '（適用対象外）'}
            </dd>
            <dt>Execution</dt>
            <dd>{entry.evaluation.execution.status}</dd>
            <dt>Ollama version</dt>
            <dd>{entry.evaluation.execution.runtime?.version ?? '—'}</dd>
            <dt>Model</dt>
            <dd>{entry.evaluation.execution.model?.id ?? '—'}</dd>
            <dt>Model digest</dt>
            <dd className="mono">
              {entry.evaluation.execution.model
                ? shortHash(entry.evaluation.execution.model.digest)
                : '—'}
            </dd>
            <dt>Prompt SHA</dt>
            <dd className="mono">
              {entry.evaluation.execution.prompt
                ? shortHash(entry.evaluation.execution.prompt.sha256)
                : '—'}
            </dd>
            <dt>Runs</dt>
            <dd>{semanticRunSummary(entry.evaluation)}</dd>
            <dt>Created At</dt>
            <dd>{entry.evaluation.created_at}</dd>
          </dl>

          <p className="fixed-note">{semanticRouteNote(entry.evaluation)}</p>

          <p className="fixed-note">
            {SEMANTIC_DECISION_RULES.join('')}
            {SEMANTIC_INPUT_NOTE}
            Raw / Surface / Critical を置き換えるものではなく、4 つ目の層として並びます。
          </p>

          <p className="fixed-note">
            <strong>Known Limitation（自己訂正）</strong>：
            「二千六百、あ、すみません、二千七百」のような自己訂正は、最終的な意図としては
            保持されていても、critical-info-v1 からは数値の multiset 不一致に見えます。
            そのため p12 型の事例は決定的に CHANGED になります。これは既知の限界であり、
            例外規則は入れていません。
          </p>

          <div className="raw-eval-texts">
            <div>
              <span className="hint">normalized source（reference）</span>
              <pre className="transcript">{entry.normalized?.reference ?? ''}</pre>
            </div>
            <div>
              <span className="hint">normalized transcript（hypothesis）</span>
              <pre className="transcript">{entry.normalized?.hypothesis ?? ''}</pre>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * Both evaluators for one Result, plus anything that failed to verify.
 *
 * A rejected Evaluation is not shown under either evaluator: the reason it was
 * rejected can be that its evaluator record is unreadable, so filing it under
 * one of them would be a guess.
 */
function EvaluationSections({
  resultId,
  sealed,
  entries,
  busyEvaluator,
  disabled,
  error,
  onCreateRawChar,
  onCreateSurface,
  onCreateCritical,
  onCreateSemantic,
}: {
  resultId: string;
  sealed: boolean;
  entries: EvaluationEntry[];
  busyEvaluator: string | null;
  disabled: boolean;
  error: ApiErrorShape | null;
  onCreateRawChar: () => void;
  onCreateSurface: () => void;
  onCreateCritical: () => void;
  onCreateSemantic: () => void;
}) {
  if (!sealed) {
    return (
      <div className="raw-eval">
        <h4>Evaluation</h4>
        <p className="fixed-note">
          この Result は integrity 署名を持たない legacy (schema v1) のため、
          <strong>raw-char-v1 / surface-normalized-char-v1 / critical-info-v1 /
          semantic-h3-v1 いずれの strict evaluation も対象外</strong>
          です。観測としては読めますが、tool identity が保存後に編集されていないことを
          証明できません。
        </p>
      </div>
    );
  }

  const verified = entries.filter(isVerified);
  const rejected = entries.filter((entry) => entry.status === 'rejected');

  return (
    <>
      {error && <ErrorBox title={`Evaluation（${resultId}）`} error={error} />}

      <RawEvaluationSection
        entries={verified.filter(isRawChar)}
        busy={busyEvaluator === 'raw-char-v1'}
        disabled={disabled}
        onCreate={onCreateRawChar}
      />

      <SurfaceEvaluationSection
        entries={verified.filter(isSurface)}
        busy={busyEvaluator === 'surface-normalized-char-v1'}
        disabled={disabled}
        onCreate={onCreateSurface}
      />

      <CriticalEvaluationSection
        entries={verified.filter(isCritical)}
        busy={busyEvaluator === 'critical-info-v1'}
        disabled={disabled}
        onCreate={onCreateCritical}
      />

      <SemanticEvaluationSection
        entries={verified.filter(isSemantic)}
        busy={busyEvaluator === 'semantic-h3-v1'}
        disabled={disabled}
        onCreate={onCreateSemantic}
      />

      {rejected.length > 0 && (
        <div className="raw-eval">
          <h4>検証に失敗した Evaluation</h4>
          {rejected.map((entry) =>
            entry.status === 'rejected' ? (
              <ErrorBox
                key={entry.evaluationId}
                title={entry.evaluationId}
                error={{ kind: entry.reason, message: entry.message, detail: entry.detail }}
              />
            ) : null,
          )}
        </div>
      )}
    </>
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

  /** Which Result is being evaluated with which evaluator, if any. */
  const [evaluating, setEvaluating] = useState<{
    resultId: string;
    evaluatorId: EvaluatorId;
  } | null>(null);
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
   * Only the Result ID and which evaluator to run are sent. Everything the
   * measurement is about is resolved server-side, so nothing this page believes
   * can influence the numbers.
   */
  const createEvaluation = useCallback(
    async (resultId: string, runId: string, evaluatorId: EvaluatorId) => {
      setEvaluating({ resultId, evaluatorId });
      setEvaluationError(null);
      try {
        const response = await fetch('/api/evaluations', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ resultId, evaluatorId }),
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

                <EvaluationSections
                  resultId={entry.resultId}
                  sealed={entry.integrityTrust === 'sealed'}
                  entries={evaluationsByResult.get(entry.resultId) ?? []}
                  busyEvaluator={
                    evaluating?.resultId === entry.resultId ? evaluating.evaluatorId : null
                  }
                  disabled={evaluating !== null}
                  error={
                    evaluationError && evaluationError.resultId === entry.resultId
                      ? evaluationError.error
                      : null
                  }
                  onCreateRawChar={() =>
                    void createEvaluation(entry.resultId, selectedRunId, 'raw-char-v1')
                  }
                  onCreateSurface={() =>
                    void createEvaluation(
                      entry.resultId,
                      selectedRunId,
                      'surface-normalized-char-v1',
                    )
                  }
                  onCreateCritical={() =>
                    void createEvaluation(entry.resultId, selectedRunId, 'critical-info-v1')
                  }
                  onCreateSemantic={() =>
                    void createEvaluation(entry.resultId, selectedRunId, 'semantic-h3-v1')
                  }
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
