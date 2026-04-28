#!/usr/bin/env bash
# Render the first page of an audit PDF to PNG for the README.
#
# Usage:
#   scripts/render-pdf-hero.sh pdfs/aml-screening-pjotrs-avens-c5a44f51.pdf
#
# Output: public/screenshots/05-pdf-page.png
set -euo pipefail

INPUT="${1:?usage: $0 <input.pdf>}"
OUT_DIR="$(dirname "$0")/../public/screenshots"
mkdir -p "$OUT_DIR"

# pdftoppm: -r 144 = 2x DPI for crisp Retina; -f 1 -l 1 = first page only
pdftoppm -r 144 -f 1 -l 1 -png "$INPUT" "$OUT_DIR/05-pdf-page"
# pdftoppm appends "-1" to filename when -l 1; rename to fixed name
if [[ -f "$OUT_DIR/05-pdf-page-1.png" ]]; then
  mv "$OUT_DIR/05-pdf-page-1.png" "$OUT_DIR/05-pdf-page.png"
fi

echo "✓ Wrote $OUT_DIR/05-pdf-page.png"
