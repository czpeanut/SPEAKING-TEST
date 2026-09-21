# 開發紀錄與技術交接文件

這份文件記錄這個專案從最初構想到目前狀態的完整技術決策過程，包含試過但放棄的方案、為什麼放棄、已修好的 bug 與根因、還沒解決的問題。目的是讓合併到其他專案時不會丟失這些脈絡——很多決策背後有實測數據支撐，不是憑感覺選的。

最後更新對應的 commit：本次批次影片生成改版（分支 `claude/zealous-thompson-93pmdy`）。**第 1-5 節是目前架構；第 6 節之後保留了完整的歷史演進記錄（包含已經放棄的即時問答虛擬人架構），合併專案時想知道「為什麼不是 X 方案」可以往下翻。**

---

## 1. 專案是什麼（目前版本）

使用者上傳一張正臉照片、輸入一段文件內容（貼上文字或上傳 .txt）→ 後端把文字合成語音、再把「照片＋語音」交給批次影片生成服務 → 回傳一支這張照片「講出這段內容」的 mp4 影片，可以線上播放或下載。**不是即時互動**：送出後要等待約 1-2 分鐘生成。

這是從更早的「即時問答虛擬人」（打字問問題、Gemini 即時回答、虛擬人用 WebRTC 即時嘴型同步唸出來）改版而來——需求從「即時互動」變成「輸入文件、拿到影片檔」，不再需要即時性，因此把 Simli 的即時串流整套換成批次影片生成 API（D-ID），詳見第 6.4 節。

## 2. 目前架構

```
使用者上傳照片（存 localStorage，下次免重傳）+ 貼上/上傳文件文字
      │
      ▼
POST /api/video/generate { photo: dataURL, text }
      │  伺服器立即回傳 { jobId }，背景非同步處理：
      ▼
sanitizeForSpeech(text) 清掉 Markdown/LaTeX 符號
      ▼
把上傳的照片存到暫存目錄，用 /tmp-media/<jobId>.<ext> 這個路徑公開提供
      ▼
synthesizeSpeech() ──────► Gemini TTS API (gemini-2.5-flash-preview-tts)
      │                     男聲 "Puck"，文字前面加一段「請逐字朗讀」指示避免被當成對話
      │◄──────────────────  回傳無檔頭 L16 PCM，後端補上 WAV 檔頭
      ▼
把 WAV 也存到同一個暫存目錄，用 /tmp-media/<jobId>.wav 這個路徑公開提供
      ▼
POST https://api.d-id.com/talks { source_url: 照片網址, script: { type: "audio", audio_url: 語音網址 } }
      │
      ▼
輪詢 GET /talks/{id} 直到 status === "done"，拿到 result_url
      ▼
前端輪詢 GET /api/video/status/:jobId，顯示 <video src=result_url> + 下載連結
```

後端（`server.js`）只做這些事，金鑰全部留在伺服器端：
1. `POST /api/video/generate`：驗證輸入、把照片存成暫存檔、建立工作、回傳 `jobId`，背景跑完整流程（TTS → 暫存音檔 → D-ID 建立工作 → 輪詢）
2. `GET /api/video/status/:id`：前端輪詢用，回傳工作目前狀態（`queued`/`synthesizing`/`rendering`/`done`/`error`）與完成後的 `videoUrl`
3. `/tmp-media/*`：暫存照片和語音檔的靜態路由，只給 D-ID 抓取用，工作結束或 15 分鐘後會被清掉

工作狀態存在記憶體（`Map`），不是資料庫——重啟伺服器會遺失所有進行中的工作，這對單一使用者的小工具是可接受的取捨，但合併到多實例/多 worker 的專案時要注意（見第 8 節）。

## 3. 檔案結構

```
server.js                      後端：/api/video/generate、/api/video/status/:id
render.yaml                    Render 部署設定（Blueprint）
package.json                   npm scripts：build（打包前端）
scripts/
  build-client.js              esbuild 打包 public/src/app.js → public/app.bundle.js
public/
  index.html                   頁面結構（Industry 設計系統，單卡片版面）
  style.css                    設計系統 tokens + 版面（藍圖風格：直角、四角測繪標記）
  src/app.js                   前端邏輯原始碼（會被打包成 app.bundle.js，不要直接改 bundle）
  app.bundle.js                打包產物，.gitignore 排除，每次改 src/app.js 後要重跑 npm run build
.env.example                   環境變數範本
```

