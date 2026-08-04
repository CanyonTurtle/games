# Map generators

`cart.mapGenerator` selects one of three (`0` = none, no map — `GETTILE`
always returns `-1` and the cart draws its own backdrop). Each generator
is pure — same config in, same grid out — and returns
`{ grid, checkpoints, ... }`; `grid` is `grid[y][x]`, 1-based tile ids
indexing `cart.tiles[id-1]`. `checkpoints` is an array of `{x, y}` pixel
positions, read in a hook via `GET_CHECKPOINT` (index in, pushes x then
y). Tile id `1` is the fixed convention for "solid boundary" — every
generator uses it for both its actual wall/edge tiles *and* as what
`GETTILE` returns for any off-grid query, so a cart never needs a
separate off-grid check.

## `mapGenerator: 1` — track (turtle graphics)

`cart.track = { tokens, trackWidth, segLen, startGX, startGY, startDir, gridW, gridH }`.

A turtle starts at tile `(startGX, startGY)` heading `startDir` (`0`=+x,
`1`=+y, `2`=-x, `3`=-y) and walks `tokens` — a flat array of these values
(no operands):

- `STRAIGHT (0)` — advances `segLen` tiles in the current heading,
  stamping a `trackWidth`-wide perpendicular strip at every tile stepped
  (the two edge tiles get `TILE_RUMBLE`, everything between gets
  `TILE_ROAD`).
- `CURVE_R90 (1)` / `CURVE_L90 (2)` — fills a `trackWidth`×`trackWidth`
  block of `TILE_ROAD` at the current position, turns 90° right/left,
  advances one tile.
- `START_FINISH (3)` / `CHECKPOINT (4)` — records a checkpoint at the
  current position *and* queues a `trackWidth`-wide perpendicular marker
  line (`TILE_STARTLINE` / `TILE_CHECKPOINT`) to be stamped in one final
  pass after the entire token walk finishes — deliberately deferred, so a
  later part of the walk (a closing curve on a looped track, for
  instance) can never overwrite the marker by stamping plain road over
  it first.
- `WAYPOINT (5)` — records a checkpoint only, no tile stamp (an AI
  steering target with no visible marker).

Tile ids: `1` = edge/untouched (also the grid's initial fill value), `2` =
`TILE_ROAD`, `3` = `TILE_RUMBLE`, `4` = `TILE_STARTLINE`, `5` =
`TILE_CHECKPOINT`. A cart's
`tiles[]` array needs 5 entries if it uses all five (start/finish and
checkpoint can point at the same bitmap if a cart doesn't need them to
look different).

## `mapGenerator: 2` — cave (cellular automata)

`cart.cave = { gridW, gridH, fillProb, iterations, wallThreshold, goldCount }`.

Every non-border cell starts as wall with probability `fillProb/255`
(border is always wall); then `iterations` smoothing passes apply
"wall if `wallThreshold`+ of its 8 neighbors are wall, floor otherwise".
After smoothing, a BFS from the first floor tile found (raster order)
finds the single farthest reachable tile and walls off every floor tile
*not* reachable from that start (no isolated pockets survive). Up to
`goldCount` of the remaining reachable floor tiles (excluding the start
and the farthest point) are randomly chosen and set to gold.

Tile ids: `1` = `CAVE_WALL`, `2` = `CAVE_FLOOR`, `3` = `CAVE_STAIRS`
(the BFS-farthest tile), `4` = `CAVE_GOLD`. `checkpoints[0]` = the BFS
start tile's center (a natural player-spawn point), `checkpoints[1]` =
the stairs tile's center. `tileSurfaceOverrides` needs `2` (and `3`/`4`
if used) mapped to `0` for `MOVE_SOLID` to treat floor as walkable — see
`cart-object.md`.

## `mapGenerator: 3` — platform (side-scroller)

`cart.platform = { gridH, startGroundY, minGroundY, maxGroundY, tokens }`.
`gridW` is not given directly — it's the sum of every width-token's
width, computed by the generator itself. `tokens` is a flat array where
some entries consume the *next* array slot as an operand:

- `FLAT (0), width` — fills `width` columns of ground at the current
  ground row (`groundY`; a `PLATFORM_GROUND` cap tile with
  `PLATFORM_DIRT` filling down to the bottom).
- `STEP_UP (1), width` — raises `groundY` by 1 (clamped to
  `minGroundY`), then fills `width` columns at the new height.
- `STEP_DOWN (2), width` — lowers `groundY` by 1 (clamped to
  `maxGroundY`), then fills `width` columns.
- `GAP (3), width` — leaves `width` columns with no ground at all except
  a single `PLATFORM_GROUND` tile 5 rows below `groundY` (clamped to the
  grid's bottom row) — a pit with a floor, not a bottomless drop.
- `BLOCK (4), width` — fills `width` columns of ground normally, and
  additionally places up to 3 `PLATFORM_BRICK` tiles in a floating row 4
  tiles above `groundY`.
- `COIN (5)` — a checkpoint 3 rows above `groundY` at the current column;
  doesn't advance the column cursor.
- `ENEMY (6)` — a checkpoint 1 row above `groundY` at the current column;
  doesn't advance the column cursor.
- `COIN_AT (7), rowOffset` — like `COIN` but at `groundY - rowOffset`
  rows instead of the fixed 3.
- `ENEMY_AT (8), rowOffset` — like `ENEMY` but at `groundY - rowOffset`.

Tile ids: `1` = `PLATFORM_AIR`, `2` = `PLATFORM_GROUND`, `3` =
`PLATFORM_DIRT`, `4` = `PLATFORM_BRICK`. Returned checkpoints are
`[startCp, ...coinCheckpoints, ...enemyCheckpoints]` in that order, plus
`numCoins`/`numEnemies` counts so a hook's spawn loop knows how many of
each type to walk through (`checkpoints[0]` is the start position;
`checkpoints[1 .. numCoins]` are coins; the rest are enemies).
