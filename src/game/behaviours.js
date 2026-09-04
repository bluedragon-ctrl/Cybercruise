// Traffic AI — the manoeuvres a car knows, and the order they are decided in.
//
// THE CONTRACT
//   driveCar(car, dt, world)
//     car    the TrafficCar being driven (see traffic.js)
//     dt     seconds since the last logic tick (fixed, see engine/loop.js)
//     world  { player, distance, cars, obstacles, playerBody, W, H } — the
//            read-only view of everything else. `cars` is every live traffic car
//            including this one; `obstacles` is every live road hazard
//            (game/obstacles.js); `playerBody` is the player expressed in ROAD
//            coordinates (worldY / offset / w / h / speed), which is the form to
//            compare against a car. Reach for `player` only for things the body
//            doesn't carry, and never write to any of them.
//
// A behaviour only ever sets INTENT on the car:
//     car.targetOffset  where it wants to be across the road (lateral px from
//                       the centre-line — see road.js laneOffset)
//     car.targetSpeed   how fast it wants to go (world units/sec)
// traffic.js then integrates that intent under the car type's limits
// (`steerSpeed`, acceleration) and keeps it on the tarmac. Behaviours must not
// write car.offset / car.speed / car.worldY directly, or a truck would corner
// like a roadster and the physics would live in two places.
//
// THE TWO EXCEPTIONS — the only things a behaviour may DO rather than intend —
// are the world's own hooks, because putting a bullet or a mine into the world
// is not something the car's own physics can integrate later:
//     world.fireShot(car, weaponType, dir, dx)  a round leaves the muzzle, +1
//                                           up the road or -1 back down it;
//                                           dx (optional, 0 by default) is a
//                                           lateral offset — armament.js's
//                                           shoot() calls this once per
//                                           muzzleOffsets() entry, so a paired
//                                           weapon (weapons.js's `twin`) is
//                                           two calls, not a second hook
//     world.dropMine(car, obstacleType)     a mine is laid behind the car;
//                                           returns whether there was room
// Both are wired up in main.js and are OPTIONAL: they keep this file and
// traffic.js free of any import of projectiles.js or obstacles.js. Neither is
// called from here directly — game/armament.js decides when.
//
// --- THE THREE STAGES ---------------------------------------------------------
//
// `driveCar` is the whole of what traffic.js calls, and it runs the same three
// stages for every car on the road, in this order and never another:
//
//   1. TACTIC   the manoeuvre — cruise, overtake, and the hostile ones. Sets
//               both halves of the intent. This is the part a car type chooses,
//               by naming a `behaviour`.
//   2. REFLEX   `avoidHazards`. Runs for EVERYONE, whatever the tactic, and may
//               override the intent laterally: finishing an overtake is never
//               worth driving over a mine.
//   3. ARMS     `useArms`, for anything carrying something. Last, always —
//               nothing a car shoots at changes where it is going, and keeping
//               that one-way is what makes the two halves separable.
//
// --- WHERE THE NUMBERS LIVE ---------------------------------------------------
//
// Not here. Every tuning constant below reads off `car.drive`, the DRIVING
// PROFILE its type names (game/driving.js) — so a timid overtaker and an
// impatient one are two rows of a data table rather than two functions.
//
// The only constants this file owns are CONTRACTS WITH ANOTHER FILE, never a
// matter of taste, and there are five:
//
//   HAZARD_DODGE_SPAN, HAZARD_SAFETY   where obstacles.js may place a hazard
//   RAID_LEAD, RAID_CLEARANCE          armament.js's own mine window and aim
//   TRAIL_ENGAGE                       the gap at which a shot is possible at all
//   FLIGHT_MARGIN                      how far off the road an airborne car may
//                                      fly and still be wholly in frame
//
// Each is derived from a figure another module owns, so pinning it to a driving
// profile would let a retune quietly break the other file's assumption. Every
// one is marked where it is defined.
//
// Behaviours are free to be STATEFUL by stashing fields on `car` (a timer, a
// chosen lane) — each car is a plain object owned by one behaviour for life.

import { laneAt, laneOffset, LANE_COUNT, LANE_WIDTH, ROAD_HALF_WIDTH } from "./road.js";
// The road's own sideways travel, from the one file that owns the road's shape
// — road.js reads it from here too and does not re-export it. See FLIGHT_MARGIN.
import { ROAD_AMPLITUDE } from "./tuning.js";
import { useArms, MINE_RANGE, MINE_AIM } from "./armament.js";
import { impactCost, SIDE_DAMAGE } from "./collisions.js";

// --- Following ---------------------------------------------------------------

// The speed to ask for while `lead` is in the way — the lead car's speed once
// inside the gap this car needs at its current closing rate, `desired` outside it
// (or with the road clear).
//
// `desired` is a parameter rather than car.cruiseSpeed because an overtaking car
// wants MORE than its cruise (see passSpeed): the braking rule and the "how fast
// do I want to go" question are separate, and a car making a pass still has to
// brake for whatever is in front of it.
//
// The gap wanted is `followGap` plus a closing term, both off the driving
// profile. Traffic can only shed speed at traffic.js's ACCEL, so the pair is a
// REAL CONSTRAINT rather than free tuning — see driving.js's followReaction and
// test/hazards.test.js.
function followSpeed(car, lead, desired = car.cruiseSpeed) {
  if (!lead) return desired;
  const gap = lead.worldY - car.worldY - (lead.h + car.h) / 2;
  const closing = Math.max(0, car.speed - lead.speed);
  const needed = car.drive.followGap + closing * car.drive.followReaction;
  return gap < needed ? Math.min(desired, lead.speed) : desired;
}

// The nearest thing ahead of `car` that it would run into if it drove the line
// at `offset`, or null if that line is clear. `ignore` is the one body to look
// past — the car being overtaken, which is beside the pass line and not in it.
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
    // it at the end of the tick. It is about to explode and leave nothing solid
    // behind, so it is not something to brake for.
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

// --- What a driver is willing to hit ------------------------------------------
//
// One mechanism, two tolerances — see driving.js's nerve section for why they
// are separate numbers. Both are hull damage against an ESTIMATE of what the
// thing would cost. A hazard names its own price (`threat`, obstacles.js); a
// car's uses collisions.js's own formula, not a copy, since a driver deciding
// against arithmetic the game doesn't run is wrong exactly where it matters.
//
// LATERAL ONLY. A lane change risks arriving SIDEWAYS into somebody, so it is
// priced as a side-swipe at this car's steering rate. The head-on component is
// not a risk this decision takes — a car pulling in ahead of something slower
// brakes for it (followSpeed) — and pricing it in would make every lane change
// look lethal to a fast car and freeze it in its lane.
//
// `other`'s own `attackFloor` rides along, same as it does inside
// applyDamage — the player's PlayerBody is the one body that ever sets it (a
// maxed RAM PLATE, collisions.js). Nothing in today's catalogue has both a
// steerSpeed in the gap that opens up (RAM_MAXED_ATTACK_FLOOR to
// collisions.js's DAMAGE_FLOOR — both still under tuning) and a nonzero
// `contact` ceiling, so this changes no decision yet — it exists so a
// driver's ESTIMATE never diverges from the solver's own arithmetic, per this
// function's header.
function contactCost(car, other) {
  return impactCost(car, other, car.type.steerSpeed, SIDE_DAMAGE, other.attackFloor);
}

