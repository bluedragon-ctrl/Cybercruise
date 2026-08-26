import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  findMatchingBrace,
  patchCarType,
  patchDrivingProfile,
  patchObstacleType,
  patchPickupType,
  patchUpgradeEntry,
  patchWeaponType,
} from "../tools/car-editor/patcher.js";
import { CAR_TYPES } from "../src/game/cartypes.js";
import { OBSTACLE_TYPES } from "../src/game/obstacletypes.js";
import { PICKUP_TYPES } from "../src/game/pickuptypes.js";
import { CONSUMABLES, STATS } from "../src/game/upgrades.js";

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
  // one number changing, whatever health happens to be tuned to right now.
  const currentHealth = CAR_TYPES.find((t) => t.id === "interceptor").health;
  assert.equal(result.length - realSource.length, "999".length - String(currentHealth).length);
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
  // one number changing, whatever minDistance happens to be tuned to right now.
  const currentMinDistance = OBSTACLE_TYPES.find((t) => t.id === "trestle").minDistance;
  assert.equal(result.length - realSource.length, "40".length - String(currentMinDistance).length);
});

const SAMPLE_PICKUPTYPES = `export const PICKUP_TYPES = [
  {
    id: "fix",
    kind: HEAL,
    amount: 70,
    weight: 1,
    minDistance: 0,
  },
  {
    id: "shield",
    kind: SHIELD,
    duration: 5,
    weight: 1,
    minDistance: 0, // rare
  },
];
`;

test("patchPickupType replaces weight and minDistance without touching other fields", () => {
  const result = patchPickupType(SAMPLE_PICKUPTYPES, "shield", { weight: 0.5, minDistance: 30 });
  assert.match(result, /id: "shield",\n {4}kind: SHIELD,\n {4}duration: 5,\n {4}weight: 0.5,\n {4}minDistance: 30, \/\/ rare/);
  assert.match(result, /id: "fix",\n {4}kind: HEAL,\n {4}amount: 70,\n {4}weight: 1,/); // untouched
});

test("patchPickupType throws for an unknown pickup id", () => {
  assert.throws(
    () => patchPickupType(SAMPLE_PICKUPTYPES, "ghost", { weight: 1 }),
    /no entry with id "ghost"/
  );
});

test("patchPickupType throws for a field not present on the entry", () => {
  assert.throws(
    () => patchPickupType(SAMPLE_PICKUPTYPES, "fix", { blastDamage: 10 }),
    /field "blastDamage" not found/
  );
});

test("patchPickupType works against the real src/game/pickuptypes.js", () => {
  const realSource = readFileSync(
    new URL("../src/game/pickuptypes.js", import.meta.url),
    "utf8"
  );
  const result = patchPickupType(realSource, "fix", { minDistance: 40 });
  assert.match(result, /id: "fix",[\s\S]*?minDistance: 40,/);
  // The rest of the file must be untouched — same length delta as exactly
  // one number changing, whatever minDistance happens to be tuned to right now.
  const currentMinDistance = PICKUP_TYPES.find((t) => t.id === "fix").minDistance;
  assert.equal(result.length - realSource.length, "40".length - String(currentMinDistance).length);
});

test("patchPickupType replaces amount on an AMMO/HEAL pickup", () => {
  const result = patchPickupType(SAMPLE_PICKUPTYPES, "fix", { amount: 90 });
  assert.match(result, /id: "fix",\n {4}kind: HEAL,\n {4}amount: 90,/);
});

test("patchPickupType replaces duration on the SHIELD pickup", () => {
  const result = patchPickupType(SAMPLE_PICKUPTYPES, "shield", { duration: 8 });
  assert.match(result, /id: "shield",\n {4}kind: SHIELD,\n {4}duration: 8,/);
});

test("patchPickupType throws when asked to patch duration on an entry that only has amount", () => {
  assert.throws(
    () => patchPickupType(SAMPLE_PICKUPTYPES, "fix", { duration: 3 }),
    /field "duration" not found/
  );
});

test("patchPickupType works against the real src/game/pickuptypes.js for amount and duration", () => {
  const realSource = readFileSync(
    new URL("../src/game/pickuptypes.js", import.meta.url),
    "utf8"
  );
  const amountResult = patchPickupType(realSource, "fix", { amount: 90 });
  assert.match(amountResult, /id: "fix",[\s\S]*?amount: 90,/);

  const durationResult = patchPickupType(realSource, "shield", { duration: 8 });
  assert.match(durationResult, /id: "shield",[\s\S]*?duration: 8,/);
});

// --- patchUpgradeEntry: the shop's own catalogue (game/upgrades.js) --------
//
// Both CONSUMABLES and STATS are flat, id-first arrays exactly like
// CAR_TYPES/OBSTACLE_TYPES/PICKUP_TYPES above, so patchUpgradeEntry is
// patchTypeEntry under a third name (see patcher.js's own comment on why the
// two shelves share one function) — these tests exercise it against the real
// file rather than a fixture, the same way the pickup tests above do, because
// that shape claim is exactly the kind of thing that quietly stops being true
// if someone restructures the catalogue.
const UPGRADES_PATH = new URL("../src/game/upgrades.js", import.meta.url);

