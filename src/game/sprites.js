// Shared, pure asset-drawing functions (no game state). Both the live game
// entities and the asset gallery (demo.html) call these, so a visual tweak here
// updates the game and the gallery at once. Everything is drawn centred at a
// given (cx, cy) so callers control placement.

import { glowPoly, glowLine } from "../engine/neon.js";
import { getSprite, blitSprite } from "../engine/spritecache.js";
import { drawCarShape, carShapeExtent, CAR_SHAPES } from "./carshapes.js";
import {
  drawShape,
  shapeExtent,
  fillPoly,
  drawWallWindows,
  SHAPE_COUNT,
} from "./buildingshapes.js";
import {
  PLAYER,
  PLAYER_THRUST,
  GREEN,
  GREEN_DIM,
  BUILDING_FILL,
  BUILDING_FILL_SIDE,
  BUILDING_FILL_ROOF,
} from "../engine/palette.js";

// A detailed top-down car wireframe, pointing "up" (toward smaller y). Shared by
// the player and by traffic, which differ by SHAPE (see game/carshapes.js) as
// well as colour.
//
// The geometry itself lives in the shape catalogue; this stays as the entry point
// the gallery and the cached wrapper both call. `shape` indexes CAR_SHAPES, and
// 0 is the original supercar, so an omitted `shape` keeps the player's look.
export function drawCar(ctx, cx, cy, opts = {}) {
  const {
    shape = 0,
    color = PLAYER,
    thrust = PLAYER_THRUST,
    w,
    h,
    wheelPhase = 0, // scrolls the wheel tread to fake rotation (px travelled)
  } = opts;
  drawCarShape(ctx, cx, cy, shape, { color, thrust, w, h, wheelPhase });
}

// An extruded "cube" building — a wireframe box rising off the grid, giving the
// roadside a simple 2.5D skyline while the FOOTPRINT stays flat on the ground
// plane (so it scrolls in perfect sync with the road; only the roof is offset).
//
// (cx, cy) is the centre of the base footprint on the grid. The roof is the same
// rectangle shifted by the extrusion vector (ox, oy) = up + slight rightward
// skew, which reveals a side wall and reads as a slightly tilted top-down camera.
// Taller `height` = taller building; vary it per building for skyline depth.
export function drawBuilding(ctx, cx, cy, opts = {}) {
  const {
    w = 70,       // footprint width  (x, along the road's cross-axis)
    d = 55,       // footprint depth  (y, along the road)
    height = 60,  // extrusion height in px
    color = GREEN,
    lit = 0.5,    // fraction of front-wall windows that are lit
    seed = 1,     // deterministic window-lighting seed (stable per building)
    skew = 0.28,  // horizontal roof shift as a fraction of height (+right / -left)
  } = opts;
  const hw = w / 2;
  const hd = d / 2;

  // Extrusion vector (base -> roof). `skew` leans the roof left/right so roadside
  // buildings can lean AWAY from the road (a natural centre vanishing point).
  const ox = height * skew;
  const oy = -height;

  // Base footprint corners (F = front/south = larger y, B = back/north).
  const bFL = [cx - hw, cy + hd];
  const bFR = [cx + hw, cy + hd];
  const bBR = [cx + hw, cy - hd];
  const bBL = [cx - hw, cy - hd];
  const off = (p) => [p[0] + ox, p[1] + oy];
  const tFL = off(bFL);
  const tFR = off(bFR);
  const tBR = off(bBR);
  const tBL = off(bBL);

  // HIDDEN-LINE REMOVAL. The box is a solid, so only three of its six faces can
  // be seen and only nine of its twelve edges. Which side wall is visible follows
  // from the extrusion: the roof shifting RIGHT means the camera sits to the
  // LEFT of the box, so we see its left wall (and vice versa). Drawing the other
  // faces' edges as well is what makes a filled box read as a see-through
  // wireframe — the far verticals and the far footprint edges get painted right
  // across the near wall.
  //
  //   nearCorner = ground corner where the front wall meets the visible side wall
  //   farCorner  = the visible side wall's other ground corner (away from camera)
  //   offCorner  = the front wall's other ground corner (on the hidden side)
  const leanRight = ox >= 0;
  const nearCorner = leanRight ? bFL : bFR;
  const farCorner = leanRight ? bBL : bBR;
  const offCorner = leanRight ? bFR : bFL;

  // OPAQUE fills first, so the box hides the floor grid and any building behind
  // it. The three visible faces tile the box's whole silhouette exactly (it's a
  // convex solid), so the hidden three need no fill at all. Each face gets its
  // own shade, which is what sells the box as lit and solid. No glow on fills.
  fillPoly(ctx, [nearCorner, farCorner, off(farCorner), off(nearCorner)], BUILDING_FILL_SIDE);
  fillPoly(ctx, [bFL, bFR, tFR, tFL], BUILDING_FILL);
  fillPoly(ctx, [tFL, tFR, tBR, tBL], BUILDING_FILL_ROOF);

  // The two visible footprint edges on the grid (dim — they sit on the ground).
  // The far two are inside the silhouette and stay unstroked.
  glowLine(ctx, farCorner[0], farCorner[1], nearCorner[0], nearCorner[1], GREEN_DIM, 1, 5);
  glowLine(ctx, nearCorner[0], nearCorner[1], offCorner[0], offCorner[1], GREEN_DIM, 1, 5);

  // Three visible vertical edges: the two silhouette sides plus the crease where
  // the front and side walls meet. The fourth (rear, hidden) vertical is skipped.
  for (const p of [farCorner, nearCorner, offCorner]) {
    const t = off(p);
    glowLine(ctx, p[0], p[1], t[0], t[1], color, 1.5, 8);
  }

  // Roof (brightest — it's the top and furthest from the ground). All four of its
  // edges are on the silhouette, so the whole quad is stroked.
  glowPoly(ctx, [tFL, tFR, tBR, tBL], color, 1.5, 10);

  // Lit windows on the front (south-facing) wall quad: A,B along the base edge,
  // C,D along the roof edge.
  drawWallWindows(ctx, bFL, bFR, tFR, tFL, color, lit, seed);
}

