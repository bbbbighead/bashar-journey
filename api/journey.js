// api/journey.js — Vercel serverless 代理。單一端點，以 action 分派。
// 注入 system prompt、依 action 選模型、用 structured outputs 取回 JSON、驗證後回傳。
// 前端永不指定模型、永不看到金鑰。
//
// 雙供應商：設 OPENAI_API_KEY 走 OpenAI；否則設 ANTHROPIC_API_KEY 走 Claude；
// 兩者皆設時優先 OpenAI；都沒設則回 fallback（前端離線模板）。
//
// v2 actions：genesis / reflect / collect / finale（對話式旅程，無選擇題）。
// 回傳：{ ok:true, data } 或 { ok:false, fallback:true }（前端據此降級到模板）。

import { SYSTEM_PROMPT } from '../prompts/system.js';

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';

// 模型分層：collect 是 v2 的情感核心（讀玩家的話、寫個人化訊息）→ 與 genesis 同用強模型；
// reflect 輕量；finale 是最終答案用最強。
const MODEL = {
  genesis: 'claude-sonnet-5',
  reflect: 'claude-haiku-4-5',
  collect: 'claude-sonnet-5',
  finale: 'claude-opus-4-8',
};

// OpenAI 對應分層。模型名可用環境變數覆寫（OpenAI 型號更迭快，不必改程式）：
//   OPENAI_MODEL_STRONG（預設 gpt-5.1）、OPENAI_MODEL_LIGHT（預設 gpt-5-mini）
function openaiModels() {
  const strong = process.env.OPENAI_MODEL_STRONG || 'gpt-5.1';
  const light = process.env.OPENAI_MODEL_LIGHT || 'gpt-5-mini';
  return { genesis: strong, reflect: light, collect: strong, finale: strong };
}

const MAX_TOKENS = {
  genesis: 700, reflect: 400, collect: 800, finale: 1400,
};

const ALLOWED_THEMES = ['pet', 'relationship', 'career', 'health', 'purpose', 'generic', 'crisis'];
const PALETTES = ['warm', 'cool', 'verdant', 'cosmic'];
const ENERGIES = ['expansion', 'contraction', 'surrender', 'service', 'joy', 'fear'];
const EMOTION_TONES = ['hopeful', 'fearful', 'calm', 'excited', 'curious', 'tender', 'grateful', 'peaceful'];

const S = (extra) => ({ type: 'string', ...extra });
const ARR = (items) => ({ type: 'array', items });
const OBJ = (required, properties) => ({ type: 'object', additionalProperties: false, required, properties });

const paramDeltaSchema = OBJ(['keywords', 'tone', 'energy'], {
  keywords: ARR(S()),
  tone: S({ enum: EMOTION_TONES }),
  energy: S({ enum: ENERGIES }),
});

const SCHEMAS = {
  genesis: OBJ(['normalizedIntent', 'themeId', 'lang', 'entities', 'world'], {
    normalizedIntent: S({ enum: ALLOWED_THEMES }),
    themeId: S({ enum: ALLOWED_THEMES }),
    lang: S({ enum: ['zh', 'en'] }),
    entities: ARR(S()),
    world: OBJ(['title', 'setting', 'palette', 'motifs', 'tileThemeWords'], {
      title: S(), setting: S(), palette: S({ enum: PALETTES }),
      motifs: ARR(S()), tileThemeWords: ARR(S()),
    }),
  }),
  reflect: OBJ(['scene', 'question'], {
    scene: S(), question: S(),
  }),
  collect: OBJ(['pickup', 'reading', 'paramDelta'], {
    pickup: S(), reading: S(), paramDelta: paramDeltaSchema,
  }),
  finale: OBJ(['title', 'coreAnswer', 'recap', 'keyCards', 'suggestedPractice', 'closingBlessing'], {
    title: S(), coreAnswer: S(), recap: S(),
    keyCards: ARR(S()), suggestedPractice: S(), closingBlessing: S(),
  }),
};

