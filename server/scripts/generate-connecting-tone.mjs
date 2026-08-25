// リンリン音のWAVファイルを書き出す。波形定義は tone.js（単一ソース）。
// 用途: 過去にTwiML <Play> で使っていた名残。今は index.js が Media Streams へ
// 直接ストリーミングする方式に切り替えたため必須ではないが、単体で音を確認したい時に使える。
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { SAMPLE_RATE, generateRingToneSamples } from '../tone.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outPath = path.join(__dirname, '..', 'public', 'connecting.wav');

const samples = generateRingToneSamples();

const pcm16 = Buffer.alloc(samples.length * 2);
samples.forEach((v, i) => {
    const clamped = Math.max(-1, Math.min(1, v));
    pcm16.writeInt16LE(Math.round(clamped * 32767), i * 2);
});

const byteRate = SAMPLE_RATE * 2; // 16bit mono
const blockAlign = 2;
const dataSize = pcm16.length;

const header = Buffer.alloc(44);
header.write('RIFF', 0);
header.writeUInt32LE(36 + dataSize, 4);
header.write('WAVE', 8);
header.write('fmt ', 12);
header.writeUInt32LE(16, 16); // fmt chunk size
header.writeUInt16LE(1, 20); // PCM
header.writeUInt16LE(1, 22); // mono
header.writeUInt32LE(SAMPLE_RATE, 24);
header.writeUInt32LE(byteRate, 28);
header.writeUInt16LE(blockAlign, 32);
header.writeUInt16LE(16, 34); // bits per sample
header.write('data', 36);
header.writeUInt32LE(dataSize, 40);

fs.writeFileSync(outPath, Buffer.concat([header, pcm16]));
console.log('Wrote', outPath, `(${(dataSize / SAMPLE_RATE / 2).toFixed(2)}s)`);
