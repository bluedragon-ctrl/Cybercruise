// tools/car-editor/server.js
//
// Local HTTP server for the tuning editor: serves the editor UI and its
// API. Started via edit.bat, or directly with `node tools/car-editor/server.js`.
// Requires git on PATH — see the startup check at the bottom of this file.

import http from "node:http";
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";

import {
  buildAllCarState,
  buildAllObstacleState,
  buildAllPickupState,
  buildAllWeaponState,
  buildAllUpgradeConsumableState,
  buildAllUpgradeStatState,
  CAR_IDS,
  CAR_TYPE_FIELDS,
  CAR_FIELD_GROUPS,
  BEHAVIOR_FIELDS,
  BEHAVIOR_FIELD_GROUPS,
  OBSTACLE_FIELD_GROUPS,
  WEAPON_FIELD_GROUPS,
  OBSTACLE_IDS,
  OBSTACLE_FIELDS,
  PICKUP_IDS,
  PICKUP_SPAWN_FIELDS,
  PICKUP_EFFECT_FIELDS,
  WEAPON_IDS,
  WEAPON_FIELDS,
  UPGRADE_CONSUMABLE_IDS,
  UPGRADE_STAT_IDS,
  buildCarState,
  buildWeaponState,
  drivingProfileNameFor,
  drivingProfileScope,
  refreshCatalogues,
} from "./state.js";
import {
  CONSTANT_IDS,
  CONSTANT_BY_ID,
  CONSTANT_FILES,
  buildAllConstantState,
} from "./constants.js";
import {
  patchCarType,
  patchDrivingProfile,
  patchObstacleType,
  patchPickupType,
  patchWeaponType,
  patchUpgradeEntry,
  patchConstant,
  patchArrayConstantElement,
} from "./patcher.js";
import * as git from "./git.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "../..");

const CARTYPES_REL = "src/game/cartypes.js";
const DRIVING_REL = "src/game/driving.js";
const OBSTACLETYPES_REL = "src/game/obstacletypes.js";
const PICKUPTYPES_REL = "src/game/pickuptypes.js";
const WEAPONS_REL = "src/game/weapons.js";
const UPGRADES_REL = "src/game/upgrades.js";

// Every file a tuning session may touch: the six catalogues above plus
// whichever modules the bare-constant catalogue reaches into (player.js,
// traffic.js, tuning.js, hauler.js, score.js — and upgrades.js again, for the
// tier-price ladder, which is why this is deduplicated rather than
// concatenated). One list, used for the dirty check, for reading, and for
// staging the commit, so those three can never drift apart.
export const TOUCHED_FILES = [
  ...new Set([
    CARTYPES_REL, DRIVING_REL, OBSTACLETYPES_REL, PICKUPTYPES_REL, WEAPONS_REL,
    UPGRADES_REL, ...CONSTANT_FILES,
  ]),
];

// The working set for one commit: every touched file's text, and whether a
// patch has actually rewritten it. Replaces the five parallel
// `let xText` / `let xChanged` pairs this used to carry, which would have
// become eleven.
async function loadTouchedFiles() {
  const files = new Map();
  for (const rel of TOUCHED_FILES) {
    files.set(rel, { text: await readFile(path.join(REPO_ROOT, rel), "utf8"), changed: false });
  }
  return files;
}

function editFile(files, rel, patch) {
  const entry = files.get(rel);
  entry.text = patch(entry.text);
  entry.changed = true;
}

// The single tuning attempt in flight, if any. This is a local, one-user
// tool — there is never more than one browser tab driving it in practice —
// so module-level state is enough; no session/locking machinery needed.
let pending = null; // { branchName, originalBranch }

