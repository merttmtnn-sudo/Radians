"""Paths and tunables of the fast engine, overridable with SKYSHIFT_* environment variables."""
from __future__ import annotations

import os
from pathlib import Path

BACKEND = Path(__file__).resolve().parents[2]
ROOT = BACKEND.parent
DATA = Path(os.environ.get("SKYSHIFT_DATA", ROOT / "data"))      # download cache (not in git)
DEMO = BACKEND / "demo" / "engine"                                # pre-built views of the challenge targets

IRSA_CONCURRENCY = int(os.environ.get("SKYSHIFT_IRSA_CONCURRENCY", 16))
SIA_TTL_HOURS = float(os.environ.get("SKYSHIFT_SIA_TTL_HOURS", 72))
MAX_DISK_GB = float(os.environ.get("SKYSHIFT_MAX_DISK_GB", 5))
