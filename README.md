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

- **Radians** (the interface you see): one page with Home, the Blink viewer, the all-sky Map and the
  Planetarium; a candidate tracker with an injection test; SkyBoT, NEOSSat and Gaia overlays; a guide,
  a story tour, a glossary; rate limits and the deployment.
- **Skyshift** (the fast engine behind it, in `backend/app/engine`): one detector band at a time,
  a preview within seconds and the whole band in well under a minute; exposure pairs matched by
  wavelength; the blue/orange difference and colour by time; a second finder on the difference
  picture; halo photometry for saturated stars; a motion fit for any star; colour mixes and science
  views for the map; constellations and famous-object pins with one-line stories.

After that merge the Radians pair's newer work (GitHub `main`, 15 Nov 2026) was merged in as well:
**super-resolution** (dithered exposures drizzled onto 3″ pixels, with a before / after switch) in the
Map's and the Planetarium's deep zoom; a **details panel** in the Planetarium (SIMBAD facts and a
Wikipedia summary); the Map fading to 2MASS where SPHEREx's pixels run out; a second look at every
tracker candidate in all-detector difference pictures ("found two ways"); three more ready-made
colour views and six more famous objects; a phone layout; rate limits on the lookups; and a
bibliography (`docs/KAYNAKCA.md`). Where both sides had built the same thing (fast band first,
colour by time, FITS download, the IRSA limit, reading coordinates) there is one of each, described
below.

