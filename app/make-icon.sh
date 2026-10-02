#!/bin/bash
# Renders app/icon.svg into app/AppIcon.icns (committed, so build-app.sh needs none of these tools).
# Needs rsvg-convert (brew install librsvg), sips and iconutil. Run after changing app/icon.svg: bash app/make-icon.sh
set -euo pipefail
cd "$(dirname "$0")"
SET="$(mktemp -d)/AppIcon.iconset"
mkdir -p "$SET"
rsvg-convert -w 1024 -h 1024 icon.svg -o "$SET/master.png"
for size in 16 32 128 256 512; do
  sips -z "$size" "$size" "$SET/master.png" --out "$SET/icon_${size}x${size}.png" >/dev/null
  sips -z "$((size * 2))" "$((size * 2))" "$SET/master.png" --out "$SET/icon_${size}x${size}@2x.png" >/dev/null
done
rm "$SET/master.png"
iconutil -c icns "$SET" -o AppIcon.icns
echo "Wrote app/AppIcon.icns"
