/* ============================================================
   The Urlcade — example cart: Castle Crusher (destruction/arcade)
   (see DESIGN.md §19-§24 for the destruction genre's evolution —
   aim-line generator, stacked structures, real per-entity gravity and
   ball/block collision)
   ============================================================ */
"use strict";
const K = window.UrlcadeKernel;
const {
  assemble, HOOK_NAMES, TOUCH_TEMPLATE_STEER_ACTION, SHAPE_ELLIPSE, SHAPE_RECT,
  PLATFORM_TOKENS, PLATFORM_AIR, buildPlatformLevel,
} = K;
import { hexRowsToPixels, blobMonsterShapes } from './shared-sprites.js';

/* ============================================================
   9c. Cart authoring — Castle Crusher (destruction genre)

   Dogfoods the "physics destruction" archetype (Angry Birds / Crush the
   Castle): aim, charge, fire a projectile at an HP-bearing structure.
   §21/§22's version deliberately simplified the physics — blocks never
   moved, the projectile pierced straight through with no real collision
   — on the reasoning that entity-vs-entity solid resolution needed a
   primitive this VM didn't have. That trade was revisited on direct
   feedback ("blocks have no falling physics or ball collision"): real
   gravity and real projectile-vs-block collision turned out not to need
   a new opcode at all, just a different use of the one mechanism the
   engine already provides for entity pairs — on_collide, called once
   per tick for every already-overlapping pair, with direct read/write
   access to both entities' props.

   Gravity is uniform: every BLOCK, BLOCK variant, and TARGET falls
   every tick (same GRAVITY/MAX_FALL_SPEED as the projectile) and uses
   MOVE_SOLID to rest against the tilemap exactly like the platformer's
   player. Resting *on top of another entity* (the case MOVE_SOLID can't
   see, since it only resolves against tiles) is handled in on_collide:
   when two non-projectile entities overlap, whichever has the smaller
   y (higher on screen) is snapped to sit exactly on the other's top
   surface and its vel_y zeroed — a stack "catches" the moment its
   support arrives, tower-block-by-tower-block, the same tick order
   gravity naturally produces (the bottom of a stack always stops
   falling first). Knock the bottom block out and nothing above it has
   anything to rest on; gravity takes it from there. No new global
   state, no iteration over "all nearby entities" — just the pairwise
   overlap the engine was already computing.

   The projectile is solid against BLOCK/TARGET too, same mechanism:
   on_collide picks whichever axis the ball's incoming velocity is
   dominant on (compared via squared components, so no ABS opcode is
   needed) as the hit axis, reflects and damps that component of the
   ball's own velocity (a real bounce, not a pass-through), snaps it
   back outside the block along that axis, and shoves the block with a
   fraction of the ball's original velocity (knockback) — hard enough
   hits can now visibly topple a block off a stack, not just chip its
   HP. A damage/instant-kill step (cooldown-gated for multi-hit blocks,
   immediate for one-hit targets) rides along in the same branch.

   Aim/charge input is still deliberately digital (hold LEFT/RIGHT to
   sweep the angle, hold FIRE to charge power, release to launch)
   rather than an analog drag vector — the same trick classic console
   golf/artillery games use to make an aim-and-power mechanic work
   without a mouse.
   ============================================================ */
const DESTRUCT_CONST_NAMES = {
  GRAVITY:0, MAX_FALL_SPEED:1, LAUNCH_SPEED_SCALE:2, MIN_ANGLE:3, MAX_ANGLE:4,
  ANGLE_RATE:5, CHARGE_RATE:6, MAX_POWER:7, BLOCK_DAMAGE:8, NUM_SHOTS:9,
  NUM_BLOCKS:10, NUM_TARGETS:11, LEVEL_W:12, LEVEL_H:13, GROUND_FRICTION:14,
  BLOCK_START_HP:15, SETTLE_SPEED2:16, HIT_COOLDOWN:17, BOUNCE_DAMPING:18,
  KNOCKBACK_SCALE:19,
};
const DESTRUCT_GLOBAL_NAMES = {
  g_active_proj:0, g_angle:1, g_power:2, g_launched:3, g_shots_left:4,
  g_targets_left:5, g_won:6, g_lost:7, g_anchor_x:8, g_anchor_y:9,
  g_prev_input:10, g_scratch:11, g_i:12, g_cx:13, g_cy:14, g_proj_done:15,
  g_aiming:16, g_scratch2:17,
};
const DESTRUCT_SYM = {constants:DESTRUCT_CONST_NAMES, globals:DESTRUCT_GLOBAL_NAMES};

