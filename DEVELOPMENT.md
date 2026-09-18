# 開發紀錄與技術交接文件

這份文件記錄「會說話的人」這個專案從最初構想到目前狀態的完整技術決策過程，包含試過但放棄的方案、為什麼放棄、已修好的 bug 與根因、還沒解決的問題。目的是讓合併到其他專案時不會丟失這些脈絡——很多決策背後有實測數據支撐，不是憑感覺選的。

最後更新對應的 commit：`346db8a`（分支 `claude/zealous-thompson-93pmdy`）。

---

## 1. 專案是什麼

使用者在網頁輸入問題 → Gemini 回答 → 虛擬人（用真人照片預先建立的 avatar）把答案即時唸出來、嘴型同步。目前介面是「AI 學習問答助理」的樣式（Industry 藍圖風格設計系統），左側對話紀錄、中間虛擬人、右側對話串。

## 2. 目前架構（最終版）

```
使用者輸入問題
      │
      ▼
POST /api/ask ──────► Gemini API (gemini-3.6-flash)
      │                 系統指令要求：簡短口語、無 Markdown/LaTeX
      │◄──────────────  回傳文字答案（後端再做一層符號清洗保險）
      ▼
顯示答案文字 + 加入對話紀錄
      ▼
GET /api/tts?text=... ──► Gemini TTS API (gemini-2.5-flash-preview-tts)
      │                    男聲 "Puck"，回傳無檔頭 L16 PCM
      │◄───────────────── 後端補上 WAV 檔頭回傳
      ▼
瀏覽器端：decodeAudioData 解碼 → 重取樣成 16kHz PCM16
      ▼
simliClient.sendAudioData()（分塊、模擬即時節奏送出）
      ▼
Simli WebRTC (LiveKit mode) 即時生成嘴型同步影像
      ▼
<video> 顯示畫面、<audio> 播放聲音
```

後端（`server.js`）只做三件事，金鑰全部留在伺服器端：
1. `POST /api/ask`：呼叫 Gemini 拿文字答案
2. `GET /api/tts`：呼叫 Gemini TTS 拿語音，包裝成 WAV
3. `POST /api/simli/session`：用 `SIMLI_API_KEY` 換一次性 session token 給前端，前端用這個 token 直連 Simli，金鑰本身不會出現在瀏覽器

## 3. 檔案結構

```
server.js                      後端：/api/ask、/api/tts、/api/simli/*
render.yaml                    Render 部署設定（Blueprint）
package.json                   npm scripts：build（打包前端）、setup:simli-face
scripts/
  build-client.js              esbuild 打包 public/src/app.js → public/app.bundle.js
  setup-simli-face.js          一次性腳本：把照片送去 Simli 建立 avatar，face id 寫進 .env
public/
  index.html                   頁面結構（Industry 設計系統）
  style.css                    設計系統 tokens + 版面（藍圖風格：直角、四角測繪標記）
  src/app.js                   前端邏輯原始碼（會被打包成 app.bundle.js，不要直接改 bundle）
  app.bundle.js                打包產物，.gitignore 排除，每次改 src/app.js 後要重跑 npm run build
.env.example                   環境變數範本
```

**重要**：`public/src/app.js` 是原始碼，`public/app.bundle.js` 是 `npm run build` 的打包產物（esbuild），兩者不同步會導致改了程式碼但畫面沒變。合併到其他專案時，CI/CD 或部署流程要確保有跑 `npm run build`（`render.yaml` 的 `buildCommand` 已經包含）。

## 4. API 串接細節

### 4.1 Gemini 問答（`/api/ask` → Gemini generateContent）

```
POST https://generativelanguage.googleapis.com/v1beta/models/{GEMINI_MODEL}:generateContent
Header: x-goog-api-key: <GEMINI_API_KEY>
Body:
{
  "system_instruction": { "parts": [{ "text": "<語音助理系統指令，見 server.js SPEECH_SYSTEM_INSTRUCTION>" }] },
  "contents": [{ "parts": [{ "text": "<使用者問題>" }] }],
  "generationConfig": { "maxOutputTokens": 2048 }
}
```

**踩過的坑**：`gemini-3.6-flash` 是會「思考」的模型，`thoughtsTokenCount` 會吃掉 `maxOutputTokens` 的額度。原本設 300 導致 `finishReason: MAX_TOKENS`、答案在句子中間被切斷（思考用掉 285/300）。改成 2048 才穩定留出空間給思考＋可見答案兩者。`thinkingConfig.thinkingBudget` 試過設低值（128）或 0，0 會被 API 拒絕（400 INVALID_ARGUMENT），128 也沒有嚴格生效（實測還是用了 564 tokens 思考）——這個參數目前看起來不可靠，不要依賴它來省 token，直接拉高 `maxOutputTokens` 上限比較實際。

回答文字經過 `sanitizeForSpeech()`（`server.js`）清洗 Markdown/LaTeX 符號後才回傳，因為答案會被直接朗讀，殘留的 `**`、`$\frac{}{}` 這類符號唸出來會是逐字唸符號。系統指令已經要求模型不要輸出這些，清洗是保險，不是主要防線。

