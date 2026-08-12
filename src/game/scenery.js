// Background city floor — the LOWER level the elevated road hovers above.
//
// PARALLAX MODEL
// --------------
// Reframing the world as "an elevated road ribbon over a city floor" lets the
// floor scroll SLOWER than the road (a fraction of the driven distance). Because
// the floor is a separate, lower plane, its buildings are NOT glued to the road
// edge (unlike the old roadside placement) — so a slower scroll no longer desyncs
// anything, and the speed difference reads as depth.
//
// Everything here is drawn FIRST (behind the road). The road then paints an
// opaque tarmac ribbon on top, occluding the middle of the floor so the city
// appears to pass underneath the highway.
//
// This module only DRAWS the floor. What stands where is citygrid.js's call:
// the floor is divided into plots (streets) and, within them, lots
// (buildings), and a plot's or lot's contents are — like the road — a pure
// function of its index, so the city is infinite and never pops.

import { drawBuildingVariant, drawNodeVariant } from "./sprites.js";
import {
  CELL, PLOT, ARTERIAL_PERIOD, BUILDING, NODE, isAvenueCol,
  lotAt, lotX, lotY, lotColumns, lotRows, plotColumns,
  plotAt, plotX, plotY, plotRows,
  sectorIndex,
} from "./citygrid.js";
import { neonStroke } from "../engine/neon.js";
import {
  FLOOR_GRID, FLOOR_STREET, FLOOR_STREET_LINE, FLOOR_TRAFFIC, FLOOR_TICK,
  SECTOR_COUNT,
} from "../engine/palette.js";

function mod(n, m) {
  return ((n % m) + m) % m;
}

// citygrid.js's sectorIndex() is an unbounded integer (geometry there, palette
// count here). Wrapped to [0, SECTOR_COUNT) at exactly this one call site: every
// downstream cache key that varies by sector (this file's floor-tile cache,
// drawBuildingVariant/drawNodeVariant's keys, road.js's strip cache) uses the
// WRAPPED value, so none of them grow with how far the run has gone. Exported so
// road.js invalidates on the same wrapped sector rather than a second copy of
// this arithmetic.
export function currentSector(fDist) {
  return mod(sectorIndex(fDist), SECTOR_COUNT);
}

// The floor drifts at this fraction of the road's travelled distance. Lower =
// feels further away / more depth. 0.5 = floor moves at half road speed.
export const FLOOR_PARALLAX = 0.5;

// THE ONE DERIVATION of floor-world distance from player distance. Every
// per-frame consumer on this floor (drones.js, links.js, sectors.js, and
// main.js's own road-sector pick) calls this rather than open-coding
// Math.round(distance * FLOOR_PARALLAX).
//
// TWO-STEP ROUNDING, deliberately: round to whole pixels FIRST, then scale and
// round again, mirroring main.js's camY = Math.round(distance) followed by a
// second Math.round(camY * FLOOR_PARALLAX). The single-step version looks
// equivalent and almost always is — it disagrees by 1 on roughly 1 in 25 sector
// crossings, and since spritecache.js's Map has no eviction, that bakes the
// wrong sector's colour into a cache entry with no way to self-correct.
//
// IDEMPOTENT UNDER PRE-ROUNDING, which is the whole point: rounding an integer
// is a no-op, so this is safe to call from BOTH the simulation loop (raw
// `distance`, sectors.js) and the render loop (main.js's already-rounded
// `camY`). There is no wrong thing to pass.
export function floorDist(distance) {
  return Math.round(Math.round(distance) * FLOOR_PARALLAX);
}

// The drawn grid SUBDIVIDES the placement grid: it is CELL / GRID_SUBDIV, so
// every plot and cell boundary citygrid.js works in is still a drawn line, and
// scenery still can't drift out of step with placement — there are just extra
// lines between them. That relation is the whole reason this is safe to tune;
// an arbitrary spacing (say 40) would put grid lines through the middle of
// plots and the floor would stop reading as the thing buildings stand on.
//
// GRID_SUBDIV = 2 halves the spacing on BOTH axes, which is what makes the
// floor read as a fine map mesh rather than as big empty tiles. It costs
// nothing per frame: the tile is still ONE blit, and 4x the lines are 4x the
// work only in the one-time build.
//
// Exported so the test suite can assert the tile's phase against the spacing
// actually drawn rather than against CELL, which is no longer the same number.
const GRID_SUBDIV = 2;
export const GRID_SPACING = CELL / GRID_SUBDIV;

