// oracle.js — 「專屬靈感牌卡」的 serverless 端點。
//
// 三個 action，刻意拆開而不是一次做完：
//   text     解讀全文 → 文字模型 → 靈魂精髓、卡面文字、頁面那段話、圖像 prompt
//   image    依 id 取出圖像 prompt → 圖像模型 → 回傳 PNG（base64）
//   archive  前端把合成好的卡片壓成小張 JPEG 傳回來存檔，供站主審核品質
//
// 為什麼 text 與 image 要分成兩次請求：兩次模型呼叫加起來很可能超過函式的執行
// 上限（文字 15–25s ＋ 圖像 20–40s）。拆開之後每次都在上限內，而且畫面可以先把
// 文字顯示出來、再等圖，等待感差很多。
//
// 為什麼 image 只收 id、不收 prompt：如果讓前端把 prompt 傳回來，任何人都能拿
// 這支端點當免費的圖像生成器（用我們的金鑰畫任何東西）。prompt 存在伺服器端，
// 前端只拿得到一個 id。
//
// 「一次只能生成一張」是在伺服器端擋的（紀錄上的 imaged 旗標），不是靠前端不顯示
// 按鈕——前端的按鈕藏起來，重送請求還是會再花一次圖像生成的錢。

import { redisPipeline, redisConfigured } from '../lib/redis.js';
import { buildOraclePrompt, IMAGE_SUFFIX } from '../prompts/oracle.js';

const OPENAI_CHAT = 'https://api.openai.com/v1/chat/completions';
const OPENAI_IMAGE = 'https://api.openai.com/v1/images/generations';
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';

const TEXT_MODEL_OPENAI = process.env.OPENAI_MODEL_STRONG || 'gpt-5.1';
const TEXT_MODEL_ANTHROPIC = 'claude-opus-4-8';
const IMAGE_MODEL = process.env.ORACLE_IMAGE_MODEL || 'gpt-image-1';

// 直式牌卡比例（2:3）。神諭卡的傳統比例，也是 gpt-image-1 支援的尺寸之一。
const IMAGE_SIZE = process.env.ORACLE_IMAGE_SIZE || '1024x1536';

// 預設 medium 而不是 high：high 在這個尺寸上常要 40–90 秒，會頂到函式的
// 60 秒上限（vercel.json）。要改 high 的話得先確認方案允許更長的 maxDuration，
// 否則使用者會看到逾時而不是更好的圖。
const IMAGE_QUALITY = process.env.ORACLE_IMAGE_QUALITY || 'medium';

const DAILY_LIMIT = Number(process.env.ORACLE_DAILY_LIMIT || 2);
const READING_MAX = 12000;   // 貼上的解讀長度上限（一則完整占星報告約 3000–4000 字）
const ARCHIVE_MAX = 600_000; // 存檔預覽的 base64 長度上限（約 450 KB 的 JPEG）

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['essence', 'imagePrompt', 'title', 'keywords', 'message',
    'titleLocal', 'keywordsLocal', 'messageLocal', 'longMessage'],
  properties: {
    essence: { type: 'string' },
    imagePrompt: { type: 'string' },
    // 卡面文字，一律英文
    title: { type: 'string' },
    keywords: { type: 'array', items: { type: 'string' } },
    message: { type: 'string' },
    // 同三樣東西的使用者語言版本（輸出語言是英文時＝原文）
    titleLocal: { type: 'string' },
    keywordsLocal: { type: 'array', items: { type: 'string' } },
    messageLocal: { type: 'string' },
    longMessage: { type: 'string' },
  },
};

const LANGS = new Set(['zh-Hant', 'en', 'ja', 'ko']);
const SEXES = new Set(['male', 'female']);

const clean = (s, n) => String(s == null ? '' : s).trim().slice(0, n);

// 每位訪客每日上限。算在 text 這一段（比較便宜的那一段），所以連文字都拿不到
// 的人也不會有機會觸發圖像生成。Redis 沒設定時不限制——本機開發要能跑。
async function overDailyLimit(vid) {
  if (!redisConfigured() || !vid) return false;
  const day = new Date().toISOString().slice(0, 10);
  const key = `pi:oraclelim:${vid}:${day}`;
  const out = await redisPipeline([['INCR', key], ['EXPIRE', key, 172800]]);
  const n = out && out[0] && Number(out[0].result);
  return Number.isFinite(n) && n > DAILY_LIMIT;
}

