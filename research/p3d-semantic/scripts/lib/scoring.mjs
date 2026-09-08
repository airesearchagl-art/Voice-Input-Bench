/**
 * Scoring for the P3-D-A spike.
 *
 * Extracted from `analyze-results.mjs` so the rules and the metrics can be
 * tested directly rather than inferred from a summary file.
 *
 * The ranking metric is **false preserved**, not accuracy. A method that calls a
 * reversed instruction "preserved" has told an engineer the transcript is fine
 * when it says the opposite thing; a method that flags a correct transcript has
 * cost someone a minute. Those are not two sides of one number.
 */

import { rate } from './evidence.mjs';

/**
 * Binary scoring over the pairs a method actually decided.
 *
 * Deliberately carries **no hard-negative metric**. R1 computed one here, and
 * because this function only ever sees the automatic rows, every hard negative
 * a tri-state routed to review vanished from the denominator — a rule that
 * reviewed twelve of thirteen hard negatives and caught one scored 100% recall.
 * Hard-negative metrics belong to `hardNegativeMetrics`, which is given the
 * whole corpus.
 */
export function confusion(rows) {
  const falsePreserved = rows.filter((r) => r.gold === 'changed' && r.predicted === 'preserved');
  const falseChanged = rows.filter((r) => r.gold === 'preserved' && r.predicted === 'changed');
  const correct = rows.filter((r) => r.gold === r.predicted);

  return {
    decided: rows.length,
    correct: correct.length,
    // Named `accuracy`, not `provisional_accuracy`. What the figure is worth
    // depends on whether the corpus has been reviewed, and that standing is
    // recorded once in `gold_status` rather than baked into a field name that
    // would then be wrong after a review. See lib/goldStatus.mjs.
    accuracy: rate(correct.length, rows.length),
    false_preserved: falsePreserved.length,
    false_preserved_ids: falsePreserved.map((r) => r.id),
    false_changed: falseChanged.length,
    false_changed_ids: falseChanged.map((r) => r.id),
  };
}

/**
 * Hard-negative metrics, always over **every hard negative in the corpus**.
 *
 * Two numbers that must never share a name:
 *
 *   - `hard_negative_auto_changed_recall` — the method decided, by itself, that
 *     a hard negative had changed. Review does not count. This is detection.
 *   - `hard_negative_non_preserved_coverage` — the method did not tell anyone
 *     the pair was fine. Review counts here and only here. This is the absence
 *     of a wrong answer, which is worth measuring under its own name.
 *
 * A rule that sends everything to a human scores 0% on the first and 100% on
 * the second, and that contrast is the entire point of reporting both.
 *
 * @param rows every probe, each with `hard_negative` and a
 *   `decision` of `changed` | `preserved` | `review`.
 */
export function hardNegativeMetrics(rows) {
  const hard = rows.filter((r) => r.hard_negative);
  const autoChanged = hard.filter((r) => r.decision === 'changed');
  const autoPreserved = hard.filter((r) => r.decision === 'preserved');
  const review = hard.filter((r) => r.decision === 'review');

  return {
    hard_negative_total: hard.length,
    hard_negative_auto_changed_count: autoChanged.length,
    hard_negative_review_count: review.length,
    hard_negative_auto_preserved_count: autoPreserved.length,
    // Denominator is the corpus, never the subset the method chose to answer.
    hard_negative_auto_changed_recall: rate(autoChanged.length, hard.length),
    hard_negative_non_preserved_coverage: rate(hard.length - autoPreserved.length, hard.length),
    hard_negative_called_preserved_ids: autoPreserved.map((r) => r.id),
  };
}

/**
 * The hybrid rules.
 *
 * Each takes a context and returns a tri-state decision plus the step that
 * produced it. `ctx.fullRunUnanimous` is the strict flag from
 * `voteSemantics.tallyRuns`: every requested run parsed, and every one agreed.
 * An automated `changed` rests on that and on nothing weaker.
 *
 * H0 is the first round's rule, kept only as a comparator. It decides on the
 * majority of the valid runs and never asks whether a run was missing, which is
 * one of the reasons it is not a candidate.
 *
 * H3 and H4 differ in exactly one step and separate two policies that were
 * previously entangled. Both refuse to emit an automatic `preserved`. H3 lets a
 * critical-information mismatch decide `changed` outright; H4 routes it to a
 * person. The human review confirmed p12 — a correctly handled self-correction —
 * as `preserved` while the critical signal reports a mismatch on it, so under H3
 * that pair is a **deterministic** false changed: no model is involved and no
 * threshold moves it. Whether that is acceptable is a policy question, so the two
 * are measured apart rather than bundled.
 */
