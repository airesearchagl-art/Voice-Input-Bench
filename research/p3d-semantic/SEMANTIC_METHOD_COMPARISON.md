# Semantic Method Comparison — P3-D-A (R1.1)

**This is a research spike. Nothing here is production code, and nothing here
picks a production threshold.**

> **Every accuracy figure below is provisional accuracy against proposed labels.**
> The labels in `probes-v1.json` were proposed by the research agent that built
> this spike; no person has confirmed them. See
> [`HUMAN_GOLD_REVIEW.md`](./HUMAN_GOLD_REVIEW.md), where all 28 rows are
> `pending`. Read every number as "against these proposals", not "against ground
> truth".

| | |
| --- | --- |
| Corpus | `probes-v1.json`, digest `5a14302d80732959b5ae249de1daaf731f8e9596fd86042d526b7fafc4475b0a` |
| Probes | 28 (13 proposed `preserved`, 15 proposed `changed`, 13 hard negatives) |
| Embedding | `text-embedding-nomic-embed-text-v1.5`, LM Studio, `http://127.0.0.1:1234` |
| LLM | `llama3.1:8b` Q4_K_M, digest `46e0c10c039e…`, Ollama 0.33.3, `http://127.0.0.1:11434` |
| Rubric | `semantic-rubric-v1.md`, digest `9677764f367cfbf44048ec60ac76f111e0c2487356598405cca91b27790f3558` |
| Parameters | temperature 0, `num_predict` 600, top_p unset, **seed uncontrolled**, 3 runs per pair |
| Input variants | raw and surface-normalized, measured separately |
| Downloads performed | **0** |

## The metric that ranks these methods

**False preserved**, not accuracy.

A *false preserved* is a transcript that changed the meaning and was reported as
fine — someone reads 「梁貫通で逃がす」 believing it says 「逃がさない」 and builds
it. A *false changed* costs a person a minute of checking. Averaging them into an
accuracy figure hides the only failure that can reach a building.

Two further measures are kept apart throughout, because collapsing them flatters
every tri-state:

- **auto-changed recall** — the method decided by itself that a hard negative had
  changed. `review` does **not** count.
- **non-preserved routing** — the method did not tell anyone it was fine.
  `review` counts here and only here. **Sending something to a human is not
  detection.**

Both are divided by **all 13 hard negatives in the corpus**, always. R1 divided
auto-changed recall by the hard negatives a rule happened to answer, so every pair
a tri-state sent to a human left the denominator instead of counting against it —
and a rule that reviewed twelve of thirteen and caught one scored 100%. R1.1
corrects that, and the rules that review most are the ones whose numbers moved
furthest. A test asserts the denominator is 13 for every variant published here.

**Automated decisions rest on `full_run_unanimous`, not on agreement among the
replies that happened to parse.** R1 recorded one `unanimous` flag computed over
the valid runs, so two agreeing runs and one unparseable reply counted as three
agreeing runs. Both levels are now reported separately and only the strict one
routes anything automatically.

## What changed since the first round, and what it cost

The first round's rubric spelled out two corpus pairs as worked examples —
`2700mm` ↔ `二千七百ミリ` and `water closet` ↔ `ウォータークローゼット`. Those are
holdout pairs, and the rubric was answering them before the model was asked.

They are gone, a test now asserts the static template contains no probe text, and
the effect is measurable:

| pair | R0 (leaked prompt) | R1 raw | R1 surface |
| --- | --- | --- | --- |
| p04 `2700mm` ↔ `二千七百ミリ` | preserved ✓ | **changed ✗** | **changed ✗** |
| p05 `water closet` ↔ transliteration | preserved ✓ | preserved ✓ | preserved ✓ |

p04 flipped. The first round's 75.0% included one pair the prompt had answered in
advance, and the honest raw figure is **71.4%**. This is the clearest single
result of R1: a few-shot example drawn from the evaluation set does not measure a
method, it measures the example.

### What R1.1 changed, and what it cost

Two measurement faults, no re-run of any model. Every number below is re-derived
from the runs R1 already recorded; the prompt, the corpus and their digests are
unchanged, and no request was replayed.

**1. The hard-negative denominator.** Recall was computed over the rows a rule
answered. Correcting it to the whole corpus moved every rule that reviews:

| rule (raw, t=0.90) | R1 auto-changed recall | R1.1 auto-changed recall |
| --- | --- | --- |
| H0 | 88.9% | **61.5%** (8/13) |
| H1 | 92.3% | 92.3% (12/13) |
| H2 | 85.7% | **46.2%** (6/13) |
| H3 | **100.0%** | **92.3%** (12/13) |

