# Phase 7 — the city as a map layer

Date: 2026-08-07

## Purpose

Phase 7 ("Surroundings B: richer lit / parallax city") is the open roadmap item,
and today the floor is buildings on an empty grid. This document breaks the rest
of it into **sub-phases that each ship on their own**, so the city can be built a
PR at a time without any one of them being a rewrite of the last.

The target look is **not a photographic city**. The fiction is that the driver is
jacked into a deck and the world is rendered *for* them, so the floor should read
as a **tactical map**: symbolic blocks, simplified streets, dot-sized cars,
markers and signals — 80s cyberpunk wireframe, not scenery.

## What already exists

Two pieces of the current design are load-bearing for everything below, and
neither needs changing:

- **`citygrid.js` owns placement.** The floor is divided into square PLOTS
  (`PLOT` = 128 = `CELL` 64 x 2), and what occupies a plot is a pure function of
  its `(bx, by)` index — so the city is infinite, identical on every pass, and
  needs nothing generated or freed. `reserve()` (`src/game/citygrid.js:70`) is an
  explicit, currently-empty hook for plots claimed by something *other than* a
  building, and buildings automatically stop being placed on a claimed plot.
  **Every sub-phase below that puts something on the ground goes through it.**
- **`scenery.js` owns drawing**, and the floor is *periodic in y and static in x*.
  That is why the grid is one pre-rendered tile blitted at a phase offset — 2.35ms
  of re-stroking down to ~18µs. Anything else sharing that property is free the
  same way.

At 600x800 the plot walk is ~8 rows x 5 columns = ~40 plots per frame. That one
walk is the budget for *all* the plot types added below; none of them adds a
second pass over the floor. (Buildings now walk a finer LOT grid within this —
see the correction below — but streets, and anything else that claims ground
a whole plot at a time, still only need the plot-level walk this number
describes.)

## Correction — buildings site on LOTS, not PLOTS (mid-Phase-7)

7a, 7b and the finer-grid change each landed independently and, together,
left the floor's scale disagreeing with the buildings standing on it: a
128-wide PLOT held exactly one building, floating at its centre with an even
gap on every side — scattered boxes on a mesh, not blocks. This is a
correction to the shared assumptions above, not a new sub-phase, since it
touches nothing any sub-phase below depends on:

- **`citygrid.js` still owns placement**, but a PLOT now subdivides again
  into `LOT_SUBDIV` x `LOT_SUBDIV` LOTs (`LOT_SUBDIV = 2`, so `LOT = CELL =
  64`) — the unit a building actually stands on. `reserve()` is unchanged:
  streets still claim a whole PLOT, and every LOT inside a claimed PLOT
  inherits that claim. A LOT sites its building **flush against whichever
  edge faces a street** (known from the index alone, via `isAvenueCol`/
  `isCrossStreetRow` on the neighbouring PLOT) instead of centring it, so a
  block presents a built edge to the street with open ground behind — a
  corner LOT sites into the corner. The flush-not-margined siting matters:
  a non-zero, non-grid-multiple margin looks like a building floating off
  the mesh once it's pushed close enough to a kerb to matter.
- **The footprint catalogue was rebalanced, not grown**: `sprites.js`'s
  `variantOpts` now sizes `w`/`d` to fit a LOT (max 48x40) rather than the old
  PLOT (max 90x58); `height` stays at its old 24-96 range on purpose — free
  vertical variety is what keeps a denser skyline from reading as uniform.
  `BUILDING_VARIANTS` is still 24.
- **The density target was re-derived, not eyeballed**: subdividing shrinks
  the mean footprint far more than it grows the eligible-lot count, so
  holding the OLD building-count target would have made the city read
  *sparser*. `citygrid.js`'s `BUILD_CHANCE` now targets holding built AREA
  roughly constant instead (~3.4 buildings per 150 world units, up from 1.3 —
  see its own comment for the arithmetic).
- **A pre-existing alignment bug surfaced and was fixed in the process**:
  `isCrossStreetRow(by)` and the grid tile's actual painted ribbon (via
  `gridPhase`/`ARTERIAL_PERIOD`) had silently disagreed by a whole PLOT since
  7a — invisible with one centred building per plot (a wrongly-excluded plot
  just stood empty), glaring once siting started pushing footprints flush
  against what `reserve()` believed was the boundary. Fixed by a `+1` in
  `isCrossStreetRow`; guarded by a new invariants.test.js assertion that
  cross-checks it against `crossStreetBands()`'s actual screen output rather
  than trusting the two modules' comments to keep agreeing.
- **Cost, measured**: the lot walk is ~160 lots/frame (up from ~40 plots),
  but `scenery.render()` as a whole measured ~0.25-0.26ms/frame after this
  change against ~0.27-0.29ms/frame before (rAF-saturation method) — flat,
  since the extra walk is mostly cheap index checks on lots that turn out
  empty or street, not extra sprite blits. Still comfortably under the
  ~0.5ms budget below; no culling added.

**Second pass — flat geometry, higher density.** Sited-on-lots fixed scale
and alignment, but reviewing it in the browser turned up two more things a
correction is the right place for, not a new sub-phase, since neither changes
what any sub-phase below depends on:

- **Windows removed.** `drawWallWindows` (and the `lit`/`seed` machinery that
  fed it) is deleted from `sprites.js`'s box and every shape in
  `buildingshapes.js`. The design doc's own Purpose section calls for a
  tactical map read — "symbolic blocks... not scenery" — and a window grid is
  photographic detail working against that, more so as buildings get smaller
  and denser. Buildings are now flat-shaded silhouettes only.
- **`BUILD_CHANCE` retargeted from area-preservation to near-full occupancy**:
  0.325 -> 0.85. The first pass's target (hold built area roughly constant
  against the pre-lot city) was the wrong thing to preserve once the actual
  complaint was "the map still looks empty between the avenues" — a real city
  block doesn't leave lots empty for texture. 0.85 realizes as ~0.38 of ALL
  lots built (eligible fraction is still 0.45, unchanged — see above), against
  ~0.15 before. Measured via `scenery.js`'s `visibleBuildings`: mean ~70
  buildings/frame at 600x800 (range 56-81), up from ~27 (range up to 41).
  `scenery.render()` as a whole re-measured at ~0.36ms/frame (rAF-saturation
  method) — up from ~0.25-0.26ms, not flat this time, since most of the extra
  buildings are real blits rather than cheap empty-lot checks — but still
  under the ~0.5ms budget below, so still no culling. `LOT_SUBDIV` (still 2)
  was not revisited: the density goal was reached through `BUILD_CHANCE`
  alone, without re-running the field-of-sheds risk a finer subdivision
  carried the first time it was tried.

