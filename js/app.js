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
import { svgToPng, shareCardPng, saveImage } from './shareCard.js';
import { oracleCardPng, imagePreview } from './oracleCard.js';
import { chartWheelSvg } from './chartWheel.js';
import { parseAstroSections, parseMeihuaSections } from './astroFormat.js';
import { mountChartZoom, closeChartZoom } from './chartZoom.js';
import { cardConstellation } from '../data/lenormandIcons.js';
import { LENORMAND } from '../data/lenormand.js';
import { countryList } from '../data/countries.js';
import { detectCrisis } from './content/crisis.js';
import {
  trackVisit, trackLang, trackScreen, trackJourney, trackTiming, sendFeedback,
  sessionId, visitorIdValue,
} from './analytics.js';
import {
  t, dict, cardName, getLocale, setLocale, onLocaleChange, refineByCountry,
  initDocumentLang, LOCALE_LIST, localeName, groupLabelVariants, meihuaHeadVariants,
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
// 版面診斷面板（?diag=1）。動態載入，正常使用者一個位元組都不會下載到。
// 「整頁往右偏」有兩個成因（文件被撐寬／整頁被放大），從截圖上長得一模一樣，
// 修法卻完全不同——這一頁把兩邊的數字同時攤出來，不用再猜。見 js/diag.js。
try {
  if (new URLSearchParams(location.search).get('diag') === '1') {
    import('./diag.js').then((m) => m.mountDiag()).catch(() => {});
  }
} catch { /* 舊瀏覽器沒有 URLSearchParams 就算了，診斷頁不是必要功能 */ }

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
  if (id !== 'screenOracle') stopOracleStage();
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
  else if (act === 'cards') renderOracle();
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

// ---- 專屬靈感牌卡（選單頁） ----
// 使用者貼上一則自己喜歡的解讀，系統從那則解讀裡**逐字**挑出最有力量的一句話，
// 替它下一個英文標題，再畫一張對應的圖，合成一張可以下載、可以分享的牌卡。
// 卡面上的話是使用者自己剛剛讀到的話——這是這個功能的整個重點（見 prompts/oracle.js）。
let oracleBusy = false;
// 切換語系時的輕量重繪。與選牌畫面同一個判斷：不重建，只換文字——重建會清掉
// 使用者已經貼好的解讀。生成中與結果狀態設為 null（結果裡的牌義是用當時的輸出
// 語言取得的，跟主報告一樣不隨介面語言改寫）。
let oracleRepaint = null;
// 這一次貼的解讀全文。「再生成」用同一則重跑，不必再貼一次。
let oracleLast = null;
// 今天已用張數與上限。由伺服器給（action:'info' 只讀、不累加），不寫死在前端。
let oracleQuota = null;

// 把用量畫到表單上，額度用完時連「生成牌卡」都按不下去。
// 前端的 disabled 只是為了不讓人白等——真正的擋在伺服器端（api/oracle.js）。
//
// limit <= 0＝伺服器端沒有限制：這時候什麼都不顯示、什麼都不鎖。
// 少了這道判斷，「已使用 0 ／ 0 張」會被算成額度已滿，按鈕一開始就是灰的。
function paintOracleQuota() {
  const note = $('oracleNote');
  if (!note || !oracleQuota) return;
  const { used, limit } = oracleQuota;
  const go = $('btnOracleGo');
  if (!(limit > 0)) {
    note.textContent = '';
    note.classList.remove('oc-note-out');
    if (go) go.disabled = false;
    return;
  }
  const out = used >= limit;
  note.textContent = out ? t('oracle.usedUp', limit) : t('oracle.usage', used, limit);
  note.classList.toggle('oc-note-out', out);
  if (go) go.disabled = out;
}

async function oracleApi(payload) {
  const res = await fetch('/api/oracle', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sid: sessionId(), vid: visitorIdValue(), ...payload }),
  });
  if (!res.ok) throw new Error('oracle HTTP ' + res.status);
  return res.json();
}

function oracleError(msg) {
  const box = $('oracleErr');
  if (box) { box.textContent = msg; box.hidden = !msg; }
}

