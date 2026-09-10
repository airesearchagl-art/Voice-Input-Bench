import type { SemanticVerdict } from './semanticRubric';

/**
 * H3: how three model runs and one deterministic guard become one decision.
 *
 * This module is the whole reason a Semantic Evaluation can be verified without
 * calling the model again. Everything here is a pure function of stored
 * evidence, so readback re-derives the decision from the artifact and compares
 * it to what was written, rather than trusting it.
 *
 * The rule that shapes all of it: **there is no automatic `preserved`.** A local
 * 8B model agreeing with itself three times is not evidence that meaning
 * survived; it is evidence that nothing in the pipeline noticed a change. So
 * the decision type has two values, and "the model said preserved" routes to
 * human review exactly like "the model said nothing usable".
 */

export const SEMANTIC_VOTE_POLICY = 'full-run-unanimous-3-v1';
export const SEMANTIC_DECISION_POLICY = 'h3-no-auto-preserved-v1';

/**
 * The only two things a Semantic Evaluation may conclude.
 *
 * `preserved` is absent from the type, not merely unreachable in the code. A
 * later edit that tries to return it does not compile.
 */
export type SemanticDecisionValue = 'changed' | 'review';

/** Every reason a decision can have. Closed: readback compares against it. */
export const SEMANTIC_DECISION_SOURCES = [
  /** critical-info-v1 found a supported mismatch. The model was never asked. */
  'critical-guard-veto-v1',
  /** Three parseable runs, all saying the meaning changed. */
  'full-run-unanimous-changed-v1',
  /** Three parseable runs, all saying preserved — which H3 sends to review. */
  'full-run-unanimous-preserved-requires-review-v1',
  /** Nothing usable came back at all. */
  'no-valid-run-evidence-v1',
  /** Fewer than three usable runs: a missing run is missing evidence. */
  'incomplete-run-evidence-v1',
  /** Three usable runs that disagree. */
  'split-vote-v1',
] as const;

export type SemanticDecisionSource = (typeof SEMANTIC_DECISION_SOURCES)[number];

export interface SemanticDecision {
  value: SemanticDecisionValue;
  by: SemanticDecisionSource;
}

/** The part of a stored run the vote depends on. */
export interface SemanticVotableRun {
  parseable_schema_valid: boolean;
  parsed_output: SemanticVerdict | null;
}

export interface SemanticVoteTally {
  requested_runs: number;
  completed_runs: number;
  valid_runs: number;
  invalid_runs: number;
  preserved_votes: number;
  changed_votes: number;
  /**
   * All three requested runs happened, all three parsed, all three agreed.
   *
   * Anything less is not unanimity. "Answered twice the same way and failed
   * once" is two answers and one silence, and reading that as agreement is
   * exactly how a missing run turns into a verdict nobody gave.
   */
  full_run_unanimous: boolean;
  unanimous_label: 'preserved' | 'changed' | null;
}

/** Count the runs. Strict `=== true`, so a missing flag is not a vote. */
export function tallySemanticRuns(
  runs: readonly SemanticVotableRun[],
  requestedRuns: number,
): SemanticVoteTally {
  const valid = runs.filter(
    (run) => run.parseable_schema_valid === true && run.parsed_output !== null,
  );
  const preservedVotes = valid.filter(
    (run) => run.parsed_output?.meaning_preserved === true,
  ).length;
  const changedVotes = valid.length - preservedVotes;

  const agreed = valid.length > 0 && (preservedVotes === 0 || preservedVotes === valid.length);
  const fullRunUnanimous =
    agreed && requestedRuns > 0 && runs.length === requestedRuns && valid.length === requestedRuns;

  return {
    requested_runs: requestedRuns,
    completed_runs: runs.length,
    valid_runs: valid.length,
    invalid_runs: runs.length - valid.length,
    preserved_votes: preservedVotes,
    changed_votes: changedVotes,
    full_run_unanimous: fullRunUnanimous,
    unanimous_label: fullRunUnanimous ? (preservedVotes === valid.length ? 'preserved' : 'changed') : null,
  };
}

/**
 * Derive the H3 decision.
 *
 * `tally` is null exactly when the model was never called because the guard had
 * already decided. If it is null without a veto, that is a broken artifact
 * rather than an unanimous anything, and it goes to review: the failure mode of
 * this function must always be more review, never a quieter verdict.
 */
export function deriveSemanticDecision(
  criticalMismatch: boolean,
  tally: SemanticVoteTally | null,
): SemanticDecision {
  if (criticalMismatch) {
    return { value: 'changed', by: 'critical-guard-veto-v1' };
  }
  if (tally === null || tally.valid_runs === 0) {
    return { value: 'review', by: 'no-valid-run-evidence-v1' };
  }
  if (!tally.full_run_unanimous) {
    const incomplete =
      tally.invalid_runs > 0 ||
      tally.completed_runs !== tally.requested_runs ||
      tally.valid_runs !== tally.requested_runs;
    return { value: 'review', by: incomplete ? 'incomplete-run-evidence-v1' : 'split-vote-v1' };
  }
  if (tally.unanimous_label === 'changed') {
    return { value: 'changed', by: 'full-run-unanimous-changed-v1' };
  }
  return { value: 'review', by: 'full-run-unanimous-preserved-requires-review-v1' };
}

export function isSemanticDecisionSource(value: unknown): value is SemanticDecisionSource {
  return (
    typeof value === 'string' &&
    (SEMANTIC_DECISION_SOURCES as readonly string[]).includes(value)
  );
}

export function isSemanticDecisionValue(value: unknown): value is SemanticDecisionValue {
  return value === 'changed' || value === 'review';
}
