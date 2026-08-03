/* ============================================================
   The Urlcade — Debug view (Cart Inspector + self-serve compiler)

   A second top-level view (alongside the shelf/player) that decodes any
   Urlcade cart — the one currently playing (via the game view's "Debug"
   button), a pasted link, or a fresh "+ New Cart" — into three tabs:

   - Assets: palette, sprites, tiles — everything that's just pixels.
   - Logic: header/camera/input overview, map, entity types, and every
     hook's bytecode decompiled to a labeled listing and a flowchart.
   - Source: the cart as an editable plain-JS-object literal (hooks as
     assembly-source line arrays, plus name/author — see AUTHORING.md).
     Compile status/fragment/errors sit at the top of this tab, the
     textarea right below, so editing and its feedback are never more
     than a scroll apart. Recompiles automatically as you type, and a
     successful compile live-updates every other tab too — the cart this
     whole view describes is always whatever Source currently says, not
     a stale snapshot from whenever Debug was opened.

   This used to be nine tabs (Overview/Palette/Sprites/Tiles/Map/
   Entities/Hooks/Source/Compile — themselves the result of an earlier
   merge of a read-only Inspector and a standalone /compile page).
   Grouping into three matches how an author actually thinks about a
   cart's parts — assets, logic, source — rather than exposing the
   Inspector's own internal render-function boundaries as separate tabs.

   Reuses kernel.js's disassembler/CFG extractor and compileCartSource()
   (window.UrlcadeKernel — a classic <script> global, not an import; see
   runtime.js's header for why) and runtime.js's World class (to reuse
   its buildBitmap/mapCanvas output instead of a second copy of that
   rendering logic).
   ============================================================ */
"use strict";
const K = window.UrlcadeKernel;
const {
  formatDisassembly, renderCFGSvg, compileCartSource, decodeCartUrl,
  generatePalette, SHAPE_ELLIPSE, HOOK_NAMES, decodeCart, decodePayloadToBytes,
} = K;
import { World, disposeGLTextures } from './runtime.js';

const INSPECT_TABS = ['Assets', 'Logic', 'Source'];
const MAP_GEN_NAMES = {0:'none', 1:'track (turtle-grammar)', 2:'cave (cellular automata)', 3:'platform (heightmap turtle-grammar)'};
const TOUCH_TEMPLATE_NAMES = {0:'none', 1:'single button', 2:'steer + action', 3:'d-pad + action', 4:'d-pad only'};
let inspectWorld = null, inspectCartInfo = null, inspectTab = 'Logic', inspectHookTab = 'on_init';
// Source tab state — independent of inspectCartInfo because it has to
// survive a *failed* compile (inspectCartInfo keeps showing the
// last-known-good cart on Assets/Logic while Source shows what you
// actually typed and its status block shows why it doesn't work yet).
let sourceText = '', compileState = null, sourceDebounceTimer = null;

// Accepts a full pasted URL, a bare fragment, or a raw payload string —
// takes whatever comes after the last '#' if there is one, else the
// whole trimmed string.
function extractPayloadFromInput(raw){
  let s = raw.trim();
  const hashIdx = s.lastIndexOf('#');
  if(hashIdx >= 0) s = s.slice(hashIdx+1);
  if(s.startsWith('debug:') || s.startsWith('inspect:')) s = s.slice(s.indexOf(':')+1);
  return s;
}

// formatDisassembly()'s block-labeled output (B0:, B1:, ...) is
// deliberately assemble()-compatible (see kernel.js), so a decompiled
// hook pastes straight into compileCartSource() unmodified — that's
// what makes the Source tab round-trip. name/author go in front of the
// binary-only cart fields, matching compileCartSource's own reading of
// them (see kernel.js) — they never round-trip through decodeCart, only
// through this object and the fragment's own URL envelope.
function cartToSourceObject(cart, name, author){
  const out = {name: name || '', author: author || ''};
  Object.assign(out, cart);
  out.hooks = {};
  for(const hookName of HOOK_NAMES){
    const bc = cart.hooks[hookName];
    out.hooks[hookName] = (bc && bc.length) ? formatDisassembly(bc).split('\n') : [];
  }
  return out;
}

