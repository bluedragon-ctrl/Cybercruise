// PRESENT — how the finished frame gets from the Canvas2D backing store onto
// the screen. Phase 15a (README) shipped this as a no-op: upload the frame as
// a texture, blit it straight back out through WebGL2, unchanged. Phase 15b
// puts the first real effect in that pass — bloom — and this module now runs
// a seven-draw chain instead of one.
//
// THE CHAIN, in the order present() runs it (see gl/shaders.js for what each
// fragment stage does and why):
//
//   frame (full-res, NEAREST)
//     -> BRIGHT_FS   -> halfA    (threshold, and a decimating downsample —
//                                 the frame texture is NEAREST, so this tap
//                                 is a point sample, not a box filter; the
//                                 threshold is what matters here, not the
//                                 resampling quality of a mostly-zero image)
//     -> BLUR_FS  (H) -> halfB
//     -> BLUR_FS  (V) -> halfA   (half-res bloom, done)
//     -> PRESENT_FS   -> quarterA (downsample: halfA is LINEAR, so this same
//                                  blit shader's one tap lands between four
//                                  half-res texels and returns their bilinear
//                                  average — a correct box filter, reusing the
//                                  15a shader rather than adding a fifth one)
//     -> BLUR_FS  (H) -> quarterB
//     -> BLUR_FS  (V) -> quarterA (quarter-res bloom, done)
//     -> COMPOSITE_FS(frame, halfA, quarterA) -> the drawing buffer
//
// THAT IS THE CHAIN WITH testoptions.js's GL_PRESENT ON, which is the default
// and the only path this file's pixel-identity claims are about. Off, present()
// stops after the upload and reuses PRESENT_FS for a single frame -> drawing
// buffer blit — 15a's original no-op, with none of the seven passes above. See
// GL_PRESENT's own comment for why "off" no longer means "no GPU pass at all".
//
// WHY TWO RESOLUTIONS RATHER THAN ONE. A single blur radius is a choice
// between a tight halo (misses broad glow) and a soft one (loses the bright
// core to a wash) — see CLAUDE.md's phase notes on 15b/15d. Blurring the same
// 5-tap kernel at half-res AND at quarter-res and summing both gives a tight
// contribution and a broad one for the price of one extra downsample and one
// extra blur pass, which is cheap because both run on a quarter of the pixels
// or fewer.
//
// 15B'S NUMBERS ARE PROVISIONAL. BLOOM_THRESHOLD and BLOOM_EXPOSURE below, and
// the half/quarter mix in COMPOSITE_FS, are a first pass, not a tuned look —
// see CLAUDE.md and gl/shaders.js's header for why 15d owns the final numbers
// and this PR does not try to make a doubled halo (three-pass neonStroke plus
// bloom) look right.
//
// WHAT WOULD GO WRONG WITHOUT THIS MODULE, AS OF 15D-I: the game does not run.
// WebGL2 is required (see gl/context.js's header for the reversal and why),
// and this module is where that requirement is enforced and where both of its
// failure paths are answered — a `#gl-notice` DOM overlay (index.html,
// css/style.css), not drawn on either canvas, because the one case it exists
// for is the one where the thing that draws text is the thing that is
// missing. No WebGL2 at `init()` shows it as a dead end: `init()` returns
// false, the caller (main.js) never starts the loop, and nothing is
// playable. A context lost mid-run shows it as a pause: `live` drops to
// false, present() becomes a no-op every frame until `webglcontextrestored`
// fires, and the overlay covers whatever the (frozen, unadvancing) 2D canvas
// is currently showing so a driver hiccup never reads as "keep driving
// blind" — see gl/context.js's header for why that used to be answerable by
// just showing the 2D canvas and no longer is. Every failure path in
// gl/context.js funnels into the single `live` flag below either way; only
// what `live` false now MEANS has changed.
//
// TWO CANVASES, WHICH IS NOT A CHOICE. A 2D and a WebGL context cannot share a
// canvas element, so the frame has to cross from one to the other as a texture
// upload every frame. That cost was Phase 15's open risk and it was measured
// before any of this was written: on an Intel Iris Xe (the weak integrated GPU
// engine/viewport.js's MAX_SCALE is written for) a 1200x1600 RGBA upload plus
// the fullscreen draw was ~1047us sustained in 15a, ~259us at scale 1, of
// which only ~15us was CPU submit time. See "Per-frame cost" below for 15b's
// re-measurement of the whole chain.
//
// --- Dropped frames under a live compositor ---------------------------------
//
// THE NUMBER THIS SUB-PHASE EXISTED TO OBTAIN, in 15a. It could not come from
// a spike, because requestAnimationFrame is throttled to a standstill in a
// hidden tab — which is a fifth profiling trap on top of the four the README
// lists, and it is the reason this had to ship to be measured at all.
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
//   15b, GL_PRESENT on         see README's Phase 15b entry for the re-take
//
// READ THE SECOND COLUMN, NOT THE FIRST. Every sample holds a 16.67ms mean —
// dead-on 60Hz — and every frame counted in the first column landed between
// 17.1 and 18.2ms, which is jitter either side of a vsync the compositor still
// made. The first column also varies by more between two samples of the SAME
// configuration (1 to 8 on the untouched build) than it does between
// configurations, so it cannot carry a comparison on its own; it is here
// because it is what the earlier measurement used. What a genuinely dropped
// frame looks like at 60Hz is ~33ms, and there was exactly one over the whole
// 15a exercise: a 116ms stall on a GL_PRESENT-on sample, unreproduced in five
// other samples of that configuration and the shape of a GC pause or a track
// load rather than of a present path.
//
// So, as of 15a: THE GPU PATH DROPS NO FRAMES THE 2D PATH DOES NOT, and the
// plumbing cost nothing measurable when the flag was off. 15b adds real
// fragment work on top of that baseline; the README's Phase 15b entry carries
// the re-taken table.
//
// --- Per-frame cost ---------------------------------------------------------
//
// FORTY-TWO GL CALLS PER FRAME as of 15b, not two — one texture upload plus
// seven draw passes (bright-pass, four blur passes, one downsample, one
// composite), each wrapped in the bindFramebuffer/viewport/useProgram/bind
// calls its target and its source demand. `build()` sets every uniform that
// does not change frame to frame (which texture unit each sampler reads, the
// blend and depth state) once, so what is left on the hot path is genuinely
// per-frame: the upload, and each pass's framebuffer bind, its texture bind,
// and (for the four passes whose target size differs from the previous pass)
// a viewport call. This still matters for the reason it did in 15a: the CPU
// half of the cost is submit time, and submit time is call count — but at 42
// calls of mostly tiny, fixed-size fullscreen draws, none of them anywhere
// near the geometry-heavy calls a real scene would submit, submit time stayed
// far under budget (see the measurement below).
//
// NO VERTEX BUFFER AT ALL, IN ANY OF THE SEVEN PASSES — every stage reuses
// PRESENT_VS, whose fullscreen triangle derives its own corners from
// gl_VertexID (gl/shaders.js). One vertex shader, several fragment shaders,
// zero buffers, zero attributes, zero VAOs — which is what keeps trap #1 below
// a four-target problem instead of a four-target-plus-four-buffers one.

