# Special events — one director for gangs, blockades, narrowings and bosses

Date: 2026-08-27

> **SHIPPED.** `src/game/events.js` and `src/game/eventtypes.js` are this
> document, and the roadmap's Phase 9 is closed against it. The text below is
> written forward, in the tense it was designed in, and is kept that way — it is
> the reasoning, not the reference. Where the two disagree the source wins; the
> catalogue in particular has moved (`warlord` became `warband` during the build,
> recorded in its own section). The invariants it argues for are pinned in
> `test/events.test.js`. The follow-ups at the end are still open.

## Purpose

The road today is **statistically uniform in the small**, the same way the city
was before `sectors.js` gave it a shape: `traffic.js` drops one car every
`SPAWN_INTERVAL` seconds into whichever lane happens to be free, `obstacles.js`
drops one hazard every 2.2s wherever the passage rule allows, and both draw from
a weighted catalogue gated on `minDistance`. Nothing on the road is ever *staged*
— there is no moment at which the road stops being a texture and becomes a
situation.

This document designs the system that provides those moments:

- a **motorcycle gang** closing from behind, met by chance at distance,
- the road **narrowing** to a slot between two rows of tetras,
- a **wall of rigs** ahead, blocking the lanes,
- a **boss** at a fixed milestone,
- and the **shopping interlude** that already exists (`hauler.js`), which is the
  same kind of thing and today runs on a scheduler of its own.

The boss is the reason this is one system and not four. A boss is not a
different kind of thing from a gang: both are *several vehicles placed on
purpose, at a moment chosen on purpose*. Building a boss trigger separately from
an ambush trigger would leave two schedulers, two suppression rules and two sets
of placement bugs.

The cargo drone is the reason it is one system and not five. Its trigger is
already a distance milestone that fires once and remembers it did
(`hauler.crossedMilestone()`), which is character-for-character the boss trigger
this document was about to write — and it fires **blind**, with no notion that
anything else might be happening on the road. Every one of the encounters above
would be able to land on the tick the jaws close. So the drone's *scheduling*
comes into the director and its *animation* stays exactly where it is.

**One director, one catalogue, one arbiter of what is allowed to be happening.**

## What already exists, and must not be worked around

Four pieces are load-bearing, and every one of them is a *fairness* rule the
director inherits rather than escapes:

- **`Obstacles.leavesPassage()`** (`src/game/obstacles.js:527`) — after any
  spawn there is still a continuous gap across the road at least `MIN_PASSAGE`
  (`WIDEST_CAR + 12`) wide. This is what makes "narrow the road" a *safe* feature
  to add: the narrowing that would seal the road is refused by a rule that is
  already there.
- **`Obstacles.SPAWN_MARGIN = 1500`** — measured, not guessed: it is the road the
  slowest-steering car in the catalogue needs to cross two lanes. Anything the
  director puts *ahead* of the player obeys it, or it drops hazards into the
  middle of the live traffic field where no driver can react.
- **`Traffic.freeLane()`** (`src/game/traffic.js:563`) — a car is never placed
  within `SPAWN_GAP` of another car, or of a hazard it would have no road to
  dodge.
- **`pickWeighted(list, isEligible)`** (`src/game/weightedpick.js`) — the one
  weighted draw; the eligibility predicate stays per-catalogue. The event
  catalogue is a fourth caller, not a fourth copy.

And two patterns the director copies rather than reinvents:

- **The milestone counter** — `hauler.crossedMilestone()`
  (`src/game/hauler.js:208`): `Math.floor(distance / interval)` against a stored
  counter. A distance milestone that fires once and remembers it did. This one is
  not copied but **moved**: see "The cargo drone is an event" below.
- **The edge detector** — `sectors.js`'s `lastSector`, `links.js`'s
  `lastAnnouncedId`, `main.js`'s `wasSectorGlitching`. The module exposes a
  *level*; `main.js` owns the edge and the sound.

## The shape: two files, no third code path

```
src/game/eventtypes.js   the CATALOGUE — data only, like cartypes.js
src/game/events.js       the DIRECTOR — when to fire, and what to ask for
```

