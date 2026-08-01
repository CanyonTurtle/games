/* ============================================================
   The Urlcade — shared cart-authoring sprite helpers

   Authoring-time sugar shared by more than one example cart (DRY for
   the cart-*authoring* code only — the encoded cart gets the resulting
   plain pixel/shape data either way, never a reference to these
   functions; see kernel.js's renderShapeList for the runtime-side
   generator these ultimately feed). Split into its own module because
   more than one carts/*.js file imports it — see DESIGN.md §17.
   ============================================================ */
"use strict";
const K = window.UrlcadeKernel;
const { SHAPE_ELLIPSE } = K;

function hexRowsToPixels(rows){
  const px = [];
  for(const row of rows) for(const ch of row) px.push(parseInt(ch,16));
  return px;
}

// "head+body+feet" for the roguelike/platformer players; "single body
// mass+eyes+legs" for the roguelike monster and platformer enemy (pass
// eyeColor===pupilColor for a flat single-tone eye instead of a
// two-tone eye+pupil, as the platformer enemy and castle-crusher target do).
function blobPlayerShapes(bodyColor, outlineColor){
  return [
    {type:SHAPE_ELLIPSE, cx:8,cy:4.3, rx:3.3,ry:3.1, color:outlineColor},
    {type:SHAPE_ELLIPSE, cx:8,cy:4.3, rx:2.6,ry:2.4, color:bodyColor},
    {type:SHAPE_ELLIPSE, cx:8,cy:10.4, rx:4.5,ry:4.1, color:outlineColor},
    {type:SHAPE_ELLIPSE, cx:8,cy:10.4, rx:3.7,ry:3.3, color:bodyColor},
    {type:SHAPE_ELLIPSE, cx:5.7,cy:14.5, rx:1.6,ry:1.15, color:outlineColor},
    {type:SHAPE_ELLIPSE, cx:10.3,cy:14.5, rx:1.6,ry:1.15, color:outlineColor},
  ];
}
function blobMonsterShapes(bodyColor, outlineColor, eyeColor, pupilColor){
  return [
    {type:SHAPE_ELLIPSE, cx:8,cy:8.8, rx:6.1,ry:5.5, color:outlineColor},
    {type:SHAPE_ELLIPSE, cx:8,cy:8.8, rx:5.0,ry:4.4, color:bodyColor},
    {type:SHAPE_ELLIPSE, cx:5.2,cy:14.6, rx:1.6,ry:1.2, color:bodyColor},
    {type:SHAPE_ELLIPSE, cx:10.8,cy:14.6, rx:1.6,ry:1.2, color:bodyColor},
    {type:SHAPE_ELLIPSE, cx:5.7,cy:6.7, rx:1.7,ry:1.7, color:eyeColor},
    {type:SHAPE_ELLIPSE, cx:10.3,cy:6.7, rx:1.7,ry:1.7, color:eyeColor},
    {type:SHAPE_ELLIPSE, cx:5.7,cy:7.1, rx:0.75,ry:0.75, color:pupilColor},
    {type:SHAPE_ELLIPSE, cx:10.3,cy:7.1, rx:0.75,ry:0.75, color:pupilColor},
  ];
}

export { hexRowsToPixels, blobPlayerShapes, blobMonsterShapes };
