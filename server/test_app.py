import os, tempfile
os.environ["DATABASE_URL"] = "sqlite:///" + os.path.join(tempfile.mkdtemp(), "t.db")
os.environ["STATIC_DIR"] = tempfile.mkdtemp()
from fastapi.testclient import TestClient
import app as m

c = TestClient(m.app)
FB = {"town": "bedok", "segment": "1-2-3", "verdict": "correct", "note": "ok\x00"}
RT = {"town": "bedok", "destination_type": "park", "coords": [[103.9, 1.3], [103.91, 1.31]]}


def test_flow():
    assert c.get("/api/health").json()["db"] == "sqlite"
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


JPEG = "data:image/jpeg;base64," + __import__("base64").b64encode(b"\xff\xd8\xff\xe0" + b"0" * 100).decode()


def test_reports():
    m.HITS.clear()
    r = c.post("/api/reports", json={"lat": 1.37, "lng": 103.85, "category": "steps", "description": "Too many steps",
                                     "photo": JPEG})
    assert r.status_code == 201
    rid = r.json()["id"]
    c.post("/api/reports", json={"lat": 1.3702, "lng": 103.8501, "category": "no_seat"})  # within 60 m
    c.post("/api/reports", json={"address_hint": "Blk 123 Ang Mo Kio Ave 3", "category": "dark"})  # no location
    assert c.get(f"/api/reports/{rid}/photo").content.startswith(b"\xff\xd8\xff")
    # region lookup needs the site's data; this test static dir has none, so reports have no region
    assert r.json()["town"] is None
    with m.Session(m.engine) as s:  # pretend they were placed in a region
        for x in s.scalars(m.select(m.Report)):
            x.town = "ang-mo-kio"
        s.commit()
    cl = c.get("/api/reports/clusters", params={"town": "ang-mo-kio"}).json()
    assert len(cl) == 1 and cl[0]["count"] == 2 and cl[0]["ai"] is None
    assert len(c.get("/api/reports", params={"town": "ang-mo-kio", "category": "steps"}).json()) == 1
    bad = [{"lat": 1.37, "lng": 103.85, "category": "lava"},
           {"category": "steps"},
           {"lat": 40.0, "lng": 100.0, "category": "steps"},
           {"lat": 1.37, "lng": 103.85, "category": "steps", "photo": "data:image/jpeg;base64," + "QUJD"}]
    assert all(c.post("/api/reports", json=b).status_code == 422 for b in bad)
    assert c.get("/api/regions/locate", params={"lat": 1.37, "lng": 103.85}).json() == {"town": None, "name": None}


def test_point_in_polygon():
    sq = [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]]
    assert m.in_ring(5, 5, sq) and not m.in_ring(15, 5, sq)


def test_recent():
    m.HITS.clear()
    a = c.post("/api/reports", json={"address_hint": "Blk 1 Somewhere", "category": "other"}).json()["id"]
    rec = c.get("/api/reports/recent").json()
    assert rec[0]["id"] == a and rec[0]["town"] is None  # reports outside any region still show up
    assert c.get("/api/reports/recent", params={"after": a}).json() == []
