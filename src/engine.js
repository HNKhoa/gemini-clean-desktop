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
  const result = await processVideoWatermarkMp4(file, ({ progress, currentFrame, totalFrames, speedFps, warning }) => {
    const info = currentFrame && totalFrames
      ? `${currentFrame}/${totalFrames}${speedFps ? ` · ${speedFps.toFixed(1)}fps` : ''}`
      : (warning || '');
    onProgress(Math.max(0.02, Math.min(0.98, (progress || 0) / 100)), info);
  }, signal, { maxOutputDimension });
  return {
    blob: result.blob,
    name: result.filename || `clean_${baseName(file.name)}.mp4`,
    kind: 'video',
    applied: true,
    warning: result.meta?.warning || '',
  };
}

export async function saveToDisk(blob, name, kind) {
  const fd = new FormData();
  fd.append('file', blob, name);
  fd.append('name', name);
  fd.append('kind', kind);
  const res = await fetch('/api/save', { method: 'POST', body: fd });
  if (!res.ok) throw new Error('save failed: HTTP ' + res.status);
  return res.json();
}
