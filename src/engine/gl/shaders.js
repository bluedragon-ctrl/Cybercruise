// The GLSL for the present pass, as template strings.
//
// SEPARATE FROM THE CODE THAT COMPILES IT because shaders are the one thing in
// this phase that will keep growing: 15b's bright-pass, blur and recombine and
// 15e-i's feed pass are all fragment programs over the same bound texture, and
// they belong beside this one rather than inlined in whatever module happens to
// bind them. `gl/context.js` compiles, `present.js` draws, this says what is
// drawn.
//
// 15E WAS PENCILLED IN AS "aberration/vignette/scanlines" AND IS NOT THAT.
// Those are CRT-simulation terms — a screen being photographed — and the
// project owner rejected that reading outright. What 15e-i actually adds is
// GLITCH_FS at the bottom of this file, in the DATA vocabulary the game's own
// fiction is written in; its header has the argument.
//
// 15b ADDS FOUR STAGES: BRIGHT_FS (threshold), BLUR_FS (one separable Gaussian
// pass, reused four times — H and V at half-res, H and V at quarter-res), and
// COMPOSITE_FS (recombine with a tone knee). PRESENT_FS keeps its 15a job too:
// the half-to-quarter downsample is a plain texture fetch into a smaller
// target, which is exactly what PRESENT_FS already does, so present.js reuses
// it there rather than adding a fifth, identical shader.
//
// THESE CONSTANTS ARE PROVISIONAL. 15b ships the chain; 15d re-tunes
// `neonStroke`'s halo against whatever bloom does to it and owns the final
// threshold, blur radius and knee numbers (see the Phase 15b entry in
// README.md). Nothing here should be read as a settled look.
//
// Template strings and nothing else — the project has no build step, so there
// is no #include, no minifier and no preprocessor beyond GLSL's own. See
// CLAUDE.md.
//
// GLSL ES 3.00 (`#version 300 es`, which MUST be the first line of the source
// with no leading newline), because the context is WebGL2 and `gl_VertexID` is
// the whole reason the vertex stage below needs no buffers at all.

// The fullscreen pass, drawn as ONE triangle from three vertex IDs.
//
// No vertex buffer, no attributes, no VAO state: `gl.drawArrays(TRIANGLES, 0, 3)`
// runs this three times and it derives its own corners. That is not cleverness
// for its own sake — it removes every piece of per-frame or per-resize buffer
// state the present path would otherwise own, which is state that could go
// stale on a context loss and be wrong in a way that shows as a black screen.
//
// A TRIANGLE, NOT A QUAD. The three corners are (-1,-1), (3,-1), (-1,3), so the
// triangle covers the whole clip volume and is scissored down to it. A quad is
// two triangles meeting on a diagonal, and the fragments along that seam are
// rasterised by both — a quad pays for a screen's diagonal twice and can show a
// seam under any pass that is not an exact copy. Nothing is saved by it.
//
// vUv is the PLAIN, UNFLIPPED mapping: v=0 at the bottom of the destination,
// v=1 at the top — the natural result of interpolating this triangle's own
// corners, and the right one for every stage that samples a texture the GPU
// itself rendered (every target in gl/target.js). That covers the four blur
// passes and the downsample, which all read a texture written by an EARLIER
// pass in this same chain, at a viewport row 0 that is already "bottom" by the
// same convention this stage produces.
//
// THE EXCEPTION, AND WHY THE FLIP DOES NOT LIVE HERE ANY MORE. The frame
// texture is not GPU-rendered — present.js fills it with texSubImage2D from
// the 2D canvas's pixel data, whose row 0 is the TOP of the image (ordinary
// top-down bitmap order). That is the opposite convention from every other
// texture in the chain, so reading it needs `vec2(vUv.x, 1.0 - vUv.y)` where
// every other read needs plain `vUv` — and that correction is applied in the
// fragment stages that actually DISPLAY it (BRIGHT_FS, COMPOSITE_FS), not here.
//
// GLITCH_FS (15e-i) READS THE FRAME TEXTURE AND DOES NOT FLIP IT, which is not
// a third case so much as the absence of one: it does not display the frame, it
// REWRITES it, and it writes its target in the same row order it read. Nothing
// downstream can tell the two textures apart, so BRIGHT_FS and COMPOSITE_FS
// keep flipping exactly as they did and needed no edit. The cost is that
// GLITCH_FS's own vertical terms are in the frame's convention (v=0 is the
// image's top) rather than the screen's; that is stated once, at the top of its
// main(). 15b's first draft baked the flip into this shared
// vertex stage instead, on the (wrong) assumption that "the one flip 15a
// needed" was a property of the pipeline rather than of one specific texture's
// upload path — every FBO-to-FBO pass then flipped a second time, and bloom
// rendered upside down relative to what cast it. Keeping the flip OUT of the
// vertex stage and only in the two places that read the CPU-uploaded texture
// is what makes that failure mode structural rather than a constant to get
// right by trial and error.
export const PRESENT_VS = `#version 300 es
out vec2 vUv;
void main() {
  float x = float((gl_VertexID & 1) << 1);
  float y = float(gl_VertexID & 2);
  vUv = vec2(x, y);
  gl_Position = vec4(x * 2.0 - 1.0, y * 2.0 - 1.0, 0.0, 1.0);
}`;

