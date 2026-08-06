// Destruction effects — what a car looks like when it dies.
//
// THE LOOK. The shell breaks apart along the car's OWN outline while its insides
// spray out from under it. The silhouette fragments are what say which car died
// and which faction it belonged to; the streaks give the moment the physical
// weight that outline fragments alone lack. Because the shell comes from
// carshapes.js, a new car type is destructible the day it is added — there is no
// per-type explosion art to draw.
//
// STATELESS DRAWING. drawWreck is a PURE function of normalised progress `t`
// (0 -> 1 across WRECK_DURATION): particle positions are recomputed from a
// per-explosion seed every frame rather than stored. That keeps the artwork
// scrubbable (the gallery animates it straight from its own `phase` counter) and
// means the pool below only has to remember (worldY, offset, seed, elapsed) per
// explosion — four numbers, no particle arrays.
//
// COST. Unlike cars, an explosion is unique per instance, so the sprite cache
// cannot help: every frame is drawn live. That rules out ctx.shadowBlur — as
// neon.js documents, blur cost scales with the shadow's BOUNDING-BOX AREA, and a
// debris field's box is enormous. Everything here goes through neonStroke's
// overdraw halo instead, and each pass batches ALL of its fragments into one path
// so the three stroke passes are paid once per pass, not once per particle. A
// wreck is 9 strokes per frame regardless of how many pieces it is made of.

import { neonStroke } from "../engine/neon.js";
import { carShapeOutline } from "./carshapes.js";
import { centerXAt } from "./road.js";
import {
  CRITICAL_FLASH,
  GREEN_BRIGHT,
  GREEN_DIM,
  GREEN_PALE,
  NEUTRAL,
  NEUTRAL_DEEP,
  NEUTRAL_PALE,
  PLAYER,
  ROCKET,
  ROCKET_HOT,
} from "../engine/palette.js";
import { OBSTACLE_SHAPES, SPLINTER, WATER, IMPACT } from "./obstacleshapes.js";

// Seconds from detonation to gone.
export const WRECK_DURATION = 0.75;

// A mine's blast is a different event from a car dying and is over faster — see
// drawMineBlast below.
export const MINE_BLAST_DURATION = 0.55;

const PARTICLES = 14;  // interior streaks
const CHUNKS = 4;      // larger tumbling pieces
const DRAG = 3.4;      // 1/sec; position integrates to v*(1-e^-kt)/k
const SHELL_SPEED = 1.25; // the shell is thrown harder than the guts, so the
                          // silhouette opens up before the spray takes over

