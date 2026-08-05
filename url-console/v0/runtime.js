/* ============================================================
   The Urlcade — player runtime

   Everything about actually *playing* a decoded cart that needs a real
   `document`/`canvas`/WebGL context: the World simulation (entities,
   hooks, collisions, tilemap), both render backends (WebGL preferred,
   Canvas2D fallback), touch/keyboard input, the fixed-timestep game
   loop, and the cart-shelf menu + game view switching.

   This is "the runtime" — split out on its own, on purpose, from what
   used to be one ~5000-line urlcade.html mixing this together with five
   example carts and the Cart Inspector. The cart *format* itself (VM,
   opcodes, binary encode/decode, palette/map generators, disassembler)
   isn't duplicated here — it's loaded once from kernel.js (a classic,
   non-module <script> tag, so it's available here as the global
   `window.UrlcadeKernel`) and reused as-is. See main.js for how this
   module, inspector.js, and carts/index.js get wired together.
   ============================================================ */
"use strict";
const K = window.UrlcadeKernel;
const {
  generatePalette, buildTrack, buildCave, buildPlatformLevel, buildBlankMap, applyMapShapes, renderShapeList,
  runHook, MAP_EDGE_TILE, BUTTON_BITS,
  TOUCH_TEMPLATE_NONE, TOUCH_TEMPLATE_SINGLE, TOUCH_TEMPLATE_STEER_ACTION,
  TOUCH_TEMPLATE_DPAD_ACTION, TOUCH_TEMPLATE_DPAD_ONLY,
  decodeCart, decodePayloadToBytes, decodeCartUrl, describeControls, encodeCart,
} = K;
import { CARTS } from './carts/index.js';
import { cssColorToRGB } from './color-utils.js';

/* ============================================================
   7. World runtime — entities, hooks, collisions, game loop
   ============================================================ */
