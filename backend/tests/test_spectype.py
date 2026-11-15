"""Spectral type box: the fit, the fingerprints, the agreement verdict and the catalogue lookups. No network."""
import numpy as np
import pytest
from fastapi.testclient import TestClient

from app import archive, config, explorer, spectype, typecat
from app.main import app

LIB = spectype.library()


def synth(name, n=330, noise=0.02, flux=1e4, seed=1, saturate=0.0):
    """Exposures of a library spectrum as the page sends them: one wavelength each, 2% noise."""
    rng = np.random.default_rng(seed)
    i = list(map(str, LIB["names"])).index(name)
    w = np.exp(rng.uniform(np.log(0.76), np.log(4.98), n))
    t = np.interp(w, LIB["grid_um"], LIB["spectra"][i])
    return [{"wavelength": float(a), "flux_ujy": float(flux * b * (1 + noise * rng.standard_normal())),
             "err_ujy": float(flux * b * noise), "saturated": bool(rng.random() < saturate)}
            for a, b in zip(w, t) if np.isfinite(b)]


def test_library_is_shipped():
    assert LIB is not None and LIB["spectra"].shape[1] == spectype.GRID_UM.size
    assert {"Pickles", "SpeX", "Sonora"} == set(map(str, LIB["sources"]))


def test_type_codes_and_temperatures():
    assert spectype.type_code("M4V") == 64 and spectype.type_code("dM4.5e") == 64.5
    assert spectype.type_code("T8.5") == 88.5 and spectype.type_code("B12III") == 11.5
    assert np.isnan(spectype.type_code("")) and np.isnan(spectype.type_code(None))
    assert spectype.type_name(64) == "M4" and spectype.type_name(88.5) == "T8.5"
    assert spectype.teff_of("G2V") == 5770 and spectype.teff_of("M4III") == 3500
    assert spectype.type_at_teff(1000) in ("T5", "T6")


@pytest.mark.parametrize("name", ["A0V", "G2V", "M4V", "K3III", "T5V"])
def test_fit_recovers_the_standard_it_was_made_from(name):
    r = spectype.fit(synth(name))
    assert r["note"] is None and r["standards"]["type"] == name
    lo, hi = (spectype.type_code(t) for t in r["standards"]["range"])
    assert lo <= spectype.type_code(name) <= hi


def test_a_warm_star_gets_no_brown_dwarf_model_and_a_cold_one_does():
    assert spectype.fit(synth("G2V"))["model"] is None
    cold = spectype.fit(synth("500 K"))
    assert cold["model"]["teff"] == 500 and cold["model"]["type"].startswith(("T", "Y"))


def test_mostly_saturated_or_empty_spectra_get_no_fit():
    assert spectype.fit(synth("M4V", saturate=0.8))["note"] == "saturated"
    assert spectype.fit([])["note"] == "too_faint"
    junk = [{"wavelength": None, "flux_ujy": float("nan"), "err_ujy": None, "saturated": False}] * 30
    assert spectype.fit(junk)["note"] == "too_faint"


def test_fingerprints():
    star = {f["id"]: f for f in spectype.fingerprints(synth("G2V"))}
    assert star["water"]["verdict"] == "absent" and star["co"]["verdict"] == "absent"
    assert star["methane"]["verdict"] == "no_data"                    # the standards stop at 2.45 um
    cold = {f["id"]: f for f in spectype.fingerprints(synth("500 K"))}
    assert cold["water"]["verdict"] == "present" and cold["methane"]["verdict"] == "present"
    assert cold["methane"]["depth"] > 0.9


def test_agreement():
    ours = {"standards": {"type": "M4V", "teff": 3200}, "model": None, "note": None}
    assert spectype.agreement("M3.5V", None, ours) == "agree"
    assert spectype.agreement("M0V", None, ours) == "close"
    assert spectype.agreement("G2V", None, ours) == "differ"
    assert spectype.agreement(None, 3300, ours) == "agree"
    assert spectype.agreement(None, 5800, ours) == "differ"
    assert spectype.agreement(None, None, ours) == "unknown"
    assert spectype.agreement("M4V", None, {"note": "blend"}) == "blend"
    assert spectype.agreement("T8", None, {"standards": None, "model": {"type": "T9", "teff": 550}}) == "agree"


