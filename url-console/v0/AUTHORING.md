# Authoring a cart

A reference for building an Urlcade cart: a plain JS object describing a
game, turned into bytes by `kernel.js`'s `encodeCart`, then into a URL
fragment. This is current, current-only documentation, deliberately
scoped to just what building a cart needs — no project history here.

Everything below is verified against the actual runtime, not described
from memory: `kernel.js` is the single source of truth for the cart
format — the player runtime and its Debug view both load this exact
file, not a copy of it (see its own header comment) — and `fixtures.md`
has worked, byte-exact examples of the cart shape below going in and a
fragment string coming out. If this document and `kernel.js` ever
disagree, `kernel.js` is right.

**Fastest way to check a cart actually works:** open
[the live runtime](https://canyonturtle.github.io/games/) and click
**+ New Cart**, or **Debug** from any playing game. Paste the object
below (with your own hooks) into its Source tab — it compiles
automatically and the compile status block at the top of that same tab
shows a specific, line-numbered error the moment something's wrong (an
unknown opcode, a missing operand, a malformed field), or a working
Play link the moment it isn't. This works standalone too, from Node or
any script, via `K.compileCartSource(source)` (below) — the Source
tab's status block is a thin UI over exactly that function, nothing more.

## The pipeline

```
cart object (JS)  --encodeCart-->  bytes  --encodePayload-->  payload
     ^                                                            |
     +------------------ decodeCart <-- decodePayloadToBytes -----+

payload  --encodeCartUrl(name, author)-->  URL fragment
   ^                                             |
   +-------------- decodeCartUrl ----------------+
```

```js
const K = require('./kernel.js');
const bytes = K.encodeCart(myCart);            // -> Uint8Array
const payload = await K.encodePayload(bytes);  // -> "z.<base64url>" or "r.<base64url>"
const fragment = K.encodeCartUrl('My Game', 'Ada', payload); // -> "My%20Game,Ada,z.<base64url>"
// url: https://your-host/#<fragment>
```

`name`/`author` are plain, individually `encodeURIComponent`-encoded
text — not part of the binary cart at all, and never base64'd. Base64
buys no real compression on a short human-readable string, and leaving
them as readable text means a shared link's game name is visible in
the address bar without decoding anything. `encodeCartUrl` omits the
prefix entirely when both are empty, so it's fully backward-compatible
with a bare `z./r.` fragment from before this existed — `decodeCartUrl`
reads either shape, giving back `{name: '', author: '', payload}` for
the older, unprefixed kind. A comma is the (unambiguous) split point:
base64url's own alphabet never contains one, and `encodeURIComponent`
escapes any comma that shows up inside a name/author itself.

Paste that fragment (with or without a leading `#`) into the live
runtime's menu page "paste a cart link" box to play it, or set it as
the page's URL hash directly — any validly-encoded fragment plays, not
only the five shipped carts. Once it's playing, hit **Debug** to
inspect or edit it. There's no separate "compile" step beyond calling
`encodeCart` — the object below *is* the game.

`myCart.hooks[name]` above has to already be assembled bytecode
(`Uint8Array`) — `encodeCart` doesn't assemble source itself. If you'd
rather write `hooks.on_init` etc. as plain arrays of assembly-source
lines (like every example cart under `carts/*.js` does) and let one
call handle assembling every hook, encoding, round-trip-validating the
result, and building the final fragment (name/author included), use
`K.compileCartSource(source)` instead of calling
`assemble`/`encodeCart`/`encodePayload`/`encodeCartUrl` yourself. It's
`async` (it ends in `encodePayload`, which needs `CompressionStream`'s
async API):

```js
const { cart, bytes, fragment, name, author } = await K.compileCartSource({
  ...myCartFieldsAbove,
  name: 'My Game', author: 'Ada',   // optional — see the URL envelope above; never reach the binary format
  constNames: { GRAVITY: 0 },       // optional: name -> constants[] index, for PUSHC
  globalNames: { g_player: 0 },     // optional: name -> global slot, for LOADG/STOREG/LOADE/STOREE
  hooks: {
    on_init: ['PUSHC GRAVITY', 'STOREG g_player', 'HALT'],
    // ...
  },
});
```
Errors from `compileCartSource` always name which hook and which
source line is wrong — this is what the Debug view's Source tab calls
under the hood, on every edit.

