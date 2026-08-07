// Node markers — the "facility" plot type Phase 7d claims in citygrid.js.
//
// FLAT, DELIBERATELY. Every building on this floor is an extruded box or prism
// (buildingshapes.js) — height is what tells the eye "this is architecture". A
// node marker never rises off the ground plane at all: corner brackets and a
// centre glyph, laid flat, exactly like the street ribbons and the registration
// ticks it stands among. That contrast — up vs. flat — is what makes a node read
// as ANNOTATION rather than as one more building, and it is the whole reason
// this lives in its own module instead of another entry in buildingshapes.js's
// BUILDERS catalogue (which is nothing BUT extruded prisms).
//
// GLOW IS ALLOWED HERE. The last two sub-phases (7b's traffic dots, 7c's
// drones) banned ctx.shadowBlur because they redraw every frame; a node is the
// opposite case — baked into a sprite once via sprites.js's drawNodeVariant and
// blitted thereafter (spritecache.js's whole reason to exist), so it can afford
// neonStroke's full multi-pass treatment and come out crisper and brighter than
// the buildings around it, which is exactly the point: a node has to read as
// the most deliberate mark on the floor, not as texture.
//
// A BOUNDED SET OF LOOKS, keyed off the plot index (citygrid.js's reserve()),
// never rolled per frame — see NODE_VARIANTS below for why the count is fixed
// regardless of how many nodes the infinite city ever grows.

import { neonStroke } from "../engine/neon.js";
import { NODE_BRACKET, NODE_GLYPH } from "../engine/palette.js";

const TAU = Math.PI * 2;

// Three bracket-square sizes x two centre glyphs (diamond, crosshair) = 6 —
// "4-6 is plenty" per the design doc, and plenty is the point: a node is rare
// by construction (citygrid.js's NODE_CHANCE), so the eye only ever has to
// tell a couple of these apart on screen at once. Growing this catalogue would
// buy variety nobody is in a position to notice, at real memory cost (this
// feeds sprites.js's cache the same way BUILDING_VARIANTS does).
export const NODE_VARIANTS = 6;

const SIZES = [30, 38, 46]; // full bracket-square side, px
const GLYPHS = ["diamond", "crosshair"];

// Deterministic parameters for variant `v` — same trick as sprites.js's own
// variantOpts: each field cycles at a different rate (here, just the two
// factors of NODE_VARIANTS) so a small catalogue still reads as a genuine set
// rather than one shape resized.
function variantParams(v) {
  return {
    size: SIZES[v % SIZES.length],
    glyph: GLYPHS[Math.floor(v / SIZES.length) % GLYPHS.length],
  };
}

// Corner-bracket leg length, as a fraction of the half-size. Short L's at each
// corner rather than a closed square outline — a full square would silhouette
// exactly like a building's own footprint (see this file's header), which is
// the one look a marker has to avoid.
const BRACKET_FRAC = 0.4;
const CORNERS = [[-1, -1], [1, -1], [1, 1], [-1, 1]];

// Draws node variant `v` with its centre at (cx, cy). Called once per variant,
// ever — see sprites.js's drawNodeVariant, the cached wrapper every caller
// actually uses.
export function drawNode(ctx, cx, cy, v) {
  const { size, glyph } = variantParams(v);
  const half = size / 2;
  const leg = half * BRACKET_FRAC;

  // Four corner brackets, one batched neonStroke call (batching costs nothing
  // extra here — this whole function runs once per variant, not once per
  // frame — but there is no reason to pay for four separate glow passes when
  // one path does the same job).
  neonStroke(ctx, (c) => {
    for (const [sx, sy] of CORNERS) {
      const x = cx + sx * half;
      const y = cy + sy * half;
      c.moveTo(x - sx * leg, y);
      c.lineTo(x, y);
      c.lineTo(x, y - sy * leg);
    }
  }, NODE_BRACKET, 1.5, 4);

  // Centre glyph — a diamond or a crosshair, per variant. Brighter than the
  // brackets (NODE_GLYPH vs. NODE_BRACKET): the glyph is the "signal", the
  // brackets are the "frame" around it.
  const r = half * 0.42;
  if (glyph === "diamond") {
    neonStroke(ctx, (c) => {
      c.moveTo(cx, cy - r);
      c.lineTo(cx + r, cy);
      c.lineTo(cx, cy + r);
      c.lineTo(cx - r, cy);
      c.closePath();
    }, NODE_GLYPH, 1.5, 4);
  } else {
    neonStroke(ctx, (c) => {
      c.moveTo(cx - r, cy);
      c.lineTo(cx + r, cy);
      c.moveTo(cx, cy - r);
      c.lineTo(cx, cy + r);
    }, NODE_GLYPH, 1.5, 4);
    // A small ring around the crosshair's centre — the second glyph would
    // otherwise be strictly less mark than the diamond (four strokes vs.
    // four), and the ring is what gives it its own "signal" identity rather
    // than reading as a diamond with its corners cut off.
    neonStroke(ctx, (c) => {
      c.arc(cx, cy, r * 0.45, 0, TAU);
    }, NODE_GLYPH, 1, 4);
  }
}

// Screen-space extent of variant `v` around its centre — the bracket square
// is the whole shape's bounding box (the glyph always sits well inside it),
// so sizing the sprite canvas to it is exact, not a guess.
export function nodeExtent(v) {
  const { size } = variantParams(v);
  const half = size / 2;
  return { left: half, right: half, up: half, down: half };
}
