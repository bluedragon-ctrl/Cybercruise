// Part of the cross-file invariant suite — see test/README-invariants.md for
// what these assert and why they are not unit tests of behaviour.
//
// Road obstacles and their placement, driving profiles, enemy armament, exotic rounds and pickups.
//
// Everything imported here is DOM-free at module scope, so the game's real
// modules load under plain Node.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { CAR_TYPES, typeAvailable } from "../src/game/cartypes.js";
import { carShapeExtent } from "../src/game/carshapes.js";
import { RETIRE_MARGIN as TRAFFIC_RETIRE_MARGIN, Traffic } from "../src/game/traffic.js";
import { driveCar, dodgeDistance, TACTIC_NAMES, TRAIL_ENGAGE } from "../src/game/behaviours.js";
import { DRIVING_PROFILES, drivingFor, typesDriving } from "../src/game/driving.js";
import { BAND_RECOVER, MIN_SPEED, PLAYER_MASS, Player } from "../src/game/player.js";
import { initInput } from "../src/engine/input.js";
import {
  LANE_COUNT,
  LANE_WIDTH,
  ROAD_HALF_WIDTH,
  laneOffset,
  centerXAt,
  DIST_UNITS,
} from "../src/game/road.js";
import { OBSTACLE_SHAPES } from "../src/game/obstacleshapes.js";
import { resolveCollisions, impactCost, ramSpeed, SIDE_DAMAGE } from "../src/game/collisions.js";
import { Loadout, Weapon, WEAPON_TYPES, ENEMY_WEAPON_TYPES } from "../src/game/weapons.js";
import {
  OBSTACLE_TYPES,
  obstacleTypeById,
  pickObstacleType,
  PLACE_LANE,
  PLACE_SIDE,
} from "../src/game/obstacletypes.js";
import { Obstacles, SPAWN_MARGIN as OBSTACLE_SPAWN_MARGIN } from "../src/game/obstacles.js";
import { Explosions } from "../src/game/effects.js";
import { Projectiles } from "../src/game/projectiles.js";
import {
  armFor, armamentFor, BARRAGE, barragePhase, GUN_RANGE, GUN_MIN_RANGE,
} from "../src/game/armament.js";
import { Shells } from "../src/game/shells.js";
import { NEUTRAL_PALE, PLAYER } from "../src/engine/palette.js";
import { PICKUP_SHAPES } from "../src/game/pickupshapes.js";
import {
  PICKUP_TYPES,
  AMMO,
  HEAL,
  SHIELD,
  BOOST,
  applyPickup,
  pickupTypeById,
} from "../src/game/pickuptypes.js";
import { Pickups } from "../src/game/pickups.js";
import { driver, COMMUTER, slowest, fastest } from "../test-support/fixtures.js";

// --- Road obstacles -----------------------------------------------------------

test("every obstacle type carries coherent, positive gameplay numbers", () => {
  for (const t of OBSTACLE_TYPES) {
    assert.ok(t.health > 0, `${t.id}: health must be positive`);
    // WEIGHT IS A SPAWN FREQUENCY, so only a spawnable type needs one. A
    // laidOnly hazard must carry NO weight rather than an unread one — a
    // number the spawner never reads is a number that will eventually be
    // believed by somebody.
    if (t.laidOnly) {
      assert.equal(t.weight, 0, `${t.id}: a laid-only hazard must carry no spawn weight`);
    } else {
      assert.ok(t.weight > 0, `${t.id}: weight must be positive`);
    }
    assert.ok(t.blastRadius >= 0, `${t.id}: blastRadius must not be negative`);
    assert.ok(t.blastDamage >= 0, `${t.id}: blastDamage must not be negative`);
  }
});

test("the spike strip takes speed, not hull — and the mine is still the killer", () => {
  // obstacletypes.js: "the moment a strip does enough damage to be worth
  // laying FOR the damage, the player will simply lay whichever of the two
  // kills faster and the pair collapses into one weapon."
  const spikes = OBSTACLE_TYPES.find((t) => t.id === "spikes");
  const mine = OBSTACLE_TYPES.find((t) => t.id === "caltrop");
  const lightest = Math.min(...CAR_TYPES.map((t) => t.health));

  assert.ok(
    spikes.contactDamage < lightest,
    `a strip's ${spikes.contactDamage} can kill the lightest car outright (${lightest} hull)`,
  );
  assert.ok(spikes.contactDamage < mine.blastDamage, "a strip must not out-hit the mine");
  assert.equal(spikes.blastRadius, 0, "a strip must not explode — it stays on the road");

  // The crawl has to be a real one for EVERY type, not just the heavy ones.
  const slowest = Math.min(...CAR_TYPES.map((t) => t.speedMin));
  assert.ok(
    spikes.slowTo < slowest,
    `a strip's ${spikes.slowTo} is not below the slowest cruise on the road (${slowest})`,
  );
});

test("the spike strip is wide enough to go around and narrow enough to leave a road", () => {
  // obstacleshapes.js: it cannot be threaded, only gone around — but "anything
  // past ~3 lanes here would make a single drop unavoidable".
  const spikes = OBSTACLE_TYPES.find((t) => t.id === "spikes");
  const mine = OBSTACLE_TYPES.find((t) => t.id === "caltrop");
  const stripW = OBSTACLE_SHAPES[spikes.shape].size[0];
  const mineW = OBSTACLE_SHAPES[mine.shape].size[0];
  const widestCar = Math.max(...CAR_TYPES.map((t) => t.w));

  assert.ok(stripW > mineW * 3, "the strip must not read as a wider mine");
  assert.ok(
    stripW > LANE_WIDTH * 2,
    `a strip ${stripW} wide does not span the two lanes that make it un-threadable`,
  );
  // Laid hard against one barrier — the worst case — there must still be room
  // for the widest thing on the road to pass on the other side.
  assert.ok(
    ROAD_HALF_WIDTH * 2 - stripW > widestCar,
    `a strip laid at the edge leaves ${ROAD_HALF_WIDTH * 2 - stripW}, too little for a ${widestCar}-wide car`,
  );
});

// One live car on an otherwise empty road, driven through its own update() so
// the speed band clamp and driveCar both really run — which is the whole point
// of the puncture tests below, since the crawl is defined as the one thing
// allowed to sit outside that clamp.
function lonePuncturedCar() {
  const traffic = new Traffic();
  const player = new Player(300, 496);
  traffic.spawn({ distance: 0, player, H: 800 });
  const car = traffic.cars[0];
  assert.ok(car, "expected spawn to put a car on the road");
  return { car, world: { cars: traffic.cars, obstacles: [], playerBody: null } };
}

test("a car crossing a strip is punctured once, not once per tick", () => {
  // traffic.js's puncture(): a car sits on a strip for many ticks, and the
  // scratch being taken sixty times a second would make the gentlest hazard in
  // the game the deadliest.
  const spikes = OBSTACLE_TYPES.find((t) => t.id === "spikes");
  const { car } = lonePuncturedCar();
  const before = car.health;

  for (let i = 0; i < 60; i++) car.puncture(spikes);

  assert.equal(before - car.health, spikes.contactDamage, "the strip bit more than once");
  assert.equal(car.spikeTime, spikes.slowTime);
});

test("a punctured car is held below its own speed band, then recovers", () => {
  // traffic.js: the crawl is the ONE deliberate exception to cartypes.js's
  // "hard floor and ceiling", which is why it is applied after the clamp.
  const spikes = OBSTACLE_TYPES.find((t) => t.id === "spikes");
  const { car, world } = lonePuncturedCar();
  assert.ok(
    car.type.speedMin > spikes.slowTo,
    "the test is meaningless unless the crawl is below this car's own floor",
  );

  car.puncture(spikes);
  for (let i = 0; i < 60 * 4; i++) car.update(1 / 60, world);
  assert.ok(
    car.speed <= spikes.slowTo + 1,
    `a punctured car settled at ${car.speed}, above its ${spikes.slowTo} crawl`,
  );

  // ...and once the puncture has run out it climbs back into its own band.
  for (let i = 0; i < 60 * 8; i++) car.update(1 / 60, world);
  assert.ok(
    car.speed >= car.type.speedMin,
    `the puncture never wore off — the car is still at ${car.speed}, below its own floor`,
  );
});

test("the strip is feared out of proportion to what it costs", () => {
  // obstacles.js's `threat` and obstacletypes.js's own note: if the AI weighed
  // the strip's 6 damage it would drive straight over every one, which makes
  // it a guaranteed hit and a worse weapon — the interesting thing a strip
  // does is make traffic swerve.
  const spikes = OBSTACLE_TYPES.find((t) => t.id === "spikes");
  const mine = OBSTACLE_TYPES.find((t) => t.id === "caltrop");
  assert.ok(
    spikes.threat > spikes.contactDamage * 3,
    "a strip that reads as harmless to the AI is a strip nothing ever swerves for",
  );
  assert.ok(
    spikes.threat < mine.blastDamage,
    "...but it must still be the mine that empties a lane fastest",
  );
});

test("a laid hazard is never left hanging over a barrier", () => {
  // obstacles.js's drop(): "wherever that car was" says which LANE, not that a
  // hazard may be drawn through the wall. Only bites on the wide ones — a mine
  // laid at the edge was always inside the limit, which is why this went
  // unnoticed until the spike strip.
  const obstacles = new Obstacles(new Explosions());
  for (const type of OBSTACLE_TYPES) {
    const w = OBSTACLE_SHAPES[type.shape].size[0];
    for (const edge of [-ROAD_HALF_WIDTH, ROAD_HALF_WIDTH]) {
      obstacles.list.length = 0;
      // A car pinned against the barrier — the worst case a drop can be given.
      assert.ok(obstacles.drop(type, { worldY: 0, offset: edge, h: 60 }));
      const o = obstacles.list[0];
      assert.ok(
        Math.abs(o.offset) + w / 2 <= ROAD_HALF_WIDTH + 1e-9,
        `${type.id} laid at ${edge} reaches ${Math.abs(o.offset) + w / 2}, past the road's ${ROAD_HALF_WIDTH}`,
      );
    }
  }
});

test("a laid-only hazard never turns up on the road by itself", () => {
  // obstacletypes.js: a spike strip is somebody's deliberate act, and one
  // appearing ahead of the player would read as the city trapping its own
  // traffic. Rolled hard rather than reasoned about, because the failure mode
  // is a rare roll rather than a wrong branch.
  const laidOnly = OBSTACLE_TYPES.filter((t) => t.laidOnly);
  assert.ok(laidOnly.length, "expected at least one laid-only hazard in the catalogue");
  for (let i = 0; i < 2000; i++) {
    const picked = pickObstacleType(Infinity);
    assert.ok(!picked?.laidOnly, `the spawner rolled ${picked?.id}, which is laid-only`);
  }
});

test("the mine carries the minimum health in the catalogue, as obstacletypes.js claims", () => {
  // obstacletypes.js: "a mine takes exactly ONE hit, gunfire or contact, same
  // as a car at zero hull" — the catalogue backs that up with the number, not
  // just the comment.
  const mine = OBSTACLE_TYPES.find((t) => t.id === "caltrop");
  const minHealth = Math.min(...OBSTACLE_TYPES.map((t) => t.health));
  assert.equal(mine.health, minHealth);
  assert.equal(mine.health, 1);
});

// A minimal world: a stationary player at the origin, no traffic. Obstacles
// only need `player`, `distance`, `W`, `H` and (optionally) `cars`. The
// catalogue is free to gate every type behind a minDistance (see "obstacle
// gating uses the same units as the car catalogue" above), so `distance: 0`
// is not guaranteed to have anything available — this sits past every type's
// gate instead, mirroring the CAR_TYPES "far" idiom used for the same reason.
const OBSTACLE_GATE_CLEAR = Math.max(...OBSTACLE_TYPES.map((t) => t.minDistance ?? 0)) * DIST_UNITS;
function obstacleWorld() {
  const player = new Player(300, 496);
  return { player, distance: OBSTACLE_GATE_CLEAR, W: 600, H: 800, cars: [] };
}

test("a ram destroys an obstacle outright, even at full health", () => {
  // game/obstacles.js: contact ignores `health` entirely — the road only ever
  // gives the player one pass at a static object, so partial damage surviving
  // a hit that cannot be repeated would be a number nobody ever sees move.
  const obstacles = new Obstacles(new Explosions());
  const world = obstacleWorld();
  obstacles.spawn(world);
  const o = obstacles.list[0];
  assert.ok(o, "expected spawn to place an obstacle");
  assert.equal(o.health, o.type.health, "should start at full health");

  // Drive the player exactly onto it.
  world.distance = o.worldY;
  world.player.x = centerXAt(o.worldY, world.W) + o.offset;
  obstacles.update(1 / 60, world);

  assert.ok(!obstacles.list.includes(o), "a full-health obstacle must still be destroyed by contact");
});

test("hitting a heavier obstacle costs far more speed than a light one", () => {
  // obstacletypes.js's `mass`: a trestle is barely felt, a tetra costs nearly
  // as much as parking a rig in the way. Uses obstacles.drop() to place a
  // specific type deterministically rather than relying on spawn()'s random
  // pick.
  const trestle = obstacleTypeById("trestle");
  const tetra = obstacleTypeById("tetra");
  const startSpeed = 300;

  function speedAfterHit(type) {
    const obstacles = new Obstacles(new Explosions());
    const world = obstacleWorld();
    world.player.speed = startSpeed;
    obstacles.drop(type, { worldY: world.distance, offset: 0, h: 0 });
    const o = obstacles.list[0];
    world.distance = o.worldY;
    world.player.x = centerXAt(o.worldY, world.W) + o.offset;
    obstacles.update(1 / 60, world);
    return world.player.speed;
  }

  const afterTrestle = speedAfterHit(trestle);
  const afterTetra = speedAfterHit(tetra);

  assert.ok(afterTrestle < startSpeed, "even a light hazard should cost some speed");
  assert.ok(afterTetra < afterTrestle, "the tetra must cost far more speed than the trestle");
  assert.equal(afterTrestle, ramSpeed(startSpeed, PLAYER_MASS, trestle.mass));
  assert.equal(afterTetra, ramSpeed(startSpeed, PLAYER_MASS, tetra.mass));
});

