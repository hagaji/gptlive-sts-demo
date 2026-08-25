# 調査結果 P1（設計確定用）

実行: Sonnet / Agent 4体並列 / 2026-08-19

---

## P1-5: Twilio×OpenAI公式サンプル → **twilio-samples版を土台にする**

- **`twilio-samples/speech-assistant-openai-realtime-api-{node,python}`**: GA新スキーマに追従済み。今日cloneしてほぼ動く。修正推奨点は、モデル名を`gpt-realtime`(alias)→`gpt-realtime-2.1`に変更、`&temperature=`クエリの動作未検証な点の確認、TwiMLの`<Say voice="Google...">`がアカウント依存な点の確認、の3つ
- **`openai/openai-realtime-twilio-demo`（OpenAI公式）**: 廃止済みモデル・旧beta仕様のままで**今日はまず動かない**。ベースにしない
- 割り込み実装は `conversation.item.truncate`（発話済み範囲でアシスタントの発言を切り詰め）＋ Twilio側に`event:"clear"`送信、の2段構え。`response.cancel`は使っていない点に注意（design.mdの記述は概念的には合っているが、実装の主役は`truncate`+`clear`）

**→ design.mdの実装指針を更新**: 「土台は`twilio-samples/speech-assistant-openai-realtime-api-node`（またはpython版）をフォークし、modelを`gpt-realtime-2.1`に変更、音声フォーマットは既にGA新スキーマ対応済みなのでそのまま使える」

## P1-6: ConversationRelay → **今回は見送り、比較材料としても優先度を下げる**

speech-to-speechモデル（Realtime API）をそのまま組み込む仕組みがなく、テキストLLM前提のアーキテクチャ。GAだが今回の「speech-to-speechの間合い・感情表現を見せる」という趣旨とズレるため、design.mdの位置づけ通り「余力があれば」でよい。$0.07/分とMedia Streams($0.0044/分)より大幅に高いこともあり優先度は下げる

## P1-7: 公開URL → **Cloudflare Tunnel + 常時起動サーバー を推奨**

Render/Fly.ioの無料枠はアイドルでスリープする（デモ直前の着信で間に合わないリスク）。ngrok無料はタイムアウトなしになったが月1GB/20,000リクエストという明確な上限がある。**Cloudflare Tunnel（無料、独自ドメイン必要）を、常時稼働させたブリッジサーバー（自分のPC常駐 or Render Starter $7/月等）の前段に置く**構成が最も切れにくい

**→ design.mdの記述通りで問題なし**。「Render Starter $7/月をoriginにしてCloudflare Tunnelで公開」を具体的な推奨として明記

## P1-8: 日本語音声品質 → **実用レベル、ただし復唱確認は必須**

一次体験談では「AIだと知らなければ気づかないレベル」「コールセンター応対の実務品質」と肯定的評価が複数。ただし数字・電話番号のSTT誤認識、英語固有名詞の言語誤検出（英語/韓国語化）は実例あり。**mini版は数字系エラーが明記されているため今回は避ける（flagship=gpt-realtime-2.1を使う）**

回避テクニック:
- 重要情報（型番・電話番号・日時）は必ず復唱確認させる
- 英語固有名詞はカタカナ表記で与える
- 数字は「一桁ずつ区切って読む」よう指示する
- 発話を簡潔にするようプロンプトで指定する（長い発話ほど崩れやすい傾向）
- mini系モデルは電話デモでは避ける

---

## design.mdへの反映まとめ

1. 実装ベースは `twilio-samples/speech-assistant-openai-realtime-api-node`（またはpython）をフォーク。OpenAI公式サンプルは古いので使わない
2. モデルは `gpt-realtime-2.1`（flagship、miniは避ける）
3. 割り込み実装は元々サンプルに入っている（`conversation.item.truncate`+Twilio `clear`）。design.mdのリスク#2は「自分で書く」ではなく「サンプルの実装を理解して壊さない」に読み替え
4. ホスティングはCloudflare Tunnel＋常時起動サーバー（Render Starter等）
5. システムプロンプトに、数字の区切り読み・型番のカタカナ表記・復唱確認・簡潔な応答、を明記する
6. ConversationRelayは今回スコープ外（比較記事を書く場合のみ後回しで着手）

## 次のアクション
P2（9〜12、背景知識・法規制・競合事例）は必須ではない。着手判断は運用者次第。P0/P1の結果を踏まえてdesign.mdを改訂するか、そのまま実装に入るか。
