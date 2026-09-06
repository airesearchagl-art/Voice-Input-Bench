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

- Windows 音声入力への自動投入
- Aqua Voice への自動投入
- STT 自動取得 / Whisper 連携
- CER / Semantic evaluation / LLM grading
- Markdown Report
- SNS 連携
- データベース / ORM
- SaaS / 認証 / 課金
- クラウドデプロイ

Phase 1 において、生成済み WAV を Windows 音声入力や Aqua Voice へ投入する操作は
**手動**で行う。自動投入は Phase 1 の境界の外に置く。

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

#### Verification status (P1-A time of writing)

| 項目 | 状態 |
| --- | --- |
| 実行中 Engine の Swagger との突き合わせ | **未実施** |
| 実 API レスポンスとの突き合わせ | **未実施** |
| 根拠 | AivisSpeech Engine 公式ドキュメント記載の仕様 |

P1-A 実装時点で、ローカルの AivisSpeech Engine が起動していなかったため、
`http://127.0.0.1:10101/docs` および実レスポンスとの突き合わせは行えていない。

そのため実装は**防御的**に書いてある。

- `/version` は bare JSON string と `{ version }` オブジェクトの両方を受け付ける
- `/speakers` は要素・`styles`・`style.id` の形状を個別に検証する
- `/aivm_models` は失敗しても Engine Version の取得を巻き込まない probe として扱う
- `/audio_query` のレスポンスは形状を検証せず opaque に通す
- `/synthesis` は RIFF/WAVE ヘッダを検証する

想定と実レスポンスが食い違った場合は `MALFORMED_RESPONSE` として区別され、
接続エラーとは混同されない。**実 Engine での突き合わせは P1-A の残作業として残る。**

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

### 6.1 canonical source text

Run に残すテキスト・ハッシュ対象のテキスト・TTS へ渡すテキストが 1 文字でも食い違うと、
Manifest のハッシュが「実際に読み上げられた文字列」を指さなくなる。そのため Phase 1 では
**canonical text をひとつだけ定義し、3 箇所すべてで同じ文字列を使う**。

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

**canonicalization は改行コードの正規化だけ**（`\r\n` および `\r` を `\n` へ）。

禁止する変換:

| 禁止 | 理由 |
| --- | --- |
| trim | 前後の空白は入力内容の一部 |
| 全角 / 半角変換 | 読み上げ結果が変わりうる |
| Unicode 文字の置換（正規化形の変更を含む） | 入力内容の書き換えにあたる |
| 句読点の変更 | 韻律・区切りに直接影響する |
| 空白の圧縮 | 同上 |
| 誤字修正 | 評価対象そのものを書き換えてしまう |
| AI による整形 | 再現不能な変換を挟むことになる |

改行コードだけを対象にするのは、それが「入力内容の差」ではなく「入力経路の差」
（OS・エディタ・貼り付け元）に由来するノイズだから。それ以外の見た目上の差は
**評価対象そのもの**であり、bench 側で均してはならない。

`source.txt` には **canonical text** を保存する（「正規化前の原文」ではない）。
Text SHA-256 も canonical text に対して取り、TTS へも canonical text を渡す。

> canonicalization の実装は P1-B（Run 永続化）で行う。P1-A では契約の定義のみ。

### 6.2 Run Bundle

Run Bundle（P1-B 以降）:

```text
data/runs/<run-id>/
├─ source.txt           canonical text
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
- deterministic long-text splitter
- segment WAV assembly
- `architecture-long-001`
- Phase 1 UI completion
- Phase 1 Acceptance / README

P1-C をもって Phase 1 は完了する。評価・採点・入力自動化は §1 のとおり Phase 1 の範囲外。

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