// Small deterministic PRNG. Seeding per explosion is what makes the particle
// layout stable across frames without storing it. Exported because
// game/disconnect.js's glitch effect wants the same stable-per-seed jitter for
// its own reasons — no sense inventing a second one.
export function rng(seed) {
  let a = (seed * 1831565813) >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let x = Math.imul(a ^ (a >>> 15), 1 | a);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

// --- Path builders. Each only issues moveTo/lineTo, so the caller can batch a
// whole pass into a single neonStroke and pay the halo once. ---

// The shell: every segment of the car's own outline becomes a fragment that
// flies outward and tumbles about its midpoint.
function buildShell(c, cx, cy, tt, shape, w, h, rand) {
  for (const loop of carShapeOutline(shape, w, h)) {
    for (let i = 0; i < loop.length; i++) {
      const [x1, y1] = loop[i];
      const [x2, y2] = loop[(i + 1) % loop.length];
      const mx = (x1 + x2) / 2;
      const my = (y1 + y2) / 2;

      // Fragments fly away from the car's centre, at a speed that varies per
      // fragment so the field spreads instead of staying a ring.
      const d = Math.hypot(mx, my) || 1;
      const speed = (55 + rand() * 110) * SHELL_SPEED;
      const spin = (rand() - 0.5) * 9; // rad/sec
      const ox = (mx / d) * speed * tt;
      const oy = (my / d) * speed * tt;

      const a = spin * tt;
      const cos = Math.cos(a);
      const sin = Math.sin(a);
      const rx1 = (x1 - mx) * cos - (y1 - my) * sin;
      const ry1 = (x1 - mx) * sin + (y1 - my) * cos;
      const rx2 = (x2 - mx) * cos - (y2 - my) * sin;
      const ry2 = (x2 - mx) * sin + (y2 - my) * cos;

      c.moveTo(cx + mx + ox + rx1, cy + my + oy + ry1);
      c.lineTo(cx + mx + ox + rx2, cy + my + oy + ry2);
    }
  }
}

// The guts: streaks drawn ALONG their velocity so they read as motion rather
// than as dots. Origins are scattered across `spread` (the car's footprint), not
// emitted from a point, so they come out from UNDER the breaking shell instead
// of from a single spark beneath it.
function buildStreaks(c, cx, cy, tt, base, rand, spread) {
  const travel = (1 - Math.exp(-DRAG * tt)) / DRAG; // position factor for speed 1
  const decay = Math.exp(-DRAG * tt) * 0.035;       // a slice of current velocity
  for (let i = 0; i < PARTICLES; i++) {
    const sx = (rand() - 0.5) * spread[0];
    const sy = (rand() - 0.5) * spread[1];
    const a = rand() * Math.PI * 2;
    const speed = base * (1.4 + rand() * 3.4);
    const vx = Math.cos(a) * speed;
    const vy = Math.sin(a) * speed;
    const px = cx + sx + vx * travel;
    const py = cy + sy + vy * travel;
    c.moveTo(px, py);
    c.lineTo(px - vx * decay, py - vy * decay);
  }
}

// Larger chunks that tumble and slow — the wreckage a later phase could leave
// lying on the road as a hazard.
function buildChunks(c, cx, cy, tt, base, rand, spread) {
  const travel = (1 - Math.exp(-DRAG * tt)) / DRAG;
  for (let i = 0; i < CHUNKS; i++) {
    const sx = (rand() - 0.5) * spread[0];
    const sy = (rand() - 0.5) * spread[1];
    const a = rand() * Math.PI * 2;
    const speed = base * (0.8 + rand() * 1.6);
    const px = cx + sx + Math.cos(a) * speed * travel;
    const py = cy + sy + Math.sin(a) * speed * travel;
    const size = 3 + rand() * 4;
    const ang = (rand() - 0.5) * 7 * tt;
    for (let k = 0; k < 4; k++) {
      const c1 = ang + (k / 4) * Math.PI * 2;
      const c2 = ang + ((k + 1) / 4) * Math.PI * 2;
      c.moveTo(px + Math.cos(c1) * size, py + Math.sin(c1) * size);
      c.lineTo(px + Math.cos(c2) * size, py + Math.sin(c2) * size);
    }
  }
}

// Draw a wreck centred at (cx, cy), `t` of the way through WRECK_DURATION.
// opts: { shape, color, thrust, w, h, seed }
export function drawWreck(ctx, cx, cy, t, opts = {}) {
  if (t < 0 || t >= 1) return;
  const { shape = 0, color, thrust, w, h, seed = 1 } = opts;
  const tt = t * WRECK_DURATION; // seconds since detonation
  const rand = rng(seed);
  const base = Math.max(w, h);
  // Origins are scattered over the BODY, not the bounding box, so nothing spawns
  // out past where the car actually was.
  const spread = [w * 0.7, h * 0.75];

  ctx.save();

  // Interior first, so the shell fragments read as being in front of the spray.
  neonStroke(ctx, (c) => buildStreaks(c, cx, cy, tt, base, rand, spread),
    thrust, 2, 4, 0.13, Math.max(0, 1 - Math.pow(t, 1.5)));
  neonStroke(ctx, (c) => buildChunks(c, cx, cy, tt, base, rand, spread),
    color, 1.5, 4, 0.13, t < 0.65 ? 1 : Math.max(0, 1 - (t - 0.65) / 0.35));

  // The shell, fading first so the spray is what you are left watching.
  neonStroke(ctx, (c) => buildShell(c, cx, cy, tt, shape, w, h, rand),
    color, 2, 4, 0.13, Math.max(0, 1 - Math.pow(t, 1.7)));

  // A brief white core, so an effect built from fragments still reads as an
  // impact rather than the car quietly disassembling.
  if (t < 0.24) {
    const k = 1 - t / 0.24;
    const r = base * 0.22 * k;
    neonStroke(ctx, (c) => {
      c.moveTo(cx + r, cy);
      c.arc(cx, cy, r, 0, Math.PI * 2);
    }, "#ffffff", 3, 5, 0.16, k);
  }
  ctx.restore();
}

// ---------------------------------------------------------------------------
// MINE DETONATION — "EMP BLOOM"
//
// Deliberately NOT the car wreck. drawWreck is a SHELL BREAKING UP: fragments of
// the car's own outline tumbling outward with its guts spraying from under it,
// and it says "a vehicle died". A mine has no silhouette worth preserving, so
// this says "the road erupted" instead, and it says it in ENERGY rather than
// fire: a jittering hexagonal cage blows outward and dissolves into branching
// arcs. Nothing here reuses the shell/streak/chunk vocabulary, so a mine going
// off next to a wreck stays tellable apart.
//
// It also runs faster (MINE_BLAST_DURATION vs WRECK_DURATION) — a mine is an
// instant, not a death throe.
//
// COLOUR. The cool end of the palette is what makes this read as synthetic
// discharge, so it borrows the player's cyan. That is safe only because the
// blast lasts half a second and expands from a point the player is nowhere near
// by then; a longer or slower cyan effect would start competing with the one
// thing on screen that must always be findable — the player's own car.
//
// Like drawWreck, this is a PURE function of `t` (0 -> 1): the jitter and the
// arcs are re-rolled every frame from the seed, which is exactly what makes the
// discharge crackle, and it means a live blast is four numbers in the pool.
// Everything goes through neonStroke — a blast covers a big bounding box, and
// ctx.shadowBlur is priced by box AREA (see engine/neon.js).
export function drawMineBlast(ctx, cx, cy, t, opts = {}) {
  if (t < 0 || t >= 1) return;
  const { seed = 1, radius = 58 } = opts;
  const rand = rng(seed);
  // sqrt-ish growth: the cage is thrown out hard and then coasts to a stop.
  const R = radius * Math.sqrt(Math.min(1, t * 1.15));

  ctx.save();

  // The cage: two counter-rotating hexagons with per-vertex jitter, so the
  // outline crackles instead of expanding as a clean ring.
  for (let ring = 0; ring < 2; ring++) {
    const r = R * (1 - ring * 0.3);
    const rot = (ring ? -1 : 1) * t * 2.4;
    neonStroke(ctx, (c) => {
      for (let i = 0; i <= 6; i++) {
        const a = rot + (i / 6) * Math.PI * 2;
        const j = 1 + (rand() - 0.5) * 0.22;
        const x = cx + Math.cos(a) * r * j;
        const y = cy + Math.sin(a) * r * j;
        if (i === 0) c.moveTo(x, y);
        else c.lineTo(x, y);
      }
    }, ring ? PLAYER : CRITICAL_FLASH, 2.5 - ring, 4, 0.14,
      Math.max(0, 1 - Math.pow(t, 1.5)));
  }

  // Arcs: kinked lightning branches from the centre out past the cage, batched
  // into one path so all eight share a single set of strokes. They fade in over
  // the first instant, so the flash lands before the discharge does.
  neonStroke(ctx, (c) => {
    for (let i = 0; i < 8; i++) {
      let a = (i / 8) * Math.PI * 2 + rand() * 0.5;
      let x = cx;
      let y = cy;
      c.moveTo(x, y);
      for (let k = 0; k < 3; k++) {
        a += (rand() - 0.5) * 1.1;
        const seg = (R / 3) * (0.7 + rand() * 0.7);
        x += Math.cos(a) * seg;
        y += Math.sin(a) * seg;
        c.lineTo(x, y);
      }
    }
  }, PLAYER, 1.5, 4, 0.13, Math.max(0, 1 - t) * (t < 0.12 ? t / 0.12 : 1));

  // The collapsing white core — the charge dumping itself.
  if (t < 0.3) {
    const k = 1 - t / 0.3;
    const r = 14 * k + 3;
    neonStroke(ctx, (c) => {
      c.moveTo(cx + r, cy);
      c.arc(cx, cy, r, 0, Math.PI * 2);
    }, "#ffffff", 4, 5, 0.2, k);
  }
  ctx.restore();
}

// ---------------------------------------------------------------------------
// ROCKET IMPACT — "FIREBALL BURST"
//
// The one true FIRE-coloured explosion in the game, deliberately: drawWreck
// stays in the dying car's own colours and drawMineBlast goes cold cyan
// specifically so THIS is the only thing on the road that reads as flame. A
// rocket is meant to look and feel unlike anything else that goes off — a
// ragged ball of fire that throws its embers on a falling ARC rather than
// flinging them in a straight line, which is the one place gravity appears in
// this file at all.
//
// COLOUR. Reuses the rocket's OWN colours (ROCKET/ROCKET_HOT, engine/palette.js)
// for the ring and the glow, the same way drawWreck reuses a dying car's
// colour/thrust — the burst is visibly the same ordnance that just flew in, and
// it is why this function takes no colour opts of its own (compare
// drawMineBlast, which hardcodes its colours for the same reason: there is only
// one look for this event).
//
// Pure function of `t` like every other drawer above, and for the same reason:
// the ragged edge and the ember scatter are re-rolled from the seed every
// frame rather than stored, so a live burst is still just four numbers in the
// Explosions pool.
export const FIREBALL_DURATION = 0.5;

// The ragged outer edge: a circle whose radius is perturbed per vertex and
// re-rolled from the seed each frame, so it crawls instead of sitting as a
// clean ring — rounder and warmer than the mine's jittering hexagon cage.
function buildFireballOutline(c, cx, cy, r, rand) {
  const N = 16;
  for (let i = 0; i <= N; i++) {
    const a = (i / N) * Math.PI * 2;
    const rr = r * (0.82 + rand() * 0.36);
    const x = cx + Math.cos(a) * rr;
    const y = cy + Math.sin(a) * rr;
    if (i === 0) c.moveTo(x, y);
    else c.lineTo(x, y);
  }
}

// Embers thrown mostly upward and outward, then pulled down by a flat
// acceleration term — unlike every drag-only effect above, this is the one
// place "down" means something, which is part of what tells a fireball apart
// from a wreck's flung shell or a mine's radial arcs.
function buildFireballEmbers(c, cx, cy, tt, rand, radius) {
  const G = radius * 5.5; // tuned for the burst's short life, not real units
  for (let i = 0; i < 8; i++) {
    const a = -Math.PI / 2 + (rand() - 0.5) * Math.PI * 1.3; // upward-ish, wide spread
    const speed = radius * (1.4 + rand() * 2.2);
    const vx = Math.cos(a) * speed;
    const vy = Math.sin(a) * speed;
    const px = cx + vx * tt;
    const py = cy + vy * tt + 0.5 * G * tt * tt;
    c.moveTo(px, py);
    c.lineTo(px - vx * 0.06, py - (vy + G * tt) * 0.06);
  }
}

// A few smoke wisps that curl straight up regardless of where they started,
// so the burst reads as something that is still burning after the flash.
function buildFireballSmoke(c, cx, cy, tt, rand, radius) {
  for (let i = 0; i < 3; i++) {
    const a = -Math.PI / 2 + (rand() - 0.5) * 1.6;
    const rise = radius * (0.9 + rand() * 0.5);
    const x0 = cx + Math.cos(a) * radius * 0.35;
    const y0 = cy + Math.sin(a) * radius * 0.35;
    const x1 = x0 + Math.cos(a) * rise * tt * 1.4;
    const y1 = y0 + Math.sin(a) * rise * tt * 1.4 - rise * tt;
    c.moveTo(x0, y0);
    c.lineTo(x1, y1);
  }
}

// Draw a fireball centred at (cx, cy), `t` of the way through FIREBALL_DURATION.
// opts: { seed, radius }. `radius` defaults smaller than the mine's — this is a
// direct hit, not an area charge.
export function drawFireballBurst(ctx, cx, cy, t, opts = {}) {
  if (t < 0 || t >= 1) return;
  const { seed = 1, radius = 42 } = opts;
  const rand = rng(seed);
  const tt = t * FIREBALL_DURATION;
  // Grows fast then coasts, like the mine's cage.
  const R = radius * Math.sqrt(Math.min(1, t * 1.3));

  ctx.save();

  // Smoke first, so it reads as rising behind the fire rather than in front.
  neonStroke(ctx, (c) => buildFireballSmoke(c, cx, cy, tt, rand, radius),
    GREEN_DIM, 2, 4, 0.1, Math.max(0, t - 0.15) * 0.6);

  // The ragged outer ring.
  neonStroke(ctx, (c) => buildFireballOutline(c, cx, cy, R, rand),
    ROCKET, 2.5, 4, 0.15, Math.max(0, 1 - Math.pow(t, 1.6)));

  // Inner glow, fading a little ahead of the outer ring.
  if (t < 0.7) {
    const k = 1 - t / 0.7;
    neonStroke(ctx, (c) => {
      c.moveTo(cx + R * 0.45, cy);
      c.arc(cx, cy, R * 0.45, 0, Math.PI * 2);
    }, ROCKET_HOT, 3, 4, 0.16, k);
  }

  // Falling embers.
  neonStroke(ctx, (c) => buildFireballEmbers(c, cx, cy, tt, rand, radius),
    ROCKET, 2, 4, 0.13, Math.max(0, 1 - Math.pow(t, 1.3)));

  // The white core flash — same device drawWreck and drawMineBlast use, so an
  // impact still reads as one even before the eye has parsed the fire.
  if (t < 0.22) {
    const k = 1 - t / 0.22;
    const r = radius * 0.24 * k;
    neonStroke(ctx, (c) => {
      c.moveTo(cx + r, cy);
      c.arc(cx, cy, r, 0, Math.PI * 2);
    }, "#ffffff", 3, 5, 0.18, k);
  }
  ctx.restore();
}

// ---------------------------------------------------------------------------
// ROADBLOCK DESTRUCTION
//
// A roadblock breaking is a THIRD kind of event, and the whole point of these
// three drawers is that the player learns what they just hit without being told:
//
//   SPLINTER (the trestle) — it was a light thing on legs, and it comes apart
//   like one. Thin slats fly out fast, spin, and are gone. No shockwave, no
//   lingering debris, no white core: nothing here says "that cost you", because
//   ploughing through a trestle shouldn't feel like it did.
//
//   WATER (the barrels) — see drawWaterBurst: a crown of green spray settling
//   into a puddle. The one destruction in the game that is good news.
//
//   IMPACT (the tetra) — you hit something that did not want to
//   move. The vocabulary is inverted: the pieces are FEWER, THICKER, SLOWER and
//   they decelerate hard instead of flying clear, and the energy goes into a
//   flash and a squat shockwave ring at the point of contact rather than into
//   travel. Heavy is communicated by things NOT going far.
//
// Both are pure functions of `t` (0 -> 1) like drawWreck and drawMineBlast, both
// stay in the amber family so the debris is still recognisably road furniture,
// and both go through neonStroke for the reason engine/neon.js documents.

// Seconds from hit to gone, per style (obstacleshapes.js names the styles). The
// heavy one runs longest — the debris settling is the part that reads as weight,
// so it needs the time to settle in.
// Water runs longest of the three: the puddle settling is the payoff, and it is
// the only debris that should still be visible as the player drives past it.
export const OBSTACLE_WRECK_DURATION = { [SPLINTER]: 0.45, [WATER]: 0.7, [IMPACT]: 0.6 };

// Light debris: slats thrown clear and tumbling. `w`/`h` are the obstacle's
// footprint, so a wider block sheds its pieces across a wider front.
function drawSplinters(ctx, cx, cy, t, w, h, seed) {
  const rand = rng(seed);
  const tt = t * OBSTACLE_WRECK_DURATION[SPLINTER];
  const travel = (1 - Math.exp(-2.6 * tt)) / 2.6; // mild drag: they keep going

  neonStroke(ctx, (c) => {
    for (let i = 0; i < 12; i++) {
      // Origins spread along the beam, not from a point, so the break runs the
      // whole width of the thing that broke.
      const sx = (rand() - 0.5) * w;
      const sy = (rand() - 0.5) * h;
      const a = rand() * Math.PI * 2;
      const speed = 120 + rand() * 190;
      const px = cx + sx + Math.cos(a) * speed * travel;
      const py = cy + sy + Math.sin(a) * speed * travel;

      // Each slat is a short segment lying along its own tumble angle — a stick,
      // not a spark, which is what makes this read as splintered timber/plastic
      // rather than as an explosion.
      const len = 5 + rand() * 7;
      const spin = a + (rand() - 0.5) * 8 * tt;
      c.moveTo(px - Math.cos(spin) * len, py - Math.sin(spin) * len);
      c.lineTo(px + Math.cos(spin) * len, py + Math.sin(spin) * len);
    }
  }, NEUTRAL, 2, 4, 0.13, Math.max(0, 1 - Math.pow(t, 1.4)));

  // A few brighter stripe shards, from the painted face of the beam. They fade
  // first, so the last thing on screen is plain debris.
  neonStroke(ctx, (c) => {
    for (let i = 0; i < 4; i++) {
      const sx = (rand() - 0.5) * w;
      const a = rand() * Math.PI * 2;
      const speed = 150 + rand() * 160;
      const px = cx + sx + Math.cos(a) * speed * travel;
      const py = cy + Math.sin(a) * speed * travel;
      c.moveTo(px, py);
      c.lineTo(px - Math.cos(a) * 9, py - Math.sin(a) * 9);
    }
  }, NEUTRAL_PALE, 1.5, 4, 0.13, Math.max(0, 1 - t * 1.8));
}

// Heavy debris: a hard hit that mostly stays where it happened.
function drawHeavyImpact(ctx, cx, cy, t, w, h, seed) {
  const rand = rng(seed);
  const tt = t * OBSTACLE_WRECK_DURATION[IMPACT];
  const size = Math.max(w, h);

  // The jolt: a squat ring that snaps outward and stops almost immediately.
  // Short reach on purpose — a shockwave that raced away would read light.
  if (t < 0.55) {
    const k = t / 0.55;
    const r = size * (0.22 + 0.42 * Math.sqrt(k));
    neonStroke(ctx, (c) => {
      c.moveTo(cx + r, cy);
      c.arc(cx, cy, r, 0, Math.PI * 2);
    }, NEUTRAL_PALE, 3.5, 4, 0.15, 1 - k);
  }

  // Four stubby lances at the contact point: the force having nowhere to go.
  if (t < 0.3) {
    const k = 1 - t / 0.3;
    const L = size * 0.42 * (1 - k * 0.45);
    neonStroke(ctx, (c) => {
      for (let i = 0; i < 4; i++) {
        const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
        c.moveTo(cx + Math.cos(a) * L * 0.25, cy + Math.sin(a) * L * 0.25);
        c.lineTo(cx + Math.cos(a) * L, cy + Math.sin(a) * L);
      }
    }, "#ffffff", 3.5, 5, 0.18, k);
  }

  // The chunks. Heavy drag (8/sec vs the splinters' 2.6) means they lurch out
  // and stop dead inside the first fifth of a second, then just lie there
  // rocking — the settle is what sells the weight.
  const travel = (1 - Math.exp(-8 * tt)) / 8;
  neonStroke(ctx, (c) => {
    for (let i = 0; i < 6; i++) {
      const sx = (rand() - 0.5) * w * 0.7;
      const sy = (rand() - 0.5) * h * 0.7;
      const a = rand() * Math.PI * 2;
      const speed = 130 + rand() * 150;
      const px = cx + sx + Math.cos(a) * speed * travel;
      const py = cy + sy + Math.sin(a) * speed * travel;

      // Chunks are quads, not sticks: a lump of concrete or welded steel with
      // area, tumbling to a halt as its drag runs out.
      const r = 4 + rand() * 5;
      const ang = (rand() - 0.5) * 5 * travel * 8;
      for (let k = 0; k < 4; k++) {
        const a1 = ang + (k / 4) * Math.PI * 2;
        const a2 = ang + ((k + 1) / 4) * Math.PI * 2;
        c.moveTo(px + Math.cos(a1) * r, py + Math.sin(a1) * r);
        c.lineTo(px + Math.cos(a2) * r, py + Math.sin(a2) * r);
      }
    }
  }, NEUTRAL, 2, 4, 0.13, t < 0.7 ? 1 : Math.max(0, 1 - (t - 0.7) / 0.3));

  // Dust: a dim, slowly spreading ring of dashes low to the tarmac, still
  // hanging there after the chunks have stopped. The one part of the effect
  // that outlives the impact, so the spot stays marked for a beat.
  neonStroke(ctx, (c) => {
    for (let i = 0; i < 10; i++) {
      const a = (i / 10) * Math.PI * 2 + rand() * 0.4;
      const r = size * (0.35 + 0.55 * t) * (0.75 + rand() * 0.5);
      c.moveTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
      c.lineTo(cx + Math.cos(a + 0.22) * r, cy + Math.sin(a + 0.22) * r);
    }
  }, NEUTRAL_DEEP, 2.5, 3, 0.12, Math.max(0, 1 - t) * 0.7);
}

// A burst water barrel. The odd one out of the three, on purpose: it is the only
// destruction in the game that is GOOD NEWS, so it borrows none of the impact
// vocabulary — no shockwave, no white lance flash, no tumbling chunks. It is a
// crown of spray that spreads, slows and settles into a puddle, with a few
// amber shards of plastic drum mixed in so it still reads as a barrel that
// burst rather than as weather.
//
// COLOUR. The spray is GREEN, not cyan. Cyan is the player's own colour and the
// mine blast already borrows it, and water is the one effect on the road that
// means "you are fine" — putting it in the world's phosphor green says harmless
// the way amber says hazard. It also keeps the spray from competing with the one
// thing that must always be findable on screen: the player's car.
function drawWaterBurst(ctx, cx, cy, t, w, h, seed) {
  const rand = rng(seed);
  const tt = t * OBSTACLE_WRECK_DURATION[WATER];
  const size = Math.max(w, h);

  // The crown: a ring with a scalloped edge, thrown up at the moment of impact.
  // The scallops are what stop it reading as the impact's clean shockwave — a
  // sheet of water tears as it spreads.
  if (t < 0.6) {
    const k = t / 0.6;
    const r = size * (0.18 + 0.5 * Math.sqrt(k));
    neonStroke(ctx, (c) => {
      const N = 28;
      for (let i = 0; i <= N; i++) {
        const a = (i / N) * Math.PI * 2;
        const rr = r * (1 + 0.13 * Math.sin(a * 5 + seed));
        const x = cx + Math.cos(a) * rr;
        const y = cy + Math.sin(a) * rr;
        if (i === 0) c.moveTo(x, y);
        else c.lineTo(x, y);
      }
    }, GREEN_BRIGHT, 2.5, 4, 0.14, 1 - k);
  }

  // Droplets. Heavy drag (5/sec) and short streaks that get shorter as they
  // slow: water goes out fast, loses everything it had, and falls.
  const travel = (1 - Math.exp(-5 * tt)) / 5;
  neonStroke(ctx, (c) => {
    for (let i = 0; i < 20; i++) {
      const sx = (rand() - 0.5) * w * 0.6;
      const sy = (rand() - 0.5) * h * 0.6;
      const a = rand() * Math.PI * 2;
      const speed = 110 + rand() * 210;
      const px = cx + sx + Math.cos(a) * speed * travel;
      const py = cy + sy + Math.sin(a) * speed * travel;
      const len = (3 + rand() * 6) * Math.max(0.25, 1 - t);
      c.moveTo(px, py);
      c.lineTo(px - Math.cos(a) * len, py - Math.sin(a) * len);
    }
  }, GREEN_PALE, 2, 4, 0.13, Math.max(0, 1 - Math.pow(t, 1.7)));

  // The puddle: a wide, dim, wobbling pool that spreads slowly and is the LAST
  // thing to fade. Water doesn't vanish, it lies there — and it gives the barrels
  // an afterimage that the tetra's dust ring deliberately echoes at half the
  // friendliness.
  neonStroke(ctx, (c) => {
    const N = 24;
    const pr = size * (0.3 + 0.42 * t);
    for (let i = 0; i <= N; i++) {
      const a = (i / N) * Math.PI * 2;
      const rr = pr * (1 + 0.16 * Math.sin(a * 3 + seed * 1.7));
      const x = cx + Math.cos(a) * rr;
      const y = cy + Math.sin(a) * rr * 0.8; // squashed: a pool spreads sideways
      if (i === 0) c.moveTo(x, y);
      else c.lineTo(x, y);
    }
  }, GREEN_DIM, 2.5, 3, 0.12, t < 0.5 ? 0.85 : Math.max(0, 1 - (t - 0.5) / 0.5) * 0.85);

  // Shards of the drum itself, so the burst stays attached to the object that
  // burst. Amber, few, and gone early — the water is the event, not these.
  neonStroke(ctx, (c) => {
    for (let i = 0; i < 5; i++) {
      const a = rand() * Math.PI * 2;
      const speed = 90 + rand() * 130;
      const px = cx + Math.cos(a) * speed * travel;
      const py = cy + Math.sin(a) * speed * travel;
      const spin = a + (rand() - 0.5) * 7 * tt;
      const len = 4 + rand() * 5;
      c.moveTo(px - Math.cos(spin) * len, py - Math.sin(spin) * len);
      c.lineTo(px + Math.cos(spin) * len, py + Math.sin(spin) * len);
    }
  }, NEUTRAL, 2, 4, 0.13, Math.max(0, 1 - t * 1.6));
}

// Break a roadblock apart. `style` is SPLINTER, WATER or IMPACT
// (obstacleshapes.js says which per entry), `w`/`h` are the block's footprint.
export function drawObstacleWreck(ctx, cx, cy, t, opts = {}) {
  if (t < 0 || t >= 1) return;
  const { style = IMPACT, w = 60, h = 20, seed = 1 } = opts;
  ctx.save();
  if (style === SPLINTER) drawSplinters(ctx, cx, cy, t, w, h, seed);
  else if (style === WATER) drawWaterBurst(ctx, cx, cy, t, w, h, seed);
  else drawHeavyImpact(ctx, cx, cy, t, w, h, seed);
  ctx.restore();
}

// ---------------------------------------------------------------------------
// PICKUP COLLECTED — "GOOD NEWS" BURST
//
// The buff crates (game/pickupshapes.js, game/pickups.js) need their own
// event for the same reason drawWaterBurst gets one apart from drawHeavyImpact
// — obstacleshapes.js's own MINE/BLOCK split, restated here across a wider
// gap: everything above this line is something going WRONG (a car dying, a
// mine going off, a roadblock breaking), and a collected buff is the one
// event on the road that is unambiguously good. So it borrows none of that
// vocabulary — no shockwave, no white lance flash, no debris that implies
// something broke. A clean ring expands and a few sparks kick outward along
// the reticle's own bracket directions, then it is gone.
//
// COLOUR IS THE ONE THING THAT VARIES, and it is the point of the parameter:
// `color` is passed in from whichever buff was just collected (the same
// accent the crate's own glyph used — pickupshapes.js), so the burst still
// answers "which one did I just get" for the instant it is on screen, the way
// drawWreck reuses a dying car's own colour rather than one fixed hue.
export const COLLECT_DURATION = 0.4;

function buildCollectSparks(c, cx, cy, r) {
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    const inner = r * 0.5;
    const outer = inner + 7;
    c.moveTo(cx + Math.cos(a) * inner, cy + Math.sin(a) * inner);
    c.lineTo(cx + Math.cos(a) * outer, cy + Math.sin(a) * outer);
  }
}

