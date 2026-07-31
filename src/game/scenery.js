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
// Like the road, placement is stateless/deterministic: a building is a pure
// function of its slot index, so the city is infinite and never pops.

import { drawBuildingVariant, BUILDING_VARIANTS } from "./sprites.js";
import { neonStroke } from "../engine/neon.js";
import { FLOOR_GRID } from "../engine/palette.js";

// The floor drifts at this fraction of the road's travelled distance. Lower =
// feels further away / more depth. 0.5 = floor moves at half road speed.
export const FLOOR_PARALLAX = 0.5;

const GRID_SPACING = 64;   // floor grid cell size (px/world units on the floor plane)
const SLOT_SPACING = 150;  // world units between building slots along the floor
const PRESENCE = 0.65;     // fraction of building slots that are occupied

// Deterministic hash -> [0, 1) from any number (same trick as road/buildings).
function hash(n) {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}

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

// Cube buildings scattered across the city floor, far (top) to near (bottom) so
// nearer boxes overlap farther ones. Some will sit under the road ribbon and get
// occluded — that's intentional: the highway flies over the city.
function drawFloorBuildings(ctx, fDist, playerY, W, H) {
  const worldBottom = fDist + playerY - H - 40;
  const worldTop = fDist + playerY + 200;
  const kMin = Math.floor(worldBottom / SLOT_SPACING);
  const kMax = Math.ceil(worldTop / SLOT_SPACING);

  for (let k = kMax; k >= kMin; k--) {
    const worldY = k * SLOT_SPACING;
    const sy = playerY - (worldY - fDist);

    // Two candidate buildings per slot, spread across the screen width.
    for (let i = 0; i < 2; i++) {
      const seed = k * 7 + i * 3 + 1000;
      if (hash(seed * 1.13) > PRESENCE) continue;

      const cx = hash(seed * 2.37) * W;         // anywhere across the floor
      // Pick one of the pre-rendered building looks rather than rolling free
      // dimensions, so the sprite cache stays bounded (see sprites.js). Placement
      // is still fully deterministic per slot, so nothing pops or shifts.
      const v = Math.floor(hash(seed * 2.31) * BUILDING_VARIANTS);
      // Lean away from screen centre for a subtle shared vanishing point.
      drawBuildingVariant(ctx, cx, sy, v, cx >= W / 2);
    }
  }
}
