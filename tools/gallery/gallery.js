// Asset gallery — a static showcase page (tools/gallery/gallery.html) for
// eyeballing neon assets in isolation, without running the game. Each asset is
// drawn on its own small canvas over an optional roadside-style grid backdrop.
//
// Lives in tools/ rather than src/, alongside the tuning editor, since like it
// this is a dev tool over the game's source rather than part of the game
// itself — nothing under src/ imports this file.
//
// To add an asset: draw it in src/game/sprites.js, then register a cell below.

import { clear, glowLine } from "../../src/engine/neon.js";
import { drawCar, drawObstacle } from "../../src/game/sprites.js";
import { drawShape, SHAPE_NAMES } from "../../src/game/buildingshapes.js";
import { CAR_SHAPES, drawShapeObject } from "../../src/game/carshapes.js";
import { bossGroups } from "../../src/game/bossshapes.js";
import { cycleFamilies } from "../../src/game/cycleshapes.js";
import { OBSTACLE_SHAPES, obstacleShapeIndex, BLOCK } from "../../src/game/obstacleshapes.js";
import {
  drawWreck,
  WRECK_DURATION,
  drawMineBlast,
  MINE_BLAST_DURATION,
  drawObstacleWreck,
  OBSTACLE_WRECK_DURATION,
  drawFireballBurst,
  FIREBALL_DURATION,
} from "../../src/game/effects.js";
import { drawDart } from "../../src/game/projectiles.js";
import { CAR_TYPES, ENEMY_FACTION } from "../../src/game/cartypes.js";
import { WEAPON_TYPES } from "../../src/game/weapons.js";
import { PICKUP_SHAPES, drawPickupShape } from "../../src/game/pickupshapes.js";
import { PICKUP_TYPES } from "../../src/game/pickuptypes.js";
import {
  drawCollectBurst,
  COLLECT_DURATION,
  drawTargetMark,
  drawShieldArc,
  ARC_DURATION,
} from "../../src/game/effects.js";
import * as pal from "../../src/engine/palette.js";

const gallery = document.getElementById("gallery");
const SIZE = 160; // per-cell canvas size in px

// Optional Tron-style grid backdrop, matching the in-game roadside floor.
function gridBackdrop(ctx, size) {
  ctx.save();
  ctx.strokeStyle = pal.GRID_LINE;
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let p = 0; p <= size; p += 32) {
    ctx.moveTo(0, p);
    ctx.lineTo(size, p);
    ctx.moveTo(p, 0);
    ctx.lineTo(p, size);
  }
  ctx.stroke();
  ctx.restore();
}

// Cells that opt into animation are redrawn every frame with a rising `phase`
// (px "travelled"), so wheels and other motion play in the gallery.
const animatedCells = [];

// Create one labelled cell. `draw(ctx, size, phase)` renders the asset; the
// origin is the canvas top-left, so use size/2 for the centre. Pass
// `{ animate: true }` to have the cell redrawn each frame with a rising phase.
function cell(label, draw, { grid = true, animate = false, size = SIZE, note = "" } = {}) {
  const fig = document.createElement("figure");
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");

  const paint = (phase) => {
    clear(ctx, "#05060a");
    if (grid) gridBackdrop(ctx, size);
    draw(ctx, size, phase);
  };
  paint(0);
  if (animate) animatedCells.push(paint);

  const caption = document.createElement("figcaption");
  caption.textContent = label;
  fig.append(canvas, caption);
  // An optional second line, dimmer and left-aligned: used by the boss
  // candidates, where the WHOLE point of the cell is the argument for that
  // variant and a bare name would tell you nothing.
  if (note) {
    const sub = document.createElement("figcaption");
    sub.className = "note";
    sub.textContent = note;
    fig.append(sub);
  }
  gallery.append(fig);
}

