# The Urlcade: a fully URL-encoded virtual console

Status: this started as a draft/strawman and §§1-13 read that way, but a
real V0 runtime now exists and has grown well past what's described here
— five playable carts, a stack-machine VM, five composable generators,
a bytecode Inspector, real DEFLATE compression, and (as of §24) real
per-entity physics. **This document is a running design log, in the
order things were built — it is not guaranteed to match the current
runtime, and where the two disagree, the runtime wins.** For the
literal, current binary format/opcode table/VM, read
[`kernel.js`](https://canyonturtle.github.io/games/spec/kernel.js) (a
verbatim, dependency-free extraction of that part of the runtime, plus
[`fixtures.md`](https://canyonturtle.github.io/games/spec/fixtures.md)
for known-good examples to check against) — not this file. Sections are
numbered and left in place as history even after later sections
supersede them, same as source control: each explicitly says so where
that's happened (§5, §14, §21/§24), rather than being silently edited
out. The "Open Questions" list at the end is real and current, not
performative — the couple of items later sections have actually
answered are struck through, in place, rather than quietly deleted.

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

New open questions this raised, folded into §28 below:

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

## 21. A fifth cart_type: destruction (Slingshot & Castle Crusher)

Two new carts dogfood an Angry Birds / Crush the Castle-style genre:
aim, charge, and fire a projectile at HP-bearing blocks and one-hit
targets. The physics model is a deliberate scope cut, not a rigid-body
simulation — blocks never move under gravity or stack on each other;
they take damage and do a small damped-spring "wobble" back to their
own spawn point, and the only entity with real physics is the launched
PROJECTILE (gravity + `MOVE_SOLID`, exactly like the platformer's
player). Zero new opcodes: even the wobble is a hand-rolled damped
spring (`vel = (vel + (orig_pos - pos)*k) * damping`) using only
existing arithmetic ops, and both carts reuse `buildPlatformLevel` and
`PLATFORM_TOKENS` verbatim — COIN checkpoints become BLOCK spawns, ENEMY
checkpoints become TARGET spawns, checkpoint 0 becomes the launcher
anchor. Aim/power input is digital (hold left/right to sweep angle,
hold fire to charge power, release to launch), matching the existing
"no analog input" scope note — the same trick classic console golf
games use.

Three real bugs found by testing this properly, all before this genre
had a single line of documentation:

**Terrain elevation changes can make content permanently unreachable.**
The first version of both levels used `STEP_UP` to build a "castle
silhouette" with a rise at the entrance. `MOVE_SOLID` blocks horizontal
movement against *any* solid tile in the way, regardless of how tall
the step is — there's no step-assist, unlike a platformer where the
player can jump over a rise. Combined with every shot restarting from
the *same fixed anchor* (no forward progress carries between failed
shots, unlike a real multi-shot artillery game where you might advance),
a single elevation change between the anchor and a block/target can
wall it off from every possible angle/power combination, not just
badly-tuned ones. Caught by sweeping a full angle × power grid (12
angles × 5 charge levels) against a fresh `World` per trial and checking
which blocks/targets were ever actually destroyed: one Slingshot target
and *all four* Castle Crusher targets were unreachable — not "hard to
reach," provably unreachable. Fixed by making both terrains fully flat
(no `STEP_UP`/`STEP_DOWN` at all), with vertical variety coming entirely
from `buildPlatformLevel`'s own fixed COIN/ENEMY placement offsets
instead. Confirmed fixed the same way: re-ran the sweep, zero
unreachable targets in either cart.

**A settled projectile could soft-lock a shot forever.** The original
"is this shot over" check only looked for the projectile going off the
level's bounds. A projectile that lands and rolls to a stop on flat
ground satisfies neither "off bounds" nor any other check that existed
— it would just sit there, never triggering the next shot to spawn,
effectively burning one of a small fixed number of shots permanently.
Fixed with a settle check: grounded (`vel_y` exactly `0`, which only
happens from an actual `MOVE_SOLID` floor collision, not the momentary
zero-crossing at a parabola's true apex) *and* horizontal speed decayed
below a small threshold ends the shot. Caught by literally watching a
shot's own trajectory in a test rather than only checking the final
win/lose state — the first sign was a shot's `x`/`y` printing identically
for 250 straight ticks.

**A lingering touch could delete a block's HP as a non-event.**
`on_collide` fires every tick two entities' boxes overlap, with no
"already handled this contact" memory — fine for a fast-moving hit, but
a slow-rolling projectile can sit inside a single block's hitbox for
dozens of ticks, applying full damage on *every one* of them. A 6-HP
block could be deleted by a graze that happened to be slow, making HP
meaningless and (combined with the flat-terrain fix above, which let a
single rolling shot touch every block in a row) let one shot clear
levels that were supposed to take several. Fixed with a short per-block
hit-cooldown counter (an entity ext field, ticked down every frame,
checked by `on_collide` before applying damage) — the standard
"invincibility frames" idea from action games, applied here to a block
instead of a player.

**One more, purely cosmetic but worth recording because it wasted more
time than the real bugs:** `paletteParams` round-trips through the
binary format as *unsigned* bytes. A first attempt to fix a badly-chosen
accent hue (Slingshot's warm wood terrain paired with `accentOffset:150`
— copied from the platformer without checking — landed the accent ramp
on cyan) used a *negative* offset to reach red. It encoded, decoded, and
rendered a completely different, still-wrong hue (purple), because
`-35` truncates to `221` (`-35 & 0xFF`) on encode and is read back as
`221`, not reconstructed as `-35` — there's no sign bit to reconstruct
from. Signed hue offsets aren't representable in this field at all, not
just inconvenient. The actual fix, once that was understood: pick a
*positive* offset that lands somewhere good directly. From a base hue of
35, the reachable accent range with an unsigned 0-255 offset is exactly
`[35, 290]` — reds below hue 35 are permanently unreachable from that
base hue with this field, full stop. Landed on green (`offset:85`,
accent hue 120) instead, which turned out to fit better anyway (a green
"pig" against brown wood is very on-theme for the genre).

## 22. A sixth composable generator (aim line), and giving the destruction genre real identity

Direct feedback on §21, verbatim: the two carts felt too similar, aiming
had no visual affordance at all ("needs a power and angle line"), and
the "castles" were just squares with nothing special about them. All
three were real gaps, not taste — fixed as follows.

**Aim line — a fifth composable generator, alongside palette/map/HUD/
camera.** Charging a shot previously had zero feedback: no way to see
the current angle or how much power had built up. The fix follows the
same shape as every other generator in this runtime: the cart declares
a small parameter block (`aimLine`: which globals hold the anchor
position, angle, power, an active flag, plus a max-power constant index
and a color/length), and the renderer draws a plain line from that
anchor, in that direction, scaled by power — genuinely generic, with no
per-cart drawing code. Unlike `camera` (always present, defaulting to
"none" via a sentinel), this is properly optional — most carts have no
aiming mechanic at all — so it's gated by a presence byte in the binary
format instead. The one new implementation-level idea: `glDrawColorQuad`
already existed (used for the backdrop's ground-fill rectangle) but
never plumbed through the rotation uniform the shared shader already
supports; adding that one parameter made the line renderer 4 lines of
GL code, not a new draw path. Both renderers use the identical
angle-to-direction formula the destruction genre's own launch-velocity
math uses (`rot = -angleDeg * Math.PI/180`), so the line drawn is
provably the direction a shot fired *right now* would travel, not a
separately-computed approximation that could drift out of sync with it.

*A testing note worth recording:* the very first version of this looked
completely broken in every screenshot — until forcing a synchronous
`render()` call and screenshotting in the same tick revealed it had
worked correctly all along. Screenshots taken after any `waitForTimeout`
were catching stale frames, an artifact of headless Chromium's
`requestAnimationFrame` throttling, not a bug in the feature. Worth
knowing for testing any timing-sensitive visual in this runtime going
forward: when a screenshot looks wrong but the underlying state and
draw-call arguments both check out correctly, suspect the test's own
timing before the feature.

**Two carts need to actually look different, not just be tinted
differently.** Both had flat terrain (§21) with structure pieces that
were all one repeated square sprite — genuinely just scattered boxes,
not a shack or a castle. Fixed by giving each cart a second block
silhouette — a wide plank alongside Slingshot's tall crate, a taller
battlement/turret alongside Castle Crusher's plain wall block — spawned
on alternating block checkpoints (`g_i mod 2`) so the skyline actually
varies. This needed a fourth entity type per cart (`BLOCK` and a new
`BLOCK` variant, same fields, different `assetIndex`), which meant
`on_tick` and `on_collide`'s existing type dispatch (§21) had to widen
from "type == 1" to "type == 1 or type == 3" in a few places — a
mechanical change, not a new mechanic. Also gave the two carts more
distinct color identities while fixing this (green "pig" ball/target
against warm wood for Slingshot vs. a dark ball/red target against cool
stone-grey for Castle Crusher) — a good example of the destruction
genre's own §21 postmortem repeating itself: a `paletteParams` accent
hue chosen without checking what it actually renders to.

## 23. Real vertical structure (stacked castle), and a second reachability bug

§22's block variety only fixed the *sprites* — the actual layout was
still one flat line of ground-level positions, each holding either a
block (fixed height offset `-3`) or a target (fixed offset `-1`). That
reads as "one block above each enemy on a flat line," not a castle or a
shack, and the user called it out directly. The real fix needed genuine
stacking: multiple blocks/targets at the *same* horizontal position, at
different heights.

**Positioned tokens.** `buildPlatformLevel`'s token grammar (map_generator=3,
shared with the platformer) gained `COIN_AT`/`ENEMY_AT`, each taking a
row-offset operand instead of using the old hardcoded `-3`/`-1`. Neither
branch advances the walk's column cursor, so a run of `COIN_AT`/`ENEMY_AT`
tokens between two `FLAT`s places all of them at the *same* x, stacked
at whatever heights their offsets say — the mechanism a real skyline
needs. (Had to also add `PLATFORM_OPERAND_TOKENS`, a superset of
`PLATFORM_WIDTH_TOKENS`, so the generator's gridW pre-pass skips these
tokens' operand bytes too — otherwise a row-offset like `1` gets
misread by the pre-pass as if it were token id `1` (`STEP_UP`) with its
own operand, corrupting the width count.) Terrain itself stays fully
flat under all of this, same as §21 — only entities move vertically,
never the tilemap, which is what keeps the piercing-projectile
reachability guarantee intact in principle.

**In practice it didn't stay intact on the first attempt.** Both carts'
tokens were rewritten into real silhouettes — Slingshot a 2-story shack,
Castle Crusher two 3-tall towers flanking a walled gate — and the
reachability sweep (the same fresh-`World`, full angle×power grid from
§21) came back clean for Slingshot but found 3 of Castle Crusher's 4
targets structurally unreachable. The cause wasn't the stacking, it was
scale: the wider castle (58 columns, versus the ~40 that had been
tuned-by-luck earlier) placed its far tower and the top of its near
tower outside the projectile's *actual* reachable envelope. That
envelope is smaller and stranger-shaped than a textbook parabola,
because `GROUND_FRICTION` (0.985) is applied to the projectile's
horizontal velocity **every tick, airborne or not** — not just once
grounded — so horizontal reach decays continuously in flight, not just
after landing. A fine-grained sweep recording the highest point actually
touched at every column out from the anchor showed the reachable height
peaking around column 6–12 out and collapsing back to "ground level
only" by roughly column 27 — a hump, not the wide symmetric range naive
projectile-range math would suggest. The earlier ~40-column carts had
stayed inside this envelope by accident; the new 58-column castle didn't.

Fixed by measuring the real envelope once (a script that fires the same
angle/power sweep the reachability test uses and records, per column,
the maximum height actually reached by any trajectory) and redesigning
Castle Crusher's tokens to keep every stack within it with margin —
same structure (two towers, connecting wall, gated middle with two
targets), compressed from 58 to 24 columns. Re-ran the reachability
sweep clean (0 unreachable), then separately verified *winnability*
(not just reachability) with a fresh-`World` search for the best
angle/charge-tick combo per target, fired as one continuous playthrough
on the live cart: 4 near-direct hits cleared all 4 targets in 4 of the
14 available shots, confirming the shot budget has real margin for a
player who isn't hitting pixel-perfect aim on the first try.

**A test-methodology trap along the way, worth recording alongside
§22's rAF one**: an earlier pass at "find the best combo per target"
set `world.globals[angle]`/`[power]` directly to a candidate value and
then *also* ran the normal charge-tick loop on top — double-applying
power on every trial. That produced bogus near-perfect-looking combos
that didn't reproduce when actually played back (the projectile just
rolled to a stop on flat ground, nowhere near the target it supposedly
almost hit). The fix was to only ever drive angle/power through real
input ticks (`LEFT`/`RIGHT`/held `FIRE`, exactly what a player does),
never by writing the globals directly — same lesson as always in this
project: simulate the actual input path, don't shortcut it and assume
the shortcut is equivalent.

## 24. Real physics: gravity, entity-on-entity resting, and solid ball collision — and dropping Slingshot

Direct feedback on §23's stacked castle: "delete the angry birds slingshot
game and focus only on the castle crusher. Also the blocks have no
falling physics or ball collision. Fix." Two changes, in order.

**Slingshot is gone.** `buildSlingshotCart`, its `registerCart` entry,
and every comment cross-reference to it were removed; Castle Crusher is
now the only destruction-genre cart. `DESTRUCT_HOOKS_SRC` and the
`DESTRUCT_*_NAMES` symbol tables are unchanged in *shape* (still shared
infrastructure, just with one consumer instead of two).

**Real physics, without a new opcode.** §21 had deliberately simplified
this to "blocks never move, the projectile pierces straight through" —
a real V0 scope cut, reasoned through and user-approved at the time —
on the belief that real inter-entity physics needed a primitive this VM
doesn't have (`MOVE_SOLID` only resolves entity-vs-*tile*). Revisiting
it found that belief wrong: the engine already runs a generic pairwise
overlap scan every tick and calls `on_collide(a,b)` once per overlapping
pair with full read/write access to both entities — precisely the
primitive needed, just never used this way before.

- **Gravity is uniform.** BLOCK, the BLOCK variant, and TARGET all fall
  every tick (same `GRAVITY`/`MAX_FALL_SPEED` as the projectile) and use
  `MOVE_SOLID` to rest against the tilemap, identically to the
  platformer's player.
- **Resting on another entity** — the case `MOVE_SOLID` can't see, since
  it only checks tiles — is resolved in `on_collide`: when two
  non-projectile entities overlap, whichever has the smaller y (higher
  on screen) snaps to sit exactly on the other's top surface (using
  each type's real half-height) and its `vel_y` zeroes. A stack catches
  itself tower-block-by-tower-block, bottom-up, for free — that's just
  the order gravity naturally produces (the lowest block always reaches
  the ground first). Knock the bottom block away and nothing above has
  anything to rest on.
- **The projectile is solid against BLOCK/TARGET.** `on_collide` picks
  whichever axis the ball's incoming velocity is dominant on (compared
  via squared components — no ABS opcode needed, squares are never
  negative), reflects and damps that component (a real bounce, not a
  pass-through), snaps the ball back outside the entity along that axis,
  and shoves the entity with a fraction of the ball's original velocity
  — a hard hit now visibly topples a block off a stack, not just chips
  its HP. Damage/instant-kill still rides along in the same branch
  (cooldown-gated for multi-hit blocks, immediate for one-hit targets).

**Two real bugs found via testing, not eyeballing** (this genre's third
and fourth — §21 found terrain-wall unreachability and a soft-lock;
§23 found the friction-driven reachability envelope):

1. **A stack-management bug that silently corrupted velocity to
   `undefined`.** The "deadzone" clamp added so a damped bounce can
   reach exactly `vel_y === 0` (needed because `tick_proj`'s "shot is
   over" check requires exact equality, not a threshold) computed the
   new velocity, then did `DUP; MUL` to get its square for the
   threshold test — but `MUL` consumes *both* copies, leaving nothing
   on the stack for the subsequent store. Depending on the branch
   taken, `STORE_A`/`STORE_B` then popped an empty stack, writing
   `undefined` into `vel_y` — which the next tick's `GRAVITY` addition
   turned into `NaN`, which `Math.floor(NaN/8)` turned into `NaN` tile
   coordinates that bypassed `getTileAt`'s bounds check entirely
   (`NaN < 0` and `NaN >= length` are both `false`), crashing on the
   very next tile lookup. Caught immediately by a smoke test (a shot
   that touches any block at all), not by chance. Fixed by duplicating
   the value *twice* before squaring — one copy survives to be stored,
   the other is safely consumed by the comparison.
2. **Knockback could tunnel a block through the level edge and off the
   map forever.** The castle's level is only 192px wide; a hard
   knockback hit can give a block enough `vel_x` to cross the remaining
   distance to the edge in a single tick, faster than `MOVE_SOLID`'s
   discrete per-tick edge probe can catch it — found by running a shot
   to completion for thousands of ticks (not just until the ball's own
   shot resolved) and watching for any entity's position going
   out of the expected range: one settled into freefall at `y≈39627`,
   `MAX_FALL_SPEED` terminal velocity, forever. Fixed two ways: an
   always-correct hard position clamp in `tick_block`/`tick_target`
   (belt-and-suspenders, independent of getting any constant "right"),
   and a reduced `KNOCKBACK_SCALE` (0.6 → 0.45) so it's less likely to
   need the clamp's help in the first place.

**A third finding was a testing bug, not an engine bug, but earns its
place alongside §22's rAF trap and §23's double-charge trap**: an
adaptive "greedy best-shot" search cloned the live `World` with a
shallow `Object.assign` to try candidate shots without committing them.
The clone's `ctxBase`/`ctxScratch` — built once in the constructor,
closing over the *original* instance for several helpers (`findEntity`,
`spawn`, `getTile`, and critically the raw `globals` array reference) —
still pointed at the real, live world. "Trial" shots fired against the
clone were silently mutating the actual game (`targets_left` went to
-92; `won` flipped true on a shot count of zero). The fix was to
construct a genuine new `World` (own constructor call, own `on_init`,
own self-bound closures) and copy entities/globals *values* into it,
not to shortcut construction and copy top-level fields.

**Verification, in order**: a smoke test confirmed blocks settle at
real resting heights instead of floating at spawn position (§23's
tokens describe *heights*, not final rest positions — physics now
decides the latter); a long-run stability check confirmed the
support-resting snap converges to an exact, non-jittering rest (an
earlier version, snapping to the exact touching boundary, oscillated
forever between `vel_y = 0` and `vel_y = GRAVITY` because an exact
touch sits precisely on the strict-inequality edge the collision scan
uses — fixed with a deliberate 1px overlap margin); a 72-trial
angle/charge fuzz sweep over a full shot confirmed no cart faults and
no entity escaping the level bounds; and the corrected adaptive-search
test cleared all 4 targets in 2 of 16 available shots on a genuine
continuous playthrough — real margin, not a hopeful guess.

## 25. Shipping §3's compression, and measuring where each cart actually posts

§20 measured that generic compression alone was worth ~40-49% off the
raw fragment, and a cross-cart preset dictionary another 5-10 points
beyond that — but both were Node-side measurements against a script,
never shipped in the runtime itself. This pass ships the generic half
of that finding for real, in the browser, and answers a concrete
question raised by having five actual carts now: where can each one's
link actually be pasted?

**What's shipped.** `deflateRawCompress`/`deflateRawDecompress` wrap the
browser's native `CompressionStream`/`DecompressionStream` with the
`'deflate-raw'` format — no bundled library, matching this runtime's
existing "no dependencies for its own code" rule, and the leanest of
the three formats the API offers (no zlib/gzip header or checksum)
since every byte here travels in a URL. A short envelope tag
(`z.` compressed, `r.` raw) distinguishes the two, matching §2/§3's
original `u1`/`u1r` idea without an outer format-version tag (the real
`format_version` already lives inside the binary header, §4). A bare
fragment with *no* recognized tag is still treated as raw — every link
this runtime ever emitted before this pass keeps decoding exactly as it
always did. `encodePayload` only ever picks the compressed form when
it's actually shorter (DEFLATE's fixed per-stream overhead can lose to
raw base64 on the very smallest conceivable cart), so shipping this
can't regress a fragment's length, only shrink it or leave it alone.

