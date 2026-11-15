# Radians

**See the infrared sky change.** Radians is a public web tool that turns NASA SPHEREx images of any
patch of sky into a short "blink" movie, so anyone can spot stars, brown dwarfs, asteroids and comets
moving, and variable stars changing brightness.

NASA Space Apps Challenge 2026 — *Planet X and SPHEREx*.

**Live (the version before this merge):** https://radians.onrender.com ·
**Slides (PDF, also from before the merge):** [`docs/Radians-slides.pdf`](docs/Radians-slides.pdf)

<p>
  <img src="docs/media/barnard-s-star.gif" width="240" alt="Barnard's Star moving north between four SPHEREx visits">
  <img src="docs/media/eps-indi-b.gif" width="240" alt="Epsilon Indi B moving between three SPHEREx visits">
  <img src="docs/media/rw-aur.gif" width="240" alt="RW Aurigae changing brightness between two SPHEREx visits">
</p>

*Real SPHEREx DR1 frames as Radians blinks them (made by `backend/scripts/make_media.py`).*

## Two models, one app

Our team of four built two versions of this project during the event weekend, in two pairs, and then
merged them into this one:

- **Radians** (the interface you see): one page with Home, the Blink viewer and the all-sky Map; a
  candidate tracker with an injection test; SkyBoT and Gaia overlays; a guide, a story tour, a
  glossary; rate limits and the deployment.
- **Skyshift** (the fast engine behind it, in `backend/app/engine`): one detector band at a time,
  a preview within seconds and the whole band in well under a minute; exposure pairs matched by
  wavelength; the blue/orange difference and colour by time; a second finder on the difference
  picture; halo photometry for saturated stars; a motion fit for any star; colour mixes and science
  views for the map; famous-object pins with one-line stories.

After that merge the Radians pair's newer work (GitHub `main`, 15 Nov 2026) was merged in as well:
**super-resolution** (dithered exposures drizzled onto 3″ pixels, with a before / after switch) in the
Map's deep zoom; a second look at every
tracker candidate in all-detector difference pictures ("found two ways"); three more ready-made
colour views and six more famous objects; a phone layout; rate limits on the lookups; and a
bibliography (`docs/KAYNAKCA.md`). Where both sides had built the same thing (fast band first,
colour by time, FITS download, the IRSA limit, reading coordinates) there is one of each, described
below.

**Cut back to SPHEREx.** The merge had also collected things that are not SPHEREx data, and code that
only the two old pages used. This version removes them: the Planetarium (a ground-based night sky
with visible-light star dots drawn over the infrared map; place and time change nothing in SPHEREx
data), the other surveys' skies on the Map and in the viewer's wider view (DSS, 2MASS, AllWISE) with
the Map's fade to 2MASS, the list of NEOSSat images, and the engine's own routes and modules that the
page never called (its second spectral-type fitter, its older period search, its picture renderer and
catalogue lookups). Catalogue markers and lookups (Gaia, CatWISE2020, SIMBAD, known asteroids) stay:
the challenge asks for them and they say what a dot is. Still doubled, because both are in use (one
for the fast band, one for all detectors): the file reader, the stacker and the archive search.

