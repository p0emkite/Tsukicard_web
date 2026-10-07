const $ = (id) => document.getElementById(id);
const ORDER = ["오팔", "코랄", "골드", "실버", "TB", "올스타", "설날"];
const STORAGE_KEY = "tsuki-card-web-defaults-v1";
const EXCEL_PROGRESS_STORAGE_KEY = "tsuki-card-web-excel-progress-v1";
const SAVE_FOLDER_DB_NAME = "tsuki-card-web-storage";
const SAVE_FOLDER_STORE = "handles";
const SAVE_FOLDER_KEY = "png-save-folder";
const FONT_PATHS = [
  "assets/fonts/VITRO_INSPIRE.otf",
  "assets/fonts/Freesentation-8ExtraBold.ttf",
];
const runtimeBadge = $("runtimeBadge");
const statusBox = $("status");
const batchStatus = $("batchStatus");
const worker = new Worker(new URL("./py-worker.js", import.meta.url), { type: "module" });
let workerSeq = 1;
const workerPending = new Map();
let templates = new Map();
let staticDefaults = null;
let currentOriginalFile = null;
let currentWorkingBlob = null;
let currentPreviewUrl = null;
let renderTimer = null;
let renderInFlight = false;
let renderAgain = false;
let runtimeReady = false;
let dragState = null;
let batchRows = [];
let batchImageFiles = [];
let cutoutModule = null;
const EXCEL_REQUIRED_COLUMNS = ["시즌", "등급", "구단", "이름", "포지션", "저장파일명"];
const EXCEL_DATA_COLUMNS = ["시즌", "등급", "구단", "이름", "포지션", "이미지명", "저장파일명"];
let loadedExcelRows = [];
let excelDataSortColumn = null;
let excelDataSortDesc = false;
let selectedExcelDataId = null;
let excelDataFilters = Object.fromEntries(EXCEL_DATA_COLUMNS.map(col => [col, ""]));
let saveDirectoryHandle = null;
let excelDataImageFiles = [];
let excelRowPreviewSeq = 0;

// Browser-side realtime preview state
const liveAssetCache = new Map();
let liveSubjectCanvas = null;
let livePreviewRaf = 0;
let finalPreviewTimer = null;
let liveFontsReady = null;
let liveInteractionActive = false;
let liveSubjectMeta = null;
let currentSubjectAnalysis = null;
const AUTO_FACE_TARGET = { x: 0.50, y: 0.31, width: 0.245 };

const CUTOUT_CONFIG = {
  model: "isnet",
  output: { format: "image/png", quality: 1 },
};

function webGpuAvailable() {
  return typeof navigator !== "undefined" && !!navigator.gpu;
}

worker.onmessage = (event) => {
  const { id, ok, data, error } = event.data || {};
  const pending = workerPending.get(id);
  if (!pending) return;
  workerPending.delete(id);
  ok ? pending.resolve(data) : pending.reject(new Error(error || "Worker error"));
};
worker.onerror = (event) => {
  runtimeBadge.textContent = "Python 오류";
  runtimeBadge.className = "badge error";
  setStatus(`Python 실행 오류: ${event.message}`, true);
};

function callWorker(type, payload = {}, transfer = []) {
  return new Promise((resolve, reject) => {
    const id = workerSeq++;
    workerPending.set(id, { resolve, reject });
    worker.postMessage({ id, type, payload }, transfer);
  });
}

function setStatus(message, isError = false, ok = false) {
  statusBox.textContent = message;
  statusBox.className = `status${isError ? " error" : ok ? " ok" : ""}`;
}
function setBatchStatus(message, isError = false, ok = false) {
  batchStatus.textContent = message;
  batchStatus.className = `status compact-status${isError ? " error" : ok ? " ok" : ""}`;
}

function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }
function sanitizeFilename(name, fallback = "card.png") {
  let out = (name || "").trim() || fallback;
  out = out.replace(/[<>:"/\\|?*\x00-\x1F]/g, "_").replace(/[ .]+$/g, "");
  if (!out.toLowerCase().endsWith(".png")) out += ".png";
  return out || fallback;
}
function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>'"]/g, ch => ({"&":"&amp;","<":"&lt;",">":"&gt;","'":"&#39;",'"':"&quot;"}[ch]));
}
function base64ToBlob(base64, type = "image/png") {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type });
}
function base64ToUint8(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}



function openSaveFolderDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(SAVE_FOLDER_DB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(SAVE_FOLDER_STORE)) {
        db.createObjectStore(SAVE_FOLDER_STORE);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function storeSaveDirectoryHandle(handle) {
  const db = await openSaveFolderDb();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(SAVE_FOLDER_STORE, "readwrite");
    tx.objectStore(SAVE_FOLDER_STORE).put(handle, SAVE_FOLDER_KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
  db.close();
}

async function loadSaveDirectoryHandle() {
  try {
    const db = await openSaveFolderDb();
    const handle = await new Promise((resolve, reject) => {
      const tx = db.transaction(SAVE_FOLDER_STORE, "readonly");
      const req = tx.objectStore(SAVE_FOLDER_STORE).get(SAVE_FOLDER_KEY);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
    db.close();
    return handle;
  } catch (error) {
    console.warn("저장 폴더 불러오기 실패:", error);
    return null;
  }
}

function updateSavePathStatus() {
  const el = $("savePathStatus");
  if (!el) return;
  if (saveDirectoryHandle) {
    el.textContent = `저장 위치: ${saveDirectoryHandle.name}`;
  } else {
    el.textContent = "저장 위치: 브라우저 기본 다운로드 폴더";
  }
}

async function ensureDirectoryPermission(handle, ask = true) {
  if (!handle) return false;
  const opts = { mode: "readwrite" };
  if ((await handle.queryPermission?.(opts)) === "granted") return true;
  if (ask && (await handle.requestPermission?.(opts)) === "granted") return true;
  return false;
}

async function chooseSaveDirectory() {
  if (!("showDirectoryPicker" in window)) {
    setStatus("이 브라우저는 저장 경로 지정 기능을 지원하지 않습니다. 기본 다운로드 폴더를 사용합니다.", true);
    return;
  }
  try {
    const handle = await window.showDirectoryPicker({ mode: "readwrite" });
    const allowed = await ensureDirectoryPermission(handle, true);
    if (!allowed) throw new Error("선택한 폴더의 쓰기 권한을 허용하지 않았습니다.");
    saveDirectoryHandle = handle;
    await storeSaveDirectoryHandle(handle);
    updateSavePathStatus();
    setStatus(`저장 위치를 '${handle.name}' 폴더로 설정했습니다.`, false, true);
  } catch (error) {
    if (error?.name === "AbortError") return;
    setStatus(`저장 경로 설정 실패: ${error.message}`, true);
  }
}

async function saveBlobToChosenLocation(blob, filename) {
  const safeName = sanitizeFilename(filename);

  if (saveDirectoryHandle) {
    try {
      const allowed = await ensureDirectoryPermission(saveDirectoryHandle, true);
      if (allowed) {
        const fileHandle = await saveDirectoryHandle.getFileHandle(safeName, { create: true });
        const writable = await fileHandle.createWritable();
        await writable.write(blob);
        await writable.close();
        return { mode: "folder", name: saveDirectoryHandle.name };
      }
    } catch (error) {
      console.warn("지정 폴더 저장 실패, 기본 다운로드로 폴백:", error);
    }
  }

  downloadBlob(blob, safeName);
  return { mode: "download" };
}

async function registerModelCacheWorker() {
  if (!("serviceWorker" in navigator)) return;
  try {
    await navigator.serviceWorker.register("./service-worker.js", { scope: "./" });
    await navigator.serviceWorker.ready;
  } catch (error) {
    console.warn("모델 캐시 서비스 워커 등록 실패:", error);
  }
}

async function ensureLiveFonts() {
  if (liveFontsReady) return liveFontsReady;
  liveFontsReady = (async () => {
    try {
      const vitro = new FontFace("TsukiVITRO", "url('./assets/fonts/VITRO_INSPIRE.otf')");
      const free = new FontFace("TsukiFreesentation", "url('./assets/fonts/Freesentation-8ExtraBold.ttf')");
      const loaded = await Promise.all([vitro.load(), free.load()]);
      loaded.forEach(font => document.fonts.add(font));
    } catch (error) {
      console.warn("실시간 미리보기 폰트 로드 실패:", error);
    }
  })();
  return liveFontsReady;
}

function loadLiveImage(path) {
  if (!path) return Promise.resolve(null);
  if (liveAssetCache.has(path)) return liveAssetCache.get(path);
  const promise = new Promise((resolve, reject) => {
    const img = new Image();
    img.decoding = "async";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`미리보기 자산 로드 실패: ${path}`));
    img.src = new URL(path, location.href).href;
  });
  liveAssetCache.set(path, promise);
  return promise;
}

async function prepareLiveSubject(blob) {
  if (!blob) {
    liveSubjectCanvas = null;
    liveSubjectMeta = null;
    currentSubjectAnalysis = null;
    updateSubjectQualityUi();
    return;
  }
  const bitmap = await createImageBitmap(blob);
  const temp = document.createElement("canvas");
  temp.width = bitmap.width;
  temp.height = bitmap.height;
  const tctx = temp.getContext("2d", { willReadFrequently: true });
  tctx.drawImage(bitmap, 0, 0);

  let sx = 0, sy = 0, sw = temp.width, sh = temp.height;
  let foregroundCount = 0, semiTransparentCount = 0, transparentCount = 0;
  let minX = temp.width, minY = temp.height, maxX = -1, maxY = -1;
  try {
    const pixels = tctx.getImageData(0, 0, temp.width, temp.height).data;
    for (let y = 0; y < temp.height; y++) {
      for (let x = 0; x < temp.width; x++) {
        const alpha = pixels[(y * temp.width + x) * 4 + 3];
        if (alpha < 250) transparentCount++;
        if (alpha > 12) {
          foregroundCount++;
          if (alpha < 245) semiTransparentCount++;
          if (x < minX) minX = x;
          if (y < minY) minY = y;
          if (x > maxX) maxX = x;
          if (y > maxY) maxY = y;
        }
      }
    }
    if (maxX >= minX && maxY >= minY) {
      sx = minX; sy = minY; sw = maxX - minX + 1; sh = maxY - minY + 1;
    }
  } catch (_) {}

  const totalPixels = Math.max(1, temp.width * temp.height);
  const bboxPixels = Math.max(1, sw * sh);
  const hasCutout = transparentCount / totalPixels > 0.02;
  liveSubjectMeta = {
    sourceWidth: temp.width, sourceHeight: temp.height,
    cropX: sx, cropY: sy, cropWidth: sw, cropHeight: sh,
    hasCutout,
    foregroundAreaRatio: foregroundCount / totalPixels,
    fillRatio: foregroundCount / bboxPixels,
    semiTransparentRatio: foregroundCount ? semiTransparentCount / foregroundCount : 0,
    touchesTop: sy <= 2,
    touchesLeft: sx <= 2,
    touchesRight: sx + sw >= temp.width - 2,
    touchesBottom: sy + sh >= temp.height - 2,
  };

  const out = document.createElement("canvas");
  out.width = sw;
  out.height = sh;
  out.getContext("2d").drawImage(temp, sx, sy, sw, sh, 0, 0, sw, sh);
  liveSubjectCanvas = out;
  currentSubjectAnalysis = await analyzeSubjectCanvas(temp, out, liveSubjectMeta);
  updateSubjectQualityUi();
  bitmap.close?.();
}

function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

async function detectNativeFace(sourceCanvas, meta) {
  if (typeof FaceDetector === "undefined") return null;
  try {
    const detector = new FaceDetector({ fastMode: true, maxDetectedFaces: 5 });
    const faces = await detector.detect(sourceCanvas);
    if (!faces?.length) return null;
    const face = [...faces].sort((a, b) =>
      (b.boundingBox.width * b.boundingBox.height) - (a.boundingBox.width * a.boundingBox.height)
    )[0];
    const b = face.boundingBox;
    const x = clamp(b.x - meta.cropX, 0, meta.cropWidth - 1);
    const y = clamp(b.y - meta.cropY, 0, meta.cropHeight - 1);
    const width = clamp(b.width, 1, meta.cropWidth - x);
    const height = clamp(b.height, 1, meta.cropHeight - y);
    return { x, y, width, height, source: "native" };
  } catch (error) {
    console.warn("브라우저 얼굴 감지 실패, 실루엣 기준으로 전환:", error);
    return null;
  }
}

function estimateFaceFromSubject(canvas, meta) {
  const w = canvas.width, h = canvas.height;
  if (!w || !h) return null;

  if (!meta?.hasCutout) {
    const width = w * 0.26;
    return { x: w * 0.5 - width / 2, y: h * 0.12, width, height: width * 1.2, source: "heuristic" };
  }

  try {
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    const data = ctx.getImageData(0, 0, w, h).data;
    const rowInfo = [];
    const minCount = Math.max(3, Math.round(w * 0.012));
    let firstY = -1;

    for (let y = 0; y < Math.min(h, Math.round(h * 0.42)); y++) {
      let minX = w, maxX = -1, count = 0;
      for (let x = 0; x < w; x++) {
        if (data[(y * w + x) * 4 + 3] > 40) {
          count++;
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
        }
      }
      if (count >= minCount) {
        if (firstY < 0) firstY = y;
        rowInfo.push({ y, width: maxX - minX + 1, center: (minX + maxX) / 2 });
      }
    }

    if (firstY >= 0) {
      const endY = firstY + Math.max(8, Math.round(h * 0.16));
      const headRows = rowInfo.filter(r => r.y <= endY && r.width > 2);
      if (headRows.length) {
        const width = clamp(median(headRows.map(r => r.width)) * 0.74, w * 0.08, w * 0.48);
        const height = width * 1.22;
        const cx = median(headRows.map(r => r.center)) || w / 2;
        return {
          x: clamp(cx - width / 2, 0, Math.max(0, w - width)),
          y: clamp(firstY + width * 0.08, 0, Math.max(0, h - height)),
          width, height, source: "heuristic",
        };
      }
    }
  } catch (error) {
    console.warn("실루엣 얼굴 추정 실패:", error);
  }

  const width = w * 0.24;
  return { x: w * 0.5 - width / 2, y: h * 0.08, width, height: width * 1.22, source: "heuristic" };
}

async function analyzeSubjectCanvas(sourceCanvas, croppedCanvas, meta) {
  const faceBox = await detectNativeFace(sourceCanvas, meta) || estimateFaceFromSubject(croppedCanvas, meta);
  const warnings = [];

  if (faceBox) {
    const faceSourceWidthRatio = faceBox.width / Math.max(1, meta.cropWidth);
    const faceOriginalWidthRatio = faceBox.width / Math.max(1, meta.sourceWidth);
    if (faceOriginalWidthRatio < 0.075 || faceSourceWidthRatio < 0.09) warnings.push("얼굴이 원본에서 작음");
    if (faceBox.y <= 2 || faceBox.x <= 2 || faceBox.x + faceBox.width >= meta.cropWidth - 2) warnings.push("얼굴 잘림 가능성");
  } else {
    warnings.push("얼굴 위치를 추정하지 못함");
  }

  if (meta.hasCutout) {
    if (meta.touchesTop || meta.touchesLeft || meta.touchesRight) warnings.push("피사체가 원본 가장자리에 닿음");
    if (meta.fillRatio < 0.16) warnings.push("누끼 일부 누락 가능성");
    else if (meta.semiTransparentRatio > 0.30) warnings.push("누끼 가장자리 검수 권장");
  }

  return {
    faceBox,
    warnings: [...new Set(warnings)],
    faceMode: faceBox?.source === "native" ? "얼굴 감지" : "실루엣 추정",
    hasCutout: !!meta.hasCutout,
  };
}

function updateSubjectQualityUi() {
  const box = $("subjectQuality");
  if (!box) return;
  if (!currentWorkingBlob || !currentSubjectAnalysis) {
    box.className = "subject-quality info";
    box.textContent = "자동 점검: 이미지를 선택하면 얼굴 크기 · 잘림 · 누끼 상태를 확인합니다.";
    return;
  }
  const analysis = currentSubjectAnalysis;
  if (!analysis.warnings.length) {
    box.className = "subject-quality ok";
    box.textContent = `자동 점검: 양호 · ${analysis.faceMode}${analysis.hasCutout ? " · 투명 누끼 확인" : ""}`;
    return;
  }
  box.className = "subject-quality warning";
  box.textContent = `자동 점검: ⚠ ${analysis.warnings.join(" · ")} · ${analysis.faceMode}`;
}

function autoPlaceSubject(mode = "align") {
  if (!liveSubjectCanvas || !currentSubjectAnalysis?.faceBox) {
    setStatus("자동 배치에 사용할 얼굴/피사체 정보를 찾지 못했습니다.", true);
    return;
  }
  const tpl = currentTemplate();
  if (!tpl) return;
  const native = tpl.native_canvas || { width: 800, height: 1200 };
  const box = tpl.subject_box || { x: 0, y: 0, width: native.width, height: native.height };
  const face = currentSubjectAnalysis.faceBox;
  const baseScale = Math.min(
    box.width / Math.max(1, liveSubjectCanvas.width),
    box.height / Math.max(1, liveSubjectCanvas.height)
  );

  let zoom = numValue("zoomNumber", 100);
  if (mode === "size") {
    const targetFaceWidth = native.width * AUTO_FACE_TARGET.width;
    zoom = clamp((targetFaceWidth / Math.max(1, face.width * baseScale)) * 100, 40, 500);
    setLinkedRange("zoom", Number(zoom.toFixed(1)));
  }

  const scale = baseScale * Math.max(0.1, zoom / 100);
  const dw = liveSubjectCanvas.width * scale, dh = liveSubjectCanvas.height * scale;
  const targetX = native.width * AUTO_FACE_TARGET.x, targetY = native.height * AUTO_FACE_TARGET.y;
  const desiredLeft = targetX - (face.x + face.width / 2) * scale;
  const desiredTop = targetY - (face.y + face.height / 2) * scale;
  const denomX = box.width - dw, denomY = box.height - dh;
  const focusX = Math.abs(denomX) < 0.001 ? 50 : ((desiredLeft - box.x) / denomX) * 100;
  const focusY = Math.abs(denomY) < 0.001 ? 50 : ((desiredTop - box.y) / denomY) * 100;

  setLinkedRange("focusX", Number(clamp(focusX, -1000, 1000).toFixed(1)));
  setLinkedRange("focusY", Number(clamp(focusY, -1000, 1000).toFixed(1)));
  queueLivePreview();
  scheduleFinalPreview(0);
  setStatus(
    mode === "size"
      ? `인물 크기와 얼굴 위치를 자동 보정했습니다. (${currentSubjectAnalysis.faceMode})`
      : `얼굴 위치를 자동 정렬했습니다. (${currentSubjectAnalysis.faceMode})`,
    false, true
  );
}

async function warmLivePreviewAssets() {
  const tpl = currentTemplate();
  if (!tpl) return;
  const team = $("teamSelect").value;
  const paths = [tpl.background, tpl.overlay];
  const logo = tpl.team_logos?.[team];
  if (logo) paths.push(logo);
  await Promise.allSettled(paths.map(loadLiveImage));
  await ensureLiveFonts();
}

function gradientForStops(ctx, stops, x0, y0, x1, y1) {
  const g = ctx.createLinearGradient(x0, y0, x1, y1);
  const list = Array.isArray(stops) && stops.length ? stops : [
    { color: "#FFFFFF", position: 0 },
    { color: "#D7D7D7", position: 100 },
  ];
  for (const stop of list) {
    g.addColorStop(clamp(Number(stop.position || 0) / 100, 0, 1), stop.color || "#FFFFFF");
  }
  return g;
}

function drawLiveText(ctx, tpl, c, scaleX, scaleY) {
  const gp = tpl.gradient_profile || {};
  const stops = gp.stops || [];
  const direction = gp.direction || "vertical";

  const header = String(c.season || "").trim();
  if (header) {
    ctx.save();
    ctx.font = `${c.top_right_size * scaleY}px TsukiVITRO, sans-serif`;
    ctx.textAlign = "right";
    ctx.textBaseline = "top";
    ctx.fillStyle = c.top_right_color || "#009520";
    ctx.fillText(header, c.top_right_x * scaleX, c.top_right_y * scaleY);
    ctx.restore();
  }

  const name = String(c.name || "").trim();
  if (name) {
    ctx.save();
    const x = c.name_x * scaleX;
    const y = c.name_y * scaleY;
    const size = c.name_size * scaleY;
    ctx.font = `${size}px TsukiVITRO, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const metrics = ctx.measureText(name);
    const width = Math.max(metrics.width, 1);
    const top = y - size * 0.58;
    const bottom = y + size * 0.58;
    const grad = direction === "horizontal"
      ? gradientForStops(ctx, stops, x - width / 2, y, x + width / 2, y)
      : gradientForStops(ctx, stops, x, top, x, bottom);
    ctx.lineJoin = "round";
    ctx.miterLimit = 2;
    ctx.lineWidth = Math.max(1, c.name_outline_width * 2 * scaleY);
    ctx.strokeStyle = grad;
    ctx.strokeText(name, x, y);
    ctx.fillStyle = c.name_color || "#FFFFFF";
    ctx.fillText(name, x, y);
    // 로컬 제작기의 안쪽 반투명 검정 테두리를 시각적으로 근사
    ctx.lineWidth = Math.max(0.8, scaleY * 1.5);
    ctx.strokeStyle = "rgba(0,0,0,.48)";
    ctx.strokeText(name, x, y);
    ctx.fillText(name, x, y);
    ctx.restore();
  }

  const position = String(c.position || "").trim();
  if (position) {
    ctx.save();
    const x = c.position_x * scaleX;
    const y = c.position_y * scaleY;
    const size = c.position_size * scaleY;
    ctx.font = `${size}px TsukiFreesentation, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const metrics = ctx.measureText(position);
    const width = Math.max(metrics.width, 1);
    const grad = direction === "horizontal"
      ? gradientForStops(ctx, stops, x - width / 2, y, x + width / 2, y)
      : gradientForStops(ctx, stops, x, y - size * .6, x, y + size * .6);
    ctx.shadowColor = "rgba(0,0,0,.9)";
    ctx.shadowBlur = 1 * scaleY;
    ctx.shadowOffsetX = 2 * scaleX;
    ctx.shadowOffsetY = 2 * scaleY;
    ctx.fillStyle = grad;
    ctx.fillText(position, x, y);
    ctx.restore();
  }
}

async function drawLivePreviewNow() {
  if (!currentWorkingBlob || !liveSubjectCanvas) return;
  const tpl = currentTemplate();
  if (!tpl) return;

  const canvas = $("livePreviewCanvas");
  const ctx = canvas.getContext("2d");
  const w = canvas.width, h = canvas.height;
  const native = tpl.native_canvas || { width: 800, height: 1200 };
  const sx = w / native.width;
  const sy = h / native.height;
  const c = collectControls();

  const bg = await loadLiveImage(tpl.background);
  const overlay = await loadLiveImage(tpl.overlay);
  const logoPath = tpl.team_logos?.[c.team_name];
  const logo = logoPath ? await loadLiveImage(logoPath) : null;
  await ensureLiveFonts();

  ctx.clearRect(0, 0, w, h);
  if (bg) ctx.drawImage(bg, 0, 0, w, h);

  const box = tpl.subject_box || { x: 0, y: 0, width: native.width, height: native.height };
  const bw = box.width * sx;
  const bh = box.height * sy;
  const bx = box.x * sx;
  const by = box.y * sy;
  const subjectScale = Math.min(bw / liveSubjectCanvas.width, bh / liveSubjectCanvas.height) * Math.max(.1, c.zoom / 100);
  const dw = liveSubjectCanvas.width * subjectScale;
  const dh = liveSubjectCanvas.height * subjectScale;
  const dx = bx + (bw - dw) * (c.focus_x / 100);
  const dy = by + (bh - dh) * (c.focus_y / 100);

  ctx.save();
  if (c.subject_glow) {
    ctx.shadowColor = "rgba(255,255,255,.9)";
    ctx.shadowBlur = 16 * Math.min(sx, sy);
  }
  ctx.drawImage(liveSubjectCanvas, dx, dy, dw, dh);
  ctx.restore();

  if (overlay) ctx.drawImage(overlay, 0, 0, w, h);
  if (logo) {
    ctx.save();
    ctx.shadowColor = "rgba(255,255,255,.75)";
    ctx.shadowBlur = 5 * Math.min(sx, sy);
    ctx.drawImage(logo, 0, 0, w, h);
    ctx.restore();
  }

  drawLiveText(ctx, tpl, c, sx, sy);
}

function queueLivePreview() {
  if (!currentWorkingBlob || !liveSubjectCanvas) return;
  $("previewStage").classList.add("live-preview");
  if (livePreviewRaf) return;
  livePreviewRaf = requestAnimationFrame(async () => {
    livePreviewRaf = 0;
    try {
      await drawLivePreviewNow();
    } catch (error) {
      console.warn("실시간 미리보기 렌더 실패:", error);
    }
  });
}

function scheduleFinalPreview(delay = 180) {
  clearTimeout(finalPreviewTimer);
  finalPreviewTimer = setTimeout(() => scheduleRender(true), delay);
}

async function loadJson(path) {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`${path} 로드 실패 (${res.status})`);
  return res.json();
}

async function loadTemplates() {
  const files = ["OPAL_V1.json", "CORAL_V1.json", "GOLD_V1.json", "SILVER_V1.json", "TB_V1.json", "ALLSTAR_V1.json", "SEOLLAL_V1.json"];
  const list = await Promise.all(files.map(file => loadJson(`./templates/${file}`)));
  list.forEach(t => templates.set(t.display_name, t));
  const select = $("templateSelect");
  select.innerHTML = ORDER.filter(name => templates.has(name)).map(name => `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`).join("");
}

function inputValue(id, fallback = "") { return $(id).value === "" ? fallback : $(id).value; }
function numValue(id, fallback = 0) {
  const n = Number($(id).value);
  return Number.isFinite(n) ? n : fallback;
}

function currentTemplate() { return templates.get($("templateSelect").value); }
function composedName() {
  return $("nameInput").value.trim();
}
function filenameFromCurrent() {
  const name = $("nameInput").value.trim() || "card";
  const grade = $("templateSelect").value || "card";
  return sanitizeFilename([name, grade].filter(Boolean).join("_"));
}

function styleFromTemplate(resetAll = false) {
  const tpl = currentTemplate();
  if (!tpl) return;
  const h = tpl.top_right_text || {};
  const n = tpl.name_text || {};
  const p = tpl.position_text || {};
  if (resetAll || !$("headerSize").value) $("headerSize").value = h.font_size ?? 28;
  if (resetAll || !$("headerX").value) $("headerX").value = h.x ?? 778;
  if (resetAll || !$("headerY").value) $("headerY").value = h.y ?? 42;
  if (resetAll || !$("headerColor").value) $("headerColor").value = h.color ?? "#00B03A";
  if (resetAll || !$("nameSize").value) $("nameSize").value = n.font_size ?? 48;
  if (resetAll || !$("nameX").value) $("nameX").value = n.x ?? 405;
  if (resetAll || !$("nameY").value) $("nameY").value = n.y ?? 973;
  if (resetAll || !$("nameColor").value) $("nameColor").value = n.color ?? "#FFFFFF";
  if (resetAll || !$("nameOutline").value) $("nameOutline").value = tpl.gradient_profile?.name?.outer_stroke_default ?? 3;
  if (resetAll || !$("positionSize").value) $("positionSize").value = p.font_size ?? 60;
  if (resetAll || !$("positionX").value) $("positionX").value = p.x ?? 680;
  if (resetAll || !$("positionY").value) $("positionY").value = p.y ?? 980;
  if (resetAll || !$("positionColor").value) $("positionColor").value = p.color ?? "#FFFFFF";
}

function populateTeams(preferred = null) {
  const tpl = currentTemplate();
  const names = Object.keys(tpl?.team_logos || {});
  const select = $("teamSelect");
  const old = preferred ?? select.value;
  select.innerHTML = `<option value="">로고 없음</option>` + names.map(n => `<option value="${escapeHtml(n)}">${escapeHtml(n)}</option>`).join("");
  if (names.includes(old)) select.value = old;
  else if (names.includes(staticDefaults?.team_name)) select.value = staticDefaults.team_name;
  else select.value = names[0] || "";
}

function collectControls() {
  const tpl = currentTemplate();
  return {
    grade: $("templateSelect").value,
    team_name: $("teamSelect").value,
    season: $("seasonInput").value,
    name: $("nameInput").value,
    position: $("positionInput").value,
    focus_x: numValue("focusXNumber", 50),
    focus_y: numValue("focusYNumber", 50),
    zoom: numValue("zoomNumber", 100),
    subject_glow: $("glowCheck").checked,
    top_right_size: numValue("headerSize", tpl?.top_right_text?.font_size || 28),
    top_right_x: numValue("headerX", tpl?.top_right_text?.x || 778),
    top_right_y: numValue("headerY", tpl?.top_right_text?.y || 42),
    top_right_color: $("headerColor").value || "#00B03A",
    name_size: numValue("nameSize", tpl?.name_text?.font_size || 48),
    name_x: numValue("nameX", tpl?.name_text?.x || 405),
    name_y: numValue("nameY", tpl?.name_text?.y || 973),
    name_color: $("nameColor").value || "#FFFFFF",
    position_size: numValue("positionSize", tpl?.position_text?.font_size || 60),
    position_x: numValue("positionX", tpl?.position_text?.x || 680),
    position_y: numValue("positionY", tpl?.position_text?.y || 980),
    position_color: $("positionColor").value || "#FFFFFF",
    name_outline_width: numValue("nameOutline", 3),
  };
}

function applyControls(data) {
  if (!data) return;
  if (data.grade && templates.has(data.grade)) $("templateSelect").value = data.grade;
  populateTeams(data.team_name);
  const map = {
    season: "seasonInput", name: "nameInput", position: "positionInput",
    top_right_size: "headerSize", top_right_x: "headerX", top_right_y: "headerY", top_right_color: "headerColor",
    name_size: "nameSize", name_x: "nameX", name_y: "nameY", name_color: "nameColor", name_outline_width: "nameOutline",
    position_size: "positionSize", position_x: "positionX", position_y: "positionY", position_color: "positionColor",
  };
  for (const [key, id] of Object.entries(map)) if (data[key] !== undefined && data[key] !== null) $(id).value = data[key];
  setLinkedRange("focusX", data.focus_x ?? 50);
  setLinkedRange("focusY", data.focus_y ?? 50);
  setLinkedRange("zoom", data.zoom ?? 100);
  $("glowCheck").checked = data.subject_glow ?? true;
  $("filenameInput").value = filenameFromCurrent();
}

function paramsForRender(overrides = {}) {
  const c = collectControls();
  const tpl = currentTemplate();
  const team = overrides.team_name ?? c.team_name;
  const season = overrides.season ?? c.season;
  const displayName = overrides.display_name ?? composedName();
  const position = overrides.position ?? c.position;
  return {
    name: displayName,
    element_color: "#FFFFFF",
    text_color: "#FFFFFF",
    focus_x: (overrides.focus_x ?? c.focus_x) / 100,
    focus_y: (overrides.focus_y ?? c.focus_y) / 100,
    zoom: (overrides.zoom ?? c.zoom) / 100,
    font_override: null,
    extra: {
      team_name: team,
      top_right_text: season,
      top_right_size: overrides.top_right_size ?? c.top_right_size,
      top_right_x: overrides.top_right_x ?? c.top_right_x,
      top_right_y: overrides.top_right_y ?? c.top_right_y,
      top_right_color: overrides.top_right_color ?? c.top_right_color,
      name_text: displayName,
      name_size: overrides.name_size ?? c.name_size,
      name_x: overrides.name_x ?? c.name_x,
      name_y: overrides.name_y ?? c.name_y,
      name_color: overrides.name_color ?? c.name_color,
      position_text: position,
      position_size: overrides.position_size ?? c.position_size,
      position_x: overrides.position_x ?? c.position_x,
      position_y: overrides.position_y ?? c.position_y,
      position_color: overrides.position_color ?? c.position_color,
      name_outline_width: overrides.name_outline_width ?? c.name_outline_width,
      gradient_profile: tpl?.gradient_profile || {},
      header_font_path: "/home/pyodide/app/assets/fonts/VITRO_INSPIRE.otf",
      name_font_path: "/home/pyodide/app/assets/fonts/VITRO_INSPIRE.otf",
      position_font_path: "/home/pyodide/app/assets/fonts/Freesentation-8ExtraBold.ttf",
      subject_glow: overrides.subject_glow ?? c.subject_glow,
    },
  };
}

function assetsFor(template, teamName = "") {
  const paths = [template.background, template.overlay, ...FONT_PATHS];
  const logo = template.team_logos?.[teamName];
  if (logo) paths.push(logo);
  return [...new Set(paths.filter(Boolean))];
}

async function setWorkingPhoto(blob, label = "이미지") {
  const buffer = await blob.arrayBuffer();
  await callWorker("setPhoto", { buffer }, [buffer]);
  currentWorkingBlob = blob;
  await prepareLiveSubject(blob);
  await warmLivePreviewAssets();
  $("cutoutBtn").disabled = false;
  $("autoFaceBtn").disabled = false;
  $("autoScaleBtn").disabled = false;
  $("restorePhotoBtn").disabled = !currentOriginalFile || blob === currentOriginalFile;
  $("generateBtn").disabled = false;
  $("previewHint").textContent = label;
  scheduleRender(true);
}

async function renderCurrent(width = 400, height = 600) {
  if (!currentWorkingBlob) return null;
  const template = currentTemplate();
  const params = paramsForRender();
  await callWorker("ensureAssets", { paths: assetsFor(template, params.extra.team_name) });
  return callWorker("render", { template, params, width, height });
}

function scheduleRender(immediate = false) {
  if (!runtimeReady || !currentWorkingBlob) return;
  clearTimeout(renderTimer);
  renderTimer = setTimeout(runPreviewRender, immediate ? 0 : 160);
}

async function runPreviewRender() {
  if (renderInFlight) { renderAgain = true; return; }
  renderInFlight = true;
  try {
    setStatus("미리보기를 생성하고 있습니다.");
    const result = await renderCurrent(400, 600);
    const blob = base64ToBlob(result.base64);
    if (currentPreviewUrl) URL.revokeObjectURL(currentPreviewUrl);
    currentPreviewUrl = URL.createObjectURL(blob);
    $("previewImage").src = currentPreviewUrl;
    $("previewStage").classList.add("has-image");
    $("previewStage").classList.remove("live-preview");
    setStatus("미리보기 완료. 드래그로 위치를 이동하고 휠로 확대/축소할 수 있습니다.", false, true);
  } catch (error) {
    console.error(error);
    setStatus(`미리보기 생성 실패: ${error.message}`, true);
  } finally {
    renderInFlight = false;
    if (renderAgain) { renderAgain = false; scheduleRender(true); }
  }
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

async function generateAndDownload() {
  if (!currentWorkingBlob) return;
  const btn = $("generateBtn");
  btn.disabled = true;
  try {
    setStatus("800 × 1200 PNG를 생성하고 있습니다.");
    const template = currentTemplate();
    const params = paramsForRender();
    await callWorker("ensureAssets", { paths: assetsFor(template, params.extra.team_name) });
    const result = await callWorker("render", { template, params, width: 800, height: 1200 });
    const blob = base64ToBlob(result.base64);
    const filename = sanitizeFilename($("filenameInput").value, filenameFromCurrent());
    const saved = await saveBlobToChosenLocation(blob, filename);
    markSelectedExcelDataDone();
    if (saved.mode === "folder") {
      setStatus(`저장 완료: ${saved.name} / ${filename}`, false, true);
    } else {
      setStatus("저장 완료: 브라우저 기본 다운로드 폴더", false, true);
    }
  } catch (error) {
    setStatus(`PNG 생성 실패: ${error.message}`, true);
  } finally { btn.disabled = false; }
}

function setLinkedRange(prefix, value) {
  const range = $(`${prefix}Range`);
  const number = $(`${prefix}Number`);
  if (range) range.value = value;
  if (number) number.value = value;
}
function bindRange(prefix, min, max) {
  const range = $(`${prefix}Range`);
  const number = $(`${prefix}Number`);
  const sync = (from, to) => {
    const value = clamp(Number(from.value || 0), min, max);
    to.value = value;
    queueLivePreview();
    scheduleFinalPreview(180);
  };
  range.addEventListener("input", () => sync(range, number));
  number.addEventListener("input", () => sync(number, range));
}

function updateGuides() {
  $("centerGuide").style.display = $("centerGuideCheck").checked ? "block" : "none";
  $("faceGuide").style.display = $("faceGuideCheck").checked ? "block" : "none";
  const scale = Number($("faceGuideRange").value || 100) / 100;
  $("faceGuide").style.width = `${28 * scale}%`;
  $("faceGuideValue").value = `${Math.round(scale * 100)}%`;
}

function bindPreviewGestures() {
  const stage = $("previewStage");
  stage.addEventListener("pointerdown", (e) => {
    if (!currentWorkingBlob) return;
    stage.setPointerCapture(e.pointerId);
    dragState = { x: e.clientX, y: e.clientY };
    liveInteractionActive = true;
    stage.classList.add("dragging", "live-preview");
    queueLivePreview();
  });
  stage.addEventListener("pointermove", (e) => {
    if (!dragState) return;
    const rect = stage.getBoundingClientRect();
    const dx = e.clientX - dragState.x;
    const dy = e.clientY - dragState.y;
    const nx = clamp(numValue("focusXNumber", 50) - dx * 100 / Math.max(1, rect.width), -1000, 1000);
    const ny = clamp(numValue("focusYNumber", 50) - dy * 100 / Math.max(1, rect.height), -1000, 1000);
    setLinkedRange("focusX", nx.toFixed(1));
    setLinkedRange("focusY", ny.toFixed(1));
    dragState = { x: e.clientX, y: e.clientY };
    queueLivePreview();
  });
  const endDrag = () => {
    if (!dragState) return;
    dragState = null;
    liveInteractionActive = false;
    stage.classList.remove("dragging");
    scheduleFinalPreview(0);
  };
  stage.addEventListener("pointerup", endDrag);
  stage.addEventListener("pointercancel", endDrag);

  stage.addEventListener("wheel", (e) => {
    if (!currentWorkingBlob) return;
    e.preventDefault();
    const delta = Math.abs(e.deltaY) > 12 ? 3 : 1;
    const direction = e.deltaY < 0 ? 1 : -1;
    const next = clamp(numValue("zoomNumber", 100) + direction * delta, 40, 500);
    setLinkedRange("zoom", next);
    queueLivePreview();
    scheduleFinalPreview(160);
  }, { passive: false });
}

async function doCutout() {
  if (!currentWorkingBlob) return;
  const btn = $("cutoutBtn");
  btn.disabled = true;
  try {
    setStatus("AI 누끼 모델을 준비하고 있습니다. 최초 실행은 다운로드 때문에 오래 걸릴 수 있습니다.");
    if (!cutoutModule) cutoutModule = await import("https://esm.sh/@imgly/background-removal@1.5.6");
    const progress = (key, current, total) =>
      setStatus(`AI 누끼 처리 중: ${key} ${Math.round((current / Math.max(1, total)) * 100)}%`);

    let out;
    if (webGpuAvailable()) {
      try {
        setStatus("AI 누끼: WebGPU로 처리 중...");
        out = await cutoutModule.removeBackground(currentWorkingBlob, {
          ...CUTOUT_CONFIG,
          device: "gpu",
          progress,
        });
      } catch (gpuError) {
        console.warn("WebGPU 누끼 실패, CPU/WASM으로 재시도:", gpuError);
        setStatus("WebGPU 처리 실패. CPU/WASM으로 자동 재시도합니다.");
        out = await cutoutModule.removeBackground(currentWorkingBlob, {
          ...CUTOUT_CONFIG,
          device: "cpu",
          progress,
        });
      }
    } else {
      setStatus("WebGPU 미지원 환경입니다. CPU/WASM으로 처리합니다.");
      out = await cutoutModule.removeBackground(currentWorkingBlob, {
        ...CUTOUT_CONFIG,
        device: "cpu",
        progress,
      });
    }
    await setWorkingPhoto(out, webGpuAvailable() ? "AI 누끼 적용됨 (WebGPU 우선)" : "AI 누끼 적용됨");
    $("restorePhotoBtn").disabled = false;
    setStatus("AI 누끼를 적용했습니다.", false, true);
  } catch (error) {
    console.error(error);
    setStatus(`AI 누끼 실패: ${error.message}. PNG 투명 배경 이미지를 직접 넣어도 됩니다.`, true);
  } finally { btn.disabled = false; }
}

function saveDefaults() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(collectControls()));
  setStatus("현재 설정을 이 브라우저의 기본값으로 저장했습니다.", false, true);
}
function resetDefaults() {
  localStorage.removeItem(STORAGE_KEY);
  applyControls({
    grade: "오팔",
    team_name: staticDefaults.team_name,
    season: staticDefaults.top_right_text,
    name: "츠키",
    position: staticDefaults.position_text,
    focus_x: 50, focus_y: 50, zoom: 100, subject_glow: true,
    ...staticDefaults,
  });
  setStatus("저장된 사용자 기본값을 지우고 프로그램 기본값으로 되돌렸습니다.", false, true);
  scheduleRender();
}

