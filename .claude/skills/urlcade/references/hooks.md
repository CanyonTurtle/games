# Hooks: the lifecycle VM

A cart's behavior is six independent bytecode blobs (`cart.hooks.on_*`),
each run through `runHook()` with a different `ctx` binding depending on
which hook it is. All six share the same opcode set (`opcodes.md`) and the
same per-call budget: **`MAX_STEPS = 20000`** dispatched instructions per
single `runHook()` invocation. Exceeding it sets `world.cartFault = true`
and the call returns early — there is no partial-credit recovery, so
budget headroom matters (see `workflow.md` for how to verify a hook stays
under budget in its worst case before shipping it).

| Hook | Runs | `self` | `a` / `b` |
|---|---|---|---|
| `on_init` | Once, at `World` construction | `null` | `null` |
| `on_input` | Once per simulation tick, before `on_frame` | `null` | `null` |
| `on_frame` | Once per simulation tick, after `on_input` | `null` | `null` |
| `on_tick` | Once per **active entity**, per simulation tick | that entity | `null` |
| `on_collide` | Once per **overlapping pair**, per simulation tick | `null` | the two entities (see below) |
| `on_draw` | Once per `renderKind:2` entity, per **rendered frame** | that entity | `null` |

## Simulation tick vs rendered frame

Everything except `on_draw` runs on a fixed 60Hz simulation clock
(`World.step()`), decoupled from the actual frame rate — a slow device
can render fewer frames than ticks (or vice versa; the runtime's loop
accumulates real elapsed time and runs as many fixed-size ticks as have
accumulated, then renders once). `on_draw` is the one exception: it runs
at *render* time, once per `renderKind:2` entity per frame actually
drawn — a hook that recomputes something every render call should expect
to be called more or less often than once per tick, not exactly once per
tick.

One `World.step()`, in order: snapshot every entity's current props (for
render interpolation) → `on_input` → `on_frame` → `on_tick` for every
active entity → collision detection (AABB overlap) → `on_collide` for
every overlapping pair found.

## `on_collide`'s pairing

Each overlapping pair fires **one** `on_collide` call, with `a`/`b` bound
in whatever order the entities happen to sit in the world's internal
list — not guaranteed to match spawn order, and never fired a second time
with `a`/`b` swapped. A hook that cares which of a pair is which (e.g.
"the player's hp drops, not the monster's") must check both
`(a.type==player && b.type==monster)` and
`(a.type==monster && b.type==player)` explicitly — see any shipped
cart's `on_collide` for the pattern (a pair of symmetric branches, each
ending in the same shared cleanup label).

## Entity props: what's reserved

Every entity has `9 + extFieldCount` numeric props. The runtime itself
reserves and auto-manages: `props[0]`/`[1]` (x/y — read by the renderer
and camera, written by whatever hook moves the entity), `props[4]`
(`typeId`, set once at spawn, never written by a hook), `props[7]` (its
own entity id, set once at spawn), and `props[8 + extFieldCount]` — one
slot past every ext field, this entity's current `assetIndex`, set at
spawn from `entityTypes[typeId].assetIndex` as a default, then read
every frame by the renderer instead of the type's; a hook is free to
overwrite it later (`STORE_SELF (8 + extFieldCount)`) to retarget just
this one entity's sprite/tile. That slot is placed *after* every ext
field rather than folded into the base eight on purpose — a base slot
that looks unused by a literal-text search can still be spoken for via
a named constant a cart defines itself (see `cart-object.md`'s note on
`doom-like.js`'s `ANGLEPROP`), so appending past whatever the author
declared is the only placement that can't collide with anything.
Everything else — `[2]`, `[3]`, `[5]`, `[6]`, and any ext slots from
`[8]` through `[7 + extFieldCount]` — is free for the cart to define
meaning for; see `cart-object.md`'s Entity state note for the informal
conventions (`[2]`/`[3]` as velocity when using `MOVE_SOLID`, `[5]` as hp) that
aren't runtime-enforced but every shipped cart follows.

## `on_draw` specifics

Bound entity must have `entityTypes[typeId].renderKind === 2`. Runs
*instead of* the sprite/tile-column renderer for that entity — nothing
else draws it. Presentation-only by convention: nothing stops `on_draw`
from writing to a global or a prop, but since it runs at render time
rather than on the fixed simulation clock, doing so makes the
simulation's behavior depend on the display's actual frame rate — reads
are fine, writes should happen in `on_tick`/`on_frame` instead. Typical
shape: a stationary entity (spawned once, never
moved) whose `on_draw` reads world state through globals/other entities'
props and emits a sequence of `DRAW_LINE` calls; see `workflow.md` for
why the entity issuing the draws usually shouldn't be the same entity
that's actually moving around the world (camera-offset math gets
involved otherwise). If a cart has more than one `renderKind:2` entity,
`on_draw` runs once per instance with a different `self` each time and
must itself branch on `self`'s `typeId`/props to know which one it's
drawing.

## `cartFault`

Once set, `world.cartFault` stays `true`; the runtime shows a fault
banner and the cart stops behaving normally. There is no automatic
recovery — a hook that might exceed budget in some reachable state
(a large loop bound, an unbounded search) needs its worst case measured
before shipping, not just its typical case.
