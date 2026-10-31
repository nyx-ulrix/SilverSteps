"""Ageing Well in Place: senior footfall + accessibility gaps for every HDB town in Singapore.

Run:  .venv/Scripts/python pipeline/build.py [slug ...]
Writes web/public/data/. Downloads are cached in pipeline/cache/, so reruns are fast and resumable.

Everything here is a MODEL. Senior counts per block are estimates spread from SingStat subzone
totals; trips are simulated with a gravity model. No individual movement data is used.
"""
import html
import json
import math
import os
import pickle
import re
import sys
import time
from collections import defaultdict
from concurrent.futures import ProcessPoolExecutor, as_completed
from pathlib import Path

import geopandas as gpd
import networkx as nx
import osmnx as ox
import pandas as pd
import requests
from shapely.geometry import Point, mapping, shape
from shapely.ops import unary_union

ROOT = Path(__file__).resolve().parent
CACHE = ROOT / "cache"
OUT = ROOT.parent / "web" / "public" / "data"
for p in (CACHE / "towns", OUT / "towns"):
    p.mkdir(parents=True, exist_ok=True)

FIRST_TOWN = "ANG MO KIO"
WORKERS = 3          # parallel towns; Overpass only gives a couple of slots per IP
SENIOR_AGE = 65
CUTOFF_M = 800       # max senior-weighted walking cost per trip
DECAY_M = 300        # distance decay: weight = exp(-cost / DECAY_M)
BENCH_GAP_M = 100    # no seat within 100 m of a segment midpoint = in a >200 m rest gap

# Trips per senior per week, by destination type. Assumptions, shown in the app.
DEST_TYPES = {
    "hawker": ("Hawker centre or market", 5.0),
    "kopitiam": ("Kopitiam or food court", 3.0),
    "bus": ("Bus stop", 4.0),
    "fitness": ("Fitness corner", 1.0),
    "park": ("Park", 2.0),
    "supermarket": ("Supermarket", 2.0),
    "mrt": ("MRT station", 1.5),
    "eldercare": ("Eldercare or Active Ageing Centre", 1.5),
    "community": ("Community club", 1.0),
    "clinic": ("CHAS clinic", 0.5),
    "polyclinic": ("Polyclinic", 0.25),
}

# Senior walking cost on top of segment length.
STEPS_FACTOR = 4.0
SHELTER_FACTOR = 0.8
ROAD_FACTOR = 1.25           # walking along a road with no separate footpath
UNSIGNALISED_CROSSING_M = 40
SIGNALISED_CROSSING_M = 20
ROADS = {"residential", "service", "tertiary", "secondary", "primary", "unclassified", "living_street"}

# Barrier: (label, severity 1-3, fix, effort)
BARRIERS = {
    "steps": ("Steps with no ramp recorded", 3, "Ramp or lift", "high"),
    "crossing": ("Crossing without signals", 2, "Signalised or zebra crossing", "medium"),
    "kerb": ("Raised kerb", 2, "Kerb ramp", "low"),
    "no_shelter": ("No shelter", 1, "Covered linkway", "high"),
    "rest_gap": ("No seat for over 200 m", 1, "Bench", "low"),
    "surface": ("Rough surface", 1, "Resurface path", "medium"),
    "dark": ("Unlit at night", 1, "Path lighting", "medium"),
    "slope": ("Slope", 1, "Handrail or regrade", "medium"),
    "obstruction": ("Path partly blocked", 2, "Clear or move obstruction", "low"),
    "no_tactile": ("Crossing without tactile paving", 2, "Tactile paving", "low"),
    "silent_signal": ("Traffic light without audio signal", 2, "Audible crossing signal", "medium"),
}
# Who each barrier affects most: "mobility" (walking frame, wheelchair, frailty) and/or "sight" (low vision, blind).
PROFILES = {"steps": ["mobility", "sight"], "crossing": ["mobility", "sight"], "kerb": ["mobility"],
            "no_shelter": ["mobility"], "rest_gap": ["mobility"], "surface": ["mobility", "sight"],
            "dark": ["sight"], "slope": ["mobility"], "obstruction": ["mobility", "sight"],
            "no_tactile": ["sight"], "silent_signal": ["sight"]}
VISION_MIN_CONF = 0.6  # street-image findings below this stay "needs a field check"
# Attributes OSM usually does not record: shown as "needs field check", never as barriers.
UNKNOWN = {"shelter": "Shelter not recorded", "lit": "Lighting not recorded",
           "tactile": "Tactile paving not recorded at this crossing",
           "sound": "Audio signal not recorded at this traffic light"}

S = requests.Session()
S.headers["User-Agent"] = "SilverSteps hackathon (github.com/nyx-ulrix/SilverSteps)"


def slugify(name):
    return re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")


def cached_json(name, fetch):
    p = CACHE / name
    if p.exists():
        return json.loads(p.read_text(encoding="utf8"))
    data = fetch()
    p.write_text(json.dumps(data), encoding="utf8")
    return data


