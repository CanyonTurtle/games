/* ============================================================
   The Urlcade — example cart: Corridor (raycast FPS)

   The first cart whose visible gameplay is entirely first-person: a
   classic screen-column raycaster, drawn every frame by a single
   stationary renderKind:2 "camera" entity's on_draw hook, using nothing
   but DRAW_LINE (see DESIGN.md §54 for the full writeup — column-
   stretching to stay under MAX_STEPS, why the camera entity never
   moves, and the billboard-occlusion trick for monsters).

   Map is the same cellular-automata cave generator Cave Crawler uses
   (mapGenerator:2 / buildCave) — reused here purely as a wall/floor
   grid for GETTILE, never actually drawn top-down: the camera's on_draw
   repaints the full 160x160 screen every frame, so the automatic
   top-down map render (still built, still required for GETTILE to have
   real data) is always fully hidden behind it during play. It's the
   same map generator, put to a genuinely different use.
   ============================================================ */
"use strict";
const K = window.UrlcadeKernel;
const {
  assemble, HOOK_NAMES, TOUCH_TEMPLATE_DPAD_ACTION,
} = K;
import { hexRowsToPixels } from './shared-sprites.js';

/* ============================================================
   9c. Cart authoring — Corridor (raycast FPS)
   ============================================================ */
const DOOM_CONST_NAMES = {
  PLAYER_START_HP: 0, MONSTER_HP: 1, TURN_SPEED: 2, MOVE_SPEED: 3,
  CONTACT_DAMAGE: 4, CONTACT_COOLDOWN: 5, MOVE_INTERVAL: 6, CHASE_RADIUS: 7,
  MAP_W: 8, MAP_H: 9, SHOOT_RANGE: 10, SHOOT_CONE: 11,
  RAYS_HALF: 12, ANGLE_STEP: 13, STEP_SIZE: 14, FAR_SENTINEL: 15,
  WALL_SCALE: 16, SCREEN_H_F: 17, HALF_H_F: 18, THRESH1: 19, THRESH2: 20,
  FOV_HALF: 21, BILLBOARD_SCALE: 22, COL_W_F: 23, NUM_RAYS_F: 24,
};
// Persistent state (0-8) lives for the whole run; g_s0..g_s12 (9-21) are
// pure scratch, reused for a different purpose in every hook/loop that
// touches them (spawn-loop temp, ray-march accumulator, monster-shot
// bookkeeping, ...) — safe because none of those uses ever overlap
// within a single hook invocation. See DESIGN.md §54 for the full
// reuse map; each generator function below comments its own slice.
const DOOM_GLOBAL_NAMES = {
  g_player: 0, g_won: 1, g_dead: 2, g_kills: 3,
  g_mon0: 4, g_mon1: 5, g_mon2: 6, g_contact_cd: 7, g_prev_shoot: 8,
  g_s0: 9, g_s1: 10, g_s2: 11, g_s3: 12, g_s4: 13, g_s5: 14, g_s6: 15,
  g_s7: 16, g_s8: 17, g_s9: 18, g_s10: 19, g_s11: 20, g_s12: 21,
  g_s13: 22, // genMarchSteps' own loop counter — shared across all 46 call sites, never needed simultaneously with anything else
  g_ray_idx: 23, // genWallColumnLoop's own loop counter
};
const DOOM_SYM = { constants: DOOM_CONST_NAMES, globals: DOOM_GLOBAL_NAMES };

// Entity prop layout (base 8 props every entity gets, see runtime.js's
// spawnEntity): 0=x, 1=y, 2=vx, 3=vy, 4=typeId (auto-set), 5=hp (the
// "universal hp prop" every combat-capable cart uses at this index —
// see cave-crawler), 6=free (player's facing angle, degrees), 7=own id
// (auto-set). Monster adds one ext field (prop 8) for its wander/chase
// move-timer, exactly like cave-crawler's monster.
const XPROP = 0, YPROP = 1, HPPROP = 5, ANGLEPROP = 6;
const PLAYER_TYPE = 0, CAMERA_TYPE = 1, MONSTER_TYPE = 2;