### 4.2 Gemini 語音合成（`/api/tts` → Gemini TTS generateContent）

```
POST https://generativelanguage.googleapis.com/v1beta/models/{GEMINI_TTS_MODEL}:generateContent
Header: x-goog-api-key: <GEMINI_API_KEY>
Body:
{
  "contents": [{ "parts": [{ "text": "<答案文字，語速用自然語言前綴>" }] }],
  "generationConfig": {
    "responseModalities": ["AUDIO"],
    "speechConfig": { "voiceConfig": { "prebuiltVoiceConfig": { "voiceName": "Puck" } } }
  }
}
```

回應是 base64 的**無檔頭 L16 PCM**（`mimeType` 字串裡帶 `rate=24000`），後端 `wavHeader()` 手動組 44-byte WAV 檔頭再回傳給前端，因為瀏覽器的 `decodeAudioData` 需要完整的檔案容器格式，不能直接吃裸 PCM。

語速控制**不是精確倍率**，是靠在文字前面加自然語言指示達成（`withPaceDirection()`）：
- `rate <= 0.85` → 「請用較慢的語速說：」
- `rate >= 1.15` → 「請用較快的語速說：」

實測同一句話：慢 12.1 秒／正常 7.2 秒／快 5.3 秒，指示確實有效，但不是線性可控的倍率。

**已知延遲數據**（線上 Render 實測，2026-09-18）：
- `/api/ask`：約 3.5 秒
- `/api/tts`：約 7-17 秒（依答案長度，見下方「延遲根因」）
- 總計使用者從送出問題到聽到聲音：**約 14-20 秒**

Gemini TTS **不支援真正的逐段串流**：測過 `streamGenerateContent?alt=sse`，回應還是整段音訊一次送達（`chunks=1`），沒有邊生成邊送的效果。

### 4.3 Simli 虛擬人（session token + 前端 WebRTC）

**後端**（`server.js` `/api/simli/session`）：
```
POST https://api.simli.ai/compose/token
Header: x-simli-api-key: <SIMLI_API_KEY>
Body: { "faceId": "<SIMLI_FACE_ID>", "apiVersion": "v2", "audioInputFormat": "pcm16" }
回應: { "session_token": "..." }
```
`apiVersion` 是固定值 `"v2"`（OpenAPI 標記為 `const`），跟 face 是 Legacy 還是 Trinity 無關，不用因為 face 類型改這個欄位。

**前端**（`public/src/app.js`）：
```js
import { SimliClient, LogLevel } from "simli-client/dist/client.js"; // 注意路徑，見下方 bug 章節
const simliClient = new SimliClient(session_token, videoEl, audioEl, null, LogLevel.WARN, "livekit");
await simliClient.start();
simliClient.sendAudioData(pcm16Chunk); // 16kHz mono PCM16，~187ms 一塊，模擬即時節奏送出
await simliClient.stop(); // 斷線/重連時呼叫
```

音訊格式要求：**16kHz、mono、PCM16、無檔頭**。Gemini TTS 回傳的是 24kHz，前端用 `OfflineAudioContext(1, 1, 16000)` 的 `decodeAudioData()` 順便完成重取樣（`decodeAudioData` 會自動採樣到 context 指定的 sampleRate，這個技巧不需要額外的重取樣函式庫）。

### 4.4 Simli face 建立（`scripts/setup-simli-face.js`，一次性本機操作）

這是**唯一一個免費方案能用的路徑**，過程踩了不少坑：

1. **Trinity（新版 Gaussian-splat avatar）在免費方案上完全不能用**：呼叫 `POST /faces/trinity` 直接回 403「max number of GS Faces for your current subscription」，即使帳號目前 0 個 face 也一樣——這是方案限制，不是額度用完。
2. **改用 Legacy pipeline**（官方 OpenAPI 標記 `deprecated: true`，但目前唯一免費可用）：
   ```
   POST https://api.simli.ai/faces/legacy?face_name=<name>
   Header: x-simli-api-key: <key>
   Body: multipart/form-data，欄位 image（僅接受 JPEG/PNG，不接受 WEBP，需要先轉檔）
   回應: { "character_uid": "<face_id>", "warnings": [...] }
   ```
   這是**非同步**的，要輪詢：
   ```
   GET https://api.simli.ai/faces/legacy/generation_status?face_id=<id>
   回應: { "status": "processing" | "completed", "face_id": "..." }
   ```
   實測處理時間約 3-5 分鐘。`scripts/setup-simli-face.js` 已經包含完整的提交＋輪詢邏輯。
3. 如果哪天 Legacy pipeline 也被下架，代表免費方案已經沒有自訂照片的路徑了，屆時只能升級付費方案或改用 Simli 提供的預設人像。

## 5. 環境變數完整清單

