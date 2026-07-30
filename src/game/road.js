// The road — an infinitely long, procedurally curving neon highway.
//
// COORDINATE MODEL (top-down, flat — not pseudo-3D)
// --------------------------------------------------
// `distance` is how far the car has travelled along the road, in world units
// (it only ever increases, driven by player speed). Larger world-Y = further
// AHEAD of the car.
//
// The camera keeps the player pinned at a fixed screen row (`playerY`). A screen
// row `sy` therefore maps to a world position:
//
//     worldY = distance + (playerY - sy)
//
// so rows ABOVE the player (smaller sy) are ahead (larger worldY) and rows below
// are behind. Inverting: sy = playerY - (worldY - distance).
//
// The road's shape is a pure function of worldY (see centerOffset), which makes
// it deterministic and infinite with no stored state — any world position always
// yields the same curve, so nothing needs to be generated or freed as we drive.

import { glowPath, glowLine } from "../engine/neon.js";
import { GREEN, GREEN_PALE, GREEN_DIM, ROAD_SURFACE, WALL_FILL } from "../engine/palette.js";

// Spacing of the roadside floor grid, in px/world-units (square cells). Also the
// natural unit for placing Phase 2 buildings, which will sit on this grid.
export const GRID_SPACING = 60;

// Distance from the road centre-line to each barrier, in px. The full road is
// twice this wide. Deliberately kept well under the 600px canvas width so the
// road never fills the screen — turns leave wide roadside space on both sides
// for Phase 2 buildings/scenery.
export const ROAD_HALF_WIDTH = 130;

// How far the road centre wanders left/right of the canvas centre, as a function
// of world distance. Two layered sines of different wavelengths give smooth,
// non-obviously-repeating turns. The summed amplitude (90 + 40 = 130) keeps the
// road on-canvas while always leaving roadside margin, on a 600px-wide canvas:
//   centre range ≈ 300 ± 130 = [170, 430]
//   road edges   ≈ [170-130, 430+130] = [40, 560]  → always ≥40px off each edge,
//   and up to ~170px of roadside when the road is centred.
export function centerOffset(worldY) {
  return 90 * Math.sin(worldY * 0.0016) + 40 * Math.sin(worldY * 0.0043 + 1.7);
}

// Road geometry (in screen x) at a given world distance.
export function edgesAt(worldY, canvasW) {
  const center = canvasW / 2 + centerOffset(worldY);
  return {
    center,
    left: center - ROAD_HALF_WIDTH,
    right: center + ROAD_HALF_WIDTH,
  };
}

// Elevated-road side wall: how far the outer face drops toward the lower city
// floor. dy = downward (elevation), dx = slight outward reveal of the face.
const WALL_DY = 11;
const WALL_DX = 6;

// Draw the road as an ELEVATED ribbon over the parallax city floor (see
// scenery.js): a dark side wall on each edge to give it height, an OPAQUE tarmac
// surface that occludes the floor beneath, two glowing barriers, and the dashed
// centre line.
export function render(ctx, distance, playerY, W, H) {
  const step = 8; // px between edge samples; smaller = smoother curve, more cost

  // Sample both barriers across the full height (with a little overscan so the
  // glowing line runs off the top/bottom edges rather than stopping short).
  const left = [];
  const right = [];
  for (let sy = -step; sy <= H + step; sy += step) {
    const worldY = distance + (playerY - sy);
    const e = edgesAt(worldY, W);
    left.push([e.left, sy]);
    right.push([e.right, sy]);
  }

  // Elevated side walls (drawn first; the tarmac surface then overlaps their
  // tops so only the outer face shows below each barrier).
  drawRoadWall(ctx, left, -1);
  drawRoadWall(ctx, right, +1);

  // Opaque tarmac surface between the barriers — occludes the city floor drawn
  // behind it, which is what makes the road read as a raised ribbon rather than
  // a hole cut in the grid.
  ctx.save();
  ctx.fillStyle = ROAD_SURFACE;
  ctx.beginPath();
  ctx.moveTo(left[0][0], left[0][1]);
  for (const p of left) ctx.lineTo(p[0], p[1]);
  for (let i = right.length - 1; i >= 0; i--) ctx.lineTo(right[i][0], right[i][1]);
  ctx.closePath();
  ctx.fill();
  ctx.restore();

  // Glowing neon barriers.
  glowPath(ctx, left, GREEN, 2, 12);
  glowPath(ctx, right, GREEN, 2, 12);

  // Dashed yellow centre line. Dashes are tied to WORLD position (not screen)
  // so they scroll naturally with the road instead of shimmering in place.
  const dash = 26;
  const span = dash + 26; // dash + gap
  const worldBottom = distance + playerY - H; // smallest visible worldY
  const worldTop = distance + playerY; // largest visible worldY
  const firstDash = Math.ceil(worldBottom / span) * span;
  for (let wy = firstDash; wy <= worldTop; wy += span) {
    const syA = playerY - (wy - distance);
    const syB = playerY - (wy + dash - distance);
    const xA = W / 2 + centerOffset(wy);
    const xB = W / 2 + centerOffset(wy + dash);
    glowLine(ctx, xA, syA, xB, syB, GREEN_PALE, 3, 8);
  }
}

// Draws one elevated side wall from a barrier edge polyline. The wall's top edge
// is the barrier itself; its bottom edge is offset DOWN (elevation) and slightly
// OUTWARD (`sign`: -1 left / +1 right) to reveal the outer face. Filled dark with
// a dim-green bottom rim so the road reads as a raised ribbon above the city
// floor. `edge` is the top->bottom sample array built by render().
function drawRoadWall(ctx, edge, sign) {
  ctx.save();

  // Wall face quad: down the barrier (top edge), then back up the offset edge.
  ctx.beginPath();
  ctx.moveTo(edge[0][0], edge[0][1]);
  for (const p of edge) ctx.lineTo(p[0], p[1]);
  for (let i = edge.length - 1; i >= 0; i--) {
    ctx.lineTo(edge[i][0] + sign * WALL_DX, edge[i][1] + WALL_DY);
  }
  ctx.closePath();
  ctx.fillStyle = WALL_FILL;
  ctx.fill();

  // Dim-green bottom rim (the base of the wall meeting the city floor).
  ctx.strokeStyle = GREEN_DIM;
  ctx.lineWidth = 1.5;
  ctx.shadowColor = GREEN_DIM;
  ctx.shadowBlur = 6;
  ctx.beginPath();
  ctx.moveTo(edge[0][0] + sign * WALL_DX, edge[0][1] + WALL_DY);
  for (let i = 1; i < edge.length; i++) {
    ctx.lineTo(edge[i][0] + sign * WALL_DX, edge[i][1] + WALL_DY);
  }
  ctx.stroke();
  ctx.restore();
}
