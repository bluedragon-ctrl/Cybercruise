// The obstacle catalogue — everything that sits ON the road and is not a car.
//
// Same idea as carshapes.js: pure DATA plus a small draw callback per entry,
// with no knowledge of placement, collision or scoring. Gameplay code picks an
// entry BY NAME (obstacleShapeIndex) and asks for it to be drawn; adding a new
// hazard means adding an entry here and nothing else.
//
// TWO FAMILIES, TWO COLOURS. Colour answers "how dangerous is this?" and the
// silhouette answers "what is it?" — the same split the traffic palette uses:
//
//   ROADBLOCKS are AMBER (the neutral family). They are inert road furniture:
//   they never move, never chase, and hitting one is the player's own doing.
//   Three variants exist purely for variability along a long drive, and they are
//   deliberately spread across a weight range — a wide shallow beam, a cluster
//   of water barrels with real gaps between them, and an immovable welded trap —
//   so a repeated obstacle type doesn't read as the same prop pasted down the
//   road. Each one breaks differently too (see DEBRIS below), which is how that
//   weight range gets confirmed at the moment it matters.
//
//   MINES are RED (the hostile family) and PULSE. A static red dot on black
//   tarmac is genuinely easy to miss; the blink is the cheapest possible "this
//   thing is live" tell, and it is what separates a mine from a scorch mark.
//
// Unlike a car, an obstacle's colours are FIXED by its role rather than passed
// in: an amber mine or a red pylon would break the two-family read that the
// whole palette is built on. That also keeps the sprite cache tiny — an
// obstacle's only varying parameter is the mine's pulse phase.
//
// SIZE vs EXTENT. `size` is the obstacle's physical FOOTPRINT (what a collision
// test should use); `extent` is how far its artwork reaches from the anchor
// (what the sprite bounds need). The tetra's spikes and the caltrop's prongs
// reach past the body they defend, so the two are not the same number.
//
// EVERY `extent` IN THIS FILE IS DERIVED, never typed. See GLOW_BLEED below for
// why, and for how to re-measure after changing any artwork.

import { glowLine, glowPoly } from "../engine/neon.js";
import { LANE_WIDTH } from "./road.js";
import { polygon, caltropSpikes } from "./polygon.js";
import {
  CAR_FILL,
  CAR_FILL_RAISED,
  CAR_FILL_HIGH,
  CRITICAL_FLASH,
  ENEMY,
  ENEMY_PALE,
  HAZARD,
  NEUTRAL,
  NEUTRAL_DEEP,
  NEUTRAL_PALE,
} from "../engine/palette.js";

// Obstacle families. Placement, scoring and collision all branch on this rather
// than on a shape name, so a fourth roadblock costs them nothing.
export const BLOCK = "block";
export const MINE = "mine";

// Debris styles a roadblock can break with, drawn by game/effects.js. They are
// declared HERE, with the obstacles they describe, so effects.js can depend on
// the catalogue without the catalogue depending back on effects.js.
export const SPLINTER = "splinter";
export const IMPACT = "impact";
export const WATER = "water";

// --- Local drawing helpers -------------------------------------------------

// A circle as a polygon, so it goes through glowPoly and gets the same opaque
// fill + glow treatment as every other part.
const circle = (cx, cy, r, n = 20) => polygon(cx, cy, r, r, n);

// A regular polygon (hub plates, mine cores).
const ngon = (cx, cy, r, n, rot = 0) => polygon(cx, cy, r, r, n, rot);

// Diagonal hazard stripes, clipped to a rectangle. One clipped path buys the
// strongest "do not drive here" signal available.
function stripes(ctx, x, y, w, h, color, step = 9) {
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();
  ctx.strokeStyle = color;
  ctx.lineWidth = 3;
  ctx.globalAlpha = 0.85;
  ctx.shadowColor = color;
  ctx.shadowBlur = 6;
  ctx.beginPath();
  for (let i = -h; i < w + h; i += step) {
    ctx.moveTo(x + i, y + h);
    ctx.lineTo(x + i + h, y);
  }
  ctx.stroke();
  ctx.restore();
}

