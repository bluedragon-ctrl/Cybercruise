// The car silhouette catalogue — every distinct BODY SHAPE a car can have.
//
// A shape is pure DATA plus a few small draw callbacks; it knows nothing about
// colour, speed, faction or health. cartypes.js picks a shape by INDEX and
// supplies the colours and size, exactly as citygrid.js picks a building shape.
// Adding a new look means adding an entry here — no change to sprites.js.
//
// GEOMETRY. Every coordinate is a fraction of the half-width (hw) or half-length
// (hh), so a shape scales to whatever `w`/`h` a car type asks for. A `profile` is
// the RIGHT HALF of the silhouette, nose (-1) to tail (+1); fracLoop mirrors it,
// so bodies are symmetric by construction and only half the points are authored.
//
// DETAIL BUDGET. The two halves of a shape cost wildly different things, and
// the catalogue was authored as though they cost the same — every entry here
// carries roughly 5-13 marks, which is a budget the PROFILE deserves and the
// surface does not.
//
//   THE PROFILE IS EXPENSIVE, and not because of drawing. effects.js walks it
//   as segments, so every point added is another flying fragment in every
//   wreck and another copy in the jack-in/disconnect split; shapeExtent (below)
//   sizes the sprite from it; halfWidthAt derives every wheel and track from
//   it. Twelve points is still the ceiling, and most entries want fewer.
//
//   THE SURFACE IS ALMOST FREE. flat/raised/top are rasterised ONCE per cached
//   sprite (engine/spritecache.js: ~226us built, ~8us blitted thereafter) and
//   touch nothing else in the game. A shape may spend up to about THIRTY marks
//   there. That is a real increase on what the catalogue does today, and it is
//   deliberate: on a hidpi display a sprite rasterises at device resolution, so
//   there are more pixels to draw into than 34x62 suggests.
//
// WHAT ACTUALLY LIMITS IT IS THE GLOW, not the budget and not the pixels. Every
// mark carries a shadowBlur, so two marks a couple of px apart do not read as
// two -- their halos merge and the hull drifts toward one bright blob. Past
// roughly thirty, detail starts costing legibility instead of buying it, which
// is why the number is a ceiling rather than a target.
//
// CHECK IT IN THE GALLERY, whose silhouette catalogue draws these at 2x for
// exactly this reason (src/demo/gallery.js). At 1x every hull looks equally
// finished no matter how much was drawn into it, which is how a budget nobody
// could see stayed unspent.
//
// LAYERING. Parts are drawn strictly bottom-up, which is what makes a flat
// wireframe read as a solid object:
//
//   shadow    the ground track a FLYING hull projects, below everything
//   low()     ground-level parts the chassis overlaps (splitters)
//   wheels    UNDER the chassis, so only the tyre past the bodywork shows
//   tracks    same slot as wheels, but one long tread band instead of a tyre
//   body      the chassis itself, opaque
//   flat()    markings painted ON the chassis (stripes, panel lines)
//   raised()  parts standing proud of it, each OPAQUE
//   wing      opaque, above its own supports
//   top()     markings on raised parts
//   exhaust   glow
//   rotors    spinning discs, ABOVE everything -- a rotor turns over its own hull
//
// GROUND CONTACT IS OPTIONAL. `wheels` may be omitted entirely: a hovercraft or
// a drone has no axles, and the cue that replaces the tyres is `hover` (a GROUND
// TRACK offset down-screen -- a hollow ring, a cross and a dashed leader up to
// the hull, so it reads as flying rather than as a car with its wheels
// forgotten). Every shape must carry ONE of the three -- wheels, tracks, or
// hover -- or it will look like it is sliding on its belly. See
// drawHoverShadow below for why the mark is an instrument and not a shadow.
//
// `hover: { blot: false }` is the way to fly without drawing the mark. It says
// "this flies, and the mark is deliberately off" -- a very different claim from a
// shape that simply forgot to say how it meets the road, and
// test/road-and-caches.test.js can tell the two apart because of it. Two hulls
// use it, for two different reasons:
//
//   THE MARK WOULD COVER SOMETHING. The track is drawn first and its leader runs
//   down the centreline, so on the CLAW LIFTER it would be drawn across the very
//   car the vehicle exists to carry.
//   THE MARK WOULD LAND INSIDE THE HULL. `drop` is measured from the hull's
//   CENTRE, so a mark only clears the bodywork when the drop exceeds the hull's
//   own reach downward. On the ARMORED QUAD it did not: the drop it was authored
//   with was 44px against rotors that already reach 37, which put the ring
//   straight through the two lower ducts and the leader entirely inside the pod.
//   Raising the drop past ~70 clears them and was tried -- it costs a sprite half
//   as tall again, for a mark so far from the hull it stops reading as belonging
//   to it. Hence no drop on that entry at all now, just the flag.
//
// THE SECOND ONE IS ONLY AFFORDABLE BECAUSE THE LAYERS SAY IT INSTEAD. main.js
// draws the air pass after the bullets and after the player's own car, so a
// gunship visibly has the whole road passing UNDERNEATH it -- see
// Traffic.render. That is a stronger altitude cue than any mark under the hull
// was, and it is the one the player actually reads. A shape with no such
// layering behind it should still draw its track.
//
// The three fills form a height ramp (see palette.js), the same trick
// a city building uses for its faces: the higher a surface sits off the road,
// the lighter it is. Because they are OPAQUE, a spoiler or a tank drum hides
// whatever passes beneath it instead of looking like an x-ray.

import { glowPoly, glowLine } from "../engine/neon.js";
import { CAR_FILL, CAR_FILL_RAISED, CAR_FILL_HIGH } from "../engine/palette.js";
import { polygon } from "./polygon.js";

// Builds a closed symmetric polygon from a right-half profile (nose -> tail):
// the right side as given, then the left side mirrored tail -> nose.
function fracLoop(profile, cx, cy, hw, hh) {
  const right = profile.map(([fx, fy]) => [cx + fx * hw, cy + fy * hh]);
  const left = [...profile].reverse().map(([fx, fy]) => [cx - fx * hw, cy + fy * hh]);
  return right.concat(left);
}

// The body's half-width (in x-fractions) at a given y-fraction, found by walking
// the profile segments. Since the chassis is drawn OVER the wheels, this is what
// decides where a wheel has to sit for a fixed amount of tyre to stay visible —
// derived per shape rather than hand-tuned once per shape, so editing a profile
// can't silently swallow a wheel.
function halfWidthAt(parts, y) {
  let best = 0;
  for (const profile of parts) {
    for (let i = 0; i < profile.length - 1; i++) {
      const [x1, y1] = profile[i];
      const [x2, y2] = profile[i + 1];
      if (y < Math.min(y1, y2) || y > Math.max(y1, y2)) continue;
      const t = y2 === y1 ? 0 : (y - y1) / (y2 - y1);
      best = Math.max(best, x1 + (x2 - x1) * t);
    }
  }
  return best;
}

