// app.js — Intuitive Notes 頂層流程控制（MVP）。
// 節奏：首頁輸入主題＋勾選工具 → 依所選工具依序蒐集資料
// （雷諾曼選牌／梅花報數／占星出生資料）→ 分析 → 分節結果。
// 每一步都 saveSession，支援重整續玩。

import {
  createSession, saveSession, loadSession, clearSession, TOOL_LABELS,
} from './engine/session.js';
import { castMeihua, getAnalysis, fetchAstroChart } from './engine/inquiry.js';
import { saveAnalysisToHistory } from './engine/history.js';
import { shuffledDeckOrder, spreadFromPicks } from './engine/lenormand.js';
import { cardConstellation } from '../data/lenormandIcons.js';
import { countryList } from '../data/countries.js';
import { detectCrisis } from './content/crisis.js';
import { trackVisit, trackScreen, trackJourney } from './analytics.js';

const $ = (id) => document.getElementById(id);
let state = null;

// Buy Me a Coffee 贊助連結——點擊於新分頁開啟；留空則點擊顯示「即將開放」
const BMC_URL = 'https://buymeacoffee.com/intuitivenotes';

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

// ---- 入口：主題 + 選擇分析工具（單選：一次只能選一個） ----
const selectedTools = new Set();
const toolButtons = [...$('toolGrid').querySelectorAll('.tool-opt:not(.soon)')];

function refreshStart() {
  $('btnStart').disabled = !($('question').value.trim() && selectedTools.size);
}
toolButtons.forEach((btn) => {
  btn.addEventListener('click', () => {
    const t = btn.dataset.tool;
    const already = selectedTools.has(t);
    selectedTools.clear();
    toolButtons.forEach((b) => { b.classList.remove('on'); b.setAttribute('aria-pressed', 'false'); });
    if (!already) { // 再點同一個＝取消選取
      selectedTools.add(t);
      btn.classList.add('on');
      btn.setAttribute('aria-pressed', 'true');
    }
    refreshStart();
  });
});
$('question').addEventListener('input', refreshStart);
$('btnStart').addEventListener('click', start);
$('question').addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') start();
});
$('btnCareBack').addEventListener('click', () => showScreen('screenIntake'));

function start() {
  const q = $('question').value.trim();
  if (!q || !selectedTools.size) return;
  if (detectCrisis(q)) { showScreen('screenCare'); return; }

  state = createSession(q, [...selectedTools]);
  saveSession(state);
  collectNext();
}

// ---- 蒐集流程：依 state.tools 順序，逐一蒐集尚未取得的工具資料 ----
const TOOL_STEP = { lenormand: runSpread, meihua: runNumbers, astro: runAstro };

function collected(tool) {
  if (tool === 'lenormand') return !!state.lenormand;
  if (tool === 'meihua') return !!state.meihua;
  if (tool === 'astro') return !!state.astro;
  return false;
}
function collectedCount() {
  return state.tools.filter(collected).length;
}
// 步驟引言前綴：第一個蒐集步驟用「首先，」，之後用「接著，」
function stepPrefix() {
  return collectedCount() === 0 ? '首先，' : '接著，';
}
function collectNext() {
  const next = state.tools.find((t) => !collected(t));
  if (!next) {
    state.status = 'weaving';
    saveSession(state);
    runAnalysis();
    return;
  }
  TOOL_STEP[next]();
}

