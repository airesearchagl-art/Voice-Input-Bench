'use client';

import { Fragment, useEffect, useState } from 'react';
import type {
  ComparisonEvaluationGroup,
  ComparisonRejectedEvaluation,
  ComparisonResult,
  ComparisonRun,
  ComparisonToolGroup,
  ComparisonVerifiedEvaluation,
  EvaluationSummary,
  SemanticSummary,
} from '@/comparisons/runComparison';
import type { EvaluatorId } from '@/evaluation/createEvaluation';
import {
  COMPARISON_POLICY_NOTE,
  EVALUATOR_LABELS,
  LEGACY_NOTE,
  MISSING_EVALUATOR_NOTE,
  REJECTED_RESULT_NOTE,
  SELECTION_REASON_NOTES,
  SEMANTIC_DECISION_SOURCE_NOTES,
  UNATTRIBUTED_REASON_NOTES,
  groupStateLine,
  missingWithRejectedNote,
  semanticRunLine,
  semanticVerdictLabel,
} from './runComparisonCopy';
import { loadRunComparison, type ComparisonLoadState } from './runComparisonLoad';

/**
 * Run Comparison — one Run's trusted tool evidence, side by side.
 *
 * Everything on screen comes from `GET /api/comparisons/run/<run-id>`, which is
 * the one place grouping, headline selection and attribution are decided. This
 * component renders that payload in server order and decides nothing itself.
 *
 * Columns are Results, grouped under their tool; rows are the four evaluators.
 * Evidence that cannot be placed in a tool column — legacy, unattributed,
 * rejected — is shown below in its own sections rather than left out.
 */

function formatCer(cer: number): string {
  return cer.toFixed(4);
}

function formatRate(rate: number): string {
  return `${(rate * 100).toFixed(1)}%`;
}

function shortHash(value: string): string {
  return value.length <= 16 ? value : `${value.slice(0, 12)}…`;
}

function RejectionBox({ title, entry }: { title: string; entry: ApiErrorShapeLike }) {
  return (
    <div className="alert error" role="alert">
      <span className="kind">
        {title}: {entry.reason}
      </span>
      <p>{entry.message}</p>
      {entry.detail && <div className="meta">{entry.detail}</div>}
    </div>
  );
}

interface ApiErrorShapeLike {
  reason: string;
  message: string;
  detail?: string;
}

function RejectedEvaluationList({ entries }: { entries: ComparisonRejectedEvaluation[] }) {
  return (
    <>
      {entries.map((entry) => (
        <RejectionBox key={entry.evaluation_id} title={entry.evaluation_id} entry={entry} />
      ))}
    </>
  );
}

// ── Summaries ───────────────────────────────────────────────────────────────

function SemanticSummaryView({ summary }: { summary: SemanticSummary }) {
  const label = semanticVerdictLabel(summary);
  return (
    <div className="cmp-summary">
      <strong className={`cmp-verdict ${summary.decision === 'changed' ? 'changed' : 'review'}`}>
        {label}
      </strong>
      <p className="cmp-note">{SEMANTIC_DECISION_SOURCE_NOTES[summary.decision_by]}</p>
      <dl className="kv compact">
        <dt>decision_by</dt>
        <dd className="mono">{summary.decision_by}</dd>
        <dt>Critical guard</dt>
        <dd>
          {summary.critical_guard.status}・applicable {String(summary.critical_guard.applicable)}・
          mismatch {String(summary.critical_guard.mismatch)}
        </dd>
        <dt>Execution</dt>
        <dd>{summary.execution.status}</dd>
        <dt>Runs</dt>
        <dd>
          {summary.execution.runs_recorded} recorded — {semanticRunLine(summary)}
        </dd>
        {summary.model && (
          <>
            <dt>Model</dt>
            <dd className="mono">
              {summary.model.model_id} ({shortHash(summary.model.model_digest)})・runtime{' '}
              {summary.model.runtime_version}
            </dd>
            <dt>Prompt</dt>
            <dd className="mono">
              {summary.model.prompt_id} ({shortHash(summary.model.prompt_sha256)})
            </dd>
          </>
        )}
      </dl>
    </div>
  );
}

