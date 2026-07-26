// admin.js — 管理儀表板前端。
// 密碼存於 sessionStorage（僅本分頁有效）；所有查詢帶 Authorization header。

const $ = (id) => document.getElementById(id);
const PW_KEY = 'pi_admin_pw';

const SCREEN_LABELS = {
  screenIntake: '首頁（輸入主題）',
  screenSpread: '選牌（九宮格）',
  screenNumbers: '報數（起卦）',
  screenWeaving: '整合中',
  screenResult: '結果頁',
  screenCare: '關懷頁',
};

// 使用紀錄：本地快取 + 篩選 + 多選刪除。
// scope 為全域資料範圍（complete／all／incomplete），同時套用到
// 總覽統計、來源/裝置/停留圓餅圖與使用紀錄清單。
let allSessions = [];
let sessOffset = 0;
let exhausted = false;
const filters = { scope: 'complete', device: '', source: '' };
const selected = new Set(); // 已勾選的 sid

function pw() { return sessionStorage.getItem(PW_KEY) || ''; }

async function api(params, postBody) {
  const res = await fetch('/api/admin?' + new URLSearchParams(params), {
    method: postBody ? 'POST' : 'GET',
    headers: {
      authorization: 'Bearer ' + pw(),
      ...(postBody ? { 'content-type': 'application/json' } : {}),
    },
    body: postBody ? JSON.stringify(postBody) : undefined,
  });
  const json = await res.json().catch(() => ({ ok: false, error: 'bad_response' }));
  if (!res.ok || !json.ok) throw Object.assign(new Error(json.error || 'error'), { code: json.error, status: res.status });
  return json;
}

// ---- 登入 ----
$('btnLogin').addEventListener('click', login);
$('adminPw').addEventListener('keydown', (e) => { if (e.key === 'Enter') login(); });
$('btnLogout').addEventListener('click', () => {
  sessionStorage.removeItem(PW_KEY);
  location.reload();
});

async function login() {
  const value = $('adminPw').value.trim();
  if (!value) { $('adminPw').focus(); return; }
  sessionStorage.setItem(PW_KEY, value);
  $('loginError').textContent = '';
  try {
    await enterDash();
  } catch (e) {
    sessionStorage.removeItem(PW_KEY);
    $('loginError').textContent = ({
      unauthorized: '密碼不正確。',
      rate_limited: '嘗試次數過多，請一小時後再試。',
      storage_not_configured: '儲存後端尚未設定（缺 Upstash Redis 環境變數）。',
      admin_disabled: '後台未啟用（缺 ADMIN_PASSWORD 環境變數）。',
    })[e.code] || '無法連線，請稍後再試。';
  }
}

async function refreshOverview() {
  const overview = await api({ view: 'overview', scope: filters.scope });
  renderOverview(overview);
  return overview;
}

async function enterDash() {
  const overview = await refreshOverview();
  document.querySelectorAll('.screen').forEach((s) => s.classList.remove('active'));
  $('adminDash').classList.add('active');

  // 來源下拉：以總覽的來源清單填充
  const srcSel = $('fltSource');
  srcSel.length = 1;
  for (const src of Object.keys(overview.sources).sort()) {
    const opt = document.createElement('option');
    opt.value = src; opt.textContent = src;
    srcSel.appendChild(opt);
  }

  allSessions = [];
  sessOffset = 0;
  exhausted = false;
  await loadMore();
  await refreshFeedback();
  await refreshTimings();
}

// ---- 篩選 ----
// 資料範圍：一次切換總覽統計、三張圓餅圖與使用紀錄清單
$('fltScope').addEventListener('change', async (e) => {
  filters.scope = e.target.value;
  onFilterChange();
  try { await refreshOverview(); } catch { /* 保留原統計 */ }
});
$('fltDevice').addEventListener('change', (e) => { filters.device = e.target.value; onFilterChange(); });
$('fltSource').addEventListener('change', (e) => { filters.source = e.target.value; onFilterChange(); });

async function onFilterChange() {
  renderSessions();
  // 篩選後畫面太空時，自動補抓幾頁
  if (visibleSessions().length < 20 && !exhausted) await loadMore();
}

function matchesFilters(s) {
  if (filters.scope === 'complete' && !s.hasJourney) return false;
  if (filters.scope === 'incomplete' && s.hasJourney) return false;
  if (filters.device && s.device !== filters.device) return false;
  if (filters.source && s.src !== filters.source) return false;
  return true;
}

// 工具代碼 → 中文標籤（後台一律繁體中文）
const TOOL_LABEL = {
  lenormand: '雷諾曼牌陣', meihua: '梅花易數', astro: '西洋占星',
  bazi: '八字', ziwei: '紫微斗數', tarot: '塔羅牌',
};
const toolText = (s) => (Array.isArray(s.tools) && s.tools.length
  ? s.tools.map((x) => TOOL_LABEL[x] || x).join('、')
  : '');

