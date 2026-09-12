# Voice Input Bench

音声入力（Voice Input）まわりの品質を、**再現可能な形で**計測・比較するためのローカルベンチマーク環境。

## Mission

音声合成・音声入力に関する評価を、誰の環境でも・後からでも、同じ手順で辿り直せる形で残す。
評価結果そのものではなく、**「その結果がどう作られたか」を検証可能にすること**を最優先に置く。

## Product Principles

- **Local First** — 実行はローカル完結を基本とする。クラウド常時接続を前提にしない。
- **Free First** — 有料 API や商用 SaaS を必須依存にしない。無料・ローカルで動く選択肢を先に整える。
- **Reproducibility First** — 再現性が他のすべての要求（速度・機能量・UI の洗練）に優先する。
- **Evidence First** — 判断は保存された artifact から導出する。UI が持っている値や client の主張を根拠にしない。
- **Fail Closed** — 前提が崩れたら止める。壊れた evidence を「たぶん大丈夫」として通さない。
- **Immutable / Write-once** — 書いた artifact は上書きしない。訂正は新しい artifact で行う。

作らないもの: **ranking / winner / overall score / 自動 PRESERVED 判定 / STT の自動投入**。

## 現在できること

```text
Benchmark Text
    ↓
Local TTS / AivisSpeech
    ↓
Canonical WAV + immutable Run
    ↓
Manual STT capture（人が STT ツールへ通す）
    ↓
Result
    ↓
4 Evaluators
    ↓
Run Comparison
    ↓
Deterministic Report Export
```

**Benchmark Session はこの線とは別の機能。** Benchmark Case × Tool の **coverage（実施状況）**を
横断で見るためのもので、accuracy ranking ではない。

> より詳しい現在状態は [`docs/CURRENT_PRODUCT_STATE.md`](docs/CURRENT_PRODUCT_STATE.md)。
> 最終的な正本は production code。

## Phase Summary

| Phase | 内容 |
| --- | --- |
| **Phase 1** | Canonical audio / immutable Run（`Text → local TTS → canonical WAV + Manifest`） |
| **Phase 2** | Manual STT Result / Benchmark Session |
| **Phase 3** | Evaluation layer（4 evaluator + 検証付き readback） |
| **Phase 4** | Run Comparison（P4-B） / Deterministic Report（P4-C）。P4-D は deferred |
| **Phase 5-A** | Operator evaluation flow completion |

**Phase 5-A** で入ったもの:

- Result 単位 / Run 単位で「未取得の evaluator だけ」をまとめて実行する
- 既存の `POST /api/evaluations` を **strict sequential**（同時 1 件）で送るだけ。
  **server-side batch ではない** — 1 job = 1 POST = 1 immutable Evaluation
- verified な Evaluation は skip する
- 失敗は記録して次へ進み、**自動再試行はしない**
- capture metadata の記憶は **memory only**（保存も artifact 化もしない）

## The Four Evaluators

| Evaluator ID | 何を測るか |
| --- | --- |
| `raw-char-v1` | 生の transcript と canonical text の文字単位の差（CER / edit distance / S・D・I）。正規化なし。 |
| `surface-normalized-char-v1` | 表記ゆれ（全角半角・大小文字・句読点・空白）を正規化してから同じ測り方をする。 |
| `critical-info-v1` | 数値・単位・時刻などの critical entity が保存されたか。 |
| `semantic-h3-v1` | 意味が変わっていないかを、ローカル LLM の rubric で見る。 |

Raw CER と Surface CER の差は「整形エラーの量」ではない。分母も alignment も違う**別の読み**であって、
その差自体は何かの量ではない。

### semantic-h3-v1 が出す語彙

```text
CHANGED
REVIEW REQUIRED
```

**この 2 つだけ。** `PRESERVED` / `PASS` / `SAFE` / `OK` は存在しない（型にすら無い）。
3 回とも「意味は保たれている」と出た場合でも自動 PRESERVED にはならず、`REVIEW REQUIRED` になる。

`critical-info-v1` が critical entity の不一致を見つけた場合、それは semantic への **hard veto**
になる。モデルは呼ばれず、判定は `CHANGED` に固定される。

Run Comparison も Report も、**ranking / winner / overall score を作らない。** 食い違う evidence は
conflict として提示し、多数決で解決しない。

## Setup

### Requirements