function mulberry32(seed){
  let a = seed >>> 0;
  return function(){
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// FNV-1a, 32-bit — the persist[] localStorage key (see World's
// constructor). Deliberately synchronous and dependency-free rather than
// crypto.subtle.digest(): the latter is Promise-based, which would force
// `new World(cart)` (a plain sync call everywhere it's used today, e.g.
// main.js) into an async construction path just to derive a cache key
// that doesn't need cryptographic collision-resistance — not worth
// restructuring cart load for. Hashes encodeCart(cart)'s bytes, not the
// raw URL fragment: a future compression-scheme change re-encoding the
// same logical cart differently would otherwise silently orphan existing
// save data with no actual change to the cart's own content.
function hashCartBytes(bytes){
  let h = 0x811c9dc5; // FNV offset basis
  for(let i=0;i<bytes.length;i++){
    h ^= bytes[i];
    h = Math.imul(h, 0x01000193) >>> 0; // FNV prime
  }
  return h.toString(16).padStart(8,'0');
}

// Site-wide audio: one shared AudioContext for the whole page, not one
// per World — every World's voices/one-shot sounds route through this
// single context rather than each building its own, so there's one
// thing for the mute toggle (index.html's speaker icon next to Tinker)
// to suspend/resume regardless of how many carts or restarts happen
// over a session. Defaults to *off*: `audioEnabled` only reads
// `localStorage`'s prior opt-in, never assumes one, and nothing in this
// file ever constructs an `AudioContext` while it's false — a
// first-time visitor gets total silence, not muted-but-present audio
// infrastructure, until they explicitly turn it on.
let audioCtx = null;
const AUDIO_ENABLED_KEY = 'urlcade_audio_enabled';
let audioEnabled = false;
try{ audioEnabled = localStorage.getItem(AUDIO_ENABLED_KEY) === '1'; }catch(e){}

function isAudioEnabled(){ return audioEnabled; }
// The one place `setAudioEnabled(true)` gets called is the mute toggle's
// own click handler (main.js) — a guaranteed user gesture, satisfying
// browser autoplay policy for the `AudioContext` this constructs on
// first opt-in. Suspending/resuming the one shared context (rather than
// zeroing every voice's gain individually) mutes/unmutes every
// currently-playing sound on every cart at once, instantly, without
// disturbing any of their actual gain/frequency/waveform state — a
// toggle back on picks up exactly where a held note or an in-flight
// TRIGGER_VOICE decay left off, not a state a cart's own logic ever
// changed.
function setAudioEnabled(enabled){
  audioEnabled = enabled;
  try{ localStorage.setItem(AUDIO_ENABLED_KEY, enabled ? '1' : '0'); }catch(e){}
  if(enabled){
    if(!audioCtx) audioCtx = new (window.AudioContext||window.webkitAudioContext)();
    audioCtx.resume().catch(()=>{});
  } else if(audioCtx){
    audioCtx.suspend().catch(()=>{});
  }
}

// Memory caps (DESIGN.md §76) — a real bug backstop independent of
// anything network-related: spawnEntity() used to push onto
// this.entities completely unbounded, so a cart whose on_tick
// unconditionally SPAWNs would grow forever until the tab died. Sized
// off profiling all 9 example carts for 3600 frames (60s) under
// synthetic worst-case input (every button combo + a pointer drag),
// not picked out of the air — real worst observed peak across all of
// them was 2.65KB (race-car's collision particles). Two separate caps,
// not one shared budget, because they bound different failure modes and
// shouldn't compete with each other.
//
// 16KB for globals + every active entity's props (4 bytes/field,
// matching the f32 width ByteWriter already uses for the binary
// format) — ~6x that worst observed peak.
const STATE_BYTE_CAP = 16384;
// 1024 entries for the SETTILE tile-diff log — real usage across both
// shipped carts that call SETTILE at all tops out at 16 calls a full
// playthrough (cave-crawler's gold pickups); 1024 is >60x that, while
// still stopping a runaway SETTILE loop well short of diverging the
// full (worst-case 255x255) generated grid.
const TILE_DIFF_CAP = 1024;

class World {
  constructor(cart){
    this.cart = cart;
    this.entities = [];
    // Tile-diff log for SETTILE (DESIGN.md §76) — {x,y,tileId} per call,
    // in tile-grid coordinates, capped at TILE_DIFF_CAP. Not consulted
    // by anything yet (the actual rollback/resync machinery is a later
    // round) — exists now so the cap itself, and setTileAt's no-op past
    // it, can be real and tested today rather than retrofitted later.
    this.tileDiffLog = [];
    this.boxPool = []; // reused AABB scratch objects for collision detection, see getBoxInto()
    this.nextId = 1;
    this.globals = new Array(24).fill(0); // room to grow past the original 16 — LOADG/STOREG operands are already u8 (0-255), this was always just an array-size choice, not a format limit
    // Persistent storage (DESIGN.md §69) — same 24-slot shape as globals,
    // but backed by localStorage and keyed per-cart (hashCartBytes above)
    // so one cart's save data can't collide with another's, and editing a
    // cart at all (even a cosmetic change) starts it fresh rather than
    // risking a stale/incompatible save silently loading. Loaded here,
    // synchronously, before on_init runs below, so a cart can read a
    // persisted value on its very first tick.
    this.persist = new Array(24).fill(0);
    this.persistKey = null;
    // Sound (DESIGN.md §72/§73) — 4 persistent voices, index-addressed by
    // the SET_VOICE_*/TRIGGER_VOICE opcodes, one node graph per slot
    // built lazily on first touch (see _ensureVoice below) against the
    // one page-wide shared AudioContext (module-level `audioCtx`, not a
    // per-World field) — voices themselves are still per-World so a
    // fresh World's sounds don't fight over stale node state from a
    // previous play, but the underlying audio output and the site-wide
    // mute toggle only ever have one context to deal with. Nothing here
    // constructs that context at all while the toggle is off — see
    // `audioEnabled`/`setAudioEnabled` above the World class.
    this.voices = [null, null, null, null];
    try{
      this.persistKey = 'urlcade_persist_' + hashCartBytes(encodeCart(cart));
      const raw = localStorage.getItem(this.persistKey);
      if(raw){
        const saved = JSON.parse(raw);
        if(Array.isArray(saved)) for(let i=0;i<24 && i<saved.length;i++) this.persist[i] = +saved[i] || 0;
      }
    }catch(e){
      // localStorage can throw (private browsing, a sandboxed iframe,
      // quota already exceeded by something else on the origin) — same
      // "never let a storage failure break the game" posture as
      // savePersist() below. A cart that never manages to load or save
      // just always sees zeros, same as a first-ever play.
      this.persistKey = null;
    }
    this.rng = mulberry32(Math.imul(cart.rngSeed+1, 2654435761) >>> 0);
    this.input = 0;
    this.pointerX = 0; this.pointerY = 0; this.pointerDown = 0; // set once/frame by loop(), see LOAD_POINTER_* below
    // Scratch, refilled by runDrawHook() each render call — see DRAW_LINE.
    // Object *identity* is reused across frames (drawLine mutates an
    // existing pooled entry in place rather than pushing a fresh literal),
    // the same pool-not-allocate idiom boxPool above already uses for
    // collision AABBs. A renderKind:2 cart that draws a lot per frame
    // (Corridor's raycaster emits ~490 DRAW_LINE calls, 60 times a second)
    // would otherwise garbage a comparable number of short-lived objects
    // every single frame regardless of whether anything on screen is
    // actually changing — real, avoidable GC pressure on constrained
    // hardware. See DESIGN.md §55.
    this.drawCmds = [];
    this.drawCmdCount = 0;
    this.cartFault = false;
    this.cameraX = 0; this.cameraY = 0; // recomputed every render() via updateCamera()
    this.palette = generatePalette(cart);
    // cssColorToRGB resolves an hsl(...) string to [r,g,b] by creating a
    // throwaway <canvas> (a real DOM element, ~300x150px by default) and
    // reading its 2d context's resolved fillStyle back — fine to pay once
    // per palette entry (16, here), ruinous to pay per draw call. Found
    // while chasing a reported input-lag stutter in Corridor: its
    // raycaster's on_draw emits ~480-490 DRAW_LINE calls a frame, and
    // every one of them used to call cssColorToRGB fresh (via glDrawLine,
    // below) — on the order of 29,000 canvas creations a second, just to
    // re-derive the same 16 colors over and over. See DESIGN.md §57.
    this.paletteRGB = this.palette.map(c => cssColorToRGB(c));
    this.spriteCanvases = cart.sprites.map(s => this.buildBitmap(s, true));
    this.tileCanvases = cart.tiles.map(t => this.buildBitmap(t, false));
    // Same source canvases feed either renderer: Canvas2D blits them
    // directly, WebGL uploads them as textures once here. No duplicated
    // pixel-building logic between the two backends.
    if(USE_GL){
      this.glSpriteTextures = this.spriteCanvases.map(c => buildGLTexture(c));
      this.glTileTextures = this.tileCanvases.map(c => buildGLTexture(c));
    }
    this.map = null;
    if(cart.mapGenerator === 1) this.map = buildTrack(cart.track);
    else if(cart.mapGenerator === 2) this.map = buildCave(cart.cave, () => this.rng());
    else if(cart.mapGenerator === 3) this.map = buildPlatformLevel(cart.platform);
    // Tilemap authoring — shape layers (DESIGN.md §74). mapGenerator:0
    // has no grid at all today unless a shapes-only cart actually needs
    // one to stamp into; every other generator already has a grid by
    // this point, so mapShapes composites onto whatever's already there
    // rather than replacing it. Both are no-ops (this.map stays null,
    // or unchanged) for the 8 of 9 example carts that don't use this.
    else if(cart.mapGenerator === 0 && cart.mapShapes && cart.mapShapes.length) this.map = buildBlankMap(cart.blankMap);
    if(this.map && cart.mapShapes && cart.mapShapes.length) applyMapShapes(this.map.grid, cart.mapShapes);
    if(this.map){
      // Pre-render the static tilemap once at load instead of redrawing every
      // tile every frame. A CPU profile under random input (see README) found
      // this was issuing ~1120 GL draw calls/frame for the racer's map alone
      // (~67,000/sec at 60fps) for a grid that never changes after the
      // generator runs — one draw call for the whole map, from here on, in
      // both renderers, regardless of which generator produced it.
      const grid = this.map.grid;
      const mapCanvas = document.createElement('canvas');
      mapCanvas.width = grid[0].length * 8;
      mapCanvas.height = grid.length * 8;
      const mctx = mapCanvas.getContext('2d');
      for(let y=0;y<grid.length;y++){
        for(let x=0;x<grid[0].length;x++){
          mctx.drawImage(this.tileCanvases[grid[y][x]-1], x*8, y*8);
        }
      }
      this.mapCanvas = mapCanvas;
      if(USE_GL) this.glMapTexture = buildGLTexture(mapCanvas);
    }
    const self_ = this;
    this.ctxBase = {
      constants: cart.constants,
      globals: this.globals,
      world: this,
      findEntity: id => self_.entities.find(e => e.id===id && e.active),
      spawn: t => self_.spawnEntity(t),
      getTile: (x,y) => self_.getTileAt(x,y),
      // Cart-declared, not a hardcoded special case: only the racer needs a
      // visually-distinct tile (its start/finish line) to behave as a
      // different one physically. Defaults to identity for every other cart
      // (including the cave, whose own tile id 4 would otherwise have
      // collided with the racer's hardcoded "id 4 behaves like id 2" rule
      // that used to live here — found while adding a second map generator).
      tileSurface: t => (cart.tileSurfaceOverrides && cart.tileSurfaceOverrides[t] !== undefined) ? cart.tileSurfaceOverrides[t] : t,
      setTile: (x,y,tileId) => self_.setTileAt(x,y,tileId),
      getCheckpoint: i => (self_.map && self_.map.checkpoints[i]) || {x:0,y:0},
      rng: () => self_.rng(),
      playSound: id => self_.playSound(id),
      setVoiceFreq: (voice, freq) => self_.setVoiceFreq(voice, freq),
      setVoiceWave: (voice, wave) => self_.setVoiceWave(voice, wave),
      setVoiceGain: (voice, gain) => self_.setVoiceGain(voice, gain),
      triggerVoice: voice => self_.triggerVoice(voice),
      // DRAW_LINE's sink — only ever populated during a runDrawHook() call
      // (renderKind:2 entities, at render time), but harmless to have here
      // unconditionally: every other hook's bytecode simply never contains
      // a DRAW_LINE instruction, so this never gets called from them.
      // Reuses the pooled object already sitting at this slot from a
      // previous frame instead of pushing a fresh literal — see the
      // drawCmds field comment above.
      drawLine: (x1,y1,x2,y2,color) => {
        const i = self_.drawCmdCount++;
        let cmd = self_.drawCmds[i];
        if(!cmd){ cmd = {x1:0,y1:0,x2:0,y2:0,color:0}; self_.drawCmds[i] = cmd; }
        cmd.x1 = x1; cmd.y1 = y1; cmd.x2 = x2; cmd.y2 = y2; cmd.color = color;
      },
      loadPersist: idx => self_.persist[idx] ?? 0,
      storePersist: (idx, v) => { self_.persist[idx] = v; self_.savePersist(); },
    };
    // Reused across every hook call this session (self/a/b/input mutated in
    // place instead of Object.assign-ing a fresh object + copying the ~10
    // unchanging ctxBase fields every single invocation — up to ~7 hook
    // calls/tick * 60 ticks/sec). Safe because runHook only ever reads ctx
    // synchronously and never retains a reference past the call.
    this.ctxScratch = Object.assign({}, this.ctxBase, {self:null, a:null, b:null, input:0, pointerX:0, pointerY:0, pointerDown:0});
    this.runGlobalHook('on_init');
  }
  buildBitmap(asset, transparent){
    const off = document.createElement('canvas');
    off.width = asset.w; off.height = asset.h;
    const c = off.getContext('2d');
    const img = c.createImageData(asset.w, asset.h);
    // Sprites may be a shape list (kind 1) instead of raw pixels — expand
    // it into a flat index array here, at load time, from decoded cart
    // data. Tiles never have `kind` set, so this is a no-op for them.
    const pixels = asset.kind === 1 ? renderShapeList(asset.w, asset.h, asset.shapes) : asset.pixels;
    for(let i=0;i<asset.w*asset.h;i++){
      const idx = pixels[i];
      if(transparent && idx===0){ img.data[i*4+3]=0; continue; }
      const [r,g,b] = this.paletteRGB[idx] || [255,0,255];
      img.data[i*4]=r; img.data[i*4+1]=g; img.data[i*4+2]=b; img.data[i*4+3]=255;
    }
    c.putImageData(img,0,0);
    return off;
  }
  spawnEntity(typeId){
    const type = this.cart.entityTypes[typeId];
    // One extra prop beyond the author's own 8 + extFieldCount, always at
    // the very end — this entity's *current* assetIndex, defaulting to
    // its type's. Deliberately NOT one of the base-8 "reserved" slots
    // (props[6] looked free by grep, but doom-like.js already uses it —
    // `const ANGLEPROP = 6` — via a named JS constant, invisible to a
    // literal-text search for "STORE_SELF 6"; see DESIGN.md for the
    // regression this caused). Appending past extFieldCount instead is
    // safe by construction: it can't collide with any per-cart prop
    // convention, named or not, since it's always one past whatever the
    // author declared for themselves. See the three renderer call sites
    // below, which read this instead of type.assetIndex directly.
    // type.assetIndex is now only the spawn-time default, not a lifetime
    // constant; STORE_SELF (8 + extFieldCount) from a hook retargets
    // which sprite/tile-pair this one entity draws as, independent of
    // every other instance of its type.
    const assetIndexProp = 8 + type.extFieldCount;
    const propCount = assetIndexProp + 1;
    // 16KB state cap (DESIGN.md §76) — becomes a graceful no-op past the
    // ceiling, not a cart fault, the same posture a lost network peer
    // resimulating the same cap would need anyway. Returns exactly the
    // phantom shape kernel.js's own runHook doc comment already
    // documents as the minimum ctx.spawn() fallback ({id:0,props:[]}) —
    // id 0 is never a real entity's id (nextId starts at 1), so every
    // existing STOREE/findEntity call already treats a write through it
    // as a silent no-op with no VM change needed to make this safe.
    const currentBytes = this.globals.length*4 + this.entities.reduce((sum,e) => sum + e.props.length*4, 0);
    if(currentBytes + propCount*4 > STATE_BYTE_CAP) return {id:0, props:[]};
    const e = { id:this.nextId++, active:true, typeId, props:new Array(propCount).fill(0) };
    e.props[4] = typeId;
    e.props[7] = e.id;
    e.props[assetIndexProp] = type.assetIndex;
    this.entities.push(e);
    return e;
  }
  runGlobalHook(name){
    const bc = this.cart.hooks[name];
    const ctx = this.ctxScratch;
    ctx.self = null; ctx.a = null; ctx.b = null; ctx.input = this.input;
    ctx.pointerX = this.pointerX; ctx.pointerY = this.pointerY; ctx.pointerDown = this.pointerDown;
    return runHook(bc, ctx);
  }
  runEntityHook(name, entity){
    const bc = this.cart.hooks[name];
    const ctx = this.ctxScratch;
    ctx.self = entity; ctx.a = null; ctx.b = null; ctx.input = this.input;
    ctx.pointerX = this.pointerX; ctx.pointerY = this.pointerY; ctx.pointerDown = this.pointerDown;
    return runHook(bc, ctx);
  }
  runCollideHook(a,b){
    const bc = this.cart.hooks['on_collide'];
    const ctx = this.ctxScratch;
    ctx.self = null; ctx.a = a; ctx.b = b; ctx.input = this.input;
    ctx.pointerX = this.pointerX; ctx.pointerY = this.pointerY; ctx.pointerDown = this.pointerDown;
    return runHook(bc, ctx);
  }
  // Render-time, not tick-time (see HOOK_NAMES's own comment in kernel.js)
  // — called once per renderKind:2 entity per drawn frame, immediately
  // before the renderer consumes whatever it pushed into drawCmds via
  // DRAW_LINE. Presentation-only, like ilerp: nothing stops a cart from
  // writing to globals/props from on_draw, but doing so makes the
  // simulation's determinism depend on the display's actual frame rate —
  // spec/skill/references/hooks.md flags this as a footgun, not
  // something enforced here.
  runDrawHook(entity){
    // Reset the count, not the array — drawLine (see ctxBase above) reuses
    // whatever pooled object already sits at each index, so truncating the
    // backing array here would defeat the pooling by forcing every slot to
    // be reallocated on the very next drawLine call.
    this.drawCmdCount = 0;
    const bc = this.cart.hooks.on_draw;
    const ctx = this.ctxScratch;
    ctx.self = entity; ctx.a = null; ctx.b = null; ctx.input = this.input;
    ctx.pointerX = this.pointerX; ctx.pointerY = this.pointerY; ctx.pointerDown = this.pointerDown;
    runHook(bc, ctx);
    // Trim any stale entries left over from a previous, longer frame (e.g.
    // one more monster billboard was visible then than now) — cheap: this
    // only drops array *slots*, the pooled objects still below the new
    // length are untouched and stay reusable next frame.
    this.drawCmds.length = this.drawCmdCount;
    return this.drawCmds;
  }
  getTileAt(x,y){
    if(!this.map) return -1;
    const tx = Math.floor(x/8), ty = Math.floor(y/8);
    if(ty<0||ty>=this.map.grid.length||tx<0||tx>=this.map.grid[0].length) return MAP_EDGE_TILE;
    return this.map.grid[ty][tx];
  }
  // SETTILE's runtime half: mutates the generated grid and patches just the
  // one changed tile into the pre-rendered map (both the CPU-side canvas
  // and, if active, the GL texture) rather than undoing the single-draw-call
  // optimization above for a mutation that only happens a few times a game.
  setTileAt(x,y,tileId){
    if(!this.map) return;
    const tx = Math.floor(x/8), ty = Math.floor(y/8);
    if(ty<0||ty>=this.map.grid.length||tx<0||tx>=this.map.grid[0].length) return;
    // Tile-diff log cap (DESIGN.md §76) — becomes a no-op past the
    // ceiling rather than letting the live grid keep changing while the
    // log (the thing a future rollback resync would actually ship)
    // silently stops reflecting it.
    if(this.tileDiffLog.length >= TILE_DIFF_CAP) return;
    this.tileDiffLog.push({x:tx, y:ty, tileId});
    this.map.grid[ty][tx] = tileId;
    const mctx = this.mapCanvas.getContext('2d');
    mctx.drawImage(this.tileCanvases[tileId-1], tx*8, ty*8);
    if(USE_GL && this.glMapTexture){
      gl.bindTexture(gl.TEXTURE_2D, this.glMapTexture);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, this.mapCanvas);
    }
  }
  // Writes e's AABB into `out` instead of returning a fresh object. The
  // O(n²) pairwise collision scan below used to call the allocating
  // version twice per pair (via overlap()), recomputing and reallocating
  // the *same* entity's box once for every other entity it was compared
  // against — O(n²) allocations for what only needs O(n). Measured
  // negligible at the entity counts either cart actually reaches (a few
  // microseconds for ~10 entities), but it's real, avoidable churn in a
  // hot per-tick loop, found while checking whether collision was the
  // source of a reported stutter.
  getBoxInto(e, out){
    const type = this.cart.entityTypes[e.typeId];
    if(type.renderKind === 1){ // tile column
      const extent = Math.max(0, Math.floor(e.props[8]));
      out.x0 = e.props[0]; out.y0 = e.props[1];
      out.x1 = e.props[0] + 8; out.y1 = e.props[1] + extent*8;
    } else {
      const w = type.collisionW, h = type.collisionH;
      out.x0 = e.props[0]-w/2; out.y0 = e.props[1]-h/2;
      out.x1 = e.props[0]+w/2; out.y1 = e.props[1]+h/2;
    }
    return out;
  }
  playSound(id){
    if(!audioEnabled) return;
    try{
      if(!audioCtx) audioCtx = new (window.AudioContext||window.webkitAudioContext)();
      const ctx = audioCtx;
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.frequency.value = 220 + id*90;
      o.type = 'square';
      g.gain.value = 0.05;
      o.connect(g); g.connect(ctx.destination);
      o.start(); g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime+0.15);
      o.stop(ctx.currentTime+0.15);
    }catch(e){}
  }
  // Lazily builds voice `i`'s persistent node graph on first use — an
  // oscillator (sine/square/triangle, its `.type` swapped live rather than
  // rebuilt) and a looping white-noise buffer source, each gated through
  // its own gain into a shared `mainGain` that SET_VOICE_GAIN/
  // TRIGGER_VOICE actually control, then to the destination. Both sources
  // are started once and simply left running for the game's whole
  // lifetime (silent via gain 0 until selected) — swapping `.type` or a
  // gain value is real-time-safe on a running node, no stop/restart
  // needed, so "4 persistent voices" really does mean 4 nodes total per
  // voice, created once, not one per note.
  _ensureVoice(i){
    if(!audioEnabled) return null; // let the caller's own try/catch (below) treat this the same as any other audio failure — see setVoiceFreq/etc.
    if(this.voices[i]) return this.voices[i];
    if(!audioCtx) audioCtx = new (window.AudioContext||window.webkitAudioContext)();
    const ctx = audioCtx;
    if(!this._noiseBuffer){
      this._noiseBuffer = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
      const data = this._noiseBuffer.getChannelData(0);
      for(let j=0;j<data.length;j++) data[j] = Math.random()*2-1;
    }
    const osc = ctx.createOscillator();
    osc.type = 'square';
    osc.frequency.value = 440;
    const oscGain = ctx.createGain(); oscGain.gain.value = 1;
    const noiseSrc = ctx.createBufferSource();
    noiseSrc.buffer = this._noiseBuffer;
    noiseSrc.loop = true;
    const noiseGain = ctx.createGain(); noiseGain.gain.value = 0;
    const mainGain = ctx.createGain(); mainGain.gain.value = 0;
    osc.connect(oscGain); oscGain.connect(mainGain);
    noiseSrc.connect(noiseGain); noiseGain.connect(mainGain);
    mainGain.connect(ctx.destination);
    osc.start(); noiseSrc.start();
    const v = {osc, oscGain, noiseSrc, noiseGain, mainGain};
    this.voices[i] = v;
    return v;
  }
  setVoiceFreq(voice, freq){
    try{ this._ensureVoice(voice).osc.frequency.value = freq; }catch(e){}
  }
  // waveform: 0=square 1=triangle 2=noise 3=sine — see kernel.js's
  // SET_VOICE_WAVE comment. Noise and the oscillator share one mainGain,
  // so switching waveform just re-routes which source's own gain is open
  // (1) vs closed (0) rather than tearing down and rebuilding a node.
  setVoiceWave(voice, waveform){
    try{
      const v = this._ensureVoice(voice);
      if(waveform === 2){
        v.oscGain.gain.value = 0; v.noiseGain.gain.value = 1;
      } else {
        v.noiseGain.gain.value = 0; v.oscGain.gain.value = 1;
        v.osc.type = waveform===0 ? 'square' : waveform===1 ? 'triangle' : 'sine';
      }
    }catch(e){}
  }
  // Sustained volume for a held note/drone — cancels any TRIGGER_VOICE
  // decay ramp still in flight so a cart can interrupt a decaying hit with
  // a held note on the same voice without the two fighting over the gain
  // value.
  setVoiceGain(voice, gain){
    try{
      const v = this._ensureVoice(voice);
      // cancelScheduledValues, then a plain assignment rather than
      // setValueAtTime(gain, ctx.currentTime) — behaviorally the same
      // ("this value, right now"), but a direct AudioParam.value write is
      // guaranteed to read back synchronously; setValueAtTime schedules
      // an automation-timeline event that only takes effect once the
      // audio thread next processes a render quantum, which a caller
      // reading `.value` back immediately (a test, or another opcode
      // this same tick) can't rely on.
      v.mainGain.gain.cancelScheduledValues(audioCtx.currentTime);
      v.mainGain.gain.value = gain;
    }catch(e){}
  }
  // Fixed percussive envelope, same 0.05 peak / 150ms exponential decay
  // the old one-shot playSound() used — scoped to one persistent voice
  // instead of a throwaway node pair. cancelScheduledValues first so
  // re-triggering the same voice before its previous decay finishes
  // restarts cleanly instead of the two ramps stacking. The peak itself
  // is a plain assignment, not setValueAtTime — see setVoiceGain's
  // comment; exponentialRampToValueAtTime below still needs the
  // automation-timeline API since a ramp can't be expressed any other
  // way, but its implicit start point (current value, current time) is
  // exactly this synchronously-applied peak.
  triggerVoice(voice){
    try{
      const v = this._ensureVoice(voice);
      const ctx = audioCtx;
      const now = ctx.currentTime;
      v.mainGain.gain.cancelScheduledValues(now);
      v.mainGain.gain.value = 0.05;
      v.mainGain.gain.exponentialRampToValueAtTime(0.001, now+0.15);
    }catch(e){}
  }
  // Called on every STORE_PERSIST (ctxBase.storePersist above) — writes
  // are rare relative to ticks (a high score, an unlock flag, not a
  // per-frame value), so saving the whole 24-slot array immediately
  // rather than debouncing is simple and cheap enough. Silently a no-op
  // if the constructor never managed to establish a key (localStorage
  // unavailable) or a write fails now (quota exceeded) — same
  // never-let-storage-break-the-game posture as the constructor's own
  // load attempt.
  savePersist(){
    if(!this.persistKey) return;
    try{ localStorage.setItem(this.persistKey, JSON.stringify(this.persist)); }catch(e){}
  }
  step(){
    if(this.cartFault) return;
    // Snapshot pre-step state for render interpolation (§8 amendment) before
    // anything mutates it. Entities spawned *during* this step won't be
    // caught here (they don't exist yet) — they get a snapshot equal to
    // their own post-spawn state below, so they appear at the right place
    // immediately instead of interpolating in from stale/zeroed values.
    for(const e of this.entities) e.prevProps = e.props.slice();
    this.runGlobalHook('on_input');
    this.runGlobalHook('on_frame');
    for(const e of this.entities.slice()){ if(e.active) this.runEntityHook('on_tick', e); }
    this.entities = this.entities.filter(e=>e.active);
    // Compute each entity's AABB once (O(n)) into a reused pool, instead of
    // the old overlap()-calls-getBox()-twice-per-pair pattern, which recomputed
    // and reallocated the *same* entity's box once per other entity it was
    // checked against (O(n²) allocations for what only needs O(n) — see
    // getBoxInto's comment). The comparison itself stays O(n²), but it's now
    // four numeric comparisons on already-built boxes, no allocation at all.
    //
    // `n` is captured once, deliberately: on_collide can SPAWN (the racer's
    // collision particles do), which would otherwise grow entities.length
    // *during* this same pass. The old per-pair overlap() calls happened to
    // tolerate that silently (plain array indexing never goes out of bounds
    // on a growing array); the box pool is sized up front, so it can't. Fixing
    // it this way also gives more predictable behavior: an entity born mid-pass
    // joins collision detection next tick, not immediately in the tick it spawned.
    const n = this.entities.length;
    while(this.boxPool.length < n) this.boxPool.push({x0:0,y0:0,x1:0,y1:0});
    for(let i=0;i<n;i++) this.getBoxInto(this.entities[i], this.boxPool[i]);
    for(let i=0;i<n;i++){
      const A = this.boxPool[i];
      for(let j=i+1;j<n;j++){
        const B = this.boxPool[j];
        if(A.x0<B.x1 && A.x1>B.x0 && A.y0<B.y1 && A.y1>B.y0){
          this.runCollideHook(this.entities[i], this.entities[j]);
        }
      }
    }
    this.entities = this.entities.filter(e=>e.active);
    for(const e of this.entities) if(!e.prevProps) e.prevProps = e.props.slice();
  }
}


