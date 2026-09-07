// The city floor's CAMERA — a real pinhole in a real 3D world, and the one
// place the perspective is defined.
//
// WHY THIS EXISTS (Phase 16a, proof of concept). Everything on the floor plane
// is presently drawn by an OBLIQUE projection: buildingshapes.js maps a point
// at height z to a screen offset of (z * skew, -z), with `skew` flipped by hand
// per building (`leanRight`) to fake a shared vanishing point. That is cheap
// and it cached beautifully — a building is the same pixels wherever it stands,
// which is what let 192 sprites cover an infinite city — but it has three hard
// limits, and the camera pan (road.js's cameraX) has just made the first one
// visible:
//
//   1. The lean is BINARY. A building is on the left or on the right, so it
//      leans one of two ways and SWAPS as it crosses the middle. With a fixed
//      camera that almost never happened; with a panning one it happens
//      constantly, and it only stays unseen because the flip line sits under
//      the road (scenery.js's visibleBuildings says this at length).
//   2. There is no yaw. A rotation of the map is not expressible as a
//      per-sprite parameter at all, because a sprite IS one fixed view of one
//      solid.
//   3. Distance does nothing. Far buildings are the same size as near ones, so
//      the only depth cue the floor has is its parallax scroll rate.
//
// A real camera dissolves all three: lean, size and silhouette all become
// consequences of WHERE a building stands relative to the eye, computed per
// vertex. What it costs is the sprite cache — a solid seen from a moving eye is
// different pixels every frame — which is why the geometry moves to the GPU
// (engine/gl/city3d.js) rather than staying on the 2D canvas.
//
// THE PARAMETERISATION, and why it is not a matrix
// ------------------------------------------------
// Three knobs, and a fourth that is derived:
//
//   height   the eye's height above the floor, in floor units. This is the
//            PERSPECTIVE STRENGTH: a point at height z projects at a scale of
//            height / (height - z), so a large eye height flattens toward the
//            parallel projection this replaces, and a small one splays.
//   tilt     degrees down from the horizon. 90 looks straight down, and is
//            what ships — tuning.js's CITY_TILT says why.
//   yaw      degrees the eye is turned about the vertical. 0 looks up-screen.
//
//   focal    NOT a knob: height / sin(tilt), which is exactly the value that
//            makes the GROUND PLANE render at 1:1 at the anchor. Pinning it
//            there is what makes tilt = 90, yaw = 0 reproduce the existing
//            floor EXACTLY, so the mode can be switched on without moving
//            anything and only then tilted.
//
// THE ANCHOR is the ground point directly under the screen point (W/2,
// playerY) — floor-world (camX + W/2, fDist). It is the point both projections
// agree on, and it is the player's own position on the floor, so tilting the
// camera pivots the world about the car rather than about a screen corner.
//
// WHY NOT A mat4. The transform is written out (eye, three basis vectors,
// focal, anchor) and applied by hand in the shader, because that form is the
// one this file can be READ against: `screenX = W/2 + focal * xc / zc` is the
// pinhole, on the page, in the units scenery.js has always used. A 4x4 with an
// off-centre y shear folded into it says the same thing and can be checked by
// nobody. It costs a few dot products per vertex, which on a city of ~7000
// triangles is not a number anything can measure.
//
// DEGENERACY AT tilt = 90, yaw = 0, asserted in test/city-camera.test.js:
//   fwd = (0, 0, -1), right = (1, 0, 0), up = (0, 1, 0), focal = height,
//   eye = (anchorX, anchorY, height). For a ground point (wx, wy, 0):
//     xc = wx - anchorX,  yc = wy - anchorY,  zc = height
//     screenX = W/2 + (wx - anchorX)
//     screenY = playerY - (wy - anchorY)
//   which IS scenery.js's existing mapping (`sy = playerY - (lotY - fDist)`,
//   x untransformed). Every flat layer on this plane therefore keeps its exact
//   pixels at tilt 90 whether it goes through this camera or not.

import { CITY_TILT, CITY_YAW, CITY_EYE_HEIGHT } from "./tuning.js";

const DEG = Math.PI / 180;

// The LIVE camera parameters. tuning.js holds the shipped values; this object
// is what the PoC's `cybercruise.city3d({...})` handle writes, so a tilt can be
// dialled in from a driven browser without a code edit and a reload. Nothing in
// the game itself writes it.
const params = { tilt: CITY_TILT, yaw: CITY_YAW, height: CITY_EYE_HEIGHT };

export function cameraParams() {
  return { ...params };
}

// Set any subset; returns the full set, so a console caller sees what it got.
// The clamps are the ones the projection needs to stay finite: a tilt of 0 puts
// the horizon through the eye and divides by zero, and an eye below the tallest
// building would put geometry behind the camera plane.
export function setCameraParams(next = {}) {
  if (Number.isFinite(next.tilt)) params.tilt = Math.min(90, Math.max(5, next.tilt));
  if (Number.isFinite(next.yaw)) params.yaw = next.yaw;
  if (Number.isFinite(next.height)) params.height = Math.max(200, next.height);
  return cameraParams();
}

