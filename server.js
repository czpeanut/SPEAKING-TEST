require("dotenv").config();
const path = require("path");
const crypto = require("crypto");
const express = require("express");

const PORT = process.env.PORT || 3000;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_TTS_MODEL = process.env.GEMINI_TTS_MODEL || "gemini-2.5-flash-preview-tts";
const GEMINI_TTS_VOICE = process.env.GEMINI_TTS_VOICE || "Puck";
const SIMLI_API_KEY = process.env.SIMLI_API_KEY;
const SIMLI_FACE_ID = process.env.SIMLI_FACE_ID;

const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta/models";
const SIMLI_BASE = "https://api.simli.ai";

const TEXT_MAX_LENGTH = 1500;
const JOB_TTL_MS = 15 * 60 * 1000;
const MP4_READY_BUFFER_MS = 2000;

const app = express();
app.use(express.json({ limit: "50kb" })); // just { text } now — no photo in the request

// No content hashing on the built bundle, so make sure browsers always
// revalidate instead of silently running a stale app.bundle.js after a
// deploy. Must run before express.static, since that responds directly and
// skips later middleware.
app.use((req, res, next) => {
  res.setHeader("Cache-Control", "no-cache");
  next();
});
app.use(express.static(path.join(__dirname, "public"), { etag: true, lastModified: true }));

// ---------- In-memory job store ----------
const jobs = new Map();

function setJob(id, patch) {
  const job = jobs.get(id) || {};
  Object.assign(job, patch);
  jobs.set(id, job);
  return job;
}

function scheduleCleanup(id) {
  setTimeout(() => jobs.delete(id), JOB_TTL_MS).unref();
}

