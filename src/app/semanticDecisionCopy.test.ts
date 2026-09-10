import { describe, expect, it } from 'vitest';
import type { SemanticEvaluationV4 } from '@/evaluation/semanticEvaluationSchema';
import {
  SEMANTIC_DECISION_RULES,
  SEMANTIC_INPUT_NOTE,
  semanticDecisionLabel,
  semanticRouteNote,
  semanticRouteOf,
  semanticRunSummary,
} from './semanticDecisionCopy';

/**
 * What the Semantic panel tells an operator, held to what the evaluator does.
 *
 * The screen is where the policy is actually read. An explanation that covers
 * only the model route is wrong in the one case the operator is most likely to
 * be looking at — a p12 self-correction, which shows CHANGED with no model run
 * at all — and a reader who trusts the sentence learns a rule the bench does
 * not follow.
 */

/** A p12-shaped artifact: the guard vetoed, so nothing was contacted. */
const VETO_ARTIFACT = {
  decision: { value: 'changed', by: 'critical-guard-veto-v1' },
  critical: { status: 'applied', applicable: true, mismatch: true },
  execution: { status: 'skipped_by_critical_veto', runs: [] },
} as unknown as SemanticEvaluationV4;

/** A p14-shaped artifact: no veto, three unanimous model runs. */
const MODEL_ARTIFACT = {
  decision: { value: 'changed', by: 'full-run-unanimous-changed-v1' },
  critical: { status: 'not_applicable_no_reference_entity', applicable: false, mismatch: false },
  execution: {
    status: 'completed',
    runs: [1, 2, 3].map(() => ({
      parseable_schema_valid: true,
      exact_output_contract_valid: true,
      parsed_output: { meaning_preserved: false },
    })),
  },
} as unknown as SemanticEvaluationV4;

describe('the Semantic panel never says PRESERVED', () => {
  it('has only two verdict labels', () => {
    expect(semanticDecisionLabel(VETO_ARTIFACT)).toBe('CHANGED');
    expect(semanticDecisionLabel(MODEL_ARTIFACT)).toBe('CHANGED');
    expect(
      semanticDecisionLabel({
        decision: { value: 'review' },
      } as unknown as SemanticEvaluationV4),
    ).toBe('REVIEW REQUIRED');
  });

  it('uses none of the words the evaluator cannot earn', () => {
    const copy = [...SEMANTIC_DECISION_RULES, SEMANTIC_INPUT_NOTE].join(' ');
    for (const forbidden of ['SAFE', 'PASS']) {
      expect(copy).not.toContain(forbidden);
    }
    // PRESERVED appears once, and only to say it is never produced.
    expect(copy).toContain('PRESERVED を出しません');
  });
});

describe('the explained policy covers both routes', () => {
  it('states the Critical veto route, not only the unanimous one', () => {
    const copy = SEMANTIC_DECISION_RULES.join(' ');
    // The regression this pins: copy that describes the three-run vote alone.
    expect(copy).toContain('Critical guard');
    expect(copy).toContain('モデルを実行せず');
    expect(copy).toContain('全会一致');
    expect(copy).toContain('REVIEW REQUIRED');
  });

  it('says which text each half of the evaluator reads', () => {
    expect(SEMANTIC_INPUT_NOTE).toContain('surface');
    expect(SEMANTIC_INPUT_NOTE).toContain('raw');
  });
});

describe('a p12-style veto card explains itself consistently', () => {
  it('shows CHANGED, no model execution, and a veto explanation together', () => {
    expect(semanticRouteOf(VETO_ARTIFACT)).toBe('critical-veto');
    expect(semanticDecisionLabel(VETO_ARTIFACT)).toBe('CHANGED');
    expect(semanticRunSummary(VETO_ARTIFACT)).toBe('モデル実行なし');

    const note = semanticRouteNote(VETO_ARTIFACT);
    expect(note).toContain('モデルを実行せず');
    expect(note).toContain('CHANGED');
    // The card must not claim a vote it never took.
    expect(note).not.toContain('3 回');
  });

  it('does not describe the model route as the reason for a veto decision', () => {
    // Guards the exact contradiction: CHANGED + `モデル実行なし` on the same card
    // as a sentence saying three runs agreed.
    const note = semanticRouteNote(VETO_ARTIFACT);
    expect(note).not.toContain('全会一致');
  });
});

describe('a model-route card explains itself consistently', () => {
  it('shows the three-run vote and a matching explanation', () => {
    expect(semanticRouteOf(MODEL_ARTIFACT)).toBe('model');
    expect(semanticRunSummary(MODEL_ARTIFACT)).toBe(
      '3/3 parseable・3/3 exact format・changed 3 / preserved 0',
    );

    const note = semanticRouteNote(MODEL_ARTIFACT);
    expect(note).toContain('3 回');
    expect(note).toContain('全会一致');
    expect(note).not.toContain('モデルを実行せず');
  });
});
