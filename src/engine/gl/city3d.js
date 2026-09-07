// The city floor, drawn as actual 3D geometry on the GPU — Phase 16a, a PROOF
// OF CONCEPT and labelled as one. game/citycamera.js says why the projection
// changed; this file is how it gets drawn.
//
// WHERE IT SITS IN THE FRAME, and why it is a second WebGL2 context
// -----------------------------------------------------------------
// It owns its own canvas and its own context, renders the floor into it with a
// transparent background, and game/scenery.js drawImage()s that canvas into the
// 2D frame at exactly the point drawFloorGrid/drawFloorBuildings used to draw.
// So the layer order, the road painting over the middle, the whole downstream
// bloom pass in engine/present.js — none of it learns that anything changed.
//
// THAT COSTS ONE FULL-FRAME COPY, and it is the thing this PoC is deliberately
// paying so that everything else stays still. The copy is not necessary: the
// end state is this geometry drawn into present.js's OWN context, ahead of the
// frame texture, with the 2D canvas made alpha so it composites over the city.
// That is a change to the frame pipeline every glitch and bloom pass hangs off,
// which is not what you want tangled up with "does perspective look right".
// Measure the copy separately (it is one drawImage) and subtract it from any
// figure taken here before comparing against the sprite path.
//
// A SECOND CONTEXT IS NOT FREE EITHER — a browser has a per-page limit on live
// WebGL contexts, and going over it kills the OLDEST, which here would be
// present.js's and would take the whole frame down. Two is nowhere near any
// browser's limit (typically 8-16). It is still a reason the end state is one
// context and not two.
//
// WHY A DEPTH BUFFER RATHER THAN A SORT. The 2D path sorts sections
// painter-style within a building and walks lot rows far-to-near between them,
// which works because a lot row is a fixed depth band. Under a yawed camera
// that stops being true — rows are no longer parallel to the screen — so the
// sort has to go. A depth buffer replaces the whole of it and is the thing
// that makes yaw possible at all. It also removes the class of bug the 2D
// renderer's hidden-face reasoning keeps rediscovering (an overhanging tier
// whose underside was culled as "inside the solid").
//
// BACK FACES ARE NOT CULLED, deliberately. A closed solid over a depth buffer
// is correct either way, culling only saves fragments on a triangle count
// (~7000 for the whole city) that is not the bottleneck, and getting the
// winding convention backwards against a projection this file builds BY HAND
// fails as an entirely invisible city. The cost is measured overdraw of about
// 2x on the cheapest pass in the frame.
//
// EDGE VISIBILITY IS PER-FRAME, in the vertex shader. game/buildingmesh.js's
// header gives the four rules and why a line cannot simply be depth-tested.
//
// LINES ARE QUADS, not gl.LINES. WebGL's lineWidth is capped at 1 on every
// desktop driver that matters, and the city's look is 1.5px structural edges
// over 1px detail — a uniform 1px wireframe is a different city. Each segment
// is expanded to a screen-space quad in the vertex shader, which also gets the
// width in SCREEN pixels for free, so a near building's edges do not fatten as
// it approaches.

import { createContext, buildProgram } from "./context.js";
import { renderScale } from "../viewport.js";

