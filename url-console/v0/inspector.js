/* ============================================================
   The Urlcade — Debug view (Cart Inspector + self-serve compiler)

   A second top-level view (alongside the shelf/player) that decodes any
   Urlcade cart — the one currently playing (via the game view's "Debug"
   button), a pasted link, or a fresh "+ New Cart" — into three tabs:

   - Assets: palette, sprites, tiles — everything that's just pixels.
   - Logic: header/camera/input overview, map, entity types, and every
     hook's bytecode decompiled to a labeled listing and a flowchart.
   - Source: the cart as an editable plain-JS-object literal (hooks as
     assembly-source line arrays, plus name/author — see
     spec/skill/references/cart-object.md).
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
  BUTTON_BITS,
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
// sourceText holds header fields only (name/author + everything but
// hooks) — hooks live in hookTexts, one join('\n')'d string per hook
// name, edited in the Logic tab so the opcode palette always knows
// exactly which hook + line it's inserting into, instead of having to
// locate a hook's array inside one big free-form JS-literal blob.
let sourceText = '', hookTexts = {}, compileState = null, sourceDebounceTimer = null;
// The last header object that successfully parsed as JS (new Function
// didn't throw), independent of whether compileCartSource then failed —
// this is what the opcode palette's global/constant pickers read names
// from (lastParsedHeader.globalNames/constNames), so a picker can show
// real names even while a hook elsewhere is mid-edit and not compiling.
let lastParsedHeader = null;
// Last known caret position inside #hookSourceInput — stashed on every
// input/click/keyup/select because a palette button click steals focus
// away from the textarea first, and some browsers clear selection state
// on blur, so insertion can't rely on live ta.selectionStart at click time.
let lastHookCursorPos = 0;

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

// Header-fields-only view of a decoded cart — everything compileCartSource
// needs except hooks (those live in hookTexts, built by hooksToTexts
// below, and merged back in at compile time by compileSourceText). name/
// author go in front of the binary-only cart fields, matching
// compileCartSource's own reading of them (see kernel.js) — they never
// round-trip through decodeCart, only through this object and the
// fragment's own URL envelope.
function cartToSourceObject(cart, name, author){
  const out = {name: name || '', author: author || ''};
  Object.assign(out, cart);
  delete out.hooks;
  return out;
}

// formatDisassembly()'s block-labeled output (B0:, B1:, ...) is
// deliberately assemble()-compatible (see kernel.js), so a decompiled
// hook pastes straight into compileCartSource() unmodified — that's what
// makes each hook's textarea round-trip. One join('\n')'d string per hook
// name, matching what a <textarea> holds.
function hooksToTexts(cart){
  const out = {};
  for(const hookName of HOOK_NAMES){
    const bc = cart.hooks[hookName];
    out[hookName] = (bc && bc.length) ? formatDisassembly(bc) : '';
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
  const headerObj = cartToSourceObject(cart, name, author);
  sourceText = JSON.stringify(headerObj, null, 2);
  hookTexts = hooksToTexts(cart);
  // Seeded synchronously (not left to await compileSourceText() below) so
  // the very first Logic-tab render — which happens before that await
  // resolves — always has a real header to read from, not null.
  lastParsedHeader = headerObj;
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

// Editable header/camera/input/backdrop/palette fields — everything else
// on the Logic tab (map, entities, hooks) stays read-only display, driven
// from the last *compiled* cart. These fields instead read/write
// lastParsedHeader directly (falling back to the compiled cart only
// before any edit has happened this session), the same live object the
// Source tab's textarea round-trips through — so a hand-typed edit in
// Source and a form edit here can never show conflicting values, and
// every edit here goes through the exact same debounced recompile path.
//
// entityTypes/sprites/tiles, mapGenerator's config block, and hudSpec
// stay out of scope here — dedicated editors for those are later phases.
// formatVersion and mapGenerator stay read-only display: the kernel only
// ever decodes formatVersion 3, and switching mapGenerator needs a whole
// new valid config sub-block generated, which is that future editor's
// job, not a plain scalar edit.

function setHeaderPath(path, value){
  let node = lastParsedHeader;
  for(let i=0;i<path.length-1;i++) node = node[path[i]];
  node[path[path.length-1]] = value;
}
// Reserializes the whole header back into sourceText (a full wholesale
// re-render, not a targeted text patch — this component owns the entire
// object already, and it's the exact same serialization startInspect
// itself does on every decode) and reuses the Source textarea's own
// debounce/recompile timer. Silently drops any hand-typed comments or
// unusual formatting the Source textarea had — same "sourceText is
// always machine round-tripped" tradeoff the opcode palette already
// makes for hook text; the Overview section says so once, inline.
function scheduleHeaderRecompile(){
  sourceText = JSON.stringify(lastParsedHeader, null, 2);
  const ta = document.getElementById('debugSourceInput');
  if(ta) ta.value = sourceText;
  clearTimeout(sourceDebounceTimer);
  sourceDebounceTimer = setTimeout(compileSourceText, 400);
}
// Covers every plain number/checkbox/select field: reads the control's
// current value, writes it to lastParsedHeader at `path` (an array, e.g.
// ['camera','followGlobal']), runs an optional onAfter (a sibling binary
// readout, etc.), then schedules the recompile.
function bindHeaderField(el, path, {parse = (v => +v), onAfter} = {}){
  el.addEventListener('input', () => {
    const raw = el.type === 'checkbox' ? el.checked : el.value;
    setHeaderPath(path, parse(raw));
    if(onAfter) onAfter();
    scheduleHeaderRecompile();
  });
}
// inputActiveButtons/inputButtonLabels don't fit bindHeaderField's shape:
// toggling a bit needs to OR/AND it into the bitmask *and* show/hide a
// sibling label <input> *and* delete the label key on uncheck (encodeCart
// only ever writes labels for currently-active bits — leaving a stale
// object key would resurface old text if the box is re-checked later).
function wireButtonCheckbox(checkboxEl, bit){
  checkboxEl.addEventListener('change', () => {
    const h = lastParsedHeader;
    h.inputActiveButtons = checkboxEl.checked ? (h.inputActiveButtons | bit) : (h.inputActiveButtons & ~bit);
    const labelRow = document.getElementById('buttonLabelRow'+bit);
    if(checkboxEl.checked){
      if(labelRow) labelRow.style.display = '';
      if(!(bit in h.inputButtonLabels)) h.inputButtonLabels[bit] = '';
    } else {
      if(labelRow) labelRow.style.display = 'none';
      delete h.inputButtonLabels[bit];
    }
    scheduleHeaderRecompile();
  });
}

// A picker variant of renderPaletteStrip (~line 236) — clickable swatches
// with a selected-index highlight, for fields that are literally a
// palette index (backdropFillIndex/backdropGroundIndex) rather than a
// number an author would rather type.
function renderIndexPicker(colors, selectedIndex, fieldName){
  return '<div class="pal-strip" style="grid-template-columns:repeat(' + colors.length + ',40px)">' + colors.map((c,i) => `
    <div class="pal-swatch pickable${i===selectedIndex?' selected':''}" style="background:${c}"
      title="${i}: ${esc(c)}" data-index="${i}" data-field="${fieldName}" tabindex="0" role="button"><span>${i}</span></div>
  `).join('') + '</div>';
}
function wireIndexPickerSlot(slotId){
  const slot = document.getElementById(slotId);
  if(!slot) return;
  slot.querySelectorAll('.pal-swatch.pickable').forEach(sw => sw.addEventListener('click', () => {
    lastParsedHeader[sw.dataset.field] = +sw.dataset.index;
    refreshBackdropPickers();
    scheduleHeaderRecompile();
  }));
}
function refreshBackdropPickers(){
  const pal = generatePalette(lastParsedHeader);
  const fillSlot = document.getElementById('backdropFillPickerSlot');
  const groundSlot = document.getElementById('backdropGroundPickerSlot');
  if(fillSlot) fillSlot.innerHTML = renderIndexPicker(pal, lastParsedHeader.backdropFillIndex, 'backdropFillIndex');
  if(groundSlot) groundSlot.innerHTML = renderIndexPicker(pal, lastParsedHeader.backdropGroundIndex, 'backdropGroundIndex');
  wireIndexPickerSlot('backdropFillPickerSlot');
  wireIndexPickerSlot('backdropGroundPickerSlot');
}

// paletteParams[1] is a real byte slot (the array must stay 8 long) but
// generatePalette() never reads it — see cart-object.md's Palette
// section — so its slider is disabled and labeled, not just silently
// inert (an author would otherwise spend time tuning a control that
// visibly does nothing and file it as a bug).
const PALETTE_SLIDER_LABELS = ['Base hue','(unused — reserved)','Sat min','Sat max','Light min','Light max','Entity A hue hint','Entity B hue hint'];
function renderPaletteEditorSlot(){
  const slot = document.getElementById('paletteEditorSlot');
  if(!slot) return;
  const h = lastParsedHeader;
  const pal = generatePalette(h);
  slot.innerHTML = `
    <div class="inspect-section-title">Palette</div>
    <div class="pal-slider-rows">${h.paletteParams.map((v,i) => `
      <div class="pal-slider-row${i===1?' pal-slider-unused':''}">
        <label for="palSlider${i}">${esc(PALETTE_SLIDER_LABELS[i])}</label>
        <input type="range" id="palSlider${i}" min="0" max="255" value="${v}" data-pp-index="${i}"${i===1?' disabled':''}>
        <span class="pal-slider-readout" id="palReadout${i}">${v}</span>
      </div>
    `).join('')}</div>
    <div id="paletteLivePreviewSlot">${renderPaletteStrip(pal, 0)}</div>
    <div class="inspect-section-title">Backdrop</div>
    <p class="inspect-help">Only used when map generator is 0 — a generated map draws instead and these are ignored.</p>
    <div class="header-field-row"><label>Fill color</label></div>
    <div id="backdropFillPickerSlot">${renderIndexPicker(pal, h.backdropFillIndex, 'backdropFillIndex')}</div>
    <div class="header-field-row"><label>Ground height</label>
      <input type="number" id="field-backdropGroundHeight" min="0" max="255" value="${h.backdropGroundHeight}"></div>
    <div class="header-field-row"><label>Ground color</label></div>
    <div id="backdropGroundPickerSlot">${renderIndexPicker(pal, h.backdropGroundIndex, 'backdropGroundIndex')}</div>
  `;
  slot.querySelectorAll('input[type=range][data-pp-index]').forEach(rng => rng.addEventListener('input', () => {
    const idx = +rng.dataset.ppIndex;
    lastParsedHeader.paletteParams[idx] = +rng.value;
    document.getElementById('palReadout'+idx).textContent = rng.value;
    const livePal = generatePalette(lastParsedHeader);
    document.getElementById('paletteLivePreviewSlot').innerHTML = renderPaletteStrip(livePal, 0);
    refreshBackdropPickers();
    scheduleHeaderRecompile();
  }));
  wireIndexPickerSlot('backdropFillPickerSlot');
  wireIndexPickerSlot('backdropGroundPickerSlot');
  bindHeaderField(document.getElementById('field-backdropGroundHeight'), ['backdropGroundHeight']);
}

function renderInspectOverview(cart){
  const h = lastParsedHeader || cart;
  let html = '';
  html += '<div class="inspect-section-title">Header</div>';
  html += '<p class="inspect-help">Editing these fields rewrites the Source tab\'s JSON — any comments or custom formatting there will be replaced.</p>';
  html += `<div class="header-field-row"><label>Format version</label><span>${h.formatVersion} <span class="field-hint">(fixed — only version this kernel decodes)</span></span></div>`;
  html += `<div class="header-field-row"><label>Cart type</label><input type="number" id="field-cartType" min="0" max="255" value="${h.cartType}"><span class="field-hint">advisory label only, never a runtime dispatch key</span></div>`;
  html += `<div class="header-field-row"><label>Screen</label><input type="number" id="field-screenW" min="0" max="65535" value="${h.screenW}"> × <input type="number" id="field-screenH" min="0" max="65535" value="${h.screenH}"></div>`;
  html += `<div class="header-field-row"><label>RNG seed</label><input type="number" id="field-rngSeed" min="0" max="255" value="${h.rngSeed}"></div>`;
  html += `<div class="header-field-row"><label>Mode flags</label><input type="number" id="field-modeFlags" min="0" max="255" value="${h.modeFlags}"><span class="field-hint" id="modeFlagsBinary">0b${h.modeFlags.toString(2).padStart(8,'0')}</span></div>`;
  html += `<div class="header-field-row"><label>Map generator</label><span>${h.mapGenerator} — ${MAP_GEN_NAMES[h.mapGenerator] || 'unknown'} <span class="field-hint">(read-only — switching generators needs a full config block, a future editor)</span></span></div>`;
  html += '<div id="paletteEditorSlot"></div>';

  html += '<div class="inspect-section-title">Camera</div>';
  html += `<div class="header-field-row"><label>Follow global</label><input type="number" id="field-camFollow" min="0" max="255" value="${h.camera.followGlobal}"><span class="field-hint">255 = none/static</span></div>`;
  html += `<div class="header-field-row"><label>Clamp X</label><input type="number" id="field-camClampMinX" min="0" max="65535" value="${h.camera.clampMinX}"> – <input type="number" id="field-camClampMaxX" min="0" max="65535" value="${h.camera.clampMaxX}"></div>`;
  html += `<div class="header-field-row"><label>Clamp Y</label><input type="number" id="field-camClampMinY" min="0" max="65535" value="${h.camera.clampMinY}"> – <input type="number" id="field-camClampMaxY" min="0" max="65535" value="${h.camera.clampMaxY}"></div>`;

  html += '<div class="inspect-section-title">Input</div>';
  html += '<div class="input-buttons-grid">' + BUTTON_BITS.map((bit,i) => `
    <label class="input-button-check"><input type="checkbox" id="field-btn${bit}" ${(h.inputActiveButtons & bit) ? 'checked' : ''}> ${esc(TESTBIT_NAMES[i][1])} (bit ${bit})</label>
    <div class="header-field-row" id="buttonLabelRow${bit}" style="${(h.inputActiveButtons & bit) ? '' : 'display:none'}">
      <label>Label</label><input type="text" id="field-btnLabel${bit}" value="${esc(h.inputButtonLabels[bit] || '')}">
    </div>
  `).join('') + '</div>';
  html += `<div class="header-field-row"><label>Touch template</label><select id="field-touchTemplate">${
    Object.entries(TOUCH_TEMPLATE_NAMES).map(([v,name]) => `<option value="${v}"${+v===h.inputTouchTemplate?' selected':''}>${v} — ${esc(name)}</option>`).join('')
  }</select></div>`;
  html += `<div class="header-field-row"><label>Wants pointer</label><input type="checkbox" id="field-wantsPointer" ${h.inputWantsPointer?'checked':''}></div>`;

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

function wireInspectOverview(){
  bindHeaderField(document.getElementById('field-cartType'), ['cartType']);
  bindHeaderField(document.getElementById('field-screenW'), ['screenW']);
  bindHeaderField(document.getElementById('field-screenH'), ['screenH']);
  renderPaletteEditorSlot();
  bindHeaderField(document.getElementById('field-rngSeed'), ['rngSeed']);
  bindHeaderField(document.getElementById('field-modeFlags'), ['modeFlags'], {onAfter: () => {
    document.getElementById('modeFlagsBinary').textContent = '0b' + lastParsedHeader.modeFlags.toString(2).padStart(8,'0');
  }});
  bindHeaderField(document.getElementById('field-camFollow'), ['camera','followGlobal']);
  bindHeaderField(document.getElementById('field-camClampMinX'), ['camera','clampMinX']);
  bindHeaderField(document.getElementById('field-camClampMaxX'), ['camera','clampMaxX']);
  bindHeaderField(document.getElementById('field-camClampMinY'), ['camera','clampMinY']);
  bindHeaderField(document.getElementById('field-camClampMaxY'), ['camera','clampMaxY']);
  BUTTON_BITS.forEach(bit => {
    wireButtonCheckbox(document.getElementById('field-btn'+bit), bit);
    bindHeaderField(document.getElementById('field-btnLabel'+bit), ['inputButtonLabels', bit], {parse: v => v});
  });
  bindHeaderField(document.getElementById('field-touchTemplate'), ['inputTouchTemplate']);
  bindHeaderField(document.getElementById('field-wantsPointer'), ['inputWantsPointer'], {parse: v => !!v});
}

// A dense 8-wide swatch grid, not a card list — see index.html's .pal-*
// CSS comment for why. Every cart's 16 colors split into three labeled
// groups now — terrain (0-7) and two independent entity ramps (8-11,
// 12-15) — because that three-way split is a structural guarantee of
// generatePalette() itself, not a convention some carts follow and
// others don't (DESIGN.md §43; there's no longer a curated-bank mode
// whose own index usage might disagree with the labels).
function renderPaletteStrip(colors, startIndex){
  return '<div class="pal-strip" style="grid-template-columns:repeat(' + colors.length + ',40px)">' + colors.map((c,i) => `
    <div class="pal-swatch" style="background:${c}" title="${startIndex+i}: ${esc(c)}"><span>${startIndex+i}</span></div>
  `).join('') + '</div>';
}
function renderInspectPalette(cart){
  const pal = generatePalette(cart);
  return `
    <div class="pal-group">
      <p class="pal-group-label">Terrain / backdrop (0-7)</p>
      ${renderPaletteStrip(pal.slice(0,8), 0)}
    </div>
    <div class="pal-group">
      <p class="pal-group-label">Entity A (8-11)</p>
      ${renderPaletteStrip(pal.slice(8,12), 8)}
    </div>
    <div class="pal-group">
      <p class="pal-group-label">Entity B (12-15)</p>
      ${renderPaletteStrip(pal.slice(12,16), 12)}
    </div>`;
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

/* ============================================================
   Opcode palette — a drawer of grouped buttons next to the active
   hook's textarea. Each button inserts a correctly-formed assembly
   line at the last-known caret position; some open a small inline
   picker first, built from the cart's own real data (entity sprite
   thumbnails, tile thumbnails, the fixed input-bit list, or the
   header's declared globals/constants), so you never have to guess an
   operand number.

   Grouped the same way references/opcodes.md and the learn site's VM
   section group them — same mental model, agent doc / human doc /
   editor UI all in sync.

   operandKind is a UI-only classification (which picker, if any, a
   button opens) — never hand-copied operand *counts*: those come
   straight from K.OPS so this stays correct if kernel.js's operand
   shapes ever change.
     null          — no operand (ADD, HALT, ...)
     'raw'         — operand(s) are just numbers with no cart-data
                     meaning (LOAD_SELF/STORE_SELF/LOAD_A/LOAD_B/
                     STORE_A/STORE_B prop indices, PLAYSOUND id, a bare
                     PUSHI literal) — insert with '0' placeholder(s),
                     cursor left on the first one to overtype.
     'addr'        — JMP/JZ/JNZ: a label doesn't exist yet from a
                     picker's perspective, so insert the mnemonic plus
                     a trailing space and leave the caret there for the
                     author to type a label name by hand.
     'entityType'  — SPAWN's typeId: pick from cart.entityTypes, shown
                     with each type's real sprite thumbnail.
     'testbit'     — TESTBIT's bit index: fixed 5-item left/right/up/
                     down/action list, no cart data needed.
     'tileId'      — a dedicated "PUSHI (tile id)" entry (GETTILE/
                     SETTILE/TILE_SURFACE take their tile id off the
                     *stack*, not as an embedded operand on the
                     instruction itself — see K.OPS — so the tile
                     picker attaches to the PUSHI that precedes one of
                     them instead of to those opcodes directly, keeping
                     "one button click -> one inserted line" true for
                     every button in the palette).
     'globalSlot'  — LOADG/STOREG's slot: pick from the 24 global
                     slots, named ones shown by name.
     'globalHandle'— LOADE/STOREE's first operand: same 24-slot picker
                     as globalSlot (a global slot holding an entity id,
                     rather than a plain value) — kept as a distinct
                     label since the *meaning* differs even though the
                     picker source is identical. The instruction's
                     second operand (a prop index) always defaults to
                     '0', same as a 'raw' opcode's placeholder.
     'constIdx'    — PUSHC's index: pick from the header's declared
                     constants[], named ones shown by name.
   ============================================================ */