async function startInspect(rawFragment){
  let cart, bytes, name = '', author = '';
  try{
    const decodedUrl = decodeCartUrl(rawFragment);
    name = decodedUrl.name; author = decodedUrl.author;
    bytes = await decodePayloadToBytes(decodedUrl.payload);
    cart = decodeCart(bytes);
  } catch(err){
    document.getElementById('inspectError').textContent = 'Could not decode this as an Urlcade cart: ' + err.message;
    return false;
  }
  document.getElementById('inspectError').textContent = '';
  if(inspectWorld) disposeGLTextures(inspectWorld);
  try{
    inspectWorld = new World(cart);
  } catch(err){
    document.getElementById('inspectError').textContent = 'Decoded, but the map/entity data could not be built: ' + err.message;
    return false;
  }
  inspectCartInfo = {cart, payload: rawFragment, byteLen: bytes.length, charLen: rawFragment.length, name, author};
  inspectTab = 'Logic';
  const liveHooks = HOOK_NAMES.filter(n => cart.hooks[n] && cart.hooks[n].length > 0);
  inspectHookTab = liveHooks[0] || HOOK_NAMES[0];
  sourceText = JSON.stringify(cartToSourceObject(cart, name, author), null, 2);
  document.getElementById('menu').classList.remove('active');
  document.getElementById('gameWrap').classList.remove('active');
  const iw = document.getElementById('inspectWrap');
  iw.classList.remove('active'); void iw.offsetWidth; iw.classList.add('active');
  updateTitle();
  renderInspectTabs();
  renderInspectBody();
  // Populate the Source tab's compile status / tab-strip badge
  // immediately, without requiring an edit first — what Source currently
  // says should always compile cleanly right after a successful decode.
  // compileSourceText() itself never throws (every failure path sets
  // compileState instead of rejecting) — still guarded here as defense
  // in depth: an unguarded await in a caller with no .catch() turns any
  // unexpected throw into a silent, invisible failure, which is exactly
  // the bug class that made "Debug/New Cart do nothing" hard to
  // diagnose in the first place.
  try{ await compileSourceText(); } catch(err){ console.error('compileSourceText failed:', err); }
  return true;
}

function updateTitle(){
  const {cart, byteLen, charLen, name} = inspectCartInfo;
  const label = name ? `${name} — cart_type ${cart.cartType}` : `cart_type ${cart.cartType}`;
  document.getElementById('inspectTitle').textContent = `${label} · ${byteLen}B raw / ${charLen} chars`;
}

function renderInspectTabs(){
  const wrap = document.getElementById('inspectTabs');
  wrap.innerHTML = INSPECT_TABS.map(t => {
    let label = t;
    let cls = 'inspect-tab' + (t===inspectTab ? ' active' : '');
    if(t === 'Source' && compileState){
      cls += compileState.ok ? ' tab-ok' : ' tab-err';
      label = t + (compileState.ok ? ' ✓' : ' ✕');
    }
    return `<button class="${cls}" data-tab="${t}">${label}</button>`;
  }).join('');
  wrap.querySelectorAll('.inspect-tab').forEach(btn => btn.addEventListener('click', () => {
    inspectTab = btn.dataset.tab;
    renderInspectTabs();
    renderInspectBody();
  }));
}

