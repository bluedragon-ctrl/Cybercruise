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
// FOUR HULLS, THREE VEHICLES — was eight and five. The combat drone and the
// cargo drone keep their one apiece and the armoured rig and the hovercraft
// have none left (see below); the FIGHTER PLANE is the one group that arrived
// here rather than leaving, two hulls for an airborne enemy that has no type
// or tactic yet — precisely what this file is for. `group` says which vehicle a hull belongs to, so
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

  // =========================================================================
  // FIGHTER PLANE — a FIXED-WING aircraft, which nothing in the game has been
  // before: every flying hull to date (the quad, the catamaran, the gun ring,
  // the claw lifter) is a rotorcraft that station-keeps. A plane cannot hover
  // and cannot hold a lane, so whatever eventually wears one of these hulls is
  // committed to crossing the frame — the artwork is here to make that decision
  // concrete before the session that takes it.
  //
  // NO TYPE, NO TACTIC, ON PURPOSE. This is artwork only, exactly as the header
  // describes: behaviours.js's airborne tactic is `hover`, which station-keeps
  // and is the wrong verb for both of these, and inventing the right one is the
  // work these hulls are waiting on rather than something to slip in beside
  // them.
  //
  // TWO HULLS, ONE QUESTION: whether a delta keeps a tail. They are deliberately
  // the two ends of that rather than two points near each other — a third
  // candidate (a CRANKED DELTA, kinked leading edge, single fin) sat between
  // them and was dropped for exactly that reason: the kink is a ~6px feature at
  // 1x, so it would have read as the STRIKE DELTA at road scale while costing a
  // second hull's worth of catalogue.
  //
  // NEITHER HAS AN ANIMATED PART, and that is what separates them from every
  // other flying hull here. A rotorcraft sells flight with its rotors; a plane
  // has none, no wheels and no tracks, so the whole "this is not on the road"
  // claim rests on two static cues instead:
  //
  //   THE GROUND TRACK IS DROPPED MUCH FURTHER than any other hull's. The gun
  //   ring flies at 46 and the gunship (carshapes.js) at 32; these fly at 66
  //   and 74, with a SMALLER ring (0.45/0.50 against 0.54). A small, distant
  //   contact reads as high, and that ramp is the only altitude scale the game
  //   has. It also sizes the sprite: shapeExtent adds `drop + hh * scale` to the
  //   bottom, which already reaches well past the burners, so neither entry
  //   needs an `overhang.down` to keep its thrust in frame.
  //
  //   THE BURNERS RUN PAST THE TAIL (`y2` over 1.0 on the delta), which no
  //   ground car does — an exhaust ending at the bodywork is a tailpipe, one
  //   that keeps going is a jet. Both set `thrustWide`, so the plume is the 4px
  //   draw rather than the standard 3.
  // =========================================================================

  {
    group: "FIGHTER PLANE",
    name: "STRIKE DELTA",
    pitch: "stubby and fuselage-led — the wing is the smaller half",
    size: [72, 78],
    hover: { drop: 66, scale: 0.45 },
    // Six points, and the profile is the FUSELAGE only: the wings are opaque
    // pieces in low(), the same construction the catamaran uses for its
    // pontoons, so the body reads as sitting on top of the wing rather than as
    // one flat plate with it.
    profile: [[0, -1.00], [0.09, -0.76], [0.12, -0.20], [0.14, 0.56], [0.10, 0.88], [0, 0.92]],
    exhaust: [0.09, 0.88, 1.12],
    thrustWide: true,
    // Nothing reaches past 0.74 in x (the wingtips), and the profile only
    // reaches 0.14 — so this has to be stated, or the sprite is sized off the
    // fuselage and clips both wings.
    overhang: { x: 0.80 },
    low({ solid }, c) {
      // SHORT SPAN, deliberately: the tips stop at 0.74 and the root starts at
      // -0.16, well aft of the nose. A full-span delta reads as a wide flat
      // arrowhead; keeping the wing small leaves the fuselage as the longest
      // line on the hull, which is what makes this read fast rather than big —
      // and separates it from the MANTA below, which is the wide one.
      const wing = [[0.12, -0.16], [0.70, 0.54], [0.74, 0.78], [0.30, 0.80], [0.13, 0.58]];
      solid(wing, c, CAR_FILL);
      solid(flip(wing), c, CAR_FILL);
    },
    flat({ line }, c, thrust, headlight) {
      line(0, -0.86, 0, -0.70, headlight, 1.5, 8); // nose sensor
      line(0.14, -0.12, 0.67, 0.53, c);            // leading edges
      line(-0.14, -0.12, -0.67, 0.53, c);
      line(0.28, 0.34, 0.62, 0.72, c);             // outer panel joins
      line(-0.28, 0.34, -0.62, 0.72, c);
    },
    raised({ solid }, c) {
      // A RECTANGLE, and INSET: the fuselage is 0.095 half-width at the cabin's
      // nose end and 0.119 at its tail, so body shows on both flanks along its
      // whole length and the hull's taper reads past it. It is 5.8px wide at
      // this size, close enough to the fuselage outline that bloom will merge
      // the two on the road — a gallery-scale detail, kept because that is the
      // scale this catalogue is authored at. The session that gives this hull a
      // type and wants the inset legible at 1x should widen the MIDSECTION
      // (0.12 -> ~0.17), not the cabin.
      solid(box(-0.08, -0.64, 0.08, -0.24), c);
      // Twin canted fins. TWO verticals rather than one, because the tail is
      // what the player looks at longest — a plane crossing the frame is
      // leaving for most of the time it is on screen.
      solid([[0.24, 0.40], [0.38, 0.36], [0.45, 0.86], [0.29, 0.86]], c, CAR_FILL_HIGH);
      solid([[-0.24, 0.40], [-0.38, 0.36], [-0.45, 0.86], [-0.29, 0.86]], c, CAR_FILL_HIGH);
      // NO WINGTIP PYLONS. They were drawn, at 0.56-0.66, and removed: that
      // leaves a 4px gap to the fins at this size, and carshapes.js's header is
      // explicit that two marks a few px apart bloom into one. The fins are the
      // tail group's mark; a second one beside them subtracts.
    },
    top({ line }, c) {
      line(0.27, 0.56, 0.42, 0.54, c); // fin roots
      line(-0.27, 0.56, -0.42, 0.54, c);
    },
  },

  {
    group: "FIGHTER PLANE",
    name: "MANTA",
    pitch: "tailless — the trailing edge cuts BACK IN, no fin anywhere",
    size: [86, 70],
    hover: { drop: 74, scale: 0.50 },
    // THE ONLY CONCAVE OUTLINE IN THE GAME. Every other hull in all four
    // catalogues is convex; this one's trailing edge turns forward between the
    // tip and the centre stub, so the silhouette has a notch cut out of each
    // side. That is the whole aircraft — there is no separate wing in low(),
    // the fuselage is blended into it and drawn as raised detail on top, which
    // is why this profile spends nine of the twelve points the header allows
    // where the delta above spends six.
    //
    // WIDER THAN IT IS TALL (86 x 70), which nothing on the road is either. Two
    // independent reads, both from the outline alone — and it has to be the
    // outline, because with no fin this is the flattest hull in the game and
    // has nothing standing up to be recognised by. Do not shrink it.
    profile: [
      [0, -1.00], [0.18, -0.74], [0.50, -0.24], [0.86, 0.30], [1.00, 0.66],
      [0.90, 0.80], [0.46, 0.40], [0.16, 0.70], [0, 0.66],
    ],
    // The burners fire INTO the notch rather than past a tail — there is no
    // tail for them to pass. Hence a `y2` inside 1.0, unlike the delta's.
    exhaust: [0.21, 0.60, 0.90],
    thrustWide: true,
    overhang: { x: 1.04 }, // the tip pylons, just past the profile's own 1.00
    flat({ line }, c, thrust, headlight) {
      line(0, -0.96, 0, -0.88, headlight, 1.5, 8); // clear of the spine at -0.86
      line(0.19, -0.70, 0.84, 0.28, c);            // leading edges
      line(-0.19, -0.70, -0.84, 0.28, c);
      line(0.88, 0.74, 0.50, 0.40, c);             // the notch, outer half
      line(-0.88, 0.74, -0.50, 0.40, c);
      line(0.44, 0.44, 0.20, 0.66, c);             // and inner, back to the stub
      line(-0.44, 0.44, -0.20, 0.66, c);
    },
    raised({ solid }, c) {
      // The fuselage as a RAISED SPINE on the wing rather than a body the wing
      // is bolted to. Blended is the point: at the outline it has already
      // stopped being a separate object.
      solid([
        [0, -0.86], [0.13, -0.66], [0.15, 0.18], [0.10, 0.46],
        [-0.10, 0.46], [-0.15, 0.18], [-0.13, -0.66],
      ], c);
      solid([[0.17, -0.30], [0.30, -0.20], [0.31, 0.34], [0.18, 0.40]], c, CAR_FILL_HIGH);
      solid([[-0.17, -0.30], [-0.30, -0.20], [-0.31, 0.34], [-0.18, 0.40]], c, CAR_FILL_HIGH);
      solid([[0, -0.62], [0.11, -0.48], [0.10, -0.24], [0, -0.16], [-0.10, -0.24], [-0.11, -0.48]], c);
      // Tip pylons, at 0.84-0.94 rather than on the tip itself: the leading
      // edge is still climbing out there, and any further out the box pokes
      // through it. Far enough from the engine humps at 0.31 to survive the
      // merge the delta's pylons did not.
      for (const p of pair(0.84, 0.54, 0.94, 0.70)) solid(p, c, CAR_FILL_HIGH);
    },
    top({ line }, c) {
      for (const y of [-0.06, 0.14]) {
        line(0.21, y, 0.28, y, c); // hump ribs
        line(-0.21, y, -0.28, y, c);
      }
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
