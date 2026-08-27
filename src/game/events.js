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
import { SPAWN_MARGIN as TRAFFIC_SPAWN_MARGIN } from "./traffic.js";
import { SPAWN_MARGIN as HAZARD_SPAWN_MARGIN } from "./obstacles.js";
import { DIST_UNITS, LANE_COUNT, ROAD_HALF_WIDTH } from "./road.js";
import { announceCityLine } from "./links.js";
import { WARN } from "../engine/console.js";
import * as gameConsole from "../engine/console.js";

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
const MAX_STAGED_CARS = 6;
// Sized off the LARGEST field in the catalogue with room over it — the
// minefield asks for four rows of three. Deliberately not tighter: that entry's
// whole claim is that the PASSAGE RULE decides how many mines land, and a
// budget that bit first would silently take the decision off it.
const MAX_STAGED_OBSTACLES = 14;

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
function dueMilestone(dist) {
  for (const type of EVENT_TYPES) {
    if (type.at !== undefined) {
      if (dist < type.at) continue;
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
  return !enc.placed.some((body) => body.alive);
}

// --- Firing ------------------------------------------------------------------

function fire(type, world, handlers, clockValue, push, busy, spend) {
  const placed = [];
  let handler = null;

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
      const body = applyRequest(req, world);
      if (body) {
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
// THE FIVE KINDS:
//
//   cars     `count` cars of one type on the named `side`, staggered by
//            `spread` world units. Lanes are walked so a pack spreads across
//            the road instead of forming a queue in one lane
//   abreast  `count` cars of one type at ONE worldY, on adjacent lanes, leaving
//            `gapLanes` lanes open
//   rows     `count` rows of one obstacle type, `spread` apart, hard against
//            BOTH barriers — the road narrowing
//   scatter  `count` rows of `perRow` hazards at random offsets — the minefield
//   handoff  places nothing; see fire() above
export function planStage(spec, world) {
  const { distance, player, H } = world;

  // WHERE A STAGED THING ENTERS, and the two margins are not the same number by
  // accident. Behind, the traffic spawner's own margin: a car arriving in the
  // mirror only has to be off-screen. Ahead, the HAZARD margin, which is much
  // larger and was measured against the slowest-steering car in the catalogue
  // (obstacles.js's SPAWN_MARGIN) — anything placed up the road has to be
  // dodgeable by the traffic already driving towards it, and by the player.
  const ahead = distance + player.y + HAZARD_SPAWN_MARGIN;
  const behind = distance - (H - player.y) - TRAFFIC_SPAWN_MARGIN;

  switch (spec.kind) {
    case "cars": {
      const type = carTypeById(spec.type);
      if (!type) return [];
      const back = spec.side === "behind";
      const origin = back ? behind : ahead;
      const lanes = spreadLanes(spec.count);
      const out = [];
      for (let i = 0; i < spec.count; i++) {
        // Staggered AWAY from the screen, so the pack streams in rather than
        // arriving as a rank: the first of them is at the margin and the rest
        // are further out still.
        const worldY = back ? origin - i * spec.spread : origin + i * spec.spread;
        out.push({ kind: "car", type, worldY, lane: lanes[i], speed: rollSpeed(type) });
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
      const out = [];
      for (let i = 0; i < count; i++) {
        const lane = fromLeft ? i : LANE_COUNT - 1 - i;
        out.push({ kind: "car", type, worldY: ahead, lane, speed: rollSpeed(type) });
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
      for (let row = 0; row < spec.count; row++) {
        const worldY = ahead + row * spec.spread;
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
      for (let i = 0; i < spec.count; i++) {
        const worldY = ahead + i * spec.spread;
        out.push({ kind: "obstacle", type, worldY, offset: -limit });
        out.push({ kind: "obstacle", type, worldY, offset: limit });
      }
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
    return world.traffic.place(req.type, req.worldY, req.lane, req.speed, true);
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
  return type.speedMin + Math.random() * (type.speedMax - type.speedMin);
}

// Distinct lanes for a pack, starting somewhere random so a gang doesn't always
// form up on the left, wrapping once there are more cars than lanes.
function spreadLanes(count) {
  const start = Math.floor(Math.random() * LANE_COUNT);
  const out = [];
  for (let i = 0; i < count; i++) out.push((start + i) % LANE_COUNT);
  return out;
}
