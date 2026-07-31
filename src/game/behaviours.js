// Traffic AI — one function per tactic, picked by a car type's `behaviour` key.
//
// THE CONTRACT
//   behave(car, dt, world)
//     car    the TrafficCar being driven (see traffic.js)
//     dt     seconds since the last logic tick (fixed, see engine/loop.js)
//     world  { player, distance, cars, W, H } — the read-only view of everything
//            else, `cars` being every live traffic car including this one
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

// Drive on, holding a lane and a steady speed — but don't drive THROUGH the car
// in front. Nothing collides yet (Phase 3 has no ramming), so without this two
// cars sharing a lane at different speeds simply merge into one another, which
// looks broken long before it matters to gameplay.
function cruise(car, _dt, world) {
  const lead = leadCar(car, world.cars);
  if (!lead) {
    car.targetSpeed = car.cruiseSpeed;
    return;
  }

  // Nose-to-tail gap, and the room this car needs at its current closing rate.
  const gap = lead.worldY - car.worldY - (lead.type.h + car.type.h) / 2;
  const closing = Math.max(0, car.speed - lead.speed);
  const needed = FOLLOW_GAP + closing * FOLLOW_REACTION;

  // Inside that gap, fall in behind at the lead car's speed; outside it, resume
  // the car's own cruising speed.
  car.targetSpeed = gap < needed ? Math.min(car.cruiseSpeed, lead.speed) : car.cruiseSpeed;
}

// The nearest car ahead of `car` in the same lane, or null if the road is clear.
// Lanes are wide enough that cars in different ones never overlap, so same-lane
// is the whole test (see road.js).
function leadCar(car, cars) {
  let best = null;
  let bestGap = Infinity;
  for (const other of cars) {
    if (other === car || other.lane !== car.lane) continue;
    const gap = other.worldY - car.worldY;
    if (gap > 0 && gap < bestGap) {
      bestGap = gap;
      best = other;
    }
  }
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
