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

   Sync policy: this used to say "kept in sync with urlcade.html by
   copying, not by import" — that was true back when the runtime was one
   ~5000-line self-contained HTML file and this was a hand-maintained
   verbatim copy of its cart-format guts, checked for drift by
   `test/check-kernel-sync.js` (a Playwright diff). As of the runtime's
   module split, that's no longer the arrangement: this file is now
   *the* single source of truth for the cart format, loaded directly —
   via a plain `<script src="kernel.js">` tag, not copied — by the
   player runtime (`runtime.js`), the Cart Inspector (`inspector.js`),
   every example cart, and the standalone `/compile` authoring tool.
   There is nothing left to drift, so there is nothing left to check;
   `check-kernel-sync.js` has been retired (see `test/smoke.js`). This
   file still has zero DOM/canvas/window dependency and still runs
   identically under Node or a browser — that property was always about
   being usable outside a browser (by an agent, a script, a CLI), not
   about avoiding an import, and it's unchanged.

   Beyond the opcode table/VM/binary format, this file also carries
   everything else about a cart that's pure data-in-data-out with no
   DOM dependency: palette generation, the three map generators
   (track/cave/platform), the sprite shape-list renderer, and the
   disassembler + control-flow-graph extractor the Inspector and
   `/compile` both use to decompile bytecode back to readable mnemonics.
   Only things that genuinely need a `document`/`canvas`/`WebGLContext`
   (building actual bitmaps, running the game loop, drawing) live in
   `runtime.js` instead.

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
  // Pointer input (DESIGN.md §36) — raw analog position/held-state, the
  // continuous counterpart to LOAD_INPUT's discrete button bitmask. Only
  // meaningful when the cart declares inputWantsPointer; reads 0 otherwise
  // (see runHook below), same "always safe to read, cart declares intent"
  // shape as the button system.
  ['LOAD_POINTER_X',[]],['LOAD_POINTER_Y',[]],['LOAD_POINTER_DOWN',[]],
  // Immediate-mode drawing (DESIGN.md §36) — issued from a renderKind-2
  // entity's on_draw hook, at render time, in entity-local pixel space
  // (the renderer translates to the entity's own position first, same as
  // an ordinary sprite). No operands beyond the stack: push x1,y1,x2,y2,
  // color in that order (color ends up on top, same "last pushed operand
  // on top" convention as SETTILE's x,y,tileId).
  ['DRAW_LINE',[]],
  // Persistent storage (DESIGN.md §69) — a second, localStorage-backed
  // globals array, same u8-slot shape as LOADG/STOREG, keyed per-cart by
  // the runtime so one cart's save data can't collide with another's.
  // Survives a page reload; LOADG/STOREG don't. See runtime.js's World
  // for the ctx.loadPersist/storePersist this actually routes through —
  // the VM itself has no localStorage access, same reason SETTILE routes
  // through ctx.setTile instead of touching the map directly.
  ['LOAD_PERSIST',['u8']],['STORE_PERSIST',['u8']],
  // Sound (DESIGN.md §72) — 4 persistent voices (channels), each a real
  // oscillator+noise+gain node graph held for the game's whole lifetime
  // in runtime.js, driven by these opcodes instead of indexing a header
  // table of pre-authored clips. A cart computes its own melody/arpeggio
  // logic in on_frame/on_tick (ADD/MOD are already exactly the right
  // tools for that) and pokes the registers every tick, the same way a
  // real sound chip works. PLAYSOUND (above) is untouched and still a
  // valid one-shot beep — this is an addition, not a replacement, so
  // existing compiled bytecode never needs to change.
  //   SET_VOICE_FREQ <u8 voice>  — pops Hz off the stack.
  //   SET_VOICE_WAVE <u8 voice> <u8 waveform> — both immediate; waveform
  //     0=square 1=triangle 2=noise 3=sine.
  //   SET_VOICE_GAIN <u8 voice> — pops a sustained 0..1 volume off the
  //     stack; for a held note or drone.
  //   TRIGGER_VOICE <u8 voice> — no stack operand; applies a fixed,
  //     engine-side decay envelope (mirrors the old PLAYSOUND's 150ms
  //     exponential decay) for a percussive hit. Not a duration operand
  //     on purpose — a cart wanting a longer/sustained note already has
  //     SET_VOICE_GAIN for that.
  // All four route through ctx callbacks the VM never implements itself
  // (no direct AudioContext access here, same reason ctx.setTile/
  // ctx.loadPersist exist) — see runtime.js's World for what they do.
  ['SET_VOICE_FREQ',['u8']],['SET_VOICE_WAVE',['u8','u8']],
  ['SET_VOICE_GAIN',['u8']],['TRIGGER_VOICE',['u8']],
];
const OPINDEX = {};
OPS.forEach((o,i)=>OPINDEX[o[0]]=i);

/* ============================================================
   2. Assembler — mnemonic source -> Uint8Array bytecode
   ============================================================ */
