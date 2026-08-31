// SPECIAL EVENTS — the director. When something staged happens, and what it
// asks for. The catalogue it reads is game/eventtypes.js; read that file's
// header first for WHY a gang, a blockade, a narrowing, a boss and the shop
// drone are all one list.
//
// THIS FILE PLACES NOTHING ITSELF. It builds requests and hands them to
// Traffic.place() and Obstacles.place(), which are the same entry points those
// files' own ambient spawners go through. That is the load-bearing decision
// here: a director pushing into `traffic.cars` directly would be the one thing
// on the road that had skipped the clearance tests, the passage rule and the
// road clamp — and it would be the only thing capable of sealing the highway.
// Everything below inherits obstacles.js's fairness rules rather than escaping
// them, which is exactly why "narrow the road" is a safe feature to add at all.
//
// DISTANCE, NOT TIME, drives every decision here — the roll beat, the
// milestones, the cooldowns and the durations are all in road covered. Same
// reasoning cartypes.js gives for ENEMY_MIN_DISTANCE: speed is what asks for the
// trouble. A player dawdling to farm encounters would be a bug; a player flat
// out meeting more of them is the game working.
//
// WHAT MAIN.JS OWNS, as with every other system on this floor: the wiring. The
// director exposes a LEVEL (`active()`), never an edge, so main.js can hang
// audio off a crossing the same way it already does for sectors.glitching().
// And a `handoff` names a HANDLER, not a module — main.js passes the map, so
// this file never learns that a cargo drone exists.

import { pickWeighted } from "./weightedpick.js";
import { EVENT_TYPES, eventAvailable } from "./eventtypes.js";
import { carTypeById } from "./cartypes.js";
import { obstacleTypeById } from "./obstacletypes.js";
import { OBSTACLE_SHAPES } from "./obstacleshapes.js";
import {
  SPAWN_MARGIN as TRAFFIC_SPAWN_MARGIN,
  STAGED_RETIRE_MARGIN,
} from "./traffic.js";
import { SPAWN_MARGIN as HAZARD_SPAWN_MARGIN } from "./obstacles.js";
import { DIST_UNITS, LANE_COUNT, ROAD_HALF_WIDTH } from "./road.js";
import { announceCityLine } from "./links.js";
import { WARN } from "../engine/console.js";
import * as gameConsole from "../engine/console.js";
import { SHOW_TEST_OPTIONS, EVENT_AT_OVERRIDES } from "../testoptions.js";

// How much road passes between rolls. Big enough that the roll is cheap at any
// frame rate (it is one Math.floor per tick and a weighted draw eight times per
// DIST unit of odometer), small enough that a gap between encounters is decided
// by the cooldowns below rather than by the granularity of the beat.
const BEAT = 8 * DIST_UNITS;

// The odds a beat with nothing live and no cooldown running actually fires.
// With EVENT_GAP below this works out at roughly one encounter every 45 DIST of
// road once the catalogue has opened up — often enough to be a rhythm, rare
// enough that arriving is still an event.
const EVENT_CHANCE = 0.18;

// Road covered after ANY encounter before another may start, on top of each
// entry's own `cooldown`. Two encounters back to back read as one long one.
const EVENT_GAP = 25 * DIST_UNITS;

// Staged budgets, kept apart from the ambient ones for the reason traffic.js's
// `staged` and obstacles.js's `laid` both give: pooling them would let one
// feature quietly starve another. Sized so the largest formation in the
// catalogue fits with room to spare, and so a director bug cannot fill the road.
//
// RAISED FROM 6 when `warband` gained its bike wing (seven cars), and FROM 8
// when `swarm` landed: twelve bikes is the largest formation the catalogue has
// ever asked for, and at 8 the last four were refused by this number rather
// than by the road — which is the one thing this budget must never be. It is
// documented as tracking the catalogue's largest formation, so it moves when
// that formation does; the "room to spare" is what keeps it a guard against a
// director bug rather than a second place to tune encounter sizes.
const MAX_STAGED_CARS = 14;
// Sized off the LARGEST field in the catalogue with room over it. Deliberately
// not tighter: the minefield's whole claim is that the PASSAGE RULE decides how
// many of its mines land, and a budget that bit first would silently take that
// decision off it.
//
// RAISED FROM 14 when `chokepoint` landed: two rows of trestles and five rows
// of tank traps is fourteen hazards exactly, so at 14 the budget — not the road
// — was deciding whether the last one went down. This number tracks the
// catalogue's largest field the way MAX_STAGED_CARS tracks its largest
// formation, and it moves when that field does.
const MAX_STAGED_OBSTACLES = 20;

