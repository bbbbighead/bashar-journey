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
// 訪客標註（vid → 「這是誰」），由 sessions 回應整張帶回。放模組層而不是每列
// 各自存：同一位訪客會出現在很多列，改一次名字要全部一起變。
let vidLabels = {};
let sessOffset = 0;
let exhausted = false;
const filters = { scope: 'complete', device: '', source: '', lang: '', country: '', vid: '' };
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
  const overview = await api({
    view: 'overview', scope: filters.scope,
    // 日界照瀏覽器當地時間切（getTimezoneOffset 是「西為正」，取負變成東為正）
    tz: String(-new Date().getTimezoneOffset()),
  });
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

  // 語言下拉：同樣以總覽的語系清單填充，並依筆數多寡排序
  const langSel = $('fltLang');
  langSel.length = 1;
  for (const [code] of topEntries(overview.langs || {}, 20)) {
    const opt = document.createElement('option');
    opt.value = code; opt.textContent = LANG_LABEL[code] || code;
    langSel.appendChild(opt);
  }

  // 地區下拉：同上，國碼轉成國名顯示
  const geoSel = $('fltGeo');
  geoSel.length = 1;
  for (const [code] of topEntries(overview.countries || {}, 30)) {
    const opt = document.createElement('option');
    opt.value = code; opt.textContent = regionName(code);
    geoSel.appendChild(opt);
  }

  allSessions = [];
  sessOffset = 0;
  exhausted = false;
  await loadMore();
  // 回饋與處理時間改為「第一次打開該分頁才抓」——見 showTab()
}

// ---- 分頁 ----
// 只有總覽與使用紀錄吃「資料範圍」，其他分頁把那條列隱藏起來，
// 免得使用者以為切了範圍卻沒反應。
const SCOPED_TABS = new Set(['overview', 'sessions']);
const tabLoaded = { feedback: false, timings: false, oracles: false };

function showTab(name) {
  document.querySelectorAll('.a-tab-btn').forEach((b) => {
    const on = b.dataset.tab === name;
    b.classList.toggle('on', on);
    b.setAttribute('aria-selected', on ? 'true' : 'false');
  });
  document.querySelectorAll('.a-pane').forEach((p) => {
    p.classList.toggle('on', p.dataset.pane === name);
  });
  $('scopeBar').hidden = !SCOPED_TABS.has(name);
  // 第一次打開才抓資料：開後台不必等這兩支 API
  if (name === 'feedback' && !tabLoaded.feedback) {
    tabLoaded.feedback = true;
    refreshFeedback();
  }
  if (name === 'timings' && !tabLoaded.timings) {
    tabLoaded.timings = true;
    refreshTimings();
  }
  if (name === 'oracles' && !tabLoaded.oracles) {
    tabLoaded.oracles = true;
    refreshOracles();
  }
}

$('aTabs').addEventListener('click', (e) => {
  const btn = e.target.closest('.a-tab-btn');
  if (btn) showTab(btn.dataset.tab);
});


// ---- 篩選 ----
// 資料範圍：一次切換總覽統計、三張圓餅圖與使用紀錄清單
$('fltScope').addEventListener('change', async (e) => {
  filters.scope = e.target.value;
  // 來訪次數是伺服器依 scope 算出來的，所以換範圍要重抓，不能只在本地重新過濾——
  // 否則 badge 會停在舊範圍的次數，跟清單對不起來。
  allSessions = [];
  sessOffset = 0;
  exhausted = false;
  selected.clear();
  renderSessions();
  try { await refreshOverview(); } catch { /* 保留原統計 */ }
  await loadMore();
});
$('fltDevice').addEventListener('change', (e) => { filters.device = e.target.value; onFilterChange(); });
$('fltSource').addEventListener('change', (e) => { filters.source = e.target.value; onFilterChange(); });
$('fltLang').addEventListener('change', (e) => { filters.lang = e.target.value; onFilterChange(); });
$('fltGeo').addEventListener('change', (e) => { filters.country = e.target.value; onFilterChange(); });

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
  if (filters.lang && (s.lang || '(unknown)') !== filters.lang) return false;
  if (filters.country && (s.country || '(unknown)') !== filters.country) return false;
  if (filters.vid && s.vid !== filters.vid) return false;
  return true;
}

// 只看某一位訪客：點列表裡的訪客 ID 就會套用。
// 注意這是在「已載入的紀錄」上過濾，所以會自動往後多抓幾頁
// （onFilterChange 會補抓），但若該訪客最早的紀錄還沒載入就看不到，
// 所以下面的提示會標明目前載入了幾筆。
function setVidFilter(vid) {
  filters.vid = filters.vid === vid ? '' : vid;
  onFilterChange();
}

// 語言修正上線的時間（本機時區）。「修正舊紀錄的語言」以此為預設的時間上限：
// 這之後的紀錄記的已經是正確的介面語言，不該被批次改寫蓋掉。
const LANG_FIX_DEPLOYED_AT = new Date('2026-08-02T22:00:00+08:00').getTime();

// 語系代碼 → 中文標籤。i18n 只有四個語系，(unknown) 是舊紀錄沒存 lang 的情況。
const LANG_LABEL = {
  'zh-Hant': '繁體中文', en: 'English', ja: '日本語', ko: '한국어',
  '(unknown)': '（未知）',
};

// 國碼 → 繁體中文國名。不硬編一張對照表（跟 data/countries.js 同一個原則）：
// 交給 Intl.DisplayNames 產生，環境不支援時就顯示原始國碼。
// (unknown) 是這個功能上線前的舊紀錄，那時候還沒有記國碼。
const REGION_NAMES = (() => {
  try { return new Intl.DisplayNames(['zh-Hant'], { type: 'region' }); } catch { return null; }
})();
const regionCache = new Map();
// 只有國名（「台灣」）：給清單的欄位用，那裡每一格的寬度都很吃緊
function regionShort(code) {
  if (!code || code === '(unknown)') return '（未知）';
  if (regionCache.has(code)) return regionCache.get(code);
  let name = code;
  // 查不到時 Intl 會原樣回傳（fallback: 'code' 是預設行為），也可能直接丟錯
  try { name = REGION_NAMES ? (REGION_NAMES.of(code) || code) : code; } catch { name = code; }
  regionCache.set(code, name);
  return name;
}
// 國名＋國碼（「台灣（TW）」）：給分布圖與下拉用，那裡看得到代碼比較好對照。
// 查不到國名時不重複顯示代碼。
function regionName(code) {
  const name = regionShort(code);
  return (!code || code === '(unknown)' || name === code) ? name : `${name}（${code}）`;
}

