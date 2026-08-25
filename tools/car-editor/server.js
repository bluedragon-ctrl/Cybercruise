// tools/car-editor/server.js
//
// Local HTTP server for the enemy car editor: serves the editor UI and its
// API. Started via edit.bat, or directly with `node tools/car-editor/server.js`.
// Requires git on PATH — see the startup check at the bottom of this file.

import http from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";

import {
  buildAllCarState,
  buildAllObstacleState,
  buildAllPickupState,
  buildAllUpgradeConsumableState,
  buildAllUpgradeStatState,
  CAR_IDS,
  BEHAVIOR_FIELDS,
  HULL_SPEED_FIELDS,
  SPAWN_FIELDS,
  OBSTACLE_IDS,
  OBSTACLE_FIELDS,
  PICKUP_IDS,
  PICKUP_SPAWN_FIELDS,
  PICKUP_EFFECT_FIELDS,
  UPGRADE_CONSUMABLE_IDS,
  UPGRADE_STAT_IDS,
} from "./state.js";
import {
  patchCarType,
  patchDrivingProfile,
  patchObstacleType,
  patchPickupType,
  patchUpgradeEntry,
} from "./patcher.js";
import * as git from "./git.js";
import { carTypeById } from "../../src/game/cartypes.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "../..");

const CARTYPES_REL = "src/game/cartypes.js";
const DRIVING_REL = "src/game/driving.js";
const OBSTACLETYPES_REL = "src/game/obstacletypes.js";
const PICKUPTYPES_REL = "src/game/pickuptypes.js";
const UPGRADES_REL = "src/game/upgrades.js";
const CARTYPES_PATH = path.join(REPO_ROOT, CARTYPES_REL);
const DRIVING_PATH = path.join(REPO_ROOT, DRIVING_REL);
const OBSTACLETYPES_PATH = path.join(REPO_ROOT, OBSTACLETYPES_REL);
const PICKUPTYPES_PATH = path.join(REPO_ROOT, PICKUPTYPES_REL);
const UPGRADES_PATH = path.join(REPO_ROOT, UPGRADES_REL);

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
  sendJson(res, 200, {
    cars: buildAllCarState(),
    obstacles: buildAllObstacleState(),
    pickups: buildAllPickupState(),
    upgradeConsumables: buildAllUpgradeConsumableState(),
    upgradeStats: buildAllUpgradeStatState(),
  });
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}

// Fields that must be strictly positive numbers, beyond just finite. Applied
// after the generic finite-number check below, and also cross-checked as a
// pair (speedMax >= speedMin) when a single request touches both — catching
// nonsensical values like `health: -50` or an inverted speed range at the
// boundary, rather than relying on downstream game-invariant tests to notice.
//
// `price` and `step` join the set for the shop's own catalogue: a free or
// negatively-priced row is a bug, not a sale, and a step of 0 or less is a
// tier that buys nothing (or moves a stat backwards), neither of which
// upgrades.js's own ladder logic accounts for.
export const POSITIVE_FIELDS = new Set([
  "health", "speedMin", "speedMax", "amount", "duration", "price", "step",
]);

