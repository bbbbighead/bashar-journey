// feedback.js — 記住「這一則解讀已經回饋過了」。
//
// 只存在瀏覽器（localStorage），目的是避免同一則解讀被反覆詢問／反覆送出：
// 回饋成功後記下 runId、星等與留言，之後（含從歷史紀錄回看時）直接顯示
// 感謝狀態，並把當時填的內容以不可編輯的方式呈現給本人回看。
// 這份資料只有這台瀏覽器的主人看得到，跟送到後台的那份互不相依。

const KEY = 'inquiry_feedback_v1';
const MAX = 100; // 只保留最近 100 則，避免無上限成長

function readAll() {
  try {
    const raw = localStorage.getItem(KEY);
    const list = raw ? JSON.parse(raw) : null;
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

// 這一則解讀先前的回饋：{ rating, text }；沒回饋過回 null。
// text 是後來才開始存的，舊紀錄沒有——呈現端要接受 text 為空字串。
export function feedbackFor(runId) {
  if (!runId) return null;
  const hit = readAll().find((r) => r && r.runId === runId);
  return hit ? { rating: hit.rating, text: String(hit.text || '') } : null;
}

export function rememberFeedback(runId, rating, text) {
  if (!runId) return;
  try {
    const list = readAll().filter((r) => r && r.runId !== runId);
    list.unshift({ runId, rating, text: String(text || '').trim().slice(0, 500), ts: Date.now() });
    localStorage.setItem(KEY, JSON.stringify(list.slice(0, MAX)));
  } catch { /* 配額或隱私模式：略過，最多就是再問一次 */ }
}
