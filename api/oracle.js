// oracle.js — 「專屬靈感牌卡」的 serverless 端點。
//
// 三個 action，刻意拆開而不是一次做完：
//   text     解讀全文 → 文字模型 → 從原文逐字挑一句、下一個英文標題、圖像 prompt
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
// 卡面那一句**不是模型寫的**，是從使用者貼過來的解讀裡逐字挑出來的。
// 「逐字」由 quotesReading() 在送去生圖之前驗過——提示可以被繞過，比對不行。
// 比不到時會帶著「你剛剛改了這句」重試一次，再不行才算這次失敗。

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

// 每位訪客每日張數。**0 或負數＝不限制。**
// 測試期間暫時設為 0（站主要能連續產很多張來調 prompt，兩張不夠）。測試結束後
// 改回 2 即可，或在 Vercel 設 ORACLE_DAILY_LIMIT。
// 提醒：不限制時仍然會累加計數，所以恢復限制後那個數字是真的；但只要 limit <= 0，
// 前端就完全不顯示用量、也不會鎖任何按鈕（見 js/app.js 的 paintOracleQuota）。
const DAILY_LIMIT = Number(process.env.ORACLE_DAILY_LIMIT || 0);

// 功能總開關（後台「靈感牌卡」分頁最上方那一顆）。關閉時端點拒絕所有請求、
// 牌卡頁顯示「即將開放」，但不刪任何東西——已產生的紀錄、存檔預覽、每日計數都留著。
//
// **唯一的來源是 Redis 的 pi:oracleon**（後台那顆開關寫的）。站主隨時可以切，
// 即時生效、不必改程式、不必重新部署。曾經有一個 ORACLE_ENABLED 環境變數當
// kill switch，站主決定拿掉——兩個地方都能決定同一件事，遲早會忘記是哪一個在生效。
//
// 讀不到就一律當**關閉**：沒設定過、Redis 沒設定、Redis 掛了、逾時，全部都算關。
// 方向是刻意的——誤關只是少產一張卡，誤開會花錢（這是全站唯一每次呼叫都有明確
// 單張成本的功能）。
async function isEnabled() {
  if (!redisConfigured()) return false;
  try {
    const [r] = await redisPipeline([['GET', 'pi:oracleon']]);
    if (!r || r.result == null) return false;
    return !/^(0|false|off|no)$/i.test(String(r.result).trim());
  } catch {
    return false;
  }
}
const READING_MAX = 12000;   // 貼上的解讀長度上限（一則完整占星報告約 3000–4000 字）
const ARCHIVE_MAX = 600_000; // 存檔預覽的 base64 長度上限（約 450 KB 的 JPEG）

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['sentence', 'keyword', 'animal', 'why', 'imagePrompt'],
  properties: {
    // 卡面那一句：逐字取自使用者貼上的解讀，所以是使用者的語言。
    // 「逐字」由 quotesReading() 在下面驗，不是靠模型自律。
    sentence: { type: 'string' },
    // 那句話的標題，一個英文單字
    keyword: { type: 'string' },
    // 守護動物：從第三步那 30 種裡挑的，英文名。
    // 這一欄是「模型說它挑了什麼」，imagePrompt 才是真正到得了圖像模型的東西——
    // 兩者可能不一致，所以下面 animalCheck() 會對一次，結果存進紀錄給站主看。
    animal: { type: 'string' },
    // 為什麼挑這一句、以及為什麼挑這隻動物。只給站主看，不回傳給前端。
    why: { type: 'string' },
    imagePrompt: { type: 'string' },
  },
};

// 守護動物的 30 種（與 prompts/oracle.js 第三步的表格一致）。
// 放在這裡是為了「檢查」，不是為了「產生」——提示那一份才是給模型看的。
// 兩邊要一起改，animal_list.mjs 會驗這件事。
const ANIMALS = ['wolf', 'deer', 'fox', 'bear', 'elephant', 'horse', 'rabbit', 'otter',
  'frog', 'butterfly', 'dragonfly', 'owl', 'swan', 'peacock', 'sheep', 'egret', 'crane',
  'eagle', 'dog', 'cat', 'camel', 'reindeer', 'cow', 'goose', 'parrot', 'pig', 'raccoon',
  'ferret', 'tortoise', 'chameleon'];

