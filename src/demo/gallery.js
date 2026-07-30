// Asset gallery — a static showcase page (demo.html) for eyeballing neon assets
// in isolation, without running the game. Each asset is drawn on its own small
// canvas over an optional roadside-style grid backdrop.
//
// To add an asset: draw it in src/game/sprites.js, then register a cell below.

import { clear, glowLine } from "../engine/neon.js";
import { drawCar, drawBuilding } from "../game/sprites.js";
import * as pal from "../engine/palette.js";

const gallery = document.getElementById("gallery");
const SIZE = 160; // per-cell canvas size in px

// Optional Tron-style grid backdrop, matching the in-game roadside floor.
function gridBackdrop(ctx, size) {
  ctx.save();
  ctx.strokeStyle = pal.GRID_LINE;
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let p = 0; p <= size; p += 32) {
    ctx.moveTo(0, p);
    ctx.lineTo(size, p);
    ctx.moveTo(p, 0);
    ctx.lineTo(p, size);
  }
  ctx.stroke();
  ctx.restore();
}

// Create one labelled cell. `draw(ctx, size)` renders the asset; the origin is
// the canvas top-left, so use size/2 for the centre.
function cell(label, draw, { grid = true } = {}) {
  const fig = document.createElement("figure");
  const canvas = document.createElement("canvas");
  canvas.width = SIZE;
  canvas.height = SIZE;
  const ctx = canvas.getContext("2d");

  clear(ctx, "#05060a");
  if (grid) gridBackdrop(ctx, SIZE);
  draw(ctx, SIZE);

  const caption = document.createElement("figcaption");
  caption.textContent = label;
  fig.append(canvas, caption);
  gallery.append(fig);
}

// A row of palette swatches so colour choices are visible at a glance.
function paletteCell() {
  const entries = [
    ["GREEN", pal.GREEN],
    ["GREEN_PALE", pal.GREEN_PALE],
    ["PLAYER", pal.PLAYER],
    ["ENEMY", pal.ENEMY],
    ["NEUTRAL", pal.NEUTRAL],
    ["HAZARD", pal.HAZARD],
  ];
  cell("PALETTE", (ctx, size) => {
    const sw = size / entries.length;
    entries.forEach(([, color], i) => {
      ctx.save();
      ctx.fillStyle = color;
      ctx.shadowColor = color;
      ctx.shadowBlur = 8;
      ctx.fillRect(i * sw + 3, size / 2 - 24, sw - 6, 48);
      ctx.restore();
    });
  }, { grid: false });
}

// --- Registered assets ---
cell("PLAYER CAR", (ctx, size) =>
  drawCar(ctx, size / 2, size / 2, { color: pal.PLAYER, thrust: pal.PLAYER_THRUST }));

cell("ENEMY CAR", (ctx, size) =>
  drawCar(ctx, size / 2, size / 2, { color: pal.ENEMY, thrust: pal.ENEMY }));

cell("NEUTRAL CAR", (ctx, size) =>
  drawCar(ctx, size / 2, size / 2, { color: pal.NEUTRAL, thrust: pal.NEUTRAL }));

cell("BUILDING (WIP)", (ctx, size) =>
  drawBuilding(ctx, size / 2, size / 2, { w: 90, h: 120, color: pal.GREEN }));

paletteCell();