// DEBRIS. Each roadblock names how it comes apart (see game/effects.js), and
// the three styles form the same ramp as the silhouettes: the trestle SPLINTERs
// into flying slats, the barrels burst in a harmless spray of WATER, and the
// tetra gives the heavy IMPACT — a flash, a squat shockwave and chunks that stop
// almost where they started. That is the obstacle telling the player what it
// just cost them, so a block's debris style should match how hard it is to drive
// through, not how large it is. Mines have no debris style; they detonate
// (drawMineBlast).
//
// Fields:
//   name    lookup key / gallery caption
//   family  BLOCK or MINE
//   size    [w, h] physical footprint in px, for collision and debris spread
//   extent  {x, up, down} how far the ARTWORK reaches from the anchor
//   debris  BLOCK only: SPLINTER, WATER or IMPACT
//   pulse   true if the look depends on the `pulse` argument (0..1)
//   draw    (ctx, cx, cy, pulse) — anchored at the obstacle's centre
// --- Glow bleed ------------------------------------------------------------
//
// How far past its own geometry a neon part actually PAINTS. Every `extent` in
// this file is geometry + one of these constants, and that is the whole point:
// an extent that is typed by hand is a claim nobody checks, and the lane-fit
// test in test/invariants.test.js asserts against `extent`, so a hand-typed
// number that under-reports lets the test pass while the drawing crosses the
// lane edge. That is exactly what the trestle did — declared 29, drew 33.
//
// MEASURED, not derived from lineWidth and shadowBlur by formula. Render a
// shape to an offscreen canvas and scan for its alpha > 40 bounding box:
//
//   for (const shape of OBSTACLE_SHAPES) {
//     const c = document.createElement("canvas"); c.width = c.height = 300;
//     const ctx = c.getContext("2d"); shape.draw(ctx, 150, 150, 1);
//     const d = ctx.getImageData(0, 0, 300, 300).data;   // ...bounding box of
//   }                                                    // pixels with a > 40
//
// (Node has no canvas, which is why this cannot be a unit test; the test can
// only check that the extents are still DERIVED. Re-run the scan by hand after
// touching any draw().)
//
// A 1.5–2px stroke with shadowBlur 7–10 — nearly every part in this file —
// lands 5–6px past the edge it is stroked on. The trestle's beam is the one
// outlier: a 2px stroke with shadowBlur 11, reaching 7.
const GLOW_BLEED = 6;
const BEAM_GLOW_BLEED = 7;

// Some parts fade under the alpha threshold before the full bleed shows up —
// the caltrop's spikes taper to a needle, so their tips measure only 2px of
// bleed. Those extents therefore over-declare by a few px. That is the right
// direction to be wrong in: it costs a slightly larger cached sprite and
// nothing else, where under-declaring clips artwork and lies to the test.

// THE TRESTLE MUST FIT INSIDE A LANE, artwork and all.
//
// It is the one obstacle placed on lane centres (obstacletypes.js's PLACE_LANE),
// and "in the middle of a lane" is only true of something a lane can hold. At
// its original 1.25 lanes it was 81px in a 65px lane, so a trestle in an inner
// lane spilled 8px over the dashed centre-line and one in an outer lane hung
// over the barrier — it read as a block that had been dropped carelessly rather
// than as a lane closure.
//
// The bound is on the ARTWORK, not just the collision box: extent.x below is
// half this plus BEAM_GLOW_BLEED, and that is what has to stay inside
// LANE_WIDTH / 2 (32.5). At 0.8 lanes the beam was 52px and the artwork
// measured 33 — half a pixel over the edge the whole time, hidden because the
// declared extent said 29. At 0.775 the beam is 50.4px and the artwork reaches
// 32.2. Anything past LANE_WIDTH * 0.784 puts it back outside.
const TRESTLE_WIDTH = LANE_WIDTH * 0.775;
const TRESTLE_FOOT_HALF = 13; // the folding feet run cy ± this, past the beam