// The shared pinhole, written out rather than folded into a 4x4 — see
// game/citycamera.js's header for why, and for what each uniform means.
const PROJECT = `
uniform vec3 uEye;
uniform vec3 uRight;
uniform vec3 uUp;
uniform vec3 uFwd;
uniform float uFocal;
uniform vec2 uAnchor;
uniform vec2 uViewport;
uniform vec2 uDepthRange;
uniform vec2 uFade;

vec3 toCam(vec3 p) {
  vec3 r = p - uEye;
  return vec3(dot(r, uRight), dot(r, uUp), dot(r, uFwd));
}

vec2 toScreen(vec3 c) {
  return uAnchor + vec2(uFocal * c.x / c.z, -uFocal * c.y / c.z);
}

// The city's far haze, as a GROUND distance from the anchor (which is
// uEye + uFocal * uFwd — see game/citycamera.js). Horizontal, not a distance
// from the eye: at a steep tilt the eye is hundreds of units UP, so a 3D
// distance would fade the floor directly beneath the player as hard as the
// floor at the horizon, which is how this was first written and why the ground
// came out blank.
float groundFade(vec3 world) {
  vec2 anchor = (uEye + uFwd * uFocal).xy;
  return 1.0 - smoothstep(uFade.x, uFade.y, length(world.xy - anchor));
}

// Screen px -> clip. The w component is the camera depth, so the hardware does
// the perspective divide and the perspective-correct interpolation; the z is
// the usual near/far mapping, taken from a SEPARATE depth so a caller can pull
// a primitive slightly toward the eye (see uLineBias).
vec4 clipOf(vec2 scr, float zc, float zDepth) {
  vec2 ndc = vec2(scr.x / uViewport.x * 2.0 - 1.0, 1.0 - scr.y / uViewport.y * 2.0);
  float n = uDepthRange.x;
  float f = uDepthRange.y;
  float zn = ((f + n) / (f - n)) * zDepth - 2.0 * f * n / (f - n);
  return vec4(ndc * zc, zn, zc);
}
`;

// A building's solid: every wall of every section, plus the roofs.
const FILL_VS = `#version 300 es
precision highp float;
${PROJECT}
in vec3 aPos;
in vec3 aNrm;
in float aFace;
in vec3 aInst;
out vec3 vNrm;
out float vFace;
out vec3 vWorld;
out float vEnter;
void main() {
  vec3 w = vec3(aPos.x + aInst.x, aPos.y + aInst.y, aPos.z);
  vec3 c = toCam(w);
  gl_Position = clipOf(toScreen(c), c.z, c.z);
  vNrm = aNrm;
  vFace = aFace;
  vWorld = w;
  vEnter = aInst.z;
}
`;

const FILL_FS = `#version 300 es
precision highp float;
${PROJECT}
uniform vec3 uFill;
uniform vec3 uFillSide;
uniform vec3 uFillRoof;
in vec3 vNrm;
in float vFace;
in vec3 vWorld;
in float vEnter;
out vec4 outColor;
void main() {
  vec3 col;
  if (vFace > 0.5) {
    col = uFillRoof;
  } else {
    // How square-on this wall is to the eye, which is what turns a flat
    // silhouette into something that reads as lit. The 2D path normalises this
    // against the most-facing wall of the same section; here it is the raw
    // cosine, which is the same ramp without needing a per-section maximum the
    // GPU has no cheap way to know.
    vec3 v = normalize(vWorld - uEye);
    float facing = clamp(abs(dot(normalize(vNrm), -v)), 0.0, 1.0);
    col = mix(uFillSide, uFill, facing);
  }
  // Two alphas, and both are the same idea — something that is not fully here
  // yet does not draw at full strength. groundFade is the far haze; vEnter is
  // scenery.js's materialisation, which in the 2D path was a scanline clip and
  // here is a plain fade (see visibleBuildings3D for why the scanline went).
  float a = groundFade(vWorld) * vEnter;
  outColor = vec4(col * a, a);
}
`;