// ---- raycast tuning (DESIGN.md §54) ----
// 40 rays, each stretched across a 4px-wide screen strip (40*4 = 160,
// the full viewport width) — casting a ray per screen *pixel* column
// would be the accurate approach but blows MAX_STEPS on its own (160
// rays * ~200 worst-case march steps > 20000 before a single DRAW_LINE
// is even issued); casting fewer, wider rays and repeating each one's
// computed wall slice across a handful of adjacent pixel columns keeps
// every column painted (no gaps — canvas line strokes are 1px wide, so
// unlike a filled rect there's no way to cover width other than by
// drawing that many adjacent lines) while paying the expensive part
// (the wall-distance march) only once per ray, not once per pixel.
const NUM_RAYS = 40, COL_W = 4, SCREEN_W = 160, SCREEN_H = 160, HALF_H = 80;
// Fixed-step ray march (not true DDA — there's no floor/frac opcode to
// do sub-tile-accurate stepping) up to 14 steps of 8px (one tile) each,
// i.e. a 112px lookahead. Distances beyond that never register a hit —
// the wall slice degenerates to hairline-thin (see FAR_SENTINEL below)
// and the column reads as open, which reads as fog/darkness rather
// than a visible bug.
const MAX_MARCH = 14, STEP_SIZE = 8;
const FOV = 66;
const ANGLE_STEP = FOV / NUM_RAYS;
const RAYS_HALF = (NUM_RAYS - 1) / 2;
// WALL_SCALE/dist gives the on-screen wall-slice height; picked so a
// wall one tile away (dist=8) fills the whole 160px screen height, and
// falls off gracefully from there.
const WALL_SCALE = 1280;
// A ray that never hits anything within MAX_MARCH gets this distance —
// far enough that WALL_SCALE/FAR_SENTINEL is a fraction of a pixel, so
// the shared draw code (which always emits a "wall" segment) needs no
// separate hit/no-hit branch: an unhit ray's wall slice is just
// invisibly thin, and the column reads as pure ceiling+floor.
const FAR_SENTINEL = 2000;
const THRESH1 = 48, THRESH2 = 100; // wall shading distance buckets
// Ceiling near the terrain ramp's dark "ink" end and floor near its
// lightest end — deliberately far apart (not neighboring shades like 1/2)
// so the two are still visually distinct even when neither has a wall
// slice between them (an all-open column, e.g. a big room or a ray past
// FAR_SENTINEL, is nothing but a ceiling/floor split — DESIGN.md §54).
const CEIL_COLOR = 0, FLOOR_COLOR = 4, WALL_NEAR = 7, WALL_MID = 5, WALL_FAR = 3;
const FOV_HALF = 33; // ~ RAYS_HALF*ANGLE_STEP — both the wall FOV/2 and the monster visibility cone
const BILLBOARD_SCALE = 640;
const MONSTER_COLOR = 14; // entity B ramp — see paletteParams below

// Shared by every ray-march site (wall columns, monster-billboard
// occlusion, and the shoot hit-scan): steps g_s3/g_s4 (the marching
// x/y) by g_s1/g_s2 (the per-step delta) until GETTILE reports a wall
// (id 1) or the budget of MAX_MARCH steps runs out — identical bytecode
// every time, just parameterized by where to jump on a hit, which is
// why it's a shared generator rather than copy-pasted three times.
// A real VM-level loop (g_s13 counts iterations), not 14 unrolled copies —
// this one function is spliced into all 46 call sites (40 wall rays, 3
// monster-billboard occlusion checks, 3 shoot hit-scan checks), so it was
// nearly 60% of the whole cart's instruction count when it was unrolled
// per site (14 steps x 14 opcodes x 46 sites). Looping costs a handful of
// extra opcodes *per march step actually taken* (the counter bookkeeping
// below) versus the unrolled form, which is why the wall-column budget
// math in the header comment re-measures the real worst case rather than
// reusing the pre-loop number — see DESIGN.md §57.
function genMarchSteps(hitLabel) {
  const loopLabel = `${hitLabel}_marchloop`;
  return [
    'PUSHI 0', 'STOREG g_s13',
    `${loopLabel}:`,
    'LOADG g_s3', 'LOADG g_s1', 'ADD', 'STOREG g_s3',
    'LOADG g_s4', 'LOADG g_s2', 'ADD', 'STOREG g_s4',
    'LOADG g_s3', 'LOADG g_s4', 'GETTILE', 'PUSHI 1', 'CMPEQ', `JNZ ${hitLabel}`,
    'LOADG g_s13', 'PUSHI 1', 'ADD', 'DUP', 'STOREG g_s13',
    `PUSHI ${MAX_MARCH}`, 'CMPLT', `JNZ ${loopLabel}`,
  ];
}

