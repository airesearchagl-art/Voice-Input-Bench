# Semantic Method Comparison — P3-D-A Final

**This is a research spike. Nothing here is production code, and nothing here
picks a production threshold.**

> **The labels are human-reviewed.** All 28 were proposed by the research agent
> that built this spike, reviewed by the project owner on **2026-09-08**, and
> **approved unchanged — 0 rejected, 0 label changes**. See
> [`HUMAN_GOLD_REVIEW.md`](./HUMAN_GOLD_REVIEW.md). Every figure in this section
> is **accuracy against human-reviewed labels**.
>
> The promotion changed the corpus digest, so **all evidence below was
> re-acquired against the promoted corpus on real runtimes** — embeddings, both
> rubric variants, the environment capture and the analysis. Nothing was carried
> over by rewriting a digest.
>
> Rounds R0, R1 and R1.1 predate the review, are labelled *provisional accuracy
> against proposed labels*, and are kept as history at the end of this document.

| | |
| --- | --- |
| Corpus | `probes-v1.json`, digest `40715f8298628ad3af77a678451c26c835688f173d562efa52fb58c1a194b092` |
| Gold | **human-reviewed 2026-09-08** — 28/28 approved, 0 changes. Pre-review digest `5a14302d…5b0a` is historical. |
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
and a rule that reviewed twelve of thirteen and caught one scored 100%. That was
corrected in R1.1 and still holds: a test asserts the denominator is 13 for every
variant published here, and that detection is short of 100% whenever a rule
reviews a hard negative.

**Automated decisions rest on `full_run_unanimous`, not on agreement among the
replies that happened to parse.** R1 recorded one `unanimous` flag computed over
the valid runs, so two agreeing runs and one unparseable reply counted as three
agreeing runs. Both levels are now reported separately and only the strict one
routes anything automatically.

## Final evidence

Acquired against the promoted corpus `40715f82…b092` on 2026-09-08. Ollama 0.33.3
running `llama3.1:8b` (digest `46e0c10c039e…`, Q4_K_M) and LM Studio running
`text-embedding-nomic-embed-text-v1.5` (Q4_K_M, no digest available), both
loopback, 0 downloads.

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
**12 of 13** correct transcripts as changed on raw input and 11 of 13 on surface. That is not a strict setting; it is a
method that has stopped discriminating. This embedding measures topical
similarity, and negation, direction and quantity are one or two tokens in a long
sentence about the same subject.

## B. Local LLM rubric — raw vs surface

`evidence/llm-rubric-results.raw.json`, `evidence/llm-rubric-results.surface.json`

Same model, same prompt, same parameters, 3 runs per pair, 84 runs each.

| measure | **raw** | **surface** |
| --- | --- | --- |
| accuracy | 71.4% (20/28) | **75.0%** (21/28) |
| **false preserved** | **1** (p21) | **0** |
| false changed | 7 | 7 |
| hard-negative auto-changed recall | 92.3% (12/13) | **100.0%** (13/13) |
| valid-vote unanimous | 100.0% | 100.0% |
| full-run unanimous | **100.0%** (28/28) | **100.0%** (28/28) |
| pairs with an unparseable reply | **0** | **0** |
| valid votes that disagreed | 0 | 0 |
| `parseable_schema_valid` | **100.0%** | **100.0%** |
| `exact_output_contract_valid` | **96.4%** | 86.9% |
| byte-identical replies across runs | 89.3% (25/28) | 64.3% (18/28) |
| latency per request (median) | 586 ms | 600 ms |

**The invalid-run rate is not stable between runs, and that is itself a result.**
R1.1's raw run had three pairs with an unparseable reply (p05, p06, p08); this
run, same model, same prompt, same temperature 0, has none. The seed is
uncontrolled, so the run-to-run variance sits in exactly the place a bench cannot
tolerate it — in how much evidence a verdict rests on. **A rule that treats a
missing reply as agreement would be right on one of these two runs and wrong on
the other**, which is why the full-run check stays even though this run would not
have needed it.

The *labels* were stable across both acquisitions: same accuracy, same false
preserved, same seven false changed, in both input variants. What moved was
compliance and packaging, not judgement.

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
and they are separated everywhere now:

- **`parseable_schema_valid`** — a complete, correctly typed verdict could be
  recovered from the reply: **raw 100.0%, surface 100.0%** in this acquisition.
- **`exact_output_contract_valid`** — the reply was one JSON object and nothing
  else, which is what the prompt asked for: raw **96.4%**, surface **86.9%**.

In this run the first figure genuinely is 100%, and reporting it alone would
*still* have been misleading: **one surface reply in eight arrived wrapped in a
code fence or a sentence.** The parser tolerates that; a production evaluator
would have to decide whether it should.

