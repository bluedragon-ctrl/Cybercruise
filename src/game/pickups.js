// Buff pickups — crates that spawn on the road and grant the player an
// instant effect on contact (an ammo refill, a heal, or a shield). Same shape
// of job as obstacles.js, considerably simpler: a pickup never moves, never
// damages anyone, and only the PLAYER can trigger it — traffic drives straight
// through one with no reaction. A buff is a reward the game is offering the
// player specifically, not a hazard shared traffic has any reason to avoid or
// was ever taught to (behaviours.js's avoidHazards never sees this list).
//
// WHY NOT OBSTACLES.JS'S PLACEMENT MACHINERY. Obstacles.js earns its passage
// rule and cluster-avoidance because a hazard that seals the road is a bug —
// see its own header, "the one thing a spawn may never do is close the road".
// A pickup blocks nothing (contact with it costs nobody any speed), so none
// of that applies: a crate can be dropped anywhere across the tarmac with a
// plain random offset. That is also exactly what this pass was asked for —
// let the five buffs spawn randomly first; a fairness/placement pass on top
// is a later refinement, not a prerequisite.
//
// SPAWNING AND TUNING NUMBERS BELOW ARE A FIRST PASS, same caveat every other
// freshly-landed catalogue in this codebase carries: retune once there is
// real road time to measure the buffs against, not by guessing.

import { drawPickupShape, PICKUP_SHAPES } from "./pickupshapes.js";
import { pickPickupType, applyPickup, AMMO, HEAL, SHIELD } from "./pickuptypes.js";
import { centerXAt, headingAt, ROAD_HALF_WIDTH } from "./road.js";
import { overlaps } from "./collisions.js";
import * as gameConsole from "../engine/console.js";

// The console line a crate's kind reads as (engine/console.js) — always a
// HINT, never a warning, since a pickup is only ever good news.
function pickupMessage(type) {
  switch (type.kind) {
    case AMMO:
      return `${type.label} +${type.amount}`;
    case HEAL:
      return `HULL REPAIRED +${type.amount}`;
    case SHIELD:
      return `SHIELD CHARGED ${type.duration}s`;
    default:
      return type.label;
  }
}

const SPAWN_INTERVAL = 5; // seconds between spawn attempts
const MAX_PICKUPS = 3; // live crates at once
// World units past the screen's top edge a crate appears at — same order as
// traffic's own SPAWN_MARGIN (120, traffic.js), since nothing needs advance
// warning of a pickup the way behaviours.js's hazard dodge needs of a hazard.
const SPAWN_MARGIN = 150;
const RETIRE_MARGIN = 250; // ...and how far past the bottom before it's dropped
const DRAW_MARGIN = 40; // px past the screen edge still worth drawing
// rad/sec the reticle breathes at — distinct from (and slower than) the
// mine's own 7 (obstacles.js's PULSE_RATE) so a pickup never reads as a
// hazard blinking.
const PULSE_RATE = 2.2;

// One crate on the road.
class Pickup {
  constructor(type, worldY, offset) {
    this.type = type;
    this.worldY = worldY; // fixed for life — pickups do not move
    this.offset = offset;
    this.alive = true;
    // Seconds live. Drives the reticle's own pulse AND, for SHIELD, the
    // spinning tick on its glyph (pickupshapes.js's drawShieldGlyph) — one
    // clock for both rather than tracking pulse and animation phase apart.
    this.age = 0;
    // Random phase so several live crates don't breathe in lockstep — the
    // same reasoning RoadObstacle gives its own pulsePhase.
    this.pulsePhase = Math.random() * Math.PI * 2;
  }

  get w() {
    return PICKUP_SHAPES[this.type.shape].size[0];
  }

  get h() {
    return PICKUP_SHAPES[this.type.shape].size[1];
  }
}

export class Pickups {
  // `onCollect` is optional: `(type) => void`, called once per crate actually
  // collected, with its pickuptypes.js entry — mirrors traffic.js's own
  // onDestroyed/obstacles.js's onDestroyed callback shape, for the same
  // reason: this file stays ignorant of the audio engine (see the Phase 8
  // design brief's own rule) while still giving main.js a hook onto the one
  // place a crate is ever actually applied.
  constructor(explosions, onCollect) {
    this.explosions = explosions; // shared with Traffic/Obstacles — see effects.js
    this.onCollect = onCollect;
    this.list = [];
    this.spawnTimer = SPAWN_INTERVAL;
  }

