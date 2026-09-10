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
| Run identity | `run_id`, `test_id` |
| Canonical evidence | `source_sha256`, `audio_sha256`, `manifest_schema_version` |
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
  test_id: string;
  source_sha256: string;
  audio_sha256: string;

  /** Sealed Results placed in a tool group, verified or attributably rejected. */
  results: Array<{
    result_id: string;
    tool: ToolIdentity;
    tool_version: string | null;
    result_status: 'verified' | 'rejected';

    /** Content identity, independent of any seal. */
    result_file_sha256: string;

    /** Present only for a verified Result; a rejected one vouches for neither. */
    result_semantic_sha256?: string;
    transcript_sha256?: string;

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

    /** Named, not attributed. No evaluator is inferred for these. */
    unclassified_rejected_evaluation_ids: string[];
  }>;

  legacy_unsealed_result_ids: string[];
  unattributed_result_ids: string[];
  unattributed_rejected_evaluation_ids: string[];

  /**
   * Content identity for every artifact this report read, of any kind.
   *
   * Byte SHA-256 of the file as stored — `result.json` or `evaluation.json` —
   * so an artifact with no valid semantic seal still has a frozen identity.
   * This is the map a re-render compares against before it verifies anything.
   */
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
```

Every id that appears anywhere else in `ReportSource` has an entry in
`artifact_content`. Legacy, rejected and unattributed artifacts included —
especially those, since they are the ones with no seal to fall back on.

### Re-render, in order

```text
1. read ReportSource
2. load EXACTLY the ids it names — nothing else, ever
3. hash each file and compare against artifact_content
       mismatch -> evidence_changed
                   report it as such and stop treating it as the cited evidence
       match    -> continue
4. re-verify each matching artifact with the CURRENT verifier
5. re-derive headline selection under the frozen ordering rules
6. report any change in verification outcome as a verification change,
   distinct from evidence_changed
```

Step 2 is what isolates an old report from new evidence: an Evaluation created
after the report is not in `considered_evaluation_ids`, so it cannot join the
re-render or become the new newest.

Step 3 is the fix this revision adds. Without it, an artifact edited in place
under a stable id would surface as "the verifier now rejects this", implying a
tooling change when the real event was that the evidence moved. Those are
different findings and an operator acts differently on each.

Step 4 is what keeps the report honest. Verification status is a property of the
current verifier, not of the artifact — five v2 artifacts and five v3 artifacts
changed outcome inside a week with no byte modified — so a re-render reports
today's outcome rather than repeating a stored one.

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