import { GL_PRESENT } from "../testoptions.js";
import { mirrorCanvas } from "./viewport.js";
import { createContext, buildProgram } from "./gl/context.js";
import { PRESENT_VS, PRESENT_FS, BRIGHT_FS, BLUR_FS, COMPOSITE_FS } from "./gl/shaders.js";
import { createTarget, resizeTarget } from "./gl/target.js";

// PROVISIONAL — see the file header and gl/shaders.js. Per-channel: a pixel
// below this on every channel contributes no bloom at all, so most of a dark
// road contributes nothing and the cost stays where the fullscreen passes are
// cheapest (a near-empty bright-pass target). Raised to >= 1.0 for the
// pixel-identity self-test below, since every frame channel is in [0, 1].
const BLOOM_THRESHOLD = 0.75;

// PROVISIONAL — multiplies the bright-pass contribution before COMPOSITE_FS's
// `1 - exp(-x)` knee (gl/shaders.js). Higher pushes more of the knee's curve
// into its steep early region, which reads as a stronger glow for the same
// threshold.
const BLOOM_EXPOSURE = 3.0;

// The 2D canvas the game draws into, and the WebGL2 canvas in front of it.
let source = null;
let frameEl = null;

let gl = null;

// The four programs in the chain. bright and the reused `present` (the 15a
// blit, doing the half-to-quarter downsample here) each read one texture at
// unit 0; blur reads its source at unit 0 too, four times over with a
// different target and a different uStep each time; composite is the one
// program that reads more than one unit at once (frame at 0, the two bloom
// targets at 1 and 2).
let presentProgram = null;
let brightProgram = null;
let blurProgram = null;
let compositeProgram = null;

