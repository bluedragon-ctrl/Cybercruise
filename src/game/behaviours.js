// Traffic AI — one function per tactic, picked by a car type's `behaviour` key.
//
// THE CONTRACT
//   behave(car, dt, world)
//     car    the TrafficCar being driven (see traffic.js)
//     dt     seconds since the last logic tick (fixed, see engine/loop.js)
//     world  { player, distance, cars, playerBody, W, H } — the read-only view of
//            everything else. `cars` is every live traffic car including this
//            one; `obstacles` is every live road hazard (game/obstacles.js);
//            `playerBody` is the player expressed in ROAD coordinates
//            (worldY / offset / w / h / speed), which is the form to compare
//            against a car. Reach for `player` only for things the body doesn't
//            carry, and never write to any of them.
//
// A behaviour only ever sets INTENT on the car:
//     car.targetOffset  where it wants to be across the road (lateral px from
//                       the centre-line — see road.js laneOffset)
//     car.targetSpeed   how fast it wants to go (world units/sec)
// traffic.js then integrates that intent under the car type's limits
// (`steerSpeed`, acceleration) and keeps it on the tarmac. Behaviours must not
// write car.offset / car.speed / car.worldY directly, or a truck would be able
// to corner like a roadster and the physics would live in two places.
//
// THE TWO EXCEPTIONS — the only things a behaviour may DO rather than intend —
// are the world's own hooks, and they exist because putting a bullet or a mine
// into the world is not something the car's own physics can integrate later:
//     world.fireShot(car, weaponType, dir)  a round leaves the muzzle, +1 up the
//                                           road or -1 back down it
//     world.dropMine(car, obstacleType)     a mine is laid behind the car;
//                                           returns whether there was room
// Both are wired up in main.js and are OPTIONAL: they are what keeps this file
// and traffic.js free of any import of projectiles.js or obstacles.js. Neither
// is called from here directly — game/armament.js decides when, and the hostile
// tactics at the bottom of this file decide who asks.
//
// Behaviours are also free to be STATEFUL by stashing fields on `car` (a timer,
// a chosen lane) — each car is a plain object owned by one behaviour for life.
//
// Two real DRIVING tactics ship today, `cruise` and `overtake`. The named
// tactics at the bottom of this file (`pursue`, `ram`, `block`, `weave`,
// `convoy`) still delegate their driving to one of those two — the car types
// already name them, so finishing one is a matter of filling in a function body,
// not of rewiring the catalogue. The four HOSTILE ones are no longer pure stubs:
// their driving is still borrowed, but they shoot and lay mines for real.

import { laneAt, laneOffset, LANE_COUNT, LANE_WIDTH, ROAD_HALF_WIDTH } from "./road.js";
import { useArms } from "./armament.js";

// Clear road a cruising car wants between its nose and the tail of the car in
// front, in world units, plus a term for how fast it is closing. Traffic can
// only shed speed at traffic.js's ACCEL, and shedding dv takes dv²/(2*ACCEL)
// units of road; one second of closing rate covers that for every dv the
// catalogue can produce, so a follower always has room to match rather than
// running into the car ahead.
//
// That "for every dv" is a REAL CONSTRAINT between three numbers, not a
// platitude: it holds exactly while the catalogue's largest closing speed (the
// fastest cruise minus the player's minimum, currently 730 - 120 = 610) is no
// more than 2 * ACCEL * FOLLOW_REACTION. Widen the speed band and one of ACCEL
// or FOLLOW_REACTION has to move with it, or the road starts rear-ending itself.
const FOLLOW_GAP = 40;
// Exported so the constraint spelled out above can be asserted rather than only
// documented (see test/invariants.test.js).
export const FOLLOW_REACTION = 1.0; // seconds of closing rate added to the gap

// Drive on, holding a lane and a steady speed — but don't drive INTO whatever is
// in front, traffic or player. Cars do collide now (collisions.js), so this is
// what separates an accident from ordinary traffic: without it every faster car
// on the road would grind through the queue ahead of it, and the player would be
// rear-ended from behind constantly rather than as a consequence of driving
// badly. Enemy types keep it until Phase 4 gives them a reason not to.
function cruise(car, _dt, world) {
  car.targetSpeed = followSpeed(car, leadCar(car, world, car.offset, null));
  avoidHazards(car, world);
}