The real preset dictionary from §3 is still unshipped: the standard
Compression Streams API has no dictionary hook, so building it for real
means hand-rolling a DEFLATE (or range-coder) encoder — genuine scope
for a future pass, not a gap in this one.

**Threading it through required going async**, since browsers expose no
synchronous compression primitive: `registerCart`, `startGame`,
`startInspect`, and `boot` all became `async`, with cart registration
now wrapped in one `registerAllCarts()` awaited before the menu ever
renders — a real architectural change, not just adding two functions,
but confined entirely to the URL-transport layer. `encodeCart`/
`decodeCart` (the binary cart format itself) are untouched.

**Measured, not assumed, on all 5 currently-shipped carts:**

| cart | raw bytes | uncompressed fragment | compressed fragment | reduction |
|---|---|---|---|---|
| Flappy Bird | 636 | 850 | 518 | −39.1% |
| Race Car | 1,103 | 1,473 | 784 | −46.8% |
| Cave Crawler | 1,301 | 1,737 | 993 | −42.8% |
| Run & Jump | 1,261 | 1,684 | 917 | −45.5% |
| Castle Crusher | 2,014 | 2,688 | 1,469 | −45.3% |

These land almost exactly on §20's "deflate, no dict" column (measured
independently, in-browser, months later, on a codebase that's grown
substantially since) — good confirmation the earlier Node measurement
wasn't an artifact of the tool used to take it.

Against §2's own three size classes (fragment length alone, no base
URL): three carts (Race Car, Cave Crawler, Run & Jump) move from the
**full** tier (≤2000) down into **standard** (≤1000) once compressed.
Castle Crusher is the sharper finding — its *uncompressed* fragment
(2,688 chars) doesn't fit inside **full** at all, exceeding the
project's own documented ceiling; compression is what gets it under
that ceiling in the first place, not just a nice-to-have on top of an
already-working link. None of the five reach **micro** (≤280) — that
tier needs §3's real dictionary, not generic DEFLATE.

**Checked against real platforms**, using the actual GitHub Pages URL
(`https://canyonturtle.github.io/games/#<fragment>`, 38 chars of
prefix): every cart fits Twitter/X (links auto-shorten via t.co
regardless of length, up to a ~4096-char original-URL ceiling), old-IE's
historical 2083-char address-bar cap, a ~1600-char practical
concatenated-SMS ceiling, and Slack/email/GitHub markdown (all
effectively unbounded for a single URL) — compressed *or* not. Discord's
hard 2000-char message cap is the one real pass/fail: Castle Crusher's
uncompressed fragment (2,726 chars as a full URL) exceeds it outright;
compressed (1,507), it fits with room to spare. A single QR code (byte
mode, Version 40/low-ECC's 2,953-byte ceiling — the largest the
standard defines) fits all five either way, but compression turns
Castle Crusher from the tightest cart on the shelf (92% of max capacity,
forcing the densest, hardest-to-scan code) into a comfortable one (51%).

## 26. Ground truth for agents: kernel.js and fixtures.md

Direct feedback, relayed from another agent that tried to visit this
project cold and author a cart with no prior context: it couldn't. Not
because the spec was wrong, but because of how it's shaped.

Three concrete blockers it reported: (1) the actual `encodeCart`/
`decodeCart`/opcode table/bit-packing only exist as running code inside
`urlcade.html` — this document describes them in prose, and (per the
new note at the top of this file) that prose is explicitly allowed to
lag the runtime; (2) it had no way to fetch or execute `urlcade.html`
from its own sandbox — no browser, and a code environment with no
network access to even load one; (3) even with the source in hand,
hand-encoding or hand-reimplementing a cart had no way to be checked
except by pasting the result back into the live page, which again needs
either network or a human relay.

None of that is a spec-content problem — the format wasn't ambiguous or
underspecified, it was just unreachable in a form a sandboxed agent
could actually use. Two artifacts fix it:

- **`kernel.js`**: `encodeCart`/`decodeCart`, the opcode table,
  `assemble()`, `runHook()` (the VM interpreter), and the base64url +
  DEFLATE transport, copied byte-for-byte out of `urlcade.html` into one
  file with zero DOM/browser dependency. `CompressionStream`/
  `DecompressionStream` are native globals in Node 18+ as well as every
  evergreen browser, so this runs identically under
  `node -e "require('./kernel.js')"` with no network access at all —
  directly answering blocker (2). Verified byte-identical to
  `urlcade.html`'s own functions across every currently shipped cart,
  the assembler, and cross-runtime (browser↔Node) compression interop
  in both directions (`test/check-kernel-sync.js`) — this isn't a
  reimplementation with its own bugs, it's the same code, checked.
- **`fixtures.md`**: a handful of known-good (cart description → exact
  bytes → exact fragment string) examples generated by `kernel.js`,
  including one that runs a real `on_init` hook through `runHook` and
  shows the resulting globals. Directly answers blocker (3) — checking
  a hand-computation or a from-scratch reimplementation against these
  needs nothing but reading a markdown file.

Blocker (1) is addressed by making the choice explicit rather than
implicit: every entry point (`llms.txt`, `spec/index.html`, this file's
own opening) now leads with "read `kernel.js`, not this prose" instead
of mentioning the drift risk as a caveat near the bottom. The V0 runtime
is still the only executable form of the spec — `kernel.js` doesn't
change that, it just makes the part of it worth reading in isolation
actually isolable.

Sync is maintained by discipline, not tooling: `kernel.js` is a copy,
not an import (`urlcade.html` stays a single self-contained file on
purpose — see §1), so nothing *prevents* the two from drifting apart
except remembering to update both and re-running the sync check. That's
a real, open cost of this fix, not a solved problem — see below.

## 27. Pruning the public site down to an authoring API

Direct instruction: pare down the public docs that aren't valuable for
authoring games (this file named explicitly as an example), and refocus
the published site around being a self-hosted game-authoring API rather
than a history of the project.

This file, `v0/README.md`, and the early worked examples
(`examples/*.md`) are no longer published to the Pages site
(`.github/workflows/pages.yml` stopped copying them into `_site`) —
they stay in the repo, unchanged, as exactly what they've always been:
a decision log for whoever maintains this codebase, not something a
newcomer trying to build a game needs to read. §26 had already made the
call that this file *can* lag the runtime and pointed at `kernel.js`
instead; this goes a step further and stops presenting the narrative
alongside the API at all, rather than just discouraging trusting it.

What replaced it: **`v0/AUTHORING.md`** — a new, current-only reference
(cart object shape, every field's meaning, the opcode table grouped by
purpose, the hook lifecycle, all three map generators' token tables,
camera/aim-line/HUD field semantics) written fresh by reading the
actual runtime, not adapted from this file's prose. Writing it found
two things worth fixing that had never been written down precisely
anywhere, including in this design log: track-generator tokens carry
*no* per-token width operand (unlike platform tokens, which do — an
easy mix-up), and `renderKind: 1` (tile-column) entities are
positioned by their top-left corner and ignore `collisionW`/`collisionH`
entirely, unlike every other entity, which is centered. `llms.txt` and
`spec/index.html` now lead with `AUTHORING.md` → `kernel.js` →
`fixtures.md`, in that order, as "build a cart"; the runtime's own menu
page links to it as "game authoring API" instead of "spec & design docs."

## 29. From monolith to modules: splitting the runtime, and a self-serve /compile tool

Direct instruction, in the same spirit as §27: stop shipping the
runtime as one file. `urlcade.html` had grown to ~5000 lines — the VM/
format guts (already separately available as `kernel.js`, §26), the
World simulation and both render backends, touch/keyboard input, the
menu and hash-based view router, the Cart Inspector UI, and all five
example carts' authoring code, all in one inline `<script>`. That was a
deliberate original design property (§1's "no build step, no server"
read, at the time, as "no separate files either"), but it stopped
paying for itself once the goal became a platform other people's
agents build on, not just a single demo page.

**The split.** `kernel.js` gained everything else about the cart format
that's pure data-in-data-out with no DOM dependency and had, until now,
only existed duplicated inside `urlcade.html`: palette generation, the
three map generators (track/cave/platform), the sprite shape-list
renderer, and — most consequentially — the disassembler and
control-flow-graph extractor (§19's Inspector, previously
Inspector-only code). `runtime.js` took everything that genuinely needs
a `document`/canvas/WebGL context: the `World` class, both render
backends, input, the fixed-timestep loop, and menu/game view-switching.
`inspector.js` took the Inspector's own tab UI. Each of the five example
carts moved to its own file under `carts/`, plus a small
`carts/shared-sprites.js` for the blob-silhouette helpers more than one
of them reuses (§17's authoring sugar). `index.html` shrank to markup
and CSS plus two `<script>` tags — `kernel.js` as a classic script
(so `window.UrlcadeKernel` and `require('./kernel.js')` are still both
the same file, unchanged contract), everything else as native ES
modules (`<script type="module">`) importing each other directly. Still
zero build step: no bundler, no transpiler, browsers have supported
`type="module"` natively for years.

The headline consequence: **`kernel.js` stopped being a copy and became
an import.** §26 built it as "the same code, copied out and checked
against the original by a Playwright diff" specifically because
`urlcade.html` staying one file meant it *couldn't* be a shared module.
Once that constraint was gone, the fix wasn't "check harder," it was
"stop duplicating" — the runtime now loads `kernel.js` directly, so
there's nothing left for `test/check-kernel-sync.js` to check. Retired,
replaced by `test/smoke.js` (loads the real module-split `index.html` in
a real browser, registers all five carts, plays each, exercises the
Inspector and `/compile`, asserts zero console errors) — a regression
test against the thing that's actually risky about a refactor this size
(behavior silently changing while moving code), not a drift check
against a problem that no longer exists.

**A real bug the split surfaced, not introduced.** Two of the five
carts (`run-and-jump.js`, `castle-crusher.js`) call `buildPlatformLevel`
directly at authoring time — not just at runtime inside `World`'s
constructor — to read off the generated grid's actual width and
coin/enemy counts before finalizing `screenW`/camera clamp bounds and
`NUM_COINS`/`NUM_ENEMIES` constants (see §15.2's note on why a naive
`tokens.filter()` undercounts). Splitting `buildPlatformLevel` into
`kernel.js` without noticing this second, authoring-time call site broke
both carts the first time they were actually loaded in a browser — caught
immediately by `test/smoke.js`, not shipped. Worth naming because it's
the same *species* of bug §15.1 found twice before (a piece of code
quietly relying on something that looked purely internal to one part of
the system) — found the same way, by actually running it, not by
re-reading the diff.

**Another real bug the split fixed.** The original single-scope
`boot()`/`backToMenu()` could leave a game's step/render loop running
invisibly in the background after navigating straight from a live game
to an `#inspect:` link — nothing on that path reset `running`, only the
explicit "back to shelf" button did. Splitting the runtime and the
Inspector into separate modules with their own private state (no more
one script incidentally able to reach into the other's variables)
forced this transition to be named explicitly in `main.js`'s `boot()`
instead of happening by accident — fixed as a consequence of the
module boundary, not a separately-motivated change.

**A real product gap the split exposed, fixed at the same time.** The
original `startGame(key)` only ever played a hash that matched one of
the five shelf carts' own precomputed payload string — `findCartByHash`
did a linear scan against `CARTS`, and any other validly-encoded cart
fragment (a `/compile` result, a link a friend shared) silently fell
through to the menu instead of playing. Backwards for a self-serve
platform: a cart shouldn't need to be checked into this repo's shelf to
be playable, it just needs to decode. `startGame` now takes a raw
fragment and decodes it directly (falling back to the Inspector's
existing decode-error UI, rather than duplicating that messaging, if it
doesn't); the five shelf carts play exactly the same way any other
cart does now, through the same code path, not a special one.

**`/compile`.** A new, standalone page (`url-console/compile/`) —
self-serve compiling and decompiling, the piece this platform needed
most for an agent (or a human) to close its own loop without a human
relay. Two panes, kept in sync in both directions: a "cart source" pane
(plain JS object literal, hooks as arrays of assembly-source lines —
the same shape every `carts/*.js` builder already returns) that
compiles automatically as it's edited, and a "fragment" pane that
decompiles automatically as it's edited. Compiling goes through a new
`kernel.js` export, `compileCartSource(source)` — assembles every hook
(via `assemble`, which now reports a 1-based source line number in
every error, not just the offending line's text), `encodeCart`s the
result, and round-trips it back through `decodeCart` immediately so a
malformed-but-not-rejected cart shape fails at the point it was
authored, not the first time the runtime or Inspector tries to read it.
Decompiling reuses `formatDisassembly` (§19) — its block-labeled output
(`B0:`, `B1:`, ...) was already, deliberately, `assemble()`-compatible,
so a decompiled hook pastes back in and reassembles to byte-identical
bytecode with no translation step.

`decodeCart` itself got stricter as part of this: `ByteReader` now
bounds-checks every read instead of silently returning `undefined` (and
poisoning everything downstream as `NaN`) past the end of a truncated
buffer, `format_version` is validated against a known list, and leftover
unread bytes after a full decode throw instead of being silently
ignored — each with a specific message naming what's wrong and where.
This wasn't `/compile`-specific plumbing; it's `kernel.js` itself
getting an actual point of view about "invalid cart data" for the first
time, which every other caller (the runtime, the Inspector) inherited
for free.

**A real bug shipped anyway, found within a day by an actual user.**
`/compile`'s own HTML referenced its sibling runtime files
(`kernel.js`, `index.html`, `AUTHORING.md`, `fixtures.md`) with
root-absolute paths (`/kernel.js`) — reasoned about, at the time, as
"safe because the site's always served from a domain root." Wrong: this
site is also published from a subpath on at least one custom domain
(`some-domain.example/games/...`, not the domain root), where a
root-absolute path resolves to an entirely different, nonexistent
location — `kernel.js` 404s, `window.UrlcadeKernel` never gets set, and
every module that reads it throws immediately, including inside
`/compile`'s own Play-link construction. The local test setup (this
section, above) never caught it because it served the assembled site
from the true root of a local HTTP server every time — root-absolute
and root-relative paths are indistinguishable from *that* vantage
point, which is exactly why the bug was invisible to it. Fixed by
switching `/compile` to paths relative to its own location
(`../kernel.js`, one directory up to the flattened site root — see
`build-site.sh`), which resolve correctly regardless of what prefix, if
any, the whole site is mounted under. `test/smoke.js` gained a third
section that serves the assembled site behind a simulated URL prefix
specifically to keep this class of bug from being invisible to the
test suite a second time — confirmed against both the broken and fixed
version before landing, the same "reproduce the failure, then verify
the fix undoes it" instinct DESIGN.md keeps coming back to elsewhere
(§15.1, §18.2).

## 30. Merging Play/Inspect/Compile into one view, and dropping DESIGN.md from the site

Direct feedback after §29 shipped: three separate top-level experiences
(the shelf/player, a standalone Cart Inspector view, a standalone
`/compile` page) was a seam that never needed to exist. Nothing about
"look at this cart's guts" and "edit this cart's guts" was actually
different work — both start from a decoded cart, both need the same
disassembler, and `/compile`'s whole right-hand pane (byte/fragment
size, Play link, errors) is information the Inspector's Overview tab
was already halfway toward showing. Keeping them apart just meant a
player who wanted to peek under the hood had to leave the game, and an
author fixing a bug had to bounce between two pages that didn't share
state.

**The fix: Debug tabs, not Debug pages.** `/compile` is gone. The
Inspector (now generally called "Debug" in the UI, reachable via a new
Debug button in the game view's topbar) grew two more tabs —
**Source** (the cart as an editable plain-JS-object literal, recompiling
automatically as you type, via the same `compileCartSource()` §29
added) and **Compile** (a specific, line-numbered error naming the
failing hook, or byte/fragment size info and a "Play this version"
button) — landing `/compile`'s entire feature set inside the same tab
strip as Overview/Palette/Sprites/Tiles/Map/Entities/Hooks. A
successful compile now also live-rebuilds `inspectWorld`/
`inspectCartInfo` from the *edited* cart, so every other tab reflects
the current Source text, not a stale snapshot from whenever Debug was
opened — switch to Hooks after fixing a bug and the disassembly is
already the fixed version's.

**Debug can pause and resume a live game, not just replace it.**
Opening Debug used to always fully tear the current view down
(`stopGame()`, in `runtime.js`) — fine when the destination was a
different cart entirely, wrong when the destination is "the same game,
plus a panel over it." `runtime.js` gained `pauseGame()`/`resumeGame()`
— pause hides the game view and stops the simulation loop without
disposing `World`/its GL textures; resume picks the exact same instance
back up. `main.js`'s `openDebug(payload)` decides which one applies by
comparing the fragment being debugged against whatever's currently
playing (`Runtime.getCurrentFragment()`, also new) — no separate
"how did we get here" state to keep in sync, just a comparison against
what's already on screen. Debugging something else entirely (a pasted
link, "+ New Cart") still gets the full `stopGame()` teardown, same as
before.

**"+ New Cart"**, on the shelf, replaces `/compile`'s "load with a
starter template already compiled" default state: it compiles a small
known-good cart (one entity wrapping around the screen, a frame-count
HUD line — the same starter `/compile` shipped) and opens Debug on it,
landed on the Source tab instead of Overview. Round-tripped through
encode→decode like every other path into Debug, rather than a separate
"nothing decoded yet" mode — one less state for every tab's rendering
code to account for, at the cost of the freshly-opened Source tab
showing numeric disassembly instead of the original named constants
(`PUSHC 0` instead of `PUSHC SCREEN_W`) — accepted, since named
constants never round-trip through the binary format for *any* cart,
so this is consistent with every other decompile, not a special case
worth keeping the extra state for.

**DESIGN.md itself dropped out of the authoring-facing surface**,
tightening what §27 already started. `AUTHORING.md` used to point
readers at this file for "how the format got here, or why a decision
was made a particular way" — true, but this file was never published
(§27), so that pointer was a dead link on the live site and, more to
the point, unnecessary reading for the one job `AUTHORING.md` exists to
do. The pointer is gone; this file stays exactly what §27 already
said it was — a decision log for whoever maintains this codebase, kept
in the repo, not part of what an author (human or agent) needs to load
to build a cart.

## 31. Silent failures on mobile: two unguarded awaits and a compression-format gap

Reported live, right after §30 shipped: "Debug" and "+ New Cart" did
nothing on mobile — no error, no view change, no console output visible
to the reporter. Diagnosing this without access to the reporter's
device meant reasoning from the code, not reproducing the exact
failure — and the code had a real, findable class of bug regardless of
what specifically triggered it on that device.

**The bug: unhandled promise rejections in click handlers.**
`inspector.js`'s `startNewCart()` called `compileCartSource()`,
`encodePayload()`, and `startInspect()` back to back with no
`try`/`catch`; `main.js`'s `newCartBtn` click handler called it without
`await` or `.catch()` either. If *anything* in that chain threw —
network hiccup, a browser-specific API quirk, any future bug — the
resulting rejected promise had no handler anywhere in the call chain.
That's not a crash and not a console error a typical mobile user would
ever see: it's a tap that visibly does nothing, indistinguishable from
"the button isn't wired up" from the user's side. The same shape of gap
existed in `main.js`'s `boot()`/`openDebug()` (the Debug button's own
path, via `hashchange`) and in `startInspect()`'s own tail (the
newly-added automatic `compileSourceText()` call from §30). Fixed by
making every one of these an explicit `try`/`catch` that either shows a
specific message via the existing `#inspectError` element or, for the
top-level bootstrap IIFE, force-shows the shelf first so the error has
somewhere visible to land — plus a `window.unhandledrejection` listener
as a last-resort console log for anything that still slips past. None
of this changes behavior when nothing goes wrong; it only changes
whether a failure is visible or silent.

