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
// DEATH is handled here too: a car at zero hull explodes (effects.js) and its
// blast hurts whatever is beside it, possibly setting off a chain. The wreck is
// pure effect — the car itself leaves the simulation the same tick — so the road
// is never left with an obstacle on it.
//
// WHAT A CAR DECIDES vs WHAT THIS FILE DECIDES: the car type's behaviour
// (behaviours.js) sets `targetOffset` / `targetSpeed`; this file integrates that
// intent under the type's steering and acceleration limits and keeps the car on
// the tarmac. Ramming is a third thing again — cars shoving each other and the
// player around is solved for every body at once, in collisions.js, after all of
// them have moved.

import { drawCarCached } from "./sprites.js";
import { behaviourFor } from "./behaviours.js";
import { pickCarType } from "./cartypes.js";
import { Explosions } from "./effects.js";
import { resolveCollisions, PlayerBody } from "./collisions.js";
import { PLAYER_MASS } from "./player.js";
import { centerXAt, laneOffset, laneAt, LANE_COUNT, ROAD_HALF_WIDTH } from "./road.js";
import { CRITICAL_FLASH } from "../engine/palette.js";

const MAX_CARS = 7;          // cars simulated at once
const SPAWN_INTERVAL = 1.1;  // seconds between spawn attempts
const SPAWN_MARGIN = 120;    // world units past the screen edge a car appears at
const RETIRE_MARGIN = 320;   // ...and how far past it before the car is dropped.
                             // Comfortably beyond SPAWN_MARGIN so a fresh car is
                             // never retired on the tick after it spawns.
const SPAWN_GAP = 150;       // min world-units of CLEAR ROAD between the boxes of
                             // two cars in the same lane at spawn time, so traffic
                             // never pops in on top of itself. Measured between
                             // box edges, not centres: the rig is 124 units long,
                             // and a centre-to-centre rule would let one appear
                             // half inside another
const ACCEL = 340;           // world units/sec² traffic uses to reach targetSpeed.
                             // Sized against the CATALOGUE, not against feel: the
                             // speed band runs 180..730 (cartypes.js) and the
                             // player can be down at 120, so a car can close at up
                             // to 610 units/sec on the thing in front. behaviours.js
                             // gives a follower one second of closing rate to shed
                             // that, which only works while 2 * ACCEL >= the largest
                             // closing speed. Just under the player's own 380, so
                             // traffic still can't out-brake the player.
const SHOVE_DAMP = 5;        // per second; how fast a rammed car's slide dies away
const CRITICAL = 0.35;       // hull fraction below which a car reads as wrecked
const BLINK_PERIOD = 0.12;   // seconds per half-cycle of the critical-hull blink

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
    this.exploded = false; // set when its wreck has been spawned (see Traffic.detonate),
                           // so a chain reaction can't set the same car off twice
    this.wheelPhase = 0; // accumulated roll distance, drives the wheel tread
    this.vLateral = 0; // sideways velocity from being rammed (collisions.js)
    this.criticalTime = 0; // seconds spent on the brink; drives the blink
  }

  // One more hit and this car is scrap. Drives the warning blink in render(),
  // and it's the natural hook for the destruction effect being built separately.
  get critical() {
    return this.health < this.maxHealth * CRITICAL;
  }

  // Collision box and ramming mass, read straight off the type. Present as
  // fields on the car because collisions.js treats every body the same way and
  // knows nothing about car types.
  get w() {
    return this.type.w;
  }

  get h() {
    return this.type.h;
  }

  get mass() {
    return this.type.mass;
  }

  // Take `amount` hull damage. At zero the car is destroyed: it stops colliding
  // immediately, Traffic.detonate blows it up, and retire() drops it at the end
  // of the tick. Nothing is left behind on the road — the wreck is pure effect,
  // so driving through the fireball costs nothing by itself.
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

    // ...plus whatever is left of the last shove, which the driver can't help.
    this.offset += this.vLateral * dt;
    this.vLateral -= this.vLateral * Math.min(1, SHOVE_DAMP * dt);

    this.clampToRoad();

    this.worldY += this.speed * dt;
    this.wheelPhase += this.speed * dt;

    // Timed per car rather than off a global clock, so a car starts blinking at
    // the moment it's crippled and the road doesn't strobe in unison.
    if (this.critical) this.criticalTime += dt;
  }

  // Keep the car on the tarmac — traffic never scrapes the barriers, even when
  // rammed at one: the wall absorbs the shove, and the car pinned against it is
  // what passes the hit back. Called again after the collision pass, which moves
  // offsets around and would otherwise leave a squeezed car hanging over the
  // edge for a frame.
  clampToRoad() {
    const limit = ROAD_HALF_WIDTH - this.type.w / 2;
    if (this.offset < -limit) {
      this.offset = -limit;
      if (this.vLateral < 0) this.vLateral = 0;
    } else if (this.offset > limit) {
      this.offset = limit;
      if (this.vLateral > 0) this.vLateral = 0;
    }

    // Where the car ACTUALLY is now, which a shove may have changed. Only the
    // spawner reads it, but a stale lane would let traffic pop in on top of a
    // car that has been knocked across the road.
    this.lane = laneAt(this.offset);
  }
}

export class Traffic {
  constructor() {
    this.cars = [];
    this.spawnTimer = 0;
    // The view handed to the car behaviours: main.js's world plus the car list.
    // Reused across ticks rather than rebuilt, since every car reads it.
    this.view = { player: null, distance: 0, W: 0, H: 0, cars: this.cars };

    // The player as something collisions.js can push around, plus the scratch
    // list of bodies handed to it. Both are reused rather than rebuilt per tick.
    this.playerBody = new PlayerBody(PLAYER_MASS, ROAD_HALF_WIDTH);
    this.bodies = [];

    // Wrecks. Owned here because traffic is what dies: a car's destruction and
    // its explosion are the same event, and keeping them together means main.js
    // never has to know that cars can blow up.
    this.explosions = new Explosions();
  }

