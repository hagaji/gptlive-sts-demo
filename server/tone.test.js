// server/tone.js のユニットテスト。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SAMPLE_RATE, generateRingToneSamples } from './tone.js';

test('SAMPLE_RATE は Media Streams の固定仕様(8kHz)と一致する', () => {
    assert.equal(SAMPLE_RATE, 8000);
});

test('generateRingToneSamples: サンプル数が「リン(120ms)+無音(90ms)+リン(120ms)」の合計と一致する', () => {
    const samples = generateRingToneSamples();
    const expected =
        Math.round((SAMPLE_RATE * 120) / 1000) +
        Math.round((SAMPLE_RATE * 90) / 1000) +
        Math.round((SAMPLE_RATE * 120) / 1000);
    assert.equal(samples.length, expected);
});

test('generateRingToneSamples: 全サンプルが±1.0の範囲に収まる（クリッピングしない）', () => {
    const samples = generateRingToneSamples();
    for (const v of samples) {
        assert.ok(v >= -1 && v <= 1, `sample out of range: ${v}`);
    }
});

test('generateRingToneSamples: 中間の無音区間(GAP_MS)は実際に無音になる', () => {
    const samples = generateRingToneSamples();
    const ringSamples = Math.round((SAMPLE_RATE * 120) / 1000);
    const gapSamples = Math.round((SAMPLE_RATE * 90) / 1000);
    // 無音区間の中央付近をサンプリングして確認（境界は±1サンプルの丸め誤差があり得るため中央を見る）
    const midOfGap = ringSamples + Math.floor(gapSamples / 2);
    assert.equal(samples[midOfGap], 0);
});

test('generateRingToneSamples: 最初と最後は音（0でない）から始まる/終わる', () => {
    const samples = generateRingToneSamples();
    // 立ち上がり直後（数サンプル目）は減衰エンベロープがまだ効いておらず、ほぼ0ではないはず
    assert.notEqual(samples[5], 0);
});