test("hitting an obstacle also costs a traffic car speed, not just the player", () => {
  // The contact loop in game/obstacles.js treats any live car the same as the
  // player — which is what lets a car SHOVED into a hazard (collisions.js's
  // sideSwipe) pay for it exactly as if it had driven there itself.
  const trestle = obstacleTypeById("trestle");
  const obstacles = new Obstacles(new Explosions());
  const traffic = new Traffic();
  const world = obstacleWorld();
  traffic.spawn(world);
  const car = traffic.cars[0];
  assert.ok(car, "expected spawn to place a car");

  const startSpeed = 300;
  car.speed = startSpeed;
  obstacles.drop(trestle, { worldY: world.distance, offset: 0, h: 0 });
  const o = obstacles.list[0];
  car.worldY = o.worldY;
  car.offset = o.offset;
  world.cars = traffic.cars;

  obstacles.update(1 / 60, world);

  assert.equal(car.speed, ramSpeed(startSpeed, car.mass, trestle.mass));
});

test("gunfire spends an obstacle's health instead of destroying it outright", () => {
  const obstacles = new Obstacles(new Explosions());
  const world = obstacleWorld();
  obstacles.spawn(world);
  const o = obstacles.list[0];

  o.damage(o.health / 2);
  assert.ok(o.alive, "half its health should leave the obstacle standing");

  o.damage(o.health); // more than enough to finish it off
  assert.ok(!o.alive, "spending the rest of its health must destroy it");
});

test("destroying an obstacle spawns its destruction effect exactly once", () => {
  const explosions = new Explosions();
  const obstacles = new Obstacles(explosions);
  const world = obstacleWorld();
  obstacles.spawn(world);
  const o = obstacles.list[0];

  o.damage(o.health);
  obstacles.update(1 / 60, world);

  const alive = explosions.slots.filter((s) => s.alive);
  assert.equal(alive.length, 1, "exactly one effect should have been spawned");
  assert.ok(!obstacles.list.includes(o), "the destroyed obstacle should have been retired");
});

test("hazards are placed beyond the traffic field, with room left to dodge", () => {
  // The relation obstacles.js's SPAWN_MARGIN is sized by, spanning three files:
  // a hazard must appear past the furthest live car (traffic.js's RETIRE_MARGIN)
  // AND leave the worst dodger in the catalogue enough road to get clear
  // (behaviours.js's dodgeDistance). Break it and hazards land in the middle of
  // the traffic field, where the cars nearest the spawn point cannot avoid them
  // however well they drive — which measured as the road clearing 88% of its own
  // obstacles before the player ever reached one.
  const worst = Math.max(...CAR_TYPES.map((t) => dodgeDistance(t.speedMax, t.steerSpeed)));
  const needed = TRAFFIC_RETIRE_MARGIN + worst;
  assert.ok(
    OBSTACLE_SPAWN_MARGIN >= needed,
    `obstacle SPAWN_MARGIN is ${OBSTACLE_SPAWN_MARGIN} but needs to be at least ` +
      `${Math.ceil(needed)} (traffic RETIRE_MARGIN ${TRAFFIC_RETIRE_MARGIN} + ` +
      `${Math.ceil(worst)} units for the slowest-steering type to cross two lanes)`,
  );
});

test("no driver has the nerve to run onto a mine", () => {
  // driving.js's NERVE section: no profile's ceiling reaches the tetra's damage,
  // and therefore none reaches the mine's. That keeps mines the PLAYER'S
  // problem rather than something the road sweeps up for them, and it avoids
  // score.js fining the player for a civilian a mine killed unaided.
  const boldest = Math.max(...Object.values(DRIVING_PROFILES).map((p) => p.nerve));
  const mine = OBSTACLE_TYPES.find((t) => t.id === "caltrop");
  const tetra = OBSTACLE_TYPES.find((t) => t.id === "tetra");
  assert.ok(
    boldest < tetra.blastDamage,
    `the boldest nerve (${boldest}) now reaches the tetra's ${tetra.blastDamage} hit`,
  );
  assert.ok(
    boldest < mine.blastDamage,
    `the boldest nerve (${boldest}) now reaches the mine's ${mine.blastDamage} hit — ` +
      `traffic would start clearing mines off the road for the player`,
  );
});

test("the amber civilians always dodge, and at least one hostile gambles", () => {
  // The shape of the dial, not its exact settings. Every civilian shares ONE
  // base chassis colour now (cartypes.js), so the dodge/gamble tell has moved
  // to `accent` instead: a civilian with no accent is "amber" and must always
  // dodge, and the roadster's PALE accent is what buys it the room to shoulder
  // through a stack of barrels without muddying that signal for the rest of the
  // traffic — see driving.js's NERVE section.
  const civilians = CAR_TYPES.filter((t) => t.value < 0);
  const amber = civilians.filter((t) => (t.accent ?? t.color) !== NEUTRAL_PALE);
  assert.ok(amber.length > 0, "the signal needs someone to carry it");
  for (const t of amber) {
    assert.equal(drivingFor(t).nerve, 0, `${t.id}: amber civilians must always dodge`);
  }
  const trestle = OBSTACLE_TYPES.find((t) => t.id === "trestle");
  const gamblers = CAR_TYPES.filter((t) => drivingFor(t).nerve > trestle.blastDamage);
  assert.ok(gamblers.length > 0, "no hostile type can ever barge a trestle");
});

test("a nerve setting is either zero or bold enough to do something", () => {
  // The dial is QUANTISED by the obstacle catalogue: nerve is compared against a
  // hazard's blastDamage, so anything between 0 and the cheapest hazard behaves
  // exactly like 0. There is no "slightly bolder", and a profile sitting in that
  // dead band is a tuning attempt that silently did nothing.
  const cheapest = Math.min(...OBSTACLE_TYPES.map((t) => t.blastDamage));
  for (const [name, p] of Object.entries(DRIVING_PROFILES)) {
    assert.ok(
      p.nerve === 0 || p.nerve > cheapest,
      `profile "${name}" has nerve ${p.nerve}, which is under the cheapest hazard ` +
        `(${cheapest} hull) and therefore identical to nerve 0`,
    );
  }
});

// The cheapest lane change `type` could ever make: behaviours.js prices one as a
// side-swipe at the car's own steering rate, so the only thing left to vary is
// who it swipes, and the lightest neighbour is the cheapest. Below this figure a
// `contact` ceiling cannot buy the type anything at all.
function cheapestContact(type) {
  return Math.min(
    ...CAR_TYPES.map((other) => impactCost(type, other, type.steerSpeed, SIDE_DAMAGE)),
  );
}

test("a contact ceiling is either zero or bold enough to do something", () => {
  // The same trap as the nerve test above, sprung by different arithmetic.
  // `contact` is compared against a cost that scales with the car's own
  // steerSpeed, so what counts as a bold number is a property of the TYPE, not
  // of the dial — and a ceiling under the cheapest contact its drivers can even
  // be offered is a tuning attempt that silently did nothing.
  //
  // THIS TEST FOUND ONE. `darter` sat at contact 4 while the cycle's cheapest
  // possible contact is 7.35 hull, so the cycle had been driving at contact 0
  // since the profile was written, and the table said otherwise.
  for (const [name, p] of Object.entries(DRIVING_PROFILES)) {
    if (p.contact === 0) continue; // zero is a decision, not a dead setting
    const users = typesDriving(name, CAR_TYPES);
    if (users.length === 0) continue;
    const floor = Math.min(...users.map(cheapestContact));
    assert.ok(
      p.contact > floor,
      `profile "${name}" has contact ${p.contact}, under the cheapest contact its ` +
        `drivers can be offered (${floor.toFixed(2)} hull) and therefore identical ` +
        `to contact 0. Raise it, or set it to 0 and say so.`,
    );
  }
});

test("every car type names a tactic that actually exists", () => {
  // tacticFor falls back to `cruise` for an unknown name rather than throwing,
  // so a half-written type still drives — but a SHIPPED type taking that path
  // is a catalogue that lies about what its car does.
  //
  // THIS IS THE `convoy` FAILURE, pinned. The rig named a tactic row that
  // resolved to plain `cruise` and carried a comment promising a rolling
  // roadblock, so cartypes.js read as though the rig had a manoeuvre of its own
  // for as long as that row sat there. The row is gone and the rig names
  // `cruise`; this is what stops the next placeholder outliving its author.
  for (const t of CAR_TYPES) {
    assert.ok(
      TACTIC_NAMES.includes(t.behaviour),
      `${t.id} names behaviour "${t.behaviour}", which is not a tactic — it would ` +
        `silently fall back to cruising. Known: ${TACTIC_NAMES.join(", ")}`,
    );
  }
});

test("a chasing driver holds a gap it would still count as contact", () => {
  // The stocker's give-up clock (behaviours.js's `trail`) runs on TRAIL_ENGAGE
  // while its DRIVING holds the profile's `pursueHold`. Those are two numbers
  // in two files, and if the hold gap ever drifted outside the contact gap the
  // car would sit exactly where it means to sit, perfectly in range, and give
  // the player up anyway for no reason either of them could see.
  for (const [name, p] of Object.entries(DRIVING_PROFILES)) {
    if (p.giveUpTime <= 0) continue; // never gives up: nothing to get wrong
    assert.ok(
      p.pursueHold < TRAIL_ENGAGE,
      `profile "${name}" holds station at ${p.pursueHold} but only counts contact ` +
        `inside ${TRAIL_ENGAGE}, so it would disengage while doing its job`,
    );
  }
});

test("a chase range is wider than the gap it chases down to", () => {
  // `pursueRange` is the gap at which chasing STARTS and `pursueHold` the gap
  // it settles at. Inverted, the car would only ever chase when it was already
  // closer than it wanted to be, and would cruise the rest of the time — a
  // hostile that never actually comes after anyone.
  for (const [name, p] of Object.entries(DRIVING_PROFILES)) {
    assert.ok(
      p.pursueHold < p.pursueRange,
      `profile "${name}" holds at ${p.pursueHold} but only chases inside ` +
        `${p.pursueRange}: it would never close on the player at all`,
    );
  }
});

test("the ram's block is slower than the player's own minimum", () => {
  // behaviours.js's `ram`, once ahead of the player, asks for a fraction of
  // THEIR speed with `ramFloor` underneath it. That floor has to sit below the
  // player's own MIN_SPEED or simply lifting off the throttle would out-slow
  // the roadblock and the whole second half of the tactic would go slack.
  for (const [name, p] of Object.entries(DRIVING_PROFILES)) {
    assert.ok(
      p.ramFloor < MIN_SPEED,
      `profile "${name}" blocks at a floor of ${p.ramFloor}, at or above the ` +
        `player's own minimum of ${MIN_SPEED}: they could simply coast past it`,
    );
  }
});

// A hostile that wants the player's line, with that line already occupied by
// something it will not touch. `stale` is the intent left over from whatever it
// was doing before — the thing that must not survive the tick.
function blockedChaseScenario(stale) {
  const type = CAR_TYPES.find((t) => t.id === "interceptor");
  const rig = CAR_TYPES.find((t) => t.id === "rig");
  const here = laneOffset(0);
  const there = laneOffset(LANE_COUNT - 1);

  const car = driver({
    worldY: 0, offset: here, targetOffset: stale, speed: 430, cruiseSpeed: 430,
    targetSpeed: 430, w: type.w, h: type.h, type, drive: drivingFor(type),
    nerve: 0, contact: 0,
  });
  // Parked on the line the hostile wants. The interceptor's `contact` is 0, so
  // it will not take a lane with this in it at any price.
  const wall = driver({
    worldY: 90, offset: there, speed: 195, cruiseSpeed: 195, targetSpeed: 195,
    targetOffset: there, w: rig.w, h: rig.h, type: rig, drive: drivingFor(rig),
  });
  const playerBody = {
    worldY: 300, offset: there, w: 34, h: 60, speed: 460, alive: true,
    prevOffset: there, mass: 1.4, damage() {},
  };
  driveCar(car, 1 / 60, {
    cars: [car, wall], obstacles: [], playerBody,
    player: new Player(300, 496), H: 800,
    fireShot: () => {}, dropMine: () => true,
  });
  return car;
}

test("a chasing car whose line is blocked holds its own line, not a stale one", () => {
  // THE INTENT MUST BE WRITTEN EVERY TICK, which is the rule `keepLane` already
  // enforces for civilians and which the hostile tactics used to break. All
  // four of them read `if (!blocked(...)) car.targetOffset = want;` and did
  // nothing on the other branch — so a car that could not take the player's
  // line went on steering at wherever the player had been several ticks ago,
  // quite possibly straight into the traffic that blocked it.
  //
  // Measured before the fix: a hostile sitting in the outer lane with a stale
  // target of +40 kept asking for +40 for as long as the block lasted.
  const stale = 40;
  const car = blockedChaseScenario(stale);
  assert.notEqual(
    car.targetOffset, stale,
    "a blocked chase must not keep steering at the line it wanted last tick",
  );
  assert.equal(
    car.targetOffset, car.offset,
    "with nowhere it will go, the car should hold the line it is actually on",
  );
});

// A cruising car in lane 1, and a hazard somewhere ahead of it. `gap` is how
// much road it gets, which is what decides whether steering alone is enough.
function hazardScenario(gap, over = {}) {
  const car = driver({
    worldY: 0, offset: laneOffset(1), w: 34, h: 60, speed: 300, cruiseSpeed: 300,
    targetSpeed: 300, targetOffset: laneOffset(1),
    // behaviours.js derives its hazard lookahead from speed and steerSpeed, so
    // a fixture without a steering rate would look ahead an undefined distance.
    type: { behaviour: "cruise", w: 34, steerSpeed: 90 },
    ...over,
  });
  const hazard = {
    worldY: gap, offset: laneOffset(1), w: 60, h: 14, alive: true, threat: 8,
  };
  driveCar(car, 1 / 60, { cars: [car], obstacles: [hazard], playerBody: null });
  return { car, hazard };
}

