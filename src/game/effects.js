// Destruction and discharge effects — what happens on screen when something in
// the world gets hit.
//
// PHASE 15E-II-B RE-AUTHORS NEARLY ALL OF THIS FILE, not just the fade. Through
// 15e-ii-a every effect here was Canvas2D debris art built against a renderer
// (the three-pass `neonStroke` overdraw) that no longer exists — bloom now
// supplies the halo (engine/present.js), and a stroke's `alpha` fading through
// `BRIGHT_FS`'s threshold goes fully bloomless partway through its own life
// (engine/neon.js's `neonStroke` header has the derivation). The brief for
// this phase was not "patch the fade in place"; it was "the project owner
// explicitly invited a second answer to `the car is destroyed`, is the
// existing debris vocabulary even still the right one". It wasn't, for four
// of the events below, and the record of WHY is kept here rather than
// deleted, per this repo's rule on superseded decisions.
//
// TWO NEW VOCABULARIES, PLUS ONE CARRIED OVER UNCHANGED:
//
//   BLOCK SHATTER (drawWreck, the three roadblock materials). A destroyed
//   object's RENDER fails rather than its parts flying off it — the
//   silhouette is sampled onto a small grid and the occupied cells fly
//   outward, shrinking to a point at CONSTANT alpha. This is deliberately not
//   a glass-shatter trope: it echoes `GLITCH_FS`'s own macroblock vocabulary
//   (engine/gl/shaders.js) — the game's fiction is already "you are looking
//   at a signal", so a destroyed object's picture failing block by block is
//   the same category of event as the signal itself failing, just local and
//   permanent. Squares, always — see AREA PULSE below for why that shape
//   choice is load-bearing.
//
//   AREA PULSE (drawMineBlast, drawFireballBurst, drawCollectBurst,
//   drawShieldArc). These four are not objects failing, they are ENERGY AT A
//   POINT (or, for the arc, energy travelling between two points) with a real
//   radius — so the idiom is a WAVEFRONT REVEALING a field rather than blocks
//   flying off a silhouette. Every cell in the field gets an arrival time
//   from its own position (radial distance for a point event, distance along
//   the line for the arc); a cell not yet arrived is not drawn AT ALL, and
//   once arrived it flares then shrinks to a point over FLARE_HOLD of the
//   effect's own life — the identical `GLITCH_FS` "frontier through a block
//   field" mechanism (`uResolve` sweeping `arriveT`), reused here in 2D so
//   the whole game speaks one dialect for "something happened here" rather
//   than three unrelated ones. DRAWN AS CIRCLES, NOT SQUARES, except the mine
//   and the shield arc, which are TRIANGLES — see each effect's own header
//   for why. The shape difference (square vs. circle/triangle) is what keeps
//   "an object's picture failed" reading as a different category of event
//   from "energy happened here" at a glance, before colour or duration are
//   read at all.
//
//   drawTargetMark and drawHullMeter are UNCHANGED — neither is a fade (a
//   persistent pulse and a plain instrument respectively); see each for the
//   one-line decision on why.
//
// WHAT THIS BUYS ON THE ORIGINAL BRIEF (a threshold-free fade) FOR FREE: every
// block/circle/triangle in both new vocabularies fades by SHRINKING TO A
// POINT at alpha 1, never by thinning a stroke or ramping alpha down — see
// engine/neon.js's `neonStroke` header for why thinning a stroke cannot do
// this (the width trap) and why shrinking the geometry can. Nothing below
// crosses BLOOM_THRESHOLD's knee partway through its own life the way the
// pre-15e-ii-b file did.
//
// STATELESS DRAWING, UNCHANGED FROM BEFORE. Every draw function here is a PURE
// function of normalised progress `t` (0 -> 1 across the effect's own
// `*_DURATION`): geometry is recomputed from a per-explosion seed every frame
// rather than stored, which keeps the artwork scrubbable (the gallery
// animates it straight from its own `phase` counter) and means the pool below
// only remembers (worldY, offset, seed, elapsed) per explosion — four
// numbers, no particle arrays.
//
// COST, UNCHANGED IN SHAPE. An explosion is unique per instance, so the
// sprite cache cannot help — every frame is drawn live, which is why nothing
// here uses ctx.shadowBlur (its cost scales with the shadow's BOUNDING-BOX
// AREA, and a debris field's box is large) and everything goes through
// `neonStroke` instead, batched so each pass costs one stroke regardless of
// fragment count. The ONE new cost this phase adds: block/pulse OCCUPANCY —
// which grid cells are inside a silhouette, or inside a disk — depends only
// on the shape's own dimensions, never on seed or t, so it is computed once
// per distinct shape and cached (`shatterCache`) rather than rebuilt every
// frame of every explosion. A car wreck's occupancy is the same array for
// every wreck of that car type; a mine's disk is the same array for every
// mine at that radius.

import { neonStroke, dartAt } from "../engine/neon.js";
import { carShapeOutline } from "./carshapes.js";
import { centerXAt } from "./road.js";
import {
  CRITICAL_FLASH,
  GREEN_BRIGHT,
  HAZARD,
  GREEN_DIM,
  NEUTRAL,
  PICKUP_FRAME_BRIGHT,
  PLAYER,
  PLAYER_THRUST,
  ROCKET,
  ROCKET_HOT,
  SHIELD_FLICKER,
} from "../engine/palette.js";
import { OBSTACLE_SHAPES, SPLINTER, WATER, IMPACT } from "./obstacleshapes.js";

// Seconds from detonation to gone.
export const WRECK_DURATION = 0.75;

