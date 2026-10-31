"""Street-image audit of the busiest paths: Google Street View photos checked by Claude.

Run after build.py:  .venv/Scripts/python pipeline/vision.py [--per-town 30] [--towns ang-mo-kio ...] [--dry-run]
Needs GOOGLE_MAPS_API_KEY and ANTHROPIC_API_KEY in .env. Results are cached in pipeline/cache/vision/<town>.json
(resumable; each image is paid for once), then rerun `REBUILD=1 build.py` to fold them into the barriers.
Photos are never republished: the site links to the panorama on Google Maps instead.
"""
import argparse
import base64
import json
import math
import os
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Literal

import anthropic
import requests
from pydantic import BaseModel

ROOT = Path(__file__).resolve().parent
DATA = ROOT.parent / "web" / "public" / "data"
CACHE = ROOT / "cache" / "vision"
IMGS = ROOT / "cache" / "streetview"  # private cache, not served
CACHE.mkdir(parents=True, exist_ok=True)
IMGS.mkdir(parents=True, exist_ok=True)
MODEL = "claude-opus-5-5"

for line in (ROOT.parent / ".env").read_text().splitlines():
    k, _, v = line.partition("=")
    if k.strip() and not k.startswith("#") and v.strip():
        os.environ.setdefault(k.strip(), v.strip())

Val = Literal["yes", "no", "unknown"]


class Item(BaseModel):
    value: Val
    confidence: float  # 0 to 1


class Checklist(BaseModel):
    shelter: Item       # roof or covered linkway over the walking path
    bench: Item         # a seat on or right beside the path
    steps: Item         # steps on the path itself
    ramp: Item          # ramp or kerb cut letting a wheelchair or walker avoid steps or kerbs
    surface_ok: Item    # even, intact surface with no broken slabs or large cracks
    obstruction: Item   # something blocking part of the path (poles, parked bikes, goods, works)
    signage: Item       # wayfinding or crossing signs visible
    tactile_paving: Item  # raised tactile (studded or ribbed) paving at kerbs, crossings or stairs
    ped_signal: Item    # a pedestrian traffic light, with push-button box if visible
    notes: str          # one short sentence on anything a senior would struggle with


PROMPT = """These two photos look both ways along one footpath in a Singapore HDB estate, from Google Street View.
Fill the checklist for THIS footpath only, as a planner checking whether a 75-year-old using a walking frame,
or one with low vision, could use it safely.
Use "unknown" whenever the photos don't clearly show it (path out of view, too far away, blocked, blurry, or ambiguous).
Confidence is how sure you are of the value, from 0 to 1. Keep notes to one plain sentence."""


def bearing(a, b):
    y = math.sin(math.radians(b[0] - a[0])) * math.cos(math.radians(b[1]))
    x = math.cos(math.radians(a[1])) * math.sin(math.radians(b[1])) - \
        math.sin(math.radians(a[1])) * math.cos(math.radians(b[1])) * math.cos(math.radians(b[0] - a[0]))
    return (math.degrees(math.atan2(y, x)) + 360) % 360


