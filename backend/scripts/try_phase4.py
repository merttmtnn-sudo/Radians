"""Smoke test of the phase-4 endpoints against the real services."""
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from fastapi.testclient import TestClient  # noqa: E402

from app.main import app  # noqa: E402

c = TestClient(app)


def timed(label, path, params):
    t0 = time.time()
    r = c.get(path, params=params)
    print(f"{label}: HTTP {r.status_code} in {time.time() - t0:.1f}s")
    return r.json() if r.status_code == 200 else print("   ", r.text[:300])


d = timed("gaia Barnard", "/api/gaia", {"ra": 269.452, "dec": 4.693, "radius": 0.04})
if d:
    print("   ", len(d["sources"]), d["sources"][:1])
d = timed("sso ecliptic", "/api/sso", {"ra": 0, "dec": 0, "radius": 600, "mjd": "60986.5,61100.25"})
if d:
    print("   ", [(e["mjd"], len(e["objects"])) for e in d], d[0]["objects"][:1])
p = {"ra": 269.4520769586187, "dec": 4.69336496657667, "pmra": -801.551, "pmdec": 10362.394, "fov": 240}
f = timed("frames Barnard", "/api/frames", p)
print("    target phot sample:", f["exposures"][0])
s = timed("photometry Barnard centre (cached frames)", "/api/photometry", {**p, "x": 19, "y": 19})
print("   ", len(s["points"]), s["points"][0])
