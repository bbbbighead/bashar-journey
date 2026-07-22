// app.js — 「靈感訊息」頂層流程控制。
// 節奏：輸入想獲得靈感的主題 → 雷諾曼（使用者親手從 36 張選 9 張入九宮格）
// → 梅花易數報數起卦 → 交叉整合 → 綜合靈感訊息。
// 每一步都 saveSession，支援重整續玩。

import {
  createSession, saveSession, loadSession, clearSession,
} from './engine/session.js';
import { castMeihua, fetchAstroChart, getAnalysis } from './engine/inquiry.js';
import { countryList } from '../data/countries.js';
import { shuffledDeckOrder, spreadFromPicks } from './engine/lenormand.js';
import { detectCrisis } from './content/crisis.js';
import { trackVisit, trackScreen, trackJourney } from './analytics.js';

const $ = (id) => document.getElementById(id);
let state = null;

trackVisit();
trackScreen('screenIntake');

// ---- 螢幕切換 ----
function showScreen(id) {
  document.querySelectorAll('.screen').forEach((s) => s.classList.remove('active'));
  $(id).classList.add('active');
  trackScreen(id);
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function showWeaving(text) {
  if (text) $('weavingText').innerHTML = text;
  showScreen('screenWeaving');
}

// ---- 入口 ----
$('btnStart').addEventListener('click', start);
$('question').addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') start();
});
$('examples').addEventListener('click', (e) => {
  if (e.target.tagName === 'SPAN') $('question').value = e.target.textContent;
});
$('btnCareBack').addEventListener('click', () => showScreen('screenIntake'));

function start() {
  const q = $('question').value.trim();
  if (!q) { $('question').focus(); return; }
  if (detectCrisis(q)) { showScreen('screenCare'); return; }

  state = createSession(q);
  saveSession(state);
  runSpread();
}

// ---- 占卜一：使用者親手選牌（36 選 9，依序入九宮格） ----
const POS_TIME = { past: '過去', present: '現在', future: '走向' };
const POS_LAYER = { mind: '想法', core: '現實', root: '潛意識' };
const POS_LABELS = [
  '過去・想法', '現在・想法', '走向・想法',
  '過去・現實', '現在・現實', '走向・現實',
  '過去・潛意識', '現在・潛意識', '走向・潛意識',
];

function runSpread() {
  const deck = $('deckGrid');
  const grid = $('spreadGrid');
  const count = $('pickCount');
  const doneBtn = $('btnSpreadDone');
  const resetBtn = $('btnSpreadReset');

  const order = shuffledDeckOrder(); // 牌池顯示順序（牌背朝上，位置不代表任何牌）
  let picks = []; // 已選牌的索引（0..35），順序即九宮格位置

  // 九宮格：九個空位
  function renderGrid() {
    grid.innerHTML = '';
    for (let pos = 0; pos < 9; pos++) {
      const slot = document.createElement('div');
      if (pos < picks.length) {
        const spreadEntry = spreadFromPicks(picks)[pos];
        slot.className = 'scard flipped';
        slot.innerHTML = `
          <div class="scard-inner">
            <div class="scard-face scard-back"></div>
            <div class="scard-face scard-front">
              <span class="scard-no">${spreadEntry.card.id}</span>
              <span class="scard-name">${spreadEntry.card.name}</span>
            </div>
          </div>
          <div class="scard-pos">${POS_LABELS[pos]}</div>`;
      } else {
        slot.className = 'slot-empty' + (pos === picks.length ? ' next' : '');
        slot.innerHTML = `<div class="slot-box">${pos === picks.length ? '下一張' : ''}</div>
          <div class="scard-pos">${POS_LABELS[pos]}</div>`;
      }
      grid.appendChild(slot);
    }
  }

  function renderCount() {
    count.textContent = `已選 ${picks.length} / 9`;
    doneBtn.disabled = picks.length !== 9;
  }

  // 牌池：36 張牌背
  deck.innerHTML = '';
  order.forEach((cardIdx) => {
    const el = document.createElement('div');
    el.className = 'deck-card';
    el.dataset.cardIdx = String(cardIdx);
    el.setAttribute('role', 'button');
    el.setAttribute('aria-label', '一張牌（牌背朝上）');
    el.addEventListener('click', () => {
      if (el.classList.contains('taken') || picks.length >= 9) return;
      el.classList.add('taken');
      picks.push(cardIdx);
      renderGrid();
      renderCount();
    });
    deck.appendChild(el);
  });

  resetBtn.onclick = () => {
    picks = [];
    deck.querySelectorAll('.deck-card.taken').forEach((el) => el.classList.remove('taken'));
    renderGrid();
    renderCount();
  };

  doneBtn.onclick = () => {
    if (picks.length !== 9) return;
    state.lenormand = spreadFromPicks(picks);
    state.status = 'numbers';
    saveSession(state);
    runNumbers();
  };

  renderGrid();
  renderCount();
  showScreen('screenSpread');
}

