// shareCard.js — 把這一次抽到的東西畫成一張方形圖，讓使用者存下或分享出去。
//
// 為什麼是「重畫成 SVG」而不是「截圖畫面」：
// 沒有截圖 API 能在不裝套件的情況下把 DOM 變成圖。但這三個視覺本來就都能用
// SVG 表達（牌面圖案與星盤本來就是 SVG，卦爻就是幾個矩形），所以直接組一張
// 自給自足的 SVG，再用瀏覽器自己的光柵化能力轉成 PNG——零外部套件。
//
// 一個關鍵限制：SVG 透過 <img> 載入時是隔離環境，**頁面的 CSS 完全不套用**、
// 外部資源（背景圖、web font）也一律不載入。所以：
//   ・要用到的樣式必須內嵌進 SVG 的 <style>（見 inlineStyles）
//   ・CSS 變數要先在頁面上算成實際色值再寫進去，不能留 var(--accent)
//   ・底圖用漸層自己畫，不引用 assets 裡的照片
// 字型不必內嵌：全站用的是系統字型堆疊，隔離環境照樣拿得到裝置上的字。

import { cardConstellation } from '../data/lenormandIcons.js';
import { hexagramLines } from './engine/meihua.js';
import { chartWheelSvg } from './chartWheel.js';

const W = 360;              // 內部座標；輸出時放大到 OUT
const OUT = 1080;           // 實際 PNG 邊長（社群平台縮圖後仍清楚）
const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

const VAR_NAMES = ['--ink', '--ink-dim', '--ink-faint', '--accent', '--accent-dim',
  '--line', '--line-strong', '--panel', '--bg'];

// 從頁面上取實際色值（CSS 變數在隔離環境裡解不開，要先換成字面值）
function palette() {
  const cs = getComputedStyle(document.documentElement);
  const v = (name, fallback) => (cs.getPropertyValue(name).trim() || fallback);
  return {
    ink: v('--ink', '#f7f2e6'),
    inkDim: v('--ink-dim', '#ddd4c0'),
    inkFaint: v('--ink-faint', '#b3a98f'),
    accent: v('--accent', '#e0c184'),
    accentDim: v('--accent-dim', '#c2a869'),
    line: v('--line', 'rgba(214,183,122,.18)'),
  };
}

// 把整站的 CSS 變數重新宣告在 SVG 的根元素上。
// 這一段是必要的，不是保險：卡片上的規則（含搬過來的 .cw-*）大量使用
// var(--accent) 這類寫法，而 <img> 載入的 SVG 是獨立文件，拿不到頁面的
// :root 宣告——少了這段，那些顏色會全部變成黑色（實測過）。
function cssVars() {
  const cs = getComputedStyle(document.documentElement);
  const decls = VAR_NAMES
    .map((n) => [n, cs.getPropertyValue(n).trim()])
    .filter(([, val]) => val)
    .map(([n, val]) => `${n}:${val}`);
  return `svg{${decls.join(';')}}`;
}

// 把頁面樣式表裡「用得到的那些規則」抓出來內嵌。
// 直接從 document.styleSheets 讀，而不是在這裡另寫一份——不然 calm.css 一改
// 分享圖就默默走鐘。CSS 變數同時展開成實際色值。
function inlineStyles(prefixes) {
  const out = [];
  for (const sheet of Array.from(document.styleSheets)) {
    let rules;
    try { rules = sheet.cssRules; } catch { continue; }   // 跨網域樣式表讀不到
    for (const rule of Array.from(rules || [])) {
      const sel = rule.selectorText;
      if (!sel) continue;
      if (prefixes.some((p) => sel.includes(p))) out.push(rule.cssText);
    }
  }
  return out.join('\n');
}

// ── 三個工具各自的視覺 ────────────────────────────────────────────────────
// 每個都回 { body, styles }：body 畫在 viewBox 內，styles 是額外要內嵌的規則。

// 雷諾曼：3×3，每格＝星座圖案＋牌名
function lenormandBody(spread, nameOf) {
  // 版面高度只有 360：標題區到頁尾之間約 250，所以 3 排格子必須壓在這個範圍內
  const CELL = 76, GAP = 7, X0 = (W - (CELL * 3 + GAP * 2)) / 2, Y0 = 80;
  const cells = spread.slice(0, 9).map(({ card }, i) => {
    const x = X0 + (i % 3) * (CELL + GAP);
    const y = Y0 + Math.floor(i / 3) * (CELL + GAP);
    // cardConstellation 回的是完整 <svg viewBox="0 0 100 100">，用 <g> 縮放塞進格子
    const ico = cardConstellation(card.id).replace(/^<svg[^>]*>/, '').replace(/<\/svg>$/, '');
    const k = (CELL * 0.56) / 100;
    return `<g>
      <rect x="${x}" y="${y}" width="${CELL}" height="${CELL}" rx="2"
        fill="rgba(10,15,24,.55)" stroke="rgba(214,183,122,.22)" stroke-width="0.8"/>
      <text x="${x + 7}" y="${y + 13}" class="sc-pos">${i + 1}</text>
      <g transform="translate(${x + CELL * 0.22},${y + CELL * 0.14}) scale(${k})">${ico}</g>
      <text x="${x + CELL / 2}" y="${y + CELL - 8}" class="sc-cardname">${esc(nameOf(card))}</text>
    </g>`;
  }).join('');
  return {
    body: cells,
    styles: `.sc-pos{fill:var(--accent-dim);font-size:9px;opacity:.8}
      .sc-cardname{fill:var(--ink);font-size:10.5px;text-anchor:middle}`,
  };
}