export function render(ctx, distance, playerY, W, H) {
  // The floor uses its own, slower "distance". Same screen<->world mapping as the
  // road (see road.js), just with the parallax-scaled distance.
  //
  // ROUNDED HERE, ONCE, and then used for BOTH the grid and the buildings. The
  // grid is blitted from a pre-rendered tile (below) and only lands pixel-exact
  // on a whole-pixel offset; but rounding it for the grid alone would slide the
  // buildings up to half a pixel against the grid squares they stand on, so the
  // rounded value is the only floor clock there is. main.js does the same for the
  // road's camera — the floor needs its own because it runs at half speed.
  const fDist = floorDist(distance);
  // Phase 7f: which sector this frame's floor falls in, wrapped to a palette
  // index (see wrappedSector above). A pure function of fDist, like
  // gridPhase/plotAt — computed once here and threaded down, not re-derived
  // per building/node, so every layer this frame agrees on which sector it's
  // drawing even if palette.js's own bindings were reassigned mid-frame by
  // something upstream (they aren't, in practice — see game/sectors.js's own
  // header on why setSector() only ever runs in update()).
  const sector = currentSector(fDist);
  drawFloorGrid(ctx, fDist, playerY, W, H, sector);
  // NODES BEFORE BUILDINGS, not interleaved into the far-to-near building walk —
  // a node is flat ground texture, not a depth-sorted entity. A building never
  // SHARES a plot with a node (citygrid.js's reserve() claims the whole plot),
  // but a neighbouring building's footprint or glow padding can reach across the
  // boundary, and drawing nodes first is what lets a building nearer the camera
  // overlap one.
  drawFloorNodes(ctx, fDist, playerY, W, H, sector);
  drawFloorBuildings(ctx, fDist, playerY, W, H, sector);
  // After the buildings: a street plot never hosts one, so a dot is never
  // actually occluded either way and this is presentation, not correctness.
  // Drawing last keeps every dot crisp and reads as the map's moving-marker
  // layer sitting above its static one.
  drawTrafficDots(ctx, trafficDots(clock, fDist, playerY, W, H));
}

// --- The floor grid, avenues and cross-streets are ONE pre-rendered tile ----
//
// WHY. The grid profiled at 2.35ms/frame — 95% of all scenery work — and it is
// pure lines, the same line-overdraw cost the road pays (see road.js's strip
// cache). Measured against the direct re-stroke: ~1500-2000us -> ~18us.
//
// The horizontals are world-anchored at every GRID_SPACING, so the grid is
// PERIODIC in y with that period; the verticals are fixed SCREEN columns, so it
// is static in x. A periodic-and-static layer is one tile, built once and
// blitted at a phase offset — never rebuilt, never keyed.
//
// Avenues and cross-streets (citygrid.js) share that property, at period
// ARTERIAL_PERIOD — and GRID_SPACING divides CELL divides PLOT divides
// ARTERIAL_PERIOD, so a period that is a multiple of another period is still one
// period. All three layers bake into ONE tile and the floor stays at exactly one
// drawImage per frame. That divisibility is the constraint on GRID_SUBDIV, and
// why it is a SUBDIVISION rather than a free spacing.
//
// The tile is W x (H + ARTERIAL_PERIOD) — one period taller than the screen, so
// whatever the phase, a single blit at destY in [-ARTERIAL_PERIOD, 0) still
// covers the bottom row. ~3.1MB at 600x1312.
//
// EXACTNESS. The phase is (playerY + fDist) mod ARTERIAL_PERIOD and BOTH TERMS
// MATTER: a line world-anchored at k*ARTERIAL_PERIOD lands at
// playerY + fDist - k*period, so the whole set sits at that sum's residue.
// Dropping playerY (easy to talk yourself into, since it is a constant)
// misplaces the tile — diffed against the direct re-stroke, mean error goes from
// 0.07-0.25/255 to 1.2 with channels off by 32.
//
// LOOK. Each street is a dim fill (FLOOR_STREET) plus a brighter dashed centre
// line (FLOOR_STREET_LINE), and the fine grid is skipped — not merely painted
// over — wherever it would cross the ribbon, so the street reads as open ground
// rather than a brighter patch of grid.
//
// The ribbon is STREET_WIDTH not the full plot, the grid is GRID_SPACING not
// CELL, and a building's footprint is sized to a LOT not a PLOT: the same
// decision three times, because the floor is meant to read as a fine MAP MESH
// with routes through it. Retune any one of the three without the others and it
// goes back to reading as a handful of big tiles with boxes standing on them.
//
// No ctx.shadowBlur anywhere here: this tile is one canvas-spanning path, and a
// shadow on a shape that size measured ~0.5ms/frame from a single draw call (see
// neonStroke's header for the same trade on the road's barriers). The dashed
// centre lines get their glow from neonStroke's overdraw passes instead.
//
// All of this is a ONE-TIME cost (tile build, on first draw or canvas resize),
// so it can afford more draw calls than the per-frame budget ever could.

// A tiny FIFO cache bounded to `max` entries. Standalone (not folded into
// floorGridTile below) so the test suite can assert the BOUND directly with
// plain values — floorGridTile is the one function in this file that touches
// `document` (a canvas), which can't run under plain Node, but the eviction
// rule itself has nothing to do with canvases and shouldn't need one to test.
export function makeBoundedCache(max) {
  const order = []; // insertion order, oldest first
  const map = new Map();
  return {
    get(key) {
      return map.get(key);
    },
    set(key, value) {
      if (!map.has(key)) order.push(key);
      map.set(key, value);
      while (order.length > max) map.delete(order.shift());
    },
    get size() {
      return map.size;
    },
  };
}

// The tile varies by SECTOR (FLOOR_GRID and friends are live bindings — see
// palette.js's setSector), so its key is (W, H, sector) and one slot is not
// enough across a crossing: the OLD sector's tile is still needed for whatever
// hasn't scrolled past the boundary while the NEW one is built, or every frame
// straddling a boundary would rebuild. Bounded to 2 by hand rather than left to
// grow with SECTOR_COUNT — this cache is module-local, not spritecache.js (which
// has no eviction at all). No crossing ever needs a third sector's tile alive.
const FLOOR_TILE_CACHE_MAX = 2;
const floorTiles = makeBoundedCache(FLOOR_TILE_CACHE_MAX);

