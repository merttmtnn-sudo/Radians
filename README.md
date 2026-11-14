# Radians

**See the infrared sky change.** Radians is a public web tool that turns NASA SPHEREx images of any
patch of sky into a short "blink" movie, so anyone can spot stars, brown dwarfs, asteroids and comets
moving, and variable stars changing brightness.

NASA Space Apps Challenge 2026 — *Planet X and SPHEREx*.

## How it works

1. You type coordinates (`08h55m10.8s -07d14m42s`, `133.795 -7.245`) or a name (`Barnard's Star`).
   Names are resolved with CDS Sesame, which also returns proper motion so fast movers stay centred.
2. The backend asks NASA/IPAC IRSA which SPHEREx exposures cover that position (SIA2).
3. Instead of downloading 65 MB files, it reads only the pixel rows it needs with HTTP byte ranges
   (~30 kB per exposure), including the RICE-compressed contamination flags.
4. Exposures are reprojected onto one grid, background-subtracted, grouped into epochs (SPHEREx
   revisits the sky every ~6 months) and co-added with inverse-variance weights.
5. Every exposure also gives a brightness measurement at a known wavelength (the SPHEREx
   linear-variable filters), which is what makes on-the-fly spectra possible.

New data releases are picked up automatically: the archive is queried live, and adding a release is
one environment variable (`SPHEREX_COLLECTIONS=spherex_dr2,spherex_dr1`).

## Roadmap

| Phase | What | Status |
|---|---|---|
| 0 | Data discovery: IRSA collections, file layout, byte-range access | ✅ |
| 1 | Core backend: search, cutouts, reprojection, epochs, co-add, photometry, API | ✅ |
| 2 | Blink player: input, playback, stretch, dates, shareable URLs | ✅ |
| 3 | Discovery tools: difference/sum images, per-detector co-adds, field of view, flag overlay | 🚧 |
| 4 | Extras: on-the-fly spectra, Gaia / WISE overlays with Aladin Lite | ⏳ |
| 5 | Testing on challenge targets, deployment (Hugging Face Space), demo | ⏳ |

## Run locally

```bash
python -m venv .venv && .venv/bin/pip install -r backend/requirements.txt
cd backend && ../.venv/bin/uvicorn app.main:app --reload
# open http://127.0.0.1:8000
```

Tests: `cd backend && python -m pytest -q tests`

## API

| Endpoint | Purpose |
|---|---|
| `GET /api/resolve?q=Barnard's Star` | name or coordinates → RA/Dec (+ proper motion) |
| `GET /api/observations?ra=&dec=` | SPHEREx exposures covering a position |
| `GET /api/frames?ra=&dec=&fov=300&mode=epoch` | aligned frames (`epoch`, `epoch_detector`, `exposure`) + photometry |

## Data and credits

SPHEREx data from NASA/IPAC Infrared Science Archive (IRSA). Name resolution by CDS Sesame
(Strasbourg). Built with Astropy, PyVO, NumPy, SciPy and FastAPI.

## Using the viewer

- **Space** play/pause, **← →** step frames, the timeline jumps to an epoch.
- All frames share one brightness scale, so a star that brightens really is brighter.
- Hover the image for RA/Dec, pixel value (MJy/sr) and the SPHEREx contamination flags of that pixel.
- Every view is a URL: `/?q=RW%20Aur&fov=240&mode=epoch&frame=1&cmap=heat`. Add `&embed=1` for a
  chrome-free player to put in an `<iframe>`.