// 排序狀態（點表頭切換 遞增／遞減）。預設依時間新到舊。
let sort = { key: 'ts', dir: 'desc' };

// 各欄的排序鍵值（統一成可比較的字串或數字）
const SORT_VALUE = {
  ts: (s) => Number(s.ts) || 0,
  vid: (s) => String(s.vid || ''),
  src: (s) => String(s.src || ''),
  device: (s) => `${s.device || ''} ${s.os || ''}`,
  topic: (s) => String(s.topic || ''),
  tools: (s) => toolText(s),
  hasJourney: (s) => (s.hasJourney ? 1 : 0),
  // 沒回饋的排在最後（遞減時最高分在前、遞增時 0 在前）
  feedback: (s) => (s.feedback ? Number(s.feedback.rating) || 0 : 0),
  note: (s) => String(s.note || ''),
};

// 星等 → ★★★☆☆
const STARS = (n) => '★★★★★'.slice(0, n) + '☆☆☆☆☆'.slice(0, 5 - n);

function sortSessions(list) {
  const pick = SORT_VALUE[sort.key] || SORT_VALUE.ts;
  const mul = sort.dir === 'asc' ? 1 : -1;
  return [...list].sort((a, b) => {
    const va = pick(a);
    const vb = pick(b);
    let c;
    if (typeof va === 'number' && typeof vb === 'number') c = va - vb;
    else c = String(va).localeCompare(String(vb), 'zh-Hant');
    if (c === 0) c = (Number(b.ts) || 0) - (Number(a.ts) || 0); // 同值時固定以時間新到舊
    else c *= mul;
    return c;
  });
}

function visibleSessions() {
  return sortSessions(allSessions.filter(matchesFilters));
}

// ---- 總覽（圓餅圖） ----
const PIE_COLORS = ['#c2a869', '#7d94b8', '#a97e5f', '#8f86ad', '#7fa38d', '#b78a92', '#6e6957'];

function renderOverview(o) {
  const u = o.usage || { bytes: 0, limitBytes: 1, pct: 0, prunedTotal: 0, prunedAt: null };
  const capCls = u.pct >= 95 ? 'crit' : u.pct >= 85 ? 'warn' : '';
  const scopeLabel = { complete: '有題目的來訪', incomplete: '未完成的來訪' }[o.scope] || '累計來訪';
  $('statRow').innerHTML = `
    <div class="stat"><b>${o.totalSessions}</b><span>${scopeLabel}</span></div>
    <div class="stat"><b>${Object.values(o.devices).reduce((a, b) => a + b, 0)}</b><span>裝置事件</span></div>
    <div class="stat"><b>${Object.keys(o.sources).length}</b><span>來源管道數</span></div>
    <div class="stat cap-stat">
      <b class="${capCls}">${u.pct}%</b>
      <span>容量使用（估算 ${fmtBytes(u.bytes)}／${fmtBytes(u.limitBytes)}）</span>
      <div class="cap-bar"><div class="cap-fill ${capCls}" style="width:${Math.min(100, u.pct)}%"></div></div>
      <button class="btn ghost small" id="btnRecalc">重算容量</button>
      <span class="recalc-note" id="recalcNote"></span>
    </div>`;

  $('btnRecalc').addEventListener('click', async () => {
    const b = $('btnRecalc');
    b.disabled = true; b.textContent = '重算中……';
    try {
      const r = await api({}, { action: 'recalc' });
      await refreshOverview(); // 會重繪 statRow，按鈕連同狀態一起重建
      if (r.orphansRemoved) {
        const note = $('recalcNote');
        if (note) note.textContent = `已順手清掉 ${r.orphansRemoved} 筆沒有主人的殘留資料`;
      }
    } catch { b.textContent = '重算失敗'; }
  });

  // 容量警示橫幅
  const banner = $('capBanner');
  if (u.prunedTotal > 0) {
    banner.className = 'cap-banner crit';
    banner.innerHTML = `⚠ <b>已達容量上限</b>——系統已自動刪除最舊的 <b>${u.prunedTotal}</b> 筆紀錄，讓用量維持在 95% 以下${u.prunedAt ? `（最近一次：${fmtTime(u.prunedAt)}）` : ''}。若要保留更多歷史，請升級 Upstash 容量方案，或調高 STORAGE_LIMIT_MB。`;
    banner.style.display = 'block';
  } else if (u.pct >= 85) {
    banner.className = 'cap-banner warn';
    banner.innerHTML = `⚠ 儲存容量已使用 <b>${u.pct}%</b>——接近免費方案上限。達到 95% 時，系統會自動從最舊的紀錄開始刪除；若要避免，請留意升級容量。`;
    banner.style.display = 'block';
  } else {
    banner.style.display = 'none';
  }

  renderPie($('srcChart'), topEntries(o.sources, 6), (v) => `${v} 次`, '（尚無來源資料）');
  renderPie($('devChart'), topEntries(mapKeys(o.devices, { mobile: '手機', desktop: '電腦', tablet: '平板' }), 6), (v) => `${v} 次`, '（尚無裝置資料）');

  const order = ['screenIntake', 'screenSpread', 'screenNumbers', 'screenWeaving', 'screenResult', 'screenCare'];
  const dwellEntries = order
    .filter((k) => o.dwellAvgMs[k] > 0)
    .map((k) => [SCREEN_LABELS[k] || k, o.dwellAvgMs[k]]);
  renderPie($('dwellChart'), dwellEntries, fmtMs, '（尚無停留資料）');
}

