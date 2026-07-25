// app.js — Intuitive Notes 頂層流程控制（MVP）。
// 節奏：首頁輸入主題＋勾選工具 → 依所選工具依序蒐集資料
// （雷諾曼選牌／梅花報數／占星出生資料）→ 分析 → 分節結果。
// 每一步都 saveSession，支援重整續玩。

import {
  createSession, saveSession, loadSession, clearSession, TOOL_LABELS,
} from './engine/session.js';
import { castMeihua, getAnalysis, fetchAstroChart } from './engine/inquiry.js';
import {
  saveAnalysisToHistory, loadHistory, deleteHistoryRecord, clearHistory,
} from './engine/history.js';
import { loadBirthProfile, saveBirthProfile, clearBirthProfile } from './engine/profile.js';
import { feedbackFor, rememberFeedback } from './engine/feedback.js';
import { shuffledDeckOrder, spreadFromPicks } from './engine/lenormand.js';
import { cardConstellation } from '../data/lenormandIcons.js';
import { countryList } from '../data/countries.js';
import { detectCrisis } from './content/crisis.js';
import { trackVisit, trackScreen, trackJourney, sendFeedback } from './analytics.js';
import {
  t, dict, cardName, getLocale, setLocale, onLocaleChange, refineByCountry,
  initDocumentLang, LOCALE_LIST, localeName,
} from './i18n/index.js';

const $ = (id) => document.getElementById(id);
let state = null;
let spreadRepaint = null; // 選牌畫面的輕量重繪（切換語系時只換文字）

// 工具名稱：走語系字典（synthesis 也在 tools 內）
function toolLabel(tool) {
  return t(`tools.${tool}`) || TOOL_LABELS[tool] || tool || '';
}

// ---- 靜態文案：把 data-i18n / data-i18n-html / data-i18n-ph / data-i18n-aria 套上目前語系 ----
function applyStaticText(root = document) {
  root.querySelectorAll('[data-i18n]').forEach((el) => {
    const v = t(el.dataset.i18n);
    if (v) el.textContent = v;
  });
  root.querySelectorAll('[data-i18n-html]').forEach((el) => {
    const v = t(el.dataset.i18nHtml);
    if (v) el.innerHTML = v; // 僅用於自家語系檔中含 <b> 的字串
  });
  root.querySelectorAll('[data-i18n-ph]').forEach((el) => {
    const v = t(el.dataset.i18nPh);
    if (v) el.setAttribute('placeholder', v);
  });
  root.querySelectorAll('[data-i18n-aria]').forEach((el) => {
    const v = t(el.dataset.i18nAria);
    if (v) el.setAttribute('aria-label', v);
  });
}

// ---- 選單內的語言切換 ----
function renderLangRow() {
  const row = $('langRow');
  if (!row) return;
  row.innerHTML = LOCALE_LIST.map((code) => `
    <button type="button" class="lang-opt${code === getLocale() ? ' on' : ''}"
      data-lang="${code}" lang="${code}">${esc(localeName(code))}</button>`).join('');
  row.querySelectorAll('.lang-opt').forEach((b) => {
    b.addEventListener('click', () => setLocale(b.dataset.lang, true));
  });
}

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