const OPCODE_GROUPS = [
  {label: 'Stack & arithmetic', ops: [
    {mnem:'PUSHI', operandKind:'raw'},
    {mnem:'PUSHC', operandKind:'constIdx'},
    {mnem:'DUP'}, {mnem:'POP'}, {mnem:'SWAP'},
    {mnem:'ADD'}, {mnem:'SUB'}, {mnem:'MUL'}, {mnem:'DIV'}, {mnem:'MOD'}, {mnem:'NEG'},
  ]},
  {label: 'Comparison & logic', ops: [
    {mnem:'CMPEQ'}, {mnem:'CMPNE'}, {mnem:'CMPLT'}, {mnem:'CMPLE'}, {mnem:'CMPGT'}, {mnem:'CMPGE'},
    {mnem:'AND'}, {mnem:'OR'}, {mnem:'NOT'},
  ]},
  {label: 'Control flow', ops: [
    {mnem:'JMP', operandKind:'addr'}, {mnem:'JZ', operandKind:'addr'}, {mnem:'JNZ', operandKind:'addr'},
  ]},
  {label: 'Entity state', ops: [
    {mnem:'LOAD_SELF', operandKind:'raw'}, {mnem:'STORE_SELF', operandKind:'raw'},
    {mnem:'LOAD_A', operandKind:'raw'}, {mnem:'LOAD_B', operandKind:'raw'},
    {mnem:'STORE_A', operandKind:'raw'}, {mnem:'STORE_B', operandKind:'raw'},
    {mnem:'LOADE', operandKind:'globalHandle'}, {mnem:'STOREE', operandKind:'globalHandle'},
  ]},
  {label: 'Globals', ops: [
    {mnem:'LOADG', operandKind:'globalSlot'}, {mnem:'STOREG', operandKind:'globalSlot'},
  ]},
  {label: 'World queries', ops: [
    {mnem:'PUSHI', operandKind:'tileId', label:'PUSHI (tile id)'},
    {mnem:'RAND_RANGE'}, {mnem:'SIN'}, {mnem:'COS'}, {mnem:'ATAN2'}, {mnem:'DIST'},
    {mnem:'CLAMP_ABS'}, {mnem:'LERP'}, {mnem:'NORM_ANGLE'},
    {mnem:'GETTILE'}, {mnem:'TILE_SURFACE'}, {mnem:'GET_CHECKPOINT'},
  ]},
  {label: 'Entity lifecycle', ops: [
    {mnem:'SPAWN', operandKind:'entityType'}, {mnem:'KILL_SELF'}, {mnem:'MOVE_SOLID'}, {mnem:'SETTILE'},
  ]},
  {label: 'Input', ops: [
    {mnem:'TESTBIT', operandKind:'testbit'}, {mnem:'LOAD_INPUT'},
    {mnem:'LOAD_POINTER_X'}, {mnem:'LOAD_POINTER_Y'}, {mnem:'LOAD_POINTER_DOWN'},
  ]},
  {label: 'Drawing & control', ops: [
    {mnem:'DRAW_LINE'}, {mnem:'PLAYSOUND', operandKind:'raw'}, {mnem:'HALT'},
  ]},
];
const TESTBIT_NAMES = [[0,'left'],[1,'right'],[2,'up'],[3,'down'],[4,'action']];
// Which OPCODE_GROUPS.label is showing its buttons — one group's worth at
// a time behind a <select>, not all nine stacked open, since the full
// list ran to several screens' worth of vertical space for what's meant
// to be a quick "insert one line" reach, not a page of its own. Persists
// across re-renders (switching hooks, editing text) so picking a category
// once holds while you keep working in it.
let activeOpcodeGroupLabel = OPCODE_GROUPS[0].label;

