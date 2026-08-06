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
// is called from here directly — game/armament.js decides when.
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
// The stages were previously copied into each tactic by hand — `avoidHazards` in
// two of them, `useArms` in four — with the ordering enforced only by comment. A
// new tactic could silently forget either. Now a tactic sets intent and nothing
// else, and the table at the bottom says which of them are armed.
//
// --- WHERE THE NUMBERS LIVE ---------------------------------------------------
//
// Not here. Every tuning constant below reads off `car.drive`, the DRIVING
// PROFILE its type names (game/driving.js) — so a timid overtaker and an
// impatient one are two rows of a data table rather than two functions.
//
// THE ONLY CONSTANTS THIS FILE OWNS ARE CONTRACTS WITH ANOTHER FILE, never a
// matter of taste, and there are five of them:
//
//   HAZARD_DODGE_SPAN, HAZARD_SAFETY   where obstacles.js may place a hazard
//   RAID_LEAD, RAID_CLEARANCE          armament.js's own mine window and aim
//   TRAIL_ENGAGE                       the gap at which a shot is possible at all
//
// Each is derived from a figure another module owns, so pinning it to a driving
// profile would let a retune quietly break the other file's assumption. Every
// one is marked where it is defined.
//
// THE HOSTILE TACTICS USED TO OWN SIXTEEN MORE — hold gaps, chase ceilings,
// proportional gains, a give-up clock — which meant the five enemy profiles in
// driving.js differed only in `nerve`, and a second, more cautious interceptor
// needed a new FUNCTION rather than a new row. Those are profile fields now
// (driving.js's "Chasing the player" section); what is left here is the shape
// of the manoeuvre, which is what this file is for.
//
// Behaviours are also free to be STATEFUL by stashing fields on `car` (a timer,
// a chosen lane) — each car is a plain object owned by one behaviour for life.

import { laneAt, laneOffset, LANE_COUNT, LANE_WIDTH, ROAD_HALF_WIDTH } from "./road.js";
import { useArms, MINE_RANGE, MINE_AIM } from "./armament.js";
import { impactCost, SIDE_DAMAGE } from "./collisions.js";

// --- Following ---------------------------------------------------------------

