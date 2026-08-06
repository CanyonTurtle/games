/* ============================================================
   The Urlcade — multiplayer signaling, lobby, and gameplay sync
   (DESIGN.md §79, §80)

   Two layers. First: wraps the vendored Trystero (vendor/trystero/,
   torrent strategy — see that directory's own README for why this one
   strategy/why vendored) into the small surface this project's match
   UI needs — join a room keyed by a short human-shareable code, get
   told when a peer connects or disconnects, and know which of the (up
   to 2 — v1's hard architectural cap, matching maxPlayers' own ceiling
   in kernel.js and the rollback ring buffer's 2-player assumption,
   DESIGN.md §78) player slots is "you" (connectToRoom/hostMatch/
   joinMatch, plus the lobby UI at the bottom of this file). Second:
   startMatchSync wires a *connected* room's makeAction() into
   World.inputs[] and DESIGN.md §78's resimulateFrom() — the actual
   gameplay sync, once there's a connected room to drive it with.
   ============================================================ */
import { joinRoom as trysteroJoinRoom, selfId } from './vendor/trystero/torrent.mjs';
import { hashCartBytes, startGame, getCurrentFragment, getWorld, setPerTickHook } from './runtime.js';

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
  session._room = room; // startMatchSync (below) needs makeAction() once the match actually starts syncing
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

// A join link bundles this exact game with a room code, so opening it is
// the recipient's whole "join" step — no separately-communicated code to
// read off another screen and type in by hand. `&mp=<code>` is appended
// directly to the fragment rather than carried as a real query string
// (there's nowhere else to put it: everything after `#` is the fragment,
// and a second `#` isn't legal in a URL) — safe to just concatenate,
// since a cart fragment's own alphabet (base64url payload, URI-encoded
// name/author, see kernel.js's encodeCartUrl) never contains `&`, so this
// suffix can't be confused with anything the fragment itself produced.
// parseJoinLinkHash is the exact inverse, used by main.js's boot() (and
// exercised directly by test/smoke.js, without needing a live match to
// verify the split itself).
function parseJoinLinkHash(hash){
  const m = hash.match(/&mp=([^&]+)$/);
  return m ? { gameHash: hash.slice(0, m.index), code: m[1] } : { gameHash: hash, code: null };
}
function buildJoinLink(roomCode){
  const fragment = getCurrentFragment();
  if(!fragment) return null;
  return location.origin + location.pathname + location.search + '#' + fragment + '&mp=' + roomCode;
}

// navigator.clipboard.writeText needs a secure context (https, or
// localhost for local dev — both satisfied for every real deployment of
// this site) but not always a user gesture depending on the browser;
// either way this only ever runs from a real click. Falls back to the
// old execCommand('copy') path — deprecated but still universally
// supported — only when the modern API is missing entirely or itself
// rejects (e.g. a permissions-policy blocking it in some embed contexts).
async function copyToClipboard(text){
  if(navigator.clipboard && navigator.clipboard.writeText){
    try{ await navigator.clipboard.writeText(text); return true; } catch(err){ /* fall through */ }
  }
  try{
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
    return true;
  } catch(err){
    return false;
  }
}

let copyFeedbackTimer = null;
async function copyJoinLink(roomCode, btn){
  const link = buildJoinLink(roomCode);
  if(!link) return;
  const original = btn.textContent;
  const ok = await copyToClipboard(link);
  if(!btn.isConnected) return; // the lobby re-rendered or closed while the (async) copy was in flight
  clearTimeout(copyFeedbackTimer);
  btn.textContent = ok ? 'Copied!' : 'Copy failed';
  copyFeedbackTimer = setTimeout(() => { if(btn.isConnected) btn.textContent = original; }, 1500);
}

// How many ticks of input history to keep around — must match (or
// exceed) World's own ROLLBACK_WINDOW (runtime.js, currently 8): a
// correction for a tick older than that fails at the World level
// regardless of whether this controller remembers it, so there's no
// benefit to keeping more, and keeping less would make a correction
// fail here even when the World could still have handled it.
const SYNC_HISTORY_TICKS = 8;
function pruneOld(map, currentTick){
  for(const t of map.keys()) if(t <= currentTick - SYNC_HISTORY_TICKS) map.delete(t);
}

