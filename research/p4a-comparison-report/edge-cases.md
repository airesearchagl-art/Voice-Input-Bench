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

State `multiple_candidates`. Headline is the newest verified; `selection_reason`
records `newest-verified-by-id-v1`; the other verified entries stay visible.

For v1/v2/v3 these entries are necessarily equivalent — readback recomputes those
metrics from the same Run and Result bytes, so a verified entry cannot disagree
with another verified entry about them. The flag exists so the reader knows a
selection happened, not because the numbers are in doubt.

## 4. Conflicting verified Evaluations

*Not represented locally.*

State `conflicting_evidence`. Only reachable for `semantic-h3-v1`, whose
Evaluations are historical model executions rather than recomputations: two
verified v4 artifacts for one Result can legitimately disagree.

The conflict is shown, not resolved. No majority vote across Evaluations, no
recency preference presented as truth, and above all no preference for whichever
answer is friendlier. A conflict between `changed` and `review` is surfaced as a
conflict.

## 5. Evidence exists, none of it verifies

*Present: four groups — `4e66c178 / surface`, `4e66c178 / semantic-h3-v1`,
`7cdff2e8 / surface` and `1ff85dda / surface` — each 1 rejected, 0 verified.*

State `has_rejected_evidence`, headline `null`. This must never render as
`missing` and never as a blank cell that reads like "not applicable". Something
was attempted and cannot be used, which is a stronger signal than nothing having
been attempted.

## 6. Missing evaluator

*Present: `bfe7ffd0` has no `semantic-h3-v1`; `bf897c7d` has none of the four.*

State `missing`, with the group still present in the model. `missing` is not
zero, not `exact_match: false`, and not a pass.

## 7. Legacy unsealed Result

*Present: 4 Results at `schema_version: 1`, all with zero Evaluations.*

`integrity_trust: 'legacy-unsealed'`, completeness `not_eligible`. Listed, never
counted as coverage, never migrated. Distinct from `missing`: nothing is
expected of it, because strict Evaluation requires a sealed Result v2.

## 8. Rejected Evaluation with an unreadable evaluator record

*Present: 4 pre-final v1 artifacts carrying `algorithm` instead of `evaluator`,
rejected as `EVALUATION_EVALUATOR_MISMATCH`.*

`evaluator_id: null`. Attributed to its Result but **not** filed under any
evaluator group — filing it would be a guess about which evaluator it belonged
to, which is exactly why the current UI keeps rejected entries in a separate
block (`ManualSttResults.tsx:601-603`).

## 9. Rejected Evaluation with no attributable Result

*Shape supported by production: `EvaluationListEntry` rejected variant has
`resultId?` optional.*

Surfaced at Run level in `unattributed_rejected`. Never dropped.

## 10. Rejected Result

*Production supports it: `/api/results` returns rejected entries.*

The Result is still listed, with its rejection reason and no transcript. Its
Evaluation groups are not silently emptied — Evaluations naming that Result are
still shown, because they are evidence about what happened even though the
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
