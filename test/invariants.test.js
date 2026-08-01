// Cross-file invariants — the relations the source documents in prose.
//
// WHY THIS FILE EXISTS. Cybercruise tunes itself through numbers that live in
// one file but constrain another: the traffic catalogue is pinned to the
// player's speed band, the follower's braking rule is sized against the widest
// closing speed that band can produce, and the sprite-cache budget is a product
// of the catalogue's length and the wheel-frame count. Every one of those is
// carefully explained in a comment — and a comment cannot fail. Retuning one
// number in cartypes.js could quietly invalidate a paragraph in behaviours.js
// and the road would start rear-ending itself with nothing to say so.
//
// So these are deliberately NOT unit tests of behaviour. They are assertions of
// the arithmetic the comments claim, placed so that changing a tuning number
// either keeps the claim true or fails here with the relation spelled out.
//
// Run with: npm test   (node --test, no dependencies)
//
// Everything imported here is DOM-free at module scope — spritecache.js only
// touches `document` inside getSprite, and input.js only reads `window` as a
// default argument — so the game's real modules load under plain Node.

import test from "node:test";
import assert from "node:assert/strict";

import { CAR_TYPES } from "../src/game/cartypes.js";
import { CAR_SHAPES, carShapeExtent } from "../src/game/carshapes.js";
import {
  ACCEL as TRAFFIC_ACCEL,
  RETIRE_MARGIN as TRAFFIC_RETIRE_MARGIN,
  Traffic,
} from "../src/game/traffic.js";
import { FOLLOW_REACTION, behaviourFor, dodgeDistance } from "../src/game/behaviours.js";
import { MIN_SPEED, MAX_SPEED, ACCEL as PLAYER_ACCEL, Player } from "../src/game/player.js";
import { WHEEL_FRAMES } from "../src/game/sprites.js";
import {
  LANE_COUNT, LANE_WIDTH, ROAD_HALF_WIDTH, laneAt, laneOffset, centerXAt,
} from "../src/game/road.js";
import { OBSTACLE_SHAPES } from "../src/game/obstacleshapes.js";
import { plotAt, plotColumns, plotRows, BUILDING, EMPTY } from "../src/game/citygrid.js";
import { resolveCollisions } from "../src/game/collisions.js";
import { Score, DISTANCE_POINTS } from "../src/game/score.js";
import { Loadout, Weapon, WEAPON_TYPES, ENEMY_WEAPON_TYPES } from "../src/game/weapons.js";
import {
  OBSTACLE_TYPES, obstacleTypeById, PLACE_LANE, PLACE_SIDE,
} from "../src/game/obstacletypes.js";
import { Obstacles, SPAWN_MARGIN as OBSTACLE_SPAWN_MARGIN } from "../src/game/obstacles.js";
import { Explosions } from "../src/game/effects.js";
import { Projectiles } from "../src/game/projectiles.js";
import { armFor, armamentFor } from "../src/game/armament.js";

const slowest = Math.min(...CAR_TYPES.map((t) => t.speedMin));
const fastest = Math.max(...CAR_TYPES.map((t) => t.speedMax));

// --- The speed band, and the braking rule sized against it -------------------

test("traffic can always shed the largest closing speed the catalogue allows", () => {
  // behaviours.js: a follower is given FOLLOW_REACTION seconds of closing rate
  // to brake in, which only covers the distance needed while
  //     largestClosing <= 2 * ACCEL * FOLLOW_REACTION
  // (shedding dv costs dv^2 / (2 * ACCEL) of road). Widen the band or drop
  // ACCEL without moving the other and traffic starts rear-ending itself.
  const largestClosing = fastest - MIN_SPEED;
  const canShed = 2 * TRAFFIC_ACCEL * FOLLOW_REACTION;
  assert.ok(
    largestClosing <= canShed,
    `largest closing speed ${largestClosing} exceeds what a follower can shed ` +
      `in ${FOLLOW_REACTION}s (${canShed}). Lower a speedMax, raise traffic ACCEL, ` +
      `or raise FOLLOW_REACTION.`,
  );
});

test("traffic cannot out-brake the player", () => {
  // traffic.js sizes its ACCEL "just under the player's own", so the player can
  // always change speed harder than the cars around them.
  assert.ok(
    TRAFFIC_ACCEL < PLAYER_ACCEL,
    `traffic ACCEL ${TRAFFIC_ACCEL} must stay under the player's ${PLAYER_ACCEL}`,
  );
});

