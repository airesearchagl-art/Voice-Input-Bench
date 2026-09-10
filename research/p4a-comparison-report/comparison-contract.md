# Candidate comparison contract

Research candidate only. **These types must not be added to `src/` in P4-A.**
They are written as TypeScript because that is the least ambiguous way to state
a shape, not because they are ready to compile into production.

Every field below is either already produced by current production code or
derived from it by a rule stated in `recommended-architecture.md`.

## The attribution rule this contract is built on

An artifact that failed verification has not earned the right to be filed
anywhere its own claims would put it.

Production already works this way, and states why. `ResultListEntry`'s rejected
variant carries `trustedToolId?` and documents that without a seal it is "a
shape check rather than trustworthy attribution"
(`src/results/saveResult.ts:185-198`). The Session matrix acts on that: a
rejected Result reaches a tool's cell only when `integrityTrust === 'sealed'`
**and** `trustedToolId` matches, and otherwise goes to `unattributedRejected`
(`src/sessions/comparisonMatrix.ts:194-209`), because "one broken Windows
observation must not show up as a failure of Aqua Voice" (`:236-239`).

The comparison contract adopts the same rule at both levels:

```text
rejected Result
  sealed AND trustedToolId present   → that tool's group
  otherwise                          → ComparisonRun.unattributed_results[]

rejected Evaluation
  result_id known, evaluator known and trusted   → that evaluator's group
  result_id known, evaluator not trustworthy     → ComparisonResult
                                                    .unclassified_rejected_evaluations[]
  result_id unknown                              → ComparisonRun
                                                    .unattributed_rejected_evaluations[]
```

`EvaluationListEntry`'s rejected variant carries no `evaluatorId` at all
(`createEvaluation.ts:660-682`), so for a rejected Evaluation the middle case is
the normal one, not the exception.

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
   * Rejected Results whose tool cannot be trusted.
   *
   * Either no seal survived, or the `tool` section itself is what failed. Their
   * stored `tool.id` is readable and is deliberately not used: filing a failure
   * under a tool on the strength of an unverified claim would attribute it to a
   * tool that may have had nothing to do with it.
   */
  unattributed_results: UnattributedResult[];

  /**
   * Rejected Evaluations that name no Result at all.
   *
   * They cannot be attributed, and they are not dropped: an artifact that
   * cannot say which Result it measured is still evidence that something was
   * attempted and did not survive readback.
   */
  unattributed_rejected_evaluations: ComparisonEvaluationEntry[];

  completeness: RunCompleteness;
  ordering: OrderingRules;
}

interface UnattributedResult {
  result_id: string;
  /** Why it could not be placed, in a closed vocabulary. */
  reason_class: 'no-seal' | 'tool-identity-unverified';
  reason: string;
  message: string;
  detail?: string;
  integrity_trust: IntegrityTrust | null;
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

  /**
   * Rejected Evaluations that name this Result but no trustworthy evaluator.
   *
   * The common case for a rejected Evaluation, since the rejected entry shape
   * carries no evaluator id. Filing one under an evaluator would be a guess —
   * the reason for rejection can be that the evaluator record is exactly what
   * could not be read.
   */
  unclassified_rejected_evaluations: ComparisonEvaluationEntry[];

  completeness: ResultCompleteness;
}
```

An evaluator with no Evaluation still gets a group, with empty `entries` and
`availability: 'missing'`. A missing evaluator is a fact about the comparison
and has to occupy space in it; omitting the group would make an incomplete
Result look like a shorter complete one.

## ComparisonEvaluationGroup

```ts
interface ComparisonEvaluationGroup {
  evaluator_id: EvaluatorId;
  schema_version: 1 | 2 | 3 | 4;

  /** Every attempt attributable to this evaluator, evaluation_id ascending. */
  entries: ComparisonEvaluationEntry[];

  /** Chosen only from verified entries. Null when none verifies, or on conflict. */
  headline: ComparisonEvaluationEntry | null;

  /** Why that entry — or why there is none. Closed vocabulary, never prose. */
  selection_reason: SelectionReason | null;

  state: GroupEvidenceState;
}

type SelectionReason =
  | 'only-verified-entry-v1'
  | 'newest-verified-by-id-v1'
  /** Verified entries disagree; no entry is promoted. See below. */
  | 'conflict-no-headline-v1';
```

### Group state is orthogonal, not one enum

A single enum forced these into one slot and lost whichever fact came second.
The real states overlap: a group can have two verified entries *and* a rejected
sibling, and a v4 group can be conflicting *and* have rejected siblings.

```ts
interface GroupEvidenceState {
  /** Is there anything usable? Derived from the counts, never set by hand. */
  availability: 'available' | 'only_rejected' | 'missing';

  verified_count: number;
  rejected_count: number;

  /** More than one verified entry: a selection happened. */
  multiple_candidates: boolean;

  /** Verified entries disagree. Only reachable for semantic-h3-v1. */
  conflicting_evidence: boolean;
}
```

Derivation, in full:

```text
availability          = missing        when verified_count == 0 && rejected_count == 0
                        only_rejected  when verified_count == 0 && rejected_count > 0
                        available      when verified_count > 0

multiple_candidates   = verified_count > 1
conflicting_evidence  = verified entries disagree on decision or metrics
```

`availability: 'available'` says nothing about whether rejected siblings exist —
that is what `rejected_count` is for. The two are independent readings, and the
UI and report must show both.

**Worked against real data.** `7cdff2e8 / critical-info-v1` holds three
Evaluations: two verified, one rejected.

```text
old enum      multiple_candidates      ← "and one rejected sibling" is lost
new state     availability: available
              verified_count: 2
              rejected_count: 1
              multiple_candidates: true
              conflicting_evidence: false
```

`1ff85dda / critical-info-v1` is the same shape at 2 verified / 2 rejected. Both
are in the tree today, and under the old enum both under-reported.

## ComparisonEvaluationEntry

```ts
interface ComparisonEvaluationEntry {
  evaluation_id: string;
  status: 'verified' | 'rejected';

  /**
   * Null for every rejected entry.
   *
   * Not "unknown when unreadable" — the rejected entry shape has no evaluator
   * id at all, so there is never a trustworthy one to record. The stored
   * `evaluator` claim inside the file is not promoted to this field after the
   * artifact has failed verification.
   */
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
  /** Attributed rejected entries plus this Result's unclassified ones. */
  rejected_count: number;
  unclassified_rejected_count: number;
}

interface RunCompleteness {
  state: 'complete' | 'partial';
  sealed_results: number;
  legacy_unsealed_results: number;
  results_missing_all_evaluators: number;
  unattributed_results: number;
  unattributed_rejected_evaluations: number;
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
  unattributed: 'artifact-id-ascending-v1';
}
```

Naming the rules in the payload means a Report can cite the ordering it was
built under, and a later change of rule is visible rather than silent.

## Where the Report's frozen selection lives

`ReportSource` is defined in `report-contract.md`, because what it freezes is a
report concern rather than a view concern. It must be able to reconstruct every
container above — including the empty ones — which is why it freezes the whole
candidate set and not just the headline.
