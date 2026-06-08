// Thin wrapper around the validated watermark engine.
//
// The engine lives in /engine (served from public/ in dev, from dist/ in prod)
// and is loaded as RAW ES modules at runtime — NOT bundled by Vite — so the
// proven extension engine is reused unchanged. The /* @vite-ignore */ keeps
// Vite from trying to resolve these absolute runtime URLs at build time.

let sdkP = null;
let engineP = null;
let videoP = null;

// Use variables (not string literals) so Rollup/Vite cannot statically resolve
// these at build time — they must stay runtime imports of files served from
// /engine (public/ in dev, dist/ in prod).
const SDK_URL = '/engine/vendor/gwr/sdk/image-data.js';
const VIDEO_SERVICE_URL = '/engine/video-mp4-service.js';
const ALPHA_URL = '/engine/vendor/gwr/core/embeddedAlphaMaps.js';
const BLEND_URL = '/engine/vendor/gwr/core/blendModes.js';
const METRICS_URL = '/engine/vendor/gwr/core/restorationMetrics.js';
const ADAPTIVE_URL = '/engine/vendor/gwr/core/adaptiveDetector.js';

let alphaP = null;
let calibP = null;

export function getSdk() {
  if (!sdkP) sdkP = import(/* @vite-ignore */ SDK_URL);
  return sdkP;
}
export async function getEngine() {
  const sdk = await getSdk();
  if (!engineP) engineP = sdk.createWatermarkEngine();
  return engineP;
}
export function getVideoService() {
  if (!videoP) videoP = import(/* @vite-ignore */ VIDEO_SERVICE_URL);
  return videoP;
}
function getAlphaModule() {
  if (!alphaP) alphaP = import(/* @vite-ignore */ ALPHA_URL);
  return alphaP;
}

// Lazy-load the proven engine routines used for per-video gain calibration.
function getCalibModules() {
  if (!calibP) {
    calibP = Promise.all([
      import(/* @vite-ignore */ BLEND_URL),
      import(/* @vite-ignore */ METRICS_URL),
      import(/* @vite-ignore */ ADAPTIVE_URL),
      getAlphaModule(),
    ]).then(([blend, metrics, adaptive, alpha]) => ({
      removeWatermark: blend.removeWatermark,
      scoreRegion: metrics.scoreRegion,
      calculateNearBlackRatio: metrics.calculateNearBlackRatio,
      interpolateAlphaMap: adaptive.interpolateAlphaMap,
      getEmbeddedAlphaMap: alpha.getEmbeddedAlphaMap,
    }));
  }
  return calibP;
}

// ── Video watermark auto-detection ──────────────────────────────────────────
// The Gemini "✦" watermark sits at different spots depending on video format,
// so the fixed bottom-right preset misses it. We grab one frame and locate the
// sparkle by template-matching its alpha map (NCC) against the frame luminance.

async function grabVideoFrame(file, timeFrac = 0.5) {
  const url = URL.createObjectURL(file);
  const video = document.createElement('video');
  video.muted = true;
  video.preload = 'auto';
  video.playsInline = true;
  try {
    video.src = url;
    await new Promise((res, rej) => {
      const to = setTimeout(() => rej(new Error('video load timeout')), 15000);
      video.onloadeddata = () => { clearTimeout(to); res(); };
      video.onerror = () => { clearTimeout(to); rej(new Error('video load error')); };
    });
    const dur = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 1;
    const t = Math.min(Math.max(0.1, dur * timeFrac), Math.max(0.1, dur - 0.05));
    await new Promise((res, rej) => {
      const to = setTimeout(() => rej(new Error('seek timeout')), 10000);
      video.onseeked = () => { clearTimeout(to); res(); };
      video.onerror = () => { clearTimeout(to); rej(new Error('seek error')); };
      video.currentTime = t;
    });
    const w = video.videoWidth, h = video.videoHeight;
    if (!w || !h) throw new Error('no video dimensions');
    const off = new OffscreenCanvas(w, h);
    const ctx = off.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(video, 0, 0, w, h);
    return ctx.getImageData(0, 0, w, h);
  } finally {
    video.src = '';
    try { video.load(); } catch (_) { /* ignore */ }
    URL.revokeObjectURL(url);
  }
}

