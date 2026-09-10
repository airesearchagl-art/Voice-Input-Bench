# Candidate comparison contract

Research candidate only. **These types must not be added to `src/` in P4-A.**
They are written as TypeScript because that is the least ambiguous way to state
a shape, not because they are ready to compile into production.

Every field below is either already produced by current production code or
derived from it by a rule stated in `recommended-architecture.md`.

## ComparisonRun

```ts
/** One canonical Run, and everything observed under it. Derived, never stored. */
interface ComparisonRun {
  run_id: string;
  test_id: string;

  /** Straight from the verified manifest — the condition being held constant. */
  evidence: {
    manifest_schema_version: number;
    source_sha256: string;
    audio_sha256: string;
    generated_at: string;
    segment_count: number;
  };

  /** Grouped by tool, in STT_TOOL_IDS order. */
  tools: ComparisonToolGroup[];

  /**
   * Rejected Evaluations that name no Result.
   *
   * They cannot be attributed, and they are not dropped: an artifact that
   * cannot say which Result it measured is still evidence that something was
   * attempted and did not survive readback.
   */
  unattributed_rejected: ComparisonEvaluationEntry[];

  completeness: RunCompleteness;
  ordering: OrderingRules;
}
```

## ComparisonToolGroup

```ts
/**
 * All Results one tool produced for this Run.
 *
 * A list rather than a single Result on purpose: three Results for one tool
 * under one Run is a real state in the current tree, and none of them is
 * automatically the authoritative one.
 */
interface ComparisonToolGroup {
  tool: { id: SttToolId; name: string; version: string | null };
  results: ComparisonResult[];
}
```

## ComparisonResult

```ts
interface ComparisonResult {
  result_id: string;
  captured_at: string;

  capture: { method: 'manual-paste'; delivery_path: DeliveryPath };

  /** 'sealed' | 'legacy-unsealed' — legacy is shown, never counted. */
  integrity_trust: IntegrityTrust;

  /** Absent when the Result itself did not verify. */
  transcript?: string;

  /** Present when the Result did not verify; the Result is still listed. */
  rejection?: { reason: string; message: string; detail?: string };

  /** One group per evaluator in EVALUATOR_IDS order, including empty ones. */
  evaluations: ComparisonEvaluationGroup[];

  completeness: ResultCompleteness;
}
```

An evaluator with no Evaluation still gets a group, with an empty `entries` and
`state: 'missing'`. A missing evaluator is a fact about the comparison and has
to occupy space in it; omitting the group would make an incomplete Result look
like a shorter complete one.

## ComparisonEvaluationGroup

```ts
interface ComparisonEvaluationGroup {
  evaluator_id: EvaluatorId;
  schema_version: 1 | 2 | 3 | 4;

  /** Every attempt, verified and rejected, evaluation_id ascending. */
  entries: ComparisonEvaluationEntry[];

  /** Chosen only from verified entries. Null when none verifies. */
  headline: ComparisonEvaluationEntry | null;

  /** Why that entry, in a closed vocabulary — never prose. */
  selection_reason: SelectionReason | null;

  state: GroupState;
}

type SelectionReason =
  | 'only-verified-entry-v1'
  | 'newest-verified-by-id-v1';

type GroupState =
  | 'complete'                 // one verified entry, nothing rejected
  | 'partial'                  // a verified headline, plus rejected siblings
  | 'multiple_candidates'      // more than one verified entry; a choice was made
  | 'conflicting_evidence'     // verified entries disagree — never auto-resolved
  | 'has_rejected_evidence'    // entries exist, none verifies
  | 'missing';                 // no entry at all
```

`multiple_candidates` and `conflicting_evidence` are different claims.
The first says a choice was made among equivalent readings; the second says the
readings do not agree. For v1–v3 only the first can occur, because readback
recomputes those metrics from the same bytes. For v4 both can, because a
Semantic Evaluation is historical execution evidence rather than a recomputation.

## ComparisonEvaluationEntry

