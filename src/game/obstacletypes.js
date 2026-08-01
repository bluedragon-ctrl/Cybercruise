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
//   weight      relative spawn frequency (see obstacles.js's pickObstacleType)
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

export const OBSTACLE_TYPES = [
  {
    id: "trestle",
    label: "TRESTLE",
    shape: obstacleShapeIndex("TRESTLE"),
    health: 20, // one cannon round (34 dmg) puts it down
    blastRadius: 26,
    blastDamage: 8,
    weight: 3, // the backbone of the roadblock spread — see cartypes.js's sedan
  },
  {
    id: "barrels",
    label: "BARRELS",
    shape: obstacleShapeIndex("BARRELS"),
    health: 45, // two cannon rounds — sturdier than it looks, but barging it is
    // still free: see blastDamage below
    blastRadius: 30,
    blastDamage: 5, // the deliberate exception — see the header
    weight: 2.5,
  },
  {
    id: "tetra",
    label: "TETRA",
    shape: obstacleShapeIndex("TETRA"),
    health: 80, // three cannon rounds — the one roadblock worth just steering
    // around rather than shooting out
    blastRadius: 30,
    blastDamage: 24, // heaviest hit among the blocks, matching its "immovable" billing
    weight: 1.2,
  },
  {
    id: "caltrop",
    label: "CALTROP",
    shape: obstacleShapeIndex("CALTROP"),
    // The minimum in the catalogue, deliberately: a mine goes off on the FIRST
    // thing that touches it, gunfire included — there is no such thing as a
    // mine that "mostly" survives a hit.
    health: 1,
    // A real explosive, not a debris field: wide enough to reach past the car
    // that found it, unlike the blocks' contact-only radii above.
    blastRadius: 66,
    blastDamage: 30, // the single hardest hit anything on the road can deal
    weight: 0.8, // rare — see cartypes.js's rival for the same reasoning
  },
];

const TOTAL_WEIGHT = OBSTACLE_TYPES.reduce((sum, t) => sum + t.weight, 0);

// A random obstacle type, honouring `weight`. Mirrors cartypes.js's
// pickCarType exactly — same shape of problem, same answer.
export function pickObstacleType() {
  let roll = Math.random() * TOTAL_WEIGHT;
  for (const type of OBSTACLE_TYPES) {
    roll -= type.weight;
    if (roll <= 0) return type;
  }
  return OBSTACLE_TYPES[OBSTACLE_TYPES.length - 1];
}
