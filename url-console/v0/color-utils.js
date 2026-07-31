/* ============================================================
   The Urlcade — tiny DOM-dependent color helpers

   Split into their own module (rather than living in runtime.js) so
   that neither runtime.js nor carts/index.js has to import the other
   just to convert a palette entry to RGB/hex — both need this, in
   different directions, and a one-way shared leaf avoids a cycle.
   ============================================================ */
"use strict";
function cssColorToRGB(col){
  if(col.startsWith('#')){
    const n = parseInt(col.slice(1),16);
    return [(n>>16)&255,(n>>8)&255,n&255];
  }
  // hsl(h,s%,l%) -> use canvas to resolve
  const el = document.createElement('canvas').getContext('2d');
  el.fillStyle = col;
  const resolved = el.fillStyle; // becomes #rrggbb
  const n = parseInt(resolved.slice(1),16);
  return [(n>>16)&255,(n>>8)&255,n&255];
}
function cssColorToHex(col){
  const [r,g,b] = cssColorToRGB(col);
  return '#' + [r,g,b].map(x=>x.toString(16).padStart(2,'0')).join('');
}
export { cssColorToRGB, cssColorToHex };
