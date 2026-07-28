// chartWheel.js — 把 api/astro.py 算出的本命盤畫成星盤輪（inline SVG，零圖檔）。
//
// 座標：黃經 L 對到螢幕角度 A = 180 + (L − 上升點黃經)，SVG 的 y 向下所以取負。
// 這組換算給出的正是傳統擺法——上升點在左側水平、天頂在正上方、宮位逆時針走。
// 沒有上升點時（出生時間不確定）改以 0° 牡羊為左側水平的固定盤。
//
// 出生時間不確定時後端不輸出宮位與四軸（api/astro.py 的 cusps = None），
// 這裡就只畫黃道環、行星與相位，不畫宮位線也不畫上升軸——用猜的正午反推
// 宮位，畫出來幾乎是隨機的，比不畫更誤導。
//
// 圖層由外而內：
//   黃道環（星座字符）→ 1°/5°/10° 刻度 → 宮頭度數（環外）→ 行星符號與度數
//   → 宮位線與宮位編號 → 相位線
// 符號位置會沿圓周推開避免重疊，但度數不會騙人：每個符號都有一條指示線
// 連回它真正的度數刻度。
//
// 密度是刻意的：對齊專業星盤軟體（Astro Gold 等）的資訊量。手機上看不清的
// 部分交給 js/chartZoom.js 的放大檢視，而不是靠減少內容來遷就螢幕。

import {
  SIGN_GLYPH, SIGN_NAMES, POINT_GLYPH, MAIN_TEN, ASPECT_AXES, ASPECT_META, ASPECT_ORDER,
} from '../data/astroGlyphs.js';

const SIZE = 600;
const C = SIZE / 2;
// 宮頭度數（含四軸名稱，如「ASC 26♎07」）畫在黃道環外，會超出 0–600 的範圍，
// 所以 viewBox 往外留一圈。64 是實測值：最長的那行是四軸的「MC 0♑10」。
const MARGIN = 64;
const R_OUT = 288;        // 黃道環外緣
const R_SIGN_IN = 250;    // 黃道環內緣
const R_SIGN_TXT = 269;   // 星座字符
const R_G1 = 244;         // 1° 刻度內端
const R_G5 = 239;         // 5° 刻度內端
const R_G10 = 232;        // 10° 刻度內端
const R_BODY_TICK = 228;  // 行星真實度數的刻度內端（比 1° 格線長）
const R_POINT_IN = 224;   // 指示線靠內的一端
const R_PLANET = 210;     // 行星符號所在圓
const R_DEG_TXT = 196;    // 度數文字的起點（往圓心方向書寫）
const R_INNER = 162;      // 內圈：宮位線終點
const R_HOUSE_TXT = 150;  // 宮位編號
const R_ASPECT = 144;     // 相位線所在圓
const R_CUSP_TXT = R_OUT + 5;   // 宮頭度數（環外，往外書寫）

// 1／4／7／10 宮頭就是四軸。名稱併進宮頭度數那一行（見 houseLayer）。
const AXIS_OF_CUSP = { 0: '上升點', 3: '天底', 6: '下降點', 9: '天頂' };

// 「可以點開放大」的角標。畫成 SVG 而不是用字元：⌕（U+2315）在不少字型裡缺字或
// 長得不像放大鏡，🔍 又是彩色 emoji，會把整張盤的金色語言破掉。
const ZOOM_ICON = `<span class="cw-zoom-badge" aria-hidden="true">
  <svg viewBox="0 0 20 20"><circle cx="8.5" cy="8.5" r="5.2"/><path d="M12.4 12.4 L17 17"/></svg>
</span>`;

// 文字表現選擇器（U+FE0E）。♈–♓ 與 ♀♂ 這些碼位有 emoji 表現形式，不加這個
// 就會被畫成彩色 emoji（實測在容器裡星座全變成彩色圓圈），整張盤的金色語言就毀了。
// 對沒有 emoji 形式的字元加上它是無害的，所以一律加。
const VS_TEXT = '︎';
const asText = (ch) => (ch ? ch + VS_TEXT : ch);

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');
const r1 = (n) => Math.round(n * 10) / 10;

