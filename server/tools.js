// function calling ツールのダミー実装。仕様は scenario/tools-spec.md 参照。
// 受付情報（氏名・住所・電話番号）は一切永続化しない。プロセス内メモリのみで完結させる。
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(__dirname, '..', 'data');

const errorCodesData = JSON.parse(fs.readFileSync(path.join(dataDir, 'error-codes.json'), 'utf8'));
const availabilityData = JSON.parse(fs.readFileSync(path.join(dataDir, 'availability.json'), 'utf8'));

// 予約済みslotId。プロセスを再起動すると消える（意図的。永続化しない）。
const bookedSlotIds = new Set();

// 東京23区 → 内部エリア（availability.jsonのareas）のマッピング。
// 営業範囲は東京23区内のみ。ここに無い区名（23区外・他都道府県）はinServiceArea:falseになる。
const WARD_TO_AREA = {
    '台東区': '東エリア', '墨田区': '東エリア', '江東区': '東エリア', '荒川区': '東エリア',
    '葛飾区': '東エリア', '江戸川区': '東エリア', '足立区': '東エリア',
    '港区': '南エリア', '品川区': '南エリア', '目黒区': '南エリア', '大田区': '南エリア', '世田谷区': '南エリア',
    '新宿区': '西エリア', '渋谷区': '西エリア', '中野区': '西エリア', '杉並区': '西エリア',
    '豊島区': '西エリア', '練馬区': '西エリア',
    '千代田区': '北エリア', '中央区': '北エリア', '文京区': '北エリア', '北区': '北エリア', '板橋区': '北エリア',
};

// 「渋谷」のように「区」が省略されて渡ってきても拾えるようにする。
// ただし「武蔵野市」のように他の行政区分で終わる場合は変換しない（誤って「武蔵野市区」にしない）。
const normalizeWardName = (raw) => {
    const s = String(raw ?? '').trim();
    if (!s) return s;
    if (s.endsWith('区') || s.endsWith('市') || s.endsWith('町') || s.endsWith('村')) return s;
    return `${s}区`;
};

const KANJI_DIGITS = ['〇', '一', '二', '三', '四', '五', '六', '七', '八', '九'];
const WEEKDAY_JA = ['日曜日', '月曜日', '火曜日', '水曜日', '木曜日', '金曜日', '土曜日'];

// 日付の読み上げ用（1〜31の範囲で足りる）。
const toKanjiNumber = (n) => {
    if (n < 10) return KANJI_DIGITS[n];
    if (n < 20) return '十' + (n % 10 === 0 ? '' : KANJI_DIGITS[n % 10]);
    const tens = Math.floor(n / 10);
    const ones = n % 10;
    return KANJI_DIGITS[tens] + '十' + (ones === 0 ? '' : KANJI_DIGITS[ones]);
};

const formatDateSpoken = (date) =>
    `${toKanjiNumber(date.getMonth() + 1)}月${toKanjiNumber(date.getDate())}日 ${WEEKDAY_JA[date.getDay()]}`;

const formatDateISO = (date) => {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
};

const formatDateCompact = (date) => formatDateISO(date).replace(/-/g, '');

const lastFourDigits = (phone) => {
    const digits = String(phone ?? '').replace(/\D/g, '');
    return digits.length >= 4 ? digits.slice(-4) : null;
};

export function lookupErrorCode({ code }) {
    const normalized = String(code ?? '').trim().toUpperCase();
    const entry = errorCodesData.errorCodes.find((e) => e.code.toUpperCase() === normalized);
    if (!entry) return { found: false };

    return {
        found: true,
        code: entry.code,
        symptomName: entry.symptomName,
        likelyCauses: entry.likelyCauses,
        selfResolvable: entry.selfResolvable,
        selfResolutionGuidance: entry.selfResolutionGuidance,
        interimGuidance: entry.interimGuidance,
    };
}

export function checkAvailability({ area }) {
    const ward = normalizeWardName(area);
    const internalArea = WARD_TO_AREA[ward];

    if (!internalArea) {
        return { inServiceArea: false, ward };
    }

    const now = new Date();
    const slots = availabilityData.slotTemplates
        .filter((t) => t.area === internalArea && t.status === 'available')
        .map((t) => {
            const date = new Date(now);
            date.setDate(date.getDate() + t.dayOffset);
            return {
                slotId: `${t.templateId}-${formatDateCompact(date)}`,
                date: formatDateISO(date),
                dateSpoken: formatDateSpoken(date),
                timeRange: t.timeRange,
            };
        })
        .filter((s) => !bookedSlotIds.has(s.slotId));

    if (slots.length === 0) return { inServiceArea: true, ward, slots: [], note: '現在空いている枠がありません。' };
    return { inServiceArea: true, ward, slots };
}

// context.callerNumber: Twilio発信者番号（ブラウザ発信時はnull）
export function bookVisit({ name, slot_id, callback_phone, symptom_summary }, context) {
    const phone = callback_phone || context.callerNumber;
    if (!phone) return { accepted: false, reason: 'callback_phone_required' };

    bookedSlotIds.add(slot_id);

    return {
        accepted: true,
        receptionPhoneLast4: lastFourDigits(phone),
        symptomSummary: symptom_summary ?? null,
    };
}

export function escalateEmergency({ reason }) {
    console.warn('Emergency escalation triggered. reason:', reason);
    return {
        guidance:
            '安全のため、ただちに給湯器のご使用を中止し、ガス栓を閉めて窓を開けてください。火気は使用しないでください。これより担当者におつなぎいたします。',
        demoNotice: '――ただいまのデモでは実際の転送は行われません。AIとの通話はここまでとなります。',
    };
}

export const toolHandlers = {
    lookup_error_code: lookupErrorCode,
    check_availability: checkAvailability,
    book_visit: bookVisit,
    escalate_emergency: escalateEmergency,
};
