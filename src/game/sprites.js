// Shared, pure asset-drawing functions (no game state). Both the live game
// entities and the asset gallery (demo.html) call these, so a visual tweak here
// updates the game and the gallery at once. Everything is drawn centred at a
// given (cx, cy) so callers control placement.

import { glowPoly, glowLine } from "../engine/neon.js";
import { getSprite, blitSprite } from "../engine/spritecache.js";
import { PLAYER, PLAYER_THRUST, GREEN, GREEN_DIM, BUILDING_FILL } from "../engine/palette.js";

// A detailed top-down supercar wireframe, pointing "up" (toward smaller y).
// Shared by the player and (later) enemy/neutral traffic, which differ mainly by
// colour. Inspired by a neon wireframe sports car: tapered nose, fender bulges,
// hexagonal canopy, four wheels poking out past the body, and a rear wing.
//
// Geometry is expressed in fractions of the half-width (hw) and half-length (hh)
// so the whole car scales with `w`/`h`. Wheels extend slightly beyond hw, so the
// visual footprint is a touch wider than `w` (the collision box stays `w`x`h`).
export function drawCar(ctx, cx, cy, opts = {}) {
  const {
    color = PLAYER,
    thrust = PLAYER_THRUST,
    w = 34,
    h = 60,
    fill = "#0b1118", // opaque dark body so the road/grid don't show through
    wheelPhase = 0, // scrolls the wheel tread to fake rotation (px travelled)
  } = opts;
  const hw = w / 2;
  const hh = h / 2;

  // Body silhouette as [x, y] fractions for the RIGHT half, nose -> tail. The
  // left half is this mirrored, so the car is symmetric. Widest at ~0.88*hw,
  // leaving room for the wheels at the sides.
  const BODY_PROFILE = [
    [0.00, -1.00], // nose centre
    [0.46, -0.90], // nose shoulder
    [0.74, -0.66], // front fender
    [0.86, -0.30],
    [0.88, 0.05],  // widest
    [0.82, 0.42],
    [0.86, 0.72],  // rear fender
    [0.66, 0.92],
    [0.30, 1.00],  // rear corner
    [0.00, 1.02],  // tail centre
  ];
  const body = fracLoop(BODY_PROFILE, cx, cy, hw, hh);
  glowPoly(ctx, body, color, 2, 13, fill);

  // Wheels: four rounded slabs at the corners, poking out past the body.
  const wheelX = hw * 0.98;
  const frontY = cy - hh * 0.58;
  const rearY = cy + hh * 0.62;
  drawWheel(ctx, cx - wheelX, frontY, color, wheelPhase);
  drawWheel(ctx, cx + wheelX, frontY, color, wheelPhase);
  drawWheel(ctx, cx - wheelX, rearY, color, wheelPhase);
  drawWheel(ctx, cx + wheelX, rearY, color, wheelPhase);

  // Hexagonal canopy (cockpit), slightly forward of centre.
  const CANOPY = [
    [0.00, -0.34], [0.40, -0.14], [0.40, 0.18],
    [0.00, 0.34], [-0.40, 0.18], [-0.40, -0.14],
  ];
  glowPoly(ctx, CANOPY.map(([fx, fy]) => [cx + fx * hw, cy + fy * hh]), color, 1.5, 9);

  // Hood panel lines: nose shoulders converging back toward the canopy.
  glowLine(ctx, cx - hw * 0.34, cy - hh * 0.80, cx - hw * 0.40, cy - hh * 0.14, color, 1, 5);
  glowLine(ctx, cx + hw * 0.34, cy - hh * 0.80, cx + hw * 0.40, cy - hh * 0.14, color, 1, 5);
  // Centre spine down the hood.
  glowLine(ctx, cx, cy - hh * 0.92, cx, cy - hh * 0.34, color, 1, 5);

  // Rear wing: a wide bar behind the tail on two short supports.
  const wingY = cy + hh * 0.98;
  const wingHalf = hw * 1.06;
  glowPoly(ctx, [
    [cx - wingHalf, wingY - 3], [cx + wingHalf, wingY - 3],
    [cx + wingHalf, wingY + 3], [cx - wingHalf, wingY + 3],
  ], color, 1.5, 8);
  glowLine(ctx, cx - hw * 0.45, cy + hh * 0.82, cx - hw * 0.45, wingY, color, 1, 5);
  glowLine(ctx, cx + hw * 0.45, cy + hh * 0.82, cx + hw * 0.45, wingY, color, 1, 5);

  // Twin exhaust glow between the wing supports (accent colour).
  glowLine(ctx, cx - hw * 0.20, cy + hh * 0.80, cx - hw * 0.20, cy + hh * 0.94, thrust, 3, 10);
  glowLine(ctx, cx + hw * 0.20, cy + hh * 0.80, cx + hw * 0.20, cy + hh * 0.94, thrust, 3, 10);
}

