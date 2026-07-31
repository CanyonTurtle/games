# Dogfood: top-down race car, uncompressed

Where Flappy Bird (`flappy-bird.md`) broke every genre template and had
to fall back to `cart_type = 63` (generic/raw), this one is the control
case: does the declarative **Racer/golf** template (`cart_type = 2`,
described only vaguely in `DESIGN.md` §5 as "track spline control
points or procedural track seed, physics constants") actually hold up
for a real game? Mostly yes — but it stresses a completely different
part of the format than Flappy did: continuous physics/heading instead
of grid-ish entities, a track *grammar* instead of RLE tiles, and
terrain-based (not just entity-based) collision. It also **confirms** a
gap Flappy only flagged as a maybe, and forces one real generalization
of the entity-properties model. Findings are folded into `DESIGN.md`
§14 and the amended §4/§7.

## 0. What this run changed, up front

1. **Confirmed, not just flagged: bytecode needs to read a property off
   an arbitrary entity by id.** Flappy's write-up noted this as a rough
   edge (pipe reading the bird's `pos_x`) and left it an open question.
   Here it's load-bearing: computing race position requires comparing
   progress across three known cars from a hook (`on_frame`) that isn't
   bound to any entity at all. Two independent games needing the same
   primitive is enough to promote it: `LOADE <entity-id>.<prop>` /
   `STOREE` are now real opcodes, not a future maybe.
2. **`custom0`/`custom1` don't generalize.** Flappy needed one scratch
   bool. A car needs `heading`, `angular_vel`, `next_checkpoint_idx`,
   `lap_count`, and `finish_rank` simultaneously — and a particle only
   needs a `ttl`. Bumping the generic-scratch-field count forever
   (`custom0..customN`) doesn't scale and wastes bytes on entities that
   don't need them. Fix, replacing the ad hoc Flappy version: the
   entity type table now lets each type **declare its own named
   extension fields with their own bit widths**, instead of everyone
   getting the same fixed generic slots.
3. **Trig needs a table, not an algorithm.** Turning a `heading` into a
   velocity delta (`accel * cos(heading), accel * sin(heading)`) and
   turning a target direction into a desired heading (`atan2(dy, dx)`)
   for AI steering are unavoidable for anything that isn't grid-aligned.
   Hand-rolling series expansion in a tiny fixed-point VM is a bad time.
   Fix: the runtime ships a shared 256-entry fixed-point sin/cos table
   and an atan2 lookup, exposed as opcodes (`SIN`, `COS`, `ATAN2`) —
   free for every cart since it lives in the runtime, not the URL.
4. **Sprite rotation should be a runtime draw feature, not N stored
   frames.** A car sprite drawn at an arbitrary heading naively wants
   8–32 pre-rotated frames. Since the trig table already exists for
   physics, the `sprite` render kind gains an optional "rotate by
   `self.heading`" flag and the runtime rotates the one stored bitmap
   at draw time. One sprite instead of a bank of rotated ones.
5. **The vague "procedural track seed" is now a concrete grammar.** A
   closed lap track is authored (or generated) as a short sequence of
   **track-piece tokens** from a fixed bank (straight, 45°/90° curves,
   chicane, start/finish, checkpoint), each ~4 bits, turtle-interpreted
   by the runtime into the tile plane. This is the same "generate,
   don't store" move as procedural levels/palettes, just applied to a
   racetrack, and it turns out to be *extremely* cheap: a full oval
   lap is ~16 tokens, 8 bytes.

## 1. Header

```
format_version = 1
cart_type      = 2               (Racer/golf)
palette_mode   = 1               (procedural harmony)
palette_seed   = base_hue=210° (blue-gray asphalt), scheme=monochrome,
                 sat=[5,20], light=[15,55], accent_offset=+120°
rng_seed       = 0x11
mode_flags     = 0b00000010      (bit0 mirror=off, bit1 hard_wall=on, bit2 ai_hard=off)
```

Finding worth calling out: a single-hue "monochrome" harmony scheme with
a **low, narrow saturation range** is what generates a convincing
asphalt/concrete gray ramp — tracks don't want hue variety in the road
itself, they want a believable neutral. The `accent_offset` field (spec
originally hand-waved as "for UI/accent colors") turns out to be exactly
the field the grass/rumble-strip color needs: one hue-shifted accent
off the same generator, rather than a second unrelated color pulled
from nowhere. Both fields already existed in `DESIGN.md` §6 — this run
is what validates they're the right two knobs.

Constant pool (10 slots):

| slot | name | value |
|---|---|---|
| 0 | ACCEL | 0.08 |
| 1 | MAX_SPEED | 3.0 |
| 2 | TURN_RATE | 6° per tick |
| 3 | FRICTION_ROAD | 0.02 |
| 4 | FRICTION_RUMBLE | 0.06 |
| 5 | FRICTION_GRASS | 0.15 |
| 6 | CHECKPOINT_RADIUS | 6 px |
| 7 | TOTAL_LAPS | 3 |
| 8 | AI_TURN_GAIN | 0.5 |
| 9 | PARTICLE_TTL | 12 ticks |

## 2. Track grammar (the "procedural track seed" made concrete)

Piece bank (4 bits, 9 of 16 slots used): `STRAIGHT, CURVE_L45, CURVE_R45,
CURVE_L90, CURVE_R90, CHICANE_L, CHICANE_R, START_FINISH, CHECKPOINT`.

A rounded-rectangle oval, one lap:

```
START_FINISH, STRAIGHT, STRAIGHT, STRAIGHT, CURVE_R90,
STRAIGHT, STRAIGHT, CURVE_R90, CHECKPOINT,
STRAIGHT, STRAIGHT, STRAIGHT, CURVE_R90,
STRAIGHT, STRAIGHT, CURVE_R90
```

16 tokens × 4 bits = **8 bytes**, turtle-interpreted at load time: start
at origin heading = east, each piece advances (x, y, heading) by its
canonical delta and stamps a fixed-width strip (`TRACK_WIDTH` = 3 tiles:
road center, rumble edge each side, grass beyond) into the tile plane.
`START_FINISH` and `CHECKPOINT` tokens also register a world-space
checkpoint position in a small **level-data table** the runtime builds
once at load and exposes to bytecode via `GET_CHECKPOINT idx` — a third
data-access kind alongside entity properties and `GETTILE`, and one this
exercise needed but `DESIGN.md` hadn't named yet (see open questions).

Tile surface types, keyed off tile id via a small runtime-builtin
`TILE_SURFACE(tile_id)` map: `ROAD | RUMBLE | GRASS | WALL` (the last
only exists when `mode_flags.hard_wall` is set — otherwise off-track
tiles are just slow, not solid).

Compare to a literal tile grid for the same loop: at even a modest
64×64 world, RLE'd road/grass runs would cost several times this. Eight
bytes for a full lap is the generate-don't-store thesis paying off
concretely, the same way seeded procedural levels were supposed to.

## 3. Entity types, now with declared extension fields

Universal fields every entity has: `pos_x, pos_y, vel_x, vel_y, type,
hp, anim_frame`. Anything beyond that is **declared per type** in the
entity type table, not a fixed global scratch allocation:

| type id | name | render_kind | extension fields | notes |
|---|---|---|---|---|
| 0 | CAR | sprite, rotate_by=heading | `heading`(16b), `angular_vel`(8b), `next_cp`(8b), `lap_count`(8b), `finish_rank`(8b) | 6 bytes/entity of extension state |
| 1 | PARTICLE | sprite | `ttl`(8b) | dust/skid puff, expires via `KILL` |

This replaces Flappy's ad hoc `custom0`/`custom1`: a pipe needing one
scratch bool and a car needing five named fields are both expressible
by declaring exactly what a type needs, at the width it needs, instead
of guessing a fixed generic-field count that's wasteful for simple
types and insufficient for complex ones.

## 4. Graphics

Palette (procedural, per §1): 8 of 16 slots — transparent, asphalt
dark/mid/light (the monochrome ramp), rumble red/white, grass green
(accent), car body accent.

Car sprite, 8×8, 2bpp, drawn facing east at heading=0 (runtime rotates
per `self.heading` at draw time — one bitmap, no frame bank):

```
00111100
01222210
12222221
12233221
12222221
12222221
01222210
00111100
```

Track tiles, 8×8, 2bpp — road, rumble, grass, wall (4 tiles × 16 bytes
= 64 bytes; wall reuses the grass palette with a darker outline rather
than a fifth distinct tile).

Particle sprite, 4×4, 1bpp (8 bytes) — a single dot, faded by `ttl`.

Gfx total: 16 (car) + 64 (4 track tiles) + 8 (particle) = **88 bytes**.

## 5. Hook bytecode (representative, not exhaustive)

### `on_init` (global, once)

```
SPAWN CAR -> STOREG g_car_player
  PUSHC START_X ; STORE self.pos_x
  PUSHC START_Y ; STORE self.pos_y
  PUSHI 0       ; STORE self.heading
  PUSHI 0       ; STORE self.next_cp
  PUSHI 0       ; STORE self.lap_count
  PUSHI 0       ; STORE self.finish_rank

SPAWN CAR -> STOREG g_car_ai1   ; lane offset +8px, same init pattern
SPAWN CAR -> STOREG g_car_ai2   ; lane offset -8px

PUSHI 0 ; STOREG g_finish_counter
PUSHI 0 ; STOREG g_race_over
```

### `on_input(buttons)` — steers the player car only

```
LOADG g_race_over
JNZ input_end
LOADG g_car_player
TESTBIT BUTTON_LEFT
  JZ  skip_left
  LOADE g_car_player.heading ; PUSHC TURN_RATE ; SUB ; STOREE g_car_player.heading
skip_left:
TESTBIT BUTTON_RIGHT
  JZ  skip_right
  LOADE g_car_player.heading ; PUSHC TURN_RATE ; ADD ; STOREE g_car_player.heading
skip_right:
TESTBIT BUTTON_ACCEL
  JZ input_end
  LOADE g_car_player.heading ; COS ; PUSHC ACCEL ; MUL
  LOADE g_car_player.vel_x ; ADD ; STOREE g_car_player.vel_x
  LOADE g_car_player.heading ; SIN ; PUSHC ACCEL ; MUL
  LOADE g_car_player.vel_y ; ADD ; STOREE g_car_player.vel_y
input_end:
RET
```

### `on_tick(self)` — physics + AI + checkpoints, all car types

```
LOAD self.type ; CMPEQ PARTICLE ; JZ tick_particle
; -- CAR --
LOADG g_car_player ; LOAD self.id ; CMPEQ ; JNZ skip_ai   ; player steers via on_input
  ; AI steering
  GET_CHECKPOINT self.next_cp        ; -> (cx, cy) on stack
  LOAD self.pos_x ; LOAD self.pos_y
  ATAN2                              ; desired_heading = atan2(cy-y, cx-x)
  LOAD self.heading ; SUB            ; NORMALIZE_ANGLE
  PUSHC TURN_RATE ; PUSHC AI_TURN_GAIN ; MUL ; CLAMP_ABS
  LOAD self.heading ; ADD ; STORE self.heading
  LOAD self.heading ; COS ; PUSHC ACCEL ; MUL ; LOAD self.vel_x ; ADD ; STORE self.vel_x
  LOAD self.heading ; SIN ; PUSHC ACCEL ; MUL ; LOAD self.vel_y ; ADD ; STORE self.vel_y
skip_ai:
; integrate + terrain friction
LOAD self.pos_x ; LOAD self.vel_x ; ADD ; STORE self.pos_x
LOAD self.pos_y ; LOAD self.vel_y ; ADD ; STORE self.pos_y
LOAD self.pos_x ; LOAD self.pos_y ; GETTILE ; TILE_SURFACE   ; -> surface enum
DUP ; CMPEQ WALL
  JZ  not_wall
  ; hard stop: zero velocity, nudge back along -heading
  PUSHI 0 ; STORE self.vel_x ; PUSHI 0 ; STORE self.vel_y
  JMP after_friction
not_wall:
  ; friction = table[surface] via three compares (small, no jump table op yet — see open Qs)
  ... ; STORE friction_const
  LOAD self.vel_x ; LOAD self.vel_x ; friction_const ; MUL ; SUB ; STORE self.vel_x
  LOAD self.vel_y ; LOAD self.vel_y ; friction_const ; MUL ; SUB ; STORE self.vel_y
after_friction:
; checkpoint / lap progress
GET_CHECKPOINT self.next_cp
LOAD self.pos_x ; LOAD self.pos_y ; DIST ; PUSHC CHECKPOINT_RADIUS ; CMPLT
  JZ tick_end
  LOAD self.next_cp ; PUSHI 1 ; ADD ; PUSHI NUM_CHECKPOINTS ; MOD ; STORE self.next_cp
  LOAD self.next_cp ; JNZ tick_end            ; only lap-count on wrap to 0
  LOAD self.lap_count ; PUSHI 1 ; ADD ; STORE self.lap_count
  LOAD self.lap_count ; PUSHC TOTAL_LAPS ; CMPLT ; JNZ tick_end
  LOADG g_finish_counter ; PUSHI 1 ; ADD ; DUP ; STOREG g_finish_counter ; STORE self.finish_rank
  JMP tick_end
tick_particle:
  LOAD self.ttl ; PUSHI 1 ; SUB ; DUP ; STORE self.ttl
  JNZ tick_end
  KILL self
tick_end:
RET
```

### `on_collide(a, b)` — car-vs-car bump, spawns a dust particle

```
LOAD a.type ; CMPEQ CAR ; LOAD b.type ; CMPEQ CAR ; AND
  JZ collide_end
  ; swap a slice of velocity between a and b (soft bump, not a hard elastic solve)
  LOAD a.vel_x ; LOAD b.vel_x ; PUSHC 0.3 ; LERP ; STORE a.vel_x
  LOAD b.vel_x ; LOAD a.vel_x ; PUSHC 0.3 ; LERP ; STORE b.vel_x
  SPAWN PARTICLE
    LOAD a.pos_x ; STORE self.pos_x
    LOAD a.pos_y ; STORE self.pos_y
    PUSHC PARTICLE_TTL ; STORE self.ttl
collide_end:
RET
```

### `on_frame` (global) — race position / finish check

```
LOADE g_car_player.lap_count ; PUSHI NUM_CHECKPOINTS ; MUL
LOADE g_car_player.next_cp ; ADD                         ; progress_player
LOADE g_car_ai1.lap_count  ; PUSHI NUM_CHECKPOINTS ; MUL
LOADE g_car_ai1.next_cp    ; ADD                         ; progress_ai1
LOADE g_car_ai2.lap_count  ; PUSHI NUM_CHECKPOINTS ; MUL
LOADE g_car_ai2.next_cp    ; ADD                         ; progress_ai2
; three-way compare -> STOREG g_player_rank (1/2/3), used by HUD draw
...
LOADE g_car_player.finish_rank
LOADE g_car_ai1.finish_rank
LOADE g_car_ai2.finish_rank
; all nonzero? -> STOREG g_race_over = 1
RET
```

## 6. Byte tally (rough)

| segment | bytes |
|---|---|
| header + mode flags | 6 |
| constant pool (10×2) | 20 |
| entity type table (2 types, w/ extension-field widths) | ~10 |
| track grammar (16 tokens × 4 bits) | 8 |
| palette (procedural seed) | 3 |
| sprites/tiles (car 16 + 4 track tiles 64 + particle 8) | 88 |
| bytecode (~120 packed instructions incl. new trig/entity-ref ops, ~1.4 B avg) | ~170 |
| **total (raw, pre-base64url)** | **~305** |
| base64url expansion (×4/3) | **~407 chars** |

Roughly 1.8× Flappy Bird's size — still comfortably inside "standard"
(≤1000 chars), nowhere near "full." The increase over Flappy is almost
entirely **bytecode**, not graphics or level data: the track grammar (8
bytes) and procedural palette (3 bytes) stayed cheap exactly as
intended, while continuous physics + AI steering + position-ranking
pushed the behavior cost up. In both dogfoods so far, bytecode is the
dominant cost center (90/167 for Flappy, ~170/305 here) — once
graphics and level data are generative, **VM opcode density matters
more than asset compression** for whether a small-but-compelling game
fits its size class. That's worth treating as a standing design
priority, not just an incidental observation.

## 7. Conclusion

The Racer template holds up better than a fully generic cart would need
to, but only after two real amendments: entities needed *declared*
per-type extension fields instead of Flappy's fixed generic scratch
slots, and the VM needed a way to read/write an arbitrary entity by id
(`LOADE`/`STOREE`) — confirming, not just flagging, the gap Flappy left
open. Trig-via-lookup-table and rotate-by-heading sprites are new,
racer-specific, but cheap: both are runtime features paid for once,
not per cart. See `DESIGN.md` §14 for how these fold back into the
spec, and the open questions it adds about level-derived query tables,
closed-loop track validation, and how far named-entity-handle patterns
(`g_car_player`, `g_car_ai1`, ...) scale before they need a real
collection primitive.
