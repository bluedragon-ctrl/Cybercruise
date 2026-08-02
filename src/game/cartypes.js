// The traffic catalogue — every kind of car on the road other than the player.
//
// A type is pure DATA: how it looks, how fast it drives, how much punishment it
// takes, how big a hole it leaves when it goes up, and which BEHAVIOUR drives it
// (see behaviours.js). Adding a new kind of traffic means adding an entry here
// and, if it needs new tactics, a behaviour function. Nothing in traffic.js knows
// any type by name.
//
// ONE TYPE PER SILHOUETTE. The catalogue is a 1:1 map onto game/carshapes.js:
// every shape in that file is exactly one type here, and the shape is what tells
// them apart on the road. Colour only carries FACTION and WEIGHT CLASS, so shades
// repeat across types (see palette.js) — a red car is hostile, a big red car is
// hostile and heavy, and which car it is comes from its outline. The one shape
// shared with the player (SUPERCAR) is deliberately given to an ENEMY: your own
// silhouette coming at you in red reads instantly as a rival, where a civilian
// copy of the player's car would just look like a bug.
//
// THE SPEED BAND. The player runs 120..620 (player.js), and the catalogue is
// pinned to both ends of that:
//
//   FLOOR    the slowest type cruises at 180 — half again the player's minimum.
//            Dawdling therefore never makes the road go quiet; it makes the
//            whole city stream past you, which is the point of a minimum speed.
//   CEILING  the fastest types cruise ABOVE 620, so flat out is not fast enough
//            to be left alone: a cycle will still come past a player at full
//            throttle. Nothing in the game should be outrun by simply holding
//            the throttle down — that is what the Phase 5 boosts are for, and
//            they only mean something if there is something to catch.
//
// Everything else is spread between those two, ordered by role: haulers at the
// bottom, the enemy mid-field around 300-500, and the three genuine speed
// machines (rival, hypercar, cycle) at or over the player's ceiling.
//
// WITHIN a type, no two cars drive alike, and none of it costs a sprite:
//   - the range is ROLLED per spawn, so two sedans start out different;
//   - each car then WANDERS ±4% around its roll on its own period, so a pair
//     that happened to roll close together separates instead of locking into
//     formation (traffic.js DRIFT);
//   - an overtaker spends up to its profile's `passEffort` more while it is
//     committed to a pass (driving.js), so passing reads as effort.
// Civilian types carry the widest ranges, since a civilian type is a spread of
// ordinary drivers; the speed machines are defined by their ceiling and stay
// narrow. Both extras are CAPPED by speedMin/speedMax, so the band below is a
// hard floor and ceiling and everything after this paragraph still holds.
//
// The band's WIDTH is not free: traffic sheds speed at traffic.js's ACCEL, and
// behaviours.js sizes a follower's gap from that rate. The largest closing speed
// the catalogue can now produce is 730 - 120 = 610 units/sec, and ACCEL is set so
// one second of closing rate still covers the road needed to match it. Widening
// the band further means revisiting that pair — see driving.js's followReaction,
// which is now sized PER PROFILE against the types that actually drive it.
//
// SPRITE-CACHE BUDGET. Every distinct (shape, color, thrust, w, h) combination is
// a cache key in sprites.js, times WHEEL_FRAMES (8) wheel positions, plus one
// more colour for the critical-hull blink: 10 types * 8 * 2 = 160 sprites at the
// absolute worst, built lazily as each type first appears. That is the same order
// as the city's building cache. Keeping the catalogue a small FIXED list is what
// bounds it — so vary cars by ADDING A TYPE, never by rolling continuous
// per-instance sizes or colours. Per-instance variety comes from
// `speedMin`..`speedMax`, which costs nothing because speed doesn't affect the
// artwork.

import { carShapeIndex } from "./carshapes.js";
import { DIST_UNITS } from "./road.js";
import {
  ENEMY,
  ENEMY_DEEP,
  ENEMY_PALE,
  ENEMY_THRUST,
  NEUTRAL,
  NEUTRAL_DEEP,
  NEUTRAL_PALE,
  NEUTRAL_THRUST,
} from "../engine/palette.js";