function maybeUpdateFilename() { $("filenameInput").value = filenameFromCurrent(); }

function bindInputs() {
  bindRange("focusX", -1000, 1000);
  bindRange("focusY", -1000, 1000);
  bindRange("zoom", 40, 500);
  bindPreviewGestures();

  $("templateSelect").addEventListener("change", () => {
    // 등급 변경 시 텍스트 크기/위치/색상은 유지한다.
    // 프레임/배경/그라데이션만 새 등급으로 바뀐다.
    populateTeams();
    warmLivePreviewAssets();
    maybeUpdateFilename();
    scheduleRender();
  });
  $("teamSelect").addEventListener("change", () => {
    warmLivePreviewAssets();
    scheduleRender();
  });
  ["seasonInput","nameInput","positionInput","headerSize","headerX","headerY","headerColor","nameSize","nameX","nameY","nameColor","nameOutline","positionSize","positionX","positionY","positionColor","glowCheck"].forEach(id => {
    $(id).addEventListener("input", () => {
      if (id === "nameInput") maybeUpdateFilename();
      scheduleRender();
    });
    $(id).addEventListener("change", scheduleRender);
  });

  $("photoInput").addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    currentOriginalFile = file;
    await setWorkingPhoto(file, file.name);
    $("restorePhotoBtn").disabled = true;
  });
  $("restorePhotoBtn").addEventListener("click", async () => {
    if (!currentOriginalFile) return;
    await setWorkingPhoto(currentOriginalFile, `${currentOriginalFile.name} (원본)`);
    $("restorePhotoBtn").disabled = true;
  });
  $("cutoutBtn").addEventListener("click", doCutout);
  $("autoFaceBtn").addEventListener("click", () => autoPlaceSubject("align"));
  $("autoScaleBtn").addEventListener("click", () => autoPlaceSubject("size"));
  $("generateBtn").addEventListener("click", generateAndDownload);
  const savePathBtn = $("savePathBtn");
  if (savePathBtn) savePathBtn.addEventListener("click", chooseSaveDirectory);
  $("resetCropBtn").addEventListener("click", () => { setLinkedRange("focusX", 50); setLinkedRange("focusY", 50); setLinkedRange("zoom", 100); scheduleRender(); });
  $("resetTextBtn").addEventListener("click", () => {
    const c = collectControls();
    applyControls({
      ...c,
      top_right_size: staticDefaults.top_right_size,
      top_right_x: staticDefaults.top_right_x,
      top_right_y: staticDefaults.top_right_y,
      top_right_color: staticDefaults.top_right_color,
      name_size: staticDefaults.name_size,
      name_x: staticDefaults.name_x,
      name_y: staticDefaults.name_y,
      name_color: staticDefaults.name_color,
      name_outline_width: staticDefaults.name_outline_width,
      position_size: staticDefaults.position_size,
      position_x: staticDefaults.position_x,
      position_y: staticDefaults.position_y,
      position_color: staticDefaults.position_color,
    });
    scheduleRender();
  });
  $("saveDefaultsBtn").addEventListener("click", saveDefaults);
  $("resetDefaultsBtn").addEventListener("click", resetDefaults);
  ["centerGuideCheck","faceGuideCheck","faceGuideRange"].forEach(id => $(id).addEventListener("input", updateGuides));
  updateGuides();

  const excelDataLoadBtn = $("excelDataLoadBtn");
  const excelDataInput = $("excelDataInput");
  const excelDataImageFolderBtn = $("excelDataImageFolderBtn");
  const excelDataImageFolderInput = $("excelDataImageFolderInput");
  const excelProgressSaveBtn = $("excelProgressSaveBtn");
  if (excelDataLoadBtn && excelDataInput) {
    excelDataLoadBtn.addEventListener("click", () => excelDataInput.click());
    excelDataInput.addEventListener("change", loadExcelDataPanel);
  }
  if (excelProgressSaveBtn) {
    excelProgressSaveBtn.addEventListener("click", saveExcelProgressState);
  }
  if (excelDataImageFolderBtn && excelDataImageFolderInput) {
    excelDataImageFolderBtn.addEventListener("click", () => excelDataImageFolderInput.click());
    excelDataImageFolderInput.addEventListener("change", () => {
      excelDataImageFiles = [...(excelDataImageFolderInput.files || [])];
      updateExcelDataStatus(
        excelDataImageFiles.length
          ? `이미지 폴더 연결: ${excelDataImageFiles.length}개 파일 · 행 클릭 시 사진까지 즉시 미리보기됩니다.`
          : "이미지 폴더가 비어 있습니다."
      );
    });
  }

  $("excelInput").addEventListener("change", prepareBatch);
  $("imageFolderInput").addEventListener("change", prepareBatch);
  $("batchBtn").addEventListener("click", runBatch);
}


