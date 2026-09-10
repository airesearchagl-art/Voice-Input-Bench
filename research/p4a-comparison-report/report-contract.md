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
| Per tool, per Result | `result_id`, tool id/name/version, `capture.delivery_path`, `integrity_trust` |
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

A missing evaluator gets a line saying it is missing. A group whose only
evidence is rejected gets a line saying evidence exists and none of it verifies,
with the reason. Rejected entries are never filtered out to make a report look
complete, and neither are unclassified or unattributed ones. The report's
completeness state appears near the top, not buried.

## ReportSource — freeze the whole candidate set

The mistake a headline-only freeze makes is subtle and bad: a Report that
records only the Evaluation it used cannot distinguish *"there was one candidate
and it was chosen"* from *"there were four and one was chosen"*, and it cannot
prove that a group was empty rather than merely unmentioned. Worse, an
Evaluation created **after** the report would silently join the candidate set on
re-render and could change which entry looks newest.

So the freeze covers every candidate considered, not just the survivor.

```ts
interface ReportSource {
  report_contract_version: 1;

  run_id: string;
  test_id: string;
  source_sha256: string;
  audio_sha256: string;

  results: Array<{
    result_id: string;
    tool_id: SttToolId;
    transcript_sha256: string;
    integrity_trust: IntegrityTrust;

    /** One entry per evaluator in EVALUATOR_IDS order, including empty ones. */
    evaluation_groups: Array<{
      evaluator_id: EvaluatorId;

      /**
       * Every Evaluation id considered for this group at report time,
       * verified and rejected alike, evaluation_id ascending.
       *
       * Empty means the candidate set was empty — which is how `missing` stays
       * reconstructable rather than being confused with "not mentioned".
       */
      considered_evaluation_ids: string[];

      /** Which ones did not verify at report time. Subset of the above. */
      rejected_evaluation_ids: string[];

      /** Null when nothing verified, and null on conflict. */
      headline_evaluation_id: string | null;
      selection_reason: SelectionReason | null;

      /** Present only when conflicting_evidence was true. */
      conflicting_evaluation_ids?: string[];

      /** The seal of each verified candidate, so a re-render can tell it apart. */
      semantic_sha256_by_evaluation_id: Record<string, string>;
    }>;

    /** Rejected Evaluations naming this Result but no trustworthy evaluator. */
    unclassified_rejected_evaluation_ids: string[];
  }>;

  /** Rejected Results whose tool could not be trusted. */
  unattributed_result_ids: string[];

  /** Rejected Evaluations naming no Result. */
  unattributed_rejected_evaluation_ids: string[];

  /** Named so a re-render can tell whether it is reproducing the same view. */
  ordering: OrderingRules;

  /** What was already incomplete when the report was made. */
  completeness: RunCompleteness;
}
```

**No verification verdicts are frozen.** `rejected_evaluation_ids` records what
did not verify *at report time* as historical context; it is not consulted on
re-render, which re-verifies everything itself.

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

### What a re-render does

1. Read `ReportSource`.
2. Load **exactly** the ids it names — nothing else, ever.
3. Re-verify each one with the current verifier.
4. Re-derive headline selection from what verifies now, under the frozen
   ordering rules.
5. State any cited evidence that no longer verifies.

Step 2 is what isolates an old report from new evidence. An Evaluation created
after the report is not in `considered_evaluation_ids`, so it cannot enter the
re-render, cannot become the new "newest verified", and cannot silently change
what the report says.

Step 3 is what keeps the report honest. Verification status is a property of the
current verifier, not of the artifact — five v2 artifacts and five v3 artifacts
changed outcome inside a week with no byte modified — so a re-render reports
today's outcome rather than repeating a stored one.

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
