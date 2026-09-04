// Driving profiles — the numbers behind a tactic.
//
//   cartypes.js   what a car IS      — size, mass, hull, speed band, silhouette
//   armament.js   what it CARRIES    — which gun, which mine layer
//   driving.js    how it DRIVES      — the disposition behind the manoeuvres
//   behaviours.js what it CAN DO     — the manoeuvres themselves (the code)
//
// A car type names a `behaviour` (which manoeuvres it knows) and a `driving`
// profile (how boldly it runs them), so a new type is usually no new code.
//
// Profiles are shared and FROZEN: one object per profile, resolved at load and
// handed to every car naming it (traffic.js stores it as `car.drive`), so a
// per-tick read is one field access. Two hundred sedans share one object —
// nothing may write to a profile.
//
// behaviours.js keeps HAZARD_DODGE_SPAN and HAZARD_SAFETY as its own constants:
// they feed `dodgeDistance`, which obstacles.js sizes its spawn margin against,
// so they are a contract between files rather than a disposition.
//
// No imports — this file is the leaf of the dependency graph, which is what
// lets cartypes.js, behaviours.js and the tests read it without a cycle.

// --- The knobs ---------------------------------------------------------------
//
// `commuter` is both the reference and the documentation: every field appears
// once, here. Every other profile is a DELTA from it.
//
// THREE FIELDS ARE MARKED "baseline only" — no profile in the catalogue below
// turns them. That is not the same as a constant, and the distinction is what
// decides where a number lives: a knob stays here when a future type could
// plausibly want its own, and moves next to the tactic when the figure is
// ARITHMETIC AGAINST ANOTHER FILE, one HALF OF A PAIR that only means anything
// alongside the other, or DERIVABLE FROM THE CATALOGUE and so never a choice at
// all. behaviours.js's PURSUE_RANGE, RAM_FLOOR, RAM_BRAKE and LOOK_BEHIND_SLACK
// left on those grounds — RAM_FLOOR is sized against player.js's minimum speed,
// RAM_BRAKE is the same block's other end and useless read apart from it, and
// the look-behind turned out to be the two cars' own lengths plus a margin no
// profile had a reason to differ on. These three did not.
//
// The marker exists so a reader tuning the road knows which knobs the catalogue
// is actually using (nineteen of them) without diffing every profile against
// this one.
const COMMUTER = {
  // --- Following ------------------------------------------------------------
  followGap: 40,        // clear road wanted nose-to-tail (behaviours.js followSpeed)
  // Seconds of closing rate added to that gap. The one knob with a hard floor:
  // traffic sheds speed at traffic.js's ACCEL, so shedding dv costs dv²/(2·ACCEL)
  // of road, and a follower can only match while
  //     dv² / (2·ACCEL)  <=  followGap + dv·followReaction
  // for every closing speed dv the types naming this profile can produce (that
  // type's max minus the player's minimum). Asserted per profile in
  // test/hazards.test.js — profiles below state their headroom only where the
  // pair is tight.
  followReaction: 1.0,

  // --- Lane discipline ------------------------------------------------------
  // How hard this driver insists on a lane CENTRE, 0..1, read as a TOLERANCE: it
  // accepts being (1 - laneDiscipline) * half a lane off centre before
  // correcting. Not cosmetic — nothing else re-derives which lane a car belongs
  // in, so a car shoved sideways by a ram would otherwise steer back across live
  // traffic to the lane it spawned in.
  laneDiscipline: 1.0,
  // Which lane it would RATHER be in: "any" | "inner" (fast, by the centre-line)
  // | "outer" (by the barriers). Never worth a lane change through traffic, so
  // behaviours.js acts on it only when the wanted lane is already free.
  laneHome: "any",

  // --- Overtaking -----------------------------------------------------------
  patience: 1.2,        // seconds held up before it commits to a pass
  passTrigger: 220,     // world units: a blocker further off isn't holding us up
  passMargin: 30,       // ...the nose must clear before pulling back in.
                        // BASELINE ONLY: every profile runs the same margin
  passTimeout: 6,       // seconds before an unfinished pass is abandoned
  passSpeedMargin: 15,  // how much faster we must want to be to bother
  passClearance: 12,    // px of daylight between the boxes as it goes by
  passLookAhead: 140,   // world units of the pass line checked beyond the NOSE of
                        // the car we mean to pass — a planning distance, and the
                        // one look figure that is genuinely chosen rather than
                        // measured. There is no matching figure for BEHIND: what
                        // counts as beside this car is the two bodies' own
                        // lengths, so behaviours.js derives that instead — see
                        // its LOOK_BEHIND_SLACK
  passEffort: 1.15,     // how much harder it drives while committed to a pass.
                        // CAPPED at the type's own speedMax (behaviours.js), so
                        // it does nothing for a type whose cruise band already
                        // reaches the top of its hard band — which is every type
                        // as shipped. Check the catalogue before tuning this

  // --- Hazards --------------------------------------------------------------
  hazardClearance: 6,   // px of daylight wanted when steering past one

  // --- Chasing the player ---------------------------------------------------
  // Read by behaviours.js's `pursue`, `trail`, `ram` and `raid`; inert for every
  // civilian, and listed here so a hostile omitting one inherits the enemy
  // baseline rather than a hole.
  pursueHold: 200,      // gap held behind the player while chasing. Comfortably
                        // inside armament.js's GUN_RANGE, with slack either side
                        // for pursueGain to correct in without clipping the
                        // firing window
  pursueGain: 1.2,      // proportional term on the gap error, not a limit —
                        // traffic.js's ACCEL still gets `speed` there.
                        // BASELINE ONLY
  // NO CHASE CEILING LIVES HERE, and the absence is the design. A `chaseSpeed`
  // did — an absolute figure a chasing car asked for, deliberately under what
  // its chassis could give — and it was removed: HOW FAST A CAR CAN CHASE IS A
  // FACT ABOUT THE CAR, so the one ceiling is the type's own `speedMax`
  // (cartypes.js), which traffic.js already clamps every request to. A second,
  // profile-wide ceiling beneath it only ever said "this car may not spend what
  // it has", which is not a disposition any driver had a reason to hold.
  //
  // What keeping it cost: the field sat on a SHARED table, so the interceptor
  // and the rival were leashed to 600 by a figure neither catalogue entry
  // mentioned, while the stocker and the bruiser had to open their
  // cruiseMax..speedMax gap to exactly that figure to reach a pace they were
  // already rated for — two types tuned where nobody would look, and two
  // stating the same number twice. Chase pace is `speedMax` and only
  // `speedMax`; see cartypes.js's THE TWO SPEED BANDS.
  // Seconds of LOST CONTACT before this driver gives the player up for good, or
  // 0 for never — the baseline, and what makes `pursue` the road's standing
  // pressure rather than a timed encounter. Only behaviours.js's `trail` reads
  // it; giving up there leaves the car permanently unarmed, so it is a one-way
  // switch rather than a lull.
  giveUpTime: 0,
  raidGain: 1.5,        // gain on the MINE RUN's hold (behaviours.js `raid`),
                        // separate from pursueGain because holding station AHEAD
                        // of a target you must not out-pace is tighter. Read by
                        // `outrun` too, which is that hold without the mine.
                        // BASELINE ONLY, and kept a knob rather than a constant
                        // because the three tactics reading it are exactly where
                        // a boss would want its own
  // The gap held AHEAD of the player by behaviours.js's `outrun` — the one
  // tactic that attacks from in front. Bounded at both ends by the gun rather
  // than by taste: under armament.js's GUN_MIN_RANGE it is inside contact range,
  // over GUN_RANGE (or over the road the player can see ahead, the tighter of
  // the two) it is a hostile posing out of range. test/hazards.test.js says so.
  leadHold: 300,
  // The sweep behaviours.js's `strafe` rides across the player's line: how far
  // either side, and seconds for a full there-and-back. Read TOGETHER — a span
  // the steering cannot cover in the time is not a faster weave, it is a lazy
  // drift, since the car chases a sine it never catches. Pinned against the
  // type's own steerSpeed in test/hazards.test.js.
  weaveSpan: 40,
  weaveTime: 1.6,

  // --- Nerve: what this driver will accept hitting --------------------------
  //
  // Two tolerances, one mechanism. Both are hull damage this driver will eat
  // rather than leave its line, against an estimated cost — a hazard's own
  // `threat` (obstacles.js), or what collisions.js says an impact would take
  // off. Separate numbers because the risks differ in kind:
  //
  //   nerve    ROADBLOCKS. Must stay 0 for every civilian: an amber car swerving
  //            has to mean "there is something in that lane". The pale civilians
  //            (roadster, hypercar) are the exception the palette signals. Also
  //            what keeps mines the PLAYER's problem — no type reaches the
  //            tetra's 24, so none reaches the mine's 30, so traffic never
  //            clears a mine and score.js never fines the player for it.
  //
  //   contact  OTHER CARS. Free to vary: a fender-bender reads as driving rather
  //            than as a mistake, and is what makes an impatient driver look it.
  //
  // Each car ROLLS its own tolerance uniformly in [0, the figure] at spawn
  // (traffic.js), so the profile's number is a CEILING and two roadsters meeting
  // the same barrels do different things. Rolled once for life — a fresh flip
  // per tick would swerve and unswerve all the way down the road.
  //
  // Against the hazard catalogue (obstacletypes.js `blastDamage`: barrels 5,
  // trestle 8, tetra 24, mine 30), P(barge) = 1 - damage/nerve, or 0 when
  // damage >= nerve. So the dial is QUANTISED: anything below 5 does nothing,
  // and the first setting that exists is "sometimes barges barrels".
  // BOTH DEFAULT TO 0, AND NEITHER DEFAULTS TO THE OTHER. `contact` used to
  // inherit `nerve` wherever a profile omitted it, and that was a units error:
  // the two are weighed against different quantities — `nerve` against a
  // hazard's `threat` (5 to 30 across obstacletypes.js), `contact` against a
  // hull cost that runs 0.3 to 9.6 across the whole catalogue — and they only
  // looked interchangeable because those ranges overlap. The four hostiles that
  // set a nerve inherited a contact ceiling of 10-20 against costs of at most
  // 9.6, i.e. "leans on anything, always", which was nobody's decision.
  //
  // Every profile now states both. The cost of that is five more lines; what it
  // buys is that a driver willing to shoulder through traffic has to SAY so.
  nerve: 0,
  contact: 0,
};

