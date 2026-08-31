// Reads the whole roster's CURRENT values by importing the real game
// modules — same trick tools/drivesim.js already uses — so the editor never
// shows a stale snapshot. A field is reported "inherited" when its value
// equals the commuter default, which is a value-based approximation of "not
// explicitly overridden in the source": correct in every case the source
// actually looks like today, and if a profile were ever written to spell
// out a value equal to the default anyway, the worst outcome is a cosmetic
// "(overridden)" tag missing in the UI — not a wrong edit.

//
// The five catalogues are held in the mutable `live` registry below rather
// than as plain static imports, because a static import is read ONCE per
// process: after a tuning session patches cartypes.js on disk, the running
// server would keep serving the values it read at startup, and the next
// session would diff against a baseline that no longer exists. Every builder
// reads through `live`, and refreshCatalogues() swaps in freshly re-imported
// copies (see its own note on how).

import { stat as statFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import * as cartypesModule from "../../src/game/cartypes.js";
import * as drivingModule from "../../src/game/driving.js";
import * as obstacletypesModule from "../../src/game/obstacletypes.js";
import * as pickuptypesModule from "../../src/game/pickuptypes.js";
import * as upgradesModule from "../../src/game/upgrades.js";
import * as weaponsModule from "../../src/game/weapons.js";

const GAME_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../src/game");

const CATALOGUE_FILES = {
  cartypes: "cartypes.js",
  driving: "driving.js",
  obstacletypes: "obstacletypes.js",
  pickuptypes: "pickuptypes.js",
  upgrades: "upgrades.js",
  weapons: "weapons.js",
};

// Starts as the statically imported modules so importing this file is enough
// to use it (tests do exactly that, and never call refreshCatalogues).
const live = {
  cartypes: cartypesModule,
  driving: drivingModule,
  obstacletypes: obstacletypesModule,
  pickuptypes: pickuptypesModule,
  upgrades: upgradesModule,
  weapons: weaponsModule,
};

// Re-reads the five catalogues from disk, bypassing the ES module cache by
// giving each import a URL that changes whenever the file does (its mtime).
// Each refresh therefore leaves another module instance in the loader's cache
// — unavoidable, and irrelevant for a local single-user tool that refreshes
// once per page load.
//
// Re-importing the five INDEPENDENTLY is correct only because no editable
// value crosses between them: upgrades.js imports pickuptypes.js, but only
// for the kind strings (AMMO/HEAL/SHIELD/BOOST) and applyPickup(), none of
// which this editor writes. If an editable field ever became a cross-module import, a
// fresh module here would still see the stale copy of its dependency.
//
// This refreshes VALUES, not structure: the *_IDS lists below are derived
// once at load, so a type newly ADDED to a catalogue still needs a server
// restart to appear. The editor only ever writes existing fields on existing
// entries, so that gap is not reachable through the editor itself.
export async function refreshCatalogues() {
  for (const [key, file] of Object.entries(CATALOGUE_FILES)) {
    const filePath = path.join(GAME_DIR, file);
    const { mtimeMs } = await statFile(filePath);
    live[key] = await import(`${pathToFileURL(filePath).href}?mtime=${mtimeMs}`);
  }
}

// Derived from the catalogue itself, civilian and hostile alike, so a type
// added to cartypes.js shows up here without a second list to remember to
// update — the same reasoning the gallery in src/demo/gallery.js already
// applies to the same catalogue.
export const CAR_IDS = live.cartypes.CAR_TYPES.map((t) => t.id);

// Every tunable number that lives on the CAR_TYPES entry itself, grouped the
// way the editor shows them. Everything NOT in here and not decoration
// (shape/colour/label) belongs to the driving profile instead, which is a
// different file and a different blast radius — see BEHAVIOR_FIELDS below.
//
// The split into groups is by what a change DOES: `mass` is a hull property
// even though it never appears on a health bar, and `value`/`bounty` are one
// decision (what killing this is worth) even though one is score and the
// other is credits.
export const CAR_FIELD_GROUPS = [
  { label: "Hull", fields: ["health", "mass"] },
  { label: "Speed", fields: ["speedMin", "cruiseMin", "speedMax", "steerSpeed"] },
  { label: "Wreck", fields: ["blastRadius", "blastDamage"] },
  { label: "Reward", fields: ["value", "bounty"] },
  { label: "Spawn", fields: ["minDistance", "weight"] },
];

export const CAR_TYPE_FIELDS = CAR_FIELD_GROUPS.flatMap((g) => g.fields);

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
  // Chasing and ramming. Inert for every civilian — the tactics that read them
  // are hostile-only (behaviours.js's `pursue`, `trail`, `ram`, `raid`,
  // `strafe`, `outrun` and `strew`) — but they live on the same profile
  // object as everything above, so they surface here on the same terms and the
  // "(inherited)" tag does the explaining.
  "pursueHold",
  "pursueRange",
  "pursueGain",
  "chaseSpeed",
  "giveUpTime",
  "raidGain",
  // The motorcycle fleet's three. `leadHold` is the gap the outrunner keeps
  // AHEAD of the player, and the weave pair is the sweep the outrider rides
  // across their line — see driving.js, where each says what bounds it.
  "leadHold",
  "weaveSpan",
  "weaveTime",
  "ramBrake",
  "ramFloor",
  "nerve",
  "contact",
];

