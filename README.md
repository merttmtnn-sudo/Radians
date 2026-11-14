# Radians

**See the infrared sky change.** Radians is a public web tool that turns NASA SPHEREx images of any
patch of sky into a short "blink" movie, so anyone can spot stars, brown dwarfs, asteroids and comets
moving, and variable stars changing brightness.

NASA Space Apps Challenge 2026 — *Planet X and SPHEREx*.

**Live:** https://radians.onrender.com (free instance: the first visit after a quiet spell wakes it up, about a minute) ·
**Slides (PDF):** [`docs/Radians-slides.pdf`](docs/Radians-slides.pdf)

<p>
  <img src="docs/media/barnard-s-star.gif" width="240" alt="Barnard's Star moving north between four SPHEREx visits">
  <img src="docs/media/eps-indi-b.gif" width="240" alt="Epsilon Indi B moving between three SPHEREx visits">
  <img src="docs/media/rw-aur.gif" width="240" alt="RW Aurigae changing brightness between two SPHEREx visits">
</p>

*Real SPHEREx DR1 frames as Radians blinks them (made by `backend/scripts/make_media.py`).*
Slides: [`frontend/slides.html`](frontend/slides.html) (served at `/static/slides.html`) ·
demo reel: [`docs/media/radians-demo.gif`](docs/media/radians-demo.gif) · recording script: [`docs/demo-script.md`](docs/demo-script.md)

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
| 3 | Discovery tools: difference/stack views, detector selection, flag summary, candidate finder, EN/TR | ✅ |
| 4 | Extras: on-the-fly spectra, light curves, Gaia DR3 / SkyBoT overlays, NEOSSat archive, Aladin Lite context | ✅ |
| 5 | Testing on challenge targets, deployment (Hugging Face Space), demo | ⏳ |

## Run locally

```bash
python -m venv .venv && .venv/bin/pip install -r backend/requirements.txt
cd backend && ../.venv/bin/uvicorn app.main:app --reload
# open http://127.0.0.1:8000
```

Tests: `cd backend && python -m pytest -q tests` and `node --test frontend/tests`

Fill the caches for the five demo targets (a few minutes, once): `cd backend && python scripts/warm.py`

## Deploy

The `Dockerfile` runs everything in one container. **Render** (what the live site uses): New → Web
Service → public repository URL, Docker, Free plan, `MAX_WORKERS=16`; or use the `render.yaml` Blueprint.

**Hugging Face** Docker Spaces now need a paid plan. With one, create a Docker Space, then:

```bash
deploy/push_hf.sh <hf-user>/<space-name>
```

The script pushes the current commit with `deploy/huggingface/README.md` as the Space card.
Settings (environment variables): `MAX_WORKERS` (parallel IRSA reads, 32 in the container),
`WARM_ON_START=1` (prepare the demo targets in the background at start-up), `CACHE_DIR`.

**Speed.** A new position needs every SPHEREx exposure that covers it (300–400), about 0.5 MB each over
HTTP byte ranges, most of it the compressed flag rows. On a home connection this takes a few minutes, in a
data centre seconds; the page shows how many exposures have been read. Everything is cached afterwards.

## API

| Endpoint | Purpose |
|---|---|
| `GET /api/resolve?q=Barnard's Star` | name or coordinates → RA/Dec (+ proper motion) |
| `GET /api/observations?ra=&dec=` | SPHEREx exposures covering a position |
| `GET /api/frames?ra=&dec=&fov=300&mode=epoch` | aligned frames (`epoch`, `epoch_detector`, `exposure`) + photometry + candidates |
| `GET /api/progress?job=` | progress of a running `/api/frames?…&job=` request |
| `GET /api/photometry?ra=&dec=&fov=&x=&y=` | per-exposure brightness and wavelength at one pixel: an on-the-fly spectrum |
| `GET /api/gaia?ra=&dec=&radius=` | Gaia DR3 stars (ESA archive), with proper motions |
| `GET /api/sso?ra=&dec=&radius=&mjd=` | known asteroids and comets in the field at each date (IMCCE SkyBoT) |
| `GET /api/neossat?ra=&dec=&radius=` | archived NEOSSat images of the area (CSA, via CADC) |

