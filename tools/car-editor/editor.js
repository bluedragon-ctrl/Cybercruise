// tools/car-editor/editor.js
//
// Vanilla-JS UI: fetch the roster's current values — cars AND obstacles —
// let the user tune hull/speed/spawn/behavior fields with a plain-English
// description of what each one does, show a diff before anything is
// written, then drive the commit/test/push flow (added in Task 14-15).

const FIELD_DESCRIPTIONS = {
  health: "Hull points. Spent by ramming, explosions, and weapons; the car is destroyed at zero.",
  speedMin: "Slowest cruising speed this car will roll at when it spawns, in world units/sec.",
  speedMax: "Fastest cruising speed this car will roll at when it spawns, in world units/sec.",
  minDistance: 'How far the player must have driven before this car can spawn at all, in DIST-readout units (the same number the HUD shows). 0 means it can appear from the very first metre.',

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
  spawn: ["minDistance"],
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

// Obstacles have no driving-profile split (see state.js) — just the two
// spawn-tuning fields the catalogue itself calls "weight" and "minDistance".
// "weight" is described here as "chance" because that's what it decides —
// the game code's own name for it stays in the label so it's still
// recognisable against obstacletypes.js.
const OBSTACLE_FIELD_DESCRIPTIONS = {
  weight: "Relative spawn chance among the obstacle types currently unlocked — bigger means more common, not a fixed probability. 0 takes this type out of the draw entirely.",
  minDistance: "How far the player must have driven before this obstacle can spawn at all, in DIST-readout units (the same number the HUD shows). 0 means it can appear from the very first metre.",
};

const OBSTACLE_FIELD_ORDER = ["weight", "minDistance"];

// Pickups (see state.js) share the exact same weight/minDistance spawn shape
// as obstacles, just described in terms of buff crates rather than hazards.
const PICKUP_FIELD_DESCRIPTIONS = {
  weight: "Relative spawn chance among the pickup types currently unlocked — bigger means more common, not a fixed probability. 0 takes this type out of the draw entirely.",
  minDistance: "How far the player must have driven before this pickup can spawn at all, in DIST-readout units (the same number the HUD shows). 0 means it can appear from the very first metre.",
};

const PICKUP_FIELD_ORDER = ["weight", "minDistance"];

// The payload a crate grants isn't the same field for every kind (see
// state.js's header on PICKUP_EFFECT_FIELDS) — this picks which single field
// applies to a given pickup's `kind`, and what it means in that context.
const PICKUP_EFFECT_FIELD_BY_KIND = {
  ammo: "amount",
  heal: "amount",
  shield: "duration",
};

const PICKUP_EFFECT_DESCRIPTIONS = {
  ammo: "Ammo added to the matching weapon's magazine when this crate is picked up.",
  heal: "Hull points restored when this crate is picked up, capped at the player's max health.",
  shield: "Seconds of invulnerability granted when this crate is picked up.",
};

let cars = [];
let obstacles = [];
let pickups = [];
let selection = null; // { kind: "car" | "obstacle" | "pickup", id }
const pendingChanges = {}; // { carId: { field: value } }
const pendingObstacleChanges = {}; // { obstacleId: { field: value } }
const pendingPickupChanges = {}; // { pickupId: { field: value } }

async function loadState() {
  const res = await fetch("/api/state");
  const data = await res.json();
  cars = data.cars;
  obstacles = data.obstacles;
  pickups = data.pickups;
}

function fieldValue(car, field) {
  if (field in car.hull) return car.hull[field];
  if (field in car.speed) return car.speed[field];
  if (field in car.spawn) return car.spawn[field];
  return car.behavior[field].value;
}

function isOverridden(car, field) {
  if (field in car.hull || field in car.speed || field in car.spawn) return true;
  return !car.behavior[field].inherited;
}

// Escapes text for safe interpolation into an innerHTML template string.
// (showStatus() already uses textContent, which is safe by construction;
// this is only needed for the showStatusHtml() call sites.)
//
// The textContent -> innerHTML round-trip only escapes &, < and > (the
// characters that matter for plain text-node content); it leaves quote
// characters untouched. That's fine for the call sites that land in plain
// text (error messages, <pre>, <code>) but not for pushAttempt()'s success
// message, which also interpolates data.url inside href="..." — a bare "
// there would close the attribute early and let the rest of the string be
// parsed as markup. Escaping quotes too makes this safe in both an
// attribute-value context and a text-node context.
function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = String(str);
  return div.innerHTML.replaceAll('"', "&quot;").replaceAll("'", "&#39;");
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

function currentObstacleValue(obstacleId, field) {
  if (pendingObstacleChanges[obstacleId] && field in pendingObstacleChanges[obstacleId]) {
    return pendingObstacleChanges[obstacleId][field];
  }
  const obstacle = obstacles.find((o) => o.id === obstacleId);
  return obstacle.spawn[field];
}

function setObstacleChange(obstacleId, field, value) {
  pendingObstacleChanges[obstacleId] ??= {};
  pendingObstacleChanges[obstacleId][field] = value;
}

// A pickup's fields are split across two objects (spawn tuning vs. the
// payload it grants — see state.js), but callers just want "the value of
// this field on this pickup" without caring which side it lives on.
function pickupFieldValue(pickup, field) {
  if (field in pickup.spawn) return pickup.spawn[field];
  return pickup.effect[field];
}

function currentPickupValue(pickupId, field) {
  if (pendingPickupChanges[pickupId] && field in pendingPickupChanges[pickupId]) {
    return pendingPickupChanges[pickupId][field];
  }
  const pickup = pickups.find((p) => p.id === pickupId);
  return pickupFieldValue(pickup, field);
}

function setPickupChange(pickupId, field, value) {
  pendingPickupChanges[pickupId] ??= {};
  pendingPickupChanges[pickupId][field] = value;
}

const FACTION_GROUPS = [
  { faction: "enemy", heading: "Hostile" },
  { faction: "neutral", heading: "Civilian" },
];

function renderNav() {
  const nav = document.getElementById("car-list");
  nav.innerHTML = "";

  function addButton(label, kind, id) {
    const button = document.createElement("button");
    button.textContent = label;
    button.className = selection && selection.kind === kind && selection.id === id ? "selected" : "";
    button.addEventListener("click", () => {
      selection = { kind, id };
      renderNav();
      renderForm();
    });
    nav.appendChild(button);
  }

  for (const { faction, heading } of FACTION_GROUPS) {
    const group = cars.filter((car) => car.faction === faction);
    if (group.length === 0) continue;

    const headingEl = document.createElement("h3");
    headingEl.textContent = heading;
    nav.appendChild(headingEl);

    for (const car of group) addButton(car.label, "car", car.id);
  }

  if (obstacles.length > 0) {
    const headingEl = document.createElement("h3");
    headingEl.textContent = "Obstacles";
    nav.appendChild(headingEl);

    for (const obstacle of obstacles) addButton(obstacle.label, "obstacle", obstacle.id);
  }

  if (pickups.length > 0) {
    const headingEl = document.createElement("h3");
    headingEl.textContent = "Pickups";
    nav.appendChild(headingEl);

    for (const pickup of pickups) addButton(pickup.label, "pickup", pickup.id);
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

function makeObstacleField(obstacleId, field) {
  const wrapper = document.createElement("div");
  wrapper.className = "field";

  const label = document.createElement("label");
  label.textContent = field;
  wrapper.appendChild(label);

  const input = document.createElement("input");
  input.type = "number";
  input.step = "any";
  input.value = currentObstacleValue(obstacleId, field);
  input.addEventListener("change", () => {
    setObstacleChange(obstacleId, field, Number(input.value));
  });
  wrapper.appendChild(input);

  const description = document.createElement("div");
  description.className = "description";
  description.textContent = OBSTACLE_FIELD_DESCRIPTIONS[field];
  wrapper.appendChild(description);

  return wrapper;
}

// `description` is passed in rather than looked up by field name because
// "amount" means something different per pickup kind (see
// PICKUP_EFFECT_DESCRIPTIONS) — unlike weight/minDistance, whose meaning is
// the same for every pickup and can be looked up in PICKUP_FIELD_DESCRIPTIONS.
function makePickupField(pickupId, field, description) {
  const wrapper = document.createElement("div");
  wrapper.className = "field";

  const label = document.createElement("label");
  label.textContent = field;
  wrapper.appendChild(label);

  const input = document.createElement("input");
  input.type = "number";
  input.step = "any";
  input.value = currentPickupValue(pickupId, field);
  input.addEventListener("change", () => {
    setPickupChange(pickupId, field, Number(input.value));
  });
  wrapper.appendChild(input);

  const descriptionEl = document.createElement("div");
  descriptionEl.className = "description";
  descriptionEl.textContent = description;
  wrapper.appendChild(descriptionEl);

  return wrapper;
}

function renderForm() {
  const carSection = document.getElementById("car-form");
  const obstacleSection = document.getElementById("obstacle-form");
  const pickupSection = document.getElementById("pickup-form");

  if (!selection) {
    carSection.hidden = true;
    obstacleSection.hidden = true;
    pickupSection.hidden = true;
    return;
  }

  if (selection.kind === "obstacle") {
    carSection.hidden = true;
    pickupSection.hidden = true;
    obstacleSection.hidden = false;

    const obstacle = obstacles.find((o) => o.id === selection.id);
    document.getElementById("obstacle-form-title").textContent = obstacle.label;

    const spawnDiv = document.getElementById("obstacle-spawn-fields");
    spawnDiv.innerHTML = "";
    for (const field of OBSTACLE_FIELD_ORDER) spawnDiv.appendChild(makeObstacleField(obstacle.id, field));
    return;
  }

  if (selection.kind === "pickup") {
    carSection.hidden = true;
    obstacleSection.hidden = true;
    pickupSection.hidden = false;

    const pickup = pickups.find((p) => p.id === selection.id);
    document.getElementById("pickup-form-title").textContent = pickup.label;

    const effectDiv = document.getElementById("pickup-effect-fields");
    effectDiv.innerHTML = "";
    const effectField = PICKUP_EFFECT_FIELD_BY_KIND[pickup.kind];
    if (effectField) {
      effectDiv.appendChild(
        makePickupField(pickup.id, effectField, PICKUP_EFFECT_DESCRIPTIONS[pickup.kind])
      );
    }

    const spawnDiv = document.getElementById("pickup-spawn-fields");
    spawnDiv.innerHTML = "";
    for (const field of PICKUP_FIELD_ORDER) {
      spawnDiv.appendChild(makePickupField(pickup.id, field, PICKUP_FIELD_DESCRIPTIONS[field]));
    }
    return;
  }

  obstacleSection.hidden = true;
  pickupSection.hidden = true;
  carSection.hidden = false;

  const car = cars.find((c) => c.id === selection.id);
  document.getElementById("car-form-title").textContent = car.label;

  const hullDiv = document.getElementById("hull-fields");
  hullDiv.innerHTML = "";
  for (const field of FIELD_ORDER.hull) hullDiv.appendChild(makeField(car.id, field));

  const speedDiv = document.getElementById("speed-fields");
  speedDiv.innerHTML = "";
  for (const field of FIELD_ORDER.speed) speedDiv.appendChild(makeField(car.id, field));

  const spawnDiv = document.getElementById("spawn-fields");
  spawnDiv.innerHTML = "";
  for (const field of FIELD_ORDER.spawn) spawnDiv.appendChild(makeField(car.id, field));

  const behaviorDiv = document.getElementById("behavior-fields");
  behaviorDiv.innerHTML = "";
  for (const [group, fields] of Object.entries(FIELD_ORDER.behavior)) {
    const heading = document.createElement("h3");
    heading.textContent = group;
    behaviorDiv.appendChild(heading);
    for (const field of fields) behaviorDiv.appendChild(makeField(car.id, field));
  }
}

// Behavior fields flag whether this edit ADDS a new override to the car's
// profile (it currently inherits the commuter default) or CHANGES an
// override that was already there. Hull/speed/spawn fields are always plain
// changes — cartypes.js sets them on every entry, so there's no "inherited"
// state for the note to describe.
function noteFor(car, field) {
  if (field in car.hull || field in car.speed || field in car.spawn) return "";
  return car.behavior[field].inherited ? "new override" : "changed";
}

// pendingChanges/pendingObstacleChanges can accumulate no-op entries — a
// field the user changed and then changed back to its original value.
// renderReview() already filters these out of the diff table; these do the
// same filtering for what actually gets sent to the server, using the
// identical comparison.
function realChanges() {
  const result = {};
  for (const [carId, fields] of Object.entries(pendingChanges)) {
    const car = cars.find((c) => c.id === carId);
    for (const [field, value] of Object.entries(fields)) {
      if (fieldValue(car, field) === value) continue;
      result[carId] ??= {};
      result[carId][field] = value;
    }
  }
  return result;
}

function realObstacleChanges() {
  const result = {};
  for (const [obstacleId, fields] of Object.entries(pendingObstacleChanges)) {
    const obstacle = obstacles.find((o) => o.id === obstacleId);
    for (const [field, value] of Object.entries(fields)) {
      if (obstacle.spawn[field] === value) continue;
      result[obstacleId] ??= {};
      result[obstacleId][field] = value;
    }
  }
  return result;
}

function realPickupChanges() {
  const result = {};
  for (const [pickupId, fields] of Object.entries(pendingPickupChanges)) {
    const pickup = pickups.find((p) => p.id === pickupId);
    for (const [field, value] of Object.entries(fields)) {
      if (pickupFieldValue(pickup, field) === value) continue;
      result[pickupId] ??= {};
      result[pickupId][field] = value;
    }
  }
  return result;
}

function renderReview() {
  const section = document.getElementById("review");
  const tbody = document.querySelector("#review-table tbody");
  tbody.innerHTML = "";

  let hasChanges = false;

  function addRow(label, field, before, after, note) {
    if (before === after) return;
    hasChanges = true;
    const row = document.createElement("tr");
    for (const text of [label, field, String(before), String(after), note]) {
      const td = document.createElement("td");
      td.textContent = text;
      row.appendChild(td);
    }
    tbody.appendChild(row);
  }

  for (const [carId, fields] of Object.entries(pendingChanges)) {
    const car = cars.find((c) => c.id === carId);
    for (const [field, value] of Object.entries(fields)) {
      addRow(car.label, field, fieldValue(car, field), value, noteFor(car, field));
    }
  }

  for (const [obstacleId, fields] of Object.entries(pendingObstacleChanges)) {
    const obstacle = obstacles.find((o) => o.id === obstacleId);
    for (const [field, value] of Object.entries(fields)) {
      addRow(obstacle.label, field, obstacle.spawn[field], value, "");
    }
  }

  for (const [pickupId, fields] of Object.entries(pendingPickupChanges)) {
    const pickup = pickups.find((p) => p.id === pickupId);
    for (const [field, value] of Object.entries(fields)) {
      addRow(pickup.label, field, pickupFieldValue(pickup, field), value, "");
    }
  }

  section.hidden = false;
  document.getElementById("create-pr").disabled = !hasChanges;
}

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
    showStatusHtml(
      `Push failed: ${escapeHtml(data.error)}<br>` +
        `<button id="cancel-btn">Cancel</button> <button id="retry-push-btn">Retry push</button>`,
      "error"
    );
    document.getElementById("cancel-btn").addEventListener("click", cancelAttempt);
    document.getElementById("retry-push-btn").addEventListener("click", pushAttempt);
    return;
  }
  showStatusHtml(
    `Pushed. Opening the pull request page: <a href="${escapeHtml(data.url)}" target="_blank" rel="noopener">${escapeHtml(data.url)}</a>`,
    "success"
  );
  window.open(data.url, "_blank", "noopener");
  for (const key of Object.keys(pendingChanges)) delete pendingChanges[key];
  for (const key of Object.keys(pendingObstacleChanges)) delete pendingObstacleChanges[key];
  for (const key of Object.keys(pendingPickupChanges)) delete pendingPickupChanges[key];
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
    body: JSON.stringify({
      changes: realChanges(),
      obstacleChanges: realObstacleChanges(),
      pickupChanges: realPickupChanges(),
    }),
  });
  const commitData = await commitRes.json();

  if (!commitRes.ok) {
    showStatus(`Could not start: ${commitData.error}`, "error");
    document.getElementById("create-pr").disabled = false;
    return;
  }

  if (!commitData.testsPassed) {
    showStatusHtml(
      `Tests failed on branch <code>${escapeHtml(commitData.branch)}</code>:<pre>${escapeHtml(commitData.testOutput)}</pre>` +
        `<button id="cancel-btn">Cancel</button> <button id="push-anyway-btn">Push anyway</button>`,
      "error"
    );
    document.getElementById("cancel-btn").addEventListener("click", cancelAttempt);
    document.getElementById("push-anyway-btn").addEventListener("click", pushAttempt);
    return;
  }

  await pushAttempt();
}

document.getElementById("review-button").addEventListener("click", renderReview);
document.getElementById("create-pr").addEventListener("click", createPullRequest);

await loadState();
renderNav();
