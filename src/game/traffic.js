// Traffic — the other cars on the highway: spawning, driving, retiring, drawing.
//
// COORDINATE MODEL. Unlike the road and the city, traffic is NOT stateless: a
// car accumulates damage and reacts to the player, so it can't be a pure
// function of its position. Each car therefore lives as an object with:
//
//   worldY  its position ALONG the road, in the same world units as `distance`
//           (see road.js). Screen y is playerY - (worldY - distance).
//   offset  its position ACROSS the road, as a lateral px offset from the
//           centre-line. Screen x is centerXAt(worldY, W) + offset — so a car
//           follows every curve without steering, and `offset` means exactly one
//           thing (lane position) whether the road is straight or turning.
//
// A car exists only while it is near the player: it is spawned just off the top
// or bottom of the screen and retired once it has fallen far enough behind or
// run far enough ahead. Nothing off-screen is simulated, so the cost is flat in
// how far you've driven.
//
// WHAT A CAR DECIDES vs WHAT THIS FILE DECIDES: the car type's behaviour
// (behaviours.js) sets `targetOffset` / `targetSpeed`; this file integrates that
// intent under the type's steering and acceleration limits and keeps the car on
// the tarmac. Phase 3 ships cruising traffic only — no ramming or weapons yet,
// so cars currently pass THROUGH the player; collision physics lands next.

import { drawCarCached } from "./sprites.js";
import { behaviourFor } from "./behaviours.js";
import { pickCarType } from "./cartypes.js";
import { centerXAt, laneOffset, LANE_COUNT, ROAD_HALF_WIDTH } from "./road.js";

const MAX_CARS = 7;          // cars simulated at once
const SPAWN_INTERVAL = 1.1;  // seconds between spawn attempts
const SPAWN_MARGIN = 120;    // world units past the screen edge a car appears at
const RETIRE_MARGIN = 320;   // ...and how far past it before the car is dropped.
                             // Comfortably beyond SPAWN_MARGIN so a fresh car is
                             // never retired on the tick after it spawns.
const SPAWN_GAP = 150;       // min world-units clearance from another car in the
                             // same lane, so traffic never pops in on top of itself
const ACCEL = 140;           // world units/sec² traffic uses to reach targetSpeed

// One car on the road. Constructed by the spawner below; driven by its type's
// behaviour every tick.
class TrafficCar {
  constructor(type, worldY, lane, speed) {
    this.type = type;
    this.worldY = worldY;
    this.lane = lane;
    this.offset = laneOffset(lane);
    this.prevOffset = this.offset; // previous-tick offset, for render interpolation
    this.speed = speed;
    this.cruiseSpeed = speed; // the speed it returns to after slowing for traffic

    // Intent, written by the behaviour (see behaviours.js). Seeded with "keep
    // doing what you were spawned doing", so a car that never gets a decision
    // simply drives on.
    this.targetOffset = this.offset;
    this.targetSpeed = speed;

    this.health = type.health;
    this.maxHealth = type.health;
    this.alive = true;
    this.wheelPhase = 0; // accumulated roll distance, drives the wheel tread
  }

  // Take `amount` damage. Unused until Phase 4 adds weapons and ramming, but the
  // health a type carries is meaningless without one place that spends it.
  damage(amount) {
    if (!this.alive) return;
    this.health -= amount;
    if (this.health <= 0) {
      this.health = 0;
      this.alive = false;
    }
  }

  update(dt, world) {
    behaviourFor(this.type.behaviour)(this, dt, world);

    // Speed: approach the requested speed at a fixed rate rather than snapping,
    // so a behaviour can ask for anything without teleporting the car.
    const dv = this.targetSpeed - this.speed;
    const step = ACCEL * dt;
    this.speed += Math.abs(dv) <= step ? dv : Math.sign(dv) * step;

    // Lateral: slide toward the requested offset, capped by the type's steering.
    this.prevOffset = this.offset;
    const dx = this.targetOffset - this.offset;
    const maxDx = this.type.steerSpeed * dt;
    this.offset += Math.abs(dx) <= maxDx ? dx : Math.sign(dx) * maxDx;

    // Stay on the tarmac — traffic never scrapes the barriers.
    const limit = ROAD_HALF_WIDTH - this.type.w / 2;
    if (this.offset < -limit) this.offset = -limit;
    else if (this.offset > limit) this.offset = limit;

    this.worldY += this.speed * dt;
    this.wheelPhase += this.speed * dt;
  }
}

