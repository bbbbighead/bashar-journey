// chartZoom.js — 星盤輪的放大檢視。
//
// 為什麼需要：星盤輪的資訊密度是刻意做滿的（對齊專業星盤軟體），在 390px 寬的
// 手機上一定讀不清度數與小行星符號。解法不是把內容減少，是讓它可以放大。
//
// 操作方式（四種都支援，因為使用者的習慣不一樣）：
//   兩指捏合縮放、單指拖曳平移、連點兩下切換 1×／2.6×、右下角的 ＋／－／重設按鈕
//   桌機另外支援滾輪縮放與方向鍵平移。
//
// 指引：開啟時中央浮出一行操作提示，4 秒後淡出；縮放倍率隨時顯示在角落。
// 沒有這兩樣的話，「可以捏合」這件事只有本來就知道的人會知道。
//
// 實作用 Pointer Events 而不是 Touch Events：同一套程式碼同時吃觸控、滑鼠與
// 觸控筆，不必寫兩份；捏合則自己從兩個 pointer 的距離算，不依賴非標準的
// gesturechange（那是 Safari 專有的）。

const MIN_K = 1;
const MAX_K = 6;
const DBL_K = 2.6;        // 連點兩下的目標倍率
const HINT_MS = 4200;

let overlay = null;       // 同時只會有一個放大檢視
let lastFocus = null;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// 縮放後把內容夾回可視範圍：放到最小時回到正中，放大時最多拖到邊緣為止。
// 沒有這個的話一放手圖就飛出畫面，使用者只能關掉重開。
function clampPan(st) {
  const { stage, k } = st;
  const w = stage.clientWidth;
  const h = stage.clientHeight;
  const ox = Math.max(0, (w * k - w) / 2);
  const oy = Math.max(0, (h * k - h) / 2);
  st.x = clamp(st.x, -ox, ox);
  st.y = clamp(st.y, -oy, oy);
}

function apply(st) {
  clampPan(st);
  st.inner.style.transform = `translate(${st.x}px, ${st.y}px) scale(${st.k})`;
  st.readout.textContent = `${st.k.toFixed(1)}×`;
  st.el.classList.toggle('zoomed', st.k > MIN_K + 0.01);
}

// 以畫面上的某個點為錨縮放：那個點在縮放前後要停在原地，
// 否則捏合的時候圖會從指間滑走。
function zoomAt(st, nextK, cx, cy) {
  const k2 = clamp(nextK, MIN_K, MAX_K);
  const r = st.stage.getBoundingClientRect();
  const px = cx - r.left - r.width / 2;
  const py = cy - r.top - r.height / 2;
  const ratio = k2 / st.k;
  st.x = px - (px - st.x) * ratio;
  st.y = py - (py - st.y) * ratio;
  st.k = k2;
  apply(st);
}

function reset(st) {
  st.k = MIN_K; st.x = 0; st.y = 0;
  apply(st);
}

export function closeChartZoom() {
  if (!overlay) return;
  overlay.remove();
  overlay = null;
  document.body.classList.remove('cz-open');
  if (lastFocus && document.contains(lastFocus)) lastFocus.focus();
  lastFocus = null;
}

