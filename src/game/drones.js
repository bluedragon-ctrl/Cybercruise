// Air traffic — a layer of small flying drones between the city floor
// (FLOOR_PARALLAX 0.5, scenery.js) and the elevated road (1.0, road.js).
//
// WHY THIS EXISTS. Phase 7's original 7c was a third, dimmer, static parallax
// tile standing in for a distant skyline — built, looked at, and rejected (see
// the design doc's 7c section for the reasoning). A static layer is a weak
// depth cue; what actually reads as depth in this game is a DISCRETE OBJECT
// MOVING AT A RATE DIFFERENT FROM EVERYTHING ELSE — exactly what makes 7b's
// traffic dots the biggest perceptual win in the whole phase. This layer is
// that idea applied to the band of the frame that currently has no motion in
// it at all: the sky between the floor and the road.
//
// A DRONE IS A PHASE, NOT AN ENTITY — same rule as scenery.js's traffic dots.
// Nothing here is spawned, freed or stored per-frame; droneField() below is a
// pure function of (clock, distance, playerY, W, H) that returns plain data,
// mirroring trafficDots/visibleBuildings so test/city-floor.test.js can
// exercise the motion under plain Node with no canvas anywhere in the call
// path. drawDrones() is the only function that touches ctx.
//
// NOT LOCKED TO THE STREET GRID. Ground traffic runs in the avenues and
// cross-streets because roads constrain it; air traffic has no such
// constraint, and flying at its own headings — diagonal, crossing the grid
// rather than running parallel to it — is most of what makes this read as AIR
// traffic rather than as more dots. See DRONE_HEADINGS below.
//
// PARALLAX. DRONE_PARALLAX sits between the floor's 0.5 and the road's 1.0 —
// drones fly above the city but below the camera's plane. Reuses scenery.js's
// own clock (its `clock` export) rather than keeping a second one, so this
// layer freezes exactly when the floor's traffic dots do (pause, death) —
// see scenery.js's own header for why that clock lives where it does.
//
// COST. This is the first genuinely per-frame path layer on the city floor —
// no tile to hide behind, so the README's three rendering rules are hard
// requirements: no ctx.shadowBlur (a drone is 2-4px; a shadow on that many
// scattered rects would cost far more than the rects), and every drone
// batched into one path per colour (body, nav light, ground shadow — three
// fill() calls total, not three per drone). See drawDrones() below for the
// measured cost.

import { clock, floorDist, laneDotPositions } from "./scenery.js";
import { DRONE_BODY, DRONE_NAV, DRONE_SHADOW } from "../engine/palette.js";
import { worldSeed } from "./worldseed.js";

// Between the floor (0.5) and the road (1) — tuned by eye, not derived; see
// the design doc's 7c section for the stratification this is the point of.
export const DRONE_PARALLAX = 0.72;

// Flight lines are periodic in world-y, like a lot row (citygrid.js), so the
// sky stays populated forever rather than being a fixed bank of lines that
// scrolls away for good after enough driving. ROW_SPACING is world-y px
// between successive rows; ROW_MARGIN walks a couple of extra rows either
// side of the direct window, since a diagonal line's visible SEGMENT can
// reach the screen even while its own row anchor (s=0) currently doesn't —
// cheap ones are filtered out below at negligible cost, see droneField.
const DRONE_ROW_SPACING = 900;
const DRONE_ROW_MARGIN = 1;

// A small, fixed set of headings (radians; 0 = screen-rightward, +PI/2 =
// screen-downward) and their own speeds (px/s along the heading) — the
// "bounded set derived from the drone index" the design doc asks for.
// Deliberately kept away from axis-aligned (0, PI/2, PI, -PI/2, and their
// neighbourhoods): an avenue's own traffic already owns "straight up the
// screen", and a drone flying that line would read as one more ground dot,
// not as something crossing the grid from its own direction.
const DRONE_HEADINGS = [
  { angle: 0.5, speed: 42 },
  { angle: 2.35, speed: 55 },
  { angle: -0.65, speed: 47 },
  { angle: 1.9, speed: 60 },
];

// Spacing between FORMATIONS along one flight line — large enough that
// usually at most one is visible on screen per line at once, which is what
// keeps sky traffic sparse (see the design doc's "reads better sparse than
// dense"). GROUP_PHASE offsets that spacing per lane so formations across
// different lines don't all arrive in lockstep.
const DRONE_GROUP_SPACING = 500;

// A formation is 1-3 drones a short way apart along the SAME heading — a
// tight cluster that reads as one delivery run rather than as noise. Which
// size a given lane draws is index-derived (laneParams below), not rolled
// per frame.
const DRONE_FORMATION_OFFSETS = [
  [0],
  [0, 16],
  [0, 16, 32],
];

// A drone is fully drawn before it crosses on/off screen, same reasoning as
// scenery.js's DOT_MARGIN.
const DRONE_MARGIN = 10;

