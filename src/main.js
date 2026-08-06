// Cybercruise — bootstrap + game loop.
// Phase 4: a neon player car driving an infinite curving highway through a
// parallax city, sharing the road with other traffic — and shooting at it.

import { createLoop } from "./engine/loop.js";
import { initInput, isDown, consumePress } from "./engine/input.js";
import { clear, glowText } from "./engine/neon.js";
import { GREEN, GREEN_BRIGHT, GREEN_PALE, HAZARD, PLAYER, SHIELD_FLICKER } from "./engine/palette.js";
import { Player } from "./game/player.js";
import { Projectiles } from "./game/projectiles.js";
import { Score } from "./game/score.js";
import { Traffic } from "./game/traffic.js";
import { Obstacles } from "./game/obstacles.js";
import { obstacleTypeById } from "./game/obstacletypes.js";
import { Pickups } from "./game/pickups.js";
import { pickupTypeById } from "./game/pickuptypes.js";
import { ENEMY_FACTION } from "./game/cartypes.js";
import { Explosions } from "./game/effects.js";
import { Disconnect } from "./game/disconnect.js";
import { Loadout } from "./game/weapons.js";
import { createMenu } from "./game/menu.js";
import { createMusic } from "./audio/synth.js";
import * as road from "./game/road.js";
import * as scenery from "./game/scenery.js";

const canvas = document.getElementById("game");
const ctx = canvas.getContext("2d");
const W = canvas.width;
const H = canvas.height;
const hint = document.getElementById("hint");

const MENU_HINT = "&uarr;/&darr; select &middot; SPACE/ENTER confirm";
const PAUSE_HINT = "&uarr;/&darr; select &middot; SPACE/ENTER confirm &middot; ESC resume";
const PLAY_HINT = "&larr;/&rarr; or A/D steer &middot; &uarr;/&darr; speed &middot; SPACE fire &middot; TAB weapon &middot; ESC pause";

initInput();

// Top-level game state: the menu owns the screen until START GAME/CONTINUE is
// picked, then main's own update/render (unchanged below) take over. "menu"
// only ever happens once, before the very first game; ESC toggles "playing"
// to "paused" and back for the rest of the session — same menu.js screen
// both times, see its header for how it tells the two apart.
//
// "dying" is the run of the game/disconnect.js death sequence (see the check
// at the bottom of the "playing" branch below): the world is frozen — nothing
// under "playing" runs — but still drawn, under the glitching car, for the
// beat the sequence takes. "gameover" is menu.js's screen a third time, once
// that beat is over; confirming its RESTART row calls newGame() and drops
// straight back into "playing", the same way CONTINUE drops out of "paused".
const menu = createMenu();
let state = "menu"; // "menu" | "playing" | "paused" | "dying" | "gameover"

// Phase 8's first slice: procedural synthwave music (src/audio/synth.js).
// `music.start()` is only ever called below, from inside the "fire" press
// that confirms START GAME — see synth.js's header for why it must follow a
// real user gesture. `musicFlag` mirrors menu.js's MUSIC toggle so
// setEnabled() only fires on an actual change rather than every frame the
// menu is open (that would retrigger its volume ramp 60x/sec — see setEnabled).
const music = createMusic();
let musicFlag = menu.musicOn();

// The death sequence (game/disconnect.js). One instance, reused across
// restarts via reset() — see newGame() below — the same way `menu` itself is
// one instance reused for start/pause/gameover.
const disconnect = new Disconnect();

// Everything below is PER-RUN state: it all gets torn down and rebuilt by
// newGame(), so it's declared with `let` rather than `const` even though
// nothing outside newGame() ever reassigns it directly. The functions that
// close over these bindings (onCarDestroyed, fireShot, dropMine) are defined
// ONCE, below, and keep working across a restart because a closure reads the
// current value of an outer `let` at call time, not the value it had when the
// closure was created.
let player;
let score;
let explosions;
let obstacles;
let pickups;
let traffic;
let shots;
let enemyShots;
let loadout;
// How far we've driven, in world units. Grows with speed and drives
// everything that scrolls (road curve, lane dashes) — see road.js for the
// screen<->world coordinate model. Declared up here, ahead of newGame(),
// because newGame() zeroes it and runs once at module load below.
let distance = 0;