// The blit. One texture fetch, straight out.
//
// 15a SHIPPED THIS AS THE WHOLE PASS, ON PURPOSE (README, Phase 15a): with the
// texture the same size as the drawing buffer, NEAREST filtering and no colour
// conversion on upload, every fragment centre lands exactly on one texel and
// the frame that arrives on screen is the frame Canvas2D drew, bit for bit.
// That pixel-identity property still exists in 15b — see COMPOSITE_FS below —
// it just no longer lives in THIS shader being the last one drawn.
//
// 15b KEEPS THIS SHADER FOR THE HALF-TO-QUARTER DOWNSAMPLE: present.js binds
// it with a smaller target and a smaller (LINEAR) source, and a plain fetch at
// the destination's texel centres IS the downsample — see present.js's chain
// comment for why that single tap is a correct box filter and not a shortcut.
//
// A PLAIN, UNFLIPPED FETCH IS CORRECT HERE, and that is a change from 15a
// rather than an oversight: this shader's one job in the chain is reading
// halfA, a GPU-rendered target — see PRESENT_VS's header for why that texture
// wants vUv exactly as the vertex stage produces it, with no flip, and why the
// flip this shader used to rely on lives elsewhere now.
//
// mediump would be enough for a copy of 8-bit colour, and is deliberately not
// used: this shader is the base every later pass is edited out of, and a bloom
// chain accumulating in mediump bands visibly in the dark half of a frame that
// is mostly dark.
export const PRESENT_FS = `#version 300 es
precision highp float;
uniform sampler2D uFrame;
in vec2 vUv;
out vec4 fragColor;
void main() {
  fragColor = texture(uFrame, vUv);
}`;