// Which named driving profile a car actually drives. cartypes.js entries may
// omit `driving` entirely (the sedan does), and drivingFor() resolves both
// that and an unknown name to the commuter default — so the profile a car
// READS and the string on its catalogue entry are not always the same thing.
// Patching driving.js needs the resolved NAME, which is what this returns;
// passing `type.driving` straight through, as the commit handler used to,
// meant a behavior edit on the sedan tried to patch a profile called
// "undefined" and failed.
// The behavior fields, grouped for the form. The editor used to own this
// ordering and state.js owned the flat list, which meant a field added to one
// and not the other simply never rendered.
export const BEHAVIOR_FIELD_GROUPS = [
  { label: "Following", fields: ["followGap", "followReaction"] },
  { label: "Lane keeping", fields: ["laneDiscipline", "laneHome"] },
  {
    label: "Passing",
    fields: [
      "patience", "passTrigger", "passMargin", "passTimeout", "passSpeedMargin",
      "passClearance", "passLookBehind", "passLookAhead", "passEffort",
    ],
  },
  { label: "Hazards", fields: ["hazardClearance"] },
  {
    label: "Chasing the player",
    fields: [
      "pursueHold", "pursueRange", "pursueGain", "chaseSpeed", "giveUpTime", "raidGain",
      "leadHold", "weaveSpan", "weaveTime",
    ],
  },
  { label: "Ramming", fields: ["ramBrake", "ramFloor"] },
  { label: "Nerve", fields: ["nerve", "contact"] },
];

export function drivingProfileNameFor(carId) {
  const type = live.cartypes.carTypeById(carId);
  if (!type) throw new Error(`drivingProfileNameFor: unknown car id "${carId}"`);
  const named = type.driving;
  return named && live.driving.DRIVING_PROFILES[named] ? named : "commuter";
}

// Driving profiles are SHARED: VAN and BUS both drive "hauler", and every car
// without its own profile falls back to "commuter". Editing a behavior field
// therefore edits a profile, not a car, and the blast radius is everything
// that reads it — which the editor has to say out loud, because the form looks
// exactly like the per-car hull and speed fields directly above it.
//
// `sharedWith` lists the OTHER cars resolving to the same profile. `isBaseline`
// flags the commuter profile specially: its reach is wider than sharedWith
// suggests, since every field a car does not override is inherited from it.
export function drivingProfileScope(carId) {
  const name = drivingProfileNameFor(carId);
  const sharedWith = live.cartypes.CAR_TYPES
    .filter((t) => t.id !== carId && drivingProfileNameFor(t.id) === name)
    .map((t) => t.label);
  return { name, sharedWith, isBaseline: name === "commuter" };
}

export function buildCarState(carId) {
  if (!CAR_IDS.includes(carId)) {
    throw new Error(`buildCarState: unknown car id "${carId}"`);
  }
  const type = live.cartypes.carTypeById(carId);
  const profile = live.driving.drivingFor(type);
  const commuter = live.driving.DRIVING_PROFILES.commuter;

  const behavior = {};
  for (const field of BEHAVIOR_FIELDS) {
    behavior[field] = {
      value: profile[field],
      inherited: profile[field] === commuter[field],
    };
  }

  const values = {};
  for (const field of CAR_TYPE_FIELDS) values[field] = type[field] ?? 0;

  return {
    id: type.id,
    label: type.label,
    faction: type.faction,
    values,
    behavior,
    // Which driving profile the behavior block above actually writes, and who
    // else it reaches — see drivingProfileScope.
    profile: drivingProfileScope(carId),
  };
}

export function buildAllCarState() {
  return CAR_IDS.map(buildCarState);
}

// Obstacles (obstacletypes.js) have no driving-profile split — there's no
// behaviours.js/driving.js pair for a static hazard — so their state is just
// the two fields the catalogue's header calls out as spawn tuning: how often
// a type is picked (`weight`, relative to the others available) and how far
// the player must drive before it's in the draw at all (`minDistance`, same
// gate cartypes.js documents for cars).
export const OBSTACLE_IDS = live.obstacletypes.OBSTACLE_TYPES.map((t) => t.id);

