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
import { joinRoom as trysteroJoinRoom, selfId, getRelaySockets } from './vendor/trystero/torrent.mjs';
import { startGame, getCurrentFragment, getWorld, setPerTickHook, getIdentity } from './runtime.js';
import { CARTS } from './carts/index.js';
import * as Avatars from './avatars.js';

// kernel.js loads as a plain (non-module) <script> before this file —
// see index.html's own script-tag comment — so its exports land on
// window.UrlcadeKernel rather than being import-able here, the same
// convention runtime.js's own `const K = window.UrlcadeKernel` already
// uses.
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

// One fixed room topic for the whole party — not a hash of whatever
// cart happens to be loaded (DESIGN.md §97: Multiplayer Party Stage 1).
// A single persistent room lets two peers play several games in a row
// without a fresh signaling handshake between each one, which is the
// whole point of a "party." The guarantee that used to come from a
// cart-derived topic — two peers who find each other are running
// byte-identical game logic, required by the deterministic rollback-sync
// engine — is replaced by an *explicit* one instead: whichever peer adds
// a game to the shared queue sends the literal compiled fragment string
// over this room, and a match always starts from that exact,
// peer-verified payload (see addToQueue/startMatch below), never from
// "whatever's currently loaded locally." That's a stronger guarantee
// than the old one — a version mismatch becomes a legible protocol
// issue instead of two peers silently never finding each other.
const PARTY_APP_ID = 'urlcade-mp-party-v1';

// Confirmed via a real two-device attempt (DESIGN.md §95): Trystero's own
// onJoinError fired with "could not connect to peer X after exchanging
// SDP" — signaling (the tracker-brokered offer/answer exchange, DESIGN.md
// §85-92's whole arc) genuinely succeeds; only the actual WebRTC/ICE
// connection between the two peers fails, the standard signature of a
// NAT (or NAT-like network interference — cellular CGNAT, a restrictive
// network, possibly iCloud Private Relay) that STUN alone can't punch
// through. TURN is the standard, user-transparent answer: a relay
// server WebRTC falls back to automatically, no player action needed.
//
// Open Relay Project's old static, publicly-embeddable credentials
// (`openrelayproject`/`openrelayproject`) stopped authenticating —
// confirmed via a second real two-device session reproducing the exact
// same SDP-exchange failure with those credentials still wired in
// (DESIGN.md §10x). metered.ca's current model requires an account and
// mints short-lived credentials per-app via their TURN REST API, so
// TURN_CONFIG below is now populated at runtime by fetchTurnCredentials()
// rather than hardcoded. METERED_API_KEY gates *credential minting only*
// (it is not itself a TURN password) and is meant to ship in client-side
// code the same way the old static credentials did — metered.ca's own
// docs assume this deployment shape.
// The dashboard's own "App domain" — metered.ca now issues these under
// metered.live rather than metered.ca itself, so this is the full host,
// not a subdomain to interpolate into a fixed suffix.
const METERED_TURN_HOST = 'urlcade.metered.live';
const METERED_API_KEY = '28f6b47f99040f457763ef26a0859d555df0';

// Mutated in place (never reassigned) once fetchTurnCredentials() resolves
// — starts empty (STUN-only) rather than stale/broken entries, since a
// wrong TURN entry actively made things worse (DESIGN.md §10x: Trystero
// treats "a turnConfig is present" as license to report the specific
// "check your TURN credentials" error, which is only accurate once real
// credentials are actually in here). joinRoomFn's config below hands
// Trystero this exact array by reference — vendor/trystero/torrent.mjs's
// joinRoom() spreads the outer config object but not the array inside
// it, and vendor/trystero/strategy.mjs's ctx.config keeps that same
// reference for the room's whole lifetime, read fresh by peer.mjs each
// time a peer connection is actually created (initPeer(false,
// ctx.config), destructuring turnConfig at call time, not join time) —
// so a fetch that resolves *after* joinRoomFn is called below still
// reaches the first real peer connection, as long as it beats the
// tracker-signaling handshake that has to happen first (observed taking
// seconds to over a minute in practice, comfortably longer than a single
// HTTP round trip).
const TURN_CONFIG = [];

