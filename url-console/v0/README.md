# V0 — a real, working Urlcade

`urlcade.html` is a single self-contained page: the runtime (VM,
assembler, palette generator, track-grammar interpreter, renderer) and
both dogfood carts (`../examples/flappy-bird.md`,
`../examples/race-car.md`) built and playable in one file. Open it
directly in a browser — no build step, no server.

Both carts are authored once, assembled to real bytecode, **encoded to
bytes, base64url'd into the URL fragment, and then the runtime decodes
that exact fragment back into the cart it actually runs** — the
in-memory authoring object is never used to play the game, only the
round-tripped one. That's the load-bearing claim of the whole project
and it's exercised on every play, not just asserted.

## What's real here

- The stack-machine VM from `DESIGN.md` §7: ~50 opcodes, `LOADE`/`STOREE`
  for arbitrary-entity access, `SIN`/`COS`/`ATAN2`, per-entity `on_tick`
  vs global `on_frame`, a hard step budget with a visible fault state.
- A working two-pass assembler: mnemonic source with labels and named
  constants/globals compiles to the same bytecode format the VM
  executes — this is genuinely how both carts were authored, not
  hand-computed bytes.
- Procedural palette generation (color-theory harmony ramps) and a
  curated bank, both driving real rendering.
- The track-piece grammar turtle-interpreting a token sequence into a
  tile grid + checkpoint table at load time.
- Per-type declared entity fields (not a fixed generic scratch count).
- **Fixed-timestep simulation decoupled from the display, with render
  interpolation** (`DESIGN.md` §8): the sim now runs a real 60Hz clock via
  an accumulator (any number of ticks per rendered frame, to catch up if
  one ran long) instead of the original "step once if 33ms elapsed, else
  redraw the same positions" — measured before the fix, ~63% of rendered
  frames were pixel-identical to the previous one. Rendering interpolates
  each entity's position/heading between its last two tick states; the
  actual simulation state (what collisions and scoring see) is always the
  fixed-tick value, so this is purely cosmetic. Per-tick constants
  (gravity, accel, friction, turn rate, spawn/particle timers) were
  rescaled to match, so gameplay pacing is the same as before — only the
  smoothness changed, not the speed.
- **Composable generators, not a genre switch** (`DESIGN.md` §14): the
  backdrop, HUD, and touch-control layout are each declared by the cart
  and interpreted generically by the runtime — nothing in `render()` or
  the touch-control builder branches on which cart, or even which
  `cart_type`, is loaded. `cart_type` is advisory display metadata only.
  This replaced a real regression a first pass introduced (a touch-layout
  lookup table keyed by the cart's literal name, and HUD/backdrop code
  branching on `cart_type` then reaching into cart-specific global
  indices) — see §14 for the postmortem.
- **A WebGL renderer, with the original Canvas2D renderer kept as the
  fallback.** Both backends draw from the exact same source: the
  palette-built sprite/tile bitmaps (`buildBitmap`) are either blitted
  directly (Canvas2D) or uploaded once as GL textures (WebGL) — no
  duplicated pixel-building logic. The GL path samples with `NEAREST`
  filtering and cuts out transparency via alpha-discard in the fragment
  shader, so rotated sprites (the car) stay crisp at any heading —
  `ctx.rotate()` + `drawImage()` in Canvas2D always anti-aliases a
  rotated sprite's edges; there's no way to ask it not to. WebGL is
  attempted first (`canvas.getContext('webgl2')`, falling back to
  `'webgl'`); Canvas2D is used only if both fail, verified by forcing
  that failure in a test rather than assuming the fallback path works.
  A lost GL context is *not* recovered (would need swapping in a fresh
  canvas element, since a canvas can't change context type once one's
  been requested) — logged loudly rather than silently left blank.