// --- Per-run state -----------------------------------------------------------
//
// The minimum the job needs, in the spirit of sectors.js's own two scalars.
// `milestones` is the counter that used to live in hauler.js as `milestone`;
// it is not a new kind of memory, it just belongs with the other schedules now.
let lastBeat = null;
let cooldownUntil = 0;
let live = null; // { type, endsAt, placed: [], handler }
const milestones = new Map(); // event id -> milestones already spent
const lastFired = new Map(); // ...and when each ROLLED entry last fired, for its
                              // own `cooldown`. Separate because a milestone
                              // entry has no cooldown to serve

// Called from main.js's newGame(), beside sectors.reset(). Restoring the
// densities is NOT this function's job — it has no systems to restore them on —
// which is why apply() below re-asserts them every tick instead. See there.
export function reset() {
  lastBeat = null;
  cooldownUntil = 0;
  live = null;
  milestones.clear();
  lastFired.clear();
}

// The live encounter's id, or null. A LEVEL, not an edge: main.js owns the edge
// (see the header), exactly as it does for sectors.glitching().
export function active() {
  return live ? live.type.id : null;
}

// How many times an entry's milestone has been spent this run — for `shop`,
// which visit this is. The shop screen prints it as "STOP N" and it used to
// read hauler.js's own `milestone` field, which moved here whole; this is the
// same number, asked of the file that now keeps it.
export function milestoneCount(id) {
  return milestones.get(id) ?? 0;
}

// --- The tick ----------------------------------------------------------------
//
// `world` = { distance, player, W, H, traffic, obstacles } — the two SYSTEMS,
// not their lists, since this is the one caller that needs to put things into
// them. `handlers` maps a stage's `handler` name to { fire, live }; see the
// `handoff` kind in planStage().
//
// `clockValue` is scenery.js's floor clock, taken as a parameter rather than
// imported, the same choice sectors.update() and links.announce() make and for
// the same reason: it lets the suite drive the announcer's rate limiter without
// scenery's own "playing"-only cadence running first.
export function update(clockValue, world, handlers = {}, push = gameConsole.push, busy = gameConsole.isBusy) {
  const dist = world.distance / DIST_UNITS;

  if (live) {
    applyDensity(world, live.type.density);
    if (finished(live, world, handlers)) {
      // AN ENCOUNTER THAT TIMED OUT WITH SOMETHING STILL ALIVE SAYS SO. The
      // rival's entry named this as the one rough edge in the scheduler: a
      // fight whose `duration` ran out while the car was still healthy "would
      // just quietly hand the road back", with the pursuit simply evaporating.
      // One line fixes it — the encounter reads as a withdrawal rather than as
      // a fadeout, and the player is told the thing they failed to kill has
      // left rather than being allowed to wonder whether it is still coming.
      //
      // Only when something SURVIVED: an encounter that ended because the
      // player killed everything in it has already announced itself, loudly,
      // in fireballs.
      if (live.type.exitLabel && live.placed.some((body) => body.alive)) {
        announceCityLine(clockValue, live.type.exitLabel, WARN, push, busy);
      }
      live = null;
      cooldownUntil = world.distance + EVENT_GAP;
    }
  }
  if (!live) applyDensity(world, null);

  // MILESTONES FIRST, and they DEFER rather than cancel — a milestone that
  // comes due while something else is live keeps its counter unspent and fires
  // the moment the road clears. That matters far more for the shop visit than
  // for a set-piece: a missed boss is a missed moment, a missed shop visit is a
  // lost upgrade. Deferral is bounded because every rolled encounter carries a
  // `duration`, so the road always clears.
  if (!live) {
    const due = dueMilestone(dist);
    if (due) fire(due.type, world, handlers, clockValue, push, busy, due.spend);
  }

  // ...then the roll, on its own beat.
  const beat = Math.floor(world.distance / BEAT);
  if (lastBeat === null) {
    lastBeat = beat; // first tick after a (re)start: settle in, never fire
    return;
  }
  if (beat === lastBeat) return;
  lastBeat = beat;

  if (live || world.distance < cooldownUntil) return;
  if (Math.random() >= EVENT_CHANCE) return;

  const type = pickWeighted(EVENT_TYPES, (t) =>
    eventAvailable(t, dist, lastFired.get(t.id) ?? -Infinity));
  if (type) fire(type, world, handlers, clockValue, push, busy, null);
}

