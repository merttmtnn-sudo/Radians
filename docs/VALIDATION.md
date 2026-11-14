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
