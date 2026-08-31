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
import { ramSpeed, overlaps, inBlastPlane } from "./collisions.js";
import { centerXAt, headingAt, laneOffset, LANE_COUNT, ROAD_HALF_WIDTH } from "./road.js";


// Hazards simulated at once. Sized against SPAWN_MARGIN below rather than
// picked: a hazard is now placed well beyond the traffic field and has to scroll
// all the way back through it, so it lives roughly three times as long as it did
// when it appeared just off the top of the screen. The old cap of 4 was sized
// for that short life and, left alone, became the thing limiting how often the
// player meets an obstacle at all.
const MAX_OBSTACLES = 8;

// ...and, COUNTED SEPARATELY, hazards laid on the road by a car (see drop()).
// Separate budgets rather than one shared cap, because they compete for nothing
// and mean opposite things: road furniture is scenery the spawner puts out ahead
// of the player, and a laid mine is something a car just DID to them. Sharing one
// number would let a run of roadblocks quietly disarm every enemy on the road,
// and let a busy firefight starve the road of obstacles — each failure looking
// like a bug in the other system.
//
// AND THE LAID BUDGET IS ITSELF TWO, by the same argument one step further in.
// The player's own drops and the hostiles' were one number until the SPIKE MINES
// special (upgrades.js) started laying a PAIR per press: against a shared four,
// two presses filled the road and the next enemy layer to come along found
// nothing left to lay with — a hostile silently disarmed by the player having
// used their own weapon, which is exactly the cross-system failure the split
// above exists to prevent.
//
// FOUR EACH, so the player still gets two full pairs down at once — which is
// what "block the road behind me" has to mean to be worth 350 CR — without the
// hostiles noticing that the player bought anything.
const MAX_LAID_PLAYER = 4;
const MAX_LAID_HOSTILE = 4;

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
// Exported and asserted in test/hazards.test.js, since the relation is
// between three numbers in three different files.
export const SPAWN_MARGIN = 1500; // world units past the player an obstacle appears at
const RETIRE_MARGIN = 220;    // how far behind the player before it's dropped
const DRAW_MARGIN = 140;      // px past the screen edge still worth blitting. Kept
                              // separate from SPAWN_MARGIN: a hazard spawns most of
                              // a screen-height beyond the top edge and would
                              // otherwise be drawn for seconds before it is visible
// Exported so the relation events.js's `slalom` and `flank` are spaced by can be
// asserted rather than restated: a gate laid closer than this plus a block deep
// is simply refused, and a formation authored that way comes out with holes.
export const SPAWN_GAP = 90;  // min world-units of CLEAR ROAD between two obstacles'
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
// test/hazards.test.js, since it is a relation between two files.
//
// THE AMBIENT CATALOGUE, and `staged` types are deliberately left out of it.
// This is a real trade rather than a convenience, so it is worth the lines:
//
//   WHY IT CAME UP. The boss (cartypes.js's `mortar`) is 62px wide against the
//   bus's 46 — it is a siege gun, and that width is the artwork rather than a
//   tuning choice. Folded in here it would take MIN_PASSAGE from 58 to 74, and
//   that number is not a boss setting: it is the guaranteed gap in EVERY
//   minefield, roadblock and lane closure in the game. One car that the ambient
//   spawner can never even produce would have quietly made every hazard on the
//   road easier for a player whose own car is 34px wide.
//
//   WHAT IT COSTS. A staged type is not guaranteed to fit through an ambient
//   hazard, and the boss genuinely may not. That is survivable and arguably
//   right — a mine is 150 against its 1600 hull, its driving profile avoids
//   hazards anyway (driving.js's `battery`, nerve 0), and the encounter that
//   stages it runs with the hazard budget at zero, so the case only arises at
//   all once the fight is over. A 62px vehicle not fitting everywhere a 34px
//   one does is not a bug.
const WIDEST_CAR = Math.max(...CAR_TYPES.filter((t) => !t.staged).map((t) => t.w));
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
    this.staged = false; // ...and true when game/events.js put it here as part
                       // of an encounter (a road narrowing). A THIRD budget for
                       // the same reason the first two are separate: a staged
                       // row of trestles that ate MAX_OBSTACLES would silence
                       // the ambient road for as long as it stood
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
  // `threat` may be stated OUTRIGHT by a type that hurts by some other means
  // than a blast — which is the case this comment already anticipated, now
  // real: the spike strip barely scratches a car and must still be given a
  // wide berth, so it names its own figure rather than being read as harmless
  // (obstacletypes.js).
  get threat() {
    return this.type.threat ?? this.type.blastDamage;
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
    // caught by test/hazards.test.js, not something to paper over here.
    default: {
      const start = Math.floor(Math.random() * LANE_COUNT);
      const spots = [];
      for (let i = 0; i < LANE_COUNT; i++) spots.push(laneOffset((start + i) % LANE_COUNT));
      return spots;
    }
  }
}

