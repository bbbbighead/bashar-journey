// api/admin.js — Admin 後台查詢與管理端點。
// 驗證：Authorization: Bearer <ADMIN_PASSWORD>（環境變數，未設定即整個後台停用）。
// GET views：
//   overview            總覽（來訪數、來源分布、裝置分布、各畫面平均停留）
//   sessions?offset=0   來訪清單（每頁 50 筆，含題目前段、是否留有題目、標註與回饋星等）
//   session?sid=xxx     單一 session 詳情（題目/選牌/報數/產出/完整訊息/各畫面停留/標註/回饋）
//   feedback?limit=200  使用者回饋清單（新到舊）＋筆數、平均星等與分布
//   timings?limit=200   處理時間清單（新到舊）＋各階段的中位數與 P90
//   oracles?limit=50    專屬靈感牌卡清單（新到舊）：挑中的牌與原因、卡面、譯文、牌義、圖像 prompt
//   oracleimg?id=xxx[&kind=art]  單張牌卡的存檔圖：合成卡，或圖像模型的原始 artwork
//   oracleprompt?id=xxx 那一張卡實際送給模型的原始 prompt（文字 system＋user、圖像）
//   oracleswitch        專屬靈感牌卡的總開關現況（enabled／是誰在決定）
// POST actions（body JSON）：
//   { action:'oracleswitch', on }    即時開關專屬靈感牌卡（存 Redis，不必重新部署）
//   { action:'note',   sid, note }   儲存自由文字標註（空字串＝清除）
//   { action:'delete', sid|sids[] }  刪除紀錄（清單/題目/停留/標註），並回扣聚合統計與用量
//   { action:'recalc' }              全面重算 pi:agg:bytes 用量估算（掃描所有紀錄）

import { redisPipeline, redisConfigured } from '../lib/redis.js';
import { chatComplete, llmConfigured } from '../lib/llm.js';
// 圖像模型收到的收尾約束是程式接上去的，不在模型寫的 prompt 裡。後台要顯示「實際
// 送出去的完整 prompt」就得把它接回來，否則看起來像少了那些禁令。
import { IMAGE_SUFFIX } from '../prompts/oracle.js';

// 專屬靈感牌卡的總開關：站主在後台切，值存在 Redis，api/oracle.js 每次請求都讀。
// 讀不到（沒設定過、或 Redis 掛了）一律當關閉——誤關只是少賣一張卡，誤開會花錢。
async function oracleSwitchStored() {
  if (!redisConfigured()) return false;
  try {
    const [r] = await redisPipeline([['GET', 'pi:oracleon']]);
    return r && r.result != null ? !/^(0|false|off|no)$/i.test(String(r.result).trim()) : false;
  } catch {
    return false;
  }
}

const KEY_OVERHEAD = 64;
const LIMIT_BYTES = Math.max(0.01, Number(process.env.STORAGE_LIMIT_MB) || 256) * 1024 * 1024;

// 停留資料的估算大小：與寫入時的增量（100/事件）完全對稱，避免記帳漂移
function dwellBytesOf(dwell, dcnt) {
  const events = Object.values(dcnt).reduce((a, v) => a + (Number(v) || 0), 0)
    || Object.keys(dwell).length; // 舊紀錄沒有事件數：以每畫面 1 次估計
  return events * 100;
}

// 訪客統計。vid 認的是「同一個瀏覽器」而不是「同一個人」：換裝置、換瀏覽器、
// 無痕、清資料，以及 iOS Safari 的 ITP（7 天未回訪就清掉 localStorage）都會斷掉，
// 所以「回訪」算出來的是**下限**，真實回訪一定比這個數字多。
// 反向誤差也有：共用裝置會把不同人併成同一個 vid。
// 依某個欄位分組計數。缺值歸到「（未知）」而不是丟掉——舊紀錄可能沒有那個
// 欄位，靜靜不計會讓總數對不上，看起來像資料掉了。
function tally(entries, field) {
  const out = {};
  for (const e of entries || []) {
    const k = (e && e[field]) ? String(e[field]) : '(unknown)';
    out[k] = (out[k] || 0) + 1;
  }
  return out;
}

// 最近 30 天的每日來訪：次數＋不重複訪客數。
// tzMin＝前端的時區（分鐘，東為正）：日界要照站主看報表的當地時間切，
// 用 UTC 切的話台灣早上八點前的來訪會被記到「昨天」。
function dailySeries(entries, tzMin) {
  const off = Number.isFinite(tzMin) ? Math.max(-840, Math.min(840, tzMin)) : 0;
  const dayOf = (ts) => Math.floor((ts + off * 60000) / 86400000);
  const today = dayOf(Date.now());
  const first = today - 29;
  const days = Array.from({ length: 30 }, (_, i) => ({ d: first + i, visits: 0, vids: new Set() }));
  for (const e of entries) {
    const i = dayOf(Number(e.ts) || 0) - first;
    if (i >= 0 && i < 30) { days[i].visits += 1; if (e.vid) days[i].vids.add(e.vid); }
  }
  return days.map((x) => ({
    day: new Date(x.d * 86400000).toISOString().slice(0, 10),   // d 已是「當地日」序號
    visits: x.visits, visitors: x.vids.size,
  }));
}

function visitorStats(entries) {
  const perVid = new Map();
  for (const e of entries) {
    if (e && e.vid) perVid.set(e.vid, (perVid.get(e.vid) || 0) + 1);
  }
  const unique = perVid.size;
  let returning = 0;
  for (const n of perVid.values()) if (n > 1) returning += 1;
  return {
    unique,
    returning,
    repeatPct: unique ? +((returning / unique) * 100).toFixed(1) : 0,
  };
}