// 梅花易數：本卦／互卦／變卦三欄，六爻由下而上，動爻加亮
function meihuaBody(cast, labels) {
  const COL = 100, GAP = 10, X0 = (W - (COL * 3 + GAP * 2)) / 2, Y0 = 96;
  const BAR = 9, LH = 17, BW = 76;
  const col = (hex, role, ox, movingAt) => {
    const lines = hexagramLines(hex);
    if (!lines.length) return '';
    const cx = ox + COL / 2;
    const yao = lines.map((v, i) => {
      const y = Y0 + 34 + (5 - i) * LH;             // i=0 是初爻 → 畫在最下面
      const on = movingAt && (i + 1) === movingAt;
      const cls = on ? 'sc-yao sc-yao-on' : 'sc-yao';
      return v
        ? `<rect x="${cx - BW / 2}" y="${y}" width="${BW}" height="${BAR}" rx="1" class="${cls}"/>`
        : `<rect x="${cx - BW / 2}" y="${y}" width="${BW * 0.42}" height="${BAR}" rx="1" class="${cls}"/>
           <rect x="${cx + BW / 2 - BW * 0.42}" y="${y}" width="${BW * 0.42}" height="${BAR}" rx="1" class="${cls}"/>`;
    }).join('');
    return `<g>
      <rect x="${ox}" y="${Y0}" width="${COL}" height="${168}" rx="2"
        fill="rgba(10,15,24,.55)" stroke="rgba(214,183,122,.22)" stroke-width="0.8"/>
      <text x="${cx}" y="${Y0 + 20}" class="sc-role">${esc(role)}</text>
      ${yao}
      <text x="${cx}" y="${Y0 + 152}" class="sc-hexname">${esc(hex.name || '')}</text>
    </g>`;
  };
  return {
    body: col(cast.ben, labels.ben, X0, cast.moving)
      + col(cast.hu, labels.hu, X0 + COL + GAP)
      + col(cast.bian, labels.bian, X0 + (COL + GAP) * 2),
    styles: `.sc-role{fill:var(--accent-dim);font-size:11px;text-anchor:middle;letter-spacing:.1em}
      .sc-hexname{fill:var(--ink);font-size:13px;text-anchor:middle}
      .sc-yao{fill:var(--accent-dim)}
      .sc-yao-on{fill:var(--accent)}`,
  };
}

// 占星：直接搬結果頁那張星盤 SVG（它本來就是 SVG），連同 .cw-* 樣式內嵌
function astroBody(chart, wheelLabels) {
  const html = chartWheelSvg(chart, wheelLabels);
  if (!html) return null;
  // chartWheelSvg 回的不是單純一張 SVG，是包著它的 <figure>（含放大鏡圖示、
  // 提示句、圖例——全都是 HTML）。用瀏覽器解析後取出第一個 <svg> 元素，
  // 不要用正規表示式硬切：切不乾淨的話 HTML 殘留會讓 SVG 變成無效 XML，
  // 而 <img> 載入 SVG 是嚴格 XML 解析，一個錯誤就整張圖不出來。
  const holder = document.createElement('div');
  holder.innerHTML = html;
  const wheel = holder.querySelector('svg');
  if (!wheel) return null;
  const inner = wheel.innerHTML;
  const [vx, vy, vw, vh] = String(wheel.getAttribute('viewBox') || '0 0 728 728')
    .split(/[\s,]+/).map(Number);
  const SIZE = 248, X = (W - SIZE) / 2, Y = 80;
  const k = SIZE / Math.max(vw, vh);
  return {
    // 星盤上的次要相位在頁面上是靠 .cw-wrap:not(.show-aux) 藏起來的，
    // 這裡沒有那層 wrapper，所以自己補一條規則把它藏掉（分享圖要乾淨）
    body: `<g transform="translate(${X},${Y}) scale(${k}) translate(${-vx},${-vy})">${inner}</g>`,
    styles: inlineStyles(['.cw-']) + '\n.cw-asp-aux{display:none}\n.cw-zoom-badge{display:none}',
  };
}

