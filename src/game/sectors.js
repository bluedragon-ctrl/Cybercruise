// Sectors — the city is infinite but statistically uniform, so a long run has no
// shape. This gives it one: at a fixed distance interval the world's palette
// changes, the deck reads out the new sector's name in the SYS LOG, and the
// crossing itself is a brief full-screen "rescan" glitch — the deck re-syncing
// to a new grid — rather than a blend.
//
// The name is read out on the EDGE of crossing rather than labelled on the floor
// every frame, reusing the pattern links.js already uses for node callsigns. The
// rescan spends the same deck-glitch vocabulary (scanline tear, desync,
// re-materialisation) that spritecache.js's entry wipe does: a crossing is the
// moment that vocabulary is for, so there is no second, separate glitch.
//
// EVERYTHING BUT THE EDGE DETECTOR IS A PURE LOOKUP. citygrid.js's
// sectorIndex(fDist) is a pure function of position, like the rest of the floor;
// this file's only job is to notice when that answer CHANGES from one tick to
// the next ("an edge needs memory", as links.js puts it) and, on that edge
// alone, kick off the two things a lookup can't: a transient glitch timer and
// one SYS LOG line.

import { floorDist } from "./scenery.js";
import { sectorIndex } from "./citygrid.js";
import { setSector } from "../engine/palette.js";
import { announceCityLine } from "./links.js";
import { HINT } from "../engine/console.js";
import * as gameConsole from "../engine/console.js";

// Same hash trick as road.js/scenery.js/citygrid.js/links.js — each file
// keeps its own copy rather than sharing one, per those files' own comments
// on why (a shared utility module would be one more file to open to follow
// what is, everywhere it's used, a three-line deterministic PRNG).
function hash(n) {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}

// A-Z minus I/O — same exclusion links.js's own callsign() makes and for the
// same reason: both read too easily as 1/0 at 11px in a monospace HUD font.
const SECTOR_LETTERS = "ABCDEFGHJKLMNPQRSTUVWXYZ";

// This module's own seed space, distinct from citygrid's plot/node rolls and
// from links.js's conduit/ping/callsign ones — every hash-seeded catalogue on
// this floor gets its own offset for exactly this reason (see citygrid.js's
// lotAt comment on why the building roll doesn't reuse the plot roll's seed).
function sectorNameSeed(index) {
  return index * 97711 + 4001;
}

// A sector's stable name, derived from its own index the same deterministic
// way every other label on this floor is (citygrid.js's hash trick, links.js's
// callsign) — same index in, same name out, forever, which is what lets the
// SYS LOG line mean something rather than just noting "something changed".
// Unlike a node's callsign, a sector index never repeats across a single run
// (it only counts up with distance), so "stable" here matters for the TEST
// suite's own sake more than for the player's — but it costs nothing extra
// to make true, and it's the same contract as everything else here.
export function sectorName(index) {
  const seed = sectorNameSeed(index);
  const letter = SECTOR_LETTERS[Math.floor(hash(seed) * SECTOR_LETTERS.length)];
  const num = 1 + Math.floor(hash(seed + 1) * 99);
  const numStr = num < 10 ? `0${num}` : `${num}`;
  return hash(seed + 2) < 0.5 ? `SEC ${numStr}-${letter}` : `GRID-${letter}${num}`;
}

// How long a rescan reads as punctuation rather than a stutter — tuned by
// eye in the browser (see the design doc's own "Verify it" section). Short
// enough that "the glitch must cost nothing when it isn't firing" is true
// for the overwhelming majority of frames even at 1x SECTOR_PERIOD, the
// shortest legal value citygrid.js ships with.
const GLITCH_DURATION = 0.35;

// THE ONE THING THIS FLOOR'S "PURE FUNCTION OF POSITION" RULE DOESN'T COVER,
// same exception links.js's own lastAnnouncedId carves out and for the same
// reason: "a crossing just happened" is inherently an edge, and detecting an
// edge needs to remember which side of it the last tick was on. Two scalars,
// same minimum the design asks for — which sector was current (so a repeat
// call with the same sector is a no-op, not a fresh glitch) and how much of
// the current glitch is left to draw.
let lastSector = null;
let glitchTimer = 0;

