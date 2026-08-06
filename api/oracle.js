// oracle.js — 「專屬靈感牌卡」的 serverless 端點。
//
// 三個 action，刻意拆開而不是一次做完：
//   text     解讀全文 → 文字模型 → 挑一張牌（data/oracleDeck.js）、卡面文字、圖像 prompt
//   image    依 id 取出圖像 prompt → 圖像模型 → 回傳 PNG（base64）
//   archive  前端把「合成好的卡」與「原始 artwork」各壓成小張 JPEG 傳回來存檔
//   info     只讀今天已用張數與上限（不累加），並回報功能有沒有開著
//
// 除錯資料（都只有後台看得到）：
//   pi:oraclesys:<hash>  實際送給文字模型的 system prompt（同一份只存一次）
//   pi:oracleuser:<id>   實際送出去的 user prompt（貼過來的解讀全文）
//   pi:oracleart:<id>    圖像模型畫出來的原始 artwork（壓縮預覽）
//   pi:oracleimg:<id>    合成後的整張卡（壓縮預覽）
// 有這四樣，任何一張卡都能回頭問「這段字為什麼變成這張圖」。
//
// 牌卡下方那兩段牌義（核心訊息／洞見）**不是模型寫的**，是從 data/oracleDeck.js
// 照抄的。模型只負責挑哪一張、萃取卡面的一個英文關鍵字與一句短句、以及寫圖像
// prompt。為什麼這樣改：見 prompts/oracle.js 的檔頭。
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
import { buildOraclePrompt, buildTranslatePrompt, IMAGE_SUFFIX } from '../prompts/oracle.js';
import { deckCard, DECK_SIZE } from '../data/oracleDeck.js';

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

// 每位訪客每日張數。**0 或負數＝不限制。**
// 測試期間暫時設為 0（站主要能連續產很多張來調 prompt，兩張不夠）。測試結束後
// 改回 2 即可，或在 Vercel 設 ORACLE_DAILY_LIMIT。
// 提醒：不限制時仍然會累加計數，所以恢復限制後那個數字是真的；但只要 limit <= 0，
// 前端就完全不顯示用量、也不會鎖任何按鈕（見 js/app.js 的 paintOracleQuota）。
const DAILY_LIMIT = Number(process.env.ORACLE_DAILY_LIMIT || 0);

// 功能總開關。端點拒絕所有請求，牌卡頁改成顯示「即將開放」。
// 關閉不刪任何東西——已產生的紀錄、存檔預覽、每日計數都留著。
//
// **預設是關閉的**（站主要求，2026-08）。要開的話兩種方式，任一即可：
//   ・在 Vercel 設 ORACLE_ENABLED=1（改完要 Redeploy 才生效），不必改程式
//   ・或把下面那個預設值改回 '1' 再部署
// 為什麼預設關而不是預設開：這是全站唯一每次呼叫都有明確單張成本的功能（圖像生成），
// 而且畫風還在調。預設關的話，任何一次意外部署都不會把它打開。
const ENABLED = !/^(0|false|off|no)$/i.test(String(process.env.ORACLE_ENABLED ?? '0').trim());
const READING_MAX = 12000;   // 貼上的解讀長度上限（一則完整占星報告約 3000–4000 字）
const ARCHIVE_MAX = 600_000; // 存檔預覽的 base64 長度上限（約 450 KB 的 JPEG）

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['cardId', 'why', 'keyword', 'sentence', 'keywordLocal', 'sentenceLocal', 'imagePrompt'],
  properties: {
    // 挑中的牌（data/oracleDeck.js 的 id，1–100）
    cardId: { type: 'integer' },
    // 為什麼挑這張。只給站主看，不回傳給前端。
    why: { type: 'string' },
    // 卡面文字，一律英文
    keyword: { type: 'string' },
    sentence: { type: 'string' },
    // 同兩樣東西的使用者語言版本（輸出語言是英文時＝原文）
    keywordLocal: { type: 'string' },
    sentenceLocal: { type: 'string' },
    imagePrompt: { type: 'string' },
  },
};

// 牌義翻譯（只在使用者語言不是繁中時用）。忠實翻譯，不改結構。
const TRANS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['essence', 'insights'],
  properties: {
    essence: { type: 'string' },
    insights: { type: 'string' },
  },
};