// NCC template-match of the sparkle alpha map against frame luminance.
function locateSparkle(imageData, alpha96) {
  const { width: W, height: H, data } = imageData;
  const longSide = Math.max(W, H);
  const scale = Math.min(1, 440 / longSide); // coarse working resolution
  const ww = Math.max(8, Math.round(W * scale));
  const hh = Math.max(8, Math.round(H * scale));

  // Downscaled luminance
  const L = new Float32Array(ww * hh);
  for (let y = 0; y < hh; y++) {
    const sy = Math.min(H - 1, Math.floor(y / scale));
    for (let x = 0; x < ww; x++) {
      const sx = Math.min(W - 1, Math.floor(x / scale));
      const o = (sy * W + sx) * 4;
      L[y * ww + x] = 0.299 * data[o] + 0.587 * data[o + 1] + 0.114 * data[o + 2];
    }
  }

  const minDim = Math.min(W, H);
  const srcSizes = [0.035, 0.045, 0.055, 0.065, 0.08]
    .map((f) => Math.round(f * minDim))
    .filter((s) => s >= 24);

  let best = { score: -2, x: 0, y: 0, size: 0 };
  for (const srcSize of srcSizes) {
    const ts = Math.max(8, Math.round(srcSize * scale));
    if (ts >= ww || ts >= hh) continue;
    // Build downscaled alpha template + its stats.
    const tmpl = new Float32Array(ts * ts);
    let tsum = 0;
    for (let ty = 0; ty < ts; ty++) {
      const ay = Math.min(95, Math.floor((ty / ts) * 96));
      for (let tx = 0; tx < ts; tx++) {
        const ax = Math.min(95, Math.floor((tx / ts) * 96));
        const v = alpha96[ay * 96 + ax] || 0;
        tmpl[ty * ts + tx] = v;
        tsum += v;
      }
    }
    const tmean = tsum / (ts * ts);
    let tden = 0;
    for (let i = 0; i < ts * ts; i++) { const d = tmpl[i] - tmean; tden += d * d; }
    tden = Math.sqrt(tden) || 1e-6;

    const step = Math.max(1, Math.round(ts / 5));
    for (let y = 0; y <= hh - ts; y += step) {
      for (let x = 0; x <= ww - ts; x += step) {
        let rsum = 0;
        for (let ty = 0; ty < ts; ty++) {
          const ro = (y + ty) * ww + x;
          for (let tx = 0; tx < ts; tx++) rsum += L[ro + tx];
        }
        const rmean = rsum / (ts * ts);
        let num = 0, rden = 0;
        for (let ty = 0; ty < ts; ty++) {
          const ro = (y + ty) * ww + x;
          for (let tx = 0; tx < ts; tx++) {
            const lv = L[ro + tx] - rmean;
            num += lv * (tmpl[ty * ts + tx] - tmean);
            rden += lv * lv;
          }
        }
        const ncc = num / (tden * (Math.sqrt(rden) || 1e-6));
        if (ncc > best.score) best = { score: ncc, x, y, size: ts };
      }
    }
  }

  if (best.score < 0.42) return null; // not confident enough
  const inv = 1 / scale;
  let x = Math.round(best.x * inv);
  let y = Math.round(best.y * inv);
  let s = Math.round(best.size * inv);
  // clamp inside the frame
  s = Math.min(s, W - x, H - y);
  if (s < 16) return null;
  return { x, y, w: s, h: s, score: +best.score.toFixed(3) };
}

