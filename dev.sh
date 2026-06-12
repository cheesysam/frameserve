#!/usr/bin/env bash
# Local dev runner — no Docker, no NAS.
# Edit code -> Ctrl-C -> ./dev.sh -> refresh browser.
#
# Override any of these inline, e.g.:  PORT=9000 ./dev.sh
set -euo pipefail
cd "$(dirname "$0")"

PORT="${PORT:-8008}"
PHOTOS_DIR="${PHOTOS_DIR:-./photos}"

mkdir -p "$PHOTOS_DIR"

echo "Frameserve dev server -> http://localhost:${PORT}  (photos: ${PHOTOS_DIR})"
PORT="$PORT" PHOTOS_DIR="$PHOTOS_DIR" AUTH_TOKEN="${AUTH_TOKEN:-}" go run main.go
