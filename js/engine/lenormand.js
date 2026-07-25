// lenormand.js — 雷諾曼引擎：抽牌（確定性隨機）+ 九宮格語義 + 模式摘要。
// 純前端、無 AI 依賴。輸出僅供內部整合使用，絕不直接顯示給使用者。

import { LENORMAND, CLUSTER_MEANING, GRID_POSITIONS } from '../../data/lenormand.js';

// 使用者自選：以 36 張中被選的 9 個索引（依選取順序對應九宮格位置）組成牌陣
export function spreadFromPicks(cardIndices) {
  return cardIndices.slice(0, 9).map((cardIdx, pos) => ({
    position: GRID_POSITIONS[pos],
    card: LENORMAND[cardIdx],
  }));
}

// 洗亂 0..35 的顯示順序（讓牌池每次排列不同；crypto 隨機）
export function shuffledDeckOrder() {
  const order = [...LENORMAND.keys()];
  const rand = new Uint32Array(order.length);
  crypto.getRandomValues(rand);
  for (let i = order.length - 1; i > 0; i--) {
    const j = rand[i] % (i + 1);
    [order[i], order[j]] = [order[j], order[i]];
  }
  return order;
}

// 系統隨機抽 9 張（後備用，例如續玩異常時）
export function drawSpread() {
  const indices = [...LENORMAND.keys()];
  const picked = [];
  const rand = new Uint32Array(9);
  crypto.getRandomValues(rand);
  for (let i = 0; i < 9; i++) {
    const j = rand[i] % indices.length;
    picked.push(indices.splice(j, 1)[0]);
  }
  return picked.map((cardIdx, pos) => ({
    position: GRID_POSITIONS[pos],
    card: LENORMAND[cardIdx],
  }));
}

// 統計主題群集出現次數，回傳收斂主題（出現 ≥2 次者，依次數排序）
export function convergingClusters(spread) {
  const counts = {};
  for (const { card } of spread) counts[card.cluster] = (counts[card.cluster] || 0) + 1;
  return Object.entries(counts)
    .filter(([, n]) => n >= 2)
    .sort((a, b) => b[1] - a[1])
    .map(([cluster, n]) => ({ cluster, n, ...CLUSTER_MEANING[cluster] }));
}

// 產出給 AI 的內部敘述（緊湊、含位置語義與牌義）
export function spreadForAI(spread) {
  return {
    grid: spread.map(({ position, card }) => ({
      position: position.label,
      time: position.time,
      layer: position.layer,
      card: card.name,
      keys: card.keys,
      meaning: card.meaning,
    })),
    center: spread[4].card.name,
    themes: convergingClusters(spread).map((t) => `${t.label}（×${t.n}）`),
  };
}

