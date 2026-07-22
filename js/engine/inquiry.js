// inquiry.js — 靈感訊息引擎。
// 先試 AI（serverless 代理），失敗即靜默降級到引擎規則式綜合。
// 對 UI 而言介面一致：不論 AI 是否成功，回傳形狀相同。
//
// 流程：ensureSpread（使用者選牌）→ castMeihua（報數起卦）
//       → getAnalysis（主題＋牌＋卦 → 綜合靈感訊息）

import { callAI, AI_CONFIG } from '../ai/client.js';
import { logAiCall } from './session.js';
import { drawSpread, spreadForAI, offlinePatterns } from './lenormand.js';
import { castHexagrams, castFromNumbers, meihuaForAI, offlineDynamics } from './meihua.js';
import { OFFLINE_MESSAGE, OFFLINE_CLOSINGS } from '../content/templates.js';

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
  if (!state.lenormand) state.lenormand = drawSpread(); // 後備（正常由使用者選牌寫入）
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

// 西洋占星本命盤：呼叫 /api/astro（Swiss Ephemeris 實算；失敗 throw 附 code）
export async function fetchAstroChart(payload) {
  const res = await fetch('/api/astro', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw Object.assign(new Error('astro HTTP ' + res.status), { code: 'calc_failed' });
  const json = await res.json();
  if (!json || !json.ok || !json.chart) throw Object.assign(new Error(json && json.error), { code: (json && json.error) || 'calc_failed' });
  return json.chart;
}

// 給 AI 的星盤摘要：保留完整結構、截取最緊密的相位以控制大小
function astroForAI(chart) {
  if (!chart) return null;
  const aspects = chart.aspects || [];
  return {
    meta: chart.meta,
    points: (chart.points || []).map((p) => ({
      name: p.name, position: p.position, house: p.house, retrograde: p.retrograde,
    })),
    houses: chart.houses,
    intercepted: chart.intercepted,
    duplicatedCuspSigns: chart.duplicatedCuspSigns,
    aspects: [
      ...aspects.filter((a) => a.major).slice(0, 30),
      ...aspects.filter((a) => !a.major).slice(0, 12),
    ],
    structure: chart.structure,
    dispositors: chart.dispositors,
    patterns: chart.patterns,
    unaspected: chart.unaspected,
  };
}

// ---- 2. 綜合靈感訊息（主題＋雷諾曼＋梅花易數 → 單一正式文字） ----
export async function getAnalysis(state) {
  ensureEngines(state);

  if (aiOn(state)) {
    const data = await tryAI(state, 'analyze', {
      opening: state.opening,
      lenormand: spreadForAI(state.lenormand),
      meihua: meihuaForAI(state.meihua),
      astro: astroForAI(state.astro),
    });
    if (data && data.message) {
      state.analysis = {
        title: sanitize(String(data.title || '給你的靈感訊息')),
        message: sanitize(String(data.message)),
        closing: sanitize(String(data.closing || '')),
      };
      state.usedOffline = false;
      state.status = 'done';
      return state.analysis;
    }
  }

  state.analysis = offlineAnalysis(state);
  state.usedOffline = true;
  state.status = 'done';
  return state.analysis;
}

// ---- 離線綜合（從簡：兩個引擎的讀數 + 固定段落拼成一則訊息） ----
function offlineAnalysis(state) {
  const patterns = offlinePatterns(state.lenormand);   // 牌陣的模式觀察（無術語）
  const dynamics = offlineDynamics(state.meihua);      // 時機與節奏的讀數（無術語）

  const paras = [
    `關於「${stripEnd(state.opening)}」——${OFFLINE_MESSAGE.opening}`,
    [OFFLINE_MESSAGE.bridge, ...patterns.slice(0, 2).map(ensurePeriod)].join('\n'),
    dynamics.join('\n'),
    OFFLINE_MESSAGE.invite,
  ];
  if (state.astro) {
    const pts = {};
    for (const p of state.astro.points || []) pts[p.name] = p;
    const bits = ['太陽', '月亮', '上升點'].filter((k) => pts[k]).map((k) => `${k.replace('點', '')}在${pts[k].sign}`);
    if (bits.length) paras.push(`（你的本命星盤已完成精算——${bits.join('、')}。完整的三方交叉解讀需要連線模式，此刻的訊息以牌與卦為主。）`);
  }

  return {
    title: '給你的靈感訊息',
    message: paras.join('\n\n'),
    closing: OFFLINE_CLOSINGS[hashCode(state.runId) % OFFLINE_CLOSINGS.length],
  };
}

function hashCode(s) {
  let h = 0;
  for (let i = 0; i < String(s).length; i++) h = (h * 31 + String(s).charCodeAt(i)) >>> 0;
  return h;
}

function ensurePeriod(s) {
  return /[。！？…]$/.test(s) ? s : s + '。';
}

// 引號內文字去尾句號，避免「……。」。的重複標點
function stripEnd(s) {
  return String(s || '').replace(/[。．\s]+$/, '');
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
