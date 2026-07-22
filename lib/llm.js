// lib/llm.js — 共用的純文字 LLM 對話補全（後台除錯問答用）。
// 與 api/insight.js 相同的雙供應商策略：OPENAI_API_KEY 優先，其次 ANTHROPIC_API_KEY。
// 回傳 { provider, model, reply }；任何失敗直接 throw，由呼叫端決定如何呈現。

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';

export function llmConfigured() {
  return !!(process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY);
}

export async function chatComplete({ system, messages, maxTokens = 1600 }) {
  // 本地整合測試用（沙箱無外網）：LLM_STUB=1 時回覆固定格式，驗證脈絡組裝與 UI 接線
  if (process.env.LLM_STUB) {
    const last = messages[messages.length - 1];
    return {
      provider: 'stub',
      model: 'stub',
      reply: `[本地測試回覆] 脈絡${system.includes('System Prompt') ? '已' : '未'}含當時 prompt；你的問題：${last ? last.content : ''}`,
    };
  }
  const openaiKey = process.env.OPENAI_API_KEY;
  const anthropicKey = process.env.ANTHROPIC_API_KEY;

  if (openaiKey) {
    const model = process.env.OPENAI_MODEL_STRONG || 'gpt-5.1';
    const res = await fetch(OPENAI_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + openaiKey },
      body: JSON.stringify({
        model,
        max_completion_tokens: maxTokens * 4, // 推理型模型把思考也算進去，放寬
        messages: [{ role: 'system', content: system }, ...messages],
      }),
    });
    if (!res.ok) throw new Error('openai HTTP ' + res.status);
    const json = await res.json();
    const msg = json.choices && json.choices[0] && json.choices[0].message;
    if (!msg || msg.refusal || !msg.content) throw new Error('refusal or empty');
    return { provider: 'openai', model, reply: String(msg.content) };
  }

  if (anthropicKey) {
    const model = 'claude-opus-4-8';
    const res = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': anthropicKey,
        'anthropic-version': ANTHROPIC_VERSION,
      },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        system: [{ type: 'text', text: system }],
        messages,
      }),
    });
    if (!res.ok) throw new Error('anthropic HTTP ' + res.status);
    const json = await res.json();
    if (json.stop_reason === 'refusal') throw new Error('refusal');
    const text = (json.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
    if (!text) throw new Error('empty');
    return { provider: 'anthropic', model, reply: text };
  }

  throw new Error('no_provider');
}
