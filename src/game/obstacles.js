// Road obstacles — the static hazards (roadblocks, mines) that live on the
// road: spawning, placement, triggering, drawing. Same job as traffic.js, for
// a much simpler kind of entity.
//
// STATIC, UNLIKE TRAFFIC. An obstacle never moves once placed — no speed, no
// steering, no behaviour — so it needs none of TrafficCar's integration step.
// It has exactly two things that can happen to it: something hits it, and it
// eventually scrolls far enough behind the player to be dropped. Its `worldY`
// is therefore written once, at spawn, and never touched again.
//
// TWO WAYS ONTO THE ROAD, and they are deliberately different. spawn() places
// road FURNITURE far ahead of the player under placement rules built for
// fairness (a lane is always left open, nothing lands on top of a car). drop()
// lets a hostile car LAY a mine where it is, right now, under none of them. The
// difference is who chose it: furniture is something the game put in the
// player's way and therefore owes them a way through, while a laid mine is an
// enemy's move that the player watched being made and is expected to answer.
//
// ONE PASS, ONE HIT. A roadblock or mine sits at a fixed point on an
// infinitely scrolling road — nothing can double back on the player's minimum
// speed (player.js), so nothing ever gets a second run at the same obstacle.
// That is why a RAM always destroys an obstacle outright regardless of its
// `health`: partial damage surviving a hit you structurally cannot repeat
// would just be a number nobody ever sees move. `health` (obstacletypes.js)
// is spent by GUNFIRE instead, which — unlike a ram — the player can walk
// away from and take again: shooting a hazard out from a safe distance is the
// one situation where "how many hits does this take" is a real question.
//
// THE SHARED EXPLOSION POOL. `explosions` is constructed once in main.js and
// handed to both this class and Traffic — see effects.js's Explosions header:
// "cars, mines and roadblocks share ONE pool rather than getting one each…
// they compete for the same frame budget." A mine going off next to a dying
// car is exactly the moment that pool's cap is meant to bite, so the two
// systems must never each get their own.
//
// BLAST DAMAGE reuses Traffic.blast()'s exact falloff formula (peak at the
// box edge, zero at `blastRadius`) rather than inventing a second one — a
// roadblock's small radius and a mine's wide one are then just two points on
// the SAME curve traffic.js already uses for a car's death, not a parallel
// mechanic with its own rules to keep in sync.
//
// TICK ORDER (see main.js). This runs AFTER shots.update() and BEFORE
// traffic.update(), for the same reason shots run before traffic: an obstacle
// (or car) killed this tick must detonate and, for a car, score in the frame
// it died in rather than a frame late. Concretely: gunfire can already have
// marked an obstacle's health <= 0 by the time update() runs here, and a
// mine's blast here can already have marked a car's health <= 0 by the time
// traffic.update() runs after — both get picked up the same tick they died.

import { drawObstacleCached } from "./sprites.js";
import {
  pickObstacleType,
  PLACE_SIDE,
  PLACE_CENTRE,
  PLACE_ANY,
} from "./obstacletypes.js";
import { OBSTACLE_SHAPES, MINE } from "./obstacleshapes.js";
import { CAR_TYPES } from "./cartypes.js";
import { centerXAt, headingAt, laneOffset, LANE_COUNT, ROAD_HALF_WIDTH } from "./road.js";


// Hazards simulated at once. Sized against SPAWN_MARGIN below rather than
// picked: a hazard is now placed well beyond the traffic field and has to scroll
// all the way back through it, so it lives roughly three times as long as it did
// when it appeared just off the top of the screen. The old cap of 4 was sized
// for that short life and, left alone, became the thing limiting how often the
// player meets an obstacle at all.
const MAX_OBSTACLES = 8;

