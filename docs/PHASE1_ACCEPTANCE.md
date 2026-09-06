# Phase 1 Acceptance

Phase 1 のゴールが満たされているかを、実装に対して確認するための基準。

```text
Phase 1 Goal:  Text → local TTS → canonical WAV + Manifest
```

この文書は「Phase 1 が終わったかどうか」を判定するためのものであり、
新しい要求を足す場所ではない。Phase 1 の範囲は
[`INITIAL_PRODUCT_DIRECTION.md`](INITIAL_PRODUCT_DIRECTION.md) と
[`architecture/phase-1-plan.md`](architecture/phase-1-plan.md) が正本。

## 1. 前提

- Node.js 24.x
- AivisSpeech（または AivisSpeech Engine）がローカルで起動していること
- 音声モデルが 1 つ以上インストールされていること

```powershell
npm.cmd install
npm.cmd run build
npm.cmd start
```

> Windows PowerShell では `npm.ps1` が Execution Policy に阻まれることがあるため、
> `npm.cmd` を使う。PowerShell 以外のシェルでは `npm` のままでよい。

## 2. Automated Acceptance

Engine を起動していない状態でも、次がすべて PASS すること。

```powershell
npm.cmd run lint
npm.cmd run typecheck
npm.cmd test
npm.cmd run build
```

テストは `fetchImpl` を注入する構造になっており、AivisSpeech Engine に一切接続しない。

## 3. Manual Acceptance

Engine を起動した状態で、ブラウザから次を確認する。

### 3.1 接続と Voice

| # | 確認 | 期待 |
| --- | --- | --- |
| 1 | ページ上部の AivisSpeech Connection | `Connected` |
| 2 | Engine Version | 実行中の Engine のバージョンが表示される |
| 3 | AIVM Models | インストール済みモデル数が表示される |
| 4 | Voice / Style selector | Engine の `/speakers` に対応した一覧が出る |

Engine を停止した状態では `Not connected` になり、Generate が有効化されないこと。

### 3.2 短文 Run（1 segment）

Test に `architecture-short-001` を選び、Generate。

| # | 確認 | 期待 |
| --- | --- | --- |
| 1 | Test ID | `architecture-short-001` |
| 2 | Segmentation | `none / 1 segment` |
| 3 | Run Bundle | `data/runs/<run-id>/` に 4 ファイル |
| 4 | audio player | 保存済み `audio.wav` が再生できる |
| 5 | manifest の hash | 実ファイルの SHA-256 と一致 |

### 3.3 長文 Run（multiple segments）

Test に `architecture-long-001` を選び、Generate。

| # | 確認 | 期待 |
| --- | --- | --- |
| 1 | Test ID | `architecture-long-001` |
| 2 | Segmentation | `sentence-v1 / N segment`（N > 1） |
| 3 | `source.txt` | Case 本文の全文と一致（欠落・重複なし） |
| 4 | `provider-query.json` | `segments` が N 件 |
| 5 | `audio.wav` | 結合済みで、最後まで再生できる |
| 6 | segment 境界 | 文字の欠落・重複・二重読みがない |
| 7 | manifest の hash | 実ファイルの SHA-256 と一致 |

### 3.4 immutability

| # | 確認 | 期待 |
| --- | --- | --- |
| 1 | 同じ Case をもう一度 Generate | 別の Run ID の Run が作られる |
| 2 | 既存の Run ディレクトリ | 変更されていない |
| 3 | Text SHA-256 | 同一テキストなので 2 つの Run で一致する |

## 4. Phase 1 完了条件

| 項目 | 内容 | 実装 |
| --- | --- | --- |
| Text → local TTS | ローカル AivisSpeech で音声を生成できる | P1-A |
| Provider 境界 | `TTSProvider` / `AivisSpeechProvider` | P1-A |
| canonical WAV | 生成済み WAV を canonical artifact として保存 | P1-B |
| Manifest | 生成条件とハッシュを記録 | P1-B / P1-C |
| canonical text | 改行コードのみ正規化、3 箇所で同一文字列 | P1-B |
| immutable Run | 上書きしない、transactional write | P1-B |
| Benchmark Case | 6 件の built-in case | P1-C |
| 長文対応 | `sentence-v1` splitter + segment WAV 結合 | P1-C |

## 5. Phase 1 の範囲外

以下は Phase 1 では**実装しない**。Acceptance の対象にもしない。

- Windows 音声入力への自動投入 / Aqua Voice への自動投入
  （固定 WAV の投入は Phase 1 では**手動**）
- STT 自動取得 / Whisper 連携
- CER / Semantic evaluation / LLM grading
- Critical Information Preservation の自動採点
- Markdown Report / SNS 連携
- データベース / ORM / 認証 / クラウド / Docker 必須化
- 2 つ目の TTS Provider

## 6. 既知の制約

- Run ディレクトリのファイルに読み取り専用属性は付けていない。immutability は
  「上書きしない設計 + 事前存在チェック + rename」で担保している。
- `fsync` は行っていない。OS レベルの電源断に対する耐性はない。
- Run の retention / cleanup はない。`data/runs/` は増え続ける。
- **P1-B で作成済みの Run**（manifest schema v1）は migration も rewrite もしない。
  アプリは v1 manifest を読まないので、v1 向けの reader も置いていない。