// 工具代碼 → 中文標籤（後台一律繁體中文）
const TOOL_LABEL = {
  lenormand: '雷諾曼牌陣', meihua: '梅花易數', astro: '西洋占星',
  bazi: '八字', ziwei: '紫微斗數', tarot: '塔羅牌',
};
const toolText = (s) => (Array.isArray(s.tools) && s.tools.length
  ? s.tools.map((x) => TOOL_LABEL[x] || x).join('、')
  : '');

// 「字數」欄一律數字元：中日韓 1 個字＝1 個字元，數字可以直接對上 prompt 裡的
// 規定；但 api/insight.js 對英文的規定是寫 words 的（雷諾曼無上限、梅花 1000
// words、占星 1800 words），而同一段英文的字元數大約是 words 的五倍——只看
// 字元數會把正常長度誤判成爆量。所以英文紀錄旁邊加註 words。
// 新紀錄是產生當下實算的；舊紀錄沒有這個欄位，用字元數推估並標 ≈ 以示區別。
const CHARS_PER_EN_WORD = 5;   // 英文去掉空白後，平均約 5 個字元一個字
function wordsNote(s) {
  if (s.lang !== 'en') return '';
  if (Number.isFinite(s.msgWords)) {
    return `<span class="chars-w" title="實算的 words。英文的篇幅規定以 words 計">（${s.msgWords.toLocaleString()} w）</span>`;
  }
  if (!Number.isFinite(s.msgChars)) return '';
  const est = Math.round(s.msgChars / CHARS_PER_EN_WORD);
  return `<span class="chars-w" title="舊紀錄沒有實算的 words，由字元數推估（約 ${CHARS_PER_EN_WORD} 字元 ≒ 1 word）">（≈${est.toLocaleString()} w）</span>`;
}

// 排序狀態（點表頭切換 遞增／遞減）。預設依時間新到舊。
let sort = { key: 'ts', dir: 'desc' };

// 各欄的排序鍵值（統一成可比較的字串或數字）
const SORT_VALUE = {
  ts: (s) => Number(s.ts) || 0,
  vid: (s) => String(s.vid || ''),
  src: (s) => String(s.src || ''),
  device: (s) => `${s.device || ''} ${s.os || ''}`,
  lang: (s) => String(s.lang || ''),
  country: (s) => String(s.country || ''),
  topic: (s) => String(s.topic || ''),
  tools: (s) => toolText(s),
  // 未完成（沒有產出）的排在最後，不跟 0 字混在一起
  msgChars: (s) => (Number.isFinite(s.msgChars) ? s.msgChars : -1),
  // 先按該訪客的總來訪次數，再按這是第幾次——回訪最多的人會聚在一起
  visitNo: (s) => (Number(s.visitTotal) || 1) * 1000 + (Number(s.visitNo) || 1),
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
  const v = o.visitors || { unique: 0, returning: 0, repeatPct: 0 };
  $('statRow').innerHTML = `
    <div class="stat"><b>${o.totalSessions}</b><span>${scopeLabel}</span></div>
    <div class="stat"><b>${v.unique}</b><span>不重複訪客</span></div>
    <div class="stat" title="次數：今天的來訪次數，同一人來兩次算 2 次。訪客數：今天來過的不重複訪客（依瀏覽器辨識，換裝置或無痕會被算成新訪客，所以是下限）。兩個數字都跟著上方「資料範圍」的選擇走。">
      <b>${(o.daily && o.daily.length ? o.daily[o.daily.length - 1].visits : 0)}</b>
      <span>今日來訪次數<br><i class="stat-note">${(o.daily && o.daily.length ? o.daily[o.daily.length - 1].visitors : 0)} 位不重複訪客</i></span></div>
    <div class="stat" title="vid 只認得出「同一個瀏覽器」：換裝置、無痕、清資料，以及 iOS Safari 7 天未回訪清掉 localStorage，都會讓回訪者看起來像新訪客。所以這是下限。">
      <b>${v.repeatPct}%</b><span>回訪率（${v.returning} 人回訪過）<br><i class="stat-note">下限，實際更高</i></span>
    </div>
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
  renderPie($('langChart'), topEntries(mapKeys(o.langs || {}, LANG_LABEL), 6), (v) => `${v} 次`, '（尚無語言資料）');
  renderPie($('geoChart'), topEntries(o.countries || {}, 8).map(([c, v]) => [regionName(c), v]), (v) => `${v} 次`, '（尚無地區資料）');
  bindLangFix();

  const order = ['screenIntake', 'screenSpread', 'screenNumbers', 'screenWeaving', 'screenResult', 'screenCare'];
  const dwellEntries = order
    .filter((k) => o.dwellAvgMs[k] > 0)
    .map((k) => [SCREEN_LABELS[k] || k, o.dwellAvgMs[k]]);
  renderPie($('dwellChart'), dwellEntries, fmtMs, '（尚無停留資料）');
  trendDaily = o.daily || [];
  renderTrend();
}

// ---- 一次性資料修正：補正舊紀錄的語言 ----
// 流程刻意是兩步的：先「試算」看會改幾筆、原本各是什麼語系，確認數字才准寫入。
// 這種批次改寫沒有回復按鈕，所以寧可多按一次。
let fixBound = false;
function bindLangFix() {
  const dry = $('btnFixDry');
  const apply = $('btnFixApply');
  const note = $('fixNote');
  const beforeEl = $('fixBefore');
  if (!dry || !apply || fixBound) return;
  fixBound = true;

  // 預設時間上限＝語言修正上線的時間。之後的紀錄是正確的，不該被蓋掉。
  if (!beforeEl.value) {
    const d = new Date(LANG_FIX_DEPLOYED_AT);
    const p = (n) => String(n).padStart(2, '0');
    beforeEl.value = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  const params = () => {
    const before = new Date(beforeEl.value).getTime();
    if (!Number.isFinite(before)) return null;
    return { action: 'backfill_lang', lang: $('fixLang').value, before };
  };
  const describe = (r) => {
    const was = Object.entries(r.wasLang || {})
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${LANG_LABEL[k] || k} ${v}`).join('、');
    return `掃描 ${r.scanned} 筆，時間上限內 ${r.matched} 筆`
      + `（原本：${was || '—'}）；${r.dryRun ? '會改' : '已改'} ${r.changed} 筆`
      + `，上限之後的 ${r.skippedNewer} 筆不動。`;
  };

  dry.addEventListener('click', async () => {
    const q = params();
    if (!q) { note.textContent = '請先選一個有效的時間上限。'; return; }
    dry.disabled = true; note.textContent = '試算中……';
    try {
      const r = await api({}, { ...q, dryRun: true });
      note.textContent = describe(r);
      apply.disabled = r.changed === 0;
      apply.dataset.q = JSON.stringify(q);   // 確認寫入時用「試算過的那組條件」
    } catch (e) {
      note.textContent = '試算失敗：' + (e.code || e.message || '未知錯誤');
    } finally { dry.disabled = false; }
  });

  apply.addEventListener('click', async () => {
    const q = apply.dataset.q ? JSON.parse(apply.dataset.q) : null;
    if (!q) return;
    if (!confirm('這會直接改寫來訪紀錄，沒有復原功能。確定要寫入嗎？')) return;
    apply.disabled = true; note.textContent = '寫入中……';
    try {
      const r = await api({}, { ...q, dryRun: false });
      note.textContent = describe(r);
      delete apply.dataset.q;
      allSessions = []; sessOffset = 0; exhausted = false;
      await refreshOverview();
      await loadMore();
    } catch (e) {
      note.textContent = e.code === 'list_changed_retry'
        ? '寫入期間有新的來訪進來，為了不寫錯位置已中止——請再按一次「試算」重來。'
        : '寫入失敗：' + (e.code || e.message || '未知錯誤');
      apply.disabled = false;
    }
  });
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
// 來訪趨勢：單一序列的直條圖（inline SVG、無相依）。
// 單一序列不需要圖例；精確數字放在每根 bar 的 <title>（滑過顯示）與今日的
// 直接標籤上。金色沿用站上的 accent，深淺只用來標「今天」這一根（註記，
// 不是第二個序列）。
document.getElementById('trendRange')?.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-days]');
  if (!btn) return;
  trendDays = Number(btn.dataset.days) || 30;
  document.querySelectorAll('#trendRange [data-days]').forEach((b) => b.classList.toggle('on', b === btn));
  renderTrend();
});
let trendDaily = [];
let trendDays = 30;

