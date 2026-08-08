// oracleCard.js — 把圖像模型畫的 artwork 合成一張神諭卡。
//
// 為什麼邊框與文字在這裡畫、不交給圖像模型：
// prompt 裡只要出現 oracle card，圖像模型就會自己加上標題與外框，而它畫出來的字
// 是糊的、常拼錯、每次都不一樣，而且沒辦法修。這裡自己排版的話文字永遠是真文字，
// 字級與比例都精確，日後要換語系也不必重畫圖。
//
// 手法沿用 js/shareCard.js：組一張自給自足的 SVG，再用瀏覽器自己的光柵化能力轉
// PNG，零外部套件。同樣的關鍵限制也適用——SVG 透過 <img> 載入時是隔離環境，頁面
// 的 CSS 完全不套用、外部資源一律不載入，所以：
//   ・樣式必須內嵌，顏色要寫字面值（不能用 var(--accent)）
//   ・artwork 與 logo 都必須是 data: URI（logo 由 oracleCardPng 先抓好再塞進來）
// 字型不必內嵌：用的是系統襯線堆疊，隔離環境照樣拿得到。
//
// ── 版面（2026-08 依站主提供的參考卡整個改掉）─────────────────────
// 舊版是「白卡紙中間貼一張畫」；新版是**滿版**——artwork 鋪滿整張卡，
// 文字直接壓在畫上。由上而下：
//   細金框（四角切邊）→ logo 標記 → INTUITIVE NOTES
//   →（畫面）→ 關鍵字 → 分隔線（中央一顆星點）→ 句子
//
// 滿版最大的風險是**文字讀不到**：artwork 是模型畫的，我們無法保證上下緣夠暗。
// 所以上下各鋪一層由透明漸到深的遮罩（scrim），字永遠有底。這不是裝飾，
// 是這個版面能成立的前提——拿掉它，遇到一張亮色的畫就整段字消失。
import { svgToPng } from './shareCard.js';

const W = 400;          // 內部座標寬
const H = 600;          // 2:3 直式
const OUT_W = 1024;     // 實際輸出（與圖像模型的 1024×1536 同比例，滿版剛好不必裁）
const OUT_H = 1536;

// logo 檔的位置。用 import.meta.url 解析，站台掛在子路徑下也找得到。
const LOGO_URL = new URL('../assets/logo-mark.png', import.meta.url).href;

// 版面旋鈕。抽成一份設定是為了「同一支渲染程式可以畫出不同版型」——
// 站主要比較字級或線條時，比出來的就是實際上線的東西，不是另外做的假預覽。
const BASE_STYLE = {
  framePad: 11,     // 金框距卡緣
  chamfer: 20,      // 四角切邊的長度
  frameW: 0.9,      // 金框線寬（站主：細細的淺色金線）
  cornerTick: true, // 切邊內側再補一道短線，角落才有「切過」的層次
  logoSize: 30,     // logo 標記的邊長
  logoY: 46,        // logo 中心
  nameY: 88,        // 站名基線
  nameSize: 10.5,
  titleMax: 34,     // 關鍵字最大字級（太長會自己退）
  titleMin: 17,
  msgSize: 14,
  msgMin: 9.5,
  msgBottom: 562,   // **句子最後一行的基線**：版面由下往上長，這個值固定
  tOrn: 30,         // 句子第一行 → 分隔線
  tKey: 24,         // 分隔線 → 關鍵字基線
  scrimTop: 0.55,   // 上緣遮罩最深處的不透明度
  scrimBot: 0.8,    // 下緣遮罩最深處
};

// 金色一族。滿版之後字是壓在畫上的，所以全部改成「淺金」——
// 舊版那組印刷金（#846c3c）是給白紙用的，放到深色畫面上會直接糊掉看不見。
const LINE_GOLD = 'rgba(226,201,150,.62)';    // 主框線
const LINE_GOLD_SOFT = 'rgba(226,201,150,.34)'; // 角落短線、分隔線兩側
const TITLE_GOLD = '#ecd9ad';
const TEXT_GOLD = '#e0c99e';
const NAME_GOLD = 'rgba(233,214,175,.88)';
const SCRIM = '#070b12';                       // 遮罩用的深色（與站上的夜空同色系）