test("the catalogue is pinned to both ends of the player's speed band", () => {
  // FLOOR: the slowest cruise is half again the player's minimum, so dawdling
  // makes the city stream past rather than making the road go quiet.
  assert.ok(
    slowest >= MIN_SPEED * 1.5,
    `slowest cruise ${slowest} must stay >= 1.5x the player's minimum ${MIN_SPEED}`,
  );
  // CEILING: something is always quicker than the player flat out, or holding
  // the throttle down would be enough to be left alone.
  assert.ok(
    fastest > MAX_SPEED,
    `fastest cruise ${fastest} must exceed the player's maximum ${MAX_SPEED}`,
  );
});

test("every car type has a coherent speed range", () => {
  for (const t of CAR_TYPES) {
    assert.ok(t.speedMin <= t.speedMax, `${t.id}: speedMin > speedMax`);
    assert.ok(t.speedMin > 0, `${t.id}: speedMin must be positive`);
  }
});

// --- The sprite-cache budget -------------------------------------------------

test("sprite-cache budget matches the figure cartypes.js documents", () => {
  // cartypes.js: "10 types * 8 * 2 = 160 sprites at the absolute worst" — one
  // per (type, wheel frame), doubled for the critical-hull blink colour. This is
  // what keeps the cache bounded, so it must not grow silently.
  const worstCase = CAR_TYPES.length * WHEEL_FRAMES * 2;
  assert.equal(
    worstCase,
    160,
    `traffic sprite worst case is now ${worstCase}, not the documented 160 ` +
      `(${CAR_TYPES.length} types x ${WHEEL_FRAMES} wheel frames x 2 colours)`,
  );
});

test("one car type per silhouette", () => {
  // cartypes.js opens with "ONE TYPE PER SILHOUETTE": a type is told apart by
  // its shape, since colour only carries faction and weight class.
  const shapes = CAR_TYPES.map((t) => t.shape);
  assert.equal(new Set(shapes).size, shapes.length, "two car types share a silhouette");
  assert.equal(shapes.length, CAR_SHAPES.length, "catalogue is no longer 1:1 with CAR_SHAPES");
});

test("carShapeExtent bounds every point of every shape", () => {
  // The extent decides the offscreen sprite's size. If it ever under-reports,
  // the artwork is silently clipped at the sprite edge — which looks like a
  // drawing bug, a long way from the shape that caused it.
  for (let i = 0; i < CAR_SHAPES.length; i++) {
    const shape = CAR_SHAPES[i];
    const [w, h] = shape.size;
    const ext = carShapeExtent(i, w, h);
    for (const profile of shape.parts ?? [shape.profile]) {
      for (const [fx, fy] of profile) {
        assert.ok(Math.abs(fx * (w / 2)) <= ext.x, `${shape.name}: x extent clips the profile`);
        assert.ok(-fy * (h / 2) <= ext.up, `${shape.name}: up extent clips the profile`);
        assert.ok(fy * (h / 2) <= ext.down, `${shape.name}: down extent clips the profile`);
      }
    }
  }
});

// --- Road geometry -----------------------------------------------------------

test("laneAt inverts laneOffset, and every lane sits on the tarmac", () => {
  for (let i = 0; i < LANE_COUNT; i++) {
    const offset = laneOffset(i);
    assert.equal(laneAt(offset), i, `lane ${i} does not round-trip`);
    assert.ok(Math.abs(offset) < ROAD_HALF_WIDTH, `lane ${i} centre is off the road`);
  }
});

test("laneAt clamps anything shoved past the barriers", () => {
  // Ramming knocks cars off their lane; laneAt is what the spawner reads to
  // avoid dropping traffic on top of them, so it must never return a bad index.
  assert.equal(laneAt(-ROAD_HALF_WIDTH * 4), 0);
  assert.equal(laneAt(ROAD_HALF_WIDTH * 4), LANE_COUNT - 1);
});

// --- The city floor is a pure function of its plot index ---------------------

