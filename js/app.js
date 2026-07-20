// app.js — 「拖延探索」頂層流程控制（規格 v1.0）。
// 節奏：輸入拖延情境 → 九宮格翻牌 → 報數起卦 → AI 建立假說（過場）
// → 四題驗證提問 → 第五題主假說確認（是/部分是/不是）→ 最後分析。
// 每一步都 saveSession，支援重整續玩。

import {
  createSession, saveSession, loadSession, clearSession, PROBE_COUNT,
} from './engine/session.js';
import {
  ensureSpread, castMeihua, buildHypotheses,
  getProbe, submitProbe, getConfirmation, submitVerdict, getAnalysis,
} from './engine/inquiry.js';
import { detectCrisis } from './content/crisis.js';
import { AI_CONFIG } from './ai/client.js';

const $ = (id) => document.getElementById(id);
let state = null;

// ---- 螢幕切換 ----
function showScreen(id) {
  document.querySelectorAll('.screen').forEach((s) => s.classList.remove('active'));
  $(id).classList.add('active');
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function setStage(stage) {
  const order = ['divine', 'probe', 'confirm', 'analysis'];
  const cur = order.indexOf(stage);
  document.querySelectorAll('.stage').forEach((el) => {
    const i = order.indexOf(el.dataset.stage);
    el.classList.toggle('on', i === cur);
    el.classList.toggle('done', i < cur);
  });
}

function refreshOfflineTag() {
  const off = !AI_CONFIG.enabled || !state || !state.aiAvailable;
  $('offlineTag').style.display = off ? 'inline-block' : 'none';
}

function showWeaving(text) {
  $('weavingText').innerHTML = text;
  showScreen('screenWeaving');
}

// ---- 對談訊息 ----
function addGuideMsg(text) {
  const div = document.createElement('div');
  div.className = 'msg guide';
  for (const para of String(text).split(/\n\n+/)) {
    const p = document.createElement('p');
    p.textContent = para;
    div.appendChild(p);
  }
  $('talkLog').appendChild(div);
  scrollToEnd();
}

function addUserMsg(text) {
  const div = document.createElement('div');
  div.className = 'msg user' + (text == null ? ' skip' : '');
  div.textContent = text == null ? '（先跳過）' : text;
  $('talkLog').appendChild(div);
  scrollToEnd();
}

let typingEl = null;
function showTyping() {
  typingEl = document.createElement('div');
  typingEl.className = 'msg guide';
  typingEl.innerHTML = '<span class="typing"><i></i><i></i><i></i></span>';
  $('talkLog').appendChild(typingEl);
  scrollToEnd();
}
function hideTyping() {
  if (typingEl) { typingEl.remove(); typingEl = null; }
}

function scrollToEnd() {
  requestAnimationFrame(() => window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' }));
}

// ---- 輸入區：回傳 Promise（送出 → 文字；跳過 → null） ----
function waitComposer({ placeholder, skipLabel }) {
  const box = $('composer');
  const ta = $('answer');
  const send = $('btnSend');
  const skip = $('btnSkip');

  ta.value = '';
  ta.placeholder = placeholder || '用你自己的話，慢慢說……';
  skip.textContent = skipLabel || '先跳過';
  send.disabled = true;
  box.style.display = 'block';
  scrollToEnd();
  setTimeout(() => ta.focus(), 200);

  return new Promise((resolve) => {
    const done = (value) => {
      ta.oninput = null; send.onclick = null; skip.onclick = null; ta.onkeydown = null;
      box.style.display = 'none';
      resolve(value);
    };
    ta.oninput = () => { send.disabled = !ta.value.trim(); };
    send.onclick = () => { if (ta.value.trim()) done(ta.value.trim()); };
    ta.onkeydown = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && ta.value.trim()) done(ta.value.trim());
    };
    skip.onclick = () => done(null);
  });
}