// ── 組出整張卡 ────────────────────────────────────────────────────────────
export function buildShareCardSvg({ tool, state, labels }) {
  const p = palette();
  let part = null;
  if (tool === 'lenormand' && Array.isArray(state.lenormand) && state.lenormand.length) {
    part = lenormandBody(state.lenormand, labels.cardName);
    part.styles += '\n' + inlineStyles(['.cst']);
  } else if (tool === 'meihua' && state.meihua && state.meihua.ben) {
    part = meihuaBody(state.meihua, labels.meihuaGrid || {});
  } else if (tool === 'astro' && state.astro) {
    part = astroBody(state.astro, labels.chartWheel || {});
  }
  if (!part) return null;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${OUT}" height="${OUT}"
  viewBox="0 0 ${W} ${W}" font-family="${esc(labels.fontStack)}">
<defs>
  <linearGradient id="scbg" x1="0" y1="0" x2="0.3" y2="1">
    <stop offset="0" stop-color="#0b111c"/><stop offset="0.55" stop-color="#070c14"/>
    <stop offset="1" stop-color="#04070c"/>
  </linearGradient>
  <radialGradient id="scglow" cx="0.5" cy="0.42" r="0.6">
    <stop offset="0" stop-color="rgba(214,183,122,.10)"/>
    <stop offset="1" stop-color="rgba(214,183,122,0)"/>
  </radialGradient>
</defs>
<style>
  ${cssVars()}
  text{font-family:${esc(labels.fontStack)}}
  .sc-brand{fill:${p.accentDim};font-size:10px;letter-spacing:.34em;text-anchor:middle}
  .sc-tool{fill:${p.accent};font-size:16px;letter-spacing:.2em;text-anchor:middle}
  .sc-foot{fill:${p.inkFaint};font-size:9px;letter-spacing:.08em;text-anchor:middle}
  ${part.styles}
</style>
<rect width="${W}" height="${W}" fill="url(#scbg)"/>
<rect width="${W}" height="${W}" fill="url(#scglow)"/>
<rect x="10" y="10" width="${W - 20}" height="${W - 20}" fill="none"
  stroke="rgba(214,183,122,.16)" stroke-width="0.7"/>
<text x="${W / 2}" y="34" class="sc-brand">INTUITIVE NOTES</text>
<line x1="${W / 2 - 34}" y1="44" x2="${W / 2 + 34}" y2="44" stroke="rgba(214,183,122,.3)" stroke-width="0.7"/>
<text x="${W / 2}" y="70" class="sc-tool">${esc(labels.toolName)}</text>
${part.body}
<text x="${W / 2}" y="${W - 22}" class="sc-foot">${esc(labels.footer)}</text>
</svg>`;
}

// SVG 字串 → PNG Blob。走 <img> ＋ canvas，不需要任何外部套件。
// 高度預設等於寬度（分享卡是方的）；神諭卡是 2:3，所以另外傳 h。
export function svgToPng(svg, size = OUT, h = size) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    // 逾時保護：某些瀏覽器遇到不支援的內容會既不 load 也不 error
    const timer = setTimeout(() => reject(new Error('svg_timeout')), 8000);
    img.onload = () => {
      clearTimeout(timer);
      try {
        const c = document.createElement('canvas');
        c.width = size; c.height = h;
        const ctx = c.getContext('2d');
        ctx.drawImage(img, 0, 0, size, h);
        c.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob_null'))), 'image/png');
      } catch (e) { reject(e); }
    };
    img.onerror = () => { clearTimeout(timer); reject(new Error('svg_load_failed')); };
    // 用 encodeURIComponent 而不是 btoa：btoa 遇到中文會直接丟例外
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  });
}

// 純下載。牌卡頁把「下載」與「分享」分成兩顆按鈕，所以要能單獨呼叫。
export function downloadPng(blob, fileName) {
  const href = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = href; a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(href), 4000);
}

// 分享（或退回下載）。回傳 'shared' | 'downloaded'，讓呼叫端決定提示什麼。
export async function shareCardPng(blob, { fileName, title, text, url }) {
  const file = new File([blob], fileName, { type: 'image/png' });
  // Web Share Level 2：手機瀏覽器可以直接把圖丟進 IG／Threads／LINE。
  // canShare 一定要先問——沒問就 share 的話，不支援檔案的平台會直接丟例外。
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    // 刻意不同時帶 url：部分平台看到 url 就只取連結、把圖丟掉
    await navigator.share({ files: [file], title, text });
    return 'shared';
  }
  // 不能分享檔案、但能分享文字時，至少把文字送出去（牌卡的解讀本身就有價值）。
  // 注意：能不能同時保留文字要看接收端——多數社群平台收到圖片就會丟掉文字。
  if (navigator.share) {
    await navigator.share({ title, text });
    return 'shared';
  }
  downloadPng(blob, fileName);
  return 'downloaded';
}