function mapKeys(obj, names) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) out[names[k] || k] = v;
  return out;
}

// 取前 N 名，其餘合併為「其他」
function topEntries(counts, n) {
  const entries = Object.entries(counts).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
  if (entries.length <= n) return entries;
  const head = entries.slice(0, n);
  const rest = entries.slice(n).reduce((a, [, v]) => a + v, 0);
  return [...head, ['其他', rest]];
}

// 圓餅圖（conic-gradient 甜甜圈 + 圖例：名稱、數值、百分比）
function renderPie(host, entries, fmtValue, emptyText) {
  const total = entries.reduce((a, [, v]) => a + v, 0);
  if (!total) { host.innerHTML = `<div class="empty">${emptyText}</div>`; return; }

  let acc = 0;
  const stops = entries.map(([, v], i) => {
    const from = (acc / total) * 360;
    acc += v;
    const to = (acc / total) * 360;
    return `${PIE_COLORS[i % PIE_COLORS.length]} ${from.toFixed(1)}deg ${to.toFixed(1)}deg`;
  }).join(', ');

  host.innerHTML = `
    <div class="pie-wrap">
      <div class="pie" style="background: conic-gradient(${stops})"></div>
      <div class="pie-legend">
        ${entries.map(([label, v], i) => `
          <div class="pl-row">
            <span class="pl-dot" style="background:${PIE_COLORS[i % PIE_COLORS.length]}"></span>
            <span class="pl-label">${esc(label)}</span>
            <span class="pl-val">${fmtValue(v)}</span>
            <span class="pl-pct">${Math.round((v / total) * 100)}%</span>
          </div>`).join('')}
      </div>
    </div>`;
}

// ---- 使用者回饋 ----
// 獨立的 pi:feedback 清單（新到舊）。每筆自帶主題與工具，
// 因此就算原來訪紀錄已被刪除或汰舊，回饋內容仍讀得到。
let fbLimit = 200;

$('btnFbMore').addEventListener('click', async () => {
  fbLimit = Math.min(500, fbLimit + 200);
  await refreshFeedback();
});

async function refreshFeedback() {
  try {
    const d = await api({ view: 'feedback', limit: String(fbLimit) });
    renderFeedback(d);
  } catch {
    $('fbList').innerHTML = '<div class="empty">（回饋讀取失敗）</div>';
  }
}

function renderFeedback(d) {
  const summary = $('fbSummary');
  const list = $('fbList');

  if (!d.total) {
    summary.innerHTML = '';
    list.innerHTML = '<div class="empty">（還沒有人送出回饋）</div>';
    $('btnFbMore').style.display = 'none';
    return;
  }

  const bars = [5, 4, 3, 2, 1].map((n) => {
    const c = d.dist[n] || 0;
    const pct = d.loaded ? Math.round((c / d.loaded) * 100) : 0;
    return `<div class="fbd-row">
      <span class="fbd-star">${STARS(n)}</span>
      <span class="fbd-bar"><span class="fbd-fill" style="width:${pct}%"></span></span>
      <span class="fbd-num">${c}</span>
    </div>`;
  }).join('');

  summary.innerHTML = `
    <div class="fb-avg"><b>${d.avg || '—'}</b><span>平均星等（已載入 ${d.loaded} 筆／共 ${d.total} 筆）</span></div>
    <div class="fb-dist">${bars}</div>`;

  list.innerHTML = d.items.map((f) => `
    <div class="fb-card">
      <div class="fb-card-head">
        <span class="fb-card-stars">${STARS(Number(f.rating) || 0)}</span>
        <span class="fb-card-meta">${fmtTime(f.ts)}${f.tools && f.tools.length ? `・${esc(f.tools.map((x) => TOOL_LABEL[x] || x).join('、'))}` : ''}${f.lang ? `・${esc(f.lang)}` : ''}${f.offline ? '・離線模板' : ''}</span>
      </div>
      <div class="fb-card-topic">主題：${esc(f.topic || '—')}</div>
      ${f.text ? `<div class="fb-card-text">${esc(f.text)}</div>` : '<div class="fb-card-text dim">（沒有留下文字）</div>'}
      <div class="fb-card-sid">來訪 <code>${esc(f.sid || '')}</code>・訪客 <code>${esc(f.vid || '')}</code></div>
    </div>`).join('');

  $('btnFbMore').style.display = (d.loaded < d.total && fbLimit < 500) ? 'inline-block' : 'none';
}

