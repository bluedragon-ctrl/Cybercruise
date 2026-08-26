// Extra building silhouettes — pyramids, ziggurats, drums, spires — so the city
// isn't wall-to-wall cubes, plus the small projection kit they're built from.
//
// THE PROJECTION
// --------------
// One oblique camera for the whole city: the footprint is drawn in plan view
// on the ground plane, and height maps to a screen offset of
// (z * skew, -z). A footprint offset (fx, fy) at height z therefore lands at
//   (cx + fx + z * skew, cy + fy - z)
//
// WHICH FACES YOU SEE
// -------------------
// Because height leans by `skew`, the eye sits along (-skew, +1, +1): below the
// city, and off to whichever side the roofs lean AWAY from. A face is visible
// exactly when its outward normal points that way. That one test generalises
// the hand-derived "roof leans right => you see the left wall" this started as
// to ANY footprint, which is what makes hidden-line removal on a 16-sided drum
// no harder than on a box — and hidden-line removal is the whole
// game here, since drawing the far edges is what makes a solid read as a
// see-through wireframe.
//
// SHAPES ARE DATA
// ---------------
// A shape is a list of prism SECTIONS: a footprint polygon swept between two
// heights, optionally tapering to a smaller top (or to a point), optionally with
// per-vertex roof heights (a slanted roof). Stacking sections gives setbacks,
// masts and sky bridges without any new drawing code.
//
// Crucially the renderer AND the sprite bounding box are both derived from that
// same list, so a new shape can never draw outside the offscreen canvas the
// sprite cache sized for it. Adding a shape means adding one DATA ENTRY to
// the catalogue below — no new drawing code, and no JavaScript at all beyond
// the literal itself.
//
// COST: none per frame. These go through the same sprite cache as the box (see
// spritecache.js) — a shape is rendered once and blitted (~1.3us) thereafter, so
// what a shape costs to draw only affects the single frame it first appears on.

import { glowLine, glowPoly } from "../engine/neon.js";
import { polygon } from "./polygon.js";
import {
  BUILDING_EDGE,
  BUILDING_EDGE_DIM,
  BUILDING_FILL,
  BUILDING_FILL_SIDE,
  BUILDING_FILL_ROOF,
} from "../engine/palette.js";

const TAU = Math.PI * 2;

// ---------------------------------------------------------------------------
// Footprints — plan-view offsets from the base centre, any winding order.
// ---------------------------------------------------------------------------

function rect(w, d) {
  const hw = w / 2;
  const hd = d / 2;
  return [[-hw, hd], [hw, hd], [hw, -hd], [-hw, -hd]];
}

// A regular n-gon stretched to fill w x d. `rot` in turns; the default puts a
// flat edge at the front for even n, which faces the camera squarely.
// NOTE `rot` is in TURNS here, not radians — the footprint table below reads far
// better as `ngon(w, d, 6, 0.5)` than with a TAU on every row. polygon() takes
// radians, so the conversion lives here, once.
const ngon = (w, d, n, rot = 0) => polygon(0, 0, w / 2, d / 2, n, rot * TAU);

// Shifts a footprint sideways/forward — used to place towers side by side.
function at(pts, dx, dy) {
  return pts.map(([x, y]) => [x + dx, y + dy]);
}

// One prism section. `base` is swept from height `z0` to `z1`.
//   topScale  shrinks the top about the footprint centre (0 = a point => a cone
//             or pyramid; 1 = straight sides)
//   topZ      per-vertex roof heights, for a slanted roof (defaults to z1)
//   smooth    the footprint approximates a curve, so only draw the outline
//             verticals, not one per facet
//   ribEvery  dim vertical accent lines every N facets (curved walls)
function section(base, z0, z1, opts = {}) {
  return { base, z0, z1, topScale: 1, smooth: false, ribEvery: 0, ...opts };
}

