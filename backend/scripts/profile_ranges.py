"""Multi-range (one range per row) vs one contiguous block of full rows: which does IRSA serve faster?"""
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app import archive, fitsrange  # noqa: E402

RA, DEC = 133.79, -7.24          # WISE 0855 field
exps = archive.query_exposures(RA, DEC)[100:160]
W = 2040


def rows_multi(e):
    img, _ = fitsrange.image_and_flags_headers(e.url)
    t = time.time()
    rng = fitsrange._rows(img.data_start, range(900, 981), 900, 981, W)
    fitsrange.fetch_ranges(e.url, rng)
    return time.time() - t


def rows_block(e):
    img, _ = fitsrange.image_and_flags_headers(e.url)
    t = time.time()
    fitsrange.fetch_ranges(e.url, [(img.data_start + 900 * W * 4, img.data_start + 981 * W * 4)])
    return time.time() - t


for name, fn, chunk in (("multi 81 ranges", rows_multi, exps[:30]), ("block 660 kB", rows_block, exps[30:60])):
    t = time.time()
    with ThreadPoolExecutor(30) as pool:
        ts = sorted(pool.map(fn, chunk))
    print(f"{name}: wall {time.time() - t:.1f}s, per request median {ts[len(ts) // 2]:.2f}s p90 {ts[int(len(ts) * .9)]:.2f}s max {ts[-1]:.2f}s")
