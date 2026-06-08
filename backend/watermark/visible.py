"""Visible watermark: text and/or logo overlay.

Primary engine renders a full-frame RGBA overlay with Pillow (text, rotation,
diagonal tiling, drop-shadow, stroke, logo with opacity) and composites it with a
single ffmpeg ``overlay`` pass. Fast native paths (drawtext / overlay) are opt-in.
Audio is always stream-copied; only the video is re-encoded.
"""

from __future__ import annotations

import math
import os
import random
from dataclasses import dataclass, field

from PIL import Image, ImageColor, ImageDraw, ImageFilter, ImageFont

from . import geometry as _geo
from . import video_io as _io
from .utils import WatermarkError, ensure_input_exists, temp_path, validate_opacity


@dataclass
class TextSpec:
    text: str
    font: str = "arial.ttf"          # path to a .ttf/.otf or a font file name
    fontsize_ratio: float = 0.05     # fraction of video height
    fontsize_px: int | None = None
    color: str = "white"
    opacity: float = 0.5
    stroke_width: int = 0
    stroke_color: str = "black"
    shadow: bool = False
    shadow_offset: tuple[int, int] = (2, 2)
    shadow_color: str = "black"
    rotate: float = 0.0              # degrees (CCW)
    tile: bool = False               # repeating diagonal pattern
    tile_spacing: float = 1.6        # pitch as multiple of tile size
    sparkle: bool = False            # draw a Gemini/Veo-style spark ✦ before the text
    glow: bool = False               # soft glow halo (Veo look)


@dataclass
class LogoSpec:
    path: str
    scale: float = 0.15              # fraction of video width
    opacity: float = 1.0


