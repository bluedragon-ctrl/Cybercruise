import { test } from "node:test";
import assert from "node:assert/strict";
import {
  validateChanges,
  validateWeaponChanges,
  validateConstantChanges,
  validateObstacleChanges,
  validatePickupChanges,
  validateUpgradeConsumableChanges,
  validateUpgradeStatChanges,
  POSITIVE_FIELDS,
} from "../tools/car-editor/server.js";
import {
  CAR_IDS,
  CAR_TYPE_FIELDS,
  BEHAVIOR_FIELDS,
  OBSTACLE_IDS,
  OBSTACLE_FIELDS,
  PICKUP_IDS,
  PICKUP_SPAWN_FIELDS,
  PICKUP_EFFECT_FIELDS,
  UPGRADE_CONSUMABLE_IDS,
  UPGRADE_STAT_IDS,
  WEAPON_IDS,
  buildCarState,
  buildWeaponState,
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

// The speed range has to hold AFTER the edit, so a lone speedMax is checked
// against the speedMin already in the source rather than waved through — the
// pair-only check this replaces let an edit invert a car's range in one field.
test("validateChanges accepts speedMax alone when it clears the car's current speedMin", () => {
  const { speedMin } = buildCarState("rival").values;
  assert.doesNotThrow(() => validateChanges({ rival: { speedMax: speedMin + 10 } }));
});

test("validateChanges rejects speedMax alone when it falls under the car's current speedMin", () => {
  const { speedMin } = buildCarState("rival").values;
  assert.throws(
    () => validateChanges({ rival: { speedMax: speedMin - 10 } }),
    // The "unchanged" tag is the point of the message: it says the speedMin
    // it compared against came from the source, not from the request.
    (err) =>
      err.message ===
      `speedMax (${speedMin - 10}) must be >= speedMin (${speedMin}, unchanged) for "rival"`
  );
});

test("validateChanges rejects speedMin alone when it rises above the car's current speedMax", () => {
  const { speedMax } = buildCarState("rival").values;
  assert.throws(
    () => validateChanges({ rival: { speedMin: speedMax + 10 } }),
    /must be >= speedMin/
  );
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
  // `health` used to be the example here, back when spawn odds were all an
  // obstacle exposed. It is a real field now — a hazard's own toughness is
  // tunable — so the example has to be something the catalogue genuinely has
  // no notion of.
  assert.throws(
    () => validateObstacleChanges({ trestle: { nerve: 4 } }),
    /unknown field "nerve" for "trestle"/
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

// The shop's two shelves (game/upgrades.js), edited through their own
// validators for the same reason state.js builds their state separately —
// see server.js's own note on why a consumable and a stat don't share a
// field list.
test("validateUpgradeConsumableChanges accepts a price change", () => {
  assert.doesNotThrow(() => validateUpgradeConsumableChanges({ buy_repair: { price: 120 } }));
});

test("validateUpgradeConsumableChanges accepts an amount change for an AMMO/HEAL row", () => {
  assert.doesNotThrow(() => validateUpgradeConsumableChanges({ buy_repair: { amount: 90 } }));
});

test("validateUpgradeConsumableChanges accepts a duration change for the SHIELD row", () => {
  assert.doesNotThrow(() => validateUpgradeConsumableChanges({ buy_shield: { duration: 8 } }));
});

test("validateUpgradeConsumableChanges rejects a zero price", () => {
  assert.throws(
    () => validateUpgradeConsumableChanges({ buy_repair: { price: 0 } }),
    /field "price" for "buy_repair" must be a positive number, got 0/
  );
});

test("validateUpgradeConsumableChanges rejects a negative amount", () => {
  assert.throws(
    () => validateUpgradeConsumableChanges({ buy_repair: { amount: -5 } }),
    /field "amount" for "buy_repair" must be a positive number, got -5/
  );
});

test("validateUpgradeConsumableChanges rejects an unknown consumable id", () => {
  assert.throws(
    () => validateUpgradeConsumableChanges({ nope: { price: 100 } }),
    /unknown shop consumable id "nope"/
  );
});

test("validateUpgradeConsumableChanges rejects an unknown field", () => {
  assert.throws(
    () => validateUpgradeConsumableChanges({ buy_repair: { step: 5 } }),
    /unknown field "step" for "buy_repair"/
  );
});

test("validateUpgradeConsumableChanges rejects an empty changes object", () => {
  assert.throws(() => validateUpgradeConsumableChanges({}), /must not be empty/);
});

test("validateUpgradeStatChanges accepts price and step together", () => {
  assert.doesNotThrow(() => validateUpgradeStatChanges({ engine: { price: 160, step: 45 } }));
});

test("validateUpgradeStatChanges rejects a zero step", () => {
  assert.throws(
    () => validateUpgradeStatChanges({ engine: { step: 0 } }),
    /field "step" for "engine" must be a positive number, got 0/
  );
});

test("validateUpgradeStatChanges rejects a negative price", () => {
  assert.throws(
    () => validateUpgradeStatChanges({ engine: { price: -10 } }),
    /field "price" for "engine" must be a positive number, got -10/
  );
});

test("validateUpgradeStatChanges rejects an unknown stat id", () => {
  assert.throws(
    () => validateUpgradeStatChanges({ nope: { price: 100 } }),
    /unknown shop stat id "nope"/
  );
});

test("validateUpgradeStatChanges rejects an unknown field", () => {
  assert.throws(
    () => validateUpgradeStatChanges({ engine: { amount: 5 } }),
    /unknown field "amount" for "engine"/
  );
});

test("validateUpgradeStatChanges rejects an empty changes object", () => {
  assert.throws(() => validateUpgradeStatChanges({}), /must not be empty/);
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
    fields: [...CAR_TYPE_FIELDS, ...BEHAVIOR_FIELDS] },
  { name: "validateObstacleChanges", fn: validateObstacleChanges, id: OBSTACLE_IDS[0],
    fields: OBSTACLE_FIELDS },
  { name: "validatePickupChanges", fn: validatePickupChanges, id: PICKUP_IDS[0],
    fields: [...PICKUP_SPAWN_FIELDS, ...PICKUP_EFFECT_FIELDS] },
  { name: "validateUpgradeConsumableChanges", fn: validateUpgradeConsumableChanges,
    id: UPGRADE_CONSUMABLE_IDS[0], fields: ["price", "amount", "duration"] },
  { name: "validateUpgradeStatChanges", fn: validateUpgradeStatChanges,
    id: UPGRADE_STAT_IDS[0], fields: ["price", "step"] },
  // The rocket rather than WEAPON_IDS[0]: a weapon validator rejects a field
  // the entry does not HAVE before it ever gets to a sign check, so this has to
  // ask about the fields that weapon actually carries.
  { name: "validateWeaponChanges", fn: validateWeaponChanges, id: "rocket",
    fields: Object.keys(buildWeaponState("rocket").values) },
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
