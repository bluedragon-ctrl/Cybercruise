// Phase 8 step 3's three SUSTAINED voices: hull_hiss (the headline of this
// step), shield_drone, wall_scrape. See sustained.js's own header for the
// LIFECYCLE these ride (acquire/setLevel/release — built once, silenced by
// gain, never by stopping); this file owns what each one is MADE of and
// WHEN it should be audible, mirroring sfx.js's own split from
// soundtypes.js: the catalogue (sustainedtypes.js) says what exists,
// sustained.js says how a voice lives, this file says what it sounds like
// and what game state drives it.
//
// EVERY PURE FUNCTION BELOW — the hull curve, its hysteresis, the
// dropout/crackle schedulers, the shield fade — is exported and unit-tested
// without an AudioContext at all (test/invariants.test.js's own "Phase 8
// step 3" section), the same pure/stateful split context.js's
// planDuck()/duck() already established. The update*() functions at the
// bottom are the only things here that touch a real AudioContext (via
// sustained.js/context.js), and they're what main.js actually calls, once
// per "playing" tick, through synth.js's facade.
//
// THE SHARED FICTION, UNCHANGED FROM EARLIER STEPS: the player is jacked
// into a VR deck: "you never hear the world, you hear the deck reporting on
// the world." Damage here is signal degradation, not physical damage — see
// hull_hiss's own comment for how that shapes every choice below.

import { getCtx, getSfxBus, getNoiseBuffer, dropSfxBus } from "./context.js";
import { registerGenerator } from "./sustainedtypes.js";
import * as sustained from "./sustained.js";
import { SHIELD_EXPIRING } from "../game/player.js";

// ===========================================================================
// hull_hiss — a looping noise bed whose level tracks hull damage, plus two
// escalating "tells" (dropouts, crackle) at deeper damage. Routed to the sfx
// bus (sustained.js's acquire() already does this), not the music bus — this
// is feedback about the PLAYER'S state, not part of the score, so it follows
// the SOUND slider, not MUSIC.
// ===========================================================================

// --- The graph --------------------------------------------------------
//
// A single looping source over the SHARED noise buffer (context.js's
// getNoiseBuffer(), the same buffer every one-shot noise burst in sfx.js
// already slices) rather than a fresh buffer of its own — this graph is
// built exactly once, ever, so there's no per-hit allocation to save the way
// sharing the buffer saves one for a one-shot, but there's no reason to
// duplicate it either. Bandpassed around 1.4kHz, Q 0.7 — the design brief is
// explicit that noise is allowed some AIR here ("noise is allowed some air
// here — it is textural, not pitched, and hiss without top end reads as
// rumble rather than a failing signal"), while staying well clear of the
// catalogue's ~5kHz noise rolloff and nowhere near the ~1.5kHz TONAL ceiling
// (this is noise, not a pitched tone, so that ceiling doesn't even apply,
// but 1.4kHz keeps it from reading as bright regardless).
//
// FLUTTER, layered on top of the bandpassed noise — a perfectly steady hiss
// reads as ambient TEXTURE (room tone, wind), which is exactly wrong for
// "the deck reporting a struggling signal". A SECOND looping source over the
// same shared buffer, heavily lowpassed down to a few Hz, drives the hiss's
// own gain — because the modulator is filtered NOISE rather than a clean
// sine LFO, the resulting wobble has no fixed period and never settles into
// a predictable pulse (a sine tremolo would just read as vibrato on a
// texture, still smooth). This is deliberately separate from — and much
// milder/more local than — DROPOUT_GAIN's own hard, bus-wide cuts below: the
// flutter is the hiss's own constant, low-level irregularity; a dropout is a
// rare, deep, whole-feed event layered on top of it once hull is critical.
function buildHullHiss(ctx, dest) {
  const src = ctx.createBufferSource();
  src.buffer = getNoiseBuffer();
  src.loop = true;
  const band = ctx.createBiquadFilter();
  band.type = "bandpass";
  band.frequency.value = 1400;
  band.Q.value = 0.7;

  const flutterGain = ctx.createGain();
  flutterGain.gain.value = 0.7; // base level the flutter swings around

  const flutterSrc = ctx.createBufferSource();
  flutterSrc.buffer = getNoiseBuffer();
  flutterSrc.loop = true;
  const flutterLp = ctx.createBiquadFilter();
  flutterLp.type = "lowpass";
  flutterLp.frequency.value = 4; // a handful of irregular wobbles a second — static, not a pulse
  const flutterDepth = ctx.createGain();
  flutterDepth.gain.value = 0.35; // flutterGain.gain swings roughly 0.35 .. 1.05 — deep enough to read as the signal genuinely faltering, not just breathing
  flutterSrc.connect(flutterLp).connect(flutterDepth).connect(flutterGain.gain);
  flutterSrc.start();

  src.connect(band).connect(flutterGain).connect(dest);
  src.start();
}
registerGenerator("hull_hiss", buildHullHiss);