// A stretch of scrolling tread: a slab from `top` to `bot` with horizontal bands
// marching along it to fake rotation. `phase` is the distance rolled (px);
// increasing it moves the bands backward, which reads as turning forward.
//
// A WHEEL AND A TANK TRACK ARE THE SAME DRAWING. A track is just a very long
// tread with its bands spaced further apart -- writing it as one function is what
// keeps a tracked boss rolling in lockstep with the traffic around it instead of
// inventing a second, subtly different animation for the same idea.
// The tread's band spacing, and therefore the period over which the whole wheel
// animation REPEATS in `phase`. EXPORTED because sprites.js's sprite cache has to
// quantise `wheelPhase` to exactly this to keep the cache bounded (its
// WHEEL_PERIOD), and the two being one number rather than two copies of 4 is what
// stops a cached car animating over a fraction of its own cycle.
//
// ANY per-phase artwork in this file must complete its visual cycle in this
// many px, or the cache will sample a sliver of it and the motion will vanish.
// drawRotor below is written to that rule; it is not free to pick its own rate.
export const TREAD_SPACING = 4;

function drawTread(ctx, x, top, bot, color, phase, ww, spacing = TREAD_SPACING) {
  glowPoly(ctx, [[x - ww, top], [x + ww, top], [x + ww, bot], [x - ww, bot]], color, 1.5, 7);

  const off = ((phase % spacing) + spacing) % spacing; // wrapped scroll offset
  ctx.save();
  ctx.beginPath();
  ctx.rect(x - ww, top, ww * 2, bot - top);
  ctx.clip();
  ctx.strokeStyle = color;
  ctx.globalAlpha = 0.5;
  ctx.lineWidth = 1.2;
  ctx.shadowColor = color;
  ctx.shadowBlur = 2;
  ctx.beginPath();
  for (let yy = top + off; yy <= bot; yy += spacing) {
    ctx.moveTo(x - ww, yy);
    ctx.lineTo(x + ww, yy);
  }
  ctx.stroke();
  ctx.restore();
}

// A single wheel: a short tread slab centred on its axle.
function drawWheel(ctx, x, y, color, phase, ww, wl) {
  drawTread(ctx, x, y - wl + 2, y + wl - 2, color, phase, ww);
}

// A rotor: an opaque duct ring with blades sweeping inside it. The blades are
// drawn faint and few rather than as a solid disc -- a neon wireframe cannot show
// motion blur, so the readable cue is "spokes at an angle that keeps changing".
// Rotors are the LAST thing drawn, because a rotor genuinely passes over its own
// airframe and reading it any other way makes the drone look flat.
function drawRotor(ctx, x, y, r, color, phase, blades = 3) {
  const TAU = Math.PI * 2;
  ctx.save();
  ctx.strokeStyle = color;
  ctx.fillStyle = CAR_FILL_RAISED;
  ctx.lineWidth = 1.5;
  ctx.shadowColor = color;
  ctx.shadowBlur = 9;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, TAU);
  ctx.fill();
  ctx.stroke();

  // ONE FULL BLADE CYCLE PER TREAD_SPACING OF TRAVEL, and it has to be exactly
  // that. A rotor of `blades` spokes is rotationally symmetric every TAU/blades,
  // so mapping one tread period onto one such turn means the cache's frames
  // sample the whole visual cycle evenly and the rotor genuinely spins.
  //
  // IT USED TO BE `phase * 0.05`, which is fine in the gallery (drawn live, off
  // a phase that only ever grows) and almost nothing on the road. The sprite
  // cache quantises wheelPhase to TREAD_SPACING, so on a cached car that factor
  // spanned 10 DEGREES across all eight frames — MEASURED: 1.9px of travel at a
  // 13px blade tip. The frames were not identical, they were a two-pixel wobble,
  // which reads as a static three-spoke mark on a hull whose whole design leans
  // on the blades turning. This rule spans 105 degrees over the same eight.
  //
  // No shape in CAR_SHAPES had rotors until the gunship — bossshapes.js's hulls
  // are gallery-only and drawn uncached — which is why it went unnoticed.
  const a0 = (phase / TREAD_SPACING) * (TAU / blades);
  ctx.globalAlpha = 0.55;
  ctx.lineWidth = 1.2;
  ctx.shadowBlur = 3;
  ctx.beginPath();
  for (let i = 0; i < blades; i++) {
    const a = a0 + (i * TAU) / blades;
    ctx.moveTo(x, y);
    ctx.lineTo(x + Math.cos(a) * (r - 2), y + Math.sin(a) * (r - 2));
  }
  ctx.stroke();

  ctx.globalAlpha = 1;
  ctx.shadowBlur = 6;
  ctx.beginPath();
  ctx.arc(x, y, 2.2, 0, TAU);
  ctx.stroke();
  ctx.restore();
}

// The GROUND TRACK under a flying hull, offset DOWN-SCREEN from it: where the
// console reckons this contact is over the road, with a leader up to the hull
// itself. The gap between the two is the altitude.
//
// IT USED TO BE A SHADOW, and that was wrong for this game rather than merely
// plain. Everything on this screen is a neon wireframe drawn by a deck rendering
// a hostile network; a soft translucent-black ellipse is a PHOTOGRAPH of a light
// source that does not exist in that fiction, and it was the only opaque black
// in the game -- not even a palette entry, just an inline rgba(0,0,0,0.55). It
// read as an object from another renderer.
//
// SO THE HEIGHT CUE IS AN INSTRUMENT INSTEAD. A hollow ring, a centre cross and
// a dashed leader are the same information in the vocabulary the rest of the
// screen already speaks -- the deck PROJECTING a contact's ground position,
// which is exactly the sort of thing a deck would draw and a shadow is not.
//
// FLATTENED, and that is doing real work: at ry = rx/2 the ring reads as lying
// ON the road plane rather than standing up in it, which is what stops it being
// mistaken for a second, fainter vehicle below the first.
//
// THE LEADER IS THE PART THAT ENCODES HEIGHT. A ring on its own is just a ring;
// a dashed line climbing from it to the hull is what says how far up the thing
// at the top is. It starts below the hull's own edge so it never draws over the
// body, and it is dashed rather than solid so it reads as a projection instead
// of a tether the drone is hanging from.
//
// NOT DIMMED, unlike the blot it replaces: this no longer needs to darken the
// road to be seen, because a stroked glow in the vehicle's own colour is legible
// against the tarmac on its own. It is drawn FIRST regardless, so the hull and
// everything on it still paints over the leader's top end.
//
// THE WHOLE THING IS INSIDE THE CACHED SPRITE (sprites.js), like every other
// part of a car, so none of this costs anything per frame.
const TRACK_FLATTEN = 0.5;  // ry as a fraction of rx -- see FLATTENED above
const TRACK_ALPHA = 0.45;
const TRACK_DASH = 4;       // px on, px off, up the leader

