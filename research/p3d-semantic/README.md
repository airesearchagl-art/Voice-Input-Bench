# P3-D-A — Semantic Evaluation Architecture Spike (Final)

> **Current status note (added later).** This is the record of the P3-D-A spike as it
> stood when the spike ended. The statements below describe *that moment*: at the time,
> no evaluator and no schema v4 existed. **Production has since moved on** — the
> `semantic-h3-v1` evaluator and its schema v4 are implemented and shipped, and the
> decisions recorded here are what they were built from. Read this directory as a
> decision and evidence record, not as the current specification. Current state:
> [`README.md`](../../README.md) and
> [`docs/CURRENT_PRODUCT_STATE.md`](../../docs/CURRENT_PRODUCT_STATE.md); production
> code is the final authority.

**Research only.** Nothing in this directory is production code. No evaluator was
added to `src/evaluation/`, no schema v4 was implemented, no existing artifact
under `data/` was read or written, and no cloud service was contacted.

Two questions:

1. Can a local semantic method say whether an STT transcript preserved the
   meaning of the canonical text — and if so, which method?
2. When a fourth evaluator arrives, does it get a fourth per-evaluator schema or
   a generic envelope?

The answers are in [`SEMANTIC_METHOD_COMPARISON.md`](./SEMANTIC_METHOD_COMPARISON.md)
and [`EVALUATION_ENVELOPE_ARCHITECTURE.md`](./EVALUATION_ENVELOPE_ARCHITECTURE.md).

> **The labels are human-reviewed.** They were proposed by the research agent that
> built this spike, reviewed by the project owner on **2026-09-08**, and approved
> unchanged — **28/28 approved, 0 rejected, 0 label changes**. See
> [`HUMAN_GOLD_REVIEW.md`](./HUMAN_GOLD_REVIEW.md). Current figures are *accuracy
> against human-reviewed labels*; the R0/R1/R1.1 history sections predate the
> review and stay labelled *provisional*.

## Layout

```
probes-v1.json                    28 frozen probe pairs with human-reviewed labels
probes-v1.sha256                  the digest every run records
HUMAN_GOLD_REVIEW.md              the per-probe review sheet; 28/28 approved
prompts/semantic-rubric-v1.md     the frozen rubric prompt (R1: no worked examples)
prompts/semantic-rubric-v1.sha256 its digest
scripts/verify-probes.mjs         check the corpus before trusting any result
scripts/capture-environment.mjs   ask both runtimes what they are, nulls included
scripts/run-embedding.mjs         method A — local embedding cosine
scripts/run-llm-rubric.mjs        method B — local LLM rubric, 3 runs per pair
scripts/analyze-results.mjs       score both methods and four hybrid rules
scripts/backfill-vote-semantics.mjs  re-derive stored vote flags, runs untouched
scripts/lib/scoring.mjs           the rules and the metrics, tested directly
scripts/lib/voteSemantics.mjs     what a set of repeated runs actually agreed on
scripts/lib/goldStatus.mjs        how a figure may be described, derived from provenance
scripts/lib/                      loopback guard, corpus loader, runtime probe, mirrors
evidence/                         every result file, with the conditions that produced it
```

## Running it

```
node research/p3d-semantic/scripts/verify-probes.mjs
node research/p3d-semantic/scripts/capture-environment.mjs
node research/p3d-semantic/scripts/run-embedding.mjs
node research/p3d-semantic/scripts/run-llm-rubric.mjs --input raw
node research/p3d-semantic/scripts/run-llm-rubric.mjs --input surface
node research/p3d-semantic/scripts/analyze-results.mjs
```

Defaults are the two runtimes that were present on the machine this spike ran on:
Ollama at `127.0.0.1:11434` for the rubric and LM Studio at `127.0.0.1:1234` for
embeddings. Both are overridable with `--endpoint`, `--model` and `--api`.

`--input` selects which text the model is shown: `raw` is the transcript as
captured, `surface` is the same text after production `surface-normalize-v1`.
The two runs write separate files (`evidence/llm-rubric-results.raw.json` and
`…surface.json`) and `analyze-results.mjs` scores both, because R1 found the
choice changes the result. Neither file overwrites the other, so a comparison
is always between two runs that both still exist.

**No model is downloaded.** If the named embedding model is not already installed,
`run-embedding.mjs` writes `evidence/embedding-unavailable.json` with status
`UNAVAILABLE_ON_CURRENT_MACHINE` and exits — it does not fetch anything, and the
result is reported as PARTIAL rather than filled in.

## The four guards