// A mine's blast is a different event from a car dying and is over faster — see
// drawMineBlast below. SHORTENED in Phase 15e-ii-b (0.55 -> 0.32) alongside
// the switch to an area pulse: an EMP discharge reads as a zap, not a bloom
// that lingers, and the shorter window also means a slot frees up sooner —
// strictly cheaper at the MAX_WRECKS ceiling during a busy road, not more
// expensive.
export const MINE_BLAST_DURATION = 0.32;

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

// ---------------------------------------------------------------------------
// BLOCK SHATTER — shared by drawWreck and the three roadblock materials.
//
// OCCUPANCY IS CACHED, NOT PER-INSTANCE. Which grid cells sit inside a
// silhouette depends only on the silhouette's own shape and size (and the
// grid resolution), never on seed or t, so it is computed once per distinct
// key and reused by every explosion that shares it — the sprite-cache
// principle applied to a per-instance effect. `shatterCache` is unbounded
// only in the sense that nothing ever evicts it, which is fine: the possible
// keys are the car catalogue's (shape, w, h) triples and three fixed obstacle
// footprints, a few dozen entries for the life of a run, not a per-explosion
// allocation.
const shatterCache = new Map();

// Point-in-polygon via ray casting, over carShapeOutline's loops (each an
// array of [x, y] pairs in car-centred coordinates — see carshapes.js). Used
// only to build the occupancy grid once per car shape; never called per frame.
function pointInLoops(loops, x, y) {
  let inside = false;
  for (const loop of loops) {
    for (let i = 0, j = loop.length - 1; i < loop.length; j = i++) {
      const [xi, yi] = loop[i], [xj, yj] = loop[j];
      if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) inside = !inside;
    }
  }
  return inside;
}

// Build (or fetch) the occupied-cell list for a `key`: a `cols` x `rows` grid
// over a `w` x `h` box centred on the origin, keeping only cells where `test`
// is true. Each cell records its own centre offset and size, so a caller never
// has to re-derive them.
function blocksFor(key, w, h, cols, rows, test) {
  const k = `${key}:${w}:${h}:${cols}:${rows}`;
  let blocks = shatterCache.get(k);
  if (blocks) return blocks;
  blocks = [];
  const bw = w / cols, bh = h / rows;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const x = -w / 2 + bw * (c + 0.5), y = -h / 2 + bh * (r + 0.5);
      if (test(x, y)) blocks.push({ x, y, w: bw, h: bh });
    }
  }
  shatterCache.set(k, blocks);
  return blocks;
}

// The four occupancy shapes this file needs. A car's is the real silhouette
// (carShapeOutline); the three obstacle materials get simple parametric
// stand-ins rather than parsed geometry — obstacleshapes.js draws each with
// imperative glowPoly/glowLine calls with no shared "outline" abstraction to
// sample, and a rectangle/diamond/circle-pair reads close enough to each
// material's real footprint (a wide flat beam, a squat welded cross, a barrel
// pair) that the extra parsing was not worth building for a look effect.
const carBlocks = (shape, w, h, cols, rows) =>
  blocksFor(`car:${shape}`, w, h, cols, rows, (x, y) => pointInLoops(carShapeOutline(shape, w, h), x, y));
const rectBlocks = (w, h, cols, rows) => blocksFor("rect", w, h, cols, rows, () => true);
const diamondBlocks = (w, h, cols, rows) =>
  blocksFor("diamond", w, h, cols, rows, (x, y) => Math.abs(x) / (w / 2) + Math.abs(y) / (h / 2) <= 1.05);
const barrelBlocks = (w, h, cols, rows) =>
  blocksFor("barrels", w, h, cols, rows, (x, y) => Math.hypot(x + w / 4, y) <= h / 2 || Math.hypot(x - w / 4, y) <= h / 2);

// A field of occupied blocks flying outward from the object's own centre and
// SHRINKING TO A POINT at constant alpha 1 — the threshold-free fade every
// effect in this file now uses one form of. `life` is `t` (0..1 of the
// effect's own duration); `drag` shapes how far a block travels before it
// coasts (the same `(1 - e^-kt) / k` integral driving speed already used
// throughout this file); `bias` is an optional extra directional pull (water's
// upward kick) blended with the pure radial scatter.
function buildBlockShatter(c, cx, cy, blocks, life, rand, { speed, drag, spinMax, bias = [0, 0] }) {
  const recede = Math.max(0, 1 - life);
  if (recede <= 0) return;
  const travel = (1 - Math.exp(-drag * life)) / drag;
  for (const b of blocks) {
    const dist = Math.hypot(b.x, b.y) || 1;
    const nx = b.x / dist, ny = b.y / dist;
    const jitter = rand() * Math.PI * 2;
    const sp = speed[0] + rand() * (speed[1] - speed[0]);
    const dirx = nx * 0.7 + Math.cos(jitter) * 0.2 + bias[0] * 0.3;
    const diry = ny * 0.7 + Math.sin(jitter) * 0.2 + bias[1] * 0.3;
    const ox = dirx * sp * travel, oy = diry * sp * travel;
    const spin = (rand() - 0.5) * spinMax;
    const a = spin * life, cos = Math.cos(a), sin = Math.sin(a);
    const hw = (b.w / 2) * recede, hh = (b.h / 2) * recede;
    const px = cx + b.x + ox, py = cy + b.y + oy;
    const corners = [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]];
    for (let i = 0; i < 4; i++) {
      const [dx, dy] = corners[i];
      const rx = px + dx * cos - dy * sin, ry = py + dx * sin + dy * cos;
      if (i === 0) c.moveTo(rx, ry); else c.lineTo(rx, ry);
    }
    c.closePath();
  }
}

