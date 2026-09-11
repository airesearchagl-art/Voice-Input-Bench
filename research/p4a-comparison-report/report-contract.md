# Report contract

A Report is the citable form of a comparison. It is derived only from stored,
readback-verified evidence.

**The report never calls the model.** `semantic-h3-v1` values are read from
stored v4 artifacts, whose readback re-derives the parse, the vote and the H3
decision from stored bytes without contacting Ollama. Report generation performs
no inference of any kind.

## The package

A Report is two artifacts that only make sense together:

```text
ReportSource   (JSON)      the frozen evidence selection — identities + hashes
report.md      (Markdown)  the rendered document
```

The JSON is what makes the Markdown re-derivable; the Markdown is what a person
reads. Markdown alone would be a document nobody can check, and JSON alone would
be a document nobody reads.

**Where the package lives is not decided here.** Whether it becomes an
app-managed immutable artifact under a fifth storage root, or files the operator
exports and keeps, is deferred to P4-C — that decision needs P4-B to exist first,
so it can be made against a model in use rather than a sketch. Everything in this
document holds either way: what P4-A fixes is the *contract*, not the storage.

## Content

### Always present

| section | source |
|---|---|
| Run identity | `run_id`, and `test_id` read from `manifest.json` |
| Canonical evidence | `manifest_schema_version` (from the manifest), `source_sha256`, `audio_sha256` |
| Per tool, per Result | `result_id`, tool identity, per-Result `tool.version`, `capture.delivery_path` |
| Unsealed Results | listed at Run level, tool shown as an unverified claim |
| Transcript | from the verified Result |
| Raw | `exact_match`, `cer`, edit distance, substitutions/deletions/insertions |
| Surface | same metric shape, plus normalized hashes and lengths |
| Critical | `exact_entity_multiset_match`, `preservation_rate`, matched/missing/extra, canonical keys of missing and extra |
| Semantic | `decision`, `decision_by`, critical guard state, run validity summary, model/runtime/prompt identity |
| Evidence citation | every `evaluation_id` considered, which was used, and why |
| Gaps | missing evaluators, rejected evidence, unclassified and unattributed entries |
| Contract metadata | `report_contract_version`, ordering rule ids |

### The four layers stay four layers

One section per evaluator, in `EVALUATOR_IDS` order — Raw, Surface, Critical,
Semantic. No summary row combining them, no overall figure, no ordering of tools
by preference.

Factual cross-tool statements are allowed where they are observations rather
than judgements — that two tools produced identical normalized transcripts, or
that one has a Critical mismatch and the other does not. "Tool A is better" is
not such a statement and does not appear.

### Semantic rendering rules

- `changed` renders as **CHANGED**.
- `review` renders as **REVIEW REQUIRED**.
- The words `PRESERVED`, `SAFE` and `PASS` never appear as a Semantic verdict.
- A veto-path Evaluation is rendered with its route stated: the guard decided,
  the model was not called, and `runs_recorded` is 0. A report that showed
  CHANGED next to "0 runs" without saying why would read like missing data.
- The p12-style self-correction Known Limitation is carried as a note wherever a
  `critical-guard-veto-v1` decision appears.

### Gaps are content, not omissions

A missing evaluator gets a line saying it is missing — meaning no *verified*
evidence for it exists.

A Result carrying rejected Evaluations gets a line saying so at Result level,
with each one's reason. It is deliberately not phrased per evaluator: a rejected
Evaluation carries no trustworthy evaluator id, so "surface failed" is a claim
the evidence cannot support, while "this Result has an unusable Evaluation" is
one it can.

Rejected entries are never filtered out to make a report look complete, and
neither are unclassified, unattributed or legacy ones. The report's completeness
state appears near the top, not buried.

## ReportSource — freeze the candidate set *and* the exact bytes

Two different things can change under a report after it is written, and a report
that cannot tell them apart is not auditable:

```text
same bytes, new verifier    a verifier was hardened; the evidence is untouched
same id, different bytes    the artifact itself is not what the report read
```

Freezing ids alone catches neither. Freezing verdicts catches the wrong one. So
`ReportSource` freezes **identity plus content hash** for every artifact it
read, including artifacts that have no valid seal of their own.

A headline-only freeze is also insufficient for a second reason: it cannot
distinguish "one candidate, chosen" from "four candidates, one chosen", cannot
prove a group was empty rather than unmentioned, and lets an Evaluation created
*after* the report join the candidate set on re-render and become the new newest.

