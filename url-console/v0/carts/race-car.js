/* ============================================================
   The Urlcade — example cart: Race Car
   (see url-console/examples/race-car.md for the original worked design
   writeup — header, procedural palette, constant pool, track piece
   grammar, per-type declared entity fields, and representative bytecode)
   ============================================================ */
"use strict";
const K = window.UrlcadeKernel;
const {
  assemble, HOOK_NAMES, TOUCH_TEMPLATE_STEER_ACTION, SHAPE_ELLIPSE, SHAPE_RECT,
  TRACK_TOKENS, TILE_ROAD, TILE_STARTLINE, TILE_CHECKPOINT,
} = K;
import { hexRowsToPixels } from './shared-sprites.js';

/* ============================================================
   9. Cart authoring — Race Car (see url-console/examples/race-car.md)
   ============================================================ */
const RACER_CONST_NAMES = {
  ACCEL:0, TURN_RATE:1, FRICTION_ROAD:2, FRICTION_RUMBLE:3, FRICTION_GRASS:4,
  CHECKPOINT_RADIUS:5, TOTAL_LAPS:6, AI_TURN_GAIN:7, PARTICLE_TTL:8, NUM_CHECKPOINTS:9,
  START_X:10, START_Y:11, BUMP_MIX:12, LAP_FLASH_DURATION:13,
};
// g_car_player2 sits immediately after g_car_player (DESIGN.md §82) —
// runtime.js's camera/HUD local-player offset during a multiplayer match
// reads globals[followGlobal + localPlayerSlot], so player 2's own car
// handle has to be the very next global index, not just anywhere.
const RACER_GLOBAL_NAMES = {
  g_car_player:0, g_car_player2:1, g_car_ai1:2, g_car_ai2:3, g_scratch:4,
  g_finish_counter:5, g_race_over:6, g_cpx:7, g_cpy:8, g_friction:9,
  g_scratch2:10, g_lap_flash:11,
};
const RACER_SYM = {constants:RACER_CONST_NAMES, globals:RACER_GLOBAL_NAMES};

// typeId parameterized (not always 0) so the two AI cars can spawn as a
// second, differently-colored entity type (entityTypes[2], entity A's
// ramp) instead of the player's own (entityTypes[0], entity B's ramp) —
// same collisionW/H and extFieldCount as the player's type, same props
// layout, just a different assetIndex (DESIGN.md §48).
function racerInitCarBlock(handleName, typeId, xExpr, yExpr){
  return `
    SPAWN ${typeId}
    STOREG ${handleName}
    ${xExpr}
    STOREE ${handleName} 0
    ${yExpr}
    STOREE ${handleName} 1
    PUSHI 0
    STOREE ${handleName} 8
    ; Checkpoint index starts at 1 (checkpoint 1), not 0 — every car
    ; spawns exactly on checkpoint 0's own position (it's the finish
    ; line), and lap-completion now specifically means "reached
    ; checkpoint 0 while it was the active target" (DESIGN.md §50).
    ; Starting the index at 0 would satisfy that trivially on the very
    ; first tick, crediting a whole lap before the car had moved at all.
    PUSHI 1
    STOREE ${handleName} 9
    PUSHI 0
    STOREE ${handleName} 10
    PUSHI 0
    STOREE ${handleName} 11
  `;
}