// 守護動物挑得對不對，回一個給站主看的標記。**刻意不讓它失敗整次請求**：
// 逐字引用是這個功能的承諾，挑錯動物只是畫面差一點——為了一隻動物把使用者
// 那一次額度燒掉不划算。但要看得見，不然沒人會發現模型在這一步偷懶。
//   inList   模型回的 animal 在那 30 種裡
//   inPrompt 那個字真的出現在送去生圖的英文 prompt 裡（沒有的話畫面會是別的動物）
function animalCheck(animal, imagePrompt) {
  const a = String(animal || '').trim().toLowerCase();
  const inList = ANIMALS.includes(a);
  const inPrompt = a.length > 0 && new RegExp(`\\b${a}s?\\b`, 'i').test(String(imagePrompt || ''));
  return { animal: a, inList, inPrompt, ok: inList && inPrompt };
}

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

// 一張牌卡的總估算成本。text 走文字供應商的價目，image 走圖像的。
// translate 這一段留著是為了舊紀錄：2026-08 之前的牌卡有牌義翻譯那一次呼叫，
// 後台仍然要算得出那些紀錄的成本。新紀錄的 usage.translate 一律是 undefined。
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

// 卡面那一句必須是使用者貼過來的原文，一字不動。這一關是整個做法的地基：
// 提示裡講了三次「一字不動」，但提示是可以被繞過的，比對不行。
//
// 比對前先做正規化，因為有兩種差異是「格式」而不是「改字」，擋掉只會白白提高失敗率：
//   ・空白與換行：模型會把跨行的句子接成一行
//   ・markdown 記號：解讀常有 **粗體**、「-」條列，模型引用時通常會把它們去掉
// 除此之外一律要求逐字相同——字換了、順序變了、補了主詞，都會比不到。
//
// 刻意**不**做的正規化：全形半形互換、標點統一、大小寫。那些都已經算改字了，
// 放行等於這個功能的承諾破掉。
function normalizeForQuote(t) {
  return String(t || '')
    .replace(/[*_`~#>]/g, '')      // markdown 記號
    .replace(/\s+/g, '')           // 所有空白（含換行）
    .trim();
}

// 回傳 true 代表 sentence 確實出現在 reading 裡。
function quotesReading(sentence, reading) {
  const a = normalizeForQuote(sentence);
  const b = normalizeForQuote(reading);
  if (a.length < 8) return false;          // 太短的「引用」沒有意義，多半是模型在敷衍
  if (b.includes(a)) return true;
  // 唯一放寬的一項：模型把原文句尾的標點**省略**了。
  // 只在它回的句子本身沒有句尾標點時才放寬——如果它回的是「……開始！」而原文是
  // 「……開始。」，那是**換掉**了一個字元，不是省略，要擋。（第一版寫成「把句尾標點
  // 一律去掉再比」，結果驚嘆號換句號也會過關，等於默許改標點。）
  if (/[。．.！!？?、，,；;：:]$/.test(a)) return false;
  return b.includes(a + '。') || b.includes(a + '.') || b.includes(a + '！')
    || b.includes(a + '!') || b.includes(a + '？') || b.includes(a + '?');
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

  const callText = (up) => (openaiKey
    ? callOpenAIText(openaiKey, systemPrompt, up)
    : callAnthropicText(anthropicKey, systemPrompt, up));

  const t0 = Date.now();
  let { data: out, usage: textUsage } = await callText(userPrompt);
  let retried = false;

  // 一字不動的保證。模型在「引用」任務上最常見的失誤不是亂編，而是順手潤稿——
  // 補一個主詞、把逗號改成句號、把兩個短句接起來。所以比不到時先重試一次，
  // 並在提示裡指出它剛剛改掉的那一句。
  //
  // 重試划算：文字是便宜的一半，圖還沒生（圖是最貴的），而且沒通過的話這次本來
  // 就會失敗。多花一次文字的錢換掉一次整體失敗，值得。只重試一次——兩次都做不到，
  // 多半是這則解讀裡真的沒有適合單獨拿出來的句子。
  if (!quotesReading(clean(out.sentence, 400), reading)) {
    retried = true;
    const nudge = `${userPrompt}

⚠ 上一次你回的 sentence 是：
"""
${clean(out.sentence, 400)}
"""
這一句在上面的解讀原文裡找不到——你改了字。請**重新挑一句**，
用**複製貼上**的方式一字不動地照抄：不補主詞、不改標點、不把兩句併起來。`;
    const again = await callText(nudge);
    // 兩次的 token 都要算進成本，不然後台看到的數字會偏低。
    // 欄位名是 in／cachedIn／out（見 openaiUsage／anthropicUsage），不是
    // 供應商原始的那一套——寫錯的話重試過的牌卡會靜靜地算成 0 元。
    // 兩次都拿不到用量就維持 null：null 是「沒有回報」，0 會被誤讀成免費。
    const a = textUsage, c = again.usage;
    textUsage = (a || c)
      ? {
        in: (a ? a.in : 0) + (c ? c.in : 0),
        cachedIn: (a ? a.cachedIn : 0) + (c ? c.cachedIn : 0),
        out: (a ? a.out : 0) + (c ? c.out : 0),
      }
      : null;
    out = again.data;
  }

  // 卡面兩樣文字缺一樣就算這次失敗，而且是**在生圖之前**擋掉。
  // 為什麼要有這一關：模型照 schema 一定會給這兩個欄位，但欄位可以是空字串，
  // 而空字串排進版面就是一張只有畫、只有一條金線與站名的卡——看起來不像壞了，
  // 只像做得很爛。實際production上出現過一次（站主回報「產出的版本沒有文字」）。
  // 擋在這裡而不是在前端：前端擋的話錢已經花掉了（圖是最貴的一段）。
  const keyword = clean(out.keyword, 40);
  const sentence = clean(out.sentence, 400);
  if (!keyword || !sentence) {
    console.error('[oracle] empty card face', JSON.stringify({ keyword, sentence }));
    res.status(200).json({ ok: false, reason: 'failed' });
    return;
  }

  // 重試過還是比不到就這次失敗——不要退而求其次直接用模型給的句子：
  // 這個功能的承諾是「卡面上的話是你自己剛剛讀到的那一句」，一句模型潤過的話
  // 違背那個承諾，而且從外觀完全看不出來（讀者不會拿去跟原文比對）。
  if (!quotesReading(sentence, reading)) {
    console.error('[oracle] sentence not verbatim after retry', JSON.stringify({ sentence }));
    res.status(200).json({ ok: false, reason: 'not_verbatim' });
    return;
  }

  const animalOk = animalCheck(out.animal, out.imagePrompt);
  if (!animalOk.ok) {
    // 只記錄不擋。站主在後台看得到不合格的比例；比例高就代表第三步的規則要再收緊。
    console.warn('[oracle] guardian animal', JSON.stringify(animalOk));
  }

  const textMs = Date.now() - t0;
  const provider = openaiKey ? 'openai' : 'anthropic';
  const usage = { text: textUsage, image: null };

  const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const record = {
    id,
    ts: Date.now(),
    sid,
    vid,
    lang,
    // 為什麼挑這一句。只給站主看，不回傳給前端。
    why: clean(out.why, 200),
    imagePrompt: clean(out.imagePrompt, 4000),
    // 卡面文字。keyword 規定是單字，但不在這裡截成第一個字——真的回了詞組時
    // 截斷會變成沒有意義的字，版面本來也吃得下（見 js/oracleCard.js 的 titleSize）。
    // 違規看得到就好：站主在後台審核時會看到原樣。
    keyword,
    // sentence 已經通過 quotesReading() 的原文比對，所以這一欄一定是使用者
    // 自己貼過來的話。後台會把它與 readingHead 一起顯示，方便站主抽查。
    sentence,
    // 第一次有沒有改字（改了才會有第二次呼叫）。後台顯示這一欄，站主就看得出
    // 模型在「照抄」這件事上的實際表現，不必靠猜。
    retried,
    // 守護動物：模型說它挑了哪一隻，以及那一隻有沒有真的寫進圖像 prompt。
    // 不合格不會讓這次失敗（見 animalCheck 的說明），但後台看得到。
    animal: animalOk.animal,
    animalInList: animalOk.inList,
    animalInPrompt: animalOk.inPrompt,
    // 貼過來的解讀只留開頭一段給清單顯示；完整的那一份在 pi:oracleuser:<id>
    //（就是實際送出去的 user prompt），站主要 debug 時整段都調得出來。
    readingHead: reading.slice(0, 300),
    readingChars: reading.length,
    // 除錯用：實際送給文字模型的 system prompt 存在 pi:oraclesys:<sysHash>。
    // 每次呼叫的 system prompt 都一樣，所以按內容雜湊只存一份，紀錄裡只留 hash。
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
      const on = await isEnabled();
      const used = on ? await dailyUsed(clean(body.vid, 32)) : 0;
      res.status(200).json({ ok: true, enabled: on, used, limit: DAILY_LIMIT });
      return;
    }
    if (!await isEnabled()) { res.status(200).json({ ok: false, reason: 'disabled' }); return; }
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
