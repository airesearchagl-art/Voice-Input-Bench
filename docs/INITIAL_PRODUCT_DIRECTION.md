# Initial Product Direction

Voice Input Bench の初期方針を記録する。以降の設計判断はこの文書を出発点とする。

## Mission

音声入力・音声合成まわりの品質評価を、**再現可能な形で**残すためのローカルベンチ環境をつくる。

評価スコアそのものより、「そのスコアがどういう条件で出たのか」を後から検証できることを重視する。
評価結果は条件が失われた瞬間に価値を失う、という前提に立つ。

## Core Principles

### 1. Reproducibility First

再現性が最優先。速度・機能量・UIの洗練より優先する。

「あとから第三者が（あるいは半年後の自分が）その計測を検証できるか」を、
機能追加の可否判断における第一基準に置く。

### 2. Local First

実行はローカル完結を基本とする。

- ネットワーク常時接続を前提にしない
- クラウドサービスを必須依存にしない
- ローカルで動く TTS エンジンを一次的な対象とする

### 3. Free First

無料・オープンな選択肢を先に整える。

- 有料 API を必須依存にしない
- 商用 SaaS を必須依存にしない
- 有料選択肢は「あってもよい」が「なければ動かない」にはしない

## Phase 1 Definition

Phase 1 のスコープは次の一文に閉じる。

```text
Text → local TTS → canonical WAV + Manifest
```

テキストを入力すると、ローカル TTS エンジンで音声を生成し、
その音声と生成条件を、あとから検証できる形で保存する。ここまで。

### First Provider

最初に対応する TTS Provider は **AivisSpeech** とする。

理由:

- ローカル実行可能（Local First）
- 無料で利用可能（Free First）
- HTTP API を持ち、エンジンバージョン・音声モデル情報を取得できる（再現性の記録に必要）

### Provider Adapter 方式

将来の Provider 追加に備え、Provider 境界を最初から切る。

- 共通インターフェース `TTSProvider` を定義する
- Provider 固有の差異は各 Adapter の内側に閉じ込める
- ただし **Phase 1 で実装する Provider は `AivisSpeechProvider` のみ**

将来 Provider のためだけの Factory / DI Container / Repository Layer は作らない。
抽象は「2つ目の Provider が実際に来たとき」に必要な分だけ広げる。

## Out of Scope for Phase 1

以下は Phase 1 の対象外とする。Phase 1 の境界をこれらへ拡張しない。

### 入力自動化・評価系（Phase 1 外）

- Windows 音声入力への自動投入
- Aqua Voice への自動投入
- STT 自動取得
- Whisper 連携
- CER
- Semantic evaluation
- LLM grading
- Markdown Report
- SNS 連携

> Phase 1 において、生成済み WAV を Windows 音声入力や Aqua Voice へ投入する操作は
> **手動**で行う。自動投入は Phase 1 の範囲に含めない。

### 基盤系（Phase 1 外）

- データベース / ORM
- SaaS 化
- 認証 / 認可
- 課金
- クラウドデプロイ

## Reproducibility Model

### bit-exact regeneration は前提にしない

TTS の出力は、エンジンバージョン・音声モデル・実行環境・推論の非決定性によって変化しうる。
「同じ入力から同じバイト列が再生成できること」を再現性の定義に採用すると、
エンジン更新のたびに過去の計測がすべて無効になる。これは採らない。

### canonical artifact は「生成済み WAV そのもの」

再現性の基準を次のように定義する。

> 実際に評価に使った音声ファイルが、生成条件とともに残っていること。

つまり **生成済み WAV そのものを canonical artifact として保持する**。
WAV は再生成可能な中間物ではなく、Run の一次成果物として扱う。

### 再生成は既存 Run を上書きしない

同じテキスト・同じ設定で再度生成した場合も、既存 Run を更新しない。
**常に新しい Run として記録する。**

Run は immutable。これにより「いつの計測か」「どのエンジンでの結果か」が失われない。

### canonical source text

Run に残すテキストと、ハッシュを取るテキストと、TTS へ渡すテキストが食い違うと、
Manifest のハッシュが「実際に読み上げられた文字列」を指さなくなり、再現性が壊れる。
そのため Phase 1 では **canonical text をひとつだけ定義し、3 箇所すべてで同じ文字列を使う**。

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
それ以外の変換は一切行わない。

禁止する変換:

- trim（前後の空白除去）
- 全角 / 半角変換
- Unicode 文字の勝手な置換（正規化形の変更を含む）
- 句読点の変更
- 空白の圧縮
- 誤字修正
- AI による整形

改行コードだけを対象にするのは、それが「入力内容の差」ではなく「入力経路の差」
（OS・エディタ・貼り付け元）に由来するノイズであり、これを残すと同一テキストが
別ハッシュになってしまうため。逆に、それ以外の見た目上の些細な差は
**評価対象そのもの**なので、bench 側で勝手に均してはならない。

`source.txt` は「正規化前の原文」ではなく **canonical text** を保存する。
Text SHA-256 も canonical text に対して取り、TTS へも canonical text を渡す。

### Run Bundle

将来の Run 保存形式は次を想定する。

```text
data/runs/<run-id>/
├─ source.txt           canonical text（改行を LF に正規化した入力テキスト）
├─ audio.wav            canonical artifact
├─ provider-query.json  Provider へ実際に送ったリクエスト内容
└─ manifest.json        Run メタデータ
```

`data/runs/` は Git 管理外とする。canonical artifact はローカルに残すが、
リポジトリを音声バイナリで肥大させない。

## Phase Boundaries

### P1-A — Genesis + AivisSpeech Contract Spike

- Genesis baseline（本文書を含むドキュメント基盤）
- 最小ローカル Web アプリ（Next.js / TypeScript）
- `TTSProvider` インターフェース
- `AivisSpeechProvider` 実装
- `Text → WAV` を実際に通し、ブラウザで再生できるところまで
- AivisSpeech の実 API 契約を確認する（Contract Spike）

**P1-A の目的は「動く」ことではなく「AivisSpeech の実際の契約を確定させること」。**

### P1-B — Run Persistence

- `data/runs/<run-id>` の完成版
- immutable Run Bundle
- Manifest 完全実装
- Text SHA-256 / Audio SHA-256 の正式保存
- `provider-query.json` の保存
- transactional write（temp → final rename）

### P1-C — Benchmark Cases & Long Text

- Benchmark Case selector
- deterministic long-text splitter（長文の決定的分割）
- segment WAV assembly（segment WAV 結合）
- `architecture-long-001`
- Phase 1 UI completion
- Phase 1 Acceptance / README

P1-C をもって Phase 1 は完了する。評価・採点・入力自動化は Phase 1 の範囲外
（[Out of Scope for Phase 1](#out-of-scope-for-phase-1) を参照）。

受け入れ基準は [`PHASE1_ACCEPTANCE.md`](PHASE1_ACCEPTANCE.md)。

## Non-Goals（当面つくらないもの）

- 将来機能のためだけのディレクトリ階層
- 使う予定のない抽象レイヤー
- Provider が 1 つしかない段階での Provider Factory
- 汎用化された設定管理基盤