// The speed to ask for while `lead` is in the way — the lead car's speed once
// inside the gap this car needs at its current closing rate, `desired` outside
// it (or with the road clear).
//
// `desired` is a parameter rather than just car.cruiseSpeed because an
// overtaking car wants MORE than its cruise (see passSpeed): the braking rule
// and the "how fast do I want to go" question are separate, and a car making a
// pass still has to brake for whatever is in front of it.
function followSpeed(car, lead, desired = car.cruiseSpeed) {
  if (!lead) return desired;
  const gap = lead.worldY - car.worldY - (lead.h + car.h) / 2;
  const closing = Math.max(0, car.speed - lead.speed);
  const needed = FOLLOW_GAP + closing * FOLLOW_REACTION;
  return gap < needed ? Math.min(desired, lead.speed) : desired;
}

// The nearest thing ahead of `car` that it would run into if it drove the line
// at `offset`, or null if that line is clear. `ignore` is the one body to look
// past — the car being overtaken, which is by definition beside the pass line
// and not an obstacle in it.
//
// Overlap is tested LATERALLY rather than by lane number: ramming knocks cars
// between lanes and the player never had one, so "shares my lane" is not the
// same question as "is in my way".
function leadCar(car, world, offset, ignore) {
  let best = null;
  let bestGap = Infinity;
  const consider = (other) => {
    if (other === car || other === ignore) return;
    // A car killed earlier this tick is still in the list until traffic.js retires
    // it at the end of the tick (see Traffic.update). It is about to explode and
    // leave nothing solid behind, so it is not something to brake for.
    if (!other.alive) return;
    if (Math.abs(other.offset - offset) >= (other.w + car.w) / 2) return;
    const gap = other.worldY - car.worldY;
    if (gap > 0 && gap < bestGap) {
      bestGap = gap;
      best = other;
    }
  };
  for (const other of world.cars) consider(other);
  if (world.playerBody) consider(world.playerBody);
  return best;
}

// --- Overtaking -------------------------------------------------------------
// Cruising alone makes a fast car queue politely behind a slow one forever,
// which on a four-lane road looks broken — and it means the player can hold up
// the whole road by sitting in one lane. An overtaker instead pulls out, drives
// past on one side and settles back into a lane.
//
// The manoeuvre is COMMITTED: a car picks a side once, holds that line until it
// is past (or gives up), and doesn't re-decide every tick. Re-deciding is what
// makes traffic AI dither in the mirror, and here it would also mean cars
// jinking sideways into each other, since every swerve is now a collision.

const PASS_CLEARANCE = 12;    // px of daylight between the two boxes as it goes by
const PASS_TRIGGER = 220;     // world units: a blocker further off isn't holding us up yet
const PASS_MARGIN = 30;       // world units the nose must clear before pulling back in
const PASS_TIMEOUT = 6;       // seconds before an unfinished pass is abandoned
const PASS_SPEED_MARGIN = 15; // how much faster we must want to be to bother
const PASS_LOOK_BEHIND = 90;  // world units of the pass line checked behind us...
const PASS_LOOK_AHEAD = 140;  // ...and beyond the car we mean to pass
const PASS_EFFORT = 1.15;    // how much harder a car drives while committed to a pass

// The speed a car wants while it is actually alongside something. A pass driven
// at cruise speed is a slow one — the whole manoeuvre runs at whatever margin
// the two cruise speeds happen to differ by, which is why passes used to expire
// on PASS_TIMEOUT rather than finish. Spending a little extra makes overtaking
// read as effort rather than as drift.
//
// CAPPED AT THE TYPE'S OWN speedMax, which is what keeps this free: the top of
// the catalogue's speed band doesn't move, so the largest closing speed the road
// can produce is unchanged and the ACCEL / FOLLOW_REACTION invariant above still
// holds. A car already cruising at its maximum simply passes at cruise.
function passSpeed(car) {
  return Math.min(car.type.speedMax, car.cruiseSpeed * PASS_EFFORT);
}

