# 照片說話影片產生器

輸入一段文件內容，產生一支事先設定好的照片「講出這段內容」的影片，可以下載。

> 完整的技術決策過程、試過並放棄的方案、已修復 bug 的根因、還沒解決的問題，見 [`DEVELOPMENT.md`](./DEVELOPMENT.md)。要合併這個 repo 到其他專案之前建議先看過。

## 技術架構

- **語音**：[Gemini API](https://ai.google.dev) 的 TTS 模型（男聲 `Puck`）把輸入的文字合成成語音。
- **影片**：[Simli](https://www.simli.com) 的 `/static/audio` 批次影片生成 API，用「事先建立好的照片 avatar（faceId）+ 一段音檔」生成嘴型同步的 mp4，幾秒鐘就完成（不是即時串流，但也不用像 D-ID 那樣等 1-2 分鐘）。
- **後端**：Node.js + Express。收到文字後：呼叫 Gemini TTS 產生語音（PCM），直接把 base64 音訊連同已設定好的 `SIMLI_FACE_ID` 一起丟給 Simli，幾秒後拿回 mp4 網址。金鑰全部留在伺服器端。
- **前端**：純 JS，沒有框架。輸入文字或上傳文字檔、送出後輪詢工作狀態、完成後顯示影片與下載按鈕。

## 為什麼照片是「事先設定好」而不是每次上傳

Simli 的批次影片 API（`/static/audio`）吃的是一個事先建立好的 `faceId`，不是每次請求帶一張新照片——要用新照片得先透過 Simli 的 Legacy 頭像流程建立 avatar（非同步，約 3-5 分鐘），不適合放進「使用者按一下就要影片」的即時流程裡。因此照片用 `npm run setup:simli-face <照片路徑>` 建立一次，之後每次生成影片都重複使用同一個 `faceId`，只有文字內容會變。要換照片就重跑一次這個腳本。

## 為什麼不是 D-ID

這個專案原本接的是 D-ID 的 `/talks` API（每次可以直接帶照片，不用事先建立 avatar），但 D-ID 是全付費服務，免費註冊拿到的 key 額度是 0，要真的開通方案才能生成。改用 Simli 之後：
- 免費方案每月 50 分鐘額度，這個專案的使用量通常用不到
- 生成速度快很多（幾秒 vs 1-2 分鐘）
- 音檔直接用 base64 傳給 Simli，不需要像 D-ID 那樣先把照片和音檔暫存成公開 https 網址（D-ID 的 `/talks` 明確要求 https 網址，`localhost` 本機測不出真正的影片；Simli 沒有這個限制，本機就能完整測試）

這個專案更早之前還試過「即時問答虛擬人」（用 Simli 的 WebRTC 即時串流，輸入問題、Gemini 即時回答、虛擬人即時唸出來），因為對網路環境很敏感、踩過手機連線失敗的問題而放棄，改成現在的批次生成。完整脈絡見 `DEVELOPMENT.md` 第 6 節。

## 事前準備

1. Node.js 18 以上
2. 一組 [Gemini API key](https://aistudio.google.com/apikey)（TTS 用）
3. 一組 [Simli API key](https://www.simli.com)（免費方案每月 50 分鐘）
4. 一張正臉照片，**JPEG 或 PNG**（webp/heic 請先轉檔）

## 安裝與設定

```bash
npm install
cp .env.example .env                          # 填入 GEMINI_API_KEY 與 SIMLI_API_KEY
npm run setup:simli-face path/to/你的照片.jpg   # 建立 avatar（需要幾分鐘），face id 會自動寫進 .env
npm run build
npm start
```

開啟 `http://localhost:3000`，輸入文字、按「產生說話影片」。跟先前的 D-ID 版本不同，**這個流程本機就能完整測試**，不需要部署到有公開網址的環境。

## 部署到 Render

repo 附有 `render.yaml`：在 [Render](https://render.com) 點 **New +** → **Blueprint** → 選這個 repo → **Apply**。

環境變數 `GEMINI_API_KEY`、`SIMLI_API_KEY`、`SIMLI_FACE_ID` 要在 Render 的 Environment 頁手動加入（`setup:simli-face` 是一次性的本機操作，把產生的 face id 貼過去即可）。

**注意**：免費方案閒置約 15 分鐘會休眠，下次有人造訪要等十幾秒到一分鐘的冷啟動。

## 可調整的環境變數

| 變數 | 預設 | 說明 |
|---|---|---|
| `GEMINI_TTS_MODEL` | `gemini-2.5-flash-preview-tts` | 語音合成模型 |
| `GEMINI_TTS_VOICE` | `Puck` | 語音角色，可換成 Gemini 其他內建聲音 |

## 已知限制

- 綁定 Gemini、Simli 兩家供應商；超出免費額度後按用量計費
- 照片是事先設定好的單一 avatar，不是每次上傳；換照片要重跑 `npm run setup:simli-face`
- 需要清晰的正臉照片，且只接受 JPEG/PNG
- 文件內容上限 1500 字，超過會被截斷
- Simli 的 mp4 網址不支援 HEAD 請求做「是否已生成完成」的檢查，後端是用 API 回傳的預估秒數等待，極少數情況下可能等待時間不夠精準
