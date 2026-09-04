# Cybercruise

A retro **80s neon wireframe** browser game in vanilla JavaScript, inspired by the
1983 arcade classic **Spy Hunter**. Drive a car along an infinite curving neon
highway, weave through friendly and enemy traffic, and blast enemies with a
selection of switchable weapons.

> **This file is a map, not a manual.** Every module carries a header explaining
> what decision it embodies and what would go wrong without it, and that is where
> the reasoning lives — often at far more length than makes sense here. What
> follows says what each system IS, what is load-bearing about it, and which file
> to open. Where the two disagree, the source wins.

## Play

```bash
npm run serve
```

Then open <http://localhost:5173>. On Windows, **`play.bat`** does the same and
waits for the port before opening the browser; it takes an optional port
(`play.bat 8080`). The game is native ES modules, so it cannot be opened as a
`file://`.

Both run `tools/serve.js` — a static server on Node built-ins alone, because the
project has zero dependencies and starting the game must not depend on a working
npm install. It is deliberately **API-free**: the soundtrack listing is a
committed manifest (`npm run music`), not an endpoint, so what runs locally is
byte for byte what runs on a static host. `tools/serve.js` and
`tools/musicmanifest.js` have the full reasoning.

Any static server will do. Two traps if you roll your own: `.js` must be sent as
`text/javascript`, and resolve the document root to an absolute path before the
containment check.

`.claude/launch.json` runs the same server, plus an entry for the tuning editor.

| script | |
| --- | --- |
| `npm test` | the cross-file invariant suite — `test/README-invariants.md` |
| `npm run sim` | headless driving-profile measurement (`tools/drivesim.js`) |
| `npm run econ` | headless credit-economy measurement (`tools/econsim.js`) |
| `npm run music` | regenerate `assets/music/tracks.json` |

### Controls

| Key | Action |
| --- | --- |
| ←/→ or A/D | Steer |
| ↑/↓ | Accelerate / brake |
| Space | Fire |
| Tab / Shift / Q | Swap weapon |

### Test options

