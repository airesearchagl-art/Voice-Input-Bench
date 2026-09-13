# Current Product State

Voice Input Bench の**現在の状態**をまとめた canonical overview。README より一段詳しい。

> **正本は production code。** この文書は現在の実装を読んで書かれた要約であり、コードと食い違う
> 場合はコードが正しい。`docs/` と `research/` の他の文書は当時の判断を残す historical /
> decision record であって、現在仕様ではない（§13）。
>
> 記載内容は `main@d7a5d5db67d68890cc5fb35bbc7da4a5e89f18e7` の実装に対して確認した。

## 1. 現在のプロダクト

ローカル完結で「音声入力（STT）の品質を、後から検証できる形で計測する」ための bench。

```text
Benchmark Text
    ↓
Local TTS / AivisSpeech
    ↓
Canonical WAV + immutable Run
    ↓
Manual STT capture（人が STT ツールへ通す）
    ↓
Result（1 ツール 1 観測）
    ↓
4 Evaluators
    ↓
Run Comparison（1 Run 内の evidence 突き合わせ）
    ↓
Deterministic Report Export
```

**Benchmark Session はこの線とは別の機能。** Case × Tool の **coverage（実施状況）** を横断で見る
ためのもので、accuracy ranking ではない。「どの Case をどのツールで観測済みか」を答えるだけで、
スコアの優劣は出さない。

### 設計原則

| 原則 | 意味 |
| --- | --- |
| **Local First** | 実行はローカル完結。クラウド常時接続を前提にしない。 |
| **Free First** | 有料 API / 商用 SaaS を必須依存にしない。 |
| **Reproducibility First** | 再現性が速度・機能量・UI の洗練に優先する。 |
| **Evidence First** | 判断は保存された artifact から導出する。UI が持つ値や client の主張を根拠にしない。 |
| **Fail Closed** | 前提が崩れたら止める。壊れた evidence を「たぶん大丈夫」として通さない。 |
| **Immutable / Write-once** | 書いた artifact は上書きしない。訂正は supersede（新しい artifact）で行う。 |

**作らないもの**: ranking / winner / overall score / 自動 PRESERVED 判定 / 多数決による conflict
解決 / STT 自動投入。

## 2. Phase history

| Phase | 内容 |
| --- | --- |
| **Phase 1** | Canonical audio / immutable Run。`Text → local TTS → canonical WAV + Manifest`。 |
| **Phase 2** | Manual STT Result と Benchmark Session。 |
| **Phase 3** | Evaluation layer（4 evaluator と検証付き readback）。 |
| **Phase 4** | Run Comparison（P4-B）と Deterministic Report（P4-C）。P4-D は deferred。 |
| **Phase 5-A** | Operator evaluation flow completion。 |

### Phase 5-A の内容

- Result 単位の「未取得 evaluator をまとめて実行」
- Run 単位の「未取得 evaluator をまとめて実行」
- 既存の `POST /api/evaluations` を **strict sequential**（同時実行 1 件）で送るだけ
- **server-side batch ではない。** batch API も batch writer も無い。1 job = 1 POST = 1 immutable Evaluation
- verified な Evaluation は skip する（作り直さない）
- 失敗は記録して次へ進む。**自動再試行はしない**
- capture metadata profile は **memory only**（localStorage / cookie / server / artifact のいずれにも出ない）

## 3. Artifact model

| Artifact | 何か |
| --- | --- |
| **Run** | canonical text + canonical WAV + 生成条件。1 回の Generate = 1 Run。 |
| **Result** | 1 つの STT ツールが 1 つの Run に対して返した transcript。1 観測 = 1 Result。 |
| **Evaluation** | 1 つの Result を 1 つの evaluator で測った derived artifact。 |
| **Session** | Benchmark Case ごとに Run を固定した実験セット定義。 |

いずれも **write-once**。再生成は既存を上書きせず新しい artifact になる。

読み出しは常に検証付き。Result は `sealed`（schema v2）と `legacy-unsealed` を区別し、検証に
失敗した artifact は transcript や測定値として表示せず、失敗として表示する。**rejected な
artifact は自分の主張（tool id / evaluator id 等）を根拠に採用されない。**

## 4. Four data roots

```text
data/
├─ runs/          canonical source + WAV + 生成 evidence
├─ results/       manual STT observations
├─ sessions/      benchmark coverage definitions
└─ evaluations/   derived evaluator artifacts
```

