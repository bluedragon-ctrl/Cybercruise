// The pickup catalogue — everything a buff crate LOOKS like. Same split as
// obstacleshapes.js: pure DATA plus a small draw callback per entry, with no
// knowledge of spawning, contact or effects. game/pickups.js picks an entry BY
// NAME (pickupShapeIndex) and asks for it to be drawn; adding a new buff's
// artwork means adding an entry here and nothing else.
//
// ONE BODY, FIVE GLYPHS. Every pickup shares a single silhouette — a flat
// DIAMOND RETICLE with four corner brackets, alpha-pulsing as one piece — so
// the road reads "collectible" before the player is close enough to see which
// buff it is; only the glyph at the centre answers that. The body is
// deliberately built off the MINE's own construction (obstacleshapes.js's
// CALTROP) rather than the buildings'/obstacles' raised-fill one: a mine is
// the one point-object this game already draws, and it is flat, concentric
// and alpha-pulsing with no fill-hierarchy height cues at all. A pickup lying
// on the tarmac belongs in that family, not with things that actually stand
// off the road. The bracket-cornered diamond leans the result toward a
// spy-thriller HUD target-lock rather than toward road furniture — the
// player is meant to read "mine to take", not "obstacle to dodge".
//
// SIZE vs EXTENT, same distinction obstacleshapes.js draws: `size` is the
// footprint game/pickups.js tests contact against; `extent` is how far the
// artwork (rings, brackets, glow) actually reaches from the anchor. Unlike
// that file, these extents are HAND-PADDED rather than measured off a
// rendered bitmap — there is no browser canvas in this environment to scan
// for the alpha-bleed boundary the way obstacleshapes.js's own header
// describes. Padding generously is the safe direction to be wrong in (a
// larger cached sprite bound, never clipped artwork), so every extent below
// carries a few px more than the geometry strictly needs.

import { glowLine, glowPoly } from "../engine/neon.js";
import {
  GREEN,
  GREEN_BRIGHT,
  GREEN_DIM,
  GRAY,
  GRAY_BRIGHT,
  GRAY_DIM,
  PURPLE,
  PURPLE_BRIGHT,
  PURPLE_DIM,
  PLAYER,
  PLAYER_THRUST,
  ROCKET,
  ROCKET_HOT,
  ENEMY,
  ENEMY_PALE,
  SHIELD_FLICKER,
} from "../engine/palette.js";

// --- Local drawing helpers (mirrors obstacleshapes.js's own) ---------------

function ngon(cx, cy, r, n, rot = 0) {
  const pts = [];
  for (let i = 0; i < n; i++) {
    const a = rot + (i / n) * Math.PI * 2;
    pts.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]);
  }
  return pts;
}

// The reticle every pickup shares. `pulse` (0..1) drives the whole thing's
// alpha AS ONE PIECE, target-lock style — a mine's core pulses independently
// of its (static) spikes; this pulses whole, closer to a HUD element
// blinking than to a living thing breathing.
//
// The FRAME (diamond + corner brackets) is tinted by `scheme` so the three
// buff KINDS read apart before the glyph at the centre does: ammo -> gray,
// boosts -> purple, healing -> the world's own green (RETICLE_GREEN, the
// default every glyph used before kinds had their own tint).
const RET_R = 14; // diamond half-diagonal

const RETICLE_GREEN = { edge: GREEN, dim: GREEN_DIM, bright: GREEN_BRIGHT };
const RETICLE_GRAY = { edge: GRAY, dim: GRAY_DIM, bright: GRAY_BRIGHT };
const RETICLE_PURPLE = { edge: PURPLE, dim: PURPLE_DIM, bright: PURPLE_BRIGHT };