// 每筆來訪是「這位訪客的第幾次」（1＝最早的一次）。
// 刻意依 ts 排序而不是依清單位置推算：序數是對「時間先後」的斷言，
// 綁在清單順序上是隱性耦合——只要有一筆順序不對（補寫的紀錄、時鐘偏移），
// 標出來的次數就會默默錯掉。
function visitOrdinals(entries) {
  const byVid = new Map();
  for (const e of entries) {
    if (!e || !e.sid || !e.vid) continue;
    if (!byVid.has(e.vid)) byVid.set(e.vid, []);
    byVid.get(e.vid).push(e);
  }
  const out = new Map();   // sid → { visitNo, visitTotal }
  for (const list of byVid.values()) {
    list.sort((a, b) => (Number(a.ts) || 0) - (Number(b.ts) || 0));  // 舊 → 新
    list.forEach((e, i) => out.set(e.sid, { visitNo: i + 1, visitTotal: list.length }));
  }
  // 沒有 vid 的紀錄（極舊的資料）一律當單次
  for (const e of entries) {
    if (e && e.sid && !out.has(e.sid)) out.set(e.sid, { visitNo: 1, visitTotal: 1 });
  }
  return out;
}

const scopeOf = (url) => {
  const s = url.searchParams.get('scope');
  return ['complete', 'incomplete', 'all'].includes(s) ? s : 'complete';
};

