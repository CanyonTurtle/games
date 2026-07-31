# V0 — a real, working Urlcade

`urlcade.html` is a single self-contained page: the runtime (VM,
assembler, palette generator, three map generators — track-grammar,
cellular-automata caves, and a heightmap turtle-grammar — a camera, and a
renderer) and four dogfood carts (`../examples/flappy-bird.md`,
`../examples/race-car.md`, and a roguelike and a platformer both built
directly from `../examples/three-more-carts.md` §1/§2) built and playable
in one file. Open it directly in a browser — no build step, no server.

All four carts are authored once, assembled to real bytecode, **encoded
to bytes, base64url'd into the URL fragment, and then the runtime decodes
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
- **A second map-generator archetype: cellular-automata caves**
  (`map_generator = 2`), backing the third cart, Cave Crawler. Stochastic
  and smoothed (seed → noise → CA smoothing passes → flood-fill
  connectivity → BFS-farthest stairs placement) rather than the racer's
  deterministic turtle-walked token grammar — confirms `map_generator` is
  a small selector id over *any* algorithm, not a family of grammar
  variants. Border cells are forced solid (a practical simplification of
  the textbook "4-5 rule" algorithm) and the flood-fill guarantees every
  reachable tile is connected to the player's own start point by
  construction, not by chance — verified across 60 random seeds with an
  independent BFS reachability check in the test suite, zero failures.
- **`SETTILE`, the VM's first tilemap write opcode** — `GETTILE`'s
  missing write half, identified as a real gap in the design-level
  dogfood and now implemented and exercised for real (gold pickup: walk
  onto a gold tile, it flips to floor, `g_gold` increments). It patches
  just the one changed tile into the pre-rendered map canvas/GL texture
  rather than undoing the single-draw-call tilemap optimization above.
- **Edge-triggered grid movement, confirmed needing no new opcode**: the
  roguelike stores last frame's input mask in a global and compares it
  to the current one to detect a fresh press, moving exactly one tile
  per press regardless of how long a direction is held — verified
  directly (holding a direction across multiple ticks produces exactly
  one move, not continuous movement).
- **Deferred-kill combat, confirmed by driving it directly**: a monster
  reduced to non-positive hp via `on_collide` stays in `world.entities`
  through the rest of that tick (collision code never calls `KILL_SELF`
  on `a`/`b` — only `self`) and is removed on its own very next `on_tick`,
  which checks its own hp before running its AI. Both halves of that
  timing are asserted in the test suite, not just assumed from the
  design doc's reasoning.
- **A cart-declared `tileSurfaceOverrides` map**, replacing a runtime bug
  found while building the second tile-based cart: `TILE_SURFACE` used to
  hardcode the racer's startline-drives-like-road special case globally,
  which would have silently mis-treated the roguelike's own (unrelated)
  tile id 4. Now every cart declares its own sparse tile-id → surface-id
  remap (round-tripped through the binary format), defaulting to
  identity; the racer declares `{4: 2}` itself instead of the runtime
  assuming it. See `DESIGN.md` §15.1 for the full postmortem — including
  a second, same-species bug (`describeControls()` hardcoding "steer" for
  any cart using both left/right bits) found the same way, by building a
  cart that exercises the same "generic" code path differently.
