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
  generatePalette, SHAPE_ELLIPSE, SHAPE_RECT, HOOK_NAMES, decodeCart, decodePayloadToBytes,
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
// Sprite shape editor state — which shape (by index into that sprite's
// shapes[] array) is currently selected, keyed by sprite index. Purely
// ephemeral UI state, deliberately not part of lastParsedHeader (it's
// not cart data). {spriteIndex: shapeIndex | undefined}.
let selectedShapeIndex = {};
// In-progress drag state for the sprite editor's canvas — {spriteIndex,
// mode:'move'|'resize', shapeIndex, corner (resize only), startPointer,
// startBox} or null when nothing is being dragged.
let spriteDragState = null;
// Internal canvas buffer = sprite.w/h * this — CSS width:100%;height:auto
// does the actual on-screen magnification (same pattern as every other
// canvas in this view), this just keeps overlay lines/handles crisp.
const SPRITE_EDITOR_ZOOM = 8;
// Tile pixel editor state — the palette index a paint stroke currently
// writes, keyed by tile index. {tileIndex: colorIndex}.
let selectedTileColor = {};
// In-progress paint-drag for the tile editor's canvas — {tileIndex,
// lastX, lastY} (last-painted pixel, so a slow drag doesn't re-write the
// same pixel every pointermove) or null when nothing is being dragged.
let tileDragState = null;

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
  // Fires on every compileState change (decode, compile success/failure)
  // and every tab switch, same as the tab strip above — the one place
  // that needs to know "is the live-edited fragment currently playable."
  const tryBtn = document.getElementById('inspectTryBtn');
  if(tryBtn) tryBtn.disabled = !(compileState && compileState.ok);
}

