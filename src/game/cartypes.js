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
// FACTION_LIVERY below enforces that rather than trusting each entry to repeat
// it; a type states a colour only where it means to break the rule.
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
// THE TWO SPEED BANDS. Four numbers per type, and they are TWO ranges, nested:
//
//   cruiseMin..cruiseMax  THE CRUISE BAND. What this type rolls at spawn and
//                         wanders within — how fast it drives when nothing is
//                         happening to it.
//   speedMin..speedMax    THE HARD BAND. What this type is physically CAPABLE
//                         of, and it contains the cruise band at both ends.
//                         NOTHING may ask a car outside it — not a tactic, not
//                         braking for the car in front, not slowing to fit a
//                         swerve past a roadblock, not a chase — traffic.js
//                         clamps both ends to this band once, after every
//                         behaviour has had its say. `speedMax` is therefore
//                         THE SINGLE ANSWER to "how fast can this car be
//                         driven, for any reason"; driving profiles carry no
//                         second ceiling under it (driving.js says why not).
//
// `speedMin <= cruiseMin <= cruiseMax <= speedMax` therefore holds for every
// entry, and the car editor refuses an edit that breaks it (car-editor/server.js).
//
// WHICH BAND A CALLER READS IS DECIDED BY WHAT IT IS DOING, never by which
// number is to hand: spawning and wandering are CRUISE (traffic.js, events.js's
// `rollSpeed`), and every tactic that spends EFFORT — passing, holding station
// on a mine run, fleeing, or asking whether this type can close on the player
// at all — reads the hard band.
//
// EACH GAP IS A DESIGN SURFACE, and they are different surfaces:
//
//   speedMin..cruiseMin   what the player buys by SLOWING DOWN — see the floor
//                         below, which decides whether braking sheds a type.
//   cruiseMax..speedMax   what a car has left when it is TRYING. Ordinary
//                         cruise never reaches into it; `passEffort`, the
//                         station-holding tactics and every chase do. MOST
//                         TYPES SHIP WITH THIS GAP CLOSED (speedMax =
//                         cruiseMax), which is the road the catalogue has
//                         always had. THE STOCKER AND THE BRUISER open it, so
//                         that a car whose whole job is closing on the player
//                         has something to close with that its cruise band
//                         would not give. HOW FAST A TYPE CHASES IS THIS
//                         NUMBER — there is nowhere else to look, which is the
//                         point of it living here. Opening the gap also
//                         un-clips `passEffort` for that type alone. THE
//                         OUTRIDER now opens it too (see its own entry), past
//                         the two numbers ("fastest thing on the road") that
//                         used to size themselves off whichever type had the
//                         widest open gap — deliberately: it is low health,
//                         low damage, and SWEEPS PAST rather than chasing, so
//                         being unshootable from behind while it does costs
//                         nothing the player needed.
//
// WHAT THE FLOOR BUYS, and it is ONE design decision with one number behind it.
// A hostile holds station only on a player it can MATCH, so its floor is the
// speed at which the player stops being holdable — which makes this field the
// answer to "does braking work against this type".
//
//   floor 200   cycle, outrider, outrunner, sower — the motorcycle fleet. One
//               number for all four, because it is one physical fact about
//               bikes rather than four dispositions: A BIKE CANNOT BE RIDDEN
//               AT WALKING PACE. Drop under 200 and none of them can hold
//               station on you.
//   floor 100   the interceptor, EXPERIMENTALLY, as of this tuning pass —
//               see its own entry. Sits exactly on the player's own MIN_SPEED
//               rather than clear of it, which the invariant the rest of this
//               table used to enforce (hazards.test.js) would have flagged as
//               a dead value: neither an escape (0) nor cleanly holdable-past
//               (>100). Left as a live question for playtesting rather than
//               forced back to one answer or the other.
//   floor 0     EVERYTHING ELSE, hostile and civilian alike. Braking is not an
//               answer to the stocker, the rival, the bruiser, the boss or the
//               gunship, which is what stops "slow down" being the answer to
//               everything. A civilian at 0 stops dead for a roadblock and
//               brakes behind a rig.
//
// WHY THE SECOND GROUP IS 0 RATHER THAN THE PLAYER'S OWN 100, which looks like
// it would do and does not: a hostile that attacks from IN FRONT must be able to
// drive SLOWER than the player, not merely as slow. `outrun` and `siege`
// overshoot their hold on the way in — the mortar arrives at 640+ and sheds it
// through traffic.js's ACCEL, ending ~400 units past `leadHold` — and closing
// that back up means falling BACK onto the player. Floored at 100 against a
// player at 100 the boss could match a crawl and never close on one, so braking
// parked it off the top of the screen for good. Measured, and it is why this
// group is 0 flat.
//
// WHERE 200 COMES FROM. It is bounded hard at BOTH ends, and the upper bound is
// the easy mistake — a floor that looks reasonable and is wrong on one side:
//
//   ABOVE the player's 100, or braking would never shed anything and the whole
//   design does nothing.
//   WELL UNDER the player's ordinary cruise — a run starts at 260 — because the
//   floor breaks the tactic at EVERY player speed under it, not only at the
//   crawl. A bike floored at its own 600 cruise cannot hold station on a player
//   doing 380 either: it blows past, and the type stops working at ordinary
//   speeds instead of becoming escapable at slow ones. That was measured on the
//   outrunner and the sower, as their pass rate going through the roof in
//   `npm run sim`, and it is why these four are not simply floored at cruiseMin.
//
// Both bounds are asserted in test/hazards.test.js.
//
// THE FLOOR ALSO DECIDES WHAT A CAR CAN DODGE, and this is the second thing the
// player can exploit. behaviours.js answers a hazard two ways, and the floor
// reaches both: `avoidHazards` slows a car so its swerve FITS in the road left,
// and `hazardStop` stops it dead when no lane is free at all. A bike can do
// neither, so a fully blocked road is a weapon against the bike fleet
// specifically — it drives into what it cannot go round. obstacles.js's
// SPAWN_MARGIN therefore no longer promises every type an avoidable hazard; it
// still promises every type the ROAD to steer across (that is a claim about
// steerSpeed, and the mortar's entry below derives its own from it).
//
// THE CRUISE BAND is pinned to both ends of the player's own 100..620
// (player.js):
//
//   FLOOR    the slowest type cruises at 180 — well above the player's minimum.
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
// range is ROLLED per spawn; each car WANDERS ±4% around its roll on its own
// period, so a close-rolling pair separates instead of locking into formation
// (traffic.js DRIFT); and an overtaker spends up to its profile's `passEffort`
// more while committed. Civilians carry the widest ranges (a civilian type is a
// spread of ordinary drivers); the speed machines are defined by their ceiling
// and stay narrow. Both extras are CAPPED by the CRUISE band.
//
// The band's WIDTH is not free: traffic sheds speed at traffic.js's ACCEL, and
// behaviours.js sizes a follower's gap from that rate. The largest closing
// speed the catalogue can produce is 730 - 100 = 630 units/sec, and ACCEL is
// set so one second of closing still covers the road needed to match it.
// Widening the band means revisiting that pair — see driving.js's
// followReaction, sized per profile against the types that drive it.
//
// SPRITE-CACHE BUDGET. Every distinct (shape, color, thrust, w, h) is a cache
// key in sprites.js, times WHEEL_FRAMES (8), plus one colour for the
// critical-hull blink: 22 types * 8 * 2 = 352 sprites at worst, built lazily. A
// `staged` type costs what any other does — the cache is keyed on artwork, and
// the gunship's is built the first time its encounter rolls.
// Keeping the catalogue a small FIXED list is what bounds this: vary cars by
// ADDING A TYPE, never by rolling continuous per-instance sizes or colours.
// The speed band is free variety, since speed doesn't affect the artwork.

import { carShapeIndex } from "./carshapes.js";
import { DIST_UNITS, LANE_WIDTH } from "./road.js";
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
// entry. That scaffolding is now LOAD-BEARING rather than speculative: the
// figures run -300 (the bus, full of passengers) to 1500 (the boss), and the
// two currencies below are deliberately not proportional to each other — the
// rival pays 300 points to 100 credits, the hypercar 150 to 15. What a kill is
// WORTH and what it PAYS are two judgements, and they are two fields.

// THE OPENING ROAD IS CIVILIAN. Every hostile type is held back until the
// player has covered this much road (DIST readout units, road.js), so a run
// starts as ordinary traffic and the enemy arrives as a CHANGE the player can
// feel. It also gives the opening a job: learn the car and the traffic first.
//
// 100 on the odometer is 10,000 world units — ~16 seconds flat out, or a minute
// and a half at the player's minimum, so dawdling buys a longer quiet spell.
// Deliberate: speed is what asks for the trouble.
//
// One figure for the whole faction for now. `minDistance` is per-type so the
// enemy can later be STAGED (interceptors early, a rival much later) without
// touching traffic.js; spread the entries when there is a reason to.
const ENEMY_MIN_DISTANCE = 100;