const LANGS = new Set(['zh-Hant', 'en', 'ja', 'ko']);

// 每百萬 token 的美金單價，用來估算單張牌卡的成本。
//
// ⚠ 這是**估算**，不是帳單。三件事會讓它與實際請款不同：
//   ・價目會變，而且這份寫死在程式裡的表不會自己更新
//   ・免費額度、批次折扣、稅金都不在這裡
//   ・供應商回報的 token 數與計費 token 數偶爾會有差
// 所以全部可以用環境變數覆寫，後台顯示的金額一律標「估算」。
// 預設值是 gpt-5.1 與 gpt-image-1 的檯面價；用 Anthropic 走文字時改 ORACLE_PRICE_A_*。
const price = (name, fallback) => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v >= 0 ? v : fallback;
};
const PRICE = {
  openai: {
    in: price('ORACLE_PRICE_IN', 1.25),
    cachedIn: price('ORACLE_PRICE_CACHED_IN', 0.125),
    out: price('ORACLE_PRICE_OUT', 10),
  },
  anthropic: {
    in: price('ORACLE_PRICE_A_IN', 15),
    cachedIn: price('ORACLE_PRICE_A_CACHED_IN', 1.5),
    out: price('ORACLE_PRICE_A_OUT', 75),
  },
  // gpt-image-1：輸入是文字 token，輸出是「圖像 token」，兩者單價不同。
  image: {
    in: price('ORACLE_PRICE_IMG_IN', 5),
    out: price('ORACLE_PRICE_IMG_OUT', 40),
  },
};

// usage（供應商實際回報的 token 數）→ 美金。拿不到 usage 就回 0，
// 但呼叫端會另外記 usage 是不是 null，後台才能分辨「免費」與「沒回報」。
function costOf(usage, rate) {
  if (!usage) return 0;
  return ((usage.in || 0) * rate.in
    + (usage.cachedIn || 0) * (rate.cachedIn != null ? rate.cachedIn : rate.in)
    + (usage.out || 0) * rate.out) / 1e6;
}

// 一張牌卡的總估算成本。text／translate 走文字供應商的價目，image 走圖像的。
// 圖是最貴的一段（1024×1536 medium 大約是文字那一段的十倍以上），所以分開列。
function totalCost(usage, provider) {
  const textRate = provider === 'anthropic' ? PRICE.anthropic : PRICE.openai;
  const u = usage || {};
  return costOf(u.text, textRate) + costOf(u.translate, textRate) + costOf(u.image, PRICE.image);
}

const clean = (s, n) => String(s == null ? '' : s).trim().slice(0, n);

// 與 api/insight.js 同一支雜湊。system prompt 每次呼叫都一樣（約 2.8 萬字，整副牌
// 都在裡面），所以按內容雜湊只存一份，紀錄裡只留 hash——否則 50 筆就是 1.4 MB。
function djb2(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  return h.toString(16);
}

// 每位訪客每日上限。算在 text 這一段（比較便宜的那一段），所以連文字都拿不到
// 的人也不會有機會觸發圖像生成。Redis 沒設定時不限制——本機開發要能跑。
// 回傳 used 是為了讓畫面能顯示「今天第幾張／共幾張」，並在用完時把「再生成」關掉。
// 只讀，不累加。開啟牌卡頁時用它把「今天已使用 n ／ 上限」顯示出來——
// 上限不寫死在前端，否則改了 ORACLE_DAILY_LIMIT 之後畫面上的數字會是舊的。
async function dailyUsed(vid) {
  if (!redisConfigured() || !vid) return 0;
  const day = new Date().toISOString().slice(0, 10);
  const out = await redisPipeline([['GET', `pi:oraclelim:${vid}:${day}`]]);
  const n = Number((out && out[0] && out[0].result) || 0);
  return Number.isFinite(n) ? n : 0;
}

async function dailyUse(vid) {
  if (!redisConfigured() || !vid) return { used: 0, over: false };
  const day = new Date().toISOString().slice(0, 10);
  const key = `pi:oraclelim:${vid}:${day}`;
  const out = await redisPipeline([['INCR', key], ['EXPIRE', key, 172800]]);
  const n = out && out[0] && Number(out[0].result);
  const used = Number.isFinite(n) ? n : 0;
  // limit <= 0＝不限制。仍然累加，只是永遠不判定超量。
  return { used, over: DAILY_LIMIT > 0 && used > DAILY_LIMIT };
}