// Factions decide who a behaviour is allowed to be interested in. Colour follows
// the faction — see the palette. Scoring follows it too, but only by CONVENTION:
// the scoreboard reads `value` off the type and never asks what faction a car
// belonged to (score.js), which is what leaves room for a civilian that is worth
// killing, or a hostile that is worth more than the rest.
export const NEUTRAL_FACTION = "neutral";
export const ENEMY_FACTION = "enemy";

// Starting point for `value`, below: one flat figure for the enemy and its
// mirror image for the city's traffic. Deliberately UNIFORM for now — the point
// of putting the number on every type separately is that it can be spread out
// later (a rig worth more than a sedan, a rival worth more than an interceptor)
// without touching score.js. Tune the entries, not these two constants, once
// there is a reason to tell types apart.
const ENEMY_VALUE = 100;
const CIVILIAN_VALUE = -100;

// THE OPENING ROAD IS CIVILIAN. Every hostile type is held back until the player
// has covered this much road, measured in the DIST readout's units (road.js), so
// the run starts as ordinary traffic and the enemy arrives as a CHANGE the player
// can feel rather than as the state of the world from the first second. It also
// gives the opening a job: learn the car and the traffic before anything is out
// here for you.
//
// 100 on the odometer is 10,000 world units — roughly 16 seconds flat out, or a
// minute and a half at the player's minimum, so dawdling buys a longer quiet
// spell. That is deliberate: speed is what asks for the trouble.
//
// One figure for the whole faction for now, exactly as ENEMY_VALUE is — the
// point of putting `minDistance` on every type separately is that the enemy can
// later be STAGED (interceptors early, a rival only much later) without touching
// a line of traffic.js. Spread the entries when there is a reason to; leave this
// constant as the faction's floor.
const ENEMY_MIN_DISTANCE = 100;

// TWO AXES OF BEHAVIOUR, and a type names both.
//
//   behaviour  the TACTIC — which manoeuvres this car knows (behaviours.js)
//   driving    the PROFILE — how boldly it runs them (driving.js)
//
// That split is what makes a new type cheap. Before it, everything a driver
// might feel about the road was hard-coded in behaviours.js, so two civilians
// naming `overtake` drove identically and telling them apart meant writing a
// second function. Now the sedan and the roadster share one tactic and differ
// entirely in the table they point at — including `nerve`, which used to sit
// here among the physical stats and is a disposition rather than a property of
// the chassis. Nothing outside behaviours.js ever read it.
//
// A type that names no profile gets the commuter's, which is the sedan's: bland,
// careful, and obviously so.

