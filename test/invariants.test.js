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
import { ACCEL as TRAFFIC_ACCEL, Traffic } from "../src/game/traffic.js";
import { FOLLOW_REACTION, behaviourFor } from "../src/game/behaviours.js";
import { MIN_SPEED, MAX_SPEED, ACCEL as PLAYER_ACCEL, Player } from "../src/game/player.js";
import { WHEEL_FRAMES } from "../src/game/sprites.js";
import { LANE_COUNT, ROAD_HALF_WIDTH, laneAt, laneOffset } from "../src/game/road.js";
import { plotAt, plotColumns, plotRows, BUILDING, EMPTY } from "../src/game/citygrid.js";
import { resolveCollisions } from "../src/game/collisions.js";
import { Score, DISTANCE_POINTS } from "../src/game/score.js";
import { Loadout, Weapon, WEAPON_TYPES } from "../src/game/weapons.js";

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