// Wires a connected session's room to an actual live World, syncing
// gameplay input between the two peers (DESIGN.md §80) — everything
// before this point (§79) only got two peers *finding* each other.
//
// Approach: every tick, each peer sends its own player-slot's input
// mask, tagged with the tick number it's for, over a Trystero action.
// The *local* player's input for a not-yet-confirmed remote tick is
// never in question (it's this peer's own, recorded the instant it's
// sent) — only the *remote* player's input for a tick that hasn't
// arrived yet needs a guess, and the simplest predictor that works
// here is "repeat the last confirmed value" (a held button usually
// stays held/released from one 16ms tick to the next; standard for
// small-scale rollback netcode, not a shortcut specific to this
// project). When the real value for an already-simulated tick turns
// out to differ from the guess, World.resimulateFrom() (DESIGN.md §78)
// rewinds and replays with the corrected history — the entire reason
// that machinery was built two rounds before there was a network to
// drive it with.
//
// Returns a {stop} handle; runtime.js's setPerTickHook is what actually
// invokes this every tick (wired by the caller, see main.js).
function startMatchSync(session, world){
  const localSlot = session.playerSlot;
  const remoteSlot = localSlot === 0 ? 1 : 0;
  const inputAction = session._room.makeAction('input');

  const localInputHistory = new Map();   // tick -> this peer's own mask (always exact, it's our own input)
  const remoteConfirmed = new Map();     // tick -> the real mask the remote peer actually sent for it
  const remoteUsed = new Map();          // tick -> whatever mask was actually fed into world.inputs[remoteSlot] when that tick ran (confirmed if it had arrived in time, predicted otherwise)
  let lastConfirmedRemoteTick = -1;      // guards against an out-of-order message overwriting a newer prediction basis with a stale one
  let lastConfirmedRemoteMask = 0;

  function inputsForTick(t){
    const inputs = [0, 0, 0, 0];
    inputs[localSlot] = localInputHistory.get(t) ?? 0;
    const remote = remoteConfirmed.has(t) ? remoteConfirmed.get(t) : lastConfirmedRemoteMask;
    remoteUsed.set(t, remote);
    inputs[remoteSlot] = remote;
    return inputs;
  }

  inputAction.onMessage(data => {
    const { tick, mask } = data;
    remoteConfirmed.set(tick, mask);
    pruneOld(remoteConfirmed, world.tick);
    if(tick >= lastConfirmedRemoteTick){ lastConfirmedRemoteTick = tick; lastConfirmedRemoteMask = mask; }
    if(tick <= world.tick){
      // Already simulated this tick, possibly on a guess — check.
      const used = remoteUsed.get(tick);
      if(used !== undefined && used !== mask){
        world.resimulateFrom(tick, inputsForTick);
        // A {ok:false} result (the tick has already fallen out of
        // World's own rollback window) is a known, accepted gap this
        // round doesn't close — see this file's own module comment and
        // DESIGN.md §80. Nothing further to do locally either way: the
        // world is now either corrected, or has silently drifted from
        // the peer's, with no full-resync fallback yet to recover it.
      }
    }
  });

  function beforeTick(w){
    const tick = w.tick + 1;
    const localMask = w.inputs[localSlot];
    localInputHistory.set(tick, localMask);
    pruneOld(localInputHistory, tick);
    inputAction.send({ tick, mask: localMask });
    w.inputs = inputsForTick(tick);
  }

  return { beforeTick };
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
let activeSync = null; // the startMatchSync() handle for the current 'connected' session, if any
// Bumped every time beginSyncedMatch starts, and checked after its one
// await — guards against a peer leaving (or this side closing the
// lobby) while that restart is still in flight, which would otherwise
// let a since-superseded call attach a sync/hook after the match it
// belonged to has already ended. A plain counter rather than an
// AbortController: nothing here needs to actually cancel startGame()
// mid-flight, just to notice it's stale once it resolves.
let matchGeneration = 0;

function stopSync(){
  matchGeneration++;
  setPerTickHook(null);
  activeSync = null;
  // The World itself isn't torn down when a match ends (the player may
  // keep playing solo on it afterward) — so its multiplayerActive flag
  // (DESIGN.md §81, gates STORE_PERSIST) needs clearing explicitly here
  // rather than going away with the rest of the match state.
  const world = getWorld();
  if(world){ world.multiplayerActive = false; world.localPlayerSlot = 0; }
  document.getElementById('restartBtn').style.display = '';
}

function closeLobby(){
  stopSync();
  if(activeSession) activeSession.leave();
  if(unsubscribeSession) unsubscribeSession();
  activeSession = null;
  unsubscribeSession = null;
  lobbyMode = 'choice';
  document.getElementById('mpOverlay').classList.remove('active');
}

// Fires once per 'connected' transition (including a reconnect after
// 'peer-left' — see handleSessionStateChange below): restarts the game
// fresh so both peers begin ticking from the exact same on_init state
// (the World that was already running single-player has no reason to
// agree with the peer's — different play sessions, different RNG
// progress, different entity state), then wires the fresh World's
// per-tick hook to this session's sync controller. Hides the modal
// rather than closing it — closeLobby() would also leave the room.
async function beginSyncedMatch(session){
  document.getElementById('mpOverlay').classList.remove('active');
  const fragment = getCurrentFragment();
  if(!fragment) return;
  const generation = ++matchGeneration;
  await startGame(fragment);
  if(generation !== matchGeneration) return; // superseded — the peer already left (or this side closed) while startGame() was in flight
  const world = getWorld();
  if(!world) return;
  world.multiplayerActive = true; // gates STORE_PERSIST off for the match's duration, DESIGN.md §81
  world.localPlayerSlot = session.playerSlot; // this peer's own camera/HUD offset, DESIGN.md §82
  activeSync = startMatchSync(session, world);
  setPerTickHook(activeSync.beforeTick);
  // Restarting mid-match has no well-defined meaning yet (both peers
  // would need to agree and re-sync, out of scope this round) — hidden
  // rather than left to silently desync the match if clicked, the same
  // "prevent the broken path outright" posture as the stray-3rd-peer
  // guard in connectToRoom above. Restored by stopSync() once the match
  // ends (peer-left or closeLobby()).
  document.getElementById('restartBtn').style.display = 'none';
}

function statusDot(kind){ return `<span class="mp-status-dot mp-${kind}"></span>`; }

function renderSessionBody(session){
  const s = session.state;
  if(s === 'waiting-for-peer'){
    const hosting = session._role === 'host';
    return `
      <h3>${hosting ? 'Hosting a match' : 'Joining a match'}</h3>
      ${hosting ? `<p>Send this link to a friend, or share the code below:</p><div class="mp-room-code">${esc(session.roomCode)}</div>` : ''}
      <div class="mp-status">${statusDot('pending')} ${hosting ? 'Waiting for your friend to join…' : `Connecting to ${esc(session.roomCode)}…`}</div>
      <p>The match starts the moment they join — no account, no server,
      just this browser talking directly to theirs.</p>
      <div class="mp-actions">${hosting ? '<button id="mpCopyLinkBtn" class="mp-primary">Copy Link</button>' : ''}<button id="mpCancelBtn">Cancel</button></div>
    `;
  }
  if(s === 'connected'){
    // Normally never seen — beginSyncedMatch() hides the modal for
    // this state almost immediately. Still rendered defensively in
    // case that async transition (it awaits startGame()) hasn't
    // finished by the time this runs.
    return `
      <h3>Connected!</h3>
      <div class="mp-status">${statusDot('good')} You're Player ${session.playerSlot + 1} of 2 — starting the match…</div>
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
    const copyLinkBtn = document.getElementById('mpCopyLinkBtn');
    if(copyLinkBtn) copyLinkBtn.addEventListener('click', () => copyJoinLink(activeSession.roomCode, copyLinkBtn));
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

// The single listener driving both the modal's contents and the actual
// match lifecycle for as long as a session is active — including while
// the modal itself is hidden (mid-match, see beginSyncedMatch), which
// is exactly why this is a dedicated subscription rather than a
// render-only one: 'peer-left' needs to stop the sync hook and bring
// the (currently hidden) modal back, not just re-render whatever's
// already showing.
function handleSessionStateChange(state, session){
  if(state === 'connected'){
    beginSyncedMatch(session);
    return;
  }
  if(state === 'peer-left'){
    stopSync();
    document.getElementById('mpOverlay').classList.add('active');
  }
  renderLobby();
}

let lobbyCart = null;
let lobbyOpts = undefined;
function startSession(role, code){
  activeSession = role === 'host' ? hostMatch(lobbyCart, lobbyOpts) : joinMatch(lobbyCart, code, lobbyOpts);
  activeSession._role = role;
  unsubscribeSession = activeSession.onStateChange(handleSessionStateChange);
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

// Auto-join counterpart to openLobby() — used when a join link (Copy
// Link, above) already carries a room code, so the person who opened it
// never sees the Host/Join choice screen at all: straight to
// startSession('join', code), same as if they'd typed that exact code
// into the join form themselves. main.js's boot() is the only real
// caller (via parseJoinLinkHash on the incoming hash); test/smoke.js
// reaches it directly with a mock joinRoomFn, same pattern as openLobby.
function openLobbyAndJoin(cart, code, opts){
  lobbyCart = cart;
  lobbyOpts = opts;
  document.getElementById('mpOverlay').classList.add('active');
  startSession('join', code);
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
  openLobby, openLobbyAndJoin, closeLobby, updateMultiplayerButton, initMultiplayerUI,
  startMatchSync, parseJoinLinkHash,
};
