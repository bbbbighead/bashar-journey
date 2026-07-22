// api/insight.js — Vercel serverless 代理。單一端點、單一 action。
// 注入 system prompt、用 structured outputs 取回 JSON、驗證後回傳。
// 前端永不指定模型、永不看到金鑰。
//
// 雙供應商：設 OPENAI_API_KEY 走 OpenAI；否則設 ANTHROPIC_API_KEY 走 Claude；
// 兩者皆設時優先 OpenAI；都沒設則回 fallback（前端離線後備）。
//
// action：analyze（描述＋雷諾曼＋梅花易數 → 五段式最後分析）
// 回傳：{ ok:true, data } 或 { ok:false, fallback:true }。

import { SYSTEM_PROMPT } from '../prompts/system.js';
import { redisPipeline, redisConfigured } from '../lib/redis.js';

// system prompt 版本雜湊（djb2）——prompt 紀錄引用它，system prompt 本體依版本去重存一份
function djb2(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  return h.toString(16);
}
const SYS_HASH = djb2(SYSTEM_PROMPT);

// 把實際送給 LLM 的 prompt 記錄到該次來訪（供後台複盤；失敗靜默，不影響回應）
async function recordPrompt(sid, provider, model, prompt) {
  try {
    if (!sid || !redisConfigured()) return;
    const record = JSON.stringify({
      ts: Date.now(), provider, model, sysHash: SYS_HASH,
      prompt: prompt.slice(0, 20000),
    });
    const results = await redisPipeline([
      ['SET', `pi:prompt:${sid}`, record],
      ['SET', `pi:sysprompt:${SYS_HASH}`, SYSTEM_PROMPT, 'NX'],
      ['INCRBY', 'pi:agg:bytes', String(record.length + 64)],
    ]);
    // system prompt 首次寫入才計入用量
    if (results && results[1] && results[1].result === 'OK') {
      await redisPipeline([['INCRBY', 'pi:agg:bytes', String(SYSTEM_PROMPT.length + 64)]]);
    }
  } catch { /* 靜默 */ }
}

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';

const MODEL = { analyze: 'claude-opus-4-8' };

function openaiModels() {
  const strong = process.env.OPENAI_MODEL_STRONG || 'gpt-5.1';
  return { analyze: strong };
}

const MAX_TOKENS = { analyze: 3000 };

const S = (extra) => ({ type: 'string', ...extra });
const ARR = (items) => ({ type: 'array', items });
const OBJ = (required, properties) => ({ type: 'object', additionalProperties: false, required, properties });

const SCHEMAS = {
  analyze: OBJ(['title', 'message', 'closing'], {
    title: S(), message: S(), closing: S(),
  }),
};

function buildPrompt(action, p) {
  switch (action) {
    case 'analyze':
      return `使用者想獲得靈感的主題：「${String(p.opening || '').slice(0, 600)}」

【系統一：雷諾曼九宮格讀數（使用者親手選牌；牌名與術語不得出現在輸出）】
${JSON.stringify(p.lenormand || {}).slice(0, 3500)}

【系統二：梅花易數讀數（使用者報數起卦；卦名與術語不得出現在輸出）】
${JSON.stringify(p.meihua || {}).slice(0, 1500)}

【系統三：西洋占星本命盤（Swiss Ephemeris 實算；僅可依此詮釋，不得補造）】
${p.astro ? JSON.stringify(p.astro).slice(0, 11000) : '（使用者選擇跳過占星——以兩源整合，不假裝有第三源）'}

請依系統提示中的跨系統整合方法：先各自萃取與主題最相關的重點並重新分群；辨認重複呼應（最高優先）、相互補充（占星＝為什麼、卦＝階段、牌＝現實表現，串成因果）、與表面矛盾（分層說明，不強行統一）；區分確定程度；聚焦主題。生成：
- title：這則訊息的名字（≤16字，有畫面感）。
- message：450–800字、4–6 個完整段落的整合敘事，依核心脈絡推進（核心 → 為什麼 → 階段 → 現實表現與阻礙資源 → 共同指向的轉折與方向 → 一致與待觀察之處）。結尾啟發停留在視角、心境或策略層次，**嚴禁開立具體生活行動處方**。不逐牌、逐卦、逐星解釋。
- closing：一句臨別祝福（≤40字）。`;
    default:
      return '';
  }
}

