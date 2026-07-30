# Three more dogfoods: roguelike, platformer, arena shooter

Lighter-weight than `flappy-bird.md` and `race-car.md` on purpose: those
two had to prove the whole format works at all (full byte tallies, full
per-hook bytecode listings). These three are chosen specifically to
stress the parts of the spec still thin after the composable-generator
pivot (`DESIGN.md` §15) — a genuinely different **map generator**
archetype, a **presentation** concept beyond backdrop/HUD/input, and
whether "generator" needs to keep growing new primitives or whether the
existing ones already generalize. Findings are folded into `DESIGN.md`
§16 (new section), with amendments to §7 and §15.

Design-level only in this doc — none of the three are wired up as
playable bytecode carts in `v0/urlcade.html` yet, unlike Flappy Bird and
the race car. That's a deliberate scope cut for this pass; see the repo
history if that changes.

## 1. Roguelike: cave crawler

Grid-locked dungeon crawl: player moves one tile per press, fights
wandering monsters by walking into them, collects gold tiles, finds the
stairs down. Chosen specifically because it's the canonical genre for
**stochastic** map generation (cellular automata / WFC), a different
archetype from the racer's **deterministic token-grammar** generator —
and because "move one tile per press" stresses the input model in a way
neither Flappy (continuous hold) nor the racer (continuous hold) does.

### New map generator: cellular-automata caves (`map_generator = 2`)

Parameters: `grid_w, grid_h, fill_prob (u8, 0-255), iterations (u8),
wall_threshold (u8)`.

Algorithm — standard "4-5 rule" CA cave generation:
1. Seed the grid: each cell is WALL with probability `fill_prob/255`,
   else FLOOR (using the cart's existing seeded RNG — no new RNG surface
   needed).
2. Repeat `iterations` times: a cell becomes WALL if its 8-neighbor wall
   count ≥ `wall_threshold`, else FLOOR. A handful of passes turns
   uniform noise into organic-looking cave rooms and corridors.
3. Flood-fill from an arbitrary floor cell; any floor tile *not* reached
   becomes WALL too (guarantees the whole map is one connected region —
   without this, CA generation reliably produces isolated unreachable
   pockets).
4. Place the player at the flood-fill's start cell; place stairs-down at
   whichever reached floor cell is *farthest* by BFS distance (the classic
   "put the exit far from the entrance" trick).

This is a real second map-generator archetype, not a variant of the
track grammar — validates that `map_generator` as a small integer id
selecting *any* algorithm (not just turtle-grammars) actually holds up.

### Finding: grid-locked movement doesn't need a new opcode

The instinct was "held-button semantics (`TESTBIT` read every frame)
won't work for move-one-tile-per-press" — true, but the fix needs
*nothing new*: store the previous frame's `LOAD_INPUT` result in a
global at the end of `on_input`, and at the start of the next tick
compare current vs. stored to detect a rising edge, e.g. (pseudo-bytecode):

```
LOAD_INPUT
LOADG g_prev_input
NOT_EQUAL_BIT_CHECK ; (TESTBIT both, compare) — expressible with
                     ; TESTBIT + CMPEQ + AND on existing opcodes
... move exactly one tile if newly pressed and target tile isn't solid ...
LOAD_INPUT
STOREG g_prev_input
```

No new VM surface required — this is an **authoring idiom**
("edge-detect via a stored previous-input global"), not a primitive gap.
Worth naming and documenting as a recommended pattern (§16), not worth a
new opcode.

### Finding: tile mutation needs a real gap filled — `SETTILE`

Gold pickup (walk onto a gold tile, it becomes floor, score increments)
needs the tilemap to change at runtime. The VM has `GETTILE` but never
got its write counterpart — an honest gap, not a deliberate omission.
Added to §7: `SETTILE` (pop `tileId, y, x` — same push-order convention
as `GETTILE` — write it into the tilemap).

### Finding: HP/damage needed nothing new

Monster contact damage is just `on_collide` reading/writing the
universal `hp` prop (index 5) on `a`/`b` — already fully generic, no new
mechanism. Good confirmation that the universal property set was sized
right the first time.

### Open, not resolved: fog of war

Roguelikes traditionally reveal only nearby tiles, with previously-seen
tiles remembered but dimmed. That's a real rendering concept this spec
has no answer for yet — a per-tile visibility state, and either a
runtime-computed radius or cart-maintained visibility bytecode. Deferred
rather than hastily resolved; see the open questions below.

## 2. Platformer: run and jump

