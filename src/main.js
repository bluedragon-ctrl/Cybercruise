// Cybercruise — bootstrap + game loop.
// Phase 4: a neon player car driving an infinite curving highway through a
// parallax city, sharing the road with other traffic — and shooting at it.

import { createLoop } from "./engine/loop.js";
import { initInput, isDown, consumePress } from "./engine/input.js";
import { clear, glowText } from "./engine/neon.js";
import { GREEN, GREEN_BRIGHT, GREEN_PALE, HAZARD } from "./engine/palette.js";
import { Player } from "./game/player.js";
import { Projectiles } from "./game/projectiles.js";
import { Score } from "./game/score.js";
import { Traffic } from "./game/traffic.js";
import { Obstacles } from "./game/obstacles.js";
import { Explosions } from "./game/effects.js";
import { Loadout } from "./game/weapons.js";
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

// One explosion pool shared by traffic (car wrecks) and the road obstacles
// (mine blasts, roadblock rubble) — see effects.js's Explosions header and
// game/obstacles.js for why they must not each get their own.
const explosions = new Explosions();
const traffic = new Traffic((car) => score.destroyed(car.type), explosions);
const obstacles = new Obstacles(explosions);

// Scratch target list for bullets: cars AND obstacles in one flat array, so a
// shot resolves against whichever it actually crosses first regardless of
// which system owns it (see projectiles.js's firstHit). Reused every tick
// rather than rebuilt, same as Traffic.bodies.
const shotTargets = [];

// The guns, and the bullets they put in the air. The player holds a Loadout
// (each weapon's cooldown and ammo — weapons.js); the world holds the shots
// (projectiles.js). Every armed enemy car holds an Armament of the same Weapon
// class (game/armament.js).
const loadout = new Loadout();
const shots = new Projectiles();

// HOSTILE FIRE GETS ITS OWN POOL, and the reason is targeting rather than
// bookkeeping. projectiles.js resolves one pool against one list of targets —
// "WHO CAN BE HIT is the CALLER'S choice" — so two pools is how a bullet knows
// whose side it is on, with no notion of a faction anywhere in that file.
//
// Enemy rounds are resolved against the PLAYER ALONE: they pass through traffic
// and through road hazards untouched. That is deliberate and it is score.js's
// doing — the scoreboard pays out however a car died, so a civilian shot by an
// enemy would fine the player for a kill they had no part in, exactly the
// oddity cartypes.js's NERVE section already had to design mines around. The
// same goes for a hostile round setting off a mine.
const enemyShots = new Projectiles();
// Reused every tick rather than rebuilt. Traffic's PlayerBody is already the
// player expressed as something with { worldY, offset, w, h, alive, damage } —
// the exact target interface projectiles.js documents — so it needs no adapter
// of its own.
const enemyTargets = [traffic.playerBody];

// --- The two things a hostile car may do to the world ------------------------
//
// Handed to traffic on the world view each tick, so behaviours.js and
// game/armament.js can put a bullet or a mine into the world without importing
// either system — the same shape of wiring as Traffic's `onDestroyed` callback,
// which is what keeps traffic.js from ever knowing what a point is.

// A round leaves `car`'s muzzle: its nose when firing up the road, its tail when
// firing back down it at a player who is behind.
function fireShot(car, type, dir) {
  enemyShots.spawn(car.worldY + dir * (car.h / 2), car.offset, car.speed, type, W, dir);
}