// ...and, COUNTED SEPARATELY, mines laid on the road by hostile cars (see
// drop()). Two budgets rather than one shared cap, because the two compete for
// nothing and mean opposite things: road furniture is scenery the spawner puts
// out ahead of the player, and a laid mine is something a car just DID to them.
// Sharing one number would let a run of roadblocks quietly disarm every enemy on
// the road, and let a busy firefight starve the road of obstacles — each failure
// looking like a bug in the other system.
const MAX_LAID = 4;

// World units of clear road left between a car's tail and the mine it lays, so
// the dropper is not sitting inside its own mine on the tick it leaves it (the
// contact test below makes no exception for whoever put it there). It only ever
// grows from here — the car is driving away from it.
const DROP_CLEARANCE = 12;
const SPAWN_INTERVAL = 2.2;   // seconds between spawn attempts — rarer than traffic

// HOW FAR AHEAD A HAZARD IS PLACED, and this is not a framing choice — it is
// what makes traffic's avoidance (behaviours.js) possible at all.
//
// A hazard has to appear BEYOND EVERY LIVE CAR, with enough road left over for
// the worst dodger in the catalogue to get out of the way. Traffic is simulated
// out to traffic.js's RETIRE_MARGIN past the player, and the slowest-steering
// type (the rig, at 35px/sec) needs about 1142 units to cross two lanes at
// cruising speed — so anything less than their sum drops hazards into the
// middle of the traffic field, where the cars nearest the spawn point are given
// a few dozen units of warning and cannot possibly use it.
//
// That was measured, not guessed: at the original 140 the road cleared 88% of
// its own hazards before the player ever saw one, and the failures were
// dominated by exactly the type this bound is sized against.
//
// Exported and asserted in test/invariants.test.js, since the relation is
// between three numbers in three different files.
export const SPAWN_MARGIN = 1500; // world units past the player an obstacle appears at
const RETIRE_MARGIN = 220;    // how far behind the player before it's dropped
const DRAW_MARGIN = 140;      // px past the screen edge still worth blitting. Kept
                              // separate from SPAWN_MARGIN: a hazard spawns most of
                              // a screen-height beyond the top edge and would
                              // otherwise be drawn for seconds before it is visible
const SPAWN_GAP = 90;         // min world-units of CLEAR ROAD between two obstacles'
                              // boxes where they overlap laterally, measured edge
                              // to edge — same idea as traffic.js's SPAWN_GAP
// How much road either side of a spawn counts as "the same stretch" when asking
// whether there is still a way through it.
const CLUSTER_WINDOW = 130;

// THE PASSAGE RULE — the one thing a spawn may never do is close the road.
//
// This used to be counted in LANES: a spawn was refused if it would leave every
// lane spoken for. That worked only while every hazard sat on a lane centre, and
// it stopped being true the moment the catalogue gained placements (see
// obstacletypes.js) — a barrels stack flush against the barrier occupies no lane
// squarely, and a tetra on the centre-line occupies two of them badly.
//
// So the question is asked directly instead: after this spawn, is there still a
// CONTINUOUS GAP across the road wide enough to drive through? That is both
// stricter and more honest — four mines on four lane centres leave four 39px
// gaps and pass a lane count while being impassable — and it needs no notion of
// a lane at all, which is what lets a hazard sit anywhere.
//
// Sized against the CATALOGUE rather than picked: the widest car has to fit, or
// the rule guarantees a way through that the rig cannot use. Asserted in
// test/invariants.test.js, since it is a relation between two files.
const WIDEST_CAR = Math.max(...CAR_TYPES.map((t) => t.w));
const PASSAGE_CLEARANCE = 6;  // px of daylight either side, so the gap is drivable
                              // rather than exactly car-shaped
const MIN_PASSAGE = WIDEST_CAR + PASSAGE_CLEARANCE * 2;

// How many random offsets a PLACE_ANY type tries before giving up this interval.
// Small on purpose: failing to find a spot is a perfectly good outcome (the road
// is busy), and retrying forever would just push mines into the gaps the rule
// above is protecting.
const ANY_TRIES = 6;

