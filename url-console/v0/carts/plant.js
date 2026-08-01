/* ============================================================
   The Urlcade — example cart: Water the Plant

   The first cart to use both of DESIGN.md §36's new primitives: pointer
   input (drag anywhere on the canvas to drop water) and immediate-mode
   drawing (the plant is never a baked sprite — it's a renderKind:2
   entity whose on_draw hook draws it fresh, from lines, every frame,
   reading how much it's been watered straight out of a global).
   ============================================================ */
"use strict";
const K = window.UrlcadeKernel;
const { assemble, HOOK_NAMES, TOUCH_TEMPLATE_NONE, SHAPE_ELLIPSE } = K;

const PLANT_CONST_NAMES = {
  DROP_FALL_SPEED:0, SOIL_Y:1, WIN_THRESHOLD:2, DROP_SPAWN_INTERVAL:3, DROP_START_Y:4,
  PLANT_X:5, STEM_STEP:6, MAX_STEM_H:7, BRANCH_UNLOCK_1:8, BRANCH_UNLOCK_2:9, BRANCH_LEN:10,
};
const PLANT_GLOBAL_NAMES = { g_plant:0, g_water:1, g_won:2, g_drag_timer:3, g_scratch:4 };
const PLANT_SYM = {constants:PLANT_CONST_NAMES, globals:PLANT_GLOBAL_NAMES};

const PLANT_HOOKS_SRC = {
  on_init: `
    SPAWN 1
    STOREG g_plant
    PUSHC PLANT_X
    STOREE g_plant 0
    PUSHC SOIL_Y
    STOREE g_plant 1
    PUSHI 0
    STOREG g_water
    PUSHI 0
    STOREG g_won
    PUSHI 0
    STOREG g_drag_timer
    HALT
  `,
  // Drag-to-water: while the pointer is held down, drop a water entity at
  // the current pointer x every DROP_SPAWN_INTERVAL ticks (throttled by a
  // simple down-counter, reset to 0 the instant the pointer isn't down so
  // the *next* press always spawns immediately rather than waiting out
  // whatever the counter happened to be mid-drag).
  on_input: `
    LOADG g_won
    JNZ reset_timer
    LOAD_POINTER_DOWN
    JZ reset_timer
    LOADG g_drag_timer
    PUSHI 0
    CMPGT
    JNZ still_waiting
    PUSHC DROP_SPAWN_INTERVAL
    STOREG g_drag_timer
    SPAWN 0
    STOREG g_scratch
    LOAD_POINTER_X
    STOREE g_scratch 0
    PUSHC DROP_START_Y
    STOREE g_scratch 1
    PUSHI 0
    STOREE g_scratch 2
    PUSHC DROP_FALL_SPEED
    STOREE g_scratch 3
    JMP done
    still_waiting:
    LOADG g_drag_timer
    PUSHI 1
    SUB
    STOREG g_drag_timer
    JMP done
    reset_timer:
    PUSHI 0
    STOREG g_drag_timer
    done:
    HALT
  `,
  // Only water drops (type 0) do anything here — the plant (type 1) grows
  // purely by reading g_water in its own on_draw, no per-tick state of its
  // own needed. A drop that reaches the soil line is absorbed: it kills
  // itself and increments g_water (and g_won, once past the threshold) —
  // no on_collide needed at all for this mechanic, just a y comparison.
  on_tick: `
    LOAD_SELF 4
    PUSHI 0
    CMPEQ
    JZ tick_end
    LOAD_SELF 1
    LOAD_SELF 3
    ADD
    STORE_SELF 1
    LOAD_SELF 1
    PUSHC SOIL_Y
    CMPLT
    JNZ tick_end
    KILL_SELF
    LOADG g_water
    PUSHI 1
    ADD
    DUP
    STOREG g_water
    PUSHC WIN_THRESHOLD
    CMPLT
    JNZ tick_end
    PUSHI 1
    STOREG g_won
    tick_end:
    HALT
  `,
  // Immediate-mode: runs at render time against the plant entity (self),
  // never at tick time — see kernel.js's HOOK_NAMES comment. Stem height
  // is a pure function of g_water (clamped to MAX_STEM_H), stashed in the
  // plant's own ext field 8 via STORE_SELF/LOAD_SELF exactly like any
  // other per-entity scratch value, then reused by every DRAW_LINE below
  // that needs it — on_draw isn't a different kind of hook, just one that
  // happens to run on a different clock. Side branches unlock at
  // BRANCH_UNLOCK_1 waterings, a small bloom at BRANCH_UNLOCK_2 — the
  // plant visibly grows in real time as its own global changes, not in
  // discrete sprite-swap stages.
  on_draw: `
    LOADG g_water
    PUSHC STEM_STEP
    MUL
    PUSHC MAX_STEM_H
    CLAMP_ABS
    STORE_SELF 8
    PUSHI 0
    PUSHI 0
    PUSHI 0
    LOAD_SELF 8
    NEG
    PUSHI 5
    DRAW_LINE
    LOADG g_water
    PUSHC BRANCH_UNLOCK_1
    CMPLT
    JNZ after_branches
    PUSHI 0
    LOAD_SELF 8
    PUSHI 2
    DIV
    NEG
    PUSHC BRANCH_LEN
    NEG
    LOAD_SELF 8
    PUSHI 2
    DIV
    PUSHC BRANCH_LEN
    ADD
    NEG
    PUSHI 5
    DRAW_LINE
    PUSHI 0
    LOAD_SELF 8
    PUSHI 2
    DIV
    NEG
    PUSHC BRANCH_LEN
    LOAD_SELF 8
    PUSHI 2
    DIV
    PUSHC BRANCH_LEN
    ADD
    NEG
    PUSHI 5
    DRAW_LINE
    after_branches:
    LOADG g_water
    PUSHC BRANCH_UNLOCK_2
    CMPLT
    JNZ done
    PUSHI -6
    LOAD_SELF 8
    NEG
    PUSHI 6
    SUB
    PUSHI 6
    LOAD_SELF 8
    NEG
    PUSHI 6
    ADD
    PUSHI 2
    DRAW_LINE
    PUSHI 6
    LOAD_SELF 8
    NEG
    PUSHI 6
    SUB
    PUSHI -6
    LOAD_SELF 8
    NEG
    PUSHI 6
    ADD
    PUSHI 2
    DRAW_LINE
    done:
    HALT
  `,
};