H3's 100% was the review-credited artefact the re-review predicted: it reviews one
hard negative and catches twelve. H2's number nearly halved, which matters because
H2 is the rule that trades vetoes for reviews — exactly the behaviour the old
metric rewarded.

**2. Invalid runs stopped counting as agreement.** Three raw pairs — **p05, p06,
p08** — have one unparseable reply out of three. Under R1 they were "unanimous"
and drove automatic decisions; under R1.1 they route to review:

| raw, t=0.90 | R1 | R1.1 |
| --- | --- | --- |
| H1 automatic coverage | 89.3% | **82.1%** |
| H1 false changed | 7 | **5** |
| H3 automatic coverage | 75.0% | **67.9%** |
| H3 false changed | 7 | **5** |

Coverage fell and false changed fell with it, because two of the three pairs were
being auto-flagged `changed` on the strength of evidence that was missing a run.
The surface variant has **no** invalid runs, so none of its hybrid numbers moved.

Neither correction changed the ranking of the methods. Both changed how much
credit the tri-states were getting for not answering.

## A. Local embedding — cosine similarity

`evidence/embedding-results.json`

Unchanged from the first round, and still decisive: **the corpus is not separable
by any threshold**, in either input variant.

| variant | lowest `preserved` | highest `changed` | separable |
| --- | --- | --- | --- |
| raw | **0.7356** (p05, transliterated fixture name) | **0.9867** (p21, instruction → report) | **no** |
| surface | 0.7262 (p05) | 0.9866 (p21) | **no** |

The distributions are not merely overlapping, they are *inverted*. Hard negatives,
raw cosine, highest first:

| probe | difference | cosine |
| --- | --- | --- |
| p21 | 整理しておいてください → 整理しておきました | **0.9867** |
| p26 | マージ前 → マージ後 | **0.9834** |
| p14 | 逃がさない → 逃がす | **0.9749** |
| p16 | 午前10時 → 午後10時 | **0.9723** |
| p22 | 三百ミリ → 三千ミリ | **0.9683** |

The lowest threshold with zero false preserved is **0.99**, where the method flags
**12 of 13** correct transcripts as changed. That is not a strict setting; it is a
method that has stopped discriminating. This embedding measures topical
similarity, and negation, direction and quantity are one or two tokens in a long
sentence about the same subject.

## B. Local LLM rubric — raw vs surface

`evidence/llm-rubric-results.raw.json`, `evidence/llm-rubric-results.surface.json`

Same model, same prompt, same parameters, 3 runs per pair, 84 runs each.

| measure | **raw** | **surface** |
| --- | --- | --- |
| provisional accuracy | 71.4% (20/28) | **75.0%** (21/28) |
| **false preserved** | **1** (p21) | **0** |
| false changed | 7 | 7 |
| hard-negative auto-changed recall | 92.3% (12/13) | **100.0%** (13/13) |
| valid-vote unanimous | 100.0% | 100.0% |
| **full-run unanimous** | **89.3%** (25/28) | **100.0%** (28/28) |
| pairs with an unparseable reply | **3** (p05, p06, p08) | **0** |
| valid votes that disagreed | 0 | 0 |
| byte-identical replies across runs | 82.1% | 64.3% |
| `parseable_schema_valid` | 96.4% | **100.0%** |
| `exact_output_contract_valid` | **92.9%** | 86.9% |
| latency per request (median) | 587 ms | 602 ms |

The two unanimity rows are the correction R1.1 makes to R1's flat "unanimous
100%". Every reply that parsed agreed with the others — that part was true. But on
raw input three pairs are missing a reply entirely, and calling those unanimous
credits the model with an answer it did not give. Surface input has no such gap,
which is a second, independent reason the raw/surface choice is not cosmetic.

### Surface input removes the only dangerous error

p21 — 「整理しておいてください」 → 「整理しておきました」 — is the one pair the raw
run called `preserved` three times out of three. On surface-normalized input the
same model, same prompt and same parameters calls it `changed` three times out of
three.

This is a real result and it is a fragile one. Nothing in surface-normalize-v1
touches Japanese verb morphology; the profile folds width, case, two punctuation
marks and runs of ASCII spaces. What actually changed for p21 is the surrounding
punctuation and spacing, and that was enough to move an 8B model across a decision
boundary it was already sitting on. **Treat this as evidence that the raw/surface
choice matters, not as evidence that surface normalization solves instruction
detection.**

### The two compliance rates are not the same number

The first round reported "0.0% invalid JSON". That figure conflated two things,
and they are now separated:

