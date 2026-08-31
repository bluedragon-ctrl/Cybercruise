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
for reaching by hand what a normal run makes expensive to reach. Both persist
across a reload and take effect on the next tick.

**`src/testoptions.js` is the switch**: clearing `SHOW_TEST_OPTIONS` (or either
per-row flag) removes them from the menu entirely, and a removed row reads as off
whatever `localStorage` holds. `test/test-options.test.js` pins that the removal
is complete rather than half-wired.

### Asset gallery

A static showcase of the neon assets for iterating on visuals without running the
game: <http://localhost:5173/demo.html>. Add a sprite in `src/game/sprites.js`,
then register a cell in `src/demo/gallery.js` — car types are the exception,
since the gallery walks the catalogue.

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
2. **Never put `shadowBlur` on a path that spans much of the canvas.** Use
   `neonStroke` (`src/engine/neon.js`), which strokes a path several times at
   decreasing width instead — 865µs shadowed against 217µs layered for one
   full-height barrier.
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

Two profiling traps, both of which cost time to rediscover: `getImageData` used
to "force a flush" demotes the canvas out of GPU acceleration and changes what is
being compared, and measuring throughput inside `requestAnimationFrame` silently
floors at vsync and reports a ratio of ~1. Two plausible-looking methods
disagreed by 5x.

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
- **`will-change: transform` on the canvas is load-bearing** — 48 dropped frames
  of 599 unpromoted against 7 promoted. `css/style.css` carries that measurement
  and the alternatives tried against it, alongside why `#hint` needs
  `width: 0; min-width: 100%`.

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

## Traffic

The other cars are split so that adding a kind of traffic doesn't mean touching
the simulation:

| file | |
| --- | --- |
| `game/cartypes.js` | **the catalogue.** A type is pure data: silhouette, colours, size, hull, speed band, steering, blast, spawn weight, `minDistance`, and the names of its tactic and driving profile. New traffic = a new entry here |
| `game/carshapes.js` | the silhouettes, 1:1 with the catalogue and pinned both ways by `test/road-and-caches.test.js`. Siblings: `cycleshapes.js` for the bike hulls, `bossshapes.js` for Phase 10's artwork, held outside the pairing until its types exist — hulls graduate OUT of it one at a time as types are written for them (the siege mortar, then the gunship) |
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

**Two speed bands, not one.** `cruiseMin`–`speedMax` is what a type rolls at
spawn and wanders within — how it drives when nothing is happening to it.
`hardFloor`–`speedMax` is what it is physically capable of, and `traffic.js`
applies that floor once per tick after every behaviour has spoken, so nothing can
reach under it: not the tactic, not braking behind another car, not slowing to fit
a swerve past a roadblock. The ceiling is shared because a car's top speed is the
top of its cruise. The floor is not, and the gap between them is what the player
buys by slowing down.

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
| mortar | 640–730 | 0 | the boss |

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
  to the interceptor, stocker, rival, bruiser, boss or gunship, which is what
  stops "slow down" being the answer to everything. And every civilian still
  stops dead for a roadblock and still brakes behind a rig, exactly as before the
  field existed.

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
are both stable facts about that place. There is **one** way to take one: hold the
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
the dish on the car, the floating `+25CR` over the spot it came from. The stock
figures there (300px reach, four seconds at the edge, face value) are all raised
by the SIPHON RIG below.

`npm run econ` measures the whole thing headlessly — credits per minute for a
player who hugs the shoulders, one who hunts nodes, one who eases off to stay
beside them longer, and one who never leaves the middle (that last should always
read zero).

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
| SIPHON RIG | +20% off every node, plus reach and drain to match | 100% → 160% |

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
tier. `wallet.js`'s `SIPHON_TIERS` header has that argument in full, including why
tier 0 must be exactly the stock car.

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
| SPIKE MINES | the mine you already lay sprays spikes: whatever lives through the blast crawls at 150 for three seconds | `game/obstacles.js` |
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
  - [ ] **11d** — Persistence, once players have records to hold one: turn
        `main.js`'s `CREDIT_STORE` back on and decide, then, whether the
        upgrade ladder persists with the money or stays scoped to a run
- [ ] **Phase 12** — Polish: balance, high scores, performance
- [ ] **Phase 13** — Online server: put the game on a public URL. Static
      hosting is enough for the no-build ES-module layout; the server side is
      whatever the game wants beyond that — a shared high-score board being
      the obvious first thing, which also means the score submission has to
      be something the server can sanity-check
- [ ] **Phase 14** — Advertisement: consider monetising via ads. Decide the
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
      Unmeasured risk to settle first: the per-frame canvas->texture upload.
      NOT a performance phase — the 1x frame is ~1ms of a 16.7ms budget; this is
      purely visual ambition, and a full WebGL/WebGPU renderer (which would also
      retire the sprite cache, free per-object rotation and lift the scaling
      constraints above) stays out of scope until the post pass proves the look