// How wide the painted street ribbon is. A street still OWNS its whole plot —
// that is citygrid.js's call and none of this changes it — but it is painted
// CELL wide and centred, not PLOT wide, so the tarmac matches the scale of the
// grid it lies on instead of being a double square of flat fill. What is left
// of the plot either side stays gridded, which is what makes the street read as
// a route through the mesh rather than as a hole cut in it.
//
// Centred on the plot, so the ribbon runs from STREET_INSET to
// STREET_INSET + STREET_WIDTH within it. Both of those land on GRID_SPACING
// boundaries (32 and 96 of a 128 plot), which is the point: the ribbon's edges
// fall exactly on grid lines rather than slicing squares in half.
//
// Exported so the test suite can assert traffic-dot lanes (below) against the
// ribbon actually painted, rather than a value it recomputes itself.
export const STREET_WIDTH = CELL;
export const STREET_INSET = (PLOT - STREET_WIDTH) / 2;

// Where a cross-street's ribbon sits inside one ARTERIAL_PERIOD, in canvas y.
// Canvas y = 0 stands for plot row by = 0, which citygrid.js's isCrossStreetRow
// makes a cross-street by convention, so the ribbon occupies
// [STREET_INSET, STREET_INSET + STREET_WIDTH) of every period.
function crossStreetLocal(y) {
  return ((y % ARTERIAL_PERIOD) + ARTERIAL_PERIOD) % ARTERIAL_PERIOD;
}

// True where canvas-local y is STRICTLY inside a cross-street ribbon. Strictly,
// so a grid line landing exactly on a ribbon edge is still drawn: those two
// lines are what give the street a crisp kerb on each side instead of a fill
// that fades out against nothing.
function insideCrossStreet(y) {
  const local = crossStreetLocal(y);
  return local > STREET_INSET && local < STREET_INSET + STREET_WIDTH;
}

// Same idea across x: canvas x = 0 stands for plot column bx = 0, an avenue by
// isAvenueCol's own convention (0 is always a multiple of AVENUE_COLS).
function insideAvenue(x) {
  if (!isAvenueCol(Math.floor(x / PLOT))) return false;
  const local = ((x % PLOT) + PLOT) % PLOT;
  return local > STREET_INSET && local < STREET_INSET + STREET_WIDTH;
}

// A dashed neon stroke: neonStroke's own overdraw passes, with the dash
// pattern scoped to just this call via an outer save/restore (neonStroke saves
// and restores around its own passes, but that inner restore returns to
// whatever was current when IT was called — including a dash set just before —
// so the outer pair is what actually clears it again afterward).
function neonDashedStroke(ctx, build, color, dash, width, spread) {
  ctx.save();
  ctx.setLineDash(dash);
  neonStroke(ctx, build, color, width, spread);
  ctx.restore();
}

// px each registration tick's arm reaches off its intersection centre — kept
// small enough to read as texture, not a shape (that's what a NODE's corner
// brackets + glyph are for). Exported alongside tileIntersections below so a
// test can size its own on-screen tolerance against the actual drawn mark.
export const TICK_LEN = 5;

// TILE-LOCAL (pre-phase) centres of every registration tick the floor tile
// bakes — every (avenue column, cross-street band) pairing within the tile's own
// height, in the same coordinate space floorGridTile()'s ribbon loops use.
//
// Its own pure function rather than a loop inline in floorGridTile(), because a
// SECOND copy of this geometry is how the tile and citygrid.js's index math
// drifted a whole PLOT apart once already (see isCrossStreetRow's "+1"). The
// test suite maps this list through gridPhase and cross-checks it against
// crossStreetBands()/avenueCenters(), the screen-space equivalent.
export function tileIntersections(W, tileHeight) {
  const points = [];
  for (let y0 = 0; y0 <= tileHeight; y0 += ARTERIAL_PERIOD) {
    const y = y0 + PLOT / 2;
    for (let bx = 0; bx * PLOT < W; bx++) {
      if (!isAvenueCol(bx)) continue;
      points.push({ x: bx * PLOT + PLOT / 2, y });
    }
  }
  return points;
}

