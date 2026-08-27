// Part of the cross-file invariant suite — see test/README-invariants.md for
// what these assert and why they are not unit tests of behaviour.
//
// STAGED EVENTS: the catalogue's gating, the formations' geometry, and the two
// promises the director makes to the rest of the game — that a staged encounter
// can never seal the road, and that a shop visit is only ever LATE, never lost.
//
// Everything imported here is DOM-free at module scope, so the game's real
// modules load under plain Node.

import test from "node:test";
import assert from "node:assert/strict";
import * as events from "../src/game/events.js";
import { EVENT_TYPES, FOCUS, eventAvailable, eventTypeById } from "../src/game/eventtypes.js";
import { CAR_TYPES, carTypeById } from "../src/game/cartypes.js";
import { obstacleTypeById } from "../src/game/obstacletypes.js";
import { OBSTACLE_SHAPES } from "../src/game/obstacleshapes.js";
import { Traffic, MAX_CARS } from "../src/game/traffic.js";
import { Obstacles } from "../src/game/obstacles.js";
import { Explosions } from "../src/game/effects.js";
import { Player } from "../src/game/player.js";
import { SHOP_INTERVAL } from "../src/game/hauler.js";
import { DIST_UNITS, LANE_COUNT, ROAD_HALF_WIDTH } from "../src/game/road.js";

// The director announces through links.js's shared rate limiter and pushes to
// the SYS LOG; neither wants a real console here, so both are stubbed at every
// call site. `clock` is scenery's floor clock, taken as a parameter for exactly
// this reason (see events.update()'s own header).
const QUIET = [() => {}, () => false];

function makeWorld(dist) {
  const player = new Player(300, 496);
  const explosions = new Explosions();
  const obstacles = new Obstacles(explosions);
  const traffic = new Traffic(null, explosions);
  return { distance: dist, player, W: 600, H: 800, traffic, obstacles };
}

// Drive the director from `from` to `to` DIST units in small steps, so the roll
// and the milestones get the same number of chances they would in a run.
// Returns the world, so a caller can inspect what ended up on the road.
function drive(world, from, to, handlers = {}, step = 2 * DIST_UNITS) {
  for (let d = from * DIST_UNITS; d <= to * DIST_UNITS; d += step) {
    world.distance = d;
    events.update(d / 1000, world, handlers, ...QUIET);
  }
  return world;
}

// Pin Math.random for the duration of `fn`. The director's roll is the one
// genuinely random thing in this file, and a test about MILESTONES that let a
// rolled encounter turn up halfway through would be a test that fails once a
// week for a reason nobody could reproduce.
//
//   1 — no roll ever fires (`Math.random() >= EVENT_CHANCE`)
//   0 — every roll fires, and picks the first eligible entry
function withRandom(value, fn) {
  const real = Math.random;
  Math.random = () => value;
  try {
    return fn();
  } finally {
    Math.random = real;
  }
}

// --- The catalogue -----------------------------------------------------------

test("FOCUS is empty — a focused catalogue breaks every gating test below", () => {
  // Same guard cartypes.js's own FOCUS gets, and for the same reason: "the gang
  // never fired" is a far worse error message than this one.
  assert.deepEqual(FOCUS, [], "src/game/eventtypes.js's FOCUS must ship empty");
});

test("every entry names exactly one trigger, and ids are unique", () => {
  const seen = new Set();
  for (const type of EVENT_TYPES) {
    assert.ok(!seen.has(type.id), `duplicate event id ${type.id}`);
    seen.add(type.id);

    const triggers = ["weight", "at", "every"].filter((k) => type[k] !== undefined);
    assert.equal(
      triggers.length, 1,
      `${type.id} names ${triggers.length} triggers (${triggers}) — exactly one is the contract`,
    );
  }
});

