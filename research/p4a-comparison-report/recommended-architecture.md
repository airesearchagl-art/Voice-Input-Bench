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
- Legacy unsealed v1 Results are their own types at Run level — **verified** and
  **rejected** are separate, because production produces both and they are not
  the same state. Shown with their tool as an unverified claim (and with no tool
  claim at all when the Result itself did not read back), never inside a tool
  group, never counted as coverage. Four exist today, all verified.
- Tool identity is `id` for the two built-ins and `(id, trusted_name)` for
  `other`, so two unrelated custom tools never share a column; `tool.version`
  stays per verified Result.
- A tool-grouped **rejected** Result is built-in only, enforced by the type: a
  rejected `other` has no trusted name, and `other` without a name is not an
  identity. It goes to `unattributed_results`.

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
availability          available | missing        (verified entries only)
verified_count        n
multiple_candidates   verified_count > 1
conflicting_evidence  verified entries disagree (v4 only)
```

At Result level, alongside those:

```text
unclassified_rejected_count   Evaluations naming this Result that cannot be
                              used and cannot be attributed to an evaluator
```

- `missing` is not zero and not a pass. It means no *verified* evidence exists
  for that evaluator.
- `multiple_candidates` and `conflicting_evidence` are different claims and can
  both be true: one says a selection happened among candidates, the other says
  the candidates disagree.
- Rejected entries stay visible at Result or Run level with their `reason`,
  `message` and `detail`. Nothing is filtered out of the view or the report.
- `rejected_count` and `only_rejected` are deliberately **not** group-level
  facts. The earlier draft had them, and it could only compute them by reading
  the untrusted `evaluator` claim inside a failed artifact.

### Attribution: a failed artifact is never filed on its own say-so

Production already draws this line. A rejected Result reaches a tool's cell only
when `integrityTrust === 'sealed'` **and** `trustedToolId` matches, because
without a seal `trustedToolId` is "a shape check rather than trustworthy
attribution" (`saveResult.ts:185-198`, `comparisonMatrix.ts:194-209`). One
broken Windows observation must not appear as a failure of Aqua Voice.

The comparison applies the same rule everywhere, without exception:

```text
evaluator groups                         verified Evaluations only
rejected Evaluation, result_id known     -> Result.unclassified_rejected_evaluations[]
rejected Evaluation, no result_id        -> Run.unattributed_rejected_evaluations[]
rejected Result, tool not trusted        -> Run.unattributed_results[]
legacy unsealed Result                   -> Run.legacy_unsealed_results[]
```

**Evaluator groups contain verified entries only.** A rejected
`EvaluationListEntry` has no evaluator id at all, so there is never a
trustworthy evaluator to file one under — the stored `evaluator` claim inside a
failed artifact is not promoted to an attribution.

The cost is stated rather than hidden: a group can no longer report
"attempted and unusable" for its own evaluator. That signal moves to the Result,
where it can be made without a guess. Recovering it per evaluator would need a
fail-closed `trustedEvaluatorId` in production — a documented P4-B scope change,
never an implicit one. See `comparison-contract.md`.

A legacy unsealed Result is never trusted tool evidence: nothing proves its
`tool` section was not edited after the fact, so it sits at Run level with its
tool shown as a claim.

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
- which of those was the headline and the `selection_reason`;
- the Run's evidence identity — `manifest_file_sha256` alongside
  `source_sha256` and `audio_sha256`, because `verifyRunEvidence` re-hashes
  source, audio and provider-query *against the SHAs the manifest records* and
  never hashes the manifest itself (`runEvidence.ts:206-215`), so an edited
  manifest can move a recorded hash and the file beside it together;
- `transcript.sha256` and each verified Evaluation's `semantic_sha256`;
- **the byte SHA-256 of every artifact file read**, including legacy, rejected
  and unattributed ones, so an artifact with no valid seal still has a frozen
  content identity;
- unclassified, unattributed and legacy ids, so nothing that existed goes
  unrecorded;
- the ordering rule identifiers.

The byte hash is what lets a re-render separate *"the artifact changed under a
stable id"* from *"a verifier was hardened and now rejects the same bytes"*.
Those are different findings and an operator acts differently on each; a report
that reported both as "no longer verifies" would be misleading about which one
happened.

The transcript gets the same treatment for the same reason. It lives in its own
file, so `result.json` can hash identically while `transcript.txt` beside it has
changed — the Result seal covers `transcript.sha256`, not the transcript bytes
(`resultSchema.ts:79-82`). A re-render hashes the transcript before it verifies
anything, so an edited transcript is reported as `evidence_changed` rather than
as a verifier outcome.

`ReportSource` is discriminated the same way the view is, so a field that cannot
be trusted for a rejected Result is **absent** rather than `null`. Using `null`
for both "no version was supplied" and "no version can be trusted" would leave a
reader unable to tell which they are looking at.

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
Tools               STT_TOOL_IDS order, then trusted_name for custom tools
Results in a tool   result_id ascending      (matches listResultsForRun)
Evaluators          EVALUATOR_IDS order      raw → surface → critical → semantic
Evaluations         evaluation_id ascending  (matches listEvaluationsForRun)
Headline            newest verified = max evaluation_id among verified
Rejected entries    evaluation_id ascending
Report sections     the same evaluator order
```

`other` is a bucket, not a tool: its real identity is the operator-supplied
name, so custom groups key on `(id, trusted_name)` and two unrelated custom
tools never share a column. `tool.version` stays per Result — hoisting it to a
group would assert a version some of those Results never claimed.

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
