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

// citygrid.js's sectorIndex() is an unbounded integer (see its own comment on
// why: geometry there, palette count here). Wrapped to [0, SECTOR_COUNT) at
// exactly this one call site — every cache key downstream that varies by
// sector (this file's own floor-tile cache and drawBuildingVariant/
// drawNodeVariant's keys, plus road.js's strip cache — see its own render())
// uses the WRAPPED value, so none of those caches grow with how far the run
// has actually gone. Exported so road.js can compute the SAME wrapped sector
// its own strip cache needs to invalidate on, rather than a second copy of
// this mod-by-SECTOR_COUNT arithmetic drifting from this one the way
// isCrossStreetRow's own "+1" once drifted from the tile it describes.
export function currentSector(fDist) {
  return mod(sectorIndex(fDist), SECTOR_COUNT);
}

// The floor drifts at this fraction of the road's travelled distance. Lower =
// feels further away / more depth. 0.5 = floor moves at half road speed.
export const FLOOR_PARALLAX = 0.5;

// THE ONE DERIVATION of floor-world distance from player distance. Every
// per-frame consumer on this floor (drones.js, links.js, sectors.js, and
// main.js's own road-sector pick) calls this rather than open-coding
// Math.round(distance * FLOOR_PARALLAX) — that expression used to be
// hand-copied at five call sites, correct at each one only by accident of
// what its caller happened to pass in: four were fed main.js's pre-rounded
// `camY` (see its "THE CAMERA IS QUANTISED" header), but sectors.js's own
// update() runs in the simulation loop, where `camY` doesn't exist, and was
// fed the raw `distance` instead. Single-step Math.round(distance *
// FLOOR_PARALLAX) disagrees with Math.round(camY * FLOOR_PARALLAX) by 1 on
// roughly 1 in 25 sector crossings, and on that tick, since
// spritecache.js's Map has no eviction, the wrong sector's colour got baked
// into a building or floor-tile cache entry with no way to ever self-correct.
//
// TWO-STEP ROUNDING, deliberately: round to whole pixels FIRST, then scale
// and round again — mirroring main.js's own camY = Math.round(distance)
// followed by a second Math.round(camY * FLOOR_PARALLAX), rather than the
// single-step Math.round(distance * FLOOR_PARALLAX) that looks equivalent
// and almost always IS.
//
// IDEMPOTENT UNDER PRE-ROUNDING: Math.round(Math.round(d) * FLOOR_PARALLAX)
// is the same value whether `d` is the simulation's raw float or already an
// integer, because rounding an integer is a no-op. That property is the
// whole fix — it's what makes this function safe to call from BOTH the
// simulation loop (raw `distance` — sectors.js's own update()) and the
// render loop (main.js's already-rounded `camY` — this file's own render(),
// drones.render(), links.render()): there is no longer a wrong thing to pass.
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
  // NODES BEFORE BUILDINGS, not interleaved into the far-to-near building
  // walk — a node is flat ground texture, not a depth-sorted entity, so it is
  // drawn once as a single pass. A building never SHARES a plot with a node
  // (citygrid.js's reserve() claims the whole plot), but a NEIGHBOURING
  // building's footprint or glow padding can still visually reach across the
  // plot boundary — drawing every node first means any building nearer the
  // camera that does reach that far is painted on top of it, which is what
  // "a building standing nearer the camera should be able to overlap a node"
  // (the design doc's own draw-order rule) actually requires in practice.
  drawFloorNodes(ctx, fDist, playerY, W, H, sector);
  drawFloorBuildings(ctx, fDist, playerY, W, H, sector);
  // AFTER the buildings, not before — a street plot never hosts one
  // (citygrid.js's reserve() claims avenues/cross-streets before the building
  // roll ever runs), so a dot is never actually occluded either way and this
  // is a draw-order choice rather than a correctness one. Drawing last keeps
  // every dot crisp on top of the far-to-near building walk instead of
  // sharing a pixel at a street's edge with whatever variant a building drew
  // there, and reads as the map's moving-marker layer sitting above its
  // static one.
  drawTrafficDots(ctx, trafficDots(clock, fDist, playerY, W, H));
}

