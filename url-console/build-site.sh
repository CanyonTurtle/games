#!/usr/bin/env bash
# Assembles the deployed Pages site layout into $1 — exactly what
# .github/workflows/pages.yml publishes. Used by that workflow AND by
# test/smoke.js, so there is exactly one place that knows the site's
# file layout instead of two that can quietly drift apart (a config
# and a test, in this shape, drift exactly as easily as two copies of
# kernel.js used to — see DESIGN.md §29).
set -euo pipefail
DEST="${1:?usage: build-site.sh <dest-dir>}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

mkdir -p "$DEST/spec"

# v0/*'s runtime files, flat at the site root — not under /v0/ — so
# every fragment link ever shared against this site (`#z.<payload>` at
# the root) keeps working. See pages.yml's own comment. This is also now
# the entire self-serve experience: play, Debug (Inspector + Source/
# Compile tabs), "+ New Cart" — one page, no separate /compile (see
# DESIGN.md §30).
cp "$ROOT/v0/index.html" "$DEST/index.html"
cp "$ROOT/v0/kernel.js" "$DEST/kernel.js"
cp "$ROOT/v0/color-utils.js" "$DEST/color-utils.js"
cp "$ROOT/v0/runtime.js" "$DEST/runtime.js"
cp "$ROOT/v0/inspector.js" "$DEST/inspector.js"
cp "$ROOT/v0/main.js" "$DEST/main.js"
cp -r "$ROOT/v0/carts" "$DEST/carts"

cp "$ROOT/../llms.txt" "$DEST/llms.txt"
cp "$ROOT/../spec/index.html" "$DEST/spec/index.html"
cp "$ROOT/v0/kernel.js" "$DEST/spec/kernel.js"
cp "$ROOT/v0/fixtures.md" "$DEST/spec/fixtures.md"
cp "$ROOT/v0/AUTHORING.md" "$DEST/spec/AUTHORING.md"
# Also at the root — llms.txt, AUTHORING.md, and the Debug view's Source
# tab all link to these without /spec/.
cp "$ROOT/v0/AUTHORING.md" "$DEST/AUTHORING.md"
cp "$ROOT/v0/fixtures.md" "$DEST/fixtures.md"