function SummaryView({ summary }: { summary: EvaluationSummary }) {
  switch (summary.kind) {
    case 'raw-char-v1':
      return (
        <dl className="kv compact cmp-summary">
          <dt>exact_match</dt>
          <dd>{String(summary.exact_match)}</dd>
          <dt>CER</dt>
          <dd>{formatCer(summary.cer)}</dd>
          <dt>Edit distance</dt>
          <dd>
            {summary.edit_distance}（S {summary.substitutions} / D {summary.deletions} / I{' '}
            {summary.insertions}）
          </dd>
          <dt>Chars</dt>
          <dd>
            reference {summary.reference_chars} / hypothesis {summary.hypothesis_chars}
          </dd>
        </dl>
      );
    case 'surface-normalized-char-v1':
      return (
        <dl className="kv compact cmp-summary">
          <dt>exact_match</dt>
          <dd>{String(summary.exact_match)}</dd>
          <dt>CER</dt>
          <dd>{formatCer(summary.cer)}</dd>
          <dt>Edit distance</dt>
          <dd>
            {summary.edit_distance}（S {summary.substitutions} / D {summary.deletions} / I{' '}
            {summary.insertions}）
          </dd>
          <dt>Normalized</dt>
          <dd className="mono">
            ref {summary.normalized.reference.chars} ({shortHash(summary.normalized.reference.sha256)})
            / hyp {summary.normalized.hypothesis.chars} (
            {shortHash(summary.normalized.hypothesis.sha256)})
          </dd>
        </dl>
      );
    case 'critical-info-v1':
      return (
        <dl className="kv compact cmp-summary">
          <dt>exact multiset</dt>
          <dd>{String(summary.exact_entity_multiset_match)}</dd>
          <dt>Preservation</dt>
          <dd>
            {formatRate(summary.preservation_rate)}（matched {summary.matched} /{' '}
            {summary.reference_entities}）
          </dd>
          <dt>Missing</dt>
          <dd>
            {summary.missing}
            {summary.missing_keys.length > 0 && (
              <span className="mono"> — {summary.missing_keys.join(', ')}</span>
            )}
          </dd>
          <dt>Extra</dt>
          <dd>
            {summary.extra}
            {summary.extra_keys.length > 0 && (
              <span className="mono"> — {summary.extra_keys.join(', ')}</span>
            )}
          </dd>
        </dl>
      );
    case 'semantic-h3-v1':
      return <SemanticSummaryView summary={summary} />;
  }
}

/** Compact one-line reading of an entry, for candidate lists. */
function EntryLine({ entry }: { entry: ComparisonVerifiedEvaluation }) {
  const { summary } = entry;
  let reading: string;
  switch (summary.kind) {
    case 'raw-char-v1':
    case 'surface-normalized-char-v1':
      reading = `CER ${formatCer(summary.cer)}`;
      break;
    case 'critical-info-v1':
      reading = `preservation ${formatRate(summary.preservation_rate)}`;
      break;
    case 'semantic-h3-v1':
      reading = `${semanticVerdictLabel(summary)} (${summary.decision_by})`;
      break;
  }
  return (
    <li>
      <span className="mono">{entry.evaluation_id}</span> — {reading}
    </li>
  );
}

// ── Cells ───────────────────────────────────────────────────────────────────

