import type { SemanticEvaluationV4 } from '@/evaluation/semanticEvaluationSchema';

/**
 * What the Semantic panel says, as data rather than as JSX.
 *
 * Pulled out of the component so the wording can be held to the policy by a
 * test. The screen previously explained H3 as "CHANGED only when all three runs
 * agree, everything else REVIEW REQUIRED", which is true of the model route and
 * silently drops the other one — and the other one is the route p12 takes. An
 * operator reading that sentence next to a p12 card saw CHANGED, `モデル実行なし`,
 * and an explanation that allowed neither. Wording that contradicts the artifact
 * beside it is not a cosmetic problem: it teaches the reader the wrong rule.
 */

/** Which of the two routes produced this artifact's decision. */
export type SemanticRoute = 'critical-veto' | 'model';

export function semanticRouteOf(evaluation: SemanticEvaluationV4): SemanticRoute {
  return evaluation.execution.status === 'skipped_by_critical_veto' ? 'critical-veto' : 'model';
}

/**
 * The verdict, in the only two words this evaluator is allowed to say.
 *
 * No PRESERVED, no SAFE, no PASS. `review` is spelled REVIEW REQUIRED so it
 * reads as work outstanding rather than as a passing grade.
 */
export function semanticDecisionLabel(evaluation: SemanticEvaluationV4): string {
  return evaluation.decision.value === 'changed' ? 'CHANGED' : 'REVIEW REQUIRED';
}

/** How the runs came back, in one line. */
export function semanticRunSummary(evaluation: SemanticEvaluationV4): string {
  const runs = evaluation.execution.runs;
  if (runs.length === 0) return 'モデル実行なし';
  const valid = runs.filter((run) => run.parseable_schema_valid).length;
  const exact = runs.filter((run) => run.exact_output_contract_valid).length;
  const changed = runs.filter(
    (run) => run.parsed_output !== null && run.parsed_output.meaning_preserved === false,
  ).length;
  const preserved = valid - changed;
  return `${valid}/${runs.length} parseable・${exact}/${runs.length} exact format・changed ${changed} / preserved ${preserved}`;
}

/**
 * The decision policy, both routes, in the order they are tried.
 *
 * Kept as separate lines so a test can require the veto clause to still be
 * there rather than pattern-matching one long paragraph.
 */
export const SEMANTIC_DECISION_RULES: readonly string[] = [
  'Critical guard が supported mismatch を検出した場合は、モデルを実行せず CHANGED。',
  'Critical veto が無い場合は、3 回すべて parseable かつ全会一致で changed のときだけ CHANGED。',
  'それ以外はすべて REVIEW REQUIRED。',
  'semantic-h3-v1 は PRESERVED を出しません。',
];

/**
 * Which input each half of the evaluator reads.
 *
 * Worth saying on screen because the panel shows the normalized pair: without
 * this line a reader would reasonably assume the Critical guard was computed
 * from the text displayed underneath it, and it was not.
 */
export const SEMANTIC_INPUT_NOTE =
  'モデルは surface 正規化後のテキストを読み、Critical guard は raw テキストを読みます。';

/** The sentence describing the route this particular artifact actually took. */
export function semanticRouteNote(evaluation: SemanticEvaluationV4): string {
  return semanticRouteOf(evaluation) === 'critical-veto'
    ? 'Critical guard が mismatch を検出したため、モデルを実行せずに CHANGED と判定しました。'
    : 'Critical veto が無かったため、モデルを 3 回実行し、その全会一致で判定しました。';
}