// Spawn tuning was all this exposed for a long time, which meant you could
// change how OFTEN a hazard appeared but not how much it hurt. The rest of the
// entry is here now, in the same two-group shape the cars use.
//
// Not every field is on every type: only the two punctures (the SPIKES strip
// and the SPIKE MINE) have the slow-effect fields, and `threat` only means
// anything for a hazard the AI actively avoids.
// Like a pickup's amount/duration split, a field is reported only when the
// entry actually has a finite number for it — a form field writing a key the
// catalogue does not read is a change with no effect.
export const OBSTACLE_FIELD_GROUPS = [
  { label: "Hazard", fields: ["health", "mass", "contactDamage", "threat"] },
  { label: "Blast", fields: ["blastRadius", "blastDamage"] },
  { label: "Slow effect", fields: ["slowTo", "slowTime"] },
  { label: "Spawn", fields: ["weight", "minDistance"] },
];

export const OBSTACLE_FIELDS = OBSTACLE_FIELD_GROUPS.flatMap((g) => g.fields);

export function buildObstacleState(obstacleId) {
  if (!OBSTACLE_IDS.includes(obstacleId)) {
    throw new Error(`buildObstacleState: unknown obstacle id "${obstacleId}"`);
  }
  const type = live.obstacletypes.obstacleTypeById(obstacleId);
  const values = {};
  for (const field of OBSTACLE_FIELDS) {
    if (Number.isFinite(type[field])) values[field] = type[field];
  }
  // minDistance is the one field the catalogue may legitimately omit and still
  // mean something by it — absent is "from the first metre", same as 0.
  if (!("minDistance" in values)) values.minDistance = 0;
  return { id: type.id, label: type.label, values };
}

export function buildAllObstacleState() {
  return OBSTACLE_IDS.map(buildObstacleState);
}

// Pickups (pickuptypes.js) have the same spawn-tuning shape as obstacles —
// `weight` (relative draw odds among unlocked types) and `minDistance` (the
// unlock gate) — see that file's own header on why both are already read at
// runtime even though every entry ships uniform today.
export const PICKUP_IDS = live.pickuptypes.PICKUP_TYPES.map((t) => t.id);

export const PICKUP_SPAWN_FIELDS = ["weight", "minDistance"];

// Unlike spawn tuning, the payload each crate grants is NOT the same field
// across every kind — see pickuptypes.js's header: AMMO and HEAL both spend
// `amount` (rounds refilled / hull restored), SHIELD spends `duration`
// (seconds of invulnerability) instead, and BOOST spends BOTH (world units/sec
// added to the speed band, and for how long). So buildPickupState reports
// whichever of the pair the entry actually carries rather than a fixed set of
// keys — one field for most kinds, two for an overdrive — and the editor
// builds its Effect section from what it finds.
export const PICKUP_EFFECT_FIELDS = ["amount", "duration"];

export const PICKUP_FIELDS = [...PICKUP_EFFECT_FIELDS, ...PICKUP_SPAWN_FIELDS];

export function buildPickupState(pickupId) {
  if (!PICKUP_IDS.includes(pickupId)) {
    throw new Error(`buildPickupState: unknown pickup id "${pickupId}"`);
  }
  const type = live.pickuptypes.pickupTypeById(pickupId);
  const values = { weight: type.weight, minDistance: type.minDistance ?? 0 };
  for (const field of PICKUP_EFFECT_FIELDS) {
    if (field in type) values[field] = type[field];
  }
  return { id: type.id, label: type.label, kind: type.kind, values };
}

export function buildAllPickupState() {
  return PICKUP_IDS.map(buildPickupState);
}

// Weapons (game/weapons.js) — two arrays in one file, the player's kit and the
// hostiles'. They are one editable KIND here rather than two, differing only in
// a `side` tag, because they are the same shape and are tuned against each
// other: what a blaster does to you is only meaningful against what a cannon
// does to them.
//
// Only numbers are surfaced. Everything else on an entry decides what a weapon
// IS rather than how strong it is — `flight` (straight/tracking/seeking),
// `payload`, `render`, `forwardOnly`, the colours — and changing any of them is
// a design change that belongs in a reviewed diff, not a number box. `length`
// and `width` are skipped for the same reason: they are how a shot draws.
export const WEAPON_FIELD_GROUPS = [
  { label: "Damage", fields: ["damage", "pierce", "blastRadius", "blastDamage"] },
  { label: "Rate of fire", fields: ["interval", "burstCount", "burstInterval"] },
  { label: "Flight", fields: ["muzzleSpeed", "accel", "topSpeed", "turnRate", "aimSlack"] },
  { label: "Ammunition", fields: ["ammo", "startAmmo"] },
];