def datagov_geojson(dataset_id):
    def fetch():
        for attempt in range(6):  # data.gov.sg answers {"data": null} when rate limited
            data = S.get(f"https://api-open.data.gov.sg/v1/public/api/datasets/{dataset_id}/poll-download").json().get("data")
            if data and data.get("url"):
                return S.get(data["url"]).json()
            time.sleep(10 * (attempt + 1))
        raise RuntimeError(f"data.gov.sg download failed for {dataset_id}")
    return cached_json(f"{dataset_id}.geojson", fetch)


def datagov_rows(resource_id):
    def fetch():
        rows, offset = [], 0
        while True:
            r = S.get("https://data.gov.sg/api/action/datastore_search",
                      params={"resource_id": resource_id, "limit": 5000, "offset": offset}).json()["result"]
            rows += r["records"]
            offset += 5000
            if offset >= r["total"]:
                return rows
    return cached_json(f"{resource_id}.json", fetch)


def desc_fields(props):
    """data.gov.sg GeoJSON keeps attributes in an HTML table in Description."""
    if "Description" not in props:
        return props
    cells = re.findall(r"<th>(.*?)</th>\s*<td>(.*?)</td>", props["Description"], re.S)
    return {k.strip(): html.unescape(v.strip()) for k, v in cells}


def num(v):
    try:
        return float(str(v).replace(",", ""))
    except ValueError:
        return 0.0


def r6(c):
    return [round(c[0], 6), round(c[1], 6)]


def to_m(geom):
    return gpd.GeoSeries([geom], crs=4326).to_crs(3414).iloc[0]


def to_ll(geom):
    return gpd.GeoSeries([geom], crs=3414).to_crs(4326).iloc[0]


# ======================================================================== national prep
RATE_LIMITED = "rate_limited"


def onemap(q, blk):
    """Returns [lng, lat], None (not found) or RATE_LIMITED (OneMap said 429; skip, retry on a later run)."""
    try:
        r = S.get("https://www.onemap.gov.sg/api/common/elastic/search",
                  params={"searchVal": q, "returnGeom": "Y", "getAddrDetails": "Y", "pageNum": 1}, timeout=20)
        if r.status_code == 429:
            return RATE_LIMITED
        hit = next((x for x in r.json().get("results", []) if x["BLK_NO"] == blk), None)
        return [float(hit["LONGITUDE"]), float(hit["LATITUDE"])] if hit else None
    except (ValueError, requests.RequestException):
        return RATE_LIMITED


def locate_blocks(hdb):
    """HDB property rows have no coordinates. Match each street to a footprint street code by the overlap
    of their block-number sets, take the footprint centroid; geocode only what doesn't match."""
    fp = datagov_geojson("d_16b157c52ed637edd6ba1232e026258d")
    polys = defaultdict(list)
    code_blks = defaultdict(set)
    for f in fp["features"]:
        p = f["properties"]
        polys[(p["ST_COD"], p["BLK_NO"])].append(shape(f["geometry"]))
        code_blks[p["ST_COD"]].add(p["BLK_NO"])
    inv = defaultdict(set)
    for c, bs in code_blks.items():
        for b in bs:
            inv[b].add(c)
    street_blks = defaultdict(set)
    for r in hdb:
        street_blks[r["street"]].add(r["blk_no"])
    match, taken = {}, set()
    # Most distinctive streets first so shared codes go to the better match.
    for s, bs in sorted(street_blks.items(), key=lambda kv: -len(kv[1])):
        cand = defaultdict(int)
        for b in bs:
            for c in inv[b]:
                cand[c] += 1
        best = sorted(((n / len(bs | code_blks[c]), c) for c, n in cand.items() if c not in taken), reverse=True)[:2]
        if best and best[0][0] >= 0.5 and (len(best) < 2 or best[0][0] - best[1][0] >= 0.2):
            match[s] = best[0][1]
            taken.add(best[0][1])

    gc_p = CACHE / "onemap.json"
    gc = json.loads(gc_p.read_text()) if gc_p.exists() else {}
    out, n_fp, n_gc = {}, 0, 0
    limited = False  # once OneMap rate-limits us, stop asking this run
    for r in hdb:
        key = (r["street"], r["blk_no"])
        ps = polys.get((match.get(r["street"]), r["blk_no"]))
        if ps:
            c = unary_union(ps).centroid
            out[key] = [c.x, c.y]
            n_fp += 1
            continue
        q = f"{r['blk_no']} {r['street']}"
        if q not in gc and not limited:
            res = onemap(q, r["blk_no"])
            limited = res == RATE_LIMITED
            if not limited:
                gc[q] = res
                gc_p.write_text(json.dumps(gc))
            time.sleep(0.3)
        if gc.get(q):
            out[key] = gc[q]
            n_gc += 1
    print(f"  blocks located: {n_fp} by footprint, {n_gc} by OneMap, {len(hdb) - n_fp - n_gc} not found")
    return out