// THE BARRELS FIT INSIDE A LANE TOO, for a related but not identical reason.
//
// This one is placed against a barrier (PLACE_SIDE), not on a lane centre, so
// nothing forces it to be lane-sized geometrically. The reason is what the block
// is FOR: it is the barge-able one, the block the player is meant to line up and
// smash. A hazard 1.24 lanes wide cannot be lined up on without hanging out of
// your own lane, which made the one inviting obstacle the one you had to leave
// your lane to take. Two barrels inside a lane is a target you can aim at from
// the lane you are already in.
//
// The pair also stops eating more than a lane's worth of a four-lane road, so a
// barrels stack at the edge always leaves the other three lanes intact.
const BARREL_RADIUS = 12;
const BARREL_SPREAD = LANE_WIDTH * 0.21; // each barrel's offset from the centre
const BARREL_RISE = 9;                   // ...and up or down the road
const BARRELS_WIDTH = (BARREL_SPREAD + BARREL_RADIUS) * 2;

// The tetra's three welded beams sit 60 degrees apart, so its widest point is
// the horizontal arm's tip and its tallest is a slanted arm's outer corner —
// the arm's own half-length projected on y, plus the beam's half-thickness
// projected the other way.
const TETRA_ARM = LANE_WIDTH * 0.52; // hub to tip; under a lane wide, immovable
const TETRA_HALF_THICK = 4;          // half a beam's thickness
const TETRA_REACH_Y =
  TETRA_ARM * Math.sin(Math.PI / 3) + TETRA_HALF_THICK * Math.cos(Math.PI / 3);

// The caltrop reaches furthest at the top of its pulse, which is the frame the
// sprite bounds have to hold — the spikes breathe, the hex core does not.
const CALTROP_CORE = 9;
const CALTROP_SPIKE = 8;       // spike length at rest...
const CALTROP_SPIKE_PULSE = 2; // ...and how much further a full pulse pushes it
const CALTROP_REACH = CALTROP_CORE + CALTROP_SPIKE + CALTROP_SPIKE_PULSE;

// THE SPIKE STRIP IS THE WIDE ONE, and that is its entire silhouette argument.
//
// The caltrop above is deliberately the narrowest thing in the catalogue — "a
// mine is a POINT threat, not a wall" — so the strip has to be unmistakably the
// opposite at a glance, or the two red hazards read as the same object at two
// sizes. At 2.4 lanes it is by some way the widest thing on the road: it cannot
// be threaded, only gone around, which is the whole difference between dodging
// a mine and being HERDED by a strip.
//
// It does NOT close the road. 2.4 of four lanes leaves 1.6 lanes of tarmac
// whichever side it is laid, and obstacles.js's passage rule keeps the SPAWNER
// from adding to it (a laid hazard counts against that budget, see drop()).
// Anything past ~3 lanes here would make a single drop unavoidable, which is a
// different and much worse weapon.
const SPIKES_WIDTH = LANE_WIDTH * 2.4;
const SPIKES_SPINE_HALF = 3.5; // half the belt's own thickness, up and down road
const SPIKES_TOOTH = 6;        // how far a tooth reaches past the spine...
const SPIKES_TOOTH_PULSE = 1.5; // ...and how much further at the top of a pulse
const SPIKES_TOOTH_COUNT = 13;
const SPIKES_REACH_Y = SPIKES_SPINE_HALF + SPIKES_TOOTH + SPIKES_TOOTH_PULSE;

