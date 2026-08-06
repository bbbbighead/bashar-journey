// analytics.js — 前端匿名埋點（fire-and-forget，失敗一律靜默，不影響體驗）。
// 收集：來訪（時間/來源/UTM）、頁面停留時間、題目與產出結果。
// 傳送用 sendBeacon（頁面關閉也能送達）；未部署儲存後端時 API 會靜默丟棄。

import { parseAstroSections } from './astroFormat.js';
import { groupLabelVariants, meihuaHeadVariants } from './i18n/index.js';

const ENDPOINT = '/api/track';
const VID_KEY = 'pi_visitor_id';

// 預覽模式（後台的「預覽結果頁」以 iframe 載入 index.html?preview=1）：
// 一律不送統計、也不碰訪客 ID。少了這道閘門，站主每看一次舊紀錄就會多產生
// 一筆來訪與一堆停留時間，把自己的數據汙染掉。
const PREVIEW = (() => {
  try { return new URLSearchParams(location.search).get('preview') === '1'; }
  catch { return false; }
})();

// 持久訪客 ID（同一瀏覽器跨次來訪不變）。
// 純隨機、不含任何個人資訊——只能認出「同一個瀏覽器」，不能認出「同一個人」。
// 已知會斷掉的情況：換裝置／換瀏覽器／無痕／清資料，
// 以及 iOS Safari 的 ITP（7 天未回訪就清掉 localStorage）。
const newVid = () => (crypto.randomUUID
  ? crypto.randomUUID()
  : Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2)).slice(0, 8);

function visitorId() {
  // 預覽模式不建立、也不讀取訪客 ID。後台與正式站同源，共用同一份
  // localStorage——站主只是看一筆舊紀錄，卻會在自己的瀏覽器裡種下一個
  // pi_visitor_id，之後真的去逛網站時就被算成回訪。
  if (PREVIEW) return 'preview';
  try {
    let v = localStorage.getItem(VID_KEY);
    if (!v) {
      v = newVid();
      localStorage.setItem(VID_KEY, v);
    }
    return v;
  } catch {
    // localStorage 被封鎖時仍給隨機值。原本回傳固定的 'anon'，
    // 結果所有這類使用者共用同一個標籤，在後台看起來像一個超級活躍的訪客，
    // 把不重複訪客數也算少了。認不出回訪沒關係，不要把不同人併成一個。
    return newVid();
  }
}

// 本次來訪的 session ID（每次載入頁面一個）
const SID = (crypto.randomUUID ? crypto.randomUUID() : 'S' + Math.random().toString(36).slice(2)).slice(0, 12);
const VID = visitorId();

// 供其他模組（如 analyze 呼叫）帶上本次 session id，讓 server 端記錄可對上這筆來訪
export function sessionId() { return SID; }
// 訪客 ID。牌卡的每日次數上限要按人算（圖像生成是唯一有單張成本的功能），
// 所以那支端點需要拿到它。預覽模式回 'preview'，見 visitorId()。
export function visitorIdValue() { return VID; }

function send(payload) {
  if (PREVIEW) return;
  try {
    const body = JSON.stringify({ sid: SID, vid: VID, ...payload });
    if (navigator.sendBeacon) {
      navigator.sendBeacon(ENDPOINT, new Blob([body], { type: 'application/json' }));
    } else {
      fetch(ENDPOINT, { method: 'POST', body, keepalive: true }).catch(() => {});
    }
  } catch { /* 靜默 */ }
}

// ---- 1. 來訪（時間 / 來源 / UTM；裝置由後端從 User-Agent 解析） ----
// lang 由呼叫端傳入「實際生效的介面語言」（getLocale()），不能自己讀
// navigator.language——那是瀏覽器的系統語言，跟畫面上顯示的語言是兩回事：
// 系統英文＋台灣 IP 的人介面是繁體中文，卻會被記成 en。
export function trackVisit(lang) {
  const q = new URLSearchParams(location.search);
  send({
    type: 'start',
    ref: document.referrer || '',
    utm: q.get('utm_source') || q.get('ref') || '',
    lang: String(lang || '').slice(0, 12),
    vw: window.innerWidth,
  });
}