// ---- 占卜一：使用者親手選牌（36 選 9；選取順序對應內部九宮格，不對外揭示牌面） ----
function runSpread() {
  const deck = $('deckGrid');
  const count = $('pickCount');
  const doneBtn = $('btnSpreadDone');
  const resetBtn = $('btnSpreadReset');
  deck.closest('.spread').querySelector('.divine-lede').textContent = `${stepPrefix()}請憑直覺選出 9 張牌卡。`;

  const order = shuffledDeckOrder(); // 牌池顯示順序（牌背朝上，位置不代表任何牌）
  let picks = []; // 已選牌的索引（0..35），選取順序即內部九宮格位置；不對使用者揭示牌面

  function renderCount() {
    count.textContent = `已選 ${picks.length} / 9`;
    doneBtn.disabled = picks.length !== 9;
  }

  // 牌池：36 張牌背。點一張＝選取（發光框），再點一次＝取消選取；牌不翻面、不消失。
  deck.innerHTML = '';
  order.forEach((cardIdx) => {
    const el = document.createElement('div');
    el.className = 'deck-card';
    el.dataset.cardIdx = String(cardIdx);
    el.setAttribute('role', 'button');
    el.setAttribute('aria-pressed', 'false');
    el.setAttribute('aria-label', '一張牌（牌背朝上）');
    el.addEventListener('click', () => {
      const at = picks.indexOf(cardIdx);
      if (at >= 0) {
        picks.splice(at, 1);
        el.classList.remove('sel');
        el.setAttribute('aria-pressed', 'false');
      } else {
        if (picks.length >= 9) return;
        picks.push(cardIdx);
        el.classList.add('sel');
        el.setAttribute('aria-pressed', 'true');
      }
      renderCount();
    });
    deck.appendChild(el);
  });

  resetBtn.onclick = () => {
    picks = [];
    deck.querySelectorAll('.deck-card.sel').forEach((el) => {
      el.classList.remove('sel');
      el.setAttribute('aria-pressed', 'false');
    });
    renderCount();
  };

  doneBtn.onclick = () => {
    if (picks.length !== 9) return;
    state.lenormand = spreadFromPicks(picks);
    saveSession(state);
    collectNext();
  };

  renderCount();
  showScreen('screenSpread');
}

// ---- 占卜二：梅花易數報數起卦（單一數字 1–9） ----
function runNumbers() {
  const inputs = [$('num1'), $('num2'), $('num3')];
  const doneBtn = $('btnNumbersDone');
  const randomBtn = $('btnNumbersRandom');
  const picked = $('numPicked');
  $('screenNumbers').querySelector('.divine-lede').textContent = `${stepPrefix()}請憑直覺輸入 3 個個位數（1–9）。`;

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
    saveSession(state);
    collectNext();
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
  $('astroLede').textContent = `${stepPrefix()}請提供你的出生資料，將以天文曆精算你的本命星盤。`;

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
        if (seq !== citySeq) return;
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
      state.astro = chart;
      saveSession(state);
      collectNext();
    } catch (e) {
      errEl.textContent = ({
        geocode_failed: '找不到這個城市——請輸入後從跳出的清單中選擇一個城市。',
        date_out_of_range: '出生年份需在 1800–2399 之間。',
        tz_unavailable: '無法解析當地時區，請稍後再試。',
      })[e.code] || '星盤計算暫時無法使用，請稍後再試。';
      doneBtn.textContent = '計算星盤，繼續';
      refresh();
    }
  };

  showScreen('screenAstro');
}

// ---- 分析 → 分節結果 ----
async function runAnalysis() {
  showWeaving();
  const t0 = Date.now();
  const analysis = await getAnalysis(state);
  saveSession(state);
  saveAnalysisToHistory(state); // 存進瀏覽器歷史（localStorage，供日後回顧頁讀取）
  trackJourney(state);
  const waitMs = Math.max(0, 2400 - (Date.now() - t0));
  setTimeout(() => renderResult(analysis), waitMs);
}

// 舊格式（.message）相容：包成單一 section
function sectionsOf(a) {
  if (Array.isArray(a.sections) && a.sections.length) return a.sections;
  const only = (state && state.tools && state.tools.length === 1) ? state.tools[0] : 'synthesis';
  return [{ tool: only, content: String(a.message || '') }];
}

// 雷諾曼九宮格牌卡畫面：3×3，每張牌以星座圖案＋牌名＋位置編號呈現
function spreadGridHtml(spread) {
  if (!Array.isArray(spread) || !spread.length) return '';
  const cells = spread.map(({ card }, i) => `
    <div class="lg-cell">
      <div class="lg-pos">${i + 1}</div>
      <div class="lg-ico">${cardConstellation(card.id)}</div>
      <div class="lg-name">${esc(card.name)}</div>
    </div>`).join('');
  return `<div class="lenormand-grid" aria-label="雷諾曼九宮格">${cells}</div>`;
}

// 全形數字轉半形
function normDigits(s) {
  return String(s).replace(/[０-９]/g, (d) => String.fromCharCode(d.charCodeAt(0) - 0xFF10 + 0x30));
}