// Both human cars spawn as typeId 0 (the player color ramp) — the two
// AI cars keep typeId 2 (DESIGN.md §48's second ramp) so color still
// tells "human" from "AI" apart at a glance; telling the two humans'
// own cars apart doesn't need a third color, since each peer's camera
// (DESIGN.md §82) is always centered on its own car, never the other
// player's (DESIGN.md §83).
const RACER_HOOKS_SRC = {
  on_init: `
    ${racerInitCarBlock('g_car_player', 0, 'PUSHC START_X', 'PUSHC START_Y')}
    ${racerInitCarBlock('g_car_player2', 0, 'PUSHC START_X', 'PUSHC START_Y\nPUSHI -10\nADD')}
    ${racerInitCarBlock('g_car_ai1', 2, 'PUSHC START_X', 'PUSHC START_Y\nPUSHI -20\nADD')}
    ${racerInitCarBlock('g_car_ai2', 2, 'PUSHC START_X', 'PUSHC START_Y\nPUSHI 10\nADD')}
    PUSHI 0
    STOREG g_finish_counter
    PUSHI 0
    STOREG g_race_over
    PUSHI 0
    STOREG g_lap_flash
    HALT
  `,
  // Two near-identical blocks, one per human player (LOAD_INPUT 0 / 1 —
  // slot 0 is always this browser's own keys/touch, slot 1 is the synced
  // remote peer's during a match and simply stays all-zero otherwise, so
  // g_car_player2 just sits idle in solo play, DESIGN.md §83). Not
  // factored into a shared subroutine — this VM has no CALL/RET, only
  // JMP, so a shared block would need its own dispatch-by-handle
  // plumbing for no real win at this size.
  on_input: `
    LOADG g_race_over
    JNZ done
    LOAD_INPUT 0
    TESTBIT 0
    JZ p1chkright
    LOADE g_car_player 8
    PUSHC TURN_RATE
    SUB
    STOREE g_car_player 8
    p1chkright:
    LOAD_INPUT 0
    TESTBIT 1
    JZ p1chkaccel
    LOADE g_car_player 8
    PUSHC TURN_RATE
    ADD
    STOREE g_car_player 8
    p1chkaccel:
    LOAD_INPUT 0
    TESTBIT 2
    JZ p2block
    LOADE g_car_player 8
    COS
    PUSHC ACCEL
    MUL
    LOADE g_car_player 2
    ADD
    STOREE g_car_player 2
    LOADE g_car_player 8
    SIN
    PUSHC ACCEL
    MUL
    LOADE g_car_player 3
    ADD
    STOREE g_car_player 3
    p2block:
    LOAD_INPUT 1
    TESTBIT 0
    JZ p2chkright
    LOADE g_car_player2 8
    PUSHC TURN_RATE
    SUB
    STOREE g_car_player2 8
    p2chkright:
    LOAD_INPUT 1
    TESTBIT 1
    JZ p2chkaccel
    LOADE g_car_player2 8
    PUSHC TURN_RATE
    ADD
    STOREE g_car_player2 8
    p2chkaccel:
    LOAD_INPUT 1
    TESTBIT 2
    JZ done
    LOADE g_car_player2 8
    COS
    PUSHC ACCEL
    MUL
    LOADE g_car_player2 2
    ADD
    STOREE g_car_player2 2
    LOADE g_car_player2 8
    SIN
    PUSHC ACCEL
    MUL
    LOADE g_car_player2 3
    ADD
    STOREE g_car_player2 3
    done:
    HALT
  `,
  // The "Lap complete!" flash (DESIGN.md §49) counts down here, once per
  // simulation step regardless of how many cars are active — on_tick
  // (below) only ever sets it, never decrements it, since on_tick runs
  // once per car per step and a per-car decrement would tick it down 3x
  // too fast.
  on_frame: `
    LOADG g_lap_flash
    JZ chk_race_over
    LOADG g_lap_flash
    PUSHI 1
    SUB
    DUP
    STOREG g_lap_flash
    JNZ still_flashing
    ; Countdown just reached 0 this frame — force both human cars' sprites
    ; back to normal (sprites[0]) and stop, rather than leaving either at
    ; whatever the strobe below last landed on. Both, not just
    ; g_car_player, since g_lap_flash is a shared whole-race event now
    ; (either player crossing triggers it, see on_tick's skip_flash gate)
    ; and there's no per-crosser record here to strobe selectively.
    PUSHI 0
    STOREE g_car_player 12
    PUSHI 0
    STOREE g_car_player2 12
    JMP chk_race_over
    still_flashing:
    ; Strobe both human cars' current assetIndex (props[12], 8 +
    ; extFieldCount(4)) between normal (0) and carFlashShapes (3) every 4
    ; ticks — ~7.5Hz at 60Hz, fast enough to read as a flash rather than a
    ; slow color fade, for the whole LAP_FLASH_DURATION countdown.
    LOADG g_lap_flash
    PUSHI 8
    MOD
    PUSHI 4
    CMPLT
    JZ flash_frame
    PUSHI 0
    STOREE g_car_player 12
    PUSHI 0
    STOREE g_car_player2 12
    JMP chk_race_over
    flash_frame:
    PUSHI 3
    STOREE g_car_player 12
    PUSHI 3
    STOREE g_car_player2 12
    chk_race_over:
    LOADE g_car_player 11
    JZ done
    LOADE g_car_player2 11
    JZ done
    LOADE g_car_ai1 11
    JZ done
    LOADE g_car_ai2 11
    JZ done
    PUSHI 1
    STOREG g_race_over
    done:
    HALT
  `,
  // skip_ai's position update is axis-separated wall collision against
  // GETTILE's *raw* tile id (grass, id 1 — MAP_EDGE_TILE, the same id
  // returned off-grid, so this doubles as a grid-boundary wall for free),
  // not MOVE_SOLID: MOVE_SOLID tests ctx.tileSurface() !== 0, the exact
  // function this cart already overloads for its own 3-way friction
  // lookup below (road/rumble/grass all read as distinct nonzero-ish
  // surfaces), so reusing it for solidity would either break friction or
  // make every tile solid. Hand-rolling the same axis-separated check
  // against the untouched tile id instead keeps both independent: only
  // grass blocks movement (and zeroes that axis's velocity, so a car
  // stops at the wall instead of sliding along it), while road/rumble
  // both stay fully passable with their own friction (DESIGN.md §45).
  on_tick: `
    LOAD_SELF 4
    PUSHI 1
    CMPEQ
    JNZ tick_particle
    LOAD_SELF 7
    LOADG g_car_player
    CMPEQ
    LOAD_SELF 7
    LOADG g_car_player2
    CMPEQ
    OR
    JNZ skip_ai
    LOAD_SELF 9
    GET_CHECKPOINT
    STOREG g_cpy
    STOREG g_cpx
    LOADG g_cpx
    LOAD_SELF 0
    SUB
    LOADG g_cpy
    LOAD_SELF 1
    SUB
    ATAN2
    LOAD_SELF 8
    SUB
    NORM_ANGLE
    PUSHC TURN_RATE
    PUSHC AI_TURN_GAIN
    MUL
    CLAMP_ABS
    LOAD_SELF 8
    ADD
    STORE_SELF 8
    LOAD_SELF 8
    COS
    PUSHC ACCEL
    MUL
    LOAD_SELF 2
    ADD
    STORE_SELF 2
    LOAD_SELF 8
    SIN
    PUSHC ACCEL
    MUL
    LOAD_SELF 3
    ADD
    STORE_SELF 3
    skip_ai:
    LOAD_SELF 0
    LOAD_SELF 2
    ADD
    STOREG g_scratch
    LOADG g_scratch
    LOAD_SELF 1
    GETTILE
    PUSHI 1
    CMPEQ
    JZ x_pass
    LOAD_SELF 0
    STOREG g_scratch
    PUSHI 0
    STORE_SELF 2
    x_pass:
    LOADG g_scratch
    STORE_SELF 0
    LOAD_SELF 1
    LOAD_SELF 3
    ADD
    STOREG g_scratch2
    LOAD_SELF 0
    LOADG g_scratch2
    GETTILE
    PUSHI 1
    CMPEQ
    JZ y_pass
    LOAD_SELF 1
    STOREG g_scratch2
    PUSHI 0
    STORE_SELF 3
    y_pass:
    LOADG g_scratch2
    STORE_SELF 1
    LOAD_SELF 0
    LOAD_SELF 1
    GETTILE
    TILE_SURFACE
    STOREG g_scratch
    LOADG g_scratch
    PUSHI 2
    CMPEQ
    JZ chk_rumble2
    PUSHC FRICTION_ROAD
    STOREG g_friction
    JMP fric_done2
    chk_rumble2:
    LOADG g_scratch
    PUSHI 3
    CMPEQ
    JZ is_grass2
    PUSHC FRICTION_RUMBLE
    STOREG g_friction
    JMP fric_done2
    is_grass2:
    PUSHC FRICTION_GRASS
    STOREG g_friction
    fric_done2:
    LOAD_SELF 2
    LOAD_SELF 2
    LOADG g_friction
    MUL
    SUB
    STORE_SELF 2
    LOAD_SELF 3
    LOAD_SELF 3
    LOADG g_friction
    MUL
    SUB
    STORE_SELF 3
    LOAD_SELF 9
    GET_CHECKPOINT
    STOREG g_cpy
    STOREG g_cpx
    LOAD_SELF 0
    LOAD_SELF 1
    LOADG g_cpx
    LOADG g_cpy
    DIST
    PUSHC CHECKPOINT_RADIUS
    CMPLT
    JZ tick_end2
    ; Reached whichever checkpoint this car was currently targeting. A lap
    ; only completes when that target *was* checkpoint 0 (the actual
    ; finish line) — checked here, on the *old* index, before it's
    ; advanced below. The previous version checked the index *after*
    ; advancing/wrapping it, which meant crossing checkpoint
    ; NUM_CHECKPOINTS-1 (the last ordinary checkpoint) counted as a
    ; completed lap immediately, a tick before the car had actually
    ; driven anywhere near the real finish line (DESIGN.md §50).
    LOAD_SELF 9
    JNZ advance_checkpoint
    LOAD_SELF 10
    PUSHI 1
    ADD
    STORE_SELF 10
    ; This lap-complete branch runs for every car, AI included (this
    ; crossing isn't player-specific) — the "Lap complete!" HUD flash
    ; should only ever fire for a human player's own crossing, so it's
    ; gated separately here on prop 7 (self's own id) matching either
    ; g_car_player or g_car_player2, same identity check the top of
    ; on_tick already uses to decide whose input drives this car at all.
    ; g_lap_flash is a single shared global (sourceKind:0, never offset
    ; by localPlayerSlot — DESIGN.md §82), so this flash is a whole-race
    ; event both peers see together, not "your own lap" specifically.
    LOAD_SELF 7
    LOADG g_car_player
    CMPEQ
    LOAD_SELF 7
    LOADG g_car_player2
    CMPEQ
    OR
    JZ skip_flash
    PUSHC LAP_FLASH_DURATION
    STOREG g_lap_flash
    skip_flash:
    LOAD_SELF 10
    PUSHC TOTAL_LAPS
    CMPLT
    JNZ advance_checkpoint
    LOAD_SELF 11
    JNZ advance_checkpoint
    LOADG g_finish_counter
    PUSHI 1
    ADD
    DUP
    STOREG g_finish_counter
    STORE_SELF 11
    advance_checkpoint:
    LOAD_SELF 9
    PUSHI 1
    ADD
    PUSHC NUM_CHECKPOINTS
    MOD
    STORE_SELF 9
    JMP tick_end2
    tick_particle:
    LOAD_SELF 8
    PUSHI 1
    SUB
    DUP
    STORE_SELF 8
    JNZ tick_end2
    KILL_SELF
    tick_end2:
    HALT
  `,
  // "Is this a car" now checks prop 4 (auto-set to typeId at spawn) !=
  // the particle type (1), not == the player's own car type (0) — the AI
  // cars spawn as a second car type (2, entity A's colors) below, and
  // this bump-mix physics needs to fire for *any* car-vs-car collision,
  // player or AI, not just player-vs-player (which never happens with
  // one player car anyway).
  on_collide: `
    LOAD_A 4
    PUSHI 1
    CMPNE
    LOAD_B 4
    PUSHI 1
    CMPNE
    AND
    JZ done3
    LOAD_A 2
    LOAD_B 2
    PUSHC BUMP_MIX
    LERP
    STOREG g_scratch
    LOAD_B 2
    LOAD_A 2
    PUSHC BUMP_MIX
    LERP
    STOREG g_scratch2
    LOADG g_scratch
    STORE_A 2
    LOADG g_scratch2
    STORE_B 2
    SPAWN 1
    STOREG g_scratch
    LOAD_A 0
    STOREE g_scratch 0
    LOAD_A 1
    STOREE g_scratch 1
    PUSHC PARTICLE_TTL
    STOREE g_scratch 8
    done3:
    HALT
  `,
};