/* ============================================================
   12. UI wiring — menu, game loop, HUD, input
   ============================================================ */
const canvas = document.getElementById('screen');

/* ============================================================
   12a. GPU renderer (WebGL) — crisp pixel art, including under
   rotation. Canvas2D's ctx.rotate() always anti-aliases a rotated
   sprite's edges (the car); a fragment shader can sample its texture
   with NEAREST filtering at any angle, so pixel art stays crisp no
   matter the heading. Canvas2D remains the fallback renderer for any
   browser/context WebGL isn't available in — unchanged from before,
   see renderSceneCanvas/drawEntityCanvas below.
   ============================================================ */
let gl = null, ctx2d = null, USE_GL = false;
let glProgram = null, glUniforms = {}, glQuadBuffer = null;

function compileShader(type, src){
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if(!gl.getShaderParameter(sh, gl.COMPILE_STATUS)){
    console.warn('urlcade: GL shader compile failed', gl.getShaderInfoLog(sh));
    gl.deleteShader(sh);
    return null;
  }
  return sh;
}

function initGL(){
  let g;
  try{
    g = canvas.getContext('webgl2', {antialias:false, alpha:false}) ||
        canvas.getContext('webgl', {antialias:false, alpha:false});
  }catch(e){ g = null; }
  if(!g) return false;
  gl = g;

  const vs = compileShader(gl.VERTEX_SHADER, `
    attribute vec2 aUnit;      // unit quad corner, (0,0)..(1,1)
    uniform vec2 uScreenSize;  // cart's native pixel resolution
    uniform vec4 uDst;         // x, y, w, h — top-left + size, pixel space
    uniform float uRotation;   // radians, about the quad's own center
    varying vec2 vUV;
    void main(){
      vec2 local = (aUnit - 0.5) * uDst.zw;
      float c = cos(uRotation), s = sin(uRotation);
      vec2 rotated = vec2(local.x*c - local.y*s, local.x*s + local.y*c);
      vec2 center = uDst.xy + uDst.zw * 0.5;
      vec2 pixelPos = center + rotated;
      // pixel space is top-left origin, y-down (matches entity props);
      // clip space is center origin, y-up — flip here, once, for everyone.
      vec2 clip = vec2(
        pixelPos.x / uScreenSize.x * 2.0 - 1.0,
        1.0 - pixelPos.y / uScreenSize.y * 2.0
      );
      gl_Position = vec4(clip, 0.0, 1.0);
      vUV = aUnit;
    }
  `);
  const fs = compileShader(gl.FRAGMENT_SHADER, `
    precision mediump float;
    varying vec2 vUV;
    uniform sampler2D uTex;
    uniform vec4 uColor;
    uniform float uUseTex; // 1 = sample uTex (sprites/tiles), 0 = flat uColor (backdrop fills)
    void main(){
      if(uUseTex > 0.5){
        vec4 texel = texture2D(uTex, vUV);
        if(texel.a < 0.02) discard; // sprite transparency, see buildBitmap()
        gl_FragColor = texel;
      } else {
        gl_FragColor = uColor;
      }
    }
  `);
  if(!vs || !fs) return false;
  const prog = gl.createProgram();
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  if(!gl.getProgramParameter(prog, gl.LINK_STATUS)){
    console.warn('urlcade: GL program link failed', gl.getProgramInfoLog(prog));
    return false;
  }
  gl.useProgram(prog);
  glProgram = prog;

  glQuadBuffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, glQuadBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0,0, 1,0, 0,1, 1,1]), gl.STATIC_DRAW);
  const aUnit = gl.getAttribLocation(prog, 'aUnit');
  gl.enableVertexAttribArray(aUnit);
  gl.vertexAttribPointer(aUnit, 2, gl.FLOAT, false, 0, 0);

  glUniforms = {
    screenSize: gl.getUniformLocation(prog, 'uScreenSize'),
    dst: gl.getUniformLocation(prog, 'uDst'),
    rotation: gl.getUniformLocation(prog, 'uRotation'),
    color: gl.getUniformLocation(prog, 'uColor'),
    useTex: gl.getUniformLocation(prog, 'uUseTex'),
    tex: gl.getUniformLocation(prog, 'uTex'),
  };

  gl.enable(gl.BLEND);
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
  gl.disable(gl.DEPTH_TEST);

  // V0 scope cut, noted in the README: a lost GL context is not recovered
  // (that needs swapping in a fresh canvas element, since a canvas can't
  // switch context type once one's been requested). It's flagged loudly
  // rather than silently left blank.
  canvas.addEventListener('webglcontextlost', e => {
    e.preventDefault();
    console.warn('urlcade: WebGL context lost — this session will not recover it (V0 scope cut, see README); reload to resume.');
  });

  return true;
}

