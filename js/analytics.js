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

// ---- 3. 題目與產出結果 ----
export function trackJourney(state) {
  try {
    send({
      type: 'journey',
      opening: String(state.opening || '').slice(0, 300),
      cards: (state.lenormand || []).map((x) => x.card.name),
      numbers: state.numbers || null,
      title: state.analysis ? String(state.analysis.title || '').slice(0, 60) : '',
      message: state.analysis ? String(state.analysis.message || '').slice(0, 2000) : '',
      closing: state.analysis ? String(state.analysis.closing || '').slice(0, 100) : '',
      offline: !!state.usedOffline,
      // 隱私：不記錄出生資料，只記錄是否使用占星與太陽星座
      astroUsed: !!state.astro,
      astroSun: state.astro ? String(((state.astro.points || []).find((p) => p.name === '太陽') || {}).sign || '') : '',
    });
  } catch { /* 靜默 */ }
}
