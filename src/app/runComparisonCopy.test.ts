import { describe, expect, it } from 'vitest';
import type { SemanticSummary } from '@/comparisons/runComparison';
import { SEMANTIC_DECISION_SOURCES } from '@/evaluation/semanticDecision';
import {
  COMPARISON_POLICY_NOTE,
  MISSING_EVALUATOR_NOTE,
  SELECTION_REASON_NOTES,
  SEMANTIC_DECISION_SOURCE_NOTES,
  UNATTRIBUTED_REASON_NOTES,
  groupStateLine,
  missingWithRejectedNote,
  semanticRunLine,
  semanticVerdictLabel,
} from './runComparisonCopy';

/**
 * The Run Comparison's wording, held to policy.
 *
 * The view must never say anything a reader could take as a grade. `review` is
 * outstanding work, a Critical veto's zero runs is a route rather than a gap,
 * and a missing evaluator is neither zero nor a failure nor a pass.
 */

/** A verdict-shaped word the Semantic view is never allowed to print. */
const GRADE_WORDS = /\b(PASS|PASSED|SAFE|PRESERVED|OK)\b/;

function semantic(overrides: Partial<SemanticSummary> = {}): SemanticSummary {
  return {
    kind: 'semantic-h3-v1',
    decision: 'review',
    decision_by: 'full-run-unanimous-preserved-requires-review-v1',
    critical_guard: { status: 'applied', applicable: true, mismatch: false },
    execution: {
      status: 'completed',
      runs_recorded: 3,
      runs_parseable: 3,
      runs_exact_format: 3,
      full_run_unanimous: true,
      changed_votes: 0,
      preserved_votes: 3,
    },
    model: null,
    ...overrides,
  };
}

describe('Semantic verdict wording', () => {
  it('renders review as REVIEW REQUIRED, even when all three runs said preserved', () => {
    expect(semanticVerdictLabel(semantic())).toBe('REVIEW REQUIRED');
    expect(SEMANTIC_DECISION_SOURCE_NOTES['full-run-unanimous-preserved-requires-review-v1']).toContain(
      'REVIEW REQUIRED',
    );
  });

  it('renders changed as CHANGED', () => {
    expect(
      semanticVerdictLabel(semantic({ decision: 'changed', decision_by: 'full-run-unanimous-changed-v1' })),
    ).toBe('CHANGED');
  });

  it('has a note for every production decision source, none of them a grade', () => {
    expect(Object.keys(SEMANTIC_DECISION_SOURCE_NOTES).sort()).toEqual([...SEMANTIC_DECISION_SOURCES].sort());
    for (const note of Object.values(SEMANTIC_DECISION_SOURCE_NOTES)) {
      expect(note).not.toMatch(GRADE_WORDS);
    }
    for (const source of SEMANTIC_DECISION_SOURCES) {
      const expected = source === 'critical-guard-veto-v1' || source === 'full-run-unanimous-changed-v1'
        ? 'CHANGED'
        : 'REVIEW REQUIRED';
      expect(SEMANTIC_DECISION_SOURCE_NOTES[source]).toContain(expected);
    }
  });

  it('says a Critical veto skipped the model, so zero runs does not read as missing', () => {
    const veto = semantic({
      decision: 'changed',
      decision_by: 'critical-guard-veto-v1',
      critical_guard: { status: 'applied', applicable: true, mismatch: true },
      execution: {
        status: 'skipped_by_critical_veto',
        runs_recorded: 0,
        runs_parseable: 0,
        runs_exact_format: 0,
        full_run_unanimous: false,
        changed_votes: 0,
        preserved_votes: 0,
      },
    });
    expect(semanticVerdictLabel(veto)).toBe('CHANGED');
    expect(semanticRunLine(veto)).toContain('Critical veto');
    expect(semanticRunLine(veto)).toContain('欠損ではありません');
    expect(SEMANTIC_DECISION_SOURCE_NOTES['critical-guard-veto-v1']).toContain('モデルは実行していません');
  });

  it('reports model runs as counts, not as a verdict', () => {
    expect(semanticRunLine(semantic())).toBe(
      '3/3 parseable・3/3 exact format・changed 0 / preserved 3・full-run unanimous: yes',
    );
  });
});

describe('Evidence-state wording', () => {
  it('never lets a missing evaluator read as zero, failure or pass', () => {
    expect(MISSING_EVALUATOR_NOTE).toContain('0 点でも失敗でも合格でもありません');
    expect(MISSING_EVALUATOR_NOTE).not.toMatch(GRADE_WORDS);
  });

  it('marks a missing evaluator beside unusable Evaluations differently from a clean one', () => {
    expect(missingWithRejectedNote(0)).toBeNull();
    expect(missingWithRejectedNote(2)).toContain('2 件');
  });

  it('names a conflict and a selection as what they are', () => {
    expect(SELECTION_REASON_NOTES['conflict-no-headline-v1']).toContain('headline なし');
    expect(SELECTION_REASON_NOTES['newest-verified-by-id-v1']).toContain('優劣ではありません');
    expect(
      groupStateLine({
        availability: 'available',
        verified_count: 2,
        multiple_candidates: true,
        conflicting_evidence: true,
      }),
    ).toBe('verified 2 件・multiple candidates・CONFLICTING EVIDENCE');
  });

  it('describes every unattributed reason and promises no ranking', () => {
    expect(Object.keys(UNATTRIBUTED_REASON_NOTES).sort()).toEqual([
      'custom-tool-identity-unavailable',
      'no-seal',
      'tool-identity-unverified',
    ]);
    expect(COMPARISON_POLICY_NOTE).toContain('ランキング');
    expect(COMPARISON_POLICY_NOTE).toContain('最新・正式かは判定しません');
  });
});
