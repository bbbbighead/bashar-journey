// scene.js — v2 渲染進度光點與中央沉浸場景。純呈現，互動以 Promise 回傳給 screens.js。

import { TILE_LABELS } from '../engine/board.js';
import { renderCollectCard } from './cardFlip.js';

const TILE_ICON = {
  start: '✧', reflect: '◌', collect: '❈', finale: '✦',
};

// 進度光點 + 棋子
export function renderTrack(trackEl, state) {
  trackEl.innerHTML = '';
  state.board.tiles.forEach((t) => {
    const el = document.createElement('div');
    el.className = 'tile';
    if (t.idx < state.position) el.classList.add('done');
    if (t.idx === state.position) el.classList.add('here');
    el.textContent = TILE_ICON[t.type] || '·';
    el.title = TILE_LABELS[t.type] + (t.themeWord ? '·' + t.themeWord : '');
    if (t.idx === state.position) {
      const p = document.createElement('div');
      p.className = 'piece';
      p.textContent = '✦';
      el.appendChild(p);
    }
    trackEl.appendChild(el);
  });
}

// 一般敘事（啟程 / 過場 / 等待）
export function panelNarration(panelEl, { kind, text, prompt }) {
  panelEl.innerHTML = `
    <div class="tile-kind">${esc(kind || '')}</div>
    <div class="scene-text">${esc(text)}</div>
    ${prompt ? `<div class="prompt">${esc(prompt)}</div>` : ''}`;
}

// 開放提問：場景 + 提問 + 自由文字輸入。
// 回傳 Promise，玩家送出時 resolve 文字；點「先靜靜走過」時 resolve null。
export function panelReflect(panelEl, kind, reflect) {
  panelEl.innerHTML = `
    <div class="tile-kind">${esc(kind)}</div>
    ${reflect.scene ? `<div class="scene-text">${esc(reflect.scene)}</div>` : ''}
    <div class="prompt reflect-q">${esc(reflect.question)}</div>
    <div class="reflect-input">
      <textarea rows="3" maxlength="500" placeholder="用你自己的話，寫下此刻浮現的……"></textarea>
      <div class="reflect-actions">
        <button class="dice-btn reflect-submit" disabled>這樣回答 →</button>
        <span class="skip-link">先靜靜走過 →</span>
      </div>
    </div>`;
  const ta = panelEl.querySelector('textarea');
  const submit = panelEl.querySelector('.reflect-submit');
  const skip = panelEl.querySelector('.skip-link');
  ta.addEventListener('input', () => { submit.disabled = !ta.value.trim(); });
  setTimeout(() => ta.focus(), 250);

  return new Promise((resolve) => {
    submit.addEventListener('click', () => {
      if (!ta.value.trim()) return;
      submit.disabled = true; skip.style.display = 'none'; ta.disabled = true;
      resolve(ta.value.trim());
    });
    ta.addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && ta.value.trim()) submit.click();
    });
    skip.addEventListener('click', () => {
      submit.disabled = true; skip.style.display = 'none'; ta.disabled = true;
      resolve(null);
    });
  });
}

// 沿路拾得：拾得敘事 + 翻牌 + 個人化訊息（不顯示原文、不標來源）。
export async function panelCollect(panelEl, { pickup, card, reading }) {
  panelEl.innerHTML = `
    <div class="tile-kind">沿路拾得</div>
    <div class="scene-text pickup-text">${esc(pickup)}</div>
    <div class="card-host"></div>`;
  const host = panelEl.querySelector('.card-host');
  await renderCollectCard(host, card);
  const block = document.createElement('div');
  block.className = 'card-reading';
  block.innerHTML = `
    <h4>${esc(card.title)}</h4>
    <p>${esc(reading)}</p>`;
  block.style.opacity = '0';
  block.style.transition = 'opacity .6s';
  panelEl.appendChild(block);
  requestAnimationFrame(() => { block.style.opacity = '1'; });
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