// 確認列：回傳 Promise（'yes' | 'partly' | 'no'）
function waitVerdict() {
  const row = $('verdictRow');
  row.style.display = 'flex';
  scrollToEnd();
  return new Promise((resolve) => {
    row.querySelectorAll('button').forEach((b) => {
      b.onclick = () => {
        row.querySelectorAll('button').forEach((x) => { x.onclick = null; });
        row.style.display = 'none';
        resolve(b.dataset.verdict);
      };
    });
  });
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

// ---- 占卜一：雷諾曼九宮格翻牌 ----
const POS_TIME = { past: '過去', present: '現在', future: '走向' };
const POS_LAYER = { mind: '想法', core: '現實', root: '潛意識' };

function runSpread() {
  setStage('divine');
  const spread = ensureSpread(state);
  saveSession(state);

  const grid = $('spreadGrid');
  const doneBtn = $('btnSpreadDone');
  grid.innerHTML = '';
  let flipped = 0;

  spread.forEach(({ position, card }) => {
    const el = document.createElement('div');
    el.className = 'scard';
    el.innerHTML = `
      <div class="scard-inner">
        <div class="scard-face scard-back"></div>
        <div class="scard-face scard-front">
          <span class="scard-no">${card.id}</span>
          <span class="scard-name">${card.name}</span>
        </div>
      </div>
      <div class="scard-pos">${POS_TIME[position.time]}・${POS_LAYER[position.layer]}</div>`;
    el.addEventListener('click', () => {
      if (el.classList.contains('flipped')) return;
      el.classList.add('flipped');
      flipped++;
      if (flipped === spread.length) doneBtn.disabled = false;
    });
    grid.appendChild(el);
  });

  doneBtn.disabled = true;
  doneBtn.onclick = () => {
    state.status = 'numbers';
    saveSession(state);
    runNumbers();
  };
  showScreen('screenSpread');
}

// ---- 占卜二：梅花易數報數起卦 ----
function runNumbers() {
  setStage('divine');
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
    state.status = 'probe';
    saveSession(state);
    runHypothesize();
  };
  doneBtn.onclick = () => { if (inputs.every(valid)) proceed(inputs.map((el) => Number(el.value))); };
  skipBtn.onclick = () => proceed(null);

  showScreen('screenNumbers');
  setTimeout(() => inputs[0].focus(), 200);
}

// ---- 建立工作假說（過場） ----
async function runHypothesize() {
  showWeaving('正在把你的描述、九張牌、和你報的數放在一起，<br>形成幾個關於「你為什麼還沒往前走」的假說……');
  const t0 = Date.now();
  await buildHypotheses(state);
  state.hypothesesDone = true;
  saveSession(state);
  refreshOfflineTag();
  const waitMs = Math.max(0, 1800 - (Date.now() - t0));
  setTimeout(() => enterProbe(true), waitMs);
}

// ---- 四題驗證提問 ----
function enterProbe(fresh) {
  setStage('probe');
  if (fresh) {
    $('talkLog').innerHTML = '';
    addUserMsg(state.opening);
    addGuideMsg('接下來我會問你四個問題——一次一題，沒有標準答案，想到什麼說什麼就好。');
  }
  showScreen('screenTalk');
  refreshOfflineTag();
  runProbeLoop();
}

async function runProbeLoop() {
  while (state.probes.length < PROBE_COUNT) {
    showTyping();
    const probe = await getProbe(state);
    hideTyping();
    refreshOfflineTag();
    addGuideMsg(probe.question);

    const answer = await waitComposer({ skipLabel: '先跳過' });
    addUserMsg(answer);
    submitProbe(state, probe.question, answer);
    saveSession(state);

    if (answer && detectCrisis(answer)) { showScreen('screenCare'); return; }
  }
  state.status = 'confirm';
  saveSession(state);
  await runConfirm();
}

// ---- 第五題：主假說確認 ----
async function runConfirm() {
  setStage('confirm');
  showTyping();
  const statement = await getConfirmation(state);
  hideTyping();
  refreshOfflineTag();
  saveSession(state);
  addGuideMsg(statement);
  await collectVerdict();
}

async function collectVerdict() {
  const verdict = await waitVerdict();
  const labels = { yes: '是', partly: '部分是', no: '不是' };
  addUserMsg(labels[verdict]);

  let note = null;
  if (verdict !== 'yes') {
    note = await waitComposer({
      placeholder: verdict === 'partly' ? '哪一部分是、哪一部分不是？說說看……' : '那你覺得比較接近的是什麼？',
      skipLabel: '先不補充',
    });
    if (note) addUserMsg(note);
    if (note && detectCrisis(note)) { showScreen('screenCare'); return; }
  }
  submitVerdict(state, verdict, note);

  state.status = 'weaving';
  saveSession(state);
  await runAnalysis();
}

