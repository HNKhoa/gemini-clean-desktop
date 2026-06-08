"""Robust, blind invisible video watermark (DWT -> blocked DCT -> QIM/SVD).

The same payload bit-sequence is embedded in the luma (Y) channel of every
processed frame; extraction accumulates a soft vote across all frames so the
message survives heavy recompression. Extraction is blind: it needs only the
watermarked video, the password, and the payload length (in bytes).
"""

from __future__ import annotations

import hashlib
import math

import numpy as np

from . import payload as _payload
from . import transform as _t
from . import video_io as _io
from .utils import WMConfig, WatermarkError, ensure_input_exists, log


def _seed_from_password(password: str) -> int:
    digest = hashlib.sha256(password.encode("utf-8")).digest()
    return int.from_bytes(digest[:8], "big")


def _block_permutation(n_blocks: int, seed: int) -> np.ndarray:
    rng = np.random.default_rng(seed)
    return rng.permutation(n_blocks)


def _ll_blocks(ll: np.ndarray, n: int):
    """Split LL into (nb, N, N) blocks plus the (bh, bw) grid for reassembly."""
    bh, bw = ll.shape[0] // n, ll.shape[1] // n
    core = ll[: bh * n, : bw * n]
    blocks = core.reshape(bh, n, bw, n).swapaxes(1, 2).reshape(bh * bw, n, n)
    return blocks, bh, bw


def _put_blocks(ll: np.ndarray, blocks: np.ndarray, bh: int, bw: int, n: int) -> None:
    grid = blocks.reshape(bh, bw, n, n).swapaxes(1, 2).reshape(bh * n, bw * n)
    ll[: bh * n, : bw * n] = grid


