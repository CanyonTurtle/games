/* ============================================================
   The Urlcade — authoring kernel

   This file is a byte-for-byte extraction (not a re-implementation) of
   the parts of urlcade.html that define the cart format: the opcode
   table, the bytecode assembler, the lifecycle-hook VM interpreter, the
   binary cart encode/decode, and the URL-fragment transport (base64url
   + DEFLATE compression). It exists because urlcade.html itself is
   deliberately a single self-contained ~5000-line HTML file (runtime +
   UI + five dogfood carts all inlined, no build step, no server) — a
   good distribution format for *playing* a cart, a bad one for an
   agent or a script that needs to *read* the spec or *author* a cart
   without a browser. This file has no DOM/canvas/window dependency, so
   it runs identically under Node (`node -e "require('./kernel.js')"`)
   or any other JS host, with zero network access required — it is the
   whole spec, executable, not a description of the spec that might
   have drifted (see DESIGN.md, which explicitly documents that its own
   prose can lag the runtime).

   Sync policy: kept in sync with urlcade.html by copying, on purpose,
   not by import — urlcade.html stays a single self-contained file
   (that's a deliberate design property, not an oversight), so this
   can't be a shared module the runtime also loads. Any change to the
   binary format, the opcode table, or the VM in urlcade.html must be
   copied here too. `test/check-kernel-sync.js` diffs this file's output
   against urlcade.html's own (via Playwright — that half needs a real
   browser, since that's the only place urlcade.html's functions run;
   this file itself has no such dependency) for a battery of real carts,
   and fails loudly if they've drifted. Run it after touching either
   file. It's a maintainer/verification tool, not part of what ships to
   players — this file stays dependency-free either way.

   Usage:
     const K = require('./kernel.js');
     const bytes = K.encodeCart(cartObject);
     const roundTrip = K.decodeCart(bytes);
     const fragment = await K.encodePayload(bytes);       // "z.<base64url>" or "r.<base64url>"
     const bytesBack = await K.decodePayloadToBytes(fragment);
     const bytecode = K.assemble(['PUSHI 5', 'STOREG 0', 'HALT'], {constants:{}, globals:{}});

   See fixtures.md in this directory for known-good (cart -> exact
   bytes -> exact fragment) examples to check any of the above against,
   without needing to run this file at all.
   ============================================================ */