// All 40 wall rays, as ONE copy of this logic run through a real VM loop
// (g_ray_idx counts 0..NUM_RAYS-1) instead of 40 JS-unrolled copies —
// unrolled, this alone was ~40% of the whole cart's compiled size (see
// DESIGN.md §57); a real loop costs a little more at *runtime* (loop
// bookkeeping opcodes actually get dispatched, unlike an unrolled copy's
// implicit fall-through) but is dramatically smaller *compiled*, which is
// what actually matters for a shareable URL fragment. Per-ray angle
// offset and each column's x position, previously baked in as compile-
// time PUSHI constants, are now computed from g_ray_idx at runtime.
// g_s0=angle, g_s1/g_s2=march step dx/dy, g_s3/g_s4=march position,
// g_s5=hit distance, g_s6=wall height then (reused, dead by then)
// colBase, g_s7=half height then (reused) the current column's x,
// g_s8/g_s9=wall slice top/bottom y, g_s10=wall color.
function genWallColumnLoop() {
  const hit = 'wallray_hit', after = 'wallray_after', loopTop = 'wallray_loop';
  let lines = [
    'PUSHI 0', 'STOREG g_ray_idx',
    `${loopTop}:`,
    'LOADG g_ray_idx', 'PUSHC RAYS_HALF', 'SUB', 'PUSHC ANGLE_STEP', 'MUL',
    `LOADE g_player ${ANGLEPROP}`, 'ADD', 'STOREG g_s0',
    'LOADG g_s0', 'COS', 'PUSHC STEP_SIZE', 'MUL', 'STOREG g_s1',
    'LOADG g_s0', 'SIN', 'PUSHC STEP_SIZE', 'MUL', 'STOREG g_s2',
    `LOADE g_player ${XPROP}`, 'STOREG g_s3',
    `LOADE g_player ${YPROP}`, 'STOREG g_s4',
    'PUSHC FAR_SENTINEL', 'STOREG g_s5',
  ];
  lines = lines.concat(genMarchSteps(hit));
  lines.push(`JMP ${after}`);
  lines.push(`${hit}:`);
  lines.push(`LOADE g_player ${XPROP}`, `LOADE g_player ${YPROP}`, 'LOADG g_s3', 'LOADG g_s4', 'DIST', 'STOREG g_s5');
  lines.push(`${after}:`);
  lines.push(
    'PUSHC WALL_SCALE', 'LOADG g_s5', 'DIV',
    'DUP', 'PUSHC SCREEN_H_F', 'CMPGT', 'JZ wallray_noclamp',
    'POP', 'PUSHC SCREEN_H_F',
    'wallray_noclamp:',
    'STOREG g_s6',
    'LOADG g_s6', 'PUSHI 2', 'DIV', 'STOREG g_s7',
    'PUSHC HALF_H_F', 'LOADG g_s7', 'SUB', 'STOREG g_s8',
    'PUSHC HALF_H_F', 'LOADG g_s7', 'ADD', 'STOREG g_s9',
  );
  lines.push(
    'LOADG g_s5', 'PUSHC THRESH1', 'CMPLT', 'JNZ wallray_near',
    'LOADG g_s5', 'PUSHC THRESH2', 'CMPLT', 'JNZ wallray_mid',
    `PUSHI ${WALL_FAR}`, 'JMP wallray_colordone',
    'wallray_near:', `PUSHI ${WALL_NEAR}`, 'JMP wallray_colordone',
    'wallray_mid:', `PUSHI ${WALL_MID}`,
    'wallray_colordone:',
    'STOREG g_s10',
  );
  // colBase = g_ray_idx * COL_W, into g_s6 (its "height" job is long done)
  lines.push('LOADG g_ray_idx', 'PUSHC COL_W_F', 'MUL', 'STOREG g_s6');
  for (let s = 0; s < COL_W; s++) {
    lines.push(
      'LOADG g_s6', `PUSHI ${s}`, 'ADD', 'STOREG g_s7', // g_s7 = this column's x (its "half height" job is long done)
      'LOADG g_s7', 'PUSHI 0', 'LOADG g_s7', 'LOADG g_s8', `PUSHI ${CEIL_COLOR}`, 'DRAW_LINE',
      'LOADG g_s7', 'LOADG g_s8', 'LOADG g_s7', 'LOADG g_s9', 'LOADG g_s10', 'DRAW_LINE',
      'LOADG g_s7', 'LOADG g_s9', 'LOADG g_s7', `PUSHI ${SCREEN_H}`, `PUSHI ${FLOOR_COLOR}`, 'DRAW_LINE',
    );
  }
  lines.push(
    'LOADG g_ray_idx', 'PUSHI 1', 'ADD', 'DUP', 'STOREG g_ray_idx',
    `PUSHI ${NUM_RAYS}`, 'CMPLT', `JNZ ${loopTop}`,
  );
  return lines;
}

