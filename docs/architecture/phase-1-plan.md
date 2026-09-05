# Phase 1 Plan

Phase 1 の設計方針・境界・分割を定義する。

```text
Phase 1 Goal:  Text → local TTS → canonical WAV + Manifest
```

## 1. Scope

Phase 1 は「入力テキストから、ローカル TTS で音声を生成し、
その生成物と生成条件を検証可能な形で保存する」までを対象とする。

含むもの:

- ローカル Web アプリ（Next.js / App Router / TypeScript / Node.js）
- `TTSProvider` 境界
- `AivisSpeechProvider`（Phase 1 唯一の Provider 実装）
- WAV 生成とブラウザ再生
- Run Bundle 永続化（P1-B）
- Benchmark Case と長文対応（P1-C）

含まないもの:

- STT
- 自動採点 / CER / LLM 評価
- データベース / ORM
- SaaS / 認証 / 課金
- クラウドデプロイ

## 2. Provider Boundary

### 2.1 なぜ境界を切るか

Phase 1 の Provider は AivisSpeech ひとつだけ。それでも境界を切る理由は、
将来の差し替えのためというより、**責務の混線を最初に止めるため**。

TTS Provider が「ファイル保存」や「Manifest 生成」まで持つと、
Provider を増やしたとき保存仕様が Provider ごとに分裂する。
そうなる前に、Provider の責務を次の一行に固定する。

> **AivisSpeech へ要求を送り、Engine 情報・Voice 情報・WAV を取得する。**

### 2.2 インターフェース

```ts
interface TTSProvider {
  readonly id: string;

  getRuntimeInfo(): Promise<TTSRuntimeInfo>;

  listVoices(): Promise<TTSVoice[]>;

  getCapabilities(): Promise<TTSCapabilities>;

  generateSpeech(input: GenerateSpeechInput): Promise<GenerateSpeechResult>;
}
```

### 2.3 Provider に入れないもの

| 入れないもの | 置き場所 |
| --- | --- |
| filesystem 保存 | P1-B の Run 永続化層 |
| Manifest 生成 | P1-B の Run 永続化層 |
| Benchmark Case 管理 | P1-C |
| Hash 管理（SHA-256） | P1-B |
| 長文 Run 管理 / 分割 | P1-C |
| UI state | App 層（React） |

### 2.4 やらない抽象化

Provider が 1 つしかない段階で次は作らない。

- Provider Factory
- DI Container
- Repository Layer
- 汎用 Config 基盤

2 つ目の Provider が実際に必要になった時点で、必要な分だけ広げる。

## 3. AivisSpeech Contract Stance

### 3.1 VOICEVOX と同一視しない

AivisSpeech Engine は VOICEVOX ENGINE 互換の API 形状を持つが、**同一ではない**。

判明している差異（AivisSpeech 公式ドキュメント記載）:

- `intonationScale` の意味が異なる（全体のピッチではなく「感情表現の強さ」）
- `tempoDynamicsScale` は AivisSpeech 固有パラメータ
- `pauseLength` / `pauseLengthScale` は互換のために存在するが常に無視される
- `kana` は AquesTalk 記法ではなく通常の読みテキストを受け付ける
- `pitch` / `consonant_length` / `vowel_length` はダミー値を返し、変更は無視される
- `/aivm_models` は AivisSpeech 固有エンドポイント
- 歌唱合成 / モーフィング系エンドポイントは未実装

したがって「VOICEVOX の型定義を流用する」ことはしない。

### 3.2 Runtime を正とする

契約の正は **実行中の AivisSpeech Engine の Swagger と実 API レスポンス**とする。

```text
http://127.0.0.1:10101/docs
```

ドキュメントや他実装の型定義は参考情報にとどめ、実レスポンスと矛盾した場合は実レスポンスを採る。

### 3.3 AudioQuery を独自共通型へ変換しない

`/audio_query` のレスポンスを独自の共通型へマッピングし直すと、

- 未知フィールドが落ちる
- AivisSpeech 側の仕様変更に追従できない
- `/synthesis` に渡す JSON が元の契約から乖離する

ため、**AudioQuery は不透明（opaque）なオブジェクトとして扱い、そのまま `/synthesis` へ返す**。

アプリが変更するのは、UI で明示的に公開しているごく少数のフィールドのみ。

```text
speedScale         ← UI: Speed
volumeScale        ← UI: Volume
outputSamplingRate ← 固定 44100
outputStereo       ← 固定 false
```

