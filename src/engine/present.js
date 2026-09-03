// PRESENT — how the finished frame gets from the Canvas2D backing store onto
// the screen. Phase 15a (README) shipped this as a no-op: upload the frame as
// a texture, blit it straight back out through WebGL2, unchanged. Phase 15b
// puts the first real effect in that pass — bloom. Phase 15e-i adds a second,
// which is the first one that is not a filter over the picture but part of the
// GAME: the jack-in and the disconnect (gl/shaders.js's GLITCH_FS).
//
// THE CHAIN, in the order present() runs it (see gl/shaders.js for what each
// fragment stage does and why):
//
//   frame (full-res, NEAREST)
//     -> GLITCH_FS   -> feedTarget  (15e-i, and ONLY while a sequence is
//                                    running — see `feed.level`. Idle, this
//                                    draw does not happen at all and every
//                                    stage below reads the frame texture
//                                    directly, exactly as it did in 15d)
//     -> BRIGHT_FS   -> halfA    (threshold, and a downsample — FOUR taps, each
//                                 thresholded before they are averaged, which
//                                 is a 2x2 box filter that a thin bright line
//                                 survives. It shipped as ONE tap and that was
//                                 a real bug, not a quality trade: see
//                                 BRIGHT_FS's header)
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
// "frame" IN THAT DIAGRAM IS `frameTex`, which is the uploaded frame texture
// when the feed is idle and the feed target when it is not. The bright pass and
// the composite do not know which, and neither needed editing for 15e-i —
// GLITCH_FS writes its target in the same row convention it read the frame in,
// so the y-flip those two stages apply is still exactly right. That is
// deliberate; see GLITCH_FS's header for the 15b bug it is avoiding.
//
// WHERE THE FEED PASS SITS IS A LOOK DECISION, NOT AN ORDERING DETAIL. It runs
// BEFORE the bright pass, so bloom reads the CORRUPTED frame: a displaced block
// takes its halo with it, an arriving block's flare glows, and the fragments
// still alive at the end of a death keep their neon. Run after the composite
// instead and the corruption would be sharp-edged, sitting over a halo cast by
// pixels that had since moved — which on a game whose whole look is that bright
// things glow reads as a compositing bug rather than as a signal failing.
//
// THAT IS THE CHAIN WITH testoptions.js's GL_PRESENT ON, which is the default
// and the only path this file's pixel-identity claims are about. Off, present()
// reuses PRESENT_FS for a single frame -> drawing buffer blit — 15a's original
// no-op, with none of the seven bloom passes above. See GL_PRESENT's own
// comment for why "off" no longer means "no GPU pass at all".
//
// THE FEED PASS IS OUTSIDE THAT FLAG, as of 15e-i, and that is the third time
// GL_PRESENT's meaning has had to be pinned down. It A/Bs BLOOM. The feed pass
// is not bloom — it is the boot and the death — and a switch that deleted them
// would be useless as a bloom comparison during exactly the two moments this
// module now owns. So off still runs the feed pass and then blits its result.
//
// WHY TWO RESOLUTIONS RATHER THAN ONE. A single blur radius is a choice
// between a tight halo (misses broad glow) and a soft one (loses the bright
// core to a wash) — see CLAUDE.md's phase notes on 15b/15d. Blurring the same
// 5-tap kernel at half-res AND at quarter-res and summing both gives a tight
// contribution and a broad one for the price of one extra downsample and one
// extra blur pass, which is cheap because both run on a quarter of the pixels
// or fewer.
//
// BLOOM_THRESHOLD/BLOOM_EXPOSURE ARE FINAL AS OF PHASE 15C. 15b shipped them
// provisional; 15d-ii held them at those same provisional values because the
// only stronger setting it tried (0.55/4.0) bridged HUD text into unreadable
// blobs, and reverted. Phase 15c is what removes that constraint — see "THE
// HUD SPLIT" below — and these two constants are the payoff: retuned for the
// world alone, with nothing dense sharing this canvas to bridge any more. The
// half/quarter mix in COMPOSITE_FS is unchanged and still provisional; only
// the two constants below were in scope for this phase.
//
// --- The HUD split (Phase 15c) ----------------------------------------------
//
// A second 2D canvas (`#hud` — index.html, css/style.css), painted on top of
// this one, transparent, never uploaded to the GPU and never touched by the
// chain below. drawHud() (main.js), the menu's test-row checkboxes and the
// shop's price list all draw there now instead of on the canvas this module
// bloom's — see main.js's render() for the full split rule (which surface
// goes on which canvas and why).
//
// THE ALTERNATIVE, AND WHY IT LOST. The other way to keep the HUD out of the
// bloom chain was to draw it to an OFFSCREEN 2D canvas, upload it as a SECOND
// TEXTURE, and composite it in COMPOSITE_FS after bloom — one visible canvas,
// no compositor layering. Rejected on 15a's own measurement: the per-frame
// frame-texture upload already dominates this pass at ~1047us sustained
// (see "TWO CANVASES" above), and it is bandwidth-bound (only ~15us of that
// is CPU submit), so a second full-size upload for the HUD would cost
// roughly that same ~1047us AGAIN every frame — nearly doubling the chain's
// already-dominant cost to buy back a compositor blend that `will-change:
// transform` already makes close to free (the same trick `#present` already
// gets over `#game` — see css/style.css). The DOM layer instead costs a
// second small canvas repainted on the game's clock: measured live at
// ~0.72ms mean (p95 ~1.1ms, one 8.2ms outlier in ~1000 samples, consistent
// with this environment's own noise floor) for `#hud`'s own clear-and-redraw,
// against the ~1047us the rejected path would have added on top of the
// existing upload. A THIRD option — masking the bright-pass so HUD pixels
// never enter the chain at all — was considered and rejected without being
// built: the HUD is not a tidy rectangle (the console panel, the wallet
// line and damage flashes all move), so there is no static mask that would
// work.
//
// This is the same trade `engine/gutter.js`'s header calls "declined" for
// the side gutters — a second surface repainted on the game's clock, instead
// of DOM diffed at ~1 write/second — taken here instead of declined, because
// the HUD repaints every frame and needs Canvas2D's text/blend primitives,
// which DOM diffing has no equivalent of.
//
// GLOWTEXT'S OWN shadowBlur IS UNCHANGED, and that is what keeps HUD text
// (and the menu/shop text that joined it) from going dark on the new canvas:
// it was never part of 15d-ii's shadowBlur ban (that was about canvas-
// spanning paths and cached sprites bloom now covers instead), so it keeps
// glowing exactly as it always did, just without ALSO getting bloom's
// per-pixel halo on top — which is the double-glow that made small text
// bridge in the first place.
//
// RETUNED LIVE, A/B AGAINST THE OLD 0.75/3.0: 0.55/4.0 (the exact pair 15d-ii
// tried and reverted) with nothing dense left on the bloomed canvas to
// bridge. Confirmed live across a busy gameplay scene, the menu title and
// rows, and the gameover screen — buildings and barriers gained a visibly
// thicker, richer halo without washing into flat blobs (internal wireframe
// detail stays legible), and HUD/menu/shop text on the new `#hud` layer
// stayed crisp throughout, since none of it shares this chain any more. A
// readPixels scan through a barrier's cross-section (green channel, GL
// drawing buffer, `preserveDrawingBuffer` temporarily forced true to make
// the read possible) confirmed the core still saturates at 255 and the halo
// spreads measurably further at 0.55/4.0 than at 0.75/3.0, consistent with
// (not a re-derivation of) 15d-ii's own "roughly doubled" finding — an exact
// pixel-for-pixel before/after was not attempted, since the two scans were
// taken on different live runs (different traffic, different road curve) and
// are not directly subtractable; the visual comparison across three screen
// types is the stronger evidence here.
//
// THE SELF-TEST'S BLIND SPOT, worth recording once this module has a second
// canvas layered onto its output. THE PIXEL-IDENTITY SELF-TEST (README's "The
// present path": forcing BLOOM_THRESHOLD above 1.0 and diffing the composite
// against the source frame byte for byte) proves colourspace, precision and
// filtering — but it
// is a same-frame diff, so it is BLIND TO ORIENTATION: a vertically mirrored
// copy of an all-zero contribution is still all zeros, and the test would
// pass either way. That blind spot is exactly what 15b's own PRESENT_VS
// Y-flip bug went through undetected (see that shader's header) — found live,
// not by this test. 15e-i adds another GPU-to-GPU pass over the same targets,
// which is more surface for the identical mistake; a future self-test that
// wants to catch an orientation bug needs content with an asymmetric feature in
// it (e.g. a single bright corner pixel), not a uniform field. WHAT 15E-I DID
// INSTEAD, being cheaper and stronger than a better self-test: it does not move
// the flip at all. GLITCH_FS reads the frame in the frame's own row convention
// and writes its target in the same one, so BRIGHT_FS and COMPOSITE_FS were not
// edited and cannot have been edited wrongly.
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
//   15c, HUD layer added       19             0                      16.67ms
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
// THE 15C ROW IS ONE SAMPLE, NOT THREE, reported honestly rather than padded.
// A second attempt RE-TRIGGERED the README's own fourth profiling trap rather
// than turning up a new one: reloading the tab with a plain `navigate` call
// (rather than the `preview_start` call that originally opened it) reproduced
// the exact "hidden:false but rAF still throttled" symptom the README's
// rendering-performance section already documents — the second sample's rAF
// loop sat mostly idle and then delivered one 5983ms frame, an artifact of
// the measurement method, not of this PR. The one clean sample (above) lands
// squarely inside 15a's own "6, 19, 20" range for GL_PRESENT on, with zero
// missed vsync, which
// is what a third canvas costing nothing worth a dropped frame should look
// like. The bare-desktop GPU re-measurement 15b's entry already owed remains
// owed — this sandboxed/remoted pane is still not where that number should be
// taken from, and 15c does not attempt it.
//
// THE HUD LAYER'S OWN CPU COST, measured directly (not inferred from the
// table above): `#hud`'s clear-and-redraw, batched over ~1000 gameplay
// frames, averaged ~0.72ms (p95 ~1.1ms, one 8.2ms outlier consistent with
// this environment's own GC-pause noise rather than a per-frame cost). That
// is the real price of the DOM-layer choice — see "The HUD split" above for
// what the rejected second-texture alternative would have cost instead.
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
// calls its target and its source demand. UNCHANGED BY 15E-I on the frames
// that matter: the feed pass adds a draw plus eleven uniform calls, and adds
// them only while a boot or a death is on screen — which is a couple of seconds
// per run against every other frame the game draws. Gameplay, the menu and the
// shop submit exactly the forty-two they did before. `build()` sets every uniform that
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
import { mirrorCanvas, LOGICAL_W, LOGICAL_H } from "./viewport.js";
import { createContext, buildProgram } from "./gl/context.js";
import { PRESENT_VS, PRESENT_FS, BRIGHT_FS, BLUR_FS, COMPOSITE_FS, GLITCH_FS } from "./gl/shaders.js";
import { createTarget, resizeTarget } from "./gl/target.js";