// ---------------------------------------------------------------------------
// AREA PULSE — shared by drawMineBlast, drawFireballBurst and
// drawCollectBurst; drawShieldArc reuses the same arrival-time idea walked
// along a line instead of a disk (see buildLinePulse, below its own header).
//
// Each cell's arrival time is its OWN radial distance (normalised to `maxR`)
// plus a fixed jitter draw — for `inward` effects (the collect burst) the
// field is read in the opposite direction, outermost arriving first, which is
// what makes an explosion push outward and a collect pull inward off the
// IDENTICAL function. A cell that has not yet arrived is not drawn at all
// (blank, not dim); once arrived it flares to full brightness then shrinks to
// a point over FLARE_HOLD of the effect's own life. Reading the true `maxR`
// straight off the field is what makes the pulse's own extent an honest tell
// of the event's real radius, rather than a decorative ring drawn at whatever
// looked right.
const FLARE_HOLD = 0.22; // fraction of an effect's life a cell stays visible after arriving

// `dartAt` (engine/neon.js) is the shape used wherever a pulse or a spark
// wants to read as SHARP/DIRECTIONAL rather than as a smooth radiating field
// — see buildAreaPulse's `mark` option and buildLinePulse below for the two
// places that choice is made per effect. Shared with game/walletrender.js's
// uplink packets, which is why it lives in neon.js rather than here.

// `mark` is "circle" (the default — a smooth radiating field, mine's own
// exception aside) or "triangle" (a field of outward-pointing darts, sharper
// and more electrical — drawMineBlast's own choice; see its header).
function buildAreaPulse(c, cx, cy, t, rand, { maxR, cols, rows, inward = false, edgeSpread = 0.28, blockScale = 1, mark = "circle" }) {
  const blocks = blocksFor(`disk:${maxR}`, maxR * 2, maxR * 2, cols, rows, (x, y) => Math.hypot(x, y) <= maxR);
  for (const b of blocks) {
    const dist = Math.hypot(b.x, b.y);
    const frac = maxR > 0 ? dist / maxR : 0;
    const jitter = (rand() - 0.5) * edgeSpread; // one rand() per block, fixed order — no t-dependent branch before this
    let arriveT = Math.min(1, Math.max(0, frac + jitter));
    if (inward) arriveT = 1 - arriveT;
    const age = t - arriveT;
    if (age < 0) continue; // hasn't arrived yet — blank, not dim
    const recede = Math.max(0, 1 - age / FLARE_HOLD);
    if (recede <= 0) continue;
    const r = (Math.min(b.w, b.h) / 2) * blockScale * recede;
    const px = cx + b.x, py = cy + b.y;
    if (mark === "triangle") {
      dartAt(c, px, py, r * 1.3, dist > 0.001 ? Math.atan2(b.y, b.x) : 0);
    } else {
      c.moveTo(px + r, py);
      c.arc(px, py, r, 0, Math.PI * 2);
    }
  }
}

// The 1-D form of the same idea: a travelling burst of darts from (x1,y1) to
// (x2,y2), each point's arrival time its own fraction of the distance along
// the line. Always triangles (see drawShieldArc's header for why a spark is
// drawn differently from an area pulse) and always a small perpendicular
// `crackle` jitter, so the burst still reads as electrical rather than as a
// travelling dot.
function buildLinePulse(c, x1, y1, x2, y2, t, rand, { count, edgeSpread = 0.12, crackle = 3 }) {
  const dx = x2 - x1, dy = y2 - y1;
  const len = Math.hypot(dx, dy) || 1;
  const dirAngle = Math.atan2(dy, dx); // every dart points toward the target
  const nx = -dy / len, ny = dx / len; // perpendicular, for the crackle offset
  for (let i = 0; i < count; i++) {
    const frac = i / (count - 1);
    const jitter = (rand() - 0.5) * edgeSpread;
    const arriveT = Math.min(1, Math.max(0, frac + jitter));
    const age = t - arriveT;
    if (age < 0) continue;
    const recede = Math.max(0, 1 - age / FLARE_HOLD);
    if (recede <= 0) continue;
    const off = (rand() - 0.5) * crackle;
    const px = x1 + dx * frac + nx * off, py = y1 + dy * frac + ny * off;
    dartAt(c, px, py, 2.4 * recede, dirAngle);
  }
}

// The arc's landing flare: a small field of OUTWARD-pointing darts at the
// target, timed so the flare blooms right as the travelling burst above
// arrives (arriveT ~= 1 at the far end of buildLinePulse). Its own tiny
// arrival loop rather than a call into buildAreaPulse, so its darts can point
// radially outward from the LANDING point — "a spark hitting and skittering
// off" — without adding a third option to buildAreaPulse's own `mark` switch
// for an effect that owns no other caller of it.
function buildLandingSpark(c, cx, cy, t, rand, maxR, cols, rows) {
  const blocks = blocksFor(`disk:${maxR}`, maxR * 2, maxR * 2, cols, rows, (x, y) => Math.hypot(x, y) <= maxR);
  for (const b of blocks) {
    const dist = Math.hypot(b.x, b.y) || 0.001;
    const frac = maxR > 0 ? dist / maxR : 0;
    const jitter = (rand() - 0.5) * 0.2;
    const arriveT = Math.min(1, Math.max(0, frac + jitter));
    const age = t - arriveT;
    if (age < 0) continue;
    const recede = Math.max(0, 1 - age / FLARE_HOLD);
    if (recede <= 0) continue;
    const r = (Math.min(b.w, b.h) / 2) * recede;
    dartAt(c, cx + b.x, cy + b.y, r, Math.atan2(b.y, b.x));
  }
}

