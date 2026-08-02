// lenormand.js — 雷諾曼引擎：抽牌（crypto 隨機）＋ 九宮格位置編號。
//
// 位置只是標記：它要帶的資訊只有「這一格抽到哪張牌」，以及那張牌象徵什麼。
// 位置本身沒有獨立牌義——九宮格是一組一組讀的（直欄看時間、橫排看三股力量），
// 意義來自兩張以上合起來的組合。所以這裡不再給每一格語意標籤，只給 1–9 的編號；
// 哪些編號組成哪一組，寫在解讀指令裡（api/insight.js 的 TOOL_STRUCT.lenormand）。

import { LENORMAND } from '../../data/lenormand.js';

// 使用者自選：以 36 張中被選的 9 個索引（依選取順序對應九宮格位置）組成牌陣
export function spreadFromPicks(cardIndices) {
  return cardIndices.slice(0, 9).map((cardIdx, pos) => ({
    position: pos + 1,
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
    position: pos + 1,
    card: LENORMAND[cardIdx],
  }));
}

// 產出給 AI 的內部敘述。每一格只帶三件事：編號、抽到哪張牌、那張牌象徵什麼。
//
// 移除過的欄位，都是因為不符合上面那條規則：
//   ・position 的語意標籤（「過去的想法／舊有認知」「全局核心／此刻的中心影響」
//     「潛意識的暗流」…）——那是給單一格子下定義，而九宮格沒有一格有獨立牌義；
//     其中好幾個還與現行的橫排定義相反（例如位置 7–9 標成「未察覺的基礎」，
//     但那一組現在是「個人心境」，也就是可以調整的部分）。改為純編號。
//   ・time（past/present/future）與 layer（mind/core/root）——沒有任何程式讀過
//     它們，而 layer 的值還是舊橫排制度的命名。
//   ・center（位置 5 那張，配合已刪除的十字法）與 themes（把九張牌的 cluster
//     標籤數一數當成收斂主題）——都是在模型讀牌之前先給它結論。themes 還會把
//     位置資訊抹掉：實測有一副牌的「阻礙」落在過去與現在、「洞察」落在現在與
//     未來，走向很清楚，數出來卻是 3:3 打平。
// cluster 欄位仍留在 data/lenormand.js，日後要做後台主題統計還用得到。
export function spreadForAI(spread) {
  return {
    grid: spread.map(({ position, card }) => ({
      position,
      card: card.name,
      keys: card.keys,
      meaning: card.meaning,
    })),
  };
}

