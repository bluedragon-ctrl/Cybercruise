// Driving profiles — the numbers behind a tactic.
//
// THE SPLIT, for the third time in this codebase, and for the same reason both
// of the others exist: data that can be retuned without reading code, kept apart
// from the code that acts on it.
//
//   cartypes.js   what a car IS      — size, mass, hull, speed band, silhouette
//   armament.js   what it CARRIES    — which gun, which mine layer
//   driving.js    how it DRIVES      — the disposition behind the manoeuvres
//   behaviours.js what it CAN DO     — the manoeuvres themselves (the code)
//
// Before this file existed, behaviours.js's tuning lived in module constants, so
// every car naming `overtake` drove identically and two civilians differed only
// in the physical limits traffic.js applied afterwards. There was no way to say
// "a van is a timid overtaker" without writing a second function — which is the
// reuse problem: a new car type could only ever be a new function.
//
// TWO AXES INSTEAD OF ONE. A car type now names both:
//   behaviour   the TACTIC — which manoeuvres it knows (behaviours.js)
//   driving     the PROFILE — how boldly it runs them (this file)
// so adding a car type is usually no new code at all. Pick a tactic, pick a
// profile, and the only thing left is the artwork.
//
// PROFILES ARE SHARED AND FROZEN. One object per profile, resolved at module
// load and handed to every car that names it (traffic.js stores it as
// `car.drive`). A per-tick read is therefore one field access and behaviours.js
// goes on allocating nothing, which is the whole reason the merge happens here
// rather than per car. Nothing may write to a profile: two hundred sedans share
// one object.
//
// WHAT IS NOT HERE. `HAZARD_DODGE_SPAN` and `HAZARD_SAFETY` stay as constants in
// behaviours.js, because they feed `dodgeDistance`, and `dodgeDistance` is what
// obstacles.js sizes its spawn margin against. Those two are a contract BETWEEN
// FILES about where a hazard may be placed, not a question of how a given driver
// feels about it — and the driver's feeling is already expressed, by `nerve`.

// NO IMPORTS. This file is pure data and one lookup; it is the leaf of the
// dependency graph, which is what lets cartypes.js, behaviours.js and the tests
// all read it without a cycle.

