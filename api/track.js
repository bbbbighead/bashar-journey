// api/track.js — 匿名埋點收集端點（sendBeacon POST）。
// 事件：start（來訪：來源/UTM/裝置）、dwell（頁面停留）、journey（題目與產出）、
//       feedback（結果頁的星等與選填文字）、timing（「分析中」各階段耗時）。
// 寫入 Upstash Redis；未設定儲存後端時回 204 靜默丟棄。永不回傳錯誤內容給前端。
//
// 保存策略：資料不設時間過期。以 pi:agg:bytes 估算目前用量（邏輯大小＋每鍵固定開銷），
// 當用量超過容量上限（STORAGE_LIMIT_MB，預設 256MB＝Upstash 免費方案）的 95% 時，
// 自動從最舊的來訪開始刪除（含其題目/停留/標註，並回扣統計），使用量維持在 95% 以下；
// 汰舊次數與時間記錄於 pi:agg:pruned / pi:agg:pruned_at，供後台警示。
//
// 資料模型：
//   pi:sessions            LIST  來訪（JSON：sid/vid/ts/src/device/os/lang/country），新的在左、舊的在右
//   pi:dwell:<sid>         HASH  各畫面停留毫秒累計
//   pi:dwellcnt:<sid>      HASH  各畫面停留事件數（刪除時精準回扣平均值）
//   pi:journey:<sid>       STRING JSON（opening/cards/numbers/title/message/closing/offline/ts）
//   pi:fb:<sid>            STRING JSON（rating/text/topic/tools/ts）＝該次來訪的回饋
//   pi:feedback            LIST  同一份 JSON（含 sid/vid），新的在左，供後台整批瀏覽
//   pi:timing:<sid>        STRING JSON（各階段毫秒）＝該次來訪的處理時間
//   pi:timings             LIST  同一份 JSON（含 sid），新的在左，供後台效能分析
//   pi:agg:src / device    HASH  來源/裝置 → 次數
//   pi:agg:dwell_sum/_cnt  HASH  畫面 → 停留毫秒總和／次數
//   pi:agg:bytes           STRING 估算用量（bytes）
//   pi:agg:pruned(_at)     STRING 自動汰舊累計筆數／最近一次時間

import { redisPipeline, redisConfigured } from '../lib/redis.js';

const KEY_OVERHEAD = 64; // 每鍵估算固定開銷（bytes）
const LIMIT_BYTES = Math.max(0.01, Number(process.env.STORAGE_LIMIT_MB) || 256) * 1024 * 1024;
const PRUNE_TARGET = 0.95;

// 汰舊保護：進行中的來訪絕不能被刪。
// 一次體驗的資料是分好幾個請求陸續寫進來的（start → dwell → journey → feedback），
// 若在中途把來訪紀錄刪掉，後面寫入的題目、產出與回饋就變成沒有主人的孤兒鍵——
// 既讀不到（清單掃不到）、也不會被容量重算算到，用量估算因此越來越虛高。
// 一次體驗頂多幾分鐘，所以 30 分鐘的保護窗已非常寬裕；同時永遠留下最新的幾筆。
const PRUNE_MIN_AGE_MS = 30 * 60_000;
const PRUNE_KEEP_RECENT = 20;

// User-Agent → 裝置與作業系統（粗分類即可滿足分析需求）
function parseDevice(ua) {
  ua = String(ua || '');
  let device = 'desktop';
  if (/iPad|Macintosh.*Mobile|Android(?!.*Mobile)|Tablet/i.test(ua)) device = 'tablet';
  else if (/Mobi|iPhone|Android.*Mobile/i.test(ua)) device = 'mobile';
  let os = 'other';
  if (/iPhone|iPad|iPod/i.test(ua)) os = 'iOS';
  else if (/Android/i.test(ua)) os = 'Android';
  else if (/Windows/i.test(ua)) os = 'Windows';
  else if (/Mac OS X|Macintosh/i.test(ua)) os = 'macOS';
  else if (/Linux/i.test(ua)) os = 'Linux';
  return { device, os };
}

// 來源正規化：UTM 優先，其次 referrer 網域，否則「直接進入」
function parseSource(ref, utm) {
  if (utm) return 'utm:' + String(utm).slice(0, 40);
  try {
    if (ref) {
      const host = new URL(ref).hostname.replace(/^www\./, '');
      return host || '直接進入';
    }
  } catch { /* ignore */ }
  return '直接進入';
}