test("plotAt is deterministic and total", () => {
  // citygrid.js's whole design rests on this: the city is infinite and identical
  // every time you drive past because nothing is stored. A plot that varied
  // between calls would make buildings flicker in and out as you approached.
  for (let bx = 0; bx < 6; bx++) {
    for (let by = -30; by < 30; by++) {
      const a = plotAt(bx, by);
      const b = plotAt(bx, by);
      assert.deepEqual(a, b, `plot (${bx}, ${by}) is not stable across calls`);
      assert.ok(a.type === BUILDING || a.type === EMPTY, `plot (${bx}, ${by}) has an unknown type`);
      if (a.type === BUILDING) {
        assert.ok(Number.isInteger(a.variant) && a.variant >= 0, "building variant must be an index");
      }
    }
  }
});

test("the visible floor stays a bounded walk", () => {
  // scenery.js walks every plot in view each frame, so this product is per-frame
  // work. It is small today; this pins it so it cannot creep.
  const rows = plotRows(0, 800 + 240);
  const plots = (rows.max - rows.min + 1) * plotColumns(600);
  assert.ok(plots <= 60, `floor walk grew to ${plots} plots per frame`);
});

// --- Ramming physics ---------------------------------------------------------

// A minimal body satisfying the interface collisions.js documents.
function body(over = {}) {
  return {
    worldY: 0, offset: 0, prevOffset: 0, w: 34, h: 60,
    speed: 0, vLateral: 0, mass: 1, alive: true, taken: 0,
    damage(hp) { this.taken += hp; },
    ...over,
  };
}

test("an equal-mass rear-end costs each car the documented hull", () => {
  // collisions.js: "At equal mass, a 300 unit/sec rear-end costs each car
  // (300-40) * 0.15 = 39 hull."
  const rear = body({ worldY: 0, speed: 400 });
  const front = body({ worldY: 50, speed: 100 });
  resolveCollisions([rear, front], 1 / 60);

  assert.equal(+rear.taken.toFixed(6), 39);
  assert.equal(+front.taken.toFixed(6), 39);
  // Momentum goes the right way, and nothing is left overlapping.
  assert.ok(rear.speed < 400, "the rear car should have been slowed");
  assert.ok(front.speed > 100, "the front car should have been shoved along");
  assert.ok(front.worldY - rear.worldY >= 60, "the pair are still inside each other");
});

test("low-speed contact is free", () => {
  // Parking against a car must cost nothing, or traffic would grind itself down
  // just by queueing. DAMAGE_FLOOR is 40.
  const rear = body({ worldY: 0, speed: 130 });
  const front = body({ worldY: 50, speed: 100 });
  resolveCollisions([rear, front], 1 / 60);
  assert.equal(rear.taken, 0);
  assert.equal(front.taken, 0);
});

test("a heavier car shrugs off a lighter one", () => {
  // Damage and movement split by INVERSE mass, so the light car comes off worse.
  const light = body({ worldY: 0, speed: 400, mass: 0.5 });
  const heavy = body({ worldY: 50, speed: 100, mass: 4 });
  resolveCollisions([light, heavy], 1 / 60);
  assert.ok(light.taken > heavy.taken, "the lighter car must take the greater share");
});

// --- Tick ordering: a dead car stops existing immediately --------------------
//
// main.js resolves bullets BEFORE traffic, so that a car killed this tick
// detonates and scores in the same frame rather than a frame later. The cost of
// that ordering is a window in which a car is dead but still in `traffic.cars`,
// because it is not dropped until retire() at the end of the tick. Nothing may
// act on a car inside that window.

test("a car killed by a bullet does not drive on before it explodes", () => {
  const traffic = new Traffic();
  const player = new Player(300, 496);
  const world = { player, distance: 0, W: 600, H: 800 };

  traffic.spawn(world);
  const car = traffic.cars[0];
  assert.ok(car, "expected spawn to put a car on the road");
  const diedAt = car.worldY;
  const diedOffset = car.offset;

  car.damage(car.health); // as a bullet would, in main.js, before traffic.update
  assert.ok(!car.alive);
  assert.ok(car.speed > 0, "the test is meaningless if the car was not moving");

  traffic.update(1 / 60, world);

  const wreck = traffic.explosions.slots.find((s) => s.alive);
  assert.ok(wreck, "the dead car should have detonated this tick");
  assert.equal(wreck.worldY, diedAt, "the wreck drifted from where the car was killed");
  assert.equal(wreck.offset, diedOffset, "the wreck drifted across the road");
  // Note the road may not be empty: retire() runs before spawn(), so a fresh car
  // can take the corpse's place in the same tick. Only this car must be gone.
  assert.ok(!traffic.cars.includes(car), "the corpse should have been retired");
});