// Takes the target array as a parameter (mutated in place) rather than
// closing over TURN_CONFIG directly, so test/smoke.js can inject a fake
// fetcher (connectToRoom's own fetchTurnCredentialsFn option, same
// override convention as joinRoomFn) that still exercises the real
// by-reference wiring joinRoomFn's config relies on, without a real
// network call or real metered.ca credentials.
async function fetchTurnCredentials(targetArray){
  // Captured *before* the fetch itself, not after — the point is "was a
  // teardown already pending/in-progress when I started," and diagStopGeneration's
  // own comment explains why a value read here rather than at
  // connectToRoom's call site is what's actually needed.
  const startGeneration = diagStopGeneration;
  const stillOwnsDiagLog = () => diagStopGeneration === startGeneration;
  if(!METERED_TURN_HOST || !METERED_API_KEY){
    if(stillOwnsDiagLog()) pushDiag('TURN not configured (METERED_TURN_HOST/METERED_API_KEY empty) — STUN-only');
    return;
  }
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 4000);
  try{
    const url = `https://${METERED_TURN_HOST}/api/v1/turn/credentials?apiKey=${encodeURIComponent(METERED_API_KEY)}`;
    const res = await fetch(url, {signal: controller.signal});
    if(!res.ok) throw new Error(`HTTP ${res.status}`);
    const servers = await res.json();
    if(!Array.isArray(servers) || !servers.length) throw new Error('empty credential list');
    targetArray.length = 0;
    targetArray.push(...servers);
    if(stillOwnsDiagLog()) pushDiag(`TURN credentials refreshed (${servers.length} servers)`);
  } catch(err){
    if(stillOwnsDiagLog()) pushDiag(`TURN credential fetch failed: ${err.message} (falling back to STUN-only)`);
  } finally{
    clearTimeout(timeoutId);
  }
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
//
// 'connected' describes *party* connectivity only, not a live match —
// see the wire-protocol note above `session.queue`/`startMatch` below.
// A match only ever begins on an explicit party-start message, never as
// a side effect of a peer joining the room.
function connectToRoom(roomCode, {joinRoomFn = trysteroJoinRoom, voteTimeoutMs = 5000, fetchTurnCredentialsFn = fetchTurnCredentials} = {}){
  const listeners = new Set();
  const queueListeners = new Set();
  const matchStartListeners = new Set();
  const peerIdentityListeners = new Set();
  const cascadeListeners = new Set();
  let nextQueueId = 1;
  let cascadeCounter = 0; // see the End Round / vote cascade block below for why this stays purely local
  let cascadeVoteTimer = null;
  const session = {
    roomCode,
    selfId,
    state: 'waiting-for-peer',
    peerId: null,
    playerSlot: null,
    error: null,
    queue: [],
    peerIdentity: null, // {name, avatarId} once the peer's own party-identity message arrives — null until then
    lastMatchFragment: null, // the fragment of the most recently *started* match — End Round's own "restart" candidate
    cascade: null, // {id, candidates, index, selfVote, peerVote} while a post-round Ready/Skip vote is in progress, else null
    onStateChange(fn){ listeners.add(fn); return () => listeners.delete(fn); },
    onQueueChange(fn){ queueListeners.add(fn); return () => queueListeners.delete(fn); },
    onMatchStart(fn){ matchStartListeners.add(fn); return () => matchStartListeners.delete(fn); },
    onPeerIdentityChange(fn){ peerIdentityListeners.add(fn); return () => peerIdentityListeners.delete(fn); },
    onCascadeChange(fn){ cascadeListeners.add(fn); return () => cascadeListeners.delete(fn); },
  };
  function setState(next){
    session.state = next;
    for(const fn of listeners) fn(session.state, session);
  }
  function notifyQueueChange(){
    for(const fn of queueListeners) fn(session.queue);
    // Wire-protocol correctness rule (DESIGN.md §99's plan, carried into
    // §10x's End Round stage): candidates are snapshotted the instant a
    // cascade begins, so a queue mutation observed mid-cascade has to
    // invalidate that snapshot rather than leave a vote referring to a
    // candidate list that's no longer accurate. startCascade() (below)
    // is what re-snapshots; calling it again here (from either the local
    // mutation path or the remote queueAction.onMessage path, both of
    // which already call notifyQueueChange) is what keeps candidateIndex
    // meaningful even after a mid-vote queue change.
    if(session.cascade) startCascade();
  }
  function notifyCascadeChange(){
    for(const fn of cascadeListeners) fn(session.cascade);
  }
  function assignSlot(){
    if(!session.peerId){ session.playerSlot = null; return; }
    // Deterministic and symmetric — both peers independently sort the
    // same two ids and land on the same answer, no host-says-so
    // handshake required.
    const sorted = [selfId, session.peerId].slice().sort();
    session.playerSlot = sorted.indexOf(selfId);
  }
  fetchTurnCredentialsFn(TURN_CONFIG); // fire-and-forget — see TURN_CONFIG's own comment for why joining doesn't need to wait on this
  let room;
  try{
    // Trystero's own default is 3 of its 5 hardcoded public trackers
    // (vendor/trystero/torrent.mjs's defaultRedundancy) — bumped to all
    // 5 here. Public BitTorrent trackers are built for file-sharing
    // swarms, not real-time WebRTC signaling; unlike this app's own
    // relay *sockets* (confirmed reaching OPEN and exchanging announce
    // acks via DESIGN.md §88's diagnostics), a specific tracker can
    // still be too flaky to reliably broker an actual offer/answer
    // exchange between two independent peers. Connecting to all 5
    // widens the chance at least one pair is mutually healthy for that,
    // at the cost of a few more open sockets per session.
    // Trystero's own third `callbacks` argument (`joinRoom(config,
    // roomId, callbacks)`) — never wired before this round — reports
    // exactly the failure this whole diagnostics arc has been trying to
    // pin down: onJoinError fires with a specific, already-worded
    // message ("could not connect to peer X after exchanging SDP") when
    // two peers' signaling (SDP offer/answer) succeeds but the
    // WebRTC/ICE connection itself never completes — as opposed to
    // failing earlier, before any peer is even found. Surfacing it
    // directly answers whether this app's stalls are in that specific
    // bucket (which is what a missing TURN server, or something like
    // iCloud Private Relay interfering with STUN, would look like) or
    // somewhere upstream of it.
    room = joinRoomFn(
      {appId: PARTY_APP_ID, relayConfig: {redundancy: 5}, turnConfig: TURN_CONFIG},
      roomCode,
      {onJoinError: ({error, peerId}) => pushDiag(`join error: ${error}` + (peerId ? ` (peer ${String(peerId).slice(0, 6)})` : ''))}
    );
  } catch(err){
    session.error = err.message;
    setState('error');
    session.leave = () => {};
    return session;
  }
  session._room = room; // startMatchSync (below) needs makeAction() once the match actually starts syncing

  // Party-level channels — created once and live for the whole party,
  // reused match after match (room.makeAction is memoized per room by
  // type string, vendor/trystero/actions.mjs:78-82, confirmed directly
  // this round). 'input' (startMatchSync, below) is the only action
  // created fresh per match, since it needs a new onMessage closure over
  // that match's own World each time.
  const queueAction = room.makeAction('party-queue');
  const startAction = room.makeAction('party-start');
  const identityAction = room.makeAction('party-identity');
  const endRoundAction = room.makeAction('party-end-round');
  const voteAction = room.makeAction('party-vote');
  function broadcastQueue(){
    queueAction.send({items: session.queue});
  }
  queueAction.onMessage = data => {
    session.queue = (data && data.items) || [];
    notifyQueueChange();
  };
  startAction.onMessage = data => {
    // Mirrors what session.startMatch() already does for the sending
    // side — without this, only whichever peer clicked Play would ever
    // remember the match's fragment, so the two sides' End Round
    // "restart" candidate (buildCascadeCandidates, below) would silently
    // diverge: one side offering a restart candidate the other doesn't
    // even have, shifting every later candidateIndex out of alignment.
    session.lastMatchFragment = data.fragment;
    for(const fn of matchStartListeners) fn(data.fragment);
  };
  identityAction.onMessage = data => {
    session.peerIdentity = data && typeof data === 'object'
      ? {name: typeof data.name === 'string' ? data.name : '', avatarId: Number.isInteger(data.avatarId) ? data.avatarId : 0}
      : null;
    for(const fn of peerIdentityListeners) fn(session.peerIdentity);
  };
  // Exposed on the session (rather than just fired once at connect time)
  // so a *local* identity edit mid-party — the Stage 0c picker's own Save
  // button, via this file's module-level broadcastIdentity() export below
  // — can push the update immediately, not just whatever name/avatar was
  // set before the room was joined.
  session.broadcastOwnIdentity = () => {
    identityAction.send(getIdentity());
  };
  session.addToQueue = ({fragment, name, author, maxPlayers}) => {
    // selfId + a counter alone is enough to keep two *distinct* real peers
    // from ever colliding, but a random suffix is added anyway — cheap
    // insurance against the pathological case (e.g. two sessions sharing
    // one selfId within a single test/mock JS realm, as this file's own
    // smoke.js coverage does) rather than a scenario this code otherwise
    // has to reason carefully about.
    const entry = {id: 'q' + (nextQueueId++) + '-' + selfId.slice(0, 6) + '-' + Math.random().toString(36).slice(2, 6), fragment, name, author, maxPlayers, addedBy: selfId};
    session.queue = session.queue.concat([entry]);
    broadcastQueue();
    notifyQueueChange();
    return entry;
  };
  session.removeFromQueue = id => {
    session.queue = session.queue.filter(item => item.id !== id);
    broadcastQueue();
    notifyQueueChange();
  };
  // Unilateral — either peer can start a match on a queued (or
  // freshly-added) fragment with no approval round-trip, matching the
  // "no approval to queue" trust posture. Trystero's send() never loops
  // a message back to its own sender, so the local match-start listeners
  // are called directly here rather than only from startAction.onMessage
  // (which only ever fires for the *other* peer's clicks).
  session.startMatch = fragment => {
    session.lastMatchFragment = fragment; // End Round's own "restart" candidate — see the cascade block below
    startAction.send({fragment});
    for(const fn of matchStartListeners) fn(fragment);
  };

  // End Round + Ready/Skip vote cascade (DESIGN.md §10x, Multiplayer
  // Party's final stage). Either peer can end the round currently
  // playing; both sides then vote Ready/Skip through a shared,
  // deterministically-ordered candidate list — [restart the fragment
  // that was just playing, ...the queue at the instant the round
  // ended] — advancing to the next candidate on any Skip, resolving
  // to a match the instant both sides are Ready on the same one.
  //
  // cascadeId is a purely *local* monotonic counter, never sent over
  // the wire (party-end-round is `{}`) — it only needs to stay equal
  // between the two peers, which it does by construction: it only ever
  // increments on events both sides are guaranteed to process exactly
  // once each, in the same order — a cascade starting (either peer's
  // own endRound() call *and* the other peer's resulting
  // endRoundAction.onMessage both call startCascade()) and a queue
  // mutation observed mid-cascade (already reliably mirrored via
  // notifyQueueChange above, itself called from both the local mutation
  // path and queueAction's own onMessage). No coordination message is
  // needed to keep two independent local counters in lockstep when both
  // sides only ever increment them in response to events they're
  // already guaranteed to see once each.
  function buildCascadeCandidates(){
    const list = [];
    if(session.lastMatchFragment){
      try{
        const { name, author } = K.decodeCartUrl(session.lastMatchFragment);
        list.push({id: 'restart', fragment: session.lastMatchFragment, name, author});
      } catch(err){ /* a malformed remembered fragment just isn't offered as a restart candidate */ }
    }
    for(const item of session.queue) list.push({id: item.id, fragment: item.fragment, name: item.name, author: item.author});
    return list;
  }
  function armVoteTimer(){
    clearTimeout(cascadeVoteTimer);
    const c = session.cascade;
    if(!c) return;
    const atId = c.id, atIndex = c.index;
    cascadeVoteTimer = setTimeout(() => {
      const cur = session.cascade;
      if(!cur || cur.id !== atId || cur.index !== atIndex) return; // the cascade moved on before this fired
      if(cur.selfVote) return; // already voted explicitly
      castVote('ready');
    }, voteTimeoutMs);
  }
  function startCascade(){
    cascadeCounter++;
    const candidates = buildCascadeCandidates();
    session.cascade = candidates.length
      ? { id: cascadeCounter, candidates, index: 0, selfVote: null, peerVote: null }
      : null; // nothing to vote on (no prior match, empty queue) — End Round is a no-op in that edge case
    if(session.cascade) armVoteTimer(); else clearTimeout(cascadeVoteTimer);
    notifyCascadeChange();
  }
  function advanceOrResolve(){
    const c = session.cascade;
    if(!c) return;
    if(c.selfVote === 'ready' && c.peerVote === 'ready'){
      // Unanimous — both sides independently resolve off their own
      // converged vote state and start the match directly (reusing the
      // existing onMatchStart wiring, not session.startMatch's
      // party-start broadcast) rather than exchanging a separate "go"
      // message — the same deterministic-and-symmetric reasoning
      // assignSlot() already relies on above.
      const winner = c.candidates[c.index];
      session.lastMatchFragment = winner.fragment;
      session.cascade = null;
      clearTimeout(cascadeVoteTimer);
      notifyCascadeChange();
      for(const fn of matchStartListeners) fn(winner.fragment);
      return;
    }
    if(c.selfVote === 'skip' || c.peerVote === 'skip'){
      const nextIndex = c.index + 1;
      if(nextIndex >= c.candidates.length){
        // Exhausted every candidate — back to the ordinary queue/shelf
        // UI, no match starts.
        session.cascade = null;
        clearTimeout(cascadeVoteTimer);
        notifyCascadeChange();
        return;
      }
      session.cascade = { id: c.id, candidates: c.candidates, index: nextIndex, selfVote: null, peerVote: null };
      armVoteTimer();
      notifyCascadeChange();
    }
    // else: still waiting on one or both votes for this candidate.
  }
  function castVote(choice){
    const c = session.cascade;
    if(!c) return;
    session.cascade = { ...c, selfVote: choice };
    voteAction.send({cascadeId: c.id, candidateIndex: c.index, choice});
    // Notify before advanceOrResolve(), not just from inside it — a vote
    // that doesn't yet resolve or advance anything (still waiting on the
    // peer) still changed session.cascade.selfVote, and the panel needs
    // to reflect that immediately (e.g. "You: Ready") rather than
    // silently doing nothing until the peer's own vote arrives.
    notifyCascadeChange();
    advanceOrResolve();
  }
  endRoundAction.onMessage = () => {
    startCascade();
  };
  voteAction.onMessage = data => {
    const c = session.cascade;
    // Stale-vote guard: a vote for a cascade/candidate this side has
    // already moved past (a Skip it processed locally before this
    // arrived, or a queue-mutation reset) is silently discarded rather
    // than corrupting the current one.
    if(!c || !data || c.id !== data.cascadeId || c.index !== data.candidateIndex) return;
    session.cascade = { ...c, peerVote: data.choice };
    notifyCascadeChange(); // same reasoning as castVote above — reflect the peer's vote immediately even if it doesn't resolve/advance anything yet
    advanceOrResolve();
  };
  session.endRound = () => {
    endRoundAction.send({});
    startCascade();
  };
  session.vote = choice => {
    castVote(choice);
  };

  // Trystero's send() only reaches peers already connected at send-time
  // — it does not replay past sends to a peer who joins (or rejoins)
  // later. Re-broadcasting the current queue (and, same reasoning, this
  // peer's own identity) on every join closes that gap: a peer who
  // connects (or reconnects after 'peer-left') always ends up with
  // whatever the other side's queue/identity currently is, rather than
  // staying stuck with whatever it last saw (or nothing at all).
  room.onPeerJoin = peerId => {
    if(session.peerId) return; // a 3rd peer is outside v1's 2-player cap — see this file's own header comment; never becomes "the" opponent
    session.peerId = peerId;
    assignSlot();
    setState('connected');
    broadcastQueue();
    session.broadcastOwnIdentity();
  };
  room.onPeerLeave = peerId => {
    if(peerId !== session.peerId) return;
    session.peerId = null;
    session.playerSlot = null;
    setState('peer-left');
  };
  session.leave = () => {
    clearTimeout(cascadeVoteTimer);
    room.leave();
    setState('left');
  };
  return session;
}