- **Edge-to-edge game screens.** The canvas is `position:absolute;
  inset:0` with `object-fit:contain` — no bezel, border, or padding box
  around it; it fills the viewport (letterboxed only as much as the
  cart's own aspect ratio genuinely requires). The back button, HUD,
  controls hint, and touch controls all became floating overlays with a
  gradient scrim instead of occupying their own layout rows that used to
  shrink the canvas to make room.
- **A reported touch-triggered stutter in Flappy Bird** led to an
  investigation, not a guess: instrumenting frame timing showed the
  fixed-timestep accumulator occasionally runs 2 simulation steps in one
  rendered frame, continuously, unrelated to touch (expected — no display
  refreshes at exactly 60.000Hz, interpolation is supposed to make this
  invisible) — so a touch-specific stall has to come from real touch-event/
  compositor overhead a headless test can't reproduce. Couldn't confirm the
  exact cause conclusively, but found and removed one legitimate, real
  cost along the way (`backdrop-filter: blur()` on the back button — an
  expensive re-sample of a canvas that's redrawing every frame behind it),
  and tightened the accumulator's catch-up cap so *any* main-thread hiccup
  corrects by a little on the next frame instead of a lot (smoothness over
  perfect real-time accuracy after a stall).

  The stutter persisted, prompting a specific follow-up hypothesis: is
  running the `on_input` hook on touch actually expensive? Measured
  directly rather than reasoned about — `on_input` costs ~1 microsecond
  per call, a full `world.step()` ~2-5 microseconds, both 3-4 orders of
  magnitude too small to explain a dropped ~16.7ms frame, and a
  higher-fidelity touch simulation (Chromium's real touch-input dispatch,
  not just synthetic DOM events) still showed zero frame-timing anomaly
  around the touch. That rules the hook out with numbers, not a guess.
  Found and fixed a real (if unconfirmed-as-root-cause) source of GC
  pressure while measuring it, though: every hook call was allocating a
  fresh context object (`Object.assign`-ing ~10 unchanging fields plus
  self/a/b/input) and a fresh VM operand-stack array — up to ~7 times a
  tick at 60 ticks/sec. Both are now reused and mutated in place instead
  (safe: hook execution is synchronous and never re-entrant), which
  measurably roughly halved per-step cost in the same benchmark. Whether
  that's enough to resolve a stutter that only reproduces on a real
  touchscreen remains to be seen.

  Third hypothesis, and this one found a real, concrete gap rather than
  ruling something out: taps occasionally "refocusing" the HUD text at
  the top of the screen, triggering native text selection (and its
  magnifier-loupe / copy-callout UI) that burns real main-thread time —
  a well-known mobile-web jank source when a tappable area overlaps
  unprotected text. Checked, and confirmed: `user-select:none` was only
  ever applied to the canvas and the touch buttons, never to the HUD,
  controls hint, fault banner, or topbar text. `pointer-events:none` on
  their containers *should* already keep taps from reaching them, but
  that guarantee is inconsistently enforced across mobile browsers
  specifically for native text-selection gestures — belt and suspenders,
  not relying on pointer-events alone. Fixed by setting `user-select:
  none` (plus `-webkit-touch-callout:none`) once on `#gameWrap`, which
  every overlay text node inherits — verified via computed style that
  all five (HUD, controls, topbar, back button, fault banner) actually
  pick it up now.

  Fourth hypothesis: is the O(n²) pairwise collision scan expensive?
  Measured directly, at the actual entity counts either cart reaches
  (~10): a few microseconds, negligible — but the measurement surfaced
  a real inefficiency anyway. `getBox()` allocated a fresh object *every
  call*, and the old `overlap()`-per-pair pattern called it twice per
  pair — recomputing and reallocating the *same* entity's box once for
  every other entity it was checked against (O(n²) allocations for
  what only needs O(n)). Confirmed the quadratic blowup is real at
  artificial entity counts (100 entities: ~135us; still small in
  absolute terms, but the trend is unmistakable) — replaced it with
  `getBoxInto()`, computing each entity's box once per tick into a
  reused pool, so the O(n²) part left is just four numeric comparisons,
  no allocation. This refactor briefly broke collision detection outright
  (an entity spawned mid-collision-pass, which the racer's particles do,
  grew `entities.length` past the pool's pre-sized length) — caught by
  the regression suite, not shipped broken, and fixed by capturing the
  entity count once at the top of the pass rather than letting it grow
  underneath a fixed-size pool. Stress-tested afterward by pinning all
  three cars on top of each other for 8000 ticks (constant collisions,
  entity count peaking at 63): no crash, no fault.

These are scope cuts to get something working, not spec revisions.
Each one is a reasonable next step, not a design admission of defeat:

- **Byte-aligned, not bit-packed.** Every header field, constant, and
  pixel is a whole byte. The spec's nibble-level packing (4-bit
  opcodes, 4-bit track tokens, 2bpp sprites) would cut these carts
  roughly in half again, but byte alignment removes an entire class of
  off-by-one bit-math bugs for a first working version. Concretely:
  Flappy Bird is ~650 raw bytes here vs. the ~167-byte estimate in
  `examples/flappy-bird.md`; the race car is ~1060 vs. ~305 (both grew a
  bit further once backdrop/HUD/input became declared cart data instead
  of runtime code — that's the cost of genericity, paid once per cart).
  Both still fit inside the "full" (≤2000 char) size class uncompressed.
- **HUD/button label strings are ASCII, one byte per character.** A
  non-ASCII character (an em dash, in an earlier draft of the crash
  message) silently truncates on encode. Full Unicode support would need
  a real text encoding in the string format, not a bigger scope cut.
- **No compression.** The preset-dictionary compressor from §3 isn't
  implemented — every cart ships as `u1r` (raw) in spec terms. Adding
  it would shrink both further without changing anything else here.
- **Floats, not fixed-point.** Physics and trig use JS doubles. Good
  enough for a same-session demo; the spec's concern about
  cross-browser float determinism (for byte-identical replays shared
  between different browsers) is real but out of scope for V0.
- **`on_timer` folded into `on_frame`.** Flappy's pipe-spawn cadence is
  a plain countdown global decremented each frame rather than a
  dedicated timer hook/opcode.
- **Digital input only**, exactly as `DESIGN.md` assumed — no analog
  steering. Both keyboard (arrows/space) and on-screen touch buttons
  drive the same held-bit `button_mask`, so a "hold" on a touch button
  behaves identically to holding down a key — mobile isn't a second,
  differently-behaved input path.
- **Racer track pieces are cardinal-only** (straight, 90° turns,
  start/finish, checkpoint). The 45°-curve and chicane pieces from
  `examples/race-car.md` aren't implemented; the interpreter would
  need diagonal tile rasterization to support them.
- **No camera/scrolling.** Flappy fixes the bird's x position and
  scrolls pipes through a static frame; the racer renders the entire
  track at once. Both sidestep needing a camera system.
- **Two entity types per cart.** Enough to exercise the per-type
  extension-field mechanism, not an exhaustive catalog.

## Three more dogfoods, design-level only

`../examples/three-more-carts.md` sketches a roguelike, a platformer, and
an arena shooter — chosen to pressure-test the composable-generator model
(`DESIGN.md` §14) with a genuinely different map-generator archetype
(cellular-automata caves) and to check whether "generator" needed to keep
growing new primitives or whether the existing ones already generalized.
None of the three are wired up as playable carts here, unlike Flappy Bird
and the race car — a deliberate scope cut given the size of this pass
(three new games plus the WebGL renderer plus the layout change was too
much to also implement reliably in one go), not an oversight. Findings
(two real primitive gaps — `SETTILE`, `MOVE_SOLID` — one real new
composable concept — camera/viewport — and three confirmations that
existing machinery already covered enough ground) are folded into
`DESIGN.md` §15.

## Playing it

Open `urlcade.html`. The landing page is a shelf of cart cards, each
with its own accent color pulled from that cart's own generated
palette, a byte/char tally, and a collapsible view of the exact
fragment payload. Clicking **Play** sets `location.hash` to that
payload; the runtime's `boot()` reads the hash on load *and* on
`hashchange`, so pasting a cart's URL directly into a fresh tab (no
visit to the menu at all) boots straight into that game — this is
tested, not assumed.
