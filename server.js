require("dotenv").config();
const path = require("path");
const fs = require("fs");
const { spawn } = require("child_process");
const { Readable } = require("stream");
const express = require("express");

const PORT = process.env.PORT || 3000;
const SIMLI_API_KEY = process.env.SIMLI_API_KEY;
const SIMLI_FACE_ID = process.env.SIMLI_FACE_ID;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";

const VOICES_DIR = path.join(__dirname, "voices");
const DEFAULT_VOICE = "zh_CN-chaowen-medium";
const PIPER_SERVICE_PORT = 5001;
const PIPER_SERVICE_URL = `http://127.0.0.1:${PIPER_SERVICE_PORT}`;

const app = express();
app.use(express.json({ limit: "20kb" }));
app.use(express.static(path.join(__dirname, "public")));

function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}

function listVoices() {
  if (!fs.existsSync(VOICES_DIR)) return [];
  return fs
    .readdirSync(VOICES_DIR)
    .filter((f) => f.endsWith(".onnx"))
    .map((f) => {
      const shortName = f.replace(/\.onnx$/, "");
      const configPath = path.join(VOICES_DIR, `${f}.json`);
      const localeMatch = shortName.match(/^([a-z]{2}_[A-Z]{2})/);
      const locale = localeMatch ? localeMatch[1].replace("_", "-") : "unknown";
      return { shortName, locale };
    })
    .filter((v) => fs.existsSync(path.join(VOICES_DIR, `${v.shortName}.onnx.json`)));
}

// ---------- Persistent Piper TTS service (Python) ----------
// Spawned once and kept warm for the life of the Node process: loading the
// Chinese phonemizer (BERT tokenizer + g2pW) from cold takes several seconds,
// which would otherwise happen on every single /api/tts request.
let piperServiceReady = false;

function startPiperService() {
  const voices = listVoices()
    .map((v) => v.shortName)
    .join(",");
  const env = { ...process.env, PIPER_PRELOAD_VOICES: voices, PIPER_SERVICE_PORT: String(PIPER_SERVICE_PORT) };
  const pythonBin = process.env.PYTHON_BIN || "python3";
  const child = spawn(pythonBin, [path.join(__dirname, "piper_service.py")], { env });

  child.stderr.on("data", (d) => {
    const line = d.toString();
    process.stderr.write(`[piper_service] ${line}`);
    if (line.includes("READY")) piperServiceReady = true;
  });
  child.on("error", (err) => {
    console.error("⚠️  無法啟動 piper_service.py（需要 Python 3 與 requirements.txt 依賴）：", err.message);
  });
  child.on("exit", (code) => {
    piperServiceReady = false;
    console.error(`piper_service.py 已結束 (code ${code})，語音合成將無法使用。`);
  });

  return child;
}

const piperService = startPiperService();

process.on("exit", () => piperService.kill());
process.on("SIGINT", () => process.exit());
process.on("SIGTERM", () => process.exit());

app.get("/api/voices", (req, res) => {
  const voices = listVoices();
  if (voices.length === 0) {
    return res.status(500).json({
      error: "尚未安裝任何語音模型，請先執行 npm run setup:voices。",
    });
  }
  res.json(
    voices.map((v) => ({
      shortName: v.shortName,
      locale: v.locale,
      displayName: v.shortName,
    }))
  );
});

app.get("/api/tts", async (req, res) => {
  const { text, voice, rate } = req.query || {};
  if (typeof text !== "string" || !text.trim()) {
    return res.status(400).json({ error: "請提供要朗讀的文字" });
  }
  if (text.length > 800) {
    return res.status(400).json({ error: "文字長度過長（上限 800 字）" });
  }
  if (!piperServiceReady) {
    return res.status(503).json({ error: "語音服務尚未就緒，請稍候再試。" });
  }

  const voices = listVoices();
  if (voices.length === 0) {
    return res.status(500).json({ error: "尚未安裝任何語音模型，請先執行 npm run setup:voices。" });
  }
  const selected = voices.find((v) => v.shortName === voice) || voices.find((v) => v.shortName === DEFAULT_VOICE) || voices[0];

  const rateVal = Number.isFinite(Number(rate)) ? Number(rate) : 1;
  const lengthScale = clamp(1 / rateVal, 0.4, 2.5);

  try {
    const params = new URLSearchParams({
      text,
      voice: selected.shortName,
      length_scale: String(lengthScale),
    });
    const svcRes = await fetch(`${PIPER_SERVICE_URL}/synthesize?${params.toString()}`);
    if (!svcRes.ok || !svcRes.body) {
      const detail = await svcRes.text().catch(() => "");
      return res.status(502).json({ error: "語音合成失敗", detail });
    }
    res.setHeader("Content-Type", "audio/wav");
    res.setHeader("Cache-Control", "no-store");
    Readable.fromWeb(svcRes.body).pipe(res);
  } catch (err) {
    res.status(502).json({ error: "連線語音服務失敗", detail: String(err) });
  }
});

// ---------- Gemini Q&A ----------
app.post("/api/ask", async (req, res) => {
  if (!GEMINI_API_KEY) {
    return res.status(500).json({ error: "尚未設定 GEMINI_API_KEY，請在 .env 加入後重新啟動伺服器。" });
  }

  const { question } = req.body || {};
  if (typeof question !== "string" || !question.trim()) {
    return res.status(400).json({ error: "請提供問題內容" });
  }
  if (question.length > 2000) {
    return res.status(400).json({ error: "問題長度過長（上限 2000 字）" });
  }

  try {
    const geminiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`,
      {
        method: "POST",
        headers: {
          "x-goog-api-key": GEMINI_API_KEY,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          contents: [{ parts: [{ text: question }] }],
        }),
      }
    );

    const data = await geminiRes.json();
    if (!geminiRes.ok) {
      console.error("Gemini 失敗:", geminiRes.status, JSON.stringify(data));
      return res.status(502).json({ error: "問答服務發生錯誤", detail: data.error && data.error.message });
    }

    const answer = data.candidates?.[0]?.content?.parts?.map((p) => p.text).join("") || "";
    if (!answer) {
      return res.status(502).json({ error: "沒有取得回答內容", detail: data });
    }
    res.json({ answer });
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
      error: "尚未設定 Simli，請先在 .env 設定 SIMLI_API_KEY，並執行 npm run setup:simli-face 建立 avatar。",
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
  console.log(`Speaking-photo server running at http://localhost:${PORT}`);
  if (listVoices().length === 0) {
    console.warn("⚠️  尚未安裝語音模型，請執行 `npm run setup:voices`。");
  }
  if (!SIMLI_API_KEY || !SIMLI_FACE_ID) {
    console.warn("⚠️  尚未設定 Simli，請在 .env 設定 SIMLI_API_KEY 並執行 `npm run setup:simli-face <照片路徑>`。");
  }
  if (!GEMINI_API_KEY) {
    console.warn("⚠️  尚未設定 GEMINI_API_KEY，問答功能將無法使用。");
  }
});
