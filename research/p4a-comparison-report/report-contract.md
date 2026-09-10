# Report contract

A Report is the citable form of a comparison. It is derived only from stored,
readback-verified evidence.

**The report never calls the model.** `semantic-h3-v1` values are read from
stored v4 artifacts, whose readback re-derives the parse, the vote and the H3
decision from stored bytes without contacting Ollama. Report generation performs
no inference of any kind.

## Recommended shape: deterministic JSON + rendered Markdown

Option C from `architecture-options.md`.

```text
ReportSource   (JSON)      the frozen evidence selection — identities + hashes
report.md      (Markdown)  the rendered document
```

Both are stored. The JSON is what makes the Markdown re-derivable; the Markdown
is what a person reads. Markdown alone would be a document nobody can check, and
JSON alone would be a document nobody reads.

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
| Evidence citation | every `evaluation_id` used, and its `selection_reason` |
| Gaps | missing evaluators, rejected evidence, unattributed rejected entries |
| Contract metadata | `report_contract_version`, ordering rule ids |

### The four layers stay four layers

The report has one section per evaluator, in `EVALUATOR_IDS` order — Raw,
Surface, Critical, Semantic. There is no summary row that combines them, no
overall figure, and no ordering of tools by preference.

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
complete. The report's completeness state appears near the top, not buried.

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

### Re-rendering

A re-render:

1. loads the exact ids in `ReportSource`;
2. re-verifies each one now;
3. renders from what verifies now;
4. states explicitly any cited evidence that no longer verifies.

It never reuses a stored verdict. If a verifier has been hardened since the
report was written — which happened twice this month — the re-render shows the
new outcome. The frozen part is *which evidence was cited*; the live part is
*whether that evidence still holds*.

### What a report claims

> These exact artifacts, identified by these ids and hashes, were selected under
> these ordering and selection rules; here is what they said when this document
> was rendered.

It does not claim that the artifacts will verify forever, and for `semantic-h3-v1`
it does not claim the model would return the same verdict again — the v4 schema
itself is explicit that its claim is historical execution evidence plus a
deterministically verified derivation.

## Open question for the Human Gate

Whether a Report should be an immutable stored artifact under a fifth root, or a
file the operator exports, is deliberately left open. The recommendation only
requires that the *selection* be frozen and re-verifiable. P4-C should decide
storage after P4-B has shown what the derived model actually looks like in use.
