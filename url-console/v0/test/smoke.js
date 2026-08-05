// Regression test for the unified Play/Debug experience (DESIGN.md §29,
// §30): assembles the real deployed site layout (via ../build-site.sh —
// the same script .github/workflows/pages.yml uses, so this tests
// exactly what ships, not an approximation of it), serves it locally,
// and drives it with a real browser.
//
// Requires Playwright with a Chromium binary available (this repo does
// not otherwise depend on it — it's a maintainer/verification tool, not
// part of the zero-dependency shipped runtime):
//   npm install playwright && npx playwright install chromium
//   node url-console/v0/test/smoke.js
"use strict";
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const { execFileSync } = require('child_process');

const MIME = { '.html':'text/html', '.js':'text/javascript', '.mjs':'text/javascript', '.md':'text/markdown', '.json':'application/json' };

// `prefix`, when given, simulates a subpath deployment (this site published
// under e.g. https://a-custom-domain/games/ rather than the domain root —
// a real, current deployment target, not a hypothetical): requests outside
// the prefix 404, and it's stripped before resolving to a file. Root-
// absolute paths (`/kernel.js`) break under a prefix; paths relative to the
// referencing file don't — see the subpath test below and DESIGN.md §29.
function serve(root, prefix){
  prefix = prefix || '';
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let p = decodeURIComponent(req.url.split('?')[0]);
      if(prefix){
        if(!p.startsWith(prefix)){ res.writeHead(404); res.end('not found: ' + p); return; }
        p = p.slice(prefix.length) || '/';
      }
      if(p === '/') p = '/index.html';
      const full = path.join(root, p);
      fs.readFile(full, (err, data) => {
        if(err){ res.writeHead(404); res.end('not found: ' + p); return; }
        res.writeHead(200, {'Content-Type': MIME[path.extname(full)] || 'application/octet-stream'});
        res.end(data);
      });
    });
    server.listen(0, () => resolve(server));
  });
}

