// Asset gallery — a static showcase page (demo.html) for eyeballing neon assets
// in isolation, without running the game. Each asset is drawn on its own small
// canvas over an optional roadside-style grid backdrop.
//
// To add an asset: draw it in src/game/sprites.js, then register a cell below.

import { clear, glowLine } from "../engine/neon.js";
import { drawCar, drawBuilding, drawObstacle } from "../game/sprites.js";
import { drawShape, SHAPE_NAMES } from "../game/buildingshapes.js";
import { CAR_SHAPES } from "../game/carshapes.js";
import { OBSTACLE_SHAPES, obstacleShapeIndex, BLOCK } from "../game/obstacleshapes.js";
import {
  drawWreck,
  WRECK_DURATION,
  drawMineBlast,
  MINE_BLAST_DURATION,
  drawObstacleWreck,
  OBSTACLE_WRECK_DURATION,
  drawFireballBurst,
  FIREBALL_DURATION,
} from "../game/effects.js";
import { drawDart } from "../game/projectiles.js";
import { CAR_TYPES, ENEMY_FACTION } from "../game/cartypes.js";
import { WEAPON_TYPES } from "../game/weapons.js";
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
//
// The caption carries BOTH AXES a type names — its tactic and its driving
// profile — because the gallery is where you go to ask "which one is that?" and
// half the answer is now how it drives. Two cars can share a silhouette family
// and a colour and still be opposites (roadster vs hypercar), and reading
// `overtake/hustler` beside `overtake/showpiece` is the shortest way to see it.
// Derived, never hand-written, so a retune in cartypes.js can't leave a stale
// caption behind.
CAR_TYPES.forEach((t) => {
  const drives = `${t.behaviour}/${t.driving ?? "commuter"}`;
  cell(`${t.faction === ENEMY_FACTION ? "ENEMY" : "CIVIL"} · ${t.label} · ${drives}`, (ctx, size, phase) =>
    drawCar(ctx, size / 2, size / 2, {
      shape: t.shape, color: t.color, thrust: t.thrust, w: t.w, h: t.h, wheelPhase: phase,
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

// Road obstacles, straight from their catalogue — the three amber roadblocks
// and the mine. `phase` is px travelled, so dividing by the cruising speed gives
// seconds and the mine can blink at a fixed rate regardless of frame time.
OBSTACLE_SHAPES.forEach((s, i) => {
  cell(`OBS · ${s.name}`, (ctx, size, phase) =>
    drawObstacle(ctx, size / 2, size / 2, {
      shape: i,
      pulse: 0.5 + 0.5 * Math.sin((phase / 260) * 7),
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

// The mine detonation, on the same armed-then-blown loop as the wreck cell above
// so the two effects can be compared back to back — telling them apart at a
// glance is the whole point of the EMP bloom being energy rather than debris.
const MINE_CYCLE = FX_PAUSE + MINE_BLAST_DURATION;
cell("FX · MINE BLAST", (ctx, size, phase) => {
  const seconds = phase / 260;
  const time = seconds % MINE_CYCLE;
  if (time < FX_PAUSE) {
    drawObstacle(ctx, size / 2, size / 2, {
      shape: obstacleShapeIndex("CALTROP"),
      pulse: 0.5 + 0.5 * Math.sin(seconds * 7),
    });
  } else {
    drawMineBlast(ctx, size / 2, size / 2, (time - FX_PAUSE) / MINE_BLAST_DURATION, {
      seed: Math.floor(seconds / MINE_CYCLE) + 1,
    });
  }
}, { animate: true });

// The rocket itself (weapons.js's ROCKET) — a static dart, flickering, at
// several times its true in-game size (16x6 world units) so the shape reads at
// a glance. The gallery otherwise draws things at exactly the size the game
// uses them (see the CAR_TYPES cells above); this is the one exception,
// because at true size a dart this small would be a handful of pixels.
const ROCKET_TYPE = WEAPON_TYPES.find((t) => t.id === "rocket");
const ROCKET_GALLERY_SCALE = 3;
cell("WPN · ROCKET", (ctx, size, phase) => {
  const flicker = 0.75 + 0.25 * Math.sin(phase * 0.035); // matches projectiles.js's own flicker
  drawDart(ctx, size / 2, size / 2, 0, {
    color: ROCKET_TYPE.color,
    glow: ROCKET_TYPE.glow,
    length: ROCKET_TYPE.length * ROCKET_GALLERY_SCALE,
    width: ROCKET_TYPE.width * ROCKET_GALLERY_SCALE,
    flicker,
  });
}, { animate: true });

// The fireball it detonates into, on the same armed-then-blown loop as the
// wreck and mine-blast cells above — the point of the loop is to see the FX
// against the thing it replaces.
const FIREBALL_PAUSE = 0.5;
const FIREBALL_CYCLE = FIREBALL_PAUSE + FIREBALL_DURATION;
cell("FX · FIREBALL", (ctx, size, phase) => {
  const seconds = phase / 260;
  const time = seconds % FIREBALL_CYCLE;
  if (time < FIREBALL_PAUSE) {
    const flicker = 0.75 + 0.25 * Math.sin(phase * 0.035);
    drawDart(ctx, size / 2, size * 0.72, 0, {
      color: ROCKET_TYPE.color,
      glow: ROCKET_TYPE.glow,
      length: ROCKET_TYPE.length * ROCKET_GALLERY_SCALE,
      width: ROCKET_TYPE.width * ROCKET_GALLERY_SCALE,
      flicker,
    });
  } else {
    drawFireballBurst(ctx, size / 2, size / 2, (time - FIREBALL_PAUSE) / FIREBALL_DURATION, {
      seed: Math.floor(seconds / FIREBALL_CYCLE) + 1,
    });
  }
}, { animate: true });

// Roadblocks breaking, one cell per block, on the same intact-then-destroyed
// loop. Each block uses the debris style its catalogue entry names, so the light
// trestle and the two heavy blocks can be compared directly — that contrast is
// the whole point of having two styles.
OBSTACLE_SHAPES.forEach((s, i) => {
  if (s.family !== BLOCK) return;
  const cycle = FX_PAUSE + OBSTACLE_WRECK_DURATION[s.debris];
  cell(`FX · ${s.name} HIT`, (ctx, size, phase) => {
    const seconds = phase / 260;
    const time = seconds % cycle;
    if (time < FX_PAUSE) {
      drawObstacle(ctx, size / 2, size / 2, { shape: i });
    } else {
      drawObstacleWreck(ctx, size / 2, size / 2,
        (time - FX_PAUSE) / OBSTACLE_WRECK_DURATION[s.debris], {
          style: s.debris,
          w: s.size[0],
          h: s.size[1],
          seed: Math.floor(seconds / cycle) + 1,
        });
    }
  }, { animate: true });
});

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
