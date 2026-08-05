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
// more colour for the critical-hull blink: 11 types * 8 * 2 = 176 sprites at the
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

// THE FOCUS SWITCH — a testing aid, and the reason `minDistance` is worth having
// as a gate rather than as a spawn weight.
//
// Tuning one type's driving means watching it, and a road running the full
// catalogue gives you a few seconds of the car you care about between everything
// else. List the ids you are working on here and only those reach the road; an
// EMPTY list is the shipping catalogue, untouched. Ship it empty.
//
//   const FOCUS = ["sedan", "roadster"];   // civilian profiles, nothing else
//
// Implemented as an override on the SAME gate the game ships with, rather than
// as a filter of its own, so a focused road is still a road the real spawner
// built: the same reweighting, the same "everything gated" path, the same
// pickCarType. A filter bolted on beside it would be a second code path, and the
// one thing a measurement harness must not do is measure a different game.
// Exported so the suite can say so out loud: a focused catalogue breaks several
// gating invariants below, and "van never appeared" is a much worse error
// message than "FOCUS is still set". See test/invariants.test.js.
export const FOCUS = [];

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
//               road weaving at once. Most of the enemy tactics still borrow
//               their driving from those two; a few (`raid`) are real
//   driving     key into driving.js — the PROFILE: following distances, patience,
//               lane discipline, and how much hull this driver will accept
//               hitting. Omitted means `commuter`
//   arms        key into armament.js's ARMAMENTS — the KIT. Omitted means every
//               enemy-faction type gets the shared `hostile` loadout (gun +
//               mine layer) and every neutral-faction type carries nothing;
//               name a profile to override that default, e.g. a car that
//               fights without a gun at all
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
    // RAISED FROM 195-255 when the van was given the outer lane. The rig runs
    // 180-215 and also wants that lane, so the old range put a fifth of all vans
    // permanently behind a rig they were never going to pass — `cruise` does not
    // overtake, so that queue is for life. 205 leaves a 10-unit overlap instead
    // of a 20-unit one and keeps the van clearly under the sedan's 215 floor, so
    // the speed gradient across the road still reads.
    speedMin: 205,
    speedMax: 265,
    // LOAD-BEARING, and not only for how it corners. behaviours.js prices a lane
    // change from this figure against collisions.js's DAMAGE_FLOOR of 40, so 60
    // is what puts the van's contacts in a 0.7-1.5 hull band and gives the
    // `hauler` profile the only finely-graded `contact` dial in the file. Drop it
    // near 40 and that dial goes binary, as the rig's already is.
    steerSpeed: 60,
    blastRadius: 42,
    blastDamage: 18,
    value: CIVILIAN_VALUE,
    minDistance: 0, // the city's own traffic: on the road from the first metre
    behaviour: "cruise", // slow and wide: it holds its lane and makes you go round
    driving: "hauler",   // out of the way, and it will lean on a small car
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
    minDistance: 200, // the city's own traffic: on the road from the first metre
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
    // UNDER collisions.js's DAMAGE_FLOOR of 40, and left there on purpose. It
    // means every lane change a rig makes is free, so its `contact` dial has only
    // two settings rather than a range — see driving.js's `juggernaut`. Raising
    // it to clear the floor would also shrink dodgeDistance, which is the figure
    // obstacles.js sizes its whole spawn margin against, so this number is not
    // the rig's alone to change.
    steerSpeed: 35,
    // It is carrying something. Killing a rig in traffic is the biggest event on
    // the road — the blast covers most of the tarmac around it and will take a
    // third of the player's hull if they are alongside when it goes.
    blastRadius: 72,
    blastDamage: 46,
    value: CIVILIAN_VALUE,
    minDistance: 0, // the city's own traffic: on the road from the first metre
    // Even the rolling wall dodges — `juggernaut` keeps nerve at 0. A rig
    // ploughing a trestle is tempting flavour, but it is also the one civilian
    // heavy enough to be somewhere near a hazard the player wanted left standing,
    // and the AMBER cars dodging without exception is what makes one swerving
    // read as "there is something in that lane" rather than as one type's quirk.
    behaviour: "convoy",
    driving: "juggernaut", // dead straight, brakes from a long way out, and
                           // expects to be given room rather than to ask for it
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
    minDistance: 700, // the city's own traffic: on the road from the first metre
    behaviour: "overtake",
    // The other pale civilian, and the deliberate opposite of the roadster: same
    // shade, same tactic, similar pace, and it holds a perfect line and sweeps
    // wide where the roadster rides the edge and cuts close. Two profiles, one
    // silhouette apart — see driving.js.
    driving: "showpiece",
    weight: 0.4,
  },

  {
    id: "muscle",
    label: "MUSCLE",
    shape: carShapeIndex("MUSCLE"),
    // THE HOLE IN THE CIVILIAN ROAD, and it was a specific one: every heavy
    // civilian was careful and the only reckless one was the frailest thing out
    // here. The roadster is rude at mass 0.8 and 40 hull, so the player swats it
    // aside for free and rudeness costs them nothing. Nothing on this side of the
    // road leaned back.
    //
    // MOVED HERE FROM THE ENEMY, silhouette and stats intact. It was the hostile
    // that blocked the player's lane from in front; the shape and the weight
    // class were already right for a civilian brawler, and a car that is
    // aggressive WITHOUT being out to get you is a different thing from an enemy
    // — it is traffic that will not yield. The hostile role it vacated is a fresh
    // enemy type's to fill (behaviours.js still holds the `block` tactic and
    // driving.js the `enforcer` profile, both unclaimed and waiting).
    faction: NEUTRAL_FACTION,
    // Deep amber, the heavy-neutral shade it shares with the rig. Colour carries
    // faction and weight class only, so two heavy civilians matching is correct —
    // the MUSCLE silhouette is what tells them apart, and nothing else has to.
    color: NEUTRAL_DEEP,
    thrust: NEUTRAL_THRUST,
    w: 38,
    h: 68,
    health: 110,
    // Heavier than the player: it wins a shoving match, slowly. Unchanged from
    // its hostile days and now the whole point of the type — this is the civilian
    // the player cannot simply move out of the way.
    mass: 1.7,
    speedMin: 310,
    speedMax: 360,
    // AND THE FIGURE THAT MAKES IT RECKLESS RATHER THAN JUST BIG. At 85 against
    // the damage floor of 40 its contacts price at 1.1 to 3.3 hull, which off 110
    // hull is nothing at all — so the `brawler` profile can hand it a genuinely
    // bold `contact` and the car pays for it in nothing but other people's
    // trouble. Compare the roadster, whose rudeness costs it 4-9 hull off 40.
    steerSpeed: 85,
    blastRadius: 44,
    blastDamage: 24,
    value: CIVILIAN_VALUE, // killing one is a fine, like any other civilian
    minDistance: 500,        // the city's own traffic: on the road from the first metre
    behaviour: "overtake", // it does not block for anyone; it just goes past
    driving: "brawler",    // heavy, impatient, and it will lean on you
    // Kept at exactly what it was as a hostile, which MOVES THE FACTION MIX and
    // is worth knowing: civilian weight goes 7.7 -> 8.9 and hostile 5.3 -> 4.1,
    // so past DIST 100 the road is now about 68% civilian rather than 59%. That
    // is a thinner enemy presence, not a rebalanced one — the figure to restore
    // when the replacement hostile arrives, rather than something to paper over
    // by inflating the four types left.
    weight: 1.2,
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
    minDistance: 300,
    behaviour: "pursue",
    driving: "pursuer", // nerve 12: through a trestle a third of the time
    weight: 2, // the standard hostile: whatever else is out, one of these is too
  },
  {
    id: "stocker",
    label: "STOCKER",
    // THE HOSTILE THE MUSCLE VACATED. When the muscle crossed to the civilian
    // side it took the enemy's mid-field heavy with it, and this is the car that
    // fills the hole — deliberately not a copy of it. The muscle was a street
    // heavy that got in front of you and sat there; the STOCKER came off a
    // circuit, and it CHASES. The `block` tactic and the `enforcer` profile the
    // muscle left behind are still unclaimed, and still the right pair for a
    // second heavy that leans on the player rather than racing them.
    shape: carShapeIndex("STOCKER"),
    faction: ENEMY_FACTION,
    // Deep red: the heavy hostile class, shared with the bruiser. Its own
    // silhouette — flared over every wheel, caged, winged — is what tells the two
    // apart, exactly as the MUSCLE outline now does on the civilian side.
    color: ENEMY_DEEP,
    thrust: ENEMY_THRUST,
    w: 40,
    h: 70,
    health: 130, // a caged car: more than the departed muscle's 110, less than
                 // the bruiser's 160
    mass: 1.9,
    // Fills the enemy's speed hole between the bruiser's 330 and the
    // interceptor's 400: a heavy that is genuinely quick, so being ahead of one
    // is not the escape it is with the rest of the heavy class.
    speedMin: 355,
    speedMax: 415,
    steerSpeed: 100, // quicker across the road than any other heavy
    blastRadius: 46,
    blastDamage: 26,
    value: ENEMY_VALUE,
    minDistance: ENEMY_MIN_DISTANCE,
    behaviour: "trail",    // hangs off your back bumper and fires forward — see
                           // behaviours.js's `trail`. It never tries to get past,
                           // unlike the placeholder `pursue` still borrowed by
                           // the interceptor and rival
    // THE SMG, NOT THE STANDARD BLASTER — a burst-fire spray rather than one
    // well-aimed round, which is what a trailing car sustaining fire on one
    // target for several seconds should sound and look like. See armament.js's
    // `gunner` profile and weapons.js's `smg` type. Overrides the faction's
    // default hostile kit, same mechanism as the cycle's `raider`.
    arms: "gunner",
    driving: "roadracer", // nerve 14: a racer's nerve, between pursuer and enforcer
    // Exactly the weight the muscle took with it, which RESTORES THE FACTION MIX
    // the muscle's move disturbed: hostile weight goes 4.1 -> 5.3 and civilian
    // stays 8.9, so past DIST 100 the road returns to roughly 63% civilian. See
    // the note on the muscle's own weight above — this is the replacement hostile
    // it asks for.
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
    behaviour: "raid",
    // NO GUN. It fights entirely by forcing its way past and dropping one
    // mine ahead of the player — see armament.js's `raider` profile and
    // behaviours.js's `raid` tactic. Overrides the faction's default hostile
    // kit, which is what `arms` naming a profile is for.
    arms: "raider",
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
    minDistance: 1000,
    behaviour: "pursue",
    driving: "duelist", // nerve 10: a driver, not a battering ram — it would
                        // rather keep the line clean
    weight: 0.3, // rare enough that meeting one is an event
  },
];

// Whether `type` is allowed on the road yet. `distance` is the RAW world
// odometer (main.js), and `minDistance` is in readout units, so the conversion
// lives here and nowhere else — a caller only ever passes what it already has.
// A focused type keeps its own gate (so focusing on the interceptor still waits
// for DIST 100); everything else is gated for ever. See FOCUS above.
export function typeAvailable(type, distance) {
  if (FOCUS.length > 0 && !FOCUS.includes(type.id)) return false;
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
