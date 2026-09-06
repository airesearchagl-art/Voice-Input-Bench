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

- STT（音声認識）
- 自動採点 / CER / LLM評価
- データベース
- SaaS化
- 認証 / 認可
- 課金
- クラウドデプロイ

## Reproducibility Model

本プロジェクトは **bit-exact regeneration を前提にしない**。

TTS エンジンはバージョン・モデル・実行環境によって出力が変わりうるため、
「同じ入力から同じバイト列が再生成できること」を再現性の定義には採用しない。

代わりに次を採る。

- **生成済み WAV そのものを canonical artifact として保持する。**
  再現性の基準は「再生成できること」ではなく「実際に評価に使った音声が残っていること」。
- **再生成は既存 Run を上書きしない。** 常に新しい Run として記録する。
- Run は生成条件（入力テキスト・Provider・エンジン情報・リクエスト内容）とともに保存する。

### 将来の Run Bundle 構成

```text
data/runs/<run-id>/
├─ source.txt           入力テキスト
├─ audio.wav            canonical artifact（正）
├─ provider-query.json  Provider へ送った実リクエスト
└─ manifest.json        Run メタデータ（ハッシュ・エンジン情報・パラメータ）
```

> Run Bundle の完成版は P1-B 以降で実装する。

## Phase 1 Breakdown

| Phase | 内容 |
| --- | --- |
| **P1-A** | Genesis baseline + AivisSpeech Contract Spike。最小ローカルWebアプリで `Text → WAV` を通す。Provider境界を確定させる。 |
| **P1-B** | Run 永続化。`data/runs/<run-id>` の immutable Run Bundle、Manifest、SHA-256、transactional write。 |
| **P1-C** | Benchmark Case と長文対応。Case selector、決定的な長文分割、segment WAV 結合、レポート出力。 |

現在地: **P1-A**

## Setup

### Requirements

- Node.js 20.9 以上（開発・検証は Node.js 24.15.0 / npm 11.12.1）
- [AivisSpeech](https://aivis-project.com/) または AivisSpeech Engine（ローカル起動）

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

```bash
npm install
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

```bash
npm run dev
```

<http://localhost:3000> を開く。

## Usage (P1-A)

1. ページ上部の **AivisSpeech Connection** が `Connected` になっていることを確認する
2. **Test Text** にテキストを入力する
3. **Voice / Style** を選ぶ
4. **Speed** / **Volume** を調整する
5. **Generate** を押す
6. **Output** の audio player で再生する

P1-A では音声を保存しない。生成した WAV はブラウザに返すだけで、
`data/runs/` への永続化は P1-B の範囲。

## Scripts

| コマンド | 内容 |
| --- | --- |
| `npm run dev` | 開発サーバー |
| `npm run build` | 本番ビルド |
| `npm start` | 本番サーバー |
| `npm run lint` | ESLint |
| `npm run typecheck` | `tsc --noEmit` |
| `npm test` | Vitest（**Engine 未起動でも実行可能**） |
| `npm run smoke:aivis` | 実 Engine への Manual Integration Smoke |

### Automated Tests

`npm test` は AivisSpeech Engine に一切接続しない。Provider に `fetchImpl` を注入し、
URL 構築・レスポンスマッピング・各段階のエラー伝播・WAV 検証・不正レスポンス処理を
すべてオフラインで検証する。

### Manual Integration Smoke

実 Engine を使う確認は `npm test` から分離してある。

```bash
npm run smoke:aivis
npm run smoke:aivis -- --text "読み上げたいテキスト" --out out.wav
```

Engine が起動していない場合、`MANUAL_SMOKE_BLOCKED_ENGINE_NOT_RUNNING` を出力して
終了コード 2 で終わる。

## Repository Layout

```text
src/
├─ app/
│  ├─ page.tsx                    P1-A の単一ページ UI
│  ├─ layout.tsx
│  ├─ globals.css
│  └─ api/
│     ├─ status/route.ts          接続状態 + Engine Version + /aivm_models
│     ├─ voices/route.ts          Voice / Style 一覧 + capabilities
│     └─ generate/route.ts        Text -> WAV
├─ lib/
│  ├─ engineConfig.ts             AIVIS_ENGINE_URL の解決
│  └─ apiError.ts                 原因別 HTTP ステータスへの変換
└─ tts/
   ├─ TTSProvider.ts              Provider 境界（interface / error kinds）
   └─ AivisSpeechProvider.ts      AivisSpeech 専用 Adapter

scripts/
└─ aivis-smoke.mjs                Manual Integration Smoke

docs/
├─ INITIAL_PRODUCT_DIRECTION.md   プロダクト方針の初期記録
└─ architecture/
   └─ phase-1-plan.md             Phase 1 の設計方針と境界

data/runs/   Run 生成物の出力先（Git管理外・P1-B で使用）
```

## License

未定（Phase 1 時点では未設定）。
