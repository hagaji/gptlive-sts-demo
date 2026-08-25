// server/twiml.js のユニットテスト。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractCallerNumber, buildStreamTwiml } from './twiml.js';

test('extractCallerNumber: 通常の電話番号はそのまま抽出される', () => {
    assert.equal(extractCallerNumber('+819012345678'), '+819012345678');
});

test('extractCallerNumber: ハイフンなど数字と+以外の文字は除去される', () => {
    assert.equal(extractCallerNumber('+81-90-1234-5678'), '+819012345678');
});

test('extractCallerNumber: ブラウザ発信(client:形式)は空文字を返す', () => {
    assert.equal(extractCallerNumber('client:demo-web-user'), '');
});

test('extractCallerNumber: 空文字・undefined・nullは空文字を返す', () => {
    assert.equal(extractCallerNumber(''), '');
    assert.equal(extractCallerNumber(undefined), '');
    assert.equal(extractCallerNumber(null), '');
});

test('extractCallerNumber: XMLインジェクションを試みる文字列は数字と+以外が除去される', () => {
    // TwiMLの<Parameter value="...">にそのまま埋め込まれるため、タグを構成する文字が
    // 残らないことがそのままインジェクション対策になっている（実接続テストで確認済みの回帰確認）。
    const result = extractCallerNumber('+81"><Say>pwned</Say>');
    assert.equal(result, '+81');
    assert.ok(!result.includes('<'));
    assert.ok(!result.includes('>'));
    assert.ok(!result.includes('"'));
});

test('buildStreamTwiml: host・callerNumber・terminationMessageが正しく埋め込まれる', () => {
    const xml = buildStreamTwiml('example.com', '+819012345678', 'ご利用ありがとうございました。');
    assert.match(xml, /<Response>/);
    assert.match(xml, /wss:\/\/example\.com\/media-stream/);
    assert.match(xml, /<Parameter name="callerNumber" value="\+819012345678" \/>/);
    assert.match(xml, /ご利用ありがとうございました。/);
    assert.match(xml, /<Hangup\/>/);
});

test('buildStreamTwiml: callerNumberが空文字でも正しいXMLになる', () => {
    const xml = buildStreamTwiml('example.com', '', 'エラーメッセージ');
    assert.match(xml, /<Parameter name="callerNumber" value="" \/>/);
});