// --- The level curve (PURE) --------------------------------------------

export const HULL_HISS_ON = 0.6; // hull fraction the hiss switches ON at or below
// ...and switches back OFF strictly above this — the 3%-point gap between
// the two is the HYSTERESIS band. Without it, hull sitting exactly on the
// edge (wall-scrape ticks in whole-HP steps, so it can land precisely there)
// flutters the hiss on and off every tick it crosses — see the design
// brief's own warning: "a car scraping you across the threshold will
// flutter it on and off." A single shared threshold can't have a gap, so
// this needs two.
export const HULL_HISS_OFF = 0.63;
export const HULL_HISS_PEAK = 0.08; // gain at 0% hull — "something the player
// notices they have been hearing", per the design brief, not an alarm

// Whether the hiss should be considered ON this tick, given whether it WAS on
// last tick — a small hysteresis state machine, the same edge-detection
// shape sectors.js's own lastSector tracking uses for a related reason (an
// edge needs to remember which side of it you were just on). Pure and
// stateless itself: the CALLER (updateHullHiss below) is what remembers
// `wasActive` between ticks.
export function hullHissActive(hullFrac, wasActive) {
  return wasActive ? hullFrac < HULL_HISS_OFF : hullFrac <= HULL_HISS_ON;
}

// The target gain once ACTIVE — silent at/above HULL_HISS_ON, rising on a
// SQUARED curve toward HULL_HISS_PEAK as hull falls to 0%, so (per the
// design brief) most of the audible change happens in the last 20% of hull,
// not spread evenly across the whole 0-60% range. This function alone knows
// nothing about hysteresis — callers gate it behind hullHissActive() first
// (see updateHullHiss), so it stays a plain, monotonic curve to test.
export function hullHissLevel(hullFrac) {
  const x = Math.max(0, Math.min(1, (HULL_HISS_ON - hullFrac) / HULL_HISS_ON));
  return HULL_HISS_PEAK * x * x;
}

// --- Dropouts + crackle scheduling (PURE) -------------------------------
//
// Both are modelled as a countdown timer that only runs while its OWN hull
// threshold is crossed — frozen, not reset, while inactive (see
// stepDropoutTimer/stepCrackleTimer below), so a hull that flickers around
// 25%/10% doesn't get a free event on every re-entry, and doesn't lose
// progress toward the next one while briefly healed past the line either.

export const DROPOUT_HULL_THRESHOLD = 0.25;
export const DROPOUT_MIN_INTERVAL = 3; // seconds — "averaging every 3-6s" per the brief
export const DROPOUT_MAX_INTERVAL = 6;
export const DROPOUT_MIN_HOLD = 0.03; // seconds — "30-60ms" per the brief
export const DROPOUT_MAX_HOLD = 0.06;
export const DROPOUT_GAIN = 0.03; // near-zero, not a hard 0 — true silence can click on the ramp back up

export const CRACKLE_HULL_THRESHOLD = 0.1;
export const CRACKLE_MIN_INTERVAL = 0.15; // seconds — "a few per second" baseline
export const CRACKLE_MAX_INTERVAL = 0.45;
export const CRACKLE_CLUSTER_MIN = 0.04; // an occasional much-shorter gap — see the header below
export const CRACKLE_CLUSTER_MAX = 0.12;
export const CRACKLE_CLUSTER_CHANCE = 0.3;

