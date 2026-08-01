// Road obstacles — the static hazards (roadblocks, mines) that live on the
// road: spawning, placement, triggering, drawing. Same job as traffic.js, for
// a much simpler kind of entity.
//
// STATIC, UNLIKE TRAFFIC. An obstacle never moves once placed — no speed, no
// steering, no behaviour — so it needs none of TrafficCar's integration step.
// It has exactly two things that can happen to it: something hits it, and it
// eventually scrolls far enough behind the player to be dropped. Its `worldY`
// is therefore written once, at spawn, and never touched again.
//
// ONE PASS, ONE HIT. A roadblock or mine sits at a fixed point on an
// infinitely scrolling road — nothing can double back on the player's minimum
// speed (player.js), so nothing ever gets a second run at the same obstacle.
// That is why a RAM always destroys an obstacle outright regardless of its
// `health`: partial damage surviving a hit you structurally cannot repeat
// would just be a number nobody ever sees move. `health` (obstacletypes.js)
// is spent by GUNFIRE instead, which — unlike a ram — the player can walk
// away from and take again: shooting a hazard out from a safe distance is the
// one situation where "how many hits does this take" is a real question.
//
// THE SHARED EXPLOSION POOL. `explosions` is constructed once in main.js and
// handed to both this class and Traffic — see effects.js's Explosions header:
// "cars, mines and roadblocks share ONE pool rather than getting one each…
// they compete for the same frame budget." A mine going off next to a dying
// car is exactly the moment that pool's cap is meant to bite, so the two
// systems must never each get their own.
//
// BLAST DAMAGE reuses Traffic.blast()'s exact falloff formula (peak at the
// box edge, zero at `blastRadius`) rather than inventing a second one — a
// roadblock's small radius and a mine's wide one are then just two points on
// the SAME curve traffic.js already uses for a car's death, not a parallel
// mechanic with its own rules to keep in sync.
//
// TICK ORDER (see main.js). This runs AFTER shots.update() and BEFORE
// traffic.update(), for the same reason shots run before traffic: an obstacle
// (or car) killed this tick must detonate and, for a car, score in the frame
// it died in rather than a frame late. Concretely: gunfire can already have
// marked an obstacle's health <= 0 by the time update() runs here, and a
// mine's blast here can already have marked a car's health <= 0 by the time
// traffic.update() runs after — both get picked up the same tick they died.

import { drawObstacleCached } from "./sprites.js";
import { pickObstacleType } from "./obstacletypes.js";
import { OBSTACLE_SHAPES, MINE } from "./obstacleshapes.js";
import { centerXAt, laneOffset, LANE_COUNT } from "./road.js";


// Hazards simulated at once. Sized against SPAWN_MARGIN below rather than
// picked: a hazard is now placed well beyond the traffic field and has to scroll
// all the way back through it, so it lives roughly three times as long as it did
// when it appeared just off the top of the screen. The old cap of 4 was sized
// for that short life and, left alone, became the thing limiting how often the
// player meets an obstacle at all.
const MAX_OBSTACLES = 8;
const SPAWN_INTERVAL = 2.2;   // seconds between spawn attempts — rarer than traffic

// HOW FAR AHEAD A HAZARD IS PLACED, and this is not a framing choice — it is
// what makes traffic's avoidance (behaviours.js) possible at all.
//
// A hazard has to appear BEYOND EVERY LIVE CAR, with enough road left over for
// the worst dodger in the catalogue to get out of the way. Traffic is simulated
// out to traffic.js's RETIRE_MARGIN past the player, and the slowest-steering
// type (the rig, at 35px/sec) needs about 1040 units to cross two lanes at
// cruising speed — so anything less than their sum drops hazards into the
// middle of the traffic field, where the cars nearest the spawn point are given
// a few dozen units of warning and cannot possibly use it.
//
// That was measured, not guessed: at the original 140 the road cleared 88% of
// its own hazards before the player ever saw one, and the failures were
// dominated by exactly the type this bound is sized against.
//
// Exported and asserted in test/invariants.test.js, since the relation is
// between three numbers in three different files.
export const SPAWN_MARGIN = 1400; // world units past the player an obstacle appears at
const RETIRE_MARGIN = 220;    // how far behind the player before it's dropped
const DRAW_MARGIN = 140;      // px past the screen edge still worth blitting. Kept
                              // separate from SPAWN_MARGIN: a hazard spawns most of
                              // a screen-height beyond the top edge and would
                              // otherwise be drawn for seconds before it is visible
const SPAWN_GAP = 90;         // min world-units of CLEAR ROAD between two obstacles'
                              // boxes in the same lane, measured edge to edge —
                              // same idea as traffic.js's SPAWN_GAP
// A spawn must leave at least one lane clear within this many world-units of
// itself — measured against every OTHER live obstacle, not just ones in the
// same lane — so a run of unlucky rolls can never wall off the whole road.
const CLUSTER_WINDOW = 130;

