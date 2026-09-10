# Edge cases the model must be able to express

Each case says what the state is, what the model must show, and — where it
applies — which artifacts in the local tree already exercise it. Cases marked
**not represented locally** must be covered by synthetic fixtures in P4-B.

## 1. Multiple Results from one tool under one Run

*Present: `windows-standard-voice-input` ×3 under Run `f5d8794e`.*

All are shown, ordered by `result_id` ascending, inside that tool's group. None
is promoted. Repeated capture attempts are an operator matter; the system has no
basis for deciding which attempt was the real one.

## 2. Multiple Evaluations for one (Result, evaluator)

*Present: 10 groups.*

All entries retained, ordered by `evaluation_id` ascending. Headline chosen from
verified entries only.

## 3. Multiple **verified** Evaluations in one group

*Present: 6 groups, one with 3.*

`multiple_candidates: true`, `availability: 'available'`. Headline is the newest
verified; `selection_reason` records `newest-verified-by-id-v1`; the other
verified entries stay visible.

`multiple_candidates` and `conflicting_evidence` remain independent readings and
can both be true, which is why group state is dimensions rather than one enum.
The rejected-sibling overlap the previous revision recorded here was an artifact
of grouping by an untrusted field; those rejected entries now sit on the Result.

For v1/v2/v3 these entries are necessarily equivalent — readback recomputes those
metrics from the same Run and Result bytes, so a verified entry cannot disagree
with another verified entry about them. The flag exists so the reader knows a
selection happened, not because the numbers are in doubt.

## 4. Conflicting verified Evaluations

*Not represented locally.*

`conflicting_evidence: true`. Only reachable for `semantic-h3-v1`, whose
Evaluations are historical model executions rather than recomputations: two
verified v4 artifacts for one Result can legitimately disagree.

**There is no headline.** `headline` is null and `selection_reason` is
`conflict-no-headline-v1`; every conflicting id is retained and shown. No
majority vote across Evaluations, no recency preference presented as truth, and
no preference for whichever answer is friendlier. A conflict between `changed`
and `review` is surfaced as a conflict, and the Report carries every conflicting
Evaluation id rather than one verdict.

## 5. Evidence exists, none of it verifies

*Present: four Results carry an Evaluation that does not verify and have no
verified Evaluation of the evaluator that artifact claims to be.*

This case had to be **restated** in R2. The earlier draft called it a group
state, `only_rejected` — but computing it meant reading the `evaluator` claim
inside a failed artifact, which is precisely what the trust rule forbids.

The honest split:

```text
evaluator group      availability: 'missing'      no verified evidence
Result               unclassified_rejected_count  n unusable Evaluations
```

The "attempted and unusable" signal survives, at the level where it can be
stated without a guess. It must never render as a clean blank: a Result with
unclassified rejected Evaluations is visibly different from one with none.

## 6. Missing evaluator

*Present: `bfe7ffd0` has no `semantic-h3-v1`; `bf897c7d` has none of the four.*

`availability: 'missing'`, with the group still present in the model and its
`considered_evaluation_ids` empty in any Report built from it. `missing` is not
zero, not `exact_match: false`, and not a pass.

## 7. Legacy unsealed Result

*Present: 4 Results at `schema_version: 1`, all with zero Evaluations.*

A `ComparisonLegacyResult`, held at Run level in `legacy_unsealed_results[]` and
**never inside a tool group**: nothing proves its `tool` section was not edited
after the fact, so its tool fields are named `claimed_*` and carry
`tool_claim_is_unverified: true`.

Ineligibility is structural rather than a flag — it is a different type, not a
Result with a state on it. Listed, never counted as coverage, never migrated.
Distinct from `missing`: nothing is expected of it, because strict Evaluation
requires a sealed Result v2.

## 8. Rejected Evaluation with an unreadable evaluator record

*Present: 4 pre-final v1 artifacts carrying `algorithm` instead of `evaluator`,
rejected as `EVALUATION_EVALUATOR_MISMATCH`.*

`evaluator_id: null`, and it goes to that Result's
`unclassified_rejected_evaluations[]` — **not** into any evaluator group.

This is not the exotic case, it is *every* case: `EvaluationListEntry`'s
rejected variant carries no evaluator id at all, so no rejected Evaluation ever
has a trustworthy evaluator, whatever its file happens to say. The stored
`evaluator` claim is not promoted to an attribution after the artifact failed.
The current UI keeps rejected entries in a separate block for the same reason
(`ManualSttResults.tsx:601-603`).

Consequently evaluator groups hold verified entries only, and the four pre-final
v1 artifacts are simply four unclassified rejected Evaluations on their Results
rather than a `(pre-final-v1-shape)` pseudo-group.

## 9. Rejected Evaluation with no attributable Result

*Shape supported by production: `EvaluationListEntry` rejected variant has
`resultId?` optional.*

Surfaced at Run level in `unattributed_rejected_evaluations[]`. Never dropped,
and never guessed into a Result.

## 10. Rejected Result

*Production supports it: `/api/results` returns rejected entries with an
optional `trustedToolId`.*

A rejected Result is listed under a tool **only** when `integrityTrust ===
'sealed'` and `trustedToolId` is present — the rule the Session matrix already
applies (`comparisonMatrix.ts:194-209`), because without a seal `trustedToolId`
is a shape check rather than trustworthy attribution
(`saveResult.ts:185-198`). Otherwise it goes to
`ComparisonRun.unattributed_results[]` with a `reason_class` of `no-seal` or
`tool-identity-unverified`.

Either way it keeps its rejection reason and has no transcript, and Evaluations
naming it are still shown: they are evidence about what happened even though the
Result itself no longer verifies.

## 11. Semantic `review`

*Not represented locally — all 5 semantic artifacts decided `changed`.*

Renders as **REVIEW REQUIRED**. Never as a pass, never as `preserved`, never as a
neutral or empty cell. This is the single most important rendering path that
local data cannot validate, so P4-B must cover it with a fixture, including the
`full-run-unanimous-preserved-requires-review-v1` source, where the model agreed
three times that meaning was preserved and H3 still routes to review.

## 12. Critical veto with zero model runs

*Present: 2 artifacts with `critical-guard-veto-v1`.*

`decision: changed`, `execution.status: skipped_by_critical_veto`,
`runs_recorded: 0`. The route must be stated, or a reader sees CHANGED beside
"0 runs" and reads it as missing data. The p12 self-correction Known Limitation
note accompanies it.

## 13. Run with no Results

*Present: 16 of 18 Runs.*

A valid, empty comparison. The Run is shown with zero tool groups and a
completeness state that says so, rather than an error.

## 14. Run itself fails verification

*Production behaviour: `listEvaluationsForRun` calls `verifyRunEvidence` first
and fails closed.*

The comparison request fails as a whole. Reporting evaluation numbers about a Run
whose own artifacts no longer match its manifest would be worse than reporting
nothing.

## 15. Same tool, same Result, different evaluator schemas over time

*Present: `4e66c178` carries both pre-final v1 artifacts and current v1 artifacts.*

Grouping is by `evaluator_id`, not by `schema_version`. An artifact whose
evaluator cannot be read falls into case 8.

## 16. Verification status changes between two renders

*Happened twice this month: 5 v2 artifacts in P3-E-A, 5 v3 artifacts in P3-E-B —
no artifact byte changed.*

The derived view simply shows the new truth. A Report re-render shows it too, and
says which cited evidence no longer verifies. This case is the reason the
recommendation refuses to persist verification verdicts.