Side-scrolling: gravity, jump, solid floors/walls/ceilings that actually
block movement (not just modify friction, unlike the racer's tracks),
coins, patrolling enemies, a level wider than the screen.

### Finding: solid-tile collision earns a real opcode — `MOVE_SOLID`

The racer's tiles are **soft** — `TILE_SURFACE` changes a friction
constant, entities pass through freely. A platformer's tiles are
**hard** — landing on a floor must stop downward velocity and snap to
the tile's top edge; hitting a wall must stop horizontal velocity at the
tile's edge. Hand-rolling axis-separated swept-AABB-vs-tile collision in
bytecode (check leading-edge tile per axis, resolve position, zero the
blocked velocity component) is boilerplate nearly every platformer (and
top-down zelda-like, and plenty of other genres) needs verbatim — exactly
the "expensive to re-derive per cart, cheap to ship once" case that
justified `SIN`/`COS`/`ATAN2` becoming opcodes instead of staying
hand-written. Proposed addition to §7: `MOVE_SOLID` — given `self`'s
current pos/vel/collision box, moves it against the tilemap one axis at
a time via `TILE_SURFACE`'s solid/non-solid distinction, resolving
position and zeroing blocked velocity components, all as one VM step.

### Finding: a real presentation gap — camera/viewport

A level wider than one screen needs a camera. Neither existing dogfood
needed one (Flappy fixes the bird's x; the racer renders the whole track
at once). This is a genuine fourth composable concept alongside
backdrop/HUD/input-layout (§15): a declared **camera** — which entity
(by global handle) it follows, and clamp bounds — with the renderer
offsetting all tile/entity drawing by the computed camera position.
Unlike backdrop/HUD/input, this one is genuinely new engine surface, not
just a data-driven version of something already implemented.

### Map generator: reuse, or a near-duplicate third one?

A platformer level (open path, elevation-change tokens, gaps) doesn't
fit the racer's track grammar's closed-loop assumption cleanly. Rather
than force a fit, this doc tentatively proposes a third id
(`map_generator = 3`, a linear turtle-grammar: platform segments, gap
tokens, step-up/step-down tokens) — while flagging plainly that #1 and
#3 are structurally very similar (both turtle-interpreted token
sequences) and might actually want to be **one** generator with a
declared topology flag (open path vs. closed loop) rather than two
near-duplicates. Left as an open question rather than resolved by fiat,
since resolving it well needs a third and fourth data point, not a
guess from two.

## 3. Arena shooter: wave survival

Top-down arena, player moves and fires in their facing/movement
direction, enemies spawn in escalating waves from the arena edges and
chase the player, projectiles kill enemies on contact, player has HP and
loses on depletion.

### Finding: no new "wave generator" needed — the countdown idiom generalizes

The instinct was "waves of enemies need a dedicated spawn-table
generator," symmetric with the racer's track grammar. It doesn't:
Flappy's pipe-spawn cadence (§12) was already exactly this pattern — a
global countdown decremented in `on_frame`, spawning and resetting at
zero. Wave escalation is the same idiom with two more globals
(`wave_index`, `enemies_left_in_wave`) and the spawn count/interval read
from the constant pool indexed by wave (or computed as
`base + growth * wave_index`). No new engine primitive earns its keep
here — a second confirmation (alongside the roguelike's edge-detection
finding) that a handful of orthogonal primitives, composed by the cart
author, covers more temporal-generation ground than it first appears to,
without the runtime needing a bespoke "wave generator" concept.

### Finding: projectiles needed nothing new either

A projectile is `SPAWN`'d on fire input, moves at a fixed velocity every
`on_tick`, and `KILL_SELF`s on going off-screen or in `on_collide` when
it hits an `ENEMY`. Structurally identical to the racer's collision
particles and Flappy's pipes — a third confirmation that the entity
system's generality (declared per-type extension fields, generic
`on_tick`/`on_collide`) was the right call, not something that needs
genre-specific entity machinery.

### Aiming, scoped down

Aim-at-nearest-enemy (reusing `ATAN2`, the same pattern as the racer's
AI steering) or fire-in-current-facing-direction both work with the
existing digital `button_mask` — no analog stick needed for this cart,
so it doesn't force the still-open "does input need an analog axis"
question (§16) to be resolved here.

## Summary: what this round of dogfooding actually settled

| Finding | Resolution |
|---|---|
| Stochastic (CA) map generation | Validated as a second `map_generator` archetype, not a special case |
| Grid-locked movement | No new opcode — an edge-detection *authoring idiom* using existing primitives |
| Runtime tile mutation | Real gap — `SETTILE` added to §7 |
| Solid-tile collision | Real gap — `MOVE_SOLID` proposed for §7 |
| Camera/viewport | Real gap — a genuinely new composable concept, added to §15 |
| Wave-based enemy spawning | No new generator — the countdown idiom from §12 generalizes |
| Projectiles | No new entity machinery — identical shape to pipes/particles |
| HP/damage | No new machinery — universal `hp` prop was already enough |

Two real primitive gaps found (`SETTILE`, `MOVE_SOLID`), one real new
composable concept (camera), and three confirmations that the existing
design already generalized further than expected. That ratio is worth
noting on its own: most of what three very different genres needed was
already there.