// 5174 is duplicated in edit.bat's own no-arg default — keep both in sync.
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
  // Re-read the catalogues from disk first. Without this the server keeps
  // serving whatever it imported at startup, so the session after a commit
  // would show pre-edit values as "current" and diff every change against a
  // baseline that no longer exists on disk.
  await refreshCatalogues();
  sendJson(res, 200, {
    cars: buildAllCarState(),
    obstacles: buildAllObstacleState(),
    pickups: buildAllPickupState(),
    weapons: buildAllWeaponState(),
    upgradeConsumables: buildAllUpgradeConsumableState(),
    upgradeStats: buildAllUpgradeStatState(),
    // Read straight from the source text on every request (see constants.js),
    // so unlike the five catalogues above these need no cache-busting at all.
    constantGroups: buildAllConstantState(),
    // The field ORDERINGS, sent alongside the values. The UI used to keep its
    // own copy of these, which meant a field added to a catalogue and not to
    // the UI's list simply never rendered — a silent gap rather than an error.
    carFieldGroups: CAR_FIELD_GROUPS,
    behaviorFieldGroups: BEHAVIOR_FIELD_GROUPS,
    obstacleFieldGroups: OBSTACLE_FIELD_GROUPS,
    weaponFieldGroups: WEAPON_FIELD_GROUPS,
  });
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}

// Fields that must be strictly positive numbers, beyond just finite. Applied
// after the generic finite-number check below, and also cross-checked as an
// ORDERING (speedMin <= cruiseMin <= cruiseMax <= speedMax) whatever subset of
// the four a request touches — catching nonsensical values like `health: -50` or an
// inverted speed range at the boundary, rather than relying on downstream
// game-invariant tests to notice.
//
// `price` and `step` join the set for the shop's own catalogue: a free or
// negatively-priced row is a bug, not a sale, and a step of 0 or less is a
// tier that buys nothing (or moves a stat backwards), neither of which
// upgrades.js's own ladder logic accounts for.
export const POSITIVE_FIELDS = new Set([
  "health", "cruiseMin", "cruiseMax", "speedMax", "amount", "duration", "price",
  "step",
  // Weapons and the rest of a car's own figures. A weapon with `interval: 0`
  // fires every frame forever and a `mass: 0` car cannot be pushed by
  // anything, so neither is a value, both are a wedged simulation. `slowTo`
  // is a SPEED to slow a car down TO, not an amount taken off, so zero would
  // mean "stopped dead" — a different effect than the strip is designed for.
  "interval", "muzzleSpeed", "topSpeed", "mass", "steerSpeed", "slowTo",
]);

// minDistance is a gate, not a magnitude — 0 ("from the first metre", see
// cartypes.js) is its most common and entirely valid value, so it only rules
// out negative distances rather than joining POSITIVE_FIELDS above. An
// obstacle's `weight` joins it for the same reason: 0 is how you take a
// hazard out of the draw entirely without deleting its entry.
//
// The rest are fields where zero genuinely means "none of this": a weapon
// that deals no direct damage (the mine layer's payload does the work), a
// wreck with no blast, a burst of one shot, a magazine you start empty.
// `speedMin` is the bottom of the car's HARD band, and 0 — "this car can be
// brought to a full stop" — is the setting every civilian ships with
// (cartypes.js's THE TWO SPEED BANDS), so it belongs here rather than with the
// positive-only fields the rest of the band sits in.
const NON_NEGATIVE_FIELDS = new Set([
  "speedMin", "minDistance", "weight", "damage", "blastRadius", "blastDamage",
  "contactDamage", "threat", "slowTime", "pierce", "burstCount",
  "burstInterval", "accel", "turnRate", "aimSlack", "ammo", "startAmmo",
]);

// `value` and `bounty` are deliberately in NEITHER set: a civilian is worth
// NEGATIVE score and negative credits (see cartypes.js), so a sign check here
// would reject the roster the game already ships.

