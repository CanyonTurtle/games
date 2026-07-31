# The Urlcade: a fully URL-encoded virtual console

Status: draft / strawman for discussion. Nothing here is implemented yet.
This document crystallizes a design sketch — it intentionally leaves an
"Open Questions" list at the end rather than pretending every decision is
final.

## 1. Philosophy

A cart is a URL. The runtime (interpreter, generators, sprite/palette
libraries, sound synth) is static JS/WASM shipped with the site, identical
for every cart. The URL only carries the *delta* that makes one cart
different from another — never the delta plus the engine.

Two corollaries fall out of that and drive most of the decisions below:

1. **Generate, don't store.** A byte spent on a literal tile is a byte
   that could have driven a generator producing a hundred tiles. Seeds,
   harmony rules, and grammars are the currency; raw asset data is a last
   resort escape hatch, not the default path.
2. **The format is the save file is the mod tool.** Because the cart *is*
   the URL, there's no separate save-state or level-editor format to
   design — flipping a mode-flag bit in the fragment IS "hard mode," and
   pasting the URL back to a friend IS "sharing your save."

## 2. Envelope

Cart data lives in the URL **fragment** (`#...`), never the query string:
no server ever sees it, no server-side length limit applies, and
navigating between fragment states doesn't reload the page (so the
runtime can rewrite `location.hash` live as a "soft save").

```
https://urlcade.example/#u1.<payload>
```

- `u1` — literal envelope tag + format version. Lets the runtime dispatch
  to the correct historical decoder if the format ever changes shape.
- `payload` — base64url of a compressed binary blob.

Encoding choice: base64url (6 bits/char) over a denser custom Unicode
alphabet. A bigger alphabet buys maybe 20–30% density but breaks on
copy/paste into half the apps people share links through (Twitter, SMS,
chat clients that don't round-trip astral-plane characters cleanly).
Compatibility wins.

Size classes (a creative constraint, not just an engineering one — see
demoscene 4k/64k intro categories for prior art):

| Class | Fragment length | Intended feel |
|---|---|---|
| **micro** | ≤ 280 chars | tweetable, fits in a QR code at low error-correction |
| **standard** | ≤ ~1000 chars | the default target |
| **full** | ≤ ~2000 chars | ceiling; still safe against old proxies/IE-era limits even though fragments technically avoid most of those |

## 3. Compression

Because the runtime is shared and static, it can carry a **preset
dictionary** trained on a corpus of real carts (common opcode
sequences, common RLE tile runs, stock palette-seed shapes) that never
travels over the wire. Raw DEFLATE with a preset dictionary (or a small
static range coder over the same corpus) beats generic gzip/brotli for
this domain because the dictionary is doing work for free.

The dictionary is versioned **together with** the envelope format
version (`u1`, `u2`, ...) — bumping the dictionary without bumping the
version byte would silently corrupt old links, so it's treated as a
breaking change to the format, not a runtime implementation detail.

An uncompressed escape mode exists for hand-golfers who want to craft
bits by hand and see exactly what they're spending — `u1r` (raw) instead
of `u1` (dictionary-compressed).

## 4. Header / memory map

Every cart starts with a fixed header, then a body whose *shape* is
determined by the `cart_type` field. This is the "reserve segments of
memory for flags" idea made concrete:

```
bit offset  width  field
0           4      format_version
4           6      cart_type          (genre template, §5)
10          2      palette_mode       (§6)
12          8      palette_seed_lo    (meaning depends on palette_mode)
20          8      rng_seed           (drives procedural gen + determinism)
28          8      mode_flags         (difficulty, controls, wrap, seed-vs-explicit, ...)
36          —      cart_type-specific body (§5)
```

`mode_flags` is a plain bitfield, not something a schema owns, precisely
so it's the thing people hand-edit to remix a shared link: flip bit 2
for "hard mode," bit 5 for "mirrored controls," etc. It's the one segment
of the header explicitly designed to be readable and toggleable by a
human without a decoder.

## 5. Cart types (genre templates)

> **Superseded by §14.** This section is kept for historical framing —
> it's the original guess, and the "what body schema does `cart_type`
> unlock" idea drove real design work. But a runtime dogfood (§14) found
> the guess encouraged exactly the wrong instinct (branch behavior on
> `cart_type`) and replaced it: `cart_type` is now advisory metadata only,
> and what used to be "the racer template's body" is a composable **map
> generator** selected independently of any genre label. Read this
> section as motivation, not as the current mechanism.

A single universal schema is either too narrow (one genre) or too
expensive (bytecode-only, general enough to express everything but
costing a lot of bits per unit of gameplay). Instead, `cart_type` selects
a **genre-specific declarative layout** for the expensive parts
(tilemap, entity table, level structure), all sharing the same header
and the same behavior-hook VM (§7).

| cart_type | Template | Body highlights |
|---|---|---|
| 0 | Platformer | RLE tilemap, gravity/jump constants, entity spawn table |
| 1 | Puzzle/match | grid dims, piece-type bank, win condition flags |
| 2 | Racer/golf | track spline control points or procedural track seed, physics constants |
| 3 | Roguelike/dungeon | WFC/cellular-automata seed + generation knobs, no literal map at all |
| 4 | Arena/shooter | arena shape id, wave table, enemy archetype indices |
| 5 | Sandbox/toy | no fixed win condition; mostly hook-VM driven |
| 6–62 | reserved | future templates |
| 63 | Generic/raw | no declarative body — 100% behavior-hook VM, for genre-breaking experiments |

Cart type 63 is the deliberate escape hatch: it costs more bytes per
behavior than a templated genre, but nothing about the format forces
every game into one of the six house styles.

## 6. Palette design

This was the explicit open question, so here's the concrete answer: a
2-bit `palette_mode` selector, because "curated set" and "infinite
procedural expressiveness" aren't actually in tension if the procedural
path is driven by real color theory instead of raw random RGB (random
RGB triples almost always look bad; harmony rules almost always look
fine).

| palette_mode | Meaning | Cost |
|---|---|---|
| 0 | **Curated bank** — index into ~32 hand-designed palettes (Game Boy green, CRT amber, NES-ish, grayscale, ...) | 5 bits |
| 1 | **Procedural harmony** — generated from a seed via color theory (below) | ~20–24 bits |
| 2 | **Derived-from-cart-type default** — e.g. roguelike defaults to a moody desaturated ramp, overridable | 0 bits (uses cart_type as implicit seed) |
| 3 | **Explicit RGB** — raw color list, escape hatch for hand-authored art | expensive, ~4–8 bits/color |

Procedural harmony generation (`palette_mode = 1`):

```
base_hue        8 bits   (0-255 -> 0-360°)
harmony_scheme  3 bits   {monochrome, analogous, complementary,
                          split-complementary, triadic, tetradic,
                          square, jittered}
sat_curve       4 bits   (min/max saturation, coarse-quantized)
light_ramp      4 bits   (min/max lightness, coarse-quantized)
accent_offset   3 bits   (hue offset for UI/accent colors relative to base)
```

A deterministic function turns those ~22 bits into a full N-color ramp
(N fixed per cart_type, e.g. 16). Because the *rule* is color theory
(complementary/triadic/analogous relationships, a lightness ramp for
shading), the output is close to always coherent — the same trick as
constraining procedural level generation with rules so the *output*
stays playable even though the *input* is a handful of random-looking
bits. Nostalgia-console constraint (fixed small palette size) is kept;
"infinite expressiveness" comes from the seed space, not from an
unbounded color count.

Recommendation: default to mode 1, keep mode 0 for pinned "featured"
aesthetics (so not everything visually reads as "generated"), and keep
mode 3 as a true escape hatch nobody is forced to pay for.

## 7. The lifecycle-hook VM

Rather than one big general-purpose bytecode language for *everything*
(expensive per bit of gameplay it buys) or no programmability at all
(genre templates can't anticipate every behavior), custom logic lives in
a small **stack machine** invoked only at fixed **lifecycle hook
points**. The declarative body (§5) owns structure; the VM owns
behavior.

Hook points (each either present with a bytecode offset, or absent —
absence costs 1 bit):

- `on_init` — once, at cart load
- `on_frame` — once per logic step, **global** (spawning, timers, whole-cart bookkeeping)
- `on_tick(self)` — once per logic step, **per active entity** (see below — amended after the Flappy Bird dogfood, §12)
- `on_input(button_mask)`
- `on_collide(type_a, type_b)`
- `on_timer(timer_id)`
- `on_spawn(entity_id)` / `on_death(entity_id)`
- `on_score_change(delta)`
- `on_draw_extra` — optional overlay after the automatic tile/entity draw

`on_tick` was originally sketched as a single global call. The Flappy
Bird dogfood (§12) found that's a dead end for anything with a
dynamic-length entity set: with no arrays or loops in the VM, there's no
way for one global call to iterate "all pipes." Splitting it into a
global `on_frame` (spawning, score-independent bookkeeping) and a
per-entity `on_tick(self)` (physics, per-entity scoring/despawn, same
shape as `on_collide(a, b)`) resolves it without adding loop primitives.

VM shape:
- Integer/fixed-point only (16.16), **no floats** — cross-browser float
  determinism is not guaranteed by spec, and determinism is load-bearing
  here (replays, ghosts, shared seeds all depend on it).
- Small operand stack (depth 16), a handful of 3-bit-indexed scratch
  registers, and mediated access to: current entity's properties, tile
  get/set, global flags, RNG.next(), score, sound-trigger,
  sprite-override.
- Entity properties = a small **universal set** (`pos_x, pos_y, vel_x,
  vel_y, type, hp, anim_frame`) plus **per-type declared extension
  fields** with their own bit widths, listed in the entity type table
  (§7.1). Flappy Bird (§12) first surfaced the need with two generic
  `custom0`/`custom1` scratch slots; the race car dogfood (§13) showed
  that doesn't generalize — a car needs five named fields
  (`heading`, `angular_vel`, `next_cp`, `lap_count`, `finish_rank`) at
  once, while a particle needs exactly one (`ttl`). A fixed generic
  count is either wasteful or insufficient depending on the type, so
  each cart declares what its own entity types need instead of the
  format guessing a number that fits everyone.
- `LOADE <entity-id>.<prop>` / `STOREE` — read or write a property on
  an entity that is **neither** `self` nor `a`/`b`, given its id (from
  a global or a computed value). Flappy Bird flagged this as an open
  question (a pipe needing the bird's `pos_x`); the race car dogfood
  confirmed it's load-bearing, not optional — `on_frame` has no bound
  entity at all, and computing race position requires comparing
  progress across every known car from there.
- `SIN(angle)` / `COS(angle)` / `ATAN2(dy, dx)` — fixed-point trig via a
  shared runtime-resident lookup table (e.g. 256 entries covering
  0–360°), not computed by cart bytecode. Anything with a heading
  (steering, aiming, knockback direction) needs this, and hand-rolling
  a series expansion in a tiny fixed-point VM is a bad time. The table
  lives once in the runtime, so it's free per-cart no matter how many
  carts use it.
- `SETTILE(x, y, tile_id)` — the write counterpart `GETTILE` never got.
  An honest gap, not a deliberate omission: nothing needed runtime tile
  mutation until the roguelike dogfood's gold pickups (§15) did.
- `MOVE_SOLID` — given `self`'s pos/vel/collision box, resolves movement
  against the tilemap one axis at a time using `TILE_SURFACE`'s
  solid/non-solid distinction, snapping position and zeroing blocked
  velocity components. The racer's tiles are *soft* (surface only
  changes a friction constant); a platformer's are *hard* (must actually
  block movement), and hand-rolling axis-separated swept-AABB-vs-tile
  collision per cart is exactly the "expensive to re-derive, cheap to
  ship once" case that justified `SIN`/`COS`/`ATAN2` as opcodes instead
  of bytecode — see the platformer dogfood, §15.
- A small **constant pool**: a handful (e.g. 8) of named fixed-point
  values declared in the header and referenced from bytecode by index
  (`PUSHC n`) instead of re-encoding literals inline. Cheaper once a
  constant (gravity, scroll speed) is used more than once, and gives
  designers one place to retune a cart instead of hunting through
  bytecode. Also added after §12.
- Dense encoding: the ~16 hottest ops (push-small-int, push-const,
  add, sub, get/set-entity-prop, compare, branch, jump-if-zero,
  call-local-sub, return, get/set-tile, random, play-sound, spawn,
  **kill**) get a 4-bit opcode; a 4-bit escape value opens a secondary
  byte-wide table for rarer ops (including `LOADE`/`STOREE` and the
  trig ops above). `KILL self` (remove an entity) was missing from the
  first draft — obvious in hindsight, but nothing else in the format
  catches an unbounded-entity-growth bug, so it's promoted to the hot
  table. No strings, no heap, no dynamic allocation.

### 7.1 Entity type table

A header segment, one entry per entity type id in use, declaring:
`render_kind` (`sprite` [optionally `rotate_by: <angle-prop>`] |
`tile_column_down` | `tile_column_up` | `rect`), an asset index, a
collision shape, and a list of `(name, bit-width)` extension fields
appended after the universal property set. First introduced (render
kind only) by the Flappy Bird dogfood (§12) to handle pipes that aren't
single sprites; extended to declared per-type fields by the race car
dogfood (§13). `rotate_by` (render a stored sprite at an arbitrary
runtime angle instead of storing pre-rotated frames) was the race car's
addition, riding on the same trig table added for physics.
- **Hard step budget per hook invocation** (e.g. 2000 VM steps). Exceeding
  it aborts that hook call and surfaces a visible "cart fault" indicator
  — never a silent hang, since this is untrusted code executing from a
  clicked link.
- No wall-clock reads inside the VM — only a monotonic tick counter and
  the seeded RNG — so the same cart + same input stream always produces
  the same frames, which is what makes replay/ghost sharing (§8) work at
  all.

## 8. Determinism, replays, and "multiplayer"

Since RNG and time are both fully seeded/deterministic, a "beat my
score" challenge link is just `seed + compressed input stream` — no
server needed. This is the natural async-multiplayer story for a
serverless format: ghost replays, ChallengeLink-style score attacks,
no real-time netcode implied or promised.

**Simulation rate is fixed and decoupled from display rate, and rendering
interpolates between ticks.** V0 first ran the simulation once per
elapsed-33ms check inside the render loop itself — so on a 60Hz+ display,
most rendered frames simply redrew the previous tick's positions
unchanged (measured: ~63% of frames were pixel-identical to the frame
before, which is exactly what reads as "choppy"). The fix is the standard
one: the simulation always advances in fixed ticks (any number of them
per rendered frame, to catch up if a frame ran long) entirely independent
of however fast requestAnimationFrame fires, and the renderer is handed
`alpha` — how far into the next, not-yet-simulated tick real time has
gotten — and linearly interpolates each entity's position (and, angle-
aware, heading) between its last two tick states for display. This is
presentation-only: the actual simulation state used for collisions,
scoring, and anything else consequential is exactly the fixed-tick value,
never the interpolated one, so replay/ghost determinism (above) is
untouched by how smoothly a given viewer's display happens to render it.