// ---- 最後分析 ----
async function runAnalysis() {
  showWeaving('正在把牌、卦、你的回答、和你的確認，<br>整理成一份完整的分析……');
  const t0 = Date.now();
  const analysis = await getAnalysis(state);
  saveSession(state);
  const waitMs = Math.max(0, 2400 - (Date.now() - t0));
  setTimeout(() => renderResult(analysis), waitMs);
}

function renderResult(a) {
  setStage('analysis');
  $('resultHost').innerHTML = `
    <div class="r-title">最 後 分 析</div>
    <div class="r-sub">關於你為什麼還沒往前走</div>
    <div class="r-block core"><h3>拖延真正可能代表什麼</h3><p>${esc(a.meaning)}</p></div>
    ${a.coreBelief ? `<div class="r-block"><h3>正在運作的核心信念</h3><p>${esc(a.coreBelief)}</p></div>` : ''}
    ${a.direction ? `<div class="r-block"><h3>牌與卦共同指出的方向</h3><p>${esc(a.direction)}</p></div>` : ''}
    ${a.need ? `<div class="r-block"><h3>你目前真正需要的</h3><p>${esc(a.need)}</p></div>` : ''}
    ${a.action ? `<div class="r-block"><h3>一個最值得嘗試的小行動</h3><p>${esc(a.action)}</p></div>` : ''}
    ${a.basis ? `<div class="r-block r-basis"><h3>對應說明 · 牌與卦</h3><p>${esc(a.basis)}</p></div>` : ''}
    ${a.closing ? `<div class="r-closing">${esc(a.closing)}</div>` : ''}
    <div class="r-actions">
      <button class="btn" id="btnCopy">帶走這份分析</button>
      <button class="btn" id="btnRestart">開始新的探索</button>
    </div>`;
  $('btnRestart').addEventListener('click', restart);
  $('btnCopy').addEventListener('click', () => copyAnalysis(a));
  showScreen('screenResult');
}

function copyAnalysis(a) {
  const text = [
    '拖延探索 · 最後分析',
    '',
    `我的拖延情境:${state.opening}`,
    '',
    '【拖延真正可能代表什麼】', a.meaning,
    a.coreBelief ? `\n【正在運作的核心信念】\n${a.coreBelief}` : '',
    a.direction ? `\n【牌與卦共同指出的方向】\n${a.direction}` : '',
    a.need ? `\n【你目前真正需要的】\n${a.need}` : '',
    a.action ? `\n【一個最值得嘗試的小行動】\n${a.action}` : '',
    a.basis ? `\n【對應說明 · 牌與卦】\n${a.basis}` : '',
    a.closing ? `\n${a.closing}` : '',
  ].filter((s) => s !== '').join('\n');
  const btn = $('btnCopy');
  navigator.clipboard.writeText(text).then(
    () => { btn.textContent = '已帶走 ✓'; setTimeout(() => { btn.textContent = '帶走這份分析'; }, 1800); },
    () => { btn.textContent = '複製失敗'; }
  );
}

function restart() {
  clearSession();
  state = null;
  $('question').value = '';
  $('talkLog').innerHTML = '';
  showScreen('screenIntake');
}

// ---- 續玩 ----
(async function resume() {
  const saved = loadSession();
  if (!saved || !saved.opening) return;
  state = saved;

  if (state.status === 'done' && state.analysis) {
    renderResult(state.analysis);
    return;
  }
  if (state.status === 'spread') { runSpread(); return; }
  if (state.status === 'numbers') { runNumbers(); return; }

  if (state.status === 'probe') {
    if (!state.hypothesesDone) { runHypothesize(); return; }
    // 重建問答紀錄後繼續
    $('talkLog').innerHTML = '';
    showScreen('screenTalk');
    refreshOfflineTag();
    addUserMsg(state.opening);
    for (const p of state.probes) {
      addGuideMsg(p.question);
      addUserMsg(p.answer);
    }
    enterProbe(false);
    return;
  }

  if (state.status === 'confirm') {
    $('talkLog').innerHTML = '';
    showScreen('screenTalk');
    refreshOfflineTag();
    addUserMsg(state.opening);
    for (const p of state.probes) {
      addGuideMsg(p.question);
      addUserMsg(p.answer);
    }
    setStage('confirm');
    if (state.confirmation && state.confirmation.statement && !state.confirmation.verdict) {
      addGuideMsg(state.confirmation.statement);
      await collectVerdict();
    } else {
      await runConfirm();
    }
    return;
  }

  if (state.status === 'weaving') { await runAnalysis(); }
})();

// ---- utils ----
function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
