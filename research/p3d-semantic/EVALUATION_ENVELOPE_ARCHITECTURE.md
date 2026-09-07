# Evaluation Envelope Architecture — P3-D-A

**Design study. No schema v4 is implemented here, and nothing in `src/` changes.**

The question: when a fourth evaluator arrives, does it get a fourth per-evaluator
schema, or does it get a generic envelope that later evaluators share?

## Where the three schemas stand today

| schema | evaluator | what it stores beyond the common part | recomputed on read |
| --- | --- | --- | --- |
| v1 | `raw-char-v1` | `metrics` (S/D/I, CER) | metrics |
| v2 | `critical-info-v1` | `entities`, `matches`, `missing`, `extra`, `metrics` | entities, matches, leftovers, metrics |
| v3 | `surface-normalized-char-v1` | `normalized` (hashes + lengths), `metrics` | normalization, metrics |

They already share more than they differ:

```
schema_version   evaluation_id   created_at   evaluator
run_id           result_id       subject      reference
hypothesis       run_evidence    integrity
```

Eleven common fields; the divergence is one to four evaluator-specific blocks and
a `metrics` object whose shape differs.

## Option A — a fourth per-evaluator schema

Semantic gets `schema_version: 4` with its own payload, its own canonical
serializer, its own verifier, and its own entry in the readback dispatch.

**In favour**

- Every field is typed for exactly one evaluator. `metrics.cer` cannot appear on
  a semantic artifact and `metrics.preservation_rate` cannot appear on a
  character one, because the types do not permit it.
- The canonical serializer is a literal, explicit property order. That is what
  makes reformatting invisible to the seal and meaning changes visible, and it is
  easy to review because it is written out.
- The verifier recomputes *this* evaluator's working. v2 checks entities and
  matches, v3 checks a normalization — neither of those has a generic shape.
- The pattern is proven three times over, including through two review rounds
  that tightened it.

**Against**

- Real duplication. The subject / reference / hypothesis / run_evidence blocks are
  written out four times in four canonical serializers, and the subject checks are
  written out four times in four verifiers. A fifth evaluator makes it five.
- Every new evaluator touches the dispatch in `createEvaluation.ts` and the
  `StoredEvaluation` union — small edits, but edits to shared production code for
  something that should be additive.

## Option B — generic envelope v4, for future evaluators only

v1, v2 and v3 stay exactly as they are and keep their own verifiers. From v4
onwards, artifacts share one envelope:

```
schema_version : 4
evaluation_id  : string
created_at     : ISO-8601
evaluator      : { id, ...versioned sub-contracts }     ← evaluator-defined, sealed
subject        : { result_schema_version, tool, capture, result_semantic_sha256 }
evidence       : { reference, hypothesis, derived[] }   ← hashes and lengths only
execution      : { runtime, model, prompt_sha256, params, repeats, latency_ms }
output         : { verdict, metrics, working }          ← evaluator-defined, sealed
integrity      : { algorithm, semantic_sha256 }
```

**In favour**

- The eleven common fields are defined and serialized once. Four verifiers stop
  repeating the same fourteen subject checks.
- `execution` is the block none of v1–v3 has and every model-based evaluator needs:
  which runtime, which model digest, which prompt digest, which temperature, how
  many repeats. A semantic verdict without that is not reproducible, and bolting
  it onto a per-evaluator schema means inventing it per evaluator.
- `evidence.derived[]` generalises what v3 does with `normalized`: any evaluator
  that transforms its input before comparing records what it produced, by hash.
- Adding an evaluator becomes registering one, rather than editing a union and a
  dispatch.

**Against**

- The seal needs a canonical serializer for `evaluator`, `output` and `working`
  whose shapes are evaluator-defined. Either every evaluator supplies its own
  canonical function for its own blocks — which is most of Option A's code back
  again, one level down — or the envelope sorts keys generically, which is a
  weaker guarantee than a written-out property order and much harder to review.
- Typed access gets worse before it gets better. `output.metrics` becomes a union
  the UI has to narrow, which is what `schema_version` does today for free.
- It is a shape designed against one known future evaluator. P3-D-A has just
  demonstrated that the semantic method is *not* settled — a tri-state, a review
  outcome and possibly a fourth signal are all still open. Freezing an envelope
  around it now would be designing for a thing that does not exist yet.

## What this spike learned that bears on the choice

Two findings from the method comparison change the shape of the problem:

1. **A semantic evaluator's output is not one label.** The hybrid needs
   `preserved | changed | review`, and `review` is not a metric — it is a state
   that means a person still has to act. No existing schema has a place for an
   outcome that is deliberately not a measurement.
2. **Reproducibility now depends on things outside the artifact.** v1–v3 can be
   recomputed exactly from `source.txt` and `transcript.txt`. A model verdict
   cannot: it depends on a model digest, a prompt digest, a temperature, a
   runtime version and, at three runs per pair, on which runs happened to agree.
   The strongest guarantee available is *"this verdict was produced by this model
   with this prompt, and here is the vote record"* — which is an `execution`
   block plus a stored `working`, not a recomputation.

That second point is the real architectural break. Every schema so far has been
verifiable by re-deriving it. A semantic schema cannot be, and pretending
otherwise by giving it the same shape as v1–v3 would misrepresent what it
guarantees.

## Recommendation

**Neither, yet — and the sequencing matters more than the choice.**

- Do **not** implement schema v4 in P3-D-B's first step. The output shape is still
  moving; a tri-state with a `review` outcome and an `execution` block is a
  different artifact from anything shipped, and it should be designed against a
  method that has been decided.
- When it is designed, take **Option B's `execution` and `evidence.derived`
  ideas** and **Option A's explicit canonical serializers**. They are not in
  conflict: a shared envelope can require each evaluator to supply a written-out
  canonical function for its own blocks. That keeps the seal reviewable and stops
  the fourth copy of the subject checks.
- Keep v1, v2 and v3 **read-only and unmigrated** either way. They are correct,
  they are sealed, and they are recomputable — three properties a semantic
  artifact will not have, which is itself a reason not to house them together.

The one thing this spike would change today if it changed anything: the next
schema needs a field for *"this verdict is not automatic"*. Every method measured
here needs somewhere to say that, and none of v1–v3 has one.