export const WEAPON_FIELDS = WEAPON_FIELD_GROUPS.flatMap((g) => g.fields);

// A weapon carries only some of these — the mine layer has no `damage` (its
// payload is an obstacle), the rocket alone has `turnRate`, and the cannon's
// `ammo` is Infinity ON PURPOSE: the default gun never runs dry, which is the
// premise the rest of the arsenal is balanced against. Reporting only finite,
// present fields means the form never offers a box that would either write a
// key nothing reads, or quietly turn the endless gun into a magazine.
export function buildWeaponState(id) {
  const player = live.weapons.WEAPON_TYPES.find((w) => w.id === id);
  const entry = player ?? live.weapons.ENEMY_WEAPON_TYPES.find((w) => w.id === id);
  if (!entry) throw new Error(`buildWeaponState: unknown weapon id "${id}"`);
  const values = {};
  for (const field of WEAPON_FIELDS) {
    if (Number.isFinite(entry[field])) values[field] = entry[field];
  }
  return {
    id: entry.id,
    label: entry.label,
    side: player ? "player" : "enemy",
    // Context for the form, not editable: what the weapon fundamentally is.
    flight: entry.flight ?? null,
    payload: entry.payload ?? null,
    unlimitedAmmo: entry.ammo === Infinity,
    values,
  };
}

export const WEAPON_IDS = [
  ...live.weapons.WEAPON_TYPES.map((w) => w.id),
  ...live.weapons.ENEMY_WEAPON_TYPES.map((w) => w.id),
];

export function buildAllWeaponState() {
  return WEAPON_IDS.map(buildWeaponState);
}

// The shop's catalogue (game/upgrades.js) — two shelves, and they are edited
// as two different shapes for the same reason the file that owns them treats
// them as two different kinds of thing (see its own header): a CONSUMABLE is
// a flat price plus "how much", and a STAT is a tier ladder whose only tunable
// numbers are its price and what one tier adds.
//
// `base` (a stock car's own figure) is deliberately NOT surfaced as editable
// here — it is imported into upgrades.js from cartypes.js/player.js precisely
// so the ladder can never drift from the car, and an editor field for it would
// be a second place that fact could be set wrong. Tune the car, not the shop,
// to move where a stat starts.
export const UPGRADE_CONSUMABLE_IDS = live.upgrades.CONSUMABLES.map((e) => e.id);
export const UPGRADE_STAT_IDS = live.upgrades.STATS.map((s) => s.id);

// A consumable's "how much" lives on a different field per `kind` — `amount`
// for AMMO and HEAL, `duration` for SHIELD — mirroring PICKUP_EFFECT_FIELDS
// above exactly, because upgrades.js's consumables spend through the very same
// applyPickup() switch a crate does (see that file's header).
export const UPGRADE_CONSUMABLE_EFFECT_FIELD_BY_KIND = {
  ammo: "amount",
  heal: "amount",
  shield: "duration",
};

export function buildUpgradeConsumableState(id) {
  const entry = live.upgrades.CONSUMABLES.find((e) => e.id === id);
  if (!entry) {
    throw new Error(`buildUpgradeConsumableState: unknown consumable id "${id}"`);
  }
  const effectField = UPGRADE_CONSUMABLE_EFFECT_FIELD_BY_KIND[entry.kind];
  const values = { price: entry.price };
  if (effectField) values[effectField] = entry[effectField];
  return {
    id: entry.id,
    label: entry.label,
    kind: entry.kind,
    values,
    // Shown for context (which weapon a row rearms) but not itself editable —
    // renaming what a row spends on is a catalogue restructure, not a tuning
    // pass, and belongs in code review rather than a number field.
    weaponId: entry.weaponId ?? null,
    effectField,
  };
}

export function buildAllUpgradeConsumableState() {
  return UPGRADE_CONSUMABLE_IDS.map(buildUpgradeConsumableState);
}

export function buildUpgradeStatState(id) {
  const stat = live.upgrades.statById(id);
  if (!stat) {
    throw new Error(`buildUpgradeStatState: unknown stat id "${id}"`);
  }
  return {
    id: stat.id,
    label: stat.label,
    values: { price: stat.price, step: stat.step },
    // Read-only context so the editor can show what tier 1 actually buys
    // (base -> base + step) without the caller re-importing upgrades.js's own
    // formatting rules.
    base: stat.base,
    unit: stat.unit,
    decimals: stat.decimals,
  };
}

export function buildAllUpgradeStatState() {
  return UPGRADE_STAT_IDS.map(buildUpgradeStatState);
}