function EvaluatorCell({
  group,
  unclassifiedRejected,
}: {
  group: ComparisonEvaluationGroup;
  unclassifiedRejected: number;
}) {
  if (group.state.availability === 'missing') {
    const rejectedNote = missingWithRejectedNote(unclassifiedRejected);
    return (
      <td className={`cmp-cell cmp-missing${rejectedNote ? ' has-rejected' : ''}`}>
        <strong>MISSING</strong>
        <p className="cmp-note">{MISSING_EVALUATOR_NOTE}</p>
        {rejectedNote && <p className="cmp-note warn">{rejectedNote}</p>}
      </td>
    );
  }

  return (
    <td className={`cmp-cell${group.state.conflicting_evidence ? ' cmp-conflict' : ''}`}>
      {group.headline ? (
        <SummaryView summary={group.headline.summary} />
      ) : (
        <div className="cmp-summary">
          <strong className="cmp-verdict conflict">CONFLICTING EVIDENCE — headline なし</strong>
          {group.entries.map((entry) => (
            <div key={entry.evaluation_id} className="cmp-conflict-entry">
              <div className="mono">{entry.evaluation_id}</div>
              <SummaryView summary={entry.summary} />
            </div>
          ))}
        </div>
      )}
      <p className="cmp-note">
        {groupStateLine(group.state)}
        {group.selection_reason && (
          <>
            <br />
            <span className="mono">{group.selection_reason}</span>:{' '}
            {SELECTION_REASON_NOTES[group.selection_reason]}
          </>
        )}
      </p>
      {group.headline && (
        <p className="cmp-note">
          headline: <span className="mono">{group.headline.evaluation_id}</span>
        </p>
      )}
      {group.state.multiple_candidates && group.headline && (
        <details>
          <summary>考慮した verified Evaluation（{group.entries.length} 件）</summary>
          <ul className="cmp-entry-list">
            {group.entries.map((entry) => (
              <EntryLine key={entry.evaluation_id} entry={entry} />
            ))}
          </ul>
        </details>
      )}
    </td>
  );
}

function ToolCaptureCell({ result }: { result: ComparisonResult }) {
  if (result.kind === 'rejected') {
    return (
      <td className="cmp-cell cmp-rejected">
        <strong>REJECTED</strong>
        <dl className="kv compact">
          <dt>Trusted tool</dt>
          <dd>{result.trusted_tool_id}（sealed）</dd>
        </dl>
        <p className="cmp-note">{REJECTED_RESULT_NOTE}</p>
        <RejectionBox title={result.result_id} entry={result} />
      </td>
    );
  }
  return (
    <td className="cmp-cell">
      <dl className="kv compact">
        <dt>Tool</dt>
        <dd>
          {result.tool.name}
          <span className="mono"> ({result.tool.id})</span>
        </dd>
        <dt>Version</dt>
        <dd>{result.tool.version ?? '未記録'}</dd>
        <dt>Delivery</dt>
        <dd>{result.capture.delivery_path}</dd>
        <dt>Captured At</dt>
        <dd>{result.captured_at}</dd>
        <dt>Transcript</dt>
        <dd className="mono">{shortHash(result.transcript_sha256)}</dd>
      </dl>
    </td>
  );
}

function ResultColumnCells({
  result,
  evaluatorId,
}: {
  result: ComparisonResult;
  evaluatorId: EvaluatorId;
}) {
  if (result.kind === 'rejected') {
    return (
      <td className="cmp-cell cmp-rejected">
        <p className="cmp-note">対象外（Result rejected のため evaluator group を作りません）</p>
      </td>
    );
  }
  const group = result.evaluations.find((candidate) => candidate.evaluator_id === evaluatorId);
  if (!group) return <td className="cmp-cell" />;
  return (
    <EvaluatorCell
      group={group}
      unclassifiedRejected={result.completeness.unclassified_rejected_count}
    />
  );
}

