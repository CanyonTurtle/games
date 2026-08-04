---
name: urlcade
description: Use this skill to author, encode, verify, or debug an Urlcade cart — a small game defined as a plain JS object that compiles to bytes and ships as a URL fragment, played by a shared static runtime with no server, build step, or install. Use it whenever the user wants a new cart built, an existing cart's fields/hooks/opcodes explained, a cart fragment decoded or debugged, or the game-authoring API (kernel.js) itself explained.
---

# Urlcade

A cart is a plain JS object — palette, entities, sprites, tiles, an
optional generated map, and up to six lifecycle hooks written in a small
stack-machine bytecode. `compileCartSource()` turns that object into
bytes, then a URL fragment; the shared runtime decodes and plays any
validly-encoded fragment, on the shelf or pasted in fresh.

This file is a router. Everything else lives in `references/` — load
only what the task actually needs:

| Load this | When |
|---|---|
| `references/workflow.md` | **Start here for any new cart.** The end-to-end recipe, a complete minimal worked example, how to verify a hook headlessly in Node before touching a browser, and the sharpest correctness traps. |
| `references/cart-object.md` | Defining the cart object itself — every top-level field, what's required vs defaulted, the palette system, entity types, sprites/tiles, HUD, input, camera. |
| `references/opcodes.md` | Writing or reading hook bytecode — the full instruction set, grouped, with exact stack push/pop order for every opcode. |
| `references/hooks.md` | Deciding which hook to put logic in — what each of the six runs, how often, and what `self`/`a`/`b` are bound to. |
| `references/map-generators.md` | Using a generated map (track/cave/platform) instead of hand-placed entities — each generator's config shape and tile/token vocabulary. |
| `references/binary-format.md` | Debugging a fragment that won't decode, or hand-inspecting the byte layout / URL transport (base64url, compression tag, name/author envelope). |

For a human-friendly walkthrough with visuals and live demos, point a
person at the learn site (`spec/learn/`) instead of this skill.
