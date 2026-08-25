// Base: twilio-samples/speech-assistant-openai-realtime-api-node (MIT License)
// See LICENSE-twilio-samples.txt. Modified for this project (model, prompt, voice).
import path from 'path';
import { fileURLToPath } from 'url';
import Fastify from 'fastify';
import WebSocket from 'ws';
import dotenv from 'dotenv';
import fs from 'fs';
import twilio from 'twilio';
import fastifyFormBody from '@fastify/formbody';
import fastifyWs from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import alawmulaw from 'alawmulaw';
import { toolHandlers } from './tools.js';
import { generateRingToneSamples } from './tone.js';
import { extractCallerNumber, buildStreamTwiml } from './twiml.js';

// Load environment variables from .env file
dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Retrieve the OpenAI API key from environment variables.
const { OPENAI_API_KEY, TWILIO_ACCOUNT_SID, TWILIO_API_KEY, TWILIO_API_SECRET, TWILIO_TWIML_APP_SID } = process.env;

if (!OPENAI_API_KEY) {
    console.error('Missing OpenAI API key. Please set it in the .env file.');
    process.exit(1);
}

// ブラウザ発信口（/token, /call）に必要な設定が揃っているか。
// 未設定でも電話経由（/incoming-call）は動かしたいので、ここではプロセスを落とさない。
const voiceSdkConfigured = Boolean(TWILIO_ACCOUNT_SID && TWILIO_API_KEY && TWILIO_API_SECRET && TWILIO_TWIML_APP_SID);
if (!voiceSdkConfigured) {
    console.warn('Twilio Voice SDK credentials are not fully set. /token and browser calling will be unavailable.');
}

// 通話の能動的な切断（escalate_emergency後、book_visit完了後）に使うRESTクライアント。
// Account SID/Auth Tokenではなく、Voice SDKと同じAPI Key/Secretで認証する（型定義上、
// constructor(username, password, {accountSid}) はAPI Key認証に対応している）。
const twilioRestClient = voiceSdkConfigured
    ? twilio(TWILIO_API_KEY, TWILIO_API_SECRET, { accountSid: TWILIO_ACCOUNT_SID })
    : null;

// Initialize Fastify
const fastify = Fastify();
fastify.register(fastifyFormBody);
fastify.register(fastifyWs);
fastify.register(fastifyStatic, {
    root: path.join(__dirname, 'public'),
    prefix: '/',
});

// Constants
const scenarioPath = (...segments) => path.join(__dirname, '..', 'scenario', ...segments);
const loadJson = (...segments) => JSON.parse(fs.readFileSync(scenarioPath(...segments), 'utf8'));

// scenario/system-prompt.md の```コードブロックがプロンプト本体。単一ソースを保つため
// ドキュメントからそのまま抽出する（コピーして二重管理にしない）。
const loadSystemPrompt = () => {
    const md = fs.readFileSync(scenarioPath('system-prompt.md'), 'utf8');
    const match = md.match(/```\n([\s\S]*?)```/);
    if (!match) {
        throw new Error('scenario/system-prompt.md からプロンプト本体（```コードブロック）を抽出できませんでした。');
    }
    return match[1].trim();
};
const SYSTEM_MESSAGE = loadSystemPrompt();

// function calling ツール定義。実装はtools.js。scenario/tools-spec.mdと二重管理にならないよう
// JSON Schema定義そのものはscenario/tools.jsonを単一ソースとする。
const TOOLS = loadJson('tools.json');

// 実行時に動的組み立て・注入されるプロンプト断片。system-prompt.md本体には含まれない。
const PROMPT_FRAGMENTS = loadJson('prompt-fragments.json');
// marin/cedarが公式に最高品質として推奨されている（日本語での比較は未確認、要実聴）。
const VOICE = 'marin';
// PLAN.md Phase1: `&temperature=`クエリの要否は未検証（GA公式ドキュメントに記載なし）。
// 動作確認できたら不要なら削除する。findings-P1.md参照。
const TEMPERATURE = 0.8;
const PORT = process.env.PORT || 5050; // Allow dynamic port assignment

// List of Event Types to log to the console. See the OpenAI Realtime API Documentation: https://platform.openai.com/docs/api-reference/realtime
const LOG_EVENT_TYPES = [
    'error',
    'response.content.done',
    'rate_limits.updated',
    'response.done',
    'input_audio_buffer.committed',
    'input_audio_buffer.speech_stopped',
    'input_audio_buffer.speech_started',
    'session.created',
    'session.updated'
];