// The milestone entry due at `dist`, if any, plus the callback that SPENDS it —
// deliberately not spent here, so an `atomic` stage that cannot be placed
// leaves the milestone to come round again on the next beat.
// Where a one-shot milestone actually fires. The catalogue's own `at` unless
// this is a test build with an override for that id — see src/testoptions.js's
// EVENT_AT_OVERRIDES for why the override lives there and not in the catalogue.
// Guarded by the same master switch every other cheat is, so a shipping build
// reads the catalogue and nothing else, whatever the override object happens to
// still contain.
function milestoneAt(type) {
  if (!SHOW_TEST_OPTIONS) return type.at;
  return EVENT_AT_OVERRIDES[type.id] ?? type.at;
}

function dueMilestone(dist) {
  for (const type of EVENT_TYPES) {
    if (type.at !== undefined) {
      if (dist < milestoneAt(type)) continue;
      if (milestones.get(type.id)) continue;
      return { type, spend: () => milestones.set(type.id, 1) };
    }
    if (type.every !== undefined) {
      // hauler.crossedMilestone()'s own arithmetic, moved here whole.
      const reached = Math.floor(dist / type.every);
      if (reached <= (milestones.get(type.id) ?? 0)) continue;
      return { type, spend: () => milestones.set(type.id, reached) };
    }
  }
  return null;
}

// --- Density -----------------------------------------------------------------
//
// RE-ASSERTED EVERY TICK rather than set once on the edges, and that is worth a
// line: main.js's respawnWorld() throws away the Traffic and the Obstacles
// wholesale on every shop visit, so a multiplier written once onto the old
// objects would be silently lost. One assignment per tick costs nothing and is
// immune to the rebuild — and it also means reset() has nothing to undo.
function applyDensity(world, density) {
  world.traffic?.setDensity(density?.cars ?? 1);
  world.obstacles?.setDensity(density?.hazards ?? 1);
}

// --- Lifecycle ---------------------------------------------------------------

// Has this encounter run its course? A handoff ends when its handler says so
// and is given no `duration` at all — a shop visit lasts as long as the player
// spends shopping, and no road passes while the world is frozen. Everything
// else ends when the last thing it staged is dead or gone, or when the player
// has simply driven past it.
function finished(enc, world, handlers) {
  if (enc.handler) return !handlers[enc.handler]?.live?.();
  if (world.distance >= enc.endsAt) return true;
  return !enc.placed.some((body) => stillOnRoad(body, world));
}

// Is this staged body still a thing on the road at all?
//
// `alive` ALONE IS NOT ENOUGH, and the gap is easy to miss: Traffic.retire()
// and Obstacles.retire() drop a body by FILTERING IT OUT OF THE LIST, without
// touching `alive` — nothing else in the game cares, because nothing else holds
// a reference to a car after the road has finished with it. An encounter does.
//
// So an encounter whose cars simply drove off the top of the screen used to stay
// "live" until its `duration` ran out, holding the ambient density at whatever
// it had set — which for a set-piece means a road that stays EMPTY, for tens of
// seconds, with nothing on it to explain why. It is a quiet failure, and it gets
// louder the longer an encounter's duration is: the boss's is the longest in the
// catalogue.
//
// This also makes the boss's one intended escape resolve cleanly. A player who
// takes twelve seconds of overdrive (pickuptypes.js) genuinely outruns the
// battery; the battery falls behind, is retired like any other car, and the
// encounter ends there rather than leaving a dead road behind a fight that is
// over. They keep their escape and lose the payout, which is the trade.
function stillOnRoad(body, world) {
  if (!body.alive) return false;
  return world.traffic?.cars.includes(body) || world.obstacles?.list.includes(body);
}

// --- Firing ------------------------------------------------------------------