// Builds a closed symmetric polygon from a right-half profile of [x, y] fractions
// (nose -> tail): the right side as given, then the left side mirrored tail -> nose.
function fracLoop(profile, cx, cy, hw, hh) {
  const right = profile.map(([fx, fy]) => [cx + fx * hw, cy + fy * hh]);
  const left = [...profile].reverse().map(([fx, fy]) => [cx - fx * hw, cy + fy * hh]);
  return right.concat(left);
}

// A single wheel: a small slab centred at (x, y), with horizontal tread bands
// that scroll along its length to fake rotation. `phase` is the distance the car
// has "rolled" (px); increasing it moves the tread backward (down the wheel),
// which reads as the wheel spinning forward.
function drawWheel(ctx, x, y, color, phase = 0) {
  const ww = 4;  // half-width across the car
  const wl = 10; // half-length along the car
  const top = y - wl + 2;
  const bot = y + wl - 2;

  // Tyre outline.
  glowPoly(ctx, [
    [x - ww, top], [x + ww, top], [x + ww, bot], [x - ww, bot],
  ], color, 1.5, 7);

  // Scrolling tread bands, clipped to the tyre.
  const spacing = 4;
  const off = ((phase % spacing) + spacing) % spacing; // wrapped scroll offset
  ctx.save();
  ctx.beginPath();
  ctx.rect(x - ww, top, ww * 2, bot - top);
  ctx.clip();
  ctx.strokeStyle = color;
  ctx.globalAlpha = 0.5;
  ctx.lineWidth = 1.2;
  ctx.shadowColor = color;
  ctx.shadowBlur = 2;
  ctx.beginPath();
  for (let yy = top + off; yy <= bot; yy += spacing) {
    ctx.moveTo(x - ww, yy);
    ctx.lineTo(x + ww, yy);
  }
  ctx.stroke();
  ctx.restore();
}

// An extruded "cube" building — a wireframe box rising off the grid, giving the
// roadside a simple 2.5D skyline while the FOOTPRINT stays flat on the ground
// plane (so it scrolls in perfect sync with the road; only the roof is offset).
//
// (cx, cy) is the centre of the base footprint on the grid. The roof is the same
// rectangle shifted by the extrusion vector (ox, oy) = up + slight rightward
// skew, which reveals a side wall and reads as a slightly tilted top-down camera.
// Taller `height` = taller building; vary it per building for skyline depth.
export function drawBuilding(ctx, cx, cy, opts = {}) {
  const {
    w = 70,       // footprint width  (x, along the road's cross-axis)
    d = 55,       // footprint depth  (y, along the road)
    height = 60,  // extrusion height in px
    color = GREEN,
    lit = 0.5,    // fraction of front-wall windows that are lit
    seed = 1,     // deterministic window-lighting seed (stable per building)
    skew = 0.28,  // horizontal roof shift as a fraction of height (+right / -left)
  } = opts;
  const hw = w / 2;
  const hd = d / 2;

  // Extrusion vector (base -> roof). `skew` leans the roof left/right so roadside
  // buildings can lean AWAY from the road (a natural centre vanishing point).
  const ox = height * skew;
  const oy = -height;

  // Base footprint corners (F = front/south = larger y, B = back/north).
  const bFL = [cx - hw, cy + hd];
  const bFR = [cx + hw, cy + hd];
  const bBR = [cx + hw, cy - hd];
  const bBL = [cx - hw, cy - hd];
  const off = (p) => [p[0] + ox, p[1] + oy];
  const tFL = off(bFL);
  const tFR = off(bFR);
  const tBR = off(bBR);
  const tBL = off(bBL);

  // OPAQUE fills first, so the box hides the floor grid and any building behind
  // it. Every lateral wall is filled (the hidden ones are harmless) plus the
  // roof; then the glowing outlines are stroked on top. No glow on the fills.
  fillQuad(ctx, bFL, bFR, tFR, tFL); // front wall
  fillQuad(ctx, bFR, bBR, tBR, tFR); // right wall
  fillQuad(ctx, bBR, bBL, tBL, tBR); // back wall
  fillQuad(ctx, bBL, bFL, tFL, tBL); // left wall
  fillQuad(ctx, tFL, tFR, tBR, tBL); // roof

  // Footprint on the grid (dim — it sits on the ground).
  glowPoly(ctx, [bFL, bFR, bBR, bBL], GREEN_DIM, 1, 5);

  // Vertical edges.
  glowLine(ctx, bFL[0], bFL[1], tFL[0], tFL[1], color, 1.5, 8);
  glowLine(ctx, bFR[0], bFR[1], tFR[0], tFR[1], color, 1.5, 8);
  glowLine(ctx, bBR[0], bBR[1], tBR[0], tBR[1], color, 1.5, 8);
  glowLine(ctx, bBL[0], bBL[1], tBL[0], tBL[1], color, 1.5, 8);

  // Roof (brightest — it's the top and furthest from the ground).
  glowPoly(ctx, [tFL, tFR, tBR, tBL], color, 1.5, 10);

  // Lit windows on the front (south-facing) wall quad: A,B along the base edge,
  // C,D along the roof edge.
  drawWallWindows(ctx, bFL, bFR, tFR, tFL, color, lit, seed);
}