// Matches the mine pulse formula demo/gallery.js uses for the same shape
// (`0.5 + 0.5 * Math.sin(seconds * 7)`), so the asset gallery and the live
// game blink at the same rate.
const PULSE_RATE = 7;

// One obstacle on the road. Constructed by the spawner below.
class RoadObstacle {
  constructor(type, worldY, lane) {
    this.type = type;
    this.worldY = worldY; // fixed for life — obstacles do not move
    this.lane = lane;
    this.offset = laneOffset(lane);
    this.health = type.health;
    this.alive = true;
    this.exploded = false; // set once its destruction effect has been spawned,
                           // so a kill from two directions in one tick (gunfire
                           // that already zeroed it, then a ram) can't detonate
                           // it twice
    this.pulseTime = 0;
    // Random phase so several live mines don't blink in lockstep — the same
    // reasoning TrafficCar gives its own driftPhase.
    this.pulsePhase = Math.random() * Math.PI * 2;
  }

  // Collision box, read off the shape catalogue (obstacleshapes.js: "`size` is
  // the obstacle's physical FOOTPRINT... what a collision test should use").
  // Not duplicated onto the type the way cartypes.js duplicates a car's w/h,
  // because an obstacle's artwork is authored tight to this exact footprint —
  // there is no independent "collision box" to tune away from it.
  get w() {
    return OBSTACLE_SHAPES[this.type.shape].size[0];
  }

  get h() {
    return OBSTACLE_SHAPES[this.type.shape].size[1];
  }

  // What driving into this costs, in hull. Traffic reads it to decide whether
  // to steer around (behaviours.js compares it against the driver's `nerve`),
  // and it is exposed as a plain body property rather than having behaviours
  // reach into `type.blastDamage` — a later hazard that hurts by some other
  // means than a blast can then answer the same question without behaviours.js
  // learning anything new about obstacles.
  get threat() {
    return this.type.blastDamage;
  }

  // Take `amount` hull damage — the interface projectiles.js's targets need.
  // See the header for why this is gunfire's path onto an obstacle and a ram
  // never goes through it.
  damage(amount) {
    if (!this.alive) return;
    this.health -= amount;
    if (this.health <= 0) {
      this.health = 0;
      this.alive = false;
    }
  }
}

// AABB overlap between two boxes exposing {worldY, offset, w, h}. Obstacles
// never move under a rammed shove the way TrafficCar does, so this is the
// whole test — no resolveCollisions-style separation is needed on either side.
function overlaps(a, b) {
  return (
    Math.abs(a.worldY - b.worldY) < (a.h + b.h) / 2 &&
    Math.abs(a.offset - b.offset) < (a.w + b.w) / 2
  );
}

export class Obstacles {
  constructor(explosions) {
    this.explosions = explosions; // shared with Traffic — see the header
    this.list = [];
    this.spawnTimer = SPAWN_INTERVAL;
  }

  // `world` = { player, distance, W, H, cars }. `cars` is Traffic's live list
  // (main.js passes traffic.cars) — optional, so a caller with no traffic yet
  // (tests) can omit it and obstacles simply never trigger off a car.
  update(dt, world) {
    const { player, distance, W, cars = [] } = world;
    const centerX = centerXAt(distance, W);

    // The player expressed as a body in road coordinates, exactly as
    // collisions.js's PlayerBody does it, but read-only: an obstacle never
    // shoves anything, so there is no need for the fuller adapter.
    const playerBox = {
      worldY: distance,
      offset: player.x - centerX,
      w: player.w,
      h: player.h,
      damage: (hp) => player.damage(hp),
    };

    // Contact: the player or any live car driving into a hazard breaks it —
    // see the header for why this ignores `health` entirely.
    for (const o of this.list) {
      if (!o.alive) continue;
      o.pulseTime += dt;
      if (overlaps(o, playerBox) || cars.some((c) => c.alive && overlaps(o, c))) {
        o.health = 0;
        o.alive = false;
      }
    }

    this.detonate(playerBox, cars);
    this.retire(world);

    this.spawnTimer -= dt;
    if (this.spawnTimer <= 0) {
      this.spawnTimer = SPAWN_INTERVAL;
      if (this.list.length < MAX_OBSTACLES) this.spawn(world);
    }
  }

  // Break every obstacle killed this tick — by the contact pass above or by
  // gunfire in main.js, before update() ran — exactly once. Mirrors
  // Traffic.detonate()'s same bounded sweep for the same reason: dying is rare
  // enough per tick that an exact bound costs nothing, and it doubles as a
  // guard against a runaway loop.
  detonate(playerBox, cars) {
    for (let n = 0; n < this.list.length; n++) {
      const o = this.list.find((x) => !x.alive && !x.exploded);
      if (!o) return;
      o.exploded = true;

      // The destruction EFFECT follows the shape's family, not the obstacle's
      // own state — a mine always gets the EMP bloom, a roadblock always gets
      // its debris style (spawnObstacleWreck reads that off OBSTACLE_SHAPES
      // itself; see effects.js).
      if (OBSTACLE_SHAPES[o.type.shape].family === MINE) {
        this.explosions.spawnMineBlast(o.worldY, o.offset);
      } else {
        this.explosions.spawnObstacleWreck(o.worldY, o.offset, o.type.shape);
      }

      this.blast(o, playerBox, cars);
    }
  }

