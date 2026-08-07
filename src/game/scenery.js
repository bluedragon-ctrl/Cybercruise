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

import { drawBuildingVariant } from "./sprites.js";
import {
  CELL, PLOT, ARTERIAL_PERIOD, BUILDING, isAvenueCol,
  lotAt, lotX, lotY, lotColumns, lotRows, plotColumns,
} from "./citygrid.js";
import { neonStroke } from "../engine/neon.js";
import { FLOOR_GRID, FLOOR_STREET, FLOOR_STREET_LINE, FLOOR_TRAFFIC } from "../engine/palette.js";

// The floor drifts at this fraction of the road's travelled distance. Lower =
// feels further away / more depth. 0.5 = floor moves at half road speed.
export const FLOOR_PARALLAX = 0.5;

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
  const fDist = Math.round(distance * FLOOR_PARALLAX);
  drawFloorGrid(ctx, fDist, playerY, W, H);
  drawFloorBuildings(ctx, fDist, playerY, W, H);
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

let gridTile = null;
let gridTileW = 0;
let gridTileH = 0;

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

// Build the tile if we don't have one for this canvas size. `document` is
// touched only in here, never at module scope — the test suite imports this file
// under plain Node (same rule as engine/spritecache.js).
function floorGridTile(W, H) {
  if (gridTile && gridTileW === W && gridTileH === H) return gridTile;

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

  gridTile = canvas;
  gridTileW = W;
  gridTileH = H;
  return gridTile;
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
export function drawFloorGrid(ctx, fDist, playerY, W, H) {
  ctx.drawImage(floorGridTile(W, H), 0, gridPhase(fDist, playerY) - ARTERIAL_PERIOD);
}

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
      buildings.push({ cx, sy: sy - lot.dy, ly, variant: lot.variant, leanRight: cx >= W / 2 });
    }
  }
  return buildings;
}

// Blits every visible building, far to near. Some will sit under the road
// ribbon and get occluded — that's intentional: the highway flies over the
// city.
function drawFloorBuildings(ctx, fDist, playerY, W, H) {
  for (const b of visibleBuildings(fDist, playerY, W, H)) {
    // Lean away from screen centre for a subtle shared vanishing point.
    drawBuildingVariant(ctx, b.cx, b.sy, b.variant, b.leanRight);
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
// Two lanes per street, opposite directions, at different speeds — different
// from both the road's own scroll and this floor's FLOOR_PARALLAX, which is
// what sells the depth (see the design doc's "why the avenues matter most").
// A cross-street's lanes slide in SCREEN X (the street runs left-right); an
// avenue's lanes slide in SCREEN Y (the street runs top-to-bottom, the
// direction of travel) — each lane slides along its OWN street, never across
// it.

let clock = 0;

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
const DOT_SPACING = 75;
const DOT_SPEED_A = 70;  // one direction's lanes
const DOT_SPEED_B = -55; // the other direction's lanes, opposite way —
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
const DOT_LANE_PHASE = DOT_SPACING / 2;

const DOT_LEN = 4; // long axis, along the direction of travel
const DOT_WID = 2; // short axis, across it

// Positions along ONE lane at a fixed spacing, shifted by `clockValue * speed
// + phase`, bounded to the visible span [lo, hi] — NOT to a lane length. The
// design doc phrases this as `pos = (t*speed + offset) mod laneLength`, but a
// lane has no natural length to mod against (a street runs the full screen,
// forever), and inventing one risks a dot count that depends on the invented
// number rather than on the screen. Walking the index range that lands in
// [lo, hi] instead gives an infinite, evenly-spaced sequence and just asks
// which of it is on screen right now — the count stays bounded by
// (hi - lo) / spacing no matter how far `clockValue` has run. `phase` is a
// fixed px offset (see DOT_LANE_PHASE) for staggering a second lane running
// the same direction at the same speed, not something that varies with time.
function laneDotPositions(spacing, speed, clockValue, lo, hi, phase = 0) {
  const shift = clockValue * speed + phase;
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

  for (const cx of avenueCenters(W)) {
    const xInnerA = cx - DOT_LANE_OFFSET_INNER;
    const xOuterA = cx - DOT_LANE_OFFSET_OUTER;
    const xInnerB = cx + DOT_LANE_OFFSET_INNER;
    const xOuterB = cx + DOT_LANE_OFFSET_OUTER;
    for (const y of laneDotPositions(DOT_SPACING, DOT_SPEED_A, clockValue, -DOT_MARGIN, H + DOT_MARGIN)) {
      dots.push({ x: xInnerA, y, alongX: false });
    }
    for (const y of laneDotPositions(DOT_SPACING, DOT_SPEED_A, clockValue, -DOT_MARGIN, H + DOT_MARGIN, DOT_LANE_PHASE)) {
      dots.push({ x: xOuterA, y, alongX: false });
    }
    for (const y of laneDotPositions(DOT_SPACING, DOT_SPEED_B, clockValue, -DOT_MARGIN, H + DOT_MARGIN)) {
      dots.push({ x: xInnerB, y, alongX: false });
    }
    for (const y of laneDotPositions(DOT_SPACING, DOT_SPEED_B, clockValue, -DOT_MARGIN, H + DOT_MARGIN, DOT_LANE_PHASE)) {
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
