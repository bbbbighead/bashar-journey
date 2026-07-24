// analytics.js — 前端匿名埋點（fire-and-forget，失敗一律靜默，不影響體驗）。
// 收集：來訪（時間/來源/UTM）、頁面停留時間、題目與產出結果。
// 傳送用 sendBeacon（頁面關閉也能送達）；未部署儲存後端時 API 會靜默丟棄。

const ENDPOINT = '/api/track';
const VID_KEY = 'pi_visitor_id';

// 持久訪客 ID（同一瀏覽器跨次來訪不變）
function visitorId() {
  try {
    let v = localStorage.getItem(VID_KEY);
    if (!v) {
      v = (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2)).slice(0, 8);
      localStorage.setItem(VID_KEY, v);
    }
    return v;
  } catch {
    return 'anon';
  }
}

// 本次來訪的 session ID（每次載入頁面一個）
const SID = (crypto.randomUUID ? crypto.randomUUID() : 'S' + Math.random().toString(36).slice(2)).slice(0, 12);
const VID = visitorId();

// 供其他模組（如 analyze 呼叫）帶上本次 session id，讓 server 端記錄可對上這筆來訪
export function sessionId() { return SID; }

function send(payload) {
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
export function trackVisit() {
  const q = new URLSearchParams(location.search);
  send({
    type: 'start',
    ref: document.referrer || '',
    utm: q.get('utm_source') || q.get('ref') || '',
    lang: navigator.language || '',
    vw: window.innerWidth,
  });
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
      closing: a ? String(a.closing || '').slice(0, 100) : '',
      offline: !!state.usedOffline,
      astroUsed: !!state.astro,
      astroSun: state.astro ? String(((state.astro.points || []).find((p) => p.name === '太陽') || {}).sign || '') : '',
      // 出生資料與解析結果（供後台分析；前台已揭露會匿名記錄）
      astroBirth: state.astro ? birthRecord(state.astro) : null,
    });
  } catch { /* 靜默 */ }
}
