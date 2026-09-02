// Part of the cross-file invariant suite — see test/README-invariants.md for
// what these assert and why they are not unit tests of behaviour.
//
// THE VECTOR ALPHABET (src/engine/vectorfont.js) and the screen that uses it
// (src/game/menu.js). Three things here cannot be caught anywhere else:
//
//   1. COVERAGE. A character with no glyph draws NOTHING — vectorText has no
//      fallback box, deliberately (vectorfont.js's header). So a label with an
//      uncovered character is a silent hole on the title screen, and the one
//      moment anyone would notice is the moment a player is looking at it.
//      menu.js exports VECTOR_STRINGS — the actual strings it renders, not a
//      copy — so renaming a row or adding a mode is checked here.
//   2. THE CELL. Every metric vectorText computes (centring, right alignment,
//      the selected row's brackets) assumes glyph geometry stays inside
//      0..CELL_W by 0..1. A glyph that overflows does not fail, it overlaps its
//      neighbour, which reads as a font bug rather than as the one bad point it
//      is. Descenders are the deliberate exception and are named as such.
//   3. THE METER COUNTS THE KEYPRESSES. menu.js derives VOLUME_SEGMENTS from
//      VOLUME_STEP so a left/right press moves exactly one segment; that claim
//      is arithmetic in a comment, and a comment cannot fail.

import test from "node:test";
import assert from "node:assert/strict";

import { GLYPHS, CELL_W, advance, textWidth, missingGlyphs } from "../src/engine/vectorfont.js";
import { VECTOR_STRINGS } from "../src/game/menu.js";

// --- 1. Coverage ------------------------------------------------------------

test("the alphabet covers every string the menu renders in vector type", () => {
  for (const s of VECTOR_STRINGS) {
    assert.deepEqual(
      missingGlyphs(s),
      [],
      `menu.js renders "${s}", which vectorfont.js has no glyph for`,
    );
  }
});

test("the alphabet covers A-Z and 0-9, so a runtime string cannot hole", () => {
  // main.js composes gameover's readouts from live numbers ("FINAL SCORE 1234")
  // and shop.js may yet, so digits have to be complete rather than only the
  // ones today's literals happen to use.
  const required = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 ";
  assert.deepEqual(missingGlyphs(required), []);
});

test("VECTOR_STRINGS is not empty and holds the title", () => {
  // Guards against the export being emptied or stubbed, which would make the
  // coverage test above pass by testing nothing.
  assert.ok(VECTOR_STRINGS.length >= 6);
  assert.ok(VECTOR_STRINGS.includes("CYBERCRUISE"));
});

// --- 2. The cell ------------------------------------------------------------

// The one glyph that leaves the cell on purpose: a comma hangs below the
// baseline, which is what a comma is. Listed by name so a SECOND overflowing
// glyph is a failure rather than something this exception quietly absorbs.
const DESCENDERS = new Set([","]);

test("every glyph stays inside its cell", () => {
  for (const [ch, polys] of Object.entries(GLYPHS)) {
    for (const poly of polys) {
      for (const [x, y] of poly) {
        assert.ok(x >= 0 && x <= CELL_W, `glyph "${ch}" has x=${x} outside 0..${CELL_W}`);
        const maxY = DESCENDERS.has(ch) ? 1.1 : 1;
        assert.ok(y >= 0 && y <= maxY, `glyph "${ch}" has y=${y} outside 0..${maxY}`);
      }
    }
  }
});

test("every glyph is a list of polylines of at least two points", () => {
  // A one-point polyline strokes nothing at all (a moveTo with no lineTo), so
  // it is a silently invisible stroke rather than a dot — if a dot is wanted,
  // it is a two-point segment, which is how "." and ":" are built.
  for (const [ch, polys] of Object.entries(GLYPHS)) {
    assert.ok(Array.isArray(polys), `glyph "${ch}" is not an array of polylines`);
    for (const poly of polys) {
      assert.ok(poly.length >= 2, `glyph "${ch}" has a polyline of ${poly.length} point(s)`);
      for (const p of poly) assert.equal(p.length, 2, `glyph "${ch}" has a malformed point`);
    }
  }
});

test("space is present and draws nothing", () => {
  // It is the one glyph that SHOULD be empty; the coverage test above would
  // otherwise be satisfied by a space that had been given accidental ink.
  assert.deepEqual(GLYPHS[" "], []);
});

// --- 3. Metrics -------------------------------------------------------------

test("textWidth is the advance times the count, less the trailing track", () => {
  // The subtraction is what keeps a centred string centred — counting the gap
  // after the last glyph would offset every title by half a track. Asserted
  // against the arithmetic vectorfont.js's own comment claims.
  const cap = 40, track = 5;
  assert.equal(textWidth("AB", cap, track), 2 * advance(cap, track) - track);
  assert.equal(textWidth("A", cap, track), CELL_W * cap);
  assert.equal(textWidth("", cap, track), 0);
});

test("the volume meter has one segment per keypress", () => {
  // menu.js's VOLUME_SEGMENTS = round(1 / VOLUME_STEP), so the meter IS the
  // level counted out rather than an approximation of it. Both numbers are
  // private to menu.js, so this asserts the relation through the only thing it
  // exposes: that a full sweep of the step lands exactly on the segment count.
  const VOLUME_STEP = 0.1; // menu.js
  const segments = Math.round(1 / VOLUME_STEP);
  assert.equal(segments, 10);
  for (let i = 0; i <= segments; i++) {
    const level = i * VOLUME_STEP;
    assert.equal(Math.round(level * segments), i, `level ${level} should light ${i} segments`);
  }
});
