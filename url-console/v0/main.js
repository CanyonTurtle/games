/* ============================================================
   The Urlcade — top-level wiring

   The one thing every other module needed to stay decoupled from: which
   view is active (shelf / game / Debug) and how a URL hash maps to one
   of them. Everything here is composition — reaching into runtime.js
   and inspector.js's own exported entry points, never their internals
   (see runtime.js's stopGame()/pauseGame()/showMenu() split and
   inspector.js's closeInspector() for why that split exists).

   Three ways into Debug, one code path: a pasted/hash fragment
   (openDebug, used to be `#inspect:`), the game currently playing (the
   in-game "Debug" button — same hash shape, `#debug:<fragment>`, and
   openDebug() itself decides whether that fragment matches the live
   game and pauses instead of stopping it), and "+ New Cart" on the
   shelf (Inspector.startNewCart(), no fragment to route on yet).

   This is the only <script type="module"> index.html loads; every other
   module is reached transitively through here or through each other.
   ============================================================ */
"use strict";
const K = window.UrlcadeKernel;
import * as Runtime from './runtime.js';
import * as Inspector from './inspector.js';
import * as Multiplayer from './multiplayer.js';
import * as Avatars from './avatars.js';
import { CARTS, registerAllCarts } from './carts/index.js';

function goToMenu(){
  Multiplayer.closeLobby(); // leaves any open room rather than abandoning it silently in the background
  Runtime.stopGame();
  Inspector.closeInspector();
  Runtime.showMenu();
  history.replaceState(null, '', location.pathname + location.search);
}

// Debug can be reached two ways: from the game that's currently playing
// (the in-game "Debug" button), where the point is coming back to that
// *same* game afterward — or from anywhere else (a pasted link, "+ New
// Cart"), where there's no live game to come back to. Distinguished by
// whether a live game's own fragment matches what's being debugged,
// rather than a separate piece of routing state to keep in sync.
//
// The try/catch here is load-bearing, not decorative: this used to call
// Inspector.startInspect() unguarded, and an unguarded await whose
// promise nobody catches is an *invisible* failure — the tap registers,
// the click handler runs, and if anything inside throws, nothing
// happens on screen and nothing is logged anywhere a mobile user could
// see. That's exactly what "Debug/New Cart do nothing" turned out to
// be. See inspector.js's startInspect/startNewCart for the same fix.
async function openDebug(payload){
  Multiplayer.closeLobby(); // same reasoning as goToMenu() — never leave a room joined in the background
  const resuming = !!Runtime.getWorld() && Runtime.getCurrentFragment() === payload;
  if(resuming) Runtime.pauseGame(); else Runtime.stopGame();
  let ok = false;
  try{
    ok = await Inspector.startInspect(payload);
  } catch(err){
    console.error('openDebug failed:', err);
    document.getElementById('inspectError').textContent = 'Could not open Debug: ' + err.message;
  }
  if(ok) return true;
  if(resuming) Runtime.resumeGame(); else goToMenu();
  return false;
}

// Counterpart to openDebug()'s "resuming" branch: if there's still a
// live (paused) game underneath, resume it instead of dropping back to
// the shelf. Uses history.replaceState, not location.hash=, so this
// doesn't itself trigger another hashchange/boot() cycle — that would
// re-decode the fragment via startGame() and silently replace the
// resumed game with a fresh one, losing whatever progress it had.
function goBackFromDebug(){
  Inspector.closeInspector();
  if(Runtime.getWorld() && Runtime.resumeGame()){
    history.replaceState(null, '', location.pathname + location.search + '#' + Runtime.getCurrentFragment());
  } else {
    goToMenu();
  }
}

