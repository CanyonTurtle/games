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

New open questions this raised, folded into §16 below:

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

Full write-up at `examples/three-more-carts.md`. Design-level only —
none of the three are wired up as playable carts in `v0/urlcade.html`
(unlike Flappy Bird and the race car); that's a deliberate scope cut,
not an oversight. The three were picked specifically to pressure-test
what §14's composable-generator pivot left thin: a genuinely different
**map generator** archetype, whether "generator" needs to keep growing
new primitives or whether the existing ones already generalize, and one
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
  generator id is proposed (`map_generator = 3`) — while flagging
  plainly that #1 and #3 are structurally similar enough that they might
  want to be one generator with a declared topology flag instead of two
  near-duplicates; left open rather than guessed at from two data points.
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

New open questions this raised:

- Are `map_generator` ids 1 (loop) and 3 (linear path, proposed) actually
  one generator with a topology flag, not two? Two data points (racer,
  platformer) isn't enough to decide confidently.
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

## 16. Open questions

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
