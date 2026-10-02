#!/bin/bash
# Builds dist/SimEyesStudio.app (+ .zip): Swift launcher, a pinned official Node, Studio, agent-device and sim-pool.
# Needs on this Mac: Xcode command line tools (swiftc), npm, curl, and the TypeSafe key to bundle (TYPESAFE_API_KEY or app/typesafe.key). Run: npm run build-app
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
NODE_MAJOR="${NODE_MAJOR:-24}"          # agent-device needs Node >= 22.12
AGENT_DEVICE_VERSION="${AGENT_DEVICE_VERSION:-0.21.19}"
SIM_POOL_SRC="${SIM_POOL_SRC:-$HOME/.claude/skills/sim-pool/scripts/sim-pool}"
ARCH="${ARCH:-$(uname -m)}"             # arm64 or x86_64
case "$ARCH" in arm64) NODE_ARCH=arm64 ;; x86_64) NODE_ARCH=x64 ;; *) echo "ARCH must be arm64 or x86_64" >&2; exit 1 ;; esac

DIST="$REPO/dist"
APP="$DIST/SimEyesStudio.app"
CACHE="$REPO/.cache/node"
VERSION="$(node -p "require('$REPO/package.json').version")"
[ -f "$SIM_POOL_SRC" ] || { echo "sim-pool not found at $SIM_POOL_SRC (set SIM_POOL_SRC)" >&2; exit 1; }

# 1. Official Node, checked against nodejs.org's published SHA-256.
mkdir -p "$CACHE"
BASE="https://nodejs.org/dist/latest-v$NODE_MAJOR.x"
curl -fsSL "$BASE/SHASUMS256.txt" -o "$CACHE/SHASUMS256-$NODE_MAJOR.txt"
TARBALL="$(grep -o "node-v[0-9.]*-darwin-$NODE_ARCH.tar.gz" "$CACHE/SHASUMS256-$NODE_MAJOR.txt" | head -1)"
[ -n "$TARBALL" ] || { echo "no darwin-$NODE_ARCH tarball in $BASE" >&2; exit 1; }
if [ ! -f "$CACHE/$TARBALL" ]; then curl -fL "$BASE/$TARBALL" -o "$CACHE/$TARBALL"; fi
WANT="$(grep " $TARBALL\$" "$CACHE/SHASUMS256-$NODE_MAJOR.txt" | cut -d' ' -f1)"
GOT="$(shasum -a 256 "$CACHE/$TARBALL" | cut -d' ' -f1)"
[ "$WANT" = "$GOT" ] || { echo "Node checksum mismatch for $TARBALL" >&2; rm -f "$CACHE/$TARBALL"; exit 1; }
tar -xzf "$CACHE/$TARBALL" -C "$CACHE" "${TARBALL%.tar.gz}/bin/node"

# 2. Bundle layout.
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources/sim-eyes"
RES="$APP/Contents/Resources"
cp "$CACHE/${TARBALL%.tar.gz}/bin/node" "$RES/node"
cp "$SIM_POOL_SRC" "$RES/sim-pool"
chmod +x "$RES/sim-pool"

# 3. Studio + MCP server code (no tests, evals or fixtures), then production dependencies and agent-device.
cd "$REPO"
for f in *.mjs ocr.swift package.json; do
  case "$f" in test-*|eval-*) continue ;; esac
  cp "$f" "$RES/sim-eyes/$f"
done
mkdir -p "$RES/sim-eyes/studio"
for f in studio/*.mjs; do
  case "$f" in studio/test-*|studio/eval-*) continue ;; esac
  cp "$f" "$RES/sim-eyes/$f"
done
cp -R studio/public "$RES/sim-eyes/studio/public"
( cd "$RES/sim-eyes" && PATH="$(dirname "$RES/node"):$PATH" npm install --omit=dev --no-audit --no-fund --silent && npm install --no-save --omit=dev --no-audit --no-fund --silent "agent-device@$AGENT_DEVICE_VERSION" )

# 3b. The TypeSafe key the app ships with (env TYPESAFE_API_KEY, else app/typesafe.key, which is git-ignored).
KEY="${TYPESAFE_API_KEY:-}"
if [ -z "$KEY" ] && [ -f app/typesafe.key ]; then KEY="$(tr -d '[:space:]' < app/typesafe.key)"; fi
[ -n "$KEY" ] || { echo "No TypeSafe key to bundle: set TYPESAFE_API_KEY or put it in app/typesafe.key" >&2; exit 1; }
printf '%s' "$KEY" > "$RES/typesafe.key"
chmod 600 "$RES/typesafe.key"

# 4. Launcher.
sed "s/__VERSION__/$VERSION/" app/Info.plist > "$APP/Contents/Info.plist"
swiftc -O -target "$ARCH-apple-macos13.0" app/main.swift -o "$APP/Contents/MacOS/SimEyesStudio"

# 5. Ad-hoc signature (no Developer ID): testers open it once with right-click > Open, see app/README.md.
codesign --force --deep --sign - "$APP"
codesign --verify --deep --strict "$APP"

( cd "$DIST" && rm -f SimEyesStudio.zip && ditto -c -k --keepParent SimEyesStudio.app SimEyesStudio.zip )
echo "Built $APP ($ARCH, Node ${TARBALL#node-}) and $DIST/SimEyesStudio.zip"