def prep():
    p = CACHE / "national.pkl"
    if p.exists():
        return pickle.loads(p.read_bytes())
    print("National prep")
    subzones = []
    for f in datagov_geojson("d_8594ae9ff96d0c708bc2af633048edfb")["features"]:
        q = desc_fields(f["properties"])
        subzones.append({"name": q["SUBZONE_N"], "town": q["PLN_AREA_N"], "geom": shape(f["geometry"])})

    pop = pd.read_csv(ROOT / "raw" / "respopagesex2025.csv")
    pop["age_n"] = pd.to_numeric(pop.Age.astype(str).str.extract(r"(\d+)")[0], errors="coerce")
    sz_key = pop.SZ.str.upper()
    seniors_sz = pop[pop.age_n >= SENIOR_AGE].groupby(sz_key).Pop.sum().to_dict()
    total_sz = pop.groupby(sz_key).Pop.sum().to_dict()

    # Share of residents living in HDB flats per subzone (Census 2020), so private estates
    # don't get their seniors piled onto the few HDB blocks nearby.
    hdb_share = {}
    for r in datagov_rows("d_7f243956483d5901f237e6f87b096636"):
        if " - Total" in r["Number"] or r["Number"] == "Total":
            continue
        t = num(r["Total"])
        hdb_share[r["Number"].upper()] = num(r["HDBDwellings_Total"]) / t if t else 0.0

    hdb = [r for r in datagov_rows("d_17f5382f26140b1fdae0ba2ef6239d2f")
           if r["residential"] == "Y" and int(r["total_dwelling_units"]) > 0]
    locs = locate_blocks(hdb)
    sz_gdf = gpd.GeoDataFrame([{"name": s["name"]} for s in subzones], geometry=[s["geom"] for s in subzones], crs=4326)
    blocks = [{"blk": r["blk_no"], "street": r["street"].title(), "units": int(r["total_dwelling_units"]),
               "year": int(r["year_completed"]), "ll": locs[(r["street"], r["blk_no"])]}
              for r in hdb if (r["street"], r["blk_no"]) in locs]
    pts = gpd.GeoDataFrame(geometry=[Point(b["ll"]) for b in blocks], crs=4326)
    joined = gpd.sjoin(pts, sz_gdf, how="left", predicate="within")
    joined = joined[~joined.index.duplicated()]
    for b, z in zip(blocks, joined["name"]):
        b["subzone"] = z if isinstance(z, str) else None
    blocks = [b for b in blocks if b["subzone"]]
    units_sz = defaultdict(int)
    for b in blocks:
        units_sz[b["subzone"]] += b["units"]
    for b in blocks:
        # ponytail: spreads subzone seniors over HDB blocks by dwelling units; ignores blocks that skew old
        hdb_seniors = seniors_sz.get(b["subzone"], 0) * hdb_share.get(b["subzone"], 1.0)
        b["seniors"] = round(hdb_seniors * b["units"] / units_sz[b["subzone"]], 1)

    dests = []
    for f in datagov_geojson("d_4a086da0a5553be1d89383cd90d07ecd")["features"]:
        dests.append({"type": "hawker", "name": desc_fields(f["properties"]).get("NAME", "Hawker centre").title(),
                      "ll": f["geometry"]["coordinates"][:2]})
    for f in datagov_geojson("d_548c33ea2d99e29ec63a7cc9edcccedc")["features"]:
        dests.append({"type": "clinic", "name": desc_fields(f["properties"]).get("HCI_NAME", "CHAS clinic").title(),
                      "ll": f["geometry"]["coordinates"][:2]})
    for f in datagov_geojson("d_f0fd1b3643ed8bd34bd403dedd7c1533")["features"]:
        dests.append({"type": "eldercare", "name": desc_fields(f["properties"]).get("NAME", "Eldercare centre").title(),
                      "ll": f["geometry"]["coordinates"][:2]})

    nat = {"subzones": subzones, "seniors_sz": seniors_sz, "total_sz": total_sz, "blocks": blocks, "dests": dests}
    p.write_bytes(pickle.dumps(nat))
    print(f"  {len(blocks)} blocks, {len(dests)} national destinations")
    return nat


# ======================================================================== one town
def first(v):
    return v[0] if isinstance(v, list) else v