// Build the tile if we don't have one for this (canvas size, sector). Keyed
// on `sector` too (Phase 7f) because FLOOR_STREET/FLOOR_STREET_LINE/
// FLOOR_TICK/FLOOR_GRID are live bindings (palette.js's setSector) baked into
// this canvas's actual pixels at build time — a cache hit on an old key would
// silently keep blitting the last sector's colours forever. `document` is
// touched only in here, never at module scope — the test suite imports this
// file under plain Node (same rule as engine/spritecache.js).
function floorGridTile(W, H, sector) {
  const key = `${W}x${H}x${sector}`;
  const hit = floorTiles.get(key);
  if (hit) return hit;

  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H + ARTERIAL_PERIOD;
  const g = canvas.getContext("2d");
  const DASH = [14, 10];

  // Cross-street bands: periodic every ARTERIAL_PERIOD, full width. Mirrors the
  // fine grid's own y-loop below, just at the coarser period.
  for (let y0 = 0; y0 <= canvas.height; y0 += ARTERIAL_PERIOD) {
    g.fillStyle = FLOOR_STREET;
    g.fillRect(0, y0 + STREET_INSET, W, STREET_WIDTH);
    neonDashedStroke(
      g,
      (c) => {
        c.moveTo(0, y0 + PLOT / 2);
        c.lineTo(W, y0 + PLOT / 2);
      },
      FLOOR_STREET_LINE,
      DASH,
      2,
      3,
    );
  }

  // Avenue bands: fixed screen columns, running the tile's full height.
  for (let bx = 0; bx * PLOT < W; bx++) {
    if (!isAvenueCol(bx)) continue;
    const x0 = bx * PLOT;
    g.fillStyle = FLOOR_STREET;
    g.fillRect(x0 + STREET_INSET, 0, STREET_WIDTH, canvas.height);
    neonDashedStroke(
      g,
      (c) => {
        c.moveTo(x0 + PLOT / 2, 0);
        c.lineTo(x0 + PLOT / 2, canvas.height);
      },
      FLOOR_STREET_LINE,
      DASH,
      2,
      3,
    );
  }

  // Registration ticks: a small, uniform mark at every avenue x cross-street
  // INTERSECTION, baked into this one-time build so it costs nothing per frame.
  // Deliberately UNIFORM, unlike a NODE: identical marks at every intersection
  // read as a map's own registration grid, where a node has to be rare and
  // distinguishable to read as a facility rather than more grid furniture.
  //
  // Its own pass rather than folded into the centre-line strokes above, because
  // those are DASHED: a tick that only appeared where a dash happened to overlap
  // would flicker across the grid instead of marking every intersection alike.
  neonStroke(
    g,
    (c) => {
      for (const { x, y } of tileIntersections(W, canvas.height)) {
        c.moveTo(x - TICK_LEN, y);
        c.lineTo(x + TICK_LEN, y);
        c.moveTo(x, y - TICK_LEN);
        c.lineTo(x, y + TICK_LEN);
      }
    },
    FLOOR_TICK,
    1,
    3,
  );

  // The fine CELL grid, one batched path stroked WITHOUT ctx.shadowBlur (see
  // the header above), skipping any line that falls inside a street band so
  // the street reads as open ground rather than a patch of grid.
  //
  // Verticals run the tile's FULL height rather than the screen's, so they scroll
  // off both edges instead of showing a round line-cap at the screen boundary.
  neonStroke(
    g,
    (c) => {
      for (let y = 0; y <= canvas.height; y += GRID_SPACING) {
        if (insideCrossStreet(y)) continue;
        c.moveTo(0, y);
        c.lineTo(W, y);
      }
      for (let x = 0; x <= W; x += GRID_SPACING) {
        if (insideAvenue(x)) continue;
        c.moveTo(x, 0);
        c.lineTo(x, canvas.height);
      }
    },
    FLOOR_GRID,
    1,
    3,
  );

  floorTiles.set(key, canvas);
  return canvas;
}

// The tile's phase: where the pattern (grid, avenues, cross-streets) falls
// inside one ARTERIAL_PERIOD, in screen y. Exported so a test can assert it
// against the world->screen mapping rather than trusting the comment above.
export function gridPhase(fDist, playerY) {
  return (((playerY + fDist) % ARTERIAL_PERIOD) + ARTERIAL_PERIOD) % ARTERIAL_PERIOD;
}

// Full-width Tron floor grid, avenues and cross-streets: one blit. The road
// will paint over the middle, leaving the floor visible to either side.
//
// Exported (rather than kept private like drawFloorBuildings) so the blit can be
// pixel-diffed against a direct re-stroke IN ISOLATION — buildings drawn on top
// would mask exactly the rows a phase error shows up in.
export function drawFloorGrid(ctx, fDist, playerY, W, H, sector) {
  ctx.drawImage(floorGridTile(W, H, sector), 0, gridPhase(fDist, playerY) - ARTERIAL_PERIOD);
}

// --- Materialisation (Phase 7g) ------------------------------------------
//
// Buildings and nodes wipe in bottom-up as they cross the screen's top edge,
// instead of simply existing there the instant a frame's walk reaches that far.
// Nearly free: a `clip` rect around a blit already being made (sprites.js).
//
// SPANNED IN DISTANCE, NOT TIME. A time-based wipe needs an entry timestamp,
// which is state — the one thing every other layer on this floor avoids needing.
// `sy`, the row's own screen-y anchor, crosses 0 exactly once as fDist grows, and
// how far past that crossing it is IS the progress: a pure function of (row,
// fDist), nothing to store and nothing to reset on newGame(). It also means a
// building materialises as the player APPROACHES it.
//
// WIPE_SPAN IS SHORT ON PURPOSE. At a crawl fDist barely moves, so a wide span
// leaves a building part-drawn long enough to read as a bug. 60 (floor-world
// units, which on this plane are screen px) keeps it under LOT (64), and that is
// what guarantees AT MOST ONE lot row is ever mid-wipe: adjacent rows are exactly
// LOT apart in fDist, so a shorter span can never have two overlap. At a ~400
// units/s cruise that is 0.3s; ~0.19s at the player's top speed, ~1.0s at the
// bottom of the throttle — long at a crawl, but always confined to one row.
export const WIPE_SPAN = 60;

