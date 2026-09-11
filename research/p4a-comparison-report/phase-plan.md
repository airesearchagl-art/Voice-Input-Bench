# Proposed Phase 4 split

Each task below is sized to end at a reviewable gate, and none of them requires
the next one to exist to be useful.

## P4-A — Comparison / Report Architecture Spike (this task)

Research only. Production files changed: 0. Data artifacts changed: 0.

Ends at Independent Architecture Review + Human Adoption.

## P4-B — Run Comparison read model + API + UI

The derived, evaluation-aware comparison for one Run.

**Scope**

- A pure read-model builder: `(runId) -> ComparisonRun`, assembled from
  `verifyRunEvidence`, `listResultsForRun` and `listEvaluationsForRun`.
- Grouping by tool and by `(result_id, evaluator_id)`.
- Evaluator groups built from **verified entries only**, with headline
  selection and `selection_reason`.
- The `ComparisonResult` discriminated union (verified / rejected / legacy) and
  tool identity that keeps custom `other` tools distinct.
- The attribution containers: `unclassified_rejected_evaluations`,
  `unattributed_rejected_evaluations`, `unattributed_results` with their
  `related_*_evaluations`, and `legacy_unsealed_results`.
- Deterministic ordering consumed from the existing constants — `STT_TOOL_IDS`
  and `EVALUATOR_IDS` — rather than restated.
- `GET /api/comparisons/run/:runId`.

**Optional, only if adopted deliberately:** a fail-closed `trustedEvaluatorId`
on `EvaluationListEntry`, set only when the evaluator contract verified before
the failure. It would let rejected Evaluations be attributed per evaluator
again. It is a production change with its own contract and must be scoped
explicitly, never added implicitly. See `comparison-contract.md`.
- A comparison view: tools side by side, four evaluator rows per Result.

**Explicitly out of scope**

- No new storage root, schema, verifier or migration.
- No report export.
- No score, ranking, winner or synthesis.
- No change to `semantic-h3-v1`, `critical-info-v1`, `surface-normalize-v1` or
  `raw-char-v1`.

**Test obligations that local data cannot satisfy.** These need synthetic
fixtures, because the tree contains no example:

- `semantic-h3-v1` deciding `review`, including
  `full-run-unanimous-preserved-requires-review-v1`, rendering as REVIEW
  REQUIRED and never as a pass;
- two *verified* v4 Evaluations that disagree, producing `conflicting_evidence`
  and resolving nothing.

**Test obligations local data does satisfy** — and which should be pinned
against real fixtures: multiple Results per tool, six groups with multiple
verified Evaluations, Results carrying unclassified rejected Evaluations,
missing evaluators, legacy unsealed Results kept out of tool groups, and
rejected artifacts that carry no trustworthy evaluator.

**Also not exercised by local data.** All 9 Results verify, and 4 of them are
legacy-unsealed-verified — which is the *only* one of the four Result states
this tree contains. These need fixtures:

```text
verified legacy Result              present (4)
rejected legacy Result              absent — fixture needed
rejected built-in attributable      absent — fixture needed
rejected `other`, not attributable  absent — fixture needed
```

Every Result on disk is also a built-in tool, so the custom `other` identity
rules — two custom tools never sharing a column, and a rejected `other` never
being guessed into one — need fixtures as well.

**Definition of done.** A comparison for either populated Run renders every
Result and every evaluator group, names every Evaluation id it considered, shows
the six `multiple_candidates` groups as such, keeps every rejected Evaluation
visible at Result or Run level without inferring an evaluator for it, keeps
legacy unsealed Results out of the tool groups while still showing them, and
names every Evaluation exactly once across all containers.

## P4-C — Deterministic Report generation

Markdown export over the P4-B model.

**Scope**

- `ReportSource`: the frozen evidence selection — for every group, **every**
  Evaluation id considered, plus hashes, ordering rule ids and selection
  reasons. No verification verdicts.
- Deterministic Markdown rendering, four evaluator sections, gaps included.
- `content_sha256` over the selection plus the rendered body, excluding
  `generated_at`.
- Byte identity for every artifact read, plus `transcript_sha256` for verified
  Results, so a re-render can report `evidence_changed` separately from a change
  in verifier outcome.
- Re-render: reload exactly the cited ids, compare byte hashes, then re-verify,
  and state anything that changed under either heading.

**Decide during P4-C, not before:** whether the Report package — `ReportSource`
JSON plus rendered Markdown — is an app-managed immutable artifact under a fifth
root, or files the operator exports. P4-A fixes the contract; P4-B has to exist
first to show what the model looks like in use.

**Out of scope.** No model call. No score. No ranking.

## P4-D — Cross-Run / Session aggregation — only if justified

**Recommendation: do not schedule this yet.**

A Session-level coverage matrix already exists and deliberately reports coverage
rather than accuracy. Extending it to evaluations raises the aggregation
question this phase is specifically avoiding: what "the Critical result for this
Case" means across tools is a judgement, and answering it with a number is how a
bench acquires a ranking nobody agreed to.

Revisit only when a concrete operator need appears that P4-B and P4-C cannot
meet, and treat it as its own architecture spike with its own Human Gate.

## Not in Phase 4 at all

- STT automation for Windows or Aqua. Manual capture is the current contract and
  automating it is a separate problem with its own evidence questions.
- Any change to the four evaluators' semantics.
- Any migration of existing artifacts.

## Sequencing

```text
P4-A  spike            → Human Adoption
P4-B  read model + UI  → Independent Review
P4-C  report           → Independent Review
P4-D  deferred, needs its own justification
```

P4-B and P4-C are separable: the comparison view is useful without export, and
the report is a thin deterministic layer over a model that already exists. If
only one ships, it should be P4-B.
