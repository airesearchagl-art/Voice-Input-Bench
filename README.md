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

> セットアップ手順は P1-A のアプリ実装とあわせて追記する。

## Repository Layout

```text
docs/
├─ INITIAL_PRODUCT_DIRECTION.md   プロダクト方針の初期記録
└─ architecture/
   └─ phase-1-plan.md             Phase 1 の設計方針と境界

data/runs/   Run 生成物の出力先（Git管理外）
```

## License

未定（Phase 1 時点では未設定）。
