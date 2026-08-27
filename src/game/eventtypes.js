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
    // NO BOSS CAR TYPE YET, on purpose. bossshapes.js holds the finished hulls
    // with no cartypes.js record and says in its own header why they stay out
    // until the boss session. So the lead here is the toughest thing the
    // catalogue actually has (the bruiser), and the day a boss type lands, this
    // entry changes by one string.
    id: "warband",
    label: "HEAVY CONTACT AHEAD",
    at: 700, // past the bruiser's 500 and the interceptor's 450
    once: true,
    cooldown: 0,
    duration: 90,
    // THE ROAD CLEARS. The only entry that takes both budgets to zero: a
    // set-piece competing with ambient traffic for the player's attention is a
    // set-piece nobody notices.
    density: { cars: 0, hazards: 0 },
    stage: [
      // `atomic`: if the lead cannot be placed, the whole encounter is
      // abandoned and the milestone is not spent — it fires on the next beat
      // instead. An escort with nothing to escort is not the event.
      { kind: "cars", type: "bruiser", count: 1, side: "ahead", spread: 0, atomic: true },
      { kind: "cars", type: "interceptor", count: 2, side: "ahead", spread: 300 },
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
    at: 1000, // exactly the rival's own gate (cartypes.js) — the moment the
              // road unlocks it is the moment it arrives
    once: true,
    cooldown: 0,
    // LONG, because this one is meant to take a while. 400 hull at the
    // player's own top speed is not a fight that resolves in a few seconds,
    // and an encounter that timed out while the rival was still healthy would
    // just quietly hand the road back mid-duel.
    duration: 120,
    // BEHIND, and that follows from the car rather than from taste: the rival
    // is faster than the player, and traffic.js's own spawner puts anything
    // faster behind for exactly this reason — a fast car placed ahead simply
    // vanishes over the horizon. It also gives `duel` the approach it is
    // written around.
    //
    // `atomic` even though there is only one of it: a rival that could not be
    // placed leaves the milestone unspent, so the meeting is deferred to the
    // next beat rather than skipped. This fight is the entire event.
    stage: [
      { kind: "cars", type: "rival", count: 1, side: "behind", spread: 0, atomic: true },
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

