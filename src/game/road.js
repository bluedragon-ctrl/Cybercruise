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
//
// That purity is also why the road is DRAWN FROM A STRIP CACHE rather than
// re-stroked every frame — see "Strip cache" near the bottom of this file.

import { neonStroke } from "../engine/neon.js";
import {
  ROAD_EDGE, ROAD_EDGE_DIM, ROAD_CENTERLINE, ROAD_SURFACE, WALL_FILL,
} from "../engine/palette.js";
// NOT importing scenery.js/citygrid.js for the sector, even though both
// export exactly what's needed (currentSector/floorDist, sectorIndex):
// obstacleshapes.js already imports LANE_WIDTH from THIS file, and both of
// those modules import obstacleshapes.js on their way down to it (scenery.js
// via sprites.js, citygrid.js via sprites.js directly) — road.js pulling
// either one back in closes that into a real import cycle (a TDZ
// ReferenceError on LANE_WIDTH at module load, found by trying it). `sector`
// comes in as a plain parameter instead — main.js already computes it once
// for scenery.render(); see this file's own render() for the rest.
import {
  ROAD_AMPLITUDE,
  ROAD_STRAIGHTNESS,
  ROAD_TURN_RATE,
  ROAD_WAVE_A_FREQ,
  ROAD_WAVE_A_WEIGHT,
  ROAD_WAVE_B_FREQ,
  ROAD_WAVE_B_WEIGHT,
  ROAD_WAVE_B_PHASE,
} from "./tuning.js";

// Distance from the road centre-line to each barrier, in px. The full road is
// twice this wide. Deliberately kept well under the 600px canvas width so the
// road never fills the screen — turns leave wide roadside space on both sides
// for Phase 2 buildings/scenery.
export const ROAD_HALF_WIDTH = 143; // 130 * 1.1 — 10% wider than the original road

// World units per unit of the DIST readout. The simulation counts raw world
// units — roughly a pixel each — which reaches five figures inside a minute and
// reads as noise on the HUD, so the odometer is shown divided by this (main.js).
//
// It is exported because the readout is now a UNIT THE DESIGN SPEAKS IN, not
// just a formatting detail: the spawn gates in cartypes.js and obstacletypes.js
// (`minDistance`) are written in these same units, so "the enemy turns up at
// 100" means the number the player watches tick past. Everything else — world
// coordinates, spawn margins, the score's distance term — stays in raw units.
export const DIST_UNITS = 100;

// How far the road centre wanders left/right of the canvas centre, as a function
// of world distance. Two layered sines of different wavelengths give smooth,
// non-obviously-repeating turns. The summed amplitude (90 + 40 = 130) keeps the
// road on-canvas while always leaving roadside margin, on a 600px-wide canvas:
//   centre range ≈ 300 ± 130 = [170, 430]
//   road edges   ≈ [170-130, 430+130] = [40, 560]  → always ≥40px off each edge,
//   and up to ~170px of roadside when the road is centred.
//
// Every number that sets the road's shape lives in tuning.js; this section is
// only the maths that turns them into a curve. Read tuning.js first — it
// explains what each knob does. Here is what the code is doing:
//
// STEP 1, the wander. Two sines of different, non-harmonic wavelengths, summed
// and normalised to [-1, 1]. On its own this is the old road: smooth, never
// exactly repeating, and turning ALL THE TIME, which is what we are fixing.
//
// STEP 2, overdrive and soft-clip. Multiply the wander by ROAD_STRAIGHTNESS so
// it overshoots [-1, 1], then flatten the overshoot away. Wherever the driven
// wave is past the limit the result is a CONSTANT — a straight road holding a
// fixed offset — and the road only turns while the wave passes back through the
// middle. Turn the knob up and the straights grow; at 1 there is no overshoot
// and the road turns forever, as it used to.
//
// The clip has to be C1 (continuous first derivative) or every car on screen
// would snap its heading at the moment the road went straight. A hard clamp is
// not: its slope drops from "whatever it was" to zero in one step. So the
// clamped value is passed through a quarter-sine, whose own slope reaches zero
// exactly at ±1 — the two pieces meet with the same value AND the same slope, so
// the entry into a straight is invisible.
//
// headingAt() below differentiates this same expression analytically, which is
// why the pieces are spelled out as small named functions instead of inlined:
// the two must never drift apart, or every car would point along a road that
// isn't there. Keep tuning.js the single source of truth for the numbers.