// --- THE FEED CHANNEL (Phase 15e-i) -----------------------------------------
//
// THE RULE THIS BREAKS, AND WHAT THE RULE IS NOW. Through Phase 15d this file's
// header and the README both said present() takes no game state — "no module
// under src/game/ knows the GPU path exists". The first half of that is what
// changed: the jack-in and the disconnect are now drawn by GLITCH_FS
// (gl/shaders.js), and a sequence driven by a progress value cannot be rendered
// by a pass that is told nothing. THE SECOND HALF IS STILL TRUE AND IS THE
// POINT: game/jackin.js and game/disconnect.js import nothing from here or from
// gl/. Each writes plain numbers into this object through a feed() method, and
// main.js — which already owns both instances and already knows the state
// machine — is the only place that knows those numbers reach a shader.
//
//   THE GAME COMPUTES, main.js DESCRIBES, present.js RENDERS.
//
// ONE-DIRECTIONAL: nothing reads this object back out, and nothing in src/game/
// may. It is a description of the FEED handed forward once per frame, not a
// channel.
//
// THE FIELDS NAME THE SIGNAL, NOT EITHER SEQUENCE. Nothing here says "jack-in"
// or "death", deliberately: 15e-iv is hull-driven corruption on this same axis,
// and when it lands it writes `corrupt`/`quant` from the hull and main.js takes
// the larger of the two. A channel whose fields were named after the sequences
// that first filled them would need widening for that; this one does not.
//
// ONE FROZEN-SHAPE OBJECT, allocated once at module scope and mutated in place.
// Not a per-frame object literal (that is an allocation on the hot path, which
// this codebase does not do — see game/effects.js's "a pure function of
// progress"), and not an index-named Float32Array, which costs the same and
// reads worse. Every field is written every frame by main.js, so there is no
// stale-value case to reason about.
export const feed = {
  // 0 SKIPS THE PASS ENTIRELY. Not "run it with zeroed uniforms" — the draw
  // does not happen and the rest of the chain reads the uploaded frame exactly
  // as it did before this phase existed. That is what makes idle a bit-for-bit
  // no-op by construction rather than by arithmetic, and it is ~99% of the time
  // the game is on screen. GLITCH_FS is written to be the identity at rest
  // anyway (its header), which makes this an optimisation rather than a
  // correctness requirement — but it is the reason there is nothing to measure.
  level: 0,
  // 0..1. Which blocks exist: the frontier through GLITCH_FS's arrival field.
  // 1 is a whole frame, 0 is nothing received.
  resolve: 1,
  // 0..1. How ordered that arrival is — 0 a top-to-bottom wavefront, 1 no order
  // at all.
  order: 0,
  // 0..1. Block-row reordering and line dropout.
  corrupt: 0,
  // 0..1. Per-block-row colour channel desync.
  split: 0,
  // 0..1. Bandwidth: 0 is full depth, 1 is two levels per channel.
  quant: 0,
  // 0..1 toward black, and 0..1 toward white. The two ends' punctuation.
  fade: 0,
  flash: 0,
  // LOGICAL pixels, converted to a UV offset at the uniform call below — the
  // callers deal in the 600x800 playfield and know nothing about the backing
  // store's size or the texture's.
  shakeX: 0,
  shakeY: 0,
  // Seconds. The animated jitter is reseeded from this every frame rather than
  // stored, so nothing in the pass persists across frames.
  time: 0,
  // A FRACTION IN [0, 1), NOT THE CALLER'S RAW SEED, and that is a hard
  // requirement rather than a convention. GLITCH_FS adds this to block indices
  // before hashing, in a 32-bit float: above 2^24 (16,777,216) consecutive
  // integers are no longer representable, so a raw seed of the size
  // Math.random() * 0x7fffffff produces — up to ~2.1e9, where the gap between
  // floats is 128 — SWALLOWS the block index entirely. Every block then hashes
  // to the same value, and the whole per-block character of the pass silently
  // collapses: the arrival frontier becomes a straight horizontal line and the
  // torn rows all tear together.
  //
  // FOUND LIVE, NOT BY INSPECTION, and it very nearly shipped looking fine: the
  // first captures were taken with a JackIn that had never had trigger() called
  // on it, so its seed was the constructor's 1 and everything was correctly
  // ragged. The bug only appears once a real run has seeded it — which is every
  // run. The callers reduce their own seed (jackin.js, disconnect.js); doing it
  // here instead would hide a constraint that belongs where the number is
  // chosen.
  seed: 0,
};