// Build one profile from COMMUTER plus a delta, and freeze it.
function profile(delta = {}) {
  return Object.freeze({ ...COMMUTER, ...delta });
}

// --- The catalogue ------------------------------------------------------------
// The civilian road is a LANE GRADIENT, built here rather than in any one
// profile: the two slow haulers want the outer lanes, the two fast machines the
// inner, and the sedan fills whatever is left. The road sorts itself by speed,
// so the player's choice of lane is a choice about what they will meet there.
// Asserted in test/hazards.test.js, so a retune putting a rig in the fast lane
// fails rather than merely looking odd.
//
// One profile per type. The van and the rig could share a "slow and heavy" table
// and deliberately do not: their most legible difference is that the van wanders
// and the rig does not, which is the one field sharing would cost.
export const DRIVING_PROFILES = {
  // The reference, and the fallback for anything naming nothing. The sedan alone
  // drives it — it stays the plain one every other profile differs FROM.
  commuter: profile(),

  // The roadster. The impatient civilian, on the same `overtake` tactic as the
  // sedan — so every difference visible on the road comes out of this table,
  // which is how the profile system is observed working at all.
  hustler: profile({
    laneDiscipline: 0.3, // rides the lane edges. Against the sedan's dead centre
                         // this is the most visible line in the file
    laneHome: "inner",   // lives in the fast lane
    patience: 0.2,       // pulls out almost the moment it is held up
    passSpeedMargin: 5,  // and will pass for almost any gain at all
    passClearance: 7,    // cutting closer as it goes by
    passTimeout: 4,      // gives up sooner and tries again rather than committing
    // Tailgates, and only legally because nothing fast drives this profile: the
    // roadster's worst closing speed is 440, needing 285 units of road against
    // the 306 this allows. Point a quicker type here and the invariant fails.
    followGap: 20,
    followReaction: 0.65,
    // Barges barrels (5) about a third of the time, never a trestle (8) — the
    // whole of what "takes risks" can mean at this end of the quantised dial.
    // Contact BELOW nerve: it gambles on junk in the road more readily than it
    // leans on a car, which is the difference between reckless and rude.
    nerve: 8,
    contact: 6,
  }),

  // The van. Slow, wide, out of the way — and uniquely on this road it expresses
  // itself through `contact` rather than `nerve`.
  //
  // `contactCost` scales with the car's own steerSpeed (behaviours.js), so the
  // van's 60 against collisions.js's floor of 40 puts every contact it could
  // make in the 0.7-1.5 hull band. A ceiling of 1.2, rolled per car, comes out
  // as: squeezes past a roadster two times in five, a sedan one in three,
  // another van one in eight, never a rig — a driver who leans on small cars and
  // gives way to big ones, out of one number. The roadster cannot do this: it
  // steers at 140, its contacts cost 4-9, and its dial is coarse.
  //
  // Most of the table is inert here — the van's tactic is `cruise`, which never
  // passes. `passLookAhead` IS read (`blocked` uses it for the lane preference
  // and the hazard dodge), which is why it stays at the commuter's figure rather
  // than being tuned.
  hauler: profile({
    laneDiscipline: 0.85, // a big box that never quite settles on the centre-line
    laneHome: "outer",    // keeps out of the way: the slow side of the gradient
    followGap: 55,        // heavier and slower to shed speed than it looks, so it
    followReaction: 1.2,  // starts backing off early
    hazardClearance: 10,  // a wide vehicle gives a roadblock a wide berth
    nerve: 0,             // amber: it dodges everything, without exception
    contact: 1.2,         // ...but it will lean on something small. See above
  }),

  // The rig. The one that cannot react, and drives like it knows. Discipline is
  // left at the commuter's 1.0 rather than loosened, deliberately opposite to
  // the van: the wandering thing on this road should be the van, not the truck.
  juggernaut: profile({
    laneHome: "outer",   // a lane-and-a-half of wall belongs by the barrier
    followGap: 90,       // the longest look-ahead on the road, and pure character
    followReaction: 1.6, // — a rig that brakes late reads as a car
    hazardClearance: 14, // the widest berth in the catalogue
    nerve: 0,            // amber, and the type most likely to be standing near a
                         // hazard the player wanted left alone
    // `contact: 0` makes this a binary switch regardless of price: `tolerated`
    // reads the profile ceiling rather than the price, so nobody clears it and
    // the rig never takes an occupied lane. (The rig steers at 35, which used
    // to sit under collisions.js's DAMAGE_FLOOR and price every lane change at
    // zero hull outright — the floor has since come down to 25, so that is no
    // longer true on its own, but the ceiling here still means never.)
    //
    // Never is the setting, and it was measured: contacts fall from 7.0-8.8 per
    // minute to 3.9-5.9, hazard strikes are indistinguishable either way, and
    // the rig gives up 2-3% of its life stopped in a live lane. Free contacts
    // are still SHOVES — a 4-mass wall displaces whatever it touches, which is
    // chaos the damage model happens not to bill for.
    contact: 0,
  }),

  // The hypercar. Fast and immaculate — the counterweight to the roadster, since
  // those two are the road's only pale civilians. Same shade, similar speed,
  // opposite manners: the roadster cuts past at 7px, this one sweeps by at 20.
  showpiece: profile({
    laneHome: "inner", // the fast side of the gradient
    patience: 0.15,    // it does not queue
    // Its caution is FORCED, not chosen: at 700 the braking rule has to cover
    // 580 of closing, needing 495 units of road against the 534 this pair
    // allows. The fastest civilian necessarily leaves the most room in front.
    followGap: 70,
    followReaction: 0.8,
    // And the trigger has to clear that braking gap — it starts backing off
    // inside 534 units, so at the commuter's 220 this car would have matched the
    // blocker's speed long before considering a pass. Wrong for the one civilian
    // whose whole character is that it does not slow down.
    passTrigger: 560,
    passLookAhead: 260,  // it needs to see further, because it eats road faster
    passSpeedMargin: 60, // only bothers for a gain it can realise — this is what
                         // stops it committing to a pass on a cycle
    passClearance: 20,   // it does not scrape. The widest pass on the road
    passEffort: 1.0,     // deliberately none: its cruise roll already runs up to
                         // the speedMax that caps passSpeed, and it is 200
                         // units/sec faster than anything it would want to pass
    hazardClearance: 12,
    nerve: 0,   // pale, so it is ALLOWED to barge — and doesn't. 45 hull, and a
                // showpiece that scrapes is not a showpiece
    // Never leans on anyone: at 160px/sec sideways its cheapest contact is 4.5
    // hull, a tenth of its life. It costs 8-11% of its life stopped against the
    // commuter's 4%, because a driver that will not take an occupied lane has
    // only the brake left. A ceiling of 7 buys two of those points back; zero is
    // kept because "would rather stop than scrape" IS the character. If the
    // stopping ever reads as broken, this is the number to move.
    contact: 0,
  }),

  // The muscle car. Heavy AND reckless — the combination the civilian road did
  // not otherwise have. It steers at 85 and weighs 1.7, so its contacts price at
  // 1.1 (a cycle) to 3.3 (the rig) against 110 hull, a rounding error: a ceiling
  // of 3 reads as "will lean on anything smaller than a truck". The roadster is
  // the other impatient civilian and pays 4-9 hull off 40 for every liberty.
  //
  // And it dodges every hazard, because it is AMBER — which keeps the two kinds
  // of aggression separate. Barging barrels is a claim about the driver's
  // judgement; leaning on the car beside it is a claim about their manners. This
  // one has bad manners and good judgement.
  brawler: profile({
    laneDiscipline: 0.6, // sloppier than the sedan, tidier than the roadster
    laneHome: "any",     // drives where it likes, which also keeps it out of the
                         // road's speed gradient
    patience: 0.4,       // it gives you a moment. Not much of one
    passSpeedMargin: 8,  // and will go for a small gain
    passClearance: 9,    // passing close enough to be a statement
    followGap: 25,       // sits on your bumper, with room to spare on the braking
    followReaction: 0.5, // rule — 85 units needed against the 145 this leaves
    passEffort: 1.2,     // muscle used as muscle, though the catalogue clips it:
                         // 310 * 1.2 = 372 against a ceiling of 360, so a car
                         // that rolled slow gets the shove and one at the top
                         // gets none
    nerve: 0,            // amber: it dodges everything. The load-bearing half of
                         // the design, not a concession
    contact: 3,          // ...and leans on everything. See above
  }),

  // --- Hostile dispositions --------------------------------------------------
  // One per enemy type, because the numbers genuinely differ per type. Most say
  // nothing about the chase fields on COMMUTER, which is the system working — a
  // hostile states a figure only where it differs from the enemy baseline.
  //
  // EVERY HOSTILE SETS `contact` TO 0, and it is one decision rather than six.
  // The enemy's aggression is its WEAPONS: a car that also shouldered its way
  // through the traffic between it and the player would be spending hull on the
  // approach, and the road would fill with wrecks the player never touched. The
  // hostile that leans on people is a role the catalogue can still add — it just
  // has to be chosen, which is the whole point of no longer inheriting it from
  // `nerve`. Its own bikes and the darter already reasoned their way to 0
  // independently; this is the rest of the fleet agreeing.
  pursuer: profile({ nerve: 12, contact: 0 }), // interceptor: through a trestle
                                     // a third of the time — the baseline gamble
  // UNCLAIMED — no type drives this, and behaviours.js's `block` tactic is
  // likewise unclaimed. Kept because the role is still wanted: a heavy hostile
  // that shoves — and the one profile where a nonzero `contact` would be the
  // point, whenever a type claims it. A profile nobody drives constrains nothing
  // (the braking-rule invariant skips it) and costs nothing.
  enforcer: profile({ nerve: 16, contact: 0 }),
  // The bruiser: three in five through a trestle, the type least interested in
  // going round anything. Its `contact` of 0 says nothing about how it treats
  // the PLAYER — ramming is behaviours.js's `ram`, which never consults this.
  batterer: profile({
    nerve: 20,
    contact: 0,
  }),
  duelist: profile({ nerve: 10, contact: 0 }), // rival: a driver, not a battering
                                     // ram — it would rather keep the line clean
  // The stocker: a heavy off a circuit rather than out of a garage, and the only
  // hostile that runs a RACING line — it lives on the lane edges and pulls out
  // early, so it arrives from the side of the road rather than up the middle.
  // The cage is why its nerve sits above the interceptor's: junk in the road
  // costs it paint, not a wheel.
  roadracer: profile({
    laneDiscipline: 0.35,
    patience: 0.5,
    nerve: 14,
    contact: 0,
    // The only driver on the road that ever gives the player up; everything else
    // hostile keeps coming forever. Counted in seconds of LOST CONTACT, not
    // seconds of fight, so a stocker glued to your bumper is never on a timer.
    giveUpTime: 3,
  }),
  // The cycle: 25 hull means a trestle costs it a third of its life, and it is
  // the nimblest thing on the road. It goes round because going round is what it
  // is FOR — the contrast with the bruiser is why these are per type at all.
  // `contact` is 0 rather than small because small would do nothing: it steers
  // at 180, so its cheapest possible contact is 7.35 hull. Patience is next to
  // nothing because it carries no gun — its one attack is a mine dropped after
  // it has fought past whatever holds it up (behaviours.js's `raid`), so
  // queueing is time spent not attacking rather than time spent being careful.
  darter: profile({ nerve: 0, contact: 0, patience: 0.1 }),

  // --- The motorcycle fleet --------------------------------------------------
  // Three hostiles sharing one physical fact — nothing here weighs more than 0.7
  // or carries more than 45 hull — and therefore sharing the two settings that
  // fact forces: nerve 0 and contact 0. A bike does not barge and does not lean
  // on anybody; both would cost it a life it does not have. Everything telling
  // the three apart is the chase, where they differ completely.
  //
  // Both zeros are also the only settings AVAILABLE to them, which is the
  // quantisation the two dial tests describe: at 160-200px/sec of steering, the
  // cheapest contact a bike can be offered is over 6 hull, so any ceiling worth
  // writing would be a fifth of its life.

  // The outrider: holds a tighter gap than the interceptor's baseline 200,
  // because the SMG is a spray rather than an aimed round and a burst wants to
  // be close enough that its spread still lands. The weave is left at the
  // reference figures — 40px either side at 1.6s a sweep, which its 200px/sec
  // steering covers three times over.
  outrider: profile({
    laneDiscipline: 0.1, // it is never settled in a lane; saying so here keeps
                         // the approach as loose as the attack
    patience: 0.3,       // it wants to be behind the player, not behind a bus
    pursueHold: 150,
    nerve: 0,
    contact: 0,
  }),

  // The outrunner: the one profile whose chase is spent getting IN FRONT.
  // Patience is the lowest of the three because everything it wants is up the
  // road — a queue is not a delay to its attack, it IS the thing stopping the
  // attack — and `leadHold` stays at the reference 300, which frames it high on
  // the screen with road to spare inside the gun's reach.
  outrunner: profile({
    patience: 0.2,
    passSpeedMargin: 6, // it will take almost any gap that gains it a length
    nerve: 0,
    contact: 0,
  }),

  // The sower: the cycle's disposition, near enough, and for the cycle's reason
  // — it has one thing to lay and queueing is time spent not laying it.
  // `raidGain` stays at the reference: holding station over the drop is the same
  // problem for a strip as for a mine.
  sower: profile({
    patience: 0.1,
    nerve: 0,
    contact: 0,
  }),

  // The siege mortar. The outrunner's disposition — everything it wants is up
  // the road — with two figures moved for reasons about the BOSS rather than
  // about driving.
  //
  // `leadHold` 420 rather than the reference 300: it holds higher on the screen
  // than any other hostile, which puts a 90px hull at the top edge with the
  // whole barrage landing in the road between it and the player. NOT bounded by
  // armament.js's gun band the way the outrunner's is — this car has no gun (see
  // behaviours.js's `siege`) — but still well inside the road the player can see
  // ahead, which is the rule that does apply and the one the suite checks.
  //
  // NERVE AND CONTACT AT ZERO, like every other hostile, and worth saying out
  // loud here: a boss that shouldered through hazards would clear the very
  // minefield it is trying to drive the player into.
  battery: profile({
    patience: 0.15,
    leadHold: 420,
    nerve: 0,
    contact: 0,
  }),

  // The bunker trailer, the second boss. `outrun` (behaviours.js), unlike the
  // siege battery's own `siege`, so `leadHold` answers to armament.js's gun
  // band as well as to the framing rule — see test/hazards.test.js, which
  // checks every type naming `outrun` against GUN_MIN_RANGE..GUN_RANGE. 420
  // is the siege battery's own figure, reused rather than re-derived: it
  // already sits inside that band with room either side, and a second boss
  // holding at the same height on the screen is the same promise the first
  // one made — "the player must be able to see the thing attacking them" — not
  // a coincidence worth a new number.
  //
  // NERVE AND CONTACT AT ZERO, and PATIENCE AT THE SIEGE BATTERY'S OWN 0.15,
  // for its own reason: a boss that shouldered through hazards would clear
  // the very mines it is laying to fight in front of.
  bunker: profile({
    patience: 0.15,
    leadHold: 420,
    nerve: 0,
    contact: 0,
  }),

  // The skirted barge, the third boss. Same disposition as the bunker's own
  // — `outrun` (behaviours.js), the siege battery's own 420 `leadHold` —
  // because none of what makes this fight different lives in HOW it drives.
  // That is cartypes.js's `roadMargin`, read by `trackTarget` and
  // `clampToRoad` rather than by anything in this table: a third boss
  // holding at the same height on screen, past a wider line, is still the
  // same promise the first two made.
  //
  // `followReaction` IS TURNED, and it is the one figure here that answers
  // to arithmetic rather than to character: this profile's only driver tops
  // out at 900 (cartypes.js's own OVERDRIVE note), so its worst closing
  // speed against the player's own MIN_SPEED is 800 units/sec, needing 941
  // units of road to shed (test/road-and-caches.test.js's braking rule) —
  // the reference COMMUTER's 40 followGap + 1.0 followReaction covers only
  // 840. 1.3 clears it (40 + 800*1.3 = 1080) with room, the same knob
  // COMMUTER's own header names as the one with a hard floor.
  barge: profile({
    patience: 0.15,
    leadHold: 420,
    followReaction: 1.3,
    nerve: 0,
    contact: 0,
  }),

  // The catamaran gunship, the fourth boss. `siege` (behaviours.js), the
  // mortar's own tactic — this one carries no gun either, so `leadHold` need
  // only answer to the framing rule, not to armament.js's gun band, exactly
  // as `battery`'s own note says. NO followReaction bump, unlike the barge's:
  // this boss's speedMax stays at the shared 730 arrival pace rather than
  // opening a chase gap, because a barrage has no range gate (armament.js's
  // fireBarrage) — outrunning it on overdrive was always the mortar's one
  // intended escape, not a bug this boss needs to close.
  catamaran: profile({
    patience: 0.15,
    leadHold: 420,
    nerve: 0,
    contact: 0,
  }),

  // The gunship (cartypes.js) — the only profile here driving something that is
  // not on the road, and the only one whose sweep is bounded by the SCREEN
  // rather than by the tarmac (behaviours.js's `patrol` and its FLIGHT_LIMIT).
  //
  // `leadHold` STAYS AT THE REFERENCE 300, and it is the same rule the boss's
  // 420 is measured by: hold where the player can see you. That puts a 70px
  // hull high in the frame with the player looking up at it, and well inside
  // both armament.js's gun band and the road visible ahead — the two bounds
  // test/hazards.test.js checks every station-keeper against.
  //
  // THE SWEEP IS THE WHOLE CHARACTER, and it is four times the outrider's 40.
  // That figure is not a preference: 150 either side of the player's own line
  // carries the hull clear of a 143px half-road from anywhere on it, so the
  // sweep VISIBLY leaves the tarmac and comes back, which is the one thing that
  // makes this read as flying rather than as a very wide car. It is also why
  // `weaveTime` is three times the outrider's 1.6 — the pair is read together
  // (see weaveSpan above), and 4 * 150 = 600px in 4.5s needs 133px/sec against
  // this type's 240, with the sine's own peak rate (2*PI*150/4.5 = 209) also
  // inside it. A shorter time here would come out as a drift, not a faster
  // sweep, which is exactly what that test exists to catch.
  //
  // NERVE AND CONTACT AT ZERO like every other hostile, and here they are not
  // merely unread but unreadable: behaviours.js skips the hazard reflex outright
  // for an airborne car, so there is no gamble for a nerve figure to price.
  gunship: profile({
    leadHold: 300,
    weaveSpan: 150,
    weaveTime: 4.5,
    nerve: 0,
    contact: 0,
  }),
};

// The profile a car type drives by. A named profile always wins; an unknown name
// falls back to the commuter rather than throwing, on the same grounds as
// behaviourFor — a half-finished type should still drive.
//
// Faction is NOT a default here, unlike armament.js's: "armed" follows from
// being hostile, but "drives like this" follows from nothing, so a hostile that
// forgot to name a profile should drive blandly rather than inherit somebody
// else's temperament.
export function drivingFor(type) {
  return DRIVING_PROFILES[type.driving] ?? DRIVING_PROFILES.commuter;
}

// Every car type that drives `name`. Exported for the per-profile invariant
// test, which has to know whose speeds a profile's braking rule must cover.
// Takes the catalogue as an argument rather than importing it, so this file
// keeps its one-way dependency on cartypes.js.
export function typesDriving(name, types) {
  return types.filter((t) => drivingFor(t) === DRIVING_PROFILES[name]);
}
