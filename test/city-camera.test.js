// The 3D floor's camera and geometry, asserted against the arithmetic its own
// headers claim — the same contract as the rest of test/ (see
// test/README-invariants.md): a comment cannot fail, so the derivation in it is
// held here.
//
// Nothing in this file touches a canvas or a GL context. Both modules under
// test are deliberately pure — game/citycamera.js is numbers, and
// game/buildingmesh.js is arrays of numbers — precisely so that the part of the
// 3D floor that can be wrong silently is the part that runs under plain Node.

import test from "node:test";
import assert from "node:assert/strict";

import {
  cityCamera, projectGround, projectPoint, unprojectGround, groundReach,
  cameraParams, setCameraParams, GROUND_FADE_END,
} from "../src/game/citycamera.js";
import { buildMesh, buildVariantMeshes, FACE_ROOF, RULE_SILHOUETTE } from "../src/game/buildingmesh.js";
import { SHAPE_NAMES } from "../src/game/buildingshapes.js";
import { ROAD_HALF_WIDTH } from "../src/game/road.js";
import { CAMERA_FOLLOW, ROAD_AMPLITUDE, CITY_TILT, CITY_YAW, CITY_EYE_HEIGHT } from "../src/game/tuning.js";
import { BUILDING_VARIANTS } from "../src/game/sprites.js";

// The camera parameters are module state (the console handle writes them), so
// every test that moves them puts them back.
function withCamera(next, body) {
  const before = cameraParams();
  try {
    setCameraParams(next);
    body();
  } finally {
    setCameraParams(before);
  }
}

const W = 600;
const H = 800;

test("at tilt 90 the camera reproduces the 2D floor's mapping exactly", () => {
  withCamera({ tilt: 90, yaw: 0, height: 900 }, () => {
    const fDist = 1234;
    const playerY = 600;
    const camX = -80;
    const cam = cityCamera(fDist, playerY, W, camX);

    // The claim in citycamera.js's header, in the terms scenery.js states its
    // own mapping in: screen x is world x with the pan taken off (main.js
    // translates the whole floor block by it), and screen y is
    // playerY - (worldY - fDist).
    for (const [wx, wy] of [[0, 1234], [512, 900], [-300, 2000], [camX + W, fDist - 200]]) {
      const p = projectGround(cam, wx, wy);
      assert.ok(p, `${wx},${wy} should be in front of a straight-down camera`);
      assert.ok(Math.abs(p[0] - (wx - camX)) < 1e-9, `screen x at ${wx}`);
      assert.ok(Math.abs(p[1] - (playerY - (wy - fDist))) < 1e-9, `screen y at ${wy}`);
    }
  });
});

test("the eye sits at exactly `height` above the floor, at every tilt", () => {
  for (const tilt of [90, 68, 50, 30, 12]) {
    withCamera({ tilt, yaw: 0, height: 900 }, () => {
      const cam = cityCamera(1000, 600, W, 0);
      assert.ok(Math.abs(cam.eye[2] - 900) < 1e-9, `tilt ${tilt}`);
    });
  }
});

test("the focal length is what pins the ground to 1:1 at the anchor", () => {
  // The header's reason for focal NOT being a knob: it is the value that makes
  // one floor unit at the anchor one screen pixel. Checked by projecting two
  // points a known distance apart ACROSS the view (the axis a tilt does not
  // foreshorten), at the anchor row.
  for (const tilt of [90, 68, 50, 30]) {
    withCamera({ tilt, yaw: 0, height: 900 }, () => {
      const fDist = 700;
      const cam = cityCamera(fDist, 600, W, 0);
      const a = projectGround(cam, 300, fDist);
      const b = projectGround(cam, 400, fDist);
      assert.ok(Math.abs(b[0] - a[0] - 100) < 1e-6, `tilt ${tilt}: ${b[0] - a[0]}`);
    });
  }
});

test("unprojectGround inverts projectGround", () => {
  for (const tilt of [90, 68, 50]) {
    for (const yaw of [0, 25, -40]) {
      withCamera({ tilt, yaw, height: 900 }, () => {
        const cam = cityCamera(1500, 600, W, 40);
        for (const [sx, sy] of [[0, H], [W, H], [W / 2, H / 2], [123, 456]]) {
          const g = unprojectGround(cam, sx, sy);
          if (!g) continue; // above the horizon at this tilt — nothing to invert
          const back = projectGround(cam, g[0], g[1]);
          assert.ok(back, "a point unprojected from the screen is on the screen");
          assert.ok(Math.abs(back[0] - sx) < 1e-6 && Math.abs(back[1] - sy) < 1e-6,
            `tilt ${tilt} yaw ${yaw} at ${sx},${sy} -> ${back}`);
        }
      });
    }
  }
});

