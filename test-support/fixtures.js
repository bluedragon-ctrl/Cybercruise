// Fixtures shared by more than one file of the invariant suite.
//
// OUTSIDE test/ ON PURPOSE. Node's test runner treats every .js file under a
// directory named `test` as a test file — including one that only exports
// helpers, which would then be reported as an extra passing "test" with no
// assertions in it. Keeping shared fixtures here means `node --test test/`
// scans only real test files, and this module is reached the ordinary way,
// by being imported.
import { DRIVING_PROFILES } from "../src/game/driving.js";
import { CAR_TYPES } from "../src/game/cartypes.js";

// A fixture car. Traffic cars are built by traffic.js, which hands them the two
// things behaviours.js reads that a plain object literal would not have: the
// driving profile (`drive`) and the tolerances rolled from it. Defaults are the
// commuter's — careful, dead centre in its lane, unwilling to hit anything.
export const COMMUTER = DRIVING_PROFILES.commuter;
export function driver(over = {}) {
  return {
    drive: COMMUTER, nerve: 0, contact: 0, heldTime: 0, alive: true,
    ...over,
  };
}

// The slowest CRUISE on the road, not the lowest floor — cartypes.js's two
// speed bands are different numbers and every caller here means the cruise one.
export const slowest = Math.min(...CAR_TYPES.map((t) => t.cruiseMin));
export const fastest = Math.max(...CAR_TYPES.map((t) => t.speedMax));