(function(root, factory){
  const kernel = factory();
  if(typeof module !== 'undefined' && module.exports) module.exports = kernel;
  else root.UrlcadeKernel = kernel;
})(typeof globalThis !== 'undefined' ? globalThis : this, function(){
"use strict";

/* ============================================================
   1. Opcode table (shared by assembler + VM) — see DESIGN.md §7
   ============================================================ */
const OPS = [
  ['NOP',[]],['PUSHI',['i16']],['PUSHC',['u8']],['DUP',[]],['POP',[]],['SWAP',[]],
  ['ADD',[]],['SUB',[]],['MUL',[]],['DIV',[]],['MOD',[]],['NEG',[]],
  ['CMPEQ',[]],['CMPNE',[]],['CMPLT',[]],['CMPLE',[]],['CMPGT',[]],['CMPGE',[]],
  ['AND',[]],['OR',[]],['NOT',[]],
  ['JMP',['addr']],['JZ',['addr']],['JNZ',['addr']],
  ['LOAD_SELF',['u8']],['STORE_SELF',['u8']],
  ['LOAD_A',['u8']],['LOAD_B',['u8']],['STORE_A',['u8']],['STORE_B',['u8']],
  ['LOADG',['u8']],['STOREG',['u8']],
  ['LOADE',['u8','u8']],['STOREE',['u8','u8']],
  ['RAND_RANGE',[]],['SIN',[]],['COS',[]],['ATAN2',[]],
  ['SPAWN',['u8']],['KILL_SELF',[]],
  ['GETTILE',[]],['TILE_SURFACE',[]],['GET_CHECKPOINT',[]],
  ['DIST',[]],['CLAMP_ABS',[]],['LERP',[]],['NORM_ANGLE',[]],
  ['TESTBIT',['u8']],['LOAD_INPUT',[]],['PLAYSOUND',['u8']],['HALT',[]],
  ['SETTILE',[]],
  ['MOVE_SOLID',[]],
];
const OPINDEX = {};
OPS.forEach((o,i)=>OPINDEX[o[0]]=i);

/* ============================================================
   2. Assembler — mnemonic source -> Uint8Array bytecode
   ============================================================ */
function assemble(lines, sym){
  sym = sym || {constants:{}, globals:{}};
  const cleaned = lines.map(l=>l.split(';')[0].trim()).filter(l=>l.length>0);
  const labelOffsets = {};
  const parsed = [];
  let offset = 0;
  function operandBytes(spec){ let n=0; for(const t of spec) n += (t==='u8')?1:2; return n; }
  for(const line of cleaned){
    if(line.endsWith(':')){ labelOffsets[line.slice(0,-1)] = offset; continue; }
    const parts = line.split(/\s+/);
    const mnem = parts[0];
    const args = parts.slice(1);
    if(!(mnem in OPINDEX)) throw new Error('assemble: unknown opcode "'+mnem+'" in line: '+line);
    const spec = OPS[OPINDEX[mnem]][1];
    parsed.push({mnem,args,spec,offset,line});
    offset += 1 + operandBytes(spec);
  }
  const buf = [];
  for(const instr of parsed){
    const opIdx = OPINDEX[instr.mnem];
    buf.push(opIdx);
    const spec = instr.spec;
    for(let i=0;i<spec.length;i++){
      const type = spec[i];
      const tok = instr.args[i];
      if(tok === undefined) throw new Error('assemble: missing operand for '+instr.mnem+' in line: '+instr.line);
      let val;
      if(type === 'addr'){
        if(!(tok in labelOffsets)) throw new Error('assemble: unknown label "'+tok+'" in line: '+instr.line);
        val = labelOffsets[tok];
      } else if(instr.mnem === 'PUSHC' && tok in sym.constants){
        val = sym.constants[tok];
      } else if((instr.mnem==='LOADG'||instr.mnem==='STOREG') && tok in sym.globals){
        val = sym.globals[tok];
      } else if((instr.mnem==='LOADE'||instr.mnem==='STOREE') && i===0 && tok in sym.globals){
        val = sym.globals[tok];
      } else {
        val = Number(tok);
        if(Number.isNaN(val)) throw new Error('assemble: bad operand "'+tok+'" for '+instr.mnem+' in line: '+instr.line);
      }
      if(type === 'u8'){ buf.push(val & 0xFF); }
      else { let v = val; if(v<0) v = 0x10000+v; buf.push(v & 0xFF, (v>>8)&0xFF); }
    }
  }
  return new Uint8Array(buf);
}

/* ============================================================
   3. The lifecycle-hook VM — stack machine, see DESIGN.md §7

   `ctx` is a plain object the caller builds; nothing here reaches for
   a browser global. Minimum shape to run a hook that touches only the
   stack/globals (no self/a/b, no entities, no tilemap):
     { constants:[], globals:[], self:null, a:null, b:null, input:0,
       world:{cartFault:false}, findEntity:()=>null, spawn:()=>({id:0,props:[]}),
       getTile:()=>0, tileSurface:()=>0, getCheckpoint:()=>({x:0,y:0}),
       rng:Math.random, playSound:()=>{}, setTile:()=>{} }
   ============================================================ */
const MAX_STEPS = 20000;
const vmStack = [];
function runHook(bytecode, ctx){
  if(!bytecode || bytecode.length===0) return true;
  const stack = vmStack;
  stack.length = 0;
  let ip = 0, steps = 0;
  function u8(){ return bytecode[ip++]; }
  function i16(){ const lo=bytecode[ip++], hi=bytecode[ip++]; let v=lo|(hi<<8); if(v & 0x8000) v -= 0x10000; return v; }
  function u16(){ const lo=bytecode[ip++], hi=bytecode[ip++]; return lo|(hi<<8); }
  while(ip < bytecode.length){
    if(++steps > MAX_STEPS){ ctx.world.cartFault = true; return false; }
    const op = bytecode[ip++];
    switch(op){
      case 0: break; // NOP
      case 1: stack.push(i16()); break; // PUSHI
      case 2: stack.push(ctx.constants[u8()] ?? 0); break; // PUSHC
      case 3: stack.push(stack[stack.length-1]); break; // DUP
      case 4: stack.pop(); break; // POP
      case 5: { const b=stack.pop(), a=stack.pop(); stack.push(b); stack.push(a); break; } // SWAP
      case 6: { const b=stack.pop(), a=stack.pop(); stack.push(a+b); break; }
      case 7: { const b=stack.pop(), a=stack.pop(); stack.push(a-b); break; }
      case 8: { const b=stack.pop(), a=stack.pop(); stack.push(a*b); break; }
      case 9: { const b=stack.pop(), a=stack.pop(); stack.push(b!==0 ? a/b : 0); break; }
      case 10:{ const b=stack.pop(), a=stack.pop(); stack.push(b!==0 ? a-Math.floor(a/b)*b : 0); break; }
      case 11:{ const a=stack.pop(); stack.push(-a); break; }
      case 12:{ const b=stack.pop(), a=stack.pop(); stack.push(a===b?1:0); break; }
      case 13:{ const b=stack.pop(), a=stack.pop(); stack.push(a!==b?1:0); break; }
      case 14:{ const b=stack.pop(), a=stack.pop(); stack.push(a<b?1:0); break; }
      case 15:{ const b=stack.pop(), a=stack.pop(); stack.push(a<=b?1:0); break; }
      case 16:{ const b=stack.pop(), a=stack.pop(); stack.push(a>b?1:0); break; }
      case 17:{ const b=stack.pop(), a=stack.pop(); stack.push(a>=b?1:0); break; }
      case 18:{ const b=stack.pop(), a=stack.pop(); stack.push((a&&b)?1:0); break; }
      case 19:{ const b=stack.pop(), a=stack.pop(); stack.push((a||b)?1:0); break; }
      case 20:{ const a=stack.pop(); stack.push(a?0:1); break; }
      case 21: ip = u16(); break; // JMP
      case 22: { const t=u16(); const v=stack.pop(); if(v===0) ip=t; break; } // JZ
      case 23: { const t=u16(); const v=stack.pop(); if(v!==0) ip=t; break; } // JNZ
      case 24: { const idx=u8(); stack.push(ctx.self ? ctx.self.props[idx] : 0); break; }
      case 25: { const idx=u8(); const v=stack.pop(); if(ctx.self) ctx.self.props[idx]=v; break; }
      case 26: { const idx=u8(); stack.push(ctx.a ? ctx.a.props[idx] : 0); break; }
      case 27: { const idx=u8(); stack.push(ctx.b ? ctx.b.props[idx] : 0); break; }
      case 28: { const idx=u8(); const v=stack.pop(); if(ctx.a) ctx.a.props[idx]=v; break; }
      case 29: { const idx=u8(); const v=stack.pop(); if(ctx.b) ctx.b.props[idx]=v; break; }
      case 30: { const idx=u8(); stack.push(ctx.globals[idx] ?? 0); break; }
      case 31: { const idx=u8(); const v=stack.pop(); ctx.globals[idx]=v; break; }
      case 32: { const hg=u8(), prop=u8(); const id=ctx.globals[hg]; const e=ctx.findEntity(id); stack.push(e?e.props[prop]:0); break; }
      case 33: { const hg=u8(), prop=u8(); const v=stack.pop(); const id=ctx.globals[hg]; const e=ctx.findEntity(id); if(e) e.props[prop]=v; break; }
      case 34: { const b=stack.pop(), a=stack.pop(); stack.push(a+Math.floor(ctx.rng()*(b-a))); break; } // RAND_RANGE
      case 35: { const a=stack.pop(); stack.push(Math.sin(a*Math.PI/180)); break; }
      case 36: { const a=stack.pop(); stack.push(Math.cos(a*Math.PI/180)); break; }
      case 37: { const b=stack.pop(), a=stack.pop(); stack.push(Math.atan2(b,a)*180/Math.PI); break; } // a=dx,b=dy
      case 38: { const t=u8(); const e=ctx.spawn(t); stack.push(e.id); break; }
      case 39: { if(ctx.self) ctx.self.active=false; break; }
      case 40: { const y=stack.pop(), x=stack.pop(); stack.push(ctx.getTile(x,y)); break; }
      case 41: { const t=stack.pop(); stack.push(ctx.tileSurface(t)); break; }
      case 42: { const idx=stack.pop(); const cp=ctx.getCheckpoint(idx); stack.push(cp.x); stack.push(cp.y); break; }
      case 43: { const y2=stack.pop(), x2=stack.pop(), y1=stack.pop(), x1=stack.pop(); stack.push(Math.hypot(x2-x1,y2-y1)); break; }
      case 44: { const limit=stack.pop(), v=stack.pop(); stack.push(Math.max(-limit,Math.min(limit,v))); break; }
      case 45: { const t=stack.pop(), b=stack.pop(), a=stack.pop(); stack.push(a+(b-a)*t); break; }
      case 46: { const a=stack.pop(); stack.push(((a+180)%360+360)%360-180); break; }
      case 47: { const bit=u8(); const mask=stack.pop(); stack.push((mask>>bit)&1); break; }
      case 48: { stack.push(ctx.input||0); break; }
      case 49: { const id=u8(); if(ctx.playSound) ctx.playSound(id); break; }
      case 50: return true; // HALT
      case 51: { const tileId=stack.pop(), y=stack.pop(), x=stack.pop(); ctx.setTile(x,y,tileId); break; } // SETTILE
      case 52: { // MOVE_SOLID — axis-separated tile collision, see DESIGN.md §15/§16
        const e = ctx.self;
        if(e){
          const type = ctx.world.cart.entityTypes[e.typeId];
          const hw = type.collisionW/2, hh = type.collisionH/2;
          const solidAt = (px,py) => ctx.tileSurface(ctx.getTile(px,py)) !== 0;
          let nx = e.props[0] + e.props[2];
          if(e.props[2] !== 0){
            const dir = e.props[2] > 0 ? 1 : -1;
            const edgeX = nx + dir*hw;
            if(solidAt(edgeX, e.props[1]-hh+1) || solidAt(edgeX, e.props[1]+hh-1)){
              const tileX = Math.floor(edgeX/8);
              nx = dir>0 ? tileX*8 - hw : (tileX+1)*8 + hw;
              e.props[2] = 0;
            }
          }
          e.props[0] = nx;
          let ny = e.props[1] + e.props[3];
          if(e.props[3] !== 0){
            const dir = e.props[3] > 0 ? 1 : -1;
            const edgeY = ny + dir*hh;
            if(solidAt(e.props[0]-hw+1, edgeY) || solidAt(e.props[0]+hw-1, edgeY)){
              const tileY = Math.floor(edgeY/8);
              ny = dir>0 ? tileY*8 - hh : (tileY+1)*8 + hh;
              e.props[3] = 0;
            }
          }
          e.props[1] = ny;
        }
        break;
      }
      default: throw new Error('runHook: unknown opcode '+op+' at ip '+(ip-1));
    }
  }
  return true;
}

/* ============================================================
   4. base64url + compression transport (DESIGN.md §2/§3, §25)
   ============================================================ */
function b64urlEncode(bytes){
  let bin = '';
  for(let i=0;i<bytes.length;i++) bin += String.fromCharCode(bytes[i]);
  const b64 = (typeof btoa !== 'undefined') ? btoa(bin) : Buffer.from(bin, 'binary').toString('base64');
  return b64.replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
}
function b64urlDecode(str){
  str = str.replace(/-/g,'+').replace(/_/g,'/');
  while(str.length % 4) str += '=';
  const bin = (typeof atob !== 'undefined') ? atob(str) : Buffer.from(str, 'base64').toString('binary');
  const bytes = new Uint8Array(bin.length);
  for(let i=0;i<bin.length;i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

// CompressionStream/DecompressionStream are native globals in both
// evergreen browsers and Node 18+ — no polyfill, no network fetch to
// obtain them, works the same in a sandboxed/offline environment.
const HAS_COMPRESSION = typeof CompressionStream !== 'undefined' && typeof DecompressionStream !== 'undefined';
async function runThroughStream(streamCtor, format, bytes){
  const stream = new streamCtor(format);
  const writer = stream.writable.getWriter();
  writer.write(bytes);
  writer.close();
  const chunks = [];
  let total = 0;
  const reader = stream.readable.getReader();
  for(;;){
    const {done, value} = await reader.read();
    if(done) break;
    chunks.push(value);
    total += value.length;
  }
  const out = new Uint8Array(total);
  let off = 0;
  for(const c of chunks){ out.set(c, off); off += c.length; }
  return out;
}
async function deflateRawCompress(bytes){ return runThroughStream(CompressionStream, 'deflate-raw', bytes); }
async function deflateRawDecompress(bytes){ return runThroughStream(DecompressionStream, 'deflate-raw', bytes); }

async function encodePayload(bytes){
  const raw = 'r.' + b64urlEncode(bytes);
  if(!HAS_COMPRESSION) return raw;
  const compressed = 'z.' + b64urlEncode(await deflateRawCompress(bytes));
  return compressed.length < raw.length ? compressed : raw;
}
async function decodePayloadToBytes(str){
  if(str.startsWith('z.')) return deflateRawDecompress(b64urlDecode(str.slice(2)));
  if(str.startsWith('r.')) return b64urlDecode(str.slice(2));
  return b64urlDecode(str); // untagged: legacy raw fragment
}

/* ============================================================
   5. Cart binary format (byte-aligned V0 simplification of
      DESIGN.md §4 — see url-console/v0/README.md for what this
      cuts relative to the full nibble-packed spec)
   ============================================================ */
class ByteWriter {
  constructor(){ this.bytes = []; }
  u8(v){ this.bytes.push(v & 0xFF); }
  u16(v){ this.bytes.push(v & 0xFF, (v>>8) & 0xFF); }
  f32(v){ const b = new Uint8Array(4); new DataView(b.buffer).setFloat32(0, v, true); this.bytes.push(...b); }
  bytesRaw(arr){ for(const x of arr) this.bytes.push(x & 0xFF); }
  toUint8Array(){ return new Uint8Array(this.bytes); }
}
class ByteReader {
  constructor(bytes){ this.bytes = bytes; this.p = 0; }
  u8(){ return this.bytes[this.p++]; }
  u16(){ const lo=this.bytes[this.p++], hi=this.bytes[this.p++]; return lo|(hi<<8); }
  f32(){ const b = this.bytes.slice(this.p, this.p+4); this.p += 4; return new DataView(b.buffer).getFloat32(0, true); }
  bytesN(n){ const r = this.bytes.slice(this.p, this.p+n); this.p += n; return r; }
}

const HOOK_NAMES = ['on_init','on_frame','on_tick','on_input','on_collide'];

// Button bit convention, fixed and universal (not genre- or cart-specific):
// 1=left 2=right 4=up/primary 8=down/secondary 16=action. A cart declares
// which of these it actually reads (inputActiveButtons) and which touch
// *shape* fits it (inputTouchTemplate) — see DESIGN.md §14.
const TOUCH_TEMPLATE_NONE=0, TOUCH_TEMPLATE_SINGLE=1, TOUCH_TEMPLATE_STEER_ACTION=2, TOUCH_TEMPLATE_DPAD_ACTION=3, TOUCH_TEMPLATE_DPAD_ONLY=4;
const BUTTON_BITS = [1,2,4,8,16];

const SHAPE_ELLIPSE = 0, SHAPE_RECT = 1;

// ASCII-only, one byte per character (V0 scope cut, see README) — a
// non-ASCII char here silently truncates to charCode & 0xFF on encode.
function writeString(w, s){ w.u8(s.length); for(let i=0;i<s.length;i++) w.u8(s.charCodeAt(i)); }
function readString(r){ const n = r.u8(); let s=''; for(let i=0;i<n;i++) s += String.fromCharCode(r.u8()); return s; }

function encodeCart(cart){
  const w = new ByteWriter();
  w.u8(cart.formatVersion);
  w.u8(cart.cartType); // advisory/display metadata only — never a runtime dispatch key, see DESIGN.md §14
  w.u8(cart.paletteMode);
  w.u8(cart.rngSeed);
  w.u8(cart.modeFlags);
  w.u16(cart.screenW);
  w.u16(cart.screenH);
  const pp = cart.paletteParams.slice(0,8); while(pp.length<8) pp.push(0);
  w.bytesRaw(pp);

  w.u8(cart.backdropFillIndex);
  w.u8(cart.backdropGroundHeight);
  w.u8(cart.backdropGroundIndex);

  const tso = cart.tileSurfaceOverrides ? Object.entries(cart.tileSurfaceOverrides) : [];
  w.u8(tso.length);
  for(const [k,v] of tso){ w.u8(+k); w.u8(+v); }

  w.u8(cart.inputActiveButtons);
  w.u8(cart.inputTouchTemplate);
  for(const bit of BUTTON_BITS){
    if(cart.inputActiveButtons & bit) writeString(w, cart.inputButtonLabels[bit] || '');
  }

  w.u8(cart.hudSpec.length);
  for(const line of cart.hudSpec){
    w.u8(line.kind);
    w.u8(line.sourceKind);
    w.u8(line.srcA);
    w.u8(line.srcB);
    w.u8(line.delta || 0);
    w.u8(line.suffixConstIdx === undefined ? 255 : line.suffixConstIdx);
    w.u8(line.clamp ? 1 : 0);
    writeString(w, line.label || '');
  }

  w.u8(cart.constants.length);
  for(const c of cart.constants) w.f32(c);
  w.u8(cart.entityTypes.length);
  for(const t of cart.entityTypes){
    w.u8(t.renderKind); w.u8(t.assetIndex); w.u8(t.rotateFlag);
    w.u8(t.collisionW); w.u8(t.collisionH); w.u8(t.extFieldCount);
  }
  w.u8(cart.sprites.length);
  for(const s of cart.sprites){
    w.u8(s.kind === 1 ? 1 : 0);
    w.u8(s.w); w.u8(s.h);
    if(s.kind === 1){
      w.u8(s.shapes.length);
      for(const sh of s.shapes){
        w.u8(sh.type);
        const p = sh.type === SHAPE_ELLIPSE ? [sh.cx,sh.cy,sh.rx,sh.ry] : [sh.x,sh.y,sh.w,sh.h];
        for(const v of p) w.u8(Math.round(v*8) & 0xFF); // fixed-point, 1/8px
        w.u8(sh.color);
      }
    } else {
      w.bytesRaw(s.pixels);
    }
  }
  w.u8(cart.tiles.length);
  for(const t of cart.tiles){ w.u8(t.w); w.u8(t.h); w.bytesRaw(t.pixels); }

  w.u8(cart.mapGenerator);
  if(cart.mapGenerator === 1){
    const track = cart.track;
    w.u8(track.tokens.length);
    w.bytesRaw(track.tokens);
    w.u8(track.trackWidth);
    w.u8(track.segLen);
    w.u8(track.startGX); w.u8(track.startGY); w.u8(track.startDir);
    w.u8(track.gridW); w.u8(track.gridH);
  } else if(cart.mapGenerator === 2){
    const cave = cart.cave;
    w.u8(cave.gridW); w.u8(cave.gridH);
    w.u8(cave.fillProb); w.u8(cave.iterations); w.u8(cave.wallThreshold);
    w.u8(cave.goldCount);
  } else if(cart.mapGenerator === 3){
    const p = cart.platform;
    w.u8(p.gridH);
    w.u8(p.startGroundY); w.u8(p.minGroundY); w.u8(p.maxGroundY);
    w.u8(p.tokens.length);
    w.bytesRaw(p.tokens);
  }

  const cam = cart.camera || {followGlobal:255, clampMinX:0, clampMinY:0, clampMaxX:0, clampMaxY:0};
  w.u8(cam.followGlobal);
  w.u16(cam.clampMinX); w.u16(cam.clampMinY);
  w.u16(cam.clampMaxX); w.u16(cam.clampMaxY);

  if(cart.aimLine){
    w.u8(1);
    const al = cart.aimLine;
    w.u8(al.anchorXGlobal); w.u8(al.anchorYGlobal);
    w.u8(al.angleGlobal); w.u8(al.powerGlobal);
    w.u8(al.maxPowerConstIdx); w.u8(al.activeGlobal);
    w.u8(al.colorIdx); w.u8(al.maxLengthPx);
  } else {
    w.u8(0);
  }

  for(const name of HOOK_NAMES){
    const bc = cart.hooks[name] || new Uint8Array(0);
    w.u16(bc.length);
    w.bytesRaw(bc);
  }
  return w.toUint8Array();
}

function decodeCart(bytes){
  const r = new ByteReader(bytes);
  const cart = {};
  cart.formatVersion = r.u8();
  cart.cartType = r.u8();
  cart.paletteMode = r.u8();
  cart.rngSeed = r.u8();
  cart.modeFlags = r.u8();
  cart.screenW = r.u16();
  cart.screenH = r.u16();
  cart.paletteParams = Array.from(r.bytesN(8));

  cart.backdropFillIndex = r.u8();
  cart.backdropGroundHeight = r.u8();
  cart.backdropGroundIndex = r.u8();

  const tsoCount = r.u8();
  cart.tileSurfaceOverrides = {};
  for(let i=0;i<tsoCount;i++){ const k=r.u8(); const v=r.u8(); cart.tileSurfaceOverrides[k]=v; }

  cart.inputActiveButtons = r.u8();
  cart.inputTouchTemplate = r.u8();
  cart.inputButtonLabels = {};
  for(const bit of BUTTON_BITS){
    if(cart.inputActiveButtons & bit) cart.inputButtonLabels[bit] = readString(r);
  }

  const hudCount = r.u8();
  cart.hudSpec = [];
  for(let i=0;i<hudCount;i++){
    cart.hudSpec.push({
      kind: r.u8(), sourceKind: r.u8(), srcA: r.u8(), srcB: r.u8(),
      delta: r.u8(), suffixConstIdx: r.u8(), clamp: r.u8(), label: readString(r),
    });
  }

  const constCount = r.u8();
  cart.constants = [];
  for(let i=0;i<constCount;i++) cart.constants.push(r.f32());
  const typeCount = r.u8();
  cart.entityTypes = [];
  for(let i=0;i<typeCount;i++){
    cart.entityTypes.push({
      renderKind: r.u8(), assetIndex: r.u8(), rotateFlag: r.u8(),
      collisionW: r.u8(), collisionH: r.u8(), extFieldCount: r.u8(),
    });
  }
  const spriteCount = r.u8();
  cart.sprites = [];
  for(let i=0;i<spriteCount;i++){
    const kind = r.u8();
    const w_ = r.u8(), h_ = r.u8();
    if(kind === 1){
      const shapeCount = r.u8();
      const shapes = [];
      for(let k=0;k<shapeCount;k++){
        const type = r.u8();
        const p = [r.u8()/8, r.u8()/8, r.u8()/8, r.u8()/8];
        const color = r.u8();
        shapes.push(type === SHAPE_ELLIPSE
          ? {type, cx:p[0], cy:p[1], rx:p[2], ry:p[3], color}
          : {type, x:p[0], y:p[1], w:p[2], h:p[3], color});
      }
      cart.sprites.push({kind:1, w:w_, h:h_, shapes});
    } else {
      cart.sprites.push({kind:0, w:w_, h:h_, pixels: Array.from(r.bytesN(w_*h_))});
    }
  }
  const tileCount = r.u8();
  cart.tiles = [];
  for(let i=0;i<tileCount;i++){
    const w_ = r.u8(), h_ = r.u8();
    cart.tiles.push({w:w_, h:h_, pixels: Array.from(r.bytesN(w_*h_))});
  }

  cart.mapGenerator = r.u8();
  if(cart.mapGenerator === 1){
    const tokenCount = r.u8();
    const tokens = Array.from(r.bytesN(tokenCount));
    const trackWidth = r.u8(), segLen = r.u8();
    const startGX = r.u8(), startGY = r.u8(), startDir = r.u8();
    const gridW = r.u8(), gridH = r.u8();
    cart.track = {tokens, trackWidth, segLen, startGX, startGY, startDir, gridW, gridH};
  } else if(cart.mapGenerator === 2){
    const gridW = r.u8(), gridH = r.u8();
    const fillProb = r.u8(), iterations = r.u8(), wallThreshold = r.u8();
    const goldCount = r.u8();
    cart.cave = {gridW, gridH, fillProb, iterations, wallThreshold, goldCount};
  } else if(cart.mapGenerator === 3){
    const gridH = r.u8();
    const startGroundY = r.u8(), minGroundY = r.u8(), maxGroundY = r.u8();
    const tokenCount = r.u8();
    const tokens = Array.from(r.bytesN(tokenCount));
    cart.platform = {gridH, startGroundY, minGroundY, maxGroundY, tokens};
  }

  cart.camera = {
    followGlobal: r.u8(),
    clampMinX: r.u16(), clampMinY: r.u16(),
    clampMaxX: r.u16(), clampMaxY: r.u16(),
  };

  cart.aimLine = r.u8() ? {
    anchorXGlobal: r.u8(), anchorYGlobal: r.u8(),
    angleGlobal: r.u8(), powerGlobal: r.u8(),
    maxPowerConstIdx: r.u8(), activeGlobal: r.u8(),
    colorIdx: r.u8(), maxLengthPx: r.u8(),
  } : null;

  cart.hooks = {};
  for(const name of HOOK_NAMES){
    const len = r.u16();
    cart.hooks[name] = r.bytesN(len);
  }
  return cart;
}

return {
  OPS, OPINDEX, assemble, runHook, MAX_STEPS,
  b64urlEncode, b64urlDecode, HAS_COMPRESSION,
  deflateRawCompress, deflateRawDecompress, encodePayload, decodePayloadToBytes,
  ByteWriter, ByteReader, HOOK_NAMES, BUTTON_BITS,
  TOUCH_TEMPLATE_NONE, TOUCH_TEMPLATE_SINGLE, TOUCH_TEMPLATE_STEER_ACTION, TOUCH_TEMPLATE_DPAD_ACTION, TOUCH_TEMPLATE_DPAD_ONLY,
  SHAPE_ELLIPSE, SHAPE_RECT, writeString, readString,
  encodeCart, decodeCart,
};
});
