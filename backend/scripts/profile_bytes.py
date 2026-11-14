"""Bytes downloaded per cutout, split by part (headers, image+variance rows, flag descriptors, flag tiles)."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app import archive, fitsrange  # noqa: E402

RA, DEC = 133.79, -7.24
log = []
orig = fitsrange._get


def counting(url, merged, timeout=60):
    out = orig(url, merged, timeout)
    log.append((len(merged), sum(b - a for a, b in merged), sum(len(d) for _, d in out)))
    return out


fitsrange._get = counting
for e in archive.query_exposures(RA, DEC)[200:203]:
    log.clear()
    fitsrange.read_cutout(e.url, RA, DEC, 30)
    print(e.obs_id, e.detector, [(f"{n} ranges", f"{b / 1024:.0f} kB") for n, b, _ in log], f"total {sum(b for _, b, _ in log) / 1024:.0f} kB")
