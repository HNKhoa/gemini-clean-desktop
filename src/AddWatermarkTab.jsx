import React, { useState, useRef, useEffect, useCallback } from 'react';
import {
  Box, Paper, Stack, Typography, Button, IconButton, Tooltip, TextField, Select, MenuItem,
  FormControl, InputLabel, Slider, Switch, FormControlLabel, LinearProgress, Chip, Divider, Collapse,
} from '@mui/material';
import MovieIcon from '@mui/icons-material/Movie';
import ImageIcon from '@mui/icons-material/Image';
import AutoFixHighIcon from '@mui/icons-material/AutoFixHigh';
import StopIcon from '@mui/icons-material/Stop';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import ErrorIcon from '@mui/icons-material/Error';
import RestartAltIcon from '@mui/icons-material/RestartAlt';
import FolderOpenIcon from '@mui/icons-material/FolderOpen';
import { apiFetch, addWatermark, getWmStatus, grabPreviewFrame } from './engine.js';

const isVideo = (f) => /^video\/(mp4|quicktime)$/.test(f.type) || /\.(mp4|mov|m4v)$/i.test(f.name);

// Must match geometry.compute_xy default margin in backend/watermark/geometry.py.
const MARGIN = 24;
const HANDLE = 14; // resize-handle hit radius (display px)
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const snap = (v, step) => Math.round(v / step) * step;

// Brand placement/style templates. Positions are based on web research of each
// platform's real on-video watermark (corner + motion); see each `note`. Text
// stays editable (e.g. TikTok's @username). For brands whose mark MOVES
// (Veo/Sora/TikTok) the corner is just the resting/start point — motion drives it.
const BRANDS = [
  { id: 'veo', label: 'Veo', text: 'Veo', position: 'bottom-right', motion: 'random', sparkle: false, glow: false, shadow: false, color: 'white', opacity: 0.9, fontsize: 0.04,
    note: 'Veo 3: chữ "veo" mờ, NHẢY giữa các góc & giữa khung để chống cắt (gốc ở dưới-phải). Nguồn: hỗ trợ Google, BGR, Berkeley iSchool.' },
  { id: 'sora', label: 'Sora', text: 'Sora', position: 'bottom-right', motion: 'bounce', sparkle: false, glow: false, shadow: true, color: 'white', opacity: 0.9, fontsize: 0.05,
    note: 'Sora 2: logo đám mây + chữ, NẢY quanh góc dưới-phải để chống xoá 1 khung. Nguồn: OpenAI, đánh giá Sora 2.' },
  { id: 'capcut', label: 'CapCut', text: 'CapCut', position: 'bottom-right', motion: 'none', sparkle: false, glow: false, shadow: true, color: 'white', opacity: 0.92, fontsize: 0.05,
    note: 'CapCut: chữ trắng CapCut tĩnh (watermark chính là clip cuối video). Nguồn: capcut.com & nhiều hướng dẫn.' },
  { id: 'tiktok', label: 'TikTok', text: '@username', position: 'bottom-right', motion: 'bounce', sparkle: false, glow: false, shadow: true, color: 'white', opacity: 0.85, fontsize: 0.045,
    note: 'TikTok: logo + @username DI CHUYỂN/nảy trong khung (thường bắt đầu góc dưới-phải). Nguồn: Hootsuite & các bài gỡ watermark.' },
  { id: 'kling', label: 'Kling AI', text: 'Kling AI', position: 'bottom-right', motion: 'none', sparkle: false, glow: false, shadow: true, color: 'white', opacity: 0.85, fontsize: 0.04,
    note: 'Kling AI: logo + chữ tĩnh ở góc dưới. Nguồn: nhiều hướng dẫn gỡ watermark Kling.' },
  { id: 'pika', label: 'Pika', text: 'Pika', position: 'bottom-right', motion: 'none', sparkle: false, glow: false, shadow: true, color: 'white', opacity: 0.85, fontsize: 0.045,
    note: 'Pika: logo/chữ mờ tĩnh ở góc dưới-phải (bản free). Nguồn: pika.art FAQ & nhiều nguồn.' },
  { id: 'runway', label: 'Runway', text: 'Runway', position: 'bottom-right', motion: 'none', sparkle: false, glow: false, shadow: true, color: 'white', opacity: 0.85, fontsize: 0.04,
    note: 'Runway: logo tĩnh "ở góc" trên bản free — nguồn KHÔNG nêu rõ góc nào (độ tin cậy thấp); tạm để dưới-phải, chỉnh thêm nếu cần.' },
];

// Built-in brand logos (Xưởng AI Content) bundled at public/brand -> served at
// /brand/... by the backend. One click loads them as the watermark logo so the
// user never has to browse for the file. `scale` = width as a fraction of the
// video; defaults follow the brand guide (KT AI watermark, 45–65% opacity).
const BRAND_LOGOS = [
  { id: 'kt-ai-white', label: 'KT AI (trắng)', file: 'kt-ai-watermark-white.png', scale: 0.22 },
  { id: 'kt-ai-black', label: 'KT AI (đen)', file: 'kt-ai-watermark-black.png', scale: 0.22 },
  { id: 'full-white', label: 'Logo đầy đủ', file: 'kt-xuong-ai-content-white.png', scale: 0.32 },
];

// Fonts. `file` is the Windows font-file basename the backend resolves against
// C:\Windows\Fonts (Pillow); `css`/`weight` drive the live preview so it matches.
// These ship with Windows 10/11; the backend falls back to Arial if missing.
const FONTS = [
  { file: 'arial', label: 'Arial', css: 'Arial', weight: 'normal' },
  { file: 'arialbd', label: 'Arial Bold', css: 'Arial', weight: 'bold' },
  { file: 'segoeui', label: 'Segoe UI', css: 'Segoe UI', weight: 'normal' },
  { file: 'segoeuib', label: 'Segoe UI Bold', css: 'Segoe UI', weight: 'bold' },
  { file: 'calibri', label: 'Calibri', css: 'Calibri', weight: 'normal' },
  { file: 'tahoma', label: 'Tahoma', css: 'Tahoma', weight: 'normal' },
  { file: 'verdana', label: 'Verdana', css: 'Verdana', weight: 'normal' },
  { file: 'verdanab', label: 'Verdana Bold', css: 'Verdana', weight: 'bold' },
  { file: 'trebuc', label: 'Trebuchet MS', css: 'Trebuchet MS', weight: 'normal' },
  { file: 'georgia', label: 'Georgia', css: 'Georgia', weight: 'normal' },
  { file: 'times', label: 'Times New Roman', css: 'Times New Roman', weight: 'normal' },
  { file: 'impact', label: 'Impact', css: 'Impact', weight: 'normal' },
  { file: 'comic', label: 'Comic Sans MS', css: 'Comic Sans MS', weight: 'normal' },
];
const fontDefOf = (fileTok) => FONTS.find((f) => f.file === fileTok) || FONTS[0];