test("a destroyed car is scored exactly once", () => {
  let calls = 0;
  const traffic = new Traffic(() => calls++);
  const player = new Player(300, 496);
  const world = { player, distance: 0, W: 600, H: 800 };

  traffic.spawn(world);
  traffic.cars[0].damage(traffic.cars[0].health);
  traffic.update(1 / 60, world);
  assert.equal(calls, 1);

  traffic.update(1 / 60, world); // the corpse is gone; nothing more may be paid
  assert.equal(calls, 1);
});

test("traffic does not brake for a corpse", () => {
  // The other half of the same window: a car killed this tick leaves nothing
  // solid on the road, so following cars must drive straight through the space.
  const cruise = behaviourFor("cruise");
  const follower = () => ({
    worldY: 0, offset: 0, w: 34, h: 60, speed: 300, cruiseSpeed: 300, alive: true,
    targetSpeed: 300, targetOffset: 0,
  });
  // Close enough ahead to force a hard brake if it counts as an obstacle.
  const ahead = (alive) => ({ worldY: 100, offset: 0, w: 34, h: 60, speed: 0, alive });

  const braking = follower();
  const live = ahead(true);
  cruise(braking, 1 / 60, { cars: [braking, live], playerBody: null });
  assert.ok(
    braking.targetSpeed < braking.cruiseSpeed,
    "a LIVE car ahead must still be braked for — otherwise this test proves nothing",
  );

  const clear = follower();
  const corpse = ahead(false);
  cruise(clear, 1 / 60, { cars: [clear, corpse], playerBody: null });
  assert.equal(clear.targetSpeed, clear.cruiseSpeed, "a dead car ahead must not cause braking");
});

// --- Scoring -----------------------------------------------------------------

test("kills dominate the score, as score.js claims", () => {
  // score.js: "against a car worth +-100, a minute of flat-out driving is worth
  // about a third of one kill". That ratio is the whole shape of the scoring,
  // and it breaks if either DISTANCE_POINTS or `value` moves alone.
  const minuteFlatOut = MAX_SPEED * 60 * DISTANCE_POINTS;
  const killValue = Math.max(...CAR_TYPES.map((t) => Math.abs(t.value)));
  const ratio = minuteFlatOut / killValue;
  assert.ok(
    ratio > 0.2 && ratio < 0.5,
    `a minute of driving is now worth ${ratio.toFixed(2)} of a kill (want ~0.33). ` +
      `Move DISTANCE_POINTS or the catalogue's \`value\`, never both at once.`,
  );
});

test("destroying civilians can put the score in the red", () => {
  // score.js is explicit that the total is NOT clamped at zero — the penalty is
  // supposed to be diggable-out-of, not invisible.
  const score = new Score();
  const civilian = CAR_TYPES.find((t) => t.value < 0);
  score.destroyed(civilian);
  assert.ok(score.points < 0, "a civilian kill on a fresh run must go negative");
  assert.equal(score.civilians, 1);
  assert.equal(score.kills, 0);
});

test("distance accumulates as a float and only floors when read", () => {
  // Sub-unit travel per tick must not be rounded away, or a slow player scores
  // nothing at all.
  const score = new Score();
  for (let i = 0; i < 1000; i++) score.travel(1);
  assert.equal(score.points, Math.floor(1000 * DISTANCE_POINTS));
  assert.equal(score.travelled, 1000);
});

// --- Weapons -----------------------------------------------------------------

test("the default gun never runs out", () => {
  // weapons.js: the player must always have some way to shoot, which is what
  // makes the finite weapons a choice rather than a lifeline.
  const w = new Weapon(WEAPON_TYPES[0]);
  assert.equal(w.ammo, Infinity);
  for (let i = 0; i < 100; i++) {
    w.cooldown = 0;
    assert.ok(w.tryFire());
  }
  assert.equal(w.ammo, Infinity);
  assert.equal(w.ammoText, "∞");
});

test("a weapon respects its own fire rate", () => {
  const type = WEAPON_TYPES[0];
  const w = new Weapon(type);
  assert.ok(w.tryFire(), "the first shot should be free");
  assert.ok(!w.tryFire(), "a second shot in the same instant must be refused");
  w.update(type.interval);
  assert.ok(w.tryFire(), "the weapon should be ready again after its interval");
});

