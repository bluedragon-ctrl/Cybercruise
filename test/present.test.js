// Part of the cross-file invariant suite — see test/README-invariants.md for
// what these assert and why they are not unit tests of behaviour.
//
// THE PRESENT PATH (src/engine/present.js, src/engine/gl/): the GPU blit, and
// the two claims it makes that nothing else can catch.
//
// FIRST, THE FALLBACK IS REAL. engine/present.js's header, css/style.css and
// the README's Phase 15a entry all state that a machine without WebGL2 gets
// today's game rather than a black canvas — and that claim is worth exactly as
// much as the branch behind it. A machine WITH WebGL2 (every machine anyone
// tests on) never takes that branch, so nothing else would notice it rotting.
// Here it is taken deliberately, by handing init() a canvas that answers null.
//
// SECOND, THE SAMPLER NAME. The fragment shader declares `uFrame` and
// present.js looks that string up with getUniformLocation; the two are in
// different files with nothing but spelling holding them together. WebGL does
// not fail on the mismatch — getUniformLocation returns null, uniform1i on null
// is silently ignored, the sampler defaults to texture unit 0 and it very
// nearly works. It stops working the moment 15b binds a second texture, and it
// would then look like a bloom bug.
//
// It runs headless because it can: present.js touches the DOM only through the
// two elements it is handed, so a pair of stand-ins is enough. That is the same
// arrangement test-options.test.js uses for the menu, and the same reason
// engine/gutter.js is absent from this suite — it is DOM all the way down and
// this is not.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { init, isLive, present } from "../src/engine/present.js";
import { PRESENT_FS, PRESENT_VS } from "../src/engine/gl/shaders.js";

// The minimum of a canvas element that present.js reaches for on the path
// where there is no context to be had.
function fakeCanvas(getContext) {
  const classes = new Set();
  return {
    width: 600,
    height: 800,
    getContext,
    addEventListener() {},
    parentElement: {
      classList: {
        toggle(name, on) {
          if (on) classes.add(name); else classes.delete(name);
        },
        has: (name) => classes.has(name),
      },
    },
  };
}

// --- 1. The fallback --------------------------------------------------------

test("no WebGL2 leaves the present path dead rather than half-built", () => {
  const target = fakeCanvas(() => null);
  assert.equal(init(fakeCanvas(() => null), target), false);
  assert.equal(isLive(), false);
  // The cabinet never gets the class, so css/style.css keeps the 2D canvas
  // visible and the present canvas display:none — which is the whole fallback.
  assert.equal(target.parentElement.classList.has("gl"), false);
});

test("a browser that throws from getContext is indistinguishable from one without WebGL2", () => {
  // Specified to return null, but a driver blocklist has been seen to throw.
  // gl/context.js swallows it for this reason; if that ever stops being true,
  // the throw escapes into main.js's module body and the game does not boot.
  const target = fakeCanvas(() => { throw new Error("blocklisted"); });
  assert.doesNotThrow(() => init(fakeCanvas(() => null), target));
  assert.equal(isLive(), false);
});

test("present() on a dead path is a no-op, not a crash", () => {
  // main.js calls this once per frame with no branch of its own (see the
  // present step at the bottom of that file), so "off" has to be safe 60 times
  // a second rather than merely handled.
  assert.doesNotThrow(() => present());
});

// --- 2. The seam between the shader and the code that binds it --------------

test("the sampler present.js binds is the one the fragment shader declares", () => {
  const source = readFileSync(new URL("../src/engine/present.js", import.meta.url), "utf8");
  const bound = /getUniformLocation\(program,\s*"([^"]+)"\)/.exec(source);
  assert.ok(bound, "present.js no longer binds a sampler by name — this test is stale");
  assert.match(PRESENT_FS, new RegExp(`uniform\\s+sampler2D\\s+${bound[1]}\\s*;`));
});

test("the vertex stage needs no buffers, which is what lets present() be two calls", () => {
  // present.js's header prices the path at two GL calls per frame and gl/shaders.js
  // says why there is no vertex buffer: the corners come from gl_VertexID. An
  // attribute reintroduced here would need a VAO, a buffer, and per-restore
  // rebuilding of both — none of which present.js has.
  assert.match(PRESENT_VS, /gl_VertexID/);
  assert.doesNotMatch(PRESENT_VS, /^\s*in\s+/m);
});

test("both stages are GLSL ES 3.00, declared on the first line", () => {
  // #version has to be the very first characters of the source or the shader
  // fails to compile, which is why the template strings open on the same line
  // as the backtick. A stray newline there is easy to add and gives a compile
  // error that names line 1 of a file that has no line 1.
  for (const src of [PRESENT_VS, PRESENT_FS]) {
    assert.ok(src.startsWith("#version 300 es\n"));
  }
});
