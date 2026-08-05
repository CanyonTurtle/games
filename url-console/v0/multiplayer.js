/* ============================================================
   The Urlcade — multiplayer match signaling (DESIGN.md §79)

   Wraps the vendored Trystero (vendor/trystero/, torrent strategy — see
   that directory's own README for why this one strategy/why vendored)
   into the small surface this project's match UI actually needs: join
   a room keyed by a short human-shareable code, get told when a peer
   connects or disconnects, and know which of the (up to 2 — v1's hard
   architectural cap, matching maxPlayers' own ceiling in kernel.js and
   the rollback ring buffer's 2-player assumption, DESIGN.md §78) player
   slots is "you."

   Deliberately stops there. No gameplay/input syncing lives in this
   file yet — wiring a connected room's makeAction() into World.inputs[]
   and DESIGN.md §78's resimulateFrom() is real, separate work for a
   later round, once there's an actual connected room to drive it with.
   ============================================================ */
import { joinRoom as trysteroJoinRoom, selfId } from './vendor/trystero/torrent.mjs';
import { hashCartBytes } from './runtime.js';

// kernel.js loads as a plain (non-module) <script> before this file —
// see index.html's own script-tag comment — so its exports land on
// window.UrlcadeKernel rather than being import-able here, the same
// convention runtime.js's own `const K = window.UrlcadeKernel` already
// uses. hashCartBytes itself lives in runtime.js, not kernel.js, so it's
// imported directly above instead — ES modules dedupe by URL, so this
// doesn't re-run runtime.js's own module-init a second time regardless
// of import order relative to main.js's.
const K = window.UrlcadeKernel;

// No 0/O/1/I — the four characters most likely to be misread or
// mistyped from a screen, since a room code is meant to be read aloud
// or typed by hand, not copy-pasted like the cart fragment itself is.
const ROOM_CODE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const ROOM_CODE_LENGTH = 5;

function generateRoomCode(){
  let code = '';
  for(let i=0;i<ROOM_CODE_LENGTH;i++){
    code += ROOM_CODE_ALPHABET[Math.floor(Math.random() * ROOM_CODE_ALPHABET.length)];
  }
  return code;
}

// Namespaces a room to this exact cart's content, not just "this app" —
// a host and a guest only ever find each other if they're looking at
// byte-identical carts, so a hand-edited/recompiled variant of "the
// same" cart gets its own room space rather than colliding with (or
// silently connecting a player into) a differently-tuned build of it.
// Reuses the exact hash runtime.js already computes for the persist
// key (DESIGN.md §69) — one hashing scheme for "identify this cart's
// content," not two.
function appIdForCart(cart){
  return 'urlcade-mp-' + hashCartBytes(K.encodeCart(cart));
}

// A session wraps one joined Trystero room end to end: the room code,
// current connection state, this peer's assigned slot (0 or 1) once a
// second peer is present, and a subscribe/unsubscribe pair for state
// changes. Built identically whether hosting (a freshly generated
// code) or joining (a typed-in one) — Trystero's own joinRoom() is
// symmetric; only which code gets used differs, see hostMatch/joinMatch
// below.
//
// States: 'waiting-for-peer' (in the room, alone) -> 'connected' (a
// second peer joined, playerSlot is now 0 or 1) -> 'peer-left' (that
// peer disconnected; a new onPeerJoin from here goes straight back to
// 'connected', same as a first join) -> 'left' (this peer called
// .leave()). 'error' only if joinRoomFn itself throws synchronously
// (a config bug, not a live network failure — Trystero's own signaling
// connects in the background and has no synchronous "the network is
// unreachable" signal to catch here).
function connectToRoom(cart, roomCode, {joinRoomFn = trysteroJoinRoom} = {}){
  const listeners = new Set();
  const session = {
    roomCode,
    selfId,
    state: 'waiting-for-peer',
    peerId: null,
    playerSlot: null,
    error: null,
    onStateChange(fn){ listeners.add(fn); return () => listeners.delete(fn); },
  };
  function setState(next){
    session.state = next;
    for(const fn of listeners) fn(session.state, session);
  }
  function assignSlot(){
    if(!session.peerId){ session.playerSlot = null; return; }
    // Deterministic and symmetric — both peers independently sort the
    // same two ids and land on the same answer, no host-says-so
    // handshake required.
    const sorted = [selfId, session.peerId].slice().sort();
    session.playerSlot = sorted.indexOf(selfId);
  }
  let room;
  try{
    room = joinRoomFn({appId: appIdForCart(cart)}, roomCode);
  } catch(err){
    session.error = err.message;
    setState('error');
    session.leave = () => {};
    return session;
  }
  room.onPeerJoin = peerId => {
    if(session.peerId) return; // a 3rd peer is outside v1's 2-player cap — see this file's own header comment; never becomes "the" opponent
    session.peerId = peerId;
    assignSlot();
    setState('connected');
  };
  room.onPeerLeave = peerId => {
    if(peerId !== session.peerId) return;
    session.peerId = null;
    session.playerSlot = null;
    setState('peer-left');
  };
  session.leave = () => {
    room.leave();
    setState('left');
  };
  return session;
}

