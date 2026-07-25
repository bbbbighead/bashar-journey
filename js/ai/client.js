// client.js — 對 serverless 代理 /api/insight 的 fetch 包裝。
// AI_CONFIG.enabled 為總開關；任何失敗都 throw（附 code），由 UI 顯示重試畫面。
// 代理端負責注入 system prompt、選模型、驗證 JSON；前端永不指定模型、永不碰金鑰。

export const AI_CONFIG = {
  enabled: true,           // 設 false 會讓解讀一律失敗（僅供除錯重試畫面用）
  endpoint: '/api/insight',
  // 逾時需涵蓋 serverless 上限（insight maxDuration 60s）＋網路開銷。
  // 設太短（曾設 20s）會讓帶完整星盤的分析被前端中止，明明還在跑卻算失敗。
  timeoutMs: 75000,
};

export async function callAI(action, payload) {
  if (!AI_CONFIG.enabled) throw Object.assign(new Error('AI disabled'), { code: 'unavailable' });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), AI_CONFIG.timeoutMs);
  try {
    const res = await fetch(AI_CONFIG.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, ...payload }),
      signal: controller.signal,
    });
    if (!res.ok) throw Object.assign(new Error('proxy HTTP ' + res.status), { code: 'failed' });
    const json = await res.json();
    if (!json || json.ok !== true || !json.data) {
      throw Object.assign(new Error('proxy could not produce a reading'), { code: 'unavailable' });
    }
    return json.data;
  } catch (e) {
    // AbortError＝我方逾時；分開標記，畫面才能說「這次等太久了」而不是「連線失敗」
    if (e && e.name === 'AbortError') throw Object.assign(new Error('analyze timeout'), { code: 'timeout' });
    throw e;
  } finally {
    clearTimeout(timer);
  }
}