async function main(){
  const siteDir = fs.mkdtempSync(path.join(os.tmpdir(), 'urlcade-site-'));
  execFileSync(path.join(__dirname, '..', '..', 'build-site.sh'), [siteDir], {stdio: 'inherit'});

  const server = await serve(siteDir);
  const port = server.address().port;
  const base = `http://localhost:${port}`;

  const browser = await chromium.launch();
  let failures = 0;
  function check(label, ok, detail){
    console.log((ok ? 'OK   ' : 'FAIL ') + label + (detail ? ' — ' + detail : ''));
    if(!ok) failures++;
  }

  // 0. Every local <script src>/import reference in the assembled site
  // actually got cache-busted (build-site.sh's job — see its own comment
  // and DESIGN.md §32: a browser or CDN serving a stale cached .js file
  // after a deploy is exactly what made two brand-new buttons look wired
  // up but silently do nothing). A structural check, not a behavioral
  // one — HTTP caching itself isn't practical to simulate faithfully
  // here, but "did the versioning actually apply" is, and regressing
  // that silently is exactly the kind of thing worth locking in.
  {
    const cachebustFiles = ['index.html', 'main.js', 'runtime.js', 'inspector.js', 'carts/index.js',
      ...fs.readdirSync(path.join(siteDir, 'carts')).filter(f => f !== 'index.js').map(f => 'carts/' + f)];
    // An *unversioned* local .js reference — `.js` immediately followed by
    // the closing quote, no `?v=...` in between. Checking for the absence
    // of the bad pattern (rather than trying to fully re-match the good
    // one, query string and all) is the robust direction here: it doesn't
    // need to know or guess the version's exact format.
    let allBusted = true, sample = '';
    for(const rel of cachebustFiles){
      const content = fs.readFileSync(path.join(siteDir, rel), 'utf8');
      const unversioned = [...content.matchAll(/(?:src="|from ')([\w./-]+\.js)(["'])/g)];
      if(unversioned.length){ allBusted = false; sample = `${rel}: ${unversioned[0][0]}`; }
    }
    check('every local script/import reference is cache-busted (?v=...)', allBusted, sample);
  }

  // 1. The shelf: all nine carts register and play, no console/page
  // errors — the five original examples, Breakout (vendored from a
  // decompiled externally-authored fragment, DESIGN.md §35), Water the
  // Plant (pointer input + on_draw immediate-mode drawing, DESIGN.md
  // §36), Mini Golf (a tile-map course from the track generator,
  // reused for a fairway instead of a road — no new kernel features),
  // and Corridor (a raycast first-person shooter — the cave generator
  // reused purely as a wall/floor grid, the whole screen repainted every
  // frame by a single on_draw'd DRAW_LINE raycaster, DESIGN.md §54).
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if(m.type() === 'error') errors.push(m.text()); });

  await page.goto(`${base}/index.html`);
  await page.waitForFunction(() => window.__urlcadeDebug && Object.keys(window.__urlcadeDebug.CARTS).length === 9, {timeout: 10000});
  check('all 9 shelf carts registered', true);

  // 1b. Palette contrast (DESIGN.md §41/§44): every shelf cart's two
  // generated entity ramps (8-11, 12-15 — the ramps entity sprites draw
  // from, see spec/skill/references/cart-object.md's Palette section)
  // must land far enough in hue from the terrain ramp (0-7) *and* from
  // each other, and saturated/lit enough to read as foreground,
  // regardless of how muted a cart
  // author chose the terrain ramp to be. A real behavioral check on
  // generatePalette()'s own output, not just "the cart loads" — this is
  // exactly the class of bug (blue car, ~15% saturated, on a ~15%
  // saturated green road) that loaded fine and looked broken. There's no
  // paletteMode branch to check anymore — every cart is procedural now.
  // Thresholds (45deg entity-entity, 50deg terrain-entity) match §44's
  // dynamic, author-steerable hue placement's brute-force-verified floor
  // — looser than an intermediate draft's 90/80deg on purpose: that
  // rigidity made a real, legitimate request ("yellow bird, green pipes,
  // blue sky" — DESIGN.md §44) geometrically impossible, since yellow
  // and green sit only ~70deg apart on the wheel and no floor above that
  // can ever honor both as independently placed entity hues. This
  // threshold is deliberately close to the algorithm's actual proven
  // floor (not a comfortable-looking round number well above it), so a
  // future regression that quietly erodes the guarantee gets caught
  // here rather than only by eye.
  {
    const paletteChecks = await page.evaluate(async () => {
      const K = window.UrlcadeKernel;
      const out = {};
      for(const [key, c] of Object.entries(window.__urlcadeDebug.CARTS)){
        const {payload} = K.decodeCartUrl(c.fragment);
        const cart = K.decodeCart(await K.decodePayloadToBytes(payload));
        out[key] = {baseHue: cart.paletteParams[0], palette: K.generatePalette(cart)};
      }
      return out;
    });
    let allOk = true, detail = '';
    for(const [key, {baseHue, palette}] of Object.entries(paletteChecks)){
      const parse = s => s.match(/hsl\(([\d.]+),(\d+)%,(\d+)%\)/).slice(1).map(Number);
      const base = palette.slice(0, 8).map(parse);
      const entityA = palette.slice(8, 12).map(parse);
      const entityB = palette.slice(12, 16).map(parse);
      const circDist = (a,b) => { let d = Math.abs(a-b) % 360; return d > 180 ? 360-d : d; };
      let minBaseEntitySep = 999, minEntityEntitySep = 999;
      for(const [h] of entityA) minBaseEntitySep = Math.min(minBaseEntitySep, circDist(h, baseHue));
      for(const [h] of entityB) minBaseEntitySep = Math.min(minBaseEntitySep, circDist(h, baseHue));
      for(const [hA] of entityA) for(const [hB] of entityB) minEntityEntitySep = Math.min(minEntityEntitySep, circDist(hA, hB));
      // Index 0 of each entity ramp is excluded here — it's the ramp's
      // shared near-black "ink" shade (DESIGN.md §44), deliberately
      // low-saturation so it reads as a consistent outline color across
      // every ramp regardless of hue. Only the three visible/hued shades
      // need to clear the "reads as a saturated foreground color" floor.
      const minEntitySat = Math.min(...entityA.slice(1).map(c=>c[1]), ...entityB.slice(1).map(c=>c[1]));
      // Lightness, not just hue/saturation, is its own check: a prior
      // version of this fix computed the entity ramps' lightness floor
      // with Math.min(cartLightMin, FLOOR) instead of Math.max, which
      // silently *undid* the floor for any cart with a dark terrain
      // lightMin — hue/saturation alone passed even with that bug live,
      // so this specifically re-checks that entities reach meaningfully
      // lighter than the terrain does. Checked at the ramp's lightest
      // (highlight) shade specifically — entityA[3], index 11 — rather
      // than some interior "mid" index: which fractional step of the
      // 4-shade ramp counts as "the middle one" shifted under §44's ink
      // step (index 0 of each ramp is now a fixed near-black, not part
      // of the lightness curve at all, see above), so the one point in
      // the ramp guaranteed stable across that kind of internal reshuffle
      // is the top of accentLightMax's own floor.
      const [, , baseLightMid] = base[4];
      const [, , entityALightMid] = entityA[3];
      const ok = minBaseEntitySep >= 50 && minEntityEntitySep >= 45 && minEntitySat >= 50 && entityALightMid > baseLightMid + 10;
      if(!ok){ allOk = false; detail += `${key}: baseEntitySep=${minBaseEntitySep.toFixed(0)} entityEntitySep=${minEntityEntitySep.toFixed(0)} minSat=${minEntitySat}%; `; }
    }
    check('every cart\'s two entity ramps are hue-separated from terrain and each other, saturated, and lighter than terrain',
      allOk, detail || Object.keys(paletteChecks).join(','));
  }

  // 1b2. The 8 shipped carts above only sample a tiny slice of
  // generatePalette()'s input space — the actual guarantee is supposed
  // to hold for *any* baseHue/offsetA/offsetB a cart could pick,
  // including combinations no shipped cart happens to use. Checked
  // directly by sweeping a dense grid of base hues and every extreme
  // combination of the two offset bytes and confirming the worst case
  // found still clears a real floor. This is exactly the check that
  // would have caught both DESIGN.md §43's and §44's constant
  // miscalibrations before they were tuned by hand and eyeballed instead
  // of swept.
  {
    const sweepResult = await page.evaluate(() => {
      const K = window.UrlcadeKernel;
      const parse = s => s.match(/hsl\(([\d.]+),(\d+)%,(\d+)%\)/).slice(1).map(Number);
      const circDist = (a,b) => { let d = Math.abs(a-b) % 360; return d > 180 ? 360-d : d; };
      const bytes = [0,1,32,64,65,100,128,191,192,254,255];
      let worstBaseEntity = 999, worstEntityEntity = 999;
      for(let baseHue = 0; baseHue < 360; baseHue += 15){
        for(const oA of bytes) for(const oB of bytes){
          const pal = K.generatePalette({paletteParams:[baseHue,0,15,50,20,80,oA,oB]});
          const baseHues = pal.slice(0,8).map(c => parse(c)[0]);
          const aHues = pal.slice(8,12).map(c => parse(c)[0]);
          const bHues = pal.slice(12,16).map(c => parse(c)[0]);
          for(const bh of baseHues) for(const ah of aHues) worstBaseEntity = Math.min(worstBaseEntity, circDist(bh,ah));
          for(const bh of baseHues) for(const bbh of bHues) worstBaseEntity = Math.min(worstBaseEntity, circDist(bh,bbh));
          for(const ah of aHues) for(const bh2 of bHues) worstEntityEntity = Math.min(worstEntityEntity, circDist(ah,bh2));
        }
      }
      return {worstBaseEntity, worstEntityEntity};
    });
    check('generatePalette()\'s hue-separation guarantee holds across a dense sweep of base hues and offset bytes, not just shipped carts',
      sweepResult.worstBaseEntity >= 50 && sweepResult.worstEntityEntity >= 48, JSON.stringify(sweepResult));
  }

  // 1c. Two real bugs surfaced while building the check above turned out
  // to share one root cause: paletteParams packs into 8 unsigned bytes,
  // but nothing enforced that on the way in — an accentOffset of 260 or
  // 280 (both used by shipped carts) silently wrapped mod 256 through
  // ByteWriter.u8's old `v & 0xFF`, landing the accent hue somewhere the
  // cart's own source never asked for, with no error anywhere to point
  // at why. Fixed at the one choke point every u8 field writes through,
  // so it can't recur silently for this field or any other. Checked
  // directly (not by re-finding an in-range shipped cart, which
  // wouldn't exercise the guard at all): a deliberately out-of-range
  // value must throw, and a valid one must still encode.
  {
    const u8GuardResult = await page.evaluate(async () => {
      const K = window.UrlcadeKernel;
      // Round-trip a real, already-valid shipped cart (flappy) through
      // decodeCart so every *other* field is already well-formed — the
      // point is isolating the check to the one field being mutated,
      // not also exercising "is this a complete cart object."
      const {payload} = K.decodeCartUrl(window.__urlcadeDebug.CARTS.flappy.fragment);
      const cart = K.decodeCart(await K.decodePayloadToBytes(payload));
      let threw = false;
      try{ K.encodeCart({...cart, paletteParams:[100,0,0,0,0,0,260,0]}); }
      catch(e){ threw = true; }
      let validStillWorks = false;
      try{ K.encodeCart({...cart, paletteParams:[100,0,0,0,0,0,240,0]}); validStillWorks = true; }
      catch(e){ /* leave false */ }
      return {threw, validStillWorks};
    });
    check('encodeCart rejects an out-of-range (>255) paletteParams byte instead of silently wrapping it',
      u8GuardResult.threw && u8GuardResult.validStillWorks, JSON.stringify(u8GuardResult));
  }

  // 1d. Same class of bug, found while building the sprite shape editor:
  // shape-list sprite coordinates (1/8px fixed point) pre-masked with
  // `& 0xFF` before handing off to ByteWriter.u8() — the exact guard 1c
  // added never got a chance to fire for this field, so a shape dragged
  // past the 31.875px ceiling would've silently wrapped to a small wrong
  // value instead of throwing. Same check shape as 1c: a deliberately
  // out-of-range coordinate must throw, an in-range one must still work.
  {
    const shapeGuardResult = await page.evaluate(async () => {
      const K = window.UrlcadeKernel;
      const {payload} = K.decodeCartUrl(window.__urlcadeDebug.CARTS.flappy.fragment);
      const cart = K.decodeCart(await K.decodePayloadToBytes(payload));
      const shapeSprite = {kind:1, w:16, h:16, shapes:[{type:0, cx:8, cy:8, rx:3, ry:3, color:1}]};
      let threw = false;
      try{ K.encodeCart({...cart, sprites:[{...shapeSprite, shapes:[{...shapeSprite.shapes[0], cx:40}]}]}); }
      catch(e){ threw = true; }
      let validStillWorks = false;
      try{ K.encodeCart({...cart, sprites:[shapeSprite]}); validStillWorks = true; }
      catch(e){ /* leave false */ }
      return {threw, validStillWorks};
    });
    check('encodeCart rejects an out-of-range (>31.875px) shape coordinate instead of silently wrapping it',
      shapeGuardResult.threw && shapeGuardResult.validStillWorks, JSON.stringify(shapeGuardResult));
  }

  // Each cart's own fragment carries its name/author in the URL envelope
  // (DESIGN.md §34) — never a manual title/genre/accentIdx passed to a
  // registerCart() call (that whole call shape is gone, see carts/
  // index.js). Checked straight from the fragment, the same way the shelf
  // itself reads it, not from anything the builder function returned.
  const envelopes = await page.evaluate(() => {
    const K = window.__urlcadeDebug;
    return Object.fromEntries(Object.entries(K.CARTS).map(([k, c]) => [k, K.decodeCartUrl(c.fragment)]));
  });
  check('every shelf cart\'s fragment carries a non-empty name+author envelope',
    Object.values(envelopes).every(e => e.name && e.author), JSON.stringify(envelopes));

  // The shelf itself never sees the in-memory authored cart object — it
  // rebuilds each card (thumbnail, name, author) purely by decoding the
  // fragment, same as any pasted link. Checked by reading the rendered
  // DOM, not CARTS, so a regression that broke that decode path (and fell
  // back to the div's error branch) would be caught here.
  const shelfCards = await page.evaluate(() => Array.from(document.querySelectorAll('#cartList .cart')).map(div => ({
    hasThumb: !!div.querySelector('.cart-thumb'),
    title: div.querySelector('h2')?.textContent || '',
    author: div.querySelector('.cart-author')?.textContent || '',
  })));
  check('all 9 shelf cards rendered a thumbnail canvas + name + author',
    shelfCards.length === 9 && shelfCards.every(c => c.hasThumb && c.title && /^by /.test(c.author)),
    JSON.stringify(shelfCards));

  const keys = await page.evaluate(() => Object.keys(window.__urlcadeDebug.CARTS));
  await page.evaluate((k) => { location.hash = window.__urlcadeDebug.CARTS[k].fragment; }, keys[0]);
  await page.waitForTimeout(250);
  let state = await page.evaluate(() => {
    const w = window.__urlcadeDebug.getWorld();
    return w ? {ok: true, fault: w.cartFault, entities: w.entities.length} : {ok: false};
  });
  check(`cart "${keys[0]}" plays (world exists, no cart fault)`, state.ok && !state.fault, JSON.stringify(state));
  for(const key of keys.slice(1)){
    await page.evaluate((k) => { location.hash = window.__urlcadeDebug.CARTS[k].fragment; }, key);
    await page.waitForTimeout(200);
    const st = await page.evaluate(() => {
      const w = window.__urlcadeDebug.getWorld();
      return w ? {ok: true, fault: w.cartFault} : {ok: false};
    });
    check(`cart "${key}" plays (world exists, no cart fault)`, st.ok && !st.fault, JSON.stringify(st));
  }

  // 1b. Per-entity assetIndex override (props[8 + extFieldCount], one slot
  // past every ext field — see DESIGN.md for why not one of the base
  // eight's nominally-free slots: doom-like.js's own props[6] usage,
  // ANGLEPROP, is exactly the collision that ruled that out). A freshly
  // spawned entity defaults to its type's assetIndex (auto-set in
  // spawnEntity), but the renderer reads each entity's own current value
  // every frame, not the type's constant — a hook overwriting one entity's
  // slot should retarget just that entity, independent of every other
  // instance of its type. Proven without any fragile pixel/canvas readback
  // (this repo has no precedent for that, and the live game canvas may be
  // WebGL without preserveDrawingBuffer, so toDataURL right after a draw
  // isn't reliable): instead, wrap world.spriteCanvases in a Proxy that
  // records which index actually got read during a real render() call —
  // both the Canvas2D and WebGL draw paths index into that same array (the
  // WebGL path uses it for texture dimensions), so this is backend-agnostic.
  await page.evaluate((k) => { location.hash = window.__urlcadeDebug.CARTS[k].fragment; }, 'roguelike');
  await page.waitForTimeout(250);
  const assetIndexResult = await page.evaluate(() => {
    const w = window.__urlcadeDebug.getWorld();
    const player = w.entities.find(e => e.typeId === 0);
    const type = w.cart.entityTypes[player.typeId];
    const assetIndexProp = 8 + type.extFieldCount; // cave-crawler's PLAYER has extFieldCount:0, so this is prop 8
    const defaultMatchesType = player.props[assetIndexProp] === type.assetIndex;

    // Isolate rendering to just the player for this check — cave-crawler's
    // world also has monster entities, and the Proxy below records the last
    // spriteCanvases access across the *whole* render() call; with every
    // entity still in the scene, whichever one happens to draw last (not
    // necessarily the player) would decide lastIndex, not the entity this
    // check actually cares about.
    const originalEntities = w.entities;
    w.entities = [player];

    const original = w.spriteCanvases;
    let lastIndex = null;
    w.spriteCanvases = new Proxy(original, {
      get(target, prop, receiver){
        if(typeof prop === 'string' && /^\d+$/.test(prop)) lastIndex = Number(prop);
        return Reflect.get(target, prop, receiver);
      }
    });

    window.__urlcadeDebug.forceRender(1);
    const indexAtSpawnDefault = lastIndex;

    const savedProp = player.props[assetIndexProp];
    player.props[assetIndexProp] = 1; // roguelike's second sprite (monster) — see carts/cave-crawler.js
    lastIndex = null;
    window.__urlcadeDebug.forceRender(1);
    const indexAfterOverride = lastIndex;

    w.entities = originalEntities; // restore before any other check touches this world

    player.props[assetIndexProp] = savedProp; // restore — a stray frame before the next hash change shouldn't render a mutated world
    w.spriteCanvases = original; // restore before any other check touches this world
    return {defaultMatchesType, indexAtSpawnDefault, indexAfterOverride, faultAfter: w.cartFault};
  });
  check('spawned entity defaults its assetIndex prop to its type\'s assetIndex', assetIndexResult.defaultMatchesType, JSON.stringify(assetIndexResult));
  check('renderer reads spriteCanvases at the spawn-default index before any override', assetIndexResult.indexAtSpawnDefault === 0, JSON.stringify(assetIndexResult));
  check('overriding one entity\'s assetIndex prop retargets which sprite the renderer reads, with no cart fault', assetIndexResult.indexAfterOverride === 1 && !assetIndexResult.faultAfter, JSON.stringify(assetIndexResult));

  // 1c. Four real uses of the assetIndex-override feature, each checked
  // against its own cart's actual hook logic (direct prop manipulation +
  // world.step(), not pixel reads — same reasoning as 1b above).

  // Flappy: wing-flap frame follows vertical velocity sign every tick,
  // computed fresh each step rather than latched — set vy hard negative
  // (rising) and hard positive (falling) and confirm props[8] follows.
  await page.evaluate((k) => { location.hash = window.__urlcadeDebug.CARTS[k].fragment; }, 'flappy');
  await page.waitForTimeout(250);
  const flapResult = await page.evaluate(() => {
    const w = window.__urlcadeDebug.getWorld();
    const bird = w.entities.find(e => e.typeId === 0);
    bird.props[3] = -10; // hard rising
    w.step();
    const upFrame = bird.props[8];
    bird.props[3] = 10; // hard falling
    w.step();
    const downFrame = bird.props[8];
    return {upFrame, downFrame, fault: w.cartFault};
  });
  check('Flappy: rising velocity shows the wing-up frame', flapResult.upFrame === 1 && !flapResult.fault, JSON.stringify(flapResult));
  check('Flappy: falling velocity shows the wing-down frame', flapResult.downFrame === 0 && !flapResult.fault, JSON.stringify(flapResult));

  // Cave Crawler: player switches to its dead sprite the moment HP
  // reaches 0 (on_frame), and a monster holds its dead sprite for
  // DEATH_HOLD_TICKS (24) before actually being removed, rather than
  // vanishing the instant it dies.
  await page.evaluate((k) => { location.hash = window.__urlcadeDebug.CARTS[k].fragment; }, 'roguelike');
  await page.waitForTimeout(250);
  const roguelikeDeathResult = await page.evaluate(() => {
    const w = window.__urlcadeDebug.getWorld();
    const player = w.entities.find(e => e.typeId === 0);
    player.props[5] = 0; // HP
    w.step();
    const playerDeadFrame = player.props[8];

    const monster = w.entities.find(e => e.typeId === 1);
    const monsterId = monster.id;
    monster.props[5] = 0; // HP
    w.step();
    const monsterStillThere = !!w.entities.find(e => e.id === monsterId);
    const monsterDeadFrame = monsterStillThere ? w.entities.find(e => e.id === monsterId).props[9] : null;
    for(let i = 0; i < 30; i++) w.step(); // past DEATH_HOLD_TICKS (24)
    const monsterRemoved = !w.entities.find(e => e.id === monsterId);
    return {playerDeadFrame, monsterStillThere, monsterDeadFrame, monsterRemoved, fault: w.cartFault};
  });
  check('Cave Crawler: player shows its dead sprite the frame HP reaches 0', roguelikeDeathResult.playerDeadFrame === 2, JSON.stringify(roguelikeDeathResult));
  check('Cave Crawler: monster holds its dead sprite instead of vanishing instantly', roguelikeDeathResult.monsterStillThere && roguelikeDeathResult.monsterDeadFrame === 3, JSON.stringify(roguelikeDeathResult));
  check('Cave Crawler: monster is actually removed once the death hold expires', roguelikeDeathResult.monsterRemoved && !roguelikeDeathResult.fault, JSON.stringify(roguelikeDeathResult));

  // Run & Jump: same player-death sprite switch as Cave Crawler, on_frame,
  // the moment HP reaches 0.
  await page.evaluate((k) => { location.hash = window.__urlcadeDebug.CARTS[k].fragment; }, 'platformer');
  await page.waitForTimeout(250);
  const platformerDeathResult = await page.evaluate(() => {
    const w = window.__urlcadeDebug.getWorld();
    const player = w.entities.find(e => e.typeId === 0);
    player.props[5] = 0; // HP
    w.step();
    return {deadFrame: player.props[8], fault: w.cartFault};
  });
  check('Run & Jump: player shows its dead sprite the frame HP reaches 0', platformerDeathResult.deadFrame === 3 && !platformerDeathResult.fault, JSON.stringify(platformerDeathResult));

  // Race Car: the player car's own current assetIndex (props[12], 8 +
  // extFieldCount(4)) strobes between normal (0) and the flash sprite (3)
  // while g_lap_flash counts down, and is forced back to normal (0) the
  // instant the countdown reaches 0 — not left at whatever the strobe
  // last landed on.
  await page.evaluate((k) => { location.hash = window.__urlcadeDebug.CARTS[k].fragment; }, 'racer');
  await page.waitForTimeout(250);
  const lapFlashResult = await page.evaluate(() => {
    const w = window.__urlcadeDebug.getWorld();
    const player = w.entities.find(e => e.id === w.globals[0]);
    w.globals[10] = 8; // g_lap_flash — one full strobe cycle (MOD 8) left
    const seenDuringFlash = new Set();
    for(let i = 0; i < 8; i++){ w.step(); seenDuringFlash.add(player.props[12]); }
    const afterFlash = player.props[12];
    return {seenDuringFlash: [...seenDuringFlash], afterFlash, fault: w.cartFault};
  });
  check('Race Car: the player car\'s sprite strobes between normal and the flash frame during a lap flash', lapFlashResult.seenDuringFlash.includes(0) && lapFlashResult.seenDuringFlash.includes(3), JSON.stringify(lapFlashResult));
  check('Race Car: the player car\'s sprite is back to normal once the flash ends', lapFlashResult.afterFlash === 0 && !lapFlashResult.fault, JSON.stringify(lapFlashResult));

  // 1d. Persistence (LOAD_PERSIST/STORE_PERSIST, localStorage-backed,
  // hash-keyed per cart). Direct World-construction tests first — bypass
  // gameplay entirely to isolate the storage mechanism itself — then one
  // end-to-end test through Flappy's own real high-score hooks.
  await page.evaluate((k) => { location.hash = window.__urlcadeDebug.CARTS[k].fragment; }, 'flappy');
  await page.waitForTimeout(250);
  const persistMechanismResult = await page.evaluate(async () => {
    const K = window.__urlcadeDebug;
    const w = K.getWorld();
    const flappyCart = w.cart;
    const keyLooksRight = typeof w.persistKey === 'string' && w.persistKey.startsWith('urlcade_persist_');

    w.persist[0] = 777;
    w.savePersist();
    const reloaded = new K.World(flappyCart); // fresh World, identical cart object
    const roundTripped = reloaded.persist[0] === 777;
    const sameKey = reloaded.persistKey === w.persistKey;

    // A different cart (racer) must not see flappy's data — different
    // encoded bytes, different hash, different localStorage key.
    const { payload: racerPayload } = K.decodeCartUrl(K.CARTS.racer.fragment);
    const racerCart = K.decodeCart(await K.decodePayloadToBytes(racerPayload));
    const racerWorld = new K.World(racerCart);
    const noCrossCartLeak = racerWorld.persist[0] !== 777;
    const differentKey = racerWorld.persistKey !== w.persistKey;

    // An edited cart (even a trivial change) must also get a fresh key —
    // versioning "for free" from hashing the whole encoded cart, not a
    // separate scheme. Clone flappy's own decoded cart and tweak one
    // field before re-hashing via a new World.
    const editedCart = JSON.parse(JSON.stringify(flappyCart));
    editedCart.rngSeed = (editedCart.rngSeed + 1) & 0xff;
    // hooks are Uint8Array — JSON round-tripping loses that, encodeCart
    // needs the real type back before this cart is constructible again.
    for(const name of Object.keys(editedCart.hooks)) editedCart.hooks[name] = new Uint8Array(Object.values(editedCart.hooks[name]));
    const editedWorld = new K.World(editedCart);
    const editDoesNotReadOldSave = editedWorld.persist[0] !== 777;
    const editGetsDifferentKey = editedWorld.persistKey !== w.persistKey;

    return {keyLooksRight, roundTripped, sameKey, noCrossCartLeak, differentKey, editDoesNotReadOldSave, editGetsDifferentKey};
  });
  check('persist key looks like the documented urlcade_persist_<hash> shape', persistMechanismResult.keyLooksRight, JSON.stringify(persistMechanismResult));
  check('a value written via savePersist() round-trips through localStorage into a fresh World for the same cart', persistMechanismResult.roundTripped && persistMechanismResult.sameKey, JSON.stringify(persistMechanismResult));
  check('a different cart does not see another cart\'s persisted data (different hash key)', persistMechanismResult.noCrossCartLeak && persistMechanismResult.differentKey, JSON.stringify(persistMechanismResult));
  check('an edited cart (even one changed byte) gets a fresh key, not the old save', persistMechanismResult.editDoesNotReadOldSave && persistMechanismResult.editGetsDifferentKey, JSON.stringify(persistMechanismResult));

  // End-to-end through Flappy's own hooks: force a score, confirm
  // on_tick's STORE_PERSIST actually fires and on_init's LOAD_PERSIST
  // actually reads it back on the next "play" of the same cart.
  const flappyPersistResult = await page.evaluate(() => {
    const K = window.__urlcadeDebug;
    const w = K.getWorld();
    const bird = w.entities.find(e => e.typeId === 0); // this cart's own g_player
    const scoreGlobal = 2, highScoreGlobal = 6; // FLAPPY_GLOBAL_NAMES.g_score/g_high_score
    w.globals[highScoreGlobal] = 0; // clean slate, in case an earlier check in this run left a stale in-memory value
    // A real pipe entity (typeId 1, not a hijacked bird) positioned just
    // behind the bird on the x axis and not yet marked scored — exactly
    // the state on_tick's check_score branch expects, so this exercises
    // that real hook logic rather than asserting against hand-set globals.
    const pipe = w.spawnEntity(1);
    pipe.props[0] = bird.props[0] - 10;
    pipe.props[9] = 0; // not yet scored
    w.globals[scoreGlobal] = 4;
    w.step();
    const scoreAfterStep = w.globals[scoreGlobal];
    const highScoreAfterStep = w.globals[highScoreGlobal];

    const fresh = new K.World(w.cart); // simulates the next "play" of this same cart — on_init runs for real
    return {scoreAfterStep, highScoreAfterStep, persistedHighScore: fresh.globals[highScoreGlobal], fault: w.cartFault};
  });
  check('Flappy: scoring past the previous best updates g_high_score and persists it (real on_tick hooks)', flappyPersistResult.highScoreAfterStep === 5 && !flappyPersistResult.fault, JSON.stringify(flappyPersistResult));
  check('Flappy: a fresh World for the same cart loads the persisted high score via on_init\'s own LOAD_PERSIST', flappyPersistResult.persistedHighScore === 5, JSON.stringify(flappyPersistResult));

  // Mini Golf's own best-stroke-count persistence — lower is better,
  // unlike Flappy's high score, and the "no record yet" sentinel (0) is
  // itself part of what's being verified.
  await page.evaluate((k) => { location.hash = window.__urlcadeDebug.CARTS[k].fragment; }, 'golf');
  await page.waitForTimeout(250);
  const golfPersistResult = await page.evaluate(() => {
    const K = window.__urlcadeDebug;
    const w = K.getWorld();
    const ball = w.entities.find(e => e.typeId === 0);
    const swingStateG = 1, strokesG = 5, wonG = 6, holeXG = 7, holeYG = 8, bestG = 15; // GOLF_GLOBAL_NAMES
    w.globals[bestG] = 0; // clean slate — "no record yet"
    w.globals[wonG] = 0;
    w.globals[swingStateG] = 2; // "in flight" — required for on_tick's physics/hole-check block to run at all
    w.globals[strokesG] = 3;
    // At rest, exactly on the hole — on_tick's own speed check (DIST(0,0,vx,vy) < STOP_EPS)
    // and hole-distance check (DIST(ball, hole) < HOLE_RADIUS) both pass on this one step,
    // the same real physics/win logic a slow final putt actually triggers in play.
    ball.props[0] = w.globals[holeXG];
    ball.props[1] = w.globals[holeYG];
    ball.props[2] = 0; ball.props[3] = 0;
    w.step();
    const wonAfterStep = w.globals[wonG];
    const bestAfterStep = w.globals[bestG];

    const fresh = new K.World(w.cart); // simulates the next "play" of this same cart — on_init runs for real
    return {wonAfterStep, bestAfterStep, persistedBest: fresh.globals[bestG], fault: w.cartFault};
  });
  check('Mini Golf: holing out sets g_won and records a new best-stroke count (real on_tick hooks)', golfPersistResult.wonAfterStep === 1 && golfPersistResult.bestAfterStep === 3 && !golfPersistResult.fault, JSON.stringify(golfPersistResult));
  check('Mini Golf: a fresh World for the same cart loads the persisted best via on_init\'s own LOAD_PERSIST', golfPersistResult.persistedBest === 3, JSON.stringify(golfPersistResult));

  // 1e. Sound — 4 persistent voices driven by SET_VOICE_FREQ/WAVE/GAIN
  // and TRIGGER_VOICE. Two layers: (a) the VM-level opcode dispatch,
  // checked with a mock ctx so it's independent of whether headless
  // Chromium's Web Audio actually runs, then (b) the real World's node
  // graph, checked via its actual node/param state.
  await page.evaluate((k) => { location.hash = window.__urlcadeDebug.CARTS[k].fragment; }, 'flappy');
  await page.waitForTimeout(250);
  const voiceOpcodeDispatchResult = await page.evaluate(() => {
    const K2 = window.UrlcadeKernel;
    const calls = [];
    const ctx = {
      constants: [523], globals: [0,0,0,0], self:null, a:null, b:null, input:0,
      world: {cartFault:false}, findEntity:()=>null, spawn:()=>({id:0,props:[]}),
      getTile:()=>0, tileSurface:()=>0, getCheckpoint:()=>({x:0,y:0}), rng:Math.random,
      setVoiceFreq: (v,f) => calls.push(['freq',v,f]),
      setVoiceWave: (v,w) => calls.push(['wave',v,w]),
      setVoiceGain: (v,g) => calls.push(['gain',v,g]),
      triggerVoice: v => calls.push(['trigger',v]),
    };
    const bc = K2.assemble(['PUSHC 0','SET_VOICE_FREQ 2','SET_VOICE_WAVE 3 1','PUSHI 1','SET_VOICE_GAIN 1','TRIGGER_VOICE 0','HALT'], {constants:{},globals:{}});
    const ok = K2.runHook(bc, ctx);
    return {ok, calls};
  });
  check('SET_VOICE_FREQ pops the stack value and routes (voice, freq) to ctx.setVoiceFreq', JSON.stringify(voiceOpcodeDispatchResult.calls[0]) === JSON.stringify(['freq',2,523]), JSON.stringify(voiceOpcodeDispatchResult));
  check('SET_VOICE_WAVE takes both operands immediate, routes (voice, waveform) to ctx.setVoiceWave', JSON.stringify(voiceOpcodeDispatchResult.calls[1]) === JSON.stringify(['wave',3,1]), JSON.stringify(voiceOpcodeDispatchResult));
  check('SET_VOICE_GAIN pops the stack value and routes (voice, gain) to ctx.setVoiceGain', JSON.stringify(voiceOpcodeDispatchResult.calls[2]) === JSON.stringify(['gain',1,1]), JSON.stringify(voiceOpcodeDispatchResult));
  check('TRIGGER_VOICE has no stack effect and routes voice to ctx.triggerVoice', JSON.stringify(voiceOpcodeDispatchResult.calls[3]) === JSON.stringify(['trigger',0]) && voiceOpcodeDispatchResult.ok, JSON.stringify(voiceOpcodeDispatchResult));

  // Site-wide audio toggle (index.html's speaker icon next to Tinker) —
  // defaults to off, and while off nothing here ever touches an
  // AudioContext at all, not just "produces silence." Checked before
  // anything below turns it on.
  const audioOffByDefaultResult = await page.evaluate(() => {
    const K = window.__urlcadeDebug;
    const w = K.getWorld();
    const enabledByDefault = K.isAudioEnabled();
    w.setVoiceWave(0, 3);
    w.setVoiceFreq(0, 523);
    w.setVoiceGain(1, 0.4);
    w.triggerVoice(2);
    const stillNoVoices = w.voices.every(v => v === null);
    return {enabledByDefault, stillNoVoices};
  });
  check('audio defaults to off (no prior localStorage opt-in)', audioOffByDefaultResult.enabledByDefault === false, JSON.stringify(audioOffByDefaultResult));
  check('while off, voice opcodes are no-ops — no node graph gets built at all, not just silenced', audioOffByDefaultResult.stillNoVoices, JSON.stringify(audioOffByDefaultResult));

  const voiceWorldResult = await page.evaluate(() => {
    const K = window.__urlcadeDebug;
    const w = K.getWorld();
    K.setAudioEnabled(true); // opt in — the rest of this block needs a real node graph to inspect
    const noVoicesYet = w.voices.every(v => v === null);
    w.setVoiceWave(0, 3); // sine
    w.setVoiceFreq(0, 523);
    const afterSine = {type: w.voices[0].osc.type, freq: w.voices[0].osc.frequency.value, oscGain: w.voices[0].oscGain.gain.value, noiseGain: w.voices[0].noiseGain.gain.value};
    w.setVoiceWave(0, 2); // noise — same voice, should re-route gain, not rebuild the node
    const afterNoise = {oscGain: w.voices[0].oscGain.gain.value, noiseGain: w.voices[0].noiseGain.gain.value, sameOsc: !!w.voices[0].osc};
    w.setVoiceGain(1, 0.4);
    const heldGain = w.voices[1].mainGain.gain.value;
    w.triggerVoice(2);
    const triggeredGain = w.voices[2].mainGain.gain.value;
    return {noVoicesYet, afterSine, afterNoise, heldGain, triggeredGain, fault: w.cartFault};
  });
  check('voices are not created until first used (lazy audio init, no unprompted AudioContext)', voiceWorldResult.noVoicesYet, JSON.stringify(voiceWorldResult));
  check('SET_VOICE_WAVE sine + SET_VOICE_FREQ set the oscillator\'s type/frequency and route it (not noise) through the mix', voiceWorldResult.afterSine.type === 'sine' && voiceWorldResult.afterSine.freq === 523 && voiceWorldResult.afterSine.oscGain === 1 && voiceWorldResult.afterSine.noiseGain === 0, JSON.stringify(voiceWorldResult));
  check('switching the same voice to noise re-routes gain instead of rebuilding the node graph', voiceWorldResult.afterNoise.oscGain === 0 && voiceWorldResult.afterNoise.noiseGain === 1 && voiceWorldResult.afterNoise.sameOsc, JSON.stringify(voiceWorldResult));
  // AudioParam values are internally float32 (0.4 reads back as
  // 0.4000000059604645) — epsilon comparison, not strict equality.
  check('SET_VOICE_GAIN sets a sustained volume directly', Math.abs(voiceWorldResult.heldGain - 0.4) < 1e-4, JSON.stringify(voiceWorldResult));
  check('TRIGGER_VOICE snaps to its fixed peak volume to start the decay envelope', Math.abs(voiceWorldResult.triggeredGain - 0.05) < 1e-4 && !voiceWorldResult.fault, JSON.stringify(voiceWorldResult));

  // End-to-end through Flappy's own hooks: flapping, scoring, and
  // crashing each fire their assigned voice exactly once (not, e.g., the
  // crash voice re-triggering every tick the dead bird keeps overlapping
  // the pipe — see the on_collide already_dead guard).
  const flappyVoiceResult = await page.evaluate(() => {
    const K = window.__urlcadeDebug;
    const w = K.getWorld();
    const bird = w.entities.find(e => e.typeId === 0);
    w.globals[1] = 0; // g_dead — clean slate in case an earlier check left this run mid-death
    const calls = [];
    const origTrigger = w.triggerVoice.bind(w);
    w.triggerVoice = v => { calls.push(v); origTrigger(v); };
    w.inputs[0] = 16; // action bit — flap
    w.step();
    const flapCalls = calls.filter(v => v === 0).length;
    w.inputs[0] = 0;
    const pipe = w.spawnEntity(1);
    pipe.props[0] = bird.props[0] - 10;
    pipe.props[9] = 0;
    w.step();
    const scoreCalls = calls.filter(v => v === 1).length;
    const staller = w.spawnEntity(1); // a full-height column pinned to the bird's x every tick, standing in for a pipe the dead bird keeps overlapping as it falls
    staller.props[8] = 20; // extent in tiles (*8px) — spans the whole 160px-tall screen regardless of the bird's y
    staller.props[9] = 1; // already-scored, so check_score's own branch never fires here
    for(let i=0;i<5;i++){ staller.props[0] = bird.props[0]; staller.props[1] = 0; w.step(); } // stays overlapping every one of these ticks
    const crashCalls = calls.filter(v => v === 2).length;
    return {flapCalls, scoreCalls, crashCalls, fault: w.cartFault};
  });
  check('Flappy: flapping triggers the flap voice (real on_input hook)', flappyVoiceResult.flapCalls === 1, JSON.stringify(flappyVoiceResult));
  check('Flappy: scoring triggers the score voice (real on_tick hook)', flappyVoiceResult.scoreCalls === 1, JSON.stringify(flappyVoiceResult));
  check('Flappy: crashing triggers the crash voice exactly once, not once per tick still overlapping (real on_collide hook)', flappyVoiceResult.crashCalls === 1 && !flappyVoiceResult.fault, JSON.stringify(flappyVoiceResult));

  // The actual button, not just the programmatic API — clicking it flips
  // state, persists to localStorage, and updates its own icon. Doesn't
  // assume a particular starting state (earlier checks in this file
  // already flipped the flag programmatically, which the button's own
  // click handler is the only thing that resyncs its icon to) — instead
  // reads whatever the button shows *before* each click and asserts each
  // click flips it, consistently, in both directions.
  const readAudioToggle = () => page.evaluate(() => ({
    enabled: window.__urlcadeDebug.isAudioEnabled(),
    icon: document.getElementById('audioToggleBtn').textContent,
    pressed: document.getElementById('audioToggleBtn').getAttribute('aria-pressed'),
    stored: localStorage.getItem('urlcade_audio_enabled'),
  }));
  const isConsistentlyOn = s => s.enabled === true && s.icon === '\u{1F50A}' && s.pressed === 'true' && s.stored === '1';
  const isConsistentlyOff = s => s.enabled === false && s.icon === '\u{1F507}' && s.pressed === 'false' && s.stored === '0';
  await page.click('#audioToggleBtn');
  await page.waitForTimeout(50);
  const afterFirstClick = await readAudioToggle();
  check('clicking the audio toggle button flips it to a self-consistent state (icon, aria-pressed, isAudioEnabled, localStorage all agree)', isConsistentlyOn(afterFirstClick) || isConsistentlyOff(afterFirstClick), JSON.stringify(afterFirstClick));
  await page.click('#audioToggleBtn');
  await page.waitForTimeout(50);
  const afterSecondClick = await readAudioToggle();
  check('clicking it again flips back to the opposite state, still self-consistent', afterSecondClick.enabled === !afterFirstClick.enabled && (isConsistentlyOn(afterSecondClick) || isConsistentlyOff(afterSecondClick)), JSON.stringify({afterFirstClick, afterSecondClick}));
  // Cleanup, not a check — leave audio off for the rest of the suite
  // regardless of which parity the two clicks above landed on.
  await page.evaluate(() => window.__urlcadeDebug.setAudioEnabled(false));

  // 1f. Tilemap authoring — shape layers (mapShapes/blankMap, DESIGN.md
  // §74). Three layers: (a) the kernel-level compositing primitives
  // directly, (b) a full encodeCart/decodeCart round-trip through the
  // new fields, then (c) Mini Golf's own real course, end to end through
  // an actual World — the hole fixup that used to be 4 SETTILE calls in
  // on_init is now purely declarative.
  const mapShapesKernelResult = await page.evaluate(() => {
    const K2 = window.UrlcadeKernel;
    const blank = K2.buildBlankMap({width: 6, height: 4, fillTileId: 1});
    const gridBefore = blank.grid.map(r => r.join(''));
    K2.applyMapShapes(blank.grid, [
      {tileX0: 1, tileY0: 1, tileX1: 5, tileY1: 3, tileId: 2},
      {tileX0: 2, tileY0: 1, tileX1: 3, tileY1: 2, tileId: 9}, // later shape, overlaps the first — should win
    ]);
    const gridAfter = blank.grid.map(r => r.join(''));
    // Out-of-range coordinates clip to the grid instead of throwing.
    let clipThrew = false;
    try{ K2.applyMapShapes(blank.grid, [{tileX0:-5, tileY0:-5, tileX1:100, tileY1:100, tileId:3}]); }
    catch(e){ clipThrew = true; }
    return {checkpointsEmpty: blank.checkpoints.length === 0, gridBefore, gridAfter, clipThrew};
  });
  check('buildBlankMap fills a flat grid with no checkpoints of its own', mapShapesKernelResult.gridBefore.every(r => r === '111111') && mapShapesKernelResult.checkpointsEmpty, JSON.stringify(mapShapesKernelResult));
  check('applyMapShapes stamps in array order, later shapes winning on overlap', mapShapesKernelResult.gridAfter[1] === '129221' && mapShapesKernelResult.gridAfter[2] === '122221', JSON.stringify(mapShapesKernelResult));
  check('an out-of-range shape clips to the grid instead of throwing', !mapShapesKernelResult.clipThrew, JSON.stringify(mapShapesKernelResult));

  const mapShapesEncodeResult = await page.evaluate(() => {
    const K2 = window.UrlcadeKernel;
    const cart = {
      formatVersion: 5, cartType: 0, rngSeed: 1, modeFlags: 0, screenW: 64, screenH: 64,
      paletteParams: [0,0,0,0,0,0,0,0], backdropFillIndex: 0, backdropGroundHeight: 0, backdropGroundIndex: 0,
      tileSurfaceOverrides: {}, inputActiveButtons: 0, inputTouchTemplate: 0, inputButtonLabels: {}, inputWantsPointer: false,
      hudSpec: [], constants: [], entityTypes: [], sprites: [], tiles: [],
      mapGenerator: 0, camera: null, aimLine: null, hooks: {},
      blankMap: {width: 10, height: 8, fillTileId: 2},
      mapShapes: [{tileX0:1,tileY0:1,tileX1:4,tileY1:3,tileId:5}, {tileX0:2,tileY0:2,tileX1:3,tileY1:3,tileId:7}],
    };
    const bytes = K2.encodeCart(cart);
    const rt = K2.decodeCart(bytes);
    return {blankMap: rt.blankMap, mapShapes: rt.mapShapes};
  });
  check('mapShapes/blankMap round-trip through encodeCart/decodeCart unchanged', JSON.stringify(mapShapesEncodeResult.blankMap) === JSON.stringify({width:10,height:8,fillTileId:2}) && mapShapesEncodeResult.mapShapes.length === 2 && mapShapesEncodeResult.mapShapes[1].tileId === 7, JSON.stringify(mapShapesEncodeResult));

  await page.evaluate((k) => { location.hash = window.__urlcadeDebug.CARTS[k].fragment; }, 'golf');
  await page.waitForTimeout(250);
  const golfMapShapesResult = await page.evaluate(() => {
    const w = window.__urlcadeDebug.getWorld();
    const holeGX = Math.floor(w.globals[7] / 8), holeGY = Math.floor(w.globals[8] / 8); // GOLF_GLOBAL_NAMES.g_hole_x/g_hole_y
    const row = w.map.grid[holeGY].slice(holeGX - 3, holeGX + 4);
    return {mapShapesDeclared: w.cart.mapShapes.length, row, holeTile: w.map.grid[holeGY][holeGX]};
  });
  check('Mini Golf declares its hole fixup as mapShapes, not runtime SETTILE calls', golfMapShapesResult.mapShapesDeclared === 2, JSON.stringify(golfMapShapesResult));
  check('Mini Golf: the hole\'s own tile is the checkpoint graphic (id 5) at the fairway\'s centerline, flanked by fairway (id 2), edges untouched', JSON.stringify(golfMapShapesResult.row) === JSON.stringify([1,2,2,5,2,2,1]), JSON.stringify(golfMapShapesResult));

  // 2. Debug on the currently-playing game: pauses (doesn't tear down) the
  // live world, shows all 3 tabs (Assets/Logic/Source), and Source starts
  // in a known-good compiled state matching the game's own fragment.
  await page.evaluate((k) => { location.hash = window.__urlcadeDebug.CARTS[k].fragment; }, keys[0]);
  await page.waitForTimeout(250);
  const originalFragment = await page.evaluate(() => window.__urlcadeDebug.getCurrentFragment());
  await page.click('#debugBtn');
  await page.waitForTimeout(300);
  const pausedState = await page.evaluate(() => {
    const w = window.__urlcadeDebug.getWorld();
    return {worldStillAlive: !!w, gameViewActive: document.getElementById('gameWrap').classList.contains('active'),
      debugViewActive: document.getElementById('inspectWrap').classList.contains('active')};
  });
  check('Debug pauses (not tears down) the live game', pausedState.worldStillAlive && !pausedState.gameViewActive && pausedState.debugViewActive, JSON.stringify(pausedState));

  const tabLabels = await page.$$eval('.inspect-tab', els => els.map(e => e.dataset.tab));
  check('all 3 tabs present (Assets/Logic/Source)', JSON.stringify(tabLabels) === JSON.stringify(['Assets','Logic','Source']), tabLabels.join(','));

  let compileOk = await page.evaluate(() => {
    const c = window.__urlcadeDebug.getCompileState();
    return c && c.ok && c.fragment;
  });
  check('compile state starts known-good for the paused game (computed before any tab click)', !!compileOk);

  // 2b. The Assets-tab palette grid (DESIGN.md §43): every cart now
  // renders the same three labeled groups — terrain (8 swatches) plus
  // two independent entity ramps (4 swatches each) — since palette
  // generation is unconditional; there's no longer a curated-bank cart
  // that would render differently.
  await page.click('.inspect-tab[data-tab="Assets"]');
  await page.waitForTimeout(150);
  const paletteDom1 = await page.evaluate(() => ({
    swatchCount: document.querySelectorAll('.pal-group .pal-swatch').length,
    groupLabels: Array.from(document.querySelectorAll('.pal-group-label')).map(e => e.textContent),
  }));
  check('Assets tab labels the terrain/entity-A/entity-B split with 16 total swatches',
    paletteDom1.swatchCount === 16 && paletteDom1.groupLabels.length === 3 &&
    /terrain/i.test(paletteDom1.groupLabels[0]) && /entity a/i.test(paletteDom1.groupLabels[1]) && /entity b/i.test(paletteDom1.groupLabels[2]),
    JSON.stringify(paletteDom1));

  await page.evaluate(() => { location.hash = 'debug:' + window.__urlcadeDebug.CARTS.racer.fragment; });
  await page.waitForTimeout(300);
  await page.click('.inspect-tab[data-tab="Assets"]');
  await page.waitForTimeout(150);
  const paletteDom2 = await page.evaluate(() => ({
    swatchCount: document.querySelectorAll('.pal-group .pal-swatch').length,
    groupLabels: Array.from(document.querySelectorAll('.pal-group-label')).map(e => e.textContent),
  }));
  check('a second, unrelated cart\'s Assets tab renders the same three-group palette shape',
    paletteDom2.swatchCount === 16 && paletteDom2.groupLabels.length === 3, JSON.stringify(paletteDom2));

  await page.click('.inspect-tab[data-tab="Source"]');
  await page.waitForTimeout(100);
  const sourceText1 = await page.inputValue('#debugSourceInput');
  check('Source tab is pre-filled with decompiled header, hooks split out', /formatVersion/.test(sourceText1) && !/"hooks"/.test(sourceText1), sourceText1.slice(0, 60));
  const compileFieldText = await page.textContent('.inspect-body');
  check('Source tab shows compile status (fragment/size) above the textarea', /Compile status/.test(compileFieldText), compileFieldText.slice(0, 80));
  const tryBtnEnabled1 = await page.evaluate(() => !document.getElementById('inspectTryBtn').disabled);
  check('the top-right "Try" button is enabled once the cart compiles cleanly', tryBtnEnabled1);

  // 3. Hooks are edited on the Logic tab, one textarea per hook (not in
  // the Source blob) — pre-filled with the same disassembly text the old
  // read-only view used to show.
  await page.click('.inspect-tab[data-tab="Logic"]');
  await page.waitForTimeout(100);
  const hookText1 = await page.inputValue('#hookSourceInput');
  check('Logic tab\'s active hook is pre-filled with decompiled bytecode source', /\S/.test(hookText1), hookText1.slice(0, 60));

  // Editing a hook validates fast (un-debounced, that hook only) *and*
  // triggers the same debounced full-cart recompile the header always
  // has — bad opcode surfaces a specific, line-named error right under
  // the hook textarea almost immediately, and the Source tab's own badge
  // eventually goes red too (both signals present, neither breaks the
  // other).
  const brokenHook = hookText1.replace(/HALT/, 'BOGUS');
  await page.fill('#hookSourceInput', brokenHook);
  await page.waitForTimeout(80);
  const hookErrText = await page.textContent('#hookErrorSlot .compile-error');
  check('bad opcode in a hook surfaces a specific, line-named error near-instantly (well under the 400ms debounce)', /line \d+/.test(hookErrText) && /BOGUS/.test(hookErrText), hookErrText);
  const taStillFocused = await page.evaluate(() => document.activeElement && document.activeElement.id === 'hookSourceInput');
  check('editing a hook does not steal focus from its textarea', taStillFocused);
  await page.waitForTimeout(600);
  const sourceTabClass = await page.evaluate(() => document.querySelector('.inspect-tab[data-tab="Source"]').className);
  check('a broken hook also eventually marks the Source tab as errored (debounced full recompile)', /tab-err/.test(sourceTabClass), sourceTabClass);
  const tryBtnDisabled = await page.evaluate(() => document.getElementById('inspectTryBtn').disabled);
  check('the top-right "Try" button disables itself while the live edit does not compile', tryBtnDisabled);

  // Fix it back and confirm the "Try" button actually starts the cart —
  // exercises the same "any valid fragment plays directly" path a
  // completely external cart would use.
  await page.fill('#hookSourceInput', hookText1);
  await page.waitForTimeout(600);
  const tryBtnReenabled = await page.evaluate(() => !document.getElementById('inspectTryBtn').disabled);
  check('the top-right "Try" button re-enables once the hook is fixed', tryBtnReenabled);
  await page.click('#inspectTryBtn');
  await page.waitForTimeout(300);
  const replayedState = await page.evaluate(() => {
    const w = window.__urlcadeDebug.getWorld();
    return w ? {ok: true, fault: w.cartFault, gameViewActive: document.getElementById('gameWrap').classList.contains('active')} : {ok: false};
  });
  check('the "Try" button starts the recompiled cart', replayedState.ok && !replayedState.fault && replayedState.gameViewActive, JSON.stringify(replayedState));

  // 3b. Opcode palette: clicking a no-operand button inserts a bare line;
  // SPAWN opens a picker with one real sprite-thumbnail canvas per entity
  // type; TESTBIT opens the fixed 5-item bit list — all via "+ New Cart"'s
  // one-entity-type, zero-tile starter cart (also exercises the tile
  // picker's empty-list message, since that cart has no tiles).
  await page.evaluate(() => { location.hash = ''; });
  await page.waitForTimeout(200);
  await page.click('#newCartBtn');
  await page.waitForTimeout(500);
  await page.click('.inspect-tab[data-tab="Logic"]');
  await page.waitForTimeout(100);
  const hookTextBefore = await page.inputValue('#hookSourceInput');
  const haltCountBefore = (hookTextBefore.match(/^HALT$/gm) || []).length;
  const opcodeGroupOptions = await page.$$eval('.opcode-group-select option', els => els.map(e => e.value));
  check('the opcode palette is a category dropdown, not all groups stacked open', opcodeGroupOptions.length === 11 && opcodeGroupOptions.includes('Entity lifecycle') && opcodeGroupOptions.includes('Persistence') && opcodeGroupOptions.includes('Sound'), JSON.stringify(opcodeGroupOptions));
  await page.selectOption('.opcode-group-select', 'Drawing & control');
  await page.waitForTimeout(50);
  await page.click('.opcode-btn[data-mnem="HALT"]');
  await page.waitForTimeout(100);
  const hookTextAfterHalt = await page.inputValue('#hookSourceInput');
  const haltCountAfter = (hookTextAfterHalt.match(/^HALT$/gm) || []).length;
  check('clicking a no-operand opcode button inserts a bare line', haltCountAfter === haltCountBefore + 1, hookTextAfterHalt.slice(-40));
  const errAfterHalt = (await page.textContent('#hookErrorSlot')).trim();
  check('the newly inserted line still validates (no error)', errAfterHalt === '', errAfterHalt);

  await page.selectOption('.opcode-group-select', 'Entity lifecycle');
  await page.waitForTimeout(50);
  await page.click('.opcode-btn[data-mnem="SPAWN"]');
  await page.waitForTimeout(100);
  const spawnPicker = await page.evaluate(() => ({
    items: document.querySelectorAll('.operand-picker-item').length,
    canvases: document.querySelectorAll('.operand-picker-item canvas').length,
  }));
  check('SPAWN opens a picker with one item (with a real sprite canvas) per entity type', spawnPicker.items === 1 && spawnPicker.canvases === 1, JSON.stringify(spawnPicker));
  await page.click('.operand-picker-item[data-value="0"]');
  await page.waitForTimeout(100);
  const hookTextAfterSpawn = await page.inputValue('#hookSourceInput');
  check('clicking an entity-type picker item inserts SPAWN with that type\'s index', /^SPAWN 0$/m.test(hookTextAfterSpawn), hookTextAfterSpawn.slice(-40));

  await page.selectOption('.opcode-group-select', 'Input');
  await page.waitForTimeout(50);
  await page.click('.opcode-btn[data-mnem="TESTBIT"]');
  await page.waitForTimeout(100);
  const testbitRows = await page.$$eval('.operand-picker-row', els => els.map(e => e.textContent.trim()));
  check('TESTBIT opens the fixed 5-item left/right/up/down/action list', testbitRows.length === 5 && /action/.test(testbitRows[4]), JSON.stringify(testbitRows));
  await page.click('.operand-picker-row[data-value="4"]');
  await page.waitForTimeout(100);
  const hookTextAfterTestbit = await page.inputValue('#hookSourceInput');
  check('clicking "action" inserts TESTBIT 4 (bit index, not bit value)', /^TESTBIT 4$/m.test(hookTextAfterTestbit), hookTextAfterTestbit.slice(-40));

  await page.selectOption('.opcode-group-select', 'World queries');
  await page.waitForTimeout(50);
  await page.click('.opcode-btn[data-mnem="PUSHI"][data-operand-kind="tileId"]');
  await page.waitForTimeout(100);
  const tilePickerEmptyText = await page.textContent('.operand-picker');
  check('the tile-id picker shows an empty-state message on a cart with no tiles, instead of an empty grid', /No tiles/.test(tilePickerEmptyText), tilePickerEmptyText);

  // 3c. Global/constant pickers: named rows (from the header's own
  // constNames/globalNames — hand-declared here, since a decoded fragment
  // never carries them, only ever a fresh authoring source does) show the
  // name and insert it as the operand token; unnamed rows always fall
  // back to a valid bare numeric slot, which is what every decompiled
  // cart's picker looks like since it can never have name tables.
  await page.click('.inspect-tab[data-tab="Source"]');
  await page.waitForTimeout(100);
  const headerText1 = await page.inputValue('#debugSourceInput');
  const headerWithNames = headerText1.replace('{', '{\n  "globalNames": {"g_smoke_test": 5},');
  await page.fill('#debugSourceInput', headerWithNames);
  await page.waitForTimeout(600);
  await page.click('.inspect-tab[data-tab="Logic"]');
  await page.waitForTimeout(100);
  await page.selectOption('.opcode-group-select', 'Globals');
  await page.waitForTimeout(50);
  await page.click('.opcode-btn[data-mnem="STOREG"]');
  await page.waitForTimeout(100);
  const namedRows = await page.$$eval('.operand-picker-row', els => els.map(e => e.textContent.trim()));
  check('the globalSlot picker shows the header\'s declared name for its slot', namedRows.length === 24 && namedRows.some(t => /g_smoke_test/.test(t) && /slot 5/.test(t)), JSON.stringify(namedRows.slice(0,3)));
  await page.click('.operand-picker-row[data-value="g_smoke_test"]');
  await page.waitForTimeout(100);
  const hookTextNamed = await page.inputValue('#hookSourceInput');
  check('clicking a named row inserts the name as the operand token', /STOREG g_smoke_test$/m.test(hookTextNamed), hookTextNamed.slice(-40));
  const errAfterNamed = (await page.textContent('#hookErrorSlot')).trim();
  check('the name-token line resolves via assemble()\'s own symbol table and validates', errAfterNamed === '', errAfterNamed);

  await page.evaluate(() => { location.hash = 'debug:' + window.__urlcadeDebug.CARTS.breakout.fragment; });
  await page.waitForTimeout(300);
  await page.click('.inspect-tab[data-tab="Logic"]');
  await page.waitForTimeout(100);
  await page.click('.opcode-btn[data-mnem="STOREG"]');
  await page.waitForTimeout(100);
  const unnamedRows = await page.$$eval('.operand-picker-row', els => els.map(e => e.textContent.trim()));
  check('a decompiled cart (no name tables at all) shows every globalSlot row as unnamed', unnamedRows.length === 24 && unnamedRows.every(t => /unnamed/.test(t)), JSON.stringify(unnamedRows.slice(0,3)));
  await page.click('.operand-picker-row[data-value="3"]');
  await page.waitForTimeout(100);
  const hookTextNumeric = await page.inputValue('#hookSourceInput');
  check('clicking an unnamed row inserts the bare numeric slot, still a valid operand', /STOREG 3$/m.test(hookTextNumeric), hookTextNumeric.slice(-40));
  const errAfterNumeric = (await page.textContent('#hookErrorSlot')).trim();
  check('the numeric-fallback line validates too', errAfterNumeric === '', errAfterNumeric);

  // 3d. Editable header/camera/input/backdrop/palette form fields on the
  // Logic tab's Overview — bidirectionally synced with lastParsedHeader,
  // reserialized into the Source tab's JSON on every edit.
  await page.evaluate(() => { location.hash = 'debug:' + window.__urlcadeDebug.CARTS.racer.fragment; });
  await page.waitForTimeout(300);
  await page.click('.inspect-tab[data-tab="Logic"]');
  await page.waitForTimeout(150);

  // Plain field round-trip: fill cartType, wait past the debounce, confirm
  // the Source tab's JSON and the compiled cart both picked it up.
  await page.fill('#field-cartType', '77');
  await page.waitForTimeout(600);
  const cartTypeState = await page.evaluate(() => ({
    compileOk: window.__urlcadeDebug.getCompileState().ok,
    cartTypeNow: window.__urlcadeDebug.getInspectCartInfo().cart.cartType,
  }));
  check('editing a plain number field (cartType) round-trips into the compiled cart', cartTypeState.compileOk && cartTypeState.cartTypeNow === 77, JSON.stringify(cartTypeState));

  // Palette slider: instant (non-debounced) live preview, well under the
  // 400ms full-recompile debounce.
  const swatchBefore = await page.evaluate(() => document.querySelector('#paletteLivePreviewSlot .pal-swatch').style.background);
  await page.locator('#palSlider0').fill('40');
  await page.waitForTimeout(80);
  const swatchAfter = await page.evaluate(() => document.querySelector('#paletteLivePreviewSlot .pal-swatch').style.background);
  check('dragging the base-hue palette slider updates the live preview near-instantly', swatchAfter !== swatchBefore, `${swatchBefore} -> ${swatchAfter}`);

  // Backdrop color picker: collapsed to a swatch + dropper trigger, opens
  // the full palette as a popover on click instead of always showing it.
  const popoverHiddenBefore = await page.evaluate(() => document.querySelector('#backdropFillPickerSlot .color-picker-popover').hidden);
  await page.click('#backdropFillPickerSlot .color-picker-trigger');
  await page.waitForTimeout(50);
  const popoverHiddenAfter = await page.evaluate(() => document.querySelector('#backdropFillPickerSlot .color-picker-popover').hidden);
  check('clicking the color-picker trigger opens the palette popover', popoverHiddenBefore && !popoverHiddenAfter, `${popoverHiddenBefore} -> ${popoverHiddenAfter}`);
  await page.click('#backdropFillPickerSlot .pal-swatch[data-index="5"]');
  await page.waitForTimeout(100);
  const popoverClosedAfterPick = await page.evaluate(() => document.querySelector('#backdropFillPickerSlot .color-picker-popover').hidden);
  check('picking a color closes the popover again', popoverClosedAfterPick);
  await page.waitForTimeout(600);
  const backdropState = await page.evaluate(() => window.__urlcadeDebug.getInspectCartInfo().cart.backdropFillIndex);
  check('the picked backdrop swatch index reaches the recompiled cart', backdropState === 5, backdropState);

  // Clicking outside an open popover closes it too.
  await page.click('#backdropFillPickerSlot .color-picker-trigger');
  await page.waitForTimeout(50);
  await page.click('.inspect-section-title');
  await page.waitForTimeout(50);
  const popoverClosedOnOutsideClick = await page.evaluate(() => document.querySelector('#backdropFillPickerSlot .color-picker-popover').hidden);
  check('clicking outside the popover closes it', popoverClosedOnOutsideClick);

  // Input checkboxes: checking a bit reveals its label input; unchecking
  // hides it and drops the stale label key rather than leaving it behind.
  const downLabelVisibleBefore = await page.evaluate(() => document.getElementById('buttonLabelRow8').style.display !== 'none');
  await page.check('#field-btn8');
  await page.waitForTimeout(50);
  const downLabelVisibleAfter = await page.evaluate(() => document.getElementById('buttonLabelRow8').style.display !== 'none');
  check('checking an input-button box reveals its label field', !downLabelVisibleBefore && downLabelVisibleAfter, `${downLabelVisibleBefore} -> ${downLabelVisibleAfter}`);
  await page.fill('#field-btnLabel8', 'Brake');
  await page.waitForTimeout(600);
  const afterCheckState = await page.evaluate(() => ({
    activeButtons: window.__urlcadeDebug.getInspectCartInfo().cart.inputActiveButtons,
    label: window.__urlcadeDebug.getInspectCartInfo().cart.inputButtonLabels[8],
  }));
  check('the checked bit + its label reach the recompiled cart', (afterCheckState.activeButtons & 8) === 8 && afterCheckState.label === 'Brake', JSON.stringify(afterCheckState));
  await page.uncheck('#field-btn8');
  await page.waitForTimeout(50);
  const downLabelVisibleUnchecked = await page.evaluate(() => document.getElementById('buttonLabelRow8').style.display !== 'none');
  check('unchecking hides the label field again', !downLabelVisibleUnchecked, downLabelVisibleUnchecked);
  await page.waitForTimeout(600);
  const afterUncheckState = await page.evaluate(() => ({
    activeButtons: window.__urlcadeDebug.getInspectCartInfo().cart.inputActiveButtons,
    hasLabel: 8 in window.__urlcadeDebug.getInspectCartInfo().cart.inputButtonLabels,
  }));
  check('unchecking drops the bit and its label from the recompiled cart, not just hides the input', (afterUncheckState.activeButtons & 8) === 0 && !afterUncheckState.hasLabel, JSON.stringify(afterUncheckState));

  // Max players (DESIGN.md §79) — defaults to single-player, a select
  // (not a free-number input) since 2 is a hard v1 ceiling, not a
  // suggested default.
  const maxPlayersBefore = await page.inputValue('#field-maxPlayers');
  check('the max players field defaults to 1 (single-player)', maxPlayersBefore === '1', maxPlayersBefore);
  await page.selectOption('#field-maxPlayers', '2');
  await page.waitForTimeout(600);
  const maxPlayersAfter = await page.evaluate(() => window.__urlcadeDebug.getInspectCartInfo().cart.maxPlayers);
  check('picking "2 — multiplayer" reaches the recompiled cart', maxPlayersAfter === 2, maxPlayersAfter);
  await page.selectOption('#field-maxPlayers', '1'); // leave state clean for whatever loads next
  await page.waitForTimeout(600);

  // Drift-proof round trip: hand-edit a field directly in the Source
  // tab's textarea, confirm the form on Logic picks it up afterward —
  // proves the form reads from lastParsedHeader, not a stale snapshot
  // taken whenever Debug first opened.
  await page.click('.inspect-tab[data-tab="Source"]');
  await page.waitForTimeout(100);
  const headerText2 = await page.inputValue('#debugSourceInput');
  const headerHandEdited = headerText2.replace(/"cartType":\s*\d+/, '"cartType": 201');
  await page.fill('#debugSourceInput', headerHandEdited);
  await page.waitForTimeout(600);
  await page.click('.inspect-tab[data-tab="Logic"]');
  await page.waitForTimeout(150);
  const formPickedUpHandEdit = await page.inputValue('#field-cartType');
  check('a hand-edit in the Source textarea is reflected back in the form field, not stale', formPickedUpHandEdit === '201', formPickedUpHandEdit);

  // 4. Back-from-Debug resumes the *same* paused game (not a fresh decode
  // of it) instead of dropping to the shelf, when Debug was opened on the
  // game that's actually still live. Tags the live World with a marker
  // before pausing — history.replaceState (not location.hash=) is what's
  // supposed to make resuming skip startGame() entirely; a plain "is a
  // game running" check wouldn't catch a regression back to re-decoding.
  await page.evaluate((k) => { location.hash = window.__urlcadeDebug.CARTS[k].fragment; }, keys[0]);
  await page.waitForTimeout(250);
  await page.evaluate(() => { window.__urlcadeDebug.getWorld().__smokeTestMarker = 'same-instance'; });
  await page.click('#debugBtn');
  await page.waitForTimeout(200);
  await page.click('#inspectBackBtn');
  await page.waitForTimeout(200);
  const resumedState = await page.evaluate(() => ({
    gameViewActive: document.getElementById('gameWrap').classList.contains('active'),
    debugViewActive: document.getElementById('inspectWrap').classList.contains('active'),
    worldAlive: !!window.__urlcadeDebug.getWorld(),
    sameInstance: window.__urlcadeDebug.getWorld() && window.__urlcadeDebug.getWorld().__smokeTestMarker === 'same-instance',
  }));
  check('back-from-Debug resumes the paused game (not the shelf)', resumedState.gameViewActive && !resumedState.debugViewActive && resumedState.worldAlive, JSON.stringify(resumedState));
  check('...and it is the *same* World instance, not a fresh re-decode', resumedState.sameInstance, JSON.stringify(resumedState));

  // 5. "+ New Cart": opens Debug on a small starter cart, landed on Source.
  await page.evaluate(() => { location.hash = ''; });
  await page.waitForTimeout(200);
  await page.click('#newCartBtn');
  await page.waitForTimeout(500);
  const newCartState = await page.evaluate(() => ({
    debugViewActive: document.getElementById('inspectWrap').classList.contains('active'),
    activeTab: document.querySelector('.inspect-tab.active')?.dataset.tab,
  }));
  check('"+ New Cart" opens Debug landed on the Source tab', newCartState.debugViewActive && newCartState.activeTab === 'Source', JSON.stringify(newCartState));
  const starterCompileOk = await page.evaluate(() => { const c = window.__urlcadeDebug.getCompileState(); return c && c.ok; });
  check('"+ New Cart"\'s starter template compiles cleanly', !!starterCompileOk);

  // 5a. Sprite shape editor (Assets tab, kind:1 sprites) — the starter
  // template ships exactly one kind:1 sprite with one ellipse shape.
  await page.click('.inspect-tab[data-tab="Assets"]');
  await page.waitForTimeout(200);
  const spriteBefore = await page.evaluate(() => window.__urlcadeDebug.getInspectCartInfo().cart.sprites[0].shapes);
  check('starter sprite 0 starts as one ellipse', spriteBefore.length === 1 && spriteBefore[0].type === 0, JSON.stringify(spriteBefore));

  const sBox = await page.locator('#spriteEditorCanvas0').boundingBox();
  const sCx = sBox.x + sBox.width/2, sCy = sBox.y + sBox.height/2;
  await page.mouse.click(sCx, sCy);
  await page.waitForTimeout(100);
  const selectedAfterClick = await page.evaluate(() => document.querySelector('#spriteShapeListSlot0 .shape-row.selected')?.dataset.shapeIndex);
  check('clicking the shape selects its row in the layer list', selectedAfterClick === '0', selectedAfterClick);

  // A small move (well under half a sprite-pixel of screen-space fraction)
  // — big enough to prove the drag moved the shape, small enough that its
  // bounding box (cx=4,rx=3 starts at edges 1..7 of an 8px-wide sprite)
  // stays safely inside the canvas for the resize-handle test right after.
  await page.mouse.move(sCx, sCy);
  await page.mouse.down();
  await page.mouse.move(sCx + sBox.width*0.06, sCy, {steps: 5});
  await page.mouse.up();
  await page.waitForTimeout(600);
  const movedShape = await page.evaluate(() => window.__urlcadeDebug.getInspectCartInfo().cart.sprites[0].shapes[0]);
  check('dragging the shape body moves it and the recompiled cart reflects it', movedShape.cx !== spriteBefore[0].cx, JSON.stringify(movedShape));

  // Resize via the SE corner handle — computed from the shape's current
  // (post-move) box, same sprite-space-to-canvas-space math the editor
  // itself uses (spriteEditorPointerCoords, inverted).
  const seScreenX = sBox.x + (movedShape.cx+movedShape.rx)/8 * sBox.width;
  const seScreenY = sBox.y + (movedShape.cy+movedShape.ry)/8 * sBox.height;
  await page.mouse.move(seScreenX, seScreenY);
  await page.mouse.down();
  await page.mouse.move(seScreenX + sBox.width*0.1, seScreenY + sBox.height*0.1, {steps: 5});
  await page.mouse.up();
  await page.waitForTimeout(600);
  const resizedShape = await page.evaluate(() => window.__urlcadeDebug.getInspectCartInfo().cart.sprites[0].shapes[0]);
  check('dragging a corner handle resizes the shape', resizedShape.rx !== movedShape.rx || resizedShape.ry !== movedShape.ry, JSON.stringify(resizedShape));

  await page.click('#spriteAddRectBtn0');
  await page.waitForTimeout(600);
  const afterAdd = await page.evaluate(() => window.__urlcadeDebug.getInspectCartInfo().cart.sprites[0].shapes);
  check('"+ Rect" appends a rect shape to the sprite', afterAdd.length === 2 && afterAdd[1].type === 1, JSON.stringify(afterAdd));

  await page.click('#spriteShapeListSlot0 .shape-row[data-shape-index="1"] .shape-move-up');
  await page.waitForTimeout(600);
  const afterReorder = await page.evaluate(() => window.__urlcadeDebug.getInspectCartInfo().cart.sprites[0].shapes);
  check('reordering a layer flips array (z-)order', afterReorder[0].type === 1, JSON.stringify(afterReorder));

  await page.click('#spriteShapeListSlot0 .shape-row[data-shape-index="0"] .color-picker-trigger');
  await page.waitForTimeout(100);
  await page.click('#spriteShapeListSlot0 .shape-row[data-shape-index="0"] .pal-swatch[data-index="7"]');
  await page.waitForTimeout(600);
  const recolored = await page.evaluate(() => window.__urlcadeDebug.getInspectCartInfo().cart.sprites[0].shapes[0]);
  check('recoloring a shape via the popover reaches the recompiled cart', recolored.color === 7, JSON.stringify(recolored));

  await page.click('#spriteShapeListSlot0 .shape-row[data-shape-index="1"] .shape-delete');
  await page.waitForTimeout(600);
  const afterDelete = await page.evaluate(() => window.__urlcadeDebug.getInspectCartInfo().cart.sprites[0].shapes);
  check('deleting a shape removes it from the sprite', afterDelete.length === 1, JSON.stringify(afterDelete));

  // A raw-pixel sprite (no kind:1 — Corridor's sprite 0 is a plain
  // {w,h,pixels:[...]}) gets the future-phase message instead of an
  // editor it can't actually support yet. Scoped to spriteSlot0's own
  // next sibling, not just "the first .inspect-empty on the page" — a
  // cart could have other empty-state messages elsewhere in Assets.
  await page.evaluate(() => { location.hash = 'debug:' + window.__urlcadeDebug.CARTS.doom.fragment; });
  await page.waitForTimeout(300);
  await page.click('.inspect-tab[data-tab="Assets"]');
  await page.waitForTimeout(200);
  const rawPixelMsg = await page.evaluate(() => document.getElementById('spriteSlot0')?.nextElementSibling?.textContent);
  check('a raw-pixel sprite shows a future-phase message instead of a broken editor', /Raw-pixel editing is a future phase/.test(rawPixelMsg || ''), rawPixelMsg);

  // 5a2. Tile pixel editor (Assets tab, all tiles are raw pixels — no
  // shape-list option the way sprites have). Still on doom's Assets tab;
  // its tile 0 (wallPixels) is a real 8x8 tile. Pick a paint color from
  // the always-visible palette strip, then drag a stroke across the top
  // row to prove drag-to-paint (not just a single click).
  const tileBefore = await page.evaluate(() => window.__urlcadeDebug.getInspectCartInfo().cart.tiles[0].pixels.slice());
  const paintColor = tileBefore[0] === 3 ? 5 : 3; // whichever doesn't collide with the existing pixel
  // Pick the paint color *before* reading the canvas's boundingBox — a
  // page.click() auto-scrolls its target into view, and the palette strip
  // sits below the canvas in this tile's layout, so clicking it after
  // capturing tBox would silently invalidate those coordinates (the next
  // tile's canvas can scroll up to occupy the old viewport position).
  await page.click(`#tilePaletteSlot0 .pal-swatch[data-index="${paintColor}"]`);
  await page.locator('#tileEditorCanvas0').scrollIntoViewIfNeeded();
  const tBox = await page.locator('#tileEditorCanvas0').boundingBox();
  const tCellW = tBox.width / 8, tCellH = tBox.height / 8;
  await page.mouse.move(tBox.x + tCellW*0.5, tBox.y + tCellH*0.5);
  await page.mouse.down();
  await page.mouse.move(tBox.x + tCellW*1.5, tBox.y + tCellH*0.5, {steps: 3});
  await page.mouse.move(tBox.x + tCellW*2.5, tBox.y + tCellH*0.5, {steps: 3});
  await page.mouse.up();
  await page.waitForTimeout(600);
  const tileAfter = await page.evaluate(() => window.__urlcadeDebug.getInspectCartInfo().cart.tiles[0].pixels);
  check('dragging across the tile canvas paints the selected color into the recompiled cart\'s pixels',
    tileAfter[0] === paintColor && tileAfter[1] === paintColor && tileAfter[2] === paintColor,
    JSON.stringify({before: tileBefore.slice(0,3), after: tileAfter.slice(0,3), paintColor}));

  // 5a3. Entity-type editor (Logic tab) — add/remove entity types, edit
  // per-type fields, and reassign which sprite/tile a type draws as. Race
  // Car ships 3 renderKind:0 entity types and 4 kind:1 sprites (the 4th,
  // carFlashShapes, is never an entityType's own spawn-time default — it's
  // only ever reached at runtime via the player car's own assetIndex-
  // override prop during the lap-complete flash, see RACER_HOOKS_SRC.
  // on_frame — but it's still real sprite-domain data the asset picker
  // has to show), a real domain to reassign within (not just index 0 ->
  // index 0).
  await page.evaluate(() => { location.hash = 'debug:' + window.__urlcadeDebug.CARTS.racer.fragment; });
  await page.waitForTimeout(300);
  await page.click('.inspect-tab[data-tab="Logic"]');
  await page.waitForTimeout(200);
  const entityCardCount = await page.evaluate(() => document.querySelectorAll('.entity-card').length);
  check('the entity-type editor renders one card per entity type', entityCardCount === 3, entityCardCount);

  // Plain fields (collisionW, rotate) go through bindHeaderField, same as
  // every other header form control — no bespoke wiring to prove out.
  await page.fill('#entityCollW0', '20');
  await page.waitForTimeout(600);
  const collWAfter = await page.evaluate(() => window.__urlcadeDebug.getInspectCartInfo().cart.entityTypes[0].collisionW);
  check('editing an entity type\'s collisionW round-trips into the recompiled cart', collWAfter === 20, collWAfter);

  const rotateBefore = await page.evaluate(() => window.__urlcadeDebug.getInspectCartInfo().cart.entityTypes[1].rotateFlag);
  await page.click('#entityRotate1');
  await page.waitForTimeout(600);
  const rotateAfter = await page.evaluate(() => window.__urlcadeDebug.getInspectCartInfo().cart.entityTypes[1].rotateFlag);
  check('toggling an entity type\'s rotate checkbox round-trips into the recompiled cart', rotateAfter !== rotateBefore, JSON.stringify({rotateBefore, rotateAfter}));

  // Reassign entity type 0's sprite via the asset picker popover.
  await page.click('#entityAssetPicker0 .entity-asset-trigger');
  await page.waitForTimeout(100);
  const pickerItemCount = await page.evaluate(() => document.querySelectorAll('#entityAssetPopover0 .entity-asset-item').length);
  check('the asset picker popover shows one thumbnail per sprite in the sprite domain', pickerItemCount === 4, pickerItemCount);
  await page.click('#entityAssetPopover0 .entity-asset-item[data-value="1"]');
  await page.waitForTimeout(600);
  const assetIndexAfter = await page.evaluate(() => window.__urlcadeDebug.getInspectCartInfo().cart.entityTypes[0].assetIndex);
  check('picking a thumbnail in the asset picker reassigns the entity type\'s assetIndex', assetIndexAfter === 1, assetIndexAfter);

  // Changing renderKind resets assetIndex (the old index may not even
  // exist in the new domain) and re-renders the row's picker against the
  // new domain (tiles, here, since Race Car has 5).
  await page.selectOption('#entityRenderKind0', '1');
  await page.waitForTimeout(600);
  const afterKindChange = await page.evaluate(() => window.__urlcadeDebug.getInspectCartInfo().cart.entityTypes[0]);
  check('changing renderKind resets assetIndex to 0 and recompiles cleanly', afterKindChange.renderKind === 1 && afterKindChange.assetIndex === 0, JSON.stringify(afterKindChange));

  await page.click('#addEntityTypeBtn');
  await page.waitForTimeout(600);
  const entityTypesAfterAdd = await page.evaluate(() => window.__urlcadeDebug.getInspectCartInfo().cart.entityTypes);
  check('"+ Entity Type" appends a new type with sane defaults', entityTypesAfterAdd.length === 4 && entityTypesAfterAdd[3].renderKind === 0 && entityTypesAfterAdd[3].assetIndex === 0, JSON.stringify(entityTypesAfterAdd[3]));

  await page.click('.entity-delete-btn[data-entity-index="3"]');
  await page.waitForTimeout(600);
  const entityTypeCountAfterDelete = await page.evaluate(() => window.__urlcadeDebug.getInspectCartInfo().cart.entityTypes.length);
  check('deleting an entity type removes it and the recompiled cart reflects it', entityTypeCountAfterDelete === 3, entityTypeCountAfterDelete);

  // 5a4. Tilemap shape editor (Logic tab, DESIGN.md §75) — Mini Golf
  // already ships 2 real mapShapes entries (its own hole fixup, DESIGN.md
  // §74): a 5-tile-wide fairway rect (index 0) and a 1-tile hole restamp
  // (index 1). Exercises select/move/resize/reorder/recolor/add/delete
  // against real cart data, not a synthetic fixture. Shape 0, not 1, is
  // the drag target — a 1-tile shape's corner-handle hit radius (~12
  // screen px, comfortably bigger than one 8px tile) covers its entire
  // body, so clicking its center would register as a resize, not a move.
  await page.evaluate(() => { location.hash = 'debug:' + window.__urlcadeDebug.CARTS.golf.fragment; });
  await page.waitForTimeout(300);
  await page.click('.inspect-tab[data-tab="Logic"]');
  await page.waitForTimeout(200);
  const golfShapesBefore = await page.evaluate(() => window.__urlcadeDebug.getInspectCartInfo().cart.mapShapes);
  check('Mini Golf\'s Logic tab shows its 2 real mapShapes entries', golfShapesBefore.length === 2, JSON.stringify(golfShapesBefore));

  await page.locator('#mapShapeEditorCanvas').scrollIntoViewIfNeeded();
  const mapBox = await page.locator('#mapShapeEditorCanvas').boundingBox();
  const shape0 = golfShapesBefore[0];
  // Canvas is shown at native size (8px/tile), no CSS scaling — tile
  // coords convert to screen coords with a flat *8 (see index.html's own
  // comment on .map-shape-editor-canvas-wrap for why, unlike the sprite
  // editor's shrink-to-fit canvas). Tile 21 (not the box center) — shape
  // 1's own box sits centered inside shape 0's, so the true center hits
  // shape 1 first (correctly — later/topmost shape wins on click, same
  // as the stamping order itself); nothing is selected yet at this first
  // click, so corner-handle proximity doesn't matter here.
  await page.mouse.click(mapBox.x + 21*8, mapBox.y + 27.5*8);
  await page.waitForTimeout(100);
  const mapShapeSelectedAfterClick = await page.evaluate(() => document.querySelector('#mapShapeListSlot .shape-row.selected')?.dataset.shapeIndex);
  check('clicking a map shape selects its row in the layer list', mapShapeSelectedAfterClick === '0', mapShapeSelectedAfterClick);

  // Resize first, via the NW corner handle (not SE) — shape 0 sits near
  // the bottom of Mini Golf's 30-row grid (rows 27-28), so growing
  // downward/rightward from the SE corner runs straight into the grid's
  // own bottom edge (setMapShapeBox clamps tileY1 to gridH) well before
  // there's room for the move-drag right after to find a point clear of
  // every corner handle. Growing up/left from NW instead has the whole
  // rest of the grid to work with.
  const nwX = mapBox.x + shape0.tileX0*8, nwY = mapBox.y + shape0.tileY0*8;
  await page.mouse.move(nwX, nwY);
  await page.mouse.down();
  await page.mouse.move(nwX - 16, nwY - 40, {steps: 5}); // -2 tiles left, -5 tiles up
  await page.mouse.up();
  await page.waitForTimeout(600);
  const mapResizedShape = await page.evaluate(() => window.__urlcadeDebug.getInspectCartInfo().cart.mapShapes[0]);
  check('dragging a corner handle resizes a map shape', mapResizedShape.tileX0 !== shape0.tileX0 || mapResizedShape.tileY0 !== shape0.tileY0, JSON.stringify(mapResizedShape));

  // Move-drag from deep inside the now-larger shape — 3.5 tiles in from
  // its left/top edges, comfortably clear (2+ tiles) of every corner
  // handle in both directions, and well below shape 1's own single row
  // so overlap with it is a non-issue here.
  const moveFromX = mapBox.x + (mapResizedShape.tileX0+3.5)*8, moveFromY = mapBox.y + (mapResizedShape.tileY0+3.5)*8;
  await page.mouse.move(moveFromX, moveFromY);
  await page.mouse.down();
  await page.mouse.move(moveFromX + 24, moveFromY, {steps: 5}); // 3 tiles right
  await page.mouse.up();
  await page.waitForTimeout(600);
  const mapMovedShape = await page.evaluate(() => window.__urlcadeDebug.getInspectCartInfo().cart.mapShapes[0]);
  check('dragging a map shape\'s body moves it, snapped to whole tiles, and the recompiled cart reflects it', mapMovedShape.tileX0 !== mapResizedShape.tileX0 && Number.isInteger(mapMovedShape.tileX0), JSON.stringify(mapMovedShape));

  await page.click('#mapShapeAddBtn');
  await page.waitForTimeout(600);
  const afterMapAdd = await page.evaluate(() => window.__urlcadeDebug.getInspectCartInfo().cart.mapShapes);
  check('"+ Shape" appends a new mapShapes entry', afterMapAdd.length === 3, JSON.stringify(afterMapAdd[2]));

  await page.click('#mapShapeListSlot .shape-row[data-shape-index="2"] .shape-move-up');
  await page.waitForTimeout(600);
  const afterMapReorder = await page.evaluate(() => window.__urlcadeDebug.getInspectCartInfo().cart.mapShapes);
  check('reordering a map shape flips array (stamp-)order', JSON.stringify(afterMapReorder[1]) === JSON.stringify(afterMapAdd[2]), JSON.stringify(afterMapReorder));

  // The newly-added shape (now at index 1) — recolor it via the tile
  // picker, a trigger+popover distinct from both the opcode palette's
  // SPAWN picker and the entity-type asset picker (also both reachable
  // on this same tab), each guarded against class-name collision the
  // same way (DESIGN.md §65's own lesson, reused here on purpose).
  await page.click('#mapShapeListSlot .shape-row[data-shape-index="1"] .map-tile-trigger');
  await page.waitForTimeout(100);
  const golfTileCount = await page.evaluate(() => window.__urlcadeDebug.getInspectCartInfo().cart.tiles.length);
  const tilePickerItemCount = await page.evaluate(() => document.querySelectorAll('#mapShapeListSlot .shape-row[data-shape-index="1"] .map-tile-item').length);
  check('the map tile picker popover shows one thumbnail per tile in the cart', tilePickerItemCount === golfTileCount, JSON.stringify({tilePickerItemCount, golfTileCount}));
  await page.click('#mapShapeListSlot .shape-row[data-shape-index="1"] .map-tile-item[data-value="3"]');
  await page.waitForTimeout(600);
  const recoloredMapShape = await page.evaluate(() => window.__urlcadeDebug.getInspectCartInfo().cart.mapShapes[1]);
  check('picking a tile in the map tile picker sets the shape\'s tileId', recoloredMapShape.tileId === 3, JSON.stringify(recoloredMapShape));

  await page.click('#mapShapeListSlot .shape-row[data-shape-index="1"] .shape-delete');
  await page.waitForTimeout(600);
  const afterMapDelete = await page.evaluate(() => window.__urlcadeDebug.getInspectCartInfo().cart.mapShapes);
  check('deleting a map shape removes it', afterMapDelete.length === 2, JSON.stringify(afterMapDelete));

  // A cart with no map at all (Flappy: mapGenerator 0, no mapShapes)
  // still shows the plain empty-state message, not a broken/empty editor.
  await page.evaluate(() => { location.hash = 'debug:' + window.__urlcadeDebug.CARTS.flappy.fragment; });
  await page.waitForTimeout(300);
  await page.click('.inspect-tab[data-tab="Logic"]');
  await page.waitForTimeout(200);
  const noMapMsg = await page.evaluate(() => document.querySelector('.inspect-body .inspect-empty')?.textContent);
  check('a cart with no map generator shows the empty-state message, not a broken editor', /No map generator/.test(noMapMsg || ''), noMapMsg);

  // 5b. Pointer input + on_draw immediate-mode drawing (DESIGN.md §36):
  // dragging across the canvas on the "Water the Plant" cart spawns real
  // water-drop entities via LOAD_POINTER_X/DOWN in on_input, which then
  // fall and get absorbed via on_tick (no on_collide involved at all) —
  // a real behavioral check, not just "didn't throw" (that's covered by
  // the blanket page-error listener already attached to this page, which
  // would also catch a throwing on_draw on every one of the frames
  // rendered while this cart is up).
  await page.evaluate(() => { location.hash = ''; });
  await page.waitForTimeout(200);
  await page.evaluate((k) => { location.hash = window.__urlcadeDebug.CARTS[k].fragment; }, 'plant');
  await page.waitForTimeout(250);
  const screenBox = await page.locator('#screen').boundingBox();
  const dragCx = screenBox.x + screenBox.width / 2, dragCy = screenBox.y + screenBox.height / 2;
  await page.mouse.move(dragCx, dragCy);
  await page.mouse.down();
  for(let i = 0; i < 6; i++){
    await page.mouse.move(dragCx + i * 5, dragCy, {steps: 2});
    await page.waitForTimeout(80);
  }
  // Mid-drag snapshot (DESIGN.md §77) — the local player's slot 0, taken
  // while the pointer is still physically held, is the only point in this
  // test where pointerDown is actually true. Checks three things at once:
  // quantization at capture time (pointerX/Y land on whole cart pixels,
  // not the fractional CSS-scale math pointerToCartCoords would otherwise
  // produce), the new per-player pointerXs/Ys arrays staying in lockstep
  // with the old scalar pointerX/Y (LOAD_POINTER_X/Y and LOAD_POINTER_P
  // must agree), and the pointer-held bit (index 5, value 32) folded into
  // inputs[0] alongside whatever keyboard buttons are also held.
  const midDragState = await page.evaluate(() => {
    const w = window.__urlcadeDebug.getWorld();
    return {
      pointerX: w.pointerX, pointerY: w.pointerY, pointerDown: w.pointerDown,
      pointerXs0: w.pointerXs[0], pointerYs0: w.pointerYs[0],
      inputs0: w.inputs[0], inputs1: w.inputs[1],
    };
  });
  await page.mouse.up();
  await page.waitForTimeout(1500); // let at least one dropped drop fall to the soil line and get absorbed
  const plantState = await page.evaluate(() => {
    const w = window.__urlcadeDebug.getWorld();
    return w ? {ok: true, fault: w.cartFault, water: w.globals[1]} : {ok: false};
  });
  check('dragging on the plant cart grows it (pointer input reaches hooks, water > 0)',
    plantState.ok && !plantState.fault && plantState.water > 0, JSON.stringify(plantState));
  check('pointer position is quantized to whole cart pixels at capture time (rollback determinism, DESIGN.md §77)',
    Number.isInteger(midDragState.pointerX) && Number.isInteger(midDragState.pointerY), JSON.stringify(midDragState));
  check('the new per-player pointerXs[0]/pointerYs[0] stay in lockstep with the old scalar pointerX/pointerY',
    midDragState.pointerXs0 === midDragState.pointerX && midDragState.pointerYs0 === midDragState.pointerY, JSON.stringify(midDragState));
  check('pointer-held folds into inputs[0] as bit index 5 (value 32) while other player slots stay untouched',
    midDragState.pointerDown === 1 && (midDragState.inputs0 & 32) === 32 && midDragState.inputs1 === 0, JSON.stringify(midDragState));

  // 5b2. The restart button: startGame() re-decodes the fragment and
  // rebuilds the World from scratch, re-running on_init — clicking it
  // on the still-watered plant from the drag test above should drop
  // g_water back to exactly 0, and it must be a genuinely new World
  // instance, not the same one with its globals reset in place.
  const worldBeforeRestart = await page.evaluate(() => window.__urlcadeDebug.getWorld().__smokeTag = Math.random());
  await page.click('#restartBtn');
  await page.waitForTimeout(200);
  const restartState = await page.evaluate((prevTag) => {
    const w = window.__urlcadeDebug.getWorld();
    return w ? {ok: true, fault: w.cartFault, water: w.globals[1], sameInstance: w.__smokeTag === prevTag} : {ok: false};
  }, worldBeforeRestart);
  check('restart button resets the plant cart (water back to 0, fresh World instance)',
    restartState.ok && !restartState.fault && restartState.water === 0 && !restartState.sameInstance,
    JSON.stringify(restartState));

  // 5c. Mini Golf's two-press timing swing: press once to start charging,
  // again to release — a real behavioral check that the state machine
  // (aiming -> charging -> in motion) actually advances and the ball
  // actually moves, not just "the cart loads". Drives the actual
  // on-screen touch button (.touch-btn[data-bit="4"]), not the keyboard —
  // this cart shipped with its swing action checking the wrong bit
  // (TESTBIT 4 / mask 16, matching a keyboard spacebar, when
  // TOUCH_TEMPLATE_STEER_ACTION's own action button is hardcoded to send
  // mask 4) and a keyboard-only test missed it completely, since the
  // spacebar is wired to mask 16 independent of any cart's own template
  // (DESIGN.md §38). Clicking the real button a touch player taps is
  // what actually exercises the template/opcode contract.
  await page.evaluate(() => { location.hash = ''; });
  await page.waitForTimeout(200);
  await page.evaluate((k) => { location.hash = window.__urlcadeDebug.CARTS[k].fragment; }, 'golf');
  await page.waitForTimeout(250);
  const teeState = await page.evaluate(() => {
    const w = window.__urlcadeDebug.getWorld();
    const ball = w.entities.find(e => e.typeId === 0);
    return {swingState: w.globals[1], strokes: w.globals[5], ballX: ball.props[0], ballY: ball.props[1]};
  });
  // A plain .click() fires mousedown+mouseup back to back — fast enough
  // that the button can toggle on and back off before the running game
  // loop's next frame ever samples it as held. A real tap holds for some
  // real duration; press-wait-release here mirrors that instead.
  async function tapSwingButton(){
    const box = await page.locator('#touchControls .touch-btn[data-bit="4"]').boundingBox();
    const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.waitForTimeout(80);
    await page.mouse.up();
  }
  await tapSwingButton();
  await page.waitForTimeout(400); // let power oscillate for a while
  await tapSwingButton();
  await page.waitForTimeout(1500); // let the ball roll and come to rest
  const golfState = await page.evaluate(() => {
    const w = window.__urlcadeDebug.getWorld();
    const ball = w.entities.find(e => e.typeId === 0);
    return {ok: true, fault: w.cartFault, strokes: w.globals[5], ballX: ball.props[0], ballY: ball.props[1]};
  });
  const ballMoved = Math.hypot(golfState.ballX - teeState.ballX, golfState.ballY - teeState.ballY) > 5;
  check('Mini Golf\'s timing swing moves the ball and counts a stroke',
    golfState.ok && !golfState.fault && golfState.strokes > teeState.strokes && ballMoved,
    JSON.stringify({tee: teeState, after: golfState}));

  // 5c2. Corridor: the raycast FPS actually plays. Walking forward moves
  // the player entity (collision-checked via MOVE_SOLID against the
  // cave's real wall grid, not just "the input handler ran"), turning
  // changes its facing, and — the real risk this cart's whole design bet
  // on staying under — repeated on_draw calls (the ~14000-op-worst-case
  // 40-ray raycast, run once per rendered frame the whole time) never
  // trip the MAX_STEPS cartFault guard (DESIGN.md §54).
  await page.evaluate(() => { location.hash = ''; });
  await page.waitForTimeout(200);
  await page.evaluate((k) => { location.hash = window.__urlcadeDebug.CARTS[k].fragment; }, 'doom');
  await page.waitForTimeout(250);
  const doomStart = await page.evaluate(() => {
    const w = window.__urlcadeDebug.getWorld();
    const player = w.entities.find(e => e.typeId === 0);
    return {x: player.props[0], y: player.props[1], angle: player.props[6], hp: player.props[5], entityCount: w.entities.length, fault: w.cartFault};
  });
  await page.keyboard.down('ArrowUp'); // forward, DPAD_ACTION bit 4
  await page.waitForTimeout(500);
  await page.keyboard.up('ArrowUp');
  await page.keyboard.down('ArrowRight'); // turn right, bit 2
  await page.waitForTimeout(200);
  await page.keyboard.up('ArrowRight');
  await page.keyboard.down(' '); // shoot, bit 16
  await page.waitForTimeout(80);
  await page.keyboard.up(' ');
  await page.waitForTimeout(300);
  const doomAfter = await page.evaluate(() => {
    const w = window.__urlcadeDebug.getWorld();
    const player = w.entities.find(e => e.typeId === 0);
    return {x: player.props[0], y: player.props[1], angle: player.props[6], hp: player.props[5], fault: w.cartFault};
  });
  const doomMoved = Math.hypot(doomAfter.x - doomStart.x, doomAfter.y - doomStart.y) > 1;
  check('Corridor spawns player+camera+3 monsters, walking/turning/shooting all work, no cartFault from the raycast',
    doomStart.entityCount === 5 && !doomStart.fault && doomMoved && doomAfter.angle !== doomStart.angle && !doomAfter.fault,
    JSON.stringify({start: doomStart, after: doomAfter}));

  // 5d. Race Car's off-road wall: holding Gas dead straight (no steering)
  // drives the player past the track's first turn — the exact scenario
  // that used to just cost you traction (grass friction) and let you keep
  // sailing across open grid. A real behavioral check on the actual
  // physics (position/tile after real simulated time), not just "the cart
  // loads": confirms the car comes to rest still on a road/rumble tile
  // (never grass, tile id 1) with its velocity zeroed by the wall it hit,
  // instead of ending up parked in the grass (DESIGN.md §45).
  await page.evaluate(() => { location.hash = ''; });
  await page.waitForTimeout(200);
  await page.evaluate((k) => { location.hash = window.__urlcadeDebug.CARTS[k].fragment; }, 'racer');
  await page.waitForTimeout(200);
  await page.keyboard.down('ArrowUp');
  await page.waitForTimeout(4000);
  await page.keyboard.up('ArrowUp');
  await page.waitForTimeout(200);
  const racerWallState = await page.evaluate(() => {
    const w = window.__urlcadeDebug.getWorld();
    const player = w.entities.find(e => e.id === w.globals[0] && e.active);
    const tx = Math.floor(player.props[0]/8), ty = Math.floor(player.props[1]/8);
    const inBounds = ty>=0 && ty<w.map.grid.length && tx>=0 && tx<w.map.grid[0].length;
    return {fault: w.cartFault, tile: inBounds ? w.map.grid[ty][tx] : -1, vx: player.props[2], vy: player.props[3]};
  });
  check('Race Car\'s player stops at the track edge instead of driving onto grass',
    !racerWallState.fault && racerWallState.tile !== 1 && racerWallState.vx === 0,
    JSON.stringify(racerWallState));

  // 5e. Race Car's AI cars actually finish navigating both chicanes, not
  // just avoid the player's own wall. The AI's steering is a plain "turn
  // toward the current checkpoint, then accelerate" loop with no braking
  // or turn-radius awareness — a real regression here isn't a fault or a
  // dead stop, it's a car that circles its current target forever, having
  // flown past the capture radius at speed and immediately re-locked onto
  // the same (now-behind-it) point. Confirmed live: with too few waypoints
  // through the chicanes, both AI cars got permanently stuck against the
  // first one once grass became solid (§45); with too small a capture
  // radius, one of the two would loop the second chicane's tightest turn
  // forever instead of getting stuck outright (§46). Neither shows up as
  // cartFault — only a checkpoint index that stops advancing does, so
  // this reads that directly rather than trusting silence. Reloads the
  // cart fresh first — reusing the previous check's World would let 4
  // seconds of the player car parked at the wall (and possibly bumping
  // an AI car via on_collide) contaminate this run before it even starts.
  await page.evaluate(() => { location.hash = ''; });
  await page.waitForTimeout(200);
  await page.evaluate((k) => { location.hash = window.__urlcadeDebug.CARTS[k].fragment; }, 'racer');
  await page.waitForTimeout(200);
  const racerAiProgress = await page.waitForFunction(() => {
    const w = window.__urlcadeDebug.getWorld();
    const ai1 = w.entities.find(e => e.id === w.globals[1] && e.active);
    const ai2 = w.entities.find(e => e.id === w.globals[2] && e.active);
    return ai1 && ai2 && ai1.props[9] >= 8 && ai2.props[9] >= 8;
  }, {timeout: 30000}).then(() => ({reached: true, fault: false}))
    .catch(() => page.evaluate(() => {
      const w = window.__urlcadeDebug.getWorld();
      const ai1 = w.entities.find(e => e.id === w.globals[1] && e.active);
      const ai2 = w.entities.find(e => e.id === w.globals[2] && e.active);
      return {reached: false, fault: w.cartFault, cp1: ai1 && ai1.props[9], cp2: ai2 && ai2.props[9]};
    }));
  check('Race Car\'s AI cars navigate past both chicanes instead of looping a corner forever',
    racerAiProgress.reached === true, JSON.stringify(racerAiProgress));

  // 5f. Memory caps (DESIGN.md §76) — a real bug backstop independent of
  // anything network-related: spawnEntity()/setTileAt() used to grow
  // this.entities/tileDiffLog completely unbounded. Both caps are
  // exercised directly against a real World (spawnEntity/setTileAt
  // aren't reachable any other way from a hook-authoring level test —
  // hitting them via 1000+ real SPAWN/SETTILE hook calls would be both
  // slow and no more informative than calling the same runtime methods
  // the opcodes themselves route through), on carts already loaded from
  // earlier checks.
  await page.evaluate(() => { location.hash = ''; });
  await page.waitForTimeout(200);
  await page.evaluate((k) => { location.hash = window.__urlcadeDebug.CARTS[k].fragment; }, 'flappy');
  await page.waitForTimeout(200);
  const spawnCapResult = await page.evaluate(() => {
    const w = window.__urlcadeDebug.getWorld();
    const countBefore = w.entities.length;
    let cappedId = -1, spawnsUntilCapped = 0;
    // Flappy's bird type (0) has no ext fields — 9 props/entity (36
    // bytes) — well under 500 spawns to cross the 16KB ceiling.
    for(let i=0;i<600;i++){
      const e = w.spawnEntity(0);
      spawnsUntilCapped++;
      if(e.id === 0){ cappedId = e.id; break; }
    }
    const countAfterCap = w.entities.length;
    // One more call past the cap should still return the same phantom,
    // not start growing again or throw.
    const stillCapped = w.spawnEntity(0);
    return {countBefore, cappedId, spawnsUntilCapped, countAfterCap, countAfterSecondCall: w.entities.length, stillCappedId: stillCapped.id, stillCappedProps: stillCapped.props, fault: w.cartFault};
  });
  check('SPAWN becomes a graceful no-op (id 0) once the 16KB state cap would be crossed, not a crash or cartFault', spawnCapResult.cappedId === 0 && !spawnCapResult.fault, JSON.stringify(spawnCapResult));
  check('a capped SPAWN does not grow entities[], and stays capped on every subsequent call', spawnCapResult.countAfterCap === spawnCapResult.countAfterSecondCall && spawnCapResult.stillCappedId === 0 && spawnCapResult.stillCappedProps.length === 0, JSON.stringify(spawnCapResult));

  await page.evaluate(() => { location.hash = ''; });
  await page.waitForTimeout(200);
  await page.evaluate((k) => { location.hash = window.__urlcadeDebug.CARTS[k].fragment; }, 'golf');
  await page.waitForTimeout(200);
  const tileDiffCapResult = await page.evaluate(() => {
    const w = window.__urlcadeDebug.getWorld();
    const gridBefore = w.map.grid[0][0];
    for(let i=0;i<1030;i++) w.setTileAt(0, 0, (i%2)+1); // alternate two tile ids, position irrelevant to the cap itself
    const logLenAfter = w.tileDiffLog.length;
    const gridAfterCap = w.map.grid[0][0]; // last write before the cap was hit — call 1024 (index 1023) wrote (1023%2)+1 = 2
    // A further call past the cap must not grow the log or change the grid.
    w.setTileAt(0, 0, 1);
    return {logLenAfter, capIsExactly1024: logLenAfter === 1024, gridAfterCap, gridAfterOneMore: w.map.grid[0][0], logLenAfterOneMore: w.tileDiffLog.length, fault: w.cartFault};
  });
  check('SETTILE\'s tile-diff log stops growing at exactly 1024 entries', tileDiffCapResult.capIsExactly1024, JSON.stringify(tileDiffCapResult));
  check('a capped SETTILE neither grows the log nor mutates the grid any further, and never faults the cart', tileDiffCapResult.logLenAfterOneMore === 1024 && tileDiffCapResult.gridAfterOneMore === tileDiffCapResult.gridAfterCap && !tileDiffCapResult.fault, JSON.stringify(tileDiffCapResult));

  // 5g. Multi-player input model (DESIGN.md §77) — VM-level opcode
  // dispatch, checked with a mock ctx (same two-layer approach as the
  // Sound section's voice-opcode test above): LOAD_INPUT now takes a
  // player-slot operand instead of reading a single shared value, and
  // LOAD_POINTER_P is the new per-player counterpart to LOAD_POINTER_X/Y.
  // Values are routed through STOREG into globals so they can be read
  // back — these two opcodes only ever push onto the stack, with no
  // side-effecting ctx callback to spy on the way the voice opcodes have.
  const inputOpcodeDispatchResult = await page.evaluate(() => {
    const K2 = window.UrlcadeKernel;
    const ctx = {
      constants: [], globals: [0,0,0,0], self:null, a:null, b:null,
      inputs: [5, 0, 7, 0], pointerXs: [0, 11, 0, 0], pointerYs: [0, 0, 0, 13],
      world: {cartFault:false}, findEntity:()=>null, spawn:()=>({id:0,props:[]}),
      getTile:()=>0, tileSurface:()=>0, getCheckpoint:()=>({x:0,y:0}), rng:Math.random,
    };
    const bc = K2.assemble([
      'LOAD_INPUT 0', 'STOREG 0',   // slot 0 -> 5
      'LOAD_INPUT 2', 'STOREG 1',   // slot 2 -> 7
      'LOAD_POINTER_P 1 0', 'STOREG 2', // slot 1, axis x -> pointerXs[1] = 11
      'LOAD_POINTER_P 3 1', 'STOREG 3', // slot 3, axis y -> pointerYs[3] = 13
      'HALT',
    ], {constants:{},globals:{}});
    const ok = K2.runHook(bc, ctx);
    return {ok, globals: ctx.globals};
  });
  check('LOAD_INPUT slot reads the right player\'s bitmask out of ctx.inputs, not a single shared value',
    JSON.stringify(inputOpcodeDispatchResult.globals) === JSON.stringify([5,7,11,13]) && inputOpcodeDispatchResult.ok,
    JSON.stringify(inputOpcodeDispatchResult));
  const inputFallbackResult = await page.evaluate(() => {
    const K2 = window.UrlcadeKernel;
    // A minimal ctx with no inputs/pointerXs/pointerYs at all — the
    // documented "minimum ctx shape" (kernel.js's own runHook doc
    // comment) must still run every hook without throwing.
    const ctx = {
      constants: [], globals: [0,0], self:null, a:null, b:null,
      world: {cartFault:false}, findEntity:()=>null, spawn:()=>({id:0,props:[]}),
      getTile:()=>0, tileSurface:()=>0, getCheckpoint:()=>({x:0,y:0}), rng:Math.random,
    };
    const bc = K2.assemble(['LOAD_INPUT 0', 'STOREG 0', 'LOAD_POINTER_P 0 0', 'STOREG 1', 'HALT'], {constants:{},globals:{}});
    const ok = K2.runHook(bc, ctx);
    return {ok, globals: ctx.globals};
  });
  check('LOAD_INPUT and LOAD_POINTER_P both read 0 (not throw) when ctx.inputs/pointerXs/pointerYs are absent entirely',
    inputFallbackResult.ok && inputFallbackResult.globals[0] === 0 && inputFallbackResult.globals[1] === 0,
    JSON.stringify(inputFallbackResult));

  // 5h. Rollback snapshot/restore machinery (DESIGN.md §78) — real-World
  // tests against Flappy Bird's own flap mechanic (props[3] is its
  // y-velocity, set directly from FLAP_IMPULSE on a flap tick — see the
  // cart's on_input hook), driven entirely through direct w.step() calls
  // rather than real-time frames, the same "call the runtime method the
  // opcode itself routes through" approach the memory-cap tests above use.
  await page.evaluate(() => { location.hash = ''; });
  await page.waitForTimeout(200);
  await page.evaluate((k) => { location.hash = window.__urlcadeDebug.CARTS[k].fragment; }, 'flappy');
  await page.waitForTimeout(200);
  const rollbackResult = await page.evaluate(() => {
    // pauseGame() stops the real-time rAF loop from also calling
    // world.step() in the background — this test needs full control
    // over exactly how many ticks have run, which a live game loop
    // racing against this synchronous evaluate() call would otherwise
    // race against (the page had already been running for ~200ms by
    // this point, so w.tick is not 0 here — every check below is
    // relative to tickAtStart, not an assumed absolute tick number).
    window.__urlcadeDebug.pauseGame();
    const w = window.__urlcadeDebug.getWorld();
    // Warm up past ROLLBACK_WINDOW (8) ticks unconditionally, so the ring
    // is already saturated (and every earlier, ambient-loop-driven tick
    // already evicted) before the real measurement below starts —
    // decouples this test from exactly how many ticks the page's rAF
    // loop happened to run before pauseGame() took effect.
    w.inputs[0] = 0;
    for(let i=0;i<10;i++) w.step();
    const tickAtStart = w.tick;
    w.globals[1] = 0; // g_dead — clean slate
    w.inputs[0] = 0;
    for(let i=0;i<3;i++) w.step(); // 3 ticks, no flap
    const tickAfter3 = w.tick;
    const ringLenAfter3 = w.rollbackRing.length;
    const ringHasTick3 = !!w.rollbackRing.find(e => e.tick === tickAtStart + 3);

    // Snapshot/restore round-trip, including a check that the snapshot
    // itself is a deep copy — mutating live state twice in a row and
    // restoring from the *same* original snapshot both times must land
    // on the same value both times, not drift with each mutation.
    const snap = w.snapshotState();
    const bird = () => w.entities.find(e => e.typeId === 0);
    const yBefore = bird().props[1];
    const globalsBefore = w.globals.slice();
    bird().props[1] = 9999;
    w.globals[5] = 9999;
    w.restoreState(snap);
    const yAfterFirstRestore = bird().props[1];
    const globalsAfterRestore = w.globals.slice();
    bird().props[1] = -5555;
    w.restoreState(snap);
    const yAfterSecondRestore = bird().props[1];

    // Determinism: from the same restored point, run the same two-tick
    // input sequence twice (restoring between runs), and confirm the
    // resulting props/globals/rngState are byte-identical both times —
    // covers both the ordinary step() path and the restructured RNG
    // (mulberry32Next) actually resuming from the right state.
    const inputSeq = [0, 16]; // tick+1: no flap, tick+2: flap
    function runTwoTicks(){
      for(const mask of inputSeq){ w.inputs[0] = mask; w.step(); }
      const b = bird();
      return { y: b.props[1], vy: b.props[3], tick: w.tick, globals: w.globals.slice(), rngState: w.rngState };
    }
    const runA = runTwoTicks();
    w.restoreState(snap);
    const runB = runTwoTicks();

    // Resimulation actually changes the outcome: from the same restored
    // point, run the same two ticks again (so there's a "current" tick
    // to resimulate up to), then resimulateFrom() the *first* of those
    // two ticks with flap pressed instead of the no-flap it actually got.
    // Checked via the bird's *position* (props[1]), not its velocity
    // (props[3]) — a flap tick's on_input unconditionally overwrites vy
    // to FLAP_IMPULSE+GRAVITY regardless of what vy was a moment before,
    // so both scenarios end this second (still-flapping) tick with
    // identical velocity no matter what the corrected first tick did.
    // Position is the prop that actually integrates history: the first
    // tick's different vy changes how far y moved *during* that tick,
    // which the second tick's y update then carries forward — so a
    // changed first tick shows up in the final y even though the final
    // vy converges back to the same value either way.
    w.restoreState(snap);
    for(const mask of inputSeq){ w.inputs[0] = mask; w.step(); }
    const preResimTick = w.tick;
    const resimTargetTick = preResimTick - 1;
    const resimResult = w.resimulateFrom(resimTargetTick, t => t === resimTargetTick ? [16,0,0,0] : [inputSeq[1],0,0,0]);
    const tickAfterResim = w.tick;
    const afterResimY = bird().props[1];

    // Window exceeded: run well past ROLLBACK_WINDOW (8) more ticks, then
    // try to resimulate a tick long since evicted from the ring — must
    // fail cleanly (not throw, not silently do nothing) rather than
    // attempt a bogus local recovery.
    for(let i=0;i<20;i++){ w.inputs[0]=0; w.step(); }
    const exceededResult = w.resimulateFrom(tickAtStart + 1, () => [0,0,0,0]);

    return {
      tickAtStart, ticksAdvanced: tickAfter3 - tickAtStart, ringLenAfter3, ringHasTick3,
      yBefore, yAfterFirstRestore, yAfterSecondRestore,
      globalsRoundTrip: JSON.stringify(globalsBefore) === JSON.stringify(globalsAfterRestore),
      runA, runB, deterministic: JSON.stringify(runA) === JSON.stringify(runB),
      resimOk: resimResult.ok, resimTicks: resimResult.resimulatedTicks,
      tickAfterResim, tickMatchesPreResim: tickAfterResim === preResimTick,
      afterResimY,
      exceededOk: exceededResult.ok,
      fault: w.cartFault,
    };
  });
  check('the rollback ring records one entry per tick, up to the 8-tick window', rollbackResult.ticksAdvanced === 3 && rollbackResult.ringLenAfter3 === 8 && rollbackResult.ringHasTick3, JSON.stringify(rollbackResult));
  check('restoreState reverts a mutated entity prop and globals array back to the snapshot, twice in a row from the same snapshot', rollbackResult.yAfterFirstRestore === rollbackResult.yBefore && rollbackResult.yAfterSecondRestore === rollbackResult.yBefore && rollbackResult.globalsRoundTrip, JSON.stringify(rollbackResult));
  check('snapshotState is a deep copy, not a live reference — restoring twice from the same snapshot is idempotent', rollbackResult.yAfterSecondRestore === rollbackResult.yAfterFirstRestore, JSON.stringify(rollbackResult));
  check('replaying the same input sequence from the same restored state is fully deterministic (props, globals, and the restructured RNG state all match)', rollbackResult.deterministic, JSON.stringify(rollbackResult));
  check('resimulateFrom lands back on the same final tick after correcting an earlier tick\'s input', rollbackResult.resimOk && rollbackResult.tickMatchesPreResim, JSON.stringify(rollbackResult));
  check('resimulateFrom with a different input actually changes the outcome (an earlier corrected flap changes the bird\'s final position vs. the original no-flap-that-tick run)', rollbackResult.afterResimY !== rollbackResult.runA.y, JSON.stringify(rollbackResult));
  check('resimulateFrom fails cleanly ({ok:false}) once the requested tick has fallen out of the 8-tick window, instead of a bogus recovery', rollbackResult.exceededOk === false, JSON.stringify(rollbackResult));
  check('none of the rollback exercise above ever faults the cart', !rollbackResult.fault, JSON.stringify(rollbackResult));

  // RNG determinism after the mulberry32Next restructure: two fresh
  // Worlds built from the same cart (same rngSeed) must land on the
  // exact same rngState after an identical number of rng()-consuming
  // ticks — the real-World equivalent of the standalone 1000-sample,
  // 5-seed bit-for-bit check already run against mulberry32Next directly
  // outside the browser (comparing it call-for-call against the old
  // closure-based mulberry32 it replaced).
  const rngWorldResult = await page.evaluate(() => {
    const cartObj = window.__urlcadeDebug.getWorld().cart; // reuse the already-decoded flappy cart
    const w1 = new (window.__urlcadeDebug.World)(cartObj);
    const w2 = new (window.__urlcadeDebug.World)(cartObj);
    for(let i=0;i<10;i++){ w1.inputs[0] = (i % 3 === 0) ? 16 : 0; w2.inputs[0] = (i % 3 === 0) ? 16 : 0; w1.step(); w2.step(); }
    return { rngState1: w1.rngState, rngState2: w2.rngState, tick1: w1.tick, tick2: w2.tick };
  });
  check('two fresh Worlds from the same cart seed land on identical RNG state after the same tick sequence', rngWorldResult.rngState1 === rngWorldResult.rngState2 && rngWorldResult.tick1 === rngWorldResult.tick2, JSON.stringify(rngWorldResult));

  // 5i. Multiplayer signaling + lobby UI (DESIGN.md §79). Live P2P
  // connectivity cannot be tested here — the vendored Trystero (torrent
  // strategy) reaches real BitTorrent trackers over the open internet,
  // which this sandboxed environment's network policy blocks (confirmed
  // manually: real WebSocket-connection-failed errors, not a bug in the
  // wiring). Everything reachable *without* a live network is covered
  // instead: the kernel-level maxPlayers field, and the full lobby UI/
  // state machine driven through window.__urlcadeDebug's openMultiplayer
  // Lobby/hostMatch/joinMatch with a mock joinRoomFn standing in for
  // Trystero's real one — multiplayer.js's own openLobby() accepts this
  // same {joinRoomFn} override the real "Multiplayer" button's click
  // handler never supplies, specifically so this is possible.
  const maxPlayersKernelResult = await page.evaluate(() => {
    const K2 = window.UrlcadeKernel;
    const base = {
      formatVersion: 5, cartType: 0, rngSeed: 1, modeFlags: 0, screenW: 64, screenH: 64,
      paletteParams: [0,0,0,0,0,0,0,0], backdropFillIndex: 0, backdropGroundHeight: 0, backdropGroundIndex: 0,
      tileSurfaceOverrides: {}, inputActiveButtons: 0, inputTouchTemplate: 0, inputButtonLabels: {}, inputWantsPointer: false,
      hudSpec: [], constants: [], entityTypes: [], sprites: [], tiles: [], mapGenerator: 0, camera: null, aimLine: null, hooks: {},
    };
    const omittedDecoded = K2.decodeCart(K2.encodeCart(base)); // maxPlayers omitted entirely
    const explicit2Decoded = K2.decodeCart(K2.encodeCart(Object.assign({}, base, {maxPlayers: 2})));
    let threwFor0 = false, threwFor3 = false;
    try{ K2.encodeCart(Object.assign({}, base, {maxPlayers: 0})); }catch(e){ threwFor0 = true; }
    try{ K2.encodeCart(Object.assign({}, base, {maxPlayers: 3})); }catch(e){ threwFor3 = true; }
    return { omittedMaxPlayers: omittedDecoded.maxPlayers, explicit2MaxPlayers: explicit2Decoded.maxPlayers, threwFor0, threwFor3 };
  });
  check('maxPlayers defaults to 1 (single-player) when omitted, round-tripping through encode/decode', maxPlayersKernelResult.omittedMaxPlayers === 1, JSON.stringify(maxPlayersKernelResult));
  check('an explicit maxPlayers:2 round-trips through encode/decode unchanged', maxPlayersKernelResult.explicit2MaxPlayers === 2, JSON.stringify(maxPlayersKernelResult));
  check('encodeCart throws for maxPlayers outside 1-2 (a hard v1 cap, not a soft default)', maxPlayersKernelResult.threwFor0 && maxPlayersKernelResult.threwFor3, JSON.stringify(maxPlayersKernelResult));

  // Button visibility: shown only for a cart that opted in.
  await page.evaluate(() => { location.hash = ''; });
  await page.waitForTimeout(200);
  await page.evaluate((k) => { location.hash = window.__urlcadeDebug.CARTS[k].fragment; }, 'flappy');
  await page.waitForTimeout(300);
  const btnHiddenForSingplePlayer = await page.evaluate(() => getComputedStyle(document.getElementById('multiplayerBtn')).display === 'none');
  check('the Multiplayer button stays hidden for a single-player cart (maxPlayers:1)', btnHiddenForSingplePlayer);

  const mpFragment = await page.evaluate(async () => {
    const K2 = window.__urlcadeDebug;
    const { payload } = K2.decodeCartUrl(K2.CARTS['flappy'].fragment);
    const decoded = K2.decodeCart(await K2.decodePayloadToBytes(payload));
    decoded.maxPlayers = 2;
    return await K2.encodePayload(K2.encodeCart(decoded));
  });
  await page.evaluate(() => { location.hash = ''; });
  await page.waitForTimeout(200);
  await page.evaluate((f) => { location.hash = f; }, mpFragment);
  await page.waitForTimeout(300);
  const btnVisibleForMultiplayer = await page.evaluate(() => getComputedStyle(document.getElementById('multiplayerBtn')).display !== 'none');
  check('the Multiplayer button appears for a maxPlayers:2 cart', btnVisibleForMultiplayer);

  // Full lobby state machine, driven with a mock joinRoomFn (no real
  // network): host -> a peer joins -> connected, shows the right player
  // number -> that peer leaves -> peer-left -> close leaves the room.
  const lobbyResult = await page.evaluate(() => {
    const D = window.__urlcadeDebug;
    const cart = D.getWorld().cart;
    function makeMockRoom(){
      const room = {onPeerJoin:null, onPeerLeave:null, leaveCalled:false};
      room.leave = () => { room.leaveCalled = true; };
      return room;
    }
    const rooms = [];
    const mockJoinRoomFn = (config, roomId) => { const room = makeMockRoom(); rooms.push({config, roomId, room}); return room; };

    D.openMultiplayerLobby(cart, {joinRoomFn: mockJoinRoomFn});
    const choiceHtml = document.getElementById('mpBody').innerHTML;
    document.getElementById('mpHostBtn').click();
    const roomCodeShown = document.querySelector('.mp-room-code')?.textContent;
    const roomIdMatches = rooms[0] && rooms[0].roomId === roomCodeShown;

    rooms[0].room.onPeerJoin('mockPeerId');
    const connectedHtml = document.getElementById('mpBody').innerHTML;

    rooms[0].room.onPeerLeave('mockPeerId');
    const peerLeftHtml = document.getElementById('mpBody').innerHTML;

    document.getElementById('mpCancelBtn').click();
    const overlayActiveAfterClose = document.getElementById('mpOverlay').classList.contains('active');

    return {
      hadHostJoinButtons: choiceHtml.includes('mpHostBtn') && choiceHtml.includes('mpJoinBtn'),
      roomCodeLen: (roomCodeShown || '').length,
      roomIdMatches,
      connectedShowsPlayerNumber: /Player 1 of 2/.test(connectedHtml),
      peerLeftShowsDisconnect: /disconnected/i.test(peerLeftHtml),
      roomLeaveWasCalled: rooms[0].room.leaveCalled,
      overlayActiveAfterClose,
    };
  });
  check('the lobby opens on a Host/Join choice screen', lobbyResult.hadHostJoinButtons, JSON.stringify(lobbyResult));
  check('hosting shows a room code that matches what was passed to joinRoomFn', lobbyResult.roomCodeLen > 0 && lobbyResult.roomIdMatches, JSON.stringify(lobbyResult));
  check('a mock peer joining shows the connected state with the assigned player number', lobbyResult.connectedShowsPlayerNumber, JSON.stringify(lobbyResult));
  check('that peer leaving shows the disconnected state (room stays open, not silently frozen)', lobbyResult.peerLeftShowsDisconnect, JSON.stringify(lobbyResult));
  check('closing the lobby actually leaves the underlying room, not just hides the modal', lobbyResult.roomLeaveWasCalled && !lobbyResult.overlayActiveAfterClose, JSON.stringify(lobbyResult));

  // Join flow: room code input is normalized (trimmed, uppercased)
  // before being handed to joinRoomFn.
  const joinResult = await page.evaluate(() => {
    const D = window.__urlcadeDebug;
    const cart = D.getWorld().cart;
    const rooms = [];
    const mockJoinRoomFn = (config, roomId) => { rooms.push(roomId); return {onPeerJoin:null, onPeerLeave:null, leave(){}}; };
    D.openMultiplayerLobby(cart, {joinRoomFn: mockJoinRoomFn});
    document.getElementById('mpJoinBtn').click();
    const joinFormShown = !!document.getElementById('mpJoinCode');
    document.getElementById('mpJoinCode').value = '  abcde  ';
    document.getElementById('mpJoinConnectBtn').click();
    const normalizedCode = rooms[0];
    D.closeMultiplayerLobby();
    return { joinFormShown, normalizedCode };
  });
  check('the join form is reachable from the choice screen', joinResult.joinFormShown, JSON.stringify(joinResult));
  check('a typed room code is trimmed and uppercased before joining', joinResult.normalizedCode === 'ABCDE', JSON.stringify(joinResult));

  // A synchronously-throwing joinRoomFn (a config bug, not a live network
  // failure — see multiplayer.js's own note) surfaces as a visible error
  // state, not a silent no-op.
  const mpErrorResult = await page.evaluate(() => {
    const D = window.__urlcadeDebug;
    const cart = D.getWorld().cart;
    const throwingJoinRoomFn = () => { throw new Error('mock signaling failure'); };
    D.openMultiplayerLobby(cart, {joinRoomFn: throwingJoinRoomFn});
    document.getElementById('mpHostBtn').click();
    const errorHtml = document.getElementById('mpBody').innerHTML;
    D.closeMultiplayerLobby();
    return { showsError: errorHtml.includes('mock signaling failure') };
  });
  check('a joinRoomFn that throws surfaces a visible error state instead of a silent no-op', mpErrorResult.showsError, JSON.stringify(mpErrorResult));

  // 6. Pasting a malformed fragment into the shelf's box falls back to
  // Debug's decode-error UI (surfaced back on the shelf) instead of
  // silently doing nothing.
  await page.click('#inspectBackBtn').catch(() => {});
  await page.evaluate(() => { location.hash = ''; });
  await page.waitForTimeout(200);
  await page.fill('#inspectInput', 'z.not-a-real-fragment!!!');
  await page.click('#inspectForm button[type="submit"]');
  await page.waitForTimeout(300);
  const errShown = await page.textContent('#inspectError');
  check('a malformed pasted fragment surfaces a specific decode error', errShown.length > 0, errShown);

  check('no console/page errors across the whole run', errors.length === 0, JSON.stringify(errors));
  await page.close();
  await browser.close();
  server.close();

  // 7. A real-world failure mode found live: some mobile browsers report
  // CompressionStream as present (HAS_COMPRESSION true) but throw when the
  // 'deflate-raw' format specifically is actually used — which used to
  // reject encodePayload() with nothing catching it, silently no-oping
  // "Debug"/"+ New Cart" on affected devices. Simulates exactly that by
  // making 'deflate-raw' throw while leaving CompressionStream itself
  // defined, and checks the whole flow still works (falls back to the
  // raw, uncompressed fragment form) instead of silently doing nothing.
  {
    const server2 = await serve(siteDir);
    const port2 = server2.address().port;
    const browser2 = await chromium.launch();
    const page2 = await browser2.newPage();
    const errors2 = [];
    page2.on('pageerror', e => errors2.push(e.message));
    await page2.addInitScript(() => {
      const OrigCS = window.CompressionStream;
      window.CompressionStream = function(format){
        if(format === 'deflate-raw') throw new TypeError('Unsupported format: deflate-raw (simulated)');
        return new OrigCS(format);
      };
    });
    await page2.goto(`http://localhost:${port2}/index.html`);
    await page2.waitForFunction(() => window.__urlcadeDebug && Object.keys(window.__urlcadeDebug.CARTS).length === 9, {timeout: 10000});
    check('carts still register when deflate-raw compression is unsupported', true);

    await page2.click('#newCartBtn');
    await page2.waitForTimeout(600);
    const degradedState = await page2.evaluate(() => ({
      debugActive: document.getElementById('inspectWrap').classList.contains('active'),
      activeTab: document.querySelector('.inspect-tab.active')?.dataset.tab,
      compileOk: (() => { const c = window.__urlcadeDebug.getCompileState(); return c && c.ok; })(),
      fragmentIsRaw: (() => { const c = window.__urlcadeDebug.getCompileState(); return c && c.fragment && c.fragment.startsWith('r.'); })(),
    }));
    check('"+ New Cart" still works with deflate-raw unsupported (falls back to raw)', degradedState.debugActive && degradedState.activeTab === 'Source' && degradedState.compileOk && degradedState.fragmentIsRaw, JSON.stringify(degradedState));
    check('no errors with deflate-raw unsupported', errors2.length === 0, JSON.stringify(errors2));

    await browser2.close();
    server2.close();
  }

  // 8. Same site, mounted under a URL subpath instead of the domain root
  // (a real, current deployment target — not hypothetical; see DESIGN.md
  // §29's postscript for the bug this class of check caught once already).
  {
    const subBrowser = await chromium.launch();
    const prefix = '/games';
    const subServer = await serve(siteDir, prefix);
    const subPort = subServer.address().port;
    const subBase = `http://localhost:${subPort}${prefix}`;

    const subPage = await subBrowser.newPage();
    const subErrors = [];
    subPage.on('pageerror', e => subErrors.push(e.message));
    await subPage.goto(`${subBase}/index.html`);
    await subPage.waitForFunction(() => window.__urlcadeDebug && Object.keys(window.__urlcadeDebug.CARTS).length === 9, {timeout: 8000});
    check('root runtime loads under a subpath deployment', true);

    await subPage.evaluate((k) => { location.hash = window.__urlcadeDebug.CARTS[k].fragment; }, keys[0]);
    await subPage.waitForTimeout(250);
    await subPage.click('#debugBtn');
    await subPage.waitForTimeout(300);
    await subPage.click('.inspect-tab[data-tab="Source"]');
    await subPage.waitForTimeout(100);
    const subCompileOk = await subPage.evaluate(() => { const c = window.__urlcadeDebug.getCompileState(); return c && c.ok; });
    check('Debug (Source tab, with compile status, included) works under a subpath deployment', !!subCompileOk);
    check('no errors under the subpath scenario', subErrors.length === 0, JSON.stringify(subErrors));

    await subBrowser.close();
    subServer.close();
  }

  // 9. The learn site (spec/learn/index.html) — loads clean under the
  // real built-site relative paths, and its live demos (each calling the
  // real kernel.js, not a re-implementation — see CLAUDE.md) actually
  // produce output, not just "the page rendered."
  {
    const learnBrowser = await chromium.launch();
    const learnServer = await serve(siteDir);
    const learnPort = learnServer.address().port;
    const learnPage = await learnBrowser.newPage();
    const learnErrors = [];
    learnPage.on('pageerror', e => learnErrors.push(e.message));
    learnPage.on('console', m => { if(m.type() === 'error') learnErrors.push(m.text()); });
    await learnPage.goto(`http://localhost:${learnPort}/spec/learn/index.html`);
    await learnPage.waitForFunction(() => !!window.UrlcadeKernel, {timeout: 8000});

    const paletteState = await learnPage.evaluate(() => {
      const swatches = Array.from(document.querySelectorAll('#pal-swatches .sw'));
      return {count: swatches.length, colored: swatches.every(s => !!s.style.background)};
    });
    check('learn site: palette demo renders 16 live swatches', paletteState.count === 16 && paletteState.colored, JSON.stringify(paletteState));

    await learnPage.click('#vm-run');
    const vmResult = await learnPage.evaluate(() => document.getElementById('vm-result').textContent);
    check('learn site: VM demo runs the default bytecode and shows 5+3=8 in globals', /globals\[0\.\.7\] = \[5, 3, 8/.test(vmResult), vmResult);

    await learnPage.click('#gen-track');
    const trackResult = await learnPage.evaluate(() => document.getElementById('map-result').textContent);
    check('learn site: track generator demo produces output', /track/.test(trackResult) && /checkpoints/.test(trackResult), trackResult);

    await learnPage.click('#gen-platform');
    const platResult = await learnPage.evaluate(() => document.getElementById('map-result').textContent);
    check('learn site: platform generator demo produces output', /platform/.test(platResult), platResult);

    await learnPage.click('#share-run');
    await learnPage.waitForTimeout(150);
    const shareResult = await learnPage.evaluate(() => document.getElementById('share-result').textContent);
    check('learn site: sharing demo encodes and reports byte/char counts', /bytes/.test(shareResult) && /chars/.test(shareResult), shareResult);

    check('learn site: no console/page errors', learnErrors.length === 0, JSON.stringify(learnErrors));

    await learnBrowser.close();
    learnServer.close();
  }

  fs.rmSync(siteDir, {recursive: true, force: true});

  console.log(failures === 0
    ? '\nAll checks passed.'
    : `\n${failures} check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
}
main().catch(e => { console.error('FATAL', e); process.exit(1); });