// Fills a 4-point quad with the opaque building body colour (no stroke, no glow).
// Used to make buildings solid so they occlude the floor grid and boxes behind.
function fillQuad(ctx, A, B, C, D) {
  ctx.save();
  ctx.fillStyle = BUILDING_FILL;
  ctx.beginPath();
  ctx.moveTo(A[0], A[1]);
  ctx.lineTo(B[0], B[1]);
  ctx.lineTo(C[0], C[1]);
  ctx.lineTo(D[0], D[1]);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

// Bilinear point inside a quad: u runs A->B (bottom) / D->C (top); v runs bottom
// (v=0) to top (v=1).
function quadPoint(A, B, C, D, u, v) {
  const bx = A[0] + (B[0] - A[0]) * u;
  const by = A[1] + (B[1] - A[1]) * u;
  const tx = D[0] + (C[0] - D[0]) * u;
  const ty = D[1] + (C[1] - D[1]) * u;
  return [bx + (tx - bx) * v, by + (ty - by) * v];
}

// Fills a grid of lit windows across a wall quad. `litFrac` of them glow; which
// ones is deterministic from `seed` so a given building always looks the same.
function drawWallWindows(ctx, A, B, C, D, color, litFrac, seed) {
  const cols = 3;
  const rows = 5;
  const pad = 0.16; // inset within each window cell (0..0.5)
  let s = (seed * 9301 + 49297) % 233280;
  const rnd = () => {
    s = (s * 9301 + 49297) % 233280;
    return s / 233280;
  };
  ctx.save();
  ctx.fillStyle = color;
  ctx.shadowColor = color;
  ctx.shadowBlur = 5;
  ctx.globalAlpha = 0.7;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (rnd() > litFrac) continue;
      const u0 = (c + pad) / cols;
      const u1 = (c + 1 - pad) / cols;
      const v0 = (r + pad) / rows;
      const v1 = (r + 1 - pad) / rows;
      const p00 = quadPoint(A, B, C, D, u0, v0);
      const p10 = quadPoint(A, B, C, D, u1, v0);
      const p11 = quadPoint(A, B, C, D, u1, v1);
      const p01 = quadPoint(A, B, C, D, u0, v1);
      ctx.beginPath();
      ctx.moveTo(p00[0], p00[1]);
      ctx.lineTo(p10[0], p10[1]);
      ctx.lineTo(p11[0], p11[1]);
      ctx.lineTo(p01[0], p01[1]);
      ctx.closePath();
      ctx.fill();
    }
  }
  ctx.restore();
}

// ---------------------------------------------------------------------------
// CACHED VARIANTS
//
// The drawers above are pure and re-render every glowing stroke on each call,
// which is far too slow to run per entity per frame (see spritecache.js). The
// game therefore goes through the wrappers below, which pre-render each distinct
// look once and blit it thereafter. The raw drawers stay exported because the
// asset gallery (demo.html) wants arbitrary one-off parameters, and because
// these wrappers are built on top of them — so a visual tweak above still flows
// through to the game and the gallery alike.
// ---------------------------------------------------------------------------

