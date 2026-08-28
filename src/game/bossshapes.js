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
// SIX HULLS, FOUR VEHICLES — was eight and five. Only the armoured rig still
// keeps two, since both readings were worth having; the hovercraft keeps one
// plus the pontoon variant, and the combat drone and the cargo drone one each.
// `group` says which vehicle a hull belongs to, so the gallery can show a
// vehicle's options side by side and the boss session can find them.
//
// TWO ARE GONE FROM THIS LIST, and that is this file working as intended rather
// than hulls being lost: the SIEGE MORTAR went first, then the ARMORED QUAD the
// day cartypes.js grew the gunship record that wears it. Both are in
// carshapes.js now. See the notes where each group used to be, and expect this
// count to keep falling as the rest are claimed.
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
// Shared sub-shapes.
// ---------------------------------------------------------------------------

// A turret: an octagonal ring plate. `cy` is where it sits, `r` its radius in
// hw fractions (the y radius is taken as `ry` so it stays round on a long hull).
function turret(cy, r, ry) {
  return ring(1, 8, Math.PI / 8).map(([x, y]) => [x * r, cy + y * ry]);
}

// A low, raked canopy — carshapes.js's SLIT, shifted to wherever a boss wants it.
function canopy(cy, sx = 1, sy = 1) {
  return [
    [0, cy - 0.26 * sy], [0.30 * sx, cy - 0.08 * sy], [0.28 * sx, cy + 0.14 * sy],
    [0, cy + 0.24 * sy], [-0.28 * sx, cy + 0.14 * sy], [-0.30 * sx, cy - 0.08 * sy],
  ];
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
  // ARMORED RIG — the existing RIG escalated two ways: armour bolted onto a
  // shape the player already knows, and sheer length.
  // =========================================================================
  {
    group: "ARMORED RIG",
    name: "BUNKER TRAILER",
    pitch: "the rig you know, welded shut",
    size: [46, 132],
    // Deliberately the SAME two-hull cab-and-trailer layout as carshapes.js's
    // RIG, at the same proportions. Everything that makes this a boss is bolted
    // ON: a ram bar, flank skirts, a braced trailer roof. That is the argument
    // for this variant — the player already knows what a rig is, and this one
    // says "that, but armoured" without a single new silhouette to learn.
    parts: [
      [[0, -1.00], [0.44, -0.98], [0.62, -0.88], [0.66, -0.70], [0.64, -0.54], [0, -0.52]],
      [[0, -0.48], [0.90, -0.46], [0.94, -0.30], [0.94, 0.86], [0.72, 0.96], [0, 0.98]],
    ],
    wheels: [[-0.82, 4, 10, 4], [0.34, 5, 11, 4], [0.80, 5, 11, 4]],
    exhaust: [0.30, 0.86, 0.96],
    overhang: { x: 1.16, up: 1.14 },
    flat({ line }, c, thrust, headlight) {
      line(-0.44, -1.02, 0.44, -1.02, headlight, 1.5, 8);
    },
    raised({ solid, line }, c, thrust) {
      solid(box(-0.38, -0.92, 0.38, -0.62), c);          // cab roof
      solid(box(-0.22, -0.56, 0.22, -0.42), c);          // fifth-wheel coupling
      // Trailer roof with its corners CUT rather than square — the same "armour
      // plate, never rounded" rule the BRUISER is built on, at trailer scale.
      solid([
        [-0.70, -0.32], [0.70, -0.32], [0.80, -0.20], [0.80, 0.72],
        [0.70, 0.84], [-0.70, 0.84], [-0.80, 0.72], [-0.80, -0.20],
      ], c, CAR_FILL_HIGH);
      for (const p of pair(0.94, -0.24, 1.08, 0.80)) solid(p, c); // flank skirts
      solid(box(-0.80, -0.82, -0.66, -0.58), thrust);    // stacks
      solid(box(0.66, -0.82, 0.80, -0.58), thrust);
      // Ram bar: opaque, highest, hiding the nose behind it. Same tell as the
      // BRUISER's — contact with this hurts.
      solid(box(-0.92, -1.14, 0.92, -1.02), c, CAR_FILL_HIGH);
      line(-0.50, -1.02, -0.50, -0.94, c);
      line(0.50, -1.02, 0.50, -0.94, c);
    },
    top({ line }, c) {
      // Cross-bracing on the roof, rather than the RIG's plain rungs: an X per
      // bay reads as structure holding something shut.
      for (const [a, b] of [[-0.30, 0.04], [0.04, 0.38], [0.38, 0.72]]) {
        line(-0.80, a, 0.80, b, c);
        line(0.80, a, -0.80, b, c);
        line(-0.80, b, 0.80, b, c);
      }
    },
  },

  {
    group: "ARMORED RIG",
    name: "ROAD TRAIN",
    pitch: "three hulls, one vehicle — length IS the threat",
    size: [46, 180],
    // The argument here is pure LENGTH: at 180px this fills most of the visible
    // road ahead, and the player meets the gun trailer well before the tail
    // clears. Nothing else in the game is allowed to be this long, which is
    // exactly why it reads as a boss without needing a new colour or scale.
    parts: [
      [[0, -1.00], [0.42, -0.98], [0.60, -0.90], [0.62, -0.78], [0.60, -0.72], [0, -0.70]],
      [[0, -0.66], [0.86, -0.64], [0.92, -0.56], [0.92, -0.08], [0.74, -0.04], [0, -0.04]],
      [[0, 0.04], [0.74, 0.06], [0.92, 0.16], [0.92, 0.88], [0.70, 0.98], [0, 1.00]],
    ],
    wheels: [[-0.90, 4, 9, 4], [-0.22, 5, 10, 4], [-0.12, 5, 10, 4], [0.54, 5, 10, 4], [0.90, 5, 10, 4]],
    exhaust: [0.30, 0.92, 1.00],
    overhang: { x: 1.06 },
    flat({ line }, c, thrust, headlight) {
      line(-0.42, -1.00, 0.42, -1.00, headlight, 1.5, 8);
      line(-0.92, -0.56, -0.92, -0.08, c);
      line(0.92, -0.56, 0.92, -0.08, c);
    },
    raised({ solid }, c, thrust) {
      solid(box(-0.36, -0.94, 0.36, -0.76), c);          // cab roof
      solid(box(-0.20, -0.70, 0.20, -0.62), c);          // coupling 1
      solid(box(-0.20, -0.04, 0.20, 0.04), c);           // coupling 2
      solid(box(-0.78, -0.60, 0.78, -0.12), c, CAR_FILL_HIGH); // gun deck
      solid(box(-0.78, 0.18, 0.78, 0.86), c, CAR_FILL_HIGH);   // cargo roof
      solid(box(-0.56, -0.94, -0.44, -0.78), thrust);    // stacks
      solid(box(0.44, -0.94, 0.56, -0.78), thrust);
      // The turret and its barrel, on the MIDDLE hull — the middle of a convoy
      // is where you least expect the gun, and it means the fight starts before
      // the vehicle has finished arriving.
      solid(turret(-0.36, 0.46, 0.13), c, CAR_FILL_HIGH);
      solid(box(-0.09, -0.74, 0.09, -0.40), c, CAR_FILL_HIGH);
    },
    top({ line }, c) {
      for (const y of [0.30, 0.44, 0.58, 0.72]) line(-0.78, y, 0.78, y, c);
      line(0, -0.74, 0, -0.44, c, 1.5, 7); // barrel bore
    },
  },


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
  // MILITARY HOVERCRAFT — no wheels, no tracks: `hover` and its ground track are
  // the only thing saying where the ground is. Two hulls, and they are opposite
  // arguments about how to say "this floats": a literal skirt, or a hole through
  // the middle of the vehicle with the road streaming past inside it.
  // =========================================================================
  {
    group: "HOVERCRAFT",
    name: "SKIRTED BARGE",
    pitch: "unmistakable: the skirt is the whole read",
    size: [64, 100],
    hover: { drop: 34, scale: 0.86 },
    // A visible inflated skirt standing proud of the hull all the way round,
    // plus two ducted lift fans. Nobody has to be told what this is. The cost
    // is that the skirt is a fat soft outline in a game whose entire vocabulary
    // is hard chamfered plate — which is the objection this variant has to
    // survive.
    profile: [
      [0, -1.00], [0.52, -0.96], [0.82, -0.78], [0.92, -0.50],
      [0.94, 0.50], [0.82, 0.80], [0.50, 0.96], [0, 1.00],
    ],
    rotors: [[-0.42, -0.18, 10, 4], [0.42, -0.18, 10, 4]],
    exhaust: [0.44, 0.92, 1.06],
    thrustWide: true,
    overhang: { x: 1.16, up: 1.14, down: 1.14 },
    low({ solid }, c) {
      solid(ring(1.12, 24), c, CAR_FILL); // the skirt, proud of the hull all round
    },
    flat({ line }, c, thrust, headlight) {
      line(-0.40, -0.88, 0.40, -0.88, headlight, 1.5, 8);
      // Skirt segment joins — the lobes that stop it reading as one balloon.
      for (let i = 0; i < 12; i++) {
        const a = (i / 12) * Math.PI * 2;
        line(Math.cos(a) * 0.90, Math.sin(a) * 0.90, Math.cos(a) * 1.10, Math.sin(a) * 1.10, c);
      }
    },
    raised({ solid, line }, c, thrust) {
      solid(canopy(0.30, 1.3, 1.0), c);                    // bridge
      solid(box(-0.62, 0.56, -0.30, 0.86), c, CAR_FILL_HIGH); // thrust ducts
      solid(box(0.30, 0.56, 0.62, 0.86), c, CAR_FILL_HIGH);
      solid(box(-0.30, -0.66, 0.30, -0.40), c);            // forward gun deck
      line(-0.30, -0.53, 0.30, -0.53, c);
    },
    top({ line }, c) {
      line(-0.46, 0.71, -0.46, 0.86, c);
      line(0.46, 0.71, 0.46, 0.86, c);
    },
  },


  {
    group: "HOVERCRAFT",
    name: "CATAMARAN GUNSHIP",
    pitch: "two pontoons with the road showing between them",
    size: [68, 100],
    hover: { drop: 32, scale: 0.80 },
    // The distinctive one. A narrow spine carries the hull; the mass is two
    // separate pontoons drawn at ground level with a real GAP either side of
    // the spine, so the road, the lane dashes and the city floor stream through
    // the middle of the vehicle. Nothing else in the game does that, and it is
    // the strongest single argument in this whole group — at the price of a
    // silhouette with almost no mass in its centre.
    profile: [[0, -0.94], [0.17, -0.86], [0.19, 0.78], [0, 0.92]],
    rotors: [[-0.72, 0.52, 10, 4], [0.72, 0.52, 10, 4]],
    exhaust: [0.09, 0.86, 0.98],
    overhang: { x: 1.02, up: 1.02, down: 1.02 },
    low({ solid }, c) {
      // The pontoons. Inner edge at 0.46 leaves a clear gap from the spine's
      // 0.19 — that band is the hole.
      const pontoon = [
        [0.46, -0.86], [0.74, -0.96], [0.94, -0.70], [0.98, 0.60],
        [0.80, 0.94], [0.50, 0.88], [0.46, 0.40],
      ];
      solid(pontoon, c, CAR_FILL);
      solid(flip(pontoon), c, CAR_FILL);
    },
    raised({ solid, line }, c) {
      // A bridging deck across the gap, but only amidships: leaving the fore
      // and aft gaps open is what keeps the hole visible while the vehicle
      // still looks like one object.
      solid(box(-0.78, -0.34, 0.78, 0.14), c, CAR_FILL_HIGH);
      solid(canopy(-0.10, 1.4, 1.0), c);
      solid(box(-0.30, -0.80, 0.30, -0.50), c);  // forward gun mount
      line(0, -0.80, 0, -0.50, c);
    },
    top({ line }, c) {
      for (const y of [-0.24, -0.14, -0.04, 0.06]) line(-0.78, y, 0.78, y, c);
      line(-0.46, -0.34, -0.46, 0.14, c); // where the deck meets each pontoon
      line(0.46, -0.34, 0.46, 0.14, c);
    },
  },

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
