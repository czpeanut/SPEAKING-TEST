require("dotenv").config();
const path = require("path");
const express = require("express");

const PORT = process.env.PORT || 3000;
const SIMLI_API_KEY = process.env.SIMLI_API_KEY;
const SIMLI_FACE_ID = process.env.SIMLI_FACE_ID;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-3.6-flash";
const GEMINI_TTS_MODEL = process.env.GEMINI_TTS_MODEL || "gemini-2.5-flash-preview-tts";
const GEMINI_TTS_VOICE = process.env.GEMINI_TTS_VOICE || "Puck";

const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta/models";

const app = express();
app.use(express.json({ limit: "20kb" }));
// No content hashing on the built bundle, so make sure browsers always
// revalidate instead of silently running a stale app.bundle.js after a
// deploy (this bit us once already — a fix looked like it did nothing
// because the browser never re-fetched the new JS). Must run before
// express.static, since that responds directly and skips later middleware.
app.use((req, res, next) => {
  res.setHeader("Cache-Control", "no-cache");
  next();
});
app.use(express.static(path.join(__dirname, "public"), { etag: true, lastModified: true }));

const SPEECH_SYSTEM_INSTRUCTION =
  "你是一個用聲音回答問題的語音助手，你的回答會直接被語音合成朗讀出來，使用者聽不到也看不到任何符號。" +
  "規則：(1) 只用簡短口語化的白話文回答，控制在 3 句話以內。" +
  "(2) 絕對不要使用 Markdown 格式，不要有 **、#、-、`、條列清單。" +
  "(3) 絕對不要使用 LaTeX 或數學符號語法，例如不要寫 $\\frac{a}{b}$，要用「a 除以 b」這種口語講法；不要寫 $x^2$，要說「x 的平方」。" +
  "(4) 不要輸出任何無法唸出來的符號。";