test("a rolled entry stages nothing the road has not unlocked yet", () => {
  // THE INVARIANT THAT KEEPS THE CATALOGUES HONEST. An encounter is drawn on its
  // own `minDistance`, but the cars and hazards it places carry their own gates
  // (cartypes.js / obstacletypes.js). An event gated earlier than what it stages
  // would introduce a type the ambient spawner is still holding back, which is
  // the one way a staged road stops being the road the real spawner built.
  for (const type of EVENT_TYPES) {
    const gate = type.weight !== undefined ? type.minDistance : type.at;
    if (gate === undefined) continue; // `every` entries (the shop) stage no types

    for (const spec of type.stage ?? []) {
      if (spec.kind === "handoff") continue;
      // Asked of BOTH catalogues rather than switched on the stage kind: a new
      // kind that places hazards (the minefield's `scatter` was one) would
      // otherwise silently start looking its type up in the car list and fail
      // with "unknown type" instead of checking the gate it came here for.
      const staged = carTypeById(spec.type) ?? obstacleTypeById(spec.type);
      assert.ok(staged, `${type.id} stages unknown type "${spec.type}"`);
      assert.ok(
        gate >= staged.minDistance,
        `${type.id} opens at ${gate} but stages ${spec.type}, gated at ${staged.minDistance}`,
      );
    }
  }
});

test("eligibility honours the gate, the ceiling and the entry's own cooldown", () => {
  const gang = eventTypeById("gang");

  assert.ok(!eventAvailable(gang, gang.minDistance - 1), "before its gate");
  assert.ok(eventAvailable(gang, gang.minDistance), "at its gate");

  // Fired at its gate: still cooling down one unit short of the cooldown, and
  // eligible again the moment it is served.
  const fired = gang.minDistance;
  assert.ok(
    !eventAvailable(gang, fired + gang.cooldown - 1, fired),
    "an entry must not recur inside its own cooldown",
  );
  assert.ok(eventAvailable(gang, fired + gang.cooldown, fired), "...and may after it");

  // A milestone entry has no weight and is never drawn — the director checks
  // `at`/`every` before it rolls at all.
  assert.ok(!eventAvailable(eventTypeById("shop"), 1e6), "the shop is never rolled");
  assert.ok(!eventAvailable(eventTypeById("warband"), 1e6), "a milestone is never rolled");
});

// --- Formations --------------------------------------------------------------

test("a pack staged behind arrives behind, streaming away from the screen", () => {
  const world = makeWorld(1000);
  const spec = { kind: "cars", type: "outrider", count: 4, side: "behind", spread: 240 };
  const reqs = events.planStage(spec, world);

  assert.equal(reqs.length, 4);
  const rear = world.distance - (world.H - world.player.y);
  let previous = Infinity;
  for (const req of reqs) {
    assert.ok(req.worldY < rear, "every member of a rear pack starts off-screen behind");
    assert.ok(req.worldY < previous, "and they stream away, rather than arriving abreast");
    previous = req.worldY;
  }

  // Distinct lanes, so a gang spreads across the road instead of queueing.
  assert.equal(new Set(reqs.map((r) => r.lane)).size, 4);
});

test("a pack staged ahead is placed beyond the hazard margin, where traffic can dodge it", () => {
  // obstacles.js's SPAWN_MARGIN is the MEASURED distance the slowest-steering
  // car needs to cross two lanes. Anything staged up the road has to respect it
  // or it lands inside the traffic field with no road left to react in.
  const world = makeWorld(1000);
  const reqs = events.planStage(
    { kind: "cars", type: "interceptor", count: 2, side: "ahead", spread: 300 }, world,
  );
  const front = world.distance + world.player.y;
  for (const req of reqs) {
    assert.ok(req.worldY - front >= 1500, "staged ahead must clear the hazard margin");
  }
});

test("a car wall always leaves a lane open", () => {
  // THE ONE RULE obstacles.js's passage check cannot make for us: it guards
  // hazards and knows nothing about cars, so a rank of rigs is the only
  // formation in the catalogue that could build a wall with no way through.
  for (let count = 1; count <= LANE_COUNT + 2; count++) {
    const reqs = events.planStage(
      { kind: "abreast", type: "rig", count, gapLanes: 1 }, makeWorld(1000),
    );
    const taken = new Set(reqs.map((r) => r.lane));
    assert.ok(
      taken.size <= LANE_COUNT - 1,
      `${count} rigs abreast filled ${taken.size} of ${LANE_COUNT} lanes`,
    );
    // All at one worldY — that is what makes it a wall rather than a queue.
    assert.equal(new Set(reqs.map((r) => r.worldY)).size, 1);
  }
});

