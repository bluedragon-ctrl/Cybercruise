// A resizable render target: one texture, one framebuffer that makes it a
// draw destination. Four of these are the whole memory footprint 15b adds
// (half-res bloom x2 for the H/V ping-pong, quarter-res x2) — this module
// exists because that is four near-identical lifecycles (create, resize on
// the frame texture's own resize, die with the context) that present.js would
// otherwise repeat four times by hand, which is exactly the kind of drift
// gl/context.js's header warns about.
//
// LINEAR, ALWAYS — the frame texture (present.js) is the one texture in this
// codebase that must stay NEAREST, for the reason its own comment gives at
// length: it is sampled at the same resolution it was written, so every
// fragment centre lands on one texel and any filtering would only soften a
// copy. Every target in THIS module is sampled at a DIFFERENT resolution than
// it was written — that is the downsample and the blur both — so a NEAREST
// tap would either alias (downsample) or narrow the Gaussian to whatever one
// texel happens to fall under each sample (blur, see gl/shaders.js's BLUR_FS).
//
// RGBA8, the same format and the same texStorage2D-is-immutable trade the
// frame texture makes (present.js's `allocate` explains the trade itself).
// RGBA16F was considered for the dark-half banding a bloom accumulated in
// 8-bit could show, and deliberately not built speculatively: it is a real
// GPU capability dependency (EXT_color_buffer_float / _half_float) for a
// problem that has to be seen to be worth paying for, per the "a GPU is an
// optional accessory" rule in gl/context.js. If a later pass shows banding,
// the fallback-safe form of that change is a format argument to createTarget
// and a capability probe in present.js's build(), not a rewrite of this file.
export function createTarget(gl) {
  return { texture: null, framebuffer: gl.createFramebuffer(), width: 0, height: 0 };
}

// (Re)allocate a target's texture at w x h and reattach it to the framebuffer.
// A no-op when the size already matches — present.js calls this on every
// target, every frame, and only the frame texture's own size check (which
// gates this whole rebuild) makes that cheap.
//
// texStorage2D IS IMMUTABLE, so a resize is a new texture object rather than a
// bigger one, exactly as present.js's frame texture works — the old texture is
// deleted and framebufferTexture2D re-run to point the FBO at the new one.
export function resizeTarget(gl, target, w, h) {
  if (target.width === w && target.height === h) return;
  if (target.texture) gl.deleteTexture(target.texture);

  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, w, h);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  // Same reasoning as the frame texture's wrap mode (present.js's `allocate`):
  // one mip level, and the fullscreen triangle never samples outside [0,1],
  // but CLAMP costs nothing to state and rules out an undefined edge texel.
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

  gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
  // Guarded by a dev-facing warning rather than silently drawing into a target
  // that can't hold a colour attachment — the same call gl/context.js makes
  // for a shader that won't compile: a broken framebuffer is a bug in this
  // repository, not a property of the user's machine, and the alternative is
  // a black screen with no clue which of five targets caused it.
  const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
  if (status !== gl.FRAMEBUFFER_COMPLETE) {
    console.warn("present: bloom target incomplete, status", status);
  }

  target.texture = texture;
  target.width = w;
  target.height = h;
}