// ---- 處理時間 ----
// 獨立的 pi:timings 清單，每筆帶 sid 對得回來訪紀錄。
let tmLimit = 200;

$('btnTmMore').addEventListener('click', async () => {
  tmLimit = Math.min(500, tmLimit + 200);
  await refreshTimings();
});

async function refreshTimings() {
  try {
    renderTimings(await api({ view: 'timings', limit: String(tmLimit) }));
  } catch {
    $('tmTable').querySelector('tbody').innerHTML = '<tr><td colspan="13" class="empty">（處理時間讀取失敗）</td></tr>';
  }
}

// 階段名稱：與 API 的 stats 欄位一一對應
const TM_LABEL = {
  weavingMs: '使用者等待（分析中全程）',
  analyzeMs: '解讀取得（含網路）',
  holdMs: '動畫刻意等待',
  requestMs: '/api/insight 往返',
  promptMs: '組 prompt',
  recordMs: '寫 prompt 紀錄（Redis）',
  llmFirstMs: 'LLM 生成（第一次）',
  insightServerMs: '/api/insight 伺服器全程',
  astroRoundTripMs: '/api/astro 往返',
  astroGeocodeMs: '查地點（對外 geocoding）',
  astroEphemerisMs: '星曆計算（Swiss Ephemeris）',
  astroServerMs: '/api/astro 伺服器全程',
};