def street_view(seg, key):
    c = seg["geometry"]["coordinates"]
    i = max(1, len(c) // 2)
    mid = [(c[i - 1][0] + c[i][0]) / 2, (c[i - 1][1] + c[i][1]) / 2]
    head = bearing(c[i - 1], c[i])
    meta = requests.get("https://maps.googleapis.com/maps/api/streetview/metadata", timeout=20, params={
        "location": f"{mid[1]},{mid[0]}", "radius": 30, "source": "outdoor", "key": key}).json()
    if meta.get("status") != "OK":
        return None, {"status": "no_imagery"}
    imgs = []
    for h in (round(head), round(head + 180) % 360):
        f = IMGS / f"{meta['pano_id']}_{h}.jpg"
        if not f.exists():
            r = requests.get("https://maps.googleapis.com/maps/api/streetview", timeout=30, params={
                "size": "640x480", "pano": meta["pano_id"], "heading": h, "pitch": -10, "fov": 90, "key": key})
            r.raise_for_status()
            f.write_bytes(r.content)
        imgs.append(base64.standard_b64encode(f.read_bytes()).decode())
    return imgs, {"pano": meta["pano_id"], "date": meta.get("date"), "heading": round(head),
                  "lat": meta["location"]["lat"], "lng": meta["location"]["lng"]}


def check(client, imgs):
    content = [{"type": "image", "source": {"type": "base64", "media_type": "image/jpeg", "data": d}} for d in imgs]
    content.append({"type": "text", "text": PROMPT})
    resp = client.beta.messages.parse(
        model=MODEL, max_tokens=4000, output_config={"effort": "low"},
        betas=["server-side-fallback-2026-07-01"], fallbacks="default",
        messages=[{"role": "user", "content": content}], output_format=Checklist)
    if resp.stop_reason == "refusal" or resp.parsed_output is None:
        return {"status": "refused"}, resp.usage
    out = resp.parsed_output.model_dump()
    for k, v in out.items():
        if isinstance(v, dict):
            v["confidence"] = round(min(1.0, max(0.0, v["confidence"])), 2)
    return {"status": "ok", "checklist": out, "model": MODEL}, resp.usage


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--per-town", type=int, default=30)
    ap.add_argument("--towns", nargs="*")
    ap.add_argument("--dry-run", action="store_true", help="only count Street View coverage (free metadata calls)")
    a = ap.parse_args()
    gkey = os.environ.get("GOOGLE_MAPS_API_KEY")
    if not gkey:
        raise SystemExit("GOOGLE_MAPS_API_KEY missing from .env")
    client = None if a.dry_run else anthropic.Anthropic()
    towns = a.towns or [t["slug"] for t in json.loads((DATA / "index.json").read_text())["towns"]]
    tok_in = tok_out = 0
    for slug in towns:
        cache_p = CACHE / f"{slug}.json"
        done = json.loads(cache_p.read_text()) if cache_p.exists() else {}
        segs = json.loads((DATA / "towns" / slug / "segments.json").read_text())["features"]
        segs = sorted(segs, key=lambda f: -f["properties"]["foot"])[: a.per_town]
        todo = [s for s in segs if s["properties"]["id"] not in done]

        def run(seg):
            imgs, meta = street_view(seg, gkey)
            if imgs is None or a.dry_run:
                return seg["properties"]["id"], meta, None
            for attempt in range(4):
                try:
                    res, usage = check(client, imgs)
                    return seg["properties"]["id"], {**meta, **res}, usage
                except (anthropic.RateLimitError, anthropic.APIConnectionError, anthropic.InternalServerError):
                    time.sleep(10 * (attempt + 1))
            return seg["properties"]["id"], {**meta, "status": "error"}, None

        with ThreadPoolExecutor(6) as ex:
            for sid, res, usage in ex.map(run, todo):
                if a.dry_run:
                    done.setdefault("_dry", {})[sid] = res.get("status", "ok")
                    continue
                done[sid] = res
                if usage:
                    tok_in += usage.input_tokens
                    tok_out += usage.output_tokens
        if not a.dry_run:
            cache_p.write_text(json.dumps(done))
            public = {k: {x: v[x] for x in ("status", "pano", "date", "heading", "lat", "lng", "checklist", "model") if x in v}
                      for k, v in done.items()}
            (DATA / "towns" / slug / "vision.json").write_text(json.dumps(public, separators=(",", ":")))
        ok = sum(1 for k, v in done.items() if k != "_dry" and v.get("status") == "ok")
        cover = sum(1 for v in done.get("_dry", {}).values() if v == "ok") if a.dry_run else None
        print(f"{slug}: {ok} checked" + (f", {cover}/{len(segs)} have Street View" if a.dry_run else ""), flush=True)
    if tok_in:
        # Claude Opus 5.5 list price: $4 / MTok in, $20 / MTok out
        print(f"tokens in {tok_in}, out {tok_out}, about ${tok_in * 4e-6 + tok_out * 20e-6:.2f}")


if __name__ == "__main__":
    main()
