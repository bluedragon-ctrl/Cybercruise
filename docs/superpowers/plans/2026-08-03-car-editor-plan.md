# Enemy Car Editor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `tools/car-editor/`, a local browser-based tool for tuning the 5 enemy car types' hull, speed, and driving-behavior knobs, that opens a pull request with the change on confirmation.

**Architecture:** A dependency-free Node HTTP server (`server.js`) imports the real `cartypes.js`/`driving.js` modules to read live values, serves a vanilla-JS/HTML/CSS editor UI, and on confirmation patches the two source files via targeted text surgery (`patcher.js`), runs the change on a fresh git branch, gates the push on `node --test test/` passing, and hands the user a GitHub compare URL to finish the PR — no `gh` CLI, no GitHub API token.

**Tech Stack:** Vanilla JS (ES modules), Node's built-in `http`/`fs`/`child_process`, `node:test` for unit tests. No new npm dependencies.

**Reference:** Design spec at `docs/superpowers/specs/2026-08-03-car-editor-design.md`.

---

### Task 1: `patcher.js` — brace matching

**Files:**
- Create: `tools/car-editor/patcher.js`
- Test: `test/car-editor-patcher.test.js`

- [ ] **Step 1: Write the failing tests**

```js
// test/car-editor-patcher.test.js
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/car-editor-patcher.test.js`
Expected: FAIL — cannot find module `../tools/car-editor/patcher.js`

- [ ] **Step 3: Create `patcher.js` with `findMatchingBrace`**

```js
// tools/car-editor/patcher.js
//
// Pure text-surgery helpers for the car editor. Given the raw source text of
// cartypes.js or driving.js, replace (or, for driving profiles, insert) the
// specific field values a tuning session changed, leaving every comment,
// every untouched field, and all surrounding formatting exactly as it was.
// There is no AST here — these files are simple, flat object literals, and
// brace-depth matching plus a per-field regex is enough to touch exactly one
// token per change.

export function findMatchingBrace(text, openBraceIndex) {
  if (text[openBraceIndex] !== "{") {
    throw new Error(
      `findMatchingBrace: character at index ${openBraceIndex} is not '{'`
    );
  }
  let depth = 0;
  for (let i = openBraceIndex; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  throw new Error(
    `findMatchingBrace: no matching '}' for '{' at index ${openBraceIndex}`
  );
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/car-editor-patcher.test.js`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add tools/car-editor/patcher.js test/car-editor-patcher.test.js
git commit -m "Add brace matcher for the car editor's text patcher"
```

---

### Task 2: `patcher.js` — `patchCarType`

**Files:**
- Modify: `tools/car-editor/patcher.js`
- Test: `test/car-editor-patcher.test.js`

- [ ] **Step 1: Add the failing tests**

Append to `test/car-editor-patcher.test.js`:

```js
import { patchCarType } from "../tools/car-editor/patcher.js";

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
  assert.throws(
    () => patchCarType(SAMPLE_CARTYPES, "interceptor", { mass: 2 }),
    /field "mass" not found/
  );
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/car-editor-patcher.test.js`
Expected: FAIL — `patchCarType` is not exported

- [ ] **Step 3: Add `patchCarType` to `patcher.js`**

Append to `tools/car-editor/patcher.js`:

```js
function replaceNumericField(block, field, value) {
  const re = new RegExp(`(\\b${field}:\\s*)[0-9.]+`);
  if (!re.test(block)) return null;
  return block.replace(re, `$1${value}`);
}

