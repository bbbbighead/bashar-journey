# 照見（Reflection）— AI 自我探索對談平台

一場安靜的對談＋兩段占卜儀式：帶著一件你正在思索的事坐下來，系統先用三個問題聽你的敘事、彙整確認理解；接著進入占卜——翻開為你抽出的雷諾曼九宮格、憑直覺報三個數字起卦；最後把「你說的話、九張牌、你報的數」三樣東西交叉比對，給你一份完整的「照見」：你真正在問的是什麼、值得探索的張力、留給你的問題、以及一個可帶走的小實驗。

首頁即對談（`index.html`）。這不是算命網站、不是 AI 治療師——AI 在這裡是「洞察整合引擎」（Insight Integration Engine），不是答案產生器。

## 設計理念

依《AI Self-Discovery Platform — System Specification》實作，核心原則：**敘事為地基、符號系統為額外視角、輸出必須是一份統一的理解**。

管線（規格書七階段 → 實際流程）：

```
使用者敘事收集（開場提問 + 3 個追問：現況 → 感受與身體 → 重複模式與渴望）
      ↓
彙整回照（mirror：確認聽對了沒 + 內部個案模型）＋使用者可修正補充
      ↓
占卜一：雷諾曼九宮格——36 牌抽 9 張，玩家逐一翻牌（牌面可見），
        位置語義（時間軸 × 意識層）＋主題群集統計進入內部讀數
      ↓
占卜二：梅花易數——玩家憑直覺報三個 1–100 的數字（報數起卦；跳過則以時間起卦），
        本互變卦、體用五行生剋 → 時機與動能讀數
      ↓
三源交叉比對（AI 比較敘事、牌陣、卦象：收斂主題、互補、矛盾）
      ↓
照見文件（單一整合文件，不逐牌逐卦說明）：
  我所理解的你 / 另一種視角 / 值得探索的張力 / 留給你的問題 / 一個小實驗
```

重要規則：

- **牌面可見、解讀整合**：玩家看得到抽出的九張牌與位置，但所有文字解讀都是三源交叉彙整後的產出——不逐牌說明、不逐卦解釋，卦名與技術語彙也不出現在文字中（prompt 硬性約束 + `integrate.js` 的 `sanitize` 最後防線）。
- **矛盾不是錯誤**：各來源的矛盾呈現為「值得探索的張力」。
- **不預測、不決定論**：只用過程性語言（動能、節奏、正在成形的方向），不替使用者做決定；不提供醫療/法律/財務建議。
- **全程可離線**：未設金鑰或 AI 失敗時，靜默降級——固定提問集 + 符號引擎的規則式整合（`templates.js` + `offlinePatterns`/`offlineDynamics`），整場對談仍能完整走完。
- **危機攔截**：入口與對談中途偵測到自我傷害訊號即中止，顯示固定的關懷資源頁。

## 部署（Vercel）

1. 於 [vercel.com](https://vercel.com) 匯入此 repo（Framework 選 Other，Build 設定全部留空）。
2. 設定金鑰環境變數（擇一即可，兩者皆設時優先 OpenAI）：
   - `OPENAI_API_KEY` — 走 OpenAI（模型預設 gpt-5.1／gpt-5-mini，可用 `OPENAI_MODEL_STRONG`、`OPENAI_MODEL_LIGHT` 覆寫）
   - `ANTHROPIC_API_KEY` — 走 Claude（[Anthropic Console](https://platform.claude.com) 取得）
3. Deploy。開啟 `https://<專案名>.vercel.app/` 即可開始對談。

未設金鑰亦可部署，將以離線模板模式運行。事後補設金鑰記得到 Deployments 按 **Redeploy** 才會生效。

### 本地開發

```bash
python3 -m http.server 8000   # 離線模式，開 http://localhost:8000/
vercel dev                     # 含 AI 代理（需 OPENAI_API_KEY 或 ANTHROPIC_API_KEY）
```

頁面使用原生 ES modules，需透過 HTTP（非 `file://`）開啟。無任何建置步驟。

## 使用的模型

依角色分層（每場對談約 5 次呼叫）：

- **followup**（敘事追問 ×3）：輕量模型 — Haiku 4.5 / gpt-5-mini
- **mirror**（理解回照 + 個案模型）：強模型 — Sonnet 5 / gpt-5.1
- **integrate**（多源整合照見）：最強模型 — Opus 4.8 / gpt-5.1

## 檔案結構

```
index.html               對談入口（首頁）
css/calm.css             沉靜主題（深夜墨色、暖紙感）
js/app.js                頂層流程控制（敘事 → 回照 → 整理 → 照見）
js/engine/session.js     對談狀態 + localStorage 續談
js/engine/integrate.js   洞察整合引擎（AI/離線降級雙路徑、去識別 sanitize）
js/engine/lenormand.js   雷諾曼引擎（抽牌、九宮格語義、模式摘要）
js/engine/meihua.js      梅花易數引擎（起卦、本互變卦、體用生剋）
js/content/crisis.js     危機關鍵字攔截
js/content/templates.js  離線模板（提問集、回照、反思提問、小實驗）
js/ai/client.js          對 /api/insight 的 fetch 包裝
data/lenormand.js        36 牌內部詮釋 + 主題群集 + 宮位語義
data/hexagrams.js        64 卦內部詮釋 + 八卦五行 + 階段語義
api/insight.js           Vercel serverless 代理（模型分層、structured outputs、速率限制）
prompts/system.js        洞察整合引擎人格與護欄
```

## 內容來源與聲明

- 雷諾曼牌義與梅花易數卦義為依公開傳統詮釋撰寫的內部參考資料，僅作為多視角整合的素材之一，不對使用者呈現、不作占卜宣稱。
- 本平台為自我探索式互動體驗，非醫療、法律或財務建議，亦非心理治療；若你正處於危機中，請聯繫在地的心理支持專線（台灣：1925／1995／1980）。

## 授權

程式碼以 MIT 授權釋出。

---

*前身為「心之星旅（Bashar Journey）」，舊版保留於 `main` 分支歷史。*