function renderTrend() {
  const host = $('trendChart');
  if (!host) return;
  const data = trendDaily.slice(-trendDays);
  if (!data.length || data.every((d) => !d.visits)) {
    host.innerHTML = '<p class="dim">（這段期間沒有來訪）</p>';
    return;
  }
  const W = 640, H = 170, PAD_L = 34, PAD_B = 22, PAD_T = 14;
  const plotW = W - PAD_L - 6, plotH = H - PAD_T - PAD_B;
  const max = Math.max(...data.map((d) => d.visits), 1);
  // Y 軸取「漂亮階距」：1／2／5 ×10ⁿ，抓約 4 條格線，刻度永遠是整數
  const rawStep = max / 4;
  const pow = 10 ** Math.floor(Math.log10(Math.max(1, rawStep)));
  const yStep = Math.max(1, [1, 2, 5, 10].map((m) => m * pow).find((v) => v >= rawStep));
  const yTop = Math.max(yStep, Math.ceil(max / yStep) * yStep);
  const yOf = (v) => PAD_T + plotH - (v / yTop) * plotH;
  const step = plotW / data.length;
  const bw = Math.max(3, Math.min(26, step - 2));   // 2px 間隙
  const maxIdx = data.reduce((m, d, i) => (d.visits > data[m].visits ? i : m), 0);
  const fmtDay = (iso) => `${Number(iso.slice(5, 7))}/${Number(iso.slice(8, 10))}`;

  // 格線與左側刻度（0 不畫——基線就是 0）
  let grid = '';
  for (let v = yStep; v <= yTop; v += yStep) {
    grid += `<line class="tr-grid faint" x1="${PAD_L}" y1="${yOf(v).toFixed(1)}" x2="${W - 6}" y2="${yOf(v).toFixed(1)}"></line>
      <text class="tr-lab" x="${PAD_L - 6}" y="${(yOf(v) + 3.5).toFixed(1)}" text-anchor="end">${v}</text>`;
  }

  const bars = data.map((d, i) => {
    const h = Math.round((d.visits / yTop) * plotH);
    const x = PAD_L + i * step + (step - bw) / 2;
    const y = PAD_T + plotH - h;
    const isToday = i === data.length - 1;
    const cx = (x + bw / 2).toFixed(1);
    // 今日＝亮金、其餘深金；rx=2 圓角只留在頂端（底端貼齊基線）。
    // 每組多兩個東西：整條直欄的透明命中區（滑過不必精準對到細 bar），
    // 與滑過才顯示的數字（.tr-hval，CSS 控制；今天與峰值的常駐標籤在
    // 滑過那一組時隱藏，避免同位置疊字）。
    return `<g class="tr-bar"><title>${fmtDay(d.day)}｜${d.visits} 次・${d.visitors} 人</title>
      <rect class="tr-hit" x="${(PAD_L + i * step).toFixed(1)}" y="${PAD_T}" width="${step.toFixed(1)}" height="${plotH}" fill="transparent"></rect>
      <rect class="tr-fill" x="${x.toFixed(1)}" y="${d.visits ? y : PAD_T + plotH - 1}" width="${bw.toFixed(1)}"
        height="${d.visits ? h : 1}" rx="2"
        fill="${isToday ? 'var(--accent)' : 'var(--accent-dim)'}"
        opacity="${d.visits ? (isToday ? 1 : 0.75) : 0.25}"></rect>
      ${(isToday || (i === maxIdx && d.visits)) && d.visits
    ? `<text class="tr-val" x="${cx}" y="${y - 4}" text-anchor="middle">${d.visits}</text>` : ''}
      <text class="tr-hval" x="${cx}" y="${(d.visits ? y : PAD_T + plotH - 1) - 4}" text-anchor="middle">${d.visits}</text>
    </g>`;
  }).join('');

  // X 軸標籤：頭、尾＋大約每 5～7 天一個，避免 30 天時擠成一團
  const every = trendDays > 14 ? 5 : 1;
  const labels = data.map((d, i) => {
    if (i !== 0 && i !== data.length - 1 && i % every !== 0) return '';
    if (i !== data.length - 1 && data.length - 1 - i < every && i !== 0) return '';   // 避免撞到「今天」
    const x = PAD_L + i * step + step / 2;
    return `<text class="tr-lab" x="${x.toFixed(1)}" y="${H - 6}" text-anchor="middle">${
      i === data.length - 1 ? '今天' : fmtDay(d.day)}</text>`;
  }).join('');

  host.innerHTML = `<svg class="trend-svg" viewBox="0 0 ${W} ${H}" role="img"
      aria-label="最近 ${trendDays} 天每日來訪">
    ${grid}
    <line class="tr-grid" x1="${PAD_L}" y1="${PAD_T + plotH}" x2="${W - 6}" y2="${PAD_T + plotH}"></line>
    ${bars}${labels}
  </svg>`;
}

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

