#!/usr/bin/env bash
# Resume the national refresh after the Street View link stage.
set -euo pipefail
cd "$(dirname "$0")/.."
PY=.venv/Scripts/python
export PYTHONUNBUFFERED=1 PYTHONWARNINGS=ignore
echo "== photo checks"; (cd pipeline && ../$PY vision.py --per-town 30)
echo "== fold photo findings"; REBUILD=1 $PY pipeline/build.py
echo "== links for new gaps"; (cd pipeline && ../$PY streetview_refs.py)
echo "== ALL DONE"