**A concrete cause, found while auditing what could actually throw:**
`kernel.js`'s `encodePayload()` guards on `HAS_COMPRESSION`
(`typeof CompressionStream !== 'undefined'`) before attempting
compression, but that only confirms the *constructor* exists — not that
the specific `'deflate-raw'` format it's called with is supported by
that implementation. At least one real mobile browser reports
`CompressionStream` as present but throws constructing it with
`'deflate-raw'` specifically. Previously that exception propagated
through every caller; now `encodePayload` catches it and falls back to
the raw, uncompressed fragment form — a real, always-available
fallback, so a format-support gap costs fragment length, not the whole
authoring flow built on top of it. `test/smoke.js` gained a section
that simulates exactly this (a monkeypatched `CompressionStream` that
throws only for `'deflate-raw'`) and confirms `+ New Cart` still works
end to end — verified against both the broken and fixed version, same
as §29's postscript, so this doesn't just look plausible, it's checked.

## 32. The actual cause of §31's bug report: stale cached JS, not a swallowed exception

§31 shipped real hardening — the unguarded-promise-rejection class of bug
was genuine and worth fixing regardless — but the report that prompted it
("Debug"/"+ New Cart" do nothing on mobile) was still open afterward:
same symptom, same device, after the fix deployed. Diagnosing further
without device access meant asking the reporter three direct questions
rather than guessing again: does a private/incognito tab (guaranteed no
cache) change anything; do the *other* buttons (▶ PLAY, ← back) work;
what device/browser. All three answers landed at once: a private tab
fixed it, and the old buttons — present in every deploy, including
whatever version was cached — worked fine the whole time. That's the
signature of a stale cache, not a code path: the *page* (`index.html`)
updated (new markup for the Debug/New-Cart buttons rendered, so they
were visibly there to tap), but the *script* it loaded didn't — a
browser or an intermediate CDN (this site is also served from a custom
domain, likely behind its own caching layer in front of GitHub Pages)
kept serving an old cached copy of `main.js` that predated those
buttons' event listeners entirely. Tapping a real, visible button whose
handler doesn't exist in the code that's actually running looks
identical to "does nothing" — indistinguishable from §31's failure mode
from the reporter's side, but a completely different fix.

**The fix: cache-busted local script/module URLs, generated at deploy
time.** Every `<script src>` and every local `import '...'` — from
`index.html` down through `main.js`, `runtime.js`, `inspector.js`, and
every file under `carts/` — now gets `?v=<git-sha>` appended by
`build-site.sh` as a post-processing pass over the *assembled* `_site`
output, not hand-maintained in the source files. A query string change
is a genuinely different URL to a cache, so a stale cached `main.js`
can never be served against a fresh `index.html` again: the new page
always requests the new script's exact URL. Using the git commit SHA
(`git rev-parse --short HEAD`, already available in the checkout
`pages.yml` uses) rather than a manually-bumped version number was the
deliberate choice — the alternative works too, but only if a human
remembers to move it on every deploy that touches JS, which is exactly
the kind of thing that's fine ninety-nine times and silently wrong the
hundredth. `test/smoke.js` gained a structural check (every local
`.js` reference in the assembled site actually carries `?v=...`) —
confirmed to fail when the cache-busting pass is removed, same
verify-the-verifier instinct as every other regression test added this
way.

Left deliberately alone: the source files themselves (`index.html`,
`main.js`, ...) still read `./runtime.js` with no query string —
`build-site.sh` is the only place that knows about versioning, and
local development (opening these files directly, or via a plain static
server pointed at the repo) needs no cache-busting at all. Versioning
lives entirely in the deploy step, where the actual risk (a CDN or
browser caching across deploys) actually is.

## 34. Name/author URL envelope, an automatic thumbnail shelf, and a 3-tab Debug reorg

Two changes shipped together, both aimed at the same thing: making a
cart's identity (what game is this, who made it) and the Debug view's
organization both fall directly out of the fragment/cart data itself,
rather than out of hand-maintained metadata sitting next to it.

**Name/author, unencoded, in front of the payload.** `carts/index.js`
used to call `registerCart(key, title, genre, accentIdx, builder)` —
title and a manually-chosen accent-palette index, typed once per cart,
next to but not *part of* the cart the builder actually produced. That
duplication is exactly the kind of thing that quietly drifts (rename a
cart's `cartType` comment and forget the shelf's `genre` string next to
it). The fix: `name`/`author` became real fields on the cart *source*
object every `carts/*.js` builder already returns — the same object
`compileCartSource` was already reading everything else from — and
`kernel.js` gained `encodeCartUrl(name, author, payload)` /
`decodeCartUrl(fragment)` to carry them in the URL fragment itself,
prefixed before the existing `z.`/`r.` tag: `#My%20Game,Ada,z.<payload>`.

Deliberately *not* folded into the binary cart format and base64'd like
everything else:
- Base64 buys real compression on binary data with byte-level
  redundancy; it buys essentially nothing on a short, already-dense,
  human-authored string like a game's name.
- Plain text in the fragment means a shared link is self-describing at
  a glance — `#Flappy%20Bird,Urlcade,z.dVDL...` tells a human (or an
  agent skimming a list of links) what it is without decoding anything.
  That's a real usability property a binary-encoded name would give up
  for no compression benefit in return.

A comma is the delimiter, and it's unambiguous in both directions:
base64url's own alphabet (`A-Za-z0-9-_`) never contains a comma, and
neither does a legacy untagged raw fragment (same alphabet) — so a
fragment with no comma at all is exactly a fragment from before this
existed. `encodeCartUrl` only emits the `name,author,` prefix when at
least one of them is non-empty (both empty ⇒ returns `payload`
unchanged), so every fragment this repo already shipped, and any
fresh "+ New Cart" until an author sets a name, stays exactly the
bare `z./r.` shape it always was — this is additive, not a breaking
format bump. `encodeURIComponent` on each field individually (not on
the whole `name,author` string at once) means a literal comma *inside*
a name or author gets escaped to `%2C`, so it can never be mistaken for
the delimiter — verified directly (`decodeCartUrl(encodeCartUrl('A, B',
'C, D', 'r.xyz'))` round-trips `'A, B'`/`'C, D'` exactly).

`compileCartSource` became `async` (it now ends in a call to
`encodePayload`, itself async since `CompressionStream` is) and returns
`{cart, bytes, fragment, name, author}` instead of `{cart, bytes}` —
`fragment` is the fully-encoded, ready-to-play URL fragment, envelope
included, so every caller that used to hand-assemble `encodePayload(bytes)`
itself (`carts/index.js`, `inspector.js`'s `startNewCart`/
`compileSourceText`) now gets it directly. `name`/`author` are stripped
from the cart object before `encodeCart` sees it (same treatment as the
existing `constNames`/`globalNames` authoring-time-only fields) — they
never reach `decodeCart`'s output, only the fragment's own envelope and
the Source tab's editable object (see below).

**The shelf is now auto-generated from fragments, not hand-styled
cards.** `carts/index.js` no longer takes a title/genre/accent per
cart — it just compiles each builder via `compileCartSource` and keeps
the resulting `{fragment, name, author}`. `runtime.js`'s `renderMenu()`
was rewritten to build each card by *decoding* that fragment — the same
`decodeCartUrl` → `decodePayloadToBytes` → `decodeCart` path any pasted
link goes through, never reaching into the in-memory authored object —
and rendering the decoded cart's actual first frame (post-`on_init`, no
ticks run) to an offscreen Canvas2D thumbnail. That's a deliberate
"prove it, don't just claim it" property: a shelf card existing is
proof its exact fragment decodes and renders, not a hand-typed
assertion sitting next to a cart that might have drifted from it.

The thumbnail renderer builds (and immediately tears down) a real
`World` purely to reuse its already-CPU-side `spriteCanvases`/
`tileCanvases`/`mapCanvas` (`buildBitmap` never depends on which
renderer is active), composites them onto a plain `<canvas>` with
Canvas2D — never the WebGL path `renderSceneGL` uses for actual play.
A shelf full of live GL textures with no natural disposal point is
exactly the "texture lifecycle complexity" not worth taking on for a
static preview image; `disposeGLTextures()` runs right after drawing,
same pattern `inspector.js` already used for its own throwaway/replaced
`inspectWorld`.

Card accent color is now derived from the decoded palette instead of a
manually-chosen index (the old `accentIdx` argument): scan every
palette entry (skipping index 0, conventionally an outline/background
color) for whichever has the largest max-minus-min across its RGB
channels — a cheap, mode-agnostic "how colorful is this" proxy. A fixed
index doesn't generalize: curated-bank palettes (`paletteMode: 0`) pad
unused slots with flat black past whatever count a specific bank
defines, so a fixed index like 8 or 15 lands on real color for some
banks and dead padding for others; the scan-for-most-colorful approach
is blind to that distinction entirely.

**Debug's nine tabs became three.** `Overview/Palette/Sprites/Tiles/
Map/Entities/Hooks/Source/Compile` — themselves the result of an
earlier merge (§30) of a read-only Inspector and a standalone
`/compile` page — grouped by what an author actually thinks in terms
of, not by the Inspector's own internal render-function boundaries:
- **Assets**: Palette, Sprites, Tiles, in sequence — everything that's
  just pixels.
- **Logic**: Overview, Map, Entities, Hooks, in sequence — everything
  that's cart *behavior*. Hooks keeps its own nested hook-tab
  sub-navigation (on_init/on_frame/.../on_collide) unchanged.
- **Source**: compile status (raw size, fragment length/class, a "Play
  this version" button, or a specific line-numbered error) at the top,
  the editable source textarea directly below — explicitly per this
  round's request, so editing and its own feedback are never more than
  a scroll apart, instead of two separate tab clicks away from each
  other the way Source/Compile used to be.

The ✓/✕ compile-status badge moved from the old Compile tab's own
button onto Source's. The debounced auto-recompile-on-edit still only
touches a small `#compileStatusSlot` div at the top of the Source tab's
body — never the textarea itself, never Assets/Logic — the same
focus-preservation concern §14 already solved, just re-scoped to a
sub-element instead of a whole separate tab now that status and editor
share one tab. `cartToSourceObject` (decompiled-bytecode → editable
JS-object text) now prepends `name`/`author` fields ahead of the
binary-only cart fields, so editing a cart's identity is exactly as
live/first-class in Source as editing its hooks — decoded straight
from the fragment's own envelope, round-tripped back into one on the
next successful compile.

One real bug caught during this: `runtime.js`'s `startGame(fragment)`
originally still called `decodeCart(await decodePayloadToBytes(fragment))`
directly on the raw hash — unchanged from before this section — which
broke every cart whose fragment now carries a name/author prefix (the
prefix isn't valid base64url, so decoding failed and the game silently
fell through to `boot()`'s Inspector fallback instead of playing).
Confirmed via `test/smoke.js`'s existing "cart plays" checks, which
started failing outright; fixed by decoding through `decodeCartUrl(fragment).payload`
first, same as every other entry point already did. Reverting the fix
reproduced the failure (all five shelf carts: `{"ok":false}`) before
restoring it — the standing verify-the-verifier practice throughout
this log.

## 35. The first externally-authored cart: Breakout, by an agent working purely from AUTHORING.md

§34 built the whole name/author/thumbnail pipeline on a claim it hadn't
actually been tested against yet: that a fragment doesn't need a
`carts/*.js` builder checked into this repo to be shelf-worthy, only to
decode. That claim got its first real test almost immediately — a
Breakout cart built by a different agent, working entirely against the
live site and AUTHORING.md, with no access to this repo's source at
all, handed back as nothing but a finished link
(`#Breakout,Claude,z.<payload>`).

Adding it didn't need a new `carts/breakout.js` builder — there's no
source to put in one, only the compiled fragment. `carts/index.js`
gained a second, much smaller registration path alongside
`registerCart()`: an `EXTERNAL_CARTS` list of `[key, fragment]` pairs,
registered via `decodeCartUrl(fragment)` alone (just enough to read the
`name`/`author` already sitting in the fragment's own envelope) rather
than a full `compileCartSource()` round-trip — there's no source object
to compile, the fragment already *is* the compiled output. Both paths
converge on the exact same `CARTS[key] = {fragment, name, author}`
shape, so `runtime.js`'s shelf renderer (§34) needed zero changes: it
was already decoding every card from its fragment alone, never the
in-memory authored object, specifically so this would work.

Before wiring it in, the fragment was decoded and its `on_init` hook
run standalone under Node (`kernel.js` has zero DOM dependency, so this
needed no browser) — confirmed a clean decode, no cart fault, and 42
entities spawned (paddle, ball, and a full brick grid, consistent with
a working Breakout) — the same "prove it, don't just claim it"
instinct as everywhere else in this log, applied to a cart this
codebase had zero part in producing. `test/smoke.js`'s shelf-count
assertions moved from 5 to 6, and its "every shelf card has a name and
author" check was loosened from asserting `/Urlcade/` specifically
(true of every local example) to just asserting *a* non-empty author —
the original assertion was accidentally over-fitted to "every cart on
the shelf happens to be ours."

This is the intended end state of the whole platform, not a special
case bolted on: the shelf is a list of fragments, and a fragment earns
its place by decoding and playing, regardless of which agent, human, or
codebase produced it.

## 36. Pointer input and immediate-mode drawing — a breaking format bump to 2

Two new, general-purpose kernel primitives, both needed by a single new
request: a cart where you drag on the canvas to water a procedurally
drawn, growing plant. Building it properly meant deciding how far to
take "immediate mode" as a real platform feature rather than one-off
plumbing for a single game — see the design discussion this section's
own commit history preserves for the tradeoffs considered (a per-frame
`on_draw` hook + a small opcode set vs. a heavier alternative touching
both render backends more invasively) before landing on the shape below.

**Pointer input.** A cart sets `inputWantsPointer: true` (one new u8 in
the binary header, next to `inputActiveButtons`/`inputTouchTemplate`)
and reads `LOAD_POINTER_X`/`LOAD_POINTER_Y`/`LOAD_POINTER_DOWN` — three
no-operand opcodes, available in any hook — the continuous counterpart
to `LOAD_INPUT`'s discrete bitmask. Safe to read even when the cart
never declared the flag (reads 0, same "always readable, cart declares
intent" shape buttons already have). `runtime.js` tracks real pointer
position in cart-pixel space via a small coordinate transform
(`pointerToCartCoords`) that undoes the canvas's CSS scaling/letterboxing
(`object-fit: contain` means the displayed size and the native
`cart.screenW`×`screenH` buffer size are almost never equal) — copied
onto `world.pointerX/Y/Down` once per `loop()` iteration, exactly
mirroring how `buttonMaskFromKeys()` already feeds `world.input` there,
so every hook in a given tick sees one stable value for the whole tick
it runs in rather than whatever the pointer happened to be mid-event.

**Immediate-mode drawing.** A sixth hook, `on_draw`, paired with a
third `entityTypes[i].renderKind` value (`2`, alongside the existing
`0` sprite-blit and `1` tile-column kinds). Where every other hook runs
on the fixed-timestep simulation clock, `on_draw` runs once per
`renderKind:2` entity *per rendered frame* — presentation-only, like
the existing `ilerp`/`ilerpAngle` interpolation between ticks, and
opted into per entity *type*, not globally, so the overwhelming
majority of a cast can stay cheap baked sprites and only the entities
that actually need custom art pay for it. The one opcode today is
`DRAW_LINE`: pop `color, y2, x2, y1, x1` (pushed in that order, `color`
on top — same convention as `SETTILE`'s `x, y, tileId`) and hand them to
a `ctx.drawLine` callback the caller supplies — kernel.js itself stays
completely rendering-agnostic, same as every other opcode that reaches
out through `ctx` (`playSound`, `setTile`, ...). Coordinates are
entity-local pixels; the renderer translates to the entity's own
position before running the hook, so `on_draw` never needs to know
about the camera or even read its own position back out.

`World` gained a `drawCmds` scratch array and `runDrawHook(entity)`
(clears it, runs the hook with `self` bound, returns it) — called from
`drawEntityCanvas`/`drawEntityGL`'s new `renderKind === 2` branch, and
from the shelf's `buildCardThumbnail` (so a `renderKind:2` entity's
first frame shows up in its shelf card thumbnail exactly like any
sprite-based entity's does, no special case needed there beyond the one
branch). The **GL implementation turned out cheaper than expected**: a
line is just a degenerate rotated rectangle — center at the segment's
midpoint, width = its length, height a fixed thin stroke, rotation =
its own angle — so it reuses `glDrawColorQuad` exactly as-is (`glDrawLine`
is just the trigonometry to compute those four numbers from two
endpoints). No second shader, no new vertex buffer, no separate
immediate-mode render path to keep in sync with the textured-quad one;
Canvas2D's side is the expected `moveTo`/`lineTo`/`stroke`.

**The breaking part.** `on_draw` is a genuine binary-layout change — a
sixth entry in `HOOK_NAMES`, which both `encodeCart`/`decodeCart` and
`compileCartSource` already iterate generically, so the format itself
picked it up for free, but it means every existing `formatVersion:1`
fragment has a different byte layout now. Per an explicit "we're still
pre-v1, breaking is fine" call: `SUPPORTED_FORMAT_VERSIONS` dropped 1
entirely rather than gaining a compatibility branch for it —
`formatVersion:1` fragments now fail **loudly**, with kernel.js's own
existing "unsupported format_version" error, rather than silently
misparsing. All five original example carts and the Debug view's
`STARTER_TEMPLATE` got bumped to `formatVersion: 2` in the same pass.

**Breakout, vendored a second time.** §35's Breakout cart was still a
`formatVersion:1` fragment — reachable via `EXTERNAL_CARTS` — so it
broke the instant `SUPPORTED_FORMAT_VERSIONS` changed. Rather than
lose it again, it got decompiled *before* touching the format (kernel.js's
own `formatDisassembly`, run against its original bytes while the old
kernel could still decode them) and checked in as `carts/breakout.js` —
a real local example now, compiled through the normal `registerCart()`
path like everything else, `formatVersion:2` included. `EXTERNAL_CARTS`
is empty again, but the mechanism itself stays — this is now the second
time it's proven useful to have a path for "a fragment nobody in this
repo wrote," and the decompile-recompile round-trip is exactly what
AUTHORING.md already documented as always valid, just used here to
carry a cart across a breaking format change instead of to inspect one.

**Water the Plant** (`carts/plant.js`) is the new cart both primitives
exist for: dragging anywhere on the canvas spawns falling water-drop
entities (an ordinary `renderKind:0` sprite) at the pointer's current x;
a drop crossing a fixed soil-line y increments a `g_water` global and
kills itself in its own `on_tick` — no `on_collide` needed at all for
the mechanic. The plant itself is a single `renderKind:2` entity whose
`on_draw` hook computes a stem height purely from `g_water` (clamped,
stashed in an ext field via `STORE_SELF`/`LOAD_SELF` exactly like any
other per-entity scratch value — `on_draw` isn't a different kind of
hook, just one that happens to run on a different clock) and draws a
stem, two side branches past one water threshold, and a small bloom
past a second — genuinely continuous growth, not a handful of
pre-drawn growth-stage sprites swapped by index. Before wiring it into
the site at all, the whole hand-written hook set (drag-throttling in
`on_input`, fall/absorb in `on_tick`, the branching draw logic in
`on_draw`) was exercised headlessly under Node — no browser, no
`World` — by driving `runHook` directly against a scripted sequence of
simulated ticks and pointer states and inspecting the resulting
`drawCmds` at several water levels, catching stack-discipline mistakes
in the hand-assembled `DRAW_LINE` argument order before they could ever
reach `test/smoke.js`'s Chromium pass (which then added its own
behavioral check: a real Playwright-simulated drag on the plant cart,
asserting `g_water` actually increased afterward, not just "nothing
threw").

## 37. Mini Golf — a genre with zero new kernel surface

Notable mostly for what it *didn't* need. Unlike the two previous
rounds (§34's name/author envelope + shelf, §36's pointer input +
immediate-mode drawing), Mini Golf shipped with no kernel.js changes
at all — every mechanic the request asked for (a tile-map course, a
hole, angle/power timing, a flag) turned out to already be expressible
as composition of existing primitives, aimed at a different genre than
whichever one first motivated them:

- **The course** is the track generator (`mapGenerator: 1`) — the same
  turtle-grammar walk the racer uses for a road, reused unchanged for a
  fairway. `TILE_ROAD` is the fairway, the walk's own stamped edge
  cells (`TILE_RUMBLE`) are the rough, everything the walk never
  touched (`MAP_EDGE_TILE`) is out-of-bounds — three friction tiers for
  free, no new tile-surface concept needed.
- **The hole** is a `CHECKPOINT` token at the end of the token list.
  The tee is the walk's own `START_FINISH` token (checkpoint 0). Both
  read once at `on_init` via `GET_CHECKPOINT` — the same opcode the
  racer uses for lap checkpoints and the cave crawler uses for player
  start/stairs placement, doing double duty as "arbitrary named point
  on the map" for a third, unrelated genre.
- **The flag** is an ordinary static `renderKind: 0` sprite (a pole +
  banner built from two `SHAPE_RECT`s) at the hole's checkpoint
  position — nothing about it needed the just-shipped immediate-mode
  drawing; not every visual needs to be procedural.
- **Angle/power timing** is the existing `aimLine` cart field
  (§21) — built for and until now only used by the destruction genre —
  plus a small state machine in `on_input`: aim (steer with
  left/right), press to start a power value ping-ponging between 0 and
  `MAX_POWER` every frame (arithmetic composed from `ADD`/`CMPLE`/
  `CMPGE`, no new opcode), press again to lock whatever it's at and
  launch, using the exact `cos(angle)*power, -sin(angle)*power`
  convention `aimLine`'s own doc comment already specifies. A real
  two-press timing swing, not a hold-to-charge meter — matches how the
  request was actually phrased ("angle and power timing").
- **Rolling physics** (integrate position, apply friction read off
  `GETTILE`+`TILE_SURFACE`, zero out on stop) is line-for-line the
  racer's own `on_tick` pattern, renamed. The "has the ball stopped"
  check reuses `DIST` in a way it wasn't obviously designed for —
  `DIST(0, 0, vel_x, vel_y)` computes speed as a distance from the
  origin, avoiding the need for a dedicated vector-magnitude opcode.

One real correctness gap did turn up during headless verification
(the same "exercise the hand-assembled hooks under Node before ever
opening a browser" step §36's plant cart established): after sinking
the putt, nothing reset `g_swing_state` away from 2 (only the
"missed" branch did), so `on_tick` kept re-running its now-pointless
stopped-ball check forever — harmless in practice (`on_input` already
gates all input processing on `g_won` first, so nothing downstream of
the stuck state was ever reachable again), but wasteful and worth a
one-line guard (`LOADG g_won; JNZ tick_end` at the top of `on_tick`)
for the same reason every other cart gates its update hooks on a
game-over flag. Caught by simulating a full multi-shot playthrough
(`runHook` driven by a scripted "aim at target, charge, release, roll
out" loop, not just a single swing) headlessly before wiring the cart
into the site at all — a single swing wouldn't have surfaced it, since
the stuck state only matters *after* a win.

## 38. §37's real bug: a touch-template/opcode bit mismatch a keyboard test couldn't see

Reported live: aiming worked, but the ball never launched — "stays in
place forever at the left edge of the track." §37's own headless
`runHook` playthrough and `test/smoke.js`'s browser check both passed
before shipping, so this needed a fresh look rather than trusting
"already verified."

The cause: Mini Golf declared `inputTouchTemplate:
TOUCH_TEMPLATE_STEER_ACTION` but read its swing/action button as
`TESTBIT 4` (bit *value* 16) in `on_input`. `runtime.js`'s
`buildTouchControlsHTML` hardcodes that template's own action button to
send bit value 4 (`data-bit="4"`) — the convention race-car.js (the
same template) already follows correctly (`TESTBIT 2`, bit value 4).
Golf's on-screen "Swing" button was tapping out mask 4 the whole time;
the hook was listening for mask 16. Aiming (`TESTBIT 0`/`TESTBIT 1`,
left/right) was unaffected, which is exactly why it "worked."

**Why two separate verification passes both missed it**: the headless
`runHook` simulation drove `ctx.input` directly with whatever numeric
mask the test script chose — it never went through `buildTouchControlsHTML`
at all, so a template/opcode mismatch was structurally invisible to it.
`test/smoke.js`'s browser check used `page.keyboard.down(' ')` — the
spacebar, which `buttonMaskFromKeys()` hardcodes to bit value 16
*regardless of a cart's touch template* — so it happened to send
exactly the (wrong) bit the cart was listening for, passing for the
wrong reason. Neither check ever exercised the actual on-screen button
a touch player taps.

**Fix**: `TESTBIT 4` → `TESTBIT 2` (four call sites) and
`inputActiveButtons`/`inputButtonLabels` moved from bit 16 to bit 4,
matching race-car.js's own precedent for this exact template.
`test/smoke.js`'s golf check was rewritten to locate and press-hold-release
the real `.touch-btn[data-bit="4"]` element (`page.mouse` down/wait/up
on its bounding box, not a keyboard key) — confirmed to fail against
the broken build and pass against the fix. A first attempt using
Playwright's plain `.click()` on that button *also* passed against the
broken build (a false negative): `.click()` fires mousedown+mouseup
back-to-back, fast enough that the held-button state can flip on and
back off before the running game loop's next frame ever samples it —
the same press-wait-release shape §36's plant drag test already used,
now established as the right pattern for any on-screen button test
here, not just drags.

**The general lesson**: a touch template is a *contract* between
`runtime.js` (which bit a given on-screen button actually sends) and a
cart's own hook code (which bit it reads) — nothing in `compileCartSource`
or `decodeCart` checks that the two agree, because the binary format has
no way to know a hook's TESTBIT operands are "supposed to" correspond to
a particular template. Getting this wrong doesn't error, doesn't fault,
doesn't even fail a keyboard-driven test — it just silently listens to a
button nothing on screen ever presses. Worth remembering next time a
cart pairs a specific `inputTouchTemplate` with its own `TESTBIT`
operands: cross-check against `runtime.js`'s `buildTouchControlsHTML`
(or an already-shipped cart using the same template) rather than
assuming the "obvious" bit.

## 39. HOLE_RADIUS was smaller than the ball itself, and invisible

Reported live, again, after §38's fix let the ball actually launch:
"it's too hard to win — the hole hitbox seems to be a tiny point." Two
compounding problems, both real:

- **`HOLE_RADIUS` was 6px** — smaller than the ball's own ~3px radius
  plus any reasonable margin. The check is a straight `DIST(ball,
  hole) < HOLE_RADIUS` on the ball's *center*, so a 6px radius meant
  the center had to land almost exactly on the hole's center, with
  essentially no tolerance for the ball's own size or any imprecision
  in a timing-based (not pixel-precise) aim/power system. Raised to 12.
- **There was no cup graphic at all.** The flag sprite was just a pole
  + banner — nothing marked where the actual sink radius was, so even
  a *correctly sized* hitbox would have felt arbitrary; a player has
  no way to aim for a target they can't see. Fixed by adding a dark
  ellipse to the flag sprite, positioned at the sprite's own center —
  which is where the entity's `(x, y)` anchor actually lands, per
  `drawEntityCanvas`'s `x - spr.width/2, y - spr.height/2` — so the cup
  mark and the true `HOLE_RADIUS` check now agree on where "the hole"
  is, not just visually near it. (The old flag had the pole spanning
  its *entire* sprite height, so its visual base sat 8px below the
  true anchor point — a smaller, separate accuracy gap the redesign
  fixed as a side effect of getting the cup placement right.)

Both changes verified the same way as every prior tuning change in
this cart: headlessly, before touching the browser — confirmed the
existing 4-stroke fairway-following playthrough still sinks (unchanged
distances, just a more forgiving final check), and added a new
specific case a `HOLE_RADIUS: 6` cart would have missed (a putt with a
deliberate 6° aiming error from 30px out) to confirm the fix actually
buys real, meaningful forgiveness rather than a cosmetic-only bump.

## 40. A polish round: restart, a plant that's never nothing, friendlier prose, a denser mobile grid

Four independent small requests, batched together since none touched
the cart format or needed a fixture update:

- **A restart button.** `Runtime.startGame(fragment)` already fully
  re-decodes a fragment and rebuilds the `World` from scratch, re-
  running `on_init` — exactly "start this game over," with no per-cart
  reset logic needed. Added `#restartBtn` next to `#backBtn` in the
  game view's topbar, wired to `Runtime.startGame(Runtime.getCurrentFragment())`.
  The topbar's centering trick (DESIGN.md-adjacent code comment: a real
  element balancing each side of `#hud`, not a padding hack) depended
  on `.topbar` having exactly 3 flex children — preserved by wrapping
  `#backBtn` + `#restartBtn` together in a new `.topbar-left` flex
  container, so `.topbar` still has 3 top-level children and `#hud`
  still centers correctly.
- **The plant started as literally nothing.** At `g_water: 0`,
  `on_draw`'s stem-height calc (`g_water * STEM_STEP`, clamped to
  `MAX_STEM_H`) evaluated to a zero-length line — invisible — and every
  branch/bloom was gated behind a `>= BRANCH_UNLOCK_*` check, so an
  unwatered plant drew nothing at all. Since the shelf's thumbnail for
  every cart is its own undisturbed first frame, this also made the
  shelf card for "Water the Plant" a blank rectangle. Fixed with a new
  `MIN_STEM_H` floor (constant 11) on the stem-height clamp, plus a
  small always-visible bud (a scaled-down version of the existing X-
  shaped bloom, gated open rather than closed) drawn at the stem tip
  below `BRANCH_UNLOCK_2` — so there's a small but real flower from the
  very first frame, not an empty pot. Also added a second, higher and
  shorter pair of side branches (`BRANCH_UNLOCK_3`/`BRANCH_LEN2`,
  constants 12/13) that unlock partway between the existing bloom
  threshold and full growth, so the mature plant now has two branch
  tiers instead of one. Verified headlessly by driving `on_draw`
  directly through `kernel.js`'s `runHook` at a sweep of `g_water`
  values and inspecting every `DRAW_LINE` call's coordinates and line
  count at each stage (caught and fixed a real bug this way: the first
  draft had the bloom-size branch's `JZ`/`JNZ` target backwards,
  drawing the *full* bloom below the unlock threshold and the *small*
  bud above it — invisible from reading the assembly, obvious from the
  captured line list at each water level) before running the full
  Playwright suite.
- **Landing-page prose rewritten for non-technical visitors.** The
  original copy led with "static runtime, no server" and "URL
  fragment" and pointed at "Debug's Assets/Logic/Source tabs" and "V0
  scope cut" — accurate, but aimed at a reader who already knows what
  a runtime or a fragment is. Rewritten to lead with what a casual
  visitor actually needs to know — pick a game, it plays instantly,
  no install or account, the whole game fits in the link so sharing it
  is just sharing a link — with the technical detail (how the format
  works, how to build one) moved behind a single "how it works & build
  guide" link rather than inlined into the first paragraph.
- **Shelf grid, 2 columns on portrait mobile.** `#cartList` used two
  hardcoded breakpoints (2 columns at 480px, 3 at 820px), so a phone
  narrower than 480px — most phones, held upright — got a single
  column. Replaced both with one `grid-template-columns:repeat(auto-fill,
  minmax(130px, 1fr))` rule (gap trimmed from 20px to 14px to match):
  content width on a 320px-wide screen is already enough for
  `2*130 + 14 = 274px`, so even the narrowest common phones now get 2
  columns, growing to 3+ automatically as the viewport widens — no
  extra breakpoint needed for that.

Added `test/smoke.js` coverage for the restart button: after the
existing plant-watering drag test leaves `g_water > 0`, clicking
`#restartBtn` must bring it back to exactly 0 *and* produce a
genuinely new `World` instance (tagged with a random marker before the
click, checked for absence after) — not the same instance with its
globals reset in place, which would be an easy-to-write-by-accident bug
that happened to look identical for this one cart's HUD.

## 41. Procedural palette overhaul: figure-ground contrast, hue-shifted shading, and a silent byte-overflow bug

Reported live: "all games except flappy bird, cave crawler, and breakout suffer from strange color palettes, where the entities are often desaturated or blend in almost entirely with the stage." Those three exceptions are exactly the tell — flappy and cave crawler use `paletteMode: 0` (a hand-picked `CURATED_BANK` entry), and while breakout uses `paletteMode: 1` (procedural), it happened to be authored with a wide `satMax` (70%). Every affected cart shared the same root cause in `generatePalette()` itself, not a per-cart tuning mistake.

**The original bug.** Procedural mode generates two 8-color ramps — indices 0-7 ("base," for terrain/backdrop) and 8-15 ("accent," for entities) — from one `[baseHue, satMin, satMax, lightMin, lightMax, accentOffset, ...]` param block. The original code ran *both* ramps through the exact same saturation/lightness range, varying only hue. A cart author picking a muted, low-saturation terrain range (stone, dirt, grass — several shipped carts go as low as 8-20% saturation, for good reason: believable terrain) got that same near-grayscale range forced onto every entity color too. Low saturation reads as gray regardless of hue, so a desaturated blue car on a desaturated green road doesn't read as "blue on green" — it reads as "gray on gray."

**The fix, in `generatePalette()`:** the accent ramp is no longer a hue-only variation of the base ramp. It now:
1. is pushed at least `MIN_ACCENT_HUE_SEPARATION` (100°) from the base hue, circularly clamped (not just added) so a small authored offset — "a nearby shade," exactly the case that caused blending — is corrected rather than honored;
2. gets its own saturation floor (55-90%), independent of whatever the base ramp is doing;
3. gets its own, considerably brighter lightness floor *and* ceiling (45-88%) — entities need to read as foreground by being lighter, not merely a different, equally dark hue;
4. shifts hue per ramp step rather than holding it fixed: the shadow end leans toward the cooler side of the wheel, the highlight end toward the warmer side (`ACCENT_HUE_DRIFT`, ±18°) — the same reason hand-painted pixel-art ramps outperform a naive lightness-only gradient, raised directly by the live report ("aesthetic palettes can be constructed by hopping from darker, bluer hues to lighter, less blue hues").

This runs for every `paletteMode:1` cart automatically, including ones authored after this change — no cart has to opt in.

**A backwards floor, caught by screenshotting, not by the math.** The first version of the lightness-floor fix computed `Math.min(cartLightMin, ACCENT_LIGHT_MIN)` — which, for any cart with a *dark* authored `lightMin` (the common case for moody terrain), picks the darker of the two and silently undoes the floor entirely. The numeric contrast metric used to validate the fix (a WCAG-style luminance ratio) didn't catch this because saturation alone had already improved it; only an actual rendered screenshot of the race car — "still seem out of place... too low of a color value" — made the bug visible. Fixed to `Math.max` on both bounds, which cannot be dragged down by a dark terrain range.

**Two cart-level index mistakes, once the ramp itself could be trusted.** With the ramp fixed, three sprites still read as flat:
- Run & Jump's player used `blobPlayerShapes(9, 10)` — both index 9 and 10 sit near the *dark* end of the ascending-brightness accent ramp (t≈0.14-0.29). That pairing was copied from the curated "dungeon" bank, where index 9 happens to be the bright one and 10 the dark one — a hand-picked bank has no ascending-brightness convention at all, so the same numbers mean something entirely different there. Fixed to `blobPlayerShapes(14, 8)` (bright body, dark outline, matching the ramp's actual ordering).
- Castle Crusher's wrecking ball used indices 0/1/7 — the *base* ramp, the same family as the sky and stone blocks it's aimed at. Fixed to use the accent ramp (8/13/15) instead, the same treatment already given to the blob-monster targets.
- Mini Golf's ball used indices 1/7 (also base ramp, two shades of the fairway's own green). Fixed to 8/15 (accent).

**The real find: a silent byte-overflow bug, independent of all of the above.** While tuning the race car's hue per the live suggestion to swap which side is base vs. accent (track = dark blue, car = light green — "green is warmer than blue... what if the track was the darker blue and the cars lighter green"), the result rendered *pink*, not green. Cause: `paletteParams` packs into 8 *unsigned bytes* (`AUTHORING.md` documents this: "stored as an unsigned byte (0-255)"), and `accentOffset: 260` — one past the max — silently wrapped to 4 through `ByteWriter.u8`'s old `v & 0xFF`, landing the accent hue at `baseHue + 4` instead of the intended value. Nothing in the compile pipeline said anything; the cart compiled cleanly and only *looked* wrong. Grepping for the same class of bug turned up a second, pre-existing instance: Mini Golf's `accentOffset: 280` had been silently wrapping to 24 since the procedural-palette cart shipped, landing its "warm accent ramp" (per its own code comment) on a cool blue instead of the intended red.

Both cart values are now in range (race car: `baseHue:220, accentOffset:240` → track a dark blue-grey, cars a light green; golf: `accentOffset:250` → the intended warm red/pink). But the systemic fix is in `ByteWriter.u8()` itself, the single choke point every one of the format's many byte fields writes through: it now throws on a non-integer or out-of-range value instead of masking it. This turns the same mistake, for any field, into a compile-time error naming the bad value — for anyone authoring a cart, not just this session.

**Verification.** Headless: `generatePalette()` driven directly through a range of shipped carts' real `paletteParams`, comparing accent-ramp hue/saturation/lightness before and after at matching ramp positions. Visual: real Playwright screenshots of every affected game (not just the numeric metric, which — per the backwards-floor bug above — can look fine while the actual render doesn't) both before and after each iteration of the fix. `test/smoke.js` gained three checks: every procedural-palette shelf cart's accent ramp is hue-separated, saturated, and lighter than its base ramp at the same ramp position; `encodeCart` rejects an out-of-range `paletteParams` byte instead of silently wrapping it (checked against a real decoded shipped cart with one field mutated, not a from-scratch object, so only the field under test is exercised); and the existing golf/plant checks still pass unchanged.

## 42. A compact palette grid for the Debug tab, with the terrain/entity split called out where it's real

The Assets tab's palette view used to reuse the same card-list layout as Sprites and Tiles: one `.inspect-tile` per color, a swatch plus a two-line caption (index, then the full `hsl(...)`/`#hex` string) underneath, laid out with `grid-template-columns:repeat(auto-fill,minmax(96px,1fr))`. That layout makes sense for sprites and tiles, where each cell's *content* varies (a whole rendered image per cell) — for a palette, where every cell is one flat color, the caption line spread 16 colors out over multiple screens' worth of scrolling for no information a compact grid couldn't show just as well.

Replaced with a dense 8-wide swatch strip (`.pal-strip`, new `.pal-swatch`): each color is one small square, the index is an overlaid badge (white text with a dark blurred halo — legible against any background color without computing per-swatch contrast), and the full color string moved to a `title` tooltip rather than always-on caption text.

**The terrain/entity split, called out — but only when it's real.** §41 established that `generatePalette()`'s procedural mode (`paletteMode:1`) *structurally* generates two different ramps: indices 0-7 from a muted "base" range, 8-15 from a brighter, more saturated, hue-separated "accent" range — a real, code-enforced guarantee for every procedural cart. So for `paletteMode:1`, the grid renders as two labeled groups, "Terrain / backdrop (0-7)" and "Entities (8-15)."

For `paletteMode:0` (curated banks), that same split does *not* hold: `CURATED_BANK`'s own header comments show bank 0 (flappy) puts its entity colors — bird, pipes — at indices 0-7 and its *backdrop* colors (sky, ground) at 8-9, the opposite of bank 1's (dungeon) convention, where 0-7 is terrain and 8-15 is the player/monster. A hand-picked bank has no fixed index-role convention at all; labeling it "terrain/entities" would assert something that particular bank doesn't do. So curated-mode carts render as one flat, unlabeled 16-swatch grid — an honest reflection of "here are 16 colors" rather than a guess dressed up as structure.

`test/smoke.js` gained two checks: a curated cart's Assets tab renders exactly 16 swatches and zero group labels; a procedural cart's renders exactly 16 swatches under exactly two labels, "Terrain..." and "Entities...".

## 43. Collapsing to one palette algorithm: a fixed hue triad, and the last of `paletteMode`

A design conversation, not a bug report, prompted this one: "is Flappy Bird the only game not using the programmatic palette?" It wasn't — Water the Plant and Cave Crawler also used `paletteMode: 0` (a hand-picked 16-color bank baked into the runtime, `CURATED_BANK`), three carts total, not one. The follow-up question was direct: treat "every cart's colors are pure math, no baked-in art" as a deliberate creative constraint, and collapse the curated-bank escape hatch entirely.

**Why `CURATED_BANK` existed at all.** Cave Crawler's own comment explained it plainly: §41's procedural mode generated exactly *two* ramps (terrain, one accent hue for everything else), but a dungeon needs *three* independent colors — walls/floor/stairs, the player, and the monster. Two entities sharing one accent ramp, differentiated only by shade, was the actual bug behind an earlier "enemies blend into the background" report. A hand-picked bank was the workaround; it was never fixed at the algorithm level because the algorithm only had one accent hue to give.

**The fix: a third ramp, placed by a fixed hue triad, not a second free parameter.** Splitting the 16 indices further — 8 terrain, 4 "entity A," 4 "entity B" — is the easy part. The harder question is where entity B's hue goes. The tempting answer, "just clamp a second author-supplied offset the same way §41 clamped the first," turns out to be wrong: two *independently* clamped hues can each individually be far enough from the terrain hue while still landing close to *each other* — the exact failure this feature exists to prevent, just moved one level up. The actual fix anchors entity A at `terrainHue + 120deg` and entity B at `terrainHue + 240deg` — a true color triad, the same relationship as red/yellow/blue on a wheel — with a small (~9deg) author-steerable wiggle around each fixed anchor rather than a free-standing offset. Every pairwise hue distance (terrain-A, terrain-B, A-B) is then a fact about 120deg-apart anchors and bounded wiggle/shading, not about what any particular cart's author happened to pick — verified by a brute-force sweep across base hues and both wiggle bytes at their extremes, not just by the anchor arithmetic (the same lesson from §41's contrast-metric miss applies here: check the actual rendered output, not the formula you think produces it).

That brute-force check caught a real miscalibration before it shipped: the first constant choice (15deg wiggle + 18deg hue-drift shading, both reused unchanged from §41's single-accent-ramp tuning) looked safe by the anchor math but only guaranteed 54deg between two entity ramps once each ramp's own hue-drift shading was accounted for — the shading pushes each ramp's actual rendered hues past its anchor, eating into the 120deg gap from both sides at once. Retuned to a 9deg wiggle / 6deg drift (sum ≤15deg per side) restores a proven ≥90deg entity-to-entity floor and ≥105deg terrain-to-entity floor, confirmed the same way: sweeping real `generatePalette()` output across base hues, saturation/lightness ranges, and both wiggle bytes at every combination of extremes, not trusting the arithmetic that predicted it.

**The trade-off, stated plainly rather than discovered by surprise.** A fixed 120deg triad cannot reproduce every natural color scheme — Flappy Bird's blue-sky/green-pipes/yellow-bird is a near-analogous pair (green, yellow) plus one outlier (blue), not an even triad, and no separation-guaranteeing algorithm can honor "these two entities should look almost the same hue" while also guaranteeing they never collide; that is a contradiction in terms, not a bug to fix. Migrating Flappy Bird meant accepting the reinterpretation the triad actually produces (green terrain, blue bird — "bluebird over green pipes," a coherent scheme nobody chose by hand) rather than chasing the original hues. The same happened for Water the Plant (warm terrain, +120deg lands on green — a plant — and +240deg lands on blue — the water that grows it, a happy accident of the arithmetic) and for every already-procedural cart, whose entity sprites had to be checked against which of the two new anchors (not always "A") actually reproduced the intended look: Race Car's cars moved from a freely-offset accent hue to entity B specifically because +240deg from its blue terrain hue lands on green, while +120deg lands on pink.

**The collapse itself.** `CURATED_BANK` and the `paletteMode` field are gone — `generatePalette()` no longer branches on anything, and the binary format is one byte shorter for it (`formatVersion` bumped 2->3, no compatibility branch, same policy as every prior breaking bump this project has made). Cave Crawler's gold tiles, which used to reach into the old single accent ramp's brightest indices (14/15) directly rather than through any sprite/entity path, moved to the terrain ramp's own bright end instead (indices 6/7) — with a warm terrain hue, browns and golds are close hues to begin with, so this reads as a genuine improvement, not a downgrade forced by the format change.

Verification: every cart's builder re-checked headlessly through the real `compileCartSource`/`generatePalette` pipeline (not a hand reimplementation) after each edit; the full `test/smoke.js` suite, whose palette-contrast check now covers all 8 shelf carts uniformly (no more paletteMode branch to special-case) and checks entity-to-entity separation in addition to terrain-to-entity; and real Playwright screenshots of all 8 games side by side, the same discipline that caught §41's two follow-on bugs, applied again here before calling it done.

## 44. From a fixed hue triad to author-steerable hints, plus a shared "ink" outline shade

§43's fixed 120deg/240deg triad shipped, and it worked structurally — every cart got three independent hues, guaranteed separated. It also made every cart look like the same three families of color: some blue or brown terrain, some pink, some green, never a yellow, red, or orange in sight. That's a direct consequence of the anchor being *fixed*: rotating a fixed 120deg twice around whatever narrow range of terrain hues carts actually tend to pick revisits the same few hue neighborhoods project-wide, no matter what any individual cart's author actually wants. A cart that wants a yellow entity has no way to ask for one if the algorithm insists on placing it 120deg from wherever the terrain hue happens to be.

**Absolute hints, not relative offsets.** `paletteParams[6]`/`[7]` (entity A/B) changed meaning from "offset from the terrain hue" to "the hue I actually want this ramp to read as" — an absolute point on the wheel, scaled across the full byte range (`hintByte * 360/256`, `hueHintToDegrees`) rather than reusing `baseHue`'s raw-byte-as-degrees convention (which tops out at 255deg and can never reach a hue like 350). Authoring a cart with this scheme means picking the *color* you want and writing down its hue, not reverse-engineering an offset that happens to land there. The hint is honored exactly whenever it's already far enough from its neighbors, and nudged to the nearest edge of a forbidden arc (`clampOffsetFromAnchor`, `MIN_HUE_SEPARATION`) only when it isn't — entity B checked against both the terrain hue and wherever entity A actually landed, since two independently-clamped hues can each be individually far enough from the terrain hue while landing right on top of each other, the same failure mode §43's write-up already flagged for a naively-reused single-offset design.

**Discovering `MIN_HUE_SEPARATION`'s real ceiling by trying to satisfy a real request.** An intermediate draft picked 100deg, which looked comfortably stricter than §43's proven ~90deg floor. It made "yellow bird, green pipes, blue sky" — the concrete example that motivated hints in the first place — geometrically unreachable: yellow and green sit only ~70deg apart on the wheel, and no separation floor above 70 can ever honor both as independently placed hues at once, regardless of where the third (blue) anchor goes. Brute-force sweeping confirmed it wasn't a tuning problem, it was a contradiction — at 100deg, exactly one hue (a pink, ~310deg) satisfies "far enough from both a blue terrain and a yellow entity A," which isn't a green. Lowering to 70 is what actually makes the request satisfiable (verified: sky 211deg, bird 57deg, pipes 133deg, all three simultaneously legal), at the cost of tolerating adjacent-but-still-distinct hue pairs the original design was trying to forbid — a deliberate trade, not an oversight, since sub-40deg *collisions* (the actual "blends into the background" bug reports) are a completely different, much smaller arc than 70deg apart.

**Flappy Bird as the worked case.** Terrain became the sky (blue, lightMin=20 for open daytime blue), entity A became the bird (hinted yellow), and entity B — otherwise unused, since Flappy Bird has only one character — became the pipes (hinted green), with `backdropGroundIndex` pointed at entity B's own dark shade so the ground reads as the same green as the pipes instead of a fourth, unrelated hue. The three-ramp split from §43 already supported this; hints are what made "yellow bird, green pipes, blue sky" *specifiable* rather than a coincidence of arithmetic.

**A second miss, caught live: hue-drift shading could still turn "yellow" into "lime."** Racer's entityB hint originally targeted hue ~67deg — arithmetically "yellow" by the hint alone, but 67deg is already deep in yellow-green/chartreuse territory once rendered, and the ramp's own hue-drift shading (below) pushed the most-saturated, most-visible swatch further toward green from there. Retuning the *hint* alone (down to ~50deg, solidly yellow) fixed Racer, but the same mechanism that caused it was still live for any other yellow-hinted cart, including the newly-rebuilt Flappy Bird — which is exactly what the next fix addresses.

**Entities had no genuinely dark shade, and adjacent ramp steps read as blurry.** A live look at Flappy Bird's own bird (its own smoke test, by virtue of being the first thing rendered) surfaced two more concrete defects the hue/saturation floor alone didn't catch: the ramp's darkest step (`ACCENT_LIGHT_MIN=45`) never got dark enough to read as a real outline color, and the wing and body — adjacent steps on a 4-shade ramp differing only by a small hue-drift and a lightness step — sat close enough to blur into each other rather than read as two distinct parts. Real palettes commonly cheat exactly here: ramps that are otherwise independently hued still converge on a shared near-black at their darkest step, so that step reads as a consistent outline/pupil/shadow color regardless of which entity it belongs to, instead of each ramp supplying its own hued-but-still-fairly-light "dark" shade.

`fillEntityRamp` now reserves index 0 of every entity ramp for exactly that: a fixed, low-saturation near-black (`INK_LIGHTNESS=12`, `INK_SATURATION=28`, at the ramp's own undrifted hue) computed outside the hue/sat/light curve entirely, rather than as its t=0 endpoint. That swatch doesn't need to satisfy the hue-separation guarantee the way a lighter, more saturated swatch would — a color that dark and that desaturated doesn't read as "a hue" in the first place, so it can't visually collide with a neighboring ramp regardless of which anchor it's parked at (confirmed by re-running the same brute-force sweep with the ink swatches included: the floor is unchanged, 52deg/50deg, because the ink hue is exactly the already-separated anchor value). Freeing the ink step from the curve also means the remaining three visible shades get the *whole* hue-drift/saturation range to themselves instead of sharing it with a fourth step, which directly widens the gap between what used to be two adjacent, easily-confused mid-ramp shades — and saturation now falls monotonically from the darkest visible shade to the palest highlight (replacing a previous peaked curve that tapered saturation at *both* ends), since the ink step already covers the "desaturated dark" role and the visible shades are free to stay saturated all the way down.

**The lime bug, fixed at the root.** With the ink step absorbing the true dark end, the hue-drift direction itself turned out to matter: the most-saturated visible shade was drifting *upward* in hue (toward green), which is exactly what turns a yellow-hinted anchor into the same lime-green Racer had already hit once. The fix ties direction to saturation rather than to ramp position in an arbitrary sense — the most-saturated shade now drifts *downward* (toward red/orange) and the palest, least-saturated shade drifts upward — because a yellow anchor sits right on the fragile yellow/lime boundary on the high side, with nothing but unambiguous orange on the low side, and no other hue family has an equivalent trap in either direction. Flappy Bird's bird was reassigned along the same lines: the wing/beak now use the most-saturated (orange-drifted) shade and the body uses the ramp's own hinted hue (yellow) directly, recovering the "yellow body, orange wing" look a hand-picked palette gave for free, from a procedural ramp that also guarantees hue separation. The hue-separation floor itself is unaffected by the flip — it's a sign convention on which *sub-step* gets which end of an unchanged `{hue-drift, hue, hue+drift}` set, not a change to the set itself.

Verification, same discipline as every prior round: a brute-force sweep of `generatePalette()`'s actual output across base hues and every extreme hint-byte combination (not hand arithmetic) reconfirmed the 52deg/50deg floor unchanged through the ink step, the saturation-curve change, and the hue-drift sign flip; `test/smoke.js`'s palette checks were updated to exclude the ink swatch from the "reads as saturated foreground" floor (it's deliberately not supposed to) and to check the ramp's lightest shade — rather than an arbitrary "middle" index that no longer means the same thing once the ink step stopped being part of the curve — against the terrain's own mid-lightness; and real Playwright screenshots of all 8 carts, plus a zoomed-in crop of Flappy Bird's bird specifically, confirmed the outline reads as a real dark edge and the wing reads as a distinct orange against a yellow body rather than a same-hue blur.

## 45. Race Car: a wider track, and grass as a real wall instead of a friction penalty

Two follow-on requests after the palette round: a wider track (three cars racing side by side had barely more than their own combined width to share at `trackWidth=5`), and a hard stop for driving off-road — until now, grass was just a much higher friction constant (`FRICTION_GRASS`), and a car with enough speed could sail straight across open grid indefinitely with no boundary at all.

**Width: 5 to 7, not to some rounder-looking number.** `stampPerp` (the map generator's straight/curve stamping routine) always stamps `2*half+1` tiles, `half = floor(trackWidth/2)` — an odd width keeps the centerline actually centered; an even width silently stamps one tile wider than asked (`half` floors down, but the loop's `-half..half` inclusive range is symmetric regardless), which would make the *requested* number and the *actual* tile count disagree. 7 keeps that invariant and was checked against the existing 80x65 grid at trackWidth 5, 7, and 9 by calling `buildTrack()` directly and counting any road/rumble tile that landed on the grid's outer ring (a proxy for "the stamp tried to go further and got clipped") — zero at every width tried, so the wider stamp has plenty of room on this cart's existing grid.

**Why the fix isn't `MOVE_SOLID`.** That opcode already exists precisely for tile-collision (the platformer and Castle Crusher both rest entities against solid tiles with it) and its solidity test is `ctx.tileSurface(tile) !== 0`. Race Car already overloads that exact function for something else: its own on_tick reads `GETTILE`+`TILE_SURFACE` every frame to pick a friction constant, and depends on getting three *different* values back (road, rumble, grass) to do it. Reusing `MOVE_SOLID` for wall collision would mean deciding a single surface value per tile that's simultaneously "this tile's friction is X" and "this tile is/isn't solid" — road and rumble both need to read as nonzero-but-different for friction, which would make them read as solid too if solidity used the same function. Hand-rolling the same axis-separated collision `MOVE_SOLID` does, but testing `GETTILE`'s *raw* tile id against grass specifically (id 1, `MAP_EDGE_TILE` — also what any off-grid query returns, so the same check doubles as a grid-boundary wall for free) instead of going through `TILE_SURFACE`, keeps the two concerns independent: friction still reads three distinct surfaces, solidity only cares about one of them.

The check commits X and Y separately (matching `MOVE_SOLID`'s own edge-by-edge order — resolve X, then test Y against the *already-updated* X) and zeroes the blocked axis's velocity rather than merely refusing the position update, so a car that hits the wall head-on comes to rest instead of holding a nonzero velocity it can never spend — the same "stop, don't just clip" feel `MOVE_SOLID` gives a platformer character.

Verified with a real physics run, not just a compile check: player car steered dead straight (Gas held, no turning) for several seconds of real simulated time — guaranteed to drive it past the track's first turn onto what used to be open grass — and confirmed the player comes to rest still on a road tile with zero velocity, never on grass. Added to `test/smoke.js` as a permanent regression check, the same "drive the real bytecode through Playwright and read the World's actual entity/tile state back" discipline as the Mini Golf swing check (§38).

## 46. §45's real wall exposed the AI's real steering: a straight-line seek with no path memory

Reported within a day of §45 shipping: the AI cars drive fine, then permanently stop dead partway through the first chicane. Headless simulation reproduced it immediately — both AI cars parked, velocity zero, still targeting the same checkpoint they'd been aiming at since well before the chicane.

**How the AI actually steers, and why sparse checkpoints used to be enough.** Every non-player car's `on_tick` does exactly one thing: compute the angle from its current position to `GET_CHECKPOINT(self.props[9])` — its current target, one of a small, fixed set of waypoints laid down by `buildTrack()` — and turn toward that angle by a clamped amount, then accelerate forward. There is no path-following, no look-ahead, no wall-awareness at all; it's a pure "turn toward the next dot" controller, and it worked as long as a straight line to that dot stayed roughly on the track. The track's "double chicane" (§18) breaks that assumption on purpose — a jog with four direction changes packed close together — but it went unnoticed because §45 hadn't shipped yet: with grass merely slower rather than solid, an AI cutting the chicane's inside corner just drove across the "wall" at reduced speed and reconverged once its straight line cleared again. §45 removed that silent escape hatch, and a corner sharper than the direct line to the next (now-distant) checkpoint became a permanent trap instead of a shortcut.

**The fix: more waypoints, not smarter steering.** A new `TRACK_TOKENS.WAYPOINT` registers an AI steering target exactly like `CHECKPOINT` does, minus the visible checkered startline tile `CHECKPOINT`/`START_FINISH` stamp — a plain new numeric value inside `track.tokens`, which was already just a raw byte array, so this is a zero-format-impact addition, not a new field. One `WAYPOINT` was placed right after each of the chicane's four turns, so the AI is never asked to aim more than one turn's worth of geometry ahead. `NUM_CHECKPOINTS` (the modulo the checkpoint index wraps on, and therefore what "index 0 again" — a completed lap — actually means) had to grow from 4 to 12 to match; while checking that count, a second, unrelated latent bug turned up — the cart's own `NUM_CHECKPOINTS` constant had been sitting at 2 (not 4) since some earlier, shorter version of this track, silently orphaning half the original checkpoints (indices 2 and 3 were registered by `buildTrack()` but never once reachable, since the index only ever wrapped between 0 and 1). Both counts are now confirmed the same way §18 insists on for any track geometry claim: by calling `buildTrack()` directly and reading `checkpoints.length` back, not by counting tokens in the source by eye.

**Waypoints alone traded a dead stop for a slower failure: an orbit.** With denser waypoints but the original `CHECKPOINT_RADIUS` (14px — under 2 tiles), one of the two AI cars reliably got stuck circling the chicane's tightest turn forever instead of driving into a wall — not a bug in the waypoint placement, but the same steering limitation showing up a level down: the controller has no braking or turn-radius model, so it approaches a waypoint at full speed, can't turn tightly enough to actually converge on a point that close to a sharp turn, flies past the capture radius, and immediately re-locks onto the *same*, now-behind-it target — a limit cycle, not a wall collision, so it wouldn't have shown up as a fault either. Raising `CHECKPOINT_RADIUS` to 24 gives a fast flyby enough margin to still register as "reached" before the AI needs to have already completed the turn. Confirmed by simulating both AI cars for real time end to end: at 14, this reproduced on roughly half of runs (whichever car's slightly different lateral starting offset carried it wide enough to miss the capture zone); at 24, both cars complete lap after lap without a single flyby across repeated runs.

Both failure modes share a lesson already stated once this project (§45's own write-up): a regression here isn't a `cartFault` — it's a checkpoint index, or a velocity, that quietly stops changing. `test/smoke.js` now drives both AI cars through a freshly-reloaded world (the previous check's four-second player-at-the-wall state was contaminating this one, since neither check reloads the cart, and a chance on_collide bump between the parked player and a passing AI car was as good an explanation for one early failed run as the steering bug itself) and waits — via a real condition, not a fixed sleep — for both cars' checkpoint index to clear both chicanes, rather than trusting the absence of a fault.

## 47. Tighter turns, more traction, and the player's own lap counter joins the list of things §46 broke without a fault

Two more requests, one of them a bug report: tighten the car's handling a little, and the "Lap" HUD readout never advances past 1/3 no matter how far the player actually drives.

**The lap counter bug is the exact same class of failure §46 just finished cataloguing, on the *player* car this time.** The "Lap" HUD line reads `g_car_player`'s own lap prop (`hudSpec`'s `sourceKind:1`/`srcB:10`) straight out of the World — there's no separate display-side counter to get wrong, so a lap readout stuck at 1 means the underlying prop is stuck at 0, which means the player's own checkpoint index (`props[9]`) stopped advancing somewhere, for the identical reason an AI car's did in §46: the shared on_tick checkpoint-capture code (`DIST` to `GET_CHECKPOINT(props[9])` against `CHECKPOINT_RADIUS`) applies to every car by the same bytecode, player included, and §46 had only tuned `CHECKPOINT_RADIUS` (14->24) far enough to satisfy the *AI's* particular failure mode (a flyby past too-tight a capture zone), not a human's.

The two failure modes need different radii because the two drivers reach a waypoint by different paths. The AI beelines straight at it every tick, so its worst-case miss is bounded by how far it overshoots before correcting. A human (or anything driving a real racing line rather than a point-seek) can stay entirely on-road through a turn while never coming near the exact pixel a waypoint sits at — each turn's solid block is a trackWidth-square (7 tiles = 56px) centered exactly on its checkpoint, so a path that stays right at the block's far corner the whole way through — fully on-road throughout — is still 28*sqrt(2) =~ 39.6px from center at closest approach. 24px covers the AI's flyby margin but not this; a real driven line can legitimately never satisfy it, freezing that car's checkpoint index (and therefore its lap count) permanently, with nothing that reads as a fault anywhere. Raised to 40 — enough to cover that worst case outright, not a value picked because it happened to test clean. Reproduced and confirmed with a purpose-built imprecise-driver bot (headless, 150ms reaction ticks and a 15deg dead zone before correcting, deliberately coarser than the AI's own per-tick seek, meant to approximate how a human actually drives rather than how the AI does): got permanently stuck at checkpoint 5 at radius 24, exactly as reported; completed multiple full laps cleanly at radius 40, with the AI cars unaffected (if anything more reliable, same as raising the radius already was in §46).

**Handling: `TURN_RATE` 2->2.4, `FRICTION_ROAD` 0.015->0.02, both a deliberately small bump ("just a little").** This physics model has no lateral-grip or slip-angle term at all — a car's velocity is a single 2D vector that only changes via friction decay (uniform in every direction) and new acceleration added along whatever heading the car currently faces; there's no separate mechanism that makes cornering feel "grippy" or "slidy" on its own. That means the two requests map onto the two knobs that actually exist: `TURN_RATE` controls how fast the car's *heading* itself swings per tick of input (higher = a genuinely tighter turn radius at a given speed), and `FRICTION_ROAD` controls how fast *old*-heading momentum bleeds off (higher = a new heading's acceleration takes over sooner instead of carrying a wide drift through the turn) — the closest this model gets to "traction," since friction is the only term governing how quickly velocity actually catches up to a change in heading. `AI_TURN_GAIN` scales `TURN_RATE` for the AI's own clamp, so the AI corners marginally tighter too, for free.

Verified the same way as every physics change on this cart: the sloppy-bot lap test above still completes cleanly at the new constants (confirming the traction/turn bump didn't reintroduce the wall-collision or flyby failure modes from §45/§46), the AI-progress regression check in `test/smoke.js` still passes, and a short headless spin-in-place measurement (full lock turn, held Gas) confirmed the turning circle is visibly smaller without needing to eyeball it off a screenshot.

## 48. The AI cars get their own entity type, so they're not just palette-shy copies of the player

A small ask with one real wrinkle: the two AI cars used the exact same sprite as the player car (`carShapes`, entity B's ramp), so all three cars on track were the same yellow — no visual way to tell "me" from "them" beyond position.

**Why this needs a second entity type, not just a color tweak.** Every renderable entity draws through `entityTypes[e.typeId].assetIndex` — a fixed lookup on the entity's *type*, not something an individual entity or its spawn call can override per-instance. There's no "spawn this car but point it at a different sprite" primitive; the only way to give a subset of entities of the same shape a different sprite is a second entity type with a different `assetIndex`. Added `aiCarShapes` (identical geometry to `carShapes`, entity A's ramp — 8/9/10/11 — instead of entity B's 12/13/14/15) and a third `entityTypes` entry (index 2) that's otherwise identical to the player's own (same `collisionW`/`collisionH`, same `extFieldCount`, so the same props layout every car-handling hook already assumes) with `assetIndex:2`. `racerInitCarBlock` (previously a hardcoded `SPAWN 0`) took a `typeId` parameter so the two AI cars spawn as type 2 while the player still spawns as type 0. Entity A's hint for this cart (~250deg, DESIGN.md §44) was already picked to stay clear of entity B's yellow without ever being *used* by anything — it renders as a vivid purple/violet, a real, independently-hued "opponent car" color already guaranteed far enough from the player's yellow by the same hue-separation math every other cart's two entity ramps lean on.

**The one thing this breaks if left alone: car-to-car bumping.** `on_collide`'s bump-mix physics (the velocity LERP and spark particle on car contact) gated on both colliding entities' prop 4 (every entity's prop 4 is set to its own `typeId` automatically at spawn, a generic runtime convention any cart can rely on without setting it itself) equaling 0 — "both cars," expressed as "both are the player's own type," which was harmless while every car *was* that type. With the AI cars now type 2, a player-vs-AI or AI-vs-AI collision would silently stop triggering bump physics entirely (both particles and the velocity exchange), since neither pairing would satisfy "both equal 0" — a regression that wouldn't show up as a fault, just as cars quietly passing through each other. Rewritten to check prop 4 *!=* 1 (the particle type) instead of *==* 0: "is this a car" is more simply "is this not a particle" than "is this specifically the player's car type," and generalizes correctly the moment a second car type exists. Verified directly — not just inferred from the AI/wall regression tests still passing — by forcing a player/AI overlap with opposing velocities headlessly and confirming both the velocity exchange and a new particle entity actually appear.

## 49. A finish line, and a kernel bug it took direct grid inspection to actually find

The ask sounded simple — "add a finish line" — but the track already had one, sort of: `buildTrack`'s `START_FINISH` token was always stamping a checkered tile there. Asked to clarify, the real request turned out to be two things: make that tile visually distinct from an ordinary mid-lap `CHECKPOINT` gate (both stamped the exact same tile, id 4, so a checkpoint and the actual finish line always looked identical), and add feedback for the moment a lap actually completes, not just the existing end-of-race HUD lines.

**Two tile ids, not one, so two different bitmaps.** `TILE_CHECKPOINT` (id 5) is new, used for `CHECKPOINT` tokens; `TILE_STARTLINE` (id 4) is now `START_FINISH`-only. This is a kernel change, not a per-cart one — `buildTrack` is shared with Mini Golf, whose own `START_FINISH`/`CHECKPOINT` tokens are the tee and the hole, not a lap gate — so it had to not assume every cart wants these to look different. Mini Golf already marks its hole with a separate flag entity rather than tile art, so it just points the new id at the same pixel data (`teePixels`) and the same `tileSurfaceOverrides` target (fairway friction) it already used for id 4 — genuinely zero visual or behavioral change there, confirmed by its own swing regression test still passing unmodified. Race Car's own `startPixels` also got a contrast fix while touching this: the old checker alternated terrain shades 6 and 7, adjacent steps on the same ramp barely 8 lightness points apart — geometrically a checkerboard, practically invisible. Now alternates 0 and 7, the ramp's two extremes, guaranteed high-contrast regardless of the cart's own terrain hue. The new `TILE_CHECKPOINT` renders as plain road, so mid-lap checkpoints stop looking like a second finish line entirely.

**The bug the split exposed: the checkered tile had never once rendered, on either cart, ever.** Verifying "does the finish line actually look different now" meant reading the generated grid directly rather than eyeballing a screenshot (the same discipline §18's own track-geometry checks already insist on) — and the direct read showed *zero* tiles anywhere on the grid at id 4, when the stamp width (7) times one `START_FINISH` token should have given exactly 7. The real cause: `START_FINISH`/`CHECKPOINT` tokens never advanced the turtle's position, so — this specific track being a closed loop — the walk's own *closing* curve, whose fill-block position is purely a function of where the loop happens to end, lands close enough to the start to overlap it, and silently overwrote the marker with plain road *before a single frame was ever rendered*. Not a coincidental one-off: any lap-based closed track's final curve is, by construction, near its own start — this would have bitten any cart shaped like this one, immediately, the instant the marker's *appearance* actually mattered (which it never had, until this round gave it a distinct look worth checking for). The fix moves the actual tile-stamping for `START_FINISH`/`CHECKPOINT` out of the main walk entirely: each marker's position/direction is recorded as the walk passes it, and every recorded marker is re-stamped in one final pass *after* the whole grid is built — guaranteed to be the last write to those tiles regardless of how the loop's geometry happens to close. Verified the same way the bug was found: reading tile-id counts directly off the generated grid (7 for the single `START_FINISH`, 21 for the three `CHECKPOINT`s — exactly `stampWidth * markerCount`), not by eye.

**The "Lap complete!" flash.** A new global, `g_lap_flash`, sets to `LAP_FLASH_DURATION` (90 ticks, 1.5s at this cart's 60Hz) whenever the *player's own* checkpoint index wraps back to 0 — checked with the same self-vs-`g_car_player` identity comparison `on_tick` already uses to gate AI steering, since the lap-complete branch itself runs for every car and would otherwise flash on an AI car's lap too. Ticks down once per simulation step in `on_frame` (not per-car in `on_tick`, which runs three times a step — once per car — and would drain it 3x too fast). A new `hudSpec` flag line (label-only, shown while its source is nonzero) reads `g_lap_flash` directly; it doesn't repeat the lap number, since the persistent "Lap: X/3" line above it already shows that continuously. Verified end to end with a purpose-built driving bot: drove a full lap, read the live HUD DOM text at the moment of crossing (`"Lap: 2 / 3   Lap complete!"`), and confirmed the flag cleared again almost exactly 1.5s later.

## 50. §49's finish line had a free-floating end, and its lap counter was firing early

Two follow-on reports, both about the same finish line §49 had just made visible for the first time: it sat in a corner rather than a straight, and the lap counter appeared to advance a beat before the car actually reached it.

**The corner placement.** `START_FINISH` is always token 0 — the walk's very first position — and for a *closed* loop, that position is also wherever the walk's *last* token leaves off (that's what "closed" means). The last token in this track's sequence was always a curve, so the finish line was structurally guaranteed to sit right where the closing curve exits directly into the first straight — a corner, not a straight, with nothing but the curve's own turning-radius geometry on the near side. §49's contrast fix made this visible for the first time; the placement itself was never new. Fixed by splitting 12 tiles off the leading straight (`S(4)` -> `S(2)`) and adding them back as a new trailing `S(2)`, right after the closing curve — same total straight length, just redistributed across the wrap point, so the loop still closes at exactly `startGX`/`startGY`/`startDir` (checked the same way as every geometry change on this track: simulate the walk, confirm the final position matches). That alone clipped the grid: the closing curve, it turns out, already sat only 7 tiles from the grid's left edge, and shifting 12 tiles worth of straight off the leading run shifts *everything downstream of it* — including that already-tight corner — 12 tiles further left with it. `startGX` moved 8->20 and `gridW` 80->90 to give the whole loop room, re-verified with the same "simulate and count clipped tiles" check §45 introduced rather than picking a bigger number and hoping. The finish line now has a full 7 tiles of plain road on both sides before hitting anything else.

**The lap-counter timing.** A real bug, not a perception issue: the lap-complete branch fired when a car's checkpoint index *wrapped* to 0 — which happens the instant a car reaches checkpoint `NUM_CHECKPOINTS-1` (the last ordinary checkpoint), not when it subsequently reaches checkpoint 0 (the actual finish line) some distance further down the track. Mathematically, "index becomes 0 after incrementing" and "index was `NUM_CHECKPOINTS-1` before incrementing" are the same event — the code was, in effect, treating "you just left the last checkpoint" as equivalent to "you just crossed the finish line," which were only ever the same tick because nobody had looked closely enough to notice they aren't. Fixed by checking the checkpoint index *before* it advances rather than after: a lap only completes when the car reaches its *currently targeted* checkpoint and that target was already 0 (meaning an earlier tick's wrap already wised the target to 0, and *this* crossing is the car genuinely arriving there) — not merely when this crossing happens to be the one that sets the target to 0 for the next lap.

That fix immediately surfaced a second, adjacent bug of its own: every car spawns exactly on checkpoint 0's own position (it *is* the finish line), and the checkpoint index used to start at 0 to match. With lap-completion now meaning "reached checkpoint 0 while it was the active target," a car starting with target 0 and already standing on top of it satisfied that on the literal first simulated tick — crediting a full lap before a single frame of input had been processed. Fixed by starting the checkpoint index at 1 instead: cars spawn already aimed at the next real checkpoint, not trivially re-"reaching" the one they're standing on.

Verified end to end with the same driving-bot methodology as §49/§50's own predecessors: the lap counter now stays at 0 through the entire first circuit (previously ticking up to 1 within the first few milliseconds) and only increments at the same real-time moment the car's position converges on checkpoint 0's actual coordinates — confirmed against the "Lap complete!" HUD flash timing landing at that same moment, not a lap early.

## 51. A second, explicitly-2x pass on handling — same knobs, same discipline, no fresh guessing

A follow-up to §47's "just a little" tighter-handling request: make it tighter still, by exactly double what changed last time. `TURN_RATE` 2.4->3.2 (+0.8, double §47's own +0.4) and `FRICTION_ROAD` 0.02->0.03 (+0.01, double §47's +0.005) — the request specified the *delta* relative to the previous change, not a new target value, so the previous round's own before/after was the input to this one rather than a fresh judgment call about what "tighter" should mean numerically.

Nothing about *which* two knobs govern "tighter turns" and "more traction" changed from §47's own reasoning (this physics model still has no separate lateral-grip term; `TURN_RATE` is still the only thing that changes how fast heading itself swings, `FRICTION_ROAD` still the only thing that changes how fast old-heading momentum concedes to a new one) — only the magnitude did, by exactly the requested factor. `AI_TURN_GAIN`'s own turn clamp still scales with `TURN_RATE`, so the AI's own cornering tightened proportionally too, same as last time.

At this larger delta, the two failure modes §45/§46 fixed (driving off the track entirely, and an AI car flying past a too-tight waypoint into a permanent loop) were both real risks worth re-checking rather than assuming a "just double it" change couldn't touch — a meaningfully tighter turn radius changes exactly the geometry those fixes depend on. Re-verified with the same tools as every prior handling change on this cart: the sloppy-bot lap test (150ms reaction, 15deg dead zone) still completes multiple clean laps, `test/smoke.js`'s AI-progress regression check still passes at the higher `AI_TURN_GAIN`-scaled clamp, and a headless spin-in-place measurement showed the turning circle visibly tighter and noticeably faster to settle into a stable radius than §47's own (55px steady-state diameter, reached almost immediately, versus §47's wider and slower-to-settle spiral).

## 52. Shelf thumbnails were drawing every cart's map at a fixed (0,0), not wherever play actually starts

Reported as "the cars are offscreen to the right" on Race Car's own shelf card — and they were, exactly: `buildCardThumbnail()` (the shelf's static preview renderer, DESIGN.md §23) drew a throwaway `World`'s map canvas at `(0,0)` and every entity at its raw world position, no camera offset applied at all. That's harmless for a cart whose whole world fits in one screen (backdrop-only carts, or a map no bigger than `screenW`/`screenH`), which is every shelf cart *except* the ones with a scrolling camera — but Race Car's own track is a good deal bigger than one screen by design (DESIGN.md §18), and after §50's own grid widening (`startGX` 8->20, `gridW` 80->90 — moving the finish line off a corner), the actual spawn point sits well past x=160. A thumbnail drawn at literal `(0,0)` was always going to show empty grid past the map's actual corner, with every car — drawn at its real, unshifted world x-coordinate around 164 — rendered off the right edge of a 160px-wide canvas.

The live renderer already solves exactly this problem every frame via `updateCamera()`: follow a declared entity, center the view on it, clamp to the map's bounds. `buildCardThumbnail()` just never called it, because it isn't rendering the live `world` singleton `updateCamera()` closes over — it builds its own throwaway `World` purely to reuse its already-built sprite/tile/map canvases (§23's own design), so it needs its own one-shot version of the same clamped "center on the followed entity" math, computed once against that World's post-`on_init` state (no `alpha` interpolation needed — a static preview has exactly one frame) rather than every render() against a live one. Both the map draw and every entity draw (all three `renderKind`s) now subtract that same computed offset, mirroring exactly what the real per-frame renderer already does. Carts with no `camera` declared are unaffected — the offset stays `(0,0)`, identical to the previous behavior, which was only ever wrong for carts that actually have one.

Verified with a full-shelf screenshot (all 8 cards, not just Race Car's) rather than the one cart that surfaced the report: Race Car's card now shows both AI cars and the checkered finish line properly framed, and every other camera-driven cart (Cave Crawler, Mini Golf) — whose own thumbnails happened to look fine already, since their spawn points are closer to their maps' own origins — rendered identically to before, confirming the fix is additive rather than a behavior change for carts it didn't need to touch.

## 53. Mini Golf's hole finally looks like a hole, and its flag is drawn, not a rectangle

Reported plainly: "what is the lighter patch of tiles at the end of the track, and the red rectangle?" — a fair question, since neither actually looked like what it was. The hole reused the tee's own checkered tile art (a leftover of the `TILE_STARTLINE`/`TILE_CHECKPOINT` split in §49, done for Race Car's benefit; Mini Golf's own `CHECKPOINT` token just pointed the new id at the same pixels rather than getting anything of its own), so it read as a second tee, not a target. The flag was a flat colored rectangle with no pole reading clearly against the fairway, no visual connection to "flag" at all — DESIGN.md's own §39 already flagged this same sprite's *cup ellipse* as a necessary visual cue for where the hole actually was, without addressing that the rest of the shape didn't read as a flag either.

**The hole gets its own tile art.** `holePixels`: fairway-shade corners (blends into the surrounding turf rather than announcing its own tile boundary), a mid ring, and a near-black center — a real dark, roughly round hole rather than a second checkered marker. Mini Golf's own `tiles` array now points id 5 (`TILE_CHECKPOINT`) at this instead of reusing `teePixels`.

**The flag is drawn, not sprited.** Converted the flag entity from a static `SHAPE_RECT`/`SHAPE_ELLIPSE` sprite to `renderKind:2` with its own `on_draw` hook (DESIGN.md §36) — a pole and a small triangular pennant, both plain `DRAW_LINE` segments, redrawn fresh every frame exactly the way Water the Plant already draws its stem. Since the flag is the only `renderKind:2` entity this cart has, `on_draw` never needs to branch on which entity it's running for — every other cart with more than one custom-drawn shape would need that, this one doesn't. The old cup ellipse is gone entirely; the ground tile itself is now the visual cue for where the hole is, which is a more honest cue than an ellipse floating in a flag sprite that was never precisely registered to the hole's own hitbox anyway.

**The hole was a row, not a point — reported live, same session.** `buildTrack`'s `CHECKPOINT` stamp (like every checkpoint/tee marker on this generator) always marks a full `trackWidth`-wide line, edge to edge across the fairway, not a single tile — the same "gate," not "point," convention every other marker uses, because for a lap checkpoint or a tee, that's exactly right. For a hole it reads wrong twice over: visually, it looked like sinking the putt anywhere across the whole width (including right at the rumble edge) should count, and only the actual physics check (`DIST` against the checkpoint's own center coordinate, `HOLE_RADIUS`) ever really did — an easy target smeared across a width nothing about the fairway's difficulty should reward. Fixed in `on_init`, after `GET_CHECKPOINT` returns the hole's center: four `SETTILE` calls revert the other four tiles in that stamped line back to plain fairway by hand, at fixed offsets either side of center along this course's own fixed geometry (hand-verified, like the rest of its layout, against `buildTrack()` directly — the walk reaches the hole heading +y, so the stamped line runs horizontally). What's left is exactly one hole tile, and it's already the line's own centerline point, not an edge one — the same fix that removes the row also puts the one real hole exactly where a hole should be relative to the fairway's own width, not incidentally at its edge.

Verified with `test/smoke.js` (the existing swing regression check, unmodified, still passing — sinking a putt was never affected, only what the fairway looks like around it) and Playwright screenshots at the hole itself: a single dark, round hole at the fairway's centerline, with the flag's pole and pennant clearly readable next to it.

## 54. Corridor: a raycast first-person shooter, drawn entirely from one entity's `on_draw`

Requested plainly: "Make something crazy awesome: a doom like. Use immediate mode and ray cast graphics?" — no existing cart to copy from, and a real question of whether the VM's actual constraints (line segments only in immediate mode, a hard 20,000-opcode budget per single hook invocation, no dynamic arrays, ~24 global slots) could support a screen-column raycaster at all, as opposed to just an empty walkable maze wearing a first-person camera.

**The map is Cave Crawler's generator, put to a completely different use.** `mapGenerator:2`/`buildCave` builds the same cellular-automata wall/floor grid Cave Crawler uses — but here it's never drawn top-down at all. `GETTILE` needs *some* real grid to query, and this was already the one generator that produces an organic, corridor-and-room layout instead of a single racetrack loop or a platformer's flat ground. The automatic top-down map render still happens every frame (nothing about the renderer knows this cart doesn't want it shown) — it's just always fully painted over, because the camera entity's `on_draw` repaints all 160x160 screen pixels, every frame, on top of it. Same generator, genuinely different job.

**One stationary entity does the entire render.** The obvious approach — have the player entity draw itself via `on_draw` — doesn't work: a `renderKind:2` entity's `DRAW_LINE` coordinates are entity-local, translated to screen space by adding the entity's own world position and then subtracting the camera offset (`runtime.js`'s `strokeDrawCmds`), and this cart sets `camera.followGlobal: 255` (no scrolling — the raycast view is computed math, not a scrolled sprite, so cameraX/Y must stay pinned at 0). If the *player* — who walks around the map — were the one drawing, every local offset would drift by however far they'd walked, sliding the whole rendered view off-screen. So the player and the renderer are two different entities: an invisible PLAYER (a fully-transparent sprite, `MOVE_SOLID`-collided against the cave's wall tiles, tracking real x/y/facing) and a CAMERA that's spawned once at world (0,0) and never moves again. The camera's `on_draw` reads the player's position and angle by global handle (`LOADE`, never `LOAD_SELF` — `self` inside `on_draw` is the camera, not the player) and paints in absolute screen-pixel coordinates, which its own fixed (0,0) position makes equivalent to entity-local ones.

**40 rays, not 160 — column-stretching to survive the opcode budget.** A ray per screen pixel (160 rays) would be the straightforward approach, and blows the 20,000-opcode ceiling on its own: a single ray's fixed-step march (there's no floor/frac opcode for true DDA, so it's 14 unrolled steps of one tile each, an 112px lookahead) costs roughly 14 ops per step even before any drawing happens, and 160 of those alone exceeds budget before a single `DRAW_LINE` is issued. Casting 40 rays instead and stretching each one's computed wall slice across 4 adjacent 1px-wide screen columns keeps the march's cost paid once per ray rather than once per pixel, while every pixel column still gets painted — a canvas line stroke is 1px wide with no fill-rect equivalent in this VM's immediate-mode primitives, so "no gaps" means literally drawing that many adjacent lines, there's no cheaper way to cover width. Measured (a standalone Node harness driving `kernel.js`'s `runHook` directly against a synthetic `ctx`, before any of this was wired into a real cart) at ~13,240 opcodes in the worst case — a ray that never hits a wall anywhere within its lookahead, which is the *expensive* case, since the early-exit branch inside the march loop never fires — leaving comfortable headroom under the cap.

**A ray that hits nothing draws nothing wrong — by construction, not by a branch.** Rays beyond the march's 112px lookahead, or genuinely in open space, get a large sentinel distance (2000) instead of a real hit distance. Wall height is `WALL_SCALE / distance` for every ray unconditionally — feeding the sentinel through that same formula yields a wall slice a fraction of a pixel tall, indistinguishable from zero, so the shared draw code never needs a hit/no-hit branch: an "unhit" column is just ceiling above and floor below with an invisible seam between them, which reads as fog/distance haze rather than a rendering bug. The same shared march-loop generator (parameterized only by which label to jump to on a hit) is reused three times — wall columns, monster-billboard occlusion, and the shoot hit-scan — rather than written out by hand each time.

**Monsters are two crossing lines, not sprites — sized, positioned, and occluded by ray math, not a texture.** A monster billboard first checks it's within the render FOV (a bearing/heading comparison, normalized via `NORM_ANGLE`), then casts one more ray — the same march-loop generator again — toward the monster's exact bearing; if that ray's wall-hit distance is less than the monster's own distance, a wall is in front of it and it doesn't draw. A visible monster is an X of two `DRAW_LINE` calls, screen-positioned by its bearing offset and sized by `1/distance` — the same "silhouette in a few strokes, redrawn every frame" technique Mini Golf's flag and Water the Plant's stem already established for `on_draw`, just billboarded instead of anchored to a fixed base. The same cone/range/occlusion shape, with an actual kill instead of a draw, is what the shoot button's hit-scan runs in `on_tick`, edge-triggered off a `g_prev_shoot` global so holding the button doesn't auto-fire every tick.

**Global reuse, not more global slots.** 24 globals total, 9 of them persistent for the whole run (player/monster handles, win/dead/kill state, a contact-damage cooldown, the shoot edge-trigger flag) and 13 pure scratch (`g_s0`..`g_s12`), reused for a completely different purpose in every hook or loop that touches them — the wall-march's step/position accumulators double as the monster-chase AI's target-tile scratch in `on_tick`, the spawn-loop's random-tile-pick scratch in `on_init`, and the shot hit-scan's bearing/distance bookkeeping, all safe because none of those uses ever overlap within a single hook invocation.

**`tileSurfaceOverrides` almost got skipped, and the player would have been unable to move at all.** `MOVE_SOLID`'s solidity test is `tileSurface(tile) !== 0`, which defaults to identity — meaning the cave's own floor id (2) and stairs id (3) would both read as "solid" (any nonzero tile id blocks movement) exactly as wrong as the cave-tile-id collision §16 already found and fixed once for a different cart. Caught by the first headless movement simulation (a standalone `FakeWorld` harness replicating `runtime.js`'s real ctx wiring in plain Node, no browser): the player's position never changed across 60 ticks of held-forward input. `tileSurfaceOverrides: {2: 0, 3: 0}` — the same mechanism run-and-jump and race-car already use for their own non-wall tile ids — fixes it, leaving only the wall tile (id 1, left at its identity value) actually solid.

Verified in three stages, cheapest first: a standalone Node harness driving `kernel.js`'s `runHook` directly against synthetic grids (including a deliberately adversarial fully-open one, to force every ray's march loop to run its full worst-case length with no early exit) confirmed the opcode budget and drawing math before any cart file existed; a `FakeWorld` harness replicating `runtime.js`'s real per-tick/per-hook wiring in plain Node caught the `tileSurfaceOverrides` bug and confirmed movement, monster wander/chase, contact damage, and the shoot hit-scan all behave correctly; and `test/smoke.js`, in a real browser, confirms the shipped cart spawns a player, camera, and three monsters, that walking/turning/shooting all work, and that no `cartFault` is ever raised by the live raycast running every rendered frame. Screenshots confirmed the visual result reads as an actual first-person view — shaded wall columns, a clear ceiling/floor split, a visible monster silhouette, a crosshair — not just a technically-correct wall of numbers.

## 55. `drawCmds` stopped garbaging an object per `DRAW_LINE`, every frame, forever

Reported plainly, about Corridor specifically: "going from no input to pressing input, it waits for like 1 second. But holding down allows moving quickly" — on touch, with the *whole page* (not just the character) briefly unresponsive, "even the debug button."

Couldn't reproduce a literal 1-second stall directly — a Playwright harness recording real frame-to-frame timestamps around a simulated button press showed movement starting within ~27ms, and repeating that under CDP's `Emulation.setCPUThrottlingRate` at 6x (a rough stand-in for a mid-range phone) didn't turn up anything worse than a ~180ms frame gap, uncorrelated with the press itself. CPU throttling alone can't stand in for a mobile device's actual garbage collector behavior, though, and one real difference between Corridor and every other cart *was* findable by inspection: `World.ctxBase.drawLine` (the sink every `DRAW_LINE` opcode calls) pushed a brand new `{x1,y1,x2,y2,color}` object literal every single call, and `runDrawHook` threw the whole array away (`.length = 0`) at the top of every render, before that renderKind:2 entity's `on_draw` ran again. Water the Plant and Mini Golf's flag call this a handful of times a frame; Corridor's raycaster calls it roughly 480-490 times a frame, every frame, 60 times a second — on the order of 29,000 short-lived objects a second, continuously, whether or not anything on screen is actually changing. That's real, avoidable GC pressure unique to this one cart, and a plausible match for "stutter concentrated right where a burst of other activity (a touch event, a style recalc) lands on top of it," even though the mechanism couldn't be pinned down more precisely than that from this environment.

**Fixed by pooling, the same idiom `World.boxPool` already used for collision AABBs.** `drawLine` now reuses whatever object already sits at each index of `drawCmds` from a previous frame (mutating its fields in place) instead of pushing a fresh literal, allocating a new object only the first time a given index is ever used; `runDrawHook` resets a separate `drawCmdCount` to 0 up front (instead of truncating the array) and trims `drawCmds.length` down to that count only *after* the hook runs, so the pooled objects below that length survive to be reused next frame. Once a cart's draw-call count stabilizes (Corridor's does within the first frame or two — it's a fixed 480 wall-column lines plus up to 6 monster-billboard lines plus a 2-line reticle), steady-state `on_draw` allocates nothing at all for its line-drawing output. Both consumers (`strokeDrawCmds`'s Canvas2D path, `glDrawLine`'s WebGL path) only ever read the returned array synchronously within the same frame and never retain a reference, so reusing object identity across frames is safe by construction, not just by testing.

Verified with `test/smoke.js` (unmodified — Corridor's own gameplay check, and Water the Plant/Mini Golf's `on_draw`-dependent checks, all still pass) and a fresh screenshot confirming the rendered output is pixel-identical to before. Whether this was *the* cause of the reported stall or one contributing factor among several a real device surfaces and this environment can't fully reproduce remains genuinely open — flagged below.

## 56. The actual smoking gun: ~27,800 throwaway `<canvas>` elements a second

§55's `drawCmds` pooling shipped honestly flagged as unconfirmed — a real inefficiency, fixed regardless, but not proven to be *the* cause. Asked directly what work only happens on turning/moving/shooting specifically (as opposed to sitting idle), tracing both the cart's own bytecode and `World.step()` turned up nothing: `MOVE_SOLID` runs unconditionally every tick regardless of input, the prev-props interpolation snapshot and the O(n²) collision sweep run unconditionally every tick, and the raycaster's `on_draw` runs unconditionally every *frame* — the only input-gated code in the entire cart is a handful of cheap arithmetic opcodes (turning: one `SUB`/`ADD`; moving: a `SIN`/`COS`/`MUL`). None of that could plausibly cost a second on any hardware. Which meant the right question wasn't "what's different when you press a key" — it was "what's already constantly expensive that §55 didn't touch."

Found it in `color-utils.js`'s `cssColorToRGB`: for any `hsl(...)` string (which is *every* palette entry — `generatePalette` never emits hex, see `hsl()` in kernel.js) it resolves the color by creating a brand-new `<canvas>` element (300x150px, the HTML default, since nothing sets its size), fetching a 2D context, setting `fillStyle`, and reading the browser-normalized value back out. That's a real, uncached DOM element allocation, and it was being paid **on every single `DRAW_LINE` draw call, every frame** — `glDrawLine` (the WebGL renderer's line-drawing path) called it fresh each time instead of resolving colors once. Every other cart's `on_draw` usage (Water the Plant's stem, Mini Golf's flag) draws a handful of lines a frame, so this was invisible; Corridor's raycaster draws ~480-490.

Measured directly, before touching any code: a Playwright page with `document.createElement` monkey-patched to count `'canvas'` calls, sampled over 2 full seconds of steady-state Corridor gameplay (rebuilt from the exact commit `drawCmds` pooling landed on) — **55,660 canvas elements created in 2 seconds, ~27,830/sec, continuously, whether or not any button was ever touched.** That number alone is enough to explain real jank on any hardware, mobile especially; whether it's specifically *why* the stall reads as "starts exactly when you press a button" rather than "constant" is still a question about human perception under load, not one this fix needs to answer to be worth shipping.

**Fixed by precomputing once per `World`, not resolving per draw call.** `World` now builds `this.paletteRGB` (16 `[r,g,b]` triples, one `cssColorToRGB` call each — 16 canvases total, at load, not 27,830/sec forever) right after `generatePalette()` runs. Every per-frame consumer that used to call `cssColorToRGB` fresh — `glDrawLine`, the WebGL backdrop fill/ground-strip colors, the aim-line color (mini-golf's swing indicator) — now indexes `paletteRGB` directly. `buildBitmap` (sprite/tile pixel-art baking, previously also calling `cssColorToRGB` per pixel at load time) does the same, trimming cart-load time too, not just steady-state play. Re-measured with the identical instrumented harness after the fix: **0 canvas creations across the same 2-second steady-state window.**

Verified with `test/smoke.js` (unmodified, all checks pass) and a fresh screenshot — pixel-identical to before, confirming the cached RGB values match what the throwaway-canvas resolution used to produce. The canvas-creation counting harness itself (an `addInitScript` patching `Document.prototype.createElement`) is a technique worth keeping in mind for the next "is this actually expensive" question — cheaper and more direct than guessing from a CPU throttling knob that can't emulate GC or DOM-allocation behavior at all.

## 57. Corridor's fragment shrank 3.6x by replacing 46 unrolled copies of one loop with one real loop

Asked plainly, after the two perf fixes above: Corridor's cart is 31,341 raw bytes — "almost 1k labels," "is this simplest form," "any 80/20 compromises to get much smaller?"

It wasn't simplest form, and the reason is structural: this VM has `JMP`/`JZ`/`JNZ` to fixed labels but no `CALL`/`RET` — no subroutine mechanism at all (an open question already, DESIGN.md's VM & hooks section). `genMarchSteps` (the ray-march loop every wall column, monster billboard, and shoot hit-scan needs) can't be written once and *called* from 46 sites; §54's authoring code instead ran a JS `for` loop at cart-build time and spliced in 46 literal copies of its 14-step unrolled body. Measured before touching anything: those copies alone were ~9,000 of `on_draw`'s 14,292 instructions — practically 60% of the entire cart — for logic that's identical every time.

**Two changes, same idea applied at two scales.** First, `genMarchSteps` itself became a real VM-level loop — a counter (`g_s13`) and a `JNZ` back to the top, instead of 14 unrolled copies of the step body. Contained and low-risk: it's one function, its 46 call sites don't change at all (they still just splice in whatever it returns). Second, and the bigger win: `genWallColumnBlock(i)`, previously called 40 times with the ray index `i` baked in as compile-time `PUSHI` constants (both the angle offset and each column's screen-x), became `genWallColumnLoop()` — one copy of the logic, run 40 times by an actual loop (`g_ray_idx`), with the per-ray angle and column position computed from `g_ray_idx` at runtime instead of embedded per-copy. This one required more care: an entity's own hp/x/y/handle-based addressing works fine for the three monsters (`g_mon0`/`g_mon1`/`g_mon2` are just three distinct named globals, no runtime indexing needed to reach them, so their billboard/hit-scan logic stays 3x-unrolled — genuinely the VM's addressing model, not laziness, since there's no indirect/indexed `LOADG` to loop over an array of handles with), but the 40 wall rays never needed per-ray *identity*, only a per-ray *number*, which a loop counter provides for free.

**The instructive part: raw size and *compressed* size didn't move together.** The march-loop change alone dropped raw bytes 31,341 → 16,759 (nearly half) but the compressed URL fragment barely moved, 6,319 → 6,003 characters (~5%). DEFLATE was already exploiting the massive redundancy in 46 near-identical unrolled blocks — removing redundant bytes that compression had already squashed away doesn't shrink the compressed output much. What compression *can't* remove is the genuinely unique content: each ray's distinct label names (`ray17_hit` vs `ray18_hit`) and distinct embedded constants (its index, its column offset). Only the second change — the one that actually eliminates 39 of the 40 rays' unique labels and constants, not just their redundant-but-compressible bytes — moved the number that matters: fragment size dropped again, 6,003 → 1,742 characters, a cart-wide 3.6x reduction from where §56 left off (10.2x from the original 31,341/6,319 baseline). `on_draw` alone went from 14,292 instructions to 569 — a 25x reduction — and the cart's total raw size (3,074 bytes) now sits in the same range as every other shipped cart (609-2,016 bytes) instead of being an order of magnitude outside it.

**The tradeoff, and why it needed re-verification, not just trust.** A real loop costs more at *runtime* than an unrolled copy — the counter increment/compare/branch on every iteration are opcodes that actually get dispatched, where an unrolled copy's "next iteration" was free (implicit fall-through, no bookkeeping). Smaller compiled size and higher runtime opcode count pulling in opposite directions meant §54's `MAX_STEPS` budget math (measured pre-loop) couldn't just be assumed to still hold — it needed re-measuring against the same adversarial worst case (a fully-open grid, forcing every march to run its full unearned length, with all three monsters alive and in view) used the first time. It passed with no `cartFault`, both for `on_draw` and for `on_tick`'s shoot hit-scan under the same adversarial grid with the shoot button forced held.

Verified in the same three stages as §54 originally was: a standalone Node harness against the real cart's bytecode (adversarial worst-case grids, both hooks, no `cartFault`); a `FakeWorld` gameplay simulation (movement, shooting, a monster kill, all still correct); and `test/smoke.js` plus a fresh screenshot in a real browser — pixel-identical to before every change in this section, confirming the size reduction changed nothing about what actually renders.

## 59. An opcode palette for the Debug view — pick, don't type, an operand

Asked for by name: make Debug's Logic tab easier to tinker in by adding a drawer of clickable opcode buttons that insert a correctly-formed assembly line, with context-aware pickers (real sprite/tile thumbnails, the fixed input-bit list, the cart's own global/constant slots) for opcodes whose operand means something — SPAWN's typeId, TESTBIT's bit index, LOADG/STOREG/LOADE/STOREE's slot, PUSHC's constant index — instead of an author having to already know which numeric index to type.

**The precondition turned out to be architectural, not additive.** Every hook's bytecode lived inside the Source tab's one big free-form JS-object-literal `<textarea>` (`sourceText`, parsed via `new Function(...)` on every edit) — fine for reading, but a palette needs to know exactly which hook and which line position it's inserting into, and locating `on_init: [` and its matching `]` inside arbitrary nested brackets/quotes/comments is a real parsing problem, not a string-splice. The fix: pull hooks out of that blob entirely. Each hook now gets its own `<textarea>` on the Logic tab (reusing its existing per-hook tab strip, previously read-only disassembly + CFG only), holding exactly one hook's line-joined text — no brackets to match, since a hook's on-disk shape was already a flat `string[]`. The Source tab keeps the header fields (still one JS-literal blob); `compileSourceText()` merges the two back together right before calling `compileCartSource()`.

That split paid for itself twice over: it's also what makes fast, un-debounced per-hook validation possible. Every keystroke in a hook's textarea calls `assemble()` directly against just that hook's lines (cheap — a linear scan of an already-short line list) and shows the result in a slot right under the textarea, on top of — not instead of — the existing debounced full-cart recompile that still owns the Source tab's ✓/✕ badge. The two never race: disjoint DOM, and the only state they share (the hook's text) is written synchronously before either validation pass runs.

**Two things learned about the format while wiring the pickers up, neither previously written down anywhere.** First: `GETTILE`, `SETTILE`, and `TILE_SURFACE` have no embedded tile-id operand at all — checked against `OPS` directly, all three are `[]`-operand instructions; the tile id is stack-driven, pushed by a preceding `PUSHI`. So a tile-thumbnail picker can't attach to those opcodes' own operand the way SPAWN's typeId picker attaches to SPAWN — it hangs off a dedicated "PUSHI (tile id)" palette entry instead, keeping "one button click → one inserted line" true for every button in the palette rather than breaking it for one group. Second: `constNames`/`globalNames` — the human-readable name tables a hand-authored cart declares (`STARTER_TEMPLATE` is the existing example: `globalNames: {g_ball:0, g_frames:1}`) — never survive a compile→decode round trip, because they're not part of `encodeCart`'s binary fields at all, only read by `assemble()` at compile time. That's true even for "+ New Cart," which compiles `STARTER_TEMPLATE` to a fragment and then decodes that fragment straight back — so its own Source tab shows bare numeric operands (`STOREG 0`, not `STOREG g_ball`) the instant Debug opens, same as any other decompiled cart. The global/constant pickers account for this directly rather than assuming names exist: every slot always gets a row (0-23 for globals, always render-able), named ones show their name and insert it as the operand token, unnamed ones show `slot N (unnamed)` and insert the bare number — always valid either way, never blocked on a name existing.

Answers, in part, one of §61's own long-standing open questions ("ship a visual editor at v1, or text-based only") — this is neither: still hand-typed assembly, but with the guesswork of "what number goes here" replaced by picking from the cart's own real data.

Verified via `test/smoke.js`: the split (hooks now edited on Logic, Source now header-only), fast per-hook validation surfacing a line-numbered error near-instantly versus the debounced full-cart badge eventually following, the SPAWN picker rendering one real sprite-thumbnail canvas per entity type and inserting the right index, the TESTBIT picker's fixed 5-item list, the tile picker's empty-state message on a cart with no tiles, the named-vs-unnamed global picker behavior on a hand-declared `globalNames` block versus a fully decompiled cart (`breakout`, confirmed to have none), and a Playwright screenshot of the finished editor in both themes.

## 60. Header/camera/input/backdrop/palette become live form fields, not raw JSON

Second visual-editor phase, same idea as §59 applied to the Logic tab's read-only "Overview" tables instead of hook bytecode: `cartType`, screen size, RNG seed, mode flags, camera clamp/follow, every input-button checkbox, backdrop colors, and all 8 `paletteParams` bytes are now real `<input>`s/`<select>`s/sliders/swatch-pickers instead of plain text an author had to go find and hand-edit in the Source tab's JSON. `entityTypes`/`sprites`/`tiles`, `mapGenerator`'s config block, and `hudSpec` stay out of scope — dedicated editors for those are still-later phases; `formatVersion` and `mapGenerator` stay read-only display for the same reasons stated inline in the UI (only one decodable format version; switching generators needs a whole new valid config block generated, not a scalar edit).

**The write-back mechanism is the same trick as §59's hook split, aimed at the header instead.** `lastParsedHeader` (the object `sourceText` last successfully parsed into, introduced in §59 for the global/constant-name pickers) becomes the thing every form control reads *and* now writes: a control's `change` mutates `lastParsedHeader` at a path, then the whole header gets re-serialized wholesale (`JSON.stringify(lastParsedHeader, null, 2)`, not a targeted text patch) back into `sourceText`, reusing the exact same debounce/recompile timer the Source textarea's own listener already uses. One real, deliberately-accepted behavior change that comes with it: touching *any* form field once reformats the whole Source-tab JSON, silently dropping hand-typed comments or unusual formatting that were there — the Overview section says so inline, no confirmation dialog (nothing else in this file uses one).

**A real bug caught before shipping, not after:** `renderInspectOverview` and the new palette editor both need `lastParsedHeader` to already be populated the instant the Logic tab first paints — but `startInspect`'s original order set it only inside the *awaited* `compileSourceText()` call, itself invoked *after* the synchronous `renderInspectBody()` that paints the Logic tab for the first time. First screenshot attempt threw `Cannot read properties of null (reading 'paletteParams')` immediately on opening Debug — `lastParsedHeader` was still `null` at that first paint. Fixed at the root rather than patched with another `|| cart` fallback: `startInspect` now seeds `lastParsedHeader = cartToSourceObject(cart, name, author)` synchronously, in the same place `sourceText`/`hookTexts` already get seeded, so every render from the very first one has a real header object to read.

**One kernel quirk this surfaced, worth knowing for the next field added to a form:** `ByteWriter.u8()` throws on an out-of-range value (deliberately, per §41's own postscript) but `ByteWriter.u16()` silently bit-masks instead — so a `u16` field (`screenW`/`screenH`, camera clamps) given a value over 65535 wouldn't error at compile time at all, just wrap to something small and wrong with nothing pointing at why. Every `u16` number input carries an explicit `max="65535"` for exactly this reason — the DOM cap is the *only* backstop the kernel doesn't provide for that one field width.

Verified via `test/smoke.js`: a plain field (`cartType`) round-tripping through the form into the recompiled cart; a palette slider updating its live preview strip within ~80ms, well under the 400ms full-recompile debounce, by design a separate, lighter-weight update than the debounced path; a backdrop swatch click landing the right index; an input-button checkbox revealing/hiding its label field and — the part actually worth testing, not just "does it show/hide" — dropping the stale label key from the compiled cart on uncheck rather than leaving old text behind to resurface if re-checked later; and a hand-edit typed directly into the Source textarea (`cartType` via regex-replace) showing up correctly in the form field afterward, proving the two views read from the same live object instead of silently drifting apart. Screenshot-verified in both themes.

## 61. Mobile overflow: a fixed-width palette grid and un-wrapped tables were forcing the page wide

Reported directly: on mobile, tables and "the color palette" were wide enough to expand the whole page rather than staying inside the viewport. Two independent causes, both in code from §59/§60, neither caught by the desktop-sized Playwright viewports every check in this session had used up to now.

**Cause 1 — `.pal-strip` used a fixed-column CSS grid.** `renderPaletteStrip`/the backdrop pickers set `grid-template-columns:repeat(N,40px)` inline, so a 16-swatch strip (the live palette preview, or the old always-open backdrop picker) was a *hard* 640px+ wide regardless of viewport — CSS grid doesn't wrap a fixed track list, it just overflows. Fixed by switching `.pal-strip` from grid to `display:flex;flex-wrap:wrap` with each `.pal-swatch` given an explicit `40px` width instead of relying on the grid's column tracks for sizing — same visual density when it fits (one row), wraps onto additional rows instead of overflowing when it doesn't. No visual change on desktop; screenshotted at 375px to confirm the terrain ramp (8 swatches) now wraps 7+1 instead of running off the right edge.

**Cause 2 — `table()` (the one shared helper behind every `<table>` in the Logic tab: entities, HUD spec, constants, tile-surface overrides, map-generator params) had no scroll container of its own**, unlike the CFG diagram and disassembly listing which already got `.cfg-scroll`/`overflow-x:auto` treatment when they shipped. A table with enough columns or long enough cell text had nothing to contain it, so it (or the viewport around it) went wide instead of scrolling. Fixed at the one shared function — `table()` now wraps its own output in a `.table-scroll{overflow-x:auto}` div — so every call site gets the fix without touching each one.

**Also acted on, not just a bug fix:** the request specifically asked for the backdrop color fields to stop rendering the whole palette inline and instead show a single current-color swatch plus a dropper icon that opens the full palette as a popover — a real UX request riding along with the overflow report, not just "make the wide thing narrower." Replaced `renderIndexPicker` (always-open 16-swatch grid) with `renderColorPicker`: a `.color-picker-trigger` button (the current color, painted as its own background, plus a palette-emoji dropper glyph) toggling a `.color-picker-popover` — closed by default, opened on click, closed again by picking a color *or* by a document-level click-outside listener (added once at module load, not per-render, since it needs to catch clicks anywhere on the page for the whole session). The popover needed an explicit `width` (`min(228px,80vw)`), not just `max-width` — a `flex-wrap` child inside a `position:absolute` parent with no set width computed its shrink-to-fit size as a single column in testing, not the intended multi-swatch grid; giving the popover a real width fixed the layout, and `max-width:80vw` + its own `overflow-x:auto` still catch the pathological case (a device narrower than 228px) as defense in depth on top of §61's own `.pal-strip` fix.

Verified via Playwright at a real mobile viewport (375×812, iPhone-sized) — `document.documentElement.scrollWidth === clientWidth` (no horizontal overflow at all) checked on the Assets tab, the Logic tab's overview, the Logic tab scrolled down to its tables, and with the color-picker popover open — plus screenshots at each of those checkpoints to confirm visually, not just numerically. Also re-confirmed no regression at desktop width (900px) in both themes.

## 62. An interactive sprite shape editor — pick a shape, drag to move, drag a corner to resize

Third visual-editor phase, matching the original ask word for word: "picking preset shapes in a layer and selecting a layer and resizing the shapes with the cursor." Scoped to kind:1 (shape-list) sprites only — raw-pixel sprites get a "raw-pixel editing is a future phase" message instead; creating brand-new sprites and entity-type CRUD stay separate, later phases.

**Reused rather than reimplemented: `World.buildBitmap()`.** The editor's canvas doesn't rasterize shapes itself — every redraw calls `inspectWorld.buildBitmap({kind:1, w, h, shapes}, true)` (an *instance* method, callable against any hypothetical `{kind,w,h,shapes}` object, not just ones already in `cart.sprites`) and blits the result. That's the exact same `renderShapeList` + palette-resolution path the real runtime uses, so a drag can never show something the compiled cart wouldn't actually produce — no second rendering implementation to keep in sync with the first. Move/resize math normalizes both shape kinds (ellipse's `cx/cy/rx/ry`, rect's `x/y/w/h`) to one bounding-box shape (`getShapeBox`/`setShapeBox`) so the drag handlers themselves never branch on shape type.

**Two real bugs found while building this, both fixed as part of the same round, not left for later:**

1. `encodeCart`'s shape-coordinate write pre-masked with `& 0xFF` before calling `ByteWriter.u8()` — the exact out-of-range guard §41 added for `paletteParams` never got a chance to fire for shape geometry, so a shape dragged past the 1/8px format's 31.875px ceiling would've silently wrapped to a small wrong value with no error anywhere, the identical failure shape §41 fixed for a different field. Dropped the mask; the editor also clamps every geometry value client-side regardless (`clampShapeUnit`), so the guard is a backstop, not something a normal drag would ever actually trip.
2. **A closure-staleness bug caught by the smoke suite, not by inspection.** `wireShapeListPanel`'s reorder/delete button handlers captured `const sprite = lastParsedHeader.sprites[spriteIndex]` once, outside the click listeners — fine for a same-tick call, wrong here, because `lastParsedHeader` is wholesale-*replaced* (not mutated) on every successful debounced recompile. Click a reorder button more than ~400ms after the sprite last changed, and the closure's `sprite` was already pointing at a detached, orphaned object; the swap happened on a copy nothing else could see, and the visible array order never moved. First three smoke checks (select, move-drag, resize-drag) passed because they all touch the live object within one recompile window; reorder/delete only started failing once enough `waitForTimeout`s had let a recompile land in between — exactly the gap a human clicking at a normal pace would also hit. Fixed by re-reading `lastParsedHeader.sprites[spriteIndex]` fresh inside each handler instead of closing over it — the same discipline the move/resize drag handlers already followed (deliberately, per their own comment) for the identical reason. Left as a pointed comment on `wireShapeListPanel` since this exact mistake is very easy to reintroduce the next time a handler gets added here.

**A third, latent issue fixed pre-emptively rather than after a bug report**: the sprite editor is the first Assets-tab control that can trigger a recompile *while Assets stays the visible tab* — every other editable field lives on Logic/Source, tabs Assets was never shown alongside. Every recompile does `inspectWorld = new World(cart)`, which orphans the other (kind:0/tile) canvases already appended into the page from the previous `inspectWorld` instance. Invisible today only because none of this round's edits change any *other* sprite's or tile's actual pixels — but the underlying inconsistency was real, so `refreshAssetCanvasesIfVisible()` now re-attaches fresh canvases into their existing slots (guarded to only run when Assets is actually on screen), rather than waiting for a future round to make the staleness visible and debuggable from scratch.

Verified via `test/smoke.js`: select-by-click, move-drag (`cx` changes), corner-handle resize (`rx`/`ry` change), "+ Rect" (array grows, correct `type`), reorder (array order flips), recolor via the popover, delete (array shrinks) — all against the "+ New Cart" starter template's one real shape, plus a separate check that a genuinely raw-pixel sprite (Corridor's) shows the future-phase message instead of a broken editor. Two new encoder-guard checks (`paletteParams`-style and the new shape-coordinate one) confirm both `u8` call sites now throw instead of wrapping. Screenshot-verified in both themes plus the 375px mobile viewport from §61, confirming no overflow regression.

## 63. "Debug" becomes "Tinker" (with a hammer), and "Play this version" moves to a persistent top-right "Try"

Two CTA tweaks, no behavior change to either underlying action — both about naming and placement, called out by the user directly after the sprite-editor round shipped.

**"Debug" → "Tinker" + a hammer icon (`#debugBtn`).** "Debug" implies something is broken; this button opens a live editor for art, logic, and source on a cart that's working fine — the wrong verb for what it actually does. Renamed to "🔨 Tinker" (game-view topbar and the shelf's help copy); the element id, the `debug:` URL-hash prefix `main.js` still routes on, and every other internal reference stay untouched — this is a label change, not a route change.

**"Play this version" moves out of the Source tab, into `.inspect-topbar`, relabeled "▶ Try."** It used to live inside `compileStatusHtml()` — visible only when Source was the active tab, and only after scrolling past the compile-status table. Functionally it was already the most useful button in the whole Debug view (the one way to actually *run* whatever you'd just edited), buried in the one place that made it hardest to find. Moved to a new `#inspectTryBtn` in the topbar, next to `#inspectTitle`, right-aligned via `margin-left:auto` (the existing 2-item topbar flex row already composed correctly with a 3rd item — no new layout plumbing needed, confirmed at the 375px mobile viewport too, 0px overflow). Same underlying behavior as before — `location.hash = compileState.fragment`, i.e. play the live-edited fragment exactly like any external cart link, no autosave or persistence implied.

Because it's no longer scoped to one tab's render cycle, it needed its own enabled/disabled sync — wired into `renderInspectTabs()`, the one function that already runs after every `compileState` change (decode, compile success, compile failure) and every tab switch, rather than hunting down each of those call sites individually. `#inspectTryBtn.disabled = !(compileState && compileState.ok)`: greyed out and inert while the live edit doesn't compile, live and accent-colored the instant it does — the button's own state now doubles as an at-a-glance "is this playable right now" indicator, visible regardless of which tab you're looking at.

Asked in the same message: whether to additionally `history.pushState` a new browser-history entry on every edit, turning the back/forward stack into free autosave/version-history. Answered as a recommendation, not built — no code changes came out of that question this round.

Verified via `test/smoke.js`: the Try button starts enabled once the starter template compiles, disables itself the instant a broken-hook edit lands (debounced recompile), re-enables once fixed, and clicking it actually starts the recompiled cart — same assertions the old `#playCompiledBtn` test made, just against the new element and without needing to be on the Source tab first. Screenshot-verified in both themes plus the 375px mobile viewport.

## 64. Open questions

**Format & encoding**
- ~~§26's `kernel.js` is a copy of part of `urlcade.html`, not an
  import — nothing stops the two from silently drifting apart except
  running `test/check-kernel-sync.js` after touching either one. Is a
  copy with a manual check sufficient long-term, or does this need
  enforcement before it's trustworthy enough for an agent to actually
  rely on unattended?~~ Moot as of §29: the runtime split into modules
  specifically so `kernel.js` could stop being a copy and become an
  import. There's nothing left to drift, so there's nothing left to
  check — `check-kernel-sync.js` is retired.
- Is base64url-over-custom-binary actually the right density/compat
  tradeoff, or is a larger Unicode alphabet worth the copy/paste risk
  for power users who know what they're doing?
- ~~Should compression be mandatory, or is the `u1` vs `u1r` split worth
  it?~~ Answered by §25: the tagged split (`z.`/`r.`), compression
  picked only when it's actually smaller, never mandatory. What's still
  open is the *dictionary* half — is it worth hand-rolling a DEFLATE
  encoder for the real preset-dictionary scheme, given generic
  compression alone already gets 3 of 5 carts down a full size tier?
- How do we migrate the preset dictionary over time (once it exists)
  without either freezing it forever or breaking old links? Is "one
  dictionary per format_version, all kept alive in the runtime"
  sustainable?
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
- §55/§56 fixed two real, measured sources of severe per-frame
  allocation in Corridor (`drawCmds` object churn, then ~27,830/sec
  throwaway `<canvas>` elements from uncached `hsl()`-to-RGB
  resolution) — the second one in particular is large enough to
  explain real jank on its own. Neither was pinned down as *the* exact
  cause of the originally-reported ~1s touch-input stall, since that
  stall was never reproduced directly in this environment (not
  headless, not under 6x CPU throttling — a limitation of the
  reproduction environment, not evidence the fixes are unrelated). Is
  there a real mobile device this can be re-tested against directly
  now, and if the stall persists, what's next to profile — style
  recalc from the `.touch-btn.active` class toggle, WebGL driver
  overhead specific to that device, or something in the touch-event
  pipeline itself?

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
- ~~Ship a visual editor at v1, or launch with a text-based
  assembler/compiler only (better for source control / code review of
  carts, worse for onboarding non-programmers)?~~ §59 lands a middle
  ground: still hand-typed assembly (kept text, kept diffable), but an
  opcode palette that picks operands from the cart's own real data
  instead of the author guessing a number. A fully visual/block editor
  for hooks themselves is still open — but §62 gives the *asset* side a
  genuinely fully-visual editor (drag shapes with the cursor, no text
  involved at all) for shape-list sprites; raw-pixel sprites and tiles
  are the same idea's next, still-open extension.
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