// Progress in [0, 1]. `sy` is the row's screen-y anchor at THIS fDist: sy <= 0
// means the row hasn't crossed the top edge yet, sy >= WIPE_SPAN means it did so
// at least WIPE_SPAN of floor distance ago (fully materialised — the fast,
// unclipped blit path in sprites.js). Monotonic in fDist for a fixed row, which
// is what makes "never un-materialises as you approach" a property of the
// formula rather than something maintained by hand.
//
// USED FOR THE FAST-PATH DECISION ONLY (progress >= 1?) — NOT for how much of
// the sprite the clip reveals. A sprite with its glow padding is typically
// 100-170px tall, well over WIPE_SPAN (60), so scaling the clip by this fraction
// of the SPRITE's height makes the wipe invisible for most of its span: the
// canvas's own top-edge clip already hides everything above screen y=0, and the
// explicit clip overtakes that natural edge within the first ~25-30%. sprites.js
// uses the row's raw `sy` against the sprite's own height instead.
export function materialiseProgress(sy) {
  if (sy <= 0) return 0;
  if (sy >= WIPE_SPAN) return 1;
  return sy / WIPE_SPAN;
}

// Every building lot visible this frame, in far-to-near draw order, as plain
// data — no canvas anywhere in this function, mirroring trafficDots below, which
// is what lets test/invariants.test.js assert the walk's bound and row order
// under plain Node instead of only by eye.
//
// Buildings sit on the floor's LOT grid (citygrid.js), finer than the plot grid
// streets are claimed on, walked ROW BY LOT ROW far (top) to near (bottom) so
// nearer footprints overlap farther ones. A lot row is a fixed floor-world y
// band, so depth varies only ALONG y and never within a row — walking lot rows
// in that order is sufficient. Get it wrong (iterating plot rows and drawing all
// four lots at once) and a near lot silently draws UNDER a far one, visible only
// at the scroll offsets where the two rows share screen space.
//
// This walks lots and asks citygrid.js what stands on each; it never decides
// placement itself.
//
// COST, MEASURED (rAF-saturation — see the README's profiling-traps section).
// ~70 buildings visible on an average frame (range 56-81), and scenery.render()
// as a whole — this walk, the grid blit and the traffic dots — measures
// ~0.36ms/frame, rising to ~0.41ms while a row is mid-wipe. Note that "some row
// is mid-wipe" is the steady state ~94% of the time, since WIPE_SPAN (60) is
// just under LOT (64). Both figures sit inside the design doc's ~0.5ms budget
// for the whole city layer, so "the city has no culling" stays true — but with
// less headroom than before, so a further density increase should re-measure
// rather than assume the margin holds.
export function visibleBuildings(fDist, playerY, W, H) {
  const rows = lotRows(fDist + playerY - H - 40, fDist + playerY + 200);
  const cols = lotColumns(W);
  const buildings = [];

  for (let ly = rows.max; ly >= rows.min; ly--) {
    const sy = playerY - (lotY(ly) - fDist); // lot centre, in screen y
    // Phase 7g: a row that hasn't crossed the top edge yet has nothing to
    // draw — skip it (and every lot in it) before the lx walk even starts,
    // rather than constructing entries the draw side would only throw away.
    // materialiseProgress is keyed to the ROW's own sy, not a per-building
    // one, on purpose: per-building dx/dy siting jitter is at most LOT/2
    // (32px), well inside WIPE_SPAN, so using the row's sy keeps progress a
    // pure function of (lot row, fDist) exactly as the design doc asks,
    // rather than pulling variant footprint dims into the timing too.
    const progress = materialiseProgress(sy);
    if (progress <= 0) continue;
    for (let lx = 0; lx < cols; lx++) {
      const lot = lotAt(lx, ly);
      if (lot.type !== BUILDING) continue;

      const cx = lotX(lx) + lot.dx;
      // dx is a screen-x offset (x needs no transform — see citygrid.js's own
      // header), but dy is a FLOOR-WORLD y offset, and sy is already screen
      // space, where growing world-y maps to SHRINKING screen-y (see `sy`
      // above) — so it subtracts here rather than adding. `ly` rides along
      // only so test/invariants.test.js can assert the walk is far-to-near BY
      // ROW without being tripped up by same-row siting jitter in `sy` (two
      // buildings sharing a row can differ in `sy` by their own dy, which is
      // not a depth difference — see that test's own comment).
      // rowSy rides along separately from the post-dy `sy` above: it's the
      // raw px sprites.js needs for the clip amount (see materialiseProgress's
      // own comment on why that can't be `progress` alone).
      buildings.push({ cx, sy: sy - lot.dy, ly, variant: lot.variant, leanRight: cx >= W / 2, progress, rowSy: sy });
    }
  }
  return buildings;
}

// Blits every visible building, far to near. Some will sit under the road
// ribbon and get occluded — that's intentional: the highway flies over the
// city.
function drawFloorBuildings(ctx, fDist, playerY, W, H, sector) {
  for (const b of visibleBuildings(fDist, playerY, W, H)) {
    // Lean away from screen centre for a subtle shared vanishing point.
    // `b.progress` (Phase 7g) is always > 0 here — visibleBuildings already
    // filtered out anything at or before its row's own entry — so the only
    // branch left is inside drawBuildingVariant itself: progress >= 1 takes
    // the plain, unclipped blit path, exactly as before this phase.
    drawBuildingVariant(ctx, b.cx, b.sy, b.variant, b.leanRight, sector, b.progress, b.rowSy);
  }
}