## 9. Safety model

Carts execute the moment a link is opened. Non-negotiables:
- No `eval`, no dynamic code generation — the VM is the only execution
  surface, and it's interpreted from data, not from source text.
- No ambient network or storage access from cart code. Persistence
  (e.g. high scores) goes through a mediated runtime API into
  `localStorage`, never raw.
- Step budget (§7) prevents hangs; there is no "infinite loop" a cart
  can express that isn't caught within one hook invocation.

## 10. Versioning

`format_version` (4 bits) covers the envelope + header shape.
`cart_type` schemas, the VM opcode table, the compression dictionary,
and procedural generators are all versioned *together* with it — old
links must keep decoding the same way forever, which means the runtime
carries every historical version's decoder/generator rather than
mutating them in place.

## 11. Worked example (illustrative, not final)

A "standard" platformer cart, uncompressed for readability:

```
format_version = 1
cart_type      = 0 (platformer)
palette_mode   = 1 (procedural harmony)
palette_seed   = base_hue=210°, scheme=analogous, sat=[40,70], light=[20,80]
rng_seed       = 0x7B
mode_flags     = 0b00000101   (hard mode, mirrored controls)
body:
  tilemap  = RLE("....####........########....")
  entities = [(spawn, x=2,y=10,type=player), (coin, x=8,y=6), (goblin, x=14,y=10)]
  hooks:
    on_collide -> [push player.hp; push -1; add; store player.hp; ...]
    on_tick    -> [load timer0; ...]
```

Base64url-encoded and dictionary-compressed, this is expected to land
comfortably in the "standard" size class.

## 12. Dogfood: Flappy Bird

