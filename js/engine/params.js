// params.js — 連續性引擎：參數合併/夾限、從自由文字萃取關鍵字、卡片加權選取、Journey Context Block 組裝
// 核心原則：AI 只「提議」paramDelta，模板在此以封閉詞彙 + 有界增量夾限後併入，杜絕漂移。
// v2：玩家的開放式回答是主要輸入——離線時也能從文字萃取關鍵字與情緒，讓拾得的卡回應玩家打的字。

// 封閉詞彙集
export const ENERGIES = ['expansion', 'contraction', 'surrender', 'service', 'joy', 'fear'];
export const EMOTION_TONES = ['hopeful', 'fearful', 'calm', 'excited', 'curious', 'tender', 'grateful', 'peaceful'];

// 能量 → 中文（供 UI/敘事）
export const ENERGY_ZH = {
  expansion: '擴展', contraction: '收縮', surrender: '臣服',
  service: '服務', joy: '喜悅', fear: '恐懼',
};
export const TONE_ZH = {
  hopeful: '充滿希望', fearful: '恐懼', calm: '平靜', excited: '興奮',
  curious: '好奇', tender: '溫柔', grateful: '感恩', peaceful: '安詳',
};

const MAX_KEYWORDS = 20; // 關鍵字袋上限，超過則丟棄權重最低者

function bump(bag, key, amount = 1) {
  if (!key) return;
  bag[key] = (bag[key] || 0) + amount;
}

// 將 AI（或降級）提議的 paramDelta 夾限後併入 state.params
// delta 形狀：{ keywords?:string[], tone?:string, energy?:string }
export function mergeParamDelta(params, delta) {
  if (!delta) return params;

  // keywords：每次最多採 2 個、各 +1
  if (Array.isArray(delta.keywords)) {
    delta.keywords.slice(0, 2).forEach((k) => {
      if (typeof k === 'string' && k.trim()) bump(params.keywords, k.trim(), 1);
    });
  }

  // tone：只收封閉集內的情緒
  if (delta.tone && EMOTION_TONES.includes(delta.tone)) {
    bump(params.tones, delta.tone, 1);
  }

  // energy：只收封閉集內的能量
  if (delta.energy && ENERGIES.includes(delta.energy)) {
    bump(params.energies, delta.energy, 1);
  }

  // 夾限關鍵字袋大小
  trimBag(params.keywords, MAX_KEYWORDS);
  return params;
}

function trimBag(bag, max) {
  const keys = Object.keys(bag);
  if (keys.length <= max) return;
  keys.sort((a, b) => bag[b] - bag[a]);
  keys.slice(max).forEach((k) => delete bag[k]);
}

// ---- 從玩家的自由文字回答萃取訊號（離線也生效） ----

// 情緒/能量詞典：回答文字 → tone/energy（取第一個命中的組）
const TEXT_SIGNALS = [
  { words: ['害怕', '恐懼', '擔心', '焦慮', '不安', '緊張', '怕'], tone: 'fearful', energy: 'fear' },
  { words: ['興奮', '期待', '想要', '喜歡', '開心', '快樂', '雀躍'], tone: 'excited', energy: 'joy' },
  { words: ['放下', '接受', '隨緣', '交給', '順其自然', '算了'], tone: 'peaceful', energy: 'surrender' },
  { words: ['希望', '相信', '願意', '試試', '可以的'], tone: 'hopeful', energy: 'expansion' },
  { words: ['愛', '陪伴', '照顧', '幫助', '付出', '守護'], tone: 'tender', energy: 'service' },
  { words: ['累', '疲憊', '卡住', '困住', '猶豫', '糾結', '捨不得', '放不下'], tone: 'fearful', energy: 'contraction' },
  { words: ['感謝', '感恩', '謝謝', '珍惜'], tone: 'grateful', energy: 'joy' },
];

// 從回答文字萃取關鍵字 + 情緒/能量。
// vocab：候選詞彙（主題詞 + 卡片 keys 全集），以「詞出現在文字中」比對；長詞優先、最多取 3。
export function extractSignalsFromText(text, vocab) {
  const t = String(text || '');
  if (!t.trim()) return null;

  const hits = [];
  const seen = new Set();
  for (const w of vocab) {
    if (w && w.length >= 2 && !seen.has(w) && t.includes(w)) {
      seen.add(w);
      hits.push(w);
    }
  }
  hits.sort((a, b) => b.length - a.length); // 長詞較具體，優先

  let tone; let energy;
  for (const sig of TEXT_SIGNALS) {
    if (sig.words.some((w) => t.includes(w))) { tone = sig.tone; energy = sig.energy; break; }
  }

  if (!hits.length && !tone) return null;
  return { keywords: hits.slice(0, 3), tone, energy };
}

