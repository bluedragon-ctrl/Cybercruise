import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import {
  applyChanges,
  failingTests,
  TOUCHED_FILES,
  testFiles,
} from "../tools/car-editor/server.js";
import { CONSTANT_FILES, readConstantValue } from "../tools/car-editor/constants.js";

// The commit handler's whole job is to turn one request into a set of patched
// files. Everything below drives that directly, in memory, so the pipeline —
// routing a field to the right file, folding two edits onto one file, and
// leaving valid JavaScript behind — is checked without going anywhere near git.

function loadFiles() {
  const files = new Map();
  for (const rel of TOUCHED_FILES) {
    files.set(rel, {
      text: readFileSync(new URL(`../${rel}`, import.meta.url), "utf8"),
      changed: false,
    });
  }
  return files;
}

function changedFiles(files) {
  return [...files].filter(([, entry]) => entry.changed).map(([rel]) => rel);
}

// `export` and `import` are both illegal inside a Function body, so they are
// stripped before parsing. The import pattern spans lines on purpose — several
// of these files open with a multi-line `import { ... } from "...";` and a
// line-wise strip would leave the braces behind, failing every file equally and
// so proving nothing. What is being checked is that the patch left the file's
// own syntax intact — a dropped comma, an unbalanced brace — not that the
// module graph still resolves.
function toParseable(text) {
  return text.replace(/^import[\s\S]*?from\s+"[^"]*";/gm, "").replace(/^export /gm, "");
}

function assertParses(text, label) {
  assert.doesNotThrow(() => new Function(toParseable(text)), `${label} no longer parses`);
}

test("the parse check is meaningful: every untouched source already parses", () => {
  // Guards the guard. If the stripping were wrong, assertParses would throw for
  // every file and "still valid JavaScript" would be asserting nothing.
  for (const [rel, entry] of loadFiles()) assertParses(entry.text, rel);
});

// One representative change per catalogue, plus the two cases that used to go
// wrong quietly: two cars on one driving profile, and two entries in one file.
const BROAD_REQUEST = {
  changes: {
    // A catalogue field and a behavior field on the same car — they land in two
    // different files.
    rival: { health: 420, bounty: 40, nerve: 11 },
    // VAN and BUS share the "hauler" profile: the SAME value from both is
    // allowed and must produce exactly one patch.
    van: { followGap: 44 },
    bus: { followGap: 44 },
    // The sedan has no `driving` key at all and resolves to the commuter
    // profile, which is written `profile()` with no argument object.
    sedan: { patience: 2.5 },
  },
  obstacleChanges: { spikes: { contactDamage: 9, slowTo: 120 }, trestle: { health: 30 } },
  pickupChanges: { fix: { amount: 70, weight: 2 } },
  weaponChanges: { rocket: { damage: 110 }, blaster: { damage: 7 } },
  upgradeConsumableChanges: { buy_shield: { price: 130 } },
  upgradeStatChanges: { engine: { step: 45 } },
  constantChanges: {
    "player.MAX_SPEED": 640,
    "traffic.MAX_CARS": 8,
    "road.ROAD_TURN_RATE": 0.7,
    "run.SHOP_INTERVAL": 450,
    "run.TIER_PRICE_3": 5,
  },
};

test("a request touching every catalogue patches every file it should", () => {
  const files = loadFiles();
  applyChanges(BROAD_REQUEST, files);
  assert.deepEqual(changedFiles(files).sort(), [
    "src/game/cartypes.js",
    "src/game/driving.js",
    "src/game/hauler.js",
    "src/game/obstacletypes.js",
    "src/game/pickuptypes.js",
    "src/game/player.js",
    "src/game/traffic.js",
    "src/game/tuning.js",
    "src/game/upgrades.js",
    "src/game/weapons.js",
  ]);
  // score.js is the control: it is in TOUCHED_FILES, but the request names no
  // score constant, so it must come back unchanged.
  assert.ok(!changedFiles(files).includes("src/game/score.js"));
});

test("every file a broad request patches is still valid JavaScript", () => {
  const files = loadFiles();
  applyChanges(BROAD_REQUEST, files);
  for (const [rel, entry] of files) {
    if (entry.changed) assertParses(entry.text, rel);
  }
});

test("the patched values are the values that were asked for", () => {
  const files = loadFiles();
  applyChanges(BROAD_REQUEST, files);
  const text = (rel) => files.get(rel).text;

  assert.match(text("src/game/cartypes.js"), /health: 420,/);
  assert.match(text("src/game/cartypes.js"), /bounty: 40,/);
  assert.match(text("src/game/driving.js"), /duelist: profile\(\{ nerve: 11 \}\)/);
  assert.match(text("src/game/obstacletypes.js"), /contactDamage: 9,/);
  assert.match(text("src/game/pickuptypes.js"), /amount: 70,/);
  assert.match(text("src/game/weapons.js"), /damage: 110,/);
  assert.match(text("src/game/weapons.js"), /damage: 7,/);
  assert.match(text("src/game/upgrades.js"), /price: 130,/);
  assert.match(text("src/game/upgrades.js"), /step: 45,/);

  assert.equal(readConstantValue(text("src/game/player.js"), "MAX_SPEED"), 640);
  assert.equal(readConstantValue(text("src/game/traffic.js"), "MAX_CARS"), 8);
  assert.equal(readConstantValue(text("src/game/tuning.js"), "ROAD_TURN_RATE"), 0.7);
  assert.equal(readConstantValue(text("src/game/hauler.js"), "SHOP_INTERVAL"), 450);
  assert.equal(readConstantValue(text("src/game/upgrades.js"), "TIER_PRICES", 2), 5);
});

