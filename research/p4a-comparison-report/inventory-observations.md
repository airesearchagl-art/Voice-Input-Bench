# Inventory observations — the local artifact tree

Read-only. No artifact was modified; the probe only reads and counts. Transcript
and benchmark sentence text is deliberately not reproduced here — identities,
counts and contracts are enough to test the architecture, and the source text is
not an approved repository fixture.

Measured on `main@8273d1aad2a981754710661f6a905b61e2eaf6d8`.

## Totals

```text
runs         18
results       9
evaluations  36

readback (via GET /api/evaluations, both Runs):
  verified   19
  rejected   17
  UNEXPECTED  0
```

Rejected breakdown by schema:

```text
v1   4   EVALUATION_EVALUATOR_MISMATCH
v2   5   EVALUATION_MALFORMED
v3   5   EVALUATION_MALFORMED
v4   3   EVALUATION_INTEGRITY_MISMATCH
```

## Results per Run

Only 2 of the 18 Runs carry Results.

```text
run 20260906T104832215Z-f5d8794e : 5 results
    windows-standard-voice-input  x3
    aqua-voice                    x2
    schema: v1 x2 (legacy), v2 x3

run 20260906T235924185Z-2d915a76 : 4 results
    windows-standard-voice-input  x2
    aqua-voice                    x2
    schema: v1 x2 (legacy), v2 x2
```

Both Runs hold **more than one Result for the same tool**, up to three. Any
design that assumes one Result per (Run, tool) is already wrong against this
tree.

Four Results are legacy v1 (unsealed) and carry **no Evaluations at all** —
they are ineligible for strict Evaluation, which is a different state from an
eligible Result whose evaluation has not been run yet.

## Evaluations per (Result, evaluator)

```text
result 4e66c178 (windows)  10 evaluations
    (pre-final v1 shape) x2   raw-char-v1 x3   critical-info-v1 x3
    surface x1   semantic x1
result bfe7ffd0 (aqua)     10 evaluations
    (pre-final v1 shape) x1   raw-char-v1 x2   critical-info-v1 x4
    surface x3    [semantic MISSING]
result bf897c7d (windows)   1 evaluation
    (pre-final v1 shape) x1   [all four evaluators MISSING]
result 7cdff2e8 (windows)   7 evaluations
    raw x1   critical x3   surface x1   semantic x2
result 1ff85dda (aqua)      8 evaluations
    raw x1   critical x4   surface x1   semantic x2
```

Ten (Result, evaluator) groups hold more than one Evaluation. That alone is
expected — repeats are allowed. The finding that matters is the next one.

## Groups with more than one *verified* Evaluation

```text
4e66c178 / critical-info-v1   -> 2 verified
4e66c178 / raw-char-v1        -> 3 verified
bfe7ffd0 / critical-info-v1   -> 3 verified
bfe7ffd0 / raw-char-v1        -> 2 verified
7cdff2e8 / critical-info-v1   -> 2 verified
1ff85dda / critical-info-v1   -> 2 verified

6 groups
```

A comparison that displays "the" Critical result for a Result is choosing one of
two or three verified candidates. Today that choice is made implicitly by render
order. The recommendation makes it explicit and records it.

## Groups holding evidence but no usable evidence

Four genuine evaluator groups have Evaluations on disk and nothing that verifies:

```text
4e66c178 / surface-normalized-char-v1   total=1  verified=0  rejected=1
4e66c178 / semantic-h3-v1               total=1  verified=0  rejected=1
7cdff2e8 / surface-normalized-char-v1   total=1  verified=0  rejected=1
1ff85dda / surface-normalized-char-v1   total=1  verified=0  rejected=1
```

This is the case the completeness model must not flatten: an evaluation was
attempted and exists on disk, and none of it can be used. That is neither
`missing` (nothing was attempted) nor `complete`.

A further three groups consist entirely of rejected pre-final v1 artifacts whose
evaluator record cannot be read (`4e66c178` ×2, `bfe7ffd0` ×1, `bf897c7d` ×1).
In the recommended model these are **not** evaluator groups at all — their
`evaluator_id` is unknown, so they are rejected entries attributed to the Result
rather than filed under any evaluator. They are counted separately for that
reason; see `edge-cases.md` case 8.

## Scenario coverage against the task's required list

| # | scenario | present locally |
|---|---|---|
| 1 | Windows + Aqua under one Run | yes — both Runs |
| 2 | Raw / Critical / Surface / Semantic all available | yes — 3 Results carry all four as artifacts (verification differs; see below) |
| 3 | missing evaluator | yes — `bfe7ffd0` missing semantic; `bf897c7d` missing all four |
| 4 | historical rejected Evaluation | yes — 17 rejected across all four schemas |
| 5 | multiple Evaluations per (Result, evaluator) | yes — 10 groups, and 6 with multiple *verified* |
| 6 | Semantic `review` | **no** — see below |
| 7 | Critical mismatch + Semantic CHANGED | yes — 2 × `critical-guard-veto-v1` |
| 8 | multiple Results from one tool | yes — windows ×3 under one Run |

### Scenario 6 is not represented and must not be faked

All five semantic Evaluations on disk decided `changed`:

```text
changed / critical-guard-veto-v1            2
changed / full-run-unanimous-changed-v1     3
```

There is no `review` artifact locally. So the `review` rendering path — the one
that must never be shown as a pass — cannot be validated against this tree. It
has to be covered by a synthetic fixture in P4-B's tests, and P4-B should treat
"`review` renders correctly" as a test obligation rather than something the
local data demonstrates.

## Two shape observations worth carrying into P4-B

**Pre-final v1 Evaluations exist.** Four artifacts carry `algorithm:
"raw-char-v1"` where current v1 carries `evaluator: {id, unit, normalization}`.
They do have `run_id`, so they are listed under their Run, and they are rejected
with `EVALUATION_EVALUATOR_MISMATCH`. A comparison must be able to show a
rejected entry whose evaluator is unknown — which is exactly why the current UI
does not file rejected entries under an evaluator section.

**Results have `captured_at`, not `created_at`.** Evaluations have `created_at`.
Neither is needed for ordering: both artifact kinds have a timestamp-prefixed id
that sorts identically and is available even when the artifact does not verify.