// 功能被站主關閉時的畫面。選單那一項仍然點得進來（與站上其他未開放項目一致），
// 但這裡不給表單——避免使用者填完一大段才發現送不出去。
function oracleSoon() {
  stopOracleStage();
  oracleRepaint = () => {
    const el = oracleHost().querySelector('.oc-soon');
    if (el) el.textContent = t('oracle.soon');
  };
  oracleHost().innerHTML = `<p class="oc-soon">${esc(t('oracle.soon'))}</p>`;
}

// 生成中的過場。用的是與探索工具**完全同一組**動畫（.orbit-stage 的三層星軌與
// 行星）與同一套階段列（.weave-stage 的文字／進度點／副標）——那是全站等待畫面的
// 語言，牌卡沒有理由自己長一套。
//
// 差別只有一個：主流程的階段是照經過時間推進的（拿不到模型的真實進度），牌卡的
// 階段是**事件驅動**的——文字那一次回來了才進到「畫那個世界」。所以這裡不需要
// WEAVE_STAGES 那張時間表，只留一個「比平常久」的計時器。
//
// 星軌的 markup 與 index.html 的 #screenWeaving 一字不差（同一組 class 就是同一組
// 動畫）。刻意複製而不是搬去共用元件：那邊是靜態 HTML、這邊是動態插入的，
// 為兩個地方共用一段字串要多一層抽象，不值得。改動畫時記得兩邊一起改。
// 靈感卡有兩個入口，走的是同一套產生流程，差別只在「畫到哪裡」：
//   ・專屬靈感牌卡那一頁：使用者自己貼一則解讀 → 畫進 #oracleHost
//   ・結果頁的「製作專屬靈感卡」：直接拿這一則去生 → 畫進彈出視窗
// 所以每個會動到畫面的地方都走 oracleHost()，不要寫死 oracleHost()。
let oracleHostId = 'oracleHost';
const oracleHost = () => document.getElementById(oracleHostId);
// 'page'＝牌卡頁（有再生成／換一則）｜'modal'＝結果頁彈出視窗（只有下載與分享）
let oracleMode = 'page';

const ORACLE_SLOW_MS = 55000;   // 與主流程的「比平常久」同一個門檻（≈P90）
let oracleStep = 0;
let oracleSlowTimer = null;

function stopOracleStage() {
  clearTimeout(oracleSlowTimer);
  oracleSlowTimer = null;
}

function orbitStageHtml(label) {
  const ring = (n) => `<svg class="orb-ring or${n}" viewBox="0 0 200 200">`
    + '<circle class="orb-guide" cx="100" cy="100" r="92"></circle>'
    + '<circle class="orb-arc" cx="100" cy="100" r="92"></circle></svg>';
  return `<div class="orbit-stage">
      <div class="orbit-rig" aria-hidden="true">
        ${ring(1)}${ring(2)}${ring(3)}
        <div class="orb-planet op1"><i></i></div>
        <div class="orb-planet op2"><i></i></div>
        <div class="orb-planet op3"><i></i></div>
      </div>
      <p class="orbit-label" id="oracleBusyLabel">${esc(label)}</p>
    </div>`;
}

// step：1＝讀解讀並挑牌，2＝畫那個世界
function oracleStage(step) {
  const first = !$('oracleDots');
  oracleStep = step;
  // 切語言時原地重畫：階段文字是 JS 寫進去的，applyStaticText 管不到
  oracleRepaint = () => paintOracleStage();
  if (first) {
    stopOracleStage();
    oracleHost().innerHTML = `
      <div class="weaving oc-weaving">
        ${orbitStageHtml(t('oracle.busy'))}
        <div class="weave-stage">
          <p class="weave-stage-text" id="oracleStageText" aria-live="polite"></p>
          <div class="weave-dots" id="oracleDots" aria-hidden="true"></div>
          <p class="weave-stage-sub" id="oracleStageSub"></p>
        </div>
      </div>`;
    // 只在第一次進來時起算：兩段加起來才是使用者實際等的時間
    oracleSlowTimer = setTimeout(() => {
      oracleSlowTimer = null;
      paintOracleStage();
    }, ORACLE_SLOW_MS);
  }
  paintOracleStage();
}