// ---- 左上角選單 ----
function setMenu(open) {
  const menu = $('sideMenu');
  menu.classList.toggle('open', open);
  menu.setAttribute('aria-hidden', open ? 'false' : 'true');
  const toggle = $('menuToggle');
  toggle.classList.toggle('is-open', open);
  toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
}
$('menuToggle').addEventListener('click', () => setMenu(!$('sideMenu').classList.contains('open')));
$('sideMenu').addEventListener('click', (e) => {
  const el = e.target.closest('[data-act]');
  if (!el) return;
  const act = el.dataset.act;
  if (act === 'coffee') { setMenu(false); return; } // <a> 自行開新分頁
  e.preventDefault();
  setMenu(false);
  if (act === 'home') restart();
  else if (act === 'history') renderHistory();
  else if (act === 'guide') renderGuide();
  // act === 'close'：點背景即關閉（上面已 setMenu(false)）
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') setMenu(false); });

// ---- 探索工具介紹（選單頁） ----
// 內容全在語系字典裡（guide 區塊），這裡只負責排版：
// 先三張速覽卡（滑一下就知道差異），再逐一展開細節，最後是「不知道該選哪一個？」。
function renderGuide() {
  const g = dict().guide || {};
  const rows = (list) => (list || []).map((r) => `
    <li class="gd-row"><span class="gd-row-name">${esc(r.name)}</span><span class="gd-row-line">${esc(r.line)}</span></li>`).join('');

  const cards = (g.cards || []).map((c) => `
    <div class="gd-card">
      <div class="gd-card-name"><span class="gd-mark" aria-hidden="true">✦</span>${esc(c.name)}</div>
      <div class="gd-card-line">${esc(c.line)}</div>
    </div>`).join('');

  const sections = (g.sections || []).map((s) => `
    <section class="gd-sec">
      <h3 class="gd-sec-name">${esc(s.name)}</h3>
      <p class="gd-lede">${esc(s.lede)}</p>
      <div class="gd-meta">
        <div class="gd-label">${esc(s.metaLabel)}</div>
        <p class="gd-meta-text">${s.meta}</p>
      </div>
      <div class="gd-asks">
        <div class="gd-label">${esc(s.asksLabel)}</div>
        <ul class="gd-ask-list">${(s.asks || []).map((a) => `<li>${esc(a)}</li>`).join('')}</ul>
      </div>
    </section>`).join('<div class="rule-orn" aria-hidden="true"></div>');

  $('guideHost').innerHTML = `
    <section class="gd-overview">
      <p class="gd-lede">${esc(g.overviewLede)}</p>
      <div class="gd-cards">${cards}</div>
    </section>
    <div class="rule-orn" aria-hidden="true"></div>
    ${sections}
    <div class="rule-orn" aria-hidden="true"></div>
    <section class="gd-choose">
      <h2 class="gd-h2">${esc(g.chooseTitle)}</h2>
      ${(g.chooseBody || []).map((p) => `<p class="gd-lede">${esc(p)}</p>`).join('')}
      <div class="gd-label">${esc(g.exampleLabel)}</div>
      <p class="gd-example-q">${esc(g.exampleQ)}</p>
      <ul class="gd-rows">${rows(g.exampleRows)}</ul>
      <p class="gd-lede">${esc(g.focusLabel)}</p>
      <ul class="gd-rows">${rows(g.focusRows)}</ul>
      <p class="gd-lede">${esc(g.closing)}</p>
    </section>
    <div class="gd-actions">
      <button type="button" class="btn primary" id="btnGuideStart">${esc(g.cta)}</button>
    </div>`;

  $('btnGuideStart').addEventListener('click', () => showScreen('screenIntake'));
  showScreen('screenGuide');
}

// ---- 我的靈感訊息（本機歷史回顧） ----
function formatDate(ms) {
  const d = new Date(ms || Date.now());
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function renderHistory(keepScreen) {
  const items = loadHistory();
  const host = $('historyHost');
  if (!items.length) {
    host.innerHTML = `<div class="hist-empty">${t('history.empty')}</div>`;
  } else {
    host.innerHTML = `
      <div class="hist-bar">
        <span class="hist-count">${esc(t('history.count', items.length))}</span>
        <button type="button" class="hist-clear" id="btnHistClear">${esc(t('history.clearAll'))}</button>
      </div>
      ${items.map((r, i) => {
        const tools = (r.tools || []).map(toolLabel).join(t('listSep'));
        return `<div class="hist-card">
          <button type="button" class="hist-open" data-idx="${i}">
            <div class="hist-card-title">${esc((r.analysis && r.analysis.title) || t('result.titleFallback'))}</div>
            <div class="hist-card-topic">${esc(t('result.about', r.opening))}</div>
            <div class="hist-card-meta">${esc(tools)}${tools ? ' · ' : ''}${esc(formatDate(r.savedAt))}</div>
          </button>
          <button type="button" class="hist-del" data-id="${esc(r.id)}" aria-label="${esc(t('history.delAria'))}">${esc(t('history.del'))}</button>
        </div>`;
      }).join('')}`;

    host.querySelectorAll('.hist-open').forEach((b) => {
      b.addEventListener('click', () => openHistoryRecord(items[Number(b.dataset.idx)]));
    });
    // 單筆刪除：需二次確認（再按一次才真的刪）
    host.querySelectorAll('.hist-del').forEach((b) => {
      b.addEventListener('click', () => {
        if (b.dataset.confirm !== '1') {
          host.querySelectorAll('.hist-del').forEach((o) => { o.dataset.confirm = ''; o.textContent = t('history.del'); o.classList.remove('confirm'); });
          b.dataset.confirm = '1';
          b.textContent = t('history.delConfirm');
          b.classList.add('confirm');
          return;
        }
        deleteHistoryRecord(b.dataset.id);
        renderHistory(true);
      });
    });
    // 全部清空：同樣二次確認
    const clearBtn = $('btnHistClear');
    clearBtn.addEventListener('click', () => {
      if (clearBtn.dataset.confirm !== '1') {
        clearBtn.dataset.confirm = '1';
        clearBtn.textContent = t('history.clearConfirm');
        clearBtn.classList.add('confirm');
        return;
      }
      clearHistory();
      renderHistory(true);
    });
  }
  if (!keepScreen) showScreen('screenHistory');
}

// 以歷史紀錄重建 state，沿用結果頁既有渲染（九宮格、對照牌卡、複製與導流）
function openHistoryRecord(rec) {
  if (!rec || !rec.analysis) return;
  state = {
    runId: rec.id,
    version: 3,
    status: 'done',
    opening: rec.opening || '',
    tools: Array.isArray(rec.tools) ? rec.tools : [],
    lenormand: rec.lenormand || null,
    meihua: rec.meihua || null,
    astro: rec.astro || null,
    numbers: rec.numbers || null,
    analysis: rec.analysis,
    usedOffline: !!rec.usedOffline,
    fromHistory: true,
  };
  renderResult(rec.analysis);
}

// ---- 入口：主題 + 選擇分析工具（單選：一次只能選一個） ----
const selectedTools = new Set();
const toolButtons = [...$('toolGrid').querySelectorAll('.tool-opt:not(.soon)')];

function refreshStart() {
  $('btnStart').disabled = !($('question').value.trim() && selectedTools.size);
}
toolButtons.forEach((btn) => {
  btn.addEventListener('click', () => {
    const tool = btn.dataset.tool;
    const already = selectedTools.has(tool);
    selectedTools.clear();
    toolButtons.forEach((b) => { b.classList.remove('on'); b.setAttribute('aria-pressed', 'false'); });
    if (!already) { // 再點同一個＝取消選取
      selectedTools.add(tool);
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
  return collectedCount() === 0 ? t('step.first') : t('step.then');
}
function collectNext() {
  const next = state.tools.find((tool) => !collected(tool));
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
  deck.closest('.spread').querySelector('.divine-lede').textContent = `${stepPrefix()}${t('spread.lede')}`;

  const order = shuffledDeckOrder(); // 牌池顯示順序（牌背朝上，位置不代表任何牌）
  let picks = []; // 已選牌的索引（0..35），選取順序即內部九宮格位置；不對使用者揭示牌面

  function renderCount() {
    count.textContent = t('spread.picked', picks.length);
    doneBtn.disabled = picks.length !== 9;
  }
  // 切換語系時只更新文字，不重建牌池（避免清掉使用者已選的牌）
  spreadRepaint = () => {
    deck.closest('.spread').querySelector('.divine-lede').textContent = `${stepPrefix()}${t('spread.lede')}`;
    deck.querySelectorAll('.deck-card').forEach((c) => c.setAttribute('aria-label', t('spread.cardBack')));
    renderCount();
  };

  // 牌池：36 張牌背。點一張＝選取（發光框），再點一次＝取消選取；牌不翻面、不消失。
  deck.innerHTML = '';
  order.forEach((cardIdx) => {
    const el = document.createElement('div');
    el.className = 'deck-card';
    el.dataset.cardIdx = String(cardIdx);
    el.setAttribute('role', 'button');
    el.setAttribute('aria-pressed', 'false');
    el.setAttribute('aria-label', t('spread.cardBack'));
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
  $('screenNumbers').querySelector('.divine-lede').textContent = `${stepPrefix()}${t('numbers.lede')}`;

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
    picked.textContent = t('numbers.chosen', nums);
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

  let pickedPlace = null;   // 從搜尋清單選定的城市（帶經緯度/時區，計算時免再 geocode）
  let pickedCountry = null; // 從國家清單選定 {code, zh, en}
  const COUNTRIES = countryList();
  // 國名一律用自家清單的繁體名（Intl.DisplayNames zh-Hant）——
  // 上游 geocoder 以簡體回傳（例如「台湾」），不可直接顯示
  const CC2ZH = Object.fromEntries(COUNTRIES.map((c) => [c.code, c.zh]));
  // 中文語系才覆蓋國名（自家清單為繁體，上游中文索引是簡體）；
  // 其他語系直接採用後端依語系回傳的字樣
  const countryName = (r) => (getLocale() === 'zh-Hant'
    ? (CC2ZH[String(r.countryCode || '').toUpperCase()] || r.country || '')
    : (r.country || ''));

  const refresh = () => {
    timeEl.disabled = unknownEl.checked;
    doneBtn.disabled = !(dateEl.value && (pickedPlace || cityEl.value.trim()) && (unknownEl.checked || timeEl.value));
  };
  [dateEl, timeEl].forEach((el) => { el.oninput = refresh; });
  unknownEl.onchange = refresh;

  // -- 城市：即時搜尋合法清單（含臺↔台變體），點選後鎖定經緯度與時區 --
  let cityTimer = null;
  let citySeq = 0;
  // state：'searching'（正在查）｜'failed'（服務異常）｜陣列（結果）｜null（收起）
  const renderCityList = (items, state) => {
    if (state === 'searching') {
      cityListEl.innerHTML = `<div class="combo-empty">${esc(t('astro.searching'))}</div>`;
      cityListEl.hidden = false;
      return;
    }
    if (state === 'failed') {
      cityListEl.innerHTML = `<div class="combo-empty">${esc(t('astro.searchFailed'))}</div>`;
      cityListEl.hidden = false;
      return;
    }
    if (!items) { cityListEl.hidden = true; cityListEl.innerHTML = ''; return; }
    cityListEl.innerHTML = items.length
      ? items.map((r, i) => `<div class="combo-item" data-i="${i}"><span>${esc(r.name)}${r.admin1 ? `<small>，${esc(r.admin1)}</small>` : ''}</span><small>${esc(countryName(r))}</small></div>`).join('')
      : `<div class="combo-empty">${esc(t('astro.emptyCity'))}</div>`;
    cityListEl.hidden = false;
    cityListEl.querySelectorAll('.combo-item').forEach((el) => {
      el.addEventListener('mousedown', (ev) => { ev.preventDefault(); pickCity(items[Number(el.dataset.i)]); });
    });
  };
  const pickCity = (r) => {
    pickedPlace = r;
    cityEl.value = r.name;
    const cz = countryName(r);
    cityPickedEl.textContent = `${t('astro.picked', r.name)}${r.admin1 ? `，${r.admin1}` : ''}（${cz || '—'}・${r.timezone || ''}）`;
    if (cz && !countryEl.value.trim()) countryEl.value = cz;
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
    renderCityList(null, 'searching');
    cityTimer = setTimeout(async () => {
      const seq = ++citySeq;
      try {
        const res = await fetch(`/api/astro?q=${encodeURIComponent(q)}&lang=${encodeURIComponent(getLocale())}`);
        const json = await res.json();
        if (seq !== citySeq) return;
        const all = (json && json.results) || [];
        // 上游查詢失敗且完全沒有結果 → 明確告知是服務異常，不要說「找不到城市」
        if (!all.length && json && json.searchOk === false) { renderCityList(null, 'failed'); return; }
        // 已選國家只用來排序，不過濾掉其他結果——避免使用者先選了國家就看到空清單
        let items = all;
        if (pickedCountry) {
          const inCountry = (r) => String(r.countryCode || '').toUpperCase() === pickedCountry.code;
          items = [...all.filter(inCountry), ...all.filter((r) => !inCountry(r))];
        }
        renderCityList(items.slice(0, 8));
      } catch { if (seq === citySeq) renderCityList(null, 'failed'); }
    }, 350);
  };
  cityEl.onblur = () => setTimeout(() => renderCityList(null), 150);

  // -- 國家／地區：完整 ISO 清單（繁中＋英文皆可搜尋），輸入即過濾 --
  const renderCountryList = (items) => {
    if (!items) { countryListEl.hidden = true; countryListEl.innerHTML = ''; return; }
    countryListEl.innerHTML = items.length
      ? items.map((c, i) => `<div class="combo-item" data-i="${i}"><span>${esc(c.zh)}</span><small>${esc(c.en)}</small></div>`).join('')
      : `<div class="combo-empty">${esc(t('astro.emptyCountry'))}</div>`;
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

  // ---- 自動帶入上次填過的出生資料（存在本機，省去重複輸入）----
  const savedEl = $('astroSaved');
  const showSavedHint = (on) => { savedEl.hidden = !on; };
  const fillFrom = (prof) => {
    dateEl.value = prof.date || '';
    unknownEl.checked = !!prof.timeUnknown;
    timeEl.value = prof.timeUnknown ? '' : (prof.time || '');
    cityEl.value = prof.city || '';
    countryEl.value = prof.country || '';
    if (prof.place && prof.place.latitude != null && prof.place.timezone) {
      pickedPlace = prof.place;
      const cz = countryName(prof.place);
      cityPickedEl.textContent = `${t('astro.picked', prof.place.name || prof.city || '')}`
        + `${prof.place.admin1 ? `，${prof.place.admin1}` : ''}（${cz || '—'}・${prof.place.timezone}）`;
    }
    refresh();
  };
  const profile = loadBirthProfile();
  if (profile) { fillFrom(profile); showSavedHint(true); } else { showSavedHint(false); }

  // 換一組資料（例如替別人看盤）：清空表單與本機紀錄
  $('btnAstroReset').onclick = () => {
    clearBirthProfile();
    pickedPlace = null;
    pickedCountry = null;
    dateEl.value = '';
    timeEl.value = '';
    unknownEl.checked = false;
    cityEl.value = '';
    countryEl.value = '';
    cityPickedEl.textContent = '';
    errEl.textContent = '';
    renderCityList(null);
    renderCountryList(null);
    showSavedHint(false);
    refresh();
    dateEl.focus();
  };

  refresh();

  doneBtn.onclick = async () => {
    errEl.textContent = '';
    doneBtn.disabled = true;
    doneBtn.textContent = t('astro.calculating');
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
      // 記在本機，下次占星自動帶入
      saveBirthProfile({
        date: dateEl.value,
        time: timeEl.value,
        timeUnknown: unknownEl.checked,
        city: cityEl.value.trim(),
        country: countryEl.value.trim(),
        place: pickedPlace,
      });
      collectNext();
    } catch (e) {
      errEl.textContent = ({
        geocode_failed: t('astro.err.geocode'),
        date_out_of_range: t('astro.err.date'),
        tz_unavailable: t('astro.err.tz'),
      })[e.code] || t('astro.err.generic');
      doneBtn.textContent = t('astro.submit');
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
      <div class="lg-name">${esc(cardName(card.id, card.name))}</div>
    </div>`).join('');
  return `<div class="lenormand-grid" aria-label="${esc(t('spread.gridAria'))}">${cells}</div>`;
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

// 九宮格閱讀組別 → 固定位置。依目前語系取標籤，AI 也被要求用同一組標籤。
// 依字數由長到短排序，確保「潛意識層」先於「意識層」比對（日文的「潜在意識」對「意識」亦同）。
const GROUP_POS = {
  subconscious: [7, 8, 9], conscious: [1, 2, 3], material: [4, 5, 6],
  past: [1, 4, 7], present: [2, 5, 8], future: [3, 6, 9],
  heart: [5], cross: [2, 4, 6, 8], corners: [1, 3, 7, 9],
};
function groupLabels() {
  const g = dict().groups || {};
  return Object.keys(GROUP_POS)
    .map((k) => ({ label: g[k] || k, pos: GROUP_POS[k] }))
    .filter((x) => x.label)
    .sort((a, b) => b.label.length - a.label.length);
}

// 決定某段落前方要顯示哪些對照牌卡（回傳位置群組陣列）。
// 主：內文若明寫「（1、4、7）」這類位置，全部採用；
// 備：AI 常以自然語言寫成「過去那一排」，故段落開頭若是已知組別名稱，用該組固定位置。
function posGroupsForBlock(text) {
  const explicit = posGroupsInText(text);
  if (explicit.length) return explicit;
  const txt = String(text).trim();
  if (txt.length < 10) return []; // 太短多半是小標題本身（如「時間軸」「十字法」），不放牌卡
  const head = txt.slice(0, 10);  // 只看開頭，避免內文中偶然出現「現在」等常用詞誤判
  for (const g of groupLabels()) {
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
      <figcaption class="lg-mini-name">${esc(cardName(item.card.id, item.card.name))}</figcaption>
    </figure>`;
  }).join('');
  if (!cells) return '';
  return `<div class="lg-strip" aria-label="${esc(t('spread.stripAria'))}">${cells}</div>`;
}

// 該段落是否為「單獨成行的組別小標題」（如只寫「過去」「潛意識層」）。
// 需完全等於組名（可帶尾端標點），避免「十字法」這種章節標題被誤判為「十字」。
function exactGroupLabel(text) {
  const txt = String(text).trim().replace(/[：:。，,、\s]+$/, '');
  if (txt.length > 5) return null;
  return groupLabels().find((g) => g.label === txt) || null;
}

// 雷諾曼解析內文：逐段落渲染。
// ・若某行是單獨的組別小標題（過去／現在／未來／意識層…），就把「小標題＋對應牌卡＋
//   接在後面的內文」合併進同一塊面板，讀者一眼看到標題、牌面與解讀。
// ・若內文自己帶位置或以組名開頭（舊格式），仍在該段面板最上方放牌卡。
function lenormandContentHtml(content, spread) {
  const hasSpread = Array.isArray(spread) && spread.length;
  const blocks = String(content || '').split(/\n+/).map((s) => s.trim()).filter(Boolean);
  if (!blocks.length) return `<p>${esc(String(content || ''))}</p>`;

  const out = [];
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    const g = exactGroupLabel(b);
    if (g) {
      // 組別小標題：帶上牌卡，並把下一段內文併進同一塊面板
      const strip = hasSpread ? cardStripHtml(spread, g.pos) : '';
      const next = blocks[i + 1];
      const body = (next && !exactGroupLabel(next)) ? next : '';
      if (body) i += 1;
      out.push(`<div class="lg-para"><div class="lg-sub">${esc(g.label)}</div>${strip}`
        + (body ? `<p>${esc(body)}</p>` : '') + `</div>`);
      continue;
    }
    const strip = hasSpread
      ? posGroupsForBlock(b).map((gr) => cardStripHtml(spread, gr)).join('')
      : '';
    out.push(`<div class="lg-para">${strip}<p>${esc(b)}</p></div>`);
  }
  return out.join('');
}

// ---- 使用者回饋（星等＋選填文字，送到後台） ----
const FB_STARS = 5;

// 已回饋過就直接呈現感謝狀態；否則畫出星等（選了星才展開文字框與送出鈕）
function feedbackHtml() {
  const done = feedbackFor(state && state.runId);
  if (done) return `<div class="r-feedback done"><div class="fb-done">${esc(t('feedback.already', done))}</div></div>`;
  const stars = Array.from({ length: FB_STARS }, (_, i) => i + 1).map((n) => `
    <button type="button" class="fb-star" data-rating="${n}"
      aria-label="${esc(t('feedback.starAria', n))}" title="${esc(t('feedback.scale', n))}">★</button>`).join('');
  return `<div class="r-feedback" id="fbBlock">
    <div class="fb-title">${esc(t('feedback.title'))}</div>
    <div class="fb-stars" id="fbStars" role="group" aria-label="${esc(t('feedback.title'))}">${stars}</div>
    <div class="fb-scale" id="fbScale"></div>
    <div class="fb-more" id="fbMore" hidden>
      <textarea class="fb-text" id="fbText" maxlength="500" rows="3"
        placeholder="${esc(t('feedback.textPh'))}"></textarea>
      <button type="button" class="btn fb-send" id="btnFeedback">${esc(t('feedback.send'))}</button>
      <div class="fb-hint">${esc(t('feedback.hint'))}</div>
      <div class="fb-msg" id="fbMsg"></div>
    </div>
  </div>`;
}

function bindFeedback() {
  const block = $('fbBlock');
  if (!block) return; // 已回饋過，沒有互動元素
  const scaleEl = $('fbScale');
  const moreEl = $('fbMore');
  const msgEl = $('fbMsg');
  const sendBtn = $('btnFeedback');
  let rating = 0;

  const paint = () => {
    block.querySelectorAll('.fb-star').forEach((b) => {
      b.classList.toggle('on', Number(b.dataset.rating) <= rating);
    });
    scaleEl.textContent = rating ? t('feedback.scale', rating) : '';
  };

  block.querySelectorAll('.fb-star').forEach((b) => {
    b.addEventListener('click', () => {
      rating = Number(b.dataset.rating);
      paint();
      moreEl.hidden = false;
      msgEl.textContent = '';
    });
  });

  sendBtn.addEventListener('click', async () => {
    if (!rating || sendBtn.disabled) return;
    sendBtn.disabled = true;
    sendBtn.textContent = t('feedback.sending');
    msgEl.textContent = '';
    try {
      await sendFeedback({ rating, text: $('fbText').value, state, lang: getLocale() });
      rememberFeedback(state && state.runId, rating);
      block.classList.add('done');
      block.innerHTML = `<div class="fb-done">${esc(t('feedback.done'))}</div>`;
    } catch {
      msgEl.textContent = t('feedback.failed');
      sendBtn.disabled = false;
      sendBtn.textContent = t('feedback.send');
    }
  });
}

function renderResult(a) {
  const sections = sectionsOf(a);
  const secHtml = sections.map((s) => `
    <div class="r-section">
      <h3 class="r-sec-head">${esc(toolLabel(s.tool))}</h3>
      ${s.tool === 'lenormand' ? spreadGridHtml(state.lenormand) : ''}
      <div class="r-block">${s.tool === 'lenormand'
        ? lenormandContentHtml(s.content, state.lenormand)
        : `<p>${esc(String(s.content || ''))}</p>`}</div>
    </div>`).join('');

  // 直接從使用者的主題開始（不放標題句），結尾也不放祝福語
  $('resultHost').innerHTML = `
    <div class="r-topic">${esc(t('result.about', state.opening))}</div>
    <div class="rule-orn" aria-hidden="true"></div>
    ${secHtml}
    ${feedbackHtml()}
    <div class="r-sponsor">
      <p class="r-sponsor-line">${esc(t('result.sponsorAsk'))}</p>
      <button class="btn bmc-btn" id="btnCoffee">${esc(t('result.sponsorBtn'))}</button>
      <div class="copy-toast" id="coffeeToast"></div>
    </div>
    <div class="r-actions">
      <button class="btn" id="btnCopy">${esc(t('result.copy'))}</button>
      <button class="btn" id="btnRestart">${esc(t('result.home'))}</button>
    </div>
    <div class="r-continue">
      <div class="r-continue-title">${esc(t('result.continueTitle'))}</div>
      <p class="r-continue-hint">${esc(t('result.continueHint'))}</p>
      <div class="ai-row">
        <a class="btn ai-btn" data-ai="chatgpt" href="https://chatgpt.com/" target="_blank" rel="noopener noreferrer">ChatGPT</a>
        <a class="btn ai-btn" data-ai="claude" href="https://claude.ai/new" target="_blank" rel="noopener noreferrer">Claude</a>
        <a class="btn ai-btn" data-ai="gemini" href="https://gemini.google.com/app" target="_blank" rel="noopener noreferrer">Gemini</a>
      </div>
      <div class="copy-toast" id="copyToast"></div>
    </div>
    <div class="r-advanced">
      <button class="btn" id="btnAdvanced">${esc(t('result.advanced'))}</button>
      <div class="r-advanced-hint">${esc(t('result.advancedHint'))}</div>
      <div class="copy-toast" id="advToast"></div>
    </div>`;
  bindFeedback();
  $('btnRestart').addEventListener('click', restart);
  $('btnCopy').addEventListener('click', () => copyAnalysis(a));
  $('btnAdvanced').addEventListener('click', () => {
    const el = $('advToast');
    el.textContent = t('result.advancedSoon');
    el.classList.add('show');
    setTimeout(() => el.classList.remove('show'), 3200);
  });
  $('btnCoffee').addEventListener('click', () => {
    if (BMC_URL) { window.open(BMC_URL, '_blank', 'noopener,noreferrer'); return; }
    const el = $('coffeeToast');
    el.textContent = t('result.sponsorSoon');
    el.classList.add('show');
    setTimeout(() => el.classList.remove('show'), 3200);
  });
  const handoff = buildHandoff(a);
  $('resultHost').querySelectorAll('.ai-btn').forEach((b) => {
    const provider = b.dataset.ai;
    b.href = aiHandoffUrl(provider, handoff); // 透過 query param 預先帶入內容
    b.addEventListener('click', () => continueWithAI(a, provider));
  });
  showScreen('screenResult');
}

// 完整內容（複製與導流共用）：主題 + 各節解析 + 結語
function fullText(a) {
  const sections = sectionsOf(a);
  return [
    t('result.myTopic', state.opening),
    '',
    ...sections.map((s) => `【${toolLabel(s.tool)}】\n${String(s.content || '')}`),
    '\n' + t('result.signature'),
  ].filter((s) => s !== '').join('\n\n');
}

function copyAnalysis(a) {
  const btn = $('btnCopy');
  navigator.clipboard.writeText(fullText(a)).then(
    () => { btn.textContent = t('result.copied'); setTimeout(() => { btn.textContent = t('result.copy'); }, 1800); },
    () => { btn.textContent = t('result.copyFail'); }
  );
}

// 導流用文字：內容 ＋ 接續提問引導（複製與 query param 帶入共用同一份）
function buildHandoff(a) {
  return [
    t('result.handoffPrefix'),
    '',
    fullText(a),
    '',
    t('result.handoffSuffix'),
  ].join('\n');
}

// 各 AI 的開新分頁網址；ChatGPT／Claude 支援 ?q= 預填提示，Gemini 無官方預填參數
const AI_ENDPOINTS = {
  chatgpt: 'https://chatgpt.com/?q=',
  claude: 'https://claude.ai/new?q=',
  gemini: 'https://gemini.google.com/app', // 無預填參數，維持原網址（靠剪貼簿）
};

function aiHandoffUrl(provider, text) {
  const base = AI_ENDPOINTS[provider] || AI_ENDPOINTS.chatgpt;
  if (provider === 'gemini') return base; // 不支援 query 預填
  return base + encodeURIComponent(text);
}

// 導流：連結已透過 query param 預先帶入內容；仍把同一份文字寫入剪貼簿當後備
function continueWithAI(a, provider) {
  const handoff = buildHandoff(a);
  const canPrefill = provider !== 'gemini';
  navigator.clipboard.writeText(handoff).then(
    () => showToast(canPrefill
      ? t('result.aiPrefilledCopied')
      : t('result.aiGemini')),
    () => showToast(canPrefill
      ? t('result.aiPrefilled')
      : t('result.aiFallback'))
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

// ---- 語系啟動與切換 ----
// 目前停留在哪個畫面，切換語系後要重繪同一個畫面（動態產生的內容不會自動更新）
function repaintCurrentScreen() {
  const active = document.querySelector('.screen.active');
  const id = active ? active.id : 'screenIntake';
  if (id === 'screenResult' && state && state.analysis) { renderResult(state.analysis); return; }
  if (id === 'screenHistory') { renderHistory(); return; }
  if (id === 'screenGuide') { renderGuide(); return; }
  if (id === 'screenSpread' && spreadRepaint) { spreadRepaint(); return; }
  if (id === 'screenNumbers') {
    const lede = active.querySelector('.divine-lede');
    if (lede) lede.textContent = `${stepPrefix()}${t('numbers.lede')}`;
  }
}

initDocumentLang();
applyStaticText();
renderLangRow();
onLocaleChange(() => {
  applyStaticText();
  renderLangRow();
  repaintCurrentScreen();
  refreshStart();
});
// 瀏覽器語言完全沒有對應語系、使用者也還沒自己選過時，才用 IP 國家補救
refineByCountry();

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
