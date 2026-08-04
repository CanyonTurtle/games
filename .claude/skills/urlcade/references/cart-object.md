# The cart object

A cart is a plain JS object. `compileCartSource()` (in `kernel.js`) fills in
any field you omit via `defaultCartFields()`, assembles `hooks` if you gave
assembly-line arrays instead of `Uint8Array`, then calls `encodeCart()` and
round-trips it through `decodeCart()` to catch shape mistakes before you
ever see a fragment. `encodeCart`/`decodeCart` are themselves the ground
truth for every field below — read them directly in `kernel.js` if anything
here is ambiguous.

Two authoring-only fields never reach the binary format: `name` and
`author` (stripped by `compileCartSource`, carried instead as a plain-text
prefix on the URL fragment — see `binary-format.md`). Everything else below
is a real field written to bytes.

**No default, must be set**: `formatVersion`, `cartType`, `rngSeed`,
`modeFlags`, `screenW`, `screenH`, `paletteParams`,
`backdropFillIndex`/`backdropGroundHeight`/`backdropGroundIndex`,
`inputActiveButtons`, `inputTouchTemplate`, `hooks` (an empty `{}` is
fine — every field described below this line defaults via
`defaultCartFields()` if omitted: `tileSurfaceOverrides: {}`,
`camera: {followGlobal:255, ...}` (no scrolling), `aimLine: null`,
`hudSpec: []`, `constants: []`, `entityTypes: []`, `sprites: []`,
`tiles: []`, `mapGenerator: 0`, `inputButtonLabels: {}`,
`inputWantsPointer: false`.

## Header

| Field | Type | Notes |
|---|---|---|
| `formatVersion` | u8 | Must be `3` (the only version this kernel decodes). |
| `cartType` | u8 | Advisory/display metadata only — never a runtime dispatch key. |
| `rngSeed` | u8 | Seeds `World`'s PRNG (`mulberry32`). |
| `modeFlags` | u8 | Reserved for cart-specific mode bits; not interpreted by the runtime itself. |
| `screenW`, `screenH` | u16 each | Viewport size in pixels. Every shipped cart uses 160x160. |

## Palette — `paletteParams` (8 bytes)

`[baseHue, <unused>, satMin, satMax, lightMin, lightMax, entityAHueHintByte, entityBHueHintByte]`
— **all eight are raw bytes, 0-255** (the encoder writes them with the
same bounds-checked `u8()` as everything else). Two different readings
of "byte":
- `baseHue` is read as **degrees directly**, uncapped-but-unscaled — so a
  base hue is effectively limited to 0-255° of the 360° wheel (reds
  through most of blue/cyan; not magenta/violet). `satMin`/`satMax`/
  `lightMin`/`lightMax` are plain 0-100-ish percent values, also used
  as-is.
- `entityAHueHintByte`/`entityBHueHintByte` are **scaled to the full
  circle**: `hueHintToDegrees(byte) = byte * 360/256`, so any hue is
  reachable for an entity ramp even though `baseHue` itself can't reach
  the top ~100° of the wheel.

`generatePalette()` builds all 16 colors from this array — nothing else
about a cart affects color. Index 1 is a byte slot that exists in the
array but is never read.

- **Indices 0-7 (terrain ramp)**: hue drifts by ±8° around `baseHue` across
  the 8 steps (darkest/most-desaturated at index 0), saturation and
  lightness interpolate linearly between `satMin`/`satMax` and
  `lightMin`/`lightMax`.
- **Indices 8-11 (entity A ramp)** and **12-15 (entity B ramp)**: each
  ramp's hue is anchored by its own hue *hint* — `hueHintToDegrees(byte) =
  byte * 360/256` — clamped to at least 70° of circular hue distance from
  `baseHue`, and the two entity ramps are pushed at least 70° apart from
  each other too (`generatePalette` shifts B automatically if A and B's
  hints landed too close). Index 0 of each ramp (8 and 12) is a shared
  dark "ink" shade; indices 1-3 of each ramp (9-11, 13-15) get their own
  saturation/lightness curve, independent of the terrain's `satMin`/
  `satMax`/`lightMin`/`lightMax` (entity ramps always read as bright,
  saturated accents — see `ACCENT_SAT_MIN`/`ACCENT_LIGHT_MIN` etc. in
  `kernel.js` for the exact floors).

Every generated color is an `hsl(...)` CSS string, never hex.

## Backdrop

`backdropFillIndex`, `backdropGroundHeight`, `backdropGroundIndex` (all u8)
— a flat fill color plus an optional ground strip along the bottom
`backdropGroundHeight` pixels, both indexing into the palette. Only used
when the cart has **no** `mapGenerator` (0) — a cart with a generated map
draws that instead and these three fields are ignored.

## `tileSurfaceOverrides`

`{ [tileId]: surfaceValue }`. `MOVE_SOLID`'s and any cart bytecode calling
`TILE_SURFACE`'s solidity test is `tileSurface(tileId) !== 0`, and
`tileSurface` defaults to the *identity* function — every tile id is
"solid" unless overridden to `0`. Any non-wall tile id a map generator
produces (floor, stairs, gold, a start/finish line, ...) needs an entry
here mapping it to `0`, or `MOVE_SOLID` will treat it as an impassable
wall.

## Input

- `inputActiveButtons` (u8): bitmask over `BUTTON_BITS = [1,2,4,8,16]`
  (fixed meaning: 1=left, 2=right, 4=up/primary, 8=down/secondary,
  16=action — not genre-specific).
- `inputTouchTemplate` (u8): which on-screen touch layout to render —
  `TOUCH_TEMPLATE_NONE=0`, `SINGLE=1` (one wide button, the first active
  bit), `STEER_ACTION=2` (left/right + one action button on bit 4),
  `DPAD_ACTION=3` (left/right/up/down + one action button on bit 16),
  `DPAD_ONLY=4` (left/right/up/down, no action button).
- `inputButtonLabels`: `{ [bit]: "label text" }`, one entry per bit set in
  `inputActiveButtons` — shown on the matching touch button and used to
  build the keyboard-hint text.
- `inputWantsPointer` (bool): opts into `LOAD_POINTER_X`/`Y`/`DOWN`
  reading real values; `0`/unset otherwise regardless of what a hook does
  with those opcodes.

Keyboard is fixed and always active regardless of these fields: Arrow
keys = bits 1/2/4/8, Space = bit 16.

## `hudSpec` — array of HUD lines

Each entry: `{ kind, sourceKind, srcA, srcB, delta, suffixConstIdx, clamp, label }`.

- `sourceKind`: `0` reads `world.globals[srcA]` directly; `1` treats
  `globals[srcA]` as an entity handle (id) and reads that entity's
  `props[srcB]`.
- `kind`: `0` = numeric readout, always shown, as `"<label>: <value>"`
  (plus `" / <constants[suffixConstIdx]>"` if `suffixConstIdx !== 255`,
  and clamped to that constant first if `clamp` is truthy). `1` = flag
  line — shows just `label` whenever the read value is non-zero, nothing
  otherwise. `2` = numeric, shown only while non-zero, as
  `"<label><value>"` (no colon/space — the label is expected to include
  its own punctuation).
- `delta`: added to the raw value before display (any `kind`).
- `suffixConstIdx`: index into `constants` for a "`/ max`" suffix, or
  `255` for none.

## `constants` — array of f32

Read by `PUSHC <index>` in hook bytecode. No fixed layout — a cart defines
its own indices and typically keeps a `CONST_NAMES` name→index map in its
authoring source (not part of the binary format) so hook source can write
`PUSHC TURN_SPEED` instead of a bare number.

## `entityTypes` — array

Each: `{ renderKind, assetIndex, rotateFlag, collisionW, collisionH, extFieldCount }`
(all u8). `spawnEntity(typeId)` gives every instance `8 + extFieldCount`
props, auto-setting `props[4] = typeId` and `props[7] = ` its own id — see
`hooks.md` for the full prop layout.

- `renderKind`:
  - `0` — sprite. `assetIndex` indexes `sprites[]`. If `rotateFlag`,
    drawn rotated by `props[8]` (degrees, interpolated).
  - `1` — tile column. `assetIndex` and `assetIndex+1` index `tiles[]`
    (body tile, cap tile). `props[8]` = column height in tiles,
    `props[10] === 0` means the cap renders at the top row instead of the
    bottom.
  - `2` — custom draw. Runs the cart's single `on_draw` hook at render
    time with this entity bound as `self`; `assetIndex` is unused.
- `collisionW`/`collisionH`: full AABB width/height in pixels, centered
  on `props[0]`/`props[1]` (i.e. the box extends ±width/2, ±height/2).

## `sprites` — array

Each either raw pixels — `{ w, h, pixels: [...] }`, `w*h` palette indices,
row-major, index `0` transparent — or a shape list —
`{ kind: 1, w, h, shapes: [...] }`, each shape
`{ type: SHAPE_ELLIPSE(0) | SHAPE_RECT(1), cx,cy,rx,ry, color }` or
`{ type, x,y,w,h, color }`, all geometry fields in **1/8px fixed point**
(the encoder rounds `value*8` into a byte, so coordinates/radii are
limited to 0-31.875px in increments of 0.125px).

## `tiles` — array

Each `{ w, h, pixels: [...] }`, raw pixels only (no shape-list kind for
tiles). Never transparent — index `0` is an opaque color like any other.
A generated map's grid stores 1-based tile ids; `tiles[id-1]` is the
bitmap for grid value `id`.

## `mapGenerator` (u8) + its config block

`0` = none (the cart draws its own backdrop/entities on a blank
viewport). `1`/`2`/`3` select `track`/`cave`/`platform` respectively — see
`map-generators.md` for each config block's exact shape and token
vocabulary.

## `camera`

`{ followGlobal, clampMinX, clampMinY, clampMaxX, clampMaxY }`.
`followGlobal` is a global-slot index holding an entity id to center the
viewport on, or `255` for no camera (viewport stays pinned at world
`(0,0)` — the default, and required for any cart whose `on_draw` computes
its own absolute screen-pixel coordinates rather than expecting to be
scrolled). Center-on-entity math is
`clamp(entity.x - screenW/2, clampMinX, clampMaxX)` per axis.

## `aimLine` (optional, or `null`/omitted)

`{ anchorXGlobal, anchorYGlobal, angleGlobal, powerGlobal, maxPowerConstIdx, activeGlobal, colorIdx, maxLengthPx }`
— a power/angle indicator line the runtime draws itself (no `on_draw`
needed), visible whenever `globals[activeGlobal]` is non-zero, anchored at
`(globals[anchorXGlobal], globals[anchorYGlobal])`, rotated by
`-globals[angleGlobal]` degrees, length
`(globals[powerGlobal] / constants[maxPowerConstIdx]) * maxLengthPx`.

## `hooks`

`{ on_init, on_frame, on_tick, on_input, on_collide, on_draw }` — each
either an array of assembly-source lines or a pre-assembled `Uint8Array`.
A hook a cart doesn't use can be omitted entirely (compiles to a
zero-length bytecode array, a no-op). See `hooks.md` for what each one
does and when it runs, `opcodes.md` for the instruction set.
