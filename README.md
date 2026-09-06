# Voice Input Bench

音声入力（Voice Input）まわりの品質を、**再現可能な形で**計測・比較するためのローカルベンチマーク環境。

## Mission

音声合成・音声入力に関する評価を、誰の環境でも・後からでも・同じ手順で辿り直せる形で残す。
評価結果そのものではなく、**「その結果がどう作られたか」を検証可能にすること**を最優先に置く。

## Product Principles

- **Local First** — 実行はローカル完結を基本とする。クラウド常時接続を前提にしない。
- **Free First** — 有料APIや商用SaaSを必須依存にしない。無料・ローカルで動く選択肢を先に整える。
- **Reproducibility First** — 再現性が他のすべての要求（速度・機能量・UIの洗練）に優先する。

## Phase 1 Scope

```text
Text → local TTS → canonical WAV + Manifest
```

Phase 1 のゴールは「テキストを入れると、ローカルTTSで音声を生成し、その生成物と生成条件を
あとから検証できる形で残せる」ところまで。

最初の TTS Provider は **AivisSpeech** とする。将来の Provider 追加に備え、
Provider Adapter 方式（`TTSProvider` インターフェース + Provider 個別実装）を採る。

### Phase 1 対象外（Out of Scope）

- Windows 音声入力への自動投入
- Aqua Voice への自動投入
- STT 自動取得 / Whisper 連携
- CER / Semantic evaluation / LLM grading
- Markdown Report
- SNS 連携
- データベース / ORM
- SaaS 化
- 認証 / 認可
- 課金
- クラウドデプロイ

生成した WAV を Windows 音声入力や Aqua Voice へ投入する操作は、Phase 1 では**手動**で行う。

## Reproducibility Model

本プロジェクトは **bit-exact regeneration を前提にしない**。

TTS エンジンはバージョン・モデル・実行環境によって出力が変わりうるため、
「同じ入力から同じバイト列が再生成できること」を再現性の定義には採用しない。

代わりに次を採る。

- **生成済み WAV そのものを canonical artifact として保持する。**
  再現性の基準は「再生成できること」ではなく「実際に評価に使った音声が残っていること」。
- **再生成は既存 Run を上書きしない。** 常に新しい Run として記録する。
- Run は生成条件（入力テキスト・Provider・エンジン情報・リクエスト内容）とともに保存する。

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

canonicalization は**改行コードの正規化だけ**。trim / 全角半角変換 / Unicode 置換 /
句読点変更 / 空白圧縮 / 誤字修正 / AI 整形は行わない。詳細は
[`docs/architecture/phase-1-plan.md`](docs/architecture/phase-1-plan.md) §6.1 を参照。

> canonicalization は P1-B で実装済み（`src/lib/canonicalText.ts`）。

### 将来の Run Bundle 構成

```text
data/runs/<run-id>/
├─ source.txt           canonical text
├─ audio.wav            canonical artifact（正）
├─ provider-query.json  Provider へ送った実リクエスト
└─ manifest.json        Run メタデータ（ハッシュ・エンジン情報・パラメータ）
```

> Run Bundle は P1-B で実装済み。`data/runs/` は Git 管理外。

## Phase 1 Breakdown

| Phase | 内容 |
| --- | --- |
| **P1-A** | Genesis baseline + AivisSpeech Contract Spike。最小ローカルWebアプリで `Text → WAV` を通す。Provider境界を確定させる。 |
| **P1-B** | Run 永続化。`data/runs/<run-id>` の immutable Run Bundle、Manifest、SHA-256、transactional write。 |
| **P1-C** | Benchmark Case と長文対応。Case selector、deterministic long-text splitter、segment WAV assembly、`architecture-long-001`、Phase 1 UI completion、Phase 1 Acceptance / README。 |


## Setup

### Requirements