on-disk のファイル名:

```text
runs/<run-id>/         source.txt / audio.wav / provider-query.json / manifest.json
results/<result-id>/   transcript.txt / result.json
evaluations/<id>/      evaluation.json
```

4 root は**意図的に分離**されている。`src/storage/rootIsolation.ts` が、

- ある root が別の root と同一ディレクトリであること
- ある root が別の root の内側にあること

の両方を拒否する。判定は双方向で、`path.resolve` 後に比較する。違反は書き込み前に
`ROOT_ISOLATION_VIOLATED`（HTTP 500）で止まる。

**Report は 5 番目の root ではない。** `data/reports` は作らないし、`VIB_REPORTS_DIR` も存在
しない。Report package は operator export（§8）。

## 5. Evaluators

`EVALUATOR_IDS` の順序どおり。

| # | Evaluator ID | schema | 何を測るか |
| --- | --- | --- | --- |
| 1 | `raw-char-v1` | v1 | 生の transcript と canonical text の文字単位の差（CER / edit distance / S・D・I）。正規化なし。 |
| 2 | `surface-normalized-char-v1` | v3 | 表記ゆれ（全角半角・大小文字・句読点・空白）を正規化してから同じ測り方をする。 |
| 3 | `critical-info-v1` | v2 | 数値・単位・時刻といった critical entity が保存されたか。canonical multiset で突き合わせる。 |
| 4 | `semantic-h3-v1` | v4 | 意味が変わっていないかをローカル LLM の rubric で見る。 |

> schema version は 1 / 3 / 2 / 4 で、evaluator の並び順とは一致しない。これは各 schema が
> 独立に版を重ねた結果で、意図的。

Raw CER と Surface CER の差は「整形エラー量」ではない。**分母も alignment も違う別の読み**で
あって、差分そのものは何かの量ではない。

### semantic-h3-v1 の判定語彙

出る値は **2 つだけ**。

```text
changed  → CHANGED
review   → REVIEW REQUIRED
```

**`PRESERVED` / `PASS` / `SAFE` / `OK` は存在しない。** 型にすら無く（`SemanticDecisionValue =
'changed' | 'review'`）、readback もそれ以外の値を拒否する。3 回とも「意味は保たれている」と
出た場合ですら自動 PRESERVED にはならず、`REVIEW REQUIRED`（人が見る）になる。

判定の由来は 6 種類が記録される: critical veto / 全 run 一致で changed / 全 run 一致で preserved
（→ review） / 有効な run 証拠なし / run 証拠が不完全 / 票割れ。

### Critical veto

`critical-info-v1` が critical entity の不一致を検出した場合、それは semantic evaluator への
**hard veto** になる。

- モデルは**呼ばれない**（`runs: []`、`execution` は `skipped_by_critical_veto`）
- 判定は `changed`（由来 `critical-guard-veto-v1`）

つまり「数値が壊れているのに意味は保たれている」という結論は構造上出せない。

## 6. Semantic runtime contract

semantic-h3-v1 は**固定された 1 つのローカル runtime だけ**を相手にする。契約 ID は
`ollama-pinned-v1`。

| 項目 | 値 |
| --- | --- |
| Provider / protocol | Ollama native `/api/chat`（OpenAI 互換 shim ではない） |
| Runtime | Ollama **0.33.3**（完全一致） |
| Model | `llama3.1:8b` |
| Digest | `46e0c10c039e019119339687c3c1757cc81b9da49709a3b3924863ba87ca666e` |
| Quantization | `Q4_K_M` |
| Repeats | 3 |
| Temperature | 0 |
| `num_predict` | 600 |
| `stream` | false |
| `top_p` / `seed` | 送らない（runtime default / 制御しない、と記録する） |
| Prompt | `semantic-rubric-v1`（SHA-256 `9677764f367cfbf44048ec60ac76f111e0c2487356598405cca91b27790f3558`） |
| Default endpoint | `http://127.0.0.1:11434` |

### ネットワーク境界

- **loopback only。** 許可ホストは `127.0.0.1` / `localhost` / `::1` / `[::1]` の**文字列一致**のみ。
  DNS 解決も suffix 一致もしない。`127.1` / `2130706433` / `0177.0.0.1` / `0.0.0.0` は拒否。