class InvisibleWatermarker:
    def __init__(self, password: str, strength: float = 40.0, method: str = "qim",
                 block_size: int = 4, coef: tuple[int, int] = (2, 2),
                 every_nth: int = 1, crf: int = 18, preset: str = "medium",
                 ffmpeg: str | None = None, ffprobe: str | None = None):
        if not password:
            raise WatermarkError("a non-empty password is required")
        self.password = password
        self.cfg = WMConfig(method=method, block_size=block_size, coef=coef,
                            strength=float(strength), every_nth=int(every_nth))
        self.cfg.validate()
        self.crf = crf
        self.preset = preset
        self.ffmpeg = ffmpeg
        self.ffprobe = ffprobe

    # -- geometry helpers ------------------------------------------------- #
    def _frame_layout(self, width: int, height: int):
        """Return (nb, perm) for a given frame size."""
        hc, wc = height - height % 2, width - width % 2
        ll_h, ll_w = hc // 2, wc // 2
        n = self.cfg.block_size
        nb = (ll_h // n) * (ll_w // n)
        if nb <= 0:
            raise WatermarkError("video too small for the chosen block size")
        perm = _block_permutation(nb, _seed_from_password(self.password))
        return nb, perm

    # -- core per-frame ops (operate on the luma plane directly) --------- #
    def _embed_luma(self, y_u8, bit_for_block):
        y = y_u8.astype(np.float64)
        ll, details = _t.dwt2_haar(y)
        n = self.cfg.block_size
        blocks, bh, bw = _ll_blocks(ll, n)
        d = _t.dct_blocks(blocks)
        u, v = self.cfg.coef
        delta = self.cfg.strength

        if self.cfg.method == "qim":
            d[:, u, v] = self._qim_set(d[:, u, v], bit_for_block, delta)
            blocks2 = _t.idct_blocks(d)
        else:  # svd
            uu, ss, vt = np.linalg.svd(d)
            ss[:, 0] = self._qim_set(ss[:, 0], bit_for_block, delta, nonneg=True)
            d2 = (uu * ss[:, None, :]) @ vt
            blocks2 = _t.idct_blocks(d2)

        _put_blocks(ll, blocks2, bh, bw, n)
        y2 = _t.idwt2_haar(ll, details)
        return np.clip(y2 + 0.5, 0, 255).astype(np.uint8)

    def _read_luma_soft(self, y_u8):
        ll, _ = _t.dwt2_haar(y_u8.astype(np.float64))
        n = self.cfg.block_size
        blocks, _, _ = _ll_blocks(ll, n)
        d = _t.dct_blocks(blocks)
        u, v = self.cfg.coef
        if self.cfg.method == "qim":
            c = d[:, u, v]
        else:
            c = np.linalg.svd(d, compute_uv=False)[:, 0]
        return np.cos(math.pi * c / self.cfg.strength)  # +1 -> bit0, -1 -> bit1

    @staticmethod
    def _qim_set(values, bits, delta, nonneg: bool = False):
        q = np.round(values / delta).astype(np.int64)
        if nonneg:
            q = np.where(q < 0, 0, q)
        parity = (q & 1).astype(np.uint8)
        mismatch = parity != bits.astype(np.uint8)
        direction = np.where((values - q * delta) >= 0, 1, -1)
        q = q + np.where(mismatch, direction, 0)
        if nonneg:
            q = np.where(q < 0, q + 2, q)
        return q * delta

    # -- public API ------------------------------------------------------- #
    def embed(self, input_path: str, output_path: str, message: str) -> dict:
        ensure_input_exists(input_path)
        info = _io.probe(input_path, ffprobe=self.ffprobe)
        nb, perm = self._frame_layout(info.width, info.height)

        bits, n_bytes = _payload.encode_message(message)
        n_bits = bits.size
        if nb < n_bits:
            raise WatermarkError(
                f"frame capacity ({nb} blocks) < payload ({n_bits} bits). "
                f"Use a smaller --block-size or a shorter message."
            )
        # tile payload across all blocks in permuted order
        bit_of_pos = np.resize(bits, nb).astype(np.uint8)
        bit_for_block = np.empty(nb, dtype=np.uint8)
        bit_for_block[perm] = bit_of_pos

        psnr_sum, psnr_n, idx = 0.0, 0, 0
        writer = _io.FrameWriter(
            output_path, input_path, info.width, info.height, info.fps,
            info.has_audio, crf=self.crf, preset=self.preset, ffmpeg=self.ffmpeg,
            pix_fmt="yuv420p",
        )
        with writer:
            for y, u, v in _io.read_yuv420p_frames(input_path, info.width,
                                                   info.height, ffmpeg=self.ffmpeg):
                if idx % self.cfg.every_nth == 0:
                    y2 = self._embed_luma(y, bit_for_block)
                    if psnr_n < 30:  # sample luma PSNR on the first frames
                        psnr_sum += _t.psnr(y, y2)
                        psnr_n += 1
                    writer.write(y2.tobytes() + u.tobytes() + v.tobytes())
                else:
                    writer.write(y.tobytes() + u.tobytes() + v.tobytes())
                idx += 1

        stats = {
            "psnr": (psnr_sum / psnr_n) if psnr_n else float("inf"),
            "n_frames": idx,
            "n_bytes": n_bytes,
            "backend": _t.backends(),
        }
        log.info("embedded %d-byte payload over %d frames (psnr=%.1f dB)",
                 n_bytes, idx, stats["psnr"])
        return stats

    def extract(self, input_path: str, n_bytes: int) -> str:
        message, _ = self.extract_details(input_path, n_bytes)
        return message

    def extract_details(self, input_path: str, n_bytes: int) -> tuple[str, bool]:
        ensure_input_exists(input_path)
        info = _io.probe(input_path, ffprobe=self.ffprobe)
        nb, perm = self._frame_layout(info.width, info.height)

        n_bits = _payload.total_bits(n_bytes)
        if nb < n_bits:
            raise WatermarkError(
                f"frame capacity ({nb} blocks) < payload ({n_bits} bits) for n_bytes={n_bytes}"
            )
        # block index -> payload bit index
        pos = np.empty(nb, dtype=np.int64)
        pos[perm] = np.arange(nb)
        payload_idx = (pos % n_bits).astype(np.int64)

        acc = np.zeros(n_bits, dtype=np.float64)
        idx = used = 0
        for y, _u, _v in _io.read_yuv420p_frames(input_path, info.width,
                                                 info.height, ffmpeg=self.ffmpeg):
            if idx % self.cfg.every_nth == 0:
                soft = self._read_luma_soft(y)
                np.add.at(acc, payload_idx, soft)
                used += 1
            idx += 1

        if used == 0:
            raise WatermarkError("no frames were processed during extraction")
        bits = _payload.decide_bits(acc)
        message, crc_ok = _payload.decode_message(bits, n_bytes)
        log.info("extracted %d-byte payload from %d frames (crc_ok=%s)",
                 n_bytes, used, crc_ok)
        return message, crc_ok