// 四角星（sparkle）。logo 上那顆星的簡化版——分隔線中央、四角的點綴都用它。
// 用二次曲線做出內凹的腰身，看起來才是「星芒」而不是菱形。
const star = (cx, cy, r, fill) => {
  const k = r * 0.16;
  return `<path d="M${cx} ${cy - r}Q${cx + k} ${cy - k} ${cx + r} ${cy}`
    + `Q${cx + k} ${cy + k} ${cx} ${cy + r}Q${cx - k} ${cy + k} ${cx - r} ${cy}`
    + `Q${cx - k} ${cy - k} ${cx} ${cy - r}Z" fill="${fill}"/>`;
};

// 一條「線—星點—線」的分隔線（站主指定：分隔線中間有一個星點）。
const ornRule = (cx, cy, half, gap, r, color, starColor) => `
<line x1="${cx - half}" y1="${cy}" x2="${cx - gap}" y2="${cy}" stroke="${color}" stroke-width="0.7"/>
<line x1="${cx + gap}" y1="${cy}" x2="${cx + half}" y2="${cy}" stroke="${color}" stroke-width="0.7"/>
${star(cx, cy, r, starColor)}`;

// 四角切邊的外框。八個點繞一圈，每個角用一段 45° 的斜線切掉，
// 而不是直角相接——這是站主指定的「四個角有切邊的設計」。
const chamferPath = (pad, c) => [
  `M${pad + c} ${pad}`, `L${W - pad - c} ${pad}`, `L${W - pad} ${pad + c}`,
  `L${W - pad} ${H - pad - c}`, `L${W - pad - c} ${H - pad}`,
  `L${pad + c} ${H - pad}`, `L${pad} ${H - pad - c}`, `L${pad} ${pad + c}`, 'Z',
].join('');

