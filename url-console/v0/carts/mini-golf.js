/* ============================================================
   The Urlcade — example cart: Mini Golf

   A tile-map course built from the *track* generator (mapGenerator: 1
   — DESIGN.md §16/§18) — the same turtle-grammar walk the racer uses,
   reused here for a fairway instead of a road. TILE_ROAD is the
   fairway (low friction), the stampPerp()-stamped edge cells are
   TILE_RUMBLE (rough — higher friction), everything the walk never
   stamped stays MAP_EDGE_TILE (out of bounds — heaviest friction, no
   hard wall). Two checkpoints do double duty as tee and hole: the
   walk's own START_FINISH gives the tee-off point (checkpoint 0), a
   trailing CHECKPOINT token gives the hole (checkpoint 1) — both read
   once at on_init via GET_CHECKPOINT, no new map-generator concept
   needed for "where's the hole."

   Angle/power is a two-press timing swing, not a hold-to-charge meter:
   press once to lock the aim angle and start a power value oscillating
   (a ping-pong 0..MAX_POWER, DESIGN.md-style composition of existing
   arithmetic ops, not a new opcode), press again to lock whatever power
   it's at right now and launch — the aimLine field (DESIGN.md §21) is
   the only thing new here, everything else (the state machine, the
   friction-by-tile-surface physics) is exactly the racer's own
   patterns aimed at a different genre.
   ============================================================ */
"use strict";
const K = window.UrlcadeKernel;
const {
  assemble, HOOK_NAMES, TOUCH_TEMPLATE_STEER_ACTION, SHAPE_ELLIPSE, SHAPE_RECT,
  TRACK_TOKENS, buildTrack,
} = K;
import { hexRowsToPixels } from './shared-sprites.js';

const GOLF_CONST_NAMES = {
  MAX_POWER:0, POWER_STEP:1, ANGLE_STEP:2, FRICTION_FAIRWAY:3, FRICTION_ROUGH:4,
  FRICTION_OB:5, STOP_EPS:6, HOLE_RADIUS:7,
};
const GOLF_GLOBAL_NAMES = {
  g_ball:0, g_swing_state:1, g_angle:2, g_power:3, g_power_dir:4, g_strokes:5,
  g_won:6, g_hole_x:7, g_hole_y:8, g_scratch:9, g_prev_input:10, g_aim_x:11,
  g_aim_y:12, g_active:13, g_friction:14, g_best_strokes:15,
};
const GOLF_SYM = {constants:GOLF_CONST_NAMES, globals:GOLF_GLOBAL_NAMES};
// Persist slot 0: this cart's own all-time best (lowest) stroke count —
// see opcodes.md's Persistence section. Each cart's persist array is
// keyed separately (a hash of the whole cart), so reusing slot 0 here
// is exactly as safe as Flappy Bird's own PERSIST_HIGH_SCORE reusing it
// for a completely different meaning.
const PERSIST_BEST_STROKES = 0;

