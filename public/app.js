import {
  FaceLandmarker,
  FilesetResolver,
} from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs";

const WASM_BASE = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm";
const MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task";

// MediaPipe Face Mesh lip contour indices.
const LIP_IDX = {
  upperOuter: [61, 185, 40, 39, 37, 0, 267, 269, 270, 409, 291],
  lowerOuter: [61, 146, 91, 181, 84, 17, 314, 405, 321, 375, 291],
  upperInner: [78, 191, 80, 81, 82, 13, 312, 311, 310, 415, 308],
  lowerInner: [78, 95, 88, 178, 87, 14, 317, 402, 318, 324, 308],
};

const MAX_DIMENSION = 1000;
const OPEN_SENSITIVITY = 5.5;
const SMOOTH_UP = 0.45;
const SMOOTH_DOWN = 0.25;

const photoInput = document.getElementById("photoInput");
const uploadPlaceholder = document.getElementById("uploadPlaceholder");
const detectOverlay = document.getElementById("detectOverlay");
const detectStatus = document.getElementById("detectStatus");
const changePhotoBtn = document.getElementById("changePhotoBtn");
const photoError = document.getElementById("photoError");
const canvas = document.getElementById("canvas");
const ctx = canvas.getContext("2d");
const statusBadge = document.getElementById("statusBadge");
const statusText = document.getElementById("statusText");

const textInput = document.getElementById("textInput");
const voiceSelect = document.getElementById("voiceSelect");
const rateRange = document.getElementById("rateRange");
const volumeRange = document.getElementById("volumeRange");
const rateVal = document.getElementById("rateVal");
const volumeVal = document.getElementById("volumeVal");
const speakBtn = document.getElementById("speakBtn");
const stopBtn = document.getElementById("stopBtn");
const hint = document.getElementById("hint");
const audioEl = document.getElementById("ttsAudio");

let faceLandmarker = null;
let faceLandmarkerReady = null;

let baseCanvas = null; // offscreen resized source image
let lipPx = null; // pixel-space lip points {upperOuter, lowerOuter, upperInner, lowerInner}
let maxOpenPx = 0;
let lipFillColor = "#a1524f";

let audioCtx = null;
let analyser = null;
let timeDomainData = null;
let mediaSourceConnected = false;

let openness = 0;
let rafId = null;
let photoReady = false;

// ---------- Face model bootstrap ----------
function loadFaceLandmarker() {
  if (!faceLandmarkerReady) {
    faceLandmarkerReady = FilesetResolver.forVisionTasks(WASM_BASE).then((vision) =>
      FaceLandmarker.createFromOptions(vision, {
        baseOptions: { modelAssetPath: MODEL_URL },
        runningMode: "IMAGE",
        numFaces: 1,
      })
    ).then((landmarker) => {
      faceLandmarker = landmarker;
      return landmarker;
    });
  }
  return faceLandmarkerReady;
}

// ---------- Photo upload + face detection ----------
photoInput.addEventListener("change", (e) => {
  const file = e.target.files && e.target.files[0];
  if (file) handlePhotoUpload(file);
});

changePhotoBtn.addEventListener("click", () => {
  photoInput.value = "";
  photoInput.click();
});

async function handlePhotoUpload(file) {
  photoError.textContent = "";
  uploadPlaceholder.hidden = true;
  detectOverlay.hidden = false;
  detectStatus.textContent = "載入臉部偵測模型中…";
  canvas.hidden = true;
  photoReady = false;
  speakBtn.disabled = true;

  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, MAX_DIMENSION / Math.max(bitmap.width, bitmap.height));
    const w = Math.round(bitmap.width * scale);
    const h = Math.round(bitmap.height * scale);

    baseCanvas = document.createElement("canvas");
    baseCanvas.width = w;
    baseCanvas.height = h;
    const bctx = baseCanvas.getContext("2d");
    bctx.drawImage(bitmap, 0, 0, w, h);
    bitmap.close && bitmap.close();

    detectStatus.textContent = "偵測臉部特徵點中…";
    const landmarker = await loadFaceLandmarker();
    const result = landmarker.detect(baseCanvas);

    if (!result.faceLandmarks || result.faceLandmarks.length === 0) {
      throw new Error("NO_FACE");
    }

    const landmarks = result.faceLandmarks[0];
    lipPx = extractLipPoints(landmarks, w, h);

    const corner1 = lipPx.upperOuter[0];
    const corner2 = lipPx.upperOuter[lipPx.upperOuter.length - 1];
    const mouthWidthPx = Math.hypot(corner2.x - corner1.x, corner2.y - corner1.y);
    maxOpenPx = mouthWidthPx * 0.42;

    lipFillColor = sampleLipColor(bctx, lipPx.lowerOuter);

    canvas.width = w;
    canvas.height = h;
    canvas.hidden = false;
    detectOverlay.hidden = true;
    changePhotoBtn.hidden = false;

    photoReady = true;
    speakBtn.disabled = false;
    hint.textContent = "照片準備好了，輸入文字後按「開始說話」。";
    statusBadge.hidden = false;
    drawFrame(0);
  } catch (err) {
    detectOverlay.hidden = true;
    uploadPlaceholder.hidden = false;
    if (err && err.message === "NO_FACE") {
      photoError.textContent = "偵測不到清楚的正臉，請換一張光線充足、臉部完整的照片。";
    } else {
      photoError.textContent = "照片處理失敗，請重試或更換照片。";
      console.error(err);
    }
  }
}