async function callOpenAIText(apiKey, systemPrompt, userPrompt) {
  const res = await fetch(OPENAI_CHAT, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + apiKey },
    body: JSON.stringify({
      model: TEXT_MODEL_OPENAI,
      max_completion_tokens: 8000,   // 推理型模型把思考也算進來，放寬
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      response_format: {
        type: 'json_schema',
        json_schema: { name: 'oracle_card', strict: true, schema: SCHEMA },
      },
    }),
  });
  if (!res.ok) throw new Error('openai text HTTP ' + res.status);
  const json = await res.json();
  const msg = json.choices && json.choices[0] && json.choices[0].message;
  if (!msg || msg.refusal || !msg.content) throw new Error('refusal or empty');
  return JSON.parse(msg.content);
}

async function callAnthropicText(apiKey, systemPrompt, userPrompt) {
  const res = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': ANTHROPIC_VERSION,
    },
    body: JSON.stringify({
      model: TEXT_MODEL_ANTHROPIC,
      max_tokens: 3000,
      system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
      output_config: { format: { type: 'json_schema', schema: SCHEMA } },
      messages: [{ role: 'user', content: userPrompt }],
    }),
  });
  if (!res.ok) throw new Error('anthropic text HTTP ' + res.status);
  const json = await res.json();
  if (json.stop_reason === 'refusal') throw new Error('refusal');
  const block = (json.content || []).find((b) => b.type === 'text');
  if (!block) throw new Error('no text block');
  return JSON.parse(block.text);
}

// ---- action: text ----
async function doText(body, res) {
  const openaiKey = process.env.OPENAI_API_KEY;
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (!openaiKey && !anthropicKey) {
    res.status(200).json({ ok: false, reason: 'no_text_key' });
    return;
  }

  const reading = clean(body.reading, READING_MAX);
  if (reading.length < 80) {
    res.status(200).json({ ok: false, reason: 'reading_too_short' });
    return;
  }
  const sex = SEXES.has(body.sex) ? body.sex : null;
  const lang = LANGS.has(body.lang) ? body.lang : 'zh-Hant';
  const vid = clean(body.vid, 32);
  const sid = clean(body.sid, 64);

  if (await overDailyLimit(vid)) {
    res.status(200).json({ ok: false, reason: 'daily_limit', limit: DAILY_LIMIT });
    return;
  }

  const systemPrompt = buildOraclePrompt(lang);
  const userPrompt = `使用者的生理性別：${sex === 'male' ? '生理男性' : sex === 'female' ? '生理女性' : '未提供'}

使用者貼上的解讀全文：
"""
${reading}
"""`;

  const t0 = Date.now();
  const card = openaiKey
    ? await callOpenAIText(openaiKey, systemPrompt, userPrompt)
    : await callAnthropicText(anthropicKey, systemPrompt, userPrompt);
  const textMs = Date.now() - t0;

  // keywords 規定恰好三個。schema 的 strict 模式不支援 minItems／maxItems，
  // 所以在這裡收斂——少於三個就照原樣給前端排版，不要為了湊數自己編字。
  const kw = (arr) => (Array.isArray(arr) ? arr : [])
    .map((x) => clean(x, 40)).filter(Boolean).slice(0, 3);
  const keywords = kw(card.keywords);
  // 翻譯版的關鍵詞要與英文版一一對應（那是轉化的三個階段，順序有意義）。
  // 數量對不上時寧可整個不顯示翻譯，也不要讓兩排字錯位對照。
  const keywordsLocal = kw(card.keywordsLocal);
  const localOk = keywordsLocal.length === keywords.length;

  const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const record = {
    id,
    ts: Date.now(),
    sid,
    vid,
    lang,
    sex,
    essence: clean(card.essence, 400),
    imagePrompt: clean(card.imagePrompt, 4000),
    title: clean(card.title, 60),
    keywords,
    message: clean(card.message, 400),
    titleLocal: clean(card.titleLocal, 80),
    keywordsLocal: localOk ? keywordsLocal : [],
    messageLocal: clean(card.messageLocal, 400),
    longMessage: clean(card.longMessage, 1200),
    // 貼過來的解讀只留開頭一段：站主要能認出這張卡是從哪一則解讀來的，
    // 但沒有必要把整則再存一次（原本那一則已經在 pi:journey 裡了）。
    readingHead: reading.slice(0, 300),
    readingChars: reading.length,
    textMs,
    imaged: false,
  };

  if (redisConfigured()) {
    await redisPipeline([
      ['SET', `pi:oracle:${id}`, JSON.stringify(record)],
      ['LPUSH', 'pi:oracles', id],
      ['LTRIM', 'pi:oracles', 0, 999],
    ]);
  }

  // essence 與 imagePrompt 不回傳給前端：那是站主檢查用的資料，
  // 使用者看到「這是系統對你的判斷」反而會影響他讀卡的方式。
  res.status(200).json({
    ok: true,
    id,
    title: record.title,
    keywords: record.keywords,
    message: record.message,
    titleLocal: record.titleLocal,
    keywordsLocal: record.keywordsLocal,
    messageLocal: record.messageLocal,
    longMessage: record.longMessage,
  });
}

