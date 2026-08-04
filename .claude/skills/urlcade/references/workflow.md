# Building, verifying, and shipping a cart

## The loop

1. Author a cart as a plain JS object (fields: `cart-object.md`; hook
   bytecode: `opcodes.md` + `hooks.md`).
2. Compile it: `await K.compileCartSource(cartSource)` →
   `{cart, bytes, fragment, name, author}`.
3. **Verify headlessly in Node before touching a browser** — see below.
   This is the fast loop; a browser is for final visual confirmation, not
   for catching logic bugs.
4. Play it at `<site>/#<fragment>`, or paste the fragment (or raw source)
   into the live site's Debug → Source tab, which recompiles on every
   keystroke and shows a specific, line-numbered error or a "Play this
   version" link.

## Minimal worked example

```js
const K = require('./kernel.js'); // or window.UrlcadeKernel in a browser

const GLOBALS = { g_box: 0 };
const cartSource = {
  name: 'Tiny', author: 'you',
  // These eight have no default (defaultCartFields doesn't set them) —
  // every other top-level field cart-object.md lists does, and can be
  // omitted for a first draft.
  formatVersion: 3, cartType: 0, rngSeed: 1, modeFlags: 0,
  screenW: 160, screenH: 160,
  backdropFillIndex: 0, backdropGroundHeight: 0, backdropGroundIndex: 0,
  inputActiveButtons: 1|2|4|8, inputTouchTemplate: 4, // DPAD_ONLY
  paletteParams: [200, 0, 30, 60, 20, 70, 20, 180], // baseHue, _, satMin, satMax, lightMin, lightMax, entityAHueHintByte, entityBHueHintByte
  entityTypes: [
    { renderKind: 0, assetIndex: 0, rotateFlag: 0, collisionW: 8, collisionH: 8, extFieldCount: 0 },
  ],
  sprites: [{ w: 8, h: 8, pixels: new Array(64).fill(9) }], // solid entity-A color
  globalNames: GLOBALS,
  hooks: {
    on_init: [
      'SPAWN 0', 'STOREG g_box',
      'PUSHI 80', 'STOREE g_box 0', // x
      'PUSHI 80', 'STOREE g_box 1', // y
      'HALT',
    ],
    on_tick: [ // runs once per active entity — self is the box here
      'LOAD_INPUT', 'TESTBIT 1', 'JZ done', // bit index 1 = right (value 2)
      'LOAD_SELF 0', 'PUSHI 1', 'ADD', 'STORE_SELF 0',
      'done:', 'HALT',
    ],
  },
};

const { fragment } = await K.compileCartSource(cartSource);
console.log(fragment); // "Tiny,you,z.<...>" or "r.<...>" if shorter uncompressed
```

Real carts keep a `CONST_NAMES`/`GLOBAL_NAMES` object per file (passed as
`constNames`/`globalNames` on the source, exactly like `GLOBALS` above)
so hook source reads `PUSHC TURN_SPEED` / `LOADG g_box` instead of bare
indices — purely an authoring convenience, stripped before encoding.

## Verifying headlessly (no browser)

Build a minimal synthetic `ctx` and call `runHook` directly against one
hook's bytecode — this is the fast, deterministic way to check logic,
including a hook's *worst case* opcode count against the `MAX_STEPS`
budget (build an adversarial `getTile`/entity state and confirm
`ctx.world.cartFault` stays `false`), before ever loading a page:

```js
const K = require('./kernel.js');
const cart = await K.compileCartSource(cartSource); // .cart is the decoded object

const ctx = {
  constants: cart.cart.constants,
  globals: new Array(24).fill(0),
  world: { cartFault: false, cart: cart.cart }, // .cart needed only if the hook uses MOVE_SOLID
  self: { id: 1, typeId: 0, active: true, props: [80, 80, 0, 0, 0, 0, 0, 1] },
  a: null, b: null, input: 2, // bit value 2 = right held
  findEntity: id => null,           // resolve LOADE/STOREE handle lookups
  getTile: (x, y) => 2,             // GETTILE / MOVE_SOLID's map query
  tileSurface: t => t,              // identity unless testing tileSurfaceOverrides
  setTile: () => {}, spawn: () => ({ id: 2, props: [] }),
  rng: Math.random, playSound: () => {}, getCheckpoint: () => ({ x: 0, y: 0 }),
  drawLine: (x1,y1,x2,y2,color) => {}, // only read from on_draw
};
K.runHook(cart.cart.hooks.on_tick, ctx);
console.log(ctx.self.props[0], ctx.world.cartFault); // 81 false
```

Only fill in the `ctx` fields the hook you're testing actually touches —
`runHook`'s own doc comment in `kernel.js` lists the true minimum shape.
For multi-tick gameplay (movement + collision + spawning over many
ticks), build a small `World`-alike that re-runs this same pattern in a
loop, snapshotting `prevProps` and resolving collisions the way
`hooks.md` describes `World.step()` doing it — there's no shortcut around
reimplementing that loop for a headless test, but it's a few dozen lines
once, reusable for every hook in the cart.

## Sharpest gotchas

- **Stack push order matters and is easy to get backwards.**
  `DRAW_LINE` wants `x1,y1,x2,y2,color` pushed in that order (color ends
  up on top); `GETTILE` wants `x,y`; `SETTILE` wants `x,y,tileId`. Get
  any of these backwards and you get a silently wrong draw or tile
  write, not an error.
- **`MOVE_SOLID` needs `tileSurfaceOverrides`.** Its solidity test
  defaults to "every tile id is solid" — a map generator's floor/stairs/
  gold tile ids all need an entry mapping them to `0`, or an entity can
  never move at all. See `cart-object.md`.
- **No `CALL`/`RET`.** Anything that needs to run more than once with
  different data — cast N rays, check N entities — either gets a real
  loop (a global counter + a label + `JNZ` back to the top) or gets
  authoring-time-unrolled into N copies. A loop is smaller compiled and
  costs a little more at runtime (counter bookkeeping is real dispatched
  opcodes); unrolling is the reverse. For anything beyond a handful of
  repetitions, prefer the loop — 40-plus unrolled copies of the same
  logic is both a large fragment and hard to keep correct by hand.
- **A `renderKind:2` entity that's supposed to paint the whole screen
  (a first-person view, a HUD overlay) usually shouldn't be the entity
  that's also moving around the world.** `DRAW_LINE` coordinates are
  entity-local, translated to screen space by adding the entity's own
  `props[0]`/`[1]` and then subtracting the camera offset — if that
  entity is also the thing walking around the map, its own local (0,0)
  drifts across the screen as it moves. Spawn a second, stationary
  entity at world `(0,0)` (with `camera.followGlobal: 255`, i.e. no
  camera) to do the drawing, reading whatever it needs from the moving
  entity via `LOADE`.
- **`MAX_STEPS = 20000` is per single hook call, not per frame or per
  tick.** `on_tick` fires once per entity — each entity's call gets its
  own fresh budget. `on_draw` fires once per `renderKind:2` entity per
  rendered frame — same. Measure a hook's *worst case* (the input/map
  state that makes it do the most work), not its typical case.