class Reply:
    def __init__(self, text, ok=True):
        self.text, self.ok = text, ok


SIMBAD = 'main_id,sp_type,otype,ra,dec\n"far star","K0V","*",10.0015,5.0\n"V* near","M4V","BY*",10.0001,5.0\n'
GAIA = ("source_id,teff_gspphot,logg_gspphot,mh_gspphot,distance_gspphot,parallax,parallax_over_error,"
        "classprob_dsc_combmod_star,spectraltype_esphs\n123,3250.5,4.9,-0.4,1.9,546.98,900,0.99,\n")


def test_catalogue_lookup(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "CACHE_DIR", tmp_path)
    monkeypatch.setattr(explorer, "_get", lambda url, params=None, **kw: Reply(SIMBAD if "simbad" in url else GAIA))
    out = typecat.lookup(10.0, 5.0, None, "Gaia DR3 123")
    assert out["simbad"] == {"ok": True, "found": True, "id": "V* near", "sptype": "M4V", "otype": "BY*"}
    g = out["gaia"]
    assert g["ok"] and g["teff"] == 3250.5 and g["p_star"] == 0.99 and g["hot_type"] is None
    assert abs(g["distance_pc"] - 1.83) < 0.01                          # from the parallax, not the photometric guess
    assert typecat.lookup(10.0, 5.0, None, None)["gaia"] == {"ok": True, "found": False}


def test_named_target_uses_its_simbad_entry_not_the_position(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "CACHE_DIR", tmp_path)
    monkeypatch.setattr(archive, "details", lambda name: {"name": "NAME Barnard's star", "sptype": "M4V", "otype": "BY*"})

    def no_network(*a, **kw):
        raise AssertionError("should not query by position")
    monkeypatch.setattr(explorer, "_get", no_network)
    assert typecat.lookup(269.45, 4.69, "Barnard's Star", None)["simbad"]["sptype"] == "M4V"


def test_route_fit_first_then_catalogues(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "CACHE_DIR", tmp_path)

    def down(*a, **kw):
        raise explorer.Upstream("down")
    monkeypatch.setattr(explorer, "_get", down)
    c = TestClient(app)
    body = {"points": synth("M4V"), "ra": 10, "dec": 5}
    r = c.post("/api/spectype", json=body).json()
    assert r["fit"]["standards"]["type"] == "M4V" and r["catalogue"] is None and len(r["fingerprints"]) == 5
    # catalogues down: our own answer still comes back, and the verdict is "unknown", not an error
    r = c.post("/api/spectype", json={**body, "catalogues": True, "gaia_id": "123"}).json()
    assert r["fit"]["standards"]["type"] == "M4V"
    assert not r["catalogue"]["simbad"]["ok"] and not r["catalogue"]["gaia"]["ok"] and r["agreement"] == "unknown"
    assert c.post("/api/spectype", json={"points": [], "ra": 400, "dec": 0}).status_code == 422


def test_fit_returns_the_best_match_as_a_curve_through_the_data():
    """The curve the page draws over the spectrum: the reference spectrum, scaled, inside the fitted window."""
    r = spectype.fit(synth("G2V", flux=5e3))
    st = r["standards"]
    wave, flux = np.array(st["curve"]["wave"]), np.array(st["curve"]["flux"])
    assert wave.size > 50 and wave.min() >= spectype.STANDARDS_UM[0] and wave.max() <= spectype.STANDARDS_UM[1]
    data_w, data_f = np.array(r["data"]["wave"]), np.array(r["data"]["flux"])
    inside = (data_w >= wave.min()) & (data_w <= wave.max())
    assert inside.sum() >= 20
    at_data = np.interp(data_w[inside], wave, flux)
    assert np.median(np.abs(at_data / data_f[inside] - 1)) < 0.03          # it runs through the binned points
    cold = spectype.fit(synth("T5V", flux=5e3))
    assert cold["model"] and len(cold["model"]["curve"]["wave"]) > 50
    assert max(cold["model"]["curve"]["wave"]) > 4.5                        # models cover the long wavelengths too
    assert spectype.fit(synth("G2V", saturate=0.9))["standards"] is None    # no fit, no curve