export const HYBRIDS = {
  H0_agreement_gated: (ctx) => {
    if (ctx.critical.applicable && ctx.critical.mismatch) {
      return { decision: 'changed', by: 'critical-veto' };
    }
    if (ctx.majorityLabel === null) return { decision: 'review', by: 'llm-unscored' };
    if (ctx.embeddingSays === ctx.majorityLabel) {
      return { decision: ctx.majorityLabel, by: 'agreement' };
    }
    return { decision: 'review', by: 'disagreement' };
  },

  H1_canonical_baseline: (ctx) => {
    if (ctx.critical.applicable && ctx.critical.mismatch) {
      return { decision: 'changed', by: 'critical-veto' };
    }
    // An invalid run or a split vote is missing evidence, not a verdict.
    if (!ctx.fullRunUnanimous) return { decision: 'review', by: 'llm-not-full-run-unanimous' };
    if (ctx.majorityLabel === 'changed') return { decision: 'changed', by: 'llm-changed' };
    if (ctx.embeddingSays !== ctx.majorityLabel) {
      return { decision: 'review', by: 'embedding-conflict' };
    }
    return { decision: 'preserved', by: 'agreement' };
  },

  H2_critical_review_trigger: (ctx) => {
    if (ctx.critical.applicable && ctx.critical.mismatch) {
      return { decision: 'review', by: 'critical-review' };
    }
    if (!ctx.fullRunUnanimous) return { decision: 'review', by: 'llm-not-full-run-unanimous' };
    if (ctx.majorityLabel === 'changed') return { decision: 'changed', by: 'llm-changed' };
    if (ctx.embeddingSays !== ctx.majorityLabel) {
      return { decision: 'review', by: 'embedding-conflict' };
    }
    return { decision: 'preserved', by: 'agreement' };
  },

  H3_no_auto_preserved: (ctx) => {
    if (ctx.critical.applicable && ctx.critical.mismatch) {
      return { decision: 'changed', by: 'critical-veto' };
    }
    if (ctx.fullRunUnanimous && ctx.majorityLabel === 'changed') {
      return { decision: 'changed', by: 'llm-changed' };
    }
    // `preserved` is never automatic under H3.
    return { decision: 'review', by: 'no-auto-preserved' };
  },

  H4_no_auto_preserved_critical_review: (ctx) => {
    // H3 with the critical mismatch demoted to a review trigger, and nothing
    // else changed. Uses no embedding, so it is threshold-independent.
    if (ctx.critical.applicable && ctx.critical.mismatch) {
      return { decision: 'review', by: 'critical-review' };
    }
    if (ctx.fullRunUnanimous && ctx.majorityLabel === 'changed') {
      return { decision: 'changed', by: 'llm-changed' };
    }
    return { decision: 'review', by: 'no-auto-preserved' };
  },
};

export const HYBRID_RULE_DESCRIPTIONS = {
  H0_agreement_gated:
    'critical veto; else the embedding and the majority of valid rubric runs must agree; else review. Does not require every run to have parsed — kept as a comparator, not a candidate.',
  H1_canonical_baseline:
    'critical veto; else any invalid run or split vote -> review; else full-run-unanimous rubric changed -> changed; else embedding conflict -> review; else preserved',
  H2_critical_review_trigger:
    'as H1 but a critical mismatch routes to review instead of vetoing',
  H3_no_auto_preserved:
    'critical veto -> changed; else full-run-unanimous rubric changed -> changed; everything else -> review. Never produces an automatic preserved. Uses no embedding, so it is threshold-independent.',
  H4_no_auto_preserved_critical_review:
    'critical mismatch -> review; else full-run-unanimous rubric changed -> changed; everything else -> review. H3 with the critical veto demoted to a review trigger, and nothing else changed. Never produces an automatic preserved. Uses no embedding, so it is threshold-independent.',
};

/** The rules that use no embedding, and whose figures therefore cannot move with the threshold. */
export const THRESHOLD_INDEPENDENT_RULES = ['H3_no_auto_preserved', 'H4_no_auto_preserved_critical_review'];

/**
 * Score one tri-state run over the whole corpus.
 *
 * @param rows every probe, each with `id`, `gold`, `hard_negative`, `decision`
 *   and `by`.
 */
export function scoreHybrid(rows) {
  const automatic = rows.filter((r) => r.decision !== 'review');
  const review = rows.filter((r) => r.decision === 'review');
  const decided = automatic.map((r) => ({ ...r, predicted: r.decision }));

  return {
    auto_changed: rows.filter((r) => r.decision === 'changed').length,
    auto_preserved: rows.filter((r) => r.decision === 'preserved').length,
    review_count: review.length,
    review_rate: rate(review.length, rows.length),
    review_ids: review.map((r) => r.id),
    automatic_coverage: rate(automatic.length, rows.length),
    decided_by: rows.reduce((counts, r) => ({ ...counts, [r.by]: (counts[r.by] ?? 0) + 1 }), {}),
    ...confusion(decided),
    // Given every row, not just the ones the rule answered.
    ...hardNegativeMetrics(rows),
  };
}