// Chance a destroyed HOSTILE car leaves a FIX crate where it died. CIVILIANS
// NEVER DO — a buff dropped by killing an innocent bystander would reward
// the exact kill score.js already fines the player for (see cartypes.js's
// NERVE section and score.js's own civilian penalty). This is a straight
// coin-weighted roll, not gated by anything else on the road.
const ENEMY_FIX_DROP_CHANCE = 0.2;
function onCarDestroyed(car) {
  score.destroyed(car.type);
  if (car.type.faction === ENEMY_FACTION && Math.random() < ENEMY_FIX_DROP_CHANCE) {
    pickups.drop(pickupTypeById("fix"), car.worldY, car.offset);
  }
}

// Scratch target list for bullets: cars AND obstacles in one flat array, so a
// shot resolves against whichever it actually crosses first regardless of
// which system owns it (see projectiles.js's firstHit). Reused every tick
// rather than rebuilt, same as Traffic.bodies — and reused across restarts
// too, since it's rebuilt from scratch inside update() every "playing" tick
// regardless of which `traffic`/`obstacles` instance is current.
const shotTargets = [];

// Reused every tick rather than rebuilt, same as shotTargets — but its ONE
// entry (Traffic's PlayerBody, already the player expressed as something with
// { worldY, offset, w, h, alive, damage }, the exact target interface
// projectiles.js documents) has to be re-pointed at the new Traffic's
// PlayerBody whenever newGame() builds one, since nothing else touches this
// array on a "playing" tick to do that for it.
const enemyTargets = [];

// (Re)builds every per-run system fresh: called once below for the initial
// game, and again from the "gameover" screen's RESTART row. Everything it
// touches is declared `let` above for exactly this reason.
function newGame() {
  distance = 0;
  // Player sits around mid-screen (Spy Hunter framing) so traffic catching up
  // from behind is visible below before it draws level.
  player = new Player(W / 2, H * 0.62);
  // The scoreboard, and the wiring that feeds it: traffic reports every car
  // that blows up, main.js reports the road covered (see update). Traffic
  // itself knows nothing about points — see score.js.
  score = new Score();
  // One explosion pool shared by traffic (car wrecks) and the road obstacles
  // (mine blasts, roadblock rubble) — see effects.js's Explosions header and
  // game/obstacles.js for why they must not each get their own.
  explosions = new Explosions();
  obstacles = new Obstacles(explosions);
  // Buff crates — shares the same explosion pool for their own "collected"
  // burst (effects.js's drawCollectBurst), same reasoning as obstacles above.
  // Constructed BEFORE traffic so onCarDestroyed can close over it.
  pickups = new Pickups(explosions);
  traffic = new Traffic(onCarDestroyed, explosions);
  enemyTargets[0] = traffic.playerBody;
  // The guns, and the bullets they put in the air. The player holds a Loadout
  // (each weapon's cooldown and ammo — weapons.js); the world holds the shots
  // (projectiles.js). Every armed enemy car holds an Armament of the same
  // Weapon class (game/armament.js).
  loadout = new Loadout();
  // Shares the explosion pool above, so a rocket's fireball (weapons.js's
  // ROCKET, effects.js's drawFireballBurst) competes for the same slot budget
  // as every other detonation on the road — see projectiles.js's `impact`.
  shots = new Projectiles(explosions);
  // HOSTILE FIRE GETS ITS OWN POOL, and the reason is targeting rather than
  // bookkeeping. projectiles.js resolves one pool against one list of
  // targets — "WHO CAN BE HIT is the CALLER'S choice" — so two pools is how a
  // bullet knows whose side it is on, with no notion of a faction anywhere in
  // that file.
  //
  // Enemy rounds are resolved against the PLAYER ALONE: they pass through
  // traffic and through road hazards untouched. That is deliberate and it is
  // score.js's doing — the scoreboard pays out however a car died, so a
  // civilian shot by an enemy would fine the player for a kill they had no
  // part in, exactly the oddity cartypes.js's NERVE section already had to
  // design mines around. The same goes for a hostile round setting off a
  // mine.
  enemyShots = new Projectiles(explosions);
  disconnect.reset();
}
newGame();

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