## Two constraints that apply to every sub-phase

**Colour discipline.** `palette.js` is load-bearing: green is the world, red and
amber are *gameplay faction*. A floor traffic dot in amber would compete with real
traffic in the half-second faction read the palette exists to protect. **The whole
city layer stays in green shades**, and the map layer distinguishes itself by
brightness, dash pattern and motion instead of hue. New colours here go in the
green family in `palette.js`, next to `FLOOR_GRID`.

**Amended by 7f.** "The whole city layer stays in green shades" was true
through 7e and stops being literally true once sectors ship: the WORLD now
cycles through a small, fixed set of hues (green, azure, teal, violet), one
at a time, for as long as a sector lasts. What survives unchanged is the rule
this constraint actually exists to protect — gameplay faction colours
(red/amber, plus the player's own cyan and the HUD/SYS LOG's green) are
invariant across every sector, asserted directly in the test suite. Read
"stays in green shades" from here on as shorthand for "stays out of the
faction hues", not as a claim about a single fixed palette; see 7f's own
section for the mechanism (`palette.js`'s `setSector`) and exactly where the
line is drawn.

**Performance.** The README's three rendering rules are the spec, not advice.
Restated for this work:

| Property of the thing being drawn | What it must be |
| --- | --- |
| Periodic in y, static in x | Baked into a tile, blitted at phase |
| Bounded set of distinct looks | A sprite-cache entry, blitted |
| Genuinely dynamic per frame | No `shadowBlur`, batched into one path per colour |

The whole city layer should land **under ~0.5ms/frame** against the current
sub-1ms total. Each sub-phase below is individually measurable against that, and
each one should be measured — by saturating rAF throughput, not inside it (see
the profiling traps in the README).

---

## Sub-phase 7a — Street network

**Goal.** The floor reads as *blocks* rather than scattered boxes. This is the
unlock: the negative space is what makes the eye interpret the buildings as a
city, and 7b, 7d and 7e all want somewhere to attach.

**Placement.** `reserve()` claims two new plot types, deterministically from the
index: an **avenue** every N plot columns, a **cross-street** every M plot rows.
With 5 plot columns on a 600px floor, every 3rd column gives 2 avenues on screen.

**Drawing.** Both are periodic-and-static, so neither costs a per-frame path.
Note that `CELL` divides `PLOT` divides the arterial period, which means the grid,
the avenues and the cross-streets can all live in **one tile** — the existing grid
tile, grown from `H + CELL` tall to `H + ARTERIAL_PERIOD` and blitted at the
arterial phase. That keeps the floor at **one `drawImage` per frame**, exactly
where it is now. Memory goes ~2MB → ~3.1MB at 600x800.

Look: a wider dim band, the floor grid suppressed inside it, a brighter dashed
centre line.

**Watch for.** Claiming plots shrinks the pool buildings roll against, so
`BUILD_CHANCE` needs raising to hold the skyline at its current density — the
constant's comment documents the density it was tuned to, and that is the number
to preserve.

**Done when.** Streets are visible, buildings never stand in one, the floor is
still one blit, and the grid-phase test still passes against the direct re-stroke.

---

## Sub-phase 7b — Traffic dots

**Goal.** The city is *alive*. This is the largest perceptual return in the whole
phase and it depends only on 7a.

**Approach — do not simulate.** A car is a phase, not an entity:
`pos = (t * speed + offset) mod laneLength`, a pure function of time and lane
index, in keeping with the rest of the floor being a pure function of position.
Two lanes per street running opposite directions, slightly different speeds.

**Cost.** 2x4px rects, **no `shadowBlur`**, every dot batched into a single path
with one `fill()` per colour. 60–80 dots should land around 0.03ms.

**Why the avenues matter most.** Dots running *with* and *against* the player at a
rate different from both the road and the floor parallax is what sells the depth —
more than any static detail on this list.

**Done when.** Dots run both directions on both street kinds, the layer is 1–2
fill calls, and the frame cost is measured rather than assumed.

---

## Sub-phase 7c — Drone air traffic

**Rejected first: a far field.** The original plan here was a third, dimmer,
static parallax tile above the floor (~0.15, against the floor's 0.5) standing
in for a distant skyline — one more pre-rendered tile, one more blit, cheapest
depth available on paper. It was built, looked at in the browser, and
rejected. The reason is worth keeping on record so it doesn't get proposed
again on the strength of its own "cheapest depth available" pitch: a **static**
layer is a weak depth cue in this game. What actually sells depth is a
**discrete object moving at a rate different from everything else** — which is
exactly why 7b's traffic dots, not the street network or the buildings, are
the sub-phase this doc already calls the largest perceptual return in the
whole phase. A dim motionless tile doesn't borrow any of that; it's scenery
sitting still behind other scenery sitting still.

**Goal, restated.** Depth, and motion in the one band of the frame that still
has none: the sky between the floor (0.5) and the elevated road (1.0).

**Approach.** A layer of small flying drones at `DRONE_PARALLAX` — between the
floor and the road (~0.65–0.8; shipped at 0.72, tuned by eye) — drawn in a new
`src/game/drones.js`, not folded into `scenery.js`. Same rule 7b's traffic
dots follow: **a drone is a phase, not an entity**. Position is a pure
function of time and index, reusing `scenery.js`'s own clock (now exported)
rather than keeping a second one, so the layer freezes exactly when the
floor's traffic dots do.

Unlike ground traffic, drones are **not locked to the street grid** — nothing
constrains them to an avenue or a cross-street the way tarmac constrains a
car. Each flight line gets a heading and speed off a small, fixed, index-keyed
table (deliberately kept off axis-alignment), so lines cross the grid
diagonally at their own angle. That, more than anything else on this list, is
what reads as *air* traffic rather than as more dots. Bounding the count still
follows 7b's own rule: positions are generated only within the visible span
(closed-form, via the same line-of-sight arithmetic `laneDotPositions` already
does for an axis-aligned lane, generalised to a diagonal one and exported for
reuse) — never a loose modulo over an invented path length, and a drone past
the edge of the screen costs nothing.

**Look.** A 3px body plus a 1-2px blinking nav light (another phase off the
same clock — the cheapest and strongest "aircraft" cue available at this
scale), loose 1-3 drone formations (an index grouping, not per-frame state),
and a dim ground-shadow marker drawn on the floor. The shadow's naive
mechanism — the same "one world point, two parallax rates" idea every other
depth cue on this floor already uses — turns out to be **unbounded** in raw
distance driven (0.22px of drift per world unit at this layer's parallax gap,
which is already 1000+px within the opening couple thousand units of a normal
run). Saturated through a `tanh` cap instead: a small, genuinely growing gap
right as the player starts driving, capped at a fixed on-screen maximum for
the rest of the run rather than drifting off into nowhere. Worth knowing if
this pattern gets reused elsewhere — any "same point, two rates" cue needs a
cap the moment `distance` is unbounded, which on this floor it always is.

**Cost.** The first genuinely per-frame path layer on the city floor — no tile
to hide behind, so the README's three rendering rules are hard requirements
here, not advice (see the "Two constraints" section above, and its own
correction below). No `ctx.shadowBlur`; every drone batched into one path per
colour (body, nav light, shadow — three `fill()` calls total, not three per
drone). Measured by the rAF-saturation method: the new layer costs
**~7-12µs/frame** on top of `scenery.render()`'s own ~0.36-0.5ms (unchanged by
this sub-phase — `scenery.js` only gained two exports), comfortably inside the
~0.5ms city-layer budget with room to spare.

**Done when.** Drones fly their own diagonal lines across the sky, formations
and blink are visible at speed, the ground shadow separates from its drone
without ever drifting off-screen, and the frame cost is measured rather than
assumed.

---

## Sub-phase 7d — Nodes and markers

**Goal.** The first thing that says "map" rather than "city". Depends on 7a for
somewhere sensible to sit (intersections).

**The doc's own contradiction.** "A new reserved plot type… nodes on
intersections" can't both be true: `reserve()` already claims an intersection
plot as `CROSS_STREET` first, on purpose (an intersection plot is street
ground, and `scenery.js` paints avenue/cross-street ribbons from
`isAvenueCol`/`isCrossStreetRow` independently of `reserve()` — claiming it for
a node punches a hole in the ribbon those two derivations still have to agree
on). Resolved by building **two different things**, because they're right for
two different jobs:

- **Registration ticks — baked into the floor tile, free.** A small uniform
  mark at every avenue × cross-street intersection, drawn once into
  `scenery.js`'s existing grid tile (the same one 7a's ribbons already share)
  and blitted with it. Since the tile is periodic in `ARTERIAL_PERIOD` and
  static in screen x, "every intersection" is one geometry pass over the tile,
  not a per-intersection draw call — literally zero per-frame cost. Uniformity
  is the point here: identical marks at every crossing read as a map's own
  registration grid (survey ticks, a radar bezel), which is a different job
  from a facility marker and doesn't compete with it.
