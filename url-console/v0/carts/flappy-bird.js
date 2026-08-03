/* ============================================================
   The Urlcade — example cart: Flappy Bird
   (see url-console/examples/flappy-bird.md for the original worked
   design writeup — header, palette, constant pool, entity type table,
   sprite/tile bitmaps, and complete per-hook bytecode listing)
   ============================================================ */
"use strict";
const K = window.UrlcadeKernel;
const { assemble, HOOK_NAMES, TOUCH_TEMPLATE_SINGLE, SHAPE_ELLIPSE } = K;
import { hexRowsToPixels } from './shared-sprites.js';

/* ============================================================
   8. Cart authoring — Flappy Bird (see url-console/examples/flappy-bird.md)
   ============================================================ */
const FLAPPY_CONST_NAMES = {
  GRAVITY:0, FLAP_IMPULSE:1, SCROLL_SPEED:2, GAP_SIZE:3, GAP_MIN_Y:4, GAP_MAX_Y:5,
  SPAWN_PERIOD:6, SCREEN_H:7, SCREEN_W:8, BIRD_START_X:9, BIRD_START_Y:10, GROUND_MARGIN:11,
};
const FLAPPY_GLOBAL_NAMES = { g_player:0, g_dead:1, g_score:2, g_scratch:3, g_spawn_timer:4, g_gap:5 };
const FLAPPY_SYM = {constants:FLAPPY_CONST_NAMES, globals:FLAPPY_GLOBAL_NAMES};

const FLAPPY_HOOKS_SRC = {
  on_init: `
    SPAWN 0
    STOREG g_player
    PUSHC BIRD_START_X
    STOREE g_player 0
    PUSHC BIRD_START_Y
    STOREE g_player 1
    PUSHI 0
    STOREG g_dead
    PUSHI 0
    STOREG g_score
    PUSHC SPAWN_PERIOD
    STOREG g_spawn_timer
    HALT
  `,
  on_input: `
    LOADG g_dead
    JNZ done
    LOAD_INPUT
    TESTBIT 4
    JZ done
    PUSHC FLAP_IMPULSE
    STOREE g_player 3
    done:
    HALT
  `,
  on_frame: `
    LOADG g_dead
    JNZ done
    LOADG g_spawn_timer
    PUSHI 1
    SUB
    DUP
    STOREG g_spawn_timer
    JNZ done
    PUSHC SPAWN_PERIOD
    STOREG g_spawn_timer
    PUSHC GAP_MIN_Y
    PUSHC GAP_MAX_Y
    RAND_RANGE
    STOREG g_gap
    SPAWN 1
    STOREG g_scratch
    PUSHC SCREEN_W
    STOREE g_scratch 0
    PUSHI 0
    STOREE g_scratch 1
    LOADG g_gap
    PUSHI 8
    DIV
    STOREE g_scratch 8
    PUSHI 0
    STOREE g_scratch 9
    PUSHI 1
    STOREE g_scratch 10
    SPAWN 1
    STOREG g_scratch
    PUSHC SCREEN_W
    STOREE g_scratch 0
    LOADG g_gap
    PUSHC GAP_SIZE
    ADD
    STOREE g_scratch 1
    PUSHC SCREEN_H
    LOADG g_gap
    PUSHC GAP_SIZE
    ADD
    SUB
    PUSHI 8
    DIV
    STOREE g_scratch 8
    PUSHI 0
    STOREE g_scratch 9
    PUSHI 0
    STOREE g_scratch 10
    done:
    HALT
  `,
  on_tick: `
    LOAD_SELF 4
    PUSHI 1
    CMPEQ
    JNZ tick_pipe
    LOAD_SELF 3
    PUSHC GRAVITY
    ADD
    STORE_SELF 3
    LOAD_SELF 1
    LOAD_SELF 3
    ADD
    STORE_SELF 1
    LOAD_SELF 1
    PUSHI 0
    CMPLT
    LOAD_SELF 1
    PUSHC SCREEN_H
    PUSHC GROUND_MARGIN
    SUB
    CMPGT
    OR
    JZ tick_end
    PUSHI 1
    STOREG g_dead
    JMP tick_end
    tick_pipe:
    LOADG g_dead
    JNZ tick_end
    LOAD_SELF 0
    PUSHC SCROLL_SPEED
    SUB
    STORE_SELF 0
    LOAD_SELF 0
    PUSHI -16
    CMPLT
    JZ check_score
    KILL_SELF
    JMP tick_end
    check_score:
    LOAD_SELF 9
    JNZ tick_end
    LOAD_SELF 0
    LOADE g_player 0
    CMPLT
    JZ tick_end
    PUSHI 1
    STORE_SELF 9
    LOADG g_score
    PUSHI 1
    ADD
    STOREG g_score
    tick_end:
    HALT
  `,
  on_collide: `
    LOAD_A 4
    PUSHI 0
    CMPEQ
    LOAD_B 4
    PUSHI 1
    CMPEQ
    AND
    JNZ crash
    LOAD_A 4
    PUSHI 1
    CMPEQ
    LOAD_B 4
    PUSHI 0
    CMPEQ
    AND
    JNZ crash
    JMP done
    crash:
    PUSHI 1
    STOREG g_dead
    done:
    HALT
  `,
};

