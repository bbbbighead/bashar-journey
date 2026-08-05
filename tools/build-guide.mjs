// build-guide.mjs — 由語系字典產出 /guide/ 底下的靜態頁。
//
// 為什麼要有產生器，而不是手寫四份 HTML：
// 「探索工具介紹」的文案原本只活在 js/i18n/locales/*.js 的 guide 區塊裡，透過
// js/app.js 的 renderGuide() 畫成一個沒有網址的畫面——所以搜尋引擎看不到，也沒
// 辦法單獨分享。這裡把同一份文案輸出成有網址的靜態頁。
// 若改成手寫，同一段文案就有兩份來源：日後改了字典裡的版本，公開頁會默默留在舊
// 版，而且沒有人會發現。產生器讓字典永遠是唯一來源。
//
// 用法：
//   node tools/build-guide.mjs          產出檔案（輸出結果要 commit 進 repo）
//   node tools/build-guide.mjs --check  只比對，磁碟上的檔案與字典不一致就非零退出
//
// 產出的是純靜態 HTML（內容直接寫在標記裡，不靠 JS 注入）——這是整件事的重點：
// Googlebot 雖然會執行 JS，但「內容本來就在 HTML 裡」才是最可靠的。
//
// 目前只做繁體中文。四語系版本要等語言網址的機制一起決定（見 sitemap.xml 的註解）。