Full worked cart (header, palette, constant pool, entity type table,
sprite/tile bitmaps, and complete per-hook bytecode listing) at
`examples/flappy-bird.md`. Short version: **it fits, easily, even
uncompressed** — around 165 raw bytes, ~220 base64url characters, inside
even the "micro" (≤280 char) size class without needing the preset
dictionary at all. Bit budget was never the risk for a game this small.

What the exercise actually stress-tested, and changed, was the hook/VM
model (§7) and the header (§4–§6):

- **`on_tick` had to split** into a global `on_frame` and a per-entity
  `on_tick(self)` — a single global tick call has no way to iterate a
  dynamic-length entity list without loops/arrays, which the VM
  deliberately doesn't have.
- **`KILL self`** was missing. Nothing else expires an off-screen pipe;
  without it entity count grows without bound.
- **Entities needed generic scratch fields** (`custom0`, `custom1`) —
  "has this pipe already been scored" isn't position, velocity, hp,
  type, or animation frame, and won't be the last thing like it a
  future cart needs. (This ad hoc pair turned out not to generalize —
  the race car dogfood, §13, replaced it with per-type *declared*
  extension fields; see §7.1.)
- **Not every entity is a single sprite blit.** Flappy's pipes have a
  gap-dependent height, so they render as a repeated tile column, not
  a fixed bitmap. This needed a new header segment — an **entity type
  table** mapping each type id to a `render_kind` (sprite / tile-column
  / rect) and an asset index — which cart_type 63 uses directly and
  which the declarative genre templates (§5) could also reference for
  non-uniform entities instead of assuming "entity = sprite" always.
- **A constant pool earns its keep even in a tiny cart.** Gravity,
  flap impulse, and scroll speed are each read every tick; naming them
  once in the header and referencing them by index from bytecode both
  saves bytes past the first use and gives a human one place to retune
  the feel of the game.

One gap surfaced but *not* resolved at the time: per-entity hooks
cleanly expose `self` (`on_tick`) or `a`/`b` (`on_collide`), but scoring
in `flappy-bird.md` needed a pipe to read the *bird's* `pos_x`, i.e. a
property off an entity that is neither. The example leaned on a global
entity-id handle (`g_player`) and an implied "read a prop off an
arbitrary entity by id" addressing mode that §7 didn't define yet. The
race car dogfood (§13) hit the same wall from a different angle and
hard-confirmed it — it's now `LOADE`/`STOREE` in §7, not an open
question.

## 13. Dogfood: Race Car

Full worked cart (header, procedural palette, constant pool, a track
piece grammar, per-type declared entity fields, sprite/tile bitmaps, and
representative per-hook bytecode) at `examples/race-car.md`. Where
Flappy Bird broke every genre template and needed the generic/raw
escape hatch, this one deliberately targets the declarative **Racer**
template (`cart_type = 2`) to see whether a real genre template holds
up — and stresses a different part of the format: continuous
physics/heading instead of grid-ish entities, terrain-based collision
via `GETTILE`, and AI opponents.

It comes in around ~305 raw bytes (~405 base64url chars) — about 1.8×
Flappy Bird, still comfortably inside "standard" (§2), nowhere near
"full." The increase is almost entirely **bytecode**: the track grammar
(8 bytes for a full lap) and the procedural palette (3 bytes) stayed
cheap exactly as the generate-don't-store thesis predicted; it was
continuous physics, AI steering, and position-ranking logic that cost
bytes. In both dogfoods so far, bytecode — not graphics, not level data
— has been the dominant size contributor once assets are generative.
That reframes a design priority from §1: **VM opcode density matters
more than asset/level compression** for whether a small game fits its
size class, once generation is doing its job on the data side.

Changes folded back into the spec (§4, §6, §7):

- **`LOADE`/`STOREE`** (arbitrary-entity property access) — promoted
  from Flappy's open question to a real opcode; `on_frame` has no
  bound entity at all, and ranking three cars' progress needs it.
- **Declared per-type extension fields** replace Flappy's fixed
  `custom0`/`custom1` — a car needs five named fields at once, a
  particle needs one; a fixed generic count can't fit both without
  waste or a future overflow. Now part of the entity type table (§7.1).
- **`SIN`/`COS`/`ATAN2`** via a shared runtime lookup table — needed the
  moment anything has a heading (steering, aiming). Paid for once in
  the runtime, free per cart.
- **Sprite `rotate_by`** — a render-kind option that rotates one stored
  bitmap by an entity's heading at draw time, riding on the same trig
  table, instead of a cart having to store several pre-rotated frames.
- **Level-derived query tables** (`GET_CHECKPOINT idx`) — a track's
  piece grammar produces checkpoint positions the runtime computes once
  at load and bytecode queries by index. This is a third data-access
  kind (alongside entity properties and `GETTILE`) that the format
  hadn't named before; see open questions below on whether it should
  generalize.

New open questions this run raised, beyond what Flappy already left:

- **Is `GET_CHECKPOINT` special-cased, or does the format need a
  general "named level-data table" mechanism** other generators
  (dungeon waypoints, arena spawn rings) could also populate and query?
- **Who validates that an authored track-piece sequence closes the
  loop** (net rotation ±360°, ends where it started)? The authoring
  tool, a runtime check at load, or is an open/non-looping point-to-point
  track a legitimate track too?
- **Named entity handles (`g_car_player`, `g_car_ai1`, `g_car_ai2`) work
  for three cars set up once in `on_init`. How far does that scale** —
  an 8-car race, or a genre with a variable and possibly large number of
  same-type entities — before it needs a real collection/iteration
  primitive instead of one global per entity?
- **Should position-ranking be a genre-specific runtime built-in**
  (racers very generally need "rank N entities by a progress scalar")
  rather than something every racer cart hand-rolls in `on_frame`? More
  broadly: how much genre-specific "standard library" should the VM
  offer per `cart_type`, versus staying fully generic and letting every
  cart re-derive common patterns?
- **`button_mask` is inherently digital.** That's a fine, arcade-honest
  constraint for a top-down racer, but is there ever a case for analog
  input (steering feel, trigger pressure) the envelope doesn't have
  room for today?
- **How big should the shared trig table be**, and is its cost (living
  once in the runtime, not per cart) actually negligible, or does a
  256-entry sin/cos/atan2 set start to matter next to everything else
  the runtime has to ship?

## 14. Runtime dogfood: from genre-switch to composable generators

The V0 runtime (`v0/urlcade.html`) itself became a dogfood subject once it
existed. Playing both carts side by side turned up a real regression: the
implementation had quietly drifted into exactly the anti-pattern this spec
argues against everywhere else. Worth stating plainly rather than papering
over, since it's a sharper version of a mistake the spec should make
structurally hard to repeat.

**What went wrong.** Three places in the runtime branched on cart identity
or `cart_type` to decide how to present a cart, instead of reading that
from the cart itself:

- The on-screen touch-control layout was a lookup table **keyed by the
  cart's literal name** (`flappy` → a flap button, `racer` → a steering
  pad) — not even genre-level, tied to specific titles.
- The HUD text was branched on `cart_type`, and then read specific global
  indices (`g_score`, `g_car_player`) that were authoring-time constants
  for *those two particular carts*. A third cart with a different global
  layout would either render garbage or need a third hardcoded branch.
- The backdrop (sky-blue fill + green ground strip) was hardcoded for
  *any* `cart_type = 63` cart — the one type that's explicitly supposed to
  carry zero genre assumptions ended up with Flappy Bird's look baked into
  the "no assumptions" escape hatch.

**The fix, generalized.** `cart_type` is demoted to advisory/display
metadata — a label a menu can show, nothing a runtime may switch on.
Presentation and control surfaces that used to be genre-branches in host
code become **generators**: small, independent, cart-declared slots the
runtime interprets the same way for every cart, regardless of genre or
identity. This is the same move the entity type table already made for
rendering (`render_kind` is a cart-assigned enum, not a host special case)
— applied everywhere else the implementation had quietly skipped it.

