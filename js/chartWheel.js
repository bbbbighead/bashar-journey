// chartWheel.js — 把 api/astro.py 算出的本命盤畫成星盤輪（inline SVG，零圖檔）。
//
// 座標：黃經 L 對到螢幕角度 A = 180 + (L − 上升點黃經)，SVG 的 y 向下所以取負。
// 這組換算給出的正是傳統擺法——上升點在左側水平、天頂在正上方、宮位逆時針走。
// 沒有上升點時（出生時間不確定）改以 0° 牡羊為左側水平的固定盤。
//
// 出生時間不確定時後端不輸出宮位與四軸（api/astro.py 的 cusps = None），
// 這裡就只畫黃道環、行星與相位，不畫宮位線也不畫上升軸——用猜的正午反推
// 宮位，畫出來幾乎是隨機的，比不畫更誤導。

import { SIGN_GLYPH, SIGN_NAMES, POINT_GLYPH, MAIN_TEN } from '../data/astroGlyphs.js';

const SIZE = 400;
const C = SIZE / 2;
// 四軸文字標在環外（R_OUT + 11），會超出 0–400 的範圍而壓到外框，
// 所以 viewBox 往外留一圈邊界，半徑常數就不必跟著改。
const MARGIN = 18;
const R_OUT = 192;        // 黃道環外緣
const R_SIGN_IN = 160;    // 黃道環內緣
const R_SIGN_TXT = 176;   // 星座字符
const R_TICK_OUT = 160;   // 行星刻度線外端
const R_TICK_IN = 150;
const R_PLANET = 136;     // 行星符號基準半徑
const R_ASPECT = 116;     // 相位線所在圓
const R_HOUSE_TXT = 126;  // 宮位編號

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
let glyphCache = null;

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

function buildGlyphSupport(fontFamily) {
  const out = {};
  try {
    const cv = document.createElement('canvas');
    cv.width = CV_W; cv.height = CV_H;
    const ctx = cv.getContext('2d');
    if (!ctx) return out;
    ctx.font = `28px ${fontFamily}`;
    ctx.fillStyle = '#fff';
    // 兩個保證沒有字形的碼位（Unicode 未定義、私用區）＝豆腐框的樣子
    const t1 = alphaHash(ctx, '￿');
    const t2 = alphaHash(ctx, '\u{F0000}');
    // 兩個缺字若畫出來不一樣，說明這個環境的 getImageData 不可信
    // （例如瀏覽器的指紋防護會加雜訊）——這時一律當作有字符。
    const reliable = t1.h === t2.h;
    Object.keys(POINT_GLYPH).forEach((name) => {
      const g = POINT_GLYPH[name].glyph;
      if (!g) { out[name] = false; return; }
      if (!reliable) { out[name] = true; return; }
      // 量的字串必須跟實際畫的一致（含文字表現選擇器），否則結論對不上
      const r = alphaHash(ctx, asText(g));
      // 與豆腐框畫得一樣，或根本沒畫出東西，就是缺字
      out[name] = r.ink > 0 && r.h !== t1.h;
    });
  } catch {
    // 偵測本身失敗：一律用字符。主要行星的符號支援度本來就好，
    // 為了保險把全部降成縮寫反而讓常見情況變醜。
    Object.keys(POINT_GLYPH).forEach((name) => { out[name] = !!POINT_GLYPH[name].glyph; });
  }
  return out;
}
function glyphSupport() {
  if (glyphCache) return glyphCache;
  // 必須量 CSS 實際用來畫符號的那組字型（--symbol），量錯字型結論就是錯的
  const font = getComputedStyle(document.documentElement).getPropertyValue('--symbol').trim()
    || 'sans-serif';
  glyphCache = buildGlyphSupport(font);
  return glyphCache;
}
// 供除錯與字型稽核用：回傳每個符號在這台裝置上畫不畫得出來
export function glyphAudit() {
  const sup = glyphSupport();
  return Object.keys(POINT_GLYPH).map((name) => ({
    name,
    glyph: POINT_GLYPH[name].glyph,
    code: POINT_GLYPH[name].glyph
      ? 'U+' + POINT_GLYPH[name].glyph.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')
      : '',
    abbr: POINT_GLYPH[name].abbr,
    supported: !!sup[name],
    used: sup[name] ? POINT_GLYPH[name].glyph : POINT_GLYPH[name].abbr,
  }));
}