function hostMatch(opts){
  return connectToRoom(generateRoomCode(), opts);
}
// Room codes are generated uppercase (ROOM_CODE_ALPHABET); normalized
// the same way here so a guest typing/pasting one in lowercase, or with
// stray whitespace, still matches.
function joinMatch(roomCode, opts){
  return connectToRoom(String(roomCode).trim().toUpperCase(), opts);
}

// A join link bundles this exact game with a room code, so opening it is
// the recipient's whole "join" step — no separately-communicated code to
// read off another screen and type in by hand. `&mp=<code>` is appended
// after the fragment (there's nowhere else to put it: everything after
// `#` is the fragment, and a second `#` isn't legal in a URL) — `&` is
// never confusing to a URL/link detector (it's the standard query-param
// separator, seen in essentially every real-world URL) so it's safe to
// just concatenate.
//
// The fragment needed two rounds of real investigation to get right
// (DESIGN.md §85-87), both against iOS iMessage's link detector — the
// only external, non-mocked signal this whole Multiplayer arc ever got.
// Two *different* bugs turned out to be stacked on top of each other:
//
// 1. A bare comma reads as sentence punctuation, not URL syntax, to
//    iMessage's detector, and splits the link outright. kernel.js's
//    encodeCartUrl joins `encodeURIComponent(name) + ',' +
//    encodeURIComponent(author) + ',' + payload` with two literal,
//    unescaped commas — fine for this app's own `location.hash` routing,
//    not fine handed to a third party. Confirmed directly: a raw link
//    split exactly at that comma.
// 2. Independently, iMessage (and Signal) cap a single unbroken run of
//    URL-safe characters at roughly 300 before splitting it into two
//    separate tokens regardless of punctuation — documented publicly
//    (see this function's own comment below) and confirmed here by a
//    cart whose payload's naturally-occurring base64url `-`/`_`
//    characters happened to leave a long enough gap to trip it.
//
// A tried-and-discarded first fix wrapped the *entire* fragment in one
// more `encodeURIComponent`, then in base64url — both genuinely removed
// literal commas, but both also made bug 2 worse, not better: encoding
// mostly-printable-ASCII *text* (not random bytes) through base64
// systematically under-produces the very `-`/`/` symbols base64 needs to
// break up a long run, so the "fixed" link could go 1400+ characters
// with zero natural breaks. Both attempts also had a real, independent
// cost the maintainer flagged directly: the link stopped being
// human-readable — no more seeing "Race Car" in a link before opening
// it, which is a real quality worth keeping, not just a coincidence of
// the format.
//
// The actual fix addresses each bug at its source instead of
// obliterating the whole fragment's readability to route around both:
// escape only the two real structural commas (anything inside an
// already-`encodeURIComponent`'d name/author can't contain a *literal*
// comma to begin with, so this can't misfire on a comma-containing cart
// name), then insert a `-` every LINK_BREAK_INTERVAL characters through
// the whole thing, comfortably under the ~300-character danger zone.
// Insertion/removal is purely position-based — it doesn't need to tell
// "a `-` I inserted" apart from "a `-` that was already there" (both
// look identical once inserted), it just always removes the character
// sitting at each known interval boundary, which loslessly reconstructs
// the exact original by construction regardless of what's there.
const IMESSAGE_LINK_BREAK_INTERVAL = 200; // Patrick Weaver measured iMessage/Signal breaking bare (unbroken) base64 runs somewhere between 300 and 303 chars (patrickweaver.net/blog/imessage-mystery) — 200 leaves comfortable margin
function insertLinkBreaks(str){
  let out = '';
  for(let i = 0; i < str.length; i += IMESSAGE_LINK_BREAK_INTERVAL){
    out += str.slice(i, i + IMESSAGE_LINK_BREAK_INTERVAL);
    if(i + IMESSAGE_LINK_BREAK_INTERVAL < str.length) out += '-';
  }
  return out;
}
function removeLinkBreaks(str){
  let out = '', i = 0;
  while(i < str.length){
    out += str.slice(i, i + IMESSAGE_LINK_BREAK_INTERVAL);
    i += IMESSAGE_LINK_BREAK_INTERVAL;
    if(i < str.length) i += 1; // skip the inserted '-'
  }
  return out;
}
function parseJoinLinkHash(hash){
  const m = hash.match(/&mp=([^&]+)$/);
  if(!m) return { gameHash: hash, code: null };
  const gameHash = removeLinkBreaks(hash.slice(0, m.index)).replace(/%2C/g, ',');
  return { gameHash, code: m[1] };
}
function buildJoinLink(roomCode){
  const fragment = getCurrentFragment();
  if(!fragment) return null;
  const safe = insertLinkBreaks(fragment.replace(/,/g, '%2C'));
  return location.origin + location.pathname + location.search + '#' + safe + '&mp=' + roomCode;
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

  // Trystero's public makeAction()'s onMessage is a getter/setter
  // *property* (vendor/trystero/actions.mjs's makeActionImpl — `get
  // onMessage(){...}, set onMessage(handler){...}`), assigned to, not
  // called — the callable-method shape only exists on the *internal*
  // actions room.mjs makes for its own ping/pong/signal/leave/handshake
  // messages, which multiplayer.js never touches. Calling this as a
  // function threw `inputAction.onMessage is not a function` the
  // instant a real match actually reached 'connected' — invisible to
  // every prior round of network diagnostics in this arc (which never
  // got a real connection this far), and invisible to test/smoke.js's
  // own mock rooms too, since their `onMessage(){}` stubs encoded the
  // exact same wrong assumption.
  inputAction.onMessage = data => {
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
  };

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
let unsubscribeQueue = null;
let unsubscribeMatchStart = null;
let unsubscribePeerIdentity = null;
let unsubscribeCascade = null;
let activeSync = null; // the startMatchSync() handle for the current 'connected' session, if any
// Bumped every time beginSyncedMatch starts, and checked after its one
// await — guards against a peer leaving (or this side closing the
// lobby) while that restart is still in flight, which would otherwise
// let a since-superseded call attach a sync/hook after the match it
// belonged to has already ended. A plain counter rather than an
// AbortController: nothing here needs to actually cancel startGame()
// mid-flight, just to notice it's stale once it resolves.
let matchGeneration = 0;

// Diagnostics (DESIGN.md §88) — a "the connection just stalls" report
// looks identical from this file's own state machine whether the cause
// is a same-origin JS bug or a network that's silently blocking WSS to
// the signaling relays: 'waiting-for-peer' either way, no error, no
// visible difference. The only way to tell those apart from inside the
// browser itself (no computer, no network-proxy app, just the phone
// that's actually failing) is to surface what the two layers underneath
// the lobby's own state are actually doing: whether any of the
// vendored Trystero relay WebSockets (vendor/trystero/torrent.mjs's
// getRelaySockets, module-level and shared across every joinRoom call,
// exactly the sockets DESIGN.md §85 confirmed really attempt to open)
// ever reach OPEN, and once a peer is found through them, whether the
// peer-to-peer WebRTC connection progresses past ICE negotiation.
//
// Polls rather than hooking events directly: relay sockets are
// recreated wholesale on reconnect (vendor/trystero/utils.mjs's
// makeSocket does `new WebSocket(url)` again on close), so there's no
// single long-lived socket object to hang a one-time listener off of —
// polling readyState every tick and diffing against the last-seen value
// per URL sidesteps needing to notice "a new socket replaced the old
// one" at all.
const DIAG_POLL_MS = 800;
const DIAG_LOG_CAP = 60;
const RELAY_READY_STATE_NAMES = ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED'];
let diagStartTime = 0;
let diagLog = [];
let diagPollTimer = null;
let lastRelayStates = {};
let lastPeerStates = {};
// Bumped by stopDiag() only (every session teardown, DESIGN.md §103) —
// fetchTurnCredentials() (below) captures this at the moment it's fired
// (before the *current* session's own startDiag() has even run yet, see
// connectToRoom) and checks it again once the fetch resolves, skipping
// its own pushDiag lines if a teardown happened in between. Without
// this, a fetch kicked off by a session that's already been left (its
// own pushDiag calls otherwise having no owner to check against) can
// resolve arbitrarily late and write a stray "TURN credentials
// refreshed" line into whatever session's log happens to be showing at
// that moment — confusing for a real user, and a source of cross-test
// contamination in test/smoke.js, where many sessions share one page.
let diagStopGeneration = 0;

function diagElapsed(){ return ((Date.now() - diagStartTime) / 1000).toFixed(1) + 's'; }
function pushDiag(msg){
  diagLog.push(`[+${diagElapsed()}] ${msg}`);
  if(diagLog.length > DIAG_LOG_CAP) diagLog.shift();
  renderDiag();
}
function pollDiag(){
  const sockets = getRelaySockets();
  for(const [url, socket] of Object.entries(sockets)){
    const stateName = RELAY_READY_STATE_NAMES[socket.readyState] ?? String(socket.readyState);
    if(lastRelayStates[url] !== stateName){
      pushDiag(`relay ${url.replace('wss://', '')}: ${stateName}`);
      lastRelayStates[url] = stateName;
    }
  }
  const room = activeSession && activeSession._room;
  // test/smoke.js's mock rooms (see this file's own openLobby/openLobbyAndJoin
  // comment) only ever implement onPeerJoin/onPeerLeave/leave — no
  // getPeers, no real RTCPeerConnection to inspect — so this has to be
  // optional, not just "room exists."
  if(room && typeof room.getPeers === 'function'){
    for(const [peerId, conn] of Object.entries(room.getPeers())){
      const shortId = peerId.slice(0, 6);
      if(lastPeerStates[peerId + ':connection'] !== conn.connectionState){
        pushDiag(`peer ${shortId}: connectionState ${conn.connectionState}`);
        lastPeerStates[peerId + ':connection'] = conn.connectionState;
      }
      if(lastPeerStates[peerId + ':ice'] !== conn.iceConnectionState){
        pushDiag(`peer ${shortId}: iceConnectionState ${conn.iceConnectionState}`);
        lastPeerStates[peerId + ':ice'] = conn.iceConnectionState;
      }
    }
  }
}
// Trystero's own tracker-protocol layer (vendor/trystero/torrent.mjs's
// warn()) already detects and reports exactly the class of failure this
// diagnostic panel exists to catch — a tracker relay responding with a
// "failure reason" or "warning message" to an announce, which is
// precisely what "relays reach OPEN but no peer is ever found" would
// look like — but only ever sends it to console.warn, invisible on a
// phone with no devtools attached. Capturing it here (filtered to this
// library's own `${libName}: ...` prefix, so an unrelated page warning
// doesn't get misattributed as a multiplayer problem) closes that gap
// without touching the vendored library itself. Calls through to the
// real console.warn too — this is additive, not a replacement, so
// anyone who *does* have devtools open still sees it there as well.
let originalConsoleWarn = null;
function installConsoleWarnCapture(){
  if(originalConsoleWarn) return; // already installed
  originalConsoleWarn = console.warn.bind(console);
  console.warn = (...args) => {
    originalConsoleWarn(...args);
    const text = args.map(a => (typeof a === 'string' ? a : String(a))).join(' ');
    if(text.includes('Trystero')) pushDiag(`console.warn: ${text}`);
  };
}
function uninstallConsoleWarnCapture(){
  if(!originalConsoleWarn) return;
  console.warn = originalConsoleWarn;
  originalConsoleWarn = null;
}
function startDiag(role, roomCode){
  diagStartTime = Date.now();
  diagLog = [];
  lastRelayStates = {};
  lastPeerStates = {};
  installConsoleWarnCapture();
  // PARTY_APP_ID is exactly the second half of the room's topic — every
  // party uses the same one now (DESIGN.md §97), so a host and a joiner
  // only ever find each other if this string matches (it always will,
  // it's a constant) and the room code matches. Logged anyway, mostly so
  // a diag log from before this round and one from after look visibly
  // different rather than silently comparing apples to oranges.
  pushDiag(`${role === 'host' ? 'hosting' : 'joining'} room ${roomCode} — selfId ${selfId.slice(0, 6)} — appId ${PARTY_APP_ID}`);
  pollDiag();
  clearInterval(diagPollTimer);
  diagPollTimer = setInterval(pollDiag, DIAG_POLL_MS);
}
// Clears the log too (not just the timer) — closeLobby's the only
// caller, and the next time the modal opens it should show the choice
// screen with no stale diagnostics from whatever session just ended,
// not leftover text sitting there until a new session happens to start.
function stopDiag(){
  diagStopGeneration++;
  clearInterval(diagPollTimer);
  diagPollTimer = null;
  uninstallConsoleWarnCapture();
  diagLog = [];
  renderDiag();
}
function renderDiag(){
  const panel = document.getElementById('mpDiag');
  const logEl = document.getElementById('mpDiagLog');
  if(!logEl || !panel) return;
  // '' (not 'block') would just clear the inline override and fall back
  // to .mp-diag's own CSS default, which is display:none — so this has
  // to set an explicit visible value, not merely "not none".
  panel.style.display = diagLog.length ? 'block' : 'none';
  logEl.textContent = diagLog.join('\n');
  logEl.scrollTop = logEl.scrollHeight;
}
async function copyDiagLog(btn){
  const ok = await copyToClipboard(diagLog.join('\n'));
  const original = btn.textContent;
  btn.textContent = ok ? 'Copied!' : 'Copy failed';
  setTimeout(() => { if(btn.isConnected) btn.textContent = original; }, 1500);
}

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
  document.getElementById('endRoundBtn').style.display = 'none';
}