function renderOpcodePalette(){
  const slot = document.getElementById('opcodePaletteSlot');
  if(!slot) return;
  const group = OPCODE_GROUPS.find(g => g.label === activeOpcodeGroupLabel) || OPCODE_GROUPS[0];
  slot.innerHTML = `
    <div class="opcode-palette">
      <select class="opcode-group-select">${OPCODE_GROUPS.map(g => `
        <option value="${esc(g.label)}"${g.label===group.label?' selected':''}>${esc(g.label)}</option>
      `).join('')}</select>
      <div class="opcode-btns">${group.ops.map(op => `
        <button type="button" class="opcode-btn" data-mnem="${op.mnem}" data-operand-kind="${op.operandKind||''}">${esc(op.label||op.mnem)}</button>
      `).join('')}</div>
    </div>
  `;
  slot.querySelector('.opcode-group-select').addEventListener('change', (e) => {
    activeOpcodeGroupLabel = e.target.value;
    const pickerSlot = document.getElementById('operandPickerSlot');
    if(pickerSlot) pickerSlot.innerHTML = '';
    renderOpcodePalette();
  });
  slot.querySelectorAll('.opcode-btn').forEach(btn => btn.addEventListener('click', () => {
    onOpcodeButtonClick(btn.dataset.mnem, btn.dataset.operandKind || null);
  }));
}

