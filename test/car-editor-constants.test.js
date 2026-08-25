import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  CONSTANT_GROUPS,
  CONSTANTS,
  CONSTANT_IDS,
  CONSTANT_FILES,
  CONSTANT_BY_ID,
  readConstantValue,
  buildAllConstantState,
  buildConstantState,
} from "../tools/car-editor/constants.js";
import { patchConstant, patchArrayConstantElement } from "../tools/car-editor/patcher.js";
import { MAX_SPEED, BASE_MAX_HEALTH, PLAYER_MASS } from "../src/game/player.js";
import { TIER_PRICES, STATS } from "../src/game/upgrades.js";
import { SHOP_INTERVAL } from "../src/game/hauler.js";

function sourceOf(rel) {
  return readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");
}

test("every constant id is unique", () => {
  // player.js and traffic.js both export ACCEL, so the bare identifier cannot
  // be the key — the ids are group-qualified precisely to keep those apart.
  assert.equal(new Set(CONSTANT_IDS).size, CONSTANT_IDS.length);
});

test("every constant resolves to a finite number in the source it names", () => {
  for (const state of buildAllConstantState()) {
    for (const constant of state.constants) {
      assert.ok(
        Number.isFinite(constant.value),
        `${constant.id} read ${constant.value} from ${constant.file}`
      );
    }
  }
});

test("the values read from source match what the modules actually export", () => {
  // The whole premise of reading text rather than importing is that the two
  // agree. Where a constant IS importable, check that they do.
  const byId = new Map(
    buildAllConstantState().flatMap((g) => g.constants.map((c) => [c.id, c.value]))
  );
  assert.equal(byId.get("player.MAX_SPEED"), MAX_SPEED);
  assert.equal(byId.get("player.BASE_MAX_HEALTH"), BASE_MAX_HEALTH);
  assert.equal(byId.get("player.PLAYER_MASS"), PLAYER_MASS);
  assert.equal(byId.get("run.SHOP_INTERVAL"), SHOP_INTERVAL);
  assert.equal(byId.get("run.TIER_PRICE_2"), TIER_PRICES[1]);
  assert.equal(byId.get("run.TIER_PRICE_3"), TIER_PRICES[2]);
});

test("the three player figures the shop's ladders count up from are all editable", () => {
  // state.js declines to expose a stat's `base` on the shop screen, on the
  // grounds that you should tune the car rather than the shop. That advice
  // pointed nowhere until these existed — so this asserts the destination it
  // points at is actually here.
  const ids = new Set(CONSTANT_IDS);
  for (const id of ["player.MAX_SPEED", "player.BASE_MAX_HEALTH", "player.PLAYER_MASS"]) {
    assert.ok(ids.has(id), `${id} is a shop ladder's base and must be tunable`);
  }
  const bases = new Set(STATS.map((s) => s.base));
  assert.ok(bases.has(MAX_SPEED) && bases.has(BASE_MAX_HEALTH) && bases.has(PLAYER_MASS));
});

test("readConstantValue is anchored to a declaration, not to any mention", () => {
  const source = `// A comment mentioning const MAX_CARS = 99 in passing.\nconst MAX_CARS = 7;\n`;
  assert.equal(readConstantValue(source, "MAX_CARS"), 7);
});

test("readConstantValue does not match a longer name that starts the same way", () => {
  const source = `const SPAWN_INTERVAL_MIN = 5;\nconst SPAWN_INTERVAL = 1.1;\n`;
  assert.equal(readConstantValue(source, "SPAWN_INTERVAL"), 1.1);
});

test("readConstantValue throws for a name that is not declared", () => {
  assert.throws(() => readConstantValue("const A = 1;\n", "B"), /no numeric "const B" found/);
});

test("readConstantValue reads one element of an array constant", () => {
  const source = `export const TIER_PRICES = [1, 2, 4];\n`;
  assert.equal(readConstantValue(source, "TIER_PRICES", 0), 1);
  assert.equal(readConstantValue(source, "TIER_PRICES", 2), 4);
  assert.throws(() => readConstantValue(source, "TIER_PRICES", 5), /no index 5/);
});

test("buildConstantState throws for an id outside the catalogue", () => {
  assert.throws(() => buildConstantState("nope.NOPE"), /unknown constant id "nope.NOPE"/);
});

test("CONSTANT_FILES is exactly the set of files the catalogue reaches into", () => {
  assert.deepEqual([...CONSTANT_FILES].sort(), [...new Set(CONSTANTS.map((c) => c.file))].sort());
});

// --- Patch round-trip -------------------------------------------------------
//
// Reading and writing are two different regexes over the same declaration. A
// value written by the patcher and then read back is the only check that they
// agree about what a declaration looks like — including for the module-private
// ones (traffic.js's MAX_CARS) that no import could verify.

test("every constant survives a patch-then-read round trip", () => {
  const sources = new Map(CONSTANT_FILES.map((rel) => [rel, sourceOf(rel)]));
  for (const entry of CONSTANTS) {
    const before = sources.get(entry.file);
    const target = 12.5;
    const after =
      entry.index === undefined
        ? patchConstant(before, entry.name, target)
        : patchArrayConstantElement(before, entry.name, entry.index, target);
    assert.notEqual(after, before, `${entry.id}: patch changed nothing`);
    assert.equal(
      readConstantValue(after, entry.name, entry.index),
      target,
      `${entry.id}: did not read back what was written`
    );
  }
});

test("patching one constant leaves its neighbours in the same file alone", () => {
  const source = sourceOf("src/game/tuning.js");
  const patched = patchConstant(source, "ROAD_TURN_RATE", 0.9);
  assert.equal(readConstantValue(patched, "ROAD_TURN_RATE"), 0.9);
  assert.equal(
    readConstantValue(patched, "ROAD_AMPLITUDE"),
    readConstantValue(source, "ROAD_AMPLITUDE")
  );
  // Only one number moved: the length delta is exactly "0.6" -> "0.9".
  assert.equal(patched.length, source.length);
});

test("patching a tier price leaves the other tiers alone", () => {
  const source = sourceOf("src/game/upgrades.js");
  const patched = patchArrayConstantElement(source, "TIER_PRICES", 2, 6);
  assert.equal(readConstantValue(patched, "TIER_PRICES", 0), 1);
  assert.equal(readConstantValue(patched, "TIER_PRICES", 1), 2);
  assert.equal(readConstantValue(patched, "TIER_PRICES", 2), 6);
});

test("patchConstant refuses a name it cannot find rather than doing nothing", () => {
  assert.throws(
    () => patchConstant("const A = 1;\n", "B", 2),
    /no "const B = <number>" declaration found/
  );
});

test("every group's constants all name that group in their id", () => {
  // The id prefix is what keeps the colliding bare names apart; a row filed
  // under the wrong prefix would be a collision waiting to happen.
  for (const group of CONSTANT_GROUPS) {
    for (const entry of group.constants) {
      assert.ok(entry.id.startsWith(`${group.id}.`), `${entry.id} is not in group ${group.id}`);
      assert.equal(CONSTANT_BY_ID.get(entry.id).name, entry.name);
    }
  }
});
