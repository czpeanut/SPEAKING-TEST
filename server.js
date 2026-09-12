require("dotenv").config();
const path = require("path");
const fs = require("fs");
const { spawn } = require("child_process");
const express = require("express");

const PORT = process.env.PORT || 3000;
const SIMLI_API_KEY = process.env.SIMLI_API_KEY;
const SIMLI_FACE_ID = process.env.SIMLI_FACE_ID;

const PIPER_DIR = path.join(__dirname, "vendor", "piper");
const PIPER_BIN = path.join(PIPER_DIR, process.platform === "win32" ? "piper.exe" : "piper");
const ESPEAK_DATA_DIR = path.join(PIPER_DIR, "espeak-ng-data");
const VOICES_DIR = path.join(__dirname, "voices");

const app = express();
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
      const modelPath = path.join(VOICES_DIR, f);
      const configPath = `${modelPath}.json`;
      const localeMatch = shortName.match(/^([a-z]{2}_[A-Z]{2})/);
      const locale = localeMatch ? localeMatch[1].replace("_", "-") : "unknown";
      return { shortName, modelPath, configPath, locale };
    })
    .filter((v) => fs.existsSync(v.configPath));
}

app.get("/api/voices", (req, res) => {
  const voices = listVoices();
  if (voices.length === 0) {
    return res.status(500).json({
      error: "尚未安裝任何語音模型，請先執行 npm run setup:piper 下載 Piper 執行檔與語音模型。",
    });
  }
  res.json(
    voices.map((v) => ({
      shortName: v.shortName,
      locale: v.locale,
      displayName: v.shortName,
      gender: "unknown",
    }))
  );
});

app.get("/api/tts", (req, res) => {
  const { text, voice, rate } = req.query || {};
  if (typeof text !== "string" || !text.trim()) {
    return res.status(400).json({ error: "請提供要朗讀的文字" });
  }
  if (text.length > 800) {
    return res.status(400).json({ error: "文字長度過長（上限 800 字）" });
  }

  if (!fs.existsSync(PIPER_BIN)) {
    return res.status(500).json({
      error: "尚未安裝 Piper 執行檔，請先執行 npm run setup:piper。",
    });
  }

  const voices = listVoices();
  if (voices.length === 0) {
    return res.status(500).json({
      error: "尚未安裝任何語音模型，請先執行 npm run setup:piper。",
    });
  }
  const selected = voices.find((v) => v.shortName === voice) || voices[0];

  const rateVal = Number.isFinite(Number(rate)) ? Number(rate) : 1;
  const lengthScale = clamp(1 / rateVal, 0.4, 2.5);

  const args = [
    "--model", selected.modelPath,
    "--config", selected.configPath,
    "--output_file", "-",
    "--length_scale", String(lengthScale),
  ];
  if (fs.existsSync(ESPEAK_DATA_DIR)) {
    args.push("--espeak_data", ESPEAK_DATA_DIR);
  }

  const env = { ...process.env };
  if (process.platform === "linux") {
    env.LD_LIBRARY_PATH = env.LD_LIBRARY_PATH ? `${PIPER_DIR}:${env.LD_LIBRARY_PATH}` : PIPER_DIR;
  } else if (process.platform === "darwin") {
    env.DYLD_LIBRARY_PATH = env.DYLD_LIBRARY_PATH ? `${PIPER_DIR}:${env.DYLD_LIBRARY_PATH}` : PIPER_DIR;
  }

  const child = spawn(PIPER_BIN, args, { env });

  let stderrBuf = "";
  child.stderr.on("data", (d) => (stderrBuf += d.toString()));

  child.on("error", (err) => {
    if (!res.headersSent) {
      res.status(500).json({ error: "語音合成程序啟動失敗", detail: String(err) });
    }
  });

  child.on("close", (code) => {
    if (code !== 0) {
      console.error("Piper 執行失敗:", stderrBuf);
      if (!res.headersSent) {
        res.status(500).json({ error: "語音合成失敗", detail: stderrBuf });
      }
    }
  });

  res.setHeader("Content-Type", "audio/wav");
  res.setHeader("Cache-Control", "no-store");
  child.stdout.pipe(res);

  child.stdin.write(text);
  child.stdin.end();
});

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
      return res.status(502).json({ error: "無法建立 Simli session", detail: data });
    }
    res.json({ session_token: data.session_token });
  } catch (err) {
    res.status(502).json({ error: "連線 Simli 服務失敗", detail: String(err) });
  }
});

app.listen(PORT, () => {
  console.log(`Speaking-photo server running at http://localhost:${PORT}`);
  if (!fs.existsSync(PIPER_BIN) || listVoices().length === 0) {
    console.warn("⚠️  尚未安裝 Piper 執行檔或語音模型，請執行 `npm run setup:piper`。");
  }
  if (!SIMLI_API_KEY || !SIMLI_FACE_ID) {
    console.warn("⚠️  尚未設定 Simli，請在 .env 設定 SIMLI_API_KEY 並執行 `npm run setup:simli-face <照片路徑>`。");
  }
});