// 使用者中途自己切換語言：回頭更新這次來訪的語言。
// start 事件在載入時就送出了，若不更新，後台看到的會是「他進站時的語言」，
// 而不是「他實際讀完整份解讀時用的語言」——那正是他在畫面上看到的那個。
export function trackLang(lang) {
  send({ type: 'lang', lang: String(lang || '').slice(0, 12) });
}

// ---- 2. 頁面停留時間 ----
let curScreen = null;
let curSince = Date.now();

export function trackScreen(screenId) {
  flushDwell();
  curScreen = screenId;
  curSince = Date.now();
}

function flushDwell() {
  if (!curScreen) return;
  const ms = Date.now() - curSince;
  if (ms > 400 && ms < 3600_000) send({ type: 'dwell', screen: curScreen, ms });
  curSince = Date.now();
}

// 關頁 / 切到背景時，把目前畫面的停留也送出
addEventListener('pagehide', flushDwell);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') flushDwell();
});

// 出生資料紀錄：輸入值 + 地點/時區解析 + 三要點星座
function birthRecord(chart) {
  try {
    const meta = chart.meta || {};
    const input = meta.input || {};
    const pts = {};
    for (const p of chart.points || []) pts[p.name] = p;
    return {
      date: input.date || '',
      time: input.timeUnknown ? null : (input.time || ''),
      timeUnknown: !!input.timeUnknown,
      city: input.city || '',
      country: input.country || null,
      resolved: (meta.place && meta.place.resolved) || '',
      tz: (meta.timezone && meta.timezone.iana) || '',
      utc: meta.utc || '',
      sun: pts['太陽'] ? pts['太陽'].sign : '',
      moon: pts['月亮'] ? pts['月亮'].sign : '',
      asc: pts['上升點'] ? pts['上升點'].sign : '',
    };
  } catch {
    return null;
  }
}

// 後台「字數」要量的是「模型實際寫了多少分析」，所以只算分析本文：
//   ・不算 message 裡的【工具】分節標記與段落之間的換行（那是我們組出來的）
//   ・不算占星每段的白話標題與配置行（切法與結果頁排版共用 astroFormat.js）
//   ・不算雷諾曼那八個組別小標題（模型被要求逐字使用的字樣）
// 這個數字必須在這裡算——message 在前端與伺服器端都被切在 4000 字，用存下來的
// 字串回推永遠會飽和在 4000，看不出真實長度。
//
// 先取出「要算的那些行」，再由同一份文字量字元數與 words 兩個數字。刻意不讓
// bodyChars 與 bodyWords 各走一次過濾：兩邊若各自實作，同一份報告會算出互相
// 對不上的兩個數字，後台就沒辦法用其中一個去解釋另一個。
function bodyLines(a) {
  if (!a) return null;
  const sections = Array.isArray(a.sections) ? a.sections : null;
  if (!sections) return [String(a.message || '')];
  const groupLabels = new Set(
    [
      ...['past', 'present', 'future', 'outer', 'event', 'inner', 'combos', 'overall']
        .flatMap((k) => groupLabelVariants(k)),
      // 梅花易數的固定小標題（含卦象提點的標題）同樣不算；提點的內文照算
      ...['tip', 'ben', 'bian', 'moving', 'meaning', 'advice']
        .flatMap((k) => meihuaHeadVariants(k)),
    ].map((x) => String(x).trim()),
  );
  const out = [];
  for (const sec of sections) {
    const content = String((sec && sec.content) || '');
    if (sec && sec.tool === 'astro') {
      const { ok, segs } = parseAstroSections(content, groupLabelVariants('overall'));
      // 切不出來就整段算——寧可高估，也不要因為切法失效而低報字數
      if (ok) for (const g of segs) out.push(...g.body);
      else out.push(content);
      continue;
    }
    out.push(...content.split(/\n+/)
      .map((x) => x.trim())
      .filter((x) => x && !groupLabels.has(x.replace(/[：:]\s*$/, ''))));
  }
  return out;
}