// Splits the active hook's text at the last-known caret position, snaps
// to line boundaries (a palette insert always lands on its own new line,
// never mid-line), matches the current line's leading whitespace, updates
// hookTexts + the live textarea, restores focus/caret just after the new
// line, closes any open picker, and fires the same validation pair a real
// edit would (setting .value directly doesn't dispatch an input event).
function insertOpcodeLine(mnem, operandTokens){
  const text = hookTexts[inspectHookTab] || '';
  const pos = Math.max(0, Math.min(lastHookCursorPos, text.length));
  const lineStart = text.lastIndexOf('\n', pos - 1) + 1;
  const nlAfter = text.indexOf('\n', pos);
  const lineEnd = nlAfter === -1 ? text.length : nlAfter;
  const indentMatch = text.slice(lineStart, lineEnd).match(/^[ \t]*/);
  const indent = indentMatch ? indentMatch[0] : '';
  const opText = (operandTokens && operandTokens.length) ? mnem + ' ' + operandTokens.join(' ') : mnem;
  const newLine = indent + opText;
  const before = text.slice(0, lineEnd);
  const after = text.slice(lineEnd);
  const newText = before + (before.length ? '\n' : '') + newLine + after;
  const insertedAt = before.length + (before.length ? 1 : 0);
  hookTexts[inspectHookTab] = newText;
  const ta = document.getElementById('hookSourceInput');
  const newCursorPos = insertedAt + newLine.length;
  if(ta){
    ta.value = newText;
    ta.focus();
    ta.selectionStart = ta.selectionEnd = newCursorPos;
  }
  lastHookCursorPos = newCursorPos;
  const pickerSlot = document.getElementById('operandPickerSlot');
  if(pickerSlot) pickerSlot.innerHTML = '';
  onHookTextChanged();
}