- **`parseable_schema_valid`** — a complete, correctly typed verdict could be
  recovered from the reply: raw 96.4%, surface 100.0%.
- **`exact_output_contract_valid`** — the reply was one JSON object and nothing
  else, which is what the prompt asked for: raw 92.9%, surface **86.9%**.

Roughly one reply in eight wraps the object in a code fence or a sentence. The
parser tolerates that; a production evaluator would have to decide whether it
should.

### Where it over-flags

Seven proposed-`preserved` pairs are called `changed` in both variants: p04, p06,
p08, p09, p10, p12, p28. Six are the same shape — the transcript said the same
thing in a different script or a different word — and p12 is the self-correction
whose final intent was correctly kept. This is the safe direction to fail in, and
it is expensive: over half the correct transcripts in the corpus would reach a
human.

Note that p04 is on that list, and p04 is also on the
[list of labels most worth a second opinion](./HUMAN_GOLD_REVIEW.md). If the human
review moves p04 to `changed`, both variants gain a point and the false-changed
count drops to 6.

## C. Hybrid variants

`evidence/analysis-summary.json`

Four rules, each measured at three embedding thresholds, each measured raw/raw
and surface/surface so a variant is compared against itself.

| rule | |
| --- | --- |
| **H0** | critical veto; else embedding and the rubric's **majority** must agree; else review. Does not require every run to have parsed — kept as a comparator, not a candidate. |
| **H1** | critical veto; else **any invalid run or split vote → review**; else full-run-unanimous rubric `changed` → `changed`; else embedding conflict → review; else `preserved` |
| **H2** | as H1, but a critical mismatch **routes to review** instead of vetoing |
| **H3** | critical veto → `changed`; else full-run-unanimous rubric `changed` → `changed`; **everything else → review** |

H1, H2 and H3 all place the missing-evidence check **before** they read the
rubric's label. That ordering is the point: an invalid run is not a quieter
`changed`, it is an absent answer, and only the deterministic critical signal —
computed from the two texts, not from the model — decides ahead of it.

### raw input

| rule @ t | FP | FC | auto changed | auto preserved | review | coverage | hn auto-changed | hn non-preserved |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| H0 @ 0.90 | 1 | 6 | 16 | 4 | 28.6% | 71.4% | 61.5% (8/13) | 92.3% |
| H1 @ 0.90 | 1 | 5 | 19 | 4 | 17.9% | 82.1% | 92.3% (12/13) | 92.3% |
| H2 @ 0.90 | 1 | 4 | 11 | 4 | 46.4% | 53.6% | 46.2% (6/13) | 92.3% |
| **H3 @ any** | **0** | 5 | 19 | **0** | 32.1% | 67.9% | 92.3% (12/13) | **100.0%** |

### surface input

| rule @ t | FP | FC | auto changed | auto preserved | review | coverage | hn auto-changed | hn non-preserved |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| H0 @ 0.90 | **0** | 6 | 16 | 4 | 28.6% | 71.4% | 61.5% (8/13) | 100.0% |
| **H1 @ 0.90** | **0** | 7 | 22 | 4 | **7.1%** | **92.9%** | **100.0%** (13/13) | 100.0% |
| H2 @ 0.90 | **0** | 6 | 14 | 4 | 35.7% | 64.3% | 53.8% (7/13) | 100.0% |
| H3 @ any | **0** | 7 | 22 | **0** | 21.4% | 78.6% | **100.0%** (13/13) | 100.0% |

Four things these tables say that the first round could not:

1. **On surface input every rule reaches zero false preserved.** The first round
   reported one that no variant could remove; the input variant was the missing
   lever, not the rule.
2. **H1 is the best-covered zero-FP rule** — 92.9% automatic, 7.1% review, and now
   also the only rule pairing that detects all 13 hard negatives by itself. It
   gets there by letting the rubric's `changed` decide alone and using the
   embedding only to send disagreements to review, which is the opposite of the
   agreement-gated H0 and is why it covers more.
3. **H3 buys its guarantee structurally, not statistically.** Its zero is true on
   raw input too, because it never says `preserved` at all. It is the only rule
   whose false-preserved count does not depend on the model being right.
4. **Reviewing more does not detect more.** H0 and H2 review the most and now
   score 53.8–61.5% auto-changed recall against H1 and H3's 92.3–100%. Under the
   old denominator they read 85.7–100% and looked competitive. This is the single
   comparison R1.1's metric fix changes most, and it argues against both.

### The critical guard: veto or review trigger?