// ---------- Text sanitizing ----------
// Documents pasted in by the user may carry Markdown/LaTeX from wherever
// they came from; strip it before speech synthesis rather than having the
// voice read out literal symbols.
function sanitizeForSpeech(text) {
  return text
    .replace(/\$\$?/g, "")
    .replace(/\\frac\{([^{}]*)\}\{([^{}]*)\}/g, "$1 除以 $2")
    .replace(/\\sqrt\{([^{}]*)\}/g, "$1 的平方根")
    .replace(/\\[a-zA-Z]+/g, "")
    .replace(/[{}]/g, "")
    .replace(/\*\*(.*?)\*\*/g, "$1")
    .replace(/\*(.*?)\*/g, "$1")
    .replace(/`+/g, "")
    .replace(/^#{1,6}\s*/gm, "")
    .replace(/^[-*+]\s+/gm, "")
    .replace(/^\d+\.\s+/gm, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

// Gemini's TTS model will sometimes treat short/conversational input (e.g. a
// plain greeting) as something to respond to rather than a transcript to
// read verbatim, and returns a 400 ("Model tried to generate text, but it
// should only be used for TTS"). A plain instructive prefix fixes it.
function withNarrationInstruction(text) {
  return `請逐字朗讀以下文字，不要回答、不要評論、不要新增任何內容：${text}`;
}

// ---------- Gemini TTS ----------
// Returns raw base64 PCM16 + its sample rate — Simli's /static/audio takes
// PCM directly (audioFormat: "pcm16"), so unlike the earlier D-ID version
// there's no WAV container to build here.
async function synthesizeSpeech(text) {
  const ttsRes = await fetch(`${GEMINI_BASE}/${GEMINI_TTS_MODEL}:generateContent`, {
    method: "POST",
    headers: { "x-goog-api-key": GEMINI_API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: withNarrationInstruction(text) }] }],
      generationConfig: {
        responseModalities: ["AUDIO"],
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: GEMINI_TTS_VOICE } } },
      },
    }),
  });

  const data = await ttsRes.json();
  if (!ttsRes.ok) {
    throw new Error(`語音合成失敗：${(data.error && data.error.message) || ttsRes.status}`);
  }

  const inline = data.candidates?.[0]?.content?.parts?.find((p) => p.inlineData)?.inlineData;
  if (!inline?.data) {
    throw new Error("語音合成沒有回傳音訊");
  }

  const sampleRate = Number(/rate=(\d+)/.exec(inline.mimeType || "")?.[1]) || 24000;
  return { audioBase64: inline.data, sampleRate };
}

// ---------- Simli static video ----------
// Simli's batch endpoint for a pre-created face: feed it audio, get back an
// mp4 (and hls) URL, ready within a couple of seconds — no polling job
// status for minutes like D-ID. The face itself (SIMLI_FACE_ID) is created
// once, out of band, via `npm run setup:simli-face <photo>`.
async function generateSimliVideo(audioBase64, sampleRate) {
  const res = await fetch(`${SIMLI_BASE}/static/audio`, {
    method: "POST",
    headers: { "x-simli-api-key": SIMLI_API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({
      faceId: SIMLI_FACE_ID,
      audioBase64,
      audioFormat: "pcm16",
      audioSampleRate: sampleRate,
      audioChannelCount: 1,
    }),
  });
  const data = await res.json();
  if (!res.ok || !data.mp4_url) {
    throw new Error(`Simli 影片生成失敗：${data.detail ? JSON.stringify(data.detail) : res.status}`);
  }
  return { mp4Url: data.mp4_url, etaSeconds: data.mp4_availablility_eta_seconds || 0 };
}

async function processVideoJob(jobId, text) {
  try {
    setJob(jobId, { status: "synthesizing", message: "AI教師啟動中…" });
    const { audioBase64, sampleRate } = await synthesizeSpeech(text);

    setJob(jobId, { status: "rendering", message: "AI教師模擬中…" });
    const { mp4Url, etaSeconds } = await generateSimliVideo(audioBase64, sampleRate);
    // Simli's mp4 host doesn't support HEAD (405), so we can't poll for
    // readiness — just wait out the ETA it hands back plus a small buffer.
    await new Promise((r) => setTimeout(r, etaSeconds * 1000 + MP4_READY_BUFFER_MS));

    setJob(jobId, { status: "done", message: "完成", videoUrl: mp4Url });
  } catch (err) {
    console.error(`影片工作 ${jobId} 失敗:`, err);
    setJob(jobId, { status: "error", error: err.message || String(err) });
  } finally {
    scheduleCleanup(jobId);
  }
}

app.post("/api/video/generate", (req, res) => {
  if (!GEMINI_API_KEY || !SIMLI_API_KEY || !SIMLI_FACE_ID) {
    return res.status(500).json({
      error: "尚未設定 GEMINI_API_KEY、SIMLI_API_KEY 或 SIMLI_FACE_ID，請先執行 npm run setup:simli-face 並設定環境變數。",
    });
  }

  const { text } = req.body || {};
  if (typeof text !== "string" || !text.trim()) {
    return res.status(400).json({ error: "請提供要講出來的文件內容" });
  }
  const cleanText = sanitizeForSpeech(text).slice(0, TEXT_MAX_LENGTH);
  if (!cleanText) {
    return res.status(400).json({ error: "文件內容清理後是空的，請確認內容不是純符號/格式標記" });
  }
  if (text.trim().length > TEXT_MAX_LENGTH) {
    console.warn(`文件長度 ${text.trim().length} 超過上限 ${TEXT_MAX_LENGTH}，已截斷`);
  }

  const jobId = crypto.randomUUID();
  setJob(jobId, { status: "queued", message: "排隊中…" });
  processVideoJob(jobId, cleanText);

  res.status(202).json({ jobId, truncated: text.trim().length > TEXT_MAX_LENGTH });
});

app.get("/api/video/status/:id", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) {
    return res.status(404).json({ error: "找不到這個工作，可能已過期" });
  }
  res.json(job);
});

app.listen(PORT, () => {
  console.log(`Speaking-photo server running at http://localhost:${PORT}`);
  if (!GEMINI_API_KEY) {
    console.warn("⚠️  尚未設定 GEMINI_API_KEY，語音合成將無法使用。");
  }
  if (!SIMLI_API_KEY || !SIMLI_FACE_ID) {
    console.warn("⚠️  尚未設定 Simli，請設定 SIMLI_API_KEY 並執行 `npm run setup:simli-face <照片路徑>`。");
  }
});