// THE FOCUS SWITCH — a testing aid, and the reason `minDistance` is worth having
// as a gate rather than as a spawn weight.
//
// Tuning one type's driving means watching it, and the full catalogue gives you
// a few seconds of the car you care about between everything else. List the ids
// you are working on and only those reach the road. SHIP IT EMPTY.
//
//   const FOCUS = ["sedan", "roadster"];   // civilian profiles, nothing else
//
// An override on the SAME gate the game ships with, not a filter of its own, so
// a focused road is still a road the real spawner built — same reweighting,
// same "everything gated" path, same pickCarType. A measurement harness must
// not measure a different game. Exported so the suite can say so out loud: a
// focused catalogue breaks several gating invariants below, and "van never
// appeared" is a much worse error message than "FOCUS is still set".
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
//   faction     NEUTRAL_FACTION | ENEMY_FACTION — and, through FACTION_LIVERY,
//               the source of `color` and `thrust` for any entry not naming them
//   color       body wireframe colour, `thrust` the exhaust glow. BOTH DERIVED
//               from faction; written on an entry only to override, which two
//               entries do (rig, bus) and fifteen do not
//   accent      a second colour the shape may draw with, and a SIGNAL rather
//               than decoration — see the header note above
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
//   speedMin/speedMax   the HARD BAND, world units/sec: nothing may drive this
//               car slower or faster, whatever it is trying to do. The floor is
//               0 for every civilian. See THE TWO SPEED BANDS
//   cruiseMin/cruiseMax the CRUISE BAND rolled at spawn and wandered within.
//               Sits inside the hard band, and is NOT it
//   steerSpeed  how fast the car can slide sideways, px/sec — a behaviour asks
//               for a lateral position and this caps how quickly it gets there,
//               so a rig wallows and a cycle darts
//   blastRadius how far the death explosion hurts, in px measured from the car's
//               BOX EDGE outward (so a long rig doesn't get a free extra reach
//               along its own length). Lane width is 65px for scale
//   blastDamage hull taken at the centre of that blast, falling off linearly to
//               nothing at the rim. The player has 100 hull
//   value       points scored for DESTROYING this car (score.js). A LITERAL on
//               every entry, not a shared constant, so a boss or a special
//               civilian can be given its own figure by editing one line.
//               Positive for the enemy, negative for the city's own traffic —
//               a civilian kill is a fine. Paid however the car died, chain
//               reactions the player only lit the fuse for included
//   bounty      CREDITS for destroying this car (game/wallet.js) — money, not
//               points, separate from `value` so the two can diverge. OMITTING
//               IT means the car pays nothing, which is how "not every enemy
//               pays" is expressed: a boss gets a windfall, a swarm minion gets
//               no line at all, neither needs code in wallet.js. The two are
//               tuned independently — see the note above `value`'s own entry —
//               and the ratio between them varies from 3:1 to 10:1 across the
//               catalogue. The negatives are gentler than `value`'s on purpose: a
//               civilian kill can empty the run's earnings but never touches
//               credits banked earlier, so the score punishes carelessness hard
//               and the wallet punishes it honestly
//   behaviour   key into behaviours.js — the TACTIC. Nimble types `overtake`
//               (they pass whatever holds them up, the player included), heavy
//               ones `cruise` (sit in front of a rig and it stays there). That
//               split is what stops every car weaving at once. Most enemy
//               tactics borrow their driving from those two; a few are real
//   driving     key into driving.js — the PROFILE: following distances,
//               patience, lane discipline, and how much hull this driver will
//               accept hitting. Omitted means `commuter`
//   arms        key into armament.js's ARMAMENTS — the KIT. Omitted gives every
//               enemy type the shared `hostile` loadout (gun + mine layer) and
//               every neutral type nothing; name a profile to override
//   airborne    TRUE means this thing FLIES, and it is the one field here that
//               changes what a car IS rather than how it drives. It says one
//               thing — THIS BODY IS NOT IN THE ROAD PLANE — and four systems
//               each read it once to say what that costs:
//                 traffic.js      keeps it out of the ramming solver and off the
//                                 tarmac clamp, and mirrors it onto the body as
//                                 `airborne` for the two below
//                 behaviours.js   skips its hazard reflex: it flies over mines
//                                 rather than round them
//                 projectiles.js  refuses it to any round that is not SEEKING
//                 collisions.js   inBlastPlane, which the three blast sweeps ask
//               The third is the point of the flag — see the gunship record for
//               why ALTITUDE, not lateral position, is what decides which
//               weapons can touch it
//   staged      TRUE means the ambient spawner never rolls this type — only an
//               events.js encounter naming it in a `stage` spec puts one on the
//               road. The field exists because "a type nobody meets" and "a
//               type only the director may place" are opposite things that
//               `weight: 0` would make identical. Read by typeAvailable, the
//               spawner's one gate; planStage looks types up BY ID and never
//               asks about gates, which is the seam that keeps this a one-word
//               change rather than a special case in the spawner
//   weight      relative spawn frequency. Meaningless on a `staged` type, which
//               is never in a draw — written as 0 there so it reads as "never
//               rolled" rather than a rarity somebody forgot to tune
//   minDistance how far the player must have driven before this type may spawn,
//               in DIST-READOUT units (road.js's DIST_UNITS) — the number the
//               HUD shows, so a gate reads as "turns up at DIST 100". 0 means
//               from the first metre. This only decides WHETHER a type is in
//               the draw; once open it is picked on `weight` as usual. See
//               ENEMY_MIN_DISTANCE for why the enemy starts late, and
//               pickCarType for what happens while everything is still gated

// THE FACTION SUPPLIES THE LIVERY. "Every faction shares one base chassis
// colour" is a rule in the header above, and a rule restated seventeen times in
// the data is a rule that drifts the first time somebody adds a type by copying
// a neighbour. So the faction owns `color` and the default `thrust`, and an
// entry names either one only to BREAK the rule — which is what makes a stated
// colour worth reading. Two entries do: the rig and the bus, whose deep exhaust
// glow is the one mark left for "heaviest thing on the road" once the chassis
// cannot carry it.
//
// Resolved at load, not at draw: `color` and `thrust` are real fields on every
// entry by the time anything reads one, so sprites.js's cache key, traffic.js's
// draw call and the gallery all work exactly as they did when the colour was
// written out by hand.
const FACTION_LIVERY = {
  [NEUTRAL_FACTION]: { color: NEUTRAL, thrust: NEUTRAL_THRUST },
  [ENEMY_FACTION]: { color: ENEMY_DEEP, thrust: ENEMY_THRUST },
};

// Spread the livery FIRST so the entry's own fields win — that ordering is what
// makes an override an override.
function liveried(type) {
  return { ...FACTION_LIVERY[type.faction], ...type };
}