test("traffic steers around a hazard rather than queueing behind it", () => {
  // behaviours.js keeps obstacles OUT of leadCar on purpose: a hazard never
  // moves, so MATCHING ITS SPEED would mean stopping dead for something that is
  // never going to pull away. Going round is the answer.
  const { car, hazard } = hazardScenario(400);
  assert.notEqual(car.targetOffset, laneOffset(1), "the car should have picked another lane");
  assert.ok(
    Math.abs(car.targetOffset - hazard.offset) >= (car.w + hazard.w) / 2,
    "the lane it picked still overlaps the hazard",
  );
  assert.ok(car.targetSpeed > 0, "it must not stop for something it can drive around");
});

test("a car with road to spare passes a hazard at full speed", () => {
  // Tier 3 is a floor, not a target: braking must not leak into the ordinary
  // case, or the whole road would slow down every time a roadblock appeared.
  const { car } = hazardScenario(2000);
  assert.equal(car.targetSpeed, car.cruiseSpeed);
});

test("a car that cannot fit the swerve in slows down until it can", () => {
  // The tier the user asked for: a hazard is static, so going slower does not
  // let it get away — it just buys the seconds a lane change costs.
  const { car } = hazardScenario(90);
  assert.ok(
    car.targetSpeed < car.cruiseSpeed,
    `expected braking with only 90 units of road, got ${car.targetSpeed}`,
  );
  assert.ok(car.targetSpeed >= 0, "speed must never go negative");
});

test("a boxed-in car still slows, even with no lane to aim at", () => {
  // Every lane hazardous: there is no line to steer to, and the car must not
  // simply give up and drive on at cruise. Stopping in front of a hazard is an
  // acceptable outcome — see behaviours.js's tier 3.
  const car = driver({
    worldY: 0, offset: 0, w: 34, h: 60, speed: 300, cruiseSpeed: 300,
    targetSpeed: 300, targetOffset: 0,
    type: { behaviour: "cruise", w: 34, steerSpeed: 90 },
  });
  // One hazard wide enough to cover the whole road, close ahead.
  const wall = { worldY: 80, offset: 0, w: 1000, h: 14, alive: true, threat: 30 };
  driveCar(car, 1 / 60, { cars: [car], obstacles: [wall], playerBody: null });
  assert.ok(
    car.targetSpeed < car.cruiseSpeed,
    `a car with nowhere to go must slow down, got ${car.targetSpeed}`,
  );
});

test("a driver with the nerve for it holds its line through a hazard", () => {
  // A barger neither steers nor brakes: it means to hit the thing.
  const { car } = hazardScenario(150, { nerve: 20 });
  assert.equal(car.targetOffset, laneOffset(1), "nerve 20 should shrug off an 8-hull hit");
  assert.equal(car.targetSpeed, car.cruiseSpeed, "and should not slow for it either");
});

test("behaviours still run with no obstacle system at all", () => {
  // `obstacles` is optional in the world view — Traffic seeds it empty, but a
  // caller that never sets it must not crash the road.
  const car = driver({
    worldY: 0, offset: 0, w: 34, h: 60, speed: 300, cruiseSpeed: 300,
    targetSpeed: 300, targetOffset: 0,
    type: { behaviour: "cruise", w: 34, steerSpeed: 90 },
  });
  driveCar(car, 1 / 60, { cars: [car], playerBody: null });
  assert.equal(car.targetSpeed, car.cruiseSpeed);
});

// --- Driving profiles ----------------------------------------------------------
//
// Two cars running the SAME tactic and differing only in the table they point at
// is the whole claim driving.js makes. These check the claim holds for each knob
// that has teeth, rather than checking the numbers themselves.

const HUSTLER = DRIVING_PROFILES.hustler;

// A car mid-lane-1, optionally shoved off the centre-line, driven one tick.
function laneScenario(offset, drive, world = { cars: [], playerBody: null }) {
  const car = driver({
    worldY: 0, offset, w: 34, h: 60, speed: 300, cruiseSpeed: 300,
    targetSpeed: 300, targetOffset: offset, drive,
    type: { behaviour: "cruise", w: 34, steerSpeed: 90, speedMax: 400 },
  });
  driveCar(car, 1 / 60, { obstacles: [], ...world, cars: [car, ...world.cars] });
  return car;
}

test("a disciplined driver aims back at the lane centre it was shoved off", () => {
  // Nothing else re-derives which lane a car belongs in: `cruise` never wrote
  // targetOffset at all, so before keepLane a rammed car steered back to the
  // lane it SPAWNED in, however many manoeuvres ago that was.
  const car = laneScenario(laneOffset(1) + 20, COMMUTER);
  assert.equal(car.targetOffset, laneOffset(1), "commuter discipline is dead centre");
});

test("a sloppy driver holds the line it was shoved to", () => {
  // The same shove, the same tactic, the other profile. laneDiscipline is read
  // as a tolerance, so the hustler accepts sitting off centre and rides the lane
  // edge — which is the most visible difference between the two on the road.
  const off = laneOffset(1) + 20;
  const car = laneScenario(off, HUSTLER);
  assert.equal(car.targetOffset, off, "the hustler should hold its line inside the slack");
  assert.notEqual(car.targetOffset, laneOffset(1));
});

test("the civilian road is a speed gradient across the lanes", () => {
  // driving.js states the lane preferences BY SPEED: the slow haulers want the
  // lanes by the barrier and the fast machines want the lanes by the centre-line,
  // so the road sorts itself and the player's choice of lane is a choice about
  // what they will meet there. It is the kind of design that survives exactly
  // until somebody retunes a speed range, at which point nothing breaks and the
  // road just quietly stops making sense — so it is asserted rather than written
  // down.
  const civilians = CAR_TYPES.filter((t) => t.value < 0);
  const pace = (t) => (t.speedMin + t.speedMax) / 2;
  const paces = civilians.map(pace).sort((a, b) => a - b);
  const median = paces[Math.floor(paces.length / 2)];

  for (const t of civilians) {
    const home = drivingFor(t).laneHome;
    if (home === "any") continue; // the reference car, filling in what is left
    const wanted = pace(t) < median ? "outer" : "inner";
    assert.equal(
      home,
      wanted,
      `${t.id} cruises at ${pace(t)} against a civilian median of ${median} and wants ` +
        `the ${home} lanes. A car on the wrong side of the median makes the gradient ` +
        `unreadable — retune its speed, or its laneHome.`,
    );
  }
});

test("a lane preference is not worth a lane change through traffic", () => {
  // The hustler wants the inner lane. It may drift over when the road allows it
  // and must not grind across when it does not — every swerve is a collision.
  const outer = laneOffset(0);
  const clear = laneScenario(outer, HUSTLER);
  assert.ok(clear.targetOffset > outer, "a free inner lane should draw it over");

  const occupant = { worldY: 50, offset: laneOffset(1), w: 34, h: 60, speed: 300, alive: true };
  const held = laneScenario(outer, HUSTLER, { cars: [occupant], playerBody: null });
  assert.equal(held.targetOffset, outer, "an occupied inner lane must not");
});

// A hazard dead ahead in lane 1, with every other lane occupied by traffic. The
// only way through is a lane with a car in it — so what the driver does here is
// decided entirely by what it is willing to hit.
//
// `contact` is set on BOTH the car and the profile behind it, because those are
// two different things and behaviours.js reads both: the profile carries the
// CEILING (and a ceiling of zero means "nobody at all"), the car carries the
// figure it rolled under that ceiling. A fixture that set only the roll was
// describing a car whose profile forbids what the car is doing.
function boxedIn(contact, steerSpeed = 90) {
  const car = driver({
    worldY: 0, offset: laneOffset(1), w: 34, h: 60, speed: 300, cruiseSpeed: 300,
    targetSpeed: 300, targetOffset: laneOffset(1), contact,
    drive: { ...COMMUTER, contact },
    type: { behaviour: "cruise", w: 34, steerSpeed, speedMax: 400 },
  });
  const hazard = {
    worldY: 150, offset: laneOffset(1), w: 60, h: 14, alive: true, threat: 8,
  };
  const others = [0, 2, 3].map((i) => ({
    worldY: 60, offset: laneOffset(i), w: 34, h: 60, speed: 300, alive: true,
  }));
  driveCar(car, 1 / 60, { cars: [car, ...others], obstacles: [hazard], playerBody: null });
  return car;
}

test("a careful driver stops for a hazard rather than drive into traffic", () => {
  // The sedan's rule, and the one genuinely new capability behind it: with no
  // lane it will take, the hazard is handed to followSpeed as a lead car doing
  // zero. Following a hazard is never the answer WHILE A LANE IS AVAILABLE — and
  // it is exactly the answer when none is.
  const car = boxedIn(0);
  assert.equal(car.targetSpeed, 0, "a commuter with nowhere to go must stop");
});

test("a driver that will take the bump keeps rolling instead", () => {
  // Same road, same tactic, one number different. This is the trade that used to
  // be hard-coded for every car on the road ("a fender-bender beats a blast")
  // and is now the thing that tells two civilians apart: one gives up its speed,
  // the other spends a bump to keep it.
  const car = boxedIn(10);
  assert.ok(car.targetSpeed > 0, "it should have taken a lane and kept moving");
  assert.notEqual(car.targetOffset, laneOffset(1));
});

test("a contact ceiling of zero means nobody, even when the swipe would be free", () => {
  // The rig's case, and the reason behaviours.js reads the ceiling off the
  // PROFILE instead of just testing the rolled figure. `contactCost` returns 0
  // for any car steering slower than collisions.js's DAMAGE_FLOOR of 40, so
  // `0 <= 0` used to wave every occupied lane on the road through — which left
  // the heaviest, least agile vehicle in the catalogue as the single one that
  // would slide into a lane with somebody in it without a thought, in flat
  // contradiction of the profile it names.
  const rig = CAR_TYPES.find((t) => t.id === "rig");
  assert.equal(
    cheapestContact(rig),
    0,
    "this proves nothing unless the rig's lane changes really are free",
  );
  assert.ok(rig.steerSpeed < 40, "...which is only true while it steers under the floor");

  const timid = boxedIn(0, rig.steerSpeed);
  assert.equal(timid.targetSpeed, 0, "a free swipe is still a swipe, and this one said no");
});

test("a car that stops for a hazard still gets off the hazard's line", () => {
  // FOUND BY MEASURING THE ROAD, not by reading it. Stopping alone left the car
  // holding the line it had — which is by definition the line with the roadblock
  // in it. It then sat there as a stationary object in a live lane until
  // something rear-ended it and shunted it into the very thing it had stopped
  // for: every single civilian hazard strike in a 15 car-minute sample was that,
  // and nothing else. So the refuge is taken even with somebody standing in it,
  // because by then the car has already given up its speed and the contact it
  // accepts is a nudge rather than a swipe.
  const car = boxedIn(0);
  const hazard = { offset: laneOffset(1), w: 60 };
  assert.ok(
    Math.abs(car.targetOffset - hazard.offset) >= (car.w + hazard.w) / 2,
    `stopped car is aiming at ${car.targetOffset}, still inside the hazard's line`,
  );
});

// A car held up by something slower in the same lane, driven for `seconds`.
function heldUp(drive, seconds) {
  const car = driver({
    worldY: 0, offset: laneOffset(1), w: 34, h: 60, speed: 300, cruiseSpeed: 300,
    targetSpeed: 300, targetOffset: laneOffset(1), drive,
    type: { behaviour: "overtake", w: 34, steerSpeed: 90, speedMax: 400 },
  });
  const lead = {
    worldY: 150, offset: laneOffset(1), w: 34, h: 60, speed: 200, alive: true,
  };
  const world = { cars: [car, lead], obstacles: [], playerBody: null };
  for (let t = 0; t < seconds * 60; t++) driveCar(car, 1 / 60, world);
  return car;
}

test("patience decides how long a car sits behind a blocker before passing", () => {
  // Before this, a pass fired the instant the trigger distance was met, so the
  // only thing separating two overtakers was how fast they could steer.
  assert.equal(heldUp(COMMUTER, 0.5).passTarget ?? null, null, "1.2s of patience");
  assert.ok(heldUp(COMMUTER, 2).passTarget, "and it does eventually go");
  assert.ok(heldUp(HUSTLER, 0.5).passTarget, "0.2s of patience goes much sooner");
});

test("frustration is reset when the road clears, not carried around", () => {
  // heldTime measures how long this car has been stuck, not how old it is —
  // otherwise a car that spent a minute in clear traffic would pass the instant
  // it ever met anybody.
  const car = driver({
    worldY: 0, offset: laneOffset(1), w: 34, h: 60, speed: 300, cruiseSpeed: 300,
    targetSpeed: 300, targetOffset: laneOffset(1), heldTime: 5,
    type: { behaviour: "overtake", w: 34, steerSpeed: 90, speedMax: 400 },
  });
  driveCar(car, 1 / 60, { cars: [car], obstacles: [], playerBody: null });
  assert.equal(car.heldTime, 0, "an empty road must clear the timer");
});

test("a driver prices a contact with the same formula the solver applies", () => {
  // behaviours.js decides whether to take a lane using collisions.js's own
  // impactCost. A copy of the arithmetic would drift, and a driver making its
  // decisions against physics the game does not run would be wrong in exactly
  // the cases that matter.
  const a = { mass: 1 };
  const b = { mass: 1 };
  let taken = 0;
  const bodies = [
    { ...a, worldY: 0, offset: 0, prevOffset: 0, w: 34, h: 60, speed: 300,
      vLateral: 0, alive: true, damage: (hp) => (taken += hp) },
    { ...b, worldY: 40, offset: 0, prevOffset: 0, w: 34, h: 60, speed: 100,
      vLateral: 0, alive: true, damage: () => {} },
  ];
  resolveCollisions(bodies, 1 / 60);
  assert.ok(taken > 0, "the fixture must actually collide, or this proves nothing");
  assert.equal(taken, impactCost(a, b, 200, 1), "the solver and the estimate disagree");
});

