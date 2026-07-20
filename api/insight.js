// api/insight.js — Vercel serverless 代理。單一端點，以 action 分派。
// 注入 system prompt、依 action 選模型、用 structured outputs 取回 JSON、驗證後回傳。
// 前端永不指定模型、永不看到金鑰。
//
// 雙供應商：設 OPENAI_API_KEY 走 OpenAI；否則設 ANTHROPIC_API_KEY 走 Claude；
// 兩者皆設時優先 OpenAI；都沒設則回 fallback（前端離線後備）。
//
// actions（規格 v1.0）：
//   hypothesize（描述＋牌＋卦 → 3–5 個拖延機制假說）
//   probe（假說驅動的驗證提問，一次一題共四題）
//   confirm（第五題：主假說陳述，供使用者確認）
//   analyze（最後分析：五段式＋對應說明）
// 回傳：{ ok:true, data } 或 { ok:false, fallback:true }。

import { SYSTEM_PROMPT } from '../prompts/system.js';

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';

// 假說品質是整站核心 → probe 也用強模型；最後分析用最強。
const MODEL = {
  hypothesize: 'claude-sonnet-5',
  probe: 'claude-sonnet-5',
  confirm: 'claude-sonnet-5',
  analyze: 'claude-opus-4-8',
};

// OpenAI 對應（模型名可用環境變數覆寫）：
//   OPENAI_MODEL_STRONG（預設 gpt-5.1）、OPENAI_MODEL_LIGHT（預設 gpt-5-mini，目前未使用）
function openaiModels() {
  const strong = process.env.OPENAI_MODEL_STRONG || 'gpt-5.1';
  return { hypothesize: strong, probe: strong, confirm: strong, analyze: strong };
}

const MAX_TOKENS = { hypothesize: 1000, probe: 250, confirm: 600, analyze: 2200 };

const MECHANISMS = [
  'timing', 'fear', 'beliefs', 'method', 'excitement',
  'worthiness', 'identity', 'emotional_avoidance', 'energy',
];

const S = (extra) => ({ type: 'string', ...extra });
const ARR = (items) => ({ type: 'array', items });
const OBJ = (required, properties) => ({ type: 'object', additionalProperties: false, required, properties });

const SCHEMAS = {
  hypothesize: OBJ(['hypotheses'], {
    hypotheses: ARR(OBJ(['mechanism', 'hypothesis', 'signals'], {
      mechanism: S({ enum: MECHANISMS }),
      hypothesis: S(),
      signals: ARR(S()),
    })),
  }),
  probe: OBJ(['question'], { question: S() }),
  confirm: OBJ(['statement'], { statement: S() }),
  analyze: OBJ(['meaning', 'coreBelief', 'direction', 'need', 'action', 'basis', 'closing'], {
    meaning: S(), coreBelief: S(), direction: S(),
    need: S(), action: S(), basis: S(), closing: S(),
  }),
};

function buildPrompt(action, p) {
  switch (action) {
    case 'hypothesize':
      return `使用者描述的拖延情境：「${String(p.opening || '').slice(0, 600)}」

【符號視角一：雷諾曼九宮格讀數（內部參考）】
${JSON.stringify(p.lenormand || {}).slice(0, 3500)}

【符號視角二：梅花易數讀數（內部參考）】
${JSON.stringify(p.meihua || {}).slice(0, 1500)}

請根據「描述＋牌陣＋卦象」建立 3–5 個拖延機制假說（hypotheses）。
- 每個假說：mechanism 從機制清單擇一；hypothesis 一兩句白話陳述；signals 列出支持它的具體證據（使用者的字句／牌陣訊號／卦象讀數，各註明來源）。
- 假說之間要能互相區辨（不同機制、或同機制的不同方向），排序依證據強度。
- 特別檢查 timing vs fear 的分歧：若兩者都有跡象，各立一個假說，讓後續提問去區辨。`;
    case 'probe':
      return `使用者描述的拖延情境：「${String(p.opening || '').slice(0, 600)}」

【目前的工作假說（內部）】
${JSON.stringify(p.hypotheses || []).slice(0, 2500)}

【已問過的驗證問答】
${String(p.transcript || '（尚無，這是第一題）').slice(0, 3000)}

這是第 ${p.questionIndex || 1} 題（共 ${p.totalQuestions || 4} 題）。
請生成 question：一個最能區辨（驗證或排除）上述假說的開放式問題。
鐵則：只輸出問題本身——不分析、不解釋、不加前言或對上一題的回應。≤60字、溫柔、生活語言、不用任何術語。根據前面的回答挑最有資訊量的分歧點；若使用者上一題跳過，換個角度，不追問同一件事。`;
    case 'confirm':
      return `使用者描述的拖延情境：「${String(p.opening || '').slice(0, 600)}」

【工作假說（內部）】
${JSON.stringify(p.hypotheses || []).slice(0, 2500)}

【四題驗證問答】
${String(p.transcript || '').slice(0, 4000)}

四題問完了。請整合所有證據，形成**主要假說**，生成 statement：
- 3–6 句、≤220字，直接說給使用者聽（第二人稱），引用至少一句他的原話。
- 挑證據最強的一個主軸；不提牌名、卦名、機制術語。
- 語氣是「綜合看下來，我的假說是……」，結尾請他確認這個假說是、部分是、還是不是。`;
    case 'analyze':
      return `探索抵達終點。以下是全部證據：

【使用者描述的拖延情境】「${String(p.opening || '').slice(0, 600)}」

【工作假說（內部）】
${JSON.stringify(p.hypotheses || []).slice(0, 2500)}

【四題驗證問答】
${String(p.transcript || '').slice(0, 4000)}

【第五題：主假說與使用者的裁決】
假說陳述：「${String(p.confirmation?.statement || '').slice(0, 800)}」
使用者的回答：${{ yes: '是', partly: '部分是', no: '不是' }[p.confirmation?.verdict] || '（未回答）'}
${p.confirmation?.note ? `使用者的補充：「${String(p.confirmation.note).slice(0, 800)}」` : ''}

【雷諾曼九宮格讀數（內部參考；牌名僅可用於 basis）】
${JSON.stringify(p.lenormand || {}).slice(0, 3500)}

【梅花易數讀數（內部參考；卦名僅可用於 basis）】
${JSON.stringify(p.meihua || {}).slice(0, 1500)}

請認真對待使用者的裁決（是→深化；部分是→修正；不是→以他的說法重新框定並承認先前不準），生成最後分析：
- meaning：這個拖延真正可能代表什麼（150–250字，引用原話）。
- coreBelief：正在運作的核心信念（80–150字，把隱形規則說出來）。
- direction：雷諾曼與梅花共同指出的方向（120–200字，收斂之處，翻譯成生活語言，不提牌名卦名）。
- need：目前真正需要的是什麼（80–150字）。
- action：一個最值得嘗試的小行動（具體、低門檻、附「做完觀察什麼」）。
- basis：對應說明（150–280字）——唯一可出現牌名卦名的區塊：2–4 張關鍵牌（牌名＋位置）對應哪個觀察、本卦變卦與體用格局如何支撐 direction 與 action。
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

// 極簡防濫用：per-IP 每小時上限（best-effort；正式版改用 KV）
const RATE = new Map();
const RATE_LIMIT = 70; // 每 IP 每小時最多 70 次呼叫（每場約 7 次 → 約 10 場）
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