// Bright-pass: per-channel subtractive threshold, softened at the knee as of
// Phase 15e-ii-a (see softKnee below) — it has no branch, it falls off
// smoothly instead of drawing a hard edge around whatever crosses the
// threshold, and it is what makes the pixel-identity self-test provable by
// inspection rather than by measurement: with `c` a texture fetch of an 8-bit
// frame, every channel is in [0, 1], so `uThreshold >= 1.0` forces `c -
// uThreshold <= 0.0` for every fragment and softKnee(c, uThreshold, ...) is
// EXACTLY zero — no rounding, no GPU-specific transcendental, just a
// subtraction and two clamps. That makes this stage provably exact; see
// present.js's THRESHOLD SELF-TEST for the one stage downstream (COMPOSITE_FS's
// exp) that isn't provable this way and has to be measured instead.
//
// THE FRAME READ IS FLIPPED, `vec2(vUv.x, 1.0 - vUv.y)` rather than plain
// vUv — see PRESENT_VS's header. This is the one place in the chain the frame
// texture (the only CPU-uploaded one) is read, so this is the one place that
// correction belongs.
//
// --- FOUR TAPS, THRESHOLDED INDIVIDUALLY, THEN AVERAGED ----------------------
//
// This pass renders the full-res frame into a HALF-res target, so it is a
// downsample as well as a threshold, and how it samples is not a quality
// preference — it decides whether THIN BRIGHT HORIZONTAL FEATURES FLICKER as
// the world scrolls under them.
//
// THE BUG THIS REPLACED. One tap, NEAREST: a destination texel centre at
// v = (i + 0.5) / (h/2) maps to source row h - (2i + 1) — always ODD. The
// bright pass therefore sampled only the frame's odd rows, and half the rows
// in the image contributed no bloom at all. A one-device-pixel horizontal line
// — a building's roof outline (game/buildingshapes.js) is exactly that, and
// BUILDING_EDGE's green channel is 1.0, far over the threshold — alternated
// between "haloed" and "no halo whatsoever" as the floor scrolled it across
// row parities, at up to 30Hz. MEASURED, on a 64x64 probe with a single such
// line: total green 16320 (the bare core, zero bloom) on an even row against
// 65792 on an odd one. The core stays put either way, since COMPOSITE_FS reads
// the frame at full resolution, so it reads as the EDGE FLICKERING rather than
// anything vanishing. Only HORIZONTAL features showed it, because only y
// scrolls — the city floor's columns are fixed in screen x (game/citygrid.js).
//
// ANTI-ALIASING DOES NOT SAVE A SOFT LINE FROM IT, which is what makes this
// general rather than a buildings bug: the subtractive threshold below clips a
// 1.5px stroke's ~25%-alpha skirt to exactly zero and hands the pass back a
// single full-alpha row, so entities drawn at fractional screen y (obstacles,
// pickups, traffic) get the same modulation as a shimmer.
//
// WHY FOUR TAPS AND NOT A LINEAR FETCH. A destination texel centre maps to
// source coordinate exactly 2i + 1.0 — the corner where four texels meet — so
// a single bilinear tap there IS their 25/25/25/25 average, parity-invariant
// for free and with no extra fetch. That was tried first (a WebGL2 sampler
// object overriding the frame texture's NEAREST for this pass alone) and
// REJECTED ON MEASUREMENT: averaging BEFORE the threshold gives a 1px line a
// pre-threshold value of exactly 0.5, which is below BLOOM_THRESHOLD's 0.55,
// so every thin bright line lost its halo outright — the same probe read 16320
// on every row, flicker gone because the bloom was gone. Thresholding each tap
// FIRST is what keeps a thin line's own brightness intact through the average,
// and it cannot be expressed as a filter mode.
//
// PARITY-INVARIANT BY CONSTRUCTION, not by tuning: the four taps are the four
// source texels of one 2x2 quad, so a 1px horizontal line lights exactly two
// of them whichever row of the quad it occupies. The result is the same number
// either way — the flicker is removed, not reduced.
//
// THE COST IS HALF THE PEAK: 0.225 where an odd row used to give 0.45. That is
// the arithmetic mean of what the frame used to alternate between, so a scene's
// halo lands where the eye was already integrating it to; BLOOM_EXPOSURE was
// re-checked against this and left at 4.0.
//
// `uTexel` is the SOURCE's texel size (present.js sets it from the frame
// texture, not from this pass's own half-res target), so the half-texel offsets
// below land on the four texel centres flanking the quad corner. The taps are
// symmetric about that corner, so the frame's y-flip does not change which four
// texels they are and needs no sign care.
//
// --- THE SOFT KNEE (Phase 15e-ii-a) -----------------------------------------
//
// THE PROBLEM THIS ANSWERS. glow/core ratio is `1 - uThreshold/(alpha*c)` for
// a stroke fading through `alpha`, which hits exactly zero the instant
// `alpha*c` crosses `uThreshold` from above — a full-saturation colour (`c`
// == 1) loses its ENTIRE halo the moment `alpha` drops under `uThreshold`
// (0.55 today), with the bare core still visibly fading for the rest of its
// life. `engine/neon.js`'s header has the full derivation and the fade
// options weighed against it; this is the one chosen for the baseline: soften
// the APPROACH into that zero so it is not a sudden derivative kink, without
// trying to make the ratio proportional (which would need a threshold-free
// pass, and would bloom the background — see neon.js). A softer knee does NOT
// move the point where output reaches zero — see WHY IT SITS ABOVE uThreshold,
// NOT ACROSS IT below — so a fragment still goes bloomless at exactly the same
// alpha it did before. What changes is that the last sliver of glow above that
// point now fades IN gently (quadratic) rather than snapping to full linear
// contribution the instant it clears the line, which is what removes the
// visible "pop" at the edge of the halo without touching where the edge is.
//
//   d = c - uThreshold
//   d <= 0                -> 0                    (unchanged: below threshold)
//   0 < d <= BLOOM_KNEE     -> d*d / (2*BLOOM_KNEE)  (soft ramp)
//   d > BLOOM_KNEE          -> d - BLOOM_KNEE/2      (old linear shape, shifted
//                                                     down by BLOOM_KNEE/2 so it
//                                                     meets the quadratic term
//                                                     continuously in VALUE and
//                                                     SLOPE at d == BLOOM_KNEE)
//
// WHY IT SITS ABOVE uThreshold, NOT ACROSS IT — THE SELF-TEST DEMANDS IT. The
// usual "soft threshold" shape (Unreal/Frostbite-style bloom) straddles the
// cutoff: it starts ramping in BELOW the nominal threshold and reaches the old
// linear shape somewhat above it, which is a strictly SOFTER floor, not just a
// softer approach — a few pixels get a little bloom that used to get none. That
// shape cannot pass this file's own self-test: `uThreshold >= 1.0` has to force
// EVERY fragment to contribute exactly zero (present.js's THRESHOLD SELF-TEST),
// and a floor sitting BELOW uThreshold would let some fragment at `c` close to
// 1.0 leak through even with the threshold forced to 1.0 — a straddling knee
// widened just enough to be visible is a knee widened just enough to break
// provability. Anchoring the WHOLE soft region at `d = c - uThreshold >= 0`
// keeps `d <= 0` (hence output exactly 0) for every channel whenever
// `uThreshold >= 1.0`, for ANY BLOOM_KNEE > 0 — the proof does not depend on
// how wide the knee is, only on where its floor sits.
//
// BLOOM_KNEE = 0.08, chosen so the softened region (uThreshold to uThreshold +
// 0.08, i.e. roughly 0.55-0.63 today) covers a visible slice of a typical
// alpha fade without eating deeply into the headroom that drives full-strength
// bloom. THE COST: a fully saturated channel (c == 1, threshold 0.55) used to
// contribute 0.45 to the sum below; now it contributes 0.45 - 0.08/2 = 0.41, a
// flat ~9% reduction for every channel at or above uThreshold + BLOOM_KNEE
// (0.63) — see present.js for BLOOM_EXPOSURE's retune against that. The
// function itself is defined once, inside the shader source below.
//
// THE PIXEL-IDENTITY SELF-TEST SURVIVES UNCHANGED: with uThreshold >= 1.0 every
// `d` above is <= 0 for every channel of every tap, so softKnee is exactly zero
// before anything is summed and the proof above still holds by inspection —
// see softKnee's own header for why that holds for any BLOOM_KNEE.
//
// 15C-I'S PARITY ARGUMENT IS UNCHANGED TOO, and does not depend on what
// function is applied per tap: it only requires the four taps to be the same
// four source texels regardless of which row of the quad a 1px line lands on,
// and to have IDENTICAL treatment (same threshold, same knee) applied to each
// before they are summed. softKnee is applied per tap, before the sum, exactly
// where max(c - uThreshold, 0.0) was — so a 1px line still lights exactly two
// of the four taps whichever row of its quad it occupies, and the combined
// output is the same either way. Re-run at BLOOM_KNEE = 0.08, BLOOM_THRESHOLD
// 0.55: a full-value channel (c = 1) landing on 2 of 4 taps gives
// (0.41 + 0.41 + 0 + 0) * 0.25 = 0.205 flat at every row parity (was 0.225
// under the old linear subtraction) — still one number regardless of which
// physical row the line falls on, only the number itself moved with the knee.
export const BRIGHT_FS = `#version 300 es
precision highp float;
uniform sampler2D uFrame;
uniform float uThreshold;
uniform vec2 uTexel;
in vec2 vUv;
out vec4 fragColor;

vec3 softKnee(vec3 c, float threshold, float knee) {
  vec3 d = c - threshold;
  vec3 t = clamp(d, 0.0, knee);
  return t * t / (2.0 * knee) + max(d - knee, 0.0);
}

void main() {
  vec2 uv = vec2(vUv.x, 1.0 - vUv.y);
  vec2 o = uTexel * 0.5;
  const float knee = 0.08;
  vec3 c = softKnee(texture(uFrame, uv + vec2(-o.x, -o.y)).rgb, uThreshold, knee)
         + softKnee(texture(uFrame, uv + vec2( o.x, -o.y)).rgb, uThreshold, knee)
         + softKnee(texture(uFrame, uv + vec2(-o.x,  o.y)).rgb, uThreshold, knee)
         + softKnee(texture(uFrame, uv + vec2( o.x,  o.y)).rgb, uThreshold, knee);
  fragColor = vec4(c * 0.25, 1.0);
}`;