// A building's wireframe. One segment -> six vertices -> two triangles.
const LINE_VS = `#version 300 es
precision highp float;
${PROJECT}
uniform vec2 uWidths;     // half-width in screen px: [bright, dim]
uniform float uLineBias;  // depth pulled toward the eye, to beat the fills
in vec3 aA;
in vec3 aB;
in vec3 aN0;
in vec3 aN1;
in float aRule;
in float aKind;
in float aSide;
in float aEnd;
in vec3 aInst;
out float vKind;
out float vSide;
out float vEnter;
out vec3 vWorld;
void main() {
  vec3 off = vec3(aInst.x, aInst.y, 0.0);
  vec3 wa = aA + off;
  vec3 wb = aB + off;

  // Which walls this segment bounds face the eye. Evaluated at the segment's
  // MIDPOINT: the two ends of one edge can disagree under a strong
  // perspective, and a per-vertex answer would tear the quad in half.
  vec3 v = normalize((wa + wb) * 0.5 - uEye);
  bool front0 = dot(aN0, -v) > 0.0;
  bool front1 = dot(aN1, -v) > 0.0;
  bool draw;
  if (aRule < 0.5) draw = true;                    // ALWAYS
  else if (aRule < 1.5) draw = front0;             // FRONT
  else if (aRule < 2.5) draw = front0 || front1;   // EITHER
  else draw = front0 != front1;                    // SILHOUETTE

  vec3 ca = toCam(wa);
  vec3 cb = toCam(wb);
  if (!draw || ca.z <= uDepthRange.x || cb.z <= uDepthRange.x) {
    // A vertex shader cannot decline to run, so a hidden segment collapses to
    // a point outside the clip volume. No fragments, no bandwidth.
    gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
    vWorld = wa;
    return;
  }

  vec2 sa = toScreen(ca);
  vec2 sb = toScreen(cb);
  vec2 d = sb - sa;
  float len = length(d);
  vec2 dir = len > 1e-5 ? d / len : vec2(1.0, 0.0);
  vec2 nrm = vec2(-dir.y, dir.x);
  float hw = (aKind < 0.5 ? uWidths.x : uWidths.y) + 0.5; // +0.5 for the AA ramp
  bool atA = aEnd < 0.5;
  vec2 scr = (atA ? sa : sb) + nrm * aSide * hw;
  float zc = atA ? ca.z : cb.z;

  gl_Position = clipOf(scr, zc, zc * uLineBias);
  vKind = aKind;
  vSide = aSide * hw;
  vEnter = aInst.z;
  vWorld = atA ? wa : wb;
}
`;

const LINE_FS = `#version 300 es
precision highp float;
${PROJECT}
uniform vec3 uEdge;
uniform vec3 uEdgeDim;
uniform vec2 uWidths;
in float vKind;
in float vSide;
in float vEnter;
in vec3 vWorld;
out vec4 outColor;
void main() {
  float hw = vKind < 0.5 ? uWidths.x : uWidths.y;
  // One pixel of falloff at the edge of the quad. Without it a 1px line at an
  // angle stairsteps, and bloom then smears the stairsteps rather than the line.
  float a = clamp(hw + 0.5 - abs(vSide), 0.0, 1.0) * groundFade(vWorld) * vEnter;
  vec3 col = vKind < 0.5 ? uEdge : uEdgeDim;
  outColor = vec4(col * a, a); // premultiplied, matching the canvas
}
`;

// The ground: ONE quad, textured with the same floor tile the 2D path blits.
//
// WHY A TEXTURE AND NOT GEOMETRY. Everything drawn on the floor — the fine
// grid, the street ribbons, their dashed centre lines, the registration ticks —
// is already baked into one canvas by scenery.js, built once and periodic in
// AVENUE_PERIOD x ARTERIAL_PERIOD. Sampling that with GL_REPEAT gets the exact
// pixels the 2D floor has always had, foreshortened correctly, for one quad and
// no second copy of any of that geometry. Re-deriving it as GL lines would be
// hundreds of lines of new code whose only job is to look identical.
//
// It also makes the ground INFINITE for the first time: the 2D blit covers one
// screen width, where this repeats to wherever the far plane is put.
const GROUND_VS = `#version 300 es
precision highp float;
${PROJECT}
in vec2 aGround;
out vec2 vUV;
out vec3 vWorld;
uniform vec2 uTilePeriod;
void main() {
  vec3 w = vec3(aGround, 0.0);
  vec3 c = toCam(w);
  gl_Position = clipOf(toScreen(c), c.z, c.z);
  // Floor-world y grows AWAY from the player while the tile was authored with
  // screen y growing down, so v runs backwards. Same flip buildingmesh.js
  // applies to a footprint, for the same reason.
  vUV = vec2(aGround.x / uTilePeriod.x, -aGround.y / uTilePeriod.y);
  vWorld = w;
}
`;

const GROUND_FS = `#version 300 es
precision highp float;
${PROJECT}
uniform sampler2D uTile;
in vec2 vUV;
in vec3 vWorld;
out vec4 outColor;
void main() {
  // The far edge of the ground would be a hard line otherwise — the 2D floor
  // never had one because it stopped at the top of the screen.
  outColor = texture(uTile, vUV) * groundFade(vWorld);
}
`;

