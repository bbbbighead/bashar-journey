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
// 卡片本身是白底、細金框、深墨字——與全站的深色介面刻意不同。神諭卡要看起來
// 像一張實體卡片躺在星圖上，這是規格要的樣子（STEP 10），不是漏了套主題。
//
// 版面（2026-08 依站主提供的參考塔羅卡調整）由上而下：
//   白色外緣 → 細金雙框 → **站名 INTUITIVE NOTES** → artwork → 標題 → 花飾 → 句子

import { svgToPng } from './shareCard.js';

const W = 400;          // 內部座標寬
const H = 600;          // 2:3 直式
const OUT_W = 1024;     // 實際輸出（與 gpt-image-1 的 1024×1536 同比例）
const OUT_H = 1536;

const PAD = 18;                  // 白色外緣
const FRAME = 8;                 // 金框與外緣之間的距離
const ART_W = W - (PAD + FRAME) * 2;

// 版面的所有可調旋鈕。抽成一份設定是為了「同一支渲染程式可以畫出不同版型」——
// 站主要比較幾種花邊與字級時，比出來的就是實際上線的東西，不是另外做的假預覽。
// 呼叫端不傳 style 就用這一份（＝目前上線的版型）。
//
// artwork 上面留 headH 給站名，底下的空間放標題、花飾、句子。每一段的間距都是
// 量過的：站名貼著上框（常數），句子區則是畫作下緣到下框之間垂直置中，
// 排不下就一路縮字級到 msgMin——三行的長句也不會把字頂出金框。
const BASE_STYLE = {
  artRatio: 0.70,     // artwork 佔全卡高度
  frame: 'double',    // 外框：'single' 單線｜'double' 雙線
  frameW: 1.2,        // 外框線寬（比照參考卡：線細，靠顏色而不是粗細撐存在感）
  radius: 0,          // 外框圓角
  corner: 'diamond',  // 四角：'none'｜'diamond' 實心菱形｜'bracket' 細角線
  artFrame: true,     // artwork 要不要自己的細金框
  ornTop: 'rule',     // 畫與標題之間：'none'｜'dot' 一顆小菱形｜'rule' 線—菱形—線
  ornTitle: 'rule',   // 標題與句子之間：同上
  titleScale: 1,      // 標題字級倍率
  msgSize: 11.5,      // 句子字級（會依行數再退）
  msgMin: 8.5,        // 句子字級的下限
  footSize: 9.5,      // 站名字級
  headH: 22,          // 上緣留給站名的帶狀高度（站名搬到上面之後才有這一段）
  footGap: 12,        // 站名基線距上框（固定，不跟著句子跑）
  msgBotGap: 12,      // 句子最後一行到下框至少要留的距離
  tKeyMin: 24,        // 畫作下緣 → 標題基線的最小距離（垂直置中後的保險）
  tRule: 21,          // 標題 → 花飾線
  tMsg: 19,           // 花飾線 → 句子第一行
};

// 卡面底色。站主回報舊的象牙白 #f3ece0「帶黃色調」，要求「盡量乾淨的白」——
// 改成中性的近白，只留一點點灰度避免在深色介面上刺眼，色相上不偏暖。
const IVORY = '#fcfcfc';
const IVORY_EDGE = '#e8e8e6';
// 金色的色調與粗細比照站主給的參考塔羅卡（LA ESTRELLA）。取樣那張照片的框線，
// 最常出現的是 #806838 / #887040 這一族——比舊版的 #9c7a33 更暗、更偏橄欖，
// 是「印刷的金」而不是「螢光的金」，而且線本身很細。三級用法不變：
//   GOLD       主框線與裝飾
//   GOLD_MID   次要線條（第二道細框、分隔線）
//   GOLD_SOFT  最淡的一級，只給不該搶戲的地方
const GOLD = '#846c3c';
const GOLD_MID = 'rgba(132,108,60,.68)';
const GOLD_SOFT = 'rgba(132,108,60,.44)';
const INK = '#2b2620';
const INK_SOFT = '#6b6154';

// 小菱形（稜形花飾）。神諭卡的線條裝飾幾乎都由它與細線組成——
// 放在框角、分隔線中央、標題下方，一眼就看得出是「一張牌」而不是一張貼了字的圖。
const diamond = (cx, cy, r, fill) =>
  `<path d="M${cx} ${cy - r}L${cx + r} ${cy}L${cx} ${cy + r}L${cx - r} ${cy}Z" fill="${fill}"/>`;