  // `world` = { player, distance, W, H }, built by main.js each tick. Behaviours
  // see it with `cars` added (see behaviours.js).
  update(dt, world) {
    // Put the player in road coordinates first, so the behaviours can treat it
    // as just another obstacle on the tarmac (behaviours.js) and the collision
    // pass below can reuse the same body.
    this.playerBody.sync(world.player, world.distance, centerXAt(world.distance, world.W));

    Object.assign(this.view, world);
    this.view.cars = this.cars;
    this.view.playerBody = this.playerBody;
    for (const car of this.cars) car.update(dt, this.view);

    // Everything has moved; now sort out who is inside whom. Done here rather
    // than in main.js because traffic owns the cars, and the player has already
    // taken its own step by the time we're called.
    this.collide(dt);

    // Anything the collision pass killed goes up now, BEFORE retire() drops it —
    // the wreck needs the car's final position, and its blast may kill others.
    this.detonate();
    this.explosions.update(dt);

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

  // Ramming: hand every car AND the player to the solver as one flat list, so a
  // car shunted by the player carries the hit into whatever it lands on with no
  // special case for who started it (see collisions.js).
  collide(dt) {
    this.bodies.length = 0;
    this.bodies.push(this.playerBody);
    for (const car of this.cars) this.bodies.push(car);
    resolveCollisions(this.bodies, dt);
    // The solver doesn't know where the road is; put anything it pushed over an
    // edge back on the tarmac. (The player clamps itself — see PlayerBody.)
    for (const car of this.cars) car.clampToRoad();
  }

  // --- Destruction ----------------------------------------------------------
  //
  // A destroyed car EXPLODES: the wreck (effects.js) is drawn where it died, and
  // the blast hurts whatever was standing next to it. Nothing solid is left
  // behind — the car is dropped from the simulation the same tick — so driving
  // straight through the fireball costs the player nothing but the blast itself,
  // which they were already inside of when it went off.
  //
  // CHAINS. A blast can destroy another car, which then explodes too. The sweep
  // below keeps going until nothing new has died, which terminates because each
  // car detonates exactly once (`exploded`) and there are finitely many.
  detonate() {
    // At most one detonation per car, so this bound is exact rather than a
    // safety net — but it does mean a runaway can't hang the frame either.
    for (let n = 0; n < this.cars.length; n++) {
      const car = this.cars.find((c) => !c.alive && !c.exploded);
      if (!car) return;
      car.exploded = true;
      this.explosions.spawn(car.worldY, car.offset, car.type);
      this.blast(car);
    }
  }

  // Hull damage to everything near a detonating car, the player included.
  //
  // Distance is measured BETWEEN BOX EDGES, not between centres: a rig is 124
  // units long, and a centre-to-centre radius would leave the car tucked
  // alongside its trailer untouched while punishing one two lengths behind. Peak
  // damage at contact, falling off linearly to nothing at the rim, so proximity
  // is what the player is being asked to judge.
  blast(car) {
    const radius = car.type.blastRadius;
    const peak = car.type.blastDamage;
    if (!radius || !peak) return;

    const hurt = (body) => {
      // Cars already destroyed are skipped rather than hit again: they have
      // their own detonation coming, and this is what stops two dying cars
      // trading blasts.
      if (body === car || !body.alive) return;
      const dx = Math.max(0, Math.abs(body.offset - car.offset) - (body.w + car.w) / 2);
      const dy = Math.max(0, Math.abs(body.worldY - car.worldY) - (body.h + car.h) / 2);
      const dist = Math.hypot(dx, dy);
      if (dist >= radius) return;
      body.damage(peak * (1 - dist / radius));
    };

    for (const other of this.cars) hurt(other);
    hurt(this.playerBody);
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

    const lane = this.freeLane(worldY, type.h);
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
  // `h` is the length of the car being placed, since the clearance wanted is
  // between the two BOXES, not their centres. Lanes are tried in random order so
  // traffic doesn't favour the left.
  freeLane(worldY, h) {
    const start = Math.floor(Math.random() * LANE_COUNT);
    for (let i = 0; i < LANE_COUNT; i++) {
      const lane = (start + i) % LANE_COUNT;
      const blocked = this.cars.some(
        (car) =>
          car.lane === lane &&
          Math.abs(car.worldY - worldY) - (car.h + h) / 2 < SPAWN_GAP,
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

      // A car down to its last third of hull BLINKS, whatever its faction — the
      // player needs to see which one is about to go, and it's the only read-out
      // ramming has until the destruction effect lands. Alternating is what
      // carries the signal: a static red tint would vanish on a red enemy car.
      // One extra sprite-cache colour, shared by every type.
      const blink = car.critical && Math.floor(car.criticalTime / BLINK_PERIOD) % 2 === 1;

      drawCarCached(ctx, sx, sy, {
        shape: car.type.shape,
        color: blink ? CRITICAL_FLASH : car.type.color,
        thrust: car.type.thrust,
        w: car.type.w,
        h: car.type.h,
        wheelPhase: car.wheelPhase,
      });
    }

    // Wrecks last, so a fireball is never drawn under the traffic still driving
    // through it. (The player is drawn after all of this — see main.js — so its
    // car stays readable inside a blast.)
    this.explosions.render(ctx, distance, playerY, W, H);
  }
}