test("the same agreement holds once a body carries its own attackFloor", () => {
  // contactCost (behaviours.js) passes `other.attackFloor` through to
  // impactCost exactly as applyDamage (collisions.js) does — this is the
  // plumbing that lets a maxed RAM PLATE change what an ESTIMATE costs, not
  // just what the solver actually charges. Same fixture as above, one body
  // given a lower floor.
  const a = { mass: 1 };
  const b = { mass: 1, attackFloor: 20 };
  let taken = 0;
  const bodies = [
    { ...a, worldY: 0, offset: 0, prevOffset: 0, w: 34, h: 60, speed: 130,
      vLateral: 0, alive: true, damage: (hp) => (taken += hp) },
    { ...b, worldY: 40, offset: 0, prevOffset: 0, w: 34, h: 60, speed: 100,
      vLateral: 0, alive: true, damage: () => {} },
  ];
  resolveCollisions(bodies, 1 / 60); // closing 30: under the shared floor, over b's
  assert.ok(taken > 0, "the lower floor must have let this contact through");
  assert.equal(taken, impactCost(a, b, 30, 1, b.attackFloor), "the solver and the estimate disagree");
});

// --- Enemy armament -----------------------------------------------------------

const ENEMY_GUN = ENEMY_WEAPON_TYPES[0];

test("every hostile is armed and nothing else is", () => {
  // game/armament.js: "every hostile is armed, and nothing else is" — faction is
  // the default rather than a per-type flag, so a new enemy type is armed by
  // existing. The other half matters more: an armed civilian would shoot at the
  // player, and killing it back would still fine them (score.js).
  for (const t of CAR_TYPES) {
    const armed = armamentFor(t) !== null;
    assert.equal(armed, t.value >= 0, `${t.id}: armed=${armed} does not match its faction`);
  }
});

test("the enemy's gun is not something the player can end up holding", () => {
  // weapons.js keeps two catalogues for exactly this: Loadout defaults to
  // WEAPON_TYPES and the Phase 5 pickups will roll from it, so anything added
  // there is a weapon the player can pick up.
  const playerIds = new Set(WEAPON_TYPES.map((t) => t.id));
  for (const t of ENEMY_WEAPON_TYPES) {
    assert.ok(!playerIds.has(t.id), `${t.id} appears in the player's catalogue`);
  }
  const loadout = new Loadout();
  assert.ok(
    !loadout.weapons.some((w) => w.type === ENEMY_GUN),
    "the default loadout handed the player the enemy's gun",
  );
});

test("one hostile gun stays inside its sanity band", () => {
  // A BAND, NOT A TARGET — weapons.js is explicit that the blaster is tuned by
  // measuring the road, since what matters is how much hull a minute of driving
  // costs and that depends on how often a gun bears. This only catches the
  // change nobody would measure after: raising `damage` or dropping `interval`
  // far enough that a single hostile becomes a countdown on its own.
  const seconds = (new Player(0, 0).maxHealth / ENEMY_GUN.damage) * ENEMY_GUN.interval;
  assert.ok(
    seconds >= 15,
    `one blaster now empties the player's hull in ${seconds.toFixed(1)}s on its own — ` +
      `too fast for a road that puts several of them on the player at once`,
  );
});

test("every hostile type can shoot behind it", () => {
  // A rearward round leaves the muzzle at the shooter's speed MINUS the muzzle
  // speed (projectiles.js's `dir`), so it only travels backwards while the
  // muzzle speed clears the catalogue's ceiling. Below that, the quickest
  // hostiles quietly lose the ability to shoot at a player sitting behind them —
  // which is most of the time, given where the player is framed.
  assert.ok(
    ENEMY_GUN.muzzleSpeed > fastest,
    `blaster muzzleSpeed ${ENEMY_GUN.muzzleSpeed} must exceed the fastest cruise ${fastest}`,
  );
});

test("a rearward round travels back down the road and still hits", () => {
  // The whole of what projectiles.js needed for enemy fire: a sign on the muzzle
  // speed. The swept hit test is direction-agnostic, and this is what proves it.
  const shots = new Projectiles();
  const s = shots.spawn(0, 0, 400, ENEMY_GUN, 600, -1);
  assert.equal(s.speed, 400 - ENEMY_GUN.muzzleSpeed);
  assert.ok(s.speed < 0, "a rearward shot from a car slower than its gun must go backwards");

  let taken = 0;
  const target = {
    worldY: -180, offset: 0, w: 34, h: 60, alive: true,
    damage(hp) { taken += hp; },
  };
  const view = { distance: 0, playerY: 496, W: 600, H: 800 };
  for (let i = 0; i < 120 && taken === 0; i++) shots.update(1 / 60, [target], view);

  assert.equal(taken, ENEMY_GUN.damage, "the round should have run down onto the car behind it");
  assert.ok(!s.alive, "and been consumed by the hit");
  assert.ok(s.worldY < 0, "it must have ended up behind where it was fired");
});

// --- Seeking, burning and piercing rounds ------------------------------------
//
// The three mechanics that stop the cannon, the tracker and the rocket from
// being one weapon at three sets of numbers (weapons.js). Each is tested at the
// level it lives at: what the CATALOGUE promises, and what projectiles.js does
// with it.

const ROCKET_TYPE = WEAPON_TYPES.find((t) => t.id === "rocket");
const TRACKER_TYPE = WEAPON_TYPES.find((t) => t.id === "tracker");
const SHOT_VIEW = { distance: 0, playerY: 496, W: 600, H: 800 };

// A body of the shape projectiles.js resolves against, with enough hull to
// need `hits` rounds of `damage` to put down.
function dummy(worldY, offset, hits, damage, extra = {}) {
  return {
    worldY, offset, w: 34, h: 60, alive: true,
    health: hits * damage,
    taken: 0,
    seekable: true,
    damage(hp) {
      this.taken += hp;
      this.health -= hp;
      if (this.health <= 0) this.alive = false;
    },
    ...extra,
  };
}

test("a seeking round crosses the lanes to reach what it locked on to", () => {
  // weapons.js's ROCKET: "goes where the TARGET is rather than where it was
  // aimed". Fired dead ahead at nothing, up a lane the target is not in.
  const shots = new Projectiles();
  shots.spawn(0, 0, 400, ROCKET_TYPE, 600);
  const car = dummy(700, 150, 1, ROCKET_TYPE.damage);

  for (let i = 0; i < 200 && car.alive; i++) shots.update(1 / 60, [car], SHOT_VIEW);

  assert.ok(!car.alive, "the rocket should have steered a lane and a half across to reach it");
});

test("a seeker cannot turn faster than its own turnRate", () => {
  // The weapon's difficulty knob (weapons.js) — a seeker that could snap onto
  // a target instantly would make every other weapon pointless.
  const shots = new Projectiles();
  const s = shots.spawn(0, 0, 400, ROCKET_TYPE, 600);
  const car = dummy(900, 250, 1, ROCKET_TYPE.damage);

  const dt = 1 / 60;
  const before = s.offset;
  shots.update(dt, [car], SHOT_VIEW);
  assert.ok(s.offset > before, "it should have begun to turn toward the target");
  assert.ok(
    s.offset - before <= ROCKET_TYPE.turnRate * dt + 1e-9,
    `a seeker turned ${s.offset - before} in one tick, past its own ${ROCKET_TYPE.turnRate}/sec`,
  );
});

test("a seeker locks on to cars only, never to road furniture", () => {
  // projectiles.js's seek(): `seekable` is opt-IN, and traffic.js's Car is the
  // only thing that sets it. The player's gunfire is resolved against ONE flat
  // list of cars and obstacles (main.js), so without this a rocket would turn
  // across two lanes to chase a trestle.
  const shots = new Projectiles();
  const s = shots.spawn(0, 0, 400, ROCKET_TYPE, 600);
  const trestle = dummy(700, 150, 1, ROCKET_TYPE.damage, { seekable: undefined });

  for (let i = 0; i < 30; i++) shots.update(1 / 60, [trestle], SHOT_VIEW);

  assert.equal(s.offset, 0, "the rocket must have held its line rather than chasing the obstacle");
  assert.ok(trestle.alive, "and left it alone");
});

test("a rocket leaves the rail slowly and burns up to its top speed, and no further", () => {
  // weapons.js's ROCKET: "A LAUNCH, NOT A SHOT" — worst weapon in the
  // catalogue at point-blank, fastest at the far end of the road.
  const shots = new Projectiles();
  const shooter = 400;
  const s = shots.spawn(0, 0, shooter, ROCKET_TYPE, 600);
  assert.equal(s.speed, shooter + ROCKET_TYPE.muzzleSpeed, "it must launch at its muzzle speed");

  const cannon = WEAPON_TYPES.find((t) => t.id === "cannon");
  assert.ok(
    ROCKET_TYPE.muzzleSpeed < cannon.muzzleSpeed && ROCKET_TYPE.topSpeed > cannon.muzzleSpeed,
    "the burn must start below the cannon's round and finish above it, or it is just a slow bullet",
  );

  for (let i = 0; i < 300; i++) shots.update(1 / 60, [], SHOT_VIEW);
  assert.equal(s.speed, shooter + ROCKET_TYPE.topSpeed, "the burn must reach the cap");
  for (let i = 0; i < 60; i++) shots.update(1 / 60, [], SHOT_VIEW);
  assert.equal(s.speed, shooter + ROCKET_TYPE.topSpeed, "and must not run past it");
});

test("a piercing round punches through what it kills and stops at what survives", () => {
  // weapons.js's TRACKER: killing is the condition, so the heavy types still
  // stop it dead and the rocket stays the answer to armour.
  const shots = new Projectiles();
  shots.spawn(0, 0, 400, TRACKER_TYPE, 600);
  const first = dummy(300, 0, 1, TRACKER_TYPE.damage);   // dies to one round
  const second = dummy(500, 0, 1, TRACKER_TYPE.damage);  // dies to one round
  const rig = dummy(700, 0, 10, TRACKER_TYPE.damage);    // shrugs it off

  for (let i = 0; i < 200; i++) shots.update(1 / 60, [first, second, rig], SHOT_VIEW);

  assert.ok(!first.alive && !second.alive, "one round should have taken both light cars");
  assert.ok(rig.alive, "and stopped at the heavy one");
  assert.equal(rig.taken, TRACKER_TYPE.damage, "which must have been hit exactly once");
});

test("a piercing round's budget is for its whole life, not for each tick", () => {
  // The bodies a round punches through may fall either side of a tick
  // boundary, so a per-tick allowance would make `pierce` unbounded — see
  // projectiles.js's update().
  const shots = new Projectiles();
  shots.spawn(0, 0, 400, TRACKER_TYPE, 600);
  // One more body in the line than the round is allowed to kill, spread far
  // enough apart that each falls in a different tick.
  const line = [];
  for (let i = 0; i <= TRACKER_TYPE.pierce + 1; i++) {
    line.push(dummy(300 + i * 400, 0, 1, TRACKER_TYPE.damage));
  }

  for (let i = 0; i < 400; i++) shots.update(1 / 60, line, SHOT_VIEW);

  const killed = line.filter((t) => !t.alive).length;
  assert.equal(
    killed, TRACKER_TYPE.pierce + 1,
    `one round killed ${killed} cars, past its pierce budget of ${TRACKER_TYPE.pierce} + the first`,
  );
});

test("the rocket's blast is the widest on the road, but never the hardest hit", () => {
  // weapons.js: a hand-aimed warhead should out-REACH road furniture, but
  // obstacletypes.js calls the mine's blastDamage "the single hardest hit
  // anything on the road can deal" — and that claim has to stay true.
  const mine = OBSTACLE_TYPES.find((t) => t.id === "caltrop");
  const widest = Math.max(...OBSTACLE_TYPES.map((t) => t.blastRadius));
  assert.ok(
    ROCKET_TYPE.blastRadius > widest,
    `the rocket's ${ROCKET_TYPE.blastRadius} no longer out-reaches the road's own ${widest}`,
  );
  for (const t of WEAPON_TYPES) {
    assert.ok(
      (t.blastDamage ?? 0) < mine.blastDamage,
      `${t.id}'s blast now hits for ${t.blastDamage}, matching or beating the mine's ${mine.blastDamage}`,
    );
  }
  // And the reach has to actually clear a car, which is what the old 44 never
  // did — the shortest body in the catalogue is longer than that.
  const shortest = Math.min(...CAR_TYPES.map((t) => t.h));
  assert.ok(
    ROCKET_TYPE.blastRadius > shortest,
    `a blast of ${ROCKET_TYPE.blastRadius} cannot reach past the shortest car (${shortest})`,
  );
});

// An armed hostile at the origin, with the player somewhere near it, driven
// through a real hostile behaviour. `fired` / `laid` record what reached the
// world hooks, which is the only observable this layer has.
function hostileScenario(over = {}, worldOver = {}) {
  const type = CAR_TYPES.find((t) => t.id === "interceptor");
  const car = driver({
    worldY: 0, offset: 0, w: type.w, h: type.h, speed: 420, cruiseSpeed: 420,
    targetSpeed: 420, targetOffset: 0,
    type, drive: drivingFor(type), arms: armFor(type),
    ...over,
  });
  const playerBody = {
    worldY: 300, offset: 0, w: 34, h: 60, speed: 300, alive: true,
    damage() {},
    ...(worldOver.playerBody ?? {}),
  };
  const fired = [];
  const laid = [];
  const world = {
    cars: [car], obstacles: [], playerBody,
    player: new Player(300, 496), H: 800,
    fireShot: (c, t, dir) => fired.push({ car: c, type: t, dir }),
    dropMine: (c, t) => (laid.push({ car: c, type: t }), true),
    ...worldOver,
    playerBody, // worldOver may only override the body's FIELDS, above
  };
  driveCar(car, 1 / 60, world);
  return { car, world, fired, laid };
}

test("a hostile shoots at a player in front of it, up the road", () => {
  const { car, fired } = hostileScenario();
  assert.equal(fired.length, 1, "expected exactly one round");
  assert.equal(fired[0].dir, 1, "a player ahead must be shot at up the road");
  // Whichever gun this type actually carries — the interceptor's own
  // fixture, `hostileScenario`, is armed with its rocket (armament.js's
  // `rocketeer`), not the shared blaster, so this checks the round matches
  // the car's own kit rather than assuming which kit that is.
  assert.equal(fired[0].type, car.arms.gun.type);
});

