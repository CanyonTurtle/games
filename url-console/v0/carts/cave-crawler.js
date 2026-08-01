/* ============================================================
   The Urlcade — example cart: Cave Crawler (roguelike)
   (see url-console/examples/three-more-carts.md for the original
   design-level writeup this was promoted from; see DESIGN.md §15.1 for
   the two runtime bugs building this for real actually found)
   ============================================================ */
"use strict";
const K = window.UrlcadeKernel;
const {
  assemble, HOOK_NAMES, TOUCH_TEMPLATE_DPAD_ONLY,
  CAVE_WALL, CAVE_FLOOR, CAVE_STAIRS, CAVE_GOLD,
} = K;
import { hexRowsToPixels, blobPlayerShapes, blobMonsterShapes } from './shared-sprites.js';

/* ============================================================
   9b. Cart authoring — Roguelike / Cave Crawler
   (see url-console/examples/three-more-carts.md §1 for the design-level
   dogfood this implements: cellular-automata cave generator, edge-detected
   grid movement, SETTILE-based gold pickup, deferred-kill combat via the
   universal hp prop — all validated there as needing either a real gap
   filled (SETTILE) or nothing new (movement, combat) beyond existing
   opcodes composed by the cart author.)
   ============================================================ */
const ROGUELIKE_CONST_NAMES = {
  PLAYER_START_HP:0, MONSTER_START_HP:1, PLAYER_ATK:2, MONSTER_ATK:3,
  MOVE_INTERVAL:4, CHASE_RADIUS:5, MAP_W:6, MAP_H:7, NUM_MONSTERS:8,
  // MAP_W/MAP_H are the cave's own pixel size (gridW*8/gridH*8), used only
  // for random monster-spawn placement — distinct from the cart's
  // screenW/screenH, which is now the fixed 160x160 viewport the camera
  // scrolls within (DESIGN.md §18). They used to be the same number by
  // coincidence (no camera meant the whole map always fit one screen);
  // they aren't anymore, hence the rename away from "SCREEN_*".
};
const ROGUELIKE_GLOBAL_NAMES = {
  g_player:0, g_dead:1, g_won:2, g_gold:3, g_prev_input:4, g_scratch:5,
  g_target_x:6, g_target_y:7, g_dx:8, g_dy:9, g_mtx:10, g_mty:11, g_dir:12,
  g_mx:13, g_my:14, g_retry:15,
};
const ROGUELIKE_SYM = {constants:ROGUELIKE_CONST_NAMES, globals:ROGUELIKE_GLOBAL_NAMES};

