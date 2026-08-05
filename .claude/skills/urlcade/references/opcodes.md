# Opcodes

The VM (`runHook` in `kernel.js`) is a stack machine. Every instruction
below is `mnemonic` (assembly source) / one byte (bytecode) plus whatever
operands are listed. **Operand columns are literal bytes embedded in the
instruction** (`u8` = 0-255, `i16` = signed 16-bit, `addr` = a 16-bit
label address the assembler resolves) — distinct from **stack
operands**, which are values an instruction pops that some earlier
instruction pushed. "Push order" below is left-to-right in emitted
source; whichever was pushed last is on top, and pops happen top-first —
get this backwards and an instruction gets its operands swapped, not an
error.

A single hook invocation is capped at `MAX_STEPS = 20000` dispatched
instructions; exceeding it sets `world.cartFault = true` and aborts. See
`hooks.md`.

## Stack & arithmetic

| Op | Operands | Stack effect |
|---|---|---|
| `PUSHI i16` | embedded i16 | push the literal |
| `PUSHC idx` | embedded u8 | push `constants[idx]` |
| `DUP` | — | duplicate top |
| `POP` | — | discard top |
| `SWAP` | — | swap top two |
| `ADD` / `SUB` / `MUL` | — | pop b, pop a, push `a+b` / `a-b` / `a*b` |
| `DIV` | — | pop b, pop a, push `b!==0 ? a/b : 0` |
| `MOD` | — | pop b, pop a, push `b!==0 ? a-Math.floor(a/b)*b : 0` |
| `NEG` | — | pop a, push `-a` |

Division/modulo by zero push `0` rather than throwing or producing `NaN`.

## Comparison & logic

`CMPEQ`, `CMPNE`, `CMPLT`, `CMPLE`, `CMPGT`, `CMPGE` — pop b, pop a, push
`1`/`0` for `a <op> b`. `AND`, `OR` — pop b, pop a, push `1`/`0` for JS
truthiness of `a && b` / `a || b` (not bitwise). `NOT` — pop a, push `1`
if a was falsy, else `0`.

## Control flow

`JMP addr`, `JZ addr`, `JNZ addr` — `addr` is a label, resolved by the
assembler to a byte offset. `JZ`/`JNZ` pop one value and branch if it's
`0` / non-zero. **There is no `CALL`/`RET`** — no subroutine mechanism at
all. A loop is a label + a counter you maintain in a global + a trailing
`JNZ` back to the top; there is no other way to avoid duplicating logic
that needs to run more than once with different data (see
`workflow.md`'s note on this — it's a real, load-bearing constraint, not
an oversight).

## Entity state

