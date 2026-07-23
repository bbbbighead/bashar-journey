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

// 把實際送給 LLM 的 prompt 記錄到該次來訪（含各階段資料段，供後台復盤；失敗靜默）
async function recordPrompt(sid, provider, model, prompt, segments) {
  try {
    if (!sid || !redisConfigured()) return;
    const record = JSON.stringify({
      ts: Date.now(), provider, model, sysHash: SYS_HASH,
      prompt: prompt.slice(0, 20000),
      segments: segments || null,
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

// ---- 各階段資料段：排版成可讀文字（送給模型與記錄的就是這串文字，非 JSON 結構） ----

function fmtLenormand(L) {
  if (!L || !Array.isArray(L.grid)) return '（無牌陣資料）';
  const lines = L.grid.map((g) =>
    `・${g.position}｜${g.card}（${(g.keys || []).join('、')}）——${g.meaning}`);
  return [
    '九宮格（依位置，由左至右、由上至下）：',
    ...lines,
    `中心牌（全局核心）：${L.center || '—'}`,
    `收斂主題：${(L.themes || []).join('、') || '（無明顯收斂）'}`,
  ].join('\n');
}

function fmtMeihua(M) {
  if (!M) return '（無卦象資料）';
  return [
    `當前狀態：${M.present || '—'}`,
    `過程：${M.process || '—'}`,
    `發展方向：${M.direction || '—'}`,
    `動能：${M.dynamics || '—'}`,
    `動爻：第 ${M.movingLine || '—'} 爻`,
  ].join('\n');
}

function fmtAstro(A) {
  if (!A) return null;
  const out = [];
  const meta = A.meta || {};
  const input = meta.input || {};
  out.push(`計算系統：${meta.systems || '—'}`);
  out.push(`出生資料：${input.date || '—'} ${input.timeUnknown ? '（時間不確定，以當地正午計）' : (input.time || '')}｜${input.city || ''}${input.country ? `（${input.country}）` : ''}`);
  if (meta.place) out.push(`地點解析：${meta.place.resolved}（${meta.place.lat}, ${meta.place.lon}）｜時區 ${(meta.timezone || {}).iana}｜UTC ${meta.utc}`);
  for (const w of meta.warnings || []) out.push(`注意：${w}`);

  out.push('', '【點位】');
  for (const p of A.points || []) {
    out.push(`・${p.name}：${p.position}${p.house ? `，第 ${p.house} 宮` : ''}${p.retrograde ? '（逆行）' : ''}`);
  }

  if (Array.isArray(A.houses) && A.houses.length) {
    out.push('', '【十二宮】');
    for (const h of A.houses) {
      out.push(`・第 ${h.house} 宮：宮頭 ${h.cuspPosition}，宮主星 ${h.rulerTraditional}${h.rulerModernCo ? `（現代共管 ${h.rulerModernCo}）` : ''}${h.rulerSign ? `——落 ${h.rulerSign}${h.rulerHouse ? ` 第 ${h.rulerHouse} 宮` : ''}` : ''}${(h.occupants || []).length ? `；宮內：${h.occupants.join('、')}` : ''}`);
    }
    if ((A.intercepted || []).length) out.push(`攔截星座：${A.intercepted.join('、')}`);
    if ((A.duplicatedCuspSigns || []).length) out.push(`重複宮頭星座：${A.duplicatedCuspSigns.join('、')}`);
  }

  if (Array.isArray(A.aspects) && A.aspects.length) {
    out.push('', '【相位（依容許度由緊至鬆）】');
    for (const a of A.aspects) {
      out.push(`・${a.a} ${a.type} ${a.b}｜實際 ${a.actual}°｜容許度 ${a.orb}｜${a.state}${a.major ? '' : '（次要）'}`);
    }
  }

  const s = A.structure || {};
  out.push('', '【整體結構】');
  if (s.distributions) {
    const d = s.distributions;
    out.push(`元素分布：${Object.entries(d.elements || {}).map(([k, v]) => `${k}${v}`).join('、')}｜模式分布：${Object.entries(d.modes || {}).map(([k, v]) => `${k}${v}`).join('、')}｜陰陽：${Object.entries(d.polarity || {}).map(([k, v]) => `${k}${v}`).join('、')}`);
  }
  if (s.hemispheres) out.push(`半球與象限：${Object.entries(s.hemispheres).map(([k, v]) => `${k}${v}`).join('、')}`);
  if (s.dignities && Object.keys(s.dignities).length) out.push(`尊貴：${Object.entries(s.dignities).map(([k, v]) => `${k}${v}`).join('、')}`);
  if (s.chartRuler) out.push(`命主星：${s.chartRuler.name}${s.chartRuler.modernCo ? `（現代共管 ${s.chartRuler.modernCo}）` : ''}${s.chartRuler.sign ? `，落 ${s.chartRuler.sign}${s.chartRuler.house ? ` 第 ${s.chartRuler.house} 宮` : ''}` : ''}`);
  if ((s.retrogradePlanets || []).length) out.push(`逆行行星：${s.retrogradePlanets.join('、')}`);

  const dsp = A.dispositors || {};
  if (dsp.chain) {
    out.push('', '【飛星（傳統定位星）】');
    out.push(`定位鏈：${Object.entries(dsp.chain).map(([k, v]) => `${k}→${v}`).join('；')}`);
    if ((dsp.finalDispositors || []).length) out.push(`最終定位星：${dsp.finalDispositors.join('、')}`);
    for (const loop of dsp.loops || []) out.push(`定位星循環：${loop.join('→')}→（回到起點）`);
    for (const m of dsp.mutualReceptions || []) out.push(`互容：${m.join(' ↔ ')}`);
  }

  if ((A.patterns || []).length) {
    out.push('', '【特殊格局】');
    for (const pt of A.patterns) {
      if (pt.type === '群星') {
        out.push(`・群星：${pt.sign}（${(pt.bodies || []).join('、')}）｜同宮：${pt.sameHouse == null ? '不明' : pt.sameHouse ? '是' : '否'}｜最大距離 ${pt.maxSpreadDeg}°｜內行星參與：${pt.personalInvolved ? '是' : '否'}`);
      } else {
        out.push(`・${pt.type}：${(pt.bodies || []).join('、')}${pt.apex ? `（頂點 ${pt.apex}）` : ''}`);
      }
    }
  }
  if ((A.unaspected || []).length) {
    out.push(`無主相位行星：${A.unaspected.map((u) => `${u.body}${u.minorOnly ? '（僅有次要相位）' : '（近乎孤立）'}`).join('、')}`);
  }
  return out.join('\n');
}

// 各階段丟給模型前的資料段（可讀文字；分別記錄供後台復盤）
function buildSegments(p) {
  const astroText = fmtAstro(p.astro);
  return {
    opening: String(p.opening || '').slice(0, 600),
    lenormand: fmtLenormand(p.lenormand).slice(0, 4000),
    meihua: fmtMeihua(p.meihua).slice(0, 1500),
    astro: astroText ? astroText.slice(0, 11000) : null,
  };
}

function buildPrompt(action, p, seg) {
  switch (action) {
    case 'analyze':
      return `使用者想獲得靈感的主題：「${seg.opening}」

【系統一：雷諾曼九宮格讀數（使用者親手選牌；牌名與術語不得出現在輸出）】
${seg.lenormand}

【系統二：梅花易數讀數（使用者報數起卦；卦名與術語不得出現在輸出）】
${seg.meihua}

【系統三：西洋占星本命盤（Swiss Ephemeris 實算；僅可依此詮釋，不得補造）】
${seg.astro || '（使用者選擇跳過占星——以兩源整合，不假裝有第三源）'}

請依系統提示：不逐張解牌、不逐一列出各工具的分析——優先整理重複出現的模式、共同指向的主題、與生命正在醞釀的方向，再從整理框架中挑選對這個提問最有價值的三至五個面向，寫成一篇有結構、有脈絡的生命敘事。生成：
- title：一句自然、日常、一看就懂的話（≤16字），像人會說出口的標題；不要詩意標題、不要創造新詞組。
- message：450–800字、4–6 個完整段落的整合敘事，依核心脈絡推進（核心 → 為什麼 → 階段 → 現實表現與阻礙資源 → 共同指向的轉折與方向 → 一致與待觀察之處）。追求洞察感而非文學感：每一句都要有清楚的意思，刪掉只營造氣氛的句子。結尾啟發停留在視角、心境或策略層次，**嚴禁開立具體生活行動處方**。不逐牌、逐卦、逐星解釋。
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

  const segments = buildSegments(body);
  const prompt = buildPrompt(action, body, segments);
  const maxTokens = MAX_TOKENS[action];
  const schema = SCHEMAS[action];

  // 記錄實際送出的 prompt 與各階段資料段（呼叫前寫入——模型失敗也留有紀錄可復盤）
  const sid = String((body && body.sid) || '').slice(0, 16).replace(/[^\w-]/g, '');
  await recordPrompt(
    sid,
    openaiKey ? 'openai' : 'anthropic',
    openaiKey ? openaiModels()[action] : MODEL[action],
    prompt,
    segments,
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