// ---- 占卜二：梅花易數報數起卦（單一數字 1–9） ----
function runNumbers() {
  const inputs = [$('num1'), $('num2'), $('num3')];
  const doneBtn = $('btnNumbersDone');
  const randomBtn = $('btnNumbersRandom');
  const picked = $('numPicked');

  const valid = (el) => {
    const v = Number(el.value);
    return Number.isInteger(v) && v >= 1 && v <= 9;
  };
  const refresh = () => { doneBtn.disabled = !inputs.every(valid); };
  inputs.forEach((el) => {
    el.value = '';
    el.oninput = () => {
      // 只留最後輸入的一位數（1–9）
      const digits = el.value.replace(/[^1-9]/g, '');
      el.value = digits.slice(-1);
      picked.textContent = '';
      refresh();
    };
  });
  picked.textContent = '';
  refresh();

  const proceed = (numbers) => {
    castMeihua(state, numbers);
    state.status = 'astro';
    saveSession(state);
    runAstro();
  };
  doneBtn.onclick = () => { if (inputs.every(valid)) proceed(inputs.map((el) => Number(el.value))); };

  // 隨機選三個 1–9 的數字（結果填入輸入框並列出，讓使用者看見後再確認）
  randomBtn.onclick = () => {
    const rand = new Uint32Array(3);
    crypto.getRandomValues(rand);
    const nums = [...rand].map((r) => (r % 9) + 1);
    inputs.forEach((el, i) => { el.value = String(nums[i]); });
    picked.textContent = `此刻為你選出——${nums.join('、')}`;
    refresh();
  };

  // 不報數：由此刻的時間起卦
  $('btnNumbersSkip').onclick = () => proceed(null);

  showScreen('screenNumbers');
  setTimeout(() => inputs[0].focus(), 200);
}