test("patchUpgradeEntry replaces price on a CONSUMABLES row without touching its amount", () => {
  const realSource = readFileSync(UPGRADES_PATH, "utf8");
  const result = patchUpgradeEntry(realSource, "buy_repair", { price: 250 });
  assert.match(result, /id: "buy_repair",[\s\S]*?price: 250,/);
  const untouchedAmount = CONSUMABLES.find((e) => e.id === "buy_repair").amount;
  assert.match(result, new RegExp(`id: "buy_repair",[\\s\\S]*?amount: ${untouchedAmount},`));
});

test("patchUpgradeEntry replaces the effect field (amount or duration) on a CONSUMABLES row", () => {
  const realSource = readFileSync(UPGRADES_PATH, "utf8");
  const amountResult = patchUpgradeEntry(realSource, "buy_repair", { amount: 90 });
  assert.match(amountResult, /id: "buy_repair",[\s\S]*?amount: 90,/);

  const durationResult = patchUpgradeEntry(realSource, "buy_shield", { duration: 9 });
  assert.match(durationResult, /id: "buy_shield",[\s\S]*?duration: 9,/);
});

// The caption is DERIVED, not a second thing to remember: a retune that moves
// `amount` or `duration` has to move the `detail` string the shelf prints, or
// the row advertises one figure and pays out another. That drift is not
// hypothetical — it is what a tuning pass through this very function shipped
// once, and only test/shop.test.js caught it.
test("patchUpgradeEntry retunes a consumable's caption along with its effect", () => {
  const realSource = readFileSync(UPGRADES_PATH, "utf8");

  const repair = patchUpgradeEntry(realSource, "buy_repair", { amount: 90 });
  assert.ok(entryOf(repair, "buy_repair").includes('detail: "+90 HULL"'),
    "the repair still advertises its old figure");

  const shield = patchUpgradeEntry(realSource, "buy_shield", { duration: 9 });
  assert.ok(entryOf(shield, "buy_shield").includes('detail: "9 SEC"'),
    "the shield still advertises its old figure");

  // Only the FIGURE moves. The units, the sign and the wording around it are
  // the row's own voice ("SET OF 8" is not "+8 RDS") and a patch that
  // reformatted them would be rewriting the shelf, not tuning it.
  const mines = patchUpgradeEntry(realSource, "buy_mine_ammo", { amount: 12 });
  assert.ok(entryOf(mines, "buy_mine_ammo").includes('detail: "SET OF 12"'),
    "the caption lost its wording");
});

test("patchUpgradeEntry leaves the caption alone when only the price moves", () => {
  // What a row COSTS is not part of what it says it hands over — the shop
  // screen prints the price from the entry itself — so a price-only retune
  // must not go near `detail`.
  const realSource = readFileSync(UPGRADES_PATH, "utf8");
  const stated = CONSUMABLES.find((e) => e.id === "buy_repair").detail;
  const result = patchUpgradeEntry(realSource, "buy_repair", { price: 250 });
  assert.ok(entryOf(result, "buy_repair").includes(`detail: "${stated}"`),
    "a price change rewrote the caption");
});

test("patchUpgradeEntry patches a STATS row, which has no caption to keep in step", () => {
  // Every STATS row states its step through the shop screen rather than in a
  // `detail` string, so the caption sync has nothing to do there and must not
  // mistake that for a failure.
  const realSource = readFileSync(UPGRADES_PATH, "utf8");
  const result = patchUpgradeEntry(realSource, "engine", { step: 44 });
  assert.ok(entryOf(result, "engine").includes("step: 44,"));
});

// Reads back the source text of one catalogue entry, so an assertion about a
// row cannot accidentally be satisfied by a different row's identical line.
function entryOf(sourceText, id) {
  const start = sourceText.indexOf(`id: "${id}"`);
  assert.notEqual(start, -1, `no entry with id "${id}" in the patched source`);
  return sourceText.slice(start, sourceText.indexOf("},", start));
}
test("patchUpgradeEntry throws when asked to patch duration on a row that only has amount", () => {
  const realSource = readFileSync(UPGRADES_PATH, "utf8");
  assert.throws(
    () => patchUpgradeEntry(realSource, "buy_repair", { duration: 3 }),
    /field "duration" not found/
  );
});

test("patchUpgradeEntry replaces price and step together on a STATS row", () => {
  const realSource = readFileSync(UPGRADES_PATH, "utf8");
  const result = patchUpgradeEntry(realSource, "engine", { price: 160, step: 45 });
  assert.match(result, /id: "engine",[\s\S]*?step: 45,[\s\S]*?price: 160,/);
  // Untouched: the OTHER stats keep their own figures — the surgery must not
  // have grabbed the wrong block just because "engine" and "chassis" both name
  // fields called `price` and `step`.
  const chassis = STATS.find((s) => s.id === "chassis");
  assert.match(result, new RegExp(`id: "chassis",[\\s\\S]*?step: ${chassis.step},`));
});

