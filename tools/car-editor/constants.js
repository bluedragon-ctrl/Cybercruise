// tools/car-editor/constants.js
//
// The tunable numbers that are NOT catalogue entries.
//
// state.js reads five arrays of objects — cars, obstacles, pickups, weapons,
// the shop's two shelves — each anchored by an `id`, and patcher.js's
// text-surgery finds an entry by that id. A large share of what actually
// decides how the game feels has no id at all: it is a plain
// `const NAME = <number>;` at the top of the module that uses it. The player's
// own speed and hull, how many cars share the road, the shape of the road
// itself, how far apart the shops sit. This file is the catalogue for those.
//
// Values are read straight out of the SOURCE TEXT rather than by importing the
// modules, for two reasons. Several of the most useful figures are
// module-private (traffic.js's MAX_CARS, player.js's STEER_SPEED) and cannot
// be imported at all; and reading text means these can never go stale the way
// an ES-module import does after a tuning session writes the file (which is
// the whole problem state.js's refreshCatalogues() exists to work around).

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

// Grouped the way the editor shows them: a group is a screen, and the grouping
// is by what a change to any of them DOES, not by which file it happens to
// live in — "Run pacing" spans three modules and is still one decision.
//
// Per constant:
//   id     stable key the editor and the API use; qualified by group because
//          the bare names collide (player.js and traffic.js both export ACCEL)
//   name   the identifier as it is declared in the source
//   file   repo-relative path of the module declaring it
//   index  OPTIONAL — for an array constant, which element this row edits
//   min    OPTIONAL lower bound, enforced by the server and hinted in the UI
export const CONSTANT_GROUPS = [
  {
    id: "player",
    label: "Player car",
    // These three are the `base` figures upgrades.js imports for its ladder
    // (see state.js's note on why a stat's base is not editable on the shop
    // screen). This is the "tune the car, not the shop" that note points at —
    // moving MAX_SPEED here moves where the ENGINE ladder starts, and the
    // shop's own preview follows it.
    note: "The stock car, before anything is bought. MAX_SPEED, BASE_MAX_HEALTH and PLAYER_MASS are the figures the shop's upgrade ladders count up from.",
    constants: [
      {
        id: "player.MIN_SPEED", name: "MIN_SPEED", file: "src/game/player.js", min: 1,
        description: "Slowest the player can go, in world units/sec. Also the speed the road scrolls at — the car never actually stops.",
      },
      {
        id: "player.MAX_SPEED", name: "MAX_SPEED", file: "src/game/player.js", min: 1,
        description: "Top speed of a STOCK car, in world units/sec. The ENGINE upgrade counts up from this, so every tier moves with it.",
      },
      {
        id: "player.ACCEL", name: "ACCEL", file: "src/game/player.js", min: 1,
        description: "Speed gained per second at full throttle. How quickly the car answers the accelerator, independent of where its top speed is.",
      },
      {
        id: "player.STEER_SPEED", name: "STEER_SPEED", file: "src/game/player.js", min: 1,
        description: "Sideways travel in px/sec at full lock — how fast the car crosses lanes. Compare against a hostile's own steerSpeed to see who can cut whom off.",
      },
      {
        id: "player.BASE_MAX_HEALTH", name: "BASE_MAX_HEALTH", file: "src/game/player.js", min: 1,
        description: "Hull of a STOCK car. The CHASSIS upgrade counts up from this.",
      },
      {
        id: "player.PLAYER_MASS", name: "PLAYER_MASS", file: "src/game/player.js", min: 0.01,
        description: "How heavy the player is in a collision, against the traffic's own `mass`. The RAM PLATE upgrade counts up from this.",
      },
    ],
  },
  {
    id: "traffic",
    label: "Traffic density",
    note: "How busy the road is. These are global: a car type's own `weight` decides its share of the traffic, these decide how much traffic there is to share.",
    constants: [
      {
        id: "traffic.MAX_CARS", name: "MAX_CARS", file: "src/game/traffic.js", min: 1,
        description: "How many cars are simulated at once. The single strongest dial on how crowded the road feels, and the one that costs the most frame time.",
      },
      {
        id: "traffic.SPAWN_INTERVAL", name: "SPAWN_INTERVAL", file: "src/game/traffic.js", min: 0.01,
        description: "Seconds between spawn ATTEMPTS. An attempt can still fail for want of room (see SPAWN_GAP), so this is a ceiling on the arrival rate, not the rate itself.",
      },
      {
        id: "traffic.SPAWN_GAP", name: "SPAWN_GAP", file: "src/game/traffic.js", min: 0,
        description: "Minimum clear road, in world units, between a new car and whatever is already there. Raising it thins traffic no matter what MAX_CARS says.",
      },
      {
        id: "traffic.SPAWN_MARGIN", name: "SPAWN_MARGIN", file: "src/game/traffic.js", min: 0,
        description: "How far past the screen edge a car appears, in world units. Too small and cars visibly pop into existence.",
      },
      {
        id: "traffic.RETIRE_MARGIN", name: "RETIRE_MARGIN", file: "src/game/traffic.js", min: 0,
        description: "How far past the screen edge a car is dropped again. Must stay comfortably above SPAWN_MARGIN or cars retire while still visible.",
      },
      {
        id: "traffic.ACCEL", name: "ACCEL", file: "src/game/traffic.js", min: 1,
        description: "World units/sec² the traffic uses to reach its target speed. Distinct from the player's own ACCEL — this is how briskly other cars adjust.",
      },
    ],
  },
  {
    id: "road",
    label: "Road shape",
    note: "The wander of the road itself. tuning.js documents each of these at length — the short version is here; the trade-offs are in the file.",
    constants: [
      {
        id: "road.ROAD_AMPLITUDE", name: "ROAD_AMPLITUDE", file: "src/game/tuning.js", min: 0,
        description: "How far the road centre may sit from the canvas centre, in px. Raising it steepens every turn in proportion.",
      },
      {
        id: "road.ROAD_STRAIGHTNESS", name: "ROAD_STRAIGHTNESS", file: "src/game/tuning.js", min: 1,
        description: "How hard the wander is driven into its clip. 1 = never straight; 2.8 (default) = about 62% straight. Past ~3 the turns read as kinks rather than curves.",
      },
      {
        id: "road.ROAD_TURN_RATE", name: "ROAD_TURN_RATE", file: "src/game/tuning.js", min: 0.01,
        description: "How quickly the road works through its shape. Bigger = shorter straights AND shorter, sharper turns; smaller = a longer, lazier road.",
      },
      {
        id: "road.ROAD_WAVE_A_FREQ", name: "ROAD_WAVE_A_FREQ", file: "src/game/tuning.js", min: 0,
        description: "Frequency of the first of the two summed waves, in radians per world unit, before ROAD_TURN_RATE scales it.",
      },
      {
        id: "road.ROAD_WAVE_A_WEIGHT", name: "ROAD_WAVE_A_WEIGHT", file: "src/game/tuning.js", min: 0,
        description: "Relative strength of the first wave. Only the ratio against wave B matters — the pair is normalised.",
      },
      {
        id: "road.ROAD_WAVE_B_FREQ", name: "ROAD_WAVE_B_FREQ", file: "src/game/tuning.js", min: 0,
        description: "Frequency of the second wave. Kept deliberately non-harmonic against wave A so the pattern of straights and bends never visibly repeats.",
      },
      {
        id: "road.ROAD_WAVE_B_WEIGHT", name: "ROAD_WAVE_B_WEIGHT", file: "src/game/tuning.js", min: 0,
        description: "Relative strength of the second wave. Raising it toward wave A's makes the road busier and less predictable.",
      },
      {
        id: "road.ROAD_WAVE_B_PHASE", name: "ROAD_WAVE_B_PHASE", file: "src/game/tuning.js", min: 0,
        description: "Phase offset of the second wave, in radians. Shifts where the two waves reinforce, and so where the sharpest bends land.",
      },
    ],
  },
  {
    id: "run",
    label: "Run pacing & economy",
    note: "How long a run takes to develop, and how fast credits arrive against what they buy. These span three modules but they are one balance decision.",
    constants: [
      {
        id: "run.SHOP_INTERVAL", name: "SHOP_INTERVAL", file: "src/game/hauler.js", min: 1,
        description: "DIST-readout units between shop stops. Against the per-kill bounty this decides how much you can afford at each dock — the core economy pacing dial.",
      },
      {
        id: "run.APPROACH_DURATION", name: "APPROACH_DURATION", file: "src/game/hauler.js", min: 0.1,
        description: "Seconds the hauler spends closing in before the lift starts. Presentation, not balance — but a long one is dead time every stop.",
      },
      {
        id: "run.LIFT_DURATION", name: "LIFT_DURATION", file: "src/game/hauler.js", min: 0.1,
        description: "Seconds the car spends being lifted off the road. Same trade as APPROACH_DURATION: read against how often SHOP_INTERVAL makes it happen.",
      },
      {
        id: "run.DISTANCE_POINTS", name: "DISTANCE_POINTS", file: "src/game/score.js", min: 0,
        description: "Score per world unit driven, before any kills. Sets how much of a score is just surviving versus fighting.",
      },
      {
        id: "run.TIER_PRICE_2", name: "TIER_PRICES", index: 1, file: "src/game/upgrades.js", min: 0.01,
        description: "Multiplier on a stat's own price for TIER 2. The shop screen's own field only sets tier 1's price; this and the next are the shape of the ladder above it.",
      },
      {
        id: "run.TIER_PRICE_3", name: "TIER_PRICES", index: 2, file: "src/game/upgrades.js", min: 0.01,
        description: "Multiplier on a stat's own price for TIER 3. Raising it makes maxing a system a run's worth of saving; lowering it makes owning everything routine.",
      },
    ],
  },
];

