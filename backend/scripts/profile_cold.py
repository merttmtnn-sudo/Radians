"""Where does a cold (uncached) query spend its time? Times SIA and raw cutout reads at several
worker counts, without touching the cutout cache."""
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app import archive, fitsrange  # noqa: E402

RA, DEC = float(sys.argv[1]) if len(sys.argv) > 1 else 300.1821, float(sys.argv[2]) if len(sys.argv) > 2 else 22.7097
N = 48

t0 = time.time()
exps = archive.query_exposures(RA, DEC)
print(f"SIA: {len(exps)} exposures in {time.time() - t0:.1f}s")

calls = []
orig = fitsrange._get


def timed_get(url, merged, timeout=60):
    t = time.time()
    try:
        return orig(url, merged, timeout)
    finally:
        calls.append(time.time() - t)


fitsrange._get = timed_get
half = 40
for workers, chunk in ((12, exps[:N]), (32, exps[N:2 * N]), (64, exps[2 * N:3 * N])):
    if not chunk:
        break
    calls.clear()
    t = time.time()
    with ThreadPoolExecutor(workers) as pool:
        res = list(pool.map(lambda e: fitsrange.read_cutout(e.url, RA, DEC, half), chunk))
    dt = time.time() - t
    calls.sort()
    print(f"workers={workers}: {len(chunk)} cutouts in {dt:.1f}s -> {len(chunk) / dt:.1f}/s; "
          f"{len(calls)} requests, median {calls[len(calls) // 2]:.2f}s, p90 {calls[int(len(calls) * .9)]:.2f}s, "
          f"ok {sum(r is not None for r in res)}")