export async function detectVideoWatermarkBox(file) {
  try {
    const alpha96 = (await getAlphaModule()).getEmbeddedAlphaMap(96);
    if (!alpha96) return null;

    // Average several frames. A moving/animated background blurs out in the
    // average, while the STATIC watermark stays sharp — so NCC locks onto it even
    // on busy backgrounds (e.g. animated gradients). Accumulate incrementally to
    // keep memory bounded.
    const fracs = [0.12, 0.24, 0.36, 0.48, 0.6, 0.72, 0.84, 0.96];
    let sum = null, W = 0, H = 0, n = 0;
    for (const f of fracs) {
      let frame;
      try { frame = await grabVideoFrame(file, f); } catch (_) { continue; }
      if (!sum) { W = frame.width; H = frame.height; sum = new Float32Array(W * H * 4); }
      else if (frame.width !== W || frame.height !== H) continue;
      const d = frame.data;
      for (let i = 0; i < sum.length; i += 1) sum[i] += d[i];
      n += 1;
    }
    if (!n) return null;

    const avg = new Uint8ClampedArray(sum.length);
    for (let i = 0; i < avg.length; i += 1) avg[i] = sum[i] / n;
    let best = locateSparkle({ width: W, height: H, data: avg }, alpha96);

    // Fallback to a single mid frame if the average didn't yield a hit.
    if (!best) {
      try { best = locateSparkle(await grabVideoFrame(file, 0.5), alpha96); } catch (_) { /* ignore */ }
    }

    if (best) console.log('[engine] watermark detected at', best, '(frames averaged:', n, ')');
    else console.log('[engine] watermark not auto-detected; using preset');
    return best;
  } catch (e) {
    console.warn('[engine] watermark detection failed:', e);
    return null;
  }
}

// Measure the watermark's real opacity for THIS video by sweeping the reverse-alpha
// gain (including values < 1) and picking the one that best nulls the residual at the
// logo. Opacity varies by clip/compression, so a fixed strength leaves a bright trace
// (gain too low) or a dark ghost (gain too high). Runs once per video on one frame.
export async function calibrateVideoGain(file, box) {
  try {
    if (!box || !(box.w > 0)) return null;
    const eng = await getCalibModules();
    const frame = await grabVideoFrame(file, 0.5);
    const size = Math.round(box.w);
    const bx = Math.round(box.x), by = Math.round(box.y);
    if (bx < 0 || by < 0 || bx + size > frame.width || by + size > frame.height) return null;
    // Extract the logo region into its own buffer.
    const inner = new Uint8ClampedArray(size * size * 4);
    const { width: FW, data } = frame;
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        const s = ((by + y) * FW + (bx + x)) * 4;
        const d = (y * size + x) * 4;
        inner[d] = data[s]; inner[d + 1] = data[s + 1]; inner[d + 2] = data[s + 2]; inner[d + 3] = 255;
      }
    }
    const alpha = eng.interpolateAlphaMap(eng.getEmbeddedAlphaMap(96), 96, size);
    const pos = { x: 0, y: 0, width: size, height: size };
    const baseNB = eng.calculateNearBlackRatio({ width: size, height: size, data: inner }, pos);
    let best = { gain: 0.62, residual: Infinity };
    for (let g = 0.30; g <= 2.21; g += 0.05) {
      const gain = Math.round(g * 100) / 100;
      const img = { width: size, height: size, data: new Uint8ClampedArray(inner) };
      eng.removeWatermark(img, alpha, pos, { alphaGain: gain });
      // Reject gains that crush the region toward black (over-removal artefact).
      if (eng.calculateNearBlackRatio(img, pos) > baseNB + 0.06) continue;
      const residual = Math.abs(eng.scoreRegion(img, alpha, pos).spatialScore);
      if (residual < best.residual) best = { gain, residual };
    }
    console.log('[engine] calibrated removal gain', best.gain, 'residual', best.residual.toFixed(3));
    return best.gain;
  } catch (e) {
    console.warn('[engine] gain calibration failed:', e);
    return null;
  }
}

const IMG_MIME = new Set(['image/png', 'image/jpeg', 'image/webp']);

export function classifyMediaFile(file) {
  if (/^image\/(png|jpeg|webp)$/.test(file.type)) return 'image';
  if (/^video\/(mp4|quicktime)$/.test(file.type) || /\.(mp4|mov|m4v)$/i.test(file.name)) return 'video';
  return null;
}