function paintOracleStage() {
  const txt = $('oracleStageText');
  if (!txt) return;
  const label = $('oracleBusyLabel');
  if (label) label.textContent = t('oracle.busy');
  txt.textContent = t(oracleStep === 2 ? 'oracle.step2' : 'oracle.step1');
  // 計時器已經燒完＝這次比平常久。只補一句副標，不改階段文字——階段是事件驅動的，
  // 把文字換成「比平常久」會讓人以為停在別的步驟上。
  const slow = !oracleSlowTimer;
  $('oracleStageSub').textContent = slow
    ? t('weaving.sub.longer')
    : (oracleStep === 2 ? t('oracle.sub2') : '');
  $('oracleDots').innerHTML = [1, 2]
    .map((n) => `<span class="weave-dot${n <= oracleStep ? ' on' : ''}"></span>`).join('');
}

// 從結果頁直接做一張靈感卡：不用複製、不用跳去牌卡頁貼上。
// 畫在一個彈出視窗裡（站主指定「比較像是跳出來的一個視窗」），金色星軌的等待動畫
// 也在視窗裡跑，所以按下去就看得到它已經開始了。
function closeOracleModal() {
  const el = $('ocModal');
  if (!el) return;
  el.remove();
  document.body.classList.remove('ocm-open');
  // 視窗關掉之後，牌卡頁那個 host 才是預設的畫布
  oracleHostId = 'oracleHost';
  oracleMode = 'page';
  oracleRepaint = null;
}

function makeCardFromResult(a) {
  if (oracleBusy) return;
  const reading = fullText(a);
  if (!reading || reading.length < 80) return;

  const el = document.createElement('div');
  el.id = 'ocModal';
  el.className = 'ocm';
  el.innerHTML = `
    <div class="ocm-back" data-ocm-close="1"></div>
    <div class="ocm-box" role="dialog" aria-modal="true" aria-label="${esc(t('oracle.title'))}">
      <button type="button" class="ocm-x" data-ocm-close="1"
        aria-label="${esc(t('menu.close'))}"></button>
      <div id="ocModalHost"></div>
    </div>`;
  document.body.appendChild(el);
  document.body.classList.add('ocm-open');
  el.addEventListener('click', (e) => {
    if (e.target.closest('[data-ocm-close]')) closeOracleModal();
  });

  oracleHostId = 'ocModalHost';
  oracleMode = 'modal';
  runOracle(reading);
}

// Esc 關閉。掛在 document 上一次就好，不必每次開視窗都掛一組。
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && $('ocModal')) closeOracleModal();
});

function renderOracle() {
  stopOracleStage();
  // 從彈出視窗回到牌卡頁時，host 可能還指著視窗裡那顆——切回來
  oracleHostId = 'oracleHost';
  oracleMode = 'page';
  const host = oracleHost();
  host.innerHTML = `
    <p class="oc-lede">${esc(t('oracle.lede'))}</p>
    <div class="oc-panel">
      <div class="oc-field oc-field-last">
        <label class="oc-label" id="oracleReadLabel" for="oracleReading">${esc(t('oracle.readingLabel'))}</label>
        <textarea id="oracleReading" rows="8" maxlength="12000"
          placeholder="${esc(t('oracle.readingPh'))}"></textarea>
      </div>
    </div>
    <div class="oc-note" id="oracleNote"></div>
    <div class="oc-err" id="oracleErr" hidden></div>
    <div class="oc-actions">
      <button type="button" class="btn primary" id="btnOracleGo">${esc(t('oracle.submit'))}</button>
    </div>`;

  oracleRepaint = () => {
    const set = (id, text) => { const el = $(id); if (el) el.textContent = text; };
    set('oracleReadLabel', t('oracle.readingLabel'));
    set('btnOracleGo', t('oracle.submit'));
    paintOracleQuota();
    const lede = host.querySelector('.oc-lede');
    if (lede) lede.textContent = t('oracle.lede');
    $('oracleReading').placeholder = t('oracle.readingPh');
  };

  // 一次拿兩件事：功能有沒有開著、今天已用幾張／上限。
  // 都由伺服器決定：開關是站主在後台按的（存 Redis，端點每次請求都讀），
  // 上限則看 ORACLE_DAILY_LIMIT。拿不到就維持原樣（留白、不鎖），
  // 寧可不顯示也不要顯示錯的。
  oracleApi({ action: 'info' }).then((info) => {
    if (!info || !info.ok) return;
    if (info.enabled === false) { oracleSoon(); return; }
    if (!$('oracleNote')) return;
    oracleQuota = { used: Number(info.used) || 0, limit: Number(info.limit) || 0 };
    paintOracleQuota();
  }).catch(() => {});

  $('btnOracleGo').addEventListener('click', () => {
    const reading = $('oracleReading').value.trim();
    if (reading.length < 80) { oracleError(t('oracle.tooShort')); return; }
    runOracle(reading);
  });

  showScreen('screenOracle');
}

