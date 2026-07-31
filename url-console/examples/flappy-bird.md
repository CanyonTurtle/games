# Dogfood: Flappy Bird, uncompressed

Short answer: **it fits, easily, even uncompressed** — the raw cart comes
in around ~165 bytes (~220 base64url chars), well under even the "micro"
(≤280 char) size class from `DESIGN.md`. Bit budget was never the
obstacle. The obstacle was that writing it exposed four real gaps in the
spec as drafted. This doc is the worked cart *and* the punch list of
fixes, folded back into `DESIGN.md` §13.

Flappy Bird is actually a good stress test precisely because it doesn't
fit any of the six declarative genre templates cleanly — it's an endless
scroller with runtime-generated obstacles, not an authored level. So
this cart uses `cart_type = 63` (generic/raw): no declarative body at
all, everything is header + assets + hook bytecode.

## 0. What broke on first draft, up front

1. **`on_tick` can't be a single global call.** Bird physics and pipe
   movement/scoring/despawn are inherently *per-entity* behavior. A
   VM with no arrays or loops has no way to iterate a dynamic-length
   entity list from one global entry point. Fix: `on_tick(self)` is
   invoked once per **active entity**, same shape as `on_collide(a, b)`.
   A separate `on_frame` (truly global, once/frame) exists for
   whole-cart bookkeeping like spawning. This is a real amendment to
   §7, not just a Flappy-specific quirk.
2. **Entities need a scratch field.** Scoring requires "have I already
   credited the player for passing this pipe" — a boolean that isn't
   position, velocity, hp, type, or animation frame. Fix: every entity
   gets a small generic `flags`/`custom` field (a few bits) that hook
   bytecode can read/write freely. The property list in §7 was
   incomplete.
3. **No opcode to remove an entity.** Pipes scroll off-screen forever
   without one, and the entity count grows unbounded. Fix: `KILL self`
   is a needed complement to `SPAWN`, obvious in hindsight but absent
   from the original hot-opcode list.
4. **Not every entity is a single sprite blit.** A pipe's visible
   height depends on the (randomized) gap position — it can't be one
   fixed sprite. Fix: an **entity type table** (new header segment)
   declares, per type, a `render_kind` (`sprite` | `tile_column_down` |
   `tile_column_up` | `rect`) and an asset index, so pipes render as a
   repeated tile run of a runtime-computed length rather than a blit.
5. **Tunable numbers wanted a home.** Gravity, flap impulse, scroll
   speed, and gap size are all just numbers a designer wants to nudge
   without hunting through bytecode for every literal. Fix: a small
   **constant pool** (8 named fixed-point slots) in the header;
   bytecode references `PUSHC n` instead of re-encoding the literal
   every time it's used. Bonus: reused constants (gravity is read every
   tick) get cheaper to encode after the first use.

None of these change the byte budget story — they're ergonomics and
completeness fixes, not compression problems.

## 1. Header

```
format_version = 1
cart_type      = 63              (generic/raw — endless scroller, no template fits)
palette_mode   = 0               (curated bank)
palette_idx    = 3               ("sky/grass" bank: sky blue, white cloud,
                                   grass green, pipe green, outline black,
                                   bird yellow, bird orange, highlight white)
rng_seed       = 0x2A
mode_flags     = 0b00000000      (no hard mode / mirrored controls for v1)
```

Constant pool (new segment, §5 below in DESIGN.md terms — 8 slots,
16.16 fixed point, 2 bytes each = 16 bytes):

| slot | name | value | meaning |
|---|---|---|---|
| 0 | GRAVITY | 0.35 | added to bird.vel_y every tick |
| 1 | FLAP_IMPULSE | -3.2 | set as bird.vel_y on flap input |
| 2 | SCROLL_SPEED | 1.5 | pipe.pos_x -= this, every tick |
| 3 | GAP_SIZE | 26 | vertical gap height, in px |
| 4 | GAP_MIN_Y | 12 | min gap top, px from screen top |
| 5 | GAP_MAX_Y | 70 | max gap top, px from screen top |
| 6 | SPAWN_PERIOD | 90 | ticks between pipe pairs |
| 7 | SCREEN_H | 128 | logic screen height |

