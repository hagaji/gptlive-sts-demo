# function calling ツール定義（Phase 3）

OpenAI Realtime APIの `session.update` に含める `tools` 配列の元になる定義。4本すべてダミー実装でよい（`data/error-codes.json` / `data/availability.json` を参照するローカルロジック）。

**JSON Schema定義そのものは [`scenario/tools.json`](tools.json) を単一ソースとする。** `server/index.js` はこのファイルをそのまま読み込んで `session.update` の `tools` に渡す（二重管理を避けるため、このドキュメントにはJSON定義を転記しない）。以下は各ツールの設計意図と実装の補足。

---

## 1. lookup_error_code

**実装**: `data/error-codes.json` の `errorCodes` 配列を `code` で検索。一致なしの場合は `{ "found": false }` を返し、AIには「コードが確認できませんでした。症状を教えてください」と案内させる。

返り値には `selfResolutionGuidance`（その場で試す対処）と `interimGuidance`（予約後、訪問までの待機案内）が入る。用途が違うので混ぜないこと。前者は一次切り分けで、後者は終話時に一言だけ使う。

## 2. check_availability

**実装**: 会社の営業エリアは**東京23区内のみ**。区名 → 内部エリア（東西南北）のマッピングテーブル（`server/tools.js` の `WARD_TO_AREA`）を持ち、23区を地理的に4分割している。

- 東エリア: 台東区・墨田区・江東区・荒川区・葛飾区・江戸川区・足立区
- 南エリア: 港区・品川区・目黒区・大田区・世田谷区
- 西エリア: 新宿区・渋谷区・中野区・杉並区・豊島区・練馬区
- 北エリア: 千代田区・中央区・文京区・北区・板橋区

渡された区名がこのマッピングに無い場合（23区外・他都道府県）は `{ "inServiceArea": false, "ward": "<渡された区名>" }` を返す。AIはこれを見て「23区外のため受付できません」と案内し、通話を終える（予約フローには進まない）。

マッピングにある場合は `data/availability.json` の `slotTemplates` から該当する内部エリアかつ `status: "available"` のものを抽出し、**呼び出し時の現在日付に `dayOffset` を足して実日付を生成**する。`slotId` は `${templateId}-${YYYYMMDD}`。日付を固定値で持たないこと（デモ当日に過去日を案内する事故を防ぐため）。

返り値には `inServiceArea: true`、`ward`（正規化後の区名）、日付を `date`（`2026-08-21` 形式）と `dateSpoken`（`八月二十一日 金曜日` のような読み上げ用）の両方で入れる。AIには `dateSpoken` を読ませる。`date_range` はダミー実装では簡易フィルタ（該当なければ全件返す）でよい。

## 3. book_visit

**実装**: 予約番号は発行しない（口頭で伝えても相手が控えられず意味がないため）。**受付のキーは折り返し先の電話番号**とする。

- `callback_phone` 未指定時は、Twilioの発信者番号（`start`イベントの`customParameters.callerNumber`）をサーバー側で補う
- 返り値に確認用の下4桁を含め、AIにはこれを読み上げさせる（番号全体を読ませない）
- **発信者番号も `callback_phone` も無い場合は予約を確定させず、`{ "accepted": false, "reason": "callback_phone_required" }` を返す**。AIには折り返し先の電話番号を聞き取らせてから再度呼ばせる（非通知着信・番号取得失敗時の保険）

返り値の例:
```json
{
  "accepted": true,
  "receptionPhoneLast4": "5678",
  "symptomSummary": "お湯が出ない、エラーコードAS-01"
}
```

案内文言（「お電話番号の下四桁で受付いたしました」等）はAI側がプロンプトの指示に従って組み立てる。ツールの返り値には数字と要約のみを含め、読み上げ文の生成はAIに任せている。

該当`slot_id`のstatusを`booked`に更新するのはプロセス内メモリで完結でよい。

**受付情報は永続化しない（方針）**: 氏名・電話番号をファイルやDBに書き出さない。プロセス内メモリに留め、通話終了時に破棄する。デモに不要な個人情報を保持しないため。運用時に記録が必要になった場合に改めて設計する。

## 4. escalate_emergency

**実装**: 固定文言を返す。予約フローには進まず、有人窓口へ転送する体裁で終話する。

```json
{
  "guidance": "安全のため、ただちに給湯器のご使用を中止し、ガス栓を閉めて窓を開けてください。火気は使用しないでください。これより担当者におつなぎいたします。",
  "demoNotice": "――ただいまのデモでは実際の転送は行われません。AIとの通話はここまでとなります。"
}
```

AIは `guidance` を案内した直後に `demoNotice` をそのまま読み上げ、通話を終える。通常の予約フローに戻らないこと。

`demoNotice` を分けてあるのは、本番想定の応対（`guidance`）とデモの断り書きを混ぜないため。実運用に寄せる場合は `demoNotice` を落として実際の転送処理に差し替える。

---

## 実装メモ

- JSON Schema定義は `scenario/tools.json`。`server/index.js` が起動時に読み込み、そのまま `session.update` の `tools` 配列に渡す
- **会話継続が不可能なエラー**（OpenAI WebSocketの切断・接続エラー、および`MAX_CALL_DURATION_MS`超過による強制切断）は、AIに喋らせずサーバー側で終話させる。`server/index.js` の `terminateCallWithError()` がTwilio側のWSを閉じ、TwiMLの末尾に置いた `<Say>`＋`<Hangup/>` が終話メッセージを読み上げる。OpenAIが落ちている状況ではAIに発話させられないため、この経路はモデルに依存しない
- 一方、Realtime APIが返す `error` タイプのイベントは終話させない。割り込み時の `conversation.item.truncate` などで日常的に発生し、会話は継続できるため。ログに残すだけでよい
- 関数の実行結果は `conversation.item.create`（`type: "function_call_output"`）でOpenAI側に返す実装が必要（twilio-samplesのベースコードには含まれていないため、Phase 3で追加実装が要る）
- ダミーロジックは `server/tools.js` のような別ファイルに分離することを推奨（`index.js`が肥大化するため）
- **通話の能動的な切断**: OpenAI Realtime API自体には通話を切る手段がない。`escalate_emergency`・`book_visit`（受付完了）・`check_availability`（`inServiceArea: false`）のいずれかが呼ばれたら`pendingCallEndReason`を立て、AIがその応答を話し終えた（`markQueue`が空になった）タイミングでTwilio REST APIの`calls(callSid).update({status:'completed'})`を叩いて切る。呼ばれた瞬間に切るとAIの発話が途中で切れるため、必ず`markQueue`経由で「話し終わった」ことを確認してから切る
