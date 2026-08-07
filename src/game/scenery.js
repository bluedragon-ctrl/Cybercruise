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
// the floor is divided into plots, and a plot's contents are — like the road — a
// pure function of its index, so the city is infinite and never pops.

import { drawBuildingVariant } from "./sprites.js";
import {
  CELL, PLOT, ARTERIAL_PERIOD, BUILDING, isAvenueCol,
  plotAt, plotX, plotY, plotColumns, plotRows,
} from "./citygrid.js";
import { neonStroke } from "../engine/neon.js";
import { FLOOR_GRID, FLOOR_STREET, FLOOR_STREET_LINE } from "../engine/palette.js";

// The floor drifts at this fraction of the road's travelled distance. Lower =
// feels further away / more depth. 0.5 = floor moves at half road speed.
export const FLOOR_PARALLAX = 0.5;

// The grid drawn below and the grid things are placed on are the same grid: both
// come from citygrid.js, so scenery can never drift out of step with placement.
const GRID_SPACING = CELL;

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
// The horizontals are world-anchored at every CELL, so the grid is exactly
// PERIODIC in y with period CELL. The verticals are fixed SCREEN columns, so the
// grid is static in x. A periodic-and-static layer is one tile, built once, and
// blitted once per frame at a phase offset — never rebuilt, never keyed.
//
// Avenues and cross-streets (citygrid.js) share the SAME property: an avenue is
// a fixed screen column, a cross-street is periodic in y — with period
// ARTERIAL_PERIOD (a whole multiple of CELL, since CELL divides PLOT divides
// ARTERIAL_PERIOD). A period that's a multiple of another period is still one
// period, so all three layers bake into ONE tile rather than three, and the
// floor stays at exactly one drawImage per frame. Concretely: the tile is built
// at ARTERIAL_PERIOD's phase, and because CELL divides that period, the CELL
// lines it already contains land correctly too — shifting a CELL-periodic
// pattern by any whole number of CELLs leaves it self-aligned, and
// ARTERIAL_PERIOD is exactly that (PLOT * 4 = CELL * 8).
//
// The tile is W x (H + ARTERIAL_PERIOD): one arterial period taller than the
// screen, so that whatever the phase, a single blit at destY in
// [-ARTERIAL_PERIOD, 0) still covers the bottom row — the same reasoning the
// old H + CELL tile used, just at the coarser period now driving the blit.
// 600x1312x4 = ~3.1MB, up from ~2MB when the tile only had to cover one CELL.
//
// EXACTNESS. The phase is (playerY + fDist) mod ARTERIAL_PERIOD and BOTH TERMS
// MATTER: a line world-anchored at k*ARTERIAL_PERIOD (or any multiple of CELL,
// since CELL divides the period) lands at screen playerY + fDist - k*period, so
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
// LOOK. Each street is a wide, dim fill (FLOOR_STREET) plus a brighter dashed
// centre line (FLOOR_STREET_LINE), and the fine CELL grid is skipped — not
// merely painted over — wherever it would cross a street, so the street reads
// as open ground rather than a brighter patch of grid. None of this uses
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

// True where canvas-local y falls inside a cross-street's band. Canvas y = 0
// stands for plot row by = 0, which citygrid.js's isCrossStreetRow makes a
// cross-street by convention, so the band occupies [0, PLOT) of every
// ARTERIAL_PERIOD — this is what the tile build and the CELL-grid suppression
// below both key off.
function insideCrossStreet(y) {
  const local = ((y % ARTERIAL_PERIOD) + ARTERIAL_PERIOD) % ARTERIAL_PERIOD;
  return local < PLOT;
}

// Same idea across x: canvas x = 0 stands for plot column bx = 0, an avenue by
// isAvenueCol's own convention (0 is always a multiple of AVENUE_COLS).
function insideAvenue(x) {
  return isAvenueCol(Math.floor(x / PLOT));
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
    g.fillRect(0, y0, W, PLOT);
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
    g.fillRect(x0, 0, PLOT, canvas.height);
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

// Buildings on the floor's plot grid, far (top) to near (bottom) so nearer boxes
// overlap farther ones. Some will sit under the road ribbon and get occluded —
// that's intentional: the highway flies over the city.
//
// This walks plots and asks citygrid.js what stands on each; it never decides
// placement itself. Whatever else ends up owning plots later renders from the
// same walk, and can't collide with a building.
function drawFloorBuildings(ctx, fDist, playerY, W, H) {
  const rows = plotRows(fDist + playerY - H - 40, fDist + playerY + 200);
  const cols = plotColumns(W);

  for (let by = rows.max; by >= rows.min; by--) {
    const sy = playerY - (plotY(by) - fDist); // plot centre, in screen y
    for (let bx = 0; bx < cols; bx++) {
      const plot = plotAt(bx, by);
      if (plot.type !== BUILDING) continue;

      const cx = plotX(bx);
      // Lean away from screen centre for a subtle shared vanishing point.
      drawBuildingVariant(ctx, cx, sy, plot.variant, cx >= W / 2);
    }
  }
}