| Generator | Selected by | Runtime does |
|---|---|---|
| **Palette** (§6) | `palette_mode` + params | generates the color ramp, already fully generic |
| **Backdrop** | fill color index + optional ground-strip height/color, both palette indices | fills the frame solid whenever no map generator has produced a tilemap; a universal default, not genre-specific at all |
| **HUD** | an ordered list of declared readout lines, each a `(label, value-source, ±delta, optional "/ constant" suffix, clamp)` tuple, or a flag line shown only while its source is non-zero | renders "label: value" (or the flag text) for each line — the same interpreter for a reflex game's score or a racer's lap counter |
| **Input layout** | a bitmask of which of the 5 fixed button bits (`left/right/up/down/action`) the cart actually reads, plus a touch-*shape* id (none / single-button / steer+action / full d-pad+action) and a short label per active button | builds the on-screen touch controls and the keyboard-hint text from the same declaration — a UI *shape*, not a per-title layout |
| **Map** | a `map_generator` id (`0` = none, `1` = track-piece grammar, `2` = cellular-automata caves, `3` = linear platform grammar — see §15 — future ids reserved) + that generator's own parameter block | populates the shared tilemap the generic renderer and `GETTILE`/`SETTILE` already know how to read |
| **Camera** | a global handle for the entity to follow + clamp bounds | offsets all tile/entity drawing by the computed camera position — added by the platformer dogfood, §15; the first genuinely *new* engine surface this table has needed since the pivot, versus a data-driven version of something already built |
| **Entity types** (§7.1) | per-type `render_kind` + declared extension fields | unchanged, already generic |

**The principle this settles**, answering the standing "genre modality"
question directly: genre-specific complexity is legitimate **only inside a
generator's own algorithm** — a track-grammar interpreter, a future WFC
dungeon generator, each encoding real domain knowledge that's expensive to
re-derive per cart. It is never legitimate in code that decides how to
*display, control, or narrate* a cart based on its type or identity. A
racer isn't "`cart_type = 2`"; it's a cart that happens to compose the
track-grammar map generator with a `CAR` entity type and steer+action
input — and nothing stops a different genre from reusing the same map
generator for its own loop-shaped level, or a cart from combining
generators no existing "genre" has used together yet.

New open questions this raised, folded into §21 below:

- Does the backdrop's "no tilemap → solid fill" rule need a richer
  fallback once a map generator's grid doesn't fill the whole frame (e.g.
  margins around a non-rectangular level)?
- The HUD line format (numeric + delta + clamp + suffix, or flag-if-
  nonzero) covered both dogfood carts. Does a genuinely different genre
  (a countdown timer, a percentage, a multi-entity leaderboard) need a
  richer declared format, or a small expression mechanism instead of
  fixed fields?
- Input layout is still a fixed bitmask over 5 digital bits. Does a
  future generator ever need a declared analog axis, and would that be a
  sixth "input generator," or a variant of this one?
- Should map generators be able to **compose** (e.g., a WFC dungeon
  generator producing rooms, then a corridor generator connecting them),
  and if so, does that argue for a generator *pipeline* rather than a
  single selected id?
- `cart_type` still exists purely as a label. Is that worth keeping at
  all, or does it invite exactly the regression this section just
  documented — a future implementation "just checking cart_type" once,
  for something that feels harmless?

## 15. Three more dogfoods: roguelike, platformer, arena shooter

Full write-up at `examples/three-more-carts.md`. Design-level for all
three at first pass, same as Flappy Bird and the race car started; the
roguelike and the platformer have since been promoted to real, playable
carts in `v0/urlcade.html` (see §15.1 and §15.2) — the arena shooter
remains design-level, a deliberate scope cut rather than an oversight.
The three were picked specifically to pressure-test what §14's
composable-generator pivot left thin: a genuinely different **map
generator** archetype, whether "generator" needs to keep growing new
primitives or whether the existing ones already generalize, and one
concrete new presentation concept.