// --- The floor grid, avenues and cross-streets are ONE pre-rendered tile ----
//
// WHY. The grid was profiled at 2.35ms/frame — 95% of all scenery work — and it
// is pure lines: one batched neonStroke, not a single fill(). That is the same
// line-overdraw cost the road pays (see road.js's strip cache), and the same fix
// applies, only more cheaply: this layer does not even need a keyed cache.
//
// MEASURED, direct re-stroke against the blit, by the rAF-throughput method
// road.js describes (and warns about): ~1500-2000us -> ~18us, i.e. ~100x. Which
// is to say the grid stops being a cost the frame can notice.
//
// The horizontals are world-anchored at every GRID_SPACING, so the grid is
// exactly PERIODIC in y with that period. The verticals are fixed SCREEN
// columns, so the grid is static in x. A periodic-and-static layer is one tile,
// built once, and blitted once per frame at a phase offset — never rebuilt,
// never keyed.
//
// Avenues and cross-streets (citygrid.js) share the SAME property: an avenue is
// a fixed screen column, a cross-street is periodic in y — with period
// ARTERIAL_PERIOD (a whole multiple of GRID_SPACING, since GRID_SPACING divides
// CELL divides PLOT divides ARTERIAL_PERIOD). A period that's a multiple of
// another period is still one period, so all three layers bake into ONE tile
// rather than three, and the floor stays at exactly one drawImage per frame.
// Concretely: the tile is built at ARTERIAL_PERIOD's phase, and because
// GRID_SPACING divides that period, the fine lines it already contains land
// correctly too — shifting a GRID_SPACING-periodic pattern by any whole number
// of GRID_SPACINGs leaves it self-aligned, and ARTERIAL_PERIOD is exactly that
// (PLOT * 4 = CELL * 8 = GRID_SPACING * 16).
//
// That divisibility is the constraint on GRID_SUBDIV, and the reason it is a
// SUBDIVISION rather than a free spacing: halving keeps every one of those
// divisions whole, so the one-tile argument above survives untouched.
//
// The tile is W x (H + ARTERIAL_PERIOD): one arterial period taller than the
// screen, so that whatever the phase, a single blit at destY in
// [-ARTERIAL_PERIOD, 0) still covers the bottom row — the same reasoning the
// old H + CELL tile used, just at the coarser period now driving the blit.
// 600x1312x4 = ~3.1MB, up from ~2MB when the tile only had to cover one CELL.
//
// EXACTNESS. The phase is (playerY + fDist) mod ARTERIAL_PERIOD and BOTH TERMS
// MATTER: a line world-anchored at k*ARTERIAL_PERIOD (or any multiple of
// GRID_SPACING, since it divides the period) lands at playerY + fDist - k*period, so
// the whole set sits at that sum's residue. Dropping playerY (an easy thing to
// talk yourself into, since it is a constant) misplaces the whole tile.
//
// Diffed against the direct re-stroke at integer fDist: mean 0.07-0.25/255, and
// no single channel off by more than 4. Everything that differs is 8-bit rounding
// — the tile composites a faint halo onto transparency and then onto the
// background, where the direct render rounds once. Drop the playerY term and the
// same diff jumps to a mean of 1.2 with channels off by 32, which is what says
// the measurement can actually see a phase error rather than being blind to one.
//
// LOOK. Each street is a dim fill (FLOOR_STREET) plus a brighter dashed centre
// line (FLOOR_STREET_LINE), and the fine grid is skipped — not merely painted
// over — wherever it would cross the ribbon, so the street reads as open ground
// rather than a brighter patch of grid.
//
// The ribbon is STREET_WIDTH, not the full plot it owns, and the grid is
// GRID_SPACING, not CELL. Both are deliberate and they are the same decision
// made twice: the floor is meant to read as a fine MAP MESH with routes through
// it, and at plot-wide streets on cell-wide squares it read as a handful of big
// tiles instead. Scale the two together if either is retuned — a ribbon several
// grid squares wide goes back to looking like a gap in the mesh.
//
// A building's footprint (sprites.js's variantOpts, sited by citygrid.js's
// LOT) is the THIRD term in that same sentence, even though it never touches
// this tile: it is sized to a LOT rather than the PLOT a building used to have
// to itself, for exactly the same reason the ribbon and the grid are scaled to
// CELL rather than PLOT — a building several times the size of the block
// beneath it reads as a box standing on a mesh, not as the thing the mesh is
// a map OF. Retuning LOT_SUBDIV without rebalancing the footprint catalogue
// (or vice versa) breaks the same read the ribbon/grid pair breaks if scaled
// alone. None of this uses
// ctx.shadowBlur: this whole tile is one canvas-spanning path, and a shadow on
// a shape that size was measured at ~0.5ms/frame — a quarter of the whole
// frame, from one draw call (see neonStroke's own header for the same trade
// made for the road's barriers). The dashed centre lines get their glow the
// same way the grid does — neonStroke's overdraw passes — with ctx.setLineDash
// applied just around that one call.
//
// All of the above is a ONE-TIME cost (tile build, on first draw or a canvas
// resize), not a per-frame one, so it can afford more draw calls than the
// per-frame budget ever could.

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