// The whole camera for one frame, as plain numbers — no GL and no canvas, so
// the test suite can assert the degeneracy above under plain Node.
//
//   fDist    the FLOOR's own distance clock (scenery.js's floorDist)
//   playerY  the player's screen row, which is where the anchor lands
//   camX     the floor's own pan (scenery.js's floorCameraX)
//
// `right`/`up`/`fwd` are the camera basis in floor-world space (x right, y away
// from the player, z up). `fwd` is the direction the eye LOOKS, so a point's
// depth is dot(point - eye, fwd) and is positive in front of it.
export function cityCamera(fDist, playerY, W, camX) {
  const t = params.tilt * DEG;
  const y = params.yaw * DEG;
  const sinT = Math.sin(t);
  const cosT = Math.cos(t);
  const sinY = Math.sin(y);
  const cosY = Math.cos(y);

  // Equal by construction, and both are wanted: see the header on `focal`, and
  // note that pinning the eye-to-anchor distance to the same number is what
  // puts the eye at exactly `height` above the floor.
  const focal = params.height / sinT;
  const dist = params.height / sinT;

  const fwd = [-cosT * sinY, cosT * cosY, -sinT];
  const right = [cosY, sinY, 0];
  // up = right x fwd (the header's tilt-90 check fixes the sign).
  const up = [
    right[1] * fwd[2] - right[2] * fwd[1],
    right[2] * fwd[0] - right[0] * fwd[2],
    right[0] * fwd[1] - right[1] * fwd[0],
  ];

  const anchorX = camX + W / 2;
  const anchorY = fDist;
  const eye = [
    anchorX - dist * fwd[0],
    anchorY - dist * fwd[1],
    -dist * fwd[2], // = height, since fwd[2] = -sin(tilt) and dist = h/sin(tilt)
  ];

  return { eye, right, up, fwd, focal, anchor: [W / 2, playerY] };
}

// Screen position of a point on the GROUND (z = 0) — the bridge for every flat
// layer that stays on the 2D canvas: traffic dots, node sprites, conduit ends,
// award marks. They are points and lines lying on the floor, so projecting
// their endpoints is the whole of what perspective does to them, and none of
// them needs to become GPU geometry to stay registered with the city.
export function projectGround(cam, wx, wy) {
  return projectPoint(cam, wx, wy, 0);
}

// The general case, for anything with a height.
//
// Returns null BEHIND THE EYE, which a tilted camera makes reachable for the
// first time: a floor row far enough away projects to the vanishing point and
// anything past it is behind the camera plane. Callers read null as "not on
// screen this frame" — under the parallel projection that case did not exist,
// so it is a new branch at every call site rather than a formality.
export function projectPoint(cam, wx, wy, wz) {
  const rx = wx - cam.eye[0];
  const ry = wy - cam.eye[1];
  const rz = wz - cam.eye[2];
  const zc = rx * cam.fwd[0] + ry * cam.fwd[1] + rz * cam.fwd[2];
  if (zc <= NEAR) return null;
  const xc = rx * cam.right[0] + ry * cam.right[1] + rz * cam.right[2];
  const yc = rx * cam.up[0] + ry * cam.up[1] + rz * cam.up[2];
  return [
    cam.anchor[0] + (cam.focal * xc) / zc,
    cam.anchor[1] - (cam.focal * yc) / zc,
  ];
}

// The inverse of projectGround: which point on the floor is under a given
// SCREEN point. The 3D floor needs it to know what to walk — under the parallel
// projection the visible city was a rectangle of the same size as the screen,
// and under perspective it is a trapezoid that widens with distance, so the
// walk's window has to be unprojected rather than assumed.
//
// Returns null when the ray does not meet the ground in front of the eye: the
// screen rows above the horizon, which a tilted camera puts on screen for the
// first time.
export function unprojectGround(cam, sx, sy) {
  const xc = sx - cam.anchor[0];
  const yc = -(sy - cam.anchor[1]);
  const d = [
    cam.right[0] * xc + cam.up[0] * yc + cam.fwd[0] * cam.focal,
    cam.right[1] * xc + cam.up[1] * yc + cam.fwd[1] * cam.focal,
    cam.right[2] * xc + cam.up[2] * yc + cam.fwd[2] * cam.focal,
  ];
  if (d[2] >= -1e-6) return null; // parallel to the floor or climbing away
  const t = -cam.eye[2] / d[2];
  if (t <= 0) return null;
  return [cam.eye[0] + t * d[0], cam.eye[1] + t * d[1]];
}

// The near plane, shared with the shader (engine/gl/city3d.js reads it). Well
// inside the eye height, so nothing on the floor ever crosses it; it exists to
// keep the perspective divide away from zero and to give the depth buffer a
// sane range.
export const NEAR = 16;

// HOW FAR THE FLOOR EXISTS, as a ground distance from the anchor — the far
// plane of the city, and the thing the parallel projection never needed
// because it stopped at the top of the screen by construction.
//
// A FIXED WORLD DISTANCE, not one derived from the camera, and that is the
// second thing this got wrong. Deriving it from where the ray through screen
// y = 0 meets the ground makes it a function of the tilt: at 90 it is barely
// past the screen edge, so a fade keyed to it eats the whole visible floor,
// and at a shallow tilt it runs to the horizon and the walk never ends. A
// fixed band says the same thing in one place — the city is drawn out to
// FADE_END and haze takes it from FADE_START — and reads the same at every
// tilt, which is what makes the tilt safe to dial from the console.
//
// The numbers: 1400 is comfortably past the far corner of an untilted screen
// (500 from the anchor) so nothing fades at tilt 90, and at the shipped 68 it
// puts the horizon band well up the screen with the fade doing the work a fog
// plane would. Raising it costs a wider building walk, quadratically.
export const GROUND_FADE_START = 850;
export const GROUND_FADE_END = 1400;

export function groundReach() {
  return GROUND_FADE_END;
}