**重要**：`public/src/app.js` 是原始碼，`public/app.bundle.js` 是 `npm run build` 的打包產物（esbuild），兩者不同步會導致改了程式碼但畫面沒變。合併到其他專案時，CI/CD 或部署流程要確保有跑 `npm run build`（`render.yaml` 的 `buildCommand` 已經包含）。

## 4. API 串接細節

### 4.1 Gemini 語音合成（`synthesizeSpeech()` → Gemini TTS generateContent）

```
POST https://generativelanguage.googleapis.com/v1beta/models/{GEMINI_TTS_MODEL}:generateContent
Header: x-goog-api-key: <GEMINI_API_KEY>
Body:
{
  "contents": [{ "parts": [{ "text": "請逐字朗讀以下文字，不要回答、不要評論、不要新增任何內容：<文件內容，已清洗過 Markdown/LaTeX>" }] }],
  "generationConfig": {
    "responseModalities": ["AUDIO"],
    "speechConfig": { "voiceConfig": { "prebuiltVoiceConfig": { "voiceName": "Puck" } } }
  }
}
```

回應是 base64 的**無檔頭 L16 PCM**（`mimeType` 字串裡帶 `rate=24000`），後端 `wavHeader()` 手動組 44-byte WAV 檔頭再存成檔案，因為 D-ID 需要一個完整的音檔容器格式，不能直接吃裸 PCM。

**踩過的坑**：直接把短句（例如「你好，這是一個測試。」）當 `text` 送進去，Gemini 有機率回傳 `400 INVALID_ARGUMENT`：「Model tried to generate text, but it should only be used for TTS」——模型把輸入當成一句要回應的話（像對話開場白），而不是要逐字唸出來的稿子。舊架構下沒踩到這個坑，是因為送進去的文字都是 Gemini 自己生成的問答回答（本來就是陳述句），這次是使用者自由輸入的文件內容，短的、口語化的句子容易觸發這個誤判。修法：在文字前面加一段明確指示（`withNarrationInstruction()`），跟 `withPaceDirection()` 的語速前綴是同一種技巧——這段指示本身不會被唸出來，只會被模型當成「不要回應、只朗讀」的指示。

Gemini TTS **不支援真正的逐段串流**：測過 `streamGenerateContent?alt=sse`，回應還是整段音訊一次送達（`chunks=1`），沒有邊生成邊送的效果——但批次影片生成本來就不需要串流，這個限制已經不是問題（舊架構下這是延遲的主因，見第 6.1、8 節）。

### 4.2 D-ID 批次影片生成（`createTalk()` / `pollTalk()`）

```
POST https://api.d-id.com/talks
Header: Authorization: Basic <DID_API_KEY 的 base64>
Body:
{
  "source_url": "https://<你的網域>/tmp-media/<jobId>.<jpeg|png>",
  "script": { "type": "audio", "audio_url": "https://<你的網域>/tmp-media/<jobId>.wav" },
  "config": { "stitch": true, "result_format": "mp4" }
}
回應: { "id": "tlk_xxx", "status": "created", ... }
```

**關鍵限制（都是直接打 API 實測出來的，跟 D-ID 一般文件描述有出入）**：
- `source_url` **不接受 data URL**，即使一般文件說支援——實測回傳 `400 ValidationError`：「must be a valid image URL (ending with jpg|jpeg|png)」，包含合法的 data URL 也一樣被拒絕。一定要是真正可以被 D-ID 伺服器抓到的網址。
- `audio_url` 也**不接受 data URL**，且副檔名必須是 `flac`/`mp3`/`mp4`/`wav`/`m4a` 其中之一，用其他副檔名（例如 `.ogg`）即使內容是有效音檔也會被 schema 直接拒絕。
- 兩者都**必須是 https**（不是單純「可連到」的問題）：本機測試時用 `http://localhost:...` 送出去，`audio_url` 的驗證訊息明確寫「must be a valid https URL」；`source_url` 雖然錯誤訊息沒有明講 https，但同樣被拒絕。這是為什麼本機用 `http://localhost` 跑無法真的生成影片（見第 8 節）——Render 部署後網址本身就是 https，這裡不用額外處理。
- 因為以上限制，這個專案把「使用者上傳的照片」和「Gemini TTS 產生的語音」都先寫進暫存目錄，用 `/tmp-media` 這個 Express 靜態路由公開提供，讓 D-ID 能抓到，工作結束或 15 分鐘後清掉暫存檔。

