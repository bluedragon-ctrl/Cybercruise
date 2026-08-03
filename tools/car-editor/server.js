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

import { buildAllCarState, ENEMY_IDS, BEHAVIOR_FIELDS, HULL_SPEED_FIELDS } from "./state.js";
import { patchCarType, patchDrivingProfile } from "./patcher.js";
import * as git from "./git.js";
import { carTypeById } from "../../src/game/cartypes.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../..");

const CARTYPES_REL = "src/game/cartypes.js";
const DRIVING_REL = "src/game/driving.js";
const CARTYPES_PATH = path.join(REPO_ROOT, CARTYPES_REL);
const DRIVING_PATH = path.join(REPO_ROOT, DRIVING_REL);

// The single tuning attempt in flight, if any. This is a local, one-user
// tool — there is never more than one browser tab driving it in practice —
// so module-level state is enough; no session/locking machinery needed.
let pending = null; // { branchName, originalBranch }

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
    for (const [field, value] of Object.entries(fields)) {
      if (!HULL_SPEED_FIELDS.includes(field) && !BEHAVIOR_FIELDS.includes(field)) {
        throw new Error(`unknown field "${field}" for "${carId}"`);
      }
      if (field === "laneHome") {
        if (!["any", "inner", "outer"].includes(value)) {
          throw new Error(`invalid laneHome value for "${carId}": ${JSON.stringify(value)}`);
        }
      } else if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new Error(`field "${field}" for "${carId}" must be a finite number, got ${JSON.stringify(value)}`);
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
  server.listen(PORT, "127.0.0.1", () => {
    console.log(`Car editor running at http://localhost:${PORT}`);
  });
});
