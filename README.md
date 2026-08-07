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

### Car editor

A local tool for tuning the whole roster's — civilian and hostile alike —
hull, speed, spawn-distance, and driving-behavior knobs, plus obstacles'
spawn chance and spawn distance (`tools/car-editor/`), without hand-editing
`cartypes.js`/`driving.js`/`obstacletypes.js`. Double-click
`tools/car-editor/edit.bat` (or run `node tools/car-editor/server.js`) and
open the URL it prints. Every field shows its current value and a
description of what it does; "Create Pull Request" patches the changed
source files on a fresh branch, runs the test suite before pushing, and
opens GitHub's compare page so you finish the PR from there. Requires Git;
does not require the GitHub CLI.

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
distance term of the score read the real float. (The odometer is also *scaled*
for display — see "Distance, and the spawn gate" below — but that too is a
presentation step applied on the way to the HUD, never to `distance` itself.)

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
  blast radius and damage, spawn weight, how far into the run the type unlocks
  (`minDistance` — see below), and the name of its behaviour. New traffic = a
  new entry here.
- `src/game/carshapes.js` — the silhouettes. Eleven of them, and the catalogue is
  a 1:1 map onto it: **shape** is what tells one type from another, so colour is
  left to carry only faction (red hostile / amber civilian) and weight class, and
  shades repeat across types. The one shape shared with the player is given to an
  enemy — your own outline in red reads as a rival.
- `src/game/behaviours.js` — the manoeuvres, and the order they are decided in.
  A behaviour only sets INTENT (`targetOffset`, `targetSpeed`); traffic.js
  integrates it under the type's limits, so a rig can't corner like a roadster
  and the physics stay in one place. One entry point, `driveCar`, runs three
  stages for every car: **tactic** (the manoeuvre), **reflex** (hazard
  avoidance, which may override the tactic laterally), then **arms**. Every row
  in that table is a real manoeuvre — nothing borrows its driving from the
  civilian ones any more. `pursue` (the interceptor) is the road's one chasing
  function: close in, hold a firing gap, never give up. `raid` (the cycle)
  forces its way past whatever's ahead, then holds station just long enough
  to drop one mine in the player's path. `trail` (the stocker) is `pursue`
  plus a give-up clock: it fights one engagement off the player's back bumper
  and then rides off, permanently unarmed. `ram` (the bruiser) carries no gun and no mines
  at all — it just closes the gap, from behind or alongside to hit the player
  outright, or from in front by holding a speed under theirs to make the same
  contact happen the other way round.
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

The heavy types (van, rig, bruiser) just `cruise`, which is what keeps the whole
road from weaving at once — and means sitting in front of a rig at 180 works,
while sitting in front of anything nimble does not. The muscle car is the
exception that proves it: heavy, and an overtaker anyway, because a heavy that
comes past you rather than sitting behind you is the one civilian the player has
to actually give way to. The stocker is the hostile answer to the same idea — a
heavy that hunts, so weight stops being a promise that a car will leave you
alone.

### Distance, and the spawn gate

The simulation measures the road in **world units** — roughly one per pixel —
and that is what every coordinate, spawn margin and blast radius is written in.
It is *not* what the player sees: the **DIST** readout divides by
`road.js`'s `DIST_UNITS` (100), because raw units reach five figures inside a
minute and read as noise. So `DIST 50` is 5,000 world units driven.

That readout is a unit the design speaks in, not just a bit of formatting.
Every entry in the two spawn catalogues carries a **`minDistance`**: how far the
player must have driven before that type may appear at all, written in
DIST-readout units, so "the enemy turns up at 100" means the number on the HUD.

- **Cars** (`cartypes.js`) — civilians are `0`, on the road from the first
  metre; every hostile type is `ENEMY_MIN_DISTANCE` (100 ≈ 10,000 world units,
  or about 16 seconds flat out). The opening run is therefore ordinary city
  traffic, and the enemy arrives as a *change* rather than as the state of the
  world from the first second. Dawdling stretches that quiet spell out —
  deliberately: speed is what asks for the trouble.
- **Obstacles** (`obstacletypes.js`) — all `0` today. A roadblock is the city's,
  not the enemy's, so it belongs on the opening road alongside the traffic that
  has to swerve round it. The field is there so a hazard (the mine is the
  obvious candidate) can be held back later without new machinery.