// ---------------------------------------------------------------------------
// The catalogue. A shape is DATA: a list of prism sections, each stated in
// FRACTIONS of the shared dimensions (w, d, height) rather than in pixels, so
// every shape still answers to the same variant rolls as the box. compile()
// below turns one into the { sections, beacons } the renderer consumes, so the
// renderer never learns the difference.
//
// WHY DATA RATHER THAN A FUNCTION. A builder could do anything, and that freedom
// bought nothing: every shape here was already the same four moves — pick a
// footprint, sweep it between two heights, maybe taper it, maybe slant its roof.
// As data a shape can be authored, diffed, generated or round-tripped through a
// tool without writing JavaScript, and the interpreter runs once per sprite
// cache MISS, never per frame.
//
// AND WHY NOT IMAGE ASSETS, which is the other place this reasoning leads. Four
// things in this codebase need a building to be geometry rather than pixels:
// sprites are keyed by SECTOR because palette.js's setSector recolours every
// one of them; they are rasterised at whatever device resolution the window
// currently has (spritecache.js drops the lot when that changes); citygrid.js
// sites a building from its FOOTPRINT; and the entry wipe lightens a building's
// own edge colour. Data keeps all four. A PNG throws all four away and costs
// megabytes to do it.
//
// FRACTIONS OF WHAT:
//   plan      ["rect", fw, fd] or ["ngon", fw, fd, n, rot] — fw/fd multiply
//             o.w / o.d, and `rot` is in TURNS, as ngon() takes it
//   offset    [dx, dy], multiplying o.w / o.d — towers set side by side
//   z         [z0, z1], multiplying o.height. MAY EXCEED 1: a mast does
//   topScale  as section(): 0 tapers to a point, 1 is straight-sided
//   topZ      per-vertex roof heights, also multiplying o.height
//   smooth, ribEvery   as section()
//   beacons   [x, y, z], multiplying o.w / o.d / o.height
// ---------------------------------------------------------------------------

const SHAPES = [
  {
    // THE BOX — the plain extruded cube the city is mostly made of, and the
    // reason the rest of this catalogue exists (so the skyline isn't wall to
    // wall cubes). It is stated here rather than drawn by a renderer of its own:
    // sprites.js used to carry a hand-derived drawBuilding() that reasoned out
    // hidden-line removal for this one solid, which is the general case
    // drawSection already handles for a 16-sided drum.
    //
    // ITS WEIGHT IS THE POINT. The box is the city's NEUTRAL form, and a drum
    // only reads as special when most of what surrounds it does not — so it
    // takes a third of the variant slots and every sculptural shape divides
    // what's left. Drop this below about a quarter and the skyline stops having
    // a rhythm for the others to stand out against.
    name: "BOX",
    weight: 8,
    sections: [{ plan: ["rect", 1, 1], z: [0, 1] }],
  },
  {
    // One section tapering to a point, with a beacon at the apex.
    name: "PYRAMID",
    weight: 1,
    sections: [{ plan: ["rect", 1, 1], z: [0, 1], topScale: 0 }],
    beacons: [[0, 0, 1]],
  },
  {
    // Three setback tiers.
    name: "ZIGGURAT",
    weight: 3,
    sections: [
      { plan: ["rect", 1, 1], z: [0, 0.3] },
      { plan: ["rect", 0.72, 0.72], z: [0.3, 0.68] },
      { plan: ["rect", 0.44, 0.44], z: [0.68, 1] },
    ],
  },
  {
    // A single wall sloping inward, the classic setback skyscraper.
    name: "TAPER",
    weight: 3,
    sections: [{ plan: ["rect", 1, 1], z: [0, 1], topScale: 0.55 }],
  },
  {
    // A round tower. 16 facets read as a curve once the per-facet creases are
    // suppressed; the ribs put some vertical detail back.
    name: "DRUM",
    weight: 2,
    sections: [{ plan: ["ngon", 1, 1, 16], z: [0, 1], smooth: true, ribEvery: 3 }],
  },
  {
    // A slim tower carrying a tapered mast and a beacon.
    name: "SPIRE",
    weight: 1,
    sections: [
      { plan: ["rect", 0.66, 0.66], z: [0, 0.78] },
      { plan: ["rect", 0.16, 0.16], z: [0.78, 1.4], topScale: 0.35 },
    ],
    beacons: [[0, 0, 1.4]],
  },
  {
    // A slanted roof, low at the front and full height at the back. Per-vertex
    // roof heights, in the footprint's own vertex order: rect() starts at the
    // front-left corner and runs front-left, front-right, back-right, back-left.
    name: "WEDGE",
    weight: 2,
    sections: [{ plan: ["rect", 1, 1], z: [0, 1], topZ: [0.5, 0.5, 1, 1] }],
  },
  {
    // A hexagonal prism. Three walls face the camera instead of two, so the
    // facing-based shading gives it a rounded, lit look.
    name: "HEX",
    weight: 3,
    sections: [{ plan: ["ngon", 1, 1.1, 6], z: [0, 1] }],
  },
  {
    // Four setback tiers, each TURNED against the one below so a corner sits
    // over the middle of the tier beneath it. The ROTATION, not the setback, is
    // what separates them — which is why two tiers here can be nearly the same
    // size and the stack still reads as stepped, where the ziggurat has to
    // shrink hard at every step to say the same thing.
    //
    // A diamond of the same w x d covers HALF the area of the box it alternates
    // with, so the turned tiers are scaled up. Without that the stack reads as
    // shrinking twice as fast as it really does, and the overhang the whole
    // alternation exists for never appears.
    name: "PINWHEEL",
    weight: 1,
    sections: [
      { plan: ["rect", 1, 1], z: [0, 0.26] },
      { plan: ["ngon", 1.15, 1.15, 4, 0], z: [0.26, 0.54] },
      { plan: ["rect", 0.72, 0.72], z: [0.54, 0.78] },
      { plan: ["ngon", 0.82, 0.82, 4, 0], z: [0.78, 1] },
    ],
  },
];

