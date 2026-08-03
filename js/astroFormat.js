// astroFormat.js — 占星那一節的段落切法。
//
// 模型依規定輸出三層：白話標題／配置清單（以｜分隔，飛星用 → 串成故事線）／分析。
// 這裡把三層切開，供兩個地方共用：
//   ・js/app.js  結果頁排版（標題金色、配置行退為註記、本文明體）
//   ・js/analytics.js  後台「字數」只算分析本文，標題與配置行不算
//
// 刻意抽成一個模組而不是各寫一份：兩邊若各自實作同一套判斷，日後改了一邊
// 就會讓「畫面上看到的分層」與「後台算出來的字數」對不上。
//
// 判斷規則與兩道保險：
// ・配置行＝含｜或→、且不含句末標點。要求「不含句號」是為了不把一句拿｜當頓號
//   的敘述誤判成配置行。
// ・標題＝下一行是配置行的那一行；或收束段的標題（比對四語系字樣，因為報告是用
//   當時的輸出語言寫的，讀者現在的介面語言可能已經不同）。
// ・模型若照舊習慣把配置行加了括號，這裡剝掉，不要求它重寫。
// ・沒被判成標題或配置的行一律當本文留著——絕不丟行。
// ・切不出至少兩個有標題的段落時 ok=false，呼叫方各自決定退路（畫面退回純文字、
//   字數退回全部計算）。

const isCfgLine = (s) => !!s && (s.includes('｜') || s.includes('→')) && !/[。！？.!?]/.test(s);
const stripBrackets = (s) => s.replace(/^[（(]\s*/, '').replace(/\s*[）)]$/, '');

// content：模型寫的那一節。closingLabels：收束段標題的各語系字樣（陣列）。
// 回傳 { ok, segs:[{head, cfg, body:[...]}] }
export function parseAstroSections(content, closingLabels = []) {
  const lines = String(content || '').split(/\n+/).map((s) => s.trim()).filter(Boolean);
  const closings = closingLabels.map((x) => String(x).trim()).filter(Boolean);
  const isClosingHead = (s) => closings.includes(s.replace(/[：:]\s*$/, ''));

  const segs = [];
  let cur = { head: '', cfg: '', body: [], isClosing: false };
  const flush = () => { if (cur.head || cur.cfg || cur.body.length) segs.push(cur); };
  for (let i = 0; i < lines.length; i++) {
    const closing = isClosingHead(lines[i]);
    if (closing || isCfgLine(lines[i + 1])) {
      flush();
      // isClosing 讓呼叫方分辨收束段：它的內容是條列筆記，不是段落，
      // 要畫成清單而不是 <p>（見 css 的 .as-list）。
      cur = { head: lines[i], cfg: '', body: [], isClosing: closing };
      if (isCfgLine(lines[i + 1])) cur.cfg = stripBrackets(lines[++i]);
      continue;
    }
    cur.body.push(lines[i]);
  }
  flush();

  return { ok: segs.filter((s) => s.head).length >= 2, segs };
}