// One scheduling tick for the dropout timer: counts `timer` down by `dt`
// while `active`; once it crosses zero, fires and re-rolls a fresh interval
// from the injectable `rng` (defaults to Math.random — overridable so tests
// can drive this deterministically without needing to fake time itself).
// Frozen (not decremented, never fires) while inactive.
export function stepDropoutTimer(timer, dt, active, rng = Math.random) {
  if (!active) return { timer, fired: false };
  const next = timer - dt;
  if (next > 0) return { timer: next, fired: false };
  return { timer: DROPOUT_MIN_INTERVAL + rng() * (DROPOUT_MAX_INTERVAL - DROPOUT_MIN_INTERVAL), fired: true };
}

// How long a single dropout should hold the sfx bus down for — "30-60ms".
export function dropoutHoldSeconds(rng = Math.random) {
  return DROPOUT_MIN_HOLD + rng() * (DROPOUT_MAX_HOLD - DROPOUT_MIN_HOLD);
}

// Same shape as stepDropoutTimer, but with a SLIGHT CLUSTERING bias: most
// gaps come from the base CRACKLE_MIN/MAX_INTERVAL spread, but roughly a
// third of the time (CRACKLE_CLUSTER_CHANCE) the next spike is drawn from a
// much shorter range instead. Per the design brief's own words: "cluster
// them slightly; uniform random sounds like a metronome" — a couple of
// spikes landing close together reads as debris still settling, which
// perfectly even spacing never does.
export function stepCrackleTimer(timer, dt, active, rng = Math.random) {
  if (!active) return { timer, fired: false };
  const next = timer - dt;
  if (next > 0) return { timer: next, fired: false };
  const clustered = rng() < CRACKLE_CLUSTER_CHANCE;
  const interval = clustered
    ? CRACKLE_CLUSTER_MIN + rng() * (CRACKLE_CLUSTER_MAX - CRACKLE_CLUSTER_MIN)
    : CRACKLE_MIN_INTERVAL + rng() * (CRACKLE_MAX_INTERVAL - CRACKLE_MIN_INTERVAL);
  return { timer: interval, fired: true };
}

// One 20ms noise spike, bandpassed LOWER than the hiss's own 1.4kHz (700Hz —
// still inside the catalogue's 600Hz-2kHz noise-texture band, just the
// duller end of it, so a crackle reads as debris rather than more hiss).
// Built straight onto the sfx bus and deliberately NOT through sfx.js's
// play()/voice limiter: crackle is part of the sustained hull-damage STATE,
// not a discrete player action, and — exactly like hull_hiss itself — it
// must never be the thing that gets stolen mid-firefight (see sustained.js's
// header on why sustained voices sit outside the one-shot cap entirely).
// This is technically a one-shot burst under the hood, but it rides that
// same exemption rather than requestVoice()'s.
function spawnCrackle(ctx, dest, t) {
  const src = ctx.createBufferSource();
  src.buffer = getNoiseBuffer();
  const band = ctx.createBiquadFilter();
  band.type = "bandpass";
  band.frequency.value = 700;
  band.Q.value = 2.5;
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0.001, t);
  gain.gain.exponentialRampToValueAtTime(0.35, t + 0.004);
  gain.gain.exponentialRampToValueAtTime(0.001, t + 0.02);
  src.connect(band).connect(gain).connect(dest);
  src.start(t);
  src.stop(t + 0.025);
}

// --- The per-frame driver main.js calls (via synth.js's facade) ---------

let hissWasActive = false;
let dropoutTimer = DROPOUT_MIN_INTERVAL;
let crackleTimer = CRACKLE_MIN_INTERVAL;

const CRACKLE_SYNC_WINDOW = 0.12; // seconds — see the "glitching" nudge below

