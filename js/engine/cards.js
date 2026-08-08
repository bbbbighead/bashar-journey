// cards.js — 使用者做過的「專屬靈感牌卡」存在自己的瀏覽器裡，
// 回到那一則解讀時就看得到自己做過的卡。跟「我的靈感訊息」同一個概念：
// 純本機，不從後台讀（後台那份是站主審核用的，兩者用途不同）。
//
// ⚠ 刻意**不存進 inquiry_history_v1**，而是自己一把鑰匙。理由是配額：
// 一筆解讀的文字約 2–4 KB，一張卡壓過還有 100 KB 上下——差了兩個數量級。
// 混在一起的話，history.js 的配額退路（「砍掉一半較舊的」）會為了塞下一張圖
// 而丟掉一堆解讀。分開存，圖擠爆時只會擠掉圖。
//
// 存的是壓過的 JPEG（不是原始的 1024×1536 PNG，那張約 1.5–3 MB，
// localStorage 整個也才 5–10 MB）。所以從這裡再下載一次拿到的畫質會略低於
// 當初那張——這是為了「存得下好幾張」付的代價。

const CARDS_KEY = 'inquiry_cards_v1';
const CARDS_MAX = 12;   // 全部加起來最多留幾張（不是每一則解讀幾張）

export function loadCards() {
  try {
    const raw = localStorage.getItem(CARDS_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.filter((c) => c && c.rid && c.img) : [];
  } catch {
    return [];
  }
}

// 寫回去；配額不夠就從最舊的開始丟，一張一張退到寫得進去為止。
// 回傳有沒有寫成功——存不下不是錯誤（卡片本來就是加值的東西），
// 但呼叫端要知道，才不會顯示「已存好」卻其實沒存到。
function writeCards(arr) {
  let list = arr.slice();
  for (;;) {
    try {
      localStorage.setItem(CARDS_KEY, JSON.stringify(list));
      return true;
    } catch {
      if (list.length <= 1) {
        // 連一張都塞不下：清掉這把鑰匙，不要留下半殘的值
        try { localStorage.removeItem(CARDS_KEY); } catch { /* ignore */ }
        return false;
      }
      list = list.slice(0, list.length - 1);
    }
  }
}

// 存一張。rid＝那一則解讀的 id（state.runId），一則解讀可以有好幾張。
// 新的排在最前面，全部加起來超過 CARDS_MAX 就砍掉最舊的。
export function saveCard({ rid, id, keyword, sentence, img }) {
  if (!rid || !img) return false;
  const card = {
    rid: String(rid),
    id: String(id || ''),          // 後台那筆牌卡紀錄的 id，對帳用
    keyword: String(keyword || ''),
    sentence: String(sentence || ''),
    img,                           // data:image/jpeg;base64,...
    ts: Date.now(),
  };
  // 同一張卡（後台 id 相同）重存就覆蓋，不要疊出兩張一樣的
  const list = loadCards().filter((c) => !(card.id && c.id === card.id));
  list.unshift(card);
  return writeCards(list.slice(0, CARDS_MAX));
}

// 某一則解讀做過的卡（新到舊）
export function cardsFor(rid) {
  if (!rid) return [];
  return loadCards().filter((c) => c.rid === String(rid));
}

// 那一則解讀被刪掉時，它的卡也一起刪——不然圖會變成沒有人認領的孤兒，
// 白白佔著配額，而且使用者永遠看不到它們。
export function deleteCardsFor(rid) {
  if (!rid) return;
  const list = loadCards();
  const left = list.filter((c) => c.rid !== String(rid));
  if (left.length !== list.length) writeCards(left);
}

export function clearCards() {
  try { localStorage.removeItem(CARDS_KEY); } catch { /* ignore */ }
}

export { CARDS_KEY, CARDS_MAX };
