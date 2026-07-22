# 靈感訊息（Inspiration Message）

「今天想獲得什麼靈感訊息？」——帶著一個想被啟發的主題（事業、創作、感情、人生方向……），親手從 36 張雷諾曼牌中選出 9 張、憑直覺報三個數起卦、（可選）提供出生資料精算西洋占星本命盤；系統把三套系統視為三個觀測角度交叉比對，綜合成一則直接寫給你的靈感訊息。

首頁即體驗（`index.html`）。不逐牌、不逐卦、不逐星解釋——輸出是一篇渾然一體的跨系統整合敘事。

## 流程

```
首頁：輸入「我想獲得什麼的靈感」（附範例：事業／創作／感情／人生方向）
      ↓
占卜一：雷諾曼——36 張牌全數列出（牌背朝上、順序洗亂），
        使用者親手憑直覺選出 9 張，依序落入九宮格
        （過去/現在/走向 × 想法/現實/潛意識）→ 觀測「現實如何表現」
      ↓
占卜二：梅花易數——報三個 1–9 的單位數字起卦（可請系統隨機選，選出的數字會顯示；
        也可「讓此刻的時間替我決定」以當下時間起卦）
        → 觀測「現在處於哪個階段」
      ↓
占卜三：西洋占星——出生日期/時間/城市 → Swiss Ephemeris 精算本命盤
        （熱帶黃道、Placidus、真北交、平均莉莉絲、地心；可跳過）
        → 觀測「為什麼會這樣」（長期結構）
      ↓
AI 跨系統整合（單次呼叫）：主題萃取 → 重複呼應/相互補充/表面矛盾 →
確定程度分層 → 聚焦主題
      ↓
靈感訊息：標題 + 450–800 字整合敘事（依核心脈絡而非工具分類推進）+ 一句祝福
```

## 西洋占星計算（api/astro.py）

- **全部實算**：行星（日月水金火木土天海冥）、真北交/南交、凱龍、平均黑月莉莉絲、穀神/智神/婚神/灶神、四軸（ASC/DSC/MC/IC）、福點、Vertex——由 Swiss Ephemeris（pyswisseph）計算，星曆檔（`api/ephe/`，含主小行星檔 seas_18.se1，放在函式目錄內確保隨 serverless 打包）；AI 只詮釋、不補造數據。
- 十二宮（Placidus）宮頭與傳統宮主星（現代共管星補充）、主/次要相位（一致的容許度政策、入相出相依實際速度與逆行判斷）、四元素/三模式/陰陽/半球象限分布、尊貴、傳統定位星鏈（最終定位星/循環/互容）、格局偵測（大三角、T三角、大十字、上帝之指、群星、無主相位行星、攔截星座）。
- **出生時間不確定**：以當地正午計算行星星座，明確標示上升/宮位/福點/Vertex/月亮精確度不可靠（不輸出宮位）。
- 地點以 Open-Meteo 免費 geocoding 解析（含 IANA 時區），歷史日光節約時間由 zoneinfo 處理。出生資料（日期/時辰/城市＋解析出的地點/時區/UTC 與日月升星座）會隨紀錄匿名保存於後台供分析（前台已揭露）；不對外顯示。
- 授權注意：pyswisseph／Swiss Ephemeris 採 AGPL（或商業授權）；本 repo 的 MIT 授權不涵蓋該相依套件與星曆檔。

重要規則：

- **使用者親手選牌**：36 張牌背朝上全數列出，選取順序決定九宮格位置；可「重選」。
- **兩源必須綜合**：訊息建立在雷諾曼與梅花易數的交集上，再對照主題落地；不逐牌逐卦解釋。
- **訊息不揭示出處**：正文不提雷諾曼／梅花易數／星盤，也不出現「幾套系統」「交叉比對」等方法論字眼——就是一封直接寫給諮詢者的信（prompt 約束 + `inquiry.js` 的 `sanitize` 最後防線）。原始素材（牌、數、星盤三要點）弱化為結果頁文末的細字索引；文末另有「查看詳細進階報告」按鈕（結合牌卡、卦象與星盤的詳細報告解說——功能陸續開放）。
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
index.html               入口（首頁）＋全部畫面
css/calm.css             沉靜主題（深夜墨色、暖紙感、牌池選牌）
js/app.js                頂層流程控制（輸入 → 選牌 → 報數 → 靈感訊息）
js/engine/session.js     狀態 + localStorage 續玩
js/engine/inquiry.js     綜合引擎（AI/離線雙路徑、sanitize）
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
prompts/system.js        靈感訊息引擎人格、交叉比對方法論與護欄
```

## 內容來源與聲明

- 雷諾曼牌義與梅花易數卦義為依公開傳統詮釋撰寫的內部參考資料，作為綜合訊息的素材；不對使用者呈現、不作占卜宣稱。
- 本平台為自我探索式互動體驗，非醫療、法律或財務建議，亦非心理治療；若你正處於危機中，請聯繫在地的心理支持專線（台灣：1925／1995／1980）。

## 授權

程式碼以 MIT 授權釋出。
