# Architecture options

Three complete options. Each is described as it would actually be built, with
the failure and audit behaviour that follows from it. The recommendation is in
`recommended-architecture.md`.

Two questions are separable and are answered separately:

1. **Comparison unit** — Run-centric, Session-centric, or a new entity.
2. **Persistence** — derived, persisted snapshot, or derived + frozen report.

## Part 1 — comparison unit

### Unit A: Run-centric

One Run is the comparison boundary. The view answers: *for this canonical source
and this exact WAV, what did each tool produce, and what did each evaluator say?*

- A Run pins `source.sha256`, `audio.sha256`, `test_id` and the TTS conditions
  (`manifest.ts:15-97`). Two Results under it are transcripts of the same bytes.
- `listResultsForRun` and `listEvaluationsForRun` already exist and are already
  keyed by `runId`. The read model is the shape production already returns.
- Matches the existing UI, which already loads both lists for one Run in
  parallel precisely so they cannot describe different Runs
  (`ManualSttResults.tsx:788-796`).

Cost: low. Almost entirely assembly of existing calls.

### Unit B: Session-centric

The comparison spans a Session — several Runs, one per Benchmark Case — and
reports per-Case, per-tool evaluation results.

- A Session already exists and already produces a Case × tool matrix
  (`buildSessionComparison`), but it is wired without `evaluationStore`
  (`sessions/[sessionId]/route.ts:23-28`), so it can only report coverage.
- Extending it to evaluations means N Runs × M Results × K Evaluations per
  request, all re-verified. On this tree that is already 36 evaluation
  verifications for two Runs; a ten-Case Session would multiply it.
- It also forces an aggregation question immediately — what does "the Critical
  result for this Case" mean across tools? — which is precisely the question this
  phase is supposed to avoid answering with a score.

Cost: medium-high, and it front-loads the aggregation problem.

### Unit C: a new persisted Comparison entity

A `Comparison` artifact naming a Run, a set of Results and a set of Evaluations.

- Buys nothing at read time that Unit A does not already have, and adds a fifth
  storage root, a fifth schema, a fifth verifier and a fifth readback path.
- Its only real advantage is citability, and that advantage belongs to the
  Report rather than to the screen.

Cost: high.

**On the stated hypothesis.** The task proposed Run-centric and asked that it not
be adopted without checking. It checks out: the Run is the only boundary that
pins identical input bytes, and the Session layer that sits above it already
exists and deliberately reports coverage rather than accuracy. Run-centric is
adopted on that evidence, not on the hypothesis.

## Part 2 — persistence

### Option A — always-derived comparison

`GET /api/comparisons/run/:runId` builds the whole model per request from
`listResultsForRun` + `listEvaluationsForRun`. Nothing is stored.

```text
request → verify Run → verify Results → verify Evaluations → group → order → respond
```

- **Reproducibility**: the view always reflects current verification truth.
- **Stale data**: impossible by construction.
- **Auditability**: good for "what is true now", none for "what did the report
  say in September". Nothing is citable.
- **Correction behaviour**: a hardened verifier changes the view immediately —
  which is correct, and which actually happened twice this month.
- **Storage cost**: zero. **UI cost**: low. **Report cost**: a report generated
  from it is a snapshot of a moving view, with no way to re-render the same one.

### Option B — persisted Comparison Snapshot artifact

A new immutable artifact under a fifth root, holding the resolved comparison
including each Evaluation's verification status at write time.

- **Reproducibility**: byte-stable, and that is the problem. It records
  `verified` as a fact, when `verified` is a *judgement made by the current
  verifier*. Five v2 artifacts changed rejection reason in P3-E-A and five v3
  artifacts in P3-E-B, with no artifact byte modified. A snapshot written before
  those changes would still be asserting a verification outcome the code no
  longer reaches.
- **Stale data**: guaranteed over time, and silently.
- **Auditability**: high for the snapshot itself, misleading about the evidence.
- **Correction behaviour**: worst of the three. Correcting a verifier does not
  correct the snapshot, and nothing marks the snapshot as outdated.
- **Storage cost**: a fifth schema, verifier, readback path, isolation rule and
  set of tamper tests. **UI cost**: medium — the screen must explain that what it
  shows may not be current.

### Option C — derived view + frozen Report evidence selection

The screen is derived exactly as in Option A. A Report additionally freezes an
explicit **evidence selection**: the exact Run id, Result ids and — for every
evaluator group — every Evaluation id *considered*, plus the byte SHA-256 of
every artifact file read and the ordering rules. Not the verification verdicts.

```text
UI          derived per request, always current
Report      pins identities + hashes of the whole candidate set
Re-render   re-reads exactly those ids and re-verifies them now
```

Freezing the whole candidate set rather than only the headline is what keeps an
old report isolated from evidence created after it: a later Evaluation is not in
the frozen set, so it cannot join the re-render or become the new newest.

Freezing each artifact's byte hash alongside its id is what lets a re-render say
*which* kind of change happened — the artifact moved under a stable id, or the
same bytes are now judged differently by a hardened verifier.

The package is a `ReportSource` JSON plus rendered Markdown. Whether it is
app-managed or operator-exported is a P4-C decision and does not affect the
contract.

- **Reproducibility**: a report can always be re-rendered from its own selection.
  If the underlying evidence no longer verifies, the re-render says so instead of
  repeating a stale verdict.
- **Stale data**: impossible to hide. The selection is frozen; the verdict is not.
- **Auditability**: highest. Every number in a report traces to a named
  Evaluation id, and the selection records *why* that Evaluation was the one used.
- **Correction behaviour**: the right one. Hardening a verifier changes what a
  re-rendered report says about evidence, and that change is visible.
- **Storage cost**: low — the package is a selection plus rendered text, and
  whether the app manages it is deferred to P4-C. **UI cost**: low, the same
  derived view as Option A.

## Cost summary

| | Option A | Option B | Option C |
|---|---|---|---|
| new storage schema | none | one full artifact + verifier | report only, selection-shaped |
| view always current | yes | no | yes |
| report citable | no | yes | yes |
| stale verdict risk | none | high, silent | none |
| survives verifier hardening | yes | no | yes |
| implementation cost | low | high | low–medium |

## What none of these options include

No ranking, no winner, no quality score, no weighted average and no PASS/SAFE
synthesis. Raw, Surface, Critical and Semantic stay four separate readings in
every option, and `semantic-h3-v1` keeps exactly `changed` and `review`.