The two figures also move independently between acquisitions. R1.1 read
96.4% / 92.9% on raw where this run reads 100.0% / 96.4% — same model, same
prompt, uncontrolled seed. Neither is a property of the method; both are
properties of a run, which is why every run records its own.

### Where it over-flags

Seven proposed-`preserved` pairs are called `changed` in both variants: p04, p06,
p08, p09, p10, p12, p28. Six are the same shape — the transcript said the same
thing in a different script or a different word — and p12 is the self-correction
whose final intent was correctly kept. This is the safe direction to fail in, and
it is expensive: over half the correct transcripts in the corpus would reach a
human.

p04 was flagged during the spike as one of the labels most worth a second
opinion, precisely because the rubric disagrees with it. **The human review looked
at it and kept `preserved`.** So the disagreement is now settled against the
model: `2700mm` ↔ `二千七百ミリ` preserves meaning, and calling it `changed` is a
false changed, not an arguable label. The same applies to p12, the
self-correction.

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
| **H4** | **H3 with the critical veto demoted to a review trigger, and nothing else changed.** critical mismatch → review; else full-run-unanimous rubric `changed` → `changed`; everything else → review |

H3 and H4 read no embedding at all, so their figures are **threshold-independent**
— the three columns of 0.85 / 0.90 / 0.95 produce one answer, and a test asserts
it. They exist as a pair because **H3 and H4 differ in exactly one step**: what a
critical-information mismatch means on its own. Measuring them apart is what makes
that policy's cost readable instead of bundled with the auto-preserved policy.

H1, H2 and H3 all place the missing-evidence check **before** they read the
rubric's label. That ordering is the point: an invalid run is not a quieter
`changed`, it is an absent answer, and only the deterministic critical signal —
computed from the two texts, not from the model — decides ahead of it.

### raw input

| rule @ t | FP | FC | auto changed | auto preserved | review | coverage | hn auto-changed | hn non-preserved |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| H0 @ 0.90 | 1 | 6 | 16 | 4 | 28.6% | 71.4% | 61.5% (8/13) | 92.3% |
| H1 @ 0.90 | 1 | 7 | 21 | 4 | 10.7% | 89.3% | 92.3% (12/13) | 92.3% |
| H2 @ 0.90 | 1 | 6 | 13 | 4 | 39.3% | 60.7% | 46.2% (6/13) | 92.3% |
| **H3 @ any** | **0** | 7 | 21 | **0** | 25.0% | 75.0% | 92.3% (12/13) | **100.0%** |
| **H4 @ any** | **0** | **6** | 13 | **0** | 53.6% | 46.4% | 46.2% (6/13) | **100.0%** |

H1 and H3 recover the coverage they lost in R1.1 — 89.3% and 75.0% — because this
run has no unparseable replies to route away. **The rule did not change; the run
did.** R1.1's lower coverage was the same rule meeting worse evidence, which is
the behaviour that was wanted.

### surface input

| rule @ t | FP | FC | auto changed | auto preserved | review | coverage | hn auto-changed | hn non-preserved |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| H0 @ 0.90 | **0** | 6 | 16 | 4 | 28.6% | 71.4% | 61.5% (8/13) | 100.0% |
| **H1 @ 0.90** | **0** | 7 | 22 | 4 | **7.1%** | **92.9%** | **100.0%** (13/13) | 100.0% |
| H2 @ 0.90 | **0** | 6 | 14 | 4 | 35.7% | 64.3% | 53.8% (7/13) | 100.0% |
| **H3 @ any** | **0** | 7 | 22 | **0** | 21.4% | 78.6% | **100.0%** (13/13) | 100.0% |
| **H4 @ any** | **0** | **6** | 14 | **0** | 50.0% | 50.0% | 53.8% (7/13) | 100.0% |

Both surface tables are **identical to R1.1's** for H0–H3, to the pair. Surface input had no
invalid runs in either acquisition, so nothing the corrections touched applied to
it — and the human review changed no label, so nothing it could have moved moved.
Two independent acquisitions agreeing exactly is the strongest repeatability
evidence in this document, and it covers only the surface variant.

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
4. **Reviewing more does not detect more.** H0 and H2 review the most and score
   53.8–61.5% auto-changed recall against H1 and H3's 92.3–100%. Under the
   pre-R1.1 denominator they read 85.7–100% and looked competitive. This is the
   comparison the metric fix changes most, and it argues against both.
