import sys, time
sys.path.insert(0, str(__import__("pathlib").Path(__file__).resolve().parents[1]))
from fastapi.testclient import TestClient
from app.main import app
c = TestClient(app)
for q, fov in [("Barnard's Star", 240), ("eps Indi B", 240), ("RW Aur", 240), ("R Dra", 240), ("08h55m10.831s -07d14m42.53s", 240)]:
    r = c.get("/api/resolve", params={"q": q}).json()
    p = {"ra": r["ra"], "dec": r["dec"], "fov": fov}
    if r.get("pmra") is not None: p.update(pmra=r["pmra"], pmdec=r["pmdec"])
    t0 = time.time(); d = c.get("/api/frames", params=p).json()
    cs = d["candidates"]
    print(f"\n## {q}: {len(cs)} candidates ({time.time()-t0:.1f}s)")
    for k in cs:
        extra = (f"rate={k['rate_arcsec_yr']}\"/yr PA={k['pa_deg']}" if k["type"] == "moving" else
                 f"ratio={k['ratio']} dets={[x['detector'] for x in k['detectors']]}" if k["type"] == "variable" else f"epoch={k['epoch']}")
        print(f"  {k['type']:9s} target={k['is_target']!s:5s} xy=({k['x']-19:+.1f},{k['y']-19:+.1f}) sig={k['significance']} n={len(k['points'])} {extra}")
