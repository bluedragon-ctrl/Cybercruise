// Roadside buildings — cube/extruded wireframe boxes placed alongside the road.
//
// Like the road itself, placement is STATELESS and deterministic: a building is
// a pure function of its "slot" (an integer index along the road x a side), so
// the skyline is infinite, never pops or shifts, and needs nothing generated or
// freed as we drive. See road.js for the screen<->world coordinate model.

import { edgesAt } from "./road.js";
import { drawBuilding } from "./sprites.js";
import { GREEN } from "../engine/palette.js";

const SLOT_SPACING = 130; // world units between building slots along the road
const GAP_ROAD = 10;      // px gap between a barrier and the building's road-facing edge
const PRESENCE = 0.78;    // fraction of slots that actually hold a building

// Deterministic hash -> [0, 1) from any number.
function hash(n) {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}

// Draw every visible roadside building, far (top) to near (bottom) so nearer
// buildings correctly overlap the ones behind them (painter's algorithm).
export function render(ctx, distance, playerY, W, H) {
  // World range in view, with headroom so tall buildings entering/leaving at the
  // top and their upward extrusions aren't clipped early.
  const worldBottom = distance + playerY - H - 40;
  const worldTop = distance + playerY + 180;
  const kMin = Math.floor(worldBottom / SLOT_SPACING);
  const kMax = Math.ceil(worldTop / SLOT_SPACING);

  for (let k = kMax; k >= kMin; k--) {
    const worldY = k * SLOT_SPACING;
    const sy = playerY - (worldY - distance); // base-centre screen y
    const edges = edgesAt(worldY, W);

    for (let side = 0; side < 2; side++) {
      const seed = k * 2 + side + 1000;
      if (hash(seed * 1.13) > PRESENCE) continue; // some slots stay empty

      const height = 28 + hash(seed * 2.31) * 82;
      const w = 42 + hash(seed * 3.77) * 52;
      const d = 40 + hash(seed * 4.91) * 28;
      const lit = 0.3 + hash(seed * 5.53) * 0.5;

      let cx;
      let skew;
      if (side === 0) {
        // Left roadside: road-facing (right) edge sits just outside the left
        // barrier; the building extends toward / off the left screen edge and
        // leans left (away from the road).
        cx = edges.left - GAP_ROAD - w / 2;
        skew = -0.28;
      } else {
        // Right roadside: mirror of the above.
        cx = edges.right + GAP_ROAD + w / 2;
        skew = 0.28;
      }

      drawBuilding(ctx, cx, sy, { w, d, height, color: GREEN, lit, seed, skew });
    }
  }
}
