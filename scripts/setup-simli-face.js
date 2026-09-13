#!/usr/bin/env node
// One-time avatar creation: takes a photo, sends it to Simli's Legacy face
// pipeline, and polls until the resulting faceId is ready. The running app
// then uses that one faceId for every visitor from then on.
//
// Why "Legacy" and not "Trinity": Trinity (Simli's newer Gaussian-splat
// avatar) is gated behind a paid plan — free-tier API calls to
// /faces/trinity return 403 "max number of GS Faces for your current
// subscription" even with zero faces created. The Legacy pipeline
// (/faces/legacy) works on the free tier; it's marked deprecated in Simli's
// OpenAPI spec but is, as of this writing, the only free-tier path to a
// custom photo avatar via the API.
//
// Usage: node scripts/setup-simli-face.js path/to/photo.jpg
require("dotenv").config();
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const ENV_PATH = path.join(ROOT, ".env");
const POLL_INTERVAL_MS = 15000;
const POLL_TIMEOUT_MS = 10 * 60 * 1000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const photoPath = process.argv[2];
  if (!photoPath) {
    console.error("用法: node scripts/setup-simli-face.js <你的照片路徑（jpg 或 png）>");
    process.exit(1);
  }
  if (!fs.existsSync(photoPath)) {
    console.error(`找不到檔案: ${photoPath}`);
    process.exit(1);
  }
  const ext = path.extname(photoPath).toLowerCase();
  if (![".jpg", ".jpeg", ".png"].includes(ext)) {
    console.error("Simli 的 Legacy 頭像端點只接受 JPEG 或 PNG，請先轉檔（webp/heic 都需要先轉換）。");
    process.exit(1);
  }

  const apiKey = process.env.SIMLI_API_KEY;
  if (!apiKey) {
    console.error("請先在 .env 設定 SIMLI_API_KEY（參考 .env.example）。");
    process.exit(1);
  }

  const photoBytes = fs.readFileSync(photoPath);
  const faceName = process.argv[3] || "default";

  console.log("提交照片給 Simli（免費方案走 Legacy 頭像流程）…");
  const form = new FormData();
  form.append("image", new Blob([photoBytes]), path.basename(photoPath));

  const submitRes = await fetch(`https://api.simli.ai/faces/legacy?face_name=${encodeURIComponent(faceName)}`, {
    method: "POST",
    headers: { "x-simli-api-key": apiKey },
    body: form,
  });

  const submitData = await submitRes.json().catch(() => ({}));
  if (!submitRes.ok) {
    console.error(`提交失敗 (${submitRes.status})：${JSON.stringify(submitData)}`);
    if (submitRes.status === 403) {
      console.error("如果訊息提到 GS Faces／訂閱額度，代表你的方案不支援這個功能，請至 app.simli.com 檢查方案內容。");
    }
    process.exit(1);
  }

  const faceId = submitData.character_uid || submitData.face_id;
  if (!faceId) {
    console.error("沒能從回應中取得 face id：", JSON.stringify(submitData));
    process.exit(1);
  }
  if (submitData.warnings && submitData.warnings.length) {
    console.log("提示：", submitData.warnings.join("；"));
  }

  console.log(`已加入處理佇列（face id: ${faceId}），開始等待完成（通常需要幾分鐘）…`);

  const deadline = Date.now() + POLL_TIMEOUT_MS;
  let lastStatus = null;
  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);
    const statusRes = await fetch(
      `https://api.simli.ai/faces/legacy/generation_status?face_id=${encodeURIComponent(faceId)}`,
      { headers: { "x-simli-api-key": apiKey } }
    );
    const statusData = await statusRes.json().catch(() => ({}));
    lastStatus = statusData.status;
    console.log(`  狀態：${lastStatus || JSON.stringify(statusData)}`);

    if (lastStatus && lastStatus !== "processing" && lastStatus !== "queued") {
      break;
    }
  }

  if (lastStatus !== "completed" && lastStatus !== "done" && lastStatus !== "ready") {
    console.warn(`\n⚠️ 結束等待時狀態是「${lastStatus}」，不確定是否已經可用。`);
    console.warn(`可以晚點手動檢查： curl "https://api.simli.ai/faces/legacy/generation_status?face_id=${faceId}" -H "x-simli-api-key: 你的key"`);
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
