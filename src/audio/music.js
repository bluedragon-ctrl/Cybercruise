// Phase 8's procedural synthwave music loop — moved out of the old monolithic
// synth.js verbatim (progression, voices, scheduler all unchanged) so that
// context.js can own the bus graph and sfx.js can own one-shot SFX without
// either dragging the other's ~250 lines along. Behaviour is byte-for-byte
// the same as before the split: same chords, same drum pattern, same timing.
//
// No audio files — every sound below is a Web Audio oscillator/noise burst
// assembled at runtime, so the whole soundtrack ships as a few KB of JS
// instead of an MP3, and never repeats identically because nothing is a
// recording.
//
// Timing uses the standard "lookahead scheduler" pattern (Chris Wilson's "A
// Tale of Two Clocks"): a plain setInterval tick that peeks ~100ms into the
// future and schedules any notes due in that window against the AudioContext's
// own clock, rather than a setTimeout/rAF fired per note. rAF/setTimeout drift
// by tens of ms under load, which is audible as the beat sliding out of time
// within a few bars — scheduling against ctx.currentTime sidesteps that
// entirely, since playback time is sample-accurate regardless of when the
// scheduling tick itself actually ran.

import { getCtx, getMusicBus, getDelay, getNoiseBuffer } from "./context.js";

const BPM = 78; // slow, weighty tempo — fast tempos read as energetic/fun, this reads as tense
const SECONDS_PER_BEAT = 60 / BPM;
const STEP_DURATION = SECONDS_PER_BEAT / 4; // 16th-note grid — the finest unit anything below schedules on

const LOOKAHEAD_MS = 25; // setInterval tick period — small enough that a 100ms window is never skipped entirely
const SCHEDULE_AHEAD_TIME = 0.1; // seconds — how far past ctx.currentTime we pre-schedule each tick

// --- Music: i-VI-iv-V in A minor, one bar (4 beats) per chord ---------------
//
// Deliberately NOT the classic i-VI-III-VII synthwave loop (that one's III
// bar lands on a bright major chord a whole step below the tonic — the most
// "optimistic" move available in the key, which is why the old loop read as
// fun). This progression never resolves: iv (Dm) is the plain minor
// subdominant, and V is borrowed from A harmonic minor (E major, with its
// raised C# leading tone) — the classic film-score "pulls toward home but
// the loop just restarts on i instead" tension chord. MIDI note numbers (69 =
// A4 = 440Hz, see noteFreq()) rather than raw Hz, so the intervals stay
// legible.
const A2 = 45, D2 = 38, E2 = 40, F2 = 41;
const D3 = 50, E3 = 52, F3 = 53, GS3 = 56, A3 = 57, B3 = 59;
const C4 = 60, D4 = 62, E4 = 64, F4 = 65, A4 = 69, B4 = 71;

const PROGRESSION = [
  { bass: A2, pad: [A3, C4, E4], accent: A4 }, // i  — Am
  { bass: F2, pad: [F3, A3, C4], accent: F4 }, // VI — F
  { bass: D2, pad: [D3, F3, A3], accent: D4 }, // iv — Dm
  { bass: E2, pad: [E3, GS3, B3], accent: B4 }, // V — E (harmonic-minor dominant)
];
const STEPS_PER_BAR = 16;
const TOTAL_STEPS = STEPS_PER_BAR * PROGRESSION.length; // one full loop = 4 bars = 64 steps = ~12.3s at BPM 78

