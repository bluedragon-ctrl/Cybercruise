// The city floor's plot grid — the single authority on WHAT OCCUPIES WHERE on
// the lower level the road flies over.
//
// Buildings used to be dropped at a hashed x anywhere across the screen, which
// made them impossible to plan around: anything else added to the floor later (a
// cross street, a plaza, a landing pad) could land on top of one, and there was
// nowhere to check. Now the floor is divided into square PLOTS, and every plot
// is claimed by exactly one thing — avenues and cross-streets first (below),
// buildings on whatever's left. A new kind of scenery gets added as a claim
// here, and buildings automatically stop being placed there — no overlap
// possible, because the plot is the unit of ownership.
//
// The grid matches the one scenery.js actually draws: CELL is the drawn cell
// size, and a plot is a BLOCK_CELLS x BLOCK_CELLS square of cells.
//
// PLOTS ARE FOR STREETS, LOTS ARE FOR BUILDINGS. A single building per plot
// (128 wide) floated in the middle of a lot several times its own size and read
// as scattered boxes rather than a city — a city reads as blocks because
// buildings are smaller than the block, several stand on it, and they front
// onto the street. So a plot subdivides again, below, into LOTs — the unit a
// building actually stands on — the same move that made the drawn grid read as
// a fine mesh (see scenery.js's GRID_SUBDIV): a SUBDIVISION of the existing
// grid, not a freely-chosen size, so every alignment invariant a plot already
// satisfies (CELL divides it, ARTERIAL_PERIOD is a multiple of it) survives
// untouched.
//
// STATELESS, like the road and the old placement: what occupies a plot OR a lot
// is a pure function of its index, so the city is infinite, identical every
// time you drive past, and needs nothing generated or freed as we go. Plot/lot
// rows are indexed in FLOOR-WORLD units (the parallax-scaled distance — see
// scenery.js); columns are indexed in screen x, matching the drawn grid's fixed
// columns, since the floor never pans sideways.

import { BUILDING_VARIANTS, buildingFootprint } from "./sprites.js";

export const CELL = 64;        // floor grid cell size (world units on the floor plane)
const BLOCK_CELLS = 2;         // a plot is this many cells on a side
export const PLOT = CELL * BLOCK_CELLS;

// A plot subdivides into LOT_SUBDIV x LOT_SUBDIV lots — the unit a building
// actually stands on. 2 gives LOT = CELL (64) and up to four buildings per
// block — the obvious first thing to try, since it lands a lot on an existing
// grid cell rather than a fraction of one, and it was what shipped after
// comparing it in the browser against LOT_SUBDIV = 4 (LOT = 32, one HALF of a
// drawn grid cell): at 4, the catalogue's footprints (sized for a 64 lot —
// see sprites.js's variantOpts) had to shrink again to fit, and eight
// buildings a block read as a field of sheds rather than a city block — busier
// without reading as denser. 2 gives four genuinely city-block-sized buildings
// per block and is kept.
export const LOT_SUBDIV = 2;
export const LOT = PLOT / LOT_SUBDIV; // 64

// Clearance a sited footprint leaves between itself and the kerb it's pushed
// against. ZERO, deliberately: a kerb-facing edge is pushed flush to its own
// LOT boundary, which — since GRID_SPACING divides LOT — is always a real
// drawn grid line, so a pushed footprint's outer edge lands ON the mesh
// instead of floating a few px short of it. A visible sidewalk gap still
// exists: it's STREET_INSET (32) on the NEIGHBOURING plot, between that
// boundary and the actual painted ribbon (see the siting-never-crosses-a-
// ribbon test in invariants.test.js) — this constant would only add a SECOND,
// grid-unaligned gap on top of that one. Non-zero was tried first and
// rejected for exactly that reason.
const LOT_MARGIN = 0;

// Streets, claimed in reserve() below. An avenue runs along the driving
// direction, so it is a fixed SCREEN column, exactly like the grid's own
// verticals; a cross-street runs perpendicular, so it is periodic in
// FLOOR-WORLD y, exactly like the grid's own horizontals.
//
// AVENUE_COLS: every 3rd plot column. 5 plot columns on a 600px floor
// (plotColumns(600) = 5) puts avenues at bx = 0 and bx = 3 — 2 avenues on
// screen, per the design doc.
const AVENUE_COLS = 3;
// CROSS_STREET_ROWS: every 4th plot row — frequent enough that the buildings
// between two cross-streets read as one block, not so frequent that the
// skyline thins out.
const CROSS_STREET_ROWS = 4;