// Defensive cleanup in case the model still slips in formatting despite the
// system instruction above — strips it rather than reading symbols aloud.
function sanitizeForSpeech(text) {
  return text
    .replace(/\$\$?/g, "") // LaTeX delimiters
    .replace(/\\frac\{([^{}]*)\}\{([^{}]*)\}/g, "$1 除以 $2")
    .replace(/\\sqrt\{([^{}]*)\}/g, "$1 的平方根")
    .replace(/\\[a-zA-Z]+/g, "") // remaining LaTeX commands
    .replace(/[{}]/g, "")
    .replace(/\*\*(.*?)\*\*/g, "$1") // **bold**
    .replace(/\*(.*?)\*/g, "$1") // *italic*
    .replace(/`+/g, "")
    .replace(/^#{1,6}\s*/gm, "") // headers
    .replace(/^[-*+]\s+/gm, "") // bullet markers
    .replace(/^\d+\.\s+/gm, "") // numbered list markers
    .replace(/[ \t]+/g, " ")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

// Gemini's TTS models have no rate parameter; they take direction in plain
// language instead, which measurably changes the delivery (the same sentence
// runs ~12s "slow" / ~7s default / ~5s "fast").
function withPaceDirection(text, rate) {
  if (rate <= 0.85) return `請用較慢的語速說：${text}`;
  if (rate >= 1.15) return `請用較快的語速說：${text}`;
  return text;
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

// ---------- Text to speech ----------
// Gemini returns headerless L16 PCM; the browser's decodeAudioData needs a
// container, so wrap it in a WAV header before sending it on.
app.get("/api/tts", async (req, res) => {
  if (!GEMINI_API_KEY) {
    return res.status(500).json({ error: "尚未設定 GEMINI_API_KEY，請在環境變數加入後重新啟動伺服器。" });
  }

  const { text, rate } = req.query || {};
  if (typeof text !== "string" || !text.trim()) {
    return res.status(400).json({ error: "請提供要朗讀的文字" });
  }
  if (text.length > 2000) {
    return res.status(400).json({ error: "文字長度過長（上限 2000 字）" });
  }

  const rateVal = Number.isFinite(Number(rate)) ? Number(rate) : 1;

  try {
    const ttsRes = await fetch(`${GEMINI_BASE}/${GEMINI_TTS_MODEL}:generateContent`, {
      method: "POST",
      headers: { "x-goog-api-key": GEMINI_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: withPaceDirection(text, rateVal) }] }],
        generationConfig: {
          responseModalities: ["AUDIO"],
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: GEMINI_TTS_VOICE } } },
        },
      }),
    });

    const data = await ttsRes.json();
    if (!ttsRes.ok) {
      console.error("Gemini TTS 失敗:", ttsRes.status, JSON.stringify(data).slice(0, 500));
      return res.status(502).json({ error: "語音合成失敗", detail: data.error && data.error.message });
    }

    const inline = data.candidates?.[0]?.content?.parts?.find((p) => p.inlineData)?.inlineData;
    if (!inline?.data) {
      console.error("Gemini TTS 沒有回傳音訊:", JSON.stringify(data).slice(0, 500));
      return res.status(502).json({ error: "語音合成沒有回傳音訊" });
    }

    const pcm = Buffer.from(inline.data, "base64");
    const sampleRate = Number(/rate=(\d+)/.exec(inline.mimeType || "")?.[1]) || 24000;

    res.setHeader("Content-Type", "audio/wav");
    res.setHeader("Cache-Control", "no-store");
    res.send(Buffer.concat([wavHeader(pcm.length, sampleRate), pcm]));
  } catch (err) {
    console.error("連線語音合成服務失敗:", err);
    res.status(502).json({ error: "連線語音合成服務失敗", detail: String(err) });
  }
});

// ---------- Gemini Q&A ----------
app.post("/api/ask", async (req, res) => {
  if (!GEMINI_API_KEY) {
    return res.status(500).json({ error: "尚未設定 GEMINI_API_KEY，請在環境變數加入後重新啟動伺服器。" });
  }

  const { question } = req.body || {};
  if (typeof question !== "string" || !question.trim()) {
    return res.status(400).json({ error: "請提供問題內容" });
  }
  if (question.length > 2000) {
    return res.status(400).json({ error: "問題長度過長（上限 2000 字）" });
  }

  try {
    const geminiRes = await fetch(`${GEMINI_BASE}/${GEMINI_MODEL}:generateContent`, {
      method: "POST",
      headers: { "x-goog-api-key": GEMINI_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: SPEECH_SYSTEM_INSTRUCTION }] },
        contents: [{ parts: [{ text: question }] }],
        // gemini-3.6-flash spends a variable, sometimes large, number of tokens
        // "thinking" before it writes the visible answer, and that eats into
        // maxOutputTokens — too low a cap truncates the answer itself
        // (finishReason: MAX_TOKENS) before it gets a chance to speak.
        generationConfig: { maxOutputTokens: 2048 },
      }),
    });

    const data = await geminiRes.json();
    if (!geminiRes.ok) {
      console.error("Gemini 失敗:", geminiRes.status, JSON.stringify(data).slice(0, 500));
      return res.status(502).json({ error: "問答服務發生錯誤", detail: data.error && data.error.message });
    }

    const rawAnswer = data.candidates?.[0]?.content?.parts?.map((p) => p.text).join("") || "";
    if (!rawAnswer) {
      return res.status(502).json({ error: "沒有取得回答內容", detail: data });
    }
    res.json({ answer: sanitizeForSpeech(rawAnswer).slice(0, 800) });
  } catch (err) {
    console.error("連線 Gemini 服務失敗:", err);
    res.status(502).json({ error: "連線問答服務失敗", detail: String(err) });
  }
});

// ---------- Simli avatar ----------
// Tells the frontend whether an avatar is configured, without exposing the API key.
app.get("/api/simli/config", (req, res) => {
  res.json({ ready: Boolean(SIMLI_API_KEY && SIMLI_FACE_ID) });
});

// Mints a short-lived Simli session token server-side, so SIMLI_API_KEY never
// reaches the browser. The frontend uses the returned token to open a session
// with the simli-client SDK directly.
app.post("/api/simli/session", async (req, res) => {
  if (!SIMLI_API_KEY || !SIMLI_FACE_ID) {
    return res.status(500).json({
      error: "尚未設定 Simli，請先設定 SIMLI_API_KEY，並執行 npm run setup:simli-face 建立 avatar。",
    });
  }

  try {
    const simliRes = await fetch("https://api.simli.ai/compose/token", {
      method: "POST",
      headers: {
        "x-simli-api-key": SIMLI_API_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        faceId: SIMLI_FACE_ID,
        apiVersion: "v2",
        audioInputFormat: "pcm16",
      }),
    });

    const data = await simliRes.json();
    if (!simliRes.ok || !data.session_token || data.session_token === "FAIL TOKEN") {
      console.error("Simli compose/token 失敗:", simliRes.status, JSON.stringify(data));
      return res.status(502).json({ error: "無法建立 Simli session", detail: data });
    }
    res.json({ session_token: data.session_token });
  } catch (err) {
    console.error("連線 Simli 服務失敗:", err);
    res.status(502).json({ error: "連線 Simli 服務失敗", detail: String(err) });
  }
});

app.listen(PORT, () => {
  console.log(`Speaking-avatar server running at http://localhost:${PORT}`);
  if (!GEMINI_API_KEY) {
    console.warn("⚠️  尚未設定 GEMINI_API_KEY，問答與語音功能將無法使用。");
  }
  if (!SIMLI_API_KEY || !SIMLI_FACE_ID) {
    console.warn("⚠️  尚未設定 Simli，請設定 SIMLI_API_KEY 並執行 `npm run setup:simli-face <照片路徑>`。");
  }
});
