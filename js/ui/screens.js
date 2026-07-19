// screens.js — v2 頂層控制器：提問 → 世界成形 → 線性對話旅程 → 核心回應。
// 節奏：start →（reflect 回答後自動接 collect）×3 → finale。每一步都 saveJourney，支援重整續玩。

import { createJourney, saveJourney, loadJourney, clearJourney } from '../engine/journeyState.js';
import { advance, isFinale, TILE_LABELS } from '../engine/board.js';
import { genesis, getReflect, submitResponse, getCollect, getFinale } from '../engine/orchestrator.js';
import { renderTrack, panelNarration, panelReflect, panelCollect } from './scene.js';
import { detectCrisis } from '../content/intentMap.js';
import { AI_CONFIG } from '../ai/client.js';

// ---- starfield（手機減量）----
(function starfield() {
  const sf = document.getElementById('stars');
  const n = window.innerWidth < 560 ? 45 : 90;
  for (let i = 0; i < n; i++) {
    const s = document.createElement('span');
    const sz = Math.random() * 2 + 0.5;
    s.style.width = s.style.height = sz + 'px';
    s.style.left = Math.random() * 100 + '%';
    s.style.top = Math.random() * 100 + '%';
    s.style.setProperty('--d', (Math.random() * 3 + 1.5) + 's');
    sf.appendChild(s);
  }
})();

const $ = (id) => document.getElementById(id);
const app = $('app');
let state = null;
let busy = false;

// ---- 螢幕切換 ----
function showScreen(id) {
  document.querySelectorAll('.screen').forEach((s) => s.classList.remove('active'));
  $(id).classList.add('active');
  window.scrollTo({ top: 0, behavior: 'smooth' });
}
function showForming(text) {
  $('formingText').textContent = text;
  showScreen('screenForming');
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
  if (detectCrisis(q)) { showScreen('screenCare'); return; } // 危機訊號 → 模板關懷，不進遊戲
  state = createJourney(q);
  saveJourney(state);
  showForming('世界正在為你的提問成形…');
  await genesis(state);
  saveJourney(state);
  enterPlay(true);
}

// ---- 進入遊玩 ----
function enterPlay(fresh) {
  app.setAttribute('data-palette', state.world.palette || 'cosmic');
  $('worldTitle').textContent = state.world.title;
  $('worldSetting').textContent = state.world.setting;
  refreshOfflineTag();
  renderTrack($('track'), state);
  showScreen('screenPlay');

  if (state.status === 'done' && state.finale) { renderFinale(state.finale); showScreen('screenFinale'); return; }
  if (isFinale(state)) { doFinale(); return; }

  if (fresh || state.position === 0) {
    panelNarration($('panel'), {
      kind: '啟程',
      text: state.world.setting,
      prompt: '準備好了，就往前走。',
    });
    setNext('啟程 ✦');
  } else {
    // 續玩：從目前位置重新展開該站
    resolveStep();
  }
}

function refreshOfflineTag() {
  const off = !AI_CONFIG.enabled || !state.aiAvailable;
  $('offlineTag').style.display = off ? 'inline-block' : 'none';
}

// ---- 控制列 ----
function setNext(label) {
  const b = $('btnNext');
  if (label) { b.textContent = label; b.style.display = 'inline-flex'; b.disabled = false; }
  else { b.style.display = 'none'; }
}

$('btnNext').addEventListener('click', onNext);

async function onNext() {
  if (busy) return;
  busy = true;
  setNext(null);
  state.position = advance(state.position);
  state.turn++;
  renderTrack($('track'), state);
  await resolveStep();
  saveJourney(state);
  busy = false;
}