What the merge changed for a visitor: a new spot shows its first pictures after about 9 seconds
instead of 2 to 5 minutes (measured, see [Speed](#speed)), the candidate list comes from two
independent finders that are both tested, and the Map can mix wavelengths into colour.

## What the challenge asked for

The challenge asks for a public web tool that shows SPHEREx images of any RA/Dec "like a little video".
Its optional ideas, and where Radians stands:

| Suggestion on the challenge page | Radians |
|---|---|
| Easy to update with new data releases | Yes. Every public SPHEREx release in IRSA is searched live (`spherex_qr3` and `spherex_dr1` today; one setting to add the next), and the exposure lists are refreshed. |
| Add each detector's data to improve signal-to-noise; spectra on the fly | Yes. Outlier-rejecting mean stacks per sky pass in the fast band; inverse-variance co-adds per visit (and per visit and detector) over all detectors; a sharpened picture per visit from all six bands on 3″ pixels; a 0.75–5 µm spectrum of any pixel on request. |
| Add or subtract images from different times | Yes. A wavelength-matched difference (blue = was here, orange = is here now), frame − median, frame − previous, frame − first, a deep stack, and colour by time. |
| Let users choose the field of view | Yes. 2′ to 20′ (the fast band builds up to 10′). |
| Overlay Gaia or WISE | Yes. Gaia DR3 drawn on the image at each frame's date; every candidate is checked against Gaia DR3, SIMBAD and CatWISE2020 (a catalogue that cannot be reached is named as "could not check"); the same star's brightness in the 2MASS and AllWISE catalogues next to ours; Aladin Lite with the SPHEREx all-sky map and Gaia / CatWISE2020 markers. |
| Coordinates in the URL, embeddable | Yes. Every view is a link (`?ra=&dec=&fov=&band=&view=…`); `embed=1` hides the page chrome. |
| Contamination flags | Yes. Per-pixel SPHEREx flags shown on demand, summarised per frame, and used to mark doubtful measurements; saturated pixels are marked in the fast band. |
| Use the 102 bands creatively | Yes. Any one of the 102 planes of the all-sky cube in black and white (pick it on a slider, then confirm), the whole range squeezed into colour, five science views (water ice, CO₂ ice, methane, Paschen-α, Brackett-γ: the feature against the light beside it) and three three-colour views (ices, hydrogen gas, warm dust). |
| Public tools (Astropy, Aladin) | Astropy and PyVO throughout; Aladin Lite (CDS) for the Map and the wider view. |

Beyond the list: known asteroids from IMCCE SkyBoT, two candidate finders with injection tests (and a third look in all-detector difference
pictures), super-resolution from dithered exposures, spectral typing against 200 reference spectra,
an H-R diagram, a period search, FITS / CSV / GIF downloads, English and Turkish.

## How it works

1. You type a name (`Barnard's Star`, `Orion Nebula`) or coordinates in any common format
   (`08h55m10.8s -07d14m42s`, `133.795 -7.245`, `133,795 -7,245`, `RA 133.795 Dec -7.245`). The box
   suggests curated objects while you type and says how it read coordinates. Names are resolved with
   CDS Sesame, which also returns proper motion so fast movers stay centred; if the resolver is
   down, the built-in objects still open.
2. The backend asks NASA/IPAC IRSA which SPHEREx exposures cover that position (SIA2).
3. Instead of downloading 65 MB files, it reads only the pixel rows it needs with HTTP byte ranges,
   including the RICE-compressed contamination flags.
4. **Fast band first.** One detector band (the object's own, else band 5) is read by the engine.
   NASA's list says where each exposure sits on the sky, which predicts the target's pixel to within
   8 pixels, so the header and the pixel rows of an exposure come in one request: the first
   pictures already use every exposure, and one more request per exposure adds the variance and
   the quality flags. Exposures are grouped into sky passes (a new one after 20 days without data;
   a return visit of fewer than six exposures stays with its neighbour), and each pass is a
   clipped mean (the frames within 3 sigma of the median) on a 2″ north-up grid, all passes on one
   brightness scale.
5. **All detectors after that**, in the background: every exposure of all six bands is reprojected
   onto the native 6.15″ grid, background-subtracted, grouped into epochs and co-added with
   inverse-variance weights. This feeds the 0.75–5 µm spectrum, the colour composite, the detector
   tools and the tracker.
6. Every exposure also gives a brightness at a known wavelength (the SPHEREx linear-variable
   filters), which is what makes on-the-fly spectra possible.

**Wavelength matching** is the rule behind every comparison: SPHEREx has no filter wheel, so each
exposure sees a spot at its own wavelength, and two visits that sampled a band differently differ in
colour, which looks like change. Co-adds use only wavelengths every visit sampled; differences pair
exposures one by one within about one resolution element.

New data releases are picked up automatically: the archive is queried live, and adding a release is
one environment variable (`SPHEREX_COLLECTIONS=spherex_dr2,spherex_dr1`).

## Results on the five challenge targets

All from real SPHEREx data through the app (pre-built in `backend/demo`, so they open at once).

| Target | Tracker (all detectors) | Difference picture (one band) | Catalogue |
|---|---|---|---|
| Barnard's Star | 10.38″/yr north | 10.45 ± 1.01″/yr north (band 5) | 10.39″/yr |
| ε Indi B | 4.65″/yr south-east | 4.70 ± 0.30″/yr; a line through its position in 5 passes gives 4.67 ± 0.29″/yr | 4.68″/yr |
| WISE 0855−0714 | 8.16″/yr west (D5+D6) | declines: 3 matching exposures per pass | 8.15″/yr |
| RW Aurigae | about 70% brighter in D3/D4 | about 51% fainter in band 6 | young variable |
| R Draconis | nothing reported (it does not move) | about 41% fainter in band 6; halo light curve 0.50–1.62 × usual | Mira variable, ~246 d |

RW Aurigae is not a contradiction: it brightened at short wavelengths while its 4–5 µm light faded,
and the card shows both statements with their bands. ε Indi B is typed T3V from its spectrum (SIMBAD:
T1V+T6V, an unresolved pair): "agree". Barnard's Star and RW Aurigae are saturated, so the Type box
shows the catalogue side only and says why.

## Validation

Both finders are tested by putting fake objects into the real exposures of the five fields and
counting what comes back. Details and both methods: [docs/VALIDATION.md](docs/VALIDATION.md).

**Tracker** (`backend/scripts/inject_validate.py`; run again on the merged code, same result):

| Injected | S/N 5 | S/N 8 | S/N 12 | S/N 20 | S/N 40 |
|---|---|---|---|---|---|
| Mover, 9″/yr | 0% (0/40) | 50% (20/40) | 85% (34/40) | 100% (40/40) | 100% (40/40) |
| Variable (×3 in one visit) | 12% (5/40) | 80% (32/40) | 90% (36/40) | 88% (35/40) | 85% (34/40) |
| New source (one visit only) | 0% (0/40) | 42% (17/40) | 85% (34/40) | 100% (40/40) | 98% (39/40) |

**Difference picture** (`backend/scripts/engine/inject_validate.py`, no network needed):

| Injected | S/N 5 | S/N 8 | S/N 12 | S/N 20 | S/N 40 |
|---|---|---|---|---|---|
| Mover, 9″/yr | 50% (16/32) | 100% (32/32) | 100% (32/32) | 91% (29/32) | 100% (32/32) |
| Brightened (×2 in the last pass) | 22% (7/32) | 34% (11/32) | 53% (17/32) | 100% (32/32) | 100% (32/32) |
| Appeared (last pass only) | 53% (17/32) | 100% (32/32) | 100% (32/32) | 100% (32/32) | 100% (32/32) |

With nothing injected, neither finder reports anything besides the target in any of the five fields.
The two tests define S/N differently (see the validation document), so the columns are not
directly comparable.

## Speed

Measured on 15 Nov 2026 from Turkey, on positions in nobody's cache. The pixel reading of one band
of 55 to 59 exposures (241.90 −31.80), each way run several times on the same evening:

| | Requests | First pictures | Whole band |
|---|---|---|---|
| Before (headers first, then a few exposures per pass, then everything) | 201 to 260 | 9 to 14 s, from 24 exposures | 16.6 to 24.7 s |
| Now (one request per exposure, then one more) | 110 to 118 | 6.7 to 9.7 s, from every exposure | 10.9 to 14.6 s |

Add about 3 s for NASA's exposure list, unless the visitor paused on the suggestion first: the
page then asks for the list and opens the connections ahead of the click (`/api/quick/warm`).
A challenge target is pre-built and opens in under a second. All six bands (about 300 to 400
exposures) for the spectrum and the all-detector view took 2 to 3 minutes before; that reader now
makes two requests per exposure instead of four, but most of its time is the download of the
quality flags (about 370 kB per exposure), so expect a smaller gain there. It was not timed end
to end: NASA's image search was answering "502 Proxy Error" for the rest of that evening.

What was learnt on the way:
- A request on an open connection takes about 0.4 s, whatever it asks for (87 byte ranges or 1);
  a new connection costs 0.7 s alone and about 2.5 s when a dozen open at once. Idle connections
  stay usable for at least 30 s.
- More parallel requests do not help: IRSA throttles each client (measured by Efe: 12 in flight
  gave 1.3 exposures a second, 32 gave 0.6, 64 gave 0.3), so every reader in the server shares one
  limit (`IRSA_MAX_INFLIGHT`, 12).
- NASA's copy of the files on Amazon S3 (named in the exposure list) answered no faster from here
  and takes only one byte range per request, so it is not used.

## Repository layout

```
Radians/
├── backend/                     Python (FastAPI) server: reads public NASA/IPAC IRSA data, serves the API and the site
│   ├── app/
│   │   ├── main.py              app, routes (/api/…), caching headers, rate limits, serves frontend/ at /static
│   │   ├── quick.py             /api/quick…: an engine view in the viewer's frame format; differences, finds, motion
│   │   ├── mixtiles.py          /hips/spherex-mix and /hips/spherex-color: false-colour pictures of the all-sky cube for the Map
│   │   ├── net.py               shared helpers for outside services: GET with retries, CSV, a JSON disk cache
│   │   ├── irsa.py              one process-wide limit on requests in flight to IRSA
│   │   ├── archive.py           finds SPHEREx exposures (IRSA SIA2), resolves names (CDS Sesame)
│   │   ├── fitsrange.py         byte-range reads of remote FITS files (all-detector build)
│   │   ├── stack.py             reprojection, background subtraction, epochs, co-adds
│   │   ├── detect.py            the tracker: moving / variable / one-epoch candidates across all visits
│   │   ├── spectype.py          spectral type from a spectrum (standards + brown-dwarf models), fingerprints
│   │   ├── typecat.py           SIMBAD spectral type and Gaia DR3 parameters of one object
│   │   ├── curious.py           "for the curious": H-R diagram data, speed, period search, 2MASS / AllWISE
│   │   ├── crossmatch.py        SIMBAD + CatWISE2020 for the candidate cards
│   │   ├── external.py          Gaia DR3 and SkyBoT lookups
│   │   ├── config.py            settings from environment variables
│   │   └── engine/              the fast engine (merged in from Skyshift)
│   │       ├── http.py, sia.py, fitsread.py, field.py, store.py    polite HTTP, exposure search, byte-range reader, cut-out cache
│   │       ├── stacking.py      sky passes, wavelength matching, clipped-mean stacks, display levels
│   │       ├── views.py, api_views.py   view builds (preview, then the band), differences, /api/views/{id}/lightcurve
│   │       ├── photometry.py    box and halo-ring photometry, light curve
│   │       ├── changes.py       the difference-picture finder
│   │       ├── motion.py, render.py   a star's centre per pass and the line through them; filling saturated cores for display
│   │       ├── api_find.py, sky.py    curated objects and search, positions and proper motion
│   │       └── data/            curated objects (pins.json), known file layouts
│   ├── demo/                    the five challenge targets, pre-built (cache/ + built.pkl.gz; engine/ for the fast band)
│   ├── scripts/                 cache warming, demo media, validation; scripts/engine/ for the engine's builders
│   ├── tests/                   pytest (159 tests, no network); tests/engine/ against a fake IRSA
│   └── requirements.txt
├── frontend/                    the website (plain ES modules, no build step)
│   ├── index.html               the single page: Home, Blink viewer, Map
│   ├── slides.html              presentation slides (served at /static/slides.html)
│   ├── css/styles.css           Radians theme (dark/light), layout of every section
│   ├── js/
│   │   ├── core/                i18n.js (English / Turkish), ui.js, palette.js, cube.js, charts.js,
│   │   │                        aladin.js (viewer loader with a fallback), coords.js + suggest.js (search box)
│   │   ├── blink/               app.js (the viewer), sky.js (image maths), finds.js (cards, merging the two finders),
│   │   │                        typebox.js, curious.js, gif.js
│   │   ├── map/                 map.js (the Map), colour.js + colourdata.js (false-colour maths and texts)
│   │   └── content/             facts.js, about.js, funfacts.js
│   ├── media/                   the home page's target pictures (sharpened, made by backend/scripts/make_cards.py), GIFs and screenshots
│   └── tests/                   node tests (44): image maths, cards, colour, coordinates, whole-site checks
├── docs/                        validation report, demo script, slides PDF, figures
├── deploy/huggingface/          an unused Hugging Face Space set-up
├── explore/                     early probes of the IRSA archive (kept for reference)
├── Dockerfile, render.yaml      container and Render.com deployment
├── start-radians.bat            Windows: sets up and starts the site
└── .github/workflows/           CI: backend and frontend tests
```

## Run locally

Windows: double-click `start-radians.bat` (first run: a few minutes to set up; then
http://localhost:8765/).

Any system:

```bash
python -m venv .venv && .venv/bin/pip install -r backend/requirements.txt pytest httpx
.venv/bin/python -m uvicorn app.main:app --app-dir backend --port 8765
# open http://localhost:8765     (Windows: .venv\Scripts\python instead of .venv/bin/python)
```

Tests (no network needed): `cd backend && python -m pytest -q` and, from the repository root,
`node --test "frontend/tests/*.mjs"` (Node 21 or newer; on Node 20 leave the quotes out in a Unix shell).

Settings (environment variables, all optional): `SPHEREX_COLLECTIONS`, `CACHE_DIR`, `MAX_WORKERS`,
`WARM_ON_START`, `RATE_FRAMES`, `RATE_PHOT`, `MAX_COLD_BUILDS`, `CACHE_MAX_MB`, `IRSA_MAX_INFLIGHT`
(default 16), `SKYSHIFT_DATA` (the engine's cache folder; default `data/` next to `backend/`),
`SKYSHIFT_SIA_TTL_HOURS`, `SKYSHIFT_MAX_DISK_GB`.

## Deploy

The `Dockerfile` runs everything in one container. **Render** (what the live site uses): New → Web
Service → public repository URL, Docker, Free plan; or use the `render.yaml` Blueprint. The live
service was created by hand, so it does not redeploy on `git push`: use Manual Deploy → Deploy
latest commit in the dashboard.

The free plan sleeps after 15 quiet minutes, wakes in about a minute, and starts with an empty cache
on every wake and deploy; the five challenge targets are built into the image and always open at once.
The merged app has **not been deployed yet**, and its memory use on the 512 MB free plan has not
been measured.

## API

| Endpoint | Purpose |
|---|---|
| `GET /api/resolve?q=Barnard's Star` | name or coordinates → RA/Dec (+ proper motion); falls back to the built-in objects. Coordinates on the path of a moving built-in object (where it was at some date since 2000) are answered as that object: WISE 0855's own name gives its 2010 position, 134″ from where it is now |
| `GET /api/search?q=barn` | suggestions while typing: curated objects with their stories |
| `GET /api/pins` | the curated objects (challenge targets and famous sky) |
| `GET /api/coverage?ra=&dec=` | has SPHEREx seen this spot: exposures, sky passes, exposures per detector band |
| `GET /api/quick?ra=&dec=&fov=&band=&have=&wait=` | the fast band in the viewer's frame format: first pictures (every exposure, image only), then the whole band with variance and flags |
| `GET /api/quick/warm?ra=&dec=&band=` | a head start while the visitor is still choosing: the exposure list is fetched and connections are opened in the background (no pixels) |
| `GET /api/quick/diffs?id=` | each later pass minus the first, at matching wavelengths |
| `GET /api/quick/changes?id=` | finds on the difference picture, as candidate cards |
| `GET /api/quick/motion?id=&x=&y=` | a line through a star's position in every pass |
| `GET /api/views/{id}/lightcurve?x=&y=` | brightness over time at a spot in the fast band (`id` from `/api/quick`) |
| `GET /api/frames?ra=&dec=&fov=300&mode=epoch` | all detectors: aligned frames (`epoch`, `epoch_detector`, `exposure`) + photometry + tracker candidates + whether a star is at the target's spot. With `sharp=2`: one sharpened picture per visit on 3″ pixels instead |
| `GET /api/progress?job=` | progress of a running build |
| `GET /api/photometry?ra=&dec=&fov=&x=&y=` | per-exposure brightness and wavelength at one pixel: an on-the-fly spectrum |
| `POST /api/spectype` | spectral type, best-match curves and molecular fingerprints of a spectrum; optionally the catalogue side and the verdict |
| `GET /api/sharp?ra=&dec=&fov=&det=&factor=` | super-resolution: one detector band of a spot drizzled onto 3″ pixels (SPHEREx's are 6.15″) from its dithered exposures, plus the ordinary 6.15″ stack for a before / after comparison (the Map's deep zoom; cached a week) |
| `GET /api/curious/hr`, `/motion`, `/xmatch`, `/variable`, `/facts`, `POST /api/curious/period` | H-R diagram data, Gaia motion and speed, 2MASS / AllWISE (with fluxes), known variable stars (VSX, Gaia DR3), the star itself (distance, speeds, companion hints, radius, luminosity, mass, age, known planets), and the brightness check (change between visits, rhythm inside visits) |
| `GET /api/gaia`, `/api/crossmatch`, `/api/sso` | Gaia DR3; SIMBAD and CatWISE2020; SkyBoT |
| `GET /hips/blank/…`, `GET /hips/warm` | the Map's empty bottom layer; opens the server's connections to the archive when the Map opens |
| `GET /hips/spherex-color/…` | infrared colour sky as a HiPS (B = D1+D2, G = D3+D4, R = D5+D6) |
| `GET /hips/spherex-mix/{spec}/…` | planes of the all-sky cube mixed into false colour, as a HiPS: 2–3 tinted layers (`f21c0080ffg089_…`), or three plane numbers as red-green-blue (`88-65-18`) |

## Using the viewer

- **Fast band / All detectors / Sharpened** (top of the viewer): the fast band is on screen first;
  the D1–D6 chips next to it load another band. All detectors is the co-add of everything, read
  afterwards. The choice is remembered for the next new spot (a curated object keeps its own best
  band). **Sharpened** combines every exposure of a visit, all six bands together, on 3″ pixels
  (half SPHEREx's): a star comes out 8.9″ wide instead of 10.3″ and a pair separates from about
  11″ apart instead of 13″ (measured on test stars). It needs the all-detector data and takes
  about half a minute to make; a visit with fewer than 12 exposures gains nothing and is marked.
  "Smooth pixels" (display options) blends neighbouring pixels: softer when zoomed, no new detail.
- **Views**: Images; **Difference** (in the fast band: each later visit minus the first at matching
  wavelengths; otherwise frame − median / previous / first; always blue = was here, orange = is here
  now; a view that subtracts the first visit starts at the second, since the first minus itself is
  empty); **Colour by time** (every visit in its own colour, first blue, last red: what stays put is
  white, what moves leaves a trail); Stack.
- **A fast mover found by old coordinates.** Type `08h55m10.83s -07d14m42.5s` (the position in WISE
  0855's name) and the viewer says the coordinates lie on that object's path, then opens the object
  itself where it is today, with its own settings (D5 + D6). The same holds for any built-in moving
  object and any date between 2000 and now.
- **When NASA's archive is down** a new spot cannot be read. The viewer tries three more times with
  a countdown, then says so and offers the five prepared targets, which come with the app. An
  exposure list cached for a spot within 30″ is used meanwhile (from the team's PR #11).
- **Space** play/pause, **← →** step frames, the timeline jumps to a visit. All frames share one
  brightness scale, so a star that brightens really is brighter.
- Hover the image for RA/Dec, pixel value and the SPHEREx flags of that pixel; click any star to
  measure it. The light curve of the fast band is there at once; the spectrum needs all six bands.
- **Candidates**: one list from two finders. A card says what changed in plain words, which finder
  saw it ("found two ways" when both did, or when the all-detector difference pictures show the
  tracker's find too), what Gaia DR3, SIMBAD and CatWISE2020 know there, and warns about saturated
  stars and ghosts.
- Under the spectrum: the **Type** box (catalogues next to our own fit, with the best-match curve
  drawn over the points) and **For the curious** (H-R diagram, how it moves, does it pulse, other
  catalogues with their brightness next to SPHEREx's, and what Gaia and the NASA Exoplanet Archive
  know about the star itself). Both first check that a star is at the spot: on empty sky, or on the edge of a
  brighter neighbour, they say so instead of fitting noise (a click within 18″ of a star measures
  that star). "Does it pulse?" answers two things: whether the brightness changed between visits,
  and whether there is a rhythm inside the visits that date-shuffled copies of the data almost
  never match. When it cannot tell (too faint, saturated, too few points) it says why; it never
  gives a best guess. Next to it: what VSX and Gaia DR3 know about the star's variability.
  How often injected pulsations are found is in [`docs/VALIDATION.md`](docs/VALIDATION.md).
- Every view is a URL; add `&embed=1` for a chrome-free player to put in an `<iframe>`. GIF, PNG,
  CSV and FITS downloads (FITS: the visit or stack on screen, with its sky coordinates).

## Using the Map

Four themes, the same choice in the whole app. **Regular** (black sky) and **Inverted** (white sky)
show one wavelength of the SPHEREx all-sky cube in black and white: one wavelength alone has no
colour to show. A slider picks the wavelength and a button confirms it; the map loads a new plane
only then (the picked plane's tiles are fetched in the background meanwhile). **Colour** squeezes
the infrared range (0.75–5 µm) onto the colours the eye sees, in three steps: 0.75–1.6 µm blue,
1.6–3.8 µm green, 3.8–5 µm red. **Scientific** shows one feature at a time, picked from a row of
chips: five with the feature's wavelength in
orange and the light beside it in blue (water ice, CO₂ ice, methane, Paschen-α, Brackett-γ), three with three wavelengths as red, green and blue (ices,
hydrogen gas, warm dust). In the Blink viewer the same Regular / Inverted / Colour choice is under
Advanced; Colour needs all detectors there, because one band alone has no colour either.
Also: brightness and contrast, the challenge targets, Explore stars and 28 famous objects
as markers with a card that blinks the spot (the famous ones can be switched off in the legend).
Below 0.7° the **super-resolution** button reads the real
exposures of the spot in the band of the chosen wavelength and drizzles them onto 3″ pixels
(`backend/app/sharp.py`); Before / After switches to the ordinary 6″ stack on the same brightness
scale. The map shows SPHEREx only; zoomed in past its 13″ pixels it says that it is only magnifying
them. All colour is false colour and labelled so.

### How fast the Map is, and what it depends on

One wavelength (Regular, Inverted): the tiles go straight from NASA's archive (IRSA, California) to
the browser. Measured from Turkey: about 1.1 s for a tile on a new connection, 0.2–0.4 s on an open
one; a screen needs 12 to 40 tiles, so a new view takes 1 to 5 seconds and nothing on our side can
shorten the trip. What we do: the wavelength you picked is fetched in the background before you
confirm it, and only that wavelength is fetched. (An earlier version drew a second layer under it
to hide a detector's small holes; it turned out to be the 0.75 µm picture at every wavelength,
loaded a second time. It is gone: where SPHEREx has no data at a wavelength the map stays empty.)
Colour and Scientific: our server
makes each tile from 12 (Colour) or 2–3 (Scientific) archive tiles, then keeps it for ever. It
keeps its connections to the archive open and opens them when the Map opens (`/hips/warm`): a new
Colour tile takes 0.7 s (it took 2.6 s), a new Scientific tile 0.3 s (2.4 s), a screenful of twelve
new Colour tiles 3.7 s; a tile seen before comes from the disk or the browser cache at once. On a
Windows PC, opening the site as `127.0.0.1` saves 0.2 s on every new connection compared with
`localhost` (the start script does that).

## Sharing one free server

Each visitor may ask for 20 all-detector views (super-resolution counts as one) and 90 spectra a
minute, and 60 a minute of each catalogue or fit lookup (crossmatch, coverage, spectral type, object
details, the "for the curious" tools, the fast band's finds and motion fit); beyond that the answer is
HTTP 429 with `Retry-After`. At most two new positions are read by the all-detector build at the
same time, and two by the engine; every request to IRSA takes one of 12 slots; IRSA's own
`Retry-After` is honoured; the cut-out caches are trimmed, oldest first. All of these are
environment settings (`RATE_FRAMES`, `RATE_PHOT`, `RATE_LOOKUP`, `MAX_COLD_BUILDS`, `CACHE_MAX_MB`,
`IRSA_MAX_INFLIGHT`).

## Limitations

- SPHEREx pixels are 6.15″: motions below about 1″ a year do not show between visits a year apart.
- Saturated stars have no usable core. Their brightness comes from the PSF wings or a halo ring
  (relative only), and the Type box shows the catalogue side only.
- Visits are compared only at wavelengths every visit sampled. When visits share few wavelengths the
  comparison is noisier, and the difference finder says "too few pictures" instead of guessing.
- The fast band is one detector band of up to 10′ (2″ pixels up to that size, unless a deep field
  has so many exposures that they would not fit in memory). What only all detectors can give (the
  full spectrum, the colour composite, the sharpened pictures) arrives minutes later on a position
  nobody has looked at.
- "Does it pulse?" can only test rhythms that fit inside a visit about twice (1 day to a few
  weeks on most of the sky), needs single measurements above a signal-to-noise of 3, and reports a
  change between visits only from about 15%. Slower or smaller changes are not seen.
- Completeness of both finders falls off at low S/N (see Validation); a source fainter than that in
  every visit will not be reported.
- Asteroids move within a visit and blur in the stacks; SkyBoT marks the known ones per exposure.
- It cannot prove a Planet X: a planet hundreds of AU away moves by arcminutes between visits (mostly
  parallax), so it shows as a spot that is "new" in one visit and "gone" in another, not as one mover.
- "Not in Gaia DR3" means no Gaia star brighter than G = 19 within 7″. Infrared-only objects such as
  WISE 0855 are never in Gaia: check CatWISE2020 before calling anything new.
- Colour mixes and science views of the Map are made on the server from the cube's display tiles
  (8-bit, already stretched): for looking, not for measuring; a new place takes seconds to fill in.
- Super-resolution cannot beat the telescope's own blur (about 9″): the 3″ grid samples that blur
  better than the 6.15″ pixels do, it does not make new detail.
- Not checked: the phone layout on a real phone, Turkish wording of the new texts by a native
  speaker, the embed mode, the deployment, a 10′ view on the new 300-pixel grid against the live
  archive, and the known-planets lookup against the live NASA Exoplanet Archive (it answered with
  an error page while this was built; the page then says it could not be reached).

## Use of AI

Both versions and the merge were written during the hackathon weekend (14–15 November 2026) with an
AI coding assistant, Anthropic's Claude (Claude Code), under the team's direction: it wrote most of
the code, tests and documentation from the team's product decisions, summarised SPHEREx documents
into build notes, drafted the English and Turkish interface texts, and helped check results. The
team chose the challenge, the product, the features and the look, made every scope decision
(including each choice of the merge), tested the app and checked the science against catalogues.
Commits the assistant helped write carry a `Co-Authored-By: Claude` line. Every image shown as data
is real SPHEREx data; nothing shown as data is AI-generated, and colour pictures are labelled false
colour.

## Inspiration disclosure

Before the hackathon (12–13 November 2026), one team member built a separate pre-event prototype,
"SPHEREx Blink". The fast engine in `backend/app/engine` was **written from zero during the event**.
We studied the prototype's code and documentation to learn archive facts (for example, how to read
only the needed bytes of SPHEREx files) and took inspiration from its interface and features. **No
code was copied from it** (a few short lines may read the same where there is only one natural way
to write them, such as a FITS keyword or a standard library call). We also looked at the
public-domain WiseView tool for ideas only. The Map's "Infrared RGB" colour recipe is team member
Emre Bozkaya's, from his SPHEREx Sky Explorer.

## Licence

Code and text: MIT ([LICENSE](LICENSE)). Data stay under their providers' terms (see below).
This project is not endorsed by NASA. No NASA logos are used.

## Team

Mert Metin · Efe Gönderen · Bora Hısım · Emre Bozkaya

## Data and credits

This research has made use of the NASA/IPAC Infrared Science Archive, which is funded by the National
Aeronautics and Space Administration and operated by the California Institute of Technology. This work
has made use of data from the European Space Agency (ESA) mission Gaia (https://www.cosmos.esa.int/gaia),
processed by the Gaia Data Processing and Analysis Consortium (DPAC). This research has made use of the
SIMBAD database and Aladin, operated at CDS, Strasbourg, France, and of IMCCE's SkyBoT service.

- **SPHEREx** spectral images and the DR1 all-sky HiPS cube: NASA/JPL-Caltech SPHEREx mission, served by
  the NASA/IPAC Infrared Science Archive (IRSA). Photometry follows the IRSA SPHEREx tutorial notebooks
  (annulus background, flag bits, wavelength from the WCS-WAVE table).
- **SPHEREx HiPS** sky map (the DR1 all-sky cube): served by IRSA.
- **Gaia DR3**: ESA Gaia archive (TAP). **CatWISE2020**: IRSA / VizieR. **2MASS and AllWISE** catalogue
  entries: VizieR (CDS, Harvard mirror). Catalogue stars are moved to each frame's date with their
  proper motions, so fast movers line up with the SPHEREx image.
- **SIMBAD / Sesame**: CDS, Strasbourg (also through the Harvard mirror). Sky viewer: **Aladin Lite**
  (CDS, GPL-3.0, loaded from a CDN).
- **Spectral types**: reference spectra from the Pickles (1998) stellar flux library, the SpeX Prism
  spectral standards (Burgasser et al.; via the SPLAT toolkit) and the Sonora Bobcat brown-dwarf models
  (Marley et al. 2021, Zenodo record 5063476), smoothed to SPHEREx resolution. Type–temperature tables:
  Pecaut & Mamajek (2013), Filippazzo et al. (2015).
- **Known Solar System objects**: IMCCE SkyBoT.
- **Infrared colour recipe of the Map**: Emre Bozkaya (SPHEREx Sky Explorer).
- Built with Astropy, PyVO, NumPy, SciPy, Pillow and FastAPI; the browser side has no build step or
  framework.