## Cart object shape

```js
{
  name: '', author: '',    // optional — URL envelope only (see The pipeline above), never reach the binary format
  formatVersion: 1,        // bump only on a breaking binary-layout change
  cartType: 0,              // advisory label only (see "cartType" below) — never dispatched on
  paletteMode: 0,           // 0 = curated bank, 1 = procedural harmony (see Palette)
  rngSeed: 1,               // seeds the deterministic RNG used by RAND_RANGE and any generator
  modeFlags: 0,             // plain bitfield, meaning is entirely cart-defined (a good place for "hard mode" toggles a player can hand-edit)
  screenW: 160, screenH: 160,
  paletteParams: [/* 8 bytes, meaning depends on paletteMode */],

  backdropFillIndex: 0, backdropGroundHeight: 0, backdropGroundIndex: 0,
  tileSurfaceOverrides: {},  // { tileId: surfaceId } sparse remap, see Map generators

  inputActiveButtons: 0,     // bitmask of BUTTON_BITS this cart actually reads
  inputTouchTemplate: 0,     // which on-screen touch layout to show (see Input)
  inputButtonLabels: {},     // { buttonBit: "label text" } for each active bit

  hudSpec: [],               // ordered list of HUD readout lines (see HUD)
  constants: [],             // named-at-authoring-time f32 pool, PUSHC indexes into this
  entityTypes: [],           // per-type render/collision/ext-field declaration (see Entities)
  sprites: [],                // shape-list or raw-pixel art, indexed by entityTypes[].assetIndex
  tiles: [],                  // 8x8 raw-pixel tiles, indexed by the map generator's tokens

  mapGenerator: 0,            // 0 = none, 1 = track, 2 = cave, 3 = platform (see Map generators)
  track: undefined,           // present iff mapGenerator === 1
  cave: undefined,            // present iff mapGenerator === 2
  platform: undefined,        // present iff mapGenerator === 3

  camera: null,                // null = static viewport; or {followGlobal, clampMinX/Y, clampMaxX/Y}
  aimLine: null,                // null = no aim indicator; or {anchorXGlobal, anchorYGlobal, angleGlobal, powerGlobal, maxPowerConstIdx, activeGlobal, colorIdx, maxLengthPx}

  hooks: {},                    // { on_init, on_frame, on_tick, on_input, on_collide: Uint8Array }
}
```

`cartType` is a free-text-ish label (any 0-255 value) shown in the menu
UI and nothing else — the runtime never branches on it. What actually
determines a cart's behavior is which generators/fields it uses:
`mapGenerator`, whether `camera`/`aimLine` are present, `hooks`
contents, `entityTypes`. Two carts with the same `cartType` can be
completely different games; two carts with different `cartType` values
can share every mechanic. Treat it as a genre tag for humans browsing a
menu, not a format decision.

## Palette

16 colors total, indices 0-15.

- **`paletteMode: 0`** (curated): `paletteParams[0]` selects a
  hand-picked 16-color bank baked into the runtime (`CURATED_BANK`).
  Use this when procedural hue-rotation would put two things that need
  to read as distinct (e.g. a player and an enemy) on the same hue
  ramp.
- **`paletteMode: 1`** (procedural harmony): `paletteParams` is
  `[baseHue, <unused>, satMin, satMax, lightMin, lightMax, accentOffset, <unused>]`.
  Indices 0-7 are a ramp from `(satMin,lightMin)` to `(satMax,lightMax)`
  at `baseHue`; indices 8-15 are the same ramp at `baseHue +
  accentOffset` — a second hue for whatever needs to stand out against
  the first (player/target color, an accent UI element, etc).
  **`accentOffset` is stored as an unsigned byte (0-255)** — there is no
  way to express a negative hue shift; only positive offsets from
  `baseHue` are reachable. Render the palette (the Debug view's Assets
  tab, or `generatePalette(cart)` directly) before committing to a hue
  — a chosen offset can land somewhere unexpected.

## Backdrop

Only matters when `mapGenerator` doesn't already cover the whole
frame (e.g. Flappy Bird's endless-scroller cart_type has no map
generator at all). `backdropFillIndex` is a palette index painted as
the full-frame background; `backdropGroundHeight`/`backdropGroundIndex`
optionally paint a solid strip of that height, in that color, along
the bottom edge. Set all three to 0 when a map generator already fills
the frame — they're simply unused then, not a conflict.

