# Semantic Method Comparison — P3-D-A

**This is a research spike. Nothing here is production code, and nothing here
picks a production threshold.**

Three candidate methods were run against one frozen 28-pair probe corpus on this
machine. Every number below comes from a file in `evidence/`, and every result
file records the corpus digest, the endpoint, the model and — for the rubric —
the prompt digest.

| | |
| --- | --- |
| Corpus | `probes-v1.json`, digest `9e76b35a10c399161f07ad3602842a376d056292cc8c36624a6ad4bc6ea025de` |
| Probes | 28 (13 `preserved`, 15 `changed`, 13 hard negatives) |
| Embedding | `text-embedding-nomic-embed-text-v1.5` via LM Studio, `http://127.0.0.1:1234` |
| LLM | `llama3.1:8b` (Q4_K_M, digest `46e0c10c039e…`) via Ollama, `http://127.0.0.1:11434` |
| Rubric | `prompts/semantic-rubric-v1.md`, digest `ede8c57b4c05c6f17a25473f959d3e305109b8feecb901323059121ccab70d18`, temperature 0, 3 runs per pair |
| Downloads performed | **0** — both models were already installed |

## The metric that ranks these methods

**False preserved**, not accuracy.

A *false preserved* is a transcript that changed the meaning and was reported as
fine. Someone reads 「梁貫通で逃がす」 believing it says 「逃がさない」 and builds
it. A *false changed* costs a person a minute of checking. Averaging the two into
an accuracy figure hides the only failure that can reach a building, so accuracy
is reported below and is never the basis of a recommendation.

## A. Local embedding — cosine similarity

`evidence/embedding-results.json`

The corpus is **not separable by any threshold**, in either input variant.

| variant | lowest `preserved` | highest `changed` | separable |
| --- | --- | --- | --- |
| raw | **0.7356** (p05 `water closet` ↔ `ウォータークローゼット`) | **0.9867** (p21 instruction → report) | **no** |
| surface-normalized | 0.7262 (p05) | 0.9866 (p21) | **no** |

The two distributions are not merely overlapping, they are *inverted*: the pairs
that mean the same thing score lower than the pairs that mean the opposite.

Hard negatives, raw cosine, highest first:

| probe | difference | cosine |
| --- | --- | --- |
| p21 | 整理しておいてください → 整理しておきました | **0.9867** |
| p26 | マージ前 → マージ後 | **0.9834** |
| p14 | 逃がさない → 逃がす | **0.9749** |
| p16 | 午前10時 → 午後10時 | **0.9723** |
| p22 | 三百ミリ → 三千ミリ | **0.9683** |
| p19 | west side → east side | 0.9481 |
| p20 | 屋上 → 地下機械室 | 0.9477 |
| p15 | 2700mm → 2600mm | 0.9409 |

Every one of those is a sentence that would change what gets built, and every one
of them is scored as *more* similar than 「water closet」 and its transliteration.

The threshold sweep confirms there is nothing to tune. The lowest threshold with
zero false preserved is **0.99**, and at 0.99 the method flags **12 of 13**
correct transcripts as changed. That is not a strict setting; it is a method that
has stopped discriminating.

The reason is visible in the data: this embedding measures *topical* similarity.
Two sentences about ceiling heights in the same building are near-identical
vectors whether the height is 2700 or 2600. Negation, direction and quantity are
one or two tokens in a long sentence, and they move the vector less than a change
of vocabulary does.

## B. Local LLM rubric — semantic-rubric-v1

`evidence/llm-rubric-results.json`

| measure | value |
| --- | --- |
| accuracy | 75.0% (21/28) |
| **false preserved** | **1** — p21 |
| false changed | 6 — p06, p08, p09, p10, p12, p28 |
| hard-negative recall | **92.3%** (12/13; missed p21) |
| invalid JSON | **0.0%** (0 of 84 runs) |
| unanimous pairs | **100.0%** (28/28) |
| disagreement pairs | 0 |
| latency | 589 ms mean per request, 571 ms median (≈1.8 s per pair at 3 runs) |

The rubric caught every reversed direction, every reversed polarity, every
changed value and unit, the dropped fact, the added fact and the self-correction
that kept the retracted number. It did so unanimously across three runs at
temperature 0, and never once produced a reply the parser had to reject.

### The one that got through

p21 is 「電気室の位置も…一度整理しておいてください」 against 「…整理しておきました」
— an instruction turned into a report of completed work. The model answered
`preserved` three times out of three, with `instruction_action: false`, and
rationalised it as:

> "Only surface-level differences in verb tense."

