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

const MIME = { '.html':'text/html', '.js':'text/javascript', '.md':'text/markdown', '.json':'application/json' };

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

  // 1. The shelf: all eight carts register and play, no console/page
  // errors — the five original examples, Breakout (vendored from a
  // decompiled externally-authored fragment, DESIGN.md §35), Water the
  // Plant (pointer input + on_draw immediate-mode drawing, DESIGN.md
  // §36), and Mini Golf (a tile-map course from the track generator,
  // reused for a fairway instead of a road — no new kernel features).
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if(m.type() === 'error') errors.push(m.text()); });

  await page.goto(`${base}/index.html`);
  await page.waitForFunction(() => window.__urlcadeDebug && Object.keys(window.__urlcadeDebug.CARTS).length === 8, {timeout: 10000});
  check('all 8 shelf carts registered', true);

  // 1b. Palette contrast (DESIGN.md §41/§43): every shelf cart's two
  // generated entity ramps (8-11, 12-15 — the ramps entity sprites draw
  // from, see AUTHORING.md's Palette section) must land far enough in
  // hue from the terrain ramp (0-7) *and* from each other, and saturated/
  // lit enough to read as foreground, regardless of how muted a cart
  // author chose the terrain ramp to be. A real behavioral check on
  // generatePalette()'s own output, not just "the cart loads" — this is
  // exactly the class of bug (blue car, ~15% saturated, on a ~15%
  // saturated green road) that loaded fine and looked broken. There's no
  // paletteMode branch to check anymore — every cart is procedural now.
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
      const minEntitySat = Math.min(...entityA.map(c=>c[1]), ...entityB.map(c=>c[1]));
      // Lightness, not just hue/saturation, is its own check: a prior
      // version of this fix computed the entity ramps' lightness floor
      // with Math.min(cartLightMin, FLOOR) instead of Math.max, which
      // silently *undid* the floor for any cart with a dark terrain
      // lightMin — hue/saturation alone passed even with that bug live,
      // so this specifically re-checks that entities land lighter than
      // the terrain at the same ramp position (t), not just differently
      // hued from it.
      const [, , baseLightMid] = base[4];
      const [, , entityALightMid] = entityA[2];
      const ok = minBaseEntitySep >= 90 && minEntityEntitySep >= 80 && minEntitySat >= 50 && entityALightMid > baseLightMid + 10;
      if(!ok){ allOk = false; detail += `${key}: baseEntitySep=${minBaseEntitySep.toFixed(0)} entityEntitySep=${minEntityEntitySep.toFixed(0)} minSat=${minEntitySat}%; `; }
    }
    check('every cart\'s two entity ramps are hue-separated from terrain and each other, saturated, and lighter than terrain',
      allOk, detail || Object.keys(paletteChecks).join(','));
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
  check('all 8 shelf cards rendered a thumbnail canvas + name + author',
    shelfCards.length === 8 && shelfCards.every(c => c.hasThumb && c.title && /^by /.test(c.author)),
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
    swatchCount: document.querySelectorAll('.pal-swatch').length,
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
    swatchCount: document.querySelectorAll('.pal-swatch').length,
    groupLabels: Array.from(document.querySelectorAll('.pal-group-label')).map(e => e.textContent),
  }));
  check('a second, unrelated cart\'s Assets tab renders the same three-group palette shape',
    paletteDom2.swatchCount === 16 && paletteDom2.groupLabels.length === 3, JSON.stringify(paletteDom2));

  await page.click('.inspect-tab[data-tab="Source"]');
  await page.waitForTimeout(100);
  const sourceText1 = await page.inputValue('#debugSourceInput');
  check('Source tab is pre-filled with decompiled source', /formatVersion/.test(sourceText1) && /hooks/.test(sourceText1), sourceText1.slice(0, 60));
  const compileFieldText = await page.textContent('.inspect-body');
  check('Source tab shows compile status (fragment/size) above the textarea', /Compile status/.test(compileFieldText) && /Play this version/.test(compileFieldText), compileFieldText.slice(0, 80));

  // 3. Editing Source recompiles automatically (debounced) and updates the
  // Source tab's own compile-status block — bad opcode surfaces a
  // specific, hook+line-named error without navigating anywhere.
  const broken = sourceText1.replace(/HALT/, 'BOGUS');
  await page.fill('#debugSourceInput', broken);
  await page.waitForTimeout(600);
  const sourceTabClass = await page.evaluate(() => document.querySelector('.inspect-tab[data-tab="Source"]').className);
  check('bad opcode marks the Source tab as errored', /tab-err/.test(sourceTabClass), sourceTabClass);
  const errText = await page.textContent('.compile-error');
  check('bad opcode surfaces a specific, hook+line-named error, still on Source (no extra click)', /line \d+/.test(errText) && /hook/.test(errText), errText);
  const taStillFocused = await page.evaluate(() => document.activeElement && document.activeElement.id === 'debugSourceInput');
  check('recompiling on edit does not steal focus from the textarea', taStillFocused);

  // Fix it back and confirm Play-this-version actually starts the (now
  // slightly different, still valid) cart — exercises the same "any valid
  // fragment plays directly" path a completely external cart would use.
  await page.fill('#debugSourceInput', sourceText1);
  await page.waitForTimeout(600);
  await page.click('#playCompiledBtn');
  await page.waitForTimeout(300);
  const replayedState = await page.evaluate(() => {
    const w = window.__urlcadeDebug.getWorld();
    return w ? {ok: true, fault: w.cartFault, gameViewActive: document.getElementById('gameWrap').classList.contains('active')} : {ok: false};
  });
  check('"Play this version" starts the recompiled cart', replayedState.ok && !replayedState.fault && replayedState.gameViewActive, JSON.stringify(replayedState));

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
  await page.mouse.up();
  await page.waitForTimeout(1500); // let at least one dropped drop fall to the soil line and get absorbed
  const plantState = await page.evaluate(() => {
    const w = window.__urlcadeDebug.getWorld();
    return w ? {ok: true, fault: w.cartFault, water: w.globals[1]} : {ok: false};
  });
  check('dragging on the plant cart grows it (pointer input reaches hooks, water > 0)',
    plantState.ok && !plantState.fault && plantState.water > 0, JSON.stringify(plantState));

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
    await page2.waitForFunction(() => window.__urlcadeDebug && Object.keys(window.__urlcadeDebug.CARTS).length === 8, {timeout: 10000});
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
    await subPage.waitForFunction(() => window.__urlcadeDebug && Object.keys(window.__urlcadeDebug.CARTS).length === 8, {timeout: 8000});
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

  fs.rmSync(siteDir, {recursive: true, force: true});

  console.log(failures === 0
    ? '\nAll checks passed.'
    : `\n${failures} check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
}
main().catch(e => { console.error('FATAL', e); process.exit(1); });