function fire(type, world, handlers, clockValue, push, busy, spend) {
  const placed = [];
  let handler = null;
  // Lanes this encounter has filled at each worldY — see THE OPEN LANE below.
  const ranks = new Map();

  for (const spec of type.stage ?? []) {
    if (spec.kind === "handoff") {
      // The director does not import the module, does not know what it does and
      // cannot draw it. It only knows when to say go, and how to ask whether it
      // is still going. main.js supplies both — see this file's header.
      const h = handlers[spec.handler];
      if (!h) return; // nothing wired for it: not this file's business to guess
      h.fire();
      handler = spec.handler;
      continue;
    }

    const requests = planStage(spec, world);
    let landed = 0;
    for (const req of requests) {
      // THE OPEN LANE — `abreast`'s guarantee generalised. That kind clamps its
      // own count because obstacles.js's passage rule guards HAZARDS and knows
      // nothing about cars, so a rank of them is the one formation that can wall
      // the road. Its clamp saw a single spec, which sufficed while a rank could
      // only come from one; `lead` and the staged margin make multi-rank,
      // multi-type formations authorable, and four one-car specs at the same
      // worldY build exactly that wall.
      //
      // COUNTED WHERE THE CARS LAND, not in the plan: planStage is pure and
      // picks lanes without knowing what is on the road, and applyRequest's
      // freeLane fallback may put a car somewhere else. A rank is judged by the
      // lane the car ended up in.
      if (req.kind === "car" && (ranks.get(req.worldY)?.size ?? 0) >= LANE_COUNT - 1) continue;
      const body = applyRequest(req, world);
      if (body) {
        if (req.kind === "car") {
          const taken = ranks.get(req.worldY) ?? new Set();
          taken.add(body.lane);
          ranks.set(req.worldY, taken);
        }
        placed.push(body);
        landed++;
      }
    }

    // ATOMIC: the lead of a set-piece. If it could not be placed, abandon the
    // whole encounter and leave the milestone unspent, so it comes round again
    // on the next beat instead of being quietly lost. Everything else is
    // BEST-EFFORT — three of five cycles on a busy road is a smaller gang, not
    // a failed one.
    if (spec.atomic && landed === 0) {
      // Anything already down is LIFTED BACK OFF the road, not killed. Zeroing
      // `alive` would hand it to Traffic/Obstacles' own detonate() sweep next
      // tick, so abandoning an encounter would light off an escort the player
      // never saw arrive. Nothing has been simulated or drawn yet — this runs
      // before either system's update() — so removing the entries is clean.
      world.traffic.cars = world.traffic.cars.filter((c) => !placed.includes(c));
      world.obstacles.list = world.obstacles.list.filter((o) => !placed.includes(o));
      return;
    }
  }

  if (!handler && !placed.length) return; // the road had no room for any of it

  if (spend) spend();
  lastFired.set(type.id, world.distance / DIST_UNITS);
  live = {
    type,
    handler,
    placed,
    endsAt: world.distance + (type.duration ?? 0) * DIST_UNITS,
  };

  // Through links.js's shared announcer, not gameConsole.push() directly — a
  // gang sighting has to respect the SAME "how often can the city talk" budget
  // a node ping and a sector crossing already do, or three chatty systems
  // between them triple the log's real rate. A null label is an encounter that
  // announces itself in its own voice (the cargo drone).
  if (type.label) announceCityLine(clockValue, type.label, WARN, push, busy);
}

// --- Stages ------------------------------------------------------------------
//
// A stage spec is declarative; this turns one into a list of placement
// requests. Everything here is a PURE function of the spec and a world
// snapshot, which is what lets the suite assert the formations without a canvas
// (see test/events.test.js).
//
// THE SEVEN KINDS:
//
//   cars     `count` cars of one type on the named `side`, staggered by
//            `spread` world units. Lanes are walked so a pack spreads across
//            the road instead of forming a queue in one lane
//   abreast  `count` cars of one type at ONE worldY, on adjacent lanes, leaving
//            `gapLanes` lanes open
//   rows     `count` rows of one obstacle type, `spread` apart, hard against
//            BOTH barriers — the road narrowing
//   flank    a SEQUENCE of hazard types down ONE side, `spread` apart, in the
//            order the player meets them — a coned-off worksite
//   slalom   `gates` half-road blocks, `perGate` deep from ONE barrier and
//            alternating sides down the stretch — the weave
//   scatter  `count` rows of `perRow` hazards at random offsets — the minefield
//   handoff  places nothing; see fire() above
//
// `lead` — WORLD UNITS BEFORE THE FIRST ROW OR RANK, honoured by every kind
// that places something and zero unless a spec says otherwise. It is what lets
// ONE encounter stage things IN SEQUENCE rather than on top of itself: every
// kind starts at the same margin, so `chokepoint`'s tank traps would otherwise
// be laid across the trestles that are there to warn about them, and `swarm`'s
// second rank of bikes across its first. For cars it spends the same ahead
// budget the formation's own `spread` does — see aheadRoom.
// Room left between the last car of a staged formation and the retire boundary.
// See aheadRoom in planStage.
const AHEAD_SLACK = 60;

