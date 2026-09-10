# Candidate comparison contract

Research candidate only. **These types must not be added to `src/` in P4-A.**
They are written as TypeScript because that is the least ambiguous way to state
a shape, not because they are ready to compile into production.

Every field below is either already produced by current production code or
derived from it by a rule stated here. Where the shape production returns cannot
support a field, this document says so rather than inventing one.

## The trust rule, applied consistently

An artifact that failed verification has not earned the right to be filed
anywhere its own claims would put it. Production already works this way for
Results and states why: a rejected `ResultListEntry` carries `trustedToolId`
only when the tool contract itself survived, and without a seal that field is
"a shape check rather than trustworthy attribution"
(`src/results/saveResult.ts:185-198`). The Session matrix routes anything else
to `unattributedRejected` (`src/sessions/comparisonMatrix.ts:194-209`).

Applied without exception, that rule has three consequences, and the third is
the one this revision had to fix.

### 1. Evaluator groups are built from verified entries only

A rejected `EvaluationListEntry` carries `evaluationId`, an optional `resultId`,
and `reason`/`message`/`detail` — **and no evaluator id at all**
(`createEvaluation.ts:660-682`). There is no trusted evaluator for a rejected
Evaluation, ever.

So the stored `evaluator.id` inside a rejected file is never read to place it:

```text
rejected Evaluation, result_id known    -> ComparisonResult.unclassified_rejected_evaluations[]
rejected Evaluation, result_id unknown  -> ComparisonRun.unattributed_rejected_evaluations[]
```

**What this costs, stated plainly.** A group can no longer report
`only_rejected`. If a Result has one rejected Evaluation and no verified
`surface-normalized-char-v1`, the honest reading is *"no verified surface
evidence, and one unusable artifact that may or may not have been surface"* —
not *"surface was attempted and failed"*. The earlier draft claimed the latter,
and it was reading an untrusted field to do it.

The "something was attempted and cannot be used" signal is not lost; it moves to
the Result, where it can be stated without a guess.

### 2. Legacy unsealed Results are not trusted tool evidence

`integrity_trust: 'legacy-unsealed'` means nothing proves the `tool` section was
not edited after the fact (`resultSchema.ts:15-28`). Such a Result is shown, but
never inside a tool group, because a tool group is a claim about which tool
produced what.

### 3. Nothing is dropped for lacking a home

Every container below exists so that refusing to guess never means discarding.
An Evaluation that names a Result which itself could not be attributed still has
somewhere to go.

## ComparisonRun

```ts
/** One canonical Run, and everything observed under it. Derived, never stored. */
interface ComparisonRun {
  run_id: string;
  test_id: string;

  evidence: {
    manifest_schema_version: number;
    source_sha256: string;
    audio_sha256: string;
    generated_at: string;
    segment_count: number;
  };

  /** Trusted tool evidence only: sealed, verified or attributable. */
  tools: ComparisonToolGroup[];

  /**
   * Unsealed Results. Real observations, shown, never counted as tool evidence.
   *
   * Their tool claim is readable and is labelled as a claim, not as identity.
   */
  legacy_unsealed_results: ComparisonLegacyResult[];

  /** Rejected Results whose tool identity did not survive verification. */
  unattributed_results: UnattributedResult[];

  /** Rejected Evaluations that name no Result at all. */
  unattributed_rejected_evaluations: ComparisonEvaluationEntry[];

  completeness: RunCompleteness;
  ordering: OrderingRules;
}

interface UnattributedResult {
  result_id: string;
  reason_class:
    | 'no-seal'
    | 'tool-identity-unverified'
    /** Sealed and `other`, but the custom tool's name is not exposed. */
    | 'custom-tool-identity-unavailable';
  reason: string;
  message: string;
  detail?: string;
  integrity_trust: IntegrityTrust | null;

  /**
   * Evaluations naming this Result.
   *
   * The Result has no trusted place in the comparison, so its Evaluations have
   * nowhere to hang. They are kept here rather than dropped: they are evidence
   * that work was done against a Result that can no longer be placed.
   */
  related_rejected_evaluations: ComparisonEvaluationEntry[];
  related_verified_evaluations: ComparisonEvaluationEntry[];
}
```

## Tool identity

Grouping by `tool.id` alone is wrong for one of the three ids. `STT_TOOL_IDS` is
`['windows-standard-voice-input', 'aqua-voice', 'other']` (`tools.ts:9`), and
`other` is a bucket whose real identity is the operator-supplied name
(`tools.ts:91-98`). Two unrelated custom tools would collapse into one column.

