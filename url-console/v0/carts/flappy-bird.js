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
  FLAP_FREQ:12, SCORE_FREQ:13,
};
// Voice assignment (DESIGN.md §72) — one persistent voice each, waveform
// picked once in on_init and never changed again, so every trigger site
// only needs to (re)set frequency (if it varies) and fire TRIGGER_VOICE.
const VOICE_FLAP = 0, VOICE_SCORE = 1, VOICE_CRASH = 2;
const FLAPPY_GLOBAL_NAMES = { g_player:0, g_dead:1, g_score:2, g_scratch:3, g_spawn_timer:4, g_gap:5, g_high_score:6 };
// Persist slot 0: this cart's own all-time high score (see
// opcodes.md's Persistence section) — no PERSIST_NAMES convention exists
// yet, so just one commented slot number, same restraint as any raw
// LOAD_SELF/STORE_SELF prop index.
const PERSIST_HIGH_SCORE = 0;
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
    LOAD_PERSIST ${PERSIST_HIGH_SCORE}
    STOREG g_high_score
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
    ; Waveform set at every trigger, not once in on_init — a voice's node
    ; graph (and the AudioContext behind it) is built lazily on first
    ; touch (see runtime.js's _ensureVoice); setting it in on_init would
    ; force that eagerly on every single World construction, even a play
    ; session that turns out silent, defeating the whole point of the
    ; lazy-init discipline. Square, for a short percussive blip.
    SET_VOICE_WAVE ${VOICE_FLAP} 0
    PUSHC FLAP_FREQ
    SET_VOICE_FREQ ${VOICE_FLAP}
    TRIGGER_VOICE ${VOICE_FLAP}
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
    ; Wing-flap frame, picked from vertical velocity every tick rather
    ; than a separate timer: rising (vy<0, right after a flap impulse or
    ; still coasting up from one) shows sprites[1] (wing up), falling
    ; shows sprites[0] (wing down/resting). This writes the bird's own
    ; current assetIndex (props[8], extFieldCount:0 so 8 + 0 — see
    ; spawnEntity in runtime.js), not entityTypes[0].assetIndex, which
    ; stays the spawn-time default.
    LOAD_SELF 3
    PUSHI 0
    CMPLT
    JZ wing_down
    PUSHI 1
    STORE_SELF 8
    JMP wing_done
    wing_down:
    PUSHI 0
    STORE_SELF 8
    wing_done:
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
    SET_VOICE_WAVE ${VOICE_SCORE} 3
    PUSHC SCORE_FREQ
    SET_VOICE_FREQ ${VOICE_SCORE}
    TRIGGER_VOICE ${VOICE_SCORE}
    ; New high score? g_high_score starts this run at whatever on_init
    ; loaded (0 on a first-ever play), so this compares against last
    ; run's best the moment it's first beaten — then, since g_high_score
    ; itself gets updated right below, keeps comparing against the
    ; *current* run's own growing best from then on, firing (and
    ; persisting) again each further point past it, not just once.
    LOADG g_score
    LOADG g_high_score
    CMPLE
    JNZ tick_end
    LOADG g_score
    STOREG g_high_score
    LOADG g_score
    STORE_PERSIST ${PERSIST_HIGH_SCORE}
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
    ; Only trigger the crash sound on the tick g_dead actually transitions
    ; 0->1 — the bird keeps falling and can stay overlapping the pipe for
    ; several further ticks (on_tick's bird branch doesn't check g_dead),
    ; which would otherwise re-fire on_collide, and this trigger, every
    ; tick until it clears.
    LOADG g_dead
    JNZ already_dead
    SET_VOICE_WAVE ${VOICE_CRASH} 2
    TRIGGER_VOICE ${VOICE_CRASH}
    already_dead:
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
  // eye) come from entity A's 4-color ramp (8-11), hinted yellow — see
  // the cart's own palette comment below and DESIGN.md §44. 8 is the
  // ramp's shared near-black ink shade, doing double duty as outline
  // and pupil; 9 is the ramp's most saturated step (hue-shifted warmer),
  // used for the wing/beak accent; 10 is the ramp's mid step (closer to
  // the ramp's actual hinted hue), used for the main body fill, so wing
  // and body read as two distinctly different swatches rather than two
  // adjacent shades of the same color; 11 is the palest, least-saturated
  // step, used for the eye highlight.
  const birdShapes = [
    {type:SHAPE_ELLIPSE, cx:7.6,cy:8.3, rx:6.3,ry:6.4, color:8},
    {type:SHAPE_ELLIPSE, cx:7.6,cy:8.3, rx:6.0,ry:6.1, color:10},
    {type:SHAPE_ELLIPSE, cx:6.0,cy:10.4, rx:3.3,ry:2.2, color:9},
    {type:SHAPE_ELLIPSE, cx:13.6,cy:7.9, rx:2.2,ry:1.3, color:9},
    {type:SHAPE_ELLIPSE, cx:10.1,cy:5.3, rx:1.8,ry:1.8, color:11},
    {type:SHAPE_ELLIPSE, cx:10.9,cy:5.4, rx:0.9,ry:0.9, color:8},
  ];
  // Wing-up pose for the flap cycle (sprites[1]) — identical outline,
  // body, beak, eye, and pupil to birdShapes; only the wing ellipse
  // (shape index 2) moves, up and in from its resting position below the
  // body to above-and-beside it, narrower and taller to read as raised
  // rather than just relocated. Which frame shows is picked every tick
  // from vertical velocity (see on_tick below) — this is the entity's own
  // current per-instance assetIndex (props[8 + extFieldCount], written
  // via STORE_SELF), not entityTypes[0].assetIndex, which stays the
  // spawn-time default (frame 0, wing down).
  const birdShapesUp = [
    {type:SHAPE_ELLIPSE, cx:7.6,cy:8.3, rx:6.3,ry:6.4, color:8},
    {type:SHAPE_ELLIPSE, cx:7.6,cy:8.3, rx:6.0,ry:6.1, color:10},
    {type:SHAPE_ELLIPSE, cx:6.2,cy:4.8, rx:2.6,ry:3.2, color:9},
    {type:SHAPE_ELLIPSE, cx:13.6,cy:7.9, rx:2.2,ry:1.3, color:9},
    {type:SHAPE_ELLIPSE, cx:10.1,cy:5.3, rx:1.8,ry:1.8, color:11},
    {type:SHAPE_ELLIPSE, cx:10.9,cy:5.4, rx:0.9,ry:0.9, color:8},
  ];
  // Pipes drawn from entity B's ramp (12-15), not the terrain ramp —
  // this cart's terrain hue is the *sky*, not the pipes (see the cart's
  // palette comment below), so pipe pixels point at entity B's indices
  // (12=edge/dark, 13=fill, 15=highlight band) instead of the classic
  // 4/5/6 terrain shades every other cart's tiles use.
  const pipeBody = hexRowsToPixels([
    'cccccccc','cddddddc','cddddddc','cddffddc',
    'cddddddc','cddddddc','cddddddc','cccccccc',
  ]);
  const pipeCap = hexRowsToPixels([
    'cccccccc','cffffffc','cffffffc','cddddddc',
    'cddddddc','cddddddc','cddddddc','cccccccc',
  ]);
  const cart = {
    formatVersion: 3,
    name: 'Flappy Bird', author: 'Urlcade', // URL envelope only, see DESIGN.md §34 — never reaches the binary format
    cartType: 63, // advisory label only — see DESIGN.md §14
    // Terrain hue 210 (blue) is the *sky* here, not pipes/ground the way
    // every other cart's terrain ramp doubles as its obstacle color —
    // entity B is borrowed as a second backdrop hue instead (DESIGN.md
    // §44's "any of the three ramps can be repurposed" note). Hints:
    // entity A ~54 (yellow, the bird) and entity B ~130 (green, the
    // pipes/ground) — the actual classic scheme, all three mutually
    // reachable at once specifically because MIN_HUE_SEPARATION was
    // tuned down from an earlier draft's 100 to 70 (yellow and green
    // sit ~70-80deg apart on the wheel; a 100deg floor made this exact,
    // legitimate combination provably impossible no matter what hints
    // were chosen — DESIGN.md §44).
    paletteParams: [210, 0, 20, 55, 20, 85, 38, 92],
    rngSeed: 42,
    modeFlags: 0,
    screenW: 160,
    screenH: 160, // square, matches every other cart now — see DESIGN.md §18
    mapGenerator: 0, // no tilemap — the backdrop generator covers the frame
    backdropFillIndex: 7,   // lightest terrain shade (blue) — open sky
    backdropGroundHeight: 16,
    backdropGroundIndex: 12, // entity B's darkest shade (green) — ground, matching the pipes
    inputActiveButtons: 16, // action bit only
    inputTouchTemplate: TOUCH_TEMPLATE_SINGLE,
    inputButtonLabels: {16: 'Flap'},
    hudSpec: [
      {kind:0, sourceKind:0, srcA:FLAPPY_GLOBAL_NAMES.g_score, srcB:0, delta:0, suffixConstIdx:255, label:'Score'},
      {kind:0, sourceKind:0, srcA:FLAPPY_GLOBAL_NAMES.g_high_score, srcB:0, delta:0, suffixConstIdx:255, label:'Best'},
      {kind:1, sourceKind:0, srcA:FLAPPY_GLOBAL_NAMES.g_dead, srcB:0, delta:0, suffixConstIdx:255, label:'Crashed - refresh link to retry'},
    ],
    // GRAVITY/FLAP_IMPULSE/SCROLL_SPEED halved and SPAWN_PERIOD doubled vs
    // the original 30Hz tuning — the sim now runs at 60Hz (see the loop()
    // comment near render()), so per-tick rates are rescaled to keep the
    // same *real-time* feel; only the render smoothness changed, not the pace.
    // GAP_SIZE/GAP_MIN_Y/GAP_MAX_Y/BIRD_START_Y retuned for the shorter
    // 160px-tall square screen (was 220 tall) — see DESIGN.md §18.
    constants: [0.175, -1.6, 1.0, 32, 14, 88, 140, 160, 160, 40, 70, 16, 660, 990],
    entityTypes: [
      {renderKind:0, assetIndex:0, rotateFlag:0, collisionW:8, collisionH:8, extFieldCount:0},
      {renderKind:1, assetIndex:0, rotateFlag:0, collisionW:8, collisionH:0, extFieldCount:3},
    ],
    sprites: [ {kind:1, w:16, h:16, shapes:birdShapes}, {kind:1, w:16, h:16, shapes:birdShapesUp} ],
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