// ---------------------------------------------------------------------------
// CACHED VARIANTS
//
// The drawers above are pure and re-render every glowing stroke on each call,
// which is far too slow to run per entity per frame (see spritecache.js). The
// game therefore goes through the wrappers below, which pre-render each distinct
// look once and blit it thereafter. The raw drawers stay exported because the
// asset gallery (demo.html) wants arbitrary one-off parameters, and because
// these wrappers are built on top of them — so a visual tweak above still flows
// through to the game and the gallery alike.
// ---------------------------------------------------------------------------

// Margin around a cached sprite so the glow (max shadowBlur used here is 13)
// isn't clipped by the offscreen canvas edge.
const GLOW_PAD = 18;

// drawWheel lays its tread bands every 4px and wraps, so the wheel's appearance
// repeats with a period of exactly 4px of travel. Sampling that period at 8
// positions keeps the roll smooth while capping the cache at 8 frames per car
// colour (a 4px-wide wheel can't show finer detail than this anyway).
const WHEEL_PERIOD = 4;
const WHEEL_FRAMES = 8;

// Cached drawCar. Identical output to drawCar, except the wheel tread snaps to
// one of WHEEL_FRAMES positions.
export function drawCarCached(ctx, cx, cy, opts = {}) {
  const {
    shape = 0,
    color = PLAYER,
    thrust = PLAYER_THRUST,
    w = CAR_SHAPES[shape].size[0],
    h = CAR_SHAPES[shape].size[1],
    wheelPhase = 0,
  } = opts;

  // Quantise the tread scroll (positive modulo — wheelPhase only grows, but a
  // reversing entity in a later phase could hand us a negative).
  const wrapped = ((wheelPhase % WHEEL_PERIOD) + WHEEL_PERIOD) % WHEEL_PERIOD;
  const frame = Math.floor((wrapped / WHEEL_PERIOD) * WHEEL_FRAMES) % WHEEL_FRAMES;

  // Extents come from the shape itself: wheel positions are derived from the
  // profile, and details (ram bars, splitters, wings, a trailer bogie) reach
  // past it by different amounts per shape, so one fixed fraction of `w` would
  // clip some cars and waste memory on others. Cars are asymmetric along y — a
  // wing hangs off the tail — so the anchor is offset rather than centred.
  const ext = carShapeExtent(shape, w, h);
  const originX = ext.x + GLOW_PAD;
  const originY = ext.up + GLOW_PAD;
  const sw = ext.x * 2 + GLOW_PAD * 2;
  const sh = ext.up + ext.down + GLOW_PAD * 2;

  const key = `car|${shape}|${color}|${thrust}|${w}|${h}|${frame}`;
  const sprite = getSprite(key, sw, sh, originX, originY, (sctx, ox, oy) =>
    drawCarShape(sctx, ox, oy, shape, {
      color,
      thrust,
      w,
      h,
      wheelPhase: (frame / WHEEL_FRAMES) * WHEEL_PERIOD,
    }),
  );
  blitSprite(ctx, sprite, cx, cy);
}

