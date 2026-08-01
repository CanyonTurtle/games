/* ============================================================
   The Urlcade — example cart registry

   Builds every example cart this repo ships (one file per cart under
   carts/, each just a plain "author a JS object, describe its hooks as
   assembly source" builder function — see AUTHORING.md) into a real,
   ready-to-play URL fragment via kernel.js's own compileCartSource() —
   the same compiler every Debug-tab author uses, not a second bespoke
   encode path. The menu (runtime.js's renderMenu) never sees the
   in-memory authored object, only the fragment string each cart
   compiles to — it rebuilds everything it shows (name, author,
   thumbnail) by decoding that fragment, the same as it would for any
   fragment a player pasted in. That's deliberate: a shelf card is proof
   the fragment itself works, not a claim about it.

   `CARTS` is a mutable object (not reassigned) so other modules can
   `import { CARTS } from './carts/index.js'` and see it filled in once
   registerAllCarts() finishes, via ES modules' live-binding semantics.
   ============================================================ */
"use strict";
const K = window.UrlcadeKernel;
const { compileCartSource, decodeCartUrl } = K;
import { buildFlappyCart } from './flappy-bird.js';
import { buildRacerCart } from './race-car.js';
import { buildRoguelikeCart } from './cave-crawler.js';
import { buildPlatformerCart } from './run-and-jump.js';
import { buildCastleCrusherCart } from './castle-crusher.js';

const CARTS = {};

async function registerCart(key, builder){
  const { fragment, name, author } = await compileCartSource(builder());
  CARTS[key] = { fragment, name, author };
}

// Externally-authored carts — already-compiled fragments this repo has no
// source object for (built elsewhere, e.g. by another agent working purely
// from AUTHORING.md against the live site, not from this codebase), rather
// than a local carts/*.js builder run through compileCartSource. Registered
// the same way either path ends up: a {fragment, name, author} CARTS entry
// that renderMenu() decodes itself to build a card — a fragment doesn't need
// a builder function checked into this repo to be shelf-worthy, only to
// decode (see this file's own header, and DESIGN.md §34).
const EXTERNAL_CARTS = [
  ['breakout', 'Breakout,Claude,z.VVHNbtNAEP5m1j9rJ22ciDht0tjrS-DQqlEQQhwQKZHgQgqCA-0xqtw2UmmoCUi99QGQQOIEB8ijIM7lDTjwEpxh1ikSrDUz33w7M56ZJSLCQr4fqD3Qt9_CHsXOo_xw7j6dHh3PFcDAb7jPDmZFTnCss_Fw8iI3j9_khdkyRX5Y5K-OzXwmcF6cE1wbY_Znr83z6Wn2f8jLk8m5mRxNpqcNYDgEro2Aix0RwYv78rfR98vLe58-rn9dcma0lIVgSJwRWVzJcOfdt193pUUYDRC0tt02NBQZzST8cIWi6GdUI60JxnS7NWqUN--HnnAX_XKev-cLekjBATGCTEpRBupRSuxkBHYzIvYyYvYzUlIjtYXSEjlWuVZ5iceVeuszrOMnPlfrrQ8QW9O84qVariPNq14a9DgNE52FSIIstA-RhW6ixHqpSvzS-s0nSLwSes0RBgUSp3WGxBVlZKCyHzFkSAkSA9ar8U3RJc8VadeSAWs_ineX4N8rsvEHZbwtIqSyZBjFZ5D_ps5gC2uOLKQab2LNThi1NnE9YQqlKS779VWqhLTh7mDXtji2LY7R30a8DmMfxZd99rcpvrF0PXEt4NX4jmjxmuOSCGS7UTxeAqEH-2jb5VY7jtSvNuJb6NiNR_GegEpXddCGz3Xd5Tax8mW8LjX3bBKVSWyTJNa9ShLTdduqsqEGfwA'],
];

function registerExternalCart(key, fragment){
  const { name, author } = decodeCartUrl(fragment);
  CARTS[key] = { fragment, name, author };
}

async function registerAllCarts(){
  await registerCart('flappy', buildFlappyCart);
  await registerCart('racer', buildRacerCart);
  await registerCart('roguelike', buildRoguelikeCart);
  await registerCart('platformer', buildPlatformerCart);
  await registerCart('castle', buildCastleCrusherCart);
  for(const [key, fragment] of EXTERNAL_CARTS) registerExternalCart(key, fragment);
}

export { CARTS, registerAllCarts };
