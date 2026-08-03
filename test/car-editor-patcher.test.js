import { test } from "node:test";
import assert from "node:assert/strict";
import { findMatchingBrace, patchCarType } from "../tools/car-editor/patcher.js";

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
