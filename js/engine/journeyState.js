// journeyState.js — 旅程狀態模型 + localStorage 存/續玩
// 單一可序列化物件，所有 AI I/O 與 UI 都讀寫這個物件。

const STORAGE_KEY = 'bashar_journey_v2';

// 產生一個 runId（優先用 crypto.randomUUID）
function newRunId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return 'run-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
}

// 偵測語言（MVP：只分中/英，預設中文）
function detectLang(text) {
  return /[一-鿿]/.test(text) ? 'zh' : 'en';
}

// 建立一段全新的旅程狀態
export function createJourney(rawQuestion) {
  const raw = (rawQuestion || '').trim().slice(0, 500); // 超長提問先截斷
  const now = Date.now();
  return {
    runId: newRunId(),
    version: 2,
    createdAt: now,
    updatedAt: now,
    status: 'genesis', // genesis | playing | finale | done

    question: {
      raw,
      normalized: null,   // AI 分類（封閉集）；降級時由 intentMap 推得
      lang: detectLang(raw),
      entities: [],
    },

    world: null, // { themeId, title, setting, palette, motifs[], tileThemeWords[] }

    board: null, // { length, tiles:[{idx,type,themeWord}] }

    position: 0,
    turn: 0,

    // 連續性引擎：累積參數
    params: {
      keywords: {},        // { 詞: 權重 }
      tones: {},           // { 情緒: 次數 }
      energies: {},        // { expansion/contraction/...: 次數 }
      excitementSignals: [], // 自由文字觀察，上限保護
    },

    // 玩家沿途的開放式回答（v2 的核心輸入）
    responses: [],       // { stepIdx, question, answer|null(跳過) }

    collectedCards: [],  // { cardIndex, tileIdx, title, pickup, reading }
    usedReflectIds: [],  // 靜態提問輪替、避免 run 內重複
    usedPickupIds: [],   // 靜態拾得框架輪替

    narrative: {
      beats: [],          // { tileIdx, summary, tone }
      runningSummary: '',
    },

    finale: null, // { title, coreAnswer, recap, keyCards[], suggestedPractice, closingBlessing }

    aiAvailable: true,   // 連續失敗後轉 false，短路其餘呼叫
    aiFailStreak: 0,
    aiCallLog: [],       // { action, model, ms, ok, fallbackUsed }
  };
}

// 存檔 / 讀檔 / 清檔
export function saveJourney(state) {
  if (!state) return;
  state.updatedAt = Date.now();
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch (e) {
    // localStorage 可能被停用或滿了 — 靜默失敗，遊戲仍可在記憶體中進行
    console.warn('[journey] save failed:', e && e.message);
  }
}

export function loadJourney() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const state = JSON.parse(raw);
    if (!state || state.version !== 2) return null;
    return state;
  } catch (e) {
    return null;
  }
}

export function clearJourney() {
  try { localStorage.removeItem(STORAGE_KEY); } catch (e) { /* ignore */ }
}

// 記錄一次 AI 呼叫結果（供除錯 / 成本觀察）
export function logAiCall(state, entry) {
  state.aiCallLog.push(entry);
  if (entry.ok) {
    state.aiFailStreak = 0;
  } else {
    state.aiFailStreak += 1;
    if (state.aiFailStreak >= 2) state.aiAvailable = false; // 連兩次失敗 → 離線模式
  }
}