@dataclass
class VisibleWatermarker:
    text: TextSpec | str | None = None
    logo: LogoSpec | str | None = None
    position: str = "bottom-right"   # presets | center | custom | random
    margin: int = 24
    custom_xy: tuple[int, int] | None = None
    motion: str = "none"             # none | random | bounce (move over time)
    motion_interval: float = 3.0     # seconds between random jumps
    motion_speed: tuple[float, float] = (120.0, 80.0)  # px/s for bounce mode
    seed: int | None = None          # reproducible randomness (position/motion)
    engine: str = "auto"             # auto | pillow | drawtext | ffmpeg
    crf: int = 20
    preset: str = "medium"
    ffmpeg: str | None = None
    ffprobe: str | None = None
    _text: TextSpec | None = field(init=False, default=None)
    _logo: LogoSpec | None = field(init=False, default=None)
    _rng: random.Random = field(init=False, default=None)

    def __post_init__(self):
        self._rng = random.Random(self.seed)
        if self.motion not in ("none", "random", "bounce"):
            raise WatermarkError("motion must be 'none', 'random' or 'bounce'")
        if isinstance(self.text, str):
            self._text = TextSpec(text=self.text)
        else:
            self._text = self.text
        if isinstance(self.logo, str):
            self._logo = LogoSpec(path=self.logo)
        else:
            self._logo = self.logo
        if self._text is None and self._logo is None:
            raise WatermarkError("provide at least one of text or logo")
        if self._text is not None:
            validate_opacity(self._text.opacity, "text opacity")
        if self._logo is not None:
            validate_opacity(self._logo.opacity, "logo opacity")
            ensure_input_exists(self._logo.path)

    # ------------------------------------------------------------------ #
    def apply(self, input_path: str, output_path: str) -> str:
        ensure_input_exists(input_path)
        info = _io.probe(input_path, ffprobe=self.ffprobe)
        if self.motion != "none":
            # Moving watermark: a small tile positioned by time-varying ffmpeg
            # expressions (overrides engine/tile/static position).
            self._apply_motion(input_path, output_path, info)
            return output_path
        engine = self._resolve_engine()
        if engine == "pillow":
            self._apply_pillow(input_path, output_path, info)
        elif engine == "drawtext":
            self._apply_drawtext(input_path, output_path, info)
        else:  # ffmpeg native overlay
            self._apply_native_logo(input_path, output_path, info)
        return output_path

    def _resolve_engine(self) -> str:
        if self.engine != "auto":
            if self.position == "random" and self.engine in ("drawtext", "ffmpeg"):
                raise WatermarkError(
                    "position='random' is only supported with engine 'auto'/'pillow'"
                )
            return self.engine
        # Default to the robust Pillow path for everything.
        return "pillow"

    def _resolve_xy(self, w: int, h: int, ov_w: int, ov_h: int) -> tuple[int, int]:
        if self.position == "random":
            return (self._rng.randint(0, max(0, w - ov_w)),
                    self._rng.randint(0, max(0, h - ov_h)))
        return _geo.compute_xy(w, h, ov_w, ov_h, self.position, self.margin,
                               self.custom_xy)

    # ------------------------------------------------------------------ #
    # Pillow path
    # ------------------------------------------------------------------ #
    def _apply_pillow(self, input_path, output_path, info):
        canvas = self._build_overlay(info.width, info.height)
        with temp_path(suffix=".png") as png:
            canvas.save(png)
            cmd = [
                _io.resolve_ffmpeg(self.ffmpeg), "-hide_banner", "-loglevel", "error",
                "-y", "-i", input_path, "-i", png,
                "-filter_complex", "[0:v][1:v]overlay=0:0:format=auto:alpha=straight[v]",
                "-map", "[v]",
            ]
            if info.has_audio:
                cmd += ["-map", "0:a:0?", "-c:a", "copy"]
            cmd += [
                "-c:v", "libx264", "-crf", str(self.crf), "-preset", self.preset,
                "-pix_fmt", "yuv420p", "-movflags", "+faststart", output_path,
            ]
            _io.run_ffmpeg(cmd)

    def _build_overlay(self, w: int, h: int) -> Image.Image:
        canvas = Image.new("RGBA", (w, h), (0, 0, 0, 0))
        if self._text is not None:
            tile = self._render_text_tile(self._text, h)
            if self._text.tile:
                self._tile_onto(canvas, tile, self._text.tile_spacing)
            else:
                x, y = self._resolve_xy(w, h, tile.width, tile.height)
                canvas.paste(tile, (x, y), tile)
        if self._logo is not None:
            logo = self._render_logo(self._logo, w)
            x, y = self._resolve_xy(w, h, logo.width, logo.height)
            canvas.paste(logo, (x, y), logo)
        return canvas

    def _render_watermark_tile(self, w: int, h: int) -> Image.Image:
        """Render a small, tight RGBA tile (text and/or logo) for a moving overlay."""
        parts = []
        if self._text is not None:
            parts.append(self._render_text_tile(self._text, h))
        if self._logo is not None:
            parts.append(self._render_logo(self._logo, w))
        if len(parts) == 1:
            return parts[0]
        # stack vertically, centered, with a small gap
        gap = 6
        tw = max(p.width for p in parts)
        th = sum(p.height for p in parts) + gap * (len(parts) - 1)
        tile = Image.new("RGBA", (tw, th), (0, 0, 0, 0))
        y = 0
        for p in parts:
            tile.paste(p, ((tw - p.width) // 2, y), p)
            y += p.height + gap
        return tile

    # ------------------------------------------------------------------ #
    # Moving watermark (random jumps or bouncing) via time-varying overlay
    # ------------------------------------------------------------------ #
    def _apply_motion(self, input_path, output_path, info):
        tile = self._render_watermark_tile(info.width, info.height)
        x_max = max(0, info.width - tile.width)
        y_max = max(0, info.height - tile.height)
        duration = info.duration or (
            info.n_frames / info.fps if info.n_frames and info.fps else 10.0)
        x_expr, y_expr = self._motion_exprs(x_max, y_max, duration)
        with temp_path(suffix=".png") as png:
            tile.save(png)
            fc = (f"[0:v][1:v]overlay=x='{x_expr}':y='{y_expr}':"
                  f"eval=frame:format=auto:alpha=straight[v]")
            cmd = [
                _io.resolve_ffmpeg(self.ffmpeg), "-hide_banner", "-loglevel", "error",
                "-y", "-i", input_path, "-i", png,
                "-filter_complex", fc, "-map", "[v]",
            ]
            if info.has_audio:
                cmd += ["-map", "0:a:0?", "-c:a", "copy"]
            cmd += ["-c:v", "libx264", "-crf", str(self.crf), "-preset", self.preset,
                    "-pix_fmt", "yuv420p", "-movflags", "+faststart", output_path]
            _io.run_ffmpeg(cmd)

    def _motion_exprs(self, x_max: int, y_max: int, duration: float) -> tuple[str, str]:
        if self.motion == "bounce":
            vx, vy = self.motion_speed
            x = (f"abs(mod(t*{vx:g},2*{x_max})-{x_max})" if x_max > 0 else "0")
            y = (f"abs(mod(t*{vy:g},2*{y_max})-{y_max})" if y_max > 0 else "0")
            return x, y
        # random jumps: precompute a position per interval (seeded, reproducible)
        interval = max(0.1, float(self.motion_interval))
        steps = max(1, int(math.ceil(duration / interval)) + 1)
        xs = [self._rng.randint(0, x_max) for _ in range(steps)]
        ys = [self._rng.randint(0, y_max) for _ in range(steps)]
        return (self._piecewise(xs, interval), self._piecewise(ys, interval))

    @staticmethod
    def _piecewise(values: list[int], interval: float) -> str:
        """Build an ffmpeg expression selecting values[i] while t in [i*I, (i+1)*I)."""
        expr = str(values[-1])
        for i in range(len(values) - 2, -1, -1):
            expr = f"if(lt(t,{(i + 1) * interval:.3f}),{values[i]},{expr})"
        return expr

    @staticmethod
    def _load_font(font: str, size: int) -> ImageFont.FreeTypeFont:
        win_fonts = os.path.join(os.environ.get("WINDIR", r"C:\Windows"), "Fonts")
        name = font if font.lower().endswith((".ttf", ".otf")) else font + ".ttf"
        candidates = []
        if os.path.isfile(font):
            candidates.append(font)
        candidates += [font, os.path.join(win_fonts, name),
                       os.path.join(win_fonts, "arial.ttf")]
        for cand in candidates:
            try:
                return ImageFont.truetype(cand, size)
            except Exception:
                continue
        try:
            return ImageFont.load_default(size)
        except Exception:  # very old Pillow
            return ImageFont.load_default()

    @classmethod
    def _render_text_tile(cls, spec: TextSpec, video_h: int) -> Image.Image:
        size = spec.fontsize_px or max(8, int(video_h * spec.fontsize_ratio))
        font = cls._load_font(spec.font, size)
        measure = ImageDraw.Draw(Image.new("RGBA", (1, 1)))
        bbox = measure.textbbox((0, 0), spec.text, font=font,
                                stroke_width=spec.stroke_width)
        tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
        sx, sy = spec.shadow_offset if spec.shadow else (0, 0)

        spark = int(size * 0.95) if spec.sparkle else 0
        spark_gap = max(4, size // 5) if spec.sparkle else 0
        pad = spec.stroke_width + max(4, size // 5 if (spec.glow or spec.sparkle) else 4)
        content_h = max(th, spark)
        width = spark + spark_gap + tw + 2 * pad + abs(sx)
        height = content_h + 2 * pad + abs(sy)

        rgb = ImageColor.getrgb(spec.color)[:3]
        stroke_rgb = ImageColor.getrgb(spec.stroke_color)[:3]
        text_x = pad + spark + spark_gap + (abs(sx) if sx < 0 else 0)
        text_y = (height - th) // 2 - bbox[1]
        spark_cx = pad + spark / 2.0
        spark_cy = height / 2.0

        img = Image.new("RGBA", (width, height), (0, 0, 0, 0))

        # soft glow: draw shapes in white on a layer, blur, composite underneath
        if spec.glow:
            glow = Image.new("RGBA", (width, height), (0, 0, 0, 0))
            gdraw = ImageDraw.Draw(glow)
            if spec.sparkle:
                cls._draw_sparkle(gdraw, spark_cx, spark_cy, spark, (255, 255, 255, 255))
            gdraw.text((text_x, text_y), spec.text, font=font, fill=(255, 255, 255, 255),
                       stroke_width=spec.stroke_width, stroke_fill=(255, 255, 255, 255))
            glow = glow.filter(ImageFilter.GaussianBlur(max(2.0, size * 0.18)))
            img = Image.alpha_composite(img, glow)
            img = Image.alpha_composite(img, glow)  # twice for a brighter halo

        draw = ImageDraw.Draw(img)
        if spec.shadow:
            sh = (*ImageColor.getrgb(spec.shadow_color)[:3], 255)
            draw.text((text_x + sx, text_y + sy), spec.text, font=font, fill=sh,
                      stroke_width=spec.stroke_width, stroke_fill=sh)
        if spec.sparkle:
            cls._draw_sparkle(draw, spark_cx, spark_cy, spark, (*rgb, 255))
        draw.text((text_x, text_y), spec.text, font=font, fill=(*rgb, 255),
                  stroke_width=spec.stroke_width, stroke_fill=(*stroke_rgb, 255))

        # apply overall opacity to the whole tile (keeps glow consistent)
        if spec.opacity < 1.0:
            alpha = img.split()[3].point(lambda p: int(p * spec.opacity))
            img.putalpha(alpha)
        if spec.rotate:
            img = img.rotate(spec.rotate, expand=True, resample=Image.BICUBIC)
        return img

    @staticmethod
    def _draw_sparkle(draw, cx: float, cy: float, size: float, color) -> None:
        """Draw a 4-pointed Gemini/Veo-style spark centered at (cx, cy)."""
        r = size / 2.0
        inner = r * 0.20            # small inner radius -> sharp concave points
        pts = []
        for i in range(4):
            a_out = math.radians(90 * i - 90)        # up, right, down, left
            pts.append((cx + r * math.cos(a_out), cy + r * math.sin(a_out)))
            a_in = math.radians(90 * i - 90 + 45)    # waist between points
            pts.append((cx + inner * math.cos(a_in), cy + inner * math.sin(a_in)))
        draw.polygon(pts, fill=color)

    @staticmethod
    def _render_logo(spec: LogoSpec, video_w: int) -> Image.Image:
        logo = Image.open(spec.path).convert("RGBA")
        target_w = _geo.scale_px(video_w, spec.scale)
        ratio = target_w / logo.width
        target_h = max(1, int(round(logo.height * ratio)))
        logo = logo.resize((target_w, target_h), Image.LANCZOS)
        if spec.opacity < 1.0:
            alpha = logo.split()[3].point(lambda p: int(p * spec.opacity))
            logo.putalpha(alpha)
        return logo

    @staticmethod
    def _tile_onto(canvas: Image.Image, tile: Image.Image, spacing: float) -> None:
        w, h = canvas.size
        tw, th = tile.size
        pitch_x = max(1, int(tw * spacing))
        pitch_y = max(1, int(th * spacing))
        row = 0
        y = -th
        while y < h:
            offset = pitch_x // 2 if (row % 2) else 0
            x = -tw + offset
            while x < w:
                canvas.paste(tile, (int(x), int(y)), tile)
                x += pitch_x
            y += pitch_y
            row += 1

    @staticmethod
    def _rgba(color: str, opacity: float) -> tuple[int, int, int, int]:
        r, g, b = ImageColor.getrgb(color)[:3]
        return (r, g, b, int(round(validate_opacity(opacity) * 255)))

    # ------------------------------------------------------------------ #
    # Native fast paths
    # ------------------------------------------------------------------ #
    def _apply_drawtext(self, input_path, output_path, info):
        if self._text is None:
            raise WatermarkError("engine='drawtext' requires a text watermark")
        spec = self._text
        rel = max(1, int(1.0 / spec.fontsize_ratio)) if not spec.fontsize_px else None
        size = f"fontsize={spec.fontsize_px}" if spec.fontsize_px else f"fontsize=h/{rel}"
        xexpr, yexpr = _geo.position_expr(self.position, self.margin,
                                          custom_xy=self.custom_xy)
        font_path = _geo.resolve_font_path(spec.font)
        font_token = (f"fontfile='{_geo.escape_fontfile(font_path)}'"
                      if font_path else f"font='{spec.font}'")
        parts = [
            font_token,
            f"text='{self._escape_text(spec.text)}'",
            f"fontcolor={_geo.color_with_opacity(spec.color, spec.opacity)}",
            size, f"x={xexpr}", f"y={yexpr}",
        ]
        if spec.stroke_width:
            parts += [f"borderw={spec.stroke_width}",
                      f"bordercolor={_geo.color_with_opacity(spec.stroke_color, spec.opacity)}"]
        if spec.shadow:
            parts += [f"shadowx={spec.shadow_offset[0]}", f"shadowy={spec.shadow_offset[1]}",
                      f"shadowcolor={_geo.color_with_opacity(spec.shadow_color, spec.opacity)}"]
        vf = "drawtext=" + ":".join(parts)
        cmd = [
            _io.resolve_ffmpeg(self.ffmpeg), "-hide_banner", "-loglevel", "error",
            "-y", "-i", input_path, "-vf", vf,
        ]
        if info.has_audio:
            cmd += ["-c:a", "copy"]
        cmd += ["-c:v", "libx264", "-crf", str(self.crf), "-preset", self.preset,
                "-pix_fmt", "yuv420p", "-movflags", "+faststart", output_path]
        _io.run_ffmpeg(cmd)

    def _apply_native_logo(self, input_path, output_path, info):
        if self._logo is None:
            raise WatermarkError("engine='ffmpeg' requires a logo watermark")
        spec = self._logo
        px = _geo.scale_px(info.width, spec.scale)
        xexpr, yexpr = _geo.position_expr(self.position, self.margin,
                                          w_var="W", h_var="H", ow_var="w", oh_var="h",
                                          custom_xy=self.custom_xy)
        fc = (f"[1:v]format=rgba,colorchannelmixer=aa={spec.opacity:g},"
              f"scale={px}:-1[wm];"
              f"[0:v][wm]overlay={xexpr}:{yexpr}:format=auto:alpha=straight[v]")
        cmd = [
            _io.resolve_ffmpeg(self.ffmpeg), "-hide_banner", "-loglevel", "error",
            "-y", "-i", input_path, "-i", spec.path,
            "-filter_complex", fc, "-map", "[v]",
        ]
        if info.has_audio:
            cmd += ["-map", "0:a:0?", "-c:a", "copy"]
        cmd += ["-c:v", "libx264", "-crf", str(self.crf), "-preset", self.preset,
                "-pix_fmt", "yuv420p", "-movflags", "+faststart", output_path]
        _io.run_ffmpeg(cmd)

    @staticmethod
    def _escape_text(text: str) -> str:
        return text.replace("\\", r"\\").replace(":", r"\:").replace("'", r"\'")
