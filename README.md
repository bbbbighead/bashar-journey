# 靈感訊息（Inspiration Message）

Intuitive Notes（MVP）——輸入一個想探索的主題，自由勾選一到三個分析工具（雷諾曼牌陣、梅花易數、西洋占星），系統為每個所選工具產出一節完整解析；選兩個以上時，最後再加一節「交叉比對綜合分析」。八字、紫微斗數、塔羅牌顯示為 Coming Soon（暫不可選）。

首頁即體驗（`index.html`）。

## 流程

```
首頁：輸入「你今天想探索什麼主題？」＋勾選分析工具（可複選）
      · 可選：雷諾曼牌陣、梅花易數、西洋占星
      · Coming Soon（disabled）：八字、紫微斗數、塔羅牌
      ↓
依所選工具依序蒐集資料：
      雷諾曼——36 張牌全數列出（牌背朝上），憑直覺選 9 張（點選=發光、再點=取消）
      梅花易數——憑直覺輸入 3 個個位數（1–9；可隨機選或以當下時間起卦）
      西洋占星——出生日期/時間/城市 → Swiss Ephemeris 精算本命盤
      ↓
AI 分析（單次呼叫）：每個所選工具一節完整解析；
      兩個以上工具 → 最後加「交叉比對綜合分析」
      ↓
結果：標題 + 分節解析（雷諾曼/梅花/占星/綜合）+ 一句結語
```

- **雷諾曼**：九宮格（3×3）以牌組組合解讀——時間軸（過去 1/4/7、現在 2/5/8、未來 3/6/9）、三層意識（意識 1/2/3、現實 4/5/6、潛意識 7/8/9）、十字法（核心 5、十字 2/4/6/8、四角 1/3/7/9），整理成一個完整的生命故事。
- **梅花易數**：本卦 → 變卦 → 動爻 → 卦象含義 → 對應問題的解讀 → 行動建議。
- **西洋占星**：不固定分析整張盤，依主題主動挑選所有高度相關的配置（宮位、宮主星、飛星、相位、Vesta 等），整理成一條完整脈絡。
- **交叉比對綜合分析**：找出各工具共同反覆出現的核心與互補之處，整理出最重要的生命主題與下一步方向；不取代各工具的完整解析。

## 西洋占星計算（api/astro.py）

- **全部實算**：行星（日月水金火木土天海冥）、真北交/南交、凱龍、平均黑月莉莉絲、穀神/智神/婚神/灶神、四軸（ASC/DSC/MC/IC）、福點、Vertex——由 Swiss Ephemeris（pyswisseph）計算，星曆檔（`api/ephe/`，含主小行星檔 seas_18.se1，放在函式目錄內確保隨 serverless 打包）；AI 只詮釋、不補造數據。
- 十二宮（Placidus）宮頭與傳統宮主星（現代共管星補充）、主/次要相位（一致的容許度政策、入相出相依實際速度與逆行判斷）、四元素/三模式/陰陽/半球象限分布、尊貴、傳統定位星鏈（最終定位星/循環/互容）、格局偵測（大三角、T三角、大十字、上帝之指、群星、無主相位行星、攔截星座）。
- **出生時間不確定**：以當地正午計算行星星座，明確標示上升/宮位/福點/Vertex/月亮精確度不可靠（不輸出宮位）。
- 地點以 Open-Meteo 免費 geocoding 解析（含 IANA 時區），歷史日光節約時間由 zoneinfo 處理。出生資料（日期/時辰/城市＋解析出的地點/時區/UTC 與日月升星座）會隨紀錄匿名保存於後台供分析（前台已揭露）；不對外顯示。
- 授權注意：pyswisseph／Swiss Ephemeris 採 AGPL（或商業授權）；本 repo 的 MIT 授權不涵蓋該相依套件與星曆檔。

重要規則：

- **不逐項解牌**：每個工具的解析都圍繞主題，把整副牌／整個卦／整張盤共同描述的生命故事整理出來，而不是逐張逐顆零碎解釋。結果頁另有「直覺對話」按鈕（一對一語音諮詢——建構中）。
- **文風：洞察感優先於文學感**：自然、成熟、口語的人類語感；標題用日常的話、不造詩意詞組；一句話最多一到兩個抽象名詞；不加沒有鋪陳的比喻；每句話都要有清楚的意思，只營造氣氛的句子刪掉；依「觀察 → 解釋 → 推論 → 建議」推進。
- **介面原則**：簡潔、易讀、留白充足；每句文案簡短自然；使用者閱讀體驗優先於神秘感或詩意；亮度以一般手機中等亮度可輕鬆閱讀為基準。
- **不預測、不決定論**：過程性語言；不提供醫療/法律/財務建議；不下診斷。
- **危機攔截**：入口偵測自我傷害訊號即中止，顯示關懷資源頁。
- **離線後備（從簡）**：未設金鑰或 AI 失敗時，以引擎讀數＋固定段落拼出訊息——體驗可完整走完，個人化是線上（AI）路徑專屬。

## 部署（Vercel）