// One monster's billboard: skip if dead (hp==0) or outside the view
// cone; otherwise march a single ray toward it (reusing the exact same
// march loop the wall columns use) to test whether a wall is nearer
// than the monster is — if so it's hidden behind that wall and doesn't
// draw. A visible monster is a simple X of two crossing lines, sized by
// 1/distance and positioned by its bearing relative to the player's
// facing (no true 3D sprite — DRAW_LINE only draws segments, so this is
// the same "silhouette in a few strokes" technique the flag in Mini
// Golf's on_draw uses). g_s11=relative bearing (kept alive across the
// march, which reuses g_s1-g_s5), g_s12=distance to the monster.
function genMonsterBillboardBlock(k) {
  const monG = `g_mon${k}`;
  const skip = `bb${k}_skip`, hit = `bb${k}_hit`, after = `bb${k}_after`, absdone = `bb${k}_absdone`;
  let lines = [];
  lines.push(`LOADE ${monG} ${HPPROP}`, `JZ ${skip}`);
  lines.push(
    `LOADE ${monG} ${XPROP}`, `LOADE g_player ${XPROP}`, 'SUB',
    `LOADE ${monG} ${YPROP}`, `LOADE g_player ${YPROP}`, 'SUB',
    'ATAN2', 'STOREG g_s0',
    'LOADG g_s0', `LOADE g_player ${ANGLEPROP}`, 'SUB', 'NORM_ANGLE', 'STOREG g_s11',
    'LOADG g_s11', 'DUP', 'PUSHI 0', 'CMPLT', `JZ ${absdone}`, 'NEG', `${absdone}:`,
    'PUSHC FOV_HALF', 'CMPGT', `JNZ ${skip}`,
  );
  lines.push(
    `LOADE g_player ${XPROP}`, `LOADE g_player ${YPROP}`, `LOADE ${monG} ${XPROP}`, `LOADE ${monG} ${YPROP}`, 'DIST', 'STOREG g_s12',
  );
  lines.push(
    'LOADG g_s0', 'COS', 'PUSHC STEP_SIZE', 'MUL', 'STOREG g_s1',
    'LOADG g_s0', 'SIN', 'PUSHC STEP_SIZE', 'MUL', 'STOREG g_s2',
    `LOADE g_player ${XPROP}`, 'STOREG g_s3',
    `LOADE g_player ${YPROP}`, 'STOREG g_s4',
    'PUSHC FAR_SENTINEL', 'STOREG g_s5',
  );
  lines = lines.concat(genMarchSteps(hit));
  lines.push(`JMP ${after}`);
  lines.push(`${hit}:`);
  lines.push(`LOADE g_player ${XPROP}`, `LOADE g_player ${YPROP}`, 'LOADG g_s3', 'LOADG g_s4', 'DIST', 'STOREG g_s5');
  lines.push(`${after}:`);
  lines.push('LOADG g_s5', 'LOADG g_s12', 'CMPLT', `JNZ ${skip}`);
  lines.push(
    'LOADG g_s11', 'PUSHC FOV_HALF', 'DIV', 'PUSHI 80', 'MUL', 'PUSHI 80', 'ADD', 'STOREG g_s6',
    'PUSHC BILLBOARD_SCALE', 'LOADG g_s12', 'DIV', 'STOREG g_s7',
  );
  lines.push(
    'LOADG g_s6', 'LOADG g_s7', 'SUB', 'STOREG g_s0',
    'LOADG g_s6', 'LOADG g_s7', 'ADD', 'STOREG g_s1',
    'PUSHC HALF_H_F', 'LOADG g_s7', 'SUB', 'STOREG g_s2',
    'PUSHC HALF_H_F', 'LOADG g_s7', 'ADD', 'STOREG g_s3',
  );
  lines.push(
    'LOADG g_s0', 'LOADG g_s2', 'LOADG g_s1', 'LOADG g_s3', `PUSHI ${MONSTER_COLOR}`, 'DRAW_LINE',
    'LOADG g_s0', 'LOADG g_s3', 'LOADG g_s1', 'LOADG g_s2', `PUSHI ${MONSTER_COLOR}`, 'DRAW_LINE',
  );
  lines.push(`${skip}:`);
  return lines;
}

function genOnDraw() {
  let lines = genWallColumnLoop();
  for (let k = 0; k < 3; k++) lines = lines.concat(genMonsterBillboardBlock(k));
  // Reticle — a tiny fixed crosshair, drawn last so it's always on top.
  lines = lines.concat([
    'PUSHI 76', 'PUSHI 80', 'PUSHI 84', 'PUSHI 80', 'PUSHI 0', 'DRAW_LINE',
    'PUSHI 80', 'PUSHI 76', 'PUSHI 80', 'PUSHI 84', 'PUSHI 0', 'DRAW_LINE',
  ]);
  lines.push('HALT');
  return lines.join('\n');
}

