require("dotenv").config();
const path = require("path");
const os = require("os");
const fs = require("fs");
const crypto = require("crypto");
const express = require("express");

const PORT = process.env.PORT || 3000;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_TTS_MODEL = process.env.GEMINI_TTS_MODEL || "gemini-2.5-flash-preview-tts";
const GEMINI_TTS_VOICE = process.env.GEMINI_TTS_VOICE || "Puck";
const DID_API_KEY = process.env.DID_API_KEY;

const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta/models";
const DID_BASE = "https://api.d-id.com";

const TEXT_MAX_LENGTH = 1500;
const POLL_INTERVAL_MS = 3000;
const POLL_TIMEOUT_MS = 5 * 60 * 1000;
const JOB_TTL_MS = 15 * 60 * 1000;

// D-ID needs to fetch the generated audio from a public URL (unlike the
// source photo, which it accepts as a data URL directly). We write each
// job's synthesized speech here and serve it statically, then delete it
// once the job finishes or expires.
const TMP_AUDIO_DIR = path.join(os.tmpdir(), "speaking-video-audio");
fs.mkdirSync(TMP_AUDIO_DIR, { recursive: true });

const app = express();
app.set("trust proxy", true); // behind Render's proxy, needed so req.protocol reports https
app.use(express.json({ limit: "20mb" })); // photo is sent as a base64 data URL

// No content hashing on the built bundle, so make sure browsers always
// revalidate instead of silently running a stale app.bundle.js after a
// deploy. Must run before express.static, since that responds directly and
// skips later middleware.
app.use((req, res, next) => {
  res.setHeader("Cache-Control", "no-cache");
  next();
});
app.use(express.static(path.join(__dirname, "public"), { etag: true, lastModified: true }));
app.use("/tmp-audio", express.static(TMP_AUDIO_DIR));

// ---------- In-memory job store ----------
const jobs = new Map();

function setJob(id, patch) {
  const job = jobs.get(id) || {};
  Object.assign(job, patch);
  jobs.set(id, job);
  return job;
}

function scheduleCleanup(id, audioPath) {
  setTimeout(() => {
    jobs.delete(id);
    if (audioPath) fs.unlink(audioPath, () => {});
  }, JOB_TTL_MS).unref();
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

function wavHeader(dataLength, sampleRate, channels = 1, bitsPerSample = 16) {
  const header = Buffer.alloc(44);
  const blockAlign = (channels * bitsPerSample) / 8;
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + dataLength, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * blockAlign, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write("data", 36);
  header.writeUInt32LE(dataLength, 40);
  return header;
}

// ---------- Gemini TTS ----------
// Gemini returns headerless L16 PCM; wrap it in a WAV header so D-ID (and
// any browser) can just play/decode the file directly.
async function synthesizeSpeech(text) {
  const ttsRes = await fetch(`${GEMINI_BASE}/${GEMINI_TTS_MODEL}:generateContent`, {
    method: "POST",
    headers: { "x-goog-api-key": GEMINI_API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text }] }],
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

  const pcm = Buffer.from(inline.data, "base64");
  const sampleRate = Number(/rate=(\d+)/.exec(inline.mimeType || "")?.[1]) || 24000;
  return Buffer.concat([wavHeader(pcm.length, sampleRate), pcm]);
}

// ---------- D-ID talking video ----------
function didHeaders() {
  return { Authorization: `Basic ${DID_API_KEY}`, "Content-Type": "application/json" };
}

async function createTalk(sourceUrl, audioUrl) {
  const res = await fetch(`${DID_BASE}/talks`, {
    method: "POST",
    headers: didHeaders(),
    body: JSON.stringify({
      source_url: sourceUrl,
      script: { type: "audio", audio_url: audioUrl },
      config: { stitch: true, result_format: "mp4" },
    }),
  });
  const data = await res.json();
  if (!res.ok || !data.id) {
    throw new Error(`D-ID 建立影片失敗：${(data.description || data.kind || res.status)}`);
  }
  return data.id;
}

async function pollTalk(talkId) {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    const res = await fetch(`${DID_BASE}/talks/${talkId}`, { headers: didHeaders() });
    const data = await res.json();
    if (!res.ok) {
      throw new Error(`D-ID 查詢狀態失敗：${(data.description || data.kind || res.status)}`);
    }
    if (data.status === "done") return data.result_url;
    if (data.status === "error" || data.status === "rejected") {
      throw new Error(`D-ID 影片生成失敗：${data.error?.description || data.status}`);
    }
  }
  throw new Error("D-ID 影片生成逾時");
}

async function processVideoJob(jobId, photoDataUrl, text, baseUrl) {
  const audioPath = path.join(TMP_AUDIO_DIR, `${jobId}.wav`);
  try {
    setJob(jobId, { status: "synthesizing", message: "AI教師啟動中…" });
    const wavBuffer = await synthesizeSpeech(text);
    fs.writeFileSync(audioPath, wavBuffer);

    setJob(jobId, { status: "rendering", message: "AI教師模擬中…" });
    const audioUrl = `${baseUrl}/tmp-audio/${jobId}.wav`;
    const talkId = await createTalk(photoDataUrl, audioUrl);
    const videoUrl = await pollTalk(talkId);

    setJob(jobId, { status: "done", message: "完成", videoUrl });
  } catch (err) {
    console.error(`影片工作 ${jobId} 失敗:`, err);
    setJob(jobId, { status: "error", error: err.message || String(err) });
  } finally {
    fs.unlink(audioPath, () => {});
    scheduleCleanup(jobId, null);
  }
}

app.post("/api/video/generate", (req, res) => {
  if (!GEMINI_API_KEY || !DID_API_KEY) {
    return res.status(500).json({ error: "尚未設定 GEMINI_API_KEY 或 DID_API_KEY，請在環境變數加入後重新啟動伺服器。" });
  }

  const { photo, text } = req.body || {};
  if (typeof photo !== "string" || !/^data:image\/(jpeg|jpg|png|webp);base64,/.test(photo)) {
    return res.status(400).json({ error: "請提供 JPEG、PNG 或 WEBP 格式的照片" });
  }
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
  const baseUrl = `${req.protocol}://${req.get("host")}`;
  setJob(jobId, { status: "queued", message: "排隊中…" });
  processVideoJob(jobId, photo, cleanText, baseUrl);

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
  if (!DID_API_KEY) {
    console.warn("⚠️  尚未設定 DID_API_KEY，影片生成將無法使用。");
  }
});