// Draw a collect burst centred at (cx, cy), `t` of the way through
// COLLECT_DURATION. opts: { color }.
export function drawCollectBurst(ctx, cx, cy, t, opts = {}) {
  if (t < 0 || t >= 1) return;
  const { color = GREEN_BRIGHT } = opts;
  const r = 4 + t * 26;
  const a = 1 - t;

  ctx.save();
  neonStroke(ctx, (c) => {
    c.moveTo(cx + r, cy);
    c.arc(cx, cy, r, 0, Math.PI * 2);
  }, color, 2, 4, 0.15, a * 0.9);
  neonStroke(ctx, (c) => buildCollectSparks(c, cx, cy, r), color, 1.5, 4, 0.13, a);
  ctx.restore();
}

// ---------------------------------------------------------------------------
// THE POOL
//
// Explosions are spawned mid-collision, at the exact moment the frame is already
// at its busiest, so this allocates NOTHING per detonation: slots are created
// once and reused, and a spawn on a full pool overwrites the oldest rather than
// growing the array or dropping the newest (the newest is the one the player is
// looking at). Every live wreck is four numbers plus the type's colours.
//
// Explosions are anchored in WORLD space by (worldY, offset), exactly as traffic
// cars are, so a wreck stays welded to the tarmac where the car died instead of
// sliding against the road as the world scrolls under it.
// ---------------------------------------------------------------------------