// Drive on, but go around whatever is in the way rather than sitting behind it.
// Otherwise identical to cruising: this still brakes for the car in front, so a
// pass that can't be completed degrades to following instead of a rear-end.
function overtake(car, dt, world) {
  if (car.passTarget) holdPass(car, dt);
  else startPass(car, world);

  // Brake for the nearest obstacle in EITHER line while changing lanes — the one
  // ahead in the lane being left and the one ahead in the lane being taken. Only
  // the car being passed is looked past.
  const target = car.passTarget;
  const lead = target
    ? nearer(
        leadCar(car, world, car.offset, target),
        leadCar(car, world, car.targetOffset, target),
      )
    : leadCar(car, world, car.offset, null);

  // Drive harder while committed to a pass, but still brake for anything in
  // either line: the effort is spent on getting by, not on driving into someone.
  car.targetSpeed = followSpeed(car, lead, target ? passSpeed(car) : car.cruiseSpeed);

  avoidHazards(car, world);
}

// Commit to a pass if there's something worth passing and a side to do it on.
// Behaviour state lives on the car (see the contract above): `passTarget` is the
// body being passed, `passSide` -1/+1 the side chosen, `passTime` its age.
function startPass(car, world) {
  const lead = leadCar(car, world, car.offset, null);
  if (!lead) return;

  // Only a car that is actually holding us up is worth the risk.
  if (car.cruiseSpeed <= lead.speed + PASS_SPEED_MARGIN) return;
  if (lead.worldY - car.worldY - (lead.h + car.h) / 2 > PASS_TRIGGER) return;

  // Try the side away from wherever the blocker sits relative to us first: that's
  // the side we're already drifting toward, and it's the shorter move.
  const first = lead.offset <= car.offset ? 1 : -1;
  for (const side of [first, -first]) {
    const line = passLine(car, lead, side);
    if (line === null) continue;      // barrier that side
    if (blocked(car, lead, line, world)) continue; // someone already in it
    car.passTarget = lead;
    car.passSide = side;
    car.passTime = 0;
    car.targetOffset = line;
    return;
  }
}

// Hold the chosen line, and decide when the manoeuvre is over. The line is
// recomputed against the target's CURRENT offset each tick — cars get shoved
// around, and a stale line would steer us into the thing we're passing — but the
// side is never revisited.
function holdPass(car, dt) {
  const target = car.passTarget;
  car.passTime += dt;

  const gap = target.worldY - car.worldY;
  const past = -gap > (car.h + target.h) / 2 + PASS_MARGIN; // nose fully clear
  const gone = gap > PASS_TRIGGER * 2;                      // it drove off ahead
  if (!target.alive || past || gone || car.passTime > PASS_TIMEOUT) {
    endPass(car);
    return;
  }

  const line = passLine(car, target, car.passSide);
  if (line === null) endPass(car); // it drifted into the barrier we were using
  else car.targetOffset = line;
}

// Back to ordinary driving, aiming at whichever lane the car ended up nearest —
// it has moved a lane's width or more, and left to itself it would drive back
// across the road to the lane it spawned in.
function endPass(car) {
  car.passTarget = null;
  car.targetOffset = laneOffset(laneAt(car.offset));
}

// The lateral offset to drive at to clear `target` on `side`, or null if the
// barrier is in the way there.
function passLine(car, target, side) {
  const offset = target.offset + side * ((car.w + target.w) / 2 + PASS_CLEARANCE);
  const limit = ROAD_HALF_WIDTH - car.w / 2;
  return Math.abs(offset) > limit ? null : offset;
}

// Is anyone else already in the stretch of road this pass would use? Checked
// once, when committing: during the pass, traffic that moves in is handled by
// braking (see overtake) rather than by abandoning the line mid-swerve.
function blocked(car, target, line, world) {
  const from = car.worldY - PASS_LOOK_BEHIND;
  const to = target.worldY + PASS_LOOK_AHEAD;
  const occupies = (other) => {
    if (other === car || other === target) return false;
    if (!other.alive) return false; // a corpse must not veto a pass — see leadCar
    if (Math.abs(other.offset - line) >= (other.w + car.w) / 2) return false;
    return other.worldY > from && other.worldY < to;
  };
  for (const other of world.cars) if (occupies(other)) return true;
  // Road hazards veto a pass line exactly as a car does — swerving out of a
  // queue into a tank trap is not an overtake. Checked here as well as in the
  // dodge below so a car never COMMITS to a doomed line in the first place.
  for (const other of world.obstacles ?? []) if (occupies(other)) return true;
  return world.playerBody ? occupies(world.playerBody) : false;
}