function extractLipPoints(landmarks, w, h) {
  const toPx = (idxArr) => idxArr.map((i) => ({ x: landmarks[i].x * w, y: landmarks[i].y * h }));
  return {
    upperOuter: toPx(LIP_IDX.upperOuter),
    lowerOuter: toPx(LIP_IDX.lowerOuter),
    upperInner: toPx(LIP_IDX.upperInner),
    lowerInner: toPx(LIP_IDX.lowerInner),
  };
}

function sampleLipColor(sourceCtx, lowerOuterPts) {
  const mid = lowerOuterPts[Math.floor(lowerOuterPts.length / 2)];
  const size = 4;
  const x = Math.max(0, Math.round(mid.x - size / 2));
  const y = Math.max(0, Math.round(mid.y - size / 2));
  try {
    const data = sourceCtx.getImageData(x, y, size, size).data;
    let r = 0, g = 0, b = 0, n = 0;
    for (let i = 0; i < data.length; i += 4) {
      r += data[i];
      g += data[i + 1];
      b += data[i + 2];
      n++;
    }
    r = Math.round(r / n);
    g = Math.round(g / n);
    b = Math.round(b / n);
    return `rgb(${r}, ${g}, ${b})`;
  } catch {
    return "#a1524f";
  }
}

// ---------- Canvas rendering ----------
function pathFromPoints(points) {
  const p = new Path2D();
  p.moveTo(points[0].x, points[0].y);
  for (let i = 1; i < points.length; i++) p.lineTo(points[i].x, points[i].y);
  p.closePath();
  return p;
}

function ringPath(topPts, bottomPts) {
  const pts = [...topPts, ...[...bottomPts].reverse()];
  return pathFromPoints(pts);
}

function drawFrame(t) {
  if (!baseCanvas) return;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(baseCanvas, 0, 0);

  if (!lipPx || t <= 0.02) return;

  const lowerOuterDisp = lipPx.lowerOuter.map((p) => ({ x: p.x, y: p.y + t * maxOpenPx }));
  const lowerInnerDisp = lipPx.lowerInner.map((p) => ({ x: p.x, y: p.y + t * maxOpenPx * 0.85 }));
  const upperInnerAdj = lipPx.upperInner.map((p) => ({ x: p.x, y: p.y - t * maxOpenPx * 0.1 }));

  // Outer lip ring (redrawn lips, stretched down).
  ctx.fillStyle = lipFillColor;
  ctx.fill(ringPath(lipPx.upperOuter, lowerOuterDisp));

  // Inner mouth cavity.
  ctx.fillStyle = "#3a1418";
  ctx.fill(ringPath(upperInnerAdj, lowerInnerDisp));

  // A hint of teeth near the top of the cavity once the mouth opens enough.
  if (t > 0.3) {
    const teethLower = upperInnerAdj.map((p) => ({
      x: p.x,
      y: p.y + Math.min(7, t * maxOpenPx * 0.28),
    }));
    ctx.fillStyle = "rgba(247, 241, 230, 0.92)";
    ctx.fill(ringPath(upperInnerAdj, teethLower));
  }
}

// ---------- Audio graph ----------
function ensureAudioGraph() {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 512;
    timeDomainData = new Uint8Array(analyser.frequencyBinCount);
  }
  if (!mediaSourceConnected) {
    const source = audioCtx.createMediaElementSource(audioEl);
    source.connect(analyser);
    analyser.connect(audioCtx.destination);
    mediaSourceConnected = true;
  }
  if (audioCtx.state === "suspended") audioCtx.resume();
}