function drawHoverShadow(ctx, cx, cy, hw, hh, color, drop, scale) {
  const rx = hw * scale;
  const ry = hh * scale * TRACK_FLATTEN;
  const gy = cy + drop;

  ctx.save();
  ctx.globalAlpha = TRACK_ALPHA;

  // The leader, from just clear of the hull's lower edge to the top of the ring.
  const from = cy + hh * 0.72;
  ctx.setLineDash([TRACK_DASH, TRACK_DASH]);
  glowLine(ctx, cx, from, cx, gy - ry, color, 1, 5);
  ctx.setLineDash([]);

  // The ring itself, hollow -- no fill, so the road and grid read straight
  // through it the way they do through everything else on this screen.
  glowPoly(ctx, polygon(cx, gy, rx, ry, 18), color, 1, 6);

  // ...and a centre cross, so the mark has a POINT rather than just an area.
  const tick = Math.min(rx, ry) * 0.45;
  glowLine(ctx, cx - tick, gy, cx + tick, gy, color, 1, 4);
  glowLine(ctx, cx, gy - tick, cx, gy + tick, color, 1, 4);

  ctx.restore();
}

// Helpers handed to the per-shape callbacks, so a shape's own drawing code stays
// in fractions and never touches pixels.
function makeTools(ctx, cx, cy, hw, hh) {
  return {
    // Stroked-only shape: a panel line or flat marking.
    line: (x1, y1, x2, y2, color, w = 1, b = 5) =>
      glowLine(ctx, cx + x1 * hw, cy + y1 * hh, cx + x2 * hw, cy + y2 * hh, color, w, b),
    // Opaque part. `fill` picks the height: CAR_FILL_RAISED or CAR_FILL_HIGH.
    solid: (pts, color, fill = CAR_FILL_RAISED, w = 1.5, b = 9) =>
      glowPoly(ctx, pts.map(([fx, fy]) => [cx + fx * hw, cy + fy * hh]), color, w, b, fill),
  };
}

// Canopy presets. All are raised, so all are opaque.
const HEX = [[0, -0.34], [0.40, -0.14], [0.40, 0.18], [0, 0.34], [-0.40, 0.18], [-0.40, -0.14]];
const BOXY = [[-0.46, -0.30], [0.46, -0.30], [0.46, 0.24], [-0.46, 0.24]];
const SLIT = [[0, -0.26], [0.30, -0.08], [0.28, 0.14], [0, 0.24], [-0.28, 0.14], [-0.30, -0.08]];
// A squared cabin with its corners cut rather than rounded — armour plate, not
// glasshouse. Used by the bruiser, whose whole silhouette is built the same way.
const CHAMFER_CAB = [
  [-0.40, -0.30], [0.40, -0.30], [0.46, -0.20], [0.46, 0.14],
  [0.40, 0.24], [-0.40, 0.24], [-0.46, 0.14], [-0.46, -0.20],
];

// A rectangle in fraction space, corners (x1,y1)-(x2,y2). Came across from
// cycleshapes.js with the two-wheelers below, which is all that uses it: unlike
// a profile, `solid()` is NOT mirrored, so anything symmetric built from it is
// emitted twice or centred by hand.
const box = (x1, y1, x2, y2) => [[x1, y1], [x2, y1], [x2, y2], [x1, y2]];

// A closed ring of points at radius `r` in hw/hh fractions -- polygon.js's one
// generator in this file's vocabulary, exactly as its header describes. Only
// circular on a square shape; the gunship is 70x70, which is the only caller.
const ring = (r, n = 20, phase = 0) => polygon(0, 0, r, r, n, phase);

// The tractor cab shared by the heavy haulers.
const CAB = [[0, -1.0], [0.44, -0.98], [0.62, -0.88], [0.66, -0.70], [0.64, -0.54], [0, -0.52]];