These are not conventions, they are tests. `npm.cmd test` runs them alongside the
production suite (`scripts/lib/researchGuards.test.mjs`,
`scripts/lib/mirrors.test.mjs`, `scripts/lib/scoring.test.mjs`,
`scripts/lib/goldGate.test.mjs`).

**1. The corpus is the frozen one.** Every run recomputes the digest of
`probes-v1.json` and refuses to proceed if it does not match `probes-v1.sha256`.
Numbers from an edited corpus would look comparable to earlier numbers and would
not be, which is worse than no numbers. A test edits the corpus and asserts the
load fails.

**2. Nothing leaves this machine.** Every request goes through
`assertLoopbackEndpoint`, which accepts exactly `127.0.0.1`, `localhost`, `::1`
and `[::1]` — by exact match, so `localhost.example.com` and
`127.0.0.1.attacker.test` are both refused. The probe corpus is customer design
conversation; the whole reason this bench is local-first is that such text does
not travel. The guard returns a URL only when it is allowed, so no caller can
reach a remote host by forgetting a check.

**3. No model sees the answer.** `probes-v1.json` carries a proposed label for
every pair, and those labels are what both methods are scored against.
`modelInputFor()` builds a fresh object containing only the two texts and the id
— by construction, not by deletion, so a field added to a probe later cannot leak
by being forgotten. A test renders the actual rubric prompt for every probe and
asserts it contains neither the label nor the note.

R1 found a second leak that the per-probe check could not see: the prompt itself
spelled out two corpus pairs as worked examples, which is a few-shot answer to a
question the model was about to be asked. The rubric now states general rules and
no pairs, and a test asserts the static template contains no probe text at all.
The effect was measurable — see `SEMANTIC_METHOD_COMPARISON.md`.

**4. A malformed reply is not a data point.** `parseVerdict()` is tolerant about
packaging — a code fence or a leading sentence is a formatting habit — and strict
about content. A missing field, a wrong type, a truncated object or an empty
response is recorded as `invalid` and counted. It is never coerced: `"true"` is
not `true`, because coercing it would turn a model that could not follow the
format into a model that said the transcript was fine.

Those are two different questions and R1 records them separately per run:

- `parseable_schema_valid` — a valid verdict object was recoverable from the
  reply, whatever it was wrapped in. This is the one that decides whether the
  run counts as data.
- `exact_output_contract_valid` — the reply *was* the object: no fence, no
  preamble, no trailing remark. This is the one that says whether the model
  followed the format it was given.

A single "valid" flag would have reported the first number and implied the
second. They differ by about ten points.

## How the numbers avoid flattering themselves

Two measurements in R1 gave a tri-state credit for not answering. Both are fixed
in R1.1 and both are pinned by `scripts/lib/scoring.test.mjs`.

**Hard-negative recall divides by the corpus, not by what a rule answered.**
`hard_negative_auto_changed_recall` is auto-`changed` hard negatives over **all 13
hard negatives**, every time. R1 divided by the hard negatives a rule had decided,
so routing one to a human removed it from the measurement — a rule that reviewed
twelve of thirteen and caught one scored 100%. The companion metric,
`hard_negative_non_preserved_coverage`, is the one that counts review, and it
answers a different question: *did the method avoid telling anyone this was fine?*
A rule that reviews everything scores 0% on the first and 100% on the second, and
reporting both under one name would have hidden exactly that.

**Automation rests on `full_run_unanimous`.** Repeated runs are summarised at two
levels, and they are not interchangeable:

- `valid_vote_unanimous` — every reply that produced a verdict agreed. It says
  nothing about how many replies that was.
- `full_run_unanimous` — every requested run produced a verdict, **and** they all
  agreed.

R1 recorded only the first, called it `unanimous`, and let hybrid rules act on it,
so two agreeing replies and one unparseable one drove an automatic decision. On
raw input three of twenty-eight pairs are in exactly that state. They now route to
review. Note that `exact_output_contract_valid` never invalidates a run — a reply
wrapped in a code fence is a formatting habit, and discarding it would throw away
an answer the model got right.

## The corpus

28 pairs: 13 `preserved`, 15 `changed`, 13 of them hard negatives — pairs that are
nearly identical as text and opposite in meaning.

All eight required hard cases are present and checked by `verify-probes.mjs`.
The labels below are proposals awaiting review, not confirmed ground truth:

| probe | pair | proposed label |
| --- | --- | --- |
| p13 | north side ↔ south side | changed |
| p14 | 梁貫通で逃がさない ↔ 梁貫通で逃がす | changed |
| p04 | 2700mm ↔ 二千七百ミリ | preserved |
| p15 | 2700mm ↔ 2600mm | changed |
| p16 | 午前10時 ↔ 午後10時 | changed |
| p01 | GitHub ↔ github | preserved |
| p05 | water closet ↔ ウォータークローゼット | preserved |
| p12 | self-correction keeps the final intent | preserved |