// --- Distinguished nodes (Phase 7d) -------------------------------------------
//
// citygrid.js's reserve() claims a NODE at PLOT granularity, not LOT — a
// facility takes the whole block rather than subdividing it the way four
// buildings would (see reserve()'s own comment). So this walks PLOT rows, via
// citygrid.js's plotRows/plotX/plotY/plotAt, NOT the LOT walk visibleBuildings
// uses above: walking lots here would visit the SAME plot's claim
// LOT_SUBDIV x LOT_SUBDIV times and draw the same marker stacked on itself.
//
// Every visible node this frame, as plain data — no canvas anywhere in this
// function, mirroring visibleBuildings so test/invariants.test.js can assert
// the walk directly under plain Node. Order doesn't matter the way it does for
// visibleBuildings (nodes never overlap each other — one per plot, plots don't
// overlap), so this doesn't bother walking far-to-near.
//
// `bx`/`by` ride along with the screen position (game/links.js): a conduit's
// heading, a ping's phase and a console callsign must all derive from the SAME
// plot index that made this a node (citygrid.js's reserve()), not a second
// identity invented downstream. Free to add — the walk already has both in scope.
export function visibleNodes(fDist, playerY, W, H) {
  const rows = plotRows(fDist + playerY - H - 40, fDist + playerY + 200);
  const cols = plotColumns(W);
  const nodes = [];

  for (let by = rows.min; by <= rows.max; by++) {
    const sy = playerY - (plotY(by) - fDist);
    // Phase 7g: same row-level skip visibleBuildings uses above — a plot row
    // that hasn't crossed the top edge yet has nothing to draw.
    const progress = materialiseProgress(sy);
    if (progress <= 0) continue;
    for (let bx = 0; bx < cols; bx++) {
      const plot = plotAt(bx, by);
      if (!plot || plot.type !== NODE) continue;
      nodes.push({ cx: plotX(bx), sy, variant: plot.variant, bx, by, progress });
    }
  }
  return nodes;
}

// Blits every visible node — rare by construction (citygrid.js's NODE_CHANCE
// targets ~1-2 on screen at 600x800), so this is a handful of cached sprite
// blits, not a walk worth the far-to-near care visibleBuildings needs.
function drawFloorNodes(ctx, fDist, playerY, W, H, sector) {
  for (const n of visibleNodes(fDist, playerY, W, H)) {
    // Same materialisation as a building (Phase 7g) — it would look odd if
    // the buildings resolved in and the nodes just popped.
    // n.sy IS the row's own raw screen-y here (a node has no dx/dy siting
    // offset — see visibleNodes above), so it doubles as the clip's rowSy
    // without a separate field the way a building's post-dy sy needs.
    drawNodeVariant(ctx, n.cx, n.sy, n.variant, sector, n.progress, n.sy);
  }
}

// --- Traffic dots (Phase 7b) --------------------------------------------------
//
// THE ONE EXCEPTION TO "PURE FUNCTION OF POSITION". Every other layer on this
// floor is identical at a given index no matter WHEN you ask for it, which is
// what lets it be pre-rendered. A traffic dot also depends on time — but it is
// still not simulated: there is no car object, nothing spawns or despawns,
// nothing is stored per dot. A dot's position is a pure function of (lane, dot
// index, clock), and `update(dt)` below only advances what "now" means, on the
// same fixed step as every other per-run system, so the dots freeze when the
// rest of the world does rather than drifting on a clock of their own.
//
// Lanes run in opposite directions at different speeds of their OWN, on top of
// the road's scroll and this floor's FLOOR_PARALLAX, which is what sells the
// depth. A cross-street's lanes slide in SCREEN X, an axis the floor never
// scrolls on; an avenue's slide in SCREEN Y, the same axis the floor itself
// scrolls on — so an avenue lane's speed must be ADDED to that scroll rather
// than measured against the screen in place of it (see laneDotPositions'
// `carry`). Each lane slides along its own street, never across it.

// Exported as a live binding (not a getter) so game/drones.js can read "now"
// off the SAME clock these dots run on, rather than keeping a second one —
// the two layers freeze together on pause/death for the same reason the dots
// freeze with the rest of "playing" (see update() below). Read-only to an
// importer; only update() is allowed to advance it.
export let clock = 0;

// Advances the floor's traffic clock. Called from main.js's update() alongside
// every other per-run system — NOT from render(), which must stay a pure
// function of its arguments like the rest of this file (see gridPhase/plotAt).
export function update(dt) {
  clock += dt;
}