// ---- 占卜三：西洋占星本命盤（Swiss Ephemeris 精算） ----
function runAstro() {
  const dateEl = $('astroDate');
  const timeEl = $('astroTime');
  const unknownEl = $('astroTimeUnknown');
  const cityEl = $('astroCity');
  const cityListEl = $('cityList');
  const cityPickedEl = $('cityPicked');
  const countryEl = $('astroCountry');
  const countryListEl = $('countryList');
  const errEl = $('astroError');
  const doneBtn = $('btnAstroDone');
  const skipBtn = $('btnAstroSkip');

  let pickedPlace = null;   // 從搜尋清單選定的城市（帶經緯度/時區，計算時免再 geocode）
  let pickedCountry = null; // 從國家清單選定 {code, zh, en}
  const COUNTRIES = countryList();

  const refresh = () => {
    timeEl.disabled = unknownEl.checked;
    doneBtn.disabled = !(dateEl.value && (pickedPlace || cityEl.value.trim()) && (unknownEl.checked || timeEl.value));
  };
  [dateEl, timeEl].forEach((el) => { el.oninput = refresh; });
  unknownEl.onchange = refresh;

  // -- 城市：即時搜尋合法清單（含臺↔台變體），點選後鎖定經緯度與時區 --
  let cityTimer = null;
  let citySeq = 0;
  const renderCityList = (items) => {
    if (!items) { cityListEl.hidden = true; cityListEl.innerHTML = ''; return; }
    cityListEl.innerHTML = items.length
      ? items.map((r, i) => `<div class="combo-item" data-i="${i}"><span>${esc(r.name)}${r.admin1 ? `<small>，${esc(r.admin1)}</small>` : ''}</span><small>${esc(r.country || '')}</small></div>`).join('')
      : '<div class="combo-empty">找不到符合的城市——試試別的寫法（可省略「市」「縣」）</div>';
    cityListEl.hidden = false;
    cityListEl.querySelectorAll('.combo-item').forEach((el) => {
      // mousedown：先於 input blur 觸發，避免清單先被收起
      el.addEventListener('mousedown', (ev) => { ev.preventDefault(); pickCity(items[Number(el.dataset.i)]); });
    });
  };
  const pickCity = (r) => {
    pickedPlace = r;
    cityEl.value = r.name;
    cityPickedEl.textContent = `已選：${r.name}${r.admin1 ? `，${r.admin1}` : ''}（${r.country || '？'}・${r.timezone || ''}）`;
    if (r.country && !countryEl.value.trim()) countryEl.value = r.country;
    renderCityList(null);
    refresh();
  };
  cityEl.oninput = () => {
    pickedPlace = null;
    cityPickedEl.textContent = '';
    refresh();
    clearTimeout(cityTimer);
    const q = cityEl.value.trim();
    if (!q) { renderCityList(null); return; }
    cityTimer = setTimeout(async () => {
      const seq = ++citySeq;
      try {
        const res = await fetch('/api/astro?q=' + encodeURIComponent(q));
        const json = await res.json();
        if (seq !== citySeq) return; // 已有更新的搜尋在途
        let items = (json && json.results) || [];
        if (pickedCountry) items = items.filter((r) => String(r.countryCode || '').toUpperCase() === pickedCountry.code);
        renderCityList(items.slice(0, 8));
      } catch { if (seq === citySeq) renderCityList([]); }
    }, 350);
  };
  cityEl.onblur = () => setTimeout(() => renderCityList(null), 150);

  // -- 國家／地區：完整 ISO 清單（繁中＋英文皆可搜尋），輸入即過濾 --
  const renderCountryList = (items) => {
    if (!items) { countryListEl.hidden = true; countryListEl.innerHTML = ''; return; }
    countryListEl.innerHTML = items.length
      ? items.map((c, i) => `<div class="combo-item" data-i="${i}"><span>${esc(c.zh)}</span><small>${esc(c.en)}</small></div>`).join('')
      : '<div class="combo-empty">找不到符合的國家／地區</div>';
    countryListEl.hidden = false;
    countryListEl.querySelectorAll('.combo-item').forEach((el) => {
      el.addEventListener('mousedown', (ev) => {
        ev.preventDefault();
        const c = items[Number(el.dataset.i)];
        pickedCountry = c;
        countryEl.value = c.zh;
        renderCountryList(null);
      });
    });
  };
  const filterCountries = () => {
    const q = countryEl.value.trim().toLowerCase();
    const items = q
      ? COUNTRIES.filter((c) => c.zh.toLowerCase().includes(q) || c.en.toLowerCase().includes(q) || c.code.toLowerCase() === q)
      : COUNTRIES;
    renderCountryList(items.slice(0, 12));
  };
  countryEl.oninput = () => { pickedCountry = null; filterCountries(); };
  countryEl.onfocus = filterCountries;
  countryEl.onblur = () => setTimeout(() => renderCountryList(null), 150);

  errEl.textContent = '';
  cityPickedEl.textContent = '';
  refresh();

  const proceedTo = (chart) => {
    state.astro = chart; // null＝跳過
    state.status = 'weaving';
    saveSession(state);
    runAnalysis();
  };

  doneBtn.onclick = async () => {
    errEl.textContent = '';
    doneBtn.disabled = true;
    doneBtn.textContent = '正在精算星盤……';
    try {
      const chart = await fetchAstroChart({
        date: dateEl.value,
        time: unknownEl.checked ? null : timeEl.value,
        timeUnknown: unknownEl.checked,
        city: cityEl.value.trim(),
        country: countryEl.value.trim(),
        place: pickedPlace ? {
          name: pickedPlace.name,
          country: pickedPlace.country,
          latitude: pickedPlace.latitude,
          longitude: pickedPlace.longitude,
          timezone: pickedPlace.timezone,
        } : undefined,
      });
      proceedTo(chart);
    } catch (e) {
      errEl.textContent = ({
        geocode_failed: '找不到這個城市——請輸入後從跳出的清單中選擇一個城市。',
        date_out_of_range: '出生年份需在 1800–2399 之間。',
        tz_unavailable: '無法解析當地時區，請稍後再試。',
      })[e.code] || '星盤計算暫時無法使用，可以稍後再試，或先跳過。';
    }
    doneBtn.textContent = '計算星盤，繼續';
    refresh();
  };
  skipBtn.onclick = () => proceedTo(null);

  showScreen('screenAstro');
}

