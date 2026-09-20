# 照片說話影片產生器

上傳一張照片、輸入一段文件內容，產生一支這張照片「講出這段內容」的影片，可以下載。

> 完整的技術決策過程、試過並放棄的方案、已修復 bug 的根因、還沒解決的問題，見 [`DEVELOPMENT.md`](./DEVELOPMENT.md)。要合併這個 repo 到其他專案之前建議先看過。

## 技術架構

- **語音**：[Gemini API](https://ai.google.dev) 的 TTS 模型（男聲 `Puck`）把輸入的文字合成成語音。回傳無檔頭的 L16 PCM，後端補上 WAV 檔頭。
- **影片**：[D-ID](https://www.d-id.com) 的 `/talks` API，用「照片 + 一段音檔」批次生成嘴型同步的說話影片（非即時串流，是送出工作後等待、輪詢完成）。
- **後端**：Node.js + Express。收到照片與文字後：呼叫 Gemini TTS 產生語音檔、暫存並提供一個可公開存取的網址、把這個網址連同照片交給 D-ID 建立影片工作、輪詢直到完成，回傳影片網址給前端下載/播放。金鑰全部留在伺服器端。
- **前端**：純 JS，沒有框架。上傳照片（存在瀏覽器 localStorage 方便下次直接用）、貼上或上傳文字檔、送出後輪詢工作狀態、完成後顯示影片與下載按鈕。

## 為什麼不是即時虛擬人（Simli）

這個專案最早是「即時問答虛擬人」（輸入問題、Gemini 回答、虛擬人即時唸出來），需要 WebRTC 串流所以對「所有人的網路環境都要能穩定連線」很敏感，也踩過手機連線失敗的問題（見 `DEVELOPMENT.md`）。現在的需求改成「輸入文件、拿到一支影片檔」——不需要即時互動、可以接受生成要等一段時間，因此改用批次影片生成 API（D-ID），架構更單純，也不再有 WebRTC 連線失敗的問題。

## 事前準備

1. Node.js 18 以上
2. 一組 [Gemini API key](https://aistudio.google.com/apikey)（TTS 用）
3. 一組 [D-ID API key](https://www.d-id.com)（需要付費帳號，新註冊通常會有試用額度）
4. 一張正臉照片，**JPEG、PNG 或 WEBP**

## 安裝與設定

```bash
npm install
cp .env.example .env   # 填入 GEMINI_API_KEY 與 DID_API_KEY
npm run build
npm start
```

開啟 `http://localhost:3000`，上傳照片、貼上文字、按「產生說話影片」。

**注意**：D-ID 需要能連到你伺服器暫存的語音檔網址，本機用 `localhost` 跑的話 D-ID 連不進來，只有部署到有公開網址的環境（如 Render）才能真的產生影片；本機主要用來檢查介面和其他邏輯。

## 部署到 Render

repo 附有 `render.yaml`：在 [Render](https://render.com) 點 **New +** → **Blueprint** → 選這個 repo → **Apply**。

環境變數 `GEMINI_API_KEY`、`DID_API_KEY` 要在 Render 的 Environment 頁手動加入。

**注意**：免費方案閒置約 15 分鐘會休眠，下次有人造訪要等十幾秒到一分鐘的冷啟動。

## 可調整的環境變數

| 變數 | 預設 | 說明 |
|---|---|---|
| `GEMINI_TTS_MODEL` | `gemini-2.5-flash-preview-tts` | 語音合成模型 |
| `GEMINI_TTS_VOICE` | `Puck` | 語音角色，可換成 Gemini 其他內建聲音 |

## 已知限制

- 綁定 Gemini、D-ID 兩家供應商；D-ID 是付費服務，按生成的影片秒數（額度）計費
- 需要清晰的正臉照片
- 文件內容上限 1500 字，超過會被截斷
- 整個流程（語音合成 + D-ID 生成）約需 1-2 分鐘，視文字長度而定
- 暫存的語音檔網址只在生成期間存在，生成完成或 15 分鐘後會被清除
