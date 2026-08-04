# The Urlcade

A self-hosted game-authoring API, delivered as a URL-encoded virtual
console: build a cart as a plain JS object, encode it to bytes, and the
resulting URL fragment *is* the game — decoded and run by a static,
modular JS runtime shared by every cart. No server, no build step, no
install, no account.

- **[Play the carts](https://canyonturtle.github.io/games/)** — the live
  shelf, plus Debug (inspect/edit/recompile any cart) and "+ New Cart."
- **[Learn how it works](https://canyonturtle.github.io/games/spec/learn/)**
  — a taught tour with visuals and live demos.
- **[Build a cart](https://canyonturtle.github.io/games/spec/)** — raw
  docs for an agent or a power user; start at
  [`skill/SKILL.md`](https://canyonturtle.github.io/games/spec/skill/SKILL.md).

Building with Claude Code directly in this repo? The same docs are at
`.claude/skills/urlcade/`, auto-loaded as a skill. See `CLAUDE.md` for how
the doc surfaces in this repo relate to each other.
