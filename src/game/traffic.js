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
import { driveCar } from "./behaviours.js";
import { pickCarType } from "./cartypes.js";
import { drivingFor } from "./driving.js";
import { armFor } from "./armament.js";
import { Explosions } from "./effects.js";
import { resolveCollisions, PlayerBody } from "./collisions.js";
import { PLAYER_MASS } from "./player.js";
import { centerXAt, headingAt, laneOffset, laneAt, LANE_COUNT, ROAD_HALF_WIDTH } from "./road.js";
import { CRITICAL_FLASH } from "../engine/palette.js";

const MAX_CARS = 7;          // cars simulated at once
const SPAWN_INTERVAL = 1.1;  // seconds between spawn attempts
const SPAWN_MARGIN = 120;    // world units past the screen edge a car appears at
// Exported because obstacles.js has to place hazards BEYOND the traffic field —
// a car spawned inside one gets no road to steer around it (see that file's
// SPAWN_MARGIN, and test/invariants.test.js).
export const RETIRE_MARGIN = 320; // ...and how far past it before the car is dropped.
                             // Comfortably beyond SPAWN_MARGIN so a fresh car is
                             // never retired on the tick after it spawns.
const SPAWN_GAP = 150;       // min world-units of CLEAR ROAD between the boxes of
                             // two cars in the same lane at spawn time, so traffic
                             // never pops in on top of itself. Measured between
                             // box edges, not centres: the rig is 124 units long,
                             // and a centre-to-centre rule would let one appear
                             // half inside another
// Exported so the ACCEL / FOLLOW_REACTION / speed-band relation described below
// can be asserted rather than only documented (see test/invariants.test.js).
export const ACCEL = 340;    // world units/sec² traffic uses to reach targetSpeed.
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

