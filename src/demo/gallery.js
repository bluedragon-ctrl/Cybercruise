// Asset gallery — a static showcase page (demo.html) for eyeballing neon assets
// in isolation, without running the game. Each asset is drawn on its own small
// canvas over an optional roadside-style grid backdrop.
//
// To add an asset: draw it in src/game/sprites.js, then register a cell below.

import { clear, glowLine } from "../engine/neon.js";
import { drawCar, drawBuilding } from "../game/sprites.js";
import { drawShape, SHAPE_NAMES } from "../game/buildingshapes.js";
import { CAR_SHAPES } from "../game/carshapes.js";
import { drawWreck, WRECK_DURATION } from "../game/effects.js";
import { CAR_TYPES, ENEMY_FACTION } from "../game/cartypes.js";
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

// Cells that opt into animation are redrawn every frame with a rising `phase`
// (px "travelled"), so wheels and other motion play in the gallery.
const animatedCells = [];

// Create one labelled cell. `draw(ctx, size, phase)` renders the asset; the
// origin is the canvas top-left, so use size/2 for the centre. Pass
// `{ animate: true }` to have the cell redrawn each frame with a rising phase.
function cell(label, draw, { grid = true, animate = false } = {}) {
  const fig = document.createElement("figure");
  const canvas = document.createElement("canvas");
  canvas.width = SIZE;
  canvas.height = SIZE;
  const ctx = canvas.getContext("2d");

  const paint = (phase) => {
    clear(ctx, "#05060a");
    if (grid) gridBackdrop(ctx, SIZE);
    draw(ctx, SIZE, phase);
  };
  paint(0);
  if (animate) animatedCells.push(paint);

  const caption = document.createElement("figcaption");
  caption.textContent = label;
  fig.append(canvas, caption);
  gallery.append(fig);
}

// Single animation loop for every animated cell. Phase advances at a steady
// "cruising speed" so the wheel tread visibly rolls.
function startAnimation() {
  let phase = 0;
  let last = performance.now();
  function frame(now) {
    phase += ((now - last) / 1000) * 260; // px/sec, ~ default cruising speed
    last = now;
    for (const paint of animatedCells) paint(phase);
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

// A row of palette swatches so colour choices are visible at a glance.
function paletteCell() {
  const entries = [
    ["GREEN", pal.GREEN],
    ["GREEN_PALE", pal.GREEN_PALE],
    ["PLAYER", pal.PLAYER],
    ["ENEMY", pal.ENEMY],
    ["ENEMY_DEEP", pal.ENEMY_DEEP],
    ["NEUTRAL", pal.NEUTRAL],
    ["NEUTRAL_DEEP", pal.NEUTRAL_DEEP],
    ["NEUTRAL_PALE", pal.NEUTRAL_PALE],
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
cell("PLAYER CAR", (ctx, size, phase) =>
  drawCar(ctx, size / 2, size / 2, { color: pal.PLAYER, thrust: pal.PLAYER_THRUST, wheelPhase: phase }),
  { animate: true });

// Traffic, straight from the catalogue — a new car type in cartypes.js shows up
// here on its own, at exactly the size and colours the game will drive it with.
CAR_TYPES.forEach((t) => {
  cell(`${t.faction === ENEMY_FACTION ? "ENEMY" : "CIVIL"} · ${t.label}`, (ctx, size, phase) =>
    drawCar(ctx, size / 2, size / 2, {
      color: t.color, thrust: t.thrust, w: t.w, h: t.h, wheelPhase: phase,
    }),
    { animate: true });
});

// The silhouette catalogue, one cell each, all in the player's cyan so the cells
// compare SHAPES rather than faction colours. A car type picks one of these by
// index, exactly as a building picks a shape — so a new entry in carshapes.js
// appears here on its own, at its own default size.
CAR_SHAPES.forEach((s, i) => {
  cell(`CAR · ${s.name}`, (ctx, size, phase) =>
    drawCar(ctx, size / 2, size / 2, {
      shape: i, color: pal.PLAYER, thrust: pal.PLAYER_THRUST, wheelPhase: phase,
    }),
    { animate: true });
});

// Destruction. The cell loops: the car sits intact for a beat, then is wrecked,
// so the effect can be judged against the sprite it replaces. `phase` is px
// travelled at a known speed, so dividing by it gives us seconds. The seed
// changes each pass, since the point is that no two wrecks look the same.
const FX_PAUSE = 0.7; // seconds the intact car is shown before it blows up
const FX_CYCLE = FX_PAUSE + WRECK_DURATION;
cell("FX · WRECK", (ctx, size, phase) => {
  const seconds = phase / 260; // 260 px/sec, matching startAnimation
  const time = seconds % FX_CYCLE;
  const opts = {
    shape: 6, // BRUISER — big enough to read the fragments
    color: pal.ENEMY,
    thrust: pal.ENEMY_THRUST,
    w: 40,
    h: 74,
    seed: Math.floor(seconds / FX_CYCLE) + 1,
  };
  if (time < FX_PAUSE) {
    drawCar(ctx, size / 2, size / 2, { ...opts, wheelPhase: phase });
  } else {
    drawWreck(ctx, size / 2, size / 2, (time - FX_PAUSE) / WRECK_DURATION, opts);
  }
}, { animate: true });

// Cube buildings. Base is placed low in the cell so the extruded roof has room
// above it. Varied width/depth/height show the skyline range.
cell("BLDG · SHORT", (ctx, size) =>
  drawBuilding(ctx, size / 2, size * 0.68, { w: 64, d: 48, height: 34, color: pal.GREEN, seed: 3 }));

cell("BLDG · TALL", (ctx, size) =>
  drawBuilding(ctx, size / 2, size * 0.74, { w: 56, d: 44, height: 78, color: pal.GREEN, lit: 0.6, seed: 7 }));

cell("BLDG · WIDE", (ctx, size) =>
  drawBuilding(ctx, size / 2, size * 0.70, { w: 96, d: 40, height: 50, color: pal.GREEN, lit: 0.4, seed: 5 }));

// The alternative silhouettes, one cell each — every third slot of the city's
// variant catalogue draws one of these instead of a box.
SHAPE_NAMES.forEach((name, i) => {
  cell(`BLDG · ${name}`, (ctx, size) =>
    drawShape(ctx, size / 2, size * 0.76, i, {
      w: 58, d: 42, height: 62, color: pal.GREEN, lit: 0.55, seed: i + 2, skew: 0.26,
    }));
});

paletteCell();
startAnimation();