```ts
interface ReportSource {
  report_contract_version: 1;

  run_id: string;

  /**
   * The Run's evidence, with the manifest's own bytes included.
   *
   * `test_id` and `manifest_schema_version` are read out of `manifest.json`,
   * and `verifyRunEvidence` does not hash that file — it re-hashes source,
   * audio and provider-query *against the SHAs the manifest records*
   * (`runEvidence.ts:206-215`). So the manifest is the source of all three
   * recorded hashes and is itself unprotected: an edited manifest can move a
   * recorded hash and the file beside it together, and the check still passes.
   *
   * Freezing `manifest_file_sha256` is what closes that. It is not only about
   * `test_id` — it is about the integrity of the basis the whole comparison
   * is stated against.
   */
  run_evidence: {
    manifest_schema_version: number;
    test_id: string;
    /** Byte SHA-256 of manifest.json itself. Nothing in production seals it. */
    manifest_file_sha256: string;
    source_sha256: string;
    audio_sha256: string;
  };

  /** Sealed Results placed in a tool group. Discriminated, like the view. */
  results: ReportResultSource[];

  /** Unsealed Results, both readback outcomes. */
  legacy_results: ReportLegacyResultSource[];

  /** Rejected Results whose tool identity did not survive. */
  unattributed_results: Array<{
    result_id: string;
    reason_class: 'no-seal' | 'tool-identity-unverified' | 'custom-tool-identity-unavailable';
    related_verified_evaluation_ids: string[];
    related_rejected_evaluation_ids: string[];
  }>;

  /** Rejected Evaluations naming no Result. */
  unattributed_rejected_evaluation_ids: string[];

  /** Byte identity for every artifact read, of every kind. See below. */
  artifact_content: {
    results: Record<string, { file_sha256: string }>;
    evaluations: Record<string, {
      file_sha256: string;
      /** Present only when the Evaluation verified at report time. */
      semantic_sha256?: string;
    }>;
  };

  ordering: OrderingRules;
  completeness: RunCompleteness;
}

type ReportResultSource =
  | ReportVerifiedResultSource
  | ReportRejectedResultSource;

interface ReportVerifiedResultSource {
  kind: 'verified';
  result_id: string;
  tool: ToolIdentity;
  /** Trusted, and `null` here means the Result genuinely supplied no version. */
  tool_version: string | null;

  result_file_sha256: string;
  result_semantic_sha256: string;
  transcript_sha256: string;

  evaluation_groups: Array<{
    evaluator_id: EvaluatorId;
    /**
     * Every verified Evaluation considered for this group at report time,
     * evaluation_id ascending. Empty means the candidate set was empty —
     * which is how `missing` stays reconstructable rather than being
     * indistinguishable from "not mentioned".
     */
    considered_evaluation_ids: string[];
    headline_evaluation_id: string | null;
    selection_reason: SelectionReason | null;
    conflicting_evaluation_ids?: string[];
  }>;

  unclassified_rejected_evaluation_ids: string[];
}

/**
 * Rejected, tool identity survived.
 *
 * No `tool_version`, no `capture`, no `transcript_sha256` — not as `null`, but
 * absent from the type. `null` would mean "this Result supplied no version",
 * and that is a different statement from "no version can be trusted here".
 * Built-in ids only, for the reason given in `comparison-contract.md`.
 */
interface ReportRejectedResultSource {
  kind: 'rejected';
  result_id: string;
  trusted_tool_id: 'windows-standard-voice-input' | 'aqua-voice';
  result_file_sha256: string;
  /** Historical context only; never consulted on re-render. */
  reason_at_report_time: string;

  verified_evaluation_ids: string[];
  unclassified_rejected_evaluation_ids: string[];
}

type ReportLegacyResultSource =
  | {
      kind: 'legacy-unsealed-verified';
      result_id: string;
      result_file_sha256: string;
      transcript_sha256: string;
      claimed_tool_id: SttToolId;
      tool_claim_is_unverified: true;
      verified_evaluation_ids: string[];
      unclassified_rejected_evaluation_ids: string[];
    }
  | {
      kind: 'legacy-unsealed-rejected';
      result_id: string;
      result_file_sha256: string;
      reason_at_report_time: string;
      verified_evaluation_ids: string[];
      unclassified_rejected_evaluation_ids: string[];
    };
```

### `null` is never made to mean two things

The previous draft had one `results[]` shape with `result_status` and
`tool_version: string | null` on both branches. That forces `null` to carry two
incompatible readings — *the Result supplied no version* and *no version can be
trusted for this Result* — and a reader cannot tell which one they are looking
at. The union removes the field entirely where it cannot be trusted, so the
distinction is structural rather than a convention in a comment.

### Every Evaluation is named exactly once

A re-render must be able to reconstruct which container an Evaluation belonged
to without scanning the artifact tree. So the id sets above partition the
Evaluations the report saw:

```text
verified, in a group        results[].evaluation_groups[].considered_evaluation_ids
verified, on a rejected or legacy Result
                            *.verified_evaluation_ids
verified, on an unattributed Result
                            unattributed_results[].related_verified_evaluation_ids
rejected, Result known      *.unclassified_rejected_evaluation_ids
rejected, on an unattributed Result
                            unattributed_results[].related_rejected_evaluation_ids
rejected, no Result         unattributed_rejected_evaluation_ids
```

