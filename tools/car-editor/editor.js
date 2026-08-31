// tools/car-editor/editor.js
//
// Vanilla-JS UI for the tuning editor. Fetches every catalogue's current
// values, lets them be edited with a plain-English description of what each
// number does, shows a diff before anything is written, then drives the
// commit/test/push flow.
//
// THE SHAPE OF THIS FILE. Seven kinds of thing are editable — cars, obstacles,
// pickups, weapons, the shop's two shelves, and the world's bare constants —
// and they are NOT seven copies of the same code. Each one is a KIND descriptor
// below saying where its entries come from, how to group them in the sidebar,
// and which fields its form shows; everything after that (reading a value,
// recording a change, filtering out no-ops, building the review table, sending
// the request) is written once and runs over all seven. Adding an eighth
// catalogue should mean adding one descriptor, not another five functions.
//
// The kinds are then grouped into TABS, because "which weapon" and "which car"
// are different questions and one scrolling column of everything was the main
// thing making this hard to navigate.

// --- What each field means -------------------------------------------------

const CAR_FIELD_DESCRIPTIONS = {
  health: "Hull points. Spent by ramming, explosions, and weapons; the car is destroyed at zero.",
  mass: "How heavy this is in a collision, weighed against the player's own PLAYER_MASS (World → Player car). The heavier car wins the shove — a rig barely notices being hit.",
  speedMin: "HARD FLOOR, world units/sec: nothing may drive this car slower — not its tactic, not braking behind another car, not slowing to fit a swerve past a roadblock. 0 means it can be brought to a full stop. Raise it and the car cannot hold station behind a player who slows down; lower it and slowing down does not shake it.",
  cruiseMin: "Slowest cruising speed this car will roll at when it spawns, in world units/sec. NOT the floor above — this is only where the spawn roll starts.",
  speedMax: "Fastest cruising speed this car will roll at when it spawns, in world units/sec.",
  steerSpeed: "Sideways travel in px/sec at full lock — how fast this car changes lanes. Read it against the player's STEER_SPEED (World → Player car) to see who can cut whom off.",
  blastRadius: "How far the explosion reaches when this car is destroyed, in world units. It catches anything nearby, the player included.",
  blastDamage: "Hull points the explosion deals when this car is destroyed.",
  value: "Score for destroying this. NEGATIVE for civilians — running down a bystander costs you points.",
  bounty: "Credits for destroying this, and negative for civilians for the same reason. Against SHOP_INTERVAL (World → Run pacing) this is what decides how much you can afford at each dock.",
  minDistance: "How far the player must have driven before this car can spawn at all, in DIST-readout units (the same number the HUD shows). 0 means it can appear from the very first metre.",
  weight: "Relative spawn chance among the car types currently unlocked — bigger means more common, not a fixed probability. 0 takes this type off the road entirely.",

  followGap: "Clear road (world units) this driver wants between its nose and the car ahead's tail, before adding closing-speed room.",
  followReaction: "Seconds of closing speed added to followGap — how early this driver starts backing off from something ahead.",
  laneDiscipline: "How hard this driver holds the centre of its lane, from 0 (holds whatever line it's on) to 1 (rides the centre-line exactly).",
  laneHome: 'Which lanes this driver prefers when the road allows it: "any", "inner" (fast lanes near the centre-line), or "outer" (near the barriers).',
  patience: "Seconds this driver will sit behind something worth passing before it commits to a pass.",
  passTrigger: "How far ahead (world units) a slower car has to be before this driver considers it worth passing.",
  passMargin: "How far past a car this driver's nose must clear before pulling back into the lane.",
  passTimeout: "Seconds before an unfinished pass is abandoned.",
  passSpeedMargin: "How much faster than the car ahead this driver must be able to go to bother passing at all.",
  passClearance: "How much room this driver wants beside a car it's going past.",
  passLookBehind: "How far back (world units) this driver checks for traffic before pulling out.",
  passLookAhead: "How far ahead this driver checks the target lane is clear before pulling out.",
  passEffort: "How much of its speed reserve this driver spends to get the pass done.",
  hazardClearance: "How wide a berth this driver gives obstacles, in world units.",
  pursueHold: "Seconds this driver stays locked on the player before re-deciding.",
  pursueRange: "How far away (world units) the player can be and still be worth chasing.",
  pursueGain: "How hard this driver steers toward the player's lane while chasing.",
  chaseSpeed: "Speed multiplier applied while actively chasing the player.",
  giveUpTime: "Seconds of failing to close before this driver abandons the chase.",
  raidGain: "How hard this driver cuts across lanes on a raiding run.",
  leadHold: "How far AHEAD of the player (world units) this driver holds station before turning and shooting back down the road. Only the outrunner's tactic reads it. Too far and it is off the top of the screen, out of gun range and harmless.",
  weaveSpan: "How far either side of the player's line this driver sweeps while shooting at them from behind, in px. Only the outrider's tactic reads it.",
  weaveTime: "Seconds one full there-and-back sweep takes. Read against weaveSpan and this car's own steerSpeed — a sweep the steering cannot cover in the time comes out as a lazy drift instead.",
  ramBrake: "How hard this driver brakes into a ram rather than driving through it.",
  ramFloor: "Slowest speed a ram will be pressed home at.",
  nerve: "How readily this driver will drive through a hazard rather than around it. 0 dodges everything.",
  contact: "How willing this driver is to make contact with another car at all.",
};

