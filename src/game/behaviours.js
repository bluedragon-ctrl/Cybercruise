// Traffic AI — one function per tactic, picked by a car type's `behaviour` key.
//
// THE CONTRACT
//   behave(car, dt, world)
//     car    the TrafficCar being driven (see traffic.js)
//     dt     seconds since the last logic tick (fixed, see engine/loop.js)
//     world  { player, distance, cars, playerBody, W, H } — the read-only view of
//            everything else. `cars` is every live traffic car including this
//            one; `playerBody` is the player expressed in ROAD coordinates
//            (worldY / offset / w / h / speed), which is the form to compare
//            against a car. Reach for `player` only for things the body doesn't
//            carry, and never write to either.
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
// Behaviours are also free to be STATEFUL by stashing fields on `car` (a timer,
// a chosen lane) — each car is a plain object owned by one behaviour for life.
//
// Phase 3 ships two real tactics, `cruise` and `overtake`. The enemy tactics
// (`pursue`, `ram`, `block`, `weave`, `convoy`) exist as STUBS at the bottom of
// this file: the car types already name them, so Phase 4 is a matter of filling
// in a function body, not of rewiring the catalogue.

import { laneAt, laneOffset, ROAD_HALF_WIDTH } from "./road.js";

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
  return world.playerBody ? occupies(world.playerBody) : false;
}

// Whichever of two lead cars is nearer (either may be null).
function nearer(a, b) {
  if (!a) return b;
  if (!b) return a;
  return a.worldY <= b.worldY ? a : b;
}

// --- Phase 4 tactics: stubs -------------------------------------------------
// Every car type in the catalogue names the behaviour it will EVENTUALLY have,
// and each of those names resolves to a real function here that currently
// delegates to `cruise` or `overtake`. Named stubs rather than pointing the types
// at `cruise` directly, for two reasons: behaviourFor falls back silently on an
// unknown key, so a real entry is what proves the wiring is live today; and
// filling one in later is then a single function body, with no edit to
// cartypes.js and no chance of a type being left behind.
//
// Each stub delegates to whichever of the two shipped tactics is the closest
// approximation, so the road already drives sensibly: the hunters flow through
// traffic, the heavies hold their lane.

// Will steer onto the player's lateral offset and close the gap, instead of
// treating the player as just another obstacle to be passed.
function pursue(car, dt, world) {
  overtake(car, dt, world);
}

// Will line up behind the player and spend its speed on the impact, rather than
// braking for it. The one behaviour that deliberately does NOT keep a gap.
function ram(car, dt, world) {
  cruise(car, dt, world);
}

// Will match the player's lane from IN FRONT and hold station there, slowing to
// bottle the player up rather than driving away.
function block(car, dt, world) {
  overtake(car, dt, world);
}

// Will cross the road on a timer, alternating pass sides — hard to shoot and
// hard to predict, which is what a light, fast enemy is for.
function weave(car, dt, world) {
  overtake(car, dt, world);
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
