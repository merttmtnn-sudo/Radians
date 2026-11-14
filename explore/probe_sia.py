import sys, pyvo, numpy as np
from astropy.coordinates import SkyCoord
import astropy.units as u
c = SkyCoord("08h55m10.831s", "-07d14m42.53s")
print("WISE0855 deg:", c.ra.deg, c.dec.deg)
sia = pyvo.dal.SIA2Service("https://irsa.ipac.caltech.edu/SIA")
for coll in ["spherex_qr", "spherex_qr_deep"]:
    try:
        t = sia.search(pos=(c.ra.deg, c.dec.deg, 0.001), collection=coll).to_table()
    except Exception as e:
        print(coll, "ERR", e); continue
    print(f"\n== {coll}: {len(t)} rows")
    if not len(t): continue
    print([n for n in t.colnames][:60])
    for col in ["t_min","em_min","em_max","energy_bandpassname","obs_id","dataproduct_subtype","calib_level"]:
        if col in t.colnames: print(col, t[col][:5].tolist())
    if "t_min" in t.colnames:
        tm = np.sort(np.array(t["t_min"], float))
        gaps = np.where(np.diff(tm) > 30)[0]
        print("MJD range", tm.min(), tm.max(), "epoch breaks at", [(tm[i], tm[i+1]) for i in gaps])
    print("access_url example:", t["access_url"][0])