function noteFreq(midi) {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

// --- Module state ------------------------------------------------------------
// The scheduler's own clock. Only valid once start() has run — nothing
// schedules a note before then, and start() is only ever called after
// context.js's own start() has built the bus graph (see synth.js's facade).
let timerId = null;
let nextStepTime = 0;
let currentStep = 0;
let started = false;

// The CURRENTLY-SOUNDING pad's own oscillators/filter — see disturb() below.
// Only ever holds the most recent bar's pad: a new schedulePad() call
// REPLACES these rather than appending, which is safe because the pad's own
// `dur` is exactly one bar (see scheduleStep), so two pad instances are
// never simultaneously "current" — the previous bar's has already reached
// its own release before the next one is scheduled.
let currentPadOscs = [];
let currentPadBaseDetunes = []; // each osc's OWN steady-state detune (0 or -6, per the `detuneCents` loop below) — disturb() has to recover to THIS, not one shared value, since not every oscillator in the pad starts at the same detune
let currentPadFilter = null;

// --- Voices ------------------------------------------------------------------
// Every voice below builds and tears down its own node graph per hit — Web
// Audio nodes are one-shot (an OscillatorNode/AudioBufferSourceNode can only
// ever be started once), so there is no pool to reuse across notes the way
// the game's sprite/entity pools work.

function scheduleKick(ctx, musicGain, t) {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = "sine";
  // A fast pitch drop (140Hz -> 40Hz) is most of what reads as "kick drum" —
  // the amplitude envelope alone would sound more like a dull thud. Slightly
  // deeper and longer than a pop kick, for weight rather than punch.
  osc.frequency.setValueAtTime(140, t);
  osc.frequency.exponentialRampToValueAtTime(40, t + 0.2);
  gain.gain.setValueAtTime(0.9, t);
  gain.gain.exponentialRampToValueAtTime(0.001, t + 0.5);
  osc.connect(gain).connect(musicGain);
  osc.start(t);
  osc.stop(t + 0.55);
}

// A low, decaying boom rather than a bright pop-song snare crack — bandpassed
// noise tuned an octave-plus lower (500Hz vs. a snare's ~1800Hz) with a longer
// tail, layered under a sine "thump" for body. Reads as a war-drum hit.
function scheduleBoom(ctx, musicGain, noiseBuffer, t) {
  const src = ctx.createBufferSource();
  src.buffer = noiseBuffer;
  const band = ctx.createBiquadFilter();
  band.type = "bandpass";
  band.frequency.value = 500;
  band.Q.value = 0.7;
  const noiseGain = ctx.createGain();
  noiseGain.gain.setValueAtTime(0.4, t);
  noiseGain.gain.exponentialRampToValueAtTime(0.001, t + 0.5);
  src.connect(band).connect(noiseGain).connect(musicGain);
  src.start(t);
  src.stop(t + 0.55);

  const osc = ctx.createOscillator();
  osc.type = "sine";
  osc.frequency.setValueAtTime(110, t);
  osc.frequency.exponentialRampToValueAtTime(50, t + 0.3);
  const thumpGain = ctx.createGain();
  thumpGain.gain.setValueAtTime(0.5, t);
  thumpGain.gain.exponentialRampToValueAtTime(0.001, t + 0.45);
  osc.connect(thumpGain).connect(musicGain);
  osc.start(t);
  osc.stop(t + 0.5);
}

// A faint high-passed tick, not a driving 8th-note pulse — see scheduleStep
// for how sparingly this gets called. Constant hi-hat motion is what made the
// old beat feel busy/upbeat; this is just enough texture to keep the bars
// from feeling frozen.
//
// KNOWN OFF-BRIEF, LEFT ALONE: the 9kHz highpass here sits well above this
// project's ~5kHz noise rolloff / ~1.5kHz tonal ceiling (see synth.js's
// header). Retuning it is explicitly OUT OF SCOPE for this split — it's
// listed here only so the next pass doesn't mistake the omission for an
// oversight.
function scheduleHat(ctx, musicGain, noiseBuffer, t) {
  const src = ctx.createBufferSource();
  src.buffer = noiseBuffer;
  const high = ctx.createBiquadFilter();
  high.type = "highpass";
  high.frequency.value = 9000;
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0.07, t);
  gain.gain.exponentialRampToValueAtTime(0.001, t + 0.04);
  src.connect(high).connect(gain).connect(musicGain);
  src.start(t);
  src.stop(t + 0.05);
}

function scheduleBass(ctx, musicGain, t, freq) {
  const osc = ctx.createOscillator();
  osc.type = "sawtooth";
  osc.frequency.value = freq;
  const filter = ctx.createBiquadFilter();
  filter.type = "lowpass";
  filter.frequency.value = 350; // darker/rounder than a pop bassline — sub weight, no bite
  const gain = ctx.createGain();
  // Fires once per beat now (see scheduleStep), filling most of the quarter
  // note — a steady pulse under the pad rather than the old pumping
  // root/octave 8th-note bounce.
  const dur = SECONDS_PER_BEAT * 0.9;
  gain.gain.setValueAtTime(0.0001, t);
  gain.gain.exponentialRampToValueAtTime(0.4, t + 0.015);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  osc.connect(filter).connect(gain).connect(musicGain);
  osc.start(t);
  osc.stop(t + dur + 0.02);
}