// Fields:
//   name        gallery caption / debugging
//   size        default [w, h] in px; a car type may override
//   profile     right-half silhouette, or `parts` for articulated vehicles
//   wheels      [yFrac, halfWidthPx, halfLenPx, exposePx, solo] — x is DERIVED so
//               that exactly `expose` px of tyre clears the bodywork at that
//               axle. `solo` draws ONE wheel on the centreline instead of a
//               mirrored pair — a motorcycle's single track, or the odd axle
//               of a trike; `expose` is unused in that case
//   wing        rear wing half-width in hw, opaque, drawn above its supports
//   exhaust     [xFrac, y1, y2] twin thrust glow; `quad` doubles it to four
//   overhang    how far details reach past the profile, for the sprite bounds
export const CAR_SHAPES = [
  {
    name: "SUPERCAR",
    size: [34, 62],
    profile: [
      [0, -1.00], [0.46, -0.90], [0.74, -0.66], [0.86, -0.30], [0.88, 0.05],
      [0.82, 0.42], [0.86, 0.72], [0.66, 0.92], [0.30, 1.00], [0, 1.02],
    ],
    wheels: [[-0.58], [0.62]],
    wing: 1.06,
    exhaust: [0.20, 0.80, 0.94],
    flat({ line }, c) {
      line(-0.34, -0.80, -0.40, -0.14, c);
      line(0.34, -0.80, 0.40, -0.14, c);
      line(0, -0.92, 0, -0.34, c);
    },
    raised({ solid }, c) {
      solid(HEX, c);
    },
  },

  {
    name: "SEDAN",
    size: [34, 60],
    profile: [
      [0, -0.98], [0.52, -0.94], [0.76, -0.74], [0.84, -0.40], [0.86, 0.10],
      [0.84, 0.60], [0.76, 0.86], [0.50, 0.98], [0, 1.00],
    ],
    wheels: [[-0.56], [0.60]],
    exhaust: [0.26, 0.86, 0.96],
    flat({ line }, c, thrust, headlight) {
      line(-0.60, -0.86, -0.30, -0.86, headlight, 1.5, 8);
      line(0.30, -0.86, 0.60, -0.86, headlight, 1.5, 8);
    },
    raised({ solid, line }, c) {
      solid(BOXY, c);
      line(-0.46, -0.04, 0.46, -0.04, c);
    },
  },

  {
    name: "ROADSTER",
    size: [30, 54],
    // Flat nose rather than a spiked point — this is a civilian's sports car,
    // not a hostile's dart — and a lip spoiler out back to match.
    profile: [
      [0.26, -1.00], [0.40, -0.88], [0.72, -0.56], [0.80, -0.12], [0.92, 0.40],
      [0.90, 0.82], [0.52, 1.00], [0, 1.00],
    ],
    wheels: [[-0.60], [0.62]],
    wing: 0.85,
    exhaust: [0.16, 0.84, 0.98],
    // The flank stripe and canopy carry this type's ACCENT rather than its base
    // colour — see cartypes.js. It is the one civilian whose driving profile
    // gambles through light debris instead of always dodging, and the accent is
    // what tells the player so, without the chassis itself standing out from
    // the rest of the traffic.
    flat({ line }, c, thrust, headlight, accent) {
      line(-0.50, -0.62, -0.66, 0.34, accent);
      line(0.50, -0.62, 0.66, 0.34, accent);
    },
    raised({ solid }, c, thrust, headlight, accent) {
      solid(SLIT, accent);
    },
  },

  {
    name: "RIG",
    size: [42, 124],
    // Two hulls, not one stepped outline: a cab and a trailer, joined by a drawn
    // fifth-wheel coupling. The gap between them is what reads as "articulated".
    parts: [
      CAB,
      [[0, -0.48], [0.90, -0.46], [0.94, -0.30], [0.94, 0.86], [0.72, 0.96], [0, 0.98]],
    ],
    // One steer axle at the cab, a tandem bogie at the rear. The bogie pair is
    // spaced well beyond a tyre's length so the two read as separate wheels.
    wheels: [[-0.82, 4, 10], [0.34, 5, 11], [0.80, 5, 11]],
    exhaust: [0.30, 0.86, 0.96],
    flat({ line }, c, thrust, headlight) {
      line(-0.50, -1.02, 0.50, -1.02, headlight, 1.5, 8);
      line(-0.90, -0.34, -0.90, 0.86, c);
      line(0.90, -0.34, 0.90, 0.86, c);
    },
    raised({ solid }, c, thrust) {
      solid([[-0.38, -0.92], [0.38, -0.92], [0.40, -0.62], [-0.40, -0.62]], c); // cab roof
      solid([[-0.22, -0.56], [0.22, -0.56], [0.22, -0.42], [-0.22, -0.42]], c); // coupling
      // Trailer box top, inset from the chassis edges so the sides read as walls.
      solid([[-0.76, -0.32], [0.76, -0.32], [0.76, 0.84], [-0.76, 0.84]], c, CAR_FILL_HIGH);
      solid([[-0.80, -0.82], [-0.66, -0.82], [-0.66, -0.58], [-0.80, -0.58]], thrust); // stacks
      solid([[0.66, -0.82], [0.80, -0.82], [0.80, -0.58], [0.66, -0.58]], thrust);
    },
    top({ line }, c) {
      for (const y of [-0.02, 0.26, 0.54]) line(-0.76, y, 0.76, y, c);
      line(0, 0.54, 0, 0.84, c, 1.5, 7);
    },
  },

  {
    name: "VAN",
    size: [38, 68],
    profile: [
      [0, -0.94], [0.56, -0.92], [0.84, -0.76], [0.90, -0.44], [0.90, 0.72],
      [0.74, 0.94], [0, 0.98],
    ],
    wheels: [[-0.58], [0.62]],
    exhaust: [0.30, 0.82, 0.94],
    flat({ line }, c) {
      line(-0.90, -0.20, 0.90, -0.20, c);
    },
    raised({ solid }, c) {
      solid([[-0.44, -0.70], [0.44, -0.70], [0.44, -0.36], [-0.44, -0.36]], c);
      solid([[-0.74, -0.16], [0.74, -0.16], [0.74, 0.84], [-0.74, 0.84]], c, CAR_FILL_HIGH);
    },
    top({ line }, c) {
      line(0, -0.16, 0, 0.84, c); // rear door split
    },
  },

  {
    name: "BUS",
    size: [46, 104],
    // Boxy and flat-fronted — a low-floor transit bus, the widest civilian
    // short of the rig. Unlike every other shape, its whole passenger cabin
    // is drawn as glazing rather than an opaque roof: three separate window
    // bays down the centreline, the same "raised, opaque, palest fill" trick
    // every canopy already uses, just stretched into a row. That row is the
    // whole point — it is what tells the player "this one is full of people"
    // before the colour or the size does, and it is why the shape carries a
    // heavy destruction penalty in cartypes.js.
    profile: [
      [0, -1.00], [0.50, -0.98], [1.00, -0.80], [1.00, 0.78], [0.58, 0.98], [0, 1.00],
    ],
    wheels: [[-0.62], [0.62]],
    // A single centred vent rather than the usual twin: `ex` of 0 puts both of
    // drawCarShape's exhaust lines at x=0, which draws the same centred glow
    // twice rather than once each side. Deliberate — a rear-engined transit
    // bus reads differently from everything else's twin pipes, at no cost to
    // the shared drawing code.
    exhaust: [0, 0.90, 0.98],
    flat({ line }, c, thrust, headlight) {
      line(-0.30, -0.86, 0.30, -0.86, headlight, 1.5, 8); // destination board
    },
    raised({ solid }, c) {
      solid([[-0.30, -0.66], [-0.06, -0.66], [-0.06, -0.50], [-0.30, -0.50]], c); // roof AC pod
      solid([[0.06, -0.66], [0.30, -0.66], [0.30, -0.50], [0.06, -0.50]], c);     // roof AC pod
      // Three glazed bays, palest fill in the height ramp so the row reads as
      // glass rather than another body panel.
      solid([[-0.66, -0.40], [0.66, -0.40], [0.66, -0.12], [-0.66, -0.12]], c, CAR_FILL_HIGH);
      solid([[-0.66, 0.00], [0.66, 0.00], [0.66, 0.28], [-0.66, 0.28]], c, CAR_FILL_HIGH);
      solid([[-0.66, 0.40], [0.66, 0.40], [0.66, 0.74], [-0.66, 0.74]], c, CAR_FILL_HIGH);
    },
    top({ line }, c) {
      // Seat-row mullions inside each bay, and the pillars framing the row.
      for (const y of [-0.32, -0.24, -0.16, 0.08, 0.16, 0.48, 0.56, 0.64]) {
        line(-0.66, y, 0.66, y, c);
      }
      line(-0.66, -0.40, -0.66, 0.74, c);
      line(0.66, -0.40, 0.66, 0.74, c);
    },
  },

  {
    name: "INTERCEPTOR",
    size: [34, 62],
    // A pursuit coupe, not a jet: a single smooth taper to a wide rear haunch
    // rather than delta wings sweeping past the body, so the silhouette reads
    // as "very fast car" before the colour does, not "aircraft".
    profile: [
      [0, -1.02], [0.30, -0.86], [0.62, -0.60], [0.82, -0.20], [0.86, 0.20],
      [0.78, 0.56], [0.40, 0.92], [0, 1.00],
    ],
    wheels: [[-0.56], [0.62]],
    wing: 0.55, // a lip spoiler, not a fin
    exhaust: [0.18, 0.74, 0.96],
    thrustWide: true,
    flat({ line }, c, thrust, headlight) {
      line(-0.14, -0.94, -0.14, -0.70, headlight, 1.5, 8); // narrow driving lights
      line(0.14, -0.94, 0.14, -0.70, headlight, 1.5, 8);
      line(-0.50, 0.30, -0.68, 0.66, c); // rear haunch crease
      line(0.50, 0.30, 0.68, 0.66, c);
    },
    raised({ solid }, c) {
      solid(SLIT, c); // low canopy
    },
  },

  {
    name: "BRUISER",
    size: [40, 74],
    // A squared-off battering ram, not a swept fastback: a flat plow face up
    // front, hard chamfered shoulders, and straight flanks the rest of the way
    // back. Every corner on this car is CUT, never rounded — the one silhouette
    // on the road that reads as armour plate rather than bodywork, so ramming
    // with it never looks like an accident.
    //
    // THE BASE CHASSIS IS SLIM. Its bulk comes from what is bolted to it — the
    // side bumper plates and the ram bar — rather than from a wide body, so the
    // car reads as a lean frame armoured up for the job, not just a fat car.
    profile: [
      [0.46, -1.00], [0.82, -0.84], [0.84, -0.46], [0.84, 0.30],
      [0.78, 0.58], [0.84, 0.80], [0.50, 1.00],
    ],
    wheels: [[-0.58, 5], [0.60, 5]],
    exhaust: [0.30, 0.84, 0.98],
    overhang: { x: 1.28, up: 1.10 },
    flat({ line }, c) {
      line(-0.30, -0.98, -0.12, -0.88, c); // plow-face gussets, bolted-on look
      line(0.30, -0.98, 0.12, -0.88, c);
    },
    raised({ solid, line }, c) {
      solid(CHAMFER_CAB, c); // armour-plate cabin, corners cut not rounded
      solid([[-0.24, -0.60], [0.24, -0.60], [0.30, -0.40], [-0.30, -0.40]], c); // scoop
      // Side bumper guards — bolted-on plates that put the width back on a slim
      // base chassis, rather than baking it into the body itself.
      solid([[0.84, -0.66], [0.98, -0.58], [0.98, 0.62], [0.84, 0.70]], c);
      solid([[-0.84, -0.66], [-0.98, -0.58], [-0.98, 0.62], [-0.84, 0.70]], c);
      // Hub spikes, one bolted to each wheel — the tell that this thing rams
      // rather than merely rides heavy.
      solid([[0.90, -0.66], [0.90, -0.50], [1.20, -0.58]], c, CAR_FILL_HIGH);
      solid([[-0.90, -0.66], [-0.90, -0.50], [-1.20, -0.58]], c, CAR_FILL_HIGH);
      solid([[0.84, 0.50], [0.84, 0.68], [1.16, 0.59]], c, CAR_FILL_HIGH);
      solid([[-0.84, 0.50], [-0.84, 0.68], [-1.16, 0.59]], c, CAR_FILL_HIGH);
      // Ram bar — opaque and highest, so the nose behind it is hidden. It is the
      // tell that contact with this car hurts the player, so it must read clearly.
      solid([[-0.98, -1.10], [0.98, -1.10], [0.98, -1.00], [-0.98, -1.00]], c, CAR_FILL_HIGH);
      line(-0.62, -1.00, -0.62, -0.90, c);
      line(0.62, -1.00, 0.62, -0.90, c);
    },
  },

  {
    name: "CYCLE",
    size: [26, 58],
    // Heavy enough to survive the glow at this size: the narrowest body on the
    // road, but not a needle.
    profile: [
      [0, -1.00], [0.34, -0.90], [0.56, -0.66], [0.52, -0.34], [0.44, -0.06],
      [0.66, 0.22], [0.74, 0.62], [0.52, 0.92], [0, 1.00],
    ],
    wheels: [[-0.66, 4, 10], [0.62, 6, 12]],
    exhaust: [0.26, 0.76, 0.96],
    thrustWide: true,
    overhang: { x: 0.98 },
    flat({ line }, c) {
      line(-0.30, -0.46, -0.30, -0.86, c); // forks
      line(0.30, -0.46, 0.30, -0.86, c);
    },
    raised({ solid }, c) {
      solid([[-0.78, 0.10], [-0.50, 0.16], [-0.52, 0.60], [-0.80, 0.54]], c); // armour pods
      solid([[0.78, 0.10], [0.50, 0.16], [0.52, 0.60], [0.80, 0.54]], c);
      solid([[0, -0.30], [0.26, -0.12], [0.24, 0.16], [0, 0.28], [-0.24, 0.16], [-0.26, -0.12]], c);
      solid([[-0.30, 0.34], [0.30, 0.34], [0.34, 0.72], [-0.34, 0.72]], c, CAR_FILL_HIGH);
    },
    top({ line }, c) {
      line(-0.98, -0.46, 0.98, -0.46, c, 1.5, 7); // handlebars, above everything
      line(-0.98, -0.52, -0.98, -0.36, c, 1.5, 7);
      line(0.98, -0.52, 0.98, -0.36, c, 1.5, 7);
    },
  },

  {
    name: "HYPERCAR",
    size: [36, 64],
    profile: [
      [0, -1.00], [0.52, -0.94], [0.86, -0.78], [0.92, -0.44], [0.78, -0.10],
      [0.90, 0.30], [0.98, 0.70], [0.72, 0.94], [0.32, 1.00], [0, 1.02],
    ],
    wheels: [[-0.60, 4, 11], [0.62, 6, 12]],
    wing: 1.16,
    exhaust: [0.34, 0.62, 0.72],
    quad: true,
    overhang: { x: 1.16, up: 1.10 },
    low({ solid }, c) {
      // The splitter is at ground level, so the nose is drawn over it.
      solid([[-1.00, -1.10], [1.00, -1.10], [0.90, -0.86], [-0.90, -0.86]], c, CAR_FILL);
    },
    flat({ line }, c) {
      for (const x of [-0.48, -0.16, 0.16, 0.48]) line(x, 0.74, x, 0.92, c); // diffuser
      line(0, -0.92, 0, -0.30, c);
    },
    raised({ solid }, c) {
      solid([[-0.80, -0.12], [-0.54, -0.02], [-0.58, 0.28], [-0.86, 0.20]], c); // intakes
      solid([[0.80, -0.12], [0.54, -0.02], [0.58, 0.28], [0.86, 0.20]], c);
      solid(SLIT, c);
    },
  },

  {
    name: "MUSCLE",
    size: [38, 68],
    profile: [
      [0, -1.00], [0.60, -0.97], [0.84, -0.86], [0.86, -0.50], [0.82, -0.04],
      [0.90, 0.44], [0.92, 0.82], [0.64, 0.96], [0, 0.98],
    ],
    wheels: [[-0.62, 4, 10], [0.60, 6, 12]],
    exhaust: [0.34, 0.84, 0.96],
    overhang: { up: 1.06, down: 1.04 },
    flat({ line }, c) {
      // Stripes are paint on the chassis, so the scoop and cabin cover them.
      line(-0.16, -0.94, -0.16, 0.94, c);
      line(0.16, -0.94, 0.16, 0.94, c);
      line(-0.72, 0.72, 0.72, 0.72, c);
    },
    raised({ solid, line }, c) {
      solid([[-0.44, 0.02], [0.44, 0.02], [0.42, 0.46], [-0.42, 0.46]], c); // cabin, set back
      solid([[-0.30, -0.70], [0.30, -0.70], [0.34, -0.34], [-0.34, -0.34]], c, CAR_FILL_HIGH);
      line(-0.30, -0.52, 0.30, -0.52, c);
      solid([[-0.86, -1.06], [0.86, -1.06], [0.86, -0.98], [-0.86, -0.98]], c); // bumpers
      solid([[-0.86, 0.96], [0.86, 0.96], [0.86, 1.04], [-0.86, 1.04]], c);
    },
  },

  {
    name: "STOCKER",
    size: [40, 70],
    // A caged racer, recut as a MIDDLEWEIGHT rather than a heavy: one smooth
    // taper instead of stepped flares over each axle, a raked canopy instead of
    // a squared cab, and no ground-level air dam. It should read closer to the
    // roadster than to the bruiser — quick, not stocky — since this is the one
    // that catches you from behind and stays there.
    profile: [
      [0, -1.00], [0.50, -0.94], [0.72, -0.76], [0.80, -0.42], [0.82, 0.02],
      [0.80, 0.42], [0.72, 0.76], [0.48, 0.96], [0, 1.00],
    ],
    wheels: [[-0.44, 4, 10], [0.58, 5, 11]],
    wing: 0.92,
    exhaust: [0.34, 0.84, 0.96],
    quad: true,
    flat({ line }, c, thrust, headlight) {
      line(-0.50, -0.90, 0.50, -0.90, headlight, 1.5, 8); // lightbar across the grille
      line(0, -0.86, 0, -0.30, c); // hood centreline
    },
    raised({ solid }, c) {
      solid([[-0.22, -0.66], [0.22, -0.66], [0.26, -0.38], [-0.26, -0.38]], c, CAR_FILL_HIGH); // hood scoop
      solid(SLIT, c); // low raked canopy
    },
    top({ line }, c) {
      // Roll cage seen through the canopy, and slats over the back window.
      line(0, -0.26, 0, 0.24, c);
      for (const y of [0.34, 0.50]) line(-0.26, y, 0.26, y, c);
    },
  },

  // =========================================================================
  // THE MOTORCYCLE FLEET — three hulls moved across from cycleshapes.js in one
  // piece, unedited, on the day cartypes.js gave each of them a record (the
  // outrider, the outrunner and the sower). That file's header describes the
  // grammar they are written in and why a bike's profile stops well short of
  // +/-1.0 with its wheels parked outside it; the only thing that changed here
  // is which array they live in.
  //
  // `family` and `pitch` came with them. Nothing in this catalogue reads
  // either — they are the staging catalogue's own fields — and they are kept
  // rather than stripped so a hull that goes back, or a fourth that comes
  // across, is a move and not a rewrite.
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

  // THE FIRST BOSS HULL TO EARN A CAR TYPE. Authored in bossshapes.js and moved
  // across here UNEDITED except for its two helper calls, exactly as that file's
  // header says a boss hull graduates: the artwork was finished in the catalogue
  // session, and it comes over in one piece the day something on the road can
  // wear it. `group: "TANK"` was the staging catalogue's field and does not
  // exist here, so it is dropped; nothing else about the shape changed.
  //
  // The one edit: bossshapes.js has a `pair()` helper and this file does not, so
  // the outriggers below are emitted twice by hand. Adding `pair` here for one
  // shape would be a helper with a single caller — see `box` above, which came
  // across the same way and earned its keep across the whole two-wheeler set.
  //
  // IT IS THE ONLY TRACKED THING IN THE CATALOGUE, which is the whole point of
  // the silhouette: no wheels at all, so it does not read as traffic even for
  // the half-second before the player works out what it is.
  {
    name: "SIEGE MORTAR",
    pitch: "no barrel aimed at you — the shells arrive from off-screen",
    size: [62, 90],
    // A different KIND of threat, and the silhouette has to say so: squat and
    // wide, tube raked up-screen instead of level, and outrigger spades planted
    // at ground level. If the player reads "artillery" they will look for where
    // the shells land rather than for a firing line, which is the fight this
    // variant is proposing.
    profile: [
      [0, -0.94], [0.46, -0.90], [0.68, -0.72], [0.72, -0.40],
      [0.72, 0.70], [0.50, 0.92], [0, 0.94],
    ],
    tracks: [[-0.84, 0.84, 8, 14]],
    overhang: { x: 1.34, up: 1.08 },
    low({ solid }, c) {
      // Outrigger spades, planted. Ground level, so the hull is drawn over the
      // inboard end of each and they read as bolted under it.
      for (const [y1, y2] of [[-0.62, -0.44], [0.44, 0.62]]) {
        solid(box(0.60, y1, 1.32, y2), c, CAR_FILL);
        solid(box(-1.32, y1, -0.60, y2), c, CAR_FILL);
      }
    },
    flat({ line }, c) {
      line(-0.72, -0.10, 0.72, -0.10, c);
      line(-0.72, 0.30, 0.72, 0.30, c);
    },
    raised({ solid }, c) {
      // The tube: wide at the breech, narrowing forward and raked up-screen.
      solid([[-0.24, 0.34], [0.24, 0.34], [0.32, -0.58], [-0.32, -0.58]], c, CAR_FILL_HIGH);
      solid(box(-0.20, 0.34, 0.20, 0.56), c);          // breech block
      solid(box(-0.62, 0.40, -0.36, 0.72), c);         // loader hatches
      solid(box(0.36, 0.40, 0.62, 0.72), c);
    },
    top({ line }, c) {
      // Muzzle rings, widest at the mouth — reads as a bore you are looking
      // down the side of, not a barrel pointed anywhere.
      for (const [y, x] of [[-0.54, 0.31], [-0.42, 0.29], [-0.28, 0.27]]) {
        line(-x, y, x, y, c, 1.5, 7);
      }
      line(-0.28, 0.30, -0.32, -0.56, c);
      line(0.28, 0.30, 0.32, -0.56, c);
    },
  },

  // THE GUNSHIP -- the catalogue's first FLYING hull, and the reason `hover` is
  // an altitude rather than a skirt: the gap between the hull and its ground
  // altitude is not in the drawing at all: it is in the DRAW ORDER, and
  // cartypes.js's `airborne` is what turns that into a rule -- see the gunship
  // record there, and Traffic.render for the two passes.
  //
  // Authored in bossshapes.js as ARMORED QUAD and graduated here unedited the
  // day that record was written, exactly as the SIEGE MORTAR above was. It
  // keeps its authored name: the player never sees it (cartypes.js's `label`
  // says COMBAT DRONE), and renaming a hull on the way across would break the
  // one thing that file's protocol is for.
  {
    name: "ARMORED QUAD",
    pitch: "the drone everyone already recognises, up-armoured",
    size: [70, 70],
    // FLIES, AND DRAWS NO GROUND MARK -- see the ground-contact note in this
    // file's header for the two hulls that switch it off and why this is one of
    // them. The altitude is carried by the draw order instead (main.js draws the
    // air pass over the bullets and over the player), which is what the player
    // actually reads: their rounds go under it.
    hover: { blot: false },
    // Four ducted rotors on stub arms around an armoured pod, chin gun forward.
    // It also ties the enemy straight back to the air traffic already flying
    // over the city (drones.js) -- same species, close up.
    profile: [
      [0, -0.64], [0.36, -0.52], [0.46, -0.18], [0.46, 0.18], [0.36, 0.52], [0, 0.64],
    ],
    rotors: [[-0.64, -0.62, 13], [0.64, -0.62, 13], [-0.64, 0.62, 13], [0.64, 0.62, 13]],
    overhang: { x: 1.06, up: 1.06, down: 1.06 },
    low({ solid }, c) {
      // The arms, drawn under the pod so the pod caps them cleanly.
      solid([[-0.10, -0.16], [0.10, -0.34], [0.74, -0.72], [0.56, -0.52]], c, CAR_FILL);
      solid([[0.10, -0.16], [-0.10, -0.34], [-0.74, -0.72], [-0.56, -0.52]], c, CAR_FILL);
      solid([[-0.10, 0.16], [0.10, 0.34], [0.74, 0.72], [0.56, 0.52]], c, CAR_FILL);
      solid([[0.10, 0.16], [-0.10, 0.34], [-0.74, 0.72], [-0.56, 0.52]], c, CAR_FILL);
    },
    flat({ line }, c) {
      line(-0.34, -0.30, 0.34, -0.30, c);
      line(-0.34, 0.30, 0.34, 0.30, c);
    },
    raised({ solid, line }, c, thrust, headlight) {
      solid(box(-0.14, -0.98, 0.14, -0.54), c, CAR_FILL_HIGH); // chin gun, forward
      solid(ring(0.26, 8), c);                                 // sensor dome
      line(-0.10, -0.94, -0.10, -0.62, c);
      line(0.10, -0.94, 0.10, -0.62, c);
      line(-0.20, -0.98, 0.20, -0.98, headlight, 1.5, 8);
    },
  },
];

