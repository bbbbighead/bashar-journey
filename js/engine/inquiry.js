// inquiry.js — 拖延探索引擎：串接整場探索的每一步。
// 先試 AI（serverless 代理），失敗即靜默降級到規格範例題 + 引擎規則式分析。
// 對 UI 而言介面一致：不論 AI 是否成功，回傳形狀相同。
//
// 流程：ensureSpread → castMeihua → buildHypotheses → getProbe ×4
//       → getConfirmation（第五題）→ getAnalysis（最後分析）

import { callAI, AI_CONFIG } from '../ai/client.js';
import { logAiCall, PROBE_COUNT } from './session.js';
import { drawSpread, spreadForAI, convergingClusters, offlinePatterns } from './lenormand.js';
import { castHexagrams, castFromNumbers, meihuaForAI, offlineDynamics, RELATION_MEANING } from './meihua.js';
import { STAGE_MEANING } from '../../data/hexagrams.js';
import { SPEC_PROBES, OFFLINE_STATEMENTS, OFFLINE_ANALYSIS } from '../content/templates.js';

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

// 四題問答逐字稿（給 AI 的緊湊格式）
function probeTranscript(state) {
  return state.probes
    .map((p, i) => `問${i + 1}：${p.question}\n答：${p.answer || '（先跳過）'}`)
    .join('\n');
}

// ---- 1. 占卜（純本地、先行） ----

export function ensureSpread(state) {
  if (!state.lenormand) state.lenormand = drawSpread();
  return state.lenormand;
}

// 報數起卦：numbers 為 [n1,n2,n3]（1–100）；null 表示跳過 → 以時間起卦
export function castMeihua(state, numbers) {
  state.numbers = Array.isArray(numbers) ? numbers.slice(0, 3) : null;
  state.meihua = state.numbers
    ? castFromNumbers(state.numbers[0], state.numbers[1], state.numbers[2])
    : castHexagrams(state.opening);
  return state.meihua;
}

function ensureEngines(state) {
  ensureSpread(state);
  if (!state.meihua) castMeihua(state, state.numbers);
}

// ---- 2. 建立工作假說（規格核心：描述＋雷諾曼＋梅花 → 3–5 個拖延機制假說） ----
export async function buildHypotheses(state) {
  ensureEngines(state);
  if (aiOn(state)) {
    const data = await tryAI(state, 'hypothesize', {
      opening: state.opening,
      lenormand: spreadForAI(state.lenormand),
      meihua: meihuaForAI(state.meihua),
    });
    if (data && Array.isArray(data.hypotheses) && data.hypotheses.length) {
      state.hypotheses = data.hypotheses.slice(0, 5);
      return state.hypotheses;
    }
  }
  state.hypotheses = null; // 離線：跳過假說層，用規格範例題
  return null;
}

// ---- 3. 四題驗證提問（一次一題、不分析、只提問） ----
export async function getProbe(state) {
  const idx = state.probes.length; // 0-based
  if (idx >= PROBE_COUNT) return null;

  if (aiOn(state) && state.hypotheses) {
    const data = await tryAI(state, 'probe', {
      opening: state.opening,
      hypotheses: state.hypotheses,
      transcript: probeTranscript(state),
      questionIndex: idx + 1,
      totalQuestions: PROBE_COUNT,
    });
    if (data && data.question) {
      return { question: String(data.question).slice(0, 200), _ai: true };
    }
  }
  return { question: SPEC_PROBES[idx], _ai: false };
}

export function submitProbe(state, question, answer) {
  const clean = answer == null ? null : String(answer).trim().slice(0, 800);
  state.probes.push({ question, answer: clean });
}

// ---- 4. 第五題：主假說確認（是／部分是／不是） ----
export async function getConfirmation(state) {
  if (aiOn(state)) {
    const data = await tryAI(state, 'confirm', {
      opening: state.opening,
      hypotheses: state.hypotheses,
      transcript: probeTranscript(state),
    });
    if (data && data.statement) {
      state.confirmation = { statement: sanitize(String(data.statement)), verdict: null, note: null };
      return state.confirmation.statement;
    }
  }
  // 離線：依牌陣最強主題給一個溫和的假說陳述
  const clusters = convergingClusters(state.lenormand);
  const key = clusters[0] ? clusters[0].cluster : 'insight';
  state.confirmation = { statement: OFFLINE_STATEMENTS[key], verdict: null, note: null };
  return state.confirmation.statement;
}

export function submitVerdict(state, verdict, note) {
  if (!state.confirmation) return;
  state.confirmation.verdict = verdict; // 'yes' | 'partly' | 'no'
  state.confirmation.note = note == null ? null : String(note).trim().slice(0, 800);
}

