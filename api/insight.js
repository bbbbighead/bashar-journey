// api/insight.js — Vercel serverless 代理。單一端點、單一 action。
// 注入 system prompt、用 structured outputs 取回 JSON、驗證後回傳。
// 前端永不指定模型、永不看到金鑰。
//
// 雙供應商：設 OPENAI_API_KEY 走 OpenAI；否則設 ANTHROPIC_API_KEY 走 Claude；
// 兩者皆設時優先 OpenAI；都沒設則回 fallback（前端離線後備）。
//
// action：analyze（描述＋雷諾曼＋梅花易數 → 五段式最後分析）
// 回傳：{ ok:true, data } 或 { ok:false, fallback:true }。

import { buildSystemPrompt } from '../prompts/system.js';
import { redisPipeline, redisConfigured } from '../lib/redis.js';

// system prompt 版本雜湊（djb2）——prompt 紀錄引用它，system prompt 本體依版本去重存一份。
// system prompt 現依所選工具動態組裝，故雜湊與內容都逐次計算。
function djb2(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  return h.toString(16);
}

// 把實際送給 LLM 的 prompt 記錄到該次來訪（含各階段資料段，供後台復盤；失敗靜默）
async function recordPrompt(sid, provider, model, systemPrompt, sysHash, prompt, segments) {
  try {
    if (!sid || !redisConfigured()) return;
    const record = JSON.stringify({
      ts: Date.now(), provider, model, sysHash,
      prompt: prompt.slice(0, 20000),
      segments: segments || null,
    });
    // 同一次來訪可能重跑分析（前端失敗會重試一次），SET 是覆寫、不是新增，
    // 所以用量要算「新舊差額」，否則每次重試都會把同一份 prompt 再累加一遍。
    const [oldR] = await redisPipeline([['STRLEN', `pi:prompt:${sid}`]]);
    const oldLen = Number(oldR.result || 0);
    const delta = (record.length + 64) - (oldLen ? oldLen + 64 : 0);
    const results = await redisPipeline([
      ['SET', `pi:prompt:${sid}`, record],
      ['SET', `pi:sysprompt:${sysHash}`, systemPrompt, 'NX'],
      ['INCRBY', 'pi:agg:bytes', String(delta)],
    ]);
    // system prompt 首次寫入才計入用量（NX 未寫入時回 null）
    if (results && results[1] && results[1].result === 'OK') {
      await redisPipeline([['INCRBY', 'pi:agg:bytes', String(systemPrompt.length + 64)]]);
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

const MAX_TOKENS = { analyze: 6000 }; // 單工具＝完整報告；多工具＝各節＋綜合，需要較大額度

const S = (extra) => ({ type: 'string', ...extra });
const ARR = (items) => ({ type: 'array', items });
const OBJ = (required, properties) => ({ type: 'object', additionalProperties: false, required, properties });

const SCHEMAS = {
  analyze: OBJ(['title', 'sections'], {
    title: S(),
    sections: ARR(OBJ(['tool', 'content'], {
      tool: S({ enum: ['lenormand', 'meihua', 'astro', 'synthesis'] }),
      content: S(),
    })),
  }),
};

const LANGS = ['zh-Hant', 'en', 'ja', 'ko'];
const TOOL_LABEL = {
  'zh-Hant': { lenormand: '雷諾曼牌陣', meihua: '梅花易數', astro: '西洋占星' },
  en: { lenormand: 'Lenormand Nine-Card Grid', meihua: 'Plum Blossom I Ching', astro: 'Natal Astrology' },
  ja: { lenormand: 'ルノルマン9枚グリッド', meihua: '梅花心易', astro: '西洋占星術' },
  ko: { lenormand: '르노르망 9카드', meihua: '매화역수', astro: '서양 점성술' },
};
// 九宮格組別小標題的預設字（前端也會把自己語系的標籤一併送上，以其為準）
// 九宮格八個小標題的伺服器端備援。前端會連同請求送出自己語系的字樣，
// 這裡的值只在它沒送或送了舊格式時派上用場——沒有這層備援，剛部署時還帶著
// 舊版 JS 的瀏覽器會讓 prompt 裡出現 "undefined" 當標題。
// ⚠ 必須與 js/i18n/locales/*.js 的 groups 逐字一致，否則模型寫的標題前端認不出來。
const GROUP_FALLBACK = {
  'zh-Hant': { past: '過去', present: '現在', future: '未來', outer: '外在環境', event: '事件現況', inner: '個人心境', combos: '值得注意的牌組', overall: '整體意義' },
  en: { past: 'Past', present: 'Present', future: 'Emerging', outer: 'Around you', event: 'The situation', inner: 'Where you stand', combos: 'Combinations worth noting', overall: 'What it adds up to' },
  ja: { past: '過去', present: '現在', future: 'これから', outer: '外の状況', event: '事の現状', inner: '自分の心境', combos: '注目したい組みあわせ', overall: '全体の意味' },
  ko: { past: '과거', present: '현재', future: '앞으로', outer: '바깥 상황', event: '일의 현재', inner: '나의 마음', combos: '눈여겨볼 조합', overall: '전체의 의미' },
};
function pickLang(v) { return LANGS.includes(v) ? v : 'zh-Hant'; }

// ---- 各階段資料段：排版成可讀文字（送給模型與記錄的就是這串文字，非 JSON 結構） ----

// 每一格只送三件事：編號、抽到哪張牌、那張牌象徵什麼。位置是標記，不是定義——
// 九宮格沒有一格有獨立牌義，解讀一律以「一組」為單位（哪些編號組成哪一組，
// 寫在 TOOL_STRUCT.lenormand 裡）。
//
// 曾經多送、後來移除的（都不符合上面那條規則）：
//   ・位置的語意標籤（「過去的想法／舊有認知」「全局核心／此刻的中心影響」…）
//   ・「中心牌（全局核心）：山」——十字法的殘留，且與「核心是事件現況那一組」衝突
//   ・「收斂主題：阻礙與消耗（×3）…」——在模型讀牌之前先給結論，而且把位置
//     資訊抹掉（實測「阻礙」落在過去與現在、「洞察」落在現在與未來，走向清楚，
//     數出來卻是 3:3 打平）
function fmtLenormand(L) {
  if (!L || !Array.isArray(L.grid)) return '（無牌陣資料）';
  // 只送「位置＋牌名」，不附關鍵字與牌義：那些句子是站方自己寫的詮釋，
  // 帶有取向（例如鳥只寫了焦慮那一極），注入後模型會被它綁死。
  // 系統提示已把模型定位成資深解牌師——牌義交給它自己的傳統知識。
  const lines = L.grid.map((g, i) => `${g.position || i + 1}｜${g.card}`);
  return ['九宮格（由左至右、由上至下為位置 1–9）：', ...lines].join('\n');
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
    // 排序：先依容許度的整數度數分組（0°、1°、2°…），同一組內主相位在前、
    // 次要相位在後，同組同類再依實際容許度。
    //
    // 為什麼容許度在類型之前：一個 0° 且正在入相的次要相位，實際重量高過一個
    // 容許度 6–7°、已經出相的主相位。舊的排法（主相位全部在前）會把前者推到
    // 第 31 行之後，等於用排版否定了這個判斷。
    //
    // 標題必須如實描述這個順序——否則標題與判準互相拉扯，模型無從取捨。
    // 這裡排序也讓標題對任何呼叫方都成立，不必要求上游先排好。
    const orbOf = (x) => (Number.isFinite(x.orbDeg) ? x.orbDeg : 99);
    const asp = [...A.aspects].sort((x, y) =>
      (Math.floor(orbOf(x)) - Math.floor(orbOf(y)))
      || (x.major === y.major ? 0 : (x.major ? -1 : 1))
      || (orbOf(x) - orbOf(y)));
    const nMaj = asp.filter((x) => x.major).length;
    // 也要講明清單並不完整：astroForAI 只取最緊的 30＋12 條（交點的主相位另外
    // 全數保留）。不說的話，模型會從「清單裡沒有」推論成「這個相位不存在」
    // ——那是它自己補出來的結論。
    out.push('', `【相位（共 ${asp.length} 條：主相位 ${nMaj}、次要相位 ${asp.length - nMaj}。`
      + `排序：先依容許度整數度數由緊至鬆分組（0°、1°、2°…），同一組內主相位在前、次要相位在後；`
      + `只收錄容許度最緊的部分，未列出不代表不存在）】`);
    for (const a of asp) {
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
    // 只講事實，不下詮釋。舊版會印「（近乎孤立）」——那是我們替模型做的判斷，
    // 而且「（僅有次要相位）」在該行星有小行星主相位時是錯的。改成如實列出
    // 它實際有哪些相位，讓模型自己判斷這代表什麼。
    out.push(`無主相位行星（比對範圍：十大行星與南北交點；與小行星、四軸、福點的相位不列入此判定）：${
      A.unaspected.map((u) => {
        const has = [];
        if ((u.majorsOutsideCore || []).length) has.push(`另有主相位 ${u.majorsOutsideCore.join('、')}`);
        if ((u.minors || []).length) has.push(`次要相位 ${u.minors.join('、')}`);
        // 舊紀錄沒有這兩個欄位（曾只存 minorOnly），退回指向相位表，不編造內容
        if (!has.length && !('majorsOutsideCore' in u) && !('minors' in u)) has.push('詳見相位表');
        return `${u.body}${has.length ? `（${has.join('；')}）` : '（相位表中沒有其他相位）'}`;
      }).join('｜')}`);
  }
  return out.join('\n');
}

// 各階段丟給模型前的資料段（可讀文字；只納入使用者所選工具，分別記錄供後台復盤）
function buildSegments(p) {
  const tools = Array.isArray(p.tools) && p.tools.length ? p.tools : ['lenormand'];
  const astroText = fmtAstro(p.astro);
  const lang = pickLang(p.lang);
  const gl = (p.groupLabels && typeof p.groupLabels === 'object') ? p.groupLabels : {};
  const groups = { ...GROUP_FALLBACK[lang], ...gl };
  return {
    opening: String(p.opening || '').slice(0, 600),
    lang,
    groups,
    tools,
    lenormand: tools.includes('lenormand') ? fmtLenormand(p.lenormand).slice(0, 4000) : null,
    meihua: tools.includes('meihua') ? fmtMeihua(p.meihua).slice(0, 1500) : null,
    astro: tools.includes('astro') ? (astroText ? astroText.slice(0, 11000) : '（星盤資料缺漏）') : null,
  };
}

// 各語言的篇幅規定（由站主指定；CJK 以字計，英文以 word 計）
const LEN_RULE = {
  'zh-Hant': '整節總字數**硬性上限 1700 字、下限 1200 字**（含標點）',
  ja: '整節總字數**硬性上限 2000 字、下限 1700 字**（含標點）',
  ko: '整節總字數**硬性上限 2000 字、下限 1700 字**（韓文字，含標點）',
  en: '整節總長度**硬性上限 1000 words、下限 700 words**',
};

// 占星的字數上限。刻意只有上限、沒有下限：下限會逼模型在沒東西可講時硬撐，
// 而占星該講幾段本來就由盤與主題決定。各語系比例沿用 LEN_RULE 的校準。
const ASTRO_LEN = {
  'zh-Hant': '整節總字數請控制在 **3000 字以內**',
  ja: '整節總字數請控制在 **3500 字以內**（日文字）',
  ko: '整節總字數請控制在 **3500 字以內**（韓文字）',
  en: '整節總長度請控制在 **1800 words 以內**',
};

// 每個工具「必須逐項走完」的結構——直接寫進 prompt，模型須依此展開每一段
const TOOL_STRUCT = {
  lenormand: (g) => `雷諾曼牌陣（九宮格 3×3）——content 依下列八個小標題依序展開，每個標題單獨成行，換行後才寫該段內容。

標題必須**逐字使用**下列字樣（不可改寫、不可加說明、不可加編號）：
${g.past}／${g.present}／${g.future}／${g.outer}／${g.event}／${g.inner}／${g.combos}／${g.overall}

【每一段要回答什麼】
${g.past}（1、4、7）：這件事從哪裡來？當時的狀態與已經形成的條件是什麼？
${g.present}（2、5、8）：現在實際的位置在哪裡？眼前有什麼、缺什麼？
${g.future}（3、6、9）：照現在的走勢會往哪裡去？什麼會先出現？
${g.outer}（1、2、3）：對當事人來說外在局勢是什麼？哪些是當事人此刻不可控的？若涉及特定對象或組織，外部氣氛與其狀態是什麼？
${g.event}（4、5、6）：這件事目前真正的狀態是什麼？卡住的點在哪裡？而且要說明——它為什麼會變成現在這樣（必須扣回外在與個人兩組，不能單獨判讀）。
${g.inner}（7、8、9）：當事人的心境、信念與行動模式是什麼？真正的期待是什麼？哪些仍握在自己手裡、可以調整？
${g.combos}：挑出這副牌裡值得注意的牌組，說明它們為什麼重要。
${g.overall}：外在與個人這兩股力量如何交互、共同形成目前的局勢；以及接下來可以怎麼做。這一段是收攏，不要重述前面已經講過的情節。

【怎麼寫】
・每一段就是把該組的牌合起來讀，講出具體的內容——是什麼、往哪裡去、對當事人意味著什麼。
・直接寫牌名，用 + 連接（例：船+雲：……），後面接這個組合的意思。
・⚠ 不要寫「那一排」「這一排」「這三張」「這一組牌」（及其他語言的同義說法，如 "that row"／"those three cards"／「あの列」／'그 줄'），也不要寫位置編號——牌陣已用圖示呈現在文字上方，讀者看得到位置。用牌名指稱就好。
・上面括號裡的位置編號只是給你對照用的，不要出現在輸出裡。
・長度由內容決定：把該講的講清楚，不要為了篇幅硬撐，也不要草率帶過。`,
  meihua: (g, len) => `梅花易數——content 內請依下列小標題依序完整展開，把整個卦象整理成一個完整的故事，而非零碎解釋：
① 本卦：卦名與卦象含義。
② 變卦：卦名與其代表的走向變化。
③ 動爻：哪一爻動、它的意義。
④ 卦象含義：本卦、互卦、變卦與體用生剋合起來說明。
⑤ 行動建議。
每個小標題都要出現、有實質敘述，但每段都要精簡。⚠ ${len}，為求達標請適度精簡各段、不要展開過多——這比「寫得很長」更重要。`,
  // 段數刻意不規定：挑幾組配置由這張盤與這個主題決定。小標題也不預先給字樣——
  // 它是「這組配置共同指向什麼」的白話結論，只能由挑出來的配置長出來。
  astro: (g, len, closing, astroLen) => `西洋占星——把指向同一件事的配置合成一段來寫。每一段固定三部分，各自換行：

第一行：這組配置共同指向的核心，用白話寫成一句話（讀者看得懂的生活語言，不要用星盤術語當標題）。
第二行：這組配置分別是什麼，以｜分隔。不要加括號。
第三行起：分析內容。

範例（只是格式示範，不是要你套用這些配置）：

透過長期累積專業建立財富
二宮宮主星落十宮｜金星合木星｜二宮土星｜八宮宮主星三分 MC
這組配置共同指向……

真正的動力來自創造而非競爭
太陽五宮｜Vesta 五宮｜火星三分太陽
這組配置反覆顯示……

若這一段是由飛星（Disposition）串起來的，第二行改寫成故事線：用 → 依序串接，標題寫「◯◯故事線」。飛星代表不同生命領域彼此如何連結，這種段落要分析它形成的因果脈絡，不是逐宮解釋。

財富故事線
二宮 → 二宮宮主星落十宮 → 十宮宮主星落十一宮 → 十一宮宮主星落五宮
這條故事線顯示，這個人的財富並非來自單一收入來源，而是透過建立專業（十宮）、擴大影響力與人脈（十一宮），最後結合創造力、自我表達或個人作品（五宮）逐步累積。

其他故事線同一種寫法，例如：

事業故事線
六宮 → 六宮宮主星落五宮 → 五宮宮主星落十宮

關係故事線
七宮 → 七宮宮主星落十一宮 → 十一宮宮主星落一宮

家庭故事線
四宮 → 四宮宮主星落九宮 → 九宮宮主星落三宮

人生方向故事線
北交點 → 北交點守護星 → 守護星落宮位 → 與主要相位共同形成的發展方向

段數由這張盤與這個主題決定，不必湊數，字數以需要的內容決定長度；但每一段都要有實質分析，不可以只列配置就結束。

⚠ ${astroLen}（不含各段標題與配置清單那一行）。這是上限、不是目標——不需要湊到這個長度；若內容較多，請減少段數或把每段寫得更精準，不要為了塞進所有配置而每段都草率帶過。

最後一段的標題就寫「${closing}」，這一段不用列出配置那一行，言簡意賅把前面各段核心串成一條完整的生命脈絡敘事，並列出彙整的建議。

所有數據只能依提供的星盤，不得補造。`,
};

// 占星最後一段的標題。這是唯一一個「必須逐字使用」的占星小標題，所以要跟著
// 輸出語言走——prompt 本文是中文，若不給對應字樣，英日韓的報告會冒出中文標題。
//
// 直接沿用雷諾曼收束段的 groups.overall（繁中「整體意義」）：兩者要做的事一樣
// ——把前面各段收攏成一條脈絡、並收尾給建議（雷諾曼那段的規定裡也明寫「以及
// 接下來可以怎麼做」）。沿用同一個字串有兩個好處：四語系的翻譯已經在 locale
// 檔裡，不必維護第二套（否則改一邊忘另一邊就會不一致）；使用者在不同工具之間
// 看到的收束段也叫同一個名字。
// 下面這組只是 groupLabels 沒送到時的後備，不是主要來源。
const ASTRO_CLOSING = { 'zh-Hant': '整體意義', en: 'What it adds up to', ja: '全体の意味', ko: '전체의 의미' };

// 哪些工具有「規定好、必須逐字使用」的小標題。
// 占星刻意不列在這裡：它的小標題應該由「這張盤裡與主題高度相關的配置」長出來，
// 每張盤不同、每個主題挑到的配置也不同，硬套固定段落只會逼它去寫無關的內容。
// 這個集合存在的唯一理由是——底下的通用指令需要知道「這次能不能自己命名小標題」，
// 否則「每個小標題都必須出現」「不要自己另外命名」這兩句會把占星的自由挑選擋掉。
const FIXED_HEADINGS = new Set(['lenormand', 'meihua']);

// ── 結構驗收（不是寫給模型看的）────────────────────────────────────────────
// 為什麼放在程式而不是指令裡：字數規定寫進指令，模型會把它當成寫作目標去湊；
// 放在這裡，模型完全不知道有這條線，自然地寫，由我們收到之後判斷「這次是不是
// 壞了」。門檻刻意設得很低，只攔崩潰（曾經出現整節只有 300 字、八段幾乎全空
// 的情況），不去雕塑正常輸出——正常的解讀離這些線很遠。
const MIN_BODY = { cjk: 60, en: 25 };   // 每段本文（CJK 字／英文 words）
const MIN_TOTAL = { cjk: 500, en: 220 };

function countUnits(text, lang) {
  return lang === 'en'
    ? String(text).trim().split(/\s+/).filter(Boolean).length
    : String(text).replace(/\s+/g, '').length;
}

// 回傳缺漏原因（陣列），空陣列＝通過。只驗雷諾曼那一節。
function lenormandShortfalls(content, groups, lang) {
  const unit = lang === 'en' ? 'en' : 'cjk';
  const heads = ['past', 'present', 'future', 'outer', 'event', 'inner', 'combos', 'overall']
    .map((k) => groups[k]).filter(Boolean);
  if (heads.length !== 8) return [];        // 語系缺標題就不驗，避免誤判
  const lines = String(content || '').split(/\n+/).map((x) => x.trim()).filter(Boolean);
  const bad = [];
  const idx = heads.map((h) => lines.findIndex((l) => l.replace(/[：:。，,、\s]+$/, '') === h));
  heads.forEach((h, i) => {
    if (idx[i] < 0) { bad.push(`缺少「${h}」`); return; }
    // 該標題到下一個標題之間的所有行＝這一段的本文
    const nexts = idx.filter((n) => n > idx[i]);
    const end = nexts.length ? Math.min(...nexts) : lines.length;
    const body = lines.slice(idx[i] + 1, end).join('');
    if (countUnits(body, unit) < MIN_BODY[unit]) bad.push(`「${h}」幾乎沒有內容`);
  });
  if (countUnits(lines.join(''), unit) < MIN_TOTAL[unit]) bad.push('整節過短');
  return bad;
}

// data 是模型回傳的物件。回傳缺漏原因陣列（空＝通過）。
function shortfallsOf(data, seg) {
  if (!seg.tools || !seg.tools.includes('lenormand')) return [];
  const sec = ((data && data.sections) || []).find((x) => x && x.tool === 'lenormand');
  if (!sec) return ['缺少雷諾曼那一節'];
  return lenormandShortfalls(sec.content, seg.groups || {}, seg.lang || 'zh-Hant');
}

function buildPrompt(action, p, seg) {
  if (action !== 'analyze') return '';
  const tools = seg.tools && seg.tools.length ? seg.tools : ['lenormand'];
  const blocks = [];
  if (tools.includes('lenormand')) blocks.push(`【雷諾曼牌陣（使用者親手選九張，位置 1–9）】\n${seg.lenormand}`);
  if (tools.includes('meihua')) blocks.push(`【梅花易數（使用者報數起卦）】\n${seg.meihua}`);
  if (tools.includes('astro')) blocks.push(`【西洋占星本命盤（Swiss Ephemeris 實算；僅可依此詮釋，不得補造）】\n${seg.astro}`);

  const multi = tools.length > 1;
  const lang = seg.lang || 'zh-Hant';
  const label = (x) => (TOOL_LABEL[lang] || TOOL_LABEL['zh-Hant'])[x] || x;
  const len = LEN_RULE[lang] || LEN_RULE['zh-Hant'];
  const order = tools.map(label).join('、');
  // 雷諾曼不傳 len：它的段落規定改用「每段要回答什麼」定義完整度，不用字數。
  // 字數下限會逼模型在沒東西可講時硬撐——那正是舊版冗長的來源。
  const closing = (seg.groups && seg.groups.overall)
    || ASTRO_CLOSING[lang] || ASTRO_CLOSING['zh-Hant'];
  const astroLen = ASTRO_LEN[lang] || ASTRO_LEN['zh-Hant'];
  const structs = tools.map((x) => `〔${label(x)}〕\n${TOOL_STRUCT[x](seg.groups || {}, len, closing, astroLen)}`).join('\n\n');
  const fixed = tools.filter((x) => FIXED_HEADINGS.has(x)).map(label);
  const free = tools.filter((x) => !FIXED_HEADINGS.has(x)).map(label);
  // 沒有固定小標題的工具（占星）不在這裡補任何說明：它的段落寫法與小標題規則
  // 都寫在自己的 TOOL_STRUCT 裡，在這裡再講一次只會多一個日後互相矛盾的地方。
  const headRule = fixed.length
    ? `${fixed.join('、')}的小標題已在下方規定：每個都必須出現、都要有實質敘述，不可省略任何一項，字樣也不可改寫。`
    : '';
  const namingRule = fixed.length && free.length
    ? '有規定字樣的工具逐字使用，其餘依該工具說明的寫法'
    : (free.length ? '依各工具說明的寫法（見上）' : '只用各工具規定的字樣（見上），不要自己另外命名');
  const secRule = multi
    ? `sections 依序輸出這些工具的完整解析：${order}（tool 欄位用代碼 ${tools.join('、')}），最後再加一節 tool="synthesis" 的「交叉比對綜合分析」。不得用綜合分析取代任何工具的完整解析。`
    : `sections 只有一節：${order}（tool 欄位用代碼 ${tools[0]}）。這是使用者當次唯一的分析。`;

  return `使用者想探索的主題：「${seg.opening}」

使用者選用的分析工具：${order}

${blocks.join('\n\n')}

請為每個所選工具產出一節解析，**依下列每個工具的說明展開**。${headRule}有註明字數上限的工具請遵守；沒有註明的，長度由內容決定：該講的講清楚，不為篇幅硬撐，也不草率帶過。

使用者的主題已顯示在報告最上方，內文請**直接展開分析**，不要在開頭再複述一次主題或提問（例如不要用「關於『…』」「你問的是…」起頭）。

${structs}
${multi ? '\n完成各節後，另加「交叉比對綜合分析」：找出共同反覆出現的核心、彼此互補之處，整理出最重要的生命主題與下一步方向。\n' : ''}
輸出 JSON：
- title：一句自然、日常、一看就懂的話（以輸出語言書寫；中日韓 ≤16 字，英文 ≤10 words）。此標題**不會顯示在報告上**，僅用於「我的靈感訊息」列表的標籤。
- sections：${secRule} 每節 content 用完整段落敘事、追求洞察感而非文學感；小標題${namingRule}，不要用 markdown 符號。`;
}

async function callOpenAI(apiKey, model, maxTokens, systemPrompt, userPrompt, schema, schemaName) {
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
        { role: 'system', content: systemPrompt },
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

async function callAnthropic(apiKey, model, maxTokens, systemPrompt, userPrompt, schema) {
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
      system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
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

  // 計時：把這支端點拆成「組 prompt」「寫紀錄」「呼叫模型」三段。
  // 前端會把這些數字連同自己量到的時間一起送到 /api/track，後台才看得出時間花在哪。
  const tEnter = Date.now();
  const segments = buildSegments(body);
  const prompt = buildPrompt(action, body, segments);
  const maxTokens = MAX_TOKENS[action];
  const schema = SCHEMAS[action];

  // system prompt 依所選工具動態組裝（只納入被選到的章節；兩個以上工具才加「交叉比對綜合分析」）
  const systemPrompt = buildSystemPrompt(segments.tools, segments.lang);
  const sysHash = djb2(systemPrompt);
  const promptMs = Date.now() - tEnter;

  // 記錄實際送出的 prompt 與各階段資料段（呼叫前寫入——模型失敗也留有紀錄可復盤）
  const sid = String((body && body.sid) || '').slice(0, 16).replace(/[^\w-]/g, '');
  const tRecord = Date.now();
  await recordPrompt(
    sid,
    openaiKey ? 'openai' : 'anthropic',
    openaiKey ? openaiModels()[action] : MODEL[action],
    systemPrompt,
    sysHash,
    prompt,
    segments,
  );
  const recordMs = Date.now() - tRecord;

  const timing = (extra) => ({
    promptMs,
    recordMs,
    promptChars: prompt.length,
    sysChars: systemPrompt.length,
    provider: openaiKey ? 'openai' : 'anthropic',
    model: openaiKey ? openaiModels()[action] : MODEL[action],
    ...extra,
    serverMs: Date.now() - tEnter,
  });

  // 呼叫一次，失敗重試一次，再失敗回 fallback（兩者皆設時優先 OpenAI）。
  // 「失敗」除了拋錯，也包含結構驗收不通過——殘缺的解讀不要送到使用者面前，
  // 寧可多等一輪。retries 會記進 timing，後台才看得出這道機制多久觸發一次；
  // 若觸發率偏高，代表該回頭改指令，不是靠重跑硬撐。
  const llmMs = [];
  let lastData = null;
  let shortfalls = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    const tLlm = Date.now();
    try {
      const data = openaiKey
        ? await callOpenAI(openaiKey, openaiModels()[action], maxTokens, systemPrompt, prompt, schema, action)
        : await callAnthropic(anthropicKey, MODEL[action], maxTokens, systemPrompt, prompt, schema);
      llmMs.push(Date.now() - tLlm);
      lastData = data;
      shortfalls = shortfallsOf(data, segments);
      if (!shortfalls.length || attempt === 1) {
        // 第二輪仍不合格就照樣送出——殘缺總比讓使用者看到錯誤畫面好，
        // 而 shortfalls 會留在 timing 裡供後台追。
        res.status(200).json({
          ok: true,
          data,
          timing: timing({ llmMs, attempts: attempt + 1, shortfalls }),
        });
        return;
      }
    } catch (e) {
      llmMs.push(Date.now() - tLlm);
      if (attempt === 1) {
        if (lastData) {
          res.status(200).json({
            ok: true, data: lastData, timing: timing({ llmMs, attempts: 2, shortfalls }),
          });
          return;
        }
        res.status(200).json({ ok: false, fallback: true, timing: timing({ llmMs, attempts: 2, failed: true }) });
        return;
      }
    }
  }
}
