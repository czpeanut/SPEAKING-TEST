# 會說話的人 Talking Avatar

用你（預先處理過）的照片建立一個即時虛擬人，輸入文字就能讓他馬上開口說話——嘴型、表情是 Simli 即時生成的，不是貼圖疊圖。

## 技術架構

- **語音**：後端用本機安裝的 **[Piper](https://github.com/rhasspy/piper)**（開源本地語音合成）產生語音，完全免費、不需要帳號。
- **畫面**：**[Simli](https://www.simli.com)** 的即時串流虛擬人 API。你的照片只需要**離線處理一次**（`npm run setup:simli-face`），之後每次說話，前端把 Piper 產生的音訊即時餵給 Simli，透過 WebRTC 把畫面串流回來——嘴型、表情是模型即時生成的，不是照片疊圖。
- **後端**：Node.js + Express，只做兩件事：(1) 呼叫 Piper 產生語音、(2) 用你的 Simli API key 換取短效 session token 給前端用（key 本身不會出現在瀏覽器裡）。

## 為什麼是這個架構

嘴巴要看起來自然、又要即時反應輸入的文字，同時做到這兩件事目前只有「訓練過真人說話影片的生成模型」辦得到——這不是前端技巧能模擬出來的。Simli 把這類模型包成 API，換算下來每分鐘不到 NT$0.3（免費方案每月還有 50 分鐘額度），比自己養一台 GPU 划算很多。代價是要綁定這家供應商、需要网路連線。詳細的方案比較在專案討論中有記錄。

## 事前準備

1. Node.js 18 以上
2. 一組 [Simli](https://www.simli.com) API key（免費註冊，每月 50 分鐘額度）
3. 一張你自己（或已取得肖像權同意的人）的正臉照片——清楚、光線充足、頭部至少占畫面高度 15%

## 安裝與設定

```bash
npm install
npm run setup:piper                          # 下載 Piper 執行檔＋中文語音模型（約 100MB，一次性）
cp .env.example .env                          # 編輯 .env，填入 SIMLI_API_KEY
npm run setup:simli-face path/to/你的照片.jpg   # 建立 avatar，face id 會自動寫進 .env
npm run build                                 # 打包前端
npm start
```

開啟瀏覽器造訪 `http://localhost:3000`。

`setup:simli-face` 只需要跑一次；換照片才需要重跑。它會先把裁切預覽存到 `vendor/simli-face-preview.png`，可以打開確認裁切結果，不滿意可以重新執行。

## 部署到 Render

這個 repo 附有 `render.yaml`：連上 [Render](https://render.com)（免費、不需信用卡）之後，Dashboard 點 **New +** → **Blueprint** → 選這個 repo → **Apply**，它會自動跑 `npm install && npm run setup:piper && npm run build`。

`SIMLI_API_KEY` 與 `SIMLI_FACE_ID` 需要在 Render 的 Environment 設定頁手動加入（`npm run setup:simli-face` 是一次性的本機操作，把跑出來的 face id 貼到 Render 環境變數即可，不需要每次部署都重新產生）。

**注意**：Render 免費方案閒置約 15 分鐘會自動休眠，之後有訪客進來會有十幾秒到一分鐘的冷啟動時間。

## 使用方式

1. 開啟頁面，等虛擬人連線完成（幾秒內）
2. 在文字框輸入想說的話，選擇語音、調整語速/音量
3. 按「開始說話」

## 新增更多 Piper 語音

到 [huggingface.co/rhasspy/piper-voices](https://huggingface.co/rhasspy/piper-voices) 下載任一語音的 `.onnx` 與 `.onnx.json` 兩個檔案，放進 `voices/` 資料夾即可，伺服器會自動偵測並列在語音選單中。

## 已知限制

- 綁定 Simli 這家供應商；超出免費額度後按分鐘計費
- 需要清晰的正臉照片才能建立 avatar
- Piper 是規則式本地語音合成，音質不如雲端真人語音服務，但免費、不需連網
- 每次說話都要有網路連線到 Simli（畫面串流）