const OBSTACLE_FIELD_DESCRIPTIONS = {
  health: "Hull points this hazard has. Weapons and rams spend it; at zero it is destroyed, and its blast (if any) goes off.",
  mass: "How heavy this hazard is in a collision. A light one gets shoved aside; a heavy one stops a car dead.",
  contactDamage: "Hull points dealt to whatever drives over or into this.",
  threat: "How wide a berth the driving AI gives this, in world units. Bigger means cars swerve earlier — it does not change what the hazard actually does to them.",
  blastRadius: "How far this hazard's explosion reaches when it is destroyed, in world units.",
  blastDamage: "Hull points that explosion deals.",
  slowTo: "Speed, in world units/sec, that a car caught by this is dragged down to.",
  slowTime: "Seconds the slow lasts.",
  weight: "Relative spawn chance among the obstacle types currently unlocked — bigger means more common, not a fixed probability. 0 takes this type out of the draw entirely.",
  minDistance: "How far the player must have driven before this obstacle can spawn at all, in DIST-readout units (the same number the HUD shows). 0 means it can appear from the very first metre.",
};

const PICKUP_FIELD_DESCRIPTIONS = {
  weight: "Relative spawn chance among the pickup types currently unlocked — bigger means more common, not a fixed probability. 0 takes this type out of the draw entirely.",
  minDistance: "How far the player must have driven before this pickup can spawn at all, in DIST-readout units (the same number the HUD shows). 0 means it can appear from the very first metre.",
};

// The payload a crate grants isn't the same field for every kind — AMMO and
// HEAL spend `amount`, SHIELD spends `duration`, BOOST spends BOTH — so what
// a given effect field MEANS depends on the row's own kind. Hence a table per
// kind rather than one per field: "amount" is rounds on one row, hull points
// on the next and world units/sec on a third.
//
// A kind lists only the fields it actually uses; the effect section is built
// from whichever of them the entry really carries (see `sections` below), so
// a kind that grows a second number needs an entry here and nothing else.
const PICKUP_EFFECT_DESCRIPTIONS = {
  ammo: {
    amount: "Ammo added to the matching weapon's magazine when this crate is picked up.",
  },
  heal: {
    amount: "Hull points restored when this crate is picked up, capped at the player's max health.",
  },
  shield: {
    duration: "Seconds of invulnerability granted when this crate is picked up.",
  },
  boost: {
    amount: "World units/sec added to BOTH ends of the player's speed band while the boost runs — the slowest the car can drop to and the fastest it can reach both move up by this. The car jumps to the new floor the moment the crate is collected.",
    duration: "Seconds the raised speed band lasts. When it ends the car drops straight back to its normal top speed.",
  },
};

// The effect fields a crate can carry, in the order they should be shown.
// Matches state.js's own PICKUP_EFFECT_FIELDS; a crate carries some subset.
const PICKUP_EFFECT_FIELDS = ["amount", "duration"];

