// oracleCard.js — 把圖像模型畫的 artwork 合成一張神諭卡。
//
// 為什麼邊框與文字在這裡畫、不交給圖像模型：
// prompt 裡只要出現 oracle card，圖像模型就會自己加上標題與外框，而它畫出來的字
// 是糊的、常拼錯、每次都不一樣，而且沒辦法修。這裡自己排版的話文字永遠是真文字，
// 字級與比例都精確（artwork 佔 70–75% 是規格明訂的），日後要換語系也不必重畫圖。
//
// 手法沿用 js/shareCard.js：組一張自給自足的 SVG，再用瀏覽器自己的光柵化能力轉
// PNG，零外部套件。同樣的關鍵限制也適用——SVG 透過 <img> 載入時是隔離環境，頁面
// 的 CSS 完全不套用、外部資源一律不載入，所以：
//   ・樣式必須內嵌，顏色要寫字面值（不能用 var(--accent)）
//   ・artwork 必須是 data: URI（伺服器回傳的就是 base64，剛好）
// 字型不必內嵌：用的是系統襯線堆疊，隔離環境照樣拿得到。
//
// 卡片本身是象牙白底、細金框、深墨字——與全站的深色介面刻意不同。神諭卡要看起來
// 像一張實體卡片躺在星圖上，這是規格要的樣子（STEP 10），不是漏了套主題。

import { svgToPng } from './shareCard.js';

const W = 400;          // 內部座標寬
const H = 600;          // 2:3 直式
const OUT_W = 1024;     // 實際輸出（與 gpt-image-1 的 1024×1536 同比例）
const OUT_H = 1536;

const PAD = 18;                  // 象牙白外緣
const FRAME = 8;                 // 金框與外緣之間的距離
const ART_TOP = PAD + FRAME;
const ART_W = W - (PAD + FRAME) * 2;
const ART_H = Math.round(H * 0.70);   // artwork 佔全卡 70%（規格：70–75%）
// artwork 底下只剩約 136px 要放關鍵字、細線、句子、站名——每一段的間距都是量過的，
// 不是隨手給的。第一版把站名放在固定的 H-PAD-10，結果與句子的第二行疊在一起
// （實際截圖看到站名消失了），所以站名改成跟著最後一行走。
// 這一版卡面只有三行（關鍵字／細金線／句子），比舊版少一行，所以整塊往下移一點——
// 不移的話句子與站名之間會空出一塊，看起來像漏了東西。三行的句子仍然放得下：
// 句子第一行在 526，三行後 559，站名 577。
const T_KEY = 40;     // artwork 下緣 → 關鍵字基線
const T_RULE = 21;    // 關鍵字 → 細金線
const T_MSG = 19;     // 細金線 → 句子第一行

const IVORY = '#f3ece0';
const IVORY_EDGE = '#e6dcc9';
const GOLD = '#a98b48';
const GOLD_SOFT = 'rgba(169,139,72,.42)';
const INK = '#2b2620';
const INK_SOFT = '#6b6154';

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

// SVG 沒有自動換行，只能自己斷。卡面文字一律英文（見 prompts/oracle.js 的決定），
// 所以用拉丁字寬估算就夠：一個字元約 0.5em，大寫與寬字母略多，取 0.52 保守一點。
// 估錯的方向刻意偏保守——寧可比實際窄、多換一行，也不要撐出金框。
function wrapLatin(text, fontSize, maxWidth) {
  const per = fontSize * 0.52;
  const max = Math.max(1, Math.floor(maxWidth / per));
  const words = String(text || '').trim().split(/\s+/).filter(Boolean);
  const lines = [];
  let cur = '';
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w;
    if (next.length <= max) { cur = next; continue; }
    if (cur) lines.push(cur);
    cur = w;
  }
  if (cur) lines.push(cur);
  return lines;
}

// 關鍵字規定是一個英文單字（見 prompts/oracle.js），所以正常情況下都落在最大的
// 字級。字級仍然隨長度退：模型偶爾會回一個詞組，那時候縮小總比撐出金框好。
// 一律不換行——關鍵字換行在這個版面上會把句子頂下去。
function titleSize(title) {
  const n = String(title || '').length;
  if (n <= 12) return 27;
  if (n <= 18) return 23;
  if (n <= 26) return 19;
  return 16;
}

