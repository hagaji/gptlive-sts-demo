// server/tools.js のユニットテスト。node:test（Node.js標準、追加依存なし）。
// bookedSlotIds はモジュールスコープの共有状態なので、テスト間で干渉しないよう
// 各テストで別々の区（=別々の内部エリア）を使う。同じ区を複数テストで使い回さないこと。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lookupErrorCode, checkAvailability, bookVisit, escalateEmergency } from './tools.js';

test('lookupErrorCode: 存在するコードは詳細情報を返す', () => {
    const result = lookupErrorCode({ code: 'AS-01' });
    assert.equal(result.found, true);
    assert.equal(result.code, 'AS-01');
    assert.ok(result.symptomName);
    assert.ok(result.selfResolutionGuidance);
    assert.ok(result.interimGuidance);
});

test('lookupErrorCode: 小文字で渡しても一致する', () => {
    const result = lookupErrorCode({ code: 'as-01' });
    assert.equal(result.found, true);
});

test('lookupErrorCode: 存在しないコードはfound:falseのみを返す', () => {
    const result = lookupErrorCode({ code: 'ZZ-NOT-EXIST' });
    assert.deepEqual(result, { found: false });
});

test('checkAvailability: 正式な区名でinServiceArea:trueと空き枠を返す', () => {
    const result = checkAvailability({ area: '渋谷区' });
    assert.equal(result.inServiceArea, true);
    assert.equal(result.ward, '渋谷区');
    assert.ok(Array.isArray(result.slots));
    assert.ok(result.slots.length > 0);
});

test('checkAvailability: 「区」が省略されても正規化されて一致する', () => {
    const result = checkAvailability({ area: '新宿' });
    assert.equal(result.inServiceArea, true);
    assert.equal(result.ward, '新宿区');
});

test('checkAvailability: 23区外の区名はinServiceArea:falseを返す（「市区」にならない）', () => {
    // normalizeWardNameが「市」で終わる語まで「区」化してしまうバグの回帰防止
    const result = checkAvailability({ area: '武蔵野市' });
    assert.equal(result.inServiceArea, false);
    assert.equal(result.ward, '武蔵野市');
});

test('checkAvailability: 他都道府県の市名もinServiceArea:falseを返す', () => {
    const result = checkAvailability({ area: '横浜市' });
    assert.equal(result.inServiceArea, false);
    assert.equal(result.ward, '横浜市');
});

test('checkAvailability: 返り値の日付は当日以降で、読み上げ形式を含む', () => {
    const result = checkAvailability({ area: '練馬区' });
    assert.ok(result.slots.length > 0);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    for (const slot of result.slots) {
        assert.match(slot.date, /^\d{4}-\d{2}-\d{2}$/);
        assert.match(slot.dateSpoken, /月.+日.+曜日/);
        const slotDate = new Date(slot.date);
        assert.ok(slotDate.getTime() >= today.getTime(), `${slot.date} should not be in the past`);
    }
});

test('bookVisit: 発信者番号があればcallback_phone省略でも受付できる', () => {
    const avail = checkAvailability({ area: '北区' });
    const slotId = avail.slots[0].slotId;
    const result = bookVisit(
        { name: 'テスト太郎', slot_id: slotId },
        { callerNumber: '+819012345678' }
    );
    assert.equal(result.accepted, true);
    assert.equal(result.receptionPhoneLast4, '5678');
});

test('bookVisit: callback_phoneを指定すると発信者番号より優先される', () => {
    const avail = checkAvailability({ area: '大田区' });
    const slotId = avail.slots[0].slotId;
    const result = bookVisit(
        { name: 'テスト太郎', slot_id: slotId, callback_phone: '090-0000-8888' },
        { callerNumber: '+819012345678' }
    );
    assert.equal(result.accepted, true);
    assert.equal(result.receptionPhoneLast4, '8888');
});

test('bookVisit: 発信者番号もcallback_phoneも無ければ受付できない', () => {
    const avail = checkAvailability({ area: '品川区' });
    const slotId = avail.slots[0].slotId;
    const result = bookVisit(
        { name: 'テスト太郎', slot_id: slotId },
        { callerNumber: null }
    );
    assert.deepEqual(result, { accepted: false, reason: 'callback_phone_required' });
});

test('bookVisit: 予約済みの枠は次回のcheckAvailabilityから除外される', () => {
    const avail1 = checkAvailability({ area: '世田谷区' });
    const slotId = avail1.slots[0].slotId;

    bookVisit({ name: 'テスト太郎', slot_id: slotId }, { callerNumber: '+819011112222' });

    const avail2 = checkAvailability({ area: '世田谷区' });
    assert.ok(!avail2.slots.some((s) => s.slotId === slotId));
});

test('escalateEmergency: 固定の案内文言を返す', () => {
    const result = escalateEmergency({ reason: 'ガス臭がすると発言' });
    assert.match(result.guidance, /ガス栓/);
    assert.match(result.demoNotice, /デモ/);
});