// Phase 7f: the tile now varies by SECTOR too (BUILDING_EDGE/FLOOR_GRID/etc.
// are live bindings — see palette.js's setSector), so its key grows from
// (W, H) to (W, H, sector) and a single slot is no longer enough to hold
// "the tile on screen right now" across a crossing: the OLD sector's tile is
// still needed for whatever hasn't scrolled past the boundary yet while the
// NEW one gets built, or every frame straddling a boundary would rebuild.
// Bounded to 2 anyway, by hand, rather than left to grow with SECTOR_COUNT —
// this cache is module-local, not spritecache.js (which has no eviction at
// all), so nothing stops it from holding a stale tile for a canvas size that
// hasn't been on screen in an hour. 2 is also exactly what the design asks
// for: "as short as it looks good rather than as long as a rebuild takes"
// only works if the outgoing tile stays valid through the rescan, and no
// crossing ever needs a THIRD sector's tile alive at once.
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
// bakes (Phase 7d) — every (avenue column, cross-street band) pairing within
// the tile's own height, in the SAME tile-local coordinate space the ribbon
// loops in floorGridTile() below use (y0 a multiple of ARTERIAL_PERIOD, bx an
// avenue column — see isAvenueCol). Pulled out as its own pure function,
// rather than a loop written inline in floorGridTile(), for exactly the
// reason isAvenueCol/isCrossStreetRow are pure functions in citygrid.js
// instead of being re-derived wherever they're needed: a SECOND copy of this
// geometry is how the tile and citygrid.js's index math drifted a whole PLOT
// apart once already (see isCrossStreetRow's own "+1" comment). The test
// suite maps this tile-local list through gridPhase and cross-checks it
// against crossStreetBands()/avenueCenters() — this file's SCREEN-space,
// per-frame equivalent — rather than trusting this comment alone.
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

  // Registration ticks (Phase 7d): a small, uniform mark baked at every
  // avenue x cross-street INTERSECTION. Free — it's baked into this ONE-TIME
  // tile build like everything else in this function (see the header above),
  // so it costs literally nothing per frame. Deliberately UNIFORM, unlike a
  // NODE (citygrid.js's reserve() claim, drawn separately by scenery.js's own
  // drawFloorNodes): identical marks at every intersection read as a map's
  // own registration grid — survey ticks, a radar bezel — which is the whole
  // point, where a node instead has to be rare and distinguishable to read as
  // a facility rather than more grid furniture.
  //
  // Drawn as its own pass rather than folded into the two centre-line strokes
  // above: those are DASHED, so whether a dash segment actually lands on a
  // given crossing depends on the dash phase there, and a tick that only
  // showed up where a dash happened to overlap would flicker in and out
  // across the grid instead of marking every intersection alike.
  //
  // The point list comes from tileIntersections() above rather than a loop
  // written out here, so there is exactly ONE place that says where a tile
  // intersection falls — the test suite imports the same function and
  // cross-checks it against crossStreetBands()/avenueCenters() (this file's
  // own SCREEN-space, per-frame equivalent), rather than trusting a second
  // copy of this loop to stay in step with the ribbon loops above by
  // inspection. See citygrid.js's isCrossStreetRow "+1" comment for the bug
  // this exact kind of duplication already produced once.
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
// instead of simply existing there the instant a frame's walk reaches that
// far — the design doc's strongest "this world is being rendered for you"
// cue, and nearly free: a `clip` rect around a blit that's already being
// made (sprites.js's drawBuildingVariant/drawNodeVariant).
//
// SPANNED IN DISTANCE, NOT TIME. A time-based wipe needs an entry
// timestamp — the tick a building first came on screen — and that's state,
// the one thing every other layer on this floor goes out of its way not to
// need. A distance-based wipe needs none: `sy`, the row's own screen-y
// anchor (already computed below by visibleBuildings/visibleNodes), crosses
// 0 exactly once as fDist grows, and how far past that crossing it is IS the
// progress — a pure function of the row and the current fDist, recomputed
// fresh every frame, nothing to store and nothing to reset on newGame(). It
// also means a building materialises as the player APPROACHES it, which
// this doc's own view is the more correct behaviour anyway, not just the
// cheaper one.
//
// WIPE_SPAN IS SHORT ON PURPOSE. At a crawl, fDist barely moves, so a wide
// span would leave a building sitting part-drawn for a long time — reading
// as a bug, not an effect. 60 (floor-world units — this plane has no further
// projection, so that's also screen px) keeps it under LOT (64), which is
// what guarantees AT MOST ONE lot row is ever mid-wipe at once: two adjacent
// rows are exactly LOT apart in fDist (lotY's own spacing), so a span
// shorter than that can never have two rows' wipes overlap. A stopped player
// therefore always sees a single row resolving, never a band of
// half-buildings. At a ~400 floor-world-units/s cruising pace (fDist moves
// at FLOOR_PARALLAX x the player's own speed — see floorDist above), that
// lands the wipe at 60/200 = 0.3s, matching the design doc's figure;
// ~0.19s at the player's own top speed (620, floor speed 310), ~1.0s at the
// low end of the throttle (120, floor speed 60) — long at a crawl, but
// always confined to the one row.
export const WIPE_SPAN = 60;

