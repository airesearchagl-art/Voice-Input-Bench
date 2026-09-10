# P4-A — Comparison / Report Architecture Spike

Research only. Nothing in this directory is imported by `src/`, and this spike
changes no production file and no stored artifact.

Task: `VIB-P4-A-001`
Base: `main@8273d1aad2a981754710661f6a905b61e2eaf6d8`

## The question

Phase 3 finished the evidence layer. A canonical Run pins a source text and a
WAV; a sealed Result v2 pins one tool's transcript of that WAV; four Evaluation
schemas measure that transcript in four different ways, and readback either
re-derives an Evaluation or refuses it.

What is missing is the step that puts those artifacts beside each other:

```text
Run  →  Results (per tool)  →  Evaluations (per evaluator)  →  Comparison  →  Report
```

This spike decides how that step should be built. It does not build it.

## Documents

| file | what it settles |
|---|---|
| `production-audit.md` | what the current code actually guarantees, with citations |
| `inventory-observations.md` | what the local artifact tree actually contains |
| `architecture-options.md` | three complete options, with costs |
| `recommended-architecture.md` | the recommendation and why |
| `comparison-contract.md` | candidate read-model types |
| `report-contract.md` | report content, identity and reproducibility |
| `edge-cases.md` | the states the model must be able to express |
| `phase-plan.md` | proposed P4-B / P4-C / P4-D split |
| `inventory-observations.json` | machine-readable counts behind the above |

## The four findings that drove the recommendation

Each of these was measured against current `main` and the local artifact tree,
not assumed.

**1. A Session-level comparison already exists, and it is evaluation-blind.**
`buildSessionComparison` is wired with `runStore`, `resultStore` and
`sessionStore` and no `evaluationStore`
(`src/app/api/sessions/[sessionId]/route.ts:23-28`). The existing matrix reports
Case × tool *coverage* — which cases have been observed with which tool — and
deliberately no score. So Phase 4 is not greenfield: the missing layer is
evaluation-aware comparison *within one Run*, not another coverage view.

**2. Artifact IDs already give a deterministic total order.**
Every id is `<YYYYMMDD>T<HHmmssSSS>Z-<8 hex>` (`src/lib/timestampId.ts:12`),
fixed-width and UTC, so lexicographic order *is* chronological order. The stores
already sort by id rather than trusting `readdir`
(`LocalResultStore.ts:171-175`, `LocalEvaluationStore.ts:142-146`,
`createEvaluation.ts:796`). Ordering therefore needs no new mechanism and no
stored timestamp — which matters, because `created_at` is only trustworthy once
an artifact has verified, while its id is the directory name either way.

**3. Multiple *verified* Evaluations for one (Result, evaluator) is the normal
case, not a corner case.** Six such groups exist locally right now, one of them
with three. Nothing prevents it: each create path mints a new id and writes
(`createEvaluation.ts:246`), with no lookup for an existing evaluation of the
same evaluator. Any comparison that shows "the" Critical result for a Result is
already making a silent choice today. This spike makes that choice explicit.

**4. Verification status is a moving target, so it must not be frozen.**
Five v2 artifacts moved from `UNEXPECTED` to `EVALUATION_MALFORMED` in P3-E-A,
and five v3 artifacts moved from `EVALUATION_INTEGRITY_MISMATCH` to
`EVALUATION_MALFORMED` in P3-E-B — within one week, with no artifact byte
changed. A stored comparison snapshot claiming `verified` would have been wrong
by the following Tuesday. This is the single strongest argument against
persisting a comparison, and for a Report that pins *identities* and re-verifies
them on render.

## What this spike explicitly does not propose

- no ranking, winner, quality score, weighted average or PASS/SAFE synthesis
- no collapsing of Raw / Surface / Critical / Semantic into one number
- no change to `semantic-h3-v1`: `changed` and `review` keep exactly their
  current meanings, and `review` never becomes a pass
- no new storage schema in P4-B
- no STT automation

## Gate

STOP — Independent Architecture Review + Human Adoption required before P4-B.
