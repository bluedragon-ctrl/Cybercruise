// SALVAGE — the player's own car, left where an earlier run ended, with that
// run's credits still in it.
//
// ARTWORK ONLY. Nothing spawns this, nothing collects it, no type names it.
// It is here so the look is settled and reviewable before the gameplay is
// designed; the asset gallery is the only caller.
//
// WHY IT IS NOT IN pickupshapes.js. That catalogue's rule is that a shape
// pairs with a pickuptypes.js entry, and there is no entry for this: a crate's
// payload is a constant in the catalogue, and salvage pays whatever the dead
// player happened to be carrying. Holding artwork outside its pairing until
// the type exists is exactly what bossshapes.js does for the boss hulls (see
// the README's Traffic table — hulls graduate out of it one at a time as their
// types are written). This graduates INTO pickupshapes.js the day a CASH kind
// exists, and takes its own extents with it.
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
// STILL UNDECIDED, and none of it is the artwork's to settle: the CASH kind
// pickuptypes.js would need (applyPickup takes `player` and `loadout`, and
// this pays the wallet), the per-instance payload (the first pickup whose
// amount is not a catalogue constant), and whether "the same road" means your
// own previous death this session or a seed shared through the leaderboard
// worker — worldseed.js re-salts the city every run, so the road is not the
// same one twice by default.
//
// NOT CACHED. Every live entity goes through sprites.js's cache, and this
// would too once something spawns it; nothing draws it per frame yet, so
// adding a cache entry now would only spend the documented budget
// (test/road-and-caches.test.js) on a sprite no frame asks for.

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
