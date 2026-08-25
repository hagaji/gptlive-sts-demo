import { Device } from '@twilio/voice-sdk';

const statusEl = document.getElementById('status');
const callBtn = document.getElementById('call-btn');
const hangupBtn = document.getElementById('hangup-btn');

let device = null;
let activeCall = null;

const setStatus = (text) => {
    statusEl.textContent = text;
};

const setCalling = (calling) => {
    callBtn.disabled = calling;
    hangupBtn.disabled = !calling;
};

const init = async () => {
    setStatus('トークンを取得しています…');
    let token;
    try {
        const res = await fetch('/token');
        if (!res.ok) {
            const body = await res.json().catch(() => ({}));
            throw new Error(body.error || `HTTP ${res.status}`);
        }
        ({ token } = await res.json());
    } catch (err) {
        setStatus(`トークン取得に失敗しました: ${err.message}`);
        return;
    }

    device = new Device(token, { logLevel: 'warn' });

    device.on('registered', () => {
        setStatus('準備完了です。通話開始を押してください。');
        callBtn.disabled = false;
    });

    device.on('error', (error) => {
        setStatus(`エラー: ${error.message}`);
        setCalling(false);
    });

    device.on('unregistered', () => {
        setStatus('接続が切断されました。ページを再読み込みしてください。');
        callBtn.disabled = true;
    });

    try {
        await device.register();
    } catch (err) {
        setStatus(`デバイスの初期化に失敗しました: ${err.message}`);
    }
};

const attachCallHandlers = (call) => {
    call.on('accept', () => setStatus('通話中です。'));
    call.on('disconnect', () => {
        setStatus('通話が終了しました。');
        activeCall = null;
        setCalling(false);
    });
    call.on('cancel', () => {
        setStatus('発信をキャンセルしました。');
        activeCall = null;
        setCalling(false);
    });
    call.on('error', (error) => {
        setStatus(`通話エラー: ${error.message}`);
        activeCall = null;
        setCalling(false);
    });
};

callBtn.addEventListener('click', async () => {
    if (!device) return;
    setCalling(true);
    setStatus('発信しています…');
    try {
        activeCall = await device.connect();
        attachCallHandlers(activeCall);
    } catch (err) {
        setStatus(`発信に失敗しました: ${err.message}`);
        setCalling(false);
    }
});

hangupBtn.addEventListener('click', () => {
    if (activeCall) activeCall.disconnect();
});

init();