const WEAPON_FIELD_DESCRIPTIONS = {
  damage: "Hull points one shot deals on a direct hit.",
  pierce: "How many cars one shot passes through before it stops. 1 means it stops at the first thing it hits.",
  blastRadius: "How far this shot's explosion reaches on impact, in world units.",
  blastDamage: "Hull points the explosion deals, on top of the direct hit.",
  interval: "Seconds between shots — or between bursts, for a burst weapon. Smaller is faster, and this is the single biggest dial on a weapon's damage per second.",
  burstCount: "Shots fired in one burst.",
  burstInterval: "Seconds between the individual shots inside a burst.",
  muzzleSpeed: "Speed a shot leaves the barrel at, in world units/sec. Slow shots have to be led; fast ones are point-and-click.",
  accel: "World units/sec² the projectile gains after launch — a rocket leaves the tube slowly and builds up.",
  topSpeed: "Fastest the projectile will travel once it has finished accelerating.",
  turnRate: "Degrees per second the projectile can steer toward its target. Bigger is harder to shake.",
  aimSlack: "How far off-target, in degrees, a hostile will still take the shot. Bigger means it fires more often and hits less.",
  ammo: "Magazine capacity — the most rounds this can hold at once.",
  startAmmo: "Rounds you begin a run with. 0 means the weapon is carried empty until a crate or the shop fills it.",
};

const UPGRADE_CONSUMABLE_PRICE_DESCRIPTION =
  "Credits this costs at the dock. Always buyable, any number of times, at this flat price.";

const UPGRADE_CONSUMABLE_EFFECT_DESCRIPTIONS = {
  ammo: "Ammo added to the matching weapon's magazine when this is bought.",
  heal: "Hull points restored when this is bought, capped at the player's max health.",
  shield: "Seconds of invulnerability granted when this is bought.",
};

const UPGRADE_STAT_DESCRIPTIONS = {
  price: "Credits tier 1 costs. Tiers 2 and 3 are this multiplied by the shared TIER_PRICES ladder — which is editable under World → Run pacing & economy, and applies to every stat at once.",
  step: "What ONE tier adds to the stat, in the car's own units. Every tier adds the same amount; the price is what escalates.",
};

// --- Server state and pending edits ----------------------------------------

// Everything /api/state returns, keyed the way the server sends it.
let data = {
  cars: [], obstacles: [], pickups: [], weapons: [],
  upgradeConsumables: [], upgradeStats: [], constantGroups: [],
};

// One bag of pending edits per kind: { entryId: { field: value } }. Constants
// use the same shape, with the constant GROUP as the entry and the individual
// constant ids as its fields — see the constant kind's descriptor and
// realChanges below, which flattens that back out for the request.
const pending = {};

let activeTab = null;
let selection = null; // { kind, id }

// --- Kind descriptors ------------------------------------------------------

