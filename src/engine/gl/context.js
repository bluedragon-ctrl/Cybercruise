// WebGL2 acquisition, context-loss wiring, and shader compilation — the whole
// of what this project knows about setting up a GPU, and none of what it draws
// with one (that is `engine/present.js`).
//
// THE DECISION THIS FILE EMBODIES, AS OF PHASE 15D-I: WebGL2 is REQUIRED. A
// machine without it is told it cannot run the game rather than being handed a
// haloless version of one, and a context lost mid-run pauses the game rather
// than dropping back to something lesser. present.js owns the whole of that
// answer — the message, the pause, the resume — and nothing under src/game/
// ever finds out either way.
//
// THIS REVERSES THE ORIGINAL DECISION, and per CLAUDE.md that reasoning is kept
// rather than deleted. Through Phase 15a-15c, a GPU was genuinely an OPTIONAL
// accessory: this module never threw, present.js funnelled every failure —
// missing WebGL2, a lost context — into one `live` flag, and false meant the
// 2D canvas, which was a complete game (README, Phase 15a). That was real and
// it cost nothing to keep, because the 2D layer was doing all the actual
// drawing regardless of whether the GPU pass ran: 15a's chain was a no-op
// blit, and 15b's bloom was laid OVER a look (`neonStroke`'s three-pass
// overdraw) that already stood on its own.
//
// WHAT ENDS IT is Phase 15d-ii's collapse of `neonStroke` from three strokes to
// one — the three-pass overdraw exists only because `shadowBlur` was
// unaffordable (present.js's header carries the numbers), and once bloom does
// the halo per pixel that collapses. Past that point the Canvas2D frame ALONE
// is not the shipped look; it is a thinner one bloom was always going to
// finish. Keeping the fallback across that change would mean maintaining TWO
// looks forever — the one-stroke art plus bloom that ships, and a three-stroke
// path frozen in place for whichever fraction of machines has neither WebGL2
// nor anyone testing on them. 15d-i makes the substrate change first, with
// `neonStroke` untouched, so a regression during the switch has one possible
// cause; 15d-ii is the sub-phase that actually thins the strokes.
//
// CONTEXT LOSS IS STILL NOT A HYPOTHETICAL — if anything it matters more now
// that there is nothing to fall back to. A driver reset, a GPU switch on a
// laptop, too many live contexts in one browser, or the machine coming back
// from sleep all take the context away with no warning. The default browser
// behaviour on `webglcontextlost` is to give up permanently unless the event
// is preventDefault()ed, which is why that call is here and not left to a
// caller who might forget it: without it `webglcontextrestored` never fires
// and the game would spend the rest of the session on a dead canvas — now with
// no 2D canvas behind it to show instead. Hence this module still NEVER
// throws: it returns null, or it reports a loss through a callback, and the
// caller (present.js) has exactly one branch either way — show the failure,
// don't guess at a degraded frame.
//
// EVERY GL OBJECT DIES WITH THE CONTEXT. Programs, textures and their contents
// are all gone after a loss, and the handles left pointing at them are invalid
// rather than merely empty. `onRestored` therefore means "build it all again",
// not "carry on" — see present.js's `build()`, which is written to be run any
// number of times for exactly this reason.

// Context attributes, each of which is a decision:
//
//   alpha: false            The frame is opaque (neon.js's clear paints an
//                           opaque background over the whole playfield). An
//                           alpha channel would ask the compositor to blend the
//                           canvas against the page every frame for nothing.
//   depth/stencil: false    A fullscreen blit has no geometry to sort. Both
//                           default to on and both allocate a buffer the size
//                           of the drawing buffer — at 1200x1600 that is real
//                           memory on the integrated GPUs MAX_SCALE is written
//                           for (engine/viewport.js).
//   antialias: false        There is one triangle and its edges are off-screen.
//                           MSAA here would multisample the entire frame to
//                           resolve nothing, and a resolve is not free.
//   preserveDrawingBuffer   Left false (the default). The pass writes every
//                           pixel of the frame every frame, so keeping the
//                           previous contents is a copy nobody reads.
//   desynchronized: false   Deliberate, and the tempting one to switch on. It
//                           lets the canvas skip a compositor round trip, at
//                           the cost of tearing — and the number Phase 15a
//                           exists to obtain is the DROPPED-FRAME COUNT UNDER
//                           THE COMPOSITOR. Measuring that against a canvas
//                           that has opted out of the compositor would measure
//                           something else.
const ATTRS = {
  alpha: false,
  depth: false,
  stencil: false,
  antialias: false,
  premultipliedAlpha: false,
  preserveDrawingBuffer: false,
  desynchronized: false,
};

// Acquire a WebGL2 context on `canvas`, or return null if this browser has
// none. `onLost` fires when the context goes away (the caller must stop using
// every handle it holds), `onRestored` when it comes back (the caller must
// rebuild them).
//
// Only "webgl2" is ever asked for. There is no WebGL1 path and there will not
// be one: the shaders are GLSL ES 3.00 and the upload uses texStorage2D, both
// WebGL2-only, and a second code path maintained for a browser generation that
// no longer exists would be more likely to break than the fallback it exists to
// avoid — and the fallback is a complete game.
export function createContext(canvas, { onLost, onRestored } = {}) {
  let gl = null;
  try {
    gl = canvas.getContext("webgl2", ATTRS);
  } catch (e) {
    // getContext is specified to return null rather than throw, but a driver
    // blocklist hitting at exactly the wrong moment has been seen to throw in
    // the wild. A throw here must be indistinguishable from "no WebGL2".
    gl = null;
  }
  if (!gl) return null;

  canvas.addEventListener("webglcontextlost", (e) => {
    // See the header: without this the context is never restored.
    e.preventDefault();
    if (onLost) onLost();
  });
  canvas.addEventListener("webglcontextrestored", () => {
    if (onRestored) onRestored();
  });

  return gl;
}

// Compile one stage. Returns null on failure, having said why on the console —
// a shader that does not compile is a bug in this repository, not a property of
// the user's machine, so it is worth the noise.
function compile(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  // The status query is deliberately NOT guarded by a "skip in production"
  // switch. It is a pipeline stall, but it happens once per program at startup,
  // and the alternative is a silently black screen.
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    console.warn("present: shader failed to compile\n", gl.getShaderInfoLog(shader));
    gl.deleteShader(shader);
    return null;
  }
  return shader;
}

// Link a program from two sources. Null on any failure, so the caller's single
// "no GPU path today" branch covers a broken shader as well as a missing GPU.
//
// The shaders are DETACHED AND DELETED after linking: the program keeps
// everything it needs, and holding the stage objects open would leak one pair
// per context restore for a program that is rebuilt on every one of them.
export function buildProgram(gl, vsSource, fsSource) {
  const vs = compile(gl, gl.VERTEX_SHADER, vsSource);
  const fs = vs ? compile(gl, gl.FRAGMENT_SHADER, fsSource) : null;
  if (!vs || !fs) {
    if (vs) gl.deleteShader(vs);
    if (fs) gl.deleteShader(fs);
    return null;
  }

  const program = gl.createProgram();
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  gl.detachShader(program, vs);
  gl.detachShader(program, fs);
  gl.deleteShader(vs);
  gl.deleteShader(fs);

  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    // A link failure after two clean compiles is a mismatch between the stages
    // (a varying one side declares and the other does not), so the log is the
    // only thing that says which.
    console.warn("present: program failed to link\n", gl.getProgramInfoLog(program));
    gl.deleteProgram(program);
    return null;
  }
  return program;
}
