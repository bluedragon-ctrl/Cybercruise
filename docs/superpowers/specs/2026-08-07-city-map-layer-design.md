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

**Approach.** A new reserved plot type in `citygrid.js`. Look: corner brackets
plus a small diamond or crosshair. A bounded set of variants → a sprite-cache
entry each, blitted through the same path `drawBuildingVariant` uses.

**Done when.** Nodes appear on intersections, the sprite cache stays bounded
(assert it, as `invariants.test.js` already does for the car catalogue).

---

## Sub-phase 7e — Links and pings

**Goal.** Signals moving between places — the "symbolic signal from somewhere"
idea. Depends on 7d.

**Two effects, both nearly free:**

- **Conduits** — a dashed line between two nodes with a single bright packet dot
  travelling along it. One line, one dot. Extremely 80s-cyberspace for the cost.
- **Pings** — a stroked circle expanding out of a node and fading, phase derived
  deterministically from the node index and time, 1–2 alive at once. One `arc()`
  each, stroke only.

**Watch for.** These are the first genuinely per-frame paths on the floor. They
stay cheap only while they stay *few* and stay unblurred — the glow comes from
`neonStroke` overdraw, never `shadowBlur`.

**Done when.** Both are on screen, both are bounded in count, and the floor's
total is still measured under budget.

---

## Sub-phase 7f — Zone highlights and sector labels

**Goal.** Flavour and legibility — the map has *regions*, and they have names.

- **Zone highlight** — a district tinted with a very faint quad plus corner
  brackets. One `fillRect`, one cached bracket sprite.
- **Sector labels** — `SEC 07-N`, `GRID-A4`. `fillText` is expensive per frame, so
  these are **baked into the tiles or cached as sprites**, never drawn live.

**Done when.** Labels are legible at speed and no `fillText` runs in the render
pass.

---

## Sub-phase 7g — VR framing

**Goal.** Sell the fiction directly: this world is being *rendered for you*, and
the deck is not perfect. Last, because it decorates everything above.

- **Materialisation.** Buildings draw in as they enter — a bottom-up wipe over
  ~0.3s — instead of simply existing at the screen edge. Implemented as a `clip`
  rect around the *existing* cached blit, so the cost is one clip on top of a draw
  already being made. This is the single strongest "inside a rendered world" cue
  available and it is nearly free.
- **Deck glitches.** A horizontal band of floor offsetting a few px for two
  frames; a building occasionally rendering as bare wireframe (skip the fills)
  before resolving; a grid column flickering bright. All state, no draw cost.
  **Rare and short** — every 10–20s, not constant, or it stops reading as a
  glitch and starts reading as a bug.

**Done when.** Entry pop is gone, glitches are rare enough to be noticed rather
than watched, and neither is on by default in the asset gallery.

---

## Order, and why

7a first because nothing else has anywhere to attach without it. 7b immediately
after, because 7a+7b together are where the "symbolic map" impression actually
comes from and everything later is decoration on a floor that already works. 7c is
out of order on theme but in order on value-per-µs. 7d/7e are the map layer
proper. 7f is flavour. 7g is the fiction, and wants everything else present to
decorate.

**Correction.** The "Two constraints" section above originally reserved
"genuinely dynamic per frame, no tile to hide behind" for 7e. 7c, once it
became drone air traffic rather than a static far field, got there first: it
is the first sub-phase with no pre-rendered tile behind it, and its own
section documents the cost work that implies. 7e still gets there next, on
its own per-frame paths (conduits, pings) — this just corrects which
sub-phase actually crossed that line first.

**7a + 7b is the recommended first PR** — roughly 2 blits and 2 fills for the
whole change, and it is the slice that changes how the game reads.
