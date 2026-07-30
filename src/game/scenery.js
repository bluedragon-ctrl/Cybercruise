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

import { drawBuilding } from "./sprites.js";
import { GREEN, FLOOR_GRID } from "../engine/palette.js";

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
  ctx.save();
  ctx.strokeStyle = FLOOR_GRID;
  ctx.lineWidth = 1;
  ctx.shadowColor = FLOOR_GRID;
  ctx.shadowBlur = 3;
  ctx.beginPath();

  const worldBottom = fDist + playerY - H;
  const worldTop = fDist + playerY;
  const firstY = Math.ceil(worldBottom / GRID_SPACING) * GRID_SPACING;
  for (let wy = firstY; wy <= worldTop; wy += GRID_SPACING) {
    const sy = playerY - (wy - fDist);
    ctx.moveTo(0, sy);
    ctx.lineTo(W, sy);
  }
  for (let x = 0; x <= W; x += GRID_SPACING) {
    ctx.moveTo(x, 0);
    ctx.lineTo(x, H);
  }
  ctx.stroke();
  ctx.restore();
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
      const height = 24 + hash(seed * 2.31) * 74;
      const w = 40 + hash(seed * 3.77) * 48;
      const d = 34 + hash(seed * 4.91) * 24;
      const lit = 0.3 + hash(seed * 5.53) * 0.5;
      // Lean away from screen centre for a subtle shared vanishing point.
      const skew = cx < W / 2 ? -0.26 : 0.26;

      drawBuilding(ctx, cx, sy, { w, d, height, color: GREEN, lit, seed, skew });
    }
  }
}
