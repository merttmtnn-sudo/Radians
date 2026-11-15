"""Build app/data/spectral_library.npz: reference spectra as SPHEREx would see them.

Sources (all outside the repository, under ../resources/spectral_library/):
- pickles/  Pickles (1998) stellar flux library, O5-M types, all luminosity classes, 0.115-2.5 um
- spex/     SpeX Prism spectral standards M0-T9 (Burgasser et al.; from the SPLAT toolkit), 0.65-2.56 um
- sonora/   Sonora Bobcat cloud-free brown-dwarf models (Marley et al. 2021), 200-2400 K,
            log g = 5.0, solar metallicity, C/O = 1.5 x solar (the small single-gravity set on Zenodo)

Every spectrum is converted to flux per unit frequency (what SPHEREx measures, mJy), smoothed to
the SPHEREx resolving power of each detector band and sampled on one common wavelength grid.
Where a source has no data the value is NaN, so a fit only uses the wavelengths a template covers.

Run from backend/:  ..\\.venv\\Scripts\\python -X utf8 scripts/build_spectral_library.py
"""
from __future__ import annotations

import csv
import gzip
import io
import re
import sys
import tarfile
from pathlib import Path

import numpy as np
from astropy.io import fits

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from app.engine.spectype import GRID_UM, RESOLVING_POWER, band_of, type_code  # noqa: E402

LIB = Path(__file__).resolve().parents[3] / "resources" / "spectral_library"
OUT = Path(__file__).resolve().parents[2] / "app" / "engine" / "data" / "spectral_library.npz"



def to_sphere_x(wave_um: np.ndarray, fnu: np.ndarray) -> np.ndarray:
    """Smooth a spectrum (flux per unit frequency) to SPHEREx resolution on the common grid:
    at each grid wavelength a Gaussian of FWHM = wavelength / R of that detector band."""
    order = np.argsort(wave_um)
    w, f = wave_um[order], fnu[order]
    ok = np.isfinite(f) & np.isfinite(w)
    w, f = w[ok], f[ok]
    out = np.full(GRID_UM.size, np.nan)
    if w.size < 10:
        return out
    step = np.gradient(w)
    for i, lam in enumerate(GRID_UM):
        sigma = lam / RESOLVING_POWER[band_of(lam)] / 2.355
        if lam - 1.5 * sigma < w[0] or lam + 1.5 * sigma > w[-1]:
            continue                                     # the template does not reach this wavelength
        near = np.abs(w - lam) <= 3 * sigma
        if near.sum() < 2:
            continue
        weight = np.exp(-0.5 * ((w[near] - lam) / sigma) ** 2) * step[near]
        out[i] = np.sum(weight * f[near]) / np.sum(weight)
    return out


def pickles():
    index = fits.getdata(LIB / "pickles" / "pickles_uk.fits", 1)
    for name, sptype in zip(index["FILENAME"], index["SPTYPE"]):
        data = fits.getdata(LIB / "pickles" / f"{name.strip()}.fits", 1)
        wave = data["WAVELENGTH"].astype("f8") / 1e4                     # Angstrom -> um
        flam = data["FLUX"].astype("f8")
        flam[flam <= 0] = np.nan                                         # zeros mark "no data" in this library
        yield sptype.strip(), "Pickles", wave, flam * wave ** 2


def spex():
    with open(LIB / "spex" / "standards.csv", newline="") as fh:
        for row in csv.DictReader(fh):
            data = fits.getdata(LIB / "spex" / (row["FILENAME"].strip() + ".gz"), 0)
            wave, flam = data[0].astype("f8"), data[1].astype("f8")
            sptype = re.sub(r"\.0$", "", row["SPT"].strip())             # 'T8.0' -> 'T8'
            yield sptype + "V", "SpeX", wave, flam * wave ** 2


def sonora():
    tar = next(iter(sorted((LIB / "sonora").glob("*.tar.gz"))), None)
    if tar is None:
        print("no Sonora archive found: the library is built without brown-dwarf models")
        return
    with tarfile.open(tar) as archive:
        for member in archive:
            m = re.search(r"sp_t(\d+)g1000nc_m[+-]?0\.0", member.name)
            if not m:
                continue
            raw = archive.extractfile(member).read()
            if member.name.endswith(".gz"):
                raw = gzip.decompress(raw)
            table = np.loadtxt(io.BytesIO(raw), skiprows=2)
            wave, fnu = table[:, 0], table[:, 1]                         # um, erg/cm2/s/Hz
            keep = (wave > 0.6) & (wave < 5.6)
            yield f"{int(m.group(1))} K", "Sonora", wave[keep], fnu[keep]


def main():
    names, sources, codes, teffs, spectra = [], [], [], [], []
    for label, source, wave, fnu in [*pickles(), *spex(), *sonora()]:
        flux = to_sphere_x(wave, fnu)
        if np.isfinite(flux).sum() < 30:
            print("skipped (too little coverage):", source, label)
            continue
        flux /= np.nanmedian(flux)
        names.append(label)
        sources.append(source)
        codes.append(type_code(label) if source != "Sonora" else np.nan)
        teffs.append(float(label.split()[0]) if source == "Sonora" else np.nan)
        spectra.append(flux.astype("f4"))
    OUT.parent.mkdir(exist_ok=True)
    np.savez_compressed(OUT, grid_um=GRID_UM.astype("f4"), names=np.array(names), sources=np.array(sources),
                        codes=np.array(codes, "f4"), teffs=np.array(teffs, "f4"), spectra=np.array(spectra))
    by = {s: sources.count(s) for s in sorted(set(sources))}
    print(f"wrote {len(names)} spectra {by} on {GRID_UM.size} wavelengths to {OUT} ({OUT.stat().st_size / 1e3:.0f} kB)")


if __name__ == "__main__":
    main()
