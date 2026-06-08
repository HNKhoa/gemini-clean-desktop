"""Shared utilities: errors, logging, temp files, config, validators."""

from __future__ import annotations

import contextlib
import logging
import os
import tempfile
from dataclasses import dataclass

log = logging.getLogger("watermark")


class WatermarkError(RuntimeError):
    """Raised for any user-facing watermarking failure (bad input, ffmpeg error...)."""


def setup_logging(verbose: int = 0) -> None:
    """Configure the package logger. 0=WARNING, 1=INFO, 2+=DEBUG."""
    level = logging.WARNING
    if verbose == 1:
        level = logging.INFO
    elif verbose >= 2:
        level = logging.DEBUG
    logging.basicConfig(
        level=level,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
        datefmt="%H:%M:%S",
    )
    log.setLevel(level)


@contextlib.contextmanager
def temp_path(suffix: str = "", prefix: str = "wtm_"):
    """Yield a temp file path and delete it on exit (even on error)."""
    fd, path = tempfile.mkstemp(suffix=suffix, prefix=prefix)
    os.close(fd)
    try:
        yield path
    finally:
        with contextlib.suppress(OSError):
            os.remove(path)


@dataclass
class WMConfig:
    """Tuning parameters for the invisible (hidden) watermark."""

    method: str = "qim"          # "qim" | "svd"
    block_size: int = 4          # NxN blocks on the LL subband
    coef: tuple[int, int] = (2, 2)  # mid-band DCT coefficient used by QIM
    strength: float = 40.0       # QIM step (Delta) / SVD step; bigger = more robust, more visible
    every_nth: int = 1           # process 1 of every N frames (>=1)

    def validate(self) -> None:
        if self.method not in ("qim", "svd"):
            raise WatermarkError(f"method must be 'qim' or 'svd', got {self.method!r}")
        if self.block_size < 2:
            raise WatermarkError("block_size must be >= 2")
        if self.strength <= 0:
            raise WatermarkError("strength must be > 0")
        if self.every_nth < 1:
            raise WatermarkError("every_nth must be >= 1")
        u, v = self.coef
        if not (0 <= u < self.block_size and 0 <= v < self.block_size):
            raise WatermarkError(f"coef {self.coef} out of range for block_size {self.block_size}")
        if u == 0 and v == 0:
            raise WatermarkError("coef must not be the DC term (0, 0)")


def validate_opacity(value: float, name: str = "opacity") -> float:
    v = float(value)
    if not (0.0 <= v <= 1.0):
        raise WatermarkError(f"{name} must be in [0, 1], got {v}")
    return v


def ensure_input_exists(path: str) -> None:
    if not os.path.isfile(path):
        raise WatermarkError(f"Input file not found: {path}")
