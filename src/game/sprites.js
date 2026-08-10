// Shared, pure asset-drawing functions (no game state). Both the live game
// entities and the asset gallery (demo.html) call these, so a visual tweak here
// updates the game and the gallery at once. Everything is drawn centred at a
// given (cx, cy) so callers control placement.

import { glowPoly, glowLine } from "../engine/neon.js";
import { getSprite, blitSprite, blitSpriteRotated, blitSpriteMaterialising } from "../engine/spritecache.js";
import { drawCarShape, carShapeExtent, CAR_SHAPES } from "./carshapes.js";
import { drawObstacleShape, obstacleExtent, OBSTACLE_SHAPES } from "./obstacleshapes.js";
import {
  drawShape,
  shapeExtent,
  fillPoly,
  SHAPE_COUNT,
} from "./buildingshapes.js";
import { drawNode, nodeExtent } from "./nodeshapes.js";
import {
  PLAYER,
  PLAYER_THRUST,
  BUILDING_EDGE,
  BUILDING_EDGE_DIM,
  BUILDING_FILL,
  BUILDING_FILL_SIDE,
  BUILDING_FILL_ROOF,
  NODE_BRACKET,
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
    accent,
    w,
    h,
    wheelPhase = 0, // scrolls the wheel tread to fake rotation (px travelled)
  } = opts;
  drawCarShape(ctx, cx, cy, shape, { color, thrust, accent, w, h, wheelPhase });
}

// A road obstacle — roadblock or mine — pointing "up" like everything else on
// the tarmac. The geometry lives in the catalogue (game/obstacleshapes.js); this
// is the entry point the gallery and the cached wrapper both call. `pulse`
// (0..1) drives a mine's blink and is ignored by the inert roadblocks.
export function drawObstacle(ctx, cx, cy, opts = {}) {
  const { shape = 0, pulse = 1 } = opts;
  drawObstacleShape(ctx, cx, cy, shape, pulse);
}

// An extruded "cube" building — a wireframe box rising off the grid, giving the
// roadside a simple 2.5D skyline while the FOOTPRINT stays flat on the ground
// plane (so it scrolls in perfect sync with the road; only the roof is offset).
// Deliberately flat-shaded geometry, no windows: the design doc's target is a
// tactical map (symbolic blocks), not photographic detail, and a denser city of
// smaller footprints reads as blocks, not a texture, once nothing on a building
// needs to be big enough to resolve a window grid.
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
    color = BUILDING_EDGE,
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
  glowLine(ctx, farCorner[0], farCorner[1], nearCorner[0], nearCorner[1], BUILDING_EDGE_DIM, 1, 5);
  glowLine(ctx, nearCorner[0], nearCorner[1], offCorner[0], offCorner[1], BUILDING_EDGE_DIM, 1, 5);

  // Three visible vertical edges: the two silhouette sides plus the crease where
  // the front and side walls meet. The fourth (rear, hidden) vertical is skipped.
  for (const p of [farCorner, nearCorner, offCorner]) {
    const t = off(p);
    glowLine(ctx, p[0], p[1], t[0], t[1], color, 1.5, 8);
  }

  // Roof (brightest — it's the top and furthest from the ground). All four of its
  // edges are on the silhouette, so the whole quad is stroked.
  glowPoly(ctx, [tFL, tFR, tBR, tBL], color, 1.5, 10);
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
// Exported so the sprite-cache budget in cartypes.js can be asserted rather than
// only documented (see test/invariants.test.js).
export const WHEEL_FRAMES = 8;