function renderTimings(d) {
  const tbody = $('tmTable').querySelector('tbody');
  if (!d.total) {
    $('tmStats').innerHTML = '';
    tbody.innerHTML = '<tr><td colspan="13" class="empty">（還沒有處理時間紀錄——完成一次解讀後才會產生）</td></tr>';
    $('btnTmMore').style.display = 'none';
    return;
  }

  const rows = Object.keys(TM_LABEL)
    .filter((f) => d.stats[f] && d.stats[f].n)
    .map((f) => {
      const st = d.stats[f];
      return `<tr>
        <td>${esc(TM_LABEL[f])}</td>
        <td class="tm-num">${fmtDur(st.p50)}</td>
        <td class="tm-num">${fmtDur(st.p90)}</td>
        <td class="tm-num dim">${fmtDur(st.max)}</td>
        <td class="tm-num dim">${st.n}</td>
      </tr>`;
    }).join('');
  $('tmStats').innerHTML = `
    <div class="tm-stats-head">已載入 ${d.loaded} 筆／共 ${d.total} 筆</div>
    <table class="a-table tm-summary">
      <thead><tr><th>階段</th><th>中位數</th><th>P90</th><th>最慢</th><th>樣本</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;

  tbody.innerHTML = d.items.map((it) => {
    const llm = Array.isArray(it.llmMs) && it.llmMs.length ? it.llmMs[0] : null;
    // 網路差＝前端量到的往返 減 伺服器自己量到的處理時間
    const netGap = (it.requestMs != null && it.insightServerMs != null)
      ? Math.max(0, it.requestMs - it.insightServerMs) : null;
    const cell = (v) => `<td class="tm-num">${v == null ? '<span class="dim-dash">—</span>' : fmtDur(v)}</td>`;
    return `<tr>
      <td>${fmtTime(it.ts)}</td>
      <td><code>${esc(it.sid || '')}</code></td>
      <td>${esc((it.tools || []).map((x) => TOOL_LABEL[x] || x).join('、'))}</td>
      ${cell(it.weavingMs)}
      ${cell(llm)}
      <td class="tm-num">${it.attempts || 1}</td>
      <td class="tm-num">${it.promptChars == null ? '<span class="dim-dash">—</span>' : it.promptChars}</td>
      ${cell(it.recordMs)}
      ${cell(netGap)}
      ${cell(it.holdMs)}
      ${cell(it.astroRoundTripMs)}
      ${cell(it.astroGeocodeMs)}
      ${cell(it.astroEphemerisMs)}
    </tr>`;
  }).join('');

  $('btnTmMore').style.display = (d.loaded < d.total && tmLimit < 500) ? 'inline-block' : 'none';
}

// ---- 使用紀錄 ----
$('btnMore').addEventListener('click', loadMore);

async function fetchPage() {
  const { sessions } = await api({ view: 'sessions', offset: String(sessOffset) });
  sessOffset += 50;
  if (sessions.length < 50) exhausted = true;
  allSessions.push(...sessions);
}

// 載入更多：抓到「符合篩選的可見筆數」至少多 20 筆，或資料抓完為止（單次最多 6 頁）
async function loadMore() {
  const before = visibleSessions().length;
  let pages = 0;
  while (!exhausted && pages < 6 && visibleSessions().length - before < 20) {
    await fetchPage();
    pages++;
  }
  renderSessions();
}

// 表頭排序：點一次切換遞增／遞減，再點同一欄則反向
function bindSortHeaders() {
  document.querySelectorAll('#sessTable th.sortable').forEach((th) => {
    if (th.dataset.bound) return;
    th.dataset.bound = '1';
    th.addEventListener('click', () => {
      const key = th.dataset.sort;
      if (sort.key === key) sort.dir = sort.dir === 'asc' ? 'desc' : 'asc';
      else sort = { key, dir: key === 'ts' ? 'desc' : 'asc' };
      renderSessions();
    });
  });
}

function paintSortHeaders() {
  document.querySelectorAll('#sessTable th.sortable').forEach((th) => {
    const on = th.dataset.sort === sort.key;
    th.classList.toggle('sorted', on);
    th.classList.toggle('asc', on && sort.dir === 'asc');
    th.classList.toggle('desc', on && sort.dir === 'desc');
    th.setAttribute('aria-sort', on ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none');
  });
}

function renderSessions() {
  bindSortHeaders();
  paintSortHeaders();
  const tbody = $('sessTable').querySelector('tbody');
  tbody.innerHTML = '';
  const visible = visibleSessions();

  if (!visible.length) {
    tbody.innerHTML = `<tr><td colspan="10" class="empty">${
      allSessions.length
        ? '（目前的資料範圍與篩選條件下沒有紀錄——試著切換上方「資料範圍」或放寬條件）'
        : '（尚無來訪紀錄）'
    }</td></tr>`;
  }

  // 清掉已不存在的勾選
  const visibleSids = new Set(visible.map((s) => s.sid));
  for (const sid of [...selected]) if (!visibleSids.has(sid)) selected.delete(sid);

  for (const s of visible) {
    const tr = document.createElement('tr');
    tr.className = 'sess-row';
    tr.innerHTML = `
      <td class="chk-col"><input type="checkbox" class="row-chk" ${selected.has(s.sid) ? 'checked' : ''}></td>
      <td>${fmtTime(s.ts)}</td>
      <td><code>${esc(s.vid)}</code></td>
      <td>${esc(s.src)}</td>
      <td>${esc({ mobile: '手機', desktop: '電腦', tablet: '平板' }[s.device] || s.device)} · ${esc(s.os)}</td>
      <td class="topic-cell" title="${esc(s.topic || '')}">${esc(truncate(s.topic, 12)) || '<span class="dim-dash">—</span>'}</td>
      <td>${toolText(s) ? `<span class="tool-tag">${esc(toolText(s))}</span>` : '<span class="dim-dash">—</span>'}</td>
      <td>${s.hasJourney ? '<span class="badge">有題目</span>' : '<span class="badge dim">未完成</span>'}</td>
      <td class="fb-cell" title="${esc(s.feedback ? `${s.feedback.rating} 星${s.feedback.text ? `：${s.feedback.text}` : ''}` : '')}">${
        s.feedback
          ? `<span class="fb-stars-cell">${STARS(s.feedback.rating)}</span>${s.feedback.text ? `<span class="fb-has-text" title="有留言">✎</span>` : ''}`
          : '<span class="dim-dash">—</span>'
      }</td>
      <td class="note-cell" title="${esc(s.note || '')}">${esc(truncate(s.note, 12)) || '<span class="dim-dash">—</span>'}</td>`;

    const chk = tr.querySelector('.row-chk');
    chk.addEventListener('click', (e) => e.stopPropagation()); // 勾選不展開詳情
    chk.addEventListener('change', () => {
      if (chk.checked) selected.add(s.sid); else selected.delete(s.sid);
      updateBulkBar();
    });
    tr.addEventListener('click', () => toggleDetail(tr, s));
    tbody.appendChild(tr);
  }

  $('fltCount').textContent = `顯示 ${visible.length} 筆／已載入 ${allSessions.length} 筆`;
  $('btnMore').style.display = exhausted ? 'none' : 'inline-block';
  updateBulkBar();
}

// ---- 多選刪除 ----
function updateBulkBar() {
  const visible = visibleSessions();
  $('bulkBar').style.display = selected.size ? 'flex' : 'none';
  $('bulkCount').textContent = `已選取 ${selected.size} 筆`;
  const all = $('chkAll');
  all.checked = visible.length > 0 && visible.every((s) => selected.has(s.sid));
  all.indeterminate = selected.size > 0 && !all.checked;
}

$('chkAll').addEventListener('change', () => {
  const check = $('chkAll').checked;
  for (const s of visibleSessions()) {
    if (check) selected.add(s.sid); else selected.delete(s.sid);
  }
  document.querySelectorAll('#sessTable .row-chk').forEach((c) => { c.checked = check; });
  updateBulkBar();
});

$('btnBulkDel').addEventListener('click', async () => {
  if (!selected.size) return;
  if (!confirm(`確定刪除選取的 ${selected.size} 筆紀錄？（題目、訊息、停留與標註都會移除，統計數字同步扣除）`)) return;
  const btn = $('btnBulkDel');
  btn.disabled = true;
  try {
    // 後端單次上限 100 筆：超過時分批送出
    const sids = [...selected];
    for (let i = 0; i < sids.length; i += 100) {
      await api({}, { action: 'delete', sids: sids.slice(i, i + 100) });
    }
    allSessions = allSessions.filter((s) => !selected.has(s.sid));
    selected.clear();
    renderSessions();
    await refreshOverview();
    await refreshFeedback(); // 刪掉的紀錄，其回饋也一併移除了
    await refreshTimings();
  } catch {
    alert('刪除失敗，請重試。');
  }
  btn.disabled = false;
});

async function toggleDetail(tr, s) {
  const existing = tr.nextElementSibling;
  if (existing && existing.classList.contains('sess-detail')) { existing.remove(); return; }

  const detail = document.createElement('tr');
  detail.className = 'sess-detail';
  detail.innerHTML = '<td colspan="10" class="detail-cell">讀取中……</td>';
  tr.after(detail);

  try {
    const d = await api({ view: 'session', sid: s.sid });
    const j = d.journey;
    const dwell = Object.entries(d.dwellMs || {})
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${SCREEN_LABELS[k] || k}：${fmtMs(v)}`)
      .join('｜');
    detail.querySelector('td').innerHTML = `
      ${j ? `
        <div class="d-line"><b>題目</b>${esc(j.opening)}</div>
        <div class="d-line"><b>選牌</b>${(j.cards || []).map(esc).join('、') || '—'}</div>
        <div class="d-line"><b>報數</b>${j.numbers ? j.numbers.join('、') : '（時間起卦）'}</div>
        <div class="d-line"><b>星盤</b>${astroDetail(j)}</div>
        <div class="d-line"><b>產出</b>${esc(j.title || '—')}${j.offline ? '（離線模板）' : ''}</div>
        ${j.message ? `
        <div class="d-line d-message"><b>訊息</b><div class="d-msg-text">${esc(j.message)}${j.closing ? `\n\n— ${esc(j.closing)}` : ''}</div></div>` : ''}
      ` : '<div class="d-line"><b>題目</b>（此次來訪未完成體驗）</div>'}
      <div class="d-line"><b>回饋</b>${d.feedback
        ? `<span class="fb-stars-cell">${STARS(Number(d.feedback.rating) || 0)}</span>（${Number(d.feedback.rating) || 0} 星，${fmtTime(d.feedback.ts)}）${
          d.feedback.text ? `<div class="d-msg-text fb-detail-text">${esc(d.feedback.text)}</div>` : '<span class="astro-sub">（沒有留下文字）</span>'}`
        : '（未回饋）'}</div>
      <div class="d-line"><b>停留</b>${dwell || '—'}</div>
      <div class="d-line"><b>處理時間</b>${timingDetail(d.timing)}</div>
      ${d.prompt ? `
      <div class="d-line d-message"><b>Prompt</b>
        <div class="prompt-wrap">
          <div class="prompt-meta">最後送給模型的完整文字（可分段檢視）｜${esc(d.prompt.provider || '?')} / ${esc(d.prompt.model || '?')}｜system prompt 版本 <code>${esc(d.prompt.sysHash || '?')}</code>
            <button class="btn ghost small btn-copy-prompt">複製此段</button>
          </div>
          <div class="seg-tabs">
            <button class="seg-tab on" data-seg="full">完整 Prompt</button>
            <button class="seg-tab" data-seg="opening">題目</button>
            <button class="seg-tab" data-seg="lenormand">雷諾曼</button>
            <button class="seg-tab" data-seg="meihua">梅花易數</button>
            <button class="seg-tab" data-seg="astro">占星</button>
          </div>
          <div class="d-msg-text prompt-text">讀取中……</div>
          <div class="ask-chat">
            <div class="ask-hint">對這次的結果有疑問？直接問——會把當時的完整 prompt 與產出一併給模型當脈絡。</div>
            <div class="ask-log"></div>
            <div class="ask-row">
              <input type="text" class="ask-input" maxlength="1000" placeholder="例如：為什麼訊息說需要連線模式？這段建議是根據什麼？">
              <button class="btn small btn-ask">詢問</button>
            </div>
          </div>
        </div>
      </div>` : ''}
      <div class="d-line d-note"><b>標註</b>
        <input type="text" class="note-input" maxlength="300" placeholder="例如：我自己測試的訊息……" value="${esc(d.note || s.note || '')}">
        <button class="btn small btn-save-note">儲存標註</button>
        <span class="note-saved"></span>
      </div>
      <div class="d-actions-row">
        <button class="btn small danger btn-del">刪除這筆紀錄</button>
      </div>`;

    // Prompt 操作：分段檢視 / 複製目前段。
    // 「完整 Prompt」＝最後丟給模型的整串文字：System Prompt ＋ User Prompt 接續呈現。
    const copyPromptBtn = detail.querySelector('.btn-copy-prompt');
    if (copyPromptBtn) {
      const promptBox = detail.querySelector('.prompt-text');
      const segs = d.prompt.segments || {};
      let fullText = null; // 快取組合後的完整文字

      const buildFull = async () => {
        if (fullText != null) return fullText;
        let sys = '';
        try {
          const r = await api({ view: 'sysprompt', hash: d.prompt.sysHash || '' });
          sys = r.content || '（此版本的 system prompt 未留存——可能是舊紀錄）';
        } catch { sys = '（system prompt 讀取失敗）'; }
        fullText = [
          '════ System Prompt ════', '', sys, '',
          '════ User Prompt（接續於 system 之後送出） ════', '',
          d.prompt.prompt || '',
        ].join('\n');
        return fullText;
      };

      const segText = (key) => {
        if (key === 'opening') return segs.opening || '（此紀錄未含分段資料——舊版本）';
        const raw = segs[key];
        if (raw == null) return key === 'astro' ? '（使用者跳過占星）' : '（此紀錄未含分段資料——舊版本）';
        return raw;
      };

      let curSeg = 'full';
      const show = async (key) => {
        curSeg = key;
        detail.querySelectorAll('.seg-tab').forEach((t) => t.classList.toggle('on', t.dataset.seg === key));
        promptBox.textContent = key === 'full' ? '讀取中……' : segText(key);
        if (key === 'full') promptBox.textContent = await buildFull();
      };
      detail.querySelectorAll('.seg-tab').forEach((tab) => {
        tab.addEventListener('click', (e) => { e.stopPropagation(); show(tab.dataset.seg); });
      });
      show('full');

      copyPromptBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const text = curSeg === 'full' ? await buildFull() : segText(curSeg);
        navigator.clipboard.writeText(text).then(
          () => { copyPromptBtn.textContent = '已複製 ✓'; setTimeout(() => { copyPromptBtn.textContent = '複製此段'; }, 1800); },
          () => { copyPromptBtn.textContent = '失敗'; }
        );
      });

      // 除錯問答：帶著當時的 prompt 與產出脈絡，直接問 LLM
      const askLog = detail.querySelector('.ask-log');
      const askInput = detail.querySelector('.ask-input');
      const askBtn = detail.querySelector('.btn-ask');
      const askHistory = [];
      const appendMsg = (role, text) => {
        const div = document.createElement('div');
        div.className = 'ask-msg ' + role;
        div.textContent = text;
        askLog.appendChild(div);
        askLog.scrollTop = askLog.scrollHeight;
      };
      const sendAsk = async () => {
        const q = askInput.value.trim();
        if (!q || askBtn.disabled) return;
        askInput.value = '';
        askHistory.push({ role: 'user', content: q });
        appendMsg('user', q);
        askBtn.disabled = true;
        askBtn.textContent = '思考中…';
        try {
          const r = await api({}, { action: 'ask', sid: s.sid, messages: askHistory });
          askHistory.push({ role: 'assistant', content: r.reply });
          appendMsg('assistant', r.reply);
        } catch (err) {
          askHistory.pop(); // 失敗的提問不留在脈絡裡
          appendMsg('error', ({
            llm_not_configured: '（未設定 AI 金鑰——請在環境變數加入 OPENAI_API_KEY 或 ANTHROPIC_API_KEY）',
            llm_failed: '（模型呼叫失敗，請稍後再試）',
          })[err.code] || '（詢問失敗，請稍後再試）');
        }
        askBtn.disabled = false;
        askBtn.textContent = '詢問';
        askInput.focus();
      };
      askBtn.addEventListener('click', (e) => { e.stopPropagation(); sendAsk(); });
      askInput.addEventListener('click', (e) => e.stopPropagation());
      askInput.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Enter') sendAsk();
      });
    }

    // 儲存標註
    const noteInput = detail.querySelector('.note-input');
    const saveBtn = detail.querySelector('.btn-save-note');
    const savedTag = detail.querySelector('.note-saved');
    saveBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      saveBtn.disabled = true;
      try {
        const { note } = await api({}, { action: 'note', sid: s.sid, note: noteInput.value });
        s.note = note;
        tr.querySelector('.note-cell').innerHTML = esc(truncate(note, 12)) || '<span class="dim-dash">—</span>';
        tr.querySelector('.note-cell').title = note;
        savedTag.textContent = '已儲存 ✓';
        setTimeout(() => { savedTag.textContent = ''; }, 2000);
      } catch {
        savedTag.textContent = '儲存失敗';
      }
      saveBtn.disabled = false;
    });

    // 刪除紀錄
    detail.querySelector('.btn-del').addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!confirm('確定刪除這筆紀錄？（清單、題目、訊息、停留與標註都會移除，統計數字同步扣除）')) return;
      try {
        await api({}, { action: 'delete', sid: s.sid });
        allSessions = allSessions.filter((x) => x.sid !== s.sid);
        renderSessions();
        await refreshOverview(); // 刷新總覽（統計已回扣）
        await refreshFeedback();
        await refreshTimings();
      } catch {
        alert('刪除失敗，請重試。');
      }
    });
  } catch {
    detail.querySelector('td').textContent = '讀取失敗。';
  }
}