- **A third map-generator archetype and the VM's first real physics
  opcode**, backing the fourth cart, Run & Jump. `MOVE_SOLID`
  (`map_generator = 3`'s heightmap grid + this one opcode) resolves an
  entity's movement against the tilemap one axis at a time, snapping
  position and zeroing velocity on the blocked axis — confirmed against
  floor-landing, wall-blocking, and ceiling-bonking, plus that terminal
  velocity clamped by `CLAMP_ABS` (already in the opcode table for the
  racer's AI steering) never let a fast fall tunnel through a tile.
  Solidity itself reuses `tileSurfaceOverrides` (born as a racer bug fix
  above) for an unplanned second purpose: nonzero surface = solid, so the
  platformer's whole tile bank needs exactly one override (`{AIR: 0}`).
- **A camera — the fourth composable concept**, alongside backdrop/HUD/
  input-layout/map-generator (`DESIGN.md` §14): a cart declares which
  entity to follow (by global handle) and clamp bounds; the renderer
  recomputes camera position every frame from the *interpolated* followed
  entity and offsets both the pre-rendered tilemap and every entity draw
  by it, in both backends. Unlike `MOVE_SOLID`/`SETTILE`, nothing in cart
  bytecode ever touches the camera directly — it's pure declared data
  read generically by the runtime, the same shape as the other three
  generators, not the opcode family. Verified with a bot that holds
  right and jumps periodically: it crosses the full level with the
  camera visibly panning and clamping correctly at both ends,
  screenshotted identically in both the WebGL and Canvas2D backends. All
  four carts now use this same camera (see the square-viewport pass
  below, `DESIGN.md` §18) — the platformer was just first.
- **A real authoring bug caught by the test suite, not eyeballing**:
  the platformer's level tokens mix marker tokens (`COIN`, `ENEMY` — no
  operand) with width-carrying tokens (`FLAT`, `GAP`, ...), and a naive
  `tokens.filter(t => t === COIN)` to count coins for the HUD/spawn-loop
  constant is wrong — a `GAP` or `BLOCK` width byte can numerically equal
  `COIN`'s or `ENEMY`'s token id. Caught because the test suite's spawned
  entity count didn't match the generator's own checkpoint count; fixed
  by reading `numCoins`/`numEnemies` off the generator's real,
  position-aware token walk instead of re-deriving them naively.
- **The open "is `map_generator` 1 and a proposed 3 actually one
  generator" question from the design-level dogfood, resolved by
  building #3 instead of debating it further**: kept separate. Both walk
  an authored token list into a tile grid + checkpoints (same category),
  but the racer stamps a fixed-width path *perpendicular* to travel at
  every step while the platformer walks *columns* maintaining a running
  ground height with tokens that only make sense for a heightmap — a
  shared "topology flag" would have to switch between two different
  stamping algorithms internally, which isn't really unification. See
  `DESIGN.md` §15.2 for the full writeup.
- **Sprites as a real generator, not raw pixels or a hand-written painter
  function.** Went through both alternatives first and both were real
  findings: raw hex-typed pixel art, nearest-neighbor-scaled to make
  sprites bigger, looked exactly like what it was ("too much blockiness,
  just scaled up"); a hand-written ellipse-math JS function per sprite
  fixed the blockiness but baked its one-time output into the cart —
  functionally fine (verified: a cart decodes and renders correctly with
  every painter function deleted from the page) but a real regression
  against this runtime's own pattern everywhere else (palette/map/HUD/
  camera: cart declares small params, runtime holds the generator), and
  a fair complaint ("these are hand-written functions?"). Landed on a
  small ordered list of ellipse/rect primitives — genuinely cart-declared
  data (~6 bytes/shape), interpreted by a shared `renderShapeList` at
  load time. Every sprite across all four carts decomposes into 3-8
  shapes; measured result, not estimated: sprite data shrank the total
  cart payload 20-37% depending on the cart. See `DESIGN.md` §17 for the
  full three-stage writeup.
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

  Rather than keep guessing at the touch-specific angle, took an
  automated CPU profile instead: a random-input bot (holding/releasing
  keys at random intervals, restarting on death) driving each cart for
  15 real seconds under Chrome DevTools' sampling profiler
  (`Profiler.start`/`stop` over CDP). Flappy Bird looked healthy — ~90%
  idle, the single biggest actual JS hotspot was `renderHUD` at only
  0.22% of samples. It was still worth fixing: `renderHUD` called
  `getElementById` and wrote `textContent`/`style.display`
  *unconditionally* every one of the 60 frames/sec, even though the HUD
  only changes a few times a minute. Now the elements are cached once and
  the DOM is only touched when the computed value actually differs from
  last frame's — `renderHUD`'s self-time dropped ~85% in the same
  profile (164 → 25 samples out of ~74k).

  The racer told a completely different story: **0.23% idle, 97.88%**
  in undifferentiated V8 "(program)" time — essentially pegging the
  thread the entire 15 seconds, nothing like Flappy Bird's profile
  shape. Traced it to the map renderer: the racer's 40×28 tile grid was
  being redrawn tile-by-tile, every frame, in both backends — confirmed
  directly by counting calls, 1,120 tiles + entities = 1,123
  `glDrawTexturedQuad` calls in a single frame, ~67,000/sec at 60fps,
  for a map that `buildTrack()` only ever computes once and never
  changes again. Fixed by pre-rendering the static tilemap to an
  offscreen canvas once at load (and a GL texture from that canvas when
  WebGL is active), so both renderers now draw the whole map as a
  single quad instead of one draw call per tile. Re-profiled after:
  **87.24% idle, 11.82% "(program)"** — back to matching Flappy Bird's
  shape. This is very likely the single biggest performance fix in the
  whole investigation, even though it was found while chasing an
  unrelated bug report specifically about Flappy Bird, which has no
  tilemap at all and was never affected by it.

- **A square 160×160 viewport for all four carts, and three genuinely
  more playable games behind it** (`DESIGN.md` §18). The racer's oval
  used to fit on one un-scrolled screen; it's now an 80×65-tile loop with
  a camera and a "double chicane" pattern verified to close by simulating
  the turtle-walk position math standalone before committing token
  counts to the cart (an earlier hand-counted attempt was off by exactly
  one segment length). The roguelike's cave grew from 32×20 to 48×36,
  which needed real parameter re-tuning — the same `fillProb` that gave a
  balanced floor ratio at the old size pushed well past 80% floor at the
  new one, and just raising `fillProb` to compensate hit a sharp collapse
  cliff (some seeds degenerating to near-all-wall) rather than scaling
  smoothly. And fixing "enemies don't move" surfaced a genuine, previously
  unmeasured bug two layers down from the intended fix: a monster's
  move-timer starts at 0 and counts down by checking `!= 0`, so it goes
  0 → −1 → −2 → ... forever and never fires again — monsters had likely
  never reliably moved, the intended retry-loop fix just happened to be
  the first test rigorous enough to catch it. The platformer's jump got
  heavier fall gravity than rise gravity plus a jump-cut on early release
  (measured: a tap now rises ~21px, a held jump ~52px) and roughly double
  the level length — which, walked end-to-end by an automated bot instead
  of spot-checked, turned up two more shipped-but-never-exercised
  generator bugs: `BLOCK` obstacles had no floor underneath at all (a
  bottomless pit with a decoration floating over it), and `GAP`'s "no
  death, just cost distance" safety net was pinned to the grid's absolute
  bottom row rather than the current ground height, so a gap encountered
  while the terrain was high up could be deeper than a jump can climb out
  of — an unrecoverable trap despite the design explicitly promising
  otherwise. All three bugs predate this pass; none had been walked or
  swept exhaustively before.

- **Deployed to GitHub Pages, and a discoverable spec.** The runtime is
  a single file with no build step, so "deploy" is just "publish that
  file" — a GitHub Actions workflow does it on every push to `main`.
  `DESIGN.md`, this file, and the worked examples are published alongside
  it under `/spec/` as raw markdown (agent-fetchable with no rendering
  step in the way) plus an `llms.txt` index at the site root, rather than
  left as repo-only files a human would have to go clone to read.
- **A Cart Inspector — decompiling a cart back into something readable,
  not just playable** (`DESIGN.md` §19). A third top-level view, next to
  the shelf and the player, that decodes *any* cart (pasted as a URL, a
  fragment, or just the payload — not only the four shipped ones) and
  tabs between its palette, rendered sprites/tiles, map, entity types,
  and — the new part — every hook's bytecode as both a labeled
  disassembly listing and a hand-rolled SVG control-flow-graph flowchart.
  Both the disassembler and the CFG extractor work from raw bytecode plus
  the shared opcode table alone, with no dependence on any cart's own
  symbol names, which is what makes "paste an arbitrary cart" possible
  rather than "inspect one of these four hardcoded carts." No diagramming
  library either — consistent with the runtime's own no-dependency
  policy for gameplay code, and validated as the right call here too:
  these hooks are short, mostly-linear programs, so a simple vertical
  block stack with bezier "bow right for forward branches, bow left for
  loops" edges reads as clearly as a full graph-layout algorithm would,
  for far less code. Verified against a hand-traced hook (the roguelike's
  `on_tick` retry loop) — the disassembler reconstructed it exactly,
  including the one instruction that makes it a loop.

- **A fifth cart_type: destruction (Slingshot & Castle Crusher)**
  (`DESIGN.md` §21). Angry Birds / Crush the Castle at a deliberately
  simplified physics tier — no rigid-body simulation, no rotation; HP-
  bearing blocks that wobble on a damped spring back to their own spawn
  point instead of falling or stacking, and the one real physics body
  (the launched projectile) reuses `MOVE_SOLID` + gravity exactly like
  the platformer's player. Zero new opcodes: the wobble is hand-rolled
  spring math, and both carts reuse `buildPlatformLevel`/`PLATFORM_TOKENS`
  verbatim (COIN → block spawn, ENEMY → target spawn, checkpoint 0 →
  launcher anchor) rather than a new map generator. Testing this properly
  — not just "does it crash" — found three real bugs before any of it
  shipped: an early terrain design with elevation changes left one
  Slingshot target and *all four* Castle Crusher targets *provably*
  unreachable at every angle/power combination (`MOVE_SOLID` has no
  step-assist, and every shot restarts from a fixed anchor with no
  forward progress carried between misses, so one wall between the
  anchor and a target is fatal, not just inconvenient); a settled,
  stopped projectile satisfied none of the "shot is over" conditions and
  could soft-lock a shot forever; and `on_collide` re-applying damage on
  every tick of continued overlap meant a slow graze could delete a
  6-HP block as fast as a direct hit, making HP meaningless. All three
  found by simulating (a full angle × power sweep against fresh `World`
  instances, watching a shot's actual trajectory tick-by-tick) rather
  than by eyeballing a couple of test plays. One more bug, purely
  cosmetic but the most surprising: `paletteParams` round-trips through
  the binary format as *unsigned* bytes, so a negative hue-offset value
  used to fix a bad accent color silently wrapped to a different wrong
  color instead of the intended one on encode/decode — signed offsets
  aren't representable in that field at all, which only became clear by
  checking the *decoded* cart's params, not just the source object.

- **An aim line — a fifth composable generator — and real visual identity
  for the two destruction carts** (`DESIGN.md` §22), both from direct
  play feedback: charging a shot had no visual feedback at all, and the
  two carts' "structures" were just scattered identical squares. The aim
  line follows the exact same cart-declares-params/runtime-draws-it
  shape as camera/HUD/palette — genuinely optional (gated by a presence
  byte, unlike camera's always-on sentinel), and both renderers compute
  its direction with the *same formula* the destruction genre's own
  launch-velocity math uses, so the line is provably where a shot fired
  right now would go. Each cart also got a second block silhouette
  (a plank alongside the crate, a turret alongside the wall) spawned on
  alternating checkpoints, which needed widening `on_tick`/`on_collide`'s
  type dispatch from "is this a block" to "is this either block variant"
  — mechanical, not a new mechanic. One testing note worth keeping: the
  aim line looked completely broken in every early screenshot, until
  forcing a synchronous render and screenshotting in the same tick
  showed it had worked correctly the whole time — `waitForTimeout`
  before a screenshot was catching stale frames under headless
  Chromium's rAF throttling, not a real bug.

- **Real vertical structure — a stacked castle, not one block per enemy
  on a flat line** (`DESIGN.md` §23). The previous fix only varied block
  *sprites*; every position was still ground-level with two fixed height
  offsets. Fixed at the map-generator level: `COIN_AT`/`ENEMY_AT` tokens
  take an explicit row-offset operand and don't advance the column
  cursor, so a run of them between two `FLAT`s stacks multiple
  blocks/targets at one x position, at any heights — real skylines
  (a 2-story shack; two 3-tall towers flanking a walled gate) instead of
  a scattered line. This reopened the exact reachability question §21
  already fixed once: the reachability sweep caught 3 of Castle
  Crusher's 4 targets as structurally unreachable in the wider (58-col)
  layout, not because of the stacking but because of scale — the
  projectile's horizontal velocity decays under `GROUND_FRICTION` every
  tick, airborne or not, so real reachable range is a hump that peaks
  a handful of columns out and collapses to ground-level-only well
  before 58 columns. Measured the actual envelope (a sweep recording
  peak height reached at every column) and compressed the castle to fit
  inside it with margin; the sweep came back clean, and a follow-up
  search for the best angle/charge-tick per target — fired as one
  continuous playthrough, not isolated trials — cleared all 4 targets
  in 4 of 14 shots, confirming real margin. One testing-methodology bug
  worth recording alongside the rAF one: an early "find the best combo"
  script set the angle/power globals directly *and* still ran the
  charge-tick loop on top, silently doubling the power applied — it
  produced combos that looked perfect in isolation but didn't reproduce
  when actually played back. Fixed by only ever driving angle/power
  through real input ticks, same as a player would.

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
- **Two entity types per cart.** Enough to exercise the per-type
  extension-field mechanism, not an exhaustive catalog.

## Three more dogfoods — two now real, one still design-level

`../examples/three-more-carts.md` sketches a roguelike, a platformer, and
an arena shooter — chosen to pressure-test the composable-generator model
(`DESIGN.md` §14) with a genuinely different map-generator archetype
(cellular-automata caves) and to check whether "generator" needed to keep
growing new primitives or whether the existing ones already generalized.

The roguelike (**Cave Crawler**) and the platformer (**Run & Jump**) have
since been built as real, playable carts in `urlcade.html` — cave
generation, `SETTILE`-based gold pickup, edge-triggered grid movement,
and deferred-kill monster combat for the roguelike; a heightmap turtle-
grammar generator, `MOVE_SOLID` tile collision, and a camera for the
platformer — all running as actual bytecode and real engine code, not
just design prose (see the bullets above, and `DESIGN.md` §15.1/§15.2).
The arena shooter remains design-level only — a deliberate scope cut,
not an oversight. Findings from the original design-level pass on all
three (two real primitive gaps — `SETTILE`, `MOVE_SOLID` — one real new
composable concept — camera/viewport — and three confirmations that
existing machinery already covered enough ground) are folded into
`DESIGN.md` §15; findings specific to actually *building* the roguelike
and the platformer are in §15.1 and §15.2.

## Playing it

Open `urlcade.html`. The landing page is a shelf of cart cards, each
with its own accent color pulled from that cart's own generated
palette, a byte/char tally, and a collapsible view of the exact
fragment payload. Clicking **Play** sets `location.hash` to that
payload; the runtime's `boot()` reads the hash on load *and* on
`hashchange`, so pasting a cart's URL directly into a fresh tab (no
visit to the menu at all) boots straight into that game — this is
tested, not assumed.
