#!/usr/bin/env bash
# Full national refresh: model every town, link Street View, photo-check the busiest paths, fold results in.
set -euo pipefail
cd "$(dirname "$0")/.."
PY=.venv/Scripts/python
export PYTHONUNBUFFERED=1 PYTHONWARNINGS=ignore
echo "== build"; REBUILD=1 $PY pipeline/build.py
echo "== street view links"; (cd pipeline && ../$PY streetview_refs.py)
echo "== photo checks"; (cd pipeline && ../$PY vision.py --per-town 30)
echo "== fold photo findings"; REBUILD=1 $PY pipeline/build.py
echo "== links for new gaps"; (cd pipeline && ../$PY streetview_refs.py)
echo "== ALL DONE"