**曾經誤判過的地方**：第一次測試 `script.type: "audio"` 時用了一個 `.ogg` 的音檔網址，收到的錯誤訊息（union 型別的驗證錯誤，會同時列出多個候選 schema 各自失敗的原因）長得像「這個帳號只支援 `type: 'text'`」，一度誤以為是帳號/方案限制，因此在文件跟程式碼裡短暫改成用 D-ID 內建 TTS（`script.type: "text"` + `provider: { type: "microsoft", voice_id: "zh-CN-YunyangNeural" }`，這部分程式碼已經不在目前的 `server.js` 裡了）。換成正確副檔名（`.wav`）之後重測，`type: "audio"` 一樣能通過驗證，證實純粹是副檔名問題，不是帳號限制——目前這個專案維持用 `type: "audio"`，因為這樣語音仍然是 Gemini TTS 的男聲 `Puck`，D-ID 只負責嘴型同步，不用依賴 D-ID/Azure 的語音音色。如果之後合併專案時想省一個 API 呼叫（不用 Gemini TTS），`type: "text"` + `provider` 也是可行選項，只是聲音來源會變成 D-ID 的 TTS 供應商。

輪詢：
```
GET https://api.d-id.com/talks/{id}
Header: Authorization: Basic <DID_API_KEY>
回應: { "status": "created" | "started" | "done" | "error" | "rejected", "result_url": "...", ... }
```
`status === "done"` 才有 `result_url`（mp4 直連網址，D-ID 的 S3 之類的儲存，有效期間有限，不是永久網址——完成後應該讓使用者立即下載，不要指望這個網址長期有效）。`server.js` 用 `POLL_INTERVAL_MS = 3000`、`POLL_TIMEOUT_MS = 5 分鐘` 輪詢，超時會回傳錯誤。

**Authorization 格式**：D-ID 儀表板給的 API key 字串本身就是 `Basic` scheme 期待的值，直接接在 `Basic ` 後面即可，不需要自己再 base64 編碼一次。

**計費**：按生成秒數（額度）計費，是付費服務，見第 9 節。

## 5. 環境變數完整清單

| 變數 | 必要 | 說明 | 取得方式 |
|---|---|---|---|
| `GEMINI_API_KEY` | 是 | 語音合成用 | https://aistudio.google.com/apikey |
| `DID_API_KEY` | 是 | D-ID 帳號 key，直接貼儀表板上顯示的字串 | https://www.d-id.com（付費，新帳號通常有試用額度） |
| `GEMINI_TTS_MODEL` | 否，預設 `gemini-2.5-flash-preview-tts` | 語音合成模型 | — |
| `GEMINI_TTS_VOICE` | 否，預設 `Puck` | Gemini 內建語音角色 | Gemini API 文件列有完整清單 |
| `PORT` | 否，預設 `3000` | — | — |

`.env` 不會被 commit（`.gitignore`），合併專案時記得把這幾把 key 手動搬過去，不會隨 git 走。**`SIMLI_API_KEY`、`SIMLI_FACE_ID`、`GEMINI_MODEL` 是舊架構（即時問答虛擬人）留下的變數，目前程式碼完全沒有讀取，可以從 `.env` 刪掉。**

## 6. 開發歷程：試過並放棄的方案

依時間序，每個都是有明確原因才放棄，不是隨意換的：

### 6.1 語音合成（TTS）演進

