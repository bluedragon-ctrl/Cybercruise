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

// Distance from the road centre-line to each barrier, in px. The full road is
// twice this wide. Kept well under the 480px canvas so turns leave visible
// roadside space (for Phase 2 buildings) instead of filling the screen.
export const ROAD_HALF_WIDTH = 120;

// How far the road centre wanders left/right of the canvas centre, as a function
// of world distance. Two layered sines of different wavelengths give smooth,
// non-obviously-repeating turns. Keep the summed amplitude (70 + 30 = 100) such
// that centre ± ROAD_HALF_WIDTH stays mostly on-canvas:
//   centre range  ≈ 240 ± 100  = [140, 340]
//   road edges    ≈ [140-120, 340+120] = [20, 460]  → fits 0..480 with margin.
export function centerOffset(worldY) {
  return 70 * Math.sin(worldY * 0.0016) + 30 * Math.sin(worldY * 0.0043 + 1.7);
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

// Draw the road: tarmac fill, two glowing barriers, and a dashed centre line.
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

  // Tarmac: fill the ribbon between the two edge polylines.
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(left[0][0], left[0][1]);
  for (const p of left) ctx.lineTo(p[0], p[1]);
  for (let i = right.length - 1; i >= 0; i--) ctx.lineTo(right[i][0], right[i][1]);
  ctx.closePath();
  ctx.fillStyle = "rgba(18,34,60,0.35)";
  ctx.fill();
  ctx.restore();

  // Glowing neon barriers.
  glowPath(ctx, left, "#2ad4ff", 2, 12);
  glowPath(ctx, right, "#2ad4ff", 2, 12);

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
    glowLine(ctx, xA, syA, xB, syB, "#ffd23f", 3, 8);
  }
}
