// board.js — v2：線性引導式旅程，無骰子、無選擇題。
// 固定 8 站：start → (reflect → collect) ×3 → finale，按「下一步」逐站前進。
// AI 永不參與此處：站點序列完全由模板掌管。

// 站點類型：
//   start   — 世界開場
//   reflect — 開放提問，玩家自由文字回答
//   collect — 「沿路拾得」：一張以巴夏卡為原型的個人化訊息
//   finale  — 直指核心的答案
const STEP_PATTERN = [
  'start',    // 0
  'reflect',  // 1
  'collect',  // 2
  'reflect',  // 3
  'collect',  // 4
  'reflect',  // 5
  'collect',  // 6
  'finale',   // 7
];

export const BOARD_LENGTH = STEP_PATTERN.length;

// 生成旅程序列。tileThemeWords 由 genesis（或降級主題包）提供，逐站貼上主題風味詞。
export function generateBoard(tileThemeWords = []) {
  const tiles = STEP_PATTERN.map((type, idx) => ({
    idx,
    type,
    themeWord: tileThemeWords[idx] || '',
  }));
  return { length: STEP_PATTERN.length, tiles };
}

// 前進一站（不超過終點）
export function advance(position, length = BOARD_LENGTH) {
  return Math.min(position + 1, length - 1);
}

// 目前是否已抵達終點
export function isFinale(state) {
  return state.position >= state.board.length - 1;
}

// 中文顯示標籤（UI 用）
export const TILE_LABELS = {
  start: '啟程',
  reflect: '對話',
  collect: '拾得',
  finale: '回應',
};