// Whichever of two lead cars is nearer (either may be null).
function nearer(a, b) {
  if (!a) return b;
  if (!b) return a;
  return a.worldY <= b.worldY ? a : b;
}

// --- Road hazards -----------------------------------------------------------
//
// An obstacle (game/obstacles.js) is NOT traffic, and that difference decides
// everything about how one is handled. Traffic is something you QUEUE behind:
// it is moving, so matching its speed still gets you where you were going. A
// roadblock is standing still and always will be, so FOLLOWING one is never the
// answer — which is exactly what the rule above would do if hazards were let
// into leadCar, since followSpeed matches the lead's speed and a hazard's is
// zero. Hazards are deliberately kept out of leadCar for that reason.
//
// So the answer is STEER FIRST, and only then slow down — and the reason
// slowing down helps at all is the same fact that makes following useless. A
// hazard does not move, so going slower does not "let it get away"; it simply
// buys more SECONDS of approach, and seconds of approach are exactly what a
// lane change costs. A car that cannot fit its swerve into the road it has left
// can always fit it by taking longer over that road.
//
// Hence the three tiers below, cheapest first:
//   1. steer to a lane clear of both the hazard and traffic;
//   2. failing that, steer to one merely clear of the HAZARD, accepting that
//      there is a car there — a fender-bender beats a blast every time;
//   3. and whatever line was chosen, slow down enough that the sideways move
//      actually fits in the road remaining. In the worst case that means
//      stopping, which is a fine thing for a car to do in front of a mine.
// Tier 3 is a floor on the tactic's own speed, never a target: a car with room
// to spare passes a hazard at full cruise and never knows this ran.
//
// THE REFLEX RUNS LAST. Both shipped tactics call this after setting their own
// intent, so a dodge overrides whatever the tactic wanted LATERALLY: finishing
// an overtake is never worth driving over a mine. Everything else the tactic
// decided — its speed, its pass state — survives untouched, so the pass simply
// resumes once the road is clear again.
//
// DODGES AIM AT LANE CENTRES, which is what lets this skip a "pull back in"
// step entirely: a car that swerves ends up in a real lane and cruises on from
// there as if it had spawned in it. It is also what keeps the dodge STABLE —
// the candidate lines are fixed, so a car picks a lane and holds it instead of
// hunting between two near-equal offsets as it closes. Re-deciding every tick
// is the dithering the overtake section above warns about, and it would be far
// worse here, where the thing being dodged never moves out of the way.
//
// WHY STEERING ALONE IS ENOUGH: obstacles.js refuses to place a hazard in the
// last open lane of a stretch of road, so a lane to dodge into always exists.
// That is a real constraint between the two files, asserted in
// test/invariants.test.js rather than only promised here.

const HAZARD_CLEARANCE = 6;   // px of daylight wanted when steering past one

// HOW FAR AHEAD A DRIVER LOOKS is not a constant, for the same reason
// FOLLOW_REACTION isn't: the road has to give a car enough WARNING, and warning
// is a distance divided by how fast the car is covering it. A fixed lookahead
// gets this exactly backwards — a rig steers at 35px/sec and a cycle at 180,
// while the cycle also arrives at nearly four times the speed, so one number
// cannot be right for both. Measured against a live road, a flat 260 units left
// every type arriving with roughly the time for ONE lane change and no more,
// which is not enough: a car meeting the wider blocks has to cross more than a
// lane to get its whole box clear, so it was still overlapping on arrival and
// traffic went on clearing ~90% of the hazards off the road.
//
// So the lookahead is DERIVED: the time this car needs to slide clear, times
// the speed it is closing at. A hazard never moves, so the closing speed is
// simply the car's own.
// TWO lane widths, not one, and what sets it is no longer a question of WIDTH.
// Every block in the catalogue now fits in or beside a lane, and each is a
// single lane change to clear. The binding case is the MINE, and it is binding
// because of where it is allowed to be rather than how big it is: PLACE_ANY
// (obstacletypes.js) lets it land BETWEEN two lane centres, and a mine sitting
// on the line between two lanes spoils both of them at once. Measured against
// the catalogue, the worst case is a rig in the outer lane with a mine at -72:
// its own lane and the next one in are both unusable, so the nearest lane centre
// it can actually take is the third one over — 130px away, exactly two lane
// widths.
//
// So this number follows PLACE_ANY. Take the free placement away and one lane
// would do; give another type a free placement and this stays right. Sizing it
// at one lane is what left cars finishing their swerve still overlapping the
// thing they were avoiding.
const HAZARD_DODGE_SPAN = 2; // lane widths a dodge may have to cover
const HAZARD_SAFETY = 1.3;   // slack, so a car arrives already clear rather than
                             // finishing its swerve exactly at the obstacle

