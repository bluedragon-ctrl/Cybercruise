// Extra building silhouettes — pyramids, ziggurats, drums, spires — so the city
// isn't wall-to-wall cubes, plus the small projection kit they're built from.
//
// THE PROJECTION
// --------------
// The same oblique camera drawBuilding() uses (see sprites.js): the footprint is
// drawn in plan view on the ground plane, and height maps to a screen offset of
// (z * skew, -z). A footprint offset (fx, fy) at height z therefore lands at
//   (cx + fx + z * skew, cy + fy - z)
//
// WHICH FACES YOU SEE
// -------------------
// Because height leans by `skew`, the eye sits along (-skew, +1, +1): below the
// city, and off to whichever side the roofs lean AWAY from. A face is visible
// exactly when its outward normal points that way. That one test generalises
// drawBuilding's hand-derived "roof leans right => you see the left wall" to any
// footprint, which is what makes hidden-line removal on a 16-sided drum or a
// hexagonal tower no harder than on a box — and hidden-line removal is the whole
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
// sprite cache sized for it. Adding a shape means adding a builder below and
// nothing else.
//
// COST: none per frame. These go through the same sprite cache as the box (see
// spritecache.js) — a shape is rendered once and blitted (~1.3us) thereafter, so
// what a shape costs to draw only affects the single frame it first appears on.

import { glowLine, glowPoly } from "../engine/neon.js";
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
function ngon(w, d, n, rot = 0) {
  const pts = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n + rot) * TAU;
    pts.push([Math.cos(a) * (w / 2), Math.sin(a) * (d / 2)]);
  }
  return pts;
}

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
// The catalogue. Each builder turns the shared dimensions (w, d, height) into
// sections, so every shape still answers to the same variant rolls as the box.
// ---------------------------------------------------------------------------

export const SHAPE_NAMES = [
  "PYRAMID",
  "ZIGGURAT",
  "TAPER",
  "DRUM",
  "SPIRE",
  "TWIN",
  "WEDGE",
  "HEX",
];

const BUILDERS = [
  // 0 — PYRAMID: one section tapering to a point, with a beacon at the apex.
  (o) => ({
    sections: [section(rect(o.w, o.d), 0, o.height, { topScale: 0 })],
    beacons: [[0, 0, o.height]],
  }),

  // 1 — ZIGGURAT: three setback tiers.
  (o) => ({
    sections: [
      section(rect(o.w, o.d), 0, o.height * 0.3),
      section(rect(o.w * 0.72, o.d * 0.72), o.height * 0.3, o.height * 0.68),
      section(rect(o.w * 0.44, o.d * 0.44), o.height * 0.68, o.height),
    ],
  }),

  // 2 — TAPER: a single wall sloping inward, the classic setback skyscraper.
  (o) => ({
    sections: [section(rect(o.w, o.d), 0, o.height, { topScale: 0.55 })],
  }),

  // 3 — DRUM: a round tower. 16 facets read as a curve once the per-facet
  // creases are suppressed; the ribs put some vertical detail back.
  (o) => ({
    sections: [
      section(ngon(o.w, o.d, 16), 0, o.height, { smooth: true, ribEvery: 3 }),
    ],
  }),

  // 4 — SPIRE: a slim tower carrying a tapered mast and a beacon.
  (o) => ({
    sections: [
      section(rect(o.w * 0.66, o.d * 0.66), 0, o.height * 0.78),
      section(rect(o.w * 0.16, o.d * 0.16), o.height * 0.78, o.height * 1.4, { topScale: 0.35 }),
    ],
    beacons: [[0, 0, o.height * 1.4]],
  }),

  // 5 — TWIN: two towers of unequal height joined by a sky bridge. The bridge is
  // just another section, so the depth sort puts it in front of both towers.
  (o) => ({
    sections: [
      section(at(rect(o.w * 0.36, o.d * 0.8), -o.w * 0.3, 0), 0, o.height),
      section(at(rect(o.w * 0.36, o.d * 0.8), o.w * 0.3, 0), 0, o.height * 0.74),
      section(rect(o.w * 0.62, o.d * 0.3), o.height * 0.46, o.height * 0.56),
    ],
  }),

  // 6 — WEDGE: a slanted roof, low at the front and full height at the back.
  // Per-vertex roof heights, in the footprint's own vertex order: rect() starts
  // at the front-left corner and runs front-left, front-right, back-right,
  // back-left.
  (o) => ({
    sections: [
      section(rect(o.w, o.d), 0, o.height, {
        topZ: [o.height * 0.5, o.height * 0.5, o.height, o.height],
      }),
    ],
  }),

  // 7 — HEX: a hexagonal prism. Three walls face the camera instead of two, so
  // the facing-based shading gives it a rounded, lit look.
  (o) => ({
    sections: [section(ngon(o.w, o.d * 1.1, 6), 0, o.height)],
  }),
];

export const SHAPE_COUNT = BUILDERS.length;

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
  const geom = BUILDERS[shape](o);
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

  // Footprint edges of the visible walls, but only for sections standing on the
  // ground — an upper tier's underside is inside the solid.
  if (s.z0 <= 0) {
    for (let i = 0; i < n; i++) {
      if (!visible[i]) continue;
      const j = (i + 1) % n;
      glowLine(ctx, bot[i][0], bot[i][1], bot[j][0], bot[j][1], BUILDING_EDGE_DIM, 1, 5);
    }
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
  const geom = BUILDERS[shape](o);
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
// Shared wall bits, used by the shapes here and by drawBuilding in sprites.js.
// ---------------------------------------------------------------------------

// Fills a polygon with an opaque face colour (no stroke, no glow). Buildings are
// solid: this is what occludes the floor grid and whatever stands behind them.
export function fillPoly(ctx, pts, color = BUILDING_FILL) {
  ctx.save();
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

