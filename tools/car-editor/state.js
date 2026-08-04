// Reads the whole roster's CURRENT values by importing the real game
// modules — same trick tools/drivesim.js already uses — so the editor never
// shows a stale snapshot. A field is reported "inherited" when its value
// equals the commuter default, which is a value-based approximation of "not
// explicitly overridden in the source": correct in every case the source
// actually looks like today, and if a profile were ever written to spell
// out a value equal to the default anyway, the worst outcome is a cosmetic
// "(overridden)" tag missing in the UI — not a wrong edit.

import { CAR_TYPES, carTypeById } from "../../src/game/cartypes.js";
import { DRIVING_PROFILES, drivingFor } from "../../src/game/driving.js";
import { OBSTACLE_TYPES, obstacleTypeById } from "../../src/game/obstacletypes.js";

// Derived from the catalogue itself, civilian and hostile alike, so a type
// added to cartypes.js shows up here without a second list to remember to
// update — the same reasoning the gallery in src/demo/gallery.js already
// applies to the same catalogue.
export const CAR_IDS = CAR_TYPES.map((t) => t.id);

export const HULL_SPEED_FIELDS = ["health", "speedMin", "speedMax"];

// `minDistance` lives on the CAR_TYPES entry, same as the hull/speed fields
// above, but it isn't a hull or speed number — it's spawn gating (see
// cartypes.js's ENEMY_MIN_DISTANCE comment) — so it gets its own list rather
// than blurring into HULL_SPEED_FIELDS's name.
export const SPAWN_FIELDS = ["minDistance"];

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
  if (!CAR_IDS.includes(carId)) {
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
    faction: type.faction,
    hull: { health: type.health },
    speed: { speedMin: type.speedMin, speedMax: type.speedMax },
    spawn: { minDistance: type.minDistance ?? 0 },
    behavior,
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
export const OBSTACLE_IDS = OBSTACLE_TYPES.map((t) => t.id);

export const OBSTACLE_FIELDS = ["weight", "minDistance"];

export function buildObstacleState(obstacleId) {
  if (!OBSTACLE_IDS.includes(obstacleId)) {
    throw new Error(`buildObstacleState: unknown obstacle id "${obstacleId}"`);
  }
  const type = obstacleTypeById(obstacleId);
  return {
    id: type.id,
    label: type.label,
    spawn: { weight: type.weight, minDistance: type.minDistance ?? 0 },
  };
}

export function buildAllObstacleState() {
  return OBSTACLE_IDS.map(buildObstacleState);
}