function buildGLTexture(sourceCanvas){
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, sourceCanvas);
  return tex;
}
function glDrawTexturedQuad(tex, x, y, w, h, rotationRad){
  gl.uniform4f(glUniforms.dst, x, y, w, h);
  gl.uniform1f(glUniforms.rotation, rotationRad || 0);
  gl.uniform1f(glUniforms.useTex, 1);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.uniform1i(glUniforms.tex, 0);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
}
function glDrawColorQuad(x, y, w, h, r, g, b, a, rotationRad){
  gl.uniform4f(glUniforms.dst, x, y, w, h);
  gl.uniform1f(glUniforms.rotation, rotationRad || 0);
  gl.uniform1f(glUniforms.useTex, 0);
  gl.uniform4f(glUniforms.color, r, g, b, a===undefined?1:a);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
}
function disposeGLTextures(w){
  if(!w || !gl) return;
  for(const t of w.glSpriteTextures || []) gl.deleteTexture(t);
  for(const t of w.glTileTextures || []) gl.deleteTexture(t);
  if(w.glMapTexture) gl.deleteTexture(w.glMapTexture);
}

USE_GL = initGL();
if(!USE_GL){ ctx2d = canvas.getContext('2d'); }

let world = null, currentKey = null, running = false, keysDown = new Set();
let touchBits = new Set();