// 依資料範圍過濾來訪紀錄。complete／incomplete 要看「有沒有留下題目」，
// 所以得逐筆問 pi:journey 是否存在。
// onlyVids：只在乎這幾個訪客時就先砍掉其他人，EXISTS 的次數會少很多
// （一頁 50 筆最多 50 個 vid，通常遠少於整份清單）。
async function inScope(entries, scope, onlyVids) {
  const pool = onlyVids && onlyVids.size
    ? entries.filter((e) => e && onlyVids.has(e.vid))
    : entries.filter(Boolean);
  if (scope === 'all') return pool;
  const out = [];
  for (let i = 0; i < pool.length; i += 200) {
    const chunk = pool.slice(i, i + 200);
    const flags = await redisPipeline(chunk.map((e) => ['EXISTS', `pi:journey:${e.sid}`]));
    chunk.forEach((e, j) => {
      const has = flags[j].result === 1;
      if ((scope === 'complete') === has) out.push(e);
    });
  }
  return out;
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

// i18n 有的語系。維護動作只接受這幾個值，避免打錯字寫進一堆無效語系。
const LANGS = ['zh-Hant', 'en', 'ja', 'ko'];

// 以 SCAN 列出符合樣式的所有鍵（Upstash REST 支援 SCAN）。
// 用於容量重算：來訪清單是唯一索引，掃不到的附屬資料只能靠 SCAN 找出來。
async function scanKeys(pattern, maxRounds = 60) {
  const keys = [];
  let cursor = '0';
  for (let round = 0; round < maxRounds; round++) {
    const [r] = await redisPipeline([['SCAN', cursor, 'MATCH', pattern, 'COUNT', '500']]);
    const out = r && r.result ? r.result : [];
    cursor = String(out[0] == null ? '0' : out[0]);
    for (const k of (out[1] || [])) keys.push(String(k));
    if (cursor === '0') break;
  }
  return keys;
}

// 單筆來訪的附屬資料前綴（皆以 sid 結尾）
const PER_SID_PREFIXES = ['pi:journey:', 'pi:dwell:', 'pi:dwellcnt:', 'pi:note:', 'pi:prompt:', 'pi:fb:', 'pi:timing:'];

// 刪掉沒有主人的附屬資料：來訪紀錄已不在清單中，附屬鍵卻還留著。
// 這類資料讀不到也算不到，只會讓用量估算虛高——重算時一併清除。
async function removeOrphanKeys(liveSids) {
  let removed = 0;
  for (const prefix of PER_SID_PREFIXES) {
    const orphans = (await scanKeys(prefix + '*')).filter((k) => !liveSids.has(k.slice(prefix.length)));
    for (let i = 0; i < orphans.length; i += 50) {
      const chunk = orphans.slice(i, i + 50);
      const cmds = chunk.map((k) => ['DEL', k]);
      // 回饋與計時各另有一份在清單裡，要用原始字串才能移除
      const listKey = prefix === 'pi:fb:' ? 'pi:feedback' : prefix === 'pi:timing:' ? 'pi:timings' : '';
      if (listKey) {
        const vals = await redisPipeline(chunk.map((k) => ['GET', k]));
        vals.forEach((v) => { if (v && v.result) cmds.push(['LREM', listKey, '1', v.result]); });
      }
      await redisPipeline(cmds);
      removed += chunk.length;
    }
  }
  return removed;
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

      // 專屬靈感牌卡的總開關。即時生效：api/oracle.js 每次請求都讀這個值，
      // 所以按下去之後下一個使用者就是新的狀態，不必改程式也不必重新部署。
      // 環境變數 ORACLE_ENABLED 有設的話它贏，這裡就拒絕——否則畫面上按了沒反應，
      // 站主會以為壞掉。
      if (action === 'oracleswitch') {
        const envRaw = process.env.ORACLE_ENABLED;
        if (envRaw != null && String(envRaw).trim() !== '') {
          res.status(409).json({ ok: false, error: 'env_override' });
          return;
        }
        if (!redisConfigured()) { res.status(503).json({ ok: false, error: 'no_redis' }); return; }
        const on = body.on === true || body.on === 1 || body.on === '1';
        await redisPipeline([['SET', 'pi:oracleon', on ? '1' : '0']]);
        res.status(200).json({ ok: true, enabled: on, source: 'redis' });
        return;
      }

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

      // 訪客標註：vid → 「這是誰」的對照（例如「我自己」「測試員小林」）。
      // 存成一個 hash（pi:vidlabels），而不是每個 vid 一支 key——整份對照表
      // 每次列清單都要整張讀回來，一個 HGETALL 比幾十個 GET 便宜得多。
      // 空字串＝清除標註。
      if (action === 'vid_label') {
        const vid = String(body.vid || '').slice(0, 16).replace(/[^\w-]/g, '');
        if (!vid) { res.status(400).json({ ok: false, error: 'bad_vid' }); return; }
        const label = String(body.label || '').trim().slice(0, 40);
        const [oldR] = await redisPipeline([['HGET', 'pi:vidlabels', vid]]);
        const old = oldR.result ? String(oldR.result) : '';
        const size = (v) => (v ? vid.length + v.length + 8 : 0); // 8≈hash 欄位額外負擔
        await redisPipeline([
          label ? ['HSET', 'pi:vidlabels', vid, label] : ['HDEL', 'pi:vidlabels', vid],
          ['INCRBY', 'pi:agg:bytes', String(size(label) - size(old))],
        ]);
        res.status(200).json({ ok: true, vid, label });
        return;
      }

      // 一次性資料修正：把來訪紀錄的語言補成指定語系。
      //
      // 為什麼需要：語言欄一度記的是 navigator.language（瀏覽器系統語言）而不是
      // 實際生效的介面語言，而且 start 埋點送得比「IP 補救」和「使用者手動切換」
      // 都早，所以那段時間的紀錄有一部分是錯的。
      //
      // 兩道保護：
      //   ・預設 dryRun，先回報「會改幾筆」，確認數字才真的寫。
      //   ・before 是時間上限（毫秒）。修正的目標是「出錯那段時間的舊紀錄」，
      //     不該蓋掉修好之後正確記下來的新紀錄——所以一定要給上限，
      //     否則今天以後真的來自其他語區的人也會被改成同一個語系。
      if (action === 'backfill_lang') {
        const lang = String(body.lang || '').slice(0, 12);
        if (!LANGS.includes(lang)) { res.status(400).json({ ok: false, error: 'bad_lang' }); return; }
        const before = Number(body.before);
        if (!Number.isFinite(before) || before <= 0) {
          res.status(400).json({ ok: false, error: 'before_required' }); return;
        }
        const dryRun = body.dryRun !== false;

        const [listR] = await redisPipeline([['LRANGE', 'pi:sessions', '0', '-1']]);
        const raws = (listR.result || []).slice(0, 10000);
        const cmds = [];
        let matched = 0, changed = 0, skippedNewer = 0, delta = 0;
        const wasLang = {};
        raws.forEach((raw, i) => {
          const e = parseJSON(raw, null);
          if (!e || !e.sid) return;
          // 沒有 ts 的舊格式紀錄視為久遠（那正是最該修的一批）
          const ts = Number(e.ts) || 0;
          if (ts && ts >= before) { skippedNewer += 1; return; }
          matched += 1;
          const from = e.lang || '(unknown)';
          wasLang[from] = (wasLang[from] || 0) + 1;
          if (e.lang === lang) return;               // 已經是目標語系，不用寫
          changed += 1;
          if (!dryRun) {
            const updated = JSON.stringify({ ...e, lang });
            cmds.push(['LSET', 'pi:sessions', String(i), updated]);
            delta += updated.length - raw.length;
          }
        });

        if (!dryRun && cmds.length) {
          // LSET 用的是索引，所以中途不能有人改動清單長度。來訪只會 LPUSH 到
          // 最前面（索引位移），因此寫入前重新確認長度；不一致就中止讓人重試，
          // 也比寫錯位置好。
          const [lenR] = await redisPipeline([['LLEN', 'pi:sessions']]);
          if (Number(lenR.result || 0) !== raws.length) {
            res.status(409).json({ ok: false, error: 'list_changed_retry' }); return;
          }
          for (let i = 0; i < cmds.length; i += 100) await redisPipeline(cmds.slice(i, i + 100));
          if (delta) await redisPipeline([['INCRBY', 'pi:agg:bytes', String(Math.round(delta))]]);
        }
        res.status(200).json({
          ok: true, dryRun, lang, before,
          scanned: raws.length, matched, changed, skippedNewer, wasLang,
        });
        return;
      }

      if (action === 'recalc') {
        // 全面重算用量估算（掃描所有紀錄；分批查詢避免單次 pipeline 過大）。
        // 先清掉沒有主人的附屬資料，再重數——這樣重算後的數字就是真實用量。
        const [listR] = await redisPipeline([['LRANGE', 'pi:sessions', '0', '-1']]);
        const raws = (listR.result || []).slice(0, 10000);
        let bytes = 0;
        for (const raw of raws) bytes += raw.length + 16;
        const sids2 = raws.map((r) => (parseJSON(r, {}) || {}).sid).filter(Boolean);

        let orphansRemoved = 0;
        try {
          orphansRemoved = await removeOrphanKeys(new Set(sids2));
        } catch { /* 儲存後端不支援 SCAN：略過清理，仍照樣重算 */ }

        for (let i = 0; i < sids2.length; i += 100) {
          const chunk = sids2.slice(i, i + 100);
          const STRIDE = 7;
          const reads = await redisPipeline(chunk.flatMap((s) => [
            ['STRLEN', `pi:journey:${s}`],
            ['HGETALL', `pi:dwell:${s}`],
            ['HGETALL', `pi:dwellcnt:${s}`],
            ['STRLEN', `pi:note:${s}`],
            ['STRLEN', `pi:prompt:${s}`],
            ['STRLEN', `pi:fb:${s}`],
            ['STRLEN', `pi:timing:${s}`],
          ]));
          chunk.forEach((s, j) => {
            const jLen = Number(reads[j * STRIDE].result || 0);
            if (jLen) bytes += jLen + KEY_OVERHEAD;
            const toObj2 = (arr) => {
              const o = {}; const a = arr || [];
              for (let k = 0; k < a.length; k += 2) o[a[k]] = a[k + 1];
              return o;
            };
            bytes += dwellBytesOf(toObj2(reads[j * STRIDE + 1].result), toObj2(reads[j * STRIDE + 2].result));
            const nLen = Number(reads[j * STRIDE + 3].result || 0);
            if (nLen) bytes += nLen + KEY_OVERHEAD;
            const pLen = Number(reads[j * STRIDE + 4].result || 0);
            if (pLen) bytes += pLen + KEY_OVERHEAD;
            const fLen = Number(reads[j * STRIDE + 5].result || 0);
            if (fLen) bytes += fLen + KEY_OVERHEAD + fLen + 16; // 字串 + pi:feedback 清單各一份
            const tLen = Number(reads[j * STRIDE + 6].result || 0);
            if (tLen) bytes += tLen + KEY_OVERHEAD + tLen + 16; // 字串 + pi:timings 清單各一份
          });
        }
        // system prompt 依版本共用一份、不屬於任何單一來訪，也要計入用量
        try {
          const sysKeys = await scanKeys('pi:sysprompt:*');
          for (let i = 0; i < sysKeys.length; i += 100) {
            const reads = await redisPipeline(sysKeys.slice(i, i + 100).map((k) => ['STRLEN', k]));
            for (const r of reads) {
              const n = Number(r.result || 0);
              if (n) bytes += n + KEY_OVERHEAD;
            }
          }
        } catch { /* 不支援 SCAN：略過這一項 */ }

        await redisPipeline([['SET', 'pi:agg:bytes', String(Math.round(bytes))]]);
        res.status(200).json({ ok: true, bytes: Math.round(bytes), orphansRemoved });
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
        const STRIDE = 7;
        const reads = await redisPipeline(sids.flatMap((s) => [
          ['HGETALL', `pi:dwell:${s}`],
          ['HGETALL', `pi:dwellcnt:${s}`],
          ['STRLEN', `pi:journey:${s}`],
          ['STRLEN', `pi:note:${s}`],
          ['STRLEN', `pi:prompt:${s}`],
          ['GET', `pi:fb:${s}`], // 取全文：從 pi:feedback 清單移除需要原始字串
          ['GET', `pi:timing:${s}`],
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
          cmds.push(
            ['DEL', `pi:journey:${s}`],
            ['DEL', `pi:dwell:${s}`],
            ['DEL', `pi:dwellcnt:${s}`],
            ['DEL', `pi:note:${s}`],
            ['DEL', `pi:prompt:${s}`],
            ['DEL', `pi:fb:${s}`],
            ['DEL', `pi:timing:${s}`],
          );
        });
        cmds.push(['INCRBY', 'pi:agg:bytes', String(-Math.round(freed))]);
        await redisPipeline(cmds);
        res.status(200).json({ ok: true, removed });
        return;
      }

      if (action === 'ask') {
        // 除錯問答：把「當時實際送出的 prompt＋產出結果」餵給 LLM 當脈絡，
        // 讓管理者直接詢問某次結果是根據什麼產生的。
        if (!sid) { res.status(400).json({ ok: false, error: 'bad_sid' }); return; }
        if (!llmConfigured()) { res.status(503).json({ ok: false, error: 'llm_not_configured' }); return; }
        const history = (Array.isArray(body.messages) ? body.messages : [])
          .slice(-12)
          .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && m.content)
          .map((m) => ({ role: m.role, content: String(m.content).slice(0, 4000) }));
        if (!history.length || history[history.length - 1].role !== 'user') {
          res.status(400).json({ ok: false, error: 'bad_messages' });
          return;
        }

        const [pR, jR] = await redisPipeline([
          ['GET', `pi:prompt:${sid}`],
          ['GET', `pi:journey:${sid}`],
        ]);
        const promptRec = pR.result ? parseJSON(pR.result, null) : null;
        const journey = jR.result ? parseJSON(jR.result, null) : null;
        let sysPrompt = null;
        if (promptRec && promptRec.sysHash) {
          const [sR] = await redisPipeline([['GET', `pi:sysprompt:${promptRec.sysHash}`]]);
          sysPrompt = sR.result || null;
        }

        const context = [
          '你是「靈感訊息」平台的後台除錯助手，正在協助管理者理解一次歷史產出的來龍去脈。',
          '以下是這次來訪的完整脈絡（管理者視角，內部資料，可自由引用術語與系統名稱）：',
          '',
          '════ 當時的 System Prompt ════',
          sysPrompt || '（未留存）',
          '',
          '════ 當時實際送出的 User Prompt ════',
          promptRec ? (promptRec.prompt || '（未留存）') : '（此次來訪沒有 prompt 紀錄——可能走了離線後備、或紀錄已被刪除）',
          '',
          '════ 最終呈現給使用者的產出 ════',
          journey
            ? `標題：${journey.title || '—'}\n訊息：${journey.message || '—'}\n結語：${journey.closing || '—'}\n離線後備模式：${journey.offline ? '是（AI 呼叫失敗或未設金鑰，訊息由固定模板拼成）' : '否（AI 生成）'}`
            : '（無產出紀錄）',
          '',
          '回答時：直接、誠實、技術上準確；管理者懂這套系統，不需要對他隱藏占卜術語。',
          '若產出走了離線後備模式，請明確指出訊息內容並非由上述 prompt 生成。繁體中文回答。',
        ].join('\n');

        try {
          const out = await chatComplete({ system: context, messages: history, maxTokens: 1600 });
          res.status(200).json({ ok: true, reply: out.reply, provider: out.provider, model: out.model });
        } catch {
          res.status(502).json({ ok: false, error: 'llm_failed' });
        }
        return;
      }

      res.status(400).json({ ok: false, error: 'bad_action' });
      return;
    }

    if (view === 'overview') {
      // scope：all＝全部來訪（走全域聚合計數器）；complete／incomplete＝
      // 依「是否留有題目」即時掃描彙總，讓所有分析區塊可動態切換資料範圍。
      const scope = { all: 'all', complete: 'complete', incomplete: 'incomplete' }[url.searchParams.get('scope')] || 'all';
      const toObj = (arr) => {
        const o = {};
        const a = arr || [];
        for (let i = 0; i < a.length; i += 2) o[a[i]] = Number(a[i + 1]);
        return o;
      };

      const [bytesR, prunedR, prunedAtR] = await redisPipeline([
        ['GET', 'pi:agg:bytes'],
        ['GET', 'pi:agg:pruned'],
        ['GET', 'pi:agg:pruned_at'],
      ]);
      const bytes = Math.max(0, Number(bytesR.result || 0));
      const usage = {
        bytes,
        limitBytes: LIMIT_BYTES,
        pct: Math.min(100, +((bytes / LIMIT_BYTES) * 100).toFixed(2)),
        prunedTotal: Number(prunedR.result || 0),
        prunedAt: Number(prunedAtR.result || 0) || null,
      };

      if (scope === 'all') {
        // 來源／裝置／停留走預先累加的 pi:agg:*，但訪客數必須逐筆看 vid，
        // 所以多讀一次清單（單一 LRANGE，比 complete 那條路徑的 N 次 EXISTS 便宜）
        const [srcR, devR, sumR, cntR, lenR, listR] = await redisPipeline([
          ['HGETALL', 'pi:agg:src'],
          ['HGETALL', 'pi:agg:device'],
          ['HGETALL', 'pi:agg:dwell_sum'],
          ['HGETALL', 'pi:agg:dwell_cnt'],
          ['LLEN', 'pi:sessions'],
          ['LRANGE', 'pi:sessions', '0', '-1'],
        ]);
        const sum = toObj(sumR.result), cnt = toObj(cntR.result);
        const dwellAvg = {};
        for (const k of Object.keys(sum)) dwellAvg[k] = cnt[k] ? Math.round(sum[k] / cnt[k]) : 0;
        // 語系與地區直接從清單數，不另外開 pi:agg:lang／pi:agg:country 計數器：
        // 這條路徑本來就已經讀了整份清單（訪客數需要逐筆看 vid），所以是零成本；
        // 而且新開的計數器還得在刪除紀錄時記得回扣（pi:agg:src／device 就是這樣，
        // 一有遺漏就會永久偏掉），逐筆數則永遠跟清單一致。
        const all = (listR.result || []).map((r) => parseJSON(r, null)).filter(Boolean);
        res.status(200).json({
          ok: true, scope,
          totalSessions: Number(lenR.result || 0),
          sources: toObj(srcR.result),
          devices: toObj(devR.result),
          langs: tally(all, 'lang'),
          countries: tally(all, 'country'),
          dwellAvgMs: dwellAvg,
          visitors: visitorStats(all),
          daily: dailySeries(all, Number(url.searchParams.get('tz'))),
          usage,
        });
        return;
      }

      // 過濾範圍：掃描清單 → 以 journey 是否存在分類 → 即時彙總來源/裝置/停留
      const [listR] = await redisPipeline([['LRANGE', 'pi:sessions', '0', '-1']]);
      const entries = (listR.result || []).map((r) => parseJSON(r, null)).filter(Boolean).slice(0, 10000);
      const wanted = [];
      for (let i = 0; i < entries.length; i += 200) {
        const chunk = entries.slice(i, i + 200);
        const flags = await redisPipeline(chunk.map((e) => ['EXISTS', `pi:journey:${e.sid}`]));
        chunk.forEach((e, j) => {
          const has = flags[j].result === 1;
          if ((scope === 'complete') === has) wanted.push(e);
        });
      }
      const sources = {}, devices = {};
      for (const e of wanted) {
        if (e.src) sources[e.src] = (sources[e.src] || 0) + 1;
        if (e.device) devices[e.device] = (devices[e.device] || 0) + 1;
      }
      const langs = tally(wanted, 'lang');
      const countries = tally(wanted, 'country');
      const visitors = visitorStats(wanted);
      const sum = {}, cnt = {};
      for (let i = 0; i < wanted.length; i += 100) {
        const chunk = wanted.slice(i, i + 100);
        const reads = await redisPipeline(chunk.flatMap((e) => [
          ['HGETALL', `pi:dwell:${e.sid}`],
          ['HGETALL', `pi:dwellcnt:${e.sid}`],
        ]));
        chunk.forEach((e, j) => {
          const dwell = toObj(reads[j * 2].result), dcnt = toObj(reads[j * 2 + 1].result);
          for (const [screen, ms] of Object.entries(dwell)) {
            sum[screen] = (sum[screen] || 0) + ms;
            cnt[screen] = (cnt[screen] || 0) + (dcnt[screen] || 1);
          }
        });
      }
      const dwellAvg = {};
      for (const k of Object.keys(sum)) dwellAvg[k] = cnt[k] ? Math.round(sum[k] / cnt[k]) : 0;
      res.status(200).json({
        ok: true, scope,
        totalSessions: wanted.length,
        sources,
        devices,
        langs,
        countries,
        dwellAvgMs: dwellAvg,
        visitors,
        daily: dailySeries(wanted, Number(url.searchParams.get('tz'))),
        usage,
      });
      return;
    }

    if (view === 'sessions') {
      const offset = Math.max(0, Number(url.searchParams.get('offset')) || 0);
      // 這一頁的 50 筆，加上整份清單——「這是第幾次來訪」必須看該 vid 的全部
      // 紀錄才算得出來，只看本頁會把每個人都算成第 1 次。
      const [listR, allR, labelsR] = await redisPipeline([
        ['LRANGE', 'pi:sessions', String(offset), String(offset + 49)],
        ['LRANGE', 'pi:sessions', '0', '-1'],
        ['HGETALL', 'pi:vidlabels'],   // 訪客標註整張帶回，前端用 vid 對照
      ]);
      const sessions = (listR.result || []).map((s) => parseJSON(s, null)).filter(Boolean);
      // 次數要跟著使用者選的資料範圍算：選「僅有題目的來訪」時，
      // 標成「第 3 次」卻只在清單裡看到 2 筆就對不上了。
      const all = (allR.result || []).map((r) => parseJSON(r, null)).filter(Boolean);
      const counted = await inScope(all, scopeOf(url), new Set(sessions.map((s) => s.vid)));
      const ordinals = visitOrdinals(counted);
      sessions.forEach((s) => {
        const o = ordinals.get(s.sid);
        s.visitNo = o ? o.visitNo : null;
        s.visitTotal = o ? o.visitTotal : null;
      });
      // 附註每筆是否留有題目（journey）、使用的工具、標註內容與回饋。
      // 取 journey 全文（而非只 EXISTS）是為了帶出 tools 讓清單直接顯示工具。
      if (sessions.length) {
        const STRIDE = 3;
        const extras = await redisPipeline(sessions.flatMap((s) => [
          ['GET', `pi:journey:${s.sid}`],
          ['GET', `pi:note:${s.sid}`],
          ['GET', `pi:fb:${s.sid}`],
        ]));
        sessions.forEach((s, i) => {
          const journey = extras[i * STRIDE].result ? parseJSON(extras[i * STRIDE].result, null) : null;
          s.hasJourney = !!journey;
          s.tools = (journey && Array.isArray(journey.tools)) ? journey.tools : null;
          // 題目只帶前段（清單看方向就夠，全文在展開的詳情裡）
          s.topic = journey ? String(journey.opening || '').slice(0, 40) : '';
          // 分析本文的字數：只算模型實際寫的分析，不含【工具】分節標記、占星每段
          // 的白話標題與配置行、雷諾曼的組別小標題。由前端在產生當下算好送來。
          //
          // 舊紀錄沒有 bodyChars，只能退回 message.length（含標題與標記，而且寫入
          // 時截斷在 4000，所以那是「至少 4000」）。msgCharsExact 讓前端知道這一筆
          // 是精確值還是退回來的估值，不必自己猜。
          if (journey && Number.isFinite(journey.bodyChars)) {
            s.msgChars = journey.bodyChars;
            s.msgCharsExact = true;
          } else {
            s.msgChars = journey ? String(journey.message || '').length : null;
            s.msgCharsExact = false;
          }
          // 同一份本文的 words（英文的篇幅規定以 words 計）。舊紀錄沒有這個欄位，
          // 前端會改用字元數推估並標明是估的。
          s.msgWords = journey && Number.isFinite(journey.bodyWords) ? journey.bodyWords : null;
          s.note = extras[i * STRIDE + 1].result || '';
          const fb = extras[i * STRIDE + 2].result ? parseJSON(extras[i * STRIDE + 2].result, null) : null;
          s.feedback = fb ? { rating: fb.rating, text: fb.text || '', ts: fb.ts } : null;
        });
      }
      // HGETALL 回平面陣列 [vid1, 名字1, vid2, 名字2, …]，轉成物件給前端對照
      const vidLabels = {};
      const flat = labelsR.result || [];
      for (let i = 0; i + 1 < flat.length; i += 2) vidLabels[flat[i]] = String(flat[i + 1]);
      res.status(200).json({ ok: true, offset, sessions, vidLabels });
      return;
    }

    // 單一訪客的全部來訪（含每次的題目）——後台點「第 N 次」時展開用。
    // 這裡是掃整份清單而不是只看已載入的幾頁，所以拿得到的是「全部」，
    // 不像列表的訪客過濾只在已載入的紀錄裡找。
    if (view === 'visitor') {
      const vid = String(url.searchParams.get('vid') || '').slice(0, 40);
      if (!vid) { res.status(400).json({ ok: false, error: 'vid_required' }); return; }
      const [listR] = await redisPipeline([['LRANGE', 'pi:sessions', '0', '-1']]);
      const all = (listR.result || []).map((r) => parseJSON(r, null)).filter(Boolean);
      const mine = await inScope(all, scopeOf(url), new Set([vid]));
      mine.sort((a, b) => (Number(a.ts) || 0) - (Number(b.ts) || 0));   // 舊 → 新
      const visits = mine.slice(0, 200);
      if (visits.length) {
        const STRIDE = 2;
        const extras = await redisPipeline(visits.flatMap((s) => [
          ['GET', `pi:journey:${s.sid}`],
          ['GET', `pi:fb:${s.sid}`],
        ]));
        visits.forEach((s, i) => {
          const j = extras[i * STRIDE].result ? parseJSON(extras[i * STRIDE].result, null) : null;
          s.hasJourney = !!j;
          s.topic = j ? String(j.opening || '') : '';
          s.tools = (j && Array.isArray(j.tools)) ? j.tools : null;
          const fb = extras[i * STRIDE + 1].result ? parseJSON(extras[i * STRIDE + 1].result, null) : null;
          s.feedback = fb ? { rating: fb.rating, text: fb.text || '' } : null;
        });
      }
      const [vlR] = await redisPipeline([['HGET', 'pi:vidlabels', vid]]);
      res.status(200).json({
        ok: true, vid, label: vlR.result ? String(vlR.result) : '',
        scope: scopeOf(url), total: mine.length,
        visits: visits.map((s, i) => ({
          visitNo: i + 1, sid: s.sid, ts: s.ts, src: s.src, device: s.device,
          topic: s.topic, tools: s.tools, hasJourney: s.hasJourney, feedback: s.feedback,
        })),
      });
      return;
    }

    if (view === 'timings') {
      // 處理時間清單（新到舊）＋各階段的中位數與 P90。
      // 中位數看「一般使用者的體驗」，P90 看「最慢的那些人有多慘」——兩個都要。
      const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit')) || 200));
      const [listR] = await redisPipeline([['LRANGE', 'pi:timings', '0', String(limit - 1)]]);
      const items = (listR.result || []).map((r) => parseJSON(r, null)).filter(Boolean);

      const FIELDS = ['weavingMs', 'analyzeMs', 'holdMs', 'requestMs', 'promptMs', 'recordMs',
        'llmFirstMs', 'insightServerMs', 'astroRoundTripMs', 'astroGeocodeMs', 'astroEphemerisMs', 'astroServerMs'];
      const valueOf = (f, it) => (f === 'llmFirstMs'
        ? (Array.isArray(it.llmMs) && it.llmMs.length ? it.llmMs[0] : null)
        : it[f]);
      const pick = (arr, q) => (arr.length ? arr[Math.min(arr.length - 1, Math.floor(arr.length * q))] : null);
      const stats = {};
      for (const f of FIELDS) {
        const vals = items.map((it) => valueOf(f, it)).filter((v) => typeof v === 'number').sort((a, b) => a - b);
        stats[f] = { n: vals.length, p50: pick(vals, 0.5), p90: pick(vals, 0.9), max: vals.length ? vals[vals.length - 1] : null };
      }
      const [lenR] = await redisPipeline([['LLEN', 'pi:timings']]);
      res.status(200).json({
        ok: true,
        total: Number(lenR.result || 0),
        loaded: items.length,
        stats,
        items,
      });
      return;
    }

    if (view === 'session') {
      const sid = String(url.searchParams.get('sid') || '').slice(0, 16).replace(/[^\w-]/g, '');
      if (!sid) { res.status(400).json({ ok: false, error: 'bad_sid' }); return; }
      const [jR, dR, nR, pR, fR, tR] = await redisPipeline([
        ['GET', `pi:journey:${sid}`],
        ['HGETALL', `pi:dwell:${sid}`],
        ['GET', `pi:note:${sid}`],
        ['GET', `pi:prompt:${sid}`],
        ['GET', `pi:fb:${sid}`],
        ['GET', `pi:timing:${sid}`],
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
        feedback: fR.result ? parseJSON(fR.result, null) : null,
        timing: tR.result ? parseJSON(tR.result, null) : null,
      });
      return;
    }

    if (view === 'feedback') {
      // 使用者回饋清單（新到舊）＋筆數、平均星等與 1–5 星分布。
      // 每筆自帶主題與工具，因此即使原來訪紀錄已被刪除，回饋本身仍可閱讀。
      const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit')) || 200));
      const [listR] = await redisPipeline([['LRANGE', 'pi:feedback', '0', String(limit - 1)]]);
      const items = (listR.result || []).map((r) => parseJSON(r, null)).filter(Boolean);
      const dist = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
      let sum = 0;
      for (const f of items) {
        const r = Number(f.rating) || 0;
        if (r >= 1 && r <= 5) { dist[r]++; sum += r; }
      }
      const [lenR] = await redisPipeline([['LLEN', 'pi:feedback']]);
      res.status(200).json({
        ok: true,
        total: Number(lenR.result || 0),
        loaded: items.length,
        avg: items.length ? +(sum / items.length).toFixed(2) : 0,
        dist,
        items,
      });
      return;
    }

    // 專屬靈感牌卡的清單。給站主審核產出品質用，所以整筆紀錄原樣回傳：
    // 挑中哪一張牌與為什麼（所有東西的源頭）→ 卡面英文 → 譯文 → 牌義 → 圖像 prompt。
    // 挑中的牌、why 與圖像 prompt 從來不回傳給使用者（見 api/oracle.js），這裡是唯一
    // 看得到它們的地方——出問題時要能分辨是「挑錯牌」還是「翻譯或畫面不好」。
    //
    // 存檔的預覽圖刻意不隨清單一起回傳：一張約 30 KB，50 張就 1.5 MB，
    // 每次開分頁都拉那麼多不合理。改成點開單筆才另外要（view=oracleimg）。
    if (view === 'oracles') {
      const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit')) || 50));
      const [idsR] = await redisPipeline([['LRANGE', 'pi:oracles', '0', String(limit - 1)]]);
      const ids = (idsR.result || []).filter(Boolean);
      const items = [];
      if (ids.length) {
        const rows = await redisPipeline(ids.map((id) => ['GET', `pi:oracle:${id}`]));
        // 同時問哪幾筆有存檔圖，前端才知道要不要顯示按鈕。兩種各問一次：
        // 合成後的卡與圖像模型的原始 artwork 是分開存的，可能只有其中一張
        //（artwork 是後來才加的，之前的紀錄只有合成卡）。
        const imgs = await redisPipeline(ids.map((id) => ['EXISTS', `pi:oracleimg:${id}`]));
        const arts = await redisPipeline(ids.map((id) => ['EXISTS', `pi:oracleart:${id}`]));
        ids.forEach((id, i) => {
          const rec = parseJSON(rows[i] && rows[i].result, null);
          if (!rec) return;
          items.push({
            ...rec,
            hasImage: Number((imgs[i] || {}).result) === 1,
            hasArt: Number((arts[i] || {}).result) === 1,
            // 圖像模型實際收到的完整 prompt。收尾那段約束是程式接上去的，不在模型
            // 寫的那一段裡——只顯示前半段會讓人以為指定尺寸與「不要有文字」的要求
            // 不見了（站主就是這樣誤會過一次）。
            imagePromptFull: rec.imagePrompt
              ? `${rec.imagePrompt}\n\n${IMAGE_SUFFIX}` : '',
          });
        });
      }
      const [lenR] = await redisPipeline([['LLEN', 'pi:oracles']]);
      res.status(200).json({
        ok: true, total: Number(lenR.result || 0), loaded: items.length, items,
      });
      return;
    }

    // 單張牌卡的存檔圖。kind=art 是圖像模型畫的原始 artwork（對照 prompt 用），
    // 預設是合成後的整張卡（使用者拿到的東西）。兩張都是壓縮預覽，各約 30 KB。
    if (view === 'oracleimg') {
      const id = String(url.searchParams.get('id') || '').slice(0, 40).replace(/[^\w-]/g, '');
      if (!id) { res.status(400).json({ ok: false, error: 'bad_id' }); return; }
      const key = url.searchParams.get('kind') === 'art' ? 'pi:oracleart' : 'pi:oracleimg';
      const [r] = await redisPipeline([['GET', `${key}:${id}`]]);
      res.status(200).json({ ok: true, image: r.result || null });
      return;
    }

    // 專屬靈感牌卡的總開關現況。與 api/oracle.js 的 isEnabled() 是同一套判斷，
    // 只是這裡多回報「現在是誰在決定」，畫面才能說明為什麼開關按不動。
    if (view === 'oracleswitch') {
      const envRaw = process.env.ORACLE_ENABLED;
      const envSet = envRaw != null && String(envRaw).trim() !== '';
      const on = envSet
        ? !/^(0|false|off|no)$/i.test(String(envRaw).trim())
        : await oracleSwitchStored();
      res.status(200).json({ ok: true, enabled: on, envSet, source: envSet ? 'env' : 'redis' });
      return;
    }

    // 這一張卡實際送給文字模型的原始 prompt，供站主 debug。
    // system 與 user 分開存（system 每次都一樣，按內容雜湊只存一份），這裡合起來回。
    // 刻意不隨清單一起回傳：system prompt 約 2.8 萬字（整副牌都在裡面），
    // 50 筆就是 1.4 MB——要看的時候才單筆調。
    if (view === 'oracleprompt') {
      const id = String(url.searchParams.get('id') || '').slice(0, 40).replace(/[^\w-]/g, '');
      if (!id) { res.status(400).json({ ok: false, error: 'bad_id' }); return; }
      const [recR, userR] = await redisPipeline([
        ['GET', `pi:oracle:${id}`],
        ['GET', `pi:oracleuser:${id}`],
      ]);
      const rec = parseJSON(recR.result, null);
      let system = null;
      if (rec && rec.sysHash) {
        const hash = String(rec.sysHash).replace(/[^\w]/g, '').slice(0, 16);
        const [sysR] = await redisPipeline([['GET', `pi:oraclesys:${hash}`]]);
        system = sysR.result || null;
      }
      res.status(200).json({
        ok: true,
        provider: (rec && rec.provider) || null,
        model: (rec && rec.model) || null,
        system,
        user: userR.result || null,
        // 圖像模型收到的完整 prompt＝模型寫的那段 ＋ 程式固定接上的收尾約束。
        // 只回前半段會讓人以為缺了那些禁令，實際上是程式加的。
        imagePrompt: rec && rec.imagePrompt
          ? `${rec.imagePrompt}\n\n${IMAGE_SUFFIX}` : null,
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