// 依 action 組出 user prompt（Journey Context Block 由前端算好一併傳入）
function buildPrompt(action, p) {
  switch (action) {
    case 'genesis':
      return `玩家的提問：「${String(p.question || '').slice(0, 500)}」

請為這個提問生成一個「與提問高度相關」的沉浸式世界。
- normalizedIntent 與 themeId 從這些選項擇一：${ALLOWED_THEMES.join(' / ')}（若無明確歸屬用 generic；若含危機/自我傷害訊號用 crisis）。
- palette 從：${PALETTES.join(' / ')} 擇一。
- tileThemeWords 需正好 ${p.boardLength || 8} 個、貼合世界主題的關鍵詞（對應旅程的 ${p.boardLength || 8} 站，首站宜近「啟程」、末站宜近「回應」）。
- title 精簡有畫面（≤16字），setting 一到兩句（≤60字），motifs 給 2–4 個母題意象。
- entities：從提問中萃取 2–6 個關鍵名詞。`;
    case 'reflect':
      return `${p.journeyContext}

這是旅程中第 ${p.questionIndex || 1} 個提問（共 ${p.totalQuestions || 3} 個），這一站的主題風味詞是「${p.tile?.themeWord}」。
深度遞進原則：第 1 問貼近現況與感受；第 2 問輕觸卡點與恐懼；第 3 問開向渴望與可能。
請生成：
- scene：一小段沉浸場景（≤60字），貼合世界意象，並自然銜接玩家先前的回答（若有）。
- question：一個開放式提問（≤40字）——一次只問一件事、溫柔不逼迫、邀請玩家說出自己的話（不是選擇題、不是是非題）。`;
    case 'collect':
      return `${p.journeyContext}

玩家剛剛的回答：${p.latestAnswer ? `「${String(p.latestAnswer).slice(0, 300)}」` : '（玩家選擇靜靜走過，未回答）'}

這是一張作為**原型參考**的卡：
- 標題:${p.card?.title}｜關鍵字:${(p.card?.keys || []).join('、')}
- 原文（僅供你理解思想，禁止引述或翻譯給玩家）:「${p.card?.en}」
- 原解讀（僅供參考語意方向）:「${String(p.card?.read || '').slice(0, 300)}」

請生成「沿路拾得」的訊息：
- pickup：一句拾得敘事（≤40字），貼合世界意象，並映照玩家剛剛的回答（或安靜）。
- reading：150–250字，以卡片思想為原型、用你自己的話延伸改寫，直接寫給這位玩家——務必點出你在他的提問與回答中讀到的具體脈絡、慣性或盲點（至少呼應他一句原話的意涵），結尾給一個輕輕的邀請。不引述原文、不提巴夏或卡片、不署名出處。
- paramDelta：keywords（最多 2）、tone（${EMOTION_TONES.join('/')} 擇一）、energy（${ENERGIES.join('/')} 擇一）。`;
    case 'finale':
      return `旅程抵達終點。請綜合聽下來的一切，給玩家一個直指核心的回應。

原始提問：「${p.question}」
世界：${p.world?.title}——${p.world?.setting}
沿途對話（依序）：
${(p.responses || []).map((r, i) => `第${i + 1}問：${r.question}\n玩家答：${r.answer || '（靜靜走過）'}`).join('\n')}
拾得的訊息：${(p.collectedCards || []).join('、')}
主導關鍵字：${(p.topKeywords || []).join('、')}
情緒軌跡：${p.toneArc}｜能量平衡：${p.energyBalance}

請生成：
- title：這份回應的標題（≤16字）。
- coreAnswer：250–400字的核心回應——先點出玩家真正在問的是什麼；再說出你在他的回答中看見的模式或盲點（用「你說……」引用他的原話）；最後給出方向——賦能式、把力量還給玩家（不做醫療/法律/財務指令、不替他做決定，但要具體、切中，不要泛泛安慰）。
- recap：約100字的旅程回顧，帶世界意象。
- keyCards：從「拾得的訊息」中挑 2–3 個最關鍵的（務必是清單中確實有的標題）。
- suggestedPractice：一個可帶走、貼合此人狀態的具體小練習。
- closingBlessing：一句臨別祝福。`;
    default:
      return '';
  }
}

// 呼叫 OpenAI Chat Completions，用 json_schema strict mode 取回 JSON。
// max_completion_tokens 放寬（推理型模型會把思考也算進去）。
async function callOpenAI(apiKey, model, maxTokens, userPrompt, schema, schemaName) {
  const res = await fetch(OPENAI_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: 'Bearer ' + apiKey,
    },
    body: JSON.stringify({
      model,
      max_completion_tokens: maxTokens * 4,
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
  return JSON.parse(msg.content); // strict json_schema 保證是合法 JSON
}

// 呼叫 Anthropic，用 structured outputs 取回 JSON（這些模型不支援 assistant 預填）
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
  return JSON.parse(textBlock.text); // structured outputs 保證是合法 JSON
}

// 極簡防濫用：per-IP 每小時上限（best-effort，serverless 實例重啟即歸零；正式版改用 KV）
const RATE = new Map();
const RATE_LIMIT = 60; // 每 IP 每小時最多 60 次呼叫（約 7 局）
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
    res.status(200).json({ ok: false, fallback: true }); // 未設任何金鑰 → 前端走離線模板
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
