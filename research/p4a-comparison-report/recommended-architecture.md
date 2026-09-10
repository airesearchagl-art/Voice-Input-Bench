# Recommendation

**Unit A + Option C: a Run-centric derived comparison, with Reports that freeze
an explicit evidence selection and re-verify it on render.**

## The recommendation in one page

```text
GET /api/comparisons/run/:runId
        │
        ├── verifyRunEvidence(runId)              fail closed on the Run first
        ├── listResultsForRun(runId)              verified + rejected
        ├── listEvaluationsForRun(runId)          verified + rejected
        │
        ├── group   Results by tool, Evaluations by (result_id, evaluator)
        ├── select  headline = newest verified, reason recorded
        ├── flag    completeness per group and per Result
        └── order   by artifact id, everywhere

  → ComparisonRun (derived, never stored)

Report
        ├── freezes: run id, result ids, evaluation ids, evidence hashes,
        │            ordering rule ids, selection reasons
        ├── does not freeze: verification verdicts
        └── re-render re-reads those ids and re-verifies them now
```

## Decisions

### Comparison unit: Run

Adopted on evidence, not on the stated hypothesis. A Run pins the source text,
the WAV and their hashes, so Results under it are transcripts of identical
bytes; `listResultsForRun` and `listEvaluationsForRun` are already keyed by
`runId`; and the Session layer above already exists and deliberately reports
coverage rather than accuracy.

The Session comparison stays as it is. Linking a Session's cases to their Run
comparisons is a later question (P4-D) and only if a real need appears.

### Result policy: show every sealed Result, grouped by tool

- Every sealed Result under the Run appears. Older Results are never discarded —
  three Windows Results under one Run is a real state in the current tree.
- Grouping is by `tool.id`, in `STT_TOOL_IDS` order, with Results inside a group
  ordered by `result_id` ascending.
- **No Result is promoted to "current" or "latest".** Multiple Results for one
  tool usually mean repeated capture attempts, and which one is authoritative is
  an operator judgement the system has no basis to make. They are shown as
  siblings.
- Legacy unsealed v1 Results are listed with an explicit `not_eligible` state,
  not hidden and not counted as coverage.

### Evaluation history policy: keep all, select one, say which

For each `(result_id, evaluator_id)` group:

- every Evaluation is retained in `entries[]`, ordered by `evaluation_id` ascending;
- a `headline` is selected **only from verified entries**;
- the selection rule is *newest verified by `evaluation_id` descending*;
- `selection_reason` records the rule that fired;
- when more than one verified entry exists, the group is flagged
  `multiple_candidates` so the reader knows a choice was made.

Why newest-verified is defensible, with one important asymmetry:

- For **v1, v2 and v3** a verified Evaluation has been *recomputed from the same
  Run and Result bytes* during readback. Two verified entries in one group are
  therefore necessarily equivalent measurements — picking the newest is
  arbitrary but cannot change a number. Six such groups exist today.
- For **v4** this is not true. A Semantic Evaluation is historical execution
  evidence, and two verified Semantic Evaluations of the same Result can
  legitimately disagree, because they are two different model executions.

So the model carries a `conflicting_evidence` flag, raised when verified entries
within a group disagree on their reported decision or metrics.

**On conflict there is no headline at all.** `headline` is null and
`selection_reason` is `conflict-no-headline-v1`, and every conflicting id is
retained. Promoting the newest entry would publish one execution's verdict as
the answer while another verified execution said otherwise. A conflict is never
resolved by majority, by recency, or by preference for the friendlier answer.

### Rejected and missing: independent dimensions, never one enum

A single state enum loses whichever fact comes second, and these facts overlap.
A group can have two verified entries *and* a rejected sibling; a v4 group can
be conflicting *and* have rejected siblings. So state is recorded as separate
readings:

```text
availability          available | only_rejected | missing
verified_count        n
rejected_count        n
multiple_candidates   verified_count > 1
conflicting_evidence  verified entries disagree (v4 only)
```

- `missing` is not zero and not a pass.
- `only_rejected` is not `missing` — something was attempted and cannot be used,
  which is a stronger signal than nothing having been attempted. Four evaluator
  groups are in this state today.
- `available` says nothing about whether rejected siblings exist; that is what
  `rejected_count` is for. `7cdff2e8 / critical-info-v1` is available, has two
  verified candidates, and has one rejected sibling — all three at once.
- Rejected entries stay visible with their `reason`, `message` and `detail`.
  Nothing is filtered out of the view or the report.

### Attribution: a failed artifact is never filed on its own say-so