function buttonMaskFromKeys(){
  let m = 0;
  if(keysDown.has('ArrowLeft')) m |= 1;
  if(keysDown.has('ArrowRight')) m |= 2;
  if(keysDown.has('ArrowUp')) m |= 4;
  if(keysDown.has('ArrowDown')) m |= 8;
  if(keysDown.has(' ')) m |= 16;
  for(const b of touchBits) m |= b;
  return m;
}
// keysDown is purely this module's own input-state implementation detail
// (buttonMaskFromKeys, above, is its only reader), so the listeners that
// populate it live here too rather than in main.js.
window.addEventListener('keydown', e=>{
  if(['ArrowLeft','ArrowRight','ArrowUp','ArrowDown',' '].includes(e.key)) e.preventDefault();
  keysDown.add(e.key);
});
window.addEventListener('keyup', e=>{ keysDown.delete(e.key); });

/* Touch controls — a small, fixed library of generic *shapes*, selected and
   labeled by what the cart declares (inputTouchTemplate / inputActiveButtons
   / inputButtonLabels), never looked up by cart identity. Held-button
   semantics throughout (TESTBIT reads every frame, not edge-triggered, so
   holding a touch button is exactly like holding a key) — see DESIGN.md §14. */
function buildTouchControlsHTML(cart){
  const label = bit => (cart.inputButtonLabels[bit] || '').toUpperCase();
  if(cart.inputTouchTemplate === TOUCH_TEMPLATE_SINGLE){
    const bit = BUTTON_BITS.find(b => cart.inputActiveButtons & b) ?? 16;
    return `<div class="side"></div><div class="side">
      <button type="button" class="touch-btn wide" data-bit="${bit}">&#9650; ${label(bit)}</button>
    </div>`;
  }
  if(cart.inputTouchTemplate === TOUCH_TEMPLATE_STEER_ACTION){
    return `<div class="side">
      <button type="button" class="touch-btn" data-bit="1" aria-label="Steer left">&#9664;</button>
      <button type="button" class="touch-btn" data-bit="2" aria-label="Steer right">&#9654;</button>
    </div><div class="side">
      <button type="button" class="touch-btn" data-bit="4">&#9650; ${label(4)}</button>
    </div>`;
  }
  if(cart.inputTouchTemplate === TOUCH_TEMPLATE_DPAD_ACTION){
    return `<div class="side">
      <button type="button" class="touch-btn" data-bit="1" aria-label="Left">&#9664;</button>
      <button type="button" class="touch-btn" data-bit="2" aria-label="Right">&#9654;</button>
      <button type="button" class="touch-btn" data-bit="4" aria-label="Up">&#9650;</button>
      <button type="button" class="touch-btn" data-bit="8" aria-label="Down">&#9660;</button>
    </div><div class="side">
      <button type="button" class="touch-btn" data-bit="16">${label(16)}</button>
    </div>`;
  }
  if(cart.inputTouchTemplate === TOUCH_TEMPLATE_DPAD_ONLY){
    return `<div class="side">
      <button type="button" class="touch-btn" data-bit="1" aria-label="Left">&#9664;</button>
      <button type="button" class="touch-btn" data-bit="2" aria-label="Right">&#9654;</button>
      <button type="button" class="touch-btn" data-bit="4" aria-label="Up">&#9650;</button>
      <button type="button" class="touch-btn" data-bit="8" aria-label="Down">&#9660;</button>
    </div><div class="side"></div>`;
  }
  return ''; // TOUCH_TEMPLATE_NONE
}
function setTouchBit(bit, on, el){
  if(on) touchBits.add(bit); else touchBits.delete(bit);
  if(el) el.classList.toggle('active', on);
}
function wireHoldButton(el){
  const bit = Number(el.dataset.bit);
  const press = e => { e.preventDefault(); setTouchBit(bit, true, el); };
  const release = () => setTouchBit(bit, false, el);
  el.addEventListener('pointerdown', press, {passive:false}); // explicit: this listener calls preventDefault()
  el.addEventListener('pointerup', release);
  el.addEventListener('pointercancel', release);
  el.addEventListener('pointerleave', release);
  el.addEventListener('contextmenu', e => e.preventDefault());
}
let canvasTapBit = null; // set by setupTouchControls(); non-null only under the single-action template
function setupTouchControls(cart){
  touchBits = new Set();
  const el = document.getElementById('touchControls');
  const html = buildTouchControlsHTML(cart);
  el.innerHTML = html;
  el.classList.toggle('active', !!html);
  el.querySelectorAll('.touch-btn').forEach(wireHoldButton);
  canvasTapBit = (cart.inputTouchTemplate === TOUCH_TEMPLATE_SINGLE)
    ? (BUTTON_BITS.find(b => cart.inputActiveButtons & b) ?? null)
    : null;
}
// Tap-and-hold anywhere on the canvas also presses whatever the single-action
// template's button is — a generic convention for that template's shape, not
// a Flappy-Bird-specific gesture; carts using other templates get nothing here.
(function wireCanvasTap(){
  const press = e => { if(canvasTapBit !== null){ e.preventDefault(); touchBits.add(canvasTapBit); } };
  const release = () => { if(canvasTapBit !== null) touchBits.delete(canvasTapBit); };
  canvas.addEventListener('pointerdown', press, {passive:false}); // explicit: this listener calls preventDefault()
  canvas.addEventListener('pointerup', release);
  canvas.addEventListener('pointercancel', release);
  canvas.addEventListener('pointerleave', release);
  canvas.addEventListener('contextmenu', e => e.preventDefault());
})();

/* Pointer input (DESIGN.md §36) — raw analog position/held-state for carts
   that declare inputWantsPointer, read via LOAD_POINTER_X/Y/DOWN in any
   hook. Tracked unconditionally (cheap, and every cart's canvas already
   gets pointer events for the tap gesture above) — module-scope, same
   pattern as keysDown/touchBits, copied onto world.pointerX/Y/Down once
   per loop() iteration rather than written directly from the event
   handler, so a hook always sees a value stable for the whole tick it
   runs in, the same guarantee buttonMaskFromKeys() already gives inputs. */
let pointerX = 0, pointerY = 0, pointerDown = 0;
// Canvas is CSS-scaled (object-fit:contain, letterboxed on a mismatched
// aspect — see #screen's own CSS) while its pixel buffer stays at the
// cart's native resolution; a raw clientX/Y needs both the letterbox
// offset and the uniform scale factor removed to land in cart-pixel space.
function pointerToCartCoords(e){
  const rect = canvas.getBoundingClientRect();
  const scale = Math.min(rect.width / canvas.width, rect.height / canvas.height);
  const dispW = canvas.width * scale, dispH = canvas.height * scale;
  const offX = rect.left + (rect.width - dispW) / 2, offY = rect.top + (rect.height - dispH) / 2;
  return { x: (e.clientX - offX) / scale, y: (e.clientY - offY) / scale };
}
(function wirePointerTracking(){
  const move = e => { const p = pointerToCartCoords(e); pointerX = p.x; pointerY = p.y; };
  const down = e => { move(e); pointerDown = 1; };
  const up = () => { pointerDown = 0; };
  canvas.addEventListener('pointerdown', down, {passive:true});
  canvas.addEventListener('pointermove', move, {passive:true});
  canvas.addEventListener('pointerup', up);
  canvas.addEventListener('pointercancel', up);
  canvas.addEventListener('pointerleave', up);
})();