// `values` is the flat { field: value } map the server sends for an entry.
// `sections` returns the form's fieldsets: a legend, an optional note, and the
// fields to render. `input` on a field is anything beyond a plain number box.
const KINDS = {
  car: {
    tab: "cars",
    label: "Car",
    entries: () => data.cars,
    requestKey: "changes",
    // Groups derived rather than hard-coded: two `faction` filters used to BE
    // the sidebar, which meant a car whose faction was neither string simply
    // never appeared — the BUS was invisible and uneditable for as long as its
    // catalogue entry was missing a `faction` key.
    groups() {
      const known = [
        { heading: "Hostile", faction: "enemy" },
        { heading: "Civilian", faction: "neutral" },
      ];
      const claimed = new Set(known.map((g) => g.faction));
      const groups = known.map(({ heading, faction }) => ({
        heading,
        entries: data.cars.filter((car) => car.faction === faction),
      }));
      const rest = data.cars.filter((car) => !claimed.has(car.faction));
      if (rest.length > 0) groups.push({ heading: "Uncategorised", entries: rest });
      return groups.filter((g) => g.entries.length > 0);
    },
    sections(car) {
      const catalogue = carFieldGroups.map(({ label, fields }) => ({
        legend: label,
        fields: fields.map((field) => ({
          field,
          description: CAR_FIELD_DESCRIPTIONS[field],
        })),
      }));
      // Behavior fields write a DRIVING PROFILE, not a car. The form gives them
      // the same shape as the per-car fields above, so the reach of an edit has
      // to be spelled out — or tuning the VAN quietly retunes the BUS.
      const behavior = behaviorFieldGroups.map(({ label, fields }) => ({
        legend: label,
        collapsible: true,
        // Collapsed when nothing in the group is overridden: for a civilian
        // that hides the whole chase-and-ram half of the profile, which it
        // never reads.
        open: fields.some((field) => !car.behavior[field].inherited),
        fields: fields.map((field) => ({
          field,
          description: CAR_FIELD_DESCRIPTIONS[field],
          tag: car.behavior[field].inherited ? "(inherited)" : "(overridden)",
          input: field === "laneHome" ? { type: "select", options: ["any", "inner", "outer"] } : null,
        })),
      }));
      behavior[0] = { ...behavior[0], scopeNote: behaviorScopeNote(car.profile) };
      return [...catalogue, ...behavior];
    },
    // The behavior half of a car's fields is not stored in `values` — it is
    // stored with its inherited flag alongside — so reading a value has to know
    // which half a field is in.
    //
    // NOT named `valueOf`: every object inherits Object.prototype.valueOf, so a
    // `kind.valueOf` test is true for EVERY kind, and the generic reader below
    // would call the built-in and get the descriptor object back.
    readValue(car, field) {
      return field in car.values ? car.values[field] : car.behavior[field].value;
    },
    note(car, field) {
      if (field in car.values) return "";
      const base = car.behavior[field].inherited ? "new override" : "changed";
      // The diff is per car, but the file this writes is per profile — a review
      // row reading only "VAN: followGap" would understate what the PR changes.
      const { name, sharedWith, isBaseline } = car.profile;
      if (isBaseline) {
        return `${base} — "${name}" baseline, inherited by every car not overriding ${field}`;
      }
      if (sharedWith.length > 0) {
        return `${base} — "${name}" profile, also applies to ${sharedWith.join(", ")}`;
      }
      return base;
    },
  },

  obstacle: {
    tab: "hazards",
    label: "Obstacle",
    entries: () => data.obstacles,
    requestKey: "obstacleChanges",
    groups: () => [{ heading: "Obstacles", entries: data.obstacles }],
    sections(obstacle) {
      // Only the fields this hazard actually has: the slow-effect group exists
      // for the SPIKES strip alone, and an empty fieldset is noise.
      return obstacleFieldGroups
        .map(({ label, fields }) => ({
          legend: label,
          fields: fields
            .filter((field) => field in obstacle.values)
            .map((field) => ({ field, description: OBSTACLE_FIELD_DESCRIPTIONS[field] })),
        }))
        .filter((section) => section.fields.length > 0);
    },
  },

  pickup: {
    tab: "hazards",
    label: "Pickup",
    entries: () => data.pickups,
    requestKey: "pickupChanges",
    groups: () => [{ heading: "Pickups", entries: data.pickups }],
    sections(pickup) {
      // EVERY effect field the entry actually carries, not just the first —
      // most kinds have exactly one (AMMO/HEAL's `amount`, SHIELD's
      // `duration`), but BOOST spends both and is meaningless with either
      // half missing (see src/game/pickuptypes.js's header).
      const effectFields = PICKUP_EFFECT_FIELDS.filter((field) => field in pickup.values);
      const sections = [];
      if (effectFields.length > 0) {
        sections.push({
          legend: "Effect",
          fields: effectFields.map((field) => ({
            field,
            description: PICKUP_EFFECT_DESCRIPTIONS[pickup.kind]?.[field],
          })),
        });
      }
      sections.push({
        legend: "Spawn",
        fields: ["weight", "minDistance"].map((field) => ({
          field,
          description: PICKUP_FIELD_DESCRIPTIONS[field],
        })),
      });
      return sections;
    },
  },

  weapon: {
    tab: "weapons",
    label: "Weapon",
    entries: () => data.weapons,
    requestKey: "weaponChanges",
    groups: () => [
      { heading: "Player", entries: data.weapons.filter((w) => w.side === "player") },
      { heading: "Hostile", entries: data.weapons.filter((w) => w.side === "enemy") },
    ],
    subtitle(weapon) {
      const parts = [];
      if (weapon.flight) parts.push(`${weapon.flight} flight`);
      if (weapon.payload) parts.push(`lays ${weapon.payload}`);
      // Worth saying out loud rather than leaving as a missing box: the default
      // gun never running dry is the premise the rest of the arsenal is
      // balanced against, so there is no ammo field to find.
      if (weapon.unlimitedAmmo) parts.push("unlimited ammo (by design — not editable)");
      return parts.join(" · ");
    },
    sections(weapon) {
      return weaponFieldGroups
        .map(({ label, fields }) => ({
          legend: label,
          fields: fields
            .filter((field) => field in weapon.values)
            .map((field) => ({ field, description: WEAPON_FIELD_DESCRIPTIONS[field] })),
        }))
        .filter((section) => section.fields.length > 0);
    },
  },

  upgradeConsumable: {
    tab: "shop",
    label: "Shop consumable",
    entries: () => data.upgradeConsumables,
    requestKey: "upgradeConsumableChanges",
    groups: () => [{ heading: "Consumables", entries: data.upgradeConsumables }],
    sections(entry) {
      const fields = [{ field: "price", description: UPGRADE_CONSUMABLE_PRICE_DESCRIPTION }];
      if (entry.effectField) {
        fields.push({
          field: entry.effectField,
          description: UPGRADE_CONSUMABLE_EFFECT_DESCRIPTIONS[entry.kind],
        });
      }
      return [{ legend: "Price & effect", fields }];
    },
  },

  upgradeStat: {
    tab: "shop",
    label: "Shop car system",
    entries: () => data.upgradeStats,
    requestKey: "upgradeStatChanges",
    groups: () => [{ heading: "Car systems", entries: data.upgradeStats }],
    sections(stat) {
      return [{
        legend: "Price & tier increase",
        fields: [
          { field: "price", description: UPGRADE_STAT_DESCRIPTIONS.price },
          { field: "step", description: UPGRADE_STAT_DESCRIPTIONS.step, preview: statStepPreview(stat) },
        ],
      }];
    },
  },

  constant: {
    tab: "world",
    label: "World",
    // A constant GROUP is the entry here, and the individual constants are its
    // fields. That keeps constants on the same "entry with fields" rails as
    // every catalogue above, even though the request the server wants is flat —
    // realChanges is where that flattening happens.
    entries: () => data.constantGroups,
    requestKey: "constantChanges",
    flatRequest: true,
    groups: () => [{ heading: "World", entries: data.constantGroups }],
    subtitle: (group) => group.note,
    sections(group) {
      return [{
        legend: group.label,
        fields: group.constants.map((constant) => ({
          field: constant.id,
          label: constant.label,
          description: `${constant.description} — ${constant.file}`,
          input: constant.min === null ? null : { type: "number", min: constant.min },
        })),
      }];
    },
  },
};

