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
import { EVENT_AT_OVERRIDES, EVENT_GATE_OVERRIDES } from "../src/testoptions.js";
import { CAR_TYPES, carTypeById } from "../src/game/cartypes.js";
import { WEAPON_TYPES, FLIGHT_SEEKING } from "../src/game/weapons.js";
import { PICKUP_TYPES } from "../src/game/pickuptypes.js";
import { obstacleTypeById } from "../src/game/obstacletypes.js";
import { OBSTACLE_SHAPES } from "../src/game/obstacleshapes.js";
import {
  Traffic, MAX_CARS,
  RETIRE_MARGIN as TRAFFIC_RETIRE_MARGIN,
  STAGED_RETIRE_MARGIN,
  SPAWN_GAP as TRAFFIC_SPAWN_GAP,
} from "../src/game/traffic.js";
import {
  Obstacles,
  SPAWN_MARGIN as OBSTACLE_SPAWN_MARGIN,
  SPAWN_GAP as OBSTACLE_SPAWN_GAP,
} from "../src/game/obstacles.js";
import { TACTIC_NAMES, dodgeDistance } from "../src/game/behaviours.js";
import { Explosions } from "../src/game/effects.js";
import { Player } from "../src/game/player.js";
import { Hauler, SHOP_INTERVAL } from "../src/game/hauler.js";
import { DIST_UNITS, LANE_COUNT, ROAD_HALF_WIDTH } from "../src/game/road.js";
import { MAX_SPEED as PLAYER_MAX_SPEED } from "../src/game/player.js";
import { drivingFor } from "../src/game/driving.js";

// The director announces through links.js's shared rate limiter and pushes to
// the SYS LOG; neither wants a real console here, so both are stubbed at every
// call site. `clock` is scenery's floor clock, taken as a parameter for exactly
// this reason (see events.update()'s own header).
// THE SUITE MEASURES THE SHIPPING SCHEDULE, so the hand-testing override is
// cleared here before a single test runs.
//
// src/testoptions.js's EVENT_AT_OVERRIDES pulls a one-shot milestone forward so
// the fight behind it can be reached in seconds instead of driven to, and
// game/events.js honours it. That is exactly right for playing the game and
// exactly wrong for testing it: a boss moved to DIST 150 sits on the director
// for the length of its duration and DEFERS everything behind it, so a test
// about the shop interval starts failing for reasons that have nothing to do
// with the shop. This file is the only one that drives the director, and
// cartypes.js's FOCUS note already states the rule it is following — the one
// thing a measurement harness must not do is measure a different game.
//
// Cleared rather than asserted-empty on purpose: a developer with the override
// set should be able to run the suite without it going red.
for (const id of Object.keys(EVENT_AT_OVERRIDES)) delete EVENT_AT_OVERRIDES[id];
// ...and the same for the ROLLED entries' gates, which is the map most likely
// to be non-empty on a working tree: a new encounter is normally pulled forward
// while it is being looked at. An entry eligible from DIST 150 turns up in the
// middle of every test that drives the director.
for (const id of Object.keys(EVENT_GATE_OVERRIDES)) delete EVENT_GATE_OVERRIDES[id];

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
    sweepStaged(world);
  }
  return world;
}