// Called every "playing" tick with the CURRENT hull fraction — per the
// design brief, "polled from main.js's update loop, not pushed from
// damage()... it must also fall when healing and on newGame()." Polling
// (rather than main.js pushing a value only on a damage EVENT) is what makes
// healing "just work" here: the curve is a pure function of the current
// fraction, so a heal that raises it is indistinguishable from any other
// tick where the fraction happened to change.
//
// `glitching` is sectors.js's own glitching() — read-only, this file never
// touches sectors.js's timer, only asks it a yes/no question — see the
// crackle-sync comment below for the one thing it's used for.
export function updateHullHiss(dt, hullFrac, glitching = false) {
  const active = hullHissActive(hullFrac, hissWasActive);
  hissWasActive = active;

  // A fixed 0.5s ramp regardless of how far the target moved — per the
  // brief, "ramp level changes over ~0.5s, never set them" — and
  // sustained.setLevel() itself already no-ops when the target hasn't
  // actually changed since last tick, so this costs nothing on the vast
  // majority of frames where hull is holding steady.
  sustained.setLevel("hull_hiss", active ? hullHissLevel(hullFrac) : 0, 0.5);

  const dropoutActive = active && hullFrac < DROPOUT_HULL_THRESHOLD;
  const dropoutStep = stepDropoutTimer(dropoutTimer, dt, dropoutActive);
  dropoutTimer = dropoutStep.timer;
  if (dropoutStep.fired) {
    const ctx = getCtx();
    if (ctx) dropSfxBus(DROPOUT_GAIN, dropoutHoldSeconds());
  }

  const crackleActive = active && hullFrac < CRACKLE_HULL_THRESHOLD;
  // SYNCING CRACKLE TO THE VISUAL GLITCH, "where you can" (the design
  // brief's own phrase): a crackle that's already within CRACKLE_SYNC_WINDOW
  // of firing on its own schedule snaps FORWARD onto a glitch frame instead
  // of landing a fraction of a second later on its own. This never invents
  // an extra crackle (a spike that wasn't due soon anyway is left alone) and
  // never touches sectors.js's own timer — glitching() is read, nothing
  // else. Reuses stepCrackleTimer itself (timer=0, dt=0) for the actual
  // re-roll, rather than duplicating its random-interval formula here.
  const dueSoon = crackleActive && crackleTimer - dt <= CRACKLE_SYNC_WINDOW;
  const crackleStep = dueSoon && glitching
    ? stepCrackleTimer(0, 0, true)
    : stepCrackleTimer(crackleTimer, dt, crackleActive);
  crackleTimer = crackleStep.timer;
  if (crackleStep.fired) {
    const ctx = getCtx();
    if (ctx) spawnCrackle(ctx, getSfxBus(), ctx.currentTime);
  }
}

// ===========================================================================
// shield_drone — a held fifth, fading in on activation and audibly counting
// down its own expiry.
// ===========================================================================

// --- The graph --------------------------------------------------------
//
// A2 + E3 (110Hz, 164.81Hz — the same fifth pickup_shield's own rising
// interval lands on and shield_deflect's own swell borrows, see sfx.js).
//
// SQUARE, NOT SINE — a deliberate deviation from the original "genuinely
// pleasant sine pad" design brief, made after listening in the gallery: a
// clean sine fifth read as a pad tone, not as a FORCE FIELD. Square is
// harmonically the buzziest waveform available (odd harmonics only, same
// choice generateFireEnemy makes for "rougher and grittier"), so the two
// tones now read as an electric buzz holding the fifth rather than a chord.
// A lowpass right after them keeps that buzz CONTAINED — square's harmonics
// climb fast, and without the filter this would blow well past the
// catalogue's spectral discipline into a harsh edge instead of a hum.
function buildShieldDrone(ctx, dest) {
  const freqs = [110, 164.81]; // A2, E3

  const lp = ctx.createBiquadFilter();
  lp.type = "lowpass";
  lp.frequency.value = 850; // tames the square waves' own harmonics — a contained buzz, not a harsh edge
  lp.connect(dest);

  const tremGain = ctx.createGain();
  tremGain.gain.value = 0.5; // lowered from an earlier sine-pad pass — see SHIELD_DRONE_LEVEL's own note
  tremGain.connect(lp);

  const lfo = ctx.createOscillator();
  lfo.type = "sine";
  lfo.frequency.value = 9; // faster than the original 6Hz tremolo — reads as an electrical flutter, not a Leslie-speaker warble
  const lfoDepth = ctx.createGain();
  lfoDepth.gain.value = 0.18; // tremGain.gain swings roughly 0.32 .. 0.68
  lfo.connect(lfoDepth).connect(tremGain.gain);
  lfo.start();

  for (const freq of freqs) {
    const osc = ctx.createOscillator();
    osc.type = "square"; // see the header — the buzz IS the waveform choice
    osc.frequency.value = freq;
    osc.connect(tremGain);
    osc.start();
  }
}
registerGenerator("shield_drone", buildShieldDrone);

