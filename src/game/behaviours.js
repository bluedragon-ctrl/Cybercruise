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
// Phase 3 ships `cruise` and `overtake`. The pursuit/ram/shoot tactics land in
// Phase 4 as further entries in this table, and existing types switch over by
// changing one string in cartypes.js.

import { laneAt, laneOffset, ROAD_HALF_WIDTH } from "./road.js";

// Clear road a cruising car wants between its nose and the tail of the car in
// front, in world units, plus a term for how fast it is closing. Traffic can
// only shed speed at traffic.js's ACCEL, and shedding dv takes dv²/(2*ACCEL)
// units of road; one second of closing rate covers that for every dv the
// catalogue can produce, so a follower always has room to match rather than
// running into the car ahead.
const FOLLOW_GAP = 40;
const FOLLOW_REACTION = 1.0; // seconds of closing rate added to the gap

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
// inside the gap this car needs at its current closing rate, its own cruising
// speed outside it (or with the road clear).
function followSpeed(car, lead) {
  if (!lead) return car.cruiseSpeed;
  const gap = lead.worldY - car.worldY - (lead.h + car.h) / 2;
  const closing = Math.max(0, car.speed - lead.speed);
  const needed = FOLLOW_GAP + closing * FOLLOW_REACTION;
  return gap < needed ? Math.min(car.cruiseSpeed, lead.speed) : car.cruiseSpeed;
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

  car.targetSpeed = followSpeed(car, lead);
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

const BEHAVIOURS = {
  cruise,
  overtake,
};

// Resolve a behaviour key. Unknown keys fall back to cruising rather than
// throwing: a half-finished type in the catalogue should still drive.
export function behaviourFor(name) {
  return BEHAVIOURS[name] ?? cruise;
}
