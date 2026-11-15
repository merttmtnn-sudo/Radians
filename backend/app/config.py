"""Runtime settings. Everything can be overridden with environment variables so a new
SPHEREx data release only needs SPHEREX_COLLECTIONS to change (e.g. "spherex_dr2,spherex_dr1")."""
import os
from pathlib import Path

IRSA_SIA = os.getenv("IRSA_SIA", "https://irsa.ipac.caltech.edu/SIA")
COLLECTIONS = [c.strip() for c in os.getenv("SPHEREX_COLLECTIONS", "spherex_qr3,spherex_dr1").split(",") if c.strip()]
# CDS Sesame and its mirrors, tried in order (the main site redirects to a mirror that can be slow)
SESAME = [
    "https://cds.unistra.fr/cgi-bin/nph-sesame/-oxp/SNV",
    "https://vizier.cfa.harvard.edu/viz-bin/nph-sesame/-oxp/SNV",
    "https://vizier.cds.unistra.fr/viz-bin/nph-sesame/-oxp/SNV",
]

CACHE_DIR = Path(os.getenv("CACHE_DIR", Path(__file__).resolve().parents[1] / ".cache"))
SIA_TTL_S = int(os.getenv("SIA_TTL_S", 12 * 3600))  # re-ask the archive twice a day for new data

PIXEL_SCALE = 6.15          # arcsec / SPHEREx pixel
DETECTOR_SIZE = 2040
MAX_WORKERS = int(os.getenv("MAX_WORKERS", 12))
EPOCH_GAP_DAYS = 20.0       # observations further apart than this start a new epoch
DEFAULT_FOV = 300.0         # arcsec
MIN_FOV, MAX_FOV = 60.0, 1800.0
APERTURE_PX = 2.0
# Nominal SPHEREx detector wavelength ranges (micron); each is a linear-variable filter.
DETECTORS = {1: [0.75, 1.09], 2: [1.10, 1.62], 3: [1.63, 2.42], 4: [2.42, 3.82], 5: [3.83, 4.41], 6: [4.42, 5.00]}           # photometry aperture radius in output pixels

# SPHEREx Level-2 FLAGS bits: MSKN/MSKD header keywords of DR1 (v27) files, as listed in the IRSA
# SPHEREx tutorial; bits 29+ from the IRSA spectrophotometry tool notes. Authoritative: Table 16 of
# the SPHEREx Explanatory Supplement.
FLAG_BITS = {
    0: "TRANSIENT", 1: "OVERFLOW", 2: "SUR_ERROR", 6: "NONFUNC", 7: "DICHROIC", 9: "MISSING_DATA",
    10: "HOT", 11: "COLD", 12: "FULLSAMPLE", 14: "PHANMISS", 15: "NONLINEAR", 17: "PERSIST",
    19: "OUTLIER", 20: "CROSSTALK", 21: "SOURCE", 22: "GHOST", 23: "GHOST_FPA", 24: "GHOST_EXT",
    25: "STREAK", 26: "BLOOM", 27: "SNOWBALL", 28: "HALO", 29: "SATELLITE_HALO",
}
# Same exclusion list IRSA's own SPHEREx spectrophotometry tool uses for its fits.
BAD_BITS = ["SUR_ERROR", "NONFUNC", "MISSING_DATA", "HOT", "COLD", "NONLINEAR", "PERSIST",
            "BLOOM", "SNOWBALL", "HALO", "SATELLITE_HALO"]
BAD_MASK = sum(1 << b for b, n in FLAG_BITS.items() if n in BAD_BITS)

# sharing one free server between many visitors
RATE_FRAMES = int(os.getenv("RATE_FRAMES", "20"))           # /api/frames per visitor per minute
RATE_PHOT = int(os.getenv("RATE_PHOT", "90"))               # /api/photometry per visitor per minute
RATE_LOOKUP = int(os.getenv("RATE_LOOKUP", "60"))           # each catalogue / fit endpoint per visitor per minute
MAX_COLD_BUILDS = int(os.getenv("MAX_COLD_BUILDS", "2"))    # positions read from IRSA at the same time
CACHE_MAX_MB = int(os.getenv("CACHE_MAX_MB", "4000"))       # cut-out cache size before oldest files go
# IRSA throttles parallel requests per client (measured by Efe, PR #9: 12 in flight gave 1.3 exposures/s,
# 32 gave 0.6/s, 64 gave 0.3/s), so the whole server shares one cap: the all-detector reader, the fast
# engine, the Sky Explorer cut-outs and the colour tiles (app/irsa.py holds the semaphore)
IRSA_MAX_INFLIGHT = int(os.getenv("IRSA_MAX_INFLIGHT", "12"))


def atomic_write(path, data):
    """Write a cache file so readers in other threads never see it half-written (they would get
    truncated FITS/pickles, or a SIGBUS through a memory map)."""
    import tempfile
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=".tmp-")
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(data.encode() if isinstance(data, str) else data)
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise
