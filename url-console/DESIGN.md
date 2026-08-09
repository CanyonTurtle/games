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

## 64. A tile pixel editor — paint palette indices directly onto the canvas

Fourth visual-editor phase, and the simpler of the two items left on the original wishlist (the other, entity-type CRUD, is next). Tiles have no shape-list option the way sprites do (`kernel.js`'s tile encode/decode is always `{w, h, pixels}`, raw palette indices, no `kind` field at all) — so "editing" a tile is just painting palette indices onto a grid, no shape math needed. Every tile in the cart gets its own always-visible canvas plus a palette strip to pick the current paint color; drag across the canvas to paint a stroke, same click/drag-anywhere feel as the sprite editor's canvas.

**Reused the same foundations as §62, not reimplemented.** `redrawTileEditor` calls `inspectWorld.buildBitmap({w, h, pixels}, false)` — the identical real-runtime rasterizer the sprite editor already proved out, so a painted tile can never show a color the compiled cart wouldn't actually produce. `paintTilePixel` re-fetches `lastParsedHeader.tiles[tileIndex]` fresh on every pointer event rather than closing over a reference, the same staleness discipline `wireShapeListPanel` learned the hard way in §62. No kernel.js change was needed this round — unlike a shape's `cx/cy/rx/ry` (which needed §62's `& 0xFF` fix because the 1/8px fixed-point format has a real ceiling a drag could exceed), a tile pixel is just a palette index, and the editor only ever writes what's already on the always-visible 16-swatch strip (0-15), so there's no out-of-range value the UI can produce in the first place.

**One difference from the shape editor's color picker worth calling out**: the tile editor's palette strip is deliberately *not* the popover-based `renderColorPicker`/`wireColorPickerSlot` component the shape list and backdrop fields use. Those pick a color for one field, once, then close. A paint tool needs its current color reselectable constantly while painting — closing a popover after every swatch pick would make painting more than one color a click-fest. So it's a small dedicated renderer (`renderTilePaletteSlot`) instead, reusing the same `.pal-strip`/`.pal-swatch.pickable`/`.selected` CSS the popover already established rather than inventing new visual language for "a row of clickable swatches."

**A latent staleness gap in §62 itself, found and fixed while building this.** `refreshAssetCanvasesIfVisible()` — the function that keeps Assets-tab canvases in sync after a recompile that happens while Assets stays the visible tab — only ever re-attached the *raw-pixel* sprite thumbnails; it never redrew an open kind:1 shape editor. Invisible until now because nothing else editable on the Assets tab could change how a shape's *existing* colors render — until this round: the Assets tab's own palette-hue slider (from the header-fields round) recompiles while Assets is visible, and both the shape editor and the new tile editor resolve their colors through `inspectWorld.buildBitmap()`, so a palette edit changes what an already-open editor *should* show without anything telling it to redraw. Fixed by having `refreshAssetCanvasesIfVisible()` also call `redrawSpriteEditor`/`redrawTileEditor` for every kind:1 sprite and every tile, not just re-attach the static kind:0 thumbnails.

Verified via `test/smoke.js`: Corridor's wall tile (`tiles[0]`) starts as a real 8×8 raw-pixel texture; picking a palette color and dragging across the top row asserts the recompiled cart's `pixels` array actually changed to the picked color. (One test-authoring bug worth a note for future rounds using this same pattern: the first version of this check computed the canvas's `boundingBox()` *before* clicking the palette-strip swatch — but that swatch click auto-scrolls its target into view, and the palette strip sits below the canvas in this layout, so the scroll invalidated the already-captured coordinates and the drag silently painted the *next* tile's canvas instead. Fixed by picking the color first, then reading `boundingBox()` immediately before the mouse actions — capture layout-dependent coordinates only right before you use them, never before a step that can still scroll the page.) Screenshot-verified in both themes plus the 375px mobile viewport, confirming no overflow with the palette strip's own flex-wrap.

## 65. Entity-type CRUD — add/remove entity types, reassign which sprite or tile a type draws as

Fifth and last visual-editor phase of this series, closing out the original wishlist (opcode palette, header/camera/input/backdrop/palette fields, sprite shape editor, tile pixel editor, and now this). The Logic tab's entity-type table — `[#, renderKind, assetIndex, rotate, collisionW, collisionH, extFields]`, read-only since the very first Debug view — becomes one editable card per entity type: a render-kind select, a sprite/tile thumbnail picker, and plain fields for rotate/collision/ext-field-count, plus add/delete.

**Almost every field is a direct `bindHeaderField` reuse, not new plumbing.** Rotate (checkbox), collisionW/H, and extFieldCount are exactly the same "read the control, `setHeaderPath`, debounce-recompile" shape every Overview field already used — no bespoke wiring needed. Only two things needed custom handling, because they change *what the other controls even mean* rather than writing a scalar:

1. **renderKind** — switching between Sprite (0), Tile column (1), and Custom draw (2) changes which array `assetIndex` even points into (`entityTypes[i].assetIndex` means "index into `cart.sprites`" for kind 0, "index into `cart.tiles`" for kind 1, and is unused entirely for kind 2 — confirmed straight from `doom-like.js`'s own `// assetIndex unused for renderKind:2` comment, not guessed). Changing it resets `assetIndex` to 0 and re-renders the whole card, rather than leaving a stale index that might not even exist in the new domain.
2. **The asset picker** — a thumbnail-trigger + popover-grid picker, structurally identical to the color-picker popover (trigger button, absolute-positioned popover, a global click-outside-closes listener) but showing sprite/tile thumbnails instead of palette swatches. Picking one writes `assetIndex` directly.

**A real bug caught by screenshot verification, not by the smoke suite.** The first version never actually painted the trigger's own thumbnail on initial render — `renderEntityAssetThumb()` existed and worked, but was only ever called from inside the picker's own "you just picked a new asset" handler, never during the card's first render. Every trigger button showed a blank canvas until you reassigned it once. The smoke suite's DOM/data assertions all still passed (nothing checks pixel content), so this only surfaced once the dark/light-theme screenshots were actually looked at — a concrete instance of this project's own standing rule that a reference/feature that reads correctly but wasn't checked against the real thing is worse than not having checked at all. Fixed by calling `renderEntityAssetThumb(i)` for every card during `wireEntityTypesPanel()`, alongside the wiring it already did.

**A second bug, this time caught by the smoke suite itself: a class-name collision between two unrelated pickers.** The asset-picker popover's grid first reused the opcode palette's own `.operand-picker-grid`/`.operand-picker-item` classes outright — same visual language, seemed like reuse. But both the SPAWN operand picker (Hooks section) and an entity card's asset popover (Entities section, just above it) live on the same Logic tab at the same time, so a page-global selector like `.operand-picker-item[data-value="0"]` — exactly what the existing SPAWN-picker smoke test used — matched one element from each, and Playwright silently picked whichever came first in DOM order. The existing "SPAWN opens a picker with one item per entity type" check started reporting 2 items instead of 1, and a later click hung for 30 seconds against a match that turned out to be the wrong (hidden) element. Fixed by giving the entity picker its own `.entity-asset-grid`/`.entity-asset-item` classes, with the CSS rules shared via a comma-joined selector (`.operand-picker-item, .entity-asset-item{...}`) rather than duplicated — same visual result, no shared class name for a page-global selector to accidentally match twice.

**Index-shift hazard, documented rather than solved.** `entityTypes` is a plain array; `SPAWN <n>` in hook bytecode hardcodes `n` as a typeId. Deleting entity type 1 out of 3 silently renumbers what was type 2 down to type 1 — any hook's `SPAWN 2` now spawns the wrong thing, and nothing in this editor (or the compiler) can detect that, since a numeric SPAWN operand is indistinguishable from an intentional one. Solving this for real would mean either named entity-type references (a bigger format change) or rewriting hook bytecode operands on every delete (fragile, hooks are hand-editable text). Neither is in scope here — a plain warning line above the entity list says so once, matching this project's standing preference for hand-typed-assembly-owns-its-own-correctness over trying to paper over a sharp edge with automation that can't fully close it.

Verified via `test/smoke.js` against Race Car (3 renderKind:0 entity types, 3 real sprites — a genuine domain to reassign within, not a 1-item no-op): card count, a plain field edit (collisionW) and a checkbox (rotate) round-tripping through the recompiled cart, the asset picker's popover showing the right thumbnail count and reassigning `assetIndex` on pick, a renderKind change resetting `assetIndex` and recompiling cleanly, and add/delete both reflected in the recompiled cart. Screenshot-verified in both themes plus the 375px mobile viewport (0px overflow, the card rows wrap correctly).

## 66. Per-entity sprite animation — `assetIndex` becomes a spawn-time default, not a lifetime constant, and a wrong-by-grep first attempt at where to put it

First round out of a multi-feature design pass (sound, persistence, sprite animation, tilemap authoring, rollback multiplayer — worked out over a long planning conversation, this repo's slice of it). Smallest of the four "main asks": until now, `SPAWN` set `entityTypes[typeId].assetIndex` for the entity's entire lifetime — a walk cycle meant burning a separate entity type per frame, or killing and respawning (losing all other state) just to swap which sprite something draws as.

**The fix, once landed correctly, needed no new opcode surface at all** — every entity already gets `STORE_SELF idx`/`STOREE handle idx` for free; the only real change is *where the renderer reads the asset index from*. `entityTypes[typeId].assetIndex` is now only the spawn-time default, copied into a new per-entity prop that the renderer reads every frame instead of the type's constant. All three render call sites (the static shelf-thumbnail renderer, `drawEntityCanvas`, `drawEntityGL`) changed identically: read the entity's own current value, not `type.assetIndex`.

**Where that value lives took two attempts, and the first one shipped a real regression before smoke.js caught it.** `props[6]` looked free — a literal-text grep for `STORE_SELF 6`/`STOREE ... 6` across every shipped cart's hook source came up empty, and `opcodes.md` already documented `[2]`/`[3]`/`[5]`/`[6]` as "free for cart use." First implementation claimed `props[6]` as a third engine-reserved base slot, same style as the existing `props[4]`/`[7]` (`typeId`/entity id). `test/smoke.js` immediately started intermittently failing two unrelated-looking checks — "Race Car's AI cars navigate past both chicanes" (stuck at checkpoint 1) and "no console/page errors" (`Cannot read properties of undefined (reading 'width')` in `drawEntityGL`). Bisected by stashing the change and confirming the baseline was clean, then re-added a temporary in-page diagnostic logging the crashing entity's type/props on every `!src` hit, which pinned it down in three reproducible runs: `doom-like.js:59` defines `const XPROP = 0, YPROP = 1, HPPROP = 5, ANGLEPROP = 6;` and writes the player's facing angle to `props[6]` via `STORE_SELF ANGLEPROP` every time it turns — a real, load-bearing use of that slot that a literal grep for the digit `"6"` could never find, since the source only ever says `ANGLEPROP`. Once the player turned during the raycaster's own smoke test, `props[6]` held an angle value instead of a sprite index, and the renderer tried to index `spriteCanvases[3]` on a cart with exactly one sprite — undefined, `.width` throws, the uncaught exception skips the trailing `requestAnimationFrame(loop)` call in the game loop, and the world silently stops advancing for the rest of that test's 20-second wait, which is what actually failed the unrelated-looking Race Car checkpoint check downstream in the same page session.

**The real fix: append one slot *after* every entity type's own ext fields — `props[8 + extFieldCount]` — instead of reusing any of the base eight.** This is safe by construction, not by having grepped hard enough: it can't collide with a per-cart convention, named or not, because it's always one past whatever `extFieldCount` an author declared for themselves, and every existing renderKind convention that already lives inside the ext-field region (renderKind 1's column-height/cap-orientation at ext fields 0/2, renderKind 0's rotation angle at ext field 0 when `rotateFlag` is set) stays exactly where it was — the new slot is strictly beyond all of them. `spawnEntity`'s prop count went from `8 + extFieldCount` to `9 + extFieldCount`; `opcodes.md`, `hooks.md`, and `cart-object.md` all got the corrected layout plus an explicit note on why `props[6]` specifically was ruled out, not just silently avoided.

**Verification lesson, not just a bug story:** the smoke suite's own new test for this feature had the identical class of bug on first write, caught by the suite itself rather than a human. It isolated one entity's chosen sprite by wrapping `world.spriteCanvases` in a `Proxy` that records the last-accessed index during a real `render()` call (no pixel/canvas readback — this repo has no precedent for that, and the live canvas may be WebGL without `preserveDrawingBuffer`, so `toDataURL` right after a draw isn't reliable). First version ran that check against cave-crawler's roguelike world with every entity still in the scene; the Proxy recorded whichever entity happened to draw *last* that frame, not necessarily the player the test meant to check, so the assertion passed or failed depending on monster-render ordering rather than the thing being tested. Fixed the same way as the production bug: isolate to exactly the entity under test (`w.entities = [player]` for the duration of the check, restored after) rather than trusting an aggregate signal to mean what it looked like it meant.

## 67. Four real animations, the first actual use of the assetIndex-override feature: a flap, two death poses, and a lap-complete flash

§66 built the mechanism (per-entity `assetIndex`, spawn-time default overridable via `STORE_SELF (8 + extFieldCount)`) but shipped with nothing actually using it — every example cart still spawned an entity and left its sprite untouched for its whole lifetime. This round wires it into four real cart moments: Flappy's bird flaps its wing from vertical velocity, Cave Crawler's player and monster both get a death pose (the monster's held briefly before removal, not instant), Run & Jump's player gets the same death pose, and Race Car's existing HUD-only "Lap complete!" flash (§49) now strobes the player's own car sprite too.

**Flappy's wing frame is derived, not stored.** `on_tick`'s bird branch already computes a new `vy` every tick (gravity, or a flap impulse from `on_input`); the wing frame is just that same value's sign, re-derived and re-written to `props[8]` every tick rather than tracked as separate state — rising shows `sprites[1]` (wing up), falling shows `sprites[0]` (wing down/resting). No timer, no extra ext field: the physics the cart was already computing was the animation state the whole time.

**Cave Crawler's monster death needed to hold, not just switch.** Killing on the same tick HP reaches 0 (the original behavior) means the death sprite is never actually rendered — the entity is gone before the next frame. Fixed by repurposing the monster's existing `move_timer` ext field (`props[8]`) as a death-hold countdown once dead, since a dead monster no longer needs to move: the first tick at `hp<=0` switches to the dead sprite and starts a `DEATH_HOLD_TICKS` (24, 0.4s) countdown in that same slot; every tick after, holds until it expires, then `KILL_SELF`. "Already dying vs. just died" is distinguished by checking whether `props[9]` (the monster's assetIndex prop) already equals the dead-sprite index — no separate flag needed, the visible state and the internal state are the same read.

**A first version of both death sprites was screenshot-checked and found unreadable, not just assumed to work.** Cave Crawler's and Run & Jump's death poses started as a single flattened ellipse in each entity's darkest "ink" shade only — matching that the alive sprites' *outline* color, reasoning that a collapsed silhouette needed one shape's worth of change from an upright blob. Grabbing the actual sprite bitmaps (`world.spriteCanvases[i].toDataURL()`, upscaled 8x nearest-neighbor — not a scene screenshot, which turned out to have its own problem, see below) showed the real result: a near-invisible dark smudge, indistinguishable from the outline of anything else on screen. Fixed by keeping the same two-tone outline+fill every alive sprite already uses, just recomposed into a flattened, wider pose — the "collapsed" read comes from the shape, not from stripping color out of it.

**Race Car's flash reuses `g_lap_flash`'s existing countdown rather than adding a second one**, extending `on_frame`'s decrement (previously HUD-text-only) to also strobe the player car's own `props[12]` (`8 + extFieldCount(4)`) between `sprites[0]` (normal) and a new `sprites[3]` (`carFlashShapes`, recolored to the terrain ramp's two extremes rather than a third independent hue — guaranteed distinct from both entity ramps by the same construction DESIGN.md §43/§44 already established, nothing new to hint or risk colliding with) every 4 ticks (~7.5Hz). The countdown reaching exactly 0 forces the sprite back to normal explicitly, rather than leaving it at whatever the strobe last landed on — the same "don't trust an aggregate/derived signal, check the actual terminal state" lesson §66 already learned from the rollback-window design conversation, applied here to a countdown instead of a render call.

**A first attempt at screenshot-verifying the race-car flash picked the wrong car.** Race Car has two entity types sharing similar silhouettes (player, entity B ramp; AI cars, entity A ramp) — a scene screenshot with the camera nominally following the player showed a car, but nothing in the screenshot itself confirmed *which* one, and it read as unchanged between "normal" and "flash" captures. Same fix as the death-sprite readability issue above: stopped trying to verify through the full scene (camera framing, which car is in view, palette-derived hues that aren't obviously "yellow" vs. "purple" at 16x16) and instead grabbed `spriteCanvases[0]` and `spriteCanvases[3]` directly — unambiguous, and immediately showed the intended result, a stark grey/white car clearly distinct from the normal yellow one.

**One straightforward bug, caught immediately by the existing startup check, not by a new test:** `cave-crawler.js` had never imported `SHAPE_ELLIPSE` from the kernel (its sprites were always built via the shared `blobPlayerShapes`/`blobMonsterShapes` helpers, which import it themselves), so the first version of its inline death-pose shape arrays threw `ReferenceError: SHAPE_ELLIPSE is not defined` at cart-registration time — caught by `smoke.js`'s very first check (`all 9 shelf carts registered`) timing out, not a subtler failure.

Verified via `test/smoke.js`: eight new checks, one per animation's actual mechanism (wing frame follows velocity sign in both directions; player and monster both switch sprite the frame HP reaches 0; the monster is still present with its dead sprite immediately after, then confirmed actually removed only after stepping past `DEATH_HOLD_TICKS`; the lap-flash strobe visits both the normal and flash frame across one cycle and lands back on normal once the countdown ends) — all direct prop/state inspection via `world.step()`, no pixel reads, same reasoning as §66's own test. Screenshot-verified separately (sprite bitmaps directly, not scene captures, per the two lessons above) for all four animations plus one pre-existing entity-type-editor smoke test updated for Race Car's new sprite count (3 -> 4).

## 69. Persistence — `LOAD_PERSIST`/`STORE_PERSIST`, a second globals array backed by `localStorage`, keyed automatically per cart

Second feature out of the same multi-feature design pass §66 opened (sound, persistence, sprite animation, tilemap authoring, rollback multiplayer). Until now every play started from zero — no high score, no unlock, no setting survived a reload, a real gap for a format whose whole pitch is "share a link, come back and play again."

**Shape mirrors `LOADG`/`STOREG` deliberately, not a new addressing scheme.** `LOAD_PERSIST idx`/`STORE_PERSIST idx` (opcodes 57/58) read/write a second 24-element array, `World.persist`, the same u8-slot shape carts already know from `globals`. Routed through `ctx.loadPersist`/`ctx.storePersist` callbacks rather than touched directly by the VM — same reason `SETTILE`/`SPAWN`/`PLAYSOUND` are ctx-callbacks and not inline: `runHook()` in `kernel.js` has zero browser-global access by design (see its own doc comment), and `localStorage` is exactly that.

**The cart key is a synchronous hash over `encodeCart(cart)`'s bytes, not the raw URL fragment or a hand-picked name.** `hashCartBytes()` (FNV-1a, 32-bit, a dozen lines, no dependency) hashes the cart's own re-encoded bytes — deterministically identical to what it originally decoded from, per `compileCartSource`'s own round-trip guarantee — into a `urlcade_persist_<hex>` `localStorage` key. Two deliberate choices baked into that one line:
- **Synchronous, not `crypto.subtle.digest()`.** The latter is Promise-based and would force `new World(cart)` — a plain, synchronous call everywhere it's used today (`main.js`, every smoke test, this file's own new tests) — into an async construction path just to derive a cache key that doesn't need cryptographic collision-resistance. Not worth restructuring cart load for.
- **Hashing the whole encoded cart means versioning is free, not a separate mechanism.** Any edit at all — a hook logic change, a sprite recolor, a constant tweak — changes the hash and starts that cart's save data fresh. No version field to remember to bump, no stale-save-format detection logic. The cost: a cosmetic-only edit also resets a high score. Accepted rather than solved — building and maintaining a "what counts as gameplay-relevant" classifier as the format grows is a bigger, more fragile thing than living with that cost.

**Never lets a storage failure become a game failure.** Both the constructor's load attempt and `savePersist()` wrap `localStorage` access in `try/catch` — private browsing, a sandboxed iframe, or a quota already exceeded by something else on the origin all just mean the cart always sees zeros and every write is silently discarded, the same experience as a first-ever play, never a thrown error or a blocked hook.

**Wired into a real cart, not shipped inert.** Flappy Bird gets a persisted all-time high score: `on_init` loads persist slot 0 into `g_high_score` (persistence loads before `on_init` runs, so this works on the very first tick — see `hooks.md`); `on_tick`'s existing score-increment branch compares against it and, on a new best, updates the working global and calls `STORE_PERSIST` in the same breath. A new "Best" HUD line sits next to the existing "Score" one. No new opcode surface needed beyond the pair itself — same "the physics the cart already computes is the state" shape §67's wing-flap animation used, just for a scoreboard instead of a sprite index.

**Inspector wiring is one line, not a new picker.** The opcode palette's `Persistence` group uses `operandKind:'raw'`, the same plain numeric entry `LOAD_SELF`/`STORE_SELF` already use for prop indices — deliberately not `'globalSlot'` (which would show the *globals* name table, semantically wrong for a separate 24-slot array with no name-table concept of its own yet). Documented as a real, load-bearing decision in `opcodes.md`, not left implicit: a future `PERSIST_NAMES` convention is a natural next step if enough carts want one, not something worth inventing speculatively now.

Verified via `test/smoke.js`: the storage mechanism tested directly first, bypassing gameplay entirely — a written value round-trips through `localStorage` into a fresh `World` for the identical cart object; a different cart (Race Car) never sees Flappy's data, confirmed by both the value and the key itself differing; an edited clone of the same cart (one changed byte) also gets a fresh key rather than reading the old save. Then one end-to-end check through Flappy's own real hooks — a genuine spawned pipe entity (not a hand-set global) triggers `on_tick`'s scoring branch, confirms the new high score persists, and confirms a fresh `World` for that same cart loads it back via `on_init`'s own `LOAD_PERSIST`, not a test-only shortcut. The opcode-palette group-count check (added in §63) bumped 9 -> 10 for the new `Persistence` group, same mechanical update the entity-type-CRUD round's sprite-count check needed in §67.

## 70. Mini Golf's own persisted best — a second cart, and the first "lower is better" record

Short follow-up to §69: Flappy Bird's persisted high score was the only cart actually using `LOAD_PERSIST`/`STORE_PERSIST` — this round gives Mini Golf a persisted all-time best (fewest) stroke count, the same feature applied to a genuinely different shape of "record."

**Reusing persist slot 0 is safe, and worth saying why rather than just doing it.** Each cart's `persist[]` is keyed by a hash of its own encoded bytes (§69), so Flappy's slot 0 (`PERSIST_HIGH_SCORE`) and Mini Golf's slot 0 (`PERSIST_BEST_STROKES`) never share a `localStorage` entry despite the same numeric index — there's no shared namespace to collide in, the same reason two carts' `globals[0]` have never meant the same thing either.

**"Lower is better" needed a real sentinel for "no record yet," not just a zero-initialized value read as a score.** Flappy's high score starts at 0 and only ever goes up, so "0" and "no record" are the same state with no ambiguity. Golf's stroke count can't be 0 for a *real* completion (tee and hole are different checkpoints — reaching the hole always takes at least one real swing), which is exactly what makes 0 a safe, unambiguous "not set yet" sentinel here too, just for the opposite reason. The comparison in `on_tick`'s hole-out branch checks `g_best_strokes == 0 OR g_strokes < g_best_strokes` — the first clause only ever fires once, the very first hole-out this cart's `localStorage` entry has ever seen.

**The HUD line uses `kind:2` (shown only while nonzero) specifically because of that sentinel** — `hudSpec`'s numeric-always (`kind:0`) would show a misleading "Best: 0" before the course has ever been finished once; `kind:2`'s existing "shown only while nonzero" behavior (already used elsewhere for flag-style lines) means the "Best: N" line simply doesn't exist yet on a first-ever play, matching what the sentinel actually means.

Verified via `test/smoke.js`, same two-part shape as §69's Flappy checks but through Mini Golf's own real physics: a ball placed at rest exactly on the hole (velocity zeroed, position set to `g_hole_x`/`g_hole_y`) with `g_swing_state` forced to the in-flight state `on_tick`'s physics block requires, so a single `world.step()` exercises the actual speed-check and hole-distance-check branches rather than asserting against hand-set globals — confirms `g_won` sets and a new best (3 strokes) persists, then confirms a fresh `World` for that same cart loads it back via `on_init`'s own `LOAD_PERSIST`.

## 72. Sound — four persistent voices, driven by registers a cart pokes every frame, not a table of pre-authored clips

Second round of the same multi-feature pass §66-§70 opened (sound, persistence, sprite animation, tilemap authoring — persistence and sprite animation shipped first as the smaller items; this is sound). The starting point (`playSound(id)`, a hardcoded square-wave oscillator with a fixed 150ms decay and no other waveform) was architecturally a one-shot: every call built a throwaway `OscillatorNode`/`GainNode` pair and let it decay and stop — no persistent node a cart could re-tune frame to frame even if the opcode surface supported it.

**The design question settled during planning, not during this round, but worth restating because it shaped everything here**: a `sounds[]` header table + `PLAYSOUND <u8>` indexing into it (the same shape `sprites[]`/`tiles[]` already have) was the obvious first idea and was deliberately not built. Real sound chips don't play back authored clips — they expose live registers (frequency, duty cycle, volume) that the game's own code pokes every frame, and the tune is just whatever running code produces over time. That's the more interesting, more "virtual console" version of a sound system, and it fits this engine's existing shape well: there's already a fixed 60Hz `on_frame` hook and real arithmetic opcodes (`ADD`/`MUL`/`MOD`/etc.) a cart can already use to compute its own melody or arpeggio logic each tick — no new expressiveness needed on that side, just something for it to drive.

**Four new opcodes** (`kernel.js` OPS indices 59-62, appended after `STORE_PERSIST` — `PLAYSOUND` itself is untouched, this is additive): `SET_VOICE_FREQ voice` (pops Hz off the stack), `SET_VOICE_WAVE voice waveform` (both operands immediate — 0=square, 1=triangle, 2=noise, 3=sine), `SET_VOICE_GAIN voice` (pops a sustained volume, for a held note/drone), `TRIGGER_VOICE voice` (no stack operand — a fixed, engine-side decay envelope for a percussive hit). All four route through optional `ctx` callbacks the VM itself never implements (same shape as `ctx.setTile`/`ctx.loadPersist`) and are no-ops when the callback isn't supplied. **`TRIGGER_VOICE` deliberately has no duration operand** — a cart wanting a longer or sustained note already has `SET_VOICE_GAIN` for that, so a tunable percussive decay would be surface for a need the sustained-gain path already covers.

**Four voices, matching the Game Boy's channel count** — a bass line, a lead melody, a percussion/noise channel, and one to spare, without the audio-graph overhead of always running more persistent node pairs than that.

**Runtime engineering: one small node graph per voice, built lazily and left running.** `World._ensureVoice(i)` builds, on first touch, an `OscillatorNode` (type swapped live via `.type`, no rebuild needed for square/triangle/sine) and a looping white-noise `AudioBufferSourceNode`, each gated through its own gain (`oscGain`/`noiseGain`) into one shared `mainGain` — `SET_VOICE_GAIN`/`TRIGGER_VOICE` only ever touch `mainGain`, so switching a voice's waveform is just re-routing which source's gain is open (1) vs closed (0), never tearing down and rebuilding nodes. Both sources are `start()`ed once and simply left running (silent via gain 0) for the whole session — matches the old one-shot `playSound()`'s own lazy-init discipline (don't touch `AudioContext` until a cart actually makes a sound), just for a fixed pool created once instead of a node pair per call.

**A real bug, caught immediately by the smoke suite, not shipped and found later**: the first version of Flappy Bird's wiring set each voice's waveform once in `on_init` (square/sine/noise for flap/score/crash respectively), reasoning that every trigger site then only needs to touch frequency. That's exactly backwards for laziness — `on_init` runs synchronously in the `World` constructor, so `SET_VOICE_WAVE` there forced `_ensureVoice` (and the `AudioContext` behind it) to build immediately on *every* World construction, even a play session that never actually triggers a sound — defeating the "don't create an AudioContext before a cart needs one" discipline `_ensureVoice`'s own doc comment promises. A smoke check asserting `w.voices.every(v => v === null)` on a freshly-loaded World caught this immediately (`noVoicesYet: false`). Fixed by moving each `SET_VOICE_WAVE` call to its own trigger site instead (flap/score/crash) — redundant across repeated triggers of the same voice (harmless: `_ensureVoice` already memoizes, so this is just a `.type`/gain re-assignment, not a rebuild) but correct: a cart that never actually triggers a sound never touches `AudioContext` at all.

**A second bug, also smoke-caught, in the test methodology rather than the feature**: `SET_VOICE_GAIN`/`TRIGGER_VOICE`'s peak both originally used `gain.setValueAtTime(v, ctx.currentTime)` — technically-correct WebAudio automation-timeline usage, but reading `.value` back immediately afterward (what a test does, and in principle what a same-tick opcode chain might do) doesn't reliably reflect a `setValueAtTime`-scheduled event until the audio thread actually processes a render quantum at or past that instant — which real time, not just wall-clock, has to pass for. Both call sites now use a plain `gain.value = v` assignment for "this value, right now" (behaviorally identical to `setValueAtTime(v, currentTime)` per spec, but a direct property write is guaranteed synchronous) — `TRIGGER_VOICE`'s decay ramp still needs `exponentialRampToValueAtTime` (no other way to express a ramp), but its implicit start point is exactly that synchronously-applied peak. Once fixed, a third, unrelated failure remained: `0.4` read back as `0.4000000059604645` (AudioParam values are internally float32) — strict `===` in the smoke check was wrong regardless of the timing fix; switched to an epsilon comparison, the same category of fix `DIST`/`LERP`-adjacent float assertions elsewhere in this file already use.

**Determinism note, decided during planning and now written down in `hooks.md` rather than left implicit**: sound is presentation-only, the same as `on_draw` — none of the four opcodes change simulation state, so a muted or backgrounded client's simulation is unaffected either way. The one sharp edge: if a cart's melody/percussion logic calls `RAND_RANGE` to humanize timing or pitch, that call still consumes the shared, deterministic RNG stream every other opcode draws from — it has to run identically on every peer in a replay/multiplayer context even on a client where the sound is muted, or the shared stream desyncs the real simulation.

**Wired into a real cart, not left as opcodes with no caller**: Flappy Bird gets three sounds — a square-wave blip on flap, a sine chime on scoring, a noise hit on crash — each its own voice (0/1/2). The crash trigger needed one extra guard beyond "call it once": `on_tick`'s bird branch doesn't check `g_dead`, so a dead bird keeps falling and can stay AABB-overlapping the pipe it hit for several further ticks, which would otherwise re-fire `on_collide` (and this trigger) every one of those ticks. Fixed with a `LOADG g_dead / JNZ already_dead` guard around the trigger, so it only fires on the tick `g_dead` actually transitions 0→1 — verified with a smoke test that pins a full-height column entity to the bird's x every tick for 5 steps (guaranteeing continuous overlap) and asserts the crash voice fires exactly once.

Verified via `test/smoke.js` at two layers: a VM-level dispatch check (a mock `ctx` confirms all four opcodes route the right `(voice, operand)` pairs, independent of whether headless Chromium's Web Audio actually runs anything), and a `World`-level check against the real node graph's own state (`.osc.type`, `.frequency.value`, `.oscGain`/`.noiseGain` routing, `.mainGain.gain.value`) plus the end-to-end Flappy Bird trigger-counting test above. `opcodes.md` gets a new Sound section (mirroring Persistence's), `hooks.md` gets the determinism note; no `cart-object.md` change, since this feature adds no new cart field (no header table, by design).

## 73. A site-wide mute toggle — opt-in only, and a shared AudioContext instead of one per World

Requested directly, right after §72 shipped: "People don't like sites that play audio without opt-in." A small speaker icon next to Tinker (`#audioToggleBtn`, in `.topbar-right` alongside `#debugBtn`), one `localStorage`-backed on/off for every cart, defaulting to off.

**Landing this correctly required undoing part of §72's own per-World design, not just adding a switch on top of it.** Each `World` had its own lazily-created `_actx`/`voices`/`_noiseBuffer` — fine when the only question was "has *this* cart made a sound yet," but a site-wide mute needs one thing to actually mute, and a session that restarts a cart or switches games multiple times would otherwise leave a trail of independent, never-closed `AudioContext`s from every earlier `World` still running in the background (a latent leak §72 already had, just never exercised by anything before now). Moved `audioCtx` to module scope in `runtime.js` — one shared context for the whole page, every `World`'s voices route through it — which fixes that leak as a side effect and gives the toggle exactly one thing to control. `this.voices` stays per-`World` on purpose: different `World` instances (the live game vs. a Debug preview, or before/after a restart) can still have genuinely different voice states without fighting over the same four node graphs, they just all output through the one shared context now instead of each building their own.

**Suspend/resume the shared context, not a master gain node.** The obvious alternative — a gain node between every voice and the destination, zeroed on mute — was rejected because it would silently clobber whatever gain a cart's own `SET_VOICE_GAIN`/`TRIGGER_VOICE` had actually set, and toggling back on would need to somehow restore that lost value. `AudioContext.suspend()`/`.resume()` sidesteps this entirely: it halts and resumes *all* audio processing for every voice on every cart at once, with each voice's actual frequency/waveform/gain automation completely undisturbed — toggling back on picks up exactly where a held note or an in-flight decay ramp left off, because nothing about the cart's own state was ever touched.

**"Opt-in," taken literally: nothing constructs an `AudioContext` at all while the toggle is off**, not merely "produces no audible sound." `playSound`/`_ensureVoice` both gate on the module-level `audioEnabled` flag *before* touching `audioCtx` — a first-time visitor who never opts in never has any audio infrastructure built on their page, matching the request's own framing more literally than a muted-but-present context would. The only place `setAudioEnabled(true)` is ever called is the toggle button's own click handler in `main.js` — a guaranteed user gesture, which is also exactly what browser autoplay policy wants for constructing/resuming an `AudioContext` in the first place, so this reads as the textbook-correct pattern rather than a workaround bolted on for policy compliance.

**A real test-methodology bug, caught immediately, not shipped**: the first version of the button-click smoke test set the flag on programmatically (`K.setAudioEnabled(true)`) before clicking, then asserted the button's *icon* already reflected that. It didn't — `updateAudioToggleUI()` only ever runs from the click handler itself and once at page load, so a programmatic flip (exactly what several earlier checks in this same test file already do, to reach into `World` internals directly) leaves the visible button stale until the next real click. This is correct behavior for the shipped feature (nothing else in the app changes audio state outside a user click, so nothing else needs to resync the icon) — the test's assumption was wrong, not the code. Fixed by rewriting the check to never assume a starting visual state at all: read whatever the button currently shows, click, assert the four signals (`isAudioEnabled()`, icon, `aria-pressed`, the `localStorage` value) all flipped together and stayed internally consistent, click again, assert the same in the other direction — a round-trip check that doesn't care what state a prior test left the flag in.

No `references/*.md` or learn-site changes — this is page-level UI (`index.html`/`main.js`/`runtime.js`'s module-scope audio plumbing), not a cart-format or VM change; nothing here is part of what a cart author writes or reads.

Verified via `test/smoke.js`: defaults to off with no prior `localStorage` entry, voice opcodes are true no-ops while off (no node graph built at all, confirmed against `World.voices` staying `[null,null,null,null]` even after calling all four), and the actual button (not just the programmatic API) flips state/icon/`aria-pressed`/`localStorage` together and consistently in both directions.

## 74. Tilemap authoring — shape layers (`mapShapes`), and Mini Golf's hole fixup done properly

Third and last of the multi-feature design pass §66-§73 opened (sound §72, the audio toggle §73 that followed directly from it, persistence/sprite-animation earlier). Started as a side note during the memory-cap conversation (see Multiplayer, still not built): both real carts using `SETTILE` today (cave-crawler's gold pickup, Mini Golf's own checkpoint fixup) use it as a narrow, sparse, live-gameplay primitive — never as a level-building tool, since looping it to paint bulk terrain would be exactly the kind of unbounded mutation a future rollback-snapshot cap would need to catch. That left an open question worth answering on its own: what *is* the right way to hand-author a level shape that isn't procedural? A cart's own `sprites[]` already answers this for sprites (`shapes[]`, layered rects/ellipses, a full editor already shipped) — the same model, retargeted to a tile grid, is a direct answer for maps too.

**Not a fourth generator — an orthogonal compositing pass.** `mapGenerator` stays exactly 0/1/2/3; a new `cart.mapShapes` array runs as a post-processing step over whatever grid already exists once the generator (if any) has produced it, stamping each shape's declared tile id over the cells it covers, **in array order, later shapes win on overlap** — the exact z-order-collapses-down rule `renderShapeList` already uses for sprites, reused as-is rather than inventing separate overlap semantics. `mapGenerator: 0` normally means no map object at all; a shapes-only cart declares `cart.blankMap = {width, height, fillTileId}` to get an explicit flat grid to stamp into first. `SETTILE` is completely untouched — still the narrow, live, in-game mutation primitive it always was, on top of whatever `mapShapes` + the generator produced.

**Shape coordinates are tile-grid cells, not pixels** — `{tileX0, tileY0, tileX1, tileY1, tileId}`, a plain half-open range (`x1`/`y1` exclusive). Deliberately simpler than a sprite shape's pixel/sub-pixel math: no anti-aliasing or boundary-pixel ambiguity to resolve, since gameplay (`solidAt`) is already per-tile — authoring at that same granularity sidesteps a whole class of off-by-one edge cases a pixel-then-quantize approach would invite. Every entry is a rect; no ellipse variant for v1 (a tile grid has no sub-pixel coverage to rasterize the way a sprite ellipse needs).

**Binary format bump, 3→4** (`kernel.js`'s `encodeCart`/`decodeCart`, `SUPPORTED_FORMAT_VERSIONS`) — same no-compatibility-branch policy every prior bump has used, so every example cart and the Debug "+ New Cart" starter template got a mechanical `formatVersion: 4`. One real ordering subtlety: `blankMap`'s own presence in the byte stream depends on whether `mapShapes` is non-empty, but a decoder has no way to know that until it's read the shape count — so the shape count is written *before* `blankMap`, not after, even though `blankMap` conceptually "comes first" (you need a grid before you can stamp into it). Getting this backwards would leave `decodeCart` with no way to tell whether the next bytes are `blankMap` or the first shape. Cost for the 8 of 9 example carts that don't use this at all: exactly one new byte (the shape count, `0`) — about as close to "free" as a new required field can get. `fixtures.md`'s two fixtures regenerated for real (`K.encodeCart`/`K.decodeCart` run directly, not hand-patched) rather than hand-editing the documented byte dumps to guess at the one-byte shift.

**Wired into Mini Golf, replacing 4 hand-written `SETTILE` calls with 2 declarative shapes — "done properly," not just demonstrated.** `buildTrack`'s own `CHECKPOINT` stamp always marks a full `trackWidth`-wide gate line, which reads wrong for an actual hole (landing anywhere across the whole width looks like it should sink the putt, when only the exact centerline tile's physics check — `DIST` against the checkpoint's own coordinate — ever really did; see §53). The old fix reverted the 4 flanking tiles to fairway by hand in `on_init`, using `GET_CHECKPOINT`'s runtime value every single play. The new version: `buildTrack()` is a pure function of `cart.track` (no RNG, unlike the cave generator), so `carts/mini-golf.js` now calls it directly at cart-*build* time to get the exact same hole position the runtime will later compute — no need to hand-derive or hand-verify the geometry separately, the same "call the real thing, don't reimplement it" discipline this project keeps returning to (`World.buildBitmap()` reuse in the sprite editor, `buildTrack()`/`buildCave()` reuse in the shelf thumbnails). Two shapes, later wins on overlap: revert the whole gate line to fairway (id 2), then restamp just the centerline tile back to the hole graphic (id 5, `TILE_CHECKPOINT`) — `on_init` shrinks by the entire 4-`SETTILE` block, down to a single explanatory comment pointing at the cart's own `mapShapes` field.

**A real bug worth flagging for the next person editing a hook's assembly source, not just fixed silently**: the first version of `on_init`'s replacement comment used a backtick to reference `` `mapShapes` `` — but hook source lives inside a JS template literal (`` FLAPPY_HOOKS_SRC.on_init = `...` `` is the pattern every cart in this repo uses), and a backtick *inside* one prematurely closes it, producing `SyntaxError: Unexpected identifier 'mapShapes'` at cart-registration time. Caught immediately by `node --input-type=module --check` before it ever reached the smoke suite. Fixed by just not using backticks in a hook-source comment — the sharp edge is generic (any hook-source comment in this codebase that wants to `` `quote` `` an identifier will hit the same thing), not specific to this round.

Scoped out of this round on purpose, matching this project's established split between "format + runtime + a real cart using it" rounds and "editor UI for it" rounds when the editor is nontrivial (the sprite shape editor got 6 of its own stages, separate from when shape-list sprites themselves first shipped): an actual drag-to-draw visual editor for `mapShapes`, at tile-grid resolution, reusing the sprite editor's already-proven interaction model (select/move/resize/reorder, retargeted to snap to cells and pick a tile id instead of a palette color). A natural next round, not a gap in this one — every cart today authors `mapShapes` by hand, in JS, the same way every hook is hand-assembled text.

Verified via `test/smoke.js`: `buildBlankMap`/`applyMapShapes` directly (flat fill, later-shape-wins overlap, out-of-range shapes clip instead of throwing), a full `encodeCart`/`decodeCart` round-trip through both new fields, and Mini Golf's own real course end to end through an actual `World` — confirms the hole's tile is the checkpoint graphic (id 5) at the exact centerline, fairway (id 2) at all 4 flanking cells, edges untouched, with zero `SETTILE` calls left in `on_init`. `map-generators.md` gets a new "Tilemap authoring" section, `cart-object.md` documents the two new fields, `binary-format.md`'s byte-order list and `formatVersion` both updated (plus one accuracy fix found while spot-checking that file against the current encoder: item 10's sprite-shape-geometry description still said `& 0xFF`, which §62 already removed — corrected while touching this exact file for the same reason, not left for a future round to rediscover).

## 75. A tilemap shape editor — §74's own scoped-out follow-up, done the same day

Requested directly right after §74 shipped: "Make tilemap editing follow-up first," picking this over continuing into Multiplayer. Closes the wishlist item §74 explicitly deferred — a drag-to-move/resize visual editor for `cart.mapShapes`, reusing the sprite shape editor's already-proven interaction model (Sprite editor Stages 0-5, §77-83) retargeted to tile-grid cells.

**Almost entirely reuse, not new interaction design.** `getMapShapeBox`/`setMapShapeBox` mirror the sprite editor's `getShapeBox`/`setShapeBox` exactly, just integer-tile-snapped instead of 1/8px sub-pixel; `mapShapeEditorPointerDown/Move/Up` mirror `spriteEditorPointerDown/Move/Up` line for line; `renderMapShapeListPanel`/`wireMapShapeListPanel` mirror `renderShapeListPanel`/`wireShapeListPanel`, including re-fetching `lastParsedHeader.mapShapes` fresh inside every handler (the exact staleness discipline §62's own closure bug taught). The one new UI element is a tile picker (`.map-tile-picker`/`-trigger`/`-popover`/`-grid`/`-item`) standing in for the sprite editor's color picker — structurally identical to the entity-type asset picker (§65), given its own class names for the same reason that one needed them: the SPAWN operand picker, the entity asset picker, and now this tile picker can all be on the Logic tab's DOM at once, and a page-global selector would otherwise match more than one.

**Rendering reuses the real compositing pass, not a preview reimplementation.** The editor's canvas draws `inspectWorld.mapCanvas` directly — the actual pre-rendered map bitmap, already reflecting `applyMapShapes` composited in at `World` construction (§74) — so a drag can never show a fill pattern the compiled cart wouldn't actually produce, the same "never re-derive what the runtime already computed" discipline the sprite editor's `buildBitmap()` reuse established. Shown at native pixel size (8px/tile) inside a horizontally-scrolling wrapper rather than shrunk to fit like the sprite/tile editors — a map grid is already much bigger than a sprite, and shrinking a 40+-tile-wide grid down to a phone screen would make individual tiles and drag handles too small to hit precisely.

**`renderInspectMap`'s own gate had to change, not just gain new UI.** It used to read `if(cart.mapGenerator === 0 || !inspectWorld.map) return <empty message>` — correct before this round (mapGenerator:0 never had a map), wrong after: §74 made a `mapGenerator:0` cart *with* `blankMap`+`mapShapes` declared build a real map. Fixed to `if(!inspectWorld.map)`, the actually-correct test, letting a shapes-only cart's map show and be editable.

**A real, previously-latent bug found by this round's own smoke test, not shipped**: `hitTestHandle` (shared by both editors — written once for the sprite editor, reused as-is here) picks the first corner within radius in array-declaration order, not the closest one. For a typical sprite shape (roughly as wide as it is tall) this never surfaces. Mini Golf's own shape 0 — the hole fixup itself, 5 tiles wide but only 1 tall — hits it immediately: the ~1.5-tile handle-hit radius is *larger than the shape's entire height*, so every corner is ambiguous with its vertical neighbor, and a drag aimed at the SE handle silently grabbed the NE one instead (array order: NW, NE, SW, SE — NE comes first). Traced by instrumenting the real pointer handlers directly (not guessing from the symptom) after confirming the raw pointer events themselves carried the exact expected coordinates — ruling out an event-simulation issue before suspecting the hit-test logic. Fixed by comparing squared distance across every candidate corner within radius and keeping the closest, not the first found — a one-function fix that corrects both editors at once, since neither had its own copy. Left as a pointed comment on `hitTestHandle` itself, the same "this exact mistake is easy to reintroduce" flag §62 left on `wireShapeListPanel`.

Scoped out, on purpose, same restraint as every prior editor phase: no drag-to-create-a-brand-new-shape-from-empty-canvas (a "+ Shape" button adds one at a sensible default position/size, then it's dragged into place — identical to how the sprite editor's own "+ Ellipse"/"+ Rect" work, not a gap unique to this round); no editor path for authoring a *brand-new* `blankMap`-backed map from a `mapGenerator:0` cart that has no map at all yet (only a cart that already has one, from a generator or a hand-declared `blankMap`, gets the interactive canvas — matches the sprite editor's own "editing what's there, not bootstrapping a new asset from nothing" posture, §77's plan explicitly cut the analogous case for brand-new sprites the same way).

Verified via `test/smoke.js`, against Mini Golf's own real `mapShapes` (its §74 hole fixup, not a synthetic fixture): select-by-click (including confirming a click inside two overlapping shapes correctly resolves to the topmost/last-stamped one, not just "a" shape), corner-handle resize, body move (snapped to whole tiles), "+ Shape", reorder, recolor via the tile picker, delete, and a cart with no map at all still showing the plain empty-state message. Screenshot-verified in both themes plus the 375px mobile viewport (0px horizontal overflow) from §61.

## 76. Memory caps — a real bug backstop, and multiplayer's first prerequisite

First round of Multiplayer, the last of the five features from the original design pass (§66's own opening). Rollback netcode needs a state snapshot small enough to send over P2P on every mispredict — but before any of that, `spawnEntity()` and `setTileAt()` had no cap at all: a cart whose `on_tick` unconditionally `SPAWN`s already grows `this.entities` forever until the tab dies, single-player, no networking involved. That's the framing this round shipped under: real, independent bug-backstop value first: rollback affordability is a consequence, not the only reason to have it.

**Sized from measurement, not guessed.** The original design conversation profiled all 9 example carts for 3600 frames (60s) under synthetic worst-case input (every button combo cycled plus a pointer drag) in a headless-browser harness, sampling peak entity count and total prop-field count every frame. Worst observed: race-car's collision particles, 2.65KB. Every other cart peaked well under 1KB.

**Two separate caps, not one shared budget, because they bound different failure modes:**
- **16KB** for `globals` (a fixed 96 bytes) plus every active entity's `props` (4 bytes/field, matching the `f32` width `ByteWriter` already uses in the binary format) — roughly 6x the worst measured peak. `spawnEntity()` checks this *before* pushing; past it, `SPAWN` becomes a graceful no-op rather than a crash or a `cartFault` — the same posture a lost network peer resimulating the identical cap would need anyway, so building it as "no-op, not fault" now costs nothing later.
- **1024 entries** for `setTileAt`'s new `tileDiffLog` (`{x,y,tileId}` per call, tile-grid coordinates) — a separate budget so a `SETTILE`-heavy cart and a `SPAWN`-heavy cart never compete for the same ceiling. Real usage across every shipped cart that calls `SETTILE` at all tops out at 16 calls a full playthrough (cave-crawler's gold pickups) — 1024 is >60x that, while still stopping a runaway loop well short of diverging the full generated grid.

**The capped-`SPAWN` return value needed no new sentinel — it already existed as documentation.** `kernel.js`'s own `runHook` doc comment, written for the *minimum ctx shape* a caller can supply, already specifies `spawn:()=>({id:0,props:[]})` as what a host with no real spawn capability should return. Reusing that exact shape here means every existing `STOREE`/`LOADE`/`findEntity` call already treats a write through id `0` as a silent no-op (`nextId` starts at 1, so `0` is never a real entity's id) — no VM change was needed to make a capped `SPAWN` safe, only `runtime.js`'s own bounds check.

**`tileDiffLog` isn't consulted by anything yet.** It exists now, capped and real, specifically so the cap itself is testable and shipped today rather than retrofitted once the actual rollback/resync machinery (a later round) needs to read it. `setTileAt` becomes a no-op past the cap for the same reason `SPAWN` does past its own — keeps the live grid and the log that's supposed to describe it from ever disagreeing about what's actually been mutated.

Verified via `test/smoke.js`, calling `spawnEntity`/`setTileAt` directly against a real `World` (not through 450+ real hook-driven `SPAWN` calls, which would be slow to simulate and no more informative than exercising the same runtime methods the opcode itself routes through): confirms the exact call count where `SPAWN` starts returning id `0`, that `entities.length` stops growing at that point and stays stopped on every further call, that the tile-diff log stops at exactly 1024 entries, and that a capped `SETTILE` neither grows the log nor mutates the grid any further — none of it ever setting `cartFault`. `opcodes.md`'s `SPAWN`/`SETTILE` entries document both caps' behavior for a cart author reading them cold.

## 77. Multi-player input model — one shared `inputs[4]`, quantized pointer capture, and a per-player pointer opcode

Second round of Multiplayer (§76 was the first: memory caps). This round doesn't touch networking at all — it lays the input-plumbing groundwork rollback netcode needs later: every hook already reading input identically off `ctx` had to become "identical, but from one of four slots" before there was anything to synchronize between peers.

**WASM-4's own trick made this small.** `this.input`/`ctx.input` (a single shared scalar, read by every hook call the same way every tick) became `this.inputs`/`ctx.inputs` — a fixed 4-slot array instead. Because every hook already reads the exact same shared value every tick regardless of which entity or player it's conceptually "for," widening it to 4 slots needed no change to hook invocation at all — just `LOAD_INPUT` gaining a `u8` player-slot operand (`LOAD_INPUT 0` reads the local player; a remote peer's input will land in slots 1-3 once the networking round exists). "Which entity belongs to which player" stays a pure authoring convention — an entity's own prop field, same as before — not something the engine tracks.

**A breaking bytecode change made in place, on purpose, same as every other opcode-only change this project has made before it.** `LOAD_INPUT`'s operand shape changed at the same opcode index rather than adding a new opcode alongside it, because `formatVersion` (currently 4) only governs the binary *cart header* layout `encodeCart`/`decodeCart` read and write — not bytecode opcode semantics, which have already changed in place for `LOAD_PERSIST`/`STORE_PERSIST` and the `SET_VOICE_*` family without a version bump. There's no format-version concept for "old bytecode encoded against yesterday's opcode table" to begin with — cart source is always recompiled from the authored JS, never decoded-and-relinked bytecode from an old link — so there was nothing to preserve compatibility with.

**`LOAD_POINTER_X`/`Y`/`DOWN` stay untouched, on purpose — `LOAD_POINTER_P` is new and additive instead of widening them.** Redefining the existing pointer opcodes to take a slot operand would have been the "symmetric" choice, but it wasn't the one this project's own history argues for: every past change here has preferred adding a new opcode over redefining one already in carts (mirroring exactly how `LOAD_INPUT` itself was deliberately *not* treated this same way — its in-place change is the sanctioned exception, not the template). `LOAD_POINTER_P <u8 slot> <u8 axis>` (axis: 0=x, 1=y) is the new per-player counterpart, mirroring the handle-plus-field shape `LOADE` already uses for cross-entity prop reads, reading from new `ctx.pointerXs`/`ctx.pointerYs` arrays that sit alongside the old scalar `ctx.pointerX`/`Y` untouched.

**No per-player "pointer down" opcode — it folds into `LOAD_INPUT`'s own bitmask instead, as a new reserved bit.** Bit index 5 (value 32) of a player's `inputs[slot]` means "this player's pointer is currently held," tested via ordinary `TESTBIT 5` — conceptually just another button, not a second parallel per-player array the way `LOAD_POINTER_DOWN` is for the single-player case. That bit is deliberately kept structurally separate from `BUTTON_BITS = [1,2,4,8,16]` (indices 0-4): `BUTTON_BITS` is which *authored, labeled* buttons a cart declares via `inputActiveButtons`/`inputButtonLabels` — touch-UI-relevant, opt-in, per-cart — an unrelated concept from "is this player's pointer currently held," which is always-on runtime infrastructure whenever `inputWantsPointer` is set, the same separation `LOAD_POINTER_DOWN` already had from the button system before this round.

**Pointer position is quantized to whole cart pixels at the moment it's captured, not just for display.** `pointerToCartCoords` (runtime.js) now rounds both axes before they're ever stored — a determinism requirement for the rollback netcode this round exists to unblock: every peer replays another peer's captured input verbatim, so a value that isn't already quantized at the sender would need reconciling downstream, and since it's the sender's own authoritative input, any such divergence would never self-correct. `loop()`'s per-frame capture block populates `inputs[0]` from `buttonMaskFromKeys()` with the pointer-down bit folded in, plus `pointerXs[0]`/`pointerYs[0]` — alongside the untouched scalar `pointerX`/`Y`/`Down` writes, since `LOAD_POINTER_X`/`Y`/`DOWN` still read those unchanged.

**Every shipped cart's bare `LOAD_INPUT` became `LOAD_INPUT 0`, mechanically** — 29 call sites across 8 carts (breakout, castle-crusher, cave-crawler, doom-like, flappy-bird, mini-golf, race-car, run-and-jump), all local-player reads, none needing any behavior change beyond naming the slot explicitly. `inspector.js`'s opcode palette got the same treatment — `LOAD_INPUT` picked up an `operandKind:'raw'` slot picker (a player slot has no cart-data table to pick from, same reasoning as the Sound group's raw voice-index pickers), and `LOAD_POINTER_P` was added alongside `LOAD_POINTER_X`/`Y`/`DOWN` in the Input group.

**A near-miss worth recording:** the first draft of `runHook`'s updated "minimum ctx shape" doc comment wrote `LOAD_POINTER_*/LOAD_POINTER_P` inline — inside a `/* ... */` block comment, that `*/` is a literal comment terminator, not text, and silently truncated the comment mid-sentence, dropping the rest of the block into live code and producing a page-load-breaking syntax error the moment the built site loaded in a browser (`node --check` on `kernel.js` alone caught it in a second; the smoke suite's very first `waitForFunction` had already timed out on it before that). Fixed by spelling it out (`LOAD_POINTER_X/Y/DOWN and LOAD_POINTER_P`) instead of using the glob shorthand — a small reminder that a doc comment's own delimiters are as much a part of "does this parse" as the code around it.

Verified via `test/smoke.js`: VM-level dispatch against a mock `ctx` confirms `LOAD_INPUT slot` reads the correct player's bitmask (not a single shared value) and `LOAD_POINTER_P slot axis` reads the correct `pointerXs`/`pointerYs` entry, plus a fallback check that both still read `0` rather than throwing when `ctx.inputs`/`pointerXs`/`pointerYs` are absent entirely (the documented minimum shape). A mid-drag snapshot on the "Water the Plant" cart (the only point in the suite where a real pointer is actually held) confirms `pointerX`/`Y` land on whole cart pixels, `pointerXs[0]`/`pointerYs[0]` stay in lockstep with the old scalars, and `inputs[0]` carries bit 32 while `inputs[1]` stays untouched. The existing Flappy Bird flap test (previously poking `w.input` directly) now pokes `w.inputs[0]`. `opcodes.md`'s Input section and `workflow.md`'s worked example and headless-`ctx` snippet were updated to match the new operand/array shapes.

## 78. Rollback snapshot/restore machinery — a pure state capture, an 8-tick ring buffer, and resimulation, all still purely local

Third round of Multiplayer (§76: memory caps; §77: the multi-player input model). Still no networking at all — this round builds the primitives a later round's real peer-to-peer rollback loop will drive, and proves them correct in isolation, the same "build the machinery before there's a caller for it" posture §76's own `tileDiffLog` already took for `SETTILE`.

**What gets captured, and why each piece is there.** `World.snapshotState()` deep-copies exactly four things: every active entity's `id`/`typeId`/`active`/`props` (a deep copy — `props` arrays are mutated in place by `STOREE`/`STORE_SELF`, so a shallow reference would let the *next* tick silently corrupt an "old" snapshot sitting in the ring), `nextId` (skip it and entity identity desyncs the moment anything spawns or despawns between the snapshot and a later correction — a resimulated `SPAWN` needs to hand out the same id a forward-only run would have), the 24 `globals`, and the RNG's own internal state. `cartFault` and `tick` ride along too, for the same reason: `restoreState()` needs to put *everything* `step()` can change back exactly where it was, not most of it.

**Deliberately excluded: the tilemap and `persist[]`.** Restoring `entities`/`globals`/RNG but leaving `this.map.grid` wherever it currently sits is a real, accepted gap — a mispredicted `SETTILE` from a thrown-away tick can leave the wrong tile painted, and resimulation only fixes it if the *corrected* run happens to write that same cell again. This is exactly why §76 sized `tileDiffLog`'s cap for a full resync path in the first place (replay the log against a freshly generated base map) rather than folding grid state into every tick's snapshot — both shipped `SETTILE`-using carts use it for one-shot cosmetic fixups (cave-crawler's pickups, Mini Golf's hole graphic), not core simulation state, so the gap is a rare edge a periodic resync closes later, not something every rollback tick needs to carry the weight of. `persist[]` doesn't need touching at all — a later round disables `STORE_PERSIST` for a match's whole duration, so rollback never has reason to reach for it.

**The RNG had to stop being a closure to be snapshotable.** `mulberry32(seed)` returned a function closing over its own private `a` — there was no way to read or rewind that state from outside it. Restructured into `mulberry32Next(state)`, a pure function taking the current 32-bit state and returning the next float plus the state to carry forward; `World` now holds `this.rngState` as a plain field, advanced by `this.rng()` calling the pure step and writing the result back. Checked call-for-call against the original closure (1000 calls each, 5 different seeds, in a standalone Node script) before touching `runtime.js` at all — a seed producing even one different value would have silently changed every existing cart's map generation output.

**A reference-identity trap the constructor itself sets, and `restoreState()` has to respect.** `this.ctxBase.globals = this.globals`, captured once at construction and reused for the World's whole lifetime via `ctxScratch`. `restoreState()` writes the restored values into that same array in place (a loop of `this.globals[i] = snap.globals[i]`) rather than `this.globals = snap.globals.slice()` — the tempting, simpler-looking line — because reassigning would leave every hook still reading and writing the old, now-orphaned array. `this.entities`, by contrast, *is* safely reassignable: every access goes through a live `this.entities`/`self_.entities` property read (`findEntity`, `step()`, the renderer), never a reference captured once and held.

**The ring buffer stores pre-tick snapshots, keyed by the tick about to run.** `step()` pushes `{tick: this.tick+1, state: this.snapshotState()}` onto `rollbackRing` *before* any mutation, trims to the last `ROLLBACK_WINDOW` (8) entries, then proceeds exactly as before — so the entry tagged `tick: N` is "the world exactly as it was about to simulate tick N," not tick N's result. `resimulateFrom(tick, getInputs)` looks up that entry, restores it (which rewinds `this.tick` too, since it's part of the snapshot), discards any newer ring entries (they're about to be regenerated with corrected history), then replays `step()` from `tick` up through whatever tick the World was actually at, substituting `getInputs(t)` for `this.inputs` before each replayed tick. A `tick` no longer in the ring returns `{ok:false}` without touching any state — the signal a later round's networking layer will use to fall back to a full resync instead of attempting a bogus local recovery.

**A test-writing trap worth recording:** the first draft of the smoke test drove `World.step()` directly against the currently-loaded cart and asserted on absolute tick numbers (`w.tick === 3`) — failed immediately, because the page's real-time `requestAnimationFrame` loop had already been calling `world.step()` in the background from the moment the cart loaded, so `w.tick` was never 0 to begin with by the time the test's own `page.evaluate()` ran. Fixed two ways: `pauseGame()` (already exposed on the debug surface) stops the ambient loop before the test takes over, and every assertion became relative to a `tickAtStart` captured after an unconditional 10-tick warm-up, rather than an absolute number — decouples the test from exactly how many ambient frames happened to run before `pauseGame()` took effect. A second trap in the same test: the "does resimulating an earlier tick with different input change the outcome" check first compared the bird's *velocity* after the correction, which came back identical every time — Flappy's flap handler unconditionally overwrites velocity to a fixed value on any flap tick, so whichever tick's input got corrected, the *last* tick's flap reset velocity to the same number regardless of history. Position, not velocity, is what actually integrates that history forward, so the check moved to `props[1]` (y) instead.

Verified via `test/smoke.js`, entirely through direct `World` method calls (no real networking exists yet to drive this through): the ring buffer holds exactly 8 entries and evicts older ones; `restoreState()` reverts a mutated prop/globals array back to a snapshot twice in a row without drifting (the deep-copy check); replaying an identical input sequence from the same restored point twice produces byte-identical props, globals, *and* RNG state both times; `resimulateFrom()` with a corrected input lands back on the same final tick number while producing a genuinely different outcome; a tick that's fallen out of the window fails cleanly; and two independently-constructed `World`s from the same cart land on identical RNG state after an identical tick sequence, confirming the `mulberry32Next` restructure didn't change what a given seed produces.

## 79. Trystero signaling + a match lobby — two peers can now find each other, no server involved

Fourth round of Multiplayer (§76: memory caps; §77: multi-player input model; §78: rollback snapshot/restore machinery). This is the first round that touches a real network — and, on reflection partway through planning it, too big a round to ship as one thing: getting two peers *connected* (this round) and actually *syncing gameplay* over that connection (driving §78's rollback machinery with real remote input) are separably-shippable, separately-risky pieces of work, so they're staying two rounds rather than one. What shipped here stops at "two browsers can find and reach each other and know it" — no gameplay wiring yet.

**A real, upfront constraint shaped most of this round's decisions: this sandbox cannot reach the live internet.** The proxy this environment runs behind allow-lists `registry.npmjs.org` but returns 403 for CDN hosts (`unpkg.com`, `esm.sh`, `cdn.jsdelivr.net`) and — confirmed by hand — for the public BitTorrent trackers Trystero's signaling actually needs (`wss://tracker.openwebtorrent.com/` etc. all failed with real "tunnel via proxy server failed" errors when tried for real, not a bug in the code being tested). Two decisions followed directly from asking the user about this rather than picking silently: vendor Trystero into the repo rather than CDN-load it at runtime (`url-console/v0/vendor/trystero/`, its own README explains the two mechanical edits made to the raw npm dist files), and accept that this round's automated tests cannot prove a live two-browser handshake works — only that everything on this side of that handshake (the UI, the state machine, the wiring) behaves correctly, driven through a mock transport instead. **That live handshake still needs manual verification in two real browser tabs before this is trusted for real users** — the one honest gap this round leaves open.

**Which Trystero strategy, and why vendoring was even straightforward.** Trystero split (as of the vendored 0.25.3) into one scoped npm package per signaling strategy — `@trystero-p2p/torrent`, `-nostr`, `-mqtt`, `-ipfs`, plus `-firebase`/`-supabase` (need an account, ruled out immediately by this project's own "no server, no account" principle). Torrent was picked over the other serverless options mainly for being the most battle-tested and for pulling in zero further dependencies of its own (Nostr's package needs `@noble/secp256k1` for signing; torrent needs nothing). The vendored result is ~119KB across a dozen `.mjs` files, pure browser-native code (`RTCPeerConnection`, `WebSocket`, no Node-isms) with only internal relative imports — exactly the shape a static, build-step-free site can serve as-is, once one bare-specifier import (`@trystero-p2p/core`) was rewritten to a relative path pointing at the renamed `core.mjs` sitting next to it.

**`maxPlayers` — a real header field, not a `modeFlags` bit.** `modeFlags` is documented (opcodes.md) as reserved entirely for cart-author use; multiplayer opt-in is a runtime-dispatch-relevant fact about the cart, an unrelated purpose. Bumped `formatVersion` 4→5 (a new required header byte, same "not appendable without a version bump" reasoning every prior bump has used) — and, while touching every formatVersion-bearing file anyway, fixed three doc surfaces (`fixtures.md`, `cart-object.md`, `binary-format.md`) that had drifted to stale version numbers from *previous* bumps (§74's 3→4 bump never got followed all the way through `cart-object.md`'s "Must be `3`" prose or `workflow.md`'s worked example) — caught only because this round's own bump forced a fresh look at every place a format version gets asserted. `maxPlayers` itself defaults to `1` if omitted (the only header field whose default lives in `encodeCart` itself rather than `defaultCartFields()`, since it's really "this cart didn't opt in," not a blank a cart author forgot to fill) and `encodeCart` throws for anything outside `1`/`2` — a hard v1 ceiling matching what the rollback ring buffer and this round's own lobby actually support, not a soft suggestion a cart could round up from. `fixtures.md`'s two fixtures were regenerated for real (`K.encodeCart`/`K.decodeCart` run directly), the same policy §74's own round already established for exactly this situation.

**The match lobby is new UI surface, not a repurposed popover.** Every existing overlay in this codebase (the color picker, the map tile picker) is small and anchored to its own trigger — none of them fit a multi-step host/join flow with real back-and-forth (choice → room code or join form → waiting → connected/error). New `.mp-overlay`/`.mp-card` CSS instead: a centered, scrim-backed modal, the first of its kind here. A room code is a 5-character code from a 32-character alphabet that deliberately excludes `0`/`O`/`1`/`I` — the four characters most likely to be misread when read aloud or typed by hand, since (unlike the cart fragment itself) this is meant to be communicated verbally or typed, not copy-pasted. Player-slot assignment (0 or 1, "Player 1"/"Player 2" in the UI) needs no host-arbitrated handshake at all: both peers independently sort `[selfId, peerId]` and take their own index in that sorted pair — deterministic and symmetric by construction. A room is namespaced to the exact cart being played (`appId` derived from `hashCartBytes(encodeCart(cart))`, reusing the exact hash `runtime.js` already computes for the persist key, DESIGN.md §69) so a host and guest only ever find each other across byte-identical carts — a hand-edited variant of "the same" cart gets its own room space rather than silently connecting a mismatched pair of peers.

**A third peer showing up (outside v1's 2-player cap) is a noted gap, not a policed one.** By the time Trystero's `onPeerJoin` fires, that peer has already completed its WebRTC handshake — there's no "reject before connecting" hook in the API this round reaches for. The session just never treats a third `peerId` as *the* opponent (an early `if(session.peerId) return` in the join handler), which is enough to keep the UI and the (future) gameplay sync from getting confused, but doesn't disconnect the stray peer or stop it from occupying a WebRTC connection slot. Acceptable for now — genuinely fixing it means either policing room size before the handshake completes or actively dropping a peer's connection after the fact, both real design work with no forcing function yet, since nothing downstream of "who's in this room" exists until the next round wires gameplay through it.

**Testing this without a network needed one real seam, added on purpose.** `multiplayer.js`'s `openLobby(cart, {joinRoomFn})` — and `hostMatch`/`joinMatch` underneath it — accept an optional transport override that the real "Multiplayer" button's click handler never supplies (so production always uses the real vendored Trystero), but that `test/smoke.js` reaches through `window.__urlcadeDebug` with a synthetic mock room (`{onPeerJoin, onPeerLeave, leave}`, driven by hand) to exercise the *entire* lobby state machine — host, a peer joining, that peer leaving, reconnection, the stray-third-peer guard, the join-code-normalization path, and a synchronously-throwing transport surfacing a visible error — without a single real network call. Confirmed this actually worked, not just in theory: the one time a test path *did* reach the real `joinRoomFn` (an early manual check, before the mock seam existed), the browser's console genuinely tried to reach `wss://tracker.openwebtorrent.com/` and friends and failed exactly the way the sandbox's own proxy policy predicts — real evidence the wiring is correct and only the live handshake itself is untestable here.

**A near-miss caught by the smoke suite's own infrastructure, not by inspection.** `test/smoke.js`'s local static file server didn't know `.mjs` should be served as `text/javascript` — every vendored Trystero file 404'd-by-MIME-type (Chromium enforces strict MIME checking for `<script type=module>` and its dynamic imports), which surfaced as the exact same "page never finished loading" timeout a genuine syntax error would produce. One line fixed it (`.mjs` added to the test server's MIME map) — a reminder that a local test harness's own serving assumptions are as much a part of "does this actually work" as the application code itself, the same category of gotcha as `build-site.sh`'s cache-busting regex needing to *not* mangle `.mjs` imports (verified it doesn't: the pattern requires a literal `.js` immediately before the closing quote, which `.mjs` doesn't contain).

Verified via `test/smoke.js`: `maxPlayers` round-trips through encode/decode (defaulting to 1, preserving an explicit 2, throwing outside that range), the header form's new select reaches the recompiled cart, the "Multiplayer" button's visibility tracks the loaded cart's `maxPlayers`, and the full lobby flow (choice screen, hosting shows a room code that matches what the transport received, a mock peer joining shows the correctly-assigned player number, that peer leaving shows a visible disconnected state rather than a silent freeze, closing the lobby actually calls the underlying room's `leave()`, the join form normalizes a typed code, and a throwing transport surfaces a visible error) all pass against the mock transport. `vendor/trystero/README.md` documents provenance, the strategy choice, and exactly what was edited from the raw npm packages. **Live two-peer connectivity has not been verified in this sandbox and needs a manual check in two real browser tabs before this ships for real users** — see this round's own opening note.

## 80. Gameplay sync — real player input now flows over the wire, and DESIGN.md §78's rollback machinery finally has a caller

Fifth round of Multiplayer (§76: memory caps; §77: multi-player input model; §78: rollback snapshot/restore machinery; §79: Trystero signaling + a match lobby). §79 stopped at "two peers can find each other" on purpose, planned as its own round rather than folded into this one — and that split held up: this round is the payoff, wiring a connected room's messages into `World.inputs[]` and, on a misprediction, §78's `resimulateFrom()` — the actual reason that machinery got built two rounds early.

**The predictor is "repeat the last confirmed input," the simplest thing that could work, and it's the one every small rollback implementation reaches for first.** Every tick, each peer sends its own player slot's input mask tagged with the tick number it's for. The *local* player's input for any tick is never in question — it's this peer's own, known the instant it's captured — so the only thing ever guessed is the *remote* player's input for a tick whose real value hasn't arrived yet, and "assume they're still doing what they were last doing" is right far more often than not for a held button on a 16ms clock. When the real value for an already-simulated tick turns out to disagree with the guess, `World.resimulateFrom()` rewinds to that tick and replays forward with the corrected history.

**Testing this without a live network turned out to be strictly better than testing it with one, not just a workaround for this sandbox.** Two real, independent `World` instances (same cart, same seed) get "networked" through a pair of linked in-process mock rooms — `send()` on one side calls the other side's `onMessage`, after an optional artificial `setTimeout` delay. Driven forward with *different* scripted local inputs on each side, both worlds converge to byte-identical globals, entities, RNG state, and tick count — first at near-zero latency (no misprediction ever possible, proving the happy path), then again with a deliberate 30ms one-way delay at a 16.6ms tick (guaranteeing at least one tick simulates on a guess before the real value lands, proving the correction path actually fires and still converges). A real, jittery network connection would only ever prove the happy path by luck of timing; this proves both paths on purpose, every run, deterministically. The two-Worlds harness is genuinely more rigorous than anything a live connection could have offered here, sandbox restrictions aside.

**A connected match restarts both peers' games from scratch, on purpose — it doesn't try to reconcile whatever each side happened to already be doing.** The `World` that was already running single-player before a peer showed up has no reason to agree with the peer's — different play sessions, different RNG progress, different entity state — so reconciling them would mean inventing a whole second synchronization problem on top of the one this round already solves. Restarting to a shared `on_init` state the instant `connected` fires sidesteps that entirely: both peers begin ticking from identical zero, and from there tick-tagged messages plus the predictor/corrector above are sufficient. Both peers do this restart independently, the moment *they themselves* observe `connected` — no explicit "ready" handshake first. This works because ticks are numbered, not wall-clock-timed: a peer whose restart happens to complete a few milliseconds earlier just has its early messages sitting in the other side's `remoteConfirmed` map, waiting to be consumed exactly like a same-timing message would be.

**A real race condition, caught before it shipped, not after.** `beginSyncedMatch()` has exactly one await (`startGame()`, which rebuilds the whole `World`) — and a peer that joins and disconnects again before that await resolves would otherwise let the *stale*, since-superseded call go on to attach a sync controller and a per-tick hook after the match it belonged to had already ended, quietly resuming ticking on a hook nothing was meant to still be running. Fixed with a monotonic `matchGeneration` counter, bumped both when a new synced match starts and whenever sync stops (`peer-left`, closing the lobby) — `beginSyncedMatch` checks its own generation is still current immediately after the await, and simply does nothing if it isn't. No `AbortController` needed: nothing here has to actually cancel `startGame()` mid-flight, only notice after the fact that its result no longer matters. Caught by writing the smoke test for "a mock peer joins and instantly leaves," not by inspection — the exact kind of timing bug that's easy to miss by reading the code in isolation and obvious the moment a test tries to drive both transitions back to back.

**Restarting mid-match has no defined meaning yet, so the button that would trigger it is hidden, not left to silently desync things.** The existing "restart" button re-decodes the current fragment and rebuilds the `World` from scratch — exactly what `beginSyncedMatch` itself does at match start, but with no coordination between peers if triggered *during* a match (both would need to agree and re-sync together, out of scope this round). Hidden for the duration of a synced match, restored the moment sync stops — the same "prevent the broken path outright rather than let it corrupt state" posture the stray-third-peer guard from §79 already took.

**Deliberately unsolved and stated as such: no full-resync fallback when a correction's target tick has already fallen out of the rollback window.** §78's own `resimulateFrom()` already returns `{ok:false}` for exactly this case; `startMatchSync`'s message handler calls it, gets that result back, and does nothing further — the world is left either freshly corrected or silently diverged from the peer's, with no mechanism yet to detect or recover from the second outcome. This isn't new scope creep to close now — the persist-key-shaped, `hashCartBytes`-namespaced groundwork and the tile-diff log from §76 were both explicitly sized for a resync path back when they were built, and closing this gap for real is exactly that: replaying the tile-diff log against a freshly generated base map, extended to cover the rest of simulation state too. A real, live network's actual jitter characteristics — not a sandbox's guess at plausible delay values — are what should drive whether this is ever worth building, which is one more reason the manual two-browser check this round (and §79) both still need is the thing to do next, before investing further here.

Verified via `test/smoke.js`: two independently-simulated Worlds converge under both near-zero and deliberately-induced-misprediction latency, neither ever faulting; the full UI-driven path (a mock peer joining a hosted room) actually restarts the game to tick 0, hides the lobby modal, hides the restart button, and keeps the match ticking live via the real `requestAnimationFrame` loop without faulting; closing the lobby after a match restores the restart button. **Live two-peer connectivity — and, now, live two-peer gameplay sync under real network jitter — still has not been verified in this sandbox** and needs manual verification in two real browser tabs, compounding the same gap §79 already flagged.

## 81. STORE_PERSIST goes silent for the duration of a match — closing out the original five-item Multiplayer roadmap

Sixth round of Multiplayer, and the last one on the original list (§76: memory caps; §77: multi-player input model; §78: rollback snapshot/restore machinery; §79: Trystero signaling + a match lobby; §80: gameplay sync). Worth naming directly: the original design pass scoped Multiplayer as five items, and it shipped as six rounds — §79's own writeup already explains why (signaling+lobby and gameplay sync turned out to be separably-shippable, separately-risky pieces once actually in progress), and this round is the fifth *item*, sixth *round* by that same split. Small by comparison to the five before it — no new opcode, no header field, no new UI — but it closes a real correctness gap the rollback machinery opened back in §78 and left unaddressed on purpose.

**The bug this closes: a `STORE_PERSIST` write has no undo.** `resimulateFrom()` (§78) can rewind and replay a mispredicted tick because every piece of state it touches — entities, globals, RNG, `cartFault` — is covered by `snapshotState()`/`restoreState()`. `localStorage` never was, and structurally can't be the same way: it's not part of the `World` object at all, and by the time a correction says "that tick shouldn't have happened that way," a `STORE_PERSIST` call from the mispredicted version has already landed a byte in a place nothing here can find and revert. A cart using persist for something like a high score would silently persist a value computed from a play that — once the correction lands — never really happened, with no way to notice, let alone recover. This isn't hypothetical the way an untested edge case might be: it's the direct, structural consequence of building a rollback system whose whole trick is variable-swapping in-memory state, applied to a side effect that lives outside that state.

**The fix is one flag and a guard clause, on purpose.** `World.multiplayerActive` (`false` for every ordinary single-player game) gates `ctxBase.storePersist` — a `STORE_PERSIST` call is a silent no-op for as long as it's `true`. `LOAD_PERSIST` is untouched; only writes carry the undo problem. `multiplayer.js`'s `beginSyncedMatch()` sets the flag the instant a fresh, match-bound `World` is built; `stopSync()` clears it again when a match ends (`peer-left` or closing the lobby) — explicitly, not implicitly, because the `World` itself survives past the match ending (the player may keep playing solo on it), so nothing else would ever flip the flag back.

**No opcode or format change, and CLAUDE.md's own upsert rule reflects that.** `STORE_PERSIST`'s bytecode-level contract (operand shape, stack effect) is exactly what it was — what changed is a runtime *behavior* under a condition a cart author can't directly observe or control, documented as a note on the existing `opcodes.md` Persistence section rather than a new entry, `cart-object.md`, or a `binary-format.md` change, since none of those describe anything that moved.

Verified via `test/smoke.js`: `STORE_PERSIST` (exercised directly through `ctxBase.storePersist`, the same callback the opcode itself routes through) writes normally when `multiplayerActive` is `false`, silently no-ops when it's `true`, and `LOAD_PERSIST` reads the last real value regardless — plus, through the real match-start flow, that a peer joining actually sets the flag on the freshly-restarted `World` and that closing the lobby afterward clears it again.

With this round, every item from the original Multiplayer design pass has shipped in some form. What hasn't shipped is verification against a real second peer — §79 and §80 both flagged the same gap (this sandbox cannot reach the public trackers Trystero's signaling needs), and it's still open. Everything on this side of an actual WebRTC handshake — signaling, the lobby state machine, prediction, correction, persist-gating — is built and tested; the handshake itself, and gameplay sync under real (not artificially-induced) network jitter, have not been.

## 82. A local-player camera/HUD offset — the presentation-layer piece the engine rounds never needed until content asked for it

§76-§81 built the entire Multiplayer *engine*: two peers can find each other, their input streams stay in sync, corrections replay cleanly, persistence doesn't diverge. None of it needed either peer's *view* of the shared simulation to differ from the other's, because no shipped cart had ever had two humans looking at the same World from two different cars/characters at once. Making Race Car (§83) an actual 2-player game exposed the gap directly: `camera.followGlobal` and `hudSpec`'s entity-sourced rows are static header fields, the same on both peers' identical bytecode — read literally, both screens would always center on and report player 1's car, never player 2's.

**The fix stays presentation-only, on purpose — no opcode, no binary-format field, no new cart-authoring concept.** `World` gains `localPlayerSlot` (0 or 1, default 0 — always 0 outside a match, so every existing single-player cart is unaffected). `updateCamera` now reads `globals[cam.followGlobal + world.localPlayerSlot]` instead of `globals[cam.followGlobal]`; `renderHUD` applies the identical offset to `srcA` for every `sourceKind: 1` (entity-derived) row. `sourceKind: 0` rows — a plain global read, no entity indirection — are deliberately left unoffset: those are whole-world facts (a shared "race over" flag, a shared "someone just lapped" flash), correctly identical on both screens, not "about" either player specifically. The convention this leans on: a cart wanting a personalized camera or HUD line declares that player's own state as two *adjacent* globals, slot 0's at the header field's own index, slot 1's at the next one — Race Car's `g_car_player`/`g_car_player2` (globals 0/1) are exactly that pair, and `camera.followGlobal` and every `Lap`/`Finished #` HUD row keep pointing at index 0 (player 1's) unchanged; the offset does the rest at render time.

`multiplayer.js`'s `beginSyncedMatch()` sets `world.localPlayerSlot = session.playerSlot` right alongside the existing `multiplayerActive = true` (§81); `stopSync()` resets it to 0 alongside clearing `multiplayerActive`. Same lifecycle, same reasoning: presentation state tied to "is a match currently running," not something that needs its own separate on/off path.

**Why this is safe to leave un-synchronized between peers despite everything else in Multiplayer being built around strict determinism.** Rollback/resimulation (§78) only ever snapshots and replays *simulated* state — entities, globals, RNG, tick count — because that's the state both peers' worlds must agree on bit-for-bit. `localPlayerSlot` never touches any of that: it's read only by `updateCamera`/`renderHUD`, both called from `render()`, never from `step()`. Two peers can (and are meant to) hold different values for it locally while their underlying `World.step()` calls stay in lockstep — exactly the same category of local-only state `cameraX`/`cameraY` themselves already were before this round.

Docs: `cart-object.md`'s `hudSpec` and `camera` sections both gained a note describing the offset directly (CLAUDE.md's upsert rule — this is a real behavior change to what those fields do during a match, even though neither field's own shape or the binary format moved).

Verified via `test/smoke.js` against real content (Race Car, §83) rather than a synthetic cart: setting `world.localPlayerSlot` to 0 vs 1 and forcing a render between each shows the camera centering on a different entity's position and the HUD's "Lap" line showing a different car's own lap count, both purely from flipping that one field — no other state touched.

## 83. Race Car becomes a real 2-player game — the first cart to actually use `maxPlayers: 2`

Every prior Multiplayer round (§76-§82) built infrastructure; none of it had shipped in an actual cart yet. Race Car was the natural first target — already had two AI opponents and a full lap/checkpoint/race-over model, needed "only" a second human-controlled car layered in, not a new genre.

**What changed, mechanically.** `cart.maxPlayers: 2` (the "Multiplayer" button now appears on Race Car itself, no test-side patching needed). A second player-car global, `g_car_player2`, spawns immediately after `g_car_player` in `on_init` — deliberately the very *next* global index (§82's adjacent-globals convention), not appended wherever convenient; the two AI cars' own globals shifted down by one to make room. `on_input` gained a second, near-identical block driving `g_car_player2` from `LOAD_INPUT 1` instead of `LOAD_INPUT 0` — not factored into a shared subroutine, since this VM has no `CALL`/`RET`, only `JMP`, and a hand-rolled dispatch-by-handle would cost more than the duplication it'd save at this size. `on_tick`'s player-vs-AI identity check (`JNZ skip_ai`) now matches *either* car (`CMPEQ` twice, `OR`'d together) instead of just `g_car_player`; `on_frame`'s race-over check now requires all four cars finished, not three; the lap-complete flash fires for either human's crossing and strobes both cars' sprites, since `g_lap_flash` is a single shared global (§82's `sourceKind: 0` case) with no per-crosser record to strobe selectively.

**What *didn't* need to change, and why that's the interesting part.** `camera.followGlobal` and every `hudSpec` row still point at `g_car_player` (index 0) — untouched, because §82's engine-level offset already does the right thing: each peer's own camera centers on their own car, each peer's own "Lap"/"Finished #" HUD line shows their own progress, purely from `g_car_player2` sitting at the very next global index. Building §82 as a generic engine feature first, rather than a one-off hack inside Race Car's own bytecode, is what made the content round this small.

**Solo play is unaffected by design, not by luck.** `maxPlayers: 2` doesn't require a second player to be present — it's a capability flag, checked against `LOAD_INPUT`'s existing per-slot behavior (§77): slot 1 simply reads all-zero when nobody's connected, so `g_car_player2` spawns and just sits idle at the line in ordinary solo play, functionally a fourth stationary car. Both human cars spawn as the same car-color entity type (not a third color) — color still tells "human" from "AI" apart at a glance, and telling the two human cars apart doesn't need a third color when each peer's camera is always centered on their own.

Docs: none beyond §82's own upsert (camera/hudSpec's documented behavior already covers what Race Car now relies on) — no opcode, cart-field, hook, or format change originates in this round; it's `race-car.js` content plus the mechanical global-index bookkeeping that follows from it. Two smoke.js tests that read specific global indices (the lap-flash strobe test, the AI-chicane-progress test) needed updating to the new indices — a reminder that a shipped cart's own global layout is real, testable surface area, not just internal bookkeeping.

Verified via `test/smoke.js`, against the real shipped cart: both input slots independently drive their own car from the real spawn position; the Multiplayer button and `cart.maxPlayers` reflect the real header field; §82's camera/HUD offset holds up against this cart's actual (not synthetic) adjacent-globals layout. Not yet verified: an actual two-human race end-to-end over a real connection — the same live-peer gap §79-§81 have each already flagged, unchanged by this round.

## 84. Join links — "Copy Link" bundles the game and the room code into one URL

Requested directly: hosting a match still required a second, out-of-band channel to actually get the room code to a friend (read it aloud, type it into a text message) even though the game link itself is the one thing already easy to send. The fix folds both into a single URL, so sending the game *is* the invite.

**The link shape, and why it's just string concatenation, not a new transport.** A join link is an ordinary game fragment with `&mp=<code>` appended to the hash — `location.origin + location.pathname + location.search + '#' + fragment + '&mp=' + roomCode`. This is safe precisely because of what a fragment's own alphabet can't contain: `encodeCartUrl` (kernel.js) URI-encodes name/author and the payload itself is base64url (`kernel.js`'s own alphabet, no `&`/`=`), so `&mp=` can never be ambiguous with anything the fragment legitimately produced. `parseJoinLinkHash` is the exact inverse — one regex, split into `{gameHash, code}` — kept as its own small, pure, exported function specifically so it's unit-testable without a room or network anywhere near it, and so `main.js`'s `boot()` doesn't duplicate the regex.

**Where the code goes once boot() has it.** `boot()` parses `gameHash`/`code` before anything else, loads `gameHash` exactly like any other link (an unrecognized or malformed `code` doesn't stop the game from loading — only after a successful `Runtime.startGame()` does a present `code` do anything), then calls a new `Multiplayer.openLobbyAndJoin(cart, code)`. This is `openLobby`'s auto-join sibling: it skips the Host/Join choice screen entirely and calls the same `startSession('join', code)` a person typing that code into the join form would have triggered — same state machine, same UI, the only difference is nobody had to type anything.

**Copy Link itself.** A new button next to Cancel in the hosting view's `waiting-for-peer` state (the same screen that already shows the room code) — `navigator.clipboard.writeText`, with a `document.execCommand('copy')` fallback via a throwaway offscreen `<textarea>` for the rare case the modern API is missing or itself rejects. Button text flips to "Copied!" for 1.5s as the only feedback; guarded with `btn.isConnected` before touching it back, since the write is async and the lobby can re-render or close entirely while it's in flight.

**Why this needed no format or engine change at all.** Everything here is presentation/routing: the link's own shape lives entirely in how `location.hash` gets built and parsed, not in the cart binary, and `openLobbyAndJoin` is a thin wrapper around machinery §79 already built (`hostMatch`/`joinMatch`/`connectToRoom`, the whole state machine). No `opcodes.md`/`cart-object.md`/`binary-format.md` update needed — nothing there moved.

Verified via `test/smoke.js`: `parseJoinLinkHash` against a handful of hash shapes (with/without a code, code casing left alone since normalization is `joinMatch`'s job not the parser's); clicking Copy Link while hosting (spying on `navigator.clipboard.writeText` rather than reading the real clipboard back — real clipboard access needs OS-level permissions headless Chromium doesn't reliably grant, and the spy tests exactly what this feature promises) confirms the copied string contains both the current fragment and the session's own room code, and that the button shows "Copied!" afterward; `openLobbyAndJoin` with a mock `joinRoomFn` confirms it goes straight to a joining state with the exact room code given, never rendering the Host/Join choice screen at all. Also manually verified against the real (unmocked) `navigator.clipboard` API and a real screenshot of both the hosting view and the post-click "Copied!" state. Not exercised end-to-end with a real second browser actually opening a captured link and landing in a live match — the same live-peer gap every Multiplayer round since §79 has flagged, unchanged here.

## 85. A real bug from real usage: bare commas in a join link split apart in iMessage

The first genuinely external signal on this whole Multiplayer arc — manual two-device testing (finally possible once §84 actually deployed) surfaced two reports. The first, "no outbound network request happens," turned out not to be a bug at all: driving the real (unmocked) `hostMatch`/`joinMatch` paths in a live browser and watching for `WebSocket` construction confirms both fire real connection attempts to the public tracker relays immediately, exactly as designed — what was being observed was almost certainly a stale pre-deploy page (the deploy for §84 took several hours to actually go out, chased down separately) rather than anything in this codebase. Worth recording as a real verification technique though: `page.on('websocket', ...)` plus watching for the browser's own `WebSocket connection to '...' failed` console errors is a way to prove a join attempt really left the browser, without needing the connection to actually succeed — useful for any future debugging of this path from inside a sandbox that can't reach the public trackers either.

**The second report was real.** Pasting a copied join link into iOS iMessage split it into two separate tappable links, breaking right at the comma between the cart's author and its payload. `encodeCartUrl` (kernel.js) joins `encodeURIComponent(name) + ',' + encodeURIComponent(author) + ',' + payload` with two *literal, unescaped* commas — completely fine for this app's own routing (`location.hash` is never parsed as a spec URL, just read back as an opaque string) but exactly the kind of character a link-detection heuristic that isn't purely RFC-following treats as ordinary sentence punctuation, not something that could legitimately sit inside a URL.

**The fix: wrap the whole fragment in one more `encodeURIComponent` before it goes in the link, once.** `buildJoinLink` now builds `'#' + encodeURIComponent(fragment) + '&mp=' + roomCode` instead of concatenating the raw fragment; `parseJoinLinkHash` mirrors it with a single `decodeURIComponent` on the `&mp=`-stripped portion. This isn't selective comma-escaping (which would need to somehow tell "the two structural separator commas" apart from a comma that's part of a cart's own name and already sitting inside an `encodeURIComponent`'d segment as `%2C` — genuinely ambiguous after the fact, since both look identical once escaped). Encoding the *entire* fragment sidesteps that ambiguity completely: `encodeURIComponent`/`decodeURIComponent` round-trip losslessly regardless of what's inside, so there's nothing to disambiguate on the way back out, and the copied link ends up as one unbroken run of letters/digits/`%`/`-`/`_`/`.`/`~` — no raw punctuation of any kind for a detector to trip on. `&mp=` itself stays unescaped on purpose: `&` is the standard query-param separator, about as unambiguous a URL character as exists, and no link detector treats it as a sentence break.

Confirmed directly: the same Race Car link that used to read `#Race%20Car,Urlcade,z.p...&mp=CODE` (two literal commas) now reads `#Race%2520Car%2CUrlcade%2Cz.p...&mp=CODE` — zero literal commas anywhere — and a full round-trip (build the link, navigate to it fresh, as opening a shared link would) lands on the correct cart with the lobby already showing "Joining a match… Connecting to `<code>`," exactly as before, just without the punctuation a link detector could misread.

Docs: none — this is a bug fix to a link-building implementation detail, not a change to any documented field, opcode, or format.

Verified via `test/smoke.js`: `parseJoinLinkHash` now asserts the decoded `gameHash` comes back byte-identical to the original (comma-containing) fragment; the Copy Link test switched from a synthetic bare-payload cart (which never had a comma to begin with, and so couldn't have caught this) to the real Race Car cart specifically, and gained a dedicated regression check that the copied link contains no literal comma at all. Also manually verified end-to-end outside the suite: building a real join link and navigating to it fresh loads the correct cart and lands on the right "Joining a match" state.

## 86. §85's comma fix was real but incomplete — the actual culprit was `%`, not commas specifically

§85's `encodeURIComponent`-wrapped link still split apart in iMessage on retest. The retest itself was the useful part: **a link for a different cart, Doom-like's "Corridor" (no space in its name, so no `%20` to escape), linked fine throughout — at nearly double the character length of Race Car's.** That single comparison ruled out two of the three plausible explanations at once: length isn't it (Corridor's link is longer and still fine), and it isn't specifically the two structural commas either (§85's fix already removed every literal comma, and the split persisted). The one real difference between the two carts' links: Race Car's name is "Race Car," Corridor's is "Corridor" — the only reason Race Car's link had a `%` in it at all was the space. And §85's own fix made that worse before making it better: running `encodeURIComponent` a second time over an already-`%`-escaped string doesn't remove `%` signs, it multiplies them (`%20` becomes `%2520` — one `%` becomes three, once the two comma-escapes are counted too).

**The actual fix: stop percent-encoding the link's fragment portion at all.** `buildJoinLink` now base64url-encodes the whole fragment (via kernel.js's own `b64urlEncode`/`b64urlDecode` — the exact function the cart payload itself already uses, one "safe to put in a link" encoding scheme for this codebase, not two) instead of running it through `encodeURIComponent`. `parseJoinLinkHash` mirrors it with `b64urlDecode`. The fragment is guaranteed pure ASCII by construction (`encodeCartUrl` already URI-encodes name/author; the payload is base64url), so treating each character as one byte for the encode/decode round-trip is lossless — no UTF-8 machinery needed. The result: the entire hash portion of a join link (everything up to `&mp=`) is now nothing but the base64url alphabet — letters, digits, `-`, `_` — the identical character class the payload segment has always used on its own, which is exactly the part of every link (multiplayer or not) that's never had a reported splitting issue in the first place. Costs about 33% more characters than the percent-encoded attempt, but §85's own retest already showed length isn't what iMessage's detector reacts to here — character class is.

Docs: none, same reasoning as §85 — link-building implementation detail, nothing documented moved.

Verified via `test/smoke.js`: `parseJoinLinkHash`'s round-trip test switched to asserting against the base64url-wrapped form and gained a regex check that the wrapped `gameHash` itself is pure `[A-Za-z0-9_-]`; the Copy Link test's regression check now asserts the *entire* copied hash portion (not just "no comma") matches that same alphabet — a strictly stronger guarantee than §85's, and one that would have caught this round's bug too. Not independently re-verified against real iMessage (no access to that from this environment, same limitation as ever) — the fix is confirmed correct by construction (base64url's alphabet has no member iMessage's detector, or any other, has ever been reported to choke on) and by the smoke suite's stronger character-class assertion, not by a third round of manual retesting from here.

## 87. §86's base64url fix was also incomplete — real external research finally explains why, and the actual fix keeps the cart's name readable too

§86's base64url-wrapped link *also* still split apart in iMessage on retest, and the retest carried a second, independent complaint: the copied link no longer showed the cart's name at all, a real usability loss on top of the bug not actually being fixed. Both §85 and §86 had been diagnosed purely from local, first-party evidence (character-class diffs between two carts' links) — this round instead started from the maintainer's explicit instruction to look outside the codebase for what iMessage's link detector actually does.

**What web research turned up**: Patrick Weaver's "Unravelling an iMessage URL Parsing Mystery" (patrickweaver.net/blog/imessage-mystery/) documents, from his own direct measurement, that iMessage (and Signal) split a single *unbroken run* of base64-alphabet characters into two separate tappable links once it exceeds roughly 300 characters — 300 held, 303 didn't, in his testing — regardless of punctuation. His workaround: insert a `-` periodically, since `-` isn't part of *standard* base64's alphabet, so the detector can treat each side as its own reviewable section instead of one long ambiguous run.

That single fact reframes everything §85 and §86 individually found. §85's comma bug and this run-length bug are two genuinely different, independently-triggerable causes — the original report's split landed exactly on a structural comma (bug 1), but nothing about bug 1 rules out bug 2 also being present. And §86's base64url "fix" didn't just fail to address bug 2, it made it *actively worse*: measuring the actual PR #71 link locally (`gap-check.mjs`, scratchpad) found a **1477-character run with literally zero `-`/`_` characters in it** — nowhere near Weaver's ~300 threshold, on the safe side. The mechanism: base64-encoding genuinely random *bytes* produces `+`/`/` (→ `-`/`_` in base64url) roughly 1-in-32 characters by construction, but §86 wasn't encoding random bytes — it was encoding the fragment's own mostly-narrow-range printable-ASCII *text* (itself already URI-escaped name/author plus a payload whose own base64url alphabet got re-encoded a second time), which systematically under-produces those exact symbols. Wrapping already-text-like data in base64 a second time is close to the worst possible way to guarantee a long dash-free run — worse than the comma-bug link it replaced.

**The actual fix treats the two bugs as the two separate things they are**, instead of running the whole fragment through one more transform to route around both at once (which is what cost §85 and §86 their readability in the first place): escape only the two real structural commas (`fragment.replace(/,/g, '%2C')` — safe unconditionally, since a comma inside an already-`encodeURIComponent`'d name/author can only ever appear pre-escaped as `%2C`, never as a literal `,`), then insert a `-` every 200 characters through the whole result (`IMESSAGE_LINK_BREAK_INTERVAL`, comfortably under Weaver's measured 300-303 danger zone) via new `insertLinkBreaks`/`removeLinkBreaks` helpers. Those helpers are deliberately *position-based*, not content-based: they never need to tell "a `-` this function inserted" apart from "a `-` that was already there in the payload's own base64url" — both look identical once present — so `removeLinkBreaks` just always deletes whatever character sits at each known interval boundary, which reconstructs the exact original losslessly by construction regardless of what that character happens to be. `buildJoinLink`/`parseJoinLinkHash` are the mirror pair, same shape as every previous round: `insertLinkBreaks(fragment.replace(/,/g,'%2C'))` going out, `removeLinkBreaks(...).replace(/%2C/g,',')` coming back.

The result restores what §85 and §86 both gave up: a link like `#Race%20Car%2CUrlcade%2Cz.p...-...-...&mp=CODE` — the cart's name is visible again exactly as it was before any of these three rounds started, only the two structural commas are escaped, and periodic `-`s (not visible as anything unusual to a human glancing at the link) keep every run safely under the length that trips iMessage/Signal's detector.

Docs: none, same reasoning as §85/§86 — link-building implementation detail, nothing documented (cart format, opcodes, hooks) moved.

Verified via `test/smoke.js`: `parseJoinLinkHash`'s round-trip test now uses a fragment padded past 200 characters specifically to exercise the interval-break insertion/removal, not just the comma escape, and asserts a byte-exact round-trip back to the original (commas, %-escapes, and all). The Copy Link regression test now checks three things directly responsive to this round's history: no bare comma survives in the copied link, the cart's own name is still visible in it (`encodeURIComponent('Race Car')` appears literally — the readability regression both prior rounds introduced), and no run of 200+ characters in it goes without a `-`/`_` break. Not independently re-verified against real iMessage from this environment (same limitation as every prior round) — confidence here comes from Weaver's own directly-measured threshold (200 leaves nearly 100 characters of margin under his observed 300-303 break point) plus the local measurement (`gap-check.mjs`/`gap-check2.mjs`/`determinism-check.mjs`, scratchpad) that reproduced and explained exactly why §86's link had gone 1477 characters with no break at all.

## 88. A connection diagnostics log in the lobby modal — for a phone-only bug report with no computer or network-proxy app to debug it with

§85's original "no outbound network request happens" report (later concluded to be a stale pre-deploy page, not a real bug) came back after §85-§87's link-splitting fix landed: the maintainer's own two-device retest showed the copied link now works, but joining still stalls forever on the actual device. This time there was no easy stale-deploy explanation to reach for, and no way to hand the maintainer a debugging technique that assumes a second computer — they only had the phone itself. Every prior verification technique this Multiplayer arc has used (Playwright's `page.on('websocket', ...)`, a Mac's Safari Web Inspector over USB, Proxyman/Charles's on-device traffic capture) either can't run from inside this sandbox, or needs hardware/software the maintainer doesn't have sitting in front of them.

**The fix: put the debugging surface directly in the page**, so no external tool is needed at all. The lobby modal (`#mpOverlay`) already has a state machine (`waiting-for-peer` / `connected` / `peer-left` / `error`) but that state machine can't tell "the network is silently blocked" apart from "still working on it" — both look like a static "Waiting for your friend to join…" message forever. Two layers sit underneath that state and were previously invisible entirely:

1. **Relay signaling** — `vendor/trystero/torrent.mjs`'s `getRelaySockets()` (added to its exports for this round) returns the raw `WebSocket` objects for every one of the five default tracker relays, module-level and shared across every `joinRoom()` call regardless of which room. Polling each one's `readyState` (`CONNECTING`/`OPEN`/`CLOSING`/`CLOSED`) every 800ms and logging only the transitions answers the exact question §85's investigation had to answer by hand with Playwright: did any relay socket ever actually open?
2. **Peer WebRTC** — once a peer is found through those relays, `room.getPeers()` returns each peer's raw `RTCPeerConnection`. Polling `.connectionState`/`.iceConnectionState` the same way surfaces whether a found peer's connection is actually progressing through ICE negotiation or stuck/failed there — a distinct, later failure mode signaling-relay logging alone can't see.

Both are polled rather than event-hooked: relay sockets are recreated wholesale on every reconnect (`vendor/trystero/utils.mjs`'s `makeSocket` does `new WebSocket(url)` again on close, replacing `client.socket`), so there's no single long-lived object to attach a one-time listener to — diffing against the last-seen state per URL/peer sidesteps needing to notice "a new socket replaced the old one" at all.

The whole thing renders into a small always-present `#mpDiag` panel — a timestamped, scrolling log (`[+2.3s] relay tracker.webtorrent.dev: OPEN`, `[+2.4s] session state: connected`) plus a **Copy** button, so the maintainer can read it straight off the phone screen or copy the whole thing and paste it back for help, without installing anything. It's a sibling of `#mpBody` inside `.mp-card`, not a child of it — `renderLobby()`'s `body.innerHTML = ...` swap (body = `#mpBody`) would otherwise wipe it out on every single state-machine re-render, which happens constantly (every relay/peer state change re-renders the log itself). `display:none` by default, shown only once a session actually starts attempting a connection (empty on the very first Host/Join choice screen), and cleared on `closeLobby()` — though that clear has to happen *after* `activeSession.leave()`, not before: `leave()` itself triggers one more `'left'` state transition that would otherwise repopulate the just-cleared log.

Docs: none — an in-app debugging aid, not a change to any documented field, opcode, or format.

Verified via `test/smoke.js`, using the same mock-`joinRoomFn` pattern as every other lobby test (mock rooms only ever implement `onPeerJoin`/`onPeerLeave`/`leave` — no `getPeers`, so the peer-state polling has to treat that as optional, not assumed present, which is exactly the kind of thing this round would have silently thrown on without a smoke test catching it first): the log is hidden on the initial choice screen; hosting reveals it and records the room code and `waiting-for-peer`; a peer joining records `connected`; the Copy button copies the log's exact text; closing the lobby hides and clears it; and a synchronously-throwing `joinRoomFn` (§ existing error-state test's own scenario) still reaches the log even though it lands on `'error'` before `onStateChange` has a listener attached to relay it normally — `startSession` logs the session's starting state directly for exactly this reason. Not verified against a real stalled connection from this environment (the sandbox can't reach the public trackers either, same limitation as ever) — next real-device retest is what this round exists to make legible.

## 89. §88's diagnostics found relays reaching OPEN and then nothing — closing the one real gap left, tracker-level failures that only ever reached `console.warn`

First real-device use of §88's connection log: both a hosting and a joining device showed all three signaling relays reaching `OPEN` within under a second, and then — nothing. No peer found, no state change, ever, on either side. That's a genuinely useful result even though it doesn't yet pin the root cause: it rules out a network-level block outright (both devices' WSS traffic to the trackers works fine), which narrows the problem to the rendezvous step itself — the two sides never finding each other's announce even though both are demonstrably talking to the same relay infrastructure.

Re-reading `vendor/trystero/torrent.mjs`'s own tracker layer while investigating turned up a real, previously-invisible gap: its `warn()` helper already detects and reports exactly this class of failure — a relay responding to an announce with a `"failure reason"` or `"warning message"` — but only ever routes it to `console.warn`. That's silently discarded on a phone with no devtools attached, which is exactly the scenario §88 exists for. If the trackers are rejecting or malforming this app's announces for any reason, §88's diagnostics as shipped couldn't have shown it.

**The fix**: capture `console.warn` calls while a diagnostic session is active, filtered to this library's own `${libName}: ...` prefix (so an unrelated page warning doesn't get misattributed as a multiplayer problem), and push matches into the same diag log every other line goes through. Calls through to the real `console.warn` too — additive, not a replacement, so anyone with devtools open still sees it there as well. Installed in `startDiag()`, uninstalled in `stopDiag()` — a permanent monkey-patch left behind after the lobby closes would be a real problem for every other unrelated warning on the page, not just this one.

Docs: none — an in-app debugging aid, not a change to any documented field, opcode, or format.

Verified via `test/smoke.js`: a Trystero-prefixed `console.warn` call reaches the log while a session is active; an unrelated warning (no `Trystero` prefix) does not, confirming the filter isn't just capturing everything; and `console.warn` is restored to the native function after `closeLobby()`, confirming no permanent patch is left behind to interfere with later test output or later real usage. Whether this actually explains the real stall is still open — next real-device retest is what tells us that, same as §88 itself.

## 90. The appId itself, logged directly — the one comparison a phone-only bug report couldn't make until now

Following up on §89's own real-device result: the maintainer separately captured raw WebSocket tracker frames on the host device (via an on-device network inspector — a genuinely new debugging capability for this thread) and found two different `info_hash` values in the stream. Turned out to be a non-finding: those were two separate "Host a match" attempts, each generating its own random room code, and a different room code always produces a different topic/hash by design — expected, not a bug. But it pointed at the one comparison that actually would be diagnostic and that nothing so far could make: do a host and a joiner, for the *same* attempt, ever compute the *same* room topic?

`appId` (`urlcade-mp-<hash>`, from this file's own `appIdForCart`, namespacing a room to the cart's exact encoded bytes — DESIGN.md §79's own reasoning) is exactly that topic's other half, alongside the room code. It was computable but never actually *shown* anywhere — confirming a match required either trusting the code or, as just demonstrated, pulling raw sha1'd `info_hash` values out of a WebSocket frame inspector and eyeballing them against each other, on a phone, mid-investigation.

**The fix**: log it. `startDiag()`'s opening line now reads `hosting room ABCDE — selfId a1b2c3 — appId urlcade-mp-0929e711` (or `joining`), computed the exact same way `connectToRoom` itself derives the room's real `appId` for `joinRoomFn`, using the already-set `lobbyCart` at the moment diagnostics start. Comparing two devices' diag logs for a single attempt now directly answers "do these two agree on the room" without any external tool — continuing this round's whole premise (§88) of putting the debugging surface where the person having the problem actually is.

`appIdForCart` was already exported from `multiplayer.js` (used internally by `connectToRoom`) but not wired into `window.__urlcadeDebug` — added there too, both because the diag panel's own smoke test needed an independent way to compute the expected value to assert against, and because it's a small, genuinely useful addition to the debug surface on its own.

Docs: none — an in-app debugging aid, not a change to any documented field, opcode, or format.

Verified via `test/smoke.js`: the connection log's opening line now includes the exact string `D.appIdForCart(cart)` independently computes for the same cart, alongside the room code and `waiting-for-peer` already covered by §88's tests. Whether a real host/join pair's `appId` values actually match is still the open question this was built to answer — next real-device retest, this time capturing both devices' logs for one single attempt, is what settles it.

## 91. Same-network retest, still stuck — widened tracker redundancy from 3 to all 5 default relays

§90's `appId` check came back matching on both devices for a single attempt — ruling out a topic mismatch definitively. A same-network retest (both devices on one Wi-Fi, to isolate NAT/TURN as the cause) showed the identical symptom anyway: relays reach `OPEN`, `appId` matches, and still no peer ever found. Same-network working would have pointed squarely at NAT traversal (no TURN server configured, a real and expected limitation of this vendored library — see its own README's "Why torrent" section); same-network *also* failing rules that out as the sole explanation, since two devices on one LAN don't need to traverse any NAT to reach each other directly.

With signaling (relay connectivity, topic match) and NAT both now ruled out, the remaining plausible layer is the tracker infrastructure itself. Web research (`vendor/trystero/torrent.mjs` upstream's own project) surfaced a real, relevant distinction: Trystero's maintainers now default new users to their Nostr strategy specifically because the BitTorrent/MQTT/IPFS strategies have "far less relay redundancy" — public BitTorrent trackers are built and optimized for real file-sharing swarms, not the repurposed real-time WebRTC offer/answer brokering Trystero asks of them, and a given tracker can be too flaky for that specific job even while still accepting connections and acking announces normally (exactly what this app's own diagnostics have shown on every attempt so far: `OPEN` sockets, generic acks flowing, no actual peer ever surfaces).

**The fix, as a first low-risk experiment before considering a bigger strategy migration**: `connectToRoom` now passes `{relayConfig: {redundancy: 5}}` to `joinRoomFn`, widening from Trystero's own default (3 of its 5 hardcoded public trackers) to all 5. Doesn't touch which trackers are used, doesn't add any dependency, doesn't change the vendored library at all — purely widens the odds that at least one pair of trackers between two devices happens to be mutually healthy enough to actually broker an offer/answer, at the cost of a few more open sockets per session.

If this doesn't resolve it, the next real lever is a genuine strategy question rather than a config tweak: migrate from the `torrent` strategy to Trystero's `nostr` strategy (their own now-recommended default, with meaningfully better relay redundancy) — a bigger change than this round, since it needs a new vendored package and a signing dependency (`@noble/secp256k1`) this codebase has avoided everywhere else on purpose (this file's own vendoring README specifically named that dependency as the reason torrent was picked over Nostr in the first place). That decision is deliberately not made in this round.

Docs: none — a config-only tweak to an already-documented library integration, no field/opcode/format change.

Verified via `test/smoke.js`: full suite still passes unchanged (mock `joinRoomFn`s in every test only ever inspect the room code argument, never the config object, so widening `relayConfig` couldn't have broken anything there by construction) — this round has no automated way to verify the actual real-world effect, same limitation as every round in this arc. Next real-device retest tells us whether this alone was enough, or whether the Nostr-migration question needs to be raised.

## 92. Widened redundancy retested, still stuck — this round instead wires up a diagnostic Trystero already had, `onJoinError`, that pins down exactly which side of the SDP exchange is failing

§91's widened-redundancy retest showed 4 of its 5 relays reaching `OPEN` cleanly — the redundancy bump is doing what it was meant to — and still no peer, no tracker-level warning, nothing. At this point the maintainer raised the real product constraint this whole line of inquiry needed: whatever the fix turns out to be, it can't ask a player to change a device setting (e.g. iCloud Private Relay, floated as one hypothesis) just to use Multiplayer. Fair, and it reframes what's worth chasing: if the eventual fix is a TURN relay (the standard, transparent-to-the-user answer to "STUN alone can't find a path," regardless of *why* STUN failed — Private Relay, CGNAT, a restrictive network, doesn't matter), then confirming *whether* that's actually the failure mode is worth doing before committing to standing up TURN infrastructure, which is a real new dependency this project hasn't had before.

Reading the vendored library directly (rather than continuing to guess from external symptoms) turned up exactly the tool needed: `joinRoom(config, roomId, callbacks)` accepts a third argument, and `callbacks.onJoinError` — already implemented inside `vendor/trystero/signal-handler.mjs`, never wired by this app — fires with a specific, pre-worded message: `"could not connect to peer X after exchanging SDP"`, precisely when two peers' *signaling* (the offer/answer SDP exchange, brokered through the tracker relays this whole arc has been diagnosing) succeeds but the actual WebRTC/ICE connection never completes. That is the exact distinction needed: confirms whether a real attempt is reaching the peer-to-peer layer at all (in which case TURN is the right, user-transparent fix) or failing even earlier, before signaling completes (in which case TURN wouldn't help and the tracker-infra angle from §89-91 would still be the live lead).

Also found, as a direct byproduct of reading the same file: Trystero already configures default STUN servers (Google's public ones plus Cloudflare's) that this project never had to set up, and has a first-class `turnConfig` option on `joinRoom`'s config object for exactly this scenario — meaning adding TURN later, if confirmed necessary, needs no fork of the vendored library, just a config addition once a TURN provider is chosen.

**This round**: `connectToRoom` now passes `{onJoinError: ({error, peerId}) => pushDiag(...)}` as `joinRoomFn`'s third argument, so that message reaches the same phone-readable diagnostics log every prior round in this arc has built on. No other behavior change.

Docs: none — a diagnostic wiring addition, not a fix, and not a change to any documented field/opcode/format.

Verified via `test/smoke.js`: the mock `joinRoomFn` now captures its third `callbacks` argument and the test invokes `onJoinError` directly (the same "call the callback directly rather than reproduce a real network failure" pattern `onPeerJoin` etc. already use throughout this file) with a message matching Trystero's actual wording, asserting it reaches the connection log. Whether a real device ever fires it — and thus whether TURN is actually the fix worth building — is what the next real-device retest settles.

## 93. The real bug, at last: `startMatchSync` called `onMessage` as a method that was actually a property — six rounds of network diagnostics were chasing a connection that, this whole time, was one line from crashing the moment it succeeded

Every round from DESIGN.md §85 through §92 diagnosed and improved the *signaling* path — comma-splitting links, run-length limits, tracker redundancy, `appId` verification, `onJoinError` wiring — all real, all worth doing, and none of them the actual reason Multiplayer never worked. The real bug only became visible once a real connection finally succeeded: the maintainer ran two tabs on a desktop browser (not phone-constrained, so an easy same-machine WebRTC path) and, for the first time in this entire arc, watched two peers actually reach `'connected'` — immediately followed by an uncaught `TypeError: inputAction.onMessage is not a function` at `multiplayer.js:334`, thrown from inside `startMatchSync` (DESIGN.md §80) the instant it tried to wire up gameplay sync.

`startMatchSync` called `inputAction.onMessage(handler)` — a function call — because that's the internal-only shape (`vendor/trystero/room.mjs`'s own `pingAction.onMessage((_, id) => ...)`, used for the room's own ping/pong/signal/leave/handshake control messages). But `inputAction` here came from `room.makeAction('input')`, the *public* API Trystero exposes to library users, and its `onMessage` is a getter/setter *property* (`vendor/trystero/actions.mjs`'s `makeActionImpl`: `get onMessage(){...}, set onMessage(handler){...}`), assigned to (`action.onMessage = handler`), never called. Two genuinely different shapes for two genuinely different purposes, easy to conflate — the README's own "Public API surface actually used" section even described it loosely as `{send, onMessage}` without spelling out which one is a method and which is an accessor. The fix was a one-character-class change: `inputAction.onMessage(data => {...})` → `inputAction.onMessage = data => {...}`.

**Why nothing caught this until a real connection succeeded**: this line only ever runs once two peers actually reach `'connected'` and `beginSyncedMatch` calls `startMatchSync` for real — every mock room in `test/smoke.js` stood in for the connection itself, and every one of those mocks' `makeAction()` stubs used the *same* callable-method shape the buggy code assumed (`onMessage(){}` as a plain method, or `onMessage(fn){...}` explicitly calling the handler). The mocks and the bug agreed with each other, so nothing ever disagreed loudly enough to fail a test — including the deep two-World gameplay-sync test (DESIGN.md §80's own `syncResult` check), which "worked" throughout its whole authored history purely because its mock's `onMessage` was a method too. No amount of network-layer diagnostics (this whole §85-§92 arc) could have caught this either — the bug lives entirely on the other side of "the connection succeeds," a state none of those diagnostics were designed to see past by construction (they measure whether relays/peers/SDP get that far, not what happens the instant they do).

Fixed both sides: `multiplayer.js`'s real call site, and all four mock `makeAction()` stubs across `test/smoke.js` (three simple placeholder stubs, plus the elaborate linked-World-pair mock) — rewritten as real getter/setter pairs matching Trystero's actual shape, so a future regression back to call-style would fail loudly again instead of silently agreeing with itself.

Docs: none — an internal bug fix against an already-vendored, already-documented library integration; no field/opcode/format changed.

Verified via `test/smoke.js`: full suite, 3 clean runs, including the two-World convergence tests (still passing, now against a mock that actually matches reality) and every multiplayer state-machine test touching `makeAction`. Not yet confirmed against the maintainer's own original real-device report — that stall may have had this exact crash as part of its story too (a connection that got this far would have silently died right here, indistinguishable from "never connected" to a player with no devtools open) or may still have a separate root cause; the next real-device retest is what tells us whether fixing this alone was enough.

## 94. A second real bug, found immediately after the first: local input capture always wrote to slot 0, so a slot-1 peer's own keypresses never landed anywhere the match sync could see them

With §93's `onMessage` crash fixed, the maintainer's next real-device test (two desktop tabs) got further than ever — a live, running two-player match — and found only one of the two cars would move. Exactly the shape of bug §93 predicted: something else was still one connection-success away from ever being exercised.

`runtime.js`'s `loop()` writes this device's own captured keyboard/pointer state into the World every frame — but unconditionally at index 0 (`world.inputs[0] = buttonMaskFromKeys() | ...`, and the same for `pointerXs[0]`/`pointerYs[0]`), regardless of `world.localPlayerSlot` (DESIGN.md §82's own local-player offset, already used correctly elsewhere for camera/HUD). For the host (slot 0) this is a no-op bug — their real input already lands exactly where it should. For the guest (slot 1), it's silent and total: their own real keypresses land in `inputs[0]`, while `startMatchSync`'s `beforeTick` (DESIGN.md §80) reads `inputs[localSlot]` — `inputs[1]` for them — as "this peer's real input for the tick." That slot was never touched by real capture at all, so every tick the guest sent was just whatever `inputsForTick`'s own remote-merge logic had last left sitting there. The guest's own controls were never connected to anything.

**The fix**: index by `world.localPlayerSlot` instead of the hardcoded `0`, for both the button mask and the per-player pointer coordinates. `localPlayerSlot` defaults to `0`, so single-player and hosting are byte-for-byte unaffected — this only changes behavior for a peer actually occupying a non-zero slot.

Docs: none — an internal engine bug fix, not a change to any documented field/opcode/format (the `inputs[4]`/`pointerXs[4]`/`pointerYs[4]` per-player model itself, DESIGN.md §77, was already correctly documented; only its *capture* side had the bug).

Verified via `test/smoke.js`: a new check drives this through the real capture path (`page.keyboard.down`, not a test directly assigning `world.inputs` the way the existing two-player-drive checks do) with `world.localPlayerSlot` set to 1, asserting the real keypress lands at `inputs[1]` and *not* `inputs[0]` — the exact regression, reproduced and now guarded against. Full suite otherwise unaffected (default `localPlayerSlot` keeps every prior single-player and host-perspective check passing unchanged).

## 95. Confirmed: signaling succeeds, WebRTC/ICE itself fails — a TURN server via `turnConfig`, no player action required

With §93 and §94's real bugs fixed, real cross-device testing resumed on the actual open question from §85-92: why do two independent devices' relay connections reach `OPEN`, with matching `appId`s, and still never find each other? §92's `onJoinError` wiring finally answered it directly: a real attempt logged `join error: could not connect to peer DSOsAvyw0yNfH84lxOSK after exchanging SDP; configure TURN servers with turnConfig or rtcConfig.iceServers`. Confirmed, not guessed: the two peers' *signaling* — the tracker-brokered offer/answer exchange this whole arc has been diagnosing — genuinely succeeds. Only the actual peer-to-peer WebRTC/ICE connection fails afterward, the standard signature of a NAT (cellular CGNAT, a restrictive network, possibly iCloud Private Relay, never definitively pinned to one specific cause and no longer needing to be) that STUN alone can't punch through.

That's exactly the case a TURN relay exists to fix, and exactly why so much of this arc's earlier effort (tracker redundancy, `appId` verification, the diagnostics panel itself) was worth doing anyway: it systematically ruled out every *other* explanation (topic mismatch, tracker infra flakiness, this app's own code) before landing on the one a config change actually fixes, with the maintainer's own hard constraint in mind — no player should ever need to change a device setting to use Multiplayer.

**The fix**: `connectToRoom` now passes `turnConfig` (a new module-level `TURN_CONFIG` constant) to `joinRoomFn` — Trystero's own first-class extension point for exactly this (`vendor/trystero/peer.mjs`: `iceServers: defaultIceServers.concat(turnConfig ?? [])`), no vendored-library changes needed. Uses Open Relay Project's (openrelayproject.org, served from metered.ca) publicly-documented static TURN credentials specifically because they're meant for open embedding — no account for this project, no account or setting for a player, the same constraint every fix in this arc has had to respect. Accepted tradeoff, deliberate for now: it's free, shared public infrastructure — not capacity reserved for this app — so its reliability under load is outside this project's control. If that becomes the actual bottleneck later, only the credentials filling `TURN_CONFIG` would need to change, not the wiring itself.

Docs: none — a config addition to an already-vendored, already-documented library integration; no field/opcode/format changed.

Verified via `test/smoke.js`: a new regression check asserts `connectToRoom` actually hands `joinRoomFn` a `turnConfig` array with at least one `turn:`-prefixed URL and real username/credential fields, so this can't silently rot back to STUN-only. Not yet re-verified against the exact real-device scenario that produced the original `onJoinError` — that retest is what finally closes this whole arc out, one way or the other.

## 96. Multiplayer Party — first stage: a player-count badge on the shelf

With Multiplayer actually working cross-device (§79-95), the next question is the *experience* around it: joining a match today means "join once, play one round of one game, done" — every game switch re-negotiates a whole new WebRTC connection. The plan going forward is a persistent party — one long-lived room, a shared queue either player can add to, and a post-round Ready/Skip vote that cascades from "restart" through the queue — built as a sequence of independently-shippable stages, the same way every other multiplayer round shipped. This is the first: a small, fully independent piece with no `multiplayer.js` involvement at all.

`cart.maxPlayers` has been encoded/decoded since §148 but was only ever read in one place (`updateMultiplayerButton`, gating the topbar button) — nowhere on the shelf itself said which games support a friend. `renderMenu()` (runtime.js) already fully decodes every cart to build its card (thumbnail, name, author), so `cart.maxPlayers` was already sitting right there, unread. Added a small "👥 N players" badge, shown only when `maxPlayers >= 2` — omitted entirely (not "👥 1 players") for the overwhelming majority of single-player carts, so the badge stays a signal instead of shelf noise.

Docs: none — `maxPlayers` itself was already documented (`cart-object.md`); this is a display-only addition, no field/format change.

Verified via `test/smoke.js`: extended the existing shelf-rendering DOM check to also capture each card's badge text, asserting exactly one of the 9 shipped carts (Race Car, the only `maxPlayers:2` cart today) shows a "2 players" badge and no other card shows one. 3 clean full-suite runs.

## 97. Multiplayer Party — second stage: player identity, and a fixed avatar set that needed no cart at all

The Party plan (§96) needs a name/avatar for each player, saved once and reused across every game in a party, not scoped to any single cart — so it can't reuse `STORE_PERSIST`'s per-cart-hash `persistKey` scheme. It follows the *other* existing localStorage precedent instead: the audio toggle's `AUDIO_ENABLED_KEY` (a single fixed key, a module-level var seeded synchronously in a try/catch, plain getter/setter, exported through `window.__urlcadeDebug`). `getIdentity`/`setIdentity` (runtime.js) are that same shape, one level up: `{name, avatarId}` instead of a boolean. `avatarId` is stored as a bare integer with no bounds-checking in `runtime.js` deliberately — that module has no reason to know how many avatars exist; an out-of-range or stale id (e.g. after the avatar set changes shape someday) is the renderer's problem to wrap safely, not the storage layer's to reject.

The avatars themselves are a new small module, `avatars.js` — eight hand-authored `kind:1` shape lists, the exact same `{type:SHAPE_ELLIPSE|SHAPE_RECT, ..., color}` primitives the sprite editor already authors (same shape as STARTER_TEMPLATE's own ball sprite). The interesting decision was *how* to rasterize them: `World.buildBitmap` (the sprite editor's own rendering path) needs a real `World` instance purely to resolve a shape's `color` index through `this.paletteRGB`, itself derived from a cart's `paletteParams` via `generatePalette`. An avatar isn't part of any cart, so standing up a throwaway `World` (and the GL-texture disposal dance `buildCardThumbnail` already has to do for the same reason) just to reuse a trivial index-to-RGB lookup would be pure overhead for no benefit. Instead, `avatars.js` calls `kernel.js`'s `renderShapeList` directly — already a pure function needing no `World` — and resolves the resulting index array against a small fixed hex-color table of its own. Same rasterization logic reused, zero World/cart machinery pulled in.

One real bug found immediately by the test suite, not by inspection: `build-site.sh` (the single source of truth for what actually ships, shared by `pages.yml` and `test/smoke.js` alike, DESIGN.md §29) has an explicit file list, not a glob — adding `avatars.js` without adding it there meant `main.js`'s new `import * as Avatars from './avatars.js'` 404'd in the built site, which fails the *entire* module graph, not just the one import. Fixed by adding it alongside `multiplayer.js` in both the copy list and the cache-busting list.

Docs: none — internal data-layer/avatar-rendering addition, no cart-facing field/opcode/format.

Verified via `test/smoke.js`: identity round-trips through `localStorage` including across a real full page reload (not just an in-memory variable surviving); every one of the 8 fixed avatars rasterizes to a non-blank 8×8 canvas; an out-of-range `avatarId` (negative or past the end) renders safely instead of throwing. 3 clean full-suite runs — the `build-site.sh` gap above was caught by the very first run timing out at the initial page-load check, before ever reaching the new checks themselves, which is exactly the kind of failure this suite's "test the real built site, not an approximation" posture (DESIGN.md §29) exists to catch.

## 98. Multiplayer Party — third stage: the identity picker itself

§97 built the storage/rendering layer for player identity (`getIdentity`/`setIdentity`, the fixed avatar set); this stage builds the actual UI on top of it — a small chip in the shelf's own header (not tucked inside the multiplayer overlay), since setting your name is useful before a party even exists. The chip always shows *something*: the saved avatar + name once set, or a neutral "Set your name" placeholder before that — never blank, so there's always a visible, tappable thing rather than an empty corner of the page.

Clicking it opens a picker reusing `.mp-card`'s own visual shape (card-in-a-scrim, `mp-close`, `mp-primary` button) — a name input plus a grid of the 8 fixed avatars, mirroring the existing `.pal-swatch`/`.pal-swatch.selected` convention the palette editor already uses for "a grid of pickable, one-selected things." `Runtime.getIdentity()`/`setIdentity()` stay the single source of truth throughout: the picker re-reads fresh every time it opens rather than trusting whatever the chip happened to already be showing, and `selectedAvatarId` is purely this picker's own transient in-progress choice, discarded (not written anywhere) unless Save is actually pressed.

Docs: none — UI on top of an already-internal (non-cart-facing) preference.

Verified via `test/smoke.js`, driving the real chip/overlay/inputs (not just the storage functions §97 already covered): the chip shows the placeholder before anything's set; clicking it opens the overlay; typing a name, picking a non-default avatar, and clicking Save writes through to `Runtime.getIdentity()` (not just local UI state) and closes the overlay; the chip re-renders with the new name immediately, no reload needed. Also confirmed visually via Playwright screenshots of both the shelf (chip in the corner) and the open picker (all 8 avatars legible and distinct) — the sprite-editor/kernel rendering path §97 chose to reuse produces a real, readable result at picker size, not just a technically-non-blank canvas.

## 99. Multiplayer Party — fourth stage: one persistent room instead of one per match, a shared queue, and unilateral Play

§96-98 built the independent pieces (player-count badge, identity storage, identity picker); this stage is the actual rearchitecture the rest of the Party plan depends on. Today's room topic is `'urlcade-mp-' + hashCartBytes(encodeCart(cart))` — the *cart's own bytes* are the room address, which is why joining meant "play one round of one game, done": switching games meant leaving the room and renegotiating a whole new WebRTC connection (another TURN-relayed handshake, §95) from scratch. `PARTY_APP_ID` replaces it with one fixed constant — `connectToRoom`/`hostMatch`/`joinMatch`/`openLobby`/`openLobbyAndJoin` all drop `cart` as a parameter entirely, since the room address no longer depends on it.

That decouple removes a real guarantee, though, not just an inconvenience: a cart-derived topic was the *only* thing ensuring two peers who found each other were running byte-identical game logic, which the deterministic rollback-sync engine (§78) requires — any divergence desyncs silently, with no detection. The replacement has to be explicit, not implicit: whichever peer adds a game to the shared queue sends the literal compiled fragment string over the room (`session.addToQueue({fragment, name, author, maxPlayers})`), and `beginSyncedMatch` now takes that exact fragment as a parameter rather than calling `getCurrentFragment()` internally — both peers always start a match from the one fragment they explicitly agreed on, never from "whatever's currently loaded locally." This is a *stronger* guarantee than the old one: a version mismatch becomes a legible protocol issue (the queued item just doesn't match either peer's shelf) instead of two peers silently never finding each other.

Two new party-level Trystero actions, created once per room and reused for the room's whole lifetime (`room.makeAction` is memoized per action-type string, confirmed by reading `vendor/trystero/actions.mjs` directly rather than assumed): `'party-queue'` (`{items: [...]}`, full-replace broadcast on any local add/remove — not a CRDT, deliberately; fine for a human-paced, rarely-concurrent 2-peer queue) and `'party-start'` (`{fragment}`, sent when either peer clicks Play). Play itself is unilateral, no approval round-trip — `session.startMatch(fragment)` sends the message *and* calls its own local match-start listeners directly, since Trystero's `send()` never loops a message back to its own sender.

One correctness gap needed its own explicit fix: Trystero's `send()` only reaches peers already connected at send-time, it does not replay past sends to a peer who joins (or reconnects) later. Without a fix, a peer who joins after the other side's queue was already built up would simply never see it. `room.onPeerJoin` now re-broadcasts the current queue on every join, including a reconnect after `'peer-left'` — closing that gap rather than hoping an earlier `addToQueue` broadcast happened to still be in flight.

The lobby UI's `'connected'` state changed shape correspondingly: it used to be a defensive, essentially-never-seen "Connected! Starting the match…" message, since `beginSyncedMatch` fired automatically the instant `handleSessionStateChange` saw `'connected'`. That auto-start is gone — `'connected'` now renders the real party queue (each item with Play/remove buttons and "added by you"/"added by your friend"), plus an "Add a game" section listing every `maxPlayers >= 2` shelf cart (decoded from `CARTS` the same lazy, cached way `renderMenu()` already decodes every card, never from an in-memory authored object). This is a deliberate, immediately-observable UX change worth calling out on its own: joining a party now lands on a queue, not an auto-started match — even before later stages (Ready/Skip voting, persistent chrome) add the rest of what makes that useful.

Seeding: only the host auto-adds its own currently-loaded game to the queue, once, at `startSession('host', ...)` — never inside `hostMatch`/`connectToRoom` themselves, which stay pure connection primitives. The guest relies entirely on the peer-join re-broadcast above to receive it. Both sides seeding independently was considered and rejected: under the full-replace broadcast model, whichever side's broadcast happened to land last would silently overwrite the other's, and there's no reason to thread an extra `initialFragment` parameter through the join-link flow (`openLobbyAndJoin`) when the existing re-broadcast mechanism already covers it for free.

Docs: none — this stage is multiplayer-session-lifecycle behavior, not a cart-facing field/opcode/format change; nothing in `cart-object.md`/`hooks.md`/the skill references needed updating.

Verified via `test/smoke.js`: two sessions on the same room code reach `'connected'` with no cart passed to `connectToRoom` at all (the structural proof the topic decouple actually removed cart as an input, not just stopped reading it); a peer joining broadcasts the party queue; `addToQueue`/`removeFromQueue` on either side are reflected on the other; `startMatch` on one peer fires the local match-start listener immediately *and* starts a match on the other peer with the exact same peer-verified fragment — the concrete regression test for the desync risk the topic decouple would otherwise reopen. The existing lobby-state-machine and gameplay-sync-UI tests were reworked for the new behavior (a peer joining now shows the queue instead of auto-starting a match; clicking the auto-seeded item's Play button is what starts it) rather than just signature-patched. One real, if narrow, bug the queue tests caught directly: queue-entry ids were generated from a per-session counter plus `selfId` alone, which collides when two sessions share one `selfId` (only possible within a single JS realm, as two mock sessions in one test page do — real distinct peers have distinct Trystero-generated `selfId`s and can't collide this way) — fixed by adding a random suffix, cheap insurance against a scenario this code otherwise has to reason carefully about. 3 clean full-suite runs, plus a Playwright screenshot confirming the queue UI renders correctly (auto-seeded item, Add-a-game list, Leave Party) and that clicking Play actually starts and plays a real synced match.

## 100. Multiplayer Party — fifth stage: persistent chrome — hide vs. leave, and a party indicator that survives navigation

§99 made the room itself persistent (one topic for the whole party, a shared queue, unilateral Play) but the *UI* around it hadn't caught up: the X button and scrim click both still called `closeLobby()` — the real, full teardown (`stopSync()`, `activeSession.leave()`, unsubscribe everything) — so closing the panel for any reason, including a stray tap outside the card, ended the party. Worse, `main.js`'s `goToMenu()`/`openDebug()` (the shelf's "← shelf" button and the in-game "Tinker" button) *also* called `closeLobby()` unconditionally, on the old reasoning that leaving a room joined silently in the background was worse than just ending it — which was the right call when a room was scoped to one match, but exactly backwards now that the point of a persistent room is that it survives switching between games.

This stage splits "hide" from "leave" for real. `hideLobby()` (X/scrim, `initMultiplayerUI`) does nothing but remove `.mp-overlay`'s `active` class — the room stays exactly as connected as it was. Actually leaving is now only ever the explicit in-panel button's job (Cancel while waiting for a peer, "Leave Party" once connected, Close after a disconnect — all still wired to the real `closeLobby()`). Navigating away from a *match* needed a third function, distinct from both: `leaveMatchKeepParty()` calls `stopSync()` (detaching the per-tick sync hook cleanly, same as `closeLobby()`'s first step) but never touches the room connection at all. `goToMenu()`/`openDebug()` call this now instead of `closeLobby()` — switching to the shelf or Tinker still correctly ends whatever match is running (the `World` driving it is being torn down or paused either way, and a match's sync has no defined meaning outside a live `World`) without also dropping the party.

Getting back to a hidden-but-still-connected party needed its own entry point, since the existing "Multiplayer" button lives inside the game view's own topbar — invisible on the shelf or in Tinker. New `#partyIndicator`: a small pill, deliberately `position:fixed` at the page level rather than nested in any one of the 3 views' own chrome, so it survives exactly the navigation it exists to recover from. Shown for `'connected'` and `'peer-left'` (still a real party, just between peers) via `updatePartyIndicator()`, called from every `handleSessionStateChange` transition; hidden for `'waiting-for-peer'` (no second player to have a party *with* yet) and after a real leave. One of this file's own now-familiar gotchas caught immediately by hand-testing, not review: setting `el.style.display = ''` to reveal it just cleared the inline override and fell back to the stylesheet's own `display:none` default (the exact bug `renderDiag()`'s own comment already warns about) — fixed by setting an explicit `'inline-block'`.

The other piece: `updateMultiplayerButton()` used to gate the "Multiplayer" entry button on `cart.maxPlayers >= 2`, correct back when a party was scoped to one cart. It's unconditional now — you can open a party while playing any single-player game and add a `maxPlayers:2` one to the shared queue from inside it (queue-*adding* itself stays gated on `maxPlayers >= 2`, via the existing `loadMultiplayerCapableCarts()` filter — untouched this round).

Docs: none — chrome/UI-lifecycle behavior, no cart-facing field/opcode/format change.

Verified via `test/smoke.js`: the Multiplayer button now shows for a single-player cart, not just a `maxPlayers:2` one; the party indicator appears once connected and stays visible while the panel is hidden; clicking the X leaves the mock room's `leave()` uncalled (hidden, not left) while clicking the panel's own "Leave Party" does call it; clicking the indicator reopens the same connected session showing the same queue; clicking the shelf's back button mid-party leaves the room open and the indicator still reachable from the shelf, not just the game view that started it. 3 clean full-suite runs, plus Playwright screenshots confirming the indicator's placement doesn't collide badly with the identity chip on the shelf or the topbar buttons in the game view, and that reopening it from the shelf shows the exact same connected party (room code, queue, and connection log all intact).

## 101. Multiplayer Party — sixth stage: identity broadcast — the peer's real name and avatar, not "your friend"

Every prior stage's UI (the queue's "added by", the party indicator, the panel itself) fell back to a generic "your friend" or a bare 👥 placeholder, because nothing had ever told either peer who the *other* one actually was — `getIdentity()`/`setIdentity()` (§97) and the picker (§98) only ever wrote to `localStorage`, never onto the wire. This stage closes that gap with a third party-level Trystero action, `'party-identity'`, alongside `'party-queue'`/`'party-start'` from §99 — created once per room the same way, sending `{name, avatarId}`.

Two send sites, matching the plan's own wire-protocol note from before implementation started: `room.onPeerJoin` (§99's own re-broadcast handler) now also calls a new `session.broadcastOwnIdentity()` right after `broadcastQueue()` — the same "Trystero's `send()` never replays to a late joiner" reasoning applies identically to identity as to the queue, so a peer who joins or reconnects gets told who you are every time, not just once. The second site is explicit: a new module-level `broadcastIdentity()` export, called from the Stage 0c picker's own Save button (`main.js`) right after `Runtime.setIdentity(...)` — a no-op if no party is active, otherwise it pushes the live edit to the peer immediately rather than waiting for a reconnect that might never happen mid-session.

Received identity lands on `session.peerIdentity` (`null` until the first message arrives — deliberately not defaulted to some fake avatar/name, since a made-up placeholder would misrepresent a peer whose real identity just hasn't arrived yet) and fans out through a new `onPeerIdentityChange` subscription, wired into `startSession` the same way `onQueueChange`/`onMatchStart` already are. Three UI surfaces read it: the queue's "added by" (now the peer's real name, `peerDisplayName()`, falling back to "your friend" only while unknown or genuinely blank — `DEFAULT_IDENTITY`'s empty-string case, not distinguished from "hasn't arrived yet"), a new peer-info line at the top of the `'connected'`/`'peer-left'` panel bodies, and the party indicator (§100), upgraded from a static 👥/"Party" label to the peer's real rendered avatar (`Avatars.renderAvatarCanvas`, the same fixed 8 avatars and rasterization path §97 built) plus name once known.

Rendering a real `<canvas>` avatar inside markup this file builds via `innerHTML` strings needed the same two-step pattern `main.js`'s own `renderIdentityChip()` already uses: an empty `<span id="mpPeerAvatarSlot">` placeholder in the HTML, then `appendChild(Avatars.renderAvatarCanvas(...))` immediately after `innerHTML` is set — a canvas element can't be serialized into a string and reparsed back into a live, drawable node.

Docs: none — session-lifecycle/UI behavior, no cart-facing field/opcode/format change.

Verified via `test/smoke.js`, two ways. First, directly against `connectToRoom`'s own session API (matching the plan's own verification note): two sessions sharing one linked mock-room pair, with the *local* identity changed between each side's own `broadcastOwnIdentity()` call — since both "sessions" run in one page and therefore share one real `Runtime.getIdentity()`, changing it between calls is what makes each side send a genuinely different value, exactly modeling what two distinct real peers with distinct saved identities would each independently do. Confirmed: each side receives the other's distinct identity on connect, not a shared/confused one, and a live edit via `broadcastOwnIdentity()` (not just the initial connect) is received immediately. Second, through the real lobby UI: hosting, a peer joining, then simulating the peer's own `party-identity` message arriving (the same "invoke a captured callback directly" pattern this file's diagnostics tests already use for anything only a second real peer could trigger) — confirmed the panel shows the peer's real name and a real `<canvas>` avatar, and the party indicator does too. 3 clean full-suite runs, plus a Playwright screenshot confirming the rendered avatar is legible at both the panel's and the indicator's actual on-screen size, not just technically present in the DOM.

## 102. Multiplayer Party — seventh and final stage: End Round + a Ready/Skip vote cascade

The last piece of the Party plan: a manual "End Round" that either peer can trigger, followed by both peers voting Ready or Skip through a shared candidate list — [restart the game that was just playing, ...the queue at that instant] — advancing on any Skip, resolving the instant both sides are Ready on the same candidate. Confirmed directly in `kernel.js`'s hook system before writing any of this: there is no `on_game_over` hook anywhere in the cart-authoring API (Race Car laps forever, Flappy Bird just retries on death) — End Round is fully manual and player-initiated, deliberately, to avoid a much larger cart-authoring-API change every existing and future multiplayer cart would otherwise need to adopt. Automatic round-over detection stays explicit future work.

Two new party-level Trystero actions, alongside the three from §99/§101: `'party-end-round'` (`{}` — either peer sends it, both sides `stopSync()` and enter the cascade) and `'party-vote'` (`{cascadeId, candidateIndex, choice}`). The interesting design problem was `cascadeId`: the wire protocol needs it to let each side discard a stale vote (one for a candidate it's already moved past), but `party-end-round` deliberately carries no payload, so nothing ever tells the two peers to agree on a shared id. The resolution: `cascadeId` is a purely *local* monotonic counter, never transmitted, that only needs to stay numerically equal between the two peers — which it does by construction, not coordination. It only ever increments on two kinds of event, and both peers are guaranteed to process each occurrence of either exactly once: a cascade starting (the peer who calls `endRound()` runs `startCascade()` locally *and* sends `party-end-round`, which makes the other peer's `endRoundAction.onMessage` run the identical `startCascade()`), and a queue mutation observed mid-cascade (already reliably mirrored on both sides via the existing `notifyQueueChange()`, called from both the local mutation path and `queueAction`'s own `onMessage` — one extra line there re-snapshots the candidate list, satisfying the plan's own "any queue mutation mid-cascade resets to a fresh snapshot" rule). No coordination message is needed to keep two independently-incrementing local counters in lockstep when both sides only ever increment them in response to events they already can't help but see exactly once each.

Skip and Ready resolve asymmetrically on purpose, matching the original spec exactly: Skip from *either* side advances immediately, no need to wait on the other vote; Ready requires both `selfVote` and `peerVote` to read `'ready'` on the *same* candidate before anything happens. Both peers resolve independently off their own converged vote state and call `beginSyncedMatch` directly — reusing the existing `onMatchStart` wiring rather than a new "go" message, the same deterministic-and-symmetric reasoning `assignSlot()` already relies on for slot assignment. The 5-second local auto-ready timer (injectable as `voteTimeoutMs`, same override pattern `joinRoomFn` already established, defaulting to the real 5000ms) is armed per-candidate and checks its own captured `(cascadeId, candidateIndex)` before firing — the exact mechanism that makes a stale timer (one for a candidate the cascade already advanced past) a silent no-op instead of injecting a corrupting vote.

Two real bugs found by hand-testing and by the smoke suite respectively, neither visible from reading the code in isolation:

1. `startAction.onMessage` (the *receiving* side of a queue-item Play) never recorded `session.lastMatchFragment` — only the sending side's `session.startMatch()` did. Unnoticed until building the cascade tests: if the peer who *didn't* click Play later calls `endRound()`, their own candidate list would silently omit the restart candidate the other side's list has, shifting every later `candidateIndex` out of alignment between the two peers. Fixed by recording it in both places.
2. `castVote()`/`voteAction.onMessage` only called `notifyCascadeChange()` from inside `advanceOrResolve()` — which does nothing when a vote doesn't yet resolve or advance anything (still waiting on the other side). Caught visually, not by the automated suite: clicking Ready showed no feedback at all until the peer's own vote arrived. Fixed by notifying immediately after mutating `session.cascade`, before calling `advanceOrResolve()`.

UI: a new `#endRoundBtn` (visible only during a live synced match, the same hidden-during-sync slot pattern `#restartBtn` already uses, mirrored) opens the party panel into a vote view instead of the usual queue view whenever `session.cascade` is non-null — both peers see it, not just whoever clicked End Round, since the `onCascadeChange` subscription force-opens the overlay the same way `'peer-left'` already does.

Docs: none — session-lifecycle/UI behavior, no cart-facing field/opcode/format change (the deliberate absence of `on_game_over` is exactly why nothing here touches the authoring API at all).

Verified via `test/smoke.js`, both at the session level and through the real UI. Session-level (matching the plan's own verification list): both peers derive the identical candidate list from one `endRound()` call; explicit ready/ready resolves to the restart candidate and clears the cascade on both sides; explicit skip advances both sides to the next candidate with freshly-reset votes; a short injected timeout produces the same unanimous-ready outcome as an explicit click; and the race condition the staleness guard exists for — a skip advancing the cascade while a now-stale timer (armed for the pre-skip candidate) is still ticking — confirmed the stale timer's eventual firing is discarded rather than corrupting the already-advanced candidate (this one needed carefully staggered real waits, not just a single generous timeout, since two timers of the same duration armed moments apart will both eventually fire within any sufficiently long window — the first naive version of this test passed for the wrong reason, letting a second, entirely legitimate unanimous-ready resolve and mask whether the stale one had actually been discarded). UI-level: the End Round button stays hidden until a match is live, appears alongside the hidden restart button once one starts, and clicking it swaps the panel to the vote view with real, clickable Ready/Skip buttons. 3 clean full-suite runs, plus Playwright screenshots of the full flow — the button appearing mid-match, the vote view opening with both players' status, and a Ready click reflecting immediately in the local player's own row.

With this stage shipped, every stage of the original Multiplayer Party plan (§96-102) is complete: a persistent party room, a shared queue, unilateral Play, chrome that survives navigation, real peer identity, and now a full post-round Ready/Skip cascade.

## 103. Open questions

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
  for hooks themselves is still open — but the asset/entity side is now
  genuinely fully-visual end to end: §62 for shape-list sprites (drag
  shapes with the cursor), §64 for raw-pixel sprites and tiles (paint
  palette indices directly), and §65 for entity types themselves
  (add/remove, reassign which sprite or tile a type draws as) — no text
  editing required for art or entity wiring, only for hook logic.
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
