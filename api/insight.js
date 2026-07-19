// api/insight.js — Vercel serverless 代理。單一端點，以 action 分派。
// 注入 system prompt、依 action 選模型、用 structured outputs 取回 JSON、驗證後回傳。
// 前端永不指定模型、永不看到金鑰。
//
// 雙供應商：設 OPENAI_API_KEY 走 OpenAI；否則設 ANTHROPIC_API_KEY 走 Claude；
// 兩者皆設時優先 OpenAI；都沒設則回 fallback（前端離線模板）。
//
// actions：followup（敘事追問，輕量模型）/ mirror（理解確認 + 個案模型，強模型）
//          / integrate（多源整合照見，最強模型）
// 回傳：{ ok:true, data } 或 { ok:false, fallback:true }（前端據此降級）。

import { SYSTEM_PROMPT } from '../prompts/system.js';

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';

const MODEL = {
  followup: 'claude-haiku-4-5',
  mirror: 'claude-sonnet-5',
  integrate: 'claude-opus-4-8',
};

// OpenAI 對應分層，模型名可用環境變數覆寫：
//   OPENAI_MODEL_STRONG（預設 gpt-5.1）、OPENAI_MODEL_LIGHT（預設 gpt-5-mini）
function openaiModels() {
  const strong = process.env.OPENAI_MODEL_STRONG || 'gpt-5.1';
  const light = process.env.OPENAI_MODEL_LIGHT || 'gpt-5-mini';
  return { followup: light, mirror: strong, integrate: strong };
}

const MAX_TOKENS = { followup: 300, mirror: 900, integrate: 2000 };

const S = (extra) => ({ type: 'string', ...extra });
const ARR = (items) => ({ type: 'array', items });
const OBJ = (required, properties) => ({ type: 'object', additionalProperties: false, required, properties });

const SCHEMAS = {
  followup: OBJ(['question'], { question: S() }),
  mirror: OBJ(['mirror', 'caseModel'], {
    mirror: S(),
    caseModel: OBJ(['patterns', 'emotions', 'beliefs', 'resources', 'conflicts', 'desired'], {
      patterns: ARR(S()),   // 重複模式假設
      emotions: ARR(S()),   // 情緒迴圈
      beliefs: ARR(S()),    // 限制性信念假設
      resources: ARR(S()),  // 既有資源與力量
      conflicts: ARR(S()),  // 相互衝突的動機／身分張力
      desired: S(),         // 期待的樣子
    }),
  }),
  integrate: OBJ(['understanding', 'newPerspective', 'tension', 'questions', 'experiment', 'closing'], {
    understanding: S(), newPerspective: S(), tension: S(),
    questions: ARR(S()), experiment: S(), closing: S(),
  }),
};

function buildPrompt(action, p) {
  switch (action) {
    case 'followup':
      return `使用者帶來的問題：「${String(p.opening || '').slice(0, 600)}」

目前的對談逐字稿：
${String(p.transcript || '（尚無，這是第一個追問）').slice(0, 3000)}

這是敘事收集的第 ${p.questionIndex || 1} 個提問（共 ${p.totalQuestions || 3} 個）。
這一問要涵蓋的面向：「${p.coverage || '現況與具體情境'}」。

請生成 question：一個開放式提問（≤80字）——一次只問一件事、順著使用者剛說過的話自然銜接、溫柔不逼迫、不是問卷式的制式提問。若使用者上一題選擇跳過，不要追問同一件事，輕輕換個角度即可。`;
    case 'mirror':
      return `使用者帶來的問題：「${String(p.opening || '').slice(0, 600)}」

完整對談逐字稿：
${String(p.transcript || '').slice(0, 5000)}

敘事收集完成。請生成：
- mirror：理解確認（3-5 句，≤200字）。把你聽到的核心回照給使用者——他真正在說的是什麼、有份量的原話（引用）、你注意到的重複或張力。語氣是「我想確認我有沒有聽對」，結尾邀請他修正或補充。
- caseModel：你的內部個案假設（使用者不會看到）。patterns 重複模式、emotions 情緒迴圈、beliefs 限制性信念、resources 既有資源、conflicts 衝突的動機或身分張力（各 1-4 條，證據不足的留空陣列）、desired 他期待的樣子（一句）。`;
    case 'integrate':
      return `對談抵達整合階段。以下是所有來源的證據：

【使用者的問題】「${String(p.opening || '').slice(0, 600)}」

【完整對談逐字稿】
${String(p.transcript || '').slice(0, 5000)}
${p.correction ? `\n【使用者對理解確認的補充】「${String(p.correction).slice(0, 800)}」` : ''}

【內部個案模型】${p.caseModel ? JSON.stringify(p.caseModel).slice(0, 2000) : '（無——請直接從逐字稿建立你的理解）'}

【符號視角一：模式讀數（內部參考，術語與名稱嚴禁出現在輸出）】
${JSON.stringify(p.lenormand || {}).slice(0, 3500)}

【符號視角二：時機與動能讀數（內部參考，術語與名稱嚴禁出現在輸出）】
${JSON.stringify(p.meihua || {}).slice(0, 1500)}

請比較各來源的證據：找出收斂的主題、互補的洞察、以及矛盾（矛盾呈現為值得探索之處）。敘事永遠優先於符號讀數；符號讀數與敘事衝突時，以敘事為準、把差異放進 tension。然後生成統一的照見文件：
- understanding：250-350字。使用者真正在問的是什麼、你在他的敘事中看見的模式（引用「你說……」的原話）、多個來源共同指向的主題。要讓他感覺被深深聽見。
- newPerspective：150-250字。真正新的視角——把符號讀數中的收斂主題與時機動能，完全翻譯成自然的生活語言（如「此刻的節奏更適合養而不是衝」），提供敘事本身沒有的角度。
- tension：80-150字。一個值得探索的矛盾或張力（來源之間的、或使用者自身的），以好奇而非糾錯的姿態呈現。
- questions：2-3 個反思提問，切中他的具體處境。
- experiment：一個具體、低門檻、一週內可完成的小實驗（不是建議，是實驗——附上「觀察什麼」）。
- closing：一句溫暖收尾（≤40字）。`;
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

// 極簡防濫用：per-IP 每小時上限（best-effort，實例重啟即歸零；正式版改用 KV）
const RATE = new Map();
const RATE_LIMIT = 60; // 每 IP 每小時最多 60 次呼叫（約 10 場對談）
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
    res.status(200).json({ ok: false, fallback: true }); // 未設金鑰 → 前端離線模板
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