// The macroblock grid, in blocks across and down the playfield. 24x32 over
// 600x800 is 25 logical pixels square — big enough to read as a transport
// artifact rather than as noise, small enough that a car (34x60) spans two or
// three of them and comes apart rather than blinking out whole. Chosen by
// scrubbing both sequences over a captured frame with the grid on a slider.
const FEED_BLOCKS_X = 24;
const FEED_BLOCKS_Y = 32;

// FINAL AS OF PHASE 15C — see the file header's "The HUD split" for the A/B
// this retune rests on. Per-channel: a pixel below this on every channel
// contributes no bloom at all, so most of a dark road contributes nothing and
// the cost stays where the fullscreen passes are cheapest (a near-empty
// bright-pass target). Raised to >= 1.0 for the pixel-identity self-test
// below, since every frame channel is in [0, 1].
const BLOOM_THRESHOLD = 0.55;

// RETUNED IN PHASE 15E-II-A, up from 4.0. Multiplies the bright-pass
// contribution before COMPOSITE_FS's `1 - exp(-x)` knee (gl/shaders.js).
// Higher pushes more of the knee's curve into its steep early region, which
// reads as a stronger glow for the same threshold.
//
// THE RETUNE IS A CORRECTION, NOT A NEW LOOK. BRIGHT_FS's softKnee (see that
// shader's own header) trims a flat BLOOM_KNEE/2 (0.04) off every fully
// saturated channel's contribution to make the approach into zero gentle
// instead of kinked — a deliberate, small cost, paid once per channel
// regardless of how far past threshold it sits. Left at 4.0, that shows up as
// every already-established halo (buildings, barriers — anything drawn at
// full alpha) reading measurably dimmer than it did through Phase 15c, which
// is not what this phase set out to change. Solved for directly rather than
// nudged by eye: a full-value channel's four-tap bright-pass output drops
// from 0.225 to 0.205 (BRIGHT_FS's own header has the per-tap arithmetic), and
// `E` solving `1 - exp(-0.205*E) == 1 - exp(-0.225*4.0)` is ~4.39 — rounded to
// 4.4, which restores the OLD peak composited halo intensity for a saturated
// thin line almost exactly (0.5934 old vs 0.5942 new, computed) while still
// letting near-threshold pixels ramp in through the soft knee rather than
// snapping on. Confirmed live: a busy gameplay scene's buildings and barriers
// read the same thickness of halo as before the knee, not thinner.
const BLOOM_EXPOSURE = 4.4;

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
// 15e-i's feed pass, which runs BEFORE all four of those when the feed is not
// idle and not at all when it is.
let glitchProgram = null;

