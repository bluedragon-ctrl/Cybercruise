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
    id: "driving",
    label: "Driving tactics",
    // The counterpart to the behavior screen. A PROFILE says how boldly one
    // driver runs a manoeuvre; these say what the manoeuvre IS, so each of them
    // reaches every type on that tactic at once. They live in behaviours.js
    // rather than on a profile because each is arithmetic against another file
    // — the player's minimum speed, the mine layer's window, the road a hazard
    // may be spawned on — which no single profile could state correctly.
    note: "Shared figures behind the hostile tactics (behaviours.js). A driving profile decides how boldly one type runs a manoeuvre; these decide what the manoeuvre is, so a change here reaches every type on that tactic at once.",
    constants: [
      {
        id: "driving.PURSUE_RANGE", name: "PURSUE_RANGE", file: "src/game/behaviours.js", min: 1,
        description: "Gap (world units) inside which a chasing car actually chases; outside it, it just cruises. Must stay ABOVE every profile's pursueHold, or a hostile would only give chase once it was already closer than it wanted to be.",
      },
      {
        id: "driving.RAM_FLOOR", name: "RAM_FLOOR", file: "src/game/behaviours.js", min: 1,
        description: "Slowest speed the bruiser's roadblock runs at once it is ahead of the player. Must stay UNDER the player's own MIN_SPEED (World -> Player car), or simply lifting off the throttle would out-slow the block and the second half of the ram goes slack.",
      },
      {
        id: "driving.LOOK_BEHIND_SLACK", name: "LOOK_BEHIND_SLACK", file: "src/game/behaviours.js", min: 0,
        description: "Daylight (world units) a driver wants BEHIND the point where two cars stop overlapping, before it will move sideways into that lane. Not a mirror check — nothing on this road reacts to a car behind it — but the tail of 'is the space I am moving into empty', since a body whose centre trails this one's by less than their combined half-length is alongside it. The overlap itself is derived from the two cars' own lengths; this is only the margin on top, sized so a body just past the line cannot be alongside by the time a ~0.4s lane change finishes.",
      },
      {
        id: "driving.RAM_BRAKE", name: "RAM_BRAKE", file: "src/game/behaviours.js", min: 0.01,
        description: "The fraction of the PLAYER'S own speed the bruiser's roadblock runs at once it is ahead of them, which is what makes the block bite at any speed rather than only at the one it was tuned against. RAM_FLOOR above is the floor under it, and the two cross at player speed 160 — below that this does nothing. Raising it toward 1 makes the block a gentler nudge; lowering it toward the floor makes each hit roughly twice as expensive FOR BOTH CARS, since impact damage is symmetric in closing speed.",
      },
      {
        id: "driving.TRAIL_ENGAGE", name: "TRAIL_ENGAGE", file: "src/game/behaviours.js", min: 1,
        description: "Gap within which the stocker counts as still in contact with the player. Its give-up clock only runs OUTSIDE this, so it has to stay above that profile's pursueHold — otherwise a stocker holding its station perfectly would still time out and ride off.",
      },
      {
        id: "driving.RAID_CLEARANCE", name: "RAID_CLEARANCE", file: "src/game/behaviours.js", min: 0,
        description: "Extra px the cycle and the sower hold clear of the player's own line while still fighting their way past traffic, so an ordinary overtake never satisfies the mine layer's aim and drops their one charge early.",
      },
      {
        id: "driving.HAZARD_DODGE_SPAN", name: "HAZARD_DODGE_SPAN", file: "src/game/behaviours.js", min: 0.1,
        description: "Lane widths a car assumes it may have to cross to get round a roadblock. This feeds the road every type needs to see a hazard coming, and obstacles.js sizes its whole spawn margin from that — so raising it pushes every hazard further up the road.",
      },
      {
        id: "driving.HAZARD_SAFETY", name: "HAZARD_SAFETY", file: "src/game/behaviours.js", min: 1,
        description: "Slack multiplier on that dodge distance, so a car arrives already clear of an obstacle rather than finishing its swerve exactly at it.",
      },
    ],
  },
  {
    id: "impact",
    label: "Ramming & contact",
    // Why these belong on a car-tuning tool at all: a profile's `contact`
    // ceiling is a HULL COST, and nothing in driving.js decides what a hull
    // cost is — these do. The rig's dial is binary rather than graded purely
    // because its steerSpeed of 35 sits under DAMAGE_FLOOR's 40, and that is a
    // relation between two files a tuner has to be able to see both halves of.
    note: "What a collision costs. Every driving profile's contact ceiling is priced against these, so they decide whether a type's dial has a usable range at all or only never and always — a car steering slower than DAMAGE_FLOOR prices every lane change it could make at zero.",
    constants: [
      {
        id: "impact.DAMAGE_FLOOR", name: "DAMAGE_FLOOR", file: "src/game/collisions.js", min: 0,
        description: "Closing speed that does no harm at all. Also the floor a lane change is priced against, so a type steering slower than this (the rig, at 35) prices every lane change at zero hull and its contact dial has only two settings rather than a range.",
      },
      {
        id: "impact.IMPACT_DAMAGE", name: "IMPACT_DAMAGE", file: "src/game/collisions.js", min: 0.001,
        description: "Hull lost per unit of closing speed above the floor. At equal mass a 300 unit/sec rear-end costs each car (300 - DAMAGE_FLOOR) times this.",
      },
      {
        id: "impact.SIDE_DAMAGE", name: "SIDE_DAMAGE", file: "src/game/collisions.js", min: 0.001,
        description: "How much of a head-on a side-swipe costs at the same speed. behaviours.js prices every lane change as a side-swipe, so this scales what contact means for every profile at once.",
      },
      {
        id: "impact.PUSH_GAIN", name: "PUSH_GAIN", file: "src/game/collisions.js", min: 0,
        description: "Sideways speed handed to a body per px of overlap, per second. This is what turns steady pressure into a slide that keeps going after contact ends, and what carries an impact down a chain of cars.",
      },
      {
        id: "impact.RESTITUTION", name: "RESTITUTION", file: "src/game/collisions.js", min: 0,
        description: "Bounce, 0..1. Deliberately low: cars crumple, they do not ping.",
      },
      {
        id: "impact.RAM_MAXED_ATTACK_FLOOR", name: "RAM_MAXED_ATTACK_FLOOR", file: "src/game/collisions.js", min: 0,
        description: "The maxed RAM PLATE's own damage floor, replacing DAMAGE_FLOOR on the PLAYER's hits only. Lower means ordinary driving contact starts to cost the other car something, not just a charge lined up in advance.",
      },
      {
        id: "impact.RAM_MAXED_SHOVE_POWER", name: "RAM_MAXED_SHOVE_POWER", file: "src/game/collisions.js", min: 0,
        description: "How much harder a maxed RAM PLATE's side-swipes shove whatever they land on. Above 1 a hit is meant to carry into the struck car's neighbour as well as clearing the first overlap.",
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
  {
    id: "siphon",
    label: "Siphon rig",
    // The SIPHON RIG has no row of its own under Shop → Car systems — every
    // other stat there is a base+step ladder, and this one isn't (see
    // upgrades.js's own comment on the `siphon` STATS entry), so
    // state.js's UPGRADE_STAT_IDS excludes it and ALL of its numbers,
    // PRICE included, are retuned from here instead. upgrades.js reads
    // PRICE and YIELD_T1/T2/T3 below DIRECTLY, so a retune here is what the
    // shop shelf prints. Reach and drain never got shelf rows of their own —
    // see wallet.js's own SIPHON_YIELDS header for why.
    //
    // STOCK, then the three tiers the rig can be bought up to. The first three
    // rows (LINK_RADIUS/LINK_NEAR_TIME/LINK_FAR_TIME) are what a car with NO
    // rig bought reads — index 0 of every array below is fixed to the first
    // two of them rather than a restated literal — and are also the base every
    // hunter/crawler style in tools/econsim.js is measured against.
    note: "What a node's siphon actually costs and pays, stock and at every SIPHON RIG tier, plus what the rig itself costs to buy — the SIPHON RIG has no row under Shop → Car systems, so this is the only place any of it is retuned. PRICE and the yield column are the same numbers the shop shelf prints.",
    constants: [
      {
        id: "siphon.PRICE", name: "SIPHON_PRICE", file: "src/game/wallet.js", min: 1,
        description: "Credits for ONE tier of the rig (tiers 2 and 3 cost this times upgrades.js's TIER_PRICES, same as every other shop stat). THE SHOP SHELF CHARGES THIS SAME NUMBER — it is read live, so there is nothing else to retune to match it.",
      },
      {
        id: "siphon.LINK_RADIUS", name: "LINK_RADIUS", file: "src/game/wallet.js", min: 1,
        description: "Siphon reach on a STOCK car (no rig bought), in px from the car to a node's marker. Also what a node's price fades in from, and the far end of the drain curve below.",
      },
      {
        id: "siphon.LINK_NEAR_TIME", name: "LINK_NEAR_TIME", file: "src/game/wallet.js", min: 0.01,
        description: "Seconds to drain a node at POINT BLANK — the near end of the falloff curve, and the one figure the rig never moves at any tier: only the far end (below) gets faster as the rig is upgraded.",
      },
      {
        id: "siphon.LINK_FAR_TIME", name: "LINK_FAR_TIME", file: "src/game/wallet.js", min: 0.05,
        description: "Seconds to drain a node at the OUTER edge of LINK_RADIUS, on a stock car. This is what the rig's FAR_TIME_T1/2/3 rows below count down from — 4s stock, 3/2/1s at tier 1/2/3.",
      },
      {
        id: "siphon.RANGE_T1", name: "SIPHON_RANGES", index: 1, file: "src/game/wallet.js", min: 1,
        description: "Siphon reach at tier 1, in px — how far off a node this can still be entitled to drain. Stock (index 0) is LINK_RADIUS, above.",
      },
      {
        id: "siphon.RANGE_T2", name: "SIPHON_RANGES", index: 2, file: "src/game/wallet.js", min: 1,
        description: "Siphon reach at tier 2, px.",
      },
      {
        id: "siphon.RANGE_T3", name: "SIPHON_RANGES", index: 3, file: "src/game/wallet.js", min: 1,
        description: "Siphon reach at tier 3 (maxed), px.",
      },
      {
        id: "siphon.FAR_TIME_T1", name: "SIPHON_FAR_TIMES", index: 1, file: "src/game/wallet.js", min: 0.05,
        description: "Seconds to drain a node at the OUTER edge of reach, tier 1. The near end never moves — LINK_NEAR_TIME is the same 0.3s for every tier — so this is the whole size of what the rig buys on this axis.",
      },
      {
        id: "siphon.FAR_TIME_T2", name: "SIPHON_FAR_TIMES", index: 2, file: "src/game/wallet.js", min: 0.05,
        description: "Seconds to drain a node at the outer edge of reach, tier 2.",
      },
      {
        id: "siphon.FAR_TIME_T3", name: "SIPHON_FAR_TIMES", index: 3, file: "src/game/wallet.js", min: 0.05,
        description: "Seconds to drain a node at the outer edge of reach, tier 3 (maxed) — 1s by design, not a smoothed curve: the wait itself is the pain the rig is sold to fix.",
      },
      {
        id: "siphon.YIELD_T1", name: "SIPHON_YIELDS", index: 1, file: "src/game/wallet.js", min: 0.01,
        description: "Payout multiplier at tier 1 — 1.20 means every node pays 20% more. THE IN-GAME SHOP SHELF PRINTS THIS SAME NUMBER (as a %, on its SIPHON RIG row) — it is read live, so there is nothing else to retune to match it.",
      },
      {
        id: "siphon.YIELD_T2", name: "SIPHON_YIELDS", index: 2, file: "src/game/wallet.js", min: 0.01,
        description: "Payout multiplier at tier 2. The in-game shop shelf reads this one live too.",
      },
      {
        id: "siphon.YIELD_T3", name: "SIPHON_YIELDS", index: 3, file: "src/game/wallet.js", min: 0.01,
        description: "Payout multiplier at tier 3 (maxed). The in-game shop shelf reads this one live too.",
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
