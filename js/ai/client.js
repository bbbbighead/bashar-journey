// client.js — 對 serverless 代理 /api/journey 的 fetch 包裝
// MVP：AI_CONFIG.enabled 控制是否啟用。離線開發時設 false，orchestrator 會直接走降級。
// 代理端負責注入 system prompt、選模型、驗證 JSON；前端永不指定模型、永不 parse 原始模型文字。

export const AI_CONFIG = {
  enabled: true,          // 設 false 可強制全程離線（純模板）
  endpoint: '/api/journey',
  timeoutMs: 12000,
};

// 呼叫代理。成功回傳已驗證的 data 物件；任何失敗都 throw，交由 orchestrator 降級。
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
    if (!json || json.ok !== true || !json.data) {
      throw new Error('proxy returned fallback');
    }
    return json.data;
  } finally {
    clearTimeout(timer);
  }
}
