// Viewport: the one place that knows the difference between the game's LOGICAL
// coordinate system and the DEVICE pixels it ends up rasterised into.
//
// The whole game — every module under src/game — is written against a fixed
// 600x800 playfield and must stay that way. Widening the world on a wide screen
// would show more road ahead and change the difficulty of every tuned value, so
// the playfield's dimensions are a GAME CONSTANT, not a window measurement.
//
// What scales instead is the RASTER. The canvas backing store is sized to
// LOGICAL x `scale`, a single uniform transform is installed on the context, and
// every drawing call in the game keeps issuing 600x800-space coordinates that
// land on more physical pixels than before. Nothing downstream knows.
//
// Three numbers, and it is worth keeping them apart:
//
//   fit    — how many CSS pixels one logical pixel occupies. Purely how big the
//            game LOOKS. Driven by the window; uncapped.
//   scale  — how many DEVICE pixels one logical pixel is RASTERISED into. Purely
//            how SHARP the game is. Capped (see MAX_SCALE) because fill-rate and
//            cache memory both grow with its square.
//   dpr    — the display's own device-pixel ratio, folded into `scale` so a
//            150%-scaled Windows desktop stops upscaling us blurrily.
//
// When `scale` < `fit` * dpr the browser stretches the finished frame the rest
// of the way. That is a deliberate, bounded quality-for-performance trade, and
// it is the only blur in the pipeline.

export const LOGICAL_W = 600;
export const LOGICAL_H = 800;

// Hard ceiling on raster scale.
//
// Cost rationale: the frame currently runs under 1 ms against a 16.7 ms budget
// (see the README's rendering-performance section), and the dominant term is
// neonStroke's blended overdraw, which is pure fill-rate — so cost grows with
// scale SQUARED. 2x is 4x the pixels, landing around 4 ms: still a quarter of
// the budget, with room for a weak integrated GPU underneath. Cache memory grows
// the same way, and the road-strip plus floor-grid tiles are ~5 MB at 1x.
//
// 3x would be ~9 ms and ~45 MB. That is the wrong side of the trade for a
// sharpness difference almost nobody can see at arm's length.
const MAX_SCALE = 2;

// Settle delay before the backing store is resized, in ms.
//
// The CSS box follows the window on every resize event — that is cheap and keeps
// the cabinet glued to the frame. Reallocating the BACKING STORE is the
// expensive half: it invalidates every cached bitmap (road strips, floor grid,
// the whole sprite catalogue), so doing it per pixel of a drag would rebuild
// them hundreds of times. Deferring it until the window has been still for a
// moment collapses a whole drag into ONE rebuild.
//
// The visible trade is that the canvas is briefly non-1:1 — i.e. slightly soft —
// while a drag is in flight, then snaps sharp when it stops. That is the right
// way round: nobody is reading the screen mid-drag.
const RESIZE_SETTLE_MS = 150;

// Current device-pixels-per-logical-pixel. Read through the accessor rather than
// imported as a binding: it changes on resize, and the offscreen caches need to
// see the new value the same frame they are asked to rebuild.
let scale = 1;

export function renderScale() {
  return scale;
}

// How much of the window the cabinet chrome eats: the bezel padding around the
// canvas plus the control-hint bar beneath it.
//
// MEASURED, not a constant mirroring the stylesheet. The hint bar's height
// depends on its font size, which scales with `fit`, which is what we are trying
// to compute — and the bar can wrap on a narrow window besides. Reading the
// rendered difference between the frame and the canvas inside it gets all of
// that for free and cannot drift out of sync with the CSS.
function chromeSize(canvas, frameEl) {
  if (!frameEl) return { w: 0, h: 0 };
  return {
    w: Math.max(0, frameEl.offsetWidth - canvas.offsetWidth),
    h: Math.max(0, frameEl.offsetHeight - canvas.offsetHeight),
  };
}

function currentFit(canvas, frameEl) {
  const chrome = chromeSize(canvas, frameEl);
  const availW = Math.max(1, window.innerWidth - chrome.w);
  const availH = Math.max(1, window.innerHeight - chrome.h);
  return Math.min(availW / LOGICAL_W, availH / LOGICAL_H);
}