// Spacing and speed are screen px and px/s. DOT_SPACING is picked so the total
// dot count at 600x800 — ~2 avenues (citygrid's AVENUE_COLS) and ~2 visible
// cross-street bands (ARTERIAL_PERIOD 512 against an 800px screen), 4 lanes
// each (see DOT_LANE_OFFSET_INNER/OUTER below) — lands a little over the
// design doc's original 60-80, a deliberate retune: two dot-sized cars per
// direction reads as actual traffic against the road's own scale where one
// read as sparse. Retune DOT_SPACING together with the ribbon width if either
// changes.
//
// Exported (with DOT_SPEED_A/B and DOT_LANE_PHASE below) so the test suite
// can assert an avenue dot's position against its own lane's speed and phase
// directly, rather than trusting the carry fix by eye — see
// test/invariants.test.js's "avenue traffic lanes carry the floor's own
// scroll" test.
export const DOT_SPACING = 75;
export const DOT_SPEED_A = 70;  // one direction's lanes
export const DOT_SPEED_B = -55; // the other direction's lanes, opposite way —
                          // deliberately not the same magnitude, so the two
                          // directions never look paired
const DOT_MARGIN = 8;    // a dot is fully drawn before it crosses on/off screen,
                          // rather than popping in already half-formed at 0/W/H

// Two lanes per direction, kept inside the ribbon and off both the kerb and
// the centre line. STREET_WIDTH/8 and 3*STREET_WIDTH/8 quarter each HALF of
// the ribbon — from a kerb inward: margin, outer lane, gap, inner lane,
// margin, centre line — so the four lanes and the two margins land in an
// even 1:2:2:1 split of the half-ribbon rather than needing four independent
// numbers. Scales automatically with STREET_WIDTH, same reasoning the single
// offset this replaced was built on.
const DOT_LANE_OFFSET_INNER = STREET_WIDTH / 8;
const DOT_LANE_OFFSET_OUTER = STREET_WIDTH * 3 / 8;

// The outer lane of a pair is walked at a half-spacing phase from its inner
// neighbour, so the two don't draw as a mirrored, lockstep pair of dots
// gliding in the same direction — see laneDotPositions' `phase` argument.
// Exported alongside DOT_SPACING/DOT_SPEED_A/B above, same reason.
export const DOT_LANE_PHASE = DOT_SPACING / 2;

const DOT_LEN = 4; // long axis, along the direction of travel
const DOT_WID = 2; // short axis, across it

// Positions along ONE lane at a fixed spacing, shifted by `clockValue * speed +
// phase + carry`, bounded to the visible span [lo, hi] — NOT to a lane length. A
// lane has no natural length to mod against (a street runs the full screen,
// forever), and inventing one would make the dot count depend on the invented
// number rather than on the screen. Walking the index range that lands in
// [lo, hi] keeps the count bounded by (hi - lo) / spacing however far
// `clockValue` has run.
//
// `phase` is a fixed px offset (see DOT_LANE_PHASE) for staggering a second lane
// at the same speed. `carry` DOES vary with time — it is trafficDots' own `fDist`
// for an avenue lane, 0 for a cross-street one. Without it a dot's speed is
// measured against the SCREEN rather than the WORLD, which is wrong whenever the
// floor is also moving along that axis; see trafficDots' avenue loop.
//
// Exported so game/drones.js can place formations along a diagonal flight line
// with the same arithmetic rather than a second copy — same problem, different
// axis.
export function laneDotPositions(spacing, speed, clockValue, lo, hi, phase = 0, carry = 0) {
  const shift = clockValue * speed + phase + carry;
  const iMin = Math.ceil((lo - shift) / spacing);
  const iMax = Math.floor((hi - shift) / spacing);
  const positions = [];
  for (let i = iMin; i <= iMax; i++) positions.push(i * spacing + shift);
  return positions;
}

// Screen-y tops of every cross-street ribbon touching [0, H] — derived from
// the SAME phase drawFloorGrid's blit uses, walked forward and back from it
// rather than a fresh modulo of our own, so a dot can never drift from the
// ribbon the tile actually painted.
//
// Inside the tile, a band at y0 = n*ARTERIAL_PERIOD (any integer n) has its
// ribbon at [y0 + STREET_INSET, y0 + STREET_INSET + STREET_WIDTH) — see
// floorGridTile's own cross-street loop above. The tile is blitted at
// gridPhase(fDist, playerY) - ARTERIAL_PERIOD, so mapping a tile-local y0
// through that offset gives screen top = phase + n*ARTERIAL_PERIOD +
// STREET_INSET for every integer n; walk n across the range that can possibly
// touch the screen and keep the ones that do.
export function crossStreetBands(fDist, playerY, H) {
  const phase = gridPhase(fDist, playerY);
  const nMin = Math.floor((-STREET_INSET - STREET_WIDTH - phase) / ARTERIAL_PERIOD);
  const nMax = Math.ceil((H - STREET_INSET - phase) / ARTERIAL_PERIOD);
  const bands = [];
  for (let n = nMin; n <= nMax; n++) {
    const top = phase + n * ARTERIAL_PERIOD + STREET_INSET;
    if (top + STREET_WIDTH > 0 && top < H) bands.push(top);
  }
  return bands;
}

// Screen-x centres of every avenue ribbon touching [0, W] — citygrid.js's own
// isAvenueCol, walked over the same plot columns drawFloorGrid's tile does, so
// an avenue lane can never straddle a column the tile didn't paint as one.
export function avenueCenters(W) {
  const centers = [];
  for (let bx = 0; bx < plotColumns(W); bx++) {
    if (isAvenueCol(bx)) centers.push(bx * PLOT + PLOT / 2);
  }
  return centers;
}