function excelNaturalSortKey(value) {
  return String(value ?? "").trim().toLocaleLowerCase("ko-KR");
}

function excelNaturalCompare(a, b) {
  const aa = excelNaturalSortKey(a);
  const bb = excelNaturalSortKey(b);
  return aa.localeCompare(bb, "ko-KR", { numeric: true, sensitivity: "base" });
}

function getFilteredExcelRows() {
  return loadedExcelRows.filter(item =>
    EXCEL_DATA_COLUMNS.every(col => {
      const filter = String(excelDataFilters[col] || "").trim();
      if (!filter) return true;
      return String(item.row[col] ?? "").trim() === filter;
    })
  );
}

function getExcelFilterOptions(column) {
  return [...new Set(
    loadedExcelRows
      .map(item => String(item.row[column] ?? "").trim())
      .filter(Boolean)
  )].sort(excelNaturalCompare);
}

function renderExcelDataHead() {
  const head = $("excelDataHead");
  if (!head) return;

  const titleRow = "<tr class=\"excel-sort-row\">" + EXCEL_DATA_COLUMNS.map(col => {
    const arrow = col === excelDataSortColumn ? (excelDataSortDesc ? " ▼" : " ▲") : "";
    return `<th data-col="${escapeHtml(col)}">${escapeHtml(col)}${arrow}</th>`;
  }).join("") + "</tr>";

  const filterRow = "<tr class=\"excel-filter-row\">" + EXCEL_DATA_COLUMNS.map(col => {
    const options = getExcelFilterOptions(col);
    const selected = excelDataFilters[col] || "";
    return `<th><select class="excel-column-filter" data-filter-col="${escapeHtml(col)}">
      <option value="">전체</option>
      ${options.map(value => `<option value="${escapeHtml(value)}" ${value === selected ? "selected" : ""}>${escapeHtml(value)}</option>`).join("")}
    </select></th>`;
  }).join("") + "</tr>";

  head.innerHTML = titleRow + filterRow;

  head.querySelectorAll(".excel-sort-row th").forEach(th => {
    th.addEventListener("click", () => sortExcelDataPanel(th.dataset.col));
  });
  head.querySelectorAll(".excel-column-filter").forEach(select => {
    select.addEventListener("change", (event) => {
      const col = event.target.dataset.filterCol;
      excelDataFilters[col] = event.target.value;
      renderExcelDataBody();
      updateExcelDataStatus();
    });
  });
}