test("a hostile ahead of the player shoots back down the road", () => {
  // The case the `dir` parameter exists for: the enemy is in front, which is
  // where the framing puts most of them.
  const { fired } = hostileScenario({}, { playerBody: { worldY: -260 } });
  assert.equal(fired.length, 1);
  assert.equal(fired[0].dir, -1, "a player behind must be shot at back down the road");
});

test("a hostile holds fire on a player out of its line", () => {
  const { fired } = hostileScenario({}, { playerBody: { offset: 120 } });
  assert.equal(fired.length, 0, "a shot two lanes wide of the player is wasted");
});

test("a hostile holds fire from off screen", () => {
  // game/armament.js: "a car firing from beyond the edge of the screen is an
  // unattributable hit". A player framed at 62% down an 800px canvas can see
  // 304 units of road behind them, so a car 290 back may shoot and one 400 back
  // may not — even though both are inside GUN_RANGE.
  const seen = hostileScenario({}, { playerBody: { worldY: 290 } });
  assert.equal(seen.fired.length, 1, "a car still on screen behind the player should fire");
  const unseen = hostileScenario({}, { playerBody: { worldY: 400 } });
  assert.equal(unseen.fired.length, 0, "a car below the bottom edge must not fire");
});

test("a hostile does not fire a round that cannot catch anything", () => {
  // A car quicker than its own muzzle speed puts rearward rounds out that still
  // drift forwards. Rather than tune the case away, the shot is not taken — and
  // a car pulling away from the player ceasing fire reads correctly anyway.
  const { fired } = hostileScenario(
    { speed: ENEMY_GUN.muzzleSpeed + 400 },
    { playerBody: { worldY: -260 } },
  );
  assert.equal(fired.length, 0, "a round that never closes must not be fired");
});

test("a civilian carries nothing and never fires", () => {
  const sedan = CAR_TYPES.find((t) => t.id === "sedan");
  assert.equal(armFor(sedan), null);
  const { fired, laid } = hostileScenario({ type: sedan, arms: armFor(sedan) });
  assert.equal(fired.length, 0);
  assert.equal(laid.length, 0);
});

// The mine tests below need a hostile that actually carries a layer.
// `hostileScenario`'s own default (the interceptor) no longer does — see
// armament.js's `rocketeer` — so these override `arms` explicitly with a
// type that still does. The rival is the shipped stand-in for "a hostile
// that mines", alongside the cycle's own dedicated `raid` tactic.
//
// A FRESH INSTANCE PER CALL, not a shared constant: `Armament` carries real
// cooldown and ammo state, so firing it in one test would leave the next
// test's copy already part-spent or still cooling down.
const mineCapableArms = () => armFor(CAR_TYPES.find((t) => t.id === "rival"));

test("a hostile lays the catalogue's mine at a player on its tail", () => {
  const { laid } = hostileScenario(
    { arms: mineCapableArms() },
    { playerBody: { worldY: -200 } },
  );
  assert.equal(laid.length, 1, "expected one mine");
  assert.equal(laid[0].type, obstacleTypeById("caltrop"), "the payload must be the mine");
});

test("a hostile does not mine somebody else's traffic", () => {
  // The scoring rule of cartypes.js's NERVE section, at the other end: score.js
  // pays out however a car died, so a civilian killed by a mine the player never
  // laid would fine them for a kill they had no part in.
  const between = {
    worldY: -100, offset: 0, w: 34, h: 60, speed: 300, alive: true,
    type: CAR_TYPES.find((t) => t.id === "sedan"),
  };
  const clear = hostileScenario({ arms: mineCapableArms() }, { playerBody: { worldY: -200 } });
  assert.equal(clear.laid.length, 1, "the test is meaningless if this case does not lay one");

  const blockedByTraffic = hostileScenario({ arms: mineCapableArms() }, {
    playerBody: { worldY: -200 },
    cars: [between],
  });
  assert.equal(blockedByTraffic.laid.length, 0, "a car between the two must veto the drop");
});

test("a hostile will not drop a mine into the player's face", () => {
  // MINE_MIN_LEAD: a mine that appears with no road left to steer around it is
  // not a threat the player can answer, it is just damage.
  const { laid } = hostileScenario(
    { arms: mineCapableArms() },
    { playerBody: { worldY: -40 } },
  );
  assert.equal(laid.length, 0);
});

test("a mine layer runs dry, and its magazine is what rations mines", () => {
  // weapons.js's blaster is deliberately infinite and the layer deliberately is
  // not — see game/armament.js. This pins the pair: a car cannot mine the road
  // indefinitely.
  const arms = mineCapableArms();
  assert.equal(arms.gun.ammo, Infinity, "the enemy gun must never run out");
  assert.ok(Number.isFinite(arms.layer.ammo) && arms.layer.ammo > 0);
  for (let i = 0; i < arms.layer.type.ammo; i++) {
    arms.layer.cooldown = 0;
    assert.ok(arms.layer.tryFire());
  }
  arms.layer.cooldown = 0;
  assert.ok(!arms.layer.tryFire(), "the layer should be empty");
});

test("a laid mine sits clear behind the car that dropped it", () => {
  // obstacles.js's DROP_CLEARANCE: the contact test makes no exception for
  // whoever laid it, so a car sitting inside its own mine would detonate it on
  // the tick it appeared.
  const obstacles = new Obstacles(new Explosions());
  const mine = obstacleTypeById("caltrop");
  const car = { worldY: 1000, offset: 20, h: 62, w: 34 };
  assert.ok(obstacles.drop(mine, car));

  const o = obstacles.list[0];
  assert.ok(o.laid, "a dropped obstacle must be marked as laid");
  assert.equal(o.offset, 20, "it belongs where the car was, not on a lane centre");
  assert.ok(o.worldY < car.worldY, "it must be behind the car");
  assert.ok(
    car.worldY - o.worldY > (car.h + o.h) / 2,
    "the dropper is sitting inside its own mine",
  );
});

test("laid mines and road furniture are budgeted separately", () => {
  // obstacles.js keeps two caps: a run of roadblocks must not quietly disarm
  // every enemy on the road, and a firefight must not starve the road of
  // obstacles. Each failure would look like a bug in the other system.
  const obstacles = new Obstacles(new Explosions());
  const mine = obstacleTypeById("caltrop");
  const car = { worldY: 1000, offset: 0, h: 62, w: 34 };

  let laid = 0;
  while (obstacles.drop(mine, car)) laid++;
  assert.ok(laid > 0 && laid < 8, `expected a small mine cap, got ${laid}`);
  assert.equal(obstacles.count(true), laid);
  assert.equal(obstacles.count(false), 0, "no mine may count against the spawner's budget");

  // ...and the spawner still works with the mine budget full.
  const world = obstacleWorld();
  obstacles.spawn(world);
  assert.equal(obstacles.count(false), 1, "the spawner should be unaffected by laid mines");
});

// --- Obstacle placement -------------------------------------------------------

test("each obstacle type is placed where its catalogue entry says", () => {
  // obstacletypes.js's placement modes, resolved through the real spawner. This
  // is the whole user-visible point of the field: barrels at the edge, trestles
  // in a lane, tetras in the middle, mines anywhere.
  const spots = (id, n) => {
    const type = obstacleTypeById(id);
    const [w] = OBSTACLE_SHAPES[type.shape].size;
    const out = [];
    for (let i = 0; i < n; i++) {
      // A fresh road each time, so nothing that was just placed blocks the next.
      const offset = new Obstacles(new Explosions()).freeOffset(type, 1000, []);
      assert.notEqual(offset, null, `${id}: found nowhere to go on an empty road`);
      out.push({ offset, w });
    }
    return out;
  };

  const edge = ROAD_HALF_WIDTH;
  for (const { offset, w } of spots("barrels", 20)) {
    // Flush with a barrier: the box edge touches the road edge on one side.
    const touching = Math.min(Math.abs(offset - w / 2 + edge), Math.abs(offset + w / 2 - edge));
    assert.ok(touching < 0.001, `barrels at ${offset.toFixed(1)} is not against a barrier`);
  }

  const laneCentres = Array.from({ length: LANE_COUNT }, (_, i) => laneOffset(i));
  for (const { offset } of spots("trestle", 20)) {
    assert.ok(laneCentres.includes(offset), `trestle at ${offset} is not on a lane centre`);
  }

  for (const { offset } of spots("tetra", 10)) {
    assert.equal(offset, 0, "a tetra belongs on the centre-line");
  }

  // The mine is the only type that may be anywhere — which is only observable as
  // it NOT collapsing onto the handful of offsets the other three use.
  const mines = spots("caltrop", 30).map((s) => s.offset);
  assert.ok(new Set(mines).size > 20, "mine placement looks quantised, not free");
  assert.ok(
    mines.some((o) => !laneCentres.includes(o)),
    "no mine landed off a lane centre",
  );
});

test("every obstacle keeps its whole box on the road", () => {
  // A placement may push a hazard flush against a barrier, never past one.
  for (const type of OBSTACLE_TYPES) {
    const [w] = OBSTACLE_SHAPES[type.shape].size;
    const offset = new Obstacles(new Explosions()).freeOffset(type, 1000, []);
    assert.notEqual(offset, null, `${type.id}: found nowhere to go on an empty road`);
    const overhang = Math.abs(offset) + w / 2 - ROAD_HALF_WIDTH;
    assert.ok(
      overhang <= 0.001,
      `${type.id} overhangs the barrier by ${overhang.toFixed(1)}px`,
    );
  }
});

test("a lane- or side-placed obstacle fits inside one lane, artwork and all", () => {
  // Two defects, both reported against the live game, both this shape:
  //
  //   PLACE_LANE  the trestle was 1.25 lanes wide, so sitting on a lane centre
  //               put it 8px over the dashed centre-line. "In the middle of a
  //               lane" only means anything for something a lane can hold.
  //   PLACE_SIDE  the barrels were 1.24 lanes wide, which made the one block the
  //               player is invited to aim AT also the one they could not line
  //               up on from inside their own lane. It also kept a four-lane
  //               road from having three clean lanes left beside it.
  //
  // The bound is on the ARTWORK (`extent`), not the collision box, since the
  // glow is what the player actually sees crossing a line. See TRESTLE_WIDTH and
  // BARRELS_WIDTH in obstacleshapes.js.
  //
  // PLACE_CENTRE is deliberately exempt: the tetra is meant to straddle the
  // centre-line and take a bite out of both middle lanes.
  for (const type of OBSTACLE_TYPES) {
    if (type.placement !== PLACE_LANE && type.placement !== PLACE_SIDE) continue;
    const shape = OBSTACLE_SHAPES[type.shape];
    const [w] = shape.size;
    assert.ok(
      w <= LANE_WIDTH,
      `${type.id} is ${w}px wide but a lane is only ${LANE_WIDTH}px`,
    );
    assert.ok(
      shape.extent.x <= LANE_WIDTH / 2,
      `${type.id}'s artwork reaches ${shape.extent.x}px, past its lane's ${LANE_WIDTH / 2}px edge`,
    );
  }
});

test("every obstacle extent is derived from the shape's own geometry", () => {
  // THIS TEST GUARDS THE TEST ABOVE. The lane-fit assertion is only worth
  // anything if `extent` is the artwork's real reach, and for three of the four
  // shapes it once was not: the trestle declared 29 and drew 33, the tetra
  // declared 37.8 and drew 39, the caltrop declared 20 and drew 21. Nothing
  // broke visibly — sprites.js pads by GLOW_PAD, which absorbed the shortfall —
  // but the lane-fit test was passing on a number that was not the drawing, and
  // the trestle really was half a pixel over its lane edge.
  //
  // The honest check would render each shape and scan the pixels. Node has no
  // canvas, and an obstacle's artwork is a draw() call rather than the point
  // data carShapeExtent gets to measure, so that check cannot run here — see
  // GLOW_BLEED in obstacleshapes.js for the browser snippet that does it.
  //
  // What CAN be enforced headlessly is the discipline that made the numbers
  // right: every extent field must be an expression over the shape's own named
  // constants plus a measured *_BLEED, never a literal somebody typed. A
  // hand-typed number is a claim no one re-measures; a derived one moves when
  // the geometry moves.
  const src = readFileSync(new URL("../src/game/obstacleshapes.js", import.meta.url), "utf8");

  // Extent objects contain no nested braces, so a non-greedy brace match is
  // enough of a parser here.
  const blocks = src.match(/extent:\s*\{[^}]*\}/g) ?? [];
  assert.equal(
    blocks.length,
    OBSTACLE_SHAPES.length,
    "every shape should declare exactly one extent block that this test can read",
  );

  for (const block of blocks) {
    const body = block.replace(/extent:\s*\{/, "").replace(/\}$/, "");
    const fields = body.split(",").map((f) => f.trim()).filter(Boolean);
    assert.deepEqual(
      fields.map((f) => f.split(":")[0].trim()),
      ["x", "up", "down"],
      `extent must declare x, up and down: ${block}`,
    );
    for (const field of fields) {
      const expr = field.slice(field.indexOf(":") + 1).trim();
      assert.match(
        expr,
        /_BLEED\b/,
        `extent field "${field}" must add a measured glow bleed — the artwork ` +
        "reaches past its geometry, and that is the part that leaves the lane",
      );
      // ...and no TERM of the sum may be a bare number, which is what rules out
      // the old `x: 20 + GLOW_BLEED` shape of thing: the bleed was named, but
      // the reach it was added to was still typed from memory. A divisor is
      // fine (TRESTLE_WIDTH / 2 is half a named width, not a guess).
      for (const term of expr.split("+")) {
        assert.match(
          term.trim(),
          /[A-Z][A-Z0-9_]*/,
          `extent field "${field}" adds a bare number — derive it from the ` +
          "shape's own constants so it moves when the artwork does",
        );
      }
    }
  }
});