Two cheat rows on the start/pause menu — `INVULNERABILITY` and `EXTRA CASH` —
for reaching by hand what a normal run makes expensive to reach. Neither is
persisted (the game is served, not installed — see `game/menu.js`'s own note);
both reset to OFF on every load and take effect on the next tick.

**Hidden until F1, armed only by a mouse click.** The rows don't draw at all
until F1 is pressed, and even then the keyboard's up/down wrap never steps
onto them — a click directly on the checkbox is the only way to select or
flip one, so a stray key can never arm a cheat by accident. See
`game/menu.js`'s and `testoptions.js`'s own comments for why.

**`src/testoptions.js` is the switch**: clearing `SHOW_TEST_OPTIONS` (or either
per-row flag) removes them from the menu entirely, and a removed row always
reads as off. `test/test-options.test.js` pins that the removal is complete
rather than half-wired.

**Useful when verifying a change in a live browser session, AI-driven or not**:
`INVULNERABILITY` survives anything so a change can be watched for as long as it
takes rather than for as long as one life lasts, `EXTRA CASH` opens the whole
shop instantly instead of grinding credits for it, and the same file's
`EVENT_AT_OVERRIDES`/`EVENT_GATE_OVERRIDES` pull a specific encounter forward to
DIST 0 so it can be reached in seconds instead of driven to. All three are code
edits, not menu state, and all three ship back at their defaults (`{}` for the
override maps) once the thing they were checking is confirmed.

### Asset gallery

A static showcase of the neon assets for iterating on visuals without running
the game. Run `tools/gallery/gallery.bat`, or `npm run serve` and open
<http://localhost:5173/tools/gallery/gallery.html>. Add a sprite in
`src/game/sprites.js`, then register a cell in `tools/gallery/gallery.js` — car
types are the exception, since the gallery walks the catalogue. It lives in
`tools/` rather than `src/`, alongside the tuning editor, since it is a dev
tool over the game's source rather than part of the game itself.

The silhouette catalogue at the bottom draws each car at **2x** as a detail
study; the traffic cells above it are the size-accurate ones. See the detail
budget in `src/game/carshapes.js`.

### Tuning editor

`tools/car-editor/` — a local browser UI for essentially every balance number in
the game, across five tabs:

| Tab | What it edits |
| --- | --- |
| Cars | the whole roster: hull and mass, speed and steering, blast, score and bounty, spawn odds and distance, driving profile |
| Hazards & pickups | toughness, contact damage, blast and slow, crate payloads, spawn odds and distance |
| Weapons | the player's kit and the hostiles' alike |
| Shop | consumable prices and payloads; a system's tier-1 price and what one tier adds |
| World | the stock car, traffic density, the road's shape, the run's pacing and economy |

Run `tools/car-editor/edit.bat` or `node tools/car-editor/server.js`. Every field
shows its value and what it does; "Create Pull Request" patches the source on a
fresh branch, **runs the test suite before pushing**, and opens GitHub's compare
page. Requires Git, not the GitHub CLI.

Two things worth knowing before tuning. Driving profiles are **shared** (the van
and the bus both drive `hauler`; anything unnamed falls back to `commuter`), so
the editor states the reach of a behaviour edit on the form and in the diff. And
a stat's shop ladder counts up from the car's own figure, which is why
`MAX_SPEED`, `BASE_MAX_HEALTH` and `PLAYER_MASS` are tuned under World rather
than on the shop screen.

## Project layout

```
index.html          canvas + module entry
css/style.css       page + CRT frame styling
src/
  main.js           bootstrap, the game loop, and the state machine over it
  testoptions.js    the menu's cheat rows, and the switch that removes them
  engine/           loop, input, neon draw helpers, sprite cache, viewport,
                    the console and the gutter panels
  game/             player, road, traffic, weapons, events, shop, city floor
  audio/            synth, the sound catalogues, the wavesynth and track backends
  demo/             the asset gallery's cells
tools/
  serve.js          the zero-dependency static server
  drivesim.js       headless driving-profile measurement
  econsim.js        headless credit-economy measurement
  musicmanifest.js  regenerates assets/music/tracks.json
  car-editor/       the tuning editor — see above
test/               the cross-file invariant suite — see its own README
test-support/       fixtures shared between test files, deliberately outside test/
docs/superpowers/   design records, each with a banner saying what shipped
```

## Tech

- Vanilla JS + HTML5 Canvas 2D — no framework, no build step
- Native ES modules
- Web Audio API for SFX and for music — a procedural wavesynth backend and a
  committed soundtrack behind one interface (`src/audio/`)

### Rendering performance

`ctx.shadowBlur` is what makes the neon look and is by far the most expensive
thing the renderer can do — its cost scales with the shadow's **bounding-box
area**, not with the shape. Before this was addressed, glow was ~80% of frame
time (5.05ms → 1.01ms with `shadowBlur` forced to 0) and grew linearly with every
object on screen.

Three rules keep that from coming back:

1. **Anything drawn per-frame per-entity goes through the sprite cache** —
   `drawCarCached` / `drawBuildingVariant` (`src/game/sprites.js`), or a wrapper
   on `src/engine/spritecache.js`. Cache keys must be bounded: quantise
   continuous parameters, never key on a raw float.
2. **Never put `shadowBlur` on a path that spans much of the canvas, and
   (since Phase 15d-ii) not on a cached sprite either.** Use `neonStroke`
   (`src/engine/neon.js`) for anything live and per-frame; bloom
   (`engine/present.js`) supplies the halo over the whole finished frame, so
   nothing drawn into the 2D layer needs a glow of its own any more —
   `neonStroke` is a single plain stroke, and `carshapes.js`/`buildingshapes.js`/
   `obstacleshapes.js` draw plain lines and fills into the sprite cache the
   same way. Through 15d-i, `neonStroke` faked its halo with a three-pass
   overdraw instead (865µs shadowed against 217µs layered for one full-height
   barrier) precisely because a real blur was unaffordable on a canvas-spanning
   path; 15d-ii's *Rendering the halo* below has the retuned numbers.
   **This covers TEXT ON THE BLOOMED CANVAS too, as of the vector type below**:
   `vectorText` (`src/engine/neon.js`) carries no `shadowBlur` for exactly this
   reason. `glowText` still does, and is still right to — it draws on `#hud`,
   which bloom never reads.
3. **Anything that only SCROLLS is pre-rendered and blitted, not re-stroked.**
   The road is a rolling cache of 128px strips (`road.js`), the city floor a
   single tile (`scenery.js`) — together ~4.3ms/frame down to ~60µs. A new
   full-screen scrolling layer belongs in a cache too; check first whether it
   *repeats* (one tile) or not (a keyed sliding window).

**The camera is quantised to whole pixels, and this is load-bearing.** `main.js`
rounds `distance` ONCE at the top of the render pass and hands that value to
every layer. A blit is only pixel-exact at an integer offset, so interpolating
the scroll — or rounding per-layer — resamples both caches, softens the neon and
shears the traffic against the road. Do **not** round the simulation's
`distance`: the odometer and the score's distance term read the real float.

Current cost is **under 1ms/frame** at 600×800 with a full screen of traffic,
against 16.7ms, and **flat in object count** — entities are effectively free and
the remaining budget is governed by screen area. Nothing is left above the noise
floor (all building blits together 43µs, a cached car ~8µs, `clear()` ~25µs), so
future work here should be triggered by a measurement rather than a hunch.

**Culling was never needed.** The city floor was measured at every sub-phase of
Phase 7 that looked likely to force it, and landed at or under the ~0.5ms budget
each time — including 7g's materialisation, the one most likely to have broken
it. The full per-sub-phase numbers, the 7e result that briefly made culling look
like a prerequisite, and the rejected half-res glow downsample are all in
`docs/superpowers/specs/2026-08-07-city-map-layer-design.md`.

Profiling traps, each of which cost time to rediscover: `getImageData` used
to "force a flush" demotes the canvas out of GPU acceleration and changes what is
being compared, and measuring throughput inside `requestAnimationFrame` silently
floors at vsync and reports a ratio of ~1. Two plausible-looking methods
disagreed by 5x. A third, found in Phase 15a: rAF is throttled to a standstill
in a hidden tab, so anything counting frames has to be measured with the page
actually on screen. A fourth, found re-measuring in Phase 15d-ii: "on screen"
is not the same claim as `document.hidden === false`, and in this project's own
sandboxed browser tooling the two disagree — a tab opened with a plain
navigate reported `hidden: false` and *also* throttled rAF to ~1-2Hz, silently
turning an 8-second sample into 15 frames. The tab opened by `preview_start`
did not, and sustained ~90-150Hz. When a frame-rate-dependent measurement in
that tooling looks too quiet, check which call opened the tab before trusting
the number.

### The present path

The finished 2D frame is uploaded as a texture and run through a WebGL2 chain
on a canvas sitting on top of the 2D one. Phase 15a shipped that chain as a
single no-op blit — pixel-identical either way — to isolate the plumbing from
the look; Phase 15b puts the first real effect in it: bright-pass threshold,
half- and quarter-res separable Gaussian blur, additive recombine with a tone
knee. **Phase 15e-i adds the second, and it is the first one that is not a
filter over the picture but part of the GAME** — the jack-in and the disconnect
(*The feed pass* below). `src/engine/present.js` is the whole chain,
`src/engine/gl/shaders.js` the GLSL for each stage, `src/engine/gl/target.js`
the renderable-texture helper its targets share, `src/engine/gl/context.js` the
WebGL2 setup underneath all of it.

Things about it worth knowing before touching the renderer:

- **It is one call, wrapped around `render()` in `main.js`** — not written at
  that function's tail, because `render()` returns early on the menu and the
  shop and a present those branches skip is a **black** screen, not a stale one.
- **`present()` TAKES GAME STATE, AS OF 15E-I, AND THE OLD RULE IS REWRITTEN
  RATHER THAN QUIETLY DROPPED.** Through 15d this section and `main.js` both
  said "no module under `src/game/` knows the GPU path exists". The jack-in and
  the disconnect are now drawn by a fragment pass, and a sequence driven by a
  progress value cannot be rendered by a pass that is told nothing. **The
  second half of that claim is still true and is the point**: `jackin.js` and
  `disconnect.js` import nothing from `present.js` or `gl/`. Each grows a
  `feed(out)` method that writes plain numbers into one frozen-shape object
  `present.js` owns, and `main.js` — which already owns both instances and the
  state machine — is the only place that knows those numbers reach a shader.
  **The game computes, `main.js` describes, `present.js` renders**, one
  direction only, nothing read back. The fields name the SIGNAL rather than
  either sequence (`resolve`, `corrupt`, `split`, `quant`, `fade`, `flash`,
  `order`, `shakeX/Y`, `time`, `seed`), which is what lets 15e-iv's hull-driven
  corruption write the same fields without widening anything.
- **`src/testoptions.js`'s `GL_PRESENT` A/Bs bloom against a plain blit** — both
  through WebGL2, and **as of 15e-i the feed pass sits OUTSIDE it**: the flag's
  job is to compare a halo, and a switch that also deleted the boot and the
  death would be useless during exactly the two moments it would be flipped to
  look at. Off still means precisely "skip bright-pass/blur/composite". **It no longer A/Bs the GPU path against the 2D canvas**:
  Phase 15d-i made WebGL2 REQUIRED (see `gl/context.js`'s header for the
  reversal and why), so a machine without it is told the game cannot run
  rather than being handed a haloless version of one, and a context lost
  mid-run pauses the game — the world frozen, a DOM notice covering all three
  canvases (see the HUD layer below) — rather than dropping back to something
  lesser. Both failure paths
  are verified, context loss included — 15b re-verified the loss/restore path
  by hand with `WEBGL_lose_context` before 15d-i changed what restoring means
  to the player, since restoring rebuilds four programs and four render
  targets rather than one texture (present.js's header calls this out as a
  high-risk area); 15d-i re-verified it again by hand afterward, this time for
  the pause and resume rather than the rebuild.
  **THE Y-FLIP LIVES IN THE FRAGMENT STAGES THAT TOUCH THE CPU-UPLOADED FRAME
  TEXTURE, NOT IN THE SHARED VERTEX STAGE** — found live, not by inspection:
  a first draft baked 15a's flip into the vertex stage all seven draws share,
  which is correct for the one CPU-uploaded texture but silently double-flips
  every GPU-to-GPU pass in the chain, so bloom rendered mirrored vertically
  against whatever cast it (obvious on the menu, where the title sits near the
  top and the mirrored glow lands in the empty space near the bottom with
  nothing nearby to explain it — much harder to spot in gameplay, where a busy,
  fairly repetitive scene made a full-frame vertical mirror look "roughly
  plausible" at a glance). `gl/shaders.js`'s `PRESENT_VS` header carries the
  full reasoning; the fix is structural rather than a constant to get right by
  trial and error.
- **Both canvases are sized by `engine/viewport.js`** (`mirrorCanvas`), so the
  fit, the eighth-step quantisation, the `MAX_SCALE` cap and the resize settle
  have one implementation rather than two that can drift.
- **THE BRIGHT PASS TAKES FOUR TAPS AND THRESHOLDS EACH ONE BEFORE AVERAGING
  THEM**, and that is a bug fix, not a quality knob. It shipped in 15b as a
  single NEAREST tap into a half-res target, which works out to sampling only
  the frame's ODD ROWS — so a one-pixel-tall bright horizontal line (a
  building's roof outline is exactly that) had a halo on the frames where it
  landed on an odd row and NO halo on the others, and flickered at up to 30Hz
  as the city floor scrolled it between them. Reported as building edges
  flickering at speed after 15c; measured on a 64x64 probe as total green
  16320 (bare core, zero bloom) on an even row against 65792 on an odd one,
  and 41088 flat across every row afterwards — which is also, to within 0.08%,
  the mean of the two states it used to alternate between, so the halo is now
  steady at the brightness the eye was already integrating. **A LINEAR fetch
  was tried first and is the trap here**: one bilinear tap at the quad corner
  is the same 2x2 average for no extra fetch, but it averages BEFORE the
  threshold, which puts a 1px line at exactly 0.5 — under `BLOOM_THRESHOLD`'s
  0.55 — and deletes thin lines' halos outright (the same probe read 16320 on
  every row: no flicker, because no bloom). Thresholding per tap is not
  expressible as a filter mode. `BRIGHT_FS`'s header has the derivation.

**A THIRD CANVAS, AS OF PHASE 15C: `#hud`, plain 2D, never uploaded to the
GPU.** `src/main.js`'s `drawHud()`, the menu's test-row checkboxes and the
shop's entire price list draw there instead of on the canvas this chain
bloom's, so the dense per-frame readouts that used to cap `BLOOM_THRESHOLD`/
`BLOOM_EXPOSURE` (see *Rendering the halo*) are no longer in this chain at
all. It is a DOM layer composited by the browser, not a second texture fed
into `COMPOSITE_FS` — the second-texture path was measured and rejected: the
per-frame frame-texture upload already dominates this chain at ~1047us (see
Cost below), and a second full-size upload for the HUD would have added
roughly that again, to buy back a compositor blend `will-change: transform`
already makes close to free (the same trick this canvas already gets over
`#game`). `present.js`'s "The HUD split" has the full argument and the
measured numbers either way. It is registered as a third `mirrorCanvas`
alongside `#present`, sits `pointer-events: none` without exception (the
menu's mouse-only test rows sit directly under it — `src/testoptions.js`),
and is covered by `#gl-notice` on both of its failure paths exactly as the
other two canvases already were.

**THE PIXEL-IDENTITY SELF-TEST, verified live.** With the bright-pass threshold
raised to 1.5 (every frame channel is in [0, 1], so this forces the bloom
contribution to exactly zero at every stage — see `BRIGHT_FS`'s header for why
that's provable by inspection rather than merely likely) and the composite's
frame read compared against the source Canvas2D frame via a synchronous
`gl.readPixels` immediately after the draw: **0 mismatches across 2,430,000
bytes** (675x900x4, the drawing buffer at this machine's window size). The
composite reproduces the source frame bit for bit when bloom is zero, which is
the 15a pixel-identity property carried into 15b rather than lost to it.

**RE-RUN FOR 15E-I, IN TWO CONFIGURATIONS, ON A MENU FRAME AND A GAMEPLAY
FRAME — 0 mismatches across 2,430,000 bytes in all four.** The first is the
one that matters: with the feed idle (`feed.level` 0) the pass **is not drawn
at all**, so ~99% of the frames the game ever shows go through exactly the
chain they went through in 15d. The second is stronger and was worth taking
anyway: forcing the pass to RUN with every field at rest is *also* byte-
identical, which makes the skip an optimisation rather than something
correctness depends on. (`GLITCH_FS` is written to be the exact identity at
rest — at `quant` 0 its level count is exactly 255.0, so the round trip
through `floor(c * 255 + 0.5) / 255` returns an 8-bit channel unchanged, and
every other term is multiplied or added by zero.)

**AND IT EARNED ITS KEEP.** The first 15e-i run came back **10,975 bytes off**,
every one of them in the bottom block row: the arrival frontier is a band, and
a caller's `resolve` of exactly 1 parks it ON the last blocks rather than past
them, so that row flared permanently — live, a bright strip along the bottom of
the screen from `SWEEP_END` to the end of every jack-in. The fix is a margin
that lets the frontier travel slightly beyond both ends of the field
(`FRONT_MARGIN`, `GLITCH_FS`).

**THE FEED PASS (Phase 15e-i).** The jack-in and the disconnect used to be
Canvas2D: `jackin.js` masked, tore and channel-split the frame by drawing it
back onto itself; `disconnect.js` swept and dimmed it. Both are now one
fragment stage, `GLITCH_FS` (`gl/shaders.js`), which runs **before the bright
pass** so bloom reads the corrupted frame — a displaced block takes its halo
with it, and corruption that did not glow would read as a compositing bug on a
game whose whole look is that bright things glow. Its header carries the
design; the short version is that the screen is a grid of macroblocks with
per-block arrival times, and **one scalar swept up gives a feed arriving and
swept down gives one collapsing** — which is what those two modules' headers
have always claimed about each other without ever sharing an implementation.
The vocabulary is deliberately the DATA one (packet arrival, block loss, line
dropout, reordering, channel desync, bandwidth collapse): **CRT simulation was
rejected outright by the project owner** — no phosphor, no barrel distortion,
no standing scanline overlay, no vignette-as-tube-falloff.

**NEITHER MODULE DRAWS ON THE WORLD CANVAS ANY MORE.** `jackin.js` and
`disconnect.js` are a beat table, an offset and a HUD readout each; everything
that used to be ink is a number now. The last 2D draw to go was the death's
hit core — a white ring at the car's centre, shrinking to nothing over the
killing frame — which 15e-i initially kept, since it is geometry at a position
and the pass has the frame but not the car. It was dropped on the project
owner's call once everything around it had changed: it read as a circle closing
in rather than as a hit, and it was a lone Canvas2D artifact firing inside the
one beat where the pass is deliberately idle. `FLASH_END` went with it, and the
death now opens on the car simply being gone — the punctuation on the hit is
the sound and the absence.

Three things worth knowing before touching it:

- **The readouts stay sharp because the pass physically cannot reach them.**
  The boot percentage and CONNECTION LOST live on `#hud` (Phase 15c above),
  which is never uploaded to the GPU. The world fails and the instruments keep
  working — the right fiction, and free.
- **THE SEED IS A FRACTION IN [0, 1), NOT THE CALLER'S RAW SEED, AND THAT IS A
  BUG THAT NEARLY SHIPPED LOOKING FINE.** `GLITCH_FS` adds the seed to block
  indices in a 32-bit float; above 2^24 consecutive integers are not
  representable, so a raw `Math.random() * 0x7fffffff` seed — where the gap
  between floats is 128 — **swallows the block index entirely** and every block
  hashes the same. The arrival frontier collapses to a straight horizontal line
  and every torn row tears together. It was invisible for a whole round of
  captures because those were taken on an instance whose `trigger()` had never
  run, so its seed was the constructor's 1; the bug only appears once a real
  run has seeded it, which is every run. Found by looking at a frame, not by
  reasoning. The callers reduce their own seed, and
  `test/present.test.js` range-checks the field.
- **No history texture, on purpose.** Frame-to-frame persistence was the
  obvious way to get real feedback and is rejected: it would make a render
  target's CONTENTS matter across frames, and target contents are the one thing
  `build()` cannot restore after a context loss. As written the pass is a pure
  function of its uniforms, so the first frame after a restore mid-sequence is
  simply correct — verified by hand with `WEBGL_lose_context` during a
  sequence, comparing the frame either side (identical lit-pixel count, byte
  diff on the same order as two no-loss renders of the same beat).

**THE 2D WORK IT REMOVED WAS MEASURED BEFORE AND AFTER**, rather than
asserted — `main` timed in a throwaway worktree of its own, with the same
harness. `render()`'s own CPU time, 400 frames per sample, three samples,
675x900, the same frame-stepping harness in each build:

| beat | on `main` | 15e-i |
| --- | --- | --- |
| jack-in 0.50 (mid chromatic split) | 0.489 / 1.743 / 2.145 ms | 0.282 / 0.232 / 0.247 ms |
| jack-in 0.80 | 1.114 / 1.124 / 1.694 ms | 0.227 / 0.289 / 0.253 ms |
| disconnect 0.50 | 0.436 / 0.384 / 0.223 ms | 0.254 / 0.188 / 0.208 ms |

The jack-in rows are the ones with something to remove: the split phase ran
`tintedCopy` twice per frame — a full-device-resolution `clearRect` +
`drawImage` + `multiply` `fillRect` each — then drew both back, six full-frame
operations plus a `blitScreenBand` per tear band. On `main` that is not only
expensive but WILDLY VARIABLE (0.489 to 2.145 across three samples of one
beat), which is what full-frame composited drawImage work looks like; on 15e-i
those frames are tight around 0.25ms and indistinguishable from an ordinary
one. The disconnect barely moves, correctly — its 2D side was only a
`fillRect` and two `glowLine`s.

**The GPU side of that trade could not be measured here.** `present()`'s
wall-clock came back between 0.04 and 1.7ms on BOTH builds with no relation to
whether the pass ran — the highest single reading was a disconnect frame on
which the feed is idle and the pass is not drawn at all — so the figure is
driver-queue backpressure in this sandboxed pane, not per-call cost. The GL
call count is unchanged on every frame outside the two sequences; inside them
it is one extra draw and eleven uniform calls, for a couple of seconds per run.

**Cost.** 15a's baseline (~259us at scale 1, ~1047us at 1200x1600 on an Intel
Iris Xe, ~15us of it CPU submit) does not have a directly comparable 15b
number yet. Measuring inside this project's own development sandbox (a
remoted/virtualized browser pane, not a bare desktop Chrome) turned up what
looks like a SIXTH profiling trap to add to the five the rendering-performance
section above already lists: forcing a GPU sync with `gl.readPixels`
immediately after the draw — the exact technique 15a used to get past
`gl.finish()` not being a sync point on ANGLE/D3D11 — measured ~7-8ms just for
the ORIGINAL 15a one-draw blit in this environment, nearly 10x its historical
1047us on the same reported GPU (`ANGLE (Intel, Iris Xe Graphics, D3D11)`, so
this is not a software-rendering fallback). The full 15b chain measured
~11.4ms by the same method — a real, small, incremental cost over the
single-draw figure taken the same way, but neither absolute number is safe to
compare against 15a's desktop-Chrome baseline; something about syncing a
remoted display pipeline dominates both. What DID measure consistently low in
this environment: CPU submit time (wall-clock with no forced sync), ~0.3ms
mean for the full seven-draw chain against 15a's ~15us for one draw — higher,
plausibly consistent with a virtualized driver's higher per-call overhead, but
still a small fraction of the 16.7ms budget and not competing with `update()`.
**THE BARE-DESKTOP RE-MEASUREMENT OWED SINCE 15B IS STILL OWED — 15e-i did not
take it, and 15e-ii-a did not either** — this is still the same
sandboxed/remoted pane, and the paragraph below is unchanged for the same
reason it was unchanged in 15c. It is named here rather than papered over with
a number that could not be measured. The soft knee's own added cost (one
`clamp`, one `max`, one multiply and one divide per tap, per channel, on top of
what `max(c - uThreshold, 0.0)` already cost) is the same class of change
15c-i's own three extra fetches were measured against and found free relative
to the ~1047us frame-texture upload that dominates this chain — no new texture
fetch, no new draw call, just a few more ALU ops inside a fragment shader
already bound by the upload rather than by its own arithmetic. Not
independently re-measured for the same reason the paragraph above names: the
CPU-side number this environment CAN measure would not show a GPU-bound
shader's real cost either way.
**This section needs re-taking on a bare desktop browser before its numbers can
be read as the phase's real GPU cost** — the dropped-frame table below is
carried over from 15a unchanged for the same reason: retaking it through the
same remoted pipeline would not produce a comparable number, and re-doing it in
a properly diagnosed environment is next session's job, not a settled result of
this one.

### Rendering the halo

**Bloom is not the only thing in the chain any more.** Phase 15e-i's feed pass
runs BEFORE the bright pass, so everything below describes what happens to a
frame the boot or the death may already have corrupted — deliberately, so a
displaced block carries its own halo. See *The present path* above.

Through Phase 15d-i, bloom ran ALONGSIDE `neonStroke`'s own three-pass overdraw
and every cached sprite's own `shadowBlur` — real per-pixel bloom laid over a
hand-tuned fake one, deliberately not reconciled yet (present.js's header:
"this PR does not try to make a doubled halo... look right"). Phase 15d-ii is
that reconciliation: bloom is now the ONLY source of halo in the game.
`neonStroke` (`engine/neon.js`) collapsed from three strokes to one at all 59
call sites across `effects.js`, `projectiles.js`, `road.js`, `exhaust.js`,
`nodeshapes.js`, `scenery.js`, `links.js`, `shells.js`, `walletrender.js` and
`disconnect.js`; `glowLine`/`glowPoly` (the same file) dropped their own
`shadowBlur` too, which reaches every mark in `carshapes.js`,
`buildingshapes.js`, `obstacleshapes.js` and `pickupshapes.js` — the shape
catalogues the sprite cache rasterises once and blits thereafter (`pickupshapes.js`
crates are the one exception drawn live rather than cached, and stayed in that
list anyway once the signature bug below made it moot — see THE SIGNATURE BUG
below); and `player.js`'s shield swapped `glowOrb`'s radial gradient for a
single additive ring, for the same reason (its own header carries the
argument, including why a ring rather than a filled disc — a filled disc
would wash out the wireframe under it exactly the way the gradient's dimmed
centre stop was built to avoid).

**BLOOM_THRESHOLD/BLOOM_EXPOSURE (`present.js`) WERE HELD AT 0.75/3.0 THROUGH
15D-II — BUT NOT BECAUSE THE FIRST PASS OF VERIFICATION CAUGHT EVERYTHING.**
It didn't, and the honest record is worth keeping. The initial live check
(menu, connecting boot, gameplay with traffic and buildings on screen) looked
at FULL-ALPHA, OPAQUE elements — the car's own wireframe, road barriers — and
concluded no retuning was needed. It missed the player's shield ring
entirely, which is exactly the kind of element that check didn't cover: drawn
at a fraction of full alpha as a STEADY STATE (not a fade), so its composited
brightness never got near the threshold regardless of geometry. Found live,
by the person actually looking at the running game, not by this project's own
verification pass — see player.js's `SHIELD_ORB_ALPHA` header for the
per-channel arithmetic and the fix (0.3 → 0.85).

That opened the real question: should `BLOOM_THRESHOLD`/`BLOOM_EXPOSURE`
themselves move, so a moderately-bright element like the OLD shield alpha
would bloom without needing its own fix? Tried live (0.75→0.55,
3.0→4.0) and measured two ways — a full-height bar's halo intensity roughly
doubled, which is what "stronger" was asked for — but the SAME lower
threshold also pulled HUD text into blooming, and text has nothing in common
with a barrier: `glowText`'s glyphs are small, dense, and it is the SOLID FILL
of each character (not its own `shadowBlur`) that crosses the threshold, so
letters bloom into their neighbours before the AREA increase reads as "text
glowing more" — measured directly (a horizontal scan through "SCORE 12345"):
at 0.75/3.0 the gap between letters still dipped to ~30-40 against a ~250
peak; at 0.55/4.0 the same gaps only reached ~45-90, visibly bridging words
together. There was no way to give the world a stronger pass without also
doing that to text through ONE global post-process over the whole composited
frame — that split (HUD off the bloomed layer entirely) was what Phase 15c
was for, and it was not built yet. Reverted to 0.75/3.0 at the time, pending
that split.

**PHASE 15C LANDS EXACTLY THAT SPLIT AND FINALISES 0.55/4.0.** With `drawHud()`,
the menu's test rows and the shop's entire shelf moved onto their own
unbloomed `#hud` canvas (see *The present path* below), the SAME pair 15d-ii
tried and reverted has nothing left to bridge — there is no dense text sharing
the bloomed canvas any more, only large display type (the menu's title and
rows, the shop's header and credit total, `gameover`'s FINAL SCORE) that reads
the same way `CYBERCRUISE`'s own 46px title always has. Confirmed live across
a busy gameplay scene, the menu and the gameover screen: buildings and
barriers gained a visibly thicker, richer halo without washing into flat
blobs — internal wireframe detail stays legible — and every readout on
`#hud` stayed crisp throughout. `present.js`'s header has the full account,
including a readPixels scan through a barrier cross-section corroborating
(not re-deriving, since the two scans were taken on different live runs)
15d-ii's own "roughly doubled" finding. World glow is now real AND strong —
the gap this section used to end on.

**THE SIGNATURE BUG, found the same way — live, by a person looking at the
game, not by review, and worse than it first looked.** `glowLine`/`glowPoly`
lost their `blur` PARAMETER in this phase (not just its effect), and every
caller had to be found, not just the three files this sub-phase set out to
touch. First found in `pickupshapes.js`, missed entirely: its calls like
`glowPoly(ctx, outer, PICKUP_FRAME, 1.5, 9)` kept passing a positional `9`
that used to be `blur` and is now `fill`, so a crate's reticle and glyphs
started calling `ctx.fill()` with a fill style of the NUMBER 9 wherever that
path used to be stroke-only — read live as pickups "oscillating toward white"
as whatever `fillStyle` happened to be left over from a previous draw call
bled into shapes that were never meant to be filled at all. All 15 sites in
`pickupshapes.js` were wrong the same way.

THAT FIX PROMPTED A RE-READ OF `carshapes.js`'s OWN `drawShapeObject`, AND IT
HAD THE IDENTICAL BUG ON THE CHASSIS FILL OF EVERY CAR IN THE GAME —
`glowPoly(ctx, fracLoop(p, cx, cy, hw, hh), color, 2, 13, CAR_FILL)`, the main
body fill step every single car and traffic type runs through, plus the rear
wing bar. `13` (the old blur) landed in `fill`, and `CAR_FILL`/`CAR_FILL_HIGH`
became silently-discarded sixth arguments. This one had NOT been caught by
the file-by-file review that fixed `carshapes.js`'s other call sites, because
that review worked through `drawTread`/`drawRotor`/`drawHoverShadow`/
`makeTools` and never re-read `drawShapeObject`'s OWN two direct calls — the
exact kind of gap a targeted read-and-fix pass leaves and a mechanical scan
does not. **After this, every remaining `glowLine`/`glowPoly` call site in the
whole tree was re-verified with a script, not by re-reading source by eye**:
walk every call, parse its balanced argument list (bracket-and-brace-aware,
so array-literal points and object arguments do not miscount as extra
arguments), and flag any `glowPoly` call whose 5th (`fill`) slot is a bare
numeric literal — the exact fingerprint of this bug class, since `fill` is
always either absent or a colour. Zero remained. `disconnect.js`, `menu.js`
and `jackin.js`'s five `glowLine` calls carried the same stale trailing
argument but were always harmless (`glowLine` has no `fill` slot for it to
land in) — cleaned up anyway, since a dead argument that used to mean
something is exactly the kind of thing worth not leaving behind.

**THE CARGO DRONE'S ROTORS — AND THEN ITS WHOLE HULL — THE ONE PLACE
`shadowBlur` CAME BACK.** `carshapes.js`'s `drawRotor` (shared by the
gunship, cached, and hauler.js's CLAW LIFTER, drawn LIVE every frame of the
lift/lower sequence) draws its spinning blades in `HAULER` — a colour
deliberately kept dim enough that it can never cross `BLOOM_THRESHOLD` even
at alpha 1, because the drone is supposed to read as visibly dimmer than the
car it is rescuing (see hauler.js's own render() comment). With no local
blur and no bloom substitute possible for a colour that dim, a thin
single-alpha spoke re-rasterised at a new angle every live frame had nothing
softening it between angles and read as blinking rather than turning — found
live. Restored a small `shadowBlur` (4) on just the blade stroke first: the
bounding box is a ~22-74px disc regardless of which hull calls it, nowhere
near the canvas-spanning paths this whole phase exists to keep unshadowed.

That fix was too narrow. `HAULER` being unable to cross threshold is a
property of the WHOLE hull, not just its rotor blades — every fill and
stroke on the CLAW LIFTER (the claws, the avionics boxes, the cross-beams)
was drawn in the same colour and lost its glow the same way, which read live
as flat, dark, unshaded fills rather than blinking (a different symptom of
the identical cause). `drawShapeObject` now takes a `shape.localGlow` flag:
when a hull sets it, the WHOLE draw is wrapped in one ambient
`ctx.shadowColor`/`shadowBlur`, set once and left live for every nested
`tools.line`/`tools.solid`/`glowPoly`/`glowLine` call underneath it, because
none of those touch shadow state any more — the same "set it once, let it
ride" trick `scenery.js`'s `neonDashedStroke` already uses for a dash
pattern. Only the CLAW LIFTER opts in (`bossshapes.js`'s own comment on the
entry carries the argument); this is a bounded exception for the one hull
whose colour was chosen NOT to clear threshold, not a reopening of
shadowBlur for the catalogue generally — every other shape's colours were
chosen to bloom on their own.

**GLOW_BLEED (`obstacleshapes.js`), measured**, the same offscreen-canvas/
alpha>40 scan the file's own header has always specified, re-run after every
`shadowBlur` in the file was removed:

| shape | axis | measured reach (px) | old declared (bleed 6/7) | new declared (bleed 3) |
| --- | --- | --- | --- | --- |
| TRESTLE | x (beam) | 29 | 34.7 (bleed 7) | 30.7 |
| TRESTLE | up/down (feet) | 14 | 19 | 16 |
| BARRELS | x | 28 | 33.0 | 30.0 |
| BARRELS | up/down | 22 | 27 | 24 |
| TETRA | x | 39 | 43.2 | 40.2 |
| TETRA | up/down | 35 | 40.2 | 37.2 |
| CALTROP | x | 20 | 25 | 22 |
| SPIKES | x | 87 | 91.8 | 88.8 |
| SPIKES | up/down | 12 | 17 | 14 |

What used to bleed 5-7px past a stroked edge (blur-driven) now bleeds under 2px
everywhere (stroke-width-driven — a join or a cap poking past the nominal
line). `GLOW_BLEED` drops from 6 to 3 and `BEAM_GLOW_BLEED` (7, the trestle's
own outlier under the old blur-driven regime) is retired entirely — folded
into the same constant, since the trestle is no longer the outlier: TETRA's
end-cap strokes are, at 1.8px measured against GLOW_BLEED=3's 1.2px of margin.
The trestle's own lane-fit bound (LANE_WIDTH/2 = 35.75px, see that entry's own
comment) now has ~5.0px of headroom where it once had ~1.0.

