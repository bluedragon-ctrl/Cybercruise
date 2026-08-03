// test/car-editor-git.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  timestampBranchName,
  normalizeRemoteToHttps,
  compareUrl,
} from "../tools/car-editor/git.js";

test("timestampBranchName formats a fixed date", () => {
  const date = new Date(2026, 7, 3, 9, 5, 7); // month is 0-indexed: August
  assert.equal(timestampBranchName(date), "car-editor-20260803-090507");
});

test("normalizeRemoteToHttps passes an https remote through, minus .git", () => {
  assert.equal(
    normalizeRemoteToHttps("https://github.com/bluedragon-ctrl/Cybercruise.git"),
    "https://github.com/bluedragon-ctrl/Cybercruise"
  );
});

test("normalizeRemoteToHttps converts an ssh remote to https", () => {
  assert.equal(
    normalizeRemoteToHttps("git@github.com:bluedragon-ctrl/Cybercruise.git"),
    "https://github.com/bluedragon-ctrl/Cybercruise"
  );
});

test("compareUrl builds a GitHub compare link", () => {
  assert.equal(
    compareUrl(
      "https://github.com/bluedragon-ctrl/Cybercruise",
      "main",
      "car-editor-20260803-090507"
    ),
    "https://github.com/bluedragon-ctrl/Cybercruise/compare/main...car-editor-20260803-090507?expand=1"
  );
});