function onOpcodeButtonClick(mnem, operandKind){
  if(!operandKind){ insertOpcodeLine(mnem, []); return; }
  if(operandKind === 'addr'){ insertOpcodeLine(mnem, ['']); return; }
  if(operandKind === 'raw'){
    const count = (K.OPS[K.OPINDEX[mnem]][1] || []).length || 1;
    insertOpcodeLine(mnem, new Array(count).fill('0'));
    return;
  }
  const pickerSlot = document.getElementById('operandPickerSlot');
  if(!pickerSlot) return;
  pickerSlot.innerHTML = operandPickerHtml(operandKind);
  wireOperandPicker(pickerSlot, mnem, operandKind);
}

// Named vs. numeric-fallback row list for the global/constant pickers —
// slot/idx -> name comes only from the *header text's own* constNames/
// globalNames (lastParsedHeader), since a decoded fragment never carries
// them (not part of the binary format at all — see binary-format.md).
// Always has *something* to show either way: a named row inserts the
// name as the operand token (matching how a hand-authored cart writes
// it — assemble() resolves it via the exact same header object at
// compile time), an unnamed row inserts the bare numeric slot, which is
// always a valid operand.
function nameTableFor(kind){
  const reverse = {};
  const names = (kind === 'constIdx')
    ? ((lastParsedHeader && lastParsedHeader.constNames) || {})
    : ((lastParsedHeader && lastParsedHeader.globalNames) || {});
  for(const name in names) reverse[names[name]] = name;
  return reverse;
}

