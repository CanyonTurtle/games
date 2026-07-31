/* ============================================================
   The Urlcade — example cart registry

   Builds every example cart this repo ships (one file per cart under
   carts/, each just a plain "author a JS object, describe its hooks as
   assembly source" builder function — see AUTHORING.md), encodes each
   to bytes and a URL fragment, and round-trips it through decodeCart so
   the menu always shows exactly what a player's link will actually
   decode to. Split out from the former urlcade.html monolith, where
   these five carts and the runtime were the same ~5000-line file.

   `CARTS` is a mutable object (not reassigned) so other modules can
   `import { CARTS } from './carts/index.js'` and see it filled in once
   registerAllCarts() finishes, via ES modules' live-binding semantics.
   ============================================================ */
"use strict";
const K = window.UrlcadeKernel;
const { encodeCart, decodeCart, b64urlEncode, encodePayload, generatePalette, describeControls } = K;
import { cssColorToHex } from '../color-utils.js';
import { buildFlappyCart } from './flappy-bird.js';
import { buildRacerCart } from './race-car.js';
import { buildRoguelikeCart } from './cave-crawler.js';
import { buildPlatformerCart } from './run-and-jump.js';
import { buildCastleCrusherCart } from './castle-crusher.js';

const CARTS = {};

async function registerCart(key, title, genre, accentIdx, builder){
  const authored = builder();
  const encoded = encodeCart(authored);
  const rawPayload = 'r.' + b64urlEncode(encoded); // for the menu's "savings" display, see renderMenu
  const payload = await encodePayload(encoded);
  const decoded = decodeCart(encoded);
  const palette = generatePalette(decoded);
  const accent = palette[accentIdx] ? cssColorToHex(palette[accentIdx]) : '#e0a030';
  const controlsText = describeControls(decoded);
  CARTS[key] = { title, controlsText, genre, accent, payload, byteLen: encoded.length, charLen: payload.length,
    rawCharLen: rawPayload.length, compressed: payload.startsWith('z.'), decoded };
}

async function registerAllCarts(){
  await registerCart('flappy', 'Flappy Bird', 'cart_type 63 · generic/raw', 2, buildFlappyCart);
  await registerCart('racer', 'Race Car', 'cart_type 2 · racer/golf', 13, buildRacerCart);
  await registerCart('roguelike', 'Cave Crawler', 'cart_type 3 · roguelike/dungeon', 12, buildRoguelikeCart);
  await registerCart('platformer', 'Run & Jump', 'cart_type 4 · platformer', 11, buildPlatformerCart);
  await registerCart('castle', 'Castle Crusher', 'cart_type 5 · destruction/arcade', 10, buildCastleCrusherCart);
}

export { CARTS, registerAllCarts };