// The world-y period at which the whole street pattern (and therefore the
// combined floor tile — see scenery.js) repeats. CELL divides PLOT divides
// this, which is exactly what lets the grid, the avenues and the
// cross-streets share one pre-rendered tile instead of needing three.
export const ARTERIAL_PERIOD = PLOT * CROSS_STREET_ROWS; // 512

// Fraction of unclaimed LOTS that grow a building. Superseded a first pass
// (0.325) that held built AREA roughly constant against the pre-lot city —
// area-preservation is the wrong target once the ask is explicitly a DENSER
// map, not a same-density one at finer grain: at 0.325 the eligible lots
// between two avenues still read as scattered rather than as a block, which
// is what "few buildings between highways" (the reported problem) is a
// description of. This targets near-FULL occupancy of eligible ground
// instead, since the tactical-map goal (see the design doc's Purpose) is
// continuous city fabric between streets, not naturalistic vacancy — a real
// city block doesn't have empty lots for texture.
//
// 0.85 measured (test/invariants.test.js samples lotAt directly rather than
// trusting this comment): eligible-lot fraction is unchanged at 0.45 — see
// the LOT subdivision comment above, this is a claim about the DENOMINATOR,
// which streets still remove before this roll ever runs — so 0.85 realizes
// as 0.85 x 0.45 =~ 0.38 of ALL lots built, versus 0.325 x 0.45 =~ 0.15
// before. Visible buildings at 600x800 (scenery.js's visibleBuildings, the
// same sampling its own cost comment uses): mean ~70/frame (range 56-81)
// against the prior ~27 (range up to 41) — roughly 2.6x, not merely "more".
const BUILD_CHANCE = 0.85;

// What a plot holds. Anything added later (parks, pads, ...) becomes another
// kind here and is claimed in reserve() below.
export const EMPTY = 0;
export const BUILDING = 1;
export const AVENUE = 2;
export const CROSS_STREET = 3;

// Modulo that stays positive for negative bx/by — plot rows run both
// directions of travel, and JS's % keeps the sign of its left operand.
function mod(n, m) {
  return ((n % m) + m) % m;
}

// Pure functions of the index, like everything else here, so scenery.js can
// ask "is this column/row a street" without going through plotAt/reserve —
// it needs to know for every screen column and every row in the tile, not
// just the ones a walked plot happens to land on.
export function isAvenueCol(bx) {
  return mod(bx, AVENUE_COLS) === 0;
}
// The +1 is load-bearing, not cosmetic. scenery.js's cross-street ribbon is
// periodic in y via gridPhase()/ARTERIAL_PERIOD, a SEPARATE derivation from
// this function, and the two only agree if this checks by ≡ -1 (mod
// CROSS_STREET_ROWS) rather than by ≡ 0: the tile's phase formula anchors
// n = 0's ribbon one whole PLOT short of by = 0, a discrepancy found by
// checking crossStreetBands' actual screen output against this function
// directly (invariants.test.js's own "isCrossStreetRow agrees with where the
// ribbon is actually painted" test) rather than by trusting the two modules'
// prose comments to still agree with each other. Dropping the +1 puts
// buildings back to being sited flush against a plot boundary that ISN'T
// where the painted ribbon is — quiet with the single centred building a
// plot used to hold, glaring once lots push footprints against it.
export function isCrossStreetRow(by) {
  return mod(by + 1, CROSS_STREET_ROWS) === 0;
}

// Deterministic hash -> [0, 1) from any number (same trick as road/scenery).
function hash(n) {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}

// Plot columns whose centre falls on screen. The rightmost may hang off the
// edge, exactly as free-form placement used to at the screen margins. Still
// used directly (not via lots) by anything that only cares about STREETS,
// which are claimed a whole plot at a time — see scenery.js's avenueCenters.
export function plotColumns(W) {
  return Math.ceil(W / PLOT);
}

// Reserved plots: things other than buildings that own ground. Runs BEFORE
// any lot within the plot is looked at, so a claim always wins the WHOLE
// plot outright — streets are a plot-level concept and stay one regardless of
// how finely lots subdivide a plot for buildings. Cross-streets are checked
// first: at an intersection a plot is both an avenue column and a
// cross-street row, and it only needs to come back as ONE type — callers care
// that it isn't BUILDING, not which street claimed it.
function reserve(bx, by) {
  if (isCrossStreetRow(by)) return { type: CROSS_STREET };
  if (isAvenueCol(bx)) return { type: AVENUE };
  return null;
}