critical-info-v1 applies to 12 of 28 pairs and reports a mismatch on 8. Seven are
correct. The eighth is **p12** — the self-correction 「二千六百ミリで、あ、すみません、
二千七百ミリでした」 → 「二千七百ミリです」. The reference names both the retracted
and the corrected value, the hypothesis names one, and the entity multiset does not
match.

Measured, on surface input at t=0.90:

| | H1 (veto) | H2 (review trigger) |
| --- | --- | --- |
| false preserved | 0 | 0 |
| false changed | **7** | **6** |
| auto changed | 22 | 14 |
| review rate | **7.1%** | 35.7% |
| automatic coverage | **92.9%** | 64.3% |
| **hard-negative auto-changed recall** | **100.0%** (13/13) | **53.8%** (7/13) |

Demoting the veto buys back exactly one false changed — p12 — and costs 28.6
points of automatic coverage **and 46.2 points of hard-negative detection**. That
last column is new in R1.1: under the old denominator H2 also read 100.0%, because
the six hard negatives it sent to review were not being counted against it. With
the corpus denominator the trade is no longer close.

**On this evidence the review-trigger recommendation from the first round does not
hold up**, and the corrected metric makes the case stronger rather than weaker.
Keep the veto, and record p12's shape as a known limitation: a correctly handled
self-correction will be auto-flagged `changed` because the retracted value is a
real entity in the reference.

## Side by side

| | Embedding | LLM rubric (surface) | Hybrid H1 (surface, 0.90) |
| --- | --- | --- | --- |
| false preserved | **not controllable** — 0 only at a threshold rejecting 12/13 correct | **0** | **0** |
| false changed | 12 at that threshold | 7 | 7 |
| hard-negative auto-changed | 0% at any usable threshold | 100.0% | 100.0% |
| repeatability | deterministic | 100% full-run unanimous | inherits |
| exact output contract | n/a | 86.9% | 86.9% |
| latency per pair (median, 3 runs) | ≈23 ms | ≈1.8 s | ≈1.8 s |
| review load | n/a | n/a | 7.1% |

## Recommendation

- **Embedding-only: no.** Inverted on this corpus; the failure is structural, not
  an unfound threshold. Useful only as a second opinion that can send a
  disagreement to review.
- **Input variant: surface.** Measured, not assumed — it is the difference between
  one false preserved and none, in both the rubric alone and every hybrid rule.
  R1.1 adds a second, unrelated reason: raw input produced three unparseable
  replies and surface produced none, so raw loses coverage to missing evidence
  before any rule is chosen. The meaning-level mechanism is still not understood
  and should not be relied on beyond this corpus.
- **Critical guard: keep it as a veto.** The review-trigger alternative buys one
  false changed for 28.6 points of coverage and 46.2 points of hard-negative
  detection. Record the self-correction limitation.
- **Rule: H1 for coverage, H3 if `preserved` must never be automatic.** H1 reaches
  zero false preserved with 92.9% coverage *on this corpus and this proposal set*.
  H3 reaches zero by construction and costs 21.4% review.
- **H0 and H2 are out.** Both now score 53.8–61.5% auto-changed recall on the
  corpus denominator, against 100% for H1 and H3 on surface input. Neither
  survives the correction that stopped crediting review as detection.

**The choice between H1 and H3 is not a research question.** H1's zero depends on
an 8B model being right about 15 changed pairs; H3's does not depend on the model
at all. That is a decision about how much model behaviour a bench is willing to
put behind the word "preserved", and it belongs to a person.

## Evidence limitations

- **The labels are unconfirmed.** 28 proposals, zero human approvals.
- **28 pairs, one machine, one 8B model, one quantization.** No claim about
  another model, another quantization, or another Ollama build.
- **The seed is uncontrolled.** Repeatability was measured at temperature 0 across
  three runs. Every reply that parsed agreed; on raw input three pairs are missing
  one reply each, which is why full-run unanimity is 89.3% there and 100% on
  surface. None of this guarantees a fourth run agrees.
- **The hybrid numbers are re-derived, not re-run.** R1.1 corrected two scoring
  faults and recomputed everything from the runs R1 recorded. That is the right
  way to fix a measurement — the model's actual replies are unchanged and their
  hashes still match — but it also means no new sampling was done, and the sample
  is still 84 runs per variant.
- **Rationale text is not stable even when labels are.** Two of p21's three raw
  rationales described a self-correction that appears in neither text. Rationales
  are a debugging aid, not evidence.
- **No embedding-model digest exists.** LM Studio reports quantization and
  architecture but no artifact checksum, so the embedding numbers cannot be pinned
  to a specific file.
