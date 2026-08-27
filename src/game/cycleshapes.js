// The two- and three-wheeler silhouette catalogue — the hulls a future phase's
// bikes and trikes will wear, chosen from a top-down Harley/Bugatti reference
// and kept here, drawable, until the phase that gives them behaviour.
//
// THREE OF THE ORIGINAL FOUR HAVE LEFT, and the way they left is the point of
// this file: CRUISER, RACER and GLIDE moved across to carshapes.js's CAR_SHAPES
// the day cartypes.js gave each of them a record (the outrunner, the outrider
// and the sower). They went in one piece and unedited, which is what a staging
// catalogue is for. DELTA is what is left, and it is still here for the reason
// all four were.
//
// NO CAR TYPE YET, ON PURPOSE. This is bossshapes.js's arrangement, for
// bossshapes.js's reason: carshapes.js's CAR_SHAPES is 1:1 with cartypes.js and
// that pairing is enforced by test/road-and-caches.test.js's "one car type per
// silhouette", so a shape in that catalogue with no type is a broken invariant,
// not a work in progress. The finished ARTWORK lives here and the TYPE gets
// written later, at which point the hull moves across to CAR_SHAPES beside its
// cartypes.js record, in one piece, unedited.
//
// Staging it here also keeps it out of sprites.js's cache budget (see
// cartypes.js's SPRITE-CACHE BUDGET note), which is sized off the number of car
// TYPES and would otherwise be paying for a hull nothing can spawn. It costs
// ~0.5 MB of sprite cache the day it gets a type, and not before.
//
// THE WHOLE FLEET'S NOTES, INCLUDING THE HULLS THAT LEFT. Everything from here
// down describes how a two- or three-wheeler is drawn, and CRUISER, RACER and
// GLIDE are still named in it by way of example. They are worked examples, not
// a stale index: the three are in carshapes.js now and its own entry for them
// points back here rather than restating any of this. Keeping one copy is the
// point — a bike's drawing rules do not change with which array it sits in.
//
// THE GRAMMAR IS carshapes.js's. Read that file's header first: `profile` is
// the right half of a symmetric hull (nose -1, tail +1) in fractions of hw/hh,
// and the drawing happens in strict bottom-up layers (shadow, low, wheels,
// body, flat, raised, wing, top, exhaust). Everything below is written in those
// terms and adds no new drawing code of its own.
//
// THE ONE IDEA THAT MAKES A BIKE LOOK LIKE A BIKE. A car's profile runs the
// whole length of the shape and its tyres peek out from under the bodywork. A
// motorcycle seen from above is the opposite: a NARROW SPINE — bars, tank,
// seat — occupying barely half the length, with both wheels living entirely
// OUTSIDE it. So every profile here stops well short of ±1.0 (CRUISER's body
// spans just -0.52..0.42) and the wheels are parked beyond its ends, where no
// bodywork can cover them. That is what buys "every wheel visible" without any
// special-casing in the renderer.
//
// This is safe because the HITBOX does not come from the profile: collisions.js
// tests the type's own `w`/`h` box, and the profile only feeds effects.js's
// wreck break-up. A short body means a bike's wreck shatters along its spine
// and not its tyres, which is the right read anyway.
//
// THE TWO WHEEL IDIOMS, and the one engine change these rely on:
//
//   SOLO      `solo` (the 5th slot of a `wheels` entry, added to carshapes.js
//             for these) draws ONE wheel on the centreline instead of a
//             mirrored pair. Every single-track axle here uses it — both of
//             CRUISER's and RACER's, and the odd wheel of each trike. Drawing
//             one wheel rather than a pair 0px apart matters: laying the same
//             tread down twice doubles its shadowBlur, and that tyre would read
//             visibly brighter than every other on the road.
//   OUTBOARD  a wide profile at the axle plus `expose` 10, so the tyre stands
//             clear of the flank. The trikes' twin axles.
//
// WHEEL PROPORTION IS IN PIXELS, NOT FRACTIONS. `ww`/`wl` do NOT scale with a
// type's `w`/`h` the way the profile does, so a type that overrides `size` must
// revisit them or the tyres will come out the wrong size for the body. They are
// set here at roughly 28% of hull length; at 45% a tyre stops reading as a
// wheel and starts reading as a ladder.
//
// Fork and swingarm arms are drawn in `flat()`, which lands AFTER the body but
// over the road, so an arm can reach out past the spine to meet a wheel that
// sits outside it — without them the wheels look detached. Saddlebags and
// winglets are `raised()` and deliberately OUTBOARD of the tyres rather than
// over them, so they frame a wheel instead of hiding it.
import { CAR_FILL_HIGH } from "../engine/palette.js";

export const CYCLE_SHAPES = [
  // =========================================================================
  // TRICYCLE — three wheels, and the pair of them differed by WHICH END carried
  // the twin axle. GLIDE (rear pair, trunk between the tyres) has gone to
  // CAR_SHAPES as the sower; this is the other half of that contrast, and it
  // keeps its odd wheel solo and its twin axle outboard as it always did.
  // =========================================================================
  {
    family: "TRICYCLE",
    name: "DELTA",
    pitch: "widest at the NOSE — the one hull that tapers backwards",
    size: [36, 62],
    profile: [
      [0, -0.70], [0.30, -0.64], [0.62, -0.48], [0.72, -0.22],
      [0.56, 0.04], [0.38, 0.26], [0.22, 0.42], [0, 0.46],
    ],
    // Fronts stand outboard of a wide shoulder AND reach past the nose; the
    // rear is solo and almost entirely behind the body.
    wheels: [[-0.50, 5, 10, 10], [0.68, 6, 10, 0, true]],
    exhaust: [0.18, 0.34, 0.54],
    overhang: { x: 1.24 },
    flat({ line }, c, thrust, headlight) {
      line(-0.56, -0.52, -0.26, -0.52, headlight, 1.5, 8);
      line(0.26, -0.52, 0.56, -0.52, headlight, 1.5, 8);
      line(0, -0.64, 0, -0.16, c);
      line(-0.14, 0.44, -0.09, 0.72, c); // swingarm out to the rear tyre
      line(0.14, 0.44, 0.09, 0.72, c);
    },
    raised({ solid }, c) {
      // Aero shrouds INBOARD of the front tyres — they sit between wheel and
      // cockpit, so neither tyre is covered.
      solid([[-0.54, -0.56], [-0.28, -0.46], [-0.30, -0.16], [-0.58, -0.26]], c);
      solid([[0.54, -0.56], [0.28, -0.46], [0.30, -0.16], [0.58, -0.26]], c);
      solid([[0, -0.30], [0.26, -0.10], [0.22, 0.18], [0, 0.28], [-0.22, 0.18], [-0.26, -0.10]], c);
      solid([[0.14, 0.28], [0.30, 0.36], [0.24, 0.50], [-0.24, 0.50], [-0.30, 0.36], [-0.14, 0.28]], c, CAR_FILL_HIGH);
    },
  },
];

// Hulls grouped in catalogue order, so a gallery can show whichever families
// are still staged here. Derived rather than hand-listed, so adding or dropping
// a hull can't leave a stale grouping behind — bossGroups()'s trick, for the
// same reason, and the reason moving three hulls out left the gallery correct
// without a line of work.
export function cycleFamilies() {
  const families = [];
  for (const s of CYCLE_SHAPES) {
    let f = families.find((x) => x.name === s.family);
    if (!f) families.push((f = { name: s.family, shapes: [] }));
    f.shapes.push(s);
  }
  return families;
}