// --- The fade curve (PURE) ----------------------------------------------

// Lowered from an earlier pass (0.12) after listening — a square-wave buzz
// carries more perceived loudness than the sine pad it replaced at the SAME
// gain (more harmonic content = more energy for a given amplitude), so this
// came down independently of, and on top of, the graph's own lp/tremGain
// levels above.
const SHIELD_DRONE_LEVEL = 0.07;
const SHIELD_DRONE_FADE_IN = 0.3; // seconds, per the design brief
const SHIELD_DRONE_TRACK_RAMP = 0.12; // short ramp used every tick once already
// active, so the level keeps pace with a continuously-falling target
// (during the countdown) without a full 0.3s fade-in lag on every tick

// The fade-out window REUSES player.js's own SHIELD_EXPIRING rather than a
// second hand-picked number that could quietly drift from it — per the
// design brief's own instruction: "player.js already tracks shieldTime and
// has a SHIELD_EXPIRING constant used by its own render — reuse that
// threshold." Halved rather than used directly: the brief's own target here
// is "~0.5s", and SHIELD_EXPIRING (the visual ring flicker's own window) is
// 1s today, so starting the AUDIBLE fade at half that window means the
// rings have already begun flickering by the time the drone starts dying —
// two tells staggered a beat apart, rather than both firing in the same
// instant. If SHIELD_EXPIRING is ever retuned, this scales with it instead
// of drifting into a stale number.
export const SHIELD_DRONE_FADE_WINDOW = SHIELD_EXPIRING / 2;

// The target level for a GIVEN shieldTime: 0 once it's spent, ramping
// linearly up to `peak` across the last `fadeWindow` seconds, held at `peak`
// for everything before that. Exported with `peak`/`fadeWindow` as
// overridable parameters purely so the endpoint/monotonicity tests below can
// exercise it without depending on this file's own private constants.
export function shieldDroneLevel(shieldTime, peak = SHIELD_DRONE_LEVEL, fadeWindow = SHIELD_DRONE_FADE_WINDOW) {
  if (shieldTime <= 0) return 0;
  if (shieldTime >= fadeWindow) return peak;
  return peak * (shieldTime / fadeWindow);
}

let shieldWasActive = false;

// Called every "playing" tick with player.shieldTime — per the design
// brief, "shield_drone follows player.shieldTime from the update loop."
export function updateShieldDrone(shieldTime) {
  const active = shieldTime > 0;
  if (active && !shieldWasActive) {
    // A freshly (re)activated shield — fade in over SHIELD_DRONE_FADE_IN,
    // per the brief, rather than the shorter per-tick tracking ramp below.
    sustained.setLevel("shield_drone", shieldDroneLevel(shieldTime), SHIELD_DRONE_FADE_IN);
  } else if (active) {
    sustained.setLevel("shield_drone", shieldDroneLevel(shieldTime), SHIELD_DRONE_TRACK_RAMP);
  } else if (shieldWasActive) {
    sustained.release("shield_drone");
  }
  shieldWasActive = active;
}

// ===========================================================================
// wall_scrape — a low gated buzz held for as long as contact continues. A
// CONTINUOUS FAULT, not repeated hits — per the design brief, driven from
// contact state (player.hitWall), not from the wall-damage tick.
// ===========================================================================

// --- The graph --------------------------------------------------------
//
// A single low square oscillator (70Hz — impacts/sub-adjacent) through a
// NARROW bandpass (Q5, tighter than the hiss's own Q0.7 — "narrower
// filtering than the hit stutter" per the design brief) and a hard square-
// wave gate at 20Hz. Square, not sine, for the gate LFO: a scrape stutters,
// it doesn't breathe the way the shield's smooth sine tremolo does — the two
// sustained voices that both use amplitude modulation are deliberately
// built from different LFO shapes so they read as two different KINDS of
// sustained sound, not the same trick reused.
function buildWallScrape(ctx, dest) {
  const osc = ctx.createOscillator();
  osc.type = "square";
  osc.frequency.value = 70;

  const band = ctx.createBiquadFilter();
  band.type = "bandpass";
  band.frequency.value = 95;
  band.Q.value = 5;

  const gate = ctx.createGain();
  gate.gain.value = 0.7; // base the gate swings around

  const lfo = ctx.createOscillator();
  lfo.type = "square";
  lfo.frequency.value = 20;
  const lfoDepth = ctx.createGain();
  lfoDepth.gain.value = 0.35; // gate.gain swings roughly 0.35 .. 1.05
  lfo.connect(lfoDepth).connect(gate.gain);
  lfo.start();

  osc.connect(band).connect(gate).connect(dest);
  osc.start();
}
registerGenerator("wall_scrape", buildWallScrape);

