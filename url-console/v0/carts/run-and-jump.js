/* ============================================================
   The Urlcade — example cart: Run & Jump (platformer)
   (see url-console/examples/three-more-carts.md for the original
   design-level writeup; see DESIGN.md §15.2 for building it for real —
   MOVE_SOLID's exact contract, camera, and the map_generator=3 grammar)
   ============================================================ */
"use strict";
const K = window.UrlcadeKernel;
const {
  assemble, HOOK_NAMES, TOUCH_TEMPLATE_STEER_ACTION, SHAPE_ELLIPSE, PLATFORM_TOKENS, PLATFORM_AIR,
  buildPlatformLevel,
} = K;
import { hexRowsToPixels, blobPlayerShapes, blobMonsterShapes } from './shared-sprites.js';

/* ============================================================
   9c. Cart authoring — Platformer / Run & Jump
   (see url-console/examples/three-more-carts.md §2 for the design-level
   dogfood this implements: solid-tile collision needing a real opcode
   (MOVE_SOLID), a level wider than one screen needing a real new
   composable concept (camera) — both built for real here, alongside
   confirmations that gravity/jump/patrol-AI/coin-pickup needed nothing
   new beyond what MOVE_SOLID + the existing opcode set already provide.)
   ============================================================ */
const PLATFORM_CONST_NAMES = {
  GRAVITY:0, MOVE_SPEED:1, JUMP_VELOCITY:2, ENEMY_SPEED:3, PLAYER_START_HP:4,
  ENEMY_ATK:5, LEVEL_W:6, LEVEL_H:7, NUM_COINS:8, NUM_ENEMIES:9, MAX_FALL_SPEED:10,
  FALL_GRAVITY:11, JUMP_CUT_MULT:12,
  // FALL_GRAVITY > GRAVITY (rising) is the whole "jump curve" fix: the
  // original single-gravity arc integrates to a lazy, floaty parabola in
  // both directions (a real curve, just not a snappy-feeling one — the
  // clunkiness reported wasn't the underlying math shape, it was a flat
  // response curve). Heavier gravity once vel_y>0 gives a fast, decisive
  // fall while the rise stays soft, the standard platformer trick (see
  // on_tick's tick_player/tick_enemy). JUMP_CUT_MULT is the other half:
  // releasing JUMP while still rising truncates vel_y (on_input), so tap
  // = short hop, hold = full arc — variable jump height instead of a
  // single fixed-height jump every time the button is touched.
};
const PLATFORM_GLOBAL_NAMES = {
  g_player:0, g_dead:1, g_won:2, g_score:3, g_scratch:4, g_i:5, g_cx:6, g_cy:7,
  g_prev_input:8,
};
const PLATFORM_SYM = {constants:PLATFORM_CONST_NAMES, globals:PLATFORM_GLOBAL_NAMES};

