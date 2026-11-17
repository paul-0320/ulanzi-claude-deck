#!/bin/bash
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
src="$here/dials"
dest="$HOME/Library/Application Support/Ulanzi/UlanziDeck/Plugins/com.ulanzi.claudeeffort.ulanziPlugin"

if [ ! "$here/bin/deckkeys" -nt "$here/deckkeys.swift" ]; then
  mkdir -p "$here/bin"
  swiftc -O -o "$here/bin/deckkeys" "$here/deckkeys.swift"
fi
if [ ! -d "$src/plugin/node_modules/ws" ]; then
  (cd "$src/plugin" && npm install --omit=dev --no-audit --no-fund)
fi

if [ -e "$dest" ]; then
  mv "$dest" "$(mktemp -d)/"
fi
mkdir -p "$dest"
cp -R "$src/." "$dest/"
mkdir -p "$dest/plugin/bin"
cp "$here/bin/deckkeys" "$dest/plugin/bin/deckkeys"
echo "installed: $dest"
echo "restart Ulanzi Studio (from Finder or Launchpad) to load it"
