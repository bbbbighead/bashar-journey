// integrate.js — 洞察整合引擎：串接整場對談的每一步。
// 先試 AI（serverless 代理），失敗即靜默降級到手寫模板 + 符號引擎的規則式整合。
// 對 UI 而言介面一致：不論 AI 是否成功，回傳形狀相同。
//
// 流程：getNextQuestion ×4 → getMirror（理解確認）→ getReading（擲引擎 + 多源整合）

import { callAI, AI_CONFIG } from '../ai/client.js';
import { logAiCall, NARRATIVE_TURNS } from './session.js';
import { drawSpread, spreadForAI, convergingClusters, offlinePatterns } from './lenormand.js';
import { castHexagrams, castFromNumbers, meihuaForAI, offlineDynamics } from './meihua.js';
import {
  NARRATIVE_QUESTIONS, offlineMirror,
  CLUSTER_QUESTIONS, CLUSTER_EXPERIMENTS, CLOSINGS, GENERIC_QUESTIONS,
} from '../content/templates.js';

function aiOn(state) {
  return AI_CONFIG.enabled && state.aiAvailable;
}

async function tryAI(state, action, payload) {
  const t0 = Date.now();
  try {
    const data = await callAI(action, payload);
    logAiCall(state, { action, ms: Date.now() - t0, ok: true });
    return data;
  } catch (e) {
    logAiCall(state, { action, ms: Date.now() - t0, ok: false });
    return null;
  }
}

// 對談逐字稿（給 AI 的緊湊格式）
function transcript(state) {
  return state.turns
    .map((t, i) => `問${i + 1}：${t.question}\n答：${t.answer || '（先跳過）'}`)
    .join('\n');
}

// ---- 1. 敘事收集：下一個提問（共 3 題） ----
// 涵蓋面向依序：現況 → 情緒與身體 → 重複模式與渴望
const COVERAGE = ['現況與具體情境', '情緒、想法與身體感受', '重複的模式、已試過的方法，以及期待的樣子'];

export async function getNextQuestion(state) {
  const idx = state.turns.length; // 0-based
  if (idx >= NARRATIVE_TURNS) return null;

  if (aiOn(state)) {
    const data = await tryAI(state, 'followup', {
      opening: state.opening,
      transcript: transcript(state),
      questionIndex: idx + 1,
      totalQuestions: NARRATIVE_TURNS,
      coverage: COVERAGE[idx],
    });
    if (data && data.question) {
      return { question: String(data.question).slice(0, 200), _ai: true };
    }
  }
  return { question: NARRATIVE_QUESTIONS[idx], _ai: false };
}

// ---- 2. 收下回答（純本地） ----
export function submitAnswer(state, question, answer) {
  const clean = answer == null ? null : String(answer).trim().slice(0, 800);
  state.turns.push({ question, answer: clean });
}

// ---- 3. 理解確認（mirror）：回照 + 內部個案模型 ----
export async function getMirror(state) {
  if (aiOn(state)) {
    const data = await tryAI(state, 'mirror', {
      opening: state.opening,
      transcript: transcript(state),
    });
    if (data && data.mirror) {
      state.caseModel = data.caseModel || null;
      state.mirror = { text: sanitize(String(data.mirror)), correction: null };
      return state.mirror.text;
    }
  }
  state.caseModel = null; // 離線：整合時直接用規則式
  state.mirror = { text: offlineMirror(state), correction: null };
  return state.mirror.text;
}

export function submitCorrection(state, correction) {
  const clean = correction == null ? null : String(correction).trim().slice(0, 800);
  if (state.mirror) state.mirror.correction = clean;
}

// ---- 4. 占卜引擎（純本地） ----

// 進入九宮格站時抽牌（玩家看得到牌面）
export function ensureSpread(state) {
  if (!state.lenormand) state.lenormand = drawSpread();
  return state.lenormand;
}

// 報數起卦：numbers 為 [n1, n2, n3]（1–100）；null 表示跳過 → 以時間起卦
export function castMeihua(state, numbers) {
  state.numbers = Array.isArray(numbers) ? numbers.slice(0, 3) : null;
  state.meihua = state.numbers
    ? castFromNumbers(state.numbers[0], state.numbers[1], state.numbers[2])
    : castHexagrams(state.opening);
  return state.meihua;
}

// 後備：直接進整合時仍保證兩個引擎都有結果
export function ensureEngines(state) {
  ensureSpread(state);
  if (!state.meihua) castMeihua(state, state.numbers);
}

// ---- 5. 多源整合 → 照見文件 ----
export async function getReading(state) {
  ensureEngines(state);

  if (aiOn(state)) {
    const data = await tryAI(state, 'integrate', {
      opening: state.opening,
      transcript: transcript(state),
      correction: state.mirror && state.mirror.correction,
      caseModel: state.caseModel,
      lenormand: spreadForAI(state.lenormand),
      meihua: meihuaForAI(state.meihua),
    });
    if (data && data.understanding) {
      state.reading = {
        understanding: sanitize(String(data.understanding)),
        newPerspective: sanitize(String(data.newPerspective || '')),
        tension: sanitize(String(data.tension || '')),
        questions: (Array.isArray(data.questions) ? data.questions : []).slice(0, 3).map((q) => sanitize(String(q))),
        experiment: sanitize(String(data.experiment || '')),
        closing: sanitize(String(data.closing || '')),
      };
      state.status = 'done';
      return state.reading;
    }
  }

  state.reading = offlineReading(state);
  state.status = 'done';
  return state.reading;
}

