import { test } from "node:test";
import assert from "node:assert/strict";
import {
  validateChanges,
  validateObstacleChanges,
  validatePickupChanges,
  POSITIVE_FIELDS,
} from "../tools/car-editor/server.js";
import {
  CAR_IDS,
  HULL_SPEED_FIELDS,
  SPAWN_FIELDS,
  BEHAVIOR_FIELDS,
  OBSTACLE_IDS,
  OBSTACLE_FIELDS,
  PICKUP_IDS,
  PICKUP_SPAWN_FIELDS,
  PICKUP_EFFECT_FIELDS,
} from "../tools/car-editor/state.js";

test("validateChanges rejects a negative health value", () => {
  assert.throws(
    () => validateChanges({ cycle: { health: -50 } }),
    /field "health" for "cycle" must be a positive number, got -50/
  );
});

test("validateChanges rejects a zero speedMin value", () => {
  assert.throws(
    () => validateChanges({ rival: { speedMin: 0 } }),
    /field "speedMin" for "rival" must be a positive number, got 0/
  );
});

test("validateChanges accepts a valid speedMin/speedMax pair", () => {
  assert.doesNotThrow(() =>
    validateChanges({ rival: { speedMin: 420, speedMax: 470 } })
  );
});

test("validateChanges rejects speedMax < speedMin when both are given", () => {
  assert.throws(
    () => validateChanges({ rival: { speedMin: 470, speedMax: 400 } }),
    /speedMax \(400\) must be >= speedMin \(470\) for "rival"/
  );
});

test("validateChanges accepts speedMax alone without speedMin in the request", () => {
  assert.doesNotThrow(() => validateChanges({ rival: { speedMax: 500 } }));
});

test("validateChanges accepts a civilian car id", () => {
  assert.doesNotThrow(() => validateChanges({ sedan: { health: 70 } }));
});

test("validateChanges rejects an unknown car id", () => {
  assert.throws(
    () => validateChanges({ ghost: { health: 70 } }),
    /unknown car id "ghost"/
  );
});

test("validateChanges accepts a zero minDistance value", () => {
  assert.doesNotThrow(() => validateChanges({ sedan: { minDistance: 0 } }));
});

test("validateChanges rejects a negative minDistance value", () => {
  assert.throws(
    () => validateChanges({ interceptor: { minDistance: -5 } }),
    /field "minDistance" for "interceptor" must not be negative, got -5/
  );
});

test("validateObstacleChanges accepts weight and minDistance together", () => {
  assert.doesNotThrow(() =>
    validateObstacleChanges({ trestle: { weight: 4, minDistance: 20 } })
  );
});

test("validateObstacleChanges accepts a zero weight (takes the type out of the draw)", () => {
  assert.doesNotThrow(() => validateObstacleChanges({ caltrop: { weight: 0 } }));
});

test("validateObstacleChanges rejects a negative weight", () => {
  assert.throws(
    () => validateObstacleChanges({ caltrop: { weight: -1 } }),
    /field "weight" for "caltrop" must not be negative, got -1/
  );
});

test("validateObstacleChanges rejects a negative minDistance", () => {
  assert.throws(
    () => validateObstacleChanges({ tetra: { minDistance: -10 } }),
    /field "minDistance" for "tetra" must not be negative, got -10/
  );
});

test("validateObstacleChanges rejects an unknown obstacle id", () => {
  assert.throws(
    () => validateObstacleChanges({ ghost: { weight: 1 } }),
    /unknown obstacle id "ghost"/
  );
});

test("validateObstacleChanges rejects an unknown field", () => {
  assert.throws(
    () => validateObstacleChanges({ trestle: { health: 100 } }),
    /unknown field "health" for "trestle"/
  );
});

test("validateObstacleChanges rejects an empty changes object", () => {
  assert.throws(() => validateObstacleChanges({}), /must not be empty/);
});

test("validatePickupChanges accepts weight and minDistance together", () => {
  assert.doesNotThrow(() =>
    validatePickupChanges({ fix: { weight: 2, minDistance: 20 } })
  );
});

test("validatePickupChanges accepts a zero weight (takes the type out of the draw)", () => {
  assert.doesNotThrow(() => validatePickupChanges({ shield: { weight: 0 } }));
});

test("validatePickupChanges rejects a negative weight", () => {
  assert.throws(
    () => validatePickupChanges({ shield: { weight: -1 } }),
    /field "weight" for "shield" must not be negative, got -1/
  );
});

test("validatePickupChanges rejects a negative minDistance", () => {
  assert.throws(
    () => validatePickupChanges({ fix: { minDistance: -10 } }),
    /field "minDistance" for "fix" must not be negative, got -10/
  );
});

test("validatePickupChanges rejects an unknown pickup id", () => {
  assert.throws(
    () => validatePickupChanges({ ghost: { weight: 1 } }),
    /unknown pickup id "ghost"/
  );
});

test("validatePickupChanges rejects an unknown field", () => {
  assert.throws(
    () => validatePickupChanges({ fix: { weaponId: "rocket" } }),
    /unknown field "weaponId" for "fix"/
  );
});

test("validatePickupChanges rejects an empty changes object", () => {
  assert.throws(() => validatePickupChanges({}), /must not be empty/);
});

test("validatePickupChanges accepts an amount change for an AMMO/HEAL pickup", () => {
  assert.doesNotThrow(() => validatePickupChanges({ fix: { amount: 90 } }));
});

test("validatePickupChanges accepts a duration change for the SHIELD pickup", () => {
  assert.doesNotThrow(() => validatePickupChanges({ shield: { duration: 8 } }));
});

test("validatePickupChanges rejects a zero amount", () => {
  assert.throws(
    () => validatePickupChanges({ fix: { amount: 0 } }),
    /field "amount" for "fix" must be a positive number, got 0/
  );
});

test("validatePickupChanges rejects a negative duration", () => {
  assert.throws(
    () => validatePickupChanges({ shield: { duration: -5 } }),
    /field "duration" for "shield" must be a positive number, got -5/
  );
});

// The three validators were near-copies until they shared a core, and the copy
// that drifted (validateObstacleChanges) was the one that quietly dropped the
// POSITIVE_FIELDS check. That went unnoticed because OBSTACLE_FIELDS contains
// no positive-only field, so no hand-written case could have caught it.
//
// This one is derived from the field tables instead: it asks every catalogue
// about every positive-only field it actually has. It is vacuous for obstacles
// TODAY and becomes a live assertion the moment one gains such a field, which
// is precisely when the old gap would have reopened.
const CATALOGUES = [
  { name: "validateChanges", fn: validateChanges, id: CAR_IDS[0],
    fields: [...HULL_SPEED_FIELDS, ...SPAWN_FIELDS, ...BEHAVIOR_FIELDS] },
  { name: "validateObstacleChanges", fn: validateObstacleChanges, id: OBSTACLE_IDS[0],
    fields: OBSTACLE_FIELDS },
  { name: "validatePickupChanges", fn: validatePickupChanges, id: PICKUP_IDS[0],
    fields: [...PICKUP_SPAWN_FIELDS, ...PICKUP_EFFECT_FIELDS] },
];

test("every validator enforces POSITIVE_FIELDS on every such field it accepts", () => {
  for (const { name, fn, id, fields } of CATALOGUES) {
    for (const field of fields) {
      if (!POSITIVE_FIELDS.has(field)) continue;
      for (const bad of [0, -1]) {
        assert.throws(
          () => fn({ [id]: { [field]: bad } }),
          /must be a positive number/,
          `${name} accepted ${field}: ${bad} for "${id}"`,
        );
      }
    }
  }
});
