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
| Mover, 9″/yr | 50% (16/32) | 100% (32/32) | 100% (32/32) | 97% (31/32) | 100% (32/32) |
| Brightened (×2 in the last pass) | 25% (8/32) | 28% (9/32) | 78% (25/32) | 100% (32/32) | 100% (32/32) |
| Appeared (last pass only) | 47% (15/32) | 100% (32/32) | 100% (32/32) | 100% (32/32) | 100% (32/32) |

| Field (nothing injected) | Band | Passes | Finds besides the target | Finder's own note |
|---|---|---|---|---|
| Epsilon Indi B | 5 | 5 | 0 | – |
| WISE 0855−0714 | 5 | 4 | 0 | too few pictures at matching wavelengths: it does not search |
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

This table was run again after two later changes to the fast band (same day): pass pictures are a
clipped mean instead of a median (`stacking.pass_stack`: per pixel, the mean of the frames within
3 sigma of the median; measured on 92 real pass pictures from two independent halves of their
frames, the noise is 11% lower), and a new visit starts after 20 days without data instead of 45
(so Epsilon Indi B has five passes and WISE 0855 four). Before those changes the rows read
50 / 100 / 100 / 91 / 100% (mover), 22 / 34 / 53 / 100 / 100% (brightened) and 53 / 100 / 100 / 100 /
100% (appeared): the same within the scatter of 32 trials, except a doubling at S/N 12, which went
from 53% to 78%.

## "Does it pulse?": the brightness check

The tool under the spectrum used to run one period search on everything and always came back with
a "best guess". On the five challenge fields those guesses were 20 to 50 days for every star, and
the same measurements with their brightness values shuffled gave 24 to 31 days too: the answer came
from the observing dates and the noise. At a spot with no star (signal 0.4 times the noise) the
"usual brightness" it divided by was close to zero, which produced points 80 and 3967 times brighter
than usual. It now works like this (`backend/app/pulse.py`):

1. **Is a star there?** The median of all exposures is looked at in a small box around the spot
   (`stack.spot_check`). No peak above 5 times the picture's noise: "no star stands out", and
   neither a type nor a rhythm is given. A peak that is not at the spot, next to a neighbour at
   least twice as bright: the light is that neighbour's edge. If it is within 3 pixels the page
   measures the neighbour instead.
2. **Clean points.** Flagged and saturated points are left out (or, for a saturated star, the page's
   "PSF wings" measurement is used). Each point is divided by the usual brightness of its six
   nearest neighbours in wavelength inside the same detector band; a group whose usual brightness is
   not itself measured to 3 sigma is dropped. A point more than 5 sigma from the others taken within
   three days is a stray (a cosmic ray, an asteroid). Fewer than 30 points left, or single points
   below a signal-to-noise of 3: it says so and stops.
3. **Between visits.** Each visit with at least five points gets a level (the median) with an error
   from the scatter inside the visit and a 2% calibration floor. The pair of visits that differ most
   is reported; it counts as a change from 5 sigma and 5%.
4. **A rhythm.** Each visit's own level is taken out, so a plain change between visits cannot pass
   for a period. A weighted Lomb-Scargle search covers 1 day to twice the longest visit (a rhythm
   longer than that was never seen for a whole cycle). The best peak is compared with 300 copies of
   the same measurements whose dates are shuffled inside each visit. It counts when fewer than 1 in
   100 copies do as well and the visits cover at least two cycles; otherwise the page says
   "no rhythm found between 1 and N days".
5. **What the catalogues know.** The AAVSO index (VSX) and Gaia DR3's variability flag and class are
   shown next to our answer, also when we cannot test the star ourselves, and a catalogue period is
   compared with ours.

`python backend/scripts/pulse_validate.py 3 2 20` (about 12 minutes, no network: it uses the
pre-built all-detector fields in `backend/demo/built.pkl.gz`). It takes field stars that are not
saturated (5 qualified: signal-to-noise of single measurements 20 to 121, median 30, about 290 usable
measurements each), turns each into a steady star with its real dates, wavelengths, spectrum and
noise (the real scatter of its points, shuffled), and injects:

| Pulsation injected | period 1.7 d | period 3 d | period 6 d | period 11 d |
|---|---|---|---|---|
| ±5% | 20% (2/10) | 40% (4/10) | 30% (3/10) | 30% (3/10) |
| ±10% | 90% (9/10) | 80% (8/10) | 90% (9/10) | 80% (8/10) |
| ±20% | 100% (10/10) | 100% (10/10) | 100% (10/10) | 80% (8/10) |
| ±40% | 100% (10/10) | 100% (10/10) | 100% (10/10) | 80% (8/10) |

| One visit brighter by | Found as a change between visits |
|---|---|
| 10% | 0% (0/10) |
| 20% | 70% (7/10) |
| 40% | 100% (10/10) |

Nothing injected (100 runs): a rhythm reported in 0, a change between visits in 0.

Reading it:
- A pulsation counts as found when it is reported as convincing with a period within 10% of the
  true one. From ±10% it is found in 8 or 9 of 10 runs; ±5% is at the level of the scatter of single
  points (6 to 12% for these stars) and is found in about a third.
- An 11-day period is missed more often in fields whose visits last under a week: fewer than two
  cycles are seen, and the tool then refuses by design.
- A step between visits is reported from about 15% (5 sigma of two 2% floors plus the scatter):
  10% is never reported, 40% always.
- Only five stars qualified, so the percentages are rough. All five are ordinary field stars of
  signal-to-noise 20 or more; fainter stars will do worse, and the tool refuses below 3.
- Not tested: real variable stars with a known period (the one in the challenge list, R Dra, is
  saturated in every exposure and even its wings are usable in only 50 of 400, so the tool says it
  cannot follow it and shows the catalogue period of 246 days instead), periods under one day, and
  stars that flicker without a period.