// --- The knobs ---------------------------------------------------------------
//
// `commuter` doubles as the reference AND as the documentation: every field is
// listed once, here, with the value behaviours.js used to hard-code. Every other
// profile is a DELTA from it, so a diff of the table below reads as a
// description of the driver rather than as a wall of numbers.
const COMMUTER = {
  // --- Following ------------------------------------------------------------
  // Clear road wanted between this car's nose and the tail of the car in front,
  // plus a term for how fast it is closing. See behaviours.js's followSpeed.
  followGap: 40,
  // Seconds of closing rate added to that gap. THE ONE KNOB WITH A HARD FLOOR:
  // traffic sheds speed at traffic.js's ACCEL, so shedding dv costs dv²/(2·ACCEL)
  // of road, and this only leaves a follower room to match while
  //     dv² / (2·ACCEL)  <=  followGap + dv·followReaction
  // for every closing speed dv the profile's own users can produce. Per profile,
  // dv is (fastest type naming it) minus the player's minimum — NOT the whole
  // catalogue's 610, which is why `hustler` below can go lower than this can.
  // Asserted per profile in test/invariants.test.js.
  followReaction: 1.0,

  // --- Lane discipline ------------------------------------------------------
  // How hard this driver insists on sitting at a lane CENTRE, 0..1. It is read
  // as a tolerance: the car accepts being up to (1 - laneDiscipline) * half a
  // lane off centre before it corrects. At 1 it rides the centre-line of its
  // lane exactly; at 0 it holds whatever line it happens to be on.
  //
  // This is not cosmetic. Nothing else ever re-derives which lane a car belongs
  // in: `cruise` never wrote `targetOffset` at all, so a car shoved sideways by
  // a ram used to steer all the way back across live traffic to the lane it
  // spawned in, however long ago that was.
  laneDiscipline: 1.0,
  // Which lane this driver would RATHER be in, when the road allows it:
  //   "any"    no preference — take the lane you are in
  //   "inner"  the lanes nearest the centre-line (the fast lanes)
  //   "outer"  the lanes nearest the barriers
  // A preference is never worth a lane change through traffic, so behaviours.js
  // only acts on it when the lane it wants is actually free.
  laneHome: "any",

  // --- Overtaking -----------------------------------------------------------
  // Seconds this driver will sit behind something worth passing before it
  // commits. Before this existed a pass fired the instant the trigger distance
  // was met, so every overtaker was equally twitchy.
  patience: 1.2,
  passTrigger: 220,     // world units: a blocker further off isn't holding us up
  passMargin: 30,       // ...the nose must clear before pulling back in
  passTimeout: 6,       // seconds before an unfinished pass is abandoned
  passSpeedMargin: 15,  // how much faster we must want to be to bother
  passClearance: 12,    // px of daylight between the boxes as it goes by
  passLookBehind: 90,   // world units of the pass line checked behind us...
  passLookAhead: 140,   // ...and beyond the car we mean to pass
  passEffort: 1.15,     // how much harder it drives while committed to a pass.
                        // CAPPED at the type's own speedMax (behaviours.js), so
                        // it does nothing for a type already cruising at its
                        // ceiling — check the catalogue before tuning this

  // --- Hazards --------------------------------------------------------------
  hazardClearance: 6,   // px of daylight wanted when steering past one

  // --- Nerve: what this driver will accept hitting --------------------------
  //
  // Moved here from cartypes.js, where it sat among the physical stats. It is a
  // disposition, not a property of the chassis — two drivers of the same car
  // differ on it, and nothing outside behaviours.js ever read it.
  //
  // TWO TOLERANCES, ONE MECHANISM. Both are hull damage this driver will eat
  // rather than lift off its line, and both are compared against an ESTIMATED
  // COST — a hazard's own `threat` (obstacles.js) or, for a car, what
  // collisions.js says the impact would actually take off. They are separate
  // numbers because the two are not the same kind of risk:
  //
  //   nerve    ROADBLOCKS. Must stay 0 for every civilian, and that is a
  //            readability rule rather than a balance one: an amber car swerving
  //            has to mean "there is something in that lane". The pale civilians
  //            (roadster, hypercar) are the exception the palette already
  //            signals — they are visibly a different shade, so a pale car
  //            barging a stack of barrels does not muddy the amber signal.
  //            Also the number that keeps mines the PLAYER's problem: no type
  //            reaches the tetra's 24, so none reaches the mine's 30, so traffic
  //            never clears a mine off the road and score.js never fines the
  //            player for a kill they had no part in.
  //
  //   contact  OTHER CARS. Free to vary anywhere, because a fender-bender is
  //            survivable and reads as driving rather than as a mistake. This is
  //            what makes an impatient driver look impatient: it will brush past
  //            where a careful one brakes.
  //
  // Each car ROLLS ITS OWN tolerance uniformly in [0, the figure] at spawn
  // (traffic.js), so the profile's number is a CEILING and two roadsters meeting
  // the same barrels do different things. Rolled once, for life — a fresh coin
  // flip per tick would make a car swerve and unswerve all the way down the road.
  //
  // The probabilities fall straight out of the obstacle catalogue, since what
  // `nerve` is compared against is the hazard's `blastDamage` (obstacletypes.js:
  // barrels 5, trestle 8, tetra 24, mine 30):
  //
  //     P(barge) = 1 - damage/nerve, or 0 when damage >= nerve
  //
  // WHICH MAKES THE DIAL QUANTISED, and that is worth knowing before tuning it:
  // anything below 5 does nothing at all, because there is no hazard cheaper
  // than the barrels. There is no "slightly bolder" — the first setting that
  // exists is "sometimes barges barrels".
  nerve: 0,
  // Defaults to `nerve` when a profile leaves it out (see profile() below), which
  // is the right default: a driver's appetite for one kind of risk is the best
  // guess at its appetite for the other, and it means an enemy profile only has
  // to state a number when the two genuinely differ.
  contact: 0,
};

// Build one profile from COMMUTER plus a delta, and freeze it. `contact` follows
// `nerve` unless the delta says otherwise — see the note on the field.
function profile(delta = {}) {
  const merged = { ...COMMUTER, ...delta };
  if (delta.contact === undefined) merged.contact = merged.nerve;
  return Object.freeze(merged);
}