// Would this driver accept putting itself where `other` is?
//
// A CEILING OF ZERO MEANS "NOBODY", not "anybody it happens to be free to hit".
// `contactCost` is zero whenever the car's own steering rate is under the
// floor it's priced against — collisions.js's DAMAGE_FLOOR against ordinary
// traffic, so a car steering slower than that floor prices every lane change
// at nothing, and `0 <= 0` would wave all of them through. Read the ceiling
// off the PROFILE rather than the rolled figure, so a car that merely rolled
// low is still just a timid car and not a special case.
function tolerated(car, other) {
  if (other.threat !== undefined) return other.threat <= car.nerve;
  if (car.drive.contact <= 0) return false;
  return contactCost(car, other) <= car.contact;
}

// --- Lane discipline ----------------------------------------------------------
//
// NOTHING ELSE RE-DERIVES WHICH LANE A CAR BELONGS IN. `cruise` never wrote
// `targetOffset` and `startPass` returns early with nobody to pass, so without
// this a car shoved sideways by a ram steers back across live traffic to the
// lane it spawned in, however many manoeuvres ago that was.
//
// `laneDiscipline` (driving.js) is a TOLERANCE, not a strength: the car accepts
// sitting up to (1 - discipline) of a half-lane off centre and holds whatever
// line it is on inside that. At 1 the slack is zero; at 0.3 it settles anywhere
// in the middle two thirds and reads as sloppier without ever wandering.
//
// "Move just far enough to be inside the slack", NOT "snap to the centre once
// outside it" — snapping would leave the tolerance deciding only WHEN a car
// corrected, with every profile still arriving dead centre.
function keepLane(car, world) {
  const home = homeLane(car, world);
  const slack = LANE_WIDTH * 0.5 * (1 - car.drive.laneDiscipline);
  const off = car.offset - home;
  // Inside the slack: hold this line. Written as an explicit intent rather than
  // left alone, so a stale target from a finished manoeuvre can't keep steering.
  if (Math.abs(off) <= slack) car.targetOffset = car.offset;
  else car.targetOffset = home + Math.sign(off) * slack;
}

// The lane centre this car is aiming to sit at: the one it is in, or its
// preferred one when that is free.
//
// A preference is never worth a lane change through traffic. Without that gate a
// car with a `laneHome` would grind across the road at every opportunity, which
// is worse driving and — since every swerve is a collision — actively dangerous.
function homeLane(car, world) {
  const here = laneOffset(laneAt(car.offset));
  const pref = car.drive.laneHome;
  if (pref === "any") return here;

  const want = laneOffset(preferredLane(pref, car.offset));
  if (want === here) return here;
  return blocked(car, null, want, world, car.drive.passLookAhead) ? here : want;
}

// The index of the lane this preference wants, on whichever side of the road the
// car is already on — crossing the centre-line to reach the far outer lane is not
// what "keep out of the way" means. Derived from LANE_COUNT rather than written
// out, so a wider road doesn't silently break it.
function preferredLane(pref, offset) {
  const right = offset >= 0;
  if (pref === "inner") {
    return right ? Math.ceil(LANE_COUNT / 2) : Math.floor(LANE_COUNT / 2) - 1;
  }
  return right ? LANE_COUNT - 1 : 0;
}

// --- Cruising ------------------------------------------------------------------

// Drive on, holding a lane and a steady speed — but don't drive INTO whatever is
// in front, traffic or player. Cars do collide (collisions.js), so this is what
// separates an accident from ordinary traffic: without it every faster car would
// grind through the queue ahead of it, and the player would be rear-ended
// constantly rather than as a consequence of driving badly.
function cruise(car, _dt, world) {
  keepLane(car, world);
  car.targetSpeed = followSpeed(car, leadCar(car, world, car.offset, null));
}

// --- Overtaking -----------------------------------------------------------------
// Cruising alone makes a fast car queue politely behind a slow one forever, which
// on a four-lane road looks broken — and it means the player can hold up the whole
// road by sitting in one lane.
//
// The manoeuvre is COMMITTED: a car picks a side once, holds that line until it
// is past (or gives up), and doesn't re-decide every tick. Re-deciding is what
// makes traffic AI dither in the mirror, and here it would also mean cars jinking
// sideways into each other, since every swerve is a collision.

// The speed a car wants while it is actually alongside something. A pass driven
// at cruise speed runs at whatever margin the two cruise speeds happen to differ
// by, which is why passes used to expire on timeout rather than finish.
//
// UNCAPPED HERE: traffic.js clamps every targetSpeed to the type's own
// speedMax after driveCar returns, so the largest closing speed the road can
// produce is still a catalogue figure that does not move — this just doesn't
// have to say so itself. A type whose `speedMax` equals its `cruiseMax`,
// which is most of the catalogue, therefore passes at cruise and gets nothing
// from `passEffort`; opening that gap on a type is what buys it a pass with
// something behind it, and it buys it for that type alone.
function passSpeed(car) {
  return car.cruiseSpeed * car.drive.passEffort;
}

