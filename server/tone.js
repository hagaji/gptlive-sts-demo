// リンリン音の波形定義。scripts/generate-connecting-tone.mjs（WAV生成、<Play>用に残置）と
// index.js（Media Streamsへの直接ストリーミング）の両方から使う単一ソース。
export const SAMPLE_RATE = 8000;
const BELL_FREQ = 1000; // ベルらしい高めの音
const RING_MS = 120;    // 「リン」1回分の長さ
const GAP_MS = 90;      // 「リン」の間の無音

// -1.0〜1.0のfloatサンプル配列を返す
export function generateRingToneSamples() {
    const samples = [];

    const addTone = (freqHz, durationMs) => {
        const n = Math.round((SAMPLE_RATE * durationMs) / 1000);
        for (let s = 0; s < n; s++) {
            const t = s / SAMPLE_RATE;
            // ベルらしい減衰エンベロープ（立ち上がりは速く、その後指数的に減衰）
            const envelope = Math.exp(-4 * (s / n));
            samples.push(Math.sin(2 * Math.PI * freqHz * t) * envelope * 0.6);
        }
    };

    const addSilence = (durationMs) => {
        const n = Math.round((SAMPLE_RATE * durationMs) / 1000);
        for (let s = 0; s < n; s++) samples.push(0);
    };

    addTone(BELL_FREQ, RING_MS);
    addSilence(GAP_MS);
    addTone(BELL_FREQ, RING_MS);
    return samples;
}
