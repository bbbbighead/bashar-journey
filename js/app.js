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
$('btnCareBack').addEventListener('click', () => showScreen('screenIntake'));

function start() {
  const q = $('question').value.trim();
  if (!q) { $('question').focus(); return; }
  if (detectCrisis(q)) { showScreen('screenCare'); return; }

  state = createSession(q);
  saveSession(state);
  runSpread();
}

// ---- 占卜一：使用者親手選牌（36 選 9；選取順序對應內部九宮格，不對外揭示牌面） ----
function runSpread() {
  const deck = $('deckGrid');
  const count = $('pickCount');
  const doneBtn = $('btnSpreadDone');
  const resetBtn = $('btnSpreadReset');

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
    state.status = 'numbers';
    saveSession(state);
    runNumbers();
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

  // 第一階段只用雷諾曼＋梅花易數；西洋占星保留給進階版
  const proceed = (numbers) => {
    castMeihua(state, numbers);
    state.status = 'weaving';
    saveSession(state);
    runAnalysis();
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

// （西洋占星流程已移至進階版——第一階段僅雷諾曼＋梅花易數）

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

// 匯聚圖：兩個觀測角度的髮絲線緩緩收束到中心——
// 視覺化「整合的訊息」而非兩份孤立解讀。字級放大以照顧手機縮放。
function convergeSVG() {
  const nodes = [
    { x: 170, label: '雷諾曼', sub: '現實如何表現' },
    { x: 430, label: '梅花易數', sub: '正處哪個階段' },
  ];
  const parts = nodes.map((n) => `
    <text x="${n.x}" y="28" text-anchor="middle" font-size="17" fill="#cabfa4" letter-spacing="2">${n.label}</text>
    <text x="${n.x}" y="50" text-anchor="middle" font-size="12.5" fill="#948a72" letter-spacing="1">${n.sub}</text>
    <circle cx="${n.x}" cy="66" r="3" fill="#d6b77a"/>
    <path class="cv-line" pathLength="1" d="M ${n.x} 72 C ${n.x} 100, 300 104, 300 126" stroke="rgba(214,183,122,.6)" stroke-width="1" fill="none"/>`).join('');
  return `
    <div class="r-converge" aria-hidden="true">
      <svg viewBox="0 0 600 182" fill="none" xmlns="http://www.w3.org/2000/svg">
        ${parts}
        <circle class="cv-halo" cx="300" cy="134" r="9" stroke="rgba(214,183,122,.5)" stroke-width="1"/>
        <circle cx="300" cy="134" r="3.4" fill="#d6b77a"/>
        <text x="300" y="170" text-anchor="middle" font-size="13.5" fill="#a89466" letter-spacing="3">同一份底層圖樣</text>
      </svg>
    </div>`;
}

function renderResult(a) {
  // 訊息本體直接開場、不揭示出處；不顯示抽到的牌（僅保留報數作為索引）
  const numsText = state.numbers ? state.numbers.join('・') : '由此刻的時間起卦';

  $('resultHost').innerHTML = `
    <div class="r-title">${esc(a.title || '給你的靈感訊息')}</div>
    <div class="r-sub">寫給此刻的你</div>
    <div class="rule-orn" aria-hidden="true"></div>
    <div class="r-block core"><p>${esc(a.message)}</p></div>
    ${a.closing ? `<div class="r-closing">${esc(a.closing)}</div>` : ''}
    <div class="r-index" aria-label="本次紀錄索引">
      <div class="r-index-label">本次紀錄・索引</div>
      ${convergeSVG()}
      <div class="r-index-line"><span>數</span>${esc(numsText)}</div>
    </div>
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
    </div>
    <div class="r-advanced">
      <button class="btn" id="btnAdvanced">查看詳細進階報告</button>
      <div class="r-advanced-hint">結合牌卡、卦象與星盤的詳細報告解說</div>
      <div class="copy-toast" id="advToast"></div>
    </div>`;
  $('btnRestart').addEventListener('click', restart);
  $('btnCopy').addEventListener('click', () => copyAnalysis(a));
  $('btnAdvanced').addEventListener('click', () => {
    const t = $('advToast');
    t.textContent = '詳細進階報告正在打磨中——此功能即將開放，敬請期待。';
    t.classList.add('show');
    setTimeout(() => t.classList.remove('show'), 3200);
  });
  $('resultHost').querySelectorAll('.ai-btn').forEach((b) => {
    // 連結本身負責開新分頁（不會被彈窗攔截）；點擊當下同步把 handoff 寫入剪貼簿
    b.addEventListener('click', () => continueWithAI(a));
  });
  showScreen('screenResult');
}

// 完整內容（複製與導流共用）：主題 + 數 + 訊息（不揭示抽到的牌）
function fullText(a) {
  return [
    a.title || '給你的靈感訊息',
    '',
    `我的主題:${state.opening}`,
    `我報的三個數:${state.numbers ? state.numbers.join('、') : '（由當下時間起卦）'}`,
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
    '請你扮演一位溫暖而誠實的引導者，基於以上的主題與訊息，陪我繼續深入探討——我接下來會針對其中的內容提問。',
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
  if (state.status === 'astro') { state.status = 'weaving'; runAnalysis(); return; } // 舊版流程遺留
  if (state.status === 'weaving') { runAnalysis(); }
})();

// ---- utils ----
function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