// The three validators below are one rule applied to three catalogues, so the
// rule lives here once. Splitting them out as near-copies is how
// validateObstacleChanges came to be missing the POSITIVE_FIELDS check its two
// siblings performed — harmless only because OBSTACLE_FIELDS happens to contain
// no positive-only field today, which is exactly the kind of accident that
// stops being harmless the moment the catalogue grows one.
//
// `label` is the request-body key, and appears verbatim in the messages so a
// failure names the field the caller actually sent. `noun` names the entity in
// the "unknown ... id" message. `enums` maps a field to its permitted string
// values (only laneHome has any); anything not listed there must be a number.
// `crossCheck` runs last, for rules that need more than one field at once.
function validateEntityChanges(value, { label, noun, ids, fields, enums = {}, crossCheck = null }) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`body.${label} must be an object`);
  }
  if (Object.keys(value).length === 0) {
    throw new Error(`body.${label} must not be empty`);
  }
  for (const [id, entry] of Object.entries(value)) {
    if (!ids.includes(id)) {
      throw new Error(`unknown ${noun} id "${id}"`);
    }
    if (!entry || typeof entry !== "object" || Object.keys(entry).length === 0) {
      throw new Error(`${label} for "${id}" must be a non-empty object`);
    }
    for (const [field, fieldValue] of Object.entries(entry)) {
      if (!fields.includes(field)) {
        throw new Error(`unknown field "${field}" for "${id}"`);
      }
      const allowed = enums[field];
      if (allowed) {
        if (!allowed.includes(fieldValue)) {
          throw new Error(`invalid ${field} value for "${id}": ${JSON.stringify(fieldValue)}`);
        }
      } else if (typeof fieldValue !== "number" || !Number.isFinite(fieldValue)) {
        throw new Error(
          `field "${field}" for "${id}" must be a finite number, got ${JSON.stringify(fieldValue)}`
        );
      } else if (POSITIVE_FIELDS.has(field) && fieldValue <= 0) {
        throw new Error(
          `field "${field}" for "${id}" must be a positive number, got ${JSON.stringify(fieldValue)}`
        );
      } else if (NON_NEGATIVE_FIELDS.has(field) && fieldValue < 0) {
        throw new Error(
          `field "${field}" for "${id}" must not be negative, got ${JSON.stringify(fieldValue)}`
        );
      }
    }
    if (crossCheck) crossCheck(entry, id);
  }
}

const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

export function validateChanges(changes) {
  validateEntityChanges(changes, {
    label: "changes",
    noun: "car",
    ids: CAR_IDS,
    fields: [...CAR_TYPE_FIELDS, ...BEHAVIOR_FIELDS],
    enums: { laneHome: ["any", "inner", "outer"] },
    // The speed ordering has to hold AFTER the edit lands, which is not the
    // same as "the submitted fields are valid among themselves": editing
    // cruiseMax alone, down past the cruiseMin already in the source, used to
    // sail through because this check only fired when one request carried both.
    // Whichever of the four the request does not name is read from the current
    // source instead, and tagged in the message so the number's origin is
    // obvious.
    //
    // FOUR FIELDS, THREE RELATIONS — the two bands of cartypes.js, nested:
    // speedMin <= cruiseMin says a car may not be rolled below what it is
    // capable of, cruiseMin <= cruiseMax is the old range check, and
    // cruiseMax <= speedMax says the cruise band may not reach over the hard
    // ceiling. Checked in that order so the message names the pair that
    // actually broke.
    crossCheck(fields, carId) {
      const SPEEDS = ["speedMin", "cruiseMin", "cruiseMax", "speedMax"];
      if (!SPEEDS.some((f) => has(fields, f))) return;
      const current = buildCarState(carId).values;
      const tag = (f) => (has(fields, f) ? "" : ", unchanged");
      const value = (f) => (has(fields, f) ? fields[f] : current[f]);
      for (const [lo, hi] of [
        ["speedMin", "cruiseMin"],
        ["cruiseMin", "cruiseMax"],
        ["cruiseMax", "speedMax"],
      ]) {
        if (value(hi) < value(lo)) {
          throw new Error(
            `${hi} (${value(hi)}${tag(hi)}) must be >= ` +
              `${lo} (${value(lo)}${tag(lo)}) for "${carId}"`
          );
        }
      }
    },
  });
}

export function validateObstacleChanges(obstacleChanges) {
  validateEntityChanges(obstacleChanges, {
    label: "obstacleChanges",
    noun: "obstacle",
    ids: OBSTACLE_IDS,
    fields: OBSTACLE_FIELDS,
  });
}

export function validatePickupChanges(pickupChanges) {
  validateEntityChanges(pickupChanges, {
    label: "pickupChanges",
    noun: "pickup",
    ids: PICKUP_IDS,
    fields: [...PICKUP_SPAWN_FIELDS, ...PICKUP_EFFECT_FIELDS],
  });
}