export class Traffic {
  constructor() {
    this.cars = [];
    this.spawnTimer = 0;
    // The view handed to the car behaviours: main.js's world plus the car list.
    // Reused across ticks rather than rebuilt, since every car reads it.
    this.view = { player: null, distance: 0, W: 0, H: 0, cars: this.cars };
  }

  // `world` = { player, distance, W, H }, built by main.js each tick. Behaviours
  // see it with `cars` added (see behaviours.js).
  update(dt, world) {
    Object.assign(this.view, world);
    this.view.cars = this.cars;
    for (const car of this.cars) car.update(dt, this.view);

    this.retire(world);

    this.spawnTimer -= dt;
    if (this.spawnTimer <= 0) {
      this.spawnTimer = SPAWN_INTERVAL;
      if (this.cars.length < MAX_CARS) this.spawn(world);
    }

    // Painter's order: farthest ahead first, so nearer cars overlap the ones
    // beyond them (same rule the city floor draws by).
    this.cars.sort((a, b) => b.worldY - a.worldY);
  }

  // Drop cars that have left the neighbourhood, or that were destroyed.
  retire({ distance, player, H }) {
    const ahead = distance + player.y + RETIRE_MARGIN;
    const behind = distance - (H - player.y) - RETIRE_MARGIN;
    this.cars = this.cars.filter(
      (car) => car.alive && car.worldY < ahead && car.worldY > behind,
    );
  }

  // Introduce one car just off-screen.
  //
  // WHICH END it enters from follows from its speed: a car slower than the
  // player is placed AHEAD (the player runs it down), a faster one BEHIND (it
  // overtakes). Spawning a slow car behind would leave it dropping away, never
  // seen — and a fast one ahead would simply vanish over the horizon.
  spawn({ distance, player, H }) {
    const type = this.pickType();
    const speed = type.speedMin + Math.random() * (type.speedMax - type.speedMin);

    const ahead = speed < player.speed;
    const worldY = ahead
      ? distance + player.y + SPAWN_MARGIN
      : distance - (H - player.y) - SPAWN_MARGIN;

    const lane = this.freeLane(worldY);
    if (lane === -1) return; // every lane busy here; try again next interval

    this.cars.push(new TrafficCar(type, worldY, lane, speed));
  }

  // A weighted type pick that resists one kind taking over the road.
  //
  // Traffic self-selects for cars driving at the PLAYER'S speed: a car much
  // slower or faster crosses the screen and retires in a few seconds, while one
  // closing at 40 units/sec stays for half a minute. Measured over a minute of
  // steady cruising, that left all seven slots holding the one type that happened
  // to match — so re-roll a type that already holds its share of the live cars.
  pickType() {
    const cap = Math.max(2, Math.floor(this.cars.length / 3));
    for (let attempt = 0; attempt < 4; attempt++) {
      const type = pickCarType();
      const held = this.cars.reduce((n, car) => n + (car.type === type ? 1 : 0), 0);
      if (held < cap) return type;
    }
    return pickCarType(); // crowded road — take whatever came up
  }

  // A lane with nothing already sitting near `worldY`, or -1 if there is none.
  // Lanes are tried in random order so traffic doesn't favour the left.
  freeLane(worldY) {
    const start = Math.floor(Math.random() * LANE_COUNT);
    for (let i = 0; i < LANE_COUNT; i++) {
      const lane = (start + i) % LANE_COUNT;
      const blocked = this.cars.some(
        (car) => car.lane === lane && Math.abs(car.worldY - worldY) < SPAWN_GAP,
      );
      if (!blocked) return lane;
    }
    return -1;
  }

  // `alpha` is the loop's interpolation fraction (see engine/loop.js). Only the
  // lateral offset is interpolated: screen y comes from the raw `worldY` and the
  // raw `distance`, exactly as the road and city are drawn, so traffic stays
  // welded to the tarmac instead of sliding against it a fraction of a step.
  render(ctx, distance, playerY, W, H, alpha) {
    for (const car of this.cars) {
      const sy = playerY - (car.worldY - distance);
      if (sy < -SPAWN_MARGIN || sy > H + SPAWN_MARGIN) continue;

      const offset = car.prevOffset + (car.offset - car.prevOffset) * alpha;
      const sx = centerXAt(car.worldY, W) + offset;

      drawCarCached(ctx, sx, sy, {
        color: car.type.color,
        thrust: car.type.thrust,
        w: car.type.w,
        h: car.type.h,
        wheelPhase: car.wheelPhase,
      });
    }
  }
}
