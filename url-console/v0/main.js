/* ============================================================
   The Urlcade — top-level wiring

   The one thing every other module needed to stay decoupled from: which
   view is active (shelf / game / Inspector) and how a URL hash maps to
   one of them. Everything here is composition — reaching into runtime.js
   and inspector.js's own exported entry points, never their internals
   (see runtime.js's stopGame()/showMenu() split and inspector.js's
   closeInspector() for why that split exists).

   This is the only <script type="module"> index.html loads; every other
   module is reached transitively through here or through each other.
   ============================================================ */
"use strict";
const K = window.UrlcadeKernel;
import * as Runtime from './runtime.js';
import * as Inspector from './inspector.js';
import { CARTS, registerAllCarts } from './carts/index.js';

function goToMenu(){
  Runtime.stopGame();
  Inspector.closeInspector();
  Runtime.showMenu();
  history.replaceState(null, '', location.pathname + location.search);
}

// Navigating away from whichever view is currently live always tears it
// down first — fixes a latent bug in the original single-scope version,
// where jumping straight from a live game to an `#inspect:` link left the
// game's step/render loop running invisibly in the background (nothing
// reset `running` on that path, only on the explicit "back to shelf"
// button). Splitting the modules apart is what surfaced it: it's no
// longer possible to *accidentally* reach into the other view's state,
// so the transition has to be named explicitly here instead.
async function boot(){
  const hash = location.hash.replace(/^#/, '');
  if(hash.startsWith('inspect:')){
    Runtime.stopGame();
    if(await Inspector.startInspect(hash.slice('inspect:'.length))) return;
    goToMenu();
    return;
  }
  Inspector.closeInspector();
  if(hash){
    // startGame() decodes the fragment directly — it doesn't need to be
    // one of the five shelf carts, just a validly-encoded one (any
    // /compile output, or a link a friend shared, works exactly the same
    // way). If it doesn't decode, fall into the Inspector's own
    // decode-error UI instead of duplicating that messaging here.
    if(await Runtime.startGame(hash)) return;
    if(await Inspector.startInspect(hash)) return;
  }
  goToMenu();
}

document.getElementById('backBtn').addEventListener('click', goToMenu);
document.getElementById('inspectBackBtn').addEventListener('click', goToMenu);
document.getElementById('inspectForm').addEventListener('submit', e => {
  e.preventDefault();
  const payload = Inspector.extractPayloadFromInput(document.getElementById('inspectInput').value);
  if(!payload) return;
  location.hash = 'inspect:' + payload;
});
window.addEventListener('hashchange', boot);

(async () => {
  await registerAllCarts();
  Runtime.renderMenu();
  await boot();
  Runtime.startLoop();
})();

// Debugging/testing surface only (see test/smoke.js) — not part of the
// authoring API kernel.js documents; nothing here is meant to be a
// stable contract for cart authors.
window.__urlcadeDebug = {
  CARTS, World: Runtime.World, getWorld: Runtime.getWorld, isUsingGL: Runtime.isUsingGL,
  forceRender: (a) => Runtime.render(a === undefined ? 1 : a),
  startInspect: Inspector.startInspect, extractPayloadFromInput: Inspector.extractPayloadFromInput,
  getInspectWorld: Inspector.getInspectWorld, getInspectCartInfo: Inspector.getInspectCartInfo,
  decodeCart: K.decodeCart, encodeCart: K.encodeCart, b64urlEncode: K.b64urlEncode, b64urlDecode: K.b64urlDecode,
  disassembleHook: K.disassembleHook, buildCFG: K.buildCFG, formatDisassembly: K.formatDisassembly, renderCFGSvg: K.renderCFGSvg,
  encodePayload: K.encodePayload, decodePayloadToBytes: K.decodePayloadToBytes,
  deflateRawCompress: K.deflateRawCompress, deflateRawDecompress: K.deflateRawDecompress,
  hasCompression: () => K.HAS_COMPRESSION,
};