export const OBSTACLE_SHAPES = [
  {
    // The widest and flattest block: it fills most of its lane but is shallow, so
    // a committed lane change still clears it. The stripes do the communicating —
    // at distance this is a bright bar across the tarmac and nothing else.
    name: "TRESTLE",
    family: BLOCK,
    size: [TRESTLE_WIDTH, 14],
    // The beam is the widest part and the feet are the tallest, so x comes off
    // the beam (with the wide blur it carries) and up/down off the feet.
    extent: {
      x: TRESTLE_WIDTH / 2 + BEAM_GLOW_BLEED,
      up: TRESTLE_FOOT_HALF + GLOW_BLEED,
      down: TRESTLE_FOOT_HALF + GLOW_BLEED,
    },
    debris: SPLINTER, // light thing on legs — it just comes apart
    draw(ctx, cx, cy) {
      const hw = TRESTLE_WIDTH / 2;
      const fh = TRESTLE_FOOT_HALF;

      // Folding feet, at ground level, drawn first so the beam overlaps them and
      // the trestle reads as a solid object rather than a flat sticker.
      for (const fx of [-hw * 0.62, hw * 0.62]) {
        glowPoly(ctx, [
          [cx + fx - 3, cy - fh], [cx + fx + 3, cy - fh],
          [cx + fx + 3, cy + fh], [cx + fx - 3, cy + fh],
        ], NEUTRAL_DEEP, 1.5, 7, CAR_FILL);
        glowLine(ctx, cx + fx - 3, cy, cx + fx + 3, cy, NEUTRAL_DEEP, 1, 4);
      }

      // The beam: opaque and raised, so it hides the feet behind it.
      const top = cy - 7;
      glowPoly(ctx, [
        [cx - hw, top], [cx + hw, top], [cx + hw, top + 14], [cx - hw, top + 14],
      ], NEUTRAL, 2, 11, CAR_FILL_RAISED);
      stripes(ctx, cx - hw, top, hw * 2, 14, NEUTRAL);

      // Bright lip along the LEADING edge: the face the player is driving at is
      // the one that should catch the eye first.
      glowLine(ctx, cx - hw, top, cx + hw, top, NEUTRAL_PALE, 2, 9);
    },
  },

  {
    // Water-filled crash barrels — the middle weight, and the interesting one.
    // TWO of them, staggered rather than in a row, so the gap between them is
    // real and readable: this is the block that looks barge-able. It IS
    // barge-able, and it bursts when barged (debris: WATER), which is the set's
    // one moment of relief — the player gets to smash something and be rewarded
    // with a splash instead of a jolt. The silhouette is all circles, with no
    // square skirt, so a barrel never gets confused with the tetra's hub plate
    // at distance.
    //
    // Sized by the same rule as the trestle above: the PAIR fits inside one
    // lane, artwork included (see BARRELS_WIDTH). It used to be three barrels
    // spanning 1.24 lanes, which meant the one block the player is invited to
    // aim AT was also the one they could not line up on without hanging out of
    // their lane.
    name: "BARRELS",
    family: BLOCK,
    size: [BARRELS_WIDTH, (BARREL_RISE + BARREL_RADIUS) * 2],
    extent: {
      x: BARREL_SPREAD + BARREL_RADIUS + GLOW_BLEED,
      up: BARREL_RISE + BARREL_RADIUS + GLOW_BLEED,
      down: BARREL_RISE + BARREL_RADIUS + GLOW_BLEED,
    },
    debris: WATER,
    draw(ctx, cx, cy) {
      // Top-down, a barrel is concentric: a wide dark base ring on the tarmac, a
      // banded drum, a reflective band, then the lid — the highest surface, so
      // the lightest fill — with a rib across it to say "this is a top, not a
      // hole". The full-circle rings are what make it read as a drum standing
      // upright rather than a painted disc.
      const barrel = (x, y, r) => {
        glowPoly(ctx, circle(x, y, r), NEUTRAL_DEEP, 1.5, 7, CAR_FILL);
        glowPoly(ctx, circle(x, y, r * 0.85), NEUTRAL, 2, 10, CAR_FILL_RAISED);
        glowPoly(ctx, circle(x, y, r * 0.62), NEUTRAL_PALE, 1.5, 8, CAR_FILL_RAISED);
        glowPoly(ctx, circle(x, y, r * 0.38, 12), NEUTRAL_PALE, 1.5, 10, CAR_FILL_HIGH);
        glowLine(ctx, x - r * 0.3, y, x + r * 0.3, y, NEUTRAL_DEEP, 1.5, 5); // lid rib
      };

      // Offset on BOTH axes, so the pair reads as a diagonal rather than as a
      // pair of eyes — and so the gap between them survives the pair being
      // narrow enough to fit a lane. Measured rim to rim along the diagonal it
      // is ~10px, where measured straight across it would be under 5.
      barrel(cx - BARREL_SPREAD, cy + BARREL_RISE, BARREL_RADIUS);
      barrel(cx + BARREL_SPREAD, cy - BARREL_RISE, BARREL_RADIUS);
    },
  },

  {
    // The heavy one: a welded tank trap that is obviously not going to move. Its
    // spiky asterisk silhouette is what keeps it apart from the trestle at the
    // top of the screen, where both are only a few pixels of amber.
    name: "TETRA",
    family: BLOCK,
    size: [TETRA_ARM * 2, LANE_WIDTH * 0.9],
    extent: {
      x: TETRA_ARM + GLOW_BLEED,
      up: TETRA_REACH_Y + GLOW_BLEED,
      down: TETRA_REACH_Y + GLOW_BLEED,
    },
    debris: IMPACT, // welded steel — the heaviest hit on the road
    draw(ctx, cx, cy) {
      const R = TETRA_ARM;

      // Three beams 60 degrees apart, each an OPAQUE slab so the crossings look
      // welded instead of transparent.
      for (const a of [0, Math.PI / 3, (2 * Math.PI) / 3]) {
        const dx = Math.cos(a);
        const dy = Math.sin(a);
        const nx = -dy * TETRA_HALF_THICK; // perpendicular to the beam
        const ny = dx * TETRA_HALF_THICK;
        glowPoly(ctx, [
          [cx - dx * R + nx, cy - dy * R + ny], [cx + dx * R + nx, cy + dy * R + ny],
          [cx + dx * R - nx, cy + dy * R - ny], [cx - dx * R - nx, cy - dy * R - ny],
        ], NEUTRAL, 1.5, 9, CAR_FILL_RAISED);
        // Bright end caps — what sells the arms as sharpened steel.
        glowLine(ctx, cx + dx * R * 0.86, cy + dy * R * 0.86, cx + dx * R, cy + dy * R,
          NEUTRAL_PALE, 3, 9);
        glowLine(ctx, cx - dx * R * 0.86, cy - dy * R * 0.86, cx - dx * R, cy - dy * R,
          NEUTRAL_PALE, 3, 9);
      }

      // Hub plate: highest part, hiding all three crossings at once.
      glowPoly(ctx, ngon(cx, cy, 9, 6, Math.PI / 6), NEUTRAL_PALE, 1.5, 10, CAR_FILL_HIGH);
      glowPoly(ctx, ngon(cx, cy, 4, 6, Math.PI / 6), NEUTRAL_DEEP, 1, 6);
    },
  },

  {
    // The mine. A spiked ball: the silhouette alone says "this will hurt", so it
    // stays readable at speed even in the frame before the pulse comes round.
    // Small on purpose — a mine is a POINT threat, not a wall.
    name: "CALTROP",
    family: MINE,
    size: [26, 26],
    extent: {
      x: CALTROP_REACH + GLOW_BLEED,
      up: CALTROP_REACH + GLOW_BLEED,
      down: CALTROP_REACH + GLOW_BLEED,
    },
    pulse: true,
    draw(ctx, cx, cy, pulse) {
      const r = CALTROP_CORE;
      const spike = CALTROP_SPIKE + pulse * CALTROP_SPIKE_PULSE; // the spikes
                                                 // breathe; the core does not

      // Tapered triangles, not lines, so they survive the glow at this size —
      // see polygon.js's caltropSpikes, which pickupshapes.js's MINE glyph
      // draws from too so the crate keeps the hazard's exact silhouette.
      for (const tri of caltropSpikes(cx, cy, r, spike, 3.5)) {
        glowPoly(ctx, tri, ENEMY, 1.5, 9, CAR_FILL_RAISED);
      }

      glowPoly(ctx, ngon(cx, cy, r, 6), ENEMY_PALE, 2, 11, CAR_FILL_HIGH);

      // Pulsing core, in ALPHA rather than size: a mine that visibly grew would
      // read as already detonating.
      ctx.save();
      ctx.globalAlpha = 0.3 + 0.7 * pulse;
      glowPoly(ctx, ngon(cx, cy, r * 0.42, 6), CRITICAL_FLASH, 1.5, 10, HAZARD);
      ctx.restore();
    },
  },

  {
    // The spike strip. A long belt of teeth laid across the lanes — the MINE
    // family's second entry, and the reason it belongs there rather than with
    // the amber blocks is that somebody LAID it: it is hostile action on the
    // tarmac, not road furniture, and the red-and-pulsing family is what says
    // so. See SPIKES_WIDTH above for the silhouette argument against the
    // caltrop.
    name: "SPIKES",
    family: MINE,
    size: [SPIKES_WIDTH, SPIKES_SPINE_HALF * 2],
    extent: {
      x: SPIKES_WIDTH / 2 + GLOW_BLEED,
      up: SPIKES_REACH_Y + GLOW_BLEED,
      down: SPIKES_REACH_Y + GLOW_BLEED,
    },
    pulse: true,
    draw(ctx, cx, cy, pulse) {
      const half = SPIKES_WIDTH / 2;
      const tooth = SPIKES_TOOTH + pulse * SPIKES_TOOTH_PULSE; // teeth breathe,
                                                  // the belt itself does not
      // The belt: one opaque slab the teeth are mounted on, so the strip still
      // reads as a single laid object at distance rather than as a scattering
      // of small red marks.
      glowPoly(ctx, [
        [cx - half, cy - SPIKES_SPINE_HALF], [cx + half, cy - SPIKES_SPINE_HALF],
        [cx + half, cy + SPIKES_SPINE_HALF], [cx - half, cy + SPIKES_SPINE_HALF],
      ], ENEMY, 1.5, 9, CAR_FILL_RAISED);

      // Teeth, alternating up-road and down-road so the strip bites whichever
      // way it is crossed — and so the silhouette is a saw rather than a comb.
      for (let i = 0; i < SPIKES_TOOTH_COUNT; i++) {
        const x = cx - half + ((i + 0.5) / SPIKES_TOOTH_COUNT) * SPIKES_WIDTH;
        const dy = i % 2 === 0 ? -1 : 1;
        const base = cy + dy * SPIKES_SPINE_HALF;
        glowPoly(ctx, [
          [x, base + dy * tooth],
          [x - 3, base],
          [x + 3, base],
        ], ENEMY_PALE, 1.2, 8, CAR_FILL_HIGH);
      }

      // The live tell, in ALPHA like the caltrop's core and for the same
      // reason: a strip that visibly grew would read as already going off.
      ctx.save();
      ctx.globalAlpha = 0.25 + 0.75 * pulse;
      glowLine(ctx, cx - half, cy, cx + half, cy, CRITICAL_FLASH, 1.5, 10);
      ctx.restore();
    },
  },
];

// Look an obstacle up by name. Callers select through this rather than by
// writing a bare index, for the reason carShapeIndex documents: inserting an
// entry in the middle of the catalogue must not silently turn every mine on the
// road into a pile of cones. Throws rather than falling back to entry 0.
export function obstacleShapeIndex(name) {
  const i = OBSTACLE_SHAPES.findIndex((s) => s.name === name);
  if (i === -1) throw new Error(`unknown obstacle shape: ${name}`);
  return i;
}

// Draw obstacle `index` centred at (cx, cy). `pulse` (0..1) drives the mine's
// blink and is ignored by the inert blocks.
export function drawObstacleShape(ctx, cx, cy, index, pulse = 1) {
  const shape = OBSTACLE_SHAPES[index] ?? OBSTACLE_SHAPES[0];
  shape.draw(ctx, cx, cy, pulse);
}

// Half-extents of the ARTWORK, in px from the centre. Callers add glow padding.
export function obstacleExtent(index) {
  return (OBSTACLE_SHAPES[index] ?? OBSTACLE_SHAPES[0]).extent;
}