const WAVE_A_FREQ = ROAD_WAVE_A_FREQ * ROAD_TURN_RATE;
const WAVE_B_FREQ = ROAD_WAVE_B_FREQ * ROAD_TURN_RATE;
const WEIGHT_SUM = ROAD_WAVE_A_WEIGHT + ROAD_WAVE_B_WEIGHT;

// The un-clipped wander, normalised to [-1, 1] (step 1).
function wander(worldY) {
  return (
    (ROAD_WAVE_A_WEIGHT * Math.sin(worldY * WAVE_A_FREQ) +
      ROAD_WAVE_B_WEIGHT * Math.sin(worldY * WAVE_B_FREQ + ROAD_WAVE_B_PHASE)) /
    WEIGHT_SUM
  );
}

// d(wander)/d(worldY) — the exact derivative of the function above.
function wanderSlope(worldY) {
  return (
    (ROAD_WAVE_A_WEIGHT * WAVE_A_FREQ * Math.cos(worldY * WAVE_A_FREQ) +
      ROAD_WAVE_B_WEIGHT * WAVE_B_FREQ * Math.cos(worldY * WAVE_B_FREQ + ROAD_WAVE_B_PHASE)) /
    WEIGHT_SUM
  );
}

// How far the road centre sits left/right of the canvas centre, in px, at a
// given world distance. Range ±ROAD_AMPLITUDE (60), which on a 600px canvas puts
// the centre in [240, 360] and the barriers (ROAD_HALF_WIDTH = 143) in [97, 503]
// — at least 97px of roadside on the tight side, and ~157px when centred.
export function centerOffset(worldY) {
  const driven = ROAD_STRAIGHTNESS * wander(worldY);
  const clipped = driven < -1 ? -1 : driven > 1 ? 1 : driven;
  return ROAD_AMPLITUDE * Math.sin((Math.PI / 2) * clipped);
}