Neither of them spawns anything. `events.js` builds a list of **placement
requests** and hands them to `Traffic` and `Obstacles`, which grow one entry
point each. That is the most important decision in this design: an event that
pushed into `traffic.cars` directly would bypass `freeLane`, `clampToRoad`, the
passage rule and both retire sweeps, and would be the only thing on the road that
could seal it.

## The trigger model — one beat, three kinds of trigger

The director keeps the minimum per-run state the job actually needs, in the
spirit of `sectors.js`'s own two scalars: the last beat index rolled, the
distance the current cooldown ends at, the live encounter (or null), and one
counter per milestone entry — the last of which is the `milestone` field moved
out of `hauler.js`, not a new kind of memory.

**Rolled events** are polled on a beat measured in *road covered*, not seconds:

```js
const BEAT = 8 * DIST_UNITS;        // one roll per 800 world units
const beat = Math.floor(distance / BEAT);
if (beat > lastBeat) { lastBeat = beat; maybeFire(distance); }
```

Distance, not time, for the reason `cartypes.js` already gives about
`ENEMY_MIN_DISTANCE`: *speed is what asks for the trouble*. A player dawdling to
farm gang encounters is a bug; a player flat out meeting more of them is the
game working.

`maybeFire` refuses immediately if an encounter is live or `distance <
cooldownUntil`, then rolls a flat `EVENT_CHANCE` (~0.18 — roughly one encounter
per 4400 units of road, on top of the global cooldown that keeps two from
touching), then `pickWeighted(EVENT_TYPES, eligible)` where `eligible` is this
catalogue's own predicate: the `minDistance` gate in DIST units, `maxDistance`
for events that stop being interesting late, a `once` already spent, and this
entry's own `cooldown` not yet expired.

**Milestone events** are the *same catalogue* with a milestone field instead of
`weight`, and there are two of them because the catalogue has to express both
kinds already in the game:

- `at: 500` — a ONE-SHOT milestone. The boss.
- `every: 400` — a RECURRING one, `Math.floor(distance / (every * DIST_UNITS))`
  against a stored counter. This is `SHOP_INTERVAL`, unchanged, and it is the
  drone.

Milestones are checked before the roll and they **defer, never cancel**. A
milestone that comes due while a rolled encounter is live is held — its counter
is *not* advanced — and it fires on the next beat after the road clears. That
matters far more for the drone than for the boss: a skipped boss is a missed
set-piece, but a skipped shop visit is a lost upgrade in a run whose whole
economy is built on that ladder. Deferral is bounded because every rolled
encounter carries a `duration` in road covered, so the road always clears.