  // Hurt whoever is standing near a detonating obstacle. Identical falloff to
  // Traffic.blast() — peak damage at the box edge, nothing at `blastRadius` —
  // so a roadblock's tight radius and a mine's wide one are the same formula
  // at two different settings, not two mechanics to keep in sync.
  blast(o, playerBox, cars) {
    const radius = o.type.blastRadius;
    const peak = o.type.blastDamage;
    if (!radius || !peak) return;

    const hurt = (body) => {
      const dx = Math.max(0, Math.abs(body.offset - o.offset) - (body.w + o.w) / 2);
      const dy = Math.max(0, Math.abs(body.worldY - o.worldY) - (body.h + o.h) / 2);
      const dist = Math.hypot(dx, dy);
      if (dist >= radius) return;
      body.damage(peak * (1 - dist / radius));
    };

    hurt(playerBox);
    for (const car of cars) if (car.alive) hurt(car);
  }

  // Drop obstacles that have fallen behind the neighbourhood, or that were
  // destroyed. Unlike traffic there is no "ahead" bound to check — a static
  // obstacle is always spawned ahead of the player and can only ever fall
  // behind, never run off over the horizon.
  retire({ distance, player, H }) {
    const behind = distance - (H - player.y) - RETIRE_MARGIN;
    this.list = this.list.filter((o) => o.alive && o.worldY > behind);
  }

  // Introduce one obstacle just off the top of the screen.
  spawn({ distance, player, cars = [] }) {
    const type = pickObstacleType();
    const worldY = distance + player.y + SPAWN_MARGIN;
    const [w, h] = OBSTACLE_SHAPES[type.shape].size;

    const lane = this.freeLane(worldY, w, h, cars);
    if (lane === -1) return; // no lane both clear and fair right now — try next interval

    this.list.push(new RoadObstacle(type, worldY, lane));
  }

  // A lane with nothing already sitting near `worldY`, subject to the
  // fairness rule in the header — or -1 if none qualifies.
  //
  // LIVE TRAFFIC COUNTS as much as another obstacle does, and for a reason that
  // is not symmetric with it: an obstacle appearing on top of a car gives that
  // car's driver no warning at all, and behaviours.js can only steer around a
  // hazard it had road enough to see. The two spawn points nearly coincide
  // (traffic.js appears a SPAWN_MARGIN past the screen edge and this file a
  // slightly larger one), so without this a mine materialises a few units in
  // front of a car that then detonates it before the player ever sees it — and
  // no amount of driving skill on the car's part could have avoided it.
  freeLane(worldY, w, h, cars = []) {
    const start = Math.floor(Math.random() * LANE_COUNT);
    for (let i = 0; i < LANE_COUNT; i++) {
      const lane = (start + i) % LANE_COUNT;
      const offset = laneOffset(lane);

      const tooClose = this.list.some(
        (o) => o.lane === lane && Math.abs(o.worldY - worldY) - (o.h + h) / 2 < SPAWN_GAP,
      );
      if (tooClose) continue;

      // Traffic is tested by LATERAL OVERLAP rather than by lane number: a
      // block can be wider than a lane, and ramming leaves cars sitting between
      // lanes, so "which lane is it in" is the wrong question for both of them.
      const onTraffic = cars.some(
        (c) =>
          c.alive &&
          Math.abs(c.offset - offset) < (c.w + w) / 2 &&
          Math.abs(c.worldY - worldY) - (c.h + h) / 2 < SPAWN_GAP,
      );
      if (onTraffic) continue;

      // Fairness: which lanes are already spoken for near this stretch of
      // road, PLUS the one this spawn would take. If that covers every lane,
      // this candidate would seal the road off — reject it and try another.
      const blocked = new Set(
        this.list
          .filter((o) => Math.abs(o.worldY - worldY) < CLUSTER_WINDOW)
          .map((o) => o.lane),
      );
      blocked.add(lane);
      if (blocked.size >= LANE_COUNT) continue;

      return lane;
    }
    return -1;
  }

  // No lateral interpolation, for the same reason bullets and explosions skip
  // it: an obstacle's `offset` never changes after spawn, so there is nothing
  // to smooth between logic ticks.
  render(ctx, distance, playerY, W, H) {
    for (const o of this.list) {
      const sy = playerY - (o.worldY - distance);
      if (sy < -DRAW_MARGIN || sy > H + DRAW_MARGIN) continue;

      const sx = centerXAt(o.worldY, W) + o.offset;
      const pulse = 0.5 + 0.5 * Math.sin(o.pulseTime * PULSE_RATE + o.pulsePhase);
      drawObstacleCached(ctx, sx, sy, { shape: o.type.shape, pulse });
    }
  }
}