| 順序 | 方案 | 結果 | 放棄原因 |
|---|---|---|---|
| 1 | Azure Speech (Cognitive Services) | 可用 | 使用者希望完全免費、不需申請帳號的路徑 |
| 2 | 本機 Piper（C++ binary，女聲 huayan） | 可用但只有女聲 | 使用者要求男聲 |
| 3 | 本機 Piper（Python 版，男聲 chaowen，g2pW+BERT 拼音注音） | **實測 OOM 崩潰** | 中文男聲需要拼音注音（非 espeak），只有 Python 版 Piper 支援；記憶體峰值 **583MB**，Render 免費方案上限 512MB，服務被系統反覆 OOM 強制關閉，表現為間歇性「語音合成失敗」（見第 7 節）。已加過自動重啟機制treat 症狀，但根因是記憶體不夠，treat 不了 |
| 4 | **Gemini TTS**（現行） | 採用 | 記憶體降到 62MB、免自建服務、速度沒有變慢（Piper 在 Render 共用 CPU 上本來就要 9 秒左右） |

中文 Piper 官方語音只有三個：`huayan`（女聲，espeak 注音，穩定）、`xiao_ya`（女聲，拼音注音）、`chaowen`（男聲，拼音注音）。用音高分析（autocorrelation-based F0 estimation）量過：huayan 199Hz、xiao_ya 245Hz、chaowen 154Hz——chaowen 明顯是三者中唯一偏男聲的。

### 6.2 畫面／嘴型演進

| 順序 | 方案 | 結果 | 放棄原因 |
|---|---|---|---|
| 1 | MediaPipe 臉部特徵點偵測 + Canvas 疊圖變形（拉伸下嘴唇像素、疊深色嘴巴內部色塊） | 可動但效果差 | 使用者實測後反饋「非常不自然的色塊」、無肢體動作。這是純前端零延遲方案的技術天花板——沒有 AI 生成模型就是做不到真實嘴型，色塊是唯一能做到的效果 |
| 2 | Simli Trinity（新版 Gaussian-splat avatar） | **API 直接拒絕** | 免費方案 403，付費限定功能（見 4.4 節） |
| 3 | **Simli Legacy pipeline**（現行） | 採用 | 免費方案唯一可用路徑，但官方標記 deprecated，是長期風險 |

**中途考慮過但沒有實作的方向**（使用者問過技術細節，尚未拍板）：
- **預錄「待機」+「說話」動作影片，播音檔時切換影片**：不做即時嘴型比對，只在音訊播放期間播放通用說話動作迴圈。優點：完全不需要 Simli（沒有 WebRTC/WebSocket，因此不會有手機連線失敗的問題）、可以搭配瀏覽器本地 TTS（見下）把延遲壓到最低。缺點：嘴型跟實際發音完全不同步，是更低一級的擬真度。
- **在此前提下改用瀏覽器內建 `speechSynthesis`（Web Speech API）**：因為不需要即時嘴型，原本排除 Web Speech API 的理由（無法把音訊波形接到 Web Audio API 做音量分析）就不成立了。優點：**零網路延遲**（本地生成，取代現在 Gemini TTS 的 7-17 秒），順便解決手機連線失敗與（可能的）自動播放權限問題。缺點：音質較生硬，不同裝置的語音引擎、男聲音色不保證一致。
- **ElevenLabs 聲音克隆**：可以訓練出貼合真人（例如老師本人）聲線的語音模型。Instant Voice Clone 需要 1-2 分鐘乾淨語音樣本，API 流程是 `voices.ivc.create(files=[...])` 拿到 `voice_id`，之後 TTS 呼叫帶這個 id。Flash v2.5 模型延遲約 75ms（比 Gemini TTS 快非常多個量級）。需要付費訂閱（Starter tier $6/月起才能用 Instant Voice Clone）+ 按字數計費（Flash 模型約 $0.05/1000 字元）+ **一定要取得聲音本人的同意**，這是服務條款要求也是基本倫理。這個方案跟「畫面用 Simli 還是預錄影片」是正交的兩個決策，可以任意搭配。

以上三個方向都只停留在研究/報價階段，**沒有寫進程式碼**，如果要接續開發需要重新確認需求。

### 6.3 介面演進

