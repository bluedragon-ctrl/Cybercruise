// The GLSL for the present pass, as template strings.
//
// SEPARATE FROM THE CODE THAT COMPILES IT because shaders are the one thing in
// this phase that will keep growing: 15b's bright-pass, blur and recombine and
// 15e's aberration/vignette/scanlines are all fragment programs over the same
// bound texture, and they belong beside this one rather than inlined in
// whatever module happens to bind them. `gl/context.js` compiles, `present.js`
// draws, this says what is drawn.
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
// itself rendered (every target in gl/target.js). That covers five of this
// chain's six texture reads: the four blur passes and the downsample all read
// a texture written by an EARLIER pass in this same chain, at a viewport row
// 0 that is already "bottom" by the same convention this stage produces.
//
// THE ONE EXCEPTION, AND WHY THE FLIP DOES NOT LIVE HERE ANY MORE. The frame
// texture is not GPU-rendered — present.js fills it with texSubImage2D from
// the 2D canvas's pixel data, whose row 0 is the TOP of the image (ordinary
// top-down bitmap order). That is the opposite convention from every other
// texture in the chain, so reading it needs `vec2(vUv.x, 1.0 - vUv.y)` where
// every other read needs plain `vUv` — and that correction is applied in the
// two fragment stages that actually touch the frame texture (BRIGHT_FS,
// COMPOSITE_FS), not here. 15b's first draft baked the flip into this shared
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

// Bright-pass: per-channel subtractive threshold. `max(c - uThreshold, 0.0)`
// rather than a hard cutoff on luminance — it has no branch, it falls off
// smoothly instead of drawing a hard edge around whatever crosses the
// threshold, and it is what makes the pixel-identity self-test provable by
// inspection rather than by measurement: with `c` a texture fetch of an 8-bit
// frame, every channel is in [0, 1], so `uThreshold >= 1.0` forces `c -
// uThreshold <= 0.0` for every fragment and `max(..., 0.0)` is EXACTLY zero —
// no rounding, no GPU-specific transcendental, just a subtraction and a max.
// That makes this stage provably exact; see present.js's THRESHOLD SELF-TEST
// for the one stage downstream (COMPOSITE_FS's exp) that isn't provable this
// way and has to be measured instead.
//
// THE FRAME READ IS FLIPPED, `vec2(vUv.x, 1.0 - vUv.y)` rather than plain
// vUv — see PRESENT_VS's header. This is the one place in the chain the frame
// texture (the only CPU-uploaded one) is read, so this is the one place that
// correction belongs.
export const BRIGHT_FS = `#version 300 es
precision highp float;
uniform sampler2D uFrame;
uniform float uThreshold;
in vec2 vUv;
out vec4 fragColor;
void main() {
  vec3 c = texture(uFrame, vec2(vUv.x, 1.0 - vUv.y)).rgb;
  fragColor = vec4(max(c - uThreshold, 0.0), 1.0);
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
