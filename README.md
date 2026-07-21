# 拖延探索（Procrastination Inquiry）

這不是一個教你打敗拖延的網站，而是一個協助使用者探索——**「我真正為什麼沒有往前走？」**——的體驗。透過雷諾曼、梅花易數、AI 對話引導與信念探索，協助使用者理解：拖延背後真正的原因、阻力來自哪裡、下一步真正適合自己的方向。

首頁即體驗（`index.html`）。依《AI 拖延探索網站規格 v1.0》實作。

## 流程（無問答互動版）

```
首頁：輸入拖延情境
      ↓
占卜一：雷諾曼——36 張牌全數列出（牌背朝上、順序洗亂），
        使用者親手憑直覺選出 9 張，依序落入九宮格
        （過去/現在/走向 × 想法/現實/潛意識）
      ↓
占卜二：梅花易數——使用者憑直覺報三個 1–100 的數字（報數起卦；跳過則以時間起卦）
      ↓
AI 交叉整合（單次呼叫）：描述＋牌陣＋卦象——內部依機制透鏡建立假說，
兩個占卜來源必須綜合起來一起看（收斂與互補），不可只依單一來源
      ↓
最後分析（五段式）：
  拖延真正可能代表什麼 / 正在運作的核心信念 / 牌與卦共同指出的方向
  / 目前真正需要的是什麼 / 一個最值得嘗試的小行動
  ＋「對應說明 · 牌與卦」（唯一出現牌名卦名的區塊）＋一句收尾
```

## AI 幕後知識（規格第四、九節）

假說引擎**絕不預設「拖延＝懶惰」**。假說機制透鏡：**Timing**（其實不是現在）、**Fear**（怕失敗/成功/被看見/責任/改變/未知）、**Beliefs**（「我一定要／應該／不能……」）、**Method**（不是不想做，是方法不合——完美主義、沒有允許迭代）、**Excitement**（是否在做別人的人生）、**Worthiness**（我配不上／還沒準備好）、**Identity**（成功了我會變成誰）、**Emotional Avoidance**（迴避的是情緒不是事情）、**Energy**（耗能與分散）。特別辨別 **Timing vs Fear**：真正的等待與恐懼造成的不前進。

重要規則：

- **使用者親手選牌**：36 張牌背朝上全數列出，選取順序決定九宮格位置；可「重選」。
- **假說不是診斷**：全程假說語氣（「可能」「似乎」）——證據只有一段描述與占卜讀數，不寫成定論。
- **兩源必須綜合**：direction／need／action 一律是雷諾曼＋梅花易數交叉之後（再對照描述）的結論。
- **牌面可見、正文無術語、依據透明**：分析正文不出現牌名卦名術語（prompt 約束 + `inquiry.js` 的 `sanitize`）；末尾「對應說明」區塊點名關鍵牌與卦，攤開工作底稿。
- **不預測、不決定論**：過程性語言；不提供醫療/法律/財務建議；不下診斷。
- **危機攔截**：入口偵測自我傷害訊號即中止，顯示關懷資源頁。
- **離線後備（從簡）**：未設金鑰或 AI 失敗時，分析用規則式模板產出——體驗可完整走完，個人化是線上（AI）路徑專屬。

## 部署（Vercel）

1. 於 [vercel.com](https://vercel.com) 匯入此 repo（Framework 選 Other，Build 設定全部留空）。
2. 設定金鑰環境變數（擇一即可，兩者皆設時優先 OpenAI）：
   - `OPENAI_API_KEY` — 走 OpenAI（預設 gpt-5.1，可用 `OPENAI_MODEL_STRONG` 覆寫）
   - `ANTHROPIC_API_KEY` — 走 Claude（[Anthropic Console](https://platform.claude.com) 取得）
3. Deploy。開啟 `https://<專案名>.vercel.app/` 即可開始探索。

未設金鑰亦可部署（離線後備模式）。補設金鑰後記得 **Redeploy** 才會生效。

### 本地開發

```bash
python3 -m http.server 8000   # 離線後備模式，開 http://localhost:8000/
vercel dev                     # 含 AI 代理（需 OPENAI_API_KEY 或 ANTHROPIC_API_KEY）
```

頁面使用原生 ES modules，需透過 HTTP（非 `file://`）開啟。無任何建置步驟。

## 使用的模型

每場探索 **1 次呼叫**：

- **analyze**（交叉整合＋最後分析）：Opus 4.8（或 OpenAI gpt-5.1，可用 `OPENAI_MODEL_STRONG` 覆寫）

## 檔案結構

```
index.html               入口（首頁）＋全部畫面
css/calm.css             沉靜主題（深夜墨色、暖紙感、牌池選牌）
js/app.js                頂層流程控制（輸入 → 選牌 → 報數 → 分析）
js/engine/session.js     探索狀態 + localStorage 續玩
js/engine/inquiry.js     探索引擎（AI/離線雙路徑、對應說明、sanitize）
js/engine/lenormand.js   雷諾曼引擎（選牌/抽牌、九宮格語義、主題群集）
js/engine/meihua.js      梅花易數引擎（報數/時間起卦、本互變卦、體用生剋）
js/content/crisis.js     危機關鍵字攔截
js/content/templates.js  離線後備（分析素材）
js/ai/client.js          對 /api/insight 的 fetch 包裝
data/lenormand.js        36 牌內部詮釋 + 主題群集 + 宮位語義
data/hexagrams.js        64 卦內部詮釋 + 八卦五行 + 階段語義
api/insight.js           Vercel serverless 代理（analyze，structured outputs、速率限制）
prompts/system.js        拖延機制幕後知識、假說方法論與護欄
```

## 內容來源與聲明

- 雷諾曼牌義與梅花易數卦義為依公開傳統詮釋撰寫的內部參考資料，作為建立心理假說的素材之一；不作占卜宣稱。
- 本平台為自我探索式互動體驗，非醫療、法律或財務建議，亦非心理治療；若你正處於危機中，請聯繫在地的心理支持專線（台灣：1925／1995／1980）。

## 授權

程式碼以 MIT 授權釋出。