// Field-group orderings, filled in from /api/state so the form and the server
// read the same list — the UI used to own its own copy of these, which meant a
// field added to the catalogue and not to the UI's list simply never rendered.
let carFieldGroups = [];
let behaviorFieldGroups = [];
let obstacleFieldGroups = [];
let weaponFieldGroups = [];

const TABS = [
  { id: "cars", label: "Cars" },
  { id: "hazards", label: "Hazards & pickups" },
  { id: "weapons", label: "Weapons" },
  { id: "shop", label: "Shop" },
  { id: "world", label: "World" },
];

function kindsInTab(tabId) {
  return Object.entries(KINDS)
    .filter(([, kind]) => kind.tab === tabId)
    .map(([id, kind]) => ({ id, ...kind }));
}

// --- Reading and writing values --------------------------------------------

function entryOf(kindId, id) {
  return KINDS[kindId].entries().find((entry) => entry.id === id);
}

function baseValue(kindId, id, field) {
  const kind = KINDS[kindId];
  const entry = entryOf(kindId, id);
  if (kind.readValue) return kind.readValue(entry, field);
  // The constant kind's "values" are its constants, keyed by their own id.
  if (entry.constants) return entry.constants.find((c) => c.id === field).value;
  return entry.values[field];
}

function currentValue(kindId, id, field) {
  const bag = pending[kindId]?.[id];
  if (bag && field in bag) return bag[field];
  return baseValue(kindId, id, field);
}

function setChange(kindId, id, field, value) {
  pending[kindId] ??= {};
  pending[kindId][id] ??= {};
  pending[kindId][id][field] = value;
  renderNav();
  renderActions();
  if (!document.getElementById("review").hidden) renderReview();
}

// Drops one field's pending edit, and the whole entry once it holds nothing —
// so the pending bags never accumulate empty objects that renderReview and
// realChanges would then have to skip.
function clearChange(kindId, id, field) {
  const bag = pending[kindId]?.[id];
  if (!bag) return;
  delete bag[field];
  if (Object.keys(bag).length === 0) delete pending[kindId][id];
  renderNav();
  renderActions();
  if (!document.getElementById("review").hidden) renderReview();
}

function hasChange(kindId, id) {
  return Boolean(pending[kindId]?.[id]);
}

