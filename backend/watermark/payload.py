"""Payload codec: text <-> bits with a length+CRC header and soft-vote decoding."""

from __future__ import annotations

import numpy as np

from .utils import WatermarkError

HEADER_BYTES = 3  # 2 bytes length (big-endian) + 1 byte CRC-8 of the payload
_MAX_PAYLOAD = 0xFFFF


def crc8(data: bytes, poly: int = 0x07) -> int:
    """Standard CRC-8 (poly 0x07, init 0x00)."""
    crc = 0
    for byte in data:
        crc ^= byte
        for _ in range(8):
            crc = ((crc << 1) ^ poly) & 0xFF if (crc & 0x80) else (crc << 1) & 0xFF
    return crc


def bytes_to_bits(data: bytes) -> np.ndarray:
    """Bytes -> uint8 array of 0/1, MSB first."""
    arr = np.frombuffer(data, dtype=np.uint8)
    return np.unpackbits(arr)


def bits_to_bytes(bits: np.ndarray) -> bytes:
    """uint8 array of 0/1 (length multiple of 8), MSB first -> bytes."""
    bits = np.asarray(bits, dtype=np.uint8).ravel()
    if bits.size % 8:
        bits = bits[: bits.size - (bits.size % 8)]
    return np.packbits(bits).tobytes()


def total_bits(n_payload_bytes: int) -> int:
    """Number of embedded bits for a payload of n bytes (header included)."""
    return (HEADER_BYTES + int(n_payload_bytes)) * 8


def encode_message(message: str) -> tuple[np.ndarray, int]:
    """Encode text into a bit array: [len:16][crc8:8][utf8 payload]. Returns (bits, n_bytes)."""
    payload = message.encode("utf-8")
    n = len(payload)
    if n > _MAX_PAYLOAD:
        raise WatermarkError(f"message too long: {n} bytes (max {_MAX_PAYLOAD})")
    header = n.to_bytes(2, "big") + bytes([crc8(payload)])
    bits = bytes_to_bits(header + payload)
    return bits, n


def decode_message(bits: np.ndarray, n_bytes: int) -> tuple[str, bool]:
    """Decode bits back to text given the payload byte count. Returns (message, crc_ok)."""
    raw = bits_to_bytes(bits)
    if len(raw) < HEADER_BYTES + n_bytes:
        raise WatermarkError("not enough recovered bits to decode the payload")
    declared = int.from_bytes(raw[0:2], "big")
    crc_stored = raw[2]
    payload = raw[HEADER_BYTES:HEADER_BYTES + n_bytes]
    crc_ok = (declared == n_bytes) and (crc8(payload) == crc_stored)
    try:
        message = payload.decode("utf-8")
    except UnicodeDecodeError:
        message = payload.decode("utf-8", "replace")
        crc_ok = False
    return message, crc_ok


def decide_bits(accumulator: np.ndarray) -> np.ndarray:
    """Hard-decide bits from soft accumulator: positive -> 0, negative -> 1."""
    return (np.asarray(accumulator) < 0).astype(np.uint8)
