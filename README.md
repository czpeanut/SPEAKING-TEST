# 會說話的照片 Talking Photo

上傳一張正臉照片，輸入文字，照片裡的人就會開口念出來（嘴巴會隨語音音量張合）。

## 技術架構

- **前端**：純 HTML/CSS/JS（無框架）。用 [MediaPipe Face Landmarker](https://ai.google.dev/edge/mediapipe/solutions/vision/face_landmarker) 在瀏覽器端偵測上傳照片的嘴唇輪廓，說話時用 Web Audio API 的 `AnalyserNode` 即時分析語音音量，依音量大小把下嘴唇的 landmark 往下位移、疊上嘴巴內部色塊，模擬張嘴說話（簡易疊圖變形，不是逐音素的精準對嘴）。
- **後端**：Node.js + Express，提供 `/api/tts`、`/api/voices` 兩個端點，向 **Azure Speech**（Cognitive Services TTS）請求語音並串流回傳給前端播放。金鑰只存在伺服器端環境變數，不會曝露到瀏覽器。

## 事前準備

1. Node.js 18 以上
2. 一組 Azure Speech 資源的金鑰與地區（Azure Portal 建立 "語音服務" / "Speech" 資源即可取得）

## 安裝與設定

```bash
npm install
cp .env.example .env
# 編輯 .env，填入 AZURE_SPEECH_KEY 與 AZURE_SPEECH_REGION
```

## 執行

```bash
npm start
```

開啟瀏覽器造訪 `http://localhost:3000`。

## 使用方式

1. 上傳一張光線充足、臉部完整清晰的正臉照片
2. 等待偵測完成（會自動抓取嘴唇位置）
3. 在文字框輸入想說的話，選擇語音、調整語速/音調/音量
4. 按「開始說話」，照片裡的嘴巴會隨語音音量開合

## 已知限制

- 嘴型是音量驅動的簡易形變，不是逐音素精準對嘴，也不會有頭部/表情的動作
- 需要清晰的正臉照片才能正確偵測嘴唇位置；側臉、遮擋、多人合照可能偵測失敗
- 語音合成需要有效的 Azure Speech 金鑰與網路連線
