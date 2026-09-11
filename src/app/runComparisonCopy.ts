import type {
  GroupEvidenceState,
  SelectionReason,
  SemanticSummary,
  UnattributedReasonClass,
} from '@/comparisons/runComparison';
import type { EvaluatorId } from '@/evaluation/createEvaluation';
import type { SemanticDecisionSource } from '@/evaluation/semanticDecision';

/**
 * What the Run Comparison view says, as data rather than as JSX.
 *
 * Kept out of the component for the same reason `semanticDecisionCopy.ts` is:
 * the wording is policy, and a test can hold it to that. Nothing here may read
 * as a grade — no PASS, no SAFE, no PRESERVED, no OK — and nothing may compare
 * two tools by preference.
 */

export const COMPARISON_POLICY_NOTE =
  'Raw / Surface / Critical / Semantic は別々の測定です。総合スコア・ランキング・勝者判定は行いません。' +
  '同一 tool の複数 Result は兄弟として並べ、どれが最新・正式かは判定しません。';

export const EVALUATOR_LABELS: Record<EvaluatorId, string> = {
  'raw-char-v1': 'Raw',
  'surface-normalized-char-v1': 'Surface',
  'critical-info-v1': 'Critical',
  'semantic-h3-v1': 'Semantic',
};

/** The verdict, in the only two words semantic-h3-v1 is allowed to say. */
export function semanticVerdictLabel(summary: SemanticSummary): 'CHANGED' | 'REVIEW REQUIRED' {
  return summary.decision === 'changed' ? 'CHANGED' : 'REVIEW REQUIRED';
}

/** The rule that produced the decision, in words. One line per production source. */
export const SEMANTIC_DECISION_SOURCE_NOTES: Record<SemanticDecisionSource, string> = {
  'critical-guard-veto-v1': 'Critical guard が supported mismatch を検出したため CHANGED。モデルは実行していません。',
  'full-run-unanimous-changed-v1': '3 回すべて parseable で、全会一致で changed と回答したため CHANGED。',
  'full-run-unanimous-preserved-requires-review-v1':
    '3 回すべて意味保持と回答しましたが、H3 は自動で保持判定を出さないため REVIEW REQUIRED。',
  'no-valid-run-evidence-v1': '使える実行結果が 1 件もないため REVIEW REQUIRED。',
  'incomplete-run-evidence-v1': '使える実行結果が 3 件に満たないため REVIEW REQUIRED。',
  'split-vote-v1': '3 回の回答が割れたため REVIEW REQUIRED。',
};

/**
 * How the runs came back, in one line.
 *
 * On the Critical-veto route the zero is stated as a route, not left as a bare
 * "0 runs" beside CHANGED — which a reader would take for missing data.
 */
export function semanticRunLine(summary: SemanticSummary): string {
  const { execution } = summary;
  if (execution.status === 'skipped_by_critical_veto') {
    return 'Critical veto のためモデル実行なし（0 runs は欠損ではありません）';
  }
  const n = execution.runs_recorded;
  return (
    `${execution.runs_parseable}/${n} parseable・${execution.runs_exact_format}/${n} exact format・` +
    `changed ${execution.changed_votes} / preserved ${execution.preserved_votes}` +
    `・full-run unanimous: ${execution.full_run_unanimous ? 'yes' : 'no'}`
  );
}

export const MISSING_EVALUATOR_NOTE = 'verified evidence なし（0 点でも失敗でも合格でもありません）';

export function missingWithRejectedNote(unclassifiedRejected: number): string | null {
  return unclassifiedRejected > 0
    ? `この Result には evaluator を特定できない rejected Evaluation が ${unclassifiedRejected} 件あります（下段参照）`
    : null;
}

export const SELECTION_REASON_NOTES: Record<SelectionReason, string> = {
  'only-verified-entry-v1': 'verified は 1 件のみ',
  'newest-verified-by-id-v1': '複数の verified のうち evaluation_id が最大のものを表示（選択であり優劣ではありません）',
  'conflict-no-headline-v1': 'verified 同士の判定が食い違うため headline なし（多数決・新しさでは解決しません）',
};

export function groupStateLine(state: GroupEvidenceState): string {
  const parts = [`verified ${state.verified_count} 件`];
  if (state.multiple_candidates) parts.push('multiple candidates');
  if (state.conflicting_evidence) parts.push('CONFLICTING EVIDENCE');
  return parts.join('・');
}

export const UNATTRIBUTED_REASON_NOTES: Record<UnattributedReasonClass, string> = {
  'no-seal': '検証済みの seal が無いため、tool の主張を帰属に使えません。',
  'tool-identity-unverified': 'tool の記録そのものが検証に失敗しました。',
  'custom-tool-identity-unavailable':
    'custom tool (other) ですが、識別子である tool 名が検証済みで得られないため、どの custom tool にも入れません。',
};

export const LEGACY_NOTE =
  '未署名 (legacy) の Result です。tool の記録は改変されていない保証がないため、tool 比較には含めません。';

export const REJECTED_RESULT_NOTE =
  'この Result は検証に失敗しました。captured_at・capture・version・transcript は信頼できないため表示しません。';