```ts
type ToolIdentity =
  | { kind: 'built-in'; id: 'windows-standard-voice-input' | 'aqua-voice' }
  /** Identity is (id, trusted_name). The name must come from a verified seal. */
  | { kind: 'custom'; id: 'other'; trusted_name: string };

interface ComparisonToolGroup {
  tool: ToolIdentity;
  /** Verified, rejected-but-attributable, ordered by result_id ascending. */
  results: ComparisonResult[];
}
```

- Built-in groups key on `id`.
- Custom groups key on `(id, trusted_name)`, and a custom identity can only be
  established by a **verified sealed** Result, because that is the only place a
  trustworthy `tool.name` is available.
- A rejected `other` Result exposes `trustedToolId: 'other'` but no name
  (`saveResult.ts:185-198`), so it cannot be placed in any specific custom
  group. It goes to `unattributed_results` with
  `reason_class: 'custom-tool-identity-unavailable'`. Guessing which custom tool
  it belonged to would be exactly the mistake `trustedToolId` exists to prevent.
- **`tool.version` is per Result, never per group.** One tool's version can
  change between captures under the same Run, and hoisting it to the group would
  assert a version some of those Results never claimed.

*Not exercised by local data: every Result on disk is `windows-standard-voice-input`
or `aqua-voice`. The custom-tool rules are a contract requirement and a P4-B
fixture obligation, not something this tree demonstrates.*

## ComparisonResult — a discriminated union

The earlier draft had one optional-heavy shape, which invited reconstructing
`captured_at`, `capture` and `transcript` for a Result whose metadata is exactly
what failed. Those fields are simply not available on a rejected
`ResultListEntry`, so the union makes their absence structural.

```ts
type ComparisonResult =
  | ComparisonVerifiedResult
  | ComparisonRejectedResult;

/** Verified and sealed. Everything below came through verification. */
interface ComparisonVerifiedResult {
  kind: 'verified';
  result_id: string;
  captured_at: string;
  tool: { id: SttToolId; name: string; version: string | null };
  capture: { method: 'manual-paste'; delivery_path: DeliveryPath };
  integrity_trust: 'sealed';
  transcript: string;
  transcript_sha256: string;

  /** One group per evaluator in EVALUATOR_IDS order, including empty ones. */
  evaluations: ComparisonEvaluationGroup[];

  /** Rejected Evaluations naming this Result. No evaluator is inferred. */
  unclassified_rejected_evaluations: ComparisonEvaluationEntry[];

  completeness: ResultCompleteness;
}

/**
 * Rejected, but its tool identity survived — so it belongs in this column.
 *
 * Exactly the fields `ResultListEntry`'s rejected variant can supply. There is
 * no `captured_at`, no `capture` and no `transcript`, because a Result whose
 * metadata failed verification cannot vouch for any of them.
 */
interface ComparisonRejectedResult {
  kind: 'rejected';
  result_id: string;
  trusted_tool_id: SttToolId;
  integrity_trust: 'sealed';
  reason: string;
  message: string;
  detail?: string;

  /** Evaluations naming this Result. Kept, not dropped. */
  verified_evaluations: ComparisonEvaluationEntry[];
  unclassified_rejected_evaluations: ComparisonEvaluationEntry[];
}

/**
 * Unsealed. Shown at Run level, never inside a tool group.
 *
 * The tool fields are named `claimed_*` on purpose: they are readable, and
 * nothing proves they were not edited after the fact.
 */
interface ComparisonLegacyResult {
  kind: 'legacy-unsealed';
  result_id: string;
  claimed_tool_id: SttToolId | null;
  claimed_tool_name: string | null;
  claimed_tool_version: string | null;
  /** True for every field above. Rendered as an untrusted claim. */
  tool_claim_is_unverified: true;

  transcript?: string;
  verified_evaluations: ComparisonEvaluationEntry[];
  unclassified_rejected_evaluations: ComparisonEvaluationEntry[];
}
```

If P4-B wants a rejected Result to carry trustworthy `captured_at` or
`capture`, that requires **adding explicit trusted metadata to
`ResultListEntry`** in production — a deliberate, documented scope change, not
something the comparison layer reconstructs on its own.

## ComparisonEvaluationGroup