// 字元數。以行為單位接起來再去掉所有空白，所以中日韓＝字數，英文＝字母數。
// 這兩個計數 export 出來是為了讓測試量到真正在用的那份實作。之前為了測試
// 另外手抄一份等價邏輯，結果抄錯了還以為量到的是真的（見 astroForAI 的同一個教訓）。
export function bodyChars(a) {
  const lines = bodyLines(a);
  return lines ? lines.join('\n').replace(/\s+/g, '').length : null;
}

// words。英文的篇幅規定是以 words 寫的（見 api/insight.js 的 LEN_RULE 與
// ASTRO_LEN），但同一段英文的字元數大約是 words 的五倍——後台只看字元數會誤判
// 成爆量。這裡實算，後台就不必用「字元數 ÷ 5」去估。
// 中日韓沒有詞界，這個數字對它們沒有意義，所以後台只在英文紀錄上顯示。
export function bodyWords(a) {
  const lines = bodyLines(a);
  return lines ? lines.join('\n').split(/\s+/).filter(Boolean).length : null;
}

// ---- 3. 題目與產出結果 ----
export function trackJourney(state) {
  try {
    // 產出訊息：新版為分節（sections），合併成純文字記錄；相容舊 .message
    const a = state.analysis;
    const messageText = a
      ? (Array.isArray(a.sections)
        ? a.sections.map((s) => `【${s.tool}】\n${s.content || ''}`).join('\n\n')
        : String(a.message || ''))
      : '';
    send({
      type: 'journey',
      opening: String(state.opening || '').slice(0, 300),
      tools: state.tools || null,
      cards: (state.lenormand || []).map((x) => x.card.name),
      numbers: state.numbers || null,
      title: a ? String(a.title || '').slice(0, 60) : '',
      message: messageText.slice(0, 4000),
      // 真實的分析本文字數（不含標題與配置行）。message 被切在 4000，這個沒有。
      bodyChars: bodyChars(a),
      // 同一份本文的 words。英文的篇幅規定以 words 計，後台要拿它來對照。
      bodyWords: bodyWords(a),
      closing: a ? String(a.closing || '').slice(0, 100) : '',
      offline: !!state.usedOffline,
      astroUsed: !!state.astro,
      astroSun: state.astro ? String(((state.astro.points || []).find((p) => p.name === '太陽') || {}).sign || '') : '',
      // 出生資料與解析結果（供後台分析；前台已揭露會匿名記錄）
      astroBirth: state.astro ? birthRecord(state.astro) : null,
    });
  } catch { /* 靜默 */ }
}

// ---- 4. 處理時間（整合中這一段花在哪裡） ----
// 每次成功產出解讀送一次。與 journey 分開存，因為它是效能資料、
// 量大且會隨優化不斷變動，混在一起會讓紀錄難讀也難刪。
export function trackTiming(marks) {
  try {
    send({ type: 'timing', ...marks });
  } catch { /* 靜默 */ }
}

// ---- 5. 使用者回饋（星等＋選填文字） ----
// 與其他埋點不同：這是使用者主動按下「送出」的動作，必須看得到成功或失敗，
// 所以用 fetch 等回應，而不是 sendBeacon。API 對埋點一律回 204，因此
// 「有收到回應」即視為送達；只有網路層失敗才回報失敗讓使用者重送。
export async function sendFeedback({ rating, text, state, lang }) {
  const body = JSON.stringify({
    sid: SID,
    vid: VID,
    type: 'feedback',
    rating: Number(rating) || 0,
    text: String(text || '').slice(0, 500),
    lang: String(lang || ''),
    // 讓每則回饋自己帶著上下文，後台不必仰賴同一筆來訪紀錄還在
    topic: String((state && state.opening) || '').slice(0, 300),
    tools: (state && state.tools) || null,
    title: String((state && state.analysis && state.analysis.title) || '').slice(0, 60),
    offline: !!(state && state.usedOffline),
  });
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
    keepalive: true,
  });
  if (!res.ok) throw new Error('feedback_failed');
  return true;
}