// 從段落文字中的「（1、4、7）」抓出所有位置群組（數字 1–9，每組 1–5 個）
function posGroupsInText(text) {
  const groups = [];
  const re = /[（(]\s*([0-9０-９][0-9０-９\s、，,和及]*)\s*[）)]/g;
  let m;
  while ((m = re.exec(text))) {
    const nums = [...new Set((normDigits(m[1]).match(/[1-9]/g) || []).map(Number))];
    if (nums.length >= 1 && nums.length <= 5) groups.push(nums);
  }
  return groups;
}

// 九宮格標準閱讀組別 → 固定位置。長名在前（「潛意識層」要先於「意識層」比對）。
const GROUP_LABELS = [
  { label: '潛意識層', pos: [7, 8, 9] },
  { label: '意識層', pos: [1, 2, 3] },
  { label: '現實層', pos: [4, 5, 6] },
  { label: '過去', pos: [1, 4, 7] },
  { label: '現在', pos: [2, 5, 8] },
  { label: '未來', pos: [3, 6, 9] },
  { label: '核心', pos: [5] },
  { label: '十字', pos: [2, 4, 6, 8] },
  { label: '四角', pos: [1, 3, 7, 9] },
];

// 決定某段落前方要顯示哪些對照牌卡（回傳位置群組陣列）。
// 主：內文若明寫「（1、4、7）」這類位置，全部採用；
// 備：AI 常以自然語言寫成「過去那一排」，故段落開頭若是已知組別名稱，用該組固定位置。
function posGroupsForBlock(text) {
  const explicit = posGroupsInText(text);
  if (explicit.length) return explicit;
  const t = String(text).trim();
  if (t.length < 10) return []; // 太短多半是小標題本身（如「時間軸」「十字法」），不放牌卡
  const head = t.slice(0, 6);   // 只看開頭，避免內文中偶然出現「現在」等常用詞誤判
  for (const g of GROUP_LABELS) {
    if (head.includes(g.label)) return [g.pos.slice()];
  }
  return [];
}

// 依位置陣列列出對應的小張牌卡（供各章節前方對照）
function cardStripHtml(spread, positions) {
  const cells = positions.map((pos) => {
    const item = spread[pos - 1];
    if (!item || !item.card) return '';
    return `<figure class="lg-mini">
      <span class="lg-mini-pos">${pos}</span>
      <span class="lg-mini-ico">${cardConstellation(item.card.id)}</span>
      <figcaption class="lg-mini-name">${esc(item.card.name)}</figcaption>
    </figure>`;
  }).join('');
  if (!cells) return '';
  return `<div class="lg-strip" aria-label="本段對應牌卡">${cells}</div>`;
}

// 雷諾曼解析內文：逐段落渲染，段落若提到位置群組（如「過去（1、4、7）」），
// 在該段前方列出對應的小張牌卡，方便使用者對照九宮格。
function lenormandContentHtml(content, spread) {
  const hasSpread = Array.isArray(spread) && spread.length;
  const blocks = String(content || '').split(/\n+/).map((s) => s.trim()).filter(Boolean);
  if (!blocks.length) return `<p>${esc(String(content || ''))}</p>`;
  return blocks.map((b) => {
    const strip = hasSpread
      ? posGroupsForBlock(b).map((g) => cardStripHtml(spread, g)).join('')
      : '';
    return `${strip}<p>${esc(b)}</p>`;
  }).join('');
}

