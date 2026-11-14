import sys; sys.path.insert(0, str(__import__("pathlib").Path(__file__).resolve().parents[1]))
import numpy as np, base64
from fastapi.testclient import TestClient
from app.main import app
c = TestClient(app)
r = c.get("/api/resolve", params={"q": "WISE J085510.83-071442.5"}).json(); print(r)
for dets in ["1,2,3,4,5,6", "6"]:
    p = {"ra": r["ra"], "dec": r["dec"], "fov": 360, "detectors": dets}
    if r.get("pmra") is not None: p.update(pmra=r["pmra"], pmdec=r["pmdec"])
    d = c.get("/api/frames", params=p).json()
    n = d["grid"]["n"]; cy = n // 2
    print(f"\n-- detectors {dets}: frames {len(d['frames'])}, candidates", [(k['type'], k.get('rate_arcsec_yr'), k.get('pa_deg'), round(k['x']-cy,1), round(k['y']-cy,1)) for k in d["candidates"]])
    for f in d["frames"]:
        img = np.frombuffer(base64.b64decode(f["image"]), "<f4").reshape(n, n)
        sig = 1.4826*np.nanmedian(np.abs(img-np.nanmedian(img)))
        box = img[cy-3:cy+4, cy-3:cy+4]
        yy, xx = np.unravel_index(np.nanargmax(box), box.shape)
        print(f"  E{f['epoch']} {f['date_start'][:10]} dets={f['detectors']} n={f['n_exposures']} centre-box peak {np.nanmax(box)/sig:5.1f}sigma at ({xx-3},{yy-3})")