// Every dot visible this frame, as plain data — no canvas anywhere in this
// function, which is what lets test/invariants.test.js exercise lane
// placement, the gridPhase relation and the count bound directly under plain
// Node. `alongX` says which way the dot's long axis should be drawn (see
// drawTrafficDots): true on a cross-street, where travel runs along screen x;
// false on an avenue, where it runs along screen y.
//
// FOUR lanes per street, two each direction (inner + outer, see
// DOT_LANE_OFFSET_INNER/OUTER) — the same two sides of the centre line as
// before, just each one split in two, so the street still reads as one
// two-way road rather than four independent ones.
export function trafficDots(clockValue, fDist, playerY, W, H) {
  const dots = [];

  for (const top of crossStreetBands(fDist, playerY, H)) {
    const mid = top + STREET_WIDTH / 2;
    const yInnerA = mid - DOT_LANE_OFFSET_INNER;
    const yOuterA = mid - DOT_LANE_OFFSET_OUTER;
    const yInnerB = mid + DOT_LANE_OFFSET_INNER;
    const yOuterB = mid + DOT_LANE_OFFSET_OUTER;
    for (const x of laneDotPositions(DOT_SPACING, DOT_SPEED_A, clockValue, -DOT_MARGIN, W + DOT_MARGIN)) {
      dots.push({ x, y: yInnerA, alongX: true });
    }
    for (const x of laneDotPositions(DOT_SPACING, DOT_SPEED_A, clockValue, -DOT_MARGIN, W + DOT_MARGIN, DOT_LANE_PHASE)) {
      dots.push({ x, y: yOuterA, alongX: true });
    }
    for (const x of laneDotPositions(DOT_SPACING, DOT_SPEED_B, clockValue, -DOT_MARGIN, W + DOT_MARGIN)) {
      dots.push({ x, y: yInnerB, alongX: true });
    }
    for (const x of laneDotPositions(DOT_SPACING, DOT_SPEED_B, clockValue, -DOT_MARGIN, W + DOT_MARGIN, DOT_LANE_PHASE)) {
      dots.push({ x, y: yOuterB, alongX: true });
    }
  }

  // AVENUES RUN ALONG SCREEN Y — the one axis the floor itself scrolls on as the
  // player drives. A cross-street runs along screen x, which the floor never
  // scrolls on, so only this loop needs the `fDist` carry; the loop above is
  // correct as written.
  //
  // A dot's speed here is its OWN motion on top of the floor's, so its position
  // has to carry `fDist` like everything else on this floor, or it is measured
  // against the SCREEN rather than the WORLD. Without the term the failure shows
  // only at speed: DOT_SPEED_A/B (55-70 px/s) is small next to fDist's own
  // ~310 px/s, so every avenue dot reads as being carried along at the player's
  // pace instead of driving its own line — backwards from the depth effect two
  // independent speeds exist to sell.
  for (const cx of avenueCenters(W)) {
    const xInnerA = cx - DOT_LANE_OFFSET_INNER;
    const xOuterA = cx - DOT_LANE_OFFSET_OUTER;
    const xInnerB = cx + DOT_LANE_OFFSET_INNER;
    const xOuterB = cx + DOT_LANE_OFFSET_OUTER;
    for (const y of laneDotPositions(DOT_SPACING, DOT_SPEED_A, clockValue, -DOT_MARGIN, H + DOT_MARGIN, 0, fDist)) {
      dots.push({ x: xInnerA, y, alongX: false });
    }
    for (const y of laneDotPositions(DOT_SPACING, DOT_SPEED_A, clockValue, -DOT_MARGIN, H + DOT_MARGIN, DOT_LANE_PHASE, fDist)) {
      dots.push({ x: xOuterA, y, alongX: false });
    }
    for (const y of laneDotPositions(DOT_SPACING, DOT_SPEED_B, clockValue, -DOT_MARGIN, H + DOT_MARGIN, 0, fDist)) {
      dots.push({ x: xInnerB, y, alongX: false });
    }
    for (const y of laneDotPositions(DOT_SPACING, DOT_SPEED_B, clockValue, -DOT_MARGIN, H + DOT_MARGIN, DOT_LANE_PHASE, fDist)) {
      dots.push({ x: xOuterB, y, alongX: false });
    }
  }

  return dots;
}

// Every dot in ONE fill() — the whole per-frame budget this layer gets. Multiple
// ctx.rect() calls between one beginPath()/fill() are one fill, not one each. No
// ctx.shadowBlur: the glow is FLOOR_TRAFFIC's own alpha, since a shadow across
// ~150 scattered small rects would cost far more than the rects themselves.
//
// MEASURED (rAF-saturation), trafficDots() + this together at 600x800 with a
// live 118-156 dots: ~14us/frame, inside the design doc's ~30us budget for this
// layer despite the doubled lane count.
function drawTrafficDots(ctx, dots) {
  if (dots.length === 0) return;
  ctx.beginPath();
  for (const dot of dots) {
    const w = dot.alongX ? DOT_LEN : DOT_WID;
    const h = dot.alongX ? DOT_WID : DOT_LEN;
    ctx.rect(dot.x - w / 2, dot.y - h / 2, w, h);
  }
  ctx.fillStyle = FLOOR_TRAFFIC;
  ctx.fill();
}
