// PRESENT — how the finished frame gets from the Canvas2D backing store onto
// the screen. Today that is: upload it as a texture and blit it straight back
// out through WebGL2, unchanged.
//
// WHY A NO-OP IS THE WHOLE POINT. This is Phase 15a (README), the first step of
// a GPU post-processing path whose payoff is 15b's real bloom and 15d's
// collapse of `neonStroke`'s three-pass fake halo. Shipping the PLUMBING first,
// with no effect on it at all, is what makes the rest debuggable: the frame is
// pixel-identical with the path on and off, so when bloom arrives and something
// regresses — a colour shift, a dropped frame, a soft edge — the upload, the
// sizing, the compositor layer and the fallback have all already been proved
// innocent. Do not add an effect here. 15b and 15e are separate passes and
// separate PRs.
//
// WHAT WOULD GO WRONG WITHOUT THIS MODULE: nothing, immediately, which is the
// unusual thing about it. The 2D canvas below is a complete game on its own,
// and that is exactly why the fallback is cheap enough to be unconditional —
// no WebGL2, or a context lost mid-run, and the game shows the 2D canvas
// directly and keeps playing. Every failure path in gl/context.js funnels into
// the single `live` flag below.
//
// TWO CANVASES, WHICH IS NOT A CHOICE. A 2D and a WebGL context cannot share a
// canvas element, so the frame has to cross from one to the other as a texture
// upload every frame. That cost was the phase's open risk and it was measured
// before any of this was written: on an Intel Iris Xe (the weak integrated GPU
// engine/viewport.js's MAX_SCALE is written for) a 1200x1600 RGBA upload plus
// the fullscreen draw is ~1047us sustained, ~259us at scale 1, of which only
// ~15us is CPU submit time — the rest is GPU-side and does not compete with
// update() on the main thread. Against a 16.7ms budget it clears. The README's
// 15a entry carries the derivation and the two traps that gave impossible
// answers first.
//
// --- Dropped frames under a live compositor ---------------------------------
//
// THE NUMBER THIS SUB-PHASE EXISTED TO OBTAIN. It could not come from a spike,
// because requestAnimationFrame is throttled to a standstill in a hidden tab —
// which is a fifth profiling trap on top of the four the README lists, and it
// is the reason this had to ship to be measured at all.
//
// Method as in css/style.css: frames over 17ms out of 600, counted from a bare
// rAF loop running beside the game. Three samples per configuration, all taken
// on one machine in one sitting, in a live run on the road (not on a menu — the
// full-screen states draw a fraction of the work). Chrome/ANGLE on Windows,
// scale 1.125, drawing buffer 675x900.
//
//                              over 17ms      missed vsync (>25ms)   mean frame
//   the build before 15a       1, 2, 8        0, 0, 0                16.67ms
//   15a, GL_PRESENT off        6, 6, 6        0, 0, 0                16.67ms
//   15a, GL_PRESENT on         6, 19, 20      0, 0, 1                16.67ms
//
// READ THE SECOND COLUMN, NOT THE FIRST. Every sample holds a 16.67ms mean —
// dead-on 60Hz — and every frame counted in the first column landed between
// 17.1 and 18.2ms, which is jitter either side of a vsync the compositor still
// made. The first column also varies by more between two samples of the SAME
// configuration (1 to 8 on the untouched build) than it does between
// configurations, so it cannot carry a comparison on its own; it is here
// because it is what the earlier measurement used. What a genuinely dropped
// frame looks like at 60Hz is ~33ms, and there was exactly one over the whole
// exercise: a 116ms stall on a GL_PRESENT-on sample, unreproduced in five other
// samples of that configuration and the shape of a GC pause or a track load
// rather than of a present path.
//
// So: THE GPU PATH DROPS NO FRAMES THE 2D PATH DOES NOT, and the plumbing costs
// nothing measurable when the flag is off. The upload's ~259us at this scale is
// GPU-side work inside a 16.7ms budget that was already ~1ms full, which is
// what the numbers say back. Anyone re-taking this on weaker hardware should
// expect the first column to stay noise and should watch the second.
//
// --- Per-frame cost ---------------------------------------------------------
//
// TWO GL CALLS PER FRAME, and everything else is set up once. The program, the
// texture, the sampler uniform and the unpack state are all bound in build()
// and nothing else in the game touches this context, so they stay bound; the
// viewport is set only when the drawing buffer resizes. What remains on the hot
// path is the upload and the draw. This matters more than it looks: the CPU
// half of the cost above is submit time, and submit time is call count.
//
// NO VERTEX BUFFER AT ALL — the fullscreen triangle derives its own corners
// from gl_VertexID. See gl/shaders.js for why a triangle rather than a quad,
// and why the Y flip lives in the vertex shader rather than in the upload.

import { GL_PRESENT } from "../testoptions.js";
import { mirrorCanvas } from "./viewport.js";
import { createContext, buildProgram } from "./gl/context.js";
import { PRESENT_VS, PRESENT_FS } from "./gl/shaders.js";

// The 2D canvas the game draws into, and the WebGL2 canvas in front of it.
let source = null;
let frameEl = null;

let gl = null;
let program = null;
let texture = null;
// The size the texture was allocated at. Zero means "not allocated", which is
// also the state a context loss leaves behind — so the size check on the hot
// path doubles as the rebuild trigger and there is no second flag to keep true.
let texW = 0;
let texH = 0;

// The single branch every failure funnels into: no WebGL2, a shader that would
// not compile, a lost context. False means present() does nothing and the 2D
// canvas is what the player is looking at — today's game exactly.
let live = false;

// Exposed for verifying the fallback by hand from the console: force a loss
// with the WEBGL_lose_context extension and this is what says the game noticed.
// Nothing in the render path reads it.
export function isLive() {
  return live;
}