// A fixed catalogue of building looks. Placement code picks a variant INDEX
// instead of rolling continuous dimensions, which is what caps the cache: at
// most BUILDING_VARIANTS * 2 sprites (one per lean direction) exist no matter
// how large the city grows. Rolling w/d/height/lit freely would key the cache on
// a product of continuous ranges — tens of thousands of entries — and defeat it.
export const BUILDING_VARIANTS = 24;

// Silhouette variety comes from PARTITIONING this catalogue, not from growing
// it: every third slot is one of the shapes in buildingshapes.js instead of a
// box, so the city gains pyramids, drums and spires at exactly the same sprite
// count, memory and per-frame cost as before. Giving each shape its own 24
// variants would have multiplied the cache instead (48 sprites and ~3MB per
// shape) for variety the eye can't tell apart at this size anyway.
const SHAPE_EVERY = 3;

// Which shape variant `v` draws: 0 for the classic box, otherwise 1 + an index
// into buildingshapes.js's catalogue.
function variantShape(v) {
  if (v % SHAPE_EVERY !== 2) return 0;
  return 1 + (Math.floor(v / SHAPE_EVERY) % SHAPE_COUNT);
}

// Deterministic parameters for variant `v`. The multipliers are chosen so each
// field cycles through its full range at a different rate, giving a varied
// skyline from a small catalogue. Dimensions land on 8px steps.
function variantOpts(v, leanRight) {
  return {
    w: 42 + ((v * 3) % 7) * 8, // 42..90
    d: 34 + ((v * 5) % 4) * 8, // 34..58
    height: 24 + ((v * 7) % 10) * 8, // 24..96
    lit: 0.3 + ((v * 11) % 6) * 0.1, // 0.3..0.8
    seed: v + 1,
    skew: leanRight ? 0.26 : -0.26,
    color: GREEN,
  };
}

// Cached drawBuilding, anchored (like drawBuilding) at the BASE CENTRE so
// callers keep placing buildings by their footprint on the ground plane.
// `leanRight` picks which way the roof skews, so a building can lean away from
// screen centre without doubling the variant catalogue.
export function drawBuildingVariant(ctx, cx, cy, v, leanRight) {
  const o = variantOpts(v, leanRight);
  const shape = variantShape(v);

  // Bounding box relative to the base centre. For the box it's roof-shifted up
  // by `height` and sideways by `height * skew`, so only one side gains
  // horizontal extent; the other shapes measure their own sections.
  let ext;
  if (shape === 0) {
    const roofShift = o.height * o.skew;
    ext = {
      left: o.w / 2 + Math.max(0, -roofShift),
      right: o.w / 2 + Math.max(0, roofShift),
      up: o.d / 2 + o.height,
      down: o.d / 2,
    };
  } else {
    ext = shapeExtent(shape - 1, o);
  }
  const originX = ext.left + GLOW_PAD;
  const originY = ext.up + GLOW_PAD;
  const sw = ext.left + ext.right + GLOW_PAD * 2;
  const sh = ext.up + ext.down + GLOW_PAD * 2;

  const key = `bldg|${v}|${leanRight ? 1 : 0}`;
  const sprite = getSprite(key, sw, sh, originX, originY, (sctx, sx, sy) =>
    shape === 0 ? drawBuilding(sctx, sx, sy, o) : drawShape(sctx, sx, sy, shape - 1, o),
  );
  blitSprite(ctx, sprite, cx, cy);
}
