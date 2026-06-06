import { getEmbeddedAlphaMap } from './vendor/gwr/core/embeddedAlphaMaps.js';

const ALPHA_MAX = 0.50588235;
let offscreenCanvas = null;
let offscreenCtx = null;
const alphaCache = new Map();

function interpolateAlphaMap(source, sourceSize, width, height) {
  const result = new Float32Array(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const srcX = width > 1 ? (x / (width - 1)) * (sourceSize - 1) : 0;
      const srcY = height > 1 ? (y / (height - 1)) * (sourceSize - 1) : 0;
      const x1 = Math.floor(srcX);
      const y1 = Math.floor(srcY);
      const x2 = Math.min(sourceSize - 1, x1 + 1);
      const y2 = Math.min(sourceSize - 1, y1 + 1);
      const wx = srcX - x1;
      const wy = srcY - y1;
      const v11 = source[y1 * sourceSize + x1];
      const v12 = source[y1 * sourceSize + x2];
      const v21 = source[y2 * sourceSize + x1];
      const v22 = source[y2 * sourceSize + x2];
      result[y * width + x] = (1 - wx) * (1 - wy) * v11 + wx * (1 - wy) * v12 + (1 - wx) * wy * v21 + wx * wy * v22;
    }
  }
  return result;
}

function getAlphaMap(size) {
  if (alphaCache.has(size)) return alphaCache.get(size);
  let source = null;
  let sourceSize = 48;
  if (size > 48) {
    source = getEmbeddedAlphaMap(96);
    sourceSize = 96;
  } else {
    source = getEmbeddedAlphaMap(48);
    sourceSize = 48;
  }
  if (!source) throw new Error('Alpha map unavailable.');
  const result = sourceSize === size ? source : interpolateAlphaMap(source, sourceSize, size, size);
  alphaCache.set(size, result);
  return result;
}

function clamp(value) {
  return Math.max(0, Math.min(255, Math.round(value)));
}

function getVideoReverseAlpha(rawAlpha, intensity) {
  const edgeStart = 0.16;
  const edgeEnd = 0.36;
  const t = Math.max(0, Math.min(1, (rawAlpha - edgeStart) / (edgeEnd - edgeStart)));
  const smooth = t * t * (3 - 2 * t);
  const featherBoost = 1.34 - 0.34 * smooth;
  return rawAlpha * intensity * featherBoost;
}

function buildRepairMask(alphaMap, width, height, outlineWidth) {
  const mask = new Uint8Array(width * height);
  const blend = new Float32Array(width * height);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const idx = y * width + x;
      const rawAlpha = alphaMap[idx] || 0;
      let maxDelta = 0;
      let touchesSilhouette = false;
      let fullyInside = true;

      for (let dy = -outlineWidth; dy <= outlineWidth; dy += 1) {
        for (let dx = -outlineWidth; dx <= outlineWidth; dx += 1) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || nx >= width || ny < 0 || ny >= height) {
            fullyInside = false;
            continue;
          }
          const nAlpha = alphaMap[ny * width + nx] || 0;
          if (nAlpha > 0.02) touchesSilhouette = true;
          else fullyInside = false;
          maxDelta = Math.max(maxDelta, Math.abs(rawAlpha - nAlpha));
        }
      }

      const outline = touchesSilhouette && !fullyInside;
      const softFeather = rawAlpha > 0.035 && rawAlpha < 0.30 && maxDelta > 0.018;
      if (!outline && !softFeather) continue;

      mask[idx] = 1;
      if (rawAlpha > 0.34) blend[idx] = 0.58;
      else if (rawAlpha > 0.24) blend[idx] = 0.78;
      else if (softFeather) {
        const alphaWeight = 1 - Math.min(1, Math.max(0, (rawAlpha - 0.035) / 0.265));
        const gradientWeight = Math.min(1, maxDelta / 0.08);
        blend[idx] = 0.36 + 0.32 * Math.max(alphaWeight, gradientWeight);
      } else {
        blend[idx] = 1;
      }
    }
  }

  return { mask, blend };
}