// One separable Gaussian pass. present.js runs it four times a frame — H then
// V at half-res, H then V at quarter-res — with `uStep` carrying both the
// direction and the source's texel size, so the shader itself does not know
// which axis or which resolution it is blurring.
//
// FIVE TAPS, NOT NINE. The weights and offsets are the published trick for
// folding a 9-tap Gaussian into 5 by sampling at the bilinear-weighted
// midpoint of each symmetric pair instead of the two texels separately — one
// LINEAR fetch there returns the weighted sum of both for the price of one tap.
// It only works because the source targets are LINEAR (gl/target.js); it would
// silently degrade to a narrower, wrong-weighted kernel on a NEAREST source,
// which is one more reason the frame texture itself is never blurred directly.
// Weights: 0.2270270270 (center), 0.3162162162 x2, 0.0702702703 x2 — they sum
// to 1.0, so a uniform input blurs to itself with no energy loss. Offsets:
// 0, 1.3846153846, 3.2307692308 texels.
export const BLUR_FS = `#version 300 es
precision highp float;
uniform sampler2D uSource;
uniform vec2 uStep;
in vec2 vUv;
out vec4 fragColor;
void main() {
  vec4 sum = texture(uSource, vUv) * 0.2270270270;
  sum += texture(uSource, vUv + uStep * 1.3846153846) * 0.3162162162;
  sum += texture(uSource, vUv - uStep * 1.3846153846) * 0.3162162162;
  sum += texture(uSource, vUv + uStep * 3.2307692308) * 0.0702702703;
  sum += texture(uSource, vUv - uStep * 3.2307692308) * 0.0702702703;
  fragColor = sum;
}`;