const MAX_WRECKS = 8;

// Slot kinds. Cars, mines, roadblocks, rocket impacts and collected pickups
// share ONE pool rather than getting one each: they are the same four numbers
// with a different drawer, they compete for the same frame budget, and a road
// that is simultaneously full of wrecks, mine blasts, shattered barriers and
// fireballs is exactly the moment we want a hard ceiling on all five —
// COLLECT included, so a run of buff crates picked up in quick succession
// cannot itself become the thing that starves the pool.
const WRECK = "wreck";
const BLAST = "blast";
const RUBBLE = "rubble";
const BURST = "burst";
const COLLECT = "collect";

// How long a slot lives. Not a plain map, because a roadblock's lifetime depends
// on its debris STYLE (a trestle is gone before a tetra has finished settling).
function slotDuration(s) {
  if (s.kind === BLAST) return MINE_BLAST_DURATION;
  if (s.kind === RUBBLE) return OBSTACLE_WRECK_DURATION[s.style];
  if (s.kind === BURST) return FIREBALL_DURATION;
  if (s.kind === COLLECT) return COLLECT_DURATION;
  return WRECK_DURATION;
}

export class Explosions {
  constructor(max = MAX_WRECKS) {
    this.slots = Array.from({ length: max }, () => ({
      alive: false,
      kind: WRECK, // which drawer and duration this slot uses
      style: IMPACT, // RUBBLE only: which debris look
      elapsed: 0,
      worldY: 0,
      offset: 0,
      seed: 1,
      shape: 0,
      color: "#ffffff",
      thrust: "#ffffff",
      w: 34,
      h: 62,
    }));
    this.next = 0; // round-robin cursor, so a full pool retires the oldest
    this.seed = 1;
  }

