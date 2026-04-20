#!/bin/bash
# One-off fixup: merge web/ into docs/ (after mid-run dir rename).
# Safe to run once; deletes web/ after successful merge.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if [ ! -d web ]; then
  echo "No web/ dir — nothing to merge."
  exit 0
fi

echo "Merging web/ → docs/ ..."
mkdir -p docs/audio docs/data

if [ -d web/audio ]; then
  for slug in web/audio/*; do
    name=$(basename "$slug")
    mkdir -p "docs/audio/$name"
    # cp -n: no-clobber, preserves docs/ files that already exist
    cp -n "$slug"/*.mp3 "docs/audio/$name/" 2>/dev/null || true
    echo "  audio: $name ($(ls "docs/audio/$name" | wc -l) files)"
  done
fi

if [ -d web/data ]; then
  cp -f web/data/*.json docs/data/ 2>/dev/null || true
  echo "  data: $(ls docs/data | wc -l) files"
fi

rm -rf web
echo "Done."