// artworkDataUrl：data:image/png;base64,…（伺服器回傳的原樣）
// keyword / sentence：卡面文字，英文（一個單字 ＋ 一句話）
// footer：卡片下緣的站名
export function buildOracleCardSvg({ artworkDataUrl, keyword, sentence, footer }) {
  const tSize = titleSize(keyword);

  // 文字區從 artwork 下方開始，往下依序排：關鍵字 → 細金線 → 句子 → 站名。
  const textTop = ART_TOP + ART_H;
  const yKey = textTop + T_KEY;
  const yRule = yKey + T_RULE;
  const yMsg = yRule + T_MSG;

  // 句子最多三行。規格允許 8–18 words，最長的那種在 11.5px 下會排到四行、
  // 把站名頂出卡外，所以字級隨行數退——退到 9.5 就不再退（再小讀不動了）。
  let msgSize = 11.5;
  let msgLines = wrapLatin(sentence, msgSize, ART_W - 24);
  while (msgLines.length > 3 && msgSize > 9.5) {
    msgSize -= 1;
    msgLines = wrapLatin(sentence, msgSize, ART_W - 24);
  }
  const msgLH = msgSize * 1.45;
  const yFoot = Math.max(H - PAD - 5, yMsg + (msgLines.length - 1) * msgLH + 15);

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"
  viewBox="0 0 ${W} ${H}" font-family="'Songti TC','Noto Serif TC',Georgia,'Times New Roman',serif">
<style>
  .oc-title{fill:${INK};font-size:${tSize}px;letter-spacing:.18em;text-anchor:middle}
  .oc-msg{fill:${INK_SOFT};font-size:${msgSize}px;text-anchor:middle;font-style:italic}
  .oc-foot{fill:${GOLD_SOFT};font-size:7.5px;letter-spacing:.34em;text-anchor:middle;
    font-family:-apple-system,'Helvetica Neue',Arial,sans-serif}
</style>
<defs>
  <clipPath id="ocArt">
    <rect x="${PAD + FRAME}" y="${ART_TOP}" width="${ART_W}" height="${ART_H}" rx="1"/>
  </clipPath>
</defs>

<rect width="${W}" height="${H}" fill="${IVORY}"/>
<rect x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" fill="none"
  stroke="${IVORY_EDGE}" stroke-width="1"/>

<!-- artwork。preserveAspectRatio 用 slice：寧可裁掉邊緣也不要在框內留白條，
     模型回的是 2:3，所以實際上幾乎不會裁到。 -->
<image href="${artworkDataUrl}" x="${PAD + FRAME}" y="${ART_TOP}"
  width="${ART_W}" height="${ART_H}"
  preserveAspectRatio="xMidYMid slice" clip-path="url(#ocArt)"/>

<!-- 細金框：整張卡的內框，圈住 artwork 與文字 -->
<rect x="${PAD}" y="${PAD}" width="${W - PAD * 2}" height="${H - PAD * 2}"
  fill="none" stroke="${GOLD}" stroke-width="0.8" opacity=".75"/>
<!-- artwork 與文字之間的分界，只畫一條淡線，不畫整框 -->
<line x1="${PAD + FRAME}" y1="${ART_TOP + ART_H}" x2="${W - PAD - FRAME}" y2="${ART_TOP + ART_H}"
  stroke="${GOLD_SOFT}" stroke-width="0.7"/>

<text x="${W / 2}" y="${yKey}" class="oc-title">${esc(keyword)}</text>
<line x1="${W / 2 - 26}" y1="${yRule}" x2="${W / 2 + 26}" y2="${yRule}"
  stroke="${GOLD_SOFT}" stroke-width="0.7"/>
${msgLines.map((line, i) => `<text x="${W / 2}" y="${yMsg + i * msgLH}" class="oc-msg">${esc(line)}</text>`).join('\n')}
<text x="${W / 2}" y="${yFoot}" class="oc-foot">${esc(footer || 'INTUITIVE NOTES')}</text>
</svg>`;
}

// 合成 → PNG Blob（1024×1536，與圖像模型的原生尺寸同比例）
export function oracleCardPng(parts) {
  return svgToPng(buildOracleCardSvg(parts), OUT_W, OUT_H);
}

// 存檔用的小張預覽：長邊 900px 的 JPEG。
// 站主初期要審核牌卡品質，但原圖 PNG 約 1.5–3 MB，Redis 不該裝那種東西；
// 壓過的預覽肉眼幾乎等同，而且存的是「合成後」的樣子——那才是使用者拿到的東西。
export function oracleCardPreview(blob, longEdge = 900, quality = 0.72) {
  return new Promise((resolve, reject) => {
    const href = URL.createObjectURL(blob);
    const img = new Image();
    const done = (v) => { URL.revokeObjectURL(href); resolve(v); };
    const timer = setTimeout(() => { URL.revokeObjectURL(href); reject(new Error('preview_timeout')); }, 8000);
    img.onload = () => {
      clearTimeout(timer);
      try {
        const k = longEdge / Math.max(img.width, img.height);
        const c = document.createElement('canvas');
        c.width = Math.round(img.width * k);
        c.height = Math.round(img.height * k);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        done(c.toDataURL('image/jpeg', quality));
      } catch (e) { URL.revokeObjectURL(href); reject(e); }
    };
    img.onerror = () => { clearTimeout(timer); URL.revokeObjectURL(href); reject(new Error('preview_failed')); };
    img.src = href;
  });
}