test("a spawn never closes the road, whatever the placement asks for", () => {
  // THE PASSAGE RULE (game/obstacles.js), which replaced a lane count: the
  // question is whether a drivable gap survives, not whether a lane index is
  // free. Four mines on four lane centres pass a lane count and are impassable,
  // which is exactly the case the old rule got wrong.
  const obstacles = new Obstacles(new Explosions());
  const mine = obstacleTypeById("caltrop");
  const [mineW] = OBSTACLE_SHAPES[mine.shape].size;
  // AMBIENT TYPES ONLY, matching obstacles.js's own WIDEST_CAR — a `staged`
  // type is never produced by the spawner and is deliberately outside this
  // promise. See that file for why the boss's 62px hull is not allowed to set
  // the guaranteed gap for every hazard in the game.
  const widest = Math.max(...CAR_TYPES.filter((t) => !t.staged).map((t) => t.w));

  // Park mines wall-to-wall across the whole road, spaced so every gap between
  // them is narrower than the widest car in the catalogue — a fixture that
  // blocks the road by construction, independent of LANE_WIDTH/ROAD_HALF_WIDTH.
  const step = mineW + widest - 1;
  for (let offset = -ROAD_HALF_WIDTH + mineW / 2; offset - mineW / 2 < ROAD_HALF_WIDTH; offset += step) {
    obstacles.list.push({
      alive: true, laid: false, worldY: 1000, offset, w: mineW, h: 26,
    });
  }

  for (const type of OBSTACLE_TYPES) {
    assert.equal(
      obstacles.freeOffset(type, 1000, []),
      null,
      `${type.id} was placed on a road that already has no way through`,
    );
  }
});

test("the passage rule is sized against the widest car in the catalogue", () => {
  // A relation between two files: obstacles.js promises a way through, and that
  // promise is only worth making if the rig can use it. Widen a car past the gap
  // the spawner guarantees and the road starts producing hazards the heaviest
  // traffic cannot get around however well it drives.
  const obstacles = new Obstacles(new Explosions());
  // AMBIENT TYPES ONLY, matching obstacles.js's own WIDEST_CAR — a `staged`
  // type is never produced by the spawner and is deliberately outside this
  // promise. See that file for why the boss's 62px hull is not allowed to set
  // the guaranteed gap for every hazard in the game.
  const widest = Math.max(...CAR_TYPES.filter((t) => !t.staged).map((t) => t.w));

  // One wall spanning the road from the left barrier, leaving exactly `gap` of
  // clear tarmac against the right one.
  const leaves = (gap) =>
    obstacles.leavesPassage(1000, -gap / 2, 2 * ROAD_HALF_WIDTH - gap);

  for (let gap = 0; gap <= 2 * ROAD_HALF_WIDTH; gap += 2) {
    if (leaves(gap)) {
      assert.ok(
        gap >= widest,
        `a ${gap}px gap was accepted, but the widest car is ${widest}px`,
      );
    }
  }
  // ...and it has to accept something, or the rule reduces to "never spawn".
  assert.ok(leaves(2 * ROAD_HALF_WIDTH), "an empty road must be placeable");
});

// --- Pickups -------------------------------------------------------------

test("every ammo pickup names a weapon the player's own Loadout actually carries", () => {
  const loadout = new Loadout();
  for (const type of PICKUP_TYPES) {
    if (type.kind !== AMMO) continue;
    assert.ok(
      loadout.get(type.weaponId),
      `${type.id} names weaponId "${type.weaponId}", which is not in the player's Loadout`,
    );
  }
});

test("an ammo pickup never offers more than the weapon's own magazine holds", () => {
  const loadout = new Loadout();
  for (const type of PICKUP_TYPES) {
    if (type.kind !== AMMO) continue;
    const weapon = loadout.get(type.weaponId);
    assert.ok(
      type.amount <= weapon.type.ammo,
      `${type.id} refills ${type.amount}, more than the ${weapon.type.ammo}-round magazine it tops up`,
    );
  }
});

test("every pickup type resolves to a real shape", () => {
  for (const type of PICKUP_TYPES) {
    assert.ok(PICKUP_SHAPES[type.shape], `${type.id} names a shape index that doesn't exist`);
  }
});

test("Weapon.refill tops up ammo without ever exceeding the catalogue's own starting figure", () => {
  const rocket = WEAPON_TYPES.find((t) => t.id === "rocket");
  const w = new Weapon(rocket);
  w.ammo = 10;
  w.refill(1000);
  assert.equal(w.ammo, rocket.ammo, "refill must cap at the weapon's own starting ammo");
});

test("Player.heal restores hull without ever exceeding maxHealth", () => {
  const player = new Player(0, 0);
  player.damage(50);
  player.heal(1000);
  assert.equal(player.health, player.maxHealth);
});

test("a shielded player takes no damage from any source", () => {
  // player.js: every damage source in the game (bullets, blast, ramming,
  // wall-scrape) funnels through Player.damage, so guarding it there is the
  // shield's whole implementation — this is the test that proves it.
  const player = new Player(0, 0);
  player.activateShield(2);
  player.damage(9999);
  assert.equal(player.health, player.maxHealth, "a shielded player must take zero damage");
});

test("a second shield extends the timer rather than stacking on top of it", () => {
  const player = new Player(0, 0);
  player.activateShield(2);
  player.activateShield(1); // shorter — must not shrink the running shield
  assert.equal(player.shieldTime, 2);
  player.activateShield(5); // longer — must extend it
  assert.equal(player.shieldTime, 5);
});

test("applyPickup dispatches every kind in the catalogue correctly", () => {
  const player = new Player(0, 0);
  const loadout = new Loadout();

  const ammoType = PICKUP_TYPES.find((t) => t.kind === AMMO);
  const weapon = loadout.get(ammoType.weaponId);
  weapon.ammo = 0;
  applyPickup(ammoType, player, loadout);
  assert.equal(weapon.ammo, ammoType.amount);

  const healType = PICKUP_TYPES.find((t) => t.kind === HEAL);
  player.damage(50);
  applyPickup(healType, player, loadout);
  assert.equal(player.health, player.maxHealth);

  // A shield crate ARMS the shield rather than starting it (player.js's
  // chargeShield): nothing is running until something hits the car.
  const shieldType = PICKUP_TYPES.find((t) => t.kind === SHIELD);
  applyPickup(shieldType, player, loadout);
  assert.equal(player.shieldCharge, shieldType.duration);
  assert.equal(player.shieldTime, 0);

  const boostType = PICKUP_TYPES.find((t) => t.kind === BOOST);
  applyPickup(boostType, player, loadout);
  assert.equal(player.boostTime, boostType.duration);
  assert.equal(player.boost, boostType.amount);
});

test("a charged shield opens its window on the first hit, and eats that hit", () => {
  // The whole point of charging: the crate is spent on damage, not on the
  // empty road that followed it. The hit that trips the shield must itself be
  // deflected — the charge is checked BEFORE the hull is touched.
  const player = new Player(0, 0);
  player.chargeShield(5);
  assert.equal(player.shieldTime, 0, "a charged shield must not be running yet");

  player.damage(9999);
  assert.equal(player.health, player.maxHealth, "the hit that trips the shield must be deflected too");
  assert.equal(player.shieldTime, 5);
  assert.equal(player.shieldCharge, 0, "the charge is spent");
});

test("a crate taken mid-window prolongs the running shield instead of banking", () => {
  // player.js's chargeShield: with a window already open there is nothing to
  // bank for, so the crate is spent on the fight the player is already in.
  const player = new Player(0, 0);
  player.activateShield(2);
  player.chargeShield(5);
  assert.equal(player.shieldTime, 7, "the running window must have grown by the crate");
  assert.equal(player.shieldCharge, 0, "...and nothing must have been banked behind it");

  player.damage(10);
  assert.equal(player.health, player.maxHealth, "the extended window still deflects");
  assert.equal(player.shieldTime, 7, "a hit inside the window costs it nothing");
});

test("a shield extension carries the DEFLECTOR bonus, like every other shield", () => {
  const player = new Player(0, 0);
  player.shieldBonus = 3;
  player.activateShield(2); // 2 + 3
  player.chargeShield(5); // + 5 + 3
  assert.equal(player.shieldTime, 13);
});

test("a second charge stacks onto the bank rather than capping at the longer one", () => {
  // Unlike activateShield (a RUNNING shield, which is not additive), a charge
  // not yet running has cost the player nothing yet — so a second crate found
  // before the first hit lands adds to the bank instead of being wasted.
  const player = new Player(0, 0);
  player.chargeShield(5);
  player.chargeShield(2);
  assert.equal(player.shieldCharge, 7);
  player.chargeShield(9);
  assert.equal(player.shieldCharge, 16);
});

test("the DEFLECTOR bonus applies when a charge fires, not when it is banked", () => {
  // Bonus at ACTIVATION time (player.js's chargeShield header): a deflector
  // bought between the crate and the hit still counts toward that shield.
  const player = new Player(0, 0);
  player.chargeShield(5);
  player.shieldBonus = 3;
  player.damage(10);
  assert.equal(player.shieldTime, 8);
});

// --- The overdrive buff (pickuptypes.js's BOOST) ---------------------------

test("every BOOST pickup carries both of the numbers its effect needs", () => {
  for (const type of PICKUP_TYPES) {
    if (type.kind !== BOOST) continue;
    assert.ok(type.amount > 0, `${type.id} lifts the speed band by nothing`);
    assert.ok(type.duration > 0, `${type.id} lifts the speed band for no time at all`);
  }
});

// engine/input.js reads the keyboard through whatever target initInput is
// handed, so a bare EventTarget standing in for `window` is enough to hold the
// brake down for a test — no globals, and nothing in player.js has to grow a
// seam it would not otherwise have.
const keyboard = new EventTarget();
initInput(keyboard);
function holdBrake(down) {
  keyboard.dispatchEvent(
    Object.assign(new Event(down ? "keydown" : "keyup"), { code: "KeyS", repeat: false }));
}

test("a boost lifts BOTH ends of the player's speed band by its amount", () => {
  const player = new Player(0, 0);
  const stockMin = player.minSpeed;
  const stockTop = player.topSpeed;
  assert.equal(stockMin, MIN_SPEED);

  player.activateBoost(200, 6);
  assert.equal(player.minSpeed, stockMin + 200);
  assert.equal(player.topSpeed, stockTop + 200);
});

test("a boost drives the car up to the raised floor without touching the throttle", () => {
  const player = new Player(0, 0);
  const bounds = { left: -10000, right: 10000 };
  player.speed = MIN_SPEED;

  player.activateBoost(200, 6);
  player.update(1 / 60, bounds);
  assert.ok(player.speed > MIN_SPEED,
    "the raised floor is what makes a boost felt without the player doing anything");
  assert.ok(player.speed < MIN_SPEED + 200,
    "but it is a spool-up, not a one-frame jump of the whole lift");
  assert.equal(player.speed, MIN_SPEED + BAND_RECOVER / 60, "climbing at exactly BAND_RECOVER");

  // Long enough to cover the 200 at BAND_RECOVER, with room to spare — and the
  // ramp must STOP at the floor rather than sail past it.
  for (let i = 0; i < 60; i++) player.update(1 / 60, bounds);
  assert.equal(player.speed, MIN_SPEED + 200, "and it settles exactly on the raised floor");
});

test("a running boost takes the brake away — the floor cannot be driven under", () => {
  const player = new Player(0, 0);
  const bounds = { left: -10000, right: 10000 };
  holdBrake(true); // full brake, held for the whole test

  try {
    player.activateBoost(200, 6);
    for (let i = 0; i < 120; i++) player.update(1 / 60, bounds);
    assert.equal(player.speed, MIN_SPEED + 200,
      "braking against a running overdrive must not move the car off its raised floor");
  } finally {
    holdBrake(false);
  }
});

test("a boost expires on its own clock and drops the car back to its stock band", () => {
  const player = new Player(0, 0);
  const bounds = { left: -10000, right: 10000 };

  player.activateBoost(200, 0.5);
  // Put the car at the top of the RAISED band. The clamp is what allows it to
  // sit there; the throttle is what would actually get it there in play.
  player.speed = player.topSpeed;
  player.update(0.25, bounds);
  assert.ok(player.boostTime > 0, "half a boost's duration must not end it");
  assert.equal(player.speed, player.maxSpeed + 200, "a boosted car may exceed its stock ceiling");

  player.update(0.25, bounds);
  assert.equal(player.boostTime, 0);
  assert.equal(player.boost, 0);
  assert.equal(player.topSpeed, player.maxSpeed);
  // The ceiling is back, but the car COASTS down to it rather than dropping —
  // one tick of BAND_RECOVER off the raised top speed, not 200 at once.
  assert.equal(player.speed, player.maxSpeed + 200 - BAND_RECOVER * 0.25);

  for (let i = 0; i < 60; i++) player.update(1 / 60, bounds);
  assert.equal(player.speed, player.maxSpeed, "the stock ceiling must be back in force");
});

test("a second boost stacks its CLOCK but never its LIFT", () => {
  // player.js's activateBoost: duration is the half that cannot break the
  // speed band however much of it piles up, so it is the half that adds.
  const player = new Player(0, 0);

  player.activateBoost(200, 6);
  player.activateBoost(120, 2); // weaker — the lift is unchanged, the clock still grows
  assert.equal(player.boost, 200);
  assert.equal(player.boostTime, 8);

  player.activateBoost(300, 1); // stronger — takes the lift, and adds its second
  assert.equal(player.boost, 300);
  assert.equal(player.boostTime, 9);

  player.activateBoost(50, 9); // weaker again — keeps the strong lift, adds the time
  assert.equal(player.boost, 300);
  assert.equal(player.boostTime, 18);
});

test("a boost rides on top of whatever the shop's ENGINE tiers already bought", () => {
  const player = new Player(0, 0);
  player.applyUpgrades({ maxSpeed: 800, mass: player.mass, shieldBonus: 0, maxHealth: player.maxHealth });

  player.activateBoost(200, 6);
  assert.equal(player.topSpeed, 1000, "the buff is added to the UPGRADED ceiling, not to the stock one");
});

