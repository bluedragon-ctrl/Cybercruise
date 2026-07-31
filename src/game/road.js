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

import { neonStroke } from "../engine/neon.js";
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

// Screen x of the road's centre-line at a given world distance.
export function centerXAt(worldY, canvasW) {
  return canvasW / 2 + centerOffset(worldY);
}

// Road geometry (in screen x) at a given world distance.
export function edgesAt(worldY, canvasW) {
  const center = centerXAt(worldY, canvasW);
  return {
    center,
    left: center - ROAD_HALF_WIDTH,
    right: center + ROAD_HALF_WIDTH,
  };
}

// --- Lanes -----------------------------------------------------------------
// The road carries LANE_COUNT equal lanes. A lane is expressed as a LATERAL
// OFFSET from the centre-line (px), never as a screen x: add it to centerXAt()
// for the car's own worldY and the car tracks every curve for free, with no
// per-entity steering needed to stay on the tarmac. Traffic (traffic.js) is
// placed this way; the player instead steers in raw screen x and is clamped to
// the edges, since a human aims at the screen, not at a lane.
export const LANE_COUNT = 4;
export const LANE_WIDTH = (ROAD_HALF_WIDTH * 2) / LANE_COUNT;

export function laneOffset(i) {
  return (i + 0.5) * LANE_WIDTH - ROAD_HALF_WIDTH;
}

// Which lane a lateral offset falls in. The inverse of laneOffset, clamped to
// the road: a car shoved across the tarmac (collisions.js) needs to know where
// it ended up, not where it was spawned.
export function laneAt(offset) {
  const i = Math.floor((offset + ROAD_HALF_WIDTH) / LANE_WIDTH);
  return Math.max(0, Math.min(LANE_COUNT - 1, i));
}

// Elevated-road side wall: how far the outer face drops toward the lower city
// floor. dy = downward (elevation), dx = slight outward reveal of the face.
const WALL_DY = 11;
const WALL_DX = 6;

// --- Edge sampling buffers -------------------------------------------------
// The road edges are re-sampled every frame, which used to allocate ~206 short
// [x, y] arrays plus ~103 edgesAt() result objects per frame — around 19k
// objects/second at 60fps, enough to show up as GC hitches. The samples now live
// in reusable typed arrays: the screen rows are fixed (SAMPLE_STEP apart, so
// sampleY never changes), and only the x columns are rewritten each frame.

const SAMPLE_STEP = 8; // px between edge samples; smaller = smoother, more cost

let sampleCount = 0;
let sampleY = null; // screen y of each sample row (constant for a given height)
let leftX = null; // left barrier x per row
let rightX = null; // right barrier x per row

// (Re)allocate the buffers if the canvas height changed. Overscans by one step
// top and bottom so the glowing edges run off-screen rather than stopping short.
function ensureSamples(H) {
  const n = Math.floor((H + 2 * SAMPLE_STEP) / SAMPLE_STEP) + 1;
  if (n === sampleCount) return;
  sampleCount = n;
  sampleY = new Float32Array(n);
  leftX = new Float32Array(n);
  rightX = new Float32Array(n);
  for (let i = 0; i < n; i++) sampleY[i] = -SAMPLE_STEP + i * SAMPLE_STEP;
}

// Rewrite leftX/rightX for the current scroll position.
function sampleEdges(distance, playerY, W, H) {
  ensureSamples(H);
  const mid = W / 2;
  for (let i = 0; i < sampleCount; i++) {
    const center = mid + centerOffset(distance + (playerY - sampleY[i]));
    leftX[i] = center - ROAD_HALF_WIDTH;
    rightX[i] = center + ROAD_HALF_WIDTH;
  }
}

// Trace one sampled edge, optionally offset (used for the wall's bottom rim).
function traceEdge(ctx, edgeX, dx = 0, dy = 0) {
  ctx.moveTo(edgeX[0] + dx, sampleY[0] + dy);
  for (let i = 1; i < sampleCount; i++) ctx.lineTo(edgeX[i] + dx, sampleY[i] + dy);
}