**GLOW_PAD (`sprites.js`), measured the same way** across every car shape,
every building shape at a spread of variant parameters, and every node
variant: the worst car (GLIDE) bled 3.3px past its `carShapeExtent`, the worst
building 1.6px, every node exactly 1px (half of `neonStroke`'s own 1.5-2px
line width, which is all a node ever carried). `GLOW_PAD` drops from 18 to 6 —
a real reduction in every cached sprite's canvas size, not just a cosmetic
number: the pad shrinks by 12px on each side of a sprite, so every cached
sprite's canvas is smaller by 24px on both width and height than before.

**The 2D cost.** Two measurement attempts here, reported honestly because the
first one didn't work. A whole-`render()` before/after comparison (a second
worktree checked out at pre-15d-ii `main`, `performance.now()` wrapped around
the same `render(alpha)` call in both, `preview_start` used for both tabs —
see the profiling-trap note above) came back statistically inconclusive:
random per-run differences in how much traffic and how many buildings a given
run happened to have on screen dominated the sub-millisecond total, which
this project's own `Rendering performance` section already documents as
"flat in object count" and under 1ms — too small a total, and too noisy a
comparison, to resolve a few hundred microseconds of savings inside it.

The isolated, reproducible number instead replicates the EXACT experiment
`neonStroke`'s own header has always cited (a full-height barrier path,
`performance.now()` around the draw, batched enough draws per sample to clear
this environment's coarsened timer resolution): **one plain stroke measured
~89us, matching the historical "~90us for the same stroke unshadowed" almost
exactly; the old three-pass overdraw measured ~248us**, close to the
historical ~215-217us. `shadowBlur` itself did NOT reproduce its historical
~865us in this environment (measured ~89us, indistinguishable from the
unshadowed stroke) — consistent with this project's standing finding that
GPU/compositor-accelerated effects are not trustworthy to measure through this
sandbox's remoted browser pane, joining `gl.readPixels`-forced-sync in that
category rather than the "CPU side is trustworthy" one. The three-pass number
matching history closely is what makes the one-stroke number trustworthy too:
**~89us against ~248us is a ~64% reduction per `neonStroke` call**, and that
saving now lands on every one of the 59 call sites this phase collapsed.

**PHASE 15E-II-A: THE FADE-HALO DEFECT, AND THE SOFT KNEE THAT ANSWERS IT.**
15d-ii's collapse (above) lost a property the three-pass overdraw used to give
for free — an `alpha` fade kept the halo's relative weighting the whole way
down, because every pass scaled together. Bloom's threshold does not have one
to give: glow/core ratio is `1 - uThreshold/(alpha*c)`, which is EXACTLY ZERO
the instant `alpha*c` crosses `uThreshold` (0.55) from above, so a
full-saturation fragment loses its ENTIRE halo at 55% alpha and spends the
rest of its fade as a bare stroke — on `drawWreck`'s shell (0.75s), the ratio
is 0.45 at t=0, 0.21 at t=0.5 and exactly 0 by t=0.625, so the last ~38% of
the shell's life is glow-free. Four options were weighed (soften the
threshold's knee; lower `BLOOM_THRESHOLD`; fade by GEOMETRY instead of alpha,
which is the real fix but is inherently per-effect; accept it) — the full
argument, costs and the algebra live in `engine/neon.js`'s `neonStroke`
header, next to the sentence 15d-ii's collapse orphaned. **A soft knee
shipped**: `BRIGHT_FS`'s subtractive threshold (`gl/shaders.js`) gained
`softKnee`, a quadratic ramp of width `BLOOM_KNEE` (0.08) that meets the old
linear shape continuously in value and slope, entirely ABOVE `uThreshold`
rather than straddling it — the self-test's `uThreshold >= 1.0` forces every
tap to exactly 0 for ANY knee width (the proof only needs the floor to sit at
`uThreshold`, never below it), and 15c-i's four-taps-before-the-average parity
argument is untouched, since it only requires identical per-tap treatment, not
any particular shape of it (re-verified: a saturated channel's four-tap value
moved from 0.225 to 0.205, flat across both row parities either way). **This
does not fix proportionality** — the ratio still reaches exactly zero at
`alpha = uThreshold/c`, so a saturated fragment still goes fully bloomless at
the same 55% alpha it always did. What it buys is narrower: the last sliver of
glow above that line now fades IN gently instead of snapping to full linear
contribution the moment it clears the line, so there is no visible "pop" at
the edge of the halo, even though the edge itself has not moved. The real fix
— proportional fade by geometry — is **15e-ii-b**'s job once this baseline is
in (see the roadmap below). `BLOOM_EXPOSURE` moved 4.0 -> 4.4 alongside it,
solved rather than eyeballed: the knee costs a flat `BLOOM_KNEE/2` (0.04) off
every saturated channel's bright-pass contribution, and 4.4 is the exposure
that restores the OLD peak composited halo intensity for a saturated thin line
almost exactly (0.5934 old vs 0.5942 new, computed) — confirmed live against a
busy gameplay scene, where buildings and barriers read the same thickness of
halo as before the knee.