// --- State ----------------------------------------------------------------
//
// Module-level and rebuilt from scratch by build(), for exactly the reason
// gl/context.js's header gives: every GL object dies with the context, so
// "restore" means "make it all again" and cannot mean "carry on".

let canvas = null;
let gl = null;
let ok = false;

let fillProgram = null;
let lineProgram = null;
let groundProgram = null;
let fillU = null;
let lineU = null;
let groundU = null;

let vaos = []; // one { fill, line, triCount, lineCount } per variant
let instBuffer = null;
let instData = null;
let groundVao = null;
let groundBuffer = null;

let tileTexture = null;
let tileKey = "";

// Meshes are handed in rather than imported, so this module stays engine-side
// and knows nothing about what a "building variant" is.
let meshes = null;

// How far toward the eye a wireframe segment is pushed so it wins against the
// solid it lies on. Small enough that a far building's edges cannot punch
// through a nearer one: at the shipped eye height the shift is under a pixel of
// world depth, against a lot pitch of 64.
const LINE_BIAS = 0.998;

const NEAR = 16;
const FAR = 12000;

function uniforms(program, names) {
  const u = {};
  for (const n of names) u[n] = gl.getUniformLocation(program, n);
  return u;
}

function attrib(program, name) {
  return gl.getAttribLocation(program, name);
}

// One segment -> six vertices. The per-segment attributes are duplicated across
// all six; aSide/aEnd are what distinguishes them. Non-indexed on purpose — an
// index buffer would save a third of a few hundred kilobytes, built once.
function expandLines(mesh) {
  const n = mesh.lineCount;
  const A = new Float32Array(n * 6 * 3);
  const B = new Float32Array(n * 6 * 3);
  const N0 = new Float32Array(n * 6 * 3);
  const N1 = new Float32Array(n * 6 * 3);
  const RULE = new Float32Array(n * 6);
  const KIND = new Float32Array(n * 6);
  const SIDE = new Float32Array(n * 6);
  const END = new Float32Array(n * 6);
  // (side, end) for the two triangles of the quad.
  const corners = [[-1, 0], [1, 0], [1, 1], [-1, 0], [1, 1], [-1, 1]];
  for (let i = 0; i < n; i++) {
    for (let k = 0; k < 6; k++) {
      const o3 = (i * 6 + k) * 3;
      const o1 = i * 6 + k;
      for (let c = 0; c < 3; c++) {
        A[o3 + c] = mesh.linA[i * 3 + c];
        B[o3 + c] = mesh.linB[i * 3 + c];
        N0[o3 + c] = mesh.linN0[i * 3 + c];
        N1[o3 + c] = mesh.linN1[i * 3 + c];
      }
      RULE[o1] = mesh.linRule[i];
      KIND[o1] = mesh.linKind[i];
      SIDE[o1] = corners[k][0];
      END[o1] = corners[k][1];
    }
  }
  return { A, B, N0, N1, RULE, KIND, SIDE, END, verts: n * 6 };
}

function staticBuffer(data) {
  const b = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, b);
  gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
  return b;
}

function bindFloat(loc, buffer, size, divisor = 0, stride = 0, offset = 0) {
  if (loc < 0) return;
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, size, gl.FLOAT, false, stride, offset);
  gl.vertexAttribDivisor(loc, divisor);
}

