// One building variant as GPU GEOMETRY — the 3D floor's answer to sprites.js's
// cached bitmap, built from the same catalogue sections buildingshapes.js
// draws with.
//
// WHAT REPLACES THE SPRITE CACHE. A sprite is one fixed view of a solid, so it
// survives only while every building is seen from the same angle; under a real
// camera (citycamera.js) it is different pixels every frame and the cache is
// gone. What takes its place is a MESH cache with the same shape: 24 variants,
// built once, drawn INSTANCED — one draw call per variant with a position per
// building. The city stays infinite for the same reason it always did, and the
// per-frame cost stops scaling with how many buildings there are and starts
// scaling with how many VARIANTS there are, which is a constant.
//
// COORDINATES. Model space is floor-world relative to the base centre:
//   mx  right, exactly buildingshapes.js's footprint fx
//   my  AWAY from the player, which is MINUS its footprint fy — that fy is a
//       SCREEN-y offset (`cy + fy` in its project()), and screen y grows
//       downward while floor-world y grows away. Getting this wrong flips every
//       footprint front-to-back, which on the symmetric shapes is invisible and
//       on the WEDGE is a roof sloping the wrong way.
//   mz  height above the floor, unchanged
//
// HIDDEN SURFACES ARE THE DEPTH BUFFER'S JOB, not this file's. The 2D renderer
// has to decide per wall whether it is visible, sort the sections painter-style
// and fill only the front faces, because a 2D canvas has no z. The GPU has one,
// so every wall of every section is emitted unconditionally and back faces are
// culled by winding. That removes the whole class of "a tier overhangs and its
// underside was missing" bug drawSection's comments record.
//
// EDGES ARE NOT. A line has no thickness to depth-test with, and a wireframe
// over a solid is exactly the look the city is made of, so the visibility rules
// buildingshapes.js derived by hand survive — but as a PER-FRAME test in the
// vertex shader instead of a per-sprite one at build time. Each segment carries
// the outward normals of the (one or two) walls it bounds and a RULE saying how
// to combine their facings:
//
//   ALWAYS      a roof outline — the top is never hidden by its own solid
//   FRONT       draw if wall n0 faces the eye — a footprint edge, or a rib
//   EITHER      draw if either adjoining wall faces the eye — a sharp corner,
//               which is what makes a box read as a box
//   SILHOUETTE  draw only where the two disagree — the outline of a smooth
//               solid, whose facet creases are an artefact of approximating a
//               curve and must not be drawn (buildingshapes.js's `smooth`)
//
// A hidden segment is collapsed to a degenerate triangle rather than skipped,
// since a vertex shader cannot decline to run. That costs the vertex work and
// nothing else — no fragments, no bandwidth.

import { compileShape } from "./buildingshapes.js";
import { buildingVariantSpec } from "./sprites.js";
import { BUILDING_VARIANTS } from "./sprites.js";

// Edge visibility rules, matching the shader's own constants.
export const RULE_ALWAYS = 0;
export const RULE_FRONT = 1;
export const RULE_EITHER = 2;
export const RULE_SILHOUETTE = 3;

// Which of the two line palettes and widths a segment takes.
export const KIND_EDGE = 0; // BUILDING_EDGE, the bright structural lines
export const KIND_DIM = 1; // BUILDING_EDGE_DIM, footprint lines and ribs

// Which of the two fill palettes a triangle takes. Walls shade by facing; a
// roof is flat, so it gets its own colour and skips the ramp.
export const FACE_WALL = 0;
export const FACE_ROOF = 1;

function centroid(pts) {
  let x = 0;
  let y = 0;
  for (const p of pts) {
    x += p[0];
    y += p[1];
  }
  return [x / pts.length, y / pts.length];
}

// Outward unit normal of the wall standing on footprint edge i -> i+1, in MODEL
// space (so with the y flip already applied). Resolved against the footprint
// centre rather than a winding convention, exactly as buildingshapes.js does
// and for the same reason: the footprints in that catalogue are written for
// legibility, not to a winding.
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
  if (nx * (cen[0] - mx) + ny * (cen[1] - my) > 0) return [-nx, -ny];
  return [nx, ny];
}