function update(dt) {
  if (state === "menu") {
    if (menu.update()) {
      state = "playing";
      hint.innerHTML = PLAY_HINT;
      // The keypress that just confirmed START GAME is the user gesture
      // AudioContext creation needs — see synth.js's header.
      music.start();
    }
    // Only pushed to the engine on an actual change (see musicFlag above) —
    // the MUSIC row can only have moved on the update() call just above.
    if (menu.musicOn() !== musicFlag) {
      musicFlag = menu.musicOn();
      music.setEnabled(musicFlag);
    }
    return;
  }

  if (state === "paused") {
    // ESC again resumes directly, without going through CONTINUE — the same
    // key that opened the pause screen closes it. A fresh consumePress each
    // time, so this never fires on the very keypress that just opened pause.
    if (consumePress("pause")) {
      state = "playing";
      hint.innerHTML = PLAY_HINT;
      return;
    }
    if (menu.update()) {
      state = "playing";
      hint.innerHTML = PLAY_HINT;
    }
    if (menu.musicOn() !== musicFlag) {
      musicFlag = menu.musicOn();
      music.setEnabled(musicFlag);
    }
    return;
  }

  if (state === "dying") {
    // The world is frozen — nothing below this branch runs, so the road,
    // traffic and the player's own last position all just sit exactly where
    // they were the instant the hull hit zero (render() still draws them
    // every frame; it's only update() that has stopped moving them). Only the
    // death sequence itself advances.
    disconnect.update(dt);
    if (disconnect.done) {
      state = "gameover";
      menu.open("gameover");
      hint.innerHTML = MENU_HINT;
    }
    return;
  }

  if (state === "gameover") {
    // Same screen, same interaction as "paused" above — RESTART is row 0's
    // label here (menu.js's ROW0_LABEL) the way CONTINUE is there — except
    // confirming it starts a fresh run instead of resuming a frozen one.
    if (menu.update()) {
      newGame();
      state = "playing";
      hint.innerHTML = PLAY_HINT;
    }
    if (menu.musicOn() !== musicFlag) {
      musicFlag = menu.musicOn();
      music.setEnabled(musicFlag);
    }
    return;
  }

  // state === "playing" from here down — the whole rest of this function is
  // the real game tick, untouched by any of the above.
  if (consumePress("pause")) {
    state = "paused";
    menu.open("pause");
    hint.innerHTML = PAUSE_HINT;
    return; // frozen the instant ESC is pressed — no world update this tick
  }

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
  if (isDown("fire") && weapon.ready) {
    // The muzzle is the car's nose, in road coordinates — the player's screen x
    // re-based on the centre-line, exactly as collisions.js does it.
    const centerX = road.centerXAt(distance, W);
    if (weapon.type.payload) {
      // A mine layer, not a gun (weapons.js's "mine" entry) — dropped behind
      // the player instead of fired ahead. Mirrors armament.js's own layMine:
      // the drop is attempted BEFORE the round is spent, so a mine the road
      // had no room for (obstacles.js's MAX_LAID) costs the player nothing.
      // The player, expressed as a body in road coordinates, is exactly what
      // obstacles.js's drop() wants — worldY/offset/h, the same shape a car
      // satisfies without an adapter.
      const body = { worldY: distance, offset: player.x - centerX, h: player.h };
      if (obstacles.drop(obstacleTypeById(weapon.type.payload), body)) weapon.tryFire();
    } else if (weapon.tryFire()) {
      // What the bullet does with the muzzle position from here is the
      // weapon's flight mode's business.
      shots.spawn(distance + player.h / 2, player.x - centerX, player.speed, weapon.type, W);
    }
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

  // Buff crates. Independent of everything above — a pickup never fights,
  // shoves or blocks anything — so it needs none of the tick-order care
  // bullets and obstacles do; it only has to see where the player ended up
  // this tick, which is already final by this point.
  pickups.update(dt, { player, distance, W, H, loadout });

  // The hull check runs LAST, after every damage source above (wall-scrape in
  // player.update, ramming and blast in traffic.update, mines and bullets)
  // has had its shot at the player this tick — so wherever health actually
  // hit zero, this is the one place that notices. `state` flips to "dying"
  // and nothing under "playing" runs again until newGame() resets it.
  if (player.health <= 0) {
    state = "dying";
    disconnect.trigger(player.x, player.y, player.w, player.h);
    if (menu.soundOn()) music.playDisconnect();
    hint.innerHTML = "";
  }
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

  // SHIELD, only while active — same "about to lose it" flicker the rings
  // around the car give in their last second (player.js's renderShield),
  // read off the same clock so the HUD and the car agree on when that is.
  if (player.shieldTime > 0) {
    const expiring = player.shieldTime < 1 && Math.sin(player.shieldSpin * 26) > 0;
    glowText(
      ctx, `SHIELD ${player.shieldTime.toFixed(1)}s`, bx + bw, by - 16,
      expiring ? SHIELD_FLICKER : PLAYER, 12, "right", 8,
    );
  }

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

  // "gameover" reuses the exact same full-screen menu as "menu"/"paused" (see
  // menu.js's header) — the frozen wreck behind it from "dying" is gone the
  // instant the screen takes over, the same way "paused" already covers the
  // world rather than showing it through the menu.
  if (state === "menu" || state === "paused" || state === "gameover") {
    menu.render(ctx, W, H);
    // menu.js never touches the world (see its header) — the final score is
    // world state, so it's main.js's job to draw it, not menu.open()'s to
    // have been handed it. Placed above the RESTART row rather than fighting
    // menu.js's own layout for space inside it.
    if (state === "gameover") glowText(ctx, `FINAL SCORE ${score.points}`, W / 2, 350, GREEN_BRIGHT, 18, "center", 10);
    return;
  }

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

  // While "dying", game/disconnect.js's shake() desyncs the WHOLE scene by a
  // screen-space offset — a feed losing sync, not a physical jolt (see its
  // header) — so everything from the floor grid to the glitching car itself
  // is drawn inside this translate, and only this translate. drawHud() and
  // disconnect's own CONNECTION LOST readout come after ctx.restore() below,
  // deliberately outside it, so the two things reporting the desync don't
  // themselves desync.
  ctx.save();
  if (state === "dying") {
    const [sx, sy] = disconnect.shake();
    ctx.translate(sx, sy);
  }

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
  // Pickups alongside obstacles, before traffic — so a car driving over one
  // is never hidden underneath it, same reasoning obstacles.render gets above.
  pickups.render(ctx, camY, player.y, W, H);
  traffic.render(ctx, camY, player.y, W, H, alpha);
  // Bullets over the traffic they're flying at, under the player's own car.
  // Hostile rounds draw with them and in the enemy's own red (weapons.js), so
  // which way a tracer is going is never a question the player has to work out.
  shots.render(ctx, camY, player.y, W, H);
  enemyShots.render(ctx, camY, player.y, W, H);
  // The player sits at worldY === distance, so that is where its heading comes
  // from — it leans into a bend along with the traffic around it. Read at camY,
  // like everything else drawn this frame, so the car's lean matches the bend of
  // the road actually on screen. While "dying", the disconnect sequence draws
  // in the player's place instead — see game/disconnect.js's render().
  if (state === "dying") disconnect.render(ctx, W, H);
  else player.render(ctx, alpha, road.headingAt(camY));
  ctx.restore();

  drawHud();
  if (state === "dying") disconnect.renderOverlay(ctx, W, H);
}

const loop = createLoop(update, render);
loop.start();
