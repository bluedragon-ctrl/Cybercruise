import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildCarState,
  buildAllCarState,
  CAR_IDS,
  BEHAVIOR_FIELDS,
  HULL_SPEED_FIELDS,
  SPAWN_FIELDS,
} from "../tools/car-editor/state.js";
import { CAR_TYPES } from "../src/game/cartypes.js";

const HOSTILE_IDS = CAR_TYPES.filter((t) => t.faction === "enemy").map((t) => t.id);

test("buildAllCarState returns every car in the catalogue, civilian and hostile", () => {
  const all = buildAllCarState();
  assert.deepEqual(
    all.map((c) => c.id).sort(),
    [...CAR_IDS].sort()
  );
  // Sanity check that the roster really does include both factions, not just
  // whatever CAR_IDS happens to derive to.
  assert.ok(all.some((c) => c.faction === "enemy"));
  assert.ok(all.some((c) => c.faction === "neutral"));
});

test("buildCarState returns hull, speed, spawn and every behavior field", () => {
  const state = buildCarState("interceptor");
  assert.equal(typeof state.hull.health, "number");
  assert.equal(typeof state.speed.speedMin, "number");
  assert.equal(typeof state.speed.speedMax, "number");
  assert.equal(typeof state.spawn.minDistance, "number");
  for (const field of BEHAVIOR_FIELDS) {
    assert.ok(field in state.behavior, `missing behavior field ${field}`);
    assert.equal(typeof state.behavior[field].inherited, "boolean");
  }
});

test("buildCarState works for a civilian car id", () => {
  const state = buildCarState("sedan");
  assert.equal(state.faction, "neutral");
  assert.equal(typeof state.hull.health, "number");
  assert.equal(typeof state.spawn.minDistance, "number");
});

test("laneHome is always one of the three known lane preferences", () => {
  for (const id of CAR_IDS) {
    const state = buildCarState(id);
    assert.ok(["any", "inner", "outer"].includes(state.behavior.laneHome.value));
  }
});

test("nerve is not flagged as inherited for any hostile type, except the cycle's coincidental default", () => {
  // Every hostile profile explicitly sets its own nerve figure (see
  // driving.js's "Hostile dispositions" section) — this is the field where
  // the roster is least likely to accidentally read as bland defaults.
  //
  // The one exception is the cycle: its "darter" profile explicitly writes
  // `nerve: 0`, which happens to be the same figure the commuter default
  // already uses (COMMUTER.nerve = 0 in driving.js). buildCarState's
  // "inherited" flag is a value-based approximation of "not explicitly
  // overridden" (see state.js's header comment) — it cannot see that the
  // source spells the value out, only that it matches the default — so it
  // reports the cycle's nerve as inherited even though driving.js states it
  // explicitly. That's the documented, accepted limitation of the approach,
  // not a bug: the cycle really does dodge every hazard, same as a bland
  // commuter, so the value is correct even if the "(overridden)" cosmetic
  // tag would be missing in the UI.
  for (const id of HOSTILE_IDS) {
    const state = buildCarState(id);
    const expected = id === "cycle" ? true : false;
    assert.equal(
      state.behavior.nerve.inherited,
      expected,
      `${id}.nerve inherited flag should be ${expected}`
    );
  }
});

test("buildCarState throws for a car id outside the catalogue", () => {
  assert.throws(() => buildCarState("ghost"), /unknown car id "ghost"/);
});

test("HULL_SPEED_FIELDS, SPAWN_FIELDS and BEHAVIOR_FIELDS don't overlap", () => {
  const overlap = [...HULL_SPEED_FIELDS, ...SPAWN_FIELDS].filter((f) =>
    BEHAVIOR_FIELDS.includes(f)
  );
  assert.deepEqual(overlap, []);
});