// Show AI response elapsed timing calculations
const SHOW_TIMING_MATH = false;

// サーバー側から通話を強制終了する場合（会話継続不能エラー／長時間接続タイムアウト）の終話メッセージ。
// <Connect><Stream>はストリーム終了後に次のverbへ進むため、TwiMLの末尾に置いておき、
// サーバー側がWebSocketを閉じた時だけ再生される（正常終話は発信者が切るので再生されない）。
// TwiMLは通話開始時に1つの文字列として固定されるため、理由ごとに文言を出し分けられない。
// エラーでもタイムアウトでも不自然にならない汎用文言にしてある（区別はログのreasonでつける）。
const CALL_TERMINATION_MESSAGE = PROMPT_FRAGMENTS.callTerminationMessage;

// 繋ぎっぱなしによるTwilio課金の際限ない増加を防ぐ安全弁。この時間を超えたら強制的に通話を切る。
// デモなので5分（300秒）に固定。実測で1ターンの会話が4分程度かかることもあるため、
// これより短くすると通常の会話すら打ち切ってしまう。
const MAX_CALL_DURATION_MS = Number(process.env.MAX_CALL_DURATION_MS) || 300 * 1000;

// リンリン音をMedia Streams用のμ-law 20msフレーム(Base64)に事前変換しておく。
// 接続確立直後からTwilioへ流し始め、AIの最初の音声が届いた時点で打ち切る
// （<Play>による順次実行の待ち時間をなくし、接続処理と並行させるため）。
const RING_TONE_FRAME_MS = 20;
const RING_TONE_SAMPLE_RATE = 8000;
const RING_TONE_FRAMES = (() => {
    const floatSamples = generateRingToneSamples();
    const int16Samples = Int16Array.from(floatSamples.map((v) => {
        const clamped = Math.max(-1, Math.min(1, v));
        return Math.round(clamped * 32767);
    }));
    const mulawBytes = alawmulaw.mulaw.encode(int16Samples);
    const samplesPerFrame = Math.round((RING_TONE_SAMPLE_RATE * RING_TONE_FRAME_MS) / 1000); // 160

    const frames = [];
    for (let i = 0; i < mulawBytes.length; i += samplesPerFrame) {
        frames.push(Buffer.from(mulawBytes.slice(i, i + samplesPerFrame)).toString('base64'));
    }
    return frames;
})();

// 受付キーは折り返し先の電話番号。確認は下4桁のみ読み上げる（番号全体は読ませない）。
const lastFourDigits = (phone) => {
    const digits = String(phone ?? '').replace(/\D/g, '');
    return digits.length >= 4 ? digits.slice(-4) : null;
};

// Health check（静的配信の "/" にindex.htmlを譲るため、ヘルスチェックは別パスにしてある）
fastify.get('/health', async (request, reply) => {
    reply.send({ message: 'Twilio Media Stream Server is running!' });
});

// Route for Twilio to handle incoming PSTN calls
fastify.all('/incoming-call', async (request, reply) => {
    const callerNumber = extractCallerNumber(request.body?.From ?? request.query?.From);
    reply.type('text/xml').send(buildStreamTwiml(request.headers.host, callerNumber, CALL_TERMINATION_MESSAGE));
});

// TwiML App の Voice Request URL。ブラウザ（Twilio Voice SDK）からの発信はここに届く。
// PSTN着信と処理は同じで、発信者番号だけ取れない（＝聞き取りモードにフォールバックする）。
fastify.all('/voice', async (request, reply) => {
    const callerNumber = extractCallerNumber(request.body?.From ?? request.query?.From);
    reply.type('text/xml').send(buildStreamTwiml(request.headers.host, callerNumber, CALL_TERMINATION_MESSAGE));
});

// ブラウザクライアント用のAccess Token発行。
// Account SID/Auth Tokenではなく、トークン署名専用のAPI Key/Secretを使う
// （漏洩時に取り消せる範囲を限定するため。findings-P1.md参照）。
fastify.get('/token', async (request, reply) => {
    if (!voiceSdkConfigured) {
        reply.code(503).send({ error: 'Voice SDK is not configured on the server.' });
        return;
    }

    const AccessToken = twilio.jwt.AccessToken;
    const VoiceGrant = AccessToken.VoiceGrant;

    // 単一ユーザー想定のローカルデモなので固定identityでよい。
    // 将来Cloudflare Accessでメアド制限をかける際は、認証済みメアドをidentityに使う想定。
    const identity = 'demo-web-user';

    const voiceGrant = new VoiceGrant({
        outgoingApplicationSid: TWILIO_TWIML_APP_SID,
        incomingAllow: false, // ブラウザ側での着信は使わない
    });

    const token = new AccessToken(TWILIO_ACCOUNT_SID, TWILIO_API_KEY, TWILIO_API_SECRET, {
        identity,
        ttl: 3600,
    });
    token.addGrant(voiceGrant);

    reply.send({ token: token.toJwt(), identity });
});