// The last stage: frame plus bloom, tone-knee'd, to the drawing buffer.
//
// THE KNEE IS APPLIED TO THE BLOOM TERM, NOT TO THE SUM. A tone-mapped whole
// scene (`1 - exp(-(frame + bloom))`) is the more usual shape of this pass,
// and was rejected here for a specific reason: it would recompress the FRAME
// too, which breaks pixel-identity the moment bloom is zero — `knee(frame) !=
// frame` for any frame pixel above black, so the threshold self-test could
// never pass no matter how the threshold were set. Applying the knee to bloom
// alone (`frame + (1 - exp(-bloom * uExposure))`) fixes the value at bloom==0
// to EXACTLY 0 (`exp(0) == 1` is not an approximation, it's the identity every
// transcendental implementation is built around), which is what keeps this
// provable rather than merely tuned to look right. The clamp at the end is for
// the case bloom pushes a channel over 1.0, which is the point of the knee in
// the first place: it compresses the ADDED light instead of hard-clipping the
// sum, so a near-white core gains a smooth halo instead of a flat white disc.
//
// uExposure and the half/quarter mix are provisional (see the file header).
//
// TWO DIFFERENT UV READS, AND THAT IS DELIBERATE, NOT A COPY-PASTE SLIP: uFrame
// is the CPU-uploaded frame texture and needs the flip (PRESENT_VS's header);
// uBloomHalf and uBloomQuarter are GPU-rendered chain output and must NOT get
// it, or the bloom lands mirrored against the frame it was cast from — which
// is exactly the bug this split was written to stop being possible again.
export const COMPOSITE_FS = `#version 300 es
precision highp float;
uniform sampler2D uFrame;
uniform sampler2D uBloomHalf;
uniform sampler2D uBloomQuarter;
uniform float uExposure;
in vec2 vUv;
out vec4 fragColor;
void main() {
  vec3 frame = texture(uFrame, vec2(vUv.x, 1.0 - vUv.y)).rgb;
  vec3 bloom = texture(uBloomHalf, vUv).rgb * 0.55 + texture(uBloomQuarter, vUv).rgb * 0.45;
  vec3 knee = 1.0 - exp(-bloom * uExposure);
  fragColor = vec4(clamp(frame + knee, 0.0, 1.0), 1.0);
}`;

