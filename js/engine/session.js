// session.js — Intuitive Notes 的狀態模型 + localStorage 存檔／續玩。
// 單一可序列化物件，所有引擎與 UI 都讀寫這個物件。
//
// 流程（MVP）：首頁輸入主題＋勾選工具 → 依序蒐集所選工具的資料
// （雷諾曼選牌／梅花報數／占星出生資料）→ weaving（分析中）→ done（結果）

const STORAGE_KEY = 'inquiry_session_v3';

// 目前可用的分析工具（canonical 順序＝解析與蒐集順序）
export const TOOLS = ['lenormand', 'meihua', 'astro'];
export const TOOL_LABELS = {
  lenormand: '雷諾曼牌陣',
  meihua: '梅花易數',
  astro: '西洋占星',
  synthesis: '交叉比對綜合分析',
};

function newRunId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return 'run-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
}

export function createSession(opening, tools) {
  const now = Date.now();
  const picked = TOOLS.filter((t) => Array.isArray(tools) && tools.includes(t));
  return {
    runId: newRunId(),
    version: 3, // v3：自選工具（v1/v2 存檔不相容，直接略過）
    createdAt: now,
    updatedAt: now,
    tools: picked.length ? picked : ['lenormand'],
    status: 'collect', // collect（依 tools 蒐集）| weaving | done

    opening: String(opening || '').trim().slice(0, 600), // 想探索的主題

    lenormand: null,   // 九宮格 spread
    numbers: null,     // 玩家報的三個數字 [n1,n2,n3]（跳過為 null）
    meihua: null,      // 起卦結果
    astro: null,       // 西洋占星本命盤（Swiss Ephemeris；跳過為 null）

    analysis: null,    // { title, sections:[{tool,content}], closing }

    aiAvailable: true,
    aiFailStreak: 0,
    aiCallLog: [],
  };
}

export function saveSession(state) {
  if (!state) return;
  state.updatedAt = Date.now();
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch (e) {
    console.warn('[session] save failed:', e && e.message);
  }
}

export function loadSession() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const state = JSON.parse(raw);
    if (!state || state.version !== 3) return null;
    return state;
  } catch (e) {
    return null;
  }
}

export function clearSession() {
  try { localStorage.removeItem(STORAGE_KEY); } catch (e) { /* ignore */ }
}

export function logAiCall(state, entry) {
  state.aiCallLog.push(entry);
  if (entry.ok) {
    state.aiFailStreak = 0;
  } else {
    state.aiFailStreak += 1;
    if (state.aiFailStreak >= 2) state.aiAvailable = false; // 連兩次失敗 → 離線後備
  }
}
