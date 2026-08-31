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
import { pickCarType, ENEMY_FACTION } from "./cartypes.js";
import { drivingFor } from "./driving.js";
import { armFor, BARRAGE } from "./armament.js";
import { Explosions, drawTargetMark, drawHullMeter } from "./effects.js";
import { resolveCollisions, PlayerBody, inBlastPlane } from "./collisions.js";
import { PLAYER_MASS } from "./player.js";
import { centerXAt, headingAt, laneOffset, laneAt, LANE_COUNT, ROAD_HALF_WIDTH } from "./road.js";
import { CRITICAL_FLASH } from "../engine/palette.js";

// Exported so game/events.js can scale it rather than keep a second figure —
// see setDensity(). It remains the AMBIENT baseline: staged cars are counted
// separately and are not bounded by it.
export const MAX_CARS = 7;   // cars simulated at once
const SPAWN_INTERVAL = 1.1;  // seconds between spawn attempts
// Exported alongside RETIRE_MARGIN below because game/events.js stages cars at
// the same two entry points the spawner uses — a gang has to arrive from off
// the screen edge like everything else, not materialise in view.
export const SPAWN_MARGIN = 120; // world units past the screen edge a car appears at
// Exported because obstacles.js has to place hazards BEYOND the traffic field —
// a car spawned inside one gets no road to steer around it (see that file's
// SPAWN_MARGIN, and test/combat.test.js).
export const RETIRE_MARGIN = 320; // ...and how far past it before the car is dropped.
                             // Comfortably beyond SPAWN_MARGIN so a fresh car is
                             // never retired on the tick after it spawns.
// ...AND THE SAME BOUNDARY FOR A STAGED CAR, which may sit further up the road
// than the ambient spawner would ever put one. AHEAD ONLY — behind, a staged car
// is dropped where any other car is.
//
// A SECOND NUMBER, BECAUSE RETIRE_MARGIN IS LOAD-BEARING OUTSIDE THIS FILE:
// obstacles.js sizes its own SPAWN_MARGIN as this plus the road the worst dodger
// in the catalogue needs to cross two lanes (1142 units, the rig), and
// test/hazards.test.js pins that. 1500 - 1142 leaves 358 units of headroom, so
// raising the ambient margin far enough for a second rank of cars (400) would
// silently break it, and would stretch every ambient car's life ahead of the
// player besides. Staged cars are already a separate budget (see `staged` and
// events.js's MAX_STAGED_CARS); this is the matching boundary.
//
// SIZED IN RANKS, which is what an encounter buys with it. A rank costs
// SPAWN_GAP plus a hull length — 216 for the 66-long bikes, 274 for two rigs —
// on top of the SPAWN_MARGIN the first rank enters at, with events.js keeping
// AHEAD_SLACK in hand so the last never arrives on the boundary:
//
//   2 ranks of bikes   120 + 216 + 60 = 396
//   3 ranks of bikes   120 + 432 + 60 = 612
//   2 ranks of rigs    120 + 274 + 60 = 454
//
// 620 is three ranks of bikes, or two of anything else. A fourth rank is a
// bigger number here and nothing else — but read events.js's arrivalSpeed note
// first: depth is bounded by whether a tactic REELS THE CAR IN, and a rank
// staged deeper than its tactic reaches is a rank the player never meets.
export const STAGED_RETIRE_MARGIN = 620;
// Exported for the same reason ACCEL below is: events.js sizes a staged rank as
// this plus a hull length, and test/events.test.js asserts that relation rather
// than restating the number in a second file.
export const SPAWN_GAP = 150; // min world-units of CLEAR ROAD between the boxes of
                             // two cars in the same lane at spawn time, so traffic
                             // never pops in on top of itself. Measured between
                             // box edges, not centres: the rig is 124 units long,
                             // and a centre-to-centre rule would let one appear
                             // half inside another
// Exported so the ACCEL / FOLLOW_REACTION / speed-band relation described below
// can be asserted rather than only documented (see test/combat.test.js).
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