// Detaches a live match's sync hook (same teardown stopSync() already
// does) without touching the party room connection at all — used by
// main.js's navigation (goToMenu/openDebug) instead of closeLobby(),
// since switching to the shelf or Tinker ends whatever match is running
// (the World driving it is being torn down or paused either way) but
// should NOT also end the party (DESIGN.md §100: the whole point of a
// persistent room is that it survives navigating away from one match).
function leaveMatchKeepParty(){
  stopSync();
}

// Hides the panel without leaving the room — the scrim/X's job now
// (DESIGN.md §100). Leaving is only ever the explicit in-panel button's
// job (Cancel/Leave Party/Close, all wired to closeLobby below), so a
// stray tap outside the card can never silently end a connected party.
function hideLobby(){
  document.getElementById('mpOverlay').classList.remove('active');
}

function closeLobby(){
  stopSync();
  // activeSession.leave() below triggers its own 'left' state transition
  // (session.leave -> setState('left') -> handleSessionStateChange ->
  // pushDiag), so stopDiag() has to run *after* that settles, not
  // before — otherwise that final transition would repopulate the log
  // and un-hide the panel right after this function just cleared it.
  if(activeSession) activeSession.leave();
  if(unsubscribeSession) unsubscribeSession();
  if(unsubscribeQueue) unsubscribeQueue();
  if(unsubscribeMatchStart) unsubscribeMatchStart();
  if(unsubscribePeerIdentity) unsubscribePeerIdentity();
  if(unsubscribeCascade) unsubscribeCascade();
  stopDiag();
  activeSession = null;
  unsubscribeSession = null;
  unsubscribeQueue = null;
  unsubscribeMatchStart = null;
  unsubscribePeerIdentity = null;
  unsubscribeCascade = null;
  lobbyMode = 'choice';
  document.getElementById('mpOverlay').classList.remove('active');
}