function currentVolume() {
  analyser.getByteTimeDomainData(timeDomainData);
  let sumSquares = 0;
  for (let i = 0; i < timeDomainData.length; i++) {
    const v = (timeDomainData[i] - 128) / 128;
    sumSquares += v * v;
  }
  return Math.sqrt(sumSquares / timeDomainData.length);
}

function mouthLoop() {
  const target = Math.min(1, currentVolume() * OPEN_SENSITIVITY);
  const smooth = target > openness ? SMOOTH_UP : SMOOTH_DOWN;
  openness += (target - openness) * smooth;
  drawFrame(openness);
  rafId = requestAnimationFrame(mouthLoop);
}

function startMouthLoop() {
  cancelAnimationFrame(rafId);
  mouthLoop();
}

function stopMouthLoop() {
  cancelAnimationFrame(rafId);
  rafId = null;
  openness = 0;
  drawFrame(0);
}

// ---------- Speaking controls ----------
function setSpeakingUI(isSpeaking) {
  statusBadge.classList.toggle("speaking", isSpeaking);
  statusText.textContent = isSpeaking ? "說話中…" : "待機中";
  speakBtn.disabled = isSpeaking || !photoReady;
  stopBtn.disabled = !isSpeaking;
}

function buildTtsUrl() {
  const params = new URLSearchParams({
    text: textInput.value.trim(),
    voice: voiceSelect.value || "",
    rate: rateRange.value,
  });
  return `/api/tts?${params.toString()}`;
}

function speak() {
  const text = textInput.value.trim();
  if (!photoReady) {
    hint.textContent = "請先上傳照片。";
    return;
  }
  if (!text) {
    hint.textContent = "請先輸入要說的文字。";
    return;
  }
  hint.textContent = "";
  ensureAudioGraph();

  audioEl.pause();
  audioEl.src = buildTtsUrl();
  audioEl.volume = Number(volumeRange.value);
  audioEl.play().catch((err) => {
    console.error(err);
    hint.textContent = "播放失敗，請確認伺服器已執行 npm run setup:piper 安裝 Piper 與語音模型。";
    setSpeakingUI(false);
  });
}

function stopSpeaking() {
  audioEl.pause();
  audioEl.currentTime = 0;
}

audioEl.addEventListener("play", () => {
  setSpeakingUI(true);
  startMouthLoop();
});

audioEl.addEventListener("pause", () => {
  setSpeakingUI(false);
  stopMouthLoop();
});

audioEl.addEventListener("ended", () => {
  setSpeakingUI(false);
  stopMouthLoop();
});

audioEl.addEventListener("error", () => {
  if (audioEl.src) {
    hint.textContent = "語音播放失敗，請確認伺服器已執行 npm run setup:piper 安裝 Piper 與語音模型。";
  }
  setSpeakingUI(false);
  stopMouthLoop();
});

speakBtn.addEventListener("click", speak);
stopBtn.addEventListener("click", stopSpeaking);

textInput.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === "Enter") speak();
});

rateRange.addEventListener("input", () => (rateVal.textContent = Number(rateRange.value).toFixed(1)));
volumeRange.addEventListener("input", () => {
  volumeVal.textContent = Number(volumeRange.value).toFixed(1);
  audioEl.volume = Number(volumeRange.value);
});

// ---------- Voice list ----------
async function loadVoices() {
  try {
    const res = await fetch("/api/voices");
    if (!res.ok) throw new Error("failed");
    const voices = await res.json();
    const zh = voices.filter((v) => v.locale.startsWith("zh"));
    const rest = voices.filter((v) => !v.locale.startsWith("zh"));
    const ordered = [...zh, ...rest];

    voiceSelect.innerHTML = "";
    ordered.forEach((v) => {
      const opt = document.createElement("option");
      opt.value = v.shortName;
      opt.textContent = `${v.displayName} (${v.locale})`;
      voiceSelect.appendChild(opt);
    });

    const preferred = ordered.findIndex((v) => v.shortName === "zh_CN-huayan-medium");
    if (preferred >= 0) voiceSelect.selectedIndex = preferred;
  } catch {
    voiceSelect.innerHTML = "<option value=\"\">尚未安裝語音模型</option>";
    hint.textContent = "無法取得語音清單，請先在伺服器執行 npm run setup:piper 安裝 Piper 與語音模型。";
  }
}

loadVoices();
loadFaceLandmarker().catch((err) => console.error("預先載入臉部模型失敗", err));