## 2. Entity type table (new segment)

| type id | name | render_kind | asset | collision | notes |
|---|---|---|---|---|---|
| 0 | BIRD | sprite | sprite#0 (8×8) | AABB = sprite size | player-controlled |
| 1 | PIPE_TOP | tile_column_down | tile#0 (body) + tile#1 (cap) | AABB = 8×`extent` | grows downward from y=0 |
| 2 | PIPE_BOTTOM | tile_column_up | tile#0 (body) + tile#1 (cap) | AABB = 8×`extent` | grows upward from y=SCREEN_H |

`extent` (tile count) is stored in the entity's generic `custom0` field
at spawn time — that's what makes the tile-column render primitive
resolution-independent of a fixed sprite.

Entity properties available to bytecode, finalized list after this
exercise: `pos_x, pos_y, vel_x, vel_y, type, hp, anim_frame, custom0,
custom1` (two generic scratch fields, not one — `custom1` holds the
"already scored" bool for pipes, `custom0` holds tile extent).

## 3. Graphics data

Palette bank #3 (curated, 8 of the 16 slots used):

| idx | color |
|---|---|
| 0 | transparent |
| 1 | outline black |
| 2 | bird yellow |
| 3 | bird orange (beak) |
| 4 | pipe green (fill) |
| 5 | pipe green (dark edge) |
| 6 | pipe highlight |
| 7 | sky blue (background, drawn by runtime chrome, not a tile) |

Bird sprite, 8×8, 2bpp indices into slots {0,1,2,3} (32 bytes at 4bpp
would be wasteful here — 2bpp is enough since the sprite only needs 4
colors, so this is 16 bytes):

```
00000000
00111000
01222110
12222211
12222211
01222213
00111100
00000000
```

Pipe body tile, 8×8, 2bpp {0,4,5,6} (repeated vertically for `extent`
tiles — 16 bytes):

```
55555555
54444445
54444445
54466445
54444445
54444445
54444445
55555555
```

Pipe cap tile, 8×8, same palette subset, drawn once at the gap-facing
end of each pipe (16 bytes):

```
55555555
56666665
56666665
54444445
54444445
54444445
54444445
55555555
```

Gfx total: 16 + 16 + 16 = 48 bytes.

## 4. Hook bytecode

Written as assembly-style mnemonics for readability — the actual VM
packs the ~16 hottest ops into 4 bits with a 4-bit escape, so most of
these lines cost 1 byte and a few cost 2; running tally at the bottom.

### `on_init` (global, once)

```
SPAWN   BIRD                  ; -> pushes new entity id
STOREG  g_player
PUSHI   40
STORE   g_player.pos_x
PUSHI   64
STORE   g_player.pos_y
SETTIMER 0, PUSHC(SPAWN_PERIOD), repeat=true
PUSHI   0
STOREG  g_score
PUSHI   0
STOREG  g_dead
```

### `on_input(buttons)` (global, every frame the input changes)

```
LOADG   g_dead
JNZ     input_end             ; ignore input once dead
LOAD    buttons
TESTBIT BUTTON_A
JZ      input_end
LOADG   g_player
PUSHC   FLAP_IMPULSE
STORE   self.vel_y            ; self bound to g_player for this store
input_end:
RET
```

### `on_tick(self)` (per active entity, every frame)

