// api/track.js — 匿名埋點收集端點（sendBeacon POST）。
// 事件：start（來訪：來源/UTM/裝置）、dwell（頁面停留）、journey（題目與產出）。
// 寫入 Upstash Redis；未設定儲存後端時回 204 靜默丟棄。永不回傳錯誤內容給前端。
//
// 保存策略：資料不設時間過期。以 pi:agg:bytes 估算目前用量（邏輯大小＋每鍵固定開銷），
// 當用量超過容量上限（STORAGE_LIMIT_MB，預設 256MB＝Upstash 免費方案）的 95% 時，
// 自動從最舊的來訪開始刪除（含其題目/停留/標註，並回扣統計），使用量維持在 95% 以下；
// 汰舊次數與時間記錄於 pi:agg:pruned / pi:agg:pruned_at，供後台警示。
//
// 資料模型：
//   pi:sessions            LIST  來訪（JSON：sid/vid/ts/src/device/os），新的在左、舊的在右
//   pi:dwell:<sid>         HASH  各畫面停留毫秒累計
//   pi:dwellcnt:<sid>      HASH  各畫面停留事件數（刪除時精準回扣平均值）
//   pi:journey:<sid>       STRING JSON（opening/cards/numbers/title/message/closing/offline/ts）
//   pi:agg:src / device    HASH  來源/裝置 → 次數
//   pi:agg:dwell_sum/_cnt  HASH  畫面 → 停留毫秒總和／次數
//   pi:agg:bytes           STRING 估算用量（bytes）
//   pi:agg:pruned(_at)     STRING 自動汰舊累計筆數／最近一次時間

import { redisPipeline, redisConfigured } from '../lib/redis.js';

const KEY_OVERHEAD = 64; // 每鍵估算固定開銷（bytes）
const LIMIT_BYTES = Math.max(0.01, Number(process.env.STORAGE_LIMIT_MB) || 256) * 1024 * 1024;
const PRUNE_TARGET = 0.95;

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
  const reads = await redisPipeline(entries.flatMap((e) => [
    ['STRLEN', `pi:journey:${e.sid}`],
    ['HGETALL', `pi:dwell:${e.sid}`],
    ['HGETALL', `pi:dwellcnt:${e.sid}`],
    ['STRLEN', `pi:note:${e.sid}`],
  ]));

  const cmds = [];
  let freed = 0;
  entries.forEach((e, i) => {
    freed += e.raw.length + 16;
    const jLen = Number(reads[i * 4].result || 0);
    if (jLen) freed += jLen + KEY_OVERHEAD;
    const dwell = toObj(reads[i * 4 + 1].result);
    const dcnt = toObj(reads[i * 4 + 2].result);
    freed += dwellBytes(dwell, dcnt);
    const nLen = Number(reads[i * 4 + 3].result || 0);
    if (nLen) freed += nLen + KEY_OVERHEAD;

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

// 用量超過上限的 95% 時自動汰舊。
// 優先刪除「未完成（沒有留下題目）」的紀錄（由最舊往新掃描）；
// 仍不足時，才從最舊的完成紀錄開始刪除。
async function maybePrune() {
  const [bR] = await redisPipeline([['GET', 'pi:agg:bytes']]);
  let bytes = Number(bR.result || 0);
  const target = LIMIT_BYTES * PRUNE_TARGET;
  if (bytes <= target) return;

  // 第一階段：未完成優先（掃描最舊的 300 筆，找出沒有 journey 的）
  const [tailR] = await redisPipeline([['LRANGE', 'pi:sessions', '-300', '-1']]);
  const tail = (tailR.result || []).map(parseEntry).reverse(); // 最舊在前
  if (tail.length) {
    const exists = await redisPipeline(tail.map((e) => ['EXISTS', `pi:journey:${e.sid}`]));
    const incompletes = tail.filter((e, i) => exists[i].result !== 1);
    for (let i = 0; i < incompletes.length && bytes > target; i += 20) {
      bytes -= await removeEntries(incompletes.slice(i, i + 20), true);
    }
  }

  // 第二階段：仍超標 → 從最舊的紀錄（含完成的）開始刪
  for (let round = 0; round < 3 && bytes > target; round++) {
    const [popR] = await redisPipeline([['RPOP', 'pi:sessions', '20']]);
    const raws = popR.result || [];
    if (!raws.length) break;
    bytes -= await removeEntries(raws.map(parseEntry), false);
  }
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
        cards: Array.isArray(body.cards) ? body.cards.slice(0, 9).map((c) => String(c).slice(0, 8)) : [],
        numbers: Array.isArray(body.numbers) ? body.numbers.slice(0, 3).map(Number) : null,
        title: String(body.title || '').slice(0, 60),
        message: String(body.message || '').slice(0, 2000), // 完整靈感訊息輸出
        closing: String(body.closing || '').slice(0, 100),
        offline: !!body.offline,
        astroUsed: !!body.astroUsed,
        astroSun: String(body.astroSun || '').slice(0, 8),
      });
      cmds.push(
        ['SET', `pi:journey:${sid}`, journey],
        ['INCRBY', 'pi:agg:bytes', String(journey.length + KEY_OVERHEAD)],
      );
    } else {
      res.end(); return;
    }

    await redisPipeline(cmds);
    if (checkPrune) await maybePrune();
  } catch { /* 埋點失敗靜默 */ }
  res.end();
}
