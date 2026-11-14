"""End-to-end check of the API on the challenge targets (hits the real archive)."""
import sys, time
import numpy as np, base64
from fastapi.testclient import TestClient
sys.path.insert(0, str(__import__("pathlib").Path(__file__).resolve().parents[1]))
from app.main import app

c = TestClient(app)
targets = sys.argv[1:] or ["08h55m10.831s -07d14m42.53s"]
for q in targets:
    t0 = time.time()
    r = c.get("/api/resolve", params={"q": q}).json()
    print("\n##", q, "->", r)
    params = {"ra": r["ra"], "dec": r["dec"], "fov": 240, "mode": "epoch"}
    if r.get("pmra") is not None:
        params.update(pmra=r["pmra"], pmdec=r["pmdec"])
    resp = c.get("/api/frames", params=params)
    if resp.status_code != 200:
        print("ERR", resp.status_code, resp.text[:300]); continue
    d = resp.json()
    print("grid", d["grid"]["n"], "read", d["n_exposures_read"], "time %.1fs" % (time.time() - t0))
    n = d["grid"]["n"]
    for f in d["frames"]:
        img = np.frombuffer(base64.b64decode(f["image"]), "<f4").reshape(n, n)
        cy = n // 2
        yy, xx = np.unravel_index(np.nanargmax(img), img.shape)
        print(f"  epoch {f['epoch']} {f['date_start']}..{f['date_end']} n={f['n_exposures']} "
              f"dets={f['detectors']} peak@({xx - cy},{yy - cy})px max={np.nanmax(img):.3f}")
    ok = [p for p in d["exposures"] if not p.get("flagged")]
    print("  photometry points:", len(d["exposures"]), "unflagged", len(ok))
    for p in ok[:: max(1, len(ok) // 6)]:
        print(f"    {p['date']} D{p['detector']} λ={p['wavelength']:.3f}µm flux={p['flux_ujy']:.1f}±{p['err_ujy']:.1f} µJy")