  // Claim a slot, preferring a free one and otherwise retiring the oldest — the
  // newest detonation is the one the player is looking at.
  take(worldY, offset, kind) {
    let slot = this.slots.find((s) => !s.alive);
    if (!slot) {
      slot = this.slots[this.next];
      this.next = (this.next + 1) % this.slots.length;
    }
    slot.alive = true;
    slot.kind = kind;
    slot.elapsed = 0;
    slot.worldY = worldY;
    slot.offset = offset;
    slot.seed = this.seed++;
    return slot;
  }

  // Blow up a car. The position says where it died; `type` says how it looked —
  // pass a CAR_TYPES entry straight through.
  spawn(worldY, offset, type) {
    const slot = this.take(worldY, offset, WRECK);
    slot.shape = type.shape ?? 0;
    slot.color = type.color;
    slot.thrust = type.thrust;
    slot.w = type.w;
    slot.h = type.h;
    return slot;
  }

  // Detonate a mine. It carries no silhouette or colours of its own — the blast
  // is the same discharge wherever it goes off — so position and seed are the
  // whole record.
  spawnMineBlast(worldY, offset) {
    return this.take(worldY, offset, BLAST);
  }

  // Break a roadblock. `shape` indexes OBSTACLE_SHAPES, which is where both the
  // debris style and the footprint the pieces spread across come from — so a new
  // roadblock is destructible the day it is added, exactly as a new car type is.
  spawnObstacleWreck(worldY, offset, shape) {
    const entry = OBSTACLE_SHAPES[shape] ?? OBSTACLE_SHAPES[0];
    const slot = this.take(worldY, offset, RUBBLE);
    slot.style = entry.debris ?? IMPACT;
    slot.shape = shape;
    slot.w = entry.size[0];
    slot.h = entry.size[1];
    return slot;
  }

