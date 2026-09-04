// The boss silhouette catalogue — the hulls Phase 10's named enemies will wear,
// chosen from a wider set of candidates and kept here, drawable, until the phase
// that gives them behaviour.
//
// NO CAR TYPES YET, ON PURPOSE. carshapes.js's CAR_SHAPES is 1:1 with cartypes.js
// and that pairing is enforced by test/road-and-caches.test.js's "one car type per
// silhouette" — a shape in that catalogue with no type is a broken invariant,
// not a work in progress. So the finished ARTWORK lives here and the TYPES get
// written in the boss session, at which point each entry moves across to
// CAR_SHAPES beside its cartypes.js record, in one piece, unedited.
//
// Keeping them out of CAR_SHAPES until then also keeps them out of sprites.js's
// cache budget (see cartypes.js's SPRITE-CACHE BUDGET note), which is sized off
// the number of car TYPES and would otherwise be paying for eight hulls that
// nothing on the road can spawn.
//
// TWO HULLS, TWO VEHICLES — was eight and five. The combat drone and the
// cargo drone keep their one apiece; the armoured rig and the hovercraft have
// none left (see below). `group` says which vehicle a hull belongs to, so
// the gallery can show a vehicle's options side by side and the boss session
// can find them.
//
// SIX ARE GONE FROM THIS LIST, and that is this file working as intended
// rather than hulls being lost: the SIEGE MORTAR went first, then the ARMORED
// QUAD the day cartypes.js grew the gunship record that wears it, then the
// BUNKER TRAILER the day it grew a second boss's own record, then the SKIRTED
// BARGE the day it grew a third, then the CATAMARAN GUNSHIP the day it grew a
// fourth. The ROAD TRAIN went last, and NOT to a boss record — it graduated
// the day cartypes.js grew an ordinary (if rare) ambient hostile of its own,
// which costs this file nothing extra: a hull graduates when a CAR_TYPES
// entry claims it, boss or not. All six are in carshapes.js now. See the
// notes where each group used to be, and expect this count to keep falling
// as the rest are claimed.
//
// THE GRAMMAR IS carshapes.js's. Read that file's header first: `profile` is the
// right half of a symmetric hull (nose -1, tail +1) in fractions of hw/hh,
// `parts` gives an articulated vehicle one such half per hull, and the drawing
// happens in strict bottom-up layers (shadow, low, wheels/tracks, body, flat,
// raised, wing, top, exhaust, rotors). Everything below is written in those
// terms and adds no new drawing code of its own.
//
// THE THREE THINGS THAT ARE NEW here, all now supported by carshapes.js:
//
//   tracks   a wheel stretched into a tread band — the tank, now graduated to
//            carshapes.js, and the only user this list ever had for it
//   hover    a ground track offset down-screen, replacing the tyres entirely as
//            the "this thing touches the ground" cue — the hovercraft and the
//            combat drones
//   rotors   spinning discs drawn ABOVE the hull — the drones. The GUN RING
//            below is the last user left here; the quad took the mechanism to
//            carshapes.js with it
//
// A NOTE ON HOLES. A `profile` is a filled loop, so a hull cannot have a hole
// punched in it. Two candidates need one anyway — the skycrane must show the car
// slung in its bay, the catamaran must show the road between its pontoons — and
// both get it the same way: the BODY is reduced to a narrow spine or a pair of
// end beams, and the bulk is drawn as separate opaque pieces in low(). The gap
// between those pieces is the hole. The gun ring is the exception that does
// punch one, via a keyhole polygon (outer rim, then the inner rim walked back
// the other way); the single radial seam that leaves behind reads as a panel
// join, which is why it is allowed there and nowhere else.

import { CAR_FILL, CAR_FILL_HIGH } from "../engine/palette.js";
import { polygon } from "./polygon.js";

