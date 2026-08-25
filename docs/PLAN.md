# PLAN.md
## 実装計画（Claude Code 用）

前提: DESIGN.md を先に読むこと。技術判断の根拠は findings-P0.md / findings-P1.md に一次情報付きで記載済み。

このファイルはフェーズごとにチェックリスト形式で進める。各フェーズの完了条件(DoD)を満たしてから次に進むこと。

---

## Phase 0: アカウント・番号準備（人間の作業が中心、コード作業なし）

- [x] Twilioアカウントを作成（**有料化は不要だった**。当初「トライアルでは `<Stream>` がブロックされる」としていたが、2026-08-25に実機で覆り、お試しクレジットの範囲・トライアルのまま動作した。詳細は bottlenecks.md）
  - 残課題: トライアル特有の英語アナウンスは入ったままなので、デモの体裁を整えるなら有料化する。また**PSTN着信での `<Stream>` 動作は未検証**
- [ ] Twilio Console から US ローカル番号を購入（本人確認不要のはず。取得できない場合はfindings-P0.mdのP0-1不明点を再確認）
- [ ] OpenAI APIキーを取得。Realtime API利用可否と組織のSpend Limit（ハードリミット）を設定しておく（findings-P0.mdのP0-4参照。安全弁として必須）
- [ ] `.env` に `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `OPENAI_API_KEY` を保存（**絶対にコミットしない**。`.gitignore`に追加）

**DoD**: Twilio Consoleで番号が有効化されており、OpenAI APIキーでRealtime APIに接続できることを確認済み。

---

## Phase 1: ブリッジサーバーの骨格（オウム返しレベル）

- [x] `twilio-samples/speech-assistant-openai-realtime-api-node` を clone、または参考にして `server/` 配下に実装を書き起こす
- [x] `model` を `gpt-realtime-2.1` に変更（サンプルはalias `gpt-realtime` のまま。findings-P1.mdのP1-5参照）
- [x] セッション設定がGA新スキーマ（`audio.input.format`/`audio.output.format`のネスト形式）になっていることを確認
- [ ] `&temperature=` クエリパラメータの要否を検証。GA公式ドキュメントに記載がないため、動作確認して不要なら削除（未着手。現状は残したまま動いている）
- [ ] TwiMLの `<Say voice="Google...">` がTwilioアカウントで使えるか確認。使えなければデフォルト音声に差し替え（接続確認では発話箇所まで到達していないため未検証）
- [x] ローカルでサーバーを起動し、Cloudflare Tunnel（`cloudflared tunnel --url http://localhost:<port>`）で一時公開
- [x] **経路をPSTN番号からTwilio Voice SDK（ブラウザ）に変更**（findings-P0.md P0-4追記の判断。国際通話料を避け、テストを安く回すため）。TwiML AppのVoice Request URLに `https://<tunnel-url>/voice` を設定
- [x] ブラウザから発信し、system instructionsを「オウム返ししてください」程度にしてまず**音声が往復すること**を確認 → **2026-08-20 確認済み**

**DoD**: ブラウザ（Voice SDK）またはPSTN電話から発信すると、こちらの発話に対してAIが（内容は何でもいいので）音声で応答する。→ **達成**（ブラウザ発信で確認。PSTN経由での確認はPhase 0の番号取得後、Phase 5で行う）

---

## Phase 2: 割り込み処理の確認

- [x] サンプルに含まれる `conversation.item.truncate` + Twilio `clear` イベントのロジックを読んで理解する（自作しない。DESIGN.md 4章参照。実装済みのまま変更していない）
- [x] AIが話している最中にこちらが話し始めて、AI発話が即座に止まることを実機で確認 → **2026-08-20 動作確認**（他フェーズのテスト中に自然に発話が被る場面があり、問題なく動いていた）
- [ ] 早口で被せる、小さい声で被せる、無音の相槌（「うん」）など**意図的な数パターン**での誤爆・無反応チェックはまだ。上記は偶発的な確認であり、狙ったテストではない

**DoD**: 割り込みが安定して機能する。AIが話し続けて会話が壊れるケースがない。→ **暫定達成、パターンテストは未実施**。基本動作は複数回の実接続を通じて壊れていないことが分かっているが、意図した3パターンの通しテストはまだやっていない。優先度は下げてよいと判断（他のフェーズのテスト中に何度も自然な割り込みが発生しているが、これまで一度も破綻の報告がないため）。