// The shop's two shelves get their own validators for the same reason
// state.js builds their state separately: a CONSUMABLE's editable fields are
// price plus whichever single effect field its `kind` uses (amount or
// duration — mirroring a pickup crate exactly), while a STAT's are price and
// step, full stop. Letting either accept the other's fields would let a
// request write `step` onto a consumable, which upgrades.js's patcher would
// happily do and the game would then silently never read.
export function validateUpgradeConsumableChanges(changes) {
  validateEntityChanges(changes, {
    label: "upgradeConsumableChanges",
    noun: "shop consumable",
    ids: UPGRADE_CONSUMABLE_IDS,
    // Both possible effect fields are accepted here — server-side validation
    // does not know a given id's `kind` without importing the catalogue a
    // second time, and a request naming the WRONG one for a given row (e.g.
    // `duration` on an ammo row) fails downstream in patchUpgradeEntry, which
    // already throws "field not found on entry" for exactly this case.
    fields: ["price", "amount", "duration"],
  });
}

export function validateUpgradeStatChanges(changes) {
  validateEntityChanges(changes, {
    label: "upgradeStatChanges",
    noun: "shop stat",
    ids: UPGRADE_STAT_IDS,
    fields: ["price", "step"],
  });
}

// Weapons carry only SOME of the fields WEAPON_FIELDS names — the mine layer
// has no `damage`, only the rocket steers — so a request naming a field this
// weapon does not have is rejected against the entry itself rather than
// against the union. Without that, `turnRate` on a cannon would pass here and
// fail downstream in patchWeaponType with a less obvious message.
export function validateWeaponChanges(weaponChanges) {
  validateEntityChanges(weaponChanges, {
    label: "weaponChanges",
    noun: "weapon",
    ids: WEAPON_IDS,
    fields: WEAPON_FIELDS,
    crossCheck(fields, weaponId) {
      const weapon = buildWeaponState(weaponId);
      for (const field of Object.keys(fields)) {
        if (!(field in weapon.values)) {
          throw new Error(
            `weapon "${weaponId}" has no "${field}" to tune` +
              (field === "ammo" && weapon.unlimitedAmmo
                ? ` — its ammo is unlimited on purpose, and turning the endless gun into a magazine is a design change, not a tuning one`
                : "")
          );
        }
      }
      // You cannot start with more rounds than the magazine holds. Checked
      // against the source for whichever side the request leaves out, the same
      // way the cars' speed range is.
      const ammo = has(fields, "ammo") ? fields.ammo : weapon.values.ammo;
      const startAmmo = has(fields, "startAmmo") ? fields.startAmmo : weapon.values.startAmmo;
      if (Number.isFinite(ammo) && Number.isFinite(startAmmo) && startAmmo > ammo) {
        throw new Error(
          `startAmmo (${startAmmo}) must be <= ammo (${ammo}) for "${weaponId}"`
        );
      }
    },
  });
}

// Constants are not entities — each one IS a single number, so the request
// shape is flat (`{ "player.MAX_SPEED": 700 }`) and validateEntityChanges,
// which is built around "an id with a bag of fields", does not fit. Bounds
// come from the catalogue entry itself rather than from the shared
// POSITIVE/NON_NEGATIVE sets, because what counts as sane is per-constant:
// ROAD_STRAIGHTNESS below 1 is meaningless, MAX_CARS below 1 empties the road.
export function validateConstantChanges(constantChanges) {
  if (!constantChanges || typeof constantChanges !== "object" || Array.isArray(constantChanges)) {
    throw new Error("body.constantChanges must be an object");
  }
  if (Object.keys(constantChanges).length === 0) {
    throw new Error("body.constantChanges must not be empty");
  }
  for (const [id, value] of Object.entries(constantChanges)) {
    if (!CONSTANT_IDS.includes(id)) {
      throw new Error(`unknown constant id "${id}"`);
    }
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new Error(
        `constant "${id}" must be a finite number, got ${JSON.stringify(value)}`
      );
    }
    const { min } = CONSTANT_BY_ID.get(id);
    if (min !== undefined && value < min) {
      throw new Error(`constant "${id}" must be >= ${min}, got ${value}`);
    }
  }
}