それ以外のフィールドは読まず、書かず、そのまま通す。

### 3.4 基本フロー

```text
GET  /speakers
         ↓
     style ID
         ↓
POST /audio_query?text=...&speaker=<styleId>
         ↓
     AudioQuery（opaque）
         ↓
  speedScale / volumeScale / outputSamplingRate / outputStereo を上書き
         ↓
POST /synthesis?speaker=<styleId>   body: AudioQuery
         ↓
       WAV
```

## 4. Audio Settings Policy

### ユーザー変更可能（P1-A）

| 項目 | 対応する AudioQuery フィールド |
| --- | --- |
| Voice / Style | `speaker`（style ID, query param） |
| Speed | `speedScale` |
| Volume | `volumeScale` |

### 原則固定

| 項目 | 値 |
| --- | --- |
| Format | WAV |
| Sample Rate | 44100 |
| Stereo | false |

サンプルレートを固定するのは、Run 間の比較可能性を保つため。
可変にすると「音質差なのか設定差なのか」が事後に判別できなくなる。

### UI に出さない

`pitchScale` / `intonationScale` / `tempoDynamicsScale` /
`prePhonemeLength` / `postPhonemeLength` は UI に出さない。

ただしこれらを**削除・ゼロ埋め・再構築しない**。Engine が返した値をそのまま `/synthesis` へ渡す。
「出さない」は「壊す」ではない。

## 5. Error Handling Policy

エラーは原因別に区別する。握りつぶさない。空配列・空 WAV を正常扱いしない。

| 分類 | 意味 |
| --- | --- |
| `ENGINE_CONNECTION_FAILED` | Engine へ到達できない（未起動 / URL誤り / ネットワーク） |
| `SPEAKERS_FAILED` | `/speakers` が失敗した |
| `AUDIO_QUERY_FAILED` | `/audio_query` が失敗した |
| `SYNTHESIS_FAILED` | `/synthesis` が失敗した |
| `MALFORMED_RESPONSE` | 到達も応答もしたが、内容が期待形状でない |

`MALFORMED_RESPONSE` を独立させるのは、
「Engine は動いているが契約が想定と違う」を接続エラーと混同しないため。
Contract Spike ではこの区別自体が成果物になる。

## 6. Reproducibility Model

Phase 1 全体で次を前提とする。

- **bit-exact regeneration は前提にしない**
- **生成済み WAV そのものを canonical artifact として保持する**
- **再生成は既存 Run を上書きせず、新しい Run として記録する**

Run Bundle（P1-B 以降）:

```text
data/runs/<run-id>/
├─ source.txt
├─ audio.wav
├─ provider-query.json
└─ manifest.json
```

`data/runs/` および `.env` は Git 管理外。

## 7. Phase 1 Breakdown

### P1-A — Genesis + AivisSpeech Contract Spike

**目的: AivisSpeech の実際の契約を確定させること。**

- Genesis baseline（README / docs）
- 最小 Next.js アプリ（App Router / TypeScript）
- `AIVIS_ENGINE_URL` の環境変数化
- `TTSProvider` 境界
- `AivisSpeechProvider`
- `/version` `/speakers` `/aivm_models` `/audio_query` `/synthesis`
- 1 ページの UI（接続状態 / バージョン / テキスト / Voice / Speed / Volume / 生成 / 再生 / エラー）
- Engine 未起動でも実行できる Automated Test

P1-A では **Run の永続化を行わない**。WAV はレスポンスとしてブラウザへ返すのみ。

### P1-B — Run Persistence

- `data/runs/<run-id>` 完成版
- immutable Run Bundle
- Manifest 完全実装
- Text SHA-256 / Audio SHA-256 正式保存
- `provider-query.json` 保存
- transactional temp → final rename

### P1-C — Benchmark Cases & Long Text

- Benchmark Case selector
- long-text deterministic splitter
- segment WAV 結合
- `architecture-long-001`
- Windows / Aqua Voice 入力自動化
- STT / CER / LLM 評価 / Markdown Report

## 8. Suggested Structure

```text
src/
├─ app/
│  ├─ page.tsx
│  └─ api/
│     ├─ status/route.ts
│     ├─ voices/route.ts
│     └─ generate/route.ts
└─ tts/
   ├─ TTSProvider.ts
   └─ AivisSpeechProvider.ts
```

将来機能のためだけの階層は作らない。小さな `lib` の追加は必要に応じて可。
