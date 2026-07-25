// inquiry.js — 靈感訊息引擎。
// 解讀一律由 AI（serverless 代理）產生：成功就回傳結果，失敗就 throw，
// 由 UI 顯示重試畫面。刻意不提供離線模板——與其給一段套版文字讓使用者
// 以為那就是他的解讀，不如明說這次沒完成、請再試一次。
//
// 流程：ensureSpread（使用者選牌）→ castMeihua（報數起卦）
//       → getAnalysis（主題＋牌＋卦 → 綜合靈感訊息）

import { callAI, AI_CONFIG } from '../ai/client.js';
import { logAiCall } from './session.js';
import { drawSpread, spreadForAI } from './lenormand.js';
import { castHexagrams, castFromNumbers, meihuaForAI } from './meihua.js';
import { sessionId } from '../analytics.js';
import { getLocale, dict } from '../i18n/index.js';

// 呼叫 AI；失敗時記錄後把錯誤往上拋（含 code，讓 UI 分辨逾時與其他失敗）
async function callAnalyze(state, action, payload) {
  const t0 = Date.now();
  try {
    const data = await callAI(action, payload);
    logAiCall(state, { action, ms: Date.now() - t0, ok: true });
    return data;
  } catch (e) {
    logAiCall(state, { action, ms: Date.now() - t0, ok: false });
    throw e;
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
// 成功回傳 analysis；失敗 throw（err.code：'timeout'｜'unavailable'｜'failed'）。
export async function getAnalysis(state) {
  ensureSelected(state);

  if (!AI_CONFIG.enabled) {
    throw Object.assign(new Error('AI disabled'), { code: 'unavailable' });
  }

  const payload = {
    sid: sessionId(), // 供 server 端把實際送出的 prompt 記錄到這筆來訪
    lang: getLocale(),          // 輸出語言
    groupLabels: dict().groups, // 九宮格小標題必須用這組字，前端據此對應牌卡
    tools: state.tools,
    opening: state.opening,
    lenormand: state.tools.includes('lenormand') ? spreadForAI(state.lenormand) : null,
    meihua: state.tools.includes('meihua') ? meihuaForAI(state.meihua) : null,
    astro: state.tools.includes('astro') ? astroForAI(state.astro) : null,
  };

  const data = await callAnalyze(state, 'analyze', payload);
  if (!data || !Array.isArray(data.sections) || !data.sections.length) {
    throw Object.assign(new Error('empty analysis'), { code: 'failed' });
  }

  state.analysis = {
    title: String(data.title || ''),
    sections: data.sections.map((s) => ({ tool: String(s.tool || ''), content: String(s.content || '') })),
  };
  state.usedOffline = false;
  state.status = 'done';
  return state.analysis;
}