// A pending bag can hold no-op entries — a field changed and then changed back.
// Both the review table and the request filter them out through this, using the
// identical comparison, so what you approve is exactly what gets sent.
function* realChangeEntries() {
  for (const [kindId, byEntry] of Object.entries(pending)) {
    for (const [id, fields] of Object.entries(byEntry)) {
      for (const [field, value] of Object.entries(fields)) {
        if (baseValue(kindId, id, field) === value) continue;
        yield { kindId, id, field, value };
      }
    }
  }
}

function buildRequestBody() {
  const body = {};
  for (const { kindId, id, field, value } of realChangeEntries()) {
    const kind = KINDS[kindId];
    body[kind.requestKey] ??= {};
    if (kind.flatRequest) {
      // Constants: the server wants { constantId: value }, not the
      // group-and-fields shape the UI carries them in.
      body[kind.requestKey][field] = value;
    } else {
      body[kind.requestKey][id] ??= {};
      body[kind.requestKey][id][field] = value;
    }
  }
  return body;
}

function changeCount() {
  let count = 0;
  for (const _ of realChangeEntries()) count++;
  return count;
}

function discardAllChanges() {
  for (const key of Object.keys(pending)) delete pending[key];
  renderNav();
  renderForm();
  renderActions();
  document.getElementById("review").hidden = true;
}

// --- Small DOM helpers -----------------------------------------------------

// Escapes text for safe interpolation into an innerHTML template string.
// (showStatus() uses textContent, which is safe by construction; this is only
// for the showStatusHtml() call sites.)
//
// The textContent -> innerHTML round-trip escapes &, < and > but leaves quote
// characters alone. That's fine where the result lands in plain text, but not
// for pushAttempt()'s success message, which interpolates data.url inside
// href="..." — a bare " there would close the attribute early and let the rest
// be parsed as markup. Escaping quotes too makes this safe in both contexts.
function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = String(str);
  return div.innerHTML.replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

// A number input that was blanked (or filled with something unparseable) is NOT
// a request to set zero — but `Number("")` is 0, so committing it verbatim wrote
// a silent zero the user never typed, and only the handful of fields the server
// guards as strictly positive would ever have caught it. The field is put back
// to the value it currently holds instead; this flash is what stops that restore
// from looking like nothing happened.
function flashRejected(input) {
  input.classList.remove("rejected");
  // Force a reflow so re-adding the class restarts the animation when the same
  // field is blanked twice in a row.
  void input.offsetWidth;
  input.classList.add("rejected");
}

