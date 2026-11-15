"""Disk storage: atomic writes, small array files, and a size cap with least-recently-used eviction.

Every write goes to a temporary file in the same folder and is then renamed over the target, so a
reader never sees half a file (a non-atomic write crashed a small server in the past).
"""
from __future__ import annotations

import io
import json
import os
import threading
import time
from pathlib import Path

import numpy as np

_evict_lock = threading.Lock()


def _tmp_name(path: Path) -> Path:
    return path.with_name(f".{path.name}.{os.getpid()}.{threading.get_ident()}.tmp")


def write_bytes(path: Path, data: bytes) -> None:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = _tmp_name(path)
    with open(tmp, "wb") as f:
        f.write(data)
    os.replace(tmp, path)


def write_json(path: Path, obj) -> None:
    write_bytes(path, json.dumps(obj, separators=(",", ":")).encode())


def read_json(path: Path):
    try:
        return json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def save_arrays(path: Path, **arrays) -> None:
    """Compressed .npz written atomically. Strings are stored as 0-d unicode arrays."""
    buf = io.BytesIO()
    np.savez_compressed(buf, **{k: np.asarray(v) for k, v in arrays.items()})
    write_bytes(path, buf.getvalue())


def load_arrays(path: Path) -> dict | None:
    """All arrays of an .npz as a dict (strings back as str), or None if missing or unreadable.
    Touches the file so the size cap keeps recently used data."""
    path = Path(path)
    try:
        with np.load(path, allow_pickle=False) as z:
            out = {}
            for k in z.files:
                v = z[k]
                out[k] = str(v) if v.dtype.kind == "U" and v.ndim == 0 else v
        try:
            os.utime(path)
        except OSError:
            pass
        return out
    except (OSError, ValueError, EOFError, KeyError):
        return None


def folder_size(root: Path) -> int:
    total = 0
    for p in Path(root).rglob("*"):
        try:
            if p.is_file():
                total += p.stat().st_size
        except OSError:
            pass
    return total


def enforce_cap(root: Path, max_bytes: int, protected: tuple[str, ...] = ()) -> int:
    """Delete the least recently used files under root until it fits in max_bytes.
    Paths containing any of the `protected` strings are never deleted. Returns bytes freed."""
    if max_bytes <= 0:
        return 0
    with _evict_lock:
        files = []
        for p in Path(root).rglob("*"):
            try:
                if p.is_file() and not p.name.endswith(".tmp"):
                    st = p.stat()
                    files.append((st.st_mtime, st.st_size, p))
            except OSError:
                pass
        total = sum(s for _, s, _ in files)
        freed = 0
        for _, size, p in sorted(files):
            if total - freed <= max_bytes:
                break
            if any(s in str(p) for s in protected):
                continue
            try:
                p.unlink()
                freed += size
            except OSError:
                pass
        return freed


def clean_stale_tmp(root: Path, older_than_s: float = 3600) -> None:
    """Remove temporary files left behind by a crash."""
    now = time.time()
    for p in Path(root).rglob("*.tmp"):
        try:
            if now - p.stat().st_mtime > older_than_s:
                p.unlink()
        except OSError:
            pass