function drawReticle(ctx, cx, cy, pulse, scheme = RETICLE_GREEN) {
  ctx.save();
  ctx.globalAlpha = pulse;

  const outer = ngon(cx, cy, RET_R, 4);       // vertices at 0/90/180/270deg — a diamond
  const inner = ngon(cx, cy, RET_R * 0.58, 4);
  glowPoly(ctx, outer, scheme.edge, 1.5, 9);
  glowPoly(ctx, inner, scheme.dim, 1, 7, "#0b1118");

  // Corner brackets: a short radial tick past each vertex, capped by a
  // perpendicular stroke — a camera/reticle corner mark aimed outward from
  // the diamond it frames.
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2;
    const dx = Math.cos(a);
    const dy = Math.sin(a);
    const px = -dy;
    const py = dx; // perpendicular
    const r1 = RET_R + 2;
    const r2 = RET_R + 7;
    glowLine(ctx, cx + dx * r1, cy + dy * r1, cx + dx * r2, cy + dy * r2, scheme.bright, 1.3, 7);
    glowLine(
      ctx, cx + dx * r2 - px * 3, cy + dy * r2 - py * 3,
      cx + dx * r2 + px * 3, cy + dy * r2 + py * 3, scheme.bright, 1.3, 7,
    );
  }

  ctx.restore();
}

// How far the reticle's own geometry (brackets included) reaches from centre,
// plus glow bleed — every glyph below fits well inside this, so it is the one
// number the extents share.
const RETICLE_REACH = RET_R + 7 + 7; // bracket tip + glow bleed

// --- Per-buff glyphs, drawn centred at (cx, cy) on top of the reticle ------

// Rocket ammo: three ascending chevrons, tapering brighter toward the tip —
// the rocket's own colour pair (weapons.js's ROCKET/ROCKET_HOT), so the
// crate previews the ordnance it refills.
function drawRocketGlyph(ctx, cx, cy) {
  const rows = [
    [cy + 8, ROCKET],
    [cy + 3, ROCKET],
    [cy - 2, ROCKET_HOT],
  ];
  for (const [y, color] of rows) {
    glowPoly(ctx, [[cx - 5, y + 4], [cx, y - 3], [cx + 5, y + 4]], color, 1.5, 8);
  }
}

// Tracer (tracker) ammo: a homing arc with a bright leading dot — the
// tracker weapon's own colour/glow pair, lifted straight from its catalogue
// entry.
function drawTracerGlyph(ctx, cx, cy) {
  ctx.save();
  ctx.strokeStyle = PLAYER_THRUST;
  ctx.lineWidth = 1.8;
  ctx.lineCap = "round";
  ctx.shadowColor = PLAYER_THRUST;
  ctx.shadowBlur = 8;
  ctx.beginPath();
  ctx.arc(cx + 2, cy + 2, 9, Math.PI * 1.15, Math.PI * 1.85);
  ctx.stroke();
  ctx.restore();
  glowPoly(ctx, ngon(cx - 6, cy - 7, 1.8, 8), PLAYER, 1, 9, PLAYER);
}

// Mine ammo: a miniature caltrop — the same six-spike silhouette the road
// hazard uses (obstacleshapes.js's CALTROP), shrunk and locked inside the
// friendly green reticle so the FRAME says "yours" while the GLYPH still says
// "mine", the same rule obstacleshapes.js gives every hazard's colour.
function drawMineGlyph(ctx, cx, cy) {
  const r = 3.2;
  const spike = 4.2;
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    const dx = Math.cos(a);
    const dy = Math.sin(a);
    glowPoly(ctx, [
      [cx + dx * (r + spike), cy + dy * (r + spike)],
      [cx + dx * r - dy * 1.6, cy + dy * r + dx * 1.6],
      [cx + dx * r + dy * 1.6, cy + dy * r - dx * 1.6],
    ], ENEMY, 1.2, 7);
  }
  glowPoly(ctx, ngon(cx, cy, r, 6), ENEMY_PALE, 1, 8, "#2a0a0a");
}

// Fix: a bright cross, a step brighter than world green so it reads as a
// signal rather than as scenery.
function drawFixGlyph(ctx, cx, cy) {
  glowLine(ctx, cx, cy - 8, cx, cy + 8, GREEN_BRIGHT, 3, 9);
  glowLine(ctx, cx - 8, cy, cx + 8, cy, GREEN_BRIGHT, 3, 9);
}