What the merge changed for a visitor: a new spot shows its first pictures after about 9 seconds
instead of 2 to 5 minutes (measured, see [Speed](#speed)), the candidate list comes from two
independent finders that are both tested, and the Map can mix wavelengths into colour.

## What the challenge asked for

The challenge asks for a public web tool that shows SPHEREx images of any RA/Dec "like a little video".
Its optional ideas, and where Radians stands:

| Suggestion on the challenge page | Radians |
|---|---|
| Easy to update with new data releases | Yes. Every public SPHEREx release in IRSA is searched live (`spherex_qr3` and `spherex_dr1` today; one setting to add the next), and the exposure lists are refreshed. |
| Add each detector's data to improve signal-to-noise; spectra on the fly | Yes. Median stacks per sky pass in the fast band; inverse-variance co-adds per visit (and per visit and detector) over all detectors; a 0.75–5 µm spectrum of any pixel on request. |
| Add or subtract images from different times | Yes. A wavelength-matched difference (blue = was here, orange = is here now), frame − median, frame − previous, frame − first, a deep stack, and colour by time. |
| Let users choose the field of view | Yes. 2′ to 20′ (the fast band builds up to 10′). |
| Overlay Gaia or WISE | Yes. Gaia DR3 drawn on the image at each frame's date; every candidate is checked against Gaia DR3, SIMBAD and CatWISE2020 (a catalogue that cannot be reached is named as "could not check"); the same star in 2MASS and AllWISE; Aladin Lite with AllWISE, 2MASS, CatWISE2020 and SPHEREx maps. |
| Coordinates in the URL, embeddable | Yes. Every view is a link (`?ra=&dec=&fov=&band=&view=…`); `embed=1` hides the page chrome. |
| Contamination flags | Yes. Per-pixel SPHEREx flags shown on demand, summarised per frame, and used to mark doubtful measurements; saturated pixels are marked in the fast band. |
| Use the 102 bands creatively | Yes. A slider and a tour over the 102 planes of the all-sky cube, "mix 2–3 wavelengths" into false colour, five science views (water ice, CO₂ ice, methane, Paschen-α, Brackett-γ: the feature against the light beside it) and three three-colour views (ices, hydrogen gas, warm dust). |
| Public tools (Astropy, Aladin) | Astropy and PyVO throughout; Aladin Lite (CDS) for the Map and the wider view. |

Beyond the list: known asteroids from IMCCE SkyBoT, archived NEOSSat images from the Canadian Space
Agency, two candidate finders with injection tests (and a third look in all-detector difference
pictures), super-resolution from dithered exposures, spectral typing against 200 reference spectra,
an H-R diagram, a period search, FITS / CSV / GIF downloads, a Planetarium with a details panel,
English and Turkish.

## How it works

1. You type a name (`Barnard's Star`, `Orion Nebula`) or coordinates in any common format
   (`08h55m10.8s -07d14m42s`, `133.795 -7.245`, `133,795 -7,245`, `RA 133.795 Dec -7.245`). The box
   suggests curated objects while you type and says how it read coordinates. Names are resolved with
   CDS Sesame, which also returns proper motion so fast movers stay centred; if the resolver is
   down, the built-in objects still open.
2. The backend asks NASA/IPAC IRSA which SPHEREx exposures cover that position (SIA2).
3. Instead of downloading 65 MB files, it reads only the pixel rows it needs with HTTP byte ranges,
   including the RICE-compressed contamination flags.
4. **Fast band first.** One detector band (the object's own, else band 5) is read by the engine:
   a preview from a few exposures per sky pass, spread in wavelength, then the whole band. Exposures
   are grouped into sky passes (SPHEREx returns about every six months), and each pass is a median
   stack on a 2″ north-up grid, all passes on one brightness scale.
5. **All detectors after that**, in the background: every exposure of all six bands is reprojected
   onto the native 6.15″ grid, background-subtracted, grouped into epochs and co-added with
   inverse-variance weights. This feeds the 0.75–5 µm spectrum, the colour composite, the detector
   tools, the Sharpening section and the tracker.
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
| ε Indi B | 4.65″/yr south-east | 4.37 ± 0.34″/yr; a line through its position in 4 passes gives 4.68 ± 0.34″/yr | 4.68″/yr |
| WISE 0855−0714 | 8.16″/yr west (D5+D6) | declines: 3 matching exposures per pass | 8.15″/yr |
| RW Aurigae | about 70% brighter in D3/D4 | about 52% fainter in band 6 | young variable |
| R Draconis | nothing reported (it does not move) | about 46% fainter in band 6; halo light curve 0.51–1.64 × usual | Mira variable, ~246 d |

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

Measured on 15 Nov 2026 from Turkey, on a position in nobody's cache (150.123 +20.456):

| Step | Time |
|---|---|
| Preview of the fast band on screen (about 8 exposures per pass) | 9 s |
| The whole band (68 exposures, 3 passes) | 18 s |
| All six bands (305 exposures) for the spectrum and the all-detector view | about 3 min |
| Another band of a field already visited | 8 s |
| A challenge target (pre-built) | under 1 s |

More parallel requests do not help: IRSA throttles each client (measured by Efe: 12 in flight gave
1.3 exposures a second, 32 gave 0.6, 64 gave 0.3), so every reader in the server shares one limit
(`IRSA_MAX_INFLIGHT`, 12).

## Repository layout

```
Radians/
├── backend/                     Python (FastAPI) server: reads public NASA/IPAC IRSA data, serves the API and the site
│   ├── app/
│   │   ├── main.py              app, routes (/api/…), caching headers, rate limits, serves frontend/ at /static and /planet
│   │   ├── quick.py             /api/quick…: an engine view in the viewer's frame format; differences, finds, motion
│   │   ├── mixtiles.py          /hips/spherex-mix: false-colour mixes of the all-sky cube for the Map
│   │   ├── irsa.py              one process-wide limit on requests in flight to IRSA
│   │   ├── archive.py           finds SPHEREx exposures (IRSA SIA2), resolves names (CDS Sesame)
│   │   ├── fitsrange.py         byte-range reads of remote FITS files (all-detector build)
│   │   ├── stack.py             reprojection, background subtraction, epochs, co-adds
│   │   ├── detect.py            the tracker: moving / variable / one-epoch candidates across all visits
│   │   ├── spectype.py          spectral type from a spectrum (standards + brown-dwarf models), fingerprints
│   │   ├── typecat.py           SIMBAD spectral type and Gaia DR3 parameters of one object
│   │   ├── curious.py           "for the curious": H-R diagram data, speed, period search, 2MASS / AllWISE
│   │   ├── crossmatch.py        SIMBAD + CatWISE2020 for the candidate cards
│   │   ├── external.py          Gaia DR3, SkyBoT, NEOSSat (CADC) lookups
│   │   ├── explorer.py          planetarium API (/api/sx/…) and the infrared-RGB HiPS tiles (/hips/spherex-color)
│   │   ├── config.py            settings from environment variables
│   │   └── engine/              the fast engine (merged in from Skyshift)
│   │       ├── http.py, sia.py, fitsread.py, field.py, store.py    polite HTTP, exposure search, byte-range reader, cut-out cache
│   │       ├── stacking.py      sky passes, wavelength matching, median stacks, display levels
│   │       ├── views.py, api_views.py   view builds (preview, then the band) and /api/views/…
│   │       ├── photometry.py    box and halo-ring photometry, light curve, spectrum
│   │       ├── changes.py       the difference-picture finder
│   │       ├── catalogs.py, spectype.py, advanced.py   catalogue cones, typing, period / motion / H-R / cross-match
│   │       ├── api_find.py, sky.py, hips.py   curated objects and search, positions and proper motion, per-plane HiPS
│   │       └── data/            curated objects (pins.json), reference spectra
│   ├── demo/                    the five challenge targets, pre-built (cache/ + built.pkl.gz; engine/ for the fast band)
│   ├── scripts/                 cache warming, demo media, validation; scripts/engine/ for the engine's builders
│   ├── tests/                   pytest (146 tests, no network); tests/engine/ against a fake IRSA
│   └── requirements.txt
├── frontend/                    the website (plain ES modules, no build step)
│   ├── index.html               the single page: Home, Blink viewer, Map, Planetarium
│   ├── slides.html              presentation slides (served at /static/slides.html)
│   ├── css/styles.css           Radians theme (dark/light), layout of every section
│   ├── js/
│   │   ├── core/                i18n.js (English / Turkish), ui.js, palette.js, cube.js, charts.js,
│   │   │                        aladin.js (viewer loader with a fallback), coords.js + suggest.js (search box)
│   │   ├── blink/               app.js (the viewer), sky.js (image maths), finds.js (cards, merging the two finders),
│   │   │                        typebox.js, curious.js, depth.js (Sharpening), gif.js
│   │   ├── map/                 map.js (the Map), colour.js + colourdata.js (false-colour maths and texts),
│   │   │                        constellations.js
│   │   ├── planetarium/         planetsec.js (Planetarium section controls)
│   │   └── content/             facts.js, about.js, funfacts.js
│   ├── data/                    constellation lines, names and boundaries (d3-celestial, BSD-3)
│   ├── planet/                  planetarium engine (by Emre Bozkaya), also a page of its own at /planet/
│   ├── media/                   GIFs and screenshots of the challenge targets
│   └── tests/                   node tests (42): image maths, cards, colour, coordinates, constellations, whole-site checks
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
| `GET /api/resolve?q=Barnard's Star` | name or coordinates → RA/Dec (+ proper motion); falls back to the built-in objects |
| `GET /api/search?q=barn` | suggestions while typing: curated objects with their stories |
| `GET /api/pins` | the curated objects (challenge targets and famous sky) |
| `GET /api/coverage?ra=&dec=` | has SPHEREx seen this spot: exposures, sky passes, exposures per detector band |
| `GET /api/quick?ra=&dec=&fov=&band=&have=&wait=` | the fast band in the viewer's frame format: preview, then the whole band |
| `GET /api/quick/diffs?id=` | each later pass minus the first, at matching wavelengths |
| `GET /api/quick/changes?id=` | finds on the difference picture, as candidate cards |
| `GET /api/quick/motion?id=&x=&y=` | a line through a star's position in every pass |
| `POST /api/views`, `GET /api/views/{id}/…` | the engine's own API: status, pass pictures, light curve, spectrum, type, FITS (see `backend/app/engine/api_views.py`) |
| `GET /api/frames?ra=&dec=&fov=300&mode=epoch` | all detectors: aligned frames (`epoch`, `epoch_detector`, `exposure`) + photometry + tracker candidates |
| `GET /api/progress?job=`, `/api/depth` | progress of a running build; data for the Sharpening section |
| `GET /api/photometry?ra=&dec=&fov=&x=&y=` | per-exposure brightness and wavelength at one pixel: an on-the-fly spectrum |
| `POST /api/spectype` | spectral type, best-match curves and molecular fingerprints of a spectrum; optionally the catalogue side and the verdict |
| `GET /api/sharp?ra=&dec=&fov=&det=&factor=` | super-resolution: one detector band of a spot drizzled onto 3″ pixels (SPHEREx's are 6.15″) from its dithered exposures, plus the ordinary 6.15″ stack for a before / after comparison (map and planetarium deep zoom; cached a week) |
| `GET /api/object?ra=&dec=&id=&lang=&kind=` | planetarium details panel: SIMBAD facts (type, magnitudes, distance, spectral type, other names) and a Wikipedia summary in the page language, found through Wikidata catalogue codes |
| `GET /api/curious/hr`, `/motion`, `/xmatch`, `POST /api/curious/period` | H-R diagram data, Gaia motion and speed, 2MASS / AllWISE, period search |
| `GET /api/gaia`, `/api/crossmatch`, `/api/sso`, `/api/neossat` | Gaia DR3; SIMBAD and CatWISE2020; SkyBoT; NEOSSat |
| `GET /api/sx/…` | the planetarium and its own time-lapse / spectra tool |
| `GET /hips/spherex-color/…` | infrared colour sky as a HiPS (B = D1+D2, G = D3+D4, R = D5+D6) |
| `GET /hips/spherex-mix/{spec}/…` | planes of the all-sky cube mixed into false colour, as a HiPS: 2–3 tinted layers (`f21c0080ffg089_…`), or three plane numbers as red-green-blue (`88-65-18`) |
| `GET /hips/spherex/{frame}/…` | one plane of the all-sky cube as a plain HiPS (redirects to IRSA) |

### Planetarium

`/planet/` is **SPHEREx Sky Explorer** by team member Emre Bozkaya
([EmreBozkaya127/SPHEREx-Sky-Wiever](https://github.com/EmreBozkaya127/SPHEREx-Sky-Wiever)): a planetarium for
any place and time drawn over the SPHEREx all-sky cube, with survey comparison, catalogue overlays, and a
time-lapse / spectrophotometry tool that works on every SPHEREx exposure of a target. His Node.js server was
ported to Python (`backend/app/explorer.py`); HiPS tiles come straight from IRSA.

## Using the viewer

- **Fast band / All detectors** (top of the viewer): the fast band is on screen first; the D1–D6
  chips next to it load another band. All detectors is the co-add of everything, read afterwards.
  The choice is remembered for the next new spot (a curated object keeps its own best band).
- **Views**: Images; **Difference** (in the fast band: each later visit minus the first at matching
  wavelengths; otherwise frame − median / previous / first; always blue = was here, orange = is here
  now); **Colour by time** (every visit in its own colour, first blue, last red: what stays put is
  white, what moves leaves a trail); Stack.
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
  catalogues).
- Every view is a URL; add `&embed=1` for a chrome-free player to put in an `<iframe>`. GIF, PNG,
  CSV and FITS downloads (FITS: the visit or stack on screen, with its sky coordinates).

## Using the Map

A slider and a tour over the 102 wavelengths of the SPHEREx all-sky cube, six palettes, **colour
mixes** of two or three wavelengths, eight **science views** (five with the feature's wavelength in
orange and the light beside it in blue; three with three wavelengths as red, green and blue: ices,
hydrogen gas, warm dust), constellations, the challenge targets, Explore stars and 28 famous objects
as markers with a card that blinks the spot (the famous ones can be switched off in the legend), and
2MASS and DSS skies to compare with. Below 0.7° the **super-resolution** button reads the real
exposures of the spot in the band of the chosen wavelength and drizzles them onto 3″ pixels
(`backend/app/sharp.py`); Before / After switches to the ordinary 6″ stack on the same brightness
scale. Closer than 0.25° the map fades to 2MASS (1″ pixels) and says on screen that this is not
SPHEREx. All colour is false colour and labelled so.

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
- The fast band is one detector band of up to 10′. What only all detectors can give (the full
  spectrum, the colour composite) arrives minutes later on a position nobody has looked at.
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
- Not checked after the merges: the phone layout on a real phone, Turkish wording of the new texts
  by a native speaker, the embed mode, and the deployment.

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
public-domain WiseView tool for ideas only. The planetarium engine is team member Emre Bozkaya's
own SPHEREx Sky Explorer, adapted for this site.

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
- **2MASS, AllWISE, DSS2 and SPHEREx HiPS** sky maps: served by IRSA.
- **Gaia DR3**: ESA Gaia archive (TAP). **CatWISE2020**: IRSA / VizieR. **2MASS and AllWISE** catalogue
  entries: VizieR (CDS, Harvard mirror). Catalogue stars are moved to each frame's date with their
  proper motions, so fast movers line up with the SPHEREx image.
- **SIMBAD / Sesame**: CDS, Strasbourg (also through the Harvard mirror). Sky viewer: **Aladin Lite**
  (CDS, GPL-3.0, loaded from a CDN).
- **Spectral types**: reference spectra from the Pickles (1998) stellar flux library, the SpeX Prism
  spectral standards (Burgasser et al.; via the SPLAT toolkit) and the Sonora Bobcat brown-dwarf models
  (Marley et al. 2021, Zenodo record 5063476), smoothed to SPHEREx resolution. Type–temperature tables:
  Pecaut & Mamajek (2013), Filippazzo et al. (2015).
- **Known Solar System objects**: IMCCE SkyBoT. **NEOSSat** (Canadian Space Agency) archive search: CADC.
- **Constellation lines, names and boundaries; star, constellation and Milky Way data of the
  planetarium**: d3-celestial by Olaf Frohn (BSD-3-Clause, see `frontend/data/LICENSE-d3-celestial.txt`).
- **Planetarium, its time-lapse / spectra tool and the infrared colour recipe**: Emre Bozkaya
  (SPHEREx Sky Explorer).
- Built with Astropy, PyVO, NumPy, SciPy, Pillow and FastAPI; the browser side has no build step or
  framework.
