// app.js — 「靈感訊息」頂層流程控制。
// 節奏：輸入想獲得靈感的主題 → 雷諾曼（使用者親手從 36 張選 9 張入九宮格）
// → 梅花易數報數起卦 → 交叉整合 → 綜合靈感訊息。
// 每一步都 saveSession，支援重整續玩。

import {
  createSession, saveSession, loadSession, clearSession,
} from './engine/session.js';
import { castMeihua, getAnalysis } from './engine/inquiry.js';
import { shuffledDeckOrder, spreadFromPicks } from './engine/lenormand.js';
import { detectCrisis } from './content/crisis.js';

const $ = (id) => document.getElementById(id);
let state = null;

// ---- 螢幕切換 ----
function showScreen(id) {
  document.querySelectorAll('.screen').forEach((s) => s.classList.remove('active'));
  $(id).classList.add('active');
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

// ---- 占卜二：梅花易數報數起卦 ----
function runNumbers() {
  const inputs = [$('num1'), $('num2'), $('num3')];
  const doneBtn = $('btnNumbersDone');
  const skipBtn = $('btnNumbersSkip');

  const valid = (el) => {
    const v = Number(el.value);
    return Number.isInteger(v) && v >= 1 && v <= 100;
  };
  const refresh = () => { doneBtn.disabled = !inputs.every(valid); };
  inputs.forEach((el) => { el.value = ''; el.oninput = refresh; });
  refresh();

  const proceed = (numbers) => {
    castMeihua(state, numbers);
    state.status = 'weaving';
    saveSession(state);
    runAnalysis();
  };
  doneBtn.onclick = () => { if (inputs.every(valid)) proceed(inputs.map((el) => Number(el.value))); };
  skipBtn.onclick = () => proceed(null);

  showScreen('screenNumbers');
  setTimeout(() => inputs[0].focus(), 200);
}

// ---- 交叉整合 → 最後分析 ----
async function runAnalysis() {
  showWeaving();
  const t0 = Date.now();
  const analysis = await getAnalysis(state);
  saveSession(state);
  const waitMs = Math.max(0, 2400 - (Date.now() - t0));
  setTimeout(() => renderResult(analysis), waitMs);
}

function renderResult(a) {
  $('resultHost').innerHTML = `
    <div class="r-title">${esc(a.title || '給你的靈感訊息')}</div>
    <div class="r-sub">來自你親手選的牌，與你報出的數</div>
    <div class="r-block core"><h3>靈感訊息</h3><p>${esc(a.message)}</p></div>
    ${a.closing ? `<div class="r-closing">${esc(a.closing)}</div>` : ''}
    <div class="r-actions">
      <button class="btn" id="btnCopy">帶走這則訊息</button>
      <button class="btn" id="btnRestart">再求一則靈感</button>
    </div>`;
  $('btnRestart').addEventListener('click', restart);
  $('btnCopy').addEventListener('click', () => copyAnalysis(a));
  showScreen('screenResult');
}

function copyAnalysis(a) {
  const text = [
    a.title || '給你的靈感訊息',
    '',
    `我的主題:${state.opening}`,
    '',
    a.message,
    a.closing ? `\n${a.closing}` : '',
    '\n— 靈感訊息',
  ].filter((s) => s !== '').join('\n');
  const btn = $('btnCopy');
  navigator.clipboard.writeText(text).then(
    () => { btn.textContent = '已帶走 ✓'; setTimeout(() => { btn.textContent = '帶走這則訊息'; }, 1800); },
    () => { btn.textContent = '複製失敗'; }
  );
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
  if (state.status === 'weaving') { runAnalysis(); }
})();

// ---- utils ----
function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