// Build the triangle and line lists for one catalogue shape at one set of
// dimensions. Plain arrays of plain numbers — no GL here, so the geometry can
// be asserted under plain Node the way every other pure part of this codebase
// is (see test/city-mesh.test.js).
export function buildMesh(shape, opts) {
  const geom = compileShape(shape, opts);

  const triPos = [];
  const triNrm = [];
  const triFace = [];
  const linA = [];
  const linB = [];
  const linN0 = [];
  const linN1 = [];
  const linRule = [];
  const linKind = [];

  // The y flip (see the header) is applied ONCE, here, as the footprint is read
  // out of the catalogue. Everything downstream is already in model space.
  const flip = (p) => [p[0], -p[1]];

  const tri = (a, b, c, n, face) => {
    for (const p of [a, b, c]) {
      triPos.push(p[0], p[1], p[2]);
      triNrm.push(n[0], n[1], n[2]);
      triFace.push(face);
    }
  };
  const line = (a, b, n0, n1, rule, kind) => {
    linA.push(a[0], a[1], a[2]);
    linB.push(b[0], b[1], b[2]);
    linN0.push(n0[0], n0[1], n0[2]);
    linN1.push(n1[0], n1[1], n1[2]);
    linRule.push(rule);
    linKind.push(kind);
  };

  for (const s of geom.sections) {
    const base = s.base.map(flip);
    const n = base.length;
    const cen = centroid(base);
    const pointed = s.topScale < 0.01;

    const bot = base.map((p) => [p[0], p[1], s.z0]);
    const top = base.map((p, i) => [
      cen[0] + (p[0] - cen[0]) * s.topScale,
      cen[1] + (p[1] - cen[1]) * s.topScale,
      // topZ is per-vertex in the ORIGINAL footprint order, which flip()
      // preserves — it maps points, never reorders them.
      s.topZ ? s.topZ[i] : s.z1,
    ]);

    const normals = [];
    for (let i = 0; i < n; i++) normals.push([...outwardNormal(base, i, cen), 0]);

    // Walls. Wound so the outward normal is the front face: bot[i], bot[j],
    // top[j] read counter-clockwise seen from outside, which is what lets the
    // renderer cull back faces and never think about which walls are visible.
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      tri(bot[i], bot[j], top[j], normals[i], FACE_WALL);
      tri(bot[i], top[j], top[i], normals[i], FACE_WALL);
    }

    // Roof, as a fan. Every footprint in the catalogue is convex (rectangles
    // and regular n-gons), so a fan from vertex 0 is a valid triangulation and
    // no general polygon triangulator is needed. A concave footprint would be
    // the thing that changes that, and there is none.
    if (!pointed) {
      for (let i = 1; i < n - 1; i++) tri(top[0], top[i], top[i + 1], [0, 0, 1], FACE_ROOF);
    }

    // Footprint edges of each wall — for EVERY section, not just the ones on
    // the ground: a tier's base line lands on the roof below it and is what
    // says the two are stacked. buildingshapes.js's drawSection carries the
    // full argument for why.
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      line(bot[i], bot[j], normals[i], normals[i], RULE_FRONT, KIND_DIM);
    }

    // Vertical (or, on a taper, sloping) corner edges.
    for (let i = 0; i < n; i++) {
      const prev = (i - 1 + n) % n;
      line(
        bot[i],
        top[i],
        normals[i],
        normals[prev],
        s.smooth ? RULE_SILHOUETTE : RULE_EITHER,
        KIND_EDGE,
      );
    }

    // Dim ribs down a curved wall, so a drum is not a featureless slab.
    if (s.ribEvery > 0) {
      for (let i = 0; i < n; i += s.ribEvery) {
        line(bot[i], top[i], normals[i], normals[i], RULE_FRONT, KIND_DIM);
      }
    }

    // Roof outline. An apex has none — its wall edges already meet at a point.
    if (!pointed) {
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        line(top[i], top[j], normals[i], normals[i], RULE_ALWAYS, KIND_EDGE);
      }
    }
  }

  // Beacons — the aircraft-warning light on a spire or an apex. A filled disc
  // in 2D; here a small three-axis cross of bright segments, which is the same
  // few pixels once bloom has been over it and needs no second primitive type.
  for (const b of geom.beacons ?? []) {
    const p = [b[0], -b[1], b[2]];
    const r = 2.5;
    const axes = [[r, 0, 0], [0, r, 0], [0, 0, r]];
    for (const a of axes) {
      line(
        [p[0] - a[0], p[1] - a[1], p[2] - a[2]],
        [p[0] + a[0], p[1] + a[1], p[2] + a[2]],
        [0, 0, 1],
        [0, 0, 1],
        RULE_ALWAYS,
        KIND_EDGE,
      );
    }
  }

  return {
    triCount: triFace.length,
    triPos: new Float32Array(triPos),
    triNrm: new Float32Array(triNrm),
    triFace: new Float32Array(triFace),
    lineCount: linRule.length,
    linA: new Float32Array(linA),
    linB: new Float32Array(linB),
    linN0: new Float32Array(linN0),
    linN1: new Float32Array(linN1),
    linRule: new Float32Array(linRule),
    linKind: new Float32Array(linKind),
  };
}

// Every variant's mesh, in variant order — the 3D floor's whole geometry
// catalogue, built once. Not lazily per variant: the set is 24 entries and the
// build is milliseconds, so there is nothing to gain from a miss path and one
// less thing that can happen mid-frame.
export function buildVariantMeshes() {
  const meshes = [];
  for (let v = 0; v < BUILDING_VARIANTS; v++) {
    const { shape, opts } = buildingVariantSpec(v);
    meshes.push(buildMesh(shape, opts));
  }
  return meshes;
}
