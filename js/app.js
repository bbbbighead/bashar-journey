// app.js — 「照見」頂層流程控制。
// 節奏：提問入口 →（敘事收集 ×4）→ 理解回照（可補充）→ 安靜整理 → 照見文件。
// 每一步都 saveSession，支援重整續談。

import {
  createSession, saveSession, loadSession, clearSession, NARRATIVE_TURNS,
} from './engine/session.js';
import {
  getNextQuestion, submitAnswer, getMirror, submitCorrection,
  ensureSpread, castMeihua, ensureEngines, getReading,
} from './engine/integrate.js';
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
  const order = ['narrative', 'mirror', 'divine', 'reading'];
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

// ---- 入口 ----
$('btnStart').addEventListener('click', start);
$('question').addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') start();
});
$('examples').addEventListener('click', (e) => {
  if (e.target.tagName === 'SPAN') $('question').value = e.target.textContent;
});
$('btnCareBack').addEventListener('click', () => showScreen('screenIntake'));

async function start() {
  const q = $('question').value.trim();
  if (!q) { $('question').focus(); return; }
  if (detectCrisis(q)) { showScreen('screenCare'); return; }

  state = createSession(q);
  saveSession(state);
  $('talkLog').innerHTML = '';
  setStage('narrative');
  showScreen('screenTalk');
  refreshOfflineTag();
  addUserMsg(q);
  await runNarrative();
}

// ---- 敘事收集 ----
async function runNarrative() {
  while (state.turns.length < NARRATIVE_TURNS) {
    showTyping();
    const next = await getNextQuestion(state);
    hideTyping();
    refreshOfflineTag();
    addGuideMsg(next.question);

    const answer = await waitComposer({ skipLabel: '先跳過' });
    addUserMsg(answer);
    submitAnswer(state, next.question, answer);
    saveSession(state);

    // 危機訊號可能出現在對談中途——一樣攔截
    if (answer && detectCrisis(answer)) { showScreen('screenCare'); return; }
  }
  state.status = 'mirror';
  saveSession(state);
  await runMirror();
}

// ---- 理解回照 ----
async function runMirror() {
  setStage('mirror');
  showTyping();
  const text = await getMirror(state);
  hideTyping();
  refreshOfflineTag();
  saveSession(state);
  addGuideMsg(text);

  const correction = await waitComposer({
    placeholder: '想修正或補充的話，寫在這裡……',
    skipLabel: '都對，請繼續',
  });
  if (correction) addUserMsg(correction);
  submitCorrection(state, correction);
  if (correction && detectCrisis(correction)) { showScreen('screenCare'); return; }

  state.status = 'spread';
  saveSession(state);
  runSpread();
}

// ---- 占卜一：雷諾曼九宮格翻牌 ----
// 牌面可見；解讀不逐牌說明，只進最後的交叉彙整。
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
    state.status = 'weaving';
    saveSession(state);
    runWeaving();
  };
  doneBtn.onclick = () => { if (inputs.every(valid)) proceed(inputs.map((el) => Number(el.value))); };
  skipBtn.onclick = () => proceed(null);

  showScreen('screenNumbers');
  setTimeout(() => inputs[0].focus(), 200);
}

// ---- 安靜整理 → 照見 ----
async function runWeaving() {
  showScreen('screenWeaving');
  ensureEngines(state);
  saveSession(state);

  const t0 = Date.now();
  const reading = await getReading(state);
  saveSession(state);

  // 讓過場至少停留一個呼吸的長度
  const waitMs = Math.max(0, 2400 - (Date.now() - t0));
  setTimeout(() => renderReading(reading), waitMs);
}

function renderReading(r) {
  setStage('reading');
  const qs = (r.questions || []).map((q) => `<li>${esc(q)}</li>`).join('');
  $('readingHost').innerHTML = `
    <div class="r-title">照 見</div>
    <div class="r-sub">這場對談，聽見了你</div>
    <div class="r-block core"><h3>我所理解的你</h3><p>${esc(r.understanding)}</p></div>
    ${r.newPerspective ? `<div class="r-block"><h3>另一種視角</h3><p>${esc(r.newPerspective)}</p></div>` : ''}
    ${r.tension ? `<div class="r-block"><h3>值得探索的張力</h3><p>${esc(r.tension)}</p></div>` : ''}
    ${qs ? `<div class="r-block"><h3>留給你的問題</h3><ul class="r-questions">${qs}</ul></div>` : ''}
    ${r.experiment ? `<div class="r-block"><h3>一個小實驗</h3><p>${esc(r.experiment)}</p></div>` : ''}
    ${r.basis ? `<div class="r-block r-basis"><h3>對應說明 · 牌與卦</h3><p>${esc(r.basis)}</p></div>` : ''}
    ${r.closing ? `<div class="r-closing">${esc(r.closing)}</div>` : ''}
    <div class="r-actions">
      <button class="btn" id="btnCopy">帶走這份照見</button>
      <button class="btn" id="btnRestart">開始新的對談</button>
    </div>`;
  $('btnRestart').addEventListener('click', restart);
  $('btnCopy').addEventListener('click', () => copyReading(r));
  showScreen('screenReading');
}

function copyReading(r) {
  const text = [
    '照見',
    '',
    `我帶來的問題:${state.opening}`,
    '',
    '【我所理解的你】', r.understanding,
    r.newPerspective ? `\n【另一種視角】\n${r.newPerspective}` : '',
    r.tension ? `\n【值得探索的張力】\n${r.tension}` : '',
    r.questions && r.questions.length ? `\n【留給你的問題】\n${r.questions.map((q) => '— ' + q).join('\n')}` : '',
    r.experiment ? `\n【一個小實驗】\n${r.experiment}` : '',
    r.basis ? `\n【對應說明 · 牌與卦】\n${r.basis}` : '',
    r.closing ? `\n${r.closing}` : '',
  ].filter((s) => s !== '').join('\n');
  const btn = $('btnCopy');
  navigator.clipboard.writeText(text).then(
    () => { btn.textContent = '已帶走 ✓'; setTimeout(() => { btn.textContent = '帶走這份照見'; }, 1800); },
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

// ---- 續談 ----
(async function resume() {
  const saved = loadSession();
  if (!saved || !saved.opening) return;
  state = saved;

  if (state.status === 'done' && state.reading) {
    renderReading(state.reading);
    return;
  }

  // 重建對談紀錄
  $('talkLog').innerHTML = '';
  showScreen('screenTalk');
  refreshOfflineTag();
  addUserMsg(state.opening);
  for (const t of state.turns) {
    addGuideMsg(t.question);
    addUserMsg(t.answer);
  }

  if (state.status === 'narrative') {
    setStage('narrative');
    await runNarrative();
  } else if (state.status === 'mirror') {
    setStage('mirror');
    if (state.mirror && state.mirror.text) {
      addGuideMsg(state.mirror.text);
      const correction = await waitComposer({
        placeholder: '想修正或補充的話，寫在這裡……',
        skipLabel: '都對，請繼續',
      });
      if (correction) addUserMsg(correction);
      submitCorrection(state, correction);
      state.status = 'spread';
      saveSession(state);
      runSpread();
    } else {
      await runMirror();
    }
  } else if (state.status === 'spread') {
    runSpread();
  } else if (state.status === 'numbers') {
    runNumbers();
  } else if (state.status === 'weaving') {
    await runWeaving();
  }
})();

// ---- utils ----
function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
