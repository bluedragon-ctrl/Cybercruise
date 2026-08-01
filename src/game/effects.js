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

// Seconds from detonation to gone.
export const WRECK_DURATION = 0.75;

const PARTICLES = 14;  // interior streaks
const CHUNKS = 4;      // larger tumbling pieces
const DRAG = 3.4;      // 1/sec; position integrates to v*(1-e^-kt)/k
const SHELL_SPEED = 1.25; // the shell is thrown harder than the guts, so the
                          // silhouette opens up before the spray takes over

// Small deterministic PRNG. Seeding per explosion is what makes the particle
// layout stable across frames without storing it.
function rng(seed) {
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

export class Explosions {
  constructor(max = MAX_WRECKS) {
    this.slots = Array.from({ length: max }, () => ({
      alive: false,
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

  // Blow up a car. `car` supplies where it died; `type` supplies how it looked —
  // pass a CAR_TYPES entry straight through.
  spawn(worldY, offset, type) {
    let slot = this.slots.find((s) => !s.alive);
    if (!slot) {
      slot = this.slots[this.next];
      this.next = (this.next + 1) % this.slots.length;
    }
    slot.alive = true;
    slot.elapsed = 0;
    slot.worldY = worldY;
    slot.offset = offset;
    slot.seed = this.seed++;
    slot.shape = type.shape ?? 0;
    slot.color = type.color;
    slot.thrust = type.thrust;
    slot.w = type.w;
    slot.h = type.h;
    return slot;
  }

  update(dt) {
    for (const s of this.slots) {
      if (!s.alive) continue;
      s.elapsed += dt;
      if (s.elapsed >= WRECK_DURATION) s.alive = false;
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
      drawWreck(ctx, sx, sy, s.elapsed / WRECK_DURATION, s);
    }
  }
}
