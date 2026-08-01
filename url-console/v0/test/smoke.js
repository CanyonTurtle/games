// Regression test for the module split (DESIGN.md §29): assembles the
// real deployed site layout (via ../build-site.sh — the same script
// .github/workflows/pages.yml uses, so this tests exactly what ships,
// not an approximation of it), serves it locally, and drives it with a
// real browser. Replaces test/check-kernel-sync.js, which checked that
// kernel.js hadn't drifted from a second copy inside urlcade.html — now
// that the runtime imports kernel.js directly instead of duplicating
// it, there's nothing left to drift, so there's nothing left to check.
// What's actually risky about a refactor this size is behavior quietly
// changing while code moves between files; this test is aimed at that.
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

function serve(root){
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let p = decodeURIComponent(req.url.split('?')[0]);
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

  // 1. Root runtime: all five carts register, byte-encode, and run
  // without a cart fault or any console/page error.
  {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    page.on('console', m => { if(m.type() === 'error') errors.push(m.text()); });

    await page.goto(`${base}/index.html`);
    await page.waitForFunction(() => window.__urlcadeDebug && Object.keys(window.__urlcadeDebug.CARTS).length === 5, {timeout: 10000});
    check('all 5 example carts registered', true);

    const keys = await page.evaluate(() => Object.keys(window.__urlcadeDebug.CARTS));
    for(const key of keys){
      await page.evaluate((k) => { location.hash = window.__urlcadeDebug.CARTS[k].payload; }, key);
      await page.waitForTimeout(250);
      const state = await page.evaluate(() => {
        const w = window.__urlcadeDebug.getWorld();
        return w ? {ok: true, fault: w.cartFault, entities: w.entities.length} : {ok: false};
      });
      check(`cart "${key}" plays (world exists, no cart fault)`, state.ok && !state.fault, JSON.stringify(state));
    }

    // Inspector, via a pasted fragment.
    await page.evaluate((k) => { location.hash = 'inspect:' + window.__urlcadeDebug.CARTS[k].payload; }, keys[0]);
    await page.waitForTimeout(250);
    const info = await page.evaluate(() => window.__urlcadeDebug.getInspectCartInfo());
    check('Inspector decodes a pasted fragment', !!info, JSON.stringify(info && {byteLen: info.byteLen}));

    // Back to the shelf leaves a clean menu state (regression check for
    // the stopGame()/closeInspector() split, DESIGN.md §29).
    await page.click('#inspectBackBtn');
    await page.waitForTimeout(100);
    const menuActive = await page.evaluate(() => document.getElementById('menu').classList.contains('active'));
    check('back-to-shelf leaves the menu active', menuActive);

    check('no console/page errors on the root runtime', errors.length === 0, JSON.stringify(errors));
    await page.close();
  }

  // 2. /compile: starter template compiles, decompile/recompile
  // round-trips byte-for-byte, errors are specific (name a hook + line,
  // or a decode reason), and the resulting fragment is directly
  // playable by the root runtime — not just carts already in CARTS.
  {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));

    await page.goto(`${base}/compile/index.html`);
    await page.waitForTimeout(500);
    const fragment1 = await page.inputValue('#fragmentInput');
    check('starter template compiles on load', /^[rz]\./.test(fragment1), fragment1.slice(0, 20));

    await page.fill('#fragmentInput', fragment1);
    await page.waitForTimeout(600);
    const source = await page.inputValue('#sourceInput');
    await page.fill('#sourceInput', source);
    await page.waitForTimeout(600);
    const fragment2 = await page.inputValue('#fragmentInput');
    check('decompile -> recompile round-trips byte-for-byte', fragment2 === fragment1, `${fragment1.length} vs ${fragment2.length} chars`);

    // Captured while the tool is in a known-good compiled state — the
    // error-injection checks below deliberately leave it in an error
    // state (clearInfo() removes the Play link's href entirely), so
    // this has to happen before those, not after.
    const playHref = await page.getAttribute('#playLink', 'href');

    const broken = source.replace(/HALT/, 'BOGUS');
    await page.fill('#sourceInput', broken);
    await page.waitForTimeout(600);
    const err1 = await page.evaluate(() => ({text: document.getElementById('status').textContent, cls: document.getElementById('status').className}));
    check('bad opcode surfaces a specific, hook+line-named error', err1.cls === 'err' && /line \d+/.test(err1.text) && /hook/.test(err1.text), err1.text);

    await page.fill('#fragmentInput', 'z.not-a-real-fragment!!!');
    await page.waitForTimeout(600);
    const err2 = await page.evaluate(() => ({text: document.getElementById('status').textContent, cls: document.getElementById('status').className}));
    check('malformed fragment surfaces a specific decode error', err2.cls === 'err' && err2.text.length > 0, err2.text);

    check('/compile is not otherwise erroring', errors.length === 0, JSON.stringify(errors));
    await page.close();

    // The fragment /compile produced is directly playable by the root
    // runtime — not one of the five shelf carts, exercises the
    // "any valid cart plays" fix (DESIGN.md §29).
    const page2 = await browser.newPage();
    const errors2 = [];
    page2.on('pageerror', e => errors2.push(e.message));
    await page2.goto(new URL(playHref, `${base}/compile/index.html`).href);
    await page2.waitForFunction(() => window.__urlcadeDebug && window.__urlcadeDebug.getWorld(), {timeout: 10000}).catch(() => {});
    const played = await page2.evaluate(() => {
      if(!window.__urlcadeDebug) return {ok: false, reason: 'no __urlcadeDebug'};
      const w = window.__urlcadeDebug.getWorld();
      return w ? {ok: true, fault: w.cartFault} : {ok: false, reason: 'no world'};
    });
    check('a /compile-produced fragment plays directly (not just shelf carts)', played.ok && !played.fault, JSON.stringify(played));
    check('no errors playing a /compile-produced cart', errors2.length === 0, JSON.stringify(errors2));
    await page2.close();
  }

  await browser.close();
  server.close();
  fs.rmSync(siteDir, {recursive: true, force: true});

  console.log(failures === 0
    ? '\nAll checks passed.'
    : `\n${failures} check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
}
main().catch(e => { console.error('FATAL', e); process.exit(1); });