// ---- 缺字偵測 ----
// 在使用者自己的裝置上判斷符號畫不畫得出來，不依賴開發機裝了哪些字型。
//
// 不能用「量字寬跟豆腐框比對」：符號字型裡 ♀♂☿♃♄ 這類字的前進寬度常常剛好
// 等於豆腐框寬度，會把畫得出來的字誤判成缺字（實測就踩到了）。所以改成
// 把字畫進 canvas、比對點陣：真的缺字時畫出來的像素會跟豆腐框一模一樣。
const CV_W = 40;
const CV_H = 40;

function alphaHash(ctx, ch) {
  ctx.clearRect(0, 0, CV_W, CV_H);
  ctx.fillText(ch, 2, CV_H - 8);
  const d = ctx.getImageData(0, 0, CV_W, CV_H).data;
  let h = 5381;
  let ink = 0;
  for (let i = 3; i < d.length; i += 4) {   // 只看 alpha 通道
    h = (((h * 33) ^ d[i]) >>> 0);
    if (d[i]) ink += 1;
  }
  return { h, ink };
}

// 豆腐框基準。建立一次就重複用——點位符號、相位符號都靠它判斷。
let tofu;
function tofuBase() {
  if (tofu !== undefined) return tofu;
  tofu = null;
  try {
    // 必須量 CSS 實際用來畫符號的那組字型（--symbol），量錯字型結論就是錯的
    const font = getComputedStyle(document.documentElement).getPropertyValue('--symbol').trim()
      || 'sans-serif';
    const cv = document.createElement('canvas');
    cv.width = CV_W; cv.height = CV_H;
    const ctx = cv.getContext('2d');
    if (!ctx) return tofu;
    ctx.font = `28px ${font}`;
    ctx.fillStyle = '#fff';
    // 兩個保證沒有字形的碼位（Unicode 未定義、私用區）＝豆腐框的樣子
    const t1 = alphaHash(ctx, '￿');
    const t2 = alphaHash(ctx, '\u{F0000}');
    // 兩個缺字若畫出來不一樣，說明這個環境的 getImageData 不可信
    // （例如瀏覽器的指紋防護會加雜訊）——這時一律當作有字符。
    tofu = { ctx, hash: t1.h, reliable: t1.h === t2.h };
  } catch {
    tofu = null;
  }
  return tofu;
}

const charCache = new Map();
// 這個字元在這台裝置上畫得出來嗎？偵測失敗時一律回 true：主要符號的支援度
// 本來就好，為了保險把全部降成縮寫反而讓常見情況變醜。
function charSupported(ch) {
  if (!ch) return false;
  if (charCache.has(ch)) return charCache.get(ch);
  const t = tofuBase();
  let ok = true;
  if (t && t.reliable) {
    // 量的字串必須跟實際畫的一致（含文字表現選擇器），否則結論對不上
    const r = alphaHash(t.ctx, asText(ch));
    ok = r.ink > 0 && r.h !== t.hash;
  }
  charCache.set(ch, ok);
  return ok;
}

// 供除錯與字型稽核用：回傳每個符號在這台裝置上畫不畫得出來
export function glyphAudit() {
  const rows = Object.keys(POINT_GLYPH).map((name) => ({ kind: 'point', name, ...POINT_GLYPH[name] }));
  ASPECT_ORDER.forEach((a) => rows.push({ kind: 'aspect', name: `${a}°`, ...ASPECT_META[a] }));
  return rows.map((r) => ({
    kind: r.kind,
    name: r.name,
    glyph: r.glyph,
    code: r.glyph ? `U+${r.glyph.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}` : '',
    abbr: r.abbr,
    supported: !!r.glyph && charSupported(r.glyph),
    used: (r.glyph && charSupported(r.glyph)) ? r.glyph : r.abbr,
  }));
}

// 該點位／相位實際畫出來的字：字符畫不出來就退回拉丁縮寫
function markOf(def, fallback) {
  if (!def) return { text: String(fallback || '').slice(0, 2), isAbbr: true };
  if (!def.glyph) return { text: def.abbr, isAbbr: true };
  return charSupported(def.glyph)
    ? { text: asText(def.glyph), isAbbr: false }
    : { text: def.abbr, isAbbr: true };
}
const pointMark = (name) => markOf(POINT_GLYPH[name], name);
const aspectMark = (angle) => markOf(ASPECT_META[angle], `${angle}`);