const GOLF_HOOKS_SRC = {
  // Checkpoint 0 (from the walk's own START_FINISH token) is the tee —
  // GET_CHECKPOINT pushes x then y (y on top), so STOREE'ing prop 1 then
  // prop 0 consumes them in the right order with no scratch needed.
  // Checkpoint 1 (the trailing CHECKPOINT token) is the hole.
  on_init: `
    SPAWN 0
    STOREG g_ball
    PUSHI 0
    GET_CHECKPOINT
    STOREE g_ball 1
    STOREE g_ball 0
    PUSHI 1
    GET_CHECKPOINT
    STOREG g_hole_y
    STOREG g_hole_x
    ; The checkpoint-gate-vs-single-hole fixup (buildTrack's CHECKPOINT
    ; stamp always marks a full trackWidth-wide line, wrong for an actual
    ; hole) used to be 4 hand-written SETTILE calls right here. It's now
    ; declared statically as this cart's own mapShapes (see the cart
    ; object below) — a load-time compositing pass, not a runtime fixup,
    ; since the hole's tile position is fully determined by buildTrack()
    ; and this course's fixed geometry, computable once at cart-build
    ; time rather than recomputed by a hook on every single play.
    SPAWN 1
    STOREG g_scratch
    LOADG g_hole_x
    STOREE g_scratch 0
    LOADG g_hole_y
    STOREE g_scratch 1
    PUSHI 0
    STOREG g_swing_state
    PUSHI 0
    STOREG g_angle
    PUSHI 0
    STOREG g_power
    PUSHI 1
    STOREG g_power_dir
    PUSHI 0
    STOREG g_strokes
    PUSHI 0
    STOREG g_won
    PUSHI 0
    STOREG g_prev_input
    PUSHI 1
    STOREG g_active
    ; 0 doubles as "no best recorded yet" — a hole-out in 0 strokes isn't
    ; reachable (tee and hole are different checkpoints, so at least one
    ; real swing is required), so there's no real value this sentinel
    ; could collide with. hudSpec's own "Best" line (kind:2, below) stays
    ; hidden until this is genuinely nonzero.
    LOAD_PERSIST ${PERSIST_BEST_STROKES}
    STOREG g_best_strokes
    HALT
  `,
  // Keeps the aim line's anchor glued to the ball every frame — aimLine
  // reads globals, not entity props, so this is the one bit of glue
  // code an entity-position-driven aim indicator needs.
  on_frame: `
    LOADE g_ball 0
    STOREG g_aim_x
    LOADE g_ball 1
    STOREG g_aim_y
    HALT
  `,
  // Two-state swing: aiming (steer with left/right, press action to start
  // charging) -> charging (power ping-pongs 0..MAX_POWER every frame,
  // press action again to lock it and launch). Edge-triggered on the
  // action bit both times (compares against g_prev_input) so holding the
  // button doesn't fire twice.
  on_input: `
    LOADG g_won
    JNZ store_prev
    LOADG g_swing_state
    PUSHI 0
    CMPEQ
    JZ chk_charging

    LOAD_INPUT
    TESTBIT 0
    JZ chk_right_aim
    LOADG g_angle
    PUSHC ANGLE_STEP
    ADD
    STOREG g_angle
    chk_right_aim:
    LOAD_INPUT
    TESTBIT 1
    JZ chk_swing_press
    LOADG g_angle
    PUSHC ANGLE_STEP
    SUB
    STOREG g_angle
    chk_swing_press:
    LOAD_INPUT
    TESTBIT 2
    JZ store_prev
    LOADG g_prev_input
    TESTBIT 2
    JNZ store_prev
    PUSHI 1
    STOREG g_swing_state
    PUSHI 0
    STOREG g_power
    PUSHI 1
    STOREG g_power_dir
    JMP store_prev

    chk_charging:
    LOADG g_swing_state
    PUSHI 1
    CMPEQ
    JZ store_prev

    LOADG g_power
    LOADG g_power_dir
    PUSHC POWER_STEP
    MUL
    ADD
    STOREG g_power
    LOADG g_power
    PUSHI 0
    CMPLE
    JZ chk_power_high
    PUSHI 0
    STOREG g_power
    PUSHI 1
    STOREG g_power_dir
    JMP chk_swing_release
    chk_power_high:
    LOADG g_power
    PUSHC MAX_POWER
    CMPGE
    JZ chk_swing_release
    PUSHC MAX_POWER
    STOREG g_power
    PUSHI -1
    STOREG g_power_dir

    chk_swing_release:
    LOAD_INPUT
    TESTBIT 2
    JZ store_prev
    LOADG g_prev_input
    TESTBIT 2
    JNZ store_prev
    LOADG g_angle
    COS
    LOADG g_power
    MUL
    STOREE g_ball 2
    LOADG g_angle
    SIN
    NEG
    LOADG g_power
    MUL
    STOREE g_ball 3
    PUSHI 2
    STOREG g_swing_state
    PUSHI 0
    STOREG g_active
    LOADG g_strokes
    PUSHI 1
    ADD
    STOREG g_strokes

    store_prev:
    LOAD_INPUT
    STOREG g_prev_input
    HALT
  `,
  // The flag is the only renderKind:2 entity this cart has, so this hook
  // only ever runs for it — no per-entity dispatch needed, unlike a cart
  // where on_draw might serve more than one shape. All coordinates are
  // entity-local (DRAW_LINE draws relative to self's own position, DESIGN.md
  // §36), with (0,0) sitting at the hole — a pole running straight up, and
  // a small triangular pennant (two edges; the pole itself closes the
  // triangle's third side) rather than a flat rectangle, which read as
  // exactly that — an unlabeled colored rectangle — rather than a flag.
  on_draw: `
    PUSHI 0
    PUSHI 0
    PUSHI 0
    PUSHI -18
    PUSHI 12
    DRAW_LINE
    PUSHI 0
    PUSHI -18
    PUSHI 7
    PUSHI -14
    PUSHI 13
    DRAW_LINE
    PUSHI 7
    PUSHI -14
    PUSHI 0
    PUSHI -11
    PUSHI 13
    DRAW_LINE
    HALT
  `,
  // Only the ball (type 0) does anything here — the flag (type 1) is
  // drawn fresh each frame by its own on_draw above, not simulated.
  // Integrates position, applies friction by tile surface
  // (identical shape to the racer's own on_tick — see race-car.js),
  // then once speed drops below STOP_EPS (checked via DIST(0,0,vx,vy),
  // reusing the two-point distance opcode as a velocity-magnitude one)
  // zeroes velocity and either sinks the putt or hands control back to
  // the aiming state for the next stroke.
  on_tick: `
    LOAD_SELF 4
    PUSHI 0
    CMPEQ
    JZ tick_end
    LOADG g_won
    JNZ tick_end
    LOADG g_swing_state
    PUSHI 2
    CMPEQ
    JZ tick_end

    LOAD_SELF 0
    LOAD_SELF 2
    ADD
    STORE_SELF 0
    LOAD_SELF 1
    LOAD_SELF 3
    ADD
    STORE_SELF 1

    LOAD_SELF 0
    LOAD_SELF 1
    GETTILE
    TILE_SURFACE
    STOREG g_scratch
    LOADG g_scratch
    PUSHI 2
    CMPEQ
    JZ chk_rough
    PUSHC FRICTION_FAIRWAY
    STOREG g_friction
    JMP fric_done
    chk_rough:
    LOADG g_scratch
    PUSHI 3
    CMPEQ
    JZ is_ob
    PUSHC FRICTION_ROUGH
    STOREG g_friction
    JMP fric_done
    is_ob:
    PUSHC FRICTION_OB
    STOREG g_friction
    fric_done:
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

    PUSHI 0
    PUSHI 0
    LOAD_SELF 2
    LOAD_SELF 3
    DIST
    STOREG g_scratch
    LOADG g_scratch
    PUSHC STOP_EPS
    CMPLT
    JZ tick_end

    PUSHI 0
    STORE_SELF 2
    PUSHI 0
    STORE_SELF 3
    LOAD_SELF 0
    LOAD_SELF 1
    LOADG g_hole_x
    LOADG g_hole_y
    DIST
    STOREG g_scratch
    LOADG g_scratch
    PUSHC HOLE_RADIUS
    CMPLT
    JZ not_holed
    PUSHI 1
    STOREG g_won
    ; New best (lower strokes is better, unlike Flappy's high score)?
    ; g_best_strokes doubles as "no record yet" at 0 (see on_init), so
    ; this fires either the first time this cart is ever holed out or
    ; whenever the current run beats a real previous best.
    LOADG g_best_strokes
    PUSHI 0
    CMPEQ
    JNZ new_best
    LOADG g_strokes
    LOADG g_best_strokes
    CMPLT
    JZ tick_end
    new_best:
    LOADG g_strokes
    STOREG g_best_strokes
    LOADG g_strokes
    STORE_PERSIST ${PERSIST_BEST_STROKES}
    JMP tick_end
    not_holed:
    PUSHI 0
    STOREG g_swing_state
    PUSHI 1
    STOREG g_active
    tick_end:
    HALT
  `,
};

