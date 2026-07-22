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

// 使用紀錄：本地快取 + 篩選（未完成預設隱藏）
let allSessions = [];
let sessOffset = 0;
let exhausted = false;
const filters = { includeIncomplete: false, device: '', source: '' };

function pw() { return sessionStorage.getItem(PW_KEY) || ''; }

async function api(params) {
  const res = await fetch('/api/admin?' + new URLSearchParams(params), {
    headers: { authorization: 'Bearer ' + pw() },
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

async function enterDash() {
  const overview = await api({ view: 'overview' });
  document.querySelectorAll('.screen').forEach((s) => s.classList.remove('active'));
  $('adminDash').classList.add('active');
  renderOverview(overview);

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
}

// ---- 篩選 ----
$('fltIncomplete').addEventListener('change', (e) => { filters.includeIncomplete = e.target.checked; onFilterChange(); });
$('fltDevice').addEventListener('change', (e) => { filters.device = e.target.value; onFilterChange(); });
$('fltSource').addEventListener('change', (e) => { filters.source = e.target.value; onFilterChange(); });

async function onFilterChange() {
  renderSessions();
  // 篩選後畫面太空時，自動補抓幾頁
  if (visibleSessions().length < 20 && !exhausted) await loadMore();
}

function matchesFilters(s) {
  if (!filters.includeIncomplete && !s.hasJourney) return false;
  if (filters.device && s.device !== filters.device) return false;
  if (filters.source && s.src !== filters.source) return false;
  return true;
}

function visibleSessions() {
  return allSessions.filter(matchesFilters);
}

// ---- 總覽 ----
function renderOverview(o) {
  $('statRow').innerHTML = `
    <div class="stat"><b>${o.totalSessions}</b><span>累計來訪（近 5000 筆）</span></div>
    <div class="stat"><b>${Object.values(o.devices).reduce((a, b) => a + b, 0)}</b><span>裝置事件</span></div>
    <div class="stat"><b>${Object.keys(o.sources).length}</b><span>來源管道數</span></div>`;

  renderCountTable($('srcTable'), o.sources, '（尚無來源資料）');
  renderCountTable($('devTable'), mapKeys(o.devices, { mobile: '手機', desktop: '電腦', tablet: '平板' }), '（尚無裝置資料）');
  renderDwell(o.dwellAvgMs);
}

function mapKeys(obj, names) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) out[names[k] || k] = v;
  return out;
}

function renderCountTable(table, counts, emptyText) {
  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  const total = entries.reduce((a, [, n]) => a + n, 0) || 1;
  table.querySelector('tbody').innerHTML = entries.length
    ? entries.map(([k, n]) => `
      <tr><td>${esc(k)}</td><td class="num">${n}</td>
      <td class="bar-cell"><div class="bar" style="width:${Math.round((n / total) * 100)}%"></div><span>${Math.round((n / total) * 100)}%</span></td></tr>`).join('')
    : `<tr><td class="empty">${emptyText}</td></tr>`;
}

function renderDwell(avg) {
  const order = ['screenIntake', 'screenSpread', 'screenNumbers', 'screenWeaving', 'screenResult', 'screenCare'];
  const entries = order.filter((k) => avg[k] != null);
  if (!entries.length) { $('dwellBars').innerHTML = '<div class="empty">（尚無停留資料）</div>'; return; }
  const max = Math.max(...entries.map((k) => avg[k])) || 1;
  $('dwellBars').innerHTML = entries.map((k) => `
    <div class="dwell-row">
      <span class="dwell-name">${SCREEN_LABELS[k] || k}</span>
      <div class="dwell-track"><div class="bar" style="width:${Math.round((avg[k] / max) * 100)}%"></div></div>
      <span class="dwell-val">${fmtMs(avg[k])}</span>
    </div>`).join('');
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

function renderSessions() {
  const tbody = $('sessTable').querySelector('tbody');
  tbody.innerHTML = '';
  const visible = visibleSessions();

  if (!visible.length) {
    tbody.innerHTML = `<tr><td colspan="5" class="empty">${
      allSessions.length
        ? '（目前的篩選條件下沒有紀錄——試著勾選「包含未完成的來訪」或放寬條件）'
        : '（尚無來訪紀錄）'
    }</td></tr>`;
  }

  for (const s of visible) {
    const tr = document.createElement('tr');
    tr.className = 'sess-row';
    tr.innerHTML = `
      <td>${fmtTime(s.ts)}</td>
      <td><code>${esc(s.vid)}</code></td>
      <td>${esc(s.src)}</td>
      <td>${esc({ mobile: '手機', desktop: '電腦', tablet: '平板' }[s.device] || s.device)} · ${esc(s.os)}</td>
      <td>${s.hasJourney ? '<span class="badge">有題目</span>' : '<span class="badge dim">未完成</span>'}</td>`;
    tr.addEventListener('click', () => toggleDetail(tr, s));
    tbody.appendChild(tr);
  }

  $('fltCount').textContent = `顯示 ${visible.length} 筆／已載入 ${allSessions.length} 筆`;
  $('btnMore').style.display = exhausted ? 'none' : 'inline-block';
}

async function toggleDetail(tr, s) {
  const existing = tr.nextElementSibling;
  if (existing && existing.classList.contains('sess-detail')) { existing.remove(); return; }

  const detail = document.createElement('tr');
  detail.className = 'sess-detail';
  detail.innerHTML = '<td colspan="5" class="detail-cell">讀取中……</td>';
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
        <div class="d-line"><b>產出</b>${esc(j.title || '—')}${j.offline ? '（離線模板）' : ''}</div>
        ${j.message ? `
        <div class="d-line d-message"><b>訊息</b><div class="d-msg-text">${esc(j.message)}${j.closing ? `\n\n— ${esc(j.closing)}` : ''}</div></div>` : ''}
      ` : '<div class="d-line"><b>題目</b>（此次來訪未完成體驗）</div>'}
      <div class="d-line"><b>停留</b>${dwell || '—'}</div>`;
  } catch {
    detail.querySelector('td').textContent = '讀取失敗。';
  }
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
function fmtMs(ms) {
  if (ms >= 60_000) return (ms / 60_000).toFixed(1) + ' 分';
  return (ms / 1000).toFixed(1) + ' 秒';
}
function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
