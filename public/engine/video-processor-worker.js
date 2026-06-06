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

// Clamped separable box blur of an RGBA buffer (small region; used to dissolve
// any thin residual watermark outline).
function boxBlurRGBA(src, width, height, radius) {
  const tmp = new Float32Array(width * height * 3);
  const out = new Uint8ClampedArray(src.length);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let r = 0, g = 0, b = 0, c = 0;
      for (let dx = -radius; dx <= radius; dx += 1) {
        const xx = x + dx; if (xx < 0 || xx >= width) continue;
        const o = (y * width + xx) * 4; r += src[o]; g += src[o + 1]; b += src[o + 2]; c += 1;
      }
      const t = (y * width + x) * 3; tmp[t] = r / c; tmp[t + 1] = g / c; tmp[t + 2] = b / c;
    }
  }
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let r = 0, g = 0, b = 0, c = 0;
      for (let dy = -radius; dy <= radius; dy += 1) {
        const yy = y + dy; if (yy < 0 || yy >= height) continue;
        const t = (yy * width + x) * 3; r += tmp[t]; g += tmp[t + 1]; b += tmp[t + 2]; c += 1;
      }
      const o = (y * width + x) * 4; out[o] = r / c; out[o + 1] = g / c; out[o + 2] = b / c; out[o + 3] = 255;
    }
  }
  return out;
}

function smooth01(t, a, b) {
  t = Math.max(0, Math.min(1, (t - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

// Blur away the watermark region (logo body + tips) and feather it into the
// surrounding margin so there is no seam. Centred on the logo; fully blurred out
// to just past the tips (rFull), then fades to the original by rEnd (in margin).
function softenCrop(data, width, height, cx, cy, wmRadius) {
  const blurRadius = Math.max(3, Math.round(wmRadius / 3.5));
  const blurred = boxBlurRGBA(data, width, height, blurRadius);
  const rFull = wmRadius * 1.08;
  const rEnd = wmRadius * 1.85;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const dist = Math.hypot(x - cx, y - cy);
      let m;
      if (dist <= rFull) m = 1;
      else if (dist >= rEnd) m = 0;
      else m = 1 - smooth01(dist, rFull, rEnd);
      if (m <= 0.002) continue;
      const off = (y * width + x) * 4;
      data[off] = clamp(data[off] * (1 - m) + blurred[off] * m);
      data[off + 1] = clamp(data[off + 1] * (1 - m) + blurred[off + 1] * m);
      data[off + 2] = clamp(data[off + 2] * (1 - m) + blurred[off + 2] * m);
    }
  }
}

// Process one expanded crop: reverse-alpha + outline repair on the inner
// (aligned) logo region, then a radial blur that dissolves the logo and feathers
// into the margin (eliminates the residual outline/tips on smooth backgrounds).
function processCrop(data, cropW, cropH, innerX, innerY, innerW, innerH, intensity, outlineWidth, inpaintRadius) {
  const inner = new Uint8ClampedArray(innerW * innerH * 4);
  for (let iy = 0; iy < innerH; iy += 1) {
    for (let ix = 0; ix < innerW; ix += 1) {
      const s = ((innerY + iy) * cropW + (innerX + ix)) * 4;
      const dst = (iy * innerW + ix) * 4;
      inner[dst] = data[s]; inner[dst + 1] = data[s + 1]; inner[dst + 2] = data[s + 2]; inner[dst + 3] = data[s + 3];
    }
  }
  removeWatermarkFromData(inner, innerW, innerH, intensity, outlineWidth, inpaintRadius);
  for (let iy = 0; iy < innerH; iy += 1) {
    for (let ix = 0; ix < innerW; ix += 1) {
      const dst = ((innerY + iy) * cropW + (innerX + ix)) * 4;
      const s = (iy * innerW + ix) * 4;
      data[dst] = inner[s]; data[dst + 1] = inner[s + 1]; data[dst + 2] = inner[s + 2];
    }
  }
  softenCrop(data, cropW, cropH, innerX + innerW / 2, innerY + innerH / 2, Math.max(innerW, innerH) / 2);
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
  let { innerX, innerY, innerW, innerH } = event.data;
  if (!innerW || !innerH) { innerX = 0; innerY = 0; innerW = w; innerH = h; }

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
    processCrop(imageData.data, w, h, innerX, innerY, innerW, innerH, intensity, outlineWidth, inpaintRadius);
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