// ---- 幾何 ----
function makeProject(ascLon) {
  return (lon, r) => {
    const a = (180 + (lon - ascLon)) * Math.PI / 180;
    return [C + r * Math.cos(a), C - r * Math.sin(a)];
  };
}

// 兩個黃經之間的夾角（0–180）
function sepDeg(a, b) {
  const d = (((a - b) % 360) + 360) % 360;
  return d > 180 ? 360 - d : d;
}

// 同一段黃道擠了好幾個點時，把符號沿著圓周推開，符號才不會疊在一起。
// 這是專業星盤軟體的做法：符號的位置可以挪，度數不能騙——所以每個挪過的
// 符號都會有一條指示線連回它真正的度數刻度（見 bodyLayer）。
//
// minGapDeg 是這樣算出來的：符號約 19px 寬，行星圈半徑 210，要隔開 21px 弧長
// 需要 21/210 弧度 ≈ 5.7°，取 8° 留餘裕。
function spreadAngles(items, minGapDeg = 8) {
  const n = items.length;
  if (!n) return [];
  const order = items.slice().sort((a, b) => a.lon - b.lon);
  const disp = order.map((p) => p.lon);
  // 全部點需要的角度超過一圈就沒得推（20 點 × 8° = 160°，實務上不會發生）
  if (n * minGapDeg < 360) {
    for (let pass = 0; pass < 200; pass++) {
      let moved = false;
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        const gap = (((disp[j] - disp[i]) % 360) + 360) % 360;
        if (gap < minGapDeg - 1e-6) {
          const push = (minGapDeg - gap) / 2;
          disp[i] -= push;
          disp[j] += push;
          moved = true;
        }
      }
      if (!moved) break;
    }
  }
  return order.map((p, i) => ({ ...p, disp: ((disp[i] % 360) + 360) % 360 }));
}

// 沿半徑方向書寫的小字（度數、宮頭度數）。左半邊要翻 180°，否則字是上下顛倒的。
// outward=true 往圓外長，false 往圓心長。
function radialText(ascLon, lon, r, str, cls, outward) {
  const scr = 180 + (lon - ascLon);       // 螢幕角度（數學慣例：逆時針、y 向上）
  const rad = scr * Math.PI / 180;
  const x = C + r * Math.cos(rad);
  const y = C - r * Math.sin(rad);
  // SVG 的旋轉是順時針（y 向下）所以取負；往圓心書寫時再轉 180°
  let rot = -scr + (outward ? 0 : 180);
  rot = (((rot + 180) % 360) + 360) % 360 - 180;
  let anchor = 'start';
  if (rot > 90 || rot < -90) { rot += 180; anchor = 'end'; }
  return `<text x="${r1(x)}" y="${r1(y)}" class="${cls}" style="text-anchor:${anchor}"
    transform="rotate(${r1(rot)} ${r1(x)} ${r1(y)})">${esc(str)}</text>`;
}

// 黃經 → 「23♊54」。星座字符缺字時退回三個字母的拉丁縮寫。
const SIGN_ABBR = ['Ar', 'Ta', 'Ge', 'Cn', 'Le', 'Vi', 'Li', 'Sc', 'Sg', 'Cp', 'Aq', 'Pi'];
function degLabel(lon) {
  const l = ((lon % 360) + 360) % 360;
  const si = Math.floor(l / 30);
  const within = l - si * 30;
  const d = Math.floor(within);
  let m = Math.round((within - d) * 60);
  let dd = d;
  if (m === 60) { m = 0; dd += 1; }       // 分進位，否則會印出「23°60」
  const g = SIGN_GLYPH[SIGN_NAMES[si]];
  const sign = charSupported(g) ? asText(g) : SIGN_ABBR[si];
  return `${dd}${sign}${String(m).padStart(2, '0')}`;
}

// ---- 各層 ----