// --- The feed pass (Phase 15e-i) --------------------------------------------
//
// THE JACK-IN AND THE DISCONNECT, both of them, as one fragment stage. Through
// Phase 15d these were Canvas2D: game/jackin.js masked, tore and channel-split
// the frame by drawing it back onto itself, and game/disconnect.js swept and
// dimmed it. What they were both reaching for is per-pixel work a 2D context
// cannot do, and this is it.
//
// THE FICTION, which is the whole reason the vocabulary is what it is. The game
// is a signal the player is jacked into (engine/neon.js): the car is not an
// object, it is data arriving. So the two sequences are the two ends of ONE
// connection — a feed resolving and a feed collapsing — and what they are made
// of is the DATA vocabulary: packet arrival, block loss, line dropout,
// reordering, channel desync, bandwidth collapse. It is explicitly NOT a screen
// being photographed: no phosphor, no barrel distortion, no standing scanline
// overlay, no vignette-as-tube-falloff. Those were considered and REJECTED by
// the project owner, deliberately, and they are not a subtle touch worth
// sneaking back in later.
//
// ONE MECHANISM, RUN BOTH WAYS. The screen is a grid of macroblocks; each block
// draws an ARRIVAL TIME, and `uResolve` is a frontier through that field. Ramp
// it UP and the feed arrives block by block; ramp it DOWN and the feed drains
// through the same order. That is the thing both modules' headers have always
// CLAIMED about each other ("run BACKWARDS", "the exact inverse") and never
// actually shared an implementation of. `uOrder` is how ordered that field is:
// the boot scans in as a wavefront, the death fails in scattered patches, off
// one field rather than two mechanisms.
//
// WHAT EACH TERM REPLACES, so the old look can be found from the new one:
//
//   uResolve   jackin's VOID mask below the sweep line, and disconnect's own
//              collapse. A ragged block frontier rather than a rectangle with
//              a drawn line on its edge.
//   uCorrupt   jackin's band-tear loop (blitScreenBand) and its scanline wash,
//              and disconnect's full-width scanline tears.
//   uSplit     jackin's whole-scene chromatic split — which was two tinted
//              full-frame copies at ONE global offset. Here each block ROW
//              disagrees by its own amount, in its own direction, and most
//              rows not at all: bands of desync rather than a lens fringe.
//   uQuant     new, and the term that carries the collapse. Nothing in the 2D
//              path could do it at all.
//   uFade      disconnect's dim toward black (its DESAT_MAX).
//   uFlash     jackin's hand-over flash. In here rather than left as a 2D
//              fillRect because it has to whiten what THIS pass produced, not
//              the frame that went into it.
//   uShake     disconnect's shake(), which main.js used to apply as a whole-
//              scene ctx.translate. A UV offset composes with everything above,
//              cannot reach the HUD layer by construction, and on a NEAREST
//              frame texture is quantised to whole device pixels for free —
//              which is the camera rule the README states, enforced by the
//              sampler instead of by discipline.
//
// THE CAR HAS NO STAGE OF ITS OWN AT EITHER END, as of 15e-i. jackin.js
// assembled it out of three offset wireframe copies and disconnect.js pulled it
// apart the same way (game/effects.js's drawChromaticSplit, deleted along with
// both call sites). Under this pass neither reads: a wireframe easing together
// inside a block-corrupted feed is mush, and a hole opened around the car reads
// as a cutout rather than as data loss — that second one was built, looked at
// and rejected on sight. The car now resolves and fails with the rest of the
// frame, which is the more honest version of the fiction anyway: the car is not
// a special object, it is part of the signal.
//
// A PURE FUNCTION OF ITS UNIFORMS. No history texture, no feedback, nothing
// carried between frames — the animated jitter is reseeded from `uTime` the
// same way jackin.js and disconnect.js already reseed theirs from `elapsed`
// (their shared "a pure function of progress" note). A feedback texture WAS the
// obvious way to get real persistence and is rejected for a specific reason: it
// would make a render target's CONTENTS matter across frames, and target
// contents are the one thing present.js's build() cannot restore after a
// context loss. As written, the first frame after a restore mid-sequence is
// simply correct.
//
// IDLE COSTS NOTHING BECAUSE IT IS NOT DRAWN — present() skips this pass
// entirely when the feed is at rest, rather than running it with zeroed
// uniforms (see present.js's `feed`). The identity below is still worth having,
// because it makes that skip an optimisation rather than a correctness
// requirement: at uQuant 0 `levels` is exactly 255.0, so `floor(c * 255 + 0.5)
// / 255` is the identity for any channel of an 8-bit source, and every other
// term is multiplied or added by zero.
export const GLITCH_FS = `#version 300 es
precision highp float;
uniform sampler2D uFrame;
uniform vec2  uBlocks;
uniform vec2  uShake;
uniform float uResolve;
uniform float uCorrupt;
uniform float uSplit;
uniform float uQuant;
uniform float uFade;
uniform float uFlash;
uniform float uOrder;
uniform float uTime;
uniform float uSeed;
in vec2 vUv;
out vec4 fragColor;

// Enough hash for a per-block draw that does not repeat across the grid. Not a
// quality generator and does not need to be — game/effects.js's rng() has the
// same job on the CPU side and is held to the same standard.
//
// EVERY CALLER PASSES SMALL NUMBERS INTO THIS, and that is load-bearing. The
// arguments are block indices (0..32) plus uSeed and a frame counter; highp is
// 32-bit, so an addend over 2^24 would round the block index away and hand
// every block the same value. uSeed is therefore a fraction in [0, 1) rather
// than the caller's raw seed — see present.js's feed, which has the bug this
// prevents and how it was found.
float hash(vec2 p) {
  p = fract(p * vec2(443.897, 441.423));
  p += dot(p, p + 19.19);
  return fract((p.x + p.y) * p.x);
}

// How far past each end of the arrival field the frontier runs — see its use
// below. Must exceed FLARE_WIDTH.
const float FRONT_MARGIN = 0.06;
// Half-width of the hot band about the frontier, in arrival-time units.
const float FLARE_WIDTH = 0.04;

void main() {
  // vUv IS FRAME-TEXTURE SPACE, NOT SCREEN SPACE: v = 0 is the image's TOP row,
  // because the frame texture is the one CPU-uploaded (top-down) texture in the
  // chain — see PRESENT_VS's header. Every vertical term below reads that way.
  // This pass writes its target with the SAME convention it read, so the target
  // is a texel-for-texel stand-in for the frame texture and the downstream flip
  // in BRIGHT_FS and COMPOSITE_FS is still exactly right, unedited. That is
  // deliberate: 15b's mirrored-bloom bug came from moving a flip, and the
  // version of this pass with zero downstream edits cannot reintroduce it.
  vec2  blk    = floor(vUv * uBlocks);
  float step30 = floor(uTime * 30.0);

  // ARRIVAL ORDER. uOrder 0 is a pure top-to-bottom wavefront (the boot's own
  // sweep, ragged at block granularity); 1 is no order at all (a feed failing
  // in patches). One field, both directions.
  float spread  = mix(0.22, 1.0, uOrder);
  float arriveT = vUv.y * (1.0 - spread) + hash(blk + uSeed) * spread;

  // THE FRONTIER TRAVELS PAST BOTH ENDS OF THE FIELD, and the margin is not
  // cosmetic. arriveT lands in [0, 1], so a caller's uResolve of exactly 1
  // parks the frontier ON the last blocks rather than beyond them — and the
  // flare below, which is a band about the frontier, would then light that last
  // block row FOREVER. Found by the pixel-identity self-test (README, "The present path"): with every feed field at rest the pass came back 10,975
  // bytes off a byte-identical frame, all of them in the bottom block row. Live
  // that is a permanently brightened strip along the bottom of the screen from
  // SWEEP_END to the end of every jack-in. FRONT_MARGIN is wider than the
  // flare's own half-width (0.040) so both ends clear it completely.
  float front = uResolve * (1.0 + 2.0 * FRONT_MARGIN) - FRONT_MARGIN;

  float live = step(arriveT, front);
  // The frontier itself. A block whose state has just changed runs hot for a
  // moment, so the leading edge is the SHAPE OF THE ARRIVAL rather than a line
  // drawn over it — which is what jackin.js's three glowLine calls were for.
  float edge = smoothstep(FLARE_WIDTH, 0.0, abs(arriveT - front));

  // REORDERING. A fraction of block ROWS slide sideways, and the offset is
  // floored to whole blocks — that is what makes it read as packets arriving
  // out of order rather than as a smear. A smaller fraction of rows lose their
  // data outright and repeat the last good line instead.
  float rowSel = hash(vec2(7.1, blk.y) + step30 + uSeed);
  float torn   = step(1.0 - uCorrupt * 0.45, rowSel);
  float amt    = hash(vec2(blk.y, 3.7) + step30 + uSeed) * 2.0 - 1.0;
  float dx     = floor(torn * amt * uCorrupt * 0.16 * uBlocks.x) / uBlocks.x;

  float dropSel = hash(vec2(blk.y, 11.3) + floor(uTime * 31.0) + uSeed);
  float held    = step(1.0 - uCorrupt * 0.20, dropSel);

  vec2 uv = vUv + uShake + vec2(dx, 0.0);
  uv.y = mix(uv.y, (blk.y + 0.02) / uBlocks.y, held);

  // CHANNEL DESYNC. Only SOME block rows disagree (the step(0.40, ...) leaves
  // most of them alone), each by its own amount and in its own direction. One
  // global offset applied to the whole frame is what the 2D path did, and it
  // reads as a lens; per-row is what reads as data.
  float bandSel = hash(vec2(blk.y, 5.9) + uSeed);
  float band    = (hash(vec2(blk.y, 2.3) + uSeed) * 2.0 - 1.0) * step(0.40, bandSel);
  vec2  s       = vec2(band * uSplit * 0.018, 0.0);
  vec3 c = vec3(
    texture(uFrame, uv + s).r,
    texture(uFrame, uv).g,
    texture(uFrame, uv - s).b
  );

  // BANDWIDTH. Geometric from 255 levels down to 2, because everything the eye
  // reads in a collapse happens in the last few levels — a linear ramp spends
  // most of its travel between 255 and 60, where nothing is visible. 255
  // EXACTLY at uQuant 0, which is what makes this stage the identity for an
  // 8-bit source (see the header's note on idle).
  float levels = 255.0 * pow(2.0 / 255.0, uQuant);
  c = floor(c * levels + 0.5) / levels;

  c *= live;
  c *= 1.0 - uFade;
  c += edge * vec3(0.55, 0.90, 0.68) * (0.40 + 0.60 * uCorrupt);
  c += uFlash;
  fragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
}`;