`preserved` means a reader acting on the hypothesis would do the same thing.
`changed` means they would do something different, or would be missing something
they needed.

### Who wrote these labels, and who confirmed them

Two different parties, and `probes-v1.json` records both separately:

- `authoring: "research-agent"` — the spike proposed the labels. Still true, and
  the promotion did not overwrite it.
- `human_review_status: "approved"`, `human_reviewed_pair_count: 28`,
  `human_label_change_count: 0`, `human_reviewed_at: "2026-09-08"` — the project
  owner reviewed all 28 and approved them unchanged.

The review happened **outside this repository** and was transcribed here;
`approval_recorded_by` says so in as many words. Claude Code did not tick a single
box on its own authority, and tests assert the provenance still names the agent as
author, that the reviewer role is not an agent, and that the artifact and the
corpus agree on the counts.

For the whole of R0, R1 and R1.1 the rule was that the agent must not fill in the
review column. Those rounds are kept, and their figures are still labelled
*provisional accuracy against proposed labels*, because that is what they were.

**The promotion changed the corpus digest** — from `5a14302d…5b0a` to
`40715f82…b092` — which invalidated every stored result by design. All evidence
was re-acquired on real runtimes rather than having a digest rewritten. A test
asserts no evidence file still references the pre-review digest.

## The production mirrors

`scripts/lib/surfaceNormalizeMirror.mjs` and `scripts/lib/criticalInfoMirror.mjs`
re-implement two shipped evaluators so the plain-`.mjs` research scripts can run
them. Two of this spike's conclusions depend on production semantics — whether the
semantic layer should read raw or surface-normalized text, and whether a
critical-information mismatch is a usable veto — and an approximation would answer
a different question.

`mirrors.test.mjs` asserts both agree with the shipped TypeScript on every probe
and on the evaluators' own edge cases. If production changes, that test fails
rather than the research quietly becoming about code that no longer exists.

## What was touched outside this directory

Two configuration files, and nothing else:

- `vitest.config.mts` — added `research/**/*.test.mjs` to the test include, so the
  four guards run in CI with everything else.
- `eslint.config.mjs` — added `research/**/*.mjs` to the Node-globals block.

No file under `src/`, `data/` or `public/` was modified, and `package.json` gained
no dependency.

## Reproducibility, honestly

`evidence/environment.json` is written by `capture-environment.mjs`, which asks
both runtimes and records every model present — with its digest where one exists
and `null` plus a reason where none does. Every result file additionally carries
an `execution` block built by `scripts/lib/runtimeInfo.mjs`, which asks the
runtime what it is rather than assuming. **What the two runtimes can actually tell us differs, and the evidence
says so rather than smoothing it over:**

| field | Ollama (rubric) | LM Studio (embeddings) |
| --- | --- | --- |
| `provider_protocol` | `ollama-native (/api/chat)` | `openai-compatible (/v1/embeddings)` |
| `endpoint_class` | `loopback` | `loopback` |
| `runtime.version` | reported by `/api/version` | `null`, `unavailable_from_runtime` |
| `model.digest` | manifest digest from `/api/tags` | `null`, `unavailable_from_runtime` |
| `model.quantization` | from `POST /api/show` | reported by `/api/v0/models` |
| `model.revision` | `null`, `unavailable_from_runtime` | `null`, `unavailable_from_runtime` |

So: **there is no digest for the embedding model.** LM Studio's API does not
expose one, and no field in this repository invents a substitute — a placeholder
digest would be worse than an absent one, because it looks checked. Every
`null` sits next to a status string naming the reason.

Per run, `evidence/llm-rubric-results.{raw,surface}.json` records the prompt
digest, the temperature, the repeat count, the input variant, and for each
individual call a `request_sha256`, a `raw_response_sha256`, a `latency_ms` and
the two validity flags. Per pair it records both unanimity levels.

`backfill-vote-semantics.mjs` brought R1's stored files up to those semantics. It
recomputes the derived flags from the `runs[]` already in the file and Fails
Closed if the recomputation disagrees with the counts stored beside them; it
replays no request, and leaves every run entry, hash and timestamp exactly as the
run wrote them.

That is enough to say *what produced these numbers*. It is not enough to say
another machine would produce the same ones: a different quantization, a
different Ollama build or a different model would all be reasons for the same
prompt to answer differently, and on the embedding side there is not even a
digest to compare. See question 8 in the final report.