**TWO BLOOMLESS GAPS CLOSED IN THE SAME PASS**, found by checking every
palette entry's peak channel against 0.55: `game/exhaust.js`'s outer wisp
(`WISP_ALPHA` 0.35 -> 0.65 — `PLAYER_THRUST`'s peak channel, R at 1.0, never
composited past 0.35, so the plume's soft outer edge never bloomed at all;
0.65 clears it with the same margin `SHIELD_ORB_ALPHA` was given, and goes
briefly bloomless at the bottom of its own flicker the same way the shield
ring does at the bottom of its breath) and `HAULER` (`#197c88`, peak channel
0.5333, 0.0167 under 0.55 at this threshold) — re-examined and left alone:
`bossshapes.js`'s `localGlow` exception exists because the CLAW LIFTER's hull
colour is chosen NOT to clear bloom, on purpose, so it can close around the
car it rescues without the two cyans merging (`hauler.js`'s own `render()`
comment). Closing a 0.0167 gap would mean spending exactly the margin the
colour was chosen for. `player.js`'s `SHIELD_ORB_ALPHA` comment — the one
place in `src/game/` that still quoted bloom's OLD 0.75 threshold — is
corrected to 0.55; the constant itself (0.85) is unchanged, since it already
clears the new threshold with room to spare and nothing about this phase gives
a reason to retune an already-shipped, already-verified look.

**PHASE 15E-II-B RESOLVES THE FADE QUESTION THIS SECTION LEFT OPEN — AND WIDER
THAN "RESOLVES".** The proportional-fade job named above shipped, but as a
re-authoring rather than a retune: every effect in `game/effects.js` that used
to fade by alpha now fades by GEOMETRY, a field of small shapes (squares for
an object's silhouette breaking apart, circles or triangles for a pulse of
energy) shrinking to a point at constant alpha, never touching
`BRIGHT_FS`'s knee at all. `game/effects.js`'s own header has the two new
mechanisms (block shatter, area/line pulse) and which effect uses which;
`engine/neon.js`'s `neonStroke` header has the width trap (why a stroke
narrower than one device pixel is an alpha fade wearing a different hat, and
cannot substitute for a geometric one) and the short list of what stayed
alpha-only on purpose. `player.js`'s shield ring and `drawTargetMark`'s
reticle pulse were not fades to begin with and are covered on their own terms
in the same places. The Phase 15e roadmap entry below has the full account.

### Display scaling

The playfield is **600x800 forever** — a game constant, not a window
measurement, because widening the world would show more road ahead and change the
difficulty of every tuned value. What follows the window is the RASTER, and
`src/engine/viewport.js` is the only module that knows the difference. It keeps
`fit` (how big the game looks), `scale` (how sharp, capped at 2) and `dpr` apart;
its header explains each and why they are not one number.

Two constraints worth knowing before touching it:

- **`scale` moves in eighths, and 8 is derived rather than chosen** — it is
  `gcd(128, 600, 800, 512)`, the tiled dimensions. A scale that doesn't divide
  them leaves tiles at fractional device offsets, which reads as the road
  SMEARING as it scrolls. Change any of those four and recompute the gcd.
  Integer-only scaling was tried first and is the wrong answer; `viewport.js`
  says why.
- **`will-change: transform` is load-bearing on whichever canvas is on screen**
  — 48 dropped frames of 599 unpromoted against 7 promoted. Phase 15a moved the
  promotion to the present canvas and re-took the measurement; on newer hardware
  the gap has closed to nothing, and the rule is kept anyway. `css/style.css`
  carries both figures, the alternatives tried against them, and why `#hint`
  needs `width: 0; min-width: 100%`.

### The gutters

Two DOM panels either side of the playfield: the deck's `SYS LOG` down the left,
a `RIG STATUS` readout down the right. `src/engine/gutter.js` is where they go,
`src/game/telemetry.js` is what they say, and a block in `css/style.css` is what
they look like.

**They are DOM, and that is the whole performance story** — the playfield cannot
grow, and a second canvas would be a full-height surface repainted on the game's
clock. These repaint only when their text changes, and the game loop never
touches them. `gutter.js`'s header covers the recycled row pool, the CSS-mask age
fade, and the out-of-flow positioning that keeps them from colliding with a
canvas sized off `window.innerWidth`.

**Phase 15c takes the trade this section declines, for a different surface.**
The HUD layer (*The present path* above, `#hud`) is exactly "a second canvas
repainted on the game's clock" — the thing a second canvas here would have
been — but it is the right call there and not here: the gutters repaint at
roughly one write a second and DOM diffing is cheap enough to do that with,
where the HUD's numbers change every frame and need Canvas2D's text and blend
primitives, which DOM has no equivalent of. Same question, opposite answer,
because the update rate is different by two orders of magnitude.

Three things about them are design rather than plumbing, and `telemetry.js` and
`engine/console.js` carry the argument:

- **One log, shown in two places.** Every line still enters `console.js`; what
  changes when the gutter is up is only what the in-canvas panel PAINTS. It keeps
  `CRITICAL` and hands the quiet half over — a hull warning stays where the
  player's eyes already are, pickup hints are read between hazards.
- **Three voices.** Routine chatter is reachable only while driving; menus, the
  shop and a pause draw from an idle pool, a finished run from a dead-link pool.
  Printing `hull.integrity 0%` over a wreck is the failure that split prevents.
- **The readouts double as a profiler.** `SIGNAL`, `FRAME`, `BUFFER` and
  `TRAFFIC` are real instrumentation wearing the panel's vocabulary, and `SIGNAL`
  goes amber below 55fps and red below 40 — a performance regression report
  during play rather than behind a devtools panel covering the thing being
  judged.

### The world seed

The city floor is a **pure function of position** — `citygrid.js`'s plots and
lots, `links.js`'s conduits, callsigns and node prices, `sectors.js`'s names,
`drones.js`'s flight lanes. That is what makes it infinite and free: nothing is
generated as the player drives, nothing is freed behind them, no module down
there keeps state. It also used to make it the *same city every run*.

`game/worldseed.js` adds one number to the position each roll hashes, fixed once
per run by `newGame()`. Within a run the pure-function property is untouched — a
lot answers the same the tenth time it is asked as the first — and between runs
the whole city moves. **A seed reproduces its city exactly**, so a world bug
found at one is reachable again by seeding it back.

Two things there are decisions rather than plumbing, and the module header
carries the argument: only the **salt** is shared, while the four files keep
their own copies of the three-line hash they deliberately never shared; and the
salt goes in **inside each `hash()`**, not at the ten seed functions, so a roll
added to a world file later is in this run's world by default. It **defaults to
0, which is the city that shipped before the file existed**, which is what keeps
the invariant suite reproducible — `test/city-floor.test.js`'s measured lot
fractions are seed-0 numbers, and it checks separately that they hold across
seeds and that no layer is left frozen at 0.

## Traffic

The other cars are split so that adding a kind of traffic doesn't mean touching
the simulation:

| file | |
| --- | --- |
| `game/cartypes.js` | **the catalogue.** A type is pure data: silhouette, colours, size, hull, speed band, steering, blast, spawn weight, `minDistance`, and the names of its tactic and driving profile. New traffic = a new entry here |
| `game/carshapes.js` | the silhouettes, 1:1 with the catalogue and pinned both ways by `test/road-and-caches.test.js`. Siblings: `cycleshapes.js` for the bike hulls, `bossshapes.js` for Phase 10's artwork, held outside the pairing until its types exist — hulls graduate OUT of it one at a time as types are written for them (the siege mortar, then the gunship, then the bunker trailer) |
| `game/behaviours.js` | the manoeuvres. A tactic sets only INTENT (`targetOffset`, `targetSpeed`); `traffic.js` integrates it under the type's limits, so a rig can't corner like a roadster and the physics stay in one place |
| `game/driving.js` | the driving **profiles**: the numbers behind a tactic — following distance, patience, lane discipline, how much hull a driver will accept spending |
| `game/traffic.js` | spawning, driving, dying, retiring, drawing |
| `game/collisions.js` | ramming: the only place cars push each other around |
| `game/effects.js` | wrecks |

**Shape carries identity; colour carries only faction** (red hostile / amber
civilian) and weight class, so shades repeat across types. The faction now
SUPPLIES that colour rather than each entry restating it: `cartypes.js`'s
`FACTION_LIVERY` fills in `color` and `thrust`, and an entry names either one
only to break the rule — two do (the rig and the bus, whose deep exhaust glow is
what marks the heaviest traffic once the chassis colour cannot). The one
silhouette shared with the player is given to an enemy — your own outline in red
reads as a rival.

`behaviours.js`'s tactic table lists every manoeuvre with a one-line summary,
including what the compositions (`duel`, `strafe`, `outrun`, `strew`, `patrol`)
compose. Its header explains why a tactic may be stateful, and what the three
stages — tactic, reflex, arms — run in that order for.

### The air

One type in the catalogue is not on the road. The **gunship** carries
`airborne`, and that flag says exactly one thing — *this body is not in the road
plane* — which four systems each read once to say what it costs:

| | |
| --- | --- |
| `traffic.js` | out of the ramming solver and off the tarmac clamp; mirrors the flag onto the body for the two below |
| `behaviours.js` | no hazard reflex — it flies over mines rather than round them |
| `projectiles.js` | **no round may reach it but a SEEKING one** |
| `collisions.js` | `inBlastPlane`, which the three blast sweeps ask |

The third is the point. A straight round buries itself in a barrier at road
level and a tracking round holds the lane it was fired up, so neither ever
leaves the road plane; only the rocket climbs. That makes the rocket the one
answer to the air, and it is a rule about ALTITUDE rather than about lateral
position — a shot flying low enough to hit a barrier cannot hit something in the
air above it, wherever it happens to be standing. Letting the gunship be shot at whenever
it drifted over the tarmac was the obvious alternative and is wrong for exactly
that reason.

**The altitude is in the DRAW ORDER, not in a shadow.** `Traffic` draws in two
passes — the road plane, then the air — and `main.js` puts the bullets and the
player's own car between them, so a gunship visibly has the whole road passing
underneath it. That matters because a tracer drawn *over* the thing it cannot
hit reads as a bug rather than as height. The hull therefore carries
`hover: { blot: false }` and draws no ground mark at all: at 70px square the
mark landed inside its own rotors, and the layering says it better anyway. The
ground mark that other hovering hulls still draw is an instrument — a hollow
ring, a cross and a dashed leader — rather than the translucent-black ellipse it
used to be, which was the only photographic element on a screen that is
otherwise entirely a deck's wireframe.

The rule is symmetrical: nothing on the road reaches the air, and the gunship
carries no death blast, so there is no exception to learn in either direction.
`weapons.js`'s ROCKET anticipated this before the type existed and said the air
content would opt in for itself; `airborne` is that opt-in.

Its encounter (`airstrike`) opens at DIST 1000 and runs ~2.5 times per 1000
after that — the catalogue's heaviest `weight`, and a measured one: the entry's
own comment carries the sweep it was picked from. Two figures underneath it are
the ones to keep true. It must never open before the ROCKET+ crate does, since
an enemy only one weapon can answer must not arrive before the player can have
that weapon (`test/events.test.js` pins it); and its `duration` of 80 is ~13
seconds at the player's ceiling, against a measured ~2-second kill for someone
who actually has rockets loaded. That gap is deliberate — it is the room to
notice it, switch weapons and wait for a shot, or to simply survive it.

### Ramming

`game/collisions.js` resolves a flat list of BODIES with no notion of who is the
player, so the same rules cover the player shunting a sedan, a rig rear-ending a
roadster, and the pile-up after. Both bodies move and take damage split by
INVERSE mass; chains fall out of running the pair sweep several times per tick;
blasts chain the same way and terminate because each car detonates once.

An IMPACT is an arrival, and the solver remembers which pairs were touching last
tick in order to say so. Contact that merely persists is pressure: it pushes,
without the bounce, without a second hull bill, and without being able to force a
body under the `speedFloor` its own engine is holding — what the floor refuses is
handed to the car in front. That rule is what stops one heavy car parked in front
of you from quietly cancelling an OVERDRIVE's raised floor. See `rearEnd`.

The body
interface at the top of that file is what anything rammable later — a barrel, a
boss — implements instead of editing the solver. The one thing that opts OUT is
an `airborne` body, which is never handed to the solver at all: mass makes a
thing hard to shove, absence makes it unreachable, and unreachable is what
altitude means. See The air above.

The one thing not in that file: the solver has no idea the player can die. Zero
hull is `main.js`'s business, and the wreck, the banked run and the deck's
closing sequence all hang off that one transition.

### Distance, and the spawn gate

The simulation measures the road in **world units** — roughly one per pixel — and
that is what every coordinate, spawn margin and blast radius is written in. It is
*not* what the player sees: the **DIST** readout divides by `road.js`'s
`DIST_UNITS` (100), because raw units reach five figures inside a minute. `DIST
50` is 5,000 world units driven.

That readout is a unit the design speaks in. Every entry in the spawn catalogues
carries a **`minDistance`** in DIST-readout units, so "the enemy turns up at 100"
means the number on the HUD. Cars are staged across the whole run — sedan and van
from the first metre, the cycle at 100, up to the rival at 1000 and the hypercar
at 1600 — so the catalogue a player meets early is not the one they meet late.
Obstacles are all `0` today; the field is there for when one should be held back.

The gate **reweights** the draw rather than re-rolling until something passes, so
the opening road is as busy as any other stretch — just made of two kinds of car.
Rejection sampling would have thinned it, which is the opposite of what a quiet
start should feel like. `cartypes.js` has the full reasoning, including why
enemy-laid mines are not gated.

**`cartypes.js` exports `FOCUS`, and it ships empty.** Set it to a list of type
ids and only those reach the road, which is how one profile gets watched without
the rest of the catalogue in the way. It is an override on the same gate the game
ships with rather than a filter of its own, so a focused road is still a road the
real spawner built. The first test in `test/hazards.test.js` asserts it is `[]`,
because "`van` never appeared" is a much worse error message than "`FOCUS` is
still set".

### Driving profiles

A car type names **two** things: a tactic (which manoeuvres it knows) and a
driving profile (how boldly it runs them). Everything a driver might feel about
the road used to be hard-coded in `behaviours.js`, so two civilians naming
`overtake` drove identically and telling them apart meant writing a second
function. Now it is a data table in `driving.js`, and a new car type is usually no
new code at all.

Seventeen types name sixteen profiles, and the near-miss is the point: a profile
is a driving STYLE, so a type gets its own only where it actually drives
differently.
The van and the bus share `hauler`; anything naming none falls back to `commuter`,
the reference every other table is described as a difference from.

