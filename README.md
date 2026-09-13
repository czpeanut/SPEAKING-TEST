# 會說話的人 AI QA Avatar

輸入問題，Gemini 回答，虛擬人（用你自己的照片預先建立）即時把答案唸出來。

## 技術架構

- **問答**：後端呼叫 **[Gemini API](https://ai.google.dev)**，把使用者的問題送過去，拿回文字答案。
- **語音**：本機執行的 **[Piper](https://github.com/OHF-Voice/piper1-gpl)**（Python 版）神經網路語音合成，男聲（chaowen）。用一個常駐的 Python 小服務（`piper_service.py`）預先把語音模型與中文注音元件載入記憶體，避免每次請求都要重新載入（中文的 g2pW 注音元件冷啟動要 3 秒以上，常駐後降到 0.2 秒左右）。
- **畫面**：**[Simli](https://www.simli.com)** 的即時串流虛擬人 API。你的照片只需要**離線處理一次**（`npm run setup:simli-face`），之後每次回答，前端把 Piper 產生的音訊即時餵給 Simli，透過 WebRTC 把畫面串流回來——嘴型是模型即時生成的，不是照片疊圖。
- **後端**：Node.js + Express，負責：(1) 呼叫 Gemini 拿答案、(2) 把文字丟給常駐的 Piper 服務換成語音、(3) 用你的 Simli API key 換取短效 session token 給前端用（金鑰都留在伺服器端，不會出現在瀏覽器）。

## 為什麼要另外養一個 Python 服務

Piper 官方的中文語音只有 huayan、xiao_ya、chaowen 三個，其中只有 huayan 是女聲、用espeak 注音（我們原本用的），chaowen（男聲，音調明顯較低）用的是拼音注音系統（g2pW + BERT 分詞器），這套系統只有 Python 版的 Piper 支援，且用到的分詞器每次冷啟動要 3 秒以上。改成常駐服務、開機時把模型「暖機」（先跑一次合成）之後，之後每次請求只要 0.2 秒左右。

## 事前準備

1. Node.js 18 以上，以及 **Python 3.9+**（新增，男聲需要）
2. 一組 [Gemini API key](https://aistudio.google.com/apikey)（免費）
3. 一組 [Simli](https://www.simli.com) API key（免費註冊，每月 50 分鐘額度）
4. 一張你自己（或已取得肖像權同意的人）的正臉照片，**JPEG 或 PNG**（webp/heic 請先轉檔）

## 安裝與設定

```bash
npm install
pip install -r requirements.txt              # 男聲需要的 Python 依賴
npm run setup:voices                          # 下載中文語音模型（約 120MB，一次性）
cp .env.example .env                          # 編輯 .env，填入 GEMINI_API_KEY 與 SIMLI_API_KEY
npm run setup:simli-face path/to/你的照片.jpg   # 建立 avatar（需要幾分鐘處理），face id 會自動寫進 .env
npm run build                                 # 打包前端
npm start
```

開啟瀏覽器造訪 `http://localhost:3000`。

## 部署到 Render

這個 repo 附有 `render.yaml`：連上 [Render](https://render.com)（免費、不需信用卡）之後，Dashboard 點 **New +** → **Blueprint** → 選這個 repo → **Apply**，它會自動跑 `npm install && npm run setup:voices && pip3 install -r requirements.txt && npm run build`。

`GEMINI_API_KEY`、`SIMLI_API_KEY`、`SIMLI_FACE_ID` 需要在 Render 的 Environment 設定頁手動加入（`setup:simli-face` 是一次性的本機操作，把跑出來的 face id 貼到 Render 環境變數即可，不需要每次部署都重新產生）。

**注意**：
- Render 免費方案閒置約 15 分鐘會自動休眠，之後有訪客進來會有十幾秒到一分鐘的冷啟動時間。
- Render 的 Node 環境是否內建 python3/pip3 會因方案而異；如果 build log 出現 `pip3: not found`，需要改用有 Python 的環境或自訂 Dockerfile 安裝 Python。
- 常駐的 Python 語音服務會佔用額外記憶體（onnxruntime + 兩個語音模型），免費方案 512MB 記憶體可能偏緊，如果遇到服務被系統關閉（OOM），需要升級方案。

## 使用方式

1. 開啟頁面，等虛擬人連線完成（幾秒內）
2. 在輸入框打問題，按「送出問題」
3. Gemini 的回答會顯示出來，虛擬人同時唸出來

## 新增更多 Piper 語音

到 [huggingface.co/rhasspy/piper-voices](https://huggingface.co/rhasspy/piper-voices) 找語音，下載 `.onnx` 與 `.onnx.json` 兩個檔案放進 `voices/` 資料夾即可，伺服器會自動偵測。**注意**：只有 `phoneme_type: "espeak"` 的語音能直接用；`phoneme_type: "pinyin"`（目前只有中文的 chaowen/xiao_ya）需要額外的 Python 依賴（已經裝好）且首次合成較慢，建議也加進 `piper_service.py` 啟動時的 `PIPER_PRELOAD_VOICES` 暖機清單。

## 已知限制

- 綁定 Simli、Gemini 兩家供應商；超出免費額度後按用量計費
- 需要清晰的正臉照片才能建立 avatar
- 中文男聲（chaowen）音質、語調自然度略遜女聲（huayan），是目前 Piper 官方語音庫裡唯一的中文男聲選項
- 每次使用都要有網路連線（Gemini 問答 + Simli 畫面串流）