- URL に userinfo（`user:pass@`）があれば拒否。
- **redirect は拒否**（`redirect: 'manual'`、3xx / opaqueredirect は `SEMANTIC_ENDPOINT_NOT_LOOPBACK`）。
- 触るパスは `/api/version` `/api/tags` `/api/show` `/api/chat` の 4 つだけ。`/api/pull` は
  許可リストに無い。
- **model の自動 download をしない。fallback model も無い。**

### Fail Closed

Evaluation を書く前に preflight が走り、次の順で確認する。1 つでも外れたら **Evaluation は
1 件も書かれない**。

1. prompt のハッシュ（ソケットを開く前）→ `SEMANTIC_PROMPT_MISMATCH`
2. endpoint が loopback か
3. `/api/version` が `0.33.3` か → `SEMANTIC_RUNTIME_VERSION_MISMATCH`（未応答は `SEMANTIC_RUNTIME_UNAVAILABLE`）
4. `/api/tags` に `llama3.1:8b` があるか → `SEMANTIC_MODEL_NOT_FOUND`
5. digest 一致 → `SEMANTIC_MODEL_DIGEST_MISMATCH`
6. `/api/show` の quantization が `Q4_K_M` か → `SEMANTIC_MODEL_QUANTIZATION_MISMATCH`

**Ollama が要るのは semantic-h3-v1 を実行するときだけ。** 音声生成・Result 保存・他 3 evaluator・
Run Comparison・Report Export は Ollama なしで動く。

## 7. Run Comparison

1 つの Run の中で、tool ごとの Result と evaluator ごとの Evaluation を突き合わせて見る read model。
`GET /api/comparisons/run/<run-id>` が返す。**保存しない**（Run から derive する）。

- verified な Evaluation だけを evaluator group に入れる
- rejected / legacy / 帰属不明の evidence は「無かったこと」にせず、別枠で見せる
- **ranking / winner / overall score は作らない**
- 同じ measurement について食い違う evidence があれば conflict として提示し、**多数決で解決しない**

## 8. Report / Re-render

### 生成

- **Run-centric**。verified な evidence から derive する
- deterministic な Markdown（同じ evidence からは同じ本文）
- ReportSource JSON（contract version 1）+ Markdown の 2 ファイルで 1 package
- `content_sha256` = canonical-JSON 化した `{ markdown_body, report_source }` の SHA-256。
  **`generated_at` と表示用 footer は識別対象に含めない**（footer は
  `<!-- vib-report:presentation-footer -->` で区切られる）
- export ファイル名は `vib-report-<run-id>-<content_sha256 の先頭 12 桁>` + `.source.json` / `.md`
- **operator export only。persisted Report Store は無い**（§4）
- **model call をしない**。semantic の値は保存済み v4 evidence を現行 verifier で読み直したもの
- ビルド中に evidence が動いたら `REPORT_EVIDENCE_CHANGED_DURING_BUILD` で拒否する

`GET /api/reports/run/<run-id>`

### Re-render

`POST /api/reports/rerender` — export 済みの ReportSource を現在の evidence に対して照合し直す。

- 結果は `reproduced` / `changed`
- `evidence_changed`（元の artifact が変わった） / `verification_changed`（検証結果が変わった） /
  `not_rechecked`（今回確認していない）を**区別して**返す
- ここでも **model call をしない**
- body は 8 MiB まで（超過は `REPORT_SOURCE_TOO_LARGE`）

> **re-render 専用の UI 入口は現時点で存在しない**（API のみ）。§12 参照。

## 9. Operator workflow

1. AivisSpeech（Engine）をローカル起動する
2. `npm.cmd run dev` でアプリを起動する
3. Benchmark Case を選ぶ
4. **Generate** → immutable Run が 1 つできる
5. canonical WAV を対象の STT ツールへ**手動で**通す
6. 返ってきた raw transcript を Result として保存する
7. 未取得の Evaluation を実行する（Result 単位 / Run 単位）
8. Run Comparison を確認する
9. Report を export する
10. 必要なら Session で Case × Tool の coverage を確認する

> 手順 5 の手動投入は「自動化が未実装だから仕方なく」ではなく、**現在の明示的な contract**。
> STT ツールの自動操作と自動採点は行わない。

## 10. Environment variables