// 黃道環：外緣、內緣、12 個星座分界與字符
function zodiacRing(proj) {
  let out = `<circle cx="${C}" cy="${C}" r="${R_OUT}" class="cw-ring"/>`
    + `<circle cx="${C}" cy="${C}" r="${R_SIGN_IN}" class="cw-ring"/>`;
  for (let i = 0; i < 12; i++) {
    const lon = i * 30;
    const [x1, y1] = proj(lon, R_SIGN_IN);
    const [x2, y2] = proj(lon, R_OUT);
    out += `<line x1="${r1(x1)}" y1="${r1(y1)}" x2="${r1(x2)}" y2="${r1(y2)}" class="cw-ring"/>`;
    const [tx, ty] = proj(lon + 15, R_SIGN_TXT);
    const g = SIGN_GLYPH[SIGN_NAMES[i]];
    const txt = charSupported(g) ? asText(g) : SIGN_ABBR[i];
    out += `<text x="${r1(tx)}" y="${r1(ty)}" class="cw-sign">${esc(txt)}</text>`;
  }
  return out;
}

// 度數刻度：每 1° 一格，5° 與 10° 加長。有刻度才讀得出行星落在幾度，
// 也才看得出兩顆星到底是差 1° 還是差 8°。
function graticule(proj) {
  let out = '';
  for (let d = 0; d < 360; d++) {
    const inner = d % 10 === 0 ? R_G10 : (d % 5 === 0 ? R_G5 : R_G1);
    const cls = d % 10 === 0 ? 'cw-g10' : (d % 5 === 0 ? 'cw-g5' : 'cw-g1');
    const [x1, y1] = proj(d, R_SIGN_IN);
    const [x2, y2] = proj(d, inner);
    out += `<line x1="${r1(x1)}" y1="${r1(y1)}" x2="${r1(x2)}" y2="${r1(y2)}" class="${cls}"/>`;
  }
  return out;
}

// 宮位線、宮位編號、宮頭度數、四軸標示
function houseLayer(proj, ascLon, houses) {
  if (!houses || !houses.length) return '';
  let out = '';
  houses.forEach((h, i) => {
    if (typeof h.cuspLon !== 'number') return;
    // 四軸（1、4、7、10 宮頭）畫粗一點，它們是盤面的骨架
    const strong = [0, 3, 6, 9].includes(i);
    const [x1, y1] = proj(h.cuspLon, R_INNER);
    const [x2, y2] = proj(h.cuspLon, R_SIGN_IN);
    out += `<line x1="${r1(x1)}" y1="${r1(y1)}" x2="${r1(x2)}" y2="${r1(y2)}"
      class="${strong ? 'cw-axis' : 'cw-cusp'}"/>`;
    // 宮頭度數畫在環外：畫在環內的話會跟行星度數擠在同一圈。
    // 四軸的名稱併進同一行——分開畫過一版，ASC 與 1 宮頭度數在左側水平方向
    // 一定疊在一起（兩者本來就是同一個度數，各佔一塊位置只會撞車）。
    const axisName = strong ? (AXIS_OF_CUSP[i] || '') : '';
    const label = axisName
      ? `${pointMark(axisName).text} ${degLabel(h.cuspLon)}`
      : degLabel(h.cuspLon);
    out += radialText(ascLon, h.cuspLon, R_CUSP_TXT, label,
      strong ? 'cw-cusp-deg strong' : 'cw-cusp-deg', true);
    // 宮位編號放在該宮的中間
    const next = houses[(i + 1) % 12];
    if (typeof next.cuspLon === 'number') {
      const span = ((next.cuspLon - h.cuspLon) + 360) % 360;
      const [nx, ny] = proj(h.cuspLon + span / 2, R_HOUSE_TXT);
      out += `<text x="${r1(nx)}" y="${r1(ny)}" class="cw-house">${h.house}</text>`;
    }
  });
  return out;
}

