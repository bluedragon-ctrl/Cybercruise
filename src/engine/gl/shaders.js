// The GLSL for the present pass, as template strings.
//
// SEPARATE FROM THE CODE THAT COMPILES IT because shaders are the one thing in
// this phase that will keep growing: 15b's bright-pass, blur and recombine and
// 15e's aberration/vignette/scanlines are all fragment programs over the same
// bound texture, and they belong beside this one rather than inlined in
// whatever module happens to bind them. `gl/context.js` compiles, `present.js`
// draws, this says what is drawn.
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
// vUv FLIPS Y, and that is where the 2D canvas's top-down row order is
// reconciled with GL's bottom-up framebuffer. Doing it here costs nothing: the
// alternative is UNPACK_FLIP_Y_WEBGL on the upload, which makes the driver
// flip the whole image every frame on the hot path this phase exists to price.
export const PRESENT_VS = `#version 300 es
out vec2 vUv;
void main() {
  float x = float((gl_VertexID & 1) << 1);
  float y = float(gl_VertexID & 2);
  vUv = vec2(x, 1.0 - y);
  gl_Position = vec4(x * 2.0 - 1.0, y * 2.0 - 1.0, 0.0, 1.0);
}`;

// The blit. One texture fetch, straight out.
//
// 15a SHIPS A NO-OP ON PURPOSE (README, Phase 15a): with the texture the same
// size as the drawing buffer, NEAREST filtering and no colour conversion on
// upload, every fragment centre lands exactly on one texel and the frame that
// arrives on screen is the frame Canvas2D drew, bit for bit. Anything added
// here — a threshold, a curve, a dither — stops that being checkable, which is
// the one property that makes 15b's bloom debuggable when it regresses.
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