## Team

Mert Metin · Efe Gönderen · Bora Hısım · Emre Bozkaya

## Data and credits

- **SPHEREx** spectral images (DR1): NASA/IPAC Infrared Science Archive (IRSA). Photometry follows the
  IRSA SPHEREx tutorial notebooks (annulus background, flag bits, wavelength from the WCS-WAVE table).
- **2MASS, AllWISE, DSS2 and SPHEREx HiPS** sky maps for the Aladin Lite context view: served by IRSA.
- **Gaia DR3**: ESA Gaia archive (TAP). **CatWISE2020**: VizieR. Gaia stars are moved to each frame's
  date with their proper motions, so fast movers line up with the SPHEREx image.
- **Known Solar System objects**: IMCCE SkyBoT.
- **NEOSSat** (Canadian Space Agency) archive search: CADC.
- Name resolution by CDS Sesame (Strasbourg); sky viewer: Aladin Lite (CDS).
- Built with Astropy, PyVO, NumPy, SciPy and FastAPI; the browser side has no build step or framework.

## Finding things

- **Views** (computed instantly in the browser): images, *frame − median of all* (static sky cancels,
  movers and variables stay), *frame − previous*, *frame − first*, and a deep *stack* of every frame.
- **Detectors**: pick D1–D6 or a preset. Cold brown dwarfs such as WISE 0855 are bright only at
  4–5 µm, so try *D6 only*.
- **Candidate finder**: every query also runs a simple search that
  - finds sources in each epoch (Gaussian peak fits, which stay unbiased on SPHEREx's undersampled PSF),
  - removes small astrometric offsets between epochs using bright common stars,
  - fits straight-line motion through 3 or more epochs (one outlier epoch may be dropped) → **moving**,
  - compares brightness only within the same detector, and needs two detectors to agree → **variable**,
  - flags sources seen in one epoch and truly absent in the others → **one epoch only**.

  On the challenge targets it recovers Barnard's Star (11.7″/yr, PA 354°; catalogue 10.4″/yr, 356°),
  ε Indi B (4.69″/yr, PA 123°; catalogue 4.68″/yr, 122°) and the variability of RW Aurigae.
  Candidates are suggestions to check by eye, each with a SIMBAD link.

## Using the viewer

- **Space** play/pause, **← →** step frames, the timeline jumps to an epoch.
- All frames share one brightness scale, so a star that brightens really is brighter.
- Hover the image for RA/Dec, pixel value (MJy/sr) and the SPHEREx contamination flags of that pixel.
- Every view is a URL: `/?q=RW%20Aur&fov=240&frame=1&cmap=heat&view=diff_median&det=4,5,6&lang=tr`. Add `&embed=1` for a
  chrome-free player to put in an `<iframe>`.

## Spectra, light curves and context (phase 4)

- **Spectrum**: SPHEREx's linear-variable filters see every position at a different wavelength in each
  exposure, so the brightness of one pixel across all exposures *is* a 0.75–5 µm spectrum. The target's
  spectrum appears below the player; click any star to measure it instead. Colours mark epochs.
- **Light curve**: each detector divided by its own median; real variability moves all detectors together.
- **Saturated stars** (Barnard's Star, R Dra) switch automatically to *PSF wings* photometry: the flux in a
  ring 2.5–4.5 px from the core, which still follows the star's brightness.
- **Overlays**: Gaia DR3 circles (propagated to the frame date; a line shows 5 years of motion for stars
  faster than 0.15″/yr) and SkyBoT crosses for known asteroids at that exact time.
- **NEOSSat**: links to archived images of the field from Canada's asteroid-hunting microsatellite.
- **Wider context**: Aladin Lite with 2MASS / AllWISE / SPHEREx / DSS2 maps, the Radians field outlined.
