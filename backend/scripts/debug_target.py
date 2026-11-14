import sys; sys.path.insert(0, str(__import__("pathlib").Path(__file__).resolve().parents[1]))
import numpy as np
from app import archive, stack, detect
for q in sys.argv[1:]:
    r = archive.resolve(q)
    exps = archive.query_exposures(r["ra"], r["dec"]); n = 39
    tgt = lambda m: stack.propagate(r["ra"], r["dec"], r["pmra"], r["pmdec"], 2000.0, m)
    cra, cdec = tgt(float(np.mean([e.mjd for e in exps])))
    frs = stack.build_frames(exps, cra, cdec, n, tgt)
    print("\n##", q)
    for g in stack.group_raw(frs, "epoch"):
        src = detect.find_sources(g["image"], g["variance"])
        near = sorted(src, key=lambda s: (s["x"]-19)**2 + (s["y"]-19)**2)[:2]
        print(" E%d %s dets=%s" % (g["epoch"], g["date_start"][:10], g["detectors"]), [(round(s["x"]-19,2), round(s["y"]-19,2), round(s["snr"])) for s in near])
    for g in stack.group_raw(frs, "epoch_detector"):
        p = stack._aperture(g["image"], g["variance"], g["flags"], 19, 19)
        print(f"   E{g['epoch']} D{g['detector']} n={g['n_exposures']:3d} λ={g['wavelength_min']:.2f}-{g['wavelength_max']:.2f} flux {p['flux_ujy']:9.0f}±{p['err_ujy']:.0f} flagged={p['flagged']}")