// ---- 結果頁預覽 ----

// 後台只存了解讀的「純文字合併版」（js/analytics.js 把 sections 用
// 「【工具代碼】\n內容」接起來），要重現使用者看到的畫面就得把它拆回 sections。
//
// 只認「整行剛好是【lenormand】這種工具代碼」的行當作分隔，不是看到全形方括號
// 就切——解讀內文本身可能出現【…】（例如引用），那些必須留在內文裡。
const PREVIEW_TOOLS = ['lenormand', 'meihua', 'astro', 'synthesis'];
const SECTION_MARK = new RegExp(`^【(${PREVIEW_TOOLS.join('|')})】$`);

function parseSections(message) {
  const text = String(message || '');
  if (!text.trim()) return [];
  const lines = text.split('\n');
  const out = [];
  let cur = null;
  for (const line of lines) {
    const m = line.trim().match(SECTION_MARK);
    if (m) {
      if (cur) out.push({ tool: cur.tool, content: cur.buf.join('\n').trim() });
      cur = { tool: m[1], buf: [] };
      continue;
    }
    if (cur) cur.buf.push(line);
  }
  if (cur) out.push({ tool: cur.tool, content: cur.buf.join('\n').trim() });
  return out;
}

// journey → 可以餵給結果頁的 session 物件。
// 星盤本身沒有存（只有出生資料），所以 astro 欄位留給預覽頁自己重算。
const MESSAGE_CAP = 4000; // 與 api/track.js 的 slice(0, 4000) 一致

function buildPreviewSession(j) {
  const sections = parseSections(j.message);
  // 沒有任何工具標記：舊格式（analytics 在沒有 sections 時會退回 a.message）。
  // 這種情況把全文當成第一個工具那一節，總比什麼都不顯示好。
  if (!sections.length && String(j.message || '').trim()) {
    const tool = (Array.isArray(j.tools) && j.tools[0]) || 'lenormand';
    sections.push({ tool, content: String(j.message).trim() });
  }
  return {
    version: 3,
    runId: 'preview',
    status: 'done',
    opening: j.opening || '',
    tools: Array.isArray(j.tools) && j.tools.length ? j.tools : sections.map((x) => x.tool),
    cards: Array.isArray(j.cards) ? j.cards : [],       // 牌名，預覽頁再對回牌卡資料
    numbers: Array.isArray(j.numbers) ? j.numbers : null,
    astroBirth: j.astroBirth || null,
    analysis: { title: j.title || '', sections },
    // 提醒預覽頁哪些東西不是原汁原味
    previewNotes: {
      truncated: String(j.message || '').length >= MESSAGE_CAP,
      astroRecalc: !!(Array.isArray(j.tools) && j.tools.includes('astro')),
    },
  };
}

// ---- 使用紀錄 ----
$('btnMore').addEventListener('click', loadMore);