| 順序 | 風格 | 說明 |
|---|---|---|
| 1 | 紫色漸層卡片式（最初版本） | 使用者反饋「太醜」 |
| 2 | 「CODEX STUDY」風格（白底、藍色主色、細線表格） | 中繼版本 |
| 3 | Industry 藍圖風格，三欄式問答介面 | 使用者提供 Claude Design 畫布設計稿，照樣式重新實作：方形直角、四角測繪標記線（`.blueprint` + `.corner` class）、Barlow Condensed 標題字體、steel-blue 主色 `#5980a6`、三欄式版面（對話紀錄／虛擬人／對話串）。設計稿本身的多組對話切換、setTimeout 假回覆是 demo 用假資料，已改接真實 Gemini/Simli 功能，不是照抄 mockup 行為 |
| 4 | **同一套設計 tokens，改成單卡片版面（現行）** | 拿掉問答用的三欄（對話紀錄／虛擬人／對話串），改成「上傳照片＋輸入文件＋產生按鈕＋結果影片」的單卡片流程，配合 6.4 節的架構改版。`.blueprint`／`.corner`／字體／色票等 design tokens 完全沿用，只是版面從「即時對話」改成「表單送出→等待→結果」 |

### 6.4 從即時問答虛擬人改版成批次影片生成

這是目前架構（第 1-5 節）的由來。第 6.2 節「中途考慮過但沒有實作的方向」列過「預錄影片＋本地 TTS」和「ElevenLabs 聲音克隆」，但實際採用的是另一條路：

**觸發改版的需求變化**：原本是「使用者打字問問題，虛擬人即時回答」，需要低延遲、需要 WebRTC 即時串流（Simli），也因此繼承了「手機連線失敗」「自動播放權限」這些即時串流特有的問題（見第 8 節）。使用者後來把需求改成「輸入一段文件，拿到一支說話影片檔」——不再需要使用者即時提問、Gemini 即時回答這一層，也不需要在幾秒內看到嘴型同步，可以接受等待。這個轉變讓「即時性不夠」曾經用來否決正規批次影片生成服務（D-ID/HeyGen 這類）的理由不再成立，反而變得比 Simli 更適合：Simli 的產品定位本來就是即時串流用的 SDK，不是拿來出檔案。

**選擇 D-ID 而不是重新設計成本地嘴型模擬或聲音克隆**：
- D-ID 的 `/talks` API 原生支援「照片 + 音檔 URL → 嘴型同步影片」（`script.type: "audio"`），剛好可以直接接上既有的 Gemini TTS 輸出（見 4.2 節），不需要重新解決男聲音色的問題（Puck 男聲維持不變）。
- 比起本地嘴型模擬（MediaPipe canvas 疊圖），D-ID 是用真正的生成模型做嘴型，畫質可預期比第 6.2 節第一輪嘗試（「非常不自然的色塊」）好非常多——這正是最初放棄純前端方案、改走 Simli 的原因，D-ID 提供了同等級的生成品質，但用在批次影片而不是即時串流。
- 沒有採用 HeyGen：改版當下沒有花時間做逐一 API 比較，D-ID 的 REST API 形狀（`source_url` + `script` → 非同步 job → 輪詢）簡單直接、文件清楚，優先選了它；如果之後對影片品質或費率不滿意，HeyGen 的 talking-photo/avatar API 是值得比較的替代方案，但目前沒有實測數據。
- **拿掉的東西**：`simli-client` npm 套件（含第 7 節 bug #9 的繞路 workaround，現在不需要了）、`/api/simli/config`、`/api/simli/session`、`scripts/setup-simli-face.js`、`SIMLI_API_KEY`／`SIMLI_FACE_ID` 環境變數、`/api/ask`（Gemini 問答——新流程沒有「提問」這個概念，文件內容本身就是要唸出來的逐字稿，不需要 Gemini 生成回答文字）。
- **保留的東西**：Gemini TTS（`synthesizeSpeech()`，邏輯完全沒變，只是輸出從「即時分塊送給 Simli」改成「整段存成 WAV 檔案」）、`sanitizeForSpeech()`（文件內容一樣可能夾雜 Markdown）、Industry 設計系統的視覺語言與「AI教師啟動中」「AI教師模擬中」這兩個狀態文案（沿用到新的「合成語音中」「D-ID 生成影片中」兩個階段）。

## 7. 已修復的 Bug（含根因）

> 以下 bug 大多是在「即時問答虛擬人」（Simli）架構下發現並修復的，改版成批次影片生成（第 6.4 節）後，#4、#7、#8、#9 這幾個 Simli 專屬的 bug 已經隨著 Simli 被移除而不再適用，保留紀錄是因為背後的根因（例如自動播放權限、套件路徑問題）換一個情境還是可能踩到。

