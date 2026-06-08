"""Signal-processing core for the invisible watermark.

Provides colour conversion (BGR<->YCbCr), a single-level orthonormal Haar DWT,
and a batched 2-D type-II DCT. The DCT is accelerated by SciPy when available and
falls back to a pure-numpy basis-matrix implementation that produces identical
(orthonormal) coefficients. The Haar DWT is always pure-numpy so coefficients are
bit-for-bit reproducible across machines (important: a video watermarked on one
host must be extractable on another regardless of which optional libs are present).
"""

from __future__ import annotations

import functools
import math

import numpy as np

try:  # optional accelerator for the DCT (has cp314 wheels)
    from scipy.fft import dctn as _scipy_dctn, idctn as _scipy_idctn
    _HAVE_SCIPY = True
except Exception:  # pragma: no cover - exercised only when scipy is absent
    _HAVE_SCIPY = False

try:  # detected for reporting only; the Haar transform itself stays pure-numpy
    import pywt as _pywt  # noqa: F401
    _HAVE_PYWT = True
except Exception:
    _HAVE_PYWT = False

_SQRT2 = math.sqrt(2.0)


def backends() -> dict:
    """Report which transform backend is active (for diagnostics & tests)."""
    return {
        "dct": "scipy" if _HAVE_SCIPY else "numpy",
        "dwt": "numpy-haar",
        "svd": "numpy",
        "scipy_available": _HAVE_SCIPY,
        "pywt_available": _HAVE_PYWT,
    }


# --------------------------------------------------------------------------- #
# Colour conversion (BT.601 full-range)
# --------------------------------------------------------------------------- #

def bgr_to_ycbcr(frame_bgr: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """uint8 BGR (H, W, 3) -> (Y, Cb, Cr) float64 arrays."""
    f = frame_bgr.astype(np.float64)
    b, g, r = f[..., 0], f[..., 1], f[..., 2]
    y = 0.299 * r + 0.587 * g + 0.114 * b
    cb = -0.168736 * r - 0.331264 * g + 0.5 * b + 128.0
    cr = 0.5 * r - 0.418688 * g - 0.081312 * b + 128.0
    return y, cb, cr


def ycbcr_to_bgr(y: np.ndarray, cb: np.ndarray, cr: np.ndarray) -> np.ndarray:
    """(Y, Cb, Cr) float -> uint8 BGR (H, W, 3)."""
    cb2 = cb - 128.0
    cr2 = cr - 128.0
    r = y + 1.402 * cr2
    g = y - 0.344136 * cb2 - 0.714136 * cr2
    b = y + 1.772 * cb2
    out = np.empty(y.shape + (3,), dtype=np.float64)
    out[..., 0] = b
    out[..., 1] = g
    out[..., 2] = r
    return np.clip(out + 0.5, 0, 255).astype(np.uint8)


# --------------------------------------------------------------------------- #
# Single-level orthonormal Haar DWT (pure numpy, even dimensions required)
# --------------------------------------------------------------------------- #

def dwt2_haar(img: np.ndarray):
    """Return (LL, (LH, HL, HH)) of a single-level Haar DWT. img must have even dims."""
    h, w = img.shape
    if h % 2 or w % 2:
        raise ValueError("dwt2_haar requires even height and width")
    e = img[:, 0::2]
    o = img[:, 1::2]
    low = (e + o) / _SQRT2
    high = (e - o) / _SQRT2
    le, lo = low[0::2, :], low[1::2, :]
    he, ho = high[0::2, :], high[1::2, :]
    ll = (le + lo) / _SQRT2
    lh = (le - lo) / _SQRT2
    hl = (he + ho) / _SQRT2
    hh = (he - ho) / _SQRT2
    return ll, (lh, hl, hh)


def idwt2_haar(ll: np.ndarray, details) -> np.ndarray:
    """Invert a single-level Haar DWT."""
    lh, hl, hh = details
    le = (ll + lh) / _SQRT2
    lo = (ll - lh) / _SQRT2
    he = (hl + hh) / _SQRT2
    ho = (hl - hh) / _SQRT2
    hh2, ww2 = ll.shape
    low = np.empty((hh2 * 2, ww2), dtype=np.float64)
    low[0::2, :] = le
    low[1::2, :] = lo
    high = np.empty((hh2 * 2, ww2), dtype=np.float64)
    high[0::2, :] = he
    high[1::2, :] = ho
    e = (low + high) / _SQRT2
    o = (low - high) / _SQRT2
    img = np.empty((hh2 * 2, ww2 * 2), dtype=np.float64)
    img[:, 0::2] = e
    img[:, 1::2] = o
    return img


# --------------------------------------------------------------------------- #
# Batched 2-D type-II DCT (orthonormal)
# --------------------------------------------------------------------------- #

@functools.lru_cache(maxsize=8)
def _dct_matrix(n: int) -> np.ndarray:
    """Orthonormal type-II DCT matrix C (n x n); 2-D DCT of B is C @ B @ C.T."""
    k = np.arange(n).reshape(-1, 1)
    m = np.arange(n).reshape(1, -1)
    c = np.cos(np.pi * (2 * m + 1) * k / (2 * n))
    c *= math.sqrt(2.0 / n)
    c[0, :] = math.sqrt(1.0 / n)
    return c


def dct_blocks(blocks: np.ndarray) -> np.ndarray:
    """2-D DCT of a stack of square blocks (..., N, N), orthonormal."""
    if _HAVE_SCIPY:
        return _scipy_dctn(blocks, axes=(-2, -1), norm="ortho")
    c = _dct_matrix(blocks.shape[-1])
    return np.einsum("uy,...yx,vx->...uv", c, blocks, c, optimize=True)


def idct_blocks(coeffs: np.ndarray) -> np.ndarray:
    """Inverse 2-D DCT of a stack of square blocks (..., N, N), orthonormal."""
    if _HAVE_SCIPY:
        return _scipy_idctn(coeffs, axes=(-2, -1), norm="ortho")
    c = _dct_matrix(coeffs.shape[-1])
    return np.einsum("uy,...uv,vx->...yx", c, coeffs, c, optimize=True)


def psnr(a: np.ndarray, b: np.ndarray) -> float:
    """Peak signal-to-noise ratio (dB) between two uint8 images."""
    a = a.astype(np.float64)
    b = b.astype(np.float64)
    mse = np.mean((a - b) ** 2)
    if mse <= 1e-12:
        return float("inf")
    return float(10.0 * math.log10((255.0 ** 2) / mse))
