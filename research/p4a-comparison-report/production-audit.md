# Production audit — what current `main` actually guarantees

Read against `main@8273d1aad2a981754710661f6a905b61e2eaf6d8`. Every claim below
is cited. Where a previous PR description disagrees with the code, the code wins.

## 1. Run — the canonical condition

A Run bundle is four files, written to a temp directory and committed by
`rename`, with `manifest.json` written last so an incomplete bundle is visibly
incomplete (`src/storage/LocalRunStore.ts:13-19`, `:147-152`).

```text
data/runs/<run-id>/
  source.txt
  audio.wav
  provider-query.json
  manifest.json
```

`RunManifestV2` (`src/benchmark/manifest.ts:15-97`) records `test_id`,
`generated_at`, `source{sha256,...}`, `provider`, `model`, `voice`, `settings`,
`segmentation`, `provider_query{sha256}`, `audio{sha256,bytes}` and
`reproducibility{canonical_artifact: true, bit_exact_regeneration_expected:
false}`.

Immutability: `RUN_ALREADY_EXISTS` on any existing directory
(`LocalRunStore.ts:135-140`). There is no update and no delete method.

**Consequence for comparison.** One Run pins the source text, the WAV, their
hashes, and the TTS conditions that produced them. Two Results under one Run are
transcripts of the same bytes. That is the strongest same-condition boundary the
system has.

## 2. Result — one tool's observation

`ResultPayloadV2` (`src/results/resultSchema.ts:38-74`): `schema_version`,
`result_id`, `run_id`, `captured_at`, `tool{id,name,version}`,
`capture{method,delivery_path}`, `run_evidence{manifest_schema_version, test_id,
source_sha256, audio_sha256}`, `transcript{file,encoding,line_endings,sha256,bytes}`.

- The seal covers that payload in fixed order (`resultSchema.ts:121-150`). The
  transcript *bytes* are not in the hash; `transcript.sha256` and
  `transcript.bytes` are, and they are checked separately (`resultSchema.ts:79-82`).
- `sealed` means `schema_version === 2` (`resultSchema.ts:110-112`).
- Legacy v1 Results have no `integrity` at all (`resultSchema.ts:94-96`) and are
  `legacy-unsealed` (`resultSchema.ts:108`). They are not migrated.
- Write-once: `RESULT_ALREADY_EXISTS` (`LocalResultStore.ts:137-142`).

**Many Results per Run, and many per (Run, tool).** `listResultsForRun` filters
`stored.run_id === runId` with no uniqueness constraint
(`src/results/saveResult.ts:229-241`), and `saveManualSttResult` performs no
lookup for an existing Result of the same tool before writing
(`saveResult.ts:73-155`). Confirmed in local data: one Run holds three
`windows-standard-voice-input` Results.

Tools are a closed list: `['windows-standard-voice-input', 'aqua-voice',
'other']` (`src/results/tools.ts:9`), delivery paths
`['speaker-to-mic','virtual-audio','other','unknown']` (`tools.ts:25`).

## 3. Evaluation — four schemas, one union

`StoredEvaluation = EvaluationV1 | CriticalEvaluationV2 | SurfaceEvaluationV3 |
SemanticEvaluationV4`, discriminated by `schema_version`
(`src/evaluation/createEvaluation.ts:176-181`).

`EVALUATOR_IDS` declares the four in this order
(`createEvaluation.ts:184-190`):

```text
raw-char-v1                  (v1)  rawChar.ts:19
surface-normalized-char-v1   (v3)  surfaceNormalize.ts:26
critical-info-v1             (v2)  criticalInfo.ts:24
semantic-h3-v1               (v4)  semanticEvaluationSchema.ts:51
```

Note that the declared order is Raw → Surface → Critical → Semantic, which is
already the display order this spike recommends. It should be used directly
rather than restated somewhere else.

Reportable content per schema:

| schema | evaluator contract | what a report can show |
|---|---|---|
| v1 | `id, unit, normalization` | `exact_match, reference_chars, hypothesis_chars, substitutions, deletions, insertions, edit_distance, cer` |
| v2 | 6 fields (`criticalEvaluationSchema.ts:77-84`) | `entities`, `matches`, `missing`, `extra`, `metrics{…, preservation_rate, exact_entity_multiset_match}` |
| v3 | 9 fields (`surfaceEvaluationSchema.ts:87-97`) | `normalized{reference,hypothesis}{sha256,chars}` + same metric shape as v1 |
| v4 | 8 fields (`semanticEvaluationSchema.ts:114-123`) | `normalized`, `critical` guard working, `execution`, `decision{value,by}` |

Semantic decision vocabulary, verbatim (`semanticDecision.ts:27`, `:30-43`):

```text
value : 'changed' | 'review'          // there is no 'preserved'
by    : critical-guard-veto-v1
        full-run-unanimous-changed-v1
        full-run-unanimous-preserved-requires-review-v1
        no-valid-run-evidence-v1
        incomplete-run-evidence-v1
        split-vote-v1
```

Execution status is `'completed' | 'skipped_by_critical_veto'`
(`semanticEvaluationSchema.ts:169`).