// Errors always name the 1-based source line number (in the array of
// lines the caller passed in) as well as the line text — load-bearing for
// the /compile tool, whose whole job is pointing an agent or a human at
// exactly which line of hand- or model-written assembly is wrong, not
// just that assembly *somewhere* is wrong.
function assemble(lines, sym){
  sym = sym || {constants:{}, globals:{}};
  const cleaned = lines
    .map((l,i)=>({text: l.split(';')[0].trim(), lineNo: i+1}))
    .filter(x=>x.text.length>0);
  const labelOffsets = {};
  const parsed = [];
  let offset = 0;
  function operandBytes(spec){ let n=0; for(const t of spec) n += (t==='u8')?1:2; return n; }
  for(const {text: line, lineNo} of cleaned){
    if(line.endsWith(':')){ labelOffsets[line.slice(0,-1)] = offset; continue; }
    const parts = line.split(/\s+/);
    const mnem = parts[0];
    const args = parts.slice(1);
    if(!(mnem in OPINDEX)) throw new Error('assemble: line '+lineNo+': unknown opcode "'+mnem+'" — "'+line+'"');
    const spec = OPS[OPINDEX[mnem]][1];
    parsed.push({mnem,args,spec,offset,line,lineNo});
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
      if(tok === undefined) throw new Error('assemble: line '+instr.lineNo+': missing operand for '+instr.mnem+' — "'+instr.line+'"');
      let val;
      if(type === 'addr'){
        if(!(tok in labelOffsets)) throw new Error('assemble: line '+instr.lineNo+': unknown label "'+tok+'" — "'+instr.line+'"');
        val = labelOffsets[tok];
      } else if(instr.mnem === 'PUSHC' && tok in sym.constants){
        val = sym.constants[tok];
      } else if((instr.mnem==='LOADG'||instr.mnem==='STOREG') && tok in sym.globals){
        val = sym.globals[tok];
      } else if((instr.mnem==='LOADE'||instr.mnem==='STOREE') && i===0 && tok in sym.globals){
        val = sym.globals[tok];
      } else {
        val = Number(tok);
        if(Number.isNaN(val)) throw new Error('assemble: line '+instr.lineNo+': bad operand "'+tok+'" for '+instr.mnem+' — "'+instr.line+'"');
      }
      if(type === 'u8'){
        if(val < -128 || val > 255) throw new Error('assemble: line '+instr.lineNo+': operand '+val+' out of u8 range (0-255) for '+instr.mnem+' — "'+instr.line+'"');
        buf.push(val & 0xFF);
      } else {
        if(val < -32768 || val > 65535) throw new Error('assemble: line '+instr.lineNo+': operand '+val+' out of 16-bit range for '+instr.mnem+' — "'+instr.line+'"');
        let v = val; if(v<0) v = 0x10000+v; buf.push(v & 0xFF, (v>>8)&0xFF);
      }
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
   `pointerX`/`pointerY`/`pointerDown`, `drawLine`, `loadPersist`/
   `storePersist`, and `setVoiceFreq`/`setVoiceWave`/`setVoiceGain`/
   `triggerVoice` are optional on top of that — LOAD_POINTER_* reads 0
   when absent (same as a cart that never declares inputWantsPointer),
   DRAW_LINE is simply a no-op when `drawLine` isn't supplied,
   LOAD_PERSIST/STORE_PERSIST behave the same way (read 0, write
   discarded) when `loadPersist`/`storePersist` aren't supplied, and the
   four voice opcodes are no-ops when their callbacks aren't supplied —
   so this minimum shape still runs any hook, including on_draw or one
   that touches persistent storage or sound, without throwing.
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
      case 53: { stack.push(ctx.pointerX||0); break; } // LOAD_POINTER_X
      case 54: { stack.push(ctx.pointerY||0); break; } // LOAD_POINTER_Y
      case 55: { stack.push(ctx.pointerDown?1:0); break; } // LOAD_POINTER_DOWN
      case 56: { // DRAW_LINE — see runtime.js's World for the ctx.drawLine it calls
        const color=stack.pop(), y2=stack.pop(), x2=stack.pop(), y1=stack.pop(), x1=stack.pop();
        if(ctx.drawLine) ctx.drawLine(x1,y1,x2,y2,color);
        break;
      }
      case 57: { const idx=u8(); stack.push(ctx.loadPersist ? ctx.loadPersist(idx) : 0); break; } // LOAD_PERSIST
      case 58: { const idx=u8(); const v=stack.pop(); if(ctx.storePersist) ctx.storePersist(idx, v); break; } // STORE_PERSIST
      case 59: { const voice=u8(); const freq=stack.pop(); if(ctx.setVoiceFreq) ctx.setVoiceFreq(voice, freq); break; } // SET_VOICE_FREQ
      case 60: { const voice=u8(), wave=u8(); if(ctx.setVoiceWave) ctx.setVoiceWave(voice, wave); break; } // SET_VOICE_WAVE
      case 61: { const voice=u8(); const gain=stack.pop(); if(ctx.setVoiceGain) ctx.setVoiceGain(voice, gain); break; } // SET_VOICE_GAIN
      case 62: { const voice=u8(); if(ctx.triggerVoice) ctx.triggerVoice(voice); break; } // TRIGGER_VOICE
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
  try{
    const compressed = 'z.' + b64urlEncode(await deflateRawCompress(bytes));
    return compressed.length < raw.length ? compressed : raw;
  } catch(err){
    // HAS_COMPRESSION only confirms CompressionStream/DecompressionStream
    // exist as constructors — some hosts report that true but still throw
    // when the 'deflate-raw' format specifically is actually used (seen in
    // the wild on at least one mobile browser). There's a real fallback
    // here (the raw, uncompressed form), so a format-support gap degrades
    // a fragment's length, not the entire cart-authoring flow built on top
    // of this function — every caller (the runtime, Debug's Compile tab)
    // would otherwise see this as an unexplained, silent failure instead.
    return raw;
  }
}
async function decodePayloadToBytes(str){
  if(str.startsWith('z.')) return deflateRawDecompress(b64urlDecode(str.slice(2)));
  if(str.startsWith('r.')) return b64urlDecode(str.slice(2));
  return b64urlDecode(str); // untagged: legacy raw fragment
}

// Name/author URL envelope (DESIGN.md §34) — plain, unencoded-as-cart-data
// text prefixed onto a payload before its z./r. tag: `<name>,<author>,z.<...>`.
// Deliberately encodeURIComponent'd individually rather than folded into the
// binary cart format and base64'd like everything else: base64 buys no real
// compression on a short human-readable string, and a reader glancing at a
// shared link can already tell what game it is without decoding anything.
// A comma is a safe, unambiguous split point because neither base64url's
// alphabet (A-Za-z0-9-_) nor a legacy untagged raw fragment (same alphabet)
// ever contains one — so a fragment with no comma at all is exactly a
// fragment from before this existed, or one with no name/author set.
function encodeCartUrl(name, author, payload){
  if(!name && !author) return payload;
  return encodeURIComponent(name || '') + ',' + encodeURIComponent(author || '') + ',' + payload;
}
function decodeCartUrl(fragment){
  const c1 = fragment.indexOf(',');
  if(c1 === -1) return {name: '', author: '', payload: fragment};
  const c2 = fragment.indexOf(',', c1 + 1);
  if(c2 === -1) return {name: '', author: '', payload: fragment};
  return {
    name: decodeURIComponent(fragment.slice(0, c1)),
    author: decodeURIComponent(fragment.slice(c1 + 1, c2)),
    payload: fragment.slice(c2 + 1),
  };
}

/* ============================================================
   5. Cart binary format (byte-aligned V0 simplification of
      DESIGN.md §4 — see url-console/v0/README.md for what this
      cuts relative to the full nibble-packed spec)
   ============================================================ */
class ByteWriter {
  constructor(){ this.bytes = []; }
  // `v & 0xFF` used to silently wrap out-of-range input (e.g. 260 -> 4)
  // instead of erroring — found the hard way authoring a palette's
  // accentOffset (DESIGN.md §41): the cart *compiled* fine, and only
  // rendered a plainly wrong hue once actually screenshotted, with
  // nothing in between pointing at why. A thrown error at the one choke
  // point every u8 field writes through (paletteParams, collision
  // bounds, hudSpec, entity fields, ...) turns that into a compile-time
  // error naming the exact bad value instead of a silent miscolor.
  u8(v){
    if(!Number.isInteger(v) || v < 0 || v > 255) throw new Error('u8 value out of range (0-255): '+v);
    this.bytes.push(v);
  }
  u16(v){ this.bytes.push(v & 0xFF, (v>>8) & 0xFF); }
  f32(v){ const b = new Uint8Array(4); new DataView(b.buffer).setFloat32(0, v, true); this.bytes.push(...b); }
  bytesRaw(arr){ for(const x of arr) this.u8(x); }
  toUint8Array(){ return new Uint8Array(this.bytes); }
}
// Bounds-checked on every read: a hand-edited or truncated fragment used
// to silently decode into garbage (reads past the end of the buffer just
// return `undefined`, which then poisons everything downstream as NaN) —
// exactly the failure mode a self-serve tool can't afford, since its
// whole point is telling an agent or a human *why* a cart is invalid
// instead of handing back a corrupt-looking cart with no explanation.
class ByteReader {
  constructor(bytes){ this.bytes = bytes; this.p = 0; }
  _need(n){
    if(this.p + n > this.bytes.length){
      throw new Error('truncated cart data: need '+n+' more byte(s) at offset '+this.p+', only '+(this.bytes.length-this.p)+' remain ('+this.bytes.length+' total)');
    }
  }
  u8(){ this._need(1); return this.bytes[this.p++]; }
  u16(){ this._need(2); const lo=this.bytes[this.p++], hi=this.bytes[this.p++]; return lo|(hi<<8); }
  f32(){ this._need(4); const b = this.bytes.slice(this.p, this.p+4); this.p += 4; return new DataView(b.buffer).getFloat32(0, true); }
  bytesN(n){ this._need(n); const r = this.bytes.slice(this.p, this.p+n); this.p += n; return r; }
}

// on_draw (DESIGN.md §36) runs at render time, not simulation-tick time,
// for renderKind:2 ("custom draw") entities only — every other hook here
// runs on the fixed-timestep simulation clock.
const HOOK_NAMES = ['on_init','on_frame','on_tick','on_input','on_collide','on_draw'];

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
  w.u8(cart.inputWantsPointer ? 1 : 0);

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
        for(const v of p) w.u8(Math.round(v*8)); // fixed-point, 1/8px — u8() itself throws out-of-range (ceiling 31.875px)
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

  // Tilemap authoring — shape layers (DESIGN.md §74). The shape count is
  // written before blankMap on purpose: blankMap's own presence depends
  // on whether there's anything to stamp into it, which the decoder
  // can't know until it has read this count — writing blankMap first
  // would leave decodeCart with no way to tell whether those bytes are
  // even there. mapGenerator 1/2/3 never write blankMap at all (they
  // already have a grid from their own generator); mapGenerator 0 with
  // an empty mapShapes stays exactly what it's always been (this one
  // count byte is the only cost), matching kernel.js's own
  // buildBlankMap/applyMapShapes doc comment above.
  const mapShapes = cart.mapShapes || [];
  w.u8(mapShapes.length);
  if(cart.mapGenerator === 0 && mapShapes.length){
    const bm = cart.blankMap;
    w.u8(bm.width); w.u8(bm.height); w.u8(bm.fillTileId);
  }
  for(const sh of mapShapes){
    w.u8(sh.tileX0); w.u8(sh.tileY0); w.u8(sh.tileX1); w.u8(sh.tileY1); w.u8(sh.tileId);
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

// Bumped from 3 to 4 for tilemap authoring's mapShapes[]/blankMap fields
// (DESIGN.md §74) — new required bytes in the middle of the format (the
// mapShapes count, read unconditionally right after the mapGenerator
// block), not appendable without a version bump the way a genuinely
// optional trailing field could be. Same no-compatibility-branch policy
// every prior bump has used: this project is still pre-v1, and any cart
// worth keeping can be decompiled under the old kernel and recompiled
// fresh.
const SUPPORTED_FORMAT_VERSIONS = [4];
function decodeCart(bytes){
  const r = new ByteReader(bytes);
  const cart = {};
  cart.formatVersion = r.u8();
  if(!SUPPORTED_FORMAT_VERSIONS.includes(cart.formatVersion)){
    throw new Error('unsupported cart format_version '+cart.formatVersion+' (this kernel understands: '+SUPPORTED_FORMAT_VERSIONS.join(', ')+') — either a corrupted fragment or a newer/older format than this runtime');
  }
  cart.cartType = r.u8();
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
  cart.inputWantsPointer = !!r.u8();

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

  const mapShapeCount = r.u8();
  cart.blankMap = null;
  if(cart.mapGenerator === 0 && mapShapeCount){
    cart.blankMap = {width: r.u8(), height: r.u8(), fillTileId: r.u8()};
  }
  cart.mapShapes = [];
  for(let i=0;i<mapShapeCount;i++){
    cart.mapShapes.push({
      tileX0: r.u8(), tileY0: r.u8(), tileX1: r.u8(), tileY1: r.u8(), tileId: r.u8(),
    });
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
  if(r.p !== bytes.length){
    throw new Error('trailing data after decoding cart: '+(bytes.length-r.p)+' unread byte(s) left over ('+r.p+' of '+bytes.length+' consumed) — likely a corrupted or concatenated fragment');
  }
  return cart;
}

/* ============================================================
   6. Palette generation — DESIGN.md §6, §41, §43, §44

   One algorithm, no mode switch: every cart's 16 colors are pure math
   from an 8-byte paletteParams block — no hand-picked bank baked into
   the runtime (that used to exist as CURATED_BANK/paletteMode:0; see
   DESIGN.md §43 for why it was collapsed into this). Three ramps split
   the 16 indices:
     0-7   "terrain"  — backdrop/tiles, 8 shades, one hue
     8-11  "entity A" — the cart's first character/object, 4 shades
     12-15 "entity B" — a second, independently-colored character/object
   Any of these three can be repurposed for something other than its
   name suggests — backdropFillIndex/backdropGroundIndex can point at
   *any* of the 16 indices, so a cart with only one character can borrow
   the otherwise-idle entity B ramp as a second backdrop hue (see
   carts/flappy-bird.js, DESIGN.md §44) instead of leaving it unused.
   ============================================================ */
function hsl(h,s,l){ return `hsl(${((h%360)+360)%360},${Math.max(0,Math.min(100,s)).toFixed(0)}%,${Math.max(0,Math.min(100,l)).toFixed(0)}%)`; }
function circHueDist(a,b){ const d = Math.abs(a-b) % 360; return d > 180 ? 360-d : d; }
// paletteParams[6]/[7] are *absolute hue hints* for entity A/B — "I want
// this ramp to read as roughly this hue" — not an offset relative to
// the terrain hue. That distinction matters for actually authoring a
// cart: picking a hint means picking the color you want and writing
// down its hue (get it straight off a color wheel, or off
// generatePalette()'s own rendered output), not reverse-solving "what
// offset from my terrain hue lands on orange." The hint is honored
// exactly whenever it's already far enough from its neighbors (most of
// the time — MIN_HUE_SEPARATION only forbids a fairly narrow arc around
// each already-placed hue) and nudged to the nearest edge of that arc
// only when it isn't. Entity B is checked against *both* the terrain
// hue and wherever entity A actually landed.
//
// A first version of this (DESIGN.md §43) anchored entity A at
// terrainHue+120deg and entity B at terrainHue+240deg — a fixed triad,
// guaranteed-safe by construction, but reported live as making every
// cart look like the same three families of color (always some
// blue/pink/green, never yellow/orange/red): a *fixed* 120deg rotation
// of the fairly narrow range of terrain hues carts actually tend to
// pick revisits the same few hue neighborhoods project-wide no matter
// what any individual cart does. Absolute hints fix that directly: a
// cart that actually wants a yellow entity says so, rather than hoping
// some rotation of its terrain hue happens to land there.
const ACCENT_SAT_MIN = 55, ACCENT_SAT_MAX = 90;
const ACCENT_LIGHT_MIN = 45, ACCENT_LIGHT_MAX = 88;
// Every entity ramp's first shade is *not* part of the hue-drift curve
// below — it's a fixed, low-saturation near-black, the same "ink" role
// regardless of which hue the rest of the ramp carries. Real palettes
// often cheat exactly this way: ramps that are otherwise independently
// hued still converge on a shared near-black at their darkest step, so
// that dark step reads as a consistent outline/pupil/shadow color no
// matter which entity it belongs to, instead of each ramp supplying its
// own hued-but-still-fairly-light "dark" shade (DESIGN.md §44 — a real
// report that entities had no genuinely dark shade to outline with, and
// that a ramp's mid and highlight steps sat too close in hue to read as
// distinct parts, e.g. a bird's wing blurring into its body).
const INK_LIGHTNESS = 12, INK_SATURATION = 28;
// MIN_HUE_SEPARATION is on the *anchor* hues (before hue-drift shading);
// the true floor on every *rendered* swatch is smaller, since both
// ACCENT_HUE_DRIFT and TERRAIN_HUE_DRIFT swing their ramps' actual
// colors closer to a neighbor than the anchor-to-anchor distance
// suggests. 70 (with drift 10/8) was picked by brute-force sweeping
// generatePalette()'s actual rendered output across base hues and every
// combination of extreme author-chosen hints (not by arithmetic alone —
// DESIGN.md §41 and §43 both document a constant that looked safe on
// paper and wasn't): it holds a real >=50deg floor between the two
// entity ramps and terrain, confirmed the same way. Deliberately lower
// than an earlier draft's 100 (DESIGN.md §44): 100 made a real request
// — "yellow bird, green pipes, blue sky" — geometrically unreachable,
// since yellow and green sit only ~70deg apart on the wheel and no
// separation floor above that can ever honor both as independently
// placed hues. 70 is chosen to be exactly permissive enough for that
// specific, legitimate case (adjacent-but-still-distinct hues, common
// in real palettes) while still rejecting the near-collisions (sub-40deg)
// that caused the original "blends into the background" reports.
const MIN_HUE_SEPARATION = 70;
const ACCENT_HUE_DRIFT = 10;
const TERRAIN_HUE_DRIFT = 8;
function clampOffsetFromAnchor(rawOffsetDeg){
  const r = ((rawOffsetDeg % 360) + 360) % 360;
  return Math.min(360 - MIN_HUE_SEPARATION, Math.max(MIN_HUE_SEPARATION, r));
}
// Hints are stored as a byte (0-255, same 8-bit paletteParams slot
// every other field uses) but need to reach *any* hue on a 360deg
// wheel, including ones past 255deg (a genuine red at ~350, for
// instance) — a byte interpreted as degrees directly (as baseHue still
// is, for backward-compatible reasons: it's degrees 0-255 straight,
// same as always) can't get there. Scaling by 360/256 instead spends
// the full byte range on the full circle, at a coarser ~1.4deg-per-step
// resolution nobody authoring by eye needs finer than anyway.
function hueHintToDegrees(hintByte){ return hintByte * 360/256; }
function generatePalette(cart){
  const [baseHue,,satMin,satMax,lightMin,lightMax,entityAHueHintByte,entityBHueHintByte] = cart.paletteParams;
  const entityAHueHint = hueHintToDegrees(entityAHueHintByte);
  const entityBHueHint = hueHintToDegrees(entityBHueHintByte);
  const pal = new Array(16);
  for(let i=0;i<8;i++){
    const t = i/7;
    const hueAtT = baseHue + TERRAIN_HUE_DRIFT - 2*TERRAIN_HUE_DRIFT*t;
    pal[i] = hsl(hueAtT, satMin+(satMax-satMin)*t, lightMin+(lightMax-lightMin)*t);
  }
  const entityHueA = baseHue + clampOffsetFromAnchor(entityAHueHint - baseHue);
  let entityHueB = baseHue + clampOffsetFromAnchor(entityBHueHint - baseHue);
  if(circHueDist(entityHueB, entityHueA) < MIN_HUE_SEPARATION){
    const side1 = entityHueA + MIN_HUE_SEPARATION, side2 = entityHueA - MIN_HUE_SEPARATION;
    entityHueB = circHueDist(side1, baseHue) >= circHueDist(side2, baseHue) ? side1 : side2;
  }
  fillEntityRamp(pal, 8, 4, entityHueA, satMin, satMax, lightMin, lightMax);
  fillEntityRamp(pal, 12, 4, entityHueB, satMin, satMax, lightMin, lightMax);
  return pal;
}
// Shared by both entity ramps — `count` shades (4, for the 8-11/12-15
// split), starting at `startIndex` in `pal`, radiating out from `hue`.
// Index 0 of the ramp is the shared ink shade (see INK_LIGHTNESS above),
// left out of the hue/sat/light curve entirely — it doesn't need to be,
// since a swatch that dark and that desaturated doesn't read as "a hue"
// in the first place, so it can't visually collide with a neighboring
// ramp's hue the way a lighter, more saturated swatch could. The
// remaining count-1 shades then get the *whole* hue-drift/saturation
// range to themselves (t=0..1 across just those steps) instead of
// sharing it with the ink step, which is what actually fixes "ramp's
// two middle shades barely differ in hue" — spreading the same total
// drift across three visible steps instead of four widens every gap
// between them. Saturation now falls monotonically from the darkest
// visible step to the lightest (rather than peaking at the ramp's
// midpoint) since the ink step already covers the "low-saturation dark
// shade" role; the visible steps are free to stay saturated all the way
// down to their own darkest point. The most-saturated visible step
// (t=0) drifts hue *downward* (toward red/orange) and the palest,
// least-saturated step (t=1) drifts *upward* (toward green/cyan) — not
// an arbitrary pick: a yellow anchor sits right on the fragile yellow/
// lime-green boundary (~60deg), so drifting its most-saturated,
// most-visible step upward is exactly what previously made a hinted
// "yellow" wing accent read as lime instead (DESIGN.md §44). Drifting
// downward instead lands solidly in unambiguous orange territory for
// any yellow-ish anchor, and is harmless for every other hue family —
// there's no equivalent fragile boundary on the low side, and the
// upward drift still happens, just parked on the ramp's *palest* step,
// where a small hue push barely reads at all.
function fillEntityRamp(pal, startIndex, count, hue, satMin, satMax, lightMin, lightMax){
  const accentSatMin = Math.max(satMin, ACCENT_SAT_MIN);
  const accentSatMax = Math.max(satMax, ACCENT_SAT_MAX, accentSatMin);
  const accentLightMin = Math.max(lightMin, ACCENT_LIGHT_MIN);
  const accentLightMax = Math.max(lightMax, ACCENT_LIGHT_MAX, accentLightMin + 20);
  pal[startIndex] = hsl(hue, INK_SATURATION, INK_LIGHTNESS);
  const visibleSteps = Math.max(1, count - 2);
  for(let i=1;i<count;i++){
    const t = (i-1)/visibleSteps;
    const hueAtT = hue - ACCENT_HUE_DRIFT + 2*ACCENT_HUE_DRIFT*t;
    const satAtT = accentSatMax - (accentSatMax-accentSatMin)*t;
    pal[startIndex+i] = hsl(hueAtT, satAtT, accentLightMin+(accentLightMax-accentLightMin)*t);
  }
}

/* ============================================================
   7. Map generators — DESIGN.md §12/§14/§15/§16. Three independent
   algorithms selected by cart.mapGenerator (1/2/3); 0 = none. Each takes
   its own cart-declared parameter block and returns {grid, checkpoints,
   ...}. Pure data in, data out — no DOM, no randomness except an
   injected `rng` (the cave generator's own seeded PRNG, supplied by the
   caller so this stays deterministic without owning the seed itself).
   ============================================================ */
// WAYPOINT (DESIGN.md §46) registers an AI steering target the same way
// CHECKPOINT does, without stamping a visible startline tile — a plain
// numeric token, no format impact (track.tokens is already just a raw
// byte array; this is a new value inside it, not a new field).
const TRACK_TOKENS = { STRAIGHT:0, CURVE_R90:1, CURVE_L90:2, START_FINISH:3, CHECKPOINT:4, WAYPOINT:5 };
// TILE_CHECKPOINT is its own id, not a second use of TILE_STARTLINE — a
// cart that wants its actual start/finish line to look distinct from an
// ordinary mid-lap CHECKPOINT gate (DESIGN.md §49) needs two different
// tile ids to supply two different bitmaps for in its own `tiles` array;
// sharing one id means sharing one bitmap, no matter what that bitmap
// looks like. A cart that doesn't care (mini-golf, whose CHECKPOINT is
// "the hole" rather than a lap gate, and marks it with a separate flag
// entity instead of relying on tile art) can just point both ids at the
// same pixel data and the same tileSurfaceOverrides target — nothing
// requires the two to look or behave differently.
const TILE_ROAD=2, TILE_RUMBLE=3, TILE_STARTLINE=4, TILE_CHECKPOINT=5;
// Convention, not a hardcoded special case: tile id 1 is whatever a
// generator considers its "solid/boundary" tile, returned for any
// off-grid query. Every map generator so far happens to put that tile
// first in its own bank (racer's grass, the cave's rock wall) — this is
// generic on purpose, unlike tileSurface used to be (see its own comment).
const MAP_EDGE_TILE = 1;
function buildTrack(track){
  const grid = [];
  for(let y=0;y<track.gridH;y++) grid.push(new Array(track.gridW).fill(MAP_EDGE_TILE));
  const DIRV = [[1,0],[0,1],[-1,0],[0,-1]];
  let gx = track.startGX, gy = track.startGY, dir = track.startDir;
  const checkpoints = [];
  // START_FINISH/CHECKPOINT's own marker stamp is recorded here rather
  // than written to the grid immediately, and re-applied in one final
  // pass after the whole walk finishes (DESIGN.md §49). A *closed* track
  // necessarily curves back around near its own start to close the loop
  // — the walk's last CURVE_R90/L90 fills a trackWidth-square block
  // whose position is only a function of how the walk happens to end,
  // with no way to know in advance whether it'll land close enough to
  // the start to overlap it — and on this cart's own track it does:
  // the closing curve's fill block covers the exact tile the start/
  // finish line stamped, silently overwriting it with plain road before
  // a single frame ever renders. Not a corner case: any lap-based
  // track's own closing curve is, by definition, near the start. Only a
  // final re-stamp pass — guaranteed to run after every other write —
  // can survive that regardless of the specific loop shape.
  const pendingMarkers = [];
  function setTile(x,y,v){ if(x>=0&&y>=0&&x<track.gridW&&y<track.gridH) grid[y][x]=v; }
  function stampPerp(cx,cy,dir,width,marker){
    const perp = DIRV[(dir+1)%4];
    const half = Math.floor(width/2);
    for(let o=-half;o<=half;o++){
      const px = cx+perp[0]*o, py = cy+perp[1]*o;
      const isEdge = (o===-half || o===half);
      setTile(px,py, marker || (isEdge?TILE_RUMBLE:TILE_ROAD));
    }
  }
  for(const tok of track.tokens){
    if(tok === TRACK_TOKENS.STRAIGHT){
      for(let s=0;s<track.segLen;s++){
        stampPerp(gx,gy,dir,track.trackWidth);
        gx += DIRV[dir][0]; gy += DIRV[dir][1];
      }
    } else if(tok === TRACK_TOKENS.CURVE_R90 || tok === TRACK_TOKENS.CURVE_L90){
      const half = Math.floor(track.trackWidth/2);
      for(let dx=-half;dx<=half;dx++) for(let dy=-half;dy<=half;dy++) setTile(gx+dx,gy+dy,TILE_ROAD);
      dir = (dir + (tok===TRACK_TOKENS.CURVE_R90?1:3)) % 4;
      gx += DIRV[dir][0]; gy += DIRV[dir][1];
    } else if(tok === TRACK_TOKENS.START_FINISH){
      pendingMarkers.push({gx,gy,dir,marker:TILE_STARTLINE});
      checkpoints.push({x:(gx+0.5)*8, y:(gy+0.5)*8});
    } else if(tok === TRACK_TOKENS.CHECKPOINT){
      pendingMarkers.push({gx,gy,dir,marker:TILE_CHECKPOINT});
      checkpoints.push({x:(gx+0.5)*8, y:(gy+0.5)*8});
    } else if(tok === TRACK_TOKENS.WAYPOINT){
      checkpoints.push({x:(gx+0.5)*8, y:(gy+0.5)*8});
    }
  }
  for(const m of pendingMarkers) stampPerp(m.gx, m.gy, m.dir, track.trackWidth, m.marker);
  return {grid, checkpoints, startGX:track.startGX, startGY:track.startGY, startDir:track.startDir};
}

const CAVE_WALL=1, CAVE_FLOOR=2, CAVE_STAIRS=3, CAVE_GOLD=4;
function buildCave(cave, rng){
  const {gridW, gridH, fillProb, iterations, wallThreshold} = cave;
  let grid = [];
  for(let y=0;y<gridH;y++){
    const row = [];
    for(let x=0;x<gridW;x++){
      const border = (x===0||y===0||x===gridW-1||y===gridH-1);
      row.push(border ? CAVE_WALL : (rng() < fillProb/255 ? CAVE_WALL : CAVE_FLOOR));
    }
    grid.push(row);
  }
  function countWallNeighbors(g,x,y){
    let c=0;
    for(let dy=-1;dy<=1;dy++) for(let dx=-1;dx<=1;dx++){
      if(dx===0&&dy===0) continue;
      const nx=x+dx, ny=y+dy;
      if(nx<0||ny<0||nx>=gridW||ny>=gridH||g[ny][nx]===CAVE_WALL) c++;
    }
    return c;
  }
  for(let it=0; it<iterations; it++){
    const next = grid.map(row=>row.slice());
    for(let y=1;y<gridH-1;y++) for(let x=1;x<gridW-1;x++){
      next[y][x] = countWallNeighbors(grid,x,y) >= wallThreshold ? CAVE_WALL : CAVE_FLOOR;
    }
    grid = next;
  }

  let startX=-1, startY=-1;
  outer: for(let y=1;y<gridH-1;y++) for(let x=1;x<gridW-1;x++){
    if(grid[y][x]===CAVE_FLOOR){ startX=x; startY=y; break outer; }
  }
  if(startX<0){
    startX = Math.floor(gridW/2); startY = Math.floor(gridH/2);
    for(let dy=-1;dy<=1;dy++) for(let dx=-1;dx<=1;dx++) grid[startY+dy][startX+dx]=CAVE_FLOOR;
  }
  const dist = Array.from({length:gridH}, () => new Array(gridW).fill(-1));
  dist[startY][startX] = 0;
  const queue = [[startX,startY]];
  let qi = 0, farX = startX, farY = startY, farDist = 0;
  const N4 = [[1,0],[-1,0],[0,1],[0,-1]];
  while(qi < queue.length){
    const [x,y] = queue[qi++];
    const d = dist[y][x];
    if(d > farDist){ farDist = d; farX = x; farY = y; }
    for(const [dx,dy] of N4){
      const nx=x+dx, ny=y+dy;
      if(nx<0||ny<0||nx>=gridW||ny>=gridH) continue;
      if(grid[ny][nx]===CAVE_WALL) continue;
      if(dist[ny][nx]!==-1) continue;
      dist[ny][nx] = d+1;
      queue.push([nx,ny]);
    }
  }
  const reached = [];
  for(let y=0;y<gridH;y++) for(let x=0;x<gridW;x++){
    if(grid[y][x]!==CAVE_WALL){
      if(dist[y][x]===-1) grid[y][x]=CAVE_WALL;
      else reached.push({x,y});
    }
  }
  grid[farY][farX] = CAVE_STAIRS;

  const goldCandidates = reached.filter(c => !(c.x===startX&&c.y===startY) && !(c.x===farX&&c.y===farY));
  for(let i=goldCandidates.length-1;i>0;i--){
    const j = Math.floor(rng()*(i+1));
    [goldCandidates[i],goldCandidates[j]] = [goldCandidates[j],goldCandidates[i]];
  }
  const goldCount = Math.min(cave.goldCount, goldCandidates.length);
  for(let i=0;i<goldCount;i++) grid[goldCandidates[i].y][goldCandidates[i].x] = CAVE_GOLD;

  return {
    grid,
    checkpoints: [
      {x:(startX+0.5)*8, y:(startY+0.5)*8}, // [0] = player start
      {x:(farX+0.5)*8, y:(farY+0.5)*8},     // [1] = stairs down
    ],
  };
}

const PLATFORM_TOKENS = { FLAT:0, STEP_UP:1, STEP_DOWN:2, GAP:3, BLOCK:4, COIN:5, ENEMY:6, COIN_AT:7, ENEMY_AT:8 };
const PLATFORM_WIDTH_TOKENS = new Set([0,1,2,3,4]);
const PLATFORM_OPERAND_TOKENS = new Set([0,1,2,3,4,7,8]);
const PLATFORM_AIR=1, PLATFORM_GROUND=2, PLATFORM_DIRT=3, PLATFORM_BRICK=4;
function buildPlatformLevel(level){
  const gridH = level.gridH;
  let gridW = 0;
  for(let i=0;i<level.tokens.length;i++){
    if(PLATFORM_WIDTH_TOKENS.has(level.tokens[i])) gridW += level.tokens[++i];
    else if(PLATFORM_OPERAND_TOKENS.has(level.tokens[i])) i++;
  }
  const grid = [];
  for(let y=0;y<gridH;y++) grid.push(new Array(gridW).fill(PLATFORM_AIR));
  function fillColumn(x, topY){
    if(x<0||x>=gridW) return;
    for(let y=topY;y<gridH;y++) grid[y][x] = (y===topY) ? PLATFORM_GROUND : PLATFORM_DIRT;
  }
  let gx = 0, groundY = level.startGroundY;
  const coinCps = [], enemyCps = [];
  for(let i=0;i<level.tokens.length;i++){
    const t = level.tokens[i];
    if(t === PLATFORM_TOKENS.FLAT){
      const w = level.tokens[++i];
      for(let k=0;k<w;k++){ fillColumn(gx, groundY); gx++; }
    } else if(t === PLATFORM_TOKENS.STEP_UP){
      const w = level.tokens[++i];
      groundY = Math.max(level.minGroundY, groundY-1);
      for(let k=0;k<w;k++){ fillColumn(gx, groundY); gx++; }
    } else if(t === PLATFORM_TOKENS.STEP_DOWN){
      const w = level.tokens[++i];
      groundY = Math.min(level.maxGroundY, groundY+1);
      for(let k=0;k<w;k++){ fillColumn(gx, groundY); gx++; }
    } else if(t === PLATFORM_TOKENS.GAP){
      const w = level.tokens[++i];
      const pitY = Math.min(gridH-1, groundY+5);
      for(let k=0;k<w;k++){
        if(gx>=0 && gx<gridW) grid[pitY][gx] = PLATFORM_GROUND;
        gx++;
      }
    } else if(t === PLATFORM_TOKENS.BLOCK){
      const w = level.tokens[++i];
      for(let k=0;k<w;k++){ fillColumn(gx+k, groundY); }
      const by = Math.max(0, groundY-4);
      for(let k=0;k<Math.min(3,w);k++){ const x=gx+k; if(x>=0&&x<gridW) grid[by][x]=PLATFORM_BRICK; }
      gx += w;
    } else if(t === PLATFORM_TOKENS.COIN){
      coinCps.push({x:(gx+0.5)*8, y:(groundY-3+0.5)*8});
    } else if(t === PLATFORM_TOKENS.ENEMY){
      enemyCps.push({x:(gx+0.5)*8, y:(groundY-1)*8});
    } else if(t === PLATFORM_TOKENS.COIN_AT){
      const rowOffset = level.tokens[++i];
      coinCps.push({x:(gx+0.5)*8, y:(groundY-rowOffset+0.5)*8});
    } else if(t === PLATFORM_TOKENS.ENEMY_AT){
      const rowOffset = level.tokens[++i];
      enemyCps.push({x:(gx+0.5)*8, y:(groundY-rowOffset)*8});
    }
  }
  const startCp = {x:16, y:(level.startGroundY-1)*8};
  return {
    grid,
    checkpoints: [startCp, ...coinCps, ...enemyCps],
    numCoins: coinCps.length,
    numEnemies: enemyCps.length,
  };
}

// Tilemap authoring — shape layers (DESIGN.md §74). Not a fourth
// mutually-exclusive generator alongside track/cave/platform: `mapShapes`
// is an orthogonal post-processing pass that composites on top of
// whichever base is in play, including none (`mapGenerator:0`).
//
// `buildBlankMap(blankMap)` gives `mapGenerator:0` an explicit grid to
// stamp into — the same {grid, checkpoints} shape every real generator
// returns above, just a flat fill instead of an algorithm, and an empty
// checkpoints array (nothing here to derive one from; a shapes-only cart
// that needs its own logical positions declares them as ordinary
// constants instead).
function buildBlankMap(blankMap){
  const grid = [];
  for(let y=0;y<blankMap.height;y++) grid.push(new Array(blankMap.width).fill(blankMap.fillTileId));
  return {grid, checkpoints: []};
}
// `applyMapShapes(grid, mapShapes)` stamps each shape's declared tile id
// over the cells it covers, in array order — later shapes win on
// overlap, the exact same z-order-collapses-down semantics
// `renderShapeList` already uses for sprites, reused as-is rather than
// inventing separate overlap rules. Coordinates are tile-grid cells, not
// pixels (`tileX0,tileY0` inclusive, `tileX1,tileY1` exclusive — a plain
// half-open range, simpler than a sprite shape's pixel/sub-pixel math
// since a rect stamped onto a grid has no anti-aliasing or boundary
// ambiguity to resolve). Out-of-range cells are silently clipped to the
// grid, the same forgiving posture `SETTILE` already has at runtime.
// Mutates `grid` in place — called once, at load time, over a generator's
// (or `buildBlankMap`'s) freshly-built grid, well before anything renders
// it or a hook can observe it.
function applyMapShapes(grid, mapShapes){
  const gh = grid.length, gw = gh ? grid[0].length : 0;
  for(const sh of mapShapes){
    const x0 = Math.max(0, Math.min(sh.tileX0, sh.tileX1));
    const x1 = Math.min(gw, Math.max(sh.tileX0, sh.tileX1));
    const y0 = Math.max(0, Math.min(sh.tileY0, sh.tileY1));
    const y1 = Math.min(gh, Math.max(sh.tileY0, sh.tileY1));
    for(let y=y0;y<y1;y++) for(let x=x0;x<x1;x++) grid[y][x] = sh.tileId;
  }
}

/* ============================================================
   8. Sprite shape lists — DESIGN.md §17 (sprites as generated art, not
   raw pixel dumps or hand-written draw code). A sprite is either raw
   per-pixel indices (kind 0 — see decodeCart) or a small ordered list
   of primitive shapes (kind 1), each ~6 bytes, that the runtime paints
   into a flat pixel array at *load* time via renderShapeList — from
   decoded cart data, not from re-running any cart-specific code. Only
   two primitives, deliberately (see DESIGN.md for why that's enough).
   ============================================================ */
function renderShapeList(w, h, shapes){
  const px = new Array(w*h).fill(0);
  for(const sh of shapes){
    if(sh.type === SHAPE_ELLIPSE){
      const x0 = Math.max(0, Math.floor(sh.cx-sh.rx)), x1 = Math.min(w-1, Math.ceil(sh.cx+sh.rx));
      const y0 = Math.max(0, Math.floor(sh.cy-sh.ry)), y1 = Math.min(h-1, Math.ceil(sh.cy+sh.ry));
      for(let y=y0;y<=y1;y++) for(let x=x0;x<=x1;x++){
        const dx=(x+0.5-sh.cx)/sh.rx, dy=(y+0.5-sh.cy)/sh.ry;
        if(dx*dx+dy*dy <= 1) px[y*w+x] = sh.color;
      }
    } else { // SHAPE_RECT
      const x0 = Math.max(0, Math.round(sh.x)), x1 = Math.min(w-1, Math.round(sh.x+sh.w)-1);
      const y0 = Math.max(0, Math.round(sh.y)), y1 = Math.min(h-1, Math.round(sh.y+sh.h)-1);
      for(let y=y0;y<=y1;y++) for(let x=x0;x<=x1;x++) px[y*w+x] = sh.color;
    }
  }
  return px;
}
// Authoring-time sugar for the two blob-silhouette families reused across
// carts (DRY for the cart-*authoring* code only — the encoded cart gets
// the resulting plain shape array either way, never a reference to these
// functions). Lives in carts/shared-sprites.js, not here, since it's cart
// convenience rather than part of the format itself.

/* ============================================================
   9. Disassembler + control-flow-graph extractor — reverses assemble()
   back into a labeled mnemonic listing, purely from raw bytecode + the
   shared OPS table, with no dependence on any cart's own symbol names
   (authoring-time CONST_NAMES/GLOBAL_NAMES maps never round-trip through
   the binary format). This is what makes decompiling *any* cart's
   bytecode — not just the ones this repo ships — possible: the Cart
   Inspector and the `/compile` tool both call this, never a copy of it.
   ============================================================ */
function disassembleHook(bytecode){
  const instrs = [];
  let ip = 0;
  function u8(){ return bytecode[ip++]; }
  function i16(){ const lo=bytecode[ip++], hi=bytecode[ip++]; let v=lo|(hi<<8); if(v & 0x8000) v -= 0x10000; return v; }
  function u16(){ const lo=bytecode[ip++], hi=bytecode[ip++]; return lo|(hi<<8); }
  while(ip < bytecode.length){
    const addr = ip;
    const op = bytecode[ip++];
    const opInfo = OPS[op];
    if(!opInfo){ instrs.push({addr, mnem:'DB', operands:[{type:'u8',value:op}], nextAddr:ip}); continue; }
    const [mnem, spec] = opInfo;
    const operands = [];
    for(const type of spec){
      if(type === 'u8') operands.push({type, value:u8()});
      else if(type === 'i16') operands.push({type, value:i16()});
      else if(type === 'addr') operands.push({type, value:u16()});
    }
    instrs.push({addr, mnem, operands, nextAddr:ip});
  }
  return instrs;
}
// Basic-block split + edge extraction, shared by the flat disassembly
// listing (labels blocks instead of raw byte offsets) and the flowchart.
function buildCFG(bytecode){
  const instrs = disassembleHook(bytecode);
  if(instrs.length === 0) return {instrs, blocks:[], edges:[]};
  const validAddr = new Set(instrs.map(ins=>ins.addr));
  const leaders = new Set([instrs[0].addr]);
  const isBranch = mnem => mnem==='JMP'||mnem==='JZ'||mnem==='JNZ';
  for(const ins of instrs){
    if(isBranch(ins.mnem)){
      const target = ins.operands[0].value;
      if(validAddr.has(target)) leaders.add(target);
      if(ins.nextAddr < bytecode.length) leaders.add(ins.nextAddr);
    } else if(ins.mnem === 'HALT' && ins.nextAddr < bytecode.length){
      leaders.add(ins.nextAddr);
    }
  }
  const sorted = [...leaders].sort((a,b)=>a-b);
  const blocks = sorted.map((addr,i) => ({
    id: i, startAddr: addr,
    endAddr: (i+1<sorted.length) ? sorted[i+1] : bytecode.length,
    instrs: [],
  }));
  for(const ins of instrs){
    const b = blocks.find(b => ins.addr >= b.startAddr && ins.addr < b.endAddr);
    if(b) b.instrs.push(ins);
  }
  const blockAtAddr = addr => blocks.find(b => addr >= b.startAddr && addr < b.endAddr);
  const edges = [];
  for(const b of blocks){
    if(b.instrs.length === 0) continue;
    const last = b.instrs[b.instrs.length-1];
    if(last.mnem === 'JMP'){
      const t = blockAtAddr(last.operands[0].value);
      if(t) edges.push({from:b.id, to:t.id, kind:'jump'});
    } else if(last.mnem === 'JZ' || last.mnem === 'JNZ'){
      const t = blockAtAddr(last.operands[0].value);
      if(t) edges.push({from:b.id, to:t.id, kind:'taken'});
      const ft = blockAtAddr(last.nextAddr);
      if(ft) edges.push({from:b.id, to:ft.id, kind:'fallthrough'});
    } else if(last.mnem !== 'HALT'){
      const ft = blockAtAddr(last.nextAddr);
      if(ft) edges.push({from:b.id, to:ft.id, kind:'fallthrough'});
    }
  }
  return {instrs, blocks, edges};
}
// Flat, labeled disassembly text — block boundaries from the same CFG
// split double as label points, so "B3:" here is literally the same
// block drawn as a box in the flowchart (see renderCFGSvg). This is also
// exactly the reverse direction of assemble()'s own label syntax — text
// formatDisassembly() emits re-assembles unchanged via assemble(), which
// is what makes /compile's disassembly pane round-trip.
function formatDisassembly(bytecode){
  const {blocks} = buildCFG(bytecode);
  if(blocks.length === 0) return '(empty)';
  const lines = [];
  for(const b of blocks){
    lines.push(`B${b.id}:`);
    for(const ins of b.instrs){
      const operandStrs = ins.operands.map(op =>
        op.type === 'addr' ? ('B' + (blocks.find(bb=>bb.startAddr===op.value)?.id ?? '?')) : String(op.value));
      lines.push('    ' + ins.mnem + (operandStrs.length ? ' ' + operandStrs.join(' ') : ''));
    }
  }
  return lines.join('\n');
}
const EDGE_COLOR = {jump:'#e0a030', taken:'#4a9d5f', fallthrough:'#8a7a5f'};
// Vertical-stack flowchart, blocks in address order top-to-bottom — plain
// SVG string-building, no DOM/canvas dependency, so this runs in Node too.
function renderCFGSvg(bytecode){
  const {blocks, edges} = buildCFG(bytecode);
  if(blocks.length === 0) return '<p class="inspect-empty">(empty hook)</p>';
  const boxW = 240, padX = 70, padY = 10, lineH = 13, headerH = 20;
  const boxX = padX;
  let y = padY;
  const positioned = blocks.map(b => {
    const h = headerH + b.instrs.length*lineH + 10;
    const box = {...b, x:boxX, y, w:boxW, h};
    y += h + 28;
    return box;
  });
  const totalH = y;
  const totalW = boxX + boxW + padX + 60;
  const byId = new Map(positioned.map(b=>[b.id,b]));
  let svg = `<svg viewBox="0 0 ${totalW} ${totalH}" width="100%" style="max-width:${totalW}px" xmlns="http://www.w3.org/2000/svg" font-family="ui-monospace,SFMono-Regular,Menlo,Consolas,monospace">`;
  svg += `<defs>` + Object.entries(EDGE_COLOR).map(([k,c]) =>
    `<marker id="arrow-${k}" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto"><path d="M0,0 L6,3 L0,6 Z" fill="${c}"/></marker>`).join('') + `</defs>`;
  for(const e of edges){
    const from = byId.get(e.from), to = byId.get(e.to);
    if(!from || !to) continue;
    const color = EDGE_COLOR[e.kind];
    const dash = e.kind==='jump' && to.id <= from.id ? 'stroke-dasharray="4 3"' : '';
    let d;
    if(to.id === from.id+1 && e.kind !== 'taken'){
      const x = from.x + boxW/2;
      d = `M${x},${from.y+from.h} L${x},${to.y}`;
    } else if(to.id > from.id){
      const x0 = from.x+boxW, y0 = from.y+from.h/2;
      const x1 = to.x+boxW, y1 = to.y+ (to.id===from.id ? to.h/2 : 6);
      const bow = x0 + 40;
      d = `M${x0},${y0} C${bow},${y0} ${bow},${y1} ${x1},${y1}`;
    } else {
      const x0 = from.x, y0 = from.y+from.h/2;
      const x1 = to.x, y1 = to.y+6;
      const bow = x0 - 50;
      d = `M${x0},${y0} C${bow},${y0} ${bow},${y1} ${x1},${y1}`;
    }
    svg += `<path d="${d}" fill="none" stroke="${color}" stroke-width="1.6" ${dash} marker-end="url(#arrow-${e.kind})"/>`;
  }
  for(const b of positioned){
    svg += `<rect x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" rx="4" fill="var(--bg-card,#1c1712)" stroke="var(--rule,#3a3025)"/>`;
    svg += `<text x="${b.x+10}" y="${b.y+14}" font-size="11" font-weight="700" fill="var(--accent,#e0a030)">B${b.id}</text>`;
    b.instrs.forEach((ins,i) => {
      const operandStrs = ins.operands.map(op =>
        op.type === 'addr' ? ('B' + (positioned.find(bb=>bb.startAddr===op.value)?.id ?? '?')) : String(op.value));
      const text = ins.mnem + (operandStrs.length ? ' '+operandStrs.join(' ') : '');
      svg += `<text x="${b.x+10}" y="${b.y+headerH+i*lineH+8}" font-size="10" fill="var(--ink,#efe6d2)">${text.replace(/&/g,'&amp;').replace(/</g,'&lt;')}</text>`;
    });
  }
  svg += `</svg>`;
  return svg;
}

/* ============================================================
   10. describeControls — derives the keyboard/touch hint text purely
   from a cart's own declared input layout (DESIGN.md §14/§15.1: no
   "both left+right means steering" special case — that was a
   racer-shaped assumption baked into supposedly generic UI text, wrong
   the moment a second cart used the same two bits for cardinal movement).
   ============================================================ */
function describeControls(cart){
  const parts = [];
  if(cart.inputActiveButtons & 1) parts.push('← = ' + (cart.inputButtonLabels[1] || 'left'));
  if(cart.inputActiveButtons & 2) parts.push('→ = ' + (cart.inputButtonLabels[2] || 'right'));
  if(cart.inputActiveButtons & 4) parts.push('↑ = ' + (cart.inputButtonLabels[4] || 'up'));
  if(cart.inputActiveButtons & 8) parts.push('↓ = ' + (cart.inputButtonLabels[8] || 'down'));
  if(cart.inputActiveButtons & 16) parts.push('space = ' + (cart.inputButtonLabels[16] || 'action'));
  if(cart.inputWantsPointer) parts.push('touch & drag');
  return parts.join(', ');
}

/* ============================================================
   11. Cart authoring/compiling helper — turns a plain "cart source"
   object (the same shape every carts/*.js builder function already
   returns: header fields as plain values, `hooks.<name>` as an array of
   assembly-mnemonic strings instead of bytecode) into a fully encoded,
   ready-to-play fragment. This is the one new piece of surface area the
   `/compile` tool needed that didn't already exist as a runtime-internal
   convention — every example cart was already "author a plain object,
   assemble its hook sources, encodeCart, encodePayload" by hand inside
   registerCart(); this just makes that sequence itself a reusable,
   Node-and-browser function with specific, line-numbered errors at
   every stage instead of a silent throw partway through.
   ============================================================ */
function defaultCartFields(){
  return {
    tileSurfaceOverrides: {}, camera: {followGlobal:255, clampMinX:0, clampMinY:0, clampMaxX:0, clampMaxY:0},
    aimLine: null, hudSpec: [], constants: [], entityTypes: [], sprites: [], tiles: [],
    mapGenerator: 0, inputButtonLabels: {}, inputWantsPointer: false,
  };
}
// `source` is a plain object like the carts/*.js builders return, except
// `source.hooks[name]` may be either an array of assembly-source lines
// (compiled here via assemble()) or an already-assembled Uint8Array
// (passed through as-is — useful for round-tripping a decompiled cart
// unmodified). `source.constNames`/`source.globalNames` (optional) are
// authoring-time-only name->index maps, exactly like every shipped
// cart's own FOO_CONST_NAMES/FOO_GLOBAL_NAMES, used only to resolve
// PUSHC/LOADG/STOREG/LOADE/STOREE mnemonic operands; they never affect
// the encoded bytes and are stripped before encodeCart sees the cart.
// `source.name`/`source.author` (optional) likewise never reach the binary
// format — they're carried into the returned `fragment`'s URL envelope
// instead (see encodeCartUrl above), the same "authoring-time metadata,
// stripped before encodeCart" treatment as constNames/globalNames.
// Async (unlike encodeCart/decodeCart) only because it ends in
// encodePayload(), which needs CompressionStream's async API.
async function compileCartSource(source){
  if(!source || typeof source !== 'object') throw new Error('compile: cart source must be an object');
  const cart = Object.assign(defaultCartFields(), source);
  delete cart.constNames; delete cart.globalNames;
  delete cart.name; delete cart.author;
  const sym = {constants: source.constNames || {}, globals: source.globalNames || {}};
  const hooks = {};
  for(const name of HOOK_NAMES){
    const h = source.hooks && source.hooks[name];
    if(!h){ hooks[name] = new Uint8Array(0); continue; }
    if(h instanceof Uint8Array){ hooks[name] = h; continue; }
    if(!Array.isArray(h)) throw new Error('compile: hooks.'+name+' must be an array of assembly lines or a Uint8Array, got '+typeof h);
    try{
      hooks[name] = assemble(h, sym);
    } catch(err){
      throw new Error('compile: in hook "'+name+'": '+err.message);
    }
  }
  cart.hooks = hooks;
  let bytes;
  try{
    bytes = encodeCart(cart);
  } catch(err){
    throw new Error('compile: encodeCart failed: '+err.message);
  }
  // Round-trip through decodeCart immediately: catches shape mistakes
  // (wrong-length arrays, out-of-range indices) that encodeCart itself
  // is too permissive to reject but that would fail every consumer
  // downstream (the runtime, the Inspector) with a much more confusing
  // error, far from the cart source that actually caused it.
  let decoded;
  try{
    decoded = decodeCart(bytes);
  } catch(err){
    throw new Error('compile: cart encoded but failed to round-trip through decodeCart (' + err.message + ') — this is a bug in the source data, not a transport issue');
  }
  const name = source.name || '', author = source.author || '';
  const fragment = encodeCartUrl(name, author, await encodePayload(bytes));
  return {cart: decoded, bytes, fragment, name, author};
}

return {
  OPS, OPINDEX, assemble, runHook, MAX_STEPS,
  b64urlEncode, b64urlDecode, HAS_COMPRESSION,
  deflateRawCompress, deflateRawDecompress, encodePayload, decodePayloadToBytes,
  encodeCartUrl, decodeCartUrl,
  ByteWriter, ByteReader, HOOK_NAMES, BUTTON_BITS,
  TOUCH_TEMPLATE_NONE, TOUCH_TEMPLATE_SINGLE, TOUCH_TEMPLATE_STEER_ACTION, TOUCH_TEMPLATE_DPAD_ACTION, TOUCH_TEMPLATE_DPAD_ONLY,
  SHAPE_ELLIPSE, SHAPE_RECT, writeString, readString,
  encodeCart, decodeCart, SUPPORTED_FORMAT_VERSIONS,
  hsl, generatePalette,
  TRACK_TOKENS, TILE_ROAD, TILE_RUMBLE, TILE_STARTLINE, TILE_CHECKPOINT, MAP_EDGE_TILE, buildTrack,
  CAVE_WALL, CAVE_FLOOR, CAVE_STAIRS, CAVE_GOLD, buildCave,
  PLATFORM_TOKENS, PLATFORM_WIDTH_TOKENS, PLATFORM_OPERAND_TOKENS,
  PLATFORM_AIR, PLATFORM_GROUND, PLATFORM_DIRT, PLATFORM_BRICK, buildPlatformLevel,
  buildBlankMap, applyMapShapes,
  renderShapeList,
  disassembleHook, buildCFG, formatDisassembly, renderCFGSvg, EDGE_COLOR,
  describeControls, defaultCartFields, compileCartSource,
};
});
