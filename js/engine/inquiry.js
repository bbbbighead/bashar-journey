// inquiry.js — 拖延探索引擎（無問答互動版）。
// 先試 AI（serverless 代理），失敗即靜默降級到引擎規則式分析。
// 對 UI 而言介面一致：不論 AI 是否成功，回傳形狀相同。
//
// 流程：ensureSpread → castMeihua → getAnalysis（描述＋牌＋卦 → 最後分析）

import { callAI, AI_CONFIG } from '../ai/client.js';
import { logAiCall } from './session.js';
import { drawSpread, spreadForAI, convergingClusters, offlinePatterns } from './lenormand.js';
import { castHexagrams, castFromNumbers, meihuaForAI, offlineDynamics, RELATION_MEANING } from './meihua.js';
import { STAGE_MEANING } from '../../data/hexagrams.js';
import { OFFLINE_ANALYSIS } from '../content/templates.js';

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

// ---- 1. 占卜（純本地） ----

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

// ---- 2. 最後分析（描述＋雷諾曼＋梅花易數 → 五段式） ----
export async function getAnalysis(state) {
  ensureEngines(state);

  if (aiOn(state)) {
    const data = await tryAI(state, 'analyze', {
      opening: state.opening,
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

// ---- 離線最後分析（從簡：固定素材 + 引擎讀數 + 情境回扣） ----
function offlineAnalysis(state) {
  const patterns = offlinePatterns(state.lenormand);
  const dynamics = offlineDynamics(state.meihua);

  const meaningParts = [
    `回到你描述的情境——「${stripEnd(state.opening)}」。`,
    OFFLINE_ANALYSIS.meaning,
  ];

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
    lines.push(`動爻之後轉為變卦「${cast.bian.name}」（${STAGE_MEANING[cast.bian.stage].label}），加上體用「${RELATION_MEANING[cast.relation].label}」的格局——「方向」與「下一步」的判讀，便是以此為據。`);
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