export const CAR_TYPES = [
  // --- Neutral: the city's own traffic --------------------------------------
  {
    id: "sedan",
    label: "SEDAN",
    shape: carShapeIndex("SEDAN"),
    faction: NEUTRAL_FACTION,
    w: 34,
    h: 60,
    health: 60,
    mass: 1, // the reference car: everything else is heavier or lighter than this
    // The widest range in the catalogue. A civilian type is a spread of ordinary
    // drivers, so a lane of sedans should visibly sort itself out; the speed
    // machines below are DEFINED by their ceiling and stay narrow.
    speedMin: 0,  // the civilian floor, and every one of them states it: a
                   // civilian may be brought to a full stop. See THE TWO BANDS
    cruiseMin: 215,
    cruiseMax: 290,
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
    speedMin: 0,
    cruiseMin: 205,
    cruiseMax: 265,
    speedMax: 265,
    // LOAD-BEARING, and not only for how it corners. behaviours.js prices a lane
    // change from this figure against collisions.js's DAMAGE_FLOOR (25, and
    // still being tuned — the van's contact band moves with it; re-measure via
    // `npm run sim` after retuning either number), which is what gives the
    // `hauler` profile the only finely-graded `contact` dial in the file. Drop
    // it near the floor and that dial goes binary, as the rig's now nearly is.
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
    speedMin: 0,
    cruiseMin: 430,
    cruiseMax: 560,
    speedMax: 560,
    steerSpeed: 140,
    blastRadius: 30,
    blastDamage: 9,
    value: -100,
    bounty: -15,
    minDistance: 200, // not in the opening minute: the impatient civilian is a
                      // change of pace, and the sedan sets the pace first
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
    // The one civilian detail colour still worth stating: a deep exhaust glow
    // instead of the fleet's, which is what marks the heaviest thing on the road
    // when the chassis colour cannot.
    thrust: NEUTRAL_DEEP,
    w: 42,
    h: 124, // twice any other car: it is a rolling wall, and a lane-and-a-half of
    health: 220, // road disappears behind it
    mass: 4, // immovable in practice — ram it and you lose, not the rig
    // The floor of the whole catalogue: 180 is half again the player's minimum,
    // so even a rig is pulling away from a player who has given up on the
    // throttle. The floor is the ONE number here that must not drift downward —
    // it is the reason a slow player still sees a moving road.
    speedMin: 0,
    cruiseMin: 180,
    cruiseMax: 215,
    speedMax: 215,
    // USED TO SIT under collisions.js's DAMAGE_FLOOR — that floor has since
    // come down to 25 (still being tuned) and now sits UNDER this 35, so an
    // ordinary lane change prices at a small non-zero cost rather than free.
    // It changes no driving DECISION today regardless — see driving.js's
    // `juggernaut`, whose contact ceiling of 0 is what actually makes the
    // rig's driving "never", independent of price — but the price and the
    // decision remain two different things, not one number wearing two hats.
    // Raising steerSpeed would also shrink dodgeDistance, which is the figure
    // obstacles.js sizes its whole spawn margin against, so this number is
    // not the rig's alone to change.
    steerSpeed: 35,
    // It is carrying something. Killing a rig in traffic is the biggest event on
    // the road — the blast covers most of the tarmac around it and will take a
    // third of the player's hull if they are alongside when it goes.
    blastRadius: 200,
    blastDamage: 60,
    value: -200,
    bounty: -20,
    minDistance: 500, // the road's biggest civilian, held back so meeting one is
                      // an event rather than the first thing on the road
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
    speedMin: 0,
    cruiseMin: 190,
    cruiseMax: 230,
    speedMax: 230,
    // Matches the van's exactly, and not by accident: it drives the SAME
    // `hauler` profile below, and that profile's `contact` ceiling is priced
    // off the van's own steerSpeed against collisions.js's DAMAGE_FLOOR (see
    // driving.js's comment on `hauler`). Sharing the figure keeps that pricing
    // true for the bus too, instead of quietly drifting once a second type
    // points at the same table.
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
    minDistance: 800, // the costliest civilian to hit (see `value`), so the
                      // player learns the traffic before it can fine them -300
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
    w: 36,
    h: 64,
    health: 45,
    mass: 0.9,
    // Faster than the player is ALLOWED to go: a rare showpiece that comes past
    // at full throttle and is gone, which is exactly why it is worth spotting.
    speedMin: 0,
    cruiseMin: 630,
    cruiseMax: 700,
    speedMax: 700,
    steerSpeed: 160,
    blastRadius: 32,
    blastDamage: 20,
    value: -150,
    bounty: -15,
    minDistance: 1600, // the latest civilian gate in the catalogue: 700 units/sec
                       // of showpiece belongs to a road the player already reads
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
    w: 38,
    h: 68,
    health: 110,
    // Heavier than the player: it wins a shoving match, slowly. Unchanged from
    // its hostile days and now the whole point of the type — this is the civilian
    // the player cannot simply move out of the way.
    mass: 1.7,
    speedMin: 0,
    cruiseMin: 310,
    cruiseMax: 360,
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
    minDistance: 1200,        // late, like the hypercar it counterweights — the
                              // two aggressive civilians both arrive well in
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
    w: 34,
    h: 62,
    health: 70,
    mass: 1.1,
    // RAISED TO 620, LEVEL WITH THE PLAYER'S OWN CEILING — the player's Phase 5
    // speed boosts and overdrive pickups push them past a stock car's 620, and
    // an interceptor staged behind one no longer had anything left to give
    // chase with (see events.js's arrivalSpeed and its `needed` guard: a type
    // whose speedMax cannot clear player.speed + CLOSING_MARGIN keeps its
    // ordinary roll instead of closing, so a boosted player used to outrun this
    // type outright). It still cannot beat a BOOSTED player on its own legs,
    // but it can now stay in a stock player's mirror instead of falling out of
    // it — and it chases at the whole 620, LEVEL WITH A STOCK PLAYER FLAT OUT.
    // Throttle alone therefore does not open the gap on this type; it only
    // stops it closing. What sheds an interceptor is the traffic and the
    // corners, or killing it. (It used to chase at 600 — a leash on the driving
    // profile, since removed — and slipped 20 a second against a flat-out
    // player. driving.js has the reasoning; the encounters built on that slip
    // are the battery escort and the swarm, in eventtypes.js.)
    // FLOORED AT 100, LEVEL WITH THE PLAYER'S OWN MINIMUM — still under
    // playtesting. Used to be 0 (no floor at all, so it could crawl and
    // remained the standing pressure braking never switched off); the floor
    // is meant to give a player who slows all the way down one more type to
    // reason about rather than none, though at exactly the player's own
    // minimum it is a hairline case rather than a clean escape. Revisit this
    // number together with the invariant in hazards.test.js that used to
    // pin every hostile floor to either 0 or strictly above MIN_SPEED.
    speedMin: 100,
    cruiseMin: 400,
    cruiseMax: 620,
    speedMax: 650,
    steerSpeed: 250,
    blastRadius: 38,
    blastDamage: 16,
    value: 100,
    bounty: 25,
    minDistance: 1500,
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
    // THE INTERCEPTOR'S GLASS-CANNON COUSIN. Same shape of threat — `pursue`,
    // never gives up — with the two numbers that describe it both pushed
    // further: nimbler, and carrying a heavier trigger pull. What pays for
    // both is hull: DELTA dies in about two thirds of an interceptor's hits,
    // which is the whole trade — kill it fast and the extra output never
    // lands, let it linger and it hits twice as hard for it.
    id: "delta",
    label: "DELTA",
    shape: carShapeIndex("DELTA"),
    faction: ENEMY_FACTION,
    w: 36,
    h: 62,
    // BELOW THE INTERCEPTOR'S 70, NOT AT THE CYCLE'S 25 — a trike hull, not a
    // bike one, and still a heavy in everything but hull. FIRST PASS, same
    // caveat as the interceptor's own numbers: retune once `pursue` carrying
    // this kit has been measured over real road time (tools/drivesim.js).
    health: 45,
    mass: 1.0,
    // SAME FLOOR AS THE INTERCEPTOR (100, not the bike floor 200) — see that
    // entry's own note on why 100 exactly is what keeps a type out of
    // hazards.test.js's "shakeable hostiles share one floor" invariant.
    speedMin: 100,
    // EVERY ONE OF THESE ABOVE THE INTERCEPTOR'S OWN — cruiseMin/cruiseMax/
    // speedMax all +20, steerSpeed +20 — which is the whole of "higher
    // mobility" spelled out in the one place a car's mobility actually lives
    // (per-type fields, not the shared `pursuer` driving profile below; see
    // driving.js's own header on why a profile is a disposition, not a speed).
    cruiseMin: 420,
    cruiseMax: 640,
    speedMax: 670,
    steerSpeed: 270,
    // SAME AS THE INTERCEPTOR'S OWN DEATH BLAST — the lower hull above already
    // makes this car easier to kill; there is no reason to also make dying
    // less dangerous to whatever is standing next to it when it goes.
    blastRadius: 38,
    blastDamage: 16,
    value: 100,
    // ABOVE THE INTERCEPTOR'S 25 — the extra output is worth more dead, same
    // logic as the gunship/rival sitting above the standard hostile tier.
    bounty: 30,
    minDistance: 1500,
    behaviour: "pursue", // real: chases the player down and never gives up —
                         // see behaviours.js's `pursue`. Identical to the
                         // interceptor's own; nothing about the TACTIC needed
                         // to change for this car to read as meaningfully
                         // different, only the kit underneath it
    // TWO ROCKETS A RELOAD INSTEAD OF ONE — see armament.js's `twinRocketeer`
    // profile and weapons.js's `twinMissile`. Same per-round weight as the
    // interceptor's own missile, paired rather than weakened (that entry's
    // own note explains why); no mine layer, for the identical reason the
    // interceptor carries none — `pursue` holds station behind its whole
    // engagement.
    arms: "twinRocketeer",
    // REUSES THE INTERCEPTOR'S OWN PROFILE rather than earning a new one:
    // `pursuer` is a DISPOSITION (nerve, contact — driving.js) and nothing
    // about this car's disposition differs, only its raw numbers above. Today
    // interceptor is the only other type naming it, so this is safe without
    // checking every caller — but a future retune of `pursuer` itself moves
    // both cars at once (CLAUDE.md's own rule on shared driving profiles).
    driving: "pursuer",
    // LIGHTER THAN THE INTERCEPTOR'S 2 — a first pass at rationing a car with
    // meaningfully higher output than the standard hostile tier, mirroring
    // the sower's own "uncommon: three at once would be weather" reasoning.
    // Retune with tools/drivesim.js once this has road time behind it.
    weight: 1.5,
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
    w: 40,
    h: 70,
    health: 130, // a caged car: more than the departed muscle's 110, less than
                 // the bruiser's 160
    mass: 1.9,
    // Fills the enemy's speed hole between the bruiser's 330 and the
    // interceptor's 400: a heavy that is genuinely quick, so being ahead of one
    // is not the escape it is with the rest of the heavy class.
    // A circuit car: it crawls like the interceptor. Slowing does not shake this
    // one either — its counter is already written, and it is time rather than
    // speed (driving.js's giveUpTime, the only one on the road).
    speedMin: 0,
    cruiseMin: 355,
    cruiseMax: 415,
    // OPENED TO 600 — not headroom for its own sake, but what `trail` spends
    // while chasing, which its 415 cruise top would otherwise cap. UNDER THE
    // PLAYER'S OWN 620 and deliberately so: this is the chasing type a stock
    // player can still drive away from, at 20 units a second, which is what
    // keeps it the pressure you outlast rather than a second interceptor. Its
    // other counter is time (`giveUpTime`, above).
    speedMax: 600,
    steerSpeed: 100, // quicker across the road than any other heavy
    blastRadius: 45,
    blastDamage: 20,
    value: 100,
    bounty: 15,
    minDistance: 600,
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
    w: 26,
    h: 58,
    health: 25, // one solid contact and it is gone
    mass: 0.5,
    // The fastest thing on the road. FLOOR LOWERED TO 620, LEVEL WITH THE
    // PLAYER'S OWN CEILING — the old floor of 660 was chosen when 620 was the
    // fastest a player could ever go; now Phase 5 speed boosts and overdrive
    // pickups push a player past it, and a cycle rolled at the bottom of its
    // old band was no longer guaranteed to be the thing outrunning them. The
    // ceiling still is: at 730 a cycle catches and passes a player at full
    // throttle even on a low roll, and outrunning one under boost is still the
    // job the Phase 5 boosts exist for, not the accelerator.
    // THE BIKE FLOOR — see THE TWO SPEED BANDS. It cannot hold RAID_LEAD over a
    // crawling player, so a player who drops under it is forced past with the
    // mine undropped, and it cannot slow enough to go round a blocked road.
    speedMin: 200,
    cruiseMin: 620,
    cruiseMax: 730,
    speedMax: 730,
    steerSpeed: 250, // the nimblest thing on the road, by a wide margin
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
    w: 40,
    h: 74,
    // ALSO the one enemy type that survives a single mine (150 hull,
    // obstacletypes.js) without being tuned for it specially: 160 takes one
    // hit down to 10 and dies on the second. Everything lighter than the
    // stocker's 130 dies to a mine outright; this and the rival (400, below)
    // are the two built to take a second and third respectively.
    health: 160,
    mass: 2.2, // built to ram; Phase 4 gives it the behaviour to go with the mass
    // No floor, so behaviours.js's RAM_FLOOR is the only thing setting the
    // block's pace: the whole point of that figure is that the block still bites
    // at walking pace, and a floor over it would be a second, quieter answer to
    // the same question.
    speedMin: 0,
    cruiseMin: 200,
    cruiseMax: 330,
    // OPENED TO 560 — the speed `ram` closes at from behind or alongside,
    // which its 330 cruise top would otherwise cap. WELL UNDER THE PLAYER'S
    // 620, and that is the type: it closes to HIT rather than to hold a firing
    // gap, so it needs to catch a player busy with the road, not match one
    // running away. A bruiser in clean air behind a flat-out player is a
    // bruiser you have already beaten.
    speedMax: 560,
    // RAISED FROM 70 ALONGSIDE speedMax, and load-bearing rather than a free
    // tune: behaviours.js's dodgeDistance is speed / steerSpeed once fed the
    // hard band's own top, so admitting the bruiser's real 560 at the old 70
    // made IT the worst dodger in the catalogue at ~1487 units — past what
    // obstacles.js's SPAWN_MARGIN (1500) leaves once traffic.js's RETIRE_MARGIN
    // is subtracted, and past what the `warband` encounter's own staged depth
    // affords (test/hazards.test.js, test/events.test.js). 100 brings it back
    // to ~1041, under the rig's own 1142 and comfortably inside both budgets —
    // the rig remains the worst dodger in the fleet, same as before this entry
    // opened its ceiling.
    steerSpeed: 150,
    blastRadius: 52,
    blastDamage: 32,
    value: 100,
    bounty: 20,
    minDistance: 800,
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
    // The player's own silhouette, in the hostile shade — see the header. The
    // cycle is quicker outright, and the outrider's and interceptor's bands
    // reach into the player's own ceiling too (both widened so a BOOSTED player
    // still has something behind them) — but the rival is the only hostile with
    // a band ABOVE a stock player's 620 that also chases with all of it. Flat
    // out in clean air it gains on you at 30 a second, so it is the one type
    // the throttle is no answer to at all.
    shape: carShapeIndex("SUPERCAR"),
    faction: ENEMY_FACTION,
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
    // Straddles the player's top speed: flat out you do not draw away from a
    // rival, you lose ground to it — it wears the player's own body and is
    // rated 30 over a stock one, and since a chase spends the whole hard band
    // (traffic.js) that 30 is real pressure rather than a cruising figure. The
    // mini-boss the road cannot be driven away from, which is the shape the
    // `rival` encounter is built around.
    speedMin: 0,
    cruiseMin: 580,
    cruiseMax: 650,
    speedMax: 650,
    steerSpeed: 200,
    blastRadius: 40,
    blastDamage: 20,
    value: 300,
    bounty: 50,
    // PUSHED OUT FROM 1000. The rival is being tuned up into a proper
    // mini-boss, and the further it goes in that direction the worse it reads
    // as ordinary traffic: at 1000 the ambient road could produce a second one
    // within a few hundred units of the scripted meeting, which turns the
    // fight the `rival` encounter is built around into something that just
    // happens sometimes. 1400 puts the first ambient rival AFTER the siege
    // battery at 1200, so the run reads as an escalation — rival, boss, and
    // only then rivals as part of the furniture.
    minDistance: 1400,
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

  // --- Enemy: the motorcycle fleet -----------------------------------------
  //
  // Three hostiles that arrived together, on the three hulls cycleshapes.js had
  // been staging for exactly this (they are in carshapes.js now — that move is
  // what a staging catalogue is FOR, and cycleshapes.js's header describes it).
  //
  // WHY THREE AT ONCE, when types are normally added one at a time: they are
  // one idea in three parts, and the idea is that a bike cannot fight the way a
  // car does. Nothing here carries more than 55 hull or weighs more than 0.8 —
  // a single solid contact ends any of them — so none of them can do what the
  // bruiser does, or even what the interceptor does, which is sit in one place
  // behind the player and trade. Each answers that differently:
  //
  //   OUTRIDER   never stops moving laterally. It holds the interceptor's gap
  //              and sweeps across the player's line, spraying as it crosses.
  //   OUTRUNNER  attacks from IN FRONT — the first thing on this road that
  //              does — where nothing the player lays behind them can reach it.
  //   SOWER      does not fight at all. It runs one errand, drops one spike
  //              strip and leaves at a speed the player cannot match.
  //
  // And they are cheap to kill on purpose. Every one of them dies to a single
  // burst or a single shove, which is what keeps three fragile hostiles from
  // reading as three more health bars: the pressure is that they are hard to
  // GET AT, not that they are hard to break.
  {
    id: "outrider",
    label: "OUTRIDER",
    shape: carShapeIndex("RACER"),
    faction: ENEMY_FACTION,
    // The hull's own authored size, kept: the two- and three-wheeler artwork
    // sets its wheel metrics in PIXELS (cycleshapes.js), so a type that
    // overrode `size` here would have to redraw the tyres to match.
    w: 28,
    h: 64,
    health: 15, // one burst, one shove, or one clipped barrel
    mass: 0.5,
    // WIDENED BOTH ENDS. The floor drops to 400, level with the interceptor's
    // own, so `strafe` still has a car under it to roll when the player has
    // slowed for a hazard or a fight rather than only ever cruising at 540+ —
    // a band that could not go below 540 meant an outrider following a slowed
    // player was always fighting to shed speed it wasn't allowed to roll under.
    // The ceiling rises to 660, past the cycle's new 620 floor, for the same
    // reason the interceptor's did: a boosted player leaves a stock 620 behind
    // for good, and `strafe` needs a band that can still catch one.
    // The bike floor, and the reason "slow down" is a real answer to this type:
    // under it the weave cannot hold station and sweeps past, taking the SMG's
    // firing line with it. See THE TWO SPEED BANDS.
    //
    // speedMax OPENS THE cruiseMax..660 GAP TO 800, past the cycle's own 730 —
    // the catalogue's fastest thing is now this, not the cycle, and also past
    // ENEMY_GUN's muzzleSpeed (760, weapons.js) and a maxed engine (740,
    // upgrades.js), both of which used to be sized to "clear the fastest
    // thing on the road" and no longer do against this one type. DELIBERATE:
    // low health, low damage, and it SWEEPS PAST rather than sitting behind
    // the player (`strafe`), so a rearward shot never needing to catch it
    // costs nothing — the player's window is while it's alongside or ahead,
    // same as any other pass. Not being outrunnable is the point, not a gap.
    speedMin: 200,
    cruiseMin: 400,
    cruiseMax: 660,
    speedMax: 800,
    steerSpeed: 250, // the widest sweep on the road needs the quickest hands;
                     // this is the nimblest thing in the catalogue, past the
                     // cycle's own 180
    blastRadius: 12,
    blastDamage: 6,
    value: 100,
    bounty: 10,
    minDistance: 300,
    behaviour: "strafe", // holds the interceptor's gap astern, but sweeping
                         // across the player's line rather than parked on it —
                         // see behaviours.js's `strafe`
    // THE STOCKER'S SMG, and the one place these two heavy-and-light opposites
    // agree: a spray is the right weapon for a shooter that is never quite
    // lined up, and a weaving bike is never quite lined up BY DESIGN. Its wide
    // `aimSlack` (weapons.js) is what keeps the sweep firing rather than
    // holding fire through most of it. No layer, same as the stocker's: this
    // car spends its whole life behind the player.
    arms: "gunner",
    driving: "outrider",
    weight: 2,
  },
  {
    id: "outrunner",
    label: "OUTRUNNER",
    shape: carShapeIndex("CRUISER"),
    faction: ENEMY_FACTION,
    w: 32,
    h: 66,
    health: 35, // the toughest of the three, and still under a single mine
    mass: 0.6,
    // MUST be able to get past a player at their own ceiling (620, player.js),
    // or the tactic never starts: everything this car does happens in front.
    // The bike floor, from in front: a player who drops under it watches this one
    // pull away up the road and out of the fight. The counter to the one hostile
    // that attacks from ahead is to stop chasing it.
    speedMin: 200,
    cruiseMin: 600,
    cruiseMax: 670,
    speedMax: 700,
    steerSpeed: 200,
    blastRadius: 16,
    blastDamage: 8,
    value: 100,
    bounty: 20,
    // The latest gate on the road bar the rival's. Being shot at from in front
    // is a genuinely different problem from everything the opening hour
    // teaches, and it lands better as a late surprise than as one more thing
    // in the mirror.
    minDistance: 900,
    behaviour: "outrun", // gets past, holds station up the road and fires back
                         // down it — see behaviours.js's `outrun`
    // The plain blaster, and the reason is the direction: the SMG is
    // `forwardOnly` (weapons.js) and this car is never in front of its target
    // by accident. See armament.js's `rearguard`.
    arms: "rearguard",
    driving: "outrunner",
    weight: 1,
  },
  {
    id: "sower",
    label: "SOWER",
    // The trike, and the trunk slung between its rear tyres is what it is
    // carrying. The one hull in the fleet with somewhere to put a spike strip.
    shape: carShapeIndex("GLIDE"),
    faction: ENEMY_FACTION,
    w: 38,
    h: 66,
    health: 70,
    mass: 0.8,
    // THE FASTEST THING ON THE ROAD AFTER THE CYCLE, and that is the whole
    // second half of its tactic: the run-out has to be an escape the player
    // watches happen, not a car they can chase down and settle with.
    // The bike floor. The run-out above is unaffected — that is the CEILING's
    // job — and what this buys is the run-IN: under it the trike cannot hold
    // station long enough to line the strip up.
    speedMin: 200,
    cruiseMin: 640,
    cruiseMax: 650,
    speedMax: 650,
    steerSpeed: 140,
    blastRadius: 20,
    blastDamage: 10,
    value: 100,
    // PAID LIKE THE REST, though it is the one hostile that never shoots at
    // anybody: what it leaves behind costs the player five seconds of crawling
    // (obstacletypes.js's `slowTo`), which is worth as much as a gun and
    // usually more. Killing it before the drop is the point.
    bounty: 25,
    minDistance: 1200,
    behaviour: "strew", // `raid`'s run-in with a strip for a payload, then away
                        // flat out and unarmed — see behaviours.js's `strew`
    // No gun at all, one spike strip, and one only — see armament.js's
    // `spiker`. The cycle's shape of kit pointed at the other payload.
    arms: "spiker",
    driving: "sower",
    weight: 0.8, // uncommon: a strip is an event, and three of them at once
                 // would be weather
  },

  // --- Enemy: the last one -----------------------------------------------------
  //
  // THE ROAD TRAIN. NOT A BOSS — no `staged`, no `hullMeter`, an ordinary
  // `weight` in the ambient draw — but the toughest thing that draw can
  // produce, and the last hostile this catalogue adds: everything past this
  // point is a boss's own record, held off the ambient road entirely.
  //
  // THE LONGEST SILHOUETTE IN THE GAME, at 180px — past even the mortar's 90
  // or the bunker's 132 — because this one earns its presence by being SEEN
  // arriving, three hulls at a time, rather than by an encounter announcing
  // it first. Graduated from bossshapes.js's ARMORED RIG group unedited but
  // for its one helper call; see that file's own note and carshapes.js's
  // ROAD TRAIN entry.
  //
  // `outrun` (behaviours.js), THE OUTRUNNER'S OWN TACTIC, NAMED DIRECTLY: get
  // past whatever's ahead, hold station up the road, and stay there — the
  // same tactic the bunker trailer and the skirted barge already carry. NOT
  // `duel`: that one settles into `pursue` for good once its one mine is
  // spent, which is a hostile that ends up parked on the player's own bumper
  // — the road's standing pressure, and the right shape for the rival, but
  // the wrong one for a car meant to be seen coming rather than felt from
  // behind. This one holds AHEAD instead, the same promise every other
  // front-attacking hostile makes, and the mine drop is no longer one
  // deliberate round on the way past: `useArms` (armament.js) tries `layMine`
  // every tick armed, so it drops opportunistically, again and again out of
  // its own magazine, for as long as the hold keeps the player inside the
  // layer's own window — the literal reading of "drops mines when in front
  // of the player" rather than a single scripted round.
  {
    id: "roadtrain",
    label: "ROAD TRAIN",
    shape: carShapeIndex("ROAD TRAIN"),
    faction: ENEMY_FACTION,
    // The shape's own authored size, unchanged.
    w: 46,
    h: 180,
    // TWICE THE RIVAL'S OWN 400 — the toughest ambient hostile until now, and
    // doubly so on purpose. The mine deals a flat 150 (obstacletypes.js): 800
    // survives five direct hits (800 - 5*150 = 50) and dies on the sixth,
    // where the rival's own 400 folds on the third. Still an order below the
    // boss tier's four-figure totals (the mortar's 3200) — this is the
    // ambient road's own ceiling, not a set-piece.
    health: 800,
    // HEAVIER THAN ANYTHING THAT ISN'T A BOSS — above the rig's own 4, under
    // the bosses' shared 6. Three articulated hulls of armour plate ask for
    // more than the ordinary road's mass scale was built to carry, but the
    // full boss figure would make ramming this as pointless as ramming one,
    // which this is deliberately short of being.
    mass: 5,
    // OPENS A GAP LIKE THE OTHER HEAVIES DO (the bruiser's 330..560, the
    // stocker's 415..600): the cruise roll is what the road sees on an
    // ordinary pass, `speedMax` is what `outrun`'s overtake half spends
    // fighting its way past whatever's ahead before it can settle into its
    // hold. 650 AND NO HIGHER, matching the rival's own ceiling exactly —
    // overdrive (620 -> 820, twelve seconds) is the escape from this one too,
    // and this car earns no exemption from that just for being heavier.
    speedMin: 0,
    cruiseMin: 380,
    cruiseMax: 500,
    speedMax: 650,
    // CLEARS obstacles.js's SPAWN_MARGIN BUDGET WITH ROOM TO SPARE:
    // dodgeDistance(650, 120) is ~1007, under the rig's own worst-case ~1142
    // that budget is sized against (test/hazards.test.js). Slower hands than
    // any ordinary hostile (120 against the standard tier's 150-250) — three
    // welded hulls do not snap sideways, and the road already prices that as
    // "fast, and it shows," not as unhittable.
    steerSpeed: 120,
    // THE BIGGEST BLAST A HOSTILE CAN DEAL, second only to the rig's own
    // 200/60 civilian record — three hulls of armour going up should clear
    // more tarmac than any other kill on the road, short of the one thing
    // that was always going to top it.
    blastRadius: 160,
    blastDamage: 55,
    value: 500,
    bounty: 75,
    // RARE, AND LATE. Nothing meets one before DIST 3000 — past even the
    // rival's own 1400 — so this is the last new threat the ambient road
    // introduces, arriving once the player has had the whole road to get
    // ready for it rather than as one more thing in the mirror early.
    minDistance: 3000,
    behaviour: "outrun", // gets past, holds station up the road — the
                        // outrunner's own tactic, see the header note above
    // DOUBLE SMG, EITHER DIRECTION, PLUS THE STANDARD MINE LAYER — see
    // armament.js's `roadtrain` kit. `ENEMY_TWIN_SMG` is the skirted barge's
    // own weapon (weapons.js's `twinSmg`), reused rather than duplicated —
    // and NO forwardOnly on it (unlike the outrunner's own REARGUARD kit),
    // which is what lets this car keep firing if it ever ends up behind the
    // player instead: `outrun`'s "still getting past" phase is plain
    // `overtake`, armed the whole way there, so a shot on the way to the hold
    // is on the table exactly as one is once it's won.
    arms: "roadtrain",
    // NOT THE RIVAL'S OWN `duelist` PROFILE — that one's `nerve: 10` is "a
    // driver, not a battering ram," the rival's own character. This is armour
    // plate three hulls long; it does not swerve for a barrel, it drives
    // through it. `nerve: 0` — amber, like the rig and every other heavy on
    // this road — is the different claim, and the reason it earns its own row
    // in driving.js rather than borrowing the rival's.
    driving: "roadtrain",
    weight: 0.2, // rarer than the rival's own 0.3 — the last figure the
                // ambient draw spends
  },

  // --- The boss -------------------------------------------------------------
  {
    // THE SIEGE MORTAR. The road's first proper boss, and the first entry in
    // this catalogue the ambient spawner is not allowed to touch (`staged`).
    //
    // WHAT MAKES IT A BOSS is not any one field but the fact that every one of
    // them is off the end of the scale it belongs to: eight times the hull of
    // anything else, the only tracked silhouette, the only kit with artillery
    // in it, and the only payout worth a shop visit on its own. It is still a
    // plain CAR_TYPES row driven by a plain behaviours.js tactic, which is the
    // point — the boss cost the game one new weapon system and no new concept
    // of what an enemy is.
    id: "mortar",
    label: "SIEGE MORTAR",
    // Authored in bossshapes.js and graduated into carshapes.js the day this
    // record was written — see that file's note where the TANK group used to be.
    shape: carShapeIndex("SIEGE MORTAR"),
    faction: ENEMY_FACTION,
    // The shape's own authored size, unchanged. It is the widest thing on the
    // road by some way — a lane is 65px — which is half of why it reads as a
    // wall the moment it comes over the top of the screen.
    w: 62,
    h: 90,
    // EIGHT TIMES THE RIVAL. The player's cannon does 41 a round at ~6
    // rounds/sec (weapons.js), so 3200 is about thirteen seconds of PERFECT
    // fire — and perfect is exactly what the barrage is there to prevent. At a
    // realistic third of that uptime it is a fight of well over half a minute,
    // which is what makes this the longest engagement in the game by some way.
    //
    // RAISED FROM 1600, and the encounter's `duration` went with it: that
    // backstop is measured in ROAD (eventtypes.js), so a player holding top
    // speed covers it in a fixed ~30 seconds however much hull the boss has.
    // At 1600 the fight comfortably fit inside it; doubling the hull would have
    // let a fast player run the clock out on a boss they were winning, which
    // turns a backstop against being trapped into a cap on the fight. The two
    // numbers move together — change one and check the other.
    health: 3200,
    // Half again the rig's 4, which cartypes.js already calls "immovable in
    // practice". Ramming a boss must never be a strategy; this is what makes
    // the attempt cost the player and move the mortar almost not at all.
    mass: 6,
    // AT THE TOP OF THE CATALOGUE, level with the cycle's 730 ceiling and no
    // higher. It is a tracked siege gun doing highway speed, which needs saying
    // out loud: the alternative was a boss the player drives away from, and
    // this road already has a 400-hull rival wearing the player's own body at
    // 650. What the band actually buys is that the fight STAYS ON SCREEN —
    // see behaviours.js's `siege`. It deliberately does NOT cover a boosted
    // player (pickuptypes.js lifts the whole band by 200 for twelve seconds),
    // and that gap is the one escape the encounter allows.
    // A TRACKED HULL AND NO FLOOR AT ALL, and the boss fight depends on it.
    // `siege` holds station AHEAD of the player, and its approach OVERSHOOTS —
    // it arrives at 640+ and sheds that through traffic.js's ACCEL, ending some
    // 400 units past `leadHold`. Recovering that means driving SLOWER than the
    // player, not merely as slow: floored at the player's own minimum it could
    // match a crawl but never close on one, and a player who braked would park
    // the boss off the top of the screen for good. Measured — it is the reason
    // this row reads 0 rather than 100. The one escape stays the documented one:
    // twelve seconds of overdrive (pickuptypes.js), which lifts the whole band.
    speedMin: 0,
    cruiseMin: 640,
    cruiseMax: 730,
    speedMax: 730,
    // SLOW HANDS, and the split from the speed above is what keeps it fair: it
    // holds the pace but cannot dodge, so it stays a big target the cannon can
    // stay on. Quick in both would be unhittable.
    //
    // BOUNDED FROM BELOW BY A RULE, not by feel. This is the first type that is
    // both FAST and WALLOWING, and obstacles.js's SPAWN_MARGIN is sized so the
    // worst dodger on the road can still cross two lanes before reaching a
    // hazard (behaviours.js's dodgeDistance, asserted in test/hazards.test.js).
    // At 730 units/sec that floor is 120; under it the spawner would be placing
    // hazards this car physically cannot avoid.
    //
    // 130 CLEARS IT WITH ROOM and still sits at the slow end of the fleet —
    // level with the interceptor, under the rival's 150 and the outrider's 200.
    // What makes this car unable to dodge is the SPEED, not the hands: at 730
    // units/sec, 130px/sec of slide is a lane every half second while the road
    // goes past at five lengths a second.
    steerSpeed: 130,
    // The biggest death blast in the catalogue, and still under half the
    // player's hull at the centre: winning next to it should hurt and must
    // never be what kills you the moment you have won.
    blastRadius: 90,
    blastDamage: 45,
    // THE WINDFALL both of these fields were written to allow — see the header,
    // where a boss is named as the reason `value` and `bounty` are literals on
    // every row. They are deliberately not in the flat 100/25 proportion: the
    // score resets every run and can afford to be generous, while credits BANK
    // across runs (wallet.js) and inflate every future one, so the money is the
    // conservative half. 250 is ten ordinary kills — two and a half rungs of a
    // stat ladder, or a full consumable resupply.
    value: 1500,
    bounty: 250,
    // NEVER ROLLED. The `siege` encounter (eventtypes.js) is the only thing
    // that puts one on the road, so the gate below is not a gate at all — the
    // event's own milestone is this type's only trigger. Stated as 0 rather
    // than as some large number precisely because there is no ambient unlock
    // being waited for: `staged` is what holds it back, and a second gate
    // pretending to do the same job would be the misleading one.
    staged: true,
    minDistance: 0,
    weight: 0,
    behaviour: "siege", // `outrun`'s hold with no gun behind it — the shells go
                        // on the road ahead of the player instead (behaviours.js)
    arms: "battery",    // no gun, three mines, and the artillery (armament.js)
    driving: "battery", // holds higher up the screen than anything else
    // The bar under the hull. See effects.js's drawHullMeter for why this is
    // an opt-in flag rather than a health threshold: a future boss buys the
    // instrument with one line, and no ordinary enemy ever grows one by
    // accident. THE BUNKER TRAILER below is that future boss, arrived.
    hullMeter: true,
  },

  {
    // THE BUNKER TRAILER. The road's second boss, and an escalation of the
    // OUTRUNNER rather than of the mortar above: same tactic (`outrun` —
    // overtake, then hold station ahead and shoot back down the road), same
    // shape of kit, both numbers turned up past what an ordinary hostile is
    // allowed. REARGUARD's own note names the escalation and declines it for
    // the outrunner — "a hostile that could both pin the player from in front
    // AND carpet the road between them is two encounters at once" — which is
    // exactly what a SECOND boss is for: the first one taught the player to
    // fear a fixed point ahead of them that cannot be reasoned with; this one
    // fights back while it holds that point.
    //
    // ITS OWN HULL, WELDED SHUT. carshapes.js's BUNKER TRAILER pitch is "the
    // rig you know, welded shut" — armour bolted onto the ordinary RIG's own
    // silhouette rather than a new one to learn, escalating a shape the player
    // already reads as heavy rather than introducing a second unfamiliar one
    // this early after the mortar's tracked hull.
    id: "bunker",
    label: "BUNKER TRAILER",
    shape: carShapeIndex("BUNKER TRAILER"),
    faction: ENEMY_FACTION,
    // The shape's own authored size, unchanged.
    w: 46,
    h: 132,
    // ABOVE THE MORTAR'S 3200, and the reason is where the two fights sit on
    // the road rather than anything about the kit: this one arrives at DIST
    // 2000 against the mortar's 1200, which is roughly two more shop visits
    // (hauler.js's SHOP_INTERVAL, 350) of upgrades the player has had time to
    // buy. A second boss with the first one's own hull would be a shorter
    // fight than the one the player has since out-levelled it for, which
    // reads as an anticlimax rather than an escalation.
    //
    // THE SAME DPS FLOOR THE MORTAR'S OWN NOTE MEASURES AGAINST — cannon
    // ~256 dps, rocket ~280, tracker ~185, all at roughly a third of perfect
    // uptime once dodging is accounted for — scaled by the same ~1.3x this
    // row scales the mortar's hull by: a cannon-only player clears this in
    // ~47s against the mortar's ~36s. `duration` below (eventtypes.js) moves
    // with it, at the mortar's own ratio of backstop to hull.
    health: 4200,
    // The mortar's own 6 — "half again the rig's 4… ramming a boss must never
    // be a strategy." This car IS the rig, welded shut, so the same figure is
    // the same claim rather than a coincidence.
    mass: 6,
    // THE MORTAR'S OWN BAND, reused rather than re-derived. Two things force
    // it: FLOOR 0, because this is a second hostile that attacks from IN
    // FRONT (see the field table's WHY THE SECOND GROUP IS 0 note above) and
    // must be able to fall back onto a player who brakes; and the CEILING at
    // 730, because `outrun`'s overtake has to clear the player's own 620
    // first. Reusing the figures outright also keeps this row off
    // obstacles.js's SPAWN_MARGIN budget, which the mortar's dodgeDistance
    // already spends about as much of as the catalogue can afford (see
    // test/hazards.test.js) — a car that shares the band shares the number
    // rather than adding a second claim on the same margin.
    speedMin: 0,
    cruiseMin: 640,
    cruiseMax: 730,
    speedMax: 730,
    // THE MORTAR'S OWN 130, for the mortar's own reason: fast and wallowing
    // together are what keep a car this size from also being able to dodge —
    // see the field table's WHERE 200 COMES FROM note and the dodgeDistance
    // budget cited above, both of which this figure was already measured
    // against once and would have to be measured against again for any other
    // number.
    steerSpeed: 130,
    // The mortar's own 90/45 — a boss's ram must hurt on both sides of a kill,
    // never so much that winning next to it costs more hull than the fight
    // that got the player there.
    blastRadius: 90,
    blastDamage: 45,
    // PAST THE MORTAR'S 1500/250, the same DIST-2000-over-DIST-1200 relation
    // `health` above is priced against: a second boss the player has spent
    // longer reaching pays more of both currencies, on the header's own split
    // between what a kill is WORTH (score, generous) and what it PAYS
    // (credits, conservative).
    value: 1800,
    bounty: 300,
    // NEVER ROLLED, exactly like the mortar. The `bunker` encounter
    // (eventtypes.js) is this type's only trigger.
    staged: true,
    minDistance: 0,
    weight: 0,
    behaviour: "outrun", // gets past, holds station up the road and fires back
                         // down it — the outrunner's own tactic, named
                         // directly rather than through a `siege`-style
                         // wrapper, because this car (unlike the mortar)
                         // carries a gun that tactic is free to fire
    arms: "bunker",      // the burst SMG, backward-capable, plus a mine layer
                         // twice the cycle's rate (armament.js)
    driving: "bunker",   // holds at the siege battery's own height on screen
    // The bar under the hull, same instrument the mortar's own carries. See
    // traffic.js's METER_MARKS for why this one draws with no notches: the
    // marks are the siege battery's own phase thresholds (armament.js's
    // BARRAGE), and this car has no phases to promise — an instrument that
    // notched a fight that never escalates would be the "lying instrument"
    // effects.js's own header warns against.
    hullMeter: true,
  },

  {
    // THE SKIRTED BARGE. The road's third boss, and the first that is not a
    // wheeled vehicle: a hovercraft, and `roadMargin` below is what that
    // buys — the one car on this road allowed past the barrier at all. Same
    // `outrun` tactic as the bunker (gets past, holds station ahead, fires
    // back down the road at it), so the escalation is not a new manoeuvre,
    // it is that manoeuvre's own clamp widened for this one type: `outrun`
    // reads behaviours.js's `trackTarget`, which normally clamps its hold to
    // `ROAD_HALF_WIDTH - car.w / 2` (road.js) the same as every wheeled car.
    // This is the one entry that widens that limit AND leans into it —
    // `trackTarget` holds further past the player's own lane the nearer the
    // player already is to an edge, so hugging a barrier is answered by the
    // hull visibly crossing it, not merely by a wheeled car's half-width
    // graze. See traffic.js's `clampToRoad` and behaviours.js's
    // `trackTarget`, the two places that read the field.
    id: "barge",
    label: "SKIRTED BARGE",
    // Authored in bossshapes.js and graduated into carshapes.js the day this
    // record was written — see that file's note where the HOVERCRAFT group's
    // second hull used to be.
    shape: carShapeIndex("SKIRTED BARGE"),
    faction: ENEMY_FACTION,
    // The shape's own authored size, unchanged.
    w: 64,
    h: 100,
    // SIZED AGAINST THE LOADOUT THIS BOSS ASSUMES, not the DIST-linear step
    // the first two bosses' hull totals happen to sit on (mortar 3200 @
    // DIST 1200, bunker 4200 @ DIST 2000 — about 1.25 hull per DIST unit,
    // which would put this one at ~5450). A player who has reached DIST 3000
    // has had three shop visits (hauler.js SHOP_INTERVAL 350) since the
    // mortar and is assumed to own TWIN CANNON, which neither earlier fight's
    // own health figure was priced against:
    //
    //   cannon        256 dps   ~27s
    //   twin cannon   512 dps   ~14s   (both rounds connect — this hull is
    //                                   64 wide, well past the pair's 20px
    //                                   spread)
    //   rocket        280 dps   ~25s   (rationed by ammo, so not sustainable
    //                                   this long)
    //
    // At the siege battery's own realistic third of perfect uptime — and
    // real uptime here is lower than on either predecessor, since
    // `roadMargin` below means holding the SMG's line is holding a target
    // that can plant itself anywhere across the road, not just the nearest
    // legal lane — twin cannon clears this in ~42s, longer than either
    // earlier boss's own realistic fight.
    health: 7000,
    // The mortar's and bunker's own figure, reused: half again the rig's 4,
    // "immovable in practice". A third boss gets no softer a ram just for
    // floating.
    mass: 6,
    // THE ARRIVAL PACE IS THE MORTAR'S AND BUNKER'S OWN, reused: it already
    // clears obstacles.js's SPAWN_MARGIN dodge-distance budget with room (the
    // rig, not either boss, is the actual worst case there — see the
    // bunker's own note above).
    speedMin: 0,
    cruiseMin: 640,
    cruiseMax: 730,
    // OPENS THE cruiseMax..speedMax GAP the shared boss band otherwise leaves
    // closed (this file's own THE TWO SPEED BANDS note on what that gap
    // buys): a player who reaches DIST 3000 already owns the twelve-second
    // OVERDRIVE boost (pickuptypes.js), which lifts their own ceiling from
    // 620 to 820 — past either earlier boss's flat 730 speedMax, which would
    // let an overdriving player simply leave this one behind and empty the
    // fight early by outrunning it off the bottom of the screen. 900 clears
    // 820 with room, the same way the stocker and the bruiser open this same
    // gap to chase with rather than to cruise faster.
    speedMax: 900,
    // FASTER HANDS THAN EITHER EARLIER BOSS, and not by taste: raising
    // speedMax past 730 also raises this car's own entry in behaviours.js's
    // dodgeDistance (test/hazards.test.js sweeps every type's speedMax
    // against obstacles.js's SPAWN_MARGIN), and the mortar's and bunker's own
    // 130 at 900 would have pushed this catalogue's worst case past that
    // budget. 150 keeps it under the rig's own 1141.96-unit figure — still
    // the worst case in the catalogue — rather than raising SPAWN_MARGIN, a
    // number sized for the whole road, for one boss whose own encounter never
    // spawns a hazard to dodge in the first place (density: { hazards: 0 },
    // eventtypes.js). It also happens to be the honest hull: a hovercraft is
    // not wheel-and-tread bound the way the mortar's tracked hull or the
    // bunker's semi are, so sharper lateral control reads as what it is
    // rather than as a tuning patch — and it is what lets the lean past the
    // barrier (`roadMargin` below) arrive fast enough to read as a reaction
    // to the player's own lane, not a slow drift.
    steerSpeed: 150,
    // The established boss ceiling (mortar, bunker), reused for the third
    // time running: winning next to this one should hurt exactly as much as
    // winning next to either of the others, not more.
    blastRadius: 90,
    blastDamage: 45,
    // PAST THE BUNKER'S 1800/300, on the same "a longer fight pays more of
    // both" logic — and a bigger step than mortar-to-bunker took, matching
    // the bigger step `health` above took.
    value: 2200,
    bounty: 400,
    // NEVER ROLLED. The `barge` encounter (eventtypes.js) is this type's
    // only trigger.
    staged: true,
    minDistance: 0,
    weight: 0,
    behaviour: "outrun", // the bunker's own tactic — see the header note above
                         // for why no new one was needed
    arms: "barge",       // a double SMG (weapons.js's `twinSmg`, the bunker's
                         // backward-capable `turretSmg` fired as a pair) and
                         // no mine layer — this boss's whole extra threat is
                         // that its gun follows you off the tarmac, not a
                         // second weapon system
    driving: "barge",    // the siege battery's own height on screen, same as
                         // the bunker
    // TWO LANE WIDTHS PAST THE BARRIER — as much shoulder as the paved road
    // itself gives on that side. Derived from road.js's own LANE_WIDTH rather
    // than picked, on the same grounds HAZARD_DODGE_SPAN and the rest of
    // behaviours.js's road-geometry contracts are: a car's reach off the
    // tarmac is a fact about the road, not a taste.
    //
    // `trackTarget` (behaviours.js) does not merely permit this margin — it
    // LEANS into it, holding further past the player's own lane the nearer
    // the player already is to an edge, from nothing at the centre-line up
    // to the full margin at the true barrier (the formula lives there, not
    // here, since `roadMargin: 0` makes it a no-op for every wheeled type).
    // A car that only ever matched the player's exact offset would graze the
    // barrier by half its own width at most; leaning wider is what actually
    // carries the hull's CENTRE past the tarmac, which is the whole point of
    // a hovercraft boss existing — still gated by `blocked` (behaviours.js),
    // the same reactive fallback every station-keeping tactic already has.
    roadMargin: LANE_WIDTH * 2,
    // The bar under the hull, the same instrument the other two bosses
    // carry. No BARRAGE phases here either (armament.js's `barge` kit has no
    // battery), so it draws with no notches, same reasoning as the bunker's
    // own note above.
    hullMeter: true,
  },

  {
    // THE CATAMARAN GUNSHIP. The road's fourth boss, and a combination
    // rather than a fresh escalation: the siege mortar's fight (no gun, an
    // indirect barrage that leads the target and cannot be dodged by simply
    // driving faster — armament.js's fireBarrage) carried by the skirted
    // barge's hull (`roadMargin` below, the one field that lets a car settle
    // past the barrier). Both halves are named machinery, reused rather than
    // rebuilt: `behaviour: "siege"` is the mortar's own tactic unchanged, and
    // `arms: "catamaran"` is BATTERY's own numbers on a fresh object (see
    // armament.js's CATAMARAN_BATTERY) driving the SAME shared BARRAGE
    // escalation table the mortar reads — one shell, then two, then a
    // straddle, at whatever fraction of THIS boss's own hull is left.
    id: "catamaran",
    label: "CATAMARAN GUNSHIP",
    // Authored in bossshapes.js and graduated into carshapes.js the day this
    // record was written — see that file's note where the HOVERCRAFT
    // group's last hull used to be.
    shape: carShapeIndex("CATAMARAN GUNSHIP"),
    faction: ENEMY_FACTION,
    // The shape's own authored size, unchanged.
    w: 68,
    h: 100,
    // CONTINUING THE SAME ESCALATION barge's own entry set out: a player who
    // has reached DIST 4000 has had roughly one more shop visit than the
    // barge's own fight assumed (hauler.js SHOP_INTERVAL 350), so this
    // boss's hull is priced up from the barge's 7000 by more than the
    // straight DIST-linear step would give, the same reasoning barge's own
    // note gives for why it broke from mortar-to-bunker's own ratio:
    //
    //   cannon        256 dps   ~41s
    //   twin cannon   512 dps   ~21s
    //   rocket        280 dps   ~38s   (rationed by ammo, so not sustainable
    //                                   this long)
    //
    // At the siege battery's own realistic third of perfect uptime, twin
    // cannon clears this in ~62s — longer than any earlier boss's own
    // realistic fight, which is the right shape for the last one on the
    // road so far: this is the fight the whole run has been building toward.
    health: 10500,
    // The established boss figure, reused a fourth time: half again the
    // rig's 4, "immovable in practice".
    mass: 6,
    // THE ARRIVAL PACE IS THE SHARED BOSS BAND, reused rather than opened
    // the way the barge's own speedMax was. That was a deliberate exception
    // to answer a gun that has to keep the player in its line; a barrage
    // has no line to keep — armament.js's fireBarrage has no range gate on
    // purpose, so this boss reaches the player whether they are alongside
    // it or a screen away on overdrive. Twelve seconds of overdrive
    // outrunning it stays exactly the escape the siege mortar's own entry
    // already documents, not a hole this boss needs to close.
    speedMin: 0,
    cruiseMin: 640,
    cruiseMax: 730,
    speedMax: 730,
    steerSpeed: 130,
    // The established boss ceiling, reused a fourth time: winning next to
    // this one should hurt exactly as much as winning next to any other.
    blastRadius: 90,
    blastDamage: 45,
    // PAST THE BARGE'S 2200/400, on the same "a longer fight pays more of
    // both" logic that has held for every boss so far.
    value: 2600,
    bounty: 500,
    // NEVER ROLLED. The `catamaran` encounter (eventtypes.js) is this
    // type's only trigger.
    staged: true,
    minDistance: 0,
    weight: 0,
    behaviour: "siege", // the mortar's own tactic — `outrun`'s hold with no
                        // gun-band constraint, since this car carries none
    arms: "catamaran",  // BATTERY's own numbers, no gun, no layer — the
                        // shared BARRAGE table's last-phase mine drop
                        // no-ops on this kit's null layer (armament.js)
    driving: "catamaran", // the siege battery's own height on screen
    // THE BARGE'S OWN MARGIN, reused rather than re-derived: two lane
    // widths past the barrier, leaned into the same way (behaviours.js's
    // `trackTarget`) — see that entry's own note for the formula. A barrage
    // has no aim to keep, so the lean here is pure presence: the player
    // never quite knows which side of the road the mark is coming from.
    roadMargin: LANE_WIDTH * 2,
    // The bar under the hull — and unlike the barge's own, this one DOES
    // draw BARRAGE notches (traffic.js gates them on `car.arms?.battery`,
    // which this kit sets): the phase thresholds are real for this boss,
    // exactly as they are for the mortar, so the meter earns them honestly.
    hullMeter: true,
  },

  // --- The air ---------------------------------------------------------------
  {
    // THE GUNSHIP. The first thing in this catalogue that is not on the road,
    // and — like the boss above — still a plain CAR_TYPES row driven by a plain
    // behaviours.js tactic. It cost the game one flag and no new entity.
    //
    // WHAT MAKES IT AIRBORNE is `airborne` below, and what that flag BUYS is one
    // rule the player can state in a sentence: the cannon shoots along the road,
    // and this is not on the road, so only the rocket can reach it. weapons.js's
    // ROCKET already anticipated exactly this — "a target that changes lanes
    // faster than anything on the tarmac is exactly what a straight or
    // lane-locked round cannot answer" — and said the types would opt in for
    // themselves. This is the type that does.
    //
    // NOT A BOSS, deliberately. No hull meter, no phases, no `at` milestone: it
    // is a rolled encounter the player meets repeatedly and learns to answer, and
    // the answer is a weapon they have to have gone shopping for.
    id: "gunship",
    label: "COMBAT DRONE",
    // Authored in bossshapes.js as ARMORED QUAD and graduated into carshapes.js
    // the day this record was written — the second hull to come across, after
    // the SIEGE MORTAR above.
    shape: carShapeIndex("ARMORED QUAD"),
    faction: ENEMY_FACTION,
    // The shape's own authored size, unchanged. Square, which nothing else on
    // the road is, and the four rotors reach past it — see the hull's
    // `overhang`, which is what the sprite bounds are actually sized from.
    w: 70,
    h: 70,
    // FOUR ROCKETS EXACTLY. The rocket does 98 (weapons.js), so 392 is four
    // rounds with nothing wasted and three rounds (294) comfortably short. That
    // is the whole fight: the player carries 50 rockets at most and buys them 18
    // at a time for 50 CR, so this costs a measurable ~11 CR of ammunition to
    // kill and the `bounty` below has to clear that or winning is a fine.
    //
    // It sits level with the rival's 400 on purpose. The rival is the toughest
    // thing the free cannon can kill; this is the same weight of enemy that the
    // cannon cannot touch at all, which is what the payout is priced against.
    health: 392,
    // NEVER READ. An airborne body is not handed to collisions.js at all
    // (traffic.js's collide), so this is the one field on this row that does
    // nothing — stated at the reference 1 rather than omitted, because a missing
    // `mass` would read as an oversight where a stated one reads as "the solver
    // never sees this car", which is the fact worth recording.
    mass: 1,
    // Spanning the player's own 620 ceiling, the same shape of band the boss
    // has and for the same reason: the fight has to STAY ON SCREEN, and it must
    // not survive the twelve seconds of overdrive a boost buys (pickuptypes.js
    // lifts the player's whole band by 200). That gap is the escape.
    // IT HOVERS, so nothing about being airborne makes a minimum speed physical
    // — and `patrol` holds station ahead, so the mortar's rule applies unchanged:
    // an attacker in front must be able to FALL BACK onto a player who brakes.
    speedMin: 0,
    cruiseMin: 580,
    cruiseMax: 660,
    speedMax: 660,
    // THE FASTEST THING ACROSS THE ROAD IN THE GAME, past the outrider's 200,
    // and it should be: it is the only one not steering on tyres.
    //
    // BOUNDED FROM ABOVE BY THE ROCKET, and that bound is the single most
    // important relation on the row: the rocket steers at turnRate 390
    // (weapons.js, +50% over its original 260) and is the ONLY weapon
    // permitted to reach this thing, so a gunship that could out-slide a
    // seeker could not be killed by anything at all. 240 leaves 150 units/sec
    // of margin.
    //
    // IN PRACTICE THE MARGIN IS NOT THE FIGHT, and it is worth saying so rather
    // than claiming a duel the numbers do not support. Measured (at the
    // original 260 turnRate): a player holding the trigger kills one in
    // ~1.6-2.0s having fired 5 rockets for the 4 hits it takes, i.e.
    // essentially none are dodged. The reason is flight TIME, not turn rate —
    // the round covers the gap in about 0.4s, and the sweep only moves ~84px in
    // that window against the 104px the rocket could correct at 260 (156px at
    // the current 390). What actually rations this fight is rocket
    // AMMUNITION, which the player has to have gone shopping for; the margin
    // here is the guard-rail that keeps the weapon working at all, not the
    // challenge.
    steerSpeed: 240,
    // NO BLAST, and it is the only hostile row with none. Not an omission and
    // not shyness about the number: it is the other half of the rule the whole
    // type exists to state. Nothing at road level reaches the air
    // (collisions.js's inBlastPlane, which three separate sweeps ask), so the
    // air does not reach the road either — one rule the player can hold in their
    // head, working the same way in both directions.
    //
    // A falling-wreck blast was the alternative and it reads well in isolation;
    // it was dropped because it would be the single exception to that rule, and
    // it would arrive as damage from something the player had just killed with
    // a rocket they paid for. That is the worst possible moment to teach an
    // exception. The kill still gets its fireball — that is Explosions' own
    // wreck effect (traffic.js's detonate), which owes nothing to these two.
    blastRadius: 0,
    blastDamage: 0,
    // PRICED AGAINST THE AMMUNITION, which no other row has to be: four rockets
    // is ~11 CR at the shop's 50-for-18 (upgrades.js). 100 clears that by a wide
    // enough margin that hunting these is worth doing, and matches the rival's
    // bounty — the same weight of enemy, paid the same, with the score half
    // ahead of the rival's 300 because this one costs consumables to reach.
    value: 400,
    bounty: 50,
    // FLYING. See the field table above for the three places this is read; the
    // header of this record for what it is FOR.
    airborne: true,
    // Never rolled — the `airstrike` encounter (eventtypes.js) is the only thing
    // that puts one in the sky. Same reasoning as the boss's, above.
    staged: true,
    minDistance: 0,
    weight: 0,
    behaviour: "patrol", // station-keeping and a sweep that crosses the whole
                         // frame rather than the road (behaviours.js)
    arms: "rocketeer",   // the interceptor's kit, unchanged: one heavy missile,
                         // no mine layer. A thing that never touches the tarmac
                         // has nothing to lay a mine on (armament.js)
    driving: "gunship",
  },
].map(liveried);

// Whether `type` is allowed on the road yet. `distance` is the RAW world
// odometer (main.js), and `minDistance` is in readout units, so the conversion
// lives here and nowhere else — a caller only ever passes what it already has.
// A focused type keeps its own gate (so focusing on the interceptor still waits
// for DIST 100); everything else is gated for ever. See FOCUS above.
export function typeAvailable(type, distance) {
  // A STAGED TYPE IS NEVER AVAILABLE TO THE SPAWNER, at any distance and even
  // under FOCUS — the director places it by id and does not come through here
  // (events.js's planStage), so this is the whole of the "never ambient" rule.
  // Checked before FOCUS rather than after, so focusing on a boss to look at it
  // cannot accidentally turn it into traffic.
  if (type.staged) return false;
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