// 行星符號、真實度數刻度、指示線、度數文字、逆行標記
function bodyLayer(proj, ascLon, placed) {
  let out = '';
  placed.forEach((p) => {
    // 真實度數的刻度：比 1° 格線長也亮，這是「這顆星在幾度」的唯一憑據
    const [tx, ty] = proj(p.lon, R_SIGN_IN);
    const [ix, iy] = proj(p.lon, R_BODY_TICK);
    out += `<line x1="${r1(tx)}" y1="${r1(ty)}" x2="${r1(ix)}" y2="${r1(iy)}" class="cw-btick"/>`;
    // 符號被推開時，畫一條指示線把它連回真實度數
    if (sepDeg(p.lon, p.disp) > 0.25) {
      const [px, py] = proj(p.disp, R_POINT_IN);
      out += `<line x1="${r1(ix)}" y1="${r1(iy)}" x2="${r1(px)}" y2="${r1(py)}" class="cw-lead"/>`;
    }
    const mark = pointMark(p.name);
    const [gx, gy] = proj(p.disp, R_PLANET);
    const tier = MAIN_TEN.includes(p.name) ? '' : ' cw-minor-body';
    out += `<text x="${r1(gx)}" y="${r1(gy)}"
      class="cw-planet${mark.isAbbr ? ' cw-abbr' : ''}${tier}">${esc(mark.text)}</text>`;
    // 度數往圓心方向書寫。逆行的在後面補一個 R（℞ 的支援度不穩，用 R 保險）
    const label = degLabel(p.lon) + (p.retrograde ? ' R' : '');
    out += radialText(ascLon, p.disp, R_DEG_TXT, label,
      `cw-deg${p.retrograde ? ' retro' : ''}`, false);
  });
  return out;
}

// 相位線。收錄範圍＝盤面上畫得出來的所有點位（含小行星、交點、莉莉絲、
// 福點、Vertex）加上升點與天頂，主相位與次要相位都畫。
//
// 為什麼不只畫十大行星之間的主相位（舊版做法）：那樣會把 52 條主相位濾成
// 16 條，小行星與四軸的符號明明畫在盤上卻永遠沒有線，看起來像漏畫；
// 而且會出現「某顆星一條線都沒有」的假象——實測有一張盤的太陽唯一的主相位
// 是三分上升點，被濾掉之後太陽就孤立在盤上了。
//
// 密度用層級處理而不是用刪除處理：
//   主星之間      → 實線，粗
//   有一端非主星  → 同色但更細更淡
//   次要相位      → 點線，最淡，可用圖例的開關收起（預設收起）
function aspectLayer(proj, aspects, byName, allowed) {
  let out = `<circle cx="${C}" cy="${C}" r="${R_ASPECT}" class="cw-ring"/>`;
  const seen = new Set();
  const stats = new Map();
  if (!Array.isArray(aspects)) return { svg: out, stats };
  aspects.forEach((t) => {
    const meta = ASPECT_META[t.angle];
    if (!meta) return;
    if (!allowed.has(t.a) || !allowed.has(t.b)) return;
    const pa = byName[t.a]; const pb = byName[t.b];
    if (!pa || !pb) return;
    // 同一組兩點只留最緊的一個相位（後端已按 orbDeg 排序，先到的就是最緊的）
    const key = [t.a, t.b].sort().join('|');
    if (seen.has(key)) return;
    seen.add(key);
    stats.set(t.angle, (stats.get(t.angle) || 0) + 1);
    const [x1, y1] = proj(pa.lon, R_ASPECT);
    const [x2, y2] = proj(pb.lon, R_ASPECT);
    const both = MAIN_TEN.includes(t.a) && MAIN_TEN.includes(t.b);
    // 越緊密的相位畫得越明顯（orbDeg 已由後端算好）
    const op = Math.max(0.25, 0.8 - (Number(t.orbDeg) || 0) * 0.06) * (both ? 1 : 0.5);
    const cls = [
      'cw-asp', `cw-asp-${meta.tone}`,
      meta.major ? 'cw-asp-major' : 'cw-asp-aux',
      both ? '' : 'cw-asp-weak',
    ].filter(Boolean).join(' ');
    const dash = meta.dash ? ` stroke-dasharray="${meta.dash}"` : '';
    out += `<line x1="${r1(x1)}" y1="${r1(y1)}" x2="${r1(x2)}" y2="${r1(y2)}"
      class="${cls}"${dash} style="opacity:${r1(op * 100) / 100}"/>`;
  });
  return { svg: out, stats };
}