const WALL_SCRAPE_LEVEL = 0.09;
const WALL_SCRAPE_RAMP = 0.08; // quick on both ends — a scrape starting or
// stopping should feel immediate, not fade in the way the shield's own
// 0.3s onset deliberately does

let wallWasActive = false;

// Called every "playing" tick with player.hitWall — per the design brief,
// "drive wall_scrape from contact state, not from the damage tick."
export function updateWallScrape(contact) {
  if (contact && !wallWasActive) {
    sustained.setLevel("wall_scrape", WALL_SCRAPE_LEVEL, WALL_SCRAPE_RAMP);
  } else if (!contact && wallWasActive) {
    sustained.release("wall_scrape", WALL_SCRAPE_RAMP);
  }
  wallWasActive = contact;
}

// ===========================================================================
// dread_pulse — Phase 8 step 4's ambient layer: "you are hunted." A low sine
// pulse that fades in when a hostile is behind the player and closing, with
// its PULSE RATE — not just its level — scaling with proximity, so the
// closer a hostile gets, the faster the player's own pulse seems to race.
//
// DELIBERATELY DUPLICATES NO EXISTING SIGNAL. hull_hiss (above) says "you
// are hurt"; dread_pulse says "you are hunted" — two different facts about
// the run that happen to both be true at once fairly often (a hostile on
// your tail is exactly when you're also likely to be taking damage), so the
// two have to read as clearly separate sounds when both are running: hiss is
// BANDPASSED NOISE up around 1.4kHz, texture with no pitch of its own;
// dread_pulse is a single low tone an octave-plus below wall_scrape's own
// 70Hz, pulsing far slower than either of this file's other two voices'
// modulation (hull_hiss's flutter is a few Hz of irregular wobble,
// shield_drone's tremolo is a steady 9Hz, wall_scrape's gate is 20Hz) —
// dread_pulse tops out at 4Hz even right on the player's tail. Different
// register, different waveform, different rate: the three ways two
// amplitude-modulated low tones can still be told apart at a glance.
// ===========================================================================

// --- The graph --------------------------------------------------------
//
// A single low tone at 41.2Hz (E1, half an octave under wall_scrape's 70Hz)
// — the lowest fundamental in the whole catalogue, on purpose, per the
// design brief's "peak gain low... this should register as unease before it
// registers as a sound."
//
// TRIANGLE, NOT A BARE SINE, AND THAT CHANGE IS LOAD-BEARING RATHER THAN
// COSMETIC. A first pass used a pure sine here — zero harmonics, the
// "plainest" waveform available — and on real hardware it was reported
// inaudible even with the threat slider pinned at maximum. That is not
// mixing-too-quiet, it is physics: a great many speakers (laptop internals
// especially) simply cannot MOVE AIR at 41Hz at all, whatever the gain, and
// a pure sine gives the ear nothing else to latch onto — there is no
// harmonic content anywhere else in the spectrum for a driver with a higher
// bass rolloff to reproduce instead. A triangle at the same fundamental
// keeps the same low, plain, "felt not heard" REGISTER (its harmonics fall
// off fast, at 1/n², the softest-rolling-off wave short of a sine itself —
// still nothing like wall_scrape's buzzy square or shield_drone's harsher
// one) while putting faint energy at 123.6Hz, 206Hz and up: frequencies
// ordinary speakers can actually move, which is what makes the PULSE
// audible as a pulse rather than existing only in the AudioContext's own
// arithmetic. See soundtypes.js's own catalogue header for why triangle is
// this codebase's default choice for anything meant to read as soft rather
// than aggressive (weapon_swap, mine_placed, every console tick below).
//
// AMPLITUDE-PULSED BY A SINE LFO, SWUNG FULL DEPTH (0..1, not a PARTIAL
// tremolo the way shield_drone's own 0.32-0.68 swing is) — see pulseGain
// below. A full swing is what makes this read as discrete PULSES (near-total
// silence between beats) rather than a wobbling texture, the same
// distinction a heartbeat monitor's beep has from a synth's LFO-tremolo
// pad. The LFO's own frequency is NOT fixed the way every other sustained
// voice's modulation rate is (hull_hiss's flutter, shield_drone's tremolo,
// wall_scrape's gate are all constant Hz) — updateDreadPulse() below retunes
// it every "playing" tick from the current proximity, which is the one
// thing that makes "the pulse rate scales with proximity" (the design
// brief's own words) true. `dreadLfo` is stashed at module scope, once, at
// build time — the same "capture the node you'll need to keep touching"
// pattern proceduralmusic.js's own currentPadFilter uses for disturb(), and safe for
// the same reason sustained.js's whole design rests on: this graph is built
// exactly once, ever, and never rebuilt (see that file's header), so the
// reference never goes stale.
let dreadLfo = null;