export const SHAPE_NAMES = SHAPES.map((s) => s.name);
// How many of the city's variant slots each silhouette gets — its RARITY. Stated
// per shape, next to the shape, the same way cartypes.js states a car's spawn
// `weight` on the car. sprites.js expands these into the slot table; see the
// note there for why the totals are what they are.
export const SHAPE_WEIGHTS = SHAPES.map((s) => s.weight ?? 1);
export const SHAPE_COUNT = SHAPES.length;

// One footprint spec -> plan-view points in px, around the base centre.
function plan(spec, o) {
  const [kind, fw, fd, n, rot = 0] = spec;
  if (kind === "rect") return rect(o.w * fw, o.d * fd);
  if (kind === "ngon") return ngon(o.w * fw, o.d * fd, n, rot);
  // Thrown rather than defaulted: a typo'd kind would otherwise silently draw
  // the wrong building, and the city would just look subtly off.
  throw new Error(`unknown footprint kind: ${kind}`);
}

// A data shape -> the geometry the renderer below consumes. Runs on a sprite
// cache MISS only (see sprites.js), so its cost never reaches a frame.
function compile(shape, o) {
  const sections = shape.sections.map((s) => {
    const pts = plan(s.plan, o);
    const base = s.offset ? at(pts, o.w * s.offset[0], o.d * s.offset[1]) : pts;
    const opts = {};
    if (s.topScale !== undefined) opts.topScale = s.topScale;
    if (s.topZ) opts.topZ = s.topZ.map((f) => o.height * f);
    if (s.smooth) opts.smooth = true;
    if (s.ribEvery) opts.ribEvery = s.ribEvery;
    return section(base, o.height * s.z[0], o.height * s.z[1], opts);
  });
  return {
    sections,
    beacons: shape.beacons?.map(([x, y, z]) => [o.w * x, o.d * y, o.height * z]),
  };
}

// ---------------------------------------------------------------------------
// Projection / visibility
// ---------------------------------------------------------------------------

// Screen position of footprint offset (fx, fy) at height z.
function project(cx, cy, fx, fy, z, skew) {
  return [cx + fx + z * skew, cy + fy - z];
}

// Unit eye direction in the ground plane (see the header): the side the roofs
// lean away from, plus "toward the bottom of the screen".
function eyeDir(skew) {
  const len = Math.hypot(skew, 1);
  return [-skew / len, 1 / len];
}

function centroid(pts) {
  let x = 0;
  let y = 0;
  for (const p of pts) {
    x += p[0];
    y += p[1];
  }
  return [x / pts.length, y / pts.length];
}

