// The city floor's plot grid — the single authority on WHAT OCCUPIES WHERE on
// the lower level the road flies over.
//
// Buildings used to be dropped at a hashed x anywhere across the screen, which
// made them impossible to plan around: anything else added to the floor later (a
// cross street, a plaza, a landing pad) could land on top of one, and there was
// nowhere to check. Now the floor is divided into square PLOTS, and every plot
// is claimed by exactly one thing. A new kind of scenery gets added as a claim
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

// Fraction of unclaimed plots that grow a building. Tuned to hold the skyline at
// the density the free-form placement had, ~1.3 buildings per 150 world units:
// with 5 plot columns on a 600px floor that's 1.3 / (5 * 150/PLOT) of plots.
const BUILD_CHANCE = 0.22;

// What a plot holds. Anything added later (roads, parks, pads) becomes another
// kind here and is claimed in reserve() below.
export const EMPTY = 0;
export const BUILDING = 1;

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

// Reserved plots: things other than buildings that own ground. Nothing claims
// any yet — this is the hook a future cross street or plaza hangs off, and it
// runs BEFORE the building roll so a claim always wins the plot outright.
function reserve(_bx, _by) {
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