It saw the tense change and classified it as typography. On the other two runs the
rationale was *"Only a self-correction was added"*, which describes something that
is not in either text. **The label was perfectly repeatable and the reasoning
behind it was not** — a distinction that a `unanimous_rate` of 100% conceals, and
a reason to treat rationale text as a debugging aid rather than as evidence.

### Where it over-flags

All six false changed are the same shape: the transcript said the same thing in
different words or a different script, and the model treated the difference as
meaning. p05 (`water closet` → transliteration) passed, but p08 (`Revit` →
レビット), p09 (`north side` → ノースサイド) and p28 (打ち放し → 打ちっぱなし) did
not. p12 — the self-correction whose final intent was correctly kept — was also
called changed.

This is the safe direction to fail in, and it is expensive: nearly half the
correct transcripts in the corpus would arrive at a human for checking.

## C. Hybrid tri-state — preserved / changed / review

`evidence/analysis-summary.json`

Rule under test:

1. A **critical-info-v1 mismatch vetoes** to `changed`.
2. Otherwise embedding and rubric must **agree**.
3. Otherwise **review**.

| embedding threshold | false preserved | false changed | review rate | automatic coverage | hard-negative recall (review counts as caught) |
| --- | --- | --- | --- | --- | --- |
| 0.85 | **1** (p21) | 3 | 46.4% | 53.6% | 92.3% |
| 0.90 | **1** (p21) | 5 | 32.1% | 67.9% | 92.3% |
| 0.95 | **1** (p21) | 6 | 28.6% | 71.4% | 92.3% |

**The hybrid does not reach zero false preserved.** p21 escapes every variant,
and it escapes for a structural reason rather than a tuning one:

- critical-info-v1 **has no opinion** — the sentence contains no number, unit or
  clock time, so the veto never fires;
- the embedding scores it **0.9867**, the highest similarity in the corpus;
- the rubric says `preserved` unanimously.

All three signals agree, and all three are wrong. Adding a fourth model would not
obviously help: the failure is that an instruction becoming a report is a small
lexical change with a large consequence, which is precisely the shape every one
of these methods is weakest against.

### The veto is not free either

critical-info-v1 applies to 12 of 28 pairs and reports a mismatch on 8. Seven of
those are correct. The eighth is **p12** — the self-correction 「二千六百ミリで、
あ、すみません、二千七百ミリでした」 → 「二千七百ミリです」. The reference contains
both numbers and the hypothesis contains one, so the entity multiset does not
match and the veto fires on a transcript that preserved the meaning perfectly.

Used as a hard veto, critical-info-v1 turns every correctly-handled self-correction
into a `changed`. Used as a *review trigger* it costs a person a look. That
distinction matters more than the accuracy difference between the two.

## Side by side

| | Embedding | LLM rubric | Hybrid (0.90) |
| --- | --- | --- | --- |
| false preserved | **not controllable** — 0 only at a threshold that rejects 12/13 correct transcripts | 1 | 1 |
| false changed | 12 at that threshold | 6 | 5 |
| hard-negative recall | 0% at any usable threshold | 92.3% | 92.3% |
| repeatability | deterministic | 100% unanimous (labels), rationale not stable | inherits |
| invalid output | n/a | 0.0% | 0.0% |
| latency per pair | ≈87 ms | ≈1.8 s | ≈1.9 s |
| review load | n/a | n/a | 28.6–46.4% |

## What this says about raw vs surface input

Feeding surface-normalized text to the embedding changed nothing that matters:
`separable` is false either way, the ordering of the hard negatives is unchanged,
and the best accuracy moves by one pair. The formatting-only probes (p01–p03)
were already near 1.0 in raw form.

The one asymmetry worth recording is that **surface normalization is free and
occasionally clarifying** — p02 goes from 0.8037 raw to 1.0000 normalized — while
raw input keeps information the semantic layer never uses. Nothing in this corpus
argues for raw.

## Recommendation

Not "which method is best" — none of the three is deployable as an automatic
`preserved` verdict on this evidence.

- **Embedding-only: no.** It is inverted on this corpus and the failure is
  structural, not a threshold that has not been found yet.
- **LLM rubric: usable as a detector, not as a clearance.** 92.3% hard-negative
  recall with zero malformed output and perfect label repeatability is a genuinely
  useful signal. One false preserved in 15 changed pairs is not a rate that
  should be allowed to close a case unattended.
- **Hybrid: the right shape, insufficient as specified.** The tri-state is the
  only one of the three that has anywhere to put "I do not know", and it still
  lets p21 through. Before P3-D-B, the rule needs either a fourth signal aimed at
  instruction/action changes, or an explicit decision that `preserved` is never
  automatic — only `changed` and `review` are.

The corpus is 28 pairs on one machine with one 8B model. Every number here is an
indication, not a measurement of production behaviour.