// How far a row's own anchor may sit outside the direct [0,H] window and
// still be worth walking — see DRONE_ROW_SPACING's comment. Generous on
// purpose: the real gate is droneField's own on-screen check per drone below,
// this just bounds how many (row, heading) pairs get that check run on them.
const DRONE_ROW_BUFFER_FACTOR = 0.8;

const DRONE_SIZE = 3;      // body, px square
const DRONE_NAV_SIZE = 1.6; // nav light, px square
const DRONE_SHADOW_SIZE = 3; // ground marker, px square

const BLINK_PERIOD = 1.6; // seconds per on/off cycle
const BLINK_ON = 0.18;    // seconds lit within each cycle — short, like a strobe

// The shadow's screen-space vertical gap from its own drone is capped here.
// The RAW mechanism — the same "one world point, two parallax rates" idea
// every other depth cue on this floor already uses — is (dDist - fDist),
// and it is NOT bounded: at DRONE_PARALLAX - FLOOR_PARALLAX = 0.22, it is
// already 1000+px within the first couple thousand world units driven (well
// inside a typical run's opening seconds), which would put the shadow miles
// off screen from its own drone for nearly the whole game. Saturating it
// through tanh keeps the honest mechanism where it actually reads as depth —
// a small, genuinely GROWING gap right as the player starts driving — while
// capping it at a sane on-screen amount for the rest of the run, rather than
// the shadow drifting into nowhere the moment the player picks up any speed.
const DRONE_ALTITUDE_MAX = 14; // px, the ceiling the gap saturates toward