async function boot(){
  const hash = location.hash.replace(/^#/, '');
  if(hash.startsWith('debug:') || hash.startsWith('inspect:')){
    await openDebug(hash.slice(hash.indexOf(':') + 1));
    return;
  }
  Inspector.closeInspector();
  if(hash){
    // A join link (Multiplayer's own "Copy Link") tacks `&mp=<code>`
    // onto an ordinary game fragment so opening it is the whole "join a
    // match" step — see multiplayer.js's parseJoinLinkHash for why that
    // split is unambiguous. gameHash is what startGame()/startInspect()
    // below actually decode; code (if present) is handled after a
    // successful load, not before — a malformed or stale code shouldn't
    // stop the game itself from loading.
    const { gameHash, code } = Multiplayer.parseJoinLinkHash(hash);
    try{
      // startGame() decodes the fragment directly — it doesn't need to be
      // one of the five shelf carts, just a validly-encoded one (anything
      // Debug's Source/Compile tabs produce, or a link a friend shared,
      // works exactly the same way). If it doesn't decode, fall into
      // Debug's own decode-error UI instead of duplicating that messaging.
      if(await Runtime.startGame(gameHash)){
        const cart = Runtime.getWorld().cart;
        Multiplayer.updateMultiplayerButton(cart);
        if(code) Multiplayer.openLobbyAndJoin(cart, code);
        return;
      }
      if(await Inspector.startInspect(gameHash)) return;
    } catch(err){
      console.error('boot failed:', err);
    }
  }
  goToMenu();
}

// Site-wide audio toggle (index.html's small speaker icon next to
// Tinker) — one `localStorage`-backed on/off for every cart, defaulting
// to off (see runtime.js's `audioEnabled`). Pure UI reflection here: the
// actual mute/unmute and persistence both live in Runtime.setAudioEnabled.
function updateAudioToggleUI(){
  const btn = document.getElementById('audioToggleBtn');
  const on = Runtime.isAudioEnabled();
  btn.textContent = on ? '\u{1F50A}' : '\u{1F507}'; // 🔊 : 🔇
  btn.title = on ? 'Sound is on — click to mute' : 'Sound is off by default — click to turn it on';
  btn.setAttribute('aria-pressed', on ? 'true' : 'false');
}
document.getElementById('audioToggleBtn').addEventListener('click', () => {
  Runtime.setAudioEnabled(!Runtime.isAudioEnabled());
  updateAudioToggleUI();
});
updateAudioToggleUI();

// Player identity (Multiplayer Party, DESIGN.md §97+) — a chip on the
// shelf's own header, not the multiplayer overlay, since it's useful to
// set before ever starting a party. Always shows *something* (a
// placeholder when unset) rather than being blank, so there's always a
// visible thing to tap. selectedAvatarId is this picker's own transient
// UI state while the overlay is open — Runtime.getIdentity()/setIdentity
// remain the single source of truth otherwise, re-read fresh every time
// the overlay opens rather than assumed to still match what's on screen.
function renderIdentityChip(){
  const chip = document.getElementById('identityChip');
  const identity = Runtime.getIdentity();
  chip.innerHTML = '';
  chip.appendChild(Avatars.renderAvatarCanvas(identity.avatarId));
  const label = document.createElement('span');
  label.textContent = identity.name || 'Set your name';
  chip.appendChild(label);
}
let selectedAvatarId = 0;
function renderIdentityAvatarGrid(){
  const grid = document.getElementById('identityAvatarGrid');
  grid.innerHTML = '';
  Avatars.AVATARS.forEach((avatar, i) => {
    const swatch = document.createElement('button');
    swatch.type = 'button';
    swatch.className = 'identity-avatar-swatch' + (i === selectedAvatarId ? ' selected' : '');
    swatch.title = avatar.name;
    swatch.appendChild(Avatars.renderAvatarCanvas(i));
    swatch.addEventListener('click', () => { selectedAvatarId = i; renderIdentityAvatarGrid(); });
    grid.appendChild(swatch);
  });
}
function openIdentityPicker(){
  const identity = Runtime.getIdentity();
  document.getElementById('identityNameInput').value = identity.name;
  selectedAvatarId = identity.avatarId;
  renderIdentityAvatarGrid();
  document.getElementById('identityOverlay').classList.add('active');
}
function closeIdentityPicker(){
  document.getElementById('identityOverlay').classList.remove('active');
}
document.getElementById('identityChip').addEventListener('click', openIdentityPicker);
document.getElementById('identityCloseBtn').addEventListener('click', closeIdentityPicker);
document.getElementById('identityOverlay').addEventListener('click', e => {
  if(e.target.id === 'identityOverlay') closeIdentityPicker(); // scrim, not the card
});
document.getElementById('identitySaveBtn').addEventListener('click', () => {
  Runtime.setIdentity({name: document.getElementById('identityNameInput').value.trim(), avatarId: selectedAvatarId});
  renderIdentityChip();
  closeIdentityPicker();
});
renderIdentityChip();

document.getElementById('backBtn').addEventListener('click', goToMenu);
// startGame() re-decodes the current fragment from scratch and rebuilds
// the World, re-running on_init — exactly what "start this game over"
// means, with no special-cased reset path needed per cart.
document.getElementById('restartBtn').addEventListener('click', async () => {
  const fragment = Runtime.getCurrentFragment();
  if(!fragment) return;
  try{
    await Runtime.startGame(fragment);
    Multiplayer.updateMultiplayerButton(Runtime.getWorld().cart);
  } catch(err){
    console.error('restart failed:', err);
  }
});
Multiplayer.initMultiplayerUI();
document.getElementById('multiplayerBtn').addEventListener('click', () => {
  const world = Runtime.getWorld();
  if(world) Multiplayer.openLobby(world.cart);
});
document.getElementById('inspectBackBtn').addEventListener('click', goBackFromDebug);
document.getElementById('debugBtn').addEventListener('click', () => {
  location.hash = 'debug:' + Runtime.getCurrentFragment();
});
// Same fragment-swap behavior "Play this version" always had — plays the
// currently-compiled edit, does not persist it anywhere. Disabled (see
// inspector.js's renderInspectTabs) whenever the live edit doesn't compile.
document.getElementById('inspectTryBtn').addEventListener('click', () => {
  const state = Inspector.getCompileState();
  if(state && state.ok) location.hash = state.fragment;
});
// Inspector.startNewCart() catches its own errors (see its source) and
// never rejects — awaited here anyway, and not left as a bare unawaited
// call, so a future regression there fails loudly during development
// instead of silently doing nothing on a real device again.
document.getElementById('newCartBtn').addEventListener('click', async () => {
  Runtime.stopGame();
  await Inspector.startNewCart();
});
document.getElementById('inspectForm').addEventListener('submit', e => {
  e.preventDefault();
  const payload = Inspector.extractPayloadFromInput(document.getElementById('inspectInput').value);
  if(!payload) return;
  location.hash = payload; // just play it — boot()'s normal routing (+ its Debug fallback) takes it from there
});
window.addEventListener('hashchange', boot);
// Last-resort net: logs anything that still slips past the try/catches
// above (or in some as-yet-unguarded corner) instead of leaving it as a
// completely silent, unreported failure. Doesn't itself show the user
// anything — the specific paths above already do that where it matters.
window.addEventListener('unhandledrejection', e => console.error('Unhandled rejection:', e.reason));

(async () => {
  try{
    await registerAllCarts();
    await Runtime.renderMenu();
    await boot();
    Runtime.startLoop();
  } catch(err){
    console.error('Startup failed:', err);
    // #inspectError only shows while #menu itself is the active view — a
    // startup failure this early may mean showMenu() itself never ran.
    Runtime.showMenu();
    document.getElementById('inspectError').textContent = 'Startup failed: ' + err.message;
  }
})();

// Debugging/testing surface only (see test/smoke.js) — not part of the
// authoring API kernel.js documents; nothing here is meant to be a
// stable contract for cart authors.
window.__urlcadeDebug = {
  CARTS, World: Runtime.World, getWorld: Runtime.getWorld, isUsingGL: Runtime.isUsingGL,
  getCurrentFragment: Runtime.getCurrentFragment, pauseGame: Runtime.pauseGame, resumeGame: Runtime.resumeGame,
  forceRender: (a) => Runtime.render(a === undefined ? 1 : a),
  startInspect: Inspector.startInspect, startNewCart: Inspector.startNewCart,
  extractPayloadFromInput: Inspector.extractPayloadFromInput,
  getInspectWorld: Inspector.getInspectWorld, getInspectCartInfo: Inspector.getInspectCartInfo,
  getCompileState: Inspector.getCompileState, getHookTexts: Inspector.getHookTexts,
  decodeCart: K.decodeCart, encodeCart: K.encodeCart, b64urlEncode: K.b64urlEncode, b64urlDecode: K.b64urlDecode,
  disassembleHook: K.disassembleHook, buildCFG: K.buildCFG, formatDisassembly: K.formatDisassembly, renderCFGSvg: K.renderCFGSvg,
  compileCartSource: K.compileCartSource,
  encodeCartUrl: K.encodeCartUrl, decodeCartUrl: K.decodeCartUrl,
  encodePayload: K.encodePayload, decodePayloadToBytes: K.decodePayloadToBytes,
  deflateRawCompress: K.deflateRawCompress, deflateRawDecompress: K.deflateRawDecompress,
  hasCompression: () => K.HAS_COMPRESSION,
  isAudioEnabled: Runtime.isAudioEnabled, setAudioEnabled: Runtime.setAudioEnabled,
  getIdentity: Runtime.getIdentity, setIdentity: Runtime.setIdentity,
  AVATARS: Avatars.AVATARS, renderAvatarCanvas: Avatars.renderAvatarCanvas,
  // Multiplayer (DESIGN.md §79) — openLobby's optional {joinRoomFn} lets
  // this drive the full lobby UI/state-machine with a mock transport,
  // the only way to exercise it without reaching a real signaling
  // network this sandbox/CI can't reach (see multiplayer.js's own note).
  openMultiplayerLobby: Multiplayer.openLobby, closeMultiplayerLobby: Multiplayer.closeLobby,
  hostMatch: Multiplayer.hostMatch, joinMatch: Multiplayer.joinMatch,
  startMatchSync: Multiplayer.startMatchSync,
  openLobbyAndJoin: Multiplayer.openLobbyAndJoin, parseJoinLinkHash: Multiplayer.parseJoinLinkHash,
  appIdForCart: Multiplayer.appIdForCart,
};
