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
// size, and a plot is a BLOCK_CELLS x BLOCK_CELLS square of cells, big enough
// that the largest building footprint (90 x 58) sits inside one with margin.
//
// STATELESS, like the road and the old placement: what occupies a plot is a pure
// function of its (bx, by) index, so the city is infinite, identical every time
// you drive past, and needs nothing generated or freed as we go. Plot rows are
// indexed in FLOOR-WORLD units (the parallax-scaled distance — see scenery.js);
// plot columns are indexed in screen x, matching the drawn grid's fixed columns,
// since the floor never pans sideways.

import { BUILDING_VARIANTS } from "./sprites.js";

export const CELL = 64;        // floor grid cell size (world units on the floor plane)
const BLOCK_CELLS = 2;         // a plot is this many cells on a side
export const PLOT = CELL * BLOCK_CELLS;

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

// Fraction of unclaimed plots that grow a building. Tuned to hold the skyline
// at the density the free-form placement had, ~1.3 buildings per 150 world
// units: with 5 plot columns on a 600px floor that's a baseline chance of
// 1.3 / (5 * 150/PLOT) =~ 0.222, back when every plot reached the roll.
// Streets now claim plots before the roll ever runs: avenues take 2 of the 5
// screen columns (2/5 = 0.4) and cross-streets take 1 of every
// CROSS_STREET_ROWS rows (1/4 = 0.25), so only
// (1 - 0.4) * (1 - 0.25) = 0.45 of plots are still eligible. Raised to hold
// the same overall density: 0.222 / 0.45 =~ 0.493.
const BUILD_CHANCE = 0.493;

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
export function isCrossStreetRow(by) {
  return mod(by, CROSS_STREET_ROWS) === 0;
}

// Deterministic hash -> [0, 1) from any number (same trick as road/scenery).
function hash(n) {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}

// Plot centres, in screen x and floor-world y.
export function plotX(bx) {
  return PLOT * (bx + 0.5);
}
export function plotY(by) {
  return PLOT * (by + 0.5);
}

// Plot columns whose centre falls on screen. The rightmost may hang off the
// edge, exactly as free-form placement used to at the screen margins.
export function plotColumns(W) {
  return Math.ceil(W / PLOT);
}

// Plot rows covering a floor-world y range, near (largest y) to far.
export function plotRows(worldBottom, worldTop) {
  return {
    min: Math.floor(worldBottom / PLOT),
    max: Math.ceil(worldTop / PLOT),
  };
}

// Reserved plots: things other than buildings that own ground. Runs BEFORE
// the building roll so a claim always wins the plot outright. Cross-streets
// are checked first: at an intersection a plot is both an avenue column and a
// cross-street row, and it only needs to come back as ONE type — plotAt's
// callers care that it isn't BUILDING, not which street claimed it.
function reserve(bx, by) {
  if (isCrossStreetRow(by)) return { type: CROSS_STREET };
  if (isAvenueCol(bx)) return { type: AVENUE };
  return null;
}

// What occupies plot (bx, by). Returns `{ type }`, plus a `variant` for
// buildings — never a position: the caller projects plotX/plotY itself.
export function plotAt(bx, by) {
  const claimed = reserve(bx, by);
  if (claimed) return claimed;

  const seed = bx * 73856 + by * 19349 + 1000;
  if (hash(seed * 1.13) > BUILD_CHANCE) return { type: EMPTY };

  return {
    type: BUILDING,
    variant: Math.floor(hash(seed * 2.31) * BUILDING_VARIANTS),
  };
}