That is the whole answer to "it does not make sense to have special triggers just
for bosses" — and to the drone having its own. A boss is `{ at: 500, stage:
[...] }`, a gang is `{ weight: 3, minDistance: 150, stage: [...] }`, the shop
visit is `{ every: 400, stage: [{ kind: "handoff", handler: "shop" }] }`. One
list, one loop.

## The catalogue

Data only, in the house style — every field a literal on every entry, so one
event can diverge without touching the others.

```js
{
  id: "gang",                  // stable key: logs, tests, the FOCUS switch
  label: "GANG SIGHTED",       // the SYS LOG line
  weight: 3,                   // relative odds among eligible entries
  minDistance: 150,            // DIST-readout units, the same gate cartypes uses
  maxDistance: Infinity,
  cooldown: 30 * DIST_UNITS,   // road before THIS event may recur
  once: false,
  duration: 45 * DIST_UNITS,   // road after which the event is over regardless
  density: { cars: 0.5, hazards: 1 },  // ambient budgets, scaled, for its life
  stage: [
    { kind: "cars", type: "outrider", count: 4, side: "behind",
      spread: 260, lanes: "spread" },
  ],
}
```

Seven entries ship it. Every gate is the gate of the thing it stages, never a
number of its own — asserted in `test/events.test.js`:

| id | trigger | stage |
| --- | --- | --- |
| `gang` | rolled, `minDistance: 300` | 4 outriders **behind**, staggered across lanes |
| `narrows` | rolled, `minDistance: 400` | trestles **ahead**, both barriers, 3 rows down a stretch |
| `blockade` | rolled, `minDistance: 500` | 3 rigs **ahead**, abreast, one lane deliberately left open |
| `warband` | `at: 700`, `once` | 1 bruiser **ahead** (`atomic`), escorted by 2 interceptors |
| `rival` | `at: 1000`, `once` | 1 rival **behind** (`atomic`) — the mini-boss |
| `minefield` | rolled, `minDistance: 1200` | 4 rows of 3 caltrops **ahead**, at random offsets |
| `shop` | `every: 400` | `handoff` to the cargo drone |

**The minefield is the entry whose shape the passage rule decides.** Everywhere
else that rule is a floor the design stays clear of; here it is the mechanism.
Each row asks for three 26px mines across a 286px road, which leaves four gaps
averaging 52px against a `MIN_PASSAGE` of 58 — so a row that spreads evenly is
refused its third mine and comes out as two, while a row whose mines cluster to
one side keeps all three and leaves one wide lane open. Measured over 400 fields:
three mines 50% of the time, two 46%, an average of 9.9 of the 12 asked for.
Rows sit 220 apart, beyond `CLUSTER_WINDOW`'s 130, so each is judged on its own —
a sequence of decisions rather than one puzzle the player cannot see the whole
of. `MAX_STAGED_OBSTACLES` was raised to 14 precisely so the budget never bites
before the rule does.

**The rival is the entry that adds nothing.** No new car, no new tactic, no new
artwork: `cartypes.js` already built the fight (400 hull, the only hostile that
can live with the player flat out, the player's own silhouette in the hostile
shade) and `behaviours.js`'s `duel` is written for it alone. Its own catalogue
entry says "rare enough that meeting one is an event" — but at `weight: 0.3` that
was left to chance, and a player could pass DIST 1000 and never see one. This
does not touch the odds; it pins the FIRST meeting to the exact distance the road
unlocks the car, and the rival stays in the ambient draw afterwards.

**`warlord` became `warband`,** and the lead is the bruiser rather than a boss
hull. `bossshapes.js` deliberately holds finished artwork with no `cartypes.js`
record until the boss session, so forcing one into existence here would have
broken that file's own contract. The entry changes by one string when a boss type
lands; the `at` path it exercises is already a shipping path.

## The stage — the only new imperative code

A stage entry is declarative; the director turns each into a list of requests.
Four kinds cover every *placement* event above:

- **`cars`** — `count` cars of one type on the named `side`, staggered by
  `spread` world units, lanes chosen `spread` (walk distinct lanes) or `same`.
  `side: "behind"` places at `distance - (H - player.y) - traffic.SPAWN_MARGIN`
  and downward; `side: "ahead"` at `distance + player.y + obstacles.SPAWN_MARGIN`
  and upward — the *larger* margin ahead, because a car placed ahead has to be
  dodgeable by the traffic already there.
- **`abreast`** — `count` cars of one type at ONE `worldY`, on adjacent lanes,
  with `gapLanes: 1` naming how many lanes stay open. **A car wall always leaves
  a lane.** Rigs are cars, so `leavesPassage` does not cover them; this field is
  the equivalent rule for the one stage kind that could otherwise build an
  unavoidable wall, and it is asserted in the suite the same way `MIN_PASSAGE`
  is.
- **`rows`** — `count` rows of one obstacle type, `spread` apart, at
  `PLACE_SIDE`, mirrored across the road. This is the narrowing, and it needs no
  new safety rule at all: each request goes through `freeOffset`, so the row that
  would close the road is simply not placed and the narrowing comes out one tetra
  thinner. That is the correct failure — a *narrower* narrowing, never a sealed
  road.
- **`scatter`** — `count` rows of `perRow` hazards, `spread` apart, each at its
  own random lateral offset. The minefield. A **separate kind rather than a flag
  on `rows`**, and the difference is real: `rows` names its offsets and is
  furniture somebody placed, `scatter` names none of them and is a field somebody
  sowed — that is also the mine's own `PLACE_ANY` reasoning in
  `obstacletypes.js`, applied to a stretch instead of to one hazard. Folding them
  together would be one kind with a mode switch and two unrelated meanings.

...and a fifth kind that places nothing:

- **`handoff`** — names a `handler` in a map `main.js` passes to
  `events.update()`. The director does not import the module, does not know what
  it does, and cannot draw it; it only knows when to say go and how to ask
  whether it is finished. That is the same wiring rule this codebase already
  applies to audio (`sectors.js` exposes `glitching()`, `main.js` fires the
  gong) — see "The cargo drone is an event" below for the whole of it.

## The cargo drone is an event

The shopping interlude is `handoff`'s only user today, and the reason `handoff`
exists at all.

**What moves:** `hauler.crossedMilestone()` and its `milestone` counter. That
method is deleted; the counter becomes the director's, off the `shop` entry's
`every: 400`. `SHOP_INTERVAL` stays exported from `hauler.js` and the catalogue
entry reads it — the number is still a hauler feel-dial, it is just no longer the
hauler's job to notice when the odometer passes it.

**What does not move:** everything else. The three phases, the frozen lift, the
jaw timeline, `carOffsetY()`, the `"lifting"`/`"shopping"`/`"lowering"` states in
`main.js` and `respawnWorld()`. The director schedules; it does not drive a
cut-scene, and the hauler stays the file that owns "the car leaving the road and
coming back to it".

**The wiring** is one map, built in `main.js` where every other cross-system
connection in this codebase is built:

```js
const HANDLERS = {
  shop: {
    fire: () => hauler.approach(player.x, player.y),
    live: () => hauler.phase !== "idle",
  },
};
```

`live()` is what makes a handoff a first-class encounter rather than a fire-and-
forget: the director holds the event open for as long as the drone is doing
anything, which is what stops a gang rolling in during the approach and being
frozen mid-spawn by the lift.

**What this buys, concretely:**

1. **The pickup can no longer land on top of a set-piece.** Today
   `crossedMilestone()` fires blind; a boss at DIST 500 and a shop visit at 400
   and 800 already sit close enough that a slow boss fight will meet one.
2. **Density control comes for free.** The `shop` entry declares
   `density: { cars: 0, hazards: 0 }` like any other (see below), so the drone
   descends into a road that has stopped restocking itself — which also means the
   car is set down on tarmac the ambient spawner has not been filling behind
   `respawnWorld()`'s back.
3. **The approach is already the model for the others.** `hauler.js`'s header
   argues at length that phase 1 is playable on purpose — "a warning the player
   can act on rather than a cut-scene that starts without asking". That is
   exactly the property a gang or a blockade wants, and having both scheduled by
   one file is what will keep the next event honest about it.

**The one thing to be careful of:** `hauler.js`'s own comment explains why the
counter lives in the hauler — "a shop visit spans several states and several
seconds, so the thing that survives all of that is the right place for it". That
reasoning is answered, not ignored: the director's live-encounter record survives
exactly the same span, for the same reason, and `live()` is what tells it so. The
counter is only safe to move because the thing it moves into outlives the visit
too.

## The placement contract

`Traffic` and `Obstacles` each gain one method, and both are extracted from the
spawn path they already have rather than written beside it:

```js
// traffic.js
place(type, worldY, lane, speed)   // spawn()'s last three lines, named. Returns
                                   // the car, or null when freeLane-style
                                   // clearance at that spot fails.