export function baseName(name) {
  return (name || 'image').replace(/\.[^.]+$/, '').replace(/[^\w.-]+/g, '_') || 'image';
}

function pickImageFormat(file) {
  const t = file && IMG_MIME.has(file.type) ? file.type : 'image/png';
  if (t === 'image/jpeg') return { mime: t, ext: 'jpg', quality: 0.96 };
  if (t === 'image/webp') return { mime: t, ext: 'webp', quality: 0.98 };
  return { mime: 'image/png', ext: 'png', quality: undefined };
}

async function decodeToImageData(blob) {
  const bitmap = await createImageBitmap(blob);
  const { width: w, height: h } = bitmap;
  if (!w || !h) { bitmap.close?.(); throw new Error('Image size is 0'); }
  const off = new OffscreenCanvas(w, h);
  const ctx = off.getContext('2d');
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close?.();
  return ctx.getImageData(0, 0, w, h);
}

async function removeImageWatermark(imageData) {
  const sdk = await getSdk();
  const engine = await getEngine();
  const r = await sdk.removeWatermarkFromImageData(imageData, {
    engine, enableMultiPass: true, enableCleanup: true,
  });
  return { imageData: r?.imageData || imageData, applied: !!r?.meta?.applied };
}

function imageDataToBlob(imageData, mime, quality) {
  const c = document.createElement('canvas');
  c.width = imageData.width;
  c.height = imageData.height;
  c.getContext('2d').putImageData(imageData, 0, 0);
  return new Promise((res, rej) =>
    c.toBlob((b) => (b ? res(b) : rej(new Error('encode failed'))), mime, quality));
}

export async function processImage(file) {
  const src = await decodeToImageData(file);
  let out = src;
  let applied = false;
  try {
    const r = await removeImageWatermark(src);
    out = r.imageData;
    applied = r.applied;
  } catch (e) {
    console.warn('[engine] image removal failed, keeping original:', e);
  }
  const fmt = pickImageFormat(file);
  const blob = await imageDataToBlob(out, fmt.mime, fmt.quality);
  return { blob, name: `clean_${baseName(file.name)}.${fmt.ext}`, kind: 'image', applied };
}

export async function processVideo(file, onProgress, signal, maxOutputDimension = 1920) {
  const { processVideoWatermarkMp4 } = await getVideoService();
  // Locate the watermark first (so removal targets the real position, not a preset).
  onProgress(0.02, 'Đang dò watermark…');
  const watermarkBox = await detectVideoWatermarkBox(file).catch(() => null);
  // Calibrate the removal strength to this video's actual watermark opacity.
  const gain = watermarkBox ? await calibrateVideoGain(file, watermarkBox).catch(() => null) : null;
  const result = await processVideoWatermarkMp4(file, ({ progress, currentFrame, totalFrames, speedFps, warning }) => {
    const info = currentFrame && totalFrames
      ? `${currentFrame}/${totalFrames}${speedFps ? ` · ${speedFps.toFixed(1)}fps` : ''}`
      : (warning || '');
    onProgress(Math.max(0.02, Math.min(0.98, (progress || 0) / 100)), info);
  }, signal, { maxOutputDimension, watermarkBox, gain });
  return {
    blob: result.blob,
    name: result.filename || `clean_${baseName(file.name)}.mp4`,
    kind: 'video',
    applied: true,
    warning: result.meta?.warning || '',
  };
}

// Every /api/* call must carry this header. The backend rejects /api requests
// without it, which blocks cross-site (CSRF) calls from any web page: a
// cross-origin request that carries a custom header forces a CORS preflight the
// backend denies, and one without the header is refused before any side effect.
// Same-origin renderer calls pass through.
export const API_HEADER = { 'X-GCD': '1' };
export function apiFetch(url, options = {}) {
  return fetch(url, { ...options, headers: { ...(options.headers || {}), ...API_HEADER } });
}