// THE SCALE'S DENOMINATOR MUST DIVIDE EVERY TILED DIMENSION.
//
// The renderer draws its two scrolling layers from CACHED TILES, blitted at
// offsets derived from the camera (road.js's blockDestY, scenery.js's
// gridPhase). A tile blitted at a fractional DEVICE offset is resampled rather
// than copied, and because the camera advances every frame the fractional part
// changes every frame, sliding the resample kernel under the artwork — which
// reads as the road smearing as it scrolls. A scale that does not divide the
// tile stride evenly also stops a tile being a whole number of device rows,
// opening sub-pixel seams between consecutive strips.
//
// The fix is NOT to force an integer scale. It is enough that `scale` has a
// denominator dividing every dimension that gets tiled or used as a period:
//
//   TILE_STRIDE      128   (road.js, the strip stride)
//   LOGICAL_W        600
//   LOGICAL_H        800
//   ARTERIAL_PERIOD  512   (citygrid.js, the floor grid's y period)
//
// gcd(128, 600, 800, 512) = 8, so EIGHTHS are exactly representable in device
// pixels for all of them. The camera is snapped to the matching sub-pixel grid
// by snapToDevice below, which closes the loop: every blit offset then lands on
// a whole device pixel too.
//
// Why this matters so much: integer-only scaling looks harmless until you price
// it. `fit` on a 1440p screen is ~1.74 and on a 1600p screen ~1.94, both of which
// floor to 1x — a 74% and 94% browser upscale respectively, on exactly the big
// screens this module exists to serve. Eighth steps track `fit` to within 1/16,
// cutting the worst case to about 6%.
//
// If TILE_STRIDE, either LOGICAL dimension, or ARTERIAL_PERIOD ever changes,
// recompute that gcd — SCALE_STEP is derived from them, not chosen freely.
const SCALE_STEP = 1 / 8;

// ROUND, not floor: rounding down always lands the raster below the display
// size, so the leftover is always an upscale — the one direction that blurs.
// Rounding halves the worst-case mismatch and sends half the cases into a slight
// DOWNSCALE, which resolves sharp.
function quantiseScale(v) {
  const stepped = Math.round(v / SCALE_STEP) * SCALE_STEP;
  return Math.min(MAX_SCALE, Math.max(1, stepped));
}

// Snap a camera value so that value * scale is a whole number of device pixels.
//
// This is the other half of SCALE_STEP's contract, and the reason the tile blits
// stay pixel-exact. Callers pass the values every tiled layer's offset is
// derived from — main.js's road camera and scenery.js's floor clock.
//
// Note this is FINER than the whole-logical-pixel rounding it replaced: at scale
// 1.75 the world advances in steps of 1/1.75 of a logical pixel rather than 1,
// so motion gets smoother, not chunkier. At scale 1 it reduces to Math.round and
// behaves exactly as before.
export function snapToDevice(v) {
  return Math.round(v * scale) / scale;
}

// Resize the backing store to the quantised scale. Returns true if the raster
// actually changed, which is the caller's cue to drop every cached bitmap.
function applyRasterScale(canvas, fit) {
  const dpr = window.devicePixelRatio || 1;
  const next = quantiseScale(fit * dpr);
  const w = Math.round(LOGICAL_W * next);
  const h = Math.round(LOGICAL_H * next);
  if (canvas.width === w && canvas.height === h) return false;

  scale = next;
  // Assigning width/height RESETS the context (transform, fillStyle, the lot),
  // which is why applyTransform runs per frame rather than once here.
  canvas.width = w;
  canvas.height = h;
  return true;
}

// Set the canvas's CSS box, and publish `--fit` for the DOM chrome around it.
// Cheap enough to run on every resize event.
function applyCssSize(canvas, fit) {
  // The CSS box is always the FULL fit: the game fills the window's short axis
  // whatever the raster scale quantised to. Where the two disagree the browser
  // stretches — at most 1/16, and in either direction (see quantiseScale). The
  // canvas is on its own compositor layer so that stretch is a GPU transform
  // rather than a per-frame re-raster; see `will-change` in css/style.css.
  canvas.style.width = `${LOGICAL_W * fit}px`;
  canvas.style.height = `${LOGICAL_H * fit}px`;
  // Published for the CSS chrome around the canvas (the hint bar's type) so DOM
  // text grows with the playfield instead of shrinking against it on a big
  // screen. CSS-only — nothing in the render path reads this.
  document.documentElement.style.setProperty("--fit", fit.toFixed(3));
}

