# 心之星旅（Bashar Journey）

一趟沉浸式的心靈對話旅程：帶著一個你正在思索的問題出發，系統為你的提問生成一個獨一無二的世界；沿途以開放式提問與你對話，並「沿路拾得」直接呼應你脈絡的訊息；最後綜合聽下來的一切，給你一個直指核心的回應與可帶走的練習。

首頁即遊戲（`index.html`）。姊妹作「巴夏訊息抽卡站」發布於 [bashar-message-card](https://github.com/bbbbighead/bashar-message-card) 的 GitHub Pages。

## 怎麼運作

核心設計原則：**確定性骨架 + AI 填風味**。

- 旅程結構固定 8 站（啟程 →（對話 → 拾得）×3 → 回應），推進、選卡、參數夾限、schema 驗證全由前端模板引擎掌管。
- AI（透過 serverless 代理）負責「風味與傾聽」：生成世界、開放式提問、讀你的回答並寫出個人化的拾得訊息、最後的核心回應。
- 你的提問與每一次自由文字回答會蒸餾成「Journey Context Block」注入每一次 AI 呼叫——系統從中讀出思考脈絡、慣性與盲點。
- **全程可離線遊玩**：未設金鑰或 AI 呼叫失敗時，靜默降級到手寫主題包（寵物／關係／職涯／健康／天命／通用）；離線時也會從回答文字萃取關鍵字來挑選訊息。
- 內建危機關鍵字攔截：偵測到自我傷害等訊號時不進遊戲，顯示固定的關懷資源頁。

## 部署（Vercel）

1. 於 [vercel.com](https://vercel.com) 匯入此 repo（Framework 選 Other，Build 設定全部留空）。
2. 設定金鑰環境變數（擇一即可，兩者皆設時優先 OpenAI）：
   - `OPENAI_API_KEY` — 走 OpenAI（[platform.openai.com](https://platform.openai.com) 取得；模型預設 gpt-5.1／gpt-5-mini，可用 `OPENAI_MODEL_STRONG`、`OPENAI_MODEL_LIGHT` 環境變數覆寫）
   - `ANTHROPIC_API_KEY` — 走 Claude（[Anthropic Console](https://platform.claude.com) 取得）
3. Deploy。開啟 `https://<專案名>.vercel.app/` 即可遊玩。

未設金鑰亦可部署，將以離線模板模式運行。事後補設金鑰記得到 Deployments 按 **Redeploy** 才會生效。

### 本地開發

```bash
python3 -m http.server 8000   # 離線模式，開 http://localhost:8000/
vercel dev                     # 含 AI 代理（需 OPENAI_API_KEY 或 ANTHROPIC_API_KEY）
```

頁面使用原生 ES modules，需透過 HTTP（非 `file://`）開啟。無任何建置步驟。

## 使用的模型

依角色分層（每局約 8 次呼叫）：世界生成、拾得訊息與最終回應用強模型，開放式提問用輕量模型。

- **OpenAI**（設 `OPENAI_API_KEY`）：預設 gpt-5.1（強）／gpt-5-mini（輕），可用 `OPENAI_MODEL_STRONG`、`OPENAI_MODEL_LIGHT` 覆寫成你帳號可用的型號。
- **Claude**（設 `ANTHROPIC_API_KEY`）：Sonnet 5（世界／拾得）、Haiku 4.5（提問）、Opus 4.8（最終回應）。

## 檔案結構

```
index.html            遊戲入口（首頁）
data/cards.js         917 則訊息原型資料
css/cosmic.css        宇宙主題（星空、翻牌、光紋）
css/game.css          旅程樣式
js/engine/            狀態、站點、參數（連續性引擎）、orchestrator（AI/降級）
js/content/           靜態主題包、意圖分類與危機攔截
js/ai/client.js       對 /api/journey 的 fetch 包裝
js/ui/                場景、翻牌、畫面控制
api/journey.js        Vercel serverless 代理（模型分層、structured outputs、速率限制）
prompts/system.js     敘事引擎人格與護欄
```

## 內容來源與版權

- 訊息內容以靈性傳訊者 Darryl Anka 所傳訊之「巴夏（Bashar）」教導為原型參考，僅供個人靈性參考與非商業用途；相關原文之版權歸原作者／傳訊者所有。若為版權方且不希望內容出現於此，歡迎透過 GitHub Issue 聯繫。
- 本遊戲為心靈式互動體驗，非醫療、法律或財務建議。

## 授權

程式碼（HTML/CSS/JS）以 MIT 授權釋出；訊息文字內容不在此授權範圍內（見上方版權說明）。