// 由 917 張卡的 keys 建立詞彙集（含主題詞），供文字萃取用。惰性快取。
let _vocabCache = null;
export function buildVocab(cards, extraWords = []) {
  if (!_vocabCache) {
    const set = new Set();
    for (const c of cards) for (const k of (c.keys || [])) if (k && k.length >= 2) set.add(k);
    _vocabCache = set;
  }
  const vocab = new Set(_vocabCache);
  for (const w of extraWords) if (w && w.length >= 2) vocab.add(w);
  return [...vocab];
}

// 依權重排序取前 n 個關鍵字
export function topKeywords(params, n = 3) {
  return Object.keys(params.keywords)
    .sort((a, b) => params.keywords[b] - params.keywords[a])
    .slice(0, n);
}

// 能量平衡摘要（擴展 vs 收縮傾向）
export function energyBalance(params) {
  const e = params.energies;
  const expansive = (e.expansion || 0) + (e.joy || 0) + (e.service || 0) + (e.surrender || 0);
  const contractive = (e.contraction || 0) + (e.fear || 0);
  if (expansive === 0 && contractive === 0) return '尚未定調';
  if (expansive > contractive) return '傾向擴展';
  if (contractive > expansive) return '傾向收縮';
  return '擴展與收縮之間拉鋸';
}

// 情緒軌跡（beats 依序的情緒變化，如 "恐懼 → 好奇 → 充滿希望"）
export function toneArc(state) {
  const arc = state.narrative.beats
    .map((b) => TONE_ZH[b.tone] || b.tone)
    .filter(Boolean);
  if (!arc.length) return '尚未展開';
  // 壓縮連續重複
  const compact = arc.filter((t, i) => t !== arc[i - 1]);
  return compact.join(' → ');
}

// 加權抽卡：以 params.keywords 對每張 card.keys 加權，回傳卡片索引
// excludeIndices：已拾得的卡片，避免重複
export function weightedCardPick(cards, params, excludeIndices = []) {
  const exclude = new Set(excludeIndices);
  const kw = params.keywords;
  let bestPool = [];
  let bestScore = -1;

  // 先算每張候選卡的關鍵字契合分數
  const scored = [];
  for (let i = 0; i < cards.length; i++) {
    if (exclude.has(i)) continue;
    const keys = cards[i].keys || [];
    let score = 0;
    for (const k of keys) if (kw[k]) score += kw[k];
    scored.push({ i, score });
    if (score > bestScore) bestScore = score;
  }
  if (!scored.length) {
    // 全抽過了（極端情況）：允許重複
    return Math.floor(Math.random() * cards.length);
  }

  if (bestScore <= 0) {
    // 尚無累積參數 → 純隨機
    return scored[Math.floor(Math.random() * scored.length)].i;
  }

  // 從契合度最高的一群中隨機挑（避免每次都同一張，仍保留連續感）
  bestPool = scored.filter((s) => s.score === bestScore);
  // 有 35% 機率從次高群拉一張，增加變化
  if (Math.random() < 0.35) {
    const others = scored.filter((s) => s.score > 0 && s.score < bestScore);
    if (others.length) bestPool = others;
  }
  return bestPool[Math.floor(Math.random() * bestPool.length)].i;
}

// 組裝 Journey Context Block —— 每次 AI 呼叫（genesis 之後）都前置這段蒸餾摘要。
// v2 核心：包含玩家沿途的 Q&A 全文（截斷），這是 AI 讀出思考脈絡、慣性與盲點的關鍵輸入。
export function buildContextBlock(state) {
  const w = state.world || {};
  const top = topKeywords(state.params, 3);
  const cards = state.collectedCards.map((c) => c.title).filter(Boolean);

  const qa = state.responses
    .map((r, i) => {
      const a = r.answer == null ? '（選擇靜靜走過，未回答）' : r.answer.slice(0, 120);
      return `第${i + 1}問：${r.question}\n玩家答：${a}`;
    })
    .join('\n');

  const lines = [
    `原始提問：${state.question.raw}`,
    w.title ? `世界：${w.title}——${w.setting || ''}` : '',
    w.motifs && w.motifs.length ? `母題：${w.motifs.join('、')}` : '',
    `進度：第 ${state.position} / ${state.board ? state.board.length - 1 : '?'} 站`,
    qa ? `沿途對話：\n${qa}` : '（尚未有沿途回答）',
    top.length ? `目前主導關鍵字：${top.join('、')}` : '',
    `情緒軌跡：${toneArc(state)}`,
    `能量平衡：${energyBalance(state.params)}`,
    cards.length ? `已拾得的訊息：${cards.join('、')}` : '',
  ].filter(Boolean);
  return `<journey_context>\n${lines.join('\n')}\n</journey_context>`;
}

// 追加一個敘事 beat，並更新 runningSummary（模板端串接，免 AI）
export function appendBeat(state, beat) {
  state.narrative.beats.push(beat);
  const summaries = state.narrative.beats.map((b) => b.summary).filter(Boolean);
  // 只保留最近 6 個 beat 的串接，避免無限增長
  state.narrative.runningSummary = summaries.slice(-6).join('；');
}