// Shield: a ring with a spinning tick — the one glyph that previews the
// EFFECT it grants rather than the object it refills (see game/player.js's
// renderShield, the same two-counter-rotating-rings idiom in miniature).
// `phase` drives the tick; pickups.js passes seconds elapsed since spawn so
// several live shield crates don't spin in lockstep.
function drawShieldGlyph(ctx, cx, cy, phase) {
  glowPoly(ctx, ngon(cx, cy, 8, 20), PLAYER, 1.6, 10);
  const spin = phase * 2.4;
  glowLine(
    ctx, cx + Math.cos(spin) * 8, cy + Math.sin(spin) * 8,
    cx + Math.cos(spin + 0.9) * 8, cy + Math.sin(spin + 0.9) * 8, SHIELD_FLICKER, 2, 9,
  );
  glowPoly(ctx, ngon(cx, cy, 3, 10), SHIELD_FLICKER, 1, 7, "#0d2830");
}

// Fields:
//   name   stable key (pickuptypes.js looks these up by name)
//   size   [w, h] footprint pickups.js tests player contact against
//   extent {x, up, down} how far the artwork reaches from the anchor
//   draw   (ctx, cx, cy, pulse, phase) — anchored at the pickup's centre.
//          `pulse` (0..1) is the shared reticle's breathing alpha; `phase` is
//          raw seconds live, for glyphs that animate on their own clock
//          (currently only SHIELD's spinning tick).
export const PICKUP_SHAPES = [
  {
    name: "ROCKET_AMMO",
    size: [28, 28],
    extent: { x: RETICLE_REACH, up: RETICLE_REACH, down: RETICLE_REACH },
    draw(ctx, cx, cy, pulse) {
      drawReticle(ctx, cx, cy, pulse, RETICLE_GRAY);
      drawRocketGlyph(ctx, cx, cy);
    },
  },
  {
    name: "TRACER_AMMO",
    size: [28, 28],
    extent: { x: RETICLE_REACH, up: RETICLE_REACH, down: RETICLE_REACH },
    draw(ctx, cx, cy, pulse) {
      drawReticle(ctx, cx, cy, pulse, RETICLE_GRAY);
      drawTracerGlyph(ctx, cx, cy);
    },
  },
  {
    name: "MINE_AMMO",
    size: [28, 28],
    extent: { x: RETICLE_REACH, up: RETICLE_REACH, down: RETICLE_REACH },
    draw(ctx, cx, cy, pulse) {
      drawReticle(ctx, cx, cy, pulse, RETICLE_GRAY);
      drawMineGlyph(ctx, cx, cy);
    },
  },
  {
    name: "FIX",
    size: [28, 28],
    extent: { x: RETICLE_REACH, up: RETICLE_REACH, down: RETICLE_REACH },
    draw(ctx, cx, cy, pulse) {
      drawReticle(ctx, cx, cy, pulse);
      drawFixGlyph(ctx, cx, cy);
    },
  },
  {
    name: "SHIELD",
    size: [28, 28],
    extent: { x: RETICLE_REACH, up: RETICLE_REACH, down: RETICLE_REACH },
    draw(ctx, cx, cy, pulse, phase) {
      drawReticle(ctx, cx, cy, pulse, RETICLE_PURPLE);
      drawShieldGlyph(ctx, cx, cy, phase);
    },
  },
];

export const PICKUP_SHAPE_NAMES = PICKUP_SHAPES.map((s) => s.name);

// Look a pickup shape up by name — see obstacleShapeIndex for why this is a
// throw rather than a silent fallback: reordering the catalogue must not
// quietly turn a rocket crate into a shield crate.
export function pickupShapeIndex(name) {
  const i = PICKUP_SHAPES.findIndex((s) => s.name === name);
  if (i === -1) throw new Error(`unknown pickup shape: ${name}`);
  return i;
}

// Draw pickup shape `index` centred at (cx, cy). `angle` rotates the whole
// glyph to match the road's heading at this point — the same treatment
// obstacles.js gives its own shapes — so a reticle leans into a bend along
// with everything else drawn on it.
export function drawPickupShape(ctx, cx, cy, index, pulse = 1, phase = 0, angle = 0) {
  const shape = PICKUP_SHAPES[index] ?? PICKUP_SHAPES[0];
  if (!angle) {
    shape.draw(ctx, cx, cy, pulse, phase);
    return;
  }
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(angle);
  shape.draw(ctx, 0, 0, pulse, phase);
  ctx.restore();
}

// Half-extents of the ARTWORK, in px from the centre.
export function pickupShapeExtent(index) {
  return (PICKUP_SHAPES[index] ?? PICKUP_SHAPES[0]).extent;
}