// A sustained chord held for the whole bar, replacing the old arpeggio —
// continuous 16th-note motion is what read as "fun"; a slow-swelling drone
// underneath everything else reads as dread instead. Two detuned saws per
// chord tone (same cheap thickening trick the old lead used), summed through
// one dark lowpass and a slow attack/release envelope.
function schedulePad(ctx, musicGain, delay, t, freqs, dur) {
  const attack = 0.6;
  const release = 0.8;
  const sustain = 0.09;
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0.0001, t);
  gain.gain.exponentialRampToValueAtTime(sustain, t + attack);
  gain.gain.setValueAtTime(sustain, t + dur - release);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);

  const filter = ctx.createBiquadFilter();
  filter.type = "lowpass";
  filter.frequency.value = 900; // no bright top end — kept deliberately dull
  filter.connect(gain);
  gain.connect(musicGain);
  gain.connect(delay);

  // REPLACE, not append — see currentPadOscs' own header for why only the
  // latest bar's pad is ever tracked as "current" for disturb() to reach.
  currentPadOscs = [];
  currentPadBaseDetunes = [];
  currentPadFilter = filter;

  for (const freq of freqs) {
    for (const detuneCents of [0, -6]) {
      const osc = ctx.createOscillator();
      osc.type = "sawtooth";
      osc.frequency.value = freq;
      osc.detune.value = detuneCents;
      osc.connect(filter);
      osc.start(t);
      osc.stop(t + dur + 0.05);
      currentPadOscs.push(osc);
      currentPadBaseDetunes.push(detuneCents);
    }
  }
}

// Phase 8 step 3's SEAM into the music: "the soundtrack itself degrading on
// impact is the strongest single idea in this design, and it costs no extra
// voices" (design brief). `amount` is 0..1 (main.js passes the same
// opts.intensity a heavy player_hit uses), and this briefly detunes and
// darkens the CURRENTLY-SOUNDING pad's own oscillators/filter — not a new
// voice, not a rewrite of scheduleStep's own timing, just two extra
// automation ramps layered onto nodes that already exist.
//
// A TRANSIENT, RECOVERING IN ~1s — deliberately NOT the same kind of state
// hull_hiss (audio/sustainedfx.js) tracks. hull_hiss is the PERSISTENT
// signal-degradation layer (it already reflects how much hull is gone, for
// as long as it's gone); this is the momentary shudder on the HIT itself.
// Running both at full strength on the same event would say the same thing
// twice — see main.js's own onPlayerDamage for how the two are kept
// separate calls, never combined into one bigger effect.
//
// A NO-OP IF NO PAD IS CURRENTLY SOUNDING (silence between one bar's release
// and the next bar's attack, or before start() has ever scheduled one) —
// there's nothing to disturb, and scheduleStep will pick the disturbed
// oscillators back up next bar regardless once they've recovered.
const DISTURB_DETUNE_CENTS = 45; // extra detune added at amount=1 — enough to read as a genuine wobble, not just the pad's own steady-state chorus thickening
const DISTURB_FILTER_DROP = 500; // Hz shaved off the pad's own 900Hz cutoff at amount=1
const DISTURB_RECOVER = 1.0; // seconds — "recovering over ~1s" per the design brief