// Lot centres, in screen x and floor-world y — the position a building would
// stand at if it were centred on its lot. Actual siting (below) offsets from
// this toward whichever edge faces a street.
export function lotX(lx) {
  return LOT * (lx + 0.5);
}
export function lotY(ly) {
  return LOT * (ly + 0.5);
}

// Lot columns whose centre falls on screen, and lot rows covering a
// floor-world y range — the lot-grained equivalents scenery.js's building walk
// needs (see plotColumns/its old plotRows for the plot-grained originals).
export function lotColumns(W) {
  return Math.ceil(W / LOT);
}
export function lotRows(worldBottom, worldTop) {
  return {
    min: Math.floor(worldBottom / LOT),
    max: Math.ceil(worldTop / LOT),
  };
}

// Which plot lot (lx, ly) belongs to, and where within it: (subX, subY) each
// run [0, LOT_SUBDIV), (0, 0) being the lot closest to the plot's own (bx, by)
// origin. Math.floor divides correctly for negative lx/ly (lot rows run both
// directions of travel), so this needs no mod() of its own for bx/by.
function lotPlot(lx, ly) {
  return {
    bx: Math.floor(lx / LOT_SUBDIV),
    by: Math.floor(ly / LOT_SUBDIV),
    subX: mod(lx, LOT_SUBDIV),
    subY: mod(ly, LOT_SUBDIV),
  };
}

// Which of a lot's edges face a street, known from the index alone: a lot
// only ever touches a street along an edge it shares with the PLOT boundary
// (sub == 0 is the plot's low edge, sub == LOT_SUBDIV - 1 its high edge), and
// only if the PLOT on the far side of that edge is itself a street. An
// interior lot (LOT_SUBDIV > 2 would have some) touches no plot edge in that
// axis and never fronts a street there.
function frontage(bx, by, subX, subY) {
  return {
    lo: subX === 0 && isAvenueCol(bx - 1),
    hi: subX === LOT_SUBDIV - 1 && isAvenueCol(bx + 1),
    top: subY === 0 && isCrossStreetRow(by - 1),
    bottom: subY === LOT_SUBDIV - 1 && isCrossStreetRow(by + 1),
  };
}

// Offset from the lot centre that pushes a `dim`-wide footprint flush against
// whichever edge faces a street, instead of centring it. A lot facing streets
// on both axes (a corner) gets pushed on both at once, siting the footprint
// into the corner. A lot facing no street on an axis stays centred on that
// axis — there's no kerb to front onto, and the lot centre is itself
// grid-aligned (LOT is a multiple of GRID_SPACING), so centring doesn't
// reintroduce the off-mesh floating LOT_MARGIN > 0 used to cause.
function edgeOffset(faceLo, faceHi, dim) {
  const half = LOT / 2;
  if (faceLo) return LOT_MARGIN + dim / 2 - half;
  if (faceHi) return half - LOT_MARGIN - dim / 2;
  return 0;
}

// What occupies lot (lx, ly). Returns `{ type }` for anything that isn't a
// building; a building additionally carries `variant` and the `dx`/`dy` its
// footprint is sited at, offset from lotX(lx)/lotY(ly) — still not an
// absolute position: the caller projects lotX/lotY itself, exactly as
// plotX/plotY used to work for the single-building-per-plot placement this
// replaces.
export function lotAt(lx, ly) {
  const { bx, by, subX, subY } = lotPlot(lx, ly);
  const claimed = reserve(bx, by);
  if (claimed) return claimed;

  const seed = lx * 92821 + ly * 68917 + 2000; // distinct seed space from the old plot roll
  if (hash(seed * 1.13) > BUILD_CHANCE) return { type: EMPTY };

  const variant = Math.floor(hash(seed * 2.31) * BUILDING_VARIANTS);
  const { w, d } = buildingFootprint(variant);
  const f = frontage(bx, by, subX, subY);
  return {
    type: BUILDING,
    variant,
    dx: edgeOffset(f.lo, f.hi, w),
    dy: edgeOffset(f.top, f.bottom, d),
  };
}