---

## Phase 3: シナリオ実装

- [x] `scenario/system-prompt.md` に給湯器修理窓口のsystem instructionsを書く（DESIGN.md 3章の必須指示を全て含める: 金額確約禁止、復唱確認、カタカナ表記、数字の区切り読み、簡潔な応答、危険ワード即エスカレーション）
- [x] ダミーデータを用意: `data/error-codes.json`（架空のエラーコード表、10件）、`data/availability.json`（架空の空き枠、dayOffsetによる相対生成）
- [x] function calling ツールを4本実装（`server/tools.js`。すべてダミーロジック）:
  - [x] `lookup_error_code(code)`
  - [x] `check_availability(area, date_range)` — `area`は東京23区の区名。`server/tools.js`の`WARD_TO_AREA`で区名→内部4方面エリアへマッピングし、マッチしなければ`inServiceArea:false`
  - [x] `book_visit(name, slot_id, callback_phone)` — phoneは発信者番号を既定利用するため引数から外した（bottlenecks.md/writeup参照）。住所は聞き取り不要と判断し、2026-08-20に引数から削除
  - [x] `escalate_emergency(reason)`
- [x] OpenAI Realtime APIのtool定義としてこれらを登録し、セッション設定に含める（`server/index.js` の `TOOLS`）
- [x] `response.done` → `function_call` 検出 → 実行 → `conversation.item.create`(function_call_output) → `response.create` の一連を実装
- [x] 受付情報（氏名・電話番号）は**ファイルにもDBにも永続化しない**。プロセス内メモリ（`bookedSlotIds`のみ）に留め、通話終了時に破棄する
- [x] コンソールログにも個人情報を出さない。電話番号は下4桁のみ、氏名は出力しない
- [x] 会話ログ（テキスト起こし）の保存は**見送り**。デバッグはコンソールの標準ログで進める
- [x] 通話の能動的な切断（`escalate_emergency`後／`book_visit`完了後／`check_availability`が`inServiceArea:false`を返した後、AIが応答を話し終えたタイミングでTwilio REST APIから`calls(callSid).update({status:'completed'})`）。OpenAI Realtime API自体には通話を切る機能がないため、AI発話の完了を`markQueue`（既存の音声再生完了追跡）で検知してサーバー側から切る
- [x] 繋ぎっぱなしによる課金増加の安全弁: `MAX_CALL_DURATION_MS`（デフォルト300秒=5分、実測で1ターンの会話が4分程度かかることがあるため）を超えたら`terminateCallWithError`経由で強制切断。タイムアウトロジック自体は未実測（ダミーキーではOpenAI接続エラーが先に発火してしまい検証できなかった）
- [x] 営業エリアを東京23区内に限定。23区外の区名・他都道府県が渡された場合は`check_availability`が`inServiceArea:false`を返し、AIが「23区外のため受付できません」と案内して自動切断

**実接続で確認済み（2026-08-20）**: ブラウザから「ガス臭い」と発話 → `escalate_emergency`発火 → guidance+demoNoticeを読み上げ → 読み上げ完了後に自動で通話切断、まで一連で成功。Voice SDK発信のCallSidに対してもREST APIでの切断が機能することも実証された（未検証としていた懸念が解消）。

**実接続で確認済み（2026-08-20）**: 通常フロー（エラーコードを話す → `lookup_error_code` → `check_availability` → 氏名・住所聞き取り → `book_visit` → 受付完了）も一連で確認できた。※この時点ではまだ住所を聞く旧仕様。区名ベース・住所廃止への変更後は未接続確認（下記参照）。

**実接続で確認済み（2026-08-20）**: `book_visit`完了後の自動切断も実証された。ログで`Call ended via Twilio API. reason: booking_complete`を確認。`escalate_emergency`・`book_visit`両方の自動切断経路が実接続で動くことが分かった。

**未検証**: 2026-08-20の変更（住所廃止・区名ヒアリング・23区外判定・自動切断・5分タイムアウト）は、コードレベルの検証（構文チェック・ユニット的な`tools.js`の動作確認・ダミーキーでの`session.update`内容確認）は済んでいるが、実際のOpenAI APIキーでの会話フロー（区名を話す→`check_availability`→予約完了 or 23区外での自動切断）はまだ試していない。

