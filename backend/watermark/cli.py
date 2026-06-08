"""Command-line interface: embed-visible | embed-hidden | extract-hidden | embed-both | probe."""

from __future__ import annotations

import argparse
import json
import sys

from .invisible import InvisibleWatermarker
from .utils import WatermarkError, setup_logging, temp_path
from .video_io import probe
from .visible import LogoSpec, TextSpec, VisibleWatermarker


# --------------------------------------------------------------------------- #
# argument groups
# --------------------------------------------------------------------------- #
def _add_io(p):
    p.add_argument("-i", "--input", required=True, help="input video path")
    p.add_argument("-o", "--output", required=True, help="output video path")


def _add_visible_opts(p):
    g = p.add_argument_group("visible watermark")
    g.add_argument("--text", help="watermark text")
    g.add_argument("--font", default="arial.ttf", help="font file path or name")
    g.add_argument("--fontsize-ratio", type=float, default=0.05,
                   help="font size as fraction of video height (default 0.05)")
    g.add_argument("--fontsize-px", type=int, help="absolute font size in px")
    g.add_argument("--color", default="white", help="text color (default white)")
    g.add_argument("--opacity", type=float, default=0.5, help="text opacity 0..1")
    g.add_argument("--stroke-width", type=int, default=0)
    g.add_argument("--stroke-color", default="black")
    g.add_argument("--shadow", action="store_true")
    g.add_argument("--shadow-offset", type=int, nargs=2, default=(2, 2),
                   metavar=("X", "Y"))
    g.add_argument("--shadow-color", default="black")
    g.add_argument("--rotate", type=float, default=0.0, help="rotate text (degrees)")
    g.add_argument("--tile", action="store_true", help="repeating diagonal pattern")
    g.add_argument("--tile-spacing", type=float, default=1.6)
    g.add_argument("--sparkle", action="store_true",
                   help="draw a Gemini/Veo-style spark before the text")
    g.add_argument("--glow", action="store_true", help="soft glow halo (Veo look)")
    g.add_argument("--logo", help="logo PNG path")
    g.add_argument("--logo-scale", type=float, default=0.15,
                   help="logo width as fraction of video width")
    g.add_argument("--logo-opacity", type=float, default=1.0)
    g.add_argument("--position", default="bottom-right",
                   choices=["top-left", "top-right", "bottom-left", "bottom-right",
                            "center", "custom", "random"],
                   help="placement; 'random' = random static spot, 'custom' uses --xy")
    g.add_argument("--margin", type=int, default=24)
    g.add_argument("--xy", type=int, nargs=2, metavar=("X", "Y"),
                   help="custom position (with --position custom)")
    g.add_argument("--motion", default="none",
                   choices=["none", "random", "bounce"],
                   help="move the watermark over time: random jumps or DVD-style bounce")
    g.add_argument("--motion-interval", type=float, default=3.0,
                   help="seconds between random jumps (--motion random)")
    g.add_argument("--motion-speed", type=float, nargs=2, default=(120.0, 80.0),
                   metavar=("VX", "VY"), help="px/s for --motion bounce")
    g.add_argument("--seed", type=int, default=None,
                   help="seed for reproducible random position/motion")
    g.add_argument("--engine", default="auto",
                   choices=["auto", "pillow", "drawtext", "ffmpeg"])
    g.add_argument("--crf", type=int, default=20)
    g.add_argument("--preset", default="medium")


def _add_hidden_opts(p, with_output=True):
    g = p.add_argument_group("hidden watermark")
    g.add_argument("--password", required=True, help="secret key for embed/extract")
    g.add_argument("--method", default="qim", choices=["qim", "svd"])
    g.add_argument("--strength", type=float, default=40.0,
                   help="QIM step; bigger = more robust but more visible (default 40)")
    g.add_argument("--block-size", type=int, default=4)
    g.add_argument("--coef", type=int, nargs=2, default=(2, 2), metavar=("U", "V"),
                   help="mid-band DCT coefficient to carry each bit (default 2 2)")
    g.add_argument("--every-nth", type=int, default=1)
    g.add_argument("--hidden-crf", type=int, default=18,
                   help="x264 CRF for the hidden-embed re-encode")
    g.add_argument("--hidden-preset", default="medium")


def _build_visible(args) -> VisibleWatermarker:
    if not args.text and not args.logo:
        raise WatermarkError("provide --text and/or --logo for the visible watermark")
    text = None
    if args.text:
        text = TextSpec(
            text=args.text, font=args.font, fontsize_ratio=args.fontsize_ratio,
            fontsize_px=args.fontsize_px, color=args.color, opacity=args.opacity,
            stroke_width=args.stroke_width, stroke_color=args.stroke_color,
            shadow=args.shadow, shadow_offset=tuple(args.shadow_offset),
            shadow_color=args.shadow_color, rotate=args.rotate, tile=args.tile,
            tile_spacing=args.tile_spacing, sparkle=args.sparkle, glow=args.glow,
        )
    logo = LogoSpec(path=args.logo, scale=args.logo_scale,
                    opacity=args.logo_opacity) if args.logo else None
    return VisibleWatermarker(
        text=text, logo=logo, position=args.position, margin=args.margin,
        custom_xy=tuple(args.xy) if args.xy else None,
        motion=args.motion, motion_interval=args.motion_interval,
        motion_speed=tuple(args.motion_speed), seed=args.seed,
        engine=args.engine, crf=args.crf, preset=args.preset,
        ffmpeg=args.ffmpeg, ffprobe=args.ffprobe,
    )


