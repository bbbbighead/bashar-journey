// session.js — 對談狀態模型 + localStorage 存檔／續談。
// 單一可序列化物件，所有引擎與 UI 都讀寫這個物件。

const STORAGE_KEY = 'reflection_session_v1';

export const NARRATIVE_TURNS = 3; // 敘事收集共 3 個提問——問滿即彙整，進入占卜

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
    // narrative（敘事收集）→ mirror（彙整確認）→ spread（九宮格翻牌）
    // → numbers（報數起卦）→ weaving（交叉彙整中）→ done（照見）
    status: 'narrative',

    opening: String(opening || '').trim().slice(0, 600),

    // 敘事收集的問答（answer 為 null 表示「先跳過」）
    turns: [], // { question, answer }

    // 理解確認
    mirror: null,        // { text, correction|null }

    // 內部個案模型（AI 產出；離線時由模板推得）
    caseModel: null,

    // 兩個占卜引擎的結果（序列化保存以支援續談）
    lenormand: null,     // spread（進入 spread 站時抽出，玩家看得到牌面）
    numbers: null,       // 玩家報的三個數字 [n1, n2, n3]（跳過則為 null）
    meihua: null,        // cast（依 numbers 起卦；跳過則以時間起卦）

    // 最終照見文件
    reading: null,       // { understanding, newPerspective, tension, questions[], experiment, closing }

    aiAvailable: true,
    aiFailStreak: 0,
    aiCallLog: [],       // { action, ms, ok }
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
    if (state.aiFailStreak >= 2) state.aiAvailable = false; // 連兩次失敗 → 全程離線
  }
}