// Tile ids, matching CAVE_WALL/CAVE_FLOOR/CAVE_STAIRS/CAVE_GOLD (§6b) — used
// here only as PUSHI literals, the same way the racer's hooks push TILE_ROAD
// etc. as raw ids rather than named constants (they're runtime tile ids, not
// cart-tunable values, so they don't belong in the constant pool).
const ROGUELIKE_HOOKS_SRC = {
  on_init: `
    SPAWN 0
    STOREG g_player
    PUSHI 0
    GET_CHECKPOINT
    STOREG g_target_y
    STOREG g_target_x
    LOADG g_target_x
    STOREE g_player 0
    LOADG g_target_y
    STOREE g_player 1
    PUSHC PLAYER_START_HP
    STOREE g_player 5
    PUSHI 0
    STOREG g_dead
    PUSHI 0
    STOREG g_won
    PUSHI 0
    STOREG g_gold
    PUSHI 0
    STOREG g_prev_input

    PUSHI 0
    STOREG g_dir
    spawn_loop:
    PUSHI 0
    PUSHC MAP_W
    RAND_RANGE
    STOREG g_mx
    PUSHI 0
    PUSHC MAP_H
    RAND_RANGE
    STOREG g_my
    LOADG g_mx
    LOADG g_my
    GETTILE
    PUSHI 1
    CMPEQ
    JNZ spawn_loop
    SPAWN 1
    STOREG g_scratch
    LOADG g_mx
    STOREE g_scratch 0
    LOADG g_my
    STOREE g_scratch 1
    PUSHC MONSTER_START_HP
    STOREE g_scratch 5
    PUSHI 0
    PUSHC MOVE_INTERVAL
    RAND_RANGE
    STOREE g_scratch 8
    LOADG g_dir
    PUSHI 1
    ADD
    DUP
    STOREG g_dir
    PUSHC NUM_MONSTERS
    CMPLT
    JNZ spawn_loop
    HALT
  `,
  on_input: `
    LOADG g_dead
    JNZ store_prev
    LOADG g_won
    JNZ store_prev

    LOADE g_player 0
    STOREG g_target_x
    LOADE g_player 1
    STOREG g_target_y

    LOAD_INPUT
    TESTBIT 0
    JZ chk_right
    LOADG g_prev_input
    TESTBIT 0
    JNZ chk_right
    LOADG g_target_x
    PUSHI 8
    SUB
    STOREG g_target_x
    chk_right:
    LOAD_INPUT
    TESTBIT 1
    JZ chk_up
    LOADG g_prev_input
    TESTBIT 1
    JNZ chk_up
    LOADG g_target_x
    PUSHI 8
    ADD
    STOREG g_target_x
    chk_up:
    LOAD_INPUT
    TESTBIT 2
    JZ chk_down
    LOADG g_prev_input
    TESTBIT 2
    JNZ chk_down
    LOADG g_target_y
    PUSHI 8
    SUB
    STOREG g_target_y
    chk_down:
    LOAD_INPUT
    TESTBIT 3
    JZ do_move
    LOADG g_prev_input
    TESTBIT 3
    JNZ do_move
    LOADG g_target_y
    PUSHI 8
    ADD
    STOREG g_target_y

    do_move:
    LOADG g_target_x
    LOADE g_player 0
    CMPEQ
    LOADG g_target_y
    LOADE g_player 1
    CMPEQ
    AND
    JNZ store_prev

    LOADG g_target_x
    LOADG g_target_y
    GETTILE
    STOREG g_scratch
    LOADG g_scratch
    PUSHI 1
    CMPEQ
    JNZ store_prev

    LOADG g_scratch
    PUSHI 4
    CMPEQ
    JZ chk_stairs
    LOADG g_gold
    PUSHI 1
    ADD
    STOREG g_gold
    LOADG g_target_x
    LOADG g_target_y
    PUSHI 2
    SETTILE

    chk_stairs:
    LOADG g_scratch
    PUSHI 3
    CMPEQ
    JZ commit_move
    PUSHI 1
    STOREG g_won

    commit_move:
    LOADG g_target_x
    STOREE g_player 0
    LOADG g_target_y
    STOREE g_player 1

    store_prev:
    LOAD_INPUT
    STOREG g_prev_input
    HALT
  `,
  on_frame: `
    LOADG g_dead
    JNZ done
    LOADG g_won
    JNZ done
    LOADE g_player 5
    PUSHI 0
    CMPLE
    JZ done
    PUSHI 1
    STOREG g_dead
    done:
    HALT
  `,
  on_tick: `
    LOAD_SELF 4
    PUSHI 1
    CMPEQ
    JZ tick_end

    LOAD_SELF 5
    PUSHI 0
    CMPLE
    JZ alive
    KILL_SELF
    JMP tick_end
    alive:

    LOAD_SELF 8
    PUSHI 1
    SUB
    DUP
    STORE_SELF 8
    PUSHI 0
    CMPGT
    JNZ tick_end
    PUSHC MOVE_INTERVAL
    STORE_SELF 8
    PUSHI 3
    STOREG g_retry

    LOAD_SELF 0
    LOAD_SELF 1
    LOADE g_player 0
    LOADE g_player 1
    DIST
    PUSHC CHASE_RADIUS
    CMPLT
    JZ wander

    LOADE g_player 0
    LOAD_SELF 0
    SUB
    STOREG g_dx
    LOADE g_player 1
    LOAD_SELF 1
    SUB
    STOREG g_dy
    LOADG g_dx
    PUSHI 0
    CMPGT
    JZ chase_dx_neg
    LOAD_SELF 0
    PUSHI 8
    ADD
    STOREG g_mtx
    LOAD_SELF 1
    STOREG g_mty
    JMP wander_done
    chase_dx_neg:
    LOADG g_dx
    PUSHI 0
    CMPLT
    JZ chase_use_y
    LOAD_SELF 0
    PUSHI 8
    SUB
    STOREG g_mtx
    LOAD_SELF 1
    STOREG g_mty
    JMP wander_done
    chase_use_y:
    LOAD_SELF 0
    STOREG g_mtx
    LOADG g_dy
    PUSHI 0
    CMPGT
    JZ chase_dy_neg
    LOAD_SELF 1
    PUSHI 8
    ADD
    STOREG g_mty
    JMP wander_done
    chase_dy_neg:
    LOADG g_dy
    PUSHI 0
    CMPLT
    JZ chase_no_move
    LOAD_SELF 1
    PUSHI 8
    SUB
    STOREG g_mty
    JMP wander_done
    chase_no_move:
    LOAD_SELF 1
    STOREG g_mty
    JMP wander_done

    wander:
    PUSHI 0
    PUSHI 4
    RAND_RANGE
    STOREG g_dir
    LOADG g_dir
    PUSHI 0
    CMPEQ
    JZ wchk1
    LOAD_SELF 0
    PUSHI 8
    ADD
    STOREG g_mtx
    LOAD_SELF 1
    STOREG g_mty
    JMP wander_done
    wchk1:
    LOADG g_dir
    PUSHI 1
    CMPEQ
    JZ wchk2
    LOAD_SELF 0
    PUSHI 8
    SUB
    STOREG g_mtx
    LOAD_SELF 1
    STOREG g_mty
    JMP wander_done
    wchk2:
    LOADG g_dir
    PUSHI 2
    CMPEQ
    JZ wchk3
    LOAD_SELF 0
    STOREG g_mtx
    LOAD_SELF 1
    PUSHI 8
    ADD
    STOREG g_mty
    JMP wander_done
    wchk3:
    LOAD_SELF 0
    STOREG g_mtx
    LOAD_SELF 1
    PUSHI 8
    SUB
    STOREG g_mty

    wander_done:
    LOADG g_mtx
    LOADG g_mty
    GETTILE
    PUSHI 1
    CMPEQ
    JZ commit_move
    LOADG g_retry
    PUSHI 1
    SUB
    DUP
    STOREG g_retry
    JNZ wander
    JMP tick_end
    commit_move:
    LOADG g_mtx
    STORE_SELF 0
    LOADG g_mty
    STORE_SELF 1

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
    JNZ p_hits_m
    LOAD_A 4
    PUSHI 1
    CMPEQ
    LOAD_B 4
    PUSHI 0
    CMPEQ
    AND
    JNZ m_hits_p
    JMP done
    p_hits_m:
    LOAD_B 5
    PUSHC PLAYER_ATK
    SUB
    STORE_B 5
    LOAD_A 5
    PUSHC MONSTER_ATK
    SUB
    STORE_A 5
    JMP done
    m_hits_p:
    LOAD_A 5
    PUSHC PLAYER_ATK
    SUB
    STORE_A 5
    LOAD_B 5
    PUSHC MONSTER_ATK
    SUB
    STORE_B 5
    done:
    HALT
  `,
};