Every entity has `9 + extFieldCount` numeric props (`extFieldCount` from
its `entityTypes[]` entry): the base eight, `extFieldCount` slots for the
cart's own use starting at `[8]`, then one more the runtime appends
*after* those — `props[8 + extFieldCount]`, this entity's own current
`assetIndex` (auto-set on spawn to its type's `assetIndex`, then read
every frame by the renderer instead of the type's — `STORE_SELF (8 +
extFieldCount)` retargets which sprite/tile-pair this one entity draws
as, independent of every other instance of its type). Deliberately
placed *after* every ext field rather than reusing one of the base
eight's nominally-"free" slots: a slot that looks unused by grep can
still be spoken for by a cart via a named constant (`doom-like.js`'s
`ANGLEPROP = 6` writes to `props[6]` with no literal `"6"` anywhere near
a `STORE_SELF` call in its source) — appending past `extFieldCount`
can't collide with any per-cart convention, named or not, since it's
always one past whatever the author declared for themselves.

The runtime reserves four of the base eight: `props[0]`/`[1]` = x/y
(camera- and render-interpolated), `props[4]` = its own `typeId`
(auto-set on spawn), `props[7]` = its own entity id (auto-set on spawn).
`props[2]`/`[3]`/`[5]`/`[6]` and any ext slots (`[8]` through
`[7 + extFieldCount]`) are free for cart use — `props[2]`/`[3]`
conventionally hold velocity when a cart uses `MOVE_SOLID` (which
reads/writes them directly), and `props[5]` is the de-facto "hp" slot by
convention across every shipped cart with combat (not runtime-enforced).

| Op | Operands | Effect |
|---|---|---|
| `LOAD_SELF idx` / `STORE_SELF idx` | u8 prop index | read/write `self.props[idx]` (push / pop) — `0` on read if there's no `self` bound |
| `LOAD_A idx` / `LOAD_B idx` | u8 | read `a.props[idx]` / `b.props[idx]` (`on_collide` only — `0` elsewhere) |
| `STORE_A idx` / `STORE_B idx` | u8 | pop, write `a.props[idx]` / `b.props[idx]` |
| `LOADE handleGlobal, idx` | u8 (a **global slot**, not a literal), u8 (prop index) | resolve the entity id stored in `globals[handleGlobal]`, push its `props[idx]` (`0` if that entity no longer exists) |
| `STOREE handleGlobal, idx` | u8, u8 | pop, write that same resolved entity's `props[idx]` |

`LOADE`/`STOREE`'s first operand is a **global slot index**, written as
the global's name in assembly source (e.g. `LOADE g_player 5`) — it is
resolved to the *value stored there* (an entity id) at runtime, not read
as a literal. This is how a hook reaches an entity that's neither `self`
nor `a`/`b`: stash its id in a global at spawn time, address it by handle
from anywhere afterward.

## Globals

`LOADG idx` / `STOREG idx` (u8 slot index, 0-23 — `World.globals` is a
fixed 24-element array) — read/write `globals[idx]` directly (push /
pop). Persist across ticks and hook calls for the whole run; a cart
typically keeps a `GLOBAL_NAMES` name→index map in its authoring source
(not part of the binary format).

## World queries

| Op | Stack in (push order) | Stack out | Notes |
|---|---|---|---|
| `RAND_RANGE` | min, max | one int | `min + floor(rng() * (max-min))` |
| `SIN` / `COS` | degrees | one float | `Math.sin`/`cos(deg * PI/180)` |
| `ATAN2` | dx, dy | degrees | `atan2(dy, dx) * 180/PI`, range (-180, 180] |
| `DIST` | x1, y1, x2, y2 | one float | Euclidean distance |
| `CLAMP_ABS` | value, limit | one value | `max(-limit, min(limit, value))` |
| `LERP` | a, b, t | one value | `a + (b-a)*t` |
| `NORM_ANGLE` | degrees | degrees | normalized to (-180, 180] |
| `GETTILE` | x, y (pixels) | tile id | `-1` if the cart has no map; the generator's own edge/boundary id if `(x,y)` is off-grid (every shipped generator uses id `1` for this) |
| `TILE_SURFACE` | tile id | surface value | identity unless overridden — see `tileSurfaceOverrides` in `cart-object.md` |
| `GET_CHECKPOINT` | checkpoint index | x, then y (y on top) | reads the map generator's own `checkpoints[]` array; `{0,0}` if none |

## Entity lifecycle

- `SPAWN typeId` (u8 operand) — creates an entity of that type (all
  props zeroed except the auto-set `[4]`/`[7]`), pushes its new id.
- `KILL_SELF` — no stack effect; deactivates `self` (removed from the
  world at the end of the current step).
- `MOVE_SOLID` — no stack effect. Axis-separated collision: advances
  `self.props[0]` by `self.props[2]` (x by vx) and `props[1]` by
  `props[3]` (y by vy), independently per axis, using
  `entityTypes[self.typeId].collisionW`/`collisionH` as the AABB and
  `tileSurface(getTile(...)) !== 0` as the solidity test against the
  map; zeroes the velocity component on the axis that hit something.
  Requires `self` and a map generator.
- `SETTILE` — stack in: x, y (pixels), tileId (top). Mutates the live
  map grid and repaints the pre-rendered map bitmap at that one tile —
  the only way a hook can change the map after `on_init`.

## Input

- `TESTBIT bitIndex` (u8 operand — a bit **index** 0-4, not the bit
  *value*: index 0 = value 1/left, 1 = 2/right, 2 = 4/up, 3 = 8/down,
  4 = 16/action) — pops a bitmask, pushes `(mask >> bitIndex) & 1`.
- `LOAD_INPUT` — pushes the current frame's raw button bitmask (no pop).
  Combine with `TESTBIT`, or test/mask it directly.
- `LOAD_POINTER_X` / `LOAD_POINTER_Y` / `LOAD_POINTER_DOWN` — push the
  pointer's current cart-space x/y or held state; always `0` unless the
  cart set `inputWantsPointer`.

## Drawing

- `DRAW_LINE` — stack in: x1, y1, x2, y2, color (color on top — same
  "last pushed operand ends up on top" convention as `SETTILE`). Only
  meaningful from `on_draw`, issued by a `renderKind:2` entity; a no-op
  everywhere else (harmless if bytecode contains it, since nothing
  consumes the sink outside a draw call). Coordinates are entity-local
  pixels, translated to screen space by the renderer the same way an
  ordinary sprite is.

## Control

- `PLAYSOUND id` (u8 operand) — fires a short synthesized tone (frequency
  scales with `id`); silently does nothing if the runtime has no audio
  sink.
- `HALT` — stops the hook immediately (`return true`). A hook that falls
  off the end of its bytecode without an explicit `HALT` also just stops
  — `HALT` is for early-exiting a branch, not required at every hook's
  end, though every shipped cart ends each hook with one for clarity.