// Entity type ids used as PUSHI literals in the hooks below (like the
// racer's/roguelike's hooks push their own type ids directly): 0=PLAYER,
// 1=COIN, 2=ENEMY.
const PLATFORM_HOOKS_SRC = {
  on_init: `
    SPAWN 0
    STOREG g_player
    PUSHI 0
    GET_CHECKPOINT
    STOREE g_player 1
    STOREE g_player 0
    PUSHC PLAYER_START_HP
    STOREE g_player 5
    PUSHI 0
    STOREG g_dead
    PUSHI 0
    STOREG g_won
    PUSHI 0
    STOREG g_score

    PUSHI 0
    STOREG g_i
    coin_loop:
    LOADG g_i
    PUSHI 1
    ADD
    GET_CHECKPOINT
    STOREG g_cy
    STOREG g_cx
    SPAWN 1
    STOREG g_scratch
    LOADG g_cx
    STOREE g_scratch 0
    LOADG g_cy
    STOREE g_scratch 1
    PUSHI 1
    STOREE g_scratch 5
    LOADG g_i
    PUSHI 1
    ADD
    DUP
    STOREG g_i
    PUSHC NUM_COINS
    CMPLT
    JNZ coin_loop

    PUSHI 0
    STOREG g_i
    enemy_loop:
    LOADG g_i
    PUSHC NUM_COINS
    ADD
    PUSHI 1
    ADD
    GET_CHECKPOINT
    STOREG g_cy
    STOREG g_cx
    SPAWN 2
    STOREG g_scratch
    LOADG g_cx
    STOREE g_scratch 0
    LOADG g_cy
    STOREE g_scratch 1
    PUSHI 1
    STOREE g_scratch 8
    LOADG g_i
    PUSHI 1
    ADD
    DUP
    STOREG g_i
    PUSHC NUM_ENEMIES
    CMPLT
    JNZ enemy_loop
    HALT
  `,
  on_input: `
    LOADG g_dead
    JNZ done
    LOADG g_won
    JNZ done

    LOAD_INPUT 0
    TESTBIT 0
    JZ chk_right
    PUSHC MOVE_SPEED
    NEG
    STOREE g_player 2
    JMP moved_x
    chk_right:
    LOAD_INPUT 0
    TESTBIT 1
    JZ zero_x
    PUSHC MOVE_SPEED
    STOREE g_player 2
    JMP moved_x
    zero_x:
    PUSHI 0
    STOREE g_player 2
    moved_x:

    LOAD_INPUT 0
    TESTBIT 2
    JZ chk_jump_release
    LOADE g_player 0
    LOADE g_player 1
    PUSHI 5
    ADD
    GETTILE
    TILE_SURFACE
    JZ store_prev
    PUSHC JUMP_VELOCITY
    STOREE g_player 3
    JMP store_prev

    chk_jump_release:
    LOADG g_prev_input
    TESTBIT 2
    JZ store_prev
    LOADE g_player 3
    PUSHI 0
    CMPLT
    JZ store_prev
    LOADE g_player 3
    PUSHC JUMP_CUT_MULT
    MUL
    STOREE g_player 3

    store_prev:
    LOAD_INPUT 0
    STOREG g_prev_input
    done:
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
    JZ chk_win
    PUSHI 1
    STOREG g_dead
    ; sprites[3] = deadPlayerShapes. Writes the player's own current
    ; assetIndex (props[8], extFieldCount:0 so 8 + 0), not
    ; entityTypes[0].assetIndex — only runs once, the frame HP first
    ; reaches 0 (g_dead short-circuits every frame after).
    PUSHI 3
    STOREE g_player 8
    JMP done
    chk_win:
    LOADE g_player 0
    PUSHC LEVEL_W
    PUSHI 20
    SUB
    CMPGE
    JZ done
    PUSHI 1
    STOREG g_won
    done:
    HALT
  `,
  on_tick: `
    LOAD_SELF 4
    PUSHI 1
    CMPEQ
    JZ not_coin
    LOAD_SELF 5
    PUSHI 0
    CMPLE
    JZ tick_end
    KILL_SELF
    JMP tick_end

    not_coin:
    LOAD_SELF 4
    PUSHI 0
    CMPEQ
    JNZ tick_player
    LOAD_SELF 4
    PUSHI 2
    CMPEQ
    JNZ tick_enemy
    JMP tick_end

    tick_player:
    LOAD_SELF 3
    PUSHI 0
    CMPLT
    JZ p_fall_grav
    PUSHC GRAVITY
    JMP p_apply_grav
    p_fall_grav:
    PUSHC FALL_GRAVITY
    p_apply_grav:
    LOAD_SELF 3
    SWAP
    ADD
    PUSHC MAX_FALL_SPEED
    CLAMP_ABS
    STORE_SELF 3
    MOVE_SOLID
    JMP tick_end

    tick_enemy:
    LOAD_SELF 3
    PUSHI 0
    CMPLT
    JZ e_fall_grav
    PUSHC GRAVITY
    JMP e_apply_grav
    e_fall_grav:
    PUSHC FALL_GRAVITY
    e_apply_grav:
    LOAD_SELF 3
    SWAP
    ADD
    PUSHC MAX_FALL_SPEED
    CLAMP_ABS
    STORE_SELF 3
    LOAD_SELF 8
    PUSHC ENEMY_SPEED
    MUL
    STORE_SELF 2
    MOVE_SOLID
    LOAD_SELF 2
    JNZ chk_ledge
    LOAD_SELF 8
    NEG
    STORE_SELF 8
    JMP tick_end
    chk_ledge:
    LOAD_SELF 0
    LOAD_SELF 8
    PUSHI 5
    MUL
    ADD
    LOAD_SELF 1
    PUSHI 5
    ADD
    GETTILE
    TILE_SURFACE
    JNZ tick_end
    LOAD_SELF 8
    NEG
    STORE_SELF 8

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
    JNZ hit_coin_b
    LOAD_A 4
    PUSHI 1
    CMPEQ
    LOAD_B 4
    PUSHI 0
    CMPEQ
    AND
    JNZ hit_coin_a
    LOAD_A 4
    PUSHI 0
    CMPEQ
    LOAD_B 4
    PUSHI 2
    CMPEQ
    AND
    JNZ hit_enemy_b
    LOAD_A 4
    PUSHI 2
    CMPEQ
    LOAD_B 4
    PUSHI 0
    CMPEQ
    AND
    JNZ hit_enemy_a
    JMP done

    hit_coin_b:
    PUSHI 0
    STORE_B 5
    LOADG g_score
    PUSHI 1
    ADD
    STOREG g_score
    JMP done

    hit_coin_a:
    PUSHI 0
    STORE_A 5
    LOADG g_score
    PUSHI 1
    ADD
    STOREG g_score
    JMP done

    hit_enemy_b:
    LOAD_A 5
    PUSHC ENEMY_ATK
    SUB
    STORE_A 5
    JMP done

    hit_enemy_a:
    LOAD_B 5
    PUSHC ENEMY_ATK
    SUB
    STORE_B 5

    done:
    HALT
  `,
};