// Entity type ids: 0=PROJECTILE, 1=BLOCK (ext 8=hit_cooldown, counted
// down every tick, blocking on_collide from re-applying damage every
// single tick a slow-moving projectile happens to still be overlapping
// it — found empirically: without this, a lingering touch could apply
// BLOCK_DAMAGE dozens of times over a slow pass, destroying any block
// almost on contact regardless of its HP, making HP meaningless),
// 2=TARGET (no ext fields — dies in one hit, nothing to cool down),
// 3=BLOCK variant (same ext8 hit_cooldown as BLOCK).
//
// Gravity, tilemap-resting (MOVE_SOLID), and entity-on-entity resting
// (on_collide, see below) apply uniformly to BLOCK/BLOCK-variant/TARGET
// — all three are "structural," differing only in HP and death rules,
// not in physics.
const DESTRUCT_HOOKS_SRC = {
  on_init: `
    PUSHI 0
    GET_CHECKPOINT
    STOREG g_anchor_y
    STOREG g_anchor_x

    SPAWN 0
    STOREG g_active_proj
    LOADG g_anchor_x
    STOREE g_active_proj 0
    LOADG g_anchor_y
    STOREE g_active_proj 1
    PUSHI 0
    STOREE g_active_proj 2
    PUSHI 0
    STOREE g_active_proj 3

    PUSHC MIN_ANGLE
    STOREG g_angle
    PUSHI 0
    STOREG g_power
    PUSHI 0
    STOREG g_launched
    PUSHI 1
    STOREG g_aiming
    PUSHI 0
    STOREG g_proj_done
    PUSHC NUM_SHOTS
    STOREG g_shots_left
    PUSHI 0
    STOREG g_won
    PUSHI 0
    STOREG g_lost

    PUSHI 0
    STOREG g_i
    block_loop:
    LOADG g_i
    PUSHI 1
    ADD
    GET_CHECKPOINT
    STOREG g_cy
    STOREG g_cx
    LOADG g_i
    PUSHI 2
    MOD
    PUSHI 0
    CMPEQ
    JZ spawn_block_variant
    SPAWN 1
    JMP spawned_block
    spawn_block_variant:
    SPAWN 3
    spawned_block:
    STOREG g_scratch
    LOADG g_cx
    STOREE g_scratch 0
    LOADG g_cy
    STOREE g_scratch 1
    PUSHI 0
    STOREE g_scratch 8
    PUSHC BLOCK_START_HP
    STOREE g_scratch 5
    LOADG g_i
    PUSHI 1
    ADD
    DUP
    STOREG g_i
    PUSHC NUM_BLOCKS
    CMPLT
    JNZ block_loop

    PUSHI 0
    STOREG g_i
    target_loop:
    LOADG g_i
    PUSHC NUM_BLOCKS
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
    STOREE g_scratch 5
    LOADG g_i
    PUSHI 1
    ADD
    DUP
    STOREG g_i
    PUSHC NUM_TARGETS
    CMPLT
    JNZ target_loop

    PUSHC NUM_TARGETS
    STOREG g_targets_left
    HALT
  `,
  on_input: `
    LOADG g_won
    JNZ done
    LOADG g_lost
    JNZ done
    LOADG g_launched
    JNZ done

    LOAD_INPUT
    TESTBIT 0
    JZ chk_right
    LOADG g_angle
    PUSHC ANGLE_RATE
    SUB
    STOREG g_angle
    chk_right:
    LOAD_INPUT
    TESTBIT 1
    JZ clamp_lo
    LOADG g_angle
    PUSHC ANGLE_RATE
    ADD
    STOREG g_angle
    clamp_lo:
    LOADG g_angle
    PUSHC MIN_ANGLE
    CMPLT
    JZ clamp_hi
    PUSHC MIN_ANGLE
    STOREG g_angle
    clamp_hi:
    LOADG g_angle
    PUSHC MAX_ANGLE
    CMPGT
    JZ chk_charge
    PUSHC MAX_ANGLE
    STOREG g_angle
    chk_charge:

    LOAD_INPUT
    TESTBIT 2
    JZ chk_release
    LOADG g_power
    PUSHC CHARGE_RATE
    ADD
    STOREG g_power
    LOADG g_power
    PUSHC MAX_POWER
    CMPGT
    JZ store_prev
    PUSHC MAX_POWER
    STOREG g_power
    JMP store_prev

    chk_release:
    LOADG g_prev_input
    TESTBIT 2
    JZ store_prev
    LOADG g_power
    PUSHI 0
    CMPLE
    JNZ store_prev
    LOADG g_angle
    COS
    LOADG g_power
    PUSHC LAUNCH_SPEED_SCALE
    MUL
    MUL
    STOREE g_active_proj 2
    LOADG g_angle
    SIN
    LOADG g_power
    PUSHC LAUNCH_SPEED_SCALE
    MUL
    MUL
    NEG
    STOREE g_active_proj 3
    PUSHI 1
    STOREG g_launched
    PUSHI 0
    STOREG g_aiming
    PUSHI 0
    STOREG g_power

    store_prev:
    LOAD_INPUT
    STOREG g_prev_input
    done:
    HALT
  `,
  on_frame: `
    LOADG g_won
    JNZ done
    LOADG g_lost
    JNZ done

    LOADG g_targets_left
    PUSHI 0
    CMPLE
    JZ chk_lost
    PUSHI 1
    STOREG g_won
    JMP done

    chk_lost:
    LOADG g_proj_done
    JZ done
    PUSHI 0
    STOREG g_proj_done
    LOADG g_shots_left
    PUSHI 1
    SUB
    STOREG g_shots_left
    LOADG g_shots_left
    PUSHI 0
    CMPLE
    JZ respawn
    PUSHI 1
    STOREG g_lost
    JMP done

    respawn:
    SPAWN 0
    STOREG g_active_proj
    LOADG g_anchor_x
    STOREE g_active_proj 0
    LOADG g_anchor_y
    STOREE g_active_proj 1
    PUSHI 0
    STOREE g_active_proj 2
    PUSHI 0
    STOREE g_active_proj 3
    PUSHI 0
    STOREG g_launched
    PUSHI 1
    STOREG g_aiming

    done:
    HALT
  `,
  on_tick: `
    LOAD_SELF 4
    PUSHI 0
    CMPEQ
    JNZ tick_proj
    LOAD_SELF 4
    PUSHI 1
    CMPEQ
    JNZ tick_block
    LOAD_SELF 4
    PUSHI 3
    CMPEQ
    JNZ tick_block
    LOAD_SELF 4
    PUSHI 2
    CMPEQ
    JNZ tick_target
    JMP tick_end

    tick_proj:
    LOADG g_launched
    JZ tick_end
    LOAD_SELF 3
    PUSHC GRAVITY
    ADD
    PUSHC MAX_FALL_SPEED
    CLAMP_ABS
    STORE_SELF 3
    MOVE_SOLID
    LOAD_SELF 2
    PUSHC GROUND_FRICTION
    MUL
    STORE_SELF 2

    LOAD_SELF 3
    PUSHI 0
    CMPNE
    JNZ chk_bounds
    LOAD_SELF 2
    DUP
    MUL
    PUSHC SETTLE_SPEED2
    CMPLT
    JZ chk_bounds
    JMP proj_die

    chk_bounds:
    LOAD_SELF 1
    PUSHC LEVEL_H
    PUSHI 20
    ADD
    CMPGT
    JNZ proj_die
    LOAD_SELF 0
    PUSHI 0
    CMPLT
    JNZ proj_die
    LOAD_SELF 0
    PUSHC LEVEL_W
    CMPGT
    JNZ proj_die
    JMP tick_end
    proj_die:
    PUSHI 1
    STOREG g_proj_done
    KILL_SELF
    JMP tick_end

    tick_block:
    LOAD_SELF 5
    PUSHI 0
    CMPLE
    JZ block_alive
    KILL_SELF
    JMP tick_end
    block_alive:
    LOAD_SELF 8
    PUSHI 0
    CMPGT
    JZ skip_cooldown
    LOAD_SELF 8
    PUSHI 1
    SUB
    STORE_SELF 8
    skip_cooldown:
    LOAD_SELF 3
    PUSHC GRAVITY
    ADD
    PUSHC MAX_FALL_SPEED
    CLAMP_ABS
    STORE_SELF 3
    MOVE_SOLID
    LOAD_SELF 2
    PUSHC GROUND_FRICTION
    MUL
    STORE_SELF 2
    ; Hard horizontal safety clamp (found live, not guessed): a solid
    ; knockback hit can give a block enough vel_x that in one tick it
    ; crosses the entire remaining width of this narrow level before
    ; MOVE_SOLID's discrete per-tick edge check ever sees it *inside*
    ; the out-of-bounds column that would otherwise stop it — the block
    ; tunnels straight through the boundary and falls forever past the
    ; map's edge. Clamping position (and zeroing vel_x on clamp) is a
    ; blunt but always-correct backstop, independent of tuning
    ; KNOCKBACK_SCALE to "hopefully" stay under the tunneling threshold.
    LOAD_SELF 0
    PUSHI 0
    CMPLT
    JZ block_clamp_hi
    PUSHI 0
    STORE_SELF 0
    PUSHI 0
    STORE_SELF 2
    JMP tick_end
    block_clamp_hi:
    LOAD_SELF 0
    PUSHC LEVEL_W
    CMPGT
    JZ tick_end
    PUSHC LEVEL_W
    STORE_SELF 0
    PUSHI 0
    STORE_SELF 2
    JMP tick_end

    tick_target:
    LOAD_SELF 5
    PUSHI 0
    CMPLE
    JZ target_alive
    LOADG g_targets_left
    PUSHI 1
    SUB
    STOREG g_targets_left
    KILL_SELF
    JMP tick_end
    target_alive:
    LOAD_SELF 3
    PUSHC GRAVITY
    ADD
    PUSHC MAX_FALL_SPEED
    CLAMP_ABS
    STORE_SELF 3
    MOVE_SOLID
    LOAD_SELF 2
    PUSHC GROUND_FRICTION
    MUL
    STORE_SELF 2
    LOAD_SELF 0
    PUSHI 0
    CMPLT
    JZ target_clamp_hi
    PUSHI 0
    STORE_SELF 0
    PUSHI 0
    STORE_SELF 2
    JMP tick_end
    target_clamp_hi:
    LOAD_SELF 0
    PUSHC LEVEL_W
    CMPGT
    JZ tick_end
    PUSHC LEVEL_W
    STORE_SELF 0
    PUSHI 0
    STORE_SELF 2
    JMP tick_end

    tick_end:
    HALT
  `,
  on_collide: `
    ; Dispatch on "is either side the ball" rather than exact type pairs
    ; (§24): the ball is solid against BOTH structural types the same
    ; way, and structural-vs-structural (neither is the ball) is always
    ; a resting/support check regardless of which specific types they
    ; are. Only one ball exists, so at most one of A/B can be type 0.
    LOAD_A 4
    PUSHI 0
    CMPEQ
    JNZ a_is_ball
    LOAD_B 4
    PUSHI 0
    CMPEQ
    JNZ b_is_ball
    JMP support_resolve

    a_is_ball:
    ; ball = A, other = B. Capture the ball's pre-collision velocity —
    ; everything below reads it repeatedly (axis choice, the bounce
    ; itself, the other's knockback) and STORE_A below would clobber it.
    LOAD_A 2
    STOREG g_scratch
    LOAD_A 3
    STOREG g_scratch2
    LOAD_B 4
    PUSHI 2
    CMPEQ
    JNZ a_hit_target
    LOAD_B 8
    PUSHI 0
    CMPGT
    JNZ a_bounce
    LOAD_B 5
    PUSHC BLOCK_DAMAGE
    SUB
    STORE_B 5
    PUSHC HIT_COOLDOWN
    STORE_B 8
    JMP a_bounce
    a_hit_target:
    PUSHI 0
    STORE_B 5
    a_bounce:
    ; Which axis was the ball moving faster on? (compare squared
    ; components — no ABS opcode needed, squares are never negative.)
    ; That's the hit axis: reflect+damp the ball's velocity on it, snap
    ; the ball back outside the other entity along it (half-extents
    ; approximated to 11px combined — exact for the 14px BLOCK, within
    ; a pixel for the 12/13px TARGET/turret, invisible at this scale),
    ; and shove the other entity with a fraction of the ball's original
    ; velocity — a real knockback, not just a damage tick.
    LOADG g_scratch
    DUP
    MUL
    LOADG g_scratch2
    DUP
    MUL
    CMPGE
    JZ a_vert
    LOADG g_scratch
    NEG
    PUSHC BOUNCE_DAMPING
    MUL
    STORE_A 2
    LOAD_A 0
    LOAD_B 0
    CMPLT
    JZ a_push_right
    LOAD_B 0
    PUSHI 11
    SUB
    STORE_A 0
    JMP a_knock_x
    a_push_right:
    LOAD_B 0
    PUSHI 11
    ADD
    STORE_A 0
    a_knock_x:
    LOAD_B 2
    LOADG g_scratch
    PUSHC KNOCKBACK_SCALE
    MUL
    ADD
    STORE_B 2
    JMP done
    a_vert:
    LOADG g_scratch2
    NEG
    PUSHC BOUNCE_DAMPING
    MUL
    ; deadzone: a bounce that's already nearly settled snaps to exactly
    ; 0 instead of asymptotically approaching it forever — tick_proj's
    ; own "shot is over" check needs vel_y === 0 exactly (see its
    ; comment), which a damped-forever bounce would never actually reach.
    ; DUP twice, not once: one copy is squared away for the threshold
    ; test, the other has to survive on the stack for STORE_A below —
    ; a single DUP+MUL leaves only the square on the stack, and the new
    ; velocity itself is gone by the time STORE_A runs (found live: it
    ; pops an empty stack, storing undefined into vel_y).
    DUP
    DUP
    MUL
    PUSHC SETTLE_SPEED2
    CMPLT
    JZ a_vert_store
    POP
    PUSHI 0
    a_vert_store:
    STORE_A 3
    LOAD_A 1
    LOAD_B 1
    CMPLT
    JZ a_push_down
    LOAD_B 1
    PUSHI 11
    SUB
    STORE_A 1
    JMP a_knock_y
    a_push_down:
    LOAD_B 1
    PUSHI 11
    ADD
    STORE_A 1
    a_knock_y:
    LOAD_B 3
    LOADG g_scratch2
    PUSHC KNOCKBACK_SCALE
    MUL
    ADD
    STORE_B 3
    JMP done

    b_is_ball:
    ; ball = B, other = A — exact mirror of the block above.
    LOAD_B 2
    STOREG g_scratch
    LOAD_B 3
    STOREG g_scratch2
    LOAD_A 4
    PUSHI 2
    CMPEQ
    JNZ b_hit_target
    LOAD_A 8
    PUSHI 0
    CMPGT
    JNZ b_bounce
    LOAD_A 5
    PUSHC BLOCK_DAMAGE
    SUB
    STORE_A 5
    PUSHC HIT_COOLDOWN
    STORE_A 8
    JMP b_bounce
    b_hit_target:
    PUSHI 0
    STORE_A 5
    b_bounce:
    LOADG g_scratch
    DUP
    MUL
    LOADG g_scratch2
    DUP
    MUL
    CMPGE
    JZ b_vert
    LOADG g_scratch
    NEG
    PUSHC BOUNCE_DAMPING
    MUL
    STORE_B 2
    LOAD_B 0
    LOAD_A 0
    CMPLT
    JZ b_push_right
    LOAD_A 0
    PUSHI 11
    SUB
    STORE_B 0
    JMP b_knock_x
    b_push_right:
    LOAD_A 0
    PUSHI 11
    ADD
    STORE_B 0
    b_knock_x:
    LOAD_A 2
    LOADG g_scratch
    PUSHC KNOCKBACK_SCALE
    MUL
    ADD
    STORE_A 2
    JMP done
    b_vert:
    LOADG g_scratch2
    NEG
    PUSHC BOUNCE_DAMPING
    MUL
    DUP
    DUP
    MUL
    PUSHC SETTLE_SPEED2
    CMPLT
    JZ b_vert_store
    POP
    PUSHI 0
    b_vert_store:
    STORE_B 3
    LOAD_B 1
    LOAD_A 1
    CMPLT
    JZ b_push_down
    LOAD_A 1
    PUSHI 11
    SUB
    STORE_B 1
    JMP b_knock_y
    b_push_down:
    LOAD_A 1
    PUSHI 11
    ADD
    STORE_B 1
    b_knock_y:
    LOAD_A 3
    LOADG g_scratch2
    PUSHC KNOCKBACK_SCALE
    MUL
    ADD
    STORE_A 3
    JMP done

    support_resolve:
    ; Neither is the ball: pure resting/support, no damage. Whichever
    ; has the smaller y (higher on screen) sits on top of the other —
    ; snap it to rest exactly on the other's top surface and zero its
    ; fall, using each side's real half-height (BLOCK type 1 is 14px
    ; tall, everything else structural is 12-13px — a single type==1
    ; check covers all three types exactly enough to not visibly sink
    ; or float).
    LOAD_A 1
    LOAD_B 1
    CMPLT
    JZ b_upper
    LOAD_A 3
    PUSHI 0
    CMPGT
    JZ done
    PUSHI 0
    STORE_A 3
    ; Half-heights shaved by 1px from their true value (7/6 -> 6/5): a
    ; deliberate small overlap margin, not an approximation error. An
    ; exact-touch snap sits precisely on the strict-inequality overlap
    ; boundary the engine's collision scan uses, so a single tick's
    ; GRAVITY (0.28px of movement) can knock it just outside that
    ; boundary — on_collide then skips the pair entirely that tick
    ; (nothing overlapping to resolve), gravity adds another 0.28px,
    ; and it falls back in range next tick: a stable but visible
    ; forever-alternating vel_y between 0 and 0.28 (found by sampling
    ; a resting stack for thousands of ticks, not by eyeballing). A 1px
    ; overlap margin is comfortably bigger than one tick's fall, so the
    ; pair stays inside the strict-overlap boundary permanently and
    ; on_collide re-corrects it every single tick — genuinely at rest,
    ; not oscillating at a sub-pixel amplitude that happened to be
    ; small enough not to matter.
    LOAD_B 4
    PUSHI 1
    CMPEQ
    JZ a_halfB_6
    PUSHI 6
    JMP a_halfB_done
    a_halfB_6:
    PUSHI 5
    a_halfB_done:
    STOREG g_scratch
    LOAD_A 4
    PUSHI 1
    CMPEQ
    JZ a_halfA_6
    PUSHI 6
    JMP a_halfA_done
    a_halfA_6:
    PUSHI 5
    a_halfA_done:
    STOREG g_scratch2
    LOAD_B 1
    LOADG g_scratch
    SUB
    LOADG g_scratch2
    SUB
    STORE_A 1
    JMP done

    b_upper:
    LOAD_B 3
    PUSHI 0
    CMPGT
    JZ done
    PUSHI 0
    STORE_B 3
    LOAD_A 4
    PUSHI 1
    CMPEQ
    JZ b_halfA_6
    PUSHI 6
    JMP b_halfA_done
    b_halfA_6:
    PUSHI 5
    b_halfA_done:
    STOREG g_scratch
    LOAD_B 4
    PUSHI 1
    CMPEQ
    JZ b_halfB_6
    PUSHI 6
    JMP b_halfB_done
    b_halfB_6:
    PUSHI 5
    b_halfB_done:
    STOREG g_scratch2
    LOAD_A 1
    LOADG g_scratch
    SUB
    LOADG g_scratch2
    SUB
    STORE_B 1
    JMP done

    done:
    HALT
  `,
};