function commitMessage(body) {
  const lines = ["Tune car, weapon, hazard, shop and world parameters via the tuning editor", ""];

  for (const [carId, fields] of Object.entries(body.changes ?? {})) {
    for (const [field, value] of Object.entries(fields)) {
      // Behavior fields land on a shared driving profile, not on the car —
      // name the profile (and anyone else on it) so the commit log says what
      // the diff will actually show.
      const scope = BEHAVIOR_FIELDS.includes(field) ? drivingProfileScope(carId) : null;
      const suffix = scope
        ? ` (${scope.name} profile${scope.sharedWith.length ? `, also ${scope.sharedWith.join(", ")}` : ""})`
        : "";
      lines.push(`- ${carId}: ${field} -> ${value}${suffix}`);
    }
  }

  for (const key of [
    "obstacleChanges", "pickupChanges", "weaponChanges",
    "upgradeConsumableChanges", "upgradeStatChanges",
  ]) {
    for (const [id, fields] of Object.entries(body[key] ?? {})) {
      for (const [field, value] of Object.entries(fields)) {
        lines.push(`- ${id}: ${field} -> ${value}`);
      }
    }
  }

  // Constants are flat — the id already names the thing being set.
  for (const [id, value] of Object.entries(body.constantChanges ?? {})) {
    lines.push(`- ${id} -> ${value}`);
  }

  return lines.join("\n");
}

const TEST_DIR_REL = "test";

// The test files, listed by reading the directory rather than by handing the
// runner a pattern to expand.
//
// This used to pass `test/*.test.js` straight to execFile, which spawns without
// a shell — so nothing ever expanded that glob except `node --test` itself, and
// it only learned to do that in Node 21. On Node 20 the runner reported
// `Could not find '<repo>\test\*.test.js'`, which the UI then showed as a
// failing test run: every tuning attempt looked broken on an otherwise green
// tree. (It read as working during development only because the same command
// typed at a shell prompt gets its glob expanded by the shell first, so the
// runner never sees the pattern.)
//
// An explicit list has no version-dependent expansion behind it at all, on any
// Node and on any platform.
export async function testFiles() {
  const entries = await readdir(path.join(REPO_ROOT, TEST_DIR_REL));
  return entries
    .filter((name) => name.endsWith(".test.js"))
    .sort()
    .map((name) => `${TEST_DIR_REL}/${name}`);
}

// The runner prints a couple of thousand lines for a green suite, and on a red
// one the handful that matter are buried in the middle of it. This pulls out
// each `not ok` entry together with the indented YAML block under it, so the UI
// can lead with what actually broke rather than with a wall of `ok`.
//
// TAP's own shape does the work: a result line is unindented, and everything
// belonging to it is indented beneath.
export function failingTests(tapOutput) {
  const lines = tapOutput.split(/\r?\n/);
  const failures = [];
  for (let i = 0; i < lines.length; i++) {
    if (!/^not ok \d+ - /.test(lines[i])) continue;
    const block = [lines[i]];
    let j = i + 1;
    while (j < lines.length && (lines[j] === "" || /^\s/.test(lines[j]))) {
      block.push(lines[j]);
      j++;
    }
    // Trim the blank lines a block may have swallowed on its way to the next
    // result line.
    while (block.length > 0 && block[block.length - 1].trim() === "") block.pop();
    failures.push(block.join("\n"));
  }
  return failures;
}

export async function runTests() {
  let files;
  try {
    files = await testFiles();
  } catch (err) {
    return { passed: false, output: `could not list ${TEST_DIR_REL}/: ${err.message}` };
  }
  // No test files is not a pass. Reporting one would turn "the suite went
  // missing" into a silent green light, which is the same failure mode the glob
  // bug above had, only inverted.
  if (files.length === 0) {
    return { passed: false, output: `no *.test.js files found in ${TEST_DIR_REL}/` };
  }
  return new Promise((resolve) => {
    execFile("node", ["--test", ...files], { cwd: REPO_ROOT }, (error, stdout, stderr) => {
      const output = `${stdout}\n${stderr}`;
      resolve({ passed: !error, output, failures: failingTests(output) });
    });
  });
}

// Every kind of change the API accepts, and the validator that guards it.
// Listed once so the "did you send anything at all" check, the validation pass
// and the error message naming the acceptable keys can never fall out of step —
// which they had already started to, each new catalogue having added a third
// place to remember.
const CHANGE_KINDS = [
  { key: "changes", validate: (v) => validateChanges(v) },
  { key: "obstacleChanges", validate: (v) => validateObstacleChanges(v) },
  { key: "pickupChanges", validate: (v) => validatePickupChanges(v) },
  { key: "weaponChanges", validate: (v) => validateWeaponChanges(v) },
  { key: "upgradeConsumableChanges", validate: (v) => validateUpgradeConsumableChanges(v) },
  { key: "upgradeStatChanges", validate: (v) => validateUpgradeStatChanges(v) },
  { key: "constantChanges", validate: (v) => validateConstantChanges(v) },
];

