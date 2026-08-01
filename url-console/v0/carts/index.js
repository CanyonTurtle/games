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
const { compileCartSource } = K;
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

async function registerAllCarts(){
  await registerCart('flappy', buildFlappyCart);
  await registerCart('racer', buildRacerCart);
  await registerCart('roguelike', buildRoguelikeCart);
  await registerCart('platformer', buildPlatformerCart);
  await registerCart('castle', buildCastleCrusherCart);
}

export { CARTS, registerAllCarts };