// 展開目前所在的站
async function resolveStep() {
  const tile = state.board.tiles[state.position];

  if (tile.type === 'finale') { await doFinale(); return; }

  if (tile.type === 'reflect') {
    const kind = `旅程對話 · ${tile.themeWord || TILE_LABELS.reflect}`;
    panelNarration($('panel'), { kind, text: '……', prompt: '' });
    const reflect = await getReflect(state, tile);
    refreshOfflineTag();
    const answer = await panelReflect($('panel'), kind, reflect);
    submitResponse(state, tile, reflect.question, answer);
    saveJourney(state);
    // 回答之後，路自動給出回應：前進到下一站（collect）
    state.position = advance(state.position);
    renderTrack($('track'), state);
    await resolveStep();
    return;
  }

  if (tile.type === 'collect') {
    panelNarration($('panel'), { kind: '沿路拾得', text: '光正在向你聚攏……', prompt: '' });
    const { card, pickup, reading } = await getCollect(state, tile);
    refreshOfflineTag();
    await panelCollect($('panel'), { pickup, card, reading });
    const nextTile = state.board.tiles[state.position + 1];
    setNext(nextTile && nextTile.type === 'finale' ? '接收給你的回應 ✦' : '繼續前行 →');
    return;
  }

  // start（理論上只有續玩會走到）
  panelNarration($('panel'), { kind: '啟程', text: state.world.setting, prompt: '準備好了，就往前走。' });
  setNext('啟程 ✦');
}

// ---- 結局 ----
async function doFinale() {
  setNext(null);
  state.status = 'finale';
  showForming('正在把你的話，編織成給你的回應…');
  const fin = await getFinale(state);
  saveJourney(state);
  renderFinale(fin);
  showScreen('screenFinale');
}

function renderFinale(fin) {
  const cards = (fin.keyCards || []).map((t) => `<span class="fc">${esc(t)}</span>`).join('');
  $('finaleHost').innerHTML = `
    <div class="ftitle">${esc(fin.title)}</div>
    <div class="fsub">你的旅程，聽見了你</div>
    <div class="finale-block answer core"><h3>給你的回應</h3><p>${esc(fin.coreAnswer)}</p></div>
    ${cards ? `<div class="finale-block"><h3>沿途拾得的訊息</h3><div class="finale-cards">${cards}</div></div>` : ''}
    ${fin.recap ? `<div class="finale-block"><h3>旅程回顧</h3><p>${esc(fin.recap)}</p></div>` : ''}
    ${fin.suggestedPractice ? `<div class="finale-block"><h3>帶走這份練習</h3><p>${esc(fin.suggestedPractice)}</p></div>` : ''}
    ${fin.closingBlessing ? `<div class="finale-block answer"><h3>臨別祝福</h3><p>${esc(fin.closingBlessing)}</p></div>` : ''}
    <div class="finale-actions">
      <button class="dice-btn" id="btnCopy">複製這份回應</button>
      <button class="dice-btn" id="btnRestart">開啟新的旅程 ✦</button>
    </div>`;
  $('btnRestart').addEventListener('click', restart);
  $('btnCopy').addEventListener('click', () => copyFinale(fin));
}

function copyFinale(fin) {
  const text = [
    fin.title,
    '',
    `我的提問:${state.question.raw}`,
    '',
    '【給我的回應】',
    fin.coreAnswer,
    fin.keyCards && fin.keyCards.length ? `\n沿途拾得:${fin.keyCards.join('、')}` : '',
    fin.recap ? `\n旅程回顧:${fin.recap}` : '',
    fin.suggestedPractice ? `\n帶走的練習:${fin.suggestedPractice}` : '',
    fin.closingBlessing ? `\n${fin.closingBlessing}` : '',
    '\n— 心之星旅',
  ].join('\n');
  const btn = $('btnCopy');
  navigator.clipboard.writeText(text).then(
    () => { btn.textContent = '已複製 ✓'; setTimeout(() => { btn.textContent = '複製這份回應'; }, 1800); },
    () => { btn.textContent = '複製失敗'; }
  );
}

function restart() {
  clearJourney();
  state = null;
  $('question').value = '';
  showScreen('screenIntake');
}

// ---- 續玩 ----
(function resume() {
  const saved = loadJourney();
  if (!saved || !saved.world || !saved.board) return;
  state = saved;
  if (state.status === 'done' && state.finale) {
    app.setAttribute('data-palette', state.world.palette || 'cosmic');
    renderFinale(state.finale);
    showScreen('screenFinale');
  } else if (state.status === 'playing' || state.status === 'finale') {
    enterPlay(false);
  }
})();

// ---- utils ----
function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