test("height projects a point AWAY from the vanishing point, continuously", () => {
  // The whole reason the projection changed (citycamera.js's limit 1): under
  // the oblique projection a building leaned one of two ways by a hand-set
  // flag, and swapped as it crossed the middle. Here the lean is geometry — the
  // top of a solid moves away from the screen point the camera looks THROUGH,
  // by an amount that grows smoothly with how far off-centre it stands, and is
  // zero at the centre itself.
  withCamera({ tilt: 90, yaw: 0, height: 900 }, () => {
    const fDist = 1000;
    const cam = cityCamera(fDist, 600, W, 0);
    const anchorX = W / 2;
    let previous = 0;
    for (const offset of [0, 40, 120, 260]) {
      const base = projectGround(cam, anchorX + offset, fDist);
      const top = projectPoint(cam, anchorX + offset, fDist, 96);
      const lean = top[0] - base[0];
      assert.ok(lean >= previous, "lean grows with distance from the centre");
      if (offset === 0) assert.ok(Math.abs(lean) < 1e-9, "no lean at the centre");
      previous = lean;
    }
    // ...and it is a mirror on the other side, with no discontinuity between:
    // the same offset the other way leans the other way by the same amount.
    const l = projectPoint(cam, anchorX - 260, fDist, 96)[0] - projectGround(cam, anchorX - 260, fDist)[0];
    assert.ok(Math.abs(l + previous) < 1e-6, "symmetric about the centre");
  });
});

test("the drawn extent of the floor is a fixed world distance, not a function of the tilt", () => {
  // citycamera.js's GROUND_FADE_* comment: deriving this from the camera made
  // it eat the whole visible floor at a steep tilt and run to the horizon at a
  // shallow one, so it is deliberately constant.
  for (const tilt of [90, 68, 50, 20]) {
    withCamera({ tilt, yaw: 0, height: 900 }, () => {
      assert.equal(groundReach(), GROUND_FADE_END);
    });
  }
  // And it clears the far corner of an untilted screen, or the fade would be
  // visible on a camera that is meant to look exactly like the 2D floor.
  assert.ok(GROUND_FADE_END > Math.hypot(W / 2, H / 2));
});

test("the road covers the vanishing point, so no visible building is drawn lean-free", () => {
  // THE CLAIM tuning.js's CITY_TILT makes, and the reason 90 is shippable at
  // all. A top-down camera has one degenerate point: the ground point directly
  // under the eye, where a solid projects to its roof alone with no wall and no
  // lean. That point is the anchor, which is screen (W/2, playerY) — and
  // road.js's centre-line is at W/2 minus the camera's own pan, so at
  // CAMERA_FOLLOW = 1 they are the same column and at anything less they part
  // by at most (1 - CAMERA_FOLLOW) * ROAD_AMPLITUDE.
  //
  // Four numbers across four files, exactly like city-floor.test.js's lean-flip
  // invariant, and nothing in citycamera.js would notice any of them moving.
  const drift = (1 - CAMERA_FOLLOW) * ROAD_AMPLITUDE;
  assert.ok(drift <= ROAD_HALF_WIDTH,
    `the vanishing point drifts ${drift}px off the road's centre against a half-width of ${ROAD_HALF_WIDTH}`);

  // And the degenerate REGION, not just the point: how far off-centre a
  // building has to stand before its roof is thrown clear of its own footprint
  // by a visible amount. Under the eye height that ships, that distance has to
  // land under the tarmac too, or there is a band of flat-topped buildings
  // beside the road.
  const { height } = cameraParams();
  const tallest = 96 * 1.4; // the SPIRE's mast, buildingshapes.js's tallest z
  const splayPerPx = height / (height - tallest) - 1;
  const readable = 3; // px of lean below which nothing reads as a lean at all
  assert.ok(readable / splayPerPx + drift <= ROAD_HALF_WIDTH,
    `buildings within ${(readable / splayPerPx).toFixed(0)}px of the vanishing point have no readable lean`);
});

test("at the shipped tilt the ground is the 2D floor's own window, not a wider one", () => {
  // The cost argument in the README: at tilt 90 the visible ground is exactly
  // the screen rectangle, so the 3D walk covers what visibleBuildings covered
  // and the instance count does not grow. Tilt it and this stops holding —
  // which is the thing to re-measure before shipping any other tilt.
  withCamera({ tilt: CITY_TILT, yaw: CITY_YAW, height: CITY_EYE_HEIGHT }, () => {
    const fDist = 2100;
    const cam = cityCamera(fDist, 600, W, 0);
    const corners = [[0, 0], [W, 0], [0, H], [W, H]].map(([x, y]) => unprojectGround(cam, x, y));
    for (const c of corners) assert.ok(c, "every screen corner still lands on the ground");
    const xs = corners.map((c) => c[0]);
    const ys = corners.map((c) => c[1]);
    assert.ok(Math.abs(Math.min(...xs) - 0) < 1e-6 && Math.abs(Math.max(...xs) - W) < 1e-6,
      `x window ${Math.min(...xs)}..${Math.max(...xs)}`);
    assert.ok(Math.abs(Math.max(...ys) - (fDist + 600)) < 1e-6, "the far edge is the top of the screen");
    assert.ok(Math.abs(Math.min(...ys) - (fDist - 200)) < 1e-6, "the near edge is the bottom of the screen");
  });
});