// Cached drawCar. Identical output to drawCar, except the wheel tread snaps to
// one of WHEEL_FRAMES positions and the whole car is rotated by `angle` radians
// (the road's heading — see road.headingAt) so it points where it is driving.
//
// `angle` is applied to the BLIT and is deliberately absent from the cache key,
// which is what keeps the catalogue at its documented size no matter how many
// distinct headings the traffic is spread across. See blitSpriteRotated.
export function drawCarCached(ctx, cx, cy, opts = {}) {
  const {
    shape = 0,
    color = PLAYER,
    thrust = PLAYER_THRUST,
    accent,
    w = CAR_SHAPES[shape].size[0],
    h = CAR_SHAPES[shape].size[1],
    wheelPhase = 0,
    angle = 0,
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

  const key = `car|${shape}|${color}|${thrust}|${accent}|${w}|${h}|${frame}`;
  const sprite = getSprite(key, sw, sh, originX, originY, (sctx, ox, oy) =>
    drawCarShape(sctx, ox, oy, shape, {
      color,
      thrust,
      accent,
      w,
      h,
      wheelPhase: (frame / WHEEL_FRAMES) * WHEEL_PERIOD,
    }),
  );
  blitSpriteRotated(ctx, sprite, cx, cy, angle);
}

// A mine's pulse is continuous, so it is quantised before it reaches the cache
// key — otherwise every frame would mint a new sprite and the cache would grow
// without bound. 8 steps is more than the eye can resolve in a blink this small,
// and it caps the whole obstacle catalogue at (blocks + 8) sprites.
const PULSE_FRAMES = 8;

// Cached drawObstacle. Identical output, except a mine's pulse snaps to one of
// PULSE_FRAMES levels and the whole obstacle is rotated by `angle` to sit square
// on the tarmac. Obstacles rotate for the same reason cars do, and it matters
// MORE for the ones that span a lane: a roadblock left axis-aligned beside cars
// that lean into the bend reads as more broken than nothing rotating at all.
// Inert obstacles ignore `pulse` entirely and therefore key to a single sprite
// each — `angle` never touches the key either.
export function drawObstacleCached(ctx, cx, cy, opts = {}) {
  const { shape = 0, pulse = 1, angle = 0 } = opts;
  const pulses = OBSTACLE_SHAPES[shape]?.pulse;
  const frame = pulses ? Math.min(PULSE_FRAMES - 1, Math.floor(pulse * PULSE_FRAMES)) : 0;

  // Extents come from the catalogue: spikes and end caps reach past the body by
  // different amounts per shape, so one fixed padding would clip some and waste
  // memory on others. Obstacles are symmetric about their anchor in x but not
  // necessarily in y (the pylon cluster is staggered), so up/down are separate.
  const ext = obstacleExtent(shape);
  const originX = ext.x + GLOW_PAD;
  const originY = ext.up + GLOW_PAD;
  const sw = ext.x * 2 + GLOW_PAD * 2;
  const sh = ext.up + ext.down + GLOW_PAD * 2;

  const key = `obs|${shape}|${frame}`;
  const sprite = getSprite(key, sw, sh, originX, originY, (sctx, ox, oy) =>
    drawObstacleShape(sctx, ox, oy, shape, (frame + 0.5) / PULSE_FRAMES),
  );
  blitSpriteRotated(ctx, sprite, cx, cy, angle);
}

// A fixed catalogue of building looks. Placement code picks a variant INDEX
// instead of rolling continuous dimensions, which is what caps the cache: at
// most BUILDING_VARIANTS * 2 sprites (one per lean direction) exist no matter
// how large the city grows. Rolling w/d/height freely would key the cache on
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
// skyline from a small catalogue. Dimensions land on 8px steps — a divisor of
// scenery.js's GRID_SPACING, so a footprint's edges land on grid lines.
//
// w/d are sized to fit a LOT (citygrid.js — 64, a quarter of the old 128
// PLOT a single building used to have to itself), not the screen: the
// largest, 48 x 40, leaves margin on every side even before citygrid.js's
// siting pushes it toward a kerb, the way the old 90 x 58 fit inside a 128
// plot with room around it. height is DELIBERATELY NOT shrunk to match —
// vertical variety is what stops a denser city of smaller footprints reading
// as a uniform field of small blocks, and it costs nothing extra to keep.
function variantOpts(v, leanRight) {
  return {
    w: 24 + ((v * 3) % 4) * 8, // 24..48
    d: 24 + ((v * 5) % 3) * 8, // 24..40
    height: 24 + ((v * 7) % 10) * 8, // 24..96, unchanged
    skew: leanRight ? 0.26 : -0.26,
    color: BUILDING_EDGE,
  };
}

// A variant's ground footprint alone, for citygrid.js's siting math — it needs
// w/d to push a footprint toward a kerb before any building is drawn, and
// pulling in the whole sprite/cache machinery just for two numbers would put a
// canvas dependency in a module the test suite imports under plain Node.
// leanRight doesn't affect w/d (only skew does), so it's fixed arbitrarily.
export function buildingFootprint(v) {
  const o = variantOpts(v, true);
  return { w: o.w, d: o.d };
}

// Cached drawBuilding, anchored (like drawBuilding) at the BASE CENTRE so
// callers keep placing buildings by their footprint on the ground plane.
// `leanRight` picks which way the roof skews, so a building can lean away from
// screen centre without doubling the variant catalogue.
//
// `sector` (Phase 7f) rides along in the cache key, not just in `o.color`
// above. BUILDING_EDGE/BUILDING_FILL* are LIVE bindings (engine/palette.js's
// setSector), but `getSprite` below only re-runs its draw callback on a cache
// MISS — a building revisited after a sector crossing would otherwise blit
// whatever colour was baked into its sprite the first time it was ever drawn,
// forever, since the cache key wouldn't have changed. Bounds the whole
// catalogue at BUILDING_VARIANTS * 2 * SECTOR_COUNT — still cheap to
// multiply (see palette.js's own note on why this cache and the car
// catalogue's are on opposite sides of that line).
// `progress` (Phase 7g, default 1) is the entry-wipe fraction from
// scenery.js's materialiseProgress — 1 for the ~70-odd already-materialised
// buildings a typical frame draws, which takes the exact blitSprite call
// this function has always made. Only a building whose LOT ROW is still
// inside WIPE_SPAN of its own entry pays for anything more: the branch below
// is what keeps that a save/clip/restore on a couple of blits a frame, not
// on all of them.
//
// `rowSy` (Phase 7g, only read when progress < 1) is the row's own RAW
// screen-y — always inside (0, WIPE_SPAN) whenever this branch runs, since
// materialiseProgress(rowSy) < 1 is exactly what got us here. It, not
// `progress`, is what the clip below is scaled by: WIPE_SPAN (60) is short
// against a sprite's own height (100-170px including glow padding), so a
// clip scaled by `progress` — a FRACTION OF THE SPRITE — would grow past
// what the canvas's own top-edge clip is already hiding within the first
// ~third of the span, making the wipe invisible for the rest of it (found
// by instrumenting the clip and comparing it against the canvas edge, after
// the effect didn't show up in the browser). Scaling by rowSy/sh instead —
// an absolute px budget, not a fraction of a number this floor never
// otherwise varies the wipe's speed by — keeps the clip strictly ahead of
// (more restrictive than) the natural edge for the whole span.
export function drawBuildingVariant(ctx, cx, cy, v, leanRight, sector, progress = 1, rowSy = 0) {
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

  const key = `bldg|${v}|${leanRight ? 1 : 0}|${sector}`;
  const sprite = getSprite(key, sw, sh, originX, originY, (sctx, sx, sy) =>
    shape === 0 ? drawBuilding(sctx, sx, sy, o) : drawShape(sctx, sx, sy, shape - 1, o),
  );
  if (progress >= 1) {
    blitSprite(ctx, sprite, cx, cy);
  } else {
    const spriteProgress = Math.min(1, Math.max(0, rowSy) / sh);
    // o.color is BUILDING_EDGE (variantOpts, above) — the scan reads as
    // this building's own outline lighting up, not a generic overlay.
    blitSpriteMaterialising(ctx, sprite, cx, cy, spriteProgress, o.color, GLOW_PAD);
  }
}

// Cached drawNode (nodeshapes.js), anchored at its own centre — a node has no
// footprint edge to flush against (citygrid.js sites it at the plot centre,
// unlike a building's kerb-pushed lot), and no lean: it is flat and
// symmetric, so unlike drawBuildingVariant there is exactly one sprite per
// (variant, sector) pair, not one per (variant, lean direction). `v` comes
// straight from citygrid.js's reserve(), already bounded to [0,
// NODE_VARIANTS) — `sector` (Phase 7f) is the second, equally-bounded factor
// (see drawBuildingVariant's own comment on why it has to be in the key at
// all: NODE_BRACKET/NODE_GLYPH are live bindings too), so the key below can
// never mint more than NODE_VARIANTS * SECTOR_COUNT entries no matter how
// large the city grows.
// `progress`/`rowSy` (Phase 7g, both default to the "fully materialised"
// case) — same contract as drawBuildingVariant's own; see its comment for
// why the clip below is scaled by rowSy/sh rather than by progress alone.
export function drawNodeVariant(ctx, cx, cy, v, sector, progress = 1, rowSy = 0) {
  const ext = nodeExtent(v);
  const originX = ext.left + GLOW_PAD;
  const originY = ext.up + GLOW_PAD;
  const sw = ext.left + ext.right + GLOW_PAD * 2;
  const sh = ext.up + ext.down + GLOW_PAD * 2;

  const key = `node|${v}|${sector}`;
  const sprite = getSprite(key, sw, sh, originX, originY, (sctx, sx, sy) => drawNode(sctx, sx, sy, v));
  if (progress >= 1) {
    blitSprite(ctx, sprite, cx, cy);
  } else {
    const spriteProgress = Math.min(1, Math.max(0, rowSy) / sh);
    // NODE_BRACKET is a node's own outline colour (nodeshapes.js), the same
    // pairing drawBuildingVariant's o.color/BUILDING_EDGE is above.
    blitSpriteMaterialising(ctx, sprite, cx, cy, spriteProgress, NODE_BRACKET, GLOW_PAD);
  }
}