export const CONSTANTS = CONSTANT_GROUPS.flatMap((group) =>
  group.constants.map((entry) => ({ ...entry, groupId: group.id, groupLabel: group.label }))
);

export const CONSTANT_IDS = CONSTANTS.map((c) => c.id);

export const CONSTANT_BY_ID = new Map(CONSTANTS.map((c) => [c.id, c]));

// Every file this catalogue touches, deduplicated — the commit handler reads
// and writes exactly this set, and nothing else.
export const CONSTANT_FILES = [...new Set(CONSTANTS.map((c) => c.file))];

// The same anchoring patcher.js uses to WRITE a constant, used here to READ
// one: line-anchored so a name mentioned in one of these files' (long)
// explanatory comments is never mistaken for its declaration.
function declarationPattern(name) {
  return String.raw`^[ \t]*(?:export[ \t]+)?const[ \t]+${name}(?![A-Za-z0-9_$])[ \t]*=[ \t]*`;
}

export function readConstantValue(sourceText, name, index) {
  if (index === undefined) {
    const match = sourceText.match(
      new RegExp(declarationPattern(name) + String.raw`(-?[0-9.]+(?:[eE]-?[0-9]+)?)`, "m")
    );
    if (!match) throw new Error(`readConstantValue: no numeric "const ${name}" found`);
    return Number(match[1]);
  }
  const match = sourceText.match(
    new RegExp(declarationPattern(name) + String.raw`\[([^\]]*)\]`, "m")
  );
  if (!match) throw new Error(`readConstantValue: no array "const ${name}" found`);
  const elements = match[1].split(",");
  if (index < 0 || index >= elements.length) {
    throw new Error(`readConstantValue: ${name} has ${elements.length} elements, no index ${index}`);
  }
  const value = Number(elements[index].trim());
  if (!Number.isFinite(value)) {
    throw new Error(`readConstantValue: ${name}[${index}] is not a plain number`);
  }
  return value;
}