// progress in [0, 1]. `sy` is the row's own screen-y anchor at THIS fDist —
// sy <= 0 means the row hasn't crossed the top edge yet (0, nothing to
// draw), sy >= WIPE_SPAN means it crossed at least WIPE_SPAN of floor
// distance ago (1, fully materialised — the fast, unclipped blit path in
// sprites.js). Monotonic in fDist for a fixed row, since sy only grows as
// fDist grows (see visibleBuildings/visibleNodes below), which is what
// makes "never un-materialises as you approach" a property of the formula
// rather than something that has to be maintained by hand.
//
// USED FOR THE FAST-PATH DECISION ONLY (progress >= 1?) — NOT for how much
// of the sprite the clip actually reveals. A sprite (glow padding included)
// is typically 100-170px tall, well over WIPE_SPAN (60): scaling the clip by
// this fraction of the SPRITE's own height, instead of by WIPE_SPAN's own
// px budget, was tried first and made the wipe invisible for most of its
// span — the canvas's own top-edge clip is already hiding everything above
// screen y=0, and a fraction-of-sprite-height clip catches up to (and
// overtakes) that natural edge after only the first ~25-30% of the wipe, at
// which point the explicit clip stops restricting anything a plain
// unclipped blit wouldn't already show. sprites.js's drawBuildingVariant/
// drawNodeVariant use the row's raw `sy` (passed alongside `progress`,
// always in (0, WIPE_SPAN) whenever this is < 1) against the sprite's own
// height instead — see their own comment for why that's what actually keeps
// the wipe visible for its whole span.
export function materialiseProgress(sy) {
  if (sy <= 0) return 0;
  if (sy >= WIPE_SPAN) return 1;
  return sy / WIPE_SPAN;
}