function esc(s){ return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;'); }
function table(rows){
  return '<table class="inspect-table">' + rows.map(r => '<tr>' + r.map((c,i) =>
    `<${i===0?'th':'td'}>${c}</${i===0?'th':'td'}>`).join('') + '</tr>').join('') + '</table>';
}

function renderInspectOverview(cart){
  let html = '';
  html += '<div class="inspect-section-title">Header</div>' + table([
    ['field','value'],
    ['format version', cart.formatVersion],
    ['cart type', cart.cartType + ' <span style="color:var(--ink-dim)">(advisory label only, never a runtime dispatch key)</span>'],
    ['screen', `${cart.screenW} × ${cart.screenH}`],
    ['palette mode', cart.paletteMode + (cart.paletteMode===0 ? ' (curated bank)' : ' (procedural harmony)')],
    ['palette params', esc(cart.paletteParams.join(', '))],
    ['rng seed', cart.rngSeed],
    ['mode flags', '0b' + cart.modeFlags.toString(2).padStart(8,'0')],
    ['map generator', cart.mapGenerator + ' — ' + (MAP_GEN_NAMES[cart.mapGenerator] || 'unknown')],
  ]);
  html += '<div class="inspect-section-title">Camera</div>' + table([
    ['field','value'],
    ['follow global', cart.camera.followGlobal===255 ? '255 (none/static)' : cart.camera.followGlobal],
    ['clamp x', `${cart.camera.clampMinX} – ${cart.camera.clampMaxX}`],
    ['clamp y', `${cart.camera.clampMinY} – ${cart.camera.clampMaxY}`],
  ]);
  html += '<div class="inspect-section-title">Input</div>' + table([
    ['field','value'],
    ['active buttons', '0b' + cart.inputActiveButtons.toString(2).padStart(5,'0') + ' — ' +
      (Object.entries(cart.inputButtonLabels).map(([bit,label])=>`${bit}=${esc(label)}`).join(', ') || '(none)')],
    ['touch template', cart.inputTouchTemplate + ' — ' + (TOUCH_TEMPLATE_NAMES[cart.inputTouchTemplate]||'unknown')],
  ]);
  if(Object.keys(cart.tileSurfaceOverrides).length){
    html += '<div class="inspect-section-title">Tile surface overrides</div>' + table([
      ['tile id','surface id'],
      ...Object.entries(cart.tileSurfaceOverrides),
    ]);
  }
  if(cart.hudSpec.length){
    html += '<div class="inspect-section-title">HUD spec</div>' + table([
      ['kind','source','label'],
      ...cart.hudSpec.map(h => [
        ['numeric','flag','numeric-if-nonzero'][h.kind] ?? h.kind,
        (h.sourceKind===0?'global ':'entity prop via global ') + h.srcA + (h.sourceKind===1?(' prop '+h.srcB):''),
        esc(h.label),
      ]),
    ]);
  }
  html += '<div class="inspect-section-title">Constants</div>' + table([
    ['#','value'],
    ...cart.constants.map((v,i) => [i, Number.isInteger(v) ? v : v.toFixed(4)]),
  ]);
  return html;
}

// A dense 8-wide swatch grid, not a card list — see index.html's .pal-*
// CSS comment for why. `paletteMode:1` (procedural) carts get their
// 0-7/8-15 split called out with real section labels, because that
// split is a structural guarantee of generatePalette() itself (DESIGN.md
// §41): every procedural cart's entities really do come from a
// distinctly-hued, brighter accent ramp, not just "the second half of
// the array." `paletteMode:0` (curated) banks don't get that same
// labeling — CURATED_BANK's own comments show the split isn't
// consistent there (bank 0's backdrop colors sit at 8-9, its entities
// at 0-7; bank 1 is the reverse), so labeling it "terrain/entities"
// would be asserting a convention that particular bank doesn't follow.
function renderPaletteStrip(colors, startIndex){
  return '<div class="pal-strip">' + colors.map((c,i) => `
    <div class="pal-swatch" style="background:${c}" title="${startIndex+i}: ${esc(c)}"><span>${startIndex+i}</span></div>
  `).join('') + '</div>';
}
function renderInspectPalette(cart){
  const pal = generatePalette(cart);
  if(cart.paletteMode === 1){
    return `
      <div class="pal-group">
        <p class="pal-group-label">Terrain / backdrop (0-7)</p>
        ${renderPaletteStrip(pal.slice(0,8), 0)}
      </div>
      <div class="pal-group">
        <p class="pal-group-label">Entities (8-15)</p>
        ${renderPaletteStrip(pal.slice(8,16), 8)}
      </div>`;
  }
  return `<div class="pal-group">${renderPaletteStrip(pal, 0)}</div>`;
}

function spritesListHtml(cart){
  let html = '';
  cart.sprites.forEach((s,i) => {
    html += `<div class="inspect-section-title">Sprite ${i} — ${s.w}×${s.h}, ${s.kind===1?'shape list':'raw pixels'}</div>`;
    html += `<div id="spriteSlot${i}" style="max-width:160px;margin-bottom:10px;"></div>`;
    if(s.kind === 1){
      html += table([
        ['#','type','params','color'],
        ...s.shapes.map((sh,k) => [k, sh.type===SHAPE_ELLIPSE?'ellipse':'rect',
          sh.type===SHAPE_ELLIPSE ? `cx=${sh.cx} cy=${sh.cy} rx=${sh.rx} ry=${sh.ry}` : `x=${sh.x} y=${sh.y} w=${sh.w} h=${sh.h}`,
          sh.color]),
      ]);
    }
  });
  return html;
}
function attachSpriteCanvases(cart){
  cart.sprites.forEach((s,i) => {
    const slot = document.getElementById('spriteSlot'+i);
    const c = inspectWorld.spriteCanvases[i];
    c.style.width = '100%'; c.style.imageRendering = 'pixelated';
    c.style.border = '1px solid var(--rule)'; c.style.background = 'var(--bg-card)';
    slot.appendChild(c);
  });
}
function attachTileCanvases(cart){
  const grid = document.getElementById('tileGrid');
  cart.tiles.forEach((t,i) => {
    const tile = document.createElement('div');
    tile.className = 'inspect-tile';
    const c = inspectWorld.tileCanvases[i];
    c.style.width = '100%'; c.style.imageRendering = 'pixelated';
    tile.appendChild(c);
    const p = document.createElement('p');
    p.textContent = `tile ${i} — ${t.w}×${t.h}`;
    tile.appendChild(p);
    grid.appendChild(tile);
  });
}
// Assets tab: palette + sprites + tiles, in sequence — everything that's
// just pixels, nothing that's behavior. Built as one body.innerHTML pass
// (not three separate ones) so the sprite/tile canvases' slot divs exist
// before attachSpriteCanvases/attachTileCanvases go looking for them.
function renderInspectAssets(body, cart){
  let html = '<div class="inspect-section-title">Palette</div>';
  html += renderInspectPalette(cart);
  html += '<div class="inspect-section-title">Sprites</div>';
  html += spritesListHtml(cart);
  html += '<div class="inspect-section-title">Tiles</div>';
  html += '<div class="inspect-grid" id="tileGrid"></div>';
  body.innerHTML = html;
  attachSpriteCanvases(cart);
  attachTileCanvases(cart);
}

function renderInspectMap(cart){
  if(cart.mapGenerator === 0 || !inspectWorld.map) return '<p class="inspect-empty">No map generator (mapGenerator = 0) — backdrop only.</p>';
  let html = '<div class="inspect-section-title">Generator params</div>';
  if(cart.mapGenerator === 1){
    const t = cart.track;
    html += table([['field','value'], ['grid', `${t.gridW} × ${t.gridH}`], ['track width', t.trackWidth],
      ['seg length', t.segLen], ['start', `${t.startGX},${t.startGY} dir ${t.startDir}`], ['tokens', t.tokens.length]]);
  } else if(cart.mapGenerator === 2){
    const c = cart.cave;
    html += table([['field','value'], ['grid', `${c.gridW} × ${c.gridH}`], ['fill prob', c.fillProb],
      ['iterations', c.iterations], ['wall threshold', c.wallThreshold], ['gold count', c.goldCount]]);
  } else if(cart.mapGenerator === 3){
    const p = cart.platform;
    html += table([['field','value'], ['grid height', p.gridH], ['start/min/max groundY', `${p.startGroundY} / ${p.minGroundY} / ${p.maxGroundY}`],
      ['tokens', p.tokens.length]]);
  }
  html += '<div class="inspect-section-title">Rendered map</div><div class="cfg-scroll"><div id="mapSlot"></div></div>';
  setTimeout(() => {
    const slot = document.getElementById('mapSlot');
    if(!slot) return;
    const mc = inspectWorld.mapCanvas;
    mc.style.imageRendering = 'pixelated';
    mc.style.maxWidth = 'none';
    slot.appendChild(mc);
  }, 0);
  return html;
}

function renderInspectEntities(cart){
  return table([
    ['#','renderKind','assetIndex','rotate','collisionW','collisionH','extFields'],
    ...cart.entityTypes.map((t,i) => [i, t.renderKind, t.assetIndex, t.rotateFlag, t.collisionW, t.collisionH, t.extFieldCount]),
  ]);
}

function renderInspectHooks(body, cart){
  const liveHooks = HOOK_NAMES.filter(n => cart.hooks[n] && cart.hooks[n].length > 0);
  if(!liveHooks.includes(inspectHookTab)) inspectHookTab = liveHooks[0] || HOOK_NAMES[0];
  let html = '<div class="hook-tabs">' + HOOK_NAMES.map(n => {
    const len = (cart.hooks[n]||[]).length;
    return `<button class="hook-tab${n===inspectHookTab?' active':''}${len===0?' empty':''}" data-hook="${n}">${n} (${len}B)</button>`;
  }).join('') + '</div>';
  const bc = cart.hooks[inspectHookTab] || new Uint8Array(0);
  if(bc.length === 0){
    html += '<p class="inspect-empty">(empty hook)</p>';
  } else {
    html += '<div class="inspect-section-title">Disassembly</div>';
    html += `<pre class="disasm">${esc(formatDisassembly(bc))}</pre>`;
    html += '<div class="inspect-section-title">Control-flow graph</div>';
    html += `<div class="cfg-scroll">${renderCFGSvg(bc)}</div>`;
  }
  body.innerHTML = html;
  body.querySelectorAll('.hook-tab').forEach(btn => btn.addEventListener('click', () => {
    inspectHookTab = btn.dataset.hook;
    renderInspectHooks(body, cart);
  }));
}

// Logic tab: header/camera/input overview, map, entity types, hooks — in
// sequence, everything that's cart *behavior* rather than raw assets.
// Hooks gets its own sub-slot (not body.innerHTML directly) because its
// own hook-tab clicks re-render just that slot, same as before this tab
// merge — clicking "on_tick" shouldn't also redraw Overview/Map above it.
function renderInspectLogic(body, cart){
  let html = renderInspectOverview(cart);
  html += '<div class="inspect-section-title">Map</div>';
  html += renderInspectMap(cart);
  html += '<div class="inspect-section-title">Entities</div>';
  html += renderInspectEntities(cart);
  html += '<div class="inspect-section-title">Hooks</div><div id="hooksSlot"></div>';
  body.innerHTML = html;
  renderInspectHooks(document.getElementById('hooksSlot'), cart);
}

function renderInspectBody(){
  const body = document.getElementById('inspectBody');
  const {cart} = inspectCartInfo;
  if(inspectTab === 'Assets') renderInspectAssets(body, cart);
  else if(inspectTab === 'Logic') renderInspectLogic(body, cart);
  else if(inspectTab === 'Source') renderInspectSourceTab(body);
}

function sizeClassLabel(charLen){
  // DESIGN.md §2's three fragment-length classes — micro/standard/full.
  if(charLen <= 280) return 'micro (≤280 chars)';
  if(charLen <= 1000) return 'standard (≤~1000 chars)';
  if(charLen <= 2000) return 'full (≤~2000 chars)';
  return 'over "full" (~2000-char ceiling)';
}

// Compile status block — the top of the Source tab. Lives in its own
// function (returning html, not touching the DOM) so it can be
// re-rendered into #compileStatusSlot alone on every recompile, without
// touching the textarea below it (see renderCompileStatusSlot).
function compileStatusHtml(){
  if(!compileState){
    return '<div class="inspect-section-title">Compile status</div><p class="inspect-empty">Compiling…</p>';
  }
  if(!compileState.ok){
    return `
      <div class="inspect-section-title">Compile status</div>
      <p class="compile-error">${esc(compileState.message)}</p>
    `;
  }
  const {bytes, fragment} = compileState;
  const {payload} = decodeCartUrl(fragment);
  return `
    <div class="inspect-section-title">Compile status</div>
    ${table([
      ['field','value'],
      ['raw size', bytes.length + ' bytes'],
      ['fragment', fragment.length + ' chars (' + (payload.startsWith('z.') ? 'compressed' : 'uncompressed') + ')'],
      ['size class', sizeClassLabel(fragment.length)],
    ])}
    <div class="debug-actions">
      <button type="button" id="playCompiledBtn" class="playbtn">&#9654; Play this version</button>
    </div>
    <div class="inspect-section-title">Fragment</div>
    <code class="fragment-code">${esc(fragment)}</code>
  `;
}
// Only fires while the Source tab is actually the one rendered (the
// #compileStatusSlot it targets only exists then) — compileSourceText()
// also runs right after a decode, before any tab has necessarily been
// rendered as Source, and that's fine: the status is recomputed fresh
// the next time a real tab click lands on Source (see renderInspectBody).
function renderCompileStatusSlot(){
  const slot = document.getElementById('compileStatusSlot');
  if(!slot) return;
  slot.innerHTML = compileStatusHtml();
  const playBtn = document.getElementById('playCompiledBtn');
  if(playBtn) playBtn.addEventListener('click', () => { location.hash = compileState.fragment; });
}

function renderInspectSourceTab(body){
  body.innerHTML = `
    <div id="compileStatusSlot"></div>
    <div class="inspect-section-title">Source</div>
    <p class="inspect-help">Plain JS object — header fields as values, plus <code>name</code>/
    <code>author</code> (unencoded text in the URL fragment itself — see
    <a href="AUTHORING.md">AUTHORING.md</a> — never part of the binary cart), each hook as an
    array of assembly-source lines. Recompiles automatically as you edit; status above updates live.</p>
    <textarea id="debugSourceInput" class="debug-textarea" spellcheck="false"
      autocapitalize="off" autocomplete="off">${esc(sourceText)}</textarea>
  `;
  renderCompileStatusSlot();
  const ta = document.getElementById('debugSourceInput');
  ta.addEventListener('input', () => {
    sourceText = ta.value;
    clearTimeout(sourceDebounceTimer);
    sourceDebounceTimer = setTimeout(compileSourceText, 400);
  });
}

// Parses the Source tab's text, compiles it (kernel.js's
// compileCartSource — assembles every hook, encodeCart, round-trips
// through decodeCart, encodes the fragment including any name/author),
// and on success rebuilds inspectWorld/inspectCartInfo from the *edited*
// cart so Assets/Logic reflect it live — this view always shows what
// Source currently says, never a stale snapshot from whenever Debug was
// first opened. On failure, Assets/Logic keep showing the last known-good
// cart; only the Source tab's status block reflects the broken edit.
async function compileSourceText(){
  let parsed;
  try{
    parsed = new Function('"use strict"; return (\n' + sourceText + '\n);')();
  } catch(err){
    compileState = {ok: false, message: 'Source is not valid JS: ' + err.message};
    renderInspectTabs();
    renderCompileStatusSlot();
    return;
  }
  try{
    const {cart, bytes, fragment, name, author} = await compileCartSource(parsed);
    compileState = {ok: true, bytes, fragment};
    if(inspectWorld) disposeGLTextures(inspectWorld);
    try{
      inspectWorld = new World(cart);
      inspectCartInfo = {cart, payload: fragment, byteLen: bytes.length, charLen: fragment.length, name, author};
      updateTitle();
    } catch(err){
      // Rare — compileCartSource already round-trips through decodeCart
      // — but if the World itself still can't be built, say so and keep
      // the previous good inspectWorld/cart rather than tearing the
      // view down out from under whichever tab is currently showing.
      compileState = {ok: false, message: 'Compiled, but the map/entity data could not be built: ' + err.message};
    }
  } catch(err){
    compileState = {ok: false, message: err.message};
  }
  // Tab strip (for the Source tab's ✓/✕ status) plus just the compile
  // status slot — never Assets/Logic, and never the textarea itself,
  // while the user's still typing, or every keystroke would blow away
  // textarea focus/cursor/selection by re-rendering it out from under
  // itself.
  renderInspectTabs();
  renderCompileStatusSlot();
}

// Standalone entry point for "+ New Cart" (main.js) — compiles a small
// known-good starter cart and opens it in Debug landed on the Source
// tab, the same as pasting/decoding any other fragment (round-tripped
// through encode→decode too, consistent with every other path into this
// view — no separate "nothing decoded yet" state to maintain).
const STARTER_TEMPLATE = {
  formatVersion: 2, cartType: 63, paletteMode: 0, paletteParams: [0,0,0,0,0,0,0,0],
  rngSeed: 1, modeFlags: 0, screenW: 160, screenH: 160,
  backdropFillIndex: 8, backdropGroundHeight: 0, backdropGroundIndex: 0,
  inputActiveButtons: 0, inputTouchTemplate: 0, inputButtonLabels: {},
  hudSpec: [
    {kind:0, sourceKind:0, srcA:1, srcB:0, delta:0, suffixConstIdx:255, clamp:0, label:'Frames'},
  ],
  constants: [160, 160],
  constNames: {SCREEN_W:0, SCREEN_H:1},
  globalNames: {g_ball:0, g_frames:1},
  entityTypes: [
    {renderKind:0, assetIndex:0, rotateFlag:0, collisionW:8, collisionH:8, extFieldCount:0},
  ],
  sprites: [
    {kind:1, w:8, h:8, shapes:[{type:SHAPE_ELLIPSE, cx:4, cy:4, rx:3, ry:3, color:2}]},
  ],
  tiles: [],
  mapGenerator: 0,
  hooks: {
    on_init: ['SPAWN 0','STOREG g_ball','PUSHI 1','STOREE g_ball 2','PUSHI 1','STOREE g_ball 3','HALT'],
    on_frame: ['LOADG g_frames','PUSHI 1','ADD','STOREG g_frames','HALT'],
    on_tick: [
      'LOAD_SELF 0','LOAD_SELF 2','ADD','PUSHC SCREEN_W','MOD','STORE_SELF 0',
      'LOAD_SELF 1','LOAD_SELF 3','ADD','PUSHC SCREEN_H','MOD','STORE_SELF 1','HALT',
    ],
  },
};
async function startNewCart(){
  // Every step here can throw (compileCartSource, startInspect — both
  // async) — wrapped as one block, not left to whatever caller happens
  // to invoke this, because a rejected promise nobody awaits or
  // .catch()es is a silent no-op from the user's side: exactly what made
  // this worth fixing (see startInspect's own comment on the same
  // failure class).
  try{
    const {fragment} = await compileCartSource(STARTER_TEMPLATE);
    const ok = await startInspect(fragment);
    if(ok){
      inspectTab = 'Source';
      renderInspectTabs();
      renderInspectBody();
    }
    return ok;
  } catch(err){
    console.error('startNewCart failed:', err);
    document.getElementById('inspectError').textContent = 'Could not start a new cart: ' + err.message;
    return false;
  }
}

// Counterpart to startInspect(), called by main.js when navigating away
// from the Inspector view (to the shelf or into a game) — tears down
// this module's own state without reaching into runtime.js's or vice
// versa (see runtime.js's stopGame()/showMenu() split for the same idea
// on the player side).
function closeInspector(){
  if(inspectWorld){ disposeGLTextures(inspectWorld); inspectWorld = null; inspectCartInfo = null; }
  sourceText = ''; compileState = null;
  clearTimeout(sourceDebounceTimer);
  document.getElementById('inspectWrap').classList.remove('active');
}
function getInspectWorld(){ return inspectWorld; }
function getInspectCartInfo(){ return inspectCartInfo; }
function getCompileState(){ return compileState; }

export {
  startInspect, startNewCart, closeInspector, extractPayloadFromInput,
  getInspectWorld, getInspectCartInfo, getCompileState,
};
