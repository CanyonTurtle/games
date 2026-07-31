/* ============================================================
   The Urlcade — Cart Inspector UI

   A third top-level view (alongside the shelf and the player) that
   decodes any pasted Urlcade link/fragment and tabs between its
   palette/sprites/tiles/map/entities/hooks — including a disassembly
   listing and control-flow-graph flowchart for each lifecycle hook.
   Works on any cart, not just this repo's five example ones.

   Split out on its own from the former urlcade.html monolith. Reuses
   kernel.js's disassembler/CFG extractor (window.UrlcadeKernel — a
   classic <script> global, not an import; see runtime.js's header for
   why) and runtime.js's World class (to reuse its buildBitmap/mapCanvas
   output instead of a second copy of that rendering logic).
   ============================================================ */
"use strict";
const K = window.UrlcadeKernel;
const {
  formatDisassembly, renderCFGSvg,
  generatePalette, SHAPE_ELLIPSE, HOOK_NAMES, decodeCart, decodePayloadToBytes,
} = K;
import { World, disposeGLTextures } from './runtime.js';

/* ============================================================
   11b. Inspector UI — a third top-level view (alongside the shelf and
   the player) that tabs between a decoded cart's sprites/tiles/palette/
   map/entities/hooks. Works on any cart URL, not just the four on the
   shelf: it re-decodes and rebuilds a real (never-stepped) World purely
   to reuse its existing buildBitmap/mapCanvas output instead of
   duplicating that rendering logic a second time for the inspector.
   ============================================================ */
const INSPECT_TABS = ['Overview','Palette','Sprites','Tiles','Map','Entities','Hooks'];
const MAP_GEN_NAMES = {0:'none', 1:'track (turtle-grammar)', 2:'cave (cellular automata)', 3:'platform (heightmap turtle-grammar)'};
const TOUCH_TEMPLATE_NAMES = {0:'none', 1:'single button', 2:'steer + action', 3:'d-pad + action', 4:'d-pad only'};
let inspectWorld = null, inspectCartInfo = null, inspectTab = 'Overview', inspectHookTab = 'on_init';

// Accepts a full pasted URL, a bare fragment, or a raw payload string —
// takes whatever comes after the last '#' if there is one, else the
// whole trimmed string.
function extractPayloadFromInput(raw){
  let s = raw.trim();
  const hashIdx = s.lastIndexOf('#');
  if(hashIdx >= 0) s = s.slice(hashIdx+1);
  if(s.startsWith('inspect:')) s = s.slice('inspect:'.length);
  return s;
}

async function startInspect(payload){
  let cart, bytes;
  try{
    bytes = await decodePayloadToBytes(payload);
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
  inspectCartInfo = {cart, payload, byteLen: bytes.length, charLen: payload.length};
  inspectTab = 'Overview';
  const liveHooks = HOOK_NAMES.filter(n => cart.hooks[n] && cart.hooks[n].length > 0);
  inspectHookTab = liveHooks[0] || HOOK_NAMES[0];
  document.getElementById('menu').classList.remove('active');
  document.getElementById('gameWrap').classList.remove('active');
  const iw = document.getElementById('inspectWrap');
  iw.classList.remove('active'); void iw.offsetWidth; iw.classList.add('active');
  document.getElementById('inspectTitle').textContent =
    `cart_type ${cart.cartType} · ${bytes.length}B raw / ${payload.length} chars`;
  renderInspectTabs();
  renderInspectBody();
  return true;
}

function renderInspectTabs(){
  const wrap = document.getElementById('inspectTabs');
  wrap.innerHTML = INSPECT_TABS.map(t =>
    `<button class="inspect-tab${t===inspectTab?' active':''}" data-tab="${t}">${t}</button>`).join('');
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

function renderInspectPalette(cart){
  const pal = generatePalette(cart);
  return '<div class="inspect-grid">' + pal.map((c,i) => `
    <div class="inspect-tile">
      <div style="aspect-ratio:1;border-radius:3px;border:1px solid var(--rule);background:${c}"></div>
      <p>${i}<br>${esc(c)}</p>
    </div>`).join('') + '</div>';
}

function renderInspectSprites(body, cart){
  let html = '<div class="inspect-grid" id="spriteGrid"></div>';
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
  body.innerHTML = html;
  cart.sprites.forEach((s,i) => {
    const slot = document.getElementById('spriteSlot'+i);
    const c = inspectWorld.spriteCanvases[i];
    c.style.width = '100%'; c.style.imageRendering = 'pixelated';
    c.style.border = '1px solid var(--rule)'; c.style.background = 'var(--bg-card)';
    slot.appendChild(c);
  });
}

function renderInspectTiles(body, cart){
  let html = '<div class="inspect-grid" id="tileGrid"></div>';
  body.innerHTML = html;
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

function renderInspectBody(){
  const body = document.getElementById('inspectBody');
  const {cart} = inspectCartInfo;
  if(inspectTab === 'Overview') body.innerHTML = renderInspectOverview(cart);
  else if(inspectTab === 'Palette') body.innerHTML = renderInspectPalette(cart);
  else if(inspectTab === 'Sprites') renderInspectSprites(body, cart);
  else if(inspectTab === 'Tiles') renderInspectTiles(body, cart);
  else if(inspectTab === 'Map') body.innerHTML = renderInspectMap(cart);
  else if(inspectTab === 'Entities') body.innerHTML = renderInspectEntities(cart);
  else if(inspectTab === 'Hooks') renderInspectHooks(body, cart);
}


// Counterpart to startInspect(), called by main.js when navigating away
// from the Inspector view (to the shelf or into a game) — tears down
// this module's own state without reaching into runtime.js's or vice
// versa (see runtime.js's stopGame()/showMenu() split for the same idea
// on the player side).
function closeInspector(){
  if(inspectWorld){ disposeGLTextures(inspectWorld); inspectWorld = null; inspectCartInfo = null; }
  document.getElementById('inspectWrap').classList.remove('active');
}
function getInspectWorld(){ return inspectWorld; }
function getInspectCartInfo(){ return inspectCartInfo; }

export {
  startInspect, closeInspector, extractPayloadFromInput,
  getInspectWorld, getInspectCartInfo,
};