// --- The catalogue ------------------------------------------------------------
export const DRIVING_PROFILES = {
  // The reference, and the fallback for anything that names nothing. Sedan, van,
  // rig and hypercar all drive this today: the civilian road is deliberately
  // uniform apart from the one car below, so that the difference is legible.
  commuter: profile(),

  // The roadster. The impatient civilian — same `overtake` tactic as the sedan,
  // so every difference you can see on the road comes out of this table and
  // nothing else. That is the point of it existing: it is how the profile system
  // is observed working at all.
  hustler: profile({
    // Rides the lane edges instead of the centre. Against the sedan's dead-centre
    // discipline this is the single most visible line in the file.
    laneDiscipline: 0.3,
    laneHome: "inner", // lives in the fast lane
    patience: 0.2,     // pulls out almost the moment it is held up
    passSpeedMargin: 5, // and will pass for almost any gain at all
    passClearance: 7,   // cutting closer as it goes by
    passTimeout: 4,     // gives up sooner and tries again, rather than committing
    // Tailgates. The pair has to satisfy the floor documented on followReaction,
    // and it does so only because nothing fast drives this profile: the roadster
    // tops out at 560, so its worst closing speed is 560 - 120 = 440, needing
    // 440²/680 = 285 units of road against the 20 + 440*0.65 = 306 this allows.
    // Point a quicker type at `hustler` and the per-profile invariant test fails,
    // which is exactly what it is there for.
    followGap: 20,
    followReaction: 0.65,
    // Barges the barrels (5) roughly a third of the time and never a trestle (8),
    // which is the whole of what "takes risks" can mean at this end of the dial —
    // see the quantisation note above. Contact is set BELOW nerve rather than
    // following it: this driver gambles on junk in the road more readily than it
    // leans on another car, which is the difference between reckless and rude.
    nerve: 8,
    contact: 6,
  }),

  // --- Hostile dispositions --------------------------------------------------
  // One per enemy type, carrying the nerve figures that used to sit in
  // cartypes.js. They are separate profiles rather than one shared "hostile"
  // because the numbers genuinely differed per type, and flattening them here
  // would have been a silent retune of Phase 3's traffic. Their DRIVING is still
  // the commuter's — the enemy tactics are the next step, and this file is what
  // they will be tuned through.
  pursuer: profile({ nerve: 12 }),   // interceptor: through a trestle a third of
                                     // the time — the baseline gamble
  enforcer: profile({ nerve: 16 }),  // muscle: half the time; a heavy already
                                     // built to shove
  batterer: profile({ nerve: 20 }),  // bruiser: three in five, the type least
                                     // interested in going round
  duelist: profile({ nerve: 10 }),   // rival: a driver, not a battering ram — it
                                     // would rather keep the line clean
  // The stocker: a heavy that came off a circuit rather than out of a garage. It
  // is the only hostile that runs a RACING line — it lives on the lane edges and
  // pulls out early, so a stocker closing on the player arrives from the side of
  // the road rather than up the middle. The cage is why its nerve sits above the
  // interceptor's: junk in the road costs it paint, not a wheel.
  roadracer: profile({
    laneDiscipline: 0.35,
    patience: 0.5,
    nerve: 14,
  }),
  // The cycle, and the catalogue's clearest use of the dial: 25 hull means a
  // trestle costs it a third of its life, and it is the nimblest thing on the
  // road. It goes round because going round is what it is FOR — the contrast
  // with the bruiser above is why these are per type at all.
  darter: profile({ nerve: 0, contact: 4 }),
};

// The profile a car type drives by. A named profile always wins, so the
// catalogue is the authority; an unknown name falls back to the commuter rather
// than throwing, on the same grounds as behaviourFor — a half-finished type
// should still drive.
//
// Faction is NOT a default here, unlike armament.js's. "Armed" follows from
// being hostile because an enemy that cannot fight is not a thing the game has a
// use for; "drives like this" does not follow from anything, and a hostile type
// that forgot to name a profile should drive blandly and obviously rather than
// inherit somebody else's temperament.
export function drivingFor(type) {
  return DRIVING_PROFILES[type.driving] ?? DRIVING_PROFILES.commuter;
}

// Every car type that drives `name`. Exported for the per-profile invariant
// test, which has to know whose speeds a profile's braking rule must cover —
// see followReaction. Takes the catalogue as an argument rather than importing
// it, so this file keeps its one-way dependency on cartypes.js.
export function typesDriving(name, types) {
  return types.filter((t) => drivingFor(t) === DRIVING_PROFILES[name]);
}