- **Node.js 24.x**（canonical runtime。`package.json` の `engines` も `^24.0.0` に固定）
- [AivisSpeech](https://aivis-project.com/) または AivisSpeech Engine（ローカル起動）
- **Ollama**（`semantic-h3-v1` を実行する場合のみ。§ Semantic Runtime 参照）

### 1. AivisSpeech Engine を起動する

既定のポートは `10101`。

```bash
curl http://127.0.0.1:10101/version
```

Swagger UI: <http://127.0.0.1:10101/docs>

> このリポジトリは AivisSpeech のインストールや設定変更を行わない。導入はユーザー側の責任範囲。

### 2. 依存関係をインストールする

```powershell
npm.cmd install
```

### 3. 環境変数（任意）

```bash
cp .env.example .env
```

production が読む環境変数は次の 8 つだけで、**すべて任意**。`.env` が無くても既定値で動く。

| 変数 | 既定値 | 用途 |
| --- | --- | --- |
| `AIVIS_ENGINE_URL` | `http://127.0.0.1:10101` | AivisSpeech Engine のベース URL |
| `AIVIS_ENGINE_TIMEOUT_MS` | `30000` | Engine 呼び出しのタイムアウト (ms) |
| `VIB_RUNS_DIR` | `<cwd>/data/runs` | Run root |
| `VIB_RESULTS_DIR` | `<cwd>/data/results` | Result root |
| `VIB_SESSIONS_DIR` | `<cwd>/data/sessions` | Session root |
| `VIB_EVALUATIONS_DIR` | `<cwd>/data/evaluations` | Evaluation root |
| `VIB_SEMANTIC_ENDPOINT` | `http://127.0.0.1:11434` | Ollama endpoint（loopback のみ） |
| `VIB_SEMANTIC_TIMEOUT_MS` | chat `300000` / preflight `10000` | semantic 呼び出しのタイムアウト (ms)。1 変数で両方を上書きする |

`.env` は Git 管理外。

### 4. 開発サーバーを起動する

```powershell
npm.cmd run dev
```

<http://localhost:3000> を開く。

## Semantic Runtime（semantic-h3-v1 のときだけ必要）

**Ollama が要るのは `semantic-h3-v1` を実行するときだけ。** 音声生成・Result 保存・他 3 evaluator・
Run Comparison・Report Export は Ollama なしで動く。

semantic-h3-v1 は**固定された 1 つのローカル runtime だけ**を相手にする。

| 項目 | 値 |
| --- | --- |
| Provider | Ollama native `/api/chat` |
| Runtime | Ollama **0.33.3**（完全一致） |
| Model | `llama3.1:8b` |
| Digest | `46e0c10c039e019119339687c3c1757cc81b9da49709a3b3924863ba87ca666e` |
| Quantization | `Q4_K_M` |
| Repeats | 3 |
| Temperature | 0 |
| `num_predict` | 600 |
| Default endpoint | `http://127.0.0.1:11434` |

- **loopback only。** 許可ホストは `127.0.0.1` / `localhost` / `::1` / `[::1]` の文字列一致のみ。
  `127.1` や `2130706433` のような別表記は拒否する
- **redirect は拒否する**
- **model の自動 download をしない。fallback model も無い**
- runtime / digest / quantization のいずれかがずれていれば **Fail Closed** — Evaluation は 1 件も書かれない

## Usage（End-to-End）

1. **AivisSpeech Engine** を起動する
2. `npm.cmd run dev` でアプリを起動し、上部の **AivisSpeech Connection** が `Connected` になっていることを確認する
3. **Test** で Benchmark Case を選ぶ（`Manual` なら自分でテキストを入れる）
4. **Generate** を押す → immutable Run が 1 つできる
5. canonical WAV を対象の STT ツールへ**手動で**通す
6. 返ってきた raw transcript を **Manual STT Results** から Result として保存する
7. **Run missing evaluations** で未取得の Evaluation を実行する（Result 単位 / Run 単位）
8. **Run Comparison** を確認する
9. **Report Export** で Report package を書き出す
10. 必要なら **Benchmark Session** で Case × Tool の coverage を確認する

> 手順 5 の手動投入は「自動化が未実装だから仕方なく」ではなく、**現在の明示的な contract**。
> STT ツールの自動操作と自動採点は行わない。

1 回の Generate が 1 つの immutable Run になる。

```text
data/runs/<run-id>/
├─ source.txt           canonical text
├─ audio.wav            canonical artifact
├─ provider-query.json  Provider へ送った実リクエスト
└─ manifest.json        Manifest schema v2
```

audio player は `GET /api/runs/<run-id>/audio` を読むので、聞こえているのはメモリ上のコピーではなく
ディスクに保存された canonical artifact そのもの。

### Benchmark Cases

| ID | 内容 |
| --- | --- |
| `architecture-short-001` | 建築ドメインの短文（1 segment） |
| `architecture-long-001` | 建築ドメインの長文（複数 segment） |
| `filler-001` | 「えーと」「あの」などのフィラー |
| `correction-001` | 発話中の言い直し |
| `numbers-units-001` | 寸法・面積・風量・速度・時刻 |
| `coding-001` | 固有名詞・英字略語・コマンド文字列 |

Case 本文はサーバー側（`src/benchmark/cases.ts`）が正本。client が送った本文は使わないので、
同じ `test_id` の Run 同士は必ず同じ文章を含む。

## Data Roots

```text
data/
├─ runs/          canonical source + WAV + 生成 evidence
├─ results/       manual STT observations
├─ sessions/      benchmark coverage definitions
└─ evaluations/   derived evaluator artifacts
```

4 root は**意図的に分離**されている。ある root が別の root と同一、または内側にあることは
書き込み前に拒否される（`ROOT_ISOLATION_VIOLATED`）。

**Report は 5 番目の root ではない。** `data/reports` は作らない。Report package は operator export。

## Report / Re-render

Report は Run 単位で、verified な evidence から derive される deterministic な Markdown と、
その ReportSource JSON の 2 ファイル。

- `content_sha256` は `{ markdown_body, report_source }` の canonical JSON に対する SHA-256。
  `generated_at` と表示用 footer は識別対象に**含めない**
- **operator export only。** 保存された Report Store は無い
- **model call をしない**

`GET /api/reports/run/<run-id>` が生成し、`POST /api/reports/rerender` が export 済み
ReportSource を現在の evidence に対して照合し直す（`reproduced` / `changed` と、
`evidence_changed` / `verification_changed` / `not_rechecked` の区別を返す）。re-render も
model call をしない。

> **re-render 専用の UI 入口は現時点で無い**（API のみ）。

## Reproducibility Model

本プロジェクトは **bit-exact regeneration を前提にしない**。

TTS エンジンはバージョン・モデル・実行環境によって出力が変わりうるため、「同じ入力から同じ
バイト列が再生成できること」を再現性の定義には採用しない。代わりに次を採る。

- **生成済み WAV そのものを canonical artifact として保持する。**
  再現性の基準は「再生成できること」ではなく「実際に評価に使った音声が残っていること」
- **再生成は既存 Run を上書きしない。** 常に新しい Run として記録する
- Run は生成条件（入力テキスト・Provider・エンジン情報・リクエスト内容）とともに保存する

### canonical source text

Run に残すテキスト・ハッシュ対象のテキスト・TTS へ渡すテキストは、**同じ 1 本の文字列**を使う。

```text
raw UI text
    ↓
CRLF / CR → LF
    ↓
canonical text
├─ source.txt
├─ Text SHA-256 input
└─ TTS input
```

canonicalization は**改行コードの正規化だけ**。trim / 全角半角変換 / Unicode 置換 / 句読点変更 /
空白圧縮 / 誤字修正 / AI 整形は行わない。

### 長文の分割と結合

450 code points を超えるテキストは、決定的な splitter（strategy `sentence-v1`）で分割し、segment
ごとに同じ Voice / Speed / Volume / 44100Hz / mono で生成してから 1 つの WAV に結合する。

結合時に無音挿入・normalization・denoise・silence removal・resample・gain 調整は一切行わない。
segment 間で format / channels / sampleRate / bitsPerSample / blockAlign が一致しなければ
Fail Closed として Run を保存しない。途中の segment が 1 つでも失敗した場合も official Run は作らない。

## Scripts

> **Windows PowerShell では `npm.cmd` を使う。** PowerShell は `npm.ps1` を拾うため、
> Execution Policy によっては `npm` が実行できない。`npm.cmd` はその制限を受けない。

| コマンド（PowerShell） | 内容 |
| --- | --- |
| `npm.cmd run dev` | 開発サーバー |
| `npm.cmd run build` | 本番ビルド |
| `npm.cmd start` | 本番サーバー |
| `npm.cmd run lint` | ESLint |
| `npm.cmd run typecheck` | `tsc --noEmit` |
| `npm.cmd test` | Vitest（**Engine 未起動でも実行可能**） |
| `npm.cmd run test:watch` | Vitest（watch） |
| `npm.cmd run smoke:aivis` | 実 Engine への Manual Integration Smoke |

`npm.cmd test` は AivisSpeech Engine にも Ollama にも接続しない。実 Engine を使う確認は
`npm.cmd run smoke:aivis` に分離してある（Engine 未起動なら
`MANUAL_SMOKE_BLOCKED_ENGINE_NOT_RUNNING` で終了コード 2）。

## Repository Layout

```text
src/
├─ app/          Next.js App Router。画面と API route
│  ├─ page.tsx / layout.tsx / globals.css
│  ├─ ManualSttResults.tsx / RunComparison.tsx / ReportExport.tsx / BenchmarkSessions.tsx
│  ├─ evaluationQueue.ts / captureProfile.ts   operator batch のルール（pure）
│  └─ api/       14 route（下表）
├─ audio/        RIFF/WAVE parse + segment 結合
├─ benchmark/    Benchmark Case / splitter / Run 生成 / Manifest
├─ comparisons/  runComparison.ts — 1 Run 内の evidence-aware comparison
├─ evaluation/   4 evaluator と schema / verifier、semantic stack
├─ lib/          engineConfig（全 env 読み取り）・hash・canonicalText・id・apiError
├─ reports/      Report package build / ReportSource / Markdown renderer / re-render
├─ results/      Result schema・transcript 正規化・tool identity・save/verify
├─ sessions/     Session schema・作成・coverage matrix・検証
├─ storage/      4 つの Local*Store と rootIsolation
└─ tts/          TTSProvider 境界 と AivisSpeechProvider

scripts/         Manual Integration Smoke
docs/            現在状態と historical documents
research/        decision / evidence record（p3d-semantic, p4a-comparison-report）
data/            4 つの artifact root（Git 管理外）
```

### API routes

| カテゴリ | Route |
| --- | --- |
| Engine / Case | `GET /api/status` `GET /api/voices` `GET /api/cases` |
| Run | `POST /api/generate` `GET /api/runs` `GET /api/runs/[runId]/audio` |
| Result | `GET, POST /api/results` |
| Session | `GET, POST /api/sessions` `GET /api/sessions/[sessionId]` |
| Evaluation | `GET, POST /api/evaluations` `GET /api/evaluations/[evaluationId]` |
| Comparison | `GET /api/comparisons/run/[runId]` |
| Report | `GET /api/reports/run/[runId]` `POST /api/reports/rerender` |

## Known Limitations

- **STT 投入は手動**（Windows 音声入力 / Aqua Voice への自動投入は行わない）
- **cloud STT は無い**
- **P4-D（cross-Run aggregation）は deferred**
- **ranking / winner / overall score は無い**（設計として作らない）
- **semantic runtime の状態を見る専用 UI が無い**
- **report re-render の専用 UI 入口が無い**（API は存在する）
- **local data の retention / cleanup が未実装**
- **historical artifact migration を行わない**（旧 schema は書き換えず区別して扱う）

## Documents

| 文書 | 位置づけ |
| --- | --- |
| [`docs/CURRENT_PRODUCT_STATE.md`](docs/CURRENT_PRODUCT_STATE.md) | **現在状態の canonical overview** |
| [`docs/INITIAL_PRODUCT_DIRECTION.md`](docs/INITIAL_PRODUCT_DIRECTION.md) | Historical: 初期プロダクト方針 |
| [`docs/PHASE1_ACCEPTANCE.md`](docs/PHASE1_ACCEPTANCE.md) | Historical: Phase 1 受け入れ基準 |
| [`docs/architecture/phase-1-plan.md`](docs/architecture/phase-1-plan.md) | Historical: Phase 1 設計計画 |
| [`research/p3d-semantic/`](research/p3d-semantic/) | semantic 手法比較と human-reviewed gold |
| [`research/p4a-comparison-report/`](research/p4a-comparison-report/) | Comparison / Report の設計根拠 |

historical / research 文書は**当時の判断の記録**であり、現在仕様ではない。現在仕様の最終
authority は production code。

## License

未定。