function repairOutline(data, alphaMap, width, height, outlineWidth, inpaintRadius) {
  const { mask, blend } = buildRepairMask(alphaMap, width, height, outlineWidth);
  const source = new Uint8ClampedArray(data);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const idx = y * width + x;
      if (!mask[idx]) continue;

      let r = 0;
      let g = 0;
      let b = 0;
      let weight = 0;
      for (let dy = -inpaintRadius; dy <= inpaintRadius; dy += 1) {
        for (let dx = -inpaintRadius; dx <= inpaintRadius; dx += 1) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
          const nIdx = ny * width + nx;
          if (mask[nIdx] || (alphaMap[nIdx] || 0) > 0.035) continue;
          const dist2 = dx * dx + dy * dy;
          if (dist2 === 0 || dist2 > inpaintRadius * inpaintRadius) continue;
          const w = 1 / dist2;
          const off = nIdx * 4;
          r += source[off] * w;
          g += source[off + 1] * w;
          b += source[off + 2] * w;
          weight += w;
        }
      }
      if (weight > 0) {
        const off = idx * 4;
        const mix = blend[idx] || 0.6;
        data[off] = clamp(data[off] * (1 - mix) + (r / weight) * mix);
        data[off + 1] = clamp(data[off + 1] * (1 - mix) + (g / weight) * mix);
        data[off + 2] = clamp(data[off + 2] * (1 - mix) + (b / weight) * mix);
      }
    }
  }
}

function removeWatermarkFromData(data, width, height, intensity, outlineWidth, inpaintRadius) {
  const alphaMap = getAlphaMap(width);
  const original = new Uint8ClampedArray(data);
  const logoValue = 255;

  for (let idx = 0; idx < width * height; idx += 1) {
    const off = idx * 4;
    const rawAlpha = alphaMap[idx] || 0;
    if (rawAlpha <= 0.000001) continue;
    const alpha = Math.min(getVideoReverseAlpha(rawAlpha, intensity), 0.99);
    const oneMinusAlpha = 1 - alpha;
    data[off] = clamp((original[off] - alpha * logoValue) / oneMinusAlpha);
    data[off + 1] = clamp((original[off + 1] - alpha * logoValue) / oneMinusAlpha);
    data[off + 2] = clamp((original[off + 2] - alpha * logoValue) / oneMinusAlpha);
  }

  repairOutline(data, alphaMap, width, height, outlineWidth, inpaintRadius);
}

if (typeof self !== 'undefined') {
self.onmessage = async (event) => {
  const { id, frameBitmap, x, y, w, h, intensity, outlineWidth, inpaintRadius } = event.data;

  if (!offscreenCanvas || offscreenCanvas.width !== w || offscreenCanvas.height !== h) {
    offscreenCanvas = new OffscreenCanvas(w, h);
    offscreenCtx = offscreenCanvas.getContext('2d', { willReadFrequently: true });
  }

  let finalBitmap = null;
  try {
    offscreenCtx.clearRect(0, 0, w, h);
    if (frameBitmap.width === w && frameBitmap.height === h) {
      offscreenCtx.drawImage(frameBitmap, 0, 0, w, h);
    } else {
      offscreenCtx.drawImage(frameBitmap, x, y, w, h, 0, 0, w, h);
    }
    const imageData = offscreenCtx.getImageData(0, 0, w, h);
    removeWatermarkFromData(imageData.data, w, h, intensity, outlineWidth, inpaintRadius);
    offscreenCtx.putImageData(imageData, 0, 0);
    finalBitmap = await createImageBitmap(offscreenCanvas);
    self.postMessage({ id, processedBox: finalBitmap }, [finalBitmap]);
  } catch (error) {
    self.postMessage({ id, error: error?.message || String(error) });
  } finally {
    frameBitmap.close?.();
  }
};
}