// One monster's hit-scan check, tried in g_mon0/1/2 order on the frame
// the shoot button is first pressed (on_tick edge-detects via
// g_prev_shoot so holding the button doesn't auto-fire every tick).
// Same shape as the billboard block above (cone check, then an
// occlusion march) but gated additionally by SHOOT_RANGE, and ending in
// an actual kill (hp -> 0) instead of a draw. Stops at the first
// monster that qualifies — see the shared `shot_done` label on_tick
// jumps to.
function genShotCheckBlock(k) {
  const monG = `g_mon${k}`;
  const skip = `shot${k}_skip`, hit = `shot${k}_hit`, after = `shot${k}_after`, absdone = `shot${k}_absdone`;
  let lines = [];
  lines.push(`LOADE ${monG} ${HPPROP}`, `JZ ${skip}`);
  lines.push(
    `LOADE ${monG} ${XPROP}`, `LOAD_SELF ${XPROP}`, 'SUB',
    `LOADE ${monG} ${YPROP}`, `LOAD_SELF ${YPROP}`, 'SUB',
    'ATAN2', 'STOREG g_s0',
    'LOADG g_s0', `LOAD_SELF ${ANGLEPROP}`, 'SUB', 'NORM_ANGLE', 'STOREG g_s11',
    'LOADG g_s11', 'DUP', 'PUSHI 0', 'CMPLT', `JZ ${absdone}`, 'NEG', `${absdone}:`,
    'PUSHC SHOOT_CONE', 'CMPGT', `JNZ ${skip}`,
  );
  lines.push(
    `LOAD_SELF ${XPROP}`, `LOAD_SELF ${YPROP}`, `LOADE ${monG} ${XPROP}`, `LOADE ${monG} ${YPROP}`, 'DIST', 'STOREG g_s12',
    'LOADG g_s12', 'PUSHC SHOOT_RANGE', 'CMPGT', `JNZ ${skip}`,
  );
  lines.push(
    'LOADG g_s0', 'COS', 'PUSHC STEP_SIZE', 'MUL', 'STOREG g_s1',
    'LOADG g_s0', 'SIN', 'PUSHC STEP_SIZE', 'MUL', 'STOREG g_s2',
    `LOAD_SELF ${XPROP}`, 'STOREG g_s3',
    `LOAD_SELF ${YPROP}`, 'STOREG g_s4',
    'PUSHC FAR_SENTINEL', 'STOREG g_s5',
  );
  lines = lines.concat(genMarchSteps(hit));
  lines.push(`JMP ${after}`);
  lines.push(`${hit}:`);
  lines.push(`LOAD_SELF ${XPROP}`, `LOAD_SELF ${YPROP}`, 'LOADG g_s3', 'LOADG g_s4', 'DIST', 'STOREG g_s5');
  lines.push(`${after}:`);
  lines.push('LOADG g_s5', 'LOADG g_s12', 'CMPLT', `JNZ ${skip}`);
  lines.push(
    'PUSHI 0', `STOREE ${monG} ${HPPROP}`,
    'LOADG g_kills', 'PUSHI 1', 'ADD', 'STOREG g_kills',
    'JMP shot_done',
  );
  lines.push(`${skip}:`);
  return lines;
}

