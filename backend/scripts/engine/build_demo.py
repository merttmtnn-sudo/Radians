"""Pre-build the five challenge targets into skyshift/demo/ so they open instantly (and work on a
small server that has never fetched them). Run from skyshift/backend:  python -m scripts.build_demo

Builds each target's time-lapse view in its own band, then works out the slow results the page asks
for first (light curve, six-band spectrum, spectral type, what changed) and copies the lot."""
from __future__ import annotations

import shutil
import sys
import time

from app.engine import api_find, settings, store, sky
from app.engine.views import ViewManager, make_spec, view_id

TARGETS = ["eps-indi-b", "wise-0855", "barnard", "rw-aur", "r-dra"]
SIZE = 4.0


def wait_for(fn, label):
    t0 = time.time()
    while True:
        out = fn()
        if out["state"] not in ("queued", "running"):
            print(f"  {label}: {out['state']} in {time.time() - t0:.0f} s {out.get('error') or ''}", flush=True)
            return out


def main(only: list[str]) -> None:
    manager = ViewManager(http=api_find.HTTP)
    index = store.read_json(settings.DEMO / "index.json") or {}
    pins = {p["id"]: p for p in api_find.pins()}
    for pid in only or TARGETS:
        pin = pins[pid]
        target = dict(pin, name=pin["name_en"])
        ra, dec = sky.position_now(target)
        moving = abs(target.get("pmra", 0)) + abs(target.get("pmdec", 0)) > 20
        spec = make_spec(ra, dec, pin["band"], SIZE, target if moving else None)
        vid = view_id(spec)
        print(f"{pid} band {pin['band']} -> {vid}", flush=True)
        manager.submit(spec)
        view = wait_for(lambda: manager.status(vid, wait=20), "view")
        if view["state"] != "ready":
            continue
        meta = manager._stored(vid)
        manager.lightcurve(vid)
        print("  light curve kept", flush=True)
        wait_for(lambda: manager.spectrum(vid, wait=20), "spectrum")
        cls = manager.classify(vid)
        print(f"  type: {cls.get('fit', {}).get('best', cls.get('state'))}", flush=True)
        if len(meta["passes"]) >= 2:
            ch = manager.changes(vid)
            print(f"  changes: {len(ch.get('items', []))} items", flush=True)
        if manager._dir(vid) != settings.DEMO / "views" / vid:
            shutil.copytree(manager.root / vid, settings.DEMO / "views" / vid, dirs_exist_ok=True)
        index[f"{pid};{pin['band']};{SIZE:g}"] = spec
        store.write_json(settings.DEMO / "index.json", index)
    manager.pool.shutdown(wait=True)


if __name__ == "__main__":
    main(sys.argv[1:])