The sedan and the roadster are the demonstration — same tactic, so every
difference between them comes out of the profile and nothing else. Over 15
car-minutes of headless road the sedan sits **2.1px** from its lane centre against
the roadster's **18.1**, and commits **1.0** pass per car-minute against **10.7**.
`driving.js` has a row per profile and what each field costs; three of them
(`nerve`, `contact`, and a careful driver's refusal to hit anything) are quantised
in ways that make settings silently equivalent, and its header spells out the
traps. `nerve` (what a driver will drive THROUGH) and `contact` (who it will
lean on) are independent: `contact` used to default to `nerve`, which compared a
hazard's threat against a hull cost and handed four hostiles a ceiling nobody
chose. Every profile now states both, and every hostile states `contact: 0` —
the enemy's aggression is its weapons, not its shoulders.

The preferences also add up to a **lane gradient**: the slow haulers want the
lanes by the barrier and the fast machines the lanes by the centre-line, so
choosing a lane becomes a choice about what you will meet in it. That relation is
asserted in the test suite, because a retune that puts a rig in the fast lane
breaks nothing — it just quietly stops making sense.

**Two speed bands, not one.** `cruiseMin`–`cruiseMax` is what a type rolls at
spawn and wanders within — how it drives when nothing is happening to it.
`speedMin`–`speedMax` is what it is physically capable of, and it contains the
cruise band at both ends. `traffic.js` applies both bounds once per tick after
every behaviour has spoken, so nothing can reach outside it: not the tactic, not
braking behind another car, not slowing to fit a swerve past a roadblock, and not
a chase. Which band a caller reads follows from what it is doing — spawning and
wandering are cruise; passing, holding station, fleeing and chasing are
capability.

`speedMax` is therefore the SINGLE answer to how fast a car can be driven, for
any reason, **including how fast it chases**. Driving profiles used to carry a
second, lower chase ceiling of their own (`chaseSpeed`); it was removed, because
how fast a car can chase is a fact about the car, and a shared profile stating it
put the figure where nobody tuning that car would look. `driving.js` keeps the
reasoning.

Each gap is a design surface. Below, `speedMin`–`cruiseMin` is what the player
buys by slowing down: it decides whether braking sheds a type. Above,
`cruiseMax`–`speedMax` is what a car has left when it is trying, and most types
ship with it CLOSED. The stocker and the bruiser open theirs, so that a car whose
job is closing on the player has something to close with that its cruise band
would not give. Opening it also lets `passEffort` start meaning something for
that type alone.

Read against the player's own 620, that one number is also the answer to "can I
drive away from this?" — the stocker at 600 slips back, the interceptor at 620
holds its gap without shedding, and the rival at 650 and the outrider at 660 gain
on a player flat out in clean air. Those last three are chased down by the
traffic and the corners, or shot.

The cruise band is pinned to both ends of the player's own 100–620:

| | cruise | floor | |
|---|---|---|---|
| rig | 180–215 | 0 | the slowest cruise — well above the player's minimum |
| bus | 190–230 | 0 | |
| van | 205–265 | 0 | |
| sedan | 215–290 | 0 | the widest range: civilians are a spread of ordinary drivers |
| bruiser | 280–330 | 0 | no gun, no mines: closes to ram, or blocks ahead and brakes |
| muscle | 310–360 | 0 | the heavy civilian that leans on people |
| stocker | 355–415 | 0 | the quick heavy: being ahead of one is not an escape |
| interceptor | 400–620 | 0 | |
| outrider | 400–660 | 200 | |
| roadster | 430–560 | 0 | sits just under the player's ceiling |
| gunship | 580–660 | 0 | airborne, so only the rocket reaches it |
| rival | 580–650 | 0 | straddles the player's ceiling — draws level, neither escapes |
| outrunner | 600–670 | 200 | gets past, then fights from in front |
| cycle | 620–730 | 200 | catches a player at full throttle |
| hypercar | 630–700 | 0 | |
| sower | 640–700 | 200 | lays its strip and leaves, and the band is why it can |
| mortar | 640–730 | 0 | the first boss |
| bunker | 640–730 | 0 | the second boss — the mortar's own band, reused |

**Only four types have a floor at all**, and they share one number. A hostile
holds station only on a player it can *match*, so its floor is the speed at which
you stop being holdable — which makes this field the answer to "does braking work
against this type".

- **200** — cycle, outrider, outrunner, sower. One number for the whole
  motorcycle fleet, because it is one physical fact about bikes rather than four
  dispositions: **a bike cannot be ridden at walking pace.** Drop under 200 and
  none of them can hold station on you — the outrider's weave sweeps past and
  loses its firing line, the cycle is forced by with its mine undropped, the
  outrunner and the sower pull away up the road.
- **0** — everything else, hostile and civilian alike. Braking is not an answer
  to the interceptor, stocker, rival, bruiser, either boss or the gunship, which
  is what stops "slow down" being the answer to everything. And every civilian
  still stops dead for a roadblock and still brakes behind a rig, exactly as
  before the field existed.

Two things about those numbers were measured rather than chosen, and both look
reasonable when wrong. **The second group is 0 rather than the player's own 100**
because a hostile attacking from in front has to drive *slower* than the player,
not merely as slow: `outrun` and `siege` overshoot their hold on the way in, and
recovering that means falling back onto the player. Floored at 100 against a
player at 100 the boss could match a crawl and never close on one, so braking
parked it off the top of the screen for good. And **200 is bounded above as well
as below** — a floor breaks a tactic at *every* player speed under it, not only at
the crawl, so a bike floored at its own 600 cruise cannot hold station on a player
doing 380 either. It blows past, and the type stops working at ordinary speeds
instead of becoming escapable at slow ones; `npm run sim` shows it as the
outrunner's and sower's pass rate going through the roof. Both bounds are
asserted.

The floor also decides what a car can dodge. `avoidHazards` slows a car so its
swerve fits in the road left before a hazard, and `hazardStop` stops it dead when
no lane is free at all — a bike can do neither, so a fully blocked road is a
weapon against the bike fleet specifically.

Two consequences worth having on purpose. Dawdling never makes the road go quiet
— it makes the whole city stream past you. And **flat out is not fast enough to be
left alone**: five types come past a player holding 620, so escaping is a job for
the OVERDRIVE crate and the ENGINE ladder, not for the accelerator.

Within a type no two cars drive alike, and none of it costs a sprite — the band is
rolled per spawn, each car wanders slowly around its roll, and an overtaker spends
more while committed to a pass. `traffic.js` has the three mechanisms and why a
wider one-time roll cannot replace the second.

The band's width is not a free parameter: a profile's following rule has to leave
a follower room to stop for every closing speed its own drivers reach, checked per
profile against the fastest type naming it. That is why `hustler` may tailgate
where `commuter` may not, and why pointing a quick type at `commuter` fails the
test.

**`npm run sim` reports what each profile actually did** — lane deviation, passes
committed and completed, time stopped, contacts, hazards struck. Use
`node tools/drivesim.js 300 60` for a tuning decision, not the default five runs:
two identical 20-run batches disagree by ~40% on the rare types, and a 20-run
batch once produced a confident written-up conclusion that 60 runs reversed
outright.

## Special events

Everything staged rather than spawned — a bike gang closing from the mirror, a
blockade, a coned-off worksite, the road narrowing to a slot or weaving through a
chicane, a minefield, twelve bikes at once, the rival's arrival, and the cargo
drone that carries the car to the shop, which turned out to be the same kind of
thing. `game/eventtypes.js` is the catalogue, `game/events.js` the director, and
both headers argue the design at length.

Four decisions carry it:

- **One list, not four systems.** A gang, a blockade, a narrowing, a boss and the
  shop drone are all *something placed on purpose, at a moment chosen on purpose*.
  Written separately they would be four schedulers, four ways of standing the
  ambient road down, and four places to get placement wrong.
- **The director places nothing itself.** It builds requests and hands them to
  the same `Traffic.place()` / `Obstacles.place()` the ambient spawners go
  through, so a staged encounter inherits the clearance tests, the passage rule
  and the road clamp rather than escaping them. That is what makes "narrow the
  road" a safe feature to have at all — nothing here can seal the highway.
- **Distance, not time, drives every decision** — the roll beat, the milestones,
  the cooldowns, the durations. A player dawdling to farm encounters would be a
  bug; a player flat out meeting more of them is the game working.
- **What the road allows is what an encounter gets.** Staged cars have their own
  retire boundary (`traffic.js`'s `STAGED_RETIRE_MARGIN`), which is what buys a
  formation more than one rank — the ambient margin is load-bearing for
  `obstacles.js`'s own spawn margin and was left alone. No staged rank may fill
  every lane, and hazards are placed through the passage rule, so a narrowing,
  a chicane and a car wall all leave a way through by construction.

An encounter turns the ambient budgets down by a multiplier rather than switching
them off, so the road drains over a few seconds instead of blinking out. Staged
and ambient are separate pools, so neither can starve the other. Milestones
**defer, never cancel**, which matters most for the shop: a visit is only ever
late. `test/events.test.js` pins those promises, and
`docs/superpowers/specs/2026-08-27-special-events-design.md` is the design record.

## Money

Two numbers, deliberately kept apart:

| | Score (`game/score.js`) | Credits (`game/wallet.js`) |
|---|---|---|
| lasts | one run | across runs (`localStorage`) |
| floor | none — a massacre goes negative | 0, always |
| earned by | distance + every destroyed car | bounties + siphoned nodes |
| spent on | nothing, it *is* the reward | the upgrade shop |

**Bounties** ride on the car type: every entry carries a `bounty` alongside its
score `value`, enemies pay and civilians fine, and a type with no `bounty` field
pays nothing at all. That is how "not every enemy is worth money" gets expressed
for Phase 10 — by editing the catalogue, not the wallet.

**Siphoning.** The nodes on the city floor (`game/links.js`) are worth credits,
hash-derived from the plot index like the callsign, so a node's name and its price
are both stable facts about that place for as long as the run lasts (the next run
is a different city — see The world seed). There is **one** way to take one: hold the
shoulder on the node's side and it drains, faster the closer you are — no
threshold anywhere in it, so the pickup that feels instant and the one you work
for are the same act at two ends of one curve. **The middle of the road pays
nothing, ever.** Money lives at the edges, next to the barrier, where there is
nowhere to dodge to.

Nothing reads the throttle; what speed decides is how long you stay in range. And
slowing down costs what it always did — the traffic behind you arrives, the
score's distance term stalls, everything hostile gets longer to work on you.

`game/wallet.js` carries the rest: the falloff curve and why it is squared, why
this replaced two mechanics that differed only by whether a node happened to be
lit as you arrived, and the affordances that keep one act reading as one act — the
price on the floor, the `SHOULDER` prompt, the fill meter *every* pickup draws,
the uplink marker on the car, the floating `+25CR` over the spot it came from. The stock
figures there (300px reach, four seconds at the edge, face value) are all raised
by the SIPHON RIG below.

`npm run econ` measures the whole thing headlessly — credits per minute for a
player who hugs the shoulders, one who hunts nodes, one who eases off to stay
beside them longer, and one who never leaves the middle (that last should always
read zero).

## Leaderboard

A shared top-10 board — the thing Phase 13 below was on hold for. Three
`src/game/` modules split it the way `wallet.js`/`walletrender.js` already
split state from ink: `leaderboard.js` fetches/caches/submits and draws
nothing, `leaderboardrender.js` draws the cached list and touches no network,
`nameentry.js` is the three-letter initials screen a qualifying death drops
into (own render path, not a fourth `menu.js` mode — see its header for why).
The board itself is `worker/` — a single Cloudflare Worker over one KV key
holding the whole top-10 array; that module's own header has the shape (one
record per name, no real anti-cheat) and `worker/README.md` has the deploy
steps.

## The upgrade shop

Every 400 DIST a cargo drone lifts the car to a dock (`game/hauler.js`, scheduled
by the event director above). `game/upgrades.js` holds every price, quantity and
tier in the `cartypes.js` data-file style; `game/shop.js` is a cursor, a layout
and a colour scheme over it and owns no numbers of its own. Three shelves.

**Consumables** — hull repair, a shield, and ammunition for each weapon that has a
magazine. A bought repair and a driven-over `FIX` crate are literally the same
event applied by the same code. Guns are topped up by the crate's own quantity;
the mine — the one thing the player lays rather than fires — is rearmed as a
whole set instead, because a "+1" row would be a rounding error on a decision
you walked down a menu to make.
A row that would do nothing — full hull, a full magazine — refuses the sale
rather than take the money for it, unlike a driven-over crate on the road,
which is free either way. The shield has no ceiling of its own to be full
against, so it is rationed differently: once a stop.

**Car systems** — three tiers each, the third costing four times the first, kept
for the rest of the run:

| system | what one tier buys | ladder |
| --- | --- | --- |
| ENGINE | +40 top speed | 620 → 740, clearing the fastest cruise on the road by a hair |
| CHASSIS | +50 max hull, and it repairs by the same | 200 → 350; three tiers is about one mine |
| DEFLECTOR | +12s on *every* shield the car is handed | a 5s crate becomes a 41s one |
| RAM PLATE | +0.8 mass | 1.5 → 3.9: past the bruiser, past the bus, never past the rig |
| SIPHON RIG | more off every node, plus reach and drain to match | 100% → 300% |

Two of those are one row for opposite reasons. The **ram plate** is one row
because mass is one number that buys three things — `collisions.js` splits damage
and separation by inverse mass, so a heavier car hits harder, takes less and gets
shoved around less. Mass alone is capped well short of a real weapon — the ladder
has to stay under the rig's own mass, or ramming would kill the one car the game
promises is unrammable — so the LAST tier also arms two bonuses that don't move
mass at all: hits land at a gentler contact than the shared default asks for, and
a side-swipe throws its target harder into whatever's next to it, more reliably
carrying a hit into a second car. See `collisions.js`'s `PlayerBody` for both.

The **siphon rig** is one row because two of its three numbers
would not sell: `npm run econ` found reach and drain both saturate almost at once,
so yield is the only figure the shelf advertises and the other two ride the same
tier. `wallet.js`'s `SIPHON_YIELDS` header has that argument in full, including why
tier 0 must be exactly the stock car. Its ladder also isn't a flat step like the
four rows above it — `upgrades.js`'s `siphon` entry holds `values: SIPHON_YIELDS`,
the SAME array `wallet.js` pays out of, rather than a restated `base`/`step`; a
retune of one is a retune of both, structurally, after a build once shipped
quoting a shelf figure the wallet no longer paid.

**Specials** — one-off hardware, bought once and owned for the run, so a bought
row reads `SOLD` rather than `MAX`. Each changes a *verb* rather than moving a
number, which is why none of them is a tier: there is no half of "fires two
rounds".

| special | what it does | where it lives |
| --- | --- | --- |
| TWIN CANNON | the cannon fires a parallel pair — same rate, same round | `weapons.js` |
| TWIN RACK | two rockets a press, each seeking separately, so a press into a pack splits | `projectiles.js` |
| SHIELD STORM | the shield arcs into anything that drives close, civilians included | `game/shieldstorm.js` |
| AUTOLOCK | pulling the tracer's trigger designates one hostile ahead at random; every round for the next 3.5s steers to follow it | `game/targeting.js` |
| SPIKE MINES | one press lays the mine *and* a spike belt across it — the middle of the road is a kill, the way around it is a crawl | `game/obstacles.js` |
| SIPHON MEDIC | siphoning a node heals hull 1-for-1 with the credits it just paid, so a SIPHON RIG tier heals more too | `wallet.js` |

They are ownership **flags** and nothing more — `upgrades.js` knows what each one
costs and nothing about what it does; each system reads the flag off
`player.specials` and says for itself what to do with it. The join is a bare
string, so `test/specials.test.js` pins both directions: every flag sold is read
by something, and every claim names a flag on sale. `targeting.js` is worth
reading for how an upgrade like this was kept from becoming "cannot miss" — a
round takes the lateral speed that actually *arrives* (the gap left to cross
over the time left to cross it) up to a **cap**, so what the cap decides is the
range at which a given crossing is possible: the whole road from about 350 units
out, one lane down to about 120, and nothing at all when a car commits to a hard
change late and wide. Rounds also never re-lock when their target dies
mid-burst. The rocket keeps a flat 260/sec because it is doing a different job —
it *hunts*, finding its own targets, reaching the air and carrying splash, where
a tracer round is *aimed* and chases only what the player designated. The pick is made at the TRIGGER rather than by the first round
that connects (`traffic.js`'s `randomHostileAhead`, which skips civilians and
the air), because in a fast fight the car a burst has already hit is usually
dead before the rest of the burst can benefit — designating something the
player has *not* hit is what lets the tracer answer a hostile that never
entered their lane, and what makes it worth carrying against the cannon's
infinite ammunition.

**Nothing survives a run.** The tiers and the specials die with the car exactly as
unspent credits do. Whether the ladder should persist once there is a real bank is
a decision to make then, not one to inherit — see Phase 11d.

Everything is on sale at every dock for now; offering a subset would be a filter
over `SPECIALS` in `shop.js`'s `SHELVES`, with the catalogue unchanged.
## Development roadmap

Work lands via Pull Requests, one phase at a time; each phase leaves the game
playable.

Not every PR is phase work. Building a phase surfaces problems in what is
already there — a barrier that doesn't fit its lane, cars pointing the wrong way
through a bend, a renderer spending most of the frame on two layers that never
change. Those get fixed as they turn up rather than deferred to the polish
phase, so the history interleaves phase features with side-steps into earlier
phases' code.

THE NUMBERS ARE HISTORY, NOT A QUEUE. They are the order things were built in,
and 36 files refer to them from code comments — so an open phase is never
renumbered to move it up. The working order is written here instead.

Currently: **15, then 12, then 10** — the renderer before the polish that would
otherwise be re-tuned by it (15d re-tunes `spread`/`halo` across the whole
catalogue, which IS visual polish, so doing 12 first means tuning numbers 15d
then invalidates), and both before the bosses that would be drawn against them.
Phase 12 keeps the gameplay-balance half; 15d owns the visual half.

**11d and 14 are still ON HOLD; 13 has partly shipped.** All three were
waiting on the same hosting decision, which is now made — Cloudflare Workers +
KV — and Phase 13's first piece, the shared leaderboard, is live on it (see
Leaderboard above). That is not the same as 11d and 14 being unblocked: a
public, account-free KV worker is enough for a leaderboard's write-and-read,
not for per-player persistence (11d needs accounts) or serving ads (14 needs
its own decision regardless of hosting).