function operandPickerHtml(operandKind){
  if(operandKind === 'entityType'){
    const cart = inspectCartInfo.cart;
    if(!cart.entityTypes.length) return '<div class="operand-picker"><p class="inspect-empty">No entity types in this cart yet.</p></div>';
    return `<div class="operand-picker"><div class="operand-picker-grid">${cart.entityTypes.map((t,i) => `
      <div class="operand-picker-item" data-value="${i}" tabindex="0"><canvas id="opPickEntity${i}" width="${1}" height="${1}"></canvas><div>#${i}</div></div>
    `).join('')}</div></div>`;
  }
  if(operandKind === 'tileId'){
    const cart = inspectCartInfo.cart;
    if(!cart.tiles.length) return '<div class="operand-picker"><p class="inspect-empty">No tiles in this cart yet.</p></div>';
    return `<div class="operand-picker"><div class="operand-picker-grid">${cart.tiles.map((t,i) => `
      <div class="operand-picker-item" data-value="${i}" tabindex="0"><canvas id="opPickTile${i}" width="${1}" height="${1}"></canvas><div>tile ${i}</div></div>
    `).join('')}</div></div>`;
  }
  if(operandKind === 'testbit'){
    return `<div class="operand-picker"><div class="operand-picker-list">${TESTBIT_NAMES.map(([bit,name]) => `
      <button type="button" class="operand-picker-row" data-value="${bit}">${bit} — ${esc(name)}</button>
    `).join('')}</div></div>`;
  }
  if(operandKind === 'globalSlot' || operandKind === 'globalHandle'){
    const names = nameTableFor('globalSlot');
    const rows = [];
    for(let slot = 0; slot < 24; slot++){
      const name = names[slot];
      rows.push(`<button type="button" class="operand-picker-row" data-value="${name || slot}">${
        name ? `<span class="op-slot-name">${esc(name)}</span> (slot ${slot})` : `slot ${slot} <span class="op-slot-unnamed">(unnamed)</span>`
      }</button>`);
    }
    return `<div class="operand-picker"><div class="operand-picker-list">${rows.join('')}</div></div>`;
  }
  if(operandKind === 'constIdx'){
    const names = nameTableFor('constIdx');
    const count = (lastParsedHeader && Array.isArray(lastParsedHeader.constants)) ? lastParsedHeader.constants.length : inspectCartInfo.cart.constants.length;
    if(!count) return '<div class="operand-picker"><p class="inspect-empty">No constants declared in the Source tab yet.</p></div>';
    const rows = [];
    for(let idx = 0; idx < count; idx++){
      const name = names[idx];
      const value = (lastParsedHeader && Array.isArray(lastParsedHeader.constants)) ? lastParsedHeader.constants[idx] : inspectCartInfo.cart.constants[idx];
      rows.push(`<button type="button" class="operand-picker-row" data-value="${name || idx}">${
        name ? `<span class="op-slot-name">${esc(name)}</span> (idx ${idx}, ${value})` : `idx ${idx} <span class="op-slot-unnamed">(unnamed)</span>, ${value}`
      }</button>`);
    }
    return `<div class="operand-picker"><div class="operand-picker-list">${rows.join('')}</div></div>`;
  }
  return '';
}