function buildCastleCrusherCart(){
  const airPixels = hexRowsToPixels(new Array(8).fill('77777777')); // base ramp (cool stone-grey sky), not the accent ramp
  const groundPixels = hexRowsToPixels([
    '11111111','11311131','33333333','33433433',
    '34333433','33433433','33343233','34333433',
  ]);
  const dirtPixels = hexRowsToPixels([
    '33333333','33433433','34333433','33333333',
    '33433433','33333333','34333433','33333333',
  ]);
  const stonePixels = hexRowsToPixels([
    '00000000','04440444','04440444','00000000',
    '44404440','44404440','00000000','04440444',
  ]);
  const ballShapes = [
    {type:SHAPE_ELLIPSE, cx:8,cy:8, rx:6.5,ry:6.5, color:0},
    {type:SHAPE_ELLIPSE, cx:8,cy:8, rx:5.2,ry:5.2, color:1},
    {type:SHAPE_ELLIPSE, cx:6,cy:6, rx:1.6,ry:1.6, color:7},
  ];
  // A heavy, square stone block — outline/body/sheen. Base-ramp greys,
  // not the accent ramp — keeps the block reading as "stone structure,"
  // distinct from the red ball/target (both accent).
  const blockShapes = [
    {type:SHAPE_RECT, x:0.5,y:0.5,w:15,h:15, color:0},
    {type:SHAPE_RECT, x:2,y:2,w:12,h:12, color:2},
    {type:SHAPE_RECT, x:2,y:2,w:12,h:2.5, color:4},
  ];
  // Second block silhouette (§21 follow-up: the "castle" was just
  // scattered identical squares) — a battlement/turret with two merlons
  // poking above the main wall body, spawned on alternating block
  // checkpoints (on_init's block_loop) so the skyline actually reads as
  // wall-plus-towers instead of one repeated shape.
  const towerShapes = [
    {type:SHAPE_RECT, x:1.5,y:3,w:13,h:12.5, color:0},
    {type:SHAPE_RECT, x:3,y:4.5,w:10,h:9.5, color:2},
    {type:SHAPE_RECT, x:3,y:4.5,w:10,h:2, color:4},
    {type:SHAPE_RECT, x:3,y:0.5,w:3,h:3.5, color:0},
    {type:SHAPE_RECT, x:10,y:0.5,w:3,h:3.5, color:0},
  ];
  const targetShapes = blobMonsterShapes(12, 0, 15, 0);

  const T = PLATFORM_TOKENS;
  // Flat terrain — no STEP_UP anywhere, so nothing between the fixed
  // anchor and any block/target can wall it off (§21/§22). A real
  // castle silhouette: two 3-block towers flanking a connecting wall
  // (2 courses high, using COIN_AT's row-offset operand — §23 — to
  // stack blocks straight up at one column instead of spreading them
  // along the ground), a gate gap in the middle of the wall, a guard
  // target on top of each tower, and a target sitting in the gate
  // itself plus one floating just above it.
  // Column placement matters as much as height here: the projectile's
  // horizontal speed decays every tick (GROUND_FRICTION applies whether
  // or not it's grounded), so the reachable envelope isn't the naive
  // parabola range — it's a hump that peaks a handful of columns out
  // from the anchor and collapses back to "ground level only" well
  // before the level's far edge. Measured empirically (fine-grained
  // angle/power sweep recording every (column, max height) actually
  // touched): height-7 stacks are reachable out to roughly column 20
  // from the anchor, not column 30+ — an earlier version placed the
  // far tower past that boundary and it was structurally unreachable
  // no matter the shot. Keeping the whole castle within ~24 columns
  // keeps every stack inside the measured envelope with margin.
  const tokens = [
    T.FLAT,6,
    T.COIN_AT,1, T.COIN_AT,3, T.COIN_AT,5, T.ENEMY_AT,7, T.FLAT,2, // left tower
    T.COIN_AT,1, T.COIN_AT,3, T.FLAT,2, // wall course
    T.COIN_AT,1, T.COIN_AT,3, T.FLAT,2, // wall course
    T.ENEMY_AT,1, T.ENEMY_AT,5, T.FLAT,2, // gate: ground target + floating target above it
    T.COIN_AT,1, T.COIN_AT,3, T.FLAT,2, // wall course
    T.COIN_AT,1, T.COIN_AT,3, T.FLAT,2, // wall course
    T.COIN_AT,1, T.COIN_AT,3, T.COIN_AT,5, T.ENEMY_AT,7, T.FLAT,6, // right tower
  ];
  const platform = {gridH:20, startGroundY:16, minGroundY:8, maxGroundY:18, tokens};
  const built = buildPlatformLevel(platform);
  const gridW = built.grid[0].length;
  const numBlocks = built.numCoins, numTargets = built.numEnemies;
  const screenW = 160, screenH = 160;
  const levelWpx = gridW*8, levelHpx = platform.gridH*8;

  const cart = {
    formatVersion: 1,
    name: 'Castle Crusher', author: 'Urlcade', // URL envelope only, see DESIGN.md §34 — never reaches the binary format
    cartType: 5,
    paletteMode: 1,
    paletteParams: [210, 0, 10, 30, 25, 70, 150, 0], // cool stone/grey hue
    rngSeed: 4,
    modeFlags: 0,
    screenW, screenH,
    mapGenerator: 3,
    backdropFillIndex: 0, backdropGroundHeight: 0, backdropGroundIndex: 0,
    camera: {
      followGlobal: DESTRUCT_GLOBAL_NAMES.g_active_proj,
      clampMinX: 0, clampMinY: 0,
      clampMaxX: Math.max(0, levelWpx - screenW),
      clampMaxY: Math.max(0, levelHpx - screenH),
    },
    aimLine: {
      anchorXGlobal: DESTRUCT_GLOBAL_NAMES.g_anchor_x,
      anchorYGlobal: DESTRUCT_GLOBAL_NAMES.g_anchor_y,
      angleGlobal: DESTRUCT_GLOBAL_NAMES.g_angle,
      powerGlobal: DESTRUCT_GLOBAL_NAMES.g_power,
      maxPowerConstIdx: DESTRUCT_CONST_NAMES.MAX_POWER,
      activeGlobal: DESTRUCT_GLOBAL_NAMES.g_aiming,
      colorIdx: 0, maxLengthPx: 40,
    },
    inputActiveButtons: 1|2|4,
    inputTouchTemplate: TOUCH_TEMPLATE_STEER_ACTION,
    inputButtonLabels: {1:'Angle -', 2:'Angle +', 4:'Charge/Fire'},
    hudSpec: [
      {kind:0, sourceKind:0, srcA:DESTRUCT_GLOBAL_NAMES.g_shots_left, srcB:0, delta:0, suffixConstIdx:255, label:'Shots'},
      {kind:0, sourceKind:0, srcA:DESTRUCT_GLOBAL_NAMES.g_targets_left, srcB:0, delta:0, suffixConstIdx:255, label:'Targets'},
      {kind:1, sourceKind:0, srcA:DESTRUCT_GLOBAL_NAMES.g_won, srcB:0, delta:0, suffixConstIdx:255, label:'Castle cleared! Refresh link to play again'},
      {kind:1, sourceKind:0, srcA:DESTRUCT_GLOBAL_NAMES.g_lost, srcB:0, delta:0, suffixConstIdx:255, label:'Out of shots - refresh link to retry'},
    ],
    // constants array must match DESTRUCT_CONST_NAMES' index order exactly:
    // GRAVITY, MAX_FALL_SPEED, LAUNCH_SPEED_SCALE, MIN_ANGLE, MAX_ANGLE,
    // ANGLE_RATE, CHARGE_RATE, MAX_POWER, BLOCK_DAMAGE, NUM_SHOTS,
    // NUM_BLOCKS, NUM_TARGETS, LEVEL_W, LEVEL_H, GROUND_FRICTION,
    // BLOCK_START_HP, SETTLE_SPEED2, HIT_COOLDOWN, BOUNCE_DAMPING,
    // KNOCKBACK_SCALE. BOUNCE_DAMPING/KNOCKBACK_SCALE tuned by measured
    // playtest (see DESIGN.md §24): damped enough that a shot doesn't
    // ricochet wildly, strong enough that a solid hit visibly topples a
    // block off a stack rather than just rocking in place.
    constants: [0.28, 8, 0.09, 15, 75, 1.5, 4, 100, 2, 16, numBlocks, numTargets, levelWpx, levelHpx, 0.985, 6, 0.04, 8, 0.35, 0.45],
    entityTypes: [
      {renderKind:0, assetIndex:0, rotateFlag:0, collisionW:8, collisionH:8, extFieldCount:0},
      {renderKind:0, assetIndex:1, rotateFlag:0, collisionW:14, collisionH:14, extFieldCount:1}, // BLOCK (ext 8 = hit_cooldown)
      {renderKind:0, assetIndex:2, rotateFlag:0, collisionW:12, collisionH:12, extFieldCount:0},
      {renderKind:0, assetIndex:3, rotateFlag:0, collisionW:13, collisionH:12, extFieldCount:1}, // BLOCK variant (turret) — same fields as BLOCK, just a different sprite/shape
    ],
    sprites: [ {kind:1, w:16, h:16, shapes:ballShapes}, {kind:1, w:16, h:16, shapes:blockShapes}, {kind:1, w:16, h:16, shapes:targetShapes}, {kind:1, w:16, h:16, shapes:towerShapes} ],
    tiles: [
      {w:8,h:8,pixels:airPixels}, {w:8,h:8,pixels:groundPixels},
      {w:8,h:8,pixels:dirtPixels}, {w:8,h:8,pixels:stonePixels},
    ],
    tileSurfaceOverrides: {[PLATFORM_AIR]: 0},
    platform,
    hooks: {},
  };
  for(const name of HOOK_NAMES){
    const src = DESTRUCT_HOOKS_SRC[name];
    cart.hooks[name] = src ? assemble(src.split('\n'), DESTRUCT_SYM) : new Uint8Array(0);
  }
  return cart;
}


export { buildCastleCrusherCart };
