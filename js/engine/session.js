// session.js — 拖延探索的狀態模型 + localStorage 存檔／續談。
// 單一可序列化物件，所有引擎與 UI 都讀寫這個物件。
//
// 流程（依規格 v1.0）：輸入拖延情境 → spread（雷諾曼九宮格）→ numbers（報數起卦）
// → hypothesize（AI 建立假說，過場）→ probe（四題驗證提問）→ confirm（第五題主假說確認）
// → weaving（完整分析中）→ done（最後分析）

const STORAGE_KEY = 'inquiry_session_v1';

export const PROBE_COUNT = 4; // 驗證提問共 4 題（一次一題）

function newRunId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return 'run-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
}

export function createSession(opening) {
  const now = Date.now();
  return {
    runId: newRunId(),
    version: 1,
    createdAt: now,
    updatedAt: now,
    status: 'spread', // spread | numbers | probe | confirm | weaving | done

    opening: String(opening || '').trim().slice(0, 600), // 拖延情境描述

    // 占卜（先行）
    lenormand: null,   // 九宮格 spread（玩家看得到牌面）
    numbers: null,     // 玩家報的三個數字 [n1,n2,n3]（跳過為 null）
    meihua: null,      // 起卦結果

    // AI 依「描述＋牌＋卦」建立的工作假說（內部，不顯示）
    // [{ mechanism, hypothesis, signals[] }]；離線時為 null
    hypotheses: null,

    // 四題驗證提問（answer 為 null 表示「先跳過」）
    probes: [],        // { question, answer }

    // 第五題：主假說確認
    confirmation: null, // { statement, verdict: 'yes'|'partly'|'no', note }

    // 最後分析
    analysis: null,    // { meaning, coreBelief, direction, need, action, basis, closing }

    aiAvailable: true,
    aiFailStreak: 0,
    aiCallLog: [],     // { action, ms, ok }
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
    if (!state || state.version !== 1) return null;
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
