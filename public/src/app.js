// Routes around a filename-casing bug in simli-client@3.0.2's published dist/index.js
// (it requires "./Client" but the file on disk is "./client.js" — fine on macOS/Windows,
// broken on case-sensitive filesystems like Linux). See scripts/build-client.js.
import { SimliClient, LogLevel } from "simli-client/dist/client.js";

const PCM_SAMPLE_RATE = 16000;
const CHUNK_BYTES = 6000; // ~187ms of mono 16-bit PCM at 16kHz, matches the SDK's own example size
const DEFAULT_VOICE = "zh_CN-chaowen-medium";

const videoEl = document.getElementById("avatarVideo");
const audioEl = document.getElementById("avatarAudio");
const connectOverlay = document.getElementById("connectOverlay");
const connectStatus = document.getElementById("connectStatus");
const topbarStatus = document.getElementById("topbarStatus");
const statusText = document.getElementById("statusText");

const askForm = document.getElementById("askForm");
const questionInput = document.getElementById("questionInput");
const askBtn = document.getElementById("askBtn");
const rateRange = document.getElementById("rateRange");
const volumeRange = document.getElementById("volumeRange");
const rateVal = document.getElementById("rateVal");
const volumeVal = document.getElementById("volumeVal");
const hint = document.getElementById("hint");
const answerBox = document.getElementById("answerBox");
const answerText = document.getElementById("answerText");
const historyList = document.getElementById("historyList");
const historyEmpty = document.getElementById("historyEmpty");

let simliClient = null;
let avatarReady = false;
let speaking = false;
let stopRequested = false;

function setSpeakingUI(isSpeaking) {
  speaking = isSpeaking;
  topbarStatus.classList.toggle("speaking", isSpeaking);
  statusText.textContent = isSpeaking ? "說話中" : avatarReady ? "待機中" : "連線中";
  askBtn.disabled = isSpeaking || !avatarReady;
}

// ---------- Simli avatar connection ----------
async function connectAvatar() {
  const configRes = await fetch("/api/simli/config").catch(() => null);
  const config = configRes && configRes.ok ? await configRes.json() : { ready: false };
  if (!config.ready) {
    connectStatus.textContent = "尚未設定 Simli";
    statusText.textContent = "未連線";
    hint.textContent = "請先在伺服器設定 SIMLI_API_KEY，並執行 npm run setup:simli-face 建立 avatar。";
    return;
  }

  const sessionRes = await fetch("/api/simli/session", { method: "POST" });
  const sessionData = await sessionRes.json();
  if (!sessionRes.ok) {
    console.error("Simli session error", sessionData);
    connectStatus.textContent = "連線失敗";
    statusText.textContent = "未連線";
    const detailMsg =
      sessionData.detail && typeof sessionData.detail === "object"
        ? sessionData.detail.detail || JSON.stringify(sessionData.detail)
        : sessionData.detail;
    hint.textContent = [sessionData.error, detailMsg].filter(Boolean).join("：");
    return;
  }

  simliClient = new SimliClient(
    sessionData.session_token,
    videoEl,
    audioEl,
    null,
    LogLevel.WARN,
    "livekit"
  );

  simliClient.on("start", () => {
    avatarReady = true;
    connectOverlay.hidden = true;
    hint.textContent = "";
    setSpeakingUI(false);
  });

  simliClient.on("error", (err) => {
    console.error("Simli error", err);
    hint.textContent = "虛擬人連線發生錯誤，請重新整理頁面再試一次。";
  });

  try {
    await simliClient.start();
  } catch (err) {
    console.error(err);
    connectStatus.textContent = "連線失敗";
    statusText.textContent = "未連線";
    hint.textContent = "無法連線到虛擬人服務，請重新整理頁面再試一次。";
  }
}

// ---------- Audio: Piper WAV -> 16kHz PCM16 -> Simli ----------
function floatTo16BitPCM(float32Array) {
  const buffer = new ArrayBuffer(float32Array.length * 2);
  const view = new DataView(buffer);
  for (let i = 0; i < float32Array.length; i++) {
    const s = Math.max(-1, Math.min(1, float32Array[i]));
    view.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Uint8Array(buffer);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function synthesizeAndStream(text) {
  const params = new URLSearchParams({
    text,
    voice: DEFAULT_VOICE,
    rate: rateRange.value,
  });
  const res = await fetch(`/api/tts?${params.toString()}`);
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || "語音合成失敗");
  }
  const arrayBuffer = await res.arrayBuffer();

  const offlineCtx = new OfflineAudioContext(1, 1, PCM_SAMPLE_RATE);
  const audioBuffer = await offlineCtx.decodeAudioData(arrayBuffer);
  const pcmBytes = floatTo16BitPCM(audioBuffer.getChannelData(0));

  const chunkDurationMs = (CHUNK_BYTES / 2 / PCM_SAMPLE_RATE) * 1000;
  for (let offset = 0; offset < pcmBytes.length; offset += CHUNK_BYTES) {
    if (stopRequested) break;
    const chunk = pcmBytes.subarray(offset, offset + CHUNK_BYTES);
    simliClient.sendAudioData(chunk);
    await sleep(chunkDurationMs);
  }
}

// ---------- Ask Gemini, then speak the answer ----------
function addHistoryItem(question, answer) {
  historyEmpty.hidden = true;
  const item = document.createElement("li");
  item.className = "history-item";

  const time = document.createElement("span");
  time.className = "history-time";
  time.textContent = new Date().toLocaleTimeString("zh-TW", { hour12: false });

  const q = document.createElement("p");
  q.className = "history-q";
  q.textContent = question;

  const a = document.createElement("p");
  a.className = "history-a";
  a.textContent = answer;

  item.append(time, q, a);
  historyList.prepend(item);
}

async function askQuestion(question) {
  hint.textContent = "";
  answerBox.hidden = true;
  askBtn.disabled = true;
  statusText.textContent = "思考中";

  try {
    const res = await fetch("/api/ask", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question }),
    });
    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.error || "問答服務發生錯誤");
    }

    answerText.textContent = data.answer;
    answerBox.hidden = false;
    addHistoryItem(question, data.answer);

    stopRequested = false;
    setSpeakingUI(true);
    await synthesizeAndStream(data.answer);
  } catch (err) {
    console.error(err);
    hint.textContent = err.message || "發生錯誤，請重試。";
  } finally {
    setSpeakingUI(false);
  }
}

askForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const question = questionInput.value.trim();
  if (!avatarReady) {
    hint.textContent = "虛擬人還沒連線好，請稍候。";
    return;
  }
  if (!question) {
    hint.textContent = "請先輸入問題。";
    return;
  }
  questionInput.value = "";
  askQuestion(question);
});

questionInput.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
    askForm.requestSubmit();
  }
});

rateRange.addEventListener("input", () => (rateVal.textContent = Number(rateRange.value).toFixed(1)));
volumeRange.addEventListener("input", () => {
  volumeVal.textContent = Number(volumeRange.value).toFixed(1);
  audioEl.volume = Number(volumeRange.value);
});

connectAvatar();