test("two cars sharing a driving profile produce exactly one patched field", () => {
  // VAN and BUS both drive "hauler". Patching per car — the way this used to
  // work — applied two edits to the same block against the accumulating text,
  // and the second silently overwrote the first.
  const files = loadFiles();
  applyChanges(BROAD_REQUEST, files);
  const driving = files.get("src/game/driving.js").text;
  const hauler = driving.slice(driving.indexOf("hauler: profile({"));
  const block = hauler.slice(0, hauler.indexOf("}),"));
  assert.equal((block.match(/followGap:/g) ?? []).length, 1);
  assert.match(block, /followGap: 44,/);
});

test("a behavior edit on the sedan fills in the bare commuter profile", () => {
  // `commuter: profile()` has no argument object to patch into, and the sedan's
  // own entry names no profile at all — both used to make this request fail.
  const files = loadFiles();
  applyChanges(BROAD_REQUEST, files);
  const driving = files.get("src/game/driving.js").text;
  assert.match(driving, /commuter: profile\(\{\n {4}patience: 2\.5,\n {2}\}\),/);
  assertParses(driving, "src/game/driving.js");
});

test("two cars on one profile asking for different values is refused", () => {
  const files = loadFiles();
  assert.throws(
    () => applyChanges({ changes: { van: { followGap: 30 }, bus: { followGap: 40 } } }, files),
    /share the "hauler" driving profile/
  );
});

test("two edits to the same file fold onto one another", () => {
  // upgrades.js takes edits from three different places — the consumables
  // shelf, the stats shelf and the tier-price ladder. Patching each against the
  // ORIGINAL text would leave only the last one.
  const files = loadFiles();
  applyChanges(BROAD_REQUEST, files);
  const upgrades = files.get("src/game/upgrades.js").text;
  assert.match(upgrades, /price: 130,/);
  assert.match(upgrades, /step: 45,/);
  assert.equal(readConstantValue(upgrades, "TIER_PRICES", 2), 5);
});

test("TOUCHED_FILES covers every file the constants catalogue reaches into", () => {
  // The dirty check, the read and the commit staging all run off TOUCHED_FILES.
  // A constant in a file missing from it would be written to an unstaged file.
  for (const rel of CONSTANT_FILES) {
    assert.ok(TOUCHED_FILES.includes(rel), `${rel} is patchable but not tracked`);
  }
});

// --- Finding the test files -------------------------------------------------
//
// The commit flow runs the suite before it will push, so how it FINDS the suite
// is part of the flow. It used to hand `test/*.test.js` to execFile, which
// spawns without a shell — so the only thing that could expand that glob was
// `node --test` itself, which only learned to in Node 21. On Node 20 every
// tuning attempt reported a failing test run on a completely green tree.
//
// It read as working throughout development because the same command typed at a
// shell prompt has its glob expanded by the shell before the runner ever sees
// it. That is exactly the gap these cover: discovery is asserted directly,
// never through a shell.
//
// runTests() itself is deliberately NOT called here — it spawns the whole suite,
// and calling it from inside the suite would recurse.

test("testFiles finds the test files by reading the directory, with no glob involved", async () => {
  const files = await testFiles();
  assert.ok(files.length > 0, "no test files discovered");
  for (const file of files) {
    assert.match(file, /^test\/[^*?]+\.test\.js$/, `${file} is not a plain path`);
  }
});

test("testFiles discovers exactly the *.test.js files on disk", async () => {
  const onDisk = readdirSync(new URL("../test", import.meta.url))
    .filter((name) => name.endsWith(".test.js"))
    .sort()
    .map((name) => `test/${name}`);
  assert.deepEqual(await testFiles(), onDisk);
  // Including this very file, which is the cheapest proof the list is real.
  assert.ok(onDisk.includes("test/car-editor-commit.test.js"));
});

test("testFiles skips files that are not tests", async () => {
  // test/ holds README-invariants.md alongside the suites.
  const files = await testFiles();
  assert.ok(!files.some((f) => f.endsWith(".md")));
});

// --- Reporting which test failed --------------------------------------------

test("failingTests pulls each failure out with the block beneath it", () => {
  const tap = [
    "TAP version 13",
    "ok 1 - fine",
    "not ok 2 - the repair and the shield are the crate's own figures",
    "  ---",
    "  error: |-",
    "    Expected values to be strictly equal:",
    "    50 !== 70",
    "  code: 'ERR_ASSERTION'",
    "  ...",
    "ok 3 - also fine",
    "1..3",
  ].join("\n");
  const failures = failingTests(tap);
  assert.equal(failures.length, 1);
  assert.match(failures[0], /^not ok 2 - the repair and the shield/);
  assert.match(failures[0], /50 !== 70/);
  // The passing results are not swept in with it.
  assert.ok(!failures[0].includes("ok 3"));
});

test("failingTests reports nothing for a green run", () => {
  assert.deepEqual(failingTests("TAP version 13\nok 1 - a\nok 2 - b\n1..2\n"), []);
});

test("failingTests keeps every failure when there is more than one", () => {
  const tap = "not ok 1 - first\n  ---\n  error: 'a'\n  ...\nnot ok 2 - second\n  ---\n  error: 'b'\n  ...\n";
  const failures = failingTests(tap);
  assert.equal(failures.length, 2);
  assert.match(failures[0], /first/);
  assert.match(failures[1], /second/);
});

test("failingTests handles CRLF output", () => {
  // execFile hands back whatever the runner wrote, and this is Windows.
  const tap = "ok 1 - a\r\nnot ok 2 - b\r\n  ---\r\n  error: 'x'\r\n  ...\r\n";
  assert.equal(failingTests(tap).length, 1);
});