// Daylight between two hazards stacked inward from the same barrier by
// `slalom`. Small — the gate should read as one block, not as two objects that
// happen to be near each other — but never zero: see the note in that kind.
const GATE_CLEARANCE = 2;

// How much faster than the player a car staged BEHIND arrives, so that it is
// actually gaining rather than merely keeping up. Small: this decides how long
// the approach takes, and an arrival that closes 424 units of road in a few
// seconds is a car coming up in the mirror, where twice that would be a car
// teleporting into frame. See arrivalSpeed.
const CLOSING_MARGIN = 20;

export function planStage(spec, world) {
  const { distance, player, H } = world;

  // WHERE A STAGED THING ENTERS, and the margins differ by WHAT is entering
  // rather than by which end it comes in at.
  //
  //   BEHIND        the traffic spawner's own margin. A car arriving in the
  //                 mirror only has to be off-screen.
  //   A HAZARD AHEAD  the much larger obstacles.js margin, measured against the
  //                 slowest-steering car in the catalogue: anything STATIC
  //                 placed up the road has to be dodgeable by the traffic
  //                 already driving towards it, and by the player.
  //   A CAR AHEAD   the traffic margin again, and this is the one that was
  //                 wrong. A car staged at the hazard margin lands 1500 units
  //                 up the road — far outside traffic.js's RETIRE_MARGIN of
  //                 320 — so Traffic.retire() dropped it on the very tick it
  //                 was placed, every time. `warband` had been staging a
  //                 bruiser and two interceptors into that hole since it was
  //                 written: the encounter fired, announced itself, took the
  //                 ambient road to zero density and then put nothing on it.
  //                 A car is not a hazard; it drives, it is dodged by being
  //                 driven around, and it enters where every other car enters.
  const aheadCar = distance + player.y + TRAFFIC_SPAWN_MARGIN;
  // Road between where a car staged ahead APPEARS and where Traffic would drop
  // it — the whole budget a formation up the road has to fit inside.
  //
  // MEASURED AGAINST STAGED_RETIRE_MARGIN, which is what made multi-rank
  // formations possible. Against the ambient 320 this was 140 units — under the
  // 216 a second rank of bikes costs — so every encounter in the catalogue was a
  // ONE-RANK encounter and a fifth car ahead was refused however it was asked
  // for. The staged boundary is 620, so this is 440: three ranks of bikes, or
  // two of anything. traffic.js has the arithmetic.
  //
  // SHORT OF THE BOUNDARY, not on it. retire() is a strict comparison, so a car
  // landing exactly on the margin is dropped the moment it edges a pixel further
  // out — which for anything staged ahead of a player it is faster than is the
  // very next tick. The slack is a car length or so: enough that the last of a
  // pack arrives with road to spare rather than on a knife edge.
  const aheadRoom = STAGED_RETIRE_MARGIN - TRAFFIC_SPAWN_MARGIN - AHEAD_SLACK;
  const ahead = distance + player.y + HAZARD_SPAWN_MARGIN;
  const behind = distance - (H - player.y) - TRAFFIC_SPAWN_MARGIN;

  switch (spec.kind) {
    case "cars": {
      const type = carTypeById(spec.type);
      if (!type) return [];
      const back = spec.side === "behind";
      // `lead` pushes the formation AWAY from the screen, which is what makes a
      // second rank of a DIFFERENT type authorable: every spec starts at the
      // same margin, so two ranks would otherwise be laid on top of each other
      // and the second refused, lane by lane, by traffic.js's laneClear. One
      // spec staggers itself through `spread`; two specs need this.
      const lead = spec.lead ?? 0;
      const origin = back ? behind - lead : aheadCar + lead;
      const lanes = spreadLanes(spec.count);
      const out = [];
      // HOW FAR THE PACK MAY STRING OUT. Behind, as far as it likes: the road
      // in the mirror runs off to the horizon and a car back there is being
      // caught up with anyway. Ahead, the formation has to FIT — everything
      // past traffic.js's RETIRE_MARGIN is dropped on the tick it is placed, so
      // a two-car escort at a spread of 300 keeps its leader and silently loses
      // the one behind it. Clamped rather than refused, because a slightly
      // tighter escort is the encounter and a missing one is not.
      const step = back
        ? spec.spread
        : Math.min(spec.spread, Math.max(0, aheadRoom - lead) / Math.max(1, spec.count - 1));
      for (let i = 0; i < spec.count; i++) {
        // Staggered AWAY from the screen, so the pack streams in rather than
        // arriving as a rank: the first of them is at the margin and the rest
        // are further out still.
        const worldY = back ? origin - i * step : origin + i * step;
        out.push({
          kind: "car", type, worldY, lane: lanes[i],
          speed: arrivalSpeed(type, back, player),
        });
      }
      return out;
    }

    case "abreast": {
      const type = carTypeById(spec.type);
      if (!type) return [];
      // A CAR WALL ALWAYS LEAVES A LANE, and this is a rule rather than a
      // decoration. obstacles.js's passage rule guards the hazards; it knows
      // nothing about cars, so a rank of rigs is the one formation in the
      // catalogue that could build a wall with no way through. `gapLanes` is
      // the equivalent guarantee, and the count is clamped here rather than
      // trusted from the catalogue so a mis-authored entry cannot seal the road.
      const gap = Math.max(1, spec.gapLanes ?? 1);
      const count = Math.min(spec.count, LANE_COUNT - gap);
      // The open lane(s) are chosen at one end or the other rather than in the
      // middle, so the way through is a committed line, not a threading.
      const fromLeft = Math.random() < 0.5;
      // `lead` STACKS RANKS, the same as every other kind (see the field docs
      // above) — added here so `blockade` can wall the road twice rather than
      // once. It was missing until a second rank needed it: a single spec never
      // exercised the gap, and nothing caught the omission.
      const worldY = aheadCar + (spec.lead ?? 0);
      const out = [];
      for (let i = 0; i < count; i++) {
        const lane = fromLeft ? i : LANE_COUNT - 1 - i;
        // `aheadCar`, NOT `ahead`, and this was a live bug: a wall of rigs was
        // staged at the HAZARD margin, 1500 units up the road, so
        // Traffic.retire() dropped all three on the tick they were placed —
        // `blockade` fired, announced "CONVOY BLOCKING ROAD", held the ambient
        // road down for its whole duration and put NOTHING on it. The identical
        // hole the `cars` kind's note above describes; `abreast` was written
        // beside it and never converted. Pinned in test/events.test.js.
        out.push({ kind: "car", type, worldY, lane, speed: rollSpeed(type) });
      }
      return out;
    }

    case "scatter": {
      // THE MINEFIELD. `count` rows, `perRow` hazards in each, every one at its
      // own random lateral offset — which is the mine's OWN placement rule
      // (obstacletypes.js's PLACE_ANY: "nobody laid it out for the player's
      // benefit, and being off the lane grid is precisely what makes it read as
      // a mine"), applied to a whole stretch instead of to one hazard.
      //
      // A FOURTH KIND RATHER THAN A FLAG ON `rows`, and the difference is real:
      // `rows` names its offsets (both barriers, mirrored) and is furniture
      // somebody placed; this names none of them and is a field somebody
      // sowed. Folding them together would mean one kind with a mode switch
      // and two unrelated meanings.
      //
      // NOTHING HERE CHECKS ANYTHING. Every request goes through
      // Obstacles.place(), so the passage rule decides how many of each row
      // actually land — see the catalogue entry for why that is the point
      // rather than a compromise.
      const type = obstacleTypeById(spec.type);
      if (!type) return [];
      const w = OBSTACLE_SHAPES[type.shape].size[0];
      const limit = ROAD_HALF_WIDTH - w / 2;
      const out = [];
      const start = ahead + (spec.lead ?? 0);
      for (let row = 0; row < spec.count; row++) {
        const worldY = start + row * spec.spread;
        for (let i = 0; i < (spec.perRow ?? 1); i++) {
          out.push({
            kind: "obstacle", type, worldY,
            offset: (Math.random() * 2 - 1) * limit,
          });
        }
      }
      return out;
    }

    case "rows": {
      const type = obstacleTypeById(spec.type);
      if (!type) return [];
      const w = OBSTACLE_SHAPES[type.shape].size[0];
      // Hard against each barrier — the furthest out a box of this width can
      // sit with its whole span still on the tarmac, the same limit
      // obstacles.js's placementOffsets uses for PLACE_SIDE.
      const limit = ROAD_HALF_WIDTH - w / 2;
      const out = [];
      const start = ahead + (spec.lead ?? 0);
      for (let i = 0; i < spec.count; i++) {
        const worldY = start + i * spec.spread;
        out.push({ kind: "obstacle", type, worldY, offset: -limit });
        out.push({ kind: "obstacle", type, worldY, offset: limit });
      }
      return out;
    }

    case "slalom": {
      // THE WEAVE. `gates` half-road blocks down the stretch, each `perGate`
      // hazards deep from ONE barrier inward, with the side ALTERNATING — so
      // the way through swaps halves at every gate and the player crosses the
      // whole width between them.
      //
      // ITS OWN KIND, on the rule `scatter` and `flank` were argued from:
      // `rows` is symmetrical and leaves the middle open, `flank` is one side
      // and one sequence, and this closes the middle with the open road against
      // a barrier that keeps changing sides.
      //
      // IT STILL CANNOT SEAL THE ROAD, and nothing here is what makes that
      // true: every gate goes through Obstacles.place(), and the passage rule
      // refuses the block that would close it. Two tetras from one barrier
      // leave 76px against a MIN_PASSAGE of 58, so the rule permits this gate;
      // a third would be refused and the gate stays two deep.
      const type = obstacleTypeById(spec.type);
      if (!type) return [];
      const w = OBSTACLE_SHAPES[type.shape].size[0];
      const limit = ROAD_HALF_WIDTH - w / 2;
      // Stacked inward from the barrier, each block clear of the last by
      // GATE_CLEARANCE. Exactly touching is the honest geometry and the wrong
      // call: obstacles.js's spotClear refuses a hazard whose lateral overlap
      // is under half the two widths, so blocks laid exactly one width apart
      // sit ON that comparison and a rounding error decides whether the gate
      // comes out two deep or one.
      const start = ahead + (spec.lead ?? 0);
      const side = Math.random() < 0.5 ? -1 : 1;
      const out = [];
      for (let gate = 0; gate < spec.gates; gate++) {
        const worldY = start + gate * spec.spread;
        // ALTERNATING, from a rolled starting side: the shape is fixed, which
        // half of the road it opens on is not.
        const from = side * (gate % 2 === 0 ? 1 : -1);
        for (let i = 0; i < (spec.perGate ?? 1); i++) {
          out.push({
            kind: "obstacle", type, worldY,
            offset: from * (limit - i * (w + GATE_CLEARANCE)),
          });
        }
      }
      return out;
    }

    case "flank": {
      // ONE SIDE, IN ORDER — a WORKSITE rather than the narrowing `rows`
      // describes: a warning first and the thing being warned about behind it,
      // all against the same barrier, and a sequence of DIFFERENT types for
      // exactly that reason.
      //
      // THE SIDE IS ROLLED, not authored, so the entry stays a decision rather
      // than a memorised line: the player has to read which half of the road is
      // shut before committing to the other one.
      //
      // Each item takes its OWN width against that barrier. A sequence mixes
      // footprints by definition — the catalogue's run 54px to 74px
      // (obstacleshapes.js) — so one shared limit would either float the narrow
      // ones off the edge or hang the wide ones over it.
      const side = Math.random() < 0.5 ? -1 : 1;
      const start = ahead + (spec.lead ?? 0);
      const out = [];
      (spec.types ?? []).forEach((id, i) => {
        const type = obstacleTypeById(id);
        if (!type) return;
        const w = OBSTACLE_SHAPES[type.shape].size[0];
        out.push({
          kind: "obstacle", type,
          worldY: start + i * spec.spread,
          offset: side * (ROAD_HALF_WIDTH - w / 2),
        });
      });
      return out;
    }

    default:
      return [];
  }
}