// 切邊內側的短線。四個角各一道，與斜邊平行，讓角落看起來是「切出來的」
// 而不是單純少了一塊。
const cornerTicks = (pad, c, color) => {
  const d = 5;          // 內縮距離
  const len = c * 0.52; // 短線長度（比斜邊短，才看得出是內側的細節）
  const corners = [
    [pad, pad, 1, 1], [W - pad, pad, -1, 1],
    [pad, H - pad, 1, -1], [W - pad, H - pad, -1, -1],
  ];
  return corners.map(([x, y, sx, sy]) => {
    // 斜邊的兩個端點內縮 d，再各取 len 長度
    const x1 = x + sx * (c + d - len);
    const y1 = y + sy * d;
    const x2 = x + sx * d;
    const y2 = y + sy * (c + d - len);
    return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"
  stroke="${color}" stroke-width="0.7" stroke-linecap="round"/>`;
  }).join('\n');
};

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

// SVG 沒有自動換行，只能自己斷。而中日韓與拉丁的斷行規則完全不同：
//   ・拉丁在空白處斷，單字不能切開
//   ・中日韓沒有空白，幾乎任兩個字之間都能斷，但行首不能是句號、逗號、右引號……
//     （這叫禁則處理；不做的話會出現一行開頭孤零零一個「。」）
// 卡面句子從 2026-08 起改成逐字取自使用者貼上的解讀（見 prompts/oracle.js），
// 所以它會是使用者的語言——中文的機會最大。只按空白斷的話，一整句中文會被當成
// 一個「單字」，排成一行直接撐出金框。

// 一個字有多寬（以 em 為單位）：中日韓與全形標點約一個字身，拉丁字母約 0.52。
// 用這把尺把兩種文字換算成同一個「等效字元數」，斷行與平衡就能共用一套邏輯。
const RE_CJK = /[\u3000-\u303f\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\ufe30-\ufe4f\uff00-\uffef]/;
const RE_HANGUL = /[\u1100-\u11ff\u3130-\u318f\uac00-\ud7af]/;
const LATIN_EM = 0.52;
const charEm = (ch) => (RE_CJK.test(ch) || RE_HANGUL.test(ch) ? 1 : LATIN_EM);
const unitsOf = (s) => {
  let n = 0;
  for (const ch of String(s || '')) n += charEm(ch);
  return n;
};
const hasCJK = (s) => RE_CJK.test(String(s || '')) || RE_HANGUL.test(String(s || ''));

// 行首禁則：這些字不可以出現在一行的開頭。
const NO_LINE_START = '、。，．：；！？」』）〕】》〉”’%℃…—～·,.:;!?)]}>';

// 把一句話切成「斷點單元」。三種文字的斷行規則不一樣，這裡是關鍵：
//   ・中日文（漢字、假名）：幾乎任兩個字之間都能斷 → 一個字一個單元
//   ・韓文：詞與詞之間有空白，正常在空白處斷 → 跟拉丁一樣，整個詞一個單元
//   ・拉丁：在空白處斷，單字不能切開 → 整個單字一個單元
// sp 記的是「原文在這個單元之前有沒有空白」，重組時要照原樣補回去——
// 第一版沒記，韓文的詞間空白全部被吃掉，變成一整串連在一起的字。
function segments(text) {
  const out = [];
  let buf = '';
  let sp = false;
  const flush = () => { if (buf) { out.push({ t: buf, sp }); buf = ''; sp = false; } };
  for (const ch of String(text || '').trim()) {
    if (/\s/.test(ch)) { flush(); sp = true; continue; }
    if (RE_CJK.test(ch)) { flush(); out.push({ t: ch, sp }); sp = false; continue; }
    buf += ch;   // 拉丁與韓文都累積成詞
  }
  flush();
  return out;
}

// 貪心斷行：每一行塞到滿為止。max 是「等效字元數」，不是實際字元數。
function greedyLines(segs, max) {
  const lines = [];
  let cur = '';
  for (const s of segs) {
    const next = cur + (cur && s.sp ? ' ' : '') + s.t;
    if (unitsOf(next) <= max) { cur = next; continue; }
    // 行首禁則：新的一行不可以用句號、逗號、右括號這類字開頭。
    // 標準做法是「追い出し」——把上一行的最後一個字一起推到下一行，
    // 而不是硬留在上一行（硬留會撐出金框，實測過會超出 7px）。
    if (cur && NO_LINE_START.includes(s.t) && [...cur].length > 1) {
      const arr = [...cur];
      const moved = arr.pop();
      lines.push(arr.join(''));
      cur = moved + s.t;
      continue;
    }
    if (cur) lines.push(cur);
    cur = s.t;
  }
  if (cur) lines.push(cur);
  return lines;
}

// 斷完之後再「平衡」：貪心排法會把第一行塞到滿，第二行只剩幾個字（站主回報過
// 「Your only real mission is to become yourself as fully ／ as you can.」，
// 52 字對 11 字），版面看起來是歪的。做法是在**不增加行數**的前提下，把每行允許的
// 寬度一路收窄到不能再收——行數不變，字就會自己往下一行移，兩行長度自然接近。
// 這正是瀏覽器 text-wrap: balance 的作法，只是 SVG 裡沒有這個屬性，得自己算。
function wrapText(text, fontSize, maxWidth) {
  const hardMax = Math.max(1, maxWidth / fontSize);   // 可容納的等效字元數
  const segs = segments(text);
  if (!segs.length) return [];

  const lines = greedyLines(segs, hardMax);
  if (lines.length < 2) return lines;

  // 下界是最長的那個單元——再窄下去單元本身就會撐出金框（貪心不切開單字）。
  // 中日韓每個單元都是一個字，所以下界是 1，平衡的空間很大。
  let lo = segs.reduce((m, s) => Math.max(m, unitsOf(s.t)), 1);
  let hi = hardMax;
  // 用 0.25 個字元的精度做二分：整數精度對中日韓來說太粗，會平衡不到位
  while (hi - lo > 0.25) {
    const mid = (lo + hi) / 2;
    if (greedyLines(segs, mid).length <= lines.length) hi = mid; else lo = mid;
  }
  return greedyLines(segs, hi);
}

// 關鍵字規定是一個英文單字（見 prompts/oracle.js），所以正常情況下都吃得到最大字級。
// 字級仍然隨長度退：模型偶爾會回一個詞組，那時候縮小總比撐出金框好。
// 用等效字元數而不是字元數，中日韓的關鍵字才不會撐破（一個中文字約等於兩個字母寬）。
// 一律不換行——關鍵字換行在這個版面上會把句子頂下去。
function titleSize(title, max, min, maxWidth) {
  const n = unitsOf(title);
  if (!n) return max;
  // .06em 的字距也要算進去，不然剛好卡邊的關鍵字會超出去
  let size = Math.min(max, maxWidth / (n * 1.06));
  return Math.max(min, Math.round(size * 2) / 2);
}

// artworkDataUrl：data:image/png;base64,…（伺服器回傳的原樣）。滿版鋪滿整張卡。
// logoDataUrl：assets/logo-mark.png 的 data URI，由 oracleCardPng 先抓好。
//              拿不到就不畫 logo，站名照樣在——logo 是加分，不是必要條件。
// keyword   卡面標題。一個英文單字（模型自己從句子下的標題）
// sentence  卡面句子。**逐字取自使用者貼上的解讀**，所以是使用者的語言
// footer    站名
// style     版面覆寫（見 BASE_STYLE）。正式站不傳，用預設。
export function buildOracleCardSvg({
  artworkDataUrl, logoDataUrl, keyword, sentence, footer, style,
}) {
  const S = { ...BASE_STYLE, ...(style || {}) };
  const textW = W - 108;          // 句子的可用寬度
  const titleW = W - 84;          // 關鍵字的可用寬度
  const tSize = titleSize(keyword, S.titleMax, S.titleMin, titleW);
  // 斜體只給拉丁文字。中日韓沒有真正的斜體字，瀏覽器會把字機械地斜過去，
  // 看起來是歪的而不是斜的。
  const msgItalic = hasCJK(sentence) ? 'normal' : 'italic';

  // ---- 文字區：由下往上長 ----
  // 句子的**最後一行**貼在固定的高度（S.msgBottom），往上依序是句子其他行、
  // 分隔線、關鍵字。這樣句子長短不同的卡片下緣一律齊平，而關鍵字自然往上讓。
  // 舊版是由上往下排再置中，句子一長下緣就參差不齊。
  let msgSize = S.msgSize;
  let msgLines = wrapText(sentence, msgSize, textW);
  while (msgSize > S.msgMin && msgLines.length > 4) {
    msgSize -= 0.5;
    msgLines = wrapText(sentence, msgSize, textW);
  }
  const msgLH = msgSize * 1.62;
  const n = Math.max(1, msgLines.length);
  const yMsg = S.msgBottom - (n - 1) * msgLH;   // 第一行
  const yOrn = yMsg - S.tOrn;
  const yKey = yOrn - S.tKey;

  const pad = S.framePad;
  const c = S.chamfer;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"
  viewBox="0 0 ${W} ${H}" font-family="'Songti TC','Noto Serif TC',Georgia,'Times New Roman',serif">
<style>
  .oc-title{fill:${TITLE_GOLD};font-size:${tSize}px;letter-spacing:.06em;text-anchor:middle}
  .oc-msg{fill:${TEXT_GOLD};font-size:${msgSize}px;text-anchor:middle;font-style:${msgItalic}}
  .oc-foot{fill:${NAME_GOLD};font-size:${S.nameSize}px;letter-spacing:.34em;text-anchor:middle;
    font-family:Georgia,'Times New Roman',serif}
</style>
<defs>
  <!-- 上下的遮罩：文字壓在畫上，沒有它遇到亮色的畫就整段字消失 -->
  <linearGradient id="ocTop" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="${SCRIM}" stop-opacity="${S.scrimTop}"/>
    <stop offset="1" stop-color="${SCRIM}" stop-opacity="0"/>
  </linearGradient>
  <linearGradient id="ocBot" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="${SCRIM}" stop-opacity="0"/>
    <stop offset=".45" stop-color="${SCRIM}" stop-opacity="${S.scrimBot * 0.62}"/>
    <stop offset="1" stop-color="${SCRIM}" stop-opacity="${S.scrimBot}"/>
  </linearGradient>
</defs>

<!-- 卡片外緣是完整的矩形，只有金線的四角是切邊的（參考卡就是這樣）。
     一度把整張卡也切成八邊形，四角會露出背景的黑色三角，不對。 -->
<g>
  <rect width="${W}" height="${H}" fill="${SCRIM}"/>
  <!-- artwork 滿版。slice：寧可裁掉邊緣也不要留白條（來源就是 2:3，正常不會裁到） -->
  <image href="${artworkDataUrl}" x="0" y="0" width="${W}" height="${H}"
    preserveAspectRatio="xMidYMid slice"/>
  <rect x="0" y="0" width="${W}" height="170" fill="url(#ocTop)"/>
  <rect x="0" y="${H - 290}" width="${W}" height="290" fill="url(#ocBot)"/>
</g>

<path d="${chamferPath(pad, c)}" fill="none" stroke="${LINE_GOLD}" stroke-width="${S.frameW}"/>
${S.cornerTick ? cornerTicks(pad, c, LINE_GOLD_SOFT) : ''}

${logoDataUrl ? `<image href="${logoDataUrl}" x="${(W - S.logoSize) / 2}"
  y="${S.logoY - S.logoSize / 2}" width="${S.logoSize}" height="${S.logoSize}"/>` : ''}
<text x="${W / 2}" y="${S.nameY}" class="oc-foot">${esc(footer || 'INTUITIVE NOTES')}</text>

<text x="${W / 2}" y="${yKey}" class="oc-title">${esc(keyword)}</text>
${ornRule(W / 2, yOrn, 62, 13, 4.6, LINE_GOLD_SOFT, LINE_GOLD)}
${msgLines.map((line, i) => `<text x="${W / 2}" y="${yMsg + i * msgLH}" class="oc-msg">${esc(line)}</text>`).join('\n')}
</svg>`;
}

// logo 只抓一次，之後共用同一個 Promise。抓不到就回空字串——
// 卡片少一個標記還是完整的卡片，不值得為它整張失敗。
let logoPromise = null;
export function oracleLogoDataUrl() {
  if (!logoPromise) {
    logoPromise = fetch(LOGO_URL)
      .then((r) => (r.ok ? r.blob() : Promise.reject(new Error('logo ' + r.status))))
      .then((blob) => new Promise((res, rej) => {
        const fr = new FileReader();
        fr.onload = () => res(String(fr.result));
        fr.onerror = () => rej(new Error('logo read'));
        fr.readAsDataURL(blob);
      }))
      .catch(() => '');
  }
  return logoPromise;
}

// 合成 → PNG Blob（1024×1536，與圖像模型的原生尺寸同比例；滿版剛好不必裁）
export async function oracleCardPng(parts) {
  const logo = parts.logoDataUrl != null ? parts.logoDataUrl : await oracleLogoDataUrl();
  return svgToPng(buildOracleCardSvg({ ...parts, logoDataUrl: logo }), OUT_W, OUT_H);
}

// 存檔用的小張預覽：長邊 900px 的 JPEG。
// 站主要審核牌卡品質，但原圖 PNG 約 1.5–3 MB，Redis 不該裝那種東西；
// 壓過的預覽肉眼幾乎等同。
//
// src 可以是 Blob（合成好的卡）或 data: URI（圖像模型回的 artwork）。兩張都要存：
// 合成卡是使用者拿到的東西，artwork 才是拿來對照 imagePrompt 的那一張——卡面上的
// artwork 被裁過邊、又只佔 70%，光看合成卡判斷不出「這段 prompt 畫出了什麼」。
export function imagePreview(src, longEdge = 900, quality = 0.72) {
  return new Promise((resolve, reject) => {
    const isBlob = typeof src !== 'string';
    const href = isBlob ? URL.createObjectURL(src) : src;
    const free = () => { if (isBlob) URL.revokeObjectURL(href); };
    const img = new Image();
    const timer = setTimeout(() => { free(); reject(new Error('preview_timeout')); }, 8000);
    img.onload = () => {
      clearTimeout(timer);
      try {
        const k = Math.min(1, longEdge / Math.max(img.width, img.height));
        const c = document.createElement('canvas');
        c.width = Math.round(img.width * k);
        c.height = Math.round(img.height * k);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        const out = c.toDataURL('image/jpeg', quality);
        free();
        resolve(out);
      } catch (e) { free(); reject(e); }
    };
    img.onerror = () => { clearTimeout(timer); free(); reject(new Error('preview_failed')); };
    img.src = href;
  });
}