// ---- action: image ----
async function doImage(body, res) {
  const openaiKey = process.env.OPENAI_API_KEY;
  if (!openaiKey) {
    // Anthropic 沒有圖像生成，所以這一段只能走 OpenAI。
    res.status(200).json({ ok: false, reason: 'no_image_key' });
    return;
  }
  const id = clean(body.id, 40);
  if (!id || !redisConfigured()) {
    res.status(200).json({ ok: false, reason: 'no_record' });
    return;
  }

  const got = await redisPipeline([['GET', `pi:oracle:${id}`]]);
  let record = null;
  try { record = JSON.parse((got && got[0] && got[0].result) || 'null'); } catch { record = null; }
  if (!record || !record.imagePrompt) {
    res.status(200).json({ ok: false, reason: 'no_record' });
    return;
  }
  // 一次只能生成一張——在這裡擋，不是靠前端把按鈕藏起來。
  if (record.imaged) {
    res.status(200).json({ ok: false, reason: 'already_generated' });
    return;
  }

  // 先寫回 imaged，再去生圖。順序刻意如此：如果反過來，生圖成功但寫入失敗
  // （或函式逾時被砍）就會留下一張可以無限重生成的紀錄，每次都要付錢。
  await redisPipeline([['SET', `pi:oracle:${id}`,
    JSON.stringify({ ...record, imaged: true })]]);

  const t0 = Date.now();
  const r = await fetch(OPENAI_IMAGE, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + openaiKey },
    body: JSON.stringify({
      model: IMAGE_MODEL,
      prompt: `${record.imagePrompt}\n\n${IMAGE_SUFFIX}`,
      size: IMAGE_SIZE,
      quality: IMAGE_QUALITY,
      n: 1,
    }),
  });
  if (!r.ok) {
    const detail = await r.text().catch(() => '');
    throw new Error(`openai image HTTP ${r.status} ${detail.slice(0, 300)}`);
  }
  const json = await r.json();
  const b64 = json.data && json.data[0] && json.data[0].b64_json;
  if (!b64) throw new Error('image empty');
  const imageMs = Date.now() - t0;

  await redisPipeline([['SET', `pi:oracle:${id}`,
    JSON.stringify({ ...record, imaged: true, imageMs })]]);

  res.status(200).json({ ok: true, image: `data:image/png;base64,${b64}` });
}

// ---- action: archive ----
// 站主初期要能審核牌卡品質，所以把「合成好的整張卡」存起來。
// 存的是前端壓過的小張 JPEG（長邊 900px 左右），不是原圖：
//   ・原圖 PNG 約 1.5–3 MB，Redis 不該拿來裝這種東西
//   ・審核品質用不到原始解析度，壓過的預覽肉眼幾乎等同
//   ・存的是「合成後」的樣子（含邊框與文字），那才是使用者真正拿到的東西
// 日後不想存了：把前端這一支呼叫拿掉即可，紀錄的其他欄位不受影響。
async function doArchive(body, res) {
  const id = clean(body.id, 40);
  const preview = String(body.preview || '');
  if (!id || !redisConfigured()) { res.status(204).end(); return; }
  if (!preview.startsWith('data:image/jpeg;base64,') || preview.length > ARCHIVE_MAX) {
    res.status(204).end();
    return;
  }
  await redisPipeline([
    ['SET', `pi:oracleimg:${id}`, preview],
    ['INCRBY', 'pi:agg:bytes', String(preview.length)],
  ]);
  res.status(204).end();
}

export default async function handler(req, res) {
  if (req.method !== 'POST') { res.status(405).json({ ok: false }); return; }
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  body = body || {};

  try {
    if (body.action === 'text') return await doText(body, res);
    if (body.action === 'image') return await doImage(body, res);
    if (body.action === 'archive') return await doArchive(body, res);
    res.status(400).json({ ok: false, reason: 'bad_action' });
  } catch (e) {
    // 失敗原因寫進伺服器日誌（Vercel Functions log），回給前端的只有一個代碼——
    // 這裡的錯誤訊息可能包含模型回傳的內容，不適合送到瀏覽器。
    console.error('[oracle]', body.action, e && e.message);
    res.status(200).json({ ok: false, reason: 'failed' });
  }
}
