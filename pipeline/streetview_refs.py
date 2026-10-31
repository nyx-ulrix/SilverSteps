"""Attach a Google Street View reference (nearest outdoor panorama, its date and a heading along the path)
to every gap. Uses only the Street View metadata endpoint, which Google doesn't bill. No images are fetched.

Run after build.py:  .venv/Scripts/python pipeline/streetview_refs.py
Cached in pipeline/cache/svrefs/<town>.json; build.py folds them into gaps.json on later builds.
"""
import json
import os
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import requests

from vision import bearing  # also loads .env

ROOT = Path(__file__).resolve().parent
DATA = ROOT.parent / "web" / "public" / "data"
CACHE = ROOT / "cache" / "svrefs"
CACHE.mkdir(parents=True, exist_ok=True)
KEY = os.environ.get("GOOGLE_MAPS_API_KEY") or exit("GOOGLE_MAPS_API_KEY missing from .env")


def ref(gap, seg):
    c = seg["geometry"]["coordinates"]
    i = max(1, len(c) // 2)
    lng, lat = gap["at"]
    m = requests.get("https://maps.googleapis.com/maps/api/streetview/metadata", timeout=20, params={
        "location": f"{lat},{lng}", "radius": 50, "source": "outdoor", "key": KEY}).json()
    if m.get("status") == "REQUEST_DENIED":
        raise SystemExit(f"Google refused the key: {m.get('error_message')}")
    if m.get("status") != "OK":
        return None
    # Point the camera from the panorama towards the gap.
    return {"pano": m["pano_id"], "date": m.get("date"),
            "heading": round(bearing([m["location"]["lng"], m["location"]["lat"]], [lng, lat])
                             if (m["location"]["lng"], m["location"]["lat"]) != (lng, lat) else bearing(c[i - 1], c[i]))}


def attach(gaps, refs):
    for g in gaps:
        g["sv"] = refs.get(g["id"])


def main():
    towns = [t["slug"] for t in json.loads((DATA / "index.json").read_text())["towns"]]
    all_refs = {}
    for slug in towns:
        cache_p = CACHE / f"{slug}.json"
        refs = json.loads(cache_p.read_text()) if cache_p.exists() else {}
        gaps_p = DATA / "towns" / slug / "gaps.json"
        gaps = json.loads(gaps_p.read_text())
        segs = {f["properties"]["id"]: f for f in json.loads((DATA / "towns" / slug / "segments.json").read_text())["features"]}
        todo = [g for g in gaps if g["id"] not in refs]
        with ThreadPoolExecutor(8) as ex:
            for g, r in zip(todo, ex.map(lambda g: ref(g, segs[g["segs"][0]]), todo)):
                refs[g["id"]] = r
        cache_p.write_text(json.dumps(refs))
        attach(gaps, refs)
        gaps_p.write_text(json.dumps(gaps, separators=(",", ":")))
        all_refs.update({(slug, k): v for k, v in refs.items()})
        print(f"{slug}: {sum(1 for g in gaps if g['sv'])}/{len(gaps)} gaps have Street View", flush=True)
    top_p = DATA / "top-gaps.json"
    top = json.loads(top_p.read_text())
    for g in top:
        g["sv"] = all_refs.get((g["town"], g["id"]))
    top_p.write_text(json.dumps(top, separators=(",", ":")))


if __name__ == "__main__":
    main()
