"""ffmpeg/ffprobe integration: metadata probe, binary resolver, frame pipes, runner."""

from __future__ import annotations

import contextlib
import json
import shutil
import subprocess
import threading
from dataclasses import dataclass

import numpy as np

from .utils import WatermarkError, log


def resolve_ffmpeg(override: str | None = None) -> str:
    """Return path to an ffmpeg binary: explicit override -> PATH -> imageio bundled."""
    if override:
        return override
    found = shutil.which("ffmpeg")
    if found:
        return found
    try:
        import imageio_ffmpeg
        return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception as exc:  # pragma: no cover - only when nothing is installed
        raise WatermarkError(
            "ffmpeg not found on PATH and imageio-ffmpeg fallback unavailable. "
            "Install ffmpeg or `pip install imageio-ffmpeg`."
        ) from exc


def resolve_ffprobe(override: str | None = None) -> str:
    """Return path to an ffprobe binary. imageio-ffmpeg does NOT bundle ffprobe."""
    if override:
        return override
    found = shutil.which("ffprobe")
    if found:
        return found
    raise WatermarkError(
        "ffprobe not found on PATH. Install an ffmpeg full build or pass --ffprobe."
    )


@dataclass
class VideoInfo:
    width: int
    height: int
    fps: float
    duration: float
    n_frames: int | None
    has_audio: bool
    pix_fmt: str | None = None

    def as_dict(self) -> dict:
        return {
            "width": self.width,
            "height": self.height,
            "fps": self.fps,
            "duration": self.duration,
            "n_frames": self.n_frames,
            "has_audio": self.has_audio,
            "pix_fmt": self.pix_fmt,
        }


def _parse_fraction(text: str | None) -> float:
    if not text or "/" not in text:
        try:
            return float(text) if text else 0.0
        except ValueError:
            return 0.0
    num, den = text.split("/", 1)
    try:
        d = float(den)
        return float(num) / d if d else 0.0
    except ValueError:
        return 0.0


def probe(path: str, ffprobe: str | None = None) -> VideoInfo:
    """Probe a media file and return its video metadata."""
    exe = resolve_ffprobe(ffprobe)
    cmd = [
        exe, "-v", "error", "-print_format", "json",
        "-show_streams", "-show_format", path,
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0:
        raise WatermarkError(f"ffprobe failed for {path}:\n{proc.stderr.strip()}")
    data = json.loads(proc.stdout or "{}")
    streams = data.get("streams", [])
    video = next((s for s in streams if s.get("codec_type") == "video"), None)
    audio = next((s for s in streams if s.get("codec_type") == "audio"), None)
    if video is None:
        raise WatermarkError(f"No video stream found in {path}")

    fps = _parse_fraction(video.get("avg_frame_rate")) or _parse_fraction(video.get("r_frame_rate"))
    duration = 0.0
    for src in (data.get("format", {}).get("duration"), video.get("duration")):
        if src:
            try:
                duration = float(src)
                break
            except ValueError:
                pass
    nb = video.get("nb_frames")
    if nb and str(nb).isdigit():
        n_frames: int | None = int(nb)
    elif fps and duration:
        n_frames = round(fps * duration)
    else:
        n_frames = None

    return VideoInfo(
        width=int(video["width"]),
        height=int(video["height"]),
        fps=fps or 30.0,
        duration=duration,
        n_frames=n_frames,
        has_audio=audio is not None,
        pix_fmt=video.get("pix_fmt"),
    )


def run_ffmpeg(cmd: list[str]) -> subprocess.CompletedProcess:
    """Run an ffmpeg command (list form), raising WatermarkError on failure."""
    log.debug("ffmpeg run: %s", " ".join(cmd))
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0:
        raise WatermarkError(
            f"ffmpeg failed (exit {proc.returncode}):\n{proc.stderr[-2000:]}"
        )
    return proc


def read_frames(path: str, width: int, height: int, ffmpeg: str | None = None,
                decode_audio: bool = False):
    """Yield raw BGR uint8 frames (H, W, 3) decoded by ffmpeg via a pipe."""
    exe = resolve_ffmpeg(ffmpeg)
    cmd = [
        exe, "-hide_banner", "-loglevel", "error",
        "-i", path,
        "-f", "rawvideo", "-pix_fmt", "bgr24",
        "-vsync", "0",
    ]
    if not decode_audio:
        cmd += ["-an"]
    cmd += ["-"]
    log.debug("ffmpeg read: %s", " ".join(cmd))
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                            bufsize=10 ** 8)
    frame_bytes = width * height * 3
    try:
        while True:
            buf = proc.stdout.read(frame_bytes)
            if not buf or len(buf) < frame_bytes:
                break
            yield np.frombuffer(buf, np.uint8).reshape(height, width, 3)
    finally:
        if proc.stdout:
            proc.stdout.close()
        err = proc.stderr.read().decode("utf-8", "replace") if proc.stderr else ""
        proc.wait()
        if proc.returncode not in (0, None) and err:
            log.debug("ffmpeg reader stderr: %s", err[-1000:])