async function runOracle(reading) {
  if (oracleBusy) return;
  oracleBusy = true;
  // 記住這次貼的解讀，「再生成」要用同一則重跑一次。
  // 重跑會走完整流程（新的 id、新的圖），所以會再吃掉一次每日額度——這是刻意的：
  // 圖像生成有實際成本，每日上限是唯一的成本控制。
  oracleLast = { reading };
  oracleStage(1);
  try {
    const text = await oracleApi({ action: 'text', reading, lang: getLocale() });
    if (!text.ok) {
      if (text.reason === 'disabled') { oracleSoon(); return; }
      // not_verbatim（模型改了原文的字，重試後仍然改）走一般的失敗訊息就好：
      // 對讀者來說那就是「這次沒成功，再試一次」，沒必要解釋內部的比對機制。
      oracleFailed(text.reason === 'daily_limit'
        ? t('oracle.limit', text.limit || 0)
        : text.reason === 'reading_too_short' ? t('oracle.tooShort') : t('oracle.failed'));
      return;
    }
    // 卡面沒有文字就整件事算失敗，不要進到生圖那一步。
    // 伺服器端已經擋掉空字串（api/oracle.js），這一關防的是另一件事：前後端版本
    // 不一致時（例如瀏覽器留著舊版 app.js、伺服器已經是新版）欄位名稱對不上，
    // 兩個值都會是 undefined，合成出來就是一張只有畫、沒有字的卡——那種卡看起來
    // 不像壞了，只像做得很爛，比直接說「這次沒能生成」糟得多。
    if (!text.keyword || !text.sentence) {
      oracleFailed(t('oracle.failed'));
      return;
    }
    oracleQuota = { used: Number(text.used) || 0, limit: Number(text.limit) || 0 };
    oracleStage(2);

    let image = null;
    try {
      const img = await oracleApi({ action: 'image', id: text.id });
      if (img.ok) image = img.image;
    } catch { /* 圖失敗不算整件事失敗——文字仍然值得給他 */ }

    await oracleResult(text, image);
  } catch {
    oracleFailed(t('oracle.failed'));
  } finally {
    oracleBusy = false;
  }
}

function oracleFailed(msg) {
  stopOracleStage();
  oracleRepaint = null;
  oracleHost().innerHTML = `
    <div class="oc-err oc-err-block">${esc(msg)}</div>
    <div class="oc-actions">
      <button type="button" class="btn" id="btnOracleAgain">${esc(t('oracle.again'))}</button>
    </div>`;
  $('btnOracleAgain').addEventListener('click', renderOracle);
}

