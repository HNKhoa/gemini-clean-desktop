"""
AI watermark removal for video (LaMa inpainting via ONNX Runtime).

Pipeline: ffmpeg-decode every frame -> detect the static Gemini sparkle once
(NCC of the alpha template + a bottom-right positional prior) -> LaMa-inpaint a
context window around it per frame -> ffmpeg-encode back with the original audio.
This RECONSTRUCTS the background under the logo (grids, textures, any colour),
unlike reverse-alpha which can leave a faint trace. CPU is slow; DirectML/CUDA GPU
is used automatically when available.

Model: opencv/inpainting_lama (Apache-2.0), inputs image(1x3x512x512 BGR /255) +
mask(1x1x512x512, 1=inpaint), output(1x3x512x512). Downloaded once to the data dir.
"""
import os
import json
import shutil
import tempfile
import subprocess
import pathlib
import threading

import numpy as np
import onnxruntime as ort
from PIL import Image, ImageFilter

HERE = pathlib.Path(__file__).resolve().parent
ALPHA_PATH = HERE / "lama_alpha96.f32"

# Output quality presets (libx264 crf, preset). Lower CRF = higher quality + bigger
# file. The source is already lossy, so "near_lossless" (CRF 12) is the practical
# ceiling — CRF 0 only bloats the file preserving the source's own artifacts.
QUALITY = {
    "standard": (18, "medium"),
    "high": (16, "slow"),
    "near_lossless": (12, "slow"),
}

_session = None
_alpha96 = None
_session_lock = threading.Lock()
_alpha_lock = threading.Lock()


class Cancelled(Exception):
    """Raised to abort processing when the caller requests cancellation."""


def _model_path() -> str:
    p = os.environ.get("GCD_LAMA_MODEL")
    if p:
        return p
    return str(pathlib.Path.home() / ".gemini-clean" / "models" / "inpainting_lama.onnx")


def _preload_cuda():
    # Make the CUDA/cuDNN/cuFFT DLLs from the nvidia-*-cu12 pip wheels loadable so the
    # CUDAExecutionProvider can initialise (onnxruntime-gpu builds only). No-op on the
    # CPU/DirectML builds and when the libs aren't installed.
    try:
        if hasattr(ort, "preload_dlls"):
            ort.preload_dlls()
    except Exception:
        pass


def _build_session(model, providers):
    so = ort.SessionOptions()
    so.log_severity_level = 4  # quiet: we probe providers and handle failures ourselves
    return ort.InferenceSession(model, sess_options=so, providers=providers)


def _warmup(sess):
    # One dummy inference validates the provider actually executes this model. LaMa's
    # Fourier-conv ops fail on some GPU EPs (notably DirectML: "parameter is incorrect")
    # only at run time, so creating the session is not enough — we must run it.
    img = np.zeros((1, 3, 512, 512), np.float32)
    mask = np.zeros((1, 1, 512, 512), np.float32)
    sess.run(["output"], {"image": img, "mask": mask})


def get_session():
    global _session
    if _session is None:
        with _session_lock:  # double-checked: build the heavy ORT session once
            if _session is None:
                model = _model_path()
                if not os.path.exists(model):
                    raise FileNotFoundError(f"LaMa model not found at {model}")
                _preload_cuda()
                avail = set(ort.get_available_providers())
                # Prefer a GPU EP, but VALIDATE it with a warm-up run and fall back to
                # CPU if it can't actually execute the model (DirectML reliably fails on
                # LaMa's FFC MatMul). CPU always works (slower).
                candidates = []
                for p in ("CUDAExecutionProvider", "DmlExecutionProvider"):
                    if p in avail:
                        candidates.append([p, "CPUExecutionProvider"])
                candidates.append(["CPUExecutionProvider"])
                last_err = None
                for provs in candidates:
                    try:
                        s = _build_session(model, provs)
                        _warmup(s)
                        _session = s
                        break
                    except Exception as e:  # provider can't run this model -> try next
                        last_err = e
                if _session is None:
                    raise last_err or RuntimeError("no working ONNX Runtime provider for the model")
    return _session


def active_provider() -> str:
    try:
        return get_session().get_providers()[0]
    except Exception:
        return "unknown"


def _alpha():
    global _alpha96
    if _alpha96 is None:
        with _alpha_lock:
            if _alpha96 is None:
                _alpha96 = np.fromfile(ALPHA_PATH, dtype=np.float32).reshape(96, 96)
    return _alpha96


def ffmpeg_available() -> bool:
    return shutil.which("ffmpeg") is not None and shutil.which("ffprobe") is not None


def _run(cmd, what):
    """Run a subprocess (argv list, no shell), raising a clear error with ffmpeg's
    stderr tail on failure instead of an opaque CalledProcessError."""
    p = subprocess.run(cmd, capture_output=True, text=True)
    if p.returncode != 0:
        tail = (p.stderr or "").strip().splitlines()
        msg = " ".join(tail[-3:])[-400:] if tail else f"exit {p.returncode}"
        raise RuntimeError(f"{what} failed: {msg}")
    return p