const SCREENS = ['screenIntake', 'screenSpread', 'screenNumbers', 'screenWeaving', 'screenResult', 'screenCare'];

// 極簡防濫用
const RATE = new Map();
function rateLimited(ip) {
  const now = Date.now();
  const hits = (RATE.get(ip) || []).filter((t) => t > now - 3600_000);
  hits.push(now);
  RATE.set(ip, hits);
  return hits.length > 600;
}

// 出生資料紀錄（供後台分析）：逐欄清洗與截長
function sanitizeBirth(b) {
  if (!b || typeof b !== 'object') return null;
  return {
    date: String(b.date || '').slice(0, 10),
    time: b.time == null ? null : String(b.time).slice(0, 5),
    timeUnknown: !!b.timeUnknown,
    city: String(b.city || '').slice(0, 80),
    country: b.country ? String(b.country).slice(0, 40) : null,
    resolved: String(b.resolved || '').slice(0, 120),
    tz: String(b.tz || '').slice(0, 40),
    utc: String(b.utc || '').slice(0, 16),
    sun: String(b.sun || '').slice(0, 8),
    moon: String(b.moon || '').slice(0, 8),
    asc: String(b.asc || '').slice(0, 8),
  };
}

function toObj(arr) {
  const o = {}; const a = arr || [];
  for (let i = 0; i < a.length; i += 2) o[a[i]] = a[i + 1];
  return o;
}

// 停留資料的估算大小：與寫入時的增量（100/事件）完全對稱，避免記帳漂移
export function dwellBytes(dwell, dcnt) {
  const events = Object.values(dcnt).reduce((a, v) => a + (Number(v) || 0), 0)
    || Object.keys(dwell).length; // 舊紀錄沒有事件數：以每畫面 1 次估計
  return events * 100;
}

// 刪除一批來訪紀錄（清單項已由呼叫端移出或將以 LREM 移出），回傳估算釋放的 bytes
async function removeEntries(entries, useLrem) {
  if (!entries.length) return 0;
  const STRIDE = 7;
  const reads = await redisPipeline(entries.flatMap((e) => [
    ['STRLEN', `pi:journey:${e.sid}`],
    ['HGETALL', `pi:dwell:${e.sid}`],
    ['HGETALL', `pi:dwellcnt:${e.sid}`],
    ['STRLEN', `pi:note:${e.sid}`],
    ['STRLEN', `pi:prompt:${e.sid}`],
    ['GET', `pi:fb:${e.sid}`], // 取全文而非長度：從 pi:feedback 清單移除需要原始字串
    ['GET', `pi:timing:${e.sid}`],
  ]));

  const cmds = [];
  let freed = 0;
  entries.forEach((e, i) => {
    freed += e.raw.length + 16;
    const jLen = Number(reads[i * STRIDE].result || 0);
    if (jLen) freed += jLen + KEY_OVERHEAD;
    const dwell = toObj(reads[i * STRIDE + 1].result);
    const dcnt = toObj(reads[i * STRIDE + 2].result);
    freed += dwellBytes(dwell, dcnt);
    const nLen = Number(reads[i * STRIDE + 3].result || 0);
    if (nLen) freed += nLen + KEY_OVERHEAD;
    const pLen = Number(reads[i * STRIDE + 4].result || 0);
    if (pLen) freed += pLen + KEY_OVERHEAD;
    const fbRaw = reads[i * STRIDE + 5].result || '';
    if (fbRaw) {
      freed += fbRaw.length + KEY_OVERHEAD + fbRaw.length + 16; // 字串 + 清單各一份
      cmds.push(['LREM', 'pi:feedback', '1', fbRaw]);
    }
    const tmRaw = reads[i * STRIDE + 6].result || '';
    if (tmRaw) {
      freed += tmRaw.length + KEY_OVERHEAD + tmRaw.length + 16;
      cmds.push(['LREM', 'pi:timings', '1', tmRaw]);
    }

    if (useLrem) cmds.push(['LREM', 'pi:sessions', '1', e.raw]);
    if (e.src) cmds.push(['HINCRBY', 'pi:agg:src', e.src, '-1']);
    if (e.device) cmds.push(['HINCRBY', 'pi:agg:device', e.device, '-1']);
    for (const [screen, ms] of Object.entries(dwell)) {
      cmds.push(['HINCRBY', 'pi:agg:dwell_sum', screen, String(-Math.round(Number(ms) || 0))]);
      cmds.push(['HINCRBY', 'pi:agg:dwell_cnt', screen, String(-(Number(dcnt[screen]) || 1))]);
    }
    if (e.sid) {
      cmds.push(
        ['DEL', `pi:journey:${e.sid}`],
        ['DEL', `pi:dwell:${e.sid}`],
        ['DEL', `pi:dwellcnt:${e.sid}`],
        ['DEL', `pi:note:${e.sid}`],
        ['DEL', `pi:prompt:${e.sid}`],
        ['DEL', `pi:fb:${e.sid}`],
        ['DEL', `pi:timing:${e.sid}`],
      );
    }
  });
  cmds.push(
    ['INCRBY', 'pi:agg:bytes', String(-Math.round(freed))],
    ['INCRBY', 'pi:agg:pruned', String(entries.length)],
    ['SET', 'pi:agg:pruned_at', String(Date.now())],
  );
  await redisPipeline(cmds);
  return freed;
}