// Drive on, but go around whatever is in the way rather than sitting behind it.
// Otherwise identical to cruising: this still brakes for the car in front, so a
// pass that can't be completed degrades to following instead of a rear-end.
function overtake(car, dt, world) {
  if (car.passTarget) {
    holdPass(car, dt);
  } else {
    keepLane(car, world);
    startPass(car, dt, world);
  }

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

// Commit to a pass if there's something worth passing, a side to do it on, and
// this driver has been held up long enough to care.
//
// `heldTime` counts the seconds this car has spent behind something it would
// rather be in front of, and is reset the moment that stops being true — so the
// timer measures frustration, not the age of the car. Without it every overtaker
// is equally twitchy and the only difference between drivers is steering rate.
//
// Behaviour state lives on the car (see the contract above): `passTarget` is the
// body being passed, `passSide` -1/+1 the side chosen, `passTime` its age.
function startPass(car, dt, world) {
  const d = car.drive;
  const lead = leadCar(car, world, car.offset, null);
  if (!lead) return (car.heldTime = 0);

  // Only a car that is actually holding us up is worth the risk.
  if (car.cruiseSpeed <= lead.speed + d.passSpeedMargin) return (car.heldTime = 0);
  if (lead.worldY - car.worldY - (lead.h + car.h) / 2 > d.passTrigger) {
    return (car.heldTime = 0);
  }

  car.heldTime += dt;
  if (car.heldTime < d.patience) return;

  // Try the side away from wherever the blocker sits relative to us first: that's
  // the side we're already drifting toward, and it's the shorter move.
  const first = lead.offset <= car.offset ? 1 : -1;
  // FROM THE BLOCKER'S NOSE, not its centre, the same way `passTrigger` above
  // measures a bumper-to-bumper gap: `passLookAhead` is the clear road wanted
  // BEYOND the car being passed, and measuring it from a centre point quietly
  // spent the blocker's own rear half on it — 78 units of real daylight past a
  // rig against 113 past a roadster, least road checked exactly where the pass
  // takes longest. The profile figure now means the same thing whatever it is
  // overtaking.
  const look = lead.worldY + lead.h / 2 - car.worldY + d.passLookAhead;
  for (const side of [first, -first]) {
    const line = passLine(car, lead, side);
    if (line === null) continue;                    // barrier that side
    if (blocked(car, lead, line, world, look)) continue; // someone already in it
    car.passTarget = lead;
    car.passSide = side;
    car.passTime = 0;
    car.heldTime = 0;
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
  const past = -gap > (car.h + target.h) / 2 + car.drive.passMargin; // nose clear
  const gone = gap > car.drive.passTrigger * 2;                      // it drove off
  if (!target.alive || past || gone || car.passTime > car.drive.passTimeout) {
    endPass(car);
    return;
  }

  const line = passLine(car, target, car.passSide);
  if (line === null) endPass(car); // it drifted into the barrier we were using
  else car.targetOffset = line;
}

// Back to ordinary driving. The lane is not chosen here: keepLane picks one up on
// the next tick from wherever the car actually ended up, which is the same answer
// and only written once.
function endPass(car) {
  car.passTarget = null;
}

// The lateral offset to drive at to clear `target` on `side`, or null if the
// barrier is in the way there.
function passLine(car, target, side) {
  const offset =
    target.offset + side * ((car.w + target.w) / 2 + car.drive.passClearance);
  const limit = ROAD_HALF_WIDTH - car.w / 2;
  return Math.abs(offset) > limit ? null : offset;
}

// Daylight wanted BEHIND the overlap, and the whole of what this driver chooses
// rather than measures. A swerve is not instant — around 0.4s to cross a lane at
// the fleet's steerSpeeds — so a body just past the overlap line when the
// decision is taken can be alongside by the time the car arrives. Shared rather
// than per-profile because it is a fact about how long a lane change takes, and
// every driver's takes about as long.
//
// It is a MARGIN, not the test: what counts as "beside me" is the two bodies'
// own lengths, and `blocked` derives that below.
export const LOOK_BEHIND_SLACK = 30;

// Is anything this driver won't touch in the stretch of road the line at `line`
// would use? `lookAhead` is how far up the road to care about, measured from the
// car — a pass looks past the body it is overtaking, a lane preference only as
// far as the road it is about to occupy.
//
// BEHIND IS NOT A MIRROR CHECK, and the field it replaced (`passLookBehind`) read
// like one. Nothing on this road reacts to a car behind it — braking is
// `leadCar`, which searches forward only. `worldY` is a CENTRE point, so a body
// whose centre trails this car's by less than their combined half-length is not
// behind it at all, it is ALONGSIDE, and a lane change would steer into its
// flank. So the question is "is the space I am about to move into empty", and
// the answer has to include the space beside this car's own back bumper.
//
// WHICH MAKES IT GEOMETRY, and it is now derived like the lateral test directly
// above it, from the pair's own `h` exactly as that one uses their `w`. It was a
// tuned 90 on the driving profile, which could not be right for every pair it
// met: against a roadster 90 was 33 units of slack, against a rig it was two
// units SHORT of the overlap, so a rig dodging a hazard could steer into a bus
// it never saw. One number cannot answer a question whose answer depends on who
// else is there.
//
// TOLERANCE IS WHAT MAKES THIS PER-DRIVER: it answers "is there anything there
// that I mind" rather than "is anyone there", so a sedan is stopped by a
// neighbour that a roadster will squeeze past.
//
// Checked once, when committing: during a pass, traffic that moves in is handled
// by braking (see overtake) rather than by abandoning the line mid-swerve.
function blocked(car, ignore, line, world, lookAhead) {
  const to = car.worldY + lookAhead;
  const inTheWay = (other) => {
    if (other === car || other === ignore) return false;
    if (!other.alive) return false; // a corpse must not veto a line — see leadCar
    if (Math.abs(other.offset - line) >= (other.w + car.w) / 2) return false;
    const from = car.worldY - ((car.h + other.h) / 2 + LOOK_BEHIND_SLACK);
    if (other.worldY <= from || other.worldY >= to) return false;
    return !tolerated(car, other);
  };
  for (const other of world.cars) if (inTheWay(other)) return true;
  // Road hazards veto a line exactly as a car does — swerving out of a queue
  // into a tank trap is not an overtake.
  for (const other of world.obstacles ?? []) if (inTheWay(other)) return true;
  return world.playerBody ? inTheWay(world.playerBody) : false;
}

// Whichever of two lead cars is nearer (either may be null).
function nearer(a, b) {
  if (!a) return b;
  if (!b) return a;
  return a.worldY <= b.worldY ? a : b;
}

// --- Road hazards ---------------------------------------------------------------
//
// An obstacle (game/obstacles.js) is NOT traffic, and that decides everything.
// Traffic is something you QUEUE behind — it moves, so matching its speed still
// gets you where you were going. A roadblock never moves, so following one is
// never the answer while there is a lane to take.
//
// STEER FIRST, and slow down for the same reason: going slower cannot let a
// stationary hazard get away, it buys SECONDS OF APPROACH, which is exactly
// what a lane change costs. A swerve that won't fit in the road left always
// fits by taking longer over it.
//
// THE THREE OUTCOMES, cheapest first:
//   1. steer to the nearest lane clear of the hazard and of anything this
//      driver isn't willing to touch;
//   2. whatever the line, slow enough that the sideways move fits in the road
//      remaining — a FLOOR on the tactic's speed, never a target, so a car with
//      room passes at full cruise and never knows this ran;
//   3. no lane at all: STOP (hazardStop).
//
// No "clear of the HAZARD but has a car in it" tier: that trade is `contact`
// (driving.js), per driver. One who accepts the bump finds the lane clear at
// step 1; one who won't reaches step 3.
//
// DODGES AIM AT LANE CENTRES, which removes any need for a "pull back in" step
// and keeps the dodge STABLE — fixed candidate lines mean a car holds its
// choice instead of hunting between two near-equal offsets.
//
// WHY STEERING IS USUALLY ENOUGH: obstacles.js refuses to place a hazard in the
// last open lane, so a lane clear of the HAZARD always exists. Clear of TRAFFIC
// too is not guaranteed — which is when stopping is the answer. Asserted in
// test/hazards.test.js.

// How far ahead a driver looks is DERIVED, not constant: a rig steers at 35px/sec
// and a cycle at 180 while arriving nearly four times faster, so one number cannot
// be right for both. It is the time this car needs to slide clear times the speed
// it is closing at — and a hazard never moves, so that is simply its own speed.
//
// TWO lane widths, and what sets it is not width: every block in the catalogue
// fits in or beside a lane. The binding case is the MINE, because PLACE_ANY
// (obstacletypes.js) lets it land BETWEEN two lane centres and spoil both. Worst
// case is a rig in the outer lane with a mine at -72 — the nearest lane centre it
// can take is the third one over, 130px away, exactly two lane widths.
//
// NOT ON THE PROFILE, unlike everything else in this file: these feed
// `dodgeDistance`, and obstacles.js sizes its spawn margin against that, so they
// are a contract about WHERE A HAZARD MAY BE PLACED rather than about how a
// driver feels on meeting one. The feeling is `nerve`.
const HAZARD_DODGE_SPAN = 2; // lane widths a dodge may have to cover
const HAZARD_SAFETY = 1.3;   // slack, so a car arrives already clear rather than
                             // finishing its swerve exactly at the obstacle

// Road a car needs to see a hazard coming and be clear of it. Exported because it
// is a CONSTRAINT ON WHERE HAZARDS MAY BE PLACED: obstacles.js has to spawn far
// enough ahead that every car in the catalogue gets at least this much road, or
// the slowest-steering types are asked to dodge something they physically cannot
// avoid. Asserted in test/hazards.test.js.
export function dodgeDistance(speed, steerSpeed) {
  return speed * ((LANE_WIDTH * HAZARD_DODGE_SPAN) / steerSpeed) * HAZARD_SAFETY;
}

// World units ahead `car` reads the road for hazards.
function hazardLookahead(car) {
  return dodgeDistance(car.speed, car.type.steerSpeed);
}

// The nearest hazard `car` would drive into on the line at `offset`, or null if
// that line is clear. Same lateral-overlap test leadCar uses, for the same reason.
function hazardAhead(car, world, offset, lookahead) {
  let best = null;
  let bestGap = Infinity;
  const clearance = car.drive.hazardClearance;
  for (const o of world.obstacles) {
    if (!o.alive) continue;
    const gap = o.worldY - car.worldY;
    if (gap <= 0 || gap > lookahead || gap >= bestGap) continue;
    if (Math.abs(o.offset - offset) >= (o.w + car.w) / 2 + clearance) continue;
    bestGap = gap;
    best = o;
  }
  return best;
}

// The scratch body a hazard is presented as when a car gives up on going round —
// see hazardStop. Module-level and reused, because this file allocates nothing
// per tick and a per-call object here would be one per car per frame.
const STOPPER = { worldY: 0, h: 0, speed: 0 };

// Stop short of a hazard there is no way around.
//
// This deliberately reverses the rule the section header states, and the reversal
// is the point: following a hazard is never the answer WHILE A LANE IS AVAILABLE,
// and is exactly the answer when none is. Presenting it to `followSpeed` as a
// lead car doing zero makes that one line rather than a second braking rule — and
// it comes with `followGap` for free, so the car stops a car's length short
// instead of nose to the barrier.
//
// A stopped car in front of a roadblock is not a dead end: whatever was in the
// clear lane is traffic, so it moves on, the lane opens, and the car steers into
// it and accelerates away.
function hazardStop(car, hazard) {
  STOPPER.worldY = hazard.worldY;
  STOPPER.h = hazard.h;
  const capped = followSpeed(car, STOPPER, car.targetSpeed);
  if (capped < car.targetSpeed) car.targetSpeed = capped;
}

// Steer around anything in the way that this driver isn't willing to eat. Stage
// 2 of driveCar: runs for every car, after whatever the tactic decided.
function avoidHazards(car, world) {
  if (!world.obstacles || world.obstacles.length === 0) return;

  // Check the line the car is ON and the line it is HEADING FOR, and react to
  // whichever hazard comes first. Mid-pass those are different lines, and a car
  // that only watched one would either swerve into a hazard it was steering
  // toward or ignore one it is still sitting on top of.
  const lookahead = hazardLookahead(car);
  const hazard = nearer(
    hazardAhead(car, world, car.offset, lookahead),
    hazardAhead(car, world, car.targetOffset, lookahead),
  );
  if (!hazard) return;

  // NERVE: some drivers take the hit rather than lift off their line. Rolled ONCE
  // at spawn (traffic.js) from the profile's ceiling, so a barger is a barger for
  // life — a fresh coin flip per tick would make a car swerve and unswerve all
  // the way down the road.
  if (hazard.threat <= car.nerve) return;

  // The nearest lane centre that works, walked by index rather than sorted into a
  // list, since this runs per car per tick and this file allocates nothing. TWO
  // CANDIDATES per lane, differing only in the TRAFFIC in it:
  //   best     clear of the hazard AND of anything this driver won't touch
  //   refuge   clear of the HAZARD, whoever else is standing in it
  // A line that is still hazardous is never either — the one thing not traded away.
  const look = hazard.worldY - car.worldY + car.drive.passLookAhead;
  let best = null;
  let bestDist = Infinity;
  let refuge = null;
  let refugeDist = Infinity;
  for (let i = 0; i < LANE_COUNT; i++) {
    const line = laneOffset(i);
    const dist = Math.abs(line - car.offset);
    if (hazardAhead(car, world, line, lookahead)) continue;

    if (dist < refugeDist) {
      refugeDist = dist;
      refuge = line;
    }
    if (dist >= bestDist) continue;
    if (blocked(car, hazard, line, world, look)) continue;
    bestDist = dist;
    best = line;
  }

  // NOWHERE THIS DRIVER WILL GO: stop — and get off the hazard's line anyway.
  //
  // Stopping alone is not enough, and measuring the road is what showed it: a car
  // that braked to a standstill held whatever line it was on, which is by
  // definition the line with the roadblock in it. It then sat there as a
  // stationary object in a live lane until something rear-ended it and shunted it
  // into the very thing it had stopped for — every civilian hazard strike in a 15
  // car-minute sample was that, and nothing else.
  //
  // So the refuge is taken even though there is somebody in it. The car has
  // already given up its speed, so the contact it accepts here is a nudge at
  // walking pace rather than a swipe at cruise.
  if (best === null) {
    hazardStop(car, hazard);
    if (refuge !== null) car.targetOffset = refuge;
    return;
  }
  car.targetOffset = best;

  // Slow down enough that the swerve fits in the road that is left. Applied as a
  // CEILING on whatever the tactic asked for, so this only ever takes speed away,
  // and only from a car that genuinely cannot make it.
  if (bestDist <= 0) return; // already in the lane it wants — nothing to fit in
  const seconds = bestDist / car.type.steerSpeed;
  const gap = Math.max(0, hazard.worldY - car.worldY - (hazard.h + car.h) / 2);
  const safe = gap / seconds;
  if (safe < car.targetSpeed) car.targetSpeed = Math.max(0, safe);
}

// --- Going after the player ------------------------------------------------

// Steer onto `target`'s own line, or hold the current one when this driver won't
// take whatever is standing in it. The shared half of every hostile tactic —
// `raid`, `trail`, `ram` and `pursue` all want to be on the player's line at some
// point in their lives.
//
// HOLDING THE LINE WHEN BLOCKED IS NOT A NO-OP. Doing nothing on that branch
// leaves the car steering toward wherever the player was several ticks earlier,
// quite possibly into the traffic that blocked it — the same stale-intent failure
// `keepLane` exists to end.
//
// The player is passed as `ignore` in every case: lining up with them is the
// entire point, so they are never a reason to hold back.
function trackTarget(car, target, world) {
  // `roadMargin` (cartypes.js) is 0 for every wheeled type, so `excursion`
  // and the widened clamp below are both no-ops for them — see the skirted
  // barge's own entry for the one type that sets it, and traffic.js's
  // `clampToRoad` for the other half of the same contract.
  const margin = car.type.roadMargin ?? 0;
  // LEANS FURTHER PAST THE PLAYER'S OWN LANE THE NEARER THEY ALREADY ARE TO
  // AN EDGE, scaled linearly from nothing at the centre-line to the full
  // margin at the true barrier. Matching `target.offset` exactly (as every
  // wheeled car does) only ever grazes the barrier by half this car's own
  // width; a margin-carrying car instead OVERSHOOTS in the same direction
  // the player is already leaning, which is what puts its hull's centre
  // past the tarmac rather than merely its edge — see the skirted barge's
  // own `roadMargin` note for why that distinction is the whole point.
  const excursion = margin * (target.offset / ROAD_HALF_WIDTH);
  const limit = ROAD_HALF_WIDTH + margin - car.w / 2;
  const want = Math.max(-limit, Math.min(limit, target.offset + excursion));
  const clear = !blocked(car, target, want, world, car.drive.passLookAhead);
  car.targetOffset = clear ? want : car.offset;
}

// --- Raiding -------------------------------------------------------------------
//
// The cycle. No gun (armament.js's `raider` profile) — its only attack is a
// single mine, which counts for anything only when laid ahead of the player, in
// their lane, inside the mine layer's own window (MINE_MIN_LEAD..MINE_RANGE). So:
// force past whatever's in front, hold station toward the FAR end of that window
// with the player's lane taken, drop one mine, done.
//
// TWO PHASES. Getting past whatever is in the way is exactly the overtake
// manoeuvre already written, so phase one simply IS overtake, aimed at the player.
// Holding station ahead of a moving target is a different problem (match its
// speed, don't out-pace it), so it gets its own logic.
//
// THE PHASE SPLIT IS ON RAID_LEAD, NOT MINE_MIN_LEAD, and that is load-bearing:
// armament.js's `layMine` checks only its OWN window and aim, and MINE_AIM is
// generous enough (two thirds of a lane) that merely being in the lane next to
// the player during an ordinary pass satisfies it. So phase one actively holds
// clear of MINE_AIM around the player, and only at RAID_LEAD swings onto their
// line — which is what actually gates the drop.
//
// The FAR end of the window, not the middle: laid at the near edge the mine
// appears almost on top of the player, a hit they never saw coming rather than
// one they had road left to dodge. Kept clear of MINE_RANGE's own ceiling so
// speed wobble never pushes the drop out of range.
//
// A CONTRACT WITH armament.js — MINE_RANGE minus slack, so it tracks that file's
// window automatically — which is why it stays here rather than on a profile.
const RAID_LEAD = MINE_RANGE - 40;
// How far clear of the player's own line phase one holds, beyond MINE_AIM itself
// — enough slack that this is unambiguously NOT lined up. A contract with
// armament.js's aim tolerance for the same reason as above.
const RAID_CLEARANCE = 15;
//
// The gain on the hold itself is not a contract and is not here: it is how
// tightly a given driver holds station, so it is `raidGain` on the profile.

function raid(car, dt, world) {
  const target = world.playerBody;
  const arms = car.arms;
  // Nothing left to do once the one mine is spent (or there's no player, or no
  // kit at all — a test fixture, say): drive on same as any other car, rather
  // than loitering in front of someone it has nothing left to hurt them with.
  if (!target || !arms || arms.layer.ammo < arms.layer.type.ammo) {
    cruise(car, dt, world);
    return;
  }

  const lead = car.worldY - target.worldY; // positive once clear ahead of them
  // Still closing on RAID_LEAD, or mid-pass: drive exactly like any overtaker, so
  // it genuinely gets past real traffic in its way — then, if that left it within
  // the mine layer's aim tolerance of the PLAYER specifically, nudge clear of
  // just that. A real pass against another car is left alone.
  if (lead < RAID_LEAD || car.passTarget) {
    overtake(car, dt, world);
    if (Math.abs(car.targetOffset - target.offset) <= MINE_AIM + RAID_CLEARANCE) {
      // Try the side already favoured first, but a player hugging a barrier can
      // clamp that side right back into range — fall back to the other rather
      // than silently staying aligned.
      const limit = ROAD_HALF_WIDTH - car.w / 2;
      const preferred = car.targetOffset >= target.offset ? 1 : -1;
      for (const side of [preferred, -preferred]) {
        const clear = Math.max(-limit, Math.min(limit, target.offset + side * (MINE_AIM + RAID_CLEARANCE)));
        if (Math.abs(clear - target.offset) > MINE_AIM + RAID_CLEARANCE - 1) {
          car.targetOffset = clear;
          break;
        }
      }
    }
    return;
  }

  // At the target distance: hold it rather than continuing to pull away, and NOW
  // line up on the player's own lane so the drop lands in their path. A line real
  // traffic already occupies is left alone — see trackTarget.
  trackTarget(car, target, world);

  const error = lead - RAID_LEAD;
  car.targetSpeed = Math.max(0, target.speed - error * car.drive.raidGain);
}

// --- Trailing --------------------------------------------------------------
//
// The stocker: `pursue` plus a give-up clock, which is the only part written
// here. It hangs off the player's back bumper and fires forward. "Shoots only
// forward" is enforced twice over — this function never asks for a lane the
// player is IN FRONT of, and weapons.js's `smg` refuses a rearward shot outright
// via its `forwardOnly` field.
//
// GIVES UP ON LOST CONTACT, NOT ON A CLOCK. `car.lostTime` is seconds since it
// was LAST in firing range, reset every tick back in range, so a car the player
// can't shake fights indefinitely. Only after `giveUpTime` continuously out of
// range does `car.disengaged` flip — one-way, handing driving to plain
// `overtake` forever. It goes unarmed at the same moment (`car.arms` nulled),
// so nothing in the retreat can line up a stray shot and a moment spent ahead
// of the player cannot read to armament.js as "ahead of my target".
//
// `giveUpTime` is a profile field (driving.js), where 0 means never and is the
// enemy baseline. The stocker is the only row that sets it.

// THE GAP THAT COUNTS AS "IN CONTACT", and a contract with armament.js rather
// than a free number, which is why it stays here while the rest of the chase
// figures moved onto the profile: a shot is only possible within ~304 units of
// the player (H - player.y, armament.js's visibleRoad, with the player framed at
// 62% down an 800px canvas) before GUN_RANGE's own 520 even comes into it. Kept
// under that with margin, so contact only counts once a shot is genuinely on the
// table.
//
// Exported for test/hazards.test.js, which asserts the relation to the
// profile's `pursueHold`: a stocker parked at its hold gap must count as in
// contact, or the give-up clock would run while the car was doing its job
// perfectly and it would ride off mid-engagement.
export const TRAIL_ENGAGE = 260;

function trail(car, dt, world) {
  const target = world.playerBody;
  if (!target) return cruise(car, dt, world);
  if (car.disengaged) return overtake(car, dt, world);

  // The bookkeeping, which runs whichever of `pursue`'s two modes is active —
  // that is why it sits here rather than inside the chase.
  const gap = target.worldY - car.worldY; // positive while it trails them
  if (gap <= TRAIL_ENGAGE) car.lostTime = 0;
  else car.lostTime += dt;

  // `> 0` is what makes the profile's "0 means never" true here rather than only
  // in its comment: without it a profile left at the baseline would disengage on
  // its very first tick out of range.
  const grace = car.drive.giveUpTime;
  if (grace > 0 && car.lostTime >= grace) {
    car.disengaged = true;
    car.arms = null; // rides off unarmed — see the header note above
    return overtake(car, dt, world);
  }

  pursue(car, dt, world);
}

// --- Ramming -----------------------------------------------------------------
//
// The bruiser. No gun, no mines (`arms: false` in the table below), so the only
// thing it spends on the player is its own mass. One idea — CLOSE THE GAP — in
// two modes, chosen only by which side of the player it is on.
//
// BEHIND OR ALONGSIDE: the attack. Lane tracking is the shared trackTarget, but
// the speed half is deliberately NOT `followSpeed` against the player — braking
// to avoid the thing this car exists to hit would be backwards. It asks for
// EVERYTHING THE TYPE HAS, `speedMax`, because there is no gap to hold and no
// reason to arrive at less than it can: damage is linear in closing speed
// (collisions.js). Whether that is enough to catch a fleeing player is the
// catalogue's answer, not this function's — the bruiser's 560 says no, and says
// why, in cartypes.js.
//
// AHEAD: the same job from the other side. Once it has passed, still tracking the
// player's lane while asking for LESS speed than they are running IS the block —
// the player either brakes to match a wall heavier than they are, or rear-ends it.
//
// THE BLOCK IS TWO NUMBERS AND THEY ARE ONE IDEA — "half their speed, but never
// under 80" — so both live here, next to the tactic, rather than one here and
// one on a driving profile where only half the sentence would be readable.

// The slowest the block may run, and A CONTRACT WITH player.js rather than a
// temperament: it sits UNDER the player's own minimum of 100, so lifting off can
// never escape a block, and above zero, because a stalled wall reads as broken
// rather than as a tactic. A profile could not state this correctly without
// knowing that 100, which is the test for whether a number belongs on a profile
// at all. The bruiser's own `speedMin` is 0 (cartypes.js), so this is the only
// thing setting the block's pace — a type floor above it would be a second,
// quieter answer to the same question.
export const RAM_FLOOR = 80;

// How much of the player's own speed the block runs at, which is what makes it
// bite at ANY speed rather than only at the one it was tuned against. A
// FRACTION for that reason, and half rather than a harder brake because the
// damage this tactic deals is symmetric — closing speed costs the bruiser hull
// on the same curve it costs the player (collisions.js), against a 160 hull to
// the player's 200. At 0.5 a block off a flat-out player is 48 hull to them and
// 33 to itself, about five before either dies; braking to RAM_FLOOR outright
// would make it 89 and 61, a mutual kill in three, which reads as a suicide
// rather than as a wall. THE TWO CROSS AT PLAYER SPEED 160 (0.5 * 160 = 80), so
// under that this figure is inert and RAM_FLOOR alone holds the block up.
export const RAM_BRAKE = 0.5;

function ram(car, dt, world) {
  const target = world.playerBody;
  if (!target) return cruise(car, dt, world);

  // Track the player's own lane: from behind or alongside this is what lines the
  // hit up, and ahead it's what keeps the block IN their path rather than a car
  // merely driving near them.
  trackTarget(car, target, world);

  // Still brake for REAL traffic in the way — the target itself is excluded,
  // because the one thing this tactic must never do is brake for the player.
  const lead = leadCar(car, world, car.offset, target);
  const ahead = car.worldY - target.worldY; // positive once past the player

  if (ahead > 0) {
    const held = Math.max(RAM_FLOOR, target.speed * RAM_BRAKE);
    car.targetSpeed = followSpeed(car, lead, held);
    return;
  }

  car.targetSpeed = followSpeed(car, lead, car.type.speedMax);
}

// --- Pursuing ------------------------------------------------------------------
//
// The interceptor, and the road's ONE chasing function: close in, hold a firing
// gap, never let go. `trail` is this plus a give-up clock, and `duel` falls back
// to it once the rival's mine is spent. Having no clock is what makes this read
// as the road's baseline pressure rather than a timed encounter.
//
// What each type FIRES is not this function's business — `useArms` reads whatever
// `car.arms` says. The two DISPOSITIONS are profile fields (driving.js's
// "Chasing the player"): `pursueHold` and `pursueGain`. How fast the chase may
// run is not one of them — that is the type's own `speedMax` (cartypes.js).

// The gap inside which chasing is worth doing at all, and NOT a disposition —
// which is why it sits here rather than on a profile with the other three. It is
// sized against `pursueHold` (200 at the baseline, 150 at the tightest) with
// room to spend a couple of seconds genuinely closing before the car must be in
// range: a figure about the SHAPE of the manoeuvre, the same kind of thing as
// TRAIL_ENGAGE below and RAID_LEAD above. Every profile ran the one number and
// none of them had a reason to differ.
export const PURSUE_RANGE = 500;

function pursue(car, dt, world) {
  const target = world.playerBody;
  if (!target) return cruise(car, dt, world);

  const gap = target.worldY - car.worldY; // positive while it trails them
  if (gap > PURSUE_RANGE) {
    // Not close enough to be worth actively chasing right now. No clock runs here
    // either way — this car waits for the gap to close again, however long that
    // takes. `trail` is what adds one.
    cruise(car, dt, world);
    return;
  }

  // Track the player's own lane directly, deferring to `blocked` so it won't
  // steer into traffic it doesn't tolerate to do it.
  trackTarget(car, target, world);

  // Hold the gap at `pursueHold`, but still brake for real traffic in the way
  // (the player itself is excluded from the lead search — the proportional term
  // is what governs distance to THEM).
  //
  // THE ASK HAS NO CEILING OF ITS OWN, and needs none: the P term is unbounded
  // above by design — at the edge of PURSUE_RANGE it asks for the player's
  // speed plus 360 — and traffic.js clamps the result to the type's `speedMax`
  // one step later, which is the only ceiling on the road. So the shape of the
  // chase is "match them, plus what the gap is worth, up to what this car is",
  // and the answer to "can this type close on the player" is one number in the
  // catalogue. The floor at 0 is all that is left to do here, since a negative
  // ask (the car well ahead of its hold) is a request to reverse.
  const lead = leadCar(car, world, car.offset, target);
  const held = target.speed + (gap - car.drive.pursueHold) * car.drive.pursueGain;
  car.targetSpeed = followSpeed(car, lead, Math.max(0, held));
}

// "This car has not laid its one deliberate charge yet." A full magazine means
// nothing has left the tube, so the tactics gated on it — `duel`'s mine and
// `strew`'s spike strip — need no state of their own. Same gate `raid` uses to
// retire itself.
function layerUnspent(car) {
  const layer = car.arms?.layer;
  return Boolean(layer) && layer.ammo === layer.type.ammo;
}

// --- Duelling --------------------------------------------------------------
//
// The rival: `raid`'s force-past-and-drop, then `pursue` for the rest of its life
// once that mine is gone — the two composed rather than a third driving model.
//
// ONE DELIBERATE MINE, NOT THREE — see `layerUnspent`. The other two rounds are
// not wasted, only never CHASED: `arms: true` keeps `useArms` running, and
// armament.js's `layMine` still fires opportunistically if the player ends up
// trailing this car anyway.
function duel(car, dt, world) {
  if (layerUnspent(car)) {
    raid(car, dt, world);
    return;
  }
  pursue(car, dt, world);
}

// --- Strafing ----------------------------------------------------------------
//
// The outrider (the RACER hull). `pursue` for the gap and the speed — it holds
// station off the player's back bumper exactly like the interceptor — and one
// difference on top: it does not SIT on the player's line, it sweeps back and
// forth ACROSS it, spraying the SMG forward as it crosses.
//
// WHY A BIKE CANNOT DO WHAT THE INTERCEPTOR DOES. `pursue` parks a car dead
// astern, fine for 70 hull of interceptor and suicidal for 30 of motorcycle:
// everything the player drops goes out the back, and a tail holding one line is
// a tail holding still over a mine. The weave is the answer — never on the line
// it was on a second ago — and it also turns a burst weapon into a scythe,
// where a fixed tail would put every round through the same square metre.
//
// The lateral aim is the player's own offset plus `weaveSpan` * sin(phase),
// with `weaveTime` seconds to the sweep. Both are profile fields (driving.js),
// and the pair is bounded by the type's steerSpeed — a sweep the steering
// cannot keep up with degenerates into a lazy drift, which test/hazards.test.js
// pins rather than leaves to be noticed.
//
// THE PHASE IS PER CAR AND RANDOM AT ITS FIRST TICK, so two outriders on the
// road together are not one machine drawn twice. Stashed on the car, which is
// what the header's "behaviours are free to be STATEFUL" allows.

function strafe(car, dt, world) {
  const target = world.playerBody;
  if (!target) return cruise(car, dt, world);

  // The chase itself, unmodified: the gap, the speed, and the tracking that
  // holds its own line when the player's is occupied.
  pursue(car, dt, world);

  // Out of range `pursue` is simply cruising, and a car cruising up the road
  // has nothing to weave around yet.
  const gap = target.worldY - car.worldY;
  if (gap > PURSUE_RANGE) return;

  car.weavePhase ??= Math.random() * Math.PI * 2;
  car.weavePhase += (dt / car.drive.weaveTime) * Math.PI * 2;

  const limit = ROAD_HALF_WIDTH - car.w / 2;
  const swept = target.offset + Math.sin(car.weavePhase) * car.drive.weaveSpan;
  const want = Math.max(-limit, Math.min(limit, swept));
  // Deferring to `blocked` on the same terms trackTarget does: the weave is a
  // way of being hard to hit, not a licence to steer into somebody. With the
  // swept line occupied, `pursue`'s own decision from above stands.
  if (!blocked(car, target, want, world, car.drive.passLookAhead)) car.targetOffset = want;
}

// --- Outrunning ---------------------------------------------------------------
//
// The outrunner (the CRUISER hull), and the mirror image of `pursue`: it fights
// its way PAST the player, holds station AHEAD of them, and shoots back down the
// road over its shoulder. Nothing else on this road attacks from in front —
// every other armed tactic camps behind — so this is the one hostile the player
// cannot answer by lifting off, and the one that makes the road ahead worth
// watching for something other than hazards.
//
// It runs on machinery that was already here rather than on a third chase model:
//
//   GETTING THERE   is a pass, so it is `overtake`, aimed at nothing in
//                   particular. A bike quicker than the player gets by on its
//                   own; a bike stuck behind traffic passes that first.
//   STAYING THERE   is `raid`'s hold, minus the mine: line up on the player's
//                   lane (trackTarget) and ask for THEIR speed corrected by the
//                   error on `leadHold`. It reads `raidGain` for the same
//                   reason `raid` does — holding station ahead of a target you
//                   must not out-pace is the tighter of the two problems.
//
// `leadHold` is a profile field, and it is the whole shot: armament.js takes a
// rearward one only inside GUN_RANGE and only inside the road the player can
// actually SEE ahead of them, so a hold beyond either end would be a hostile
// posing out of range. test/hazards.test.js pins it against both.

function outrun(car, dt, world) {
  const target = world.playerBody;
  if (!target) return cruise(car, dt, world);

  const lead = car.worldY - target.worldY; // positive once clear ahead of them
  // Still getting past, or mid-pass against real traffic: drive like any other
  // overtaker until the gap is made.
  if (lead < car.drive.leadHold || car.passTarget) {
    overtake(car, dt, world);
    return;
  }

  trackTarget(car, target, world);
  const error = lead - car.drive.leadHold;
  car.targetSpeed = Math.max(0, target.speed - error * car.drive.raidGain);
}

// --- Sieging -------------------------------------------------------------------
//
// The siege mortar — the road's first proper boss, and the only thing on it that
// attacks the GROUND rather than a car.
//
// THE DRIVING IS `outrun`'s, UNCHANGED: get past what's in the way, then hold
// station at the top of the screen at the profile's `leadHold`. Everything that
// makes this a boss — the hull, the three phases, the shells — lives in
// cartypes.js, armament.js and shells.js.
//
// WHY IT HOLDS STATION, given the barrage has no range gate and would happily
// shell from off-screen (armament.js's fireBarrage): a boss the player cannot
// SEE is one they cannot read, and this is the best silhouette in the game.
// Station-keeping keeps it on screen, in the cannon's line and shootable, which
// is what makes killing it the fast way out. Off-screen is the fallback for the
// twelve seconds of overdrive that can break the hold, not the intended fight.
//
// IT NEVER TURNS TO FACE THE PLAYER, and nothing enforces that: the kit carries
// no gun (armament.js's BATTERY_KIT), so there is no firing line to line up.
//
// WHY A ROW OF ITS OWN RATHER THAN THE MORTAR NAMING `outrun`: `outrun` IS
// BOUND BY A GUN. Its hold must sit inside armament.js's
// GUN_MIN_RANGE..GUN_RANGE or the car parks up the road and never fires
// (test/hazards.test.js pins every type on that tactic against it). The mortar
// has no gun, so that band is arithmetic about a weapon it does not own, and
// naming `outrun` would hold the boss to it. What DOES bind both is that the
// hold must be ON SCREEN — a rule about the player's eyes, not a weapon — and
// the suite checks both.

function siege(car, dt, world) {
  outrun(car, dt, world);
}

// --- Patrolling ---------------------------------------------------------------
//
// The gunship (cartypes.js's `airborne`) — the first tactic on this road that is
// not driving on it, and the only one whose lateral limit comes from the frame
// rather than from the barriers.
//
// WHY A ROW OF ITS OWN rather than naming `strafe`, which is the same two ideas
// (hold a gap, sweep across the player's line): `strafe` is BOUND BY THE ROAD in
// both halves, and both bindings are wrong here.
//
//   ITS SWEEP CLAMPS TO ROAD_HALF_WIDTH, because a car that steered past a
//   barrier would be steering into it. This one's whole point is that it goes
//   OVER the roadside and comes back, so the clamp it wants is the screen edge.
//   IT DEFERS TO `blocked`, so a weave never steers into somebody. Nothing on
//   the tarmac is in an aircraft's way, and asking would make the gunship dodge
//   traffic on the road below it — see cartypes.js's `airborne` for what that
//   separation is and how the rest of the game reads it.
//
// WHAT IT DOES SHARE it takes unchanged, and neither half is new arithmetic:
// the hold is `outrun`'s error term against `leadHold` on `raidGain`, and the
// sweep is `strafe`'s sine on `weaveSpan`/`weaveTime`. What is different is only
// what each is measured against.
//
// THE GUN NEEDS NO CASE HERE. armament.js will only fire when the shooter is
// lined up on the target's own line within the weapon's aim slack, and the sweep
// crosses that line twice a cycle — so the missile goes off as the gunship
// passes over the player and at no other time, which is the shot the artwork
// promises. Same mechanism the outrider's spray already runs on.

// How far past the road's own half-width an airborne car may sit and still be
// drawn WHOLLY inside the frame. A CONTRACT WITH road.js AND THE VIEWPORT, not a
// disposition, which is why it is here with the other four rather than in a
// driving profile: screen x is centerXAt(worldY) + offset and the centre-line
// wanders by up to ROAD_AMPLITUDE either way, so the worst case is the road at
// one extreme and the car swept to the far side of it. Subtracting the car's own
// half-width is done at the call site, where the car is known.
const FLIGHT_MARGIN = ROAD_AMPLITUDE;

function patrol(car, dt, world) {
  const target = world.playerBody;
  if (!target) return cruise(car, dt, world);

  // The hold — `outrun`'s, unchanged. See `siege` above for why holding station
  // on screen is a rule about the player's eyes rather than about a weapon.
  const lead = car.worldY - target.worldY;
  const error = lead - car.drive.leadHold;
  car.targetSpeed = Math.max(0, target.speed - error * car.drive.raidGain);

  // The sweep — `strafe`'s sine, against the frame instead of the barriers. The
  // phase is per car and random at its first tick, for the reason `strafe` gives.
  car.weavePhase ??= Math.random() * Math.PI * 2;
  car.weavePhase += (dt / car.drive.weaveTime) * Math.PI * 2;

  const limit = world.W / 2 - FLIGHT_MARGIN - car.w / 2;
  const swept = target.offset + Math.sin(car.weavePhase) * car.drive.weaveSpan;
  car.targetOffset = Math.max(-limit, Math.min(limit, swept));
}

// --- Strewing -----------------------------------------------------------------
//
// The sower (the GLIDE trike, and its trunk is why it is this hull that carries
// the strips). One errand in two halves: get to the top of the screen ahead of
// the player, lay ONE spike strip in their path, and then go — flat out, and
// never seen again.
//
// THE RUN IN IS `raid`, UNCHANGED — armament.js's `layMine` does not care what
// the payload is, so a strip goes through the same window, aim tolerance and
// "not over somebody else's traffic" veto as a mine. Only the PAYLOAD differs
// (a magazine of one strip, armament.js's `spiker`), and what happens after.
//
// THE RUN OUT IS THE NEW PART. `raid` retires into plain `cruise` once its
// magazine is spent, which here would mean loitering over the trap it just laid
// waiting to be rammed. This one leaves, and it is a real escape rather than a
// fadeout: the sower's speed band tops out above the player's, so you hold the
// throttle down and still watch it go.

function strew(car, dt, world) {
  if (layerUnspent(car)) {
    raid(car, dt, world);
    return;
  }
  flee(car, dt, world);
}

// Away, and for good. Two things make that read as fleeing rather than as a car
// that happens to be quick:
//
//   IT GOES UNARMED, the same one-way switch `trail` throws when it gives the
//   player up — `car.arms` is nulled rather than merely left un-fired, so
//   nothing in the retreat can line up a parting shot or a second strip.
//   IT DRIVES AT ITS CEILING. `cruiseSpeed` is re-derived from `baseSpeed` at
//   the top of every tick (traffic.js), so raising it here is an intent for THIS
//   tick and never a permanent edit to the type's speed band. Asking `overtake`
//   for the manoeuvre rather than writing a speed directly is what keeps the
//   flight braking for traffic and dodging hazards like any other car — a car
//   fleeing through the back of a bus is a bug, not a getaway.
function flee(car, dt, world) {
  car.arms = null;
  car.cruiseSpeed = car.type.speedMax;
  overtake(car, dt, world);
}

// --- The tactics table ----------------------------------------------------------
//
// Every car type names one of these. A row is `{ drive, arms }`: the manoeuvre
// that sets its intent, and whether it uses what it is carrying.
//
// EVERY ROW IS REAL — nothing in this table points at a manoeuvre it does not
// describe. A placeholder row that quietly delivers `cruise` is worse than an
// obvious hole, because the catalogue then reads as though a type has a tactic of
// its own. There is no row for `block` (the bottling-up manoeuvre) for that
// reason; driving.js's `enforcer` profile is still there waiting for it, since a
// driving profile costs nothing to leave unclaimed the way a tactic row does.
//
// `arms` is per tactic, not per faction, and that is the right way round: being
// ARMED follows from what a car carries (armament.js keys off faction), but USING
// the arms follows from what it is trying to do. An enemy type given a civilian
// tactic would carry a gun it never fires — correct, and worth knowing before
// wondering why a new type sits there quietly.
const BEHAVIOURS = {
  // Civilian tactics. Never armed: an armed civilian would shoot at the player,
  // and killing it back would still fine them (score.js).
  cruise: { drive: cruise, arms: false },
  overtake: { drive: overtake, arms: false },

  // Hostile tactics. Every one drives itself; the numbers behind them are the
  // enemy rows of driving.js.
  pursue: { drive: pursue, arms: true },    // closes in and holds a firing
                                            // gap, and never gives up on the
                                            // player once it has them
  ram: { drive: ram, arms: false },         // no gun, no mines — closes
                                            // the gap from behind or alongside
                                            // to hit the player, or sits ahead
                                            // of them going deliberately slower
                                            // to force the same contact from
                                            // the other side
  raid: { drive: raid, arms: true },        // forces its way past whatever's
                                            // ahead, then holds station in front
                                            // of the player just long enough to
                                            // drop one mine in their path
  trail: { drive: trail, arms: true },      // `pursue` with a give-up clock:
                                            // fights one engagement off the
                                            // player's back bumper, then rides
                                            // off unarmed for good
  duel: { drive: duel, arms: true },        // the rival's own — one deliberate
                                            // mine run exactly like `raid`,
                                            // then `pursue` for good
  strafe: { drive: strafe, arms: true },    // the outrider's: `pursue`'s gap,
                                            // swept side to side across the
                                            // player's line rather than parked
                                            // on it, spraying forward as it
                                            // crosses
  outrun: { drive: outrun, arms: true },    // the outrunner's, and the only
                                            // tactic that attacks from IN
                                            // FRONT: get past, hold station up
                                            // the road, shoot back down it
  strew: { drive: strew, arms: true },      // the sower's: `raid`'s run-in with
                                            // a spike strip for a payload, then
                                            // away flat out and unarmed
  siege: { drive: siege, arms: true },      // the boss's: `outrun`'s hold with
                                            // no gun to hold it for, shelling
                                            // the road ahead of the player
                                            // instead of shooting back at them
  patrol: { drive: patrol, arms: true },    // the gunship's, and the only one
                                            // flying: `outrun`'s hold with
                                            // `strafe`'s sweep, both measured
                                            // against the frame rather than
                                            // against the road
};

// Every manoeuvre the road knows. Exported for test/hazards.test.js, which
// checks that every `behaviour` in the catalogue names one of these — the
// fallback below is a safety net for a half-written type, and a shipped type
// silently taking it is the failure the table header warns about.
export const TACTIC_NAMES = Object.freeze(Object.keys(BEHAVIOURS));

// Resolve a tactic. Unknown keys fall back to cruising rather than throwing: a
// half-finished type in the catalogue should still drive.
function tacticFor(name) {
  return BEHAVIOURS[name] ?? BEHAVIOURS.cruise;
}

// Drive one car for one tick — the whole of what traffic.js calls. See THE THREE
// STAGES at the top of this file for why the order is fixed here rather than left
// to each tactic.
export function driveCar(car, dt, world) {
  const tactic = tacticFor(car.type.behaviour);
  tactic.drive(car, dt, world);
  // STAGE 2 IS FOR THINGS ON THE ROAD. An airborne car (cartypes.js) flies over
  // mines, spike strips and roadblocks rather than round them, so the reflex has
  // nothing to save it from — and running it anyway would have the gunship veer
  // away from a hazard on the road below it, which is the one manoeuvre that
  // would tell the player it was not really flying. One of the three places `airborne` is
  // read; the field table in cartypes.js lists all three.
  if (!car.type.airborne) avoidHazards(car, world);
  if (tactic.arms && car.arms) useArms(car, world);
}