import { writeFile, readFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import dict from '../js/i18n/locales/zh-Hant.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SITE = 'https://www.intuitive-notes.com';
const OG_IMAGE = `${SITE}/assets/og.jpg`;

// 網址代號。刻意不從文案推導：文案會改字、順序也可能調動，但網址一旦公開就不能
// 變（換掉等於丟掉已累積的收錄）。所以這裡寫死對應，並在下面驗證名稱沒有被換位。
const SLUGS = [
  { slug: 'lenormand', expect: '雷諾曼九宮格' },
  { slug: 'meihua', expect: '梅花易數' },
  { slug: 'astrology', expect: '西洋占星（本命星盤）' },
];

const esc = (s) => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

// meta 欄位的文案本身帶 <b>（字典裡就是這樣寫的，renderGuide 也是原樣插入），
// 所以這個欄位不能 escape。其餘欄位一律 escape。
const rawHtml = (s) => String(s);

// 描述用 lede，砍到搜尋結果會顯示的長度；不自己另寫一句，避免公開頁出現一段
// 沒人審過的文案。
const metaDesc = (s) => {
  const t = String(s).replace(/\s+/g, ' ').trim();
  return t.length <= 150 ? t : `${t.slice(0, 149)}…`;
};

function head({ title, desc, path, breadcrumb }) {
  const url = `${SITE}${path}`;
  return `<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}">
<link rel="canonical" href="${url}">
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Ccircle cx='50' cy='50' r='38' fill='none' stroke='%23c9b98a' stroke-width='6'/%3E%3Ccircle cx='50' cy='50' r='12' fill='%23c9b98a'/%3E%3C/svg%3E">
<meta property="og:type" content="article">
<meta property="og:site_name" content="Intuitive Notes">
<meta property="og:locale" content="zh_TW">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:url" content="${url}">
<meta property="og:image" content="${OG_IMAGE}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(title)}">
<meta name="twitter:description" content="${esc(desc)}">
<meta name="twitter:image" content="${OG_IMAGE}">
<script type="application/ld+json">
${JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: breadcrumb.map((b, i) => ({
      '@type': 'ListItem', position: i + 1, name: b.name, item: `${SITE}${b.path}`,
    })),
  }, null, 1)}
</script>
<!-- 沿用前台同一份樣式（.gd-* 等 class 與應用內的「探索工具介紹」完全相同），
     絕對路徑：這些頁在 /guide/ 底下，相對路徑會解析錯。 -->
<link rel="stylesheet" href="/css/calm.css">
<style>
/* .screen 預設 display:none、且 .active 帶 1 秒淡入。靜態內容頁不需要那套畫面
   切換機制，所以自己給一個等寬的容器，不去借用 .screen。 */
.gp-wrap { width: 100%; max-width: 660px; padding: 8vh 22px 60px; text-shadow: 0 1px 3px rgba(3, 7, 13, .75); }
/* 麵包屑用 flex＋nowrap：手機上整條會換行，但每一層自己不會被拆成兩半
   （原本是一整串置中文字，窄螢幕會把「雷諾曼九宮格」斷成「雷諾曼九宮／格」） */
.gp-crumb {
  display: flex; flex-wrap: wrap; justify-content: center; align-items: baseline;
  font-family: var(--sans); font-size: 12px; letter-spacing: .12em;
  color: var(--ink-faint); margin-bottom: 18px;
}
.gp-crumb a, .gp-crumb .gp-here { white-space: nowrap; }
.gp-crumb a { color: var(--ink-dim); text-decoration: none; }
.gp-crumb a:hover { color: var(--accent); }
.gp-crumb .gp-sep { margin: 0 6px; opacity: .5; }
/* .btn 是給 <button> 寫的：<a> 是行內元素，要補 display 與去底線 */
.gp-actions { display: flex; justify-content: center; padding: 26px 0 14px; }
.gp-actions .btn { display: inline-block; text-decoration: none; }
.gp-more { font-family: var(--sans); font-size: 13.5px; text-align: center; color: var(--ink-faint); padding-bottom: 10px; }
.gp-more a { color: var(--ink-dim); text-decoration: none; border-bottom: 1px solid rgba(214, 183, 122, .28); padding-bottom: 1px; }
.gp-more a:hover { color: var(--accent); }
.gp-more span { margin: 0 8px; opacity: .45; }
/* 速覽卡在這裡是連結，不是靜態方塊 */
a.gd-card { display: block; text-decoration: none; color: inherit; }
a.gd-card:hover .gd-card-name { color: var(--accent); }
</style>`;
}

const page = ({ title, desc, path, breadcrumb, body }) => `<!DOCTYPE html>
<html lang="zh-Hant">
<head>
${head({ title, desc, path, breadcrumb })}
</head>
<body>
<div class="sky" aria-hidden="true"></div>
<div class="app">
<main class="gp-wrap">
${body}
</main>
</div>
</body>
</html>
`;

const g = dict.guide;
const HUB = { name: g.title, path: '/guide/' };
// 首頁那一層用「直覺筆記」而不是完整站名：麵包屑要短，而且畫面上的字樣必須與下面
// BreadcrumbList 結構化資料裡的 name 一致（Google 會比對兩邊）。
const HOME = { name: '直覺筆記', path: '/' };

const crumbHtml = (trail) => `<nav class="gp-crumb" aria-label="麵包屑">${
  trail.map((b, i) => (i === trail.length - 1
    ? `<span class="gp-here">${esc(b.name)}</span>`
    : `<a href="${b.path}">${esc(b.name)}</a><span class="gp-sep" aria-hidden="true">›</span>`)).join('')}</nav>`;

const rowsHtml = (list) => (list || []).map((r) => `      <li class="gd-row"><span class="gd-row-name">${
  esc(r.name)}</span><span class="gd-row-line">${esc(r.line)}</span></li>`).join('\n');

// ---- 中心頁 /guide/ ----
// 三個工具的比較內容（「不知道該選哪一個？」）只放這一頁。放進每個工具頁會讓三頁
// 有一大段一模一樣的內容，那是搜尋引擎眼中的重複內容，反而扣分。
function hubPage() {
  const cards = g.cards.map((c, i) => `    <a class="gd-card" href="/guide/${SLUGS[i].slug}/">
      <div class="gd-card-name"><span class="gd-mark" aria-hidden="true">✦</span>${esc(c.name)}</div>
      <div class="gd-card-line">${esc(c.line)}</div>
    </a>`).join('\n');

  const body = `${crumbHtml([HOME, HUB])}
  <h1 class="r-title">${esc(g.title)}</h1>
  <div class="rule-orn" aria-hidden="true"></div>
  <p class="gd-lede" style="text-align:center;max-width:28em;margin:0 auto 20px">${esc(g.overviewLede)}</p>
  <div class="gd-cards">
${cards}
  </div>
  <div class="rule-orn" aria-hidden="true"></div>
  <section class="gd-choose">
    <h2 class="gd-h2">${esc(g.chooseTitle)}</h2>
${g.chooseBody.map((p) => `    <p class="gd-lede">${esc(p)}</p>`).join('\n')}
    <div class="gd-label">${esc(g.exampleLabel)}</div>
    <p class="gd-example-q">${esc(g.exampleQ)}</p>
    <ul class="gd-rows">
${rowsHtml(g.exampleRows)}
    </ul>
    <p class="gd-lede">${esc(g.focusLabel)}</p>
    <ul class="gd-rows">
${rowsHtml(g.focusRows)}
    </ul>
    <p class="gd-lede">${esc(g.closing)}</p>
  </section>
  <div class="gp-actions"><a class="btn primary" href="/">${esc(g.cta)}</a></div>`;

  return page({
    title: `${g.title} · Intuitive Notes 直覺筆記`,
    desc: metaDesc(`${g.overviewLede}${g.cards.map((c) => `${c.name}：${c.line}`).join('')}`),
    path: '/guide/',
    breadcrumb: [HOME, HUB],
    body,
  });
}

// ---- 各工具頁 /guide/<slug>/ ----
function toolPage(sec, slug) {
  const others = SLUGS.filter((x) => x.slug !== slug);
  const body = `${crumbHtml([HOME, HUB, { name: sec.name, path: `/guide/${slug}/` }])}
  <h1 class="r-title">${esc(sec.name)}</h1>
  <div class="rule-orn" aria-hidden="true"></div>
  <p class="gd-lede">${esc(sec.lede)}</p>
  <div class="gd-meta">
    <h2 class="gd-label">${esc(sec.metaLabel)}</h2>
    <p class="gd-meta-text">${rawHtml(sec.meta)}</p>
  </div>
  <div class="gd-asks">
    <h2 class="gd-label">${esc(sec.asksLabel)}</h2>
    <ul class="gd-ask-list">
${sec.asks.map((a) => `      <li>${esc(a)}</li>`).join('\n')}
    </ul>
  </div>${sec.note ? `\n  <p class="gd-note">${esc(sec.note)}</p>` : ''}
  <div class="rule-orn" aria-hidden="true"></div>
  <div class="gp-actions"><a class="btn primary" href="/">${esc(g.cta)}</a></div>
  <p class="gp-more">${others.map((o) => `<a href="/guide/${o.slug}/">${esc(o.expect)}</a>`)
    .join('<span aria-hidden="true">·</span>')}<span aria-hidden="true">·</span><a href="/guide/">${esc(g.title)}</a></p>`;

  return page({
    title: `${sec.name} · ${g.title} · Intuitive Notes 直覺筆記`,
    desc: metaDesc(sec.lede),
    path: `/guide/${slug}/`,
    breadcrumb: [HOME, HUB, { name: sec.name, path: `/guide/${slug}/` }],
    body,
  });
}

// ---- 產出 ----
// 名稱換位就停下來：網址代號是寫死對應到陣列位置的，順序一變就會把使用者帶到
// 錯的頁面，而那種錯誤不會有任何徵兆。
SLUGS.forEach((s, i) => {
  const got = g.sections[i] && g.sections[i].name;
  if (got !== s.expect) {
    throw new Error(`guide.sections[${i}] 應為「${s.expect}」，實際是「${got}」。`
      + '順序或名稱改過了——請一併確認 SLUGS 的對應，網址不可隨文案變動。');
  }
});

const files = new Map([
  ['guide/index.html', hubPage()],
  ...SLUGS.map((s, i) => [`guide/${s.slug}/index.html`, toolPage(g.sections[i], s.slug)]),
]);

const check = process.argv.includes('--check');
let drift = 0;
for (const [rel, html] of files) {
  const abs = join(ROOT, rel);
  if (check) {
    const cur = await readFile(abs, 'utf8').catch(() => null);
    if (cur !== html) { drift++; console.error(`DRIFT ${rel}`); }
    continue;
  }
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, html);
  console.log(`wrote ${rel}  (${html.length} bytes)`);
}
if (check) {
  console.log(drift ? `${drift} 個檔案與字典不一致——請重跑 node tools/build-guide.mjs`
    : `OK  ${files.size} 個檔案與字典一致`);
  process.exit(drift ? 1 : 0);
}