// Matches the mine pulse formula demo/gallery.js uses for the same shape
// (`0.5 + 0.5 * Math.sin(seconds * 7)`), so the asset gallery and the live
// game blink at the same rate.
const PULSE_RATE = 7;

// One obstacle on the road. Constructed by the spawner below.
class RoadObstacle {
  // NO LANE INDEX. An obstacle is placed by its type's `placement`
  // (obstacletypes.js) and only one of the four modes lands on a lane centre at
  // all, so a `lane` field would be a lie for most of the catalogue — and a lie
  // that reads as truth, since laneAt() answers for any offset. Everything that
  // used to ask "same lane?" now asks whether the two boxes actually overlap
  // laterally, which is the question it meant in the first place.
  constructor(type, worldY, offset) {
    this.type = type;
    this.worldY = worldY; // fixed for life — obstacles do not move
    this.offset = offset;
    this.laid = false; // true when a car put it here rather than the spawner —
                       // see drop() and the two placement budgets above
    this.health = type.health;
    this.alive = true;
    this.exploded = false; // set once its destruction effect has been spawned,
                           // so a kill from two directions in one tick (gunfire
                           // that already zeroed it, then a ram) can't detonate
                           // it twice
    this.pulseTime = 0;
    // Random phase so several live mines don't blink in lockstep — the same
    // reasoning TrafficCar gives its own driftPhase.
    this.pulsePhase = Math.random() * Math.PI * 2;
  }

  // Collision box, read off the shape catalogue (obstacleshapes.js: "`size` is
  // the obstacle's physical FOOTPRINT... what a collision test should use").
  // Not duplicated onto the type the way cartypes.js duplicates a car's w/h,
  // because an obstacle's artwork is authored tight to this exact footprint —
  // there is no independent "collision box" to tune away from it.
  get w() {
    return OBSTACLE_SHAPES[this.type.shape].size[0];
  }

  get h() {
    return OBSTACLE_SHAPES[this.type.shape].size[1];
  }

  // What driving into this costs, in hull. Traffic reads it to decide whether
  // to steer around (behaviours.js compares it against the driver's `nerve`),
  // and it is exposed as a plain body property rather than having behaviours
  // reach into `type.blastDamage` — a later hazard that hurts by some other
  // means than a blast can then answer the same question without behaviours.js
  // learning anything new about obstacles.
  get threat() {
    return this.type.blastDamage;
  }

  // Take `amount` hull damage — the interface projectiles.js's targets need.
  // See the header for why this is gunfire's path onto an obstacle and a ram
  // never goes through it.
  damage(amount) {
    if (!this.alive) return;
    this.health -= amount;
    if (this.health <= 0) {
      this.health = 0;
      this.alive = false;
    }
  }
}

// The stretch of road a box of width `w` centred at `offset` occupies, clamped
// to the tarmac. Used by the passage scan, where anything hanging over a barrier
// is not road being taken away from anybody.
function span(offset, w) {
  return [
    Math.max(-ROAD_HALF_WIDTH, offset - w / 2),
    Math.min(ROAD_HALF_WIDTH, offset + w / 2),
  ];
}