function wireOperandPicker(pickerSlot, mnem, operandKind){
  if(operandKind === 'entityType'){
    const cart = inspectCartInfo.cart;
    cart.entityTypes.forEach((t,i) => {
      const src = inspectWorld.spriteCanvases[t.assetIndex];
      const c = document.getElementById('opPickEntity'+i);
      if(!c || !src) return;
      c.width = src.width; c.height = src.height;
      c.getContext('2d').drawImage(src, 0, 0);
    });
    pickerSlot.querySelectorAll('.operand-picker-item').forEach(el => el.addEventListener('click', () => {
      insertOpcodeLine(mnem, [el.dataset.value]);
    }));
    return;
  }
  if(operandKind === 'tileId'){
    const cart = inspectCartInfo.cart;
    cart.tiles.forEach((t,i) => {
      const src = inspectWorld.tileCanvases[i];
      const c = document.getElementById('opPickTile'+i);
      if(!c || !src) return;
      c.width = src.width; c.height = src.height;
      c.getContext('2d').drawImage(src, 0, 0);
    });
    pickerSlot.querySelectorAll('.operand-picker-item').forEach(el => el.addEventListener('click', () => {
      insertOpcodeLine(mnem, [el.dataset.value]);
    }));
    return;
  }
  // testbit / globalSlot / globalHandle / constIdx all render as
  // .operand-picker-row buttons carrying the operand token directly.
  pickerSlot.querySelectorAll('.operand-picker-row').forEach(el => el.addEventListener('click', () => {
    const operands = (operandKind === 'globalHandle') ? [el.dataset.value, '0'] : [el.dataset.value];
    insertOpcodeLine(mnem, operands);
  }));
}

// Validates only the active hook's own text against kernel.js's real
// assembler — cheap (a linear scan of one hook's already-short line list),
// so it runs synchronously on every keystroke, unlike the debounced full
// recompile below it which encodes/compresses the whole fragment. Reports
// only this hook's own verdict — never anything about the header text or
// any other hook — so it never contradicts or duplicates the Source tab's
// own ✓/✕ badge, which stays the one place "does the whole cart compile"
// is answered.
function validateActiveHook(){
  const slot = document.getElementById('hookErrorSlot');
  if(!slot) return;
  const sym = {
    constants: (lastParsedHeader && lastParsedHeader.constNames) || {},
    globals: (lastParsedHeader && lastParsedHeader.globalNames) || {},
  };
  try{
    K.assemble((hookTexts[inspectHookTab] || '').split('\n'), sym);
    slot.innerHTML = '';
  } catch(err){
    slot.innerHTML = `<p class="compile-error">${esc(err.message)}</p>`;
  }
}