// A full-width divider inside the grid, so a run of related cells reads as one
// section rather than as more of the same stream.
function section(title, blurb = "") {
  const head = document.createElement("div");
  head.className = "section";
  const h = document.createElement("h2");
  h.textContent = title;
  head.append(h);
  if (blurb) {
    const p = document.createElement("p");
    p.textContent = blurb;
    head.append(p);
  }
  gallery.append(head);
}

// Single animation loop for every animated cell. Phase advances at a steady
// "cruising speed" so the wheel tread visibly rolls.
function startAnimation() {
  let phase = 0;
  let last = performance.now();
  function frame(now) {
    phase += ((now - last) / 1000) * 260; // px/sec, ~ default cruising speed
    last = now;
    for (const paint of animatedCells) paint(phase);
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

// A row of palette swatches so colour choices are visible at a glance.
function paletteCell() {
  const entries = [
    ["GREEN", pal.GREEN],
    ["GREEN_PALE", pal.GREEN_PALE],
    ["PLAYER", pal.PLAYER],
    ["ENEMY", pal.ENEMY],
    ["ENEMY_DEEP", pal.ENEMY_DEEP],
    ["NEUTRAL", pal.NEUTRAL],
    ["NEUTRAL_DEEP", pal.NEUTRAL_DEEP],
    ["NEUTRAL_PALE", pal.NEUTRAL_PALE],
    ["HAZARD", pal.HAZARD],
  ];
  cell("PALETTE", (ctx, size) => {
    const sw = size / entries.length;
    entries.forEach(([, color], i) => {
      ctx.save();
      ctx.fillStyle = color;
      ctx.shadowColor = color;
      ctx.shadowBlur = 8;
      ctx.fillRect(i * sw + 3, size / 2 - 24, sw - 6, 48);
      ctx.restore();
    });
  }, { grid: false });
}

// --- Registered assets ---
cell("PLAYER CAR", (ctx, size, phase) =>
  drawCar(ctx, size / 2, size / 2, { color: pal.PLAYER, thrust: pal.PLAYER_THRUST, wheelPhase: phase }),
  { animate: true });

// Traffic, straight from the catalogue — a new car type in cartypes.js shows up
// here on its own, at exactly the size and colours the game will drive it with.
//
// The caption carries every axis a type names — its tactic, its driving
// profile, and its score `value` — because the gallery is where you go to ask
// "which one is that?" and half the answer is now how it drives and what it's
// worth. Two cars can share a silhouette family and a colour and still be
// opposites (roadster vs hypercar), and reading `overtake/hustler` beside
// `overtake/showpiece` is the shortest way to see it. The value is what makes
// a one-off retune (a boss, a special civilian) visible at a glance instead of
// requiring a trip back into cartypes.js to check. Derived, never hand-written,
// so a retune in cartypes.js can't leave a stale caption behind.
CAR_TYPES.forEach((t) => {
  const drives = `${t.behaviour}/${t.driving ?? "commuter"}`;
  const value = t.value >= 0 ? `+${t.value}` : `${t.value}`;
  cell(`${t.faction === ENEMY_FACTION ? "ENEMY" : "CIVIL"} · ${t.label} · ${drives} · ${value}`, (ctx, size, phase) =>
    drawCar(ctx, size / 2, size / 2, {
      shape: t.shape, color: t.color, thrust: t.thrust, accent: t.accent, w: t.w, h: t.h, wheelPhase: phase,
    }),
    { animate: true });
});

// The silhouette catalogue, one cell each, all in the player's cyan so the cells
// compare SHAPES rather than faction colours. A car type picks one of these by
// index, exactly as a building picks a shape — so a new entry in carshapes.js
// appears here on its own, at its own default size.
//
// DRAWN AT 2x, for the same reason the cycle hulls below are: this section is a
// DETAIL study, not a size-accurate cell. The traffic cells above are the ones
// that promise "exactly the size the game will drive it with", which frees these
// to answer the question they actually exist for — does the panel work on this
// hull read, or does the glow swallow it? At 1x a 34x62 car cannot answer that,
// so every shape looked equally finished no matter how much was drawn into it.
// The caption carries the true size, so nothing here hides what the road sees.
const SHAPE_CELL = 200;
const SHAPE_ZOOM = 2;
CAR_SHAPES.forEach((s, i) => {
  cell(`CAR · ${s.name}`, (ctx, size, phase) => {
    ctx.save();
    ctx.translate(size / 2, size / 2);
    ctx.scale(SHAPE_ZOOM, SHAPE_ZOOM);
    drawCar(ctx, 0, 0, {
      shape: i, color: pal.PLAYER, thrust: pal.PLAYER_THRUST, wheelPhase: phase,
    });
    ctx.restore();
  }, { animate: true, size: SHAPE_CELL, note: `${s.size[0]}x${s.size[1]} · shown at 2x` });
});

// Phase 10 boss hulls, straight from bossshapes.js. Drawn bigger than the rest
// of the gallery (the road train is 180px long) and in the hostile red rather
// than the shape catalogue's cyan, because unlike a silhouette study these are
// meant to be read as ENEMIES.
//
// EXCEPT the cargo drone, which is the one group here that isn't one. It is the
// shop's, it is the only vehicle in the game that helps the player, and it flies
// in game/hauler.js in HAULER — the player's cyan a few steps darker. The cell
// uses the same pair, so the gallery shows the hull as the game actually paints
// it rather than in a red it stopped wearing.
//
// These have no cartypes.js record yet and deliberately will not until the boss
// phase — see bossshapes.js's header — so this section is the ONLY place they
// are visible at all. That makes it load-bearing rather than a nicety: without
// it the artwork is unreachable until something spawns it.
//
// The cargo-drone cell draws the PLAYER'S CAR underneath the hull before the
// hull itself. That is not decoration: the whole brief for that vehicle is that
// it picks the player up, so "can you still see the car once it has you?" is the
// question the cell exists to answer, and it cannot be answered without the car
// in the frame.
const BOSS_CELL = 220;
for (const group of bossGroups()) {
  const friendly = group.name === "CARGO DRONE";
  section(`STAGED HULL — ${group.name}`,
    friendly
      ? "player car drawn underneath, since the test is whether it stays visible while carried"
      : "");
  for (const s of group.shapes) {
    cell(s.name, (ctx, size, phase) => {
      if (friendly) {
        drawCar(ctx, size / 2, size / 2, {
          color: pal.PLAYER, thrust: pal.PLAYER_THRUST, wheelPhase: phase,
        });
      }
      drawShapeObject(ctx, size / 2, size / 2, s, {
        color: friendly ? pal.HAULER : pal.ENEMY,
        thrust: friendly ? pal.HAULER_THRUST : pal.ENEMY_THRUST,
        wheelPhase: phase,
      });
    }, { animate: true, size: BOSS_CELL, note: `${s.size[0]}x${s.size[1]} · ${s.pitch}` });
  }
}

// Two- and three-wheeler hulls, staged the same way and shown for the same
// reason (src/game/cycleshapes.js). Drawn at 2x, because the whole question
// these have to answer is whether every wheel stays clear of the bodywork and
// a 32x66 cell is too small to see a tyre edge in.
//
// The two families get the two traffic palettes rather than one shared colour:
// nothing has decided yet which of these is civilian and which is hostile, and
// seeing each hull in a plausible skin is more useful than seeing all four in
// enemy red.
const CYCLE_CELL = 200;
const CYCLE_ZOOM = 2;
for (const family of cycleFamilies()) {
  section(`${family.name} HULL`, "no car type yet — see cycleshapes.js");
  for (const s of family.shapes) {
    const hostile = s.family === "TRICYCLE";
    cell(s.name, (ctx, size, phase) => {
      ctx.save();
      ctx.translate(size / 2, size / 2);
      ctx.scale(CYCLE_ZOOM, CYCLE_ZOOM);
      drawShapeObject(ctx, 0, 0, s, {
        color: hostile ? pal.ENEMY_DEEP : pal.NEUTRAL,
        thrust: hostile ? pal.ENEMY_THRUST : pal.NEUTRAL_THRUST,
        wheelPhase: phase,
      });
      ctx.restore();
    }, { animate: true, size: CYCLE_CELL, note: `${s.size[0]}x${s.size[1]} · ${s.pitch}` });
  }
}

section("REST OF THE GALLERY");

// Road obstacles, straight from their catalogue — the three amber roadblocks
// and the mine. `phase` is px travelled, so dividing by the cruising speed gives
// seconds and the mine can blink at a fixed rate regardless of frame time.
OBSTACLE_SHAPES.forEach((s, i) => {
  cell(`OBS · ${s.name}`, (ctx, size, phase) =>
    drawObstacle(ctx, size / 2, size / 2, {
      shape: i,
      pulse: 0.5 + 0.5 * Math.sin((phase / 260) * 7),
    }),
    { animate: true });
});

// Destruction. The cell loops: the car sits intact for a beat, then is wrecked,
// so the effect can be judged against the sprite it replaces. `phase` is px
// travelled at a known speed, so dividing by it gives us seconds. The seed
// changes each pass, since the point is that no two wrecks look the same.
const FX_PAUSE = 0.7; // seconds the intact car is shown before it blows up
const FX_CYCLE = FX_PAUSE + WRECK_DURATION;
cell("FX · WRECK", (ctx, size, phase) => {
  const seconds = phase / 260; // 260 px/sec, matching startAnimation
  const time = seconds % FX_CYCLE;
  const opts = {
    shape: 6, // BRUISER — big enough to read the fragments
    color: pal.ENEMY,
    thrust: pal.ENEMY_THRUST,
    w: 40,
    h: 74,
    seed: Math.floor(seconds / FX_CYCLE) + 1,
  };
  if (time < FX_PAUSE) {
    drawCar(ctx, size / 2, size / 2, { ...opts, wheelPhase: phase });
  } else {
    drawWreck(ctx, size / 2, size / 2, (time - FX_PAUSE) / WRECK_DURATION, opts);
  }
}, { animate: true });

// The mine detonation, on the same armed-then-blown loop as the wreck cell above
// so the two effects can be compared back to back — telling them apart at a
// glance is the whole point of the EMP bloom being energy rather than debris.
const MINE_CYCLE = FX_PAUSE + MINE_BLAST_DURATION;
cell("FX · MINE BLAST", (ctx, size, phase) => {
  const seconds = phase / 260;
  const time = seconds % MINE_CYCLE;
  if (time < FX_PAUSE) {
    drawObstacle(ctx, size / 2, size / 2, {
      shape: obstacleShapeIndex("CALTROP"),
      pulse: 0.5 + 0.5 * Math.sin(seconds * 7),
    });
  } else {
    drawMineBlast(ctx, size / 2, size / 2, (time - FX_PAUSE) / MINE_BLAST_DURATION, {
      seed: Math.floor(seconds / MINE_CYCLE) + 1,
    });
  }
}, { animate: true });

// The rocket itself (weapons.js's ROCKET) — a static dart, flickering, at
// several times its true in-game size (16x6 world units) so the shape reads at
// a glance. The gallery otherwise draws things at exactly the size the game
// uses them (see the CAR_TYPES cells above); this is the one exception,
// because at true size a dart this small would be a handful of pixels.
const ROCKET_TYPE = WEAPON_TYPES.find((t) => t.id === "rocket");
const ROCKET_GALLERY_SCALE = 3;
cell("WPN · ROCKET", (ctx, size, phase) => {
  const flicker = 0.75 + 0.25 * Math.sin(phase * 0.035); // matches projectiles.js's own flicker
  drawDart(ctx, size / 2, size / 2, 0, {
    color: ROCKET_TYPE.color,
    glow: ROCKET_TYPE.glow,
    length: ROCKET_TYPE.length * ROCKET_GALLERY_SCALE,
    width: ROCKET_TYPE.width * ROCKET_GALLERY_SCALE,
    flicker,
  });
}, { animate: true });

// The fireball it detonates into, on the same armed-then-blown loop as the
// wreck and mine-blast cells above — the point of the loop is to see the FX
// against the thing it replaces.
const FIREBALL_PAUSE = 0.5;
const FIREBALL_CYCLE = FIREBALL_PAUSE + FIREBALL_DURATION;
cell("FX · FIREBALL", (ctx, size, phase) => {
  const seconds = phase / 260;
  const time = seconds % FIREBALL_CYCLE;
  if (time < FIREBALL_PAUSE) {
    const flicker = 0.75 + 0.25 * Math.sin(phase * 0.035);
    drawDart(ctx, size / 2, size * 0.72, 0, {
      color: ROCKET_TYPE.color,
      glow: ROCKET_TYPE.glow,
      length: ROCKET_TYPE.length * ROCKET_GALLERY_SCALE,
      width: ROCKET_TYPE.width * ROCKET_GALLERY_SCALE,
      flicker,
    });
  } else {
    drawFireballBurst(ctx, size / 2, size / 2, (time - FIREBALL_PAUSE) / FIREBALL_DURATION, {
      seed: Math.floor(seconds / FIREBALL_CYCLE) + 1,
    });
  }
}, { animate: true });

// Roadblocks breaking, one cell per block, on the same intact-then-destroyed
// loop. Each block uses the debris style its catalogue entry names, so the light
// trestle and the two heavy blocks can be compared directly — that contrast is
// the whole point of having two styles.
OBSTACLE_SHAPES.forEach((s, i) => {
  if (s.family !== BLOCK) return;
  const cycle = FX_PAUSE + OBSTACLE_WRECK_DURATION[s.debris];
  cell(`FX · ${s.name} HIT`, (ctx, size, phase) => {
    const seconds = phase / 260;
    const time = seconds % cycle;
    if (time < FX_PAUSE) {
      drawObstacle(ctx, size / 2, size / 2, { shape: i });
    } else {
      drawObstacleWreck(ctx, size / 2, size / 2,
        (time - FX_PAUSE) / OBSTACLE_WRECK_DURATION[s.debris], {
          style: s.debris,
          w: s.size[0],
          h: s.size[1],
          seed: Math.floor(seconds / cycle) + 1,
        });
    }
  }, { animate: true });
});

// Cube buildings. Base is placed low in the cell so the extruded roof has room
// above it. Varied width/depth/height show the skyline range.
// The three box proportions the city leans on, drawn through the catalogue
// like every other shape — there is no separate box renderer any more.
const BOX = SHAPE_NAMES.indexOf("BOX");

cell("BLDG · SHORT", (ctx, size) =>
  drawShape(ctx, size / 2, size * 0.68, BOX, { w: 64, d: 48, height: 34, color: pal.GREEN }));

cell("BLDG · TALL", (ctx, size) =>
  drawShape(ctx, size / 2, size * 0.74, BOX, { w: 56, d: 44, height: 78, color: pal.GREEN }));

cell("BLDG · WIDE", (ctx, size) =>
  drawShape(ctx, size / 2, size * 0.70, BOX, { w: 96, d: 40, height: 50, color: pal.GREEN }));

// The alternative silhouettes, one cell each — every third slot of the city's
// variant catalogue draws one of these instead of a box.
SHAPE_NAMES.forEach((name, i) => {
  cell(`BLDG · ${name}`, (ctx, size) =>
    drawShape(ctx, size / 2, size * 0.76, i, {
      w: 58, d: 42, height: 62, color: pal.GREEN, lit: 0.55, seed: i + 2, skew: 0.26,
    }));
});

// Buff pickups, straight from their catalogue — one cell per PICKUP_TYPES
// entry, labelled with the same figures pickuptypes.js documents so the
// gallery doubles as a quick sanity check on the numbers. `phase` drives the
// shared reticle's breathing pulse and the shield glyph's own spinning tick,
// on the same clock a live crate uses (pickups.js's `age`).
PICKUP_TYPES.forEach((t) => {
  cell(`PICKUP · ${t.label}`, (ctx, size, phase) => {
    const seconds = phase / 260;
    const pulse = 0.7 + 0.3 * Math.sin(seconds * 2.2);
    drawPickupShape(ctx, size / 2, size / 2, t.shape, pulse, seconds);
  }, { animate: true });
});

// The "collected" burst, on the same armed-then-triggered loop as the other
// FX cells — see effects.js's drawCollectBurst header for why this is the one
// destruction-shaped event in the game that is unambiguously good news.
const COLLECT_PAUSE = 0.6;
const COLLECT_CYCLE = COLLECT_PAUSE + COLLECT_DURATION;
cell("FX · COLLECTED", (ctx, size, phase) => {
  const seconds = phase / 260;
  const time = seconds % COLLECT_CYCLE;
  if (time < COLLECT_PAUSE) {
    const pulse = 0.7 + 0.3 * Math.sin(seconds * 2.2);
    drawPickupShape(ctx, size / 2, size / 2, PICKUP_TYPES[3].shape, pulse, seconds); // FIX
  } else {
    drawCollectBurst(ctx, size / 2, size / 2, (time - COLLECT_PAUSE) / COLLECT_DURATION);
  }
}, { animate: true });

// The two SPECIALS effects (game/upgrades.js's shelf). Both are drawn over a
// car rather than in isolation, because neither means anything on its own — a
// reticle is a reticle around something, and an arc is a line to something.
cell("FX · LOCKED", (ctx, size, phase) => {
  const seconds = phase / 260;
  const type = CAR_TYPES[0];
  drawCar(ctx, size / 2, size / 2, {
    shape: type.shape,
    color: type.color,
    thrust: type.thrust,
    accent: type.accent,
    w: type.w,
    h: type.h,
    wheelPhase: 0,
  });
  // Fed the LOCK's own remaining time in the live game, so the brackets pulse
  // faster as the designation runs out — here, just the wall clock.
  drawTargetMark(ctx, size / 2, size / 2, type.w, type.h, seconds);
}, { animate: true });

// The shield's discharge, on the same armed-then-triggered loop the other FX
// cells use. The pause is longer than the bolt by some way, which is exactly
// the cadence game/shieldstorm.js fires at.
const ARC_PAUSE = 0.45;
const ARC_CYCLE = ARC_PAUSE + ARC_DURATION;
cell("FX · SHIELD ARC", (ctx, size, phase) => {
  const seconds = phase / 260;
  const type = CAR_TYPES[0];
  drawCar(ctx, size * 0.72, size / 2, {
    shape: type.shape,
    color: type.color,
    thrust: type.thrust,
    accent: type.accent,
    w: type.w,
    h: type.h,
    wheelPhase: 0,
  });
  const time = seconds % ARC_CYCLE;
  if (time < ARC_PAUSE) return;
  // A new seed per discharge, so successive bolts are different lines rather
  // than the same zigzag flashing — see effects.js on why one bolt does NOT
  // re-randomise within its own life.
  const seed = Math.floor(seconds / ARC_CYCLE) + 1;
  drawShieldArc(ctx, size * 0.2, size / 2, size * 0.72, size / 2,
    (time - ARC_PAUSE) / ARC_DURATION, { seed });
}, { animate: true });

paletteCell();
startAnimation();