5. **The choice of rule is worth more than the choice of threshold.** Across
   0.85 / 0.90 / 0.95 the embedding threshold moves coverage by at most 7.2
   points and never changes a false preserved. The rule changes both by an order
   of magnitude more. A production threshold is not the decision that matters
   here.

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
points of automatic coverage **and 46.2 points of hard-negative detection**. Under
the pre-R1.1 denominator H2 also read 100.0% detection, because the six hard
negatives it sent to review were not counted against it; with the corpus
denominator the trade is not close.

**The human review settles the one thing that could have reversed this.** p12's
proposed `preserved` was on the list of labels most worth a second opinion — if a
reviewer had called it `changed`, the critical guard would have been right and the
demotion would have been buying nothing at all. The review kept `preserved`.

That makes p12 a **deterministic false changed** under any rule that keeps the
veto. No model is involved and no threshold moves it: the reference names both the
retracted and the corrected value, the hypothesis names one, the entity multiset
does not match, and the pair is flagged. **A correctly handled self-correction is
auto-flagged `changed`, always.** That is a confirmed limitation now, not a
suspected one.

#### H3 vs H4 — the critical policy on its own

H2 measured the demotion while also carrying H1's auto-preserve behaviour, so its
cost was never separable. **H4 is H3 with only that one step changed**, which
isolates it. Surface input:

| | H3 (hard veto) | H4 (review trigger) |
| --- | --- | --- |
| false preserved | 0 | 0 |
| **false changed** | 7 | **6** — p12 no longer auto-flagged |
| auto changed | 22 | 14 |
| auto preserved | **0** | **0** |
| review rate | **21.4%** | 50.0% |
| automatic coverage | **78.6%** | 50.0% |
| hard-negative auto-changed recall | **100.0%** (13/13) | 53.8% (7/13) |
| hard-negative non-preserved coverage | 100.0% | 100.0% |

**H4 buys exactly p12 — one false changed — for 28.6 points of automatic coverage
and 46.2 points of hard-negative detection.** Both rules reach zero false
preserved and both route every hard negative away from `preserved`; they differ in
how many of them a person has to look at.

This spike does not resolve it. The veto is the better trade on these numbers, but
"a correctly handled self-correction is always flagged" is a user-visible
behaviour, and how much review load is worth avoiding it is a judgement about the
people doing the reviewing. **It goes to the adoption decision, not to a
recommendation here.**

## Side by side

| | Embedding | LLM rubric (surface) | Hybrid H1 (surface, 0.90) | Hybrid H3 (surface) |
| --- | --- | --- | --- | --- |
| false preserved | **not controllable** — 0 only at 0.99, which rejects 12 of 13 correct on raw, 11 on surface | **0** | **0** | **0, by construction** |
| false changed | 12 raw / 11 surface at that threshold | 7 | 7 | 7 |
| hard-negative auto-changed | 0% at any usable threshold | 100.0% | 100.0% (13/13) | 100.0% (13/13) |
| auto preserved | n/a | n/a | 4 | **0** |
| repeatability | deterministic | 100% full-run unanimous | inherits | inherits |
| exact output contract | n/a | 86.9% | 86.9% | 86.9% |
| latency per pair (median, 3 runs) | ≈25 ms | ≈1.8 s | ≈1.8 s | ≈1.8 s |
| review load | n/a | n/a | **7.1%** | 21.4% |

## Recommendation

Re-derived from the final evidence, not carried over. Where a recommendation
survives an earlier round unchanged, it is because the new measurement agrees, and
the reason is given.

- **Embedding-only: reject.** `min_preserved = 0.7356` sits far below
  `max_changed = 0.9867`; the distributions are not overlapping but *inverted*,
  on both input variants. The only zero-false-preserved threshold is 0.99, which
  rejects 12 of 13 correct transcripts on raw input — a method that has stopped
  discriminating, not a strict setting. Keep it only as a second opinion that can
  route a disagreement to review, which is the single job it does well.
- **Semantic input: surface.** Two independent reasons, both measured. It is the
  difference between one false preserved and none, in the rubric alone and in
  every hybrid rule; and it is the variant whose numbers were identical across
  two separate acquisitions three days apart, while raw's compliance moved. The
  *meaning-level* mechanism for p21 is still not understood — `surface-normalize-v1`
  does not touch Japanese verb morphology — so this is an empirical choice on this
  corpus, not a principle.
- **Critical mismatch: not settled here — H3 or H4.** Keeping it as a hard veto
  is the better trade on these numbers (28.6 points of coverage and 46.2 of
  hard-negative detection, against one false changed). But the one false changed
  is p12, a *correctly handled self-correction*, confirmed `preserved` by the
  human review and flagged deterministically. Whether that behaviour is
  acceptable is a policy question about the people doing the reviewing, and this
  document should not pre-empt it.
