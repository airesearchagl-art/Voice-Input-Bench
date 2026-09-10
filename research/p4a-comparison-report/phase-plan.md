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
- Headline selection with `selection_reason`, and the completeness / conflict
  states from `comparison-contract.md`.
- Deterministic ordering consumed from the existing constants — `STT_TOOL_IDS`
  and `EVALUATOR_IDS` — rather than restated.
- `GET /api/comparisons/run/:runId`.
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
verified Evaluations, two groups with only rejected evidence, missing
evaluators, legacy unsealed Results, and rejected artifacts whose evaluator is
unreadable.

**Definition of done.** A comparison for either populated Run renders every
Result and every evaluator group, names every Evaluation id it used, and shows
the six `multiple_candidates` groups and the two `has_rejected_evidence` groups
as such.

## P4-C — Deterministic Report generation

Markdown export over the P4-B model.

**Scope**

- `ReportSource`: the frozen evidence selection — ids, hashes, ordering rule ids,
  selection reasons. No verification verdicts.
- Deterministic Markdown rendering, four evaluator sections, gaps included.
- `content_sha256` over the selection plus the rendered body, excluding
  `generated_at`.
- Re-render: reload the cited ids, re-verify now, state anything that no longer
  verifies.

**Decide during P4-C, not before:** whether a Report is an immutable stored
artifact under a fifth root or an exported file. P4-B has to exist first to show
what the model looks like in use.

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