// Fields:
//   id          stable key (save data, spawn tables, debugging)
//   label       gallery/HUD caption
//   shape       index into CAR_SHAPES — the car's silhouette, looked up BY NAME
//               so reordering that catalogue can't repaint the road
//   faction     NEUTRAL_FACTION | ENEMY_FACTION
//   color       body wireframe colour; thrust = exhaust glow
//   w, h        collision box AND drawn size (px). Kept at (or near) the shape's
//               own default size, since the artwork is authored for that ratio
//   health      hull points; spent by ramming (collisions.js), by blasts, and
//               from Phase 4 by weapons. At zero the car explodes and leaves the
//               road (see traffic.js detonate)
//   mass        how hard it is to shove, relative units — only ratios matter.
//               Ramming splits movement and damage by INVERSE mass, so this is
//               the difference between bouncing off a rig and swatting a roadster
//               aside. Roughly tracks size, but it's a gameplay dial: nudge it to
//               make a type feel heavier without redrawing it
//   speedMin/Max  cruising speed range, world units/sec. See THE SPEED BAND
//   steerSpeed  how fast the car can slide sideways, px/sec — a behaviour asks
//               for a lateral position and this caps how quickly it gets there,
//               so a rig wallows and a cycle darts
//   blastRadius how far the death explosion hurts, in px measured from the car's
//               BOX EDGE outward (so a long rig doesn't get a free extra reach
//               along its own length). Lane width is 65px for scale
//   blastDamage hull taken at the centre of that blast, falling off linearly to
//               nothing at the rim. The player has 100 hull
//   value       points scored for DESTROYING this car (score.js). Positive for
//               the enemy, negative for the city's own traffic — killing a
//               civilian is a fine, not a reward. Paid however the car died,
//               including a chain reaction the player only lit the fuse for
//   behaviour   key into behaviours.js — the TACTIC. The nimble types `overtake`
//               — they pull out and pass whatever is holding them up, the player
//               included; the heavy ones `cruise`, so sitting in front of a rig
//               means it stays there. That split is what stops every car on the
//               road weaving at once. The enemy tactics still borrow their
//               driving from those two
//   driving     key into driving.js — the PROFILE: following distances, patience,
//               lane discipline, and how much hull this driver will accept
//               hitting. Omitted means `commuter`
//   weight      relative spawn frequency
//   minDistance how far the player must have driven before this type may spawn
//               at all, in DIST-READOUT units (road.js's DIST_UNITS) — the same
//               number the HUD shows, so a gate reads as "this turns up at DIST
//               100". 0 means from the first metre. Once the gate opens the type
//               is picked on `weight` as usual; this only decides WHETHER it is
//               in the draw. See ENEMY_MIN_DISTANCE above for why the enemy
//               starts late, and pickCarType for what happens when everything is
//               still gated
export const CAR_TYPES = [
  // --- Neutral: the city's own traffic --------------------------------------
  {
    id: "sedan",
    label: "SEDAN",
    shape: carShapeIndex("SEDAN"),
    faction: NEUTRAL_FACTION,
    color: NEUTRAL,
    thrust: NEUTRAL_THRUST,
    w: 34,
    h: 60,
    health: 60,
    mass: 1, // the reference car: everything else is heavier or lighter than this
    // The widest range in the catalogue. A civilian type is a spread of ordinary
    // drivers, so a lane of sedans should visibly sort itself out; the speed
    // machines below are DEFINED by their ceiling and stay narrow.
    speedMin: 215,
    speedMax: 290,
    steerSpeed: 90,
    blastRadius: 36,
    blastDamage: 14,
    value: CIVILIAN_VALUE,
    minDistance: 0, // the city's own traffic: on the road from the first metre
    behaviour: "overtake",
    weight: 3, // the backbone of the road
  },
  {
    id: "van",
    label: "VAN",
    shape: carShapeIndex("VAN"),
    faction: NEUTRAL_FACTION,
    color: NEUTRAL,
    thrust: NEUTRAL_THRUST,
    w: 38,
    h: 68,
    health: 95,
    mass: 1.6,
    speedMin: 195,
    speedMax: 255,
    steerSpeed: 60,
    blastRadius: 42,
    blastDamage: 18,
    value: CIVILIAN_VALUE,
    minDistance: 0, // the city's own traffic: on the road from the first metre
    behaviour: "cruise", // slow and wide: it holds its lane and makes you go round
    weight: 2,
  },
  {
    id: "roadster",
    label: "ROADSTER",
    shape: carShapeIndex("ROADSTER"),
    faction: NEUTRAL_FACTION,
    color: NEUTRAL_PALE,
    thrust: NEUTRAL_THRUST,
    w: 30,
    h: 54,
    health: 40,
    mass: 0.8, // light and fragile: the one car the player can simply swat aside
    // Raised from 400-490 so it sits just under the player's 620: a player flat
    // out only just pulls away from a roadster, where before they left it behind
    // comfortably. It also un-caps `passEffort` for the type — at a 490 ceiling
    // the profile's extra pass speed was clipped to nothing for any roadster that
    // rolled near the top of its range (see behaviours.js passSpeed). Kept 130
    // wide rather than 160: still the widest spread in the catalogue, which is
    // right for a civilian, but not so wide that two roadsters differ by more
    // than a sedan's entire range.
    speedMin: 430,
    speedMax: 560,
    steerSpeed: 140,
    blastRadius: 30,
    blastDamage: 9,
    value: CIVILIAN_VALUE,
    minDistance: 0, // the city's own traffic: on the road from the first metre
    behaviour: "overtake",
    // The road's impatient civilian, and the reason driving.js exists: the same
    // tactic as the sedan, so every difference between the two of them on the
    // road comes out of the profile table and nothing else.
    driving: "hustler",
    weight: 1.5,
  },
  {
    id: "rig",
    label: "RIG",
    shape: carShapeIndex("RIG"),
    faction: NEUTRAL_FACTION,
    color: NEUTRAL_DEEP,
    thrust: NEUTRAL_DEEP,
    w: 42,
    h: 124, // twice any other car: it is a rolling wall, and a lane-and-a-half of
    health: 220, // road disappears behind it
    mass: 4, // immovable in practice — ram it and you lose, not the rig
    // The floor of the whole catalogue: 180 is half again the player's minimum,
    // so even a rig is pulling away from a player who has given up on the
    // throttle. The floor is the ONE number here that must not drift downward —
    // it is the reason a slow player still sees a moving road.
    speedMin: 180,
    speedMax: 215,
    steerSpeed: 35,
    // It is carrying something. Killing a rig in traffic is the biggest event on
    // the road — the blast covers most of the tarmac around it and will take a
    // third of the player's hull if they are alongside when it goes.
    blastRadius: 72,
    blastDamage: 46,
    value: CIVILIAN_VALUE,
    minDistance: 0, // the city's own traffic: on the road from the first metre
    // Even the rolling wall dodges — it drives the commuter profile, at nerve 0.
    // A rig ploughing a trestle is tempting flavour, but it is also the one
    // civilian heavy enough to be somewhere near a hazard the player wanted left
    // standing, and the AMBER cars dodging without exception is what makes one
    // swerving read as "there is something in that lane" rather than as one
    // type's quirk.
    behaviour: "convoy",
    weight: 0.8,
  },
  {
    id: "hypercar",
    label: "HYPERCAR",
    shape: carShapeIndex("HYPERCAR"),
    faction: NEUTRAL_FACTION,
    color: NEUTRAL_PALE,
    thrust: NEUTRAL_THRUST,
    w: 36,
    h: 64,
    health: 45,
    mass: 0.9,
    // Faster than the player is ALLOWED to go: a rare showpiece that comes past
    // at full throttle and is gone, which is exactly why it is worth spotting.
    speedMin: 630,
    speedMax: 700,
    steerSpeed: 160,
    blastRadius: 32,
    blastDamage: 10,
    value: CIVILIAN_VALUE,
    minDistance: 0, // the city's own traffic: on the road from the first metre
    behaviour: "overtake",
    weight: 0.4,
  },

  // --- Enemy: everything that is out here for you ---------------------------
  {
    id: "interceptor",
    label: "INTERCEPTOR",
    shape: carShapeIndex("INTERCEPTOR"),
    faction: ENEMY_FACTION,
    color: ENEMY,
    thrust: ENEMY_THRUST,
    w: 34,
    h: 62,
    health: 70,
    mass: 1.1,
    speedMin: 400,
    speedMax: 470,
    steerSpeed: 130,
    blastRadius: 38,
    blastDamage: 16,
    value: ENEMY_VALUE,
    minDistance: ENEMY_MIN_DISTANCE,
    behaviour: "pursue",
    driving: "pursuer", // nerve 12: through a trestle a third of the time
    weight: 2, // the standard hostile: whatever else is out, one of these is too
  },
  {
    id: "muscle",
    label: "MUSCLE",
    shape: carShapeIndex("MUSCLE"),
    faction: ENEMY_FACTION,
    color: ENEMY_DEEP,
    thrust: ENEMY_THRUST,
    w: 38,
    h: 68,
    health: 110,
    mass: 1.7, // heavier than the player: it wins a shoving match, slowly
    speedMin: 310,
    speedMax: 360,
    steerSpeed: 85,
    blastRadius: 44,
    blastDamage: 24,
    value: ENEMY_VALUE,
    minDistance: ENEMY_MIN_DISTANCE,
    behaviour: "block",
    driving: "enforcer", // nerve 16: half the time — a heavy built to shove
    weight: 1.2,
  },
  {
    id: "cycle",
    label: "CYCLE",
    shape: carShapeIndex("CYCLE"),
    faction: ENEMY_FACTION,
    color: ENEMY_PALE,
    thrust: ENEMY_THRUST,
    w: 26,
    h: 58,
    health: 25, // one solid contact and it is gone
    mass: 0.5,
    // The fastest thing on the road, and deliberately faster than the player's
    // ceiling: a cycle catches and passes a player at full throttle. Outrunning
    // one is a job for a Phase 5 boost, not for the accelerator.
    speedMin: 660,
    speedMax: 730,
    steerSpeed: 180, // the nimblest thing on the road, by a wide margin
    blastRadius: 24,
    blastDamage: 7,
    value: ENEMY_VALUE,
    minDistance: ENEMY_MIN_DISTANCE,
    behaviour: "weave",
    // The one hostile that dodges everything, and the clearest use of the dial:
    // 25 hull means a trestle costs a cycle a third of its life, and it is the
    // nimblest thing on the road. It goes round because going round is what it
    // is FOR — the contrast with the bruiser below is why these are per type.
    driving: "darter",
    weight: 1,
  },
  {
    id: "bruiser",
    label: "BRUISER",
    shape: carShapeIndex("BRUISER"),
    faction: ENEMY_FACTION,
    color: ENEMY_DEEP,
    thrust: ENEMY_THRUST,
    w: 40,
    h: 74,
    health: 160,
    mass: 2.2, // built to ram; Phase 4 gives it the behaviour to go with the mass
    speedMin: 280,
    speedMax: 330,
    steerSpeed: 70,
    blastRadius: 52,
    blastDamage: 32,
    value: ENEMY_VALUE,
    minDistance: ENEMY_MIN_DISTANCE,
    behaviour: "ram",
    driving: "batterer", // nerve 20: three times in five, the type least
                         // interested in going round
    weight: 0.8,
  },
  {
    id: "rival",
    label: "RIVAL",
    // The player's own silhouette, in enemy red — see the header. Only the cycle
    // is quicker, and nothing else hostile can live with the player flat out.
    shape: carShapeIndex("SUPERCAR"),
    faction: ENEMY_FACTION,
    color: ENEMY,
    thrust: ENEMY_THRUST,
    w: 34,
    h: 62,
    health: 90,
    mass: 1.2,
    // Straddles the player's top speed: flat out, you draw level with a rival
    // and neither of you gets away. The only hostile that can hold that.
    speedMin: 580,
    speedMax: 650,
    steerSpeed: 150,
    blastRadius: 40,
    blastDamage: 20,
    value: ENEMY_VALUE,
    minDistance: ENEMY_MIN_DISTANCE,
    behaviour: "pursue",
    driving: "duelist", // nerve 10: a driver, not a battering ram — it would
                        // rather keep the line clean
    weight: 0.3, // rare enough that meeting one is an event
  },
];