// Look a shape up by name. Car types (cartypes.js) select their silhouette
// through this rather than by writing a bare index: the catalogue above is
// ordered for reading, and inserting a shape in the middle of it must not
// silently repaint half the traffic on the road. Throws rather than falling back
// to shape 0 — a typo'd name would otherwise turn a truck into a supercar and
// only show up as a puzzling look in-game.
export function carShapeIndex(name) {
  const i = CAR_SHAPES.findIndex((s) => s.name === name);
  if (i === -1) throw new Error(`unknown car shape: ${name}`);
  return i;
}

// Default wheel metrics, overridable per wheel in a shape's `wheels` entry.
const WHEEL_W = 4;
const WHEEL_L = 10;
const WHEEL_EXPOSE = 7; // px of tyre that must clear the bodywork

// Tracks run wider and stand further out than a tyre: a track is meant to be a
// visible part of the silhouette, not a detail peeking past the bodywork.
const TRACK_W = 7;
const TRACK_EXPOSE = 12;

// Draws shape `index` centred at (cx, cy), pointing "up" (toward smaller y).
export function drawCarShape(ctx, cx, cy, index, opts = {}) {
  drawShapeObject(ctx, cx, cy, CAR_SHAPES[index] ?? CAR_SHAPES[0], opts);
}

