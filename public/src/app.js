// Routes around a filename-casing bug in simli-client@3.0.2's published dist/index.js
// (it requires "./Client" but the file on disk is "./client.js" — fine on macOS/Windows,
// broken on case-sensitive filesystems like Linux). See scripts/build-client.js.
import { SimliClient, LogLevel } from "simli-client/dist/client.js";

const PCM_SAMPLE_RATE = 16000;
const CHUNK_BYTES = 6000; // ~187ms of mono 16-bit PCM at 16kHz, matches the SDK's own example size
const GREETING = "你好，我是學習問答助理。請描述你在課業上遇到的問題，我會盡力提供解說與示例。";

const videoEl = document.getElementById("avatarVideo");
const audioEl = document.getElementById("avatarAudio");
const connectOverlay = document.getElementById("connectOverlay");
const connectStatus = document.getElementById("connectStatus");
const speakingBadge = document.getElementById("speakingBadge");
const statusTag = document.getElementById("statusTag");

const newChatBtn = document.getElementById("newChatBtn");
const historyList = document.getElementById("historyList");
const historyEmpty = document.getElementById("historyEmpty");
const chatScroll = document.getElementById("chatScroll");

const askForm = document.getElementById("askForm");
const questionInput = document.getElementById("questionInput");
const askBtn = document.getElementById("askBtn");
const rateRange = document.getElementById("rateRange");
const volumeRange = document.getElementById("volumeRange");
const rateVal = document.getElementById("rateVal");
const volumeVal = document.getElementById("volumeVal");
const hint = document.getElementById("hint");
const retryBtn = document.getElementById("retryBtn");

let simliClient = null;
let avatarReady = false;
let stopRequested = false;
let turnCount = 0;

function setStatus(label, variant) {
  statusTag.textContent = label;
  statusTag.className = `tag ${variant}`;
}

function setAskEnabled(enabled) {
  askBtn.disabled = !enabled;
}

// ---------- Chat thread ----------
function scrollToBottom() {
  requestAnimationFrame(() => {
    chatScroll.scrollTop = chatScroll.scrollHeight;
  });
}

function addChatRow(role, text) {
  const row = document.createElement("div");
  row.className = `chat-row ${role}`;

  const label = document.createElement("div");
  label.className = "chat-label";
  label.textContent = role === "user" ? "你" : "AI 助理";

  const bubble = document.createElement("div");
  bubble.className = "chat-bubble";
  bubble.textContent = text;

  row.append(label, bubble);
  chatScroll.appendChild(row);
  scrollToBottom();
  return row;
}

function addThinkingRow() {
  const row = document.createElement("div");
  row.className = "chat-row ai";
  row.innerHTML = `<div class="chat-label">AI 助理</div><div class="chat-bubble chat-bubble-thinking">思考中…</div>`;
  chatScroll.appendChild(row);
  scrollToBottom();
  return row;
}

function addHistoryEntry(question, targetRow) {
  historyEmpty.hidden = true;
  turnCount += 1;

  const item = document.createElement("li");
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "history-item";

  const title = document.createElement("span");
  title.className = "history-title";
  title.textContent = question.length > 24 ? `${question.slice(0, 24)}…` : question;

  const time = document.createElement("span");
  time.className = "history-time";
  time.textContent = new Date().toLocaleTimeString("zh-TW", { hour12: false });

  btn.append(title, time);
  btn.addEventListener("click", () => {
    targetRow.scrollIntoView({ behavior: "smooth", block: "center" });
  });

  item.appendChild(btn);
  historyList.prepend(item);
}

function resetChat() {
  chatScroll.innerHTML = "";
  addChatRow("ai", GREETING);
  historyList.innerHTML = "";
  historyList.appendChild(historyEmpty);
  historyEmpty.hidden = false;
  turnCount = 0;
  hint.textContent = "";
}

newChatBtn.addEventListener("click", resetChat);

// ---------- Simli avatar connection ----------
function showConnectFailure(message) {
  connectStatus.textContent = "連線失敗";
  setStatus("未連線", "tag-outline");
  hint.textContent = message;
  retryBtn.hidden = false;
}