**DoD**: 電話（またはブラウザ）で「お湯が出ない」「型番わからない」と話しかけると、ツールを正しく呼び分けながら会話が進み、最終的に予約が完了する。→ **達成**

---

## Phase 4: 難しい入力での調整

DESIGN.md 3章の5パターンで通しテストする:
- [ ] 型番が分からない客
- [ ] 話が脱線する客
- [ ] 途中で言い直す客（日付の訂正）
- [ ] AIの発話に被せて割り込む
- [ ] 「ガスの臭いがする」（緊急分岐）

各パターンで気になった応答をsystem promptに反映し、再テストする。このフェーズは反復が前提。

**DoD**: 5パターン全てで、少なくとも「破綻しない」応答ができる。特に緊急分岐は確実に発火すること。

---

## Phase 5: 常設化・録画

- [ ] Cloudflare Tunnelに固定ドメインを設定（独自ドメインが必要。findings-P1.mdのP1-7参照）、またはRender Starter等に本番デプロイ
- [ ] デモ数時間前に実際に試験着信して疎通確認する
- [ ] デモの様子を録画（画面 or 音声）し、ポートフォリオ用の成果物として保存

**DoD**: 公開URLが安定して稼働し、録画データが手元にある。

---

## ファイル構成（現状）

```
gptlive-sts-demo/
├── CLAUDE.md
├── README.md
├── .env                        # 秘匿情報、.gitignore対象
├── .gitignore
├── docs/
│   ├── DESIGN.md / PLAN.md / research-tasks.md
│   ├── findings-P0.md / P1.md / P2.md
│   └── bottlenecks.md          # 電話まわりの隘路事項
├── private/                    # .gitignore対象。GitHubには上げない
│   ├── writeup-draft.md        # Notion掲載用（LT補足資料）
│   ├── writeup-draft-note.md   # note掲載用
│   └── figures-guide.md        # note/Notionへの図の載せ方
├── server/
│   ├── index.js                # ブリッジサーバー本体（/incoming-call, /voice, /token, /media-stream）
│   ├── twiml.js                 # TwiML生成（extractCallerNumber, buildStreamTwiml）
│   ├── twiml.test.js           # twiml.jsのユニットテスト
│   ├── tools.js                # function calling 4本のダミー実装
│   ├── tools.test.js           # tools.jsのユニットテスト
│   ├── tone.js                 # リンリン音の波形定義（単一ソース）
│   ├── tone.test.js            # tone.jsのユニットテスト（以上3つ、node --testで一括実行）
│   ├── package.json
│   ├── client/app.js           # Voice SDKクライアント（esbuildでbundle.jsにビルド）
│   ├── scripts/generate-connecting-tone.mjs  # リンリンのWAV書き出し（単体確認用、必須ではない）
│   └── public/
│       ├── index.html          # ブラウザ入り口
│       ├── bundle.js           # ビルド生成物、.gitignore対象
│       └── connecting.wav      # ビルド生成物、.gitignore対象
├── scenario/
│   ├── system-prompt.md        # システムプロンプト本体
│   ├── tools.json              # function callingツール定義（session.updateへの単一ソース）
│   ├── prompt-fragments.json   # 実行時に動的組み立て・注入される文言（発信者番号セクション等）
│   └── tools-spec.md           # ツール仕様の説明（JSON定義はtools.json参照）
└── data/
    ├── error-codes.json        # 架空エラーコード表
    └── availability.json       # 架空の空き枠（dayOffsetで相対生成）
```

## 進め方の注意

- Phase 0は人間（運用者）の作業が中心。Claude Codeはコード作業のみ担当し、APIキー等の機密情報の扱いは`.env`経由に統一する
- 各Phaseの完了条件を満たさずに次に進まない。特にPhase 1〜2は実機での耳による確認が必須で、コードのレビューだけでは完了と判断しない
- モデル名・イベント名・料金は変化が速い分野。実装中に挙動が本ドキュメントの記載と食い違ったら、まずOpenAI公式ドキュメント（developers.openai.com/api/docs）で現行仕様を確認すること
