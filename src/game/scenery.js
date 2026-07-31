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
  const fDist = distance * FLOOR_PARALLAX;
  drawFloorGrid(ctx, fDist, playerY, W, H);
  drawFloorBuildings(ctx, fDist, playerY, W, H);
}

// Full-width Tron floor grid. Horizontal lines are world-anchored (scroll with
// fDist); vertical lines are fixed screen columns. Covers the whole screen — the
// road will paint over the middle, leaving the floor visible to either side.
function drawFloorGrid(ctx, fDist, playerY, W, H) {
  // The whole grid is one batched path, stroked WITHOUT ctx.shadowBlur. It spans
  // the entire canvas, so a shadow here blurred a full-screen bounding box for a
  // measured ~0.5ms/frame — a quarter of the whole frame, from one draw call.
  // neonStroke's overdraw keeps the soft edge for a fraction of that.
  neonStroke(
    ctx,
    (c) => {
      const worldBottom = fDist + playerY - H;
      const worldTop = fDist + playerY;
      const firstY = Math.ceil(worldBottom / GRID_SPACING) * GRID_SPACING;
      for (let wy = firstY; wy <= worldTop; wy += GRID_SPACING) {
        const sy = playerY - (wy - fDist);
        c.moveTo(0, sy);
        c.lineTo(W, sy);
      }
      for (let x = 0; x <= W; x += GRID_SPACING) {
        c.moveTo(x, 0);
        c.lineTo(x, H);
      }
    },
    FLOOR_GRID,
    1,
    3,
  );
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
