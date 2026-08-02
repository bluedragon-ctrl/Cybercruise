# Cybercruise

A retro **80s neon wireframe** browser game in vanilla JavaScript, inspired by the
1983 arcade classic **Spy Hunter**. Drive a car along an infinite curving neon
highway, weave through friendly and enemy traffic, and blast enemies with a
selection of switchable weapons.

## Play

The game uses native ES modules, so it must be served over HTTP (not opened as a
`file://`). On Windows, double-click **`play.bat`** in the project root — it
serves the folder and opens the game in your browser. It takes an optional port:
`play.bat 8080`.

Otherwise any static file server will do — from the project root:

```bash
python -m http.server 5173
```

Then open <http://localhost:5173>.

Cybercruise is developed across several machines, and not all of them have
python on PATH (on Windows, a bare `python` may hit the Microsoft Store alias
stub rather than a real interpreter). Equivalent one-liners:

```bash
npx --yes serve -l 5173 .
```

```bash
php -S localhost:5173
```

Two things to watch if you roll your own server: `.js` must be sent as
`text/javascript` or the browser refuses the modules, and resolve the document
root to an absolute path before the containment check — comparing request paths
against a relative root rejects everything as a 403.

`.claude/launch.json` (used by Claude Code's preview tooling) starts the python
variant. If python isn't available on your machine, point it at whichever server
you use locally — but please don't commit that switch, since python works for
most of the machines this is developed on.

### Asset gallery

A static showcase of the neon assets (cars, buildings, palette) for iterating on
visuals without running the game lives at <http://localhost:5173/demo.html>. Add
a sprite in `src/game/sprites.js`, then register a cell in `src/demo/gallery.js`.
Car types are the exception: the gallery walks the catalogue, so a new entry in
`src/game/cartypes.js` shows up there on its own.

### Controls

| Key | Action |
| --- | --- |
| ←/→ or A/D | Steer |
| ↑/↓ | Accelerate / brake |
| Space | Fire |
| Tab / Shift / Q | Swap weapon |

## Tech

- Vanilla JS + HTML5 Canvas 2D — no framework, no build step
- Native ES modules
- Web Audio API for procedural wavesynth music & SFX (later phase)

### Rendering performance

Canvas 2D's `ctx.shadowBlur` is what makes the neon look, and it is also by far
the most expensive thing the renderer can do — its cost scales with the shadow's
**bounding-box area**, not with the complexity of the shape. Before this was
addressed, glow accounted for ~80% of frame time (5.05ms → 1.01ms with
`shadowBlur` forced to 0) and grew linearly with every object on screen.

Three rules keep that from coming back as more visuals land:

1. **Anything drawn per-frame per-entity goes through the sprite cache.** Use
   `drawCarCached` / `drawBuildingVariant` (`src/game/sprites.js`), or add a
   wrapper built on `src/engine/spritecache.js`. Cache keys must be bounded —
   quantise continuous parameters rather than keying on raw floats. The raw
   `drawCar` / `drawBuilding` stay pure for the asset gallery and for building
   cache entries.
2. **Never put `shadowBlur` on a path that spans much of the canvas.** Use
   `neonStroke` (`src/engine/neon.js`), which strokes a path several times at
   decreasing width instead. One full-height barrier: 865µs shadowed vs 217µs
   layered.
3. **Anything that only SCROLLS is pre-rendered and blitted, not re-stroked.**
   Once rule 2 is applied, `neonStroke`'s overdraw becomes the whole frame cost,
   and the two biggest paths were pure functions of world position. The road is
   drawn from a rolling cache of 128px strips (`road.js`) and the city floor grid
   from a single tile (`scenery.js`). Together ~4.3ms/frame down to ~60µs. If a
   new full-screen layer scrolls, it belongs in a cache too — check first whether
   it *repeats* (one tile, forever) or not (a keyed sliding window).

**The camera is quantised to whole pixels, and this is load-bearing.** `main.js`
rounds `distance` ONCE at the top of the render pass and hands that value to
every layer; `scenery.render` rounds its own half-speed parallax clock the same
way. A blit is only pixel-exact at an integer offset, so interpolating the world
scroll — or rounding per-layer instead of once — would resample both caches and
soften the neon, and would shear the traffic against the road it drives on. The
world advancing in whole-pixel steps is deliberate; at 4–10px/frame it is
invisible. Do **not** round the simulation's `distance`: the odometer and the
distance term of the score read the real float.

Current cost is **under 1ms/frame** at 600×800 with a full screen of traffic,
against a 16.7ms budget — measured by injecting known workloads alongside the
live game until frames dropped, which put ~10ms+ of headroom on top. It is also
**flat in object count**, so entities are effectively free and the remaining
budget is governed by screen area. Note that budget assumes 480k pixels: going
fullscreen 1080p is 4.3x the area, fill rate scales with it, and the cache tiles
grow with it too (the grid tile alone goes 2MB → 8MB).

There is nothing left above the noise floor: all building blits together are
43µs, a cached car blit is ~8µs, `clear()` is ~25µs. Optimisation targets are
absolute, not relative — removing the two big layers did not promote any of these
to being worth touching. Future performance work should be triggered by a
measurement, not a hunch; the likely triggers are a high-DPI backing store, a new
full-screen effect (scanlines, CRT curvature, colour grade), or an order of
magnitude more entities.

Still open: the city has no culling, which will matter for Phase 7.

Two traps when profiling canvas work here, both of which cost time to rediscover:
`getImageData` used to "force a flush" demotes the canvas out of GPU acceleration
and changes what is being compared; and measuring throughput inside `requestAnimationFrame`
silently floors at vsync and reports a ratio of ~1 unless the load genuinely
overruns the frame budget. Two plausible-looking methods disagreed by 5x. Prefer
saturating rAF throughput, and sanity-check any ratio near 1.

### Traffic

The other cars on the road are three files, split so that adding a kind of
traffic doesn't mean touching the simulation:

- `src/game/cartypes.js` — the catalogue. A type is pure data: silhouette,
  colours, size, health, cruising-speed range, how fast it can change lanes,
  blast radius and damage, spawn weight, and the name of its behaviour. New
  traffic = a new entry here.
- `src/game/carshapes.js` — the silhouettes. Ten of them, and the catalogue is a
  1:1 map onto it: **shape** is what tells one type from another, so colour is
  left to carry only faction (red hostile / amber civilian) and weight class, and
  shades repeat across types. The one shape shared with the player is given to an
  enemy — your own outline in red reads as a rival.
- `src/game/behaviours.js` — the manoeuvres, and the order they are decided in.
  A behaviour only sets INTENT (`targetOffset`, `targetSpeed`); traffic.js
  integrates it under the type's limits, so a rig can't corner like a roadster
  and the physics stay in one place. One entry point, `driveCar`, runs three
  stages for every car: **tactic** (the manoeuvre), **reflex** (hazard
  avoidance, which may override the tactic laterally), then **arms**. Phase 4's
  tactics (`pursue`, `ram`, `block`, `weave`, `convoy`) are rows in that table
  still borrowing their driving from the two real ones.
- `src/game/driving.js` — the **driving profiles**: the numbers behind a tactic.
  Following distances, patience, lane discipline, and how much hull a driver
  will accept hitting. See below.
- `src/game/traffic.js` — spawning, driving, dying, retiring, drawing.
- `src/game/collisions.js` — ramming: the only place cars push each other around.
- `src/game/effects.js` — wrecks: what a destroyed car looks like on its way out.

The nimble types (sedan, roadster, interceptor) drive the `overtake` tactic: if
something slower is holding them up — traffic or the player — they pull out, pass
on one side and settle back into a lane. The manoeuvre is **committed**: a car
picks its side once, from whichever one has road and nobody already in it, and
holds that line until it is past, gives up, or the side runs out of tarmac.
Re-deciding every tick makes traffic dither, and here it would also mean cars
jinking into each other, since every swerve is now a collision. Overtakers still
brake for whatever is ahead in *either* lane while changing lanes, so a pass that
can't be completed degrades to following rather than to a rear-end.

The heavy types (van, rig, bruiser, muscle) just `cruise`, which is what keeps
the whole road from weaving at once — and means sitting in front of a rig at 180
works, while sitting in front of anything nimble does not.

### Driving profiles

A car type names **two** things: a tactic (which manoeuvres it knows) and a
**driving profile** (how boldly it runs them). Everything a driver might feel
about the road used to be hard-coded in `behaviours.js`, so two civilians naming
`overtake` drove identically and telling them apart meant writing a second
function. Now it is a data table, and a new car type is usually no new code at
all.

The sedan and the roadster are the demonstration: **same tactic**, so every
difference between them on the road comes out of the profile and nothing else.

| | `commuter` (sedan) | `hustler` (roadster) |
|---|---|---|
| lane discipline | dead centre | rides the lane edges, prefers the inner lane |
| patience before a pass | 1.2s | 0.2s |
| worth passing for | +15 units/sec | +5 |
| following gap | 40 + 1.0s of closing | 20 + 0.65s |
| will hit a roadblock | never | barrels ~1/3 of the time, never a trestle |
| will brush another car | never — it brakes instead | readily |

Measured over 15 car-minutes of headless road: the sedan sits **2.1px** from its
lane centre against the roadster's **18.1**, and commits **1.0** pass per
car-minute against **10.7**.

Two of those rows are load-bearing rather than flavour:

**`nerve` is quantised by the obstacle catalogue.** It is compared against a
hazard's `blastDamage` (barrels 5, trestle 8, tetra 24, mine 30), so anything
between 0 and 5 behaves exactly like 0 — there is no "slightly bolder". No
profile reaches the tetra's 24, so none reaches the mine's 30, so traffic never
clears a mine off the road for the player. The **amber** civilians must stay at
0: an amber car swerving has to mean "there is something in that lane". The pale
ones are a visibly different shade, which is what buys the roadster the room to
gamble.

**A careful driver stops rather than hit anything.** With no lane it will accept,
a car hands the hazard to its own following rule as a lead car doing zero and
brakes to a standstill. It also slides off the hazard's line even though there is
somebody standing in the refuge — found by measuring, not by reading: stopping
alone left the car parked in the roadblock's lane until something rear-ended it
and shunted it into the thing it had stopped for, which was *every* civilian
hazard strike in a 15 car-minute sample. Fixing it took civilian hazard strikes
from 0.43 to 0.14 per car-minute. Having already given up its speed, the contact
the car accepts in the refuge is a nudge rather than a swipe.

`npm run sim` runs the road headless for a few minutes and reports what each
profile actually did — lane deviation, passes committed and completed, time spent
stopped, contacts, hazards struck. "Does the roadster feel different" is not a
question a canvas answers honestly; these are the numbers behind the claims
above.

Cars are positioned as `worldY` (along the road) plus a lateral `offset` from
the centre-line, so they track every curve without steering. They exist only
near the player: spawned just off-screen — ahead if slower than the player,
behind if faster, so they always cross the screen — and retired once well past.

**The speed band** is pinned to both ends of the player's own 120–620:

| | | |
|---|---|---|
| rig | 180–215 | the floor — half again the player's minimum |
| van | 195–255 | |
| sedan | 215–290 | the widest range: civilians are a spread of ordinary drivers |
| bruiser | 280–330 | |
| muscle | 310–360 | |
| interceptor | 400–470 | |
| roadster | 430–560 | sits just under the player's ceiling |
| rival | 580–650 | straddles the player's ceiling — draws level, neither escapes |
| hypercar | 630–700 | |
| cycle | 660–730 | catches a player at full throttle |

Two consequences worth having on purpose. Dawdling never makes the road go
quiet — it makes the whole city stream past you. And **flat out is not fast
enough to be left alone**: a cycle still comes past a player holding 620, so
escaping is a job for the Phase 5 boosts rather than for the accelerator.

**Within a type, no two cars drive alike**, and none of it costs a sprite:

- the range is **rolled per spawn**, so two sedans start out different;
- each car then **wanders ±4%** around its roll, on its own phase and its own
  8–12s period, so a pair that happened to roll close together separates instead
  of locking into formation. A wider one-time roll can't do this — it varies cars
  against each other, not over time;
- an overtaker **spends up to 15% more** while committed to a pass, so passing
  reads as effort rather than as drift. Measured over 6 runs: passes take 2.16s
  instead of 2.79s and 7% expire on the timeout instead of 18%.

All three are capped by the type's own `speedMin`/`speedMax`, so the table above
stays a hard floor and ceiling — which is what keeps the closing-speed
constraint below true.

The band's width is not a free parameter. Traffic sheds speed at `traffic.js`'s
`ACCEL`, and a profile's `followGap` + `followReaction` only leave a follower
room to match while `dv² / (2 · ACCEL) ≤ followGap + dv · followReaction` for
every closing speed `dv` its own drivers reach. That is checked **per profile**,
against the fastest type naming it rather than against the whole catalogue —
which is exactly why `hustler` is allowed to tailgate at 0.65s where `commuter`
needs 1.0, and why pointing a quick type at it fails the test.

### Ramming

Every car has a **hull** and a **mass** (`cartypes.js`), and so does the player
(`player.js`). Collisions are resolved for all of them together, as a flat list
of BODIES with no notion of who is the player — so the same rules cover the
player shunting a sedan, a rig rear-ending a roadster, and the pile-up that
follows.

- Boxes are axis-aligned, so an overlap is undone along whichever axis is
  penetrated least: a rear-end pushes along the road, a side-swipe across it.
- Both bodies move, split by INVERSE mass, and the same split decides the
  damage. Hitting a rig is a bad idea; a roadster is swatted aside.
- Damage is linear in closing speed above a floor, so nudging traffic in queue
  costs nothing and a full-speed ram is close to lethal for both cars.
- **Chains** fall out of running the pair sweep several times per tick:
  separating A from B pushes B into C, and the next pass resolves that. A shove
  therefore carries down a row of cars, losing force at each link.
- Below a third of its hull a car **blinks** between its own colour and a
  white-hot flash. The tell has to be the alternation, not a red tint: an enemy
  car is already red, so a tint would say nothing about the one car that's
  nearly scrap. `TrafficCar.critical` is the hook for it.
- At zero hull a car is **destroyed**: it explodes where it stood (the shell
  breaks apart along the car's own outline — `effects.js`) and leaves the road
  the same tick. Nothing solid is left behind, so the fireball itself is safe to
  drive through.
- The explosion does **blast damage** to everything close by, the player
  included: peak damage at contact, falling off linearly to nothing at the rim,
  with distance measured between box EDGES so a long rig doesn't get free reach
  along its own length. Radius and damage are per type — a cycle going up is a
  pop, a rig is 46 hull and most of the road width.
- Blasts **chain**: a car killed by one explodes in the same tick, and the sweep
  keeps going until nothing new has died. It terminates because each car
  detonates exactly once.

Anything that wants to be rammable later — a barrel, a boss — implements the
body interface at the top of `collisions.js`; the solver never learns about it.
The player is not a special case there either: it reaches the solver through an
adapter that re-bases its screen x onto the road's centre-line.

Two consequences worth knowing. The player can be reduced to zero hull, and
nothing happens yet — the wreck and game-over states are Phase 6. And cruising
traffic brakes for the player as it does for any other car, so being rear-ended
is a consequence of driving badly rather than steady background noise; Phase 4's
enemy tactics are where that politeness ends.

## Project layout

```
index.html          canvas + module entry
css/style.css       page + CRT frame styling
src/
  main.js           bootstrap + game loop
  engine/           loop, input, neon draw helpers
  game/             player, road, traffic, weapons, ... (built per phase)
  audio/            wavesynth synth (later phase)
```

## Development roadmap

Work lands via Pull Requests, one phase at a time; each phase leaves the game
playable.

Not every PR is phase work. Building a phase surfaces problems in what is
already there — a barrier that doesn't fit its lane, cars pointing the wrong way
through a bend, a renderer spending most of the frame on two layers that never
change. Those get fixed as they turn up rather than deferred to Phase 9, so the
history interleaves phase features with side-steps into earlier phases' code.

- [x] **Phase 0** — Skeleton: neon car steering over a scrolling grid
- [x] **Phase 1** — Road: infinite curving highway + barriers
- [x] **Phase 2** — Surroundings A: simplified box buildings along the road
- [x] **Phase 3** — Traffic: neutral/enemy cars, ramming physics
- [ ] **Phase 4** — Combat: shooting, explosions, enemy AI (shoot / mines)
      — **in progress**
- [ ] **Phase 5** — Weapons: multiple weapons + swap pickups
- [ ] **Phase 6** — Score/states: scoring, penalties, game-over, difficulty ramp
- [ ] **Phase 7** — Surroundings B: richer lit / parallax city
- [ ] **Phase 8** — Audio & juice: wavesynth music, SFX, screen shake, scanlines
- [ ] **Phase 9** — Polish: balance, high scores, performance
