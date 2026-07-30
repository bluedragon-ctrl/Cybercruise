// Shared, pure asset-drawing functions (no game state). Both the live game
// entities and the asset gallery (demo.html) call these, so a visual tweak here
// updates the game and the gallery at once. Everything is drawn centred at a
// given (cx, cy) so callers control placement.

import { glowPoly, glowLine } from "../engine/neon.js";
import { PLAYER, PLAYER_THRUST, GREEN } from "../engine/palette.js";

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
    fill = "rgba(15,45,60,0.30)",
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

// A simple neon "box" building — placeholder look to be fleshed out in Phase 2.
// Drawn as a wireframe footprint with a lit window grid, centred at (cx, cy).
export function drawBuilding(ctx, cx, cy, opts = {}) {
  const { w = 90, h = 110, color = GREEN } = opts;
  const x = cx - w / 2;
  const y = cy - h / 2;

  // Footprint.
  glowPoly(ctx, [[x, y], [x + w, y], [x + w, y + h], [x, y + h]], color, 2, 12,
    "rgba(20,80,45,0.18)");

  // Window grid: evenly spaced lit cells inset from the walls.
  const pad = 12;
  const cols = 3;
  const rows = 4;
  const cw = (w - pad * 2) / cols;
  const ch = (h - pad * 2) / rows;
  ctx.save();
  ctx.fillStyle = color;
  ctx.shadowColor = color;
  ctx.shadowBlur = 6;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      // Leave some windows dark for texture (deterministic checker-ish pattern).
      if ((r + c) % 3 === 0) continue;
      const wx = x + pad + c * cw + 2;
      const wy = y + pad + r * ch + 2;
      ctx.globalAlpha = 0.7;
      ctx.fillRect(wx, wy, cw - 4, ch - 4);
    }
  }
  ctx.restore();
}