// A mine is laid immediately behind `car`. Returns whether the road had room —
// see obstacles.js's drop(), which owns the placement and the budget.
function dropMine(car, type) {
  return obstacles.drop(type, car);
}

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
  // TAB cycles the loadout. Edge-triggered (consumePress, not isDown) so holding
  // the key selects one weapon rather than riffling through them every frame.
  if (consumePress("swap")) loadout.next();

  loadout.update(dt);
  const weapon = loadout.current;
  if (isDown("fire") && weapon.tryFire()) {
    // The muzzle is the car's nose, in road coordinates — the player's screen x
    // re-based on the centre-line, exactly as collisions.js does it. What the
    // bullet does with that from here is the weapon's flight mode's business.
    const centerX = road.centerXAt(distance, W);
    shots.spawn(distance + player.h / 2, player.x - centerX, player.speed, weapon.type, W);
  }
  // Traffic cars and road obstacles are both fair game for the PLAYER'S gunfire
  // — one flat list, built fresh each tick into the reused scratch array, so a
  // shot stops at whichever it actually crosses first (see projectiles.js's
  // firstHit). Hostile fire is resolved separately, after traffic — see below.
  shotTargets.length = 0;
  for (const car of traffic.cars) shotTargets.push(car);
  for (const o of obstacles.list) shotTargets.push(o);
  shots.update(dt, shotTargets, { distance, playerY: player.y, W, H });

  // Obstacles run BEFORE traffic, on the same principle main.js already uses
  // for bullets: anything an obstacle kills this tick (a car caught in a mine
  // blast) must still be picked up by traffic.update()'s own detonate() sweep
  // in the SAME tick, not a tick late — see game/obstacles.js's header.
  const world = {
    player, distance, W, H,
    cars: traffic.cars,
    obstacles: obstacles.list,
    // The hostile weapons' way into the world — see above, and the contract at
    // the top of game/behaviours.js.
    fireShot,
    dropMine,
  };
  obstacles.update(dt, world);

  // retire() REPLACES obstacles.list with a filtered array, so re-point the
  // world at the live one before traffic reads it — a stale reference would
  // have the car behaviours steering around hazards that no longer exist.
  world.obstacles = obstacles.list;

  // Traffic runs on the UPDATED distance, so a car spawned this tick lands
  // relative to where the player actually is now. The object handed over becomes
  // the view of the world the car behaviours get (behaviours.js). Note the
  // player is NOT read-only here: traffic resolves ramming for every car and the
  // player together, which can shove and damage the player (collisions.js).
  traffic.update(dt, world);

  // Hostile fire resolves AFTER traffic, not before it like the player's. Two
  // reasons, and they point the same way: the rounds fired during traffic.update
  // this tick get to move and land in the tick they were fired, and the
  // PlayerBody they are tested against has just been synced to where the player
  // actually is now rather than to where it was at the top of the frame.
  enemyShots.update(dt, enemyTargets, { distance, playerY: player.y, W, H });
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

  // Shown in DIST_UNITS, not raw world units — see road.js. The same scale the
  // catalogues' `minDistance` gates are written in, so a player who sees DIST 100
  // is seeing exactly the moment the enemy is allowed on the road.
  glowText(ctx, `DIST ${Math.floor(distance / road.DIST_UNITS)}`, W - 12, 58, GREEN_PALE, 13, "right");
  glowText(ctx, `SPD ${Math.round(player.speed)}`, W - 12, 76, GREEN_PALE, 13, "right");

  // Health bar (bottom-left): green draining to red as damage mounts.
  const bx = 12;
  const by = H - 24;
  const bw = 140;
  const bh = 10;
  const frac = player.health / player.maxHealth;
  const hue = 120 * frac; // 120=green -> 0=red

  // The gun, above the hull bar: what is loaded and how much of it is left,
  // drawn in the WEAPON'S OWN bullet colour so the readout and the tracer in the
  // air match. An empty weapon turns red — it is still selected, still shown,
  // and simply won't fire (see Loadout).
  const weapon = loadout.current;
  glowText(
    ctx,
    `${weapon.type.label} ${weapon.ammoText}`,
    bx,
    by - 36,
    weapon.empty ? HAZARD : weapon.type.color,
    13,
    "left",
    8,
  );

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

  // THE CAMERA IS QUANTISED TO WHOLE PIXELS, once, here, and the rounded value
  // is what every layer below is drawn against.
  //
  // Two of those layers are now blitted from pre-rendered canvases (the road's
  // strip cache in road.js, the floor grid's tile in scenery.js), and a blit is
  // only pixel-exact on an integer offset — at a fractional one the browser
  // resamples and the neon softens. Rounding ONCE rather than per-layer is what
  // matters: every entity derives its screen row from `playerY - (worldY - d)`,
  // so a single shared `d` keeps the cars welded to the road they are driving on,
  // where per-layer rounding would let them shear apart by up to a pixel.
  //
  // The cost is that the world advances in whole-pixel steps. At the 4-10px/frame
  // the speed band produces, that is invisible.
  //
  // NOT the simulation's `distance` — only the value rendering reads. The
  // odometer and the distance term of the score run off the real float (see
  // update), and rounding that would slowly bleed travelled road away.
  const camY = Math.round(distance);

  // Lower city floor first (parallax, behind everything), then the elevated road
  // ribbon paints an opaque surface over it, then the player on top. The floor
  // runs on its own half-speed clock and rounds it itself — see scenery.render.
  scenery.render(ctx, camY, player.y, W, H);
  road.render(ctx, camY, player.y, W, H);
  // Obstacles before traffic, so a car passing over one is never hidden
  // underneath it; traffic before the player, so the player's car is never
  // hidden under one. Traffic draws the shared explosion pool last (car
  // wrecks, mine blasts and roadblock rubble alike), so a blast is never drawn
  // under something still driving through it — see traffic.js's render.
  obstacles.render(ctx, camY, player.y, W, H);
  traffic.render(ctx, camY, player.y, W, H, alpha);
  // Bullets over the traffic they're flying at, under the player's own car.
  // Hostile rounds draw with them and in the enemy's own red (weapons.js), so
  // which way a tracer is going is never a question the player has to work out.
  shots.render(ctx, camY, player.y, W, H);
  enemyShots.render(ctx, camY, player.y, W, H);
  // The player sits at worldY === distance, so that is where its heading comes
  // from — it leans into a bend along with the traffic around it. Read at camY,
  // like everything else drawn this frame, so the car's lean matches the bend of
  // the road actually on screen.
  player.render(ctx, alpha, road.headingAt(camY));
  drawHud();
}

const loop = createLoop(update, render);
loop.start();
