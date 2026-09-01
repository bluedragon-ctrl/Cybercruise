// SPECIAL EVENTS — the catalogue. Data only, exactly as cartypes.js and
// obstacletypes.js are data only; game/events.js is what reads it.
//
// WHY THERE IS ONE CATALOGUE AND NOT FOUR SYSTEMS. A motorcycle gang closing
// from behind, a wall of rigs across the road, the road narrowing to a slot, a
// boss at a milestone and the shop drone coming down are all the same kind of
// thing: SOMETHING PLACED ON PURPOSE, AT A MOMENT CHOSEN ON PURPOSE. Written as
// separate features they would be four schedulers, four ways of standing the
// ambient road down, and four places to get placement wrong. Written as entries
// here they are one loop.
//
// The cargo drone (game/hauler.js) is in this list too, and it is the reason the
// `handoff` stage kind exists. Its trigger was already a distance milestone that
// fires once and remembers it did — character for character the boss trigger
// this file would otherwise have invented — and it fired BLIND, with no notion
// that anything else might be happening on the road. Its SCHEDULING is now here;
// its animation, its three phases and its frozen lift are all still hauler.js's,
// untouched. See events.js's own header for the split.
//
import { SHOP_INTERVAL } from "./hauler.js";
import { SHOW_TEST_OPTIONS, EVENT_GATE_OVERRIDES } from "../testoptions.js";