1. 於 [vercel.com](https://vercel.com) 匯入此 repo（Framework 選 Other，Build 設定全部留空）。
2. 設定金鑰環境變數（擇一即可，兩者皆設時優先 OpenAI）：
   - `OPENAI_API_KEY` — 走 OpenAI（預設 gpt-5.1，可用 `OPENAI_MODEL_STRONG` 覆寫）
   - `ANTHROPIC_API_KEY` — 走 Claude（[Anthropic Console](https://platform.claude.com) 取得）
3. Deploy。開啟 `https://<專案名>.vercel.app/` 即可開始。

未設金鑰亦可部署（離線後備模式）。補設金鑰後記得 **Redeploy** 才會生效。

### 後台管理（/admin.html）

後台提供三類分析：使用者歷史紀錄（來訪時間、題目與產出）、來源與裝置分析、各頁面平均停留時間；「資料範圍」選單（僅有題目／全部／僅未完成）一次套用到所有統計與清單。單筆詳情記錄實際送給模型的完整 prompt（System＋User，可分段檢視），並附**除錯問答視窗**——問題會連同當時的 prompt 與產出一併送給 LLM，可直接詢問「這段結果是根據什麼產生的」。啟用需兩項設定：

1. **儲存後端**：於 Vercel 專案 → Storage → Marketplace 安裝 **Upstash Redis**（免費方案即可），安裝後 `UPSTASH_REDIS_REST_URL` 與 `UPSTASH_REDIS_REST_TOKEN` 會自動注入（舊版 `KV_REST_API_URL/TOKEN` 命名亦相容）。
2. **管理密碼**：環境變數 `ADMIN_PASSWORD`（自訂一組強密碼）。

設定後 Redeploy，開 `https://<專案名>.vercel.app/admin.html` 以密碼登入。未設定時：埋點靜默不寫入、後台顯示未啟用，前台體驗完全不受影響。

資料皆為匿名（隨機訪客 ID），**不設時間過期**。保存以容量為準：後台總覽顯示「容量使用 %」（估算，含重算按鈕），容量上限由 `STORAGE_LIMIT_MB` 控制（預設 256＝Upstash 免費方案）；用量達 **95%** 時系統自動從最舊的紀錄開始刪除、維持在 95% 以下，並在後台顯示警示橫幅（含已汰舊筆數），提醒你考慮升級容量。後台亦可勾選多筆批次刪除、對單筆加自由文字標註（統計與用量同步回扣）。

### 本地開發

```bash
python3 -m http.server 8000   # 離線後備模式，開 http://localhost:8000/
vercel dev                     # 含 AI 代理（需 OPENAI_API_KEY 或 ANTHROPIC_API_KEY）
```

頁面使用原生 ES modules，需透過 HTTP（非 `file://`）開啟。無任何建置步驟。

## 使用的模型

每場體驗 **1 次呼叫**：

- **analyze**（交叉整合＋靈感訊息）：Opus 4.8（或 OpenAI gpt-5.1，可用 `OPENAI_MODEL_STRONG` 覆寫）

## 檔案結構

```
index.html               入口（首頁：主題＋工具選擇）＋全部畫面
css/calm.css             星圖攝影主題（照片背景＋可讀性暗色塗層、柔光金線元件）
assets/bg-square.jpg     背景攝影（橫向視窗；站主提供的星圖影像素材）
assets/bg-portrait.jpg   背景攝影（直向視窗與後台）
js/app.js                頂層流程控制（主題＋選工具 → 依序蒐集 → 分節結果）
js/engine/session.js     狀態 + localStorage 續玩
js/engine/inquiry.js     分析引擎（AI/離線雙路徑、分節輸出）
js/engine/lenormand.js   雷諾曼引擎（選牌/抽牌、九宮格語義、主題群集）
js/engine/meihua.js      梅花易數引擎（報數/時間起卦、本互變卦、體用生剋）
js/content/crisis.js     危機關鍵字攔截
js/content/templates.js  離線後備（訊息段落素材）
js/ai/client.js          對 /api/insight 的 fetch 包裝
data/lenormand.js        36 牌內部詮釋 + 主題群集 + 宮位語義
data/hexagrams.js        64 卦內部詮釋 + 八卦五行 + 階段語義
api/astro.py             西洋占星本命盤計算＋城市搜尋（Python + pyswisseph；api/ephe/ 星曆檔）
data/countries.js        ISO 3166 國家/地區代碼（顯示名由 Intl.DisplayNames 產生）
requirements.txt         Python 相依（pyswisseph）
api/insight.js           Vercel serverless 代理（analyze，structured outputs、速率限制）
api/track.js             匿名埋點收集（來訪/停留/題目 → Upstash Redis）
api/admin.js             後台查詢（總覽/來訪清單/單次詳情，ADMIN_PASSWORD 驗證）
lib/redis.js             Upstash Redis REST 極簡客戶端（零依賴）
admin.html + js/admin.js 管理儀表板（/admin.html，noindex）
js/analytics.js          前端埋點（sendBeacon，失敗靜默）
prompts/system.js        分析引擎人格、各工具解析規範與交叉綜合方法
```

## 內容來源與聲明

- 雷諾曼牌義與梅花易數卦義為依公開傳統詮釋撰寫的內部參考資料，作為綜合訊息的素材；不對使用者呈現、不作占卜宣稱。
- 本平台為自我探索式互動體驗，非醫療、法律或財務建議，亦非心理治療；若你正處於危機中，請聯繫在地的心理支持專線（台灣：1925／1995／1980）。

## 授權

程式碼以 MIT 授權釋出。
