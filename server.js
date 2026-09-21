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

// D-ID's /talks endpoint needs real fetchable URLs, not data: URIs, for both
// the source photo ("must be a valid image URL (ending with jpg|jpeg|png)")
// and the driving audio ("must be a valid https URL to an audio
// (flac,mp3,mp4,wav,m4a)") — confirmed by hitting the live API directly, even
// though the general D-ID docs describe data-URL support for source_url. The
// browser sends the photo as a data URL and we synthesize the WAV ourselves,
// so both get written here and served statically just long enough for D-ID
// to fetch them.
const TMP_DIR = path.join(os.tmpdir(), "speaking-video-tmp");
fs.mkdirSync(TMP_DIR, { recursive: true });

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
app.use("/tmp-media", express.static(TMP_DIR));

// ---------- In-memory job store ----------
const jobs = new Map();

function setJob(id, patch) {
  const job = jobs.get(id) || {};
  Object.assign(job, patch);
  jobs.set(id, job);
  return job;
}

function scheduleCleanup(id, filePaths) {
  setTimeout(() => {
    jobs.delete(id);
    filePaths.forEach((p) => fs.unlink(p, () => {}));
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

// Gemini's TTS model will sometimes treat short/conversational input (e.g. a
// plain greeting) as something to respond to rather than a transcript to
// read verbatim, and returns a 400 ("Model tried to generate text, but it
// should only be used for TTS"). A plain instructive prefix fixes it — this
// is the same technique withPaceDirection() used previously for rate
// control, confirmed in production not to get read aloud itself.
function withNarrationInstruction(text) {
  return `請逐字朗讀以下文字，不要回答、不要評論、不要新增任何內容：${text}`;
}

// ---------- Gemini TTS ----------
// Gemini returns headerless L16 PCM; wrap it in a WAV header — D-ID's
// audio_url validator requires the URL to end in flac/mp3/mp4/wav/m4a, and
// a real container so it can actually decode the audio.
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

  const pcm = Buffer.from(inline.data, "base64");
  const sampleRate = Number(/rate=(\d+)/.exec(inline.mimeType || "")?.[1]) || 24000;
  return Buffer.concat([wavHeader(pcm.length, sampleRate), pcm]);
}

// ---------- D-ID talking video ----------
// D-ID's dashboard issues API keys as a raw "<id>:<secret>" pair (note the
// colon) — that's HTTP Basic auth's username:password before encoding, not
// the finished header value, so it needs base64-encoding here. Some older
// D-ID keys are handed out pre-encoded (no colon); pass those through as-is.
function didAuthToken() {
  return DID_API_KEY.includes(":") ? Buffer.from(DID_API_KEY).toString("base64") : DID_API_KEY;
}

function didHeaders() {
  return { Authorization: `Basic ${didAuthToken()}`, "Content-Type": "application/json" };
}

// D-ID only does lip-sync here (script.type "audio") — the voice itself is
// entirely Gemini TTS (synthesizeSpeech() above), so it stays the male
// "Puck" voice this project settled on rather than switching to a D-ID/Azure
// voice. Confirmed against the live API that "audio" mode validates fine
// on this account once the audio_url has a supported extension (.wav).
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
    throw new Error(`D-ID 建立影片失敗：${data.description || data.kind || res.status}`);
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
      throw new Error(`D-ID 查詢狀態失敗：${data.description || data.kind || res.status}`);
    }
    if (data.status === "done") return data.result_url;
    if (data.status === "error" || data.status === "rejected") {
      throw new Error(`D-ID 影片生成失敗：${data.error?.description || data.status}`);
    }
  }
  throw new Error("D-ID 影片生成逾時");
}

async function processVideoJob(jobId, photoPath, photoUrl, text, baseUrl) {
  const audioPath = path.join(TMP_DIR, `${jobId}.wav`);
  try {
    setJob(jobId, { status: "synthesizing", message: "AI教師啟動中…" });
    const wavBuffer = await synthesizeSpeech(text);
    fs.writeFileSync(audioPath, wavBuffer);

    setJob(jobId, { status: "rendering", message: "AI教師模擬中…" });
    const audioUrl = `${baseUrl}/tmp-media/${jobId}.wav`;
    const talkId = await createTalk(photoUrl, audioUrl);
    const videoUrl = await pollTalk(talkId);

    setJob(jobId, { status: "done", message: "完成", videoUrl });
  } catch (err) {
    console.error(`影片工作 ${jobId} 失敗:`, err);
    setJob(jobId, { status: "error", error: err.message || String(err) });
  } finally {
    scheduleCleanup(jobId, [photoPath, audioPath]);
  }
}

app.post("/api/video/generate", (req, res) => {
  if (!GEMINI_API_KEY || !DID_API_KEY) {
    return res.status(500).json({ error: "尚未設定 GEMINI_API_KEY 或 DID_API_KEY，請在環境變數加入後重新啟動伺服器。" });
  }

  const { photo, text } = req.body || {};
  const photoMatch = typeof photo === "string" && /^data:image\/(jpeg|jpg|png);base64,(.+)$/.exec(photo);
  if (!photoMatch) {
    return res.status(400).json({ error: "請提供 JPEG 或 PNG 格式的照片（D-ID 不接受 WEBP）" });
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

  const ext = photoMatch[1] === "jpg" ? "jpeg" : photoMatch[1];
  const jobId = crypto.randomUUID();
  const photoPath = path.join(TMP_DIR, `${jobId}.${ext}`);
  fs.writeFileSync(photoPath, Buffer.from(photoMatch[2], "base64"));
  const photoUrl = `${req.protocol}://${req.get("host")}/tmp-media/${jobId}.${ext}`;
  const baseUrl = `${req.protocol}://${req.get("host")}`;

  setJob(jobId, { status: "queued", message: "排隊中…" });
  processVideoJob(jobId, photoPath, photoUrl, cleanText, baseUrl);

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