  // `world` = { player, distance, W, H, loadout }. `loadout` is the player's
  // Loadout (weapons.js) — the one thing an ammo pickup needs that `player`
  // itself doesn't carry.
  update(dt, world) {
    const { player, distance, W, loadout } = world;
    const centerX = centerXAt(distance, W);

    // The player expressed as a body in road coordinates, exactly as
    // obstacles.js's own playerBox does it, but read-only: a pickup never
    // shoves or damages anything, so there is no need for a `damage` accessor.
    const playerBox = {
      worldY: distance,
      offset: player.x - centerX,
      w: player.w,
      h: player.h,
    };

    for (const p of this.list) {
      if (!p.alive) continue;
      p.age += dt;
      if (overlaps(p, playerBox)) {
        applyPickup(p.type, player, loadout);
        gameConsole.push(pickupMessage(p.type), gameConsole.HINT);
        // Every crate bursts in the player's own cyan, whichever buff it was —
        // see effects.js's drawCollectBurst header for why the burst answers
        // "that was mine" rather than "that was a rocket refill".
        this.explosions.spawnCollect(p.worldY, p.offset);
        if (this.onCollect) this.onCollect(p.type);
        p.alive = false;
      }
    }

    this.retire(world);

    this.spawnTimer -= dt;
    if (this.spawnTimer <= 0) {
      this.spawnTimer = SPAWN_INTERVAL;
      if (this.list.length < MAX_PICKUPS) this.spawn(world);
    }
  }

  // Drop crates that have fallen behind, or that were just collected. Unlike
  // traffic there is no "ahead" bound to check — a pickup is always spawned
  // ahead of the player and can only ever fall behind.
  retire({ distance, player, H }) {
    const behind = distance - (H - player.y) - RETIRE_MARGIN;
    this.list = this.list.filter((p) => p.alive && p.worldY > behind);
  }

  // Introduce one crate just off the top of the screen, at a plain random
  // offset across the tarmac — see the header for why this needs none of
  // obstacles.js's fairness machinery.
  spawn({ distance, player }) {
    const type = pickPickupType(distance);
    if (!type) return; // nothing unlocked yet (pickuptypes.js's minDistance)

    const worldY = distance + player.y + SPAWN_MARGIN;
    const half = ROAD_HALF_WIDTH - PICKUP_SHAPES[type.shape].size[0] / 2;
    const offset = (Math.random() * 2 - 1) * half;
    this.list.push(new Pickup(type, worldY, offset));
  }

  // Place one crate immediately at (worldY, offset) — for a drop the GAME
  // decided rather than the random road spawner (currently: a destroyed
  // hostile's chance to leave a FIX crate where it died, main.js).
  //
  // NO SEPARATE BUDGET, unlike obstacles.js's own drop() for a laid mine.
  // That one needs MAX_LAID because a live car can lay a mine every few
  // seconds for as long as it survives — a repeating source that could carpet
  // the road. A death drop is self-limiting by construction: a car can only
  // die once, so the rate this can possibly fire at is already bounded by how
  // fast hostiles can be killed, nowhere near enough to flood MAX_PICKUPS.
  drop(type, worldY, offset) {
    if (!type) return;
    this.list.push(new Pickup(type, worldY, offset));
  }

  // No lateral interpolation, for the same reason obstacles skip it: a
  // pickup's offset never changes after spawn.
  render(ctx, distance, playerY, W, H) {
    for (const p of this.list) {
      const sy = playerY - (p.worldY - distance);
      if (sy < -DRAW_MARGIN || sy > H + DRAW_MARGIN) continue;

      const sx = centerXAt(p.worldY, W) + p.offset;
      // Bright-biased (0.7 floor, not 0 like the mine's own pulse) so the
      // reticle reads as "live" the whole time rather than fading in and out
      // — a target lock breathing, not a hazard blinking.
      const pulse = 0.7 + 0.3 * Math.sin(p.age * PULSE_RATE + p.pulsePhase);
      drawPickupShape(ctx, sx, sy, p.type.shape, pulse, p.age, headingAt(p.worldY));
    }
  }
}