function buildMiniGolfCart(){
  // Entity B's ramp (12/15), not the terrain ramp (0-7): the ball has to
  // read as a foreground object against a fairway that's shades of the
  // *terrain* ramp's own hue — two tones of that ramp (the original
  // choice) put the ball in the exact same hue family as the grass
  // under it (DESIGN.md §41). Entity B rather than A because +240deg
  // from this cart's green terrain hue is what lands near red/warm — A
  // would have landed on blue (DESIGN.md §43).
  const ballShapes = [
    {type:SHAPE_ELLIPSE, cx:4, cy:4, rx:3.5, ry:3.5, color:12},
    {type:SHAPE_ELLIPSE, cx:4, cy:4, rx:2.7, ry:2.7, color:15},
  ];
  // Fairway/rough/OB tiles map onto grid ids 1-4 (see buildTrack) via
  // [OB, fairway, rough, tee] — same array-position convention race-car.js
  // uses for its own grass/road/rumble/start tiles.
  const obPixels = hexRowsToPixels(new Array(8).fill('11111111'));
  const fairwayPixels = hexRowsToPixels([
    '55555555','55555555','44444444','44444444',
    '55555555','55555555','44444444','44444444',
  ]);
  const roughPixels = hexRowsToPixels([
    '23232323','32323232','23232323','32323232',
    '23232323','32323232','23232323','32323232',
  ]);
  const teePixels = hexRowsToPixels([
    '79797979','97979797','79797979','97979797',
    '79797979','97979797','79797979','97979797',
  ]);
  // The hole's own tile (TILE_CHECKPOINT, id 5 — DESIGN.md §49 split this
  // off from the tee's own id 4 specifically so the two could look
  // different; this cart just reused the tee's own checkered pattern for
  // both at the time, which was exactly the "what's the lighter patch at
  // the end of the track, is that the tee again?" confusion reported
  // afterward). A real dark, roughly round hole instead: fairway-shade
  // corners so it blends into the surrounding turf rather than reading as
  // its own tile, a mid ring, and a near-black center — genuinely hole-
  // shaped rather than a second checkered marker.
  const holePixels = hexRowsToPixels([
    '55555555','54444445','54000045','40000004',
    '40000004','54000045','54444445','55555555',
  ]);

  const T = TRACK_TOKENS;
  const S = n => new Array(n).fill(T.STRAIGHT);
  // A simple dogleg-right hole: tee, three straights, a right turn, two
  // more straights, hole — validated (grid bounds, checkpoint positions,
  // tile-id distribution) against buildTrack() directly before writing
  // any hook code that depends on it.
  const trackWidth = 5, segLen = 6;
  const tokens = [T.START_FINISH, ...S(3), T.CURVE_R90, ...S(2), T.CHECKPOINT];
  const gridW = 40, gridH = 30, startGX = 4, startGY = 14, startDir = 0;
  const screenW = 160, screenH = 160;
  const track = {tokens, trackWidth, segLen, startGX, startGY, startDir, gridW, gridH};

  // Tilemap authoring — shape layers (DESIGN.md §74). buildTrack() is a
  // pure function of `track` above (no RNG, unlike the cave generator),
  // so calling it once here at cart-build time gives the exact same hole
  // position the runtime will compute later, with no need to hand-derive
  // or hand-verify it separately — the same discipline as everywhere
  // else in this file that validates geometry "against buildTrack()
  // directly" rather than by inspection. checkpoints[1] is the hole (see
  // on_init's own comment on checkpoint indices).
  const {x: holePx, y: holePy} = buildTrack(track).checkpoints[1];
  const holeGX = Math.floor(holePx / 8), holeGY = Math.floor(holePy / 8);
  // buildTrack's own CHECKPOINT stamp always marks a full trackWidth-wide
  // line, edge to edge across the fairway — the same "gate," not
  // "single point," convention every other checkpoint/tee marker on this
  // generator uses. For an actual hole that reads wrong twice over: it
  // looks like landing anywhere across the whole width (including right
  // at the rumble edge) sinks the putt, when only the exact centerline
  // tile really does. Two shapes, later wins on overlap: revert the
  // whole trackWidth-wide line to fairway (id 2), then restamp just the
  // centerline tile back to the hole graphic (id 5, TILE_CHECKPOINT) —
  // leaving one real hole, at the fairway's actual centerline, not its
  // edge. This course's fixed dogleg geometry reaches the hole heading
  // +y, so the gate runs horizontally (x varies, y fixed).
  const mapShapes = [
    {tileX0: holeGX - Math.floor(trackWidth/2), tileY0: holeGY, tileX1: holeGX + Math.floor(trackWidth/2) + 1, tileY1: holeGY + 1, tileId: 2},
    {tileX0: holeGX, tileY0: holeGY, tileX1: holeGX + 1, tileY1: holeGY + 1, tileId: 5},
  ];

  const cart = {
    formatVersion: 4,
    name: 'Mini Golf', author: 'Urlcade', // URL envelope only, see DESIGN.md §34 — never reaches the binary format
    cartType: 2, // advisory label only — see DESIGN.md §14 (same "racer/golf" family label the actual racer uses)
    // Terrain hue 100 (green fairway). Entity hue hint ~357 (red) for
    // the ball/flag — DESIGN.md §44.
    paletteParams: [100, 0, 20, 60, 15, 85, 107, 254],
    rngSeed: 1,
    modeFlags: 0,
    screenW, screenH,
    backdropFillIndex: 0, backdropGroundHeight: 0, backdropGroundIndex: 0, // unused — the map covers the whole frame
    tileSurfaceOverrides: {4: 2, 5: 2}, // tee (4) and hole (5, DESIGN.md §49) both behave like fairway for friction purposes
    // Action bit is 4 (not 16) — TOUCH_TEMPLATE_STEER_ACTION's on-screen
    // action button is hardcoded to send bit 4 (see runtime.js's
    // buildTouchControlsHTML), matching the racer's own on_input, which
    // reads the same template's action button as TESTBIT 2. A cart is
    // free to use any button for "action" with other touch templates,
    // but STEER_ACTION specifically means bit 4 — this shipped with bit
    // 16 at first (works from a keyboard's spacebar, since that's wired
    // to bit 16 regardless of template, but not from the on-screen
    // button an actual touch player taps) — see DESIGN.md §38.
    inputActiveButtons: 1 | 2 | 4, // left, right, action
    inputTouchTemplate: TOUCH_TEMPLATE_STEER_ACTION,
    inputButtonLabels: {1: 'Aim', 2: 'Aim', 4: 'Swing'},
    hudSpec: [
      {kind:0, sourceKind:0, srcA:GOLF_GLOBAL_NAMES.g_strokes, srcB:0, delta:0, suffixConstIdx:255, clamp:0, label:'Strokes'},
      // kind:2 (shown only while nonzero) rather than kind:0 — 0 doubles
      // as "no best recorded yet" (see on_init/on_tick), so this line
      // simply doesn't exist until the course has actually been holed
      // out once, instead of misleadingly reading "Best: 0".
      {kind:2, sourceKind:0, srcA:GOLF_GLOBAL_NAMES.g_best_strokes, srcB:0, delta:0, suffixConstIdx:255, clamp:0, label:'Best: '},
      {kind:1, sourceKind:0, srcA:GOLF_GLOBAL_NAMES.g_won, srcB:0, delta:0, suffixConstIdx:255, label:'Holed out! Refresh to play again'},
    ],
    // MAX_POWER=6px/tick, POWER_STEP=0.15/tick (a full 0->max->0 sweep is
    // ~80 ticks, ~1.3s — a real timing window, not a blink-and-you-miss
    // one). Friction values tuned (and headlessly verified) so a full-power
    // fairway shot travels a satisfying distance and actually comes to
    // rest rather than crawling forever. HOLE_RADIUS=12 (was 6 — smaller
    // than the ball's own 3px radius, so the ball's *center* had to land
    // almost exactly on the hole's center to sink; see DESIGN.md §39).
    constants: [6, 0.15, 2, 0.035, 0.12, 0.35, 0.15, 12],
    // Flag is renderKind:2 (custom on_draw, DESIGN.md §36/§53) rather
    // than a static sprite — an actual flagpole-and-pennant drawn fresh
    // from lines each frame, the same "draw it, don't sprite it"
    // technique Water the Plant already uses for its stem, instead of a
    // flat rectangle that read as exactly that: an unlabeled colored
    // rectangle, not obviously a flag at all.
    entityTypes: [
      {renderKind:0, assetIndex:0, rotateFlag:0, collisionW:6, collisionH:6, extFieldCount:0}, // 0: ball
      {renderKind:2, assetIndex:0, rotateFlag:0, collisionW:2, collisionH:2, extFieldCount:0}, // 1: flag, see on_draw
    ],
    sprites: [
      {kind:1, w:8, h:8, shapes:ballShapes},
    ],
    // The 5th tile is TILE_CHECKPOINT (id 5, split from TILE_STARTLINE/id
    // 4 in DESIGN.md §49 specifically so the two could look different) —
    // this course's CHECKPOINT token is the hole, now drawn as a real
    // dark, roughly round hole (holePixels, DESIGN.md §53) instead of
    // reusing the tee's own checkered pattern, which read as a second tee
    // rather than a hole.
    tiles: [
      {w:8, h:8, pixels:obPixels}, {w:8, h:8, pixels:fairwayPixels},
      {w:8, h:8, pixels:roughPixels}, {w:8, h:8, pixels:teePixels},
      {w:8, h:8, pixels:holePixels},
    ],
    mapGenerator: 1,
    track,
    mapShapes,
    camera: {
      followGlobal: GOLF_GLOBAL_NAMES.g_ball,
      clampMinX: 0, clampMinY: 0,
      clampMaxX: Math.max(0, gridW*8 - screenW),
      clampMaxY: Math.max(0, gridH*8 - screenH),
    },
    aimLine: {
      anchorXGlobal: GOLF_GLOBAL_NAMES.g_aim_x, anchorYGlobal: GOLF_GLOBAL_NAMES.g_aim_y,
      angleGlobal: GOLF_GLOBAL_NAMES.g_angle, powerGlobal: GOLF_GLOBAL_NAMES.g_power,
      maxPowerConstIdx: GOLF_CONST_NAMES.MAX_POWER, activeGlobal: GOLF_GLOBAL_NAMES.g_active,
      colorIdx: 9, maxLengthPx: 40,
    },
    hooks: {},
  };
  for(const name of HOOK_NAMES){
    const src = GOLF_HOOKS_SRC[name];
    cart.hooks[name] = src ? assemble(src.split('\n'), GOLF_SYM) : new Uint8Array(0);
  }
  return cart;
}

export { buildMiniGolfCart };
