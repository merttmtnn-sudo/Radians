"""Bake the five demo targets into the repository so a fresh server opens them instantly.

    python scripts/bake_demo.py

Writes backend/demo/built.pkl.gz (the aligned frames, exactly as /api/frames builds them) and copies
the small look-up caches (name resolution, exposure lists, Gaia, SkyBoT, FITS layouts) to
backend/demo/cache/. The server loads both at start-up (app.main.load_demo)."""
import gzip
import pickle
import shutil
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app import config, main  # noqa: E402

DEMO_DIR = Path(__file__).resolve().parents[1] / "demo"

main.warm()
built = {k: v for k, v in main._built.items()}
print(f"{len(built)} demo views, {sum(len(b['frs']) for b in built.values())} exposures")
DEMO_DIR.mkdir(exist_ok=True)
with gzip.open(DEMO_DIR / "built.pkl.gz", "wb", compresslevel=6) as f:
    pickle.dump(built, f, protocol=pickle.HIGHEST_PROTOCOL)
print(f"built.pkl.gz: {(DEMO_DIR / 'built.pkl.gz').stat().st_size / 1e6:.1f} MB")

dst = DEMO_DIR / "cache"
shutil.rmtree(dst, ignore_errors=True)
for kind in ("sesame", "sia", "gaia", "skybot", "layout", "wave"):
    src = config.CACHE_DIR / kind
    if src.exists():
        shutil.copytree(src, dst / kind)
print("cache:", sum(p.stat().st_size for p in dst.rglob("*") if p.is_file()) / 1e6, "MB")