// ---------------------------------------------------------------------------
// Small geometry helpers. These build EXPLICIT point lists for solid(), which
// is not mirrored — unlike a `profile`, which is. So anything built here that
// wants to be symmetric is either centred on x=0 or emitted twice.
// ---------------------------------------------------------------------------

// A closed ring of points at radius `r` (in hw/hh fractions). Only circular when
// the shape's w and h are equal; on a rectangular shape it comes out elliptical,
// which is what the hovercraft skirt wants anyway.
const ring = (r, n = 20, phase = 0) => polygon(0, 0, r, r, n, phase);

// An annulus as a single keyhole polygon: out along the outer rim, back along
// the inner one. Fills with a genuine hole in the middle (nonzero winding), at
// the cost of one visible radial seam where the two rims meet.
function annulus(outer, inner, n = 22) {
  const o = ring(outer, n);
  const i = ring(inner, n).reverse();
  return [...o, o[0], i[i.length - 1], ...i];
}

// A rectangle in fraction space, corners (x1,y1)-(x2,y2).
function box(x1, y1, x2, y2) {
  return [[x1, y1], [x2, y1], [x2, y2], [x1, y2]];
}

// The same rectangle on both flanks — the common case for a bolted-on plate.
function pair(x1, y1, x2, y2) {
  return [box(x1, y1, x2, y2), box(-x2, y1, -x1, y2)];
}

// Mirror an explicit point list across the centreline.
function flip(pts) {
  return pts.map(([x, y]) => [-x, y]);
}

