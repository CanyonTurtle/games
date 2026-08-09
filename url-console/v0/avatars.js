/* ============================================================
   The Urlcade — a fixed, hand-authored avatar set (Multiplayer Party,
   DESIGN.md §97+)

   Each avatar is a small kind:1 shape list — the exact same
   {type:SHAPE_ELLIPSE|SHAPE_RECT, ..., color} primitives the sprite
   editor already authors (see STARTER_TEMPLATE's own ball sprite,
   inspector.js). Deliberately *not* run through World.buildBitmap
   (runtime.js) — that needs a real World instance purely to resolve
   `color` indices via `this.paletteRGB`, which is itself derived from a
   cart's own paletteParams (kernel.js's generatePalette). An avatar
   isn't part of any cart, so standing up a throwaway World (and its GL
   texture lifecycle, see runtime.js's buildCardThumbnail) just to reuse
   a trivial index-to-RGB lookup would be pure overhead. Instead:
   kernel.js's renderShapeList (pure, no World needed) rasterizes to a
   flat index array, and AVATAR_COLORS below resolves those indices
   directly against a small fixed hex table of this module's own —
   index 0 is always transparent, matching the sprite convention.
   ============================================================ */
const K = window.UrlcadeKernel;
const { SHAPE_ELLIPSE, SHAPE_RECT } = K;

const AVATAR_SIZE = 8;

// Index 0 is reserved (transparent, never assigned to a shape below);
// 1-8 are this module's own fixed palette, unrelated to any cart's.
const AVATAR_COLORS = [
  null, '#e0574f', '#e0a83f', '#dbcf4a', '#79c56b',
  '#4fb8c7', '#5f86d6', '#9a6fd6', '#d669b0',
];

const AVATARS = [
  { name: 'Dot', shapes: [
    {type:SHAPE_ELLIPSE, cx:4, cy:4, rx:3, ry:3, color:1},
  ]},
  { name: 'Square', shapes: [
    {type:SHAPE_RECT, x:1, y:1, w:6, h:6, color:2},
  ]},
  { name: 'Ring', shapes: [
    {type:SHAPE_ELLIPSE, cx:4, cy:4, rx:3.5, ry:3.5, color:3},
    {type:SHAPE_ELLIPSE, cx:4, cy:4, rx:1.5, ry:1.5, color:0},
  ]},
  { name: 'Plus', shapes: [
    {type:SHAPE_RECT, x:3, y:0, w:2, h:8, color:4},
    {type:SHAPE_RECT, x:0, y:3, w:8, h:2, color:4},
  ]},
  { name: 'Target', shapes: [
    {type:SHAPE_ELLIPSE, cx:4, cy:4, rx:3.5, ry:3.5, color:5},
    {type:SHAPE_ELLIPSE, cx:4, cy:4, rx:2, ry:2, color:0},
    {type:SHAPE_ELLIPSE, cx:4, cy:4, rx:0.8, ry:0.8, color:5},
  ]},
  { name: 'Eyes', shapes: [
    {type:SHAPE_ELLIPSE, cx:2.5, cy:4, rx:1.3, ry:1.3, color:6},
    {type:SHAPE_ELLIPSE, cx:5.5, cy:4, rx:1.3, ry:1.3, color:6},
  ]},
  { name: 'Corners', shapes: [
    {type:SHAPE_RECT, x:0, y:0, w:3, h:3, color:7},
    {type:SHAPE_RECT, x:5, y:5, w:3, h:3, color:7},
  ]},
  { name: 'Bars', shapes: [
    {type:SHAPE_RECT, x:0, y:1, w:8, h:1.5, color:8},
    {type:SHAPE_RECT, x:0, y:3.5, w:8, h:1.5, color:8},
    {type:SHAPE_RECT, x:0, y:6, w:8, h:1.5, color:8},
  ]},
];

function hexToRGB(hex){
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

// Wraps any integer (including out-of-range/stale ids from a saved
// identity predating an avatar-set change) into a valid index rather
// than throwing — see runtime.js's own getIdentity/setIdentity comment
// on why bounds-checking is deliberately this module's job, not theirs.
function normalizeAvatarId(avatarId){
  const n = AVATARS.length;
  return ((avatarId % n) + n) % n;
}

// Pure — no World, no cart, just this module's own fixed shapes +
// colors. Returns a small (AVATAR_SIZE x AVATAR_SIZE) canvas; callers
// scale it with CSS (image-rendering:pixelated), the same convention
// every other sprite/tile canvas in this codebase already uses.
function renderAvatarCanvas(avatarId){
  const avatar = AVATARS[normalizeAvatarId(avatarId)];
  const pixels = K.renderShapeList(AVATAR_SIZE, AVATAR_SIZE, avatar.shapes);
  const canvas = document.createElement('canvas');
  canvas.width = AVATAR_SIZE; canvas.height = AVATAR_SIZE;
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(AVATAR_SIZE, AVATAR_SIZE);
  for(let i = 0; i < AVATAR_SIZE * AVATAR_SIZE; i++){
    const hex = AVATAR_COLORS[pixels[i]];
    if(!hex){ img.data[i*4+3] = 0; continue; }
    const [r,g,b] = hexToRGB(hex);
    img.data[i*4] = r; img.data[i*4+1] = g; img.data[i*4+2] = b; img.data[i*4+3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

export { AVATARS, AVATAR_SIZE, normalizeAvatarId, renderAvatarCanvas };
