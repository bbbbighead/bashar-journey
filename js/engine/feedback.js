// feedback.js — 記住「這一則解讀已經回饋過了」。
//
// 只存在瀏覽器（localStorage），目的是避免同一則解讀被反覆詢問／反覆送出：
// 回饋成功後記下 runId 與星等，之後（含從歷史紀錄回看時）直接顯示感謝狀態。
// 真正的回饋內容送到後台，這裡不留文字，只留 runId、星等與時間。

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

// 這一則解讀先前給過幾顆星？沒回饋過回 null。
export function feedbackFor(runId) {
  if (!runId) return null;
  const hit = readAll().find((r) => r && r.runId === runId);
  return hit ? hit.rating : null;
}

export function rememberFeedback(runId, rating) {
  if (!runId) return;
  try {
    const list = readAll().filter((r) => r && r.runId !== runId);
    list.unshift({ runId, rating, ts: Date.now() });
    localStorage.setItem(KEY, JSON.stringify(list.slice(0, MAX)));
  } catch { /* 配額或隱私模式：略過，最多就是再問一次 */ }
}