function esc(s){ return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;'); }

// Auto-derived, not a manual per-cart index (DESIGN.md §34): scans every
// palette entry for the most "colorful" one (max-min across its RGB
// channels — cheap, and blind to which palette *mode* produced it) and
// uses that as the card's accent. Skips index 0 on purpose — convention
// across every generator/cart is an outline/background color there, and
// it's frequently black or otherwise a poor accent regardless of mode.
// Robust to curated-bank palettes padding unused slots with flat black
// (a fixed index like 8 or 15 would land on padding for some banks).
function deriveAccentColor(palette){
  let best = null, bestScore = -1;
  for(let i=1;i<palette.length;i++){
    const [r,g,b] = cssColorToRGB(palette[i]);
    const score = Math.max(r,g,b) - Math.min(r,g,b);
    if(score > bestScore){ bestScore = score; best = palette[i]; }
  }
  return best || palette[0] || '#e0a030';
}

// Renders a decoded cart's first frame (post on_init, no ticks run) to an
// offscreen Canvas2D — deliberately not the WebGL path renderSceneGL uses
// for actual play: a shelf full of live GL textures with no defined
// disposal point is exactly the "texture lifecycle complexity" not worth
// taking on for a static preview image. Builds (and immediately tears
// down) a real World purely to reuse its already-CPU-side sprite/tile/map
// canvases (buildBitmap never depends on which renderer is active) —
// disposeGLTextures() below cleans up whatever GL textures the shared
// USE_GL flag caused it to also build, same as inspector.js already does
// for its own throwaway/replaced Worlds.
function buildCardThumbnail(cart){
  const w = new World(cart);
  const off = document.createElement('canvas');
  off.width = cart.screenW; off.height = cart.screenH;
  const c = off.getContext('2d');
  // A cart with a scrolling camera (DESIGN.md §18) generates a map far
  // bigger than one screen, and its own spawn point can land anywhere in
  // that map — Race Car's own start sits well past x=160 on an 800px-plus-
  // wide track. Drawing at a fixed (0,0), the way this used to, only ever
  // showed the map's top-left corner, regardless of where actual play
  // starts; on a track whose corner is off in open grid, that's an empty
  // thumbnail with every car rendered off the right edge of the canvas,
  // since entity draws below used the same un-offset raw world position.
  // Mirrors updateCamera()'s own clamped "center on the followed entity"
  // math (DESIGN.md §36), just computed once here against this throwaway
  // World's post-on_init state instead of every render() against the live
  // one — a static preview needs exactly one camera position, not a
  // per-frame recompute.
  let camX = 0, camY = 0;
  const cam = cart.camera;
  if(cam && cam.followGlobal !== 255){
    const followed = w.entities.find(en => en.id === w.globals[cam.followGlobal]);
    if(followed){
      camX = Math.max(cam.clampMinX, Math.min(cam.clampMaxX, followed.props[0] - off.width/2));
      camY = Math.max(cam.clampMinY, Math.min(cam.clampMaxY, followed.props[1] - off.height/2));
    }
  }
  if(w.map){
    c.drawImage(w.mapCanvas, -camX, -camY);
  } else {
    c.fillStyle = w.palette[cart.backdropFillIndex] || '#222';
    c.fillRect(0, 0, off.width, off.height);
    if(cart.backdropGroundHeight > 0){
      c.fillStyle = w.palette[cart.backdropGroundIndex] || '#222';
      c.fillRect(0, off.height - cart.backdropGroundHeight, off.width, cart.backdropGroundHeight);
    }
  }
  for(const e of w.entities){
    const type = cart.entityTypes[e.typeId];
    const ex = e.props[0] - camX, ey = e.props[1] - camY;
    const assetIndex = Math.floor(e.props[8 + type.extFieldCount]); // spawn-time default from type.assetIndex, overridable per-entity — see spawnEntity()
    if(type.renderKind === 1){ // tile column
      const extent = Math.max(0, Math.floor(e.props[8]));
      const capAtTop = e.props[10] === 0;
      const bodyCanvas = w.tileCanvases[assetIndex];
      const capCanvas = w.tileCanvases[assetIndex+1];
      for(let row=0; row<extent; row++){
        const isCapRow = capAtTop ? row===0 : row===extent-1;
        c.drawImage(isCapRow?capCanvas:bodyCanvas, ex, ey+row*8);
      }
    } else if(type.renderKind === 2){ // custom draw — same on_draw path the live renderer uses
      strokeDrawCmds(c, ex, ey, w.palette, w.runDrawHook(e));
    } else {
      const spr = w.spriteCanvases[assetIndex];
      c.drawImage(spr, ex-spr.width/2, ey-spr.height/2);
    }
  }
  disposeGLTextures(w);
  return off;
}

// Takes a list of ready-to-play fragments (CARTS' own values — see
// carts/index.js) and decodes *each one*, same as any pasted link would
// be, to build its card: name/author from the fragment's own URL
// envelope (decodeCartUrl), thumbnail/accent from the cart it decodes to.
// Never reaches into an in-memory authored object — a shelf card is proof
// its fragment plays, not a claim about it (see carts/index.js's header).
async function renderMenu(){
  const list = document.getElementById('cartList');
  list.innerHTML = '';
  for(const key of Object.keys(CARTS)){
    const { fragment } = CARTS[key];
    const div = document.createElement('div');
    div.className = 'cart';
    try{
      const { name, author, payload } = decodeCartUrl(fragment);
      const cart = decodeCart(await decodePayloadToBytes(payload));
      const accent = deriveAccentColor(generatePalette(cart));
      div.style.setProperty('--cart-accent', accent);
      div.innerHTML = `
        <a class="cart-thumb-link" href="#${fragment}" aria-label="Play ${esc(name || 'this cart')}">
          <div class="cart-thumb-slot"></div>
        </a>
        <div class="cart-body">
          <h2>${esc(name) || '(untitled)'}</h2>
          <p class="cart-author">${author ? 'by ' + esc(author) : ''}</p>
          <a class="playbtn" href="#${fragment}">&#9654; PLAY</a>
        </div>`;
      const thumb = buildCardThumbnail(cart);
      thumb.className = 'cart-thumb';
      div.querySelector('.cart-thumb-slot').appendChild(thumb);
    } catch(err){
      div.innerHTML = `<div class="cart-body"><p class="compile-error">Could not decode "${esc(key)}": ${esc(err.message)}</p></div>`;
    }
    list.appendChild(div);
  }
}

// Sizing is pure CSS now (#screen { position:absolute; inset:0; object-fit:
// contain }) — the canvas fills the whole viewport edge-to-edge and the
// browser handles aspect-ratio fit on resize/orientation change for free.

// Takes a raw fragment payload — not a CARTS registry key. The original
// single-scope version only ever played a hash that matched one of the
// five shelf carts' *exact* precomputed payload string; any other
// validly-encoded cart fragment (e.g. one just compiled by /compile, or
// shared by a friend) silently fell through to the menu. That's exactly
// backwards for a self-serve authoring platform — a cart doesn't need to
// be checked into this repo's shelf to be playable, it just needs to
// decode. Returns false (instead of throwing) on a bad fragment, so
// main.js's boot() can fall back to the Inspector's error surfacing
// rather than duplicating decode-error messaging here.
async function startGame(fragment){
  let cart;
  try{
    cart = decodeCart(await decodePayloadToBytes(decodeCartUrl(fragment).payload));
  } catch(err){
    return false;
  }
  currentKey = fragment;
  document.getElementById('menu').classList.remove('active');
  const gw = document.getElementById('gameWrap');
  gw.classList.remove('active'); void gw.offsetWidth; gw.classList.add('active'); // restart the view-in animation
  document.getElementById('controlsText').textContent = describeControls(cart);
  document.getElementById('faultBanner').style.display = 'none';
  // canvas pixel buffer stays at native cart resolution; CSS (object-fit,
  // edge-to-edge sizing) does all the responsive scaling for free.
  canvas.width = cart.screenW;
  canvas.height = cart.screenH;
  disposeGLTextures(world); // free the previous cart's GPU textures, if any
  world = new World(cart);
  setupTouchControls(world.cart);
  running = true;
  lastTime = null;
  accumulator = 0;
  return true;
}

// Split from the original single backToMenu(): that function used to also
// reach into the Inspector's module-private state (inspectWorld,
// inspectCartInfo) directly, which only worked because everything lived
// in one script's shared scope. Now that the Inspector is its own module,
// main.js's boot()/goToMenu() composes this (stop the game) with
// inspector.js's closeInspector() (tear down the Inspector) instead —
// each module only ever touches its own state.
function stopGame(){
  running = false;
  disposeGLTextures(world);
  world = null;
  currentKey = null;
  touchBits = new Set();
  document.getElementById('gameWrap').classList.remove('active');
}
function showMenu(){
  const m = document.getElementById('menu');
  m.classList.remove('active'); void m.offsetWidth; m.classList.add('active');
}

// Lighter than stopGame(): hides the game view but keeps `world` (and its
// GL textures) alive instead of disposing them, so resumeGame() can pick
// back up instantly. This is what the in-game "Debug" button uses to open
// the Inspector on the cart that's currently playing — stopGame()'s full
// teardown would be the wrong tool there, since the point is coming back
// to the *same* running game, not ending it. (Debugging something else
// entirely — a pasted link, a fresh "+ New Cart" — still goes through the
// full stopGame(), same as before; see main.js's boot().)
function pauseGame(){
  running = false;
  document.getElementById('gameWrap').classList.remove('active');
}
function resumeGame(){
  if(!world) return false;
  const gw = document.getElementById('gameWrap');
  gw.classList.remove('active'); void gw.offsetWidth; gw.classList.add('active');
  running = true;
  lastTime = null; // avoid a stale huge dt from however long the game was paused
  return true;
}
function getCurrentFragment(){ return currentKey; }

// Linear-interpolate a prop between the last two simulation steps for
// smooth rendering at whatever rate the display refreshes, independent of
// the (fixed, deterministic) simulation rate — see DESIGN.md §8 amendment.
// This is presentation-only: nothing here feeds back into game state.
function ilerp(e, idx, alpha){
  const p = e.prevProps ? e.prevProps[idx] : e.props[idx];
  return p + (e.props[idx] - p) * alpha;
}
// Same, but shortest-path around the 0/360 wrap — for headings.
function ilerpAngle(e, idx, alpha){
  const p = e.prevProps ? e.prevProps[idx] : e.props[idx];
  const c = e.props[idx];
  const delta = ((c - p + 180) % 360 + 360) % 360 - 180;
  return p + delta * alpha;
}

// Camera: a fourth composable concept alongside backdrop/HUD/input-layout
// (DESIGN.md §15) — which entity a cart wants the view to follow (by global
// handle, 255 = none), clamped to declared bounds. Computed once per render
// from the interpolated (not raw-tick) followed position, so panning is as
// smooth as entity motion itself. Carts with no camera (followGlobal===255,
// the default) get cameraX/Y stuck at 0 — identical to pre-camera behavior.
function updateCamera(alpha){
  const cart = world.cart, cam = cart.camera;
  if(!cam || cam.followGlobal === 255){ world.cameraX = 0; world.cameraY = 0; return; }
  const id = world.globals[cam.followGlobal];
  const e = world.entities.find(en => en.id === id);
  if(!e){ world.cameraX = 0; world.cameraY = 0; return; }
  const x = ilerp(e, 0, alpha) - canvas.width/2;
  const y = ilerp(e, 1, alpha) - canvas.height/2;
  world.cameraX = Math.max(cam.clampMinX, Math.min(cam.clampMaxX, x));
  world.cameraY = Math.max(cam.clampMinY, Math.min(cam.clampMaxY, y));
}

// Shared by the live Canvas2D renderer (drawEntityCanvas, below) and the
// shelf's static thumbnail renderer (buildCardThumbnail, above) — both
// paint a World's drawCmds the same way, just at different (x,y) origins
// and against different <canvas> targets. Coordinates in cmds are
// entity-local (see kernel.js's DRAW_LINE comment); translating to (x,y)
// first is what makes on_draw's own bytecode never need to know about the
// camera or even its own position.
function strokeDrawCmds(targetCtx, x, y, palette, cmds){
  targetCtx.save();
  targetCtx.translate(x, y);
  for(const cmd of cmds){
    targetCtx.strokeStyle = palette[cmd.color] || '#fff';
    targetCtx.beginPath();
    targetCtx.moveTo(cmd.x1, cmd.y1);
    targetCtx.lineTo(cmd.x2, cmd.y2);
    targetCtx.stroke();
  }
  targetCtx.restore();
}

function drawEntityCanvas(e, alpha){
  const type = world.cart.entityTypes[e.typeId];
  const x = ilerp(e, 0, alpha) - world.cameraX, y = ilerp(e, 1, alpha) - world.cameraY;
  const assetIndex = Math.floor(e.props[8 + type.extFieldCount]); // spawn-time default from type.assetIndex, overridable per-entity — see spawnEntity()
  if(type.renderKind === 1){ // tile column — position interpolates, extent/cap don't (discrete, only change at spawn)
    const extent = Math.max(0, Math.floor(e.props[8]));
    const capAtTop = e.props[10] === 0;
    const bodyCanvas = world.tileCanvases[assetIndex];
    const capCanvas = world.tileCanvases[assetIndex+1];
    for(let row=0; row<extent; row++){
      const isCapRow = capAtTop ? row===0 : row===extent-1;
      ctx2d.drawImage(isCapRow?capCanvas:bodyCanvas, x, y+row*8);
    }
  } else if(type.renderKind === 2){ // custom draw — runs on_draw, then paints whatever it emitted
    strokeDrawCmds(ctx2d, x, y, world.palette, world.runDrawHook(e));
  } else {
    const spr = world.spriteCanvases[assetIndex];
    if(type.rotateFlag){
      ctx2d.save();
      ctx2d.translate(x, y);
      ctx2d.rotate(ilerpAngle(e, 8, alpha) * Math.PI/180);
      ctx2d.drawImage(spr, -spr.width/2, -spr.height/2);
      ctx2d.restore();
    } else {
      ctx2d.drawImage(spr, x-spr.width/2, y-spr.height/2);
    }
  }
}

// Backdrop generator (universal — used whenever there's no map-generated
// tilemap; if there is one, it simply covers the whole frame instead) and
// the HUD generator (a declared list of readouts) are both interpreted
// generically here. Nothing in this function branches on cart identity,
// cart_type, or which genre a cart happens to look like — see DESIGN.md §14.
// Two renderer backends share everything except the actual draw calls:
// the fixed-timestep loop, interpolation math (ilerp/ilerpAngle), and the
// HUD/backdrop/map *data* (declared by the cart, read generically) are
// backend-agnostic. Only "how do I put a textured rectangle on screen"
// differs — see initGL() below for why WebGL is preferred when available
// and exactly what Canvas2D can't do that motivated it.
function render(alpha){
  updateCamera(alpha);
  if(USE_GL) renderSceneGL(alpha); else renderSceneCanvas(alpha);
  renderHUD();
}

// Shared aim-line math for both renderers (§21 follow-up: an aiming
// mechanic with no visual feedback for its own angle/power reads as
// broken, not just unpolished). Returns null when there's nothing to
// draw (no aimLine declared, or its activeGlobal is falsy this frame —
// e.g. the destruction genre only wants this visible while still
// choosing an angle/charging, not once a shot is already in flight).
// Angle convention matches the destruction genre's own launch-velocity
// math (vx=cos(a)*power*scale, vy=-sin(a)*power*scale): the line points
// the same direction a shot fired right now actually would.
function computeAimLine(){
  const al = world.cart.aimLine;
  if(!al) return null;
  if(!world.globals[al.activeGlobal]) return null;
  const anchorX = world.globals[al.anchorXGlobal] - world.cameraX;
  const anchorY = world.globals[al.anchorYGlobal] - world.cameraY;
  const angleDeg = world.globals[al.angleGlobal];
  const power = world.globals[al.powerGlobal];
  const maxPower = world.cart.constants[al.maxPowerConstIdx] || 1;
  const length = Math.max(4, (power/maxPower) * al.maxLengthPx);
  const rot = -angleDeg * Math.PI/180;
  // Both forms precomputed here (not derived from each other per-frame):
  // Canvas2D wants the CSS string for fillStyle, WebGL wants [r,g,b] — see
  // the paletteRGB comment in the World constructor for why this avoids
  // cssColorToRGB's throwaway-canvas cost.
  return {
    anchorX, anchorY, length, rot,
    color: world.palette[al.colorIdx] || '#fff',
    colorRGB: world.paletteRGB[al.colorIdx] || [255,255,255],
  };
}
function renderSceneCanvas(alpha){
  const cart = world.cart;
  if(world.map){
    // Drawn at native size, offset by -camera: for cameraless carts (0,0)
    // this is pixel-identical to the old fixed (0,0) draw; for a level
    // wider than the viewport, Canvas2D clips to the canvas bounds for free.
    ctx2d.drawImage(world.mapCanvas, -world.cameraX, -world.cameraY);
  } else {
    ctx2d.fillStyle = world.palette[cart.backdropFillIndex] || '#222';
    ctx2d.fillRect(0, 0, canvas.width, canvas.height);
    if(cart.backdropGroundHeight > 0){
      ctx2d.fillStyle = world.palette[cart.backdropGroundIndex] || '#222';
      ctx2d.fillRect(0, canvas.height - cart.backdropGroundHeight, canvas.width, cart.backdropGroundHeight);
    }
  }
  for(const e of world.entities) drawEntityCanvas(e, alpha);
  const aim = computeAimLine();
  if(aim){
    ctx2d.save();
    ctx2d.translate(aim.anchorX, aim.anchorY);
    ctx2d.rotate(aim.rot);
    ctx2d.fillStyle = aim.color;
    ctx2d.fillRect(0, -1, aim.length, 2);
    ctx2d.restore();
  }
}

function renderSceneGL(alpha){
  const cart = world.cart;
  gl.viewport(0, 0, canvas.width, canvas.height);
  gl.uniform2f(glUniforms.screenSize, canvas.width, canvas.height);
  if(world.map){
    gl.clear(gl.COLOR_BUFFER_BIT);
    // pre-rendered once at load (see World constructor) — one draw call for
    // the whole map instead of one per tile, every frame. Drawn at the
    // map's own native pixel size (not stretched to canvas.width/height,
    // which only happened to be correct before because cameraless maps are
    // always exactly canvas-sized), offset by -camera; the GPU clips
    // anything outside the viewport automatically, same as Canvas2D.
    glDrawTexturedQuad(world.glMapTexture, -world.cameraX, -world.cameraY, world.mapCanvas.width, world.mapCanvas.height, 0);
  } else {
    const [br,bg,bb] = world.paletteRGB[cart.backdropFillIndex] || [34,34,34];
    gl.clearColor(br/255, bg/255, bb/255, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    if(cart.backdropGroundHeight > 0){
      const [gr,gg,gb] = world.paletteRGB[cart.backdropGroundIndex] || [34,34,34];
      glDrawColorQuad(0, canvas.height - cart.backdropGroundHeight, canvas.width, cart.backdropGroundHeight, gr/255, gg/255, gb/255, 1);
    }
  }
  for(const e of world.entities) drawEntityGL(e, alpha);
  const aim = computeAimLine();
  if(aim){
    const [ar,ag,ab] = aim.colorRGB;
    const cx = aim.anchorX + Math.cos(aim.rot)*(aim.length/2);
    const cy = aim.anchorY + Math.sin(aim.rot)*(aim.length/2);
    glDrawColorQuad(cx - aim.length/2, cy - 1, aim.length, 2, ar/255, ag/255, ab/255, 1, aim.rot);
  }
}

// A line is a degenerate rotated rect: reuses glDrawColorQuad exactly
// (center = the segment's midpoint, width = its length, height = a fixed
// thin stroke, rotation = its own angle) instead of a second shader/buffer
// just for immediate-mode drawing. glDrawColorQuad's (x,y) is the quad's
// top-left *before* rotation — since rotation happens about the center
// regardless (see initGL()'s vertex shader), top-left = center - (w,h)/2
// is all that's needed to land the quad centered on the line's midpoint.
const DRAW_LINE_THICKNESS_PX = 1.4;
function glDrawLine(x, y, paletteRGB, cmd){
  const dx = cmd.x2 - cmd.x1, dy = cmd.y2 - cmd.y1;
  const length = Math.max(0.75, Math.hypot(dx, dy)); // floor avoids a degenerate zero-length quad for a dot-like "line"
  const rot = Math.atan2(dy, dx);
  const mx = x + (cmd.x1 + cmd.x2) / 2, my = y + (cmd.y1 + cmd.y2) / 2;
  const [r,g,b] = paletteRGB[cmd.color] || [255,255,255];
  glDrawColorQuad(mx - length/2, my - DRAW_LINE_THICKNESS_PX/2, length, DRAW_LINE_THICKNESS_PX, r/255, g/255, b/255, 1, rot);
}

function drawEntityGL(e, alpha){
  const type = world.cart.entityTypes[e.typeId];
  const x = ilerp(e, 0, alpha) - world.cameraX, y = ilerp(e, 1, alpha) - world.cameraY;
  const assetIndex = Math.floor(e.props[8 + type.extFieldCount]); // spawn-time default from type.assetIndex, overridable per-entity — see spawnEntity()
  if(type.renderKind === 1){ // tile column
    const extent = Math.max(0, Math.floor(e.props[8]));
    const capAtTop = e.props[10] === 0;
    const bodyTex = world.glTileTextures[assetIndex];
    const capTex = world.glTileTextures[assetIndex+1];
    for(let row=0; row<extent; row++){
      const isCapRow = capAtTop ? row===0 : row===extent-1;
      glDrawTexturedQuad(isCapRow?capTex:bodyTex, x, y+row*8, 8, 8, 0);
    }
  } else if(type.renderKind === 2){ // custom draw — runs on_draw, then paints whatever it emitted
    for(const cmd of world.runDrawHook(e)) glDrawLine(x, y, world.paletteRGB, cmd);
  } else {
    const tex = world.glSpriteTextures[assetIndex];
    const src = world.spriteCanvases[assetIndex]; // dimensions only — same source as Canvas2D
    const rot = type.rotateFlag ? ilerpAngle(e, 8, alpha) * Math.PI/180 : 0;
    glDrawTexturedQuad(tex, x - src.width/2, y - src.height/2, src.width, src.height, rot);
  }
}

// Cached once — a random-input CPU profile (see README) found renderHUD as
// the single biggest actual JS hotspot in the whole game, ahead of rendering
// itself, because it called getElementById and wrote textContent/style.display
// unconditionally on every one of the 60 frames/sec even when nothing in the
// HUD had changed (which is most frames — the score/lap only updates a few
// times a minute). Both are fixed below: cache the elements, and skip the DOM
// write entirely when the computed value is identical to last frame's.
const hudEl = document.getElementById('hud');
const faultBannerEl = document.getElementById('faultBanner');
let lastHudText = null, lastFaultVisible = null;
function renderHUD(){
  const cart = world.cart;
  const parts = [];
  for(const line of cart.hudSpec){
    let raw;
    if(line.sourceKind === 0){ raw = world.globals[line.srcA] ?? 0; }
    else { const e = world.entities.find(en => en.id === world.globals[line.srcA]); raw = e ? e.props[line.srcB] : 0; }
    if(line.kind === 0){ // numeric readout, always shown
      let val = raw + (line.delta || 0);
      if(line.clamp && line.suffixConstIdx !== 255) val = Math.min(val, Math.round(cart.constants[line.suffixConstIdx]));
      let text = line.label + ': ' + val;
      if(line.suffixConstIdx !== 255) text += ' / ' + Math.round(cart.constants[line.suffixConstIdx]);
      parts.push(text);
    } else if(line.kind === 2){ // numeric, shown only while its source is non-zero
      if(raw) parts.push(line.label + (raw + (line.delta || 0)));
    } else if(raw){ // flag line: label only, shown only while its source is non-zero
      parts.push(line.label);
    }
  }
  const text = parts.join('   ');
  if(text !== lastHudText){ hudEl.textContent = text; lastHudText = text; }
  const faultVisible = world.cartFault ? 'block' : 'none';
  if(faultVisible !== lastFaultVisible){ faultBannerEl.style.display = faultVisible; lastFaultVisible = faultVisible; }
}

// Fixed-timestep simulation, decoupled from however fast the display
// refreshes (60/120/144Hz...) — see DESIGN.md §8 amendment. The old version
// stepped once per elapsed-33ms check and rendered whatever that left
// on screen, so most rAF frames just redrew the previous tick's positions
// unchanged: measured empirically, ~63% of frames were pixel-identical to
// the one before, which is exactly what reads as "choppy." Here, `world`
// always advances in fixed STEP_MS increments (any number of them per
// frame, to catch up if a frame ran long), and render() is handed `alpha`
// — how far into the *next*, not-yet-simulated tick we are — so motion is
// interpolated (see ilerp/ilerpAngle) smoothly at whatever rate rAF fires,
// while the simulation itself stays exactly as deterministic as before.
const STEP_MS = 1000/60;
// Capped low on purpose: if the main thread stalls for any reason (a
// backgrounded tab, or — what a reported touch-triggered stutter pointed
// at — a real device's touch-event/compositor overhead that a headless
// test can't reproduce), a bigger cap would "catch up" with a burst of
// several steps in one rendered frame. The frame(s) during the stall are
// dropped no matter what (the browser can't paint while blocked), but a
// smaller cap means the *next* frame corrects by a little rather than a
// lot — the game clock falls slightly behind wall-clock during a real
// stall instead of visibly snapping forward to catch up. Smoothness over
// perfect real-time accuracy is the right tradeoff for this game.
const MAX_ACCUMULATED_MS = STEP_MS * 2;
let lastTime = null;
let accumulator = 0;
function loop(ts){
  if(running && world){
    if(lastTime === null) lastTime = ts;
    accumulator = Math.min(accumulator + (ts - lastTime), MAX_ACCUMULATED_MS);
    lastTime = ts;
    world.input = buttonMaskFromKeys();
    world.pointerX = pointerX; world.pointerY = pointerY; world.pointerDown = pointerDown;
    while(accumulator >= STEP_MS){
      world.step();
      accumulator -= STEP_MS;
    }
    render(accumulator / STEP_MS);
  } else {
    lastTime = null; // avoid a stale huge dt when the next game starts
  }
  requestAnimationFrame(loop);
}

function getWorld(){ return world; }
function isUsingGL(){ return USE_GL; }
// Called once by main.js after the initial view (menu/game/inspector) is
// decided, same ordering as the original inline script's bottom-of-file
// IIFE — kept explicit rather than self-starting on import so module load
// order never implies "and now the game is ticking."
function startLoop(){ requestAnimationFrame(loop); }

export {
  World, disposeGLTextures, renderMenu, startGame, stopGame, showMenu,
  pauseGame, resumeGame, getCurrentFragment,
  render, getWorld, isUsingGL, startLoop,
  isAudioEnabled, setAudioEnabled,
};
