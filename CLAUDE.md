# CLAUDE.md

このプロジェクトで作業する際は、まず以下を読むこと。

1. `docs/DESIGN.md` — アーキテクチャ、シナリオ、技術判断とその根拠
2. `docs/PLAN.md` — 実装フェーズ別のチェックリスト。ここに従って進める
3. `docs/findings-P0.md` / `docs/findings-P1.md` / `docs/findings-P2.md` — 技術調査の結果（一次情報の出典付き）。DESIGN.mdの記述と食い違う場合はこちらを一次情報として優先

## プロジェクト概要

電話×OpenAI Realtime API（gpt-realtime-2.1）を使った音声AIデモ。シナリオは架空の給湯器修理窓口サポート。個人のポートフォリオ用途。

構成: Twilio Media Streams ↔ 自前WebSocketブリッジ ↔ OpenAI Realtime API

## 厳守事項

- 実在メーカー名・実在エラーコードは使わない（架空の社名・エラーコード体系で統一）
- `.env` の秘匿情報はコミットしない
- 割り込み処理（`conversation.item.truncate` + Twilio `clear`）は自作せず、twilio-samplesの実装を踏襲する
- モデル・API仕様は変化が速い分野。実装中に疑問が出たら発表日の新しい情報を優先し、OpenAI公式ドキュメントで裏取りする

## private/ の扱い

`private/` は `.gitignore` で除外されている。**note / Notion への掲載用原稿を置く場所で、GitHubには上げない。**

- `private/` 配下のファイルを `docs/` へ戻したり、`git add -f` でコミットしたりしないこと
- 掲載用原稿（`writeup-draft.md` / `writeup-draft-note.md`）を編集する場合も、`private/` に置いたまま行う