// The fractions the boss's hull meter is notched at (effects.js's drawHullMeter)
// — armament.js's own barrage thresholds, DERIVED rather than restated. Two
// copies of 0.66 that could drift apart would make the notch a lie, and an
// instrument that lies is worse than none. Built once at module load, since the
// table is frozen data and the meter is drawn every frame.
const METER_MARKS = BARRAGE.map((p) => p.above).filter((f) => f > 0);

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

    // Placed by game/events.js as part of a staged encounter, rather than by
    // the ambient spawner below. Same flag shape RoadObstacle.laid already
    // uses, and for the same reason: two budgets that must not be pooled. A
    // five-strong gang counted against MAX_CARS would empty the rest of the
    // road to make room, which is the opposite of what an encounter is for.
    // Declared here with the rest rather than sprung into existence in
    // place(), per the "declare the lot" note above.
    this.staged = false;

    this.health = type.health;
    this.maxHealth = type.health;
    this.alive = true;
    // A SEEKING round (weapons.js's ROCKET) may lock on to this. Opt-IN, and
    // set here rather than assumed by projectiles.js, because the player's
    // gunfire is resolved against one flat list of cars AND road obstacles
    // (main.js) — a rocket that turned across two lanes to chase a trestle
    // would be both useless and a betrayal of the shot the player took.
    this.seekable = true;
    // ...AND HOW HIGH IT IS FLYING, in the one form projectiles.js can use: a
    // body that is off the road plane entirely, which only a SEEKING round may
    // reach (see that file's firstHit). Mirrored onto the body from the type
    // for the same reason `seekable` is a body field rather than a type lookup
    // — the player's gunfire runs against one flat list of cars AND road
    // obstacles (main.js), and an obstacle has no `type.airborne` to ask about.
    // Every body in that list answers the same two questions the same way.
    this.airborne = !!type.airborne;
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
  //
  // NOT FOR AN AIRBORNE CAR (cartypes.js), and the check is HERE rather than at
  // the two call sites for a reason worth the line: the road's width is a fact
  // about the tarmac, and a car that is not on the tarmac is not held to it. Put
  // at the callers instead, this was silently wrong — the gunship's whole
  // character is a sweep that leaves the road and comes back, and the clamp
  // inside update() quietly held it to 108px of a 150px sweep. It looked like a
  // tuning problem and was not one. One guard, in the one place the road's width
  // is applied, cannot be half-added.
  //
  // Its own lateral bound is the FRAME, and it lives where the sweep is decided
  // (behaviours.js's `patrol` and FLIGHT_MARGIN) — a limit that keeps a thing
  // on screen belongs with the tactic that aims it, not with the road.
  clampToRoad() {
    if (this.type.airborne) return;
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

    // AMBIENT DENSITY, as a multiplier on MAX_CARS rather than a replacement
    // for it — game/events.js turns this down while an encounter is live (a
    // boss gets an empty road, a gang gets a thinned one) and back to 1 when it
    // ends. MAX_CARS stays the BASELINE the multiplier is read against, so it
    // still means what it says and the tuning editor still edits the one number
    // it always did.
    //
    // A cap of zero DESTROYS NOTHING. The spawner simply stops replacing what
    // retires, so the road drains over the next few seconds as traffic falls
    // off the screen behind — which is a warning the player watches happen,
    // where six cars blinking out of existence would read as a fault.
    this.density = 1;
  }

  // See `density` above. Clamped at zero because a negative cap is a caller
  // bug that would otherwise read as "no traffic" and hide itself.
  setDensity(mul) {
    this.density = Math.max(0, mul);
  }

  // Live cars the AMBIENT spawner is responsible for — staged ones are somebody
  // else's budget (see TrafficCar's `staged`).
  ambientCount() {
    return this.cars.reduce((n, car) => n + (car.alive && !car.staged ? 1 : 0), 0);
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
      // The cap the AMBIENT road is held to, scaled by whatever encounter is
      // running (see setDensity) and counting only the cars this spawner put
      // here. A staged gang neither fills this budget nor is thinned by it.
      const cap = Math.round(MAX_CARS * this.density);
      if (this.ambientCount() < cap) this.spawn(world);
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
    // AN AIRBORNE CAR IS NOT A BODY (cartypes.js's `airborne`). It is drawn
    // flying, with the whole road drawn passing underneath it (see render), and
    // handing it to a solver that resolves overlaps in flat road coordinates
    // would let the player ram something that is not down here — the one thing
    // that would flatly contradict the artwork. Kept out of the list rather
    // than given a huge mass: mass makes a thing hard to shove, absence makes
    // it unreachable, and unreachable is what altitude means.
    //
    // ...AND IT IS NOT PUT BACK ON THE ROAD BELOW EITHER, for the same reason —
    // but that half is clampToRoad's own business rather than this loop's, so it
    // is stated once there and nothing here has to remember it.
    for (const car of this.cars) if (!car.type.airborne) this.bodies.push(car);
    resolveCollisions(this.bodies, dt);
    // The solver doesn't know where the road is; put anything it pushed over an
    // edge back on the tarmac. (The player clamps itself — see PlayerBody.)
    for (const car of this.cars) car.clampToRoad();
  }

  // Phase 8 step 4's "dread_pulse" query — the nearest ENEMY_FACTION car
  // behind the player, and whether it is gaining, so audio/sustainedfx.js can
  // turn that into a threat level. Lives HERE, not in the audio layer,
  // because traffic.js is what owns the cars and their factions — the audio
  // side only ever sees a plain {gap, closing} pair (or null), never a car
  // reference, exactly the way main.js already hands hull fraction rather
  // than a Player instance to updateHullHiss. See main.js's own call site for
  // where this is turned into sound.
  //
  // "BEHIND" is worldY less than the player's own, and `gap` is written the
  // same sign every other chase in this codebase uses (behaviours.js's
  // `trail`/`pursue`: `target.worldY - car.worldY`, positive while the car
  // trails its target) — positive while the hostile is behind the player.
  // "CLOSING" is the instantaneous car.speed > player.speed comparison, the
  // same test followSpeed's own `closing` term is built from — a hostile
  // merely holding pace or falling back is not gaining on the player,
  // whatever the gap between them.
  tailThreat() {
    const player = this.playerBody;
    let best = null;
    let bestGap = Infinity;
    for (const car of this.cars) {
      if (!car.alive || car.type.faction !== ENEMY_FACTION) continue;
      const gap = player.worldY - car.worldY;
      if (gap <= 0 || gap >= bestGap) continue;
      bestGap = gap;
      best = car;
    }
    if (!best) return null;
    return { gap: bestGap, closing: best.speed > player.speed };
  }

  // What the tracer's trigger designates (game/targeting.js, weapons.js's
  // AUTOLOCK) — ONE hostile ahead of the player, drawn at random, or null when
  // there is nothing up the road worth locking. Lives here for the reason
  // tailThreat above does: traffic owns the cars and their factions, and the
  // caller only ever gets back the one car it asked for.
  //
  // HOSTILES ONLY. A lock the player did not aim must never land on a civilian
  // — it would bend a burst away from the thing shooting at them and toward
  // somebody merely in the way, which is the exact opposite of what the upgrade
  // is for. `seekable` is checked on top of the faction for the same reason
  // projectiles.js's seek() checks it: anything added to the road later says
  // for itself whether it can be locked on.
  //
  // AND NOT THE AIR. An `airborne` car is unreachable by everything except a
  // seeking round (projectiles.js's firstHit) — designating the gunship would
  // hand the tracer the one target the rocket is supposed to be the answer to,
  // by way of the seeking steer a locked round borrows.
  //
  // RANDOM, BY RESERVOIR — one pass, no array, each candidate equally likely.
  // Nearest-first was the obvious alternative and is worse: the nearest hostile
  // is usually the one already in the player's lane, which is the shot they did
  // not need help taking. Random is what makes the trigger reach across the
  // road.
  randomHostileAhead(range) {
    const player = this.playerBody;
    if (!player || !(range > 0)) return null;
    let chosen = null;
    let seen = 0;
    for (const car of this.cars) {
      if (!car.alive || !car.seekable) continue;
      if (car.type.faction !== ENEMY_FACTION || car.type.airborne) continue;
      const ahead = car.worldY - player.worldY;
      if (ahead <= 0 || ahead > range) continue;
      seen += 1;
      if (Math.random() * seen < 1) chosen = car;
    }
    return chosen;
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
      // Nothing at road level reaches the air — see collisions.js's inBlastPlane.
      if (!inBlastPlane(body)) return;
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
    const top = distance + player.y;
    const ahead = top + RETIRE_MARGIN;
    const stagedAhead = top + STAGED_RETIRE_MARGIN;
    const behind = distance - (H - player.y) - RETIRE_MARGIN;
    this.cars = this.cars.filter(
      (car) =>
        car.alive &&
        car.worldY < (car.staged ? stagedAhead : ahead) &&
        car.worldY > behind,
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

    this.place(type, worldY, lane, speed);
  }

  // PUT ONE CAR ON THE ROAD, wherever the caller says. Extracted from spawn()
  // above rather than written beside it, because game/events.js stages whole
  // formations and must go through the SAME path the ambient road does — a
  // director pushing into `this.cars` itself would be the one thing on the
  // highway that had skipped the clearance check below (see cartypes.js's FOCUS
  // note on why a staged road still has to be a road the real spawner built).
  //
  // `staged` marks the car as somebody else's budget — see TrafficCar's own
  // field and ambientCount() above.
  //
  // Returns the car, or null when the lane is not clear at `worldY`. A refusal
  // is a normal outcome, not an error: an encounter that gets three of its five
  // cycles down because the road was busy is a smaller gang, not a failed one.
  place(type, worldY, lane, speed, staged = false) {
    if (!this.laneClear(lane, worldY, type.w, type.h)) return null;
    const car = new TrafficCar(type, worldY, lane, speed);
    car.staged = staged;
    this.cars.push(car);
    return car;
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
      if (this.laneClear(lane, worldY, w, h)) return lane;
    }
    return -1;
  }

  // The clearance test for ONE lane, split out of the search above so place()
  // can ask it about a lane the caller chose. Same question either way: is
  // there room here for a box `w` x `h`?
  laneClear(lane, worldY, w, h) {
    const offset = laneOffset(lane);
    const near = (other, otherH) =>
      Math.abs(other.worldY - worldY) - (otherH + h) / 2 < SPAWN_GAP;

    if (this.cars.some((car) => car.lane === lane && near(car, car.h))) return false;
    const hazard = this.view.obstacles.some(
      (o) => o.alive && Math.abs(o.offset - offset) < (o.w + w) / 2 && near(o, o.h),
    );
    return !hazard;
  }

  // `alpha` is the loop's interpolation fraction (see engine/loop.js). Only the
  // lateral offset is interpolated: screen y comes from the raw `worldY` and the
  // raw `distance`, exactly as the road and city are drawn, so traffic stays
  // welded to the tarmac instead of sliding against it a fraction of a step.
  // `lock` is the player's target lock (game/targeting.js), or null — READ
  // ONLY, and only to put a reticle on the one car it names. Passed in rather
  // than held, because exactly one car can be locked and a reference cannot
  // disagree with itself the way a flag copied onto every car could; and
  // because traffic has no more business owning the player's targeting system
  // than it has owning the scoreboard.
  //
  // TWO PASSES, BECAUSE THE ROAD IS NOT THE ONLY PLANE ANY MORE. This one draws
  // everything ON the road; renderAir below draws what is above it, and main.js
  // puts the bullets and the player's own car between the two. That ORDER is
  // what makes altitude legible, and it is the whole answer to the question a
  // player asks the first time they meet a gunship: my rounds are going right
  // at it, why is nothing happening?
  //
  // Drawn OVER the drone, a tracer reads as passing through it and the game
  // looks broken. Drawn UNDER it, the same tracer reads as passing beneath it,
  // which is exactly what is happening and needs no explaining at all. The
  // hauler already draws in that band for the same reason (main.js).
  render(ctx, distance, playerY, W, H, alpha, lock = null) {
    this.drawCars(ctx, distance, playerY, W, H, alpha, lock, false);
    // Wrecks last, so a fireball is never drawn under the traffic still driving
    // through it. (The player is drawn after all of this — see main.js — so its
    // car stays readable inside a blast.)
    //
    // IN THE ROAD PLANE, including an airborne car's own wreck. That is a
    // deliberate small inaccuracy rather than an oversight: the pool is shared
    // by every explosion in the game and splitting it in two to move one
    // fireball would cost more than it buys. A gunship dies at the top of the
    // screen and the player sits at 62% down it, so the two almost never
    // overlap in the first place.
    this.explosions.render(ctx, distance, playerY, W, H);
  }

  // Everything ABOVE the road. Called by main.js after the bullets and the
  // player — see render() above for why that order is the point.
  renderAir(ctx, distance, playerY, W, H, alpha, lock = null) {
    this.drawCars(ctx, distance, playerY, W, H, alpha, lock, true);
  }

  // One pass over the cars in one plane. `air` picks which.
  drawCars(ctx, distance, playerY, W, H, alpha, lock, air) {
    for (const car of this.cars) {
      if (!!car.type.airborne !== air) continue;
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

      // ...and the reticle, OVER the car it belongs to but under the wrecks
      // below, for the car the player's tracer fire is locked onto
      // (game/targeting.js, weapons.js's AUTOLOCK). Drawn off the lock's own
      // remaining time, which is what makes the brackets pulse faster as the
      // designation runs out — see effects.js's drawTargetMark.
      if (lock && car === lock.car) {
        drawTargetMark(ctx, sx, sy, car.type.w, car.type.h, lock.time);
      }

      // ...and the hull meter, for the one type that asks for one (the boss —
      // cartypes.js's `hullMeter`). Drawn in the SAME place and off the SAME
      // (sx, sy) as the reticle above, for the same reason: it is an overlay on
      // one specific car, and the car has just been drawn.
      //
      // NOT ON A WRECK. `critical` blinking is fine on a car that is about to
      // die, but a meter on one that already has would be an instrument
      // reporting on nothing — traffic keeps a dead car in the list for the
      // tick its explosion is spawned in (see detonate), so this needs saying.
      if (car.type.hullMeter && car.alive) {
        drawHullMeter(ctx, sx, sy, car.type.h, car.health / car.type.health, METER_MARKS);
      }
    }
  }
}
