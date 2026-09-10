# Inventory observations — the local artifact tree

Read-only. No artifact was modified; the probe only reads and counts. Transcript
and benchmark sentence text is deliberately not reproduced here — identities,
counts and contracts are enough to test the architecture, and the source text is
not an approved repository fixture.

Measured on `main@8273d1aad2a981754710661f6a905b61e2eaf6d8`.

**Counted under the trust rule.** Evaluator groups below are built from
*verified* Evaluations only. A rejected Evaluation carries no trustworthy
evaluator id in the shape production returns, so it is counted against its
Result rather than against an evaluator. The earlier revision of this document
grouped rejected artifacts by the `evaluator` field inside the failed file, and
several counts below changed when that stopped.

## Totals

```text
runs                     18
results                   9   (5 sealed v2, 4 legacy unsealed v1)
evaluations              36

readback (via GET /api/evaluations, both Runs):
  verified               19
  rejected               17
  UNEXPECTED              0
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

Every Result on disk is a built-in tool. **No `other` (custom-named) Result
exists**, so the custom-tool identity rules — two custom tools never sharing a
column, a rejected `other` never guessed into one — are a contract requirement
and a P4-B fixture obligation, not something this tree demonstrates.

## Evaluator groups (verified only)

```text
11 groups hold at least one verified Evaluation
 6 of them hold more than one
```

```text
4e66c178 / raw-char-v1        3 verified
4e66c178 / critical-info-v1   2 verified
bfe7ffd0 / raw-char-v1        2 verified
bfe7ffd0 / critical-info-v1   3 verified
7cdff2e8 / critical-info-v1   2 verified
1ff85dda / critical-info-v1   2 verified
```

A comparison that displays "the" Critical result for a Result is choosing one of
two or three verified candidates. Today that choice is made implicitly by render
order. The recommendation makes it explicit and records it.

**This finding survived the trust correction.** It is computed from verified
Evaluations only, which do carry a trustworthy evaluator id, so tightening the
rule did not change it.

## Rejected Evaluations, counted where they can honestly be counted

All 17 rejected Evaluations name a Result that exists on disk, so none is
Run-level unattributed in this tree.

```text
result 4e66c178   5 unclassified rejected
result bfe7ffd0   4
result 1ff85dda   4
result 7cdff2e8   3
result bf897c7d   1
                 17
```

`unclassified` is the accurate word: each artifact names an evaluator inside
itself, none of those claims survived verification, and none is used to place
it. What the model can say is *"this Result has N Evaluations that cannot be
used"* — not *"surface-normalized-char-v1 failed here"*.

**What changed from the previous revision.** It reported "four groups with only
rejected evidence" and "four groups that are both multiple-candidate and
partially rejected". Both were produced by grouping failed artifacts on their
own `evaluator` claim. Under the trust rule neither statement is available, and
the same evidence is now reported as five Results carrying unusable Evaluations.

## Legacy unsealed Results

```text
4 Results at schema_version 1
```

No `integrity` section at all, so nothing proves the `tool` section was not
edited after the fact. They carry no Evaluations. They belong at Run level with
`tool_claim_is_unverified: true`, and never inside a tool group.

## Scenario coverage against the task's required list

| # | scenario | present locally |
|---|---|---|
| 1 | Windows + Aqua under one Run | yes — both Runs |
| 2 | Raw / Critical / Surface / Semantic all available | partly — 3 Results carry all four as artifacts, but verified coverage is thinner |
| 3 | missing evaluator | yes — several Results have no verified evidence for one or more evaluators |
| 4 | historical rejected Evaluation | yes — 17 across all four schemas |
| 5 | multiple Evaluations per (Result, evaluator) | yes — 6 groups with multiple *verified* |
| 6 | Semantic `review` | **no** — see below |
| 7 | Critical mismatch + Semantic CHANGED | yes — 2 × `critical-guard-veto-v1` |
| 8 | multiple Results from one tool | yes — windows ×3 under one Run |
| — | custom `other` tool | **no** — fixture obligation |

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
They have a `run_id`, so they are listed under their Run, and they are rejected
with `EVALUATION_EVALUATOR_MISMATCH`. Under the trust rule they are simply four
of the seventeen unclassified rejected Evaluations — not a
`(pre-final-v1-shape)` pseudo-group, which is how the previous revision
reported them.

**Results have `captured_at`, not `created_at`.** Evaluations have `created_at`.
Neither is needed for ordering: both artifact kinds have a timestamp-prefixed id
that sorts identically and is available even when the artifact does not verify.

## Machine-readable output

`inventory-observations.json` carries the same numbers plus, for RF-3, the byte
SHA-256 of all 9 `result.json` and all 36 `evaluation.json` files — the content
identity a Report would freeze so that a re-render can tell an edited artifact
from a hardened verifier.