test("a narrowing puts its rows hard against both barriers, wholly on the tarmac", () => {
  const world = makeWorld(1000);
  const spec = { kind: "rows", type: "trestle", count: 3, spread: 260 };
  const reqs = events.planStage(spec, world);
  const w = OBSTACLE_SHAPES[obstacleTypeById("trestle").shape].size[0];

  assert.equal(reqs.length, 6, "three rows, both sides");
  for (const req of reqs) {
    assert.ok(
      Math.abs(req.offset) + w / 2 <= ROAD_HALF_WIDTH + 1e-9,
      "a staged hazard must not hang over a barrier",
    );
  }
  // Mirrored: each row has one on each side.
  const byRow = new Map();
  for (const req of reqs) byRow.set(req.worldY, (byRow.get(req.worldY) ?? 0) + 1);
  assert.equal(byRow.size, 3);
  for (const n of byRow.values()) assert.equal(n, 2);
});

test("a minefield sows rows across the road, each row separately drivable", () => {
  // The field's SHAPE is the passage rule's decision, not the catalogue's: each
  // row asks for three mines, and the rule takes the third away from any row
  // that would spread evenly enough to close the road. So this asserts what the
  // stage asks for, and then what actually survives placement.
  const world = makeWorld(1300);
  const spec = { kind: "scatter", type: "caltrop", count: 4, perRow: 3, spread: 220 };
  const reqs = events.planStage(spec, world);
  const w = OBSTACLE_SHAPES[obstacleTypeById("caltrop").shape].size[0];

  assert.equal(reqs.length, 12, "four rows of three");
  const rows = new Set(reqs.map((r) => r.worldY));
  assert.equal(rows.size, 4, "the mines land in rows, not in one cloud");
  for (const req of reqs) {
    assert.ok(
      Math.abs(req.offset) + w / 2 <= ROAD_HALF_WIDTH + 1e-9,
      "a sown mine must stay wholly on the tarmac",
    );
  }

  // Rows are spaced beyond obstacles.js's CLUSTER_WINDOW (130), which is what
  // makes each one judged on its own — a sequence of decisions rather than one
  // puzzle. Asserted here because it is a relation between two files.
  const sorted = [...rows].sort((a, b) => a - b);
  for (let i = 1; i < sorted.length; i++) {
    assert.ok(sorted[i] - sorted[i - 1] > 130, "rows must not be judged as one stretch");
  }

  // Now place the whole field for real and check every row still has a way
  // through it. Run repeatedly, since the offsets are rolled per mine.
  for (let attempt = 0; attempt < 50; attempt++) {
    const w2 = makeWorld(1300);
    for (const req of events.planStage(spec, w2)) {
      w2.obstacles.place(req.type, req.worldY, req.offset, [], true);
    }
    assert.ok(w2.obstacles.list.length > 0, "expected some of the field to land");
    for (const worldY of new Set(w2.obstacles.list.map((o) => o.worldY))) {
      assert.ok(
        w2.obstacles.leavesPassage(worldY, 0, 0),
        "every row of a minefield must be drivable",
      );
    }
  }
});

// --- The promise to the road -------------------------------------------------

test("nothing a staged encounter places can seal the road", () => {
  // The narrowing is the one feature whose whole point is to approach the
  // passage bound, so it is the one that has to be pinned against it. Every
  // staged hazard goes through Obstacles.place(), which refuses anything
  // leavesPassage() rejects — so the failure mode is a THINNER narrowing, never
  // a closed road.
  const world = makeWorld(1000);
  const type = obstacleTypeById("trestle");
  const w = OBSTACLE_SHAPES[type.shape].size[0];

  // Ask for far more than the road can hold, at one spot, from both sides and
  // then straight down the middle for good measure.
  const worldY = world.distance + 3000;
  const offsets = [-(ROAD_HALF_WIDTH - w / 2), ROAD_HALF_WIDTH - w / 2, 0, 20, -20, 40, -40];
  for (const offset of offsets) {
    world.obstacles.place(type, worldY, offset, [], true);
  }

  // Whatever went down, there is still a way through: ask the rule itself about
  // a hypothetical zero-width object, which is the same sweep place() ran.
  assert.ok(
    world.obstacles.leavesPassage(worldY, 0, 0),
    "the road must still be drivable after a staged pile-on",
  );
});