// Uniform locations that change every frame. Everything that does NOT change
// (which texture unit each sampler reads) is set once in build() and never
// looked up again.
let uBrightThreshold = null;
let uBlurStep = null;
let uCompExposure = null;

let texture = null;
// The size the frame texture was allocated at. Zero means "not allocated",
// which is also the state a context loss leaves behind — so the size check on
// the hot path doubles as the rebuild trigger for the WHOLE chain (the bloom
// targets are resized alongside it in allocate()) and there is no second flag
// to keep true.
let texW = 0;
let texH = 0;

// Half- and quarter-resolution render targets, each a texture plus the
// framebuffer that makes it a draw destination (gl/target.js). Two per
// resolution for the separable blur's ping-pong: the H pass reads A and
// writes B, the V pass reads B and writes back into A, so A is the one that
// holds the finished blur at each resolution and B is pure scratch.
let halfA = null;
let halfB = null;
let quarterA = null;
let quarterB = null;

// False before init() has run, and again for as long as a lost context stays
// lost — the single branch every RUNTIME failure funnels into. present()
// no-ops while this is false; what that MEANS to the player is the notice
// below. init() failing outright never sets this at all: it returns false
// before touching `live`, and main.js does not start the loop in that case
// (see this file's header) — so a permanently-false `live` is never reached
// through this flag, only through the loop never starting.
let live = false;

// Exposed for verifying the pause by hand from the console: force a loss with
// the WEBGL_lose_context extension and this is what says the game noticed.
// Nothing in the render path reads it.
export function isLive() {
  return live;
}

// Show the GL canvas or the 2D one underneath it. A CLASS ON THE CABINET, not
// inline styles on two elements, because the swap is three coupled rules
// (which canvas is visible, which one is promoted to a compositor layer, and
// which one carries the cabinet's background) and css/style.css is where all
// three are already written down. Inline styles here would be a second,
// partial copy of that stylesheet.
//
// The 2D canvas goes `visibility: hidden`, not `display: none`, whichever
// canvas is on top: it must keep its box, because engine/viewport.js measures
// it to derive the cabinet's chrome (chromeSize there) and engine/gutter.js
// measures the cabinet to hang the side panels off it. A displaced 2D canvas
// would collapse the cabinet and take the gutters with it. Hidden is enough —
// a hidden element is not painted, so the 2D canvas stops being composited,
// which is the point. A CALL WITH `next` FALSE, during a context loss, does
// not put the 2D canvas back on top of anything worth looking at — see
// showNotice below, which covers both canvases with the loss message
// regardless of this class.
function setLive(next) {
  live = next;
  if (frameEl) frameEl.classList.toggle("gl", next);
}

// --- The WebGL2-required / context-lost notice ------------------------------
//
// Plain DOM (`#gl-notice` in index.html, styled in css/style.css), covering
// the whole cabinet at a z-index above both canvases. NOT drawn on either
// canvas, because the two cases it exists for are exactly the two cases where
// drawing might not work: no WebGL2 at all, or the context that would draw it
// just having been lost. `fatal` picks the tone (a permanent dead end vs a
// pause worth waiting out) and nothing else — same two DOM nodes either way,
// found once per `init()` off the cabinet element already in hand rather than
// threaded through as a third canvas-shaped parameter.
let noticeEl = null;
let noticeTitleEl = null;
let noticeBodyEl = null;

function showNotice(fatal, title, body) {
  if (!noticeEl) return;
  noticeTitleEl.textContent = title;
  noticeBodyEl.textContent = body;
  noticeEl.classList.toggle("fatal", fatal);
  noticeEl.hidden = false;
}

function hideNotice() {
  if (noticeEl) noticeEl.hidden = true;
}

const WEBGL2_MISSING_TITLE = "WEBGL2 REQUIRED";
const WEBGL2_MISSING_BODY =
  "Cybercruise needs WebGL2 to run, and this browser or graphics driver " +
  "doesn't provide it. Try updating your browser or your graphics drivers, " +
  "or open the game in a different browser.";

// A shader/program that fails to compile or link after WebGL2 itself was
// acquired successfully — see gl/context.js's compile()/buildProgram(), which
// already console.warn the real reason. Kept distinct from the message above
// rather than reused for it: this machine HAS WebGL2, so telling it to update
// a browser or driver would be pointing at the wrong fix.
const RENDER_INIT_FAILED_TITLE = "RENDERER FAILED TO START";
const RENDER_INIT_FAILED_BODY =
  "WebGL2 is available, but the renderer failed to start — see the browser " +
  "console for the reason. Reloading may help.";

