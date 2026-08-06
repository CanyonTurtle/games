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

## Persistence

`LOAD_PERSIST idx` / `STORE_PERSIST idx` (u8 slot index, 0-23 — same
shape as `LOADG`/`STOREG`, a separate 24-element array) — read/write
`World.persist[idx]` (push / pop), backed by `localStorage` and loaded
before `on_init` runs, so a value written on one play is already there
the next time the same cart loads. Unlike `globals`, survives a page
reload/tab close; unlike a raw `localStorage` call a cart author might
picture, there's no key to pick — the runtime keys it automatically per
cart (a hash of the cart's own encoded bytes, so editing the cart at all
starts its save data fresh rather than risking a stale/incompatible
value silently loading). No `PERSIST_NAMES` convention yet, the way
`GLOBAL_NAMES` exists for globals — pick a slot number and comment it,
same as `LOAD_SELF`/`STORE_SELF`'s raw prop indices. Reads `0` and
discards writes silently if `localStorage` isn't available at all
(private browsing, a sandboxed iframe) — never throws, never blocks a
hook that touches it. `STORE_PERSIST` is also a silent no-op for the
whole duration of a multiplayer match (`World.multiplayerActive`) —
a write from a tick that later turns out to have been mispredicted and
gets rolled back has no way to be taken back once it's landed in
`localStorage`, unlike in-memory state a snapshot can restore.
`LOAD_PERSIST` is unaffected; only writes are gated.

## Sound

Four persistent **voices** (channels 0-3), each a real oscillator+noise
node graph held for the whole play session — driven by these opcodes
every frame instead of indexing a table of pre-authored clips. A cart
computes its own melody/arpeggio/percussion logic in `on_frame`/`on_tick`
(the same arithmetic opcodes already used for anything else per-tick —
`ADD`, `MOD`, etc.) and pokes a voice's registers directly, the way a
real sound chip's registers work. `PLAYSOUND` (below, under Control) is
unrelated and untouched — it's still a valid one-shot beep, this is an
additive, more expressive layer on top, not a replacement.

- `SET_VOICE_FREQ voice` (u8 operand) — pops a value (Hz) off the stack,
  sets that voice's oscillator frequency. Fixed note frequencies (e.g.
  `440.0` for A4) are ordinary `f32` entries in `cart.constants[]`,
  pushed with `PUSHC` — no in-VM pitch math needed for a fixed scale;
  live modulation (a slide, an arpeggio) is `SET_VOICE_FREQ` called again
  with a computed value.
- `SET_VOICE_WAVE voice waveform` (two u8 operands, both immediate — no
  stack pop) — `waveform`: `0`=square, `1`=triangle, `2`=noise, `3`=sine.
- `SET_VOICE_GAIN voice` (u8 operand) — pops a value (sustained volume,
  roughly `0`-`1`) off the stack, sets it directly. For a held note or a
  drone; overrides any `TRIGGER_VOICE` decay still in flight on that
  voice.
- `TRIGGER_VOICE voice` (u8 operand) — no stack effect. Applies a fixed,
  engine-side decay envelope (not a duration operand — `SET_VOICE_GAIN`
  already covers a longer/sustained note, so a tunable percussive
  duration would be surface for a need that's already met) for a
  percussive hit: coin, jump, damage.

All four are silent no-ops (nothing thrown, nothing played) if the
runtime has no audio sink to route them through — same "always safe to
call" posture `PLAYSOUND` already has. See `hooks.md` for the
determinism caveat: sound logic is presentation-only, like `on_draw`, and
must never be the only place a cart reads shared RNG.

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
  Capped: if `globals` (fixed 96 bytes) plus every active entity's
  `props` (4 bytes/field) would cross 16KB, `SPAWN` is a graceful no-op
  instead — id `0` (never a real entity's id) is pushed, and no entity
  is actually created. Every `STOREE`/`LOADE` against an unmatched id
  already resolves to nothing (`findEntity` returns none), so a hook
  that spawns past the cap and then writes to the returned id just
  silently does nothing further — no crash, no `cartFault`. Worst
  observed peak across all 9 example carts under synthetic stress input
  is ~2.65KB, so this ceiling is real headroom, not a practical limit on
  ordinary play — see DESIGN.md §76.
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
  the only way a hook can change the map after `on_init`. Capped
  separately from `SPAWN`'s own budget (DESIGN.md §76): once a cart has
  called `SETTILE` 1024 times total in one session, further calls are a
  no-op — the live grid stops changing rather than drifting out of sync
  with the runtime's own bookkeeping of what's been mutated. Real usage
  across every shipped cart that calls `SETTILE` at all tops out at 16
  calls a full playthrough, so this is deep headroom, not a practical
  limit.

## Input

- `TESTBIT bitIndex` (u8 operand — a bit **index** 0-4 for the declared
  buttons, plus 5 for the reserved pointer-held bit below; not the bit
  *value*: index 0 = value 1/left, 1 = 2/right, 2 = 4/up, 3 = 8/down,
  4 = 16/action, 5 = 32/pointer-held) — pops a bitmask, pushes
  `(mask >> bitIndex) & 1`.
- `LOAD_INPUT slot` (u8 operand, 0-3) — pushes that player slot's current
  frame bitmask (no pop). Slot 0 is the local player; slots 1-3 are 0
  until filled by a remote peer. Combine with `TESTBIT`, or test/mask it
  directly. Bit index 5 (value 32) of a slot's mask is reserved for that
  player's pointer-held state — folded in here rather than as a separate
  per-player opcode, since it's conceptually just another button. That
  bit is deliberately outside the declared-button bits (0-4): those are
  which buttons a cart *authors and labels* via `inputActiveButtons`, an
  unrelated concept from "is this player's pointer currently held,"
  which is always-on infrastructure whenever `inputWantsPointer` is set.
- `LOAD_POINTER_X` / `LOAD_POINTER_Y` / `LOAD_POINTER_DOWN` — push the
  local pointer's current cart-space x/y or held state; always `0` unless
  the cart set `inputWantsPointer`. Single-player/local-only — unaffected
  by the multi-player opcodes above and below.
- `LOAD_POINTER_P slot axis` (two u8 operands: player slot 0-3, then
  axis 0=x/1=y) — the per-player counterpart to `LOAD_POINTER_X`/`Y`,
  mirroring the handle-plus-field shape `LOADE` uses for cross-entity
  prop reads. Always `0` for a slot with no pointer data yet (same
  fallback as `LOAD_POINTER_X`/`Y`). No per-player "down" variant — see
  bit 5 of `LOAD_INPUT` above.

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
