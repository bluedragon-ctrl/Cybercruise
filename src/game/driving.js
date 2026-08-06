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

  // --- Chasing the player ---------------------------------------------------
  //
  // INERT FOR EVERY CIVILIAN, and written down here anyway for exactly the
  // reason the whole pass* family is written down on a profile the van never
  // reads it from: this object is the ONE place every field appears, and a
  // hostile that omits one should inherit the figure the enemy was tuned at
  // rather than a hole. The tactics that read these are behaviours.js's
  // `pursue`, `trail`, `ram` and `raid`; nothing a civilian names touches one.
  //
  // THESE WERE MODULE CONSTANTS IN behaviours.js, in a file whose own header
  // says the numbers do not live there. The cost was the cost this file exists
  // to remove: the five hostile profiles differed only in `nerve`, so a second,
  // more cautious interceptor needed a new FUNCTION rather than a new row.

  // The gap this driver holds behind the player once it is actually chasing.
  // Comfortably inside the reach of anything the enemy carries (armament.js's
  // GUN_RANGE), with slack either side for the proportional term below to
  // correct in without clipping the firing window.
  pursueHold: 200,
  // The gap inside which chasing is worth doing at all. Well outside
  // pursueHold on purpose: this is the room the car has to spend a couple of
  // seconds genuinely closing, at chaseSpeed, before it needs to be in range.
  // Outside it the car simply cruises and lets the gap come back to it.
  pursueRange: 500,
  // How hard the hold-station speed correction leans on the gap error — a
  // proportional term, not a limit: traffic.js's ACCEL is still what actually
  // gets `speed` there.
  pursueGain: 1.2,
  // THE CHASE CEILING, and the one field here deliberately allowed to sit ABOVE
  // the type's own speedMax. A type's speed band governs its ordinary cruise
  // roll and is what makes a stray hostile read as whatever weight it is; this
  // is what it will spend once the player is worth chasing, so it can keep pace
  // with a player running near their own 620 (player.js) for the length of one
  // engagement rather than falling off the back the moment they floor it.
  //
  // AN ABSOLUTE, NOT A MULTIPLE OF speedMax, and that is worth knowing before
  // tuning it. A multiplier would read better and would keep the two-tier
  // relation true by construction — but adopting one would have been a silent
  // retune of every hostile on the road, so these are the figures behaviours.js
  // hard-coded and nothing has moved. It does mean the relation is not
  // GUARANTEED: the rival tops out at 650 (cartypes.js), so 600 is a ceiling
  // below its own cruise and `pursue` never lets it chase at full pace. That
  // was equally true before this became a field; it is merely visible now.
  chaseSpeed: 600,
  // SECONDS OF LOST CONTACT BEFORE THIS DRIVER GIVES THE PLAYER UP FOR GOOD, or
  // 0 for "never" — the baseline, and what makes `pursue` the road's standing
  // pressure rather than a timed encounter. Only behaviours.js's `trail` reads
  // it, and see there for what giving up actually costs the car: it rides off
  // permanently unarmed, so this is a one-way switch rather than a lull.
  giveUpTime: 0,
  // The proportional gain on the MINE RUN's own hold (behaviours.js's `raid`) —
  // separate from pursueGain because holding station AHEAD of a target you must
  // not out-pace is a tighter job than trailing one.
  raidGain: 1.5,

  // --- Ramming --------------------------------------------------------------
  // Read only by behaviours.js's `ram`, and only once it is AHEAD of the player
  // and the job has turned from hitting them into blocking them.
  //
  // A FRACTION OF THE PLAYER'S OWN CURRENT SPEED rather than a fixed figure, so
  // the block still bites right down at walking pace instead of going slack the
  // moment the player lifts off themselves.
  ramBrake: 0.5,
  // ...with a floor, because a stalled wall reads as broken rather than as a
  // blocker. Deliberately UNDER the player's own minimum of 120 (player.js), so
  // there is no speed at which simply lifting off escapes the block.
  ramFloor: 80,

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
// THE CIVILIAN ROAD IS A LANE GRADIENT, and it is built here rather than in any
// one profile. Four of the five civilian types now state a `laneHome`, and they
// state it BY SPEED: the two slow haulers want the lanes by the barrier, the two
// fast machines want the lanes by the centre-line, and the sedan — the reference
// car, at the middle of the civilian speed range — wants nothing in particular
// and fills in whatever is left. The road therefore sorts itself, and the
// player's choice of lane becomes a choice about what they will meet there
// rather than four interchangeable strips of tarmac. Asserted in
// test/invariants.test.js, so a retune that puts a rig in the fast lane fails
// rather than merely looking odd.
//
// ONE PROFILE PER TYPE, from here on. The van and the rig could share a
// "slow and heavy" table, and deliberately do not: their most legible difference
// is that the van wanders and the rig does not, which is one field, and folding
// them together would cost exactly that field. The enemy already works this way
// for the same reason.
export const DRIVING_PROFILES = {
  // The reference, and the fallback for anything that names nothing. The SEDAN
  // alone drives it now — which is the point of it being the reference: it is
  // the car every other profile in this file is a described difference FROM, so
  // it should stay the plain one.
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

  // The van. The working vehicle: slow, wide, out of the way, and — uniquely on
  // this road — able to express itself through `contact` rather than `nerve`.
  //
  // WHY THE VAN AND NOT THE ROADSTER. `contactCost` scales with the car's own
  // steerSpeed (behaviours.js), so what a lane change costs is set by how fast
  // the car arrives sideways. The van steers at 60 against collisions.js's floor
  // of 40, which puts its whole catalogue of contacts in the 0.7 to 1.5 hull
  // band — so a ceiling of 1.2, ROLLED PER CAR, comes out as: squeezes past a
  // roadster about two times in five, a sedan one in three, another van one in
  // eight, and never a rig. That is a driver who leans on small cars and gives
  // way to big ones, out of one number. The roadster cannot do this: it steers
  // at 140, its contacts cost 4 to 9, and its dial is coarse by comparison.
  //
  // MOST OF THE TABLE IS INERT HERE, and it is worth knowing before tuning it.
  // The van's tactic is `cruise`, which never passes, so `patience`, the whole
  // pass* family and `passEffort` are never read. `passLookAhead` and
  // `passLookBehind` ARE — `blocked` uses them for the lane preference below and
  // for the hazard dodge — which is why they are the only two left at the
  // commuter's figures rather than tuned.
  hauler: profile({
    laneDiscipline: 0.85, // a big box that never quite settles on the centre-line
    laneHome: "outer",    // keeps out of the way: the slow side of the gradient
    // Heavier than it looks and slower to shed speed than it looks, so it starts
    // backing off early. Free of the braking floor at these speeds — 145 of
    // closing needs 31 units of road against the 229 this leaves.
    followGap: 55,
    followReaction: 1.2,
    hazardClearance: 10, // a wide vehicle gives a roadblock a wide berth
    nerve: 0,            // amber: it dodges everything, without exception
    contact: 1.2,        // ...but it will lean on something small. See above.
  }),

  // The rig. The one that cannot react, and drives like it knows.
  //
  // DELIBERATELY THE OPPOSITE OF THE VAN ON DISCIPLINE. laneDiscipline is left at
  // the commuter's 1.0 rather than loosened, so the rig tracks dead straight
  // while the van wanders — the wandering thing on this road should be the panel
  // van, not the truck, and against the van's 0.85 that inversion is the most
  // visible line in either table.
  juggernaut: profile({
    laneHome: "outer", // a lane-and-a-half of wall belongs by the barrier
    // The longest look-ahead on the road. 95 of closing needs 13 units against
    // the 242 this leaves, so the figures are pure character: a rig sheds speed
    // from a long way back, because a rig that brakes late reads as a car.
    followGap: 90,
    followReaction: 1.6,
    hazardClearance: 14, // the widest berth in the catalogue
    nerve: 0,            // amber, and the type most likely to be standing near a
                         // hazard the player wanted left alone
    // A BINARY SWITCH FOR THIS TYPE, AND THE ONE PROFILE FIELD THAT DOES NOTHING
    // UNLESS behaviours.js SAYS SO. The rig steers at 35, under collisions.js's
    // DAMAGE_FLOOR of 40, so every lane change it could ever make prices at
    // exactly zero hull: there is no middle setting available to it, only "never"
    // and "always", and until `tolerated` learned to read the ceiling rather than
    // the price, zero silently meant "always".
    //
    // NEVER is the setting, and it was measured rather than argued. Two 100
    // rig-minute batches per side: contacts fall from 7.0-8.8 per minute to
    // 3.9-5.9, hazard strikes land at 0.10-0.24 either way (indistinguishable,
    // and both well under the 0.32 the rig ran on the commuter profile), and the
    // rig gives up 2-3% of its life stopped in a live lane. Free contacts are
    // still SHOVES: a 4-mass wall displaces whatever it touches, and a road where
    // the truck moves over eight times a minute is chaos that the damage model
    // happens not to bill for.
    //
    // A NOTE ON THAT MEASUREMENT, because it nearly went the other way. At 20
    // sim runs this read as contact 0 TRIPLING hazard strikes, and the profile
    // was written up that way. Sixty runs said the opposite. Per-type rates on
    // the rarer types swing by 40% between batches of twenty — take nothing off
    // this harness at that sample size.
    contact: 0,
  }),

  // The hypercar. Fast and immaculate — and the deliberate counterweight to the
  // roadster, since those two are the road's only pale civilians. Same faction,
  // same shade, similar speed, opposite manners: the roadster rides the lane
  // edge and cuts past at 7px, this one holds the centre-line exactly and sweeps
  // by at 20. Telling those two apart at a glance is the clearest evidence the
  // profile system does anything at all.
  showpiece: profile({
    laneHome: "inner", // the fast side of the gradient
    patience: 0.15,    // it does not queue. It is behind you for a blink
    // ITS CAUTION IS FORCED, NOT CHOSEN, which is the nicest thing about this
    // profile. Its driver tops out at 700, so the braking rule documented on
    // followReaction has to cover 580 of closing — 495 units of road, against the
    // 534 this pair allows. The fastest civilian on the road is therefore
    // necessarily the one that leaves the most room in front of it.
    followGap: 70,
    followReaction: 0.8,
    // AND THE TRIGGER HAS TO CLEAR THE BRAKING GAP. followSpeed starts backing
    // off inside 70 + 580*0.8 = 534 units, so at the commuter's trigger of 220
    // this car would have matched the blocker's speed long before it ever
    // considered going round — precisely wrong for the one civilian whose whole
    // character is that it does not slow down. 560 commits it first.
    passTrigger: 560,
    passLookAhead: 260,  // it needs to see further, because it eats road faster
    passLookBehind: 140,
    passSpeedMargin: 60, // and only bothers for a gain it can actually realise:
                         // this is what stops it committing to a pass on a cycle
    passClearance: 20,   // it does not scrape. The widest pass on the road
    // DELIBERATELY 1.0, AND THE CATALOGUE IS WHY. passSpeed caps at the type's
    // own speedMax, and the hypercar's cruise roll runs right up to that cap, so
    // a car rolling near 700 gets no extra at all and one rolling at 630 gets
    // 11%. Rather than a number that quietly does nothing for half the type, say
    // it: this car is already 200 units/sec faster than anything it would want to
    // pass, and does not need to try harder to get by.
    passEffort: 1.0,
    hazardClearance: 12,
    nerve: 0,   // pale, so it is ALLOWED to barge — and doesn't. 45 hull, and a
                // showpiece that scrapes is not a showpiece
    // Never leans on anyone: at 160px/sec sideways its cheapest contact in the
    // catalogue is 4.5 hull, a tenth of its life.
    //
    // IT COSTS SOMETHING, and the cost is the one figure in this profile that
    // held steady across every sample: the hypercar spends 8-11% of its life
    // stopped, against 4% on the commuter it replaced, because a driver that will
    // not take an occupied lane has only the brake left. Giving it a ceiling of 7
    // — enough to squeeze past something light — bought two of those points back
    // and cost contacts to do it. Zero is kept because a showpiece that would
    // rather stop than scrape is the character; if the stopping ever reads as
    // broken rather than as fastidious, this is the number to move.
    contact: 0,
  }),

  // The muscle car. Heavy AND reckless — the combination the civilian road did
  // not have, and the reason this type was moved across from the enemy.
  //
  // RUDENESS THAT COSTS THE DRIVER NOTHING. The roadster is the other impatient
  // civilian, and it pays for every liberty it takes: 4 to 9 hull a contact, off
  // 40. This one steers at 85 and weighs 1.7, so its contacts price at 1.1 (a
  // cycle) to 3.3 (the rig) against 110 hull — a rounding error. A ceiling of 3
  // therefore reads as "will lean on anything smaller than a truck": a roadster
  // one time in two, a sedan two in five, a van one in four, and a rig never,
  // because a rig is the one thing out here it cannot win against.
  //
  // AND IT DODGES EVERY HAZARD, without exception, because it is AMBER. That is
  // not a compromise — it is what keeps the two kinds of aggression separate.
  // Barging a stack of barrels is a claim about the driver's judgement; leaning
  // on the car beside it is a claim about their manners. This car has bad
  // manners and perfectly good judgement, and the palette is why it can.
  brawler: profile({
    laneDiscipline: 0.6, // sloppier than the sedan, tidier than the roadster
    laneHome: "any",     // no preference at all: it drives where it likes, which
                         // is also what keeps it out of the road's speed gradient
    patience: 0.4,       // it gives you a moment. Not much of one
    passSpeedMargin: 8,  // and will go for a small gain
    passClearance: 9,    // passing close enough to be a statement
    // Sits on your bumper. Its drivers top out at 360, so 240 of closing needs 85
    // units of road against the 145 this leaves — the tailgating is comfortably
    // legal, and unlike the roadster's it stays legal if something quicker is
    // ever pointed at this profile.
    followGap: 25,
    followReaction: 0.5,
    // Muscle, used as muscle. Capped at the type's speedMax like every
    // passEffort, and the catalogue clips it the same way the hypercar's is
    // clipped: 310 * 1.2 = 372 against a ceiling of 360, so a car that rolled
    // slow gets the full shove and one that rolled at the top gets none. Worth
    // knowing before tuning it — the cruise roll and the hard cap are the same
    // field, so no type can have headroom above its own fastest cruise.
    passEffort: 1.2,
    nerve: 0,    // amber: it dodges everything. See above — this is the load-
                 // bearing half of the design, not a concession
    contact: 3,  // ...and leans on everything. See above
  }),

  // --- Hostile dispositions --------------------------------------------------
  // One per enemy type, carrying the nerve figures that used to sit in
  // cartypes.js. They are separate profiles rather than one shared "hostile"
  // because the numbers genuinely differed per type, and flattening them here
  // would have been a silent retune of Phase 3's traffic.
  //
  // THEIR CHASING IS NOW TUNED HERE TOO, which it was not when this section was
  // written: the enemy tactics landed in behaviours.js but their numbers stayed
  // behind as module constants there, so for a while every hostile profile was
  // a `nerve` figure and nothing else. The chase fields on COMMUTER above are
  // where that went. Most rows still say nothing about them, and that is the
  // system working — a hostile only states a figure where it genuinely differs
  // from the enemy baseline.
  pursuer: profile({ nerve: 12 }),   // interceptor: through a trestle a third of
                                     // the time — the baseline gamble
  // UNCLAIMED. This was the muscle car's, and the muscle car is a civilian now
  // (cartypes.js). Kept rather than deleted because the ROLE it describes did not
  // go anywhere — a heavy hostile that shoves, and gambles on a trestle half the
  // time — and the replacement enemy will want exactly this row. A profile nobody
  // drives constrains nothing and costs nothing: the braking-rule invariant skips
  // it, and `typesDriving` returns an empty list.
  //
  // STILL UNCLAIMED after the stocker. The replacement hostile arrived and wanted
  // something else — it races rather than shoves, so it drives `roadracer` below
  // and left the `block` tactic here with this row. The pair is waiting for a
  // second heavy that gets in front of the player and sits there.
  enforcer: profile({ nerve: 16 }),
  // The bruiser: three in five through a trestle, the type least interested in
  // going round anything.
  batterer: profile({
    nerve: 20,
    // THE ONE HOSTILE THAT CHASES SLOWER THAN THE REST, and the only chase
    // figure in this file that is not the baseline. It closes to HIT rather
    // than to hold a firing gap, so it does not need to match a fleeing player
    // — it needs to be quick enough to catch one who is busy with the road.
    // Still well above its own 330 (cartypes.js), which is the point of the
    // field; see chaseSpeed on COMMUTER for why that gap is deliberate.
    chaseSpeed: 560,
  }),
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
    // THE ONLY DRIVER ON THE ROAD THAT EVER GIVES THE PLAYER UP. Everything
    // else hostile keeps coming forever (giveUpTime 0, see COMMUTER), which is
    // what makes the interceptor the road's standing pressure; this one fights
    // ONE engagement and then rides off for good. Counted in seconds of LOST
    // CONTACT, not seconds of fight — a player who cannot shake it never lets
    // the clock start, so a stocker glued to your bumper is never on a timer.
    giveUpTime: 3,
  }),
  // The cycle, and the catalogue's clearest use of the dial: 25 hull means a
  // trestle costs it a third of its life, and it is the nimblest thing on the
  // road. It goes round because going round is what it is FOR — the contrast
  // with the bruiser above is why these are per type at all.
  //
  // `contact` READ 4 UNTIL THE QUANTISATION TEST WENT IN, and 4 was a setting
  // that did nothing: the cycle steers at 180, so its cheapest possible contact
  // in the whole catalogue is 7.35 hull and no roll under a ceiling of 4 ever
  // reached it. Zero is what it always meant. It is also what it should say —
  // any contact at all costs this type at least a third of its 25 hull, so the
  // one car on the road that goes round everything goes round cars too.
  //
  // PATIENCE DROPPED TO NEXT TO NOTHING. It carries no gun — its one attack is
  // a single mine dropped once it has fought its way past whatever is holding
  // it up (behaviours.js's `raid`) — so sitting behind traffic waiting out the
  // commuter's 1.2s is time spent not attacking rather than time spent being
  // careful. It still won't overtake into anything it doesn't tolerate; it
  // just stops pretending to be patient about it.
  darter: profile({ nerve: 0, contact: 0, patience: 0.1 }),
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
