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
import { hexagramLines, meihuaForAI, castFromNumbers } from './engine/meihua.js';
import { buildShareCardSvg, svgToPng, shareCardPng } from './shareCard.js';
import { chartWheelSvg } from './chartWheel.js';
import { parseAstroSections } from './astroFormat.js';
import { mountChartZoom, closeChartZoom } from './chartZoom.js';
import { cardConstellation } from '../data/lenormandIcons.js';
import { LENORMAND } from '../data/lenormand.js';
import { countryList } from '../data/countries.js';
import { detectCrisis } from './content/crisis.js';
import { trackVisit, trackLang, trackScreen, trackJourney, trackTiming, sendFeedback } from './analytics.js';
import {
  t, dict, cardName, getLocale, setLocale, onLocaleChange, refineByCountry,
  initDocumentLang, LOCALE_LIST, localeName, groupLabelVariants,
} from './i18n/index.js';

const $ = (id) => document.getElementById(id);
let state = null;

// 後台的「預覽結果頁」：以 iframe 載入 index.html?preview=1，再用 postMessage
// 把那一次的紀錄餵進來，走的是與正式站完全相同的 renderResult()——這樣預覽
// 看到的就是使用者看到的，不會兩邊長得不一樣。
// 預覽模式下：不續玩、不寫 localStorage、不送統計（統計的閘門在 analytics.js）。
const PREVIEW = (() => {
  try { return new URLSearchParams(location.search).get('preview') === '1'; }
  catch { return false; }
})();
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
  applyLocaleOnly(root);
}