- [x] **Phase 0** — Skeleton: neon car steering over a scrolling grid
- [x] **Phase 1** — Road: infinite curving highway + barriers
- [x] **Phase 2** — Surroundings A: simplified box buildings along the road
- [x] **Phase 3** — Traffic: neutral/enemy cars, ramming physics
- [x] **Phase 4** — Combat: shooting, explosions, enemy AI (shoot / mines)
- [x] **Phase 5** — Weapons: multiple weapons + swap pickups
- [x] **Phase 6** — Score/states: scoring, penalties, game-over, difficulty ramp
- [x] **Phase 7** — Surroundings B: richer lit / parallax city, in seven
      sub-phases that each shipped on their own — 7a street network, 7b traffic
      dots, 7c drone air traffic, 7d nodes and markers, 7e links and pings,
      7f sectors, 7g VR framing. The floor reads as a **tactical map** rather
      than as scenery: the driver is jacked into a deck, so the city is symbolic
      blocks, simplified streets, dot-sized cars and signal markers. Two
      approaches were built and rejected along the way (a static "far field"
      tile, a per-district highlight quad) and the per-frame cost was re-measured
      at every step. All of it, including the closing retrospective, is in
      `docs/superpowers/specs/2026-08-07-city-map-layer-design.md`
- [x] **Phase 8** — Audio & juice: wavesynth music, SFX, screen shake, scanlines
- [x] **Phase 9** — Events: staged encounters instead of the steady per-car
      spawn drip — one director on one schedule, over one catalogue. See
      Special events above
- [ ] **Phase 10** — Bosses: named enemies at fixed distance milestones, each
      with its own hull, arms and behaviour, an approach/fight/wreck sequence
      and a payout worth the run. Two pieces are already in place — the artwork
      (`game/bossshapes.js`, held outside the shape/type pairing until the types
      exist; its header says why) and the scheduling, since Phase 9's `at`
      trigger is the boss milestone this phase would otherwise have invented.
      Missing: the types and the behaviour
- [ ] **Phase 11** — Car upgrades & upgrade shop — see The upgrade shop above
  - [x] **11a** — The interlude: a cargo drone lifts the car off the road every
        400 DIST, hands it to a dock screen, and flies it back
        (`src/game/hauler.js`, the `lifting`/`shopping`/`lowering` states)
  - [x] **11b** — The first stock: consumables (hull repair, shield, ammunition
        for every weapon that has a magazine) and tiered car systems — engine,
        chassis, deflector, ram plate, and the siphon rig that followed them —
        as a catalogue in the `cartypes.js` style (`src/game/upgrades.js`) with
        a navigable storefront over it (`src/game/shop.js`) spending
        `Wallet.spend()`
  - [x] **11c** — Specials: one-off upgrades that change a VERB rather than
        move a number — TWIN CANNON, TWIN RACK, SHIELD STORM, AUTOLOCK, and
        SPIKE MINES — sold from a third shelf as ownership flags, each read by
        the system it changes and by nothing else. See The upgrade shop above.
        More are a catalogue entry plus whichever system reads the flag
  - [ ] **11d** — ON HOLD (needs a server — see 13). Persistence, once
        players have records to hold one: turn
        `main.js`'s `CREDIT_STORE` back on and decide, then, whether the
        upgrade ladder persists with the money or stays scoped to a run.
        localStorage would technically unblock this without a server and is
        deliberately not the answer: a ladder that persists per-BROWSER is a
        different design from one that persists per-PLAYER, and taking the
        cheap one now forecloses the other
- [ ] **Phase 12** — Polish: gameplay balance and performance. NOT the visual
      polish — 15d owns that and lands first, or this phase spends its time
      tuning glow constants the renderer swap then discards. High scores were
      the third item here and have moved to 13, since a board worth having is
      a shared one
- [ ] **Phase 13** — Online server. The hosting decision is made: Cloudflare
      Workers + KV. The STATIC half was already DONE — the game is published
      to GitHub Pages, which the no-build ES-module layout reached with no
      special handling, the standing proof that the zero-dependency rule pays
      for itself. The SERVER half's first piece is the shared leaderboard
      (`worker/`, see Leaderboard above): one public, account-free Worker over
      one KV key. That closes the constraint this phase was written around —
      score submission going through something that can sanity-check it, so
      the game is no longer the only thing that knows how a score was earned
      — but a public write endpoint is not accounts, so it does not unblock
      11d's per-player persistence on its own
- [ ] **Phase 14** — ON HOLD with 13 and 11d. Advertisement: consider
      monetising via ads. Decide the
      format first (an interstitial between runs and a rewarded spot in the
      upgrade shop fit the loop; nothing mid-run), then whether it is worth
      the load cost and the third-party script at all