function RejectedEvidenceCell({ result }: { result: ComparisonResult }) {
  const verifiedOnRejected = result.kind === 'rejected' ? result.verified_evaluations : [];
  const rejected = result.unclassified_rejected_evaluations;
  if (rejected.length === 0 && verifiedOnRejected.length === 0) {
    return (
      <td className="cmp-cell">
        <p className="cmp-note">なし</p>
      </td>
    );
  }
  return (
    <td className="cmp-cell cmp-has-rejected">
      {rejected.length > 0 && (
        <>
          <p className="cmp-note warn">
            evaluator を特定できない rejected Evaluation {rejected.length} 件
          </p>
          <RejectedEvaluationList entries={rejected} />
        </>
      )}
      {verifiedOnRejected.length > 0 && (
        <>
          <p className="cmp-note">
            この rejected Result を名指す verified Evaluation {verifiedOnRejected.length} 件
          </p>
          <ul className="cmp-entry-list">
            {verifiedOnRejected.map((entry) => (
              <EntryLine key={entry.evaluation_id} entry={entry} />
            ))}
          </ul>
        </>
      )}
    </td>
  );
}

function CompletenessCell({ result }: { result: ComparisonResult }) {
  if (result.kind === 'rejected') {
    return (
      <td className="cmp-cell cmp-rejected">
        <p className="cmp-note">Result rejected</p>
      </td>
    );
  }
  const { completeness } = result;
  return (
    <td className="cmp-cell">
      <strong>{completeness.state}</strong>
      <p className="cmp-note">
        present: {completeness.evaluators_present.map((id) => EVALUATOR_LABELS[id]).join(', ') || 'なし'}
        <br />
        missing: {completeness.evaluators_missing.map((id) => EVALUATOR_LABELS[id]).join(', ') || 'なし'}
        <br />
        unclassified rejected: {completeness.unclassified_rejected_count}
      </p>
    </td>
  );
}

// ── Sections ────────────────────────────────────────────────────────────────

function toolHeading(group: ComparisonToolGroup): string {
  return group.tool.kind === 'built-in'
    ? group.tool.id
    : `other: ${group.tool.trusted_name}`;
}

