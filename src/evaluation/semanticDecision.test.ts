import { describe, expect, it } from 'vitest';
import {
  SEMANTIC_DECISION_SOURCES,
  deriveSemanticDecision,
  isSemanticDecisionValue,
  tallySemanticRuns,
  type SemanticVotableRun,
} from './semanticDecision';
import type { SemanticVerdict } from './semanticRubric';

/**
 * H3, as a table.
 *
 * The one rule worth reading the whole file for: **no input produces
 * `preserved`.** Three agreeing answers from a local 8B model are not evidence
 * that meaning survived — they are evidence that nothing in the pipeline
 * noticed a change, which is a different claim and a much weaker one. So
 * agreement on "preserved" routes to human review exactly like silence does.
 */

function verdict(meaningPreserved: boolean): SemanticVerdict {
  return {
    meaning_preserved: meaningPreserved,
    severity: meaningPreserved ? 'none' : 'major',
    negation: false,
    direction_location: false,
    instruction_action: false,
    critical_fact: !meaningPreserved,
    domain_term: false,
    reason_codes: meaningPreserved ? [] : ['VALUE'],
    short_rationale: 'x',
  };
}

const CHANGED: SemanticVotableRun = { parseable_schema_valid: true, parsed_output: verdict(false) };
const PRESERVED: SemanticVotableRun = { parseable_schema_valid: true, parsed_output: verdict(true) };
const INVALID: SemanticVotableRun = { parseable_schema_valid: false, parsed_output: null };

function decide(runs: SemanticVotableRun[], requested = 3) {
  return deriveSemanticDecision(false, tallySemanticRuns(runs, requested));
}

describe('full-run unanimity', () => {
  it('needs three requested, three recorded, three parseable and three agreeing', () => {
    const tally = tallySemanticRuns([CHANGED, CHANGED, CHANGED], 3);
    expect(tally).toMatchObject({
      requested_runs: 3,
      completed_runs: 3,
      valid_runs: 3,
      invalid_runs: 0,
      changed_votes: 3,
      preserved_votes: 0,
      full_run_unanimous: true,
      unanimous_label: 'changed',
    });
  });

  it('is not reached by two agreeing runs and one unparseable one', () => {
    // Two answers and one silence. Reading that as agreement is how a missing
    // run turns into a verdict nobody gave.
    const tally = tallySemanticRuns([CHANGED, CHANGED, INVALID], 3);
    expect(tally.valid_runs).toBe(2);
    expect(tally.invalid_runs).toBe(1);
    expect(tally.full_run_unanimous).toBe(false);
  });

  it('is not reached when a run was never made', () => {
    const tally = tallySemanticRuns([CHANGED, CHANGED], 3);
    expect(tally.completed_runs).toBe(2);
    expect(tally.full_run_unanimous).toBe(false);
  });

  it('is not reached by a split vote', () => {
    expect(tallySemanticRuns([CHANGED, CHANGED, PRESERVED], 3).full_run_unanimous).toBe(false);
  });

  it('counts a run with no parsed output as invalid even if the flag says otherwise', () => {
    // A tampered artifact could claim parseable with nothing parsed. It gets no
    // vote either way.
    const liar: SemanticVotableRun = { parseable_schema_valid: true, parsed_output: null };
    expect(tallySemanticRuns([liar, liar, liar], 3).valid_runs).toBe(0);
  });
});

describe('the H3 decision table', () => {
  it('3 changed => changed', () => {
    expect(decide([CHANGED, CHANGED, CHANGED])).toEqual({
      value: 'changed',
      by: 'full-run-unanimous-changed-v1',
    });
  });

  it('3 preserved => review, never preserved', () => {
    expect(decide([PRESERVED, PRESERVED, PRESERVED])).toEqual({
      value: 'review',
      by: 'full-run-unanimous-preserved-requires-review-v1',
    });
  });

  it('2 changed + 1 invalid => review', () => {
    expect(decide([CHANGED, CHANGED, INVALID])).toEqual({
      value: 'review',
      by: 'incomplete-run-evidence-v1',
    });
  });

  it('2 changed + a missing third run => review', () => {
    expect(decide([CHANGED, CHANGED])).toEqual({
      value: 'review',
      by: 'incomplete-run-evidence-v1',
    });
  });

  it('a split vote => review', () => {
    expect(decide([CHANGED, CHANGED, PRESERVED])).toEqual({
      value: 'review',
      by: 'split-vote-v1',
    });
    expect(decide([PRESERVED, PRESERVED, CHANGED])).toEqual({
      value: 'review',
      by: 'split-vote-v1',
    });
  });

  it('all invalid => review', () => {
    expect(decide([INVALID, INVALID, INVALID])).toEqual({
      value: 'review',
      by: 'no-valid-run-evidence-v1',
    });
  });

  it('no runs at all => review', () => {
    expect(decide([])).toEqual({ value: 'review', by: 'no-valid-run-evidence-v1' });
  });

  it('a critical mismatch decides changed on its own', () => {
    // The guard runs before the model and ends the evaluation. The tally is
    // null because nothing was asked.
    expect(deriveSemanticDecision(true, null)).toEqual({
      value: 'changed',
      by: 'critical-guard-veto-v1',
    });
  });

  it('a critical mismatch overrides three preserved votes', () => {
    // Not a tie-break: a supported numeric mismatch is a change no rubric gets
    // to argue with.
    expect(
      deriveSemanticDecision(true, tallySemanticRuns([PRESERVED, PRESERVED, PRESERVED], 3)),
    ).toEqual({ value: 'changed', by: 'critical-guard-veto-v1' });
  });

  it('a missing tally without a veto is review, not a quieter verdict', () => {
    // A broken artifact fails towards more human attention.
    expect(deriveSemanticDecision(false, null)).toEqual({
      value: 'review',
      by: 'no-valid-run-evidence-v1',
    });
  });
});

describe('preserved is unreachable', () => {
  it('is not a decision value the runtime accepts', () => {
    expect(isSemanticDecisionValue('changed')).toBe(true);
    expect(isSemanticDecisionValue('review')).toBe(true);
    expect(isSemanticDecisionValue('preserved')).toBe(false);
    expect(isSemanticDecisionValue('safe')).toBe(false);
    expect(isSemanticDecisionValue('pass')).toBe(false);
  });

  it('is produced by no combination of three runs', () => {
    // Exhaustive over every arrangement of the three run outcomes, at every
    // length from zero to three.
    const options = [CHANGED, PRESERVED, INVALID];
    const seen = new Set<string>();
    const walk = (runs: SemanticVotableRun[]): void => {
      const decision = decide(runs);
      seen.add(decision.value);
      expect(['changed', 'review']).toContain(decision.value);
      expect(SEMANTIC_DECISION_SOURCES).toContain(decision.by);
      if (runs.length === 3) return;
      for (const option of options) walk([...runs, option]);
    };
    walk([]);
    expect(seen).toEqual(new Set(['changed', 'review']));
  });

  it('names no decision source that sounds like approval', () => {
    for (const source of SEMANTIC_DECISION_SOURCES) {
      expect(source).not.toMatch(/\b(safe|pass|ok)\b/);
    }
    // `preserved` appears in exactly one source name, and that source routes to
    // review — it describes what the model said, not what was concluded.
    const mentioning = SEMANTIC_DECISION_SOURCES.filter((source) => source.includes('preserved'));
    expect(mentioning).toEqual(['full-run-unanimous-preserved-requires-review-v1']);
  });
});
