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
// Phase 3 ships only `cruise`. The pursuit/ram/shoot tactics land in Phase 4 as
// further entries in this table, and existing types switch over by changing one
// string in cartypes.js.

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
  const lead = leadCar(car, world);
  if (!lead) {
    car.targetSpeed = car.cruiseSpeed;
    return;
  }

  // Nose-to-tail gap, and the room this car needs at its current closing rate.
  const gap = lead.worldY - car.worldY - (lead.h + car.h) / 2;
  const closing = Math.max(0, car.speed - lead.speed);
  const needed = FOLLOW_GAP + closing * FOLLOW_REACTION;

  // Inside that gap, fall in behind at the lead car's speed; outside it, resume
  // the car's own cruising speed.
  car.targetSpeed = gap < needed ? Math.min(car.cruiseSpeed, lead.speed) : car.cruiseSpeed;
}

// The nearest thing ahead of `car` that it would actually run into, or null if
// the road is clear. Overlap is tested LATERALLY rather than by lane number:
// ramming knocks cars between lanes and the player never had one, so "shares my
// lane" is not the same question as "is in my way".
function leadCar(car, world) {
  let best = null;
  let bestGap = Infinity;
  const consider = (other) => {
    if (other === car) return;
    if (Math.abs(other.offset - car.offset) >= (other.w + car.w) / 2) return;
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

const BEHAVIOURS = {
  cruise,
};

// Resolve a behaviour key. Unknown keys fall back to cruising rather than
// throwing: a half-finished type in the catalogue should still drive.
export function behaviourFor(name) {
  return BEHAVIOURS[name] ?? cruise;
}