def _parse_fps(v):
    try:
        num, den = str(v).split("/")
        num, den = float(num), float(den)
        return num / den if den else 0.0
    except Exception:
        return 0.0


def _ffprobe(path):
    p = _run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries",
              "stream=width,height,r_frame_rate,avg_frame_rate", "-of", "json", path], "ffprobe")
    streams = json.loads(p.stdout or "{}").get("streams") or []
    if not streams:
        raise RuntimeError("input is not a decodable video (no video stream)")
    s = streams[0]
    # Prefer avg_frame_rate so a constant-fps re-encode matches the real duration
    # (variable-fps clips keep audio in sync); fall back to r_frame_rate.
    fps = _parse_fps(s.get("avg_frame_rate")) or _parse_fps(s.get("r_frame_rate")) or 30.0
    return int(s["width"]), int(s["height"]), fps


def _has_audio(path):
    try:
        p = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "a", "-show_entries",
                            "stream=index", "-of", "csv=p=0", path], capture_output=True, text=True)
        return bool((p.stdout or "").strip())
    except Exception:
        return False


def _resize(arr, oh, ow, nearest=False):
    return np.asarray(Image.fromarray(arr).resize((ow, oh), Image.NEAREST if nearest else Image.BILINEAR))


def _locate(avg, W, H, alpha96):
    longSide = max(W, H)
    scale = min(1.0, 440.0 / longSide)
    ww = max(8, round(W * scale))
    hh = max(8, round(H * scale))
    small = _resize(avg, hh, ww)
    L = (0.299 * small[:, :, 0] + 0.587 * small[:, :, 1] + 0.114 * small[:, :, 2]).astype(np.float32)
    minDim = min(W, H)
    inv = 1.0 / scale
    # Gemini's sparkle sits at the standard bottom-right position. Bias detection
    # there with a soft prior so a star-like background feature elsewhere (e.g. a
    # grid intersection) can't outscore the real watermark. Prior stays >= 0.5 so a
    # strong genuine match in an unusual spot can still win. Compare on weighted
    # score, but threshold on the RAW correlation.
    maxDim = max(W, H)
    if maxDim >= 3840:
        logo, mr, mb = 96, 64, 64
    elif maxDim >= 1920:
        logo, mr, mb = 72, 108, 108
    else:
        logo, mr, mb = 48, 72, 72
    pcx = W - mr - logo / 2.0
    pcy = H - mb - logo / 2.0
    sig2 = (0.22 * minDim) ** 2
    best = (-2.0, -2.0, 0, 0, 0)  # (weighted, raw, x, y, ts)
    for f in (0.035, 0.045, 0.055, 0.065, 0.08):
        ss = round(f * minDim)
        if ss < 24:
            continue
        ts = max(8, round(ss * scale))
        if ts >= ww or ts >= hh:
            continue
        t = np.asarray(Image.fromarray(alpha96).resize((ts, ts), Image.BILINEAR)).astype(np.float32)
        t = t - t.mean()
        tden = float(np.sqrt((t * t).sum())) or 1e-6
        step = max(1, round(ts / 5))
        for y in range(0, hh - ts + 1, step):
            for x in range(0, ww - ts + 1, step):
                r = L[y:y + ts, x:x + ts]
                r = r - r.mean()
                ncc = float((r * t).sum() / ((float(np.sqrt((r * r).sum())) or 1e-6) * tden))
                ccx = (x + ts / 2.0) * inv
                ccy = (y + ts / 2.0) * inv
                dist2 = (ccx - pcx) ** 2 + (ccy - pcy) ** 2
                prior = 0.5 + 0.5 * float(np.exp(-dist2 / sig2))
                w = ncc * prior
                if w > best[0]:
                    best = (w, ncc, x, y, ts)
    if best[1] < 0.42:
        return None
    x = round(best[2] * inv); y = round(best[3] * inv); s = round(best[4] * inv)
    s = min(s, W - x, H - y)
    if s < 16:
        return None
    return (x, y, s, round(best[1], 3))


def _detect_box(frames_dir, files, W, H):
    idxs = np.linspace(0, len(files) - 1, min(8, len(files))).astype(int)
    acc = np.zeros((H, W, 3), np.float64)
    n = 0
    for i in idxs:
        a = np.asarray(Image.open(os.path.join(frames_dir, files[i])).convert("RGB"))
        acc += a
        n += 1
    avg = (acc / max(1, n)).astype(np.uint8)
    return _locate(avg, W, H, _alpha())


def _encode(frames_dir, fps, in_path, out_path, crf=18, preset="medium"):
    # Video re-encode at the chosen quality (lower CRF = higher quality). Resolution
    # is preserved. Audio is COPIED untouched when possible (no re-encode = no audio
    # quality loss); only if the source audio can't be copied into MP4 do we fall
    # back to a high-bitrate AAC re-encode.
    base = ["ffmpeg", "-y", "-loglevel", "error", "-framerate", f"{fps}",
            "-i", os.path.join(frames_dir, "%05d.png")]
    venc = ["-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", str(crf), "-preset", preset]
    if _has_audio(in_path):
        amap = ["-i", in_path, "-map", "0:v", "-map", "1:a", "-shortest"]
        try:
            _run(base + amap + ["-c:a", "copy"] + venc + [out_path], "ffmpeg encode")
            return
        except Exception:
            pass  # audio not MP4-copyable → re-encode
        _run(base + amap + ["-c:a", "aac", "-b:a", "192k"] + venc + [out_path], "ffmpeg encode")
    else:
        _run(base + venc + [out_path], "ffmpeg encode")


