// api/admin.js — Admin 後台查詢端點。
// 驗證：Authorization: Bearer <ADMIN_PASSWORD>（環境變數，未設定即整個後台停用）。
// views：
//   overview            總覽（來訪數、來源分布、裝置分布、各畫面平均停留）
//   sessions?offset=0   來訪清單（每頁 50 筆，含各 session 是否留有題目）
//   session?sid=xxx     單一 session 詳情（題目/選牌/報數/產出標題/各畫面停留）

import { redisPipeline, redisConfigured } from '../lib/redis.js';

// 防暴力嘗試：每 IP 每小時最多 60 次未授權嘗試
const RATE = new Map();
function rateLimited(ip) {
  const now = Date.now();
  const hits = (RATE.get(ip) || []).filter((t) => t > now - 3600_000);
  hits.push(now);
  RATE.set(ip, hits);
  return hits.length > 60;
}

function authorized(req) {
  const pw = process.env.ADMIN_PASSWORD;
  if (!pw) return false;
  const header = String(req.headers.authorization || '');
  return header === 'Bearer ' + pw;
}

function parseJSON(s, fallback) {
  try { return JSON.parse(s); } catch { return fallback; }
}

export default async function handler(req, res) {
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';

  if (!process.env.ADMIN_PASSWORD) {
    res.status(503).json({ ok: false, error: 'admin_disabled' }); // 未設 ADMIN_PASSWORD
    return;
  }
  if (!redisConfigured()) {
    res.status(503).json({ ok: false, error: 'storage_not_configured' });
    return;
  }
  if (!authorized(req)) {
    if (rateLimited(ip)) { res.status(429).json({ ok: false, error: 'rate_limited' }); return; }
    res.status(401).json({ ok: false, error: 'unauthorized' });
    return;
  }

  const url = new URL(req.url, 'http://x');
  const view = url.searchParams.get('view') || 'overview';

  try {
    if (view === 'overview') {
      const [srcR, devR, sumR, cntR, lenR] = await redisPipeline([
        ['HGETALL', 'pi:agg:src'],
        ['HGETALL', 'pi:agg:device'],
        ['HGETALL', 'pi:agg:dwell_sum'],
        ['HGETALL', 'pi:agg:dwell_cnt'],
        ['LLEN', 'pi:sessions'],
      ]);
      const toObj = (arr) => {
        const o = {};
        const a = arr || [];
        for (let i = 0; i < a.length; i += 2) o[a[i]] = Number(a[i + 1]);
        return o;
      };
      const sum = toObj(sumR.result), cnt = toObj(cntR.result);
      const dwellAvg = {};
      for (const k of Object.keys(sum)) dwellAvg[k] = cnt[k] ? Math.round(sum[k] / cnt[k]) : 0;
      res.status(200).json({
        ok: true,
        totalSessions: Number(lenR.result || 0),
        sources: toObj(srcR.result),
        devices: toObj(devR.result),
        dwellAvgMs: dwellAvg,
      });
      return;
    }

    if (view === 'sessions') {
      const offset = Math.max(0, Number(url.searchParams.get('offset')) || 0);
      const [listR] = await redisPipeline([
        ['LRANGE', 'pi:sessions', String(offset), String(offset + 49)],
      ]);
      const sessions = (listR.result || []).map((s) => parseJSON(s, null)).filter(Boolean);
      // 附註每筆是否留有題目（journey）
      if (sessions.length) {
        const jr = await redisPipeline(sessions.map((s) => ['EXISTS', `pi:journey:${s.sid}`]));
        sessions.forEach((s, i) => { s.hasJourney = jr[i].result === 1; });
      }
      res.status(200).json({ ok: true, offset, sessions });
      return;
    }

    if (view === 'session') {
      const sid = String(url.searchParams.get('sid') || '').slice(0, 16).replace(/[^\w-]/g, '');
      if (!sid) { res.status(400).json({ ok: false, error: 'bad_sid' }); return; }
      const [jR, dR] = await redisPipeline([
        ['GET', `pi:journey:${sid}`],
        ['HGETALL', `pi:dwell:${sid}`],
      ]);
      const dwell = {};
      const da = dR.result || [];
      for (let i = 0; i < da.length; i += 2) dwell[da[i]] = Number(da[i + 1]);
      res.status(200).json({
        ok: true,
        journey: jR.result ? parseJSON(jR.result, null) : null,
        dwellMs: dwell,
      });
      return;
    }

    res.status(400).json({ ok: false, error: 'bad_view' });
  } catch (e) {
    res.status(500).json({ ok: false, error: 'storage_error' });
  }
}