function renderExcelDataBody() {
  const body = $("excelDataBody");
  if (!body) return;
  const visibleRows = getFilteredExcelRows();
  if (!visibleRows.length) {
    body.innerHTML = `<tr class="excel-data-empty"><td colspan="${EXCEL_DATA_COLUMNS.length}">조건에 맞는 데이터가 없습니다.</td></tr>`;
    return;
  }
  body.innerHTML = visibleRows.map(item => {
    const cls = [
      item.done ? "done" : "",
      item.warning ? "warning" : "",
      item.id === selectedExcelDataId ? "selected" : "",
    ].filter(Boolean).join(" ");
    return `<tr data-id="${item.id}" class="${cls}" title="${escapeHtml(item.warning || "")}">
      ${EXCEL_DATA_COLUMNS.map(col => `<td data-col="${escapeHtml(col)}">${escapeHtml(item.row[col] ?? "")}</td>`).join("")}
    </tr>`;
  }).join("");

  body.querySelectorAll("tr[data-id]").forEach(tr => {
    tr.addEventListener("click", () => selectExcelDataRow(tr.dataset.id, true));
    tr.addEventListener("dblclick", (event) => {
      event.preventDefault();
      selectExcelDataRow(tr.dataset.id, true);
      toggleExcelDataDone(tr.dataset.id);
    });
  });
}

