import { test } from "node:test";
import assert from "node:assert/strict";
import { findMatchingBrace } from "../tools/car-editor/patcher.js";

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