// COST, MEASURED (rAF-saturation, real non-sandboxed browser, six warmed
// samples, first discarded, median taken — this file's own established
// method). Two numbers matter, not one: WIPE_SPAN (60) sits just under LOT
// (64), so WIPE_SPAN/LOT = 60/64 of every LOT cycle has EXACTLY ONE row
// materialising somewhere on screen — meaning "some row is mid-wipe" is the
// REAL steady state a running game sees ~94% of the time, not a rare edge
// case, even though "at most one row" still holds (see WIPE_SPAN's own
// comment). scenery.render() measured ~0.41ms/frame with the materialising
// row's few buildings/nodes paying the clip+scanline (spritecache.js's
// blitSpriteMaterialising), against ~0.27ms/frame with fDist held in the
// ~4-unit gap where nothing is (the fast-path-only figure — confirms the
// unclipped branch itself hasn't moved). Both land inside this layer's own
// pre-7g range (~0.36-0.5ms across 7d-7f) rather than opening a new one, so
// the ~0.5ms whole-floor budget the design doc sets still holds without
// culling. A first version of the scanline (one fillRect/globalAlpha change
// per static fragment instead of batched paths) measured misleadingly high
// under a poorly-warmed benchmark; see spritecache.js's own note on the
// batching fix and the isolated per-call numbers that survived it.
//
// Every building lot visible this frame, in the far-to-near draw order, as
// plain data — no canvas anywhere in this function, mirroring trafficDots
// below: it's what lets test/invariants.test.js assert the walk's bound and
// its row order directly under plain Node instead of only by eye.
//
// Buildings sit on the floor's LOT grid (citygrid.js) — finer than the plot
// grid streets are claimed on — walked ROW BY LOT ROW, far (top) to near
// (bottom), so nearer footprints overlap farther ones. Subdividing plots into
// lots means a block's four lots can now span the same screen row at
// different depths only along y — never within a row, since a lot row is a
// fixed floor-world y band exactly like a plot row was — so walking lot rows
// in the same far-to-near order the old plot-row walk used is sufficient; get
// the row order wrong (say, iterating plot rows and drawing all four lots
// within one at once) and a near lot silently draws UNDER a far one, visible
// only at certain scroll offsets since the two rows share screen space for
// only part of a cycle.
//
// This walks lots and asks citygrid.js what stands on each; it never decides
// placement itself. Whatever else ends up owning lots later renders from the
// same walk, and can't collide with a building.
//
// COST. Subdividing plots into lots roughly quadruples the walk (~40 plots at
// 600x800 to ~160 lots — see invariants.test.js's own bound), and a second
// pass (citygrid.js's BUILD_CHANCE, 0.325 -> 0.85) pushed the eligible-lot
// fill rate to near-full to answer "the map still looks empty" — so this was
// re-measured, not assumed to still be flat: ~70 buildings visible on an
// average frame now (range 56-81, up from ~27 at the old chance, itself up
// from 5-10 with one building per plot), and scenery.render() as a whole —
// this walk, the grid blit and the traffic dots together — measured
// ~0.36ms/frame by the rAF-saturation method (README's profiling-traps
// section), up from ~0.25-0.26ms/frame at the old chance. Higher this time,
// not flat — a sprite-cache blit (~1.3us per the README) is real cost, and
// the extra ~40 buildings/frame are mostly actual blits rather than cheap
// index checks on lots that turn out EMPTY, since EMPTY is now the rare
// outcome. Still comfortably inside the design doc's ~0.5ms/frame budget for
// the whole city layer, so the README's "the city has no culling" stays true
// here, though with less headroom than before — a further density increase
// should re-measure rather than assume the same margin holds.
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
// `bx`/`by` ride along with the screen position (Phase 7e, game/links.js):
// a conduit's heading, a ping's phase and a console callsign all have to be
// derived from the SAME plot index that made this a node in the first place
// (citygrid.js's reserve()), not a second identity invented downstream —
// exactly the reasoning plotAt itself already documents for staying a pure
// function of (bx, by). Free to add: citygrid.js's own walk already has both
// in scope, this just stops discarding them at the return.
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
// floor — the grid, the streets, the buildings — is identical at a given index
// or screen position no matter WHEN you ask for it, which is what lets all of
// it be pre-rendered once. A traffic dot is the one thing here that ALSO
// depends on time. It is still not simulated: there is no car object, nothing
// spawns or despawns, nothing is stored per-dot. A dot's position is a pure
// function of (lane, dot index, clock) exactly the way a building's is a pure
// function of (bx, by) — `update(dt)` below only advances what "now" means for
// that function, on the same fixed step as every other per-run system (see
// main.js's update()), so the dots freeze exactly when the rest of the world
// does (paused, dying) instead of drifting on a clock of their own.
//
// Two lanes per street, opposite directions, at different speeds of their
// OWN — on top of, not instead of, the road's own scroll and this floor's
// FLOOR_PARALLAX, which is what sells the depth (see the design doc's "why
// the avenues matter most"). A cross-street's lanes slide in SCREEN X (the
// street runs left-right, an axis the floor never scrolls on at all); an
// avenue's lanes slide in SCREEN Y (the street runs top-to-bottom, the same
// axis — and same direction — the floor itself scrolls on, so an avenue
// lane's own speed has to be added to that scroll rather than measured
// against the screen in place of it — see laneDotPositions' `carry`) — each
// lane slides along its OWN street, never across it.

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