// ---- 離線整合：符號引擎 + 玩家原話的規則式拼接 ----
function offlineReading(state) {
  const clusters = convergingClusters(state.lenormand);
  const patterns = offlinePatterns(state.lenormand);
  const dynamics = offlineDynamics(state.meihua);

  const answered = state.turns.filter((t) => t.answer);
  const longest = answered.slice().sort((a, b) => b.answer.length - a.answer.length)[0];

  // 我所理解的你：提問 + 原話回扣 + 第一條模式觀察
  const u = [`回到你帶來的問題——「${stripEnd(state.opening)}」。`];
  if (longest) {
    u.push(`這場對談裡最有份量的，是你自己說的：「${stripEnd(longest.answer.slice(0, 60))}${longest.answer.length > 60 ? '…' : ''}」。很多時候，理解就藏在我們自己說出口的話裡。`);
  } else {
    u.push('這場對談你多半選擇安靜地走過——安靜不是空白，它常常意味著：有些東西還沒準備好變成語言。這本身就值得被尊重。');
  }
  if (state.mirror && state.mirror.correction) {
    u.push(`你後來補充的那段話也很重要：「${stripEnd(state.mirror.correction.slice(0, 50))}${state.mirror.correction.length > 50 ? '…' : ''}」——我把它一起放進了理解裡。`);
  }
  if (patterns[0]) u.push(ensurePeriod(patterns[0]));

  // 另一種視角：時機動能 + 其餘模式觀察
  const p = [...dynamics, ...patterns.slice(1, 3).map(ensurePeriod)];

  // 值得探索的張力：對立群集 → 明確張力；否則通用
  const tension = detectTension(clusters);

  // 反思提問：依收斂群集 + 通用補足
  const qs = clusters.slice(0, 2).map((c) => CLUSTER_QUESTIONS[c.cluster]).filter(Boolean);
  for (const g of GENERIC_QUESTIONS) { if (qs.length >= 2) break; qs.push(g); }

  // 一個小實驗
  const expCluster = clusters[0] ? clusters[0].cluster : 'insight';
  const experiment = CLUSTER_EXPERIMENTS[expCluster];

  const closing = CLOSINGS[hashCode(state.runId) % CLOSINGS.length];

  return {
    understanding: u.join('\n\n'),
    newPerspective: p.join('\n\n'),
    tension,
    questions: qs,
    experiment,
    closing,
  };
}

// 對立主題 → 張力語句（規格：矛盾呈現為值得探索之處，而非錯誤）
const TENSION_PAIRS = [
  ['movement', 'stability', '你身上同時住著兩股真實的力量：一股想走、想變、想離開現狀；另一股想留、想穩、想守住已有的根。它們不是敵人——值得探索的是：它們各自在保護你什麼？'],
  ['emotion', 'insight', '你一邊渴望想清楚、看明白，一邊有很深的感受在推動這一切。當分析和感受給出不同答案時，你通常聽誰的？那個習慣，是怎麼來的？'],
  ['effort', 'ending', '你還在用力經營的東西裡，可能藏著一部分其實已經完結的東西。值得探索：哪些力氣是在灌溉，哪些力氣只是捨不得？'],
  ['connection', 'challenge', '你渴望靠近人，同時又用警覺和距離保護自己。這份矛盾不需要立刻解決——但值得問：那套保護機制，是為現在的你設計的，還是為很久以前的你？'],
];

function detectTension(clusters) {
  const present = new Set(clusters.map((c) => c.cluster));
  for (const [a, b, sentence] of TENSION_PAIRS) {
    if (present.has(a) && present.has(b)) return sentence;
  }
  return '這場對談裡，你說的話和你選擇不說的話之間，也許存在一個值得探索的空隙——那些被你輕輕帶過的部分，往往正是重量所在。';
}

function ensurePeriod(s) {
  return /[。！？…]$/.test(s) ? s : s + '。';
}

// 引號內文字去尾句號，避免「……。」。的重複標點
function stripEnd(s) {
  return String(s || '').replace(/[。．\s]+$/, '');
}

function hashCode(s) {
  let h = 0;
  for (let i = 0; i < String(s).length; i++) h = (h * 31 + String(s).charCodeAt(i)) >>> 0;
  return h;
}

// ---- 去識別：抹去可能外洩的占卜術語（最後防線；主要靠 prompt 約束） ----
const TERM_REPLACEMENTS = [
  [/雷諾曼|塔羅|占卜|算命/g, '內在探索'],
  [/梅花易數|易經|六爻|動爻|體用|本卦|互卦|變卦|卦象|起卦|卦辭/g, '時機的觀察'],
  [/牌陣|抽牌|翻牌|這張牌|牌面/g, '這個視角'],
];

export function sanitize(text) {
  let t = String(text || '');
  for (const [re, rep] of TERM_REPLACEMENTS) t = t.replace(re, rep);
  return t;
}
