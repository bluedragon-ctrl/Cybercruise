// Shared, pure asset-drawing functions (no game state). Both the live game
// entities and the asset gallery (demo.html) call these, so a visual tweak here
// updates the game and the gallery at once. Everything is drawn centred at a
// given (cx, cy) so callers control placement.

import { glowPoly, glowLine } from "../engine/neon.js";
import { PLAYER, PLAYER_THRUST, GREEN } from "../engine/palette.js";

// A car sprite, pointing "up" (toward smaller y). Shared by the player and
// (later) enemy/neutral traffic, which differ mainly by colour. The thruster
// offsets/inset are tuned for the default 30x54 size.
export function drawCar(ctx, cx, cy, opts = {}) {
  const {
    color = PLAYER,
    thrust = PLAYER_THRUST,
    w = 30,
    h = 54,
    fill = "rgba(20,60,80,0.35)",
  } = opts;
  const hw = w / 2;
  const hh = h / 2;

  // Body outline (arrow-ish, tapered nose).
  const body = [
    [cx, cy - hh],            // nose
    [cx + hw, cy - hh + 14],
    [cx + hw, cy + hh],       // rear right
    [cx - hw, cy + hh],       // rear left
    [cx - hw, cy - hh + 14],
  ];
  glowPoly(ctx, body, color, 2, 14, fill);

  // Cockpit line + twin thruster glow at the rear.
  glowLine(ctx, cx - hw + 6, cy, cx + hw - 6, cy, color, 1.5, 8);
  glowLine(ctx, cx - 8, cy + hh, cx - 8, cy + hh + 8, thrust, 3, 12);
  glowLine(ctx, cx + 8, cy + hh, cx + 8, cy + hh + 8, thrust, 3, 12);
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