```ts
interface ComparisonEvaluationGroup {
  evaluator_id: EvaluatorId;
  schema_version: 1 | 2 | 3 | 4;

  /** Verified entries only, evaluation_id ascending. */
  entries: ComparisonEvaluationEntry[];

  /** Null when nothing verified, and null on conflict. */
  headline: ComparisonEvaluationEntry | null;
  selection_reason: SelectionReason | null;

  state: GroupEvidenceState;
}

type SelectionReason =
  | 'only-verified-entry-v1'
  | 'newest-verified-by-id-v1'
  | 'conflict-no-headline-v1';

interface GroupEvidenceState {
  /** Only two states now: a group holds verified entries or it holds none. */
  availability: 'available' | 'missing';
  verified_count: number;
  multiple_candidates: boolean;   // verified_count > 1
  conflicting_evidence: boolean;  // verified entries disagree; v4 only
}
```

`rejected_count` and `only_rejected` are gone from group state, because a
rejected Evaluation can never be attributed to a group. The overlap the previous
revision recorded — "two verified *and* one rejected sibling in one group" — was
an artifact of grouping by an untrusted field, and the corrected reading is at
Result level.

The dimensions that genuinely overlap remain separate: a group can be
`multiple_candidates` **and** `conflicting_evidence` at once, and those are
different claims — one says a selection happened among candidates, the other
says the candidates disagree.

### Optional future: `trustedEvaluatorId`

Per-evaluator attribution of rejected Evaluations is *recoverable*, but only
with a production change, and it must not be added implicitly.

The v1 verifier checks the evaluator contract before it checks the subject or
the metrics (`verifyStoredEvaluation.ts:226` then `:264`), so a rejection with
kind `EVALUATION_SUBJECT_MISMATCH` or `EVALUATION_METRICS_MISMATCH` implies the
evaluator identity *did* verify — the same reasoning that makes `trustedToolId`
sound for Results.

If P4-B wants this, it is an explicit scope change with its own contract:

```text
trustedEvaluatorId is set ONLY when the evaluator contract check passed
  before the failure occurred; absent for every other rejection kind,
  and absent whenever that cannot be established. Fail closed.
```

Until such a field exists in production, the contract above stands as written,
and no rejected Evaluation is placed in an evaluator group.

## ComparisonEvaluationEntry

```ts
interface ComparisonEvaluationEntry {
  evaluation_id: string;
  status: 'verified' | 'rejected';

  /**
   * Populated for verified entries only, and null for every rejected one.
   *
   * Not "unknown when unreadable": the rejected entry shape has no evaluator id
   * at all, so there is never a trustworthy one. The stored `evaluator` claim
   * inside the file is not promoted here after the artifact failed.
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
  cer: number; edit_distance: number;
  substitutions: number; deletions: number; insertions: number;
  reference_chars: number; hypothesis_chars: number;
}

interface SurfaceSummary {
  kind: 'surface-normalized-char-v1';
  exact_match: boolean;
  cer: number; edit_distance: number;
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
    runs_recorded: number; runs_parseable: number; runs_exact_format: number;
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
  state: 'complete' | 'partial';
  evaluators_present: EvaluatorId[];   // have a verified entry
  evaluators_missing: EvaluatorId[];   // have none
  /**
   * Evaluations naming this Result that cannot be used or attributed.
   *
   * Replaces the earlier `evaluators_with_only_rejected`, which claimed a
   * per-evaluator fact the evidence cannot support.
   */
  unclassified_rejected_count: number;
}

interface RunCompleteness {
  state: 'complete' | 'partial';
  sealed_verified_results: number;
  sealed_rejected_results: number;
  legacy_unsealed_results: number;
  unattributed_results: number;
  unattributed_rejected_evaluations: number;
  results_with_no_verified_evaluations: number;
}
```

There is no `not_eligible` state on a Result any more: a legacy unsealed Result
is a `ComparisonLegacyResult` by type, so its ineligibility is structural rather
than a flag that has to be read.

## Ordering rules, carried in the payload

```ts
interface OrderingRules {
  tools: 'stt-tool-ids-declared-order-then-trusted-name-v1';
  results: 'result-id-ascending-v1';
  evaluators: 'evaluator-ids-declared-order-v1';
  evaluations: 'evaluation-id-ascending-v1';
  headline: 'newest-verified-by-id-v1';
  unattributed: 'artifact-id-ascending-v1';
}
```

Custom tool groups sort after the built-ins, by `trusted_name`, so two custom
tools have a stable relative order rather than an incidental one.