function TrustedToolComparison({ comparison }: { comparison: ComparisonRun }) {
  const columns = comparison.tools.flatMap((group) =>
    group.results.map((result) => ({ group, result })),
  );
  if (columns.length === 0) {
    return <p className="fixed-note">この Run には tool 比較に使える sealed Result がありません。</p>;
  }

  return (
    <div className="matrix-wrap">
      <table className="cmp-table">
        <thead>
          <tr>
            <th scope="col">Tool</th>
            {comparison.tools.map((group) => (
              <th key={toolHeading(group)} scope="colgroup" colSpan={group.results.length}>
                {toolHeading(group)}
                <span className="cmp-note">（Result {group.results.length} 件）</span>
              </th>
            ))}
          </tr>
          <tr>
            <th scope="col">Result</th>
            {columns.map(({ result }) => (
              <th key={result.result_id} scope="col" className="mono">
                {result.result_id}
                {result.kind === 'rejected' && <span className="cmp-badge rejected">REJECTED</span>}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          <tr>
            <th scope="row">Tool / capture</th>
            {columns.map(({ result }) => (
              <ToolCaptureCell key={result.result_id} result={result} />
            ))}
          </tr>
          <tr>
            <th scope="row">Transcript</th>
            {columns.map(({ result }) =>
              result.kind === 'verified' ? (
                <td key={result.result_id} className="cmp-cell">
                  <pre className="transcript">{result.transcript}</pre>
                </td>
              ) : (
                <td key={result.result_id} className="cmp-cell cmp-rejected">
                  <p className="cmp-note">表示しません（Result rejected）</p>
                </td>
              ),
            )}
          </tr>
          {comparison.evaluator_ids.map((evaluatorId) => (
            <tr key={evaluatorId}>
              <th scope="row">
                {EVALUATOR_LABELS[evaluatorId]}
                <div className="mono cmp-note">{evaluatorId}</div>
              </th>
              {columns.map(({ result }) => (
                <ResultColumnCells
                  key={result.result_id}
                  result={result}
                  evaluatorId={evaluatorId}
                />
              ))}
            </tr>
          ))}
          <tr>
            <th scope="row">Unclassified rejected</th>
            {columns.map(({ result }) => (
              <RejectedEvidenceCell key={result.result_id} result={result} />
            ))}
          </tr>
          <tr>
            <th scope="row">Completeness</th>
            {columns.map(({ result }) => (
              <CompletenessCell key={result.result_id} result={result} />
            ))}
          </tr>
        </tbody>
      </table>
    </div>
  );
}

function AttachedEvaluations({
  verified,
  rejected,
}: {
  verified: ComparisonVerifiedEvaluation[];
  rejected: ComparisonRejectedEvaluation[];
}) {
  if (verified.length === 0 && rejected.length === 0) {
    return <p className="cmp-note">この Result を名指す Evaluation はありません。</p>;
  }
  return (
    <>
      {verified.length > 0 && (
        <>
          <p className="cmp-note">verified Evaluation {verified.length} 件（tool 比較には含めません）</p>
          <ul className="cmp-entry-list">
            {verified.map((entry) => (
              <EntryLine key={entry.evaluation_id} entry={entry} />
            ))}
          </ul>
        </>
      )}
      {rejected.length > 0 && (
        <>
          <p className="cmp-note warn">rejected Evaluation {rejected.length} 件（evaluator 不明）</p>
          <RejectedEvaluationList entries={rejected} />
        </>
      )}
    </>
  );
}

function LegacySection({ comparison }: { comparison: ComparisonRun }) {
  const legacy = comparison.legacy_unsealed_results;
  return (
    <div className="cmp-aux legacy">
      <h3>Legacy unsealed Results（{legacy.length} 件）</h3>
      <p className="fixed-note">{LEGACY_NOTE}</p>
      {legacy.length === 0 && <p className="cmp-note">なし</p>}
      {legacy.map((result) => (
        <article key={result.result_id} className="transcript-card">
          <h4 className="mono">{result.result_id}</h4>
          {result.kind === 'legacy-unsealed-verified' ? (
            <>
              <dl className="kv compact">
                <dt>Tool（未検証の主張）</dt>
                <dd>
                  {result.claimed_tool_name}
                  <span className="mono"> ({result.claimed_tool_id})</span>
                  {result.claimed_tool_version ? ` / ${result.claimed_tool_version}` : ''}
                  <span className="cmp-badge unverified">tool claim is unverified</span>
                </dd>
              </dl>
              <pre className="transcript">{result.transcript}</pre>
            </>
          ) : (
            <>
              <p className="cmp-note">
                読み戻しに失敗した legacy Result です。tool の主張も表示しません。
              </p>
              <RejectionBox title={result.result_id} entry={result} />
            </>
          )}
          <AttachedEvaluations
            verified={result.verified_evaluations}
            rejected={result.unclassified_rejected_evaluations}
          />
        </article>
      ))}
    </div>
  );
}

function UnattributedSection({ comparison }: { comparison: ComparisonRun }) {
  const results = comparison.unattributed_results;
  const rejected = comparison.unattributed_rejected_evaluations;
  const verified = comparison.unattributed_verified_evaluations;
  const total = results.length + rejected.length + verified.length;
  return (
    <div className="cmp-aux unattributed">
      <h3>Unattributed / rejected evidence（{total} 件）</h3>
      <p className="fixed-note">
        検証に失敗し、どの tool・Result にも安全に帰属できない evidence です。推測で配置せず、ここに残します。
      </p>
      {total === 0 && <p className="cmp-note">なし</p>}
      {results.map((result) => (
        <article key={result.result_id} className="transcript-card">
          <h4 className="mono">{result.result_id}</h4>
          <dl className="kv compact">
            <dt>reason_class</dt>
            <dd className="mono">{result.reason_class}</dd>
            <dt>Integrity</dt>
            <dd>{result.integrity_trust ?? '不明'}</dd>
          </dl>
          <p className="cmp-note">{UNATTRIBUTED_REASON_NOTES[result.reason_class]}</p>
          <RejectionBox title={result.result_id} entry={result} />
          <AttachedEvaluations
            verified={result.related_verified_evaluations}
            rejected={result.related_rejected_evaluations}
          />
        </article>
      ))}
      {rejected.length > 0 && (
        <>
          <h4>この Run のどの Result にも帰属しない rejected Evaluation（{rejected.length} 件）</h4>
          {rejected.map((entry) => (
            <Fragment key={entry.evaluation_id}>
              {entry.named_result_id && (
                <p className="cmp-note">
                  名指している Result: <span className="mono">{entry.named_result_id}</span>
                  （この Run の Result 一覧にありません）
                </p>
              )}
              <RejectionBox title={entry.evaluation_id} entry={entry} />
            </Fragment>
          ))}
        </>
      )}
      {verified.length > 0 && (
        <>
          <h4>この Run の Result 一覧にない Result を名指す verified Evaluation（{verified.length} 件）</h4>
          <ul className="cmp-entry-list">
            {verified.map((entry) => (
              <EntryLine key={entry.evaluation_id} entry={entry} />
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

function RunHeader({ comparison }: { comparison: ComparisonRun }) {
  const { evidence, completeness } = comparison;
  return (
    <>
      <dl className="kv compact">
        <dt>Run ID</dt>
        <dd className="mono">{comparison.run_id}</dd>
        <dt>Test ID</dt>
        <dd>{comparison.test_id}</dd>
        <dt>Source SHA-256</dt>
        <dd className="mono">{shortHash(evidence.source_sha256)}</dd>
        <dt>Audio SHA-256</dt>
        <dd className="mono">{shortHash(evidence.audio_sha256)}</dd>
        <dt>Segments</dt>
        <dd>{evidence.segment_count}</dd>
        <dt>Generated At</dt>
        <dd>{evidence.generated_at}</dd>
        <dt>Evidence</dt>
        <dd>
          verified evaluator coverage: {completeness.state}・sealed verified{' '}
          {completeness.sealed_verified_results}・sealed
          rejected {completeness.sealed_rejected_results}・legacy{' '}
          {completeness.legacy_unsealed_results}・unattributed Result{' '}
          {completeness.unattributed_results}・unattributed rejected Evaluation{' '}
          {completeness.unattributed_rejected_evaluations}・verified Evaluation なしの Result{' '}
          {completeness.results_with_no_verified_evaluations}
        </dd>
      </dl>
    </>
  );
}

export default function RunComparison({
  runId,
  refreshKey,
}: {
  runId: string;
  /** Changes whenever the surrounding panel reloads, so the comparison follows it. */
  refreshKey: number;
}) {
  const [state, setState] = useState<ComparisonLoadState>({ status: 'loading' });

  useEffect(() => {
    // Aborted on every Run change and unmount. An aborted request answers null
    // however it settles, so it can never write into the Run now selected.
    const controller = new AbortController();
    setState({ status: 'loading' });
    void loadRunComparison(runId, controller.signal).then((next) => {
      if (next !== null && !controller.signal.aborted) setState(next);
    });
    return () => controller.abort();
  }, [runId, refreshKey]);

  return (
    <div className="cmp">
      <h2>Run Comparison</h2>
      <p className="fixed-note">{COMPARISON_POLICY_NOTE}</p>

      {state.status === 'loading' && <p className="fixed-note">読み込み中…</p>}

      {state.status === 'failed' && (
        <div className="alert error" role="alert">
          <span className="kind">Comparison: {state.error.kind}</span>
          <p>{state.error.message}</p>
          {state.error.detail && <div className="meta">{state.error.detail}</div>}
        </div>
      )}

      {state.status === 'loaded' && state.comparison.run_id === runId && (
        <>
          <RunHeader comparison={state.comparison} />
          <h3>Trusted tool comparison</h3>
          <TrustedToolComparison comparison={state.comparison} />
          <LegacySection comparison={state.comparison} />
          <UnattributedSection comparison={state.comparison} />
        </>
      )}
    </div>
  );
}
