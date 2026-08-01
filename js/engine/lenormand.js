// lenormand.js — 雷諾曼引擎：抽牌（確定性隨機）+ 九宮格語義 + 模式摘要。
// 純前端、無 AI 依賴。輸出僅供內部整合使用，絕不直接顯示給使用者。

import { LENORMAND, GRID_POSITIONS } from '../../data/lenormand.js';

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

// 產出給 AI 的內部敘述：只有「這九張牌是什麼、在哪個位置」。
//
// 原本還會送 center（位置 5 那張，配合已刪除的十字法）與 themes（把九張牌的
// cluster 標籤數一數當作收斂主題）。兩者都是在模型讀牌之前先給它結論，而
// themes 還會把位置資訊抹掉——實測有一副牌的「阻礙」落在過去與現在、「洞察」
// 落在現在與未來，走向很清楚，數出來卻是 3:3 打平。哪一類重複、落在哪一欄，
// 由模型自己從下面這九行讀出來才對。
// cluster 欄位仍留在 data/lenormand.js，日後要做後台主題統計還用得到。
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
  };
}