// 該點位實際畫出來的字：字符畫不出來就退回拉丁縮寫
function pointMark(name) {
  const def = POINT_GLYPH[name];
  if (!def) return { text: name.slice(0, 2), isAbbr: true };
  if (!def.glyph) return { text: def.abbr, isAbbr: true };
  return glyphSupport()[name]
    ? { text: asText(def.glyph), isAbbr: false }
    : { text: def.abbr, isAbbr: true };
}

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

// 同一個位置擠了好幾顆星時，把後來的往內推一階，符號才不會疊在一起。
// minGapDeg 是這樣算出來的：符號約 15px 寬，行星圈在手機上半徑約 110px，
// 要隔開 16px 弧長需要 16/110 弧度 ≈ 8.4°，取 10° 留餘裕。
function layoutPlanets(points, minGapDeg = 10, stepPx = 17) {
  const sorted = points.slice().sort((a, b) => a.lon - b.lon);
  const placed = [];
  sorted.forEach((p) => {
    let level = 0;
    // 同一層裡有太近的就再往內一層
    while (level <= 3
      && placed.some((q) => q.level === level && sepDeg(p.lon, q.lon) < minGapDeg)) {
      level += 1;
    }
    placed.push({ ...p, level: Math.min(level, 3), r: R_PLANET - Math.min(level, 3) * stepPx });
  });
  return placed;
}

// ---- 各層 ----
function zodiacRing(proj) {
  let out = `<circle cx="${C}" cy="${C}" r="${R_OUT}" class="cw-ring"/>`
    + `<circle cx="${C}" cy="${C}" r="${R_SIGN_IN}" class="cw-ring"/>`;
  for (let i = 0; i < 12; i++) {
    const lon = i * 30;
    const [x1, y1] = proj(lon, R_SIGN_IN);
    const [x2, y2] = proj(lon, R_OUT);
    out += `<line x1="${r1(x1)}" y1="${r1(y1)}" x2="${r1(x2)}" y2="${r1(y2)}" class="cw-ring"/>`;
    const sign = SIGN_NAMES[i];
    const [tx, ty] = proj(lon + 15, R_SIGN_TXT);
    out += `<text x="${r1(tx)}" y="${r1(ty)}" class="cw-sign">${esc(asText(SIGN_GLYPH[sign]))}</text>`;
  }
  return out;
}

function houseLayer(proj, houses, axisLons) {
  if (!houses || !houses.length) return '';
  let out = '';
  houses.forEach((h, i) => {
    if (typeof h.cuspLon !== 'number') return;
    // 四軸（1、4、7、10 宮頭）畫粗一點，它們是盤面的骨架
    const strong = [0, 3, 6, 9].includes(i);
    const [x1, y1] = proj(h.cuspLon, R_ASPECT);
    const [x2, y2] = proj(h.cuspLon, R_SIGN_IN);
    out += `<line x1="${r1(x1)}" y1="${r1(y1)}" x2="${r1(x2)}" y2="${r1(y2)}"
      class="${strong ? 'cw-axis' : 'cw-cusp'}"/>`;
    // 宮位編號放在該宮的中間
    const next = houses[(i + 1) % 12];
    if (typeof next.cuspLon === 'number') {
      const span = ((next.cuspLon - h.cuspLon) + 360) % 360;
      const [nx, ny] = proj(h.cuspLon + span / 2, R_HOUSE_TXT);
      out += `<text x="${r1(nx)}" y="${r1(ny)}" class="cw-house">${h.house}</text>`;
    }
  });
  // 四軸的文字標示（ASC／MC…）貼在環外
  Object.keys(axisLons).forEach((name) => {
    const [x, y] = proj(axisLons[name], R_OUT + 11);
    out += `<text x="${r1(x)}" y="${r1(y)}" class="cw-axis-label">${esc(pointMark(name).text)}</text>`;
  });
  return out;
}