// The same drawing, given the shape OBJECT rather than an index into the
// catalogue above. This is what lets a shape be drawn before it is a car type --
// the boss candidates in bossshapes.js live in their own list precisely so that
// trying looks out costs nothing in sprites.js's cache budget or in cartypes.js.
// drawCarShape is a one-line wrapper over it, so the two can never drift.
export function drawShapeObject(ctx, cx, cy, shape, opts = {}) {
  const {
    color,
    thrust,
    headlight = "#8ff",
    // Defaults to the chassis colour, so a shape that never references it
    // draws exactly as before. Only a type that names an `accent` (see
    // cartypes.js) gets a detail — a stripe, a canopy tint — in a second shade.
    accent = color,
    w = shape.size[0],
    h = shape.size[1],
    wheelPhase = 0,
  } = opts;
  const hw = w / 2;
  const hh = h / 2;
  const tools = makeTools(ctx, cx, cy, hw, hh);
  const parts = shape.parts ?? [shape.profile];

  // 0. The ground track, if this hull flies. Below everything, so the hull and
  //    its details paint over the top of the leader climbing to them.
  if (shape.hover && shape.hover.blot !== false) {
    drawHoverShadow(ctx, cx, cy, hw, hh, color,
      shape.hover.drop ?? hh * 0.5, shape.hover.scale ?? 0.9);
  }

  // 1. Ground-level parts, which the chassis then overlaps.
  if (shape.low) shape.low(tools, color, thrust, headlight, accent);

  // 2. Wheels, UNDER the chassis: the body fill covers the inner half of each
  //    tyre, leaving only the part that genuinely pokes past the bodywork. The x
  //    position is derived so every shape shows the same amount of tyre.
  //    Omitted entirely by anything that flies -- see the header.
  for (const [y, ww = WHEEL_W, wl = WHEEL_L, expose = WHEEL_EXPOSE, solo = false] of
       shape.wheels ?? []) {
    // A SOLO wheel sits ON the centreline, and `expose` means nothing to it:
    // there is no flank for it to clear. It is drawn ONCE rather than as a pair
    // 0px apart because laying the same tread down twice doubles its shadowBlur,
    // and that one tyre would then read visibly brighter than every other on the
    // road -- the neon equivalent of z-fighting.
    if (solo) {
      drawWheel(ctx, cx, cy + y * hh, color, wheelPhase, ww, wl);
      continue;
    }
    const wx = halfWidthAt(parts, y) * hw + expose - ww;
    drawWheel(ctx, cx - wx, cy + y * hh, color, wheelPhase, ww, wl);
    drawWheel(ctx, cx + wx, cy + y * hh, color, wheelPhase, ww, wl);
  }

  // 2b. Tracks, in the same slot and derived the same way: x comes from the
  //     hull's own half-width at the track's MIDPOINT, so a track hugs the
  //     flank it belongs to rather than being hand-placed per shape.
  for (const [y1, y2, ww = TRACK_W, expose = TRACK_EXPOSE] of shape.tracks ?? []) {
    const tx = halfWidthAt(parts, (y1 + y2) / 2) * hw + expose - ww;
    drawTread(ctx, cx - tx, cy + y1 * hh, cy + y2 * hh, color, wheelPhase, ww, 7);
    drawTread(ctx, cx + tx, cy + y1 * hh, cy + y2 * hh, color, wheelPhase, ww, 7);
  }

  // 3. The chassis, opaque so the road and grid don't show through.
  for (const p of parts) glowPoly(ctx, fracLoop(p, cx, cy, hw, hh), color, 2, 13, CAR_FILL);

  // 4. Markings painted on the chassis.
  if (shape.flat) shape.flat(tools, color, thrust, headlight, accent);

  // 5. Raised parts, each opaque.
  if (shape.raised) shape.raised(tools, color, thrust, headlight, accent);

  // 6. Rear wing: supports first, then an opaque bar over them.
  if (shape.wing) {
    tools.line(-0.45, 0.82, -0.45, 0.98, color);
    tools.line(0.45, 0.82, 0.45, 0.98, color);
    const wy = cy + hh * 0.98;
    const half = hw * shape.wing;
    glowPoly(ctx, [
      [cx - half, wy - 4], [cx + half, wy - 4], [cx + half, wy + 4], [cx - half, wy + 4],
    ], color, 1.5, 8, CAR_FILL_HIGH);
  }

  // 7. Markings on raised parts.
  if (shape.top) shape.top(tools, color, thrust, headlight, accent);

  // 8. Exhaust glow, always last so nothing dims it.
  if (shape.exhaust) {
    const [ex, y1, y2] = shape.exhaust;
    const xs = shape.quad ? [-ex, -ex * 0.36, ex * 0.36, ex] : [-ex, ex];
    const width = shape.quad ? 2.5 : shape.thrustWide ? 4 : 3;
    for (const x of xs) tools.line(x, y1, x, y2, thrust, width, 10);
  }

  // 9. Rotors, above absolutely everything -- a rotor sweeps over its own hull.
  for (const [fx, fy, r, blades = 3] of shape.rotors ?? []) {
    drawRotor(ctx, cx + fx * hw, cy + fy * hh, r, color, wheelPhase, blades);
  }
}