def process_video(in_path, out_path, progress=None, should_cancel=None, quality="standard"):
    """Inpaint the watermark out of a video.
    progress(done, total, stage); should_cancel() -> truthy aborts (raises Cancelled);
    quality in QUALITY (standard | high | near_lossless)."""
    if not ffmpeg_available():
        raise RuntimeError("ffmpeg/ffprobe not found in PATH")
    crf, preset = QUALITY.get(quality, QUALITY["standard"])

    def _ck():
        if should_cancel and should_cancel():
            raise Cancelled()

    W, H, fps = _ffprobe(in_path)
    tmp = tempfile.mkdtemp(prefix="gcd_lama_")
    fin = os.path.join(tmp, "in"); fout = os.path.join(tmp, "out")
    os.makedirs(fin); os.makedirs(fout)
    try:
        _run(["ffmpeg", "-y", "-loglevel", "error", "-i", in_path, "-vsync", "0",
              os.path.join(fin, "%05d.png")], "ffmpeg decode")
        files = sorted(os.listdir(fin))
        total = len(files)
        if total == 0:
            raise RuntimeError("no frames decoded from input")
        _ck()
        box = _detect_box(fin, files, W, H)

        if box is None:
            # Nothing to remove → preserve the original losslessly (all streams).
            try:
                _run(["ffmpeg", "-y", "-loglevel", "error", "-i", in_path, "-map", "0",
                      "-c", "copy", out_path], "ffmpeg remux")
            except Exception:
                _encode(fin, fps, in_path, out_path, crf, preset)  # fallback re-encode
            if progress:
                progress(total, total, "encode")
            return {"box": None, "frames": total, "provider": active_provider()}

        sess = get_session()
        bx, by, size, _ = box
        # Context window around the logo; grow it for big logos so the whole logo
        # plus surroundings always fits (and never produces a negative/overflow mask
        # offset on very high-resolution sources).
        ctx = min(min(W, H), max(256, size * 3))
        ctx -= ctx % 2
        cx, cy = bx + size // 2, by + size // 2
        x0 = min(max(cx - ctx // 2, 0), max(0, W - ctx))
        y0 = min(max(cy - ctx // 2, 0), max(0, H - ctx))
        a = np.asarray(Image.fromarray(_alpha()).resize((size, size), Image.BILINEAR))
        mask = np.zeros((ctx, ctx), np.uint8)
        iy, ix = max(0, by - y0), max(0, bx - x0)
        wy, wx = min(size, ctx - iy), min(size, ctx - ix)
        if wy > 0 and wx > 0:
            mask[iy:iy + wy, ix:ix + wx] = (a[:wy, :wx] > 0.02).astype(np.uint8)
        mask = (np.asarray(Image.fromarray((mask * 255)).filter(ImageFilter.MaxFilter(11))) > 0).astype(np.uint8)
        mask512 = (_resize(mask, 512, 512, nearest=True) > 0).astype(np.float32)[None, None]
        feather = (np.asarray(Image.fromarray((mask * 255)).filter(ImageFilter.GaussianBlur(2))).astype(np.float32) / 255.0)[:, :, None]

        if progress:
            progress(0, total, "inpaint")
        for k, fn in enumerate(files):
            _ck()
            img = np.asarray(Image.open(os.path.join(fin, fn)).convert("RGB"))
            win = img[y0:y0 + ctx, x0:x0 + ctx].astype(np.uint8)
            img512 = _resize(win, 512, 512).astype(np.float32) / 255.0
            inp = np.transpose(img512[:, :, ::-1], (2, 0, 1))[None].astype(np.float32)  # BGR NCHW
            out = sess.run(["output"], {"image": inp, "mask": mask512})[0][0]
            out = np.clip(np.transpose(out, (1, 2, 0)), 0, 255).astype(np.uint8)[:, :, ::-1]  # -> RGB
            out_ctx = _resize(out, ctx, ctx)
            blended = (win * (1 - feather) + out_ctx * feather).astype(np.uint8)
            img = img.copy()
            img[y0:y0 + ctx, x0:x0 + ctx] = blended
            Image.fromarray(img).save(os.path.join(fout, fn))
            if progress:
                progress(k + 1, total, "inpaint")

        _ck()
        if progress:
            progress(total, total, "encode")
        _encode(fout, fps, in_path, out_path, crf, preset)
        return {"box": box, "frames": total, "provider": active_provider()}
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    import sys
    r = process_video(sys.argv[1], sys.argv[2],
                      progress=lambda d, t, s: (print(f"{s} {d}/{t}", flush=True) if d % 30 == 0 or d == t else None))
    print("DONE", r)
