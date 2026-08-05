// The obstacle GAMEPLAY catalogue — how tough and how dangerous each entry in
// obstacleshapes.js is. Same split as cars: obstacleshapes.js says what an
// obstacle LOOKS like (silhouette, family, debris style, pulse); this file says
// what it DOES (how much it takes to kill, how much it hurts, how often it
// shows up). Adding a new hazard means an entry in each file — this one keyed
// to the other BY NAME (obstacleShapeIndex), so reordering the shape catalogue
// can't quietly reassign a mine's numbers to a roadblock.
//
// Fields:
//   id          stable key (spawn tables, debugging)
//   label       gallery/HUD caption
//   shape       index into OBSTACLE_SHAPES — looked up by name, for the same
//               reason carTypes does: inserting a shape in the middle of that
//               catalogue must not silently swap two obstacles' numbers
//   health      hull points. Spent by GUNFIRE ONLY (see game/obstacles.js) — a
//               ram always destroys an obstacle outright regardless of health,
//               because the road only ever gives you one pass at a static
//               object, so partial health surviving a hit you can't repeat
//               would mean nothing. Health is what a player who'd rather shoot
//               a hazard from a distance than touch it is spending rounds
//               against, and it is what a mine's "minimum" is measured in: a
//               mine takes exactly ONE hit, gunfire or contact, same as a car
//               at zero hull
//   mass        how much a ram costs a car's SPEED, relative units on the same
//               scale as cartypes.js's `mass` (a sedan is 1, a rig — the
//               catalogue's heaviest — is 4). An obstacle never moves —
//               collisions.js's `ramSpeed` treats it as a body pinned in
//               place, so this only ever costs the car something, never the
//               hazard. Follows the same WEIGHT-CLASS LADDER as `health` and
//               `blastDamage` below (light -> heavy: TRESTLE, BARRELS, TETRA):
//               a folding trestle barely notices a bumper, a tank trap is
//               close to a rig. The mine is the one exception, kept lowest of
//               all — it is a small charge, not a wall, so what it does to a
//               car is entirely in its blastDamage, not in the road it holds
//   blastRadius how far the destruction hurts, in px from the obstacle's BOX
//               EDGE outward — the same measure Traffic uses for a car's death
//               blast (see collisions the formula is shared with, in
//               game/obstacles.js). A roadblock's radius is kept small
//               deliberately: it should read as "only whoever hit it felt it",
//               not as a wall-wide shockwave. A mine's is wide — it is the one
//               obstacle that is a genuine area weapon
//   blastDamage hull taken at the centre of that blast, falling off linearly to
//               nothing at the rim — same falloff Traffic gives a car's own
//               death. The player has 100 hull; a TrafficCar's ranges 25..220
//               (cartypes.js)
//   placement   where across the road this type belongs — PLACE_LANE / _SIDE /
//               _CENTRE / _ANY. See the block above
//   weight      relative spawn frequency (see obstacles.js's pickObstacleType)
//   minDistance how far the player must have driven before this type may spawn,
//               in DIST-READOUT units — the same gate cartypes.js documents at
//               length, and the same units the HUD counts in (road.js). Every
//               hazard is currently 0: a roadblock is the CITY's, not the
//               enemy's, so it belongs on the opening road alongside the traffic
//               that has to swerve round it. The field is here so a type can be
//               held back without new machinery — the caltrop is the obvious
//               candidate the day the opening wants to be gentler still
//
// THE WEIGHT-CLASS LADDER. obstacleshapes.js already orders the three
// roadblocks light -> heavy (TRESTLE, BARRELS, TETRA) by their SILHOUETTE and
// their debris style; health and blastDamage climb the same ladder so the
// numbers back up what the shape already told the player. BARRELS is the one
// exception on damage — effects.js calls its burst "the one destruction in the
// game that is good news", so its blastDamage is the LOWEST of the three even
// though its health sits in the middle: bargeable is a promise about the hit,
// not about how many rounds it shrugs off.
import { obstacleShapeIndex } from "./obstacleshapes.js";
import { DIST_UNITS } from "./road.js";

// WHERE A HAZARD SITS ACROSS THE ROAD, and it is a property of the OBSTACLE
// rather than of the spawner — a barrels stack that turned up mid-lane and a
// trestle jammed against the barrier would both read as the road having no idea
// what it was doing. The four modes below are what the catalogue can ask for;
// game/obstacles.js turns each into candidate offsets and picks one that fits.
//
//   PLACE_LANE    centred in a lane, like traffic. The thing to drive AROUND: it
//                 owns one lane and leaves the others alone. A type asking for
//                 this must be NARROWER THAN A LANE, artwork included, or it is
//                 not in the middle of anything — it spills over the centre-line
//                 or the barrier and reads as carelessly dropped. See
//                 TRESTLE_WIDTH in obstacleshapes.js, which is bounded for
//                 exactly this reason.
//   PLACE_SIDE    hard against a barrier, box flush with the edge. Road
//                 furniture that has been PUT somewhere rather than dropped: it
//                 narrows the road from one side and never blocks the middle.
//   PLACE_CENTRE  straddling the centre-line, which on a four-lane road means
//                 sitting across the two middle lanes and splitting the traffic
//                 either side of it.
//   PLACE_ANY     anywhere across the tarmac, lane centres included. For the
//                 mine, which is the one hazard nobody placed deliberately —
//                 the whole point of it is that it is not where you expect.
//
// THE PASSAGE RULE IS WHAT KEEPS THIS SAFE. Whatever a type asks for, obstacles.js
// refuses a spot that would leave no gap wide enough for the widest car in the
// catalogue to get through (see leavesPassage there). So a placement is a
// PREFERENCE about where a hazard looks right, never a promise the spawner will
// find room for it — a type whose spots are all taken simply doesn't spawn this
// interval.
export const PLACE_LANE = "lane";
export const PLACE_SIDE = "side";
export const PLACE_CENTRE = "centre";
export const PLACE_ANY = "any";