function renderResult(a) {
  const sections = sectionsOf(a);
  const secHtml = sections.map((s) => `
    <div class="r-section">
      <h3 class="r-sec-head">${esc(TOOL_LABELS[s.tool] || s.tool || '')}</h3>
      ${s.tool === 'lenormand' ? spreadGridHtml(state.lenormand) : ''}
      <div class="r-block">${s.tool === 'lenormand'
        ? lenormandContentHtml(s.content, state.lenormand)
        : `<p>${esc(String(s.content || ''))}</p>`}</div>
    </div>`).join('');

  $('resultHost').innerHTML = `
    <div class="r-title">${esc(a.title || '分析結果')}</div>
    <div class="r-sub">關於「${esc(state.opening)}」</div>
    <div class="rule-orn" aria-hidden="true"></div>
    ${secHtml}
    ${a.closing ? `<div class="r-closing">${esc(a.closing)}</div>` : ''}
    <div class="r-sponsor">
      <p class="r-sponsor-line">這則分析對你有幫助嗎？</p>
      <button class="btn bmc-btn" id="btnCoffee">🍰 贊助一塊蛋糕</button>
      <div class="copy-toast" id="coffeeToast"></div>
    </div>
    <div class="r-actions">
      <button class="btn" id="btnCopy">複製這則內容</button>
      <button class="btn" id="btnRestart">回到首頁</button>
    </div>
    <div class="r-continue">
      <div class="r-continue-title">想針對這份分析，繼續往下聊？</div>
      <p class="r-continue-hint">選一個你慣用的 AI——完整內容會自動複製，開啟後直接貼上，就能接著深入提問。</p>
      <div class="ai-row">
        <a class="btn ai-btn" data-ai="chatgpt" href="https://chatgpt.com/" target="_blank" rel="noopener noreferrer">ChatGPT</a>
        <a class="btn ai-btn" data-ai="claude" href="https://claude.ai/new" target="_blank" rel="noopener noreferrer">Claude</a>
        <a class="btn ai-btn" data-ai="gemini" href="https://gemini.google.com/app" target="_blank" rel="noopener noreferrer">Gemini</a>
      </div>
      <div class="copy-toast" id="copyToast"></div>
    </div>
    <div class="r-advanced">
      <button class="btn" id="btnAdvanced">直覺對話</button>
      <div class="r-advanced-hint">一對一語音諮詢</div>
      <div class="copy-toast" id="advToast"></div>
    </div>`;
  $('btnRestart').addEventListener('click', restart);
  $('btnCopy').addEventListener('click', () => copyAnalysis(a));
  $('btnAdvanced').addEventListener('click', () => {
    const t = $('advToast');
    t.textContent = '一對一語音諮詢正在建構中——此服務即將開放，敬請期待。';
    t.classList.add('show');
    setTimeout(() => t.classList.remove('show'), 3200);
  });
  $('btnCoffee').addEventListener('click', () => {
    if (BMC_URL) { window.open(BMC_URL, '_blank', 'noopener,noreferrer'); return; }
    const t = $('coffeeToast');
    t.textContent = '贊助連結即將開放，感謝你的支持 ☕';
    t.classList.add('show');
    setTimeout(() => t.classList.remove('show'), 3200);
  });
  $('resultHost').querySelectorAll('.ai-btn').forEach((b) => {
    b.addEventListener('click', () => continueWithAI(a));
  });
  showScreen('screenResult');
}

// 完整內容（複製與導流共用）：主題 + 各節解析 + 結語
function fullText(a) {
  const sections = sectionsOf(a);
  return [
    a.title || '分析結果',
    '',
    `我的主題：${state.opening}`,
    '',
    ...sections.map((s) => `【${TOOL_LABELS[s.tool] || s.tool}】\n${String(s.content || '')}`),
    a.closing ? `\n${a.closing}` : '',
    '\n— Intuitive Notes',
  ].filter((s) => s !== '').join('\n\n');
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
    '以下是我剛在「Intuitive Notes」完成的一次分析，請你先讀完：',
    '',
    fullText(a),
    '',
    '請你扮演一位溫暖而誠實的引導者，基於以上的主題與分析，陪我繼續深入探討——我接下來會針對其中的內容提問。',
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
  // 重置工具選取，避免回首頁後殘留上一場的選取狀態（顯示為已選、再點卻變成取消）
  selectedTools.clear();
  toolButtons.forEach((b) => { b.classList.remove('on'); b.setAttribute('aria-pressed', 'false'); });
  refreshStart();
  showScreen('screenIntake');
}

// ---- 續玩 ----
(function resume() {
  const saved = loadSession();
  if (!saved || !saved.opening || !Array.isArray(saved.tools)) return;
  state = saved;

  if (state.status === 'done' && state.analysis) { renderResult(state.analysis); return; }
  if (state.status === 'weaving') { runAnalysis(); return; }
  // collect：從尚未蒐集的工具接續（已蒐集的保留）
  collectNext();
})();

// ---- utils ----
function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
