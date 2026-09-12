#!/usr/bin/env node
// Downloads the Piper TTS native binary + a default Chinese voice model.
// No account or API key needed — this just fetches public release/model files.
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const VENDOR_DIR = path.join(ROOT, "vendor");
const PIPER_DIR = path.join(VENDOR_DIR, "piper");
const VOICES_DIR = path.join(ROOT, "voices");
const PIPER_RELEASE = "https://github.com/rhasspy/piper/releases/download/2023.11.14-2";
const VOICE_BASE = "https://huggingface.co/rhasspy/piper-voices/resolve/main/zh/zh_CN/huayan/medium";
const DEFAULT_VOICE = "zh_CN-huayan-medium";

function pickAsset() {
  const platform = process.platform;
  const arch = process.arch;
  if (platform === "linux") {
    if (arch === "x64") return { asset: "piper_linux_x86_64.tar.gz", kind: "tar" };
    if (arch === "arm64") return { asset: "piper_linux_aarch64.tar.gz", kind: "tar" };
    if (arch === "arm") return { asset: "piper_linux_armv7l.tar.gz", kind: "tar" };
  } else if (platform === "darwin") {
    if (arch === "x64") return { asset: "piper_macos_x64.tar.gz", kind: "tar" };
    if (arch === "arm64") return { asset: "piper_macos_aarch64.tar.gz", kind: "tar" };
  } else if (platform === "win32") {
    return { asset: "piper_windows_amd64.zip", kind: "zip" };
  }
  throw new Error(`不支援的平台/架構: ${platform}/${arch}，請至 https://github.com/rhasspy/piper/releases 手動下載並解壓到 vendor/piper/`);
}

async function download(url, destPath) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`下載失敗 (${res.status}): ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(destPath, buf);
}

async function setupPiperBinary() {
  if (fs.existsSync(path.join(PIPER_DIR, process.platform === "win32" ? "piper.exe" : "piper"))) {
    console.log("✓ Piper 執行檔已存在，略過下載。");
    return;
  }
  fs.mkdirSync(VENDOR_DIR, { recursive: true });
  const { asset, kind } = pickAsset();
  const archivePath = path.join(VENDOR_DIR, asset);
  console.log(`下載 Piper 執行檔 (${asset})…`);
  await download(`${PIPER_RELEASE}/${asset}`, archivePath);

  console.log("解壓縮中…");
  if (kind === "tar") {
    execFileSync("tar", ["-xzf", archivePath, "-C", VENDOR_DIR], { stdio: "inherit" });
  } else {
    // Windows ships a bsdtar-based `tar.exe` (since Win10 1803+) that also handles zip.
    execFileSync("tar", ["-xf", archivePath, "-C", VENDOR_DIR], { stdio: "inherit" });
  }
  fs.unlinkSync(archivePath);
  console.log("✓ Piper 執行檔安裝完成。");
}

async function setupDefaultVoice() {
  fs.mkdirSync(VOICES_DIR, { recursive: true });
  const modelPath = path.join(VOICES_DIR, `${DEFAULT_VOICE}.onnx`);
  const configPath = path.join(VOICES_DIR, `${DEFAULT_VOICE}.onnx.json`);
  if (fs.existsSync(modelPath) && fs.existsSync(configPath)) {
    console.log("✓ 預設語音模型已存在，略過下載。");
    return;
  }
  console.log(`下載預設中文語音模型 (${DEFAULT_VOICE})，約 60MB…`);
  await download(`${VOICE_BASE}/${DEFAULT_VOICE}.onnx.json`, configPath);
  await download(`${VOICE_BASE}/${DEFAULT_VOICE}.onnx`, modelPath);
  console.log("✓ 語音模型安裝完成。");
}

(async () => {
  try {
    await setupPiperBinary();
    await setupDefaultVoice();
    console.log("\n完成！可以執行 npm start 啟動伺服器了。");
    console.log("想加入更多語音，可從 https://huggingface.co/rhasspy/piper-voices 下載");
    console.log(`其他 .onnx + .onnx.json 檔案並放進 ${VOICES_DIR}`);
  } catch (err) {
    console.error("安裝失敗：", err.message);
    process.exit(1);
  }
})();