production が読む環境変数は次の 8 つだけで、すべて `src/lib/engineConfig.ts` 経由。すべて任意で、
`.env` が無くても既定値で動く。値は trim され、空文字は未設定と同じ。timeout は「有限かつ 0 より
大きい数値」に限り採用する。

| 変数 | 既定値 |
| --- | --- |
| `AIVIS_ENGINE_URL` | `http://127.0.0.1:10101` |
| `AIVIS_ENGINE_TIMEOUT_MS` | `30000` |
| `VIB_RUNS_DIR` | `<cwd>/data/runs` |
| `VIB_RESULTS_DIR` | `<cwd>/data/results` |
| `VIB_SESSIONS_DIR` | `<cwd>/data/sessions` |
| `VIB_EVALUATIONS_DIR` | `<cwd>/data/evaluations` |
| `VIB_SEMANTIC_ENDPOINT` | `http://127.0.0.1:11434` |
| `VIB_SEMANTIC_TIMEOUT_MS` | chat `300000` / preflight `10000`（1 変数で両方を上書きする） |

詳細な注記は [`.env.example`](../.env.example)。

## 11. API routes

14 本。すべて `dynamic = 'force-dynamic'`。`PUT` / `PATCH` / `DELETE` は存在しない。

| Route | Methods |
| --- | --- |
| `/api/cases` | GET |
| `/api/voices` | GET |
| `/api/status` | GET |
| `/api/generate` | POST |
| `/api/runs` | GET |
| `/api/runs/[runId]/audio` | GET |
| `/api/results` | GET, POST |
| `/api/sessions` | GET, POST |
| `/api/sessions/[sessionId]` | GET |
| `/api/evaluations` | GET, POST |
| `/api/evaluations/[evaluationId]` | GET |
| `/api/comparisons/run/[runId]` | GET |
| `/api/reports/run/[runId]` | GET |
| `/api/reports/rerender` | POST |

## 12. Current limitations / deferred

- **STT 投入は手動。** Windows 音声入力 / Aqua Voice への自動投入は行わない（意図的な contract）
- **cloud STT は無い**
- **P4-D（cross-Run aggregation）は deferred**
- **ranking / winner / overall score は無い**（設計として作らない）
- **semantic runtime の状態を見る専用 UI が無い。** 未起動・版ずれは評価実行時にエラーとして出る
- **report re-render の専用 UI 入口が無い**（`POST /api/reports/rerender` は存在する）
- **local data の retention / cleanup が未実装。** `data/` は増える一方で、削除の導線は無い
- **historical artifact migration を行わない。** 旧 schema の artifact は書き換えず、
  `legacy-unsealed` 等として区別して扱う

## 13. Historical / research index

### Historical documents（当時の記録。現在仕様ではない）

| 文書 | 位置づけ |
| --- | --- |
| [`INITIAL_PRODUCT_DIRECTION.md`](./INITIAL_PRODUCT_DIRECTION.md) | 初期プロダクト方針 |
| [`PHASE1_ACCEPTANCE.md`](./PHASE1_ACCEPTANCE.md) | Phase 1 の受け入れ基準 |
| [`architecture/phase-1-plan.md`](./architecture/phase-1-plan.md) | Phase 1 の設計計画 |

これらの「Phase 1 対象外」記述は当時の境界であり、その後実装されたものを含む。本文は歴史として
維持されている。

### Research / decision records

現在も有効な**設計根拠**。ただし research document 自体は production の現在仕様ではなく、
決定と evidence の記録。**最終 authority は production code。**

| 文書 | 内容 |
| --- | --- |
| [`research/p3d-semantic/`](../research/p3d-semantic/) | semantic 手法比較と human-reviewed gold（28/28 approved） |
| [`research/p4a-comparison-report/comparison-contract.md`](../research/p4a-comparison-report/comparison-contract.md) | Comparison read model の契約 |
| [`research/p4a-comparison-report/report-contract.md`](../research/p4a-comparison-report/report-contract.md) | Report の内容・識別・再現性 |
| [`research/p4a-comparison-report/edge-cases.md`](../research/p4a-comparison-report/edge-cases.md) | モデルが表現できる必要のある状態 |
| [`research/p4a-comparison-report/phase-plan.md`](../research/p4a-comparison-report/phase-plan.md) | P4-B / P4-C / P4-D の分割（P4-D は deferred） |
