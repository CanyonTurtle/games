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
  TRACK_TOKENS,
} = K;
import { hexRowsToPixels } from './shared-sprites.js';

const GOLF_CONST_NAMES = {
  MAX_POWER:0, POWER_STEP:1, ANGLE_STEP:2, FRICTION_FAIRWAY:3, FRICTION_ROUGH:4,
  FRICTION_OB:5, STOP_EPS:6, HOLE_RADIUS:7,
};
const GOLF_GLOBAL_NAMES = {
  g_ball:0, g_swing_state:1, g_angle:2, g_power:3, g_power_dir:4, g_strokes:5,
  g_won:6, g_hole_x:7, g_hole_y:8, g_scratch:9, g_prev_input:10, g_aim_x:11,
  g_aim_y:12, g_active:13, g_friction:14,
};
const GOLF_SYM = {constants:GOLF_CONST_NAMES, globals:GOLF_GLOBAL_NAMES};

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
    TESTBIT 4
    JZ store_prev
    LOADG g_prev_input
    TESTBIT 4
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
    TESTBIT 4
    JZ store_prev
    LOADG g_prev_input
    TESTBIT 4
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
  // Only the ball (type 0) does anything here — the flag (type 1) is
  // static. Integrates position, applies friction by tile surface
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
  const ballShapes = [
    {type:SHAPE_ELLIPSE, cx:4, cy:4, rx:3.5, ry:3.5, color:1},
    {type:SHAPE_ELLIPSE, cx:4, cy:4, rx:2.7, ry:2.7, color:7},
  ];
  const flagShapes = [
    {type:SHAPE_RECT, x:4, y:0, w:1, h:16, color:0},
    {type:SHAPE_RECT, x:5, y:1, w:5, h:4, color:9},
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

  const cart = {
    formatVersion: 2,
    name: 'Mini Golf', author: 'Urlcade', // URL envelope only, see DESIGN.md §34 — never reaches the binary format
    cartType: 2, // advisory label only — see DESIGN.md §14 (same "racer/golf" family label the actual racer uses)
    paletteMode: 1, // procedural harmony — green fairway ramp (0-7) + a warm accent ramp (8-15) for the flag/ball/tee
    paletteParams: [100, 0, 20, 60, 15, 85, 280, 0],
    rngSeed: 1,
    modeFlags: 0,
    screenW, screenH,
    backdropFillIndex: 0, backdropGroundHeight: 0, backdropGroundIndex: 0, // unused — the map covers the whole frame
    tileSurfaceOverrides: {4: 2}, // tee behaves exactly like fairway for friction purposes
    inputActiveButtons: 1 | 2 | 16, // left, right, action
    inputTouchTemplate: TOUCH_TEMPLATE_STEER_ACTION,
    inputButtonLabels: {1: 'Aim', 2: 'Aim', 16: 'Swing'},
    hudSpec: [
      {kind:0, sourceKind:0, srcA:GOLF_GLOBAL_NAMES.g_strokes, srcB:0, delta:0, suffixConstIdx:255, clamp:0, label:'Strokes'},
      {kind:1, sourceKind:0, srcA:GOLF_GLOBAL_NAMES.g_won, srcB:0, delta:0, suffixConstIdx:255, label:'Holed out! Refresh to play again'},
    ],
    // MAX_POWER=6px/tick, POWER_STEP=0.15/tick (a full 0->max->0 sweep is
    // ~80 ticks, ~1.3s — a real timing window, not a blink-and-you-miss
    // one). Friction values tuned (and headlessly verified) so a full-power
    // fairway shot travels a satisfying distance and actually comes to
    // rest rather than crawling forever.
    constants: [6, 0.15, 2, 0.035, 0.12, 0.35, 0.15, 6],
    entityTypes: [
      {renderKind:0, assetIndex:0, rotateFlag:0, collisionW:6, collisionH:6, extFieldCount:0}, // 0: ball
      {renderKind:0, assetIndex:1, rotateFlag:0, collisionW:2, collisionH:2, extFieldCount:0}, // 1: flag
    ],
    sprites: [
      {kind:1, w:8, h:8, shapes:ballShapes},
      {kind:1, w:10, h:16, shapes:flagShapes},
    ],
    tiles: [
      {w:8, h:8, pixels:obPixels}, {w:8, h:8, pixels:fairwayPixels},
      {w:8, h:8, pixels:roughPixels}, {w:8, h:8, pixels:teePixels},
    ],
    mapGenerator: 1,
    track: {tokens, trackWidth, segLen, startGX, startGY, startDir, gridW, gridH},
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
