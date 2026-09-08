# Evaluation Envelope Architecture — P3-D-A Final

**Design study. No schema v4 is implemented here, and nothing in `src/` changes.**

> Final round. The corpus labels are human-reviewed (28/28 approved, 0 changes,
> 2026-09-08) and every measurement referenced below was re-acquired against the
> promoted corpus. The recommendation did not change; one new argument for it is
> recorded at the end.

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
execution      : { provider_protocol, endpoint_class,
                     runtime { name, version, version_status },
                     model { id, digest, digest_status, quantization, revision },
                     prompt_sha256, params, repeats,
                     runs[ { request_sha256, response_sha256,
                             parseable_schema_valid,
                             exact_output_contract_valid, latency_ms } ],
                     agreement { valid_vote_unanimous, full_run_unanimous } }
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
- R1 showed what such a block has to tolerate: **some of its fields will be
  `null`**. Ollama reports a version and a manifest digest; LM Studio reports
  neither. An envelope that *requires* a digest would either lock out a runtime
  that cannot supply one or invite a placeholder — and a placeholder digest is
  worse than an absent one, because it looks checked. Every such field needs a
  companion status string saying why it is missing. That is a shape decision an
  envelope is better placed to make once than four schemas are to make four times.
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

R1 sharpened the problem rather than changing its shape. Four findings bear on it:

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
3. **The input variant is part of the measurement.** The same model, the same
   prompt and the same parameters produced one false preserved on raw input and
   none on surface-normalized input. An artifact that does not record which text
   the model was shown records a number nobody can interpret —
   `evidence.derived[]` is exactly where that belongs.
4. **Two compliance levels, not one.** R1 separated `parseable_schema_valid`
   (96.4–100%) from `exact_output_contract_valid` (86.9–92.9%). A single "valid"
   flag hid the fact that roughly one reply in eight did not follow the format it
   was asked for. Whatever schema arrives needs both, recorded per run.
5. **Agreement across repeats is also two fields, and only one may be trusted.**
   R1.1 found that a single `unanimous` flag computed over the replies that
   parsed reported three of twenty-eight raw pairs as unanimous when one of their
   three runs produced no verdict at all. The envelope needs
   `valid_vote_unanimous` and `full_run_unanimous` side by side, and the record
   of which one an automated outcome rested on — an artifact that says
   `changed` without saying what agreement that rested on cannot be audited
   after the fact.
6. **A derived summary must be recomputable from what sits beside it.** R1.1
   corrected both faults without replaying a single request, because `runs[]`
   held enough to re-derive every summary field. That is only true by accident
   today; an envelope should make it a property. Summary fields that cannot be
   re-derived from the stored runs are fields that go stale silently when the
   scoring is corrected.

The second point is the real architectural break. Every schema so far has been
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

## R1 re-evaluation of the earlier recommendation

Both standing recommendations survive the new evidence, and one of them is now
better supported than it was.

- **v1/v2/v3 stay unmigrated and read-only.** Unchanged. R1 strengthens the
  reason: a semantic artifact needs an `execution` block whose fields are
  sometimes `null` with a status string, two separate validity flags per run,
  and — after R1.1 — two separate agreement flags per pair. None of that has any
  meaning for a character distance, and housing them together would put
  unfillable fields on three schemas that are currently complete.
- **Freezing the envelope stays deferred.** Also unchanged, and now for a
  measured reason rather than a suspected one. R1 showed the method is still
  moving in ways that change the artifact: the input variant turned out to
  decide whether the rubric produces a false preserved at all, and the choice
  between H1 and H3 changes whether `preserved` is a value the schema can even
  carry automatically. An envelope designed before that choice would be
  designed for the wrong output.

## Final answer on the envelope question

**G. Generic Evaluation Envelope v4: defer.** Unchanged across four rounds, and
the final evidence gives the clearest reason yet.

The envelope's shape depends on what a semantic evaluator outputs, and that is
still an open decision rather than an open question. On the final evidence H1 and
H3 are both viable and they need **different artifacts**: H1 emits
`preserved | changed | review` and needs somewhere to record that an automatic
`preserved` rested on three agreeing runs and a concurring embedding; H3 never
emits `preserved` at all, and an artifact for it does not need that field —
carrying it would invite a later reader to fill it in.

That is not a shape that can be frozen before someone picks the rule. Freezing it
now would mean designing an envelope for the union of two rules, which is how a
schema ends up with fields that are optional because nobody could decide.

**What to build when the rule is picked**, unchanged from R1: Option B's
`execution` block and `evidence.derived[]`, with Option A's explicit, written-out
canonical serializers per evaluator. And **v1/v2/v3 stay read-only and
unmigrated** — they are exactly recomputable, which a semantic artifact will never
be, and that difference is a reason to keep them apart rather than a wrinkle to
smooth over.

## R1.1 — what a scoring correction says about schema design

R1.1 changed no model output and no conclusion about which method to use. It
changed two derived measurements, and both had been reporting a tri-state more
favourably than the evidence supported: hard-negative recall was divided by the
pairs a rule chose to answer rather than by the corpus, and agreement was computed
over the replies that happened to parse.

The architectural point is what it took to fix them: **nothing but the stored
runs**. No request was replayed, no hash changed, and the corrected numbers are
derivable from files written before the fault was known. A schema that stores only
a verdict and a rolled-up metric would have needed a full re-run — on a model that
may no longer be installed at the same digest — to answer the same question.

That is an argument for the `execution` block carrying its `runs[]` in full, and
against treating a summary field as the record. It also suggests the envelope
should distinguish, explicitly, between fields the artifact **stores** and fields
it **derives**: R1's `unanimous` was a derived field that outlived the definition
it was derived under, and nothing in the file said so.

## Final round — what the Human Gold promotion added

The promotion changed the corpus digest, which invalidated every stored result by
design, which forced a full re-acquisition. That is the integrity model working:
**a corpus edit cannot silently leave old numbers looking current.**

It also surfaced a smaller design point with a direct bearing on the envelope. The
corpus now records two separate facts — `authoring: research-agent` and
`human_review_status: approved` — and how an accuracy figure may be *described*
is derived from the second (`scripts/lib/goldStatus.mjs`) rather than written into
each document by hand. Before the promotion every figure had to say "provisional";
after it, the same code says "human-reviewed", and no file needed editing to make
that true.

An evaluation artifact has the same problem one level up. A verdict's standing
depends on things outside the verdict — which corpus, reviewed by whom, when — and
if that standing is written into the artifact as prose it goes stale the moment the
answer changes. **The envelope should carry the provenance and derive the claim,
not store the claim.**

Finally, the re-acquisition produced a repeatability result the earlier rounds
could not: two runs of the same model, prompt and temperature, three days apart,
agreed on every label and differed on compliance — 96.4% vs 100% parseable on raw
input. A schema that stores only the verdict cannot express that difference, and a
bench that cannot express it will eventually quote one run as if it were the
method.