- **Candidate hybrid: H1, H3 or H4, on surface input. Not H0, not H2.** H0 and H2
  detect 53.8–61.5% of hard negatives by themselves; H2 is additionally
  superseded by H4, which measures the same critical policy without also changing
  the auto-preserve behaviour.

### The decision, as two independent axes

The three candidates are not a ranking. They are the corners of a two-axis
choice, and each axis has a cost that is now measured:

**Axis 1 — may the bench say `preserved` without a person?**

| | rule | cost |
| --- | --- | --- |
| yes | **H1** | `preserved` becomes model-backed: 4 automatic preserves resting on an 8B model at uncontrolled seed. Buys review load down to **7.1%**. |
| no | **H3 / H4** | Review load **21.4%** (H3) or **50.0%** (H4). Zero false preserved holds without depending on the model. |

**Axis 2 — what does a critical-information mismatch mean on its own?**

| | rule | cost |
| --- | --- | --- |
| decisive | **H3** (and H1) | p12 is a deterministic false changed. A correctly handled self-correction is always flagged. |
| needs a person | **H4** | One fewer false changed, at **+28.6 points of review** and **−46.2 points of hard-negative detection**. |

Every combination reaches **zero false preserved on surface input** and routes
every hard negative away from `preserved`. The axes trade review load against
two different things — model trust on the first, a known false-flag on the
second — and neither is a research question.

### E. Can H1 be allowed to auto-preserve?

**Not on this evidence.** H1 auto-preserves 4 of 28 pairs and reaches zero false
preserved — but that zero rests on an 8B model, at temperature 0 with an
uncontrolled seed, being right about all 15 changed pairs, on 28 examples. The
raw variant of the same rule still produces one false preserved (p21), and the
only thing separating the two is a surface transform with no explanation for why
it should matter. **One corpus-wide zero is not a bound.**

What would change the answer: a materially larger corpus, a controlled seed, and
a false-preserved rate that stays at zero across repeated acquisitions rather
than within one.

### F. Should `preserved` require human review?

**Under H3 and H4, yes — that is what they are.** Neither emits an automatic
`preserved`; every pair not vetoed or unanimously called `changed` goes to a
person. On surface input that costs **21.4% review** (H3) or **50.0%** (H4)
against H1's 7.1%, and buys a false-preserved rate of zero that **does not depend
on the model being right about anything**.

H1 and H3 differ by 14.3 points of review load. That is the entire price of the
guarantee on axis 1, and it is small.

**Neither axis is a research question.** H1's zero depends on an 8B model; H3's
and H4's do not depend on the model at all. **This spike's own reading is H3** —
the bench's stated purpose is reproducibility, every other evaluator in it is
exactly recomputable, and H1 would make `preserved` the one verdict that is not.
On axis 2 the spike has **no reading**: 28.6 points of review load against never
auto-flagging a correct self-correction is a trade only the people doing the
reviewing can price.

## Evidence limitations

- **The labels are confirmed; the corpus is still 28 pairs.** Human review
  removes the "unconfirmed labels" caveat and nothing else. A confirmed label on
  28 pairs is not a large sample, and the review approved the proposals unchanged
  — which is a check on them, not an independent second derivation of them.
- **28 pairs, one machine, one 8B model, one quantization.** No claim about
  another model, another quantization, or another Ollama build.
- **The seed is uncontrolled, and it shows.** Two acquisitions of the raw variant,
  same model and same prompt at temperature 0, differed: R1.1 had three pairs with
  an unparseable reply and this one has none. Labels were identical across both;
  compliance was not. Repeatability here is a measured property of two runs, not
  a guarantee about a third.
- **Surface's advantage rests on one pair.** p21 is the only pair that separates
  raw from surface, and the mechanism is unexplained. If p21 were removed from the
  corpus the two variants would be indistinguishable on every headline metric.
- **84 runs per variant.** Enough to see that labels are stable and compliance is
  not; not enough to bound a false-preserved rate.
- **Rationale text is not stable even when labels are.** Two of p21's three raw
  rationales described a self-correction that appears in neither text. Rationales
  are a debugging aid, not evidence.
- **No embedding-model digest exists.** LM Studio reports quantization and
  architecture but no artifact checksum, so the embedding numbers cannot be pinned
  to a specific file.

---

## History — what the earlier rounds changed, and what it cost

*The three subsections below describe R0, R1 and R1.1. Their figures were
measured against unconfirmed labels and are labelled provisional; they are kept
because each one explains why a number in the final evidence is what it is.*

### R1 — the leaked prompt

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

### R1.1 — two measurements that flattered the tri-states

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
