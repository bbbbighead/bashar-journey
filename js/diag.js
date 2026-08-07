// diag.js — 版面診斷面板（index.html?diag=1 才會載入）
//
// 為什麼需要這個：站主在 iPhone 上反覆看到「整頁往右偏」，但 headless 怎麼量都是
// 正的。同一個症狀有兩個完全不同的成因，而且從截圖上長得一模一樣：
//
//   A 文件被撐寬（水平溢出）
//     置中是相對文件寬算的，文件一變寬，置中的東西就整組往右移。
//     判斷方式：文件寬 > 視窗寬。
//
//   B 整頁被瀏覽器放大（縮放）
//     iOS Safari 點進字級 < 16px 的輸入框就會自動放大，失焦不會縮回去。
//     放大以左緣為錨點，右邊的留白被推出畫面外。
//     判斷方式：visualViewport.scale > 1。
//
// 兩者的修法完全不同，猜錯就白做。這支面板把兩邊的數字同時攤在畫面上，站主開一次
// 就知道是哪一種，不必再靠截圖來回猜。
//
// 決定性的一項是「選單鈕的實際位置」：.menu-toggle 是 position: fixed; left: 16px，
// 文件被撐寬動不了它，但整頁放大一定會把它推到 16 × 縮放倍率 的位置。

const $ = (id) => document.getElementById(id);

function vv() {
  return window.visualViewport || null;
}

// 量選單鈕：CSS 寫死 left: 16px，實際落在哪裡就反推出縮放倍率
function menuBtnLeft() {
  const el = document.querySelector('.menu-toggle');
  if (!el) return null;
  return el.getBoundingClientRect().left;
}

// 主面板的左右留白。相等＝置中
function panelGaps() {
  const el = document.querySelector('.screen.active .intake')
    || document.querySelector('.screen.active > *')
    || document.querySelector('.screen.active');
  if (!el) return null;
  const r = el.getBoundingClientRect();
  const w = document.documentElement.clientWidth;
  return { left: r.left, right: w - r.right, width: r.width };
}

// 伸出視窗右緣的元素（側邊選單刻意躲在左邊畫面外，不算）
function overflowing() {
  const w = document.documentElement.clientWidth;
  const out = [];
  for (const el of document.querySelectorAll('body *')) {
    if (el.closest('.side-menu') || el.closest('#diagPanel')) continue;
    const r = el.getBoundingClientRect();
    if (!r.width) continue;
    if (r.right > w + 1) {
      const cls = String(el.className || '').trim().split(/\s+/)[0] || '';
      out.push(`${el.tagName.toLowerCase()}${cls ? '.' + cls : ''} → ${Math.round(r.right)}`);
    }
  }
  return [...new Set(out)];
}

function collect() {
  const d = document.documentElement;
  const v = vv();
  const scale = v ? v.scale : 1;
  const mb = menuBtnLeft();
  const gaps = panelGaps();
  const over = overflowing();
  return {
    innerWidth: window.innerWidth,
    clientWidth: d.clientWidth,
    scrollWidth: d.scrollWidth,
    scrollX: Math.round(window.scrollX),
    dpr: window.devicePixelRatio,
    scale,
    vvWidth: v ? Math.round(v.width * 10) / 10 : null,
    vvLeft: v ? Math.round(v.offsetLeft * 10) / 10 : null,
    menuLeft: mb === null ? null : Math.round(mb * 100) / 100,
    menuRatio: mb === null ? null : Math.round((mb / 16) * 1000) / 1000,
    gaps,
    over,
  };
}

// 一句話結論。順序有意義：縮放先判，因為它會讓其他數字也跟著怪。
//
// ⚠ 溢出**不能**只看 scrollWidth。css/calm.css 給 html/body 上了 overflow-x: clip
// 當保險，被裁掉的部分就不再算進 scrollWidth，所以真的有元素伸出去時 scrollWidth
// 仍然等於 clientWidth。逐一量元素的 getBoundingClientRect() 才看得到——版面照樣
// 發生，只是畫面被裁掉而已。
function verdict(m) {
  const zoomed = m.scale > 1.01 || (m.menuRatio !== null && m.menuRatio > 1.02);
  const wide = m.over.length > 0 || m.scrollWidth > m.clientWidth + 1;
  const offset = m.gaps ? Math.round((m.gaps.left - m.gaps.right) / 2 * 10) / 10 : null;
  if (zoomed) {
    const z = m.scale > 1.01 ? m.scale : m.menuRatio;
    return {
      level: 'bad',
      text: `整頁被放大了約 ${z.toFixed(3)} 倍 → 這是「縮放」造成的偏移，不是版面問題。`
        + '按下面的「解除縮放」，或用兩指往內捏一下。',
    };
  }
  if (wide) {
    const who = m.over.length ? m.over[0] : `文件寬 ${m.scrollWidth} > 視窗寬 ${m.clientWidth}`;
    return {
      level: 'bad',
      text: `有東西伸出視窗右緣（${who}）→ 這是「版面溢出」造成的偏移。`,
    };
  }
  if (offset !== null && Math.abs(offset) > 1) {
    return { level: 'bad', text: `面板偏移 ${offset > 0 ? '右' : '左'} ${Math.abs(offset)}px，但看不出是縮放或溢出——把這一頁截圖給我。` };
  }
  return { level: 'ok', text: '沒有縮放、沒有溢出、面板置中——這一頁是正的。' };
}

