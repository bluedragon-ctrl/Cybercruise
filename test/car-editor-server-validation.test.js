import { test } from "node:test";
import assert from "node:assert/strict";
import { validateChanges, validateObstacleChanges } from "../tools/car-editor/server.js";

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
