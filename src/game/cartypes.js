// The traffic catalogue — every kind of car on the road other than the player.
//
// A type is pure DATA: how it looks, how fast it drives, how much punishment it
// takes, how big a hole it leaves when it goes up, and which BEHAVIOUR drives it
// (see behaviours.js). Adding a new kind of traffic means adding an entry here
// and, if it needs new tactics, a behaviour function. Nothing in traffic.js knows
// any type by name.
//
// ONE TYPE PER SILHOUETTE. The catalogue is a 1:1 map onto game/carshapes.js,
// and the shape is what tells types apart on the road: EVERY FACTION SHARES ONE
// BASE CHASSIS COLOUR — civilians in NEUTRAL, hostiles in ENEMY_DEEP — so each
// faction reads as one fleet and only the silhouette distinguishes within it.
//
// `accent` is the one exception, and it is a SIGNAL rather than decoration: the
// roadster names one because it is the one civilian whose profile gambles
// through light debris instead of always dodging (driving.js's nerve section,
// and the invariant test "the amber civilians always dodge"). A type with no
// reason to stand out omits it. No hostile needs one — nerve on the enemy side
// carries no such readability rule.
//
// The one shape shared with the player (SUPERCAR) is deliberately given to an
// ENEMY: your own silhouette coming at you in the hostile shade reads as a
// rival, where a civilian copy of the player's car would just look like a bug.
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
// WITHIN a type, no two cars drive alike, and none of it costs a sprite: the
// range is ROLLED per spawn; each car then WANDERS ±4% around its roll on its own
// period so a close-rolling pair separates instead of locking into formation
// (traffic.js DRIFT); and an overtaker spends up to its profile's `passEffort`
// more while committed to a pass. Civilian types carry the widest ranges, since a
// civilian type is a spread of ordinary drivers; the speed machines are defined
// by their ceiling and stay narrow. Both extras are CAPPED by speedMin/speedMax.
//
// The band's WIDTH is not free: traffic sheds speed at traffic.js's ACCEL, and
// behaviours.js sizes a follower's gap from that rate. The largest closing speed
// the catalogue can produce is 730 - 120 = 610 units/sec, and ACCEL is set so one
// second of closing rate still covers the road needed to match it. Widening the
// band means revisiting that pair — see driving.js's followReaction, sized per
// profile against the types that actually drive it.
//
// SPRITE-CACHE BUDGET. Every distinct (shape, color, thrust, w, h) is a cache key
// in sprites.js, times WHEEL_FRAMES (8), plus one more colour for the
// critical-hull blink: 12 types * 8 * 2 = 192 sprites at worst, built lazily.
// Keeping the catalogue a small FIXED list is what bounds it — vary cars by
// ADDING A TYPE, never by rolling continuous per-instance sizes or colours.
// Per-instance variety comes from speedMin..speedMax, which costs nothing
// because speed doesn't affect the artwork.