// minDistance is a gate, not a magnitude — 0 ("from the first metre", see
// cartypes.js) is its most common and entirely valid value, so it only rules
// out negative distances rather than joining POSITIVE_FIELDS above. An
// obstacle's `weight` joins it for the same reason: 0 is how you take a
// hazard out of the draw entirely without deleting its entry.
const NON_NEGATIVE_FIELDS = new Set(["minDistance", "weight"]);

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
    fields: [...HULL_SPEED_FIELDS, ...SPAWN_FIELDS, ...BEHAVIOR_FIELDS],
    enums: { laneHome: ["any", "inner", "outer"] },
    crossCheck(fields, carId) {
      if (has(fields, "speedMin") && has(fields, "speedMax") && fields.speedMax < fields.speedMin) {
        throw new Error(
          `speedMax (${fields.speedMax}) must be >= speedMin (${fields.speedMin}) for "${carId}"`
        );
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

function commitMessage(changes, obstacleChanges, pickupChanges, upgradeChanges) {
  const lines = ["Tune car, obstacle, pickup and shop parameters via the car editor", ""];
  for (const [carId, fields] of Object.entries(changes ?? {})) {
    for (const [field, value] of Object.entries(fields)) {
      lines.push(`- ${carId}: ${field} -> ${value}`);
    }
  }
  for (const [obstacleId, fields] of Object.entries(obstacleChanges ?? {})) {
    for (const [field, value] of Object.entries(fields)) {
      lines.push(`- ${obstacleId}: ${field} -> ${value}`);
    }
  }
  for (const [pickupId, fields] of Object.entries(pickupChanges ?? {})) {
    for (const [field, value] of Object.entries(fields)) {
      lines.push(`- ${pickupId}: ${field} -> ${value}`);
    }
  }
  for (const [upgradeId, fields] of Object.entries(upgradeChanges ?? {})) {
    for (const [field, value] of Object.entries(fields)) {
      lines.push(`- ${upgradeId}: ${field} -> ${value}`);
    }
  }
  return lines.join("\n");
}

function runTests() {
  return new Promise((resolve) => {
    // NOTE: `node --test test/` (a bare directory arg, matching package.json's
    // own "test" script) fails with MODULE_NOT_FOUND on this machine's
    // Node v24.14.0 — reproduced even outside this repo, so it's a Node/npm
    // compatibility issue, not something introduced here. The glob form
    // below is what actually works and is otherwise equivalent.
    execFile("node", ["--test", "test/*.test.js"], { cwd: REPO_ROOT }, (error, stdout, stderr) => {
      resolve({ passed: !error, output: `${stdout}\n${stderr}` });
    });
  });
}

async function handleCommit(req, res) {
  let body;
  try {
    body = await readBody(req);
    const hasCarChanges = body.changes && Object.keys(body.changes).length > 0;
    const hasObstacleChanges = body.obstacleChanges && Object.keys(body.obstacleChanges).length > 0;
    const hasPickupChanges = body.pickupChanges && Object.keys(body.pickupChanges).length > 0;
    // The shop's two shelves arrive as two separate keys, exactly as
    // obstacles and pickups do — one per catalogue, matching state.js's own
    // split rather than merged into a single "upgradeChanges" the server
    // would then have to re-sort by shelf.
    const hasUpgradeConsumableChanges =
      body.upgradeConsumableChanges && Object.keys(body.upgradeConsumableChanges).length > 0;
    const hasUpgradeStatChanges =
      body.upgradeStatChanges && Object.keys(body.upgradeStatChanges).length > 0;
    if (
      !hasCarChanges && !hasObstacleChanges && !hasPickupChanges &&
      !hasUpgradeConsumableChanges && !hasUpgradeStatChanges
    ) {
      throw new Error(
        "request must include at least one of changes, obstacleChanges, pickupChanges, " +
          "upgradeConsumableChanges or upgradeStatChanges"
      );
    }
    if (hasCarChanges) validateChanges(body.changes);
    if (hasObstacleChanges) validateObstacleChanges(body.obstacleChanges);
    if (hasPickupChanges) validatePickupChanges(body.pickupChanges);
    if (hasUpgradeConsumableChanges) validateUpgradeConsumableChanges(body.upgradeConsumableChanges);
    if (hasUpgradeStatChanges) validateUpgradeStatChanges(body.upgradeStatChanges);
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
  let obstaclesText = await readFile(OBSTACLETYPES_PATH, "utf8");
  let pickupsText = await readFile(PICKUPTYPES_PATH, "utf8");
  let upgradesText = await readFile(UPGRADES_PATH, "utf8");
  let cartypesChanged = false;
  let drivingChanged = false;
  let obstaclesChanged = false;
  let pickupsChanged = false;
  let upgradesChanged = false;

  try {
    for (const [carId, fields] of Object.entries(body.changes ?? {})) {
      const type = carTypeById(carId);
      const hullSpeedChanges = {};
      const behaviorChanges = {};
      for (const [field, value] of Object.entries(fields)) {
        if (HULL_SPEED_FIELDS.includes(field) || SPAWN_FIELDS.includes(field)) {
          hullSpeedChanges[field] = value;
        } else {
          behaviorChanges[field] = value;
        }
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
    for (const [obstacleId, fields] of Object.entries(body.obstacleChanges ?? {})) {
      obstaclesText = patchObstacleType(obstaclesText, obstacleId, fields);
      obstaclesChanged = true;
    }
    for (const [pickupId, fields] of Object.entries(body.pickupChanges ?? {})) {
      pickupsText = patchPickupType(pickupsText, pickupId, fields);
      pickupsChanged = true;
    }
    // Both shelves patch the SAME FILE, so both loops accumulate onto one
    // running `upgradesText` before it is written once below — patching
    // twice against the original text would silently drop whichever shelf's
    // edit ran first.
    for (const [id, fields] of Object.entries(body.upgradeConsumableChanges ?? {})) {
      upgradesText = patchUpgradeEntry(upgradesText, id, fields);
      upgradesChanged = true;
    }
    for (const [id, fields] of Object.entries(body.upgradeStatChanges ?? {})) {
      upgradesText = patchUpgradeEntry(upgradesText, id, fields);
      upgradesChanged = true;
    }
  } catch (err) {
    sendJson(res, 400, { error: err.message });
    return;
  }

  const dirty = await git.dirtyTrackedFiles(REPO_ROOT, [
    CARTYPES_REL, DRIVING_REL, OBSTACLETYPES_REL, PICKUPTYPES_REL, UPGRADES_REL,
  ]);
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
    if (obstaclesChanged) {
      await writeFile(OBSTACLETYPES_PATH, obstaclesText, "utf8");
      changedRelPaths.push(OBSTACLETYPES_REL);
    }
    if (pickupsChanged) {
      await writeFile(PICKUPTYPES_PATH, pickupsText, "utf8");
      changedRelPaths.push(PICKUPTYPES_REL);
    }
    if (upgradesChanged) {
      await writeFile(UPGRADES_PATH, upgradesText, "utf8");
      changedRelPaths.push(UPGRADES_REL);
    }

    const upgradeChangesForMessage = {
      ...(body.upgradeConsumableChanges ?? {}),
      ...(body.upgradeStatChanges ?? {}),
    };
    await git.commitFiles(
      REPO_ROOT,
      changedRelPaths,
      commitMessage(body.changes, body.obstacleChanges, body.pickupChanges, upgradeChangesForMessage)
    );
  } catch (err) {
    try {
      await git.checkoutBranch(REPO_ROOT, originalBranch);
      await git.deleteBranch(REPO_ROOT, branchName);
    } catch (cleanupErr) {
      // Best-effort cleanup; if even this fails, the branch is left for the
      // user to sort out manually rather than masking the original error.
      // Logged (not surfaced in the response) so it isn't a silent leak of
      // partial state — the user finds out from the console, not by
      // stumbling on `car-editor-*` cruft in `git branch` later.
      console.error(`cleanup after commit failure also failed on branch "${branchName}":`, cleanupErr);
    }
    sendJson(res, 500, { error: err.message });
    return;
  }

  const { passed, output } = await runTests();
  pending = { branchName, originalBranch };
  sendJson(res, 200, { branch: branchName, testsPassed: passed, testOutput: output });
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
      console.error("git was not found on PATH. Install Git before running the car editor.");
      process.exit(1);
    }
    server.listen(PORT, "127.0.0.1", () => {
      console.log(`Car editor running at http://localhost:${PORT}`);
    });
  });
}
