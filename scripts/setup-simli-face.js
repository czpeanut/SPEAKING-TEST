#!/usr/bin/env node
// One-time avatar creation: takes a photo, asks Simli to reframe it, then
// registers it as a Trinity face. Run this once per photo — the resulting
// faceId is what the running app uses for every visitor from then on.
//
// Usage: node scripts/setup-simli-face.js path/to/photo.jpg
require("dotenv").config();
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const ENV_PATH = path.join(ROOT, ".env");
const PREVIEW_PATH = path.join(ROOT, "vendor", "simli-face-preview.png");

async function main() {
  const photoPath = process.argv[2];
  if (!photoPath) {
    console.error("用法: node scripts/setup-simli-face.js <你的照片路徑>");
    process.exit(1);
  }
  if (!fs.existsSync(photoPath)) {
    console.error(`找不到檔案: ${photoPath}`);
    process.exit(1);
  }

  const apiKey = process.env.SIMLI_API_KEY;
  if (!apiKey) {
    console.error("請先在 .env 設定 SIMLI_API_KEY（參考 .env.example）。");
    process.exit(1);
  }

  const photoBytes = fs.readFileSync(photoPath);
  const photoName = path.basename(photoPath);

  console.log("步驟 1/2：重新裁切/對齊照片（Trinity 需要頭部置中的正臉照）…");
  const preprocessForm = new FormData();
  preprocessForm.append("image", new Blob([photoBytes]), photoName);

  const preprocessRes = await fetch("https://api.simli.ai/faces/trinity/preprocess", {
    method: "POST",
    headers: { "x-simli-api-key": apiKey },
    body: preprocessForm,
  });

  if (!preprocessRes.ok) {
    const detail = await preprocessRes.text().catch(() => "");
    console.error(`預處理失敗 (${preprocessRes.status})：${detail}`);
    console.error("常見原因：照片太小（需至少 512x512）、看不清楚正臉、或頭部占畫面高度不到 15%。");
    process.exit(1);
  }

  const preprocessedBytes = Buffer.from(await preprocessRes.arrayBuffer());
  fs.mkdirSync(path.dirname(PREVIEW_PATH), { recursive: true });
  fs.writeFileSync(PREVIEW_PATH, preprocessedBytes);
  console.log(`✓ 已存到 ${PREVIEW_PATH}，可以打開看看裁切結果是否OK。`);

  console.log("步驟 2/2：建立 Trinity avatar（需要一點時間）…");
  const faceName = process.argv[3] || "default";
  const genForm = new FormData();
  genForm.append("image", new Blob([preprocessedBytes]), "preprocessed.png");

  const genRes = await fetch(
    `https://api.simli.ai/faces/trinity?face_name=${encodeURIComponent(faceName)}`,
    {
      method: "POST",
      headers: { "x-simli-api-key": apiKey },
      body: genForm,
    }
  );

  if (!genRes.ok) {
    const detail = await genRes.text().catch(() => "");
    console.error(`建立 avatar 失敗 (${genRes.status})：${detail}`);
    process.exit(1);
  }

  const result = await genRes.json();
  console.log("\n完整回應：");
  console.log(JSON.stringify(result, null, 2));

  const faceId =
    result.faceId || result.face_id || result.id || result.faceUUID || result.uuid || null;

  if (!faceId) {
    console.warn(
      "\n⚠️ 沒能自動辨識出 face id 欄位，請從上面的回應裡自己找出來，" +
        "然後手動把它加進 .env：SIMLI_FACE_ID=<你找到的值>"
    );
    return;
  }

  console.log(`\n✓ face id: ${faceId}`);
  updateEnvFile("SIMLI_FACE_ID", faceId);
  console.log(`✓ 已寫入 ${ENV_PATH}`);
  console.log("\n完成！執行 npm start 就會用這個 avatar。");
}

function updateEnvFile(key, value) {
  let content = fs.existsSync(ENV_PATH) ? fs.readFileSync(ENV_PATH, "utf8") : "";
  const line = `${key}=${value}`;
  const re = new RegExp(`^${key}=.*$`, "m");
  if (re.test(content)) {
    content = content.replace(re, line);
  } else {
    content = content.replace(/\n?$/, "\n") + line + "\n";
  }
  fs.writeFileSync(ENV_PATH, content);
}

main().catch((err) => {
  console.error("發生錯誤：", err);
  process.exit(1);
});
