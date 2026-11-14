"""Injection test: put fake movers, variables and new sources into real SPHEREx exposures of the five
challenge fields, run the automatic finder, and count what it recovers (and what it reports with
nothing injected). Needs the fields in the local cache (run scripts/warm.py once) or network access.

    python scripts/inject_validate.py [trials-per-cell] > ../docs/validation-table.md
"""
import dataclasses
import math
import sys
import time
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app import archive, config, detect, stack  # noqa: E402
from app.main import _build  # noqa: E402

FIELDS = [("Barnard's Star", "1,2,3,4,5,6"), ("eps Indi B", "1,2,3,4,5,6"), ("WISE J085510.83-071442.5", "6"),
          ("RW Aur", "1,2,3,4,5,6"), ("R Dra", "1,2,3,4,5,6")]
SNRS = [5, 8, 12, 20, 40]
KINDS = ["moving", "variable", "transient"]
PSF_SIGMA = 0.62          # px, SPHEREx PSF core on the 6.15" grid
MOVE_RATE = 1.5           # px per year (9"/yr)
TRIALS = int(sys.argv[1]) if len(sys.argv) > 1 else 6
rng = np.random.default_rng(0)
sys.stdout.reconfigure(encoding="utf-8")


def psf(n, x, y):
    yy, xx = np.mgrid[0:n, 0:n]
    g = np.exp(-((xx - x) ** 2 + (yy - y) ** 2) / (2 * PSF_SIGMA ** 2))
    return g / (2 * math.pi * PSF_SIGMA ** 2)


def run_finder(frs, w, n):
    ep = stack.group_raw(frs, "epoch", True)
    ed = stack.group_raw(frs, "epoch_detector", True)
    return detect.find_candidates(ep, ed, w, ((n - 1) / 2, (n - 1) / 2)), ep


def inject(frs, kind, x0, y0, flux, visits, ref_mjd, pa, hit_visit):
    out = []
    n = frs[0].image.shape[0]
    ep_of = dict(zip((id(f) for f in frs), visits))
    for f in frs:
        v = ep_of[id(f)]
        if kind == "moving":
            dt = (f.exp.mjd - ref_mjd) / 365.25
            x, y, fl = x0 + MOVE_RATE * dt * math.cos(pa), y0 + MOVE_RATE * dt * math.sin(pa), flux
        elif kind == "variable":
            x, y, fl = x0, y0, flux * (3.0 if v == hit_visit else 1.0)    # flux = size of the change / 2
        else:
            x, y, fl = x0, y0, (flux if v == hit_visit else 0.0)
        img = f.image + (fl * psf(n, x, y)).astype(np.float32) if fl else f.image
        out.append(dataclasses.replace(f, image=img))
    return out


def recovered(cands, kind, positions):
    for c in cands:
        if c["type"] != kind or c.get("is_target"):
            continue
        pts = [(p["x"], p["y"]) for p in c.get("points", [])] or [(c["x"], c["y"])]
        if min(math.hypot(px - x, py - y) for px, py in pts for x, y in positions) < 1.5:
            return True
    return False


t0 = time.time()
rows, fps = {}, []
for name, dets in FIELDS:
    tg = archive.resolve(name)
    r6 = lambda v: float(f"{v:.6f}")  # noqa: E731
    b = _build(r6(tg["ra"]), r6(tg["dec"]), 240, dets, tg.get("pmra"), tg.get("pmdec"), 2000.0, 400)
    frs, w, n = sorted(b["frs"], key=lambda f: f.exp.mjd), b["w"], b["n"]
    visits = stack.epochs([f.exp.mjd for f in frs])
    base, ep = run_finder(frs, w, n)
    fps.append((name, len(ep), sum(1 for c in base if not c.get("is_target")), [c["type"] for c in base if not c.get("is_target")]))
    # S/N as the finder measures it: aperture flux over robust (confusion-including) noise
    sigma = float(np.nanmedian([detect.robust_sigma(g["image"]) for g in ep]))
    disk = detect._disk(config.APERTURE_PX)
    c0 = (n - 1) / 2
    frac = float((psf(n, c0, c0)[int(c0) - disk.shape[0] // 2:int(c0) + disk.shape[0] // 2 + 1,
                                 int(c0) - disk.shape[1] // 2:int(c0) + disk.shape[1] // 2 + 1] * disk).sum())
    ap_noise = sigma * math.sqrt(disk.sum())
    srcs = detect.find_sources(ep[0]["image"], ep[0]["variance"])
    busy = [(s["x"], s["y"]) for s in srcs if s["snr"] > 5]
    deep = {"image": stack.coadd(frs)[0]}          # injections go on empty sky (deep stack S/N < 2)
    ref_mjd = float(np.mean([f.exp.mjd for f in frs]))
    nvis = max(visits) + 1
    for kind in KINDS:
        for snr in SNRS:
            flux = snr * ap_noise / frac
            for _ in range(TRIALS):
                while True:
                    x0, y0 = rng.uniform(5, n - 6, 2)
                    if math.hypot(x0 - (n - 1) / 2, y0 - (n - 1) / 2) > 5 and all(math.hypot(x0 - a, y0 - c) > 3.5 for a, c in busy)                             and abs(detect._ap_snr(deep, x0, y0)) < 2:
                        break
                pa, hit = rng.uniform(0, 2 * math.pi), int(rng.integers(nvis))
                inj = inject(frs, kind, x0, y0, flux, visits, ref_mjd, pa, hit)
                cands, _ = run_finder(inj, w, n)
                if kind == "moving":
                    pos = [(x0 + MOVE_RATE * (g["mjd"] - ref_mjd) / 365.25 * math.cos(pa),
                            y0 + MOVE_RATE * (g["mjd"] - ref_mjd) / 365.25 * math.sin(pa)) for g in ep]
                else:
                    pos = [(x0, y0)]
                ok = recovered(cands, kind, pos)
                rows.setdefault((kind, snr), []).append(ok)
    print(f"<!-- {name}: done after {time.time() - t0:.0f} s -->", file=sys.stderr)

print("| Injected | " + " | ".join(f"S/N {s}" for s in SNRS) + " |")
print("|---|" + "---|" * len(SNRS))
label = {"moving": f"Mover, {MOVE_RATE * 6.15:.0f}″/yr", "variable": "Variable (×3 in one visit)",
         "transient": "New source (one visit only)"}
for kind in KINDS:
    cells = []
    for snr in SNRS:
        r = rows[(kind, snr)]
        cells.append(f"{100 * sum(r) / len(r):.0f}% ({sum(r)}/{len(r)})")
    print(f"| {label[kind]} | " + " | ".join(cells) + " |")
print()
print("| Field (nothing injected) | Visits | Candidates besides the target |")
print("|---|---|---|")
for name, nv, k, types in fps:
    print(f"| {name} | {nv} | {k}{(' (' + ', '.join(types) + ')') if types else ''} |")