// ---- 交叉整合 → 最後分析 ----
async function runAnalysis() {
  showWeaving();
  const t0 = Date.now();
  const analysis = await getAnalysis(state);
  saveSession(state);
  trackJourney(state);
  const waitMs = Math.max(0, 2400 - (Date.now() - t0));
  setTimeout(() => renderResult(analysis), waitMs);
}

// 三系統匯聚圖：把雷諾曼／梅花／星盤畫成觀測同一份圖樣的三個測點，
// 髮絲線緩緩收束到中心——視覺化「整合的訊息」而非三份孤立解讀。
function convergeSVG(hasAstro) {
  const nodes = hasAstro
    ? [
      { x: 110, label: '雷諾曼', sub: '現實如何表現' },
      { x: 300, label: '梅花易數', sub: '正處哪個階段' },
      { x: 490, label: '本命星盤', sub: '為什麼會這樣' },
    ]
    : [
      { x: 170, label: '雷諾曼', sub: '現實如何表現' },
      { x: 430, label: '梅花易數', sub: '正處哪個階段' },
    ];
  const parts = nodes.map((n) => `
    <text x="${n.x}" y="26" text-anchor="middle" font-size="12.5" fill="#a89f8a" letter-spacing="2">${n.label}</text>
    <text x="${n.x}" y="43" text-anchor="middle" font-size="9.5" fill="#6e6957" letter-spacing="1">${n.sub}</text>
    <circle cx="${n.x}" cy="58" r="2.6" fill="#c2a869"/>
    <path class="cv-line" pathLength="1" d="M ${n.x} 64 C ${n.x} 96, 300 100, 300 124" stroke="rgba(194,168,105,.55)" stroke-width="0.8" fill="none"/>`).join('');
  return `
    <div class="r-converge" aria-hidden="true">
      <svg viewBox="0 0 600 178" fill="none" xmlns="http://www.w3.org/2000/svg">
        ${parts}
        <circle class="cv-halo" cx="300" cy="132" r="8.5" stroke="rgba(194,168,105,.45)" stroke-width=".8"/>
        <circle cx="300" cy="132" r="3.2" fill="#c2a869"/>
        <text x="300" y="165" text-anchor="middle" font-size="11" fill="#8a774d" letter-spacing="3">同一份底層圖樣</text>
      </svg>
    </div>`;
}

function renderResult(a) {
  // 頂部：這一局抽出的九張牌（文字列表，依九宮格順序）與報的數
  const drawList = (state.lenormand || [])
    .map(({ card }, pos) => `<li><span class="dl-pos">${POS_LABELS[pos]}</span><span class="dl-name">${esc(card.name)}</span></li>`)
    .join('');
  const numsText = state.numbers ? state.numbers.join(' · ') : '由此刻的時間起卦';
  const astroText = astroSummary(state.astro);

  $('resultHost').innerHTML = `
    <div class="r-title">${esc(a.title || '給你的靈感訊息')}</div>
    <div class="r-sub">${state.astro ? '三個觀測角度' : '兩個觀測角度'}・交會於同一則訊息</div>
    ${convergeSVG(!!state.astro)}
    <div class="r-draws">
      <div class="r-draws-label">你選的九張牌</div>
      <ul class="draw-list">${drawList}</ul>
      <div class="r-draws-nums">你報的數——<b>${esc(numsText)}</b></div>
      <div class="r-draws-nums">你的星盤——<b>${esc(astroText)}</b></div>
    </div>
    <div class="r-block core"><h3>靈感訊息</h3><p>${esc(a.message)}</p></div>
    ${a.closing ? `<div class="r-closing">${esc(a.closing)}</div>` : ''}
    <div class="r-actions">
      <button class="btn" id="btnCopy">複製完整內容</button>
      <button class="btn" id="btnRestart">再求一則靈感</button>
    </div>
    <div class="r-continue">
      <div class="r-continue-title">想針對這則訊息，繼續往下聊？</div>
      <p class="r-continue-hint">選一個你慣用的 AI——完整內容會自動複製，開啟後直接貼上，就能接著深入提問。</p>
      <div class="ai-row">
        <a class="btn ai-btn" data-ai="chatgpt" href="https://chatgpt.com/" target="_blank" rel="noopener noreferrer">ChatGPT</a>
        <a class="btn ai-btn" data-ai="claude" href="https://claude.ai/new" target="_blank" rel="noopener noreferrer">Claude</a>
        <a class="btn ai-btn" data-ai="gemini" href="https://gemini.google.com/app" target="_blank" rel="noopener noreferrer">Gemini</a>
      </div>
      <div class="copy-toast" id="copyToast"></div>
    </div>`;
  $('btnRestart').addEventListener('click', restart);
  $('btnCopy').addEventListener('click', () => copyAnalysis(a));
  $('resultHost').querySelectorAll('.ai-btn').forEach((b) => {
    // 連結本身負責開新分頁（不會被彈窗攔截）；點擊當下同步把 handoff 寫入剪貼簿
    b.addEventListener('click', () => continueWithAI(a));
  });
  showScreen('screenResult');
}