async function callOpenAIText(apiKey, systemPrompt, userPrompt, schema = SCHEMA, name = 'oracle_card') {
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
        json_schema: { name, strict: true, schema },
      },
    }),
  });
  if (!res.ok) throw new Error('openai text HTTP ' + res.status);
  const json = await res.json();
  const msg = json.choices && json.choices[0] && json.choices[0].message;
  if (!msg || msg.refusal || !msg.content) throw new Error('refusal or empty');
  return { data: JSON.parse(msg.content), usage: openaiUsage(json.usage) };
}

// 用量一律取供應商實際回報的數字，不自己估——估出來的數字沒有對帳的價值。
// 拿不到就回 null，後台顯示「沒有回報用量」而不是顯示 0（0 會被誤讀成免費）。
function openaiUsage(u) {
  if (!u) return null;
  const cached = (u.prompt_tokens_details && u.prompt_tokens_details.cached_tokens) || 0;
  return {
    in: Number(u.prompt_tokens || 0) - Number(cached),
    cachedIn: Number(cached),
    out: Number(u.completion_tokens || 0),
  };
}

function anthropicUsage(u) {
  if (!u) return null;
  return {
    in: Number(u.input_tokens || 0) + Number(u.cache_creation_input_tokens || 0),
    cachedIn: Number(u.cache_read_input_tokens || 0),
    out: Number(u.output_tokens || 0),
  };
}

async function callAnthropicText(apiKey, systemPrompt, userPrompt, schema = SCHEMA) {
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
      output_config: { format: { type: 'json_schema', schema } },
      messages: [{ role: 'user', content: userPrompt }],
    }),
  });
  if (!res.ok) throw new Error('anthropic text HTTP ' + res.status);
  const json = await res.json();
  if (json.stop_reason === 'refusal') throw new Error('refusal');
  const block = (json.content || []).find((b) => b.type === 'text');
  if (!block) throw new Error('no text block');
  return { data: JSON.parse(block.text), usage: anthropicUsage(json.usage) };
}