// svgHtml：要放大的 SVG（原圖的 outerHTML）。labels：該語系文案。
// opts.showAux：進來時要不要顯示次要相位（沿用原圖的狀態）。
// opts.hasAux：這張盤有沒有次要相位可切（沒有就不要放一個切了沒反應的開關）。
export function openChartZoom(svgHtml, labels = {}, opts = {}) {
  if (overlay) closeChartZoom();
  lastFocus = document.activeElement;

  const el = document.createElement('div');
  el.className = 'cz-overlay';
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-modal', 'true');
  el.setAttribute('aria-label', labels.zoomTitle || '');
  // SVG 外面要套回 .cw-wrap：次要相位的顯示與否是「.cw-wrap:not(.show-aux)」
  // 決定的，少了這層祖先，收起來的線在放大檢視裡會全部跑出來（實測踩到）。
  const wrapCls = `cw-wrap cz-fig${opts.showAux ? ' show-aux' : ''}`;
  el.innerHTML = `
    <div class="cz-bar">
      <span class="cz-title">${labels.zoomTitle || ''}</span>
      <button type="button" class="cz-btn cz-close" aria-label="${labels.zoomClose || ''}">✕</button>
    </div>
    <div class="cz-stage"><div class="cz-inner"><div class="${wrapCls}">${svgHtml}</div></div></div>
    <p class="cz-hint">${labels.zoomHint || ''}</p>
    <div class="cz-tools">
      <span class="cz-readout" aria-live="polite">1.0×</span>
      <button type="button" class="cz-btn cz-out" aria-label="${labels.zoomOut || ''}">－</button>
      <button type="button" class="cz-btn cz-in" aria-label="${labels.zoomIn || ''}">＋</button>
      <button type="button" class="cz-btn cz-reset">${labels.zoomReset || ''}</button>
      ${opts.hasAux ? `<label class="cz-aux">
        <input type="checkbox" class="cz-aux-chk"${opts.showAux ? ' checked' : ''}>
        <span>${labels.showMinor || ''}</span></label>` : ''}
    </div>`;
  document.body.append(el);
  document.body.classList.add('cz-open');
  overlay = el;

  const st = {
    el,
    stage: el.querySelector('.cz-stage'),
    inner: el.querySelector('.cz-inner'),
    readout: el.querySelector('.cz-readout'),
    k: MIN_K, x: 0, y: 0,
  };
  apply(st);

  // 提示語過幾秒淡出：一直掛在畫面中央會擋住圖
  const hint = el.querySelector('.cz-hint');
  const hintTimer = setTimeout(() => hint.classList.add('gone'), HINT_MS);

  // ---- 手勢 ----
  const pts = new Map();          // pointerId → 目前座標
  let pinch = null;               // { dist, k }
  let pan = null;                 // { x, y, sx, sy }
  let lastTap = 0;
  let moved = 0;

  const centre = () => {
    const a = [...pts.values()];
    return [
      a.reduce((s, p) => s + p.x, 0) / a.length,
      a.reduce((s, p) => s + p.y, 0) / a.length,
    ];
  };
  const spread = () => {
    const [a, b] = [...pts.values()];
    return Math.hypot(a.x - b.x, a.y - b.y);
  };

  st.stage.addEventListener('pointerdown', (e) => {
    st.stage.setPointerCapture(e.pointerId);
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    moved = 0;
    if (pts.size === 2) {
      pinch = { dist: spread(), k: st.k };
      pan = null;
    } else if (pts.size === 1) {
      pan = { x: st.x, y: st.y, sx: e.clientX, sy: e.clientY };
    }
  });

  st.stage.addEventListener('pointermove', (e) => {
    if (!pts.has(e.pointerId)) return;
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pinch && pts.size >= 2) {
      const d = spread();
      if (pinch.dist > 0) {
        const [cx, cy] = centre();
        // 用「相對於按下時」的比例，而不是逐格累乘：累乘會累積誤差，
        // 捏到一半再放大縮小就會跟手指對不上。
        const target = pinch.k * (d / pinch.dist);
        moved = 99;
        zoomAt(st, target, cx, cy);
      }
    } else if (pan && pts.size === 1) {
      const dx = e.clientX - pan.sx;
      const dy = e.clientY - pan.sy;
      moved = Math.max(moved, Math.hypot(dx, dy));
      // 沒放大的時候不給平移：不然一碰就把圖推歪，使用者不知道發生什麼事
      if (st.k > MIN_K + 0.01) {
        st.x = pan.x + dx;
        st.y = pan.y + dy;
        apply(st);
      }
    }
  });

  const release = (e) => {
    if (!pts.has(e.pointerId)) return;
    pts.delete(e.pointerId);
    if (pts.size < 2) pinch = null;
    if (pts.size === 0) {
      pan = null;
      // 連點兩下切換倍率。moved 小於 12px 才算「點」，不然拖曳收尾會誤判。
      if (moved < 12) {
        const now = e.timeStamp;
        if (now - lastTap < 320) {
          zoomAt(st, st.k > MIN_K + 0.01 ? MIN_K : DBL_K, e.clientX, e.clientY);
          if (st.k <= MIN_K + 0.01) reset(st);
          lastTap = 0;
        } else {
          lastTap = now;
        }
      }
    }
  };
  st.stage.addEventListener('pointerup', release);
  st.stage.addEventListener('pointercancel', release);

  // 桌機：滾輪縮放（Ctrl+滾輪也一樣，觸控板的捏合會送出 ctrlKey 的 wheel）
  st.stage.addEventListener('wheel', (e) => {
    e.preventDefault();
    const f = Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0022));
    zoomAt(st, st.k * f, e.clientX, e.clientY);
  }, { passive: false });

  // ---- 按鈕與鍵盤 ----
  const mid = () => {
    const r = st.stage.getBoundingClientRect();
    return [r.left + r.width / 2, r.top + r.height / 2];
  };
  el.querySelector('.cz-in').onclick = () => zoomAt(st, st.k * 1.5, ...mid());
  el.querySelector('.cz-out').onclick = () => zoomAt(st, st.k / 1.5, ...mid());
  el.querySelector('.cz-reset').onclick = () => reset(st);
  el.querySelector('.cz-close').onclick = closeChartZoom;
  // 放大檢視裡也能切次要相位——這裡正是你會想看細節的地方
  const auxChk = el.querySelector('.cz-aux-chk');
  if (auxChk) {
    auxChk.onchange = () => {
      el.querySelector('.cz-fig').classList.toggle('show-aux', auxChk.checked);
    };
  }
  // 點圖以外的空白處關閉，跟一般的燈箱一致
  el.addEventListener('pointerdown', (e) => { if (e.target === el) closeChartZoom(); });

  el.addEventListener('keydown', (e) => {
    const step = 40;
    if (e.key === 'Escape') { closeChartZoom(); return; }
    if (e.key === '+' || e.key === '=') { zoomAt(st, st.k * 1.5, ...mid()); e.preventDefault(); return; }
    if (e.key === '-' || e.key === '_') { zoomAt(st, st.k / 1.5, ...mid()); e.preventDefault(); return; }
    if (e.key === '0') { reset(st); e.preventDefault(); return; }
    const d = { ArrowLeft: [step, 0], ArrowRight: [-step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] }[e.key];
    if (d) { st.x += d[0]; st.y += d[1]; apply(st); e.preventDefault(); }
  });

  el.querySelector('.cz-close').focus();
  el.addEventListener('remove', () => clearTimeout(hintTimer));
  return el;
}

