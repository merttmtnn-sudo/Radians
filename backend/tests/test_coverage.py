"""Coverage summary of a spot (map card): passes, bands and dates from the exposure list, no network."""
from fastapi.testclient import TestClient

from app import archive, main
from app.archive import Exposure


def exp(i, det, mjd):
    return Exposure(f"o{i}", det, "u", mjd - 0.001, mjd + 0.001, 1, 2, 100, "c")


def test_summary_counts_passes_and_bands():
    # two passes about six months apart; band 6 never saw the spot
    exps = [exp(i, 1 + i % 5, 60900 + i * 0.5) for i in range(10)] + [exp(100 + i, 1 + i % 5, 61080 + i) for i in range(5)]
    s = main.coverage_summary(exps)
    assert s["count"] == 15
    assert [p["n"] for p in s["passes"]] == [10, 5] and [p["epoch"] for p in s["passes"]] == [1, 2]
    assert s["first"] == s["passes"][0]["start"] and s["last"] == s["passes"][1]["end"]
    assert s["first"] < s["passes"][0]["end"] < s["passes"][1]["start"]
    assert s["detectors"] == {"1": 3, "2": 3, "3": 3, "4": 3, "5": 3, "6": 0}
    assert 180 < s["span_days"] < 190


def test_summary_of_an_unobserved_spot():
    s = main.coverage_summary([])
    assert s["count"] == 0 and s["first"] is None and s["passes"] == []
    assert set(s["detectors"]) == {"1", "2", "3", "4", "5", "6"}


def test_route_and_archive_down(monkeypatch):
    monkeypatch.setattr(archive, "query_exposures", lambda ra, dec: [exp(1, 2, 60900.0)])
    r = TestClient(main.app).get("/api/coverage", params={"ra": 10.123456, "dec": -5})
    assert r.status_code == 200 and r.json()["count"] == 1 and len(r.json()["passes"]) == 1

    def down(ra, dec):
        raise archive.ArchiveUnavailable("busy")
    monkeypatch.setattr(archive, "query_exposures", down)
    assert TestClient(main.app).get("/api/coverage", params={"ra": 10, "dec": -5}).status_code == 503