// Road a car needs to see a hazard coming and be clear of it: the time its own
// steering takes to cover HAZARD_DODGE_SPAN, times the speed it is closing at.
// A hazard never moves, so the closing speed is simply the car's own.
//
// Exported because it is a CONSTRAINT ON WHERE HAZARDS MAY BE PLACED, not just
// a local tuning number: obstacles.js has to spawn far enough ahead that every
// car in the catalogue gets at least this much road, or the slowest-steering
// types are asked to dodge something they physically cannot avoid. Asserted in
// test/invariants.test.js.
export function dodgeDistance(speed, steerSpeed) {
  return speed * ((LANE_WIDTH * HAZARD_DODGE_SPAN) / steerSpeed) * HAZARD_SAFETY;
}

// World units ahead `car` reads the road for hazards.
function hazardLookahead(car) {
  return dodgeDistance(car.speed, car.type.steerSpeed);
}

// The nearest hazard `car` would drive into on the line at `offset`, or null if
// that line is clear. Same lateral-overlap test leadCar uses, for the same
// reason: ramming knocks cars between lanes, so "shares my lane" is not the
// question — "is in my way" is.
function hazardAhead(car, world, offset, lookahead) {
  let best = null;
  let bestGap = Infinity;
  for (const o of world.obstacles) {
    if (!o.alive) continue;
    const gap = o.worldY - car.worldY;
    if (gap <= 0 || gap > lookahead || gap >= bestGap) continue;
    if (Math.abs(o.offset - offset) >= (o.w + car.w) / 2 + HAZARD_CLEARANCE) continue;
    bestGap = gap;
    best = o;
  }
  return best;
}

// Steer around anything in the way that this driver isn't willing to eat.
function avoidHazards(car, world) {
  if (!world.obstacles || world.obstacles.length === 0) return;

  // Check the line the car is ON and the line it is HEADING FOR, and react to
  // whichever hazard comes first. Mid-pass those are different lines, and a car
  // that only watched one of them would either swerve into a hazard it was
  // steering toward or ignore one it is still sitting on top of.
  const lookahead = hazardLookahead(car);
  const hazard = nearer(
    hazardAhead(car, world, car.offset, lookahead),
    hazardAhead(car, world, car.targetOffset, lookahead),
  );
  if (!hazard) return;

  // NERVE: some drivers take the hit rather than lift off their line. `threat`
  // is the hull this hazard costs at contact and `car.nerve` is what this
  // particular driver will accept — rolled ONCE at spawn (traffic.js), so a
  // barger is a barger for life. A fresh coin flip per tick would make a car
  // swerve and unswerve all the way down the road.
  if (hazard.threat <= car.nerve) return;

  // The nearest lane centre that works, walked by index rather than sorted into
  // a list, since this runs per car per tick and behaviours.js allocates
  // nothing.
  //
  // TWO TIERS, because a hazard is worse than a neighbour. The preferred line
  // is clear of hazards AND of traffic. But `blocked` is the OVERTAKE's test —
  // it wants a lane empty for the whole length of a sustained pass — and on a
  // busy road that rejects nearly everything. Measured against a live road,
  // insisting on it left a car with nowhere to go 39% of the time, and "nowhere
  // to go" meant driving into the mine. So a lane that is merely clear of the
  // HAZARD is kept as a fallback: swapping a certain blast for a possible
  // fender-bender is the right trade every time, and collisions.js already
  // knows what to do about the fender-bender.
  //
  // What is never traded away is the hazard itself — a line that is still
  // hazardous is skipped outright and can't become the fallback.
  let best = null;
  let bestDist = Infinity;
  let fallback = null;
  let fallbackDist = Infinity;
  for (let i = 0; i < LANE_COUNT; i++) {
    const line = laneOffset(i);
    const dist = Math.abs(line - car.offset);
    if (hazardAhead(car, world, line, lookahead)) continue;

    if (dist < fallbackDist) {
      fallbackDist = dist;
      fallback = line;
    }
    if (blocked(car, hazard, line, world)) continue;
    if (dist < bestDist) {
      bestDist = dist;
      best = line;
    }
  }

  // Both stay null only when the hazard covers every lane, which obstacles.js's
  // placement rule is supposed to make impossible. Even then the car is not out
  // of options — it just has no LANE to aim at, and tier 3 below still applies.
  const aim = best ?? fallback;
  if (aim !== null) car.targetOffset = aim;

  // TIER 3: slow down enough that the swerve fits in the road that is left.
  //
  // How far sideways this car still has to travel: to the lane it just picked,
  // or — with no lane to pick — the smallest move that would clear the hazard
  // from where it already is. The second case is what keeps a boxed-in car
  // slowing down instead of giving up and driving on at full speed.
  const clearBy = (hazard.w + car.w) / 2 + HAZARD_CLEARANCE;
  const lateral =
    aim !== null
      ? Math.abs(aim - car.offset)
      : Math.max(0, clearBy - Math.abs(car.offset - hazard.offset));
  if (lateral <= 0) return; // already clear of it — nothing to fit in

  // The speed at which the remaining road lasts as long as the swerve does.
  // Applied as a CEILING on whatever the tactic asked for, so this only ever
  // takes speed away, and only from a car that genuinely cannot make it.
  const seconds = lateral / car.type.steerSpeed;
  const gap = Math.max(0, hazard.worldY - car.worldY - (hazard.h + car.h) / 2);
  const safe = gap / seconds;
  if (safe < car.targetSpeed) car.targetSpeed = Math.max(0, safe);
}

