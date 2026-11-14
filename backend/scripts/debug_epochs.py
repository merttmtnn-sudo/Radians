"""Per-visit position of a target vs where its proper motion puts it, and which release each visit is from.

    python scripts/debug_epochs.py "Barnard's Star" "eps Indi B"
"""
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app import archive, detect, stack  # noqa: E402
from app.main import _build  # noqa: E402

for q in sys.argv[1:]:
    tg = archive.resolve(q)
    r6 = lambda v: float(f"{v:.6f}")  # noqa: E731
    b = _build(r6(tg["ra"]), r6(tg["dec"]), 240, "1,2,3,4,5,6", tg.get("pmra"), tg.get("pmdec"), 2000.0, 400)
    groups = stack.group_raw(b["frs"], "epoch", True)
    by_epoch = {}
    frs = sorted(b["frs"], key=lambda f: f.exp.mjd)
    for f, e in zip(frs, stack.epochs([f.exp.mjd for f in frs])):
        by_epoch.setdefault(e + 1, []).append(f.exp.collection)
    print(f"\n## {q}")
    for g in groups:
        ra, dec = stack.propagate(tg["ra"], tg["dec"], tg.get("pmra"), tg.get("pmdec"), 2000.0, g["mjd"])
        px, py = b["w"].wcs_world2pix([[ra, dec]], 0)[0]
        src = detect.find_sources(g["image"], g["variance"])
        near = min(src, key=lambda s: (s["x"] - px) ** 2 + (s["y"] - py) ** 2) if src else None
        colls = {c: by_epoch[g["epoch"]].count(c) for c in set(by_epoch[g["epoch"]])}
        # field stars: median offset of bright sources vs the deep reference (astrometric zero point)
        print(f" E{g['epoch']} {g['date_start'][:10]} n={g['n_exposures']:3d} {colls} expected ({px:.2f},{py:.2f}) "
              f"found {('(%.2f,%.2f) snr %.0f' % (near['x'], near['y'], near['snr'])) if near else '-'}"
              f" d={np.hypot(near['x'] - px, near['y'] - py) * 6.15 if near else float('nan'):.2f}\"")
