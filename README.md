# SilverSteps

Ageing Well in Place: estimates which footpaths seniors (65+) in Singapore's HDB towns depend on most, checks those paths for barriers, and ranks fixes by how many seniors each would help. Residents can correct the findings and draw the routes they really walk.

Everything is **modelled**, not counted: senior numbers per block are spread from SingStat subzone totals, and trips come from a gravity model over the OpenStreetMap walking network. No individual movement data is used.

## Layout

| Path | What |
|---|---|
| `pipeline/build.py` | Builds `web/public/data/` for every town: blocks, destinations, senior-weighted routing, footfall, barriers, ranked gaps |
| `pipeline/streetview_refs.py` | Adds the nearest Google Street View panorama to every gap (metadata only, not billed) |
| `pipeline/vision.py` | Claude checks Street View photos of the busiest paths against a fixed checklist |
| `web/` | Vite + React + MapLibre site |
| `server/` | FastAPI: serves the site and stores corrections and resident routes (MariaDB on Deployer, SQLite locally) |
| `failover/` | Cloudflare Worker: serves the Firebase backup when the main server is down |

## Run

```bash
python -m venv .venv && .venv/Scripts/pip install osmnx geopandas scikit-learn anthropic
.venv/Scripts/python pipeline/build.py            # REBUILD=1 to redo finished towns
.venv/Scripts/python pipeline/streetview_refs.py  # needs GOOGLE_MAPS_API_KEY in .env
.venv/Scripts/python pipeline/vision.py           # needs ANTHROPIC_API_KEY too; then REBUILD=1 build.py
cd web && npm ci && npm run dev
```

## Data sources

OpenStreetMap (BBBike Singapore extract), data.gov.sg (HDB property information, HDB building footprints, Master Plan 2019 subzones, Census 2020 dwelling type, hawker centres, CHAS clinics, eldercare services), SingStat residents by subzone and age (June 2025), Google Street View.

## Deploy

Main: Deployer (`Dockerfile`) at silversteps.liewjiaen.com. Backup: Firebase Hosting site `silversteps-sg` (`firebase deploy --only hosting:backup`), switched in automatically by `failover/worker.js`.