function esc(s){ return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;'); }
// Wrapped in a scroll container, not left to whatever width its own
// content wants — a wide table (many columns, or long cell text) forced
// the whole Debug view wider than the viewport on mobile before this;
// now it scrolls internally instead, same idea as .cfg-scroll/pre.disasm
// already use for the CFG diagram and disassembly listing.
function table(rows){
  return '<div class="table-scroll"><table class="inspect-table">' + rows.map(r => '<tr>' + r.map((c,i) =>
    `<${i===0?'th':'td'}>${c}</${i===0?'th':'td'}>`).join('') + '</tr>').join('') + '</table></div>';
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

// A compact picker for fields that are literally a palette index — a
// single swatch showing the current color plus a dropper icon, not all
// 16 swatches rendered inline (the full grid used to render open by
// default here, which is exactly the "color palette" that was wide
// enough to overflow a mobile viewport). Clicking the trigger opens the
// full palette as a popover to pick from; picking a color or clicking
// outside closes it again. Generic over *what* picking a color does
// (backdrop index, a sprite shape's color, ...) via wireColorPickerSlot's
// onPick callback, rather than hardcoding a single lastParsedHeader path.
function renderColorPicker(colors, selectedIndex){
  const color = colors[selectedIndex] || '#000';
  return `
    <div class="color-picker">
      <button type="button" class="color-picker-trigger" style="background:${color}" title="${selectedIndex}: ${esc(color)}" aria-label="Pick a color">
        <span class="color-picker-dropper" aria-hidden="true">&#127912;</span>
      </button>
      <div class="color-picker-popover" hidden>
        <div class="pal-strip">${colors.map((c,i) => `
          <div class="pal-swatch pickable${i===selectedIndex?' selected':''}" style="background:${c}"
            title="${i}: ${esc(c)}" data-index="${i}" tabindex="0" role="button"><span>${i}</span></div>
        `).join('')}</div>
      </div>
    </div>
  `;
}
function wireColorPickerSlot(slotId, onPick){
  const slot = document.getElementById(slotId);
  if(!slot) return;
  const picker = slot.querySelector('.color-picker');
  if(!picker) return;
  const trigger = picker.querySelector('.color-picker-trigger');
  const popover = picker.querySelector('.color-picker-popover');
  trigger.addEventListener('click', (e) => {
    e.stopPropagation();
    const wasOpen = !popover.hidden;
    closeAllColorPickerPopovers();
    popover.hidden = wasOpen;
  });
  popover.querySelectorAll('.pal-swatch.pickable').forEach(sw => sw.addEventListener('click', () => {
    popover.hidden = true;
    onPick(+sw.dataset.index);
  }));
}
function closeAllColorPickerPopovers(){
  document.querySelectorAll('.color-picker-popover').forEach(p => { p.hidden = true; });
}
// One listener for the module's whole lifetime (not re-added per render)
// — any click outside an open popover closes it, the standard pattern
// for a dropdown-style control.
document.addEventListener('click', closeAllColorPickerPopovers);

function refreshBackdropPickers(){
  const pal = generatePalette(lastParsedHeader);
  const fillSlot = document.getElementById('backdropFillPickerSlot');
  const groundSlot = document.getElementById('backdropGroundPickerSlot');
  if(fillSlot) fillSlot.innerHTML = renderColorPicker(pal, lastParsedHeader.backdropFillIndex);
  if(groundSlot) groundSlot.innerHTML = renderColorPicker(pal, lastParsedHeader.backdropGroundIndex);
  wireColorPickerSlot('backdropFillPickerSlot', (idx) => {
    lastParsedHeader.backdropFillIndex = idx;
    refreshBackdropPickers();
    scheduleHeaderRecompile();
  });
  wireColorPickerSlot('backdropGroundPickerSlot', (idx) => {
    lastParsedHeader.backdropGroundIndex = idx;
    refreshBackdropPickers();
    scheduleHeaderRecompile();
  });
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
    <div class="header-field-row"><label>Fill color</label><div id="backdropFillPickerSlot">${renderColorPicker(pal, h.backdropFillIndex)}</div></div>
    <div class="header-field-row"><label>Ground height</label>
      <input type="number" id="field-backdropGroundHeight" min="0" max="255" value="${h.backdropGroundHeight}"></div>
    <div class="header-field-row"><label>Ground color</label><div id="backdropGroundPickerSlot">${renderColorPicker(pal, h.backdropGroundIndex)}</div></div>
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
  wireColorPickerSlot('backdropFillPickerSlot', (idx) => {
    lastParsedHeader.backdropFillIndex = idx;
    refreshBackdropPickers();
    scheduleHeaderRecompile();
  });
  wireColorPickerSlot('backdropGroundPickerSlot', (idx) => {
    lastParsedHeader.backdropGroundIndex = idx;
    refreshBackdropPickers();
    scheduleHeaderRecompile();
  });
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
  return '<div class="pal-strip">' + colors.map((c,i) => `
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

/* ============================================================
   Sprite shape editor — interactive canvas for kind:1 (shape-list)
   sprites: select/add/delete/reorder shapes, drag to move, drag corner
   handles to resize, recolor via the color-picker popover. Reuses
   World.buildBitmap() (runtime.js) for the live preview — the exact same
   rasterization + palette-resolution path the real runtime uses — rather
   than reimplementing shape rendering here, so a drag never shows
   something the compiled cart wouldn't actually produce.

   Both shape kinds (ellipse/rect) are normalized to one bounding-box
   shape for move/resize math via getShapeBox/setShapeBox, so the drag
   handlers themselves never branch on shape.type.
   ============================================================ */
function clampShapeUnit(v){
  // 1/8px fixed point, ceiling 31.875 (kernel.js's encodeCart rounds
  // value*8 into a u8 byte) — round to the nearest representable value
  // and clamp so a drag can never produce something that would silently
  // wrap or throw at compile time.
  return Math.max(0, Math.min(31.875, Math.round(v*8)/8));
}
function getShapeBox(shape){
  return shape.type === SHAPE_ELLIPSE
    ? {x0: shape.cx-shape.rx, y0: shape.cy-shape.ry, x1: shape.cx+shape.rx, y1: shape.cy+shape.ry}
    : {x0: shape.x, y0: shape.y, x1: shape.x+shape.w, y1: shape.y+shape.h};
}
// Normalizes min/max first — a resize dragged past its fixed opposite
// corner flips naturally instead of producing a negative width/height.
function setShapeBox(shape, box){
  const x0 = Math.min(box.x0,box.x1), x1 = Math.max(box.x0,box.x1);
  const y0 = Math.min(box.y0,box.y1), y1 = Math.max(box.y0,box.y1);
  if(shape.type === SHAPE_ELLIPSE){
    shape.cx = clampShapeUnit((x0+x1)/2); shape.cy = clampShapeUnit((y0+y1)/2);
    shape.rx = clampShapeUnit(Math.max(0.5,(x1-x0)/2)); shape.ry = clampShapeUnit(Math.max(0.5,(y1-y0)/2));
  } else {
    shape.x = clampShapeUnit(x0); shape.y = clampShapeUnit(y0);
    shape.w = clampShapeUnit(Math.max(1,x1-x0)); shape.h = clampShapeUnit(Math.max(1,y1-y0));
  }
}

function spriteEditorHtml(spriteIndex){
  return `
    <div class="sprite-editor" id="spriteEditor${spriteIndex}">
      <div class="sprite-editor-canvas-wrap"><canvas id="spriteEditorCanvas${spriteIndex}"></canvas></div>
      <div id="spriteShapeListSlot${spriteIndex}"></div>
      <div class="opcode-btns" style="margin-top:6px;">
        <button type="button" class="opcode-btn" id="spriteAddEllipseBtn${spriteIndex}">+ Ellipse</button>
        <button type="button" class="opcode-btn" id="spriteAddRectBtn${spriteIndex}">+ Rect</button>
      </div>
    </div>
  `;
}

// Draws the sprite's current shapes (via inspectWorld.buildBitmap — the
// real runtime rasterizer, not a reimplementation) scaled up onto the
// editor's own canvas, then an overlay (bounding box + 4 corner handles)
// for whichever shape is selected, if any.
function redrawSpriteEditor(spriteIndex){
  const canvas = document.getElementById('spriteEditorCanvas'+spriteIndex);
  if(!canvas) return;
  const sprite = lastParsedHeader.sprites[spriteIndex];
  const w = sprite.w, h = sprite.h;
  canvas.width = w * SPRITE_EDITOR_ZOOM;
  canvas.height = h * SPRITE_EDITOR_ZOOM;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  const bitmap = inspectWorld.buildBitmap({kind:1, w, h, shapes: sprite.shapes}, true);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);

  const selIdx = selectedShapeIndex[spriteIndex];
  const shape = (selIdx !== undefined) ? sprite.shapes[selIdx] : undefined;
  if(shape){
    const box = getShapeBox(shape);
    const x0 = box.x0*SPRITE_EDITOR_ZOOM, y0 = box.y0*SPRITE_EDITOR_ZOOM;
    const x1 = box.x1*SPRITE_EDITOR_ZOOM, y1 = box.y1*SPRITE_EDITOR_ZOOM;
    ctx.strokeStyle = '#e0a030'; ctx.lineWidth = 1.5;
    ctx.strokeRect(x0+0.5, y0+0.5, x1-x0, y1-y0);
    const hs = 5; // handle half-size, in canvas px
    ctx.fillStyle = '#e0a030';
    for(const [hx,hy] of [[x0,y0],[x1,y0],[x0,y1],[x1,y1]]){
      ctx.fillRect(hx-hs, hy-hs, hs*2, hs*2);
    }
  }
}

// One row per shape — array order is z-order (renderShapeList paints
// later shapes over earlier ones), so the up/down buttons here are
// literally "layer" reordering in the user's own sense of the word.
function renderShapeListPanel(spriteIndex){
  const slot = document.getElementById('spriteShapeListSlot'+spriteIndex);
  if(!slot) return;
  const sprite = lastParsedHeader.sprites[spriteIndex];
  const pal = generatePalette(lastParsedHeader);
  const selIdx = selectedShapeIndex[spriteIndex];
  if(!sprite.shapes.length){
    slot.innerHTML = '<p class="inspect-empty">No shapes yet — add one below.</p>';
    return;
  }
  slot.innerHTML = '<div class="shape-list">' + sprite.shapes.map((sh,j) => `
    <div class="shape-row${j===selIdx?' selected':''}" data-shape-index="${j}">
      <span class="shape-row-label">${sh.type===SHAPE_ELLIPSE?'Ellipse':'Rect'} ${j}</span>
      <div class="shape-row-color" id="shapeColorSlot${spriteIndex}_${j}">${renderColorPicker(pal, sh.color)}</div>
      <button type="button" class="shape-btn shape-move-up" data-dir="-1"${j===0?' disabled':''} title="Move up (drawn later = on top)">&#9650;</button>
      <button type="button" class="shape-btn shape-move-down" data-dir="1"${j===sprite.shapes.length-1?' disabled':''} title="Move down">&#9660;</button>
      <button type="button" class="shape-btn shape-delete" title="Delete">&#10005;</button>
    </div>
  `).join('') + '</div>';
  wireShapeListPanel(spriteIndex);
}

// Every handler re-fetches lastParsedHeader.sprites[spriteIndex] fresh at
// click time rather than closing over a `sprite` reference captured when
// this function ran — lastParsedHeader is wholesale-replaced by every
// successful recompile (compileSourceText), so a reference captured at
// wiring time can be pointing at a detached, orphaned object by the time
// a button is actually clicked (the same staleness hazard the drag
// handlers already guard against, see spriteEditorPointerMove).
function wireShapeListPanel(spriteIndex){
  const slot = document.getElementById('spriteShapeListSlot'+spriteIndex);
  if(!slot) return;
  slot.querySelectorAll('.shape-row').forEach(row => {
    const j = +row.dataset.shapeIndex;
    row.addEventListener('click', (e) => {
      if(e.target.closest('button') || e.target.closest('.color-picker')) return;
      selectedShapeIndex[spriteIndex] = j;
      redrawSpriteEditor(spriteIndex);
      renderShapeListPanel(spriteIndex);
    });
    wireColorPickerSlot('shapeColorSlot'+spriteIndex+'_'+j, (idx) => {
      setHeaderPath(['sprites', spriteIndex, 'shapes', j, 'color'], idx);
      redrawSpriteEditor(spriteIndex);
      renderShapeListPanel(spriteIndex);
      scheduleHeaderRecompile();
    });
  });
  slot.querySelectorAll('.shape-move-up, .shape-move-down').forEach(btn => btn.addEventListener('click', (e) => {
    e.stopPropagation();
    const sprite = lastParsedHeader.sprites[spriteIndex];
    const row = btn.closest('.shape-row');
    const j = +row.dataset.shapeIndex;
    const k = j + (+btn.dataset.dir);
    if(k < 0 || k >= sprite.shapes.length) return;
    const tmp = sprite.shapes[j]; sprite.shapes[j] = sprite.shapes[k]; sprite.shapes[k] = tmp;
    if(selectedShapeIndex[spriteIndex] === j) selectedShapeIndex[spriteIndex] = k;
    else if(selectedShapeIndex[spriteIndex] === k) selectedShapeIndex[spriteIndex] = j;
    redrawSpriteEditor(spriteIndex);
    renderShapeListPanel(spriteIndex);
    scheduleHeaderRecompile();
  }));
  slot.querySelectorAll('.shape-delete').forEach(btn => btn.addEventListener('click', (e) => {
    e.stopPropagation();
    const sprite = lastParsedHeader.sprites[spriteIndex];
    const row = btn.closest('.shape-row');
    const j = +row.dataset.shapeIndex;
    sprite.shapes.splice(j, 1);
    if(selectedShapeIndex[spriteIndex] === j) delete selectedShapeIndex[spriteIndex];
    else if(selectedShapeIndex[spriteIndex] > j) selectedShapeIndex[spriteIndex]--;
    redrawSpriteEditor(spriteIndex);
    renderShapeListPanel(spriteIndex);
    scheduleHeaderRecompile();
  }));
}

function addShape(spriteIndex, type){
  const sprite = lastParsedHeader.sprites[spriteIndex];
  const w = sprite.w, h = sprite.h;
  const size = clampShapeUnit(Math.min(w,h)/2);
  const shape = type === SHAPE_ELLIPSE
    ? {type: SHAPE_ELLIPSE, cx: clampShapeUnit(w/2), cy: clampShapeUnit(h/2), rx: clampShapeUnit(size/2), ry: clampShapeUnit(size/2), color: 9}
    : {type: SHAPE_RECT, x: clampShapeUnit(w/2-size/2), y: clampShapeUnit(h/2-size/2), w: size, h: size, color: 9};
  sprite.shapes.push(shape);
  selectedShapeIndex[spriteIndex] = sprite.shapes.length - 1;
  redrawSpriteEditor(spriteIndex);
  renderShapeListPanel(spriteIndex);
  scheduleHeaderRecompile();
}

function spritesListHtml(cart){
  let html = '';
  cart.sprites.forEach((s,i) => {
    html += `<div class="inspect-section-title">Sprite ${i} — ${s.w}×${s.h}, ${s.kind===1?'shape list':'raw pixels'}</div>`;
    if(s.kind === 1){
      html += spriteEditorHtml(i);
    } else {
      html += `<div id="spriteSlot${i}" style="max-width:160px;margin-bottom:10px;"></div>`;
      html += '<p class="inspect-empty">Raw-pixel editing is a future phase.</p>';
    }
  });
  return html;
}
// Only the kind!==1 (raw-pixel) sprites still get the static read-only
// thumbnail here — kind:1 sprites get the interactive editor's own canvas
// instead (attachSpriteEditors), which draws straight from the live
// shapes array rather than the last-compiled inspectWorld.spriteCanvases.
// replaceChildren, not appendChild — makes this safe to call a second
// time against the same DOM (refreshAssetCanvasesIfVisible does exactly
// that after a recompile swaps inspectWorld out from under an
// already-rendered Assets tab), swapping in the new canvas instead of
// stacking it behind the stale one.
function attachSpriteCanvases(cart){
  cart.sprites.forEach((s,i) => {
    if(s.kind === 1) return;
    const slot = document.getElementById('spriteSlot'+i);
    if(!slot) return;
    const c = inspectWorld.spriteCanvases[i];
    c.style.width = '100%'; c.style.imageRendering = 'pixelated';
    c.style.border = '1px solid var(--rule)'; c.style.background = 'var(--bg-card)';
    slot.replaceChildren(c);
  });
}
// No letterboxing to account for (unlike the full-viewport game canvas'
// pointerToCartCoords in runtime.js) since this canvas is never object-fit
// — CSS width:100%/height:auto keeps its aspect ratio locked to the
// sprite's own, so a straight ratio of displayed-size to sprite-size is
// enough to land a pointer event in sprite-space coordinates.
function spriteEditorPointerCoords(canvas, sprite, e){
  const rect = canvas.getBoundingClientRect();
  return {
    x: (e.clientX - rect.left) * sprite.w / rect.width,
    y: (e.clientY - rect.top) * sprite.h / rect.height,
  };
}
// ~12 *screen* pixels converted to sprite-space, not a fixed sprite-space
// radius — keeps corner handles comfortably tappable regardless of how
// zoomed-out a small sprite is displayed (e.g. on a narrow phone).
function spriteHandleHitRadius(canvas, sprite){
  const rect = canvas.getBoundingClientRect();
  return 12 * sprite.w / rect.width;
}
function hitTestHandle(box, x, y, radius){
  for(const [hx,hy] of [[box.x0,box.y0],[box.x1,box.y0],[box.x0,box.y1],[box.x1,box.y1]]){
    if(Math.abs(x-hx) <= radius && Math.abs(y-hy) <= radius) return [hx===box.x0?'w':'e', hy===box.y0?'n':'s'].join('');
  }
  return null;
}
function hitTestShapeBox(box, x, y){
  return x >= box.x0 && x <= box.x1 && y >= box.y0 && y <= box.y1;
}
// Reverse array order — topmost/last-drawn shape wins, matching
// renderShapeList's own painter's-algorithm paint order.
function pickShapeAt(shapes, x, y){
  for(let j = shapes.length-1; j >= 0; j--){
    if(hitTestShapeBox(getShapeBox(shapes[j]), x, y)) return j;
  }
  return -1;
}

function spriteEditorPointerDown(spriteIndex, canvas, e){
  const sprite = lastParsedHeader.sprites[spriteIndex];
  const p = spriteEditorPointerCoords(canvas, sprite, e);
  const selIdx = selectedShapeIndex[spriteIndex];
  // A selected shape's own handles win over starting a new selection
  // underneath them — standard editor convention.
  if(selIdx !== undefined && sprite.shapes[selIdx]){
    const box = getShapeBox(sprite.shapes[selIdx]);
    const corner = hitTestHandle(box, p.x, p.y, spriteHandleHitRadius(canvas, sprite));
    if(corner){
      canvas.setPointerCapture(e.pointerId);
      spriteDragState = {spriteIndex, mode:'resize', shapeIndex:selIdx, corner, startBox: box};
      return;
    }
  }
  const hit = pickShapeAt(sprite.shapes, p.x, p.y);
  if(hit === -1){
    if(selectedShapeIndex[spriteIndex] !== undefined){
      delete selectedShapeIndex[spriteIndex];
      redrawSpriteEditor(spriteIndex);
      renderShapeListPanel(spriteIndex);
    }
    return;
  }
  selectedShapeIndex[spriteIndex] = hit;
  redrawSpriteEditor(spriteIndex);
  renderShapeListPanel(spriteIndex);
  canvas.setPointerCapture(e.pointerId);
  spriteDragState = {spriteIndex, mode:'move', shapeIndex: hit, startPointer: p, startBox: getShapeBox(sprite.shapes[hit])};
}
function spriteEditorPointerMove(spriteIndex, canvas, e){
  if(!spriteDragState || spriteDragState.spriteIndex !== spriteIndex) return;
  const sprite = lastParsedHeader.sprites[spriteIndex];
  // Re-fetch the live shape by index every tick — never hold the object
  // reference captured at pointerdown, since lastParsedHeader is
  // wholesale-replaced on every successful recompile and a slow drag can
  // outlast the 400ms debounce.
  const shape = sprite.shapes[spriteDragState.shapeIndex];
  if(!shape) { spriteDragState = null; return; }
  const p = spriteEditorPointerCoords(canvas, sprite, e);
  if(spriteDragState.mode === 'move'){
    const dx = p.x - spriteDragState.startPointer.x, dy = p.y - spriteDragState.startPointer.y;
    const b = spriteDragState.startBox;
    setShapeBox(shape, {x0: b.x0+dx, y0: b.y0+dy, x1: b.x1+dx, y1: b.y1+dy});
  } else { // resize — recompute from the fixed opposite corner to the live pointer
    const b = spriteDragState.startBox;
    const fixedX = spriteDragState.corner[0] === 'w' ? b.x1 : b.x0;
    const fixedY = spriteDragState.corner[1] === 'n' ? b.y1 : b.y0;
    setShapeBox(shape, {x0: fixedX, y0: fixedY, x1: p.x, y1: p.y});
  }
  // setShapeBox already mutated `shape` in place — it's a live reference
  // into lastParsedHeader.sprites[spriteIndex].shapes[...], not a copy —
  // so there's nothing further to write back, just redraw and recompile.
  redrawSpriteEditor(spriteIndex);
  scheduleHeaderRecompile();
}
function spriteEditorPointerUp(spriteIndex){
  if(spriteDragState && spriteDragState.spriteIndex === spriteIndex){
    renderShapeListPanel(spriteIndex);
    spriteDragState = null;
  }
}

function attachSpriteEditors(cart){
  cart.sprites.forEach((s,i) => {
    if(s.kind !== 1) return;
    redrawSpriteEditor(i);
    renderShapeListPanel(i);
    const canvas = document.getElementById('spriteEditorCanvas'+i);
    canvas.addEventListener('pointerdown', (e) => { e.preventDefault(); spriteEditorPointerDown(i, canvas, e); }, {passive:false});
    canvas.addEventListener('pointermove', (e) => spriteEditorPointerMove(i, canvas, e));
    canvas.addEventListener('pointerup', () => spriteEditorPointerUp(i));
    canvas.addEventListener('pointercancel', () => spriteEditorPointerUp(i));
    const addEllipseBtn = document.getElementById('spriteAddEllipseBtn'+i);
    const addRectBtn = document.getElementById('spriteAddRectBtn'+i);
    if(addEllipseBtn) addEllipseBtn.addEventListener('click', () => addShape(i, SHAPE_ELLIPSE));
    if(addRectBtn) addRectBtn.addEventListener('click', () => addShape(i, SHAPE_RECT));
  });
}
// Tile pixel editor — every tile is raw pixels only (no shape-list
// option the way sprites have), so "editing" here just means painting
// palette indices directly, no shape math needed at all. Mirrors the
// sprite editor's redraw/pointer-handler shape closely (buildBitmap for
// the real render, re-fetch lastParsedHeader fresh every event) since
// it's the same "zoomed-in editable canvas" idea underneath.
function tileEditorHtml(tileIndex){
  return `
    <div class="tile-editor" id="tileEditor${tileIndex}">
      <div class="tile-editor-canvas-wrap"><canvas id="tileEditorCanvas${tileIndex}"></canvas></div>
      <div id="tilePaletteSlot${tileIndex}"></div>
    </div>
  `;
}
function tilesListHtml(cart){
  let html = '';
  cart.tiles.forEach((t,i) => {
    html += `<div class="inspect-section-title">Tile ${i} — ${t.w}×${t.h}</div>`;
    html += tileEditorHtml(i);
  });
  return html;
}
// Draws the tile's current pixels (via inspectWorld.buildBitmap — same
// real rasterizer the runtime uses, not a reimplementation) scaled up,
// plus a faint per-cell grid — a true bitmap editor benefits from visible
// cell boundaries the vector shape editor never needed.
function redrawTileEditor(tileIndex){
  const canvas = document.getElementById('tileEditorCanvas'+tileIndex);
  if(!canvas) return;
  const tile = lastParsedHeader.tiles[tileIndex];
  const w = tile.w, h = tile.h;
  canvas.width = w * SPRITE_EDITOR_ZOOM;
  canvas.height = h * SPRITE_EDITOR_ZOOM;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  const bitmap = inspectWorld.buildBitmap({w, h, pixels: tile.pixels}, false);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  ctx.strokeStyle = 'rgba(128,128,128,.35)'; ctx.lineWidth = 1;
  for(let x=1;x<w;x++){
    ctx.beginPath(); ctx.moveTo(x*SPRITE_EDITOR_ZOOM+0.5, 0); ctx.lineTo(x*SPRITE_EDITOR_ZOOM+0.5, canvas.height); ctx.stroke();
  }
  for(let y=1;y<h;y++){
    ctx.beginPath(); ctx.moveTo(0, y*SPRITE_EDITOR_ZOOM+0.5); ctx.lineTo(canvas.width, y*SPRITE_EDITOR_ZOOM+0.5); ctx.stroke();
  }
}
// Always-visible strip (not a popover — a paint tool needs its current
// color reselectable at any time, unlike a single-field color picker), so
// it gets its own small renderer rather than reusing renderColorPicker.
function renderTilePaletteSlot(tileIndex){
  const slot = document.getElementById('tilePaletteSlot'+tileIndex);
  if(!slot) return;
  const pal = generatePalette(lastParsedHeader);
  if(selectedTileColor[tileIndex] === undefined) selectedTileColor[tileIndex] = 1;
  const sel = selectedTileColor[tileIndex];
  slot.innerHTML = `<div class="pal-strip">${pal.map((c,i) => `
    <div class="pal-swatch pickable${i===sel?' selected':''}" style="background:${c}"
      title="${i}: ${esc(c)}" data-index="${i}" tabindex="0" role="button"><span>${i}</span></div>
  `).join('')}</div>`;
  slot.querySelectorAll('.pal-swatch.pickable').forEach(sw => sw.addEventListener('click', () => {
    selectedTileColor[tileIndex] = +sw.dataset.index;
    renderTilePaletteSlot(tileIndex);
  }));
}
// No letterboxing (same reasoning as spriteEditorPointerCoords) — floored
// and clamped to the tile's own bounds since a drag can carry the pointer
// past the canvas edge while still captured.
function tileEditorPointerCoords(canvas, tile, e){
  const rect = canvas.getBoundingClientRect();
  const x = Math.floor((e.clientX - rect.left) * tile.w / rect.width);
  const y = Math.floor((e.clientY - rect.top) * tile.h / rect.height);
  return {x: Math.max(0, Math.min(tile.w-1, x)), y: Math.max(0, Math.min(tile.h-1, y))};
}
// Re-fetches lastParsedHeader.tiles[tileIndex] fresh on every call rather
// than a reference captured at pointerdown — same staleness hazard the
// sprite editor's drag handlers already guard against (lastParsedHeader is
// wholesale-replaced by every successful recompile). Returns whether the
// pixel actually changed, so callers can skip a redraw/recompile on a
// same-color repaint.
function paintTilePixel(tileIndex, x, y){
  const tile = lastParsedHeader.tiles[tileIndex];
  const idx = y*tile.w + x;
  const color = selectedTileColor[tileIndex] === undefined ? 1 : selectedTileColor[tileIndex];
  if(tile.pixels[idx] === color) return false;
  tile.pixels[idx] = color;
  return true;
}
function tileEditorPointerDown(tileIndex, canvas, e){
  canvas.setPointerCapture(e.pointerId);
  const tile = lastParsedHeader.tiles[tileIndex];
  const p = tileEditorPointerCoords(canvas, tile, e);
  tileDragState = {tileIndex, lastX: -1, lastY: -1};
  if(paintTilePixel(tileIndex, p.x, p.y)){
    tileDragState.lastX = p.x; tileDragState.lastY = p.y;
    redrawTileEditor(tileIndex);
    scheduleHeaderRecompile();
  }
}
function tileEditorPointerMove(tileIndex, canvas, e){
  if(!tileDragState || tileDragState.tileIndex !== tileIndex) return;
  const tile = lastParsedHeader.tiles[tileIndex];
  const p = tileEditorPointerCoords(canvas, tile, e);
  if(p.x === tileDragState.lastX && p.y === tileDragState.lastY) return;
  if(paintTilePixel(tileIndex, p.x, p.y)){
    tileDragState.lastX = p.x; tileDragState.lastY = p.y;
    redrawTileEditor(tileIndex);
    scheduleHeaderRecompile();
  }
}
function tileEditorPointerUp(tileIndex){
  if(tileDragState && tileDragState.tileIndex === tileIndex) tileDragState = null;
}
function attachTileEditors(cart){
  cart.tiles.forEach((t,i) => {
    redrawTileEditor(i);
    renderTilePaletteSlot(i);
    const canvas = document.getElementById('tileEditorCanvas'+i);
    if(!canvas) return;
    canvas.addEventListener('pointerdown', (e) => { e.preventDefault(); tileEditorPointerDown(i, canvas, e); }, {passive:false});
    canvas.addEventListener('pointermove', (e) => tileEditorPointerMove(i, canvas, e));
    canvas.addEventListener('pointerup', () => tileEditorPointerUp(i));
    canvas.addEventListener('pointercancel', () => tileEditorPointerUp(i));
  });
}
// The sprite shape editor was the first Assets-tab control that could
// trigger a recompile while Assets stays the visible tab (every other
// editable field lived on Logic/Source, tabs Assets isn't shown
// alongside) — the tile editor and the Assets tab's own palette slider
// now share that property. Every recompile swaps inspectWorld = new
// World(cart) (see compileSourceText), which orphans the *other* kind:0
// sprite thumbnails already appended into the page from the previous
// inspectWorld, and — since redraw for both editor canvases resolves
// colors through that same inspectWorld — leaves any already-open kind:1
// sprite or tile editor showing stale colors after a palette edit until
// something else forces a redraw. Called from compileSourceText's
// success branch; a no-op unless Assets is the tab actually on screen.
function refreshAssetCanvasesIfVisible(){
  if(inspectTab !== 'Assets' || !inspectCartInfo) return;
  attachSpriteCanvases(inspectCartInfo.cart);
  lastParsedHeader.sprites.forEach((s,i) => { if(s.kind === 1) redrawSpriteEditor(i); });
  lastParsedHeader.tiles.forEach((t,i) => redrawTileEditor(i));
}
// Assets tab: palette + sprites + tiles, in sequence — everything that's
// just pixels, nothing that's behavior. Built as one body.innerHTML pass
// (not three separate ones) so the sprite/tile editors' slot divs exist
// before attachSpriteCanvases/attachSpriteEditors/attachTileEditors go
// looking for them.
function renderInspectAssets(body, cart){
  let html = '<div class="inspect-section-title">Palette</div>';
  html += renderInspectPalette(cart);
  html += '<div class="inspect-section-title">Sprites</div>';
  html += spritesListHtml(cart);
  html += '<div class="inspect-section-title">Tiles</div>';
  html += tilesListHtml(cart);
  body.innerHTML = html;
  attachSpriteCanvases(cart);
  attachSpriteEditors(cart);
  attachTileEditors(cart);
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

/* ============================================================
   Entity-type editor (Logic tab) — add/remove entity types, edit
   renderKind/rotate/collision/extFieldCount, and reassign which sprite
   or tile column a type *starts* drawing as. That's spawn-time only:
   assetIndex here is copied into each spawned entity's own
   props[8 + extFieldCount] as a default (one slot past every ext
   field — see World.spawnEntity in runtime.js), and any hook can
   retarget one specific instance from there via ordinary
   STORE_SELF (8 + extFieldCount) without touching this type-level
   default at all. Each card edits lastParsedHeader directly and
   debounce-recompiles, same convention as every other header-form field
   (bindHeaderField) — only renderKind changes and the asset-picker need
   custom wiring, since those change *which options are valid* rather
   than just writing a scalar.
   ============================================================ */

// typeId is a plain array index into entityTypes — nothing rewrites a
// hook's `SPAWN <n>` operand when a type earlier in the array is deleted,
// so every later type's index (and any hook that hardcodes it) shifts.
// Said once here, not re-litigated per card.
const ENTITY_INDEX_WARNING = 'Entity types are numbered by array position — deleting one shifts every later index. Any hook\'s SPAWN referencing a shifted type needs updating by hand.';

function entityAssetThumbHtml(entityIndex){
  return `<canvas id="entityAssetThumb${entityIndex}" width="1" height="1"></canvas>`;
}
// Draws whatever the type's renderKind/assetIndex currently point at —
// sourced from inspectWorld (the last successfully compiled cart), same
// as every other thumbnail in this view. Guarded against an out-of-range
// assetIndex (a renderKind just switched, or a recompile hasn't landed
// yet) rather than throwing on a missing source.
function renderEntityAssetThumb(entityIndex){
  const t = lastParsedHeader.entityTypes[entityIndex];
  const c = document.getElementById('entityAssetThumb'+entityIndex);
  if(!c) return;
  const src = t.renderKind === 1 ? (inspectWorld.tileCanvases||[])[t.assetIndex] : (inspectWorld.spriteCanvases||[])[t.assetIndex];
  if(!src){ c.width = 1; c.height = 1; return; }
  c.width = src.width; c.height = src.height;
  c.getContext('2d').drawImage(src, 0, 0);
}
function entityAssetPopoverGridHtml(renderKind){
  if(renderKind === 2) return '<p class="inspect-empty">Not used for custom draw (on_draw paints it directly).</p>';
  const cart = inspectCartInfo.cart;
  const items = renderKind === 1 ? cart.tiles : cart.sprites;
  const label = renderKind === 1 ? 'tile' : 'sprite';
  if(!items.length) return `<p class="inspect-empty">No ${label}s in this cart yet.</p>`;
  // Distinct class names from the opcode palette's own .operand-picker-*
  // (CSS rules still shared, see index.html) — both this popover and the
  // SPAWN operand picker can be present in the DOM at once on the Logic
  // tab, and a page-global selector like '.operand-picker-item[data-value="0"]'
  // would otherwise match one of each.
  return `<div class="entity-asset-grid">${items.map((it,i) => `
    <div class="entity-asset-item" data-value="${i}" tabindex="0"><canvas id="entityAssetPick${renderKind}_${i}" width="1" height="1"></canvas><div>${label} ${i}</div></div>
  `).join('')}</div>`;
}
function entityAssetPickerHtml(entityIndex, t){
  return `
    <div class="entity-asset-picker" id="entityAssetPicker${entityIndex}">
      <button type="button" class="entity-asset-trigger" title="Change sprite/tile">${entityAssetThumbHtml(entityIndex)}</button>
      <div class="entity-asset-popover" id="entityAssetPopover${entityIndex}" hidden>${entityAssetPopoverGridHtml(t.renderKind)}</div>
    </div>
  `;
}
function closeAllEntityAssetPopovers(){
  document.querySelectorAll('.entity-asset-popover').forEach(p => { p.hidden = true; });
}
document.addEventListener('click', closeAllEntityAssetPopovers);
function wireEntityAssetPicker(entityIndex){
  const picker = document.getElementById('entityAssetPicker'+entityIndex);
  if(!picker) return;
  const trigger = picker.querySelector('.entity-asset-trigger');
  const popover = document.getElementById('entityAssetPopover'+entityIndex);
  trigger.addEventListener('click', (e) => {
    e.stopPropagation();
    const wasOpen = !popover.hidden;
    closeAllEntityAssetPopovers();
    popover.hidden = wasOpen;
  });
  const t = lastParsedHeader.entityTypes[entityIndex];
  if(t.renderKind !== 2){
    const src = t.renderKind === 1 ? inspectWorld.tileCanvases : inspectWorld.spriteCanvases;
    (src||[]).forEach((s,i) => {
      const c = document.getElementById(`entityAssetPick${t.renderKind}_${i}`);
      if(!c || !s) return;
      c.width = s.width; c.height = s.height;
      c.getContext('2d').drawImage(s, 0, 0);
    });
  }
  popover.querySelectorAll('.entity-asset-item').forEach(el => el.addEventListener('click', () => {
    setHeaderPath(['entityTypes', entityIndex, 'assetIndex'], +el.dataset.value);
    popover.hidden = true;
    renderEntityAssetThumb(entityIndex);
    scheduleHeaderRecompile();
  }));
}

function entityTypeCardHtml(entityIndex, t){
  return `
    <div class="entity-card" id="entityCard${entityIndex}">
      <div class="entity-card-header">
        <span class="entity-card-label">Entity ${entityIndex}</span>
        <button type="button" class="entity-delete-btn" data-entity-index="${entityIndex}" title="Delete">&#10005;</button>
      </div>
      <div class="entity-card-row">
        <label>Render
          <select id="entityRenderKind${entityIndex}">
            <option value="0"${t.renderKind===0?' selected':''}>Sprite</option>
            <option value="1"${t.renderKind===1?' selected':''}>Tile column</option>
            <option value="2"${t.renderKind===2?' selected':''}>Custom draw (on_draw)</option>
          </select>
        </label>
        ${entityAssetPickerHtml(entityIndex, t)}
        <label><input type="checkbox" id="entityRotate${entityIndex}"${t.rotateFlag?' checked':''}/> Rotate</label>
      </div>
      <div class="entity-card-row">
        <label>Collision W <input type="number" id="entityCollW${entityIndex}" value="${t.collisionW}" min="0" max="255"/></label>
        <label>H <input type="number" id="entityCollH${entityIndex}" value="${t.collisionH}" min="0" max="255"/></label>
        <label>Ext fields <input type="number" id="entityExtFields${entityIndex}" value="${t.extFieldCount}" min="0" max="255"/></label>
      </div>
    </div>
  `;
}
function entityTypesPanelHtml(){
  const types = lastParsedHeader.entityTypes;
  let html = `<p class="inspect-help">${ENTITY_INDEX_WARNING}</p>`;
  if(!types.length) html += '<p class="inspect-empty">No entity types yet — add one below.</p>';
  else html += types.map((t,i) => entityTypeCardHtml(i,t)).join('');
  html += '<div class="opcode-btns" style="margin-top:6px;"><button type="button" class="opcode-btn" id="addEntityTypeBtn">+ Entity Type</button></div>';
  return html;
}
function renderEntityTypesPanel(){
  const slot = document.getElementById('entityTypesSlot');
  if(!slot) return;
  slot.innerHTML = entityTypesPanelHtml();
  wireEntityTypesPanel();
}
function wireEntityTypesPanel(){
  const types = lastParsedHeader.entityTypes;
  types.forEach((t,i) => {
    // renderKind change swaps which asset domain (sprites vs tiles vs
    // neither) assetIndex points into — resets it to 0 rather than
    // leaving it referencing a value that may not even exist in the new
    // domain, and re-renders the whole panel since the picker's own
    // available options changed, not just a scalar.
    bindHeaderField(document.getElementById('entityRenderKind'+i), ['entityTypes', i, 'renderKind'], {onAfter: () => {
      setHeaderPath(['entityTypes', i, 'assetIndex'], 0);
      renderEntityTypesPanel();
    }});
    bindHeaderField(document.getElementById('entityRotate'+i), ['entityTypes', i, 'rotateFlag'], {parse: v => v ? 1 : 0});
    bindHeaderField(document.getElementById('entityCollW'+i), ['entityTypes', i, 'collisionW']);
    bindHeaderField(document.getElementById('entityCollH'+i), ['entityTypes', i, 'collisionH']);
    bindHeaderField(document.getElementById('entityExtFields'+i), ['entityTypes', i, 'extFieldCount']);
    wireEntityAssetPicker(i);
    renderEntityAssetThumb(i);
  });
  document.querySelectorAll('.entity-delete-btn').forEach(btn => btn.addEventListener('click', () => {
    lastParsedHeader.entityTypes.splice(+btn.dataset.entityIndex, 1);
    renderEntityTypesPanel();
    scheduleHeaderRecompile();
  }));
  const addBtn = document.getElementById('addEntityTypeBtn');
  if(addBtn) addBtn.addEventListener('click', () => {
    lastParsedHeader.entityTypes.push({renderKind: 0, assetIndex: 0, rotateFlag: 0, collisionW: 8, collisionH: 8, extFieldCount: 0});
    renderEntityTypesPanel();
    scheduleHeaderRecompile();
  });
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
  html += '<div class="inspect-section-title">Entities</div><div id="entityTypesSlot"></div>';
  html += '<div class="inspect-section-title">Hooks</div><div id="hooksSlot"></div>';
  body.innerHTML = html;
  wireInspectOverview();
  renderEntityTypesPanel();
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
      refreshAssetCanvasesIfVisible();
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
