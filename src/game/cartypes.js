// The traffic catalogue — every kind of car on the road other than the player.
//
// A type is pure DATA: how it looks, how fast it drives, how much punishment it
// takes, and which BEHAVIOUR drives it (see behaviours.js). Adding a new kind of
// traffic — a bike that weaves, a tanker that drops oil, a boss — means adding
// an entry here and, if it needs new tactics, a behaviour function. Nothing in
// traffic.js knows any type by name.
//
// SPRITE-CACHE BUDGET. Every distinct (color, thrust, w, h) combination is a
// cache key in sprites.js, times WHEEL_FRAMES (8) wheel positions. Keeping the
// catalogue a small fixed list is what keeps that bounded — so vary cars by
// ADDING A TYPE, never by rolling continuous per-instance sizes or colours.
// Per-instance variety comes from `speedMin`..`speedMax`, which costs nothing
// because speed doesn't affect the artwork.

import {
  ENEMY,
  ENEMY_DEEP,
  ENEMY_THRUST,
  NEUTRAL,
  NEUTRAL_DEEP,
  NEUTRAL_PALE,
  NEUTRAL_THRUST,
} from "../engine/palette.js";

// Factions decide who a behaviour is allowed to be interested in, and how a hit
// scores (Phase 4/6). Ramming a civilian will be a penalty; ramming an enemy
// won't. Colour follows the faction — see the palette.
export const NEUTRAL_FACTION = "neutral";
export const ENEMY_FACTION = "enemy";

// Fields:
//   id          stable key (save data, spawn tables, debugging)
//   label       gallery/HUD caption
//   faction     NEUTRAL_FACTION | ENEMY_FACTION
//   color       body wireframe colour; thrust = exhaust glow
//   w, h        collision box AND drawn size (px)
//   health      hull points; spent by ramming (collisions.js) and, from Phase 4,
//               by weapons. At zero the car is destroyed and leaves the road
//   mass        how hard it is to shove, relative units — only ratios matter.
//               Ramming splits movement and damage by INVERSE mass, so this is
//               the difference between bouncing off a truck and swatting a
//               roadster aside. Roughly tracks size, but it's a gameplay dial:
//               nudge it to make a type feel heavier without redrawing it
//   speedMin/Max  cruising speed range, world units/sec (player: 120..620)
//   steerSpeed  how fast the car can slide sideways, px/sec — a behaviour asks
//               for a lateral position and this caps how quickly it gets there,
//               so a truck wallows and a roadster darts
//   behaviour   key into behaviours.js. The nimble types `overtake` — they pull
//               out and pass whatever is holding them up, the player included;
//               the two heavy ones just `cruise`, so sitting in front of a truck
//               means it stays there. That split is what stops every car on the
//               road weaving at once
//   weight      relative spawn frequency
export const CAR_TYPES = [
  {
    id: "sedan",
    label: "SEDAN",
    faction: NEUTRAL_FACTION,
    color: NEUTRAL,
    thrust: NEUTRAL_THRUST,
    w: 34,
    h: 60,
    health: 60,
    mass: 1, // the reference car: everything else is heavier or lighter than this
    speedMin: 170,
    speedMax: 210,
    steerSpeed: 90,
    behaviour: "overtake",
    weight: 3,
  },
  {
    id: "truck",
    label: "TRUCK",
    faction: NEUTRAL_FACTION,
    color: NEUTRAL_DEEP,
    thrust: NEUTRAL_DEEP,
    w: 42,
    h: 84,
    health: 140,
    mass: 2.6, // immovable in practice — ram it and you lose, not the truck
    speedMin: 130,
    speedMax: 160,
    steerSpeed: 45,
    behaviour: "cruise", // wallows too much to pass anything; it just sits behind you
    weight: 1.5,
  },
  {
    id: "roadster",
    label: "ROADSTER",
    faction: NEUTRAL_FACTION,
    color: NEUTRAL_PALE,
    thrust: NEUTRAL_THRUST,
    w: 30,
    h: 54,
    health: 40,
    mass: 0.8, // light and fragile: the one car the player can simply swat aside
    speedMin: 300,
    speedMax: 360,
    steerSpeed: 140,
    behaviour: "overtake",
    weight: 1.5,
  },
  {
    id: "interceptor",
    label: "INTERCEPTOR",
    faction: ENEMY_FACTION,
    color: ENEMY,
    thrust: ENEMY_THRUST,
    w: 34,
    h: 62,
    health: 70,
    mass: 1.1,
    speedMin: 280,
    speedMax: 340,
    steerSpeed: 130,
    // Phase 4 swaps this for a pursuit behaviour; until then it drives fast and
    // goes around anything slower, the player included.
    behaviour: "overtake",
    weight: 2,
  },
  {
    id: "bruiser",
    label: "BRUISER",
    faction: ENEMY_FACTION,
    color: ENEMY_DEEP,
    thrust: ENEMY_THRUST,
    w: 40,
    h: 74,
    health: 160,
    mass: 2, // built to ram; Phase 4 gives it the behaviour to go with the mass
    speedMin: 200,
    speedMax: 240,
    steerSpeed: 70,
    behaviour: "cruise",
    weight: 1,
  },
];

const TOTAL_WEIGHT = CAR_TYPES.reduce((sum, t) => sum + t.weight, 0);

// A random type, honouring `weight`.
export function pickCarType() {
  let roll = Math.random() * TOTAL_WEIGHT;
  for (const type of CAR_TYPES) {
    roll -= type.weight;
    if (roll <= 0) return type;
  }
  return CAR_TYPES[CAR_TYPES.length - 1];
}

export function carTypeById(id) {
  return CAR_TYPES.find((t) => t.id === id) ?? null;
}