// 星盤摘要（結果頁顯示與複製用；不含出生資料本身）
function astroSummary(chart) {
  if (!chart) return '未提供（略過占星）';
  const pts = {};
  for (const p of chart.points || []) pts[p.name] = p;
  const parts = [];
  if (pts['太陽']) parts.push(`太陽 ${pts['太陽'].sign}`);
  if (pts['月亮']) parts.push(`月亮 ${pts['月亮'].sign}`);
  if (pts['上升點']) parts.push(`上升 ${pts['上升點'].sign}`);
  if (chart.meta && chart.meta.input && chart.meta.input.timeUnknown) parts.push('（出生時間不確定，未計宮位）');
  return parts.join(' · ') || '已計算';
}

// 完整內容（複製與導流共用）：主題 + 牌 + 數 + 星盤 + 訊息
function fullText(a) {
  const cards = (state.lenormand || [])
    .map(({ card }, pos) => `${POS_LABELS[pos]}：${card.name}`)
    .join('｜');
  return [
    a.title || '給你的靈感訊息',
    '',
    `我的主題:${state.opening}`,
    `我選的九張牌（九宮格）:${cards}`,
    `我報的三個數:${state.numbers ? state.numbers.join('、') : '（由當下時間起卦）'}`,
    `我的星盤:${astroSummary(state.astro)}`,
    '',
    a.message,
    a.closing ? `\n${a.closing}` : '',
    '\n— 靈感訊息',
  ].filter((s) => s !== '').join('\n');
}

function copyAnalysis(a) {
  const btn = $('btnCopy');
  navigator.clipboard.writeText(fullText(a)).then(
    () => { btn.textContent = '已複製 ✓'; setTimeout(() => { btn.textContent = '複製完整內容'; }, 1800); },
    () => { btn.textContent = '複製失敗'; }
  );
}

// 導流：連結開啟所選 AI 的新分頁；此函式在點擊當下把「內容＋接續提問引導」寫入剪貼簿
function continueWithAI(a) {
  const handoff = [
    '以下是我剛在「靈感訊息」完成的一次抽引結果，請你先讀完：',
    '',
    fullText(a),
    '',
    '請你扮演一位溫暖而誠實的引導者，基於以上的主題、牌陣與訊息，陪我繼續深入探討——我接下來會針對其中的內容提問。',
  ].join('\n');

  navigator.clipboard.writeText(handoff).then(
    () => showToast('內容已複製——在開啟的分頁裡貼上，就能接著聊。'),
    () => showToast('分頁已開啟。若貼上時沒有內容，請回來按「複製完整內容」。')
  );
}

let toastTimer = null;
function showToast(msg) {
  const el = $('copyToast');
  if (!el) return;
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 4200);
}

function restart() {
  clearSession();
  state = null;
  $('question').value = '';
  showScreen('screenIntake');
}

// ---- 續玩 ----
(function resume() {
  const saved = loadSession();
  if (!saved || !saved.opening) return;
  state = saved;

  if (state.status === 'done' && state.analysis) { renderResult(state.analysis); return; }
  if (state.status === 'spread') { runSpread(); return; }         // 選到一半：重新選
  if (state.status === 'numbers') { runNumbers(); return; }
  if (state.status === 'astro') { runAstro(); return; }
  if (state.status === 'weaving') { runAnalysis(); }
})();

// ---- utils ----
function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