function parseEntry(r) {
  try { return { raw: r, ...JSON.parse(r) }; } catch { return { raw: r }; }
}

// 從最舊的紀錄開始刪，直到回到目標用量以下。
// 永遠保留最新的 PRUNE_KEEP_RECENT 筆——剛開始的來訪一定在清單最前面，
// 這條規則本身就保證了進行中的來訪不會被刪。
// 以 LRANGE 先看過、再用 LREM 精準移除，不用 RPOP：RPOP 會先把紀錄拿走，
// 之後才判斷它其實該保留就來不及了。
async function pruneOldest(bytes, target, prunable) {
  for (let round = 0; round < 6 && bytes > target; round++) {
    const [lenR] = await redisPipeline([['LLEN', 'pi:sessions']]);
    const removable = Number(lenR.result || 0) - PRUNE_KEEP_RECENT;
    if (removable <= 0) break;
    const take = Math.min(20, removable);
    const [rangeR] = await redisPipeline([['LRANGE', 'pi:sessions', String(-take), '-1']]);
    const batch = (rangeR.result || []).map(parseEntry).filter(prunable);
    if (!batch.length) break;
    bytes -= await removeEntries(batch, true);
  }
  return bytes;
}

// 汰舊一輪：先刪「未完成（沒有留下題目）」的紀錄（由最舊往新），
// 仍不足時才從最舊的完成紀錄開始刪。prunable 決定哪些紀錄可以碰。
async function pruneToTarget(bytes, target, prunable) {
  // 未完成優先（掃描最舊的 300 筆，找出沒有 journey 的）
  const [tailR] = await redisPipeline([['LRANGE', 'pi:sessions', '-300', '-1']]);
  const tail = (tailR.result || []).map(parseEntry).reverse().filter(prunable); // 最舊在前
  if (tail.length) {
    const exists = await redisPipeline(tail.map((e) => ['EXISTS', `pi:journey:${e.sid}`]));
    const incompletes = tail.filter((e, i) => exists[i].result !== 1);
    for (let i = 0; i < incompletes.length && bytes > target; i += 20) {
      bytes -= await removeEntries(incompletes.slice(i, i + 20), true);
    }
  }
  // 仍超標 → 從最舊的紀錄（含完成的）開始刪
  return pruneOldest(bytes, target, prunable);
}

// 用量超過上限的 95% 時自動汰舊。
async function maybePrune() {
  const [bR] = await redisPipeline([['GET', 'pi:agg:bytes']]);
  let bytes = Number(bR.result || 0);
  const target = LIMIT_BYTES * PRUNE_TARGET;
  if (bytes <= target) return;

  // 最新的幾筆一律不動——進行中的來訪一定在清單最前面（見 PRUNE_KEEP_RECENT 的說明）
  const [recentR] = await redisPipeline([['LRANGE', 'pi:sessions', '0', String(PRUNE_KEEP_RECENT - 1)]]);
  const kept = new Set(recentR.result || []);
  const cutoff = Date.now() - PRUNE_MIN_AGE_MS;
  const unprotected = (e) => !!e.sid && !kept.has(e.raw);
  // 已結束＝不在保護名單內，且開始時間已超過保護窗（沒有 ts 的舊格式紀錄視為久遠）
  const settled = (e) => unprotected(e) && !(Number(e.ts) > cutoff);

  bytes = await pruneToTarget(bytes, target, settled);

  // 仍超標＝短時間內爆量，所有紀錄都還在保護窗內。若就此罷手，用量會一路衝破
  // 儲存上限、連寫入都失敗；因此放寬時間條件，但「最新的幾筆」這條線仍然守住。
  if (bytes > target) await pruneToTarget(bytes, target, unprotected);
}