**Repeat Evaluations are allowed by construction.** Every create path does
`const evaluationId = deps.evaluationId ?? createEvaluationId(now())`
(`createEvaluation.ts:246, 327, 411, 582`) and writes, with no lookup against
existing Evaluations for that Result and evaluator. Write-once applies to the
*id* only: `EVALUATION_ALREADY_EXISTS` (`LocalEvaluationStore.ts:117-119`).

## 4. Readback — the shape the comparison consumes

`listEvaluationsForRun(deps, runId)` (`createEvaluation.ts:751-754`):

- fails closed on the Run first (`verifyRunEvidence`),
- skips unreadable files,
- filters `stored.run_id !== runId` (`:773`),
- returns both verified and rejected entries,
- sorts `entries.sort((a, b) => a.evaluationId.localeCompare(b.evaluationId))` (`:796`).

`EvaluationListEntry` (`createEvaluation.ts:660-682`):

```ts
| { status: 'verified'; evaluationId; evaluation; referenceText; hypothesisText; normalized? }
| { status: 'rejected'; evaluationId; resultId?; reason; message; detail? }
```

The rejected variant carries `resultId` only *optionally* — a rejected artifact
may not be attributable to a Result at all. The comparison model has to keep a
place for those.

`loadVerifiedEvaluation` throws rather than returning something partial
(`createEvaluation.ts:839-845`).

## 5. Ordering — already deterministic, already id-based

`src/lib/timestampId.ts:12`:

```ts
/** Shape: `<YYYYMMDD>T<HHmmssSSS>Z-<8 hex>` — sortable by time … */
export const TIMESTAMP_ID_PATTERN = /^\d{8}T\d{9}Z-[0-9a-f]{8}$/;
```

Fixed width, UTC, no separators that vary. Lexicographic order equals
chronological order, and every artifact type uses the same generator.

Explicit sorts already in production:

- `LocalResultStore.listResultIds()` — filter valid, then `.sort()` (`:171-175`)
- `LocalEvaluationStore.listEvaluationIds()` — same (`:142-146`)
- `listResultsForRun` — `.sort((a,b) => a.resultId.localeCompare(b.resultId))` (`saveResult.ts:310`)
- `listVerifiableRuns` — `.sort().reverse()`, newest first (`runEvidence.ts:258-260`)
- `listEvaluationsForRun` — `.sort(... localeCompare)` (`createEvaluation.ts:796`)

`readdir` order never reaches semantics anywhere that was audited.

## 6. API surface

| endpoint | params | returns |
|---|---|---|
| `GET /api/runs` | none | `{ok, runs}` — catalog, newest first |
| `GET /api/results` | `runId` **required** | `{ok, runId, results}` verified/rejected entries |
| `GET /api/evaluations` | `runId` **required** | `{ok, runId, evaluations}` verified/rejected entries |
| `POST /api/evaluations` | `{resultId, evaluatorId?}` | `{ok, evaluationId, evaluation, …}` |
| `GET /api/evaluations/[id]` | path id | `{ok, ...loadVerifiedEvaluation}` |
| `GET /api/sessions` | none | `{ok, sessions}` newest first |
| `GET /api/sessions/[id]` | path id | `{ok, ...buildSessionComparison}` |

There is deliberately no "all results" listing (`results/route.ts:21-22`).

Errors are one shape: `{ok:false, error:{kind, message, endpoint?, httpStatus?,
detail?}}` (`src/lib/apiError.ts:178-209`), with `UNEXPECTED` as the 500
fallback (`:398-401`).

## 7. UI today

`ManualSttResults.tsx`:

- fetches `/api/results` and `/api/evaluations` **in parallel** for the selected
  Run, specifically so the two lists cannot describe different Runs (`:788-796`);
- groups Evaluations to Results **client-side** into a `Map` keyed by
  `evaluation.result_id` (verified) or `entry.resultId` (rejected) (`:851-859`);
- routes each verified entry to one of four sections by `schema_version`
  (`:650-676`);
- shows rejected Evaluations in one combined block rather than filing them under
  an evaluator, because the reason for rejection can be that the evaluator record
  itself is unreadable (`:601-603`);
- shows orphan rejected Evaluations with no `resultId` in their own block (`:860-863`);
- applies **no sort of its own** — it renders server order.

`BenchmarkSessions.tsx`: a Case × target-tool coverage matrix built entirely
from `GET /api/sessions/:id`. Cells show verified/rejected counts, `missing`, or
`—`. It shows no evaluation metrics at all, and states in the UI copy that
coverage is not an accuracy score and that no ranking is performed (`:401-403`).

## 8. What a Session is, versus a Run

A Session names a set of Runs — one per Benchmark Case — plus target tools
(`sessions/route.ts:41-43`). `test_id`, `source_sha256` and `audio_sha256` are
resolved server-side from a fresh verification of each Run; anything the caller
says about a Run is ignored. Results and Evaluations attach to a **Run**, never
to a Session.

Critically, `buildSessionComparison` receives `runStore`, `resultStore` and
`sessionStore` only (`sessions/[sessionId]/route.ts:23-28`). The Session
comparison cannot see Evaluations at all.

**This is the gap Phase 4 fills**: an evaluation-aware comparison inside one
Run. The Session layer above it already works and is out of scope for P4-B.