test("an empty weapon selects, shows zero and refuses to fire", () => {
  // weapons.js: "SWAPPING NEVER FAILS, including onto an empty weapon."
  const finite = WEAPON_TYPES.find((t) => t.ammo !== Infinity);
  assert.ok(finite, "expected at least one finite weapon in the catalogue");
  const w = new Weapon(finite);
  for (let i = 0; i < finite.ammo; i++) {
    w.cooldown = 0;
    assert.ok(w.tryFire());
  }
  w.cooldown = 0;
  assert.ok(!w.tryFire(), "an empty weapon must refuse to fire");
  assert.ok(w.empty);
  assert.equal(w.ammoText, "0");
});

test("swapping cannot be used to dodge a cooldown", () => {
  // weapons.js: cooldowns run for the WHOLE loadout, so flicking away and back
  // must not refresh the weapon in hand.
  const loadout = new Loadout();
  const first = loadout.current;
  assert.ok(first.tryFire());
  loadout.next();
  loadout.next(); // all the way back round to `first`
  assert.equal(loadout.current, first);
  assert.ok(!loadout.current.tryFire(), "the cooldown should have survived the swap");
});

test("the loadout cycles through every weapon and returns", () => {
  const loadout = new Loadout();
  const seen = new Set();
  for (let i = 0; i < WEAPON_TYPES.length; i++) {
    seen.add(loadout.current.type.id);
    loadout.next();
  }
  assert.equal(seen.size, WEAPON_TYPES.length, "TAB does not reach every weapon");
  assert.equal(loadout.current.type.id, WEAPON_TYPES[0].id, "the cycle does not return to the start");
});

// --- Road obstacles -----------------------------------------------------------