// 相位圖例：只列這張盤真的有的相位，並附上每種幾條。
// 次要相位給一個開關——預設收起（一次看 70 條線讀不出結構），
// 但開關就擺在眼前，不是藏起來的設定。
function legendHtml(stats, labels) {
  const names = labels.aspect || {};
  const rows = ASPECT_ORDER.filter((a) => stats.get(a));
  if (!rows.length) return '';
  const item = (a) => {
    const meta = ASPECT_META[a];
    const mark = aspectMark(a);
    return `<li class="cw-lg-item cw-lg-${meta.tone}${meta.major ? '' : ' aux'}">
      <span class="cw-lg-mark${mark.isAbbr ? ' abbr' : ''}">${esc(mark.text)}</span>
      <span class="cw-lg-name">${esc(names[a] || `${a}°`)}</span>
      <span class="cw-lg-n">${stats.get(a)}</span>
    </li>`;
  };
  const major = rows.filter((a) => ASPECT_META[a].major);
  const aux = rows.filter((a) => !ASPECT_META[a].major);
  let out = `<ul class="cw-legend">${major.map(item).join('')}</ul>`;
  if (aux.length) {
    out += `<label class="cw-toggle">
      <input type="checkbox" class="cw-minor-chk">
      <span>${esc(labels.showMinor || '')}<span class="cw-toggle-n">${aux.reduce((n, a) => n + stats.get(a), 0)}</span></span>
    </label>
    <ul class="cw-legend aux">${aux.map(item).join('')}</ul>`;
  }
  return `<div class="cw-legend-box">${out}</div>`;
}

// ---- 對外 ----
// chart：/api/astro 回傳的 chart 物件。labels：該語系的文案（aria、approxNote、
// aspect{角度→名稱}、showMinor、zoomHint…）
export function chartWheelSvg(chart, labels = {}) {
  const points = (chart && Array.isArray(chart.points)) ? chart.points : [];
  if (!points.length) return '';
  const houses = (chart.houses && chart.houses.length) ? chart.houses : null;
  const byName = {};
  points.forEach((p) => { byName[p.name] = p; });

  // 出生時間不確定：後端不給四軸，改以 0° 牡羊為左側水平
  const asc = byName['上升點'];
  const approx = !asc || !houses;
  const ascLon = asc ? asc.lon : 0;
  const proj = makeProject(ascLon);

  // 四軸不在行星圈上畫符號：它們有自己的軸線，名稱併在宮頭度數那一行
  const axisNames = ['上升點', '下降點', '天頂', '天底'];

  // 盤面上畫符號的點：四軸另外標（有自己的軸線與名稱），其餘全部畫，
  // 包含小行星、交點、莉莉絲、福點與 Vertex——它們在文字報告裡都列了，
  // 盤上就不該少。擠在一起的問題由 spreadAngles 處理，不靠省略處理。
  const axisSet = new Set(axisNames);
  const drawable = points.filter((p) => !axisSet.has(p.name) && typeof p.lon === 'number');
  const placed = spreadAngles(drawable);

  // 相位收錄的點位：盤上畫得出來的，加上升點與天頂
  const allowed = new Set(drawable.map((p) => p.name));
  if (!approx) ASPECT_AXES.forEach((n) => { if (byName[n]) allowed.add(n); });

  const asp = aspectLayer(proj, chart.aspects, byName, allowed);

  const svg = `<svg viewBox="${-MARGIN} ${-MARGIN} ${SIZE + MARGIN * 2} ${SIZE + MARGIN * 2}"
    role="img" aria-label="${esc(labels.aria || '')}">
    ${zodiacRing(proj)}
    ${graticule(proj)}
    ${approx ? '' : houseLayer(proj, ascLon, houses)}
    ${asp.svg}
    ${bodyLayer(proj, ascLon, placed)}
  </svg>`;

  const note = approx && labels.approxNote
    ? `<p class="cw-note">${esc(labels.approxNote)}</p>` : '';
  return `<figure class="cw-wrap">
    <div class="cw-canvas" role="button" tabindex="0"
      aria-label="${esc(labels.zoomOpen || '')}" title="${esc(labels.zoomOpen || '')}">
      ${svg}
      ${ZOOM_ICON}
    </div>
    <p class="cw-hint">${esc(labels.zoomOpen || '')}</p>
    ${legendHtml(asp.stats, labels)}
    ${note}
  </figure>`;
}
