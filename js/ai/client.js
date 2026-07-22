// client.js — 對 serverless 代理 /api/insight 的 fetch 包裝。
// AI_CONFIG.enabled 為總開關；任何失敗都 throw，交由 integrate.js 降級。
// 代理端負責注入 system prompt、選模型、驗證 JSON；前端永不指定模型、永不碰金鑰。

export const AI_CONFIG = {
  enabled: true,           // 設 false 可強制全程離線（純模板）
  endpoint: '/api/insight',
  // 逾時需涵蓋 serverless 上限（insight maxDuration 60s）＋網路開銷。
  // 曾設 20s：帶完整星盤的分析常超過 20s 就被前端中止 → 走離線後備，
  // 使用者只拿到模板訊息（舊版會顯示「完整解讀需要連線模式」）。
  timeoutMs: 75000,
};

export async function callAI(action, payload) {
  if (!AI_CONFIG.enabled) throw new Error('AI disabled');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), AI_CONFIG.timeoutMs);
  try {
    const res = await fetch(AI_CONFIG.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, ...payload }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error('proxy HTTP ' + res.status);
    const json = await res.json();
    if (!json || json.ok !== true || !json.data) throw new Error('proxy returned fallback');
    return json.data;
  } finally {
    clearTimeout(timer);
  }
}