// 細角線（L 形）。比實心菱形柔和——站主回報菱形「太線條、比較僵硬」，
// 這是另一個方向的角飾。
const bracket = (x, y, dx, dy, len, color) => `
<path d="M${x + dx * len} ${y}L${x} ${y}L${x} ${y + dy * len}"
  fill="none" stroke="${color}" stroke-width="0.9" stroke-linecap="round"/>`;

// 一條「線—菱形—線」的裝飾橫線。half 是整條的半寬，gap 是中間留給菱形的半寬。
const ornRule = (cx, cy, half, gap, r, color) => `
<line x1="${cx - half}" y1="${cy}" x2="${cx - gap}" y2="${cy}" stroke="${color}" stroke-width="0.6"/>
<line x1="${cx + gap}" y1="${cy}" x2="${cx + half}" y2="${cy}" stroke="${color}" stroke-width="0.6"/>
${diamond(cx, cy, r, color)}`;

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

// 關鍵字規定是一個英文單字（見 prompts/oracle.js），所以正常情況下都落在最大的
// 字級。字級仍然隨長度退：模型偶爾會回一個詞組，那時候縮小總比撐出金框好。
// 中日韓的關鍵字也吃得下（把它換成中文標題只需要改提示，版面這一側不必動）。
// 用等效字元數而不是字元數，中日韓的關鍵字才不會撐破（一個中文字約等於兩個字母寬）。
// 一律不換行——關鍵字換行在這個版面上會把句子頂下去。
function titleSize(title) {
  const n = unitsOf(title);
  if (n <= 6.5) return 27;   // 約 12 個字母／6 個中文字
  if (n <= 9.5) return 23;
  if (n <= 13.5) return 19;
  return 16;
}