function updateExcelDataStatus(message = "") {
  const el = $("excelDataStatus");
  if (!el) return;
  if (message) {
    el.textContent = message;
    return;
  }
  const visible = getFilteredExcelRows().length;
  const done = loadedExcelRows.filter(item => item.done).length;
  const activeFilters = EXCEL_DATA_COLUMNS.filter(col => excelDataFilters[col]).length;
  el.textContent = `표시 ${visible}/${loadedExcelRows.length}행 · 완료 ${done}행${activeFilters ? ` · 필터 ${activeFilters}개 적용` : ""}`;
}

function saveExcelProgressState() {
  try {
    const payload = {
      version: 1,
      savedAt: new Date().toISOString(),
      rows: loadedExcelRows,
      selectedExcelDataId,
      sortColumn: excelDataSortColumn,
      sortDesc: excelDataSortDesc,
      filters: excelDataFilters,
      hint: $("excelDataHint")?.textContent || "",
    };
    localStorage.setItem(EXCEL_PROGRESS_STORAGE_KEY, JSON.stringify(payload));
    updateExcelDataStatus("진행 상태를 이 브라우저에 저장했습니다.");
  } catch (error) {
    updateExcelDataStatus("진행 상태 저장 실패: " + error.message);
  }
}

function restoreExcelProgressState() {
  try {
    const raw = localStorage.getItem(EXCEL_PROGRESS_STORAGE_KEY);
    if (!raw) return false;
    const payload = JSON.parse(raw);
    if (!payload || !Array.isArray(payload.rows) || !payload.rows.length) return false;

    loadedExcelRows = payload.rows;
    selectedExcelDataId = payload.selectedExcelDataId || null;
    excelDataSortColumn = payload.sortColumn || null;
    excelDataSortDesc = !!payload.sortDesc;
    excelDataFilters = {
      ...Object.fromEntries(EXCEL_DATA_COLUMNS.map(col => [col, ""])),
      ...(payload.filters || {}),
    };

    if (excelDataSortColumn) {
      const nonempty = [];
      const empty = [];
      loadedExcelRows.forEach(item => {
        const value = String(item.row?.[excelDataSortColumn] ?? "").trim();
        (value ? nonempty : empty).push(item);
      });
      nonempty.sort((a, b) => {
        const cmp = excelNaturalCompare(a.row[excelDataSortColumn], b.row[excelDataSortColumn]);
        return excelDataSortDesc ? -cmp : cmp;
      });
      loadedExcelRows = nonempty.concat(empty);
    }

    renderExcelDataHead();
    renderExcelDataBody();
    if ($("excelDataHint")) {
      $("excelDataHint").textContent = payload.hint || `저장된 작업 상태 복원 · ${loadedExcelRows.length}행`;
    }
    updateExcelDataStatus("이전 작업 상태를 복원했습니다.");
    return true;
  } catch (error) {
    console.warn("진행 상태 복원 실패:", error);
    return false;
  }
}