// The lateral offsets a placement is willing to be put at, best first. Nothing
// here checks whether a spot is FREE — that is freeOffset's job; this only says
// where this kind of hazard belongs. See obstacletypes.js for what each mode
// means and why each type asks for the one it does.
function placementOffsets(placement, w) {
  // The furthest from the centre-line a box of this width can sit and still keep
  // its whole span on the tarmac.
  const limit = ROAD_HALF_WIDTH - w / 2;

  switch (placement) {
    case PLACE_SIDE: {
      // Both barriers, the coin-tossed one first, so a run of them doesn't all
      // end up on the same side of the road.
      const side = Math.random() < 0.5 ? 1 : -1;
      return [side * limit, -side * limit];
    }

    case PLACE_CENTRE:
      return [0];

    case PLACE_ANY: {
      const spots = [];
      for (let i = 0; i < ANY_TRIES; i++) spots.push((Math.random() * 2 - 1) * limit);
      return spots;
    }

    // PLACE_LANE, and the fallback for a type that names nothing: lane centres,
    // in random order so the spawner doesn't favour the left. Deliberately NOT
    // clamped by `limit` — a lane centre is a lane centre, and nudging a hazard
    // off it to make it fit would quietly turn "in the middle of a lane" into
    // "near a lane". A type too wide for a lane is a mistake in the CATALOGUE,
    // caught by test/invariants.test.js, not something to paper over here.
    default: {
      const start = Math.floor(Math.random() * LANE_COUNT);
      const spots = [];
      for (let i = 0; i < LANE_COUNT; i++) spots.push(laneOffset((start + i) % LANE_COUNT));
      return spots;
    }
  }
}

// AABB overlap between two boxes exposing {worldY, offset, w, h}. Obstacles
// never move under a rammed shove the way TrafficCar does, so this is the
// whole test — no resolveCollisions-style separation is needed on either side.
function overlaps(a, b) {
  return (
    Math.abs(a.worldY - b.worldY) < (a.h + b.h) / 2 &&
    Math.abs(a.offset - b.offset) < (a.w + b.w) / 2
  );
}

export class Obstacles {
  constructor(explosions) {
    this.explosions = explosions; // shared with Traffic — see the header
    this.list = [];
    this.spawnTimer = SPAWN_INTERVAL;
  }

  // `world` = { player, distance, W, H, cars }. `cars` is Traffic's live list
  // (main.js passes traffic.cars) — optional, so a caller with no traffic yet
  // (tests) can omit it and obstacles simply never trigger off a car.
  update(dt, world) {
    const { player, distance, W, cars = [] } = world;
    const centerX = centerXAt(distance, W);

    // The player expressed as a body in road coordinates, exactly as
    // collisions.js's PlayerBody does it, but read-only: an obstacle never
    // shoves anything, so there is no need for the fuller adapter.
    const playerBox = {
      worldY: distance,
      offset: player.x - centerX,
      w: player.w,
      h: player.h,
      damage: (hp) => player.damage(hp),
    };

    // Contact: the player or any live car driving into a hazard breaks it —
    // see the header for why this ignores `health` entirely.
    for (const o of this.list) {
      if (!o.alive) continue;
      o.pulseTime += dt;
      if (overlaps(o, playerBox) || cars.some((c) => c.alive && overlaps(o, c))) {
        o.health = 0;
        o.alive = false;
      }
    }

    this.detonate(playerBox, cars);
    this.retire(world);

    this.spawnTimer -= dt;
    if (this.spawnTimer <= 0) {
      this.spawnTimer = SPAWN_INTERVAL;
      if (this.count(false) < MAX_OBSTACLES) this.spawn(world);
    }
  }

  // How many live obstacles were laid by a car (`true`) or placed by the spawner
  // (`false`). The two budgets are kept apart — see MAX_LAID.
  count(laid) {
    return this.list.reduce((n, o) => n + (o.alive && o.laid === laid ? 1 : 0), 0);
  }