function buildRacerCart(){
  // Rounded body (outline+fill), a windshield band, a roof highlight
  // stripe, and four wheel-bump rects — nose along +x (rotateFlag rotates
  // the whole sprite to match heading). Entity B's 4-color ramp (DESIGN.md
  // §43 — entity B, not A, because +240deg from this cart's blue terrain
  // hue is what lands on green; entity A would have landed on pink) for
  // the player's own car: 12=darkest (tires/outline), 13=windshield
  // glass, 14=body fill, 15=roof highlight (brightest).
  const carShapes = [
    {type:SHAPE_ELLIPSE, cx:8,cy:8, rx:6.3,ry:4.6, color:12},
    {type:SHAPE_ELLIPSE, cx:8,cy:8, rx:6.0,ry:4.3, color:14},
    {type:SHAPE_RECT, x:8.3,y:5.2, w:3.3,h:5.6, color:13},
    {type:SHAPE_RECT, x:3.2,y:6.7, w:5.0,h:2.6, color:15},
    {type:SHAPE_RECT, x:3.0,y:0.4, w:2.2,h:2.4, color:12},
    {type:SHAPE_RECT, x:10.8,y:0.4, w:2.2,h:2.4, color:12},
    {type:SHAPE_RECT, x:3.0,y:13.2, w:2.2,h:2.4, color:12},
    {type:SHAPE_RECT, x:10.8,y:13.2, w:2.2,h:2.4, color:12},
  ];
  // Identical shapes, entity A's ramp instead of entity B's (8-11, not
  // 12-15) — the two AI cars spawn as this second car type (entityTypes
  // index 2 below) purely so they read as a different color from the
  // player's own car, not just a different shade of the same one
  // (DESIGN.md §48, the same independent-hue reasoning DESIGN.md §43
  // already established for telling a cart's own entities apart).
  const aiCarShapes = [
    {type:SHAPE_ELLIPSE, cx:8,cy:8, rx:6.3,ry:4.6, color:8},
    {type:SHAPE_ELLIPSE, cx:8,cy:8, rx:6.0,ry:4.3, color:10},
    {type:SHAPE_RECT, x:8.3,y:5.2, w:3.3,h:5.6, color:9},
    {type:SHAPE_RECT, x:3.2,y:6.7, w:5.0,h:2.6, color:11},
    {type:SHAPE_RECT, x:3.0,y:0.4, w:2.2,h:2.4, color:8},
    {type:SHAPE_RECT, x:10.8,y:0.4, w:2.2,h:2.4, color:8},
    {type:SHAPE_RECT, x:3.0,y:13.2, w:2.2,h:2.4, color:8},
    {type:SHAPE_RECT, x:10.8,y:13.2, w:2.2,h:2.4, color:8},
  ];
  // "Lap complete!" flash (sprites[3]) — the player car's own carShapes
  // geometry, recolored to the terrain ramp's two extremes (0 darkest, 7
  // lightest) instead of a third independent hue: a stark photo-flash
  // look that reads as "this car, but flashing" rather than "a different
  // car," and the terrain ramp is guaranteed visually distinct from both
  // entity ramps by construction (DESIGN.md §43/§44) — nothing new to
  // hint or risk colliding with. Strobed against carShapes while
  // g_lap_flash counts down (on_frame, extending the existing HUD-only
  // flash from DESIGN.md §49 to the sprite itself).
  const carFlashShapes = [
    {type:SHAPE_ELLIPSE, cx:8,cy:8, rx:6.3,ry:4.6, color:0},
    {type:SHAPE_ELLIPSE, cx:8,cy:8, rx:6.0,ry:4.3, color:7},
    {type:SHAPE_RECT, x:8.3,y:5.2, w:3.3,h:5.6, color:0},
    {type:SHAPE_RECT, x:3.2,y:6.7, w:5.0,h:2.6, color:7},
    {type:SHAPE_RECT, x:3.0,y:0.4, w:2.2,h:2.4, color:0},
    {type:SHAPE_RECT, x:10.8,y:0.4, w:2.2,h:2.4, color:0},
    {type:SHAPE_RECT, x:3.0,y:13.2, w:2.2,h:2.4, color:0},
    {type:SHAPE_RECT, x:10.8,y:13.2, w:2.2,h:2.4, color:0},
  ];
  const particleShapes = [
    {type:SHAPE_ELLIPSE, cx:4,cy:4, rx:3.2,ry:3.2, color:1},
    {type:SHAPE_ELLIPSE, cx:4,cy:4, rx:2.6,ry:2.6, color:2},
  ];
  const grassPixels = hexRowsToPixels(new Array(8).fill('11111111'));
  const roadPixels = hexRowsToPixels([
    '33333333','32222223','32222223','32222223',
    '32222223','32222223','32222223','33333333',
  ]);
  const rumblePixels = hexRowsToPixels([
    '44444444','44444444','55555555','55555555',
    '44444444','44444444','55555555','55555555',
  ]);
  // High-contrast checker (terrain's darkest and lightest shades, not two
  // adjacent ones) — an earlier version alternated indices 6/7, adjacent
  // steps on the same ramp barely 8 points of lightness apart, so the
  // "checkered flag" pattern was there geometrically but nearly invisible
  // in practice. 0 and 7 are the ramp's two extremes, guaranteed far apart
  // regardless of the cart's own terrain hue (DESIGN.md §49).
  const startPixels = hexRowsToPixels([
    '07070707','70707070','07070707','70707070',
    '07070707','70707070','07070707','70707070',
  ]);
  // The actual finish line's own high-contrast checker (above), not
  // reused here — TILE_CHECKPOINT (DESIGN.md §49) is its own tile id now,
  // so a mid-lap checkpoint gate can render as plain road instead of an
  // identical-looking second "finish line," leaving exactly one checkered
  // stripe on the whole track: the real one.
  const checkpointPixels = roadPixels;

  // A closed rectangular circuit, much bigger than the original small
  // donut, with a "double chicane" (turn off the main heading, jog
  // sideways, turn back — nets to zero lateral drift, verified by
  // simulating the turtle walk before committing to it) on two opposite
  // sides for visual variety a plain rectangle didn't have. Track
  // geometry was designed by simulating buildTrack's own turtle-walk
  // math standalone (position/heading only, no tile stamping) and
  // checking the token list actually closes back to the start tile —
  // see DESIGN.md §18 for why that's not just "count carefully by hand."
  // trackWidth widened 5->7 (still odd, so stampPerp's +-half loop stays
  // symmetric around the centerline) — three cars racing side by side had
  // barely more than their own combined width to work with at 5. Checked
  // against a dense grid (gridW*gridH) with plenty of margin either way, so
  // the wider stamp doesn't clip against the grid edge on any curve.
  // startGX 8->20, gridW 80->90 (DESIGN.md §50): shifted right to make room
  // for the finish line's own repositioning below — the walk's own closing
  // curve turns out to sit right at the original startGX, only 7 tiles from
  // the grid's left edge, and splitting 12 tiles off the leading straight
  // to buffer the finish line shifts that whole closing corner 12 tiles
  // further left with it, clipping the grid. Re-verified via the same
  // "simulate the walk, count clipped tiles" check as every other track
  // dimension change on this cart (DESIGN.md §18/§45) rather than guessing
  // a bigger number and hoping.
  const trackWidth = 7, segLen = 6, startGX = 20, startGY = 8, startDir = 0, gridW = 90, gridH = 65;
  // A WAYPOINT right after each of the chicane's 4 turns (DESIGN.md §46) —
  // the AI only ever steers straight at its current target, with no wall
  // awareness at all, so a target more than one turn away can point it
  // straight through a wall it has no way around. That was invisible back
  // when off-track was just extra friction (the AI could grind across the
  // "wall" until its straight line to a still-distant checkpoint cleared
  // again); once grass became solid, both AI cars got permanently stuck at
  // the first chicane, still aiming at a checkpoint 2 turns further on.
  const CHICANE = [
    TRACK_TOKENS.CURVE_R90, TRACK_TOKENS.WAYPOINT, TRACK_TOKENS.STRAIGHT, TRACK_TOKENS.STRAIGHT,
    TRACK_TOKENS.CURVE_L90, TRACK_TOKENS.WAYPOINT, TRACK_TOKENS.STRAIGHT, TRACK_TOKENS.STRAIGHT,
    TRACK_TOKENS.CURVE_L90, TRACK_TOKENS.WAYPOINT, TRACK_TOKENS.STRAIGHT, TRACK_TOKENS.STRAIGHT,
    TRACK_TOKENS.CURVE_R90, TRACK_TOKENS.WAYPOINT,
  ];
  const S = (n) => new Array(n).fill(TRACK_TOKENS.STRAIGHT);
  // START_FINISH used to sit right where the walk's closing curve exits
  // directly into it — a corner, not a straight, with a "free floating"
  // dead end on the near side once the checkered tile was actually
  // visible (DESIGN.md §49 made it visible; only then did the corner
  // placement become obvious). Moved to the middle of a straight run by
  // splitting 12 tiles off the leading S(4) (now S(2)) and moving them to
  // a new trailing S(2) at the very end of the walk, right after the
  // closing curve — same total straight length, just redistributed
  // across the wrap point, so the loop still closes identically (checked
  // the same way as always: simulate the walk, confirm it ends back at
  // startGX/startGY/startDir). The finish line now has a full 7 tiles of
  // plain road on both sides before hitting anything else (DESIGN.md §50).
  const tokens = [
    TRACK_TOKENS.START_FINISH,
    ...S(2), ...CHICANE, ...S(4),
    TRACK_TOKENS.CURVE_R90,
    ...S(3), TRACK_TOKENS.CHECKPOINT, ...S(5),
    TRACK_TOKENS.CURVE_R90,
    ...S(4), ...CHICANE, ...S(4),
    TRACK_TOKENS.CHECKPOINT,
    TRACK_TOKENS.CURVE_R90,
    ...S(3), TRACK_TOKENS.CHECKPOINT, ...S(5),
    TRACK_TOKENS.CURVE_R90,
    ...S(2),
  ];
  const startX = (startGX+0.5)*8, startY = (startGY+0.5)*8;
  const screenW = 160, screenH = 160;

  const cart = {
    formatVersion: 5,
    name: 'Race Car', author: 'Urlcade', // URL envelope only, see DESIGN.md §34 — never reaches the binary format
    cartType: 2, // advisory label only — see DESIGN.md §14
    // Track (terrain ramp) is a cool, dark blue-grey asphalt; cars
    // (entity B, hue hint ~50 — true yellow, not the ~67 yellow-green a
    // first attempt at this landed on) are light and lively — not the
    // reverse. A blue accent on a green base kept reading as flat no
    // matter how much brighter/more saturated the accent ramp got: blue
    // is the cooler, lower-perceptual-value hue of the two, so pushing
    // "the accent should be the brighter one" fights the hue itself
    // instead of working with it (DESIGN.md §41). Cars use entity B
    // rather than A only because entity A's own hint here (~250, unused
    // by any sprite) happens to keep it out of yellow's way — see
    // ../.claude/skills/urlcade/references/cart-object.md's Palette section for how these hints work.
    paletteParams: [220, 0, 8, 20, 12, 65, 178, 36],
    rngSeed: 17,
    modeFlags: 0,
    // 2 humans + 2 AI cars, DESIGN.md §83 — a friend can join over the
    // "Multiplayer" button (LOAD_INPUT 1 drives g_car_player2, on_input
    // above); with nobody connected, slot 1 just reads all-zero and
    // g_car_player2 sits idle at the line, same as any solo maxPlayers:2
    // cart before a match starts.
    maxPlayers: 2,
    screenW, screenH, // square viewport, see DESIGN.md §18 — the track
                      // itself (gridW*8 x gridH*8) is much bigger; the
                      // camera below is what makes that work instead of
                      // squashing the whole track into one small view
    mapGenerator: 1, // track-grammar generator (§16) — the same one any other
                     // genre could invoke for a loop-shaped level, not a
                     // "racer" special case
    backdropFillIndex: 0, backdropGroundHeight: 0, backdropGroundIndex: 0, // unused: the map generator covers the whole frame
    tileSurfaceOverrides: {[TILE_STARTLINE]: TILE_ROAD, [TILE_CHECKPOINT]: TILE_ROAD}, // both
                                                          // render distinctly (or not, for a plain
                                                          // checkpoint) but drive like road — cart-
                                                          // declared, not a runtime special case
                                                          // (DESIGN.md §16, §49)
    camera: {
      followGlobal: RACER_GLOBAL_NAMES.g_car_player,
      clampMinX: 0, clampMinY: 0,
      clampMaxX: Math.max(0, gridW*8 - screenW),
      clampMaxY: Math.max(0, gridH*8 - screenH),
    },
    inputActiveButtons: 1|2|4,
    inputTouchTemplate: TOUCH_TEMPLATE_STEER_ACTION,
    inputButtonLabels: {1:'Left', 2:'Right', 4:'Gas'},
    hudSpec: [
      {kind:0, sourceKind:1, srcA:RACER_GLOBAL_NAMES.g_car_player, srcB:10, delta:1, suffixConstIdx:RACER_CONST_NAMES.TOTAL_LAPS, clamp:1, label:'Lap'},
      // Flag line (label only, shown while its source is nonzero) tied to
      // g_lap_flash rather than the lap count itself — the persistent
      // "Lap: X/3" line above already shows the number continuously, so
      // this only needs to announce the moment, not repeat the count
      // (DESIGN.md §49).
      {kind:1, sourceKind:0, srcA:RACER_GLOBAL_NAMES.g_lap_flash, srcB:0, delta:0, suffixConstIdx:255, clamp:0, label:'Lap complete!'},
      {kind:2, sourceKind:1, srcA:RACER_GLOBAL_NAMES.g_car_player, srcB:11, delta:0, suffixConstIdx:255, clamp:0, label:'Finished #'},
      {kind:1, sourceKind:0, srcA:RACER_GLOBAL_NAMES.g_race_over, srcB:0, delta:0, suffixConstIdx:255, clamp:0, label:'Race over!'},
    ],
    // ACCEL/TURN_RATE halved, friction retentions square-rooted, PARTICLE_TTL
    // doubled vs the original 30Hz tuning — same reasoning as the flappy
    // cart: the sim now runs at 60Hz, rescaled to keep real-time feel fixed.
    // NUM_CHECKPOINTS was 2 here — stale from an earlier, shorter version
    // of this track, silently orphaning half the checkpoints buildTrack
    // actually registers (GET_CHECKPOINT's index wraps mod NUM_CHECKPOINTS,
    // so anything past index 1 was simply never targeted). Corrected to 12
    // to match the real count once the chicane waypoints (DESIGN.md §46)
    // are included — checked by calling buildTrack() directly and reading
    // checkpoints.length back, not by counting CHECKPOINT/WAYPOINT tokens
    // by eye.
    // TURN_RATE 2->2.4, FRICTION_ROAD 0.015->0.02 (DESIGN.md §47): a small
    // bump to both, on request — tighter turns (the car's heading itself
    // swings faster per tick of input) and more traction (old-direction
    // momentum bleeds off faster on-road, so a new heading's acceleration
    // takes over sooner instead of carrying a wide drift through a turn;
    // this model has no separate lateral-grip term, so friction is the
    // only knob that actually changes how quickly velocity "catches up"
    // to a new heading). AI_TURN_GAIN's own turn clamp scales with
    // TURN_RATE too, so the AI corners a little tighter for free.
    // TURN_RATE 2.4->3.2, FRICTION_ROAD 0.02->0.03 (DESIGN.md §51): a
    // second, explicitly 2x-as-large pass over the same two knobs, same
    // reasoning as §47 — this round's delta (+0.8 turn rate, +0.01
    // friction) is exactly double the previous round's (+0.4, +0.005),
    // not a fresh guess at "tighter." Re-verified the same way every
    // handling change on this cart has been: the sloppy-bot lap test
    // still completes cleanly (confirms this didn't reintroduce the
    // wall-collision/flyby failure modes from §45/§46 at the higher AI
    // turn-clamp this also produces), the AI-progress regression check
    // still passes, and a headless spin-in-place measurement confirmed a
    // visibly tighter turning circle than §47's own.
    // CHECKPOINT_RADIUS 14->24->40 (DESIGN.md §46, then §47): 24 was
    // enough for the AI's near-optimal, straight-line-seeking path but
    // not for a real driven line — a car sweeping wide through a turn
    // (any driven path, not just a sloppy one) can stay on-road the
    // entire time yet never come within 24px of the exact pivot pixel a
    // waypoint sits at, silently freezing that car's own checkpoint
    // index (and, since the HUD's lap counter is that same index wrapping
    // to 0, the "Lap" readout) forever. Each turn's solid block is a
    // trackWidth-square (7 tiles = 56px) centered exactly on its
    // checkpoint, so the true worst case — a path that stays right at the
    // block's far corner the whole way through — is 28*sqrt(2) =~ 39.6px
    // from center; 40 covers that worst case outright rather than being
    // a value that merely tested fine. Reproduced and confirmed headlessly
    // with a deliberately imprecise bot (150ms reaction ticks, a 15deg
    // dead zone before correcting — much closer to how a human actually
    // drives than the AI's own per-tick seek): got permanently stuck at
    // checkpoint 5 at radius 24, completed multiple full laps cleanly at
    // radius 40. The AI still completes laps at 40 too, if anything more
    // reliably than at 24.
    // LAP_FLASH_DURATION (DESIGN.md §49): ticks the "Lap complete!" HUD
    // line stays up after the player crosses the finish line — 90 at this
    // cart's 60Hz sim is 1.5s, long enough to actually read, short enough
    // to be gone well before the next lap if the player is quick.
    constants: [0.075, 3.2, 0.03, 0.041, 0.106, 40, 3, 0.6, 20, 12, startX, startY, 0.3, 90],
    // Type 2 (the AI cars' own car type) is identical to type 0 in every
    // way that matters to physics/collision — same collisionW/H, same
    // extFieldCount, so the same props layout every car-handling hook
    // above already assumes — only assetIndex differs, pointing at
    // aiCarShapes instead of carShapes.
    entityTypes: [
      {renderKind:0, assetIndex:0, rotateFlag:1, collisionW:10, collisionH:10, extFieldCount:4},
      {renderKind:0, assetIndex:1, rotateFlag:0, collisionW:4, collisionH:4, extFieldCount:1},
      {renderKind:0, assetIndex:2, rotateFlag:1, collisionW:10, collisionH:10, extFieldCount:4},
    ],
    sprites: [
      {kind:1, w:16, h:16, shapes:carShapes},
      {kind:1, w:8, h:8, shapes:particleShapes},
      {kind:1, w:16, h:16, shapes:aiCarShapes},
      {kind:1, w:16, h:16, shapes:carFlashShapes},
    ],
    tiles: [
      {w:8,h:8,pixels:grassPixels}, {w:8,h:8,pixels:roadPixels},
      {w:8,h:8,pixels:rumblePixels}, {w:8,h:8,pixels:startPixels},
      {w:8,h:8,pixels:checkpointPixels},
    ],
    track: {tokens, trackWidth, segLen, startGX, startGY, startDir, gridW, gridH},
    hooks: {},
  };
  for(const name of HOOK_NAMES){
    const src = RACER_HOOKS_SRC[name];
    cart.hooks[name] = src ? assemble(src.split('\n'), RACER_SYM) : new Uint8Array(0);
  }
  return cart;
}


export { buildRacerCart };
