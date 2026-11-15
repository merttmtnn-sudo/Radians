"""One process-wide limit on requests in flight to NASA/IPAC IRSA.

Every part of the server that reads from IRSA (the fast engine's byte-range reads, the all-detector
build, the planetarium's cut-outs and the colour tiles) takes a slot here first. IRSA throttles
parallel requests per client (measured by Efe, PR #9: 12 in flight gave 1.3 exposures/s, 32 gave
0.6/s, 64 gave 0.3/s), so more parallelism makes every visitor wait longer. The limit is
config.IRSA_MAX_INFLIGHT (environment variable IRSA_MAX_INFLIGHT).
"""
from __future__ import annotations

import contextlib
import threading

from . import config

HOST = "irsa.ipac.caltech.edu"
MAX_INFLIGHT = max(1, config.IRSA_MAX_INFLIGHT)
SLOTS = threading.BoundedSemaphore(MAX_INFLIGHT)


def slot(url: str = HOST):
    """Context manager: holds one IRSA slot while the block runs; free for any other host."""
    return SLOTS if HOST in url else contextlib.nullcontext()