- [ ] **Phase 15** — GPU render path: a WebGL post-processing pass over the
      finished Canvas2D frame — real bloom (bright-pass, downsample, blur,
      additive composite), chromatic aberration, scanlines/vignette — behind a
      flag so it can be A/B'd against the current look. The neon glow today is
      `neonStroke`'s three-pass overdraw: a hand-tuned fake halo with a fixed
      falloff that hugs each stroke. Real bloom bleeds light ACROSS objects and
      responds to brightness. Note this is not a new idea but a substrate
      change — the half/quarter-res glow downsample was built, measured and
      REJECTED (620us against a 434us baseline) because in Canvas2D the
      intermediate full-screen composite costs more than the stroke coverage it
      saves, and that composite cost is exactly what a GPU pipeline removes.
      Deliberately a POST pass first, not a renderer rewrite: it touches no game
      module, needs no SDF text atlas (~39 `glowText`/`fillText` sites across 8
      modules is the trap that makes a full port expensive), and risks nothing
      in the test suite. If it lands, effects and particles can migrate into the
      GPU path incrementally while the HUD, menus and shop stay on Canvas2D.
      The risk that had to be settled first — the per-frame canvas->texture
      upload — is settled: 15a shipped it and it clears (see The present path).
      NOT a performance phase — the 1x frame is ~1ms of a 16.7ms budget; this is
      purely visual ambition, and a full WebGL/WebGPU renderer (which would also
      retire the sprite cache, free per-object rotation and lift the scaling
      constraints above) stays out of scope until the post pass proves the look
  - [x] **15a** — DONE. The present path, looking identical: a WebGL2 canvas in front
        of the existing one, the finished 2D frame uploaded as a texture and
        blitted straight back out with no effects at all. Ships a no-op, which
        is the point — it isolates the two unmeasured costs from the look.
        First is the per-frame `texSubImage2D` of a 1200x1600 canvas (2D and
        WebGL contexts cannot share a canvas, so the upload is unavoidable and
        decides whether the phase is viable at all). MEASURED, and it clears:
        on an Intel Iris Xe — the weak integrated GPU MAX_SCALE above is
        written for — a 1200x1600 RGBA upload plus a full-screen textured draw
        costs ~1047us sustained per frame, and ~259us at scale 1; the two track
        pixel count as a bandwidth-bound copy should (~6.5 GB/s effective).
        Crucially only ~15us of that is CPU SUBMIT time — the cost is GPU-side
        and does not compete with update() on the main thread. That puts the 2D
        frame plus the upload at ~2ms of the 16.7ms budget, leaving ~14.6ms for
        the blur chain. Two traps found re-deriving this, both of which gave
        physically impossible answers first: Chrome ELIDES re-uploading a 2D
        canvas that has not changed, so the source must be dirtied every
        iteration, and gl.finish() is not a sync point on ANGLE/D3D11 — a 1px
        readPixels is. The one number that could not be had from a spike, since
        rAF is throttled in a hidden tab, is the DROPPED-FRAME COUNT under a
        live compositor — obtained by shipping this, and the answer is that the
        GL path drops none the 2D path does not (`engine/present.js` carries the
        three-configuration table and why its headline column is noise). Second
        is that `will-change: transform` on the canvas is load-bearing (48
        dropped frames of 599 unpromoted against 7 promoted — `css/style.css`),
        and this moves the promoted layer to the GL canvas while the 2D one
        stops being composited — so that measurement was RE-TAKEN rather than
        inherited: promoted and unpromoted now measure identically on both
        canvases, and the declaration is kept as a contract rather than as a
        fix. The fallback fell out for free as expected: no WebGL2, or a
        context lost mid-run, and the 2D canvas is shown directly, which is
        today's game exactly — both verified, the loss with
        `WEBGL_lose_context` in a live run, restore included. **THIS FALLBACK
        WAS REAL AND UNCONDITIONAL THROUGH 15C, AND 15D-I RETIRES IT** — see
        that entry below and `gl/context.js`'s header for why. See The present
        path above
  - [x] **15b** — DONE, PROVISIONALLY TUNED. Bloom: bright-pass threshold
        (per-channel subtractive, `BRIGHT_FS`), half- and quarter-res separable
        Gaussian blur (five taps each, the standard linear-sampled fold of a
        9-tap kernel), additive recombine with a tone knee applied to the bloom
        term alone (`1 - exp(-bloom)`, not to the whole scene — see COMPOSITE_FS's
        header for why that split is what keeps 15a's pixel-identity property
        provable rather than merely likely). The whole frame, text included,
        and `GL_PRESENT` is still what A/Bs it. Blurring at reduced resolution
        is what makes this affordable, and is not the rejected Canvas2D
        downsample above — there the intermediate composite was the cost; here
        it is a texture bind. THRESHOLD, EXPOSURE AND THE HALF/QUARTER MIX ARE
        PROVISIONAL — 15d re-tunes them together with `neonStroke`'s halo; see
        The present path above and CLAUDE.md.
        THE SELF-TEST PASSED BIT FOR BIT: with the threshold forced above 1.0,
        the composite reproduced the source frame across all 2,430,000 bytes
        with zero mismatches, verified live via a synchronous `readPixels`.
        ONE REAL BUG FOUND AND FIXED DURING THE WORK: an early draft baked
        15a's CPU-upload Y-flip into the vertex stage all seven draws share,
        which double-flipped every GPU-to-GPU pass in the chain and rendered
        bloom mirrored vertically against its source — obvious on the menu,
        much less so in busy gameplay. Fixed by moving the flip into only the
        two fragment stages that read the CPU-uploaded frame texture; see The
        present path above and `gl/shaders.js`'s `PRESENT_VS` header.
        COST IS UNSETTLED, NOT UNMEASURED: this session's environment (a
        remoted browser pane) showed the readPixels-sync timing method itself
        costing ~7-8ms for 15a's ORIGINAL one-draw blit — a new profiling trap,
        not a regression — so the 15b chain's ~11.4ms by the same method is not
        comparable to 15a's ~1047us desktop-Chrome baseline. CPU submit time
        (no forced sync) stayed low, ~0.3ms for the whole seven-draw chain. See
        The present path above for the full account and what needs re-taking
        on real hardware before the phase's cost is a settled number.
  - [x] **15c** — DONE, AND NOT THE SUB-PHASE THE ROADMAP ABOVE DESCRIBES. The
        text decision wasn't "does text want bloom" — that was answered between
        15b and 15d (yes) — it was that `BLOOM_THRESHOLD`/`BLOOM_EXPOSURE` were
        pinned at their 15b values BY TEXT, not by the world: 15d-ii tried
        0.55/4.0 live, watched it roughly double a barrier's halo, and reverted
        because the same drop bridged HUD letters together. The deliverable
        here is the retune that reversal was blocking, not the split itself —
        the split is only how the retune became possible.
        THE SEAM WAS NOT WHERE THE ROADMAP ABOVE SAID EITHER. "Everything
        before `drawHud()` is world, everything after is chrome" is wrong on
        two counts: `render()` returns early for `menu`/`paused`/`gameover`/
        `shopping` and never reaches `drawHud()` at all, so the busiest text
        screens in the game (the shop's price list, the menu's rows) were
        never touched by that seam; and the real split is LEGIBILITY, not
        draw order — a screen's LARGE display type (the menu's title and rows,
        the shop's header and credit total, `gameover`'s FINAL SCORE) wants
        bloom exactly the way `CYBERCRUISE` always has, while its SMALL dense
        readouts (the HUD proper, the menu's test-row checkboxes, the shop's
        entire shelf) are the same size class as the HUD text that bridged and
        move with it.
        THE SPLIT: a third canvas (`#hud` — index.html, css/style.css), plain
        2D, transparent, painted on top of the WebGL2 present canvas by the
        browser — NOT a second texture composited in the GPU chain, which was
        the real alternative on the table and lost on 15a's own numbers (a
        second full-frame upload would have roughly doubled the present pass's
        already-dominant cost to buy back a compositor blend `will-change:
        transform` already makes close to free). See `present.js`'s "The HUD
        split" for the full argument and the measured numbers on both sides,
        including what the rejected path would have cost. Everything dense
        (`drawHud()`, the menu's test rows, the shop's shelf) draws there now;
        everything large-and-sparse stays on the bloomed canvas. Three
        overlays that used to guarantee covering the HUD by DRAW ORDER on one
        shared canvas (`disconnect`/`jackin`/`hauler`'s `renderOverlay`) had to
        be re-derived for two canvases: only CANVAS ORDER can guarantee that
        now, so all three moved to `#hud` too, trading their bloom halo for a
        guarantee that was the actual point — `glowText`'s own `shadowBlur`
        (never part of 15d-ii's ban, which was about canvas-spanning paths and
        cached sprites) keeps them from going dark. `sectors.renderGlitch` and
        `jackin.render` were left alone on purpose: both `drawImage()` the
        frame back onto itself and must keep pointing at the canvas that is
        actually bloomed. (`jackin.render` no longer exists — 15e-i moved the
        whole of it into the present pass. `sectors.renderGlitch` still does
        exactly what this paragraph says.)
        THE RETUNE: `BLOOM_THRESHOLD`/`BLOOM_EXPOSURE` move to 0.55/4.0 — the
        exact pair 15d-ii tried and reverted — now that nothing dense shares
        the bloomed canvas to bridge. Confirmed live across a busy gameplay
        scene, the menu and the gameover screen: buildings and barriers gained
        a visibly thicker, richer halo without washing into flat blobs, and
        every readout on `#hud` stayed crisp throughout. `present.js`'s header
        has the full account, including a readPixels scan through a barrier
        cross-section corroborating (not re-deriving) 15d-ii's own "roughly
        doubled" finding.
  - [x] **15c-i** — DONE. THE BRIGHT PASS SAMPLED HALF THE FRAME'S ROWS, and
        the retune above is what made it visible: reported as building edges
        flickering at speed. One NEAREST tap into a half-res target works out
        to reading only the ODD rows, so a 1px bright horizontal line — a
        building's roof outline — had a halo on the frames where it landed on
        an odd row and none on the others, alternating at up to 30Hz as the
        floor scrolled. Not a 15c regression and not a 2D-layer problem: the
        aliasing shipped in 15b, 15d-ii made the edges 1px by collapsing
        `neonStroke`'s overdraw, and 15c's stronger halo is what raised the
        blink out of the noise. Only HORIZONTAL features show it, because only
        y scrolls. Fixed by taking FOUR taps and thresholding each BEFORE
        averaging — parity-invariant by construction. See The present path
        above for the measurements, including why the cheaper LINEAR fetch
        looks equivalent, is not, and silently deletes thin lines' halos
        instead. Pixel-identity re-verified (0 differing channels with the
        threshold forced to 1.0); 2 frames over 17ms in 600, mean 16.69ms, so
        the three extra fetches cost nothing measurable.
        MEASURED, NOT ASSUMED, per the trade the gutters declined (see The
        gutters below, and `present.js`'s header): the HUD layer's own
        clear-and-redraw cost ~0.72ms mean live (p95 ~1.1ms), and the dropped-
        frame retake (one clean sample — a second attempt hit the project's own
        documented "reloaded-tab rAF throttling" trap and was discarded) landed
        inside 15a's own range with zero missed vsync. The bare-desktop GPU
        re-measurement owed since 15b is STILL owed — this sandboxed pane
        remains the wrong place to take it, and 15c does not pretend otherwise.
        A line went into `present.js`'s header on the pixel-identity self-
        test's own blind spot too: it is a same-frame diff, so it cannot see an
        orientation bug (exactly the class 15b's own Y-flip bug was), which
        matters more now that 15e is about to add further GPU-to-GPU passes.
        `npm test`: 738 on `main`, plus two updated test files
        (`test-options.test.js`, `shop-screen.test.js`) whose `render()` calls
        now pass a second recording context for the HUD canvas — no assertion
        logic changed, only the call signature
  - [x] **15d** — DONE (both sub-phases). Collapse the fake halo: `neonStroke` strokes every path THREE
        times — wide and faint, mid, bright core — purely because `shadowBlur`
        was unaffordable (865us shadowed against 217us layered for one
        full-height barrier), and with bloom doing the halo per-pixel that
        collapses to ONE stroke. Two PRs, in that order, with the same
        argument 15a was built on behind the split — isolate the substrate
        from the appearance, so a regression has one possible cause — mattering
        more here, since 15d-ii alone touches 12 game modules and can move
        gameplay numbers
    - [x] **15d-i** — DONE. WebGL2 becomes a REQUIREMENT: the fallback that
          carried the game through 15a-15c (a machine without WebGL2, or one
          that loses its context mid-run, shown the 2D canvas directly) is
          retired. A machine without WebGL2 is told it cannot run the game — a
          `#gl-notice` DOM overlay (`index.html`/`css/style.css`), plain
          markup rather than anything drawn, since the thing that would draw
          it is exactly what is missing — and never starts the game loop
          (`main.js`'s `glReady` gate). A context lost mid-run shows the same
          overlay with a different message, freezes the run (a new `gpulost`
          frozen state in `main.js`'s state machine, entered asynchronously
          from `present.js`'s `onLost`/`onRestored` rather than from any
          player action — see that state's own note in `main.js`'s header for
          why it is the odd one out among the frozen states), and resumes on
          its own the moment `webglcontextrestored` fires. `neonStroke` and
          every other game module are UNCHANGED — this PR is pure substrate,
          reasoned about at length in `gl/context.js`'s header (the reversal
          and why 15d-ii's stroke collapse is what forces it) and
          `present.js`'s (the notice, the pause, and `GL_PRESENT`'s narrowed
          meaning — it now A/Bs bloom against a plain blit, both through
          WebGL2, rather than A/Bing the GPU path against the 2D canvas — see
          its own comment in `testoptions.js`). NO VISUAL CHANGE ON A MACHINE
          WITH WEBGL2: the `GL_PRESENT`-on chain in `present()` is the same
          code, executed the same way, as before this PR — the only new
          branching is the `!GL_PRESENT` blit path and the failure handling
          around it, neither of which the default configuration takes — so
          this is pixel-identical BY CONSTRUCTION rather than by a fresh
          `readPixels` diff against `main`; confirmed live end to end (menu,
          boot, gameplay, screenshotted) rather than only by reading the diff.
          BOTH FAILURE PATHS VERIFIED LIVE, not by reasoning: `WEBGL_lose_context`
          forced mid-run showed the amber "GPU CONNECTION LOST" notice, froze
          the world, and `restoreContext()` rebuilt all four programs and
          targets and resumed exactly where the run left off. Simulating "no
          WebGL2" by patching `getContext` and calling `present.js`'s real,
          already-loaded `init()` against the live `#gl-notice` DOM showed the
          red "WEBGL2 REQUIRED" notice and `init()` returning false. ONE BUG
          FOUND AND FIXED BY THIS LIVE CHECK, not by review: `.gl-notice`'s
          own `display: flex` is an AUTHOR rule and beat the browser's UA
          `[hidden] { display: none }` regardless of source order, so the
          notice was covering the cabinet at ALL times, hidden or not, until
          an explicit `.gl-notice[hidden] { display: none }` was added —
          without the live check this would have shipped as a permanently
          blank cabinet on every machine, including ones with WebGL2.
          `test/present.test.js`'s three fallback-era tests are now tests of
          the failure behaviour instead — the notice text and the `fatal`
          class, not a class-based 2D/GL swap
    - [x] **15d-ii** — DONE. The payoff: `neonStroke`'s three strokes collapse
          to one at all 59 call sites (`engine/neon.js`), and the same argument
          retires the `shadowBlur` baked into the sprite cache
          (`carshapes.js`/`buildingshapes.js`/`obstacleshapes.js`/
          `pickupshapes.js`'s `glowLine`/`glowPoly` calls, now shadow-free —
          see neon.js's header — bar ONE deliberate exception: the cargo
          drone's hull opts back into a local shadowBlur via a new
          `shape.localGlow` flag, because its colour is chosen to sit below
          bloom's reach on purpose — see *Rendering the halo* below) and
          `glowOrb`'s radial gradient (`player.js`'s shield, now a single
          additive ring — see its own header for why a ring rather than a
          filled disc, which would wash the wireframe out under it exactly the
          way the gradient's dimmed centre stop existed to avoid). `spread` and
          `halo` are GONE from `neonStroke`'s signature rather than becoming
          bloom parameters under a different name — there is no longer an
          overdraw for them to shape. `BLOOM_THRESHOLD`/`BLOOM_EXPOSURE` end
          this PR AT their 15b values (0.75/3.0), but not because the first
          pass of verification caught everything — it didn't, and *Rendering
          the halo* above tells that part straight, in full: FOUR real bugs
          shipped past this PR's own review and were found only by a person
          actually driving the running game — the shield ring bloomless (a
          low-alpha steady-state element the "does full-alpha geometry look
          right" check never exercised, fixed in `player.js`); a
          `glowLine`/`glowPoly` signature bug in `pickupshapes.js` (crates
          flickering toward white, `ctx.fill()` called with a stray number as
          `fillStyle`); the IDENTICAL signature bug on `carshapes.js`'s OWN
          chassis-fill call — every car and traffic type's main body fill,
          found only by re-reading the file after the pickup fix, not by the
          original review; and the cargo drone's whole hull losing its glow,
          not just its rotor blades, once its deliberately-sub-threshold
          colour met a shadowBlur-free `drawShapeObject`. Every
          `glowLine`/`glowPoly` call site in the tree was re-verified by
          script afterward (parse the argument list, flag any `glowPoly`
          whose `fill` slot is a bare number) rather than trusted by eye a
          second time. Pushing `BLOOM_THRESHOLD`/`BLOOM_EXPOSURE` stronger
          was also tried, live, and found to trade text legibility for world
          intensity with no way to have both through one global pass over the
          whole frame — that split is Phase 15c, not built; reverted.
          MEASURED, NOT GUESSED, per the
          file's own standing rule: `obstacleshapes.js`'s `GLOW_BLEED` (which
          feeds hazard `extent` and therefore lane fit) shrank from 6 (a 7px
          outlier for the trestle) to a single 3, and `sprites.js`'s `GLOW_PAD`
          from 18 to 6 — both re-run through the offscreen-canvas/alpha>40 scan
          the two files have always specified, with the before/after table in
          *Rendering the halo* above. The 2D-layer cost measurement is there
          too, including the one that didn't work (a noisy whole-`render()`
          A/B) and the one that did (the same isolated `neonStroke` experiment
          the module's own header has always cited: ~89us for one stroke
          against ~248us for the old three-pass overdraw, a ~64% reduction per
          call, `shadowBlur` itself unmeasurable in this environment for the
          same GPU-side reason `gl.readPixels` already was). `npm test`:
          738/738, no invariant needed weakening — the new constants were
          chosen with enough margin (TETRA's ~1.2px being the tightest) that
          nothing the suite already asserted about derived extents or lane fit
          came anywhere near breaking
  - [x] **16a** — DONE. THE DISPLAY TYPE BECOMES LINE ART. Every other thing
        this game draws is a stroked polyline; its type was `Courier New`, a
        1955 typewriter face and the one element on screen that could not have
        come off the same machine as the rest. `src/engine/vectorfont.js` is
        the alphabet — polylines on a 0..0.72 x 0..1 cell, chamfered rather
        than curved, the letterform a vector arcade machine could actually
        trace — and `vectorText`/`segmentMeter` in `engine/neon.js` draw from
        it. Data in a catalogue, no font file, no build step, no dependency.
        THE MENU IS THE WHOLE SCREEN, in all three of its modes (start, pause,
        gameover share one render — menu.js's header): title and subtitle in
        vector type, a perspective floor behind them, and `gameover`'s FINAL
        SCORE / CREDITS EARNED converted with them, since those two sit
        between the subtitle and the rows and would otherwise have been the
        one place the two faces are read against each other.
        THREE THINGS CHANGED BEYOND THE FACE, each because the new type
        exposed them. **Row 0 is CONNECT / RECONNECT**, not START GAME /
        RESTART: the game's own fiction is an uplink to a car (`jackin.js`,
        the HUD's UPLINK STABLE, and `CONNECTION LOST` as the gameover
        subtitle), so RECONNECT is the line that subtitle asks for. Pause
        keeps CONTINUE — nothing was dropped there. **Row 0 sits apart from
        SOUND/MUSIC and is set larger**, because it is the only row that
        leaves the screen; even spacing and one size read as "pick one of
        three". `rowY()` is now the single place row geometry is derived, so
        what is drawn cannot drift from what `barRect` hit-tests. **The volume
        rows lost their percentages** for segment meters whose segment count
        is derived from `VOLUME_STEP` — one segment per keypress, so the meter
        is the level counted out rather than an approximation of it.
        SELECTION IS A PAIR OF CHEVRONS rather than a `"> "` prefix: a prefix
        inside a centred string shifts the label sideways when the cursor
        lands on it, so every row twitched as the cursor passed.
        `test/vectorfont.test.js` pins the parts that fail silently — coverage
        of every string `menu.js` actually renders (it exports them, so a
        renamed row is checked rather than a second copy drifting), the cell
        bounds every metric assumes, and the meter's one-segment-per-keypress
        arithmetic. A missing glyph draws NOTHING by design; the test is what
        makes that safe.
  - [x] **15e-i** — DONE. The jack-in and the disconnect re-authored as ONE
        fragment pass (`GLITCH_FS`), replacing the Canvas2D machinery both
        modules used to fake it with — `jackin.js`'s VOID mask, band-tear loop,
        scanline wash and whole-scene chromatic split (and with them the
        codebase's only device-sized scratch canvas), `disconnect.js`'s
        full-width tears and dim-to-black. **Both timelines are unchanged to
        the number**; only what draws them moved. See *The present path* for
        the design, the uniform channel that replaced "no module under
        `src/game/` knows the GPU path exists", the idle no-op proof and the
        two bugs the self-test and a live capture caught.
        **CRT SIMULATION WAS PROPOSED BY THIS ROADMAP AND REJECTED BY THE
        PROJECT OWNER** — the line above used to read "chromatic aberration,
        vignette, heat shimmer, scanlines", which are all one idea (a screen
        being photographed) and the wrong one: the game's fiction is a SIGNAL
        you are jacked into, so the vocabulary is packet loss, block
        corruption, quantisation collapse and desync. Recorded here because
        the rejected list is the sort of thing that gets re-proposed by
        somebody reading an old roadmap.
        ALSO GONE, on the same call and for the same reason: the car's own
        assembly and breakup stages (`effects.js`'s `drawChromaticSplit`, both
        call sites and the function). They do not read under the pass, and
        giving the car its own region in it was built and rejected on sight —
        a hole around the car reads as a cutout, not as data loss. `CAR_START`,
        `CAR_END` and `carSolid` went with them.
        AND THEN THE DEATH'S HIT CORE, once it was the only 2D draw left in
        either sequence and read as a circle closing in rather than as an
        impact — `CAR_GLITCH_END` and `FLASH_END` with it. Neither module
        draws on the world canvas at all now; both are a beat table, an offset
        and a HUD readout. **Every beat that still describes something kept its
        name and its number** — the four that went are exactly the four whose
        effects were removed
  - [x] **15e-ii-a** — DONE. **THIS RENAMES THE SLOT**: through 15e-i, "15e-ii"
        meant hull-driven data corruption (still true of its own entry below,
        renumbered **15e-iv** to make room) — this PR claims the `-a` under it
        instead, because the defect it fixes sits directly under 15e-ii-b's
        per-effect pass and had to be settled first or the baseline would move
        under it. **THE DEFECT**: `neonStroke`'s `alpha` fade used to keep the
        halo's relative weighting through the old three-pass overdraw; 15d-ii
        collapsed that to one pass and bloom took the halo over, but never
        re-established the property — `BRIGHT_FS`'s threshold means glow/core
        ratio is `1 - uThreshold/(alpha*c)`, constant nowhere and EXACTLY ZERO
        the instant `alpha*c` crosses `uThreshold`. A full-saturation fragment
        (`drawWreck`'s shell, say) loses its ENTIRE halo at 55% alpha and
        spends the rest of its fade as a bare line — worked through on
        `drawWreck`: ratio 0.45 at t=0, 0.21 at t=0.5, exactly 0 by t=0.625,
        the last ~38% of the shell's 0.75s life glow-free. **FOUR OPTIONS
        WEIGHED** (soften the knee; lower `BLOOM_THRESHOLD`; fade by geometry
        instead of alpha; accept it) — full argument and costs in
        `engine/neon.js`'s `neonStroke` header, next to the sentence 15d-ii's
        collapse orphaned. **A SOFT KNEE SHIPPED** (`gl/shaders.js`'s
        `softKnee`, `BRIGHT_FS`): the subtractive threshold's corner at
        `c == uThreshold` becomes a short quadratic ramp (`BLOOM_KNEE = 0.08`)
        entirely ABOVE `uThreshold` rather than straddling it, so the
        self-test's exact-zero proof (`uThreshold >= 1.0` forces every tap to
        0, for ANY knee width) survives untouched, and 15c-i's parity argument
        survives too — the per-tap value moved (0.225 -> 0.205 for a
        saturated channel) but nothing about WHICH four texels are sampled or
        WHEN they are averaged did. **DOES NOT FIX PROPORTIONALITY** — a
        saturated fragment still goes fully bloomless at exactly 55% alpha;
        what changed is that the last sliver of glow above that line now fades
        IN gently instead of snapping to full linear contribution, so there is
        no visible "pop" at the edge of the halo even though the edge itself
        did not move. The real fix (fade by geometry) is **15e-ii-b**, below.
        `BLOOM_EXPOSURE` moved 4.0 -> 4.4 alongside it, solved rather than
        eyeballed, to buy back the knee's flat ~9% peak-brightness cost so
        established halos (buildings, barriers) read the same thickness they
        did through Phase 15c (`present.js`'s own header has the derivation).
        Two other defects closed in the same pass, both bloom-per-channel
        gaps found by computing every palette entry against 0.55:
        `exhaust.js`'s outer wisp (`WISP_ALPHA` 0.35 -> 0.65, PLAYER_THRUST's
        peak channel never used to clear 0.55 at all) and `HAULER`
        (0.0167 under 0.55 — re-examined and left alone: `bossshapes.js`'s
        `localGlow` exception exists because the hull's colour is chosen NOT
        to bloom, on purpose, so it could clear the car it rescues — closing
        that gap would mean spending the exact margin the colour was chosen
        for). `player.js`'s `SHIELD_ORB_ALPHA` comment, the one place in
        `src/game/` that quoted the OLD 0.75 threshold, corrected to 0.55.
  - [x] **15e-ii-b** — DONE, AND ITS PREMISE CHANGED MID-FLIGHT. This was
        pencilled in as a fade conversion — retune each effect's alpha curve
        into a threshold-free geometric one, judged against 15e-ii-a's soft
        knee. That is not what shipped. Proposed as a Stage 1 mock (a
        throwaway single-file HTML page running the real `present.js`/
        `neonStroke`/bloom chain, current vs. proposed side by side, per this
        PR's own gate), the project owner looked at the destruction family and
        asked for something built "out of the box" rather than a patched fade
        — the fade defect was real, but so was the chance to ask whether the
        pre-15e-ii-b debris vocabulary was still the right one at all, per the
        brief's own invitation. It wasn't, for eight of the eleven effects.
        **TWO NEW VOCABULARIES SHIP, PLUS ONE CARRIED OVER:**
        **BLOCK SHATTER** (`drawWreck`, the three roadblock materials) — an
        object's RENDER fails rather than its parts flying off it: the
        silhouette is sampled onto a small grid (occupancy CACHED per shape,
        never per explosion) and the occupied cells fly outward, shrinking to
        a point at CONSTANT alpha. Squares, deliberately echoing `GLITCH_FS`'s
        own macroblock vocabulary — the game's fiction is already "you are
        looking at a signal", so a destroyed object's picture failing block by
        block is the same category of event as the signal itself failing,
        just local and permanent. The three roadblock materials (trestle,
        tetra, barrels) keep their weight-class distinction entirely through
        block count/size/speed/drag now, not through three bespoke debris
        vocabularies — a trestle sheds many small fast blocks with no flash, a
        tetra sheds few big slow ones with a strong flash, water is the
        IDENTICAL mechanism recoloured green with a slight upward bias per an
        explicit call to keep water on one logic rather than its own. Water's
        old crown/droplet/puddle look, and the lingering puddle with it, are
        GONE — a future lingering-puddle effect is a layer on top of this
        shatter, not a reason to special-case it.
        **AREA PULSE** (`drawMineBlast`, `drawFireballBurst`,
        `drawCollectBurst`) plus its 1-D form **LINE PULSE** (the shield arc)
        — these are energy AT a point (or travelling between two points), not
        objects failing, so the idiom is a WAVEFRONT REVEALING a field rather
        than blocks flying off a silhouette: literally `GLITCH_FS`'s own
        "frontier through a block field" mechanism (`uResolve` sweeping an
        arrival-time field), reused in 2D. A cell not yet arrived is not drawn
        at all; once arrived it flares then shrinks to a point over
        `FLARE_HOLD` of the effect's own life. The pulse's own extent now
        traces the event's REAL radius, which the old hex cage/ragged
        ring/expanding circle never reliably did. `drawCollectBurst` runs the
        identical mechanism INWARD — destruction pushes energy out, taking
        something in pulls it in, one flag's difference. Drawn as circles by
        default (a smooth radiating field); the mine and the shield arc are
        TRIANGLES instead, on request, for a sharper/more electrical material
        — `buildAreaPulse`'s own `mark` option, scoped per effect. The mine's
        old jittering hex cage, lightning arcs and white core are all gone —
        two overlaid triangle pulses are the whole tell now. The shield arc
        now visibly TRAVELS from the shield to the target instead of existing
        complete and fading, with a landing flare timed to its arrival.
        `MINE_BLAST_DURATION` (0.55 -> 0.32) and `COLLECT_DURATION`
        (0.4 -> 0.22) both SHORTENED on top of the mechanism change, live
        feedback that a discharge and a pickup should read as a snap — both
        moves are strictly cheaper at `MAX_WRECKS`' ceiling, not more
        expensive, since a shorter slot frees sooner.
        **THE PLAYER'S SHIELD RING** becomes two wavy, layered rings (two low-
        order harmonics each, drawn "lighter" at the same `SHIELD_ORB_ALPHA`
        scheme already argued correct) instead of one crisp circle — an
        energy BARRIER rather than a wireframe outline, the "blurred" read
        coming from genuine overlap between two independently wavy shapes
        under bloom's own halo rather than from faking a blur with alpha or
        width. `player.js`'s `renderShield` carries the reasoning.
        **CARRIED OVER, ON PURPOSE, NOT AN OVERSIGHT:** `drawTargetMark`'s
        on/off halo blink (straddling `BLOOM_THRESHOLD` once per pulse cycle)
        was examined and left — flagged as likely an accident of the
        threshold moving twice, but changing it was not confirmed as wanted.
        Three white "impact" flashes (`drawWreck`, the fireball, heavy impact)
        stay alpha-only, deliberately: they are punctuation, not fragments
        meant to persist, so going bloomless as they wind down is correct for
        them the way it never was for a fade meant to travel. `engine/neon.js`'s
        `neonStroke` header carries the full account of what shipped, the
        three exceptions, and THE WIDTH TRAP (why thinning a stroke is an
        alpha fade wearing a different hat, and cannot substitute for a
        geometric one) — recorded there for the first time, as this PR's
        acceptance required. **TIER C (a positional hotspot in the feed
        channel) WAS NOT PROPOSED OR BUILT** — nothing here needed the
        channel to know WHERE an effect is; every mechanism above carries its
        own position already. **TIER B (a feed-channel punch on a big
        detonation) WAS PROPOSED EARLY AND NOT CARRIED FORWARD** once the
        out-of-the-box direction landed on block shatter/area pulse instead —
        recorded as a live option for a future pass, not built here.
        **THE BARE-DESKTOP GPU RE-MEASUREMENT OWED SINCE 15B REMAINS OWED** —
        this PR did not attempt it either, for the same reason 15e-i and
        15e-ii-a did not: still the same sandboxed/remoted pane.
  - [ ] **15e-iii** — Map visuals: a later step than the effects/fade work
        above, and an earlier one than hull-driven corruption below — not
        further specified yet
  - [ ] **15e-iv** — Hull-driven data corruption on the same axis (renamed
        from **15e-ii**, which 15e-ii-a above now claims): a damaged car
        degrades the FEED rather than flashing a red vignette, writing the
        same `corrupt`/`quant` fields 15e-i already carries, with `main.js`
        taking the larger of the two sources. No new channel needed — that is
        what the field naming in *The present path* was for. Deliberately
        LAST of the visual sub-phases: it runs over whatever the effects/fade
        work and the map visuals above produce
  - [ ] **15e-v** — A background pass: something behind the world rather
        than over it, which is the one shape the current chain has no slot for
        (every stage so far reads the finished frame)
  - [ ] **15e-vi** — Reconsider `sectors.js`'s rescan glitch, the last
        full-screen 2D tear left. Deliberately OUT of 15e-i's scope: a sector
        crossing reads as an event in the world, not a change in your
        connection, so it is not obvious it should share the feed pass's
        vocabulary at all. Verified in 15e-i that a crossing overlapping a
        boot or a death is coherent — the tear is content the feed pass then
        resolves or drops — so this is a look question, not a bug
  - [ ] **15f** — Only if 15a-15e land and the look is worth it: migrate
        effects and particles into the GPU path incrementally, HUD and menus
        staying on Canvas2D. Sprites would become a texture atlas rather than a
        `Map` of canvases, which buys free tinting, additive blending and
        rotation and starts to lift the tiling constraints in Display scaling
        above. Re-authoring the line art itself as GPU geometry — the ~3000
        lines across `carshapes`/`buildingshapes`/`obstacleshapes`/`bossshapes`
        and friends that ARE the game's look, and that `tools/gallery` and
        `tools/car-editor` both draw through a plain 2D context — is where true
        per-pixel neon lives and stays out of scope