export function disturb(amount) {
  if (!currentPadFilter) return;
  const ctx = getCtx();
  const t = ctx.currentTime;
  const clamped = Math.max(0, Math.min(1, amount));

  // Alternate the detune's SIGN across the pad's own oscillators (even index
  // sharp, odd index flat) rather than pushing every one the same direction
  // — a hit that shoves the whole chord uniformly sharp/flat still sounds
  // "in tune with itself", just transposed; alternating is what actually
  // reads as the chord souring for a moment.
  currentPadOscs.forEach((osc, i) => {
    const base = currentPadBaseDetunes[i];
    const sign = i % 2 === 0 ? 1 : -1;
    osc.detune.cancelScheduledValues(t);
    osc.detune.setValueAtTime(osc.detune.value, t);
    osc.detune.linearRampToValueAtTime(base + sign * clamped * DISTURB_DETUNE_CENTS, t + 0.05);
    osc.detune.linearRampToValueAtTime(base, t + 0.05 + DISTURB_RECOVER);
  });

  currentPadFilter.frequency.cancelScheduledValues(t);
  currentPadFilter.frequency.setValueAtTime(currentPadFilter.frequency.value, t);
  currentPadFilter.frequency.linearRampToValueAtTime(Math.max(200, 900 - clamped * DISTURB_FILTER_DROP), t + 0.05);
  currentPadFilter.frequency.linearRampToValueAtTime(900, t + 0.05 + DISTURB_RECOVER);
}

// A single quiet stinger, not a running melody — see scheduleStep for how
// rarely this fires. A triangle wave rather than the pad/bass's saws, so it
// reads as a distant bell tolling over the drone instead of another synth
// layer competing with it.
function scheduleAccent(ctx, musicGain, delay, t, freq) {
  const dur = SECONDS_PER_BEAT * 1.5;
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0.0001, t);
  gain.gain.exponentialRampToValueAtTime(0.12, t + 0.05);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);

  const filter = ctx.createBiquadFilter();
  filter.type = "lowpass";
  filter.frequency.value = 1400;
  filter.connect(gain);
  gain.connect(musicGain);
  gain.connect(delay);

  const osc = ctx.createOscillator();
  osc.type = "triangle";
  osc.frequency.value = freq;
  osc.connect(filter);
  osc.start(t);
  osc.stop(t + dur + 0.05);
}

// One bar = 16 steps = 4 beats. Half-time drums: kick+boom land together on
// beats 1 and 3 only, leaving beats 2 and 4 as open silence rather than the
// old backbeat — empty space reads as tension where a filled-in groove reads
// as fun. The pad is struck once at the top of the bar and left to sustain;
// the bass pulses every beat underneath it; the accent stinger fires at most
// once every other bar, never a running line.
function scheduleStep(ctx, musicGain, delay, noiseBuffer, step, t) {
  const bar = Math.floor(step / STEPS_PER_BAR) % PROGRESSION.length;
  const stepInBar = step % STEPS_PER_BAR;
  const chord = PROGRESSION[bar];

  if (stepInBar === 0 || stepInBar === 8) {
    scheduleKick(ctx, musicGain, t);
    scheduleBoom(ctx, musicGain, noiseBuffer, t);
  }
  if (stepInBar === 4 || stepInBar === 12) scheduleHat(ctx, musicGain, noiseBuffer, t); // a faint tick in the open beats, not a pulse

  if (stepInBar % 4 === 0) scheduleBass(ctx, musicGain, t, noteFreq(chord.bass));

  if (stepInBar === 0) schedulePad(ctx, musicGain, delay, t, chord.pad.map(noteFreq), STEPS_PER_BAR * STEP_DURATION);

  if (stepInBar === 10 && bar % 2 === 1) scheduleAccent(ctx, musicGain, delay, t, noteFreq(chord.accent));
}

function scheduler() {
  const ctx = getCtx();
  const musicGain = getMusicBus();
  const delay = getDelay();
  const noiseBuffer = getNoiseBuffer();
  while (nextStepTime < ctx.currentTime + SCHEDULE_AHEAD_TIME) {
    scheduleStep(ctx, musicGain, delay, noiseBuffer, currentStep, nextStepTime);
    nextStepTime += STEP_DURATION;
    currentStep = (currentStep + 1) % TOTAL_STEPS;
  }
}

// Call once, after context.js's start() has built the bus graph (see
// synth.js's facade, which sequences the two). A second call is a no-op —
// the loop this starts runs for the rest of the page life.
export function start() {
  if (started) return;
  started = true;
  const ctx = getCtx();
  nextStepTime = ctx.currentTime + 0.1;
  currentStep = 0;
  timerId = setInterval(scheduler, LOOKAHEAD_MS);
}