def read_yuv420p_frames(path: str, width: int, height: int, ffmpeg: str | None = None):
    """Yield (Y, U, V) uint8 planes per frame. Y is (H, W); U/V are (H//2, W//2).

    Operating on ffmpeg's native luma plane (rather than RGB with our own matrix)
    avoids an RGB<->YUV round-trip that would otherwise destroy the watermark.
    """
    if width % 2 or height % 2:
        raise WatermarkError(
            f"yuv420p needs even dimensions, got {width}x{height}; "
            "the invisible watermark requires even width/height."
        )
    exe = resolve_ffmpeg(ffmpeg)
    cmd = [
        exe, "-hide_banner", "-loglevel", "error",
        "-i", path, "-an", "-f", "rawvideo", "-pix_fmt", "yuv420p", "-vsync", "0", "-",
    ]
    log.debug("ffmpeg read yuv: %s", " ".join(cmd))
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                            bufsize=10 ** 8)
    y_bytes = width * height
    c_w, c_h = width // 2, height // 2
    c_bytes = c_w * c_h
    total = y_bytes + 2 * c_bytes
    try:
        while True:
            buf = proc.stdout.read(total)
            if not buf or len(buf) < total:
                break
            y = np.frombuffer(buf[:y_bytes], np.uint8).reshape(height, width)
            u = np.frombuffer(buf[y_bytes:y_bytes + c_bytes], np.uint8).reshape(c_h, c_w)
            v = np.frombuffer(buf[y_bytes + c_bytes:], np.uint8).reshape(c_h, c_w)
            yield y, u, v
    finally:
        if proc.stdout:
            proc.stdout.close()
        err = proc.stderr.read().decode("utf-8", "replace") if proc.stderr else ""
        proc.wait()
        if proc.returncode not in (0, None) and err:
            log.debug("ffmpeg yuv reader stderr: %s", err[-1000:])


class FrameWriter:
    """Writes raw frames to an ffmpeg encoder, muxing the source audio back in.

    Frames are written via ``write(data)`` where data is a bytes object (or ndarray)
    matching ``pix_fmt`` (default ``yuv420p``: Y plane then U then V, concatenated)."""

    def __init__(self, dst: str, src_for_audio: str | None, width: int, height: int,
                 fps: float, has_audio: bool, crf: int = 18, preset: str = "medium",
                 ffmpeg: str | None = None, pix_fmt: str = "yuv420p"):
        exe = resolve_ffmpeg(ffmpeg)
        cmd = [
            exe, "-hide_banner", "-loglevel", "error", "-y",
            "-f", "rawvideo", "-pix_fmt", pix_fmt,
            "-s", f"{width}x{height}", "-r", f"{fps}", "-i", "-",
        ]
        if has_audio and src_for_audio:
            cmd += ["-i", src_for_audio]
        cmd += [
            "-c:v", "libx264", "-pix_fmt", "yuv420p",
            "-crf", str(crf), "-preset", preset,
        ]
        if has_audio and src_for_audio:
            cmd += ["-c:a", "copy", "-map", "0:v:0", "-map", "1:a:0?", "-shortest"]
        else:
            cmd += ["-map", "0:v:0"]
        cmd += ["-movflags", "+faststart", dst]
        log.debug("ffmpeg write: %s", " ".join(cmd))
        self._proc = subprocess.Popen(cmd, stdin=subprocess.PIPE,
                                      stderr=subprocess.PIPE)
        self._stderr_chunks: list[bytes] = []
        self._stderr_thread = threading.Thread(target=self._drain_stderr, daemon=True)
        self._stderr_thread.start()

    def _drain_stderr(self) -> None:
        if self._proc.stderr is None:
            return
        for line in self._proc.stderr:
            self._stderr_chunks.append(line)

    def write(self, data) -> None:
        if isinstance(data, np.ndarray):
            data = np.ascontiguousarray(data, dtype=np.uint8).tobytes()
        self._proc.stdin.write(data)

    def close(self) -> None:
        self._proc.stdin.close()
        self._proc.wait()
        self._stderr_thread.join(timeout=5)
        if self._proc.returncode != 0:
            err = b"".join(self._stderr_chunks).decode("utf-8", "replace")
            raise WatermarkError(f"ffmpeg encoder failed:\n{err[-2000:]}")

    def __enter__(self) -> "FrameWriter":
        return self

    def __exit__(self, exc_type, exc, tb) -> None:
        if exc_type is None:
            self.close()
        else:
            with contextlib.suppress(Exception):
                self._proc.stdin.close()
                self._proc.kill()