// CRUISE DRIFT. Every car rolls its own speed at spawn, but that roll is made
// ONCE — so two cars of a type that happen to roll close together stay locked in
// formation for as long as they are both on screen, and the road reads as "every
// sedan drives the same speed" even though none of them do. Each car therefore
// also wanders slowly around its rolled speed, on its own phase and its own
// period, which lets pairs separate and re-converge instead of freezing.
//
// A one-time wider roll cannot do this: it varies cars against EACH OTHER, not
// over time. This is deliberately small and slow — it's the texture under the
// traffic, not a behaviour, and anything faster would read as indecision.
const DRIFT = 0.04;          // ± fraction of the car's own cruising speed
const DRIFT_PERIOD_MIN = 8;  // seconds for a full wander cycle...
const DRIFT_PERIOD_MAX = 12; // ...rolled per car, so the road never beats in unison

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
    this.cruiseSpeed = speed; // the speed it returns to after slowing for traffic,
                              // re-derived every tick from the three fields below
    this.baseSpeed = speed;   // the speed rolled at spawn — the centre of the wander
    this.driftPhase = Math.random() * Math.PI * 2; // where in its cycle it starts
    this.driftRate =
      (Math.PI * 2) /
      (DRIFT_PERIOD_MIN + Math.random() * (DRIFT_PERIOD_MAX - DRIFT_PERIOD_MIN));
    this.driftTime = 0;

    // Intent, written by the behaviour (see behaviours.js). Seeded with "keep
    // doing what you were spawned doing", so a car that never gets a decision
    // simply drives on.
    this.targetOffset = this.offset;
    this.targetSpeed = speed;

    // HOW THIS ONE DRIVES — the shared, frozen profile its type names
    // (game/driving.js). Everything behaviours.js used to hard-code reads off
    // here, so two cars running the same tactic can still be a timid driver and
    // an impatient one. Shared, never written to: a hundred sedans hold the same
    // object.
    this.drive = drivingFor(type);

    // How much hull THIS driver will eat rather than lift off its line — for a
    // road hazard (`nerve`) and for another car (`contact`). Rolled uniformly in
    // [0, the profile's figure] so the profile is a CEILING and each car is its
    // own gamble; see the NERVE section in driving.js. Rolled ONCE, like the
    // speed above: a barger is a barger for life, because a car that re-decided
    // every tick would weave at the roadblock instead of committing either way.
    this.nerve = Math.random() * this.drive.nerve;
    this.contact = Math.random() * this.drive.contact;

    // --- Behaviour state ------------------------------------------------------
    // Scratch space owned by whichever tactic drives this car (behaviours.js
    // says a behaviour may stash fields here), seeded in one place rather than
    // sprung into existence on first use.
    //
    // ALL OF IT, INCLUDING FIELDS THIS CAR'S OWN TACTIC WILL NEVER READ. Only
    // `heldTime` used to be declared; the rest appeared the first tick a car
    // committed to a pass or lost sight of the player, which meant a car's shape
    // changed mid-run and `trail` needed a `?? 0` to survive reading its own
    // timer. A car is cheap and there are seven of them: declare the lot, and
    // the list doubles as the register of what state the tactics actually keep.
    this.heldTime = 0;    // seconds stuck behind something it would rather be in
                          // front of — drives `patience` (startPass)
    this.passTarget = null; // the body being overtaken, while a pass is running
    this.passSide = 0;      // -1/+1, the side chosen for it
    this.passTime = 0;      // ...and its age, against `passTimeout`
    this.lostTime = 0;    // seconds since the player was last in firing range —
                          // drives `giveUpTime` (behaviours.js's `trail`)
    this.disengaged = false; // one-way: this car has given the player up for good

    // What this car is carrying, if anything — its own cooldowns and magazines,
    // so two interceptors do not share a trigger (game/armament.js). Null for
    // every civilian, which is what makes the arms code a no-op for most of the
    // road rather than something every behaviour has to guard.
    this.arms = armFor(type);

    this.health = type.health;
    this.maxHealth = type.health;
    this.alive = true;
    // A SEEKING round (weapons.js's ROCKET) may lock on to this. Opt-IN, and
    // set here rather than assumed by projectiles.js, because the player's
    // gunfire is resolved against one flat list of cars AND road obstacles
    // (main.js) — a rocket that turned across two lanes to chase a trestle
    // would be both useless and a betrayal of the shot the player took.
    this.seekable = true;
    this.exploded = false; // set when its wreck has been spawned (see Traffic.detonate),
                           // so a chain reaction can't set the same car off twice
    this.spikeTime = 0;  // seconds of punctured-tyre crawl left (see puncture)
    this.spikeSpeed = 0; // ...and the speed it is held down to while that runs
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

  // Cross a spike strip (obstacletypes.js's "spikes" effect): a scratch of
  // hull, and tyres that will not hold a cruising speed for `slowTime`.
  //
  // ALREADY-LIMPING CARS ARE NOT BITTEN AGAIN, and that single condition is
  // what makes this safe to call from a per-tick overlap test: a car sits on a
  // strip for several ticks, and without it the scratch would be taken sixty
  // times a second and the strip would be the deadliest thing in the game. It
  // also reads correctly on its own terms — a car already on its rims cannot
  // have its tyres punctured twice — and it still allows a SECOND strip to
  // bite once the first one's five seconds are up.
  puncture(type) {
    if (this.spikeTime > 0) return;
    this.spikeTime = type.slowTime;
    this.spikeSpeed = type.slowTo; // carried on the car, not looked up later —
                                   // the strip that bit it may be long gone
    this.damage(type.contactDamage);
  }

  update(dt, world) {
    // Wander first, so the behaviour decides against the speed this car actually
    // wants right now. CLAMPED to the type's own range: the catalogue documents
    // the speed band as a hard floor and ceiling (cartypes.js), and the drift is
    // texture, not licence to leave it.
    this.driftTime += dt;
    const wander = 1 + DRIFT * Math.sin(this.driftPhase + this.driftTime * this.driftRate);
    this.cruiseSpeed = Math.max(
      this.type.speedMin,
      Math.min(this.type.speedMax, this.baseSpeed * wander),
    );

    // Weapons recover BEFORE the behaviour decides, so a car that has just come
    // into range finds its gun as ready as it has earned by waiting, rather than
    // a tick behind.
    if (this.arms) this.arms.update(dt);

    // Tactic, then the hazard reflex, then whatever it is carrying — all three
    // in one call, so the order can't drift per tactic. See behaviours.js.
    driveCar(this, dt, world);

    // PUNCTURED TYRES OVERRULE THE BEHAVIOUR, and they are applied HERE — after
    // driveCar has asked for whatever its tactic wants, and after the speed
    // band was clamped at the top of this method — precisely because the band
    // is documented as "a hard floor and ceiling" (cartypes.js) that the drift
    // above is not allowed to leave. A crawl below `speedMin` is the one
    // deliberate exception to that, and it has to sit outside the clamp or it
    // would simply be clamped back up on the next tick and do nothing visible.
    //
    // It caps the REQUEST rather than the speed itself, so the car eases down
    // to its crawl through the same ACCEL ramp as any other speed change — a
    // car that snapped to 150 the instant it touched the strip would read as
    // hitting a wall, which is the mine's job, not this one.
    if (this.spikeTime > 0) {
      this.spikeTime -= dt;
      this.targetSpeed = Math.min(this.targetSpeed, this.spikeSpeed);
    }

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
  // `onDestroyed(car)` is called once for every car that blows up, at the moment
  // it detonates. A CALLBACK rather than a score object, because traffic has no
  // business knowing what a point is: main.js owns the scoreboard and decides
  // that a dead car is worth something (score.js). Chain-reaction kills come
  // through here exactly like direct ones — a kill is a kill, whoever lit it.
  //
  // `explosions` defaults to a private pool so `new Traffic()` still works
  // standalone (tests, the gallery), but main.js passes in the SAME pool it
  // hands to Obstacles — see effects.js's Explosions header and
  // game/obstacles.js: cars, mines and roadblocks are meant to share one pool
  // and one frame budget, not get one each.
  constructor(onDestroyed = null, explosions = new Explosions()) {
    this.onDestroyed = onDestroyed;
    this.cars = [];
    this.spawnTimer = 0;
    // The view handed to the car behaviours: main.js's world plus the car list.
    // Reused across ticks rather than rebuilt, since every car reads it.
    // `obstacles` starts empty rather than absent so the view's shape never
    // changes between ticks, and so a caller with no obstacle system at all
    // (the tests) still hands the behaviours something iterable.
    this.view = { player: null, distance: 0, W: 0, H: 0, cars: this.cars, obstacles: [] };

    // The player as something collisions.js can push around, plus the scratch
    // list of bodies handed to it. Both are reused rather than rebuilt per tick.
    this.playerBody = new PlayerBody(PLAYER_MASS, ROAD_HALF_WIDTH);
    this.bodies = [];

    // Wrecks (and, when the pool is shared, mine blasts and roadblock rubble
    // too). Owned here because traffic is what dies: a car's destruction and
    // its explosion are the same event, and keeping them together means main.js
    // never has to know that cars can blow up.
    this.explosions = explosions;
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
    // DEAD CARS DO NOT DRIVE. A car can already be dead when we're called: main.js
    // resolves bullets BEFORE traffic (so a kill scores in the frame it lands), and
    // the corpse is not dropped until retire() at the end of this tick. Letting it
    // take a step would move it a full tick past the spot the shot killed it at,
    // and detonate() below would then put the wreck there instead of where the car
    // actually died. The other half of that is in behaviours.js, which must not
    // brake for a corpse either.
    for (const car of this.cars) {
      if (car.alive) car.update(dt, this.view);
    }

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
      // Scored BEFORE the blast, so a chain reads in the order it happened: the
      // car that went first is credited first, then whatever it took with it.
      if (this.onDestroyed) this.onDestroyed(car);
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
    const type = this.pickType(distance);
    // Nothing in the catalogue is unlocked this early — see cartypes.js's
    // `minDistance`. Treated exactly like a full road: skip, try next interval.
    if (!type) return;

    const speed = type.speedMin + Math.random() * (type.speedMax - type.speedMin);

    const ahead = speed < player.speed;
    const worldY = ahead
      ? distance + player.y + SPAWN_MARGIN
      : distance - (H - player.y) - SPAWN_MARGIN;

    const lane = this.freeLane(worldY, type.w, type.h);
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
  // `distance` is passed straight through to the catalogue, which drops types the
  // player hasn't driven far enough to meet (cartypes.js's `minDistance`). The
  // share cap below then works on whatever is left, so the opening run spreads
  // itself across the civilian types instead of across all ten.
  pickType(distance) {
    const cap = Math.max(2, Math.floor(this.cars.length / 3));
    for (let attempt = 0; attempt < 4; attempt++) {
      const type = pickCarType(distance);
      if (!type) return null;
      const held = this.cars.reduce((n, car) => n + (car.type === type ? 1 : 0), 0);
      if (held < cap) return type;
    }
    return pickCarType(distance); // crowded road — take whatever came up
  }

  // A lane with nothing already sitting near `worldY`, or -1 if there is none.
  // `w`/`h` are the size of the car being placed, since the clearance wanted is
  // between the two BOXES, not their centres. Lanes are tried in random order so
  // traffic doesn't favour the left.
  //
  // ROAD HAZARDS COUNT TOO, and they matter more here than another car does.
  // The two spawn points very nearly coincide — traffic appears a SPAWN_MARGIN
  // past the screen edge and obstacles a slightly larger one (game/obstacles.js)
  // — so without this a car lands about twenty units short of a roadblock in the
  // same lane and is already inside it, with no road left to steer around it.
  // Avoidance (behaviours.js) cannot save a car that was never given any
  // warning, so the fix belongs at placement rather than in the driving.
  //
  // Hazards are tested by LATERAL OVERLAP against the lane's centre-line rather
  // than by a lane index, because most of them no longer have one: an obstacle
  // is placed by its type's `placement` (obstacletypes.js) and only one of the
  // four modes lands on a lane centre. A tetra straddling the centre-line is in
  // two lanes' way and in neither lane's index.
  freeLane(worldY, w, h) {
    const start = Math.floor(Math.random() * LANE_COUNT);
    for (let i = 0; i < LANE_COUNT; i++) {
      const lane = (start + i) % LANE_COUNT;
      const offset = laneOffset(lane);
      const near = (other, otherH) =>
        Math.abs(other.worldY - worldY) - (otherH + h) / 2 < SPAWN_GAP;

      if (this.cars.some((car) => car.lane === lane && near(car, car.h))) continue;
      const hazard = this.view.obstacles.some(
        (o) => o.alive && Math.abs(o.offset - offset) < (o.w + w) / 2 && near(o, o.h),
      );
      if (hazard) continue;
      return lane;
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
        accent: blink ? CRITICAL_FLASH : car.type.accent,
        w: car.type.w,
        h: car.type.h,
        wheelPhase: car.wheelPhase,
        // Point the car along the road at ITS OWN worldY, not the player's: the
        // heading swings by up to ~29° across a screen height, so a shared angle
        // would shear the whole column of traffic into a bend it isn't in yet.
        angle: headingAt(car.worldY),
      });
    }

    // Wrecks last, so a fireball is never drawn under the traffic still driving
    // through it. (The player is drawn after all of this — see main.js — so its
    // car stays readable inside a blast.)
    this.explosions.render(ctx, distance, playerY, W, H);
  }
}