function hasEntries(value) {
  return Boolean(value) && typeof value === "object" && Object.keys(value).length > 0;
}

// Applies every change in `body` to the in-memory file set. Throws on anything
// the source cannot honour; nothing reaches disk until this has returned
// cleanly for the whole request.
export function applyChanges(body, files) {
  // Hull/speed/spawn/reward fields belong to ONE car and are patched per car.
  // Behavior fields belong to a DRIVING PROFILE, which several cars can share
  // (VAN and BUS both drive "hauler"; every car without its own profile falls
  // back to "commuter"), so they are collected per profile first and each
  // profile is patched exactly once.
  //
  // Patching per car, as this used to, was wrong twice over: two cars sharing
  // a profile produced two patches of the same block against the accumulating
  // text, so the second silently overwrote the first, and a car with no
  // `driving` key passed `undefined` as the profile name.
  const behaviorByProfile = new Map(); // profileName -> { field: { value, carId } }
  for (const [carId, fields] of Object.entries(body.changes ?? {})) {
    const typeChanges = {};
    for (const [field, value] of Object.entries(fields)) {
      if (CAR_TYPE_FIELDS.includes(field)) {
        typeChanges[field] = value;
        continue;
      }
      const profileName = drivingProfileNameFor(carId);
      if (!behaviorByProfile.has(profileName)) behaviorByProfile.set(profileName, {});
      const bucket = behaviorByProfile.get(profileName);
      const claimed = bucket[field];
      // Two cars on one profile asking for two different values is not
      // something a patch can honour — one of them would have to lose. Say so
      // instead of picking a winner silently.
      if (claimed && claimed.value !== value) {
        throw new Error(
          `"${carId}" and "${claimed.carId}" share the "${profileName}" driving profile, so ` +
            `they cannot set different "${field}" values in one change ` +
            `(${value} vs ${claimed.value}) — edit one of them, or give both the same value`
        );
      }
      bucket[field] = { value, carId };
    }
    if (Object.keys(typeChanges).length > 0) {
      editFile(files, CARTYPES_REL, (text) => patchCarType(text, carId, typeChanges));
    }
  }
  for (const [profileName, bucket] of behaviorByProfile) {
    const behaviorChanges = {};
    for (const [field, { value }] of Object.entries(bucket)) behaviorChanges[field] = value;
    editFile(files, DRIVING_REL, (text) =>
      patchDrivingProfile(text, profileName, behaviorChanges)
    );
  }

  for (const [id, fields] of Object.entries(body.obstacleChanges ?? {})) {
    editFile(files, OBSTACLETYPES_REL, (text) => patchObstacleType(text, id, fields));
  }
  for (const [id, fields] of Object.entries(body.pickupChanges ?? {})) {
    editFile(files, PICKUPTYPES_REL, (text) => patchPickupType(text, id, fields));
  }
  // Both weapon arrays live in weapons.js, and both shop shelves live in
  // upgrades.js — each editFile call folds onto the running text for that file,
  // so two shelves (or the player's kit and the hostiles') never overwrite one
  // another.
  for (const [id, fields] of Object.entries(body.weaponChanges ?? {})) {
    editFile(files, WEAPONS_REL, (text) => patchWeaponType(text, id, fields));
  }
  for (const key of ["upgradeConsumableChanges", "upgradeStatChanges"]) {
    for (const [id, fields] of Object.entries(body[key] ?? {})) {
      editFile(files, UPGRADES_REL, (text) => patchUpgradeEntry(text, id, fields));
    }
  }

  // Constants reach into whichever module declares them — including
  // upgrades.js, whose tier-price ladder is an array element rather than a
  // standalone declaration.
  for (const [id, value] of Object.entries(body.constantChanges ?? {})) {
    const entry = CONSTANT_BY_ID.get(id);
    editFile(files, entry.file, (text) =>
      entry.index === undefined
        ? patchConstant(text, entry.name, value)
        : patchArrayConstantElement(text, entry.name, entry.index, value)
    );
  }
}