function sortExcelDataPanel(column) {
  if (!EXCEL_DATA_COLUMNS.includes(column)) return;
  if (excelDataSortColumn === column) excelDataSortDesc = !excelDataSortDesc;
  else {
    excelDataSortColumn = column;
    excelDataSortDesc = true;
  }

  const nonempty = [];
  const empty = [];
  loadedExcelRows.forEach(item => {
    const value = String(item.row[column] ?? "").trim();
    (value ? nonempty : empty).push(item);
  });
  nonempty.sort((a, b) => {
    const cmp = excelNaturalCompare(a.row[column], b.row[column]);
    return excelDataSortDesc ? -cmp : cmp;
  });
  loadedExcelRows = nonempty.concat(empty);
  renderExcelDataHead();
  renderExcelDataBody();
  updateExcelDataStatus(`엑셀 데이터 정렬: ${column} · ${excelDataSortDesc ? "내림차순" : "오름차순"}`);
}

function selectExcelDataRow(id, apply = true) {
  const item = loadedExcelRows.find(x => x.id === id);
  if (!item) return;
  selectedExcelDataId = id;
  renderExcelDataBody();
  if (apply) void applyExcelDataRow(item);
}

function findExcelDataImage(name, row = {}) {
  const files = excelDataImageFiles.length ? excelDataImageFiles : batchImageFiles;
  if (!files.length) return null;
  const wanted = normalizePath(name);
  if (wanted) {
    const exact = files.filter(f => normalizePath(f.webkitRelativePath || f.name).endsWith(wanted));
    if (exact.length === 1) return exact[0];
    const base = wanted.split("/").pop();
    const byBase = files.filter(f => f.name.toLowerCase() === base);
    if (byBase.length === 1) return byBase[0];
  }
  const playerName = String(row["이름"] || "").trim().toLocaleLowerCase("ko-KR");
  if (!playerName) return null;
  const byStem = files.filter(f => f.name.replace(/\.[^.]+$/, "").trim().toLocaleLowerCase("ko-KR") === playerName);
  return byStem.length === 1 ? byStem[0] : null;
}

async function applyExcelDataRow(item) {
  const r = item.row;
  const grade = String(r["등급"] || "").trim();
  if (grade && templates.has(grade)) {
    $("templateSelect").value = grade;
    populateTeams(String(r["구단"] || "").trim());
  } else if (grade) {
    $("excelDataStatus").textContent = `등록되지 않은 등급: ${grade}`;
  }

  const team = String(r["구단"] || "").trim();
  if (team) $("teamSelect").value = team;

  $("seasonInput").value = String(r["시즌"] || "").trim();
  $("nameInput").value = String(r["이름"] || "").trim();
  $("positionInput").value = String(r["포지션"] || "").trim();

  const requested = String(r["저장파일명"] || "").trim();
  $("filenameInput").value = requested ? sanitizeFilename(requested) : filenameFromCurrent();

  const seq = ++excelRowPreviewSeq;
  const requestedImage = String(r["이미지명"] || "").trim();
  const image = findExcelDataImage(requestedImage, r);

  if (image && currentOriginalFile !== image) {
    currentOriginalFile = image;
    try {
      await setWorkingPhoto(image, `${image.name} · ${r["이름"] || "선택 행"}`);
      if (seq !== excelRowPreviewSeq) return;
      $("restorePhotoBtn").disabled = true;
      item.warning = currentSubjectAnalysis?.warnings?.join(" · ") || "";
      updateExcelDataStatus(
        `즉시 미리보기: ${r["이름"] || image.name}${item.warning ? ` · ⚠ ${item.warning}` : ""}`
      );
      return;
    } catch (error) {
      updateExcelDataStatus(`사진 미리보기 실패: ${error.message}`);
      return;
    }
  }

  scheduleRender();
  if (image) {
    item.warning = currentSubjectAnalysis?.warnings?.join(" · ") || item.warning || "";
    updateExcelDataStatus(
      `설정 적용 + 사진 유지: ${r["이름"] || image.name}${item.warning ? ` · ⚠ ${item.warning}` : ""}`
    );
  } else if (requestedImage) {
    updateExcelDataStatus(`설정 적용: ${r["이름"] || "선택 행"} · 이미지를 찾지 못함: ${requestedImage}`);
  } else {
    const files = excelDataImageFiles.length || batchImageFiles.length;
    updateExcelDataStatus(
      files
        ? `설정 적용: ${r["이름"] || r["저장파일명"] || "선택 행"} · 이미지명 없음`
        : `설정 적용: ${r["이름"] || r["저장파일명"] || "선택 행"} · 이미지 폴더를 연결하면 사진도 즉시 미리보기됩니다.`
    );
  }
}

function toggleExcelDataDone(id) {
  const item = loadedExcelRows.find(x => x.id === id);
  if (!item) return;
  item.done = !item.done;
  renderExcelDataBody();
  updateExcelDataStatus(
    `${item.done ? "제작 완료 표시" : "제작 완료 표시 해제"}: ${item.row["저장파일명"] || item.row["이름"] || id}`
  );
}

function markSelectedExcelDataDone() {
  if (!selectedExcelDataId) return;
  const item = loadedExcelRows.find(x => x.id === selectedExcelDataId);
  if (!item) return;
  item.done = true;
  renderExcelDataBody();
  updateExcelDataStatus();
}

async function loadExcelDataPanel(event) {
  const file = event.target.files?.[0];
  if (!file) return;
  try {
    ensureSheetJs();
    const data = await file.arrayBuffer();
    const wb = XLSX.read(data, { type: "array", raw: false });
    const sheetName = wb.SheetNames.includes("입력") ? "입력" : wb.SheetNames[0];
    const ws = wb.Sheets[sheetName];

    const grid = XLSX.utils.sheet_to_json(ws, { header: 1, defval: "", raw: false });
    let headerRow = -1;
    let indices = null;
    for (let i = 0; i < Math.min(grid.length, 20); i++) {
      const labels = grid[i].map(x => String(x ?? "").trim());
      if (EXCEL_REQUIRED_COLUMNS.every(col => labels.includes(col))) {
        headerRow = i;
        indices = Object.fromEntries(EXCEL_DATA_COLUMNS.map(col => [col, labels.indexOf(col)]));
        break;
      }
    }
    if (headerRow < 0) throw new Error("필요한 열을 찾지 못했습니다: " + EXCEL_REQUIRED_COLUMNS.join(" | "));

    loadedExcelRows = [];
    for (let r = headerRow + 1; r < grid.length; r++) {
      const raw = grid[r] || [];
      const row = {};
      EXCEL_DATA_COLUMNS.forEach(col => {
        const idx = indices[col];
        row[col] = idx >= 0 ? String(raw[idx] ?? "").trim() : "";
      });
      if (!EXCEL_DATA_COLUMNS.some(col => row[col])) continue;
      // 양식 2행의 [예시] 행은 로컬/웹 일괄 생성 규칙과 동일하게 제외
      if (r === headerRow + 1 && String(row["시즌"]).startsWith("[예시]")) continue;
      loadedExcelRows.push({
        id: `excel_${r + 1}`,
        excelRow: r + 1,
        row,
        done: false,
      });
    }

    if (!loadedExcelRows.length) throw new Error("불러올 데이터 행이 없습니다.");

    excelDataSortColumn = null;
    excelDataSortDesc = false;
    selectedExcelDataId = null;
    excelDataFilters = Object.fromEntries(EXCEL_DATA_COLUMNS.map(col => [col, ""]));
    renderExcelDataHead();
    renderExcelDataBody();
    $("excelDataHint").textContent =
      `${file.name} · ${loadedExcelRows.length}행 불러옴 · 한 번 클릭=설정+사진 미리보기 / 더블클릭=제작 완료 토글`;
    updateExcelDataStatus(`엑셀 데이터 ${loadedExcelRows.length}행을 불러왔습니다. 적용할 행을 클릭하세요.`);
  } catch (error) {
    loadedExcelRows = [];
    selectedExcelDataId = null;
    renderExcelDataHead();
    renderExcelDataBody();
    $("excelDataStatus").textContent = "엑셀 데이터 불러오기 실패: " + error.message;
  } finally {
    event.target.value = "";
  }
}

