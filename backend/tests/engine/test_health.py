from fastapi.testclient import TestClient

from app.engine.main import create_app


def test_health():
    r = TestClient(create_app()).get("/api/health")
    assert r.status_code == 200
    assert r.json()["ok"] is True
