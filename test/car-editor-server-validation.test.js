import { test } from "node:test";
import assert from "node:assert/strict";
import { validateChanges } from "../tools/car-editor/server.js";

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