// 只在特定語系提供的功能：data-locale-only="zh-Hant,en" 列出可見的語系。
// 用 hidden 而不是 CSS class，連輔助科技與 Tab 鍵都一併跳過——
// 服務不存在時，讓它「讀得到但點不到」比直接不存在更糟。
function applyLocaleOnly(root = document) {
  const now = getLocale();
  root.querySelectorAll('[data-locale-only]').forEach((el) => {
    const allowed = el.dataset.localeOnly.split(',').map((s) => s.trim()).filter(Boolean);
    el.hidden = !allowed.includes(now);
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
// 社群：網站更新會先發在這裡，結果頁最後導引使用者追蹤
const THREADS_URL = 'https://www.threads.com/@intuitive.notes';

// trackVisit 不在這裡送——語言要等 refineByCountry 定案後才記，見下方啟動段
trackScreen('screenIntake');

// ---- 螢幕切換 ----
// 「分析中」的階段進度：等待期間唯一的遠端動作就是 /api/insight 一次呼叫
// （星盤在上一頁就算完了），而 LLM 沒有 streaming，所以**拿不到真實進度**。
// 因此這裡是依經過時間推進的階段描述，刻意不顯示百分比、不宣稱「快完成了」。
//
// 時間點依後台「處理時間」的實測校準（2026-07，n=13，使用者等待全程）：
//   中位數 37.1s ／ P90 56.1s ／ 最慢 59.4s ／ 最快 21.8s
// 初版把最後一段設在 40s，只比中位數高 3 秒——等於將近一半的人在完全正常的
// 一次分析裡就看到「比平常久」，那句話變成謊話還製造焦慮。改為對齊 P90。
// 註：LLM 佔了整段等待的 98%（36.5s / 37.1s），組 prompt 與網路加起來不到 3%，
// 所以想縮短等待唯一有效的槓桿是縮短輸出長度，不是優化這裡的程式。
const WEAVE_STAGES = [
  { at: 0, key: 'prep' },        // 整理資料、送出請求
  { at: 2500, key: 'sent' },     // 請求已在路上
  { at: 9000, key: 'reading' },  // 最久的一段：模型在寫（此時 LLM 已經跑了 ~8.5s）
  { at: 55000, key: 'longer' },  // ≈P90：只有約一成的人會看到，才配得上「比平常久」
];
const TIP_ROTATE_MS = 6500;
let stageTimers = [];
let tipTimer = null;
let tipIdx = 0;
let stageIdx = 0;     // 供切換語言時原地重畫

function showScreen(id) {
  document.querySelectorAll('.screen').forEach((s) => s.classList.remove('active'));
  $(id).classList.add('active');
  if (id !== 'screenWeaving') stopWeaveProgress();
  // 放大檢視是 body 層的浮層，換頁不會自動收掉——換語言重繪結果頁時也一樣，
  // 不關的話會蓋著新畫面，而且蓋著的是舊的那張圖
  closeChartZoom();
  trackScreen(id);
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function showWeaving(text) {
  if (text) $('weavingText').innerHTML = text;
  showScreen('screenWeaving');
  startWeaveProgress();
}

function stopWeaveProgress() {
  stageTimers.forEach(clearTimeout);
  stageTimers = [];
  clearInterval(tipTimer);
  tipTimer = null;
  $('weaveTip').hidden = true;
}

function startWeaveProgress() {
  stopWeaveProgress();
  $('weaveDots').innerHTML = WEAVE_STAGES
    .map((_, i) => `<span class="weave-dot${i === 0 ? ' on' : ''}"></span>`).join('');
  paintStage(0);
  WEAVE_STAGES.forEach((s, i) => {
    if (!s.at) return;
    stageTimers.push(setTimeout(() => paintStage(i), s.at));
  });
  tipIdx = 0;
  paintTip();
  tipTimer = setInterval(paintTip, TIP_ROTATE_MS);
}

function paintStage(i) {
  stageIdx = i;
  const s = WEAVE_STAGES[i];
  // prep 這段點名使用者選的工具（「正在整理你的梅花易數資料」）
  const tools = (state && state.tools) || [];
  const label = tools.length ? tools.map(toolLabel).join(t('listSep')) : '';
  $('weaveStageText').textContent = s.key === 'prep' && label
    ? t('weaving.stage.prep', label)
    : t(`weaving.stage.${s.key}`);
  const sub = dict().weaving && dict().weaving.sub && dict().weaving.sub[s.key];
  $('weaveStageSub').textContent = sub || '';
  $('weaveDots').querySelectorAll('.weave-dot')
    .forEach((d, n) => d.classList.toggle('on', n <= i));
}

// 切換語言時原地重畫（階段文字與提示都是 JS 寫入，applyStaticText 管不到）
function repaintWeaving() {
  if (!stageTimers.length && !tipTimer) return;
  paintStage(stageIdx);
  tipIdx = Math.max(0, tipIdx - 1); // 停在同一則，只換語言
  paintTip();
}

function paintTip() {
  const tips = (dict().weaving && dict().weaving.tips) || [];
  if (!tips.length) return;
  const box = $('weaveTip');
  const tip = tips[tipIdx % tips.length];
  tipIdx += 1;
  const draw = () => {
    $('weaveTipLabel').textContent = tip.label || '';
    $('weaveTipText').textContent = tip.text || '';
    box.hidden = false;
    // 讓瀏覽器先套用 hidden 解除後的初始狀態，再淡入
    requestAnimationFrame(() => box.classList.add('show'));
  };
  if (box.hidden) { draw(); return; }
  box.classList.remove('show');
  setTimeout(draw, 260); // 對齊 CSS 的 opacity transition
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
      ${s.note ? `<p class="gd-note">${esc(s.note)}</p>` : ''}
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
// 三個數字用「滑動選取」：原生 scroll-snap，慣性與回彈都交給瀏覽器，
// 手機上不彈鍵盤。每一格同時是按鈕，點擊也能選；方向鍵同樣可以調。
const PICK_ITEM_H = 46;   // 每一格的高度，需與 CSS 的 .np-opt 一致

function buildPickers() {
  const row = $('numRow');
  if (row.dataset.built) return;
  row.dataset.built = '1';
  row.innerHTML = [0, 1, 2].map((i) => {
    // 第一格是空白：不預選任何數字，維持「憑直覺自己選」
    const opts = ['', 1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => `
      <button type="button" class="np-opt${n === '' ? ' np-blank' : ''}"
        data-n="${n === '' ? 0 : n}" tabindex="-1"
        aria-hidden="${n === '' ? 'true' : 'false'}">${n === '' ? '—' : n}</button>`).join('');
    // 中央標示帶（.np-band）必須放在捲動容器**外面**：放在裡面的話它是相對
    // 捲動內容定位，會跟著數字一起捲走，只有 scrollTop=0 時才在正確位置。
    return `<div class="num-cell">
      <div class="num-pick" id="num${i + 1}" data-idx="${i}" data-value="0"
        role="spinbutton" tabindex="0" aria-valuemin="1" aria-valuemax="9"
        aria-label="${esc(t('numbers.digitAria', i + 1))}">
        <div class="np-track">${opts}</div>
      </div>
      <div class="np-band" aria-hidden="true"></div>
    </div>`;
  }).join('');
}

function pickerValue(el) { return Number(el.dataset.value) || 0; }

// 把某一欄捲到指定數字（0＝空白）。smooth 只在使用者操作時用，
// 初始化時要瞬間定位，否則會看到畫面自己滑一下。
//
// quietUntil：程式觸發的捲動也會叫醒 onscroll，而 onscroll 會清掉「此刻為你選出
// ——9、1、7」那行字。所以這裡標一段靜音期，讓 onscroll 只更新值、不清訊息，
// 否則「請幫我隨機選」會被自己造成的捲動把提示抹掉。
function setPickerValue(el, n, smooth = true) {
  const idx = Math.max(0, Math.min(9, n));
  el.dataset.quietUntil = String(Date.now() + (smooth ? 700 : 60));
  el.style.scrollBehavior = smooth ? 'smooth' : 'auto';
  el.scrollTop = idx * PICK_ITEM_H;
  syncPicker(el, idx);
}

const pickerQuiet = (el) => Date.now() < Number(el.dataset.quietUntil || 0);

// 依目前捲動位置決定選中哪一格，並更新樣式與 aria
function syncPicker(el, forceIdx) {
  const idx = forceIdx != null ? forceIdx : Math.round(el.scrollTop / PICK_ITEM_H);
  const n = Math.max(0, Math.min(9, idx));
  el.dataset.value = String(n);
  el.setAttribute('aria-valuenow', String(n || ''));
  el.setAttribute('aria-valuetext', n ? String(n) : t('numbers.blank'));
  el.querySelectorAll('.np-opt').forEach((o, i) => o.classList.toggle('on', i === n));
}

function runNumbers() {
  buildPickers();
  const picks = [$('num1'), $('num2'), $('num3')];
  const doneBtn = $('btnNumbersDone');
  const picked = $('numPicked');
  $('screenNumbers').querySelector('.divine-lede').textContent = `${stepPrefix()}${t('numbers.lede')}`;

  const refresh = () => { doneBtn.disabled = !picks.every((el) => pickerValue(el) >= 1); };

  picks.forEach((el) => {
    setPickerValue(el, 0, false);
    let t0 = null;
    el.onscroll = () => {
      // 捲動停下來才判定（原生 snap 會自己對位，這裡只是收尾）
      clearTimeout(t0);
      const quiet = pickerQuiet(el);
      t0 = setTimeout(() => {
        syncPicker(el);
        if (!quiet) picked.textContent = ''; // 使用者自己滑的才清提示
        refresh();
      }, 90);
    };
    el.onclick = (e) => {
      const opt = e.target.closest('.np-opt');
      if (!opt) return;
      setPickerValue(el, Number(opt.dataset.n));
      picked.textContent = '';
      refresh();
    };
    el.onkeydown = (e) => {
      const step = e.key === 'ArrowUp' ? -1 : e.key === 'ArrowDown' ? 1 : 0;
      if (!step) return;
      e.preventDefault();
      setPickerValue(el, pickerValue(el) + step);
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
  doneBtn.onclick = () => {
    if (picks.every((el) => pickerValue(el) >= 1)) proceed(picks.map(pickerValue));
  };

  // 隨機選三個 1–9 的數字（捲到該位置並列出，讓使用者看見後再確認）
  $('btnNumbersRandom').onclick = () => {
    const rand = new Uint32Array(3);
    crypto.getRandomValues(rand);
    const nums = [...rand].map((r) => (r % 9) + 1);
    picks.forEach((el, i) => setPickerValue(el, nums[i]));
    picked.textContent = t('numbers.chosen', nums);
    refresh();
  };

  // 不報數：由此刻的時間起卦
  $('btnNumbersSkip').onclick = () => proceed(null);

  showScreen('screenNumbers');
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
// 沒有離線後備：解讀要嘛完成，要嘛顯示重試畫面。
async function runAnalysis() {
  showWeaving();
  const t0 = Date.now();
  try {
    const analysis = await getAnalysis(state);
    saveSession(state);
    saveAnalysisToHistory(state); // 存進瀏覽器歷史（localStorage，供日後回顧頁讀取）
    trackJourney(state);
    const analyzeMs = Date.now() - t0;
    const waitMs = Math.max(0, 2400 - analyzeMs);
    reportTiming(analyzeMs, waitMs);
    setTimeout(() => renderResult(analysis), waitMs);
  } catch (e) {
    // 維持 weaving 狀態：重整或按重試都能從同一組牌與資料再跑一次
    state.status = 'weaving';
    saveSession(state);
    showAnalysisError((e && e.code) || 'failed');
  }
}

// 把「整合中」這段的時間拆開回報：前端等待、伺服器各階段、占星實算。
// astroMs 只在這一輪有算星盤時才有（重試同一場不會重算）。
function reportTiming(analyzeMs, holdMs) {
  try {
    const at = (state && state.analyzeTiming) || {};
    const sv = at.server || {};
    const astroMeta = (state && state.astro && state.astro.meta && state.astro.meta.timing) || null;
    trackTiming({
      tools: state.tools || null,
      lang: getLocale(),
      // 前端量到的
      analyzeMs,                                  // getAnalysis 全程（含網路）
      holdMs,                                     // 為了動畫刻意多等的時間
      weavingMs: analyzeMs + holdMs,              // 使用者實際盯著「分析中」的時間
      requestMs: at.requestMs || null,            // /api/insight 往返
      // /api/insight 伺服器端
      promptMs: sv.promptMs != null ? sv.promptMs : null,
      recordMs: sv.recordMs != null ? sv.recordMs : null,
      llmMs: Array.isArray(sv.llmMs) ? sv.llmMs : null,
      insightServerMs: sv.serverMs != null ? sv.serverMs : null,
      attempts: sv.attempts || null,
      promptChars: sv.promptChars || null,
      model: sv.model || '',
      provider: sv.provider || '',
      // /api/astro（Swiss Ephemeris）
      astroRoundTripMs: (state && state.astro && state.astro.roundTripMs) || null,
      astroGeocodeMs: astroMeta ? astroMeta.geocodeMs : null,
      astroEphemerisMs: astroMeta ? astroMeta.ephemerisMs : null,
      astroServerMs: astroMeta ? astroMeta.serverMs : null,
    });
  } catch { /* 計時回報失敗不影響體驗 */ }
}

function showAnalysisError(code) {
  const body = code === 'timeout' ? t('analysisError.timeout')
    : code === 'unavailable' ? t('analysisError.unavailable')
      : t('analysisError.body');
  $('errBody').textContent = body;
  showScreen('screenError');
}

$('btnErrRetry').addEventListener('click', () => { if (state) runAnalysis(); else restart(); });
$('btnErrHome').addEventListener('click', restart);

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

// 梅花易數卦象：本卦／互卦／變卦各一張「牌」，六爻以橫槓畫出（由下而上）。
// 與雷諾曼九宮格同一套視覺語言——同樣在該節最上方，讓使用者看得到抽到什麼。
function meihuaGridHtml(cast) {
  if (!cast || !cast.ben) return '';
  const g = dict().meihuaGrid || {};
  const cell = (hex, role, movingAt) => {
    if (!hex) return '';
    const lines = hexagramLines(hex);
    if (!lines.length) return '';
    // DOM 由上而下，六爻由下而上：反轉後才是傳統的擺法（上爻在最上）
    const yao = lines.map((v, i) => {
      const isMoving = movingAt && (i + 1) === movingAt;
      return `<span class="mh-yao ${v ? 'yang' : 'yin'}${isMoving ? ' moving' : ''}"
        ${isMoving ? `title="${esc(g.moving || '')}"` : ''}></span>`;
    }).reverse().join('');
    return `<figure class="mh-cell">
      <div class="mh-role">${esc(role)}</div>
      <div class="mh-lines">${yao}</div>
      <figcaption class="mh-name">${esc(hex.name || '')}</figcaption>
    </figure>`;
  };
  return `<div class="mh-grid" aria-label="${esc(g.aria || '')}">
    ${cell(cast.ben, g.ben, cast.moving)}
    ${cell(cast.hu, g.hu, 0)}
    ${cell(cast.bian, g.bian, cast.moving)}
  </div>`;
}

// 星盤輪的開關。留著這個常數是為了出事時能一行關掉，不必回滾整支渲染程式。
const SHOW_CHART_WHEEL = true;

// 占星段落最上方的本命盤星盤輪。出生時間不確定時 chartWheelSvg 會自動改畫
// 「只有黃道環與行星」的近似盤，並在圖下標明原因（不畫宮位與上升，見該模組註解）。
function chartWheelHtml(chart) {
  if (!SHOW_CHART_WHEEL) return '';
  if (!chart || !Array.isArray(chart.points) || !chart.points.length) return '';
  return chartWheelSvg(chart, dict().chartWheel || {});
}

// 解讀的八個小標題。前六個是牌組（直欄＝時間、橫排＝三股力量），
// 後兩個是收束段落（畫法不同，見 lenormandContentHtml）。
//
// 這裡刻意不再存「小標題 → 牌位」的對應：抽到的九張牌在該節最上方的九宮格
// 已經完整呈現一次，每一段再把那一組牌重列一遍只是把版面撐長。文字裡有寫到
// 牌名就夠了。
const READ_GROUPS = ['past', 'present', 'future', 'outer', 'event', 'inner'];
const CLOSE_GROUPS = ['combos', 'overall'];
function groupLabels() {
  const g = dict().groups || {};
  return [...READ_GROUPS.map((k) => ({ label: g[k], close: false })),
    ...CLOSE_GROUPS.map((k) => ({ label: g[k], close: true }))]
    .filter((x) => x.label)
    // 長的先比：短標題是長標題的前綴時（如「過去」對「過去的想法」）才不會先被吃掉
    .sort((a, b) => b.label.length - a.label.length);
}

// 該段落是否為「單獨成行的組別小標題」（如只寫「過去」「潛意識層」）。
// 需完全等於組名（可帶尾端標點），避免「十字法」這種章節標題被誤判為「十字」。
function exactGroupLabel(text) {
  const txt = String(text).trim().replace(/[：:。，,、\s]+$/, '');
  const labels = groupLabels();
  // 上限由實際標題長度算出，不寫死數字：寫死 5 會讓「值得注意的牌組」這種
  // 較長的標題被當成內文（實測踩到）。+2 留一點餘裕給各語系。
  const max = labels.reduce((n, g) => Math.max(n, g.label.length), 0) + 2;
  if (!txt || txt.length > max) return null;
  return labels.find((g) => g.label === txt) || null;
}

// 雷諾曼解析內文：逐段落渲染。
// ・單獨成行的小標題（過去／現在／外在環境…）與它後面所有的內文段落，合併成
//   一塊面板；收束的兩段畫法不同（左側金線）。
// ・抽到的牌不在這裡重列——該節最上方的九宮格已經完整呈現過一次。
function lenormandContentHtml(content) {
  const blocks = String(content || '').split(/\n+/).map((s) => s.trim()).filter(Boolean);
  if (!blocks.length) return `<p>${esc(String(content || ''))}</p>`;

  const out = [];
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    const g = exactGroupLabel(b);
    if (g) {
      // 小標題後面所有的內文段落都要併進同一塊面板。必須吃掉「所有」而不只是
      // 下一段——只吃一段的話，模型寫成兩段的內容會有第二段掉出面板、自成一塊
      // 無標題的框，看起來像另一節。
      const body = [];
      while (i + 1 < blocks.length && !exactGroupLabel(blocks[i + 1])) {
        body.push(blocks[i + 1]);
        i += 1;
      }
      out.push(`<div class="lg-para${g.close ? ' lg-close' : ''}">`
        + `<div class="lg-sub">${esc(g.label)}</div>`
        + body.map((t) => `<p>${esc(t)}</p>`).join('') + `</div>`);
      continue;
    }
    out.push(`<div class="lg-para"><p>${esc(b)}</p></div>`);
  }
  return out.join('');
}

// ---- 使用者回饋（星等＋選填文字，送到後台） ----
const FB_STARS = 5;

// 感謝狀態＝致謝句＋當時填的內容（星等與留言，唯讀回看，不可再編輯）
function fbDoneHtml(message, rating, text) {
  const stars = '★★★★★'.slice(0, rating) + '☆☆☆☆☆'.slice(0, FB_STARS - rating);
  return `<div class="fb-done">${esc(message)}</div>
    <div class="fb-echo">
      <span class="fb-echo-stars" aria-label="${esc(t('feedback.starAria', rating))}">${stars}</span>
      ${text ? `<p class="fb-echo-text">${esc(text)}</p>` : ''}
    </div>`;
}

// 已回饋過就直接呈現感謝狀態；否則畫出星等（選了星才展開文字框與送出鈕）
function feedbackHtml() {
  const done = feedbackFor(state && state.runId);
  if (done) {
    return `<div class="r-feedback done">${
      fbDoneHtml(t('feedback.already', done.rating), done.rating, done.text)}</div>`;
  }
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
      const text = $('fbText').value.trim();
      await sendFeedback({ rating, text, state, lang: getLocale() });
      rememberFeedback(state && state.runId, rating, text);
      block.classList.add('done');
      block.innerHTML = fbDoneHtml(t('feedback.done'), rating, text);
    } catch {
      msgEl.textContent = t('feedback.failed');
      sendBtn.disabled = false;
      sendBtn.textContent = t('feedback.send');
    }
  });
}

// 占星那一節的排版。模型依規定輸出三層：白話標題／配置清單（以｜分隔，飛星
// 用 → 串成故事線）／分析。這裡把三層切開上樣式，讀者才掃得出一段從哪裡開始。
//
// 兩個保險：
// ・配置行的判斷刻意要求「不含句號」——一句用｜當頓號的敘述不會被誤當成配置行。
//   模型若照舊習慣加了括號，這裡把括號剝掉再顯示，不要求它重寫。
// ・切不出至少兩個有標題的段落就整段退回純文字。格式沒被遵守時，寧可少了層次，
//   不要破版；也絕不丟行——沒被判成標題或配置的行一律當本文留著。
export function astroContentHtml(content) {
  const raw = String(content || '');
  // 切法與後台字數統計共用 js/astroFormat.js：兩邊若各寫一份，改了一邊就會讓
  // 「畫面上的分層」與「後台算出來的字數」對不上。
  const { ok, segs } = parseAstroSections(raw, groupLabelVariants('overall'));
  if (!ok) return `<p>${esc(raw)}</p>`;
  return segs.map((s) => `<div class="as-seg${s.isClosing ? ' as-close' : ''}">
      ${s.head ? `<p class="as-head">${esc(s.head)}</p>` : ''}
      ${s.cfg ? `<p class="as-cfg">${esc(s.cfg)}</p>` : ''}
      ${s.isClosing
    // 收束段是條列筆記：一行一項，畫成清單。前面各段是長段落，這裡換成清單
    // 才有「最後快速看過一遍」的節奏；也讓讀者知道報告要結束了。
    ? `<ul class="as-list">${s.body.map((t) => `<li>${esc(t)}</li>`).join('')}</ul>`
    : s.body.map((t) => `<p class="as-body">${esc(t)}</p>`).join('')}
    </div>`).join('');
}

function renderResult(a) {
  const sections = sectionsOf(a);
  const secHtml = sections.map((s) => `
    <div class="r-section">
      <h3 class="r-sec-head">${esc(toolLabel(s.tool))}</h3>
      ${s.tool === 'lenormand' ? spreadGridHtml(state.lenormand) : ''}
      ${s.tool === 'meihua' ? meihuaGridHtml(state.meihua) : ''}
      ${s.tool === 'astro' ? chartWheelHtml(state.astro) : ''}
      <div class="r-block">${s.tool === 'lenormand' ? lenormandContentHtml(s.content)
        : s.tool === 'astro' ? astroContentHtml(s.content)
        : `<p>${esc(String(s.content || ''))}</p>`}</div>
    </div>`).join('');

  // 直接從使用者的主題開始（不放標題句），結尾也不放祝福語
  $('resultHost').innerHTML = `
    <div class="r-topic">${esc(t('result.about', state.opening))}</div>
    <div class="rule-orn" aria-hidden="true"></div>
    ${secHtml}
    ${feedbackHtml()}
    <div class="r-sponsor">
      <button class="btn bmc-btn" id="btnCoffee">${esc(t('result.sponsorBtn'))}</button>
      <div class="copy-toast" id="coffeeToast"></div>
    </div>
    <div class="r-actions">
      <button class="btn" id="btnCopy">${esc(t('result.copy'))}</button>
      <button class="btn" id="btnShare">${esc(t('result.share'))}</button>
      ${shareCardTool() ? `<button class="btn" id="btnShareImg">${esc(t('result.shareImage'))}</button>` : ''}
      <button class="btn" id="btnRestart">${esc(t('result.home'))}</button>
    </div>
    <div class="copy-toast" id="imgToast"></div>
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
    <div class="r-advanced" data-locale-only="zh-Hant">
      <button class="btn" id="btnAdvanced">${esc(t('result.advanced'))}</button>
      <div class="r-advanced-hint">${esc(t('result.advancedHint'))}</div>
      <div class="copy-toast" id="advToast"></div>
    </div>
    <div class="r-follow">
      <div class="r-follow-title">${esc(t('result.followTitle'))}</div>
      <p class="r-follow-hint">${esc(t('result.followHint'))}</p>
      <a class="btn" href="${esc(THREADS_URL)}" target="_blank" rel="noopener noreferrer">${esc(t('result.followBtn'))}</a>
    </div>`;
  applyLocaleOnly($('resultHost'));   // 結果頁是動態組的，語系限定區塊要在這裡才生效
  bindFeedback();
  $('btnRestart').addEventListener('click', restart);
  $('btnCopy').addEventListener('click', () => copyAnalysis(a));
  $('btnShare').addEventListener('click', shareSite);
  if ($('btnShareImg')) $('btnShareImg').addEventListener('click', shareImage);
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
  const handoffUrlText = buildHandoff(a, true); // 網址用精簡版，避免被截斷
  $('resultHost').querySelectorAll('.ai-btn').forEach((b) => {
    const provider = b.dataset.ai;
    b.href = aiHandoffUrl(provider, handoffUrlText); // 透過 query param 預先帶入內容
    b.addEventListener('click', () => continueWithAI(a, provider));
  });
  // 星盤輪的放大檢視。用事件委派掛在容器上，所以每次重繪都還有效
  mountChartZoom($('resultHost'), () => dict().chartWheel || {});
  showScreen('screenResult');
}

// 完整內容（複製與導流共用）：主題 + 各節解析 + 結語
// 交接文字用的「閱讀角度 → 牌位」對照。只有這裡需要位置編號（見下方註解）。
const GRID_LEGEND = {
  past: [1, 4, 7], present: [2, 5, 8], future: [3, 6, 9],
  outer: [1, 2, 3], event: [4, 5, 6], inner: [7, 8, 9],
};

// 九張牌的文字清單＋位置對照，供複製與帶給 AI 用。
// 為什麼需要：結果頁的九宮格是圖，複製貼上帶不走；而 prompt 又刻意要求解讀
// 內文「不要逐一列出牌名」，所以少了這一段，接手的 AI 根本不知道抽到哪九張牌。
function spreadTextForAI(spread) {
  if (!Array.isArray(spread) || !spread.length) return '';
  const g = dict().groups || {};
  const sep = t('listSep');
  const cards = spread
    .map(({ card }, i) => `${i + 1}. ${cardName(card.id, card.name)}`)
    .join('\n');
  // 每個閱讀角度各佔一行（直式），讓 AI 一眼對得起來。
  // 這裡保留位置編號是刻意的：讀這段文字的是另一個 AI 或剪貼簿，它看不到
  // 九宮格的圖，沒有編號就不知道哪張牌在哪個位置。頁面上的解讀不用編號，
  // 那是給人讀的、圖就在旁邊——兩邊的讀者不同，規則本來就該不同。
  const legend = Object.entries(GRID_LEGEND)
    .filter(([k]) => g[k])
    .map(([k, pos]) => `${g[k]}${t('labelSep')}${pos.join(sep)}`)
    .join('\n');
  return [
    t('result.cardsTitle'),
    cards,
    '',
    t('result.gridLegend'),
    t('result.gridLayout'),
    legend,
  ].join('\n');
}

// 卦象的文字版。九張牌早就有這一段，梅花與占星卻沒有——結果頁的卦象圖與
// 星盤圖都是圖，複製貼上帶不走，接手的 AI 根本不知道起出什麼卦、什麼盤。
function meihuaTextForAI(cast) {
  if (!cast || !cast.ben) return '';
  const g = dict().meihuaGrid || {};
  const sep = t('labelSep');
  const yao = (hex) => {
    const lines = hexagramLines(hex);
    if (!lines.length) return '';
    // 由下而上寫（初爻在前），與傳統讀法一致。
    // 陽／陰 不隨語系翻譯——卦名本身在四語系也都是中文（已知限制），
    // 而且這一段是給 AI 讀的，用通行的漢字術語比翻譯更不容易誤解。
    return `（${t('result.yaoOrder')}${sep}${lines.map((v) => (v ? '陽' : '陰')).join(' ')}）`;
  };
  const line = (hex, role) => (hex ? `${role}${sep}${hex.name || ''}${yao(hex)}` : '');
  const ai = meihuaForAI(cast);
  return [
    t('result.hexTitle'),
    line(cast.ben, g.ben),
    line(cast.hu, g.hu),
    line(cast.bian, g.bian),
    cast.moving ? `${g.moving}${sep}${t('result.movingNth', cast.moving)}` : '',
    ai.dynamics,
  ].filter(Boolean).join('\n');
}

// 星盤的文字版。刻意只帶「實算出來的位置」，不帶任何詮釋——
// 詮釋是解讀內文的事，這一段的作用是讓 AI 有正確的盤可以依據。
//
// compact：給 AI 連結的 query param 用的精簡版。中文百分比編碼後一個字要 9 個
// 字元，完整版會把網址推到兩萬字以上，有被對方截斷的風險——而星盤資料排在
// 解讀前面，一截就是把「解讀」截掉、留下原始資料，剛好是最糟的順序。
// 精簡版只留十顆主星與四軸、六條相位。複製到剪貼簿的版本仍然是完整的。
const CORE_POINTS = ['太陽', '月亮', '水星', '金星', '火星', '木星', '土星',
  '天王星', '海王星', '冥王星', '上升點', '下降點', '天頂', '天底', '北交點'];

function astroTextForAI(chart, compact = false) {
  if (!chart || !Array.isArray(chart.points) || !chart.points.length) return '';
  const sep = t('labelSep');
  const meta = chart.meta || {};
  const input = meta.input || {};
  const born = [input.date, input.timeUnknown ? t('result.timeUnknown') : input.time,
    input.city].filter(Boolean).join(' ');
  const places = chart.points
    .filter((p) => typeof p.position === 'string')
    .filter((p) => !compact || CORE_POINTS.includes(p.name))
    .map((p) => `${p.name}${sep}${p.position}`
      + (p.house ? ` / ${t('result.nthHouse', p.house)}` : '')
      + (p.retrograde ? ` ${t('result.retro')}` : ''))
    .join('\n');
  // 相位只帶主相位、依緊密度取前幾條，否則光相位就比解讀還長。
  // 精簡版連相位也只留兩端都有列出位置的——否則會出現「天王星 對分 Vertex」
  // 卻沒給 Vertex 位置，AI 讀到的是一張自相矛盾的盤。
  const asp = (Array.isArray(chart.aspects) ? chart.aspects : [])
    .filter((x) => x.major)
    .filter((x) => !compact || (CORE_POINTS.includes(x.a) && CORE_POINTS.includes(x.b)))
    .slice(0, compact ? 6 : 10)
    .map((x) => `${x.a} ${x.type} ${x.b}（${x.orb}）`)
    .join('\n');
  return [
    t('result.chartTitle'),
    born ? `${t('result.bornAt')}${sep}${born}` : '',
    places,
    asp ? `\n${t('result.aspTitle')}\n${asp}` : '',
    !compact && meta.systems ? `\n${meta.systems}` : '',
  ].filter(Boolean).join('\n');
}

function fullText(a, compact = false) {
  const sections = sectionsOf(a);
  const tools = state.tools || [];
  // 三個工具各自把「實際抽到／起到／算出來的東西」補成文字
  const casts = [
    tools.includes('lenormand') ? spreadTextForAI(state.lenormand) : '',
    tools.includes('meihua') ? meihuaTextForAI(state.meihua) : '',
    tools.includes('astro') ? astroTextForAI(state.astro, compact) : '',
  ].filter(Boolean);
  return [
    t('result.myTopic', state.opening),
    ...casts,
    ...sections.map((s) => `${t('secLabel', toolLabel(s.tool))}\n${String(s.content || '')}`),
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

// 分享網站本身（一句話＋網址），刻意**不帶使用者的主題與解析內容**——
// 主題常常很私人，自動塞進社群分享等於替使用者洩漏；要分享內容的人有「複製」可用。
// 網址取當下站台位址，所以本機、preview、正式站都分享得出正確連結。
// 分享用的網址固定寫死正式網域，不從 location 推。
// 從 *.vercel.app 的預覽部署、沒有 www 的網域，或後台預覽的 iframe 進來時，
// location 推出來的是那個當下的網址——分享給朋友的連結不該長那樣。
const SITE_URL = 'https://www.intuitive-notes.com/';
function siteUrl() {
  return SITE_URL;
}

// ---- 分享圖（把這次抽到的東西畫成一張方形 PNG） ----
// 哪一個工具的視覺可以入圖：三個都可以，多選時取第一個有資料的。
function shareCardTool() {
  const tools = (state && Array.isArray(state.tools)) ? state.tools : [];
  if (tools.includes('lenormand') && (state.lenormand || []).length) return 'lenormand';
  if (tools.includes('meihua') && state.meihua && state.meihua.ben) return 'meihua';
  if (tools.includes('astro') && state.astro) return 'astro';
  return null;
}

async function shareImage() {
  const btn = $('btnShareImg');
  const toast = $('imgToast');
  const tool = shareCardTool();
  if (!btn || !tool) return;
  const flash = (key) => {
    if (!toast) return;
    toast.textContent = t(key);
    toast.classList.add('show');
    setTimeout(() => toast.classList.remove('show'), 2600);
  };
  btn.disabled = true;
  const label = btn.textContent;
  btn.textContent = t('result.shareImageBusy');
  try {
    const d = dict();
    const svg = buildShareCardSvg({
      tool,
      state,
      labels: {
        toolName: toolLabel(tool),
        footer: 'www.intuitive-notes.com',
        // 字型堆疊要從頁面上取當下語系的那一套，隔離環境裡沒有 CSS 變數可用
        fontStack: getComputedStyle(document.documentElement).getPropertyValue('--sans').trim()
          || 'sans-serif',
        cardName: (card) => cardName(card.id, card.name),
        meihuaGrid: d.meihuaGrid || {},
        chartWheel: d.chartWheel || {},
      },
    });
    if (!svg) { flash('result.shareImageFail'); return; }
    const blob = await svgToPng(svg);
    const how = await shareCardPng(blob, {
      fileName: `intuitive-notes-${tool}.png`,
      title: t('result.shareTitle'),
      text: t('result.shareText'),
      url: siteUrl(),
    });
    if (how === 'downloaded') flash('result.shareImageSaved');
  } catch (e) {
    // 使用者在系統分享面板按取消不算失敗
    if (e && (e.name === 'AbortError' || e.name === 'NotAllowedError')) return;
    flash('result.shareImageFail');
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
}

function shareSite() {
  const btn = $('btnShare');
  const flash = (key, revert = true) => {
    btn.textContent = t(key);
    if (revert) setTimeout(() => { btn.textContent = t('result.share'); }, 1800);
  };
  const text = t('result.shareText');
  const url = siteUrl();
  if (navigator.share) {
    navigator.share({ title: t('result.shareTitle'), text, url }).catch((e) => {
      // 使用者按取消不算失敗，不要跳錯誤訊息
      if (e && (e.name === 'AbortError' || e.name === 'NotAllowedError')) return;
      flash('result.shareFail');
    });
    return;
  }
  // 桌機瀏覽器多半沒有 Web Share API：退回複製「一句話＋網址」
  navigator.clipboard.writeText(`${text}\n${url}`).then(
    () => flash('result.shareCopied'),
    () => flash('result.shareFail')
  );
}

// 導流用文字：內容 ＋ 接續提問引導（複製與 query param 帶入共用同一份）
// compact：只給 AI 連結的 query param 用（見 astroTextForAI 的註解）。
// 剪貼簿一律拿完整版。
function buildHandoff(a, compact = false) {
  return [
    t('result.handoffPrefix'),
    '',
    fullText(a, compact),
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
  if (id === 'screenWeaving') { repaintWeaving(); return; }
  if (id === 'screenNumbers') {
    const lede = active.querySelector('.divine-lede');
    if (lede) lede.textContent = `${stepPrefix()}${t('numbers.lede')}`;
    // 滑動選取器的 aria 文字也要換語言，但不能重建（會清掉已選的數字）
    active.querySelectorAll('.num-pick').forEach((el) => {
      el.setAttribute('aria-label', t('numbers.digitAria', Number(el.dataset.idx) + 1));
      syncPicker(el, pickerValue(el));
    });
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
  if (!PREVIEW) trackLang(getLocale());   // 後台的語言欄要跟著改
});
// 瀏覽器語言完全沒有對應語系、使用者也還沒自己選過時，才用 IP 國家補救。
// 預覽模式跳過：那一次的語系由後台指定，不能讓 IP 蓋掉。
//
// 來訪埋點要等這一步做完才送：refineByCountry 可能把語系從預設改掉，
// 提早送就會記到「還沒補救前」的語言，跟使用者實際看到的畫面不符。
if (!PREVIEW) {
  refineByCountry().finally(() => trackVisit(getLocale()));
}

// ---- 續玩 ----
(function resume() {
  if (PREVIEW) return;            // 預覽頁不碰站主自己的 session
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

// ---- 預覽模式：等後台把那一次的紀錄送進來 ----
if (PREVIEW) {
  document.body.classList.add('preview-mode');
  window.addEventListener('message', async (e) => {
    // 只收同源的訊息：預覽頁與後台都在同一個網域，跨來源的一律忽略
    if (e.origin !== location.origin) return;
    const msg = e.data;
    if (!msg || msg.type !== 'previewSession' || !msg.session) return;
    try {
      await renderPreview(msg.session);
    } catch (err) {
      $('resultHost').innerHTML = `<p class="preview-err">預覽失敗：${esc(err && err.message)}</p>`;
      showScreen('screenResult');
    }
  });
  // 告訴父視窗「我準備好了」，避免 postMessage 早於 iframe 載入完成
  try { parent.postMessage({ type: 'previewReady' }, location.origin); } catch { /* 忽略 */ }
}

// 把後台送來的紀錄還原成 state，再交給正式的 renderResult()。
// 有些東西紀錄裡沒有，得在這裡重建：
//   ・雷諾曼只存了牌名 → 對回 36 張的牌卡資料，九宮格圖才畫得出來
//   ・梅花只存了三個數字 → 用同一支引擎重新起卦（castFromNumbers 是純函式，
//     同樣的數字必然得到同樣的卦，所以重建的結果與當初一模一樣）
//   ・星盤完全沒存 → 用出生資料重新算一次；算不出來就不畫，並在橫幅說明
async function renderPreview(sess) {
  const notes = sess.previewNotes || {};
  // 用使用者當時的語系重現。第二個參數 false＝不寫入 localStorage，
  // 預覽不該改掉站主自己的語系偏好。
  // 這一步也是段落能不能對上的關鍵：結果頁是靠「該語系的小標題字樣」認段落的，
  // 語系不對就一段都認不出來（實測踩到：後台是英文，畫面就變成 16 塊無標題面板）。
  if (sess.lang) setLocale(sess.lang, false);
  state = {
    version: 3,
    runId: 'preview',
    status: 'done',
    opening: sess.opening || '',
    tools: sess.tools || [],
    lenormand: null,
    meihua: null,
    astro: null,
    analysis: sess.analysis || { title: '', sections: [] },
  };

  if (Array.isArray(sess.cards) && sess.cards.length) {
    state.lenormand = sess.cards.map((name, i) => {
      const card = LENORMAND.find((c) => c.name === name);
      return { position: i + 1, card: card || { id: 0, name } };
    });
  }
  if (Array.isArray(sess.numbers) && sess.numbers.length === 3) {
    state.meihua = castFromNumbers(sess.numbers[0], sess.numbers[1], sess.numbers[2]);
  }

  const warn = [];
  if (notes.truncated) warn.push('這次的解讀在記錄時被截斷（上限 4000 字），下方內容並非全文。');

  const birth = sess.astroBirth;
  if ((state.tools || []).includes('astro')) {
    if (birth && birth.date) {
      try {
        state.astro = await fetchAstroChart({
          date: birth.date,
          time: birth.timeUnknown ? null : birth.time,
          timeUnknown: !!birth.timeUnknown,
          city: birth.city || '',
          country: birth.country || '',
        });
        warn.push('星盤是用當時的出生資料重新計算的（星盤本身沒有存），與使用者看到的應該一致。');
      } catch {
        warn.push('星盤重算失敗，所以這次預覽沒有星盤圖；解讀文字不受影響。');
      }
    } else {
      warn.push('這筆紀錄沒有留下出生資料，所以畫不出星盤圖；解讀文字不受影響。');
    }
  }

  renderResult(state.analysis);
  const host = $('resultHost');
  const bar = document.createElement('div');
  bar.className = 'preview-bar';
  bar.innerHTML = `<b>預覽模式</b>——這是後台重現的畫面，不會產生任何統計紀錄。`
    + (warn.length ? `<ul>${warn.map((w) => `<li>${esc(w)}</li>`).join('')}</ul>` : '');
  host.prepend(bar);
}
