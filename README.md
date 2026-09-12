# 會說話的照片 Talking Photo

上傳一張正臉照片，輸入文字，照片裡的人就會開口念出來（嘴巴會隨語音音量張合）。

## 技術架構

- **前端**：純 HTML/CSS/JS（無框架）。用 [MediaPipe Face Landmarker](https://ai.google.dev/edge/mediapipe/solutions/vision/face_landmarker) 在瀏覽器端偵測上傳照片的嘴唇輪廓，說話時用 Web Audio API 的 `AnalyserNode` 即時分析語音音量，依音量大小把下嘴唇的 landmark 往下位移、疊上嘴巴內部色塊，模擬張嘴說話（簡易疊圖變形，不是逐音素的精準對嘴）。
- **後端**：Node.js + Express，提供 `/api/tts`、`/api/voices` 兩個端點，呼叫本機安裝的 **[Piper](https://github.com/rhasspy/piper)**（開源本地語音合成引擎）產生語音並串流回傳給前端播放。完全在本機運算，不用申請任何帳號或 API key，也不需要網路連線（安裝時下載執行檔與語音模型除外）。

## 部署到 Render（不需要在自己電腦跑任何指令）

因為後端要能執行 Node.js 並啟動 Piper 這個原生程式，**GitHub Pages 不能用**（它只能放靜態檔案，無法跑伺服器）。這個 repo 已經附上 `render.yaml`，接上 [Render](https://render.com) 之後它會自動照著這份設定 build＋部署，往後每次 `git push` 都會自動重新部署，你不需要在自己電腦執行任何 `npm` 指令。

步驟：

1. 到 [render.com](https://render.com) 免費註冊（不需要信用卡）
2. Dashboard 點 **New +** → **Blueprint**
3. 選擇這個 GitHub repo，Render 會自動讀到 `render.yaml` 並列出要建立的服務，點 **Apply** 確認
4. 等待它跑 `npm install && npm run setup:piper`（第一次建置含下載 Piper 與語音模型，約需幾分鐘）
5. 完成後 Render 會給一個網址（例如 `https://speaking-photo.onrender.com`），開啟即可使用

**注意**：Render 免費方案閒置約 15 分鐘會自動休眠，之後有訪客進來會有十幾秒到一分鐘的冷啟動時間，屬正常現象。

## 本機開發（選用）

如果想在自己電腦先測試，才需要跑這些指令：

```bash
npm install
npm run setup:piper   # 下載 Piper 執行檔＋預設中文語音模型（約 100MB，僅需一次）
npm start
```

開啟瀏覽器造訪 `http://localhost:3000`。

## 使用方式

1. 上傳一張光線充足、臉部完整清晰的正臉照片
2. 等待偵測完成（會自動抓取嘴唇位置）
3. 在文字框輸入想說的話，選擇語音、調整語速/音量
4. 按「開始說話」，照片裡的嘴巴會隨語音音量開合

## 新增更多語音

預設只安裝了一個中文語音模型（`zh_CN-huayan-medium`）。想要更多語音選擇（例如不同腔調、性別、語言），到 [huggingface.co/rhasspy/piper-voices](https://huggingface.co/rhasspy/piper-voices) 下載任一語音的 `.onnx` 與 `.onnx.json` 兩個檔案，放進 `voices/` 資料夾即可，伺服器會自動偵測並列在語音選單中。

## 已知限制

- 嘴型是音量驅動的簡易形變，不是逐音素精準對嘴，也不會有頭部/表情的動作
- 需要清晰的正臉照片才能正確偵測嘴唇位置；側臉、遮擋、多人合照可能偵測失敗
- Piper 是純規則式本地語音合成，音質、語調自然度不如雲端服務（如 Azure/ElevenLabs），但速度快、完全免費、不需連網
- `npm run setup:piper` 需要下載約 100MB 的執行檔與語音模型，僅支援 Windows/macOS/Linux 常見平台（x64、arm64）；其他平台需自行至 [Piper releases](https://github.com/rhasspy/piper/releases) 下載並手動放進 `vendor/piper/`