async function oracleResult(card, imageDataUrl) {
  stopOracleStage();
  const modal = oracleMode === 'modal';
  // limit <= 0＝沒有限制（見 api/oracle.js 的 DAILY_LIMIT）：不顯示用量、不鎖再生成
  const limit = Number(card.limit) || 0;
  const used = Number(card.used) || 0;
  const quotaOut = limit > 0 && used >= limit;
  let blob = null;
  let previewSrc = '';
  if (imageDataUrl) {
    try {
      blob = await oracleCardPng({
        artworkDataUrl: imageDataUrl,
        keyword: card.keyword,
        sentence: card.sentence,
        footer: 'INTUITIVE NOTES',
      });
      previewSrc = URL.createObjectURL(blob);
    } catch { blob = null; }
  }

  oracleRepaint = null;
  // 卡面文字**只在圖沒生出來時**才另外列一次。
  // 站主：「牌卡上面已經有了，下面就不用再打一次。」——卡片正常時再列一遍確實是重複。
  // 但圖失敗時不能什麼都不給：那時候讀者手上沒有卡片，這一塊是他唯一看得到
  // 卡面內容的地方，拿掉的話畫面只剩一行「這次的畫面沒能畫出來」。
  const trans = previewSrc ? '' : `
    <div class="oc-trans">
      <div class="oc-t-title">${esc(card.keyword)}</div>
      <div class="oc-t-msg">${esc(card.sentence)}</div>
    </div>`;

  const host = oracleHost();
  host.innerHTML = `
    ${previewSrc
    ? `<div class="oc-card-wrap"><img class="oc-card-img" src="${previewSrc}" alt="${esc(card.keyword)}"></div>`
    : `<div class="oc-err oc-err-block">${esc(t('oracle.imageFailed'))}</div>`}
    ${trans}
    <div class="oc-actions">
      ${blob ? `<button type="button" class="btn primary" id="btnOracleDl">${esc(t('oracle.download'))}</button>` : ''}
      ${blob && navigator.share ? `<button type="button" class="btn" id="btnOracleShare">${esc(t('oracle.share'))}</button>` : ''}
      ${modal ? '' : `<button type="button" class="btn" id="btnOracleRegen"${quotaOut ? ' disabled' : ''}>${esc(t('oracle.regen'))}</button>`}
    </div>
    ${limit > 0 ? `<div class="oc-usage">${esc(quotaOut
    ? t('oracle.usedUp', limit) : t('oracle.usage', used, limit))}</div>` : ''}
    <div class="oc-hint" id="oracleSaved" hidden></div>
    ${modal ? '' : `<div class="oc-actions oc-actions-sub">
      <button type="button" class="btn small" id="btnOracleAgain">${esc(t('oracle.again'))}</button>
    </div>`}`;

  // 彈出視窗只有下載與分享兩顆（站主指定）——「再生成」「換一則解讀」屬於牌卡頁，
  // 在這裡出現會讓人搞不清楚自己在哪一頁。
  if (!modal) {
    $('btnOracleAgain').addEventListener('click', renderOracle);
    // 再生成＝用同一則解讀重跑一次（新的圖與新的文字），會再吃掉一次每日額度。
    // 額度用完時按鈕是 disabled 的，但伺服器端仍會擋——前端的 disabled 擋不住重送。
    const regen = $('btnOracleRegen');
    if (regen) {
      regen.addEventListener('click', () => {
        if (!oracleLast) { renderOracle(); return; }
        runOracle(oracleLast.reading);
      });
    }
  }
  if (blob) {
    const fileName = `intuitive-notes-oracle-${Date.now()}.png`;
    const note = (key) => {
      const el = $('oracleSaved');
      el.textContent = t(key);
      el.hidden = false;
    };
    // 「下載圖片」＝站主要的是「存進相簿」，不是存成檔案。
    // iOS 的 <a download> 只會存進「檔案」App，相簿拿不到——唯一的路是系統分享面板，
    // 那裡「儲存影像」就在第一排。所以能分享檔案時就只丟檔案（不帶文字與網址，
    // 面板才不會被社群 App 佔滿），不能分享檔案的桌機才退回真正的下載。
    $('btnOracleDl').addEventListener('click', async () => {
      try {
        const how = await saveImage(blob, fileName);
        note(how === 'shared' ? 'oracle.saveHint' : 'oracle.saved');
      } catch { /* 使用者在面板按取消不是錯誤 */ }
    });
    const shareBtn = $('btnOracleShare');
    if (shareBtn) {
      shareBtn.addEventListener('click', async () => {
        try {
          // 分享出去的文字用 result.shareText——那本來就是站主指定的那一句
          // （推廣這個網站）。不用卡面的句子：圖上已經有了，收到的人看得到。
          const how = await shareCardPng(blob, {
            fileName, title: t('result.shareTitle'), text: t('result.shareText'),
          });
          note(how === 'shared' ? 'oracle.shared' : 'oracle.saved');
        } catch { /* 使用者取消分享不是錯誤 */ }
      });
    }

    // 存檔給站主審核品質。兩張都送：合成好的卡（使用者拿到的東西）與圖像模型畫的
    // 原始 artwork（要拿來對照 imagePrompt 的那一張）。都壓成小張 JPEG——原圖 PNG
    // 約 1.5–3 MB，審核用不到原始解析度。
    // 一次請求送兩張，不是兩次：這支端點只是存檔，多一趟往返沒有意義。
    // 失敗一律靜默，而且 artwork 壓失敗時仍然把卡送出去——這是站方的資料，
    // 不該影響使用者，也不該因為其中一張壞了就兩張都沒存到。
    Promise.all([
      imagePreview(blob).catch(() => ''),
      imageDataUrl ? imagePreview(imageDataUrl).catch(() => '') : '',
    ]).then(([preview, art]) => {
      if (!preview && !art) return;
      return oracleApi({ action: 'archive', id: card.id, preview, art });
    }).catch(() => {});
  }
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

// 梅花易數那一節的排版。第一段是「卦象提點」：三行總提點，畫成置中的提點卡
// ——讀者先抓到方向，再往下讀詳細解說。其餘段落沿用占星的面板樣式（金色標題
// ＋明體本文），三個工具同一套視覺語言。
// 小標題比對四個語系（報告語言與介面語言可能不同）；切不出來退回純文字、不丟行。
export function meihuaContentHtml(content) {
  const raw = String(content || '');
  const labels = {};
  for (const k of ['tip', 'ben', 'bian', 'moving', 'meaning', 'advice']) {
    labels[k] = meihuaHeadVariants(k);
  }
  const { ok, segs } = parseMeihuaSections(raw, labels);
  if (!ok) return `<p>${esc(raw)}</p>`;
  return segs.map((s) => s.isTip
    ? `<div class="mh-tip">
        <p class="mh-tip-label">${esc(s.head)}</p>
        ${s.body.map((t) => `<p class="mh-tip-text">${esc(t)}</p>`).join('')}
      </div>`
    : `<div class="as-seg">
        ${s.head ? `<p class="as-head">${esc(s.head)}</p>` : ''}
        ${s.body.map((t) => `<p class="as-body">${esc(t)}</p>`).join('')}
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
        : s.tool === 'meihua' ? meihuaContentHtml(s.content)
        : `<p>${esc(String(s.content || ''))}</p>`}</div>
    </div>`).join('');

  // 從「我的靈感訊息」點進來時，要有明顯的路可以回去那份清單。
  // 只有這種情況才出現：剛做完一次分析的人沒有「列表」可以回。
  // 上下各放一個——結果頁常常好幾個螢幕高，讀完之後不該還要滑回最上面。
  const back = state.fromHistory;
  // 選單的三線鈕是 position:fixed 在左上角（42px 高），.reading-wrap 有 8vh 上緣，
  // 所以這個返回連結落在它下面，不會疊到。
  const backTop = back
    ? `<button type="button" class="r-back" id="btnBackTop">
        <span class="r-back-arrow" aria-hidden="true">‹</span>${esc(t('result.backToList'))}
      </button>` : '';

  // 直接從使用者的主題開始（不放標題句），結尾也不放祝福語
  $('resultHost').innerHTML = `
    ${backTop}
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
      <!-- 說明句包在按鈕裡面那一格，才會對齊在「製作專屬靈感卡」正下方，
           而不是落在三顆按鈕底下（站主回報位置不對）。 -->
      <div class="r-act-cell">
        <button class="btn" id="btnMakeCard">${esc(t('result.makeCard'))}</button>
        <div class="r-makecard-hint">${esc(t('result.makeCardHint'))}</div>
      </div>
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
    <div class="r-advanced" data-locale-only="zh-Hant">
      <button class="btn" id="btnAdvanced">${esc(t('result.advanced'))}</button>
      <div class="r-advanced-hint">${esc(t('result.advancedHint'))}</div>
      <div class="copy-toast" id="advToast"></div>
    </div>
    <!-- 「分享給朋友」與「追蹤最新消息」同屬一個區塊：直覺對話下面一條金線，
         線後面就是這兩顆。兩者都是把人帶出去／帶回來的動作，放在一起才成組。 -->
    <div class="r-follow">
      <div class="r-sharesite">
        <button class="btn" id="btnShare">${esc(t('result.share'))}</button>
        <div class="r-sharesite-hint">${esc(t('result.shareHint'))}</div>
      </div>
      <div class="r-follow-title">${esc(t('result.followTitle'))}</div>
      <p class="r-follow-hint">${esc(t('result.followHint'))}</p>
      <a class="btn" href="${esc(THREADS_URL)}" target="_blank" rel="noopener noreferrer">${esc(t('result.followBtn'))}</a>
    </div>`;
  applyLocaleOnly($('resultHost'));   // 結果頁是動態組的，語系限定區塊要在這裡才生效
  bindFeedback();
  $('btnRestart').addEventListener('click', restart);
  // 回列表：只剩結果頁最上方那一個入口（底下那顆已經按站主要求拿掉）。
  // 重畫一次清單再切回去——剛剛可能在別的地方刪掉了某一筆。
  if ($('btnBackTop')) $('btnBackTop').addEventListener('click', () => renderHistory());
  $('btnCopy').addEventListener('click', () => copyAnalysis(a));
  $('btnMakeCard').addEventListener('click', () => makeCardFromResult(a));
  $('btnShare').addEventListener('click', shareSite);
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

// compact：只給 AI 連結的 query param 用（見 astroTextForAI 的註解）。
// astroData：要不要附上星盤的實算資料（度數、宮位、相位表）。
//   AI 導流＝true：接手的 AI 看不到結果頁上那張星盤圖，沒有這段它只能憑印象亂講。
//   剪貼簿＝false：使用者按「複製這則內容」是要那段解讀（多半是貼到別處、或貼進
//     專屬靈感牌卡）。一大塊度數與相位表對他沒有意義，只會把要讀的字埋掉，
//     而且那張星盤圖就在他眼前，資料他看得到。
//   雷諾曼的牌名清單與梅花的卦象仍然保留：那兩段短、而且是人讀得懂的內容。
function fullText(a, { compact = false, astroData = true } = {}) {
  const sections = sectionsOf(a);
  const tools = state.tools || [];
  // 三個工具各自把「實際抽到／起到／算出來的東西」補成文字
  const casts = [
    tools.includes('lenormand') ? spreadTextForAI(state.lenormand) : '',
    tools.includes('meihua') ? meihuaTextForAI(state.meihua) : '',
    tools.includes('astro') && astroData ? astroTextForAI(state.astro, compact) : '',
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
  navigator.clipboard.writeText(fullText(a, { astroData: false })).then(
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
// 分享用的網址依介面語言選：分享預覽的爬蟲按網址快取、不執行 JS，
// 同一條網址對所有收件人只有一種語言——所以每個語言一條入口網址
// （/en/、/ja/、/ko/ 是只有 meta 的入口頁，真人會被帶回主站）。
const SITE_URL_LANG = { en: 'en/', ja: 'ja/', ko: 'ko/' };
function siteUrl() {
  return SITE_URL + (SITE_URL_LANG[getLocale()] || '');
}

// ---- 分享圖（把這次抽到的東西畫成一張方形 PNG） ----
// 哪一個工具的視覺可以入圖：三個都可以，多選時取第一個有資料的。
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

// 導流用文字：內容 ＋ 接續提問引導（連結的 query param 與後備剪貼簿共用同一份）
// compact：只給 AI 連結的 query param 用（見 astroTextForAI 的註解）。
// 導流一律帶星盤資料——接手的 AI 需要它。結果頁的「複製這則內容」不帶（見 fullText）。
function buildHandoff(a, compact = false) {
  return [
    t('result.handoffPrefix'),
    '',
    fullText(a, { compact }),
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
  if (id === 'screenOracle') { if (oracleRepaint) oracleRepaint(); return; }
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

// ---- 進站時一定從最上面開始 ----
// 瀏覽器預設會在「重新整理」與「上一頁」時把捲動位置還原（scrollRestoration:'auto'）。
// 這個站是單頁應用、換畫面不換 URL，所以還原回來的那個位置往往屬於另一個畫面——
// 站主回報的症狀就是：一進站或一重新整理，看到的是頁面中段，站名與選單鈕都在畫面外。
// 而且沒有存檔時上面那個 resume() 直接 return，等於**一般載入根本沒有人把捲動歸零**。
//
// 三件事一起做才擋得住：
//   ① 關掉瀏覽器的自動還原
//   ② 啟動時自己捲到最上面。用 instant 不用 smooth——smooth 會被接下來的版面變動
//      （字型換好、背景圖載入）打斷，停在半路，那比不捲還糟
//   ③ 下一幀與 pageshow 再各補一次：版面會再動一次；而 iOS Safari 從「上一頁」回來
//      走的是 bfcache，整頁不重新執行，只有 pageshow 會發生
if (!PREVIEW) {
  try { history.scrollRestoration = 'manual'; } catch { /* 舊瀏覽器沒有這個屬性 */ }
  const toTop = () => window.scrollTo(0, 0);
  toTop();
  requestAnimationFrame(toTop);
  window.addEventListener('pageshow', toTop);
}

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