export default async function handler(req, res) {
  res.status(204); // 埋點一律 204，無論成敗

  try {
    if (req.method !== 'POST' || !redisConfigured()) { res.end(); return; }

    const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
    if (rateLimited(ip)) { res.end(); return; }

    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = null; } }
    if (!body || typeof body !== 'object') { res.end(); return; }

    const sid = String(body.sid || '').slice(0, 16).replace(/[^\w-]/g, '');
    const vid = String(body.vid || '').slice(0, 12).replace(/[^\w-]/g, '');
    if (!sid || !vid) { res.end(); return; }

    const cmds = [];
    let checkPrune = false;

    if (body.type === 'start') {
      const { device, os } = parseDevice(req.headers['user-agent']);
      const src = parseSource(body.ref, body.utm);
      const entry = JSON.stringify({
        sid, vid, ts: Date.now(), src, device, os,
        lang: String(body.lang || '').slice(0, 12),
        // 地區：只存兩字母國碼，永不存城市或 IP。
        // 城市加上 vid 就足以把一筆紀錄重新識別回特定的人；國碼的顆粒度粗到
        // 沒有這個風險，但已經夠回答「哪些語區的人在用」。
        // 標頭由平台在邊緣填入（Vercel／Cloudflare），前端傳什麼都不採用。
        country: String(req.headers['x-vercel-ip-country'] || req.headers['cf-ipcountry'] || '')
          .toUpperCase().replace(/[^A-Z]/g, '').slice(0, 2),
      });
      cmds.push(
        ['LPUSH', 'pi:sessions', entry],
        ['HINCRBY', 'pi:agg:src', src, '1'],
        ['HINCRBY', 'pi:agg:device', device, '1'],
        ['INCRBY', 'pi:agg:bytes', String(entry.length + 16)],
      );
      checkPrune = true; // 每次來訪檢查一次容量即可
    } else if (body.type === 'dwell') {
      const screen = String(body.screen || '');
      const ms = Math.min(Math.max(0, Number(body.ms) || 0), 3600_000);
      if (!SCREENS.includes(screen) || ms < 400) { res.end(); return; }
      cmds.push(
        ['HINCRBY', `pi:dwell:${sid}`, screen, String(Math.round(ms))],
        ['HINCRBY', `pi:dwellcnt:${sid}`, screen, '1'],
        ['HINCRBY', 'pi:agg:dwell_sum', screen, String(Math.round(ms))],
        ['HINCRBY', 'pi:agg:dwell_cnt', screen, '1'],
        ['INCRBY', 'pi:agg:bytes', '100'], // 估算增量：兩個 hash 的欄位＋鍵開銷攤提
      );
    } else if (body.type === 'journey') {
      const journey = JSON.stringify({
        ts: Date.now(),
        opening: String(body.opening || '').slice(0, 300),
        tools: Array.isArray(body.tools) ? body.tools.slice(0, 6).map((t) => String(t).slice(0, 16)) : null,
        cards: Array.isArray(body.cards) ? body.cards.slice(0, 9).map((c) => String(c).slice(0, 8)) : [],
        numbers: Array.isArray(body.numbers) ? body.numbers.slice(0, 3).map(Number) : null,
        title: String(body.title || '').slice(0, 60),
        message: String(body.message || '').slice(0, 4000), // 完整分節輸出
        closing: String(body.closing || '').slice(0, 100),
        offline: !!body.offline,
        astroUsed: !!body.astroUsed,
        astroSun: String(body.astroSun || '').slice(0, 8),
        astroBirth: sanitizeBirth(body.astroBirth),
      });
      cmds.push(
        ['SET', `pi:journey:${sid}`, journey],
        ['INCRBY', 'pi:agg:bytes', String(journey.length + KEY_OVERHEAD)],
      );
    } else if (body.type === 'feedback') {
      // 結果頁的回饋：1–5 顆星（必填）＋選填文字。同一次來訪重送＝覆寫舊的。
      const rating = Math.round(Number(body.rating) || 0);
      if (rating < 1 || rating > 5) { res.end(); return; }
      const record = JSON.stringify({
        sid,
        vid,
        ts: Date.now(),
        rating,
        text: String(body.text || '').trim().slice(0, 500),
        topic: String(body.topic || '').slice(0, 300),
        tools: Array.isArray(body.tools) ? body.tools.slice(0, 6).map((x) => String(x).slice(0, 16)) : null,
        title: String(body.title || '').slice(0, 60),
        lang: String(body.lang || '').slice(0, 12),
        offline: !!body.offline,
      });
      // 舊回饋要先從清單移除，否則同一次來訪會出現兩筆
      const [oldR] = await redisPipeline([['GET', `pi:fb:${sid}`]]);
      const old = oldR.result || '';
      if (old) cmds.push(['LREM', 'pi:feedback', '1', old]);
      const oldSize = old ? old.length + KEY_OVERHEAD + old.length + 16 : 0;
      const newSize = record.length + KEY_OVERHEAD + record.length + 16;
      cmds.push(
        ['SET', `pi:fb:${sid}`, record],
        ['LPUSH', 'pi:feedback', record],
        ['INCRBY', 'pi:agg:bytes', String(newSize - oldSize)],
      );
    } else if (body.type === 'timing') {
      // 「分析中」的分段耗時。與 journey 分開存：它是效能資料，會隨優化不斷變動。
      // 沒量到就是 null，不能寫成 0——否則沒用占星的那些次會把「查地點」
      // 的中位數拉到 0，統計就失去意義
      const ms = (v) => {
        if (v == null || v === '') return null;
        const n = Number(v);
        return Number.isFinite(n) && n >= 0 && n < 600_000 ? Math.round(n) : null;
      };
      const record = JSON.stringify({
        sid,
        ts: Date.now(),
        tools: Array.isArray(body.tools) ? body.tools.slice(0, 6).map((x) => String(x).slice(0, 16)) : null,
        lang: String(body.lang || '').slice(0, 12),
        // 前端量到的
        weavingMs: ms(body.weavingMs),
        analyzeMs: ms(body.analyzeMs),
        holdMs: ms(body.holdMs),
        requestMs: ms(body.requestMs),
        // /api/insight 伺服器端
        promptMs: ms(body.promptMs),
        recordMs: ms(body.recordMs),
        llmMs: Array.isArray(body.llmMs) ? body.llmMs.slice(0, 3).map(ms).filter((x) => x != null) : null,
        insightServerMs: ms(body.insightServerMs),
        attempts: ms(body.attempts),
        promptChars: ms(body.promptChars),
        model: String(body.model || '').slice(0, 40),
        provider: String(body.provider || '').slice(0, 12),
        // /api/astro（Swiss Ephemeris）
        astroRoundTripMs: ms(body.astroRoundTripMs),
        astroGeocodeMs: ms(body.astroGeocodeMs),
        astroEphemerisMs: ms(body.astroEphemerisMs),
        astroServerMs: ms(body.astroServerMs),
      });
      // 同一次來訪重跑（重試）＝覆寫，並把舊的從清單移除
      const [oldR] = await redisPipeline([['GET', `pi:timing:${sid}`]]);
      const old = oldR.result || '';
      if (old) cmds.push(['LREM', 'pi:timings', '1', old]);
      const oldSize = old ? old.length + KEY_OVERHEAD + old.length + 16 : 0;
      const newSize = record.length + KEY_OVERHEAD + record.length + 16;
      cmds.push(
        ['SET', `pi:timing:${sid}`, record],
        ['LPUSH', 'pi:timings', record],
        ['INCRBY', 'pi:agg:bytes', String(newSize - oldSize)],
      );
    } else {
      res.end(); return;
    }

    await redisPipeline(cmds);
    if (checkPrune) await maybePrune();
  } catch { /* 埋點失敗靜默 */ }
  res.end();
}