// Wire the canvas to the window. `onScaleChange` fires whenever the RASTER scale
// moves and every cached bitmap has to be rebuilt at the new resolution.
export function initViewport(canvas, onScaleChange, frameEl = null) {
  let settleTimer = 0;

  // The full pass: raster first, then the CSS box derived from it.
  //
  // Run TWICE, deliberately. The first pass sizes the canvas using the chrome
  // measured around the PREVIOUS canvas size; the second re-measures against the
  // new one, which is what the hint bar's own scaled height depends on. It
  // converges immediately because the chrome barely moves between the two, and a
  // stale first pass would leave the cabinet a few px oversized — enough to push
  // the bezel off the bottom of the window.
  const resize = () => {
    let changed = false;
    for (let pass = 0; pass < 2; pass++) {
      const fit = currentFit(canvas, frameEl);
      if (applyRasterScale(canvas, fit)) changed = true;
      applyCssSize(canvas, fit);
    }
    if (changed && onScaleChange) onScaleChange(scale);
  };

  // During a drag only the CSS box tracks the window; the raster resize is
  // deferred to `resize` once things go quiet. See RESIZE_SETTLE_MS.
  const onResize = () => {
    applyCssSize(canvas, currentFit(canvas, frameEl));
    clearTimeout(settleTimer);
    settleTimer = setTimeout(resize, RESIZE_SETTLE_MS);
  };

  window.addEventListener("resize", onResize);
  // devicePixelRatio changes when the window is dragged to a monitor with a
  // different scaling factor, and that fires no resize event on its own.
  const watchDpr = () => {
    const mq = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
    mq.addEventListener("change", () => { resize(); watchDpr(); }, { once: true });
  };
  watchDpr();
  resize(); // immediate, not debounced: the first paint must already be sharp
}

// Install the logical->device transform. Called once per frame, at the top of
// render, because anything that reassigns canvas.width wipes it.
export function applyTransform(ctx) {
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
}

// --- Offscreen surfaces ---------------------------------------------------
//
// Every cached layer (road strips, the floor grid, sprites) must rasterise at
// the SAME scale as the main canvas, or its blit resamples and the artwork goes
// soft — which would undo the entire point of this module.
//
// The two helpers below are a pair and must be used together: `createSurface`
// hands back a canvas whose backing store is scale-sized but whose context is
// pre-transformed, so the caller keeps drawing in plain logical units and needs
// no scale-awareness beyond including `renderScale()` in its cache key.
// `blitSurface` then undoes the size difference at draw time.
export function createSurface(logicalW, logicalH) {
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(logicalW * scale);
  canvas.height = Math.round(logicalH * scale);
  const ctx = canvas.getContext("2d");
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  return canvas;
}

// Blit a surface built by `createSurface` into a logical-space context.
//
// The explicit destination size is what makes this free: source and destination
// resolve to the same number of device pixels, so the drawImage is a 1:1 copy
// and no filtering happens. Omitting it would draw the surface at its DEVICE
// dimensions interpreted as LOGICAL ones — i.e. `scale` times too big.
export function blitSurface(ctx, surface, x, y) {
  ctx.drawImage(surface, x, y, surface.width / scale, surface.height / scale);
}

// Re-blit a horizontal band of the LIVE FRAME back onto itself, shifted `dx`
// logical pixels sideways — the primitive behind both glitch tears (the sector
// rescan in game/sectors.js and the jack-in in game/jackin.js).
//
// It needs its own helper because it is the one drawImage in the codebase whose
// SOURCE is the display canvas itself. A source rectangle indexes the backing
// store in DEVICE pixels and is not touched by the context transform, while the
// destination rectangle is in logical units and is — so the two halves of the
// same call live in different coordinate systems, and the source half is the one
// that must be scaled by hand. Getting this wrong is invisible at 1x and tears
// the wrong strip of the screen at every other scale.
export function blitScreenBand(ctx, canvasEl, y, h, dx, w) {
  ctx.drawImage(canvasEl, 0, y * scale, w * scale, h * scale, dx, y, w, h);
}