// ---- 5. 最後分析（規格八：五段式） ----
export async function getAnalysis(state) {
  ensureEngines(state);

  if (aiOn(state)) {
    const data = await tryAI(state, 'analyze', {
      opening: state.opening,
      hypotheses: state.hypotheses,
      transcript: probeTranscript(state),
      confirmation: state.confirmation,
      lenormand: spreadForAI(state.lenormand),
      meihua: meihuaForAI(state.meihua),
    });
    if (data && data.meaning) {
      state.analysis = {
        meaning: sanitize(String(data.meaning)),
        coreBelief: sanitize(String(data.coreBelief || '')),
        direction: sanitize(String(data.direction || '')),
        need: sanitize(String(data.need || '')),
        action: sanitize(String(data.action || '')),
        // 對應說明：唯一允許出現牌名與卦名的區塊，不做術語去識別
        basis: String(data.basis || '') || offlineBasis(state),
        closing: sanitize(String(data.closing || '')),
      };
      state.status = 'done';
      return state.analysis;
    }
  }

  state.analysis = offlineAnalysis(state);
  state.status = 'done';
  return state.analysis;
}

// ---- 離線最後分析（從簡：固定素材 + 引擎讀數 + 原話回扣） ----
function offlineAnalysis(state) {
  const patterns = offlinePatterns(state.lenormand);
  const dynamics = offlineDynamics(state.meihua);

  const answered = state.probes.filter((p) => p.answer);
  const longest = answered.slice().sort((a, b) => b.answer.length - a.answer.length)[0];

  const meaningParts = [`回到你描述的情境——「${stripEnd(state.opening)}」。`, OFFLINE_ANALYSIS.meaning];
  if (longest) {
    meaningParts.push(`而你自己說的這句話值得留著：「${stripEnd(longest.answer.slice(0, 50))}${longest.answer.length > 50 ? '…' : ''}」。`);
  }
  if (state.confirmation && state.confirmation.verdict === 'no' && state.confirmation.note) {
    meaningParts.push(`你不同意先前的假說，並說：「${stripEnd(state.confirmation.note.slice(0, 50))}」——請以你自己的版本為準；下面的分析請當成多一雙眼睛，而不是結論。`);
  }

  const direction = [...patterns.slice(0, 2).map(ensurePeriod), ...dynamics].join('\n\n');

  return {
    meaning: meaningParts.join('\n\n'),
    coreBelief: OFFLINE_ANALYSIS.coreBelief,
    direction,
    need: OFFLINE_ANALYSIS.need,
    action: OFFLINE_ANALYSIS.action,
    basis: offlineBasis(state),
    closing: OFFLINE_ANALYSIS.closing,
  };
}

// 對應說明（basis）：唯一點名牌與卦的區塊——攤開分析的工作底稿。
function offlineBasis(state) {
  const spread = state.lenormand;
  const cast = state.meihua;
  const lines = [];

  if (spread && spread.length === 9) {
    const clusters = convergingClusters(spread);
    const center = spread[4];
    lines.push(`九宮格的中心是「${center.card.name}」（${center.position.label}）——${firstSentence(center.card.meaning)}上面關於拖延核心的觀察，主要由這張牌定調。`);
    if (clusters[0]) {
      const inCluster = spread.filter((s) => s.card.cluster === clusters[0].cluster);
      const centerInCluster = inCluster.includes(center);
      const mates = inCluster
        .filter((s) => s !== center)
        .map((s) => `「${s.card.name}」（${POS_SHORT(s.position)}）`);
      if (inCluster.length >= 2) {
        lines.push(`${mates.join('、')}${centerInCluster ? `與中心的「${center.card.name}」` : ''}共 ${clusters[0].n} 張牌同屬「${clusters[0].label}」的主題——這是牌陣裡最強的收斂訊號。`);
      }
    }
  }

  if (cast && cast.ben) {
    const src = state.numbers ? `你報的三個數（${state.numbers.join('、')}）` : '此刻的時間';
    lines.push(`${src}起出的本卦是「${cast.ben.name}」（${STAGE_MEANING[cast.ben.stage].label}）——${cast.ben.dyn}`);
    lines.push(`動爻之後轉為變卦「${cast.bian.name}」（${STAGE_MEANING[cast.bian.stage].label}），加上體用「${RELATION_MEANING[cast.relation].label}」的格局——「方向」與「下一步」的判讀，便是以此為據，再與你的回答相互印證。`);
  }

  return lines.join('\n\n');
}

function firstSentence(m) {
  const first = String(m || '').split('。')[0];
  return first ? first + '。' : '';
}

function POS_SHORT(position) {
  const t = { past: '過去', present: '現在', future: '走向' }[position.time] || '';
  const l = { mind: '想法', core: '現實', root: '潛意識' }[position.layer] || '';
  return `${t}・${l}`;
}

function ensurePeriod(s) {
  return /[。！？…]$/.test(s) ? s : s + '。';
}

// 引號內文字去尾句號，避免「……。」。的重複標點
function stripEnd(s) {
  return String(s || '').replace(/[。．\s]+$/, '');
}

// ---- 去識別：正文抹去可能外洩的占卜術語（basis 區塊除外；主要靠 prompt 約束） ----
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