// Build (or rebuild) every GL object. Safe to run any number of times.
function build() {
  fillProgram = buildProgram(gl, FILL_VS, FILL_FS);
  lineProgram = buildProgram(gl, LINE_VS, LINE_FS);
  groundProgram = buildProgram(gl, GROUND_VS, GROUND_FS);
  if (!fillProgram || !lineProgram || !groundProgram) return false;

  const camera = ["uEye", "uRight", "uUp", "uFwd", "uFocal", "uAnchor", "uViewport", "uDepthRange", "uFade"];
  fillU = uniforms(fillProgram, [...camera, "uFill", "uFillSide", "uFillRoof"]);
  lineU = uniforms(lineProgram, [...camera, "uEdge", "uEdgeDim", "uWidths", "uLineBias"]);
  groundU = uniforms(groundProgram, [...camera, "uTile", "uTilePeriod"]);

  // One instance buffer for the whole frame, sliced per variant by the attribute
  // pointer's byte offset — so the whole city is ONE upload and 48 draw calls,
  // rather than 24 uploads.
  instBuffer = gl.createBuffer();
  instData = new Float32Array(MAX_INSTANCES * 3);

  vaos = meshes.map((mesh) => {
    const lines = expandLines(mesh);

    const fill = gl.createVertexArray();
    gl.bindVertexArray(fill);
    bindFloat(attrib(fillProgram, "aPos"), staticBuffer(mesh.triPos), 3);
    bindFloat(attrib(fillProgram, "aNrm"), staticBuffer(mesh.triNrm), 3);
    bindFloat(attrib(fillProgram, "aFace"), staticBuffer(mesh.triFace), 1);

    const line = gl.createVertexArray();
    gl.bindVertexArray(line);
    bindFloat(attrib(lineProgram, "aA"), staticBuffer(lines.A), 3);
    bindFloat(attrib(lineProgram, "aB"), staticBuffer(lines.B), 3);
    bindFloat(attrib(lineProgram, "aN0"), staticBuffer(lines.N0), 3);
    bindFloat(attrib(lineProgram, "aN1"), staticBuffer(lines.N1), 3);
    bindFloat(attrib(lineProgram, "aRule"), staticBuffer(lines.RULE), 1);
    bindFloat(attrib(lineProgram, "aKind"), staticBuffer(lines.KIND), 1);
    bindFloat(attrib(lineProgram, "aSide"), staticBuffer(lines.SIDE), 1);
    bindFloat(attrib(lineProgram, "aEnd"), staticBuffer(lines.END), 1);

    return {
      fill,
      line,
      triVerts: mesh.triCount,
      lineVerts: lines.verts,
      fillInstLoc: attrib(fillProgram, "aInst"),
      lineInstLoc: attrib(lineProgram, "aInst"),
    };
  });

  groundBuffer = gl.createBuffer();
  groundVao = gl.createVertexArray();
  gl.bindVertexArray(groundVao);
  gl.bindBuffer(gl.ARRAY_BUFFER, groundBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, 12 * 2 * 4, gl.DYNAMIC_DRAW);
  const gLoc = attrib(groundProgram, "aGround");
  gl.enableVertexAttribArray(gLoc);
  gl.vertexAttribPointer(gLoc, 2, gl.FLOAT, false, 0, 0);

  gl.bindVertexArray(null);
  tileTexture = null;
  tileKey = "";
  return true;
}

// The upper bound on buildings drawn in one frame. ~70 are visible on an
// average frame under the parallel projection (scenery.js measures it); a
// tilted camera sees further, so this carries a lot of headroom and the walk is
// clamped to it rather than the buffer being grown mid-frame.
const MAX_INSTANCES = 4096;

// --- Public API -----------------------------------------------------------

// Bring the renderer up. `variantMeshes` is game/buildingmesh.js's catalogue.
// Returns false if this machine has no second WebGL2 context to give, which the
// caller reads as "stay on the sprite path" — unlike present.js, a floor that
// cannot go 3D has a complete renderer to fall back to.
export function init(variantMeshes) {
  if (canvas) return ok;
  meshes = variantMeshes;
  canvas = document.createElement("canvas");
  gl = createContext(canvas, {
    // The two attributes that differ from the present canvas: this pass sorts
    // geometry with a depth buffer, and its result is composited over the 2D
    // frame rather than being the frame.
    attrs: { depth: true, alpha: true },
    onLost: () => {
      ok = false;
    },
    onRestored: () => {
      ok = build();
    },
  });
  if (!gl) return false;
  ok = build();
  return ok;
}

export function isLive() {
  return ok;
}

export function canvasEl() {
  return canvas;
}

function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

let fadeStart = 0;
let fadeEnd = 1;

function setCamera(u, cam, W, H) {
  gl.uniform3fv(u.uEye, cam.eye);
  gl.uniform3fv(u.uRight, cam.right);
  gl.uniform3fv(u.uUp, cam.up);
  gl.uniform3fv(u.uFwd, cam.fwd);
  gl.uniform1f(u.uFocal, cam.focal);
  gl.uniform2fv(u.uAnchor, cam.anchor);
  gl.uniform2f(u.uViewport, W, H);
  gl.uniform2f(u.uDepthRange, NEAR, FAR);
  gl.uniform2f(u.uFade, fadeStart, fadeEnd);
}