// Margin around a cached sprite so the glow (max shadowBlur used here is 13)
// isn't clipped by the offscreen canvas edge.
const GLOW_PAD = 18;

// drawWheel lays its tread bands every 4px and wraps, so the wheel's appearance
// repeats with a period of exactly 4px of travel. Sampling that period at 8
// positions keeps the roll smooth while capping the cache at 8 frames per car
// colour (a 4px-wide wheel can't show finer detail than this anyway).
const WHEEL_PERIOD = 4;
const WHEEL_FRAMES = 8;

// Cached drawCar. Identical output to drawCar, except the wheel tread snaps to
// one of WHEEL_FRAMES positions.
export function drawCarCached(ctx, cx, cy, opts = {}) {
  const {
    color = PLAYER,
    thrust = PLAYER_THRUST,
    w = 34,
    h = 60,
    fill = "#0b1118",
    wheelPhase = 0,
  } = opts;

  // Quantise the tread scroll (positive modulo — wheelPhase only grows, but a
  // reversing entity in a later phase could hand us a negative).
  const wrapped = ((wheelPhase % WHEEL_PERIOD) + WHEEL_PERIOD) % WHEEL_PERIOD;
  const frame = Math.floor((wrapped / WHEEL_PERIOD) * WHEEL_FRAMES) % WHEEL_FRAMES;

  // Half-extents of the drawn car. Width is set by the wheels (0.98*hw + the
  // wheel's own 4px half-width), which reach past the rear wing (1.06*hw);
  // height by the nose (-1.00*hh) and the wing bar (0.98*hh + 3).
  const halfW = w * 0.62 + GLOW_PAD;
  const halfH = h * 0.55 + GLOW_PAD;

  const key = `car|${color}|${thrust}|${fill}|${w}|${h}|${frame}`;
  const sprite = getSprite(key, halfW * 2, halfH * 2, halfW, halfH, (sctx, ox, oy) =>
    drawCar(sctx, ox, oy, {
      color,
      thrust,
      w,
      h,
      fill,
      wheelPhase: (frame / WHEEL_FRAMES) * WHEEL_PERIOD,
    }),
  );
  blitSprite(ctx, sprite, cx, cy);
}

// A fixed catalogue of building looks. Placement code picks a variant INDEX
// instead of rolling continuous dimensions, which is what caps the cache: at
// most BUILDING_VARIANTS * 2 sprites (one per lean direction) exist no matter
// how large the city grows. Rolling w/d/height/lit freely would key the cache on
// a product of continuous ranges — tens of thousands of entries — and defeat it.
export const BUILDING_VARIANTS = 24;

// Deterministic parameters for variant `v`. The multipliers are chosen so each
// field cycles through its full range at a different rate, giving a varied
// skyline from a small catalogue. Dimensions land on 8px steps.
function variantOpts(v, leanRight) {
  return {
    w: 42 + ((v * 3) % 7) * 8, // 42..90
    d: 34 + ((v * 5) % 4) * 8, // 34..58
    height: 24 + ((v * 7) % 10) * 8, // 24..96
    lit: 0.3 + ((v * 11) % 6) * 0.1, // 0.3..0.8
    seed: v + 1,
    skew: leanRight ? 0.26 : -0.26,
    color: GREEN,
  };
}

// Cached drawBuilding, anchored (like drawBuilding) at the BASE CENTRE so
// callers keep placing buildings by their footprint on the ground plane.
// `leanRight` picks which way the roof skews, so a building can lean away from
// screen centre without doubling the variant catalogue.
export function drawBuildingVariant(ctx, cx, cy, v, leanRight) {
  const o = variantOpts(v, leanRight);

  // Bounding box relative to the base centre: the roof is shifted up by `height`
  // and sideways by `height * skew`, so only one side gains horizontal extent.
  const roofShift = o.height * o.skew;
  const originX = o.w / 2 + Math.max(0, -roofShift) + GLOW_PAD;
  const originY = o.d / 2 + o.height + GLOW_PAD;
  const sw = o.w + Math.abs(roofShift) + GLOW_PAD * 2;
  const sh = o.d + o.height + GLOW_PAD * 2;

  const key = `bldg|${v}|${leanRight ? 1 : 0}`;
  const sprite = getSprite(key, sw, sh, originX, originY, (sctx, sx, sy) =>
    drawBuilding(sctx, sx, sy, o),
  );
  blitSprite(ctx, sprite, cx, cy);
}