// obstacles.js
place(type, worldY, offset)        // spawn()'s tail, still honouring freeOffset:
                                   // returns false where leavesPassage refuses.
```

`spawn()` in both files becomes *pick a type, choose a spot, call `place`*. The
director calls the same `place`. There is no second code path, for the reason
`cartypes.js`'s FOCUS comment already states about measurement harnesses: a
staged road must still be a road the real spawner built.

**Requests are placed best-effort, in order, and partial success is success.** An
event that gets 3 of its 5 cycles down because the road was busy is a smaller
gang, not a failed event. The one exception is a stage marked `atomic` (the
boss): if the lead vehicle cannot be placed, the whole request is abandoned and
the milestone counter is *not* advanced, so it fires on the next beat instead.

## Budgets — staged and ambient are two pools

`MAX_CARS = 7` is the ambient density dial, and a five-strong gang inside it
would mean the rest of the road empties to make room — the opposite of the
intended feel. So:

- Every car and obstacle the director places is tagged `staged = true` (the same
  flag shape `RoadObstacle.laid` already uses, and for the same reason: two
  budgets that must not be pooled).
- `Traffic.spawn()`'s cap counts **unstaged cars only**, against `MAX_CARS`
  unchanged. Staged cars count against `MAX_STAGED_CARS = 6`, checked by the
  director.
- `Obstacles.spawn()`'s cap already reads `count(false)`; staged hazards get a
  third bucket, `MAX_STAGED_OBSTACLES = 8`.

Retirement is untouched: a staged car retires on the same margins as any other,
which is what stops an abandoned encounter from leaking.

## Density — `MAX_CARS` is a dial the director can turn

Standing the ambient spawner down entirely is the *boss* case, not the general
one, so this is a **scale factor, not a switch**. A live encounter's `density`
block multiplies the two ambient caps for as long as it runs:

```js
// traffic.js — one scalar, defaulting to 1, and the cap it feeds
setDensity(mul)                       // events.js sets it; reset() restores 1
const cap = Math.round(MAX_CARS * this.density);
if (this.unstagedCount() < cap) this.spawn(world);
```

`MAX_CARS = 7` and `MAX_OBSTACLES = 8` are untouched: they stay the *baseline*
the multiplier is read against, so the tuning dial keeps meaning what it means
and the car editor keeps editing the one number it always did.

The catalogue then says exactly how crowded each event wants its road:

| id | `cars` | `hazards` | why |
| --- | --- | --- | --- |
| `warband` | `0` | `0` | **The road clears for the set-piece.** Nothing ambient at all |
| `rival` | `0.3` | `0` | Thin traffic to weave through; every mine on this stretch should be one the rival just dropped (`duel`'s own first half), not one the road laid |
| `gang` | `0.4` | `1` | Thinned, not emptied — the pack needs traffic to weave through |
| `blockade` | `0.5` | `0` | No hazards behind a wall the player is already braking for |
| `narrows` | `1` | `0` | Full traffic, but no ambient hazard inside the slot |
| `minefield` | `0.6` | `0` | Traffic stays and does a job: cars swerve around mines the player has not spotted, and one that misjudges goes up — the loudest possible warning |
| `shop` | `0` | `0` | The drone descends into a road that has stopped restocking |

**A cap of zero does not despawn anything, and that is the point.** Nothing is
removed from the road; the spawner simply stops replacing what retires, so the
traffic already there drains away over the next few seconds as it falls off the
screen behind. The road *emptying out ahead of the boss* is a thing the player
watches happen and reads as a warning — where a frame in which six cars blink out
of existence would read as a bug. It also means the rule needs no new retire
path, no ownership question about who may delete a car, and no special case for a
car the player is mid-fight with.

It composes with the staged budget already described: staged cars never counted
against `MAX_CARS`, so `cars: 0` silences the ambient road *without* touching the
boss's own escort. That separation is the whole reason the two budgets were split
in the first place.

Restoring is unconditional — the director sets both multipliers back to 1 when
the encounter ends, and `events.reset()` does the same on `newGame()`, so a run
that dies mid-boss cannot leave the next one driving an empty highway.

## Lifecycle

```
idle ──roll / milestone──> firing (stage applied, density set, log line pushed)
                              │
                              ├─ every member dead or retired ──┐  (placements)
                              ├─ distance past `duration` ──────┤
                              └─ handler's live() went false ───┤  (handoffs)
                                                                v
                                    density restored, cooldown (EVENT_GAP road)
                                                                │
                                                                v
                                                              idle