  // A rocket's hit (weapons.js's ROCKET, routed through projectiles.js's
  // `impact` dispatch). Like the mine blast, it carries no target's silhouette
  // or colours — every rocket detonates the same way wherever it lands — so
  // position and seed are the whole record.
  spawnFireball(worldY, offset) {
    return this.take(worldY, offset, BURST);
  }

  // A buff crate collected (game/pickups.js). `color` is the crate's own
  // glyph accent (pickupshapes.js) so the burst still says which buff it was
  // for the instant it is on screen — see drawCollectBurst's header.
  spawnCollect(worldY, offset, color) {
    const slot = this.take(worldY, offset, COLLECT);
    slot.color = color;
    return slot;
  }

  update(dt) {
    for (const s of this.slots) {
      if (!s.alive) continue;
      s.elapsed += dt;
      if (s.elapsed >= slotDuration(s)) s.alive = false;
    }
  }

  // Screen mapping matches Traffic.render exactly, so a wreck sits where its car
  // was standing. No interpolation: like the road and the city, wrecks are placed
  // from the raw `distance`, and unlike a car they have no lateral motion to
  // smooth anyway.
  render(ctx, distance, playerY, W, H) {
    for (const s of this.slots) {
      if (!s.alive) continue;
      const sy = playerY - (s.worldY - distance);
      if (sy < -H || sy > H * 2) continue;
      const sx = centerXAt(s.worldY, W) + s.offset;
      const t = s.elapsed / slotDuration(s);
      if (s.kind === BLAST) drawMineBlast(ctx, sx, sy, t, s);
      else if (s.kind === RUBBLE) drawObstacleWreck(ctx, sx, sy, t, s);
      else if (s.kind === BURST) drawFireballBurst(ctx, sx, sy, t, s);
      else if (s.kind === COLLECT) drawCollectBurst(ctx, sx, sy, t, s);
      else drawWreck(ctx, sx, sy, t, s);
    }
  }
}
