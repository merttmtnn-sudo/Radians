p = "README.md"
s = open(p, encoding="utf-8").read()
s = s.replace("| 3 | Discovery tools: difference/sum images, per-detector co-adds, field of view, flag overlay | 🚧 |",
              "| 3 | Discovery tools: difference/stack views, detector selection, flag summary, candidate finder, EN/TR | ✅ |")
s = s.replace("| 4 | Extras: on-the-fly spectra, Gaia / WISE overlays with Aladin Lite | ⏳ |",
              "| 4 | Extras: on-the-fly spectra, light curves, Gaia / WISE overlays with Aladin Lite | 🚧 |")
if "## Finding things" not in s:
    s = s.replace("## Using the viewer", """## Finding things

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

## Using the viewer""")
s = s.replace("- Every view is a URL: `/?q=RW%20Aur&fov=240&mode=epoch&frame=1&cmap=heat`.",
              "- Every view is a URL: `/?q=RW%20Aur&fov=240&frame=1&cmap=heat&view=diff_median&det=4,5,6&lang=tr`.")
open(p, "w", encoding="utf-8").write(s)
print("ok")