def build_town(town, nat):
    slug = slugify(town)
    t0 = time.time()
    zs = [s for s in nat["subzones"] if s["town"] == town]
    area = unary_union([s["geom"] for s in zs])
    area_m = to_m(area)
    origin_buf = to_ll(area_m.buffer(CUTOFF_M))        # anyone who can reach a path inside the town
    route_buf = to_ll(area_m.buffer(CUTOFF_M * 2))     # everywhere those trips can go

    blocks = [b for b in nat["blocks"] if origin_buf.contains(Point(b["ll"]))]
    if not any(area.contains(Point(b["ll"])) for b in blocks):
        return None

    ox.settings.useful_tags_way += OSM_TAGS_WAY
    ox.settings.useful_tags_node += OSM_TAGS_NODE
    ox.settings.log_console = False
    gml = CACHE / "towns" / f"{slug}.g{GRAPH_VERSION}.graphml"
    if gml.exists():
        G = ox.load_graphml(gml)
    else:
        G = ox.graph_from_polygon(route_buf, network_type="walk", simplify=True, retain_all=False)
        ox.save_graphml(G, gml)
    G = ox.convert.to_undirected(G)

    for u, v, k, d in G.edges(keys=True, data=True):
        hw = first(d.get("highway"))
        covered = first(d.get("covered")) == "yes" or first(d.get("tunnel")) in ("yes", "building_passage")
        ends = [G.nodes[n] for n in (u, v)]

        def tag(k):  # way tag, else either end node's
            return first(d.get(k)) or next((e.get(k) for e in ends if e.get(k)), None)
        crossing = tag("crossing")
        is_crossing = first(d.get("footway")) == "crossing"
        signals = crossing == "traffic_signals" or tag("crossing:signals") == "yes"
        barriers, unknown = [], []
        if hw == "steps":
            barriers.append("steps")
        if is_crossing and not signals and crossing not in ("zebra", "marked"):
            barriers.append("crossing")
        if is_crossing:  # checks for people with low vision or blindness
            tactile = tag("tactile_paving")
            if tactile == "no":
                barriers.append("no_tactile")
            elif tactile is None:
                unknown.append("tactile")
            if signals:
                sound = tag("traffic_signals:sound")
                if sound == "no" and tag("traffic_signals:vibration") != "yes":
                    barriers.append("silent_signal")
                elif sound is None:
                    unknown.append("sound")
        d["xing"] = ("signals" if signals else "zebra" if crossing in ("zebra", "marked") else "uncontrolled") \
            if is_crossing else None
        if any(G.nodes[n].get("kerb") == "raised" for n in (u, v)):
            barriers.append("kerb")
        if first(d.get("surface")) in ("unpaved", "gravel", "dirt", "grass", "ground", "sand", "cobblestone", "sett"):
            barriers.append("surface")
        lit = first(d.get("lit"))
        if lit == "no":
            barriers.append("dark")
        elif lit is None:
            unknown.append("lit")
        if first(d.get("incline")) not in (None, "no", "0", "0%"):
            barriers.append("slope")
        if first(d.get("covered")) == "no":
            barriers.append("no_shelter")
        elif not covered:
            unknown.append("shelter")
        cost = d["length"] * (STEPS_FACTOR if hw == "steps" else 1) * (SHELTER_FACTOR if covered else 1) \
            * (ROAD_FACTOR if hw in ROADS else 1)
        cost += UNSIGNALISED_CROSSING_M if "crossing" in barriers else SIGNALISED_CROSSING_M if is_crossing else 0
        d.update(cost=cost, hw=hw, covered=covered, barriers=barriers, unknown=unknown, foot=0.0)

    best = {}
    for u, v, k, d in G.edges(keys=True, data=True):
        key = (u, v) if u < v else (v, u)
        if key not in best or d["cost"] < G.edges[best[key]]["cost"]:
            best[key] = (u, v, k)
    R = nx.Graph()
    for (a, b), ek in best.items():
        R.add_edge(a, b, cost=G.edges[ek]["cost"], ek=ek)

    # Destinations: national lists + OpenStreetMap for the rest.
    dests = [dict(d) for d in nat["dests"] if route_buf.contains(Point(d["ll"]))]
    feats = gpd.read_file(CACHE / "towns" / f"{slug}.features2.geojson")  # cut by cache_from_extract
    benches = []
    for _, f in feats.iterrows():
        c = f.geometry if f.geometry.geom_type == "Point" else f.geometry.representative_point()
        name = f.get("name") if isinstance(f.get("name"), str) else None
        kind = None
        food = " ".join(str(f.get(k) or "") for k in ("name", "cuisine")).lower()
        if f.get("amenity") == "bench":
            benches.append(c)
        elif f.get("amenity") == "food_court" or (f.get("amenity") in ("cafe", "restaurant")
                                                  and any(w in food for w in KOPITIAM_WORDS)):
            kind, name = "kopitiam", name or "Kopitiam"
        elif f.get("leisure") == "fitness_station":
            kind, name = "fitness", name or "Fitness corner"
        elif f.get("highway") == "bus_stop":
            kind, name = "bus", name or "Bus stop"
        elif f.get("railway") == "subway_entrance":
            kind, name = "mrt", name or "MRT exit"
        elif f.get("shop") == "supermarket":
            kind, name = "supermarket", name or "Supermarket"
        elif f.get("leisure") == "park" and f.geometry.area > 2e-7:  # skip tiny pocket greens
            kind, name = "park", name or "Park"
        elif f.get("amenity") == "community_centre":
            kind, name = "community", name or "Community club"
        elif f.get("amenity") == "clinic" and name and "polyclinic" in name.lower():
            kind = "polyclinic"
        elif f.get("amenity") == "marketplace":
            kind, name = "hawker", name or "Market"
        if kind:
            dests.append({"type": kind, "name": name, "ll": [c.x, c.y]})
    benches += [Point(d["ll"]) for d in dests if d["type"] == "bus"]  # most SG bus stops have seats

    near = ox.distance.nearest_nodes(G, [x["ll"][0] for x in blocks + dests], [x["ll"][1] for x in blocks + dests])
    for x, n in zip(blocks + dests, near):
        x["node"] = n
    dest_by_node = defaultdict(list)
    for d in dests:
        dest_by_node[d["node"]].append(d)

    # Gravity model: each senior picks one destination of each type, nearer ones more often.
    total_trips = 0.0
    routes = []
    for b in blocks:
        if b["node"] not in R or not b["seniors"]:
            continue
        dist, paths = nx.single_source_dijkstra(R, b["node"], cutoff=CUTOFF_M, weight="cost")
        by_type = defaultdict(list)
        for n, c in dist.items():
            for d in dest_by_node.get(n, []):
                by_type[d["type"]].append((n, math.exp(-c / DECAY_M), d))
        inside = area.contains(Point(b["ll"]))
        for t, opts in by_type.items():
            trips = b["seniors"] * DEST_TYPES[t][1] * 2  # weekly, there and back
            wsum = sum(w for _, w, _ in opts)
            for n, w, d in opts:
                share = trips * w / wsum
                p = paths[n]
                for a, c in zip(p, p[1:]):
                    G.edges[R.edges[a, c]["ek"]]["foot"] += share
                if inside:
                    total_trips += share
                    routes.append({"b": b, "t": t, "d": d, "p": p, "trips": share, "share": w / wsum})

    # Audit the segments inside the town.
    bench_m = gpd.GeoSeries(benches, crs=4326).to_crs(3414)
    segs = []
    for u, v, k, d in G.edges(keys=True, data=True):
        if d["foot"] < 1:
            continue
        geom = d.get("geometry")
        coords = list(geom.coords) if geom is not None else \
            [(G.nodes[u]["x"], G.nodes[u]["y"]), (G.nodes[v]["x"], G.nodes[v]["y"])]
        mid = Point(coords[len(coords) // 2])
        if not area.contains(mid):
            continue
        segs.append({"id": f"{u}-{v}-{k}", "u": u, "v": v, "way": str(first(d.get("osmid"))),
                     "name": first(d.get("name")) if isinstance(first(d.get("name")), str) else None,
                     "hw": d["hw"], "xing": d["xing"], "len": round(d["length"]), "foot": round(d["foot"]),
                     "barriers": list(d["barriers"]), "unknown": d["unknown"], "covered": d["covered"],
                     "coords": [r6(c) for c in coords], "_mid": mid})
    if not segs:
        return None
    if len(bench_m):
        mids = gpd.GeoSeries([s["_mid"] for s in segs], crs=4326).to_crs(3414)
        _, dists = bench_m.sindex.nearest(mids, return_distance=True, return_all=False)
    else:
        dists = [1e9] * len(segs)
    for s, dist in zip(segs, dists):
        if dist > BENCH_GAP_M:
            s["barriers"].append("rest_gap")

    # Fold in confident street-image findings (pipeline/vision.py) on the busiest paths.
    vis_p = CACHE / "vision" / f"{slug}.json"
    vis = json.loads(vis_p.read_text()) if vis_p.exists() else {}
    for s in segs:
        v = vis.get(s["id"], {})
        s["vsrc"] = []
        if v.get("status") != "ok":
            continue
        c = v["checklist"]

        def sure(k, val):  # older cached checklists lack the sight-loss items
            return k in c and c[k]["value"] == val and c[k]["confidence"] >= VISION_MIN_CONF

        def add(bt):
            if bt not in s["barriers"]:
                s["barriers"].append(bt)
            s["vsrc"].append(bt)
        if sure("shelter", "yes"):
            s["covered"] = True
            s["unknown"] = [u for u in s["unknown"] if u != "shelter"]
            s["barriers"] = [b for b in s["barriers"] if b != "no_shelter"]
        elif sure("shelter", "no"):
            s["unknown"] = [u for u in s["unknown"] if u != "shelter"]
            add("no_shelter")
        if sure("bench", "yes"):
            s["barriers"] = [b for b in s["barriers"] if b != "rest_gap"]
        if sure("steps", "yes") and not sure("ramp", "yes"):
            add("steps")
        if sure("surface_ok", "no"):
            add("surface")
        if sure("obstruction", "yes"):
            add("obstruction")
        if s["xing"] and sure("tactile_paving", "no"):
            s["unknown"] = [u for u in s["unknown"] if u != "tactile"]
            add("no_tactile")
    feet = sorted(s["foot"] for s in segs)
    p50, p75 = feet[len(feet) // 2], feet[len(feet) * 3 // 4]

    # A gap = one connected stretch of path with the same barrier, ranked by demand x severity.
    flagged = defaultdict(list)
    for s in segs:
        for bt in s["barriers"]:
            # Comfort gaps only on the busiest quarter: OSM records few benches or shelters in SG,
            # so flagging them everywhere would mostly measure missing map data.
            if bt in ("no_shelter", "rest_gap") and s["foot"] < p75:
                continue
            flagged[bt].append(s)
    gaps = defaultdict(lambda: {"segs": [], "foot": 0, "len": 0, "name": None})
    for bt, ss in flagged.items():
        parent = {}

        def root(n):
            while parent.setdefault(n, n) != n:
                parent[n] = parent[parent[n]]
                n = parent[n]
            return n
        for s in ss:
            parent[root(s["u"])] = root(s["v"])
        for s in ss:
            g = gaps[(str(root(s["u"])), bt)]
            g["segs"].append(s["id"])
            if s["foot"] >= g["foot"]:
                g["foot"], g["at"] = s["foot"], s["coords"][len(s["coords"]) // 2]
            g["len"] += s["len"]
            g["name"] = g["name"] or s["name"]
            g["seen"] = g.get("seen") or bt in s["vsrc"]
    # Most footpaths are unnamed in OSM: describe each gap by its nearest HDB block instead.
    blk_m = gpd.GeoSeries([Point(b["ll"]) for b in blocks], crs=4326).to_crs(3414)
    gap_items = list(gaps.items())
    at_m = gpd.GeoSeries([Point(g["at"]) for _, g in gap_items], crs=4326).to_crs(3414)
    (_, blk_i), blk_d = blk_m.sindex.nearest(at_m, return_distance=True, return_all=False)
    gap_list = []
    for ((way, bt), g), bi, bd in zip(gap_items, blk_i, blk_d):
        label, sev, fix, effort = BARRIERS[bt]
        near = f"Blk {blocks[bi]['blk']} {blocks[bi]['street']}" if bd < 300 else None
        gap_list.append({"id": f"{way}:{bt}", "barrier": bt, "label": label, "severity": sev, "fix": fix,
                         "effort": effort, "foot": g["foot"], "len": g["len"], "name": g["name"], "near": near,
                         "segs": g["segs"], "at": g["at"], "town": slug,
                         "source": "Street View photo checked by Claude" if g.get("seen")
                         else "OpenStreetMap benches and bus stops (often incomplete)" if bt == "rest_gap"
                         else "OpenStreetMap tags"})
    gap_list.sort(key=lambda g: g["foot"] * g["severity"], reverse=True)
    sv_p = CACHE / "svrefs" / f"{slug}.json"  # Street View references from streetview_refs.py
    if sv_p.exists():
        sv = json.loads(sv_p.read_text())
        for g in gap_list:
            g["sv"] = sv.get(g["id"])

    def fc(features):
        return {"type": "FeatureCollection", "features": features}

    def pt(ll, props):
        return {"type": "Feature", "properties": props, "geometry": {"type": "Point", "coordinates": r6(ll)}}

    out = OUT / "towns" / slug
    out.mkdir(exist_ok=True)
    dump = lambda name, obj: (out / name).write_text(json.dumps(obj, separators=(",", ":")))
    dump("segments.json", fc([{"type": "Feature", "id": i,
                               "properties": {**{k: v for k, v in s.items() if k not in ("coords", "_mid", "u", "v", "vsrc")},
                                              "vision": s["id"] in vis},
                               "geometry": {"type": "LineString", "coordinates": s["coords"]}}
                              for i, s in enumerate(segs)]))
    dump("gaps.json", gap_list)
    # Routes: each block's likeliest walk to each kind of place, most-used first.
    def path_coords(p):
        out = []
        for a, c in zip(p, p[1:]):
            d = G.edges[R.edges[a, c]["ek"]]
            pts = list(d["geometry"].coords) if d.get("geometry") is not None else \
                [(G.nodes[a]["x"], G.nodes[a]["y"]), (G.nodes[c]["x"], G.nodes[c]["y"])]
            if math.dist(pts[0], (G.nodes[a]["x"], G.nodes[a]["y"])) > math.dist(pts[-1], (G.nodes[a]["x"], G.nodes[a]["y"])):
                pts.reverse()
            out += pts[1:] if out else pts
        return [[round(x, 5), round(y, 5)] for x, y in out]

    by_bt = defaultdict(list)
    for r in routes:
        by_bt[(id(r["b"]), r["t"])].append(r)
    kept = []
    for rs in by_bt.values():
        rs.sort(key=lambda r: -r["share"])
        kept += [r for i, r in enumerate(rs[:ROUTES_PER_TYPE]) if i == 0 or r["share"] >= ROUTE_MIN_SHARE]
    kept.sort(key=lambda r: -r["trips"])
    route_out = []
    for i, r in enumerate(kept):
        if len(r["p"]) < 2:
            continue  # block and destination share a junction
        eks = [R.edges[a, c]["ek"] for a, c in zip(r["p"], r["p"][1:])]
        route_out.append({"id": i, "blk": f"Blk {r['b']['blk']} {r['b']['street']}", "type": r["t"],
                          "dest": r["d"]["name"], "len": round(sum(G.edges[e]["length"] for e in eks)),
                          "trips": round(r["trips"], 1), "share": round(r["share"], 2),
                          "barriers": sorted({bt for e in eks for bt in G.edges[e]["barriers"]}),
                          "coords": path_coords(r["p"])})
    dump("routes.json", route_out)

    inside = [b for b in blocks if area.contains(Point(b["ll"]))]
    dump("blocks.json", fc([pt(b["ll"], {k: b[k] for k in ("blk", "street", "units", "year", "subzone", "seniors")})
                            for b in inside]))
    dump("destinations.json", fc([pt(d["ll"], {"type": d["type"], "name": d["name"]})
                                  for d in dests if area.contains(Point(d["ll"]))]))
    w, s_, e, n = area.bounds
    summary = {"slug": slug, "name": town.title(), "seniors": int(sum(nat["seniors_sz"].get(z["name"], 0) for z in zs)),
               "residents": int(sum(nat["total_sz"].get(z["name"], 0) for z in zs)),
               "seniorsModelled": round(sum(b["seniors"] for b in inside)), "blocks": len(inside),
               "weeklyTrips": round(total_trips), "segments": len(segs), "gaps": len(gap_list), "footP50": p50,
               "footP75": p75,
               "bbox": [round(w, 5), round(s_, 5), round(e, 5), round(n, 5)],
               "center": r6([area.centroid.x, area.centroid.y]), "secs": round(time.time() - t0)}
    (out / "summary.json").write_text(json.dumps(summary))
    return summary


OSM_TAGS_WAY = ["covered", "footway", "crossing", "surface", "lit", "incline", "sidewalk", "tunnel", "foot", "access",
                "tactile_paving", "traffic_signals:sound", "traffic_signals:vibration", "crossing:signals"]
OSM_TAGS_NODE = ["kerb", "crossing", "tactile_paving", "traffic_signals:sound", "traffic_signals:vibration"]
GRAPH_VERSION = 2  # bump when the tags kept on graphs change, so cached town graphs get re-cut
FEATURE_TAGS = {"highway": "bus_stop", "railway": "subway_entrance", "shop": "supermarket",
                "leisure": ["park", "fitness_station"],
                "amenity": ["community_centre", "clinic", "marketplace", "bench", "food_court", "cafe", "restaurant"]}
KOPITIAM_WORDS = ("kopitiam", "coffee shop", "coffeeshop", "eating house", "food court", "foodcourt")
ROUTES_PER_TYPE = 2      # per block, the likeliest destinations of each type that get a drawn route
ROUTE_MIN_SHARE = 0.2    # skip destinations a block's seniors rarely pick
NOT_WALKABLE = {"motorway", "motorway_link", "trunk", "trunk_link", "construction", "proposed", "raceway",
                "bus_guideway", "busway", "abandoned", "platform"}


def cache_from_extract(nat, towns):
    """Overpass blocks bulk downloads, so cut each town's walk graph and features out of one
    Singapore OSM extract (download.bbbike.org/osm/bbbike/Singapore/Singapore.osm.gz)."""
    import gzip
    import shutil
    need_graph = [t for t in towns if not (CACHE / "towns" / f"{slugify(t)}.g{GRAPH_VERSION}.graphml").exists()]
    need_feat = [t for t in towns if not (CACHE / "towns" / f"{slugify(t)}.features2.geojson").exists()]
    if not need_graph and not need_feat:
        return
    xml = CACHE / "osm" / "Singapore.osm"
    if not xml.exists():
        with gzip.open(xml.with_suffix(".osm.gz"), "rb") as src, open(xml, "wb") as dst:
            shutil.copyfileobj(src, dst)
    print(f"Cutting {len(need_graph)} walk graphs and {len(need_feat)} feature sets from the OSM extract")
    feats = ox.features_from_xml(xml, tags=FEATURE_TAGS).reset_index()
    feats = feats[[c for c in ["name", "highway", "railway", "shop", "leisure", "amenity", "cuisine", "geometry"]
                   if c in feats]]
    for town in need_feat:
        area = unary_union([s["geom"] for s in nat["subzones"] if s["town"] == town])
        route_buf = to_ll(to_m(area).buffer(CUTOFF_M * 2))
        feats[feats.intersects(route_buf)].to_file(CACHE / "towns" / f"{slugify(town)}.features2.geojson", driver="GeoJSON")
    del feats
    if not need_graph:
        return
    ox.settings.useful_tags_way += OSM_TAGS_WAY
    ox.settings.useful_tags_node += OSM_TAGS_NODE
    G = ox.graph_from_xml(xml, bidirectional=True, simplify=False, retain_all=True)
    drop = [(u, v, k) for u, v, k, d in G.edges(keys=True, data=True)
            if first(d.get("highway")) in NOT_WALKABLE or first(d.get("foot")) == "no"
            or (first(d.get("access")) in ("private", "no") and first(d.get("foot")) not in ("yes", "designated"))]
    G.remove_edges_from(drop)
    for town in need_graph:
        slug = slugify(town)
        area = unary_union([s["geom"] for s in nat["subzones"] if s["town"] == town])
        route_buf = to_ll(to_m(area).buffer(CUTOFF_M * 2))
        sub = ox.truncate.truncate_graph_polygon(G, route_buf)
        sub = ox.truncate.largest_component(ox.simplify_graph(sub))
        ox.save_graphml(sub, CACHE / "towns" / f"{slug}.g{GRAPH_VERSION}.graphml")
        print(f"  {town}: {len(sub)} nodes", flush=True)


_NAT = None


def _init():
    global _NAT
    _NAT = pickle.loads((CACHE / "national.pkl").read_bytes())


def _run(town):
    try:
        return town, build_town(town, _NAT), None
    except Exception as e:  # keep going; one bad town shouldn't stop the country
        return town, None, repr(e)


def write_index(nat):
    towns = []
    for p in sorted((OUT / "towns").glob("*/summary.json")):
        towns.append(json.loads(p.read_text()))
    towns.sort(key=lambda t: t["name"])
    top = []
    for t in towns:
        top += json.loads((OUT / "towns" / t["slug"] / "gaps.json").read_text())[:100]
    top.sort(key=lambda g: g["foot"] * g["severity"], reverse=True)
    (OUT / "top-gaps.json").write_text(json.dumps(top[:500], separators=(",", ":")))
    (OUT / "index.json").write_text(json.dumps({
        "built": time.strftime("%Y-%m-%d"),
        "vision": "done" if any((CACHE / "vision").glob("*.json")) else "not_run",
        "visionSource": "Google Street View photos checked by Claude Opus 5.5",
        "visionMinConfidence": VISION_MIN_CONF,
        "params": {"cutoffM": CUTOFF_M, "decayM": DECAY_M, "stepsFactor": STEPS_FACTOR, "shelterFactor": SHELTER_FACTOR,
                   "unsignalisedCrossingM": UNSIGNALISED_CROSSING_M, "benchGapM": BENCH_GAP_M * 2},
        "destTypes": {k: {"label": v[0], "perWeek": v[1]} for k, v in DEST_TYPES.items()},
        "barriers": {k: {"label": v[0], "severity": v[1], "fix": v[2], "effort": v[3], "profiles": PROFILES[k]}
                     for k, v in BARRIERS.items()},
        "profiles": {"mobility": "Walking frame or wheelchair", "sight": "Low vision or blind"},
        "unknown": UNKNOWN,
        "totals": {"seniors": int(sum(nat["seniors_sz"].values())),
                   "seniorsModelled": sum(t["seniorsModelled"] for t in towns),
                   "blocks": sum(t["blocks"] for t in towns), "weeklyTrips": sum(t["weeklyTrips"] for t in towns),
                   "segments": sum(t["segments"] for t in towns), "gaps": sum(t["gaps"] for t in towns)},
        "towns": [{k: v for k, v in t.items() if k != "secs"} for t in towns],
    }, separators=(",", ":")))


if __name__ == "__main__":
    nat = prep()
    town_slugs = {slugify(s["town"]): s["town"] for s in nat["subzones"]}
    (OUT / "subzones.json").write_text(json.dumps({"type": "FeatureCollection", "features": [
        {"type": "Feature", "properties": {"name": s["name"].title(), "town": slugify(s["town"]),
                                           "seniors": int(nat["seniors_sz"].get(s["name"], 0)),
                                           "residents": int(nat["total_sz"].get(s["name"], 0))},
         "geometry": mapping(s["geom"].simplify(0.0001))} for s in nat["subzones"]]}, separators=(",", ":")))

    wanted = [town_slugs[a] for a in sys.argv[1:]] if sys.argv[1:] else None
    seniors_town = defaultdict(int)
    for s in nat["subzones"]:
        seniors_town[s["town"]] += nat["seniors_sz"].get(s["name"], 0)
    todo = wanted or sorted((t for t, n in seniors_town.items() if n > 0),
                            key=lambda t: (t != FIRST_TOWN, -seniors_town[t]))
    if not os.environ.get("REBUILD"):  # REBUILD=1 redoes towns that already have output
        todo = [t for t in todo if not (OUT / "towns" / slugify(t) / "summary.json").exists()]
    print(f"{len(todo)} towns to build")
    cache_from_extract(nat, todo)
    if todo and todo[0] == FIRST_TOWN:  # get one town out fast so the app has data to show
        _init()
        print(_run(FIRST_TOWN)[1:])
        write_index(nat)
        todo = todo[1:]
    with ProcessPoolExecutor(WORKERS, initializer=_init) as ex:
        for fut in as_completed([ex.submit(_run, t) for t in todo]):
            town, summary, err = fut.result()
            print(town, "->", err or (summary and f"{summary['segments']} segs, {summary['gaps']} gaps, {summary['secs']}s")
                  or "skipped (no HDB blocks)", flush=True)
            write_index(nat)
    write_index(nat)
    print("Done")