function buildFlappyCart(){
  // Round body (outline ring + fill), an inset wing patch, a stubby beak
  // (an elongated ellipse rather than a sharp wedge — see the "why only
  // two primitives" note above), and a white eye with a dark pupil. All
  // four distinct shades this needs (outline/pupil, body, wing/beak,
  // eye) come from entity-A's 4-color ramp (8-11) — see DESIGN.md §43:
  // this cart used to select a hand-picked bank instead of computing its
  // colors, the last of three that did.
  const birdShapes = [
    {type:SHAPE_ELLIPSE, cx:7.6,cy:8.3, rx:6.3,ry:6.4, color:8},
    {type:SHAPE_ELLIPSE, cx:7.6,cy:8.3, rx:6.0,ry:6.1, color:9},
    {type:SHAPE_ELLIPSE, cx:6.0,cy:10.4, rx:3.3,ry:2.2, color:10},
    {type:SHAPE_ELLIPSE, cx:13.6,cy:7.9, rx:2.2,ry:1.3, color:10},
    {type:SHAPE_ELLIPSE, cx:10.1,cy:5.3, rx:1.8,ry:1.8, color:11},
    {type:SHAPE_ELLIPSE, cx:10.9,cy:5.4, rx:0.9,ry:0.9, color:8},
  ];
  const pipeBody = hexRowsToPixels([
    '44444444','45555554','45555554','45566554',
    '45555554','45555554','45555554','44444444',
  ]);
  const pipeCap = hexRowsToPixels([
    '44444444','46666664','46666664','45555554',
    '45555554','45555554','45555554','44444444',
  ]);
  const cart = {
    formatVersion: 3,
    name: 'Flappy Bird', author: 'Urlcade', // URL envelope only, see DESIGN.md §34 — never reaches the binary format
    cartType: 63, // advisory label only — see DESIGN.md §14
    // Terrain hue 100 (green) — pipes (indices 4/5/6, unchanged pixel
    // data below) and ground (index 0) share this one hue family, same
    // constraint every other procedural cart already lives with (DESIGN.md
    // §41/§43). Entity A's fixed +120deg anchor lands the bird at ~220
    // (blue) — not the original yellow, but "bluebird over green pipes"
    // reads as its own coherent, pleasant palette rather than a
    // compromise; the whole point of the collapse to one algorithm was
    // accepting exactly this kind of reinterpretation in exchange for
    // guaranteed contrast (DESIGN.md §43).
    paletteParams: [100, 0, 20, 55, 20, 85, 128, 128],
    rngSeed: 42,
    modeFlags: 0,
    screenW: 160,
    screenH: 160, // square, matches every other cart now — see DESIGN.md §18
    mapGenerator: 0, // no tilemap — the backdrop generator covers the frame
    backdropFillIndex: 7,   // lightest terrain shade — reads as open sky
    backdropGroundHeight: 16,
    backdropGroundIndex: 0, // darkest terrain shade — ground
    inputActiveButtons: 16, // action bit only
    inputTouchTemplate: TOUCH_TEMPLATE_SINGLE,
    inputButtonLabels: {16: 'Flap'},
    hudSpec: [
      {kind:0, sourceKind:0, srcA:FLAPPY_GLOBAL_NAMES.g_score, srcB:0, delta:0, suffixConstIdx:255, label:'Score'},
      {kind:1, sourceKind:0, srcA:FLAPPY_GLOBAL_NAMES.g_dead, srcB:0, delta:0, suffixConstIdx:255, label:'Crashed - refresh link to retry'},
    ],
    // GRAVITY/FLAP_IMPULSE/SCROLL_SPEED halved and SPAWN_PERIOD doubled vs
    // the original 30Hz tuning — the sim now runs at 60Hz (see the loop()
    // comment near render()), so per-tick rates are rescaled to keep the
    // same *real-time* feel; only the render smoothness changed, not the pace.
    // GAP_SIZE/GAP_MIN_Y/GAP_MAX_Y/BIRD_START_Y retuned for the shorter
    // 160px-tall square screen (was 220 tall) — see DESIGN.md §18.
    constants: [0.175, -1.6, 1.0, 32, 14, 88, 140, 160, 160, 40, 70, 16],
    entityTypes: [
      {renderKind:0, assetIndex:0, rotateFlag:0, collisionW:8, collisionH:8, extFieldCount:0},
      {renderKind:1, assetIndex:0, rotateFlag:0, collisionW:8, collisionH:0, extFieldCount:3},
    ],
    sprites: [ {kind:1, w:16, h:16, shapes:birdShapes} ],
    tiles: [ {w:8,h:8,pixels:pipeBody}, {w:8,h:8,pixels:pipeCap} ],
    hooks: {},
  };
  for(const name of HOOK_NAMES){
    const src = FLAPPY_HOOKS_SRC[name];
    cart.hooks[name] = src ? assemble(src.split('\n'), FLAPPY_SYM) : new Uint8Array(0);
  }
  return cart;
}

export { buildFlappyCart };