// Deterministic hash -> [0, 1) from any number (same trick as road.js,
// scenery.js and citygrid.js), salted with this run's world seed so the air
// over a city is that city's — see worldseed.js.
function hash(n) {
  const x = Math.sin((n + worldSeed()) * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}

// Everything about one flight line that's fixed for its lifetime, derived
// purely from its (row, heading-slot) index — nothing here depends on time.
function laneParams(row, h, W) {
  const heading = DRONE_HEADINGS[h];
  const seed = row * 977 + h * 131 + 4001; // distinct seed space from citygrid's own
  return {
    hx: Math.cos(heading.angle),
    hy: Math.sin(heading.angle),
    speed: heading.speed,
    ax: hash(seed) * W,                 // screen-x anchor — x never scrolls on this floor
                                         // (see scenery.js's header), so this IS a real
                                         // screen position, not a world one
    ay: row * DRONE_ROW_SPACING,        // world-y anchor — periodic, so lanes populate the
                                         // endless world the same way lot rows do
    groupPhase: hash(seed + 7) * DRONE_GROUP_SPACING,
    blinkPhase: hash(seed + 13) * BLINK_PERIOD,
    formation: DRONE_FORMATION_OFFSETS[Math.floor(hash(seed + 19) * DRONE_FORMATION_OFFSETS.length)],
  };
}

// The range of the lane's own path parameter `s` (px along its heading, s=0
// at the anchor) for which a point on the line falls inside the visible
// rect — the diagonal-line equivalent of laneDotPositions' [lo, hi], derived
// from the same two facts every other layer on this floor uses: screen x
// never scrolls, and screen y is playerY - (worldY - dDist).
//
//   screenX(s) = ax + s*hx
//   screenY(s) = playerY - (ay + s*hy - dDist) = (playerY - ay + dDist) - s*hy
//
// Both are linear in `s`, so each screen-space bound turns into an interval
// on `s`; the visible range is their intersection. An empty intersection
// (sMin > sMax) means this particular line isn't on screen at all right now
// — the common case, since most (row, heading) pairs walked below are
// filtered out here rather than ever producing a drone.
function laneSpan(ax, ay, hx, hy, dDist, playerY, W, H) {
  const loX = -DRONE_MARGIN, hiX = W + DRONE_MARGIN;
  const [sXlo, sXhi] = hx > 0
    ? [(loX - ax) / hx, (hiX - ax) / hx]
    : [(hiX - ax) / hx, (loX - ax) / hx];

  const c = playerY - ay + dDist;
  const loY = -DRONE_MARGIN, hiY = H + DRONE_MARGIN;
  const [sYlo, sYhi] = hy > 0
    ? [(c - hiY) / hy, (c - loY) / hy]
    : [(c - loY) / hy, (c - hiY) / hy];

  return [Math.max(sXlo, sYlo), Math.min(sXhi, sYhi)];
}

// Every drone visible this frame, as plain data — no canvas anywhere in this
// function (see this file's header). `lit` says whether a drone's nav light
// is in the "on" half of its blink cycle right now; `shadowY` is the drone's
// own screen y plus the frame's shadowGap (see DRONE_ALTITUDE_MAX above) — the
// two depths scrolling at different rates off the same world position, capped
// to a sane on-screen amount rather than left to grow with total distance
// driven (see DRONE_SHADOW's own comment in palette.js).
export function droneField(clockValue, distance, playerY, W, H) {
  const dDist = Math.round(distance * DRONE_PARALLAX);
  const fDist = floorDist(distance); // scenery.js's own floor distance,
                                      // recomputed here rather than threaded
                                      // through render()'s arguments — both
                                      // are one-liners off the same `distance`
  // The gap is the SAME for every drone in a given frame — dDist and fDist
  // are both plain functions of `distance` alone, with no per-drone term —
  // so it's computed once here rather than inside the per-drone loop below.
  const shadowGap = DRONE_ALTITUDE_MAX * Math.tanh((dDist - fDist) / DRONE_ALTITUDE_MAX);
  const drones = [];

  const buffer = W * DRONE_ROW_BUFFER_FACTOR;
  const ayLo = playerY + dDist - H - buffer;
  const ayHi = playerY + dDist + buffer;
  const rowLo = Math.floor(ayLo / DRONE_ROW_SPACING) - DRONE_ROW_MARGIN;
  const rowHi = Math.ceil(ayHi / DRONE_ROW_SPACING) + DRONE_ROW_MARGIN;

  for (let row = rowLo; row <= rowHi; row++) {
    for (let h = 0; h < DRONE_HEADINGS.length; h++) {
      const { hx, hy, speed, ax, ay, groupPhase, blinkPhase, formation } = laneParams(row, h, W);
      const [sMin, sMax] = laneSpan(ax, ay, hx, hy, dDist, playerY, W, H);
      if (sMin > sMax) continue;

      for (const s0 of laneDotPositions(DRONE_GROUP_SPACING, speed, clockValue, sMin, sMax, groupPhase)) {
        for (const off of formation) {
          const s = s0 + off;
          const x = ax + s * hx;
          const yWorld = ay + s * hy;
          const y = playerY - (yWorld - dDist);
          if (x < -DRONE_MARGIN || x > W + DRONE_MARGIN || y < -DRONE_MARGIN || y > H + DRONE_MARGIN) continue;

          const shadowY = y + shadowGap;
          const lit = ((clockValue + blinkPhase) % BLINK_PERIOD) < BLINK_ON;
          drones.push({ x, y, shadowY, lit });
        }
      }
    }
  }

  return drones;
}

// Three fill()s total — ground shadows, bodies, lit nav lights — batched the
// same way scenery.js's drawTrafficDots is: one beginPath()/fill() per
// colour, no ctx.shadowBlur (the glow this layer gets is DRONE_NAV's own
// alpha). The shadow pass draws EVERY drone (its shadow exists whether or not
// the nav light happens to be lit this frame); the nav pass only draws the
// ones currently lit.
//
// MEASURED at 600x800 by the rAF-saturation method (README's profiling-traps
// section): droneField() + this function together, with a live drone count in
// the low dozens, cost ~<TODO measure>us/frame — see the design doc's 7c
// section for the number against scenery.render()'s own ~0.36ms/frame.
function drawDrones(ctx, drones) {
  if (drones.length === 0) return;

  ctx.beginPath();
  for (const d of drones) {
    ctx.rect(d.x - DRONE_SHADOW_SIZE / 2, d.shadowY - DRONE_SHADOW_SIZE / 2, DRONE_SHADOW_SIZE, DRONE_SHADOW_SIZE);
  }
  ctx.fillStyle = DRONE_SHADOW;
  ctx.fill();

  ctx.beginPath();
  for (const d of drones) {
    ctx.rect(d.x - DRONE_SIZE / 2, d.y - DRONE_SIZE / 2, DRONE_SIZE, DRONE_SIZE);
  }
  ctx.fillStyle = DRONE_BODY;
  ctx.fill();

  ctx.beginPath();
  let anyLit = false;
  for (const d of drones) {
    if (!d.lit) continue;
    anyLit = true;
    ctx.rect(d.x - DRONE_NAV_SIZE / 2, d.y - DRONE_NAV_SIZE / 2, DRONE_NAV_SIZE, DRONE_NAV_SIZE);
  }
  if (anyLit) {
    ctx.fillStyle = DRONE_NAV;
    ctx.fill();
  }
}

// Draw order: called from main.js AFTER scenery.render (grid, buildings,
// floor traffic) and BEFORE road.render — the elevated road ribbon and
// everything on it are the foreground plane, and everything below it,
// drones included, sits under that paint. `distance` here is the SAME
// already-rounded camera value scenery.render receives (main.js's camY) —
// see scenery.render's own header for why a per-layer clock still rounds its
// own derivative of that value rather than trusting the one rounding upstream.
export function render(ctx, distance, playerY, W, H) {
  drawDrones(ctx, droneField(clock, distance, playerY, W, H));
}
