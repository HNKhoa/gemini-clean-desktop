"""Geometry & formatting helpers for the visible watermark (positioning, escaping)."""

from __future__ import annotations

import os

from .utils import WatermarkError

PRESETS = (
    "top-left", "top-right", "bottom-left", "bottom-right", "center", "custom",
)


def compute_xy(video_w: int, video_h: int, ov_w: int, ov_h: int,
               position: str = "bottom-right", margin: int = 24,
               custom_xy: tuple[int, int] | None = None) -> tuple[int, int]:
    """Return integer (x, y) top-left coords of an overlay within a frame."""
    if position == "custom":
        if custom_xy is None:
            raise WatermarkError("position='custom' requires custom_xy=(x, y)")
        return int(custom_xy[0]), int(custom_xy[1])
    if position not in PRESETS:
        raise WatermarkError(f"position must be one of {PRESETS}, got {position!r}")
    m = int(margin)
    xs = {"left": m, "right": video_w - ov_w - m, "center": (video_w - ov_w) // 2}
    ys = {"top": m, "bottom": video_h - ov_h - m, "center": (video_h - ov_h) // 2}
    if position == "center":
        return xs["center"], ys["center"]
    vert, horiz = position.split("-")  # e.g. "bottom-right"
    return xs[horiz], ys[vert]


def position_expr(position: str = "bottom-right", margin: int = 24,
                  w_var: str = "w", h_var: str = "h",
                  ow_var: str = "text_w", oh_var: str = "text_h",
                  custom_xy: tuple[int, int] | None = None) -> tuple[str, str]:
    """Return ffmpeg x/y *expression* strings for drawtext (w/h/text_w/text_h)
    or overlay (W/H/w/h). Evaluated by ffmpeg at runtime."""
    if position == "custom":
        if custom_xy is None:
            raise WatermarkError("position='custom' requires custom_xy=(x, y)")
        return str(int(custom_xy[0])), str(int(custom_xy[1]))
    if position not in PRESETS:
        raise WatermarkError(f"position must be one of {PRESETS}, got {position!r}")
    m = int(margin)
    xs = {
        "left": f"{m}",
        "right": f"{w_var}-{ow_var}-{m}",
        "center": f"({w_var}-{ow_var})/2",
    }
    ys = {
        "top": f"{m}",
        "bottom": f"{h_var}-{oh_var}-{m}",
        "center": f"({h_var}-{oh_var})/2",
    }
    if position == "center":
        return xs["center"], ys["center"]
    vert, horiz = position.split("-")
    return xs[horiz], ys[vert]


def resolve_font_path(font: str) -> str | None:
    """Resolve a font name/path to an absolute .ttf/.otf path (None if not found).

    Using an explicit fontfile avoids ffmpeg's fontconfig lookup, which is often
    unconfigured (and crashes) on Windows."""
    win_fonts = os.path.join(os.environ.get("WINDIR", r"C:\Windows"), "Fonts")
    name = font if font.lower().endswith((".ttf", ".otf")) else font + ".ttf"
    candidates = []
    if os.path.isfile(font):
        candidates.append(font)
    candidates += [os.path.join(win_fonts, name), os.path.join(win_fonts, "arial.ttf")]
    for cand in candidates:
        if os.path.isfile(cand):
            return os.path.abspath(cand)
    return None


def escape_fontfile(path: str) -> str:
    """Escape a Windows font path for an ffmpeg filtergraph (drive colon, slashes)."""
    p = path.replace("\\", "/").replace(":", r"\:")
    return p


def color_with_opacity(color: str, opacity: float) -> str:
    """Format an ffmpeg color token with alpha, e.g. white@0.5."""
    return f"{color}@{float(opacity):g}"


def scale_px(video_w: int, scale: float) -> int:
    """Absolute pixel width = fraction of the video width (even number for codecs)."""
    px = max(2, int(round(video_w * float(scale))))
    return px - (px % 2)
