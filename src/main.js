// Cybercruise — bootstrap + game loop.
// Phase 4: a neon player car driving an infinite curving highway through a
// parallax city, sharing the road with other traffic — and shooting at it.

import { createLoop } from "./engine/loop.js";
import { initInput, isDown } from "./engine/input.js";
import { clear, glowText } from "./engine/neon.js";
import { GREEN, GREEN_BRIGHT, GREEN_PALE, HAZARD, PLAYER } from "./engine/palette.js";
import { Player } from "./game/player.js";
import { Projectiles } from "./game/projectiles.js";
import { Score } from "./game/score.js";
import { Traffic } from "./game/traffic.js";
import { Weapon } from "./game/weapons.js";
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

// The gun, and the bullets it puts in the air. The player holds a Weapon (its
// cooldown and ammo — weapons.js); the world holds the shots (projectiles.js).
// Kept apart because the enemy will carry the same Weapon class in the next
// step while firing into the same pool.
const weapon = new Weapon();
const shots = new Projectiles();

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

  // Shooting, BEFORE traffic: a bullet that kills a car this tick leaves that
  // car dead when traffic.update runs, so it detonates and scores in the same
  // frame it was hit rather than a frame later.
  weapon.update(dt);
  if (isDown("fire") && weapon.tryFire()) {
    // The muzzle is the car's nose, in road coordinates — the player's screen x
    // re-based on the centre-line, exactly as collisions.js does it.
    const centerX = road.centerXAt(distance, W);
    shots.spawn(distance + player.h / 2, player.x - centerX, player.speed, weapon.type);
  }
  // Traffic cars are the only targets for now. Enemy fire (next step) passes the
  // player's body here instead — see projectiles.js.
  shots.update(dt, traffic.cars, { distance, playerY: player.y, H });

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

  // The gun, above the hull bar: what is loaded and how much of it is left. The
  // default cannon reads "∞", so the number only starts meaning something once
  // Phase 5's finite weapons exist — but the readout is in place from the day
  // there is a weapon at all.
  glowText(ctx, `${weapon.type.label} ${weapon.ammoText}`, bx, by - 36, PLAYER, 13, "left", 8);

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
  // Bullets over the traffic they're flying at, under the player's own car.
  shots.render(ctx, distance, player.y, W, H);
  player.render(ctx, alpha);
  drawHud();
}

const loop = createLoop(update, render);
loop.start();