// Whether `type` is allowed on the road yet. `distance` is the RAW world
// odometer (main.js), and `minDistance` is in readout units, so the conversion
// lives here and nowhere else — a caller only ever passes what it already has.
export function typeAvailable(type, distance) {
  return distance >= (type.minDistance ?? 0) * DIST_UNITS;
}

// A random type the player has driven far enough to meet, honouring `weight`.
//
// The gate is applied by REWEIGHTING rather than by re-rolling until something
// passes: the eligible types' weights are totalled fresh each call, so before
// DIST 100 the five civilian types share the whole draw and the road is as busy
// as it ever was. Rejection sampling would instead have thinned the traffic to
// half strength for the opening run, which is the opposite of what a quiet start
// should feel like.
//
// Returns null if NOTHING is available yet — only possible if every type is
// given a gate, which the catalogue above deliberately does not do. Spawners
// treat it the same as "no room this interval" and try again (traffic.js,
// obstacles.js). The default of Infinity means a caller that doesn't care about
// gating (tools, tests) gets the whole catalogue.
export function pickCarType(distance = Infinity) {
  let total = 0;
  for (const type of CAR_TYPES) {
    if (typeAvailable(type, distance)) total += type.weight;
  }
  if (total <= 0) return null;

  let roll = Math.random() * total;
  let last = null;
  for (const type of CAR_TYPES) {
    if (!typeAvailable(type, distance)) continue;
    last = type;
    roll -= type.weight;
    if (roll <= 0) return type;
  }
  return last; // float dust at the very top of the roll
}

export function carTypeById(id) {
  return CAR_TYPES.find((t) => t.id === id) ?? null;
}