const GPU_LOST_TITLE = "GPU CONNECTION LOST";
const GPU_LOST_BODY =
  "The graphics context was lost — a driver reset, a GPU switch, or waking " +
  "from sleep can all cause this. The run is paused and will resume " +
  "automatically once the connection is back.";

// (Re)create everything that dies with the context. Written to be run any
// number of times: gl/context.js calls it again after a restore, and every
// handle it sets — four programs, four render targets, the frame texture — is
// one that was invalid a moment earlier.
//
// THIS IS THE HIGHEST-RISK FUNCTION IN THE PR. In 15a there was one program
// and one texture to rebuild; a restore that missed either was obvious (a
// black screen the instant it ran, on any machine). Here a restore that
// rebuilds the frame texture and three of four programs but drops, say,
// quarterB, is a black screen ONLY once a frame reaches the composite stage
// with a target that never got reattached — which can survive a cursory look
// and only show up after a real driver reset. Every handle below is therefore
// listed once, in one function, with nothing built lazily on first use.
function build() {
  presentProgram = buildProgram(gl, PRESENT_VS, PRESENT_FS);
  brightProgram = buildProgram(gl, PRESENT_VS, BRIGHT_FS);
  blurProgram = buildProgram(gl, PRESENT_VS, BLUR_FS);
  compositeProgram = buildProgram(gl, PRESENT_VS, COMPOSITE_FS);
  if (!presentProgram || !brightProgram || !blurProgram || !compositeProgram) return false;

  gl.useProgram(presentProgram);
  gl.uniform1i(gl.getUniformLocation(presentProgram, "uFrame"), 0);

  gl.useProgram(brightProgram);
  gl.uniform1i(gl.getUniformLocation(brightProgram, "uFrame"), 0);
  uBrightThreshold = gl.getUniformLocation(brightProgram, "uThreshold");

  gl.useProgram(blurProgram);
  gl.uniform1i(gl.getUniformLocation(blurProgram, "uSource"), 0);
  uBlurStep = gl.getUniformLocation(blurProgram, "uStep");

  gl.useProgram(compositeProgram);
  gl.uniform1i(gl.getUniformLocation(compositeProgram, "uFrame"), 0);
  gl.uniform1i(gl.getUniformLocation(compositeProgram, "uBloomHalf"), 1);
  gl.uniform1i(gl.getUniformLocation(compositeProgram, "uBloomQuarter"), 2);
  uCompExposure = gl.getUniformLocation(compositeProgram, "uExposure");

  gl.activeTexture(gl.TEXTURE0);

  // PIXEL-IDENTITY (the zero-bloom case; see COMPOSITE_FS) STARTS WITH THESE
  // THREE LINES, and the default is wrong for the first. COLORSPACE_CONVERSION
  // defaults to BROWSER_DEFAULT_WEBGL, which permits the browser to apply a
  // colour transform on upload and would shift every neon hue by an amount
  // nobody could then find. FLIP_Y off keeps the driver from re-laying-out the
  // whole image every frame (the shader flips instead, for free). PREMULTIPLY
  // off leaves the bytes alone; the frame is opaque anyway, so there is
  // nothing to premultiply and the only thing this could do is round.
  gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);

  // Nothing to blend against and nothing to occlude — every pass in the chain
  // writes every pixel of its target. Both default off in a fresh context;
  // stated anyway, because build() also runs after a restore and the cheapest
  // way to be sure of a restored context's state is not to depend on it.
  gl.disable(gl.BLEND);
  gl.disable(gl.DEPTH_TEST);

  texture = null;
  texW = 0;
  texH = 0;

  halfA = createTarget(gl);
  halfB = createTarget(gl);
  quarterA = createTarget(gl);
  quarterB = createTarget(gl);

  return true;
}

function teardown() {
  presentProgram = null;
  brightProgram = null;
  blurProgram = null;
  compositeProgram = null;
  texture = null;
  texW = 0;
  texH = 0;
  halfA = null;
  halfB = null;
  quarterA = null;
  quarterB = null;
}