// Uniform locations that change every frame. Everything that does NOT change
// (which texture unit each sampler reads) is set once in build() and never
// looked up again.
let uBrightThreshold = null;
// The FRAME's texel size, for the bright pass's four taps — see BRIGHT_FS.
// Per-frame like the rest of these, because it changes with the backing store.
let uBrightTexel = null;
let uBlurStep = null;
let uCompExposure = null;
// GLITCH_FS's uniforms. Every one of them changes on every frame a sequence is
// running, so unlike the rest of the chain there is nothing here that build()
// could set once — only the sampler binding, which it does.
let uGlitchBlocks = null;
let uGlitchShake = null;
let uGlitchResolve = null;
let uGlitchCorrupt = null;
let uGlitchSplit = null;
let uGlitchQuant = null;
let uGlitchFade = null;
let uGlitchFlash = null;
let uGlitchOrder = null;
let uGlitchTime = null;
let uGlitchSeed = null;

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

// 15e-i's feed target: FULL resolution, and NEAREST where the four above are
// LINEAR. It is a texel-for-texel stand-in for the frame texture — the bright
// pass and the composite read it exactly as they read the frame — so it wants
// the frame texture's filter mode for the frame texture's reason (see
// allocate()). Its CONTENTS never matter across frames: GLITCH_FS writes every
// pixel of it on every frame it runs, which is what makes a context restore
// mid-sequence correct on its very first frame instead of showing whatever
// survived. See gl/shaders.js's GLITCH_FS header on why there is no history
// texture here.
let feedTarget = null;

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
// rebuilds the frame texture and four of five programs but drops, say,
// quarterB, is a black screen ONLY once a frame reaches the composite stage
// with a target that never got reattached — which can survive a cursory look
// and only show up after a real driver reset. Every handle below is therefore
// listed once, in one function, with nothing built lazily on first use.
//
// 15E-I'S TWO NEW HANDLES ARE THE WORST OF THAT KIND YET, and are worth naming:
// glitchProgram and feedTarget are only ever touched while a jack-in or a death
// is on screen, so a restore that dropped either would leave a game that looks
// perfectly fine until the next time the player dies. They are listed here with
// the rest for exactly that reason, and the loss/restore path was re-verified
// by hand with WEBGL_lose_context DURING a sequence, not only at rest.
function build() {
  presentProgram = buildProgram(gl, PRESENT_VS, PRESENT_FS);
  brightProgram = buildProgram(gl, PRESENT_VS, BRIGHT_FS);
  blurProgram = buildProgram(gl, PRESENT_VS, BLUR_FS);
  compositeProgram = buildProgram(gl, PRESENT_VS, COMPOSITE_FS);
  glitchProgram = buildProgram(gl, PRESENT_VS, GLITCH_FS);
  if (!presentProgram || !brightProgram || !blurProgram || !compositeProgram ||
      !glitchProgram) return false;

  gl.useProgram(presentProgram);
  gl.uniform1i(gl.getUniformLocation(presentProgram, "uFrame"), 0);

  gl.useProgram(brightProgram);
  gl.uniform1i(gl.getUniformLocation(brightProgram, "uFrame"), 0);
  uBrightThreshold = gl.getUniformLocation(brightProgram, "uThreshold");
  uBrightTexel = gl.getUniformLocation(brightProgram, "uTexel");

  gl.useProgram(blurProgram);
  gl.uniform1i(gl.getUniformLocation(blurProgram, "uSource"), 0);
  uBlurStep = gl.getUniformLocation(blurProgram, "uStep");

  gl.useProgram(glitchProgram);
  gl.uniform1i(gl.getUniformLocation(glitchProgram, "uFrame"), 0);
  uGlitchBlocks = gl.getUniformLocation(glitchProgram, "uBlocks");
  uGlitchShake = gl.getUniformLocation(glitchProgram, "uShake");
  uGlitchResolve = gl.getUniformLocation(glitchProgram, "uResolve");
  uGlitchCorrupt = gl.getUniformLocation(glitchProgram, "uCorrupt");
  uGlitchSplit = gl.getUniformLocation(glitchProgram, "uSplit");
  uGlitchQuant = gl.getUniformLocation(glitchProgram, "uQuant");
  uGlitchFade = gl.getUniformLocation(glitchProgram, "uFade");
  uGlitchFlash = gl.getUniformLocation(glitchProgram, "uFlash");
  uGlitchOrder = gl.getUniformLocation(glitchProgram, "uOrder");
  uGlitchTime = gl.getUniformLocation(glitchProgram, "uTime");
  uGlitchSeed = gl.getUniformLocation(glitchProgram, "uSeed");

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
  feedTarget = createTarget(gl, gl.NEAREST);

  return true;
}