// Returns the number in a text/number input, or null when it is empty or holds
// something that isn't a finite number.
function readNumberInput(input) {
  const raw = input.value.trim();
  if (raw === "") return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

function behaviorScopeNote({ name, sharedWith, isBaseline }) {
  if (isBaseline) {
    return `These write the "${name}" profile — the baseline every car inherits from. ` +
      `Any car that does not override a field itself changes with it.`;
  }
  if (sharedWith.length > 0) {
    return `These write the "${name}" driving profile, shared with ${sharedWith.join(", ")}. ` +
      `Edits here apply to those cars too.`;
  }
  return `These write the "${name}" driving profile, which only this car uses.`;
}

// "620 → 660", in the shop's own printed precision, so the preview reads exactly
// like the shop screen does rather than like a raw JS number.
function statStepPreview(stat) {
  const format = (value) => `${value.toFixed(stat.decimals)}${stat.unit}`;
  return (step) =>
    step === null
      ? "Enter a number to preview what tier 1 buys."
      : `Tier 1 moves this from ${format(stat.base)} to ${format(stat.base + step)}.`;
}

// --- Rendering -------------------------------------------------------------

function renderTabs() {
  const bar = document.getElementById("tabs");
  bar.innerHTML = "";
  for (const tab of TABS) {
    const button = document.createElement("button");
    button.textContent = tab.label;
    button.role = "tab";
    button.className = tab.id === activeTab ? "tab selected" : "tab";
    button.setAttribute("aria-selected", String(tab.id === activeTab));
    // Count of pending edits in this tab, so a change made on one screen is
    // still visible from another.
    const count = [...realChangeEntries()].filter(
      ({ kindId }) => KINDS[kindId].tab === tab.id
    ).length;
    if (count > 0) {
      const badge = document.createElement("span");
      badge.className = "badge";
      badge.textContent = String(count);
      button.appendChild(badge);
    }
    button.addEventListener("click", () => {
      activeTab = tab.id;
      selection = null;
      renderTabs();
      renderNav();
      renderForm();
    });
    bar.appendChild(button);
  }
}

function renderNav() {
  const nav = document.getElementById("entry-list");
  nav.innerHTML = "";

  for (const kind of kindsInTab(activeTab)) {
    for (const group of kind.groups()) {
      const headingEl = document.createElement("h3");
      headingEl.textContent = group.heading;
      nav.appendChild(headingEl);

      for (const entry of group.entries) {
        const button = document.createElement("button");
        button.textContent = entry.label;
        const selected = selection && selection.kind === kind.id && selection.id === entry.id;
        button.className = selected ? "selected" : "";
        if (hasChange(kind.id, entry.id)) {
          const dot = document.createElement("span");
          dot.className = "change-dot";
          dot.title = "has pending changes";
          button.appendChild(dot);
        }
        button.addEventListener("click", () => {
          selection = { kind: kind.id, id: entry.id };
          renderNav();
          renderForm();
        });
        nav.appendChild(button);
      }
    }
  }
}

function makeField(kindId, entryId, spec) {
  const wrapper = document.createElement("div");
  wrapper.className = "field";

  const label = document.createElement("label");
  label.textContent = spec.label ?? spec.field;
  if (spec.tag) {
    const tag = document.createElement("span");
    tag.className = spec.tag === "(inherited)" ? "inherit-tag" : "override-tag";
    tag.textContent = spec.tag;
    label.appendChild(tag);
  }
  wrapper.appendChild(label);

  const readCurrent = () => currentValue(kindId, entryId, spec.field);

  let input;
  if (spec.input?.type === "select") {
    input = document.createElement("select");
    for (const option of spec.input.options) {
      const opt = document.createElement("option");
      opt.value = option;
      opt.textContent = option;
      input.appendChild(opt);
    }
    input.value = readCurrent();
    input.addEventListener("change", () => setChange(kindId, entryId, spec.field, input.value));
  } else {
    input = document.createElement("input");
    input.type = "number";
    input.step = "any";
    if (spec.input?.min !== undefined) input.min = String(spec.input.min);
    input.value = readCurrent();
    input.addEventListener("change", () => {
      const value = readNumberInput(input);
      if (value === null) {
        clearChange(kindId, entryId, spec.field);
        // `readCurrent` is a function, not a captured value, because a blanked
        // box has to be restored to what the field holds RIGHT NOW — the
        // pending edit if there is one, not what it was built with.
        input.value = readCurrent();
        flashRejected(input);
        return;
      }
      setChange(kindId, entryId, spec.field, value);
    });
  }
  wrapper.appendChild(input);

  const description = document.createElement("div");
  description.className = "description";
  description.textContent = spec.description ?? "";
  wrapper.appendChild(description);

  if (spec.preview) {
    const preview = document.createElement("div");
    preview.className = "description preview";
    const render = () => {
      // Read the INPUT directly rather than the pending value: that only
      // updates once the "change" listener fires on blur/Enter, and a
      // keep-typing preview needs the value mid-edit.
      preview.textContent = spec.preview(readNumberInput(input));
    };
    render();
    // Kept in sync with the input directly rather than by re-rendering the
    // form on every keystroke, which would drop focus out of the box being
    // typed in. This is the one line on the screen where a stale value would
    // read as wrong rather than as "not yet applied", since it does arithmetic
    // the user can't easily do in their head.
    input.addEventListener("input", render);
    wrapper.appendChild(preview);
  }

  return wrapper;
}

function renderForm() {
  const form = document.getElementById("form");
  const empty = document.getElementById("form-empty");
  const sectionsEl = document.getElementById("form-sections");

  if (!selection) {
    form.hidden = true;
    empty.hidden = false;
    return;
  }

  const kind = KINDS[selection.kind];
  const entry = entryOf(selection.kind, selection.id);
  form.hidden = false;
  empty.hidden = true;
  document.getElementById("form-title").textContent = entry.label;

  const subtitleEl = document.getElementById("form-subtitle");
  const subtitle = kind.subtitle?.(entry);
  subtitleEl.textContent = subtitle ?? "";
  subtitleEl.hidden = !subtitle;

  sectionsEl.innerHTML = "";
  for (const section of kind.sections(entry)) {
    // A collapsible section is a <details>, so the twenty-odd behavior fields
    // a car carries can be folded away when nothing in them is overridden.
    const box = document.createElement(section.collapsible ? "details" : "fieldset");
    if (section.collapsible) {
      box.open = section.open !== false;
      const summary = document.createElement("summary");
      summary.textContent = section.legend;
      box.appendChild(summary);
    } else {
      const legend = document.createElement("legend");
      legend.textContent = section.legend;
      box.appendChild(legend);
    }

    if (section.scopeNote) {
      const note = document.createElement("p");
      note.className = "scope-note";
      note.textContent = section.scopeNote;
      box.appendChild(note);
    }

    for (const spec of section.fields) {
      box.appendChild(makeField(selection.kind, entry.id, spec));
    }
    sectionsEl.appendChild(box);
  }
}

function renderActions() {
  const count = changeCount();
  document.getElementById("review-button").textContent =
    count === 0 ? "Review changes" : `Review ${count} change${count === 1 ? "" : "s"}`;
  document.getElementById("discard-button").hidden = count === 0;
  renderTabs();
}

function renderReview() {
  const section = document.getElementById("review");
  const tbody = document.querySelector("#review-table tbody");
  tbody.innerHTML = "";

  let hasChanges = false;
  for (const { kindId, id, field, value } of realChangeEntries()) {
    hasChanges = true;
    const kind = KINDS[kindId];
    const entry = entryOf(kindId, id);
    const before = baseValue(kindId, id, field);
    const note = kind.note ? kind.note(entry, field) : "";
    const row = document.createElement("tr");
    for (const text of [kind.label, entry.label, field, String(before), String(value), note]) {
      const td = document.createElement("td");
      td.textContent = text;
      row.appendChild(td);
    }
    tbody.appendChild(row);
  }

  section.hidden = false;
  document.getElementById("create-pr").disabled = !hasChanges;
}

// --- Status and the commit/test/push flow ----------------------------------

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

async function loadState() {
  const res = await fetch("/api/state");
  if (!res.ok) throw new Error(`/api/state responded ${res.status}`);
  data = await res.json();
  carFieldGroups = data.carFieldGroups;
  behaviorFieldGroups = data.behaviorFieldGroups;
  obstacleFieldGroups = data.obstacleFieldGroups;
  weaponFieldGroups = data.weaponFieldGroups;
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
  // The source files on disk have moved on, so the baseline every "before"
  // column and no-op filter reads from has to move with them. /api/state
  // re-reads them from disk (see the server's refreshCatalogues), which is what
  // makes a second tuning session in one sitting diff against reality.
  discardAllChanges();
  await loadState();
  renderTabs();
  renderNav();
  renderForm();
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
    body: JSON.stringify(buildRequestBody()),
  });
  const commitData = await commitRes.json();

  if (!commitRes.ok) {
    showStatus(`Could not start: ${commitData.error}`, "error");
    document.getElementById("create-pr").disabled = false;
    return;
  }

  if (!commitData.testsPassed) {
    // Lead with the tests that actually broke. The full run is thousands of
    // lines and burying the three that matter in it is how a real failure —
    // the shop and the crate it mirrors drifting apart, say — reads as noise.
    const failures = commitData.testFailures ?? [];
    const headline = failures.length
      ? `${failures.length} test${failures.length === 1 ? "" : "s"} failed on branch ` +
        `<code>${escapeHtml(commitData.branch)}</code>:` +
        `<pre>${escapeHtml(failures.join("\n\n"))}</pre>`
      : `The test run did not pass on branch <code>${escapeHtml(commitData.branch)}</code>, ` +
        `and reported no individual failing test — see the full output below.`;
    showStatusHtml(
      headline +
        `<details><summary>Full test output</summary><pre>${escapeHtml(commitData.testOutput)}</pre></details>` +
        `<p>Your changes are committed on that branch either way. "Cancel" throws the branch away; ` +
        `"Push anyway" keeps it and opens the pull request.</p>` +
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
document.getElementById("discard-button").addEventListener("click", discardAllChanges);

// A reload or a closed tab used to take every pending edit with it silently.
window.addEventListener("beforeunload", (event) => {
  if (changeCount() === 0) return;
  event.preventDefault();
  event.returnValue = "";
});

try {
  await loadState();
  activeTab = TABS[0].id;
  renderTabs();
  renderNav();
  renderActions();
} catch (err) {
  // Without this the module just rejects and the page stays blank with the
  // reason buried in the console.
  showStatus(`Could not load the catalogues: ${err.message}`, "error");
}
