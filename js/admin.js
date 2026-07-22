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

// 使用紀錄：本地快取 + 篩選（未完成預設隱藏）+ 多選刪除
let allSessions = [];
let sessOffset = 0;
let exhausted = false;
const filters = { includeIncomplete: false, device: '', source: '' };
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

// ---- 總覽（圓餅圖） ----
const PIE_COLORS = ['#c9b98a', '#8fa3c7', '#b07a5f', '#9a8fc7', '#7fb39a', '#c78f9b', '#6d675c'];

function renderOverview(o) {
  $('statRow').innerHTML = `
    <div class="stat"><b>${o.totalSessions}</b><span>累計來訪（近 5000 筆）</span></div>
    <div class="stat"><b>${Object.values(o.devices).reduce((a, b) => a + b, 0)}</b><span>裝置事件</span></div>
    <div class="stat"><b>${Object.keys(o.sources).length}</b><span>來源管道數</span></div>`;

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
    tbody.innerHTML = `<tr><td colspan="7" class="empty">${
      allSessions.length
        ? '（目前的篩選條件下沒有紀錄——試著勾選「包含未完成的來訪」或放寬條件）'
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
      <td>${s.hasJourney ? '<span class="badge">有題目</span>' : '<span class="badge dim">未完成</span>'}</td>
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
    await api({}, { action: 'delete', sids: [...selected] });
    allSessions = allSessions.filter((s) => !selected.has(s.sid));
    selected.clear();
    renderSessions();
    const overview = await api({ view: 'overview' });
    renderOverview(overview);
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
  detail.innerHTML = '<td colspan="7" class="detail-cell">讀取中……</td>';
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
      <div class="d-line"><b>停留</b>${dwell || '—'}</div>
      <div class="d-line d-note"><b>標註</b>
        <input type="text" class="note-input" maxlength="300" placeholder="例如：我自己測試的訊息……" value="${esc(d.note || s.note || '')}">
        <button class="btn small btn-save-note">儲存標註</button>
        <span class="note-saved"></span>
      </div>
      <div class="d-actions-row">
        <button class="btn small danger btn-del">刪除這筆紀錄</button>
      </div>`;

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
        // 刷新總覽（統計已回扣）
        const overview = await api({ view: 'overview' });
        renderOverview(overview);
      } catch {
        alert('刪除失敗，請重試。');
      }
    });
  } catch {
    detail.querySelector('td').textContent = '讀取失敗。';
  }
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
function fmtMs(ms) {
  if (ms >= 60_000) return (ms / 60_000).toFixed(1) + ' 分';
  return (ms / 1000).toFixed(1) + ' 秒';
}
function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