// --- Phase 4 tactics --------------------------------------------------------
// Every car type in the catalogue names the behaviour it will EVENTUALLY have,
// and each of those names resolves to a real function here. The DRIVING half of
// each is still a stub delegating to `cruise` or `overtake`; the SHOOTING half
// is live, and identical across all four.
//
// Named functions rather than pointing the types at `cruise` directly, for two
// reasons: behaviourFor falls back silently on an unknown key, so a real entry is
// what proves the wiring is live today; and filling one in later is then a single
// function body, with no edit to cartypes.js and no chance of a type being left
// behind.
//
// Each delegates to whichever of the two shipped tactics is the closest
// approximation, so the road already drives sensibly: the hunters flow through
// traffic, the heavies hold their lane.
//
// WHY `useArms` IS CALLED FROM EACH OF THESE and not from cruise/overtake, which
// would be one call site instead of four: those two are the CIVILIAN tactics as
// well, and the next step is per-behaviour differentiation — a weaver that lays
// mines where a pursuer shoots. Splitting the call now means that step edits
// these four bodies and nothing else. Today all four ask for the same thing
// (game/armament.js decides what that is), so the difference costs nothing yet.
//
// Arms are used AFTER the driving is decided, always. Nothing a car shoots at
// changes where it is going, and keeping that one-way makes the two halves
// separable — a tactic can be retuned without wondering what its trigger finger
// did to its line.

// Will steer onto the player's lateral offset and close the gap, instead of
// treating the player as just another obstacle to be passed.
function pursue(car, dt, world) {
  overtake(car, dt, world);
  useArms(car, world);
}

// Will line up behind the player and spend its speed on the impact, rather than
// braking for it. The one behaviour that deliberately does NOT keep a gap.
function ram(car, dt, world) {
  cruise(car, dt, world);
  useArms(car, world);
}

// Will match the player's lane from IN FRONT and hold station there, slowing to
// bottle the player up rather than driving away.
function block(car, dt, world) {
  overtake(car, dt, world);
  useArms(car, world);
}

// Will cross the road on a timer, alternating pass sides — hard to shoot and
// hard to predict, which is what a light, fast enemy is for.
function weave(car, dt, world) {
  overtake(car, dt, world);
  useArms(car, world);
}

// Will pair rigs nose-to-tail across adjacent lanes into a rolling roadblock the
// player has to thread or go round.
function convoy(car, dt, world) {
  cruise(car, dt, world);
}

const BEHAVIOURS = {
  cruise,
  overtake,
  pursue,
  ram,
  block,
  weave,
  convoy,
};

// Resolve a behaviour key. Unknown keys fall back to cruising rather than
// throwing: a half-finished type in the catalogue should still drive.
export function behaviourFor(name) {
  return BEHAVIOURS[name] ?? cruise;
}
