# Vendored: Trystero (torrent strategy)

Source: [`@trystero-p2p/core`](https://www.npmjs.com/package/@trystero-p2p/core)
and [`@trystero-p2p/torrent`](https://www.npmjs.com/package/@trystero-p2p/torrent)
version `0.25.3`, MIT-licensed (see `LICENSE`). Copied verbatim from each
package's `dist/*.mjs` — this is the first third-party code the shipped
runtime depends on (DESIGN.md §79); everything else in `url-console/v0/`
has always been zero-dependency. Vendored rather than loaded from a CDN at
runtime, on purpose: keeps the "no external requests" property every other
file here already has, and doesn't add a live dependency on a CDN staying
up for anyone to play a multiplayer match.

Only two mechanical edits were made to make these files work as flat,
statically-served ES modules instead of an npm package tree:

1. `@trystero-p2p/core`'s `dist/index.mjs` renamed to `core.mjs` here
   (disambiguates it from `torrent.mjs` sitting in the same flat
   directory — npm's own layout kept them apart via separate package
   folders, which a static file server doesn't have).
2. `torrent.mjs`'s one bare-specifier import (`from "@trystero-p2p/core"`)
   rewritten to the relative `from "./core.mjs"` — the only import in
   either package that wasn't already a relative path to a sibling file.

Dangling `//# sourceMappingURL=...` comments (pointing at `.map` files not
vendored here) were also stripped from every file — cosmetic only, avoids
a 404 in devtools.

No other content was changed. To update: `npm install @trystero-p2p/core
@trystero-p2p/torrent` somewhere scratch, copy the new `dist/*.mjs` files
over (skipping `.map`/`.d.mts`), and reapply the same two edits above.

## Why torrent, not one of Trystero's other strategies

Trystero supports several serverless signaling backends (BitTorrent,
Nostr, MQTT, IPFS) plus two that need an account (Firebase, Supabase) —
ruled out by this project's own "no server, no account" principle
(`CLAUDE.md`). Torrent was picked over Nostr/MQTT/IPFS mainly because it's
the most established/battle-tested of the serverless options and pulls in
zero further dependencies of its own (Nostr, for comparison, needs
`@noble/secp256k1` for its signing). Either would have satisfied "no
server to run" equally well — this wasn't a hard requirement pointing at
one specific choice.

## Public API surface actually used

- `joinRoom({appId}, roomId)` → a `Room`.
- `room.onPeerJoin` / `room.onPeerLeave` (peerId callbacks).
- `room.makeAction(name)` → `{send, onMessage}` for peer-to-peer messages.
- `room.leave()`.
- `selfId` — this browser's own generated peer id for the session.

See `multiplayer.js` (one level up) for how this project wraps that
surface — nothing in `url-console/v0/` outside that one file imports from
this directory directly.
