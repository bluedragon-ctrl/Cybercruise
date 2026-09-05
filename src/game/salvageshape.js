// SALVAGE — the player's own car, left where an earlier run ended, with that
// run's credits still in it.
//
// ARTWORK ONLY, still — this file draws and knows nothing else. What changed
// when the CASH kind landed is that it is no longer artwork with nothing
// behind it: pickupshapes.js's SALVAGE entry names this drawer and carries the
// extents, pickuptypes.js's `salvage` entry pays out against it, pickups.js
// places one per recorded death, and sprites.js's drawSalvageCached is what
// actually reaches it per frame. The asset gallery is no longer the only
// caller, and this is no longer uncached.
//
// WHY "SALVAGE" AND NOT "WRECK". The word is taken, twice. effects.js's
// drawWreck is a car BREAKING UP — a shell coming apart over 0.75s — and
// disconnect.js's header states outright that the player's death is not a
// wreck at all: the feed fails, nothing explodes, and the game says CONNECTION
// LOST rather than showing one. This is neither event; it is the object left
// behind afterwards.
//
// ---------------------------------------------------------------------------
// THE FOUR DECISIONS THAT MAKE IT READ
//
// SIZE: 0.75 of the player's own 34x62 (SUPERCAR, carshapes.js). The whole
// emotional payload is that the player recognises their OWN car, so the
// silhouette has to survive: at a crate's 28x28 it does not, and at full size
// the thing reads as a live car sitting in the road. Three quarters is the
// span that stays recognisable while never being mistaken for traffic.
//
// DASHED [2, 2], and the dash length was the one number worth measuring.
// Judged in the browser at 3x against [3, 3] and [5, 4]: coarser dashes eat
// the NOSE POINT, which is the supercar's single strongest identity cue, and
// the husk stops reading as the player's car at all. What holds the outline
// together at any setting is that the wheels are filled polys and stay solid
// through a dash pattern, so they anchor the shape while the body breaks up.
//
// The dash is an UP-CLOSE detail, deliberately. At 50% — the size this is
// first sighted at up the road — it is invisible at every setting tried, and
// the $ is what carries the read at that range. Both jobs are covered, by
// different marks, which is why neither had to compromise.
//
// WHAT IS REMOVED, each removal doing its own work:
//   exhaust  the magenta plume is the one mark that says a player car is LIVE.
//            Dropping it is the cheapest "dead" cue available and it is free.
//   raised   the HEX canopy. The $ takes its place, so the husk is the player's
//            car with its heart swapped out rather than a car with a badge on.
//   flat     the three nose lines. They were the busiest marks inside the
//            outline and competed with the glyph for the same centre.
//
// THE $ IS GREEN (GREEN_BRIGHT), because green is money everywhere else in the
// game — walletrender.js writes every payout as a green `+25CR`. It is drawn
// as the vector font's own S with a bar through it rather than added to
// vectorfont.js's alphabet, because this is a MARK ON A CAR, not display type.
// If a $ is ever wanted inside a string it belongs in that catalogue instead,
// and its bar has to stay inside the 0..1 cell test/vectorfont.test.js pins —
// the bar here overhangs, which is what makes it look like a dollar sign and
// exactly what would fail there.
//
// THE THREE THINGS THIS HEADER LEFT UNDECIDED all have answers now, none of
// them here: applyPickup grew a `wallet` and an `amount` (pickuptypes.js's
// THE FIFTH KIND), the per-instance payload arrives with the record
// (worker/salvage.js), and "the same road" turned out not to need the city at
// all — worldseed.js re-salts it every run, but DISTANCE is the same number
// for everyone, so a husk is placed by where a run ended rather than by what
// was standing there.
//
// THE INITIALS ARE NOT DRAWN HERE, and that is a caching decision rather than
// a compositional one: a husk is one sprite for the whole game because it
// never changes, while a name varies per husk. sprites.js keeps them as two
// blits for that reason and explains it there.

import { glowLine, vectorText } from "../engine/neon.js";
import { CAR_SHAPES, drawShapeObject } from "./carshapes.js";
import { GREEN_BRIGHT, SALVAGE_HULL } from "../engine/palette.js";

// The player's supercar with the three passes above taken out. Spread from the
// catalogue rather than restated, so a change to the player's silhouette
// reaches the husk of it — the two are the same car and must not drift.
const HUSK = { ...CAR_SHAPES[0], flat: undefined, raised: undefined, exhaust: undefined };

export const SALVAGE_SCALE = 0.75;
export const SALVAGE_DASH = [2, 2];

// Footprint, for whatever eventually tests contact against it. Derived from the
// player's own size so it cannot drift from the artwork.
export const SALVAGE_SIZE = [
  CAR_SHAPES[0].size[0] * SALVAGE_SCALE,
  CAR_SHAPES[0].size[1] * SALVAGE_SCALE,
];

// The glyph's cap height as a fraction of the husk's length. Sized to fill the
// canopy the HEX used to occupy and no more: larger and it stops being a mark
// on a car and becomes a sign with a car drawn round it.
const GLYPH_H = 0.24;

// A "$": the vector font's S with a bar through it. See the header for why it
// lives here rather than in vectorfont.js.
function dollar(ctx, cx, cy, size, color, width) {
  vectorText(ctx, "S", cx, cy - size / 2, color, size, "center", width);
  glowLine(ctx, cx, cy - size * 0.72, cx, cy + size * 0.72, color, width);
}

// Draw the husk centred at (cx, cy), pointing "up" like everything else on the
// tarmac. `w`/`h` default to SALVAGE_SIZE; `angle` rotates it to the road's
// heading the way obstacles.js and pickupshapes.js both do.
export function drawSalvage(ctx, cx, cy, opts = {}) {
  const {
    w = SALVAGE_SIZE[0],
    h = SALVAGE_SIZE[1],
    hull = SALVAGE_HULL,
    glyph = GREEN_BRIGHT,
    angle = 0,
  } = opts;

  ctx.save();
  if (angle) {
    ctx.translate(cx, cy);
    ctx.rotate(angle);
    cx = 0;
    cy = 0;
  }

  // The dash is set once and left live for the whole body: glowLine and
  // glowPoly save/restore around their own state and never touch the pattern,
  // so an ambient setLineDash reaches every stroke inside — the same scoping
  // trick scenery.js and carshapes.js's hover leader both use.
  ctx.setLineDash(SALVAGE_DASH);
  drawShapeObject(ctx, cx, cy, HUSK, { color: hull, thrust: hull, w, h });
  ctx.setLineDash([]);

  dollar(ctx, cx, cy, h * GLYPH_H, glyph, 1.7);
  ctx.restore();
}
