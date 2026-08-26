// The two- and three-wheeler silhouette catalogue — the hulls a future phase's
// bikes and trikes will wear, chosen from a top-down Harley/Bugatti reference
// and kept here, drawable, until the phase that gives them behaviour.
//
// NO CAR TYPES YET, ON PURPOSE. This is bossshapes.js's arrangement, for
// bossshapes.js's reason: carshapes.js's CAR_SHAPES is 1:1 with cartypes.js and
// that pairing is enforced by test/road-and-caches.test.js's "one car type per
// silhouette", so a shape in that catalogue with no type is a broken invariant,
// not a work in progress. The finished ARTWORK lives here and the TYPES get
// written later, at which point a hull moves across to CAR_SHAPES beside its
// cartypes.js record, in one piece, unedited.
//
// Staging them here also keeps them out of sprites.js's cache budget (see
// cartypes.js's SPRITE-CACHE BUDGET note), which is sized off the number of car
// TYPES and would otherwise be paying for four hulls nothing can spawn. Each of
// these costs ~0.5 MB of sprite cache the day it gets a type, and not before.
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

// A rectangle in fraction space, corners (x1,y1)-(x2,y2). The same helper
// bossshapes.js keeps, for the same reason: `solid()` is NOT mirrored the way a
// profile is, so anything symmetric built here is emitted twice or centred.
const box = (x1, y1, x2, y2) => [[x1, y1], [x2, y1], [x2, y2], [x1, y2]];