const DOOM_HOOKS_SRC = {
  on_init: `
    SPAWN ${PLAYER_TYPE}
    STOREG g_player
    PUSHI 0
    GET_CHECKPOINT
    STOREE g_player ${YPROP}
    STOREE g_player ${XPROP}
    PUSHC PLAYER_START_HP
    STOREE g_player ${HPPROP}
    PUSHI 0
    STOREE g_player ${ANGLEPROP}
    PUSHI 0
    STOREG g_won
    PUSHI 0
    STOREG g_dead
    PUSHI 0
    STOREG g_kills
    PUSHI 0
    STOREG g_contact_cd
    PUSHI 0
    STOREG g_prev_shoot

    SPAWN ${CAMERA_TYPE}
    POP

    mon0_spawn:
    PUSHI 0
    PUSHC MAP_W
    RAND_RANGE
    STOREG g_s0
    PUSHI 0
    PUSHC MAP_H
    RAND_RANGE
    STOREG g_s1
    LOADG g_s0
    LOADG g_s1
    GETTILE
    PUSHI 1
    CMPEQ
    JNZ mon0_spawn
    SPAWN ${MONSTER_TYPE}
    STOREG g_mon0
    LOADG g_s0
    STOREE g_mon0 ${XPROP}
    LOADG g_s1
    STOREE g_mon0 ${YPROP}
    PUSHC MONSTER_HP
    STOREE g_mon0 ${HPPROP}
    PUSHI 0
    PUSHC MOVE_INTERVAL
    RAND_RANGE
    STOREE g_mon0 8

    mon1_spawn:
    PUSHI 0
    PUSHC MAP_W
    RAND_RANGE
    STOREG g_s0
    PUSHI 0
    PUSHC MAP_H
    RAND_RANGE
    STOREG g_s1
    LOADG g_s0
    LOADG g_s1
    GETTILE
    PUSHI 1
    CMPEQ
    JNZ mon1_spawn
    SPAWN ${MONSTER_TYPE}
    STOREG g_mon1
    LOADG g_s0
    STOREE g_mon1 ${XPROP}
    LOADG g_s1
    STOREE g_mon1 ${YPROP}
    PUSHC MONSTER_HP
    STOREE g_mon1 ${HPPROP}
    PUSHI 0
    PUSHC MOVE_INTERVAL
    RAND_RANGE
    STOREE g_mon1 8

    mon2_spawn:
    PUSHI 0
    PUSHC MAP_W
    RAND_RANGE
    STOREG g_s0
    PUSHI 0
    PUSHC MAP_H
    RAND_RANGE
    STOREG g_s1
    LOADG g_s0
    LOADG g_s1
    GETTILE
    PUSHI 1
    CMPEQ
    JNZ mon2_spawn
    SPAWN ${MONSTER_TYPE}
    STOREG g_mon2
    LOADG g_s0
    STOREE g_mon2 ${XPROP}
    LOADG g_s1
    STOREE g_mon2 ${YPROP}
    PUSHC MONSTER_HP
    STOREE g_mon2 ${HPPROP}
    PUSHI 0
    PUSHC MOVE_INTERVAL
    RAND_RANGE
    STOREE g_mon2 8

    HALT
  `,
  on_frame: `
    LOADG g_dead
    JNZ done
    LOADG g_won
    JNZ done
    LOADE g_player ${HPPROP}
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
    PUSHI ${PLAYER_TYPE}
    CMPEQ
    JNZ player_tick
    LOAD_SELF 4
    PUSHI ${MONSTER_TYPE}
    CMPEQ
    JNZ monster_tick
    JMP tick_end

    player_tick:
    LOADG g_dead
    JNZ tick_end
    LOADG g_won
    JNZ tick_end

    LOADG g_contact_cd
    PUSHI 0
    CMPGT
    JZ cd_done
    LOADG g_contact_cd
    PUSHI 1
    SUB
    STOREG g_contact_cd
    cd_done:

    LOAD_INPUT
    TESTBIT 0
    JZ chk_right
    LOAD_SELF ${ANGLEPROP}
    PUSHC TURN_SPEED
    SUB
    STORE_SELF ${ANGLEPROP}
    chk_right:
    LOAD_INPUT
    TESTBIT 1
    JZ chk_fwd
    LOAD_SELF ${ANGLEPROP}
    PUSHC TURN_SPEED
    ADD
    STORE_SELF ${ANGLEPROP}
    chk_fwd:

    PUSHI 0
    STORE_SELF 2
    PUSHI 0
    STORE_SELF 3
    LOAD_INPUT
    TESTBIT 2
    JZ chk_back
    LOAD_SELF ${ANGLEPROP}
    COS
    PUSHC MOVE_SPEED
    MUL
    STORE_SELF 2
    LOAD_SELF ${ANGLEPROP}
    SIN
    PUSHC MOVE_SPEED
    MUL
    STORE_SELF 3
    JMP move_input_done
    chk_back:
    LOAD_INPUT
    TESTBIT 3
    JZ move_input_done
    LOAD_SELF ${ANGLEPROP}
    COS
    PUSHC MOVE_SPEED
    MUL
    NEG
    STORE_SELF 2
    LOAD_SELF ${ANGLEPROP}
    SIN
    PUSHC MOVE_SPEED
    MUL
    NEG
    STORE_SELF 3
    move_input_done:
    MOVE_SOLID

    LOAD_SELF ${XPROP}
    LOAD_SELF ${YPROP}
    GETTILE
    PUSHI 3
    CMPEQ
    JZ no_win
    PUSHI 1
    STOREG g_won
    no_win:

    LOAD_INPUT
    TESTBIT 4
    STOREG g_s0
    LOADG g_s0
    JZ shoot_end
    LOADG g_prev_shoot
    JNZ shoot_end

    ${genShotCheckBlock(0).join('\n    ')}
    ${genShotCheckBlock(1).join('\n    ')}
    ${genShotCheckBlock(2).join('\n    ')}
    shot_done:

    shoot_end:
    LOADG g_s0
    STOREG g_prev_shoot

    JMP tick_end

    monster_tick:
    LOAD_SELF ${HPPROP}
    PUSHI 0
    CMPLE
    JZ mon_alive
    JMP tick_end
    mon_alive:

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

    LOAD_SELF ${XPROP}
    LOAD_SELF ${YPROP}
    LOADE g_player ${XPROP}
    LOADE g_player ${YPROP}
    DIST
    PUSHC CHASE_RADIUS
    CMPLT
    JZ mon_wander

    LOADE g_player ${XPROP}
    LOAD_SELF ${XPROP}
    SUB
    STOREG g_s0
    LOADE g_player ${YPROP}
    LOAD_SELF ${YPROP}
    SUB
    STOREG g_s1
    LOADG g_s0
    PUSHI 0
    CMPGT
    JZ chase_dx_neg
    LOAD_SELF ${XPROP}
    PUSHI 8
    ADD
    STOREG g_s2
    LOAD_SELF ${YPROP}
    STOREG g_s3
    JMP mon_move_done
    chase_dx_neg:
    LOADG g_s0
    PUSHI 0
    CMPLT
    JZ chase_use_y
    LOAD_SELF ${XPROP}
    PUSHI 8
    SUB
    STOREG g_s2
    LOAD_SELF ${YPROP}
    STOREG g_s3
    JMP mon_move_done
    chase_use_y:
    LOAD_SELF ${XPROP}
    STOREG g_s2
    LOADG g_s1
    PUSHI 0
    CMPGT
    JZ chase_dy_neg
    LOAD_SELF ${YPROP}
    PUSHI 8
    ADD
    STOREG g_s3
    JMP mon_move_done
    chase_dy_neg:
    LOADG g_s1
    PUSHI 0
    CMPLT
    JZ chase_no_move
    LOAD_SELF ${YPROP}
    PUSHI 8
    SUB
    STOREG g_s3
    JMP mon_move_done
    chase_no_move:
    LOAD_SELF ${YPROP}
    STOREG g_s3
    JMP mon_move_done

    mon_wander:
    PUSHI 0
    PUSHI 4
    RAND_RANGE
    STOREG g_s4
    LOADG g_s4
    PUSHI 0
    CMPEQ
    JZ wchk1
    LOAD_SELF ${XPROP}
    PUSHI 8
    ADD
    STOREG g_s2
    LOAD_SELF ${YPROP}
    STOREG g_s3
    JMP mon_move_done
    wchk1:
    LOADG g_s4
    PUSHI 1
    CMPEQ
    JZ wchk2
    LOAD_SELF ${XPROP}
    PUSHI 8
    SUB
    STOREG g_s2
    LOAD_SELF ${YPROP}
    STOREG g_s3
    JMP mon_move_done
    wchk2:
    LOADG g_s4
    PUSHI 2
    CMPEQ
    JZ wchk3
    LOAD_SELF ${XPROP}
    STOREG g_s2
    LOAD_SELF ${YPROP}
    PUSHI 8
    ADD
    STOREG g_s3
    JMP mon_move_done
    wchk3:
    LOAD_SELF ${XPROP}
    STOREG g_s2
    LOAD_SELF ${YPROP}
    PUSHI 8
    SUB
    STOREG g_s3

    mon_move_done:
    LOADG g_s2
    LOADG g_s3
    GETTILE
    PUSHI 1
    CMPEQ
    JNZ tick_end
    LOADG g_s2
    STORE_SELF ${XPROP}
    LOADG g_s3
    STORE_SELF ${YPROP}

    tick_end:
    HALT
  `,
  on_collide: `
    LOAD_A 4
    PUSHI ${PLAYER_TYPE}
    CMPEQ
    LOAD_B 4
    PUSHI ${MONSTER_TYPE}
    CMPEQ
    AND
    JNZ p_hits_m
    LOAD_A 4
    PUSHI ${MONSTER_TYPE}
    CMPEQ
    LOAD_B 4
    PUSHI ${PLAYER_TYPE}
    CMPEQ
    AND
    JNZ m_hits_p
    JMP done

    p_hits_m:
    LOAD_B ${HPPROP}
    PUSHI 0
    CMPLE
    JNZ done
    LOADG g_contact_cd
    JNZ done
    LOAD_A ${HPPROP}
    PUSHC CONTACT_DAMAGE
    SUB
    STORE_A ${HPPROP}
    PUSHC CONTACT_COOLDOWN
    STOREG g_contact_cd
    JMP done

    m_hits_p:
    LOAD_A ${HPPROP}
    PUSHI 0
    CMPLE
    JNZ done
    LOADG g_contact_cd
    JNZ done
    LOAD_B ${HPPROP}
    PUSHC CONTACT_DAMAGE
    SUB
    STORE_B ${HPPROP}
    PUSHC CONTACT_COOLDOWN
    STOREG g_contact_cd
    JMP done

    done:
    HALT
  `,
  on_draw: genOnDraw(),
};