// WebSocket route for media-stream
fastify.register(async (fastify) => {
    fastify.get('/media-stream', { websocket: true }, (connection, req) => {
        console.log('Client connected');

        // Connection-specific state
        let streamSid = null;
        let callSid = null; // 通話を能動的に切断する際、Twilio REST APIの宛先として使う
        let callerNumber = null; // 発信者番号。Phase 3で book_visit の受付キーに使う
        let latestMediaTimestamp = 0;
        let lastAssistantItem = null;
        let markQueue = [];
        let responseStartTimestampTwilio = null;
        let callDurationTimer = null; // MAX_CALL_DURATION_MS超過で強制切断するタイマー

        // escalate_emergency / book_visit(受付完了)が呼ばれたら、AIがその応答を
        // 話し終わった（markQueueが空になった＝Twilio側で音声再生が完了した）タイミングで
        // 通話を能動的に切断する。'emergency' | 'booking_complete' | null
        let pendingCallEndReason = null;
        let callEnding = false; // 二重に切断APIを叩かないためのガード

        const endCallViaTwilioApi = async (reason) => {
            if (callEnding) return;
            if (!twilioRestClient || !callSid) {
                console.warn('Cannot end call via Twilio API: missing client or callSid. reason:', reason);
                return;
            }
            callEnding = true;
            try {
                await twilioRestClient.calls(callSid).update({ status: 'completed' });
                console.log('Call ended via Twilio API. reason:', reason);
            } catch (error) {
                console.error('Failed to end call via Twilio API:', error);
                callEnding = false; // 失敗時は再試行できるようにガードを戻す
            }
        };

        // 接続確立直後からAIの最初の音声が届くまでの「間」を埋めるリンリン送出。
        // <Play>と違いMedia Streamsへの直接送出なので、OpenAI接続処理と並行して鳴らせる。
        let ringTimer = null;
        let ringStopped = false;

        const stopRingTone = () => {
            if (ringTimer) {
                clearInterval(ringTimer);
                ringTimer = null;
            }
            ringStopped = true;
        };

        const startRingTone = () => {
            if (ringStopped || ringTimer) return;
            let frameIndex = 0;
            ringTimer = setInterval(() => {
                if (ringStopped || !streamSid) {
                    clearInterval(ringTimer);
                    ringTimer = null;
                    return;
                }
                // ループさせない: 1回鳴らしたら送出をやめて無音にする。
                // ループさせると「リンリンの終わり」と「AIの話し始め」の境目が
                // 繰り返し音に埋もれて分かりにくくなるため（SPEECH_START_GAP_MSの間、明確に無音にしたい）。
                if (frameIndex >= RING_TONE_FRAMES.length) {
                    clearInterval(ringTimer);
                    ringTimer = null;
                    return;
                }
                connection.send(JSON.stringify({
                    event: 'media',
                    streamSid: streamSid,
                    media: { payload: RING_TONE_FRAMES[frameIndex] },
                }));
                frameIndex++;
            }, RING_TONE_FRAME_MS);
        };

        const openAiWs = new WebSocket(`wss://api.openai.com/v1/realtime?model=gpt-realtime-2.1&temperature=${TEMPERATURE}`, {
            headers: {
                Authorization: `Bearer ${OPENAI_API_KEY}`,
            }
        });

        // 発信者番号が取れたかどうかでinstructionsを出し分ける。
        // 取れていれば電話番号を聞かず下4桁で確認、取れなければ聞き取りに切り替える。
        const buildInstructions = () => {
            const last4 = lastFourDigits(callerNumber);
            const callerSection = last4
                ? PROMPT_FRAGMENTS.callerNumberKnownTemplate.replace('{last4}', last4)
                : PROMPT_FRAGMENTS.callerNumberUnknown;
            return `${SYSTEM_MESSAGE}\n\n${callerSection}`;
        };

        // Control initial session with OpenAI
        let sessionInitialized = false;
        const initializeSession = () => {
            if (sessionInitialized) return;
            sessionInitialized = true;

            const sessionUpdate = {
                type: 'session.update',
                session: {
                    type: 'realtime',
                    model: "gpt-realtime-2.1",
                    output_modalities: ["audio"],
                    audio: {
                        input: { format: { type: 'audio/pcmu' }, turn_detection: { type: "server_vad" } },
                        output: { format: { type: 'audio/pcmu' }, voice: VOICE },
                    },
                    instructions: buildInstructions(),
                    tools: TOOLS,
                },
            };

            console.log('Sending session update:', JSON.stringify(sessionUpdate));
            openAiWs.send(JSON.stringify(sessionUpdate));

            // server_vadはユーザー発話をトリガーに応答するため、こちらから何も言わないと
            // AIは黙ったまま待ち続ける。名乗りはAI側からさせたいので明示的に発話を開始させる。
            sendInitialConversationItem();
        };

        // AIに最初の発話（名乗り）を開始させる。
        // 具体的な文言はsystem-prompt.mdの会話フロー（1. 名乗り）に書いてあるので、
        // ここでは「始めてください」という短い指示だけ注入する。
        const sendInitialConversationItem = () => {
            const initialConversationItem = {
                type: 'conversation.item.create',
                item: {
                    type: 'message',
                    role: 'user',
                    content: [
                        {
                            type: 'input_text',
                            text: PROMPT_FRAGMENTS.initialGreetingTrigger
                        }
                    ]
                }
            };

            if (SHOW_TIMING_MATH) console.log('Sending initial conversation item:', JSON.stringify(initialConversationItem));
            openAiWs.send(JSON.stringify(initialConversationItem));
            openAiWs.send(JSON.stringify({ type: 'response.create' }));
        };

        // Handle interruption when the caller's speech starts
        const handleSpeechStartedEvent = () => {
            if (markQueue.length > 0 && responseStartTimestampTwilio != null) {
                const elapsedTime = latestMediaTimestamp - responseStartTimestampTwilio;
                if (SHOW_TIMING_MATH) console.log(`Calculating elapsed time for truncation: ${latestMediaTimestamp} - ${responseStartTimestampTwilio} = ${elapsedTime}ms`);

                if (lastAssistantItem) {
                    const truncateEvent = {
                        type: 'conversation.item.truncate',
                        item_id: lastAssistantItem,
                        content_index: 0,
                        audio_end_ms: elapsedTime
                    };
                    if (SHOW_TIMING_MATH) console.log('Sending truncation event:', JSON.stringify(truncateEvent));
                    openAiWs.send(JSON.stringify(truncateEvent));
                }

                connection.send(JSON.stringify({
                    event: 'clear',
                    streamSid: streamSid
                }));

                // Reset
                markQueue = [];
                lastAssistantItem = null;
                responseStartTimestampTwilio = null;
            }
        };

        // function calling: response.done の response.output に含まれる function_call を実行し、
        // 結果を function_call_output として送り返してから response.create で応答を継続させる。
        // 複数呼ばれる場合があるので並行実行し、全部終わってからまとめて1回 response.create する。
        const handleFunctionCalls = async (functionCalls) => {
            await Promise.all(functionCalls.map(async (call) => {
                const handler = toolHandlers[call.name];
                let output;
                if (!handler) {
                    console.error('Unknown tool called:', call.name);
                    output = { error: 'unknown_tool' };
                } else {
                    try {
                        const args = call.arguments ? JSON.parse(call.arguments) : {};
                        output = handler(args, { callerNumber });
                    } catch (error) {
                        console.error('Tool execution error:', call.name, error);
                        output = { error: 'tool_execution_failed' };
                    }
                }

                // 通話を締めるべきツール呼び出しを検知しておく。AIがこの結果を読み上げ終わった
                // （このターンの音声再生がTwilio側で完了した）タイミングでサーバー側から切断する。
                // book_visitはcallback_phone_requiredで再度呼ばれる可能性があるため、
                // 実際に受付が完了した(accepted:true)場合のみ対象にする。
                if (call.name === 'escalate_emergency') {
                    pendingCallEndReason = 'emergency';
                } else if (call.name === 'book_visit' && output.accepted === true) {
                    pendingCallEndReason = 'booking_complete';
                } else if (call.name === 'check_availability' && output.inServiceArea === false) {
                    // 営業エリア（東京23区）外。予約フローに進まず案内して終話する。
                    pendingCallEndReason = 'out_of_service_area';
                }

                openAiWs.send(JSON.stringify({
                    type: 'conversation.item.create',
                    item: {
                        type: 'function_call_output',
                        call_id: call.call_id,
                        output: JSON.stringify(output),
                    },
                }));
            }));

            openAiWs.send(JSON.stringify({ type: 'response.create' }));
        };

        // Send mark messages to Media Streams so we know if and when AI response playback is finished
        const sendMark = (connection, streamSid) => {
            if (streamSid) {
                const markEvent = {
                    event: 'mark',
                    streamSid: streamSid,
                    mark: { name: 'responsePart' }
                };
                connection.send(JSON.stringify(markEvent));
                markQueue.push('responsePart');
            }
        };

        // AI音声デルタをTwilioへ送出する実処理。
        const sendAssistantAudio = (delta, itemId) => {
            connection.send(JSON.stringify({
                event: 'media',
                streamSid: streamSid,
                media: { payload: delta },
            }));

            if (!responseStartTimestampTwilio) {
                responseStartTimestampTwilio = latestMediaTimestamp;
                if (SHOW_TIMING_MATH) console.log(`Setting start timestamp for new response: ${responseStartTimestampTwilio}ms`);
            }

            if (itemId) {
                lastAssistantItem = itemId;
            }

            sendMark(connection, streamSid);
        };

        // リンリンの後、AIの話し始めに一拍の間を作る（最初の発話のみ。2ターン目以降は即時送出）。
        // リンリンを即座に止めず0.3秒鳴らし続け、その間に届く音声デルタは破棄せずバッファして
        // ゲートが開いたタイミングでまとめて送出する（発話の冒頭が欠けないようにするため）。
        const SPEECH_START_GAP_MS = 1000;
        let firstAudioGateScheduled = false;
        let firstAudioGateOpen = false;
        let bufferedFirstDeltas = [];

        const handleAssistantAudioDelta = (delta, itemId) => {
            if (ringStopped) {
                // リンリンは既に止まっている＝2ターン目以降の応答。間を空けず即時送出。
                sendAssistantAudio(delta, itemId);
                return;
            }

            if (!firstAudioGateScheduled) {
                firstAudioGateScheduled = true;
                console.log(`[gap] first delta received, scheduling ${SPEECH_START_GAP_MS}ms gate at`, new Date().toISOString());
                setTimeout(() => {
                    console.log('[gap] gate opening, flushing', bufferedFirstDeltas.length, 'buffered deltas at', new Date().toISOString());
                    stopRingTone();
                    firstAudioGateOpen = true;
                    const buffered = bufferedFirstDeltas;
                    bufferedFirstDeltas = [];
                    buffered.forEach(({ delta: bufferedDelta, itemId: bufferedItemId }) => {
                        sendAssistantAudio(bufferedDelta, bufferedItemId);
                    });
                }, SPEECH_START_GAP_MS);
            }

            if (firstAudioGateOpen) {
                sendAssistantAudio(delta, itemId);
            } else {
                bufferedFirstDeltas.push({ delta, itemId });
            }
        };

        // instructionsに発信者番号を反映するため、OpenAI接続とTwilioのstartイベントの
        // 両方が揃うまでセッション初期化を待つ（どちらが先に届くかは保証されない）。
        let openAiReady = false;
        let twilioStarted = false;
        const maybeInitializeSession = () => {
            if (openAiReady && twilioStarted) setTimeout(initializeSession, 100);
        };

        // Open event for OpenAI WebSocket
        openAiWs.on('open', () => {
            console.log('Connected to the OpenAI Realtime API');
            openAiReady = true;
            maybeInitializeSession();

            // startが届かない異常時でも会話が始まるようにするフォールバック。
            // この場合は発信者番号なし＝聞き取りモードで初期化される。
            setTimeout(() => {
                if (!twilioStarted) {
                    console.warn('Twilio start event not received; initializing without caller number');
                    initializeSession();
                }
            }, 1000);
        });

        // Listen for messages from the OpenAI WebSocket (and send to Twilio if necessary)
        openAiWs.on('message', (data) => {
            try {
                const response = JSON.parse(data);

                if (LOG_EVENT_TYPES.includes(response.type)) {
                    console.log(`Received event: ${response.type}`, response);
                }

                if (response.type === 'response.output_audio.delta' && response.delta) {
                    handleAssistantAudioDelta(response.delta, response.item_id);
                }

                if (response.type === 'input_audio_buffer.speech_started') {
                    handleSpeechStartedEvent();
                }

                if (response.type === 'response.done') {
                    const output = response.response?.output ?? [];
                    const functionCalls = output.filter((item) => item.type === 'function_call');
                    if (functionCalls.length > 0) {
                        handleFunctionCalls(functionCalls);
                    }
                }
            } catch (error) {
                console.error('Error processing OpenAI message:', error, 'Raw message:', data);
            }
        });

        // Handle incoming messages from Twilio
        connection.on('message', (message) => {
            try {
                const data = JSON.parse(message);

                switch (data.event) {
                    case 'media':
                        latestMediaTimestamp = data.media.timestamp;
                        if (SHOW_TIMING_MATH) console.log(`Received media message with timestamp: ${latestMediaTimestamp}ms`);
                        if (openAiWs.readyState === WebSocket.OPEN) {
                            const audioAppend = {
                                type: 'input_audio_buffer.append',
                                audio: data.media.payload
                            };
                            openAiWs.send(JSON.stringify(audioAppend));
                        }
                        break;
                    case 'start':
                        streamSid = data.start.streamSid;
                        callSid = data.start.callSid;
                        callerNumber = data.start.customParameters?.callerNumber || null;
                        // ログには下4桁のみ残す
                        console.log('Incoming stream has started', streamSid, 'caller(last4):', lastFourDigits(callerNumber) ?? 'unknown');
                        // 音声フォーマットの実測確認用（公式仕様上は発信経路によらず常にmulaw/8000/1chのはず）
                        console.log('Media format:', JSON.stringify(data.start.mediaFormat));

                        // Reset start and media timestamp on a new stream
                        responseStartTimestampTwilio = null;
                        latestMediaTimestamp = 0;

                        // 通話開始からMAX_CALL_DURATION_MSを超えたら強制切断する
                        if (!callDurationTimer) {
                            callDurationTimer = setTimeout(() => {
                                terminateCallWithError('max_call_duration_exceeded');
                            }, MAX_CALL_DURATION_MS);
                        }

                        twilioStarted = true;
                        maybeInitializeSession();
                        console.log('[gap] startRingTone at', new Date().toISOString());
                        startRingTone(); // 接続確立直後から鳴らす。裏でOpenAI接続処理が並行して進む
                        break;
                    case 'mark':
                        if (markQueue.length > 0) {
                            markQueue.shift();
                        }
                        // AIの発話（このターン分）の再生がTwilio側で完全に終わったタイミング。
                        // ここでpendingCallEndReasonが立っていれば通話を切る。
                        if (markQueue.length === 0 && pendingCallEndReason) {
                            const reason = pendingCallEndReason;
                            pendingCallEndReason = null;
                            endCallViaTwilioApi(reason);
                        }
                        break;
                    default:
                        console.log('Received non-media event:', data.event);
                        break;
                }
            } catch (error) {
                console.error('Error parsing message:', error, 'Message:', message);
            }
        });

        // 発信者が切ったのか、こちらの異常で切れたのかを区別する
        let closedByCaller = false;

        // 会話継続不能時: Twilio側のWSを閉じるとTwiMLの次のverb（終話メッセージ+Hangup）に進む
        let terminating = false;
        const terminateCallWithError = (reason) => {
            if (closedByCaller || terminating) return;
            terminating = true;
            console.error('Terminating call due to unrecoverable error:', reason);
            if (openAiWs.readyState === WebSocket.OPEN) openAiWs.close();
            connection.close();
        };

        // Handle connection close
        connection.on('close', () => {
            closedByCaller = true;
            stopRingTone(); // 正常終話・異常終話どちらもここを通るのでタイマーはここで止める
            if (callDurationTimer) {
                clearTimeout(callDurationTimer);
                callDurationTimer = null;
            }
            if (openAiWs.readyState === WebSocket.OPEN) openAiWs.close();
            console.log('Client disconnected.');
        });

        // Handle WebSocket close and errors
        openAiWs.on('close', () => {
            console.log('Disconnected from the OpenAI Realtime API');
            // 発信者が切る前にOpenAI側が落ちた＝会話を続けられない
            terminateCallWithError('OpenAI WebSocket closed unexpectedly');
        });

        openAiWs.on('error', (error) => {
            console.error('Error in the OpenAI WebSocket:', error);
            terminateCallWithError('OpenAI WebSocket error');
        });
    });
});

fastify.listen({ port: PORT }, (err) => {
    if (err) {
        console.error(err);
        process.exit(1);
    }
    console.log(`Server is listening on port ${PORT}`);
});
