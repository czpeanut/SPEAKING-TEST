#!/usr/bin/env node
// Downloads the Piper voice models used by piper_service.py. No native binary
// needed — synthesis runs through the Python `piper-tts` package (see
// requirements.txt / piper_service.py), which is required separately for
// Chinese phonemization support.
const fs = require("fs");
const path = require("path");

const VOICES_DIR = path.join(__dirname, "..", "voices");
const HF_BASE = "https://huggingface.co/rhasspy/piper-voices/resolve/main/zh/zh_CN";

// name -> { dir, quality } — must match VOICE_PROFILES in server.js
const VOICES = {
  "zh_CN-huayan-medium": "huayan/medium",
  "zh_CN-chaowen-medium": "chaowen/medium",
};

async function download(url, destPath) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`下載失敗 (${res.status}): ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(destPath, buf);
}

async function main() {
  fs.mkdirSync(VOICES_DIR, { recursive: true });

  for (const [name, subpath] of Object.entries(VOICES)) {
    const modelPath = path.join(VOICES_DIR, `${name}.onnx`);
    const configPath = path.join(VOICES_DIR, `${name}.onnx.json`);
    if (fs.existsSync(modelPath) && fs.existsSync(configPath)) {
      console.log(`✓ ${name} 已存在，略過下載。`);
      continue;
    }
    console.log(`下載語音模型 ${name}（約 60MB）…`);
    await download(`${HF_BASE}/${subpath}/${name}.onnx.json`, configPath);
    await download(`${HF_BASE}/${subpath}/${name}.onnx`, modelPath);
    console.log(`✓ ${name} 下載完成。`);
  }

  console.log("\n完成！記得也要安裝 Python 依賴：pip install -r requirements.txt");
}

main().catch((err) => {
  console.error("安裝失敗：", err.message);
  process.exit(1);
});