- **Distinguished nodes — a real `reserve()` claim, sprite-cached.** A new
  `NODE` plot type, claimed in `reserve()` **after** both street checks, so it
  can only ever land on ground a street would otherwise have left for a
  building. These are the ones that read as *facilities*, and the ones 7e's
  conduits/pings will attach to.

**Placement.** `NODE` is claimed at PLOT granularity (`citygrid.js`'s
`reserve()`), not LOT — a facility takes the whole 128×128 block, not a
building-sized fraction of it. A new `frontsStreet(by)` gates eligibility:
`isCrossStreetRow(by - 1) || isCrossStreetRow(by + 1)`. It only checks the y
axis, and that's not an oversight — `AVENUE_COLS`' own period (3) means every
column that isn't itself an avenue already has one directly beside it (the
period equals avenue-plus-both-neighbours), so an x-axis check here would
never once come back false. The one axis where a plot can genuinely sit
buried mid-block — no street on either side — is y, at `CROSS_STREET_ROWS`'
coarser period (4), and that's what this excludes.

**Rarity, the single most important tuning decision here.** `NODE_CHANCE =
0.06`, applied to the street-adjacent, unclaimed pool. Tuned by sampling
`visibleNodes()` (mirroring how `BUILD_CHANCE`'s own density comment is
checked): mean ~0.9–1.2 nodes/frame at 600×800 across a wide sweep of scroll
positions and screen widths (400–700px), 0 on roughly a third of frames, max
observed 5 out of 68,000+ samples. A first pass at 0.09 measured mean ~2.0
with a tail out to 7 — visibly too many to read as individually rare — and
was pulled back down. See `citygrid.js`'s own `NODE_CHANCE` comment for the
arithmetic.

