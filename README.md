# 靈感訊息（Inspiration Message）

「今天想獲得什麼靈感訊息？」——帶著一個想被啟發的主題（事業、創作、感情、人生方向……），親手從 36 張雷諾曼牌中選出 9 張、憑直覺報三個數起卦；系統把「你的主題＋牌陣＋卦象」交叉比對，綜合成一則直接寫給你的靈感訊息。

首頁即體驗（`index.html`）。不逐牌解釋、不逐卦解說——輸出是一篇渾然一體的正式文字。

## 流程

```
首頁：輸入「我想獲得什麼的靈感」（附範例：事業／創作／感情／人生方向）
      ↓
占卜一：雷諾曼——36 張牌全數列出（牌背朝上、順序洗亂），
        使用者親手憑直覺選出 9 張，依序落入九宮格
        （過去/現在/走向 × 想法/現實/潛意識）
      ↓
占卜二：梅花易數——使用者憑直覺報三個 1–100 的數字（報數起卦；跳過則以時間起卦）
      ↓
AI 交叉整合（單次呼叫）：找出兩套讀數的收斂與互補之處，對照主題
      ↓
靈感訊息：標題 + 350–550 字的綜合正式內容（3–4 段：核心狀態 →
醞釀中的事／阻力或盲點／時機節奏 → 方向啟發＋一個小行動）+ 一句祝福
```

重要規則：

- **使用者親手選牌**：36 張牌背朝上全數列出，選取順序決定九宮格位置；可「重選」。
- **兩源必須綜合**：訊息建立在雷諾曼與梅花易數的交集上，再對照主題落地；不逐牌逐卦解釋。
- **正文無術語**：不出現牌名、卦名、任何占卜術語（prompt 約束 + `inquiry.js` 的 `sanitize` 最後防線）。
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
api/insight.js           Vercel serverless 代理（analyze，structured outputs、速率限制）
prompts/system.js        靈感訊息引擎人格、交叉比對方法論與護欄
```

## 內容來源與聲明

- 雷諾曼牌義與梅花易數卦義為依公開傳統詮釋撰寫的內部參考資料，作為綜合訊息的素材；不對使用者呈現、不作占卜宣稱。
- 本平台為自我探索式互動體驗，非醫療、法律或財務建議，亦非心理治療；若你正處於危機中，請聯繫在地的心理支持專線（台灣：1925／1995／1980）。

## 授權

程式碼以 MIT 授權釋出。