```

The live encounter holds the array of things it placed. "Dead or retired" is a
walk of that array asking `alive` and membership in the live lists — cheap, and
it needs no callback plumbing into either system. A `handoff` has no such array,
so it ends on its handler's own `live()` instead — and `duration` is not applied
to one, because a shop visit lasts as long as the player spends shopping and no
road passes at all while the world is frozen.

`reset()` clears the scalars and the milestone counters, restores both density
multipliers to 1, and is called from `newGame()` beside `sectors.reset()`. The
shop milestone resetting per run is not a change: `hauler.reset()` already zeroes
its own counter there, and that line simply moves with it.

## Announcing it — and keeping audio out

The director exposes a **level**, not an event: `events.active()` returns the
live encounter's id or null. `main.js` owns the edge, exactly as it already does
for `sectors.glitching()`:

```js
const ev = events.active();
if (ev && ev !== wasEvent) music.triggerEncounter(ev);
wasEvent = ev;
```

The SYS LOG line goes through `announceCityLine()` (`links.js`), not
`gameConsole.push()` — a gang sighting has to respect the same "how often can the
city talk" budget a node ping and a sector crossing do, or three chatty systems
between them triple the log's real rate.

## Where it hooks into main.js

One call, in `updatePlaying()`, **immediately before `obstacles.update()`** and
therefore before `traffic.update()`:

```js
events.update(dt, world, HANDLERS);   // may place cars/hazards, or hand off
```

Placing before both update passes means anything staged this tick goes through
the ordinary collision, detonation and retire pipeline in the *same* tick it
appeared, with no one-tick window where a staged car exists but is not simulated.

**And one call goes away.** The existing

```js
if (hauler.crossedMilestone(distance, road.DIST_UNITS)) hauler.approach(player.x, player.y);
```

is deleted — `events.update()` is what fires the drone now, through
`HANDLERS.shop`. `hauler.update()` and everything below it in `updatePlaying()`
stays exactly where it is: the director schedules the approach, it does not drive
it.

## Testing

Everything that decides *what* is placed is a pure function of `(catalogue,
distance, world snapshot)`, and is tested without a canvas the way
`hazards.test.js` already tests the passage rule:

- `eligible()` — gating: nothing before `minDistance`, `once` never twice, a
  per-entry cooldown honoured.
- `planStage(spec, world)` → request list: staggering never puts two requests
  within `SPAWN_GAP`; `side: "behind"` is always behind; `abreast` always leaves
  `gapLanes` lanes clear.
- **The invariant that matters**: drive a simulated run through every catalogue
  entry and assert `leavesPassage()` still holds after every staged placement.
  The narrowing is the one feature in the game whose whole point is to approach
  that bound, so it is the one that must be pinned against it.
- **The shop visit is never lost.** A simulated run past several `SHOP_INTERVAL`
  milestones, with a rolled encounter deliberately live across each one, fires
  the `shop` handoff exactly as many times as milestones were crossed — late,
  never skipped. This is the regression that folding the hauler in could
  plausibly introduce, so it is the one the suite must own. `test/economy.test.js`
  is where the shop cadence is already reasoned about.
- **Density always comes back.** Every exit path from every catalogue entry —
  members killed, `duration` elapsed, `live()` false, `reset()` mid-encounter —
  leaves both multipliers at 1.
- A `FOCUS`-style export (`eventtypes.js`'s `FOCUS = []`) so a session tuning one
  encounter sees only that one — and asserted empty by the suite, for the reason
  `cartypes.js` gives: "gang never appeared" is a much worse error message than
  "FOCUS is still set".

## Follow-ups, deliberately out of scope

- **The car editor** (`tools/car-editor/`) tunes essentially every balance number
  in the game; the event catalogue's weights, distances and cooldowns belong
  there as a sixth tab. Not part of the first PR — the catalogue's shape should
  settle first.
- **Boss car types.** `bossshapes.js` holds finished artwork with no
  `cartypes.js` record, on purpose (see its header). The `warband` entry above
  needs one such record to exist; that is the boss session's work, and this
  system is what will be waiting for it.