// Outward unit normal of the wall standing on edge i -> i+1. The normal of an
// edge is ambiguous up to sign, so it's resolved against the footprint centre
// rather than assuming a winding order — footprints above are written for
// legibility, not to a convention.
function outwardNormal(pts, i, cen) {
  const a = pts[i];
  const b = pts[(i + 1) % pts.length];
  let nx = b[1] - a[1];
  let ny = -(b[0] - a[0]);
  const len = Math.hypot(nx, ny) || 1;
  nx /= len;
  ny /= len;
  const mx = (a[0] + b[0]) / 2;
  const my = (a[1] + b[1]) / 2;
  if (nx * (cen[0] - mx) + ny * (cen[1] - my) > 0) return [-nx, -ny]; // points inward: flip
  return [nx, ny];
}

// Blends two "#rrggbb" colours. Face shading is baked into the sprite once, so
// the parse cost never reaches a frame.
function mixHex(a, b, t) {
  const pa = parseInt(a.slice(1), 16);
  const pb = parseInt(b.slice(1), 16);
  const ch = (sh) => {
    const va = (pa >> sh) & 255;
    const vb = (pb >> sh) & 255;
    return Math.round(va + (vb - va) * t);
  };
  return `rgb(${ch(16)},${ch(8)},${ch(0)})`;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

// Draws shape `shape` with its base centre at (cx, cy).
export function drawShape(ctx, cx, cy, shape, opts = {}) {
  const o = shapeOpts(opts);
  const geom = compile(SHAPES[shape], o);
  const eye = eyeDir(o.skew);

  // Painter's order, nearest last. Distance along the eye direction: a section
  // that is higher up, further toward the bottom of the screen, or further to
  // the camera's side is nearer the eye. Sections are convex and barely overlap,
  // so sorting them is all the depth resolution these shapes need.
  const ordered = geom.sections
    .map((s) => {
      const c = centroid(s.base);
      return { s, depth: c[0] * eye[0] + c[1] * eye[1] + (s.z0 + s.z1) / 2 };
    })
    .sort((a, b) => a.depth - b.depth);

  for (const { s } of ordered) drawSection(ctx, cx, cy, s, o, eye);
  for (const b of geom.beacons ?? []) {
    drawBeacon(ctx, project(cx, cy, b[0], b[1], b[2], o.skew), o.color);
  }
}

function shapeOpts(opts) {
  return {
    w: 70,
    d: 55,
    height: 60,
    color: BUILDING_EDGE,
    skew: 0.28,
    ...opts,
  };
}

function drawSection(ctx, cx, cy, s, o, eye) {
  const n = s.base.length;
  const cen = centroid(s.base);
  const bot = s.base.map((p) => project(cx, cy, p[0], p[1], s.z0, o.skew));
  const top = s.base.map((p, i) => {
    const tx = cen[0] + (p[0] - cen[0]) * s.topScale;
    const ty = cen[1] + (p[1] - cen[1]) * s.topScale;
    return project(cx, cy, tx, ty, s.topZ ? s.topZ[i] : s.z1, o.skew);
  });

  // Per-wall facing: > 0 means we can see it. The largest value is the wall most
  // square-on to the camera, which anchors the shading ramp.
  const facing = [];
  let maxFacing = 0;
  for (let i = 0; i < n; i++) {
    const nrm = outwardNormal(s.base, i, cen);
    const dot = nrm[0] * eye[0] + nrm[1] * eye[1];
    facing.push(dot);
    if (dot > maxFacing) maxFacing = dot;
  }
  const visible = facing.map((f) => f > 1e-6);
  const pointed = s.topScale < 0.01; // tapers to an apex: walls are triangles

  // OPAQUE fills first — the visible walls plus the roof tile the whole
  // silhouette of a convex solid exactly, so the hidden faces need no fill at
  // all. Each wall is shaded by how square-on it is, which is what turns a flat
  // silhouette into something that reads as lit and solid.
  for (let i = 0; i < n; i++) {
    if (!visible[i]) continue;
    const j = (i + 1) % n;
    fillPoly(
      ctx,
      [bot[i], bot[j], top[j], top[i]],
      mixHex(BUILDING_FILL_SIDE, BUILDING_FILL, facing[i] / maxFacing),
    );
  }
  if (!pointed) fillPoly(ctx, top, BUILDING_FILL_ROOF);

  // Footprint edges of the visible walls — for EVERY section, not just the ones
  // standing on the ground. A tier's base line lands on the roof of the tier
  // below it, and that line is what says the two are STACKED rather than fused
  // into one lump: without it a ziggurat's steps read as a single tapering mass,
  // and a pinwheel's turned tiers lose the very overhang they exist for. It was
  // originally skipped on the grounds that an upper tier's underside is inside
  // the solid, which is only true while every tier is strictly inset — the
  // moment one overhangs, its base is genuinely visible and was missing.
  for (let i = 0; i < n; i++) {
    if (!visible[i]) continue;
    const j = (i + 1) % n;
    glowLine(ctx, bot[i][0], bot[i][1], bot[j][0], bot[j][1], BUILDING_EDGE_DIM, 1, 5);
  }

  // Vertical (or, on a taper, sloping) edges. A sharp shape wants every edge
  // bounding a visible wall, creases included — they're what makes a corner
  // read. A smooth one wants only the two silhouette edges, since its facet
  // creases are an artefact of approximating a curve.
  for (let i = 0; i < n; i++) {
    const prev = (i - 1 + n) % n;
    const onVisibleWall = visible[i] || visible[prev];
    if (!onVisibleWall) continue;
    const silhouette = visible[i] !== visible[prev];
    if (s.smooth && !silhouette) continue;
    glowLine(ctx, bot[i][0], bot[i][1], top[i][0], top[i][1], o.color, 1.5, 8);
  }

  // Dim ribs down a curved wall, so a drum isn't a featureless slab.
  if (s.ribEvery > 0) {
    for (let i = 0; i < n; i += s.ribEvery) {
      if (!visible[i]) continue;
      glowLine(ctx, bot[i][0], bot[i][1], top[i][0], top[i][1], BUILDING_EDGE_DIM, 1, 4);
    }
  }

  // Roof outline (brightest — it's the top, furthest from the ground). An apex
  // has none: its wall edges already meet at the point.
  if (!pointed) glowPoly(ctx, top, o.color, 1.5, 10);
}

// A small glowing point — the aircraft-warning light on a spire or apex.
function drawBeacon(ctx, p, color) {
  ctx.save();
  ctx.fillStyle = color;
  ctx.shadowColor = color;
  ctx.shadowBlur = 12;
  ctx.beginPath();
  ctx.arc(p[0], p[1], 2, 0, TAU);
  ctx.fill();
  ctx.restore();
}

// Screen-space extent of a shape around its base centre, as positive distances
// (left/right/up/down). Derived from the same section list the renderer walks,
// so the sprite canvas is always big enough for what gets drawn.
export function shapeExtent(shape, opts = {}) {
  const o = shapeOpts(opts);
  const geom = compile(SHAPES[shape], o);
  let minX = 0;
  let maxX = 0;
  let minY = 0;
  let maxY = 0;
  const add = (p) => {
    minX = Math.min(minX, p[0]);
    maxX = Math.max(maxX, p[0]);
    minY = Math.min(minY, p[1]);
    maxY = Math.max(maxY, p[1]);
  };
  for (const s of geom.sections) {
    const cen = centroid(s.base);
    s.base.forEach((p, i) => {
      add(project(0, 0, p[0], p[1], s.z0, o.skew));
      add(project(
        0,
        0,
        cen[0] + (p[0] - cen[0]) * s.topScale,
        cen[1] + (p[1] - cen[1]) * s.topScale,
        s.topZ ? s.topZ[i] : s.z1,
        o.skew,
      ));
    });
  }
  for (const b of geom.beacons ?? []) {
    const p = project(0, 0, b[0], b[1], b[2], o.skew);
    add([p[0] - 3, p[1] - 3]);
    add([p[0] + 3, p[1] + 3]);
  }
  return { left: -minX, right: maxX, up: -minY, down: maxY };
}

// ---------------------------------------------------------------------------
// Shared wall bits.
// ---------------------------------------------------------------------------

// Fills a polygon with an opaque face colour (no stroke, no glow). Buildings are
// solid: this is what occludes the floor grid and whatever stands behind them.
function fillPoly(ctx, pts, color = BUILDING_FILL) {
  ctx.save();
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

