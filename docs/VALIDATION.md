# Validating the candidate finder

How often does Radians find a moving, variable or new object when one is really there, and how often
does it point at something when nothing is?

## Method

`python backend/scripts/inject_validate.py 8` (about two minutes on cached data):

1. Read the real SPHEREx exposures of the five challenge fields (4′ × 4′; WISE 0855 with detector 6
   only), exactly as the app does.
2. Pick a random position on empty sky: more than 3.5 px from any S/N > 5 source, more than 5 px from
   the target, and S/N < 2 in the deep stack of all exposures.
3. Add a Gaussian PSF (σ = 0.62 px, SPHEREx's core on the 6.15″ grid) to every exposure:
   - **mover**: 1.5 px a year (9″/yr) in a random direction, position computed at each exposure's time;
   - **variable**: a steady source that is three times brighter in one random visit;
   - **new source**: present in one random visit only.
   Brightness is set so the source has the stated S/N per visit, measured the way the finder measures
   it (aperture flux over robust noise, which includes confusion noise; the pipeline's formal errors
   are tens of times smaller here and would overstate S/N).
4. Co-add with wavelength matching and run the finder, as in the app; count a recovery when a
   candidate of the right type lies within 1.5 px of the injected position.
5. 8 injections per field, type and S/N: 40 per cell. Fixed random seed, so the table is reproducible.

## Results

| Injected | S/N 5 | S/N 8 | S/N 12 | S/N 20 | S/N 40 |
|---|---|---|---|---|---|
| Mover, 9″/yr | 0% (0/40) | 50% (20/40) | 85% (34/40) | 100% (40/40) | 100% (40/40) |
| Variable (×3 in one visit) | 12% (5/40) | 80% (32/40) | 90% (36/40) | 88% (35/40) | 85% (34/40) |
| New source (one visit only) | 0% (0/40) | 42% (17/40) | 85% (34/40) | 100% (40/40) | 98% (39/40) |

| Field (nothing injected) | Visits | Candidates besides the target |
|---|---|---|
| Barnard's Star | 5 | 0 |
| eps Indi B | 4 | 0 |
| WISE J085510.83-071442.5 | 4 | 0 |
| RW Aur | 3 | 0 |
| R Dra | 3 | 0 |

## Reading the table

- Below S/N 8 per visit nothing is reported on purpose: the finder only follows sources above S/N 8,
  and the false-alarm count above shows that threshold keeps the candidate list clean.
- Movers and new sources are complete from S/N ≈ 20. Variables level off near 85–90 %: the finder
  needs two detectors to agree on the change, which a few injections do not get.
- What it does not test: sources on top of other sources (the injections avoid them), very fast movers
  that blur within a visit (asteroids), and saturated stars.

## Changes this test led to

The first run recovered only about half of the bright new sources. Two causes were fixed in the finder:
"absent in the other visits" was judged against the formal error, so ordinary confusion noise counted
as "present"; it now uses the same robust noise as detection. And visits were numbered after
wavelength matching, which could split one visit in two; they are now numbered from all exposures.

## WISE 0855

WISE 0855 is the hardest challenge target: very cold (~285 K), so it is only visible at 4–5 µm, faint, and a
static field star sits 7.8″ away, closer than SPHEREx's ~9″ PSF at these wavelengths. Two independent checks
(14 Nov 2026):

| Setup | Exposures per epoch | Finder result |
|---|---|---|
| D6 only, wavelength matching on (previous default) | 3, 18, 3, 21 | nothing reported |
| D6 only, matching off | 3, 18, 3, 21 | nothing reported |
| D5+D6, matching on | 1, 2, 2, 1 | no target; two spurious "transient" candidates |
| **D5+D6, matching off (new default for this target)** | **11, 37, 9, 36** | **moving, 8.16″/yr, PA 285°, 7.3σ** (catalogue 8.15″/yr, PA 275°) |

Matching across two detectors keeps only wavelengths every visit sampled, which leaves almost nothing; each
detector co-added on its own gives enough signal. The rate is right; the ~10° position-angle offset is
probably the static neighbour pulling the single-source fit.

**Independent measurement** (Efe's SPHEREx Blink prototype; IRSA cutouts, D5+D6, the three 6-month
passes, a two-source PSF fit with the neighbour's position fixed from D2, where WISE 0855 is invisible):
7.64″ W, 0.52″ N over one year against 8.01″ W, 0.65″ N predicted from SIMBAD proper motion + parallax,
every pass within 0.4″ of prediction, field-star registration 0.06–0.15″ rms. The last-minus-first
difference image shows the moving pair at 4–5 µm and none at 1.1–1.6 µm.

**Note on coordinates.** The challenge text gives WISE 0855 at 08h55m10.831s −07°14′42.53″, its 2010
discovery position. During SPHEREx (2025–26) it is ~125″ west and ~10″ north of that point, outside a 100″
field. Radians handles this by propagating proper motion to each exposure date and by its 240″ default
field.

## A second look at every tracker candidate: all-detector difference pictures

Every tracker candidate is looked for a second time in the same all-detector data. The **star tracker** links sources visit to visit and fits a straight
line (moving), compares a star with itself at the same detector (variable), or finds a source absent from
every other visit (one epoch only). The **difference pictures** subtract from each visit the median of the
other visits: static stars cancel, a mover leaves an orange "is here now" / blue "was here" pair. A tracker
candidate these pictures also show carries `found_by: ["track", "difference"]` and is marked
"found two ways" in the viewer. This check does not add candidates of its own; the finder on the
fast band's difference picture (next section) does.

**Injection test** (`backend/tests/test_core.py::test_injected_faint_mover_recovered_two_ways`, runs in CI):
a faint star (peak 6σ per pixel per visit) moving 1.5 px per visit across four visits, in Gaussian noise and
a field of three static stars of 15–40σ, is recovered as the one moving candidate, by both finders; none of
the static stars leaves a difference-picture detection.

## The second finder: the difference picture

The candidate list itself comes from two finders. The tracker above follows sources across every
visit in all detectors. The second one comes from the map-first engine and works on one detector
band: it stacks the first and the last sky pass from exposure pairs that saw the same wavelength,
subtracts them, and looks for what is left (a blue/orange pair is a mover; a lone spot is something
that appeared, vanished, brightened or faded). A card on the page says which finder saw it, and
"found two ways" when both did.

`python backend/scripts/engine/inject_validate.py 8` (about two minutes, no network: it uses the
pre-built views of the five challenge fields in `backend/demo/engine`):

1. Take the real exposures of the view's band, already on the view's 2″ grid.
2. Pick a random position on empty sky: matched-filter S/N below 3 in both passes, more than two
   point-spread widths from anything brighter than S/N 8, away from the target and the edges.
3. Add a Gaussian of 9″ FWHM (the SPHEREx point-spread width) to every exposure:
   - **mover**: 9″/yr in a random direction, placed at each exposure's own date;
   - **brightened**: a steady source that is twice as bright in the last pass;
   - **appeared**: present in the last pass only.
   S/N is per sky pass as a matched filter sees it: the source's peak in one pass's stack, smoothed
   with the point-spread function, over the robust noise of that smoothed stack.
4. Stack the two passes at matching wavelengths and run the finder, as the site does; count a
   recovery when a find of the right kind lies within 7″ of the injected position.
5. 8 injections per field, kind and S/N in the four fields where the finder runs: 32 per cell.

| Injected | S/N 5 | S/N 8 | S/N 12 | S/N 20 | S/N 40 |
|---|---|---|---|---|---|
| Mover, 9″/yr | 50% (16/32) | 100% (32/32) | 100% (32/32) | 91% (29/32) | 100% (32/32) |
| Brightened (×2 in the last pass) | 22% (7/32) | 34% (11/32) | 53% (17/32) | 100% (32/32) | 100% (32/32) |
| Appeared (last pass only) | 53% (17/32) | 100% (32/32) | 100% (32/32) | 100% (32/32) | 100% (32/32) |

| Field (nothing injected) | Band | Passes | Finds besides the target | Finder's own note |
|---|---|---|---|---|
| Epsilon Indi B | 5 | 4 | 0 | – |
| WISE 0855−0714 | 5 | 3 | 0 | too few pictures at matching wavelengths (3 per pass): it does not search |
| Barnard's Star | 5 | 3 | 0 | – |
| RW Aurigae | 6 | 3 | 0 | – |
| R Draconis | 6 | 4 | 0 | – |

Reading it:

- Movers and new sources are complete from S/N 8 per pass. The three movers missed at S/N 20 were
  in the two fields with a saturated star (RW Aurigae, R Draconis), whose halo raises the bar nearby.
- A source that only doubles is harder: the finder asks for a change of at least 20% of the
  source's light well above the noise, so doubling is found reliably from S/N 20.
- With nothing injected it reports nothing besides the target in any field.
- WISE 0855 has three matching exposures per pass in band 5. The finder says so and does not
  search, instead of reporting something it cannot stand behind; the tracker (D5+D6) finds it.
- The two tests use different S/N definitions (aperture flux over noise per visit for the tracker,
  matched-filter peak per pass here), so their columns are not directly comparable.
- Not tested here either: sources on top of other sources, asteroids that move within a pass, and
  the saturated-star branch of the finder (covered by unit tests with synthetic stars).

The tracker's own table above was run again on the merged code (15 Nov 2026) and came out the same,
cell for cell.