The gate **reweights** the draw rather than re-rolling until something passes:
before `DIST 100` the six civilian types share the whole spawn weight, so the
opening road is as busy as any other stretch. Rejection sampling would have
thinned it to half strength, which is the opposite of what a quiet start should
feel like. `pickCarType`/`pickObstacleType` return `null` only if *everything*
is still gated, and the spawners treat that exactly like a full road: skip, try
again next interval. Enemy-laid mines (`armament.js`) go through the catalogue
by name and are not gated — the car that lays them already was.

Staging the enemy per type (interceptors early, a rival only much later) is a
matter of spreading those numbers out; nothing in `traffic.js` needs to change.

#### The focus switch

Tuning one type's driving means watching it, and a road running the full
catalogue gives you a few seconds of the car you care about between everything
else. `cartypes.js` exports **`FOCUS`**, a list of type ids: set it and only
those reach the road.

```js
export const FOCUS = ["sedan", "roadster"];   // civilian profiles, nothing else
```

It is an override on the same `typeAvailable` gate the game ships with, not a
filter of its own, so a focused road is still a road the real spawner built —
same reweighting, same `pickCarType`, same everything-gated path. A measurement
harness that measured a different code path would not be measuring the game. A
focused type keeps its own `minDistance`, so focusing on the interceptor still
waits for `DIST 100`.

**Ship it empty.** The first test in `invariants.test.js` asserts `FOCUS` is
`[]`, because a focused catalogue also fails the gating invariants and
"`van` never appeared" is a much worse error message than "`FOCUS` is still set".

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

**The hostiles are tuned the same way.** How close a car chases to, how wide a
net it casts before bothering, how fast it will run to stay in touch, how long
it keeps trying, and how hard it leans on the player once ahead of them are all
profile fields too (`pursueHold`, `pursueRange`, `chaseSpeed`, `giveUpTime`,
`ramBrake`, `ramFloor`). They were module constants inside `behaviours.js` for a
while, which meant the five enemy profiles differed only in `nerve` and a second,
more cautious interceptor needed a new *function* rather than a new row.

#### One profile per civilian

All six civilians have their own, and the sedan keeps `commuter` precisely
because it is the reference every other table is described as a difference from.

| | drives | in one line |
|---|---|---|
| sedan | `commuter` | the plain one, and the yardstick |
| van | `hauler` | out of the way, and it will lean on something small |
| rig | `juggernaut` | dead straight, brakes early, expects to be given room |
| muscle | `brawler` | heavy and rude, and it doesn't feel the contacts |
| roadster | `hustler` | fast and rude, and it does |
| hypercar | `showpiece` | fast and immaculate |

Three pairs carry the whole idea. **Roadster against hypercar**: the road's only
two pale civilians, similar speed, opposite manners — one rides the lane edge and
cuts past at 7px of clearance, the other holds the centre-line exactly and sweeps
by at 20. **Van against rig**: the wandering one is the panel van, not the truck.
**Muscle against roadster**: both are impatient, but the roadster pays 4–9 hull
off 40 for every liberty it takes while the muscle car pays 1–3 off 110. One is
reckless; the other simply doesn't have to care.

The muscle car was a **hostile** until recently — the one that blocked your lane
from in front. It moved across because the civilian road had a hole in exactly
that shape: every heavy civilian was careful, and the only rude one was the
frailest car out here, so rudeness never cost the player anything. A car that is
aggressive *without* being out to get you is a different thing from an enemy. It
still dodges every hazard, because it is amber and that signal is not negotiable
— bad manners, perfectly good judgement.

The **stocker** took the hostile slot it vacated, and deliberately isn't a copy:
the muscle got in front of you and sat there, where the stocker *chases*. It is
the enemy's quick heavy — 130 hull and mass 1.9 at 355–415, filling the gap
between the bruiser's 330 and the interceptor's 400, so being ahead of one is
not the escape it is with the rest of that class. It drives `roadracer`, the
only hostile profile that runs a **racing line**: it lives on the lane edges and
pulls out early, so a stocker closes from the side of the road rather than up
the middle. Its nerve (14) sits above the interceptor's because the cage means
junk in the road costs it paint rather than a wheel. It is also the only driver
on the road that ever gives the player up: `giveUpTime` is 3 seconds of **lost
contact** on this profile and 0 — never — on every other hostile. That leaves
the `enforcer` profile the muscle left behind still unclaimed, and still the
right table for a second heavy that leans on the player.