Production already draws this line. A rejected Result reaches a tool's cell only
when `integrityTrust === 'sealed'` **and** `trustedToolId` matches, because
without a seal `trustedToolId` is "a shape check rather than trustworthy
attribution" (`saveResult.ts:185-198`, `comparisonMatrix.ts:194-209`). One
broken Windows observation must not appear as a failure of Aqua Voice.

The comparison applies the same rule at both levels:

```text
rejected Result, tool not trusted        -> Run.unattributed_results[]
rejected Evaluation, evaluator unknown   -> Result.unclassified_rejected_evaluations[]
rejected Evaluation, no result_id        -> Run.unattributed_rejected_evaluations[]
```

The middle case is the normal one, not an exception: `EvaluationListEntry`'s
rejected variant carries no evaluator id at all, so a rejected Evaluation never
has a trustworthy evaluator to be filed under. This matches what the UI already
does for the same stated reason (`ManualSttResults.tsx:601-603`).

### Comparison persistence: derived only

Nothing about the comparison is stored. The decisive evidence is that
verification status is a property of the *current verifier*, not of the
artifact: five v2 artifacts and five v3 artifacts changed their rejection
outcome within a week of hardening work, with no artifact byte altered. A stored
comparison asserting `verified` would have aged into a false claim silently.

### Report persistence: freeze the whole candidate set, not the verdict

A Report package is a `ReportSource` JSON plus a rendered Markdown document.
**Where that package lives — an app-managed fifth storage root, or files the
operator exports — is deferred to P4-C**, which can decide it against a model in
use rather than a sketch.

What P4-A fixes is what the package freezes:

- `run_id`, the `result_id`s, and for every evaluator group **every**
  `evaluation_id` considered — not only the one used;
- which of those was the headline, which were rejected at report time, and the
  `selection_reason`;
- the evidence hashes relied on (`source_sha256`, `audio_sha256`,
  `transcript.sha256`, each verified Evaluation's `semantic_sha256`);
- unclassified and unattributed ids, so nothing that existed goes unrecorded;
- the ordering rule identifiers.

Freezing the whole candidate set is what stops an Evaluation created *after* the
report from joining the set on re-render and changing which entry is newest. An
empty `considered_evaluation_ids` is also how `missing` stays reconstructable
instead of being indistinguishable from "not mentioned".

It does not store "this Evaluation was verified" as a durable fact. Re-rendering
re-reads exactly those ids and re-verifies them now, so a report whose evidence
has stopped verifying says so rather than repeating itself.

### Deterministic ordering: by artifact id, everywhere

Because every id is `<YYYYMMDD>T<HHmmssSSS>Z-<8 hex>`, lexicographic order is
chronological order, and the id is available even for an artifact that does not
verify. Ordering therefore never depends on a stored `created_at`, which is only
meaningful once an artifact has verified, and never on filesystem order.

```text
Runs                run_id descending        (matches listVerifiableRuns)
Tools               STT_TOOL_IDS order       tools.ts:9
Results in a tool   result_id ascending      (matches listResultsForRun)
Evaluators          EVALUATOR_IDS order      raw → surface → critical → semantic
Evaluations         evaluation_id ascending  (matches listEvaluationsForRun)
Headline            newest verified = max evaluation_id among verified
Rejected entries    evaluation_id ascending
Report sections     the same evaluator order
```

The recommended evaluator display order — Raw, Surface, Critical, Semantic — is
**already** the declared order of `EVALUATOR_IDS`
(`createEvaluation.ts:184-190`). P4-B should consume that constant rather than
restate the order, so the two can never drift.

### No synthesis

Raw CER, Surface CER, Critical information and Semantic H3 remain four separate
readings. No combined score, no ranking, no winner, no weighted average, no
PASS/SAFE. `semantic-h3-v1` keeps `changed` and `review` exactly, and `review`
is rendered as an outstanding obligation, never as a pass.

The comparison may state factual, non-ranking relations — that two tools produced
identical normalized transcripts, or that one has a Critical mismatch and the
other does not — because those are observations rather than judgements. It must
not order tools by preference.

## Risks accepted

- **The headline is a choice.** Newest-verified is defensible for v1–v3 and
  arbitrary-but-flagged for v4. Mitigated by keeping full history, recording
  `selection_reason`, and flagging `multiple_candidates` and
  `conflicting_evidence`.
- **Derived comparison costs verification on every request.** For one Run that is
  the same work `/api/evaluations` already does. It would not scale to a
  Session-wide view without caching, which is one reason Session-level
  aggregation is deferred.
- **`review` cannot be validated against local data.** No `review` artifact
  exists. P4-B must cover it with a synthetic fixture.