def _build_hidden(args) -> InvisibleWatermarker:
    return InvisibleWatermarker(
        password=args.password, strength=args.strength, method=args.method,
        block_size=args.block_size, coef=tuple(args.coef), every_nth=args.every_nth,
        crf=getattr(args, "hidden_crf", 18), preset=getattr(args, "hidden_preset", "medium"),
        ffmpeg=args.ffmpeg, ffprobe=args.ffprobe,
    )


# --------------------------------------------------------------------------- #
# command handlers
# --------------------------------------------------------------------------- #
def _cmd_embed_visible(args) -> int:
    wm = _build_visible(args)
    out = wm.apply(args.input, args.output)
    print(f"visible watermark written to {out}")
    return 0


def _cmd_embed_hidden(args) -> int:
    wm = _build_hidden(args)
    stats = wm.embed(args.input, args.output, args.payload)
    print(f"hidden watermark embedded -> {args.output}")
    print(f"  frames={stats['n_frames']} payload={stats['n_bytes']}B "
          f"psnr={stats['psnr']:.1f}dB backend={stats['backend']['dct']}")
    print(f"  to extract: --n-bytes {stats['n_bytes']}")
    return 0


def _cmd_extract_hidden(args) -> int:
    wm = _build_hidden(args)
    message, crc_ok = wm.extract_details(args.input, args.n_bytes)
    print(message)
    if not crc_ok:
        print("[warning] CRC check failed — recovery may be unreliable "
              "(wrong password/length or too much distortion)", file=sys.stderr)
        return 2
    return 0


def _cmd_embed_both(args) -> int:
    visible = _build_visible(args)
    hidden = _build_hidden(args)
    suffix = "." + (args.output.rsplit(".", 1)[-1] if "." in args.output else "mp4")
    with temp_path(suffix=suffix) as tmp:
        if args.order == "visible-first":
            visible.apply(args.input, tmp)
            stats = hidden.embed(tmp, args.output, args.payload)
        else:  # hidden-first
            stats = hidden.embed(args.input, tmp, args.payload)
            visible.apply(tmp, args.output)
    print(f"visible + hidden watermark written to {args.output}")
    print(f"  to extract hidden: --n-bytes {stats['n_bytes']}")
    return 0


def _cmd_probe(args) -> int:
    info = probe(args.input, ffprobe=args.ffprobe).as_dict()
    if args.json:
        print(json.dumps(info, indent=2))
    else:
        for k, v in info.items():
            print(f"{k:10s}: {v}")
    return 0


# --------------------------------------------------------------------------- #
def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="watermark", description="Visible & invisible video watermarking.")
    parser.add_argument("-v", "--verbose", action="count", default=0)
    parser.add_argument("--ffmpeg", help="path to ffmpeg binary")
    parser.add_argument("--ffprobe", help="path to ffprobe binary")
    sub = parser.add_subparsers(dest="command", required=True)

    p = sub.add_parser("embed-visible", help="overlay text and/or logo")
    _add_io(p); _add_visible_opts(p); p.set_defaults(func=_cmd_embed_visible)

    p = sub.add_parser("embed-hidden", help="embed a robust invisible payload")
    _add_io(p); _add_hidden_opts(p)
    p.add_argument("--payload", required=True, help="text to hide")
    p.set_defaults(func=_cmd_embed_hidden)

    p = sub.add_parser("extract-hidden", help="recover an invisible payload")
    p.add_argument("-i", "--input", required=True)
    _add_hidden_opts(p)
    p.add_argument("--n-bytes", type=int, required=True,
                   help="payload length in bytes (printed when embedding)")
    p.set_defaults(func=_cmd_extract_hidden)

    p = sub.add_parser("embed-both", help="visible + hidden in one go")
    _add_io(p); _add_visible_opts(p); _add_hidden_opts(p)
    p.add_argument("--payload", required=True)
    p.add_argument("--order", default="visible-first",
                   choices=["visible-first", "hidden-first"])
    p.set_defaults(func=_cmd_embed_both)

    p = sub.add_parser("probe", help="print video metadata")
    p.add_argument("-i", "--input", required=True)
    p.add_argument("--json", action="store_true")
    p.set_defaults(func=_cmd_probe)

    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    setup_logging(args.verbose)
    try:
        return args.func(args)
    except WatermarkError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
