// THE VECTOR ALPHABET — the game's display type, as line art.
//
// WHY THIS EXISTS. Every single thing this game draws is a stroked polyline:
// the road, the buildings, the cars, the hazards (engine/neon.js). Everything
// except its TYPE, which was `Courier New` — a 1955 typewriter face, and the
// one element on screen that could not have come off the same machine as the
// rest of it. Replacing it is worth more to the "80s console" read than any
// palette or post-processing change, because every other period cue is layered
// on top of the lettering and inherits its era.
//
// So the letters are drawn the way a VECTOR ARCADE MACHINE would have drawn
// them: as polylines on a fixed cell, chamfered rather than curved, from the
// same primitive (a stroke) as the world around them. This is data, not code —
// the catalogue rule in CLAUDE.md — and the one module that owns letterform
// geometry, the way cartypes.js owns cars.
//
// THE CELL. Each glyph lives on 0..CELL_W horizontally and 0..1 vertically,
// scaled by the caller's cap height. Its ORIGIN IS THE TOP-LEFT, matching
// `textBaseline = "top"` on every glowText call in the codebase, so a vector
// string and a canvas string placed at the same y line up and either can
// replace the other without moving anything.
//
// CHAMFERED, NOT CURVED, and that is a look rather than a shortcut: a real
// vector display drew straight segments between points, so curves were
// polygons with visible corners. It also keeps every glyph to a handful of
// points, which matters because these are stroked live rather than cached —
// the whole alphabet is ~200 segments, against the ~2000-line floor grid that
// profiled at 2.35ms before it was cached (game/scenery.js), so a few strings
// of display type is not a cost worth a cache.
//
// NO shadowBlur, EVER — see neon.js's `vectorText`. These are drawn on the
// bloomed canvas and bloom supplies the entire halo. That is the same rule
// 15d-ii applied to every other stroke in the game, and applying it here is
// what fixed the uneven, blobby glow the old Courier title had: `shadowBlur`
// laid a wide soft skirt around every letter, bloom thresholded THAT and blurred
// it again, and wherever two letters' skirts overlapped the sum crossed
// BLOOM_THRESHOLD and the knee saturated it into an opaque patch. Measured on
// the title: the gap between B and E — the two densest glyphs in the string,
// adjacent — filled to 80/255 against 41 for the sparsest pair, which is the
// "why does BE glow harder than IS" the redesign was asked about. Removing the
// shadow roughly halves both the level and the spread.

// A glyph cell is this wide, in units of the cap height. 0.72 is a touch
// narrower than square, which is what makes a long word like CYBERCRUISE read
// as one banner rather than as eleven separate boxes; the tracking the caller
// passes is what opens it back up.
export const CELL_W = 0.72;