| # | 現象 | 根因 | 修法 | Commit |
|---|---|---|---|---|
| 1 | 前端改了但瀏覽器看不到變化 | `app.bundle.js` 無檔名雜湊，瀏覽器快取舊版不會自動更新 | `Cache-Control: no-cache`（搭配 etag／lastModified，未變更時仍走 304 省頻寬） | `8773cb1` |
| 2 | Gemini 回答在句子中間被截斷，語音合成失敗 | `gemini-3.6-flash` 思考消耗的 tokens 吃掉 `maxOutputTokens`（300 太低），`finishReason: MAX_TOKENS` | 拉高到 2048 | `77c6257` |
| 3 | 語音唸出符號（星號、`$`、`\frac{}{}`） | Gemini 答案含 Markdown/LaTeX | 系統指令要求純口語＋後端 `sanitizeForSpeech()` 保險清洗 | `77c6257` |
| 4 | Simli session 建立失敗但錯誤訊息看不出原因 | 後端有回傳 `detail` 欄位，前端只顯示 `error`，把細節丟了 | 前端改成 `[error, detail].join('：')`，後端也補上 `console.error` 讓 Render Logs 看得到 | `6e4d9cd` |
| 5 | 語音合成間歇性失敗（503／502） | **Piper Python 服務 OOM 崩潰**（見 6.1 節），約 30 秒後自動重啟恢復，表現為時好時壞 | 治標：加自動重啟機制。治本：整個換成 Gemini TTS，移除 Piper | `c19bb95`（治標）、`b6e5e88`（治本） |
| 6 | 貼錯 API key 給使用者 | 人工複製打字錯誤（`...c6ly` 誤植為 `...c6ry`） | 無程式碼修法，純提醒：**任何 key 用完都建議去源頭重新產生一把**，尤其出現在對話記錄裡的 | — |
| 7 | 動畫（說話中徽章）出現時聲音消失 | `<audio autoplay>` 播放 Simli 語音軌需要「近期使用者手勢」授權；Gemini TTS 要等 7-17 秒，等音軌真的送達時授權早已過期（iOS Safari 尤其嚴格），影片因為 `muted` 不受影響所以畫面正常、純聲音被靜默擋掉 | 在 `askForm` 的 `submit` handler 內**同步**呼叫一次 `audioEl.play()`，搶在長時間非同步等待之前用真實手勢「解鎖」該元素 | `346db8a` |
| 8 | Simli 連線失敗只能整頁重新整理 | 沒有重試機制 | 加「重試連線」按鈕，呼叫 `connectAvatar()` 重跑一次（含清掉舊的 `simliClient`） | `346db8a` |
| 9 | `simli-client@3.0.2` npm 套件在 Linux 上 `require` 失敗 | 套件自己的 `dist/index.js` 寫 `require("./Client")`，但實際檔名是小寫 `client.js`——macOS/Windows 檔案系統不分大小寫所以沒事，Linux（含所有伺服器）會直接壞掉 | 改成直接 `import from "simli-client/dist/client.js"`（繞過壞掉的 index.js），用 esbuild 打包 | 專案建立初期就發現並繞過 |

## 8. 已知未解決的問題

