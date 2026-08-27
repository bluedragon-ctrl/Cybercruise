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
    // THE ROADBLOCK. Rigs abreast, one lane deliberately left open — see
    // events.js's `abreast` for why that gap is a rule and not a decoration.
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
      // They are SLOWER than the player (400-470 against 620) and stay in the
      // fight anyway, because `pursue` chases at the profile's `chaseSpeed` of
      // 600 rather than at the type's own ceiling (behaviours.js) — 20 units a
      // second of slip against a player holding full throttle, which is half a
      // minute of pursuit and longer than the fight. A player who slows down to
      // shoot straight keeps them indefinitely.
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
      // Their own speed is no objection to either side. They cruise 400-470,
      // slower than the player — which is what puts a pair of them ahead by
      // traffic.js's spawn rule — but `pursue` chases at the profile's
      // `chaseSpeed` of 600 (behaviours.js), not the type's ceiling, so the two
      // behind slip only 20 units a second against a player at full throttle
      // and stay in the fight for longer than the fight lasts.
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
  if (dist < type.minDistance) return false;
  if (dist > (type.maxDistance ?? Infinity)) return false;
  return dist - lastFiredAt >= (type.cooldown ?? 0);
}

// By id, for the tests and for anything that wants to talk about one entry
// without walking the list. Same shape as carTypeById/obstacleTypeById.
export function eventTypeById(id) {
  return EVENT_TYPES.find((t) => t.id === id) ?? null;
}