// Show the GL canvas or the 2D one. A CLASS ON THE CABINET, not inline styles
// on two elements, because the swap is three coupled rules (which canvas is
// visible, which one is promoted to a compositor layer, and which one carries
// the cabinet's background) and css/style.css is where all three are already
// written down. Inline styles here would be a second, partial copy of that
// stylesheet.
//
// The 2D canvas goes `visibility: hidden`, not `display: none`: it must keep
// its box, because engine/viewport.js measures it to derive the cabinet's
// chrome (chromeSize there) and engine/gutter.js measures the cabinet to hang
// the side panels off it. A displaced 2D canvas would collapse the cabinet and
// take the gutters with it. Hidden is enough — a hidden element is not
// painted, so the 2D canvas stops being composited, which is the point.
function setLive(next) {
  live = next;
  if (frameEl) frameEl.classList.toggle("gl", next);
}

// (Re)create everything that dies with the context. Written to be run any
// number of times: gl/context.js calls it again after a restore, and every
// handle it sets is one that was invalid a moment earlier.
function build() {
  program = buildProgram(gl, PRESENT_VS, PRESENT_FS);
  if (!program) return false;

  gl.useProgram(program);
  gl.uniform1i(gl.getUniformLocation(program, "uFrame"), 0);
  gl.activeTexture(gl.TEXTURE0);

  // PIXEL-IDENTITY LIVES IN THESE THREE LINES, and the default is wrong for the
  // first. COLORSPACE_CONVERSION defaults to BROWSER_DEFAULT_WEBGL, which
  // permits the browser to apply a colour transform on upload and would shift
  // every neon hue by an amount nobody could then find. FLIP_Y off keeps the
  // driver from re-laying-out the whole image every frame (the shader flips
  // instead, for free). PREMULTIPLY off leaves the bytes alone; the frame is
  // opaque anyway, so there is nothing to premultiply and the only thing this
  // could do is round.
  gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);

  // Nothing to blend against and nothing to occlude — the pass writes every
  // pixel of an opaque frame. Both default off in a fresh context; stated
  // anyway, because build() also runs after a restore and the cheapest way to
  // be sure of a restored context's state is not to depend on it.
  gl.disable(gl.BLEND);
  gl.disable(gl.DEPTH_TEST);

  texture = null;
  texW = 0;
  texH = 0;
  return true;
}

function teardown() {
  program = null;
  texture = null;
  texW = 0;
  texH = 0;
}

// Allocate the frame texture at the backing store's size, and point the
// viewport at the whole drawing buffer.
//
// texStorage2D, so the texture is IMMUTABLE: the size is fixed at allocation
// and the per-frame upload is a texSubImage2D into storage the driver has
// already laid out and validated. A mutable texImage2D per frame re-specifies
// the whole texture every time, which is the same bytes plus a reallocation the
// upload does not need. The price is that a resize needs a NEW texture object
// rather than a bigger one — which is why the old one is deleted here.
//
// NEAREST, and it is load-bearing rather than a default worth taking. The
// texture and the drawing buffer are the same size, so every fragment centre
// falls exactly on one texel; LINEAR would fetch that same texel at four times
// the cost, and would turn any future half-texel disagreement into a softening
// of the whole frame rather than an obvious break.
function allocate(w, h) {
  if (texture) gl.deleteTexture(texture);
  texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, w, h);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  // Only one mip level exists, so a wrap mode that could sample outside [0,1]
  // would fetch an undefined texel at the frame's edge. The triangle never asks
  // for one, but CLAMP costs nothing to state.
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.viewport(0, 0, w, h);
  texW = w;
  texH = h;
}

// Wire the present path up. Returns whether the GL path is live; false is a
// complete answer rather than an error, and means the game runs exactly as it
// did before this module existed.
//
// CALLED BEFORE initViewport, deliberately: the GL canvas is registered as a
// viewport mirror here, and the viewport's first sizing pass is what gives it a
// backing store. Registered after, it would spend its first frames at the
// 300x150 default a canvas element carries.
export function init(gameCanvas, presentCanvas) {
  // The flag off is not a degraded mode — it is the shipping game up to Phase
  // 14. Nothing is created, nothing is registered, and the cabinet never gets
  // the `gl` class, so the second canvas stays `display: none` and out of the
  // compositor entirely.
  if (!GL_PRESENT || !gameCanvas || !presentCanvas) return false;

  source = gameCanvas;
  frameEl = presentCanvas.parentElement;

  gl = createContext(presentCanvas, {
    // A loss can arrive between any two calls, including inside present(). Both
    // handlers therefore only set state; neither touches the dead context.
    onLost: () => {
      teardown();
      setLive(false);
    },
    onRestored: () => {
      if (build()) setLive(true);
    },
  });
  if (!gl) return false;

  mirrorCanvas(presentCanvas);
  if (!build()) {
    gl = null;
    return false;
  }
  setLive(true);
  return true;
}

// The last thing render() does. Upload the frame, blit it out.
export function present() {
  if (!live) return;

  const w = source.width;
  const h = source.height;
  // A zero-sized backing store is not a state the viewport produces, but a
  // texStorage2D of zero is a GL error rather than a no-op, so it is worth the
  // one comparison to be sure this can never be the thing that kills a frame.
  if (w === 0 || h === 0) return;
  if (w !== texW || h !== texH) allocate(w, h);

  // The upload. Chrome ELIDES this when the source canvas has not changed since
  // the last one — a real optimisation for a static source, and the trap that
  // made an early benchmark report 5 TB/s (README, Phase 15a). It cannot help
  // here, for the right reason: the game draws a new frame before every call.
  gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, source);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
}