- **這把 D-ID key 目前額度是 0，要先去後台加值/開通方案**：實測打 `GET /credits` 回傳 `{"credits":[],"remaining":0,"total":0}`——帳號本身有效（認證會過），但沒有任何額度，`/talks` 一律回 `402 InsufficientCreditsError`。這不是程式碼問題，使用者要自己去 d-id.com 後台加值或開通方案才會真的有額度可以生成影片。
- **本機開發無法端到端測試出真的影片**：D-ID 對 `source_url`／`audio_url` 都要求真正的 **https** 網址（見第 4.2 節「關鍵限制」），本機 `http://localhost` 兩個條件都不滿足。本機能測到：認證格式對不對（已用真實 key 實測 `GET /credits` 回 200）、`/talks` 的 request body 格式對不對（已用真實 key 實測 `script.type: "text"` 和 `"audio"` 兩種都能通過 schema 驗證）、`/api/video/generate` 的輸入驗證邏輯、Gemini TTS 呼叫本身（已實測成功，且修掉了短句被誤判成對話的 bug，見第 4.1 節）。測不到的只剩「D-ID 實際抓到暫存檔、真的合成出一支影片」這一步，這需要部署到有公開 https 網址的環境（如 Render）或用 ngrok/cloudflared 開一個對外隧道才能驗證。**額度加值後，第一次部署應該立刻手動跑一次完整流程確認能拿到 `result_url` 且影片能播放。**
- **D-ID 影片工作狀態存在記憶體、非持久化**：`server.js` 的 `jobs` 是一個 `Map`，伺服器重啟或（未來）多實例部署時，進行中的工作會直接遺失、使用者輪詢會拿到 404。目前是單一小工具、單一 Render instance，這個取捨還算合理；合併到多 worker/多實例的專案時，這裡需要換成 Redis 或資料庫之類的共享狀態。
- **`result_url` 有效期未知/未長期驗證**：D-ID 回傳的 `result_url` 是他們儲存空間的直連網址，官方文件沒有明確保證多久後失效，這個專案的假設是「使用者完成後應該立即下載，不要指望這個網址長期可用」，但沒有實測過確切的失效時間（帳號額度是 0，還沒能真的跑出一個 `result_url` 來驗證）。
- **文字轉語音仍需 7-17 秒、D-ID 生成再疊加約 30 秒到 1-2 分鐘**：整體使用者等待時間可能到 2-3 分鐘，沒有做「先給預覽再補完整影片」之類的體驗優化。

## 9. 費用參考（2026-09 查證，會浮動）

- **D-ID**：按生成影片秒數的額度計費，方案從約 $4.7/月起（約 NT$150/月），約 15 秒影片／1 點數，確切費率以 https://www.d-id.com/pricing 為準——**需要付費帳號**，新註冊通常有一次性試用額度可以先測試
- **Gemini TTS**：用量計費，確切費率請查 https://ai.google.dev/pricing
- **Render**：免費方案，閒置約 15 分鐘會休眠，下次造訪冷啟動約十幾秒到一分鐘
- 以下是舊架構（即時問答虛擬人）留下的參考數字，目前已不適用，僅供對照：**Simli** 免費方案每月 50 分鐘，超過後約 $0.009/分鐘；**ElevenLabs**（聲音克隆，從未採用）Starter $6/月起

## 10. 合併到其他專案時的檢查清單

- [ ] 兩把環境變數（`GEMINI_API_KEY`、`DID_API_KEY`）要手動搬過去，不會隨 git 走
- [ ] **確認 `DID_API_KEY` 這個帳號有實際額度**（`GET https://api.d-id.com/credits` 檢查），光是有 key 不代表能用，見第 8 節
- [ ] 部署環境要能跑 `npm run build`（esbuild 打包 `public/src/app.js` → `public/app.bundle.js`），純靜態檔案不會自動反映 `src/` 的修改
- [ ] 部署環境要有**公開可連到的 https 網址**，D-ID 才能抓到暫存的照片和語音檔（`/tmp-media/*`）；純內網／本機環境測不了完整流程（見第 8 節）
- [ ] 如果目標專案也用 Express，注意 `server.js` 目前把 `Cache-Control: no-cache` 設成全域 middleware，合併時如果有其他靜態資源想被快取，這個全域設定需要調整成只針對 `public/` 或特定副檔名
- [ ] `jobs`（記憶體內的工作狀態 Map）在多實例部署下會不一致，見第 8 節
- [ ] `SIMLI_API_KEY`、`SIMLI_FACE_ID`、`GEMINI_MODEL`、`simli-client` 套件、`scripts/setup-simli-face.js`、`/api/ask`、`/api/simli/*` 都是**舊架構（即時問答虛擬人）的殘留**，已在這次改版移除，如果合併時看到舊分支/舊 commit 裡有這些，不要重新引入
- [ ] `voices/`、`vendor/`、`piper_service.py`、`requirements.txt`、`scripts/setup-voices.js` 是**更早一版架構（Piper 本地語音）的殘留**，已在 `b6e5e88` 這個 commit 移除，同樣不要重新引入