// AI (LaMa) video path: the backend does the heavy work (decode → inpaint → encode)
// and saves the result itself, so this uploads the original, polls progress, and
// returns the saved path. Much cleaner on patterned/coloured backgrounds, but slow.
export async function processVideoAI(file, onProgress, signal) {
  onProgress(0.02, 'Tải lên…');
  const fd = new FormData();
  fd.append('file', file, file.name);
  fd.append('name', file.name);
  const res = await apiFetch('/api/process-video-ai', { method: 'POST', body: fd });
  if (!res.ok) throw new Error('AI start failed: HTTP ' + res.status);
  const { job_id } = await res.json();
  if (!job_id) throw new Error('AI job not created');
  // Tell the backend to stop too (it runs in a worker thread) — otherwise "Stop"
  // would only end the UI wait while the backend kept churning and saved a file.
  const cancelJob = () => apiFetch('/api/ai-cancel/' + job_id, { method: 'POST' }).catch(() => {});
  for (;;) {
    if (signal?.aborted) { cancelJob(); throw new Error('Cancelled'); }
    await new Promise((r) => setTimeout(r, 1000));
    if (signal?.aborted) { cancelJob(); throw new Error('Cancelled'); }
    const jr = await apiFetch('/api/ai-job/' + job_id);
    if (!jr.ok) throw new Error('AI job lost');
    const j = await jr.json();
    const stage = j.stage === 'download' ? 'Tải model AI' : j.stage === 'encode' ? 'Xuất video' : 'AI xử lý';
    const info = j.total ? `${stage} ${j.frame || 0}/${j.total}` : stage + '…';
    onProgress(Math.max(0.02, Math.min(0.98, j.progress || 0.02)), info);
    if (j.status === 'done') return { path: j.path, name: j.name, kind: 'video', applied: true };
    if (j.status === 'cancelled') throw new Error('Cancelled');
    if (j.status === 'error') throw new Error(j.error || 'AI thất bại');
  }
}

export function getAiStatus() {
  return apiFetch('/api/ai-status').then((r) => r.json()).catch(() => ({}));
}

export function getWmStatus() {
  return apiFetch('/api/wm-status').then((r) => r.json()).catch(() => ({}));
}

// Add a watermark (visible overlay + optional hidden payload) to a video. The
// backend renders + re-encodes and saves the result; this uploads + polls.
export async function addWatermark(file, logoFile, opts, onProgress, signal) {
  onProgress(0.05, 'Tải lên…');
  const fd = new FormData();
  fd.append('file', file, file.name);
  fd.append('name', file.name);
  Object.entries(opts || {}).forEach(([k, v]) => fd.append(k, v == null ? '' : String(v)));
  if (logoFile) fd.append('logo', logoFile, logoFile.name);
  const res = await apiFetch('/api/add-watermark', { method: 'POST', body: fd });
  if (!res.ok) throw new Error('Thêm watermark thất bại: HTTP ' + res.status);
  const { job_id } = await res.json();
  if (!job_id) throw new Error('Không tạo được job');
  const cancelJob = () => apiFetch('/api/wm-cancel/' + job_id, { method: 'POST' }).catch(() => {});
  for (;;) {
    if (signal?.aborted) { cancelJob(); throw new Error('Cancelled'); }
    await new Promise((r) => setTimeout(r, 800));
    if (signal?.aborted) { cancelJob(); throw new Error('Cancelled'); }
    const jr = await apiFetch('/api/wm-job/' + job_id);
    if (!jr.ok) throw new Error('Mất job');
    const j = await jr.json();
    onProgress(Math.max(0.05, Math.min(0.95, j.progress || 0.3)), 'Đang thêm watermark…');
    if (j.status === 'done') return { path: j.path, name: j.name };
    if (j.status === 'cancelled') throw new Error('Cancelled');
    if (j.status === 'error') throw new Error(j.error || 'Thất bại');
  }
}

export async function saveToDisk(blob, name, kind) {
  const fd = new FormData();
  fd.append('file', blob, name);
  fd.append('name', name);
  fd.append('kind', kind);
  const res = await apiFetch('/api/save', { method: 'POST', body: fd });
  if (!res.ok) throw new Error('save failed: HTTP ' + res.status);
  return res.json();
}
