require("dotenv").config();
const path = require("path");
const express = require("express");
const { Readable } = require("stream");

const PORT = process.env.PORT || 3000;
const AZURE_SPEECH_KEY = process.env.AZURE_SPEECH_KEY;
const AZURE_SPEECH_REGION = process.env.AZURE_SPEECH_REGION;

const app = express();
app.use(express.json({ limit: "50kb" }));
app.use(express.static(path.join(__dirname, "public")));

function escapeXml(str) {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function requireAzureConfig(res) {
  if (!AZURE_SPEECH_KEY || !AZURE_SPEECH_REGION) {
    res.status(500).json({
      error: "缺少 Azure Speech 設定，請在伺服器的 .env 檔設定 AZURE_SPEECH_KEY 與 AZURE_SPEECH_REGION（參考 .env.example）。",
    });
    return false;
  }
  return true;
}

// List available Azure neural voices (used to populate the voice picker on the client).
app.get("/api/voices", async (req, res) => {
  if (!requireAzureConfig(res)) return;
  try {
    const azureRes = await fetch(
      `https://${AZURE_SPEECH_REGION}.tts.speech.microsoft.com/cognitiveservices/voices/list`,
      { headers: { "Ocp-Apim-Subscription-Key": AZURE_SPEECH_KEY } }
    );
    if (!azureRes.ok) {
      const detail = await azureRes.text();
      return res.status(azureRes.status).json({ error: "無法取得語音清單", detail });
    }
    const voices = await azureRes.json();
    // Trim the payload to what the client actually needs.
    const slim = voices.map((v) => ({
      shortName: v.ShortName,
      locale: v.Locale,
      displayName: v.LocalName || v.DisplayName,
      gender: v.Gender,
    }));
    res.json(slim);
  } catch (err) {
    res.status(502).json({ error: "連線 Azure Speech 服務失敗", detail: String(err) });
  }
});

// Synthesize speech and stream the audio straight through to the client.
// GET (not POST) so the browser's <audio> element can request it directly by URL
// and play the response progressively as bytes arrive, instead of waiting for a
// full fetch()+blob() round trip.
app.get("/api/tts", async (req, res) => {
  if (!requireAzureConfig(res)) return;

  const { text, voice, rate, pitch } = req.query || {};
  if (typeof text !== "string" || !text.trim()) {
    return res.status(400).json({ error: "請提供要朗讀的文字" });
  }
  if (text.length > 800) {
    return res.status(400).json({ error: "文字長度過長（上限 800 字）" });
  }

  const voiceName = typeof voice === "string" && voice.trim() ? voice : "zh-TW-HsiaoChenNeural";
  const rateVal = Number.isFinite(Number(rate)) ? Number(rate) : 1;
  const pitchVal = Number.isFinite(Number(pitch)) ? Number(pitch) : 1;
  const ratePct = Math.round((rateVal - 1) * 100);
  const pitchPct = Math.round((pitchVal - 1) * 100);

  const ssml = `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="zh-TW">
  <voice name="${escapeXml(voiceName)}">
    <prosody rate="${ratePct >= 0 ? "+" : ""}${ratePct}%" pitch="${pitchPct >= 0 ? "+" : ""}${pitchPct}%">
      ${escapeXml(text)}
    </prosody>
  </voice>
</speak>`;

  try {
    const azureRes = await fetch(
      `https://${AZURE_SPEECH_REGION}.tts.speech.microsoft.com/cognitiveservices/v1`,
      {
        method: "POST",
        headers: {
          "Ocp-Apim-Subscription-Key": AZURE_SPEECH_KEY,
          "Content-Type": "application/ssml+xml",
          "X-Microsoft-OutputFormat": "audio-24khz-48kbitrate-mono-mp3",
          "User-Agent": "speaking-photo-app",
        },
        body: ssml,
      }
    );

    if (!azureRes.ok || !azureRes.body) {
      const detail = await azureRes.text().catch(() => "");
      return res.status(azureRes.status || 502).json({ error: "語音合成失敗", detail });
    }

    res.setHeader("Content-Type", "audio/mpeg");
    res.setHeader("Cache-Control", "no-store");
    Readable.fromWeb(azureRes.body).pipe(res);
  } catch (err) {
    res.status(502).json({ error: "連線 Azure Speech 服務失敗", detail: String(err) });
  }
});

app.listen(PORT, () => {
  console.log(`Speaking-photo server running at http://localhost:${PORT}`);
  if (!AZURE_SPEECH_KEY || !AZURE_SPEECH_REGION) {
    console.warn("⚠️  尚未設定 AZURE_SPEECH_KEY / AZURE_SPEECH_REGION，語音合成端點將回傳錯誤。請複製 .env.example 為 .env 並填入金鑰。");
  }
});