// The speed to ask for while `lead` is in the way — the lead car's speed once
// inside the gap this car needs at its current closing rate, `desired` outside
// it (or with the road clear).
//
// `desired` is a parameter rather than just car.cruiseSpeed because an
// overtaking car wants MORE than its cruise (see passSpeed): the braking rule
// and the "how fast do I want to go" question are separate, and a car making a
// pass still has to brake for whatever is in front of it.
//
// The gap wanted is `followGap` plus a term for how fast we are closing, both
// off the driving profile. Traffic can only shed speed at traffic.js's ACCEL and
// shedding dv takes dv²/(2*ACCEL) units of road, so the pair is a REAL
// CONSTRAINT rather than free tuning — see driving.js's followReaction, and
// test/invariants.test.js, which checks it per profile against the speeds of the
// types that actually drive it.
function followSpeed(car, lead, desired = car.cruiseSpeed) {
  if (!lead) return desired;
  const gap = lead.worldY - car.worldY - (lead.h + car.h) / 2;
  const closing = Math.max(0, car.speed - lead.speed);
  const needed = car.drive.followGap + closing * car.drive.followReaction;
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

// --- What a driver is willing to hit ------------------------------------------
//
// One mechanism, two tolerances — see driving.js's NERVE section for why they
// are separate numbers. Both are hull damage, and both are compared against an
// ESTIMATE of what the thing in question would actually cost.
//
// A HAZARD NAMES ITS OWN PRICE (`threat`, obstacles.js). A car's has to be
// worked out, and it is worked out with collisions.js's own formula rather than
// a copy of it — a driver deciding against arithmetic the game does not run
// would be wrong in exactly the cases that matter.
//
// LATERAL ONLY, deliberately. What a lane change risks is arriving sideways into
// somebody, so it is priced as a SIDE-SWIPE at this car's own steering rate. The
// head-on component is not counted, because it is not a risk this decision takes:
// a car that pulls in ahead of something slower brakes for it (followSpeed), and
// pricing that in as an unavoidable impact would make every lane change look
// lethal to a fast car and freeze it in its lane.
function contactCost(car, other) {
  return impactCost(car, other, car.type.steerSpeed, SIDE_DAMAGE);
}

// Would this driver accept putting itself where `other` is?
//
// A CEILING OF ZERO MEANS "NOBODY", not "anybody it happens to be free to hit",
// and the difference is not academic. `contactCost` is zero whenever the car's
// own steering rate is under collisions.js's DAMAGE_FLOOR, so the RIG — 35px/sec
// against a floor of 40 — priced every lane change in the catalogue at nothing
// and `0 <= 0` waved all of them through. The heaviest thing on the road was the
// one vehicle that would slide into an occupied lane without a thought, which is
// the exact opposite of what its profile says. Read the ceiling off the PROFILE
// rather than the rolled figure, so a car that merely rolled low is still just a
// timid car and not a special case.
function tolerated(car, other) {
  if (other.threat !== undefined) return other.threat <= car.nerve;
  if (car.drive.contact <= 0) return false;
  return contactCost(car, other) <= car.contact;
}

// --- Lane discipline ----------------------------------------------------------
//
// NOTHING ELSE RE-DERIVES WHICH LANE A CAR BELONGS IN, which is the hole this
// fills. `cruise` never wrote `targetOffset` at all and `startPass` returns
// early when there is nobody to pass, so a car shoved sideways by a ram used to
// steer all the way back across live traffic to the lane it spawned in, however
// many manoeuvres ago that was.
//
// `laneDiscipline` (driving.js) is read as a TOLERANCE rather than a strength:
// the car accepts sitting up to (1 - discipline) of a half-lane off centre and
// holds whatever line it is on inside that. At 1 the slack is zero and the car
// rides the centre-line exactly; at 0.3 it settles anywhere in the middle two
// thirds of its lane and reads as sloppier without ever actually wandering.
//
// Expressed as "move just far enough to be inside the slack" rather than "snap
// to the centre once outside it": snapping would make the tolerance decide only
// WHEN a car corrected, not where it ended up, and every profile would arrive
// dead centre anyway.
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
// A PREFERENCE IS NEVER WORTH A LANE CHANGE THROUGH TRAFFIC. Without that gate a
// car with a `laneHome` would grind across the road at every opportunity, which
// is both worse driving and — since every swerve is a collision — actively
// dangerous. So the wanted lane has to be clear on this driver's own terms
// before it drifts over.
function homeLane(car, world) {
  const here = laneOffset(laneAt(car.offset));
  const pref = car.drive.laneHome;
  if (pref === "any") return here;

  const want = laneOffset(preferredLane(pref, car.offset));
  if (want === here) return here;
  return blocked(car, null, want, world, car.drive.passLookAhead) ? here : want;
}

// The index of the lane this preference wants, on whichever side of the road the
// car is already on — crossing the centre-line to reach the far outer lane is
// not what "keep out of the way" means. Derived from LANE_COUNT rather than
// written out, so a wider road doesn't silently break it.
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
// separates an accident from ordinary traffic: without it every faster car on
// the road would grind through the queue ahead of it, and the player would be
// rear-ended from behind constantly rather than as a consequence of driving
// badly.
function cruise(car, _dt, world) {
  keepLane(car, world);
  car.targetSpeed = followSpeed(car, leadCar(car, world, car.offset, null));
}

// --- Overtaking -----------------------------------------------------------------
// Cruising alone makes a fast car queue politely behind a slow one forever,
// which on a four-lane road looks broken — and it means the player can hold up
// the whole road by sitting in one lane. An overtaker instead pulls out, drives
// past on one side and settles back into a lane.
//
// The manoeuvre is COMMITTED: a car picks a side once, holds that line until it
// is past (or gives up), and doesn't re-decide every tick. Re-deciding is what
// makes traffic AI dither in the mirror, and here it would also mean cars
// jinking sideways into each other, since every swerve is now a collision.

// The speed a car wants while it is actually alongside something. A pass driven
// at cruise speed is a slow one — the whole manoeuvre runs at whatever margin
// the two cruise speeds happen to differ by, which is why passes used to expire
// on timeout rather than finish. Spending a little extra makes overtaking read
// as effort rather than as drift.
//
// CAPPED AT THE TYPE'S OWN speedMax, which is what keeps this free: the top of
// the catalogue's speed band doesn't move, so the largest closing speed the road
// can produce is unchanged. A car already cruising at its maximum simply passes
// at cruise — worth checking against the catalogue before tuning `passEffort`
// for a type whose speed range ends where its cruise does.
function passSpeed(car) {
  return Math.min(car.type.speedMax, car.cruiseSpeed * car.drive.passEffort);
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
// PATIENCE is what stops every overtaker being equally twitchy: before it, a
// pass fired the instant the trigger distance was met, so the only difference
// between drivers was how fast they could steer. `heldTime` counts the seconds
// this car has spent behind something it would rather be in front of, and is
// reset the moment that stops being true — so the timer measures frustration,
// not the age of the car.
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
  const look = lead.worldY - car.worldY + d.passLookAhead;
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

// Back to ordinary driving. The lane is not chosen here any more: keepLane picks
// one up on the next tick from wherever the car actually ended up, which is the
// same answer and only written once.
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

// Is anything this driver won't touch in the stretch of road the line at `line`
// would use? `lookAhead` is how far up the road to care about, measured from the
// car — a pass looks past the body it is overtaking, a lane preference only as
// far as the road it is about to occupy.
//
// TOLERANCE IS WHAT MAKES THIS PER-DRIVER. It used to answer "is anyone there",
// which is the same question for every car on the road. It now answers "is there
// anything there that I mind", so a sedan is stopped by a neighbour that a
// roadster will squeeze past — see the tolerance section above.
//
// Checked once, when committing: during a pass, traffic that moves in is handled
// by braking (see overtake) rather than by abandoning the line mid-swerve.
function blocked(car, ignore, line, world, lookAhead) {
  const from = car.worldY - car.drive.passLookBehind;
  const to = car.worldY + lookAhead;
  const inTheWay = (other) => {
    if (other === car || other === ignore) return false;
    if (!other.alive) return false; // a corpse must not veto a line — see leadCar
    if (Math.abs(other.offset - line) >= (other.w + car.w) / 2) return false;
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
// An obstacle (game/obstacles.js) is NOT traffic, and that difference decides
// everything about how one is handled. Traffic is something you QUEUE behind:
// it is moving, so matching its speed still gets you where you were going. A
// roadblock is standing still and always will be, so following one is not the
// answer while there is a lane to take instead.
//
// So the answer is STEER FIRST — and the reason slowing down helps at all is
// that same fact. A hazard does not move, so going slower does not "let it get
// away"; it simply buys more SECONDS of approach, and seconds of approach are
// exactly what a lane change costs. A car that cannot fit its swerve into the
// road it has left can always fit it by taking longer over that road.
//
// THE THREE OUTCOMES, cheapest first:
//   1. steer to the nearest lane that is clear of the hazard and of anything
//      this driver isn't willing to touch;
//   2. and whatever line was chosen, slow down enough that the sideways move
//      actually fits in the road remaining;
//   3. with no lane available at all, STOP — see hazardStop.
// Outcome 2 is a floor on the tactic's own speed, never a target: a car with
// room to spare passes a hazard at full cruise and never knows this ran.
//
// WHAT USED TO BE HERE, and why it isn't: a second tier that took a lane merely
// clear of the HAZARD, accepting that there was a car in it, on the grounds that
// a fender-bender beats a blast. That trade was made for every car on the road
// at once. It is now made per driver, by `contact` (driving.js) — a driver who
// will accept the bump finds that lane clear at step 1 and takes it, and one who
// won't goes to step 3 and stops. One rule instead of two, and the tier that
// used to be hard-coded is now the thing that tells two civilians apart.
//
// DODGES AIM AT LANE CENTRES, which is what lets this skip a "pull back in" step
// entirely: a car that swerves ends up in a real lane and cruises on from there.
// It is also what keeps the dodge STABLE — the candidate lines are fixed, so a
// car picks a lane and holds it instead of hunting between two near-equal
// offsets as it closes.
//
// WHY STEERING IS USUALLY ENOUGH: obstacles.js refuses to place a hazard in the
// last open lane of a stretch of road, so a lane clear of the HAZARD always
// exists. Whether it is clear of TRAFFIC too is not guaranteed, which is exactly
// when stopping is the answer. Asserted in test/invariants.test.js.

// HOW FAR AHEAD A DRIVER LOOKS is a distance divided by how fast the car is
// covering it, not a constant: a rig steers at 35px/sec and a cycle at 180,
// while the cycle also arrives at nearly four times the speed, so one number
// cannot be right for both. So the lookahead is DERIVED: the time this car needs
// to slide clear, times the speed it is closing at. A hazard never moves, so the
// closing speed is simply the car's own.
//
// TWO lane widths, and what sets it is not a question of WIDTH. Every block in
// the catalogue fits in or beside a lane. The binding case is the MINE, and it
// is binding because of where it is allowed to be: PLACE_ANY (obstacletypes.js)
// lets it land BETWEEN two lane centres, spoiling both at once. The worst case
// is a rig in the outer lane with a mine at -72 — its own lane and the next one
// in are both unusable, so the nearest lane centre it can take is the third one
// over, 130px away, exactly two lane widths.
//
// NOT ON THE PROFILE, unlike everything else in this file. These two feed
// `dodgeDistance`, and obstacles.js sizes its spawn margin against that: they
// are a contract about WHERE A HAZARD MAY BE PLACED, not about how a given
// driver feels on meeting one. The driver's feeling is `nerve`.
const HAZARD_DODGE_SPAN = 2; // lane widths a dodge may have to cover
const HAZARD_SAFETY = 1.3;   // slack, so a car arrives already clear rather than
                             // finishing its swerve exactly at the obstacle

// Road a car needs to see a hazard coming and be clear of it. Exported because
// it is a CONSTRAINT ON WHERE HAZARDS MAY BE PLACED: obstacles.js has to spawn
// far enough ahead that every car in the catalogue gets at least this much road,
// or the slowest-steering types are asked to dodge something they physically
// cannot avoid. Asserted in test/invariants.test.js.
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
// This deliberately reverses the rule the section header states, and the
// reversal is the point: following a hazard is never the answer WHILE A LANE IS
// AVAILABLE, and it is exactly the answer when none is. Presenting it to
// `followSpeed` as a lead car doing zero is what makes that one line of code
// rather than a second braking rule — and it comes with `followGap` for free, so
// the car stops a car's length short instead of nose to the barrier.
//
// A stopped car is a fine thing to be in front of a roadblock, and it is not a
// dead end: whatever was in the clear lane is traffic, so it moves on, the lane
// opens, and the car steers into it and accelerates away.
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
  // that only watched one of them would either swerve into a hazard it was
  // steering toward or ignore one it is still sitting on top of.
  const lookahead = hazardLookahead(car);
  const hazard = nearer(
    hazardAhead(car, world, car.offset, lookahead),
    hazardAhead(car, world, car.targetOffset, lookahead),
  );
  if (!hazard) return;

  // NERVE: some drivers take the hit rather than lift off their line. Rolled
  // ONCE at spawn (traffic.js) from the profile's ceiling, so a barger is a
  // barger for life — a fresh coin flip per tick would make a car swerve and
  // unswerve all the way down the road.
  if (hazard.threat <= car.nerve) return;

  // The nearest lane centre that works, walked by index rather than sorted into
  // a list, since this runs per car per tick and this file allocates nothing.
  // TWO CANDIDATES per lane, and the difference between them is only ever the
  // TRAFFIC in it:
  //   best     clear of the hazard AND of anything this driver won't touch
  //   refuge   clear of the HAZARD, whoever else is standing in it
  // A line that is still hazardous is never either — that is the one thing not
  // traded away.
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
  // Stopping alone is not enough, and measuring the road is what showed it. A
  // car that braked to a standstill was holding whatever line it was already on,
  // which is by definition the line with the roadblock in it. It then sat there
  // as a stationary object in a live lane until something ran into the back of
  // it and shunted it into the very thing it had stopped for — every civilian
  // hazard strike in a 15 car-minute sample was that, and nothing else.
  //
  // So the refuge is taken even though there is somebody in it. This is NOT the
  // old "a fender-bender beats a blast" trade made behind the driver's back: the
  // car has already given up its speed, so the contact it accepts here is a nudge
  // at walking pace rather than a swipe at cruise. Slowing down first and only
  // then accepting a touch is exactly the order of preference a careful driver
  // has — it just needs both halves to be worth anything.
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
//
// THE SHARED HALF OF EVERY HOSTILE TACTIC. `raid`, `trail`, `ram` and `pursue`
// all want the same thing at some point in their lives — be on the player's own
// line — and all four used to write it out by hand, which is four places to fix
// when the clamp or the tolerance check changes.

// Steer onto `target`'s own line, or hold the current one when this driver
// won't take whatever is standing in it.
//
// HOLDING THE LINE WHEN BLOCKED IS NOT A NO-OP, and that is the bug folding
// these together fixes. All four copies read `if (!blocked(...)) car.targetOffset
// = want;` and did NOTHING on the other branch — so a car whose line was
// momentarily occupied went on steering toward wherever the player had been
// several ticks earlier, quite possibly into the traffic that blocked it. That
// is the exact stale-intent failure `keepLane` was written to end (see its
// header, which spells out why an unwritten target keeps steering); the hostile
// tactics simply reintroduced it. Saying "hold this line" explicitly is what
// keepLane does inside its own slack, and it is what this does here.
//
// The player is passed as `ignore` in every case: lining up with them is the
// entire point, so they are never a reason to hold back.
function trackTarget(car, target, world) {
  const limit = ROAD_HALF_WIDTH - car.w / 2;
  const want = Math.max(-limit, Math.min(limit, target.offset));
  const clear = !blocked(car, target, want, world, car.drive.passLookAhead);
  car.targetOffset = clear ? want : car.offset;
}

// --- Raiding -------------------------------------------------------------------
//
// The cycle. It carries no gun (armament.js's `raider` profile) — its only
// attack is a single mine, and a mine only counts for anything laid ahead of
// the player, in their lane, inside the window the mine layer itself accepts
// (MINE_MIN_LEAD..MINE_RANGE). So the manoeuvre is: use the one thing this
// type has plenty of — speed — to force its way past whatever's in front,
// then instead of pulling away as it ordinarily would, hold station out
// toward the FAR end of that window and tuck into the player's own lane
// until the drop goes off. Then it's done — one mine, not three — and it
// goes straight back to just being the fastest thing on the road.
//
// TWO PHASES, not one function pretending to be both. Getting past whatever
// is in the way is exactly the overtake manoeuvre already written —
// patience, a chosen side, brake for whatever's genuinely blocking it — so
// phase one simply IS overtake, aimed at the player the same way it's
// already aimed at any car holding this one up. Holding station ahead of a
// moving target is a different problem (match its speed, don't out-pace it),
// so it gets its own logic rather than a bent version of the first.
//
// THE PHASE SPLIT IS ON RAID_LEAD, NOT MINE_MIN_LEAD, and that is load-
// bearing rather than a rounding choice. armament.js's `layMine` only checks
// its OWN window and aim — it has no idea this tactic wants the far end of
// it specifically, and MINE_AIM is generous enough (two thirds of a lane)
// that simply being in the lane next to the player during an ordinary pass
// already satisfies it. So phase one doesn't just leave the lateral line to
// whatever `overtake` was already doing to get past real traffic — it
// actively holds clear of MINE_AIM around the player specifically, and only
// once it reaches RAID_LEAD does it swing onto their line, which is what
// actually gates the drop.
//
// TOWARD THE FAR END of the window, not the middle of it — see armament.js's
// MINE_RANGE for why that reaches nearly to the top of the visible road: laid
// at the near edge the mine would appear almost on top of the player, which
// is a hit they never saw coming rather than one they had road left to
// dodge. Kept a little clear of MINE_RANGE's own ceiling, so ordinary speed
// wobble around the target never pushes the drop out of range.
//
// A CONTRACT WITH armament.js, which is why it stays here rather than going on
// a profile with the rest of the chase numbers: it is MINE_RANGE minus slack,
// so it tracks that file's window automatically. Written as a driving-profile
// figure it would be a bare number that silently fell out of range the next
// time the mine layer was retuned.
const RAID_LEAD = MINE_RANGE - 40;
// How far clear of the player's own line phase one holds, beyond MINE_AIM
// itself — enough slack that this is unambiguously NOT lined up, rather than
// sitting one rounding error inside the gate it's trying to stay outside of.
// A contract with armament.js's aim tolerance for the same reason as above.
const RAID_CLEARANCE = 15;
//
// The gain on the hold itself is NOT a contract and is not here: it is a matter
// of how tightly a given driver holds station, so it is `raidGain` on the
// driving profile (driving.js).

function raid(car, dt, world) {
  const target = world.playerBody;
  const arms = car.arms;
  // Nothing left to do once the one mine is spent (or there's no player, or
  // no kit at all — a test fixture, say): drive on same as any other car,
  // rather than loitering in front of someone it has nothing left to hurt
  // them with.
  if (!target || !arms || arms.layer.ammo < arms.layer.type.ammo) {
    cruise(car, dt, world);
    return;
  }

  const lead = car.worldY - target.worldY; // positive once clear ahead of them
  // Still closing on RAID_LEAD, or mid-pass: drive exactly like any
  // overtaker, so it genuinely gets past real traffic in its way — then, if
  // that left it within the mine layer's own aim tolerance of the PLAYER
  // specifically, nudge clear of just that. A real pass against another car
  // is left alone; only alignment with the player is corrected.
  if (lead < RAID_LEAD || car.passTarget) {
    overtake(car, dt, world);
    if (Math.abs(car.targetOffset - target.offset) <= MINE_AIM + RAID_CLEARANCE) {
      // Try the side already favoured first, but a player hugging a barrier
      // can clamp that side right back into range — fall back to the other
      // rather than silently staying aligned.
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

  // At the target distance: hold it, rather than continuing to pull away,
  // and NOW line up on the player's own lane so the drop actually lands in
  // their path. A line real traffic already occupies is left alone rather
  // than driven into — see trackTarget.
  trackTarget(car, target, world);

  const error = lead - RAID_LEAD;
  car.targetSpeed = Math.max(
    0,
    Math.min(car.type.speedMax, target.speed - error * car.drive.raidGain),
  );
}

// --- Trailing --------------------------------------------------------------
//
// The stocker. Where raid's whole point is getting AHEAD, this one never
// wants to be there at all — it hangs off the player's back bumper and
// fires forward, so the fight itself is what forces the strafing: a fired
// round holds the line it left on rather than homing on the player, so
// whoever is already moving when the muzzle flashes is the one who dodges
// it. "Shoots only forward" is enforced twice over, deliberately — this
// function never asks for a lane the player is IN FRONT of, so it never
// ends up aiming backward on its own account, AND the gun itself
// (weapons.js's `smg`, its `forwardOnly` field) refuses a rearward shot
// outright, so the guarantee doesn't rest on the driving alone getting
// every tick right.
//
// THE DRIVING IS `pursue`, AND ONLY THE GIVING UP IS THIS TACTIC'S OWN.
// Closing on the player, holding a gap once there, and dropping back to
// ordinary cruising when they are miles off is the interceptor's whole job
// and was written out twice, identically, down to four constants with the
// same values under two names. What actually makes a stocker a stocker is
// the paragraph below — it fights one engagement and then genuinely leaves —
// so that is all this function contains, and the rest is a call.
//
// GIVES UP ON LOST CONTACT, NOT ON A CLOCK. The first version of this timed
// out after a flat six seconds regardless of what was actually happening —
// which meant a stocker that had stayed glued to the player's tail the
// whole time gave up anyway, for no reason the player could see. What it
// tracks instead is `car.lostTime`: seconds since it was LAST inside firing
// range. Every tick back in range resets it to zero, so a car the player
// can't shake keeps fighting indefinitely — there is no cap on that at all.
// Only once it's been out of range continuously for `giveUpTime` does it
// give the player up FOR GOOD — `car.disengaged` is a one-way switch,
// checked first, that hands driving over to plain `overtake` forever. It
// becomes fast background traffic rather than circling back for another
// pass, and it goes unarmed once it does: `car.arms` is set to null right
// there, not just left un-fired, so there is no window in the retreat where
// an incidental lane change during `overtake` lines up a stray shot, or —
// worse — a moment ahead of the player where armament.js's own layMine
// would happily read as "ahead of my target" and drop one. Retiring the
// whole kit is what a car that has genuinely ridden away actually is.
//
// HOW LONG THAT TAKES IS `giveUpTime` ON THE PROFILE (driving.js), where 0
// means "never" and is the enemy baseline. The stocker is the only row that
// sets it, which is the correct shape for a trait exactly one type has.

// THE GAP THAT COUNTS AS "IN CONTACT", and it is a contract with armament.js
// rather than a free number, which is why it stays here while the rest of the
// chase figures moved onto the profile: a shot is only possible within ~304
// units of the player (H - player.y, armament.js's visibleRoad, with the player
// framed at 62% down an 800px canvas) before GUN_RANGE's own 520 even comes
// into it. Kept under that with margin, so contact only counts once a shot is
// genuinely on the table, not the instant the gap could theoretically close in
// time.
//
// Exported for test/invariants.test.js, which asserts the relation this figure
// has to the profile's `pursueHold`: a stocker parked at its hold gap must
// count as in contact, or the give-up clock would run while the car was doing
// its job perfectly and the stocker would ride off mid-engagement.
export const TRAIL_ENGAGE = 260;

function trail(car, dt, world) {
  const target = world.playerBody;
  if (!target) return cruise(car, dt, world);
  if (car.disengaged) return overtake(car, dt, world);

  // The bookkeeping, which runs whichever of `pursue`'s two modes is active —
  // that is why it sits here rather than inside the chase. `lostTime` is
  // seconds since this car was last inside firing range, so every tick back
  // in range zeroes it and a player who cannot shake the stocker is fought
  // indefinitely; only clear road between them ever starts the clock.
  const gap = target.worldY - car.worldY; // positive while it trails them
  if (gap <= TRAIL_ENGAGE) car.lostTime = 0;
  else car.lostTime += dt;

  // `> 0` is what makes the profile's own "0 means never" true here rather
  // than only in its comment: without it a profile that left giveUpTime at
  // the baseline would disengage on its very first tick out of range.
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
// The bruiser. No gun, no mines — the ARMS half of `useArms` never runs for
// this tactic at all (see the table below, `arms: false`), so the only thing
// this car spends on the player is its own mass. It has exactly one idea,
// applied from whichever side of the player it currently is: CLOSE THE GAP.
// TWO MODES, chosen only by which side of the player that leaves it on —
// there is no phase to commit to and nothing to hold, unlike raid or trail.
//
// BEHIND OR ALONGSIDE: this is the attack. The lane tracking is the same
// mechanism raid and trail already use — steer onto the player's own offset,
// deferring to `blocked` so it won't cut across traffic it doesn't tolerate
// to do it — but the speed half is deliberately NOT `followSpeed` against the
// player: braking to avoid the very thing this car exists to hit would be
// exactly backwards. It simply asks for its profile's `chaseSpeed`, a ceiling
// well above its own type.speedMax (330, cartypes.js) for the two-tier reason
// driving.js sets out on that field — a number spent purely on closing the last
// stretch onto a player who may be running near their own ceiling, not one it
// cruises at for its own sake. It is also the ONE profile that lowers it (560
// against the enemy's 600): this car closes to hit rather than to hold a firing
// gap, so it need not match a fleeing player, only catch a busy one.
// `resolveCollisions` (collisions.js) does the
// rest: at 2.2 mass, the heaviest thing on the road bar the rig, a rear-end
// or a side-swipe costs the player real hull and real speed, and costs this
// car almost none of either.
//
// AHEAD IS THE OTHER HALF OF THE SAME JOB, not a separate one. A car that
// keeps closing on a slower target does not stop closing at zero gap — it
// eventually passes, and once it has, still tracking the player's lane while
// asking for LESS speed than they are running IS the block: the player either
// brakes to match a wall heavier than they are or rear-ends it. `ramBrake` is
// a fraction of the PLAYER's own current speed rather than a fixed figure, so
// the block still bites right down at walking pace rather than going slack
// the moment the player lifts off the throttle themselves.
//
// THIS IS THE STOCKER'S OTHER HALF, and neither tactic knows the other
// exists. A player slowed here is a player held in the stocker's own gun
// window for longer (`trail`, and `pursueHold`/TRAIL_ENGAGE behind it) — the
// road producing that on its own, out of two cars each running one simple
// job, is the point of splitting the enemy into types at all rather than
// giving every hostile the same one tactic.
// All three of this tactic's numbers are profile fields (driving.js): the
// closing ceiling is `chaseSpeed`, shared with every other hostile and set
// lower for this one alone; the block is `ramBrake` and `ramFloor`.

function ram(car, dt, world) {
  const target = world.playerBody;
  if (!target) return cruise(car, dt, world);

  // Track the player's own lane: from behind or alongside this is what lines
  // the hit up, and ahead it's what keeps the block IN their path rather than
  // a car merely driving near them.
  trackTarget(car, target, world);

  // Still brake for REAL traffic in the way — the target itself is excluded
  // (see `ignore` below), because the one thing this tactic must never do is
  // brake for the player.
  const lead = leadCar(car, world, car.offset, target);
  const ahead = car.worldY - target.worldY; // positive once past the player

  if (ahead > 0) {
    const held = Math.max(car.drive.ramFloor, target.speed * car.drive.ramBrake);
    car.targetSpeed = followSpeed(car, lead, held);
    return;
  }

  car.targetSpeed = followSpeed(car, lead, car.drive.chaseSpeed);
}

// --- Pursuing ------------------------------------------------------------------
//
// The interceptor. It is the standard hostile's whole idea: close in, hold a
// firing gap, and never let go. Where the stocker's `trail` gives up for good
// once contact is lost for its `giveUpTime`, this tactic has no such
// clock — a car the player has shaken simply keeps coming, which is what
// makes it read as the road's baseline pressure rather than a timed
// encounter like `raid` or `trail` are.
//
// THE ROAD'S ONE CHASING FUNCTION, and `trail` is this plus a clock. Camping
// in range, closing the gap at a ceiling above the type's own cruise, and
// dropping back to plain cruising when the player is miles off is the whole
// of what either tactic does with the wheel; the stocker's ONLY addition is
// deciding to stop (see `trail`). The two were written out separately, with
// four constants duplicated under a second set of names and the same values,
// so a retune of the hold gap had to be made twice and nothing would have
// caught you doing it once.
//
// WHAT EACH TYPE ACTUALLY FIRES IS NOT THIS FUNCTION'S BUSINESS. The
// interceptor carries a rocket (armament.js's `rocketeer` profile) —
// `useArms` reads whatever `car.arms` says, and this tactic only ever
// decides where the car is and how fast it's going. Also the back half of
// the rival's own `duel`, below, once its one mine is spent.
// ALL FOUR OF ITS NUMBERS ARE PROFILE FIELDS (driving.js's "Chasing the
// player"): `pursueRange`, `pursueHold`, `pursueGain` and `chaseSpeed`. They
// were module constants here, duplicated under a second set of names by
// `trail` with the identical values — which is the shape of problem that made
// this the road's ONE chasing function and driving.js the place it is tuned.

function pursue(car, dt, world) {
  const target = world.playerBody;
  if (!target) return cruise(car, dt, world);

  const gap = target.worldY - car.worldY; // positive while it trails them
  if (gap > car.drive.pursueRange) {
    // Not close enough to be worth actively chasing right now. There is no
    // clock running here either way — this car simply waits for the gap to
    // close again, however long that takes. `trail` is what adds one.
    cruise(car, dt, world);
    return;
  }

  // Track the player's own lane directly, deferring to `blocked` so it won't
  // steer into traffic it doesn't tolerate to do it.
  trackTarget(car, target, world);

  // Hold the gap at `pursueHold`, but still brake for real traffic in the way
  // (the player itself is excluded from the lead search — the proportional
  // term is what governs distance to THEM). Capped at `chaseSpeed`, not the
  // type's own speedMax — see driving.js on why those differ.
  const lead = leadCar(car, world, car.offset, target);
  const held = target.speed + (gap - car.drive.pursueHold) * car.drive.pursueGain;
  car.targetSpeed = followSpeed(
    car,
    lead,
    Math.max(0, Math.min(car.drive.chaseSpeed, held)),
  );
}

// --- Duelling --------------------------------------------------------------
//
// The rival. Its whole identity is that it is the one hostile that can do
// what the cycle does AND what the interceptor does, in the same encounter —
// so rather than write a third driving model, this is the two of them
// composed: `raid`'s force-past-and-drop, then `pursue` for the rest of its
// life once that mine is gone. Both functions are already tuned and tested
// against MINE_RANGE and `pursueHold` respectively; a rival that reimplemented
// either would just be a second copy to keep in step with the first.
//
// ONE DELIBERATE MINE, NOT THREE, matching the cycle's own convention
// exactly (see raid's header) — a rival that kept diving back through
// traffic to repeat the trick would read as gimmicky rather than dangerous.
// The gate is the same one raid uses internally to retire itself:
// `arms.layer.ammo === arms.layer.type.ammo` is only true before the first
// round has ever left the tube, so the instant that first mine is laid this
// permanently falls through to `pursue` instead — no state of its own to
// track, no `car.disengaged`-style flag, just reading the magazine raid
// already keeps.
//
// THE OTHER TWO ROUNDS ARE NOT WASTED, they are just never CHASED. Once this
// is running `pursue`, the tactic itself never asks to get ahead of the
// player again — but `arms: true` on this row (below) means `useArms` still
// runs every tick regardless of which of the two functions is driving, and
// armament.js's own `layMine` still fires opportunistically if the player
// ever ends up trailing this car anyway (a hard brake, a lane fight with
// traffic). That is the whole of "in case it gets ahead, it can drop
// another" — the existing gating already does it, so there is nothing here
// to add for it.
function duel(car, dt, world) {
  const arms = car.arms;
  if (arms?.layer && arms.layer.ammo === arms.layer.type.ammo) {
    raid(car, dt, world);
    return;
  }
  pursue(car, dt, world);
}

// --- The tactics table ----------------------------------------------------------
//
// Every car type names one of these. A row is `{ drive, arms }`: the manoeuvre
// that sets its intent, and whether it uses what it is carrying.
//
// EVERY ROW IS REAL, and that is now the rule rather than the state of play:
// `raid`, `trail`, `ram`, `pursue` and `duel` are each their own function
// below, and nothing in this table points at a manoeuvre it does not describe.
//
// NO ROW FOR `convoy` ANY MORE, and it went for exactly the reason `block`
// never got one. It claimed the rig's rolling roadblock and delivered plain
// `cruise`, so cartypes.js read as though the rig had a tactic of its own when
// it drove like the van — a placeholder that had stopped looking like one,
// which is worse than an obvious hole. The rig names `cruise` directly now, so
// the catalogue says what the rig does. Write the roadblock when it ships.
//
// NO ROW FOR `block` EITHER. It was reserved for the hostile that would replace the
// muscle car once that moved to the civilian side (see cartypes.js's muscle
// and stocker entries) — but the stocker claimed that hole with `trail`
// instead, and nothing else ever named it. A row that no car type points at
// is not a placeholder earning its keep, it's dead weight sitting in the
// table looking like unfinished work; deleted rather than kept "just in
// case". If a future hostile genuinely wants "match the player's lane from
// in front and slow, to bottle them up", write it fresh then — the pair this
// used to sit next to (driving.js's `enforcer` profile) is still there
// waiting, since a driving profile costs nothing to leave unclaimed the way
// a tactic row does.
//
// Rows are still the shape for whatever DOES ship, because a table shows at a
// glance what manoeuvres the road knows, and adding one is then a function
// plus a name with no edit to traffic.js.
//
// `arms` is per tactic, not per faction, and that is the right way round: being
// ARMED follows from what a car carries (armament.js keys off faction), but
// USING the arms follows from what it is trying to do. An enemy type given a
// civilian tactic would carry a gun it never fires — which is correct, and worth
// knowing before wondering why a new type sits there quietly.
const BEHAVIOURS = {
  // Civilian tactics. Never armed: an armed civilian would shoot at the player,
  // and killing it back would still fine them (score.js).
  cruise: { drive: cruise, arms: false },
  overtake: { drive: overtake, arms: false },

  // Hostile tactics. Every one drives itself; the numbers behind them are the
  // enemy rows of driving.js.
  pursue: { drive: pursue, arms: true },    // closes in and holds a firing
                                            // gap, and never gives up on the
                                            // player once it has them — see
                                            // behaviours.js's `pursue`
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
};

// Every manoeuvre the road knows. Exported for test/invariants.test.js, which
// checks that every `behaviour` in the catalogue names one of these — the
// fallback below is a safety net for a half-written type, and a shipped type
// silently taking it is the `convoy` failure all over again.
export const TACTIC_NAMES = Object.freeze(Object.keys(BEHAVIOURS));

// Resolve a tactic. Unknown keys fall back to cruising rather than throwing: a
// half-finished type in the catalogue should still drive.
function tacticFor(name) {
  return BEHAVIOURS[name] ?? BEHAVIOURS.cruise;
}

// Drive one car for one tick — the whole of what traffic.js calls. See THE THREE
// STAGES at the top of this file for why the order is fixed here rather than
// left to each tactic.
export function driveCar(car, dt, world) {
  const tactic = tacticFor(car.type.behaviour);
  tactic.drive(car, dt, world);
  avoidHazards(car, world);
  if (tactic.arms && car.arms) useArms(car, world);
}