// Offscreen canvas used to measure text width (replicates Pillow's tile math)
// and to normalise any CSS colour (name / rgb() / hex) to "#rrggbb".
const _mcv = typeof document !== 'undefined' ? document.createElement('canvas') : null;
const _mctx = _mcv ? _mcv.getContext('2d') : null;

// Normalise a CSS colour to #rrggbb (via the canvas fillStyle getter), or null
// if invalid. Two sentinels so an invalid string can't masquerade as one of them:
// a valid colour resolves identically from both, an invalid one leaves each
// sentinel untouched (so they differ). Used for <input type="color"> + outline.
function cssToHex(c) {
  if (!_mctx || !c) return null;
  _mctx.fillStyle = '#000000'; _mctx.fillStyle = c; const a = _mctx.fillStyle;
  _mctx.fillStyle = '#ffffff'; _mctx.fillStyle = c; const b = _mctx.fillStyle;
  if (a !== b) return null;             // didn't take in at least one case -> invalid
  return /^#[0-9a-f]{6}$/i.test(a) ? a : null;
}

// Relative luminance (0..1) of a #rrggbb colour — to choose a contrasting outline.
function hexLuminance(hex) {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex || '');
  if (!m) return 1;
  const [r, g, b] = [1, 2, 3].map((i) => parseInt(m[i], 16) / 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

const QUICK_COLORS = ['#ffffff', '#000000', '#ff3b30', '#ffcc00', '#34c759', '#0a84ff', '#ff2d55'];

// Size of the rendered text tile in VIDEO pixels — mirrors
// VisibleWatermarker._render_text_tile so the preview box matches the export.
// `outline` is the stroke width as a fraction of font size (0 = none). Must match
// the stroke_width px the UI sends to the backend (see strokePxFor()).
function textTileBox(VH, { text, fontsize, sparkle, glow, shadow, outline = 0, fontCss = 'Arial', fontWeight = 'normal' }) {
  const size = Math.max(8, Math.floor(VH * fontsize));
  const stroke = strokePxFor(size, outline);
  let tw = 0, th = 0;
  if (_mctx) {
    _mctx.font = `${fontWeight} ${size}px "${fontCss}", sans-serif`;
    const m = _mctx.measureText(text || ' ');
    tw = Math.ceil(m.width);
    th = Math.round((m.actualBoundingBoxAscent || 0) + (m.actualBoundingBoxDescent || 0));
  }
  if (!th) th = Math.round(size * 0.8);
  // Pillow's textbbox(stroke_width=sw) expands the glyph box by sw on each side.
  tw += 2 * stroke;
  th += 2 * stroke;
  const spark = sparkle ? Math.floor(size * 0.95) : 0;
  const sparkGap = sparkle ? Math.max(4, Math.floor(size / 5)) : 0;
  const pad = stroke + Math.max(4, (glow || sparkle) ? Math.floor(size / 5) : 4); // backend: pad = stroke_width + base
  const sh = shadow ? 2 : 0;
  const contentH = Math.max(th, spark);
  const w = spark + sparkGap + tw + 2 * pad + sh;
  const h = contentH + 2 * pad + sh;
  return { w, h, size, spark, sparkGap, pad, th, stroke };
}

// Stroke width in px for a given font size + outline fraction. Single source of
// truth so the preview metrics and the backend stroke_width stay identical.
function strokePxFor(sizePx, outline) {
  return outline > 0 ? Math.max(1, Math.round(sizePx * outline)) : 0;
}

// Top-left anchor (video px) of a box of (bw, bh) for a preset position.
function presetAnchor(position, VW, VH, bw, bh) {
  switch (position) {
    case 'top-left': return [MARGIN, MARGIN];
    case 'top-right': return [VW - bw - MARGIN, MARGIN];
    case 'bottom-left': return [MARGIN, VH - bh - MARGIN];
    case 'center': return [(VW - bw) / 2, (VH - bh) / 2];
    case 'random': return [(VW - bw) / 2, (VH - bh) / 2]; // representative sample
    case 'bottom-right':
    default: return [VW - bw - MARGIN, VH - bh - MARGIN];
  }
}

function drawSparkle(ctx, cx, cy, size, color) {
  const r = size / 2, inner = r * 0.2;
  ctx.beginPath();
  for (let i = 0; i < 4; i++) {
    const ao = (90 * i - 90) * Math.PI / 180;
    const ax = cx + r * Math.cos(ao), ay = cy + r * Math.sin(ao);
    if (i === 0) ctx.moveTo(ax, ay); else ctx.lineTo(ax, ay);
    const ai = (90 * i - 90 + 45) * Math.PI / 180;
    ctx.lineTo(cx + inner * Math.cos(ai), cy + inner * Math.sin(ai));
  }
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
}

export default function AddWatermarkTab({ outputDir, onToast }) {
  const [file, setFile] = useState(null);
  const [logoFile, setLogoFile] = useState(null);
  const [text, setText] = useState('© 2026');
  const [position, setPosition] = useState('bottom-right');
  const [customXY, setCustomXY] = useState(null); // [x, y] video px (top-left) | null
  const [color, setColor] = useState('white');
  const [opacity, setOpacity] = useState(0.6);
  const [fontsize, setFontsize] = useState(0.05);
  const [font, setFont] = useState('arial');
  const [outlineWidth, setOutlineWidth] = useState(0); // viền chữ: 0 = tắt, else fraction of size
  const [logoScale, setLogoScale] = useState(0.15);
  const [logoLib, setLogoLib] = useState([]); // {name, file, url} from a chosen folder
  const [nameMode, setNameMode] = useState('name_text'); // output filename scheme
  const [tile, setTile] = useState(false);
  const [sparkle, setSparkle] = useState(false);
  const [glow, setGlow] = useState(false);
  const [shadow, setShadow] = useState(false);
  const [motion, setMotion] = useState('none');
  const [crf, setCrf] = useState(20);
  const [advOpen, setAdvOpen] = useState(false);
  const [hidden, setHidden] = useState(false);
  const [password, setPassword] = useState('');
  const [payload, setPayload] = useState('');

  const [status, setStatus] = useState('idle'); // idle|processing|done|error|cancelled
  const [progress, setProgress] = useState(0);
  const [info, setInfo] = useState('');
  const [savedPath, setSavedPath] = useState('');
  const [hiddenBytes, setHiddenBytes] = useState(null);
  const [available, setAvailable] = useState(true);

  // Preview state
  const [frame, setFrame] = useState(null); // { width, height } of the loaded frame
  const [previewFrac, setPreviewFrac] = useState(0.5);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [previewErr, setPreviewErr] = useState('');
  const [logoDims, setLogoDims] = useState(null); // { w, h } natural size

  const fileRef = useRef(null);
  const logoRef = useRef(null);
  const logoDirRef = useRef(null);
  const abortRef = useRef(null);
  const canvasRef = useRef(null);
  const frameCanvasRef = useRef(null); // hidden full-res frame buffer
  const logoImgRef = useRef(null);
  const dragRef = useRef(null); // null | 'move' | 'resize:text' | 'resize:logo'
  const loadSeqRef = useRef(0); // monotonic id so out-of-order frame loads are dropped
  const logoLibRef = useRef([]); // mirror of logoLib for unmount cleanup
  const busy = status === 'processing';
  const placeable = motion === 'none' && !tile; // position only matters when static & not tiled
  const interactive = !!frame && !busy && placeable;
  const fontDef = fontDefOf(font); // {css, weight} for the live preview
  const colorHex = cssToHex(color) || '#ffffff'; // normalized for the RGB picker
  // Auto outline colour: contrast against the fill (dark text -> white outline).
  const outlineColor = hexLuminance(colorHex) > 0.5 ? '#000000' : '#ffffff';

  useEffect(() => { getWmStatus().then((s) => setAvailable(!!(s && s.available === true))).catch(() => setAvailable(false)); }, []);

  // Turn the hidden logo input into a FOLDER picker + revoke thumbnail URLs on unmount.
  useEffect(() => { logoLibRef.current = logoLib; }, [logoLib]);
  useEffect(() => {
    const el = logoDirRef.current;
    if (el) { el.setAttribute('webkitdirectory', ''); el.setAttribute('directory', ''); }
    return () => { logoLibRef.current.forEach((l) => URL.revokeObjectURL(l.url)); };
  }, []);

  // ── Frame loading ─────────────────────────────────────────────────────────
  const loadFrame = useCallback(async (f, frac) => {
    const seq = ++loadSeqRef.current; // claim latest synchronously; stale loads bail
    if (!f) { setFrame(null); return; }
    setPreviewBusy(true); setPreviewErr('');
    try {
      const img = await grabPreviewFrame(f, frac);
      if (seq !== loadSeqRef.current) return; // superseded by a newer request
      let fc = frameCanvasRef.current;
      if (!fc) { fc = document.createElement('canvas'); frameCanvasRef.current = fc; }
      fc.width = img.width; fc.height = img.height;
      fc.getContext('2d').putImageData(img, 0, 0);
      setFrame({ width: img.width, height: img.height });
    } catch (_) {
      if (seq === loadSeqRef.current) { setFrame(null); setPreviewErr('Không tạo được khung xem trước cho video này'); }
    } finally {
      if (seq === loadSeqRef.current) setPreviewBusy(false);
    }
  }, []);

  // Reload preview whenever the file changes (resets the frame position to mid).
  useEffect(() => {
    setPreviewFrac(0.5);
    loadFrame(file, 0.5);
  }, [file, loadFrame]);

  // Load the logo's natural size for a faithful preview + draw.
  useEffect(() => {
    if (!logoFile) { logoImgRef.current = null; setLogoDims(null); return; }
    const url = URL.createObjectURL(logoFile);
    const img = new Image();
    img.onload = () => {
      // Some loadable images (0×0, certain SVGs, truncated files) fire onload
      // with zero dimensions — reject them to avoid a divide-by-zero NaN box.
      if (!img.naturalWidth || !img.naturalHeight) {
        logoImgRef.current = null; setLogoDims(null); onToast?.('Logo không hợp lệ (kích thước 0)');
        return;
      }
      logoImgRef.current = img; setLogoDims({ w: img.naturalWidth, h: img.naturalHeight });
    };
    img.onerror = () => { logoImgRef.current = null; setLogoDims(null); };
    img.src = url;
    return () => { URL.revokeObjectURL(url); };
  }, [logoFile]);

  // ── Layout helpers (video px) ───────────────────────────────────────────────
  const layout = useCallback((VW, VH) => {
    const out = {};
    if (text.trim()) out.text = textTileBox(VH, { text, fontsize, sparkle, glow, shadow, outline: outlineWidth, fontCss: fontDef.css, fontWeight: fontDef.weight });
    if (logoImgRef.current && logoDims && logoDims.w > 0 && logoDims.h > 0) {
      let lw = Math.max(2, Math.round(VW * logoScale));
      lw -= lw % 2;
      const lh = Math.max(1, Math.round(logoDims.h * lw / logoDims.w));
      out.logo = { w: lw, h: lh };
    }
    out.primary = out.text || out.logo || null;
    return out;
  }, [text, fontsize, sparkle, glow, shadow, outlineWidth, logoScale, logoDims, fontDef.css, fontDef.weight]);

  // ── Preview draw ────────────────────────────────────────────────────────────
  const draw = useCallback(() => {
    const cv = canvasRef.current;
    const fc = frameCanvasRef.current;
    if (!cv) return;
    const ctx = cv.getContext('2d');
    if (!frame || !fc) { ctx.clearRect(0, 0, cv.width, cv.height); return; }
    const VW = frame.width, VH = frame.height;
    const maxW = 680, maxH = 440;
    let dispW = maxW, dispH = Math.round(maxW * VH / VW);
    if (dispH > maxH) { dispH = maxH; dispW = Math.round(maxH * VW / VH); }
    cv.width = dispW; cv.height = dispH;
    cv.style.maxWidth = dispW + 'px';
    const s = dispW / VW;
    ctx.drawImage(fc, 0, 0, VW, VH, 0, 0, dispW, dispH);

    const lay = layout(VW, VH);
    // A pin only governs placement when static & not tiled; otherwise show a
    // neutral centered sample (motion/random) since the export won't honor it.
    const usePin = !!customXY && placeable;
    const anchorOf = (bw, bh) => (usePin
      ? [customXY[0], customXY[1]]
      : presetAnchor(placeable ? position : 'center', VW, VH, bw, bh));

    // Logo first (drawn under text, matching the overlay stacking order).
    if (lay.logo && logoImgRef.current) {
      const [lx, ly] = anchorOf(lay.logo.w, lay.logo.h);
      ctx.save();
      ctx.globalAlpha = clamp(opacity, 0, 1); // opacity slider now governs the logo too
      ctx.drawImage(logoImgRef.current, lx * s, ly * s, lay.logo.w * s, lay.logo.h * s);
      ctx.restore();
    }

    if (lay.text) {
      const b = lay.text;
      const drawOneText = (x, y) => {
        ctx.save();
        ctx.globalAlpha = clamp(opacity, 0, 1);
        ctx.font = `${fontDef.weight} ${b.size * s}px "${fontDef.css}", sans-serif`;
        ctx.textBaseline = 'middle';
        if (glow) { ctx.shadowColor = 'rgba(255,255,255,0.95)'; ctx.shadowBlur = b.size * 0.18 * s * 2; }
        else if (shadow) { ctx.shadowColor = 'rgba(0,0,0,0.9)'; ctx.shadowOffsetX = 2 * s; ctx.shadowOffsetY = 2 * s; }
        const cy = (y + b.h / 2) * s;
        if (b.spark) drawSparkle(ctx, (x + b.pad + b.spark / 2) * s, cy, b.spark * s, color);
        const tx = (x + b.pad + b.spark + b.sparkGap) * s;
        if (b.stroke > 0) { // outline first, fill on top (paint-order stroke->fill)
          ctx.lineWidth = b.stroke * 2 * s;
          ctx.lineJoin = 'round';
          ctx.strokeStyle = outlineColor;
          try { ctx.strokeText(text, tx, cy); } catch (_) { /* ignore */ }
        }
        ctx.fillStyle = color;
        try { ctx.fillText(text, tx, cy); } catch (_) { /* invalid color → skip */ }
        ctx.restore();
      };
      if (tile) {
        // Mirror backend _tile_onto: int()-truncated pitch + floor-div offset.
        const pitchX = Math.max(1, Math.floor(b.w * 1.6)), pitchY = Math.max(1, Math.floor(b.h * 1.6));
        let row = 0;
        for (let y = -b.h; y < VH; y += pitchY) {
          const off = (row % 2) ? Math.floor(pitchX / 2) : 0;
          for (let x = -b.w + off; x < VW; x += pitchX) drawOneText(x, y);
          row++;
        }
      } else {
        const [tx0, ty0] = anchorOf(b.w, b.h);
        drawOneText(tx0, ty0);
      }
    }

    // Selection box(es) (only when placement applies). In custom (pinned) mode
    // each present element gets its own dashed box + bottom-right resize handle,
    // so the user can resize the logo and the text independently. In preset mode
    // we draw just a guide box (no handle); a click pins it (-> custom) first.
    if (placeable && lay.primary) {
      ctx.save();
      const drawBox = (box, x, y, withHandle, pinned) => {
        ctx.lineWidth = 1.5;
        ctx.setLineDash([5, 4]);
        ctx.strokeStyle = pinned ? 'rgba(99,102,241,0.95)' : 'rgba(255,255,255,0.7)';
        ctx.strokeRect(x * s + 0.5, y * s + 0.5, box.w * s, box.h * s);
        if (withHandle) {
          const hx = (x + box.w) * s, hy = (y + box.h) * s;
          ctx.setLineDash([]);
          ctx.fillStyle = 'rgba(99,102,241,0.95)';
          ctx.fillRect(hx - 5, hy - 5, 10, 10);
          ctx.strokeStyle = 'white';
          ctx.lineWidth = 1;
          ctx.strokeRect(hx - 5, hy - 5, 10, 10);
        }
      };
      if (usePin) {
        // both elements share the pinned top-left (matches backend custom_xy)
        if (lay.logo) drawBox(lay.logo, customXY[0], customXY[1], true, true);
        if (lay.text) drawBox(lay.text, customXY[0], customXY[1], true, true);
      } else {
        const [bx, by] = anchorOf(lay.primary.w, lay.primary.h);
        drawBox(lay.primary, bx, by, false, false);
      }
      ctx.restore();
    }
  }, [frame, layout, position, customXY, opacity, color, outlineColor, text, fontsize, sparkle, glow, shadow, tile, placeable, logoDims, fontDef.css, fontDef.weight]);

  useEffect(() => { draw(); }, [draw]);

  // ── Click / drag to place a custom position ─────────────────────────────────
  const placeAt = useCallback((clientX, clientY) => {
    const cv = canvasRef.current;
    if (!cv || !frame) return;
    const VW = frame.width, VH = frame.height;
    const lay = layout(VW, VH);
    const box = lay.primary;
    if (!box) return; // nothing to place
    const rect = cv.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const dx = (clientX - rect.left) * (cv.width / rect.width);
    const dy = (clientY - rect.top) * (cv.height / rect.height);
    const s = cv.width / VW;
    const cxVid = dx / s, cyVid = dy / s;
    const x = clamp(Math.round(cxVid - box.w / 2), 0, Math.max(0, VW - box.w));
    const y = clamp(Math.round(cyVid - box.h / 2), 0, Math.max(0, VH - box.h));
    setCustomXY([x, y]);
  }, [frame, layout]);

  // Which element's bottom-right resize handle (if any) is under the pointer.
  // Handles exist ONLY in custom (pinned) mode, so a handle grab never converts
  // a preset into custom — the box is already pinned. Returns 'text'|'logo'|null.
  const handleHit = (clientX, clientY) => {
    const cv = canvasRef.current;
    if (!cv || !frame || !customXY || !placeable) return null;
    const VW = frame.width;
    const rect = cv.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    const s = cv.width / VW;
    const lay = layout(VW, frame.height);
    const near = (box) => {
      const hx = rect.left + (customXY[0] + box.w) * s * (rect.width / cv.width);
      const hy = rect.top + (customXY[1] + box.h) * s * (rect.height / cv.height);
      return Math.hypot(clientX - hx, clientY - hy) <= HANDLE;
    };
    if (lay.text && near(lay.text)) return 'text';     // text drawn on top -> test first
    if (lay.logo && near(lay.logo)) return 'logo';
    return null;
  };

  // Resize one element by dragging its handle: text -> fontsize, logo -> logoScale.
  // Grows from the pinned top-left and is clamped so the box stays inside the
  // frame (handle stays grabbable; nothing renders/exports off-screen).
  const resizeAt = useCallback((clientX, clientY, el) => {
    const cv = canvasRef.current;
    if (!cv || !frame || !customXY) return;
    const VW = frame.width, VH = frame.height;
    const lay = layout(VW, VH);
    const rect = cv.getBoundingClientRect();
    if (!rect.width) return;
    const s = cv.width / VW;
    const pxVid = ((clientX - rect.left) * (cv.width / rect.width)) / s;
    const wBudget = Math.max(8, VW - customXY[0]); // keep box right edge <= VW
    const hBudget = Math.max(8, VH - customXY[1]); // keep box bottom edge <= VH
    if (el === 'text' && lay.text) {
      const box = lay.text;
      // box dims are ~linear in font size; cap the ratio by both budgets.
      const ratio = Math.min((pxVid - customXY[0]) / box.w, wBudget / box.w, hBudget / box.h);
      setFontsize(clamp(snap(fontsize * ratio, 0.005), 0.02, 0.15));
    } else if (el === 'logo' && lay.logo && logoDims) {
      let targetW = clamp(pxVid - customXY[0], 8, wBudget);
      const lh = logoDims.h * targetW / logoDims.w; // honor aspect for the height budget
      if (lh > hBudget) targetW = hBudget * logoDims.w / logoDims.h;
      setLogoScale(clamp(snap(targetW / VW, 0.01), 0.05, 0.5)); // logo width = VW * scale
    }
  }, [frame, layout, customXY, fontsize, logoDims]);

  const onPointerDown = (e) => {
    if (!interactive) return; // interactive already excludes tile/motion
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ }
    const hit = handleHit(e.clientX, e.clientY); // 'text'|'logo'|null (custom mode only)
    if (hit) { dragRef.current = 'resize:' + hit; return; }
    dragRef.current = 'move';
    placeAt(e.clientX, e.clientY);
  };
  const onPointerMove = (e) => {
    const mode = dragRef.current;
    if (mode === 'move') { placeAt(e.clientX, e.clientY); return; }
    if (mode && mode.startsWith('resize:')) { resizeAt(e.clientX, e.clientY, mode.slice(7)); return; }
    // hover cursor hint (no React state -> no re-render)
    if (interactive) {
      const cv = canvasRef.current;
      if (cv) cv.style.cursor = handleHit(e.clientX, e.clientY) ? 'nwse-resize' : 'crosshair';
    }
  };
  const endDrag = () => { dragRef.current = null; };

  // Keyboard placement (accessibility): arrow keys nudge the custom position,
  // Shift = bigger step. Seeds from the centered point if none pinned yet.
  const nudge = useCallback((dx, dy) => {
    if (!interactive) return;
    const VW = frame.width, VH = frame.height;
    const box = layout(VW, VH).primary;
    if (!box) return;
    const base = customXY || [Math.round((VW - box.w) / 2), Math.round((VH - box.h) / 2)];
    const x = clamp(base[0] + dx, 0, Math.max(0, VW - box.w));
    const y = clamp(base[1] + dy, 0, Math.max(0, VH - box.h));
    setCustomXY([x, y]);
  }, [interactive, frame, layout, customXY]);

  const onCanvasKeyDown = (e) => {
    const step = e.shiftKey ? 10 : 1;
    let handled = true;
    switch (e.key) {
      case 'ArrowLeft': nudge(-step, 0); break;
      case 'ArrowRight': nudge(step, 0); break;
      case 'ArrowUp': nudge(0, -step); break;
      case 'ArrowDown': nudge(0, step); break;
      default: handled = false;
    }
    if (handled) e.preventDefault();
  };

  const pickFile = (e) => {
    const f = (e.target.files || [])[0];
    e.target.value = '';
    if (f && isVideo(f)) { setFile(f); setStatus('idle'); setSavedPath(''); setCustomXY(null); }
    else if (f) onToast?.('Chỉ nhận video MP4/MOV');
  };
  const pickLogo = (e) => { const f = (e.target.files || [])[0]; e.target.value = ''; if (f) setLogoFile(f); };

  // Pick a FOLDER of logos -> show its images as a clickable thumbnail library.
  const pickLogoDir = (e) => {
    const all = [...(e.target.files || [])];
    e.target.value = '';
    const imgs = all.filter((f) => /\.(png|jpe?g|webp)$/i.test(f.name));
    logoLib.forEach((l) => URL.revokeObjectURL(l.url)); // free the previous batch
    const lib = imgs.slice(0, 60).map((f) => ({ name: f.name, file: f, url: URL.createObjectURL(f) }));
    setLogoLib(lib);
    if (!imgs.length) onToast?.('Thư mục không có ảnh PNG/JPG/WebP');
    else onToast?.(`Đã nạp ${lib.length} logo từ thư mục` + (imgs.length > lib.length ? ` (hiện ${lib.length}/${imgs.length})` : ''));
  };

  // Use a logo from the chosen folder as the watermark (brand-style defaults).
  const applyLibLogo = (l) => {
    if (busy) return;
    setLogoFile(l.file); setText(''); setPosition('bottom-right'); setCustomXY(null);
    setOpacity(0.65); setLogoScale(0.22); setMotion('none'); setTile(false);
    onToast?.('Đã chọn logo: ' + l.name);
  };

  const onPosChange = (v) => {
    if (v === 'custom') {
      if (!frame) { onToast?.('Hãy chờ khung xem trước rồi bấm/kéo (hoặc dùng phím mũi tên) để chọn vị trí'); return; }
      if (!customXY) {
        const VW = frame.width, VH = frame.height;
        const box = layout(VW, VH).primary;
        // Clamp the seeded center exactly like placeAt so it can never start off-frame.
        if (box) setCustomXY([
          clamp(Math.round((VW - box.w) / 2), 0, Math.max(0, VW - box.w)),
          clamp(Math.round((VH - box.h) / 2), 0, Math.max(0, VH - box.h)),
        ]);
        else setCustomXY([0, 0]);
      }
    } else { setCustomXY(null); setPosition(v); }
  };

  const applyBrand = (b) => {
    setText(b.text); setPosition(b.position); setCustomXY(null);
    setSparkle(b.sparkle); setGlow(b.glow); setShadow(b.shadow);
    setColor(b.color); setOpacity(b.opacity); setFontsize(b.fontsize);
    setMotion(b.motion); setTile(false);
    onToast?.(`Đã áp mẫu ${b.label} — chỉnh thêm trên khung xem trước nếu cần`);
  };

  // Load a bundled brand logo (no file dialog) and apply brand-guide defaults.
  const applyBrandLogo = async (b) => {
    if (busy) return;
    try {
      const res = await fetch('/brand/' + b.file); // static asset, no CSRF header
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const blob = await res.blob();
      setLogoFile(new File([blob], b.file, { type: blob.type || 'image/png' }));
      setText('');                 // the brand mark IS the logo — avoid double text
      setPosition('bottom-right'); setCustomXY(null);
      setOpacity(0.65);            // brand guide: 45–65%; 65% reads best after H.264
      setLogoScale(b.scale); setMotion('none'); setTile(false);
      onToast?.(`Đã nạp logo ${b.label} — đã ẩn chữ để chỉ hiện logo`);
    } catch (_) {
      onToast?.('Không nạp được logo thương hiệu (cần chạy bằng update.bat)');
    }
  };

  const run = async () => {
    if (!file || busy) return;
    if (!text.trim() && !logoFile) { onToast?.('Cần nhập chữ hoặc chọn logo'); return; }
    if (hidden && (!password.trim() || !payload.trim())) { onToast?.('Watermark ẩn cần mật khẩu và nội dung'); return; }
    setStatus('processing'); setProgress(0.05); setInfo(''); setSavedPath(''); setHiddenBytes(null);
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      // Only honor a pinned custom point when it actually has effect: motion
      // and tile mode make the backend ignore position/custom_xy entirely.
      const useCustom = !!customXY && placeable;
      const effPos = useCustom ? 'custom' : position;
      // Outline width in px from the export's video height (== preview frame
      // height), using the same formula as the preview so they match exactly.
      const sizePx = Math.max(8, Math.floor((frame ? frame.height : 1080) * fontsize));
      const strokeW = strokePxFor(sizePx, outlineWidth);
      const opts = {
        text: text.trim(), color, opacity, position: effPos, font,
        custom_x: useCustom ? customXY[0] : '', custom_y: useCustom ? customXY[1] : '',
        fontsize_ratio: fontsize, stroke_width: strokeW, stroke_color: outlineColor,
        shadow, rotate: 0, tile, sparkle, glow, motion, motion_interval: 3,
        logo_scale: logoScale, logo_opacity: opacity, crf, preset: 'medium',
        name_mode: nameMode, hidden, password, payload,
      };
      const out = await addWatermark(file, logoFile, opts, (p, i) => { setProgress(p); setInfo(i); }, controller.signal);
      setStatus('done'); setProgress(1); setSavedPath(out.path); setHiddenBytes(out.hiddenBytes ?? null);
      onToast?.('Đã thêm watermark — đã lưu: ' + out.name
        + (out.hiddenBytes ? ` · watermark ẩn ${out.hiddenBytes} byte (ghi lại để trích xuất)` : ''));
    } catch (e) {
      const msg = e?.message || 'Thất bại';
      const cancelled = /cancel/i.test(msg);
      setStatus(cancelled ? 'cancelled' : 'error'); setInfo(cancelled ? 'Đã huỷ' : msg);
    } finally { abortRef.current = null; }
  };

  const stop = () => { try { abortRef.current?.abort(); } catch (_) { /* ignore */ } };
  const openResult = () => {
    if (!savedPath) return;
    const fd = new FormData(); fd.append('path', savedPath);
    apiFetch('/api/open-path', { method: 'POST', body: fd }).catch(() => {});
  };
  // Open the output folder with the just-saved file highlighted.
  const openFolder = () => {
    if (savedPath) {
      const fd = new FormData(); fd.append('path', savedPath);
      apiFetch('/api/reveal-path', { method: 'POST', body: fd }).catch(() => {});
    } else {
      apiFetch('/api/open-output', { method: 'POST' }).catch(() => {});
    }
  };

  const pct = Math.round(progress * 100);
  // Show 'custom' only when a pin is active AND effective (not under motion/tile).
  const posValue = (customXY && placeable) ? 'custom' : position;

  return (
    <Box sx={{ maxWidth: 1180, mx: 'auto', px: 3, py: 3, width: '100%' }}>
      {!available && (
        <Paper variant="outlined" sx={{ p: 1.5, mb: 2, borderColor: 'warning.main' }}>
          <Typography variant="body2" color="warning.main">
            Tính năng thêm watermark cần <b>ffmpeg + numpy + Pillow</b> (chạy bằng <b>update.bat</b>). Hiện chưa khả dụng.
          </Typography>
        </Paper>
      )}

      <Box sx={{ display: 'flex', gap: 3, alignItems: 'flex-start', flexDirection: { xs: 'column', md: 'row' } }}>
        {/* ── CỘT PHẢI (md) — Video & Xem trước (review) ───────────────────── */}
        <Box sx={{ flex: '1 1 0', minWidth: 0, width: '100%', order: { xs: 1, md: 2 },
          position: { md: 'sticky' }, top: { md: 8 }, alignSelf: { md: 'flex-start' } }}>
          <Paper
            variant="outlined"
            onClick={() => !busy && fileRef.current?.click()}
        sx={{ p: file ? 2 : 5, mb: 2.5, textAlign: 'center', cursor: busy ? 'default' : 'pointer',
          borderStyle: 'dashed', borderWidth: 2 }}
      >
        <MovieIcon sx={{ fontSize: file ? 28 : 42, color: 'primary.main', opacity: 0.9 }} />
        <Typography sx={{ fontWeight: 600, mt: 1 }}>
          {file ? file.name : 'Bấm để chọn video (MP4 / MOV)'}
        </Typography>
        <input ref={fileRef} type="file" hidden accept="video/mp4,video/quicktime,.mp4,.mov,.m4v" onChange={pickFile} />
      </Paper>

      {/* ── Live placement preview ─────────────────────────────────────────── */}
      {file && (
        <Paper variant="outlined" sx={{ p: 2, mb: 2.5 }}>
          <Stack direction="row" alignItems="center" justifyContent="space-between" sx={{ mb: 1 }}>
            <Typography variant="subtitle2">Xem trước &amp; chọn vị trí</Typography>
            {customXY && (
              <Tooltip title="Về vị trí mặc định (preset)">
                <Button size="small" color="inherit" startIcon={<RestartAltIcon />} onClick={() => setCustomXY(null)}>
                  Bỏ ghim vị trí
                </Button>
              </Tooltip>
            )}
          </Stack>
          <Box sx={{ textAlign: 'center', bgcolor: 'black', borderRadius: 1, overflow: 'hidden', minHeight: 80,
            display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            {previewErr ? (
              <Typography variant="body2" color="error.main" sx={{ p: 3 }}>{previewErr}</Typography>
            ) : (
              <canvas
                ref={canvasRef}
                role="application"
                tabIndex={interactive ? 0 : -1}
                aria-label={`Khung xem trước watermark. ${customXY
                  ? `Vị trí tuỳ chỉnh x ${customXY[0]}, y ${customXY[1]}.`
                  : 'Chưa ghim vị trí.'} ${interactive
                  ? 'Bấm hoặc kéo để chọn vị trí; phím mũi tên để dịch chuyển.'
                  : ''}`}
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={endDrag}
                onPointerCancel={endDrag}
                onKeyDown={onCanvasKeyDown}
                style={{ width: '100%', display: 'block', touchAction: 'none', outline: 'none',
                  cursor: interactive ? 'crosshair' : 'default' }}
              />
            )}
          </Box>
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5 }}>
            {tile ? 'Chế độ lưới chéo phủ toàn khung — không chọn vị trí.'
              : motion !== 'none' ? 'Đang bật chuyển động — watermark sẽ di chuyển khi xuất; vị trí cố định bị bỏ qua.'
              : customXY ? `Vị trí tuỳ chỉnh: x=${customXY[0]}, y=${customXY[1]}. Kéo (hoặc phím mũi tên) để di chuyển; kéo ô vuông ở góc mỗi khung (chữ/logo) để đổi kích thước.`
              : position === 'random' ? 'Vị trí ngẫu nhiên — đổi mỗi lần xuất (ô minh hoạ ở giữa).'
              : 'Bấm để ghim vị trí (sau đó kéo ô vuông ở góc để đổi kích thước chữ/logo), hoặc chỉnh bằng thanh trượt bên dưới.'}
          </Typography>
          <Box sx={{ mt: 1 }}>
            <Typography variant="caption" color="text.secondary">
              Khung xem trước {previewBusy ? '(đang tải…)' : `(~${Math.round(previewFrac * 100)}% thời lượng)`}
            </Typography>
            <Slider size="small" min={0} max={1} step={0.02} value={previewFrac}
              onChange={(_, v) => setPreviewFrac(v)}
              onChangeCommitted={(_, v) => loadFrame(file, v)} disabled={!file} />
          </Box>
        </Paper>
      )}
        </Box>

        {/* ── CỘT TRÁI (md) — Cài đặt watermark ────────────────────────────── */}
        <Box sx={{ flex: '1 1 0', minWidth: 0, width: '100%', order: { xs: 2, md: 1 } }}>
      <Stack spacing={2}>
        <Box>
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 0.5 }}>
            Mẫu thương hiệu — vị trí theo watermark thật của từng nền tảng (di chuột để xem nguồn)
          </Typography>
          <Stack direction="row" spacing={1} sx={{ flexWrap: 'wrap', gap: 1 }}>
            {BRANDS.map((b) => (
              <Tooltip key={b.id} title={b.note} arrow>
                <span>
                  <Button size="small" variant="outlined" onClick={() => applyBrand(b)} disabled={busy}>
                    {b.label}
                  </Button>
                </span>
              </Tooltip>
            ))}
          </Stack>
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5 }}>
            Veo · Sora · TikTok có watermark <b>di chuyển</b> — góc chỉ là điểm bắt đầu, chuyển động sẽ đè lên vị trí cố định.
          </Typography>
        </Box>

        <Stack direction="row" spacing={2} sx={{ flexWrap: 'wrap', rowGap: 2 }}>
          <TextField label="Chữ watermark" size="small" sx={{ flexGrow: 1, minWidth: 240 }} value={text}
            onChange={(e) => setText(e.target.value)} placeholder="© ACME 2026 / @username" disabled={busy} />
          <FormControl size="small" sx={{ minWidth: 190 }} disabled={busy}>
            <InputLabel id="font">Font chữ</InputLabel>
            <Select labelId="font" label="Font chữ" value={font} onChange={(e) => setFont(e.target.value)}
              renderValue={(v) => fontDefOf(v).label}>
              {FONTS.map((f) => (
                <MenuItem key={f.file} value={f.file}
                  style={{ fontFamily: f.css, fontWeight: f.weight }}>
                  {f.label}
                </MenuItem>
              ))}
            </Select>
          </FormControl>
        </Stack>

        <Stack direction="row" spacing={2} sx={{ flexWrap: 'wrap', rowGap: 2 }}>
          <FormControl size="small" sx={{ minWidth: 200 }} disabled={busy || !placeable}>
            <InputLabel id="pos">Vị trí</InputLabel>
            <Select labelId="pos" label="Vị trí" value={posValue} onChange={(e) => onPosChange(e.target.value)}>
              <MenuItem value="bottom-right">Dưới phải</MenuItem>
              <MenuItem value="bottom-left">Dưới trái</MenuItem>
              <MenuItem value="top-right">Trên phải</MenuItem>
              <MenuItem value="top-left">Trên trái</MenuItem>
              <MenuItem value="center">Giữa</MenuItem>
              <MenuItem value="random">Ngẫu nhiên</MenuItem>
              <MenuItem value="custom" disabled={!frame}>Tuỳ chỉnh (bấm/kéo trên khung)</MenuItem>
            </Select>
          </FormControl>
          <FormControl size="small" sx={{ minWidth: 170 }} disabled={busy}>
            <InputLabel id="mo">Chuyển động</InputLabel>
            <Select labelId="mo" label="Chuyển động" value={motion} onChange={(e) => setMotion(e.target.value)}>
              <MenuItem value="none">Tĩnh</MenuItem>
              <MenuItem value="random">Nhảy ngẫu nhiên</MenuItem>
              <MenuItem value="bounce">Nảy (DVD)</MenuItem>
            </Select>
          </FormControl>
        </Stack>

        {/* Màu chữ — bảng màu RGB */}
        <Stack direction="row" spacing={1.5} alignItems="center" sx={{ flexWrap: 'wrap', rowGap: 1 }}>
          <Typography variant="body2" sx={{ fontWeight: 600 }}>Màu chữ</Typography>
          <Tooltip title="Mở bảng màu RGB">
            <Box component="label" sx={{ display: 'inline-flex', cursor: busy ? 'default' : 'pointer' }}>
              <input type="color" value={colorHex} disabled={busy}
                onChange={(e) => setColor(e.target.value)}
                style={{ width: 40, height: 32, border: '1px solid #888', borderRadius: 6,
                  background: 'none', padding: 0, cursor: busy ? 'default' : 'pointer' }} />
            </Box>
          </Tooltip>
          <TextField size="small" sx={{ width: 130 }} value={color} disabled={busy}
            onChange={(e) => setColor(e.target.value)} placeholder="white / #ff0000"
            helperText="tên hoặc mã hex" />
          {QUICK_COLORS.map((c) => (
            <Box key={c} component="button" type="button" disabled={busy}
              onClick={() => setColor(c)} aria-label={`Màu ${c}`}
              sx={{ width: 22, height: 22, borderRadius: '50%', p: 0, cursor: 'pointer',
                bgcolor: c, border: colorHex.toLowerCase() === c ? '2px solid' : '1px solid',
                borderColor: colorHex.toLowerCase() === c ? 'primary.main' : 'divider' }} />
          ))}
        </Stack>

        <Box>
          <Typography variant="caption" color="text.secondary">Độ mờ (chữ &amp; logo): {opacity.toFixed(2)}</Typography>
          <Slider size="small" min={0.05} max={1} step={0.05} value={opacity} disabled={busy}
            onChange={(_, v) => setOpacity(v)} />
        </Box>
        <Box>
          <Typography variant="caption" color="text.secondary">Cỡ / độ rộng chữ (hoặc kéo ô vuông của khung chữ khi đã ghim vị trí): {fontsize.toFixed(3)}</Typography>
          <Slider size="small" min={0.02} max={0.15} step={0.005} value={fontsize} disabled={busy}
            onChange={(_, v) => setFontsize(v)} />
        </Box>
        <Box>
          <Typography variant="caption" color="text.secondary">
            Viền chữ (giúp chữ nét &amp; nổi rõ hơn): {outlineWidth === 0 ? 'tắt' : outlineWidth.toFixed(3)}
          </Typography>
          <Slider size="small" min={0} max={0.15} step={0.005} value={outlineWidth} disabled={busy}
            onChange={(_, v) => setOutlineWidth(v)} />
        </Box>

        <Stack direction="row" sx={{ flexWrap: 'wrap' }}>
          <FormControlLabel control={<Switch checked={tile} onChange={(e) => setTile(e.target.checked)} disabled={busy} />} label="Lưới chéo" />
          <FormControlLabel control={<Switch checked={sparkle} onChange={(e) => setSparkle(e.target.checked)} disabled={busy} />} label="Spark ✦" />
          <FormControlLabel control={<Switch checked={glow} onChange={(e) => setGlow(e.target.checked)} disabled={busy} />} label="Glow" />
          <FormControlLabel control={<Switch checked={shadow} onChange={(e) => setShadow(e.target.checked)} disabled={busy} />} label="Đổ bóng" />
        </Stack>

        <Box>
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 0.5 }}>
            Logo có sẵn — bấm để dùng ngay (Xưởng AI), hoặc chọn cả thư mục logo của bạn
          </Typography>
          <Stack direction="row" spacing={1} sx={{ flexWrap: 'wrap', gap: 1 }}>
            {BRAND_LOGOS.map((b) => (
              <Button key={b.id} size="small" variant="contained" color="secondary"
                startIcon={<ImageIcon />} onClick={() => applyBrandLogo(b)} disabled={busy}>
                {b.label}
              </Button>
            ))}
            <Button size="small" variant="outlined" startIcon={<FolderOpenIcon />}
              onClick={() => logoDirRef.current?.click()} disabled={busy}>
              Chọn thư mục logo…
            </Button>
            <input ref={logoDirRef} type="file" hidden multiple
              accept="image/png,image/webp,image/jpeg" onChange={pickLogoDir} />
          </Stack>
          {logoLib.length > 0 && (
            <Box sx={{ mt: 1, display: 'flex', flexWrap: 'wrap', gap: 1, maxHeight: 168, overflowY: 'auto' }}>
              {logoLib.map((l) => (
                <Tooltip key={l.name} title={l.name} arrow>
                  <Box component="button" type="button" disabled={busy} onClick={() => applyLibLogo(l)}
                    sx={{ width: 56, height: 56, p: 0.5, borderRadius: 1, bgcolor: '#1b1b1b', cursor: 'pointer',
                      border: '2px solid', borderColor: logoFile && logoFile.name === l.name ? 'primary.main' : 'divider',
                      display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    <Box component="img" src={l.url} alt={l.name}
                      sx={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }} />
                  </Box>
                </Tooltip>
              ))}
            </Box>
          )}
        </Box>

        <Stack direction="row" spacing={2} alignItems="center" sx={{ flexWrap: 'wrap', rowGap: 1 }}>
          <Button variant="outlined" size="small" startIcon={<ImageIcon />} onClick={() => logoRef.current?.click()} disabled={busy}>
            {logoFile ? 'Logo: ' + logoFile.name : 'Chọn logo khác (PNG, tuỳ chọn)'}
          </Button>
          {logoFile && <Button size="small" color="inherit" onClick={() => setLogoFile(null)} disabled={busy}>Bỏ logo</Button>}
          <input ref={logoRef} type="file" hidden accept="image/png,image/webp,image/jpeg" onChange={pickLogo} />
          <FormControl size="small" sx={{ minWidth: 190 }} disabled={busy}>
            <InputLabel id="q">Chất lượng</InputLabel>
            <Select labelId="q" label="Chất lượng" value={crf} onChange={(e) => setCrf(e.target.value)}>
              <MenuItem value={23}>Nhẹ (CRF 23)</MenuItem>
              <MenuItem value={20}>Tiêu chuẩn (CRF 20)</MenuItem>
              <MenuItem value={18}>Cao (CRF 18)</MenuItem>
              <MenuItem value={14}>Rất cao – chữ nét nhất (CRF 14)</MenuItem>
            </Select>
          </FormControl>
          <FormControl size="small" sx={{ minWidth: 200 }} disabled={busy}>
            <InputLabel id="nm">Tên file lưu</InputLabel>
            <Select labelId="nm" label="Tên file lưu" value={nameMode} onChange={(e) => setNameMode(e.target.value)}>
              <MenuItem value="name_text">Tên gốc + chữ watermark</MenuItem>
              <MenuItem value="text_only">Chỉ chữ watermark</MenuItem>
              <MenuItem value="wm_prefix">wm_ + tên gốc</MenuItem>
            </Select>
          </FormControl>
        </Stack>
        {logoFile && (
          <Box>
            <Typography variant="caption" color="text.secondary">Kích thước (độ rộng) logo theo bề ngang video — hoặc kéo ô vuông của khung logo trên khung xem trước: {logoScale.toFixed(2)}</Typography>
            <Slider size="small" min={0.05} max={0.6} step={0.01} value={logoScale} disabled={busy} onChange={(_, v) => setLogoScale(v)} />
          </Box>
        )}

        <Divider />
        <Button size="small" color="inherit" onClick={() => setAdvOpen((o) => !o)} sx={{ alignSelf: 'flex-start' }}>
          {advOpen ? '▾' : '▸'} Watermark ẩn (nâng cao)
        </Button>
        <Collapse in={advOpen}>
          <Stack spacing={1.5} sx={{ pl: 1 }}>
            <FormControlLabel control={<Switch checked={hidden} onChange={(e) => setHidden(e.target.checked)} disabled={busy} />}
              label="Nhúng watermark ẩn (bền qua re-encode)" />
            <Stack direction="row" spacing={2} sx={{ flexWrap: 'wrap', rowGap: 1 }}>
              <TextField label="Mật khẩu" size="small" value={password} onChange={(e) => setPassword(e.target.value)} disabled={busy || !hidden} />
              <TextField label="Nội dung ẩn (payload)" size="small" value={payload} onChange={(e) => setPayload(e.target.value)} disabled={busy || !hidden} />
            </Stack>
            <Typography variant="caption" color="text.secondary">
              Để trích xuất sau này cần đúng mật khẩu + số byte (in ra khi nhúng). Watermark ẩn xử lý từng khung nên chậm hơn.
            </Typography>
          </Stack>
        </Collapse>

        <Stack direction="row" spacing={1.5} alignItems="center" sx={{ mt: 1 }}>
          {!busy ? (
            <Button variant="contained" startIcon={<AutoFixHighIcon />} onClick={run} disabled={!file || !available}>
              Thêm watermark &amp; Lưu
            </Button>
          ) : (
            <Button variant="contained" color="error" startIcon={<StopIcon />} onClick={stop}>Dừng</Button>
          )}
          {status === 'done' && (
            <Tooltip title="Mở video kết quả">
              <IconButton color="success" onClick={openResult}><PlayArrowIcon /></IconButton>
            </Tooltip>
          )}
          {status === 'done' && (
            <Tooltip title="Mở thư mục chứa file">
              <IconButton onClick={openFolder}><FolderOpenIcon /></IconButton>
            </Tooltip>
          )}
          {status === 'done' && <Chip size="small" color="success" icon={<CheckCircleIcon />} label="Xong" />}
          {status === 'error' && <Chip size="small" color="error" icon={<ErrorIcon />} label={info || 'Lỗi'} />}
          {status === 'cancelled' && <Chip size="small" color="warning" label="Đã huỷ" />}
        </Stack>

        {busy && (
          <Box>
            <LinearProgress variant="determinate" value={pct} sx={{ height: 6, borderRadius: 3 }} />
            <Typography variant="caption" color="text.secondary">{info || 'Đang xử lý…'} {pct}%</Typography>
          </Box>
        )}
        {savedPath && (
          <Typography variant="caption" color="text.secondary" noWrap title={savedPath}>➜ {savedPath}</Typography>
        )}
        {hiddenBytes ? (
          <Typography variant="caption" color="warning.main" sx={{ display: 'block' }}>
            Watermark ẩn: <b>{hiddenBytes} byte</b> — ghi lại số này + mật khẩu để trích xuất sau.
          </Typography>
        ) : null}
        <Typography variant="caption" color="text.secondary">
          File lưu vào: <b>{outputDir || '…'}</b>
        </Typography>
      </Stack>
        </Box>
      </Box>
    </Box>
  );
}
