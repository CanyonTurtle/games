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
import { buildBreakoutCart } from './breakout.js';
import { buildPlantCart } from './plant.js';
import { buildMiniGolfCart } from './mini-golf.js';

const CARTS = {};

async function registerCart(key, builder){
  const { fragment, name, author } = await compileCartSource(builder());
  CARTS[key] = { fragment, name, author };
}

// Externally-authored carts — already-compiled fragments this repo has no
// source object for at all (built elsewhere, e.g. by another agent working
// purely from AUTHORING.md against the live site, never touching this
// codebase), registered directly rather than run through a local builder +
// compileCartSource. Same {fragment, name, author} CARTS shape either way —
// renderMenu() decodes every card from its fragment regardless of which
// path produced it (see this file's own header, DESIGN.md §34). Empty for
// now: the one cart that arrived this way (Breakout) got vendored as real
// local source (breakout.js) once the binary format changed under it —
// DESIGN.md §36 — but the mechanism stays here for the next one.
const EXTERNAL_CARTS = [];

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
  await registerCart('breakout', buildBreakoutCart);
  await registerCart('plant', buildPlantCart);
  await registerCart('golf', buildMiniGolfCart);
  for(const [key, fragment] of EXTERNAL_CARTS) registerExternalCart(key, fragment);
}

export { CARTS, registerAllCarts };