// Fields:
//   id          stable key (logs, tests, FOCUS below)
//   label       the SYS LOG line announcing it
//
//   --- WHEN, and exactly one of these three ---
//   weight      ROLLED. Relative odds among the eligible entries, drawn on the
//               director's own beat (events.js's BEAT) — the same weighted pick
//               cartypes.js and obstacletypes.js use, via weightedpick.js
//   at          ONE-SHOT MILESTONE, in DIST-readout units: fires the first time
//               the odometer passes it, and never again in that run
//   every       RECURRING MILESTONE, in DIST-readout units: fires every N. This
//               is the shop interval, and hauler.js still owns the number
//
//   minDistance how far the player must have driven before a ROLLED entry may
//               come up, in DIST-readout units — the same gate, in the same
//               units, that cartypes.js and obstacletypes.js use. IT MUST BE AT
//               LEAST AS LATE AS THE GATE ON EVERYTHING THE ENTRY STAGES, or an
//               encounter would introduce a car the road itself has not unlocked
//               yet. Asserted in test/events.test.js
//   maxDistance ...and when it stops coming up. Infinity for everything today
//   cooldown    road covered before THIS entry may recur, in DIST-readout units.
//               On top of the director's own global gap between any two events
//   duration    road after which the encounter is over whatever is still alive,
//               in DIST-readout units. Not applied to a `handoff`, which ends
//               when its handler says so
//   exitLabel   the SYS LOG line for an encounter that ran out of `duration`
//               with something it staged STILL ALIVE — the thing it placed is
//               leaving rather than being killed. Optional, and most entries
//               rightly have none: a gang that drifts off the back of the
//               screen needs no announcement. A set-piece does, because a boss
//               that simply stopped existing would leave the player unsure
//               whether it was still coming
//
//   density     { cars, hazards } — multipliers on the AMBIENT spawner budgets
//               (traffic.js's MAX_CARS, obstacles.js's MAX_OBSTACLES) for as
//               long as the encounter runs, restored to 1 when it ends. A
//               MULTIPLIER RATHER THAN A SWITCH because standing the road down
//               entirely is the boss case, not the general one: a gang wants
//               thinner traffic to weave through, not none.
//               A cap of zero DESTROYS NOTHING — the spawner just stops
//               replacing what retires, so the road drains over a few seconds.
//               The highway emptying ahead of a boss is a warning the player
//               watches happen; cars blinking out would read as a fault
//
//   stage       WHAT IT PUTS ON THE ROAD — a list of specs, applied in order.
//               See events.js's planStage() for the four kinds and their fields
export const EVENT_TYPES = [
  {
    // THE MOTORCYCLE GANG. Behind, and that is the whole shape of it: the
    // outriders are the fastest thing in the catalogue (cartypes.js) and a pack
    // of them arriving in the mirror and working forward through the traffic is
    // an encounter that develops rather than one the player drives into.
    id: "gang",
    label: "GANG SIGHTED — REAR",
    weight: 3,
    // The outrider's own gate (cartypes.js), not a number of its own — see the
    // rule on minDistance above.
    minDistance: 300,
    maxDistance: Infinity,
    cooldown: 40,
    duration: 60,
    // Thinned, not emptied. The pack has to weave through something or it is
    // just four cars in a line.
    density: { cars: 0.4, hazards: 1 },
    stage: [
      { kind: "cars", type: "outrider", count: 4, side: "behind", spread: 240 },
    ],
  },

  {
    // THE ROAD NARROWS. Trestles hard against both barriers, three rows of them
    // down a stretch — the lane closure the type already IS (obstacletypes.js),
    // used as furniture rather than as a single hazard.
    //
    // THIS IS SAFE BECAUSE NOTHING HERE MAKES IT SAFE. Every row goes through
    // Obstacles.place(), which refuses anything that would break the passage
    // rule, so a narrowing can only ever come out one trestle thinner than
    // asked for — never a sealed road. See obstacles.js's THE PASSAGE RULE.
    id: "narrows",
    label: "LANE CLOSURE AHEAD",
    weight: 2,
    minDistance: 400, // the trestle's own gate (obstacletypes.js)
    maxDistance: Infinity,
    cooldown: 30,
    duration: 40,
    // Full traffic, no ambient hazards: the slot is the hazard, and a mine
    // rolled into it on top would be unreadable.
    density: { cars: 1, hazards: 0 },
    stage: [
      { kind: "rows", type: "trestle", count: 3, spread: 260 },
    ],
  },

  {
    // THE ROAD CREW. A trestle, then two stacks of barrels behind it, all down
    // ONE side. The smallest encounter in the catalogue and the only one not
    // trying to hurt anybody: it is a lane being worked on.
    //
    // THE ORDER IS THE WHOLE EVENT. The trestle is a WARNING — 20 hull, mass
    // 0.25, "barely worth lifting off the throttle for" (obstacletypes.js) —
    // and the barrels behind it are what it warns about. Read the sign and you
    // have moved over before they arrive; treat it as scenery and you meet 45
    // hull of drum at half a lane's width, still bargeable but no longer free.
    // One cheap piece of information, offered early enough to act on.
    //
    // GATED 200 PAST THE BARREL'S OWN 800, not level with it. Both types are
    // ambient furniture by 1000, so this introduces neither — it arranges two
    // things the player already reads into a sentence.
    id: "roadworks",
    label: "ROAD CREW AHEAD — LANE CLOSED",
    weight: 2,
    minDistance: 1000, // past the barrel's own gate — see above
    maxDistance: Infinity,
    cooldown: 35,
    duration: 30,
    // FULL TRAFFIC: the barrels carry a real `threat`, so behaviours.js's
    // avoidance has the cars ahead easing off the closed side before the player
    // can see why. No ambient hazards, for the reason `narrows` gives.
    density: { cars: 1, hazards: 0 },
    // 150 APART, AND THE FLOOR IS ARITHMETIC. obstacles.js's SPAWN_GAP wants 90
    // units of CLEAR ROAD between two hazards' edges: two stacks of barrels (42
    // deep) need 132 between centres, a trestle followed by barrels 118. Under
    // that, place() refuses the item behind and the worksite comes out as a
    // trestle and one drum. 150 clears both, and is still under a second of
    // road at speed.
    stage: [
      { kind: "flank", types: ["trestle", "barrels", "barrels"], spread: 150 },
    ],
  },

  {
    // THE CHOKEPOINT. Trestles leading in, then five rows of tank traps hard
    // against both barriers — the late-run answer to `narrows`.
    //
    // WHAT THE TETRA CHANGES. A trestle narrowing can simply be driven
    // through: 20 hull, mass 0.25, and clipping one costs a shrug. A tank trap
    // is 80 hull and mass 3.5, "near the rig's own 4", and obstacletypes.js
    // calls it "the one block worth steering around". Five rows is the first
    // place in the run where the gap between the barriers is the ONLY way
    // forward, held for six hundred units of road at whatever speed the player
    // dares.
    //
    // THE TRESTLES ARE WHY IT IS FAIR — the cheap thing warning about the
    // expensive one, the principle `roadworks` is built around. They also taper
    // the eye into the slot before it is close enough to read, which at 620
    // units a second is the difference between a corridor and an ambush.
    //
    // GATED AT 2000, eight hundred past the tetra's own 1200: the block is
    // thoroughly familiar as a single centre-line obstacle before it is reused
    // as architecture, the move `minefield` makes with the caltrop.
    id: "chokepoint",
    label: "ROAD NARROWS — TANK TRAPS",
    weight: 1.2,
    minDistance: 2000, // well past the tetra's own gate (obstacletypes.js)
    maxDistance: Infinity,
    cooldown: 60,
    duration: 60,
    // THINNER TRAFFIC, and unlike `narrows` this one cannot run at full: a car
    // that meets the slot alongside the player has nowhere to be, and the
    // corridor is 137px wide — one car, and it is going to be a rig sooner or
    // later. Some traffic stays because ARRIVING at a chokepoint behind
    // somebody else is the interesting version of it. No ambient hazards: the
    // corridor is the hazard.
    density: { cars: 0.5, hazards: 0 },
    // TWO SPECS IN SEQUENCE, which is what `lead` exists for (events.js): the
    // warning rows, then the traps 300 units further up. All fourteen hazards
    // go through Obstacles.place() — the corridor between two 74px traps on a
    // 286px road is 137px against a MIN_PASSAGE of 58, so the passage rule
    // permits this slot rather than having to widen it.
    //
    // 170 APART IS A FLOOR, like the worksite's 150. A tank trap is 64 deep and
    // SPAWN_GAP wants 90 units of clear road, so rows closer than 155 are not a
    // tighter corridor: every other one is refused and the encounter becomes a
    // lane closure with holes. The `lead` of 300 buys the first trap that same
    // clearance from the last trestle.
    //
    // At 170 the rows also sit outside CLUSTER_WINDOW (130), so the passage
    // rule judges each on its own. It still reads as one committed line: every
    // row puts its traps on the same two barriers, so the way through one is
    // the way through all five.
    stage: [
      { kind: "rows", type: "trestle", count: 2, spread: 130 },
      { kind: "rows", type: "tetra", count: 5, spread: 170, lead: 300 },
    ],
  },

  {
    // THE SLALOM. Four half-road gates of tank traps, alternating sides, with
    // the road between them almost empty — the one encounter that is purely a
    // DRIVING test. Nothing shoots, chases or has to be killed; the whole of it
    // is whether the player can put the car where the road still is, four
    // times, at whatever speed they chose to arrive at.
    //
    // TETRAS, AND ONLY TETRAS. A gate has to be steered around, or the weave is
    // optional and the encounter is scenery. The tank trap is 80 hull and mass
    // 3.5 and obstacletypes.js calls it "the one block worth steering around";
    // a trestle slalom would be a suggestion.
    //
    // TWO DEEP FROM ONE BARRIER: 150px of a 286px road, leaving 76px open on
    // the far side — past MIN_PASSAGE (58) and twice the player's own 34px
    // width, so every gate has a way through that a committed line reaches. The
    // passage rule would refuse a third block; see events.js's `slalom`.
    //
    // 420 BETWEEN GATES IS THE PLAYER'S OWN STEERING. Crossing between open
    // sides is about 136px of lateral travel, and STEER_SPEED is 300px/s off a
    // 900px/s² ramp (player.js) — roughly 0.62s, or 385 units of road at the
    // 620 ceiling. 420 leaves a little in hand: threadable FLAT OUT by someone
    // driving well, punishing for someone arriving late. Tighter and the
    // honest answer would be "brake", which is a different encounter.
    id: "slalom",
    label: "CHICANE — WEAVE AHEAD",
    weight: 1.2,
    // ON THE TETRA'S OWN GATE (obstacletypes.js), which is the relation most of
    // this catalogue is written to: the moment the road is allowed to produce a
    // tank trap is the moment this guarantees a stretch built out of them. The
    // block is introduced and used as architecture in the same breath, and the
    // encounter that teaches what a tetra costs is the one that then asks the
    // player to thread four of them.
    //
    // It also puts the weave against the siege battery's own 1200 rather than
    // after it — the boss holds the director for its whole duration and this is
    // rolled, so in practice the player meets the fight first and the chicane
    // once the road is theirs again.
    //
    // See src/testoptions.js's EVENT_GATE_OVERRIDES for pulling a rolled entry
    // forward by hand. The number here is the SHIPPING one and stays that way.
    minDistance: 1200,
    maxDistance: Infinity,
    cooldown: 70,
    // The gates span 3 * 420 = 1260 units of road, and the encounter has to
    // outlive the drive through them at any speed the player picks.
    duration: 60,
    // ALMOST NOTHING ELSE ON THE ROAD: MAX_CARS is 7 (traffic.js), so 0.15
    // rounds to a cap of ONE ambient car. Not zero — an empty road reads as a
    // cutscene, and one car ahead picking its own way through is the clearest
    // hint the player gets about which side the next gate opens on. No ambient
    // hazards: a mine in a chicane is not a harder chicane, it is an
    // unreadable one.
    density: { cars: 0.15, hazards: 0 },
    stage: [
      { kind: "slalom", type: "tetra", gates: 4, perGate: 2, spread: 420 },
    ],
  },

  {
    // THE SWARM. Twelve bikes — every hull in the motorcycle fleet at once, and
    // by some way the largest formation in the catalogue. `gang` is four
    // outriders doing one thing; this is the fleet's whole argument (see
    // cartypes.js's "Enemy: the motorcycle fleet") arriving as one encounter:
    // one that sweeps across the player's line, one that fights from in front,
    // one that lays a strip and runs, and the cycle forcing its way past to
    // drop a mine. Nothing here has more than 55 hull. The pressure is the
    // NUMBER and the four directions it comes from, not any one bike.
    //
    // TWO RANKS AHEAD AND SIX BEHIND, AND THE ROAD DECIDES THAT SHAPE.
    //
    // A rank costs traffic.js's laneClear 150 units of CLEAR ROAD between two
    // cars in the same lane, which for 66-long bikes is 216 centre to centre.
    // The ahead budget (events.js's aheadRoom, 440) therefore holds two ranks,
    // and the second is placed with `lead` rather than with a spread. It held
    // ONE against the ambient retire margin of 320; traffic.js's
    // STAGED_RETIRE_MARGIN is what bought the second, and has the arithmetic.
    //
    // THREE PER RANK, NOT FOUR: a rank that fills every lane is a wall with no
    // way through, the one thing `abreast` has always refused to build. The
    // director now enforces it for every kind — THE OPEN LANE in events.js's
    // fire() — so a fourth would be dropped whatever this entry asked for.
    // Written as three so the catalogue says what the road will do.
    //
    // THE SIX BEHIND DO NOT ALL ARRIVE THE SAME WAY, and the mix is chosen on
    // that:
    //
    //   THE CYCLES GET IN FRONT UNDER THEIR OWN POWER, cruising 620-730 against
    //   the player's ceiling of 620 and raiding past by definition. Staged in
    //   the mirror they do not stay there — they wash through and around the
    //   player over the next few seconds, and the encounter ends up in front,
    //   where a swarm belongs. Placing them there is what the road forbids;
    //   getting there is what the type already does.
    //
    //   THE OUTRIDERS WORK THE MIRROR, which is the type rather than a
    //   compromise. Their band now reaches 660, past a STOCK player's 620 — the
    //   headroom exists for a BOOSTED player, whose overdrive and Phase 5 pickups
    //   push well past that ceiling and would otherwise strand this type off the
    //   bottom of the screen. Against a stock player it mostly still just holds
    //   station astern on its profile's chaseSpeed of 600 (driving.js) at 20
    //   units a second of slip, sweeping across the player's line as it goes
    //   (behaviours.js's `strafe`). `gang` stages the same bike from the same
    //   side for the same reason. Nine ahead once the road sorts itself out,
    //   three behind, and no clean air in either mirror.
    //
    // GATED AT 1500, past every bike's own gate (cartypes.js), so it introduces
    // nothing — the ambient road's own bikes, met all at once. It sits between
    // the siege battery at 1200 and the chokepoint at 2000: the late run's
    // answer to `gang`.
    id: "swarm",
    label: "BIKER SWARM — ALL POINTS",
    weight: 1,
    minDistance: 1500, // well past every bike's own gate — see above
    maxDistance: Infinity,
    // Twelve hostiles is the biggest ask in the catalogue outside a boss fight,
    // and one every few hundred units would be the late road's weather rather
    // than its set-piece.
    cooldown: 90,
    // The six behind need road to get through the player and out the front; a
    // duration ending mid-overtake would restore the ambient budgets with a
    // dozen bikes still on the tarmac.
    duration: 80,
    // ALMOST NO AMBIENT TRAFFIC and no hazards — `warband`'s crowding argument,
    // sharper here: twelve bikes already fill every lane the player can see,
    // and a rig in the middle of it would be a wall the swarm was never meant
    // to be fought against. The sower's spike strip and the cycle's mines are
    // the hazards this encounter wants; an ambient mine among them would be
    // indistinguishable from one just dropped.
    density: { cars: 0.2, hazards: 0 },
    stage: [
      // THE FIRST RANK — the three the player drives INTO, and the types are
      // chosen for the side rather than to fill it evenly. The outrunners
      // belong here (`outrun` holds station up the road and fires back down it,
      // and being placed in front saves it the overtake) and the sower's whole
      // errand runs forwards.
      { kind: "cars", type: "outrunner", count: 2, side: "ahead", spread: 0 },
      { kind: "cars", type: "sower", count: 1, side: "ahead", spread: 0 },
      // THE SECOND RANK, 216 units further up — one rank's clearance exactly
      // (traffic.js's SPAWN_GAP plus a bike), so the two sit as close as the
      // road allows and read as one body rather than as two encounters. It is
      // OUTRIDERS: the rank ahead is the one thing on this road the player
      // meets at closing speed, and a bike that sweeps ACROSS their line
      // (`strafe`) is worse to arrive at than one holding a lane. They will
      // fall back through the player as the fight develops, which is the type
      // doing what it does rather than the encounter losing its shape.
      { kind: "cars", type: "outrider", count: 3, side: "ahead", spread: 0, lead: 216 },
      // THE PACK — strung out down the road behind, at `gang`'s own spacing, so
      // it arrives as a column that keeps coming rather than as a rank that
      // appears. Behind there is as much road as anyone wants (planStage), so
      // these are the specs free to ask for three at a time.
      { kind: "cars", type: "cycle", count: 3, side: "behind", spread: 200 },
      { kind: "cars", type: "outrider", count: 3, side: "behind", spread: 240 },
    ],
  },

  {
    // THE ROADBLOCK. Rigs abreast, one lane deliberately left open — see
    // events.js's `abreast` for why that gap is a rule and not a decoration.
    //
    // TWO WALLS, SIX RIGS. `abreast` clamps a single rank to LANE_COUNT - 1
    // (road.js) regardless of what `count` asks for — three rigs is already
    // the most one rank can hold without sealing the road — so six means a
    // second rank, staged 300 further up the same way `chokepoint`'s second
    // row of traps is: `lead` stacks it clear of the first rather than laying
    // it on top. This is also what pushed `abreast` to honour `lead` at all —
    // a single-rank spec never exercised it, and nothing caught the gap.
    //
    // 300 CLEARS THE RIG'S OWN LENGTH, the same arithmetic the worksite and
    // chokepoint entries use: traffic.js's SPAWN_GAP wants 150 units of clear
    // road between two cars' boxes in a lane, and a rig is 124 long, so two
    // rigs sharing a lane need 274 between centres. 300 covers that with a
    // rig's width to spare — worth stating because the two ranks pick their
    // open lane independently, so a straight run down the gap is not
    // guaranteed; the second wall may open on the opposite side.
    id: "blockade",
    label: "CONVOY BLOCKING ROAD",
    weight: 1.5,
    minDistance: 500, // the rig's own gate (cartypes.js)
    maxDistance: Infinity,
    cooldown: 60,
    duration: 50,
    density: { cars: 0.5, hazards: 0 },
    stage: [
      { kind: "abreast", type: "rig", count: 3, gapLanes: 1 },
      { kind: "abreast", type: "rig", count: 3, gapLanes: 1, lead: 300 },
    ],
  },

  {
    // THE SET-PIECE. A one-shot milestone, which is the trigger a named boss
    // will use unchanged — this entry exists partly to make sure `at` is a
    // shipping path rather than a tested-in-isolation one.
    //
    // AND IT STAYS THE BRUISER'S, now that a real boss exists. The note here
    // used to say this entry would change by one string the day a boss type
    // landed; that turned out to be the wrong call. `siege` is a different
    // encounter with a different shape — three hundred units later, its own
    // hull, its own weapon — and folding it in here would have cost the run its
    // one EARLY set-piece. Two entries, and the escalation between them is the
    // point: heavy contact at 500, a rival at 900, a battery at 1200.
    id: "warband",
    label: "HEAVY CONTACT AHEAD",
    // MOVED IN FROM 700 to sit exactly ON the bruiser's own gate (cartypes.js),
    // the same relation the rival encounter used to have with its car before
    // that one was deliberately split. The moment the road is allowed to
    // produce the heaviest thing in the ambient catalogue is the moment this
    // guarantees the player meets three of them at once.
    //
    // It also un-books a collision: at SHOP_INTERVAL 350 the second shop stop
    // falls on 700, which is where this used to be, so every run had the drone
    // deferred behind this fight. Nothing was lost — milestones defer rather
    // than cancel — but it happened every single time, and the run is better
    // paced with the two apart.
    at: 500,
    once: true,
    cooldown: 0,
    duration: 90,
    // THE ROAD CLEARS — this entry and the boss below are the two that take
    // both budgets to zero: a set-piece competing with ambient traffic for the
    // player's attention is a set-piece nobody notices.
    density: { cars: 0, hazards: 0 },
    stage: [
      // `atomic`: if the lead cannot be placed, the whole encounter is
      // abandoned and the milestone is not spent — it fires on the next beat
      // instead. An escort with nothing to escort is not the event.
      { kind: "cars", type: "bruiser", count: 1, side: "ahead", spread: 0, atomic: true },
      { kind: "cars", type: "interceptor", count: 2, side: "ahead", spread: 300 },
      // THE BIKE WING, and it is what turns this from a heavy roadblock into a
      // warband. The three cars above are all slow, wide and frontal — the
      // player meets them by driving into them — so on their own the encounter
      // has one texture and one direction. Four outriders in the mirror give it
      // the other: the fastest, flimsiest thing in the catalogue, weaving across
      // the player's line (behaviours.js's `strafe`) while the heavy metal ahead
      // refuses to move out of the way.
      //
      // BEHIND, because that is the only side with room. A formation staged
      // ahead has to fit in the 140 units between the spawn and retire margins
      // (planStage), and the bruiser and its two interceptors have already
      // spent most of it; four more cars up there would simply be refused. It
      // is also where these belong — `gang` stages the same bike from the same
      // side at the same spacing, and `strafe` opens by closing from the rear.
      { kind: "cars", type: "outrider", count: 4, side: "behind", spread: 240 },
    ],
  },

  {
    // THE MINEFIELD. Caltrops scattered across four rows of road, and the one
    // encounter in the catalogue whose SHAPE IS DECIDED BY THE PASSAGE RULE
    // rather than merely permitted by it.
    //
    // Each row asks for three mines. Three 26px mines across a 286px road leave
    // four gaps averaging 52px, and MIN_PASSAGE is 58 (obstacles.js) — so a row
    // that happens to spread evenly is REFUSED its third mine and comes out as
    // two, while a row whose mines cluster to one side keeps all three and
    // leaves one wide lane open. Nothing here decides that; the rule does, row
    // by row, and the field the player threads is whatever it allowed. See
    // events.js's `scatter`.
    //
    // MEASURED, not guessed, over 400 fields: rows come out with three mines
    // 50% of the time and two 46%, occasionally one where two rolls landed on
    // top of each other, for an average of 9.9 mines of the 12 asked for. That
    // spread is the feature — every field is a different shape, and none of
    // them is impassable.
    //
    // ROWS, NOT A CLOUD, and the spacing is why: obstacles.js weighs the
    // passage rule over a CLUSTER_WINDOW of 130 units, so rows 220 apart are
    // judged independently. Every row is separately drivable, which makes the
    // field a sequence of decisions rather than one puzzle with a single
    // solution the player cannot see the whole of.
    id: "minefield",
    label: "MINES ON THE ROADWAY",
    weight: 1.2,
    minDistance: 1200, // the caltrop's own gate (obstacletypes.js)
    maxDistance: Infinity,
    cooldown: 50,
    duration: 40,
    stage: [
      { kind: "scatter", type: "caltrop", count: 4, perRow: 3, spread: 220 },
    ],
    // TRAFFIC STAYS, and it is doing a job here: a caltrop's `threat` is the
    // heaviest in the catalogue, so behaviours.js's avoidance makes the cars
    // ahead swerve around mines the player has not spotted yet — and a car that
    // misjudges it goes up, which is the loudest possible warning. An empty
    // minefield would be a much quieter one.
    //
    // No ambient hazards on top: this stretch is already the hazard.
    density: { cars: 0.6, hazards: 0 },
  },

  {
    // THE RIVAL — the mini-boss, and the one entry in this catalogue that adds
    // no new car, no new tactic and no new artwork. It only guarantees a
    // MEETING.
    //
    // cartypes.js already built this fight: the rival is the toughest thing on
    // the road (400 hull, three mines), the only hostile that can live with the
    // player flat out, it wears the player's own silhouette in the hostile
    // shade, and behaviours.js's `duel` is written for it alone — a cycle-style
    // raid past for one deliberate mine drop, then the interceptor's pursuit
    // for good. Its own entry even says "rare enough that meeting one is an
    // event". At `weight: 0.3` that was left to chance: a player could drive
    // right past DIST 1000 and never see it.
    //
    // So this does not change the odds — the rival stays in the ambient draw at
    // its own weight, and can still turn up on its own afterwards. It just
    // makes the FIRST one a fixed point in the run, the same way `warband`
    // does, three hundred units after the road has learned to fear it.
    id: "rival",
    label: "RIVAL INBOUND — REAR",
    // MOVED TO 900, AND IT NO LONGER MATCHES THE RIVAL'S OWN GATE. It used to
    // be written as "the moment the road unlocks it is the moment it arrives",
    // which was true and is now deliberately false: the ambient gate has been
    // pushed out to 1400 (cartypes.js) so that meeting a rival stays an event
    // rather than becoming weather, and this encounter is what guarantees the
    // FIRST one — five hundred units before the road can produce a second.
    //
    // A MILESTONE MAY INTRODUCE A TYPE THE ROAD HAS NOT UNLOCKED. That is the
    // whole point of a one-shot set-piece and it is what the boss already does
    // (cartypes.js's `staged`). The invariant that rolled entries may not do it
    // still stands and is still checked — see test/events.test.js.
    at: 900,
    once: true,
    cooldown: 0,
    // LONG, because this one is meant to take a while. 400 hull at the
    // player's own top speed is not a fight that resolves in a few seconds,
    // and an encounter that timed out while the rival was still healthy would
    // just quietly hand the road back mid-duel.
    duration: 120,
    // AHEAD — CHANGED FROM BEHIND, and the old reasoning was sound when it was
    // written. It ran: the rival is faster than the player, traffic.js's spawner
    // puts anything faster behind, and a fast car placed ahead simply vanishes
    // over the horizon. Two things make that wrong now.
    //
    //   IT NEVER ARRIVED. The rival's band is 580-650 against a player ceiling
    //   of 620, so most of its rolls are SLOWER than a player at full throttle.
    //   Staged 424 units back it then has to overtake through the encounter's
    //   own traffic on a speed advantage it often does not have. Measured
    //   against a flat-out player: it never got closer than 476 units behind,
    //   and the bottom of the screen is 304. The encounter announced a rival,
    //   ran its full duration, and showed the player nothing at all.
    //
    //   AND "AHEAD VANISHES" IS NO LONGER TRUE. events.js's arrivalSpeed now
    //   caps anything staged ahead at the player's own speed, so a fast car
    //   cannot run away during the seconds its tactic spends settling. That fix
    //   was made for the boss, and it is what makes this side available at all.
    //
    // Measured after the change, at both ends of the player's range: on screen
    // within two to three seconds and engaged from there. `duel` reads the same
    // either way — it opens with `raid`, which wants to be in front for its one
    // mine drop, and being placed there simply saves it the overtake.
    //
    // `atomic` even though there is only one of it: a rival that could not be
    // placed leaves the milestone unspent, so the meeting is deferred to the
    // next beat rather than skipped. This fight is the entire event.
    stage: [
      { kind: "cars", type: "rival", count: 1, side: "ahead", spread: 0, atomic: true },
    ],
    // Thinner traffic, and NO ambient hazards at all — every mine on this
    // stretch should be one the rival just dropped in front of the player
    // (that is the first half of `duel`), not one the road happened to lay
    // there. Some traffic stays: the rival's pursuit is more interesting when
    // there is something to weave through, and an empty road would make this
    // read as the boss rather than as the warm-up for one.
    density: { cars: 0.3, hazards: 0 },
  },

  {
    // THE AIRSTRIKE — the road's first encounter that does not happen ON the
    // road. One gunship (cartypes.js's `airborne`) holds station over the
    // player, sweeps across the whole frame and shoots down at them, and the
    // only thing that can shoot back is the ROCKET.
    //
    // WHY IT IS A ROLLED ENTRY AND NOT A MILESTONE. It is not a set-piece; it is
    // a NEW RULE, and a rule has to be met more than once to be learned. A
    // one-shot at some distance would teach the player that their cannon does
    // nothing to it exactly once, at a moment they would remember as a bug. Met
    // every few minutes, it becomes the reason to keep rockets in the magazine.
    //
    // WHY 800, AND IT IS THE MOST IMPORTANT NUMBER HERE. This entry stages a
    // type whose own gate is 0 (`staged` holds it back instead), so the rule at
    // the top of this file — a gate at least as late as everything it stages —
    // binds on nothing. The gate that actually matters is on the WEAPON, and it
    // is not a rule this file had yet: an encounter that can only be answered by
    // one weapon must not come up before the player can HAVE that weapon.
    //
    // The rocket starts every run empty (weapons.js's `startAmmo: 0`) and has
    // exactly two sources: the shop, first reachable at SHOP_INTERVAL 350, and
    // the ROCKET+ crate, which is gated at 800 (pickuptypes.js). The crate's is
    // the later of the two and so the binding one — `minDistance` below must
    // never fall under it, which test/events.test.js pins. Earlier than that and
    // a broke player meets an enemy they simply cannot fight.
    //
    // ONE, AND NO ESCORT, unlike every other staged encounter here. The whole
    // content of this one is a rule the player has not met before — up is a
    // place things can be, and your default gun does not reach it. Anything on
    // the tarmac alongside it would be the thing they shot at, and they would
    // learn nothing.
    id: "airstrike",
    label: "AIR CONTACT — ABOVE",
    // THE HEAVIEST WEIGHT IN THE CATALOGUE, past the gang's 3, and it is a
    // frequency TARGET rather than a rarity: two to three airstrikes per 1000
    // DIST, which is one about every minute at the player's ceiling.
    //
    // MEASURED, NOT PICKED, and the measurement is the only reason this is 6.
    // The director fires a roughly fixed ~7.75 rolled encounters per 1000 DIST
    // whatever the weights are — that rate is EVENT_CHANCE and EVENT_GAP in
    // events.js, not this figure — so a weight here only decides what SHARE of
    // them this is. Over 70 simulated runs to DIST 4000, airstrikes per 1000:
    //
    //     weight 5     1.81  2.24  2.17     overall 2.08
    //     weight 6     1.96  2.67  2.87     overall 2.50   <- this
    //     weight 7     2.41  2.77  2.99     overall 2.74
    //
    // THE RATE RISES WITH DISTANCE rather than falling, which is the opposite of
    // what the share arithmetic predicts and the thing to know before retuning:
    // the band just past the gate starts empty by definition, and DIST 1000-1200
    // is also where roadworks, slalom and minefield all open, so the early road
    // is busier with entries and one-shots than the weights alone suggest.
    //
    // IT IS TAKEN FROM EVERY OTHER ENTRY, and that is the cost worth stating out
    // loud: one encounter runs at a time, so a third of the road's encounters
    // being this one means a third fewer gangs, blockades and narrowings. That
    // is the intended trade — the air is the newest thing the road does — but it
    // IS a trade, and this is the first figure to revisit if the ground starts
    // feeling empty.
    weight: 6,
    // A THOUSAND, and this is a RHYTHM decision rather than the safety one
    // above. The gate that must hold is the rocket's; this sits 200 past it, so
    // the player has met the ROCKET+ crate and had two shop visits before the
    // road starts asking them to have used either.
    minDistance: 1000,
    maxDistance: Infinity,
    cooldown: 60, // longer than the gang's 40: a bigger interruption
    // ROOM FOR FOUR ROCKETS, with a wide margin. `duration` is ROAD, so 80 units
    // is ~13 seconds at the player's ceiling and considerably more at any speed
    // somebody is actually aiming from. The rocket reloads in 0.35s, so the
    // window holds well over thirty launches against a hull that needs four —
    // the constraint this fight is really about is whether the player BROUGHT
    // any, not whether they had time to fire them.
    duration: 80,
    // AND IT LEAVES ANNOUNCED. A player who had no rockets watched something
    // circle them for thirteen seconds and then vanish; without a line in the
    // log that reads as the game losing track of it. Same reasoning the siege
    // battery's own exit carries.
    exitLabel: "AIR CONTACT BREAKING OFF",
    // THINNED, BOTH, and not emptied. The player has to keep driving a road
    // they are no longer looking at, which is most of what makes this different
    // from every other fight — but a full ambient road under a fight happening
    // above it is asking them to read two things at once and dodge both.
    density: { cars: 0.5, hazards: 0.5 },
    stage: [
      // `atomic`: no gunship, no encounter, and the roll is not spent. There is
      // nothing else in this entry for it to be an escort to.
      { kind: "cars", type: "gunship", count: 1, side: "ahead", spread: 0, atomic: true },
    ],
  },

  {
    // THE BOSS. The set-piece `warband` was rehearsing for — a one-shot
    // milestone, an atomic lead, and both ambient budgets at zero, all of them
    // paths this catalogue was already shipping before there was a boss to use
    // them on.
    //
    // WHY 1200. Past the rival's 1000 by two hundred, so the mini-boss is
    // genuinely the warm-up and the player meets the real thing having already
    // learned that a single named car can be a fight. It also lands on the
    // caltrop's own gate, which is why `hazards: 0` below is doing real work:
    // this is the exact stretch where mines start appearing on the ambient
    // road, and a boss fight is not where the player should meet their first
    // one.
    //
    // See src/testoptions.js's EVENT_AT_OVERRIDES for pulling this forward
    // while testing. The number here is the SHIPPING one and stays that way —
    // the override lives in the test-build file so the catalogue never has to
    // be edited (and un-edited) to reach the fight, and so the invariant in
    // test/events.test.js keeps checking the road that actually ships.
    id: "siege",
    label: "SIEGE BATTERY — ROAD AHEAD",
    at: 1200,
    once: true,
    cooldown: 0,
    // FAR LONGER THAN THE RIVAL'S 120, and it is a backstop rather than a plan.
    // `duration` is ROAD, not time (see the field docs above), so 300 units is
    // about forty-eight seconds at the player's ceiling and a great deal more
    // at a crawl. Killing the battery ends the encounter sooner than the clock
    // ever will, which is the shape this fight wants: the fast way out is
    // through.
    //
    // SIZED OFF THE SLOWEST GUN, not the fastest, because the player's loadout
    // is not fixed and the spread is wide. Against 3200 hull at a third of
    // perfect uptime, which is about what dodging a barrage leaves:
    //
    //   rocket   280 dps   ~33s
    //   cannon   256 dps   ~36s
    //   tracker  185 dps   ~49s   (its rounds seek, so real uptime is higher)
    //
    // 350 units is ~56 seconds at the player's ceiling and considerably more at
    // any speed somebody is actually fighting at, so it clears even the tracker.
    // BETTER GUNS ONLY MAKE THE FIGHT END SOONER. This backstop is there so a
    // player who cannot win is not trapped, and it must never be the thing that
    // ends a fight somebody IS winning — hence the worst case, not the typical
    // one. It moves with the hull; change one and redo this arithmetic.
    //
    // AND IT ENDS AS A DECISION, not as a fadeout. The rival's entry already
    // named this as the wart — an encounter that times out mid-fight "would
    // just quietly hand the road back" — so when this one expires the battery
    // withdraws and says so (events.js announces it). That is the one thing
    // here that is not simply borrowed from `warband`.
    duration: 350,
    exitLabel: "SIEGE BATTERY DISENGAGING",
    // THE ROAD CLEARS, both budgets, the same as `warband`. A boss competing
    // with ambient traffic for the player's attention is a boss nobody notices,
    // and the barrage needs empty tarmac to read against — a shell mark landing
    // among four cars and a barrel is not a warning, it is noise.
    density: { cars: 0, hazards: 0 },
    // AHEAD, which is where a road block belongs and what the encounter's own
    // label promises. It is also the side that made events.js's staging honest:
    // a car staged ahead used to land 1500 units up the road, well past
    // traffic.js's retire margin, and was dropped on the tick it appeared —
    // `warband` had been quietly staging nothing at all since it was written.
    // See planStage's own note, and arrivalSpeed for the other half (a 730
    // mortar arriving at the player's pace, so it settles into station instead
    // of braking its way off the top of the screen).
    stage: [
      // `atomic`: no battery, no encounter, and the milestone goes unspent so it
      // comes round again on the next beat. Everything in this entry is the
      // mortar; two interceptors on their own would just be traffic.
      { kind: "cars", type: "mortar", count: 1, side: "ahead", spread: 0, atomic: true },
      // THE ESCORT, and it is doing a specific job rather than adding numbers:
      // the mortar itself never shoots at the player (armament.js's
      // BATTERY_KIT), so without these two a player could sit in one lane and
      // trade fire with something that cannot answer. The interceptors are what
      // make standing still cost something, which is what forces the player
      // into the road the shells are landing on.
      //
      // FOUR, RAISED FROM TWO. An interceptor has 70 hull — two cannon rounds —
      // so a pair of them is a speed bump rather than a screen, and the player
      // could clear both and then trade with the battery unopposed, which is
      // the one shape this fight must not collapse into.
      //
      // They TOP OUT AT the player's own ceiling (400-620 against 620) and stay
      // in the fight regardless, because `pursue` chases at the profile's
      // `chaseSpeed` of 600 (behaviours.js) — comfortably under the type's own
      // 620 ceiling, so traffic.js's clamp never touches this pair; the figure
      // that actually governs the chase is the profile's, not the catalogue's
      // — 20 units a second of slip against a player holding full throttle,
      // which is half a minute of pursuit and longer than the fight. A player
      // who slows down to shoot straight keeps them indefinitely. The band was
      // widened from a 470 ceiling for the sake of a BOOSTED player, whose speed
      // pickups run well past 620 and would otherwise leave a stock interceptor
      // no way to ever close.
      //
      // TWO AHEAD AND TWO BEHIND, and the split is forced by the road before it
      // is anything else. The budget for a formation staged ahead is the gap
      // between the spawn margin and the retire margin (planStage), which is
      // 140 units — and four interceptors packed into that, plus a 90-long
      // battery, is five cars trying to sit abreast in four lanes. Measured:
      // the fourth was refused every single time, so `count: 4` quietly meant
      // three.
      //
      // Behind there is as much road as anyone wants, and `pursue` is written
      // for exactly that approach. So the escort becomes a PINCER, which is the
      // better fight anyway: the battery shells the road in front of the player
      // while two rockets close from the mirror, and the lane the player picks
      // to dodge a shell is one they have to pick while being chased into it.
      //
      // Their own speed is no objection to either side. They cruise 400-620, at
      // or under the player's own ceiling — which is what puts a pair of them
      // ahead by traffic.js's spawn rule — and `pursue` chases at the profile's
      // `chaseSpeed` of 600 (behaviours.js), under the type's own 620 ceiling so
      // traffic.js's clamp never bites, so the two behind slip only 20 units a
      // second against a player at full throttle and stay in the fight for
      // longer than the fight lasts.
      { kind: "cars", type: "interceptor", count: 2, side: "ahead", spread: 300 },
      { kind: "cars", type: "interceptor", count: 2, side: "behind", spread: 300 },
    ],
  },

  {
    // THE SHOPPING INTERLUDE. `every: SHOP_INTERVAL` is the whole of what moved
    // out of hauler.js — its `milestone` counter and crossedMilestone(). The
    // number is still that file's feel dial and is imported, not restated.
    //
    // WHAT THIS BUYS: the pickup can no longer land on top of a set-piece. It
    // used to fire blind, and DIST 400/800 sit close enough to the milestone
    // above that a slow fight would meet one. Milestones DEFER, never cancel
    // (events.js), so a visit is only ever late — which matters more here than
    // for any other entry, since a skipped shop visit is a lost upgrade.
    id: "shop",
    label: null, // the drone announces itself, in its own voice (hauler.js)
    every: SHOP_INTERVAL,
    cooldown: 0,
    density: { cars: 0, hazards: 0 },
    stage: [{ kind: "handoff", handler: "shop" }],
  },
];