// Fires on every edit to the active hook's textarea (typed or inserted via
// the opcode palette): the fast, un-debounced per-hook check above, plus
// the same debounced full-cart recompile the header textarea already
// triggers on its own input — both read/write disjoint state and DOM, so
// they can't race each other.
function onHookTextChanged(){
  validateActiveHook();
  clearTimeout(sourceDebounceTimer);
  sourceDebounceTimer = setTimeout(compileSourceText, 400);
}

function renderInspectHooks(body, cart){
  const liveHooks = HOOK_NAMES.filter(n => (hookTexts[n] || '').trim().length > 0);
  if(!liveHooks.includes(inspectHookTab)) inspectHookTab = liveHooks[0] || HOOK_NAMES[0];
  let html = '<div class="hook-tabs">' + HOOK_NAMES.map(n => {
    const bcLen = (cart.hooks[n]||[]).length;
    const hasText = (hookTexts[n] || '').trim().length > 0;
    return `<button class="hook-tab${n===inspectHookTab?' active':''}${hasText?'':' empty'}" data-hook="${n}">${n} (${bcLen}B)</button>`;
  }).join('') + '</div>';
  html += '<div class="inspect-section-title">Insert opcode</div>';
  html += '<div id="opcodePaletteSlot"></div>';
  html += '<div id="operandPickerSlot"></div>';
  html += '<div class="inspect-section-title">Bytecode source</div>';
  html += `<textarea id="hookSourceInput" class="debug-textarea hook-textarea" spellcheck="false"
    autocapitalize="off" autocomplete="off">${esc(hookTexts[inspectHookTab] || '')}</textarea>`;
  html += '<div id="hookErrorSlot"></div>';
  const bc = cart.hooks[inspectHookTab] || new Uint8Array(0);
  html += '<div class="inspect-section-title">Control-flow graph</div>';
  html += bc.length === 0
    ? '<p class="inspect-empty">(nothing compiled for this hook yet)</p>'
    : `<div class="cfg-scroll">${renderCFGSvg(bc)}</div>`;
  body.innerHTML = html;
  body.querySelectorAll('.hook-tab').forEach(btn => btn.addEventListener('click', () => {
    inspectHookTab = btn.dataset.hook;
    renderInspectHooks(body, cart);
  }));
  renderOpcodePalette();
  const ta = document.getElementById('hookSourceInput');
  const trackCursor = () => { lastHookCursorPos = ta.selectionStart; };
  trackCursor();
  ta.addEventListener('input', () => {
    hookTexts[inspectHookTab] = ta.value;
    trackCursor();
    onHookTextChanged();
  });
  ['click','keyup','select'].forEach(evt => ta.addEventListener(evt, trackCursor));
  validateActiveHook();
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
  wireInspectOverview();
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
    <a href="spec/skill/references/binary-format.md">binary-format.md</a> — never part of the binary cart).
    Hooks are edited on the Logic tab, next to an opcode palette. Recompiles automatically as you edit; status above updates live.</p>
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
  // Header text parsed cleanly — stash it for the opcode palette's
  // global/constant pickers to read names from, regardless of whether
  // compileCartSource below succeeds (a hook can be broken while the
  // header's own constNames/globalNames are still perfectly good).
  lastParsedHeader = parsed;
  // Merge the per-hook textareas (edited in the Logic tab) back into the
  // header object right before compiling — this is the one place the
  // split-apart header/hooks representation gets put back together.
  parsed.hooks = {};
  for(const hookName of HOOK_NAMES) parsed.hooks[hookName] = (hookTexts[hookName] || '').split('\n');
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
  formatVersion: 3, cartType: 63,
  // A modest terrain hue plus generatePalette()'s own guaranteed-vivid
  // entity floors (DESIGN.md §41/§43) is enough to make a first cart
  // look intentional without the author having to think about palettes
  // at all yet — see the Palette section of
  // spec/skill/references/cart-object.md.
  paletteParams: [200, 0, 15, 40, 15, 60, 128, 128],
  rngSeed: 1, modeFlags: 0, screenW: 160, screenH: 160,
  backdropFillIndex: 0, backdropGroundHeight: 0, backdropGroundIndex: 0,
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
    {kind:1, w:8, h:8, shapes:[{type:SHAPE_ELLIPSE, cx:4, cy:4, rx:3, ry:3, color:9}]},
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
  sourceText = ''; hookTexts = {}; lastParsedHeader = null; compileState = null;
  clearTimeout(sourceDebounceTimer);
  document.getElementById('inspectWrap').classList.remove('active');
}
function getInspectWorld(){ return inspectWorld; }
function getInspectCartInfo(){ return inspectCartInfo; }
function getCompileState(){ return compileState; }
// Test-introspection only (see test/smoke.js) — the opcode palette
// writes hookTexts directly rather than always going through a DOM
// input event, so tests need a way to read it back without scraping
// the textarea by hand.
function getHookTexts(){ return hookTexts; }

export {
  startInspect, startNewCart, closeInspector, extractPayloadFromInput,
  getInspectWorld, getInspectCartInfo, getCompileState, getHookTexts,
};