function buildDreadPulse(ctx, dest) {
  const osc = ctx.createOscillator();
  osc.type = "triangle"; // see the header — a bare sine here measured inaudible on real speakers
  osc.frequency.value = 41.2; // E1

  const pulseGain = ctx.createGain();
  pulseGain.gain.value = 0.5; // base the pulse swings around

  const lfo = ctx.createOscillator();
  lfo.type = "sine";
  lfo.frequency.value = DREAD_RATE_MIN; // updateDreadPulse retunes this continuously; starts at the slowest rate so an unlucky first frame (before any update() call has run) is at least plausible
  const lfoDepth = ctx.createGain();
  lfoDepth.gain.value = 0.5; // pulseGain.gain swings 0..1 — a FULL pulse, see the header
  lfo.connect(lfoDepth).connect(pulseGain.gain);
  lfo.start();

  osc.connect(pulseGain).connect(dest);
  osc.start();

  dreadLfo = lfo;
}
registerGenerator("dread_pulse", buildDreadPulse);

// --- The threat curve (PURE) --------------------------------------------
//
// `gap` is world units of clear road between the hostile and the player
// (traffic.js's tailThreat(), positive while it's behind), `closing` is
// whether it's actually gaining (also tailThreat()'s own — see that
// method's header for both definitions). Both hostile distance AND whether
// it's closing feed into a single 0..1 proximity figure: a hostile that's
// merely holding station off the player's tail is not what this layer is
// for, whatever the gap.

// The gap must close to this many world units before the pulse can switch
// ON — and it's deliberately wider than behaviours.js's own TRAIL_ENGAGE
// (260, the gap a shot actually becomes possible at): armament.js's own
// visibleRoad puts roughly 300 world units of road behind the player on
// screen at all (see TRAIL_ENGAGE's own comment), so 480 means the dread
// starts building while the hostile closing on you is still OFF the visible
// edge of the road — you can feel it coming before you can see it, which is
// exactly the point of an unease layer rather than a combat cue.
export const DREAD_RANGE_ON = 480;
// ...and switches back OFF only once the gap opens past this — the same
// hysteresis-gap reasoning HULL_HISS_ON/OFF's own comment gives: a hostile
// sitting almost exactly at the threshold would otherwise flicker the layer
// on and off as ordinary speed wander (traffic.js's own DRIFT) nudges the
// gap a few units either side of one shared number.
export const DREAD_RANGE_OFF = 520;
// Gain once fully on the player's tail — low, per the design brief, but
// RAISED FROM AN INITIAL 0.05 alongside the sine->triangle swap above: this
// is the leanest source in the whole sustained catalogue (one oscillator,
// no noise, no second tone the way shield_drone sums two), so it needs more
// headroom than HULL_HISS_PEAK (0.08) or WALL_SCRAPE_LEVEL (0.09) to land
// at a comparable perceived loudness, not less — a thin source and a low
// peak were compounding the same problem rather than pulling in opposite
// directions.
export const DREAD_PEAK = 0.11;

