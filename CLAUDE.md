# CLAUDE.md

Guidance for an agent working in this repo — what the documentation
surfaces are, and the one rule for keeping them accurate.

## What this repo is

The Urlcade: a game-authoring API where a cart is a plain JS object,
compiled by `url-console/v0/kernel.js` to bytes and shipped as a URL
fragment, played by the static runtime in `url-console/v0/`. No server,
no build step, no account. `kernel.js` and `url-console/v0/runtime.js`
**are the spec** — every doc surface below is a teaching layer on top of
them, never the other way around.

## The three doc surfaces, and what each is for

| Surface | Audience | Purpose |
|---|---|---|
| `.claude/skills/urlcade/SKILL.md` + `references/*.md` | Agents | Concise, progressive-disclosure reference for building/debugging a cart. `SKILL.md` is a router only — it names each reference file and when to load it, nothing more. |
| `spec/learn/index.html` | Humans | A taught tour with visuals and small live demos, each calling the real `kernel.js` functions directly (never a re-implementation, never narration of what the code does — run it and show the result). |
| `DESIGN.md` | Maintainers | An append-only historical dev log — every round of work, the bug found, the fix, the reasoning. Separate on purpose. |

**`DESIGN.md` is never linked from, and never a source for, the other
two.** The skill and the learn site teach *what the system is and how
to use it right now*; `DESIGN.md` records *how it got that way*. Mixing
the two makes the teaching surfaces bloat with irrelevant history and
makes `DESIGN.md` stop being a trustworthy chronological record. Keep
doing `DESIGN.md` rounds for actual changes (a bug fixed, a feature
shipped, a perf issue chased down) exactly as before — this file doesn't
change that workflow at all.

## The upsert rule

When a change touches anything the skill or learn site describes — a new
opcode, a new/changed cart field, new hook semantics, a new map generator
or a changed config shape, a new binary-format field — update the *one*
matching reference file under `.claude/skills/urlcade/references/`, and
the matching section of `spec/learn/index.html`, **in the same change**.
Concretely:

- New opcode → `references/opcodes.md`'s matching group, and the VM
  section's opcode-group cards on the learn site.
- New/changed cart field → `references/cart-object.md`.
- New/changed hook behavior or dispatch → `references/hooks.md`.
- New/changed map generator or its config → `references/map-generators.md`.
- Anything about the byte layout or URL transport →
  `references/binary-format.md`.
- The end-to-end recipe, the worked example, or a newly-discovered sharp
  edge worth warning about → `references/workflow.md`.

Leave `SKILL.md` itself alone unless the *set of reference files* or the
one-paragraph "what is a cart" summary changed — it's a router, not a
place for content to accumulate.

**Write new content the same way the existing reference files were
written: read the relevant function in `kernel.js`/`runtime.js` directly
and describe what it actually does, field by field or opcode by opcode.**
Don't derive new doc content from an example cart's authored patterns
(`url-console/v0/carts/*.js`) or from `DESIGN.md`'s prose — both can lag
or editorialize; the source functions can't.

**No historical or changelog prose in either surface, ever** — no "this
used to X," no "fixed a bug where," no session/PR references. If a
sentence explains *why something changed* rather than *what it currently
is*, it belongs in a `DESIGN.md` round, not here.

## Verifying doc changes

- `NODE_PATH=/opt/node22/lib/node_modules node url-console/v0/test/smoke.js`
  runs the full suite, including a check that `spec/learn/index.html`
  loads clean and its demos work — run it after any change to the learn
  site or to `kernel.js` (a signature change there can silently break a
  demo that calls it).
- `url-console/build-site.sh <dest-dir>` assembles the exact deployed
  layout (what `.github/workflows/pages.yml` publishes) — the learn
  site's relative script path (`../kernel.js`) and the skill's raw-fetch
  path only resolve correctly in that built tree, not by opening
  `spec/learn/index.html` straight from a checkout.
- For a reference file, spot-check it against the actual `kernel.js`
  function it describes side by side before considering it done — a
  reference that reads well but drifted from the code is worse than no
  reference at all.
