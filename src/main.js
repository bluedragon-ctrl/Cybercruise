// Cybercruise — bootstrap + Phase 0 game loop.
// A neon player car steering over a scrolling perspective grid.

import { createLoop } from "./engine/loop.js";
import { initInput } from "./engine/input.js";
import { clear, glowLine, glowText } from "./engine/neon.js";
import { Player } from "./game/player.js";

const canvas = document.getElementById("game");
const ctx = canvas.getContext("2d");
const W = canvas.width;
const H = canvas.height;

initInput();

// Player sits around mid-screen (Spy Hunter framing) so traffic catching up
// from behind is visible below before it draws level.
const player = new Player(W / 2, H * 0.62);
const bounds = { left: 0, right: W };

// Scrolling grid state: an offset that advances with player speed to fake motion.
let scroll = 0;
let distance = 0;

const GRID_SPACING = 48;

function update(dt) {
  player.update(dt, bounds);
  scroll = (scroll + player.speed * dt) % GRID_SPACING;
  distance += player.speed * dt;
}

function drawGrid() {
  const color = "rgba(30,120,160,0.55)";
  // Horizontal lines scrolling toward the viewer.
  for (let y = -GRID_SPACING; y < H + GRID_SPACING; y += GRID_SPACING) {
    const yy = y + scroll;
    glowLine(ctx, 0, yy, W, yy, color, 1, 6);
  }
  // Vertical lanes.
  for (let x = 0; x <= W; x += GRID_SPACING) {
    glowLine(ctx, x, 0, x, H, "rgba(30,120,160,0.35)", 1, 4);
  }
}

function drawHud() {
  glowText(ctx, "CYBERCRUISE", 12, 12, "#ff36c8", 18, "left", 12);
  glowText(ctx, `DIST ${Math.floor(distance)}`, W - 12, 12, "#39f6ff", 14, "right");
  glowText(ctx, `SPD ${Math.round(player.speed)}`, W - 12, 32, "#39f6ff", 14, "right");
}

function render(alpha) {
  clear(ctx);
  drawGrid();
  player.render(ctx, alpha);
  drawHud();
}

const loop = createLoop(update, render);
loop.start();