// 相位線只取十顆主星之間的主相位，且不畫合相（線長為零看不出來）
function aspectLayer(proj, aspects, byName) {
  if (!Array.isArray(aspects)) return '';
  let out = `<circle cx="${C}" cy="${C}" r="${R_ASPECT}" class="cw-ring"/>`;
  aspects.forEach((t) => {
    if (!t.major || t.angle === 0) return;
    if (!MAIN_TEN.includes(t.a) || !MAIN_TEN.includes(t.b)) return;
    const pa = byName[t.a]; const pb = byName[t.b];
    if (!pa || !pb) return;
    const [x1, y1] = proj(pa.lon, R_ASPECT);
    const [x2, y2] = proj(pb.lon, R_ASPECT);
    const hard = t.angle === 90 || t.angle === 180;
    // 越緊密的相位畫得越明顯（orbDeg 已由後端算好）
    const op = Math.max(0.22, 0.75 - (Number(t.orbDeg) || 0) * 0.07);
    out += `<line x1="${r1(x1)}" y1="${r1(y1)}" x2="${r1(x2)}" y2="${r1(y2)}"
      class="${hard ? 'cw-asp-hard' : 'cw-asp-soft'}" style="opacity:${r1(op * 100) / 100}"/>`;
  });
  return out;
}

function planetLayer(proj, placed) {
  let out = '';
  placed.forEach((p) => {
    const [tx, ty] = proj(p.lon, R_TICK_OUT);
    const [ix, iy] = proj(p.lon, R_TICK_IN);
    out += `<line x1="${r1(tx)}" y1="${r1(ty)}" x2="${r1(ix)}" y2="${r1(iy)}" class="cw-tick"/>`;
    const mark = pointMark(p.name);
    const [px, py] = proj(p.lon, p.r);
    out += `<text x="${r1(px)}" y="${r1(py)}"
      class="cw-planet${mark.isAbbr ? ' cw-abbr' : ''}">${esc(mark.text)}</text>`;
    if (p.retrograde) {
      const [rx, ry] = proj(p.lon, p.r - 11);
      out += `<text x="${r1(rx)}" y="${r1(ry)}" class="cw-retro">R</text>`;
    }
  });
  return out;
}

// ---- 對外 ----
// chart：/api/astro 回傳的 chart 物件。labels：該語系的文案（title、aria、approxNote…）
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

  const axisNames = ['上升點', '下降點', '天頂', '天底'];
  const axisLons = {};
  if (!approx) {
    axisNames.forEach((n) => { if (byName[n]) axisLons[n] = byName[n].lon; });
  }

  // 盤面上畫的點：四軸另外標，Vertex 與福點在手機上太擠，略去不畫
  const skip = new Set([...axisNames, 'Vertex', '福點']);
  const drawable = points.filter((p) => !skip.has(p.name) && typeof p.lon === 'number');
  const placed = layoutPlanets(drawable);

  const svg = `<svg viewBox="${-MARGIN} ${-MARGIN} ${SIZE + MARGIN * 2} ${SIZE + MARGIN * 2}"
    role="img" aria-label="${esc(labels.aria || '')}">
    ${zodiacRing(proj)}
    ${approx ? '' : houseLayer(proj, houses, axisLons)}
    ${aspectLayer(proj, chart.aspects, byName)}
    ${planetLayer(proj, placed)}
  </svg>`;

  const note = approx && labels.approxNote
    ? `<p class="cw-note">${esc(labels.approxNote)}</p>` : '';
  return `<figure class="cw-wrap">
    <div class="cw-canvas">${svg}</div>
    ${note}
  </figure>`;
}