## Input

`inputActiveButtons` is a bitmask over the five fixed, universal button
bits — this convention is genre-independent, not something a cart
redefines:

| bit | meaning (by convention — hooks can treat it as anything) |
|---|---|
| 1 | left |
| 2 | right |
| 4 | up / primary |
| 8 | down / secondary |
| 16 | action |

`inputButtonLabels[bit]` is the on-screen text for each active bit
(e.g. `{1:'Angle -', 2:'Angle +', 4:'Charge/Fire'}`). `inputTouchTemplate`
picks which on-screen touch control shape to render:

| value | name | shape |
|---|---|---|
| 0 | `TOUCH_TEMPLATE_NONE` | no on-screen controls (keyboard only) |
| 1 | `TOUCH_TEMPLATE_SINGLE` | one button |
| 2 | `TOUCH_TEMPLATE_STEER_ACTION` | left/right + one action button |
| 3 | `TOUCH_TEMPLATE_DPAD_ACTION` | 4-way d-pad + one action button |
| 4 | `TOUCH_TEMPLATE_DPAD_ONLY` | 4-way d-pad, no action button |

Read `LOAD_INPUT`/`TESTBIT` (below) inside hooks to react to held
buttons; the runtime doesn't interpret button meaning beyond delivering
the raw bitmask.

## HUD

`hudSpec` is an ordered list of readout lines, each:

```js
{ kind, sourceKind, srcA, srcB, delta, suffixConstIdx, clamp, label }
```

- `sourceKind`: `0` = read `globals[srcA]`; `1` = read prop `srcB` off
  the entity whose id is stored in `globals[srcA]` (an indirect
  "entity handle" pattern used throughout the runtime, not just here).
- `kind`: `0` = numeric, always shown (`label: value`); `1` = flag —
  shows just `label`, only while the source is non-zero; `2` = numeric,
  shown only while the source is non-zero.
- `delta`: added to the raw value before display (e.g. showing a
  0-indexed level counter as 1-indexed).
- `suffixConstIdx`: `255` = none; otherwise appends `/ constants[idx]`
  (rounded) — e.g. `HP: 4 / 6`. If `clamp` is also set, the displayed
  value itself is capped to that constant, not just the suffix shown.

## Constants

`constants` is an f32 array, referenced from hook bytecode via `PUSHC
<index>` (see Hooks). Give each index a name at authoring time (a
plain JS object mapping name → index, passed as `sym.constants` to
`assemble()`) — the bytecode itself only stores the resolved index, so
the name exists purely to make your own assembly source readable.

## Entity types & the universal prop layout

`entityTypes[i]` declares one spawnable kind:

```js
{ renderKind, assetIndex, rotateFlag, collisionW, collisionH, extFieldCount }
```

- `renderKind`: `0` = blit `sprites[assetIndex]`; `1` = draw a
  repeated vertical run of `tiles[assetIndex]` (body) and
  `tiles[assetIndex+1]` (the end cap) — this is how Flappy Bird's
  pipes render at a runtime-determined height without a per-height
  sprite. Unlike other ext fields, these two are runtime-read, not
  free-form: ext field **8** is the run length in tiles, and ext field
  **10** is which end gets the cap (`0` = cap at the top of the run,
  non-zero = cap at the bottom — e.g. a pipe hanging from the ceiling
  needs its cap facing down).
- `rotateFlag`: if set, the sprite is rotated by ext field 8 (in
  degrees) around its own center at render time (the racer's car
  heading is the reference use).
- `collisionW`/`collisionH`: AABB size in pixels, for `renderKind: 0`
  centered on `(pos_x, pos_y)`. **For `renderKind: 1`, both are
  ignored entirely** — the collision box is always a fixed 8px-wide
  column, `extent*8` px tall (extent = ext field 8), and — unlike
  every other entity — anchored at `(pos_x, pos_y)` as its **top-left**
  corner, not its center. Mixing the two positioning conventions in
  the same hook (e.g. copying a centered-entity's spawn code for a
  tile-column type) silently misplaces it by half its own size.
- `extFieldCount`: how many extra per-entity fields beyond the 8
  universal ones (below) this type gets. Meaning of each ext field
  (index 8, 9, 10, ...) is entirely up to your own hooks —
  it's scratch space, not a schema.