  // Lay one obstacle on the road immediately behind `body`, and report whether
  // there was room for it. This is the hostile mine drop (game/armament.js);
  // main.js hands it to traffic as a world hook so nothing in the AI has to
  // import this file.
  //
  // `body` is anything exposing { worldY, offset, h } — the same body interface
  // collisions.js documents, so a car satisfies it without an adapter.
  //
  // NOT SUBJECT TO THE SPAWNER'S PLACEMENT RULES, and that is the point of it
  // being a separate method rather than a flag on spawn(). freeOffset() below
  // honours the type's placement, refuses to close the road and refuses to drop
  // a hazard on top of a car, because road furniture the game itself put there
  // has to be FAIR — the player never chose to meet it. A mine laid by an enemy
  // is the opposite kind of event: somebody aimed it, the player watched them do
  // it, and the answer is to not be there. It goes exactly where that car was,
  // whatever its type's placement says, and the only things bounding it are
  // MAX_LAID and the layer's own magazine.
  //
  // A laid mine still COUNTS against the passage rule for later spawns, so the
  // road can be narrowed by enemy action but never sealed by the spawner adding
  // to it.
  drop(type, body) {
    if (!type || this.count(true) >= MAX_LAID) return false;
    const [, h] = OBSTACLE_SHAPES[type.shape].size;
    const worldY = body.worldY - (body.h + h) / 2 - DROP_CLEARANCE;

    const o = new RoadObstacle(type, worldY, body.offset);
    o.laid = true;
    this.list.push(o);
    return true;
  }

  // Break every obstacle killed this tick — by the contact pass above or by
  // gunfire in main.js, before update() ran — exactly once. Mirrors
  // Traffic.detonate()'s same bounded sweep for the same reason: dying is rare
  // enough per tick that an exact bound costs nothing, and it doubles as a
  // guard against a runaway loop.
  detonate(playerBox, cars) {
    for (let n = 0; n < this.list.length; n++) {
      const o = this.list.find((x) => !x.alive && !x.exploded);
      if (!o) return;
      o.exploded = true;

      // The destruction EFFECT follows the shape's family, not the obstacle's
      // own state — a mine always gets the EMP bloom, a roadblock always gets
      // its debris style (spawnObstacleWreck reads that off OBSTACLE_SHAPES
      // itself; see effects.js).
      if (OBSTACLE_SHAPES[o.type.shape].family === MINE) {
        this.explosions.spawnMineBlast(o.worldY, o.offset);
      } else {
        this.explosions.spawnObstacleWreck(o.worldY, o.offset, o.type.shape);
      }

      this.blast(o, playerBox, cars);
    }
  }

  // Hurt whoever is standing near a detonating obstacle. Identical falloff to
  // Traffic.blast() — peak damage at the box edge, nothing at `blastRadius` —
  // so a roadblock's tight radius and a mine's wide one are the same formula
  // at two different settings, not two mechanics to keep in sync.
  blast(o, playerBox, cars) {
    const radius = o.type.blastRadius;
    const peak = o.type.blastDamage;
    if (!radius || !peak) return;

    const hurt = (body) => {
      const dx = Math.max(0, Math.abs(body.offset - o.offset) - (body.w + o.w) / 2);
      const dy = Math.max(0, Math.abs(body.worldY - o.worldY) - (body.h + o.h) / 2);
      const dist = Math.hypot(dx, dy);
      if (dist >= radius) return;
      body.damage(peak * (1 - dist / radius));
    };

    hurt(playerBox);
    for (const car of cars) if (car.alive) hurt(car);
  }

  // Drop obstacles that have fallen behind the neighbourhood, or that were
  // destroyed. Unlike traffic there is no "ahead" bound to check — a static
  // obstacle is always spawned ahead of the player and can only ever fall
  // behind, never run off over the horizon.
  retire({ distance, player, H }) {
    const behind = distance - (H - player.y) - RETIRE_MARGIN;
    this.list = this.list.filter((o) => o.alive && o.worldY > behind);
  }

  // Introduce one obstacle just off the top of the screen, where its type says
  // it belongs across the road.
  spawn({ distance, player, cars = [] }) {
    const type = pickObstacleType(distance);
    // Nothing unlocked this early (obstacletypes.js's `minDistance`) — same
    // answer as a road with nowhere to put it: skip, try next interval.
    if (!type) return;

    const worldY = distance + player.y + SPAWN_MARGIN;

    const offset = this.freeOffset(type, worldY, cars);
    if (offset === null) return; // nowhere both clear and fair — try next interval

    this.list.push(new RoadObstacle(type, worldY, offset));
  }

