// Part of the cross-file invariant suite — see test/README-invariants.md for
// what these assert and why they are not unit tests of behaviour.
//
// THE PRESENT PATH (src/engine/present.js, src/engine/gl/): the GPU blit, and
// the two claims it makes that nothing else can catch.
//
// FIRST, THE FAILURE PATH IS REAL. Phase 15d-i made WebGL2 required — no
// WebGL2 no longer means the 2D canvas, it means the "WEBGL2 REQUIRED" DOM
// notice (`#gl-notice`) and init() returning false so the caller never starts
// the game loop (engine/present.js's header, engine/gl/context.js's header).
// That claim is worth exactly as much as the branch behind it, and a machine
// WITH WebGL2 (every machine anyone tests on) never takes that branch, so
// nothing else would notice it rotting. Here it is taken deliberately, by
// handing init() a canvas that answers null, and the notice text is asserted
// along with the return value — the whole point of the redesign was that
// failure is now something the player is TOLD, not something the game quietly
// works around.
//
// SECOND, THE SAMPLER NAMES. Each fragment stage declares its own uniforms and
// present.js looks each one up with getUniformLocation; the two are in
// different files with nothing but spelling holding them together. WebGL does
// not fail on a mismatch — getUniformLocation returns null, a uniform call on
// null is silently ignored, and a sampler left unset defaults to texture unit
// 0. In 15a that "very nearly worked" (there was only one sampler, and it
// wanted unit 0 anyway); with 15b's chain binding up to three textures in one
// pass (COMPOSITE_FS), the same silent failure reads as a bloom bug — a
// texture bound to the wrong logical slot — rather than as the spelling drift
// it actually is. The test below checks every getUniformLocation call in
// present.js against every uniform declared across all six shader sources, so
// a typo in any one of them fails loudly here instead of quietly on screen.
//
// 15E-I RAISED THE STAKES ON THAT. GLITCH_FS has eleven uniforms rather than
// one or two, they are looked up as eleven separate module-level handles, and —
// unlike anything in the bloom chain — the pass they drive only runs while a
// jack-in or a death is on screen. A misspelling there is a uniform silently
// pinned at 0.0 during a sequence nobody is diffing pixel by pixel, which is
// about as quiet as a rendering bug gets.
//
// THIRD, THE FEED TIMELINE. The two sequences hand present.js a block of plain
// numbers each frame (present.js's `feed`) and the shader reads most of them as
// 0..1. Nothing on the GPU side clamps them and nothing complains: a field
// written out of range is a visual bug whose only symptom is that something
// looked wrong. The beat ORDER and the field RANGE are what section 3 pins —
// not the look, which is not something an assertion can hold.
//
// It runs headless because it can: present.js touches the DOM only through the
// two elements it is handed, so a pair of stand-ins is enough. That is the same
// arrangement test-options.test.js uses for the menu, and the same reason
// engine/gutter.js is absent from this suite — it is DOM all the way down and
// this is not.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { init, isLive, present, feed } from "../src/engine/present.js";
import {
  PRESENT_FS, PRESENT_VS, BRIGHT_FS, BLUR_FS, COMPOSITE_FS, GLITCH_FS,
} from "../src/engine/gl/shaders.js";
import { JackIn, CONNECT_DURATION } from "../src/game/jackin.js";
import { Disconnect, DISCONNECT_DURATION } from "../src/game/disconnect.js";

// The minimum of a canvas element that present.js reaches for on the path
// where there is no context to be had — now including the `#gl-notice`
// structure init() looks up off the cabinet (see present.js's `init()` and
// `showNotice()`), so the fatal path's DOM writes are something a headless
// test can actually observe.
function fakeCanvas(getContext) {
  const classes = new Set();
  const notice = {
    hidden: true,
    classes: new Set(),
    classList: {
      toggle(name, on) {
        if (on) notice.classes.add(name); else notice.classes.delete(name);
      },
      has: (name) => notice.classes.has(name),
    },
    title: { textContent: "" },
    body: { textContent: "" },
    querySelector(sel) {
      if (sel === ".gl-notice-title") return notice.title;
      if (sel === ".gl-notice-body") return notice.body;
      return null;
    },
  };
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
      querySelector: (sel) => (sel === "#gl-notice" ? notice : null),
    },
    notice,
  };
}

// --- 1. The failure path ------------------------------------------------

test("no WebGL2 leaves the present path dead and shows the WEBGL2 REQUIRED notice", () => {
  const target = fakeCanvas(() => null);
  assert.equal(init(fakeCanvas(() => null), target), false);
  assert.equal(isLive(), false);
  // The cabinet never gets the class, so css/style.css keeps the present
  // canvas display:none — there is no fallback left for it to hand off to.
  assert.equal(target.parentElement.classList.has("gl"), false);
  // The notice is what answers "no WebGL2" now — see present.js's header and
  // gl/context.js's for why a haloless game is no longer the alternative.
  assert.equal(target.notice.hidden, false);
  assert.equal(target.notice.classList.has("fatal"), true);
  assert.match(target.notice.title.textContent, /WEBGL2/);
  assert.ok(target.notice.body.textContent.length > 0);
});