// ---------------------------------------------------------------------------
// CAR WRECK
//
// The whole car — shell, interior spray, tumbling chunks — used to be three
// separate passes (an outline stroke, radial streaks, tumbling quads) that
// this phase's earlier draft re-authored into "plates": the outline's own
// segments extruded and receding. THAT DRAFT WAS SUPERSEDED, on sight, once
// block shatter existed as a direct comparison: plates read as "the
// wireframe broke", where block shatter reads as "the picture failed" — the
// stronger fit for a game whose fiction is a signal, and the same mechanism
// the three roadblock materials below now use, so a wreck and a broken
// barrier are legibly the same KIND of event rather than two unrelated ones
// that happen to share a colour convention.
//
// Because the occupancy grid is sampled from carShapeOutline, a new car type
// is destructible the day it is added — there is no per-type explosion art to
// draw, exactly as before.
const WRECK_COLS = 6, WRECK_ROWS = 9;
const WRECK_SPEED = [40, 150]; // px/sec range, low..high per block
const WRECK_DRAG = 2.6;
const WRECK_SPIN = 5; // rad/sec range, tumble as the block flies out

// Draw a wreck centred at (cx, cy), `t` of the way through WRECK_DURATION.
// opts: { shape, color, w, h, seed }
export function drawWreck(ctx, cx, cy, t, opts = {}) {
  if (t < 0 || t >= 1) return;
  const { shape = 0, color, w, h, seed = 1 } = opts;
  const rand = rng(seed);
  const blocks = carBlocks(shape, w, h, WRECK_COLS, WRECK_ROWS);
  ctx.save();
  neonStroke(ctx, (c) => buildBlockShatter(c, cx, cy, blocks, t, rand, { speed: WRECK_SPEED, drag: WRECK_DRAG, spinMax: WRECK_SPIN }),
    color, 2, 1);
  // A brief white core, so an effect built from fragments still reads as an
  // impact rather than the car quietly disassembling. IMPACT PUNCTUATION, not
  // a fragment — kept as an alpha fade on purpose: a saturated flash going
  // bloomless as it winds down reads as the flash itself dying, which is
  // correct for punctuation the way it was never correct for a fragment meant
  // to persist and travel.
  if (t < 0.2) {
    const k = 1 - t / 0.2;
    const r = Math.max(w, h) * 0.22 * k;
    neonStroke(ctx, (c) => { c.moveTo(cx + r, cy); c.arc(cx, cy, r, 0, Math.PI * 2); }, "#ffffff", 3, k);
  }
  ctx.restore();
}

// ---------------------------------------------------------------------------
// MINE DETONATION — "EMP BLOOM"
//
// Deliberately NOT the car wreck, still. A mine has no silhouette worth
// preserving and nothing to shatter, so it stays an AREA PULSE rather than
// block shatter — but it is the one pulse drawn as TRIANGLES rather than
// circles: a field of small darts pointing radially outward reads sharper and
// more electrical than the fireball/collect's smooth ripple, which is the
// right material for a synthetic discharge rather than fire or a pickup's
// gentle chime. Two overlaid pulses (cyan to the full radius, pale-red to 70%
// of it) read as a two-layer discharge; the pulse's own extent traces the
// blast's real radius, which the old jittering hex cage never did (its
// growth curve plateaued short of `radius`).
//
// THE JITTERING HEX CAGE AND THE LIGHTNING ARCS ARE BOTH GONE, on request —
// no radiating lines at all, and no white core either: a mine is not an
// impact-punctuation event the way a car dying or a heavy hit is, so the
// pulse alone is the whole tell now, the same shape of effect as the
// fireball below with a colder, sharper material.
//
// COLOUR. Cold cyan/red is what makes this read as synthetic discharge; safe
// only because the blast is half a second and expands from a point the
// player is nowhere near by then — a longer or slower cyan effect would
// compete with the one thing that must always be findable, the player's own
// car.
const MINE_COLS = 9, MINE_ROWS = 9;

export function drawMineBlast(ctx, cx, cy, t, opts = {}) {
  if (t < 0 || t >= 1) return;
  const { seed = 1, radius = 58 } = opts;
  const rand = rng(seed);
  ctx.save();
  neonStroke(ctx, (c) => buildAreaPulse(c, cx, cy, t, rand, { maxR: radius, cols: MINE_COLS, rows: MINE_ROWS, mark: "triangle" }),
    CRITICAL_FLASH, 2, 1);
  neonStroke(ctx, (c) => buildAreaPulse(c, cx, cy, t, rand, { maxR: radius * 0.7, cols: MINE_COLS, rows: MINE_ROWS, mark: "triangle" }),
    PLAYER, 2, 1);
  ctx.restore();
}

// ---------------------------------------------------------------------------
// ROCKET IMPACT — "FIREBALL BURST"
//
// The one true FIRE-coloured explosion in the game, still: drawWreck stays in
// the dying car's own colours and drawMineBlast stays cold cyan/red
// specifically so this is the only thing on the road that reads as flame.
//
// THE RAGGED OUTLINE RING AND INNER GLOW BECOME AN AREA PULSE, same
// mechanism as the mine, warm colours instead of cold and CIRCLES instead of
// triangles — a fireball's material is soft/hot, not sharp/electrical, so it
// keeps the smooth-ripple mark the mine deliberately opts out of. Two
// overlaid pulses (ROCKET to the full radius, ROCKET_HOT to 55% of it)
// replace what used to be a single ragged ring that stalled short of
// `radius` plus a separately-fading inner glow; the pulse's own extent now
// traces the blast's true reach.
//
// SMOKE AND EMBERS ARE KEPT as their own trailing debris — a flame particle
// is not "the picture failing", so neither joins the pulse mechanism. Embers
// now fade by SHRINK (their tail length -> 0 with `t`) rather than alpha,
// matching the droplet-shrink trick this file has used elsewhere. Smoke never
// fades out at all — it only ramps IN and stays low enough (GREEN_DIM's own
// peak channel, composited, never nears BLOOM_THRESHOLD at this alpha) that
// there was never a defect to fix there. The white core stays, same
// impact-punctuation reasoning as the wreck's.
export const FIREBALL_DURATION = 0.5;
const FIREBALL_COLS = 8, FIREBALL_ROWS = 8;