// Positions along ONE lane at a fixed spacing, shifted by `clockValue * speed
// + phase + carry`, bounded to the visible span [lo, hi] — NOT to a lane
// length. The design doc phrases this as `pos = (t*speed + offset) mod
// laneLength`, but a lane has no natural length to mod against (a street
// runs the full screen, forever), and inventing one risks a dot count that
// depends on the invented number rather than on the screen. Walking the
// index range that lands in [lo, hi] instead gives an infinite, evenly-spaced
// sequence and just asks which of it is on screen right now — the count
// stays bounded by (hi - lo) / spacing no matter how far `clockValue` has
// run. `phase` is a fixed px offset (see DOT_LANE_PHASE) for staggering a
// second lane running the same direction at the same speed, not something
// that varies with time.
//
// `carry`, unlike `phase`, DOES vary with time — it is trafficDots' own
// `fDist` for an avenue lane (0 for a cross-street one; see the call sites
// below for why only one of the two axes needs it). Without it a dot's
// speed was measured against the SCREEN, not the WORLD, which is wrong the
// moment the floor itself is also moving along that same axis — see
// trafficDots' avenue loop for the failure that shipped without this term.
// Exported so game/drones.js can place its own formations along a diagonal
// flight line with the exact same "positions along a lane, bounded to the
// visible span" arithmetic, rather than a second copy of it — the shape of
// the problem (an infinite evenly-spaced sequence, walked only where it's on
// screen) is identical, only the axis it's measured along differs.
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

  // AVENUES RUN ALONG SCREEN Y — the one axis the floor itself is also
  // scrolling on as the player drives (see render()'s fDist and
  // drawFloorBuildings' sy, both playerY - (worldY - fDist)). A cross-street
  // runs along screen x, which the floor never scrolls on at all (an avenue
  // column is a FIXED screen position — see avenueCenters/insideAvenue) — so
  // only this loop needs the fix below; the cross-street loop above is
  // already correct as written.
  //
  // A dot's speed here is meant to be its OWN motion on top of the floor's,
  // the same relative-motion relationship traffic.js's highway cars have to
  // `distance` — so its position has to carry `fDist` exactly like every
  // other thing on this floor does, or it is really being measured against
  // the SCREEN rather than the WORLD the floor represents.
  //
  // Shipped without this term first, and the failure was visible only at
  // speed: DOT_SPEED_A/B (55-70 px/s) is small next to how fast fDist itself
  // can move (up toward ~310 px/s at the player's own top speed, halved by
  // FLOOR_PARALLAX), so a dot's own contribution — the ONLY thing moving it,
  // with no `carry` term — was swamped by the floor scrolling underneath it
  // at a rate the dot knew nothing about. Every avenue dot read as being
  // carried along AT the player's own pace rather than driving its own
  // line — exactly backwards from the depth effect two independent speeds
  // (DOT_SPEED_A/B) exist to sell in the first place.
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

// Every dot in ONE fill() — the whole per-frame budget this layer gets (see
// the README's third rendering rule and the design doc's cost section).
// Multiple ctx.rect() calls between one beginPath()/fill() are one fill, not
// one each. No ctx.shadowBlur: the layer's glow is FLOOR_TRAFFIC's own alpha —
// a shadow across ~150 scattered small rects would cost far more than the
// rects themselves (see neon.js's own header for the same trade made at
// road-barrier scale, and the grid tile's header for it made at floor scale).
//
// MEASURED, trafficDots() + this function together, at 600x800 with a live
// 118-156 dots (four lanes per street — see DOT_LANE_OFFSET_INNER/OUTER):
// ~14us/frame — by the rAF-saturated-throughput method (README's own
// profiling-traps section), i.e. running the pair thousands of times inside
// one rAF callback until the callback's own elapsed time was many vsync
// ticks, not one call timed inside a single frame (which floors at vsync and
// reports nothing useful). Still comfortably inside the design doc's
// ~0.03ms (30us) budget for this layer despite the doubled lane count.
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