async function handleCommit(req, res) {
  let body;
  try {
    body = await readBody(req);
    const sent = CHANGE_KINDS.filter(({ key }) => hasEntries(body[key]));
    if (sent.length === 0) {
      throw new Error(
        `request must include at least one of ${CHANGE_KINDS.map((k) => k.key).join(", ")}`
      );
    }
    for (const { key, validate } of sent) validate(body[key]);
  } catch (err) {
    sendJson(res, 400, { error: err.message });
    return;
  }

  if (pending) {
    sendJson(res, 409, { error: "a tuning attempt is already in flight — push or cancel it first" });
    return;
  }

  const files = await loadTouchedFiles();
  try {
    applyChanges(body, files);
  } catch (err) {
    sendJson(res, 400, { error: err.message });
    return;
  }

  const dirty = await git.dirtyTrackedFiles(REPO_ROOT, TOUCHED_FILES);
  if (dirty.length > 0) {
    sendJson(res, 409, { error: `uncommitted changes already present: ${dirty.join(", ")}` });
    return;
  }

  const originalBranch = await git.currentBranch(REPO_ROOT);
  const branchName = git.timestampBranchName();

  try {
    await git.createBranch(REPO_ROOT, branchName);

    const changedRelPaths = [];
    for (const [rel, entry] of files) {
      if (!entry.changed) continue;
      await writeFile(path.join(REPO_ROOT, rel), entry.text, "utf8");
      changedRelPaths.push(rel);
    }

    await git.commitFiles(REPO_ROOT, changedRelPaths, commitMessage(body));
  } catch (err) {
    try {
      await git.checkoutBranch(REPO_ROOT, originalBranch);
      await git.deleteBranch(REPO_ROOT, branchName);
    } catch (cleanupErr) {
      // Best-effort cleanup; if even this fails, the branch is left for the
      // user to sort out manually rather than masking the original error.
      // Logged (not surfaced in the response) so it isn't a silent leak of
      // partial state — the user finds out from the console, not by stumbling
      // on `car-editor-*` cruft in `git branch` later.
      console.error(`cleanup after commit failure also failed on branch "${branchName}":`, cleanupErr);
    }
    sendJson(res, 500, { error: err.message });
    return;
  }

  const { passed, output, failures } = await runTests();
  pending = { branchName, originalBranch };
  sendJson(res, 200, {
    branch: branchName,
    testsPassed: passed,
    testOutput: output,
    testFailures: failures ?? [],
  });
}

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
  try {
    await git.checkoutBranch(REPO_ROOT, originalBranch);
    await git.deleteBranch(REPO_ROOT, branchName);
  } catch (err) {
    // Clear the lock even on failure: leaving `pending` set here would wedge
    // every future /api/commit (409) and /api/cancel (this same failure)
    // behind a stuck lock with no in-app way to clear it — the only escape
    // would be restarting the server. Logging (not the response) is where
    // the "something's off, go check `git status`" signal belongs.
    pending = null;
    console.error(`cancel failed to clean up branch "${branchName}":`, err);
    sendJson(res, 500, { error: err.message });
    return;
  }
  pending = null;
  sendJson(res, 200, { ok: true });
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
    if (req.method === "POST" && req.url === "/api/commit") return await handleCommit(req, res);
    if (req.method === "POST" && req.url === "/api/push") return await handlePush(res);
    if (req.method === "POST" && req.url === "/api/cancel") return await handleCancel(res);
    if (req.method === "GET") return await serveStatic(req, res);
    res.writeHead(405);
    res.end("Method not allowed");
  } catch (err) {
    sendJson(res, 500, { error: err.message });
  }
});

// Only auto-start when run directly (`node tools/car-editor/server.js`, as
// edit.bat does) — not when this module is imported (e.g. by tests that just
// want validateChanges), which would otherwise bind a real socket and shell
// out to git as a side effect of importing.
const isMainModule = process.argv[1] && path.resolve(process.argv[1]) === __filename;

if (isMainModule) {
  execFile("git", ["--version"], (error) => {
    if (error) {
      console.error("git was not found on PATH. Install Git before running the tuning editor.");
      process.exit(1);
    }
    server.listen(PORT, "127.0.0.1", () => {
      console.log(`Tuning editor running at http://localhost:${PORT}`);
    });
  });
}