function ensureSheetJs() {
  if (!window.XLSX) throw new Error("Excel 라이브러리가 아직 로드되지 않았습니다. 인터넷 연결을 확인하세요.");
}
function ensureJsZip() {
  if (!window.JSZip) throw new Error("ZIP 라이브러리가 아직 로드되지 않았습니다. 인터넷 연결을 확인하세요.");
}

async function prepareBatch() {
  const excel = $("excelInput").files?.[0];
  batchImageFiles = [...($("imageFolderInput").files || [])];
  $("batchBtn").disabled = true;
  batchRows = [];
  $("batchTableWrap").innerHTML = "";
  if (!excel || batchImageFiles.length === 0) {
    setBatchStatus("Excel과 이미지 폴더를 모두 선택하세요.");
    return;
  }
  try {
    ensureSheetJs();
    const data = await excel.arrayBuffer();
    const wb = XLSX.read(data, { type: "array", raw: false });
    const sheetName = wb.SheetNames.includes("입력") ? "입력" : wb.SheetNames[0];
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], {
      defval: "",
      raw: false,
      range: 2,
      header: ["시즌", "등급", "구단", "이름", "포지션", "이미지명", "저장파일명"],
    });
    batchRows = rows
      .filter(row => String(row["이름"] || "").trim() || String(row["이미지명"] || "").trim())
      .map((row, i) => ({ index: i + 3, row, state: "ready", message: "" }));
    if (!batchRows.length) throw new Error("생성할 데이터 행이 없습니다.");
    renderBatchTable();
    $("batchBtn").disabled = false;
    setBatchStatus(`${batchRows.length}개 행을 읽었습니다. 이미지 폴더 ${batchImageFiles.length}개 파일을 사용합니다.`, false, true);
  } catch (error) {
    setBatchStatus(`Excel 읽기 실패: ${error.message}`, true);
  }
}

function renderBatchTable() {
  const html = `<table class="batch-table"><thead><tr><th>행</th><th>시즌</th><th>등급</th><th>구단</th><th>이름</th><th>포지션</th><th>이미지</th><th>상태</th></tr></thead><tbody>` +
    batchRows.map(item => {
      const r = item.row;
      return `<tr class="${item.state === "done" ? "done" : item.state === "error" ? "error" : ""}">
        <td>${item.index}</td><td>${escapeHtml(r["시즌"])}</td><td>${escapeHtml(r["등급"])}</td><td>${escapeHtml(r["구단"])}</td><td>${escapeHtml(r["이름"])}</td><td>${escapeHtml(r["포지션"])}</td><td>${escapeHtml(r["이미지명"])}</td><td>${escapeHtml(item.message || item.state)}</td>
      </tr>`;
    }).join("") + `</tbody></table>`;
  $("batchTableWrap").innerHTML = html;
}

function normalizePath(s) { return String(s || "").replaceAll("\\", "/").replace(/^\.\//, "").toLowerCase(); }
function findBatchImage(name) {
  const wanted = normalizePath(name);
  if (!wanted) return null;
  const exact = batchImageFiles.filter(f => normalizePath(f.webkitRelativePath || f.name).endsWith(wanted));
  if (exact.length === 1) return exact[0];
  const base = wanted.split("/").pop();
  const byBase = batchImageFiles.filter(f => f.name.toLowerCase() === base);
  return byBase.length === 1 ? byBase[0] : null;
}

async function runBatch() {
  if (!batchRows.length) return;
  const btn = $("batchBtn");
  btn.disabled = true;
  try {
    ensureJsZip();
    const zip = new JSZip();
    let done = 0;
    let failed = 0;
    for (let i = 0; i < batchRows.length; i++) {
      const item = batchRows[i];
      const r = item.row;
      try {
        setBatchStatus(`${i + 1} / ${batchRows.length} 생성 중 · ${r["이름"] || ""}`);
        const grade = String(r["등급"] || $("templateSelect").value).trim();
        const tpl = templates.get(grade);
        if (!tpl) throw new Error(`등록되지 않은 등급: ${grade}`);
        const image = findBatchImage(r["이미지명"]);
        if (!image) throw new Error(`이미지를 찾을 수 없음: ${r["이미지명"]}`);
        const name = String(r["이름"] || "").trim();
        if (!name) throw new Error("이름이 비어 있음");
        const team = String(r["구단"] || "").trim();
        if (team && !tpl.team_logos?.[team]) throw new Error(`등록되지 않은 구단: ${team}`);
        const displayName = name;
        const buffer = await image.arrayBuffer();
        await callWorker("setPhoto", { buffer }, [buffer]);
        const current = collectControls();
        const params = paramsForRender({
          team_name: team,
          season: String(r["시즌"] || "").trim(),
          display_name: displayName,
          position: String(r["포지션"] || "").trim(),
          focus_x: current.focus_x,
          focus_y: current.focus_y,
          zoom: current.zoom,
        });
        params.extra.gradient_profile = tpl.gradient_profile || {};
        await callWorker("ensureAssets", { paths: assetsFor(tpl, team) });
        const result = await callWorker("render", { template: tpl, params, width: 800, height: 1200 });
        const fallback = [name, grade].filter(Boolean).join("_") + ".png";
        const filename = sanitizeFilename(String(r["저장파일명"] || "").trim(), fallback);
        zip.file(filename, base64ToUint8(result.base64));
        item.state = "done";
        item.message = "완료";
        done++;
      } catch (error) {
        item.state = "error";
        item.message = error.message;
        failed++;
      }
      renderBatchTable();
    }
    if (!done) throw new Error("성공한 카드가 없습니다.");
    const out = await zip.generateAsync({ type: "blob", compression: "DEFLATE", compressionOptions: { level: 6 } });
    downloadBlob(out, `츠키카드_일괄생성_${new Date().toISOString().slice(0,10)}.zip`);
    setBatchStatus(`완료: ${done}개 성공${failed ? ` · ${failed}개 실패` : ""}. ZIP을 다운로드했습니다.`, failed > 0, failed === 0);
  } catch (error) {
    setBatchStatus(`일괄 생성 실패: ${error.message}`, true);
  } finally {
    btn.disabled = false;
    if (currentWorkingBlob) {
      try { await setWorkingPhoto(currentWorkingBlob, $("previewHint").textContent); } catch (_) {}
    }
  }
}

async function init() {
  try {
    await registerModelCacheWorker();
    setStatus("템플릿과 Python 실행 환경을 준비하고 있습니다.");
    await loadTemplates();
    staticDefaults = await loadJson("./config/baseball_defaults.json");
    styleFromTemplate(true);
    populateTeams(staticDefaults.team_name);
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
    applyControls(saved || {
      grade: "오팔",
      team_name: staticDefaults.team_name,
      season: staticDefaults.top_right_text,
      name: "츠키",
      position: staticDefaults.position_text,
      focus_x: 50,
      focus_y: 50,
      zoom: 100,
      subject_glow: true,
      ...staticDefaults,
    });
    saveDirectoryHandle = await loadSaveDirectoryHandle();
    updateSavePathStatus();
    bindInputs();
    renderExcelDataHead();
    renderExcelDataBody();
    restoreExcelProgressState();
    await callWorker("init");
    runtimeReady = true;
    runtimeBadge.textContent = "Python 준비 완료";
    runtimeBadge.className = "badge ready";
    setStatus("준비 완료. 피사체 이미지를 선택하세요.", false, true);
  } catch (error) {
    console.error(error);
    runtimeBadge.textContent = "초기화 실패";
    runtimeBadge.className = "badge error";
    setStatus(`초기화 실패: ${error.message}. 이 페이지는 반드시 http:// 또는 https://로 열어야 합니다.`, true);
  }
}

init();