// One request onto the road, through the systems' own placement path. Returns
// the body placed, or null — a refusal is a normal outcome (see the `atomic`
// note in fire()).
function applyRequest(req, world) {
  if (req.kind === "car") {
    if (stagedCars(world) >= MAX_STAGED_CARS) return null;
    const placed = world.traffic.place(req.type, req.worldY, req.lane, req.speed, true);
    if (placed) return placed;
    // THE LANE WAS TAKEN, SO TRY THE OTHERS — the same fallback the ambient
    // spawner has always had (traffic.js's freeLane), which staging did not.
    //
    // planStage is PURE: it spreads a formation over distinct lanes without
    // knowing what is already on the road, and each `stage` spec draws its lanes
    // independently of the last. So a set-piece reliably lost a car to its own
    // leader — the boss's escort is four interceptors across four lanes, one of
    // which is always the lane the battery itself was just placed in, at the
    // same row. Measured before this: three escorts landed out of four, every
    // single time, and it read as the encounter being tuned that way.
    //
    // A refusal is still a normal outcome once EVERY lane is busy; this only
    // stops the formation colliding with itself.
    const lane = world.traffic.freeLane(req.worldY, req.type.w, req.type.h);
    if (lane === -1) return null;
    return world.traffic.place(req.type, req.worldY, lane, req.speed, true);
  }
  if (world.obstacles.stagedCount() >= MAX_STAGED_OBSTACLES) return null;
  const ok = world.obstacles.place(
    req.type, req.worldY, req.offset, world.traffic.cars, true,
  );
  // place() answers whether it went down; the encounter wants the body itself,
  // to ask later whether it is still alive. It is the last thing on the list.
  return ok ? world.obstacles.list[world.obstacles.list.length - 1] : null;
}