test("driving onto a pickup applies its effect, removes the crate and bursts once", () => {
  const explosions = new Explosions();
  const pickups = new Pickups(explosions);
  const player = new Player(300, 496);
  const loadout = new Loadout();

  const type = pickupTypeById("fix");
  const [w, h] = PICKUP_SHAPES[type.shape].size;
  const worldY = 500;
  pickups.list.push({ type, worldY, offset: 0, alive: true, age: 0, pulsePhase: 0, w, h });

  player.damage(50);
  const world = { player, distance: worldY, W: 600, H: 800, loadout };
  player.x = centerXAt(worldY, world.W);

  pickups.update(1 / 60, world);

  assert.equal(player.health, player.maxHealth, "the FIX crate should have healed the player");
  assert.equal(pickups.list.length, 0, "a collected crate must not remain on the road");

  const alive = explosions.slots.filter((s) => s.alive);
  assert.equal(alive.length, 1, "collecting a crate should spawn exactly one burst");
});

test("Pickups.drop places a crate at an exact spot, bypassing the random spawner", () => {
  // main.js's own use of this: a destroyed hostile's chance to leave a FIX
  // crate exactly where it died, not somewhere the random road spawner
  // would have put one — see Pickups.drop's header for why it needs no
  // separate budget the way obstacles.js's own drop() does.
  const pickups = new Pickups(new Explosions());
  const type = pickupTypeById("fix");
  pickups.drop(type, 1234, -40);

  assert.equal(pickups.list.length, 1);
  const dropped = pickups.list[0];
  assert.equal(dropped.type, type);
  assert.equal(dropped.worldY, 1234);
  assert.equal(dropped.offset, -40);
});

// --- The motorcycle fleet -----------------------------------------------------
//
// The three hostiles that fight from somewhere other than dead astern
// (cartypes.js's own section on them). What is pinned here is the part of each
// that spans two files — a hold gap against the gun's reach, a sweep against
// the steering that has to ride it, a payload against the catalogue it comes
// from — and not the tuning, which is allowed to move.

// One of the fleet, real type, real profile, real kit, driven for one tick with
// the player wherever the caller puts them. `hostileScenario` above is the
// interceptor's fixture and hard-codes its speeds; this is the same idea with
// the type as an argument, since these three differ in speed by design.
function bikeScenario(id, over = {}, playerOver = {}) {
  const type = CAR_TYPES.find((t) => t.id === id);
  const speed = type.speedMax;
  const car = driver({
    worldY: 0, offset: 0, w: type.w, h: type.h,
    speed, cruiseSpeed: speed, baseSpeed: speed, targetSpeed: speed, targetOffset: 0,
    type, drive: drivingFor(type), arms: armFor(type),
    ...over,
  });
  const playerBody = {
    worldY: 300, offset: 0, w: 34, h: 60, speed: 400, alive: true,
    damage() {},
    ...playerOver,
  };
  const fired = [];
  const laid = [];
  const world = {
    cars: [car], obstacles: [], playerBody,
    player: new Player(300, 496), H: 800,
    fireShot: (c, ty, dir) => fired.push({ car: c, type: ty, dir }),
    dropMine: (c, ty) => (laid.push({ car: c, type: ty }), true),
  };
  const tick = (dt = 1 / 60) => driveCar(car, dt, world);
  tick();
  return { car, world, fired, laid, tick };
}

// Every type driving the named tactic, with the profile it actually reads. The
// three fields below are on EVERY profile (driving.js states every knob once,
// on the commuter), but only the tactic that reads one can be wrong about it —
// a sedan's `weaveSpan` is inert, and holding it to a bike's arithmetic would
// be inventing a constraint the game does not have.
function typesDoing(...behaviours) {
  return CAR_TYPES.filter((t) => behaviours.includes(t.behaviour))
    .map((t) => ({ type: t, drive: drivingFor(t) }));
}

test("a hostile that holds station ahead of the player holds it inside its own gun's reach", () => {
  // behaviours.js's `outrun` parks at the profile's `leadHold` and then shoots
  // BACK down the road, which armament.js will only allow between
  // GUN_MIN_RANGE and GUN_RANGE. Outside that band the tactic still drives
  // perfectly and simply never fires — a hostile posing out of range, which is
  // the one failure nothing on screen would explain.
  // `patrol` (the gunship) holds station on exactly the same terms and shoots
  // back down the road with exactly the same gun, so it is bound by exactly the
  // same band — see behaviours.js, which borrows `outrun`'s hold unchanged.
  const holders = typesDoing("outrun", "patrol");
  assert.ok(holders.length > 0, "no type attacks from in front any more");
  for (const { type, drive } of holders) {
    assert.ok(
      drive.leadHold > GUN_MIN_RANGE && drive.leadHold < GUN_RANGE,
      `${type.id} holds station ${drive.leadHold} ahead of the player, outside the ` +
        `${GUN_MIN_RANGE}..${GUN_RANGE} band its gun will fire in`,
    );
  }
});

test("a hold ahead of the player is a hold the player can still see", () => {
  // The other half of armament.js's range rule, and usually the binding one: a
  // rearward shot is refused beyond the road VISIBLE ahead of the player, which
  // is their own framing and nothing to do with GUN_RANGE. A car holding
  // station past that would be shooting from off the top of the screen — the
  // unattributable hit that rule exists to prevent.
  //
  // The framing is main.js's `H * 0.62`, which is DOM-bound and cannot be
  // imported here; the same pair of figures is already written out in this
  // file's own hostile fixtures, and this is deliberately the more pessimistic
  // reading of the two (a shorter canvas shows less road ahead).
  const visibleAhead = 800 * 0.62;
  // BOTH front-holding tactics, and this is the half of the rule that survives
  // the boss having no gun: `siege` (behaviours.js) opts out of the gun-band
  // test above precisely because it carries nothing to shoot with, but "the
  // player must be able to SEE the thing attacking them" is about framing
  // rather than about weapons and binds every tactic that parks up the road.
  for (const { type, drive } of [...typesDoing("outrun"), ...typesDoing("siege")]) {
    assert.ok(
      drive.leadHold < visibleAhead,
      `${type.id} holds ${drive.leadHold} ahead of a player who can only see ` +
        `${visibleAhead} of road up there`,
    );
  }
});

test("a weave is a sweep the steering can actually ride", () => {
  // behaviours.js's `strafe` chases a sine across the player's line: the target
  // travels 4 * weaveSpan in one weaveTime, and a car that cannot cover that
  // never arrives at either end. The failure is silent and looks like a tuning
  // preference — the bike drifts about instead of sweeping — so the relation is
  // checked against the TYPE's own steering rather than left in a comment.
  // `patrol` rides the same sine off the same two fields, against the frame
  // instead of the barriers — the arithmetic that has to hold is identical.
  const weavers = typesDoing("strafe", "patrol");
  assert.ok(weavers.length > 0, "nothing sweeps across the player's line any more");
  for (const { type, drive } of weavers) {
    const swept = 4 * drive.weaveSpan;
    const covered = type.steerSpeed * drive.weaveTime;
    assert.ok(
      covered >= swept,
      `${type.id} sweeps ${swept}px in ${drive.weaveTime}s, which its ${type.steerSpeed}` +
        `px/sec steering cannot cover — the weave would come out as a drift`,
    );
  }
});

// --- The air ------------------------------------------------------------------
//
// cartypes.js's `airborne` says one thing — this body is not in the road plane —
// and four systems each read it once to say what that costs. These pin the two
// halves that are arithmetic rather than assertion: which rounds may reach it,
// and whether the one weapon that may can actually catch it.

const GUNSHIP = CAR_TYPES.find((t) => t.id === "gunship");
const CANNON_TYPE = WEAPON_TYPES.find((t) => t.id === "cannon");

test("only a SEEKING round can reach an airborne body", () => {
  // projectiles.js's firstHit: a straight round buries itself in a barrier at
  // road level and a tracking round holds the lane it was fired up, so neither
  // ever leaves the road plane. The rocket climbs. This is the whole rule the
  // gunship exists to state, and it is the one that would be silently undone by
  // a well-meaning "let it be shot at while it is over the tarmac".
  //
  // Every round here is fired STRAIGHT AT IT, dead on its offset and well
  // inside its box — so nothing but the rule itself can be what stops them.
  for (const weapon of [CANNON_TYPE, TRACKER_TYPE]) {
    const shots = new Projectiles();
    shots.spawn(0, 0, 400, weapon, 600);
    const air = dummy(600, 0, 1, weapon.damage, { airborne: true });
    for (let i = 0; i < 200 && air.alive; i++) shots.update(1 / 60, [air], SHOT_VIEW);
    assert.equal(
      air.taken,
      0,
      `the ${weapon.id} reached something flying, which only a seeker may do`,
    );
  }

  const shots = new Projectiles();
  shots.spawn(0, 0, 400, ROCKET_TYPE, 600);
  const air = dummy(600, 0, 1, ROCKET_TYPE.damage, { airborne: true });
  for (let i = 0; i < 200 && air.alive; i++) shots.update(1 / 60, [air], SHOT_VIEW);
  assert.ok(!air.alive, "the rocket must be able to reach what nothing else can");
});

test("a blast at road level does not reach the air", () => {
  // collisions.js's inBlastPlane, asked here through the sweep most likely to
  // break the rule by accident: a rocket's own splash. Without it the player
  // could kill a gunship by detonating something underneath it, which is
  // precisely the shot the design says is impossible.
  const shots = new Projectiles();
  shots.spawn(0, 0, 400, ROCKET_TYPE, 600);
  // The round's actual target, on the road, with an airborne body parked right
  // beside it — well inside the rocket's own blast radius.
  const ground = dummy(600, 0, 1, ROCKET_TYPE.damage);
  const air = dummy(600, 20, 8, ROCKET_TYPE.damage, { airborne: true });

  for (let i = 0; i < 200 && ground.alive; i++) shots.update(1 / 60, [ground, air], SHOT_VIEW);

  assert.ok(!ground.alive, "the rocket should have killed what it was aimed at");
  assert.equal(air.taken, 0, "the splash reached something flying above the blast");
});

test("the gunship dies to exactly the four rockets its record documents", () => {
  // cartypes.js: "FOUR ROCKETS EXACTLY. The rocket does 98, so 392 is four
  // rounds with nothing wasted and three rounds (294) comfortably short." Both
  // halves are checked — a hull that crept up would make it five and a hull that
  // crept down would make the comment a lie in the other direction.
  const rounds = GUNSHIP.health / ROCKET_TYPE.damage;
  assert.equal(
    rounds,
    4,
    `the gunship's ${GUNSHIP.health} hull is ${rounds} rockets at ${ROCKET_TYPE.damage}, not 4`,
  );
});

test("the rocket can out-turn the only thing it is allowed to shoot at", () => {
  // cartypes.js prices the gunship's steerSpeed directly against weapons.js's
  // turnRate, and it is the one relation that can make this enemy unkillable:
  // the rocket is the ONLY round permitted to reach it, so a gunship that could
  // out-slide a seeker could not be killed by anything at all.
  assert.ok(
    ROCKET_TYPE.turnRate > GUNSHIP.steerSpeed,
    `the gunship slides at ${GUNSHIP.steerSpeed}/sec and the rocket steers at ` +
      `${ROCKET_TYPE.turnRate}/sec — the only weapon allowed to hit it cannot catch it`,
  );
});

test("an airborne car is never handed to the ramming solver", () => {
  // traffic.js's collide(). A flying body resolved in flat road coordinates
  // would let the player ram something in the air above them,
  // which is the one thing that would flatly contradict the artwork. Driven
  // through the real Traffic rather than asserted against the flag, so it is the
  // BEHAVIOUR that is pinned and not the line of code that implements it.
  // One tick of the real Traffic with the player parked exactly on top of a
  // staged car. Returns what the collision cost each of them.
  const rammed = (type) => {
    const traffic = new Traffic();
    const player = new Player(300, 496, () => {});
    const car = traffic.place(type, 0, 1, 620, true);
    assert.ok(car, `${type.id} should have been placed`);
    player.x = centerXAt(0, 600) + car.offset;
    const carBefore = car.health;
    const playerBefore = player.health;
    traffic.update(1 / 60, { player, distance: 0, W: 600, H: 800 });
    return { car: carBefore - car.health, player: playerBefore - player.health };
  };

  // THE CONTROL, and it is what makes the assertion below mean anything: the
  // identical overlap with a car that IS on the road has to hurt, or "the
  // gunship took no damage" would be proving that this setup is not a collision
  // rather than that altitude is why.
  const control = rammed(CAR_TYPES.find((t) => t.id === "rival"));
  assert.ok(control.car > 0 && control.player > 0, "the setup is not a real overlap");

  const air = rammed(GUNSHIP);
  assert.equal(air.car, 0, "the gunship took ram damage from a car below it");
  assert.equal(air.player, 0, "the player was charged for ramming something in the air");
});