import { carShapeIndex } from "./carshapes.js";
import { DIST_UNITS } from "./road.js";
import { pickWeighted } from "./weightedpick.js";
import {
  ENEMY_DEEP,
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

// `value`, below, is written as a LITERAL on every entry — not a reference to
// a shared constant — precisely so it is already the field to edit when a type
// needs to diverge (a rig worth more than a sedan, a rival worth more than an
// interceptor, a boss worth a windfall) without touching score.js or any other
// entry. Every entry happens to read 100 or -100 today: deliberately UNIFORM
// FOR NOW, one flat figure for the enemy and its mirror image for the city's
// own traffic, but that's a starting VALUE, not a starting STRUCTURE — the
// scaffolding for telling types apart is already in place.

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
// One figure for the whole faction for now, exactly as every hostile's own
// literal `value` (below) currently reads the same 100 — the point of putting
// `minDistance` on every type separately is that the enemy can later be
// STAGED (interceptors early, a rival only much later) without touching a
// line of traffic.js. Spread the entries when there is a reason to; leave this
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
// message than "FOCUS is still set". See test/hazards.test.js.
export const FOCUS = [];

// TWO AXES OF BEHAVIOUR, and a type names both.
//
//   behaviour  the TACTIC — which manoeuvres this car knows (behaviours.js)
//   driving    the PROFILE — how boldly it runs them (driving.js)
//
// That split is what makes a new type cheap: the sedan and the roadster share
// one tactic and differ entirely in the table they point at. A type that names
// no profile gets the commuter's, which is the sedan's: bland and obviously so.

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
//   value       points scored for DESTROYING this car (score.js). A LITERAL on
//               every entry, not a shared constant, so a type can be given its
//               own figure at any time (a boss, a special civilian) by editing
//               only this line. Positive for the enemy, negative for the
//               city's own traffic — killing a civilian is a fine, not a
//               reward. Paid however the car died, including a chain reaction
//               the player only lit the fuse for
//   bounty      CREDITS paid for destroying this car (game/wallet.js) — money,
//               not points, and a separate field from `value` precisely so the
//               two can diverge. OMITTING IT ENTIRELY means the car is worth
//               nothing financially, which is the shape "not every enemy pays"
//               takes: a Phase 10 boss gets a windfall here, a swarm minion
//               gets no `bounty` line at all, and neither needs a word of code
//               in wallet.js. Flat across the whole catalogue today (25 for the
//               enemy, -15 for the city's own traffic) for the same reason
//               `value` is: a starting VALUE, not a starting STRUCTURE.
//               NEGATIVE IS A FINE, and it is deliberately gentler than
//               `value`'s own -100 relative to the reward — a civilian kill
//               can empty the run's earnings but never digs into credits
//               banked from earlier runs (wallet.js's header), so the score is
//               where carelessness is punished hard and the wallet is where it
//               is punished honestly
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
    blastRadius: 30,
    blastDamage: 10,
    value: -50,
    bounty: -10,
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
    value: -50,
    bounty: -10,
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
    color: NEUTRAL, // base chassis matches every other civilian's — see the header
    thrust: NEUTRAL_THRUST,
    // The pale stripe/canopy tell — see the header note on `accent`, and
    // carshapes.js's ROADSTER, where it's actually drawn.
    accent: NEUTRAL_PALE,
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
    value: -100,
    bounty: -15,
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
    // Base chassis matches every other civilian's — the deep exhaust glow below
    // is the one detail that still marks this out as the heaviest of them.
    color: NEUTRAL,
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
    blastRadius: 120,
    blastDamage: 60,
    value: -200,
    bounty: -20,
    minDistance: 400, // the city's own traffic: on the road from the first metre
    // Even the rolling wall dodges — `juggernaut` keeps nerve at 0. A rig
    // ploughing a trestle is tempting flavour, but it is also the one civilian
    // heavy enough to be somewhere near a hazard the player wanted left standing,
    // and the AMBER cars dodging without exception is what makes one swerving
    // read as "there is something in that lane" rather than as one type's quirk.
    // `cruise`, same as the van: it holds its lane and makes you go round. What
    // makes a rig a rig is the profile below and its 4 mass — if the rolling
    // nose-to-tail roadblock ever ships, it earns a tactic name of its own.
    behaviour: "cruise",
    driving: "juggernaut", // dead straight, brakes from a long way out, and
                           // expects to be given room rather than to ask for it
    weight: 0.8,
  },
  {
    id: "bus",
    label: "BUS",
    shape: carShapeIndex("BUS"),
    faction: NEUTRAL_FACTION,
    // THE HIGH-PENALTY CIVILIAN. Every other civilian's `value` still reads
    // the flat -100 every neutral type launched with; this is the first to
    // actually use the per-type `value` PR97 put on every entry — it is
    // full of passengers (carshapes.js's BUS draws the whole cabin as
    // glazing rather than an opaque roof, precisely so that reads before the
    // stat does), and killing one costs three times what killing anything
    // else on the civilian side costs.
    color: NEUTRAL,
    thrust: NEUTRAL_DEEP, // the deep exhaust glow the rig also carries — the
                          // other heavy hauler on the road
    w: 46,
    h: 104,
    // Between the muscle's 110 and the rig's 220: heavier and tougher than
    // any ordinary civilian, but the rig stays the one thing on the road
    // built to shrug off everything.
    health: 190,
    mass: 2.8,
    // Slow and deliberate, like the rig and van it shares the outer lane
    // with — a city bus keeps to stops, it does not race. Kept clearly under
    // the van's 265 ceiling so the civilian speed gradient (see driving.js)
    // still puts it on the barrier side of the road.
    speedMin: 190,
    speedMax: 230,
    // Matches the van's exactly, and not by accident: it drives the SAME
    // `hauler` profile below, and that profile's `contact` ceiling is priced
    // off the van's own steerSpeed against collisions.js's DAMAGE_FLOOR of
    // 40 (see driving.js's comment on `hauler`). Sharing the figure keeps
    // that pricing true for the bus too, instead of quietly drifting once a
    // second type points at the same table.
    steerSpeed: 60,
    // Big, but deliberately short of the rig's 72/46 — the rig stays the
    // single biggest explosion on the road (see its own comment above); the
    // bus is the second-biggest, not a replacement for it.
    blastRadius: 30,
    blastDamage: 15,
    // THE POINT OF THIS ENTRY. Three times the flat civilian fine: not a
    // rounding tweak, a stated policy that this one is worse to hit than the
    // rest of the traffic put together.
    value: -300,
    // ...and the same policy in credits: three times the -15 every other
    // civilian costs. The bus predates the wallet (it arrived a phase earlier),
    // and a catalogue entry with no `bounty` pays nothing at all — which would
    // have made the worst car on the road the one kill money never noticed.
    bounty: -45,
    minDistance: 800, // the city's own traffic: on the road from the first metre
    behaviour: "cruise", // holds its lane exactly like the van and the rig —
                         // it does not overtake, it makes you go round
    driving: "hauler",   // the van's own profile: cautious, out of the way,
                         // but it will lean on something smaller than itself
    // A QUARTER of the rig's own weight (0.8 / 4 = 0.2) — rarer than every
    // other civilian on the road, on purpose: a bus should feel like a
    // genuine event to meet, the same way the rig's own low weight already
    // makes it one.
    weight: 0.2,
  },
  {
    id: "hypercar",
    label: "HYPERCAR",
    shape: carShapeIndex("HYPERCAR"),
    faction: NEUTRAL_FACTION,
    // Base chassis matches every other civilian's — the shape alone carries
    // this one's showpiece identity.
    color: NEUTRAL,
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
    blastDamage: 20,
    value: -150,
    bounty: -15,
    minDistance: 1200, // the city's own traffic: on the road from the first metre
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
    // THE HEAVY, RECKLESS CIVILIAN, and it fills a specific hole: every other
    // heavy civilian is careful, and the only other rude one is the roadster —
    // frail at mass 0.8 and 40 hull, so the player swats it aside and its
    // rudeness costs them nothing. This one leans back. A car that is aggressive
    // WITHOUT being out to get you is a different thing from an enemy: it is
    // traffic that will not yield.
    faction: NEUTRAL_FACTION,
    // Base chassis matches every other civilian's — identity comes from the
    // silhouette, and colour carries faction rather than weight class.
    color: NEUTRAL,
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
    value: -100, // killing one is a fine, like any other civilian
    bounty: -15,
    minDistance: 1000,        // the city's own traffic: on the road from the first metre
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
    color: ENEMY_DEEP, // base chassis matches every other hostile's — see the header
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
    value: 100,
    bounty: 25,
    minDistance: 450,
    behaviour: "pursue", // real: chases the player down and never gives up —
                         // see behaviours.js's `pursue`
    // A ROCKET INSTEAD OF THE SHARED BLASTER, AND NO MINE LAYER — see
    // armament.js's `rocketeer` profile and weapons.js's `missile`. One
    // heavy, slow-reloading hit rather than a steady drip, which is what
    // makes a hostile that never disengages read as a building threat
    // instead of chip damage. Gun only: `pursue` holds station behind the
    // player for its whole engagement, so a mine layer would never be in a
    // position to fire — mining is the cycle's job today, and the rival's
    // once it gets one.
    arms: "rocketeer",
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
    // circuit, and it CHASES. `enforcer` (driving.js) is still the right
    // profile for a heavy that leans on the player rather than racing them,
    // and is still unclaimed — but the `block` tactic it would have paired
    // with was dropped from behaviours.js's table rather than kept as a row
    // nothing pointed at. Recreate both together if a future hostile wants
    // that pairing.
    shape: carShapeIndex("STOCKER"),
    faction: ENEMY_FACTION,
    // The hostile fleet's base chassis colour — see the header. Every other
    // enemy type matches this exactly; the silhouette is what tells them apart.
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
    blastRadius: 45,
    blastDamage: 20,
    value: 100,
    bounty: 15,
    minDistance: 250,
    behaviour: "trail",    // hangs off your back bumper and fires forward — see
                           // behaviours.js's `trail`. It never tries to get
                           // past, unlike the interceptor and rival's `pursue`
    // THE SMG, NOT THE STANDARD BLASTER, AND NO MINE LAYER — a burst-fire
    // spray rather than one well-aimed round, which is what a trailing car
    // sustaining fire on one target for several seconds should sound and
    // look like. See armament.js's `gunner` profile and weapons.js's `smg`
    // type. No mine layer for the same reason the interceptor's own kit
    // drops one: `trail` camps behind the player for its whole engagement,
    // so a layer would never be ahead of anything to drop one on. Overrides
    // the faction's default hostile kit, same mechanism as the cycle's
    // `raider`.
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
    color: ENEMY_DEEP, // base chassis matches every other hostile's — see the header
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
    blastRadius: 10,
    blastDamage: 5,
    value: 50,
    bounty: 10,
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
    weight: 2,
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
    // ALSO the one enemy type that survives a single mine (150 hull,
    // obstacletypes.js) without being tuned for it specially: 160 takes one
    // hit down to 10 and dies on the second. Everything lighter than the
    // stocker's 130 dies to a mine outright; this and the rival (400, below)
    // are the two built to take a second and third respectively.
    health: 160,
    mass: 2.2, // built to ram; Phase 4 gives it the behaviour to go with the mass
    speedMin: 280,
    speedMax: 330,
    steerSpeed: 70,
    blastRadius: 52,
    blastDamage: 32,
    value: 100,
    bounty: 25,
    minDistance: 500,
    // REAL: closes on the player from behind or alongside to hit them, or
    // sits in their lane going deliberately slower once it's past — see
    // behaviours.js's `ram`. Its whole job is making contact, not shooting,
    // so `arms: false` on the tactic's own row means it never fires the
    // default hostile kit `armFor` still hands it below — carrying a gun it
    // never uses is correct here (see armament.js's header), not a leftover.
    behaviour: "ram",
    driving: "batterer", // nerve 20: three times in five, the type least
                         // interested in going round
    weight: 0.8,
  },
  {
    id: "rival",
    label: "RIVAL",
    // The player's own silhouette, in the hostile shade — see the header. Only
    // the cycle is quicker, and nothing else hostile can live with the player
    // flat out.
    shape: carShapeIndex("SUPERCAR"),
    faction: ENEMY_FACTION,
    color: ENEMY_DEEP, // base chassis matches every other hostile's — see the header
    thrust: ENEMY_THRUST,
    w: 34,
    h: 62,
    // RAISED FROM 90 so a mine takes exactly THREE to finish it — the
    // toughest thing on the road, deliberately outlasting even the bruiser.
    // The mine deals a flat 150 (obstacletypes.js): 400 survives two direct
    // hits (400-150=250, 250-150=100) and dies on the third (100-150<0). A
    // rival worth chasing down shouldn't fold to a single dropped mine the
    // way the rest of the enemy roster now does.
    health: 400,
    mass: 1.2,
    // Straddles the player's top speed: flat out, you draw level with a rival
    // and neither of you gets away. The only hostile that can hold that.
    speedMin: 580,
    speedMax: 650,
    steerSpeed: 150,
    blastRadius: 40,
    blastDamage: 20,
    value: 300,
    bounty: 100,
    minDistance: 1000,
    // REAL, and the one hostile that fights like both the cycle and the
    // interceptor in the same encounter — see behaviours.js's `duel`. It
    // forces its way past exactly like the cycle's `raid` for one deliberate
    // mine drop, then falls back to the interceptor's own `pursue` for good:
    // holding a firing gap behind the player, off the plain HOSTILE blaster
    // it carries by naming no `arms` override. No numeric change to how
    // cautious it drives beyond that — `duelist`'s own nerve 10, below, is
    // already low enough to read as "a driver, not a battering ram" without
    // any special-casing for this tactic.
    behaviour: "duel",
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
  return pickWeighted(CAR_TYPES, (type) => typeAvailable(type, distance));
}

export function carTypeById(id) {
  return CAR_TYPES.find((t) => t.id === id) ?? null;
}
