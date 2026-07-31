// Verifies kernel.js is byte-for-byte identical to urlcade.html's own
// encodeCart/decodeCart/assemble/compression, for every currently
// shipped cart plus a couple of synthetic checks. Run this after
// touching either file — kernel.js is a copy, not an import (see its
// own header comment for why), so nothing enforces the two staying in
// sync except this script.
//
// Requires Playwright with a Chromium binary available (this repo does
// not otherwise depend on it — it's a maintainer/verification tool, not
// part of the zero-dependency shipped runtime):
//   npm install playwright && npx playwright install chromium
//   node url-console/v0/test/check-kernel-sync.js
"use strict";
const { chromium } = require('playwright');
const path = require('path');
const K = require('../kernel.js');

async function main(){
  // Set PLAYWRIGHT_CHROMIUM_PATH if your Playwright install can't locate a
  // browser on its own (e.g. a pinned version mismatch) — otherwise this
  // uses whatever `npx playwright install chromium` set up normally.
  const executablePath = process.env.PLAYWRIGHT_CHROMIUM_PATH;
  const browser = await chromium.launch(executablePath ? {executablePath} : {});
  const page = await browser.newPage();
  const filePath = 'file://' + path.resolve(__dirname, '../urlcade.html');
  await page.goto(filePath);
  await page.waitForTimeout(400); // let async cart registration (compression) finish

  let failures = 0;
  function check(label, ok, detail){
    console.log((ok ? 'OK   ' : 'FAIL ') + label + (detail ? ' — ' + detail : ''));
    if(!ok) failures++;
  }

  // 1. encodeCart/decodeCart parity, per shipped cart
  const browserData = await page.evaluate(() => {
    const dbg = window.__urlcadeDebug;
    const out = {};
    for(const [key, c] of Object.entries(dbg.CARTS)){
      const decoded = JSON.parse(JSON.stringify(c.decoded, (k,v) => v instanceof Uint8Array ? Array.from(v) : v));
      out[key] = { decoded, browserEncoded: Array.from(dbg.encodeCart(c.decoded)) };
    }
    return out;
  });
  for(const [key, {decoded, browserEncoded}] of Object.entries(browserData)){
    const cartForKernel = {...decoded, hooks:{}};
    for(const name of K.HOOK_NAMES) cartForKernel.hooks[name] = new Uint8Array(decoded.hooks[name] || []);
    const kernelEncoded = Array.from(K.encodeCart(cartForKernel));
    const bytesMatch = kernelEncoded.length === browserEncoded.length && kernelEncoded.every((v,i)=>v===browserEncoded[i]);
    check(`encodeCart("${key}")`, bytesMatch, `${kernelEncoded.length} bytes`);

    const kernelDecoded = K.decodeCart(new Uint8Array(browserEncoded));
    const kernelDecodedPlain = JSON.parse(JSON.stringify(kernelDecoded, (k,v) => v instanceof Uint8Array ? Array.from(v) : v));
    check(`decodeCart("${key}")`, JSON.stringify(kernelDecodedPlain) === JSON.stringify(decoded));
  }

  // 2. assemble() parity on a snippet exercising labels/branches/constants
  const src = ['LOADG 1','PUSHC 0','ADD','DUP','PUSHI 10','CMPLT','JZ done','STOREG 1','JMP loop','loop:','NOP','done:','HALT'];
  const sym = {constants:{FOO:0}, globals:{}};
  const browserAsm = await page.evaluate(({src, sym}) => Array.from(assemble(src, sym)), {src, sym});
  const kernelAsm = Array.from(K.assemble(src, sym));
  check('assemble() parity', browserAsm.length === kernelAsm.length && browserAsm.every((v,i)=>v===kernelAsm[i]), `${kernelAsm.length} bytes`);

  // 3. Cross-runtime compression interop, both directions, on a payload
  // large enough to actually trigger the compressed ("z.") path.
  const testBytes = [];
  for(let i=0;i<400;i++) testBytes.push((i*7)%50, 1, 2, 3, (i*3)%10);
  const browserFragment = await page.evaluate((bytes) => window.__urlcadeDebug.encodePayload(new Uint8Array(bytes)), testBytes);
  check('browser fragment is compressed (sanity check on the test payload)', browserFragment.startsWith('z.'));
  const viaKernel = Array.from(await K.decodePayloadToBytes(browserFragment));
  check('browser-compressed -> kernel-decompressed', viaKernel.length===testBytes.length && viaKernel.every((v,i)=>v===testBytes[i]));
  const kernelFragment = await K.encodePayload(new Uint8Array(testBytes));
  const viaBrowser = await page.evaluate((f) => window.__urlcadeDebug.decodePayloadToBytes(f).then(b => Array.from(b)), kernelFragment);
  check('kernel-compressed -> browser-decompressed', viaBrowser.length===testBytes.length && viaBrowser.every((v,i)=>v===testBytes[i]));

  await browser.close();
  console.log(failures === 0 ? '\nAll checks passed — kernel.js matches urlcade.html.' : `\n${failures} check(s) FAILED — kernel.js has drifted from urlcade.html.`);
  process.exit(failures === 0 ? 0 : 1);
}
main();
