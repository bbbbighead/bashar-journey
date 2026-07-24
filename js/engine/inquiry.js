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
import { sessionId } from '../analytics.js';

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

// 報數起卦：numbers 為 [n1,n2,n3]（1–9 單位數）；null 表示未報數 → 以時間起卦（後備）
export function castMeihua(state, numbers) {
  state.numbers = Array.isArray(numbers) ? numbers.slice(0, 3) : null;
  state.meihua = state.numbers
    ? castFromNumbers(state.numbers[0], state.numbers[1], state.numbers[2])
    : castHexagrams(state.opening);
  return state.meihua;
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

// 只保留使用者所選工具需要的引擎資料
function ensureSelected(state) {
  if (state.tools.includes('lenormand')) ensureSpread(state);
  if (state.tools.includes('meihua') && !state.meihua) castMeihua(state, state.numbers);
}

// ---- 2. 分析（主題＋所選工具 → 分節結果；兩個以上工具加交叉綜合） ----
export async function getAnalysis(state) {
  ensureSelected(state);

  if (aiOn(state)) {
    const payload = {
      sid: sessionId(), // 供 server 端把實際送出的 prompt 記錄到這筆來訪
      tools: state.tools,
      opening: state.opening,
      lenormand: state.tools.includes('lenormand') ? spreadForAI(state.lenormand) : null,
      meihua: state.tools.includes('meihua') ? meihuaForAI(state.meihua) : null,
      astro: state.tools.includes('astro') ? astroForAI(state.astro) : null,
    };
    let data = await tryAI(state, 'analyze', payload);
    if (!data) data = await tryAI(state, 'analyze', payload); // 暫時性失敗重試一次再降級
    if (data && Array.isArray(data.sections) && data.sections.length) {
      state.analysis = {
        title: String(data.title || '分析結果'),
        sections: data.sections.map((s) => ({ tool: String(s.tool || ''), content: String(s.content || '') })),
        closing: String(data.closing || ''),
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

// ---- 離線後備（從簡：各所選工具的引擎讀數 + 固定段落拼成分節） ----
function offlineAnalysis(state) {
  const sections = [];
  if (state.tools.includes('lenormand')) {
    const patterns = offlinePatterns(state.lenormand);
    sections.push({
      tool: 'lenormand',
      content: [
        '這一組牌共同指向幾件事：',
        ...patterns.slice(0, 3).map(ensurePeriod),
      ].join('\n'),
    });
  }
  if (state.tools.includes('meihua')) {
    sections.push({ tool: 'meihua', content: offlineDynamics(state.meihua).join('\n') });
  }
  if (state.tools.includes('astro')) {
    sections.push({ tool: 'astro', content: '完整的星盤解讀需要連線模式（AI）。此刻先以其他工具為你整理。' });
  }
  if (state.tools.length > 1) {
    sections.push({ tool: 'synthesis', content: [OFFLINE_MESSAGE.bridge, OFFLINE_MESSAGE.invite].join('\n\n') });
  }
  return {
    title: '分析結果',
    sections,
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