// Upload the floor tile as a repeating texture. Keyed on the same things the
// 2D tile cache is keyed on — its identity plus the raster scale — because the
// canvas it comes from is rebuilt on a sector change and re-rasterised on a
// resize, and an upload skipped on a stale key is a whole sector drawn in the
// last one's colours.
function syncTile(tileCanvas, key) {
  if (tileTexture && tileKey === key) return;
  if (tileTexture) gl.deleteTexture(tileTexture);
  tileTexture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tileTexture);
  // TRUE, matching the premultiplied blend this pass uses throughout. A canvas
  // source is already premultiplied internally, so false would ask the browser
  // to UNdo that on upload and the ground would composite over the frame at the
  // wrong weight — brighter where a line is soft, which on a grid of 1px lines
  // is every pixel that matters.
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, tileCanvas);
  // MIPS ARE NOT OPTIONAL HERE. A ground plane running to a horizon compresses
  // a whole tile into a few pixels at the far edge; sampled at one level that
  // is a field of crawling aliased grid lines, which is the single worst thing
  // a fine mesh can do in motion.
  gl.generateMipmap(gl.TEXTURE_2D);
  // NEAREST WITHIN A LEVEL, and this is not a stylistic choice — it is the GL
  // spelling of the pixel-exact blit the whole of engine/viewport.js exists to
  // guarantee. The floor is 1px lines on a transparent ground; sampled
  // BILINEARLY at an arbitrary sub-texel offset, every one of them spreads
  // across two pixels at roughly half strength, and the streets and the grid go
  // soft. Measured against the 2D blit of the same tile: peak brightness on a
  // scan across the floor fell from 255 to a median of 139.
  //
  // NEAREST is exact here because at the shipped CITY_TILT of 90 the ground
  // maps 1:1 (game/citycamera.js), the tile is rasterised at the same device
  // scale as the frame (createSurface), and both the pan and the floor clock
  // are already snapped to whole DEVICE pixels — so a texel centre lands on a
  // pixel centre, which is exactly the condition blitSurface relies on.
  //
  // THE MIP CHAIN STAYS, and stays LINEAR BETWEEN levels: a tilted camera
  // compresses a whole tile into a few pixels at the far edge, and one level
  // sampled nearest is a field of crawling grid lines, which is the single
  // worst thing a fine mesh can do in motion. So: crisp where it is 1:1, mipped
  // where it is not. A camera tilted far enough to magnify the near ground
  // would want LINEAR back, and a wider line in the tile to survive it.
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST_MIPMAP_LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
  const aniso = gl.getExtension("EXT_texture_filter_anisotropic");
  if (aniso) {
    const max = gl.getParameter(aniso.MAX_TEXTURE_MAX_ANISOTROPY_EXT);
    gl.texParameterf(gl.TEXTURE_2D, aniso.TEXTURE_MAX_ANISOTROPY_EXT, Math.min(8, max));
  }
  tileKey = key;
}