// THE FOCUS SWITCH, the same testing aid cartypes.js carries and for the same
// reason: tuning one encounter means watching it, and a director rolling the
// whole catalogue gives you the one you care about every few minutes. List the
// ids you are working on and only those are eligible; an EMPTY list is the
// shipping catalogue. Ship it empty.
//
//   export const FOCUS = ["gang"];
//
// Implemented as an override on the SAME gate the game ships with (see
// eventAvailable below), never as a filter of its own — a focused road must
// still be a road the real director built.
//
// Exported so the suite can say so out loud: a focused catalogue breaks the
// gating invariants in test/events.test.js, and "gang never fired" is a much
// worse error message than "FOCUS is still set".
export const FOCUS = [];

// Whether a ROLLED entry may come up at `dist` (DIST-readout units), given the
// road covered since it last fired. Mirrors cartypes.js's typeAvailable and
// obstacletypes.js's obstacleAvailable — one predicate per catalogue, handed to
// weightedpick.js's pickWeighted, which owns the draw itself.
//
// Milestone entries are never eligible here: `at`/`every` are checked by the
// director before it rolls at all, and an entry with a milestone has no
// `weight` to be drawn on.
export function eventAvailable(type, dist, lastFiredAt = -Infinity) {
  if (!type.weight) return false;
  if (FOCUS.length) return FOCUS.includes(type.id);
  if (dist < gateFor(type)) return false;
  if (dist > (type.maxDistance ?? Infinity)) return false;
  return dist - lastFiredAt >= (type.cooldown ?? 0);
}

// Where a ROLLED entry actually unlocks. The catalogue's own `minDistance`
// unless this is a test build with an override for that id — the same split,
// for the same reasons, that events.js's milestoneAt() makes for a one-shot.
// See src/testoptions.js's EVENT_GATE_OVERRIDES. Guarded by the same master
// switch every other cheat is, so a shipping build reads the catalogue and
// nothing else whatever the override object happens to still contain.
function gateFor(type) {
  if (!SHOW_TEST_OPTIONS) return type.minDistance;
  return EVENT_GATE_OVERRIDES[type.id] ?? type.minDistance;
}

// By id, for the tests and for anything that wants to talk about one entry
// without walking the list. Same shape as carTypeById/obstacleTypeById.
export function eventTypeById(id) {
  return EVENT_TYPES.find((t) => t.id === id) ?? null;
}