function buildDoomCart() {
  // Wall/floor/stairs tile art — visible only for the instant before the
  // camera entity's first on_draw paints over it (and in the shelf
  // thumbnail's own top-down-then-on_draw render, see runtime.js's
  // buildCardThumbnail): the 3D walls are colored directly by DRAW_LINE,
  // never by this bitmap art, so its only real job is not looking broken
  // in that first frame / thumbnail. goldCount:0 below means the cave's
  // 4th tile id (gold) never appears in the grid, so unlike Cave Crawler
  // this cart doesn't need a 4th tile bitmap at all.
  const wallPixels = hexRowsToPixels([
    '11121111', '11112121', '12111112', '11211111',
    '11112111', '21111211', '11121112', '11112111',
  ]);
  const floorPixels = hexRowsToPixels([
    '22222222', '22232222', '22222222', '23222220',
    '22222222', '22222322', '22222222', '22022222',
  ]);
  const stairsPixels = hexRowsToPixels([
    '22222222', '22222220', '22222700', '22270000',
    '22700000', '27000000', '00000000', '00000000',
  ]);
  const invisiblePixels = new Array(64).fill(0);

  const gridW = 22, gridH = 18;

  const cart = {
    formatVersion: 3,
    name: 'Corridor', author: 'Urlcade',
    cartType: 3, // advisory label only — see DESIGN.md §14
    // Cold blue-gray stone terrain (indices 0-7); entity A's hue barely
    // matters (the player entity is invisible — its own art is never
    // drawn, only its position/angle feed the raycaster), entity B is
    // pushed toward red so the monster billboard (index 14, DRAW_LINE'd
    // directly, not sprited) unmistakably reads as "hostile" against the
    // cold walls — see DESIGN.md §44's two-ramp separation guarantee.
    paletteParams: [210, 0, 10, 35, 8, 55, 135, 11],
    rngSeed: 7,
    modeFlags: 0,
    screenW: SCREEN_W, screenH: SCREEN_H,
    mapGenerator: 2, // cellular-automata cave — reused purely as a wall/floor grid, see file header
    backdropFillIndex: 0, backdropGroundHeight: 0, backdropGroundIndex: 0,
    // No scrolling: the raycast view is drawn in absolute screen-pixel
    // space by a camera entity that's spawned once at world (0,0) and
    // never moves (see DESIGN.md §54) — cameraX/Y must stay 0 for that
    // entity's own local DRAW_LINE offsets to land where they're
    // computed to land. followGlobal:255 is "no camera" (the runtime's
    // own default), set explicitly here for clarity.
    camera: { followGlobal: 255, clampMinX: 0, clampMinY: 0, clampMaxX: 0, clampMaxY: 0 },
    // MOVE_SOLID's solidity test is ctx.tileSurface(tile) !== 0, which
    // defaults to identity — meaning floor (id 2) and stairs (id 3) would
    // both read as "solid" (any nonzero tile id) and the player could
    // never step onto them at all. Both need to override to 0 so only the
    // cave's actual wall tile (id 1, left at its identity value) blocks
    // movement — the same mechanism run-and-jump/race-car use for their
    // own non-wall tile ids (see runtime.js's tileSurface comment).
    tileSurfaceOverrides: { 2: 0, 3: 0 },
    inputActiveButtons: 1 | 2 | 4 | 8 | 16,
    inputTouchTemplate: TOUCH_TEMPLATE_DPAD_ACTION,
    inputButtonLabels: { 1: 'Turn Left', 2: 'Turn Right', 4: 'Forward', 8: 'Back', 16: 'Shoot' },
    hudSpec: [
      { kind: 0, sourceKind: 1, srcA: DOOM_GLOBAL_NAMES.g_player, srcB: HPPROP, delta: 0, suffixConstIdx: 255, clamp: 0, label: 'HP' },
      { kind: 0, sourceKind: 0, srcA: DOOM_GLOBAL_NAMES.g_kills, srcB: 0, delta: 0, suffixConstIdx: 255, clamp: 0, label: 'Kills' },
      { kind: 1, sourceKind: 0, srcA: DOOM_GLOBAL_NAMES.g_dead, srcB: 0, delta: 0, suffixConstIdx: 255, clamp: 0, label: 'You died - refresh link to retry' },
      { kind: 1, sourceKind: 0, srcA: DOOM_GLOBAL_NAMES.g_won, srcB: 0, delta: 0, suffixConstIdx: 255, clamp: 0, label: 'You found the stairs! Refresh link to play again' },
    ],
    constants: [
      100,  // PLAYER_START_HP
      1,    // MONSTER_HP
      3,    // TURN_SPEED (deg/tick)
      1.6,  // MOVE_SPEED (px/tick)
      10,   // CONTACT_DAMAGE
      30,   // CONTACT_COOLDOWN (ticks)
      20,   // MOVE_INTERVAL (monster wander/chase step interval, ticks)
      60,   // CHASE_RADIUS (px)
      gridW * 8, // MAP_W
      gridH * 8, // MAP_H
      140,  // SHOOT_RANGE (px)
      10,   // SHOOT_CONE (deg half-angle)
      RAYS_HALF, ANGLE_STEP, STEP_SIZE, FAR_SENTINEL, WALL_SCALE,
      SCREEN_H, HALF_H, THRESH1, THRESH2, FOV_HALF, BILLBOARD_SCALE,
      COL_W, NUM_RAYS,
    ],
    entityTypes: [
      { renderKind: 0, assetIndex: 0, rotateFlag: 0, collisionW: 6, collisionH: 6, extFieldCount: 0 }, // PLAYER — invisible, never drawn as a sprite
      { renderKind: 2, assetIndex: 0, rotateFlag: 0, collisionW: 1, collisionH: 1, extFieldCount: 0 }, // CAMERA — the raycaster; assetIndex unused for renderKind:2
      { renderKind: 0, assetIndex: 0, rotateFlag: 0, collisionW: 8, collisionH: 8, extFieldCount: 1 }, // MONSTER — invisible top-down too (drawn as a billboard by the camera's on_draw); ext 8 = move_timer
    ],
    sprites: [ {w:8, h:8, pixels: invisiblePixels} ],
    tiles: [
      {w:8, h:8, pixels: wallPixels}, {w:8, h:8, pixels: floorPixels}, {w:8, h:8, pixels: stairsPixels},
    ],
    cave: { gridW, gridH, fillProb: 122, iterations: 4, wallThreshold: 5, goldCount: 0 },
    hooks: {},
  };
  for (const name of HOOK_NAMES) {
    const src = DOOM_HOOKS_SRC[name];
    cart.hooks[name] = src ? assemble(src.split('\n'), DOOM_SYM) : new Uint8Array(0);
  }
  return cart;
}

export { buildDoomCart };