| 變數 | 必要 | 說明 | 取得方式 |
|---|---|---|---|
| `GEMINI_API_KEY` | 是 | 問答與語音共用同一把 | https://aistudio.google.com/apikey |
| `SIMLI_API_KEY` | 是 | Simli 帳號 key | https://www.simli.com（免費方案每月 50 分鐘） |
| `SIMLI_FACE_ID` | 是 | `setup:simli-face` 產生，或手動貼 | — |
| `GEMINI_MODEL` | 否，預設 `gemini-3.6-flash` | 問答模型 | 若這個 model 被下架，錯誤訊息通常會直接告訴你該換成哪個 |
| `GEMINI_TTS_MODEL` | 否，預設 `gemini-2.5-flash-preview-tts` | 語音合成模型 | — |
| `GEMINI_TTS_VOICE` | 否，預設 `Puck` | Gemini 內建語音角色 | Gemini API 文件列有完整清單 |
| `PORT` | 否，預設 `3000` | — | — |

`.env` 不會被 commit（`.gitignore`），合併專案時記得把這幾把 key 手動搬過去，不會隨 git 走。

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
| 3 | **Industry 藍圖風格**（現行） | 使用者提供 Claude Design 畫布設計稿，照樣式重新實作：方形直角、四角測繪標記線（`.blueprint` + `.corner` class）、Barlow Condensed 標題字體、steel-blue 主色 `#5980a6`、三欄式版面（對話紀錄／虛擬人／對話串）。設計稿本身的多組對話切換、setTimeout 假回覆是 demo 用假資料，已改接真實 Gemini/Simli 功能，不是照抄 mockup 行為 |

## 7. 已修復的 Bug（含根因）

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

- **手機連線失敗**：使用者回報「手機版都會連線失敗」。目前只做了 bug #7、#8 的修復（可能有幫助但未直接針對此問題驗證），**根本原因未確認**。合理懷疑跟 Simli 的 WebRTC/WebSocket 連線在行動網路（4G/5G NAT、部分 Wi-Fi 防火牆）比桌機更容易被擋有關，但沒有實機測試數據佐證。這個沙盒環境本身的網路政策也明確不支援 WebSocket（`/root/.ccr/README.md` 有寫），所以 Claude 這端完全無法重現/驗證 Simli 連線問題，所有相關修復都只能靠使用者實機回報。
- **語音生成延遲 ~14-20 秒**：根因是 Gemini TTS 生成時間本身（無串流），跟 Simli 或介面無關。第 6.2 節列的「預錄影片＋本地 TTS」與「逐句 pipeline」是已討論但未實作的解法，使用者要求先穩定既有 bug 再談。
- **桌面版是否真的解決靜音問題未確認**：bug #7 的修法理論上桌面瀏覽器也適用（同一套瀏覽器自動播放權限機制），但因為這個沙盒連不上 Simli 的 WebSocket，無法端到端驗證，只驗證了程式邏輯本身（按鈕點擊、重連流程），沒有驗證「桌面瀏覽器實際播放出聲音」這件事。
- **Simli Legacy face pipeline 是 deprecated API**：官方隨時可能下架，屆時免費方案將沒有自訂照片的路徑（見 6.2 節）。

## 9. 費用參考（2026-09 查證，會浮動）

- **Simli**：免費方案每月 50 分鐘，超過後約 $0.009/分鐘（約 NT$0.3/分鐘）
- **Gemini**：問答與 TTS 都是用量計費，確切費率請查 https://ai.google.dev/pricing （當時沒有特別記錄費率數字）
- **Render**：免費方案，閒置約 15 分鐘會休眠，下次造訪冷啟動約十幾秒到一分鐘
- **ElevenLabs**（若採用聲音克隆，尚未實作）：Starter $6/月起（約 NT$190）才能用 Instant Voice Clone，另外按字數計費（Flash 模型約 NT$1.6/1000 字元）

## 10. 合併到其他專案時的檢查清單

- [ ] 三把環境變數（`GEMINI_API_KEY`、`SIMLI_API_KEY`、`SIMLI_FACE_ID`）要手動搬過去，不會隨 git 走
- [ ] `SIMLI_FACE_ID` 綁定「這一張照片」＋「這個 Simli 帳號」，換照片或換帳號要重跑 `npm run setup:simli-face`
- [ ] 部署環境要能跑 `npm run build`（esbuild 打包 `public/src/app.js` → `public/app.bundle.js`），純靜態檔案不會自動反映 `src/` 的修改
- [ ] 如果目標專案也用 Express，注意 `server.js` 目前把 `Cache-Control: no-cache` 設成全域 middleware（見 bug #1），合併時如果有其他靜態資源想被快取，這個全域設定需要調整成只針對 `public/` 或特定副檔名
- [ ] 如果目標專案的 Node 版本或套件管理方式不同，注意 `simli-client` 套件本身的已知 bug（見 bug #9），import 路徑要維持 `simli-client/dist/client.js` 而不是套件根目錄
- [ ] `voices/`、`vendor/`、`piper_service.py`、`requirements.txt`、`scripts/setup-voices.js` 這些是**舊架構（Piper）的殘留**，已在 `b6e5e88` 這個 commit 移除，如果合併時看到舊分支/舊 commit 裡有這些檔案，不要重新引入
