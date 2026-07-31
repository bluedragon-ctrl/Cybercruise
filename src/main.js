// Cybercruise — bootstrap + game loop.
// Phase 3: a neon player car driving an infinite curving highway through a
// parallax city, sharing the road with other traffic.

import { createLoop } from "./engine/loop.js";
import { initInput } from "./engine/input.js";
import { clear, glowText } from "./engine/neon.js";
import { GREEN, GREEN_BRIGHT, GREEN_PALE, HAZARD } from "./engine/palette.js";
import { Player } from "./game/player.js";
import { Score } from "./game/score.js";
import { Traffic } from "./game/traffic.js";
import * as road from "./game/road.js";
import * as scenery from "./game/scenery.js";

const canvas = document.getElementById("game");
const ctx = canvas.getContext("2d");
const W = canvas.width;
const H = canvas.height;

initInput();

// Player sits around mid-screen (Spy Hunter framing) so traffic catching up
// from behind is visible below before it draws level.
const player = new Player(W / 2, H * 0.62);

// The scoreboard, and the wiring that feeds it: traffic reports every car that
// blows up, main.js reports the road covered (see update). Traffic itself knows
// nothing about points — see score.js.
const score = new Score();
const traffic = new Traffic((car) => score.destroyed(car.type));

// `distance` is how far we've driven, in world units. It grows with speed and
// drives everything that scrolls (road curve, lane dashes). See road.js for the
// screen<->world coordinate model.
let distance = 0;

function update(dt) {
  // Road edges at the player's own row (worldY === distance there), used to keep
  // the car on the tarmac and to trigger barrier-scrape damage.
  const edges = road.edgesAt(distance, W);
  player.update(dt, { left: edges.left, right: edges.right });

  // Score the road covered from the SAME step that moves the world, so the
  // odometer and the distance term of the score can never disagree.
  const travelled = player.speed * dt;
  distance += travelled;
  score.travel(travelled);
  score.update(dt);

  // Traffic runs on the UPDATED distance, so a car spawned this tick lands
  // relative to where the player actually is now. The object handed over becomes
  // the view of the world the car behaviours get (behaviours.js). Note the
  // player is NOT read-only here: traffic resolves ramming for every car and the
  // player together, which can shove and damage the player (collisions.js).
  traffic.update(dt, { player, distance, W, H });
}

function drawHud() {
  glowText(ctx, "CYBERCRUISE", 12, 12, GREEN, 18, "left", 12);

  // Score gets the biggest readout on screen — it's the thing being played for.
  // DIST/SPD drop below it as instrumentation.
  glowText(ctx, `${score.points}`, W - 12, 10, GREEN_BRIGHT, 22, "right", 14);

  // The last kill's award, fading out under the total, so the player can see
  // WHY the number jumped — red for a fine, green for a bounty. Presentation
  // only: the total above has already banked it.
  const alpha = score.awardAlpha;
  if (alpha > 0) {
    const award = score.lastAward;
    const text = `${award >= 0 ? "+" : ""}${award}`;
    ctx.save();
    ctx.globalAlpha = alpha;
    glowText(ctx, text, W - 12, 36, award >= 0 ? GREEN_BRIGHT : HAZARD, 16, "right", 10);
    ctx.restore();
  }

  glowText(ctx, `DIST ${Math.floor(distance)}`, W - 12, 58, GREEN_PALE, 13, "right");
  glowText(ctx, `SPD ${Math.round(player.speed)}`, W - 12, 76, GREEN_PALE, 13, "right");

  // Health bar (bottom-left): green draining to red as damage mounts.
  const bx = 12;
  const by = H - 24;
  const bw = 140;
  const bh = 10;
  const frac = player.health / player.maxHealth;
  const hue = 120 * frac; // 120=green -> 0=red
  glowText(ctx, "HULL", bx, by - 16, GREEN_PALE, 12, "left", 6);
  // Empty track.
  ctx.save();
  ctx.strokeStyle = "rgba(120,255,180,0.4)";
  ctx.lineWidth = 1;
  ctx.strokeRect(bx, by, bw, bh);
  ctx.restore();
  // Filled portion.
  if (frac > 0) {
    ctx.save();
    const c = `hsl(${hue}, 100%, 55%)`;
    ctx.fillStyle = c;
    ctx.shadowColor = c;
    ctx.shadowBlur = 10;
    ctx.fillRect(bx + 1, by + 1, (bw - 2) * frac, bh - 2);
    ctx.restore();
  }
}

function render(alpha) {
  clear(ctx);
  // Lower city floor first (parallax, behind everything), then the elevated road
  // ribbon paints an opaque surface over it, then the player on top.
  scenery.render(ctx, distance, player.y, W, H);
  road.render(ctx, distance, player.y, W, H);
  // Traffic before the player, so the player's car is never hidden under one.
  traffic.render(ctx, distance, player.y, W, H, alpha);
  player.render(ctx, alpha);
  drawHud();
}

const loop = createLoop(update, render);
loop.start();