// 0..1: 0 at/beyond DREAD_RANGE_ON, rising to 1 as gap falls to zero.
// Doubles as both the level curve and the rate curve's own input — see
// dreadPulseLevel/dreadPulseRate below, which are just this scaled into two
// different units. Pure and stateless: knows nothing about hysteresis or
// closing, exactly the split hullHissLevel/hullHissActive already
// establishes (that split is what lets each half be tested — and retuned —
// independently).
export function dreadProximity(gap) {
  return Math.max(0, Math.min(1, (DREAD_RANGE_ON - gap) / DREAD_RANGE_ON));
}

export function dreadPulseLevel(gap) {
  return DREAD_PEAK * dreadProximity(gap);
}

export const DREAD_RATE_MIN = 0.8; // Hz, at the edge of the threat range
export const DREAD_RATE_MAX = 4; // Hz, right on the player's tail
export function dreadPulseRate(gap) {
  return DREAD_RATE_MIN + dreadProximity(gap) * (DREAD_RATE_MAX - DREAD_RATE_MIN);
}

// Whether the pulse should be considered ON this tick, given whether it WAS
// on last tick — the same hysteresis state machine shape as hullHissActive
// (see that function's own comment). `closing` gates this outright and has
// no hysteresis of its own: a hostile that stops gaining is not a reason to
// keep the pulse alive, whatever the gap was a moment ago — the ~1s fade
// updateDreadPulse applies underneath this is what keeps a single flickering
// frame of `closing` from being audible as a blink, so a second hysteresis
// dimension here would be solving a problem the fade already solves.
export function dreadPulseActive(gap, closing, wasActive) {
  if (!closing) return false;
  return wasActive ? gap < DREAD_RANGE_OFF : gap <= DREAD_RANGE_ON;
}

// --- The per-frame driver main.js calls (via synth.js's facade) ---------

let dreadWasActive = false;
const DREAD_FADE = 1.0; // seconds — "a slow fade (~1s) in both directions: this layer must never blink," per the design brief
const DREAD_RATE_RAMP = 0.15; // seconds — short, so a rate change reads promptly rather than lagging behind the much slower level fade, but still a ramp rather than a snap so retuning the LFO's own frequency never zippers

// Called every "playing" tick with traffic.js's own tailThreat() result — a
// plain {gap, closing} pair, or null when nothing hostile is behind the
// player at all. Never touches a car or the player directly, mirroring every
// other update*() here (hull fraction, shieldTime, hitWall): the game layer
// hands over a scalar (or, here, a small plain object), and the audio layer
// never reaches back into game state to get it.
export function updateDreadPulse(dt, tailThreat) {
  const gap = tailThreat ? tailThreat.gap : Infinity;
  const closing = tailThreat ? tailThreat.closing : false;
  const active = dreadPulseActive(gap, closing, dreadWasActive);
  dreadWasActive = active;

  sustained.setLevel("dread_pulse", active ? dreadPulseLevel(gap) : 0, DREAD_FADE);

  // Retune the LFO's own rate regardless of `active` — cheap while silent
  // (the gain is 0, so a rate change is inaudible), and it means the pulse
  // is already at the RIGHT rate the instant it next fades in, rather than
  // starting at whatever rate it happened to be left at when it last faded
  // out.
  const ctx = getCtx();
  if (ctx && dreadLfo) {
    const rate = dreadPulseRate(gap);
    const t = ctx.currentTime;
    dreadLfo.frequency.cancelScheduledValues(t);
    dreadLfo.frequency.setValueAtTime(dreadLfo.frequency.value, t);
    dreadLfo.frequency.linearRampToValueAtTime(rate, t + DREAD_RATE_RAMP);
  }
}

// ===========================================================================
// reset() — called from main.js's newGame()
// ===========================================================================
//
// Releases every sustained voice AND resets this file's own edge-detection
// and scheduling state, so a fresh run never inherits an "already active"
// hiss, a live dropout/crackle countdown mid-flight, a half-open shield/wall
// gate, or a dread pulse still racing, from the run that just ended. Per the
// design brief's own warning: "a hiss surviving into a fresh run at full
// health is the most likely bug in this change" — and, for this step, "a
// dread pulse surviving into a fresh run" is the same bug with a new name.
export function reset() {
  sustained.releaseAll();
  hissWasActive = false;
  dropoutTimer = DROPOUT_MIN_INTERVAL;
  crackleTimer = CRACKLE_MIN_INTERVAL;
  shieldWasActive = false;
  wallWasActive = false;
  dreadWasActive = false;
}