function buildPlatformerCart(){
  const airPixels = hexRowsToPixels(new Array(8).fill('77777777'));
  const groundPixels = hexRowsToPixels([
    '11111111','11211121','22222222','22322232',
    '23222322','22322232','22232223','23222322',
  ]);
  const dirtPixels = hexRowsToPixels([
    '22222222','22322232','23222322','22222222',
    '22322232','22222222','23222322','22222222',
  ]);
  const brickPixels = hexRowsToPixels([
    '00000000','02220222','02220222','00000000',
    '22202220','22202220','00000000','02220222',
  ]);
  // Entity A: bodyColor bright, outlineColor dark — the ramp's index
  // ordering ascends in lightness (see kernel.js's generatePalette).
  const playerShapes = blobPlayerShapes(11, 8);
  // Entity B, not entity A — a genuinely independent hue from the
  // player rather than a different shade of the same one (DESIGN.md
  // §43), the same upgrade Cave Crawler's player/monster split got.
  // eyeColor===pupilColor gives a flat single-tone eye instead of the
  // roguelike monster's two-tone white+pupil.
  const enemyShapes = blobMonsterShapes(14, 12, 12, 12);
  // Gold ring, a darker interior fill, and a bright shine patch offset
  // toward the upper-left like a light source hitting a coin — kept on
  // entity A's own ramp (the two middle shades the player's outline/body
  // extremes don't use) rather than given a third independent hue: a
  // collectible reads fine as "part of the hero's world," and the two
  // ramps this cart actually needs distinct are player vs. enemy.
  const coinShapes = [
    {type:SHAPE_ELLIPSE, cx:8,cy:8, rx:5.7,ry:5.7, color:10},
    {type:SHAPE_ELLIPSE, cx:8,cy:8, rx:2.3,ry:2.3, color:9},
    {type:SHAPE_ELLIPSE, cx:5.8,cy:5.8, rx:2.3,ry:2.3, color:10},
  ];
  // Death pose (sprites[3]) — a flattened silhouette instead of the
  // upright head+body+feet blob look, keeping the same two-tone
  // outline+fill the alive sprite uses (a single-tone first version,
  // screenshot-checked, read as a near-invisible dark smudge rather than
  // a body — see DESIGN.md). Shown once HP reaches 0 (on_frame, alongside
  // the existing g_dead state) via the same assetIndex-override write
  // every death animation in this pass uses.
  const deadPlayerShapes = [
    {type:SHAPE_ELLIPSE, cx:8,cy:12, rx:6.8,ry:3.2, color:8},
    {type:SHAPE_ELLIPSE, cx:8,cy:12, rx:5.8,ry:2.4, color:11},
  ];

  // Roughly double the original length and with more step/gap/block
  // variety — at the old 256px-wide viewport the level already spanned
  // ~3.7 screens, which read as "long enough" on paper but felt short in
  // practice once the narrower 160px square viewport (see screenW below)
  // meant more of it went by per second of camera pan. This also gives
  // the new asymmetric-gravity jump more room to be felt across a mix of
  // short hops and longer gap clears rather than just the original three.
  const T = PLATFORM_TOKENS;
  const tokens = [
    T.FLAT,14, T.COIN, T.FLAT,8, T.STEP_UP,8, T.COIN, T.ENEMY,
    T.FLAT,8, T.GAP,6, T.FLAT,8, T.STEP_DOWN,8, T.BLOCK,6, T.COIN,
    T.FLAT,8, T.ENEMY, T.FLAT,6, T.STEP_UP,8, T.GAP,5, T.FLAT,8,
    T.COIN, T.ENEMY, T.FLAT,8, T.STEP_UP,6, T.STEP_UP,6, T.COIN,
    T.FLAT,6, T.GAP,6, T.FLAT,6, T.BLOCK,6, T.ENEMY, T.FLAT,8,
    T.STEP_DOWN,6, T.STEP_DOWN,6, T.FLAT,8, T.COIN, T.GAP,4, T.FLAT,6,
    T.ENEMY, T.FLAT,8, T.STEP_UP,8, T.COIN, T.ENEMY, T.GAP,6, T.FLAT,8,
    T.BLOCK,6, T.STEP_DOWN,8, T.FLAT,6, T.COIN, T.FLAT,8, T.ENEMY,
    T.STEP_UP,6, T.GAP,5, T.COIN, T.FLAT,10, T.ENEMY, T.FLAT,14,
  ];
  const platform = {gridH:20, startGroundY:14, minGroundY:8, maxGroundY:18, tokens};
  // Author-time only: run the real generator once just to read off gridW and
  // numCoins/numEnemies. Deliberately NOT a naive tokens.filter(t=>t===T.COIN)
  // — width bytes share the same small integer space as marker token ids
  // (this level's own GAP,5 and BLOCK,6 collide with COIN(5)/ENEMY(6)), so
  // only a real position-aware walk of the stream (which buildPlatformLevel
  // already does, to place checkpoints) counts correctly.
  const built = buildPlatformLevel(platform);
  const gridW = built.grid[0].length;
  const numCoins = built.numCoins, numEnemies = built.numEnemies;
  const screenW = 160, screenH = 160; // square, matches every other cart — see DESIGN.md §18

  const cart = {
    formatVersion: 5,
    name: 'Run & Jump', author: 'Urlcade', // URL envelope only, see DESIGN.md §34 — never reaches the binary format
    cartType: 4, // advisory label only — see DESIGN.md §14
    // Terrain hue 205 (blue sky/platforms). Entity hue hints: ~32
    // (orange) for the player; ~355 (red) was the original hint for the
    // enemy, but that's too close to the player's own orange to ever be
    // a separately-readable entity hue, so generatePalette() moves it to
    // the nearest safe spot instead — ~330 (pink) — independent hues by
    // construction, not by reusing two shades of the same one the way
    // this cart's player and enemy briefly did (DESIGN.md §44).
    paletteParams: [205, 0, 25, 55, 35, 75, 23, 252],
    rngSeed: 5,
    modeFlags: 0,
    screenW, screenH, // viewport size — the level itself is gridW*8 wide, see camera below
    mapGenerator: 3, // turtle-grammar heightmap generator (§16) — see the
                      // §16 comment above buildPlatformLevel for how this
                      // relates to (and differs from) the racer's map_generator=1
    backdropFillIndex: 0, backdropGroundHeight: 0, backdropGroundIndex: 0, // unused: the map generator covers the whole frame
    camera: {
      followGlobal: PLATFORM_GLOBAL_NAMES.g_player,
      clampMinX: 0, clampMinY: 0,
      clampMaxX: Math.max(0, gridW*8 - screenW),
      clampMaxY: Math.max(0, platform.gridH*8 - screenH), // 0 here: level height == viewport height, so only X scrolls
    },
    inputActiveButtons: 1|2|4,
    inputTouchTemplate: TOUCH_TEMPLATE_STEER_ACTION, // same left/right+action
      // *shape* the racer uses — the touch template only had to encode a
      // layout, never "steering" specifically, confirming the fix to
      // describeControls() (which used to hardcode that word) was right.
    inputButtonLabels: {1:'Left', 2:'Right', 4:'Jump'},
    hudSpec: [
      {kind:0, sourceKind:0, srcA:PLATFORM_GLOBAL_NAMES.g_score, srcB:0, delta:0, suffixConstIdx:255, label:'Coins'},
      {kind:1, sourceKind:0, srcA:PLATFORM_GLOBAL_NAMES.g_dead, srcB:0, delta:0, suffixConstIdx:255, label:'You died - refresh link to retry'},
      {kind:1, sourceKind:0, srcA:PLATFORM_GLOBAL_NAMES.g_won, srcB:0, delta:0, suffixConstIdx:255, label:'You win! Refresh link to play again'},
    ],
    // FALL_GRAVITY (0.6) roughly 1.7x GRAVITY (0.35 while rising) and
    // JUMP_CUT_MULT (0.4) are the jump-feel fix — see PLATFORM_CONST_NAMES.
    // PLAYER_START_HP raised 1->3: fine for the original short/sparse
    // level, but with 2x the length and more than 2x the enemies, a
    // single touch anywhere ending the run stopped being "hard" and
    // started being "unfair" — a few hits of leeway matches the bigger
    // hazard budget instead of just making the level a longer insta-fail.
    constants: [0.35, 1.6, -6.2, 0.8, 3, 1, gridW*8, platform.gridH*8, numCoins, numEnemies, 6, 0.6, 0.4],
    entityTypes: [
      {renderKind:0, assetIndex:0, rotateFlag:0, collisionW:6, collisionH:8, extFieldCount:0}, // PLAYER
      {renderKind:0, assetIndex:2, rotateFlag:0, collisionW:6, collisionH:6, extFieldCount:0}, // COIN
      {renderKind:0, assetIndex:1, rotateFlag:0, collisionW:6, collisionH:6, extFieldCount:1}, // ENEMY (ext 8 = facing)
    ],
    sprites: [
      {kind:1, w:16, h:16, shapes:playerShapes}, {kind:1, w:16, h:16, shapes:enemyShapes},
      {kind:1, w:16, h:16, shapes:coinShapes}, {kind:1, w:16, h:16, shapes:deadPlayerShapes},
    ],
    tiles: [
      {w:8,h:8,pixels:airPixels}, {w:8,h:8,pixels:groundPixels},
      {w:8,h:8,pixels:dirtPixels}, {w:8,h:8,pixels:brickPixels},
    ],
    // MOVE_SOLID's solidity test is ctx.tileSurface(tile) !== 0 — the exact
    // same generic mechanism tileSurfaceOverrides already provides (born as
    // a bug fix for the racer's startline, see DESIGN.md §15.1), reused
    // here for an entirely different purpose: only AIR needs remapping,
    // to surface 0 (non-solid); GROUND/DIRT/BRICK default to identity
    // (nonzero = solid) with no override needed.
    tileSurfaceOverrides: {[PLATFORM_AIR]: 0},
    platform,
    hooks: {},
  };
  for(const name of HOOK_NAMES){
    const src = PLATFORM_HOOKS_SRC[name];
    cart.hooks[name] = src ? assemble(src.split('\n'), PLATFORM_SYM) : new Uint8Array(0);
  }
  return cart;
}


export { buildPlatformerCart };