  // A lateral offset this type may be placed at near `worldY`, or null if none
  // of the spots its placement offers will do. Candidates are tried in order and
  // the first that passes every check wins.
  //
  // LIVE TRAFFIC COUNTS as much as another obstacle does, and for a reason that
  // is not symmetric with it: an obstacle appearing on top of a car gives that
  // car's driver no warning at all, and behaviours.js can only steer around a
  // hazard it had road enough to see. The two spawn points nearly coincide
  // (traffic.js appears a SPAWN_MARGIN past the screen edge and this file a
  // slightly larger one), so without this a mine materialises a few units in
  // front of a car that then detonates it before the player ever sees it — and
  // no amount of driving skill on the car's part could have avoided it.
  freeOffset(type, worldY, cars = []) {
    const [w, h] = OBSTACLE_SHAPES[type.shape].size;

    for (const offset of placementOffsets(type.placement, w)) {
      // Another hazard too close along the road, where the two would overlap
      // laterally. Tested by OVERLAP rather than by lane, since most placements
      // are not lane-aligned and a block can be wider than a lane anyway.
      const crowded = this.list.some(
        (o) =>
          o.alive &&
          Math.abs(o.offset - offset) < (o.w + w) / 2 &&
          Math.abs(o.worldY - worldY) - (o.h + h) / 2 < SPAWN_GAP,
      );
      if (crowded) continue;

      const onTraffic = cars.some(
        (c) =>
          c.alive &&
          Math.abs(c.offset - offset) < (c.w + w) / 2 &&
          Math.abs(c.worldY - worldY) - (c.h + h) / 2 < SPAWN_GAP,
      );
      if (onTraffic) continue;

      if (!this.leavesPassage(worldY, offset, w)) continue;

      return offset;
    }
    return null;
  }

  // Would a hazard of width `w` at `offset` still leave a drivable gap across
  // this stretch of road? See THE PASSAGE RULE above.
  //
  // The scan is a plain sweep of the occupied spans in lateral order, tracking
  // the widest run of clear tarmac between them — barriers included as the two
  // ends. Spans are CLAMPED to the road first: nothing in the catalogue should
  // overhang a barrier today, but a gap measured against a span that does would
  // be measured against road nobody could drive on anyway.
  leavesPassage(worldY, offset, w) {
    const spans = [span(offset, w)];
    for (const o of this.list) {
      if (!o.alive) continue;
      if (Math.abs(o.worldY - worldY) >= CLUSTER_WINDOW) continue;
      spans.push(span(o.offset, o.w));
    }
    spans.sort((a, b) => a[0] - b[0]);

    let widest = 0;
    let cursor = -ROAD_HALF_WIDTH;
    for (const [lo, hi] of spans) {
      if (lo - cursor > widest) widest = lo - cursor;
      if (hi > cursor) cursor = hi;
    }
    if (ROAD_HALF_WIDTH - cursor > widest) widest = ROAD_HALF_WIDTH - cursor;

    return widest >= MIN_PASSAGE;
  }

  // No lateral interpolation, for the same reason bullets and explosions skip
  // it: an obstacle's `offset` never changes after spawn, so there is nothing
  // to smooth between logic ticks.
  render(ctx, distance, playerY, W, H) {
    for (const o of this.list) {
      const sy = playerY - (o.worldY - distance);
      if (sy < -DRAW_MARGIN || sy > H + DRAW_MARGIN) continue;

      const sx = centerXAt(o.worldY, W) + o.offset;
      const pulse = 0.5 + 0.5 * Math.sin(o.pulseTime * PULSE_RATE + o.pulsePhase);
      drawObstacleCached(ctx, sx, sy, {
        shape: o.type.shape,
        pulse,
        angle: headingAt(o.worldY),
      });
    }
  }
}
