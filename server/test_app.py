import os, tempfile
os.environ["DATABASE_URL"] = "sqlite:///" + os.path.join(tempfile.mkdtemp(), "t.db")
os.environ["STATIC_DIR"] = tempfile.mkdtemp()
from fastapi.testclient import TestClient
import app as m

c = TestClient(m.app)
FB = {"town": "bedok", "segment": "1-2-3", "verdict": "correct", "note": "ok\x00"}
RT = {"town": "bedok", "destination_type": "park", "coords": [[103.9, 1.3], [103.91, 1.31]]}


def test_flow():
    assert c.get("/api/health").json() == {"ok": True, "db": "sqlite"}
    r = c.post("/api/feedback", json=FB)
    assert r.status_code == 201 and r.json()["note"] == "ok"
    assert len(c.get("/api/feedback", params={"town": "bedok"}).json()) == 1
    assert c.get("/api/feedback", params={"town": "x y"}).status_code == 422
    assert c.post("/api/routes", json=RT).status_code == 201
    assert c.get("/api/routes", params={"town": "bedok"}).json()[0]["coords"][0] == [103.9, 1.3]


def test_invalid():
    assert c.post("/api/feedback", json={**FB, "verdict": "nope"}).status_code == 422
    assert c.post("/api/feedback", json={**FB, "verdict": "missed"}).status_code == 422
    assert c.post("/api/routes", json={**RT, "coords": [[0, 0], [1, 1]]}).status_code == 422
    assert c.get("/api/nope").status_code == 404


def test_rate_limit():
    m.HITS.clear()
    codes = [c.post("/api/feedback", json=FB).status_code for _ in range(31)]
    assert codes[:30] == [201] * 30 and codes[30] == 429