```
LOAD    self.type
CMPEQ   BIRD
JZ      tick_bird
LOAD    self.type
CMPEQ   PIPE_TOP
JZ      tick_pipe
LOAD    self.type
CMPEQ   PIPE_BOTTOM
JZ      tick_pipe
RET

tick_bird:
  LOADG   g_dead
  JNZ     tick_end
  LOAD    self.vel_y
  PUSHC   GRAVITY
  ADD
  STORE   self.vel_y
  LOAD    self.pos_y
  LOAD    self.vel_y
  ADD
  STORE   self.pos_y
  LOAD    self.pos_y
  CMPLT   0
  LOAD    self.pos_y
  PUSHC   SCREEN_H
  CMPGT
  OR
  JZ      tick_end
  PUSHI   1
  STOREG  g_dead
  JMP     tick_end

tick_pipe:
  LOAD    self.pos_x
  PUSHC   SCROLL_SPEED
  SUB
  STORE   self.pos_x
  LOAD    self.pos_x
  CMPLT   -8
  JZ      check_score
  KILL    self
  RET

  check_score:
  LOAD    self.custom1        ; "scored" flag
  JNZ     tick_end
  LOAD    self.pos_x
  LOADG   g_player
  LOAD    self.pos_x           ; note: bird.pos_x via bound-self swap, see open Q below
  CMPLT
  JZ      tick_end
  PUSHI   1
  STORE   self.custom1
  LOADG   g_score
  PUSHI   1
  ADD
  STOREG  g_score

tick_end:
RET
```

### `on_collide(a, b)` (global, per overlapping AABB pair)

```
LOAD    a.type
CMPEQ   BIRD
LOAD    b.type
CMPEQ   PIPE_TOP
AND
LOAD    a.type
CMPEQ   BIRD
LOAD    b.type
CMPEQ   PIPE_BOTTOM
AND
OR
JZ      collide_end
PUSHI   1
STOREG  g_dead
collide_end:
RET
```

### `on_timer(id)` (global, fires every `SPAWN_PERIOD` ticks)

```
LOADG   g_dead
JNZ     timer_end
RAND    PUSHC(GAP_MIN_Y), PUSHC(GAP_MAX_Y)   ; -> gap_top on stack
DUP
SPAWN   PIPE_TOP
STORE   self.custom0           ; extent = gap_top / 8 (tiles)
PUSHC   GAP_SIZE
ADD
SPAWN   PIPE_BOTTOM
STORE   self.custom0           ; extent = (SCREEN_H - (gap_top+GAP_SIZE)) / 8
timer_end:
RET
```

## 5. Byte tally (rough, hand-counted)

| segment | bytes |
|---|---|
| header + mode flags | 6 |
| constant pool (8×2) | 16 |
| entity type table (3×2) | 6 |
| palette (curated index) | 1 |
| sprite + 2 tiles (2bpp, 8×8 each) | 48 |
| bytecode (~70 packed instructions, ~1.3 B avg) | ~90 |
| **total (raw, pre-base64url)** | **~167** |
| base64url expansion (×4/3) | **~223 chars** |

That's comfortably inside the "micro" (≤280 char) class **uncompressed**
— dictionary compression (§3 of `DESIGN.md`) was not even needed to hit
the tightest size class for this game.

## 6. Conclusion

Flappy Bird is squarely within the format's reach — the constraint that
actually bit (pun intended) wasn't URL length, it was that the original
VM/hook sketch assumed more uniformity across genres than an endless
procedural scroller has. Writing this cart is what surfaced §7's
per-entity `on_tick`, the `KILL` opcode, per-entity scratch fields, the
entity type/render table, and the constant pool — all now folded into
`DESIGN.md`.

One rough edge remains uncredited above (see `DESIGN.md` §13 for the
open question it raises): the scoring comparison in `tick_pipe` needs
"my pos_x" vs "the bird's pos_x," i.e. reading a property off an entity
that **isn't** `self`. The hook model as sketched only cleanly exposes
`self` (`on_tick`) or `a`/`b` (`on_collide`); reaching an arbitrary
*other* entity by global handle (`g_player`) needs either a `LOAD
<entity_handle>.<prop>` addressing mode or an explicit "load entity by
id, then read prop" two-step the assembly above only gestures at. That's
a real gap, not a typo — flagged in `DESIGN.md` rather than papered over
here.