// Called once per SIMULATION TICK (main.js's update(), "playing" only) —
// never from render(), which must stay a pure function of its arguments like
// the rest of this floor (see scenery.js's own header). `distance` is the
// real, unrounded simulation value (see the README's own rule on why).
// `clockValue` is scenery.js's own floor clock, taken as an explicit
// PARAMETER rather than imported directly — the same choice links.js's own
// announce() makes and for the same reason: it lets the test suite drive
// this function's rate limiter without needing scenery.update()'s own
// "playing"-only cadence running first. main.js passes scenery.clock, the
// same value links.announce() already reads it from.
//
// fDist goes through scenery.js's own floorDist(), not a hand-rolled
// Math.round(distance * FLOOR_PARALLAX) — see that function's own header for
// the two-step rounding and the idempotence property that makes it safe to
// call here with the raw simulation `distance`, the same call that used to
// disagree by 1 with scenery.render()/road.render()'s camY-based rounding on
// about 1 in 25 sector crossings and bake the wrong sector's colour into a
// spritecache.js entry that then had no way to ever self-correct.
export function update(dt, clockValue, distance, push = gameConsole.push, busy = gameConsole.isBusy) {
  const fDist = floorDist(distance);
  const sector = sectorIndex(fDist);
  setSector(sector);

  if (lastSector === null) {
    lastSector = sector; // first tick after a (re)start: settle in, no glitch
  } else if (sector !== lastSector) {
    lastSector = sector;
    glitchTimer = GLITCH_DURATION;
    // Shared with links.js's own node-ping chatter (announceCityLine), not
    // gameConsole.push() directly — see that function's own header on why a
    // sector crossing has to respect the SAME "how often can the city talk"
    // budget a node's ping does, rather than keeping a second one that would
    // let the two features double the log's real chatter rate between them.
    announceCityLine(clockValue, sectorName(sector), HINT, push, busy);
  }

  if (glitchTimer > 0) glitchTimer = Math.max(0, glitchTimer - dt);
}

// Whether the rescan is currently live — exported so the test suite can
// drive the state machine without a canvas (mirrors links.js's own
// activePing/announceActive split: the EDGE logic and the DRAWING are two
// different things to get right, and only one of them needs a DOM).
export function glitching() {
  return glitchTimer > 0;
}

// THE RESCAN ITSELF. "Snap, don't blend" (the design) means the palette is
// simply already different by the time this draws — setSector() above ran
// in update(), before render() ever started — so this function's only job
// is the full-screen tear that makes the snap read as deliberate instead of
// as a pop.
//
// COST WHEN IDLE: one comparison, then return. That's the whole answer to
// "the glitch must cost nothing when it isn't firing" — no full-screen
// composite multiplied by zero, no work done and thrown away, just a branch
// not taken, on the overwhelming majority of frames even at 1x SECTOR_PERIOD.
//
// THE TEAR ITSELF reads a few horizontal strips back OUT of the already-
// drawn frame and redraws them a few px offset — `canvasEl` (the real <canvas>
// element, not just its context) is a legal drawImage SOURCE for itself, so
// this stays entirely on the GPU-accelerated path: no getImageData/
// putImageData, which the README's own profiling-traps section flags for
// silently demoting the canvas out of GPU acceleration. A few small
// drawImage calls, same primitive `ctx.drawImage(tile, ...)` already uses to
// blit the floor grid every frame, just reading from the live frame instead
// of a pre-rendered tile.
const GLITCH_BANDS = 5;
const GLITCH_MAX_SHIFT = 22; // px, at the glitch's OPENING instant
const GLITCH_MAX_BAND_H = 26;

export function renderGlitch(ctx, canvasEl, W, H) {
  if (glitchTimer <= 0) return; // the whole idle-cost path

  const frac = glitchTimer / GLITCH_DURATION; // 1 at the snap, fading to 0

  for (let i = 0; i < GLITCH_BANDS; i++) {
    const bandH = 4 + Math.random() * GLITCH_MAX_BAND_H;
    const y = Math.random() * H;
    const h = Math.min(bandH, H - y);
    if (h <= 0) continue;
    const dx = Math.round((Math.random() - 0.5) * 2 * GLITCH_MAX_SHIFT * frac);
    if (dx === 0) continue;
    ctx.drawImage(canvasEl, 0, y, W, h, dx, y, W, h);
  }

  // A brief near-white flash on top, fading with the same `frac` — the
  // "desync" half of the effect the tear alone doesn't sell, since a pure
  // pixel-shift with nothing else can read as a compression artefact rather
  // than a deliberate glitch.
  ctx.save();
  ctx.globalAlpha = 0.16 * frac;
  ctx.fillStyle = "#eafff5";
  ctx.fillRect(0, 0, W, H);
  ctx.restore();
}

// Called from main.js's newGame() alongside gameConsole.reset()/links.reset()
// — a restart must not carry the LAST run's sector (and its glitch/edge
// state) into the fresh one. setSector(0) runs synchronously here, rather
// than waiting for the next update() tick, so there is no single frame
// between newGame() and this run's own first "playing" tick where the
// palette still reflects whatever sector the previous run ended in (see
// main.js's "gameover" branch: newGame() and the switch to "playing" happen
// on one tick, but the "playing" body — and this module's own update() —
// doesn't run again until the NEXT one).
export function reset() {
  lastSector = null;
  glitchTimer = 0;
  setSector(0);
}
