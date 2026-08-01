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

  // 1. The shelf: all five carts register and play, no console/page errors.
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if(m.type() === 'error') errors.push(m.text()); });

  await page.goto(`${base}/index.html`);
  await page.waitForFunction(() => window.__urlcadeDebug && Object.keys(window.__urlcadeDebug.CARTS).length === 5, {timeout: 10000});
  check('all 5 example carts registered', true);

  const keys = await page.evaluate(() => Object.keys(window.__urlcadeDebug.CARTS));
  await page.evaluate((k) => { location.hash = window.__urlcadeDebug.CARTS[k].payload; }, keys[0]);
  await page.waitForTimeout(250);
  let state = await page.evaluate(() => {
    const w = window.__urlcadeDebug.getWorld();
    return w ? {ok: true, fault: w.cartFault, entities: w.entities.length} : {ok: false};
  });
  check(`cart "${keys[0]}" plays (world exists, no cart fault)`, state.ok && !state.fault, JSON.stringify(state));
  for(const key of keys.slice(1)){
    await page.evaluate((k) => { location.hash = window.__urlcadeDebug.CARTS[k].payload; }, key);
    await page.waitForTimeout(200);
    const st = await page.evaluate(() => {
      const w = window.__urlcadeDebug.getWorld();
      return w ? {ok: true, fault: w.cartFault} : {ok: false};
    });
    check(`cart "${key}" plays (world exists, no cart fault)`, st.ok && !st.fault, JSON.stringify(st));
  }

  // 2. Debug on the currently-playing game: pauses (doesn't tear down) the
  // live world, shows all 9 tabs including Source/Compile, and the Compile
  // tab starts in a known-good state matching the game's own fragment.
  await page.evaluate((k) => { location.hash = window.__urlcadeDebug.CARTS[k].payload; }, keys[0]);
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
  check('all 9 tabs present including Source/Compile', JSON.stringify(tabLabels) === JSON.stringify(['Overview','Palette','Sprites','Tiles','Map','Entities','Hooks','Source','Compile']), tabLabels.join(','));

  await page.click('.inspect-tab[data-tab="Compile"]');
  await page.waitForTimeout(100);
  let compileOk = await page.evaluate(() => {
    const c = window.__urlcadeDebug.getCompileState();
    return c && c.ok && c.fragment;
  });
  check('Compile tab starts in a known-good state for the paused game', !!compileOk);

  await page.click('.inspect-tab[data-tab="Source"]');
  await page.waitForTimeout(100);
  const sourceText1 = await page.inputValue('#debugSourceInput');
  check('Source tab is pre-filled with decompiled source', /formatVersion/.test(sourceText1) && /hooks/.test(sourceText1), sourceText1.slice(0, 60));

  // 3. Editing Source recompiles automatically (debounced) and updates the
  // Compile tab's status — bad opcode surfaces a specific, hook+line-named
  // error without navigating anywhere.
  const broken = sourceText1.replace(/HALT/, 'BOGUS');
  await page.fill('#debugSourceInput', broken);
  await page.waitForTimeout(600);
  const compileTabClass = await page.evaluate(() => document.querySelector('.inspect-tab[data-tab="Compile"]').className);
  check('bad opcode marks the Compile tab as errored', /tab-err/.test(compileTabClass), compileTabClass);
  await page.click('.inspect-tab[data-tab="Compile"]');
  await page.waitForTimeout(100);
  const errText = await page.textContent('.compile-error');
  check('bad opcode surfaces a specific, hook+line-named error', /line \d+/.test(errText) && /hook/.test(errText), errText);

  // Fix it back and confirm Play-this-version actually starts the (now
  // slightly different, still valid) cart — exercises the same "any valid
  // fragment plays directly" path a completely external cart would use.
  await page.click('.inspect-tab[data-tab="Source"]');
  await page.waitForTimeout(100);
  await page.fill('#debugSourceInput', sourceText1);
  await page.waitForTimeout(600);
  await page.click('.inspect-tab[data-tab="Compile"]');
  await page.waitForTimeout(100);
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
  await page.evaluate((k) => { location.hash = window.__urlcadeDebug.CARTS[k].payload; }, keys[0]);
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

  // 7. Same site, mounted under a URL subpath instead of the domain root
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
    await subPage.waitForFunction(() => window.__urlcadeDebug && Object.keys(window.__urlcadeDebug.CARTS).length === 5, {timeout: 8000});
    check('root runtime loads under a subpath deployment', true);

    await subPage.evaluate((k) => { location.hash = window.__urlcadeDebug.CARTS[k].payload; }, keys[0]);
    await subPage.waitForTimeout(250);
    await subPage.click('#debugBtn');
    await subPage.waitForTimeout(300);
    await subPage.click('.inspect-tab[data-tab="Compile"]');
    await subPage.waitForTimeout(100);
    const subCompileOk = await subPage.evaluate(() => { const c = window.__urlcadeDebug.getCompileState(); return c && c.ok; });
    check('Debug (Source/Compile included) works under a subpath deployment', !!subCompileOk);
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