test("every obstacle type carries coherent, positive gameplay numbers", () => {
  for (const t of OBSTACLE_TYPES) {
    assert.ok(t.health > 0, `${t.id}: health must be positive`);
    assert.ok(t.weight > 0, `${t.id}: weight must be positive`);
    assert.ok(t.blastRadius >= 0, `${t.id}: blastRadius must not be negative`);
    assert.ok(t.blastDamage >= 0, `${t.id}: blastDamage must not be negative`);
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
// only need `player`, `distance`, `W`, `H` and (optionally) `cars`.
function obstacleWorld() {
  const player = new Player(300, 496);
  return { player, distance: 0, W: 600, H: 800, cars: [] };
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
  // cartypes.js's NERVE section: no type's ceiling reaches the tetra's damage,
  // and therefore none reaches the mine's. That keeps mines the PLAYER'S
  // problem rather than something the road sweeps up for them, and it avoids
  // score.js fining the player for a civilian a mine killed unaided.
  const boldest = Math.max(...CAR_TYPES.map((t) => t.nerve ?? 0));
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

test("every civilian dodges, and at least one hostile gambles", () => {
  // The shape of the dial, not its exact settings: civilians steering around
  // everything is what makes an amber car swerving mean "something is in that
  // lane", and a hostile that always tiptoed round a folding trestle would
  // stop reading as hostile.
  const civilians = CAR_TYPES.filter((t) => t.value < 0);
  for (const t of civilians) {
    assert.equal(t.nerve, 0, `${t.id}: civilians must always dodge`);
  }
  const trestle = OBSTACLE_TYPES.find((t) => t.id === "trestle");
  const gamblers = CAR_TYPES.filter((t) => (t.nerve ?? 0) > trestle.blastDamage);
  assert.ok(gamblers.length > 0, "no hostile type can ever barge a trestle");
});

// A cruising car in lane 1, and a hazard somewhere ahead of it. `gap` is how
// much road it gets, which is what decides whether steering alone is enough.
function hazardScenario(gap, over = {}) {
  const car = {
    worldY: 0, offset: laneOffset(1), w: 34, h: 60, speed: 300, cruiseSpeed: 300,
    alive: true, nerve: 0, targetSpeed: 300, targetOffset: laneOffset(1),
    // behaviours.js derives its hazard lookahead from speed and steerSpeed, so
    // a fixture without a steering rate would look ahead an undefined distance.
    type: { w: 34, steerSpeed: 90 },
    ...over,
  };
  const hazard = {
    worldY: gap, offset: laneOffset(1), w: 60, h: 14, alive: true, threat: 8,
  };
  behaviourFor("cruise")(car, 1 / 60, { cars: [car], obstacles: [hazard], playerBody: null });
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
  const car = {
    worldY: 0, offset: 0, w: 34, h: 60, speed: 300, cruiseSpeed: 300,
    alive: true, nerve: 0, targetSpeed: 300, targetOffset: 0,
    type: { w: 34, steerSpeed: 90 },
  };
  // One hazard wide enough to cover the whole road, close ahead.
  const wall = { worldY: 80, offset: 0, w: 1000, h: 14, alive: true, threat: 30 };
  behaviourFor("cruise")(car, 1 / 60, { cars: [car], obstacles: [wall], playerBody: null });
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
  const cruise = behaviourFor("cruise");
  const car = {
    worldY: 0, offset: 0, w: 34, h: 60, speed: 300, cruiseSpeed: 300, alive: true,
    nerve: 0, targetSpeed: 300, targetOffset: 0, type: { w: 34, steerSpeed: 90 },
  };
  cruise(car, 1 / 60, { cars: [car], playerBody: null });
  assert.equal(car.targetSpeed, car.cruiseSpeed);
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

// An armed hostile at the origin, with the player somewhere near it, driven
// through a real hostile behaviour. `fired` / `laid` record what reached the
// world hooks, which is the only observable this layer has.
function hostileScenario(over = {}, worldOver = {}) {
  const type = CAR_TYPES.find((t) => t.id === "interceptor");
  const car = {
    worldY: 0, offset: 0, w: type.w, h: type.h, speed: 420, cruiseSpeed: 420,
    alive: true, nerve: 0, targetSpeed: 420, targetOffset: 0,
    type, arms: armFor(type),
    ...over,
  };
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
  behaviourFor("pursue")(car, 1 / 60, world);
  return { car, world, fired, laid };
}

test("a hostile shoots at a player in front of it, up the road", () => {
  const { fired } = hostileScenario();
  assert.equal(fired.length, 1, "expected exactly one round");
  assert.equal(fired[0].dir, 1, "a player ahead must be shot at up the road");
  assert.equal(fired[0].type, ENEMY_GUN);
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

test("a hostile lays the catalogue's mine at a player on its tail", () => {
  const { laid } = hostileScenario({}, { playerBody: { worldY: -200 } });
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
  const clear = hostileScenario({}, { playerBody: { worldY: -200 } });
  assert.equal(clear.laid.length, 1, "the test is meaningless if this case does not lay one");

  const blockedByTraffic = hostileScenario({}, {
    playerBody: { worldY: -200 },
    cars: [between],
  });
  assert.equal(blockedByTraffic.laid.length, 0, "a car between the two must veto the drop");
});

test("a hostile will not drop a mine into the player's face", () => {
  // MINE_MIN_LEAD: a mine that appears with no road left to steer around it is
  // not a threat the player can answer, it is just damage.
  const { laid } = hostileScenario({}, { playerBody: { worldY: -40 } });
  assert.equal(laid.length, 0);
});

test("a mine layer runs dry, and its magazine is what rations mines", () => {
  // weapons.js's blaster is deliberately infinite and the layer deliberately is
  // not — see game/armament.js. This pins the pair: a car cannot mine the road
  // indefinitely.
  const arms = armFor(CAR_TYPES.find((t) => t.id === "interceptor"));
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

test("a spawn never closes the road, whatever the placement asks for", () => {
  // THE PASSAGE RULE (game/obstacles.js), which replaced a lane count: the
  // question is whether a drivable gap survives, not whether a lane index is
  // free. Four mines on four lane centres pass a lane count and are impassable,
  // which is exactly the case the old rule got wrong.
  const obstacles = new Obstacles(new Explosions());
  const mine = obstacleTypeById("caltrop");
  const [mineW] = OBSTACLE_SHAPES[mine.shape].size;

  // Park a mine on every lane centre by hand. Between them they leave gaps of
  // LANE_WIDTH - mineW = 39px, which no car in the catalogue fits through.
  for (let i = 0; i < LANE_COUNT; i++) {
    obstacles.list.push({
      alive: true, laid: false, worldY: 1000, offset: laneOffset(i), w: mineW, h: 26,
    });
  }
  const widest = Math.max(...CAR_TYPES.map((t) => t.w));
  assert.ok(LANE_WIDTH - mineW < widest, "this fixture no longer blocks the road");

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
  const widest = Math.max(...CAR_TYPES.map((t) => t.w));

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