// 掛在結果頁的容器上：星盤輪是每次重繪就重新產生的 HTML，所以用事件委派，
// 不對個別元素綁 listener（重繪後舊的 listener 會跟著死掉）。
export function mountChartZoom(root, getLabels) {
  if (!root || root.dataset.czMounted) return;
  root.dataset.czMounted = '1';
  const open = (canvas) => {
    const svg = canvas.querySelector('svg');
    if (!svg) return;
    const wrap = canvas.closest('.cw-wrap');
    openChartZoom(svg.outerHTML, getLabels() || {}, {
      showAux: !!(wrap && wrap.classList.contains('show-aux')),
      hasAux: !!(wrap && wrap.querySelector('.cw-asp-aux')),
    });
  };
  root.addEventListener('click', (e) => {
    // 圖例的次要相位開關也在 .cw-wrap 裡，不能一起吃掉
    if (e.target.closest('.cw-toggle')) return;
    const canvas = e.target.closest('.cw-canvas');
    if (canvas) open(canvas);
  });
  root.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const canvas = e.target.closest('.cw-canvas');
    if (canvas) { e.preventDefault(); open(canvas); }
  });
  // 次要相位開關：勾了就在外層加 class，由 CSS 決定顯不顯示（不必重畫 SVG）
  root.addEventListener('change', (e) => {
    if (!e.target.classList.contains('cw-minor-chk')) return;
    const wrap = e.target.closest('.cw-wrap');
    if (wrap) wrap.classList.toggle('show-aux', e.target.checked);
  });
}
