// api/admin.js — Admin 後台查詢與管理端點。
// 驗證：Authorization: Bearer <ADMIN_PASSWORD>（環境變數，未設定即整個後台停用）。
// GET views：
//   overview            總覽（來訪數、來源分布、裝置分布、各畫面平均停留）
//   sessions?offset=0   來訪清單（每頁 50 筆，含是否留有題目與標註）
//   session?sid=xxx     單一 session 詳情（題目/選牌/報數/產出/完整訊息/各畫面停留/標註）
// POST actions（body JSON）：
//   { action:'note',   sid, note }   儲存自由文字標註（空字串＝清除）
//   { action:'delete', sid }         刪除該筆紀錄（清單/題目/停留/標註），並回扣聚合統計

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
    // ---- 管理操作（POST）----
    if (req.method === 'POST') {
      let body = req.body;
      if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
      const action = body && body.action;
      const sid = String((body && body.sid) || '').slice(0, 16).replace(/[^\w-]/g, '');
      if (!sid) { res.status(400).json({ ok: false, error: 'bad_sid' }); return; }

      if (action === 'note') {
        const ttl = Math.max(1, Number(process.env.DATA_RETENTION_DAYS) || 365) * 24 * 3600;
        const note = String(body.note || '').trim().slice(0, 300);
        await redisPipeline(note
          ? [['SET', `pi:note:${sid}`, note, 'EX', String(ttl)]]
          : [['DEL', `pi:note:${sid}`]]);
        res.status(200).json({ ok: true, note });
        return;
      }

      if (action === 'delete') {
        // 找出清單中該 sid 的原始字串（LREM 需要完整值）
        const [listR] = await redisPipeline([['LRANGE', 'pi:sessions', '0', '4999']]);
        const raw = (listR.result || []).find((s) => {
          const p = parseJSON(s, null);
          return p && p.sid === sid;
        });

        // 讀取該筆的停留數據，供回扣平均值統計
        const [dwellR, cntR] = await redisPipeline([
          ['HGETALL', `pi:dwell:${sid}`],
          ['HGETALL', `pi:dwellcnt:${sid}`],
        ]);
        const toObj = (arr) => {
          const o = {}; const a = arr || [];
          for (let i = 0; i < a.length; i += 2) o[a[i]] = Number(a[i + 1]);
          return o;
        };
        const dwell = toObj(dwellR.result), dcnt = toObj(cntR.result);

        const cmds = [];
        if (raw) {
          const entry = parseJSON(raw, {});
          cmds.push(['LREM', 'pi:sessions', '1', raw]);
          if (entry.src) cmds.push(['HINCRBY', 'pi:agg:src', entry.src, '-1']);
          if (entry.device) cmds.push(['HINCRBY', 'pi:agg:device', entry.device, '-1']);
        }
        for (const [screen, ms] of Object.entries(dwell)) {
          cmds.push(['HINCRBY', 'pi:agg:dwell_sum', screen, String(-Math.round(ms))]);
          // 舊紀錄可能沒有事件數：以 1 估計，避免平均值分母永不下降
          cmds.push(['HINCRBY', 'pi:agg:dwell_cnt', screen, String(-(dcnt[screen] || 1))]);
        }
        cmds.push(
          ['DEL', `pi:journey:${sid}`],
          ['DEL', `pi:dwell:${sid}`],
          ['DEL', `pi:dwellcnt:${sid}`],
          ['DEL', `pi:note:${sid}`],
        );
        await redisPipeline(cmds);
        res.status(200).json({ ok: true, removed: !!raw });
        return;
      }

      res.status(400).json({ ok: false, error: 'bad_action' });
      return;
    }

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
      // 附註每筆是否留有題目（journey）與標註內容
      if (sessions.length) {
        const extras = await redisPipeline(sessions.flatMap((s) => [
          ['EXISTS', `pi:journey:${s.sid}`],
          ['GET', `pi:note:${s.sid}`],
        ]));
        sessions.forEach((s, i) => {
          s.hasJourney = extras[i * 2].result === 1;
          s.note = extras[i * 2 + 1].result || '';
        });
      }
      res.status(200).json({ ok: true, offset, sessions });
      return;
    }

    if (view === 'session') {
      const sid = String(url.searchParams.get('sid') || '').slice(0, 16).replace(/[^\w-]/g, '');
      if (!sid) { res.status(400).json({ ok: false, error: 'bad_sid' }); return; }
      const [jR, dR, nR] = await redisPipeline([
        ['GET', `pi:journey:${sid}`],
        ['HGETALL', `pi:dwell:${sid}`],
        ['GET', `pi:note:${sid}`],
      ]);
      const dwell = {};
      const da = dR.result || [];
      for (let i = 0; i < da.length; i += 2) dwell[da[i]] = Number(da[i + 1]);
      res.status(200).json({
        ok: true,
        journey: jR.result ? parseJSON(jR.result, null) : null,
        dwellMs: dwell,
        note: nR.result || '',
      });
      return;
    }

    res.status(400).json({ ok: false, error: 'bad_view' });
  } catch (e) {
    res.status(500).json({ ok: false, error: 'storage_error' });
  }
}
