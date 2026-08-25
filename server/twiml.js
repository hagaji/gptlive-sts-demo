// TwiML生成。/incoming-call と /voice の両方から使う。

// 発信者番号を受付キーに使うため、<Parameter>でMedia Streamsへ引き渡す。
// startイベントの customParameters で受け取れる。外部入力なので数字と+のみに正規化する。
// ブラウザ発信（Voice SDK）の場合、Fromは "client:xxxx" 形式でありPSTN番号ではないため除外する。
export const extractCallerNumber = (rawFrom) => {
    const from = String(rawFrom ?? '');
    if (from.startsWith('client:')) return '';
    return from.replace(/[^0-9+]/g, '');
};

// 接続待ちのリンリン音は<Play>ではなくMedia Streams経由で直接ストリーミングする（server/index.jsのRING_TONE_FRAMES参照）。
// <Play>は<Connect>より前に完了させる必要があり、その間はTwilio⇄サーバーのWebSocket接続すら
// 存在しないため、裏でOpenAI接続を並行して進めることができなかった（順次実行のため）。
// テキスト読み上げの<Say>もここでは使わない（AI応答の声=marinと声が変わって不自然になるため。名乗りはAI側にやらせる方針）。
//
// terminationMessage: 会話継続不能エラー・タイムアウトでサーバー側が通話を切った場合にのみ再生される
// （<Connect><Stream>はストリーム終了後に次のverbへ進む。正常終話は発信者が切るので再生されない）。
export const buildStreamTwiml = (host, callerNumber, terminationMessage) => `<?xml version="1.0" encoding="UTF-8"?>
                          <Response>
                              <Connect>
                                  <Stream url="wss://${host}/media-stream">
                                      <Parameter name="callerNumber" value="${callerNumber}" />
                                  </Stream>
                              </Connect>
                              <Say voice="Google.ja-JP-Chirp3-HD-Aoede" language="ja-JP">${terminationMessage}</Say>
                              <Hangup/>
                          </Response>`;
