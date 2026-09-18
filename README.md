# 會說話的人 AI QA Avatar

輸入問題，Gemini 回答，虛擬人（用你自己的照片預先建立）把答案唸出來。介面是「學習問答助理」三欄式版面：左側對話紀錄、中間虛擬人、右側對話串。

> 完整的技術決策過程、試過並放棄的方案、已修復 bug 的根因、還沒解決的問題，見 [`DEVELOPMENT.md`](./DEVELOPMENT.md)。要合併這個 repo 到其他專案之前建議先看過。

## 技術架構

- **問答**：[Gemini API](https://ai.google.dev) 產生答案。系統指令要求它用簡短口語回答、不要 Markdown 或 LaTeX，因為答案會被直接唸出來；後端另有一層清洗當保險。
- **語音**：Gemini 的 TTS 模型（男聲 `Puck`）。回傳無檔頭的 L16 PCM，後端補上 WAV 檔頭再送給前端。
- **畫面**：[Simli](https://www.simli.com) 的即時串流虛擬人 API。照片只需**離線處理一次**（`npm run setup:simli-face`），之後每次回答，前端把音訊重取樣成 16kHz PCM16 餵給 Simli，透過 WebRTC 取回嘴型同步的影像。
- **後端**：Node.js + Express，只做三件事：呼叫 Gemini 取得答案、呼叫 Gemini TTS 取得語音、用 Simli API key 換短效 session token 給前端（金鑰全部留在伺服器端）。

## 為什麼語音不是自己跑模型

本來用的是本機的 Piper 神經網路語音合成。中文男聲（chaowen）需要拼音注音系統（g2pW + BERT 分詞器），實測記憶體：

| 階段 | 記憶體 |
|---|---|
| 載入語音模型 | 134 MB |
| 載入中文注音元件 | 424 MB |
| 長句合成峰值 | **583 MB** |

加上 Node 約 70MB，峰值超過 650MB，而 Render 免費方案上限是 512MB——服務會被系統反覆 OOM 強制關閉，表現出來就是間歇性的「語音合成失敗」。女聲（huayan）用 espeak 注音不需要 BERT 所以沒事，但就沒有男聲可選。

改用 Gemini TTS 後：記憶體降到 **62MB**、音高更低沉（129Hz vs Piper 男聲 154Hz）、不需要 Python 執行環境，而且速度沒有變慢——Piper 跑在 Render 免費方案的共用 CPU 上，同樣長度本來就要 9 秒左右。

## 事前準備

1. Node.js 18 以上
2. 一組 [Gemini API key](https://aistudio.google.com/apikey)（問答與語音共用同一把）
3. 一組 [Simli](https://www.simli.com) API key（免費方案每月 50 分鐘）
4. 一張正臉照片，**JPEG 或 PNG**（webp/heic 請先轉檔）

## 安裝與設定

```bash
npm install
cp .env.example .env                          # 填入 GEMINI_API_KEY 與 SIMLI_API_KEY
npm run setup:simli-face path/to/你的照片.jpg   # 建立 avatar（需要幾分鐘），face id 會自動寫進 .env
npm run build
npm start
```

開啟 `http://localhost:3000`。

## 部署到 Render

repo 附有 `render.yaml`：在 [Render](https://render.com) 點 **New +** → **Blueprint** → 選這個 repo → **Apply**。

環境變數 `GEMINI_API_KEY`、`SIMLI_API_KEY`、`SIMLI_FACE_ID` 要在 Render 的 Environment 頁手動加入（`setup:simli-face` 是一次性的本機操作，把產生的 face id 貼過去即可）。

**注意**：免費方案閒置約 15 分鐘會休眠，下次有人造訪要等十幾秒到一分鐘的冷啟動。

## 可調整的環境變數

| 變數 | 預設 | 說明 |
|---|---|---|
| `GEMINI_MODEL` | `gemini-3.6-flash` | 回答問題用的模型 |
| `GEMINI_TTS_MODEL` | `gemini-2.5-flash-preview-tts` | 語音合成模型 |
| `GEMINI_TTS_VOICE` | `Puck` | 語音角色，可換成 Gemini 其他內建聲音 |

## 已知限制

- 綁定 Simli、Gemini 兩家供應商；超出免費額度後按用量計費
- 需要清晰的正臉照片才能建立 avatar
- 語音合成一句話約需 7–11 秒（Gemini TTS 不支援逐段串流，實測會整段一次回傳）
- 語速控制是靠自然語言指示（「請用較慢的語速說」）達成，不是精確倍率
- 手機連線失敗的問題尚未完全解決，根因未確認（詳見 `DEVELOPMENT.md` 第 8 節）
