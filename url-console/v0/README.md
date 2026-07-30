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
- **Composable generators, not a genre switch** (`DESIGN.md` §15): the
  backdrop, HUD, and touch-control layout are each declared by the cart
  and interpreted generically by the runtime — nothing in `render()` or
  the touch-control builder branches on which cart, or even which
  `cart_type`, is loaded. `cart_type` is advisory display metadata only.
  This replaced a real regression a first pass introduced (a touch-layout
  lookup table keyed by the cart's literal name, and HUD/backdrop code
  branching on `cart_type` then reaching into cart-specific global
  indices) — see §15 for the postmortem.

## What V0 cuts, on purpose, relative to `DESIGN.md`

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

## Playing it

Open `urlcade.html`. The landing page is a shelf of cart cards, each
with its own accent color pulled from that cart's own generated
palette, a byte/char tally, and a collapsible view of the exact
fragment payload. Clicking **Play** sets `location.hash` to that
payload; the runtime's `boot()` reads the hash on load *and* on
`hashchange`, so pasting a cart's URL directly into a fresh tab (no
visit to the menu at all) boots straight into that game — this is
tested, not assumed.