**Density effect on buildings, measured.** A `NODE` claim removes all 4 lots
in its plot from the building roll, not just the one plot — so the eligible
pool shrinks a little. Measured (a wide `lotAt` sweep, mirroring
`BUILD_CHANCE`'s own sampling): eligible-lot fraction 0.4854, realized-build
fraction 0.4123, `visibleBuildings` mean ~65/frame (range 52–83) — down from
the pre-7d ~70/frame (range 56–81), about 7% fewer. Small, as predicted;
`BUILD_CHANCE` wasn't touched.

**Look.** Flat on the ground plane, no extrusion — buildings go up, a node
marker lies flat, and that contrast is what makes it read as annotation
rather than architecture (`src/game/nodeshapes.js`, new module, alongside
`buildingshapes.js`). Corner brackets (four short L's hugging a bounding
square — a closed outline would silhouette like a building footprint) plus a
centre glyph, diamond or crosshair. `NODE_VARIANTS = 6`: three bracket sizes
× two glyphs. Rendered with `neonStroke`'s full multi-pass glow — allowed
here, unlike 7b/7c's live per-frame paths, because a node is baked into its
sprite once (`sprites.js`'s `drawNodeVariant`, the same `getSprite`/
`blitSprite` path `drawBuildingVariant` uses) and blitted thereafter, exactly
the case `spritecache.js` exists for. Two new green-family palette entries
(`NODE_BRACKET`, `NODE_GLYPH`), brighter than a building's own `GREEN`, so a
node reads as the crispest thing on the floor plane.

**Draw order.** Nodes draw with the floor, right after the grid blit and
before the building walk (`scenery.js`'s `render()`) — a building nearer the
camera can still visually overlap a node if its footprint or glow padding
reaches across the plot boundary, even though a `NODE` plot never itself
hosts a building.

**Cost, measured.** The registration ticks are provably zero per frame: their
placement (`scenery.js`'s exported `tileIntersections()`) is only ever called
from inside `floorGridTile()`, which is cache-gated on canvas size and
rebuilds once, not per frame. The node layer itself — `visibleNodes()` (the
plot-level walk) plus every `drawNodeVariant` blit it triggers — measured in
isolation, warmed, across the same wide scroll sweep used for the rarity
tuning: **~2µs/frame**, consistent with the ~1-2 blits/frame the rarity
target implies and the README's own cached-blit figures (a building blits at
~1.3-8µs; a node blit measured ~1µs, cheaper still — its sprite canvas is
smaller). That number is reproducible and isolated from the rest of the
render pipeline.

The end-to-end `scenery.render()` total is harder to pin precisely in the
sandboxed browser this was measured in: the rAF-saturation method (README's
own profiling-traps section) gave a clean **~0.39ms** baseline for the
pre-7d code (six warmed samples, JIT warmup discarded, median 0.398ms) — in
line with the README's previously-recorded ~0.36–0.5ms range from a real
GPU-accelerated browser. Re-measuring the SAME code path after adding 7d
through a full `render()` call, rather than the isolated node-layer
measurement above, showed session-to-session variance (roughly 0.6–1.0ms)
that persisted even with warmup discarded and did not track with node count,
sprite-cache size (confirmed bounded and stable at 54 entries — 48 building +
6 node), or any change traceable to this sub-phase's own code; an earlier,
uncontrolled sample of the unmodified pre-7d baseline showed the same order
of variance (~1.0ms) before a cleaner methodology (discard-first-sample,
median-of-six) brought it back down to ~0.39ms. Given the isolated,
controlled measurement of the actual new code (~2µs) is reproducible and
the variance is not, the honest reading is: **the pre-7d baseline stays
~0.39-0.5ms (this environment's noise floor sits well below the ~0.5ms
budget), and 7d adds on the order of microseconds on top of it** — nowhere
near enough to be the reason to start culling. A follow-up should re-run this
specific comparison in a real (non-sandboxed) browser before treating the
~0.6-1.0ms figures as real; they don't survive the isolated component
measurement's cross-check.

**Done when.** Registration ticks sit on every intersection at zero per-frame
cost (baked in the tile). A small number of distinguished nodes (~1/frame on
average, rare enough to notice) read clearly as facilities, not buildings.
No street ribbon has a hole in it (`reserve()`'s ordering — `NODE` checked
after both street claims — asserted directly in `invariants.test.js`, not
just inferred from node placement in isolation). The sprite cache stays
bounded (`NODE_VARIANTS` pinned at 6, asserted). All of the above verified
in the browser and against the test suite.

---

## Sub-phase 7e — Links and pings

**Goal.** Signals moving between places — the "symbolic signal from somewhere"
idea. Depends on 7d. Built as three pieces rather than two: this doc originally
scoped 7e as pure decoration, but the in-game SYS LOG (`src/engine/console.js`)
landed after this doc was written, and it turns a ping from a pretty circle
into information — a ping that coincides with a console line reads as the world
talking to you, not a screensaver. The three pieces (conduits, pings, the
console voice) shipped together because the third is what justifies the first
two.

**The doc's own design didn't survive contact with 7d.** "A dashed line
between two nodes" was the original plan. `NODE_CHANCE` is 0.06 of
street-adjacent unclaimed plots (7d's own section), so two nodes on screen *at
once* is uncommon — a conduit that only exists in that coincidence would
almost never be drawn. Shipped instead: a conduit anchors at **one** node and
runs off along a heading derived from that node's own plot index, to a
destination that is usually off screen, clipped to the viewport. This is both
more available (every visible node gets a conduit, not just a rare pair) and
better fiction — a signal heading toward the horizon reads as a city-wide
network, where a closed A-to-B line reads as two boxes with a wire between
them. If two nodes happen to be on screen with headings that point at each
other, that's a nice accident; nothing engineers it.

**Three effects, all cheap:**

- **Conduits** — a dashed line running off a node's own heading, clipped to the
  viewport, with a single bright packet dot travelling along it. The packet is
  a phase, not an entity: `pos = (t * speed + offset) mod length`, the same
  shape `laneDotPositions` already gives the floor's traffic — reused via
  `scenery.js`'s exported `clock` rather than a second one, so the whole city
  still freezes together.
- **Pings** — a stroked circle expanding out of a node and fading, radius and
  alpha derived deterministically from the node index and the clock (a short
  active window inside an otherwise idle per-node cycle — no state needed to
  know a node is *currently* pinging, only to announce that it *just started*,
  see below). 1–2 alive at once across the whole screen, by construction: node
  rarity (7d's ~1/frame) times a short duty cycle inside each node's own
  period. One `arc()` each, stroke only.
- **The console voice** — when a ping *begins*, push one SYS LOG line: a
  stable callsign (derived from the plot index by the same hash trick
  everything else on this floor uses, so a given node reads the same name
  every time the player passes it) plus a short status, e.g.
  `NODE 7F-2 // UPLINK`, `GRID-A4 // SWEEP`. Always `HINT` severity — never
  `WARN`/`CRITICAL`, which `console.js` maps to `NEUTRAL`/`HAZARD`, gameplay
  **faction** colours this floor is not allowed to use (see "Two constraints"
  above). Rate-limited hard (one line roughly every several seconds) and
  suppressed while `console.js`'s own `isBusy()` says the log is showing
  something else — a small read-only accessor added to `console.js` for
  exactly this, since the city module has no business guessing busy-ness from
  outside. Real gameplay call-outs (hull damage, pickups) are the log's actual
  job; city chatter has to lose that contest, not compete for it.

**The one place on this floor that keeps state.** Every other layer here —
conduits, pings, and everything in 7a-7d before them — is a pure function of
position or time: same (clock, index) in, same answer out, nothing stored.
"A ping just started" is inherently an *edge*, and detecting an edge needs to
remember which side of it the last frame was on. `game/links.js` keeps exactly
one scalar for this — the identity of whichever node is the currently active
announcement (or none) — so a ping that stays alive across many frames
announces once, and the same node's next cycle (after the log has gone quiet
on it in between) announces again. Reset alongside everything else `newGame()`
tears down, the same place `console.reset()` is already called from.

**Cost, measured.** Not the first genuinely per-frame paths on the floor after
all — 7c's drones got there first (see the "Order, and why" section's own
correction below), but the same rule applies: no `ctx.shadowBlur` (the glow is
`neonStroke`'s own overdraw), batched by colour (every conduit's dash in one
path, every packet dot in one fill; every ping arc gets its own `stroke()`
call rather than a shared one, since a ring's alpha fades over its own
lifetime and a single path can only carry one alpha for everything drawn in
it — but pings are independently bounded to "1-2 alive at once" regardless of
node count, so this never scales the way the dash/packet batching exists to
bound), and bounded by the visible node walk (`visibleNodes`) so a
conduit/ping belonging to an off-screen node is never even constructed.

Measured by the rAF-saturation method in a real (non-sandboxed) browser, per
this doc's own note on 7d's measurement environment — six warmed samples,
first-sample warmup discarded, median taken, mirroring 7d's own methodology:
`links.render()` alone measured **~2.5-4.2µs/frame** (median ~3.4µs) across a
wide distance sweep (60000 world units, 733-unit steps, so both zero-node and
multi-node frames are represented) — cheaper even than 7c's drones (~5.2µs in
the same environment, same run), consistent with nodes being rarer than
drones and a ping/conduit costing at most one extra draw call each per
visible node.

`scenery.render()` alone re-measured at **~460µs (~0.46ms)** in this same
environment (one of six samples came back at ~1.6ms — noise, not signal; see
this doc's own note on this codebase's measurement environment producing
occasional outliers, and the tight cluster of the other five). Combined —
`scenery.render()` + `links.render()` + `drones.render()`, the actual
per-frame city-floor total — measured **~500.67µs (~0.50ms)**, which lands
**at** the ~0.5ms budget this doc sets for the whole layer, not comfortably
under it the way 7d's own addition was. Stated plainly, as the cost section
above asks: **the floor's total no longer has headroom**, and culling
(the README's own "still open" item) becomes 7f's prerequisite rather than a
someday item — the next sub-phase that adds a per-frame cost to this floor
should not assume the margin 7a-7d enjoyed still exists.

**Done when.** All three are on screen and in the log, all three are bounded
in count, city chatter never crowds out a real gameplay call-out, every city
line is `HINT`, and the floor's total is measured (in a real browser) under
budget or, if it no longer is, that is stated rather than assumed away.

---

## Sub-phase 7f — Sectors

**Goal.** The city is infinite but statistically uniform, so a long run has no
shape. Sectors give it one: at a fixed distance interval the world's palette
changes, the deck reads the new sector's name into the SYS LOG, and the
crossing itself is a brief full-screen **rescan glitch** — the deck re-syncing
to a new grid — rather than a blend.

**SUPERSEDES the plan above wholesale.** The original 7f was a faint
per-district highlight quad plus cached corner brackets, with sector labels
either `fillText` (rejected on sight — see the "flagged by 7e" note this
replaces) or baked into a tile/sprite. Once 7e's console voice
(`game/links.js`'s `announce`) shipped, the label question answered itself the
same way this note predicted: a name read out on the EDGE of a crossing,
never painted on the floor at all. What's new relative to that prediction is
the other half — the highlight quad turned out to be the wrong instrument
entirely. A tinted quad says "you are in a different REGION of the same
city"; a palette change says "the city itself is different now", which is
the bigger, cheaper, more legible signal, and it makes the quad redundant
rather than complementary. So 7f shipped as: **a sector-keyed palette
(`engine/palette.js`'s `setSector`), a rescan glitch (`game/sectors.js`), and
the console announcement** — no quad, no bracket sprite, no `fillText` anywhere
in the render pass.

**The period.** The floor tile repeats every `ARTERIAL_PERIOD` in FLOOR-WORLD
units (floor-world = distance × `FLOOR_PARALLAX`, `scenery.js`), so a sector
boundary that doesn't land on a tile boundary would put a colour seam through
every tile. `citygrid.js`'s `SECTOR_PERIOD` is therefore defined as a whole
multiple of `ARTERIAL_PERIOD` — shipped at 1×, the shortest legal value,
because crossings that come often are what a test harness (and a design
review) needs; a real run's pacing is `SECTOR_PERIOD_MULT`, one constant, for
later. Sector index is `citygrid.js`'s `sectorIndex(fDist)`, a pure function
of position like everything else on this floor — unbounded, the same
"geometry here, palette count elsewhere" split `plotAt`/`lotAt` already keep.

**The palette split.** `engine/palette.js` gained a table of `SECTOR_COUNT`
(4, shipped: green, azure, teal, violet) palettes and a `setSector(index)`
that reassigns a set of `export let` bindings — a live-binding swap, not an
accessor, so every existing call site (`scenery.js`, `sprites.js`,
`buildingshapes.js`, `nodeshapes.js`, `links.js`, `road.js`) picks up a
crossing with zero changes at the call site itself. What's IN the table is
exactly the floor, the buildings, the nodes, the city-network signals
(conduits/pings) — **and the road**, added after an early review caught the
first cut leaving the elevated ribbon on its own fixed green while the city
below it recoloured, which read as two disagreeing layers rather than one
world changing. What's deliberately OUT: gameplay faction colours
(PLAYER/ENEMY\*/NEUTRAL\*/HAZARD — the half-second faction read this whole
project's palette discipline protects) and the SYS LOG/HUD's own green
family, which has to stay a fixed reference point precisely because
everything else is now allowed to move. See `palette.js`'s own "why the split
falls exactly here" comment for the full reasoning, including the one trap a
live-binding swap doesn't fix for free (a module that captures a colour into
its own structure at import time — checked project-wide; `console.js`'s own
`COLORS` table does this and is fine, on purpose, for exactly the reason
above).

**Caches, multiplied, not replaced.** `sprites.js`'s building and node sprite
keys gained a `sector` field (`bldg|v|lean|sector`, `node|v|sector`) — 54
cache-able looks becomes 54 × `SECTOR_COUNT`, still cheap, still nowhere near
the car catalogue's 160-sprite/~7MB budget the same file's header warns
against multiplying. The floor's own tile — one big canvas, not a per-variant
sprite — gets a small, HAND-bounded cache instead (`scenery.js`'s
`makeBoundedCache`, capped at 2): a crossing needs the OUTGOING sector's tile
to stay valid for whatever hasn't scrolled past the boundary yet while the
incoming one builds, and 2 is exactly "one on either side of a crossing", no
more. The road's own strip cache (`road.js`) takes a third approach again —
a full `tiles.clear()` on any sector change, because a strip tile is cheap
enough (~10 of them, each a fraction of a full paint) that a targeted
per-key scheme isn't worth the bookkeeping, and the whole set rebuilding over
a few frames hides under the same rescan the floor's own rebuild does.

**A bug worth recording, because the fix is the interesting part.** The
first working version computed the tick that feeds `setSector()`
(`game/sectors.js`) as `Math.round(distance * FLOOR_PARALLAX)` straight off
the raw simulation `distance` — which LOOKS identical to what `scenery.js`/
`road.js` compute for their own cache keys, but isn't: those compute
`Math.round(Math.round(distance) * FLOOR_PARALLAX)`, because `main.js` rounds
the camera to a whole pixel ONCE (`camY`) and hands that rounded value to
every render-side layer (see the README's own "the camera is quantised"
rule). The two roundings agree almost always and disagree by exactly 1 on
roughly 1 in 25 sector crossings (found by simulating a wide speed sweep) —
and on the tick they disagree, `setSector()` fires for a DIFFERENT sector
than the one the SAME frame's cache keys use, baking the wrong sector's
colour into a building or floor tile that then has no way to self-correct
(`spritecache.js` has no eviction). Reproduced live as buildings staying one
colour after the road and floor had already moved on — caught by hand in the
browser, confirmed by simulating the two formulas across a speed sweep, fixed
by making `sectors.js` round the same two-step way everything downstream of
`distance` has to, and pinned by a test that drives `sectors.update()` across
a wide speed range and asserts its palette pick agrees with the exact `camY`-
based sector `scenery.render()`/`road.render()` would use that frame.

**The fix above was a patch, not a cure — the cause stayed in the tree.**
`sectors.js` fixed its own copy of the two-step rounding, but the same
`Math.round(distance * FLOOR_PARALLAX)` expression was independently
hand-copied at four more call sites (`scenery.js`'s own `render()`,
`drones.js`'s `droneField()`, and two in `links.js` — `announce()` and
`render()`), each one correct today only because of who happens to call it.
A follow-up PR pulled the two-step rounding into one exported function,
`scenery.js`'s `floorDist()`, and converted all five sites (including
`sectors.js`'s own hand-rolled version) to call it. The property that makes
one function safe for both the simulation loop's raw `distance` and the
render loop's pre-rounded `camY` is that the two-step form is **idempotent
under pre-rounding**: rounding an already-integer value is a no-op, so
`floorDist(camY) === floorDist(distance)` for the same tick regardless of
which one is handed in. That's what actually closes the bug class — there is
no longer a wrong value to pass, rather than a discipline of remembering to
pass the right one.

**This is the third time this exact shape of bug has shown up in this
sub-phase.** `isCrossStreetRow` disagreeing with the tile's own ribbon phase
by one whole `PLOT` (citygrid.js's own `+1` comment) was two independent
derivations of "where a cross-street falls" drifting apart. The drone
shadow's gap needing `Math.tanh` saturation (`drones.js`'s
`DRONE_ALTITUDE_MAX`) was two parallax rates applied to the same world point
with nothing reconciling how far apart their results could grow. And this
bug is two roundings of the same distance, computed independently at up to
five call sites, agreeing by construction almost everywhere and silently not
on the ticks that matter. The general lesson: on this floor, a value that
looks like it can be recomputed cheaply wherever it's needed is exactly the
value that should be computed once and threaded or exported instead — cheap
recomputation is how two derivations of one quantity end up drifting apart
without either call site ever being wrong on its own terms.

**The period, tuned.** `SECTOR_PERIOD_MULT` shipped at 1x for the reasons
above (a test harness value); the real-run pace was set afterward, by ear,
at 6x — a crossing lands roughly every ~10s at the player's cruising top
speed and ~15s at a more typical cruising pace, comfortably inside the
"every 10–20s, not constant" cadence 7g's own (now-superseded) deck-glitch
bullet independently asked for. See `citygrid.js`'s own `SECTOR_PERIOD_MULT`
comment for the two ends of the range this was checked against before
settling in the middle.

**The rescan.** Snap, not blend — the palette is already different by the
time the frame draws (`setSector()` runs in `update()`, before `render()`
starts), so the glitch's only job is making that snap read as deliberate. It
also hides the one real cost a sector change causes: the floor tile and the
road's strips both need rebuilding for the new palette, and nobody notices a
rebuild-shaped hitch during a glitch that already looks like a deliberate
tear. The tear itself (`game/sectors.js`'s `renderGlitch`) reads a few
horizontal strips back OUT of the already-drawn frame and redraws them a few
px offset — `drawImage(canvas, ...)` with the live canvas as its own source,
which stays on the GPU-accelerated path (no `getImageData`/`putImageData`,
the README's own flagged trap) — plus a brief near-white flash fading with
the same timer. Bounded to `GLITCH_DURATION` (0.35s) and gated by a single
`if (glitchTimer <= 0) return` at the top, so the idle cost is one comparison.

**Measured, real browser, rAF-saturation, six samples, first discarded,
median taken (same method 7d/7e used):** `scenery.render()` + `links.render()`
+ `drones.render()` + `road.render()` together — now including the road,
whose own cache also reacts to a crossing — measured **~0.26–0.59ms across
six samples, median ~0.39ms**. Read next to 7e's own ~0.50ms figure as a data
point from a different session, not a claim that headroom came back: this
file's own profiling-traps section is exactly the caution against trusting
either number too far past its own measurement. `renderGlitch` itself costs
**~0.13µs idle** (confirms the early-return is doing its job) and **~0.59ms
while firing** — paid for `GLITCH_DURATION` (~21 frames) once per crossing,
which at 1× `SECTOR_PERIOD` is often but, once `SECTOR_PERIOD_MULT` is raised
for real pacing, will be rare.

**Purple, tried and kept.** The one candidate this doc's own "two constraints"
section would flag as risky — neon purple sitting close enough to magenta/red
to compete with the player's thruster or the hazard family — shipped as
sector 3, deliberately blue-leaning (hue ~258°, not a redder magenta-purple),
and judged in the browser with hostile amber/civilian traffic on screen
across several crossings, not on an empty road: it reads as clearly its own
hue, distinct from `PLAYER_THRUST`'s magenta and `HAZARD`/`ENEMY`'s red at
speed. Worth re-checking if a future palette pass pushes it warmer.

**Deferred, not dropped:**
- **Per-sector density.** Varying `BUILD_CHANCE`/`NODE_CHANCE` per sector so a
  sector reads as a district (denser, sparser) rather than a pure colour
  filter over the same city — two constants, and citygrid.js's `reserve()`/
  `lotAt()` already take an index they could hash a per-sector variant out
  of. Left for a polish pass, after colour-only sectors have actually been
  driven and judged, rather than compounding two unproven changes at once.
- **7g's materialisation-on-entry** — buildings wiping in at the screen edge
  via a `clip` — is unrelated to sectors (a different moment: the START of a
  building's time on screen, not a distance boundary) and remains exactly as
  scoped below. Kept separate deliberately, so this sub-phase's diff stays
  reviewable.

**Done when.** The world changes palette at sector boundaries that land on
tile boundaries, the crossing reads as a deliberate rescan rather than a
hitch, the new sector announces itself in the SYS LOG, faction colours are
provably identical everywhere (asserted directly, across sectors well past
`SECTOR_COUNT`), both caches are bounded and asserted, the glitch costs
nothing when idle, the frame cost is measured in a real browser, and the
tests pass. All true as of this sub-phase shipping.

---

## Sub-phase 7g — VR framing

**Goal.** Sell the fiction directly: this world is being *rendered for you*, and
the deck is not perfect. Last, because it decorates everything above.

- **Materialisation. Built.** Buildings and nodes draw in as they enter — a
  bottom-up wipe — instead of simply existing at the screen edge.

  **Spanned in distance, not time**, on purpose: a time-based wipe needs an
  entry timestamp, and that's state this floor otherwise never carries.
  `scenery.js`'s `materialiseProgress(sy)` is a pure function of a lot or
  plot row's own screen-y anchor at the current `fDist` — 0 before the row
  crosses the top edge, 1 once it's `WIPE_SPAN` (60 floor-world units) past
  it, clamped and monotonic in between — recomputed fresh every frame,
  nothing stored, nothing to reset on `newGame()`. `WIPE_SPAN` sits just
  under `LOT` (64), which is what guarantees at most one lot row (and,
  separately, at most one plot row) is ever mid-wipe at once: a stopped
  player always sees a single row resolving, never a band of
  half-buildings. At the design's own ~400 floor-world-units/s reference
  cruising pace that lands the wipe at ~0.3s, matching the original figure;
  ~0.19s at the player's top speed, ~1.0s at the low end of the throttle —
  long at a crawl, but always confined to the one row.

  **The clip isn't scaled by the sprite's own height.** The first version
  did — "the bottom `progress` fraction of the sprite" read literally — and
  the effect was invisible in the browser for most of its span: a sprite
  (glow padding included) is typically 100-170px tall, well over
  `WIPE_SPAN`, so a clip growing as a fraction of that height raced past
  what the canvas's own top-edge clip was already hiding within the first
  ~30% of the wipe, and did nothing more restrictive than an unclipped blit
  for the rest. `sprites.js`'s `drawBuildingVariant`/`drawNodeVariant` scale
  the clip by the row's raw `sy` against the sprite's own height instead —
  an absolute px budget, not a fraction of a number nothing else on this
  floor varies the wipe's speed by — which keeps the clip strictly ahead of
  the natural edge for the whole span. Found by instrumenting the clip
  boundary and comparing it against the canvas edge after the effect
  didn't show up in a real run; see `scenery.js`'s own `materialiseProgress`
  comment and `sprites.js`'s `drawBuildingVariant` for the full account.

  **A leading-edge scanline**, added after the plain clip read as merely
  "quiet" rather than "being rendered": a thin, broken line rides the clip
  boundary, coloured off the sprite's *own* edge colour lightened toward
  white (not a fixed system tint, so it stays in a sector's own hue), with
  loose static flecks scattered in the band not yet revealed, fading as the
  row nears full reveal. Genuinely random every frame (`Math.random()`, the
  same vocabulary `sectors.js`'s own rescan tear already spends) rather than
  a smooth animated sweep — a clean line read as drawn UI, not as a signal
  resolving out of noise. See `spritecache.js`'s `blitSpriteMaterialising`
  for the mechanism.

  **Branches on the common case**, per the design's own ask: `progress >= 1`
  (the ~65-70 already-materialised buildings/nodes a typical frame draws)
  takes the exact `blitSprite` call this layer has always made — no
  `save`/`clip`/`restore`, no scanline. Only the handful of buildings/nodes
  belonging to whichever single row is currently inside `WIPE_SPAN` of its
  own entry pay for anything more, and `visibleBuildings`/`visibleNodes`
  filter out rows at or before their own entry before the fast/slow split
  is even reached — nothing is drawn at `progress <= 0`.

  **Cost, measured** (rAF-saturation, six warmed samples, first discarded,
  median taken — this doc's own established method): `WIPE_SPAN`/`LOT` =
  60/64 of every `LOT` cycle has exactly one row materialising somewhere on
  screen, so "some row is mid-wipe" is the *real* steady state a running
  game sees roughly 94% of the time, not a rare edge case — though "at most
  one row" still holds. `scenery.render()` measured ~0.41ms/frame in that
  realistic state, against ~0.27ms/frame with `fDist` held in the narrow gap
  where nothing is materialising (confirming the fast path itself hasn't
  moved). Both land inside this layer's own pre-7g range (~0.36-0.5ms across
  7d-7f) rather than opening a new one. A first version of the scanline —
  one `fillRect`/`globalAlpha` change per static fragment instead of one
  batched path per pass — measured misleadingly high (~0.9ms) under a
  poorly-warmed benchmark that let real sprite-cache-miss cost leak into the
  timed loop; batching the segments and flecks into two `fill()` calls
  (the same "one path, one fill" rule the traffic dots already follow)
  brought the honest, well-warmed figure back to the numbers above.

  **The optional second beat — a sector-rescan-driven full-city
  re-materialisation — was not built.** The entry wipe alone already reads
  as the strongest cue on this floor; a second, whole-screen version tied to
  `sectors.js`'s own rescan timer would very likely be the same idea spent
  twice, which is exactly the reasoning that retired the original 7g glitch
  bullet below. Left for a future pass to judge in the browser rather than
  built speculatively on top of an effect that already does the job.
- ~~**Deck glitches.** A horizontal band of floor offsetting a few px for two
  frames; a building occasionally rendering as bare wireframe (skip the fills)
  before resolving; a grid column flickering bright. All state, no draw cost.
  Rare and short — every 10–20s, not constant, or it stops reading as a glitch
  and starts reading as a bug.~~ **SUPERSEDED by 7f.** The glitch vocabulary
  this bullet describes (scanline tear, desync, re-materialisation) was written
  for a glitch with no motivation of its own, firing on a bare timer. 7f's
  sector crossing turned out to be exactly the moment that vocabulary was
  always going to be spent on — a rescan that means something (a real event:
  the palette changing) rather than a tic. Building a second, motivation-free
  glitch on top of it would be the same effect twice, so this bullet doesn't
  get built as written; see `game/sectors.js`'s own header for the rescan that
  absorbed it.

**Done when.** Entry pop is gone (buildings and nodes resolve bottom-up
instead of simply existing at the screen edge), it holds up at high speed,
low speed and stopped, fully-materialised blits are provably unchanged (the
fast path stays `blitSprite`, no clip), the steady-state cost is measured
rather than assumed, and it isn't on by default in the asset gallery (the
gallery never calls `drawBuildingVariant`/`drawNodeVariant` with a
`progress` below 1, so this holds by construction). All true as of this
sub-phase shipping.

---

## Order, and why

7a first because nothing else has anywhere to attach without it. 7b immediately
after, because 7a+7b together are where the "symbolic map" impression actually
comes from and everything later is decoration on a floor that already works. 7c is
out of order on theme but in order on value-per-µs. 7d/7e are the map layer
proper. 7f gives the finished map layer a shape a long run can feel (and,
built the way it shipped, absorbs half of 7g's own fiction along the way —
see 7f's own section). 7g is what's left of the fiction, and wants everything
else present to decorate.

**Correction.** The "Two constraints" section above originally reserved
"genuinely dynamic per frame, no tile to hide behind" for 7e. 7c, once it
became drone air traffic rather than a static far field, got there first: it
is the first sub-phase with no pre-rendered tile behind it, and its own
section documents the cost work that implies. 7e still gets there next, on
its own per-frame paths (conduits, pings) — this just corrects which
sub-phase actually crossed that line first.

**7a + 7b is the recommended first PR** — roughly 2 blits and 2 fills for the
whole change, and it is the slice that changes how the game reads.

---

## Phase 7, closed out

7g's materialisation was the last item on this list. Final measured cost —
`scenery.render()` at ~0.41ms/frame in the realistic steady state (some row
always mid-wipe) and ~0.27ms with none — lands inside the same ~0.36-0.5ms
band this layer has measured in every sub-phase since 7d, not a new one.
The whole floor's ~0.5ms budget held across all seven sub-phases (7a-7g),
and the README's own "no culling through 7a-7d" note, re-checked at every
sub-phase since, closes here too: **culling was never needed, for the whole
of Phase 7.**

Three "two derivations of one quantity" bugs and one rejected sub-phase
turned up along the way, worth having in one place rather than scattered
across seven sections:

- **7a's `isCrossStreetRow`** disagreed with the floor tile's own painted
  ribbon phase by a whole `PLOT`, invisible while a plot held one centred
  building and glaring once 7a's own correction pushed footprints flush
  against a boundary that wasn't where the ribbon actually was. Fixed by a
  `+1`, pinned by a test that cross-checks the index math against the
  tile's actual screen output rather than trusting the two to agree by
  inspection.
- **7c's drone shadow** used the same "one world point, two parallax rates"
  idea every other depth cue on this floor relies on, and that gap grows
  unbounded in raw distance driven — saturated with `Math.tanh` once the
  drift was measured rather than assumed away.
- **7f's sector tick** was computed two different ways at up to five call
  sites — a single-step rounding in `sectors.js`'s own `update()` against
  the two-step, camera-quantised rounding every render-side layer actually
  uses — agreeing almost always and silently not on the ticks that
  mattered, baking the wrong sector's colour into a cache entry with no way
  to self-correct. Fixed by pulling the rounding into one exported function
  (`floorDist`), idempotent under pre-rounding, so there is no longer a
  wrong value to pass rather than a discipline of remembering the right one.

The general lesson, stated once in 7f's own section and worth repeating
here: on this floor, a value that looks cheap to recompute wherever it's
needed is exactly the value that should be computed once and threaded or
exported instead. Cheap recomputation is how two derivations of one
quantity end up drifting apart without either call site ever being wrong
on its own terms.

**The one rejected sub-phase** was 7c's original plan — a third, dimmer,
static parallax tile standing in for a distant skyline. It was built,
looked at in the browser, and rejected outright: a static layer is a weak
depth cue here, and what actually sells depth is a discrete object moving
at its own rate, which is what shipped instead (the drones). Two more
sub-phases were *superseded* rather than rejected — the original 7f (a
per-district highlight quad, replaced wholesale by the sector palette once
7e's console voice answered the labelling question first) and half of the
original 7g (the deck-glitch bullet, absorbed by 7f's own sector rescan
once that turned out to be the motivated version of the same vocabulary) —
a different outcome from "built and discarded," but the same discipline:
look at the thing in the browser before trusting the plan on paper.