function buildFireballSmoke(c, cx, cy, tt, rand, radius) {
  for (let i = 0; i < 3; i++) {
    const a = -Math.PI / 2 + (rand() - 0.5) * 1.6;
    const rise = radius * (0.9 + rand() * 0.5);
    const x0 = cx + Math.cos(a) * radius * 0.35, y0 = cy + Math.sin(a) * radius * 0.35;
    const x1 = x0 + Math.cos(a) * rise * tt * 1.4, y1 = y0 + Math.sin(a) * rise * tt * 1.4 - rise * tt;
    c.moveTo(x0, y0); c.lineTo(x1, y1);
  }
}

// Embers thrown mostly upward and outward, then pulled down by a flat
// acceleration term — the one place "down" means something, which is part of
// what tells a fireball apart from a wreck's block field or a mine's radial
// pulse. Tail length shrinks to zero with `t` instead of fading by alpha.
function buildFireballEmbers(c, cx, cy, tt, rand, radius, t) {
  const G = radius * 5.5; // tuned for the burst's short life, not real units
  for (let i = 0; i < 8; i++) {
    const a = -Math.PI / 2 + (rand() - 0.5) * Math.PI * 1.3; // upward-ish, wide spread
    const speed = radius * (1.4 + rand() * 2.2);
    const vx = Math.cos(a) * speed, vy = Math.sin(a) * speed;
    const px = cx + vx * tt, py = cy + vy * tt + 0.5 * G * tt * tt;
    const tail = 0.06 * Math.max(0, 1 - t);
    c.moveTo(px, py);
    c.lineTo(px - vx * tail, py - (vy + G * tt) * tail);
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

  ctx.save();

  // Smoke first, so it reads as rising behind the fire rather than in front.
  neonStroke(ctx, (c) => buildFireballSmoke(c, cx, cy, tt, rand, radius),
    GREEN_DIM, 2, Math.max(0, t - 0.15) * 0.6);

  neonStroke(ctx, (c) => buildAreaPulse(c, cx, cy, t, rand, { maxR: radius, cols: FIREBALL_COLS, rows: FIREBALL_ROWS }),
    ROCKET, 2, 1);
  neonStroke(ctx, (c) => buildAreaPulse(c, cx, cy, t, rand, { maxR: radius * 0.55, cols: FIREBALL_COLS, rows: FIREBALL_ROWS }),
    ROCKET_HOT, 2, 1);

  neonStroke(ctx, (c) => buildFireballEmbers(c, cx, cy, tt, rand, radius, t),
    ROCKET, 2, 1);

  // The white core flash — same device drawWreck uses, so an impact still
  // reads as one even before the eye has parsed the fire.
  if (t < 0.22) {
    const k = 1 - t / 0.22;
    const r = radius * 0.24 * k;
    neonStroke(ctx, (c) => { c.moveTo(cx + r, cy); c.arc(cx, cy, r, 0, Math.PI * 2); }, "#ffffff", 3, k);
  }
  ctx.restore();
}

// ---------------------------------------------------------------------------
// ROADBLOCK DESTRUCTION
//
// A roadblock breaking is a THIRD kind of event, and — as before — the whole
// point of these three drawers is that the player learns what they just hit
// without being told. That distinction now lives entirely in BLOCK TUNING and
// COLOUR rather than in three bespoke debris vocabularies (slats vs. spray vs.
// chunks-and-shockwave):
//
//   SPLINTER (the trestle) — MANY small blocks, fast, LOW drag: a trestle
//   coming apart shouldn't feel like it cost you, so unlike the tetra there
//   is no flash.
//
//   IMPACT (the tetra) — FEW big blocks, slow, HIGH drag: they stop almost
//   where they started, the same "heavy doesn't go far" argument the old
//   shockwave-plus-chunks pair made, now carried entirely by the blocks
//   themselves. A strong flash IS kept — this is the one obstacle meant to
//   feel expensive to hit.
//
//   WATER (the barrels) — SAME mechanism and tuning shape as the other two,
//   differentiated by colour (GREEN_BRIGHT) alone plus a slight upward bias
//   (a burst still throws spray up before gravity takes it), per the call to
//   keep water on one logic rather than its own vocabulary. No flash — water
//   stays the one good-news destruction on the road. THE OLD CROWN/DROPLET/
//   PUDDLE LOOK, AND THE LINGERING PUDDLE WITH IT, ARE GONE: water no longer
//   leaves anything behind once the burst is over. If a lingering puddle is
//   wanted later, that is a separate effect layered on top of this shatter,
//   not a reason to special-case the shatter itself.
//
// All three go through neonStroke for the reason this file has always cited:
// ctx.shadowBlur is priced by bounding-box area, and a debris field's box is
// large.

// Seconds from hit to gone, per style (obstacleshapes.js names the styles).
// Unchanged from before this phase — block shatter reads fine at the existing
// windows, and retuning duration was not part of what this phase set out to
// change.
export const OBSTACLE_WRECK_DURATION = { [SPLINTER]: 0.45, [WATER]: 0.7, [IMPACT]: 0.6 };

const SPLINTER_COLS = 10, SPLINTER_ROWS = 3;
const SPLINTER_SPEED = [90, 220];
const SPLINTER_DRAG = 1.6;
const SPLINTER_SPIN = 8;

const IMPACT_COLS = 4, IMPACT_ROWS = 4;
const IMPACT_SPEED = [25, 70];
const IMPACT_DRAG = 5.5;
const IMPACT_SPIN = 3;

const WATER_COLS = 6, WATER_ROWS = 6;
const WATER_SPEED = [70, 180];
const WATER_DRAG = 3.2;
const WATER_SPIN = 6;
const WATER_BIAS = [0, -1]; // up

function drawSplinters(ctx, cx, cy, t, w, h, seed) {
  const rand = rng(seed);
  const blocks = rectBlocks(w, h, SPLINTER_COLS, SPLINTER_ROWS);
  neonStroke(ctx, (c) => buildBlockShatter(c, cx, cy, blocks, t, rand, { speed: SPLINTER_SPEED, drag: SPLINTER_DRAG, spinMax: SPLINTER_SPIN }),
    NEUTRAL, 2, 1);
}

function drawHeavyImpact(ctx, cx, cy, t, w, h, seed) {
  const rand = rng(seed);
  const blocks = diamondBlocks(w, h, IMPACT_COLS, IMPACT_ROWS);
  neonStroke(ctx, (c) => buildBlockShatter(c, cx, cy, blocks, t, rand, { speed: IMPACT_SPEED, drag: IMPACT_DRAG, spinMax: IMPACT_SPIN }),
    NEUTRAL, 2.5, 1);
  // The flash: the force having somewhere to punctuate even though the
  // blocks themselves barely travel.
  if (t < 0.22) {
    const k = 1 - t / 0.22;
    const r = Math.max(w, h) * 0.3 * k;
    neonStroke(ctx, (c) => { c.moveTo(cx + r, cy); c.arc(cx, cy, r, 0, Math.PI * 2); }, "#ffffff", 3.5, k);
  }
}

function drawWaterBurst(ctx, cx, cy, t, w, h, seed) {
  const rand = rng(seed);
  const blocks = barrelBlocks(w, h, WATER_COLS, WATER_ROWS);
  neonStroke(ctx, (c) => buildBlockShatter(c, cx, cy, blocks, t, rand, { speed: WATER_SPEED, drag: WATER_DRAG, spinMax: WATER_SPIN, bias: WATER_BIAS }),
    GREEN_BRIGHT, 2, 1);
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
// The buff crates need their own event for the reason they always have —
// everything else in this file is something going WRONG, and a collected
// buff is the one event on the road that is unambiguously good.
//
// AN AREA PULSE RUN INWARD — the one inversion in the whole family, and the
// reason this stayed an area pulse rather than becoming block shatter:
// destruction pushes energy OUT, taking something in pulls it IN, and
// `buildAreaPulse`'s `inward` flag is the one line of difference between the
// two readings off an otherwise identical mechanism. No new colour
// vocabulary is needed to say "this one's good news" — the direction alone
// does it. Replaces the old expanding ring plus radial sparks entirely.
//
// ONE COLOUR, THE CAR'S OWN, unchanged: the burst is drawn in the same
// player-cyan family the crate's frame rides in (palette.js's
// PICKUP_FRAME_BRIGHT), so collecting a buff reads as the car taking
// something INTO itself. Takes no options for the same reason as before —
// every crate bursts the same way regardless of which buff it was; the SYS
// LOG line answers "which one" in text. SHORTENED in Phase 15e-ii-b (0.4 ->
// 0.22) alongside the switch to an inward pulse: a pickup is a quick
// acknowledgement, not an event to linger on, and the shorter window is
// again strictly cheaper at the pool's ceiling, not more expensive.
export const COLLECT_DURATION = 0.22;
const COLLECT_RADIUS = 26;
const COLLECT_COLS = 6, COLLECT_ROWS = 6;

// Draw a collect burst centred at (cx, cy), `t` of the way through
// COLLECT_DURATION. `seed` varies the field's own jitter per crate so a run of
// pickups in quick succession doesn't visibly repeat.
export function drawCollectBurst(ctx, cx, cy, t, seed = 1) {
  if (t < 0 || t >= 1) return;
  const rand = rng(seed);
  ctx.save();
  neonStroke(ctx, (c) => buildAreaPulse(c, cx, cy, t, rand, { maxR: COLLECT_RADIUS, cols: COLLECT_COLS, rows: COLLECT_ROWS, inward: true, blockScale: 0.8 }),
    PICKUP_FRAME_BRIGHT, 1.6, 1);
  ctx.restore();
}

// --- The target reticle (weapons.js's AUTOLOCK) ------------------------------
//
// FOUR CORNER BRACKETS around the car the player's tracer rounds are chasing,
// unchanged by this phase. A closed rectangle would read as a UI element
// sitting on the road, and a colour wash would collide with the critical-hull
// blink that already owns "this car looks different" (traffic.js's
// BLINK_PERIOD). Corner ticks are the one shape that says "designated" at a
// glance, and they are four moveTo/lineTo pairs.
//
// IT IS THE UPGRADE'S ONLY EXPLANATION. Rounds that bend out of their lane are
// otherwise unaccountable — the player has to be able to see WHICH car they
// are bending toward, or a locked burst just looks like the gun has developed
// a fault.
//
// THE PULSE'S ON/OFF HALO BLINK WAS EXAMINED AND LEFT, ON PURPOSE, THIS
// PHASE. `alpha = 0.55 + 0.35*sin(...)` puts PLAYER_THRUST's fully-saturated
// channel through a composited range that straddles BLOOM_THRESHOLD (0.55),
// so the reticle's halo switches fully on and off once per pulse cycle — an
// accident of the threshold moving twice since this constant was tuned,
// arguably, but changing it was not confirmed as wanted and the current look
// is the shipped, already-familiar one. A future pass with a reason to settle
// this can retune MARK_PULSE's range then.
//
// NOT A POOLED SLOT, unlike everything above it. A lock is not an event with a
// lifetime of its own — it lasts as long as the designation does — and pooling
// it would mean a car outliving its own brackets, or the brackets outliving the
// car. Traffic.render calls this directly for the one locked car, with the same
// (cx, cy) it just drew that car at.
//
// `phase` is the lock's own REMAINING time, counted down, so the brackets pulse
// faster as the designation runs out — the countdown is the animation.
const MARK_CORNER = 9;   // px each bracket arm reaches along the box edge
const MARK_INSET = 4;    // px the brackets stand off the car's own box
const MARK_PULSE = 7;    // rad/sec

export function drawTargetMark(ctx, cx, cy, w, h, phase, color = PLAYER_THRUST) {
  const hw = w / 2 + MARK_INSET;
  const hh = h / 2 + MARK_INSET;
  // One sine drives brightness alone — the brackets do NOT move. A mark that
  // breathed in size would be read as the car changing shape.
  const alpha = 0.55 + 0.35 * (Math.sin(phase * MARK_PULSE) + 1) / 2;

  neonStroke(ctx, (c) => {
    for (const sx of [-1, 1]) {
      for (const sy of [-1, 1]) {
        const x = cx + sx * hw;
        const y = cy + sy * hh;
        c.moveTo(x - sx * MARK_CORNER, y);
        c.lineTo(x, y);
        c.lineTo(x, y - sy * MARK_CORNER);
      }
    }
  }, color, 1.6, alpha);
}

// --- The boss's hull meter ----------------------------------------------------
//
// A small bar under one car, saying how much of it is left. Unchanged by this
// phase — it is an INSTRUMENT, not neon (the node drain meter,
// game/walletrender.js, makes the same argument): a plain fill with a dark
// backing, no glow and no neonStroke, because it has to be readable at a
// glance by a player watching traffic rather than watching it. The road's
// first boss (cartypes.js's `mortar`) is the only thing that asks for one.
//
// UNDER THE HULL, not over it. The boss holds station at the TOP of the screen
// (behaviours.js's `siege`), so below it is the road between the boss and the
// player — already where the player is looking, and clear of the shape's raked
// tube and its up-screen overhang.
//
// IT ONLY EVER SHORTENS, AND IT NEVER CHANGES COLOUR. The player's own hull bar
// (main.js) ramps green to red as it empties, and copying that here would be a
// real mistake: on an ENEMY, red would arrive at the exact moment the player is
// winning and would read as danger. One colour — HAZARD, the game's own
// bad-news red — shrinking, says "threat remaining" and needs no learning.
//
// THE NOTCHES ARE THE POINT. `marks` are the fractions where the fight changes
// (armament.js's BARRAGE thresholds, passed in rather than restated here), so
// the bar is not a readout but a PROMISE: the player can see the next
// escalation coming and choose whether to push into it now or back off. Two
// fillRects, and the difference between a health bar and a fight with a shape.
const METER_W = 56;    // px. Inside the mortar's own 62px box, so the bar reads
                       // as belonging to the hull rather than floating under it
const METER_H = 3;
const METER_DROP = 10; // px below the car's box edge
const METER_PAD = 1;   // dark backing around the track

// `cx`/`cy` are the car's drawn centre — the same pair drawTargetMark takes, and
// the same the sprite was just blitted at. `frac` is hull remaining, 0..1.
export function drawHullMeter(ctx, cx, cy, h, frac, marks = []) {
  const x = cx - METER_W / 2;
  const y = cy + h / 2 + METER_DROP;

  ctx.save();
  ctx.fillStyle = "rgba(0,0,0,0.55)";
  ctx.fillRect(x - METER_PAD, y - METER_PAD, METER_W + METER_PAD * 2, METER_H + METER_PAD * 2);

  const left = Math.max(0, Math.min(1, frac));
  if (left > 0) {
    ctx.fillStyle = HAZARD;
    ctx.fillRect(x, y, METER_W * left, METER_H);
  }

  // The phase marks, drawn OVER the fill so they stay visible on the full bar
  // and on the empty track alike. A mark at 0 would sit on the bar's own end
  // and say nothing, so the catch-all threshold is skipped.
  ctx.fillStyle = "rgba(0,0,0,0.75)";
  for (const m of marks) {
    if (m <= 0 || m >= 1) continue;
    ctx.fillRect(x + METER_W * m, y - METER_PAD, 1, METER_H + METER_PAD * 2);
  }
  ctx.restore();
}

// --- The shield arc (game/shieldstorm.js) ------------------------------------
//
// One discharge from the player's shield to a car it has just bitten: a burst
// that TRAVELS from the shield to the target along the line between them,
// instead of an already-complete jagged bolt fading in place.
//
// A LINE PULSE, the 1-D form of the area-pulse mechanism above (buildLinePulse):
// the identical arrival-time field, walked along a segment instead of
// radiated across a disk, so the discharge visibly ARRIVES rather than
// existing complete and dimming. Two strands (a thicker leading one in the
// shield's own colour, a thinner trailing one in SHIELD_FLICKER) read as one
// hot discharge, the same "two strands" trick the old jagged-bolt version
// used. A small landing flare (buildLandingSpark) blooms right at the target
// as the burst arrives, echoing the destruction family's own impact language
// at a much smaller scale.
//
// TRIANGLES THROUGHOUT, not circles — on request, to read SHARP and sparky:
// a spark is directional (it flies somewhere), where an explosion's pulse is
// a radiating field with no preferred direction, and the shape difference is
// what keeps a discharge reading as electrical rather than as one more
// area pulse in a slightly different colour.
export const ARC_DURATION = 0.18; // seconds. An electrical discharge is a snap,
                                  // and this one fires several times a second

const ARC_MAIN_COUNT = 14;
const ARC_GLOW_COUNT = 9;
const ARC_LANDING_R = 10;
const ARC_LANDING_COLS = 4, ARC_LANDING_ROWS = 4;

// Draw one arc, `t` of the way through ARC_DURATION. (x1,y1) is the shield end
// and (x2,y2) the car it struck — both in screen space, resolved by the caller
// for THIS frame, so the bolt tracks a car that is still moving.
export function drawShieldArc(ctx, x1, y1, x2, y2, t, opts = {}) {
  if (t < 0 || t >= 1) return;
  const { color = PLAYER, glow = SHIELD_FLICKER, seed = 1 } = opts;
  ctx.save();
  neonStroke(ctx, (c) => buildLinePulse(c, x1, y1, x2, y2, t, rng(seed), { count: ARC_MAIN_COUNT }),
    color, 1.8, 1);
  neonStroke(ctx, (c) => buildLinePulse(c, x1, y1, x2, y2, t, rng(seed * 31 + 7), { count: ARC_GLOW_COUNT, crackle: 1.5 }),
    glow, 1.2, 0.85);
  neonStroke(ctx, (c) => buildLandingSpark(c, x2, y2, t, rng(seed * 7 + 3), ARC_LANDING_R, ARC_LANDING_COLS, ARC_LANDING_ROWS),
    glow, 1.4, 1);
  ctx.restore();
}

// ---------------------------------------------------------------------------
// THE POOL
//
// Unchanged in shape by this phase: explosions are spawned mid-collision, at
// the exact moment the frame is already at its busiest, so this allocates
// NOTHING per detonation — slots are created once and reused, and a spawn on
// a full pool overwrites the oldest rather than growing the array or dropping
// the newest (the newest is the one the player is looking at). Every live
// wreck is four numbers plus the type's colours.
//
// Explosions are anchored in WORLD space by (worldY, offset), exactly as
// traffic cars are, so a wreck stays welded to the tarmac where the car died
// instead of sliding against the road as the world scrolls under it.
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
const ARC = "arc";

// How long a slot lives. Not a plain map, because a roadblock's lifetime depends
// on its debris STYLE (a trestle is gone before a tetra has finished settling).
function slotDuration(s) {
  if (s.kind === BLAST) return MINE_BLAST_DURATION;
  if (s.kind === RUBBLE) return OBSTACLE_WRECK_DURATION[s.style];
  if (s.kind === BURST) return FIREBALL_DURATION;
  if (s.kind === COLLECT) return COLLECT_DURATION;
  if (s.kind === ARC) return ARC_DURATION;
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
      w: 34,
      h: 62,
      // ARC only: the OTHER end of the bolt — the shield it was thrown from.
      // An arc is the one slot kind that is a line between two places rather
      // than a thing that happens at one, and both ends are captured in world
      // space at the moment of the strike: the discharge stays welded to the
      // tarmac for its 0.18s exactly as a wreck does, rather than being
      // dragged along behind a car that is still driving.
      srcY: 0,
      srcOffset: 0,
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

  // A buff crate collected (game/pickups.js). Position is the whole record —
  // every crate bursts in the same player-cyan now, so there is nothing
  // per-crate to carry here; see drawCollectBurst's header.
  spawnCollect(worldY, offset) {
    return this.take(worldY, offset, COLLECT);
  }

  // One discharge from the player's shield (srcY, srcOffset) into a car it has
  // just bitten (worldY, offset) — game/shieldstorm.js. Shares the pool with
  // every other detonation on the road on purpose: a storm running inside a
  // pack is exactly the moment a hard ceiling on effects matters, and the
  // right thing to lose when the road is already full of fireballs is a spark,
  // not the fireball.
  spawnShieldArc(worldY, offset, srcY, srcOffset) {
    const slot = this.take(worldY, offset, ARC);
    slot.srcY = srcY;
    slot.srcOffset = srcOffset;
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
      if (s.kind === ARC) {
        // The only kind needing a SECOND screen position — mapped exactly as
        // the first one is, so both ends of the bolt sit on the road the same
        // way and a bend cannot shear it.
        const sy2 = playerY - (s.srcY - distance);
        const sx2 = centerXAt(s.srcY, W) + s.srcOffset;
        drawShieldArc(ctx, sx2, sy2, sx, sy, t, s);
      }
      else if (s.kind === BLAST) drawMineBlast(ctx, sx, sy, t, s);
      else if (s.kind === RUBBLE) drawObstacleWreck(ctx, sx, sy, t, s);
      else if (s.kind === BURST) drawFireballBurst(ctx, sx, sy, t, s);
      else if (s.kind === COLLECT) drawCollectBurst(ctx, sx, sy, t, s.seed);
      else drawWreck(ctx, sx, sy, t, s);
    }
  }
}