function teardown() {
  presentProgram = null;
  brightProgram = null;
  blurProgram = null;
  compositeProgram = null;
  glitchProgram = null;
  texture = null;
  texW = 0;
  texH = 0;
  halfA = null;
  halfB = null;
  quarterA = null;
  quarterB = null;
  feedTarget = null;
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
// of the whole frame rather than an obvious break. That argument is about the
// pass this texture is the same size as — COMPOSITE_FS, stage 7 — and it is
// why the ONE pass that reads this texture at a DIFFERENT size (the bright
// pass, into a half-res target) does its own box filtering from four NEAREST
// taps instead of asking for a filter mode here: see BRIGHT_FS's header, which
// has the measurement showing why a LINEAR fetch could not do that job. The
// four bloom targets are LINEAR on purpose too, and gl/target.js's header says
// why.
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
  // The feed target is the one that is NOT derived from the pass above it: it
  // stands in for the frame texture, so it is the frame texture's size exactly.
  resizeTarget(gl, feedTarget, w, h);
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

  // 0. THE FEED PASS (15e-i): the jack-in and the disconnect. Everything after
  // this point reads `frameTex` rather than `texture`, and when the feed is
  // idle those are the same object — so the whole rest of this function is
  // byte-for-byte what it was before this phase, with no branch of its own.
  //
  // ABOVE THE GL_PRESENT BRANCH, DELIBERATELY. That flag A/Bs BLOOM (see its
  // comment in testoptions.js); this is not bloom, it is the game's own
  // visuals, and a bloom comparison that deleted the boot and the death would
  // be useless during exactly the moments this pass exists for. So the flag
  // still removes the seven bloom draws and nothing else — the no-bloom blit
  // below just reads the feed target instead of the frame.
  //
  // BEFORE THE COMPOSITE RATHER THAN AFTER IT, and that decides the look. Run
  // after, the corruption would be sharp-edged and sitting on top of a halo
  // cast by pixels that have since moved — a displaced block leaving its own
  // glow behind. Run here, bloom reads the corrupted frame, so the halo travels
  // with the block, the freshly-arrived blocks' flare glows, and the surviving
  // fragments at the end of a death keep the neon they had. On a game whose
  // whole look is that bright things glow, corruption that does not is a
  // compositing bug.
  //
  // THE COST IS ONE FULL-RES DRAW AND ONE FULL-RES TARGET, paid only while a
  // sequence is running — see `feed.level`.
  let frameTex = texture;
  if (feed.level > 0) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, feedTarget.framebuffer);
    gl.viewport(0, 0, w, h);
    gl.useProgram(glitchProgram);
    gl.uniform2f(uGlitchBlocks, FEED_BLOCKS_X, FEED_BLOCKS_Y);
    // Logical pixels in, UV out. The playfield is LOGICAL_W x LOGICAL_H
    // whatever the backing store is doing (engine/viewport.js), so the render
    // scale cancels and the callers never have to know it exists.
    gl.uniform2f(uGlitchShake, feed.shakeX / LOGICAL_W, feed.shakeY / LOGICAL_H);
    gl.uniform1f(uGlitchResolve, feed.resolve);
    gl.uniform1f(uGlitchCorrupt, feed.corrupt);
    gl.uniform1f(uGlitchSplit, feed.split);
    gl.uniform1f(uGlitchQuant, feed.quant);
    gl.uniform1f(uGlitchFade, feed.fade);
    gl.uniform1f(uGlitchFlash, feed.flash);
    gl.uniform1f(uGlitchOrder, feed.order);
    gl.uniform1f(uGlitchTime, feed.time);
    gl.uniform1f(uGlitchSeed, feed.seed);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    frameTex = feedTarget.texture;
    // The bright pass below expects unit 0 to hold what it is about to read,
    // and this pass just left the FRAME there instead.
    gl.bindTexture(gl.TEXTURE_2D, frameTex);
  }

  // THE DEVELOPER SWITCH, off: skip bloom and blit the frame straight to the
  // drawing buffer — the 15a no-op path, kept for exactly the reason 15a built
  // it, comparing the look with and without bloom. What changed in 15d-i is
  // what "off" is being compared AGAINST: before, off meant no GPU pass at all
  // (the 2D canvas, shown directly); that machine no longer exists
  // (gl/context.js's header), so off means "this GPU pass, minus bloom" —
  // still through present, still through the upload above, just without the
  // seven-draw chain below it. See testoptions.js's own comment on GL_PRESENT.
  if (!GL_PRESENT) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, w, h);
    gl.useProgram(presentProgram);
    gl.bindTexture(gl.TEXTURE_2D, frameTex);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    return;
  }

  const hw = halfA.width, hh = halfA.height;
  const qw = quarterA.width, qh = quarterA.height;

  // 1. Bright-pass + downsample: frame -> halfA. `frameTex` is already bound at
  // unit 0 (from the upload above, or from the feed pass that just replaced
  // it), and uBrightFrame->0 was set once in build().
  //
  // uTexel is the SOURCE frame's texel size, not this target's: the four taps
  // BRIGHT_FS makes are half a FRAME texel either side of the quad corner they
  // straddle. See that shader's header for the flicker those four taps exist to
  // remove and why one tap could not.
  gl.bindFramebuffer(gl.FRAMEBUFFER, halfA.framebuffer);
  gl.viewport(0, 0, hw, hh);
  gl.useProgram(brightProgram);
  gl.uniform1f(uBrightThreshold, BLOOM_THRESHOLD);
  gl.uniform2f(uBrightTexel, 1 / w, 1 / h);
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
  gl.bindTexture(gl.TEXTURE_2D, frameTex);
  gl.activeTexture(gl.TEXTURE1);
  gl.bindTexture(gl.TEXTURE_2D, halfA.texture);
  gl.activeTexture(gl.TEXTURE2);
  gl.bindTexture(gl.TEXTURE_2D, quarterA.texture);
  gl.uniform1f(uCompExposure, BLOOM_EXPOSURE);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
}
