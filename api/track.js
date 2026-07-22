// api/track.js — 匿名埋點收集端點（sendBeacon POST）。
// 事件：start（來訪：來源/UTM/裝置）、dwell（頁面停留）、journey（題目與產出）。
// 寫入 Upstash Redis；未設定儲存後端時回 204 靜默丟棄。永不回傳錯誤內容給前端。
//
// 資料模型（鍵一律 90 天過期，來訪清單保留最近 5000 筆）：
//   pi:sessions            LIST  最近來訪（JSON：sid/vid/ts/src/device/os）
//   pi:dwell:<sid>         HASH  各畫面停留毫秒累計
//   pi:journey:<sid>       STRING JSON（opening/cards/numbers/title/offline/ts）
//   pi:agg:src             HASH  來源 → 次數
//   pi:agg:device          HASH  裝置 → 次數
//   pi:agg:dwell_sum/_cnt  HASH  畫面 → 停留毫秒總和／次數（算平均用）

import { redisPipeline, redisConfigured } from '../lib/redis.js';

// 保存天數：環境變數 DATA_RETENTION_DAYS 可調（預設 365 天）
const RETENTION_DAYS = Math.max(1, Number(process.env.DATA_RETENTION_DAYS) || 365);
const TTL = RETENTION_DAYS * 24 * 3600;
const MAX_SESSIONS = 5000; // 來訪清單上限（超過自動汰舊）

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

    if (body.type === 'start') {
      const { device, os } = parseDevice(req.headers['user-agent']);
      const src = parseSource(body.ref, body.utm);
      const entry = JSON.stringify({
        sid, vid, ts: Date.now(), src, device, os,
        lang: String(body.lang || '').slice(0, 12),
      });
      cmds.push(
        ['LPUSH', 'pi:sessions', entry],
        ['LTRIM', 'pi:sessions', '0', String(MAX_SESSIONS - 1)],
        ['HINCRBY', 'pi:agg:src', src, '1'],
        ['HINCRBY', 'pi:agg:device', device, '1'],
      );
    } else if (body.type === 'dwell') {
      const screen = String(body.screen || '');
      const ms = Math.min(Math.max(0, Number(body.ms) || 0), 3600_000);
      if (!SCREENS.includes(screen) || ms < 400) { res.end(); return; }
      cmds.push(
        ['HINCRBY', `pi:dwell:${sid}`, screen, String(Math.round(ms))],
        ['EXPIRE', `pi:dwell:${sid}`, String(TTL)],
        // 各畫面事件數（供後台刪除紀錄時精準回扣平均值統計）
        ['HINCRBY', `pi:dwellcnt:${sid}`, screen, '1'],
        ['EXPIRE', `pi:dwellcnt:${sid}`, String(TTL)],
        ['HINCRBY', 'pi:agg:dwell_sum', screen, String(Math.round(ms))],
        ['HINCRBY', 'pi:agg:dwell_cnt', screen, '1'],
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
      });
      cmds.push(
        ['SET', `pi:journey:${sid}`, journey, 'EX', String(TTL)],
      );
    } else {
      res.end(); return;
    }

    await redisPipeline(cmds);
  } catch { /* 埋點失敗靜默 */ }
  res.end();
}