// Every glyph is an array of POLYLINES, each an array of [x, y] points, stroked
// open (never closed — a closed path would need its own join handling at the
// seam and nothing here wants one). A glyph that needs a disjoint mark, like
// the bar in A or the two dots of a colon, is two polylines rather than one
// path with a jump in it.
//
// Missing characters draw NOTHING rather than a fallback box: a box would
// silently ship, where a hole is obvious the moment anyone looks — and
// vectorfont.test.js asserts coverage of every string the menu actually
// renders, so it fails before anyone has to.
export const GLYPHS = {
  A: [[[0, 1], [0.36, 0], [0.72, 1]], [[0.12, 0.66], [0.6, 0.66]]],
  B: [[[0, 0], [0, 1]],
      [[0, 0], [0.5, 0], [0.7, 0.18], [0.7, 0.32], [0.52, 0.5], [0, 0.5]],
      [[0, 0.5], [0.54, 0.5], [0.72, 0.68], [0.72, 0.82], [0.56, 1], [0, 1]]],
  C: [[[0.72, 0.16], [0.56, 0], [0.16, 0], [0, 0.16], [0, 0.84], [0.16, 1], [0.56, 1], [0.72, 0.84]]],
  D: [[[0, 0], [0, 1]], [[0, 0], [0.52, 0], [0.72, 0.2], [0.72, 0.8], [0.52, 1], [0, 1]]],
  E: [[[0.72, 0], [0, 0], [0, 1], [0.72, 1]], [[0, 0.5], [0.54, 0.5]]],
  F: [[[0.72, 0], [0, 0], [0, 1]], [[0, 0.5], [0.54, 0.5]]],
  G: [[[0.72, 0.16], [0.56, 0], [0.16, 0], [0, 0.16], [0, 0.84], [0.16, 1], [0.56, 1],
       [0.72, 0.84], [0.72, 0.55], [0.4, 0.55]]],
  H: [[[0, 0], [0, 1]], [[0.72, 0], [0.72, 1]], [[0, 0.5], [0.72, 0.5]]],
  I: [[[0.12, 0], [0.6, 0]], [[0.36, 0], [0.36, 1]], [[0.12, 1], [0.6, 1]]],
  J: [[[0.6, 0], [0.6, 0.84], [0.44, 1], [0.16, 1], [0, 0.84]]],
  K: [[[0, 0], [0, 1]], [[0.7, 0], [0, 0.55]], [[0.26, 0.36], [0.72, 1]]],
  L: [[[0, 0], [0, 1], [0.72, 1]]],
  M: [[[0, 1], [0, 0], [0.36, 0.45], [0.72, 0], [0.72, 1]]],
  N: [[[0, 1], [0, 0], [0.72, 1], [0.72, 0]]],
  O: [[[0.16, 0], [0.56, 0], [0.72, 0.16], [0.72, 0.84], [0.56, 1], [0.16, 1], [0, 0.84], [0, 0.16], [0.16, 0]]],
  P: [[[0, 1], [0, 0], [0.5, 0], [0.7, 0.18], [0.7, 0.36], [0.5, 0.54], [0, 0.54]]],
  Q: [[[0.16, 0], [0.56, 0], [0.72, 0.16], [0.72, 0.84], [0.56, 1], [0.16, 1], [0, 0.84], [0, 0.16], [0.16, 0]],
      [[0.44, 0.72], [0.72, 1]]],
  R: [[[0, 0], [0, 1]],
      [[0, 0], [0.5, 0], [0.7, 0.18], [0.7, 0.34], [0.52, 0.52], [0, 0.52]],
      [[0.34, 0.52], [0.72, 1]]],
  S: [[[0.72, 0.16], [0.56, 0], [0.16, 0], [0, 0.16], [0, 0.34], [0.16, 0.5], [0.56, 0.5],
       [0.72, 0.66], [0.72, 0.84], [0.56, 1], [0.16, 1], [0, 0.84]]],
  T: [[[0, 0], [0.72, 0]], [[0.36, 0], [0.36, 1]]],
  U: [[[0, 0], [0, 0.82], [0.16, 1], [0.56, 1], [0.72, 0.82], [0.72, 0]]],
  V: [[[0, 0], [0.36, 1], [0.72, 0]]],
  W: [[[0, 0], [0.14, 1], [0.36, 0.42], [0.58, 1], [0.72, 0]]],
  X: [[[0, 0], [0.72, 1]], [[0.72, 0], [0, 1]]],
  Y: [[[0, 0], [0.36, 0.5], [0.72, 0]], [[0.36, 0.5], [0.36, 1]]],
  Z: [[[0, 0], [0.72, 0], [0, 1], [0.72, 1]]],

  // A SLASHED ZERO, which is not decoration: O and 0 are otherwise the same
  // chamfered ring at this point count, and the game prints both (CYBERCRUISE
  // has an O, the attract line has a 0). The slash is also exactly the
  // convention a terminal of the era used, so it costs nothing in tone.
  0: [[[0.16, 0], [0.56, 0], [0.72, 0.16], [0.72, 0.84], [0.56, 1], [0.16, 1], [0, 0.84], [0, 0.16], [0.16, 0]],
      [[0.1, 0.86], [0.62, 0.14]]],
  1: [[[0.16, 0.16], [0.36, 0], [0.36, 1]], [[0.12, 1], [0.6, 1]]],
  2: [[[0, 0.16], [0.16, 0], [0.56, 0], [0.72, 0.16], [0.72, 0.34], [0, 1], [0.72, 1]]],
  3: [[[0, 0.16], [0.16, 0], [0.56, 0], [0.72, 0.16], [0.72, 0.34], [0.56, 0.5], [0.72, 0.66],
       [0.72, 0.84], [0.56, 1], [0.16, 1], [0, 0.84]], [[0.3, 0.5], [0.56, 0.5]]],
  4: [[[0.54, 1], [0.54, 0], [0, 0.68], [0.72, 0.68]]],
  5: [[[0.72, 0], [0, 0], [0, 0.45], [0.56, 0.45], [0.72, 0.62], [0.72, 0.84], [0.56, 1], [0.16, 1], [0, 0.84]]],
  6: [[[0.56, 0.5], [0.16, 0.5], [0, 0.66], [0, 0.84], [0.16, 1], [0.56, 1], [0.72, 0.84], [0.72, 0.66], [0.56, 0.5]],
      [[0, 0.66], [0, 0.16], [0.16, 0], [0.56, 0]]],
  7: [[[0, 0], [0.72, 0], [0.3, 1]]],
  8: [[[0.16, 0], [0.56, 0], [0.72, 0.16], [0.72, 0.34], [0.56, 0.5], [0.16, 0.5], [0, 0.34], [0, 0.16], [0.16, 0]],
      [[0.16, 0.5], [0.56, 0.5], [0.72, 0.66], [0.72, 0.84], [0.56, 1], [0.16, 1], [0, 0.84], [0, 0.66], [0.16, 0.5]]],
  9: [[[0.16, 0.5], [0.56, 0.5], [0.72, 0.34], [0.72, 0.16], [0.56, 0], [0.16, 0], [0, 0.16], [0, 0.34], [0.16, 0.5]],
      [[0.72, 0.34], [0.72, 0.84], [0.56, 1], [0.16, 1]]],

  " ": [],
  ".": [[[0.3, 0.94], [0.42, 0.94]]],
  ",": [[[0.42, 0.9], [0.26, 1.08]]],
  ":": [[[0.3, 0.3], [0.42, 0.3]], [[0.3, 0.8], [0.42, 0.8]]],
  "-": [[[0.12, 0.55], [0.6, 0.55]]],
  "+": [[[0.12, 0.55], [0.6, 0.55]], [[0.36, 0.31], [0.36, 0.79]]],
  "/": [[[0, 1], [0.72, 0]]],
  "%": [[[0.06, 1], [0.66, 0]],
        [[0.04, 0], [0.26, 0], [0.26, 0.24], [0.04, 0.24], [0.04, 0]],
        [[0.46, 0.76], [0.68, 0.76], [0.68, 1], [0.46, 1], [0.46, 0.76]]],
};

// Advance from one cell's left edge to the next. `track` is in the same units
// as the cap height, so tracking scales with the type the way a designer would
// expect rather than staying a fixed pixel gap across sizes.
export function advance(capHeight, track) {
  return CELL_W * capHeight + track;
}

// Width of a whole string, for centring and for right alignment. The trailing
// track is subtracted: it sits AFTER the last glyph, so counting it would
// centre every string half a gap to the left.
export function textWidth(text, capHeight, track) {
  if (text.length === 0) return 0;
  return text.length * advance(capHeight, track) - track;
}

// Characters in `text` this catalogue has no glyph for. Empty means the string
// renders in full. Used by vectorfont.test.js against the strings the menu
// actually draws, so adding a label with an uncovered character fails there
// rather than showing up as a hole on the title screen.
export function missingGlyphs(text) {
  const missing = [];
  for (const ch of text) if (!(ch in GLYPHS) && !missing.includes(ch)) missing.push(ch);
  return missing;
}