// Draw one frame of the floor into this module's own canvas.
//
//   cam        game/citycamera.js's camera for this frame
//   buildings  [{ wx, wy, variant, enter }], in any order — the depth buffer
//              is what resolves them, so the caller's far-to-near walk carries
//              no meaning here
//   tile       the floor tile canvas and a cache key identifying it
//   colors     the five live palette bindings, as "#rrggbb"
//   fade       [start, end] ground distance from the anchor over which the
//              city hazes out, which is also how far the ground quad reaches
//              (citycamera.js's GROUND_FADE_START/END)
export function render(cam, buildings, tile, colors, W, H, fade) {
  if (!ok) return null;
  fadeStart = fade[0];
  fadeEnd = fade[1];
  const scale = renderScale();
  const pw = Math.round(W * scale);
  const ph = Math.round(H * scale);
  if (canvas.width !== pw || canvas.height !== ph) {
    canvas.width = pw;
    canvas.height = ph;
  }
  gl.viewport(0, 0, pw, ph);
  gl.clearColor(0, 0, 0, 0);
  gl.clearDepth(1);
  gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
  gl.enable(gl.DEPTH_TEST);
  gl.depthFunc(gl.LEQUAL);
  gl.disable(gl.CULL_FACE); // see the header
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA); // premultiplied

  // --- Ground -------------------------------------------------------------
  if (tile && tile.canvas) {
    syncTile(tile.canvas, tile.key);
    gl.useProgram(groundProgram);
    setCamera(groundU, cam, W, H);
    gl.uniform1i(groundU.uTile, 0);
    gl.uniform2f(groundU.uTilePeriod, tile.periodX, tile.periodY);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tileTexture);

    // A square of ground centred on the anchor, which is eye + focal * fwd —
    // the eye-to-anchor distance and the focal length are the same number by
    // construction (citycamera.js). Two triangles: the hardware clips them
    // against the near plane and interpolates the UVs projectively, so
    // subdividing would buy nothing but vertices.
    const ax = cam.eye[0] + cam.fwd[0] * cam.focal;
    const ay = cam.eye[1] + cam.fwd[1] * cam.focal;
    const r = fadeEnd;
    const q = new Float32Array([
      ax - r, ay - r, ax + r, ay - r, ax + r, ay + r,
      ax - r, ay - r, ax + r, ay + r, ax - r, ay + r,
    ]);
    gl.bindVertexArray(groundVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, groundBuffer);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, q);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }

  // --- Buildings ----------------------------------------------------------
  // Bucketed by variant so each variant is one instanced draw. The buckets are
  // contiguous slices of ONE upload; `starts` remembers where each begins.
  const counts = new Array(vaos.length).fill(0);
  for (const b of buildings) counts[b.variant]++;
  const starts = new Array(vaos.length);
  let cursor = 0;
  for (let v = 0; v < vaos.length; v++) {
    starts[v] = cursor;
    cursor += counts[v];
  }
  const total = Math.min(cursor, MAX_INSTANCES);
  const fill = starts.slice();
  for (const b of buildings) {
    const i = fill[b.variant]++;
    if (i >= MAX_INSTANCES) continue;
    instData[i * 3] = b.wx;
    instData[i * 3 + 1] = b.wy;
    instData[i * 3 + 2] = b.enter;
  }
  gl.bindBuffer(gl.ARRAY_BUFFER, instBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, instData.subarray(0, total * 3), gl.DYNAMIC_DRAW);

  gl.useProgram(fillProgram);
  setCamera(fillU, cam, W, H);
  gl.uniform3fv(fillU.uFill, hexToRgb(colors.fill));
  gl.uniform3fv(fillU.uFillSide, hexToRgb(colors.fillSide));
  gl.uniform3fv(fillU.uFillRoof, hexToRgb(colors.fillRoof));
  for (let v = 0; v < vaos.length; v++) {
    if (counts[v] === 0 || starts[v] >= MAX_INSTANCES) continue;
    const n = Math.min(counts[v], MAX_INSTANCES - starts[v]);
    gl.bindVertexArray(vaos[v].fill);
    bindFloat(vaos[v].fillInstLoc, instBuffer, 3, 1, 12, starts[v] * 12);
    gl.drawArraysInstanced(gl.TRIANGLES, 0, vaos[v].triVerts, n);
  }

  gl.useProgram(lineProgram);
  setCamera(lineU, cam, W, H);
  gl.uniform3fv(lineU.uEdge, hexToRgb(colors.edge));
  gl.uniform3fv(lineU.uEdgeDim, hexToRgb(colors.edgeDim));
  gl.uniform2f(lineU.uWidths, 0.75, 0.5);
  gl.uniform1f(lineU.uLineBias, LINE_BIAS);
  for (let v = 0; v < vaos.length; v++) {
    if (counts[v] === 0 || starts[v] >= MAX_INSTANCES) continue;
    const n = Math.min(counts[v], MAX_INSTANCES - starts[v]);
    gl.bindVertexArray(vaos[v].line);
    bindFloat(vaos[v].lineInstLoc, instBuffer, 3, 1, 12, starts[v] * 12);
    gl.drawArraysInstanced(gl.TRIANGLES, 0, vaos[v].lineVerts, n);
  }

  gl.bindVertexArray(null);
  return canvas;
}
