import numpy as np

from app.engine import spectype as sp


def synthetic(name, noise=0.02, scale=40.0, seed=0, lo=0.76, hi=4.98, n=420):
    """Fake SPHEREx points drawn from a library spectrum: scale * template, with noise."""
    lib = sp.library()
    i = [str(x) for x in lib["names"]].index(name)
    rng = np.random.default_rng(seed)
    waves = np.exp(rng.uniform(np.log(lo), np.log(hi), n))
    t = np.interp(waves, lib["grid_um"], lib["spectra"][i], left=np.nan, right=np.nan)
    keep = np.isfinite(t)
    flux = scale * t[keep] * (1 + noise * rng.standard_normal(keep.sum()))
    return [dict(wave_um=float(w), flux_mJy=float(f), err_mJy=float(noise * scale * abs(tt) + 1e-3), saturated=False)
            for w, f, tt in zip(waves[keep], flux, t[keep])]


def test_type_codes_and_temperatures():
    assert sp.type_code("M4V") == 64 and sp.type_code("T8.5") == 88.5 and sp.type_code("B12III") == 11.5
    assert sp.type_code("K01II") == 50.5 and sp.type_code("wF5V") == 35 and np.isnan(sp.type_code("?"))
    assert sp.type_name(64) == "M4" and sp.type_name(88.5) == "T8.5"
    assert sp.luminosity_class("M5III") == "III" and sp.luminosity_class("G5IV") == "IV" and sp.luminosity_class("T8") == ""
    assert sp.teff_of("G2V") == 5770 and sp.teff_of("M5III") == 3400 and 2900 < sp.teff_of("M4.5V") < 3200
    assert sp.type_at_teff(700) == "T8" and sp.type_at_teff(300) == "Y2"


def test_library_is_complete():
    lib = sp.library()
    sources = [str(s) for s in lib["sources"]]
    assert sources.count("Pickles") == 131 and sources.count("SpeX") == 30 and sources.count("Sonora") >= 20
    assert np.isfinite(lib["spectra"]).sum(axis=1).min() >= 30


def test_standards_are_recovered():
    for name in ("M4V", "G2V", "T6V", "L3V", "K3III"):
        got = sp.fit(synthetic(name, seed=3))
        best = got["standards"]
        assert best and abs(sp.type_code(best["type"]) - sp.type_code(name)) <= 1, (name, best and best["type"])
        lo, hi = (sp.type_code(v) for v in best["range"])
        assert lo <= sp.type_code(best["type"]) <= hi and best["curve"]["wave"]


def test_model_temperature_is_recovered_and_cold_objects_need_no_short_light():
    got = sp.fit(synthetic("900 K", seed=5))
    assert abs(got["model"]["teff"] - 900) <= 100 and got["model"]["type"].startswith("T")
    cold = sp.fit(synthetic("300 K", seed=6, lo=3.6, hi=4.98, n=200))          # like WISE 0855: only 3.6-5 um
    assert cold["standards"] is None and cold["model"] and cold["model"]["teff"] <= 450 and cold["model"]["type"].startswith("Y")


def test_saturated_or_faint_spectra_give_no_type():
    pts = synthetic("M4V")
    for p in pts[: int(0.7 * len(pts))]:
        p["saturated"] = True
    assert sp.fit(pts)["note"] == "saturated"
    faint = [dict(p, flux_mJy=np.random.default_rng(1).normal(0, 1), err_mJy=1.0) for p in synthetic("M4V")]
    got = sp.fit(faint)
    assert got["standards"] is None


def test_fingerprints():
    by = {f["id"]: f for f in sp.fingerprints(synthetic("T6V", noise=0.01))}
    assert by["water"]["verdict"] == "present" and by["water"]["depth"] > 0.5
    assert by["methane"]["verdict"] == "no_data"                       # the SpeX standard stops at 2.5 um
    model = {f["id"]: f for f in sp.fingerprints(synthetic("900 K", noise=0.01))}
    assert model["methane"]["verdict"] == "present" and model["water"]["verdict"] == "present"
    star = {f["id"]: f for f in sp.fingerprints(synthetic("G2V", noise=0.01))}
    assert star["water"]["verdict"] == "absent" and star["co"]["verdict"] == "absent"


def test_agreement():
    result = dict(standards=dict(type="M4V", teff=3200), model=None)
    assert sp.agreement("M3.5V", None, result) == "agree" and sp.agreement("K7V", None, result) == "differ"
    assert sp.agreement(None, 3300, result) == "agree" and sp.agreement(None, None, result) == "unknown"


def test_cold_signature_and_blend_badge():
    import numpy as np
    w = np.array([3.3, 3.5, 3.7, 3.9, 4.2, 4.4, 4.6, 4.8])
    cold = dict(wave=w, flux=np.array([0.2, 0.18, 0.2, 0.22, 0.8, 0.75, 1.0, 0.8]), err=np.full(8, 0.05))
    star = dict(wave=w, flux=np.array([1.0, 0.95, 0.9, 0.85, 0.8, 0.77, 0.74, 0.7]), err=np.full(8, 0.05))
    assert sp.cold_signature(cold)["ratio"] > 3
    assert sp.cold_signature(star) is None
    assert sp.agreement("Y2", None, dict(note="blend", standards=dict(type="F8V", teff=6170))) == "blend"