export const OBSTACLE_TYPES = [
  {
    id: "trestle",
    label: "TRESTLE",
    shape: obstacleShapeIndex("TRESTLE"),
    health: 20, // one cannon round (34 dmg) puts it down
    mass: 0.25, // lightest in the catalogue: a folding barrier, not a wall —
                // barely worth lifting off the throttle for
    blastRadius: 26,
    blastDamage: 8,
    // A lane closure, which is what a folding trestle IS, and the type the
    // traffic-avoidance work was tuned against. Keeping it on lane centres is
    // what makes that tuning mean what it says. It does NOT set the size of the
    // dodge: behaviours.js's HAZARD_DODGE_SPAN follows the MINE's free
    // placement, so narrowing this shape leaves it untouched.
    placement: PLACE_LANE,
    weight: 3, // the backbone of the roadblock spread — see cartypes.js's sedan
    minDistance: 200,
  },
  {
    id: "barrels",
    label: "BARRELS",
    shape: obstacleShapeIndex("BARRELS"),
    health: 45, // two cannon rounds — sturdier than it looks, but barging it is
    // still free: see blastDamage below
    mass: 0.5, // a real bump, not a shrug, but still under any car in the
               // catalogue — bargeable, as the header promises
    blastRadius: 30,
    blastDamage: 5, // the deliberate exception — see the header
    // Against a barrier. Barrels are the softest hit in the catalogue and
    // effects.js calls their burst "the one destruction in the game that is good
    // news" — so they are worth going OUT OF YOUR WAY for, and putting them at
    // the road's edge is what makes that a decision. Mid-lane they would just be
    // free points collected on the racing line.
    placement: PLACE_SIDE,
    weight: 1,
    minDistance: 600,
  },
  {
    id: "tetra",
    label: "TETRA",
    shape: obstacleShapeIndex("TETRA"),
    health: 80, // three cannon rounds — the one roadblock worth just steering
    // around rather than shooting out
    mass: 3.5, // near the rig's own 4 (cartypes.js) — a tank trap earns its
               // "immovable" billing at the wheel, not just at the gun
    blastRadius: 30,
    blastDamage: 24, // heaviest hit among the blocks, matching its "immovable" billing
    // Straddling the centre-line, splitting the road in two. The tank trap is
    // the one block worth steering around rather than shooting out, and putting
    // it in the middle is what turns that into a CHOICE OF SIDE made early —
    // which is the most interesting thing a static object can ask of a driver.
    placement: PLACE_CENTRE,
    weight: 1,
    minDistance: 1000,
  },
  {
    id: "caltrop",
    label: "CALTROP",
    shape: obstacleShapeIndex("CALTROP"),
    // The minimum in the catalogue, deliberately: a mine goes off on the FIRST
    // thing that touches it, gunfire included — there is no such thing as a
    // mine that "mostly" survives a hit.
    health: 1,
    mass: 0.15, // lowest in the catalogue on purpose — see the header. What a
                // mine does to a car is all in blastDamage below, not this
    // A real explosive, not a debris field: wide enough to reach past the car
    // that found it, unlike the blocks' contact-only radii above.
    blastRadius: 66,
    blastDamage: 30, // the single hardest hit anything on the road can deal
    // ANYWHERE, and it is the only type that gets to be. The other three are
    // road furniture — somebody put them there, and where they sit says so. A
    // mine is the opposite: nobody laid it out for the player's benefit, and
    // being off the lane grid is precisely what makes it read as a mine rather
    // than as a very small roadblock. It is also the narrowest thing in the
    // catalogue (26px), so it can afford to be anywhere without closing the road.
    placement: PLACE_ANY,
    weight: 0.5, // rare — see cartypes.js's rival for the same reasoning
    minDistance: 1200,
  },
];

// Whether `type` may appear yet, given the RAW world odometer. Mirrors
// cartypes.js's typeAvailable — the readout-unit conversion happens here so no
// caller has to know about it.
export function obstacleAvailable(type, distance) {
  return distance >= (type.minDistance ?? 0) * DIST_UNITS;
}

// A random obstacle type the player has driven far enough to meet, honouring
// `weight`. Mirrors cartypes.js's pickCarType exactly, gate included — same
// shape of problem, same answer — so read the reasoning there: the eligible
// types are REWEIGHTED rather than re-rolled, and null means nothing is
// unlocked yet (obstacles.js treats that as "no room this interval").
export function pickObstacleType(distance = Infinity) {
  let total = 0;
  for (const type of OBSTACLE_TYPES) {
    if (obstacleAvailable(type, distance)) total += type.weight;
  }
  if (total <= 0) return null;

  let roll = Math.random() * total;
  let last = null;
  for (const type of OBSTACLE_TYPES) {
    if (!obstacleAvailable(type, distance)) continue;
    last = type;
    roll -= type.weight;
    if (roll <= 0) return type;
  }
  return last;
}

// One named obstacle type. Mirrors cartypes.js's carTypeById, and exists for the
// same reason the `shape` fields above are looked up by name: something that
// wants THE MINE specifically — an enemy car's mine layer (game/armament.js) —
// must not reach in by index and get a trestle the day the catalogue is
// reordered.
export function obstacleTypeById(id) {
  return OBSTACLE_TYPES.find((t) => t.id === id) ?? null;
}