```ts
interface ComparisonEvaluationEntry {
  evaluation_id: string;
  status: 'verified' | 'rejected';

  /** Unknown for a rejected artifact whose evaluator record is unreadable. */
  evaluator_id: EvaluatorId | null;
  schema_version: number | null;
  created_at: string | null;

  /** Verified only. One variant per schema; never a merged score. */
  summary?: RawSummary | SurfaceSummary | CriticalSummary | SemanticSummary;

  /** Rejected only. Carried verbatim from the verifier. */
  reason?: string;
  message?: string;
  detail?: string;
}
```

Per-schema summaries stay separate all the way down:

```ts
interface RawSummary {
  kind: 'raw-char-v1';
  exact_match: boolean;
  cer: number;
  edit_distance: number;
  substitutions: number; deletions: number; insertions: number;
  reference_chars: number; hypothesis_chars: number;
}

interface SurfaceSummary {
  kind: 'surface-normalized-char-v1';
  exact_match: boolean;
  cer: number;
  edit_distance: number;
  substitutions: number; deletions: number; insertions: number;
  normalized: { reference: { sha256: string; chars: number };
                hypothesis: { sha256: string; chars: number } };
}

interface CriticalSummary {
  kind: 'critical-info-v1';
  exact_entity_multiset_match: boolean;
  preservation_rate: number;
  reference_entities: number; hypothesis_entities: number;
  matched: number; missing: number; extra: number;
  /** Canonical keys only — enough to audit, without re-printing the text. */
  missing_keys: string[];
  extra_keys: string[];
}

interface SemanticSummary {
  kind: 'semantic-h3-v1';
  /** Exactly the production vocabulary. There is no third value. */
  decision: 'changed' | 'review';
  decision_by: SemanticDecisionSource;
  critical_guard: { status: SemanticCriticalStatus; applicable: boolean; mismatch: boolean };
  execution: {
    status: 'completed' | 'skipped_by_critical_veto';
    runs_recorded: number;
    runs_parseable: number;
    runs_exact_format: number;
    full_run_unanimous: boolean;
  };
  model: { runtime_version: string; model_id: string;
           model_digest: string; prompt_sha256: string } | null;
}
```

`SemanticSummary` has no boolean named anything like `passed`, and no field that
could be rendered as one. `review` is a decision value, not a degraded `changed`.

## Completeness

```ts
interface ResultCompleteness {
  state: 'complete' | 'partial' | 'not_eligible';
  evaluators_present: EvaluatorId[];
  evaluators_missing: EvaluatorId[];
  evaluators_with_only_rejected: EvaluatorId[];
  rejected_count: number;
}

interface RunCompleteness {
  state: 'complete' | 'partial';
  sealed_results: number;
  legacy_unsealed_results: number;
  results_missing_all_evaluators: number;
  unattributed_rejected: number;
}
```

`not_eligible` is reserved for a legacy unsealed v1 Result. It is not `missing`:
nothing is expected of it, because strict Evaluation requires a sealed Result v2.
Four such Results exist today.

## Ordering rules, carried in the payload

```ts
interface OrderingRules {
  tools: 'stt-tool-ids-declared-order-v1';
  results: 'result-id-ascending-v1';
  evaluators: 'evaluator-ids-declared-order-v1';
  evaluations: 'evaluation-id-ascending-v1';
  headline: 'newest-verified-by-id-v1';
}
```

Naming the rules in the payload means a Report can cite the ordering it was
built under, and a later change of rule is visible rather than silent.

## ComparisonSnapshot / ReportSource

The selection a Report freezes. Identities and hashes only — **no verification
verdicts**, because a verdict is a property of the verifier that ran, not of the
artifact.

```ts
interface ReportSource {
  report_contract_version: 1;

  run_id: string;
  test_id: string;
  source_sha256: string;
  audio_sha256: string;

  results: Array<{
    result_id: string;
    tool_id: SttToolId;
    transcript_sha256: string;
    /** The exact Evaluations cited, and why each was the one used. */
    evaluations: Array<{
      evaluation_id: string;
      evaluator_id: EvaluatorId;
      semantic_sha256: string;
      selection_reason: SelectionReason;
    }>;
  }>;

  /** Named so a re-render can tell whether it is reproducing the same view. */
  ordering: OrderingRules;

  /** What was already incomplete when the report was made. */
  completeness: RunCompleteness;
}
```

A re-render loads exactly these ids, re-verifies them, and reports any that no
longer verify. It never reuses a stored verdict.
