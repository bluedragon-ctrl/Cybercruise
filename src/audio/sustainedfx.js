// The SUSTAINED voices: shield_drone, wall_scrape, dread_pulse. See
// sustained.js's own header for the LIFECYCLE these ride
// (acquire/setLevel/release — built once, silenced by gain, never by
// stopping); this file owns what each one is MADE of and WHEN it should be
// audible, mirroring sfx.js's own split from soundtypes.js: the catalogue
// (sustainedtypes.js) says what exists, sustained.js says how a voice lives,
// this file says what it sounds like and what game state drives it.
//
// EVERY PURE FUNCTION BELOW — the shield fade, the dread threat curve and
// its hysteresis — is exported and unit-tested without an AudioContext at
// all (test/audio.test.js), the same pure/stateful split context.js's
// planDuck()/duck() already established. The update*() functions are the
// only things here that touch a real AudioContext (via
// sustained.js/context.js), and they're what main.js actually calls, once
// per "playing" tick, through synth.js's facade.
//
// THE SHARED FICTION, UNCHANGED FROM EARLIER STEPS: the player is jacked
// into a VR deck: "you never hear the world, you hear the deck reporting on
// the world."
//
// HULL DAMAGE IS DELIBERATELY NOT IN HERE. A hull_hiss voice (a noise bed
// whose level tracked hull damage, with bus dropouts and crackle spikes
// below 25%/10% hull) shipped and was cut: playtesting found nobody read
// the escalating hiss as "you are hurt" — it registered as the mix
// degrading, if it registered at all, and the same run's music-disturb
// bend (proceduralmusic/trackmusic's own disturb(), cut with it) said the
// same unread thing again. Hull state is a VISUAL problem; do not
// re-propose an audio layer for it without new evidence.

import { getCtx } from "./context.js";
import { registerGenerator } from "./sustainedtypes.js";
import * as sustained from "./sustained.js";
import { SHIELD_EXPIRING } from "../game/player.js";

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
// NARROW bandpass (Q5 — "narrower filtering than the hit stutter" per the
// design brief) and a hard square-
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
// DELIBERATELY DUPLICATES NO EXISTING SIGNAL. dread_pulse says "you are
// hunted", and has to stay clearly separate from the other two sustained
// voices when all three are running: it is a single low tone an octave-plus
// below wall_scrape's own 70Hz, pulsing far slower than either of their
// modulation rates (shield_drone's tremolo is a steady 9Hz, wall_scrape's
// gate is 20Hz) — dread_pulse tops out at 4Hz even right on the player's
// tail. Different register, different waveform, different rate: the three
// ways two amplitude-modulated low tones can still be told apart at a
// glance.
// ===========================================================================

// --- The graph --------------------------------------------------------
//
// A single low tone at 41.2Hz (E1, half an octave under wall_scrape's 70Hz)
// — the lowest fundamental in the whole catalogue, on purpose, per the
// design brief's "peak gain low... this should register as unease before it
// registers as a sound."
//
// TRIANGLE, NOT A BARE SINE, AND THAT IS LOAD-BEARING. A pure sine here is
// inaudible on real hardware even at maximum gain — not a mixing problem but
// physics: many speakers (laptop internals especially) cannot move air at 41Hz
// at all, and a sine has no harmonic content anywhere else in the spectrum for a
// driver with a higher bass rolloff to reproduce instead. A triangle keeps the
// same low, "felt not heard" register (harmonics falling off at 1/n², the
// softest rolloff short of a sine, nothing like wall_scrape's buzzy square)
// while putting faint energy at 123.6Hz, 206Hz and up — frequencies ordinary
// speakers can actually move, which is what makes the pulse audible as a pulse.
//
// AMPLITUDE-PULSED BY A SINE LFO, SWUNG FULL DEPTH (0..1, not the partial
// tremolo shield_drone's 0.32-0.68 swing gives) — see pulseGain below. The full
// swing is what makes this read as discrete PULSES with near-silence between
// beats rather than a wobbling texture: a heartbeat monitor, not a tremolo pad.
//
// The LFO's frequency is NOT fixed the way every other sustained voice's
// modulation rate is — updateDreadPulse() retunes it every "playing" tick from
// the current proximity, which is what makes the pulse rate scale with
// proximity. `dreadLfo` is stashed at module scope at build time, safe because
// this graph is built exactly once and never rebuilt (sustained.js), so the
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
// ...and switches back OFF only once the gap opens past this — the gap
// between the two thresholds is the HYSTERESIS band: a hostile sitting
// almost exactly at one shared threshold would otherwise flicker the layer
// on and off as ordinary speed wander (traffic.js's own DRIFT) nudges the
// gap a few units either side of one shared number.
export const DREAD_RANGE_OFF = 520;
// Gain once fully on the player's tail — low, per the design brief, but
// RAISED FROM AN INITIAL 0.05 alongside the sine->triangle swap above: this
// is the leanest source in the whole sustained catalogue (one oscillator,
// no noise, no second tone the way shield_drone sums two), so it needs more
// headroom than WALL_SCRAPE_LEVEL (0.09) to land at a comparable perceived
// loudness, not less — a thin source and a low
// peak were compounding the same problem rather than pulling in opposite
// directions.
const DREAD_PEAK = 0.11;

// 0..1: 0 at/beyond DREAD_RANGE_ON, rising to 1 as gap falls to zero.
// Doubles as both the level curve and the rate curve's own input — see
// dreadPulseLevel/dreadPulseRate below, which are just this scaled into two
// different units. Pure and stateless: knows nothing about hysteresis or
// closing — dreadPulseActive below owns that half, and the split is what
// lets each be tested (and retuned) independently.
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
// on last tick — a small hysteresis state machine, pure and stateless
// itself: the CALLER (updateDreadPulse) is what remembers `wasActive`
// between ticks. `closing` gates this outright and has
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
// other update*() here (shieldTime, hitWall): the game layer
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
// state, so a fresh run never inherits a half-open shield/wall gate or a
// dread pulse still racing from the run that just ended — a voice surviving
// into a fresh run is the most likely bug in anything added here.
export function reset() {
  sustained.releaseAll();
  shieldWasActive = false;
  wallWasActive = false;
  dreadWasActive = false;
}