// artworkDataUrl：data:image/png;base64,…（伺服器回傳的原樣）
// keyword   卡面標題。一個英文單字（模型自己從句子下的標題）
// sentence  卡面句子。**逐字取自使用者貼上的解讀**，所以是使用者的語言
// footer    卡片下緣的站名
// style     版面覆寫（見 BASE_STYLE）。正式站不傳，用預設；
//           scratchpad/card_styles.mjs 靠它畫出幾種版型讓站主挑。
export function buildOracleCardSvg({ artworkDataUrl, keyword, sentence, footer, style }) {
  const S = { ...BASE_STYLE, ...(style || {}) };
  // 站名搬到卡片上方（站主要求：位置比照參考塔羅卡上緣的「XVII」），
  // 所以畫作要往下讓出一條帶子。
  const artTop = PAD + FRAME + S.headH;
  const artH = Math.round(H * S.artRatio);
  const artBottom = artTop + artH;
  const tSize = titleSize(keyword) * S.titleScale;
  // 斜體只給拉丁文字。中日韓沒有真正的斜體字，瀏覽器會把字機械地斜過去，
  // 看起來是歪的而不是斜的（牌卡下方的譯文區為了同樣的理由也不用斜體，
  // 見 css/calm.css 的 .oc-t-msg）。
  const msgItalic = hasCJK(sentence) ? 'normal' : 'italic';

  // ---- 文字區的排法 ----
  //
  // 站名**固定貼著上框**（2026-08 從下緣搬上來）。它的位置是常數，不受句子長短影響，
  // 所以一疊卡放在一起上緣是齊的——這也解決了舊版「站名跟著句子跑、下面不整齊」。
  //
  // 句子區則是畫作下緣到下框之間，把「標題＋花飾＋句子」當成一整塊**垂直置中**。
  // 不置中的話，短句子會在下方留一個尷尬的洞。
  const yFoot = PAD + FRAME + S.footGap;
  const bandTop = artBottom;
  const bandBottom = H - PAD - S.msgBotGap;

  // 句子字級：先用設定值，排不進可用高度就一路退到下限。
  // 2026-08 起句子逐字取自使用者貼上的解讀，長度不再由規格保證，所以要退得夠深。
  const blockH = (n, size) => tSize * 0.72 + S.tRule + S.tMsg
    + (n - 1) * size * 1.55 + size * 0.3;
  let msgSize = S.msgSize;
  let msgLines = wrapText(sentence, msgSize, ART_W - 24);
  while (msgSize > S.msgMin
    && (msgLines.length > 4 || blockH(msgLines.length, msgSize) > bandBottom - bandTop)) {
    msgSize -= 0.5;
    msgLines = wrapText(sentence, msgSize, ART_W - 24);
  }
  const msgLH = msgSize * 1.55;

  const yKey = bandTop + Math.max(S.tKeyMin,
    (bandBottom - bandTop - blockH(msgLines.length, msgSize)) / 2 + tSize * 0.72);
  const yRule = yKey + S.tRule;
  const yMsg = yRule + S.tMsg;

  // ---- 外框 ----
  const inset = 3.5;
  const frame = `<rect x="${PAD}" y="${PAD}" width="${W - PAD * 2}" height="${H - PAD * 2}" rx="${S.radius}"
  fill="none" stroke="${GOLD}" stroke-width="${S.frameW}"/>`
    + (S.frame === 'double'
      ? `\n<rect x="${PAD + inset}" y="${PAD + inset}" width="${W - (PAD + inset) * 2}"
  height="${H - (PAD + inset) * 2}" rx="${Math.max(0, S.radius - 1)}"
  fill="none" stroke="${GOLD_MID}" stroke-width="0.5"/>` : '');

  // ---- 四角 ----
  const cIn = S.frame === 'double' ? PAD + inset : PAD;
  const corners = [[cIn, cIn, 1, 1], [W - cIn, cIn, -1, 1],
    [cIn, H - cIn, 1, -1], [W - cIn, H - cIn, -1, -1]];
  const cornerArt = S.corner === 'diamond'
    ? corners.map(([x, y]) => diamond(x, y, 2.8, GOLD)).join('\n')
    : S.corner === 'bracket'
      ? corners.map(([x, y, dx, dy]) => bracket(x, y, dx, dy, 11, GOLD_MID)).join('\n')
      : '';

  // ---- 兩處花飾 ----
  // 'line' 是最素的一種：一條金色細線，沒有菱形、沒有斷口。
  // 站主要的「最原始的花邊」就是這個。
  const orn = (kind, cy, half, color) => (kind === 'rule'
    ? ornRule(W / 2, cy, half, 8, 2.6, color)
    : kind === 'line'
      ? `<line x1="${W / 2 - half}" y1="${cy}" x2="${W / 2 + half}" y2="${cy}"
  stroke="${color}" stroke-width="0.6"/>`
      : kind === 'dot' ? diamond(W / 2, cy, 2.4, color) : '');

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"
  viewBox="0 0 ${W} ${H}" font-family="'Songti TC','Noto Serif TC',Georgia,'Times New Roman',serif">
<style>
  .oc-title{fill:${INK};font-size:${tSize}px;letter-spacing:.18em;text-anchor:middle}
  .oc-msg{fill:${INK_SOFT};font-size:${msgSize}px;text-anchor:middle;font-style:${msgItalic}}
  /* 站名：站主回報「顏色太淡、字也可以再大一點」，7.5px + 42% 的金在手機上看不到。 */
  .oc-foot{fill:${GOLD};font-size:${S.footSize}px;letter-spacing:.3em;text-anchor:middle;
    font-family:-apple-system,'Helvetica Neue',Arial,sans-serif}
</style>
<defs>
  <clipPath id="ocArt">
    <rect x="${PAD + FRAME}" y="${artTop}" width="${ART_W}" height="${artH}" rx="1"/>
  </clipPath>
</defs>

<rect width="${W}" height="${H}" fill="${IVORY}"/>
<rect x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" fill="none"
  stroke="${IVORY_EDGE}" stroke-width="1"/>

<!-- artwork。preserveAspectRatio 用 slice：寧可裁掉邊緣也不要在框內留白條。 -->
<image href="${artworkDataUrl}" x="${PAD + FRAME}" y="${artTop}"
  width="${ART_W}" height="${artH}"
  preserveAspectRatio="xMidYMid slice" clip-path="url(#ocArt)"/>

${frame}
${cornerArt}
${S.artFrame ? `<rect x="${PAD + FRAME}" y="${artTop}" width="${ART_W}" height="${artH}"
  fill="none" stroke="${GOLD_MID}" stroke-width="0.6"/>` : ''}

<!-- 站名：卡片上緣，位置對應參考塔羅卡的羅馬數字。 -->
<text x="${W / 2}" y="${yFoot}" class="oc-foot">${esc(footer || 'INTUITIVE NOTES')}</text>

${orn(S.ornTop, artBottom + 13, ART_W / 2 - 14, GOLD_MID)}

<text x="${W / 2}" y="${yKey}" class="oc-title">${esc(keyword)}</text>
${orn(S.ornTitle, yRule, 34, GOLD)}
${msgLines.map((line, i) => `<text x="${W / 2}" y="${yMsg + i * msgLH}" class="oc-msg">${esc(line)}</text>`).join('\n')}
</svg>`;
}

// 合成 → PNG Blob（1024×1536，與圖像模型的原生尺寸同比例）
export function oracleCardPng(parts) {
  return svgToPng(buildOracleCardSvg(parts), OUT_W, OUT_H);
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
