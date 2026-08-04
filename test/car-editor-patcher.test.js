import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  findMatchingBrace,
  patchCarType,
  patchDrivingProfile,
  patchObstacleType,
} from "../tools/car-editor/patcher.js";

test("findMatchingBrace finds the matching closing brace", () => {
  const text = "before { inner } after";
  const openIndex = text.indexOf("{");
  const closeIndex = findMatchingBrace(text, openIndex);
  assert.equal(text[closeIndex], "}");
  assert.equal(text.slice(openIndex, closeIndex + 1), "{ inner }");
});

test("findMatchingBrace throws when index is not an opening brace", () => {
  assert.throws(() => findMatchingBrace("abc", 0), /is not '\{'/);
});

test("findMatchingBrace throws when there is no matching brace", () => {
  assert.throws(() => findMatchingBrace("{ never closes", 0), /no matching/);
});

test("findMatchingBrace handles nested braces", () => {
  const text = "before { outer { inner } still outer } after";
  const openIndex = text.indexOf("{");
  const closeIndex = findMatchingBrace(text, openIndex);
  assert.equal(text[closeIndex], "}");
  assert.equal(
    text.slice(openIndex, closeIndex + 1),
    "{ outer { inner } still outer }"
  );
});

const SAMPLE_CARTYPES = `export const CAR_TYPES = [
  {
    id: "sedan",
    health: 60,
    speedMin: 215,
    speedMax: 290,
  },
  {
    id: "interceptor",
    health: 70,
    mass: 1.1,
    speedMin: 400,
    speedMax: 470, // just under the rival
  },
];
`;

test("patchCarType replaces a single field without touching others", () => {
  const result = patchCarType(SAMPLE_CARTYPES, "interceptor", { health: 85 });
  assert.match(result, /id: "interceptor",\n {4}health: 85,/);
  assert.match(result, /id: "sedan",\n {4}health: 60,/); // untouched
  assert.match(result, /speedMax: 470, \/\/ just under the rival/); // comment kept
});

test("patchCarType replaces multiple fields on the same entry", () => {
  const result = patchCarType(SAMPLE_CARTYPES, "interceptor", {
    speedMin: 420,
    speedMax: 500,
  });
  assert.match(result, /speedMin: 420,/);
  assert.match(result, /speedMax: 500, \/\/ just under the rival/);
});

test("patchCarType throws for an unknown car id", () => {
  assert.throws(
    () => patchCarType(SAMPLE_CARTYPES, "ghost", { health: 1 }),
    /no entry with id "ghost"/
  );
});

test("patchCarType throws for a field not present on the entry", () => {
  // "sedan" has no `mass` field in SAMPLE_CARTYPES (only "interceptor" does),
  // so this is the entry that actually exercises the missing-field path.
  assert.throws(
    () => patchCarType(SAMPLE_CARTYPES, "sedan", { mass: 2 }),
    /field "mass" not found/
  );
});

// Fixture where `id` is NOT the first key: the field ahead of it is a string
// that happens to contain a literal `}`. lastIndexOf still finds this entry's
// own (correct) opening brace, but that stray `}` sitting between the brace
// and "id:" is exactly the guard's trip condition — a real nested value would
// leave the same signature, so this is a cheap stand-in for one.
const SAMPLE_CARTYPES_BAD_ORDER = `export const CAR_TYPES = [
  {
    id: "closed",
    health: 10,
  },
  {
    note: "the previous entry closes with }",
    id: "ghost",
    health: 20,
  },
];
`;

test("patchCarType throws when id is not the first key in the entry", () => {
  assert.throws(
    () => patchCarType(SAMPLE_CARTYPES_BAD_ORDER, "ghost", { health: 30 }),
    /"id" is not the first key/
  );
});

const SAMPLE_CARTYPES_SHARED_CONSTANT = `const ENEMY_MIN_DISTANCE = 100;

export const CAR_TYPES = [
  {
    id: "interceptor",
    health: 70,
    minDistance: ENEMY_MIN_DISTANCE,
  },
];
`;

test("patchCarType replaces a field whose current value is a shared constant identifier", () => {
  const result = patchCarType(SAMPLE_CARTYPES_SHARED_CONSTANT, "interceptor", {
    minDistance: 130,
  });
  assert.match(result, /id: "interceptor",\n {4}health: 70,\n {4}minDistance: 130,/);
});

test("patchCarType works against the real src/game/cartypes.js", () => {
  const realSource = readFileSync(
    new URL("../src/game/cartypes.js", import.meta.url),
    "utf8"
  );
  const result = patchCarType(realSource, "interceptor", { health: 999 });
  assert.match(result, /id: "interceptor",[\s\S]*?health: 999,/);
  // The rest of the file must be untouched — same length delta as exactly
  // one number changing from "70" to "999".
  assert.equal(result.length - realSource.length, "999".length - "70".length);
});

const SAMPLE_DRIVING = `export const DRIVING_PROFILES = {
  commuter: profile(),
  pursuer: profile({ nerve: 12 }),
  hustler: profile({
    laneDiscipline: 0.3,
    laneHome: "inner",
    contact: 6,
  }),
};
`;

test("patchDrivingProfile replaces an existing single-line field", () => {
  const result = patchDrivingProfile(SAMPLE_DRIVING, "pursuer", { nerve: 18 });
  assert.match(result, /pursuer: profile\(\{ nerve: 18 \}\)/);
});