Every spawned entity gets a fixed-shape `props` array, `8 +
extFieldCount` long. Indices 0-7 are universal — every hook/opcode
that reads "an entity's position" or "an entity's type" means these,
regardless of cart:

| index | meaning | set by |
|---|---|---|
| 0 | `pos_x` | you (spawn/tick hooks), or `MOVE_SOLID` |
| 1 | `pos_y` | you, or `MOVE_SOLID` |
| 2 | `vel_x` | you |
| 3 | `vel_y` | you, or `MOVE_SOLID` (zeroed on collision) |
| 4 | `type` | the runtime, at spawn (`entityTypes` index) — read-only in practice |
| 5 | `hp` | you — no built-in meaning, but every shipped cart uses it for "hit points/state," and `KILL_SELF` doesn't check it automatically: your own `on_tick` has to |
| 6 | *(reserved)* | unused by every currently shipped cart — free for your own convention |
| 7 | `id` | the runtime, at spawn — matches the value `SPAWN` pushes and what `LOADE`/`STOREE`'s "handle" indirection looks up |
| 8+ | ext fields | you, entirely — count declared by `extFieldCount` |

Index 4 (`type`) is how `on_tick`/`on_collide` dispatch by kind when
one hook handles several entity types (`LOAD_SELF 4; PUSHI <n>;
CMPEQ; JNZ ...`) — see any shipped cart's `on_tick` for the pattern.

## Sprites & tiles

`sprites[i]` is either:
- **`kind: 1`** (shape-list): `{kind:1, w, h, shapes:[...]}`, each shape
  `{type: SHAPE_ELLIPSE|SHAPE_RECT, ...its own x/y/w/h or cx/cy/rx/ry, color}`
  — coordinates in pixels (1/8px fixed-point internally, so fractional
  positions like `x:2.5` round-trip exactly). The runtime paints these
  into a raster at load time; this is 5-10x smaller than raw pixels for
  simple geometric/blobby art and is what every shipped cart uses.
- **`kind: 0`** (raw): `{kind:0, w, h, pixels:[...]}`, one palette
  index per pixel, `w*h` long — the general escape hatch for bespoke
  art the shape-list can't express.

`tiles[i]` are always raw 8x8 pixel arrays (palette indices), used by
map generators and `renderKind: 1` tile-column entities.

## Map generators

`mapGenerator` selects which (if any) procedural level generator
populates the tilemap; `tileSurfaceOverrides` (a sparse `{tileId:
surfaceId}` map) lets a cart's own tile art mean something different
by the same numeric id than another cart's does — `TILE_SURFACE`
consults this before falling back to "tile id == surface id."

**1 — track** (`cart.track = {tokens, trackWidth, segLen, startGX,
startGY, startDir, gridW, gridH}`): a turtle-grammar walk. Unlike
platform tokens (below), track tokens carry **no per-token operand** —
`tokens` is a flat array of bare ids, and step size comes from the
cart-level `segLen`/`trackWidth` fields instead:

| token | id | meaning |
|---|---|---|
| `STRAIGHT` | 0 | advance `segLen` grid cells forward, stamping a `trackWidth`-wide road each cell |
| `CURVE_R90` | 1 | turn 90° right in place (one grid cell), stamping a `trackWidth`-square area at the corner |
| `CURVE_L90` | 2 | turn 90° left in place, same stamp as `CURVE_R90` |
| `START_FINISH` | 3 | stamp a start/finish line at the current position and push a lap checkpoint — does not advance position |
| `CHECKPOINT` | 4 | stamp + push a plain lap checkpoint, same as `START_FINISH` minus the finish-line semantics — does not advance position |

**2 — cave** (`cart.cave = {gridW, gridH, fillProb, iterations,
wallThreshold, goldCount}`): cellular automata. `fillProb` (0-255) is
the initial per-cell chance of a wall; `iterations` smoothing passes
run a 3x3-neighbor-count rule (`wallThreshold` neighbors-or-more →
wall); the border is always forced solid. The generator flood-fills
from a floor cell to guarantee full connectivity and places the exit
at the most distant reachable point by construction — there's no
"unreachable stairs" failure mode to defend against.

