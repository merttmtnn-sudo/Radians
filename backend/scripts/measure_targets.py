"""Print what the automatic finder reports for the five challenge targets (numbers for the README/slides).

    python scripts/measure_targets.py [base-url]      (default http://127.0.0.1:8765)"""
import sys

import requests

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8765"
DEMO = [("Barnard's Star", "1,2,3,4,5,6"), ("eps Indi B", "1,2,3,4,5,6"), ("WISE J085510.83-071442.5", "5,6"),
        ("RW Aur", "1,2,3,4,5,6"), ("R Dra", "1,2,3,4,5,6")]

for q, dets in DEMO:
    tg = requests.get(f"{BASE}/api/resolve", params={"q": q}, timeout=120).json()
    d = requests.get(f"{BASE}/api/frames", params={
        "ra": f"{tg['ra']:.6f}", "dec": f"{tg['dec']:.6f}", "fov": 240, "mode": "epoch", "detectors": dets,
        "pmra": tg.get("pmra"), "pmdec": tg.get("pmdec")}, timeout=1800).json()
    fr = d["frames"]
    print(f"\n{q}: {len(fr)} visits, {d['n_exposures_read']} exposures, "
          f"{fr[0]['date_start'][:10]} .. {fr[-1]['date_end'][:10]}; catalogue pm "
          f"{((tg.get('pmra') or 0) ** 2 + (tg.get('pmdec') or 0) ** 2) ** .5 / 1000:.2f}\"/yr")
    for c in d["candidates"]:
        extra = {k: c[k] for k in ("rate_arcsec_yr", "pa_deg", "ratio", "significance", "is_target", "low_confidence", "epoch")
                 if k in c}
        print(f"   {c['type']:9s} {extra}")