// Draw the road as an ELEVATED ribbon over the parallax city floor (see
// scenery.js): a dark side wall on each edge to give it height, an OPAQUE tarmac
// surface that occludes the floor beneath, two glowing barriers, and the dashed
// centre line.
export function render(ctx, distance, playerY, W, H) {
  sampleEdges(distance, playerY, W, H);

  // Elevated side walls (drawn first; the tarmac surface then overlaps their
  // tops so only the outer face shows below each barrier).
  drawRoadWall(ctx, leftX, -1);
  drawRoadWall(ctx, rightX, +1);

  // Opaque tarmac surface between the barriers — occludes the city floor drawn
  // behind it, which is what makes the road read as a raised ribbon rather than
  // a hole cut in the grid.
  ctx.save();
  ctx.fillStyle = ROAD_SURFACE;
  ctx.beginPath();
  traceEdge(ctx, leftX);
  for (let i = sampleCount - 1; i >= 0; i--) ctx.lineTo(rightX[i], sampleY[i]);
  ctx.closePath();
  ctx.fill();
  ctx.restore();

  // Glowing neon barriers. These span the full canvas height, so a shadowBlur
  // glow would blur a screen-sized bounding box twice per frame (~1.8ms of a
  // ~5ms frame); neonStroke gets the same look from overdraw instead.
  neonStroke(ctx, (c) => traceEdge(c, leftX), GREEN, 2);
  neonStroke(ctx, (c) => traceEdge(c, rightX), GREEN, 2);

  // Dashed centre line, batched into ONE path so all the dashes share a single
  // set of strokes. Dashes are tied to WORLD position (not screen) so they
  // scroll naturally with the road instead of shimmering in place.
  neonStroke(ctx, (c) => traceCentreDashes(c, distance, playerY, W, H), GREEN_PALE, 3, 3);
}

// Issues the moveTo/lineTo pairs for every visible centre dash into the caller's
// current path.
function traceCentreDashes(ctx, distance, playerY, W, H) {
  const dash = 26;
  const span = dash + 26; // dash + gap
  const worldBottom = distance + playerY - H; // smallest visible worldY
  const worldTop = distance + playerY; // largest visible worldY
  const firstDash = Math.ceil(worldBottom / span) * span;
  const mid = W / 2;
  for (let wy = firstDash; wy <= worldTop; wy += span) {
    ctx.moveTo(mid + centerOffset(wy), playerY - (wy - distance));
    ctx.lineTo(mid + centerOffset(wy + dash), playerY - (wy + dash - distance));
  }
}

// Draws one elevated side wall from a sampled barrier edge. The wall's top edge
// is the barrier itself; its bottom edge is offset DOWN (elevation) and slightly
// OUTWARD (`sign`: -1 left / +1 right) to reveal the outer face. Filled dark with
// a dim-green bottom rim so the road reads as a raised ribbon above the city
// floor. `edgeX` is leftX or rightX, sampled by render().
function drawRoadWall(ctx, edgeX, sign) {
  const dx = sign * WALL_DX;

  // Wall face quad: down the barrier (top edge), then back up the offset edge.
  ctx.save();
  ctx.fillStyle = WALL_FILL;
  ctx.beginPath();
  traceEdge(ctx, edgeX);
  for (let i = sampleCount - 1; i >= 0; i--) {
    ctx.lineTo(edgeX[i] + dx, sampleY[i] + WALL_DY);
  }
  ctx.closePath();
  ctx.fill();
  ctx.restore();

  // Dim-green bottom rim (the base of the wall meeting the city floor). Also a
  // full-height path, so it gets the same overdraw treatment as the barriers.
  neonStroke(ctx, (c) => traceEdge(c, edgeX, dx, WALL_DY), GREEN_DIM, 1.5, 3);
}