// The shape's closed outline(s) as px offsets from the car's centre — one loop
// per hull, so an articulated rig yields a cab loop and a trailer loop. Effects
// use this to break a car apart along its OWN edges (see game/effects.js), which
// is why it returns geometry rather than drawing anything.
export function carShapeOutline(index, w, h) {
  return shapeOutline(CAR_SHAPES[index] ?? CAR_SHAPES[0], w, h);
}

// As above, given the shape object -- the bossshapes.js counterpart, same reason
// drawShapeObject exists.
function shapeOutline(shape, w, h) {
  const hw = w / 2;
  const hh = h / 2;
  return (shape.parts ?? [shape.profile]).map((p) => fracLoop(p, 0, 0, hw, hh));
}

// Half-extents of shape `index` at size w x h, in px from the centre. Callers add
// their own glow padding. Wheels and details reach past the profile, so both are
// accounted for — a fixed fraction of `w` would clip the rig's trailer bogie and
// the hypercar's wing.
export function carShapeExtent(index, w, h) {
  return shapeExtent(CAR_SHAPES[index] ?? CAR_SHAPES[0], w, h);
}

// As above, given the shape object.
export function shapeExtent(shape, w, h) {
  const hw = w / 2;
  const hh = h / 2;
  const parts = shape.parts ?? [shape.profile];
  const over = shape.overhang ?? {};

  let x = 0;
  let up = 0;
  let down = 0;
  for (const profile of parts) {
    for (const [fx, fy] of profile) {
      x = Math.max(x, fx * hw);
      up = Math.max(up, -fy * hh);
      down = Math.max(down, fy * hh);
    }
  }
  for (const [y, ww = WHEEL_W, wl = WHEEL_L, expose = WHEEL_EXPOSE, solo = false] of
       shape.wheels ?? []) {
    // A solo wheel reaches `ww` from the centreline, not out past a flank it
    // does not have. Getting this wrong only wastes sprite memory -- but it
    // wastes it on all 16 cached bitmaps of whatever type wears the shape.
    x = Math.max(x, solo ? ww : halfWidthAt(parts, y) * hw + expose);
    up = Math.max(up, -(y * hh - wl));
    down = Math.max(down, y * hh + wl);
  }
  for (const [y1, y2, ww = TRACK_W, expose = TRACK_EXPOSE] of shape.tracks ?? []) {
    x = Math.max(x, halfWidthAt(parts, (y1 + y2) / 2) * hw + expose);
    up = Math.max(up, -y1 * hh);
    down = Math.max(down, y2 * hh);
  }
  for (const [fx, fy, r] of shape.rotors ?? []) {
    x = Math.max(x, Math.abs(fx) * hw + r);
    up = Math.max(up, -(fy * hh - r));
    down = Math.max(down, fy * hh + r);
  }
  if (shape.hover && shape.hover.blot !== false) {
    const drop = shape.hover.drop ?? hh * 0.5;
    const scale = shape.hover.scale ?? 0.9;
    x = Math.max(x, hw * scale);
    down = Math.max(down, drop + hh * scale);
  }
  if (shape.wing) {
    x = Math.max(x, shape.wing * hw);
    down = Math.max(down, hh * 0.98 + 4);
  }
  if (over.x) x = Math.max(x, over.x * hw);
  if (over.up) up = Math.max(up, over.up * hh);
  if (over.down) down = Math.max(down, over.down * hh);

  return { x, up, down };
}