async function fetchPage() {
  // 帶上 scope：來訪次數要依使用者選的資料範圍計算（見 api/admin.js 的 inScope）
  const { sessions, vidLabels: labels } = await api({
    view: 'sessions', offset: String(sessOffset), scope: filters.scope,
  });
  Object.assign(vidLabels, labels || {});
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
      // 第一次點某欄時的方向：數量型的欄位從大到小才有意義
      // （點「回訪」是想找回頭客，不是想看一堆「首次」）
      const DESC_FIRST = new Set(['ts', 'visitNo', 'feedback']);
      if (sort.key === key) sort.dir = sort.dir === 'asc' ? 'desc' : 'asc';
      else sort = { key, dir: DESC_FIRST.has(key) ? 'desc' : 'asc' };
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
    tbody.innerHTML = `<tr><td colspan="14" class="empty">${
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
    tr.dataset.sid = s.sid;   // 供測試與日後的深連結定位用
    tr.innerHTML = `
      <td class="chk-col"><input type="checkbox" class="row-chk" ${selected.has(s.sid) ? 'checked' : ''}></td>
      <td>${fmtTime(s.ts)}</td>
      <td class="vid-cell">${vidLabels[s.vid]
    ? `<span class="vid-label" title="你的標註（點筆型圖示可改）">（${esc(vidLabels[s.vid])}）</span>` : ''}
        <span class="vid-row"><button type="button" class="vid-btn${filters.vid === s.vid ? ' on' : ''}"
        title="只看這位訪客的紀錄（再點一次取消）"><code>${esc(s.vid)}</code></button><button
        type="button" class="vid-edit" title="標註這位訪客是誰（例如：我自己、測試員）">✎</button></span></td>
      <td class="visit-cell">${s.visitTotal > 1
        ? `<button type="button" class="badge repeat visit-btn"
            title="展開這位訪客的 ${s.visitTotal} 次來訪，看每次聊了什麼">第 ${s.visitNo} / ${s.visitTotal} 次</button>`
        : '<span class="dim-dash">首次</span>'}</td>
      <td>${esc(s.src)}</td>
      <td>${esc({ mobile: '手機', desktop: '電腦', tablet: '平板' }[s.device] || s.device)}${
        s.os ? ` · ${esc(s.os)}` : ''}</td>
      <td class="lang-cell">${s.lang ? esc(LANG_LABEL[s.lang] || s.lang) : '<span class="dim-dash">—</span>'}</td>
      <td class="geo-cell" title="${esc(s.country ? regionName(s.country) : '')}">${
        s.country ? esc(regionShort(s.country)) : '<span class="dim-dash">—</span>'}</td>
      <td class="topic-cell" title="${esc(s.topic || '')}">${esc(truncate(s.topic, 12)) || '<span class="dim-dash">—</span>'}</td>
      <td>${toolText(s) ? `<span class="tool-tag">${esc(toolText(s))}</span>` : '<span class="dim-dash">—</span>'}</td>
      <td class="chars-cell">${Number.isFinite(s.msgChars)
        ? `${s.msgChars.toLocaleString()}${
          // 新紀錄是精確的分析本文字數（不含標題與配置行），沒有上限問題。
          // 只有舊紀錄要退回 message.length，那個寫入時截在 4000，所以標 +。
          s.msgCharsExact === false && s.msgChars >= 4000
            ? '<span class="chars-cap" title="舊紀錄：只能由截斷在 4000 字的內容回推，實際產出可能更長">+</span>' : ''}${
          wordsNote(s)}`
        : '<span class="dim-dash">—</span>'}</td>
      <td class="fb-cell" title="${esc(s.feedback ? `${s.feedback.rating} 星${s.feedback.text ? `：${s.feedback.text}` : ''}` : '')}">${
        s.feedback
          ? `<span class="fb-stars-cell">${STARS(s.feedback.rating)}</span>${s.feedback.text ? `<span class="fb-has-text" title="有留言">✎</span>` : ''}`
          : '<span class="dim-dash">—</span>'
      }</td>
      <td class="note-cell" title="${esc(s.note || '')}">${esc(truncate(s.note, 12)) || '<span class="dim-dash">—</span>'}</td>
      <td class="prev-cell">${s.hasJourney
        ? `<button type="button" class="btn small prev-btn" title="用這一次的紀錄重現使用者看到的結果頁">預覽</button>`
        : '<span class="dim-dash">—</span>'}</td>`;

    const vidEdit = tr.querySelector('.vid-edit');
    vidEdit.addEventListener('click', async (e) => {
      e.stopPropagation();
      // prompt 而不是行內輸入框：這是站主自用的低頻操作，一個原生對話框
      // 就夠了，省去在表格列裡塞編輯狀態的複雜度。空字串＝清除標註。
      const cur = vidLabels[s.vid] || '';
      const input = window.prompt(`這位訪客（${s.vid}）是誰？\n留空並確定＝清除標註`, cur);
      if (input === null || input.trim() === cur) return;   // 取消或沒改
      try {
        const { label } = await api({}, { action: 'vid_label', vid: s.vid, label: input.trim() });
        if (label) vidLabels[s.vid] = label; else delete vidLabels[s.vid];
        renderSessions();   // 同一位訪客的每一列一起更新
      } catch {
        window.alert('標註儲存失敗，請再試一次。');
      }
    });
    const vidBtn = tr.querySelector('.vid-btn');
    vidBtn.addEventListener('click', (e) => {
      e.stopPropagation();                // 點訪客不展開詳情
      setVidFilter(s.vid);
    });

    const visitBtn = tr.querySelector('.visit-btn');
    if (visitBtn) {
      visitBtn.addEventListener('click', (e) => {
        e.stopPropagation();              // 點次數不展開該筆的詳情
        toggleVisitList(tr, s);
      });
    }

    const prevBtn = tr.querySelector('.prev-btn');
    if (prevBtn) {
      prevBtn.addEventListener('click', (e) => {
        e.stopPropagation();              // 點預覽不展開詳情
        openPreview(s);
      });
    }

    const chk = tr.querySelector('.row-chk');
    chk.addEventListener('click', (e) => e.stopPropagation()); // 勾選不展開詳情
    chk.addEventListener('change', () => {
      if (chk.checked) selected.add(s.sid); else selected.delete(s.sid);
      updateBulkBar();
    });
    tr.addEventListener('click', () => toggleDetail(tr, s));
    tbody.appendChild(tr);
  }

  // 訪客過濾時要說清楚只在已載入的紀錄裡找——不然會誤以為這就是他的全部紀錄
  $('fltCount').textContent = filters.vid
    ? `只看訪客 ${filters.vid}${vidLabels[filters.vid] ? `（${vidLabels[filters.vid]}）` : ''}：${visible.length} 筆（在已載入的 ${allSessions.length} 筆之中${exhausted ? '，已是全部' : '，可按「載入更多」往前找'}）`
    : `顯示 ${visible.length} 筆／已載入 ${allSessions.length} 筆`;
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

// 點「第 N 次」展開這位訪客的每一次來訪與各次的題目。
// 資料是向伺服器另外抓的（view=visitor），所以拿得到的是**全部**來訪，
// 不像列表的訪客過濾只在已載入的幾頁裡找。範圍跟著目前的「資料範圍」。
async function toggleVisitList(tr, s) {
  const next = tr.nextElementSibling;
  if (next && next.classList.contains('visit-list-row')) { next.remove(); return; }
  // 同一列若已展開「單筆詳情」，先收掉，免得兩塊疊在一起
  if (next && next.classList.contains('sess-detail')) next.remove();

  const row = document.createElement('tr');
  row.className = 'visit-list-row';
  row.innerHTML = '<td colspan="14" class="detail-cell">讀取中……</td>';
  tr.after(row);

  let d;
  try {
    d = await api({ view: 'visitor', vid: s.vid, scope: filters.scope });
  } catch {
    row.innerHTML = '<td colspan="14" class="detail-cell">（讀取失敗）</td>';
    return;
  }

  const scopeNote = { complete: '僅計有題目的來訪', incomplete: '僅計未完成的來訪' }[d.scope]
    || '計入全部來訪';
  const items = d.visits.map((v) => `
    <li class="vl-item${v.sid === s.sid ? ' now' : ''}" data-sid="${esc(v.sid)}"
      role="button" tabindex="0" title="展開這一次的完整內容">
      <span class="vl-no">第 ${v.visitNo} / ${d.total} 次</span>
      <span class="vl-time">${fmtTime(v.ts)}</span>
      <span class="vl-topic" title="${esc(v.topic || '')}">${
        v.topic ? esc(truncate(v.topic, 28)) : '<span class="dim-dash">（沒有留下題目）</span>'}</span>
      <span class="vl-tool">${toolText(v) ? `<span class="tool-tag">${esc(toolText(v))}</span>` : ''}</span>
      <span class="vl-fb">${v.feedback ? `<span class="fb-stars-cell">${STARS(v.feedback.rating)}</span>` : ''}</span>
    </li>`).join('');

  row.innerHTML = `<td colspan="14" class="detail-cell">
    <div class="vl-head">訪客 <code>${esc(d.vid)}</code>${d.label ? ` <span class="vid-label">（${esc(d.label)}）</span>` : ''} 共 ${d.total} 次來訪
      <span class="vl-scope">（${scopeNote}）</span></div>
    <ol class="vl-list">${items}</ol>
    <div class="vl-foot">目前你點開的是<b>第 ${s.visitNo} / ${d.total} 次</b>。點上面任一次即可在這裡直接展開該次的完整內容，不必回主清單找。</div>
  </td>`;

  // 這裡的每一次都可以直接展開，不必回主清單翻
  row.querySelectorAll('.vl-item').forEach((li) => {
    const open = (e) => { e.stopPropagation(); toggleVisitDetail(li, li.dataset.sid); };
    li.addEventListener('click', open);
    li.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(e); }
    });
  });
}

async function toggleDetail(tr, s) {
  const existing = tr.nextElementSibling;
  if (existing && existing.classList.contains('sess-detail')) { existing.remove(); return; }
  // 若這一列正展開「訪客的來訪清單」，先收掉再換成單筆詳情
  if (existing && existing.classList.contains('visit-list-row')) existing.remove();

  const detail = document.createElement('tr');
  detail.className = 'sess-detail';
  detail.innerHTML = '<td colspan="14" class="detail-cell">讀取中……</td>';
  tr.after(detail);
  await renderSessionDetail(detail.querySelector('td'), s);
}

// 展開「訪客歷次來訪」清單裡的某一次。
// 內容與主表格展開的單筆詳情完全相同——共用 renderSessionDetail()，
// 差別只在外層容器（表格是 <tr><td>，這裡是 <li><div>）。
async function toggleVisitDetail(li, sid) {
  const next = li.nextElementSibling;
  if (next && next.classList.contains('vl-detail')) { next.remove(); return; }
  // 同一份清單裡一次只展開一筆，免得整塊越長越亂
  li.closest('.vl-list').querySelectorAll('.vl-detail').forEach((x) => x.remove());
  li.parentElement.querySelectorAll('.vl-item.open').forEach((x) => x.classList.remove('open'));
  li.classList.add('open');

  const host = document.createElement('li');
  host.className = 'vl-detail';
  host.innerHTML = '<div class="detail-cell">讀取中……</div>';
  li.after(host);
  await renderSessionDetail(host.querySelector('.detail-cell'), { sid });
}

// 把單筆來訪的完整內容畫進 cell（表格列與訪客清單共用）
async function renderSessionDetail(cell, s) {
  try {
    const d = await api({ view: 'session', sid: s.sid });
    const j = d.journey;
    const dwell = Object.entries(d.dwellMs || {})
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${SCREEN_LABELS[k] || k}：${fmtMs(v)}`)
      .join('｜');
    cell.innerHTML = `
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
    const copyPromptBtn = cell.querySelector('.btn-copy-prompt');
    if (copyPromptBtn) {
      const promptBox = cell.querySelector('.prompt-text');
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
        cell.querySelectorAll('.seg-tab').forEach((t) => t.classList.toggle('on', t.dataset.seg === key));
        promptBox.textContent = key === 'full' ? '讀取中……' : segText(key);
        if (key === 'full') promptBox.textContent = await buildFull();
      };
      cell.querySelectorAll('.seg-tab').forEach((tab) => {
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
      const askLog = cell.querySelector('.ask-log');
      const askInput = cell.querySelector('.ask-input');
      const askBtn = cell.querySelector('.btn-ask');
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
    const noteInput = cell.querySelector('.note-input');
    const saveBtn = cell.querySelector('.btn-save-note');
    const savedTag = cell.querySelector('.note-saved');
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
    cell.querySelector('.btn-del').addEventListener('click', async (e) => {
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
    cell.textContent = '讀取失敗。';
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


// 開啟預覽：抓那一次的 journey，重建成 session，用 iframe 載入正式的結果頁。
// 走 iframe 而不是自己在後台重畫，是為了讓預覽與正式站共用同一份渲染程式——
// 只要 index.html 的結果頁改了，預覽就跟著改，不會有兩套版面各自漂移。
async function openPreview(row) {
  const sid = row.sid;
  closePreview();
  const el = document.createElement('div');
  el.className = 'pv-overlay';
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-modal', 'true');
  el.innerHTML = `
    <div class="pv-bar">
      <span class="pv-title">預覽使用者看到的結果頁　<code>${esc(sid)}</code></span>
      <span class="pv-state" id="pvState">讀取中……</span>
      <button type="button" class="btn small pv-close" title="關閉（Esc）">關閉</button>
    </div>
    <div class="pv-stage"><iframe class="pv-frame" title="結果頁預覽"
      src="/index.html?preview=1"></iframe></div>`;
  document.body.append(el);
  document.body.classList.add('pv-open');

  const close = () => closePreview();
  el.querySelector('.pv-close').onclick = close;
  el.addEventListener('pointerdown', (e) => { if (e.target === el) close(); });
  el.tabIndex = -1;
  el.focus();
  el.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });

  let session = null;
  try {
    const d = await api({ view: 'session', sid });
    if (!d.journey) throw new Error('這一筆沒有留下解讀內容');
    session = buildPreviewSession(d.journey);
    // 語系存在來訪紀錄（pi:sessions）而不是 journey 裡，所以從列表那筆帶過來
    session.lang = row.lang || '';
  } catch (err) {
    $('pvState').textContent = `讀取失敗：${err.message || err}`;
    return;
  }

  // iframe 說「我準備好了」才送資料——不等的話 postMessage 可能早於它載入完成
  const frame = el.querySelector('.pv-frame');
  const onReady = (e) => {
    if (e.origin !== location.origin) return;
    if (!e.data || e.data.type !== 'previewReady') return;
    if (e.source !== frame.contentWindow) return;
    frame.contentWindow.postMessage({ type: 'previewSession', session }, location.origin);
    $('pvState').textContent = session.previewNotes.truncated ? '內容已截斷（見頁內說明）' : '';
    window.removeEventListener('message', onReady);
  };
  window.addEventListener('message', onReady);
  previewCleanup = () => window.removeEventListener('message', onReady);
}

let previewCleanup = null;
function closePreview() {
  if (previewCleanup) { previewCleanup(); previewCleanup = null; }
  document.querySelectorAll('.pv-overlay').forEach((x) => x.remove());
  document.body.classList.remove('pv-open');
}


// ---- 專屬靈感牌卡：審核產出品質 ----
// 把整條產出鏈由上游到下游攤開。順序刻意是「挑中哪一張＋為什麼 → 卡面 → 譯文 →
// 牌義 → 圖像 prompt」而不是照畫面上的顯示順序：產出不好的時候，要先看得到最上游
// 的那一步——而現在最上游是「挑卡準不準」。挑中的牌與 why 從來不回傳給使用者
// （見 api/oracle.js），這裡是唯一看得到的地方。
//
// 舊紀錄（改成固定牌組之前產的）欄位不一樣：那時候整段牌義是模型自己寫的，
// 存的是 title／keywords／message／longMessage。這裡兩種都認——舊紀錄還在
// pi:oracles 裡，不該因為改版就變成一片空白。
//
// 存檔圖不隨清單一起拉（一張約 30 KB，五十張就 1.5 MB），點「看圖」才另外要一張。
const oaLoaded = new Set();   // 已經載過的 `${id}:${kind}`，避免重複請求

// 中日韓算字、英文算 words——與後台「字數」欄同一套判斷（英文的規定以 words 計）
function oaLen(text, lang) {
  const t = String(text || '');
  if (lang === 'en') return `${t.split(/\s+/).filter(Boolean).length} words`;
  return `${t.replace(/\s+/g, '').length} 字`;
}

const num = (n) => Number(n || 0).toLocaleString('en-US');

// 一段呼叫的 token 明細。null＝供應商沒回報用量，要與「0 個 token」分清楚：
// 顯示 0 會被讀成免費，顯示「沒回報」才知道那筆金額是少算的。
function oaTokens(u) {
  if (!u) return '<span class="dim-dash">沒回報用量</span>';
  const parts = [`輸入 ${num(u.in)}`];
  if (u.cachedIn) parts.push(`快取 ${num(u.cachedIn)}`);
  if (u.out) parts.push(`輸出 ${num(u.out)}`);
  return esc(parts.join('　'));
}

// 金額一律標「≈」：那是用程式裡的價目表乘出來的估算，不是帳單
//（價目會變、免費額度與稅金不算在內）。見 api/oracle.js 的 PRICE。
const oaCost = (v) => (Number.isFinite(Number(v)) && Number(v) > 0
  ? `≈ US$${Number(v).toFixed(4)}` : '—');

// ---- 對外開關 ----
// 值存在 Redis，api/oracle.js 每次請求都讀，所以按下去下一個使用者就是新的狀態。
// Redis 是唯一的來源：讀不到就一律當關閉（誤關只是少一張卡，誤開會花錢）。
async function refreshOracleSwitch() {
  const state = $('oswState');
  const btn = $('oswBtn');
  const note = $('oswNote');
  if (!state || !btn) return;
  let d;
  try {
    d = await api({ view: 'oracleswitch' });
  } catch {
    state.textContent = '讀不到目前狀態';
    btn.disabled = true;
    return;
  }
  const on = !!d.enabled;
  $('oswBox').classList.toggle('on', on);
  state.textContent = on ? '開放中——使用者可以製作牌卡' : '已關閉——使用者看到「即將開放」';
  btn.textContent = on ? '關閉' : '開放';
  btn.classList.toggle('primary', !on);
  btn.disabled = d.storable === false;
  note.textContent = d.storable === false
    ? '這個環境沒有設定 Redis，開關存不進去，功能維持關閉。'
    : '按下去即時生效，不必重新部署。關閉不會刪除任何已產生的紀錄與圖。'
      + '每張牌卡約 US$0.08，其中圖像佔八成以上。';
  btn.onclick = async () => {
    btn.disabled = true;
    btn.textContent = '處理中……';
    try {
      await api({}, { action: 'oracleswitch', on: !on });
    } catch {
      note.textContent = '切換失敗，請重試。';
    }
    refreshOracleSwitch();
  };
}

async function refreshOracles() {
  refreshOracleSwitch();
  const host = $('oaList');
  host.innerHTML = '<div class="a-hint">載入中……</div>';
  let data;
  try {
    data = await api({ view: 'oracles', limit: 50 });
  } catch {
    host.innerHTML = '<div class="a-hint">讀取失敗，請重新整理。</div>';
    return;
  }
  const items = data.items || [];
  // 合計只加「顯示中的這幾張」，並且明說——寫成「總花費」會被當成全站累計，
  // 但清單只拉最近 50 張，那個數字是錯的。
  const sum = items.reduce((a, o) => a + (Number(o.costUsd) || 0), 0);
  const priced = items.filter((o) => Number(o.costUsd) > 0).length;
  $('oaSummary').innerHTML = items.length
    ? `<span class="oa-count">共 ${data.total} 張，顯示最近 ${items.length} 張</span>`
      + (sum > 0 ? `<span class="oa-count">這 ${items.length} 張的估算成本合計 ≈ US$${sum.toFixed(3)}`
        + `（每張平均 ≈ US$${(sum / priced).toFixed(4)}）</span>` : '')
    : '';
  if (!items.length) {
    host.innerHTML = '<div class="a-hint">還沒有人做過牌卡。</div>';
    return;
  }

  host.innerHTML = items.map((o) => `
    <div class="oa-card" data-id="${esc(o.id)}">
      <div class="oa-meta">
        <span>${fmtTime(o.ts)}</span>
        <span>${esc(LANG_LABEL[o.lang] || o.lang || '—')}</span>
        <code>${esc(o.vid || '')}</code>
        ${o.textMs ? `<span class="oa-ms">文字 ${(o.textMs / 1000).toFixed(1)}s</span>` : ''}
        ${o.imageMs ? `<span class="oa-ms">圖 ${(o.imageMs / 1000).toFixed(1)}s</span>` : ''}
        ${o.imaged ? '' : '<span class="oa-noimg">沒生圖</span>'}
        ${Number(o.costUsd) > 0 ? `<span class="oa-cost">${esc(oaCost(o.costUsd))}</span>` : ''}
      </div>

      ${o.cardId ? `<div class="oa-row oa-essence">
        <div class="oa-k">挑中的牌</div>
        <div class="oa-v">
          <div class="oa-title">#${esc(o.cardId)}　${esc(o.cardTitle)}</div>
          <div class="oa-kw">${esc(o.cardCategory)}</div>
          <div class="oa-msg">${esc(o.why) || '<span class="dim-dash">—</span>'}</div>
        </div>
      </div>` : `<div class="oa-row oa-essence">
        <div class="oa-k">靈魂精髓<br><span class="oa-len">舊版</span></div>
        <div class="oa-v">${esc(o.essence) || '<span class="dim-dash">—</span>'}</div>
      </div>`}

      <div class="oa-row">
        <div class="oa-k">卡面（英文）</div>
        <div class="oa-v">
          <div class="oa-title">${esc(o.keyword || o.title)}</div>
          ${(o.keywords || []).length ? `<div class="oa-kw">${o.keywords.map(esc).join(' · ')}</div>` : ''}
          <div class="oa-msg">${esc(o.sentence || o.message)}</div>
        </div>
      </div>

      <div class="oa-row">
        <div class="oa-k">卡面譯文</div>
        <div class="oa-v">
          <div class="oa-title">${esc(o.keywordLocal || o.titleLocal) || '<span class="dim-dash">—</span>'}</div>
          ${(o.keywordsLocal || []).length ? `<div class="oa-kw">${o.keywordsLocal.map(esc).join(' · ')}</div>` : ''}
          <div class="oa-msg">${esc(o.sentenceLocal || o.messageLocal)}</div>
        </div>
      </div>

      ${o.cardId ? `<div class="oa-row">
        <div class="oa-k">牌義${o.translated ? '<br><span class="oa-len">翻譯</span>'
    : (o.lang && o.lang !== 'zh-Hant' ? '<br><span class="oa-len">翻譯失敗，顯示原文</span>' : '')}</div>
        <div class="oa-v oa-long">
          <p class="oa-msg">${esc(o.essence)}</p>
          ${String(o.insights || '').split(/\n+/).filter(Boolean)
    .map((x) => `<p>${esc(x)}</p>`).join('')}
        </div>
      </div>` : `<div class="oa-row">
        <div class="oa-k">解讀 <span class="oa-len">${esc(oaLen(o.longMessage, o.lang))}</span></div>
        <div class="oa-v oa-long">${(String(o.longMessage || '').split(/\n+/).filter(Boolean)
    .map((x) => `<p>${esc(x)}</p>`).join('')) || '<span class="dim-dash">—</span>'}</div>
      </div>`}

      <details class="oa-more">
        <summary>來源解讀開頭（共 ${Number(o.readingChars) || 0} 字）</summary>
        <div class="oa-pre">${esc(o.readingHead)}</div>
      </details>
      ${o.usage ? `<div class="oa-row">
        <div class="oa-k">用量與成本<br><span class="oa-len">估算</span></div>
        <div class="oa-v oa-usage">
          <div><span class="oa-ulab">文字（${esc(o.model || o.provider || '?')}）</span>${oaTokens(o.usage.text)}</div>
          ${o.usage.translate ? `<div><span class="oa-ulab">牌義翻譯</span>${oaTokens(o.usage.translate)}</div>` : ''}
          <div><span class="oa-ulab">圖像（${esc(o.imageModel || 'gpt-image-1')}）</span>${o.imaged ? oaTokens(o.usage.image) : '<span class="dim-dash">沒生圖</span>'}${o.imageQuality ? `<span class="oa-usub">${esc(o.imageQuality)}　${esc(o.imageSize || '')}</span>` : ''}</div>
          <div class="oa-utotal">合計 ${esc(oaCost(o.costUsd))}</div>
        </div>
      </div>` : ''}

      <details class="oa-more">
        <summary>送給圖像模型的 prompt</summary>
        <div class="oa-pre oa-ltr">${esc(o.imagePromptFull || o.imagePrompt)}</div>
        <div class="a-hint small">最後一段（Vertical composition… no border）是程式固定接上去的，
          不是模型寫的；尺寸與品質不在 prompt 裡，是 API 參數
          （${esc(o.imageSize || '1024x1536')}／${esc(o.imageQuality || 'medium')}）。</div>
      </details>
      ${o.sysHash ? `<details class="oa-more">
        <summary>送給文字模型的原始 prompt${o.model ? `（${esc(o.model)}）` : ''}</summary>
        <div class="oa-load" data-load="prompt">
          <button type="button" class="btn ghost small oa-load-btn">載入（約 3 萬字，點了才拉）</button>
        </div>
      </details>` : ''}
      ${o.hasImage || o.hasArt ? `<div class="oa-imgbox">
        ${o.hasArt ? `<div class="oa-load" data-load="art">
          <div class="oa-imgcap">圖像模型畫的原始畫作</div>
          <button type="button" class="btn ghost small oa-load-btn">看圖</button>
        </div>` : ''}
        ${o.hasImage ? `<div class="oa-load" data-load="card">
          <div class="oa-imgcap">合成後的整張卡（使用者拿到的）</div>
          <button type="button" class="btn ghost small oa-load-btn">看圖</button>
        </div>` : ''}
      </div>` : '<div class="a-hint small">（沒有存檔圖）</div>'}
    </div>`).join('');

  // 圖與原始 prompt 都是點了才拉：一張圖約 30 KB、一份 prompt 約 3 萬字，
  // 五十筆全部預載沒有道理。載過的不重複請求。
  host.querySelectorAll('.oa-load-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const box = btn.closest('.oa-load');
      const id = btn.closest('.oa-card').dataset.id;
      const kind = box.dataset.load;
      if (oaLoaded.has(`${id}:${kind}`)) return;
      btn.disabled = true;
      btn.textContent = '載入中……';
      try {
        if (kind === 'prompt') {
          const r = await api({ view: 'oracleprompt', id });
          if (!r.system && !r.user) throw new Error('no prompt');
          oaLoaded.add(`${id}:${kind}`);
          const pre = document.createElement('div');
          pre.className = 'oa-pre oa-promptdump';
          pre.textContent = [
            `── provider／model ──\n${r.provider || '?'}　${r.model || '?'}`,
            `── system prompt（${(r.system || '').length} 字）──\n${r.system || '(沒有存到)'}`,
            `── user prompt（${(r.user || '').length} 字）──\n${r.user || '(沒有存到)'}`,
            `── 送給圖像模型的完整 prompt ──\n${r.imagePrompt || '(沒有存到)'}`,
          ].join('\n\n');
          btn.replaceWith(pre);
          return;
        }
        const r = await api({ view: 'oracleimg', id, ...(kind === 'art' ? { kind: 'art' } : {}) });
        if (!r.image) throw new Error('no image');
        oaLoaded.add(`${id}:${kind}`);
        btn.replaceWith(Object.assign(document.createElement('img'), {
          className: 'oa-img', src: r.image, alt: '',
        }));
      } catch {
        btn.disabled = false;
        btn.textContent = '載入失敗，再試一次';
      }
    });
  });
}