- **Roguelike (cave crawler)** validated a second map-generator
  archetype — cellular-automata cave generation (`map_generator = 2`),
  stochastic rather than the track grammar's deterministic
  turtle-interpreted tokens — and found that grid-locked, move-one-tile-
  per-press input needs **no new opcode**, just an edge-detection
  authoring idiom (store last frame's `LOAD_INPUT` in a global, compare).
  It did find one honest gap: nothing could mutate the tilemap at
  runtime, so `SETTILE` (§7) fills in `GETTILE`'s missing write half.
- **Platformer (run and jump)** found the first real gap since the
  composable-generator pivot that isn't just "make existing behavior
  data-driven": solid tiles that actually block movement (unlike the
  racer's friction-only "soft" tiles) are expensive enough to hand-roll
  per cart to justify a dedicated opcode, `MOVE_SOLID` (§7). It also
  needed a **camera** — a level wider than one screen has no other way
  to render — added as a fourth composable concept in §14's table,
  genuinely new engine surface rather than a data-driven version of
  something already built. Its map needs (open path, elevation changes)
  don't fit the track grammar's closed-loop assumption, so a third map
  generator id was proposed (`map_generator = 3`); §15.2 resolves the
  "is it actually the same generator as #1" question this raised, once
  it was built for real instead of guessed at from the design alone.
- **Arena shooter (wave survival)** found the opposite of a gap twice
  over: wave-based enemy spawning is just Flappy's pipe-spawn countdown
  idiom (§12) with two more globals, and projectiles are structurally
  identical to the racer's collision particles. No "wave generator" or
  "projectile" primitive earns its keep — confirmation, not a finding
  that demanded a fix.

**The ratio matters more than any single line item.** Three very
different genres surfaced exactly two real primitive gaps
(`SETTILE`, `MOVE_SOLID`), one real new composable concept (camera), and
three separate confirmations that already-generic machinery (edge
detection via existing opcodes, the countdown-spawn idiom, the entity
system's genericity for projectiles, universal `hp` for damage) covered
more ground than expected going in. That's evidence the composable-
generator model (§14) is closer to done than to half-built — most of
what a new genre needs turns out to already be there.

New open questions this raised (the first is since resolved — see §15.2):

- ~~Are `map_generator` ids 1 (loop) and 3 (linear path, proposed)
  actually one generator with a topology flag, not two?~~ Resolved by
  building #3 for real: no, kept separate — see §15.2.
- Fog of war (roguelike) has no answer yet — a per-tile visibility state,
  and either a runtime-computed radius or cart-maintained visibility
  bytecode. Deferred deliberately rather than resolved in haste.
- `MOVE_SOLID` bundles a lot into one opcode (both axes, both directions,
  position snap *and* velocity zeroing). Is that the right grain, or
  should it decompose into smaller primitives a cart composes itself —
  the same tension `GETTILE`+`TILE_SURFACE` resolved one way and this
  resolves the other?
- Camera is the first genuinely new composable concept added after the
  §14 pivot. Is it the last one a 2D console needs, or should more
  genres be dogfooded before assuming backdrop/HUD/input/map/camera is
  a complete set?

### 15.1 From design doc to real cart: building Cave Crawler

Turning the roguelike from a design-level dogfood into an actual
playable cart (`registerCart('roguelike', ...)` in `v0/urlcade.html`)
surfaced findings beyond what the paper design predicted:

- **A latent runtime bug the roguelike would have tripped over.**
  `tileSurface` (the function backing the `TILE_SURFACE` opcode) was
  hardcoded in the runtime to special-case one specific tile id
  (`TILE_STARTLINE → TILE_ROAD`) for the racer, unconditionally, for
  *any* cart. The roguelike's own tile id 4 means GOLD, not "drives like
  road" — the exact scenario §14's "no genre-specific logic in shared
  runtime code" rule exists to prevent, and it had quietly regressed.
  Fixed by making the remap cart-declared data
  (`cart.tileSurfaceOverrides`, a sparse tile-id → surface-id map,
  round-tripped through the binary format) with identity as the
  default; the racer now declares its own `{4: 2}` override instead of
  the runtime assuming it for every cart. Found and fixed *before* it
  could corrupt anything, precisely because building a second
  tile-based cart is what exposed the assumption.
- **Deferred-kill combat, confirmed by driving it directly.** The design
  doc predicted "`on_collide` can't `KILL_SELF` on `a`/`b`, so let each
  monster's own `on_tick` check `hp ≤ 0` and kill itself" would work with
  no new opcode. Testing it for real (force a monster to 1 hp, run one
  `on_collide` pass, assert it's *still* in `world.entities`, run one
  more `world.step()`, assert it's now gone) confirmed the timing
  exactly as designed — a monster survives the tick its hp goes
  non-positive and dies on its own next tick, never mid-collision-scan.
- **Spawning a fixed batch of monsters at `on_init` needed nothing new
  either.** Not called out in the design doc (which only anticipated
  the per-frame countdown idiom from §12), a plain `JMP`-based counting
  loop — increment a global, compare against a `NUM_MONSTERS` constant,
  `JNZ` back to the loop head — spawns N entities at level-generation
  time with the same opcodes already used for AI and movement. The same
  loop-with-early-`JNZ` shape doubles as **rejection sampling**: pick a
  random tile, `GETTILE`, retry on a wall, proceed on floor — placing
  monsters only on generated floor tiles without any dedicated "find a
  valid spawn point" primitive.
- **`GET_CHECKPOINT` generalized to "generator waypoints," not just
  racing checkpoints, exactly as hoped.** The cave generator's start and
  stairs-down positions are stored as `checkpoints[0]`/`checkpoints[1]`
  and read with the same opcode the racer uses for lap checkpoints — no
  new "get spawn point" or "get level exit" primitive needed. The
  generic name earns its keep.
- **A second, unrelated hardcoded-wording bug found by looking at the
  actual rendered page**, not by reasoning about the spec: the menu's
  `describeControls()` hint text special-cased "both left and right
  bits active" to always print "steer" — true for the racer, silently
  wrong for the roguelike's cardinal-direction movement (which also uses
  those two bits). Same class of bug as the `tileSurface` one — a
  supposedly generic, data-driven piece of the runtime actually assuming
  one genre — caught the same way: build a second cart that exercises
  the same code path differently, and it stops being invisible. Fixed by
  always deriving the hint from the cart's own declared button labels,
  no merged special case.
- **A new touch-control shape, but not a new opcode:**
  `TOUCH_TEMPLATE_DPAD_ONLY` (four directional buttons, no action
  button) joins the existing library alongside `SINGLE`,
  `STEER_ACTION`, and `DPAD_ACTION` — confirming touch templates are a
  small, growable *library* of shapes rather than something that needs
  per-cart custom layout.
- **Gold pickup validated `SETTILE` end-to-end**, including the part the
  design doc could only predict: the runtime's pre-rendered tilemap
  optimization (§14, one draw call instead of one per tile) had to
  support single-tile patch-in-place mutation without falling back to
  full re-render, and it does, in both the WebGL and Canvas2D backends.

Net effect: building a real cart from a paper dogfood found two runtime
bugs (both the same *species* — genre assumptions leaking into
allegedly generic code, invisible until a second genre exercised the
same path) and zero new opcodes beyond the one (`SETTILE`) the design
doc already called out. That's a stronger validation of the
composable-generator model than the paper dogfood alone could give:
paper dogfooding checks whether a design *reads* as sufficient; actually
building the cart checks whether the *existing implementation* really
was as generic as it claimed.

### 15.2 From design doc to real cart: building Run & Jump

Turning the platformer from a design-level dogfood into a real cart
(`registerCart('platformer', ...)`) meant actually implementing both
things §15 flagged as genuine gaps — `MOVE_SOLID` and camera — rather
than just naming them. Building them settled questions the design doc
could only pose:

- **`MOVE_SOLID`'s exact contract.** The design doc described the shape
  ("moves self against the tilemap one axis at a time... resolving
  position and zeroing blocked velocity") but not the mechanism. Built
  as: resolve X first, then Y, each axis probing the leading edge (in
  the direction of travel) at two points spanning the box's extent on
  the *other* axis, inset 1px to avoid a false hit from the diagonally
  adjacent tile. Solidity itself reuses `TILE_SURFACE` — no new
  cart-declared field: `tileSurface(tile) !== 0` means solid, so the
  platformer's tile bank needs exactly one override (`{AIR: 0}`) with
  every other tile id defaulting to identity (nonzero = solid). This
  wasn't the plan going in — `tileSurfaceOverrides` was built as a bug
  fix for the racer's startline (§15.1) — but it turned out to be
  exactly the right generic mechanism for "which tiles are solid" too,
  a second, unplanned use that's a stronger validation of the mechanism
  than either use alone.
- **The camera confirmed itself as a genuinely different kind of
  addition than `SETTILE` or `MOVE_SOLID`.** Those two are opcodes a
  cart's own bytecode calls; the camera is instead a cart-*declared*
  value (`followGlobal` + clamp bounds, round-tripped through the binary
  format exactly like backdrop/HUD/input already are) that the *runtime*
  reads on every render, unconditionally, with no bytecode involvement
  at all. It slots into the same "generator" family as backdrop/HUD/
  input-layout/map-generator (§14) rather than the opcode family — the
  fourth composable concept, confirmed by turning out to need the exact
  same shape (cart declares data, runtime interprets it generically) as
  the first three.
- **The `map_generator` unification question, resolved by building #3
  instead of guessing from two data points.** Both the racer's grammar
  and the platformer's are turtle-interpreted token streams that emit a
  tile grid plus a checkpoint list — genuinely the same *category*. But
  the racer stamps a fixed-width path *perpendicular* to travel at every
  step, while the platformer walks *columns* maintaining a running
  ground height with tokens (`STEP_UP`/`STEP_DOWN`/`GAP`) that only mean
  anything for a heightmap and have no notion of turning at all. A
  "topology flag" would have to switch between two structurally
  different stamping algorithms internally — that's not a flag, that's
  two generators sharing a wrapper. Kept as separate ids (`map_generator`
  1 and 3). The open question is answered, not by philosophy, but by the
  fact that trying to write the unified version would have been more
  code, not less.
- **A new authoring idiom, not a new opcode: variable-operand tokens.**
  The platformer's token stream needed marker tokens with no operand
  (`COIN`, `ENEMY` — like the racer's `CHECKPOINT`) alongside tokens that
  need a width (`FLAT`, `STEP_UP`, `STEP_DOWN`, `GAP`, `BLOCK`). Solved
  the same way the VM's own opcode table solves "some instructions take
  operands, some don't": a small per-token-id lookup the parser consults
  as it walks the stream, mirroring `OPS`'s per-opcode operand specs.
  Found one real authoring bug this way, worth naming: computing
  `NUM_COINS`/`NUM_ENEMIES` via a naive `tokens.filter(t => t === COIN)`
  is wrong, because width *values* share the same small-integer space as
  marker token *ids* (this level's own `GAP,5` and `BLOCK,6` collide
  with `COIN`(5) and `ENEMY`(6)) — caught by the test suite (checkpoint
  count didn't match spawned entity count), fixed by reading the counts
  off the generator's own position-aware walk instead of re-deriving them
  naively. A reminder that "small integer stream with mixed fixed/
  variable-operand tokens" is a real parsing problem even at this scale,
  not just bytecode's problem.
- **Gravity, jump, patrol AI, and coin pickup all confirmed needing
  nothing new**, same pattern as the roguelike: jump is gated by an
  ordinary `GETTILE`+`TILE_SURFACE` probe just below the feet (no
  "am I grounded" flag from `MOVE_SOLID` itself — the cart derives it
  from the same primitive it already had); patrol enemies flip direction
  via the same probe pattern applied ahead-and-below (ledge detection)
  or by noticing `MOVE_SOLID` zeroed their velocity (wall detection);
  coin pickup reuses the roguelike's deferred-kill idiom verbatim
  (`on_collide` can't despawn `a`/`b`, so it zeroes hp and the coin's own
  `on_tick` checks and kills itself) — now confirmed twice, in two
  unrelated carts, as the general answer to "how does on_collide ever
  remove an entity."
- **Terminal velocity needed nothing new either** — `CLAMP_ABS`, already
  in the opcode table for the racer's AI steering (§13), clamps
  accumulating fall speed just as well as it clamps a turn rate. A third
  confirmation (alongside `GET_CHECKPOINT` and `TILE_SURFACE`) that a
  handful of these opcodes are more general-purpose than the genre they
  were first written for.

Two real engine additions this round (`MOVE_SOLID`, camera — both
predicted by the paper dogfood), one design question resolved by
building rather than debating, one real authoring bug caught by the test
suite, and four more confirmations that the existing primitive set
covers new genres without growing. Combined with §15.1's roguelike
findings, four of five genres dogfooded so far (Flappy, racer,
roguelike, platformer) needed at most one or two real primitive
additions each, and every addition has so far been exactly the kind the
paper dogfood predicted before any code was written — the design-level
pass is earning its keep as a genuine predictor, not just a formality
before implementation.

## 17. Sprite art: from raw pixels, through a painter function, to a generator

Sprites went through three designs in quick succession, each one a real
finding, not a false start — worth recording the sequence because the
end state (§17.3) only became obvious by building the two that came
before it.

### 17.1 Raw pixel indices, hand-typed as hex rows

The original format: each sprite is `w*h` bytes, one palette index per
pixel, authored as hand-typed hex-digit strings (`'01222110'`) and
shipped byte-for-byte in the cart. Fully general — any silhouette is
expressible — and honestly, exactly what a "URL-encoded virtual console"
should ship: the cart contains the actual pixels, nothing is
reconstructed from code outside the URL. The failure mode wasn't
architectural, it was practical: enlarging a sprite by nearest-neighbor-
scaling the hex grid (each pixel duplicated into a flat block) produced
sprites that were bigger but visibly just blown-up thumbnails — reported
plainly as "too much blockiness, it's like it's just scaled up."

### 17.2 A hand-written painter function per sprite

The fix for blockiness was real geometry: each sprite got a small JS
function (`paintBird(x,y)`, `paintCar(x,y)`, ...) computing a palette
index per pixel from ellipse-distance math, called once at cart-authoring
time to produce the same flat pixel array §17.1 used. This fixed the
actual visual complaint — genuinely smooth, non-blocky edges — but traded
it for a different, sharper problem: **the sprite's shape now lived in a
JS function that ships with the runtime, not in the cart.** The encoded
payload still contained the resulting pixel grid (verified directly: with
every painter function deleted from the page, a cart decoded from raw
bytes alone still rendered correctly), so nothing about *playing* a
shared link was actually broken. But it was a real regression against
every other piece of this system's own design: palette generation, the
map generators, HUD spec, camera — all of them are "cart declares small
parameters, runtime holds the shared generator." Sprites, suddenly,
weren't; they baked a one-time function's *output* into the cart instead
of shipping the *generator* as a runtime-interpreted, cart-declared thing.
Called out directly: "doesn't this get away from the intent of URL
encoding games? These are hand-written functions?" — a fair hit, even
though the URL-self-containment property itself never actually broke.

There was a second problem, independent of the first: the ellipse-math
control flow (nested conditionals, ordering-dependent branches deciding
eye-vs-body-vs-outline) was hard to read. Not because procedural
generation is inherently illegible, but because *imperative branching
code* is a bad medium for "here's what a sprite looks like" even when the
underlying math (distance from an ellipse boundary) is one line.

### 17.3 A cart-declared shape list, runtime-interpreted

The actual fix resolves both problems with one change: a sprite is either
raw pixels (kind 0, §17.1's format, kept as a fully-general escape hatch)
or a small **ordered list of primitive shapes** (kind 1) — `{type:
ELLIPSE, cx, cy, rx, ry, color}` or `{type: RECT, x, y, w, h, color}`,
~6 bytes each, drawn back-to-front. `renderShapeList(w, h, shapes)` is a
genuine runtime generator: it runs once per sprite *at cart load time*,
from the decoded cart's own `shapes` array, exactly parallel to how
`buildCave`/`buildTrack` run once per world from the decoded `cart.cave`/
`cart.track`. The list itself is what's declared on the cart and encoded
into the URL — plain data, not a reference to any function — so a human
reading `[ellipse(8,8,6,5,body), rect(8,5,3,5,glass), ...]` can picture
the sprite directly, no execution required, and the "hand-written
function" objection dissolves: the generator lives in the runtime (like
every other generator here), the cart supplies parameters (like every
other cart-declared thing here).

Only two primitive types, deliberately. Auditing every sprite actually
built across all four carts — a bird, a race car, a collision-debris
particle, two humanoid blobs (roguelike player, platformer player), two
eyed-monster blobs (roguelike monster, platformer enemy), a coin — found
every one decomposes into 3-8 ellipses/rects. That's a real signal, not
an assumption: 16x16 pixel art in this console's blobby arcade style
doesn't need more shape vocabulary than that. The one deliberate
compromise this made concrete: the bird's beak was a sharp wedge (a third
primitive, tip+base+halfwidth) in §17.2's painter; without a WEDGE
primitive it's a stubby ellipse instead. Kept the vocabulary at two
rather than add a primitive for one sprite's one feature — a wedge
primitive is one more thing every reader of a shape list has to learn,
for a silhouette difference that reads as "rounder beak," not "wrong."

Concrete result, measured (not estimated) across all four carts: sprite
data shrank 20-37% of total cart bytes depending on the cart (most on
the platformer, which has three sprites; least on the racer, whose car
has the most shapes). Verified two ways: an exact round-trip test
(decode → re-encode → decode, shape-for-shape equality within
fixed-point precision) and — the same test applied to §17.2's claim —
confirming the runtime never touches `renderShapeList`'s *callers*: only
the shared interpreter and the cart's own declared shape list are needed
to reconstruct pixels from a raw decoded cart, with every authoring-time
helper deleted from the page first.

A small amount of authoring-time sugar remains: `blobPlayerShapes(body,
outline)` and `blobMonsterShapes(body, outline, eye, pupil)` are plain
functions that return a shape-list array, used by both carts that want
that silhouette family. This is meaningfully different from §17.2's
painter functions — they return *data* (an array of shape records with
numeric literals), not a per-pixel computation, and the encoded cart gets
that resulting array either way, never a reference to the function. It's
the same relationship `buildRacerCart()` already has to `buildTrack()`:
authoring-time JS that produces the cart's declared parameters, not
runtime logic the player depends on. Named as an explicit open question
below whether this is worth promoting further, into a true
runtime-selectable `sprite_generator` id (a small library of named
archetypes, the same shape as `map_generator`) rather than
authoring-time-only sugar.

## 18. Square viewports, and making the other three carts actually fun

Flappy Bird had always been the cart that got attention — the other three
(racer, roguelike, platformer) shipped functionally correct but, once
actually played instead of just tested, thin: the racer's track fit
entirely on one screen with no camera ("a tiny donut"), the roguelike's
cave was one small flat room with monsters that barely moved, and the
platformer was short with floaty, single-curve jump physics. This pass
made all three genuinely more playable, and forced every cart's viewport
to a square 160×160 — WASM-4's own convention, chosen here for the same
reasons: it fits consistently under both portrait and landscape device
aspect ratios without letterboxing math per cart, and it leaves predictable
room for touch buttons/HUD outside the play area instead of every cart
negotiating its own layout.

### 18.1 Camera as a fourth composable generator

The square viewport is smaller than any of these carts' actual world, so
none of them can just render everything at once anymore — they all needed
scrolling. Rather than build per-cart camera logic, this added `camera` as
a cart-declared parameter block (`followGlobal`, `clampMin/MaxX/Y`) next to
palette/backdrop/HUD/map_generator: the cart names which global holds the
entity id to follow and the world-space bounds to clamp within, and the
runtime's `updateCamera()` does the rest every frame — interpolated
follow position, centered in the viewport, clamped to the declared box,
subtracted from every draw call. Carts that don't need scrolling (nothing
here — even the roguelike's cave now exceeds one screen) get a default
`{followGlobal:255, ...}` synthesized by `encodeCart`, matching the
project's running pattern: the cart supplies a handful of numbers, the
runtime supplies the shared machinery.

### 18.2 Racer: a track that actually needs a camera

The original 32×20-tile oval fit entirely inside one un-scrolled screen —
literally a small donut, no matter how the car moved. The fix was a
bigger, more interesting loop: a 80×65 grid with a "double chicane" pattern
(turn off the main heading, jog sideways, turn back) used symmetrically on
opposite sides of the rectangle, plus real checkpoints spaced around it.

Getting the turn/straight token counts right by hand turned out to be
genuinely error-prone — a first attempt used the full chicane pattern on
one side and a shortened variant on the other, and the track didn't close
(off by exactly one segment length). Rather than debug that by staring at
turn-count arithmetic, a standalone script (`track_sim.js`) reimplements
just the turtle-walk position/heading math from `buildTrack()` — no tile
stamping, just "where does the pen end up" — so candidate token sequences
can be verified to close into a loop *before* being committed to the cart.
Using the identical chicane pattern on both opposite sides closed exactly.
This is the same "measure, don't guess" instinct that shows up elsewhere
in this project (byte-count claims, cave floor ratios below) applied to
geometry instead of statistics.

### 18.3 Roguelike: a bigger cave, and a monster-AI bug two layers deep

**The cave.** The original 32×20 cave, like the racer's track, fit on one
un-scrolled screen — "one flat map." Scaling the same cellular-automata
generator up to 64×64 with unchanged parameters shifted the floor/wall
equilibrium hard: the border-forced-solid ring is always exactly one tile
thick, so it's a much smaller fraction of a bigger grid, and dilutes its
wall-injecting effect on the interior CA dynamics less. The same
`fillProb`/`wallThreshold` that gave 58–75% floor at the old size gave
83–88% at 64×64. Compensating by raising `fillProb` worked only up to a
sharp collapse cliff — past a threshold, some seeds randomly degenerated
to near-all-wall caves instead of scaling smoothly. Settling on a more
modest 48×36 grid and sweeping `fillProb` across 40–150 seeds at a time
(not eyeballing one map) found a collapse-free band; since the cart uses
one fixed `rngSeed` rather than a random one per play, the real requirement
was "this one seed is good," not "every seed is good," so the shipped
values (`fillProb:122`, seed 11) were chosen well inside the stable region
and specifically verified for that seed (0 unreachable floor tiles, full
gold placement, stairs reachable).

**The monster freeze.** Fixing "enemies don't move" took two passes. The
intended fix — a retry loop letting a monster try a few random directions
before giving up on a blocked move instead of freezing until the next full
`MOVE_INTERVAL` — made things *worse*: all 18 monsters were completely
frozen, never moving once across a 30-second test. The retry logic itself
was correct on inspection; the actual bug was one layer underneath it, in
code this pass never touched. A monster's move-timer prop starts at `0` on
spawn, and the countdown was `timer -= 1; if(timer != 0) skip-this-tick`.
Decrementing from 0 goes straight to −1 and keeps going negative forever —
the counter never lands on exactly 0 again, so the "time to move" branch
never fires, ever, for the lifetime of the entity. This predates this
session entirely; the retry-loop work just happened to be the first test
rigorous enough (tracking distinct tiles visited per monster over real
time, not just "did a crash happen") to expose it. The fix generalizes the
trigger condition from "equals zero" to "at or below zero" (`timer > 0` ?
skip : move), which is self-correcting regardless of the counter's
starting value, and the spawn-time counter is now randomized within
`[0, MOVE_INTERVAL)` as a small bonus so monsters don't all step in
lockstep. Two lessons: a fix can look completely correct in isolation and
still fail if the bug is somewhere the fix's own code never runs through
(the retry loop only executes *after* the timer reaches 0 — which it
never did), and "monsters move occasionally" had apparently never actually
been measured before, only assumed.

### 18.4 Platformer: jump feel, a longer level, and two more "never actually measured" bugs

**Jump feel.** "Clunky, not curved" wasn't a complaint about the physics
model — gravity integration already produces a real parabola — it was
about the *response curve*: one fixed gravity in both directions and a
jump velocity that's identical whether the button is tapped or held. The
fix is the standard platformer trick, not a new primitive: gravity is
heavier once the entity is falling (`vel_y >= 0`) than while it's rising,
for a soft rise and a snappy, decisive fall instead of a lazy symmetric
arc; and releasing the jump button while still rising truncates `vel_y`
toward zero (`JUMP_CUT_MULT`), so a tap gives a short hop and a hold gives
the full arc — variable jump height instead of one fixed height every
time. Measured directly: a 3-tick tap now rises ~21px versus ~52px for a
held jump, a clear, controllable difference.

**The level.** Roughly doubled in length and token variety (more
step/gap/block combinations, more coins and enemies) so the new square,
narrower viewport still has enough road ahead of the camera to feel like a
real level rather than one lucky screen's worth of content.

**Two more latent generator bugs, found by finally brute-force-walking the
whole level instead of spot-checking a few ticks.** A static "does the
whole level actually work" sweep — checking every column for *some*
reachable solid tile, and every adjacent-column pair for a step no jump
could climb — caught two bugs in `buildPlatformLevel` that had shipped
with the original, shorter level and simply never been exercised by prior
testing:
- `BLOCK` tokens (the floating brick obstacle) only ever wrote the brick
  tile itself; they never called the same `fillColumn` every other span
  uses to lay a normal floor underneath. Every `BLOCK` was secretly a
  bottomless pit with a decoration floating over it — one extra
  `fillColumn` call before placing the brick fixes it to be what it reads
  as: an overhead obstacle above ordinary ground, matching how `GAP`
  already documents "missing a jump costs distance, not a run."
- `GAP`'s safety-net floor was pinned to the grid's absolute bottom row
  regardless of the *current* ground height. That's fine when the ground
  is already low, but with `groundY` pushed up by consecutive `STEP_UP`s
  (this cart's minimum is row 8 of 20), a gap there created a pit deeper
  than a jump's apex height (~7 tiles) — falling in was permanent, exactly
  the "costs a run" outcome the design comment says it isn't supposed to
  be. The fix anchors the safety net a fixed, always-climbable distance
  below the *current* groundY instead of an absolute row, so pit depth no
  longer depends on how high up the surrounding terrain happens to be.

Both were caught by the same discipline used for the cave and the track:
don't trust a design comment's stated invariant ("no death, ever") until
something has actually swept the generated output and checked it against
that claim on every column, not just the ones a hand-written test bot
happened to walk across.

**One deliberate balance change, not a bug fix.** `PLAYER_START_HP` was
`1` in the original cart — fine for a short level with three enemies, but
with the level 2× longer and enemies more than 2× as numerous, a single
touch anywhere ending the run stopped reading as "hard" and started
reading as "unfair." Raised to `3` to match the larger hazard budget.

## 19. Productionizing: a discoverable spec, and a cart Inspector

Two changes aimed at "this is a real, shareable thing now," not new format
capability:

**The spec became a set of discoverable links, not just files in the
repo.** Once the runtime was live on GitHub Pages (see the V0 README's
deployment notes), `DESIGN.md`, the V0 findings doc, and the worked
examples were published alongside it under `/spec/`, plus an `llms.txt`
at the site root — a small, increasingly-common convention for exactly
this: a short, structured index of a site's docs meant to be fetched by
an agent, not rendered by a browser. Both are raw markdown at stable
paths rather than rendered HTML on purpose: the primary audience for
"read the spec" is often something fetching a URL programmatically, and
raw markdown already serves that need with no rendering step in the way.
A plain `spec/index.html` (styled to match the runtime, not a separate
docs-tool look) covers the human-browsing case, and the shelf page links
to it.

**A Cart Inspector — decompiling a cart back into something readable,
not just playable.** The binary format was always designed to be fully
reconstructible from its bytes (every `decodeCart` is exercised on every
`registerCart` call, at load), but "reconstructible" and "inspectable by
a person" aren't the same claim, and nothing on the site had tested the
second one. The Inspector is a third top-level view (alongside the shelf
and the player) that decodes any cart — pasted as a full URL, a bare
fragment, or just the payload, not only the four shipped ones — and tabs
between:

- **Overview** — header fields, camera, input layout, tile-surface
  overrides, HUD spec, and the raw constants array.
- **Palette** — all 16 swatches, generated the same way the runtime
  itself would.
- **Sprites** — each sprite rendered as an image, plus (for shape-list
  sprites) the actual ellipse/rect primitive list as a table.
- **Tiles**, **Map** (generator params + the rendered tilemap), and
  **Entities** (the entity type table).
- **Hooks** — bytecode length, a labeled disassembly listing, and a
  control-flow-graph flowchart, per hook.

The disassembler and CFG extractor are the two pieces of new machinery,
and both are deliberately generic — they operate on raw bytecode plus the
shared `OPS` table, with zero dependence on any cart's own symbol names
(`FLAPPY_SYM`/`RACER_SYM`/etc. are authoring-time-only maps that never
round-trip through the binary format). That's what makes "paste any cart
URL" possible rather than "inspect one of these four hardcoded carts":
the Inspector knows nothing about a cart it's shown that isn't already
recoverable from the bytes themselves.

`disassembleHook` re-runs the VM's own instruction-decode loop (same
`u8`/`i16`/`u16` readers as `runHook`) without executing anything, just
recording each instruction. `buildCFG` splits that stream into basic
blocks — leaders are the entry point, every jump target, and whatever
instruction follows a branch or `HALT` — and reads off edges directly
from each block's last instruction (`JMP` → one edge, `JZ`/`JNZ` → a
taken edge and a fallthrough edge, `HALT` → none, anything else → an
implicit fallthrough). The flat disassembly listing and the flowchart
share this same block split, so `B7:` in one is literally the same box
in the other — one source of truth for "where the labels are," not two
label schemes that could drift apart.

The flowchart itself is hand-rolled SVG, not a pulled-in diagramming
library — consistent with this runtime never taking on a dependency for
its own gameplay code (procedural sprites over an image library, a
hand-written VM over an existing bytecode engine, and so on); an
inspector *of* that code shouldn't be the first exception. It also
sidesteps needing a real graph-layout algorithm: this VM's hooks are
short, mostly-linear programs with occasional branches and small loops,
not sprawling call graphs, so a simple vertical stack in address order —
short straight lines between adjacent blocks, bezier curves bowing right
for forward branches and left for loop-backs — reads as cleanly as a
proper layered-DAG layout would for these program sizes, for a fraction
of the implementation cost. Verified directly against a hand-traced hook
(the roguelike's `on_tick` retry loop, §18.3): the disassembler correctly
reconstructed every instruction including the exact backward `JNZ` that
makes it a loop, and the CFG drew that edge bowing left into the correct
earlier block, both confirmed by rendering it and reading the picture
back, not just checking edge counts.

## 20. Compression: measuring §3's preset-dictionary hypothesis against real carts

§3 argues a preset dictionary should beat generic compression for this
domain because carts share structure a lone file's own compressor never
sees. That was a design-time argument, not a measurement — worth
checking against the four carts that now actually exist, especially
since the V0 README already ships with "no compression" listed as a cut
scope. Ran each cart's raw encoded bytes (before base64url, since that's
what the eventual dictionary compressor would operate on) through
generic gzip, deflate, and brotli at max quality, then compared against
a crude stand-in for the real thing: raw DEFLATE primed with a
dictionary built from the *other three* carts' bytes (never this cart's
own — a fair test of whether cross-cart structure is real, not just
this-file-compresses-itself-well):

| cart | raw fragment (chars) | deflate, no dict | brotli, no dict | deflate + cross-cart dict |
|---|---|---|---|---|
| Flappy Bird | 847 | 516 (−39.1%) | 511 (−39.7%) | 438 (**−48.3%**) |
| Race Car | 1470 | 780 (−46.9%) | 748 (−49.1%) | 738 (**−49.8%**) |
| Cave Crawler | 1734 | 991 (−42.8%) | 912 (−47.4%) | 776 (**−55.2%**) |
| Run & Jump | 1680 | 915 (−45.5%) | 867 (−48.4%) | 712 (**−57.6%**) |

Generic compression alone is already worth roughly 40-49% off the
current uncompressed fragment — carts are small, structured, and
repetitive enough (opcode bytes, entity-type table shapes, HUD-spec
boilerplate) that even brotli's built-in static dictionary helps a lot at
these sizes. But the hypothesis holds specifically: a dictionary built
from *other carts* beats brotli's generic one on every single cart here,
by 4-9 more points, landing around 48-58% total reduction (53.5% overall
across all four). That's the real signal — it isn't just "compression
helps," it's "the cross-cart structure §3 predicted is really there,"
confirmed on genuinely independent bytes rather than a file compressing
against itself.

This is still a rough stand-in, not the shipped design: a real preset
dictionary would be trained on a much larger corpus than four carts (and
the four measured here are *in* that corpus, which flatters the result
somewhat — the honest next test is measuring a cart against a dictionary
trained on carts it had no part in), and §3's own versioning concern
(the dictionary must be pinned to `formatVersion`, or a dictionary update
silently corrupts old links) is unaffected by any of this — it's a
constraint on shipping the feature, not on whether the feature is worth
shipping. But the headline number answers the open question directly:
building the real thing is worth roughly another 5-10 points beyond
what plain gzip/brotli would already buy for free, on top of compression
already being worth doing at all.

## 21. Open questions

**Format & encoding**
- Is base64url-over-custom-binary actually the right density/compat
  tradeoff, or is a larger Unicode alphabet worth the copy/paste risk
  for power users who know what they're doing?
- Should compression be mandatory, or is the `u1` vs `u1r` split (with
  its extra envelope complexity) worth it?
- How do we migrate the preset dictionary over time without either
  freezing it forever or breaking old links? Is "one dictionary per
  format_version, all kept alive in the runtime" sustainable?
- Where's the boundary between "cart data" and "runtime asset library"
  — do sprite/sound libraries need independent versioning from the
  envelope format?
- §17.3's shape-list sprites have authoring-time-only sugar
  (`blobPlayerShapes`/`blobMonsterShapes`) for the two silhouette
  families reused across carts. Worth promoting into a true
  runtime-selectable `sprite_generator` id — a small library of named
  archetypes (`blob_character`, `topdown_vehicle`, ...) the cart selects
  by id plus a handful of color-index params, the same shape as
  `map_generator` — once a few more carts show which archetypes actually
  recur? Four sprites (two players, two monsters) already share two
  families; two data points per family isn't a lot to generalize from.

**VM & hooks**
- How does bytecode read a property off an entity that is neither
  `self` nor `a`/`b`? The Flappy Bird cart (§12) needs a pipe's
  `on_tick` to read the bird's `pos_x` and leans on an unspecified
  "resolve entity-id global, then read a prop off it" addressing mode.
  Is that a named opcode (`LOADE <handle_global>.<prop>`), or does it
  argue for letting hooks take more than one bound entity in cases
  beyond `on_collide`?
- Now that `on_tick` is per-entity and `on_frame` is global (§7,
  amended after §12), is that two-hook split enough, or do other
  genres need a third granularity (e.g. per-entity-*type*, once per
  frame, for "move every pipe as a group" style behavior)?
- Stack machine vs register machine: stack machines compress better
  under generic LZ but register machines are often denser natively —
  has anyone actually benchmarked this for a corpus this small?
- What's the right step-budget number, and should it be fixed forever
  (fairness/determinism for shared replays) or allowed to scale with
  device performance (better perf headroom, worse fairness)?
- Fixed hook entry points only, or do we allow user-defined subroutines
  callable from multiple hooks? How much does that cost in header bits
  for a jump table?
- How many named globals/persistent scratch vars beyond entity
  properties do we actually need, and how many bits do we reserve for
  them up front vs risk running out?
- What does "cart fault" (step-budget exceeded, stack overflow) look
  like to a player — a glitch-aesthetic in-universe event, or an
  out-of-universe error screen?

**Palette & art**
- Does procedural-harmony-only risk every cart "feeling generated" the
  way procedural levels can feel same-y? Do we need artist-curated
  seeds promoted as "featured palettes" to counteract that, the same
  way palette_mode 0 exists?
- Is 16 colors the right ceiling, or does modern-display expectation
  argue for more (at the cost of the nostalgia-console read)?
- Should palette defaults differ by cart_type (mode 2) or should that
  coupling be considered an anti-pattern (genre shouldn't dictate mood)?

**Genre templates**
- How many cart_types ship at v1 before it's "enough" vs scope creep?
  Six is a guess, not a result of anything.
- Who owns adding new cart_types over time — a closed spec, or a
  reserved-id-range registry the community can extend into?
- Does cart_type 63 (fully generic/raw) get used enough in practice to
  justify keeping it, or does it just become a dumping ground that
  fragments the "genre template" idea entirely?

**Procedural generation**
- How do we keep generators (WFC, cellular automata, harmony palette
  math) byte-for-byte stable across runtime versions long-term, given
  that a generator tweak silently changes what old shared URLs render
  into? Do generators need their own version pin the way the VM does?
- Where's the actual line between "burned-in explicit parameters" and
  "generator does more with the same bits" — is that a per-cart_type
  design decision or should it be uniform?

**Multiplayer & replay**
- Async ghost-replay depends on frame-rate-independent, fully
  deterministic simulation — how robust is that in practice across
  real browsers/devices, and what breaks first?
- Is there any real-time multiplayer story worth having, or should the
  spec explicitly say "async/shared-seed only, forever"?
- Leaderboards need *some* server if they're global — out of scope for
  the format itself, but is there a companion API contract worth
  defining so sites that want one aren't inventing it from scratch?

**Tooling & authoring**
- Ship a visual editor at v1, or launch with a text-based
  assembler/compiler only (better for source control / code review of
  carts, worse for onboarding non-programmers)?
- How important is a "cart inspector" / decompiler for trust — should
  the runtime refuse to run a cart without first showing the player
  (or the developer) a human-readable disassembly?

**Safety & governance**
- Beyond step-budget hangs, are there abuse vectors worth constraining
  at the spec level — e.g. a max color-change rate to avoid
  photosensitivity-hazard carts?
- Do we promise old links work forever, and if so, what's the actual
  long-term cost of keeping every historical VM/generator version alive
  in the runtime bundle?
- Is there a spec repo separate from the reference runtime
  implementation, and what keeps the two from drifting apart?