// Which way the road POINTS at a given world distance, as a screen-space angle in
// radians (0 = straight up the canvas, positive = nosed to the right).
//
// This is the exact derivative of centerOffset, not a finite difference between
// two samples: the curve is analytic, so the slope is too, and an analytic answer
// costs the same two cosines that sampling would cost in sines while staying
// correct at any step size. It is the chain rule over centerOffset's two steps —
// the quarter-sine's slope times the driven wander's slope — and it is EXACTLY
// ZERO wherever the wave is clipped, which is what makes a straight straight.
//
// The sign works out because screen y runs OPPOSITE to worldY (see the coordinate
// model at the top of this file): moving one unit further up the road means one
// unit UP the screen and `slope` units to the right, so the heading is atan of
// the slope with no extra negation.
//
// Range, over the tuning defaults: |slope| ≤ 0.213, i.e. **±12°**, and ~62% of
// the road is dead flat, so the average lean is ~1°. That is deliberately small
// — it is what makes the road read as a highway rather than a forest track — but
// it is not zero, and it still varies across a single screen height, so every
// entity must ask for the angle at ITS OWN worldY. One angle for the whole frame
// would visibly shear the traffic.
export function headingAt(worldY) {
  const driven = ROAD_STRAIGHTNESS * wander(worldY);
  if (driven <= -1 || driven >= 1) return 0; // clipped: the road is straight here
  const slope =
    ROAD_AMPLITUDE *
    (Math.PI / 2) *
    Math.cos((Math.PI / 2) * driven) *
    ROAD_STRAIGHTNESS *
    wanderSlope(worldY);
  return Math.atan(slope);
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
let sampleY = null; // "screen" y of each sample row (constant for a given range)
let leftX = null; // left barrier x per row
let rightX = null; // right barrier x per row
let sampleFrom = NaN; // the range the buffers currently hold
let sampleTo = NaN;

// (Re)allocate the buffers if the y range changed. The range is a parameter
// rather than "the canvas" because the road is painted into fixed-height strip
// tiles that deliberately overrun their own canvas at both ends (see the strip
// cache below) — in practice the range never changes once the game is running,
// so this reallocates once and then never again.
function ensureSamples(yFrom, yTo) {
  if (yFrom === sampleFrom && yTo === sampleTo) return;
  sampleFrom = yFrom;
  sampleTo = yTo;
  // ceil, not floor: the last row must reach AT OR PAST yTo, or the stroke would
  // stop short of the bottom of whatever we are painting into.
  sampleCount = Math.ceil((yTo - yFrom) / SAMPLE_STEP) + 1;
  sampleY = new Float32Array(sampleCount);
  leftX = new Float32Array(sampleCount);
  rightX = new Float32Array(sampleCount);
  for (let i = 0; i < sampleCount; i++) sampleY[i] = yFrom + i * SAMPLE_STEP;
}

// Rewrite leftX/rightX for the current scroll position.
function sampleEdges(distance, playerY, W, yFrom, yTo) {
  ensureSamples(yFrom, yTo);
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
//
// THE ONE PLACE THE ROAD IS ACTUALLY DRAWN. Both callers below go through here:
// renderDirect() paints a whole screen, and the strip cache paints one tile. They
// differ only in the y range they cover, which is why they cannot drift apart —
// the pixel-identity of the cache against the direct render depends on that.
//
// `yFrom`/`yTo` bound the rows painted, in the destination canvas's own
// coordinates. Rows outside the destination are fine and expected: the tile
// builder deliberately paints a full stride past both ends and lets the canvas
// clip (see the strip cache).
function paintRoad(ctx, distance, playerY, W, yFrom, yTo) {
  sampleEdges(distance, playerY, W, yFrom, yTo);

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
  //
  // ROAD_EDGE, not GREEN (Phase 7f): the road recolours with the same sector
  // the city floor below it does — see palette.js's own "why the split falls
  // exactly here" comment on why the road gets its OWN sector-varying names
  // rather than sharing GREEN with the HUD, which must not shift.
  neonStroke(ctx, (c) => traceEdge(c, leftX), ROAD_EDGE, 2);
  neonStroke(ctx, (c) => traceEdge(c, rightX), ROAD_EDGE, 2);

  // Dashed centre line, batched into ONE path so all the dashes share a single
  // set of strokes. Dashes are tied to WORLD position (not screen) so they
  // scroll naturally with the road instead of shimmering in place.
  neonStroke(
    ctx,
    (c) => traceCentreDashes(c, distance, playerY, W, yFrom, yTo),
    ROAD_CENTERLINE,
    3,
    3,
  );
}

// Paint a whole screen of road directly, with no cache. This is the REFERENCE
// IMPLEMENTATION the strip cache is diffed against, and it is what render()
// used to be; keeping it exported means the cache can be proved pixel-identical
// rather than merely believed to be.
export function renderDirect(ctx, distance, playerY, W, H) {
  // Overscan by one sample step top and bottom so the glowing edges run
  // off-screen rather than stopping short with a visible round cap.
  paintRoad(ctx, distance, playerY, W, -SAMPLE_STEP, H + SAMPLE_STEP);
}

// The centre line's dash + gap period, in world units. Exported so a test can
// assert the strip cache's overdraw margin is wide enough to swallow it.
export const DASH_SPAN = 52;

// Issues the moveTo/lineTo pairs for every visible centre dash into the caller's
// current path.
function traceCentreDashes(ctx, distance, playerY, W, yFrom, yTo) {
  const dash = 26;
  const span = DASH_SPAN; // dash + gap
  const worldBottom = distance + playerY - yTo; // smallest visible worldY
  const worldTop = distance + playerY - yFrom; // largest visible worldY
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
// floor. `edgeX` is leftX or rightX, sampled by paintRoad().
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

  // Dim bottom rim (the base of the wall meeting the city floor) — ROAD_EDGE_DIM,
  // the same sector-varying pairing BUILDING_EDGE/BUILDING_EDGE_DIM uses, so the
  // wall's rim tracks the barrier it belongs to rather than staying green under
  // a recoloured edge. Also a full-height path, so it gets the same overdraw
  // treatment as the barriers.
  neonStroke(ctx, (c) => traceEdge(c, edgeX, dx, WALL_DY), ROAD_EDGE_DIM, 1.5, 3);
}

// --- Strip cache -------------------------------------------------------------
//
// WHY. Painting a screen of road was profiled at ~1270us/frame on a 600x800
// canvas. Splitting that by no-op'ing ctx.stroke / ctx.fill in turn:
//
//     strokes                1007us   81%
//     fills                   190us   15%
//     path building + state    29us    2%
//
// The opaque fills cover far MORE area than the strokes and still cost a quarter
// as much, because a fill is one unblended pass while two of neonStroke's three
// passes run at globalAlpha < 1. This was never a fill problem; it is line
// overdraw, and the only way to stop paying for it is to stop redrawing it.
//
// THE IDEA. The road is a pure function of worldY (see the header). So a fixed
// BLOCK of world is fixed content: render it once into its own canvas, then blit
// that canvas while it scrolls up the screen.
//
// MEASURED, direct (renderDirect) against cached (render), on a quiet page with
// distance advancing 4.33px/frame so tile construction is amortised honestly:
//
//     direct   ~2800-3500us      cached   ~36-44us      i.e. ~75x
//
// Read those as a RATIO, not as absolutes. Timing canvas work here is treacherous
// and two plausible-looking methods disagreed by 5x — measure sustained
// throughput by drawing the layer N times inside one rAF callback, with N large
// enough to overrun the frame budget. Anything smaller floors at vsync and
// reports a ratio of 1, and getImageData to "force a flush" demotes the canvas
// out of GPU acceleration and changes what is being compared.
//
// THE LAYOUT. Block `k` covers worldY in [k*S, (k+1)*S). Since worldY runs
// opposite to screen y, tile-local y = (k+1)*S - worldY, i.e. the top row of the
// tile is the far end of the block. Blitting the tile at
// destY = playerY - ((k+1)*S - distance) then reproduces the screen mapping
// exactly — see blockDestY/blockLocalY, whose sum is the screen formula itself.
//
// SEAMS, the one real correctness risk. Each tile paints its geometry a FULL
// STRIDE beyond both ends (world (k-1)*S to (k+2)*S) and lets the canvas clip.
// The neighbouring tile continues the identical stroke from the identical
// analytic curve, so the join is exact: seam rows diff at a mean of 0.0146/255
// against 0.0142 for every other row — indistinguishable.
//
// Do NOT hide a seam with overlapping blits instead: neonStroke's two
// alpha-blended halo passes would composite twice in the overlap and draw a
// bright band exactly where the seam was.
//
// EXACTNESS depends on destY landing on a whole pixel, which is why main.js
// rounds the camera once per frame and hands the rounded value to every layer.
// At fractional offsets the blit resamples and the diff jumps by orders of
// magnitude.
//
// REJECTED, already measured, do not re-derive: rendering the two halo passes at
// quarter resolution and upscaling (the standard GPU bloom trick) cost 620us
// against a 434us baseline on the same subset. In Canvas2D the intermediate
// full-screen composite costs more than the stroke coverage it saves.

// World units of road per tile. 128 keeps ~7 tiles on an 800px screen and a new
// tile every ~30 frames at cruising speed; the whole live set is ~10 canvases of
// 600x128, about 3MB.
export const TILE_STRIDE = 128;

// Which block a world position falls in.
export function blockOf(worldY) {
  return Math.floor(worldY / TILE_STRIDE);
}

// Where a world position sits inside block `k`'s tile, in tile-local pixels.
export function blockLocalY(k, worldY) {
  return (k + 1) * TILE_STRIDE - worldY;
}

// Where block `k`'s tile is blitted this frame. blockDestY + blockLocalY is
// identically playerY - (worldY - distance) — the screen mapping every other
// entity uses — which is what keeps the road locked to the cars on it.
export function blockDestY(k, distance, playerY) {
  return playerY - ((k + 1) * TILE_STRIDE - distance);
}

// Blocks kept beyond the visible range before being evicted. Small: the world
// only ever scrolls one way, so this is slack against the range moving under us
// rather than a working set.
const EVICT_MARGIN = 2;

const tiles = new Map(); // block index -> canvas
let tilesW = 0; // canvas width the live tiles were built for
let tilesSector = 0; // sector (Phase 7f) the live tiles were painted in

// Build (or fetch) block `k`'s tile.
//
// NOTE the DOM touch is INSIDE this function, never at module scope: the test
// suite imports this module under plain Node, where `document` does not exist.
// Same discipline as engine/spritecache.js.
function roadTile(k, W) {
  const hit = tiles.get(k);
  if (hit) return hit;

  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = TILE_STRIDE;

  // Painting with distance = (k+1)*S and playerY = 0 makes paintRoad's screen
  // formula collapse to exactly blockLocalY, so the tile IS the block. The y
  // range overruns the 0..S canvas by a full stride each way — that overrun is
  // the seam fix, and the canvas throws it away for us.
  paintRoad(canvas.getContext("2d"), (k + 1) * TILE_STRIDE, 0, W, -TILE_STRIDE, 2 * TILE_STRIDE);

  tiles.set(k, canvas);
  return canvas;
}

// Draw the road for the current scroll position, from cached strips.
//
// `distance` and `playerY` must be WHOLE PIXELS (main.js rounds the camera once
// per frame) or the blits resample and the road softens. `sector` (Phase 7f,
// default 0 so every existing caller — the test suite's renderDirect() path,
// anything not yet updated — keeps working) is a plain int main.js already
// has in hand (scenery.currentSector) — see this file's own header on why it
// arrives as a parameter instead of an import.
export function render(ctx, distance, playerY, W, H, sector = 0) {
  // A resize invalidates every tile: the road's screen x is measured from the
  // canvas centre, so nothing built for the old width is reusable.
  //
  // A SECTOR CROSSING invalidates every tile too, for the same reason
  // scenery.js's own floor tile is keyed on sector: ROAD_EDGE/ROAD_EDGE_DIM/
  // ROAD_CENTERLINE are live bindings baked into a strip's actual pixels at
  // build time, so a cache hit on a tile built under the OLD sector would
  // keep blitting the old colour forever. Unlike the floor's 2-entry bound,
  // this is a full CLEAR rather than a per-key eviction: a road strip is far
  // cheaper to rebuild (~10 tiles, each a fraction of a full paintRoad) than
  // the floor's single, much larger tile, and the whole visible set
  // rebuilding over the next few frames hides under the same rescan glitch
  // cover the floor's own rebuild does (see game/sectors.js).
  if (W !== tilesW || sector !== tilesSector) {
    tiles.clear();
    tilesW = W;
    tilesSector = sector;
  }

  const kMin = blockOf(distance + playerY - H); // block at the bottom of the screen
  const kMax = blockOf(distance + playerY); // block at the top
  for (let k = kMin; k <= kMax; k++) {
    ctx.drawImage(roadTile(k, W), 0, blockDestY(k, distance, playerY));
  }

  // Drop anything that has scrolled away. Deleting during iteration is defined
  // behaviour for a Map, and the set is ~10 entries, so this is free.
  for (const k of tiles.keys()) {
    if (k < kMin - EVICT_MARGIN || k > kMax + EVICT_MARGIN) tiles.delete(k);
  }
}

// How many strips are live — the same dev-time sanity hook spriteCacheSize() is,
// for asserting the cache is bounded rather than quietly growing forever.
export function roadTileCount() {
  return tiles.size;
}