test("a browser that throws from getContext is indistinguishable from one without WebGL2", () => {
  // Specified to return null, but a driver blocklist has been seen to throw.
  // gl/context.js swallows it for this reason; if that ever stops being true,
  // the throw escapes into main.js's module body and the game does not boot.
  const target = fakeCanvas(() => { throw new Error("blocklisted"); });
  assert.doesNotThrow(() => init(fakeCanvas(() => null), target));
  assert.equal(isLive(), false);
  // Indistinguishable all the way to the player, not just to the return value —
  // the thrown path shows exactly the same notice the null path does.
  assert.equal(target.notice.hidden, false);
  assert.equal(target.notice.classList.has("fatal"), true);
});

test("present() on a dead path is a no-op, not a crash", () => {
  // main.js calls this once per frame with no branch of its own (see the
  // present step at the bottom of that file), so "off" has to be safe 60 times
  // a second rather than merely handled.
  assert.doesNotThrow(() => present());
});

// --- 2. The seam between the shader and the code that binds it --------------

test("every uniform present.js binds by name is declared in some fragment stage", () => {
  const source = readFileSync(new URL("../src/engine/present.js", import.meta.url), "utf8");
  const bound = [...source.matchAll(/getUniformLocation\([^,]+,\s*"([^"]+)"\)/g)].map((m) => m[1]);
  assert.ok(bound.length >= 5, "present.js binds far fewer uniforms than the 15b chain has — this test is stale");

  const allSource = [PRESENT_FS, BRIGHT_FS, BLUR_FS, COMPOSITE_FS, GLITCH_FS].join("\n");
  // ONE MATCH PER NAME, NOT PER LINE. GLSL allows `uniform float a, b, c;` and
  // the first version of this pattern only captured the name touching the
  // semicolon — so a comma-declared uniform read as UNDECLARED and failed a
  // shader that was perfectly correct. Found exactly that way, adding
  // GLITCH_FS. Splitting the declarator list is what makes this a test of
  // spelling rather than of formatting.
  const declared = new Set();
  for (const m of allSource.matchAll(/uniform\s+\S+\s+([^;]+);/g)) {
    for (const name of m[1].split(",")) declared.add(name.trim());
  }
  for (const name of bound) {
    // A name bound here but declared nowhere is exactly the failure mode the
    // header above describes: silently ignored, and the sampler that should
    // have received it keeps reading whatever unit 0 happens to hold.
    assert.ok(declared.has(name), `present.js binds "${name}", which no fragment stage declares`);
  }
});

test("the vertex stage needs no buffers, which is what keeps all seven draws VAO-free", () => {
  // gl/shaders.js says why there is no vertex buffer: the corners come from
  // gl_VertexID. An attribute reintroduced here would need a VAO, a buffer,
  // and per-restore rebuilding of both, for every one of the four programs
  // that reuse this stage — none of which present.js has.
  assert.match(PRESENT_VS, /gl_VertexID/);
  assert.doesNotMatch(PRESENT_VS, /^\s*in\s+/m);
});

test("every stage is GLSL ES 3.00, declared on the first line", () => {
  // #version has to be the very first characters of the source or the shader
  // fails to compile, which is why the template strings open on the same line
  // as the backtick. A stray newline there is easy to add and gives a compile
  // error that names line 1 of a file that has no line 1.
  for (const src of [PRESENT_VS, PRESENT_FS, BRIGHT_FS, BLUR_FS, COMPOSITE_FS, GLITCH_FS]) {
    assert.ok(src.startsWith("#version 300 es\n"));
  }
});

// --- 3. The feed timeline ---------------------------------------------------
//
// NOT A TEST OF THE LOOK, which is not a thing an assertion can hold. These pin
// the ORDER of the beats and the RANGE of the fields, which are the two things
// a retune can break silently. Both sequences are driven by advancing their own
// clock, so each is walked frame by frame the way main.js walks it.

// Every field GLITCH_FS reads as a 0..1 scalar. `time` and the two shake
// components are deliberately absent — they are not fractions. `seed` IS one,
// and is here for a sharper reason than tidiness: the shader adds it to block
// indices in a 32-bit float, so a raw seed silently flattens the whole effect
// (present.js's `feed` carries the story). A range check is exactly the guard
// that would have caught it.
const UNIT_FIELDS = ["resolve", "order", "corrupt", "split", "quant", "fade", "flash", "seed"];

// One frame at 60Hz, which is what createLoop hands these.
const DT = 1 / 60;

// A copy of the real block, so a test can never leave the module-level one
// holding a sequence's last frame.
function walk(seq, duration, onFrame) {
  const block = { ...feed };
  for (let i = 0; i * DT <= duration + DT; i++) {
    seq.update(DT);
    const live = seq.feed(block);
    onFrame(seq.progress, live, block);
  }
}

test("no feed field the shader reads as a fraction ever leaves 0..1", () => {
  // A field out of range does not throw and does not warn — it produces a frame
  // that is wrong in a way nobody can attribute. `fade` over 1 is a negative
  // multiply; `resolve` outside [0,1] quietly pins the arrival frontier past
  // one end of its own field, which reads as "the effect stopped working".
  for (const [name, seq, duration] of [
    ["jackin", new JackIn(), CONNECT_DURATION],
    ["disconnect", new Disconnect(), DISCONNECT_DURATION],
  ]) {
    seq.trigger(300, 500, 34, 60);
    walk(seq, duration, (t, live, block) => {
      if (!live) return;
      for (const f of UNIT_FIELDS) {
        assert.ok(
          block[f] >= 0 && block[f] <= 1,
          name + " wrote " + f + " = " + block[f] + " at t=" + t.toFixed(3),
        );
      }
    });
  }
});

test("the jack-in resolves: the arrival frontier only ever moves forward", () => {
  // The boot's one irreversible claim. A frontier that went backwards would be
  // blocks that had arrived un-arriving, which is not something a feed does —
  // and it is exactly what a mis-signed retune of SWEEP_END would produce.
  const jackin = new JackIn();
  jackin.trigger();
  let last = -1;
  walk(jackin, CONNECT_DURATION, (t, live, block) => {
    if (!live) return;
    assert.ok(block.resolve >= last, "resolve went backwards at t=" + t.toFixed(3));
    last = block.resolve;
  });
  assert.equal(last, 1, "the feed never finished arriving");
});

test("the disconnect holds still after the hit, then only ever loses ground", () => {
  // THE HELD BEAT IS THE ASSERTION HERE. disconnect.js's HOLD_END exists so the
  // player registers the death before the screen comes apart, and the way that
  // is implemented is feed() reporting NO WORK AT ALL — which is also what
  // keeps those frames a bit-for-bit no-op (present.js's `feed`, and README's
  // "The present path"). A retune that let the collapse start at the hit would
  // quietly take both the pacing and the no-op.
  const disconnect = new Disconnect();
  disconnect.trigger(300, 500, 34, 60);
  let sawHold = false;
  let last = Infinity;
  walk(disconnect, DISCONNECT_DURATION, (t, live, block) => {
    if (!live) {
      // Only ever at the start: once the collapse begins it does not pause.
      assert.ok(last === Infinity, "the feed went idle again at t=" + t.toFixed(3));
      sawHold = true;
      return;
    }
    assert.ok(block.resolve <= last, "resolve recovered at t=" + t.toFixed(3));
    last = block.resolve;
  });
  assert.ok(sawHold, "the held beat after the hit is gone");
  assert.ok(last < 1, "the feed never started failing");
});

test("the two sequences run one arrival field from opposite ends", () => {
  // The whole design rests on this (gl/shaders.js's GLITCH_FS): ONE mechanism,
  // ramped up for a boot and down for a death, which is what those two modules'
  // headers have always claimed about each other. If a later change gave either
  // sequence machinery of its own, this is the claim that stops being true.
  const jackin = new JackIn();
  jackin.trigger();
  let jackFirst = null;
  let jackLast = null;
  walk(jackin, CONNECT_DURATION, (t, live, block) => {
    if (!live) return;
    if (jackFirst === null) jackFirst = block.resolve;
    jackLast = block.resolve;
  });

  const disconnect = new Disconnect();
  disconnect.trigger(300, 500, 34, 60);
  let discFirst = null;
  let discLast = null;
  walk(disconnect, DISCONNECT_DURATION, (t, live, block) => {
    if (!live) return;
    if (discFirst === null) discFirst = block.resolve;
    discLast = block.resolve;
  });

  assert.ok(jackFirst < jackLast, "the jack-in does not gain blocks");
  assert.ok(discFirst > discLast, "the disconnect does not lose blocks");
  // The boot ends where a live frame is, and the death starts there.
  assert.equal(jackLast, 1);
  assert.equal(discFirst, 1);
});

test("an inactive sequence describes nothing, so a stale instance cannot draw", () => {
  // reset() between games is what keeps a finished sequence from being drawn
  // for a frame on restart (both modules' reset() comments). With the picture
  // in a shader now, "drawn for a frame" would be a whole corrupted frame
  // rather than a stray outline, so the guard is worth pinning.
  const block = { ...feed };
  const jackin = new JackIn();
  assert.equal(jackin.feed(block), false);
  jackin.trigger();
  jackin.update(DT);
  assert.equal(jackin.feed(block), true);
  jackin.reset();
  assert.equal(jackin.feed(block), false);

  const disconnect = new Disconnect();
  assert.equal(disconnect.feed(block), false);
  disconnect.trigger(300, 500, 34, 60);
  disconnect.update(DISCONNECT_DURATION * 0.5);
  assert.equal(disconnect.feed(block), true);
  disconnect.reset();
  assert.equal(disconnect.feed(block), false);
});
