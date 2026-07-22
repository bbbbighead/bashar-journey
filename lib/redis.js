// lib/redis.js — Upstash Redis REST 極簡客戶端（零依賴，供 serverless functions 使用）。
// 支援 Vercel Marketplace（Upstash）與舊 Vercel KV 兩種環境變數命名。
// 未設定時回傳 null，呼叫端據此靜默略過（埋點不影響主體驗）。

export function redisConfigured() {
  return !!((process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL)
    && (process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN));
}

// 執行一批 Redis 指令（pipeline）。commands: [['LPUSH','key','val'], ...]
// 回傳 [{ result }, ...]；未設定環境變數時回傳 null。
export async function redisPipeline(commands) {
  const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
  if (!url || !token) return null;

  const res = await fetch(url.replace(/\/$/, '') + '/pipeline', {
    method: 'POST',
    headers: {
      authorization: 'Bearer ' + token,
      'content-type': 'application/json',
    },
    body: JSON.stringify(commands),
  });
  if (!res.ok) throw new Error('redis HTTP ' + res.status);
  return res.json();
}
