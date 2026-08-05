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
// LAYERING. Parts are drawn strictly bottom-up, which is what makes a flat
// wireframe read as a solid object:
//
//   low()     ground-level parts the chassis overlaps (splitters)
//   wheels    UNDER the chassis, so only the tyre past the bodywork shows
//   body      the chassis itself, opaque
//   flat()    markings painted ON the chassis (stripes, panel lines)
//   raised()  parts standing proud of it, each OPAQUE
//   wing      opaque, above its own supports
//   top()     markings on raised parts
//   exhaust   glow, always last
//
// The three fills form a height ramp (see palette.js), the same trick
// drawBuilding uses for its three faces: the higher a surface sits off the road,
// the lighter it is. Because they are OPAQUE, a spoiler or a tank drum hides
// whatever passes beneath it instead of looking like an x-ray.

import { glowPoly, glowLine } from "../engine/neon.js";
import { CAR_FILL, CAR_FILL_RAISED, CAR_FILL_HIGH } from "../engine/palette.js";

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

// A single wheel: a small slab with horizontal tread bands that scroll along its
// length to fake rotation. `phase` is the distance the car has "rolled" (px);
// increasing it moves the tread backward, which reads as spinning forward.
function drawWheel(ctx, x, y, color, phase, ww, wl) {
  const top = y - wl + 2;
  const bot = y + wl - 2;
  glowPoly(ctx, [[x - ww, top], [x + ww, top], [x + ww, bot], [x - ww, bot]], color, 1.5, 7);

  const spacing = 4;
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

// The tractor cab shared by the heavy haulers.
const CAB = [[0, -1.0], [0.44, -0.98], [0.62, -0.88], [0.66, -0.70], [0.64, -0.54], [0, -0.52]];

// Fields:
//   name        gallery caption / debugging
//   size        default [w, h] in px; a car type may override
//   profile     right-half silhouette, or `parts` for articulated vehicles
//   wheels      [yFrac, halfWidthPx, halfLenPx, exposePx] — x is DERIVED so that
//               exactly `expose` px of tyre clears the bodywork at that axle
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

// Draws shape `index` centred at (cx, cy), pointing "up" (toward smaller y).
export function drawCarShape(ctx, cx, cy, index, opts = {}) {
  const shape = CAR_SHAPES[index] ?? CAR_SHAPES[0];
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

  // 1. Ground-level parts, which the chassis then overlaps.
  if (shape.low) shape.low(tools, color, thrust, headlight, accent);

  // 2. Wheels, UNDER the chassis: the body fill covers the inner half of each
  //    tyre, leaving only the part that genuinely pokes past the bodywork. The x
  //    position is derived so every shape shows the same amount of tyre.
  for (const [y, ww = WHEEL_W, wl = WHEEL_L, expose = WHEEL_EXPOSE] of shape.wheels) {
    const wx = halfWidthAt(parts, y) * hw + expose - ww;
    drawWheel(ctx, cx - wx, cy + y * hh, color, wheelPhase, ww, wl);
    drawWheel(ctx, cx + wx, cy + y * hh, color, wheelPhase, ww, wl);
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
}

// The shape's closed outline(s) as px offsets from the car's centre — one loop
// per hull, so an articulated rig yields a cab loop and a trailer loop. Effects
// use this to break a car apart along its OWN edges (see game/effects.js), which
// is why it returns geometry rather than drawing anything.
export function carShapeOutline(index, w, h) {
  const shape = CAR_SHAPES[index] ?? CAR_SHAPES[0];
  const hw = w / 2;
  const hh = h / 2;
  return (shape.parts ?? [shape.profile]).map((p) => fracLoop(p, 0, 0, hw, hh));
}

// Half-extents of shape `index` at size w x h, in px from the centre. Callers add
// their own glow padding. Wheels and details reach past the profile, so both are
// accounted for — a fixed fraction of `w` would clip the rig's trailer bogie and
// the hypercar's wing.
export function carShapeExtent(index, w, h) {
  const shape = CAR_SHAPES[index] ?? CAR_SHAPES[0];
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
  for (const [y, ww = WHEEL_W, wl = WHEEL_L, expose = WHEEL_EXPOSE] of shape.wheels) {
    x = Math.max(x, halfWidthAt(parts, y) * hw + expose);
    up = Math.max(up, -(y * hh - wl));
    down = Math.max(down, y * hh + wl);
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