// Stand in for Traffic.retire(), which this harness never calls.
//
// `drive` runs the DIRECTOR and nothing else — no Traffic.update, so nothing
// staged ever moves and nothing is ever dropped for leaving the screen. Left
// alone, a long drive accumulates every car every encounter has ever placed,
// and once that reaches events.js's MAX_STAGED_CARS the next encounter is
// refused its cars for a reason that exists nowhere in the game. It bit the
// moment `warband` grew its bike wing: seven cars parked on a road they should
// have left hundreds of units ago, and four unrelated tests started failing.
//
// Only ONCE NOTHING IS LIVE, so a test can still inspect what the current
// encounter put down — which is most of what these tests do.
function sweepStaged(world) {
  if (events.active()) return;
  world.traffic.cars = world.traffic.cars.filter((c) => !c.staged);
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

// Every type ONE stage spec puts on the road. Almost every kind names a single
// `type`; `flank` names a `types` sequence, because a worksite is a warning of
// one type followed by a danger of another (see events.js). The gate rules
// below apply to each of them individually, so they are asked for as a list
// rather than as a field — a kind that names its types some third way must
// widen this, and the two tests keep checking every type either way.
function stagedTypeIds(spec) {
  return spec.types ?? [spec.type];
}

test("a rolled entry stages nothing the road has not unlocked yet", () => {
  // THE INVARIANT THAT KEEPS THE CATALOGUES HONEST. An encounter is drawn on its
  // own `minDistance`, but the cars and hazards it places carry their own gates
  // (cartypes.js / obstacletypes.js). An event gated earlier than what it stages
  // would introduce a type the ambient spawner is still holding back, which is
  // the one way a staged road stops being the road the real spawner built.
  //
  // ROLLED ENTRIES ONLY, which is what this test has always been called and is
  // now also what it checks. A ONE-SHOT MILESTONE introducing a type before the
  // ambient road can produce one is not the failure this guards against — it is
  // the entire point of a set-piece, and both of the ones in the catalogue now
  // do it deliberately: the boss is a `staged` type the spawner may never roll
  // at all, and the rival encounter at 900 is what guarantees the first meeting
  // five hundred units before the road starts producing them on its own. A
  // rolled entry doing the same thing would be an accident, because it recurs.
  //
  // The separate rule that keeps that from becoming a back door is below.
  for (const type of EVENT_TYPES) {
    if (type.weight === undefined) continue;
    const gate = type.minDistance;
    if (gate === undefined) continue;

    for (const spec of type.stage ?? []) {
      if (spec.kind === "handoff") continue;
      for (const id of stagedTypeIds(spec)) {
        // Asked of BOTH catalogues rather than switched on the stage kind: a
        // new kind that places hazards (the minefield's `scatter` was one)
        // would otherwise silently start looking its type up in the car list
        // and fail with "unknown type" instead of checking the gate it came
        // here for.
        const staged = carTypeById(id) ?? obstacleTypeById(id);
        assert.ok(staged, `${type.id} stages unknown type "${id}"`);
        assert.ok(
          gate >= staged.minDistance,
          `${type.id} opens at ${gate} but stages ${id}, gated at ${staged.minDistance}`,
        );
      }
    }
  }
});

test("an encounter only one weapon can answer waits for that weapon", () => {
  // THE GATE THE RULE ABOVE CANNOT SEE. `staged` types carry minDistance 0 —
  // being unrollable IS their gate (cartypes.js) — so the invariant above binds
  // on nothing for an encounter built out of one. For the airstrike that is not
  // good enough: the gunship is `airborne`, and projectiles.js will let nothing
  // but a SEEKING round touch it, which in the whole catalogue is the ROCKET
  // alone. An encounter that can only be answered by one weapon must not come
  // up before the player can have that weapon, or it is not a fight — it is a
  // thing that shoots at them for `duration` while they watch.
  //
  // The rocket starts every run empty (weapons.js's `startAmmo: 0`) and has two
  // sources: the shop, and the ROCKET+ crate. The crate's gate is the later of
  // the two and therefore the binding one.
  const seeking = WEAPON_TYPES.filter((w) => w.flight === FLIGHT_SEEKING);
  assert.equal(
    seeking.length,
    1,
    "more than one weapon seeks now — the airstrike's gate assumes exactly one",
  );
  const crate = PICKUP_TYPES.find((p) => p.weaponId === seeking[0].id);
  assert.ok(crate, `nothing on the road resupplies the ${seeking[0].id}`);

  const airstrike = eventTypeById("airstrike");
  assert.ok(
    airstrike.minDistance >= crate.minDistance,
    `the airstrike opens at ${airstrike.minDistance} but the ${crate.id} crate that ` +
      `answers it is gated at ${crate.minDistance} — the player would meet something ` +
      "they cannot shoot at",
  );
  // ...and the shop has come round at least once by then, which is the other
  // source and the one a player who is paying attention will have used.
  assert.ok(
    airstrike.minDistance >= SHOP_INTERVAL,
    `the airstrike opens at ${airstrike.minDistance}, before the first shop visit at ` +
      `${SHOP_INTERVAL}`,
  );
});

test("only a one-shot may introduce a type the road has not unlocked", () => {
  // The other half of the rule above, and the reason relaxing it is safe. A
  // milestone is allowed to bring a car in ahead of its ambient gate — that is
  // what makes a set-piece an authored meeting rather than a lucky roll — but
  // only if it happens ONCE. A recurring milestone (the shop's `every`) doing it
  // would be an ungated type on tap, which is the thing the rolled-entry rule
  // exists to prevent, wearing a different trigger.
  for (const type of EVENT_TYPES) {
    if (type.at === undefined) continue;
    for (const spec of type.stage ?? []) {
      if (spec.kind === "handoff") continue;
      for (const id of stagedTypeIds(spec)) {
        const staged = carTypeById(id) ?? obstacleTypeById(id);
        assert.ok(staged, `${type.id} stages unknown type "${id}"`);
        if (type.at >= (staged.minDistance ?? 0)) continue; // nothing to excuse
        assert.ok(
          type.once,
          `${type.id} fires at ${type.at} and stages ${id}, gated at ` +
            `${staged.minDistance} — only a one-shot may run ahead of a gate`,
        );
      }
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

test("a car staged ahead lands off-screen but inside the road the game keeps", () => {
  // THIS TEST USED TO ASSERT THE OPPOSITE, and the rule it asserted is what
  // broke every encounter that staged a car up the road.
  //
  // It required a staged car to clear obstacles.js's SPAWN_MARGIN (1500), on
  // the reasoning that anything placed ahead must leave the traffic behind it
  // room to dodge. That reasoning is about HAZARDS: a mine does not move, is
  // avoided by swerving, and dodgeDistance is the measured road that swerve
  // needs. A car is none of those things — it drives, it is dealt with by
  // following and overtaking, and the ambient spawner has always introduced one
  // ahead at the TRAFFIC margin of 120 (traffic.js's spawn).
  //
  // The cost of the stricter rule was total: 1500 is far outside traffic.js's
  // RETIRE_MARGIN of 320, so every car staged ahead was dropped by
  // Traffic.retire() on the tick it was placed. `warband` had been firing at
  // DIST 700, announcing itself, emptying the ambient road and then staging
  // nothing at all, for as long as it has existed.
  //
  // So the real constraint, and the one asserted now: OFF-SCREEN, so nothing
  // materialises in view, and INSIDE THE STAGED RETIRE MARGIN, so it is still
  // there on the next tick. The staged boundary rather than the ambient one is
  // the whole of what makes a multi-rank formation possible — see traffic.js's
  // STAGED_RETIRE_MARGIN, and note that this test asks Traffic.retire() itself
  // rather than only comparing numbers, since the boundary is now per-car.
  const world = makeWorld(1000);
  const reqs = events.planStage(
    { kind: "cars", type: "interceptor", count: 2, side: "ahead", spread: 300 }, world,
  );
  const front = world.distance + world.player.y;
  assert.ok(reqs.length > 0, "nothing was staged");
  for (const req of reqs) {
    assert.ok(req.worldY > front, "staged ahead must be off the top of the screen");
    assert.ok(
      req.worldY - front < STAGED_RETIRE_MARGIN,
      `staged at ${(req.worldY - front).toFixed(0)} ahead, outside the ` +
        `${STAGED_RETIRE_MARGIN} staged retire margin — it would be dropped on arrival`,
    );
    world.traffic.place(req.type, req.worldY, 0, req.speed, true);
  }
  world.traffic.retire(world);
  assert.equal(
    world.traffic.cars.length, reqs.length,
    "Traffic.retire() must keep every car the stager placed",
  );

  // ...AND THE AMBIENT BOUNDARY IS UNMOVED. The staged margin is a second
  // number precisely so the ordinary road is not stretched with it: an unstaged
  // car out there is still dropped at 320, which is what keeps obstacles.js's
  // own SPAWN_MARGIN relation (test/hazards.test.js) true.
  const ambient = makeWorld(1000);
  ambient.traffic.place(
    carTypeById("interceptor"),
    ambient.distance + ambient.player.y + TRAFFIC_RETIRE_MARGIN + 1, 0, 300, false,
  );
  ambient.traffic.retire(ambient);
  assert.equal(ambient.traffic.cars.length, 0, "an ambient car keeps the ambient boundary");
});

test("a hazard staged ahead still clears the margin traffic needs to dodge it", () => {
  // The half of the old rule that was RIGHT, kept and given its own test so it
  // cannot be lost with the half that was wrong. A hazard does not drive: the
  // cars already heading towards it have to swerve, and obstacles.js's
  // SPAWN_MARGIN is the measured road the slowest-steering type needs to do it.
  const world = makeWorld(1000);
  const front = world.distance + world.player.y;
  for (const spec of [
    { kind: "rows", type: "trestle", count: 2, spread: 260 },
    { kind: "scatter", type: "caltrop", count: 2, perRow: 2, spread: 220 },
  ]) {
    for (const req of events.planStage(spec, world)) {
      assert.ok(
        req.worldY - front >= OBSTACLE_SPAWN_MARGIN,
        `${spec.type} staged ${(req.worldY - front).toFixed(0)} ahead, inside the ` +
          `${OBSTACLE_SPAWN_MARGIN} a car needs to dodge it`,
      );
    }
  }
});

test("a car staged ahead never arrives faster than the player", () => {
  // events.js's arrivalSpeed. Staging names the END a car comes in at, which is
  // the decision traffic.js's own spawner makes FROM the speed — so having
  // overridden it, the stager owns the consequence. A 730-unit boss dropped in
  // ahead at its own cruising speed opens the gap faster than it can brake and
  // is retired off the top of the screen before its tactic ever settles.
  const world = makeWorld(1300);
  for (const id of ["mortar", "interceptor", "outrunner"]) {
    for (const req of events.planStage(
      { kind: "cars", type: id, count: 1, side: "ahead", spread: 0 }, world,
    )) {
      assert.ok(
        req.speed <= world.player.speed,
        `${id} arrives ahead at ${req.speed.toFixed(0)} against a player doing ` +
          `${world.player.speed} — it will simply drive away`,
      );
    }
  }
  // ...and behind, the roll stands: a car in the mirror is meant to be quick.
  const behind = events.planStage(
    { kind: "cars", type: "outrider", count: 1, side: "behind", spread: 0 }, world,
  );
  const type = carTypeById("outrider");
  assert.ok(behind[0].speed >= type.hardFloor, "a staged pack must keep its own speed band");
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

// How far under the player's ceiling a chase ceiling may sit and still count as
// holding station. 20 units/sec is the slip the boss's escort runs on and the
// number its entry works through — half a minute of pursuit, longer than the
// fight — so it is the documented floor rather than a new one invented here.
const CLOSING_SLIP = 20;

test("the swarm stages ranks the road can hold and gets the rest there itself", () => {
  // TWELVE BIKES, AND THE SHAPE IS THE ROAD'S. Two ranks may be staged ahead
  // because traffic.js's STAGED_RETIRE_MARGIN leaves events.js 440 units of
  // budget and a rank of bikes costs 216 (SPAWN_GAP plus a hull); three per
  // rank because a rank that fills every lane is a wall. Both are measurements
  // of other files, which is why they are pinned here rather than trusted.
  const swarm = eventTypeById("swarm");
  const ahead = swarm.stage.filter((spec) => spec.side === "ahead");
  const behind = swarm.stage.filter((spec) => spec.side === "behind");
  const total = (specs) => specs.reduce((n, spec) => n + spec.count, 0);

  assert.equal(total(swarm.stage), 12, "the swarm is twelve bikes");

  // A RANK IS THE SPECS SHARING A `lead`: they are all laid at the same worldY,
  // which is what makes them one rank and what the lane rule applies to.
  const ranks = new Map();
  for (const spec of ahead) {
    const lead = spec.lead ?? 0;
    ranks.set(lead, (ranks.get(lead) ?? 0) + spec.count);
  }
  for (const [lead, count] of ranks) {
    assert.ok(
      count <= LANE_COUNT - 1,
      `the rank at lead ${lead} asks for ${count} of ${LANE_COUNT} lanes — a rank must leave one open`,
    );
  }

  // AND THEY REALLY ARE BIKES. The encounter is the motorcycle fleet met all at
  // once; a car type finding its way into this list would still place, still
  // read as a gang in the log, and be a different encounter entirely.
  const fleet = new Set(["cycle", "outrider", "outrunner", "sower"]);
  for (const spec of swarm.stage) {
    assert.ok(fleet.has(spec.type), `the swarm stages ${spec.type}, which is not a bike`);
  }

  // THE LOAD-BEARING HALF OF THE SPLIT: everything staged behind has to stay in
  // the encounter against a player at full throttle. Two ways to do that, and
  // the entry names both — a band above the player's ceiling (the cycle, which
  // is how half the pack ends up in front despite being staged behind), or a
  // chase ceiling that holds station astern (the outrider's 600). A type
  // retuned under BOTH would sit off the bottom of the screen for the whole
  // encounter, which is the exact failure the rival's entry documents.
  for (const spec of behind) {
    const type = carTypeById(spec.type);
    const reach = Math.max(type.speedMax, drivingFor(type).chaseSpeed);
    assert.ok(
      reach >= PLAYER_MAX_SPEED - CLOSING_SLIP,
      `${spec.type} is staged behind but tops out at ${reach} against a player at ${PLAYER_MAX_SPEED}`,
    );
  }

  // ...and half of the pack must genuinely pass, or the mirror is the whole
  // encounter and "swarm" is just `gang` with more bikes in it.
  const passing = behind
    .filter((spec) => carTypeById(spec.type).speedMax > PLAYER_MAX_SPEED)
    .reduce((n, spec) => n + spec.count, 0);
  assert.ok(
    passing >= total(behind) / 2,
    "half the pack staged behind must be able to overtake the player",
  );

  // The ranks themselves: distinct rows, and the deepest still inside the
  // boundary Traffic.retire() keeps a staged car to.
  const world = makeWorld(1600);
  const boundary = world.distance + world.player.y + STAGED_RETIRE_MARGIN;
  const reqs = ahead.flatMap((spec) => events.planStage(spec, world));
  assert.equal(new Set(reqs.map((r) => r.worldY)).size, ranks.size, "one row per rank");
  for (const req of reqs) assert.ok(req.worldY < boundary, "a staged car must not land past retire");

  // AND THE RANKS MUST CLEAR EACH OTHER. traffic.js's laneClear is what refuses
  // a car laid too close behind another in the same lane, and two ranks closer
  // than that is not a tighter formation — it is one rank and some cars that
  // were quietly refused.
  const rows = [...new Set(reqs.map((r) => r.worldY))].sort((a, b) => a - b);
  const deepest = Math.max(...ahead.map((spec) => carTypeById(spec.type).h));
  for (let i = 1; i < rows.length; i++) {
    assert.ok(
      rows[i] - rows[i - 1] >= TRAFFIC_SPAWN_GAP + deepest,
      `ranks ${(rows[i] - rows[i - 1]).toFixed(0)} apart cannot both land`,
    );
  }
});

test("a slalom alternates its gates and leaves every one of them drivable", () => {
  // The weave: half-road gates, side alternating, and a way through each one.
  // The passage rule is what guarantees the last of those, so this places the
  // whole thing for real rather than only reading the plan.
  const spec = eventTypeById("slalom").stage[0];
  const type = obstacleTypeById(spec.type);
  const w = OBSTACLE_SHAPES[type.shape].size[0];

  for (let attempt = 0; attempt < 30; attempt++) {
    const world = makeWorld(1600);
    const reqs = events.planStage(spec, world);
    assert.equal(reqs.length, spec.gates * spec.perGate, "every gate, every block");

    const rows = [...new Set(reqs.map((r) => r.worldY))].sort((a, b) => a - b);
    assert.equal(rows.length, spec.gates, "one row per gate");

    rows.forEach((worldY, gate) => {
      const blocks = reqs.filter((r) => r.worldY === worldY);
      assert.equal(blocks.length, spec.perGate, "each gate is the same depth");

      // ONE SIDE PER GATE, ALTERNATING. The starting side is rolled; what must
      // hold is that consecutive gates open on opposite halves, which is the
      // whole of what makes this a weave rather than a queue of roadblocks.
      const sides = new Set(blocks.map((b) => Math.sign(b.offset)));
      assert.equal(sides.size, 1, "a gate must come from one barrier");
      if (gate > 0) {
        const prev = Math.sign(reqs.find((r) => r.worldY === rows[gate - 1]).offset);
        assert.notEqual([...sides][0], prev, "gates must alternate sides");
      }

      // Wholly on the tarmac, and stacked inward from the barrier with real
      // daylight between them — see events.js's GATE_CLEARANCE for why exactly
      // touching is the one spacing that must not be used.
      const offsets = blocks.map((b) => b.offset).sort((a, b) => a - b);
      for (const offset of offsets) {
        assert.ok(Math.abs(offset) + w / 2 <= ROAD_HALF_WIDTH + 1e-9, "a block hangs over a barrier");
      }
      for (let i = 1; i < offsets.length; i++) {
        assert.ok(offsets[i] - offsets[i - 1] > w, "two blocks in a gate must not overlap");
      }
    });

    // GATES FAR ENOUGH APART TO BOTH EXIST. The inner block of one gate and the
    // inner block of the next overlap laterally, so obstacles.js's own spacing
    // rule applies between them: closer than SPAWN_GAP plus a block and the
    // second gate is simply refused, which would read as a slalom with holes.
    const h = OBSTACLE_SHAPES[type.shape].size[1];
    for (let i = 1; i < rows.length; i++) {
      assert.ok(rows[i] - rows[i - 1] >= OBSTACLE_SPAWN_GAP + h, "gates too close to both land");
    }

    // Now lay it for real: every block down, and a way through every gate.
    for (const req of reqs) {
      world.obstacles.place(req.type, req.worldY, req.offset, [], true);
    }
    assert.equal(world.obstacles.list.length, reqs.length, "every block of the weave must land");
    for (const worldY of rows) {
      assert.ok(
        world.obstacles.leavesPassage(worldY, 0, 0),
        "a slalom gate must narrow the road, never close it",
      );
    }
  }
});

test("a staged rank never fills every lane", () => {
  // `abreast`'s guarantee, generalised to the whole director — see THE OPEN
  // LANE in events.js's fire(). obstacles.js's passage rule guards hazards and
  // knows nothing about cars, so a rank of them is the one formation that could
  // wall the road; multi-rank, multi-type staging is what made the old per-spec
  // clamp insufficient.
  //
  // Asked of a deliberately abusive entry rather than of the catalogue: four
  // separate one-car specs at the same worldY, which is exactly the shape a
  // mis-authored rank takes.
  const wall = {
    id: "test-wall",
    label: null,
    weight: 1,
    minDistance: 0,
    maxDistance: Infinity,
    cooldown: 0,
    duration: 10,
    density: { cars: 0, hazards: 0 },
    stage: [0, 1, 2, 3].map(() => (
      { kind: "cars", type: "interceptor", count: 1, side: "ahead", spread: 0 }
    )),
  };

  // Fired through the REAL director rather than through a seam cut for the
  // test: the entry goes into the catalogue and FOCUS makes it the only thing
  // eligible, which is exactly what that switch is exported for (eventtypes.js).
  const world = makeWorld(0);
  EVENT_TYPES.push(wall);
  FOCUS.push(wall.id);
  try {
    events.reset();
    // Rolls pinned ON, and driven from a standing start: the milestones on the
    // way (warband, rival, the boss) fire first and hold the director for their
    // own durations, exactly as they would in a run.
    withRandom(0, () => {
      for (let d = 0; d <= 2000 * DIST_UNITS && events.active() !== wall.id; d += DIST_UNITS) {
        world.distance = d;
        events.update(d / 1000, world, {}, ...QUIET);
        if (events.active() !== wall.id) sweepStaged(world);
      }
    });
  } finally {
    EVENT_TYPES.pop();
    FOCUS.pop();
  }

  assert.equal(events.active(), wall.id, "the wall never fired");
  const staged = world.traffic.cars.filter((c) => c.staged);
  const lanes = new Set(staged.map((c) => c.lane));
  assert.ok(staged.length > 0, "the wall staged nothing at all");
  assert.ok(
    lanes.size <= LANE_COUNT - 1,
    `a staged rank took ${lanes.size} of ${LANE_COUNT} lanes — the player must have one`,
  );
});

test("every type staged ahead has a tactic that brings it to the player", () => {
  // THE CEILING A BIGGER MARGIN DOES NOT BUY THROUGH. events.js's arrivalSpeed
  // caps a car staged ahead at the player's own speed, so it HOLDS ITS GAP
  // until its tactic acts: it never drifts into view on its own. Whether the
  // player ever meets a rank staged up the road is therefore decided by the
  // tactic, not by the margin — and a deep formation of cars that simply cruise
  // would announce an encounter and show the player nothing, which is the
  // failure `warband` shipped with in a different form.
  //
  // The two civilian tactics are the ones that fail this: they drive the road,
  // not the player (see behaviours.js's tactics table). Everything hostile is
  // written against the player's own position.
  const civilian = new Set(["cruise", "overtake"]);
  for (const type of EVENT_TYPES) {
    for (const spec of type.stage ?? []) {
      if (spec.kind !== "cars" || spec.side === "behind") continue;
      const staged = carTypeById(spec.type);
      assert.ok(TACTIC_NAMES.includes(staged.behaviour), `${spec.type} names no real tactic`);
      assert.ok(
        !civilian.has(staged.behaviour),
        `${type.id} stages ${spec.type} ahead, but "${staged.behaviour}" never closes on ` +
          `the player — staged ahead it would hold its gap and never be seen`,
      );
    }
  }
});

test("a deep rank still has road enough to dodge the hazards ahead of it", () => {
  // THE COST OF STAGING DEEPER, and the reason STAGED_RETIRE_MARGIN is not just
  // "as big as anyone likes". obstacles.js's SPAWN_MARGIN (1500) is sized so
  // that a car at the AMBIENT retire boundary still has the road the worst
  // dodger in the catalogue needs to cross two lanes — test/hazards.test.js
  // pins that. A staged car is allowed further up the road than that boundary,
  // which spends the same budget from the other end: stage a rank at `lead` 500
  // and the cars in it meet the hazard line with 500 units less road to react.
  //
  // Asked of what the CATALOGUE actually stages rather than of the margin, so
  // the headroom is available to whoever wants it and only an entry that
  // actually spends it has to answer for it.
  const world = makeWorld(1600);
  const front = world.distance + world.player.y;
  for (const type of EVENT_TYPES) {
    for (const spec of type.stage ?? []) {
      if (spec.kind !== "cars" || spec.side === "behind") continue;
      const staged = carTypeById(spec.type);
      const deepest = Math.max(...events.planStage(spec, world).map((r) => r.worldY)) - front;
      const needed = deepest + dodgeDistance(staged.speedMax, staged.steerSpeed);
      assert.ok(
        needed <= OBSTACLE_SPAWN_MARGIN,
        `${type.id} stages ${spec.type} ${deepest.toFixed(0)} units up the road, which leaves ` +
          `${(OBSTACLE_SPAWN_MARGIN - deepest).toFixed(0)} units to a hazard it needs ` +
          `${dodgeDistance(staged.speedMax, staged.steerSpeed).toFixed(0)} to dodge`,
      );
    }
  }
});

test("a wall of rigs is staged where traffic enters, not where hazards do", () => {
  // A LIVE BUG UNTIL THE STAGED MARGIN WORK. `abreast` was laying its cars at
  // obstacles.js's SPAWN_MARGIN — 1500 units up the road — so Traffic.retire()
  // dropped all three on the tick they were placed. `blockade` fired, announced
  // itself, held the ambient road down for its whole duration and put nothing
  // on it, which is character for character the hole `warband` fell into before
  // the `cars` kind was fixed. Pinned so it cannot be dug twice.
  const world = makeWorld(1000);
  const reqs = events.planStage(eventTypeById("blockade").stage[0], world);
  const front = world.distance + world.player.y;

  assert.ok(reqs.length > 0, "the blockade staged nothing");
  for (const req of reqs) {
    assert.ok(req.worldY > front, "a rig must not materialise in view");
    world.traffic.place(req.type, req.worldY, req.lane, req.speed, true);
  }
  world.traffic.retire(world);
  assert.equal(
    world.traffic.cars.length, reqs.length,
    "every rig of the blockade must survive the tick it was placed on",
  );
});

test("a worksite cones off ONE side, in the order the player meets it", () => {
  // `roadworks`' whole claim is a sentence read in order: the trestle warns,
  // the barrels behind it are what it warns about. Both halves are asserted —
  // one side (so the other one is open by construction) and increasing worldY
  // in the sequence's own order (so the warning is never behind the danger).
  const spec = eventTypeById("roadworks").stage[0];

  for (let attempt = 0; attempt < 40; attempt++) {
    const world = makeWorld(1100);
    const reqs = events.planStage(spec, world);

    assert.equal(reqs.length, spec.types.length, "one hazard per item in the sequence");
    const sides = new Set(reqs.map((r) => Math.sign(r.offset)));
    assert.equal(sides.size, 1, "a worksite must sit on one side of the road");

    reqs.forEach((req, i) => {
      assert.equal(req.type.id, spec.types[i], "the sequence keeps its order");
      if (i > 0) {
        assert.ok(req.worldY > reqs[i - 1].worldY, "each item is further up the road");
      }
      // Hard against that barrier at its OWN width — see events.js's `flank`.
      const w = OBSTACLE_SHAPES[req.type.shape].size[0];
      assert.equal(Math.abs(req.offset), ROAD_HALF_WIDTH - w / 2);
    });
  }

  // AND THE WHOLE SEQUENCE HAS TO LAND. obstacles.js's SPAWN_GAP refuses a
  // hazard laid too close behind another, and a worksite that lost its barrels
  // to it would still announce itself and still read as a lane closure — the
  // failure is invisible from the outside, which is exactly why it is pinned
  // here. See the spacing note in the catalogue entry.
  const laid = makeWorld(1100);
  for (const req of events.planStage(spec, laid)) {
    laid.obstacles.place(req.type, req.worldY, req.offset, [], true);
  }
  assert.equal(
    laid.obstacles.list.length, spec.types.length,
    "every item of the worksite must clear the spacing rule",
  );

  // Over many rolls it uses both sides: the side is a decision the player has
  // to read, not a line they can memorise.
  const seen = new Set();
  for (let attempt = 0; attempt < 60; attempt++) {
    seen.add(Math.sign(events.planStage(spec, makeWorld(1100))[0].offset));
  }
  assert.equal(seen.size, 2, "the closed side must be rolled, not authored");
});

test("a chokepoint leads with its warning and holds a corridor open", () => {
  // The two-spec shape `lead` exists for (events.js): trestles first, tank
  // traps starting past them. Asserted as a relation between the specs rather
  // than against fixed numbers, so retuning the catalogue moves the test with
  // it — what must stay true is that no trap is laid level with or ahead of
  // the trestles that warn about it.
  const world = makeWorld(2100);
  const [warn, traps] = eventTypeById("chokepoint").stage;
  const warnReqs = events.planStage(warn, world);
  const trapReqs = events.planStage(traps, world);

  assert.equal(warnReqs.length, warn.count * 2, "warning rows, both sides");
  assert.equal(trapReqs.length, traps.count * 2, "trap rows, both sides");
  assert.ok(
    Math.min(...trapReqs.map((r) => r.worldY)) > Math.max(...warnReqs.map((r) => r.worldY)),
    "every tank trap must sit past every trestle that warns about it",
  );

  // Now lay the whole thing for real. The corridor is what this encounter IS,
  // so the rows have to actually land — a chokepoint the passage rule thinned
  // out would be a lane closure with extra steps — and the slot between them
  // has to stay drivable at every row.
  for (const req of [...warnReqs, ...trapReqs]) {
    world.obstacles.place(req.type, req.worldY, req.offset, [], true);
  }
  assert.equal(
    world.obstacles.list.length, warnReqs.length + trapReqs.length,
    "the corridor is wide enough that nothing is refused",
  );
  for (const worldY of new Set(world.obstacles.list.map((o) => o.worldY))) {
    assert.ok(
      world.obstacles.leavesPassage(worldY, 0, 0),
      "a chokepoint must narrow the road, never close it",
    );
  }
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

test("the rival turns up once, before the road can produce one of its own", () => {
  // The mini-boss adds no car and no tactic — cartypes.js's rival and
  // behaviours.js's `duel` already existed. What the entry adds is the
  // GUARANTEE: at weight 0.3 a player could drive past its gate and never meet
  // one. So this asserts the two things that makes true — it arrives, and it
  // arrives once.
  //
  // IT NOW ARRIVES EARLY ON PURPOSE. This used to assert that the encounter sat
  // on exactly the car's own `minDistance`; the two have been split, and the
  // split is the point. The rival is being tuned up into a proper mini-boss, so
  // the scripted meeting comes first (900) and the ambient road only starts
  // producing them much later (1400) — otherwise a second one could turn up
  // while the first fight was still running and the encounter would read as
  // weather rather than as an event.
  events.reset();
  const world = makeWorld(0);
  const rival = eventTypeById("rival");
  assert.ok(
    rival.at < carTypeById("rival").minDistance,
    "the scripted meeting must come before the road can roll one for itself",
  );

  const staged = () => world.traffic.cars.filter((c) => c.staged && c.type.id === "rival");

  withRandom(1, () => drive(world, 0, rival.at - 10, {}));
  assert.equal(staged().length, 0, "not before its distance");

  // Stepped one unit at a time so the world is inspected AT the moment of
  // placement. `drive` never ticks Traffic, so a staged car does not move while
  // the odometer does — read a dozen units later, anything staged ahead looks
  // like it is behind, which is an artefact of the harness and not of the game.
  let placedAt = null;
  withRandom(1, () => {
    for (let d = rival.at - 8; d <= rival.at + 4 && !placedAt; d += 1) {
      world.distance = d * DIST_UNITS;
      events.update(d / 10, world, {}, ...QUIET);
      if (staged().length) placedAt = world.distance;
    }
  });
  assert.ok(placedAt !== null, "the rival never arrived");
  assert.equal(staged().length, 1, "exactly one rival, at its distance");
  assert.equal(events.active(), "rival");

  // AHEAD of the player, and off the top of the screen rather than in view.
  // This used to assert "behind", on the rule that a car faster than the player
  // belongs in the mirror — but the rival's band barely clears the player's
  // ceiling, so staged behind it never actually arrived (see the catalogue
  // entry, which carries the measurement). What still has to hold is that it
  // enters from off-screen and inside the road Traffic will keep.
  const front = placedAt + world.player.y;
  assert.ok(staged()[0].worldY > front, "the rival must not materialise in view");
  assert.ok(
    staged()[0].worldY - front < STAGED_RETIRE_MARGIN,
    "the rival must arrive inside the staged retire margin, or it is dropped at once",
  );

  // Kill it, drive on well past the milestone: a one-shot never comes back.
  for (const car of staged()) car.alive = false;
  world.traffic.cars = world.traffic.cars.filter((c) => c.alive);
  withRandom(1, () => drive(world, rival.at + 6, rival.at + 200, {}));
  assert.equal(staged().length, 0, "a `once` milestone must not fire twice in a run");
});

// --- The shop visit ----------------------------------------------------------

// The first shop milestone that no ONE-SHOT set-piece is sitting on top of.
//
// Milestones DEFER rather than cancel, so a shop visit that comes due inside a
// live encounter is late by that encounter's duration — correct behaviour, and
// tested for on purpose two tests below. It is not what a test about the SHOP
// wants to be measuring, though, and the catalogue keeps growing set-pieces: the
// boss landed on exactly SHOP_INTERVAL * 3, which is the milestone these tests
// used to hard-code. Derived, so the next one to land breaks nothing.
// Road after ANY encounter before the director will start another (events.js's
// own EVENT_GAP, which is not exported). Stated here as a floor rather than
// imported, so a test needing elbow room asks for MORE than the real gap and
// stays right if that number is lowered.
const EVENT_GAP_GUARD = 30;

function quietShopLap(from = 1) {
  const oneShots = EVENT_TYPES.filter((t) => t.at !== undefined);
  for (let lap = from; lap < 40; lap++) {
    const at = SHOP_INTERVAL * lap;
    // The SHADOW of a set-piece is its duration PLUS the director's gap: for a
    // few dozen units after one ends, no roll may fire at all. A test that
    // needs to force a rolled encounter next to this lap has to clear both, or
    // it fails with "expected a rolled encounter to be live" for a reason that
    // has nothing to do with what it is testing.
    const clash = oneShots.some(
      (t) => at >= t.at && at <= t.at + (t.duration ?? 0) + EVENT_GAP_GUARD,
    );
    if (!clash) return lap;
  }
  throw new Error("no shop milestone is clear of a set-piece");
}

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
  const due = SHOP_INTERVAL * quietShopLap(3);
  withRandom(1, () => drive(world, 0, due - 40, handlers));
  const before = due / SHOP_INTERVAL - 1;
  assert.equal(fires, before, "the earlier milestones should have passed uneventfully");

  // THE ROAD IS CLEARED FIRST, because `drive` is a scheduler harness and never
  // ticks Traffic — so nothing it staged on the way here has ever been retired,
  // and by this lap the set-pieces behind us have filled events.js's staged-car
  // budget. In a real run every one of them is hundreds of units astern and long
  // gone. Without this the roll below is refused for want of a slot, and the
  // test fails claiming no encounter fired.
  world.traffic.cars.length = 0;

  // Now force a rolled encounter to fire in the last few units before the
  // milestone, so it is still running when that milestone comes due.
  withRandom(0, () => drive(world, due - 38, due - 20, handlers));
  assert.ok(events.active(), "expected a rolled encounter to be live");
  const staged = world.traffic.cars.filter((c) => c.staged);
  assert.ok(staged.length, "expected it to have staged something");

  // ...and drive straight through the milestone with it still running.
  withRandom(1, () => drive(world, due - 18, due + 4, handlers));
  assert.equal(fires, before, "a milestone must not fire over the top of a live encounter");
  assert.ok(events.active(), "and the encounter is what is holding it");

  // The encounter ends (here, by the player killing it) — and the deferred
  // milestone is spent on that very tick, not on the next interval.
  for (const car of staged) car.alive = false;
  withRandom(1, () => drive(world, due + 6, due + 10, handlers));

  assert.equal(events.active(), null, "the encounter should have ended");
  assert.equal(fires, before + 1, "the deferred shop visit must fire the moment the road clears");
});

test("every shop milestone crossed is spent, exactly once each", () => {
  events.reset();
  const world = makeWorld(0);
  let fires = 0;
  const handlers = { shop: { fire: () => { fires++; }, live: () => false } };

  // Driven to a lap no set-piece is sitting on, so this measures the SPENDING
  // of milestones rather than the deferral of one — see quietShopLap.
  const laps = quietShopLap(3);
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

// How far to drive to have crossed `laps` shop milestones AND have the last of
// them actually fire, in DIST units.
//
// Milestones DEFER rather than cancel (events.js), so a shop visit that comes
// due inside a live encounter is LATE — correct behaviour, pinned on purpose by
// its own test below, and not what a test about the shop's schedule wants to be
// measuring. Which laps are affected depends on two numbers that both move for
// reasons of their own: hauler.js's SHOP_INTERVAL, and where the one-shot
// set-pieces sit. At an interval of 350, lap 2 lands on exactly 700, which is
// `warband`'s trigger; the boss at 1200 carries a 300-unit duration that will
// swallow whichever lap falls inside it.
//
// So rather than hard-code a lap and re-pick it every time the catalogue grows,
// this drives far enough to clear the last set-piece that could be sitting on
// the target lap. Deliberately NOT a way of avoiding the deferral — the visit
// still fires late, and this just drives far enough to see it.
function pastShopLaps(laps) {
  const at = SHOP_INTERVAL * laps;
  let end = at + 5;
  for (const t of EVENT_TYPES) {
    if (t.at === undefined) continue;
    if (at < t.at || at > t.at + (t.duration ?? 0)) continue;
    end = Math.max(end, t.at + (t.duration ?? 0) + 5);
  }
  return end;
}

test("a whole shop visit ends, so the road comes back", () => {
  // THE REGRESSION THIS EXISTS FOR. Every other shop test above stubs the
  // handler pair, which is right for questions about the SCHEDULE — but it
  // means none of them ever ran the real drone, and the real drone never went
  // back to "idle" after the return trip. main.js hands `phase !== "idle"` to
  // the director as this encounter's `live`, so a drone stuck in "lower" is an
  // encounter that never finishes: the shop entry's density of zero stays
  // clamped on the road for the rest of the run, and no car, no hazard and no
  // further event ever appears again.
  //
  // So this drives main.js's own state machine — the four calls it makes in
  // updatePlaying/updateLifting/updateShopping/updateLowering — against the
  // real Hauler, and then asks the two questions that were both false.
  events.reset();
  const hauler = new Hauler(800);
  const handlers = {
    shop: {
      fire: () => hauler.approach(0, 496),
      live: () => hauler.phase !== "idle",
    },
  };

  const world = makeWorld(0);
  withRandom(1, () => drive(world, 0, SHOP_INTERVAL + 5, handlers));
  assert.equal(hauler.phase, "approach", "the milestone must have called the drone down");

  // The approach, with the world still live (main.js's updatePlaying).
  while (!hauler.grabbed) hauler.update(1 / 60, 0);
  hauler.lift();
  // The frozen lift (updateLifting), then the shop screen, then the return trip
  // (updateShopping's respawnWorld()/lower(), and updateLowering).
  while (!hauler.done) hauler.update(1 / 60, 0);
  hauler.lower(0, 496);
  while (!hauler.done) hauler.update(1 / 60, 0);
  hauler.settle();

  assert.equal(hauler.phase, "idle", "the drone must retire itself when the car is back down");

  // One more tick of the director with the road handed back: the encounter has
  // to clear, and both budgets have to come off zero.
  world.distance += 2 * DIST_UNITS;
  events.update(0, world, handlers, ...QUIET);
  assert.equal(events.active(), null, "the shop encounter must be over");
  assert.equal(world.traffic.density, 1, "traffic must be spawning again");
  assert.equal(world.obstacles.density, 1, "hazards must be spawning again");

  // ...and the NEXT milestone still comes round, which is the other half of the
  // same bug: a stuck encounter also swallowed every later shop visit.
  // Far enough for the second milestone to fire even when a set-piece is sitting
  // on it and holding it back — see pastShopLaps. LATE is the contract; lost is
  // the bug this half is about.
  withRandom(1, () => drive(world, SHOP_INTERVAL + 6, pastShopLaps(2), handlers));
  assert.equal(hauler.phase, "approach", "the second shop visit must still happen");
});

test("the shop screen can say which stop this is", () => {
  // main.js prints "STOP N" from the milestone counter, which moved out of
  // hauler.js into the director — an undefined here is a visible defect on the
  // shop's own header.
  events.reset();
  assert.equal(events.milestoneCount("shop"), 0);
  const world = makeWorld(0);
  const handlers = { shop: { fire: () => {}, live: () => false } };
  withRandom(1, () => drive(world, 0, pastShopLaps(2), handlers));
  assert.equal(events.milestoneCount("shop"), 2, "two milestones crossed is STOP 2");
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

// --- The boss encounter --------------------------------------------------------

test("the boss encounter stages a battery the road can actually keep", () => {
  // The whole failure this encounter was built on top of, pinned end to end:
  // every car the siege stages must arrive off-screen, inside the retire margin
  // and at no more than the player's pace. Asserted against the SHIPPING
  // catalogue entry rather than a fixture, because the numbers that matter here
  // (the mortar's 730 speed band, the escort's spread) live in the catalogue.
  const world = makeWorld(1200);
  const siege = eventTypeById("siege");
  const front = world.distance + world.player.y;

  let staged = 0;
  for (const spec of siege.stage) {
    for (const req of events.planStage(spec, world)) {
      staged++;
      if (spec.side === "behind") {
        // Behind the player there is as much road as anyone wants, and a car
        // arriving in the mirror is meant to keep its own speed band.
        assert.ok(req.worldY < world.distance, `${spec.type} staged behind is not behind`);
        continue;
      }
      assert.ok(req.worldY > front, `${spec.type} materialised in view`);
      assert.ok(
        req.worldY - front < STAGED_RETIRE_MARGIN,
        `${spec.type} staged outside the staged retire margin — it would be dropped on arrival`,
      );
      assert.ok(
        req.speed <= world.player.speed,
        `${spec.type} arrives at ${req.speed.toFixed(0)} and would simply drive away`,
      );
    }
  }
  assert.equal(staged, 5, "a battery and four escorts");

  // ...AND THE FORMATION MUST ACTUALLY LAND, which is a different question.
  // planStage only says what is ASKED for; Traffic.place is what refuses a lane
  // already taken, and the escort used to lose a car to the battery's own row
  // EVERY time — four interceptors and a 90-long battery cannot sit abreast in
  // four lanes inside the 140 units a formation staged ahead has to fit in. It
  // read as the encounter being tuned to three.
  //
  // Measured over many firings rather than asserted once, because placement is
  // genuinely random (lane draws, and the odd busy road) and best-effort by
  // design: the invariant worth pinning is that the escort does not RELIABLY
  // come up short, not that it never does.
  let full = 0;
  const runs = 60;
  for (let i = 0; i < runs; i++) {
    const w = makeWorld(1200);
    for (const spec of siege.stage) {
      for (const req of events.planStage(spec, w)) {
        w.traffic.place(req.type, req.worldY, req.lane, req.speed, true)
          ?? (() => {
            const lane = w.traffic.freeLane(req.worldY, req.type.w, req.type.h);
            return lane === -1 ? null : w.traffic.place(req.type, req.worldY, lane, req.speed, true);
          })();
      }
    }
    const cars = w.traffic.cars;
    const ok = cars.filter((c) => c.type.id === "mortar").length === 1
      && cars.filter((c) => c.type.id === "interceptor").length === 4;
    if (ok) full++;
    // The pincer, every time: the battery ahead and part of the escort behind.
    assert.ok(cars.some((c) => c.worldY > w.distance), "nothing staged ahead of the player");
    assert.ok(cars.some((c) => c.worldY < w.distance), "nothing staged behind the player");
  }
  assert.ok(
    full >= runs * 0.8,
    `the full battery and escort landed only ${full}/${runs} times — a formation ` +
      `that reliably loses a car is a formation with the wrong count on it`,
  );
});

test("the boss encounter empties the road and leads with the battery", () => {
  // Both budgets to zero — the barrage needs empty tarmac to read against — and
  // the mortar `atomic`, so an encounter that could not place its battery is
  // abandoned with the milestone unspent rather than firing as two escorts.
  const siege = eventTypeById("siege");
  assert.equal(siege.density.cars, 0, "a boss fight does not share the road");
  assert.equal(siege.density.hazards, 0);
  assert.equal(siege.stage[0].type, "mortar", "the battery must be the lead");
  assert.ok(siege.stage[0].atomic, "no battery, no encounter");
  assert.ok(siege.once && siege.at !== undefined, "the boss is a one-shot milestone");
});

// Drive from a standing start until `id` is the live encounter, so a test does
// not have to know which milestone comes first or what a test build's
// EVENT_AT_OVERRIDES (src/testoptions.js) has done to the trigger distances.
// Rolls are pinned off, so only milestones fire.
function driveUntilLive(world, id, limit = 2000) {
  events.reset();
  return withRandom(1, () => {
    for (let d = 0; d <= limit * DIST_UNITS; d += DIST_UNITS) {
      world.distance = d;
      events.update(d / 1000, world, {}, ...QUIET);
      if (events.active() === id) return true;
      // Same standing-in-for-retire() as `drive` does, and needed for the same
      // reason: without it the set-pieces passed on the way here fill the
      // staged-car budget and the encounter we are driving towards is refused
      // its cars.
      sweepStaged(world);
    }
    return false;
  });
}

test("a staged car that leaves the road ends its encounter", () => {
  // Traffic.retire() drops a car by FILTERING IT OUT of the list without
  // touching `alive` — so an encounter holding a reference to one used to stay
  // live after everything it staged had gone, pinning the ambient density at
  // whatever it had set. For a set-piece that means an EMPTY ROAD, for the rest
  // of the encounter's duration, with nothing on it to explain why.
  //
  // The boss's duration is the longest in the catalogue, which is what made this
  // worth fixing rather than tolerating; it is also how the one escape that
  // fight allows resolves cleanly, since a player who outruns the battery leaves
  // it to be retired like any other car.
  const world = makeWorld(0);
  assert.ok(driveUntilLive(world, "siege"), "the boss encounter never went live");

  // Everything staged drives off the road, exactly as retire() would leave it:
  // gone from the list, still flagged alive.
  const staged = world.traffic.cars.filter((c) => c.staged);
  assert.ok(staged.length > 0, "the encounter staged nothing to retire");
  assert.ok(staged.every((c) => c.alive), "the fixture must mimic retire(), not a kill");
  world.traffic.cars = world.traffic.cars.filter((c) => !c.staged);

  events.update(0, world, {}, ...QUIET);
  assert.equal(events.active(), null, "an encounter with nothing left on the road must end");
});

test("an encounter that times out with something still alive announces its withdrawal", () => {
  // The rough edge the rival's entry named out loud: a fight whose duration ran
  // out while the car was still healthy "would just quietly hand the road back".
  // A set-piece announces its withdrawal instead — but only when something
  // actually survived, since an encounter the player cleared has already
  // announced itself in fireballs.
  const siege = eventTypeById("siege");
  assert.ok(siege.exitLabel, "a set-piece must be able to announce its own withdrawal");

  const world = makeWorld(0);
  assert.ok(driveUntilLive(world, "siege"), "the boss encounter never went live");

  const said = [];
  const loud = [(text) => said.push(text), () => false];
  // Past the duration with the battery still on the road. A LATER CLOCK VALUE
  // than the entry line used, because links.js rate-limits how often the city
  // may speak and the two would otherwise share one budget.
  world.distance += (siege.duration + 1) * DIST_UNITS;
  events.update(1e6, world, {}, ...loud);

  assert.equal(events.active(), null, "the encounter must have expired");
  assert.ok(
    said.includes(siege.exitLabel),
    `expected the withdrawal line, got ${JSON.stringify(said)}`,
  );
});

test("an encounter the player cleared withdraws in silence", () => {
  // The other half: nothing survived, so there is nothing to announce leaving.
  const siege = eventTypeById("siege");
  const world = makeWorld(0);
  assert.ok(driveUntilLive(world, "siege"), "the boss encounter never went live");

  for (const car of world.traffic.cars) car.alive = false;

  const said = [];
  events.update(1e6, world, {}, (text) => said.push(text), () => false);
  assert.equal(events.active(), null, "a cleared encounter must end");
  assert.ok(
    !said.includes(siege.exitLabel),
    "a battery the player destroyed must not announce that it is leaving",
  );
});