function buildRoguelikeCart(){
  const wallPixels = hexRowsToPixels([
    '11121111','11112121','12111112','11211111',
    '11112111','21111211','11121112','11112111',
  ]);
  const floorPixels = hexRowsToPixels([
    '44444444','44454444','44444444','45444440',
    '44444444','44444544','44444444','44044444',
  ]);
  const stairsPixels = hexRowsToPixels([
    '44444444','44444440','44444700','44470000',
    '44700000','47000000','00000000','00000000',
  ]);
  const goldPixels = hexRowsToPixels([
    '44444444','44044440','40ffff04','4fffffe4',
    '4fffffe4','40ffff04','44044440','44444444',
  ]);
  // Blue player. Indices 9/10 land squarely in the new curated dungeon
  // bank's blue range (see CURATED_BANK[1]).
  const playerShapes = blobPlayerShapes(9, 10);
  // Red monster, white eyes — deliberately using its own indices (12/14),
  // not the earthy ones (3/6) the map tiles use. That was the actual bug
  // behind "enemies blend into the background": the monster's *art*
  // referenced the same palette slots as the walls/floor, so no palette
  // swap alone could have fixed it — see DESIGN.md for the postmortem.
  const monsterShapes = blobMonsterShapes(12, 14, 7, 14);

  // Bigger than the original 32x20 (which fit entirely on one screen with
  // no camera, reported as feeling like "one flat map") — big enough that
  // the 160x160 viewport genuinely only shows a fraction at a time. Cave
  // generation turned out to have real phase-transition sensitivity at
  // this size: the same fillProb/wallThreshold that gave a well-balanced
  // 58-75% floor ratio at 32x20 gives 75-86% at this size (the forced-
  // solid border ring is a much smaller fraction of a bigger grid, so it
  // dilutes into the interior CA dynamics less), and pushing fillProb up
  // to compensate works until a sharp collapse cliff (some seeds produce
  // a near-all-wall degenerate cave) — found by sweeping fillProb across
  // many seeds and measuring floor%, not by eyeballing one map. 122 is
  // the highest value that stayed collapse-free across 150 test seeds.
  const gridW = 48, gridH = 36;

  const cart = {
    formatVersion: 2,
    name: 'Cave Crawler', author: 'Urlcade', // URL envelope only, see DESIGN.md §34 — never reaches the binary format
    cartType: 3, // advisory label only — see DESIGN.md §14
    paletteMode: 0, // curated bank #1 ("dungeon") — not the procedural
                     // hue-rotation mode; see CURATED_BANK's comment for why
    paletteParams: [1, 0, 0, 0, 0, 0, 0, 0],
    rngSeed: 11,
    modeFlags: 0,
    screenW: 160, screenH: 160, // square viewport, see DESIGN.md §18 —
                                 // the cave (gridW*8 x gridH*8) is bigger;
                                 // the camera below scrolls it into view
    mapGenerator: 2, // cellular-automata cave generator (§16) — a genuinely
                     // different archetype from the racer's turtle-grammar,
                     // stochastic + smoothed rather than turtle-walked
    backdropFillIndex: 0, backdropGroundHeight: 0, backdropGroundIndex: 0, // unused: the map generator covers the whole frame
    camera: {
      followGlobal: ROGUELIKE_GLOBAL_NAMES.g_player,
      clampMinX: 0, clampMinY: 0,
      clampMaxX: Math.max(0, gridW*8 - 160),
      clampMaxY: Math.max(0, gridH*8 - 160),
    },
    inputActiveButtons: 1|2|4|8,
    inputTouchTemplate: TOUCH_TEMPLATE_DPAD_ONLY,
    inputButtonLabels: {1:'Left', 2:'Right', 4:'Up', 8:'Down'},
    hudSpec: [
      {kind:0, sourceKind:1, srcA:ROGUELIKE_GLOBAL_NAMES.g_player, srcB:5, delta:0, suffixConstIdx:255, label:'HP'},
      {kind:0, sourceKind:0, srcA:ROGUELIKE_GLOBAL_NAMES.g_gold, srcB:0, delta:0, suffixConstIdx:255, label:'Gold'},
      {kind:1, sourceKind:0, srcA:ROGUELIKE_GLOBAL_NAMES.g_dead, srcB:0, delta:0, suffixConstIdx:255, label:'You died - refresh link to retry'},
      {kind:1, sourceKind:0, srcA:ROGUELIKE_GLOBAL_NAMES.g_won, srcB:0, delta:0, suffixConstIdx:255, label:'You escaped! Refresh link to play again'},
    ],
    // MOVE_INTERVAL lowered 20->14 ticks and NUM_MONSTERS raised 6->18 for
    // the bigger map — a monster whose random-direction attempt was
    // blocked used to just sit still until the next full MOVE_INTERVAL
    // (no retry), which read as "enemies don't move"; on_tick now retries
    // a few times with a fresh random direction before giving up for the
    // tick (see ROGUELIKE_HOOKS_SRC.on_tick's g_retry loop).
    constants: [20, 6, 3, 2, 14, 70, gridW*8, gridH*8, 18],
    entityTypes: [
      {renderKind:0, assetIndex:0, rotateFlag:0, collisionW:6, collisionH:6, extFieldCount:0}, // PLAYER
      {renderKind:0, assetIndex:1, rotateFlag:0, collisionW:6, collisionH:6, extFieldCount:1}, // MONSTER (ext 8 = move_timer)
    ],
    sprites: [ {kind:1, w:16, h:16, shapes:playerShapes}, {kind:1, w:16, h:16, shapes:monsterShapes} ],
    tiles: [
      {w:8,h:8,pixels:wallPixels}, {w:8,h:8,pixels:floorPixels},
      {w:8,h:8,pixels:stairsPixels}, {w:8,h:8,pixels:goldPixels},
    ],
    cave: {gridW, gridH, fillProb:122, iterations:4, wallThreshold:5, goldCount:16},
    hooks: {},
  };
  for(const name of HOOK_NAMES){
    const src = ROGUELIKE_HOOKS_SRC[name];
    cart.hooks[name] = src ? assemble(src.split('\n'), ROGUELIKE_SYM) : new Uint8Array(0);
  }
  return cart;
}


export { buildRoguelikeCart };
