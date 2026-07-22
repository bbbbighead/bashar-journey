// gensky.mjs — 產生博物館級天文版畫背景（assets/sky.svg）。
// 設計語言：古星圖／星盤／渾儀／天球儀；深海軍藍上舊黃銅雕刻線。
// 決定性種子亂數（可重現）；輸出單一自足 SVG（含內嵌動畫與 reduced-motion）。
import { writeFileSync } from 'node:fs';

// ---- 種子亂數（mulberry32） ----
let seed = 20260722;
function rnd() {
  seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const R = (a, b) => a + rnd() * (b - a);
const RI = (a, b) => Math.floor(R(a, b + 1));
const F = (n, d = 1) => Number(n.toFixed(d));

const GOLD = '#c2a869';
const BRIGHT = '#e3cf96';
const W = 1600, H = 1600;
const out = [];

// ---- 小工具 ----
function circle(cx, cy, r, sw, op, extra = '') {
  return `<circle cx="${F(cx)}" cy="${F(cy)}" r="${F(r)}" stroke-width="${sw}" opacity="${op}"${extra ? ' ' + extra : ''}/>`;
}
// 手工感：部分圓改用兩個微偏移的圓疊出「雕版雙勾線」
function engravedCircle(cx, cy, r, sw, op) {
  return circle(cx, cy, r, sw, op) +
    circle(cx + R(-1.5, 1.5), cy + R(-1.5, 1.5), r + R(-1.2, 1.2), sw * 0.6, op * 0.5);
}
function line(x1, y1, x2, y2, sw, op) {
  return `<line x1="${F(x1)}" y1="${F(y1)}" x2="${F(x2)}" y2="${F(y2)}" stroke-width="${sw}" opacity="${op}"/>`;
}
// 星芒節點（參考照片：radial spike star + 發光核心）
function starburst(cx, cy, r, spikes, op, cls = '') {
  const parts = [`<g${cls ? ` class="${cls}"` : ''} opacity="${op}">`];
  const a0 = R(0, Math.PI);
  for (let i = 0; i < spikes; i++) {
    const a = a0 + (Math.PI * 2 * i) / spikes + R(-0.05, 0.05);
    const r1 = r * R(0.16, 0.24);
    const r2 = r * (i % 2 === 0 ? R(0.85, 1) : R(0.45, 0.65)); // 長短相間
    parts.push(`<line x1="${F(cx + Math.cos(a) * r1)}" y1="${F(cy + Math.sin(a) * r1)}" x2="${F(cx + Math.cos(a) * r2)}" y2="${F(cy + Math.sin(a) * r2)}" stroke-width="${F(Math.max(0.7, r * 0.02), 2)}" opacity=".8"/>`);
  }
  parts.push(`<circle cx="${F(cx)}" cy="${F(cy)}" r="${F(r * 0.16)}" fill="url(#glow)" stroke="none"/>`);
  parts.push(`<circle cx="${F(cx)}" cy="${F(cy)}" r="${F(Math.max(1.4, r * 0.045))}" fill="${BRIGHT}" stroke="none" opacity=".9"/>`);
  parts.push('</g>');
  return parts.join('');
}
// 刻度環：內外圈＋每 step 度一刻、每 major 度一長刻
function graduatedRing(cx, cy, r, sw, op, step = 5, major = 30, tick = 10) {
  const parts = [circle(cx, cy, r, sw, op)];
  for (let d = 0; d < 360; d += step) {
    const a = (d * Math.PI) / 180;
    const len = d % major === 0 ? tick * 1.9 : tick;
    parts.push(`<line x1="${F(cx + Math.cos(a) * r)}" y1="${F(cy + Math.sin(a) * r)}" x2="${F(cx + Math.cos(a) * (r - len))}" y2="${F(cy + Math.sin(a) * (r - len))}" stroke-width="${d % major === 0 ? sw : sw * 0.7}" opacity="${op}"/>`);
  }
  return parts.join('');
}
// 度數標註環
function degreeLabels(cx, cy, r, size, op, every = 30) {
  const parts = [];
  for (let d = 0; d < 360; d += every) {
    const a = ((d - 90) * Math.PI) / 180;
    const x = cx + Math.cos(a) * r, y = cy + Math.sin(a) * r;
    parts.push(`<text x="${F(x)}" y="${F(y)}" font-size="${size}" opacity="${op}" text-anchor="middle" dominant-baseline="middle" transform="rotate(${d} ${F(x)} ${F(y)})">${d}°</text>`);
  }
  return parts.join('');
}
function text(x, y, s, size, op, rot = 0, ls = 3) {
  const tr = rot ? ` transform="rotate(${rot} ${F(x)} ${F(y)})"` : '';
  return `<text x="${F(x)}" y="${F(y)}" font-size="${size}" letter-spacing="${ls}" opacity="${op}"${tr}>${s}</text>`;
}
// 微型儀器圖：小圓＋十字＋斜刻度
function microDiagram(cx, cy, r, op) {
  const a = R(0, Math.PI);
  return `<g opacity="${op}">` +
    circle(cx, cy, r, 0.8, 1) +
    circle(cx, cy, r * 0.55, 0.7, 0.7, 'stroke-dasharray="2 3"') +
    line(cx - r * 1.25, cy, cx + r * 1.25, cy, 0.7, 0.8) +
    line(cx, cy - r * 1.25, cx, cy + r * 1.25, 0.7, 0.8) +
    line(cx + Math.cos(a) * r * 0.2, cy + Math.sin(a) * r * 0.2, cx + Math.cos(a) * r, cy + Math.sin(a) * r, 0.7, 0.9) +
    `<circle cx="${F(cx)}" cy="${F(cy)}" r="1.3" fill="${GOLD}" stroke="none" opacity=".9"/></g>`;
}
// 星座網絡：節點折線＋星點
function constellation(pts, sw, op) {
  const parts = [`<g opacity="${op}">`];
  parts.push(`<polyline points="${pts.map(([x, y]) => `${F(x)},${F(y)}`).join(' ')}" stroke-width="${sw}" fill="none" opacity=".75"/>`);
  for (const [x, y] of pts) {
    const r = R(1.3, 2.6);
    parts.push(`<circle cx="${F(x)}" cy="${F(y)}" r="${F(r)}" fill="${BRIGHT}" stroke="none" opacity="${F(R(0.6, 0.95), 2)}"/>`);
    if (rnd() < 0.35) parts.push(circle(x, y, r + R(2.5, 4), 0.7, 0.5));
  }
  parts.push('</g>');
  return parts.join('');
}

// ================= 組成 =================
out.push(`<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" fill="none" stroke="${GOLD}" font-family="Georgia, 'Times New Roman', serif" fill-rule="evenodd">`);
out.push(`<defs>
<radialGradient id="glow"><stop offset="0%" stop-color="${BRIGHT}" stop-opacity=".85"/><stop offset="45%" stop-color="${BRIGHT}" stop-opacity=".25"/><stop offset="100%" stop-color="${BRIGHT}" stop-opacity="0"/></radialGradient>
<filter id="grain" x="0" y="0" width="100%" height="100%"><feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" stitchTiles="stitch"/><feColorMatrix type="matrix" values="0 0 0 0 0.76  0 0 0 0 0.66  0 0 0 0 0.41  0 0 0 0.055 0"/></filter>
<filter id="soft" x="-40%" y="-40%" width="180%" height="180%"><feGaussianBlur stdDeviation="5"/></filter>
</defs>
<style>
.rot-a{transform-origin:470px 1120px;animation:rot 540s linear infinite}
.rot-b{transform-origin:1150px 420px;animation:rot 780s linear infinite reverse}
.tw{animation:tw 9s ease-in-out infinite}
.tw:nth-of-type(2n){animation-delay:3.1s}.tw:nth-of-type(3n){animation-delay:6.2s;animation-duration:12s}
@keyframes rot{to{transform:rotate(360deg)}}
@keyframes tw{50%{opacity:.12}}
@media (prefers-reduced-motion: reduce){.rot-a,.rot-b,.tw{animation:none}}
</style>`);

// ---- L1 遠景：滿版星野＋座標網 ----
out.push('<g>');
// 天球座標網：全版淡赤經弧線與赤緯弧
for (let i = 1; i <= 5; i++) {
  out.push(`<path d="M ${F(-200 + i * 120)} -100 Q ${F(W / 2)} ${F(H * 0.30 + i * 150)} ${F(W + 200 - i * 90)} ${H + 100}" stroke-width="0.8" opacity="0.07" fill="none"/>`);
}
for (let i = 1; i <= 4; i++) {
  out.push(`<path d="M -100 ${F(i * 300)} Q ${F(W / 2)} ${F(i * 300 - 130)} ${F(W + 100)} ${F(i * 320)}" stroke-width="0.8" opacity="0.07" fill="none"/>`);
}
// 星野
for (let i = 0; i < 240; i++) {
  const x = R(0, W), y = R(0, H), r = R(0.6, 1.9);
  const cls = rnd() < 0.16 ? ' class="tw"' : '';
  out.push(`<circle${cls} cx="${F(x)}" cy="${F(y)}" r="${F(r)}" fill="${rnd() < 0.3 ? BRIGHT : GOLD}" stroke="none" opacity="${F(R(0.1, 0.42), 2)}"/>`);
}
out.push('</g>');

// ---- L2 主焦點：星盤（astrolabe）系統 @ (620,1000)，延伸出畫面 ----
const FX = 470, FY = 1120;
out.push('<g>');
// 巨大外環（延伸出畫面）
out.push(engravedCircle(FX, FY, 880, 1.1, 0.10));
out.push(circle(FX, FY, 810, 0.9, 0.08, 'stroke-dasharray="3 9"'));
// 黃道十二分度環（雙圈＋12 分隔＋刻度＋度數）
out.push(graduatedRing(FX, FY, 640, 1.0, 0.16, 5, 30, 14));
out.push(circle(FX, FY, 585, 1.0, 0.15));
for (let d = 0; d < 360; d += 30) {
  const a = (d * Math.PI) / 180;
  out.push(line(FX + Math.cos(a) * 585, FY + Math.sin(a) * 585, FX + Math.cos(a) * 640, FY + Math.sin(a) * 640, 0.9, 0.16));
}
out.push(`<g fill="${GOLD}" stroke="none">${degreeLabels(FX, FY, 612, 13, 0.30)}</g>`);
// 內部同心結構
out.push(engravedCircle(FX, FY, 470, 1.1, 0.15));
out.push(circle(FX, FY, 405, 0.9, 0.12, 'stroke-dasharray="1.5 7"'));
out.push(graduatedRing(FX, FY, 330, 0.9, 0.14, 10, 90, 9));
out.push(circle(FX, FY, 210, 1.0, 0.14));
out.push(circle(FX, FY, 120, 0.9, 0.13));
// 神聖幾何：內接六邊形＋三角
const hex = [], tri = [];
for (let i = 0; i < 6; i++) { const a = (Math.PI / 3) * i - Math.PI / 2; hex.push(`${F(FX + Math.cos(a) * 330)},${F(FY + Math.sin(a) * 330)}`); }
for (let i = 0; i < 3; i++) { const a = ((Math.PI * 2) / 3) * i - Math.PI / 2; tri.push(`${F(FX + Math.cos(a) * 210)},${F(FY + Math.sin(a) * 210)}`); }
out.push(`<polygon points="${hex.join(' ')}" stroke-width="0.9" opacity="0.10"/>`);
out.push(`<polygon points="${tri.join(' ')}" stroke-width="0.8" opacity="0.09"/>`);
// 傾斜軌道橢圓（行星軌道系統）＋軌道上的行星點
for (const [rx, ry, rot, op] of [[520, 190, -18, 0.14], [430, 300, 22, 0.10], [700, 240, -34, 0.08]]) {
  out.push(`<ellipse cx="${FX}" cy="${FY}" rx="${rx}" ry="${ry}" stroke-width="0.9" opacity="${op}" transform="rotate(${rot} ${FX} ${FY})"/>`);
}
out.push(`<circle cx="${F(FX + 505)}" cy="${F(FY - 62)}" r="4" fill="${BRIGHT}" stroke="none" opacity=".5"/>`);
out.push(`<circle cx="${F(FX + 505)}" cy="${F(FY - 62)}" r="9" stroke-width="0.8" opacity=".3"/>`);
// 焦點大星芒（畫面主角，如參考照片）
out.push(starburst(FX, FY, 110, 16, 0.75));
// 旋轉層 A：外圈緩慢自轉的刻度環＋標記
out.push(`<g class="rot-a">${circle(FX, FY, 730, 0.9, 0.12, 'stroke-dasharray="30 14 4 14"')}<circle cx="${F(FX + 730)}" cy="${FY}" r="5" stroke-width="1" opacity=".35"/><circle cx="${F(FX - 730)}" cy="${FY}" r="3" fill="${GOLD}" stroke="none" opacity=".3"/></g>`);
out.push('</g>');

// ---- L3 次焦點：天球儀／渾儀 @ (1150,420) ----
const GX = 1150, GY = 420, GR = 260;
out.push('<g>');
out.push(engravedCircle(GX, GY, GR, 1.1, 0.16));
// 經線（子午圈組）
for (const k of [0.28, 0.55, 0.8]) {
  out.push(`<ellipse cx="${GX}" cy="${GY}" rx="${F(GR * k)}" ry="${GR}" stroke-width="0.9" opacity="0.13"/>`);
}
// 緯線（平行圈）
for (const t of [-0.62, -0.3, 0, 0.3, 0.62]) {
  const ry = GR * 0.30 * Math.sqrt(1 - t * t);
  out.push(`<ellipse cx="${GX}" cy="${F(GY + GR * t)}" rx="${F(GR * Math.sqrt(1 - t * t))}" ry="${F(ry)}" stroke-width="0.9" opacity="${t === 0 ? 0.18 : 0.11}"/>`);
}
// 黃道斜環（渾儀特徵）＋支架軸線
out.push(`<ellipse cx="${GX}" cy="${GY}" rx="${F(GR * 1.28)}" ry="${F(GR * 0.42)}" stroke-width="1.1" opacity="0.17" transform="rotate(-23.4 ${GX} ${GY})"/>`);
out.push(graduatedRing(GX, GY, GR * 1.42, 0.9, 0.11, 6, 30, 9));
out.push(line(GX - GR * 1.6, GY + GR * 0.72, GX + GR * 1.6, GY - GR * 0.72, 0.9, 0.10));
out.push(`<circle cx="${GX}" cy="${GY}" r="3.5" fill="${GOLD}" stroke="none" opacity=".5"/>`);
// 旋轉層 B（反向極慢）
out.push(`<g class="rot-b">${circle(GX, GY, GR * 1.2, 0.8, 0.10, 'stroke-dasharray="2 8"')}<circle cx="${F(GX + GR * 1.2)}" cy="${GY}" r="3.5" fill="${BRIGHT}" stroke="none" opacity=".4"/></g>`);
out.push('</g>');

// ---- L4 第三系統：小型渾天環 @ (330,300) ----
out.push('<g>');
out.push(graduatedRing(330, 300, 150, 0.9, 0.13, 10, 90, 8));
out.push(circle(330, 300, 110, 0.8, 0.11, 'stroke-dasharray="1.5 6"'));
out.push(`<ellipse cx="330" cy="300" rx="196" ry="64" stroke-width="0.9" opacity="0.12" transform="rotate(28 330 300)"/>`);
out.push(starburst(330, 300, 46, 12, 0.5));
out.push('</g>');

// ---- L5 星座網絡（參考照片的節點連線） ----
out.push(constellation([[930, 1160], [1030, 1105], [1120, 1150], [1210, 1090], [1330, 1130], [1420, 1060]], 0.9, 0.5));
out.push(constellation([[180, 760], [260, 700], [345, 745], [415, 680], [500, 705]], 0.9, 0.45));
out.push(constellation([[620, 180], [710, 230], [800, 195], [860, 280], [960, 255]], 0.9, 0.42));
out.push(constellation([[1360, 780], [1430, 850], [1520, 815], [1580, 900]], 0.9, 0.4));
out.push(constellation([[120, 1250], [210, 1310], [300, 1270], [360, 1360]], 0.9, 0.42));

// ---- L6 散落的星芒節點（大小混合，強化景深） ----
for (const [x, y, r, s] of [[1420, 200, 58, 12], [240, 980, 40, 10], [1500, 1290, 66, 14], [880, 640, 34, 10], [90, 480, 30, 8], [1290, 950, 26, 8], [740, 1420, 48, 12], [1060, 130, 30, 8]]) {
  out.push(starburst(x, y, r, s, R(0.4, 0.6)));
}
// 前景失焦星芒（bokeh 景深層）
out.push(`<g filter="url(#soft)">${starburst(1560, 620, 90, 12, 0.32)}${starburst(60, 120, 76, 10, 0.28)}${starburst(420, 1560, 84, 12, 0.3)}</g>`);

// ---- L7 微型儀器圖（microscopic diagrams） ----
for (const [x, y, r] of [[1010, 880, 16], [500, 520, 13], [1450, 520, 15], [220, 1130, 12], [830, 340, 11], [1240, 1330, 14], [70, 900, 10], [1580, 1060, 11]]) {
  out.push(microDiagram(x, y, r, 0.22));
}

// ---- L8 雕版註記：拉丁標籤／座標數字／退色計算 ----
out.push(`<g fill="${GOLD}" stroke="none">`);
out.push(text(FX, FY - 668, 'ZODIACVS · ORBIS SIGNORVM', 15, 0.30, 0, 5));
out.push(text(FX - 380, FY + 500, 'ECLIPTICA', 13, 0.26, -18));
out.push(text(GX, GY - GR * 1.5 - 12, 'SPHAERA COELESTIS', 14, 0.28, 0, 5));
out.push(text(GX + GR * 0.9, GY + GR * 0.62, 'AEQVATOR', 11, 0.24, -23));
out.push(text(330, 300 - 170, 'ARMILLA', 12, 0.26, 0, 5));
out.push(text(1180, 700, 'DECLINATIO +23°26′', 11, 0.22, 0, 2));
out.push(text(400, 860, 'ASCENSIO RECTA · XIV H', 11, 0.22, -8, 2));
out.push(text(1330, 300, 'LATITVDO BOREALIS', 10, 0.2, 12, 2));
out.push(text(240, 560, 'MERIDIANVS PRIMVS', 10, 0.2, -76, 2));
// 退色手算式
out.push(text(1030, 1020, 'Δλ = 0°47′12″', 11, 0.18, -4, 1));
out.push(text(760, 760, 'sin θ = 0.6157', 10, 0.16, 6, 1));
out.push(text(1470, 980, 'h = 90° − φ + δ', 10, 0.16, -10, 1));
out.push(text(560, 1290, 'tan φ · cos δ = 0.3084', 10, 0.16, 4, 1));
out.push(text(950, 470, 'M DCC LXXXVII', 10, 0.18, 0, 3));
// 座標小數字散點
for (let i = 0; i < 14; i++) {
  const x = R(60, W - 60), y = R(60, H - 60);
  const label = rnd() < 0.5 ? `${RI(0, 23)}ʰ ${RI(0, 59)}ᵐ` : `${rnd() < 0.5 ? '+' : '−'}${RI(0, 89)}° ${RI(0, 59)}′`;
  out.push(text(x, y, label, 9, F(R(0.12, 0.2), 2), R(-14, 14), 1));
}
out.push('</g>');

// ---- L9 紙紋顆粒（銅版印刷質感） ----
out.push(`<rect width="${W}" height="${H}" filter="url(#grain)" stroke="none"/>`);

out.push('</svg>');

writeFileSync(new URL('../assets/sky.svg', import.meta.url).pathname, out.join('\n'));
console.log('written', out.join('\n').length, 'bytes');