// 牌義的翻譯。只有在使用者語言不是繁體中文時才會走到這裡。
//
// 為什麼是另外一次呼叫：主提示裡刻意沒有牌組的 insights（模型看不到就改不到，
// 那一段的原文因此有結構上的保證）。這一支只餵它挑中的那一張，輸入很短。
// 失敗時回 null，呼叫端改用繁中原文——顯示原文總比什麼都沒有好，而且紀錄上會
// 留下 translated:false，站主看得到。
async function translateCard(keys, lang, card) {
  const systemPrompt = buildTranslatePrompt(lang);
  const userPrompt = `核心訊息：
${card.essence}

洞見：
${card.insights}`;
  try {
    const { data, usage } = keys.openai
      ? await callOpenAIText(keys.openai, systemPrompt, userPrompt, TRANS_SCHEMA, 'oracle_translation')
      : await callAnthropicText(keys.anthropic, systemPrompt, userPrompt, TRANS_SCHEMA);
    const essence = clean(data.essence, 600);
    const insights = clean(data.insights, 2000);
    if (!essence || !insights) return null;
    return { essence, insights, usage };
  } catch (e) {
    console.error('[oracle] translate', lang, e && e.message);
    return null;
  }
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
  const lang = LANGS.has(body.lang) ? body.lang : 'zh-Hant';
  const vid = clean(body.vid, 32);
  const sid = clean(body.sid, 64);

  const use = await dailyUse(vid);
  if (use.over) {
    res.status(200).json({ ok: false, reason: 'daily_limit', limit: DAILY_LIMIT });
    return;
  }

  const systemPrompt = buildOraclePrompt(lang);
  const userPrompt = `使用者貼上的解讀全文：
"""
${reading}
"""`;
  const sysHash = djb2(systemPrompt);

  const t0 = Date.now();
  const { data: out, usage: textUsage } = openaiKey
    ? await callOpenAIText(openaiKey, systemPrompt, userPrompt)
    : await callAnthropicText(anthropicKey, systemPrompt, userPrompt);

  // 挑中的牌。id 不在牌組裡就算這次失敗——不要退而求其次隨機給一張：
  // 這個功能的承諾是「這張牌對得上你貼的那則解讀」，隨機來的卡違背那個承諾。
  const deck = deckCard(out.cardId);
  if (!deck) {
    console.error('[oracle] bad cardId', out && out.cardId, 'of', DECK_SIZE);
    res.status(200).json({ ok: false, reason: 'failed' });
    return;
  }

  // 卡面兩樣文字缺一樣就算這次失敗，而且是**在生圖之前**擋掉。
  // 為什麼要有這一關：模型照 schema 一定會給這兩個欄位，但欄位可以是空字串，
  // 而空字串排進版面就是一張只有畫、只有一條金線與站名的卡——看起來不像壞了，
  // 只像做得很爛。實際production上出現過一次（站主回報「產出的版本沒有文字」）。
  // 擋在這裡而不是在前端：前端擋的話錢已經花掉了（圖是最貴的一段）。
  const keyword = clean(out.keyword, 40);
  const sentence = clean(out.sentence, 300);
  if (!keyword || !sentence) {
    console.error('[oracle] empty card face', JSON.stringify({ keyword, sentence, cardId: out.cardId }));
    res.status(200).json({ ok: false, reason: 'failed' });
    return;
  }

  // 牌義：繁中照抄原文，其他語言翻譯（失敗就用原文）。
  // 這兩段永遠不是模型自己寫的——見 prompts/oracle.js 的檔頭。
  let essence = deck.essence;
  let insights = deck.insights;
  let translated = false;
  let transUsage = null;
  if (lang !== 'zh-Hant') {
    const tr = await translateCard({ openai: openaiKey, anthropic: anthropicKey }, lang, deck);
    if (tr) {
      essence = tr.essence; insights = tr.insights; translated = true; transUsage = tr.usage;
    }
  }
  const textMs = Date.now() - t0;
  const provider = openaiKey ? 'openai' : 'anthropic';
  const usage = { text: textUsage, translate: transUsage, image: null };

  const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const record = {
    id,
    ts: Date.now(),
    sid,
    vid,
    lang,
    // 挑中的牌。cardTitle（卡名）目前不顯示給使用者——卡面上已經有一個英文關鍵字
    // 當標題，再放一個中文卡名只是兩個標題互相搶。留在紀錄裡是給站主看的：
    // 要判斷挑卡準不準，得知道挑到了哪一張。
    cardId: deck.id,
    cardTitle: deck.title,
    cardCategory: deck.category,
    why: clean(out.why, 200),
    imagePrompt: clean(out.imagePrompt, 4000),
    // 卡面文字（英文）。keyword 規定是單字，但不在這裡截成第一個字——
    // 真的回了詞組時截斷會變成沒有意義的字，版面本來也吃得下（見 titleSize）。
    // 違規看得到就好：站主在後台審核時會看到原樣。
    keyword,
    sentence,
    keywordLocal: clean(out.keywordLocal, 60),
    sentenceLocal: clean(out.sentenceLocal, 300),
    // 牌義（使用者看到的版本）
    essence,
    insights,
    translated,
    // 貼過來的解讀只留開頭一段給清單顯示；完整的那一份在 pi:oracleuser:<id>
    //（就是實際送出去的 user prompt），站主要 debug 時整段都調得出來。
    readingHead: reading.slice(0, 300),
    readingChars: reading.length,
    // 除錯用：實際送給文字模型的 system prompt 存在 pi:oraclesys:<sysHash>。
    // 每次呼叫的 system prompt 都一樣（整副牌都在裡面，約 2.8 萬字），所以按內容
    // 雜湊只存一份，紀錄裡只留 hash。
    sysHash,
    provider,
    model: openaiKey ? TEXT_MODEL_OPENAI : TEXT_MODEL_ANTHROPIC,
    // 供應商實際回報的 token 數，加上依 PRICE 表估算的美金成本。
    // image 這一段要等 action:'image' 回來才補上，所以這裡的 costUsd 只含文字。
    usage,
    costUsd: totalCost(usage, provider),
    textMs,
    imaged: false,
  };

  if (redisConfigured()) {
    // system prompt 用 NX：同一份只寫第一次。user prompt 逐筆存（那是唯一每次
    // 都不同、而且 debug 時真正想看的東西）。
    await redisPipeline([
      ['SET', `pi:oracle:${id}`, JSON.stringify(record)],
      ['SET', `pi:oraclesys:${sysHash}`, systemPrompt, 'NX'],
      ['SET', `pi:oracleuser:${id}`, userPrompt],
      ['LPUSH', 'pi:oracles', id],
      ['LTRIM', 'pi:oracles', 0, 999],
    ]);
  }

  // cardId／cardTitle／why／imagePrompt 不回傳給前端：那是站主檢查用的資料，
  // 使用者看到「這是系統對你的判斷」反而會影響他讀卡的方式。
  res.status(200).json({
    ok: true,
    id,
    // 給畫面顯示「今天第 used／limit 張」，並在用完時把「再生成」關掉
    used: use.used,
    limit: DAILY_LIMIT,
    keyword: record.keyword,
    sentence: record.sentence,
    keywordLocal: record.keywordLocal,
    sentenceLocal: record.sentenceLocal,
    essence: record.essence,
    insights: record.insights,
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

  // gpt-image-1 會回報 usage：輸入是文字 token、輸出是圖像 token（單價差 8 倍）。
  // 這一段通常佔單張成本的九成以上，所以務必記進去，否則後台的金額會嚴重低估。
  const iu = json.usage || null;
  const imageUsage = iu
    ? { in: Number(iu.input_tokens || 0), out: Number(iu.output_tokens || 0) }
    : null;
  const usage = { ...(record.usage || {}), image: imageUsage };

  await redisPipeline([['SET', `pi:oracle:${id}`, JSON.stringify({
    ...record,
    imaged: true,
    imageMs,
    imageModel: IMAGE_MODEL,
    imageSize: IMAGE_SIZE,
    imageQuality: IMAGE_QUALITY,
    usage,
    costUsd: totalCost(usage, record.provider),
  })]]);

  res.status(200).json({ ok: true, image: `data:image/png;base64,${b64}` });
}

// ---- action: archive ----
// 站主初期要能審核牌卡品質，所以把「合成好的整張卡」存起來。
// 存的是前端壓過的小張 JPEG（長邊 900px 左右），不是原圖：
//   ・原圖 PNG 約 1.5–3 MB，Redis 不該拿來裝這種東西
//   ・審核品質用不到原始解析度，壓過的預覽肉眼幾乎等同
//   ・存的是「合成後」的樣子（含邊框與文字），那才是使用者真正拿到的東西
// 日後不想存了：把前端這一支呼叫拿掉即可，紀錄的其他欄位不受影響。
// 兩張都存：
//   preview 合成後的整張卡（含邊框與文字）＝使用者真正拿到的東西
//   art     圖像模型畫的原始 artwork（未裁切的完整 2:3）＝要拿來對照 prompt 的那一張
// 卡面上的 artwork 被裁掉了邊緣、也只佔 70%，光看合成卡沒辦法判斷「這段 prompt
// 到底畫出了什麼」。兩張都是前端壓過的小 JPEG（各約 30 KB）。
async function doArchive(body, res) {
  const id = clean(body.id, 40);
  if (!id || !redisConfigured()) { res.status(204).end(); return; }
  const ok = (s) => s.startsWith('data:image/jpeg;base64,') && s.length <= ARCHIVE_MAX;
  const preview = String(body.preview || '');
  const art = String(body.art || '');
  const cmds = [];
  if (ok(preview)) {
    cmds.push(['SET', `pi:oracleimg:${id}`, preview]);
    cmds.push(['INCRBY', 'pi:agg:bytes', String(preview.length)]);
  }
  if (ok(art)) {
    cmds.push(['SET', `pi:oracleart:${id}`, art]);
    cmds.push(['INCRBY', 'pi:agg:bytes', String(art.length)]);
  }
  if (cmds.length) await redisPipeline(cmds);
  res.status(204).end();
}

export default async function handler(req, res) {
  if (req.method !== 'POST') { res.status(405).json({ ok: false }); return; }
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  body = body || {};

  try {
    // info 在關閉時仍然回 ok，只是帶 enabled:false——前端要靠它把畫面切成
    //「即將開放」。其他 action 一律直接拒絕。
    if (body.action === 'info') {
      const used = ENABLED ? await dailyUsed(clean(body.vid, 32)) : 0;
      res.status(200).json({ ok: true, enabled: ENABLED, used, limit: DAILY_LIMIT });
      return;
    }
    if (!ENABLED) { res.status(200).json({ ok: false, reason: 'disabled' }); return; }
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