The **bruiser** is the road's other real hostile tactic, and the plainest one:
`ram` carries no gun and lays no mines — `arms: false` on the tactic's own row
means it never fires the default hostile kit `armFor` still hands it, and the
whole of its threat is its own 2.2 mass. It tracks the player's lane exactly
as raid and trail do, but the speed half never brakes for them: from behind
or alongside it simply asks for a ceiling above its own 330 top speed, so it
closes and hits rather than settling into a follow. Once it's past, tracking
the same lane while asking for less than the player's own speed *is* the
block — they either brake to match a wall heavier than they are or rear-end
it. Nothing coordinates the two hostiles that actually ship real tactics, and
nothing has to: a player ground down by a bruiser is a player held in a
stocker's gun window for longer, purely because the road runs both at once.

The preferences also add up to a **lane gradient**. The two slow haulers want the
lanes by the barrier and the two fast machines want the lanes by the centre-line,
so the road sorts itself by speed and choosing a lane becomes a choice about what
you will meet in it. That relation is asserted in the test suite, because a
retune that puts a rig in the fast lane breaks nothing — it just quietly stops
making sense.

Three of those rows are load-bearing rather than flavour:

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

**`contact` is quantised too, but by the car rather than by the catalogue.** A
lane change is priced as a side-swipe at the car's *own* steering rate, so what
counts as a bold setting is a property of the type. The van steers at 60 against
a damage floor of 40, which puts its contacts in a 0.7–1.5 hull band and gives it
the only finely-graded dial on the road — it squeezes past a roadster two times
in five and never a rig. The rig steers at 35, *under* the floor, so every lane
change it could make costs exactly nothing and its dial has only two positions.
Both ends of that are traps: a ceiling under the cheapest contact a type can be
offered does nothing at all (the cycle sat at 4 against a floor of 7.35 for a
while, and the table said otherwise), and a ceiling of zero has to mean "nobody"
rather than "anybody it happens to be free to hit", or the heaviest vehicle in
the catalogue becomes the one that shoves.

`npm run sim` runs the road headless and reports what each profile actually did —
lane deviation, passes committed and completed, time spent stopped, contacts,
hazards struck. "Does the roadster feel different" is not a question a canvas
answers honestly; these are the numbers behind the claims above.

**Use `node tools/drivesim.js 300 60` for a tuning decision**, not the default
five runs. Rates are per car-minute, the rare types earn them slowly, and two
identical 20-run batches disagree by ~40% on contacts and hazard strikes for a
rig or a hypercar. A 20-run batch once produced a confident, fully written-up
conclusion about the rig's `contact` setting that 60 runs reversed outright.

Cars are positioned as `worldY` (along the road) plus a lateral `offset` from
the centre-line, so they track every curve without steering. They exist only
near the player: spawned just off-screen — ahead if slower than the player,
behind if faster, so they always cross the screen — and retired once well past.

**The speed band** is pinned to both ends of the player's own 120–620:

| | | |
|---|---|---|
| rig | 180–215 | the floor — half again the player's minimum |
| van | 205–265 | |
| sedan | 215–290 | the widest range: civilians are a spread of ordinary drivers |
| bruiser | 280–330 | no gun, no mines: closes to ram, or blocks ahead and brakes |
| muscle | 310–360 | the heavy civilian that leans on people |
| stocker | 355–415 | the quick heavy: being ahead of one is not an escape |
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
tools/
  drivesim.js       headless driving-profile measurement (see npm run sim)
  car-editor/       browser UI for tuning enemy hull/speed/behavior — see below
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
- [x] **Phase 4** — Combat: shooting, explosions, enemy AI (shoot / mines)
- [x] **Phase 5** — Weapons: multiple weapons + swap pickups
- [x] **Phase 6** — Score/states: scoring, penalties, game-over, difficulty ramp
- [ ] **Phase 7** — Surroundings B: richer lit / parallax city
      — **in progress**
- [ ] **Phase 8** — Audio & juice: wavesynth music, SFX, screen shake, scanlines
- [ ] **Phase 9** — Polish: balance, high scores, performance