function hostMatch(cart, opts){
  return connectToRoom(cart, generateRoomCode(), opts);
}
// Room codes are generated uppercase (ROOM_CODE_ALPHABET); normalized
// the same way here so a guest typing/pasting one in lowercase, or with
// stray whitespace, still matches.
function joinMatch(cart, roomCode, opts){
  return connectToRoom(cart, String(roomCode).trim().toUpperCase(), opts);
}

/* ============================================================
   Lobby UI — renders into index.html's #mpOverlay/#mpBody, wired once
   from main.js's boot (initMultiplayerUI). Kept in this file rather
   than main.js, the same way inspector.js co-locates its own state and
   rendering instead of leaving main.js to reach into its internals.
   ============================================================ */
function esc(s){ return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;'); }

let activeSession = null; // the connectToRoom() session currently shown, or null before Host/Join is chosen
let lobbyMode = 'choice'; // 'choice' | 'join-form' — only meaningful while activeSession is null
let unsubscribeSession = null;

function closeLobby(){
  if(activeSession) activeSession.leave();
  if(unsubscribeSession) unsubscribeSession();
  activeSession = null;
  unsubscribeSession = null;
  lobbyMode = 'choice';
  document.getElementById('mpOverlay').classList.remove('active');
}

function statusDot(kind){ return `<span class="mp-status-dot mp-${kind}"></span>`; }

function renderSessionBody(session){
  const s = session.state;
  if(s === 'waiting-for-peer'){
    const hosting = session._role === 'host';
    return `
      <h3>${hosting ? 'Hosting a match' : 'Joining a match'}</h3>
      ${hosting ? `<p>Share this code with a friend:</p><div class="mp-room-code">${esc(session.roomCode)}</div>` : ''}
      <div class="mp-status">${statusDot('pending')} ${hosting ? 'Waiting for your friend to join…' : `Connecting to ${esc(session.roomCode)}…`}</div>
      <p>Connection only, for now — synchronized gameplay is coming in a
      future update. This proves two browsers can find and reach each
      other with no server in between.</p>
      <div class="mp-actions"><button id="mpCancelBtn">Cancel</button></div>
    `;
  }
  if(s === 'connected'){
    return `
      <h3>Connected!</h3>
      <div class="mp-status">${statusDot('good')} You're Player ${session.playerSlot + 1} of 2.</div>
      <p>Connection only, for now — synchronized gameplay is coming in a
      future update.</p>
      <div class="mp-actions"><button id="mpCancelBtn">Close</button></div>
    `;
  }
  if(s === 'peer-left'){
    return `
      <h3>Opponent disconnected</h3>
      <div class="mp-status">${statusDot('bad')} Still in room ${esc(session.roomCode)} — waiting for them to reconnect…</div>
      <div class="mp-actions"><button id="mpCancelBtn">Close</button></div>
    `;
  }
  if(s === 'error'){
    return `
      <h3>Couldn't start multiplayer</h3>
      <div class="mp-status">${statusDot('bad')} ${esc(session.error || 'Unknown error')}</div>
      <div class="mp-actions"><button id="mpBackBtn">Back</button><button id="mpCancelBtn">Close</button></div>
    `;
  }
  return ''; // 'left' — closeLobby() already hid the overlay by the time this could render
}

function renderLobby(){
  const body = document.getElementById('mpBody');
  if(activeSession){
    body.innerHTML = renderSessionBody(activeSession);
    const cancelBtn = document.getElementById('mpCancelBtn');
    if(cancelBtn) cancelBtn.addEventListener('click', closeLobby);
    const backBtn = document.getElementById('mpBackBtn');
    if(backBtn) backBtn.addEventListener('click', () => {
      if(activeSession) activeSession.leave();
      if(unsubscribeSession) unsubscribeSession();
      activeSession = null;
      unsubscribeSession = null;
      lobbyMode = 'choice';
      renderLobby();
    });
    return;
  }
  if(lobbyMode === 'join-form'){
    body.innerHTML = `
      <h3>Join a match</h3>
      <p>Enter the code your friend shared with you.</p>
      <input type="text" id="mpJoinCode" maxlength="8" placeholder="ROOM CODE" autocomplete="off" autocapitalize="characters">
      <div class="mp-actions">
        <button id="mpJoinConnectBtn" class="mp-primary">Connect</button>
        <button id="mpBackBtn">Back</button>
      </div>
    `;
    document.getElementById('mpBackBtn').addEventListener('click', () => { lobbyMode = 'choice'; renderLobby(); });
    document.getElementById('mpJoinConnectBtn').addEventListener('click', () => {
      const code = document.getElementById('mpJoinCode').value;
      if(!code.trim()) return;
      startSession('join', code);
    });
    return;
  }
  body.innerHTML = `
    <h3>Multiplayer</h3>
    <p>Play this cart with a friend — no account, no server, just a code
    to share.</p>
    <div class="mp-actions">
      <button id="mpHostBtn" class="mp-primary">Host a match</button>
      <button id="mpJoinBtn">Join a match</button>
    </div>
  `;
  document.getElementById('mpHostBtn').addEventListener('click', () => startSession('host'));
  document.getElementById('mpJoinBtn').addEventListener('click', () => { lobbyMode = 'join-form'; renderLobby(); });
}

let lobbyCart = null;
let lobbyOpts = undefined;
function startSession(role, code){
  activeSession = role === 'host' ? hostMatch(lobbyCart, lobbyOpts) : joinMatch(lobbyCart, code, lobbyOpts);
  activeSession._role = role;
  unsubscribeSession = activeSession.onStateChange(renderLobby);
  renderLobby();
}

// Opens the lobby modal for `cart` — the caller (main.js) is responsible
// for only ever calling this when cart.maxPlayers >= 2 (the "Multiplayer"
// button is itself hidden otherwise, see updateMultiplayerButton below).
// `opts` (an optional {joinRoomFn}) passes straight through to
// hostMatch/joinMatch — main.js's real button click never supplies one
// (so real Trystero is used), but test/smoke.js reaches this same
// function via window.__urlcadeDebug with a mock, to drive the full
// lobby UI/state-machine wiring without ever touching the real network
// (see this repo's own note on why live P2P can't be tested here).
function openLobby(cart, opts){
  lobbyCart = cart;
  lobbyOpts = opts;
  lobbyMode = 'choice';
  document.getElementById('mpOverlay').classList.add('active');
  renderLobby();
}

// Shows/hides index.html's "Multiplayer" topbar button based on whether
// the currently-loaded cart opted into it — called from main.js right
// after every successful Runtime.startGame().
function updateMultiplayerButton(cart){
  document.getElementById('multiplayerBtn').style.display = (cart && cart.maxPlayers >= 2) ? '' : 'none';
}

function initMultiplayerUI(){
  document.getElementById('mpCloseBtn').addEventListener('click', closeLobby);
  document.getElementById('mpOverlay').addEventListener('click', e => {
    if(e.target.id === 'mpOverlay') closeLobby(); // click on the scrim itself, not the card
  });
}

export {
  hostMatch, joinMatch, connectToRoom, generateRoomCode, appIdForCart, selfId,
  openLobby, closeLobby, updateMultiplayerButton, initMultiplayerUI,
};