test("the mesh puts a WEDGE's low roof toward the player, not away from it", () => {
  // buildingmesh.js's y flip, which is invisible on every symmetric shape in
  // the catalogue and wrong-way-round on exactly this one. rect() winds
  // front-left, front-right, back-right, back-left where "front" is the larger
  // SCREEN y — which is the SMALLER world y, since world y grows away.
  const wedge = SHAPE_NAMES.indexOf("WEDGE");
  assert.ok(wedge >= 0, "the catalogue still has a WEDGE");
  const mesh = buildMesh(wedge, { w: 40, d: 40, height: 100 });

  let lowY = null;
  let highY = null;
  for (let i = 0; i < mesh.triCount; i++) {
    if (mesh.triFace[i] !== FACE_ROOF) continue;
    const y = mesh.triPos[i * 3 + 1];
    const z = mesh.triPos[i * 3 + 2];
    if (z < 75) lowY = lowY === null ? y : Math.max(lowY, y);
    else highY = highY === null ? y : Math.min(highY, y);
  }
  assert.ok(lowY !== null && highY !== null, "the wedge roof has a low half and a high half");
  assert.ok(lowY < highY, `the low half is nearer the player: low y ${lowY}, high y ${highY}`);
});

test("every variant builds a closed, non-empty mesh", () => {
  const meshes = buildVariantMeshes();
  assert.equal(meshes.length, BUILDING_VARIANTS);
  for (let v = 0; v < meshes.length; v++) {
    const m = meshes[v];
    assert.ok(m.triCount > 0 && m.triCount % 3 === 0, `variant ${v} triangles`);
    assert.ok(m.lineCount > 0, `variant ${v} has a wireframe`);
    assert.equal(m.triPos.length, m.triCount * 3);
    assert.equal(m.triNrm.length, m.triCount * 3);
    assert.equal(m.linA.length, m.lineCount * 3);
    for (const value of m.triPos) assert.ok(Number.isFinite(value), `variant ${v} has a finite mesh`);
    for (const value of m.linA) assert.ok(Number.isFinite(value), `variant ${v} has finite edges`);
  }
});

test("wall normals are horizontal unit vectors, or the facing test is meaningless", () => {
  // Every edge rule in the shader is a sign test on dot(normal, view). A
  // normal that is not unit length still gives the right sign, but one with a z
  // component does not: it would make an edge's visibility depend on how high
  // up the wall the camera happens to be.
  for (const mesh of buildVariantMeshes()) {
    for (let i = 0; i < mesh.lineCount; i++) {
      for (const n of [mesh.linN0, mesh.linN1]) {
        const x = n[i * 3];
        const y = n[i * 3 + 1];
        const z = n[i * 3 + 2];
        // The beacon cross is the one exception: it carries a placeholder
        // normal because its rule is ALWAYS and no facing is ever consulted.
        if (z === 1 && x === 0 && y === 0) continue;
        assert.ok(Math.abs(z) < 1e-9, "a wall normal is horizontal");
        // 1e-5, not something tighter: these are Float32Array, so a normalised
        // vector round-trips to about 1e-8 and a 16-facet drum reaches it.
        assert.ok(Math.abs(Math.hypot(x, y) - 1) < 1e-5, "a wall normal is unit length");
      }
    }
  }
});

test("only the smooth shapes ask for silhouette-only edges", () => {
  // buildingmesh.js's rule table: a curved wall's facet creases are an artefact
  // of approximating a curve and must not be drawn, which is what separates the
  // DRUM from every sharp solid. If this ever fires for a box, the box has
  // stopped reading as a box.
  const smooth = new Set(["DRUM"]);
  for (let s = 0; s < SHAPE_NAMES.length; s++) {
    const mesh = buildMesh(s, { w: 40, d: 40, height: 80 });
    let silhouettes = 0;
    for (let i = 0; i < mesh.lineCount; i++) if (mesh.linRule[i] === RULE_SILHOUETTE) silhouettes++;
    if (smooth.has(SHAPE_NAMES[s])) assert.ok(silhouettes > 0, `${SHAPE_NAMES[s]} is smooth`);
    else assert.equal(silhouettes, 0, `${SHAPE_NAMES[s]} is a sharp solid`);
  }
});