test("patchUpgradeEntry throws for an unknown upgrade id", () => {
  const realSource = readFileSync(UPGRADES_PATH, "utf8");
  assert.throws(
    () => patchUpgradeEntry(realSource, "ghost", { price: 100 }),
    /no entry with id "ghost"/
  );
});

test("patchUpgradeEntry throws for a field not present on the entry", () => {
  const realSource = readFileSync(UPGRADES_PATH, "utf8");
  assert.throws(
    () => patchUpgradeEntry(realSource, "engine", { blastDamage: 10 }),
    /field "blastDamage" not found/
  );
});

// --- `profile()` with no argument object -----------------------------------
//
// The commuter reference is written `commuter: profile(),` — it takes every
// default, so there is no `{ ... }` to patch a field into. It is also the
// profile the sedan and every car without a `driving` key actually drives,
// so this is not an exotic case: it is the whole civilian baseline.

test("patchDrivingProfile gives a bare profile() an argument object and inserts into it", () => {
  const source = `export const DRIVING_PROFILES = {
  commuter: profile(),

  hustler: profile({ nerve: 4 }),
};
`;
  const result = patchDrivingProfile(source, "commuter", { followGap: 33 });
  assert.match(result, /commuter: profile\(\{\n {4}followGap: 33,\n {2}\}\),/);
  // The neighbouring profile is untouched.
  assert.match(result, /hustler: profile\(\{ nerve: 4 \}\)/);
});

test("patchDrivingProfile inserts several fields, string and numeric, into a bare profile()", () => {
  const source = `export const DRIVING_PROFILES = {
  commuter: profile(),
};
`;
  const result = patchDrivingProfile(source, "commuter", { followGap: 33, laneHome: "inner" });
  assert.match(result, /followGap: 33,/);
  assert.match(result, /laneHome: "inner",/);
});

test("patching a bare profile() twice replaces rather than duplicates the field", () => {
  const source = `export const DRIVING_PROFILES = {
  commuter: profile(),
};
`;
  const once = patchDrivingProfile(source, "commuter", { followGap: 33 });
  const twice = patchDrivingProfile(once, "commuter", { followGap: 44 });
  assert.equal(twice.match(/followGap:/g).length, 1);
  assert.match(twice, /followGap: 44,/);
});

test("patchDrivingProfile produces parseable JS when it fills in the real commuter profile", () => {
  const realSource = readFileSync(
    new URL("../src/game/driving.js", import.meta.url),
    "utf8"
  );
  const result = patchDrivingProfile(realSource, "commuter", { followGap: 33 });
  assert.match(result, /commuter: profile\(\{\n {4}followGap: 33,\n {2}\}\),/);
  // The insertion has to be valid JS, not just the right-looking text — a
  // missing comma or brace here would break the game, and the editor writes
  // this file straight to disk before the test run that would catch it.
  assert.doesNotThrow(() => new Function(result.replace(/^export /gm, "")));
});

// --- Weapons ---------------------------------------------------------------
//
// weapons.js holds TWO arrays in one file, the player's kit and the hostiles'.
// patchWeaponType finds an entry by id across the whole file, so these check
// that reaching into one array never disturbs the other.

test("patchWeaponType patches a player weapon in the real src/game/weapons.js", () => {
  const realSource = readFileSync(new URL("../src/game/weapons.js", import.meta.url), "utf8");
  const result = patchWeaponType(realSource, "rocket", { damage: 120, ammo: 40 });
  assert.match(result, /damage: 120,/);
  assert.match(result, /ammo: 40,/);
});

test("patchWeaponType patches a hostile weapon without touching the player's kit", () => {
  const realSource = readFileSync(new URL("../src/game/weapons.js", import.meta.url), "utf8");
  const result = patchWeaponType(realSource, "blaster", { damage: 9 });
  assert.match(result, /damage: 9,/);
  // The cannon's own damage figure is untouched — same length delta as one
  // number going from "5" to "9".
  assert.equal(result.length, realSource.length);
  assert.match(result, /damage: 41,/);
});

test("two weapon patches fold onto one another rather than overwriting", () => {
  // Both arrays live in one file, so a session touching a player weapon AND a
  // hostile one must apply both to the same running text — patching twice
  // against the ORIGINAL text is how the second edit silently wins.
  const realSource = readFileSync(new URL("../src/game/weapons.js", import.meta.url), "utf8");
  const once = patchWeaponType(realSource, "rocket", { damage: 120 });
  const twice = patchWeaponType(once, "blaster", { damage: 9 });
  assert.match(twice, /damage: 120,/);
  assert.match(twice, /damage: 9,/);
});

test("patchWeaponType throws for a field the entry does not have", () => {
  const realSource = readFileSync(new URL("../src/game/weapons.js", import.meta.url), "utf8");
  assert.throws(
    () => patchWeaponType(realSource, "cannon", { turnRate: 100 }),
    /field "turnRate" not found on entry "cannon"/
  );
});

test("patchWeaponType throws for a weapon id that is in neither array", () => {
  const realSource = readFileSync(new URL("../src/game/weapons.js", import.meta.url), "utf8");
  assert.throws(
    () => patchWeaponType(realSource, "raygun", { damage: 1 }),
    /no entry with id "raygun" found/
  );
});