// Patches health/speedMin/speedMax on the CAR_TYPES entry whose `id` matches
// carId. Every field named in `changes` must already exist in the entry —
// cartypes.js always sets health/speedMin/speedMax on every type, so a
// missing field means the source has drifted from what the editor read, and
// this throws rather than silently doing nothing.
export function patchCarType(sourceText, carId, changes) {
  const idMarker = `id: "${carId}"`;
  const idIndex = sourceText.indexOf(idMarker);
  if (idIndex === -1) {
    throw new Error(`patchCarType: no entry with id "${carId}" found`);
  }

  const objStart = sourceText.lastIndexOf("{", idIndex);
  if (objStart === -1) {
    throw new Error(`patchCarType: no opening '{' found before id "${carId}"`);
  }
  const objEnd = findMatchingBrace(sourceText, objStart);

  let block = sourceText.slice(objStart, objEnd + 1);
  for (const [field, value] of Object.entries(changes)) {
    const patched = replaceNumericField(block, field, value);
    if (patched === null) {
      throw new Error(
        `patchCarType: field "${field}" not found on entry "${carId}"`
      );
    }
    block = patched;
  }

  return sourceText.slice(0, objStart) + block + sourceText.slice(objEnd + 1);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/car-editor-patcher.test.js`
Expected: PASS (7 tests)

- [ ] **Step 5: Commit**

```bash
git add tools/car-editor/patcher.js test/car-editor-patcher.test.js
git commit -m "Add patchCarType for hull/speed edits"
```

---

### Task 3: `patcher.js` — `patchDrivingProfile` (replace)

**Files:**
- Modify: `tools/car-editor/patcher.js`
- Test: `test/car-editor-patcher.test.js`

- [ ] **Step 1: Add the failing tests**

Append to `test/car-editor-patcher.test.js`:

```js
import { patchDrivingProfile } from "../tools/car-editor/patcher.js";

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

test("patchDrivingProfile throws for an unknown profile name", () => {
  assert.throws(
    () => patchDrivingProfile(SAMPLE_DRIVING, "ghost", { nerve: 1 }),
    /no "ghost: profile\(\{" found/
  );
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/car-editor-patcher.test.js`
Expected: FAIL — `patchDrivingProfile` is not exported

- [ ] **Step 3: Add `patchDrivingProfile` (replace path only) to `patcher.js`**

Append to `tools/car-editor/patcher.js`:

```js
function replaceStringField(block, field, value) {
  const re = new RegExp(`(\\b${field}:\\s*)"[^"]*"`);
  if (!re.test(block)) return null;
  return block.replace(re, `$1"${value}"`);
}

const STRING_FIELDS = new Set(["laneHome"]);
const INSERT_INDENT = "    ";

// Patches (or adds — see Task 4) fields on the driving profile named
// `profileName` — the argument object of `<profileName>: profile({ ... })`
// in driving.js.
export function patchDrivingProfile(sourceText, profileName, changes) {
  const marker = `${profileName}: profile({`;
  const markerIndex = sourceText.indexOf(marker);
  if (markerIndex === -1) {
    throw new Error(`patchDrivingProfile: no "${profileName}: profile({" found`);
  }

  const objStart = markerIndex + marker.length - 1; // index of the '{'
  const objEnd = findMatchingBrace(sourceText, objStart);

  let inner = sourceText.slice(objStart + 1, objEnd);
  for (const [field, value] of Object.entries(changes)) {
    const isString = STRING_FIELDS.has(field);
    const patched = isString
      ? replaceStringField(inner, field, value)
      : replaceNumericField(inner, field, value);

    if (patched === null) {
      throw new Error(
        `patchDrivingProfile: field "${field}" not found on profile "${profileName}" (insertion lands in Task 4)`
      );
    }
    inner = patched;
  }

  return sourceText.slice(0, objStart + 1) + inner + sourceText.slice(objEnd);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/car-editor-patcher.test.js`
Expected: PASS (11 tests)

- [ ] **Step 5: Commit**

```bash
git add tools/car-editor/patcher.js test/car-editor-patcher.test.js
git commit -m "Add patchDrivingProfile for existing behavior fields"
```

---

### Task 4: `patcher.js` — `patchDrivingProfile` (insert missing field)

**Files:**
- Modify: `tools/car-editor/patcher.js`
- Test: `test/car-editor-patcher.test.js`

- [ ] **Step 1: Add the failing test**

Append to `test/car-editor-patcher.test.js`:

```js
test("patchDrivingProfile inserts a field the profile doesn't override yet", () => {
  const result = patchDrivingProfile(SAMPLE_DRIVING, "pursuer", { contact: 5 });
  assert.match(result, /pursuer: profile\(\{ nerve: 12\n {4}contact: 5,\n {2}\}\)/);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/car-editor-patcher.test.js`
Expected: FAIL — throws "field \"contact\" not found on profile \"pursuer\""

- [ ] **Step 3: Replace the throw with an insertion in `patchDrivingProfile`**

In `tools/car-editor/patcher.js`, replace the loop body inside `patchDrivingProfile`:

```js
  let inner = sourceText.slice(objStart + 1, objEnd);
  for (const [field, value] of Object.entries(changes)) {
    const isString = STRING_FIELDS.has(field);
    const patched = isString
      ? replaceStringField(inner, field, value)
      : replaceNumericField(inner, field, value);

    if (patched !== null) {
      inner = patched;
    } else {
      // Not overridden yet — append a new line just before the closing
      // brace instead of touching whatever line happens to be last, so the
      // diff reads as a pure addition.
      const literal = isString ? `"${value}"` : `${value}`;
      inner = inner.replace(/\s+$/, "") + `\n${INSERT_INDENT}${field}: ${literal},\n  `;
    }
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/car-editor-patcher.test.js`
Expected: PASS (12 tests)

- [ ] **Step 5: Commit**

```bash
git add tools/car-editor/patcher.js test/car-editor-patcher.test.js
git commit -m "Insert new behavior overrides instead of failing"
```

---

### Task 5: `git.js` — pure helpers

**Files:**
- Create: `tools/car-editor/git.js`
- Test: `test/car-editor-git.test.js`

- [ ] **Step 1: Write the failing tests**

```js
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/car-editor-git.test.js`
Expected: FAIL — cannot find module `../tools/car-editor/git.js`

- [ ] **Step 3: Create `git.js` with the pure helpers**

```js
// tools/car-editor/git.js
//
// Thin wrappers around the exact git commands the car editor's PR flow uses
// (added in Task 7), plus the pure helpers below — branch naming and URL
// building — which are cheap to unit test without touching git at all.

export function timestampBranchName(date = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  const stamp =
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
  return `car-editor-${stamp}`;
}

export function normalizeRemoteToHttps(remote) {
  const sshMatch = remote.match(/^git@([^:]+):(.+?)(\.git)?$/);
  if (sshMatch) {
    return `https://${sshMatch[1]}/${sshMatch[2]}`;
  }
  return remote.replace(/\.git$/, "");
}

export function compareUrl(httpsRemote, base, branch) {
  return `${httpsRemote}/compare/${encodeURIComponent(base)}...${encodeURIComponent(branch)}?expand=1`;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/car-editor-git.test.js`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add tools/car-editor/git.js test/car-editor-git.test.js
git commit -m "Add branch-naming and compare-URL helpers"
```

---

### Task 6: `state.js` — reading the live enemy roster

**Files:**
- Create: `tools/car-editor/state.js`
- Test: `test/car-editor-state.test.js`

- [ ] **Step 1: Write the failing tests**

```js
// test/car-editor-state.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildCarState,
  buildAllCarState,
  ENEMY_IDS,
  BEHAVIOR_FIELDS,
  HULL_SPEED_FIELDS,
} from "../tools/car-editor/state.js";

test("buildAllCarState returns exactly the 5 enemy types", () => {
  const all = buildAllCarState();
  assert.deepEqual(
    all.map((c) => c.id).sort(),
    [...ENEMY_IDS].sort()
  );
});

test("buildCarState returns hull, speed and every behavior field", () => {
  const state = buildCarState("interceptor");
  assert.equal(typeof state.hull.health, "number");
  assert.equal(typeof state.speed.speedMin, "number");
  assert.equal(typeof state.speed.speedMax, "number");
  for (const field of BEHAVIOR_FIELDS) {
    assert.ok(field in state.behavior, `missing behavior field ${field}`);
    assert.equal(typeof state.behavior[field].inherited, "boolean");
  }
});

test("laneHome is always one of the three known lane preferences", () => {
  for (const id of ENEMY_IDS) {
    const state = buildCarState(id);
    assert.ok(["any", "inner", "outer"].includes(state.behavior.laneHome.value));
  }
});

test("nerve is not flagged as inherited for any enemy type", () => {
  // Every enemy profile explicitly sets its own nerve figure (see driving.js's
  // "Hostile dispositions" section) — this is the field where the roster is
  // least likely to accidentally read as bland defaults.
  for (const id of ENEMY_IDS) {
    const state = buildCarState(id);
    assert.equal(state.behavior.nerve.inherited, false, `${id}.nerve should be overridden`);
  }
});

test("buildCarState throws for a car id outside the enemy roster", () => {
  assert.throws(() => buildCarState("sedan"), /unknown car id "sedan"/);
});

test("HULL_SPEED_FIELDS and BEHAVIOR_FIELDS don't overlap", () => {
  const overlap = HULL_SPEED_FIELDS.filter((f) => BEHAVIOR_FIELDS.includes(f));
  assert.deepEqual(overlap, []);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/car-editor-state.test.js`
Expected: FAIL — cannot find module `../tools/car-editor/state.js`

- [ ] **Step 3: Create `state.js`**

```js
// tools/car-editor/state.js
//
// Reads the enemy roster's CURRENT values by importing the real game
// modules — same trick tools/drivesim.js already uses — so the editor never
// shows a stale snapshot. A field is reported "inherited" when its value
// equals the commuter default, which is a value-based approximation of "not
// explicitly overridden in the source": correct in every case the source
// actually looks like today, and if a profile were ever written to spell
// out a value equal to the default anyway, the worst outcome is a cosmetic
// "(overridden)" tag missing in the UI — not a wrong edit.

import { carTypeById } from "../../src/game/cartypes.js";
import { DRIVING_PROFILES, drivingFor } from "../../src/game/driving.js";

export const ENEMY_IDS = ["interceptor", "stocker", "cycle", "bruiser", "rival"];

export const HULL_SPEED_FIELDS = ["health", "speedMin", "speedMax"];

export const BEHAVIOR_FIELDS = [
  "followGap",
  "followReaction",
  "laneDiscipline",
  "laneHome",
  "patience",
  "passTrigger",
  "passMargin",
  "passTimeout",
  "passSpeedMargin",
  "passClearance",
  "passLookBehind",
  "passLookAhead",
  "passEffort",
  "hazardClearance",
  "nerve",
  "contact",
];

export function buildCarState(carId) {
  if (!ENEMY_IDS.includes(carId)) {
    throw new Error(`buildCarState: unknown car id "${carId}"`);
  }
  const type = carTypeById(carId);
  const profile = drivingFor(type);
  const commuter = DRIVING_PROFILES.commuter;

  const behavior = {};
  for (const field of BEHAVIOR_FIELDS) {
    behavior[field] = {
      value: profile[field],
      inherited: profile[field] === commuter[field],
    };
  }

  return {
    id: type.id,
    label: type.label,
    hull: { health: type.health },
    speed: { speedMin: type.speedMin, speedMax: type.speedMax },
    behavior,
  };
}

export function buildAllCarState() {
  return ENEMY_IDS.map(buildCarState);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/car-editor-state.test.js`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add tools/car-editor/state.js test/car-editor-state.test.js
git commit -m "Add state.js to read the live enemy roster"
```

---

### Task 7: `git.js` — command wrappers

**Files:**
- Modify: `tools/car-editor/git.js`

No new automated tests in this task — these functions are thin `execFile` wrappers around specific git subcommands, and exercising them for real means mutating an actual git repository's branches, which is exactly the risky, hard-to-sandbox behavior the design doc calls out as manually verified instead (end-to-end check is Task 18). The pure helpers already covered in Task 5 are the part of this file worth unit testing.

- [ ] **Step 1: Add the command wrappers to `git.js`**

Append to `tools/car-editor/git.js`:

```js
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function run(args, cwd) {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout.trim();
}

export async function currentBranch(cwd) {
  return run(["rev-parse", "--abbrev-ref", "HEAD"], cwd);
}

export async function dirtyTrackedFiles(cwd, files) {
  const out = await run(["status", "--porcelain", "--", ...files], cwd);
  return out.length > 0 ? out.split("\n") : [];
}

export async function createBranch(cwd, branchName) {
  await run(["checkout", "-b", branchName], cwd);
}

export async function commitFiles(cwd, files, message) {
  await run(["add", ...files], cwd);
  await run(["commit", "-m", message], cwd);
}

export async function pushBranch(cwd, branchName) {
  await run(["push", "-u", "origin", branchName], cwd);
}

export async function checkoutBranch(cwd, branchName) {
  await run(["checkout", branchName], cwd);
}

export async function deleteBranch(cwd, branchName) {
  await run(["branch", "-D", branchName], cwd);
}

export async function remoteUrl(cwd) {
  return run(["remote", "get-url", "origin"], cwd);
}
```

Note: the `import`/`promisify` lines belong at the top of the file — move them above the existing `timestampBranchName` export when editing, so the file has one import block rather than two.

- [ ] **Step 2: Confirm the existing tests still pass**

Run: `node --test test/car-editor-git.test.js`
Expected: PASS (4 tests, unchanged — the new exports aren't tested here)

- [ ] **Step 3: Commit**

```bash
git add tools/car-editor/git.js
git commit -m "Add git command wrappers for the PR flow"
```

---

### Task 8: `server.js` — static files and `GET /api/state`

**Files:**
- Create: `tools/car-editor/server.js`

- [ ] **Step 1: Create `server.js` with static serving and `/api/state`**

```js
// tools/car-editor/server.js
//
// Local HTTP server for the enemy car editor: serves the editor UI and its
// API. Started via edit.bat, or directly with `node tools/car-editor/server.js`.
// Requires git on PATH — see the startup check at the bottom of this file.

import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";

import { buildAllCarState } from "./state.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../..");

const PORT = Number(process.env.PORT ?? 5174);

const STATIC_FILES = {
  "/": { file: "editor.html", type: "text/html" },
  "/editor.html": { file: "editor.html", type: "text/html" },
  "/editor.css": { file: "editor.css", type: "text/css" },
  "/editor.js": { file: "editor.js", type: "text/javascript" },
};

function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(text),
  });
  res.end(text);
}

async function handleState(res) {
  sendJson(res, 200, { cars: buildAllCarState() });
}

async function serveStatic(req, res) {
  const entry = STATIC_FILES[req.url];
  if (!entry) {
    res.writeHead(404);
    res.end("Not found");
    return;
  }
  const filePath = path.join(__dirname, entry.file);
  const body = await readFile(filePath, "utf8");
  res.writeHead(200, { "Content-Type": entry.type });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === "GET" && req.url === "/api/state") return await handleState(res);
    if (req.method === "GET") return await serveStatic(req, res);
    res.writeHead(405);
    res.end("Method not allowed");
  } catch (err) {
    sendJson(res, 500, { error: err.message });
  }
});

execFile("git", ["--version"], (error) => {
  if (error) {
    console.error("git was not found on PATH. Install Git before running the car editor.");
    process.exit(1);
  }
  server.listen(PORT, () => {
    console.log(`Car editor running at http://localhost:${PORT}`);
  });
});
```

- [ ] **Step 2: Verify it starts and serves state**

Run: `node tools/car-editor/server.js &`
Then: `curl -s http://localhost:5174/api/state | head -c 300`
Expected: JSON beginning with `{"cars":[{"id":"interceptor"`
Then stop the background server: `kill %1`

(`editor.html`/`.css`/`.js` don't exist yet — hitting `http://localhost:5174/` will 500 until Task 11. That's expected at this point.)

- [ ] **Step 3: Commit**

```bash
git add tools/car-editor/server.js
git commit -m "Add car editor server: static files and GET /api/state"
```

---

### Task 9: `server.js` — `POST /api/commit`

**Files:**
- Modify: `tools/car-editor/server.js`

- [ ] **Step 1: Add the commit endpoint**

In `tools/car-editor/server.js`, update the imports at the top:

```js
import http from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";

import { buildAllCarState, ENEMY_IDS, BEHAVIOR_FIELDS, HULL_SPEED_FIELDS } from "./state.js";
import { patchCarType, patchDrivingProfile } from "./patcher.js";
import * as git from "./git.js";
import { carTypeById } from "../../src/game/cartypes.js";
```

Add these constants after `const REPO_ROOT = ...`:

```js
const CARTYPES_REL = "src/game/cartypes.js";
const DRIVING_REL = "src/game/driving.js";
const CARTYPES_PATH = path.join(REPO_ROOT, CARTYPES_REL);
const DRIVING_PATH = path.join(REPO_ROOT, DRIVING_REL);

// The single tuning attempt in flight, if any. This is a local, one-user
// tool — there is never more than one browser tab driving it in practice —
// so module-level state is enough; no session/locking machinery needed.
let pending = null; // { branchName, originalBranch }
```

Add these functions after `sendJson`:

```js
async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}

function validateChanges(changes) {
  if (!changes || typeof changes !== "object" || Array.isArray(changes)) {
    throw new Error("body.changes must be an object");
  }
  if (Object.keys(changes).length === 0) {
    throw new Error("body.changes must not be empty");
  }
  for (const [carId, fields] of Object.entries(changes)) {
    if (!ENEMY_IDS.includes(carId)) {
      throw new Error(`unknown enemy car id "${carId}"`);
    }
    if (!fields || typeof fields !== "object" || Object.keys(fields).length === 0) {
      throw new Error(`changes for "${carId}" must be a non-empty object`);
    }
    for (const field of Object.keys(fields)) {
      if (!HULL_SPEED_FIELDS.includes(field) && !BEHAVIOR_FIELDS.includes(field)) {
        throw new Error(`unknown field "${field}" for "${carId}"`);
      }
    }
  }
}

function commitMessage(changes) {
  const lines = ["Tune enemy car parameters via the car editor", ""];
  for (const [carId, fields] of Object.entries(changes)) {
    for (const [field, value] of Object.entries(fields)) {
      lines.push(`- ${carId}: ${field} -> ${value}`);
    }
  }
  return lines.join("\n");
}

function runTests() {
  return new Promise((resolve) => {
    execFile("node", ["--test", "test/"], { cwd: REPO_ROOT }, (error, stdout, stderr) => {
      resolve({ passed: !error, output: `${stdout}\n${stderr}` });
    });
  });
}

async function handleCommit(req, res) {
  let body;
  try {
    body = await readBody(req);
    validateChanges(body.changes);
  } catch (err) {
    sendJson(res, 400, { error: err.message });
    return;
  }

  if (pending) {
    sendJson(res, 409, { error: "a tuning attempt is already in flight — push or cancel it first" });
    return;
  }

  let cartypesText = await readFile(CARTYPES_PATH, "utf8");
  let drivingText = await readFile(DRIVING_PATH, "utf8");
  let cartypesChanged = false;
  let drivingChanged = false;

  try {
    for (const [carId, fields] of Object.entries(body.changes)) {
      const type = carTypeById(carId);
      const hullSpeedChanges = {};
      const behaviorChanges = {};
      for (const [field, value] of Object.entries(fields)) {
        if (HULL_SPEED_FIELDS.includes(field)) hullSpeedChanges[field] = value;
        else behaviorChanges[field] = value;
      }
      if (Object.keys(hullSpeedChanges).length > 0) {
        cartypesText = patchCarType(cartypesText, carId, hullSpeedChanges);
        cartypesChanged = true;
      }
      if (Object.keys(behaviorChanges).length > 0) {
        drivingText = patchDrivingProfile(drivingText, type.driving, behaviorChanges);
        drivingChanged = true;
      }
    }
  } catch (err) {
    sendJson(res, 400, { error: err.message });
    return;
  }

  const dirty = await git.dirtyTrackedFiles(REPO_ROOT, [CARTYPES_REL, DRIVING_REL]);
  if (dirty.length > 0) {
    sendJson(res, 409, { error: `uncommitted changes already present: ${dirty.join(", ")}` });
    return;
  }

  const originalBranch = await git.currentBranch(REPO_ROOT);
  const branchName = git.timestampBranchName();

  try {
    await git.createBranch(REPO_ROOT, branchName);

    const changedRelPaths = [];
    if (cartypesChanged) {
      await writeFile(CARTYPES_PATH, cartypesText, "utf8");
      changedRelPaths.push(CARTYPES_REL);
    }
    if (drivingChanged) {
      await writeFile(DRIVING_PATH, drivingText, "utf8");
      changedRelPaths.push(DRIVING_REL);
    }

    await git.commitFiles(REPO_ROOT, changedRelPaths, commitMessage(body.changes));
  } catch (err) {
    try {
      await git.checkoutBranch(REPO_ROOT, originalBranch);
      await git.deleteBranch(REPO_ROOT, branchName);
    } catch {
      // Best-effort cleanup; if even this fails, the branch is left for the
      // user to sort out manually rather than masking the original error.
    }
    sendJson(res, 500, { error: err.message });
    return;
  }

  const { passed, output } = await runTests();
  pending = { branchName, originalBranch };
  sendJson(res, 200, { branch: branchName, testsPassed: passed, testOutput: output });
}
```

Add the route in the `http.createServer` handler, before the `/api/state` check's `return` line falls through to `serveStatic`:

```js
    if (req.method === "GET" && req.url === "/api/state") return await handleState(res);
    if (req.method === "POST" && req.url === "/api/commit") return await handleCommit(req, res);
    if (req.method === "GET") return await serveStatic(req, res);
```

- [ ] **Step 2: Verify with a real request against a scratch branch**

Run: `node tools/car-editor/server.js &`
Then, from the repo root:

```bash
curl -s -X POST http://localhost:5174/api/commit \
  -H "Content-Type: application/json" \
  -d '{"changes":{"cycle":{"nerve":5}}}'
```

Expected: JSON with `"testsPassed":true` and a `"branch":"car-editor-<timestamp>"`. Then:

```bash
git log --oneline -1
git diff HEAD~1 -- src/game/driving.js
```

Expected: one new commit, and the diff shows only `cycle`'s `darter` profile gaining/changing a `nerve` line.

Clean up this manual verification so it doesn't linger as a stray branch:

```bash
git checkout <the branch you were on before, e.g. claude/game-car-editor-tool-3eb770>
git branch -D car-editor-<timestamp>
kill %1
```

- [ ] **Step 3: Commit**

```bash
git add tools/car-editor/server.js
git commit -m "Add POST /api/commit: patch, branch, and test-gate"
```

---

### Task 10: `server.js` — `POST /api/push`, `POST /api/cancel`, startup

**Files:**
- Modify: `tools/car-editor/server.js`

- [ ] **Step 1: Add the push and cancel handlers**

Add after `handleCommit` in `tools/car-editor/server.js`:

```js
async function handlePush(res) {
  if (!pending) {
    sendJson(res, 400, { error: "no tuning attempt is in flight" });
    return;
  }
  const { branchName, originalBranch } = pending;
  try {
    await git.pushBranch(REPO_ROOT, branchName);
  } catch (err) {
    sendJson(res, 500, { error: err.message });
    return; // pending stays set: branch and commit are untouched for a retry
  }

  const remote = await git.remoteUrl(REPO_ROOT);
  const url = git.compareUrl(git.normalizeRemoteToHttps(remote), originalBranch, branchName);
  await git.checkoutBranch(REPO_ROOT, originalBranch);
  pending = null;
  sendJson(res, 200, { url });
}

async function handleCancel(res) {
  if (!pending) {
    sendJson(res, 400, { error: "no tuning attempt is in flight" });
    return;
  }
  const { branchName, originalBranch } = pending;
  await git.checkoutBranch(REPO_ROOT, originalBranch);
  await git.deleteBranch(REPO_ROOT, branchName);
  pending = null;
  sendJson(res, 200, { ok: true });
}
```

Add the two routes in `http.createServer`:

```js
    if (req.method === "POST" && req.url === "/api/commit") return await handleCommit(req, res);
    if (req.method === "POST" && req.url === "/api/push") return await handlePush(res);
    if (req.method === "POST" && req.url === "/api/cancel") return await handleCancel(res);
    if (req.method === "GET") return await serveStatic(req, res);
```

- [ ] **Step 2: Verify the cancel path with a real request**

Run: `node tools/car-editor/server.js &`

```bash
curl -s -X POST http://localhost:5174/api/commit -H "Content-Type: application/json" \
  -d '{"changes":{"cycle":{"nerve":5}}}'
curl -s -X POST http://localhost:5174/api/cancel
git branch --list "car-editor-*"
git status --porcelain -- src/game/driving.js
kill %1
```

Expected: the cancel response is `{"ok":true}`, `git branch --list` shows no `car-editor-*` branch afterward, and `git status` on `driving.js` is empty — the working tree is exactly as it was before the commit request.

(`/api/push` is not exercised here — pushing to `origin` is a real, visible action and Task 18 covers verifying it deliberately, with your go-ahead, rather than as an automatic step of building the tool.)

- [ ] **Step 3: Commit**

```bash
git add tools/car-editor/server.js
git commit -m "Add POST /api/push and POST /api/cancel"
```

---

### Task 11: `editor.html`

**Files:**
- Create: `tools/car-editor/editor.html`

- [ ] **Step 1: Create the page**

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Cybercruise — Enemy Car Editor</title>
  <link rel="stylesheet" href="/editor.css" />
</head>
<body>
  <header>
    <h1>Enemy Car Editor</h1>
    <p class="subtitle">Tune hull, speed and driving behavior for the enemy roster, then open a pull request.</p>
  </header>

  <main>
    <nav id="car-list" aria-label="Enemy cars"></nav>

    <div>
      <section id="car-form" hidden>
        <h2 id="car-form-title"></h2>

        <fieldset>
          <legend>Hull</legend>
          <div id="hull-fields"></div>
        </fieldset>

        <fieldset>
          <legend>Speed</legend>
          <div id="speed-fields"></div>
        </fieldset>

        <fieldset>
          <legend>Behavior</legend>
          <div id="behavior-fields"></div>
        </fieldset>
      </section>

      <button id="review-button">Review changes</button>

      <section id="review" hidden>
        <h2>Review changes</h2>
        <table id="review-table">
          <thead>
            <tr><th>Car</th><th>Field</th><th>Before</th><th>After</th><th>Note</th></tr>
          </thead>
          <tbody></tbody>
        </table>
        <button id="create-pr">Create Pull Request</button>
      </section>

      <section id="status" hidden></section>
    </div>
  </main>

  <script type="module" src="/editor.js"></script>
</body>
</html>
```

- [ ] **Step 2: Verify it's served**

Run: `node tools/car-editor/server.js &`
Then: `curl -s http://localhost:5174/ | head -5`
Expected: `<!doctype html>` and the `<title>` line. Then `kill %1`.

- [ ] **Step 3: Commit**

```bash
git add tools/car-editor/editor.html
git commit -m "Add the car editor's HTML shell"
```

---

### Task 12: `editor.css`

**Files:**
- Create: `tools/car-editor/editor.css`

- [ ] **Step 1: Create the stylesheet**

```css
:root {
  --bg: #0b0d14;
  --panel: #131726;
  --text: #d8e2ff;
  --muted: #7c88b8;
  --accent: #35e6c2;
  --accent-dim: #1c8f79;
  --danger: #ff5470;
  --border: #232a44;
}

* { box-sizing: border-box; }

body {
  margin: 0;
  font-family: system-ui, sans-serif;
  background: var(--bg);
  color: var(--text);
}

header {
  padding: 1.5rem 2rem 0.5rem;
}

h1 {
  margin: 0;
  color: var(--accent);
  text-shadow: 0 0 8px var(--accent-dim);
}

.subtitle {
  color: var(--muted);
  margin: 0.25rem 0 0;
}

main {
  display: grid;
  grid-template-columns: 200px 1fr;
  gap: 1.5rem;
  padding: 1.5rem 2rem;
}

#car-list {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

#car-list button {
  background: var(--panel);
  border: 1px solid var(--border);
  color: var(--text);
  padding: 0.6rem 0.8rem;
  text-align: left;
  cursor: pointer;
  border-radius: 4px;
}

#car-list button.selected {
  border-color: var(--accent);
  color: var(--accent);
}

fieldset {
  border: 1px solid var(--border);
  border-radius: 6px;
  margin-bottom: 1rem;
  padding: 1rem;
}

legend {
  color: var(--accent);
  padding: 0 0.4rem;
}

.field {
  margin-bottom: 0.9rem;
}

.field label {
  display: block;
  font-weight: 600;
}

.field input,
.field select {
  background: var(--panel);
  border: 1px solid var(--border);
  color: var(--text);
  padding: 0.35rem 0.5rem;
  border-radius: 4px;
  width: 140px;
}

.field .description {
  color: var(--muted);
  font-size: 0.85rem;
  margin-top: 0.2rem;
  max-width: 46rem;
}

.field .override-tag {
  color: var(--accent);
  font-size: 0.75rem;
  margin-left: 0.5rem;
  font-weight: normal;
}

table {
  border-collapse: collapse;
  width: 100%;
  margin-bottom: 1rem;
}

th, td {
  border: 1px solid var(--border);
  padding: 0.4rem 0.6rem;
  text-align: left;
}

button {
  font: inherit;
  background: var(--panel);
  border: 1px solid var(--border);
  color: var(--text);
  padding: 0.5rem 1rem;
  border-radius: 4px;
  cursor: pointer;
}

button:disabled {
  opacity: 0.5;
  cursor: default;
}

#status.error {
  color: var(--danger);
}

#status.success {
  color: var(--accent);
}

pre {
  white-space: pre-wrap;
  background: var(--panel);
  border: 1px solid var(--border);
  padding: 0.75rem;
  border-radius: 6px;
  max-height: 20rem;
  overflow: auto;
}
```

- [ ] **Step 2: Verify it's served**

Run: `node tools/car-editor/server.js &`
Then: `curl -s -o /dev/null -w "%{http_code}" http://localhost:5174/editor.css`
Expected: `200`. Then `kill %1`.

- [ ] **Step 3: Commit**

```bash
git add tools/car-editor/editor.css
git commit -m "Add the car editor's stylesheet"
```

---

### Task 13: `editor.js` — load state and render forms

**Files:**
- Create: `tools/car-editor/editor.js`

- [ ] **Step 1: Create `editor.js` with state loading, the car list, and per-field forms**

```js
// tools/car-editor/editor.js
//
// Vanilla-JS UI: fetch the enemy roster's current values, let the user tune
// hull/speed/behavior fields with a plain-English description of what each
// one does, show a diff before anything is written, then drive the
// commit/test/push flow (added in Task 14-15).

const FIELD_DESCRIPTIONS = {
  health: "Hull points. Spent by ramming, explosions, and weapons; the car is destroyed at zero.",
  speedMin: "Slowest cruising speed this car will roll at when it spawns, in world units/sec.",
  speedMax: "Fastest cruising speed this car will roll at when it spawns, in world units/sec.",

  followGap: "Clear road (world units) this driver wants between its nose and the car ahead's tail, before adding closing-speed room.",
  followReaction: "Seconds of closing speed added to followGap — how early this driver starts backing off from something ahead.",
  laneDiscipline: "How hard this driver holds the centre of its lane, from 0 (holds whatever line it's on) to 1 (rides the centre-line exactly).",
  laneHome: 'Which lanes this driver prefers when the road allows it: "any", "inner" (fast lanes near the centre-line), or "outer" (near the barriers).',
  patience: "Seconds this driver will sit behind something worth passing before it commits to a pass.",
  passTrigger: "How far ahead (world units) a slower car has to be before this driver considers it worth passing.",
  passMargin: "How far past a car this driver's nose must clear before pulling back into the lane.",
  passTimeout: "Seconds before an unfinished pass is abandoned.",
  passSpeedMargin: "How much faster than the car ahead this driver must be able to go to bother passing at all.",
  passClearance: "Sideways daylight (px) this driver wants between the two cars while passing.",
  passLookBehind: "How far behind (world units) this driver checks for traffic before pulling into the passing lane.",
  passLookAhead: "How far ahead (world units) this driver checks past the car it means to pass.",
  passEffort: "How much harder this driver pushes its speed while committed to a pass (multiplier, capped at the car's own top speed).",
  hazardClearance: "Sideways daylight (px) this driver wants when steering around a roadblock or other hazard.",
  nerve: "Hull damage this driver will risk from a ROADBLOCK before swerving. 0 means it always dodges; higher means it sometimes barges through.",
  contact: "Hull damage this driver will risk from hitting ANOTHER CAR before backing off. Free to set higher than nerve — a fender-bender reads as driving, not as a mistake.",
};

const FIELD_ORDER = {
  hull: ["health"],
  speed: ["speedMin", "speedMax"],
  behavior: {
    Following: ["followGap", "followReaction"],
    "Lane discipline": ["laneDiscipline", "laneHome"],
    Overtaking: [
      "patience",
      "passTrigger",
      "passMargin",
      "passTimeout",
      "passSpeedMargin",
      "passClearance",
      "passLookBehind",
      "passLookAhead",
      "passEffort",
    ],
    Hazards: ["hazardClearance"],
    Nerve: ["nerve", "contact"],
  },
};

let cars = [];
let selectedCarId = null;
const pendingChanges = {}; // { carId: { field: value } }

async function loadState() {
  const res = await fetch("/api/state");
  const data = await res.json();
  cars = data.cars;
}

function fieldValue(car, field) {
  if (field in car.hull) return car.hull[field];
  if (field in car.speed) return car.speed[field];
  return car.behavior[field].value;
}

function isOverridden(car, field) {
  if (field in car.hull || field in car.speed) return true;
  return !car.behavior[field].inherited;
}

function currentValue(carId, field) {
  if (pendingChanges[carId] && field in pendingChanges[carId]) {
    return pendingChanges[carId][field];
  }
  const car = cars.find((c) => c.id === carId);
  return fieldValue(car, field);
}

function setChange(carId, field, value) {
  pendingChanges[carId] ??= {};
  pendingChanges[carId][field] = value;
}

function renderCarList() {
  const nav = document.getElementById("car-list");
  nav.innerHTML = "";
  for (const car of cars) {
    const button = document.createElement("button");
    button.textContent = car.label;
    button.className = car.id === selectedCarId ? "selected" : "";
    button.addEventListener("click", () => {
      selectedCarId = car.id;
      renderCarList();
      renderForm();
    });
    nav.appendChild(button);
  }
}

function makeField(carId, field) {
  const car = cars.find((c) => c.id === carId);
  const wrapper = document.createElement("div");
  wrapper.className = "field";

  const label = document.createElement("label");
  label.textContent = field;
  if (isOverridden(car, field)) {
    const tag = document.createElement("span");
    tag.className = "override-tag";
    tag.textContent = "(overridden)";
    label.appendChild(tag);
  }
  wrapper.appendChild(label);

  let input;
  if (field === "laneHome") {
    input = document.createElement("select");
    for (const option of ["any", "inner", "outer"]) {
      const opt = document.createElement("option");
      opt.value = option;
      opt.textContent = option;
      input.appendChild(opt);
    }
    input.value = currentValue(carId, field);
  } else {
    input = document.createElement("input");
    input.type = "number";
    input.step = "any";
    input.value = currentValue(carId, field);
  }
  input.addEventListener("change", () => {
    const value = field === "laneHome" ? input.value : Number(input.value);
    setChange(carId, field, value);
  });
  wrapper.appendChild(input);

  const description = document.createElement("div");
  description.className = "description";
  description.textContent = FIELD_DESCRIPTIONS[field];
  wrapper.appendChild(description);

  return wrapper;
}

function renderForm() {
  const section = document.getElementById("car-form");
  if (!selectedCarId) {
    section.hidden = true;
    return;
  }
  section.hidden = false;

  const car = cars.find((c) => c.id === selectedCarId);
  document.getElementById("car-form-title").textContent = car.label;

  const hullDiv = document.getElementById("hull-fields");
  hullDiv.innerHTML = "";
  for (const field of FIELD_ORDER.hull) hullDiv.appendChild(makeField(car.id, field));

  const speedDiv = document.getElementById("speed-fields");
  speedDiv.innerHTML = "";
  for (const field of FIELD_ORDER.speed) speedDiv.appendChild(makeField(car.id, field));

  const behaviorDiv = document.getElementById("behavior-fields");
  behaviorDiv.innerHTML = "";
  for (const [group, fields] of Object.entries(FIELD_ORDER.behavior)) {
    const heading = document.createElement("h3");
    heading.textContent = group;
    behaviorDiv.appendChild(heading);
    for (const field of fields) behaviorDiv.appendChild(makeField(car.id, field));
  }
}

document.getElementById("review-button").addEventListener("click", () => {}); // wired in Task 14

await loadState();
renderCarList();
```

- [ ] **Step 2: Verify in a browser**

Run: `node tools/car-editor/server.js &`
Open `http://localhost:5174/` in a browser. Click each of the 5 car buttons in the left column and confirm: the form re-renders with that car's label as the heading, hull/speed/behavior fields all show numeric inputs (or the 3-option dropdown for Lane home) pre-filled with real values, every field has a description under it, and fields matching that car's actual overrides in `driving.js` (e.g. `nerve` for every enemy) show the "(overridden)" tag.
Then `kill %1`.

- [ ] **Step 3: Commit**

```bash
git add tools/car-editor/editor.js
git commit -m "Add editor.js: load state and render per-car forms"
```

---

### Task 14: `editor.js` — review/diff table

**Files:**
- Modify: `tools/car-editor/editor.js`

- [ ] **Step 1: Add the review renderer**

Add to `tools/car-editor/editor.js`, after `renderForm`:

```js
// Behavior fields flag whether this edit ADDS a new override to the car's
// profile (it currently inherits the commuter default) or CHANGES an
// override that was already there. Hull/speed fields are always plain
// changes — cartypes.js sets them on every entry, so there's no "inherited"
// state for the note to describe.
function noteFor(car, field) {
  if (field in car.hull || field in car.speed) return "";
  return car.behavior[field].inherited ? "new override" : "changed";
}

function renderReview() {
  const section = document.getElementById("review");
  const tbody = document.querySelector("#review-table tbody");
  tbody.innerHTML = "";

  let hasChanges = false;
  for (const [carId, fields] of Object.entries(pendingChanges)) {
    const car = cars.find((c) => c.id === carId);
    for (const [field, value] of Object.entries(fields)) {
      const before = fieldValue(car, field);
      if (before === value) continue;
      hasChanges = true;
      const row = document.createElement("tr");
      const cells = [car.label, field, String(before), String(value), noteFor(car, field)];
      for (const text of cells) {
        const td = document.createElement("td");
        td.textContent = text;
        row.appendChild(td);
      }
      tbody.appendChild(row);
    }
  }

  section.hidden = false;
  document.getElementById("create-pr").disabled = !hasChanges;
}
```

Replace the placeholder listener near the bottom of the file:

```js
document.getElementById("review-button").addEventListener("click", renderReview);
```

- [ ] **Step 2: Verify in a browser**

Run: `node tools/car-editor/server.js &`
Open `http://localhost:5174/`, select `interceptor`, change its `nerve` field (already overridden by the `pursuer` profile), click "Review changes". Expected: a row showing the car's label, `nerve`, old value, new value, and a Note of "changed". Now go back and change `followGap` too (currently inherited from `commuter` for every enemy type), review again. Expected: a second row for `followGap` with Note "new override". Click "Review changes" again without further edits — expected: still exactly those two rows, no duplicates.
Then `kill %1`.

- [ ] **Step 3: Commit**

```bash
git add tools/car-editor/editor.js
git commit -m "Add the review/diff table to editor.js"
```

---

### Task 15: `editor.js` — commit/push/cancel flow

**Files:**
- Modify: `tools/car-editor/editor.js`

- [ ] **Step 1: Add the flow-control functions**

Add to `tools/car-editor/editor.js`, after `renderReview`:

```js
function showStatus(text, kind) {
  const status = document.getElementById("status");
  status.hidden = false;
  status.className = kind;
  status.textContent = text;
}

function showStatusHtml(html, kind) {
  const status = document.getElementById("status");
  status.hidden = false;
  status.className = kind;
  status.innerHTML = html;
}

async function pushAttempt() {
  showStatus("Pushing branch…", "");
  const res = await fetch("/api/push", { method: "POST" });
  const data = await res.json();
  if (!res.ok) {
    showStatus(`Push failed: ${data.error}`, "error");
    return;
  }
  showStatusHtml(
    `Pushed. Opening the pull request page: <a href="${data.url}" target="_blank" rel="noopener">${data.url}</a>`,
    "success"
  );
  window.open(data.url, "_blank", "noopener");
  for (const key of Object.keys(pendingChanges)) delete pendingChanges[key];
}

async function cancelAttempt() {
  showStatus("Cancelling…", "");
  const res = await fetch("/api/cancel", { method: "POST" });
  const data = await res.json();
  if (!res.ok) {
    showStatus(`Cancel failed: ${data.error}`, "error");
    return;
  }
  showStatus("Cancelled. Your working tree is back to normal.", "success");
  document.getElementById("create-pr").disabled = false;
}

async function createPullRequest() {
  document.getElementById("create-pr").disabled = true;
  showStatus("Committing and running tests…", "");

  const commitRes = await fetch("/api/commit", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ changes: pendingChanges }),
  });
  const commitData = await commitRes.json();

  if (!commitRes.ok) {
    showStatus(`Could not start: ${commitData.error}`, "error");
    document.getElementById("create-pr").disabled = false;
    return;
  }

  if (!commitData.testsPassed) {
    showStatusHtml(
      `Tests failed on branch <code>${commitData.branch}</code>:<pre>${commitData.testOutput}</pre>` +
        `<button id="cancel-btn">Cancel</button> <button id="push-anyway-btn">Push anyway</button>`,
      "error"
    );
    document.getElementById("cancel-btn").addEventListener("click", cancelAttempt);
    document.getElementById("push-anyway-btn").addEventListener("click", pushAttempt);
    return;
  }

  await pushAttempt();
}
```

Replace the placeholder listener near the bottom of the file:

```js
document.getElementById("review-button").addEventListener("click", renderReview);
document.getElementById("create-pr").addEventListener("click", createPullRequest);
```

- [ ] **Step 2: Verify the failing-test path without a real push**

This step deliberately stops short of pushing to `origin` — that is a real, visible action, covered with your explicit go-ahead in Task 18. To see the UI branch of the flow safely:

Run: `node tools/car-editor/server.js &`
Open `http://localhost:5174/`, pick the `rival` car, set `speedMin` to a value ABOVE its current `speedMax` (breaks the speed-band invariant on purpose), review, and click "Create Pull Request".
Expected: status shows "Tests failed on branch car-editor-...", the test output naming the broken invariant, and both "Cancel" and "Push anyway" buttons. Click **Cancel**.
Expected: status reads "Cancelled...", and in a terminal, `git branch --list "car-editor-*"` shows nothing and `git status --porcelain -- src/game/cartypes.js` is empty.
Then `kill %1`.

- [ ] **Step 3: Commit**

```bash
git add tools/car-editor/editor.js
git commit -m "Wire up the commit/test/push/cancel flow in editor.js"
```

---

### Task 16: `edit.bat` launcher

**Files:**
- Create: `tools/car-editor/edit.bat`

- [ ] **Step 1: Create the launcher**

```bat
@echo off
REM Cybercruise — enemy car editor.
REM
REM Starts the local editor server (server.js, in this folder) and opens the
REM editor UI once it is actually accepting connections. Requires Node.js;
REM the "Create Pull Request" step additionally needs Git and push access to
REM the repo's origin remote. See play.bat for the same wait-then-open
REM pattern, used here for the same reason: opening the browser before the
REM server is listening races it.
REM
REM Usage:  edit.bat [port]        (default port 5174)

setlocal
cd /d "%~dp0"

if /i "%~1"=="--open" goto wait_and_open

set PORT=%~1
if "%PORT%"=="" set PORT=5174

where node >nul 2>nul
if not %errorlevel%==0 (
  echo.
  echo   Node.js was not found on PATH.
  echo   Install Node.js ^(https://nodejs.org^) and run this again.
  echo.
  pause
  exit /b 1
)

echo Starting the car editor on http://localhost:%PORT%/  ^(Ctrl+C to stop^)
start "" /b "%~f0" --open %PORT%
call node server.js
exit /b %errorlevel%

:wait_and_open
set PORT=%~2

where powershell >nul 2>nul
if not %errorlevel%==0 goto blind_open

powershell -NoProfile -Command "$end=(Get-Date).AddSeconds(30); while((Get-Date) -lt $end){ $c=New-Object Net.Sockets.TcpClient; try{ $c.Connect('127.0.0.1',%PORT%); $c.Close(); exit 0 } catch { Start-Sleep -Milliseconds 200 } finally { $c.Dispose() } }; exit 1"
if errorlevel 1 (
  echo.
  echo   The server never started listening on port %PORT%.
  echo   Check the messages above; the browser was not opened.
  exit /b 1
)
echo Server is up — opening the editor.
start "" "http://localhost:%PORT%/"
exit /b 0

:blind_open
ping -n 4 127.0.0.1 >nul
start "" "http://localhost:%PORT%/"
exit /b 0
```

- [ ] **Step 2: Verify it launches the editor**

Run (on Windows, or via `cmd.exe` if available in this shell): `tools\car-editor\edit.bat`
Expected: a console window prints "Starting the car editor on http://localhost:5174/", then a browser opens to that URL showing the editor page.
Stop the server with Ctrl+C in its console.

- [ ] **Step 3: Commit**

```bash
git add tools/car-editor/edit.bat
git commit -m "Add edit.bat launcher for the car editor"
```

---

### Task 17: README

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Add `tools/car-editor/` to the project layout listing**

In `README.md`, find this block (near the end, under "## Project layout"):

```
index.html          canvas + module entry
css/style.css       page + CRT frame styling
src/
  main.js           bootstrap + game loop
  engine/           loop, input, neon draw helpers
  game/             player, road, traffic, weapons, ... (built per phase)
  audio/            wavesynth synth (later phase)
```

Replace it with:

```
index.html          canvas + module entry
css/style.css       page + CRT frame styling
src/
  main.js           bootstrap + game loop
  engine/           loop, input, neon draw helpers
  game/             player, road, traffic, weapons, ... (built per phase)
  audio/            wavesynth synth (later phase)
tools/
  drivesim.js       headless driving-profile measurement (see npm run sim)
  car-editor/       browser UI for tuning enemy hull/speed/behavior — see below
```

- [ ] **Step 2: Add a short usage subsection**

In `README.md`, find the "### Asset gallery" section and add a new subsection immediately after it (before "### Controls"):

```
### Enemy car editor

A local tool for tuning the 5 enemy types' hull, speed, and driving-behavior
knobs (`tools/car-editor/`) without hand-editing `cartypes.js`/`driving.js`.
Double-click `tools/car-editor/edit.bat` (or run
`node tools/car-editor/server.js`) and open the URL it prints. Every field
shows its current value and a description of what it does; "Create Pull
Request" patches the two source files on a fresh branch, runs the test suite
before pushing, and opens GitHub's compare page so you finish the PR from
there. Requires Git; does not require the GitHub CLI.
```

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "Document the enemy car editor in the README"
```

---

### Task 18: End-to-end verification

**Files:** none (verification only)

- [ ] **Step 1: Run the full automated test suite**

Run: `npm test`
Expected: all tests pass, including the new `test/car-editor-*.test.js` files alongside the existing `test/invariants.test.js`.

- [ ] **Step 2: Full manual walkthrough, ending just short of a real push**

Run: `tools\car-editor\edit.bat` (or `node tools/car-editor/server.js` and open `http://localhost:5174/` manually).

1. Select `interceptor`, change `speedMax` from its current value to something 20 higher, and change `nerve` to a slightly higher number.
2. Click "Review changes" — confirm both rows appear with correct before/after values.
3. Click "Create Pull Request".
4. Confirm the status shows "Committing and running tests…" then reports `testsPassed: true` behavior (tests should pass for a modest, in-band tweak) and proceeds to "Pushing branch…".

**Stop here without letting it push** — pushing a branch to `origin` and opening a real compare page against the actual repo is a visible, hard-to-reverse action. Confirm with the user before letting `pushAttempt()` actually run in this verification pass; if they want to see the full flow including a real push, get their explicit go-ahead first, since it will create a branch on `bluedragon-ctrl/Cybercruise`'s remote.

- [ ] **Step 3: If the user confirms, verify the real push**

Only after explicit confirmation: let the flow continue, confirm a browser tab opens to a GitHub compare URL of the form `https://github.com/bluedragon-ctrl/Cybercruise/compare/<original-branch>...car-editor-<timestamp>?expand=1`, and confirm locally that `git status` shows you back on your original branch with a clean working tree:

```bash
git status
git branch --list "car-editor-*"
```

Expected: `git status` shows the original branch, clean; `car-editor-*` branch does NOT exist locally (it only exists on `origin` now, ready for the PR). Decide with the user whether to open the PR for real or delete the remote branch (`git push origin --delete car-editor-<timestamp>`) to clean up after the test.

- [ ] **Step 4: Report results to the user**

Summarize what was verified (or, if the user declined the real push, what was verified up to that point) — no further commit needed, this task is verification only.