// Fires on an explicit party-start message (either peer clicking Play on
// a queue item, see session.startMatch above) — never as a side effect
// of a peer simply joining the room (see handleSessionStateChange below).
// Restarts the game fresh so both peers begin ticking from the exact
// same on_init state (the World that was already running single-player
// has no reason to agree with the peer's — different play sessions,
// different RNG progress, different entity state), then wires the fresh
// World's per-tick hook to this session's sync controller. Takes the
// exact fragment both peers agreed on over the wire, not whatever
// happens to be loaded locally (getCurrentFragment()) — that's the
// concrete mechanism behind the "explicit cart agreement" guarantee
// PARTY_APP_ID's own comment above describes. Hides the modal rather
// than closing it — closeLobby() would also leave the room.
async function beginSyncedMatch(session, fragment){
  document.getElementById('mpOverlay').classList.remove('active');
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
  // 'inline-block' (not '') — the button's CSS default is display:none,
  // so clearing an inline override would just fall back to hidden (the
  // same gotcha this file's own renderDiag()/updatePartyIndicator()
  // comments already flag).
  document.getElementById('endRoundBtn').style.display = 'inline-block';
}

function statusDot(kind){ return `<span class="mp-status-dot mp-${kind}"></span>`; }

// The shelf's own maxPlayers>=2 carts, decoded from CARTS the same way
// renderMenu() decodes every shelf card (never from an in-memory
// authored object — see carts/index.js's own header) — cached at module
// scope since CARTS itself never changes after registerAllCarts()
// resolves at boot. Loaded lazily (the first 'connected' render kicks it
// off) rather than at module init, so this file doesn't force CARTS'
// full compile to finish before a lobby that never opens the "Add a
// game" section needs it.
let mpCapableCartsList = null;
let mpCapableCartsPromise = null;
async function loadMultiplayerCapableCarts(){
  const list = [];
  for(const [key, {fragment, name, author}] of Object.entries(CARTS)){
    try{
      const cart = K.decodeCart(await K.decodePayloadToBytes(K.decodeCartUrl(fragment).payload));
      if(cart.maxPlayers >= 2) list.push({key, fragment, name, author, maxPlayers: cart.maxPlayers});
    } catch(err){ /* a cart that fails to decode just doesn't show up here — same as it wouldn't on the shelf */ }
  }
  return list;
}
function ensureMultiplayerCapableCartsLoaded(){
  if(mpCapableCartsList || mpCapableCartsPromise) return;
  mpCapableCartsPromise = loadMultiplayerCapableCarts().then(list => {
    mpCapableCartsList = list;
    renderLobby(); // re-render once the async decode settles, same pattern beginSyncedMatch's own await uses
  });
}