- **Node.js 24.x**（canonical runtime。検証は Node.js 24.15.0 / npm 11.12.1）
- [AivisSpeech](https://aivis-project.com/) または AivisSpeech Engine（ローカル起動）

> Phase 1 は Node 24.x を canonical runtime として扱い、対応範囲を広げない。
> `package.json` の `engines` も `^24.0.0` に固定してある。

### 1. AivisSpeech Engine を起動する

AivisSpeech（または AivisSpeech Engine 単体）をローカルで起動する。
既定のポートは `10101`。起動後、次で疎通を確認できる。

```bash
curl http://127.0.0.1:10101/version
```

Swagger UI: <http://127.0.0.1:10101/docs>

> このリポジトリは AivisSpeech のインストールや設定変更を行わない。
> エンジンの導入・設定はユーザー側の責任範囲とする。

### 2. 依存関係をインストールする

```powershell
npm.cmd install
```

### 3. 環境変数を設定する（任意）

```bash
cp .env.example .env
```

| 変数 | 既定値 | 用途 |
| --- | --- | --- |
| `AIVIS_ENGINE_URL` | `http://127.0.0.1:10101` | AivisSpeech Engine のベース URL |
| `AIVIS_ENGINE_TIMEOUT_MS` | `30000` | Engine 呼び出しのタイムアウト (ms) |

既定値で動くため、`.env` は無くても起動する。`.env` は Git 管理外。

### 4. 開発サーバーを起動する

```powershell
npm.cmd run dev
```

<http://localhost:3000> を開く。

## Usage

1. ページ上部の **AivisSpeech Connection** が `Connected` になっていることを確認する
2. **Test** で `Manual` または Benchmark Case を選ぶ
   - `Manual` の場合は **Test Text** にテキストを入力する
   - Benchmark Case の場合は本文が読み取り専用で表示される（本文はサーバー側の正本を使う）
3. **Voice / Style** を選ぶ
4. **Speed** / **Volume** を調整する
5. **Generate** を押す
6. **Output** に Run ID / Test ID / Segmentation / Text SHA-256 / Audio SHA-256 / bytes /
   Generated At が表示される
7. audio player で**保存済みの** `audio.wav` を再生する

1 回の Generate が 1 つの immutable Run になる。

```text
data/runs/<run-id>/
├─ source.txt           canonical text
├─ audio.wav            canonical artifact
├─ provider-query.json  Provider へ送った実リクエスト
└─ manifest.json        Manifest schema v2
```

Run は上書きされない。同じテキストを再生成しても新しい Run が作られる。

audio player は `GET /api/runs/<run-id>/audio` を読むので、聞こえているのは
メモリ上のコピーではなくディスクに保存された canonical artifact そのもの。

### Benchmark Cases

| ID | 内容 |
| --- | --- |
| `architecture-short-001` | 建築ドメインの短文（1 segment） |
| `architecture-long-001` | 建築ドメインの長文（複数 segment） |
| `filler-001` | 「えーと」「あの」などのフィラー |
| `correction-001` | 発話中の言い直し |
| `numbers-units-001` | 寸法・面積・風量・速度・時刻 |
| `coding-001` | 固有名詞・英字略語・コマンド文字列 |

Case 本文はサーバー側（`src/benchmark/cases.ts`）が正本。client が送った本文は
使わないので、同じ `test_id` の Run 同士は必ず同じ文章を含む。

### 長文の分割と結合

450 code points を超えるテキストは、決定的な splitter（strategy `sentence-v1`）で
分割し、segment ごとに同じ Voice / Speed / Volume / 44100Hz / mono で生成してから
1 つの WAV に結合する。

```text
canonical text
    ↓  sentence-v1（paragraph → 。！？!? → 、 → safe punctuation → hard split）
segments（segments.join('') === canonical text）
    ↓  segment ごとに /audio_query → /synthesis
segment WAV
    ↓  RIFF/WAVE を parse し PCM を順に連結
audio.wav
```

結合時に無音挿入・normalization・denoise・silence removal・resample・gain 調整は
一切行わない。segment 間で format / channels / sampleRate / bitsPerSample /
blockAlign が一致しなければ Fail Closed として Run を保存しない。

途中の segment が 1 つでも失敗した場合も、official Run は作らない。

## Scripts

> **Windows PowerShell では `npm.cmd` を使う。** PowerShell は `npm.ps1` を拾うため、
> Execution Policy によっては `npm` が実行できない。`npm.cmd` はその制限を受けない。
> PowerShell 以外のシェルでは `npm` のままでよい。

| コマンド（PowerShell） | 内容 |
| --- | --- |
| `npm.cmd run dev` | 開発サーバー |
| `npm.cmd run build` | 本番ビルド |
| `npm.cmd start` | 本番サーバー |
| `npm.cmd run lint` | ESLint |
| `npm.cmd run typecheck` | `tsc --noEmit` |
| `npm.cmd test` | Vitest（**Engine 未起動でも実行可能**） |
| `npm.cmd run smoke:aivis` | 実 Engine への Manual Integration Smoke |

### Automated Tests

`npm.cmd test` は AivisSpeech Engine に一切接続しない。Provider に `fetchImpl` を注入し、
URL 構築・レスポンスマッピング・各段階のエラー伝播・WAV 検証・不正レスポンス処理を
すべてオフラインで検証する。

### Manual Integration Smoke

実 Engine を使う確認は `npm.cmd test` から分離してある。

```powershell
npm.cmd run smoke:aivis
npm.cmd run smoke:aivis -- --text "読み上げたいテキスト" --out out.wav
```

Engine が起動していない場合、`MANUAL_SMOKE_BLOCKED_ENGINE_NOT_RUNNING` を出力して
終了コード 2 で終わる。

## Repository Layout

```text
src/
├─ app/
│  ├─ page.tsx                    単一ページ UI
│  ├─ layout.tsx
│  ├─ globals.css
│  └─ api/
│     ├─ status/route.ts          接続状態 + Engine Version + /aivm_models
│     ├─ voices/route.ts          Voice / Style 一覧 + capabilities
│     ├─ cases/route.ts           Built-in Benchmark Case 一覧
│     ├─ generate/route.ts        Text -> immutable Run（Run metadata を返す）
│     └─ runs/[runId]/audio/route.ts  保存済み canonical audio.wav
├─ benchmark/
│  ├─ cases.ts                     Built-in Benchmark Case のサーバー側正本
│  ├─ splitter.ts                  決定的長文分割（sentence-v1）
│  ├─ generateBenchmark.ts         Run オーケストレーション（fresh evidence 解決）
│  └─ manifest.ts                  Manifest schema v2
├─ audio/
│  └─ wav.ts                       RIFF/WAVE parse + segment 結合
├─ storage/
│  └─ LocalRunStore.ts             transactional な immutable Run 保存
├─ lib/
│  ├─ engineConfig.ts             AIVIS_ENGINE_URL / runs ルートの解決
│  ├─ canonicalText.ts            改行コードのみの正規化
│  ├─ hash.ts                     SHA-256（Node 標準 crypto）
│  ├─ runId.ts                    server-generated Run ID と検証
│  └─ apiError.ts                 原因別 HTTP ステータスへの変換
└─ tts/
   ├─ TTSProvider.ts              Provider 境界（interface / error kinds）
   └─ AivisSpeechProvider.ts      AivisSpeech 専用 Adapter

scripts/
└─ aivis-smoke.mjs                Manual Integration Smoke

docs/
├─ INITIAL_PRODUCT_DIRECTION.md   プロダクト方針の初期記録
├─ PHASE1_ACCEPTANCE.md           Phase 1 の受け入れ基準
└─ architecture/
   └─ phase-1-plan.md             Phase 1 の設計方針と境界

data/runs/   Run 生成物の出力先（Git 管理外）
```

## License

未定（Phase 1 時点では未設定）。