Every id in any of those sets has an entry in `artifact_content.evaluations`,
and every `result_id` has one in `artifact_content.results`. Legacy, rejected
and unattributed artifacts included — especially those, since they are the ones
with no seal to fall back on.

An id appearing in two containers, or in none, is a malformed `ReportSource`.

### Re-render, in order

```text
 1. read ReportSource
 2. load EXACTLY the ids it names — nothing else, ever

    --- the Run, before anything derived from it ---
 3. hash manifest.json   -> compare with frozen manifest_file_sha256
 4. hash source.txt      -> compare with frozen source_sha256
 5. hash audio.wav       -> compare with frozen audio_sha256
        any mismatch -> evidence_changed; the comparison basis moved, so
                        nothing downstream is reported as still holding

    --- Results and Evaluations ---
 6. hash each artifact file -> compare against artifact_content
        mismatch -> evidence_changed, and stop treating it as cited evidence
 7. for a verified Result, hash the actual transcript.txt bytes and compare
    against the frozen transcript_sha256
        mismatch -> evidence_changed

    --- only once byte identity holds ---
 8. run the CURRENT verifyRunEvidence(), then the current artifact verifiers
 9. re-derive headline selection under the frozen ordering rules
10. report any change in verification outcome as a verification change,
    distinct from evidence_changed
```

Steps 3-5 come first because every Result and Evaluation in the report is a
statement *about this Run*. If the canonical source or audio moved, a Result's
metrics are no longer measurements of the thing the report says they measured,
and re-verifying them would produce numbers that look fine and mean something
else.

Step 4 exists because the transcript lives in its own file. `result.json` can
hash identically while `transcript.txt` beside it has changed, and the Result
seal covers `transcript.sha256` rather than the transcript bytes
(`resultSchema.ts:79-82`). Without this step an edited transcript would surface
at step 5 as "the verifier now rejects this Result", which reads as a tooling
change when the evidence is what moved.

Step 2 is what isolates an old report from new evidence: an Evaluation created
after the report is in none of the frozen id sets, so it cannot join the
re-render, cannot enter a container, and cannot become the new newest.

Step 5 is what keeps the report honest. Verification status is a property of the
current verifier, not of the artifact — five v2 artifacts and five v3 artifacts
changed outcome inside a week with no byte modified — so a re-render reports
today's outcome rather than repeating a stored one.

### Run evidence identity

The report **does** read `manifest.json`: `test_id` and
`manifest_schema_version` come from it, and they appear in the "Always present"
table above. An earlier draft of this document said otherwise, and that was
wrong.

What production verifies, precisely (`runEvidence.ts:206-215`):

```text
source.txt          re-hashed and compared against manifest.source.sha256
audio.wav           re-hashed and compared against manifest.audio.sha256
provider-query.json re-hashed and compared against manifest.provider_query.sha256
manifest.json       NOT hashed by anything
```

So the manifest holds every recorded hash and is itself unsealed. Freezing
`manifest_file_sha256` in `ReportSource` is what separates *"the same bytes,
judged by a hardened verifier"* from *"the manifest this report was written
against is not the manifest on disk"*.

**`provider-query.json`** needs no additional frozen hash today: the report does
not quote its contents, and the manifest already records its SHA, which the
manifest hash now covers transitively. That changes the moment a report renders
a voice name, a TTS setting or anything else read from it — at that point the
value needs its own frozen content identity, for exactly the reason above. The
same applies to `segmentation` and `voice`, which `verifyRunEvidence` returns
but the report does not currently print.

This is a rule for when it happens, not an instruction to add hashes now.

### Conflict is never resolved by recency

When verified entries in a group disagree — reachable only for `semantic-h3-v1`,
whose Evaluations are historical model executions rather than recomputations:

```text
headline_evaluation_id     = null
selection_reason           = 'conflict-no-headline-v1'
conflicting_evaluation_ids = every verified id in the group
```

The report shows the conflict and every conflicting Evaluation id. It does not
print the newest one as the verdict, does not take a majority across
Evaluations, and does not prefer whichever answer is friendlier. A report that
resolved a `changed` / `review` disagreement by picking one would be asserting
something no evaluator concluded.

## Reproducibility and identity

### Content identity is separate from presentation

`generated_at` makes bytes change on every render, so it must not participate in
content identity.

```text
content_sha256   = sha256(canonical JSON of ReportSource + rendered body)
                   — excludes generated_at and any rendering timestamp
generated_at     = presentation metadata only, printed in a footer
```

Two renders of the same selection against unchanged evidence produce the same
`content_sha256` and differ only in the footer. That is the property that makes
"is this the same report?" answerable.

### What a report claims

> These exact artifacts, identified by these ids and hashes, were the candidates
> considered under these ordering and selection rules; here is what they said
> when this document was rendered.

It does not claim the artifacts will verify forever, and for `semantic-h3-v1` it
does not claim the model would return the same verdict again — the v4 schema
itself is explicit that its claim is historical execution evidence plus a
deterministically verified derivation.