// Allocate the frame texture at the backing store's size, and the four bloom
// targets at half and quarter of it. One size check (present()'s) gates the
// whole rebuild, which is what keeps trap #1 above from needing a second flag.
//
// texStorage2D, so the texture is IMMUTABLE: the size is fixed at allocation
// and the per-frame upload is a texSubImage2D into storage the driver has
// already laid out and validated. A mutable texImage2D per frame re-specifies
// the whole texture every time, which is the same bytes plus a reallocation the
// upload does not need. The price is that a resize needs a NEW texture object
// rather than a bigger one — which is why the old one is deleted here, and why
// gl/target.js's resizeTarget does the same for the four bloom targets.
//
// NEAREST, and it is load-bearing rather than a default worth taking. The
// texture and the drawing buffer are the same size, so every fragment centre
// falls exactly on one texel; LINEAR would fetch that same texel at four times
// the cost, and would turn any future half-texel disagreement into a softening
// of the whole frame rather than an obvious break. This reasoning is about the
// FRAME texture only — the four bloom targets are LINEAR on purpose, and
// gl/target.js's header says why.
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
  texW = w;
  texH = h;

  // Each target's size is derived from the one it is actually sampled FROM in
  // the chain (half from the full-res frame, quarter from half), not
  // independently from w/h — ceil rather than floor so the last row/column of
  // an odd-sized backing store still lands inside a target rather than being
  // silently dropped.
  const halfW = Math.max(1, Math.ceil(w / 2));
  const halfH = Math.max(1, Math.ceil(h / 2));
  const quarterW = Math.max(1, Math.ceil(halfW / 2));
  const quarterH = Math.max(1, Math.ceil(halfH / 2));
  resizeTarget(gl, halfA, halfW, halfH);
  resizeTarget(gl, halfB, halfW, halfH);
  resizeTarget(gl, quarterA, quarterW, quarterH);
  resizeTarget(gl, quarterB, quarterW, quarterH);
}

// Wire the present path up. Returns whether WebGL2 is live; false is now a
// FATAL answer — see this file's header — and the caller (main.js) must not
// start the game loop when it comes back false. The notice is already shown
// by the time this returns, in every failing case: there is nothing left for
// a caller to do about "false" except stay stopped.
//
// `onLost`/`onRestored` are the CALLER's own hooks, layered on top of what
// this module already does for every loss/restore (teardown/rebuild, the
// notice). They exist so main.js can pause and resume the game's own state
// machine without this module knowing that a state machine exists — the same
// callback-not-import shape gl/context.js itself uses one level down.
//
// CALLED BEFORE initViewport, deliberately: the GL canvas is registered as a
// viewport mirror here, and the viewport's first sizing pass is what gives it a
// backing store. Registered after, it would spend its first frames at the
// 300x150 default a canvas element carries.
export function init(gameCanvas, presentCanvas, { onLost, onRestored } = {}) {
  if (!gameCanvas || !presentCanvas) return false;

  source = gameCanvas;
  frameEl = presentCanvas.parentElement;
  // Found once, off the cabinet element already in hand — see showNotice's
  // header for why this lives here rather than as a third parameter.
  noticeEl = frameEl ? frameEl.querySelector("#gl-notice") : null;
  noticeTitleEl = noticeEl ? noticeEl.querySelector(".gl-notice-title") : null;
  noticeBodyEl = noticeEl ? noticeEl.querySelector(".gl-notice-body") : null;

  gl = createContext(presentCanvas, {
    // A loss can arrive between any two calls, including inside present(). Both
    // handlers therefore only set state; neither touches the dead context.
    onLost: () => {
      teardown();
      setLive(false);
      showNotice(false, GPU_LOST_TITLE, GPU_LOST_BODY);
      if (onLost) onLost();
    },
    onRestored: () => {
      if (build()) {
        setLive(true);
        hideNotice();
        if (onRestored) onRestored();
      }
      // build() failing HERE — a restore that reconnects but then fails to
      // recompile — is not given a message of its own: `live` stays false and
      // the loss notice stays up, which is still the honest answer. It just
      // stops being true that reconnecting is all that is being waited for.
    },
  });
  if (!gl) {
    showNotice(true, WEBGL2_MISSING_TITLE, WEBGL2_MISSING_BODY);
    return false;
  }

  mirrorCanvas(presentCanvas);
  if (!build()) {
    gl = null;
    showNotice(true, RENDER_INIT_FAILED_TITLE, RENDER_INIT_FAILED_BODY);
    return false;
  }
  setLive(true);
  return true;
}