function row(label, value, state) {
  return `<div class="dg-row${state ? ' dg-' + state : ''}">`
    + `<span class="dg-k">${label}</span><span class="dg-v">${value}</span></div>`;
}

function render() {
  const m = collect();
  const v = verdict(m);
  const gap = m.gaps
    ? `${m.gaps.left.toFixed(1)} / ${m.gaps.right.toFixed(1)}　(寬 ${m.gaps.width.toFixed(1)})`
    : '（量不到）';
  const gapState = m.gaps && Math.abs(m.gaps.left - m.gaps.right) <= 1 ? 'ok' : 'bad';

  $('diagBody').innerHTML = ''
    + `<div class="dg-verdict dg-${v.level}">${v.text}</div>`
    + row('視窗寬 innerWidth', m.innerWidth)
    + row('視窗寬 clientWidth', m.clientWidth)
    // scrollWidth 會被 overflow-x: clip 蓋住，不能單看它——真正可靠的是最下面
    // 那一列「伸出畫面的元素」。這裡列出來只是給個參考。
    + row('文件寬 scrollWidth（clip 會蓋住）', m.scrollWidth,
      m.scrollWidth > m.clientWidth + 1 ? 'bad' : 'ok')
    + row('橫向捲動位置', m.scrollX, m.scrollX === 0 ? 'ok' : 'bad')
    + row('縮放 visualViewport.scale', m.scale.toFixed(4),
      m.scale > 1.01 ? 'bad' : 'ok')
    + row('視覺視窗 寬 / 左偏', m.vvWidth === null ? '（不支援）' : `${m.vvWidth} / ${m.vvLeft}`)
    + row('選單鈕實際 left（CSS 寫 16）', m.menuLeft === null ? '（找不到）' : m.menuLeft,
      m.menuRatio !== null && m.menuRatio > 1.02 ? 'bad' : 'ok')
    + row('　→ 反推縮放倍率', m.menuRatio === null ? '—' : m.menuRatio.toFixed(3),
      m.menuRatio !== null && m.menuRatio > 1.02 ? 'bad' : 'ok')
    + row('面板左留白 / 右留白', gap, gapState)
    + row('裝置像素比 DPR', m.dpr)
    + row('伸出畫面的元素', m.over.length ? m.over.slice(0, 4).join('　') : '（無）',
      m.over.length ? 'bad' : 'ok')
    + row('螢幕', `${window.screen.width}×${window.screen.height}`)
    + `<div class="dg-ua">${navigator.userAgent}</div>`;
}

// iOS 解除縮放的標準手法：把 maximum-scale 暫時鎖成 1，瀏覽器會立刻縮回去，
// 然後馬上拿掉——如果留著，使用者就再也不能自己放大了（無障礙倒退）。
function resetZoom() {
  const meta = document.querySelector('meta[name="viewport"]');
  if (!meta) return;
  const original = meta.getAttribute('content');
  meta.setAttribute('content', 'width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=0');
  setTimeout(() => {
    meta.setAttribute('content', original);
    render();
  }, 350);
}

export function mountDiag() {
  const el = document.createElement('div');
  el.id = 'diagPanel';
  el.innerHTML = `
    <div class="dg-head">版面診斷<button type="button" id="diagClose" aria-label="關閉">✕</button></div>
    <div id="diagBody"></div>
    <div class="dg-acts">
      <button type="button" id="diagZoom">解除縮放</button>
      <button type="button" id="diagRefresh">重新量測</button>
    </div>`;
  document.body.appendChild(el);
  $('diagClose').addEventListener('click', () => el.remove());
  $('diagZoom').addEventListener('click', resetZoom);
  $('diagRefresh').addEventListener('click', render);

  render();
  // 縮放、捲動、轉向都會改變這些數字，跟著更新才看得到即時狀態
  const again = () => render();
  window.addEventListener('resize', again);
  window.addEventListener('scroll', again, { passive: true });
  const v = vv();
  if (v) {
    v.addEventListener('resize', again);
    v.addEventListener('scroll', again);
  }
}