test("staged cars are not counted against the ambient traffic budget", () => {
  // Two pools, for the reason traffic.js's `staged` gives: a five-strong gang
  // inside MAX_CARS would empty the rest of the road to make room, which is the
  // opposite of what an encounter is for.
  const world = makeWorld(1000);
  const type = carTypeById("outrider");
  for (let i = 0; i < 5; i++) {
    world.traffic.place(type, world.distance - 4000 - i * 400, i % LANE_COUNT, 500, true);
  }
  assert.equal(world.traffic.cars.length, 5, "expected the staged pack to land");
  assert.equal(world.traffic.ambientCount(), 0, "none of it is the ambient spawner's");
});

test("a density of zero drains the road rather than emptying it in a frame", () => {
  // The property the whole feature rests on: nothing is removed. The spawner
  // simply stops replacing what retires, so a boss arrives into a road the
  // player watched clear.
  const world = makeWorld(1000);
  const before = [];
  for (let i = 0; i < 3; i++) {
    world.traffic.spawn({ distance: world.distance, player: world.player, H: world.H });
  }
  for (const car of world.traffic.cars) before.push(car);
  assert.ok(before.length > 0, "expected the ambient spawner to place something");

  world.traffic.setDensity(0);
  for (let i = 0; i < 120; i++) {
    world.traffic.update(1 / 60, {
      distance: world.distance, player: world.player, W: world.W, H: world.H,
    });
  }
  for (const car of before) {
    assert.ok(car.alive, "a density change must never destroy a car already on the road");
  }
});

test("the ambient cap scales with density, and the baseline is MAX_CARS", () => {
  const world = makeWorld(1000);
  world.traffic.setDensity(0);
  for (let i = 0; i < 60; i++) {
    world.traffic.update(1 / 60, {
      distance: world.distance, player: world.player, W: world.W, H: world.H,
    });
  }
  assert.equal(world.traffic.ambientCount(), 0, "zero density spawns nothing new");

  world.traffic.setDensity(1);
  for (let i = 0; i < 60 * 30; i++) {
    world.traffic.update(1 / 60, {
      distance: world.distance, player: world.player, W: world.W, H: world.H,
    });
  }
  assert.ok(
    world.traffic.ambientCount() <= MAX_CARS,
    "the baseline cap still bounds the ambient road",
  );
});

// --- Milestones --------------------------------------------------------------

test("the rival turns up once, at the exact distance its own type unlocks", () => {
  // The mini-boss adds no car and no tactic — cartypes.js's rival and
  // behaviours.js's `duel` already existed. What the entry adds is the
  // GUARANTEE: at weight 0.3 a player could drive past DIST 1000 and never meet
  // one. So this asserts the two things that makes true — it arrives, and it
  // arrives once.
  events.reset();
  const world = makeWorld(0);
  const rival = eventTypeById("rival");
  assert.equal(
    rival.at, carTypeById("rival").minDistance,
    "the meeting is pinned to the car's own gate, not to a second number",
  );

  const staged = () => world.traffic.cars.filter((c) => c.staged && c.type.id === "rival");

  withRandom(1, () => drive(world, 0, rival.at - 10, {}));
  assert.equal(staged().length, 0, "not before its distance");

  withRandom(1, () => drive(world, rival.at - 8, rival.at + 4, {}));
  assert.equal(staged().length, 1, "exactly one rival, at its distance");
  assert.equal(events.active(), "rival");

  // Behind the player, because it is faster than them — the same rule
  // traffic.js's own spawner follows, and the approach `duel` is written for.
  assert.ok(staged()[0].worldY < world.distance, "the rival comes up from behind");

  // Kill it, drive on well past the milestone: a one-shot never comes back.
  for (const car of staged()) car.alive = false;
  world.traffic.cars = world.traffic.cars.filter((c) => c.alive);
  withRandom(1, () => drive(world, rival.at + 6, rival.at + 200, {}));
  assert.equal(staged().length, 0, "a `once` milestone must not fire twice in a run");
});

// --- The shop visit ----------------------------------------------------------