async function connectAvatar() {
  retryBtn.hidden = true;
  connectOverlay.hidden = false;
  connectStatus.textContent = "AI教師啟動中…";
  avatarReady = false;
  setAskEnabled(false);

  if (simliClient) {
    try {
      await simliClient.stop();
    } catch {
      // already gone
    }
    simliClient = null;
  }

  const configRes = await fetch("/api/simli/config").catch(() => null);
  const config = configRes && configRes.ok ? await configRes.json() : { ready: false };
  if (!config.ready) {
    showConnectFailure("請先在伺服器設定 SIMLI_API_KEY，並執行 npm run setup:simli-face 建立 avatar。");
    return;
  }

  const sessionRes = await fetch("/api/simli/session", { method: "POST" }).catch((err) => {
    console.error("Simli session fetch failed", err);
    return null;
  });
  if (!sessionRes) {
    showConnectFailure("連不上伺服器，請確認網路連線後重試。");
    return;
  }
  const sessionData = await sessionRes.json();
  if (!sessionRes.ok) {
    console.error("Simli session error", sessionData);
    const detailMsg =
      sessionData.detail && typeof sessionData.detail === "object"
        ? sessionData.detail.detail || JSON.stringify(sessionData.detail)
        : sessionData.detail;
    showConnectFailure([sessionData.error, detailMsg].filter(Boolean).join("："));
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
    retryBtn.hidden = true;
    hint.textContent = "";
    setStatus("線上待命", "tag-accent");
    setAskEnabled(true);
  });

  simliClient.on("error", (err) => {
    console.error("Simli error", err);
    showConnectFailure("虛擬人連線發生錯誤，請按重試連線。");
  });

  try {
    await simliClient.start();
  } catch (err) {
    console.error(err);
    showConnectFailure("無法連線到虛擬人服務，請檢查網路後按重試連線。");
  }
}

retryBtn.addEventListener("click", connectAvatar);

// ---------- Audio: Gemini TTS WAV -> 16kHz PCM16 -> Simli ----------
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
  const params = new URLSearchParams({ text, rate: rateRange.value });
  const res = await fetch(`/api/tts?${params.toString()}`);
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    console.error("TTS error", data);
    throw new Error([data.error, data.detail].filter(Boolean).join("：") || "語音合成失敗");
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
async function askQuestion(question) {
  hint.textContent = "";
  setAskEnabled(false);
  setStatus("思考中", "tag-outline");

  addChatRow("user", question);
  const thinkingRow = addThinkingRow();

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

    thinkingRow.remove();
    const answerRow = addChatRow("ai", data.answer);
    addHistoryEntry(question, answerRow);

    stopRequested = false;
    setStatus("說話中", "tag-accent");
    speakingBadge.hidden = false;
    await synthesizeAndStream(data.answer);
  } catch (err) {
    console.error(err);
    thinkingRow.remove();
    hint.textContent = err.message || "發生錯誤，請重試。";
  } finally {
    speakingBadge.hidden = true;
    setStatus(avatarReady ? "線上待命" : "未連線", avatarReady ? "tag-accent" : "tag-outline");
    setAskEnabled(avatarReady);
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

  // Must call play() synchronously inside the real user gesture (this submit
  // handler), not after — mobile browsers (iOS Safari especially) revoke
  // autoplay permission once too much async time passes. Gemini TTS alone
  // takes 7-17s, well past that window, so by the time Simli's audio track
  // actually arrives the browser would otherwise silently block playback:
  // the (muted) video still renders, but no sound — which is exactly what
  // was reported. Priming play() now on the real gesture keeps the element
  // "unlocked" for when the track shows up later.
  audioEl.play().catch(() => {});

  questionInput.value = "";
  questionInput.style.height = "";
  askQuestion(question);
});

questionInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    askForm.requestSubmit();
  }
});

questionInput.addEventListener("input", () => {
  questionInput.style.height = "";
  questionInput.style.height = `${Math.min(questionInput.scrollHeight, 120)}px`;
});

rateRange.addEventListener("input", () => (rateVal.textContent = Number(rateRange.value).toFixed(1)));
volumeRange.addEventListener("input", () => {
  volumeVal.textContent = Number(volumeRange.value).toFixed(1);
  audioEl.volume = Number(volumeRange.value);
});

connectAvatar();