**3 — platform** (`cart.platform = {gridH, startGroundY, minGroundY,
maxGroundY, tokens}`): a heightmap turtle-grammar walk, shared between
the platformer and the destruction (physics-crusher) genre. Tokens:

| token | id | operand | meaning |
|---|---|---|---|
| `FLAT` | 0 | width | flat ground for `width` columns |
| `STEP_UP` | 1 | width | raise ground one row, then flat for `width` |
| `STEP_DOWN` | 2 | width | lower ground one row, then flat for `width` |
| `GAP` | 3 | width | a pit (safety net below, not a death plane) |
| `BLOCK` | 4 | width | an overhead obstacle above normal ground |
| `COIN` | 5 | — | a coin checkpoint 3 rows above current ground, at the current column |
| `ENEMY` | 6 | — | an enemy checkpoint 1 row above current ground, at the current column |
| `COIN_AT` | 7 | row offset | a coin checkpoint `offset` rows above ground, **same column as the previous token** (doesn't advance the walk — stack several of these to place things at different heights in one column) |
| `ENEMY_AT` | 8 | row offset | same as `COIN_AT`, for enemy checkpoints |

`COIN`/`ENEMY`/`COIN_AT`/`ENEMY_AT` produce **checkpoints**, not tiles
or entities directly — your `on_init` hook reads them via
`GET_CHECKPOINT` and decides what to spawn there (this is how the same
generator backs both "coins to collect" and "blocks to destroy," just
by what the cart's own hooks do with the checkpoint list). Checkpoint
0 is always the player/anchor start position; coin-type checkpoints
follow, then enemy-type checkpoints.

Terrain elevation (`STEP_UP`/`STEP_DOWN`) is a real, physical wall to
anything using `MOVE_SOLID` — before placing an elevation change,
confirm nothing that must be reachable from a fixed starting point sits
behind one at a height a jump/shot can't clear. This has been a repeat
source of "structurally unreachable" bugs across shipped carts, always
fixed the same way: keep terrain flat and put height variety in
checkpoints/entities instead, which physically pass through each other
and can't wall anything off. Verify reachability the same way the
shipped carts do — a scripted sweep across the actual angle/power (or
jump-timing) space against a fresh `World`, checking every checkpoint
actually gets touched — rather than trusting a level looks fine.

## Camera

`null`/absent = static viewport, whole map always visible. Otherwise
`{followGlobal, clampMinX, clampMinY, clampMaxX, clampMaxY}`:
`followGlobal` names a global holding an entity id (typically the
player's, stored there at spawn) to keep centered, clamped to the
given pixel bounds so the camera never shows past the map edge.

## Aim line

`null`/absent = no aim indicator drawn. Otherwise
`{anchorXGlobal, anchorYGlobal, angleGlobal, powerGlobal, maxPowerConstIdx, activeGlobal, colorIdx, maxLengthPx}`
draws a line from `(globals[anchorXGlobal], globals[anchorYGlobal])`,
at `-globals[angleGlobal]` degrees, scaled from 0 to `maxLengthPx` as
`globals[powerGlobal]` goes from 0 to `constants[maxPowerConstIdx]` —
visible only while `globals[activeGlobal]` is non-zero. The angle
convention matches `cos(a)*power, -sin(a)*power` launch-velocity math
exactly, so the line always points where a shot fired *right now*
would actually go — match your own launch formula to that convention
or the line will visibly lie.

## Hooks: the lifecycle VM

Five fixed entry points, each independently optional (an empty/absent
hook is a no-op):

| hook | called | `self`/`a`/`b` bound |
|---|---|---|
| `on_init` | once, at cart load | none |
| `on_frame` | once per simulation tick, globally | none |
| `on_tick` | once per **active entity**, per tick | `self` = that entity |
| `on_input` | once per tick, before `on_tick` | none |
| `on_collide` | once per **overlapping entity pair**, per tick | `a`, `b` = the pair (ordered by spawn order — either could be either type) |

Compile mnemonic source (one instruction per line, whitespace-separated
operands, `label:` lines for jump targets, `;` for comments) with
`assemble(lines, {constants, globals})` — `constants`/`globals` are
plain `{name: index}` maps you define, used to resolve `PUSHC name`,
`LOADG name`/`STOREG name`, and the *first* operand of `LOADE name
prop`/`STOREE name prop` to their numeric index at assembly time; raw
numeric operands work too everywhere (`PUSHC 3`, `LOADE 3 0`).

**Stack discipline that trips people up**: binary ops pop the *second*
operand first — `CMPLT`/`SUB`/`MOD`/etc. compute `a OP b` where `a` was
pushed first (deeper) and `b` second (top). `GETTILE` expects
`x` pushed then `y` (`y` on top); `SETTILE` expects `x, y, tileId` (in
that push order, `tileId` on top); `GET_CHECKPOINT` pushes `x` then
`y` (`y` ends up on top). Get this backwards and comparisons silently
evaluate the wrong direction rather than erroring — write a quick
`runHook` test (see `fixtures.md`'s example) against known globals
before trusting a comparison you can't otherwise observe.

**Opcode groups** (full table: `kernel.js`'s `OPS` array, index = byte
value):

- **Stack/const**: `NOP DUP POP SWAP PUSHI <i16> PUSHC <constIdx>`
- **Arithmetic**: `ADD SUB MUL DIV MOD NEG`
- **Compare/logic**: `CMPEQ CMPNE CMPLT CMPLE CMPGT CMPGE AND OR NOT`
- **Control flow**: `JMP JZ JNZ <label>`, `HALT` (also implicit at
  bytecode end)
- **Entity props**: `LOAD_SELF/STORE_SELF <idx>`,
  `LOAD_A/STORE_A <idx>`, `LOAD_B/STORE_B <idx>` (indices are the
  universal-prop-layout table above, or your own ext fields)
- **Globals & indirection**: `LOADG/STOREG <idx>`,
  `LOADE/STOREE <globalIdx>,<propIdx>` (read/write a prop on the
  entity whose id lives in that global — the "entity handle" pattern
  HUD/hooks both use to reach an entity that's neither `self` nor `a`/`b`)
- **Spawn/lifecycle**: `SPAWN <typeIdx>` (pushes the new entity's id),
  `KILL_SELF` (defer actual removal — see the deferred-kill pattern
  below)
- **Map/world**: `GETTILE`, `TILE_SURFACE`, `SETTILE`, `GET_CHECKPOINT`,
  `MOVE_SOLID` (axis-separated AABB-vs-tilemap collision for `self`,
  using its `entityTypes` collision size — the one opcode that moves
  an entity *and* resolves collision in one step, used by every
  gravity-driven entity in every shipped cart)
- **Math helpers**: `SIN COS ATAN2 RAND_RANGE DIST CLAMP_ABS LERP
  NORM_ANGLE`
- **Input**: `LOAD_INPUT` (raw button bitmask), `TESTBIT <bit>`
  (extract one bit as 0/1)
- **Misc**: `PLAYSOUND <id>`

**Deferred-kill pattern**: `on_collide` should only ever adjust `hp`
(or similar state), never call `KILL_SELF` directly on either
participant. Let each entity's own `on_tick` check `hp <= 0` and call
`KILL_SELF` on itself, next tick. Killing directly inside
`on_collide` corrupts the current collision pass (other pairs
involving the same entity may already be queued this tick) — this
pattern is used by every shipped cart with destructible entities.

## Checking your work

- **[The live runtime](https://canyonturtle.github.io/games/)**: click
  **+ New Cart** (or **Debug** from any playing game) and paste/edit a
  cart source object in the Source tab — the compile status block above
  the textarea shows a specific error, or byte/fragment size info and a
  "Play this version" button, automatically as you type. No
  copy-pasting between a script and the runtime, and the Assets tab
  (palette, sprites, tiles) and Logic tab (overview, map, entities, a
  disassembly + control-flow graph of every hook) both update live off
  the same edit — including cart_type/mapGenerator/hook combinations
  this guide didn't spell out.
- **`fixtures.md`**: known-good cart → bytes → fragment examples,
  including one that runs a real hook through `runHook` and shows the
  resulting globals — check any of the above against these without
  running anything.
- **The five shipped carts**: `carts/flappy-bird.js`, `carts/race-car.js`,
  `carts/cave-crawler.js`, `carts/run-and-jump.js`, and
  `carts/castle-crusher.js` (each exporting one `build*Cart()` function)
  are complete, real, working examples of every generator and hook
  pattern above, in combination — richer worked examples than any prose
  walkthrough. `carts/shared-sprites.js` has the small blob-silhouette
  helpers more than one of them reuses.