// ---------------------------------------------------------------------------
// The hulls. Each carries `group` (which of the five vehicles it is) and `pitch`
// (the one line that says what this hull is FOR), and the gallery prints both
// under the cell. `pitch` is not a caption for its own sake: it is the reason
// this hull survived the cut, and the boss session will be reading it to decide
// what behaviour the artwork has already promised the player.
// ---------------------------------------------------------------------------
export const BOSS_SHAPES = [
  // =========================================================================
  // ARMORED RIG — GRADUATED. The ROAD TRAIN that stood here is now a car type
  // (cartypes.js's `roadtrain` — rare, ambient, and explicitly not a boss) and
  // its artwork lives in carshapes.js, beside that record. This note is what
  // is left of the group, and it is deliberately not an empty entry:
  // bossGroups() derives its groups from the list, so a vehicle with no hulls
  // left simply stops being one, and the gallery stops offering a choice that
  // has already been made.
  // =========================================================================

  // =========================================================================
  // TANK — GRADUATED. The SIEGE MORTAR that stood here is now a car type and
  // its artwork lives in carshapes.js, beside the cartypes.js record that
  // spawns it. This note is what is left of the group, and it is deliberately
  // not an empty entry: bossGroups() derives its groups from the list, so a
  // vehicle with no hulls left simply stops being one, and the gallery stops
  // offering a choice that has already been made.
  //
  // SEVEN HULLS REMAIN, four vehicles. See the header.
  // =========================================================================

  // =========================================================================
  // MILITARY HOVERCRAFT — GRADUATED, both of them. The SKIRTED BARGE went
  // first (the third boss); the CATAMARAN GUNSHIP that stood here after it
  // followed the same day cartypes.js grew a fourth boss's own record, the
  // same move the SIEGE MORTAR and the BUNKER TRAILER made above. Both are
  // in carshapes.js now, and this group has nothing left to offer.
  // =========================================================================

  // =========================================================================
  // HEAVY COMBAT DRONE — flying, so `hover` drops the track much further than
  // the hovercraft's: the gap between hull and track IS the altitude.
  //
  // ONE HULL LEFT. The other was the ARMORED QUAD, and it is the second entry
  // this list has handed over: it moved to carshapes.js the day cartypes.js
  // grew the `gunship` record, and it took the four-rotor reading of this
  // vehicle with it. What remains is the reading that hull was the safe
  // alternative to — the ring is the one shape in the game that is round.
  // =========================================================================

  {
    group: "COMBAT DRONE",
    name: "GUN RING",
    pitch: "a hole through the middle — nothing else in the game is round",
    size: [74, 74],
    hover: { drop: 46, scale: 0.54 },
    // One open annulus with the rotors set INSIDE the rim and the gun on a hub
    // suspended in the middle. No arms, no fuselage. The city behind shows
    // through the centre, which at this size is very hard to miss. The risk is
    // that a ring is so far outside the game's plate-and-chamfer vocabulary
    // that it reads as a pickup or a UI element rather than as an enemy.
    profile: [[0, -0.30], [0.22, -0.20], [0.24, 0.14], [0, 0.28]],
    rotors: [[0, -0.62, 11], [-0.62, 0, 11], [0.62, 0, 11], [0, 0.62, 11]],
    overhang: { x: 1.02, up: 1.02, down: 1.02 },
    low({ solid }, c) {
      solid(annulus(0.96, 0.34, 24), c, CAR_FILL);
      // Three thin spokes holding the hub in the middle of the ring.
      for (const a of [-Math.PI / 2, Math.PI / 6, (Math.PI * 5) / 6]) {
        const nx = -Math.sin(a) * 0.05;
        const ny = Math.cos(a) * 0.05;
        solid([
          [Math.cos(a) * 0.20 + nx, Math.sin(a) * 0.20 + ny],
          [Math.cos(a) * 0.50 + nx, Math.sin(a) * 0.50 + ny],
          [Math.cos(a) * 0.50 - nx, Math.sin(a) * 0.50 - ny],
          [Math.cos(a) * 0.20 - nx, Math.sin(a) * 0.20 - ny],
        ], c, CAR_FILL);
      }
    },
    raised({ solid, line }, c, thrust, headlight) {
      solid(box(-0.11, -0.60, 0.11, -0.10), c, CAR_FILL_HIGH); // hub gun
      line(0, -0.56, 0, -0.16, c);
      line(-0.18, -0.60, 0.18, -0.60, headlight, 1.5, 8);
    },
    top({ line }, c) {
      // Rim segment joins, so the ring reads as built rather than drawn.
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * Math.PI * 2 + Math.PI / 8;
        line(Math.cos(a) * 0.36, Math.sin(a) * 0.36, Math.cos(a) * 0.94, Math.sin(a) * 0.94, c);
      }
    },
  },


  // =========================================================================
  // HEAVY CARGO DRONE — the one that has to LIFT the player's car, so the hull
  // is built around one requirement: the car stays VISIBLE while carried. Hence
  // two end beams rather than a fuselage, an open middle, and jaws that close on
  // the car's flanks where they cannot cover it -- and `hover: { blot: false }`,
  // since the car is directly beneath and the track would be drawn over it.
  // =========================================================================

  {
    group: "CARGO DRONE",
    name: "CLAW LIFTER",
    pitch: "jaws close on the car's flanks — the grab is animatable",
    size: [88, 92],
    // Two cross-beams, fore and aft, with a hinged claw hanging off each flank.
    // The whole middle is open; the car is longer than the beam spacing, so it
    // sticks out nose and tail and the jaws visibly close on its sides. The
    // pitch is the ANIMATION — open, close, lift is a three-beat action the
    // other two variants cannot show.
    // Flies, but with the ground track switched OFF rather than merely absent:
    // the track's leader runs down the centreline, so on this hull it would be
    // drawn across the very car the vehicle exists to carry. See carshapes.js's
    // ground-contact note for why that distinction is written down rather than
    // assumed.
    hover: { blot: false },
    // hauler.js's HAULER colour is chosen to sit well below the player's own
    // cyan in value — see that file's render() comment for why — which means
    // it never crosses bloom's threshold no matter how this hull draws it.
    // Through Phase 15d-i that was still fine: shadowBlur gives ANY colour a
    // halo in proportion to its own brightness, however dim, so "dim" meant
    // "a quieter glow" rather than "no glow at all". Bloom is all-or-nothing
    // against an absolute threshold, so retiring shadowBlur here would have
    // made the ONE hull deliberately drawn muted the one hull that reads as
    // completely unlit — found live, the same way the rotor blade flicker
    // was. `localGlow` (drawShapeObject's own header explains the mechanism)
    // opts this hull back into a modest local shadowBlur for its whole draw,
    // which is a bounded exception rather than a reason to doubt the rest of
    // the catalogue: every other shape's colours were chosen to clear
    // threshold on their own, and only this one was chosen not to.
    // RE-EXAMINED AT BLOOM_THRESHOLD 0.55 (Phase 15e-ii-a, down from the 0.75
    // this exception was written against). HAULER (#197c88) peaks on B at
    // 0.5333 — 0.0167 UNDER 0.55, margin thin enough that the question was
    // worth asking again: does a small palette nudge retire this exception?
    // NO. hauler.js's render() comment is explicit that HAULER sits WELL below
    // PLAYER in value ON PURPOSE — the CLAW LIFTER closes AROUND the car it is
    // rescuing, and two similar-brightness cyans overlapping like that merge
    // into one mass with the car lost inside it. Closing a 0.0167 gap would
    // mean brightening HAULER, which is exactly the move that constraint rules
    // out — the margin this hull was given from PLAYER is not slack to spend
    // on clearing bloom, it is the point of the colour. localGlow stays.
    localGlow: true,
    parts: [
      [[0, -0.98], [0.86, -0.92], [0.90, -0.62], [0.80, -0.52], [0, -0.50]],
      [[0, 0.50], [0.80, 0.52], [0.90, 0.62], [0.86, 0.92], [0, 0.98]],
    ],
    rotors: [[-0.64, -0.76, 11], [0.64, -0.76, 11], [-0.64, 0.76, 11], [0.64, 0.76, 11]],
    overhang: { x: 1.04 },
    low({ solid }, c) {
      // A C-clamp per flank: a spine down the side with a jaw reaching inward
      // at the waist, exactly where the car's door would be.
      const claw = [
        [0.62, -0.50], [0.90, -0.50], [0.90, 0.50], [0.62, 0.50],
        [0.62, 0.18], [0.36, 0.14], [0.36, -0.14], [0.62, -0.18],
      ];
      solid(claw, c, CAR_FILL);
      solid(flip(claw), c, CAR_FILL);
    },
    flat({ line }, c, thrust, headlight) {
      line(-0.28, -0.94, 0.28, -0.94, headlight, 1.5, 8);
      line(-0.86, -0.72, 0.86, -0.72, c);
      line(-0.86, 0.72, 0.86, 0.72, c);
    },
    raised({ solid, line }, c, thrust) {
      solid(box(-0.26, -0.90, 0.26, -0.58), c, CAR_FILL_HIGH); // forward avionics
      solid(box(-0.26, 0.58, 0.26, 0.90), c, CAR_FILL_HIGH);
      // Hinge shoulders, where each claw pivots — the tell that the jaws move.
      for (const p of pair(0.58, -0.58, 0.76, -0.44)) solid(p, c, thrust);
      for (const p of pair(0.58, 0.44, 0.76, 0.58)) solid(p, c, thrust);
      line(-0.62, -0.18, -0.36, -0.14, c);
      line(0.62, -0.18, 0.36, -0.14, c);
    },
  },

];

// Candidates grouped in catalogue order, for a gallery that wants to show the
// three options for one vehicle side by side. Derived rather than hand-listed,
// so adding or dropping a candidate can't leave a stale grouping behind.
export function bossGroups() {
  const groups = [];
  for (const s of BOSS_SHAPES) {
    let g = groups.find((x) => x.name === s.group);
    if (!g) groups.push((g = { name: s.group, shapes: [] }));
    g.shapes.push(s);
  }
  return groups;
}
