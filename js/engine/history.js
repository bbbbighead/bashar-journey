// history.js — 把使用者每次得到的分析結果，存進瀏覽器的 localStorage，
// 供日後「歷史回顧」頁面讀取。本檔只負責「存結構」與「讀結構」，不含任何 UI。
//
// 為什麼用 localStorage 而不是 cookie：
// - cookie 每次 HTTP 請求都會被夾帶送出（浪費頻寬）、且上限僅約 4KB；
//   分析結果是大量文字，塞不下也不該送到伺服器。
// - localStorage 純留在使用者裝置（約 5–10MB），容量足、不外送，最適合「本機歷史」。
// - 本專案的當前來訪（inquiry_session_v3）本來就存 localStorage，語彙一致。
//
// 結構：單一鍵 inquiry_history_v1，值是一個陣列（由新到舊）。每筆記錄足以重建結果頁。

const HISTORY_KEY = 'inquiry_history_v1';
const HISTORY_MAX = 50; // 最多保留最近 50 筆，超過捨去最舊的

// 從 state 擷取「足以重建結果頁」的最小結構
function toRecord(state) {
  const a = state.analysis;
  return {
    id: state.runId,          // 以 runId 當唯一鍵（同一場重存會覆蓋，不重複）
    version: 1,               // 記錄格式版本，日後改結構可據此升級
    savedAt: Date.now(),      // 存檔時間（毫秒）
    opening: String(state.opening || ''), // 使用者當次探索的主題
    tools: Array.isArray(state.tools) ? state.tools.slice() : [],
    usedOffline: !!state.usedOffline,      // 是否為離線後備結果（非 AI）
    // 重建視覺（雷諾曼九宮格／對照牌卡等）所需的占卜資料
    lenormand: state.lenormand || null,
    meihua: state.meihua || null,
    astro: state.astro || null,
    numbers: state.numbers || null,
    // 最終文字結果（標題／分節／臨別語）
    analysis: a
      ? {
          title: String(a.title || ''),
          sections: (a.sections || []).map((s) => ({
            tool: String(s.tool || ''),
            content: String(s.content || ''),
          })),
          closing: String(a.closing || ''),
        }
      : null,
  };
}

// 讀出整個歷史陣列（新到舊）；壞資料或無資料回傳空陣列
export function loadHistory() {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

// 寫回陣列；若超出配額，逐步丟棄較舊的再試（best-effort）
function writeHistory(arr) {
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(arr));
    return true;
  } catch (e) {
    let list = arr.slice();
    while (list.length > 1) {
      list = list.slice(0, Math.ceil(list.length / 2)); // 每次砍掉一半較舊的
      try { localStorage.setItem(HISTORY_KEY, JSON.stringify(list)); return true; } catch { /* 續縮 */ }
    }
    return false;
  }
}

// 存一筆（依 id 去重：同一場重存會覆蓋既有那筆）。
// 只在 status==='done' 且有 analysis 時才存。回傳存檔後的筆數，未存回傳 null。
export function saveAnalysisToHistory(state) {
  if (!state || state.status !== 'done' || !state.analysis) return null;
  const record = toRecord(state);
  if (!record.id || !record.analysis) return null;
  const list = loadHistory().filter((r) => r && r.id !== record.id); // 依 id 去重
  list.unshift(record); // 新的放最前
  const capped = list.slice(0, HISTORY_MAX);
  writeHistory(capped);
  return capped.length;
}

// 清空歷史（日後「歷史回顧」頁可能會用到）
export function clearHistory() {
  try { localStorage.removeItem(HISTORY_KEY); } catch { /* ignore */ }
}

export { HISTORY_KEY, HISTORY_MAX };