test("the shop visit is LATE, never lost, when an encounter is already live", () => {
  // THE REGRESSION FOLDING hauler.js's SCHEDULER INTO THE DIRECTOR COULD
  // PLAUSIBLY INTRODUCE, and the reason milestones defer rather than cancel: a
  // missed set-piece is a missed moment, a missed shop visit is a lost upgrade.
  events.reset();
  const world = makeWorld(0);
  let fires = 0;
  const handlers = { shop: { fire: () => { fires++; }, live: () => false } };

  // A quiet road up to just short of the THIRD shop milestone — the first two
  // pass uneventfully on the way, which is the baseline the rest of this
  // measures against. (The one-shot `warband` fires and finishes in there too,
  // which is exactly the crowded stretch this test is about.)
  const due = SHOP_INTERVAL * 3;
  withRandom(1, () => drive(world, 0, due - 40, handlers));
  assert.equal(fires, 2, "the first two milestones should have passed uneventfully");

  // Now force a rolled encounter to fire in the last few units before the third
  // one, so it is still running when that milestone comes due.
  withRandom(0, () => drive(world, due - 38, due - 20, handlers));
  assert.ok(events.active(), "expected a rolled encounter to be live");
  const staged = world.traffic.cars.filter((c) => c.staged);
  assert.ok(staged.length, "expected it to have staged something");

  // ...and drive straight through the milestone with it still running.
  withRandom(1, () => drive(world, due - 18, due + 4, handlers));
  assert.equal(fires, 2, "a milestone must not fire over the top of a live encounter");
  assert.ok(events.active(), "and the encounter is what is holding it");

  // The encounter ends (here, by the player killing it) — and the deferred
  // milestone is spent on that very tick, not on the next interval.
  for (const car of staged) car.alive = false;
  withRandom(1, () => drive(world, due + 6, due + 10, handlers));

  assert.equal(events.active(), null, "the encounter should have ended");
  assert.equal(fires, 3, "the deferred shop visit must fire the moment the road clears");
});

test("every shop milestone crossed is spent, exactly once each", () => {
  events.reset();
  const world = makeWorld(0);
  let fires = 0;
  const handlers = { shop: { fire: () => { fires++; }, live: () => false } };

  const laps = 3;
  withRandom(1, () => drive(world, 0, SHOP_INTERVAL * laps + 5, handlers));

  assert.equal(
    fires, laps,
    `crossing ${laps} shop milestones must fire the drone ${laps} times`,
  );
});

test("the shop interval is still hauler.js's number", () => {
  // The catalogue reads SHOP_INTERVAL rather than restating it: the pacing dial
  // stayed with the drone even though the counter did not.
  assert.equal(eventTypeById("shop").every, SHOP_INTERVAL);
});

// --- Lifecycle ---------------------------------------------------------------

test("a run reset clears the schedule, so a fresh run has not shopped", () => {
  events.reset();
  const world = makeWorld(0);
  let fires = 0;
  const handlers = { shop: { fire: () => { fires++; }, live: () => false } };

  withRandom(1, () => drive(world, 0, SHOP_INTERVAL + 5, handlers));
  assert.equal(fires, 1);

  events.reset();
  const fresh = makeWorld(0);
  withRandom(1, () => drive(fresh, 0, SHOP_INTERVAL + 5, handlers));
  assert.equal(fires, 2, "a new run must earn its first shop visit again");
});

test("density is back at 1 whenever nothing is live", () => {
  // Restoring is unconditional and re-asserted every tick, which is what makes
  // it immune to main.js's respawnWorld() throwing both systems away mid-run.
  events.reset();
  const world = makeWorld(0);
  world.traffic.setDensity(0);
  world.obstacles.setDensity(0);

  events.update(0, world, {}, ...QUIET);

  assert.equal(events.active(), null, "nothing should be live on the first tick");
  assert.equal(world.traffic.density, 1);
  assert.equal(world.obstacles.density, 1);
});

test("the widest staged car still fits the passage a narrowing leaves", () => {
  // A relation between three files, asserted rather than only documented — the
  // same shape hazards.test.js's own MIN_PASSAGE check takes. If the trestle
  // ever grows, or a wider car joins the catalogue, this is what says so.
  const w = OBSTACLE_SHAPES[obstacleTypeById("trestle").shape].size[0];
  const widestCar = Math.max(...CAR_TYPES.map((t) => t.w));
  const slot = ROAD_HALF_WIDTH * 2 - 2 * w;
  assert.ok(
    slot >= widestCar,
    `a narrowing leaves ${slot}px; the widest car is ${widestCar}px`,
  );
});