function buildPlantCart(){
  // color:7 (white) — deliberately *not* 8 (sky blue), even though sky
  // blue reads as "water": that's also backdropFillIndex below, so a drop
  // painted in it would be invisible against its own background. White
  // reads clearly against both the sky and the soil band it falls past.
  const dropShapes = [
    {type:SHAPE_ELLIPSE, cx:3, cy:4, rx:2.5, ry:3.5, color:7},
  ];
  const cart = {
    formatVersion: 2,
    name: 'Water the Plant', author: 'Urlcade', // URL envelope only, see DESIGN.md §34 — never reaches the binary format
    cartType: 6, // advisory label only — see DESIGN.md §14
    paletteMode: 0, // curated bank #0 — same sky/grass bank Flappy Bird uses (DESIGN.md §6): sky blue for the water drop, brown for soil, green for the plant, all already in one bank
    paletteParams: [0,0,0,0,0,0,0,0],
    rngSeed: 1,
    modeFlags: 0,
    screenW: 160,
    screenH: 160,
    mapGenerator: 0,
    backdropFillIndex: 8,   // sky blue
    backdropGroundHeight: 30,
    backdropGroundIndex: 1, // soil brown
    inputActiveButtons: 0,
    inputTouchTemplate: TOUCH_TEMPLATE_NONE, // no discrete buttons at all — dragging on the canvas is the whole interaction
    inputWantsPointer: true,
    inputButtonLabels: {},
    hudSpec: [
      {kind:0, sourceKind:0, srcA:PLANT_GLOBAL_NAMES.g_water, srcB:0, delta:0, suffixConstIdx:PLANT_CONST_NAMES.WIN_THRESHOLD, clamp:1, label:'Watered'},
      {kind:1, sourceKind:0, srcA:PLANT_GLOBAL_NAMES.g_won, srcB:0, delta:0, suffixConstIdx:255, label:'It bloomed! Refresh to grow another'},
    ],
    // WIN_THRESHOLD raised from 8 to 24 and DROP_SPAWN_INTERVAL slowed
    // from 6 to 10 ticks — at 6 drops/sec absorbed (once the ~0.7s fall
    // time's first drop lands) that's ~4s of continuous dragging to fully
    // bloom, not under 1s. STEM_STEP dropped from 9 to 3 to match (still
    // ~MAX_STEM_H/WIN_THRESHOLD, so full growth still lands right at the
    // clamp instead of hitting it almost immediately).
    constants: [3, 130, 24, 10, 8, 80, 3, 70, 6, 14, 18],
    entityTypes: [
      {renderKind:0, assetIndex:0, rotateFlag:0, collisionW:6, collisionH:8, extFieldCount:0}, // 0: water drop
      {renderKind:2, assetIndex:0, rotateFlag:0, collisionW:1, collisionH:1, extFieldCount:1}, // 1: plant — ext 8 = current stem height, see on_draw
    ],
    sprites: [ {kind:1, w:6, h:8, shapes:dropShapes} ],
    tiles: [],
    hooks: {},
  };
  for(const name of HOOK_NAMES){
    const src = PLANT_HOOKS_SRC[name];
    cart.hooks[name] = src ? assemble(src.split('\n'), PLANT_SYM) : new Uint8Array(0);
  }
  return cart;
}

export { buildPlantCart };