test("the gunship actually flies off the tarmac, and never out of frame", () => {
  // BOTH HALVES OF ITS LATERAL BOUND, and this test exists because the first
  // half was silently wrong. `clampToRoad` is called from TWO places in
  // traffic.js — once per car per tick, and once more after the collision pass —
  // and guarding only the second held the gunship to 108px of the 150px sweep
  // its profile asks for. Nothing failed; it just quietly stopped being a
  // flying thing and read as a very wide car. So the assertion is on the
  // OBSERVED sweep of a real Traffic tick, not on the guard.
  //
  // The other half is the bound that replaces the road's: behaviours.js's
  // FLIGHT_MARGIN keeps the whole hull inside the frame, and the worst case for
  // it is the player hard against a barrier with the sweep reaching further
  // that way still — so the player is driven to both edges, not just the middle.
  const W = 600;
  const half = GUNSHIP.w / 2;
  const edge = ROAD_HALF_WIDTH - 20;

  for (const playerOffset of [0, edge, -edge]) {
    const traffic = new Traffic();
    const player = new Player(W / 2, 496, () => {});
    player.speed = 620;
    const air = traffic.place(GUNSHIP, 800, 1, 620, true);
    air.staged = true;

    let reach = 0;
    let worstLeft = Infinity;
    let worstRight = -Infinity;
    let distance = 0;
    const dt = 1 / 60;
    const world = { player, distance, W, H: 800, fireShot: () => {} };

    // Two full weaves' worth, and the first three seconds are ignored so the
    // car is measured on its sweep rather than on its run in from the spawn.
    for (let i = 0; i < 60 * 20; i++) {
      distance += player.speed * dt;
      world.distance = distance;
      player.x = centerXAt(distance, W) + playerOffset;
      traffic.update(dt, world);
      if (!traffic.cars.includes(air)) break;
      if (i < 180) continue;
      reach = Math.max(reach, Math.abs(air.offset - playerOffset));
      const sx = centerXAt(air.worldY, W) + air.offset;
      worstLeft = Math.min(worstLeft, sx - half);
      worstRight = Math.max(worstRight, sx + half);
    }

    // IT GETS OFF THE ROAD. Not "it reaches its weaveSpan" — that would pass
    // against a clamp set anywhere past the sweep. What has to be true is the
    // thing the player sees: the hull leaves the tarmac entirely.
    const profile = drivingFor(GUNSHIP);
    assert.ok(
      reach > 0.9 * profile.weaveSpan,
      `the gunship swept ${reach.toFixed(0)}px of its profile's ${profile.weaveSpan} — ` +
        "something is holding it in, as the road clamp once did",
    );
    assert.ok(
      Math.abs(air.offset) + half > ROAD_HALF_WIDTH ||
        reach + Math.abs(playerOffset) + half > ROAD_HALF_WIDTH,
      "the gunship never left the tarmac, which is the whole of what makes it fly",
    );

    // ...AND STAYS IN SHOT. A sweep that wandered off the canvas would be an
    // enemy shooting at the player from somewhere they cannot look.
    assert.ok(
      worstLeft >= -1e-9 && worstRight <= W + 1e-9,
      `with the player at ${playerOffset} the gunship spanned x ${worstLeft.toFixed(0)}..` +
        `${worstRight.toFixed(0)}, outside the ${W}px frame`,
    );
  }
});

test("the sower carries a spike strip and one only", () => {
  // armament.js's `spiker`: the raider's shape of kit — nothing to shoot with,
  // one thing laid in the road — pointed at the other payload in the hazard
  // catalogue. The magazine of one is what makes behaviours.js's "lay it and
  // leave" literal rather than a comment.
  const arms = armFor(CAR_TYPES.find((t) => t.id === "sower"));
  assert.equal(arms.gun, null, "the sower must carry nothing to shoot with");
  assert.equal(arms.payload, obstacleTypeById("spikes"), "its payload must be the strip");
  assert.equal(arms.layer.type.ammo, 1, "one strip for the car's whole life");
  assert.ok(arms.payload.laidOnly, "the strip it lays must still be a laid-only hazard");
});

test("a sower lays its strip ahead of the player, then leaves unarmed", () => {
  // The whole errand in two ticks. The first has it holding station at the far
  // end of the layer's window with the player lined up behind it, which is what
  // armament.js needs to let the drop go; the second is the run-out.
  const { car, laid, tick } = bikeScenario("sower", {}, { worldY: -430, speed: 400 });
  assert.equal(laid.length, 1, "expected one strip");
  assert.equal(laid[0].type, obstacleTypeById("spikes"), "the payload must be the strip");

  tick();
  assert.equal(car.arms, null, "a fleeing sower must be disarmed, not merely quiet");
  assert.equal(
    car.targetSpeed,
    car.type.speedMax,
    "the run-out is at the top of its band, or it is not an escape",
  );
  assert.equal(laid.length, 1, "it must not carpet the road on the way out");
});

test("an outrunner shoots back down the road from in front", () => {
  // The one hostile that attacks from ahead. Placed at exactly its own
  // `leadHold`, which is where its tactic settles, so this asserts the hold and
  // the shot agree — a hold the gun refuses would be the whole tactic doing
  // nothing.
  const type = CAR_TYPES.find((t) => t.id === "outrunner");
  const hold = drivingFor(type).leadHold;
  const { fired } = bikeScenario("outrunner", {}, { worldY: -hold, speed: 400 });
  assert.equal(fired.length, 1, "expected exactly one round");
  assert.equal(fired[0].dir, -1, "a player behind must be shot at back down the road");
  assert.ok(!fired[0].type.forwardOnly, "a rearward shooter cannot carry a forward-only gun");
});

test("an outrider sweeps across the player's line rather than parking on it", () => {
  // `strafe`'s one difference from `pursue`, and the reason a 30-hull bike can
  // hold a gap at all: it is never on the line it was on a second ago. Two
  // seconds of ticks must put it well clear of the player's line on BOTH sides.
  const { car, tick } = bikeScenario("outrider", {}, { worldY: 300, speed: 400 });
  let left = 0;
  let right = 0;
  for (let i = 0; i < 120; i++) {
    tick();
    left = Math.min(left, car.targetOffset);
    right = Math.max(right, car.targetOffset);
    assert.ok(
      Math.abs(car.targetOffset) <= ROAD_HALF_WIDTH,
      "the sweep must stay on the tarmac",
    );
  }
  const span = car.drive.weaveSpan;
  assert.ok(right > span / 2, `the sweep never reached the right (${right.toFixed(1)}px)`);
  assert.ok(left < -span / 2, `the sweep never reached the left (${left.toFixed(1)}px)`);
});

// --- The boss: the siege battery ----------------------------------------------
//
// Cross-file invariants for the one enemy that attacks the ROAD rather than a
// car. Everything here is a relation between armament.js, shells.js and the
// catalogue — the arithmetic that decides whether the fight is dodgeable at all,
// and the rules that keep the boss out of the ambient road.

// A boss in position: ahead of the player, holding station, full hull. Built on
// the same driver fixture the bikes use, with the world hook shells.js is
// actually driven through in the game.
function bossScenario(over = {}, playerOver = {}) {
  const type = CAR_TYPES.find((t) => t.id === "mortar");
  const speed = type.speedMax;
  const shells = new Shells();
  const car = driver({
    worldY: 420, offset: 0, w: type.w, h: type.h,
    speed, cruiseSpeed: speed, baseSpeed: speed, targetSpeed: speed, targetOffset: 0,
    type, drive: drivingFor(type), arms: armFor(type),
    health: type.health,
    ...over,
  });
  const playerBody = {
    worldY: 0, offset: 0, w: 34, h: 60, speed: 400, alive: true,
    damage() {},
    ...playerOver,
  };
  const laid = [];
  const world = {
    cars: [car], obstacles: [], playerBody,
    player: new Player(300, 496), H: 800,
    fireShot: () => {},
    dropMine: (c, ty) => (laid.push({ car: c, type: ty }), true),
    fireShell: (...a) => shells.fire(...a),
  };
  const tick = (dt = 1 / 60) => driveCar(car, dt, world);
  return { car, world, shells, laid, tick };
}

// Run the car until the battery has fired, or give up. Returns the ticks spent,
// which is how a phase is observed without reaching into the Weapon's cooldown.
function tickUntilShell(h, limit = 600) {
  const before = h.shells.list.filter((s) => s.alive).length;
  for (let i = 0; i < limit; i++) {
    h.tick();
    if (h.shells.list.filter((s) => s.alive).length > before) return i + 1;
  }
  return null;
}

test("the boss is never in the ambient draw, at any distance", () => {
  // cartypes.js's `staged`: the director places this by name (events.js) and
  // the spawner must never produce one. Asserted through typeAvailable itself
  // rather than through pickCarType's odds, so it holds even for a roll that
  // reweights down to a single eligible entry.
  const mortar = CAR_TYPES.find((t) => t.id === "mortar");
  assert.ok(mortar.staged, "the boss must be a staged type");
  for (const dist of [0, 1200, 1e9]) {
    assert.ok(!typeAvailable(mortar, dist * DIST_UNITS), `rollable at DIST ${dist}`);
  }
});

test("the battery carries no gun, so it can never trade fire with the player", () => {
  // carshapes.js's SIEGE MORTAR pitch — "no barrel aimed at you" — held to in
  // the kit rather than only in the artwork. A mortar that also plinked away
  // with a blaster would turn the boss back into every other pursuit.
  const mortar = CAR_TYPES.find((t) => t.id === "mortar");
  const kit = armamentFor(mortar);
  assert.equal(kit.gun, null, "the boss must carry nothing to shoot with");
  assert.ok(kit.battery, "...and must carry artillery");
});

test("a shell is aimed where the player will be, not where they are", () => {
  // armament.js's fireBarrage leads the target by the fuse. This is the whole
  // mechanic: hold your speed and you arrive with the shell, so the dodge is a
  // change of speed or lane rather than a reaction to a bullet.
  const h = bossScenario({}, { speed: 400 });
  assert.ok(tickUntilShell(h), "the battery never fired");
  const shell = h.shells.list.find((s) => s.alive);
  const fuse = armamentFor(h.car.type).battery.fuse;
  assert.ok(
    Math.abs(shell.worldY - (h.world.playerBody.worldY + 400 * fuse)) < 1,
    `shell landed at ${shell.worldY}, not at the player's ${fuse}s lead`,
  );
});

test("the fuse leaves the player real road to move in", () => {
  // The fuse is the fight. A player must be able to cross two lanes before the
  // shell arrives, or the barrage is not a dodge but a tax — the same two-lane
  // span behaviours.js sizes hazard placement by, asked of the boss's weapon
  // instead of of the road.
  const battery = armamentFor(CAR_TYPES.find((t) => t.id === "mortar")).battery;
  const lateral = 260; // the player's own steering rate (game/player.js)
  const crossable = lateral * battery.fuse;
  assert.ok(
    crossable >= LANE_WIDTH * 2,
    `a ${battery.fuse}s fuse only allows ${crossable.toFixed(0)}px of dodge, ` +
      `under the ${(LANE_WIDTH * 2).toFixed(0)}px two-lane span the road is built around`,
  );
});

test("the barrage escalates as the boss is hurt, and only then", () => {
  // armament.js's BARRAGE is keyed to DAMAGE rather than to elapsed time, so
  // the player's own progress is what makes the fight harder. A table that
  // escalated on a clock would punish a player for being slow, which is the
  // opposite of what this fight rewards.
  for (let i = 1; i < BARRAGE.length; i++) {
    assert.ok(BARRAGE[i].above < BARRAGE[i - 1].above, "thresholds must descend");
    assert.ok(BARRAGE[i].shells > BARRAGE[i - 1].shells, "each phase throws more");
    assert.ok(BARRAGE[i].interval < BARRAGE[i - 1].interval, "...and throws it sooner");
  }
  assert.equal(BARRAGE[BARRAGE.length - 1].above, 0, "the last phase must be the catch-all");
  assert.equal(barragePhase(1).shells, BARRAGE[0].shells, "a full boss opens on the first phase");
  assert.equal(
    barragePhase(0.01).shells,
    BARRAGE[BARRAGE.length - 1].shells,
    "a dying one is on the last",
  );
});

test("a straddle brackets the player's lane rather than landing to one side of it", () => {
  // The last phase's three shells are centred on the player's line, so the
  // pattern is symmetric and the dodge stops being "change lane". An off-centre
  // straddle would leave the same side free every time and be solvable once.
  const type = CAR_TYPES.find((t) => t.id === "mortar");
  const h = bossScenario({ health: type.health * 0.1 }, { offset: 0 });
  assert.ok(tickUntilShell(h), "the battery never fired");
  const offsets = h.shells.list.filter((s) => s.alive).map((s) => s.offset).sort((a, b) => a - b);
  assert.equal(offsets.length, 3, "the last phase throws three");
  assert.ok(Math.abs(offsets[0] + offsets[2]) < 1e-9, "the pattern must be centred");
  assert.equal(offsets[1], 0, "...with one shell dead on the player's line");
});

test("the battery shells a player it cannot see, which is why it cannot be outrun", () => {
  // The deliberate absence of a range gate (armament.js's fireBarrage). Every
  // other weapon refuses a shot the player could not see coming; indirect fire
  // does not, and that is the whole of why speed is not an escape from this
  // encounter. A player who runs still gets their fuse — the MARK is on screen
  // even when the battery is not — and loses only the ability to shoot back.
  const h = bossScenario({ worldY: 9000 }, { worldY: 0 });
  assert.ok(tickUntilShell(h), "a battery far up the road must still fire");
  const shell = h.shells.list.find((s) => s.alive);
  assert.ok(shell.worldY < 1000, "the shell must land on the PLAYER, not near the battery");
});

test("a shell hits whatever is standing on it, escort included", () => {
  // shells.js: indirect fire is not careful. A blast that spared the boss's own
  // side would be the game quietly explaining that the shells are only ever
  // about the player, and would take away the one thing a clever player can do
  // with them.
  const shells = new Shells();
  shells.fire(500, 0, 1, 70, 60);
  const escort = {
    worldY: 500, offset: 0, w: 40, h: 70, alive: true, hp: 100,
    damage(d) { this.hp -= d; },
  };
  shells.update(1.1, [escort]);
  assert.ok(escort.hp < 100, "a shell must damage a hostile standing on it");
});

test("a shell already in the air still lands after its battery dies", () => {
  // Killing the gun does not recall what it has already thrown — both fair and
  // the more interesting last second of the fight.
  const shells = new Shells();
  shells.fire(500, 0, 1, 70, 60);
  const player = {
    worldY: 500, offset: 0, w: 34, h: 60, alive: true, hp: 100,
    damage(d) { this.hp -= d; },
  };
  shells.update(0.5, []);   // the battery dies here; nothing else changes
  assert.ok(shells.live, "the round must still be in the air");
  shells.update(0.6, [player]);
  assert.ok(player.hp < 100, "and must still land");
});

test("the boss lays mines only once it is nearly dead", () => {
  // BARRAGE's last phase is the only one carrying `mines`. A boss laying from
  // full hull would be a second encounter running alongside the first.
  for (const phase of BARRAGE) {
    if (phase.above > 0) assert.ok(!phase.mines, "only the last phase lays");
  }
  const type = CAR_TYPES.find((t) => t.id === "mortar");
  const healthy = bossScenario({ health: type.health });
  for (let i = 0; i < 400; i++) healthy.tick();
  assert.equal(healthy.laid.length, 0, "a healthy battery must lay nothing");
});
