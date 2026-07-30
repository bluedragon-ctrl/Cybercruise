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
import { GREEN, GREEN_PALE, ROADSIDE_FILL } from "../engine/palette.js";

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

  // Roadside: faint green ground on both sides, OUTSIDE the barriers. The road
  // surface itself is left unfilled (black canvas background), which reads more
  // like real tarmac and makes the green barriers pop. Each side is the region
  // between a screen edge (x=0 or x=W) and its barrier polyline.
  ctx.save();
  ctx.fillStyle = ROADSIDE_FILL;
  // Left roadside: down the left barrier, then back up the screen's left edge.
  ctx.beginPath();
  ctx.moveTo(0, left[0][1]);
  for (const p of left) ctx.lineTo(p[0], p[1]);
  ctx.lineTo(0, left[left.length - 1][1]);
  ctx.closePath();
  ctx.fill();
  // Right roadside: down the right barrier, then back up the screen's right edge.
  ctx.beginPath();
  ctx.moveTo(W, right[0][1]);
  for (const p of right) ctx.lineTo(p[0], p[1]);
  ctx.lineTo(W, right[right.length - 1][1]);
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