export const CYCLE_SHAPES = [
  // =========================================================================
  // MOTORCYCLE — two wheels, single track, both entirely clear of the spine.
  // =========================================================================
  {
    family: "MOTORCYCLE",
    name: "CRUISER",
    pitch: "wide bars and saddlebags framing a bare rear tyre",
    size: [32, 66],
    // Bars -> tank -> seat. Stops at 0.42: everything behind that is tyre.
    profile: [
      [0, -0.52], [0.16, -0.46], [0.34, -0.30], [0.44, -0.10],
      [0.42, 0.10], [0.32, 0.26], [0.20, 0.38], [0, 0.42],
    ],
    // Skinny front, fat rear — the cruiser's whole stance in two numbers.
    wheels: [[-0.74, 4, 9, 0, true], [0.66, 6, 10, 0, true]],
    exhaust: [0.52, 0.30, 0.56],
    overhang: { x: 1.14 },
    flat({ line }, c, thrust, headlight) {
      line(-0.20, -0.10, -0.13, -0.80, c); // fork legs, all the way out to the tyre
      line(0.20, -0.10, 0.13, -0.80, c);
      line(0, -0.62, 0, -0.46, headlight, 1.5, 8); // headlamp ahead of the bars
      line(-0.16, 0.40, -0.10, 0.74, c);   // swingarm, out to the rear tyre
      line(0.16, 0.40, 0.10, 0.74, c);
    },
    raised({ solid }, c) {
      // Teardrop tank: the widest thing on the spine.
      solid([[0, -0.34], [0.34, -0.16], [0.32, 0.08], [0, 0.20], [-0.32, 0.08], [-0.34, -0.16]], c);
      // Saddlebags — OUTBOARD of the rear tyre, framing it rather than hiding it.
      solid(box(-1.02, 0.34, -0.54, 0.78), c, CAR_FILL_HIGH);
      solid(box(0.54, 0.34, 1.02, 0.78), c, CAR_FILL_HIGH);
    },
    top({ line }, c) {
      line(-1.10, -0.46, 1.10, -0.46, c, 1.5, 7); // bars, the widest point
      line(-1.10, -0.54, -1.10, -0.36, c, 1.5, 7); // mirrors
      line(1.10, -0.54, 1.10, -0.36, c, 1.5, 7);
    },
  },

  {
    family: "MOTORCYCLE",
    name: "RACER",
    pitch: "pointed fairing and winglets — the anti-cruiser",
    size: [28, 64],
    profile: [
      [0, -0.60], [0.20, -0.52], [0.40, -0.32], [0.46, -0.06],
      [0.36, 0.16], [0.20, 0.34], [0.10, 0.46], [0, 0.48],
    ],
    wheels: [[-0.76, 4, 9, 0, true], [0.68, 5, 10, 0, true]],
    exhaust: [0.16, 0.40, 0.60],
    overhang: { x: 1.04 },
    flat({ line }, c, thrust, headlight) {
      line(-0.26, -0.44, -0.30, -0.44, headlight, 1.5, 8); // slit lamps
      line(0.26, -0.44, 0.30, -0.44, headlight, 1.5, 8);
      line(-0.15, -0.06, -0.10, -0.82, c); // forks, out to the tyre
      line(0.15, -0.06, 0.10, -0.82, c);
      line(-0.12, 0.46, -0.08, 0.76, c);   // swingarm
      line(0.12, 0.46, 0.08, 0.76, c);
      line(0, -0.56, 0, -0.10, c);         // fairing centre seam
    },
    raised({ solid }, c) {
      // Winglets — swept back and OUTBOARD, well clear of the front tyre.
      solid([[0.42, -0.34], [1.00, -0.16], [1.00, 0.02], [0.40, -0.06]], c);
      solid([[-0.42, -0.34], [-1.00, -0.16], [-1.00, 0.02], [-0.40, -0.06]], c);
      // Tail unit, standing highest — the sport bike's hump.
      solid([[0, 0.06], [0.22, 0.20], [0.16, 0.44], [-0.16, 0.44], [-0.22, 0.20]], c, CAR_FILL_HIGH);
    },
    top({ line }, c) {
      line(-0.62, -0.28, 0.62, -0.28, c, 1.5, 7); // clip-ons: narrow, not cruiser bars
    },
  },

  // =========================================================================
  // TRICYCLE — three wheels, and the two of them differ by WHICH END carries
  // the pair. That is the whole distinction between these hulls, so both keep
  // their odd wheel solo and their twin axle outboard, and nothing else about
  // them is allowed to converge.
  // =========================================================================
  {
    family: "TRICYCLE",
    name: "GLIDE",
    pitch: "cruiser front end, trunk slung between two rear tyres",
    size: [38, 66],
    // Narrow bike front end that swells into a wide rear body.
    profile: [
      [0, -0.56], [0.14, -0.50], [0.28, -0.34], [0.34, -0.12], [0.30, 0.06],
      [0.54, 0.20], [0.78, 0.36], [0.80, 0.74], [0.58, 0.88], [0, 0.90],
    ],
    // Front solo and entirely ahead of the body; rears outboard of the flank,
    // so all three read at a glance.
    wheels: [[-0.76, 4, 9, 0, true], [0.58, 5, 10, 10]],
    exhaust: [0.44, 0.84, 0.98],
    overhang: { x: 1.30 },
    flat({ line }, c, thrust, headlight) {
      line(0, -0.66, 0, -0.50, headlight, 1.5, 8);
      line(-0.16, -0.08, -0.10, -0.82, c); // forks, out to the tyre
      line(0.16, -0.08, 0.10, -0.82, c);
      line(-0.74, 0.30, 0.74, 0.30, c);    // body/axle seam
    },
    raised({ solid }, c) {
      solid([[0, -0.36], [0.28, -0.20], [0.26, 0.02], [0, 0.14], [-0.26, 0.02], [-0.28, -0.20]], c);
      solid(box(-0.62, 0.40, 0.62, 0.78), c, CAR_FILL_HIGH); // the trunk
    },
    top({ line }, c) {
      // The SAME bars as CRUISER, deliberately: this is that bike with an axle
      // bolted under the back of it, and the front end is where you read that.
      line(-1.10, -0.46, 1.10, -0.46, c, 1.5, 7);
      line(-1.10, -0.54, -1.10, -0.36, c, 1.5, 7);
      line(1.10, -0.54, 1.10, -0.36, c, 1.5, 7);
      line(-0.62, 0.59, 0.62, 0.59, c);
    },
  },

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

// Hulls grouped in catalogue order, so a gallery can show the motorcycles and
// the tricycles as two families. Derived rather than hand-listed, so adding or
// dropping a hull can't leave a stale grouping behind — bossGroups()'s trick,
// for the same reason.
export function cycleFamilies() {
  const families = [];
  for (const s of CYCLE_SHAPES) {
    let f = families.find((x) => x.name === s.family);
    if (!f) families.push((f = { name: s.family, shapes: [] }));
    f.shapes.push(s);
  }
  return families;
}