export class Obstacles {
  // `onDestroyed()` is called once for every obstacle that detonates, at
  // the moment it does — same shape as Traffic's own `onDestroyed`, wired
  // up in main.js for the same reason: this file has no notion of audio or
  // score, so a caller that wants to react to "something just blew up"
  // gets a callback instead of this module importing anything about what
  // that reaction should be. Optional, so tests can build an Obstacles with
  // no listener at all.
  constructor(explosions, onDestroyed = null) {
    this.explosions = explosions; // shared with Traffic — see the header
    this.onDestroyed = onDestroyed;
    this.list = [];
    this.spawnTimer = SPAWN_INTERVAL;
    this.density = 1; // see setDensity()
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
      puncture: (type) => player.puncture(type),
    };

    // Contact: the player or any live car driving into a hazard breaks it —
    // see the header for why this ignores `health` entirely. It also costs
    // whoever hit it some SPEED, same physics as ramming a car head-on
    // (collisions.js's ramSpeed) with the hazard standing in for a body that
    // never moves — a trestle is barely felt, a tetra costs nearly as much as
    // parking a rig in the way. See obstacletypes.js's `mass`.
    for (const o of this.list) {
      if (!o.alive) continue;
      o.pulseTime += dt;
      const hitPlayer = overlaps(o, playerBox);
      const hitCars = cars.filter((c) => c.alive && overlaps(o, c));

      // A STRIP IS NOT CONSUMED BY THE CAR THAT FINDS IT (obstacletypes.js's
      // `effect`). Everything else here breaks on first contact — that is what
      // makes a mine a one-shot event — but a belt of teeth lying across two
      // lanes is a hazard the whole road has to deal with, and one that
      // vanished under the first car would be a mine that took five seconds to
      // pay out. So this branch takes no `health`, sets no `alive`, and never
      // reaches detonate() below.
      if (o.type.effect === "spikes") {
        for (const c of hitCars) c.puncture(o.type);
        // AND THE PLAYER, which is who the strips on the road are FOR now. The
        // sower (cartypes.js) lays its strip while the player trails it —
        // armament.js's layMine only fires on a target BEHIND the layer — so
        // what goes down behind the sower goes down in front of the player.
        // This line was missing for as long as the strip was something the
        // player laid rather than met, and its absence made the sower's whole
        // errand cost nothing.
        if (hitPlayer) player.puncture(o.type);
        continue;
      }

      if (hitPlayer || hitCars.length) {
        // `player.mass`, not the module's PLAYER_MASS constant — the shop's RAM
        // PLATE tiers (game/upgrades.js) move the car's own figure, and the
        // whole promise of that upgrade is that a heavier car is slowed less by
        // what it drives through. Reading the constant here would have left
        // road furniture as the one thing on the road the upgrade didn't touch.
        if (hitPlayer) player.speed = ramSpeed(player.speed, player.mass, o.type.mass);
        for (const c of hitCars) c.speed = ramSpeed(c.speed, c.mass, o.type.mass);
        o.health = 0;
        o.alive = false;
      }
    }

    this.detonate(playerBox, cars);
    this.retire(world);