// The peer's display name once known (party-identity has arrived and it
// isn't blank), else the generic "your friend" fallback this file used
// throughout before Stage 3 — a peer who never set a name (still the
// DEFAULT_IDENTITY default, runtime.js) is handled the same as one whose
// identity hasn't arrived yet, rather than showing an empty string.
function peerDisplayName(session){
  return session.peerIdentity && session.peerIdentity.name ? session.peerIdentity.name : 'your friend';
}

function renderQueueList(session){
  if(!session.queue.length){
    return `<p class="mp-queue-empty">No games queued yet — add one below.</p>`;
  }
  const rows = session.queue.map(item => `
    <div class="mp-queue-item">
      <div class="mp-queue-info">
        <span class="mp-queue-name">${esc(item.name || '(untitled)')}</span>
        <span class="mp-queue-added-by">added by ${item.addedBy === session.selfId ? 'you' : esc(peerDisplayName(session))}</span>
      </div>
      <div class="mp-queue-item-actions">
        <button class="mp-queue-play" data-queue-id="${esc(item.id)}">Play</button>
        <button class="mp-queue-remove" data-queue-id="${esc(item.id)}" title="Remove">&times;</button>
      </div>
    </div>
  `).join('');
  return `<div class="mp-queue-list">${rows}</div>`;
}
function renderAddGameSection(){
  ensureMultiplayerCapableCartsLoaded();
  if(!mpCapableCartsList){
    return `<div class="mp-queue-add"><p class="mp-queue-empty">Loading games…</p></div>`;
  }
  const options = mpCapableCartsList.map(c => `
    <button class="mp-queue-add-btn" data-cart-key="${esc(c.key)}">+ ${esc(c.name || c.key)} <span class="mp-queue-add-players">${c.maxPlayers}p</span></button>
  `).join('');
  return `<div class="mp-queue-add"><h4>Add a game</h4><div class="mp-queue-add-list">${options}</div></div>`;
}

function voteLabel(choice){
  if(choice === 'ready') return '✅ Ready';
  if(choice === 'skip') return '⏭ Skip';
  return 'Waiting…';
}
// The post-round Ready/Skip vote (DESIGN.md §10x) — shown instead of the
// normal queue view for as long as session.cascade is non-null. Ready is
// unanimous-required per candidate (both selfVote and peerVote ===
// 'ready'); Skip from either side advances immediately, no need to wait
// on the other vote. An explicit click always beats the local 5s
// implicit-yes timer (session.vote below short-circuits it); the timer
// itself is invisible here on purpose — the plan doesn't call for a
// visible countdown, only the eventual auto-ready behavior.
function renderCascade(session){
  const c = session.cascade;
  const candidate = c.candidates[c.index];
  return `
    <h3>Vote: Next Game</h3>
    <div class="mp-peer-info"><span id="mpPeerAvatarSlot" class="mp-peer-avatar"></span><span class="mp-peer-name">${esc(peerDisplayName(session))}</span></div>
    <div class="mp-vote-candidate">
      <div class="mp-vote-candidate-name">${esc(candidate.name || '(untitled)')}</div>
      <div class="mp-vote-status">
        <span>You: ${voteLabel(c.selfVote)}</span>
        <span>${esc(peerDisplayName(session))}: ${voteLabel(c.peerVote)}</span>
      </div>
    </div>
    <div class="mp-actions">
      <button class="mp-vote-ready mp-primary">Ready</button>
      <button class="mp-vote-skip">Skip</button>
    </div>
    <div class="mp-actions"><button id="mpCancelBtn">Leave Party</button></div>
  `;
}