// 單筆的處理時間拆解（同一份資料也在上方「處理時間」表裡）
function timingDetail(tm) {
  if (!tm) return '（無紀錄——這筆是舊資料，或解讀沒有完成）';
  const bit = (label, v) => (v == null ? '' : `${label} ${fmtDur(v)}`);
  const llm = Array.isArray(tm.llmMs) && tm.llmMs.length ? tm.llmMs[0] : null;
  const main = [
    bit('使用者等待', tm.weavingMs),
    bit('LLM', llm),
    bit('組 prompt', tm.promptMs),
    bit('寫紀錄', tm.recordMs),
    bit('動畫等待', tm.holdMs),
  ].filter(Boolean).join('｜');
  const astro = [
    bit('星盤往返', tm.astroRoundTripMs),
    bit('查地點', tm.astroGeocodeMs),
    bit('星曆', tm.astroEphemerisMs),
  ].filter(Boolean).join('｜');
  const meta = [
    tm.model ? `模型 ${esc(tm.model)}` : '',
    tm.attempts > 1 ? `重試 ${tm.attempts} 次` : '',
    tm.promptChars ? `prompt ${tm.promptChars} 字` : '',
  ].filter(Boolean).join('｜');
  return `${main}${astro ? `<br><span class="astro-sub">占星：${astro}</span>` : ''}`
    + `${meta ? `<br><span class="astro-sub">${meta}</span>` : ''}`;
}

