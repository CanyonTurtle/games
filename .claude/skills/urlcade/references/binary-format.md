# Binary format & transport

You will not usually hand-build these bytes — `compileCartSource()` does
it — but the shapes below are what actually goes over the wire, and
matter when debugging a fragment that won't decode. All multi-byte
integers are little-endian; `u8`=1 byte, `u16`=2 bytes, `f32`=4 bytes
(IEEE 754). Strings (`inputButtonLabels` values, `hudSpec[].label`) are
length-prefixed: one `u8` byte count, then that many raw bytes,
ASCII-only (a non-ASCII character silently truncates to `charCode & 0xFF`
on encode — a real V0 scope cut, not a bug to work around).

## `encodeCart(cart)` byte order

Exactly this sequence, nothing implicit:

1. `formatVersion` (u8, must be `3`), `cartType` (u8), `rngSeed` (u8),
   `modeFlags` (u8)
2. `screenW`, `screenH` (u16 each)
3. `paletteParams` — exactly 8 raw bytes (padded with `0` if given fewer)
4. `backdropFillIndex`, `backdropGroundHeight`, `backdropGroundIndex` (u8 each)
5. `tileSurfaceOverrides` — u8 count, then `(key u8, value u8)` per entry
6. `inputActiveButtons` (u8), `inputTouchTemplate` (u8), then one
   length-prefixed string per bit set in `inputActiveButtons` (in
   `BUTTON_BITS = [1,2,4,8,16]` order) for that bit's label,
   `inputWantsPointer` (u8, 0/1)
7. `hudSpec` — u8 count, then per line: `kind, sourceKind, srcA, srcB,
   delta, suffixConstIdx (255 if unset), clamp (0/1)` (u8 each) + a
   length-prefixed `label` string
8. `constants` — u8 count, then that many f32
9. `entityTypes` — u8 count, then per type: `renderKind, assetIndex,
   rotateFlag, collisionW, collisionH, extFieldCount` (u8 each)
10. `sprites` — u8 count, then per sprite: a u8 kind flag (`1` if
    shape-list, else `0`), `w`, `h` (u8 each); if shape-list: u8 shape
    count then per shape `type` (u8) + 4 geometry bytes (each
    `round(value*8) & 0xFF` — 1/8px fixed point) + `color` (u8); if raw:
    `w*h` raw pixel bytes
11. `tiles` — u8 count, then per tile: `w`, `h` (u8 each), `w*h` raw
    pixel bytes
12. `mapGenerator` (u8), then its config block (nothing if `0`) — see
    `map-generators.md` for the field list per generator; each field
    writes as u8 except track's `tokens`/platform's `tokens` (u8 count +
    raw bytes)
13. `camera` — `followGlobal` (u8), `clampMinX/Y`, `clampMaxX/Y` (u16 each)
14. `aimLine` — u8 flag (`1` present / `0` absent), then if present:
    `anchorXGlobal, anchorYGlobal, angleGlobal, powerGlobal,
    maxPowerConstIdx, activeGlobal, colorIdx, maxLengthPx` (u8 each)
15. `hooks` — for each of the 6 names in
    `['on_init','on_frame','on_tick','on_input','on_collide','on_draw']`,
    in that fixed order: u16 byte length, then that many raw bytecode
    bytes (`0` length for an omitted hook)

`decodeCart(bytes)` reads this same sequence back and throws (naming the
exact byte offset and how many bytes were expected vs remained) on
truncation or trailing data — a hand-edited or corrupted fragment fails
loudly, not silently, by design.

## Transport: bytes → URL fragment

1. **Compress** (`encodePayload`): try `deflate-raw` (via
   `CompressionStream`, a native browser/Node API); base64url-encode
   both the compressed and the raw bytes, keep whichever produces a
   shorter string. Tag the result `z.` (compressed) or `r.` (raw) —
   compression is opportunistic, never assumed. `decodePayloadToBytes`
   checks the tag and reverses whichever path was taken; an untagged
   string (no `z.`/`r.` prefix) is treated as legacy raw base64url with
   no tag at all.
2. **base64url** (`b64urlEncode`/`b64urlDecode`): standard base64 with
   `+`→`-`, `/`→`_`, and trailing `=` padding stripped (added back on
   decode) — safe to drop straight into a URL fragment with no further
   escaping.
3. **Name/author envelope** (`encodeCartUrl`/`decodeCartUrl`): if a cart
   has a `name` and/or `author`, the final fragment is
   `<uriEncoded name>,<uriEncoded author>,<payload>` — plain readable
   text in front of the payload, not folded into the binary format. A
   comma is a safe, unambiguous separator: neither base64url's alphabet
   nor a legacy untagged payload ever contains one, so a fragment with
   no comma at all is unambiguously "no name/author set," and
   `decodeCartUrl` finds the *first two* commas and treats everything
   after the second as the payload (a comma inside a URI-encoded name
   is itself encoded, so it can't be confused for a separator).

End to end: `#<name>,<author>,z.<base64url of deflated bytes>` — or
`#z.<...>` / `#r.<...>` with no envelope at all if the cart has no
name/author.
