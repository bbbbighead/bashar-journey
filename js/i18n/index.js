// i18n/index.js — 語系偵測、記憶與字串查詢。
//
// 偵測順序（先命中者為準）：
//   1. 使用者在網頁上自己切換過的語系（localStorage，最高優先）
//   2. 瀏覽器語言偏好 navigator.languages（反映使用者實際閱讀習慣）
//   3. 以上皆未命中時，才用 IP 所在國家推測（/api/geo，非同步；不阻塞首次繪製）
//   4. 都不成立 → 繁體中文
//
// 為什麼把瀏覽器語言排在國家之前：一位在美國出差的日文使用者，仍應看到日文。
// 國家只在瀏覽器語言完全沒有對應語系時，才用來補救。

import zhHant from './locales/zh-Hant.js';
import en from './locales/en.js';
import ja from './locales/ja.js';
import ko from './locales/ko.js';

const LOCALES = { 'zh-Hant': zhHant, en, ja, ko };
export const LOCALE_LIST = ['zh-Hant', 'en', 'ja', 'ko'];
export const DEFAULT_LOCALE = 'zh-Hant';
const STORE_KEY = 'inquiry_lang';

// 把 BCP-47 語言標籤對應到本站語系
function matchTag(tag) {
  const t = String(tag || '').toLowerCase();
  if (!t) return null;
  if (t.startsWith('ja')) return 'ja';
  if (t.startsWith('ko')) return 'ko';
  if (t.startsWith('zh')) {
    // 簡體（zh-CN／zh-SG／zh-Hans）目前沒有獨立語系，一律給繁體中文
    return 'zh-Hant';
  }
  if (t.startsWith('en')) return 'en';
  return null;
}

// 國家／地區 → 語系（僅在瀏覽器語言無法判斷時作為補救）
const COUNTRY_LOCALE = {
  TW: 'zh-Hant', HK: 'zh-Hant', MO: 'zh-Hant', CN: 'zh-Hant', SG: 'zh-Hant',
  JP: 'ja', KR: 'ko',
};

function readSaved() {
  try {
    const v = localStorage.getItem(STORE_KEY);
    return LOCALES[v] ? v : null;
  } catch { return null; }
}

function detectFromBrowser() {
  const tags = (typeof navigator !== 'undefined'
    && (navigator.languages && navigator.languages.length
      ? navigator.languages
      : [navigator.language])) || [];
  for (const tag of tags) {
    const hit = matchTag(tag);
    if (hit) return hit;
  }
  return null;
}

let current = readSaved() || detectFromBrowser() || DEFAULT_LOCALE;
let chosenByUser = !!readSaved();
let browserMatched = !!detectFromBrowser();
const listeners = new Set();

export function getLocale() { return current; }
export function isUserChosen() { return chosenByUser; }
export function localeName(code) { return (LOCALES[code] || {}).name || code; }

export function setLocale(code, byUser = true) {
  if (!LOCALES[code] || code === current) {
    if (byUser && LOCALES[code]) { chosenByUser = true; persist(code); }
    return;
  }
  current = code;
  if (byUser) { chosenByUser = true; persist(code); }
  document.documentElement.lang = LOCALES[code].htmlLang;
  document.title = LOCALES[code].meta.title;
  listeners.forEach((fn) => { try { fn(code); } catch { /* 忽略單一訂閱者錯誤 */ } });
}

function persist(code) {
  try { localStorage.setItem(STORE_KEY, code); } catch { /* 忽略 */ }
}

export function onLocaleChange(fn) { listeners.add(fn); }

// 取字串：t('result.copy')；缺字自動退回繁中，確保永不顯示空白
export function t(path, ...args) {
  const pick = (obj) => path.split('.').reduce((o, k) => (o == null ? o : o[k]), obj);
  let v = pick(LOCALES[current]);
  if (v == null) v = pick(LOCALES[DEFAULT_LOCALE]);
  if (typeof v === 'function') return v(...args);
  return v == null ? '' : v;
}

// 目前語系的完整字典（需要整包資料時用，例如牌名對照）
export function dict() { return LOCALES[current]; }

// 同一個組別小標題在四個語系的字樣。解析「已經產生好的報告」時要用這個而不是
// 只比對當前語系——報告是用當時的輸出語言寫的，但讀者現在的介面語言可能已經
// 不同（產生後切換語言、翻看歷史紀錄、後台預覽別人的紀錄都會這樣）。
export function groupLabelVariants(key) {
  return LOCALE_LIST
    .map((c) => ((LOCALES[c] || {}).groups || {})[key])
    .filter(Boolean);
}

// 梅花易數小標題的四語系字樣（用途同上：解析已產生的報告時要比對全部語系）
export function meihuaHeadVariants(key) {
  return LOCALE_LIST
    .map((c) => ((LOCALES[c] || {}).meihuaHeads || {})[key])
    .filter(Boolean);
}

// 牌名：以語系對照表為主，找不到才用資料檔內建的中文名
export function cardName(id, fallback) {
  const n = (LOCALES[current].cards || {})[id];
  return n || fallback || '';
}

// 若瀏覽器語言完全沒對應、且使用者也沒自己選過，才問一次 IP 所在國家。
// 這一步只可能把「預設語系」改成更貼近的語系，不會覆蓋使用者的選擇。
export async function refineByCountry() {
  if (chosenByUser || browserMatched) return;
  try {
    const res = await fetch('/api/geo');
    if (!res.ok) return;
    const { country } = await res.json();
    const hit = COUNTRY_LOCALE[String(country || '').toUpperCase()];
    if (hit && hit !== current) setLocale(hit, false);
  } catch { /* 靜默：維持預設語系 */ }
}

// 啟動時同步 <html lang> 與頁面標題
export function initDocumentLang() {
  document.documentElement.lang = LOCALES[current].htmlLang;
  document.title = LOCALES[current].meta.title;
}
