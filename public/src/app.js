const PHOTO_STORAGE_KEY = "speaking-video-last-photo";
const TEXT_MAX_LENGTH = 1500;
const POLL_INTERVAL_MS = 2000;

const photoDrop = document.getElementById("photoDrop");
const photoInput = document.getElementById("photoInput");
const photoPreview = document.getElementById("photoPreview");
const photoPlaceholder = document.getElementById("photoPlaceholder");

const fileInput = document.getElementById("fileInput");
const textInput = document.getElementById("textInput");
const charCount = document.getElementById("charCount");

const generateForm = document.getElementById("generateForm");
const generateBtn = document.getElementById("generateBtn");
const hint = document.getElementById("hint");

const progressPanel = document.getElementById("progressPanel");
const progressStatus = document.getElementById("progressStatus");

const resultPanel = document.getElementById("resultPanel");
const resultVideo = document.getElementById("resultVideo");
const downloadLink = document.getElementById("downloadLink");
const resetBtn = document.getElementById("resetBtn");

let photoDataUrl = null;

function setPhoto(dataUrl) {
  photoDataUrl = dataUrl;
  photoPreview.src = dataUrl;
  photoPreview.hidden = false;
  photoPlaceholder.hidden = true;
  try {
    localStorage.setItem(PHOTO_STORAGE_KEY, dataUrl);
  } catch {
    // private mode / storage full — not essential, skip silently
  }
}

(function restoreLastPhoto() {
  try {
    const saved = localStorage.getItem(PHOTO_STORAGE_KEY);
    if (saved) setPhoto(saved);
  } catch {
    // ignore
  }
})();

photoDrop.addEventListener("click", () => photoInput.click());
photoInput.addEventListener("change", () => {
  const file = photoInput.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => setPhoto(reader.result);
  reader.readAsDataURL(file);
});

fileInput.addEventListener("change", () => {
  const file = fileInput.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    textInput.value = String(reader.result).slice(0, TEXT_MAX_LENGTH);
    updateCharCount();
  };
  reader.readAsText(file);
});

function updateCharCount() {
  charCount.textContent = `${textInput.value.length} / ${TEXT_MAX_LENGTH}`;
}
textInput.addEventListener("input", updateCharCount);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function setBusy(busy) {
  generateBtn.disabled = busy;
  progressPanel.hidden = !busy;
  generateForm.hidden = busy;
}

async function pollJob(jobId) {
  while (true) {
    await sleep(POLL_INTERVAL_MS);
    const res = await fetch(`/api/video/status/${jobId}`);
    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.error || "查詢工作狀態失敗");
    }
    if (data.message) progressStatus.textContent = data.message;
    if (data.status === "done") return data.videoUrl;
    if (data.status === "error") throw new Error(data.error || "影片生成失敗");
  }
}

generateForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  hint.textContent = "";

  if (!photoDataUrl) {
    hint.textContent = "請先上傳照片。";
    return;
  }
  const text = textInput.value.trim();
  if (!text) {
    hint.textContent = "請輸入要講出來的文件內容。";
    return;
  }

  setBusy(true);
  progressStatus.textContent = "AI教師啟動中…";

  try {
    const res = await fetch("/api/video/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ photo: photoDataUrl, text }),
    });
    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.error || "無法開始產生影片");
    }

    const videoUrl = await pollJob(data.jobId);
    resultVideo.src = videoUrl;
    downloadLink.href = videoUrl;
    resultPanel.hidden = false;
  } catch (err) {
    console.error(err);
    setBusy(false);
    hint.textContent = err.message || "發生錯誤，請重試。";
  }
});

resetBtn.addEventListener("click", () => {
  resultPanel.hidden = true;
  resultVideo.pause();
  resultVideo.removeAttribute("src");
  resultVideo.load();
  textInput.value = "";
  updateCharCount();
  setBusy(false);
});
