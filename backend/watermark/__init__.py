"""watermark — visible & invisible (blind, robust) video watermarking toolkit."""

from __future__ import annotations

from .invisible import InvisibleWatermarker
from .video_io import probe
from .visible import LogoSpec, TextSpec, VisibleWatermarker

__version__ = "0.1.0"

__all__ = [
    "VisibleWatermarker",
    "TextSpec",
    "LogoSpec",
    "InvisibleWatermarker",
    "probe",
    "__version__",
]
