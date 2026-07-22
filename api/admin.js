// api/admin.js — Admin 後台查詢與管理端點。
// 驗證：Authorization: Bearer <ADMIN_PASSWORD>（環境變數，未設定即整個後台停用）。
// GET views：
//   overview            總覽（來訪數、來源分布、裝置分布、各畫面平均停留）
//   sessions?offset=0   來訪清單（每頁 50 筆，含是否留有題目與標註）
//   session?sid=xxx     單一 session 詳情（題目/選牌/報數/產出/完整訊息/各畫面停留/標註）
// POST actions（body JSON）：
//   { action:'note',   sid, note }   儲存自由文字標註（空字串＝清除）
//   { action:'delete', sid|sids[] }  刪除紀錄（清單/題目/停留/標註），並回扣聚合統計與用量
//   { action:'recalc' }              全面重算 pi:agg:bytes 用量估算（掃描所有紀錄）

import { redisPipeline, redisConfigured } from '../lib/redis.js';

const KEY_OVERHEAD = 64;
const LIMIT_BYTES = Math.max(0.01, Number(process.env.STORAGE_LIMIT_MB) || 256) * 1024 * 1024;

// 停留資料的估算大小：與寫入時的增量（100/事件）完全對稱，避免記帳漂移
function dwellBytesOf(dwell, dcnt) {
  const events = Object.values(dcnt).reduce((a, v) => a + (Number(v) || 0), 0)
    || Object.keys(dwell).length; // 舊紀錄沒有事件數：以每畫面 1 次估計
  return events * 100;
}

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
      const cleanSid = (s) => String(s || '').slice(0, 16).replace(/[^\w-]/g, '');
      const sid = cleanSid(body && body.sid);

      if (action === 'note') {
        if (!sid) { res.status(400).json({ ok: false, error: 'bad_sid' }); return; }
        const note = String(body.note || '').trim().slice(0, 300);
        const [oldR] = await redisPipeline([['STRLEN', `pi:note:${sid}`]]);
        const oldLen = Number(oldR.result || 0);
        const oldSize = oldLen ? oldLen + KEY_OVERHEAD : 0;
        const newSize = note ? note.length + KEY_OVERHEAD : 0;
        await redisPipeline([
          note ? ['SET', `pi:note:${sid}`, note] : ['DEL', `pi:note:${sid}`],
          ['INCRBY', 'pi:agg:bytes', String(newSize - oldSize)],
        ]);
        res.status(200).json({ ok: true, note });
        return;
      }

      if (action === 'recalc') {
        // 全面重算用量估算（掃描所有紀錄；分批查詢避免單次 pipeline 過大）
        const [listR] = await redisPipeline([['LRANGE', 'pi:sessions', '0', '-1']]);
        const raws = (listR.result || []).slice(0, 10000);
        let bytes = 0;
        for (const raw of raws) bytes += raw.length + 16;
        const sids2 = raws.map((r) => (parseJSON(r, {}) || {}).sid).filter(Boolean);
        for (let i = 0; i < sids2.length; i += 100) {
          const chunk = sids2.slice(i, i + 100);
          const reads = await redisPipeline(chunk.flatMap((s) => [
            ['STRLEN', `pi:journey:${s}`],
            ['HGETALL', `pi:dwell:${s}`],
            ['HGETALL', `pi:dwellcnt:${s}`],
            ['STRLEN', `pi:note:${s}`],
            ['STRLEN', `pi:prompt:${s}`],
          ]));
          chunk.forEach((s, j) => {
            const jLen = Number(reads[j * 5].result || 0);
            if (jLen) bytes += jLen + KEY_OVERHEAD;
            const toObj2 = (arr) => {
              const o = {}; const a = arr || [];
              for (let k = 0; k < a.length; k += 2) o[a[k]] = a[k + 1];
              return o;
            };
            bytes += dwellBytesOf(toObj2(reads[j * 5 + 1].result), toObj2(reads[j * 5 + 2].result));
            const nLen = Number(reads[j * 5 + 3].result || 0);
            if (nLen) bytes += nLen + KEY_OVERHEAD;
            const pLen = Number(reads[j * 5 + 4].result || 0);
            if (pLen) bytes += pLen + KEY_OVERHEAD;
          });
        }
        await redisPipeline([['SET', 'pi:agg:bytes', String(Math.round(bytes))]]);
        res.status(200).json({ ok: true, bytes: Math.round(bytes) });
        return;
      }

      if (action === 'delete') {
        // 支援單筆（sid）或批次（sids[]，上限 100）
        const sids = (Array.isArray(body.sids) ? body.sids : [sid])
          .map(cleanSid).filter(Boolean).slice(0, 100);
        if (!sids.length) { res.status(400).json({ ok: false, error: 'bad_sid' }); return; }

        // 找出清單中各 sid 的原始字串（LREM 需要完整值）
        const [listR] = await redisPipeline([['LRANGE', 'pi:sessions', '0', '-1']]);
        const rawBySid = new Map();
        for (const raw of listR.result || []) {
          const p = parseJSON(raw, null);
          if (p && sids.includes(p.sid)) rawBySid.set(p.sid, raw);
        }

        // 讀取各筆的停留數據與大小，供回扣統計與用量
        const STRIDE = 5;
        const reads = await redisPipeline(sids.flatMap((s) => [
          ['HGETALL', `pi:dwell:${s}`],
          ['HGETALL', `pi:dwellcnt:${s}`],
          ['STRLEN', `pi:journey:${s}`],
          ['STRLEN', `pi:note:${s}`],
          ['STRLEN', `pi:prompt:${s}`],
        ]));
        const toObj = (arr) => {
          const o = {}; const a = arr || [];
          for (let i = 0; i < a.length; i += 2) o[a[i]] = Number(a[i + 1]);
          return o;
        };

        const cmds = [];
        let removed = 0;
        let freed = 0;
        sids.forEach((s, i) => {
          const raw = rawBySid.get(s);
          if (raw) {
            const entry = parseJSON(raw, {});
            cmds.push(['LREM', 'pi:sessions', '1', raw]);
            if (entry.src) cmds.push(['HINCRBY', 'pi:agg:src', entry.src, '-1']);
            if (entry.device) cmds.push(['HINCRBY', 'pi:agg:device', entry.device, '-1']);
            freed += raw.length + 16;
            removed++;
          }
          const dwell = toObj(reads[i * STRIDE].result), dcnt = toObj(reads[i * STRIDE + 1].result);
          for (const [screen, ms] of Object.entries(dwell)) {
            cmds.push(['HINCRBY', 'pi:agg:dwell_sum', screen, String(-Math.round(ms))]);
            // 舊紀錄可能沒有事件數：以 1 估計，避免平均值分母永不下降
            cmds.push(['HINCRBY', 'pi:agg:dwell_cnt', screen, String(-(dcnt[screen] || 1))]);
          }
          freed += dwellBytesOf(dwell, dcnt);
          const jLen = Number(reads[i * STRIDE + 2].result || 0);
          if (jLen) freed += jLen + KEY_OVERHEAD;
          const nLen = Number(reads[i * STRIDE + 3].result || 0);
          if (nLen) freed += nLen + KEY_OVERHEAD;
          const pLen = Number(reads[i * STRIDE + 4].result || 0);
          if (pLen) freed += pLen + KEY_OVERHEAD;
          cmds.push(
            ['DEL', `pi:journey:${s}`],
            ['DEL', `pi:dwell:${s}`],
            ['DEL', `pi:dwellcnt:${s}`],
            ['DEL', `pi:note:${s}`],
            ['DEL', `pi:prompt:${s}`],
          );
        });
        cmds.push(['INCRBY', 'pi:agg:bytes', String(-Math.round(freed))]);
        await redisPipeline(cmds);
        res.status(200).json({ ok: true, removed });
        return;
      }

      res.status(400).json({ ok: false, error: 'bad_action' });
      return;
    }

    if (view === 'overview') {
      const [srcR, devR, sumR, cntR, lenR, bytesR, prunedR, prunedAtR] = await redisPipeline([
        ['HGETALL', 'pi:agg:src'],
        ['HGETALL', 'pi:agg:device'],
        ['HGETALL', 'pi:agg:dwell_sum'],
        ['HGETALL', 'pi:agg:dwell_cnt'],
        ['LLEN', 'pi:sessions'],
        ['GET', 'pi:agg:bytes'],
        ['GET', 'pi:agg:pruned'],
        ['GET', 'pi:agg:pruned_at'],
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
      const bytes = Math.max(0, Number(bytesR.result || 0));
      res.status(200).json({
        ok: true,
        totalSessions: Number(lenR.result || 0),
        sources: toObj(srcR.result),
        devices: toObj(devR.result),
        dwellAvgMs: dwellAvg,
        usage: {
          bytes,
          limitBytes: LIMIT_BYTES,
          pct: Math.min(100, +((bytes / LIMIT_BYTES) * 100).toFixed(2)),
          prunedTotal: Number(prunedR.result || 0),
          prunedAt: Number(prunedAtR.result || 0) || null,
        },
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
      const [jR, dR, nR, pR] = await redisPipeline([
        ['GET', `pi:journey:${sid}`],
        ['HGETALL', `pi:dwell:${sid}`],
        ['GET', `pi:note:${sid}`],
        ['GET', `pi:prompt:${sid}`],
      ]);
      const dwell = {};
      const da = dR.result || [];
      for (let i = 0; i < da.length; i += 2) dwell[da[i]] = Number(da[i + 1]);
      res.status(200).json({
        ok: true,
        journey: jR.result ? parseJSON(jR.result, null) : null,
        dwellMs: dwell,
        note: nR.result || '',
        prompt: pR.result ? parseJSON(pR.result, null) : null,
      });
      return;
    }

    if (view === 'sysprompt') {
      const hash = String(url.searchParams.get('hash') || '').slice(0, 16).replace(/[^\w]/g, '');
      if (!hash) { res.status(400).json({ ok: false, error: 'bad_hash' }); return; }
      const [r] = await redisPipeline([['GET', `pi:sysprompt:${hash}`]]);
      res.status(200).json({ ok: true, content: r.result || null });
      return;
    }

    res.status(400).json({ ok: false, error: 'bad_view' });
  } catch (e) {
    res.status(500).json({ ok: false, error: 'storage_error' });
  }
}