    this.spawnTimer -= dt;
    if (this.spawnTimer <= 0) {
      this.spawnTimer = SPAWN_INTERVAL;
      // Scaled by whatever encounter is running (see setDensity), against the
      // ambient count only — a staged narrowing neither fills this budget nor
      // is thinned by it.
      const cap = Math.round(MAX_OBSTACLES * this.density);
      if (this.count(false) < cap) this.spawn(world);
    }
  }

  // AMBIENT DENSITY, exactly as traffic.js's own setDensity — game/events.js
  // turns it down while an encounter is live and back to 1 when it ends.
  // MAX_OBSTACLES stays the baseline it is read against. Nothing already on the
  // road is removed; the spawner just stops replacing what retires.
  setDensity(mul) {
    this.density = Math.max(0, mul);
  }

  // How many live obstacles were laid by a car (`true`) or placed by the spawner
  // (`false`). The budgets are kept apart — see MAX_LAID_PLAYER and
  // RoadObstacle's own `staged`. Staged hazards belong to neither and are
  // excluded from both.
  //
  // `hostile` narrows a laid count to one side's drops. Omitted, it counts both
  // — which is what the passage rule wants, since a strip narrows the road just
  // as much whoever laid it.
  count(laid, hostile) {
    return this.list.reduce(
      (n, o) => n + (o.alive && !o.staged && o.laid === laid
        && (hostile === undefined || !!o.hostile === hostile) ? 1 : 0),
      0,
    );
  }

  // ...and the third bucket: hazards game/events.js staged as part of an
  // encounter. Its own budget lives in that file, alongside the staged-car one.
  stagedCount() {
    return this.list.reduce((n, o) => n + (o.alive && o.staged ? 1 : 0), 0);
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
  // the laid budget (MAX_LAID_PLAYER / MAX_LAID_HOSTILE) and the layer's own
  // magazine.
  //
  // A laid mine still COUNTS against the passage rule for later spawns, so the
  // road can be narrowed by enemy action but never sealed by the spawner adding
  // to it.
  // ...but it is still put ON THE ROAD. "Wherever that car was" is a statement
  // about which lane, not a licence to hang half a hazard over a barrier: a
  // laid obstacle is a physical object, and one drawn through the wall reads as
  // a rendering fault rather than as a bold drop. The narrow hazards never
  // noticed — a mine is 26 wide and a car near the edge is already inside the
  // limit — but the spike strip is 2.4 lanes across, so laying one while
  // hugging a barrier put a third of it off the tarmac.
  //
  // Clamped to the box's own half-width, the SAME limit placementOffsets uses
  // for a spawned hazard. It never refuses the drop: sliding a wide strip back
  // onto the road is the right answer, where rejecting it would make the
  // weapon silently fail exactly where a player most wants to use it.
  //
  // A SET, AND ALL OF IT OR NONE. `types` is one type or several, and the whole
  // set is laid on one press: SPIKE MINES (upgrades.js) is a mine and a strip
  // together, the mine for whoever drives over the middle and the strip for
  // whoever goes around it. The budget is checked for the WHOLE set up front,
  // because half a pair is not a cheaper version of the weapon — it is the
  // player spending a round and getting something they did not buy.
  //
  // ONE SPOT FOR THE WHOLE SET, measured off its DEEPEST and WIDEST member. The
  // obvious reading — place each type by its own box — puts the pair 9 units
  // apart down the road, because the mine is 26 deep and the strip is 7, and
  // half that difference is the gap: the mine sits just off the belt instead of
  // in the middle of it, which is the one thing the pair is meant to look like.
  // Sizing the spot by the deepest member keeps the whole set clear of the
  // layer's own tail, and clamping by the widest keeps them RIGID against a
  // barrier — the mine slides inboard with its strip rather than drifting
  // toward one end of it.
  //
  // A one-type drop is unaffected, since the max of one box is that box.
  //
  // `hostile` says whose budget to spend. The caller knows and this class
  // cannot: an enemy layer and the player's deploy key reach the same method
  // (armament.js's layMine, main.js's deploy branch) with the same shaped body.
  drop(types, body, hostile = false) {
    const set = (Array.isArray(types) ? types : [types]).filter(Boolean);
    if (!set.length) return false;
    const cap = hostile ? MAX_LAID_HOSTILE : MAX_LAID_PLAYER;
    if (this.count(true, hostile) + set.length > cap) return false;

    const boxes = set.map((type) => OBSTACLE_SHAPES[type.shape].size);
    const deepest = Math.max(...boxes.map(([, h]) => h));
    const widest = Math.max(...boxes.map(([w]) => w));
    const worldY = body.worldY - (body.h + deepest) / 2 - DROP_CLEARANCE;
    const limit = Math.max(0, ROAD_HALF_WIDTH - widest / 2);
    const offset = Math.max(-limit, Math.min(limit, body.offset));

    for (const type of set) {
      const o = new RoadObstacle(type, worldY, offset);
      o.laid = true;
      o.hostile = hostile;
      this.list.push(o);
    }
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
      if (this.onDestroyed) this.onDestroyed(o);

      this.blast(o, playerBox, cars);
    }
  }

  // Hurt whoever is standing near a detonating obstacle. Identical falloff to
  // Traffic.blast() — peak damage at the box edge, nothing at `blastRadius` —
  // so a roadblock's tight radius and a mine's wide one are the same formula
  // at two different settings, not two mechanics to keep in sync.
  //
  // NO PUNCTURE HERE. An earlier spike mine sprayed its teeth over this same
  // falloff area, which measured 158px across against the strip's 171.6 — near
  // enough the same belt, except invisible: nothing was drawn for it, and the
  // AI dodged the 26px mine box and was punctured by a hazard that had never
  // been on screen. The upgrade lays a REAL STRIP alongside the mine instead
  // (upgrades.js's SPIKE MINES), which is drawn, which `hazardAhead` can see,
  // and which stays in the road after the mine has gone off. See drop().
  blast(o, playerBox, cars) {
    const radius = o.type.blastRadius;
    const peak = o.type.blastDamage;
    if (!radius || !peak) return;

    const hurt = (body) => {
      // Nothing at road level reaches the air — see collisions.js's inBlastPlane.
      if (!inBlastPlane(body)) return;
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

  // PUT ONE HAZARD AT A SPOT THE CALLER CHOSE, subject to every rule a spawned
  // one obeys. This is game/events.js's way onto the road — a narrowing names
  // its own offsets (both barriers) rather than asking the type where it
  // belongs, which is the one thing placementOffsets cannot express.
  //
  // NOT drop(). That method exists precisely to SKIP these checks, because a
  // mine somebody aimed is meant to land where they aimed it (see its header).
  // A staged encounter is the other kind of thing entirely: the game itself put
  // it there and the player never chose to meet it, so it has to be fair —
  // which here means the crowding test, the traffic test and, above all, the
  // passage rule. A narrowing that would seal the road is simply refused, and
  // the encounter comes out one trestle thinner. That is the correct failure.
  //
  // Returns whether it went down. `false` is a normal outcome, not an error.
  place(type, worldY, offset, cars = [], staged = false) {
    const [w, h] = OBSTACLE_SHAPES[type.shape].size;
    if (!this.spotClear(worldY, offset, w, h, cars)) return false;
    if (!this.leavesPassage(worldY, offset, w)) return false;

    const o = new RoadObstacle(type, worldY, offset);
    o.staged = staged;
    this.list.push(o);
    return true;
  }

  // Is there room for a box `w` x `h` at (`worldY`, `offset`) — no hazard and no
  // car already too close? Split out of freeOffset below so place() can ask it
  // about a spot the caller named; freeOffset is then that same question asked
  // of each spot the type's placement offers.
  spotClear(worldY, offset, w, h, cars = []) {
    const crowded = this.list.some(
      (o) =>
        o.alive &&
        Math.abs(o.offset - offset) < (o.w + w) / 2 &&
        Math.abs(o.worldY - worldY) - (o.h + h) / 2 < SPAWN_GAP,
    );
    if (crowded) return false;

    return !cars.some(
      (c) =>
        c.alive &&
        Math.abs(c.offset - offset) < (c.w + w) / 2 &&
        Math.abs(c.worldY - worldY) - (c.h + h) / 2 < SPAWN_GAP,
    );
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
      // Another hazard or a live car too close along the road, where the two
      // would overlap laterally. Tested by OVERLAP rather than by lane, since
      // most placements are not lane-aligned and a block can be wider than a
      // lane anyway. See spotClear().
      if (!this.spotClear(worldY, offset, w, h, cars)) continue;
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