function renderSessionBody(session){
  const s = session.state;
  if(s === 'waiting-for-peer'){
    const hosting = session._role === 'host';
    return `
      <h3>${hosting ? 'Hosting a match' : 'Joining a match'}</h3>
      ${hosting ? `<p>Send this link to a friend, or share the code below:</p><div class="mp-room-code">${esc(session.roomCode)}</div>` : ''}
      <div class="mp-status">${statusDot('pending')} ${hosting ? 'Waiting for your friend to join…' : `Connecting to ${esc(session.roomCode)}…`}</div>
      <p>Once they join you'll both see a shared queue of games to
      play — no account, no server, just this browser talking directly
      to theirs.</p>
      <div class="mp-actions">${hosting ? '<button id="mpCopyLinkBtn" class="mp-primary">Copy Link</button>' : ''}<button id="mpCancelBtn">Cancel</button></div>
    `;
  }
  if(s === 'connected'){
    if(session.cascade) return renderCascade(session);
    return `
      <h3>Party</h3>
      <div class="mp-peer-info"><span id="mpPeerAvatarSlot" class="mp-peer-avatar"></span><span class="mp-peer-name">${esc(peerDisplayName(session))}</span></div>
      <div class="mp-status">${statusDot('good')} Connected — you're Player ${session.playerSlot + 1} of 2</div>
      ${renderQueueList(session)}
      ${renderAddGameSection()}
      <div class="mp-actions"><button id="mpCancelBtn">Leave Party</button></div>
    `;
  }
  if(s === 'peer-left'){
    return `
      <h3>Opponent disconnected</h3>
      <div class="mp-peer-info"><span id="mpPeerAvatarSlot" class="mp-peer-avatar"></span><span class="mp-peer-name">${esc(peerDisplayName(session))}</span></div>
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
    // renderSessionBody's own peerDisplayName() handles the text; the
    // avatar is a real <canvas> (Avatars.renderAvatarCanvas), which can
    // only be appended after the innerHTML above exists, same pattern
    // main.js's own renderIdentityChip uses. Left empty (no placeholder
    // avatar) until the peer's actual identity arrives — a made-up
    // default would misrepresent them.
    const peerAvatarSlot = document.getElementById('mpPeerAvatarSlot');
    if(peerAvatarSlot && activeSession.peerIdentity) peerAvatarSlot.appendChild(Avatars.renderAvatarCanvas(activeSession.peerIdentity.avatarId));
    const cancelBtn = document.getElementById('mpCancelBtn');
    if(cancelBtn) cancelBtn.addEventListener('click', closeLobby);
    const copyLinkBtn = document.getElementById('mpCopyLinkBtn');
    if(copyLinkBtn) copyLinkBtn.addEventListener('click', () => copyJoinLink(activeSession.roomCode, copyLinkBtn));
    const backBtn = document.getElementById('mpBackBtn');
    if(backBtn) backBtn.addEventListener('click', () => {
      if(activeSession) activeSession.leave();
      if(unsubscribeSession) unsubscribeSession();
      if(unsubscribeQueue) unsubscribeQueue();
      if(unsubscribeMatchStart) unsubscribeMatchStart();
      if(unsubscribePeerIdentity) unsubscribePeerIdentity();
      if(unsubscribeCascade) unsubscribeCascade();
      activeSession = null;
      unsubscribeSession = null;
      unsubscribeQueue = null;
      unsubscribeMatchStart = null;
      unsubscribePeerIdentity = null;
      unsubscribeCascade = null;
      lobbyMode = 'choice';
      renderLobby();
    });
    body.querySelectorAll('.mp-vote-ready').forEach(btn => btn.addEventListener('click', () => activeSession.vote('ready')));
    body.querySelectorAll('.mp-vote-skip').forEach(btn => btn.addEventListener('click', () => activeSession.vote('skip')));
    body.querySelectorAll('.mp-queue-play').forEach(btn => btn.addEventListener('click', () => {
      const item = activeSession.queue.find(i => i.id === btn.dataset.queueId);
      if(item) activeSession.startMatch(item.fragment);
    }));
    body.querySelectorAll('.mp-queue-remove').forEach(btn => btn.addEventListener('click', () => {
      activeSession.removeFromQueue(btn.dataset.queueId);
    }));
    body.querySelectorAll('.mp-queue-add-btn').forEach(btn => btn.addEventListener('click', () => {
      const cart = mpCapableCartsList && mpCapableCartsList.find(c => c.key === btn.dataset.cartKey);
      if(cart) activeSession.addToQueue({fragment: cart.fragment, name: cart.name, author: cart.author, maxPlayers: cart.maxPlayers});
    }));
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
    <p>Start a party with a friend — no account, no server, just a code
    to share. You'll both pick from a shared queue of games once
    connected.</p>
    <div class="mp-actions">
      <button id="mpHostBtn" class="mp-primary">Host a match</button>
      <button id="mpJoinBtn">Join a match</button>
    </div>
  `;
  document.getElementById('mpHostBtn').addEventListener('click', () => startSession('host'));
  document.getElementById('mpJoinBtn').addEventListener('click', () => { lobbyMode = 'join-form'; renderLobby(); });
}

// A small always-present indicator (index.html's #partyIndicator, styled
// fixed-position so it's visible regardless of which of the 3 views —
// shelf, game, Tinker — is currently active, DESIGN.md §100) reopening
// the panel on tap. Shown for 'connected' and 'peer-left' (still a real
// party, just between peers right now) — not 'waiting-for-peer' (no
// second player to have a party *with* yet) or 'error'/'left'. Shows the
// peer's real avatar/name once their party-identity message has arrived
// (DESIGN.md §101); a generic 👥/"Party" placeholder until then.
function updatePartyIndicator(){
  const el = document.getElementById('partyIndicator');
  if(!el) return;
  const state = activeSession && activeSession.state;
  const visible = state === 'connected' || state === 'peer-left';
  // 'flex' (not '') — clearing the inline override would just fall back
  // to #partyIndicator's own CSS default, which is display:none (same
  // gotcha this file's own renderDiag() already has a comment about).
  el.style.display = visible ? 'flex' : 'none';
  if(!visible) return;
  el.innerHTML = '';
  const avatarSlot = document.createElement('span');
  avatarSlot.className = 'mp-indicator-avatar';
  if(activeSession.peerIdentity) avatarSlot.appendChild(Avatars.renderAvatarCanvas(activeSession.peerIdentity.avatarId));
  else avatarSlot.textContent = '\u{1F465}';
  el.appendChild(avatarSlot);
  const label = document.createElement('span');
  const peerName = activeSession.peerIdentity && activeSession.peerIdentity.name ? activeSession.peerIdentity.name : 'Party';
  label.textContent = state === 'connected' ? peerName : peerName + ' ⚠';
  el.appendChild(label);
}

// The single listener driving both the modal's contents and the actual
// match lifecycle for as long as a session is active — including while
// the modal itself is hidden (mid-match, see beginSyncedMatch), which
// is exactly why this is a dedicated subscription rather than a
// render-only one: 'peer-left' needs to stop the sync hook and bring
// the (currently hidden) modal back, not just re-render whatever's
// already showing.
function handleSessionStateChange(state, session){
  pushDiag(`session state: ${state}` + (session.error ? ` (${session.error})` : ''));
  if(state === 'peer-left'){
    stopSync();
    document.getElementById('mpOverlay').classList.add('active');
  }
  updatePartyIndicator();
  renderLobby();
}

// Only the host auto-seeds the queue (with whatever's currently
// loaded), once, right here — never inside hostMatch/joinMatch
// themselves, which stay pure connection primitives. The guest relies
// entirely on the peer-join re-broadcast (connectToRoom's own
// room.onPeerJoin, above) to receive it; both sides seeding
// independently would race under the full-replace broadcast model,
// with whichever peer's broadcast lands last silently winning.
let lobbyOpts = undefined;
function startSession(role, code){
  activeSession = role === 'host' ? hostMatch(lobbyOpts) : joinMatch(code, lobbyOpts);
  activeSession._role = role;
  startDiag(role, activeSession.roomCode);
  // connectToRoom sets the session's initial state (normally
  // 'waiting-for-peer', or 'error' for a synchronously-throwing
  // joinRoomFn) directly on the object rather than through setState() —
  // onStateChange only fires on *future* transitions, so this starting
  // state wouldn't otherwise ever reach the diag log the way every later
  // transition does.
  pushDiag(`session state: ${activeSession.state}` + (activeSession.error ? ` (${activeSession.error})` : ''));
  unsubscribeSession = activeSession.onStateChange(handleSessionStateChange);
  unsubscribeQueue = activeSession.onQueueChange(() => renderLobby());
  unsubscribeMatchStart = activeSession.onMatchStart(fragment => beginSyncedMatch(activeSession, fragment));
  unsubscribePeerIdentity = activeSession.onPeerIdentityChange(() => { updatePartyIndicator(); renderLobby(); });
  // A cascade starting (or advancing) always brings the panel back —
  // both peers need to see the vote prompt, not just whichever one
  // clicked End Round — and stops whatever match sync was running,
  // mirroring the wire protocol's "both sides stopSync() and enter the
  // vote cascade" (idempotent: harmless if no match was actually live).
  unsubscribeCascade = activeSession.onCascadeChange(cascade => {
    if(cascade){
      stopSync();
      document.getElementById('mpOverlay').classList.add('active');
    }
    renderLobby();
  });
  if(role === 'host'){
    try{
      const fragment = getCurrentFragment();
      const world = getWorld();
      if(fragment && world && world.cart){
        const { name, author } = K.decodeCartUrl(fragment);
        activeSession.addToQueue({fragment, name, author, maxPlayers: world.cart.maxPlayers});
      }
    } catch(err){ /* seeding is best-effort — an empty queue is a fine starting state too */ }
  }
  renderLobby();
}

// Broadcasts the local player's current identity (Runtime.getIdentity())
// to the connected peer, if a party is actually active — a no-op
// otherwise. Exported for the Stage 0c identity picker's own Save button
// (main.js) to call after Runtime.setIdentity(), so a live name/avatar
// edit mid-party reaches the peer immediately rather than waiting for
// the next reconnect's automatic re-broadcast (connectToRoom's own
// room.onPeerJoin, above).
function broadcastIdentity(){
  if(activeSession) activeSession.broadcastOwnIdentity();
}

// The "End Round" topbar button's own handler (main.js) — a no-op if no
// party is active, otherwise starts the vote cascade (session.endRound
// above) for both peers.
function endRound(){
  if(activeSession) activeSession.endRound();
}

// Opens the lobby modal — no longer scoped to a particular cart (the
// party room is a fixed topic now, see PARTY_APP_ID above); the caller
// (main.js) shows the "Multiplayer" button unconditionally now
// (updateMultiplayerButton below) since a party isn't cart-scoped either.
// `opts` (an optional {joinRoomFn}) passes straight through to
// hostMatch/joinMatch — main.js's real button click never supplies one
// (so real Trystero is used), but test/smoke.js reaches this same
// function via window.__urlcadeDebug with a mock, to drive the full
// lobby UI/state-machine wiring without ever touching the real network
// (see this repo's own note on why live P2P can't be tested here).
function openLobby(opts){
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
function openLobbyAndJoin(code, opts){
  lobbyOpts = opts;
  document.getElementById('mpOverlay').classList.add('active');
  startSession('join', code);
}

// Shows index.html's "Multiplayer" topbar button unconditionally now
// (DESIGN.md §100) — the party room is no longer scoped to whatever
// cart is currently loaded (§99), so gating the entry point on the
// current cart's maxPlayers no longer makes sense: you can open a party
// while playing any game and add a maxPlayers>=2 one to the shared queue
// from inside it. Queue-*adding* stays gated on maxPlayers>=2 regardless
// (renderAddGameSection above only lists those). Kept as a function
// (rather than inlining a static display:'' in index.html) so the call
// sites in main.js don't need to change and a future stage has one place
// to add a real condition back if one turns out to be needed.
function updateMultiplayerButton(){
  document.getElementById('multiplayerBtn').style.display = '';
}

function initMultiplayerUI(){
  document.getElementById('mpCloseBtn').addEventListener('click', hideLobby);
  document.getElementById('mpOverlay').addEventListener('click', e => {
    if(e.target.id === 'mpOverlay') hideLobby(); // click on the scrim itself, not the card
  });
  document.getElementById('partyIndicator').addEventListener('click', () => {
    document.getElementById('mpOverlay').classList.add('active');
    renderLobby();
  });
  const copyDiagBtn = document.getElementById('mpDiagCopyBtn');
  if(copyDiagBtn) copyDiagBtn.addEventListener('click', () => copyDiagLog(copyDiagBtn));
}

export {
  hostMatch, joinMatch, connectToRoom, generateRoomCode, selfId, PARTY_APP_ID,
  openLobby, openLobbyAndJoin, closeLobby, hideLobby, leaveMatchKeepParty,
  updateMultiplayerButton, initMultiplayerUI, broadcastIdentity, endRound,
  startMatchSync, parseJoinLinkHash, TURN_CONFIG, fetchTurnCredentials,
};