// The last thing render() does. Upload the frame, run the chain.
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
  //
  // Bound explicitly rather than relied on from a previous frame: the
  // composite pass at the end of THIS function leaves unit 2 active, so unit 0
  // is not a safe assumption to walk into next frame without saying so again.
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, source);

  // THE DEVELOPER SWITCH, off: skip bloom and blit the just-uploaded frame
  // straight to the drawing buffer — the 15a no-op path, kept for exactly the
  // reason 15a built it, comparing the look with and without bloom. What
  // changed in 15d-i is what "off" is being compared AGAINST: before, off
  // meant no GPU pass at all (the 2D canvas, shown directly); that machine no
  // longer exists (gl/context.js's header), so off now means "this GPU pass,
  // minus bloom" — still through present, still through the upload above,
  // just without the seven-draw chain below it. See testoptions.js's own
  // comment on GL_PRESENT.
  if (!GL_PRESENT) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, w, h);
    gl.useProgram(presentProgram);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    return;
  }

  const hw = halfA.width, hh = halfA.height;
  const qw = quarterA.width, qh = quarterA.height;

  // 1. Bright-pass + downsample: frame -> halfA. `texture` is already bound at
  // unit 0 from the upload above, and uBrightFrame->0 was set once in build().
  gl.bindFramebuffer(gl.FRAMEBUFFER, halfA.framebuffer);
  gl.viewport(0, 0, hw, hh);
  gl.useProgram(brightProgram);
  gl.uniform1f(uBrightThreshold, BLOOM_THRESHOLD);
  gl.drawArrays(gl.TRIANGLES, 0, 3);

  // 2. Blur H, half-res: halfA -> halfB.
  gl.bindFramebuffer(gl.FRAMEBUFFER, halfB.framebuffer);
  gl.useProgram(blurProgram);
  gl.bindTexture(gl.TEXTURE_2D, halfA.texture);
  gl.uniform2f(uBlurStep, 1 / hw, 0);
  gl.drawArrays(gl.TRIANGLES, 0, 3);

  // 3. Blur V, half-res: halfB -> halfA. halfA now holds the finished
  // half-res bloom; halfB is scratch again until next frame.
  gl.bindFramebuffer(gl.FRAMEBUFFER, halfA.framebuffer);
  gl.bindTexture(gl.TEXTURE_2D, halfB.texture);
  gl.uniform2f(uBlurStep, 0, 1 / hh);
  gl.drawArrays(gl.TRIANGLES, 0, 3);

  // 4. Downsample: halfA -> quarterA, reusing the 15a blit shader. halfA is
  // LINEAR, so this single tap at each quarter-res texel centre lands exactly
  // between four half-res texels — a correct box filter, not a shortcut (see
  // gl/target.js and gl/shaders.js's PRESENT_FS comment).
  gl.bindFramebuffer(gl.FRAMEBUFFER, quarterA.framebuffer);
  gl.viewport(0, 0, qw, qh);
  gl.useProgram(presentProgram);
  gl.bindTexture(gl.TEXTURE_2D, halfA.texture);
  gl.drawArrays(gl.TRIANGLES, 0, 3);

  // 5. Blur H, quarter-res: quarterA -> quarterB.
  gl.bindFramebuffer(gl.FRAMEBUFFER, quarterB.framebuffer);
  gl.useProgram(blurProgram);
  gl.bindTexture(gl.TEXTURE_2D, quarterA.texture);
  gl.uniform2f(uBlurStep, 1 / qw, 0);
  gl.drawArrays(gl.TRIANGLES, 0, 3);

  // 6. Blur V, quarter-res: quarterB -> quarterA. quarterA now holds the
  // finished quarter-res bloom.
  gl.bindFramebuffer(gl.FRAMEBUFFER, quarterA.framebuffer);
  gl.bindTexture(gl.TEXTURE_2D, quarterB.texture);
  gl.uniform2f(uBlurStep, 0, 1 / qh);
  gl.drawArrays(gl.TRIANGLES, 0, 3);

  // 7. Composite: frame + halfA + quarterA -> the drawing buffer.
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.viewport(0, 0, w, h);
  gl.useProgram(compositeProgram);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.activeTexture(gl.TEXTURE1);
  gl.bindTexture(gl.TEXTURE_2D, halfA.texture);
  gl.activeTexture(gl.TEXTURE2);
  gl.bindTexture(gl.TEXTURE_2D, quarterA.texture);
  gl.uniform1f(uCompExposure, BLOOM_EXPOSURE);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
}
