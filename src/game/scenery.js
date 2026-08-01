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
import { CELL, BUILDING, plotAt, plotX, plotY, plotColumns, plotRows } from "./citygrid.js";
import { neonStroke } from "../engine/neon.js";
import { FLOOR_GRID } from "../engine/palette.js";

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

// --- The floor grid is ONE pre-rendered tile ---------------------------------
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
// The tile is W x (H + CELL): one cell taller than the screen, so that whatever
// the phase, a single blit at destY in [-CELL, 0) still covers the bottom row.
// 600x864x4 = ~2MB.
//
// EXACTNESS. The phase is (playerY + fDist) mod CELL and BOTH TERMS MATTER: a
// horizontal at world k*CELL lands at screen playerY + fDist - k*CELL, so the
// whole set sits at that sum's residue. Dropping playerY (an easy thing to talk
// yourself into, since it is a constant) misplaces the whole grid.
//
// Diffed against the direct re-stroke at integer fDist: mean 0.07-0.25/255, and
// no single channel off by more than 4. Everything that differs is 8-bit rounding
// — the tile composites a faint halo onto transparency and then onto the
// background, where the direct render rounds once. Drop the playerY term and the
// same diff jumps to a mean of 1.2 with channels off by 32, which is what says
// the measurement can actually see a phase error rather than being blind to one.

let gridTile = null;
let gridTileW = 0;
let gridTileH = 0;

// Build the tile if we don't have one for this canvas size. `document` is
// touched only in here, never at module scope — the test suite imports this file
// under plain Node (same rule as engine/spritecache.js).
function floorGridTile(W, H) {
  if (gridTile && gridTileW === W && gridTileH === H) return gridTile;

  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H + GRID_SPACING;
  const g = canvas.getContext("2d");

  // The whole grid is one batched path, stroked WITHOUT ctx.shadowBlur. It spans
  // the entire canvas, so a shadow here blurred a full-screen bounding box for a
  // measured ~0.5ms/frame — a quarter of the whole frame, from one draw call.
  // neonStroke's overdraw keeps the soft edge for a fraction of that.
  //
  // Verticals run the tile's FULL height rather than the screen's, so they scroll
  // off both edges instead of showing a round line-cap at the screen boundary.
  neonStroke(
    g,
    (c) => {
      for (let y = 0; y <= canvas.height; y += GRID_SPACING) {
        c.moveTo(0, y);
        c.lineTo(W, y);
      }
      for (let x = 0; x <= W; x += GRID_SPACING) {
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

// The grid's phase: where the world-anchored horizontals fall inside one cell,
// in screen y. Exported so a test can assert it against the world->screen
// mapping rather than trusting the comment above.
export function gridPhase(fDist, playerY) {
  return (((playerY + fDist) % GRID_SPACING) + GRID_SPACING) % GRID_SPACING;
}

// Full-width Tron floor grid: one blit. The road will paint over the middle,
// leaving the floor visible to either side.
//
// Exported (rather than kept private like drawFloorBuildings) so the blit can be
// pixel-diffed against a direct re-stroke IN ISOLATION — buildings drawn on top
// would mask exactly the rows a phase error shows up in.
export function drawFloorGrid(ctx, fDist, playerY, W, H) {
  ctx.drawImage(floorGridTile(W, H), 0, gridPhase(fDist, playerY) - GRID_SPACING);
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