function stagedCars(world) {
  return world.traffic.cars.reduce((n, c) => n + (c.alive && c.staged ? 1 : 0), 0);
}

// The same roll traffic.js's own spawn() makes. Kept here rather than exported
// from there because it is one line and the alternative is a second export that
// exists only for this caller.
function rollSpeed(type) {
  return type.cruiseMin + Math.random() * (type.speedMax - type.cruiseMin);
}

// What a staged car is DRIVING at when it appears.
//
// THE STAGER OWNS THIS BECAUSE IT OVERRODE THE END IT CAME IN AT. traffic.js's
// own spawner derives one from the other — "a car slower than the player is
// placed AHEAD, a faster one BEHIND... a fast one ahead would simply vanish
// over the horizon" — and an encounter that names a side has taken that
// decision away from it. Having done so, it has to answer the consequence.
//
// So: a car staged AHEAD arrives at no more than the player's own speed. It may
// still be a much faster type, and the moment its tactic wants the speed it has
// it (nothing here touches the type's band, only the number it starts at) — but
// it cannot open the gap during the second or two it spends settling, which for
// anything at the top of the catalogue is long enough to cross RETIRE_MARGIN
// and be dropped. The boss is the case that made this necessary: it holds
// station ahead of the player by design (behaviours.js's `siege`) and would
// otherwise brake its way straight off the top of the screen first.
//
// Staged BEHIND, the mirror image of the same problem, and it bit exactly as
// hard: a car placed in the mirror is there to CATCH UP, and one that arrives
// slower than the player never does. The rival is staged 424 units back and its
// band is 580-650 against a player ceiling of 620 — so a roll under 620, which
// is most of its range, produced an encounter that ran its full duration with
// the rival sitting permanently off the bottom of the screen. Measured: it never
// got closer than 476 units back, and the screen edge is at 304. The player was
// told a rival was inbound and then met nothing at all.
//
// So a car staged behind arrives fast enough to close, CAPPED BY ITS OWN
// CEILING. The cap is what keeps this honest: staging may pick where in a type's
// band a car starts, never widen the band. A type whose ceiling is under the
// player's is simply the wrong car to stage behind a player at full throttle,
// and that stays visible instead of being papered over here.
function arrivalSpeed(type, back, player) {
  const rolled = rollSpeed(type);
  // DELIBERATELY ALLOWED UNDER THE TYPE'S OWN FLOOR (cartypes.js's THE TWO
  // SPEED BANDS). This is a starting `speed`, not a `targetSpeed`, and the floor
  // governs the latter — so a type whose floor is over the player's speed
  // arrives matched to them and climbs back to its floor through traffic.js's
  // ACCEL, which IS the settling second this function exists to buy. Clamping to
  // the floor here would give exactly the instant gap-opening the rule below
  // prevents.
  if (!back) return Math.min(rolled, player.speed);

  // ONLY IF THE TYPE CAN ACTUALLY CLOSE, and this guard matters more than the
  // boost does. Clamping every arrival up to the type's ceiling would pin a
  // whole pack to one number — the gang's four outriders would spawn at
  // identical speeds and drive as a locked formation, which is precisely what
  // cartypes.js's speed band and traffic.js's DRIFT exist to prevent. So a type
  // that cannot beat the player's current speed keeps its roll and its spread;
  // an encounter staging one behind a flat-out player has chosen the wrong car,
  // and that stays visible rather than being papered over here.
  const needed = player.speed + CLOSING_MARGIN;
  return type.speedMax >= needed ? Math.max(rolled, needed) : rolled;
}

// Distinct lanes for a pack, starting somewhere random so a gang doesn't always
// form up on the left, wrapping once there are more cars than lanes.
function spreadLanes(count) {
  const start = Math.floor(Math.random() * LANE_COUNT);
  const out = [];
  for (let i = 0; i < count; i++) out.push((start + i) % LANE_COUNT);
  return out;
}
