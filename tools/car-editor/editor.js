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

// Behavior fields flag whether this edit ADDS a new override to the car's
// profile (it currently inherits the commuter default) or CHANGES an
// override that was already there. Hull/speed fields are always plain
// changes — cartypes.js sets them on every entry, so there's no "inherited"
// state for the note to describe.
function noteFor(car, field) {
  if (field in car.hull || field in car.speed) return "";
  return car.behavior[field].inherited ? "new override" : "changed";
}

// pendingChanges can accumulate no-op entries — a field the user changed and
// then changed back to its original value. renderReview() already filters
// these out of the diff table; this does the same filtering for what
// actually gets sent to the server, using the identical comparison.
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
    body: JSON.stringify({ changes: realChanges() }),
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

document.getElementById("review-button").addEventListener("click", renderReview);
document.getElementById("create-pr").addEventListener("click", createPullRequest);

await loadState();
renderCarList();