async function callOpenAI(apiKey, model, maxTokens, userPrompt, schema, schemaName) {
  const res = await fetch(OPENAI_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: 'Bearer ' + apiKey,
    },
    body: JSON.stringify({
      model,
      max_completion_tokens: maxTokens * 4, // 推理型模型把思考也算進去，放寬
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userPrompt },
      ],
      response_format: {
        type: 'json_schema',
        json_schema: { name: schemaName, strict: true, schema },
      },
    }),
  });
  if (!res.ok) throw new Error('openai HTTP ' + res.status);
  const json = await res.json();
  const msg = json.choices && json.choices[0] && json.choices[0].message;
  if (!msg || msg.refusal || !msg.content) throw new Error('refusal or empty');
  return JSON.parse(msg.content);
}

async function callAnthropic(apiKey, model, maxTokens, userPrompt, schema) {
  const res = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': ANTHROPIC_VERSION,
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
      output_config: { format: { type: 'json_schema', schema } },
      messages: [{ role: 'user', content: userPrompt }],
    }),
  });
  if (!res.ok) throw new Error('anthropic HTTP ' + res.status);
  const json = await res.json();
  if (json.stop_reason === 'refusal') throw new Error('refusal');
  const textBlock = (json.content || []).find((b) => b.type === 'text');
  if (!textBlock) throw new Error('no text block');
  return JSON.parse(textBlock.text);
}

// 極簡防濫用：per-IP 每小時上限（best-effort；正式版改用 KV）
const RATE = new Map();
const RATE_LIMIT = 30; // 每 IP 每小時最多 30 次呼叫（每場 1 次 → 30 場）
function rateLimited(ip) {
  const now = Date.now();
  const hourAgo = now - 3600_000;
  const hits = (RATE.get(ip) || []).filter((t) => t > hourAgo);
  hits.push(now);
  RATE.set(ip, hits);
  return hits.length > RATE_LIMIT;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ ok: false, fallback: true });
    return;
  }
  const openaiKey = process.env.OPENAI_API_KEY;
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (!openaiKey && !anthropicKey) {
    res.status(200).json({ ok: false, fallback: true });
    return;
  }

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  const action = body && body.action;
  if (!action || !SCHEMAS[action]) {
    res.status(400).json({ ok: false, fallback: true });
    return;
  }

  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
  if (rateLimited(ip)) {
    res.status(200).json({ ok: false, fallback: true });
    return;
  }

  const prompt = buildPrompt(action, body);
  const maxTokens = MAX_TOKENS[action];
  const schema = SCHEMAS[action];

  // 記錄實際送出的 prompt（呼叫前寫入——即使模型呼叫失敗也留有紀錄可複盤）
  const sid = String((body && body.sid) || '').slice(0, 16).replace(/[^\w-]/g, '');
  await recordPrompt(
    sid,
    openaiKey ? 'openai' : 'anthropic',
    openaiKey ? openaiModels()[action] : MODEL[action],
    prompt,
  );

  // 呼叫一次，失敗重試一次，再失敗回 fallback（兩者皆設時優先 OpenAI）
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const data = openaiKey
        ? await callOpenAI(openaiKey, openaiModels()[action], maxTokens, prompt, schema, action)
        : await callAnthropic(anthropicKey, MODEL[action], maxTokens, prompt, schema);
      res.status(200).json({ ok: true, data });
      return;
    } catch (e) {
      if (attempt === 1) {
        res.status(200).json({ ok: false, fallback: true });
        return;
      }
    }
  }
}