test("patchDrivingProfile replaces an existing multi-line field", () => {
  const result = patchDrivingProfile(SAMPLE_DRIVING, "hustler", { contact: 4 });
  assert.match(result, /contact: 4,\n {2}\}\)/);
  assert.match(result, /laneDiscipline: 0.3,/); // untouched
});

test("patchDrivingProfile replaces a string-valued field", () => {
  const result = patchDrivingProfile(SAMPLE_DRIVING, "hustler", { laneHome: "outer" });
  assert.match(result, /laneHome: "outer",/);
});

test("patchDrivingProfile inserts a field the profile doesn't override yet", () => {
  const result = patchDrivingProfile(SAMPLE_DRIVING, "pursuer", { contact: 5 });
  assert.match(result, /pursuer: profile\(\{ nerve: 12,\n {4}contact: 5,\n {2}\}\)/);
});

test("patchDrivingProfile throws for an unknown profile name", () => {
  assert.throws(
    () => patchDrivingProfile(SAMPLE_DRIVING, "ghost", { nerve: 1 }),
    /no "ghost: profile\(\{" found/
  );
});

test("patchDrivingProfile works against the real src/game/driving.js", () => {
  const realSource = readFileSync(
    new URL("../src/game/driving.js", import.meta.url),
    "utf8"
  );
  const result = patchDrivingProfile(realSource, "pursuer", { nerve: 99 });
  assert.match(result, /pursuer: profile\(\{ nerve: 99 \}\)/);
  // The rest of the file must be untouched — same length delta as exactly
  // one number changing from "12" to "99".
  assert.equal(result.length - realSource.length, "99".length - "12".length);
});

const SAMPLE_CARTYPES_NEGATIVE = `export const CAR_TYPES = [
  {
    id: "wreck",
    health: -50,
    speedMin: 200,
    speedMax: 260,
  },
];
`;

test("patchCarType can find and replace a field whose current value is already negative", () => {
  const result = patchCarType(SAMPLE_CARTYPES_NEGATIVE, "wreck", { health: 40 });
  assert.match(result, /id: "wreck",\n {4}health: 40,/);
});

const SAMPLE_DRIVING_NEGATIVE = `export const DRIVING_PROFILES = {
  commuter: profile(),
  reckless: profile({ contact: -3 }),
};
`;

test("patchDrivingProfile can find and replace a field whose current value is already negative", () => {
  const result = patchDrivingProfile(SAMPLE_DRIVING_NEGATIVE, "reckless", { contact: 7 });
  assert.match(result, /reckless: profile\(\{ contact: 7 \}\)/);
});

test("patchDrivingProfile inserts a field into a real single-line profile with no trailing comma", () => {
  // `enforcer: profile({ nerve: 16 }),` is a genuine single-line profile in
  // driving.js whose last (only) field has no trailing comma inside the
  // braces, and it has no `contact` override yet. This is exactly the shape
  // that used to produce invalid JS before the trailing-comma fix (91d1039):
  // the insert used to land as `nerve: 16\n    contact: 5,` with no comma
  // separating the two fields.
  const realSource = readFileSync(
    new URL("../src/game/driving.js", import.meta.url),
    "utf8"
  );
  const result = patchDrivingProfile(realSource, "enforcer", { contact: 5 });
  assert.match(
    result,
    /enforcer: profile\(\{ nerve: 16,\n {4}contact: 5,\n {2}\}\)/
  );
});

const SAMPLE_OBSTACLETYPES = `export const OBSTACLE_TYPES = [
  {
    id: "trestle",
    health: 20,
    weight: 3,
    minDistance: 0,
  },
  {
    id: "caltrop",
    health: 1,
    weight: 0.8,
    minDistance: 0, // rare
  },
];
`;

test("patchObstacleType replaces weight and minDistance without touching other fields", () => {
  const result = patchObstacleType(SAMPLE_OBSTACLETYPES, "caltrop", { weight: 0.5, minDistance: 30 });
  assert.match(result, /id: "caltrop",\n {4}health: 1,\n {4}weight: 0.5,\n {4}minDistance: 30, \/\/ rare/);
  assert.match(result, /id: "trestle",\n {4}health: 20,\n {4}weight: 3,/); // untouched
});

test("patchObstacleType throws for an unknown obstacle id", () => {
  assert.throws(
    () => patchObstacleType(SAMPLE_OBSTACLETYPES, "ghost", { weight: 1 }),
    /no entry with id "ghost"/
  );
});

test("patchObstacleType throws for a field not present on the entry", () => {
  assert.throws(
    () => patchObstacleType(SAMPLE_OBSTACLETYPES, "trestle", { blastDamage: 10 }),
    /field "blastDamage" not found/
  );
});

test("patchObstacleType works against the real src/game/obstacletypes.js", () => {
  const realSource = readFileSync(
    new URL("../src/game/obstacletypes.js", import.meta.url),
    "utf8"
  );
  const result = patchObstacleType(realSource, "trestle", { minDistance: 40 });
  assert.match(result, /id: "trestle",[\s\S]*?minDistance: 40,/);
  // The rest of the file must be untouched — same length delta as exactly
  // one number changing from "0" to "40".
  assert.equal(result.length - realSource.length, "40".length - "0".length);
});
