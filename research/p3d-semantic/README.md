# P3-D-A — Semantic Evaluation Architecture Spike

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
The short version: **no method measured here can be trusted to say "preserved"
unattended**, and the schema question should not be settled until the method is.

## Layout

```
probes-v1.json                    28 frozen probe pairs with human-authored gold labels
probes-v1.sha256                  the digest every run records
prompts/semantic-rubric-v1.md     the frozen rubric prompt
prompts/semantic-rubric-v1.sha256 its digest
scripts/verify-probes.mjs         check the corpus before trusting any result
scripts/run-embedding.mjs         method A — local embedding cosine
scripts/run-llm-rubric.mjs        method B — local LLM rubric, 3 runs per pair
scripts/analyze-results.mjs       score all three methods, including the hybrid
scripts/lib/                      loopback guard, corpus loader, production mirrors
evidence/                         every result file, with the conditions that produced it
```

## Running it

```
node research/p3d-semantic/scripts/verify-probes.mjs
node research/p3d-semantic/scripts/run-embedding.mjs
node research/p3d-semantic/scripts/run-llm-rubric.mjs
node research/p3d-semantic/scripts/analyze-results.mjs
```

Defaults are the two runtimes that were present on the machine this spike ran on:
Ollama at `127.0.0.1:11434` for the rubric and LM Studio at `127.0.0.1:1234` for
embeddings. Both are overridable with `--endpoint`, `--model` and `--api`.

**No model is downloaded.** If the named embedding model is not already installed,
`run-embedding.mjs` writes `evidence/embedding-unavailable.json` with status
`UNAVAILABLE_ON_CURRENT_MACHINE` and exits — it does not fetch anything, and the
result is reported as PARTIAL rather than filled in.

## The four guards

These are not conventions, they are tests. `npm.cmd test` runs them alongside the
production suite (`scripts/lib/researchGuards.test.mjs`,
`scripts/lib/mirrors.test.mjs`).

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

**3. No model sees the answer.** `probes-v1.json` carries a human-authored gold
label for every pair, and those labels are what all three methods are being scored
against. `modelInputFor()` builds a fresh object containing only the two texts and
the id — by construction, not by deletion, so a field added to a probe later
cannot leak by being forgotten. A test renders the actual rubric prompt for every
probe and asserts it contains neither the gold label nor the authoring note.

**4. A malformed reply is not a data point.** `parseVerdict()` is tolerant about
packaging — a code fence or a leading sentence is a formatting habit — and strict
about content. A missing field, a wrong type, a truncated object or an empty
response is recorded as `invalid` and counted. It is never coerced: `"true"` is
not `true`, because coercing it would turn a model that could not follow the
format into a model that said the transcript was fine.

## The corpus

28 pairs: 13 `preserved`, 15 `changed`, 13 of them hard negatives — pairs that are
nearly identical as text and opposite in meaning.

All eight required hard cases are present and checked by `verify-probes.mjs`:

| probe | pair | gold |
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

`evidence/environment.json` records the machine, both runtimes and the digest of
every model present. `evidence/llm-rubric-results.json` records the model, the
prompt digest, the temperature, the repeat count and every individual run.

That is enough to say *what produced these numbers*. It is not enough to say
another machine would produce the same ones: a different quantization, a different
Ollama build or a different model would all be reasons for the same prompt to
answer differently, and none of them are pinned by anything in this repository.
See question 8 in the final report.