// 星盤紀錄的詳情呈現：出生輸入 + 解析結果 + 三要點
function astroDetail(j) {
  if (!j.astroUsed) return '未使用';
  const b = j.astroBirth;
  if (!b) return `已使用${j.astroSun ? `（太陽${esc(j.astroSun)}）` : ''}（此紀錄未含出生資料——舊版本）`;
  const birth = `${esc(b.date)} ${b.timeUnknown ? '（時間不確定）' : esc(b.time || '')}．${esc(b.city)}${b.country ? `（${esc(b.country)}）` : ''}`;
  const resolved = `${esc(b.resolved)}｜${esc(b.tz)}｜UTC ${esc(b.utc)}`;
  const big3 = [b.sun && `太陽${esc(b.sun)}`, b.moon && `月亮${esc(b.moon)}`, b.asc && `上升${esc(b.asc)}`].filter(Boolean).join('、');
  return `${birth}<br><span class="astro-sub">解析：${resolved}${big3 ? `｜${big3}` : ''}</span>`;
}

function truncate(s, n) {
  s = String(s || '');
  return s.length > n ? s.slice(0, n) + '…' : s;
}

// ---- 自動登入（同分頁重整） ----
(async function init() {
  if (pw()) {
    try { await enterDash(); return; } catch { sessionStorage.removeItem(PW_KEY); }
  }
  setTimeout(() => $('adminPw').focus(), 200);
})();

// ---- utils ----
function fmtTime(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
// 處理時間專用：毫秒級的階段用「毫秒」才看得出差別（fmtMs 會全部變成 0.0 秒）
function fmtDur(ms) {
  if (ms == null) return '—';
  if (ms < 1000) return Math.round(ms) + ' ms';
  if (ms < 60_000) return (ms / 1000).toFixed(1) + ' 秒';
  return (ms / 60_000).toFixed(1) + ' 分';
}
function fmtMs(ms) {
  if (ms >= 60_000) return (ms / 60_000).toFixed(1) + ' 分';
  return (ms / 1000).toFixed(1) + ' 秒';
}
function fmtBytes(b) {
  if (b >= 1024 * 1024 * 1024) return (b / (1024 ** 3)).toFixed(1) + ' GB';
  if (b >= 1024 * 1024) return (b / (1024 ** 2)).toFixed(1) + ' MB';
  if (b >= 1024) return (b / 1024).toFixed(1) + ' KB';
  return b + ' B';
}
function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
