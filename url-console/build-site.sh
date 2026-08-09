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

mkdir -p "$DEST/spec/skill/references" "$DEST/spec/learn"

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
cp "$ROOT/v0/multiplayer.js" "$DEST/multiplayer.js"
cp "$ROOT/v0/avatars.js" "$DEST/avatars.js"
cp -r "$ROOT/v0/carts" "$DEST/carts"
# Vendored Trystero (DESIGN.md §79) — third-party .mjs files copied
# verbatim, not cache-busted below: pinned to a specific vendored
# version and only ever changes via a deliberate re-vendor (see
# vendor/trystero/README.md), not on every commit the way main.js/
# runtime.js do.
cp -r "$ROOT/v0/vendor" "$DEST/vendor"

cp "$ROOT/v0/kernel.js" "$DEST/spec/kernel.js"
cp "$ROOT/v0/fixtures.md" "$DEST/spec/fixtures.md"
cp "$ROOT/v0/fixtures.md" "$DEST/fixtures.md" # also at the root — the Debug view's Source tab links here without /spec/

# The agent-facing skill (CLAUDE.md explains the doc architecture) —
# published raw so any agent fetching by URL gets the same file Claude
# Code reads locally from .claude/skills/urlcade/, not a second copy
# that can drift.
cp "$ROOT/../.claude/skills/urlcade/SKILL.md" "$DEST/spec/skill/SKILL.md"
cp "$ROOT/../.claude/skills/urlcade/references/"*.md "$DEST/spec/skill/references/"

# The human-facing learn site — self-contained, loads spec/kernel.js
# (copied above) directly for its live demos.
cp "$ROOT/../spec/learn/index.html" "$DEST/spec/learn/index.html"

# Cache-busting: append ?v=<version> to every local <script src>/import
# reference, so a browser (or a CDN in front of a custom domain) holding
# a stale cached copy of e.g. main.js from a previous deploy is forced to
# fetch the new one instead of silently running old code against new
# HTML. Found the hard way — a real deploy where the page itself updated
# but a cached main.js didn't, so two brand-new buttons ("Debug", "+ New
# Cart") looked wired up but silently did nothing (DESIGN.md §32).
# `git rev-parse` guarantees a fresh value on every commit with zero
# manual bumping to forget; a plain incrementing counter would work too
# but only if someone remembers to move it. Falls back to the current
# time if this isn't a git checkout (e.g. a tarball).
VERSION="$(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || date +%s)"
CACHEBUST_FILES=(
  "$DEST/index.html" "$DEST/main.js" "$DEST/runtime.js" "$DEST/inspector.js" "$DEST/multiplayer.js" "$DEST/avatars.js"
  "$DEST/carts/index.js" "$DEST/carts"/*.js
  "$DEST/spec/learn/index.html"
)
for f in "${CACHEBUST_FILES[@]}"; do
  sed -E -i \
    -e "s/(src=\"[^\"]+\.js)\"/\\1?v=$VERSION\"/g" \
    -e "s/(from '[^']+\.js)'/\\1?v=$VERSION'/g" \
    "$f"
done