// One file read per constant would re-read the same four files a dozen times;
// this reads each once per call instead. Nothing is cached BETWEEN calls on
// purpose — a stale read here is exactly the bug this module is shaped to
// avoid.
export function buildAllConstantState() {
  const sources = new Map(
    CONSTANT_FILES.map((file) => [file, readFileSync(path.join(REPO_ROOT, file), "utf8")])
  );
  return CONSTANT_GROUPS.map((group) => ({
    id: group.id,
    label: group.label,
    note: group.note,
    constants: group.constants.map((entry) => ({
      id: entry.id,
      name: entry.name,
      // A row for one element of an array constant says so, so the form is not
      // two identically-labelled TIER_PRICES fields.
      label: entry.index === undefined ? entry.name : `${entry.name}[${entry.index}]`,
      file: entry.file,
      description: entry.description,
      min: entry.min ?? null,
      value: readConstantValue(sources.get(entry.file), entry.name, entry.index),
    })),
  }));
}

export function buildConstantState(id) {
  const entry = CONSTANT_BY_ID.get(id);
  if (!entry) throw new Error(`buildConstantState: unknown constant id "${id}"`);
  const source = readFileSync(path.join(REPO_ROOT, entry.file), "utf8");
  return { ...entry, value: readConstantValue(source, entry.name, entry.index) };
}
