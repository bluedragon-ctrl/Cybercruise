// Phase 8, first slice: a procedural synthwave soundtrack. No audio files —
// every sound below is a Web Audio oscillator/noise burst assembled at
// runtime, so the whole soundtrack ships as a few KB of JS instead of an MP3,
// and never repeats identically because nothing is a recording.
//
// main.js owns WHEN this plays: it calls start() the instant the player first
// confirms START GAME (menu.js's "fire" press), and calls setVolume() /
// setSfxVolume() to mirror menu.js's MUSIC and SOUND levels respectively.
// This module never reads menu.js or localStorage itself — same wiring
// pattern as fireShot/dropMine in main.js, where the owning module (menu.js)
// stays ignorant of the system it's wired into.
//
// IMPORTANT BROWSER CONTRACT: an AudioContext is born (or stays) "suspended"
// unless created/resumed inside the aftermath of a real user gesture — see
// start()'s call site. Calling start() from a keydown-driven state change
// (as main.js does) satisfies that; calling it at module load would not, and
// the whole engine would silently produce no sound.
//
// Timing uses the standard "lookahead scheduler" pattern (Chris Wilson's "A
// Tale of Two Clocks"): a plain setInterval tick that peeks ~100ms into the
// future and schedules any notes due in that window against the AudioContext's
// own clock, rather than a setTimeout/rAF fired per note. rAF/setTimeout drift
// by tens of ms under load, which is audible as the beat sliding out of time
// within a few bars — scheduling against ctx.currentTime sidesteps that
// entirely, since playback time is sample-accurate regardless of when the
// scheduling tick itself actually ran.

const BPM = 78; // slow, weighty tempo — fast tempos read as energetic/fun, this reads as tense
const SECONDS_PER_BEAT = 60 / BPM;
const STEP_DURATION = SECONDS_PER_BEAT / 4; // 16th-note grid — the finest unit anything below schedules on

const LOOKAHEAD_MS = 25; // setInterval tick period — small enough that a 100ms window is never skipped entirely
const SCHEDULE_AHEAD_TIME = 0.1; // seconds — how far past ctx.currentTime we pre-schedule each tick

const MASTER_VOLUME = 0.6; // overall mix level; everything downstream is balanced against this

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
// A single AudioContext and its permanent effects bus, built once by start().
// Everything below (ctx, masterGain, delay, noiseBuffer) is only valid after
// start() has run — nothing schedules a note before then.
let ctx = null;
let masterGain = null;
let sfxGain = null;
let noiseBuffer = null;
let delay = null;

let timerId = null;
let nextStepTime = 0;
let currentStep = 0;
let started = false;
let volume = 1; // mirrors menu.js's MUSIC level (0..1); settable before start() too, see setVolume()
let sfxVolume = 1; // mirrors menu.js's SOUND level (0..1); settable before start() too, see setSfxVolume()

// One second of white noise, sliced by a short gain envelope per hit rather
// than regenerated — snare/hat are both just this buffer through a different
// filter, the standard cheap drum-machine trick for not needing real samples.
function buildNoiseBuffer(audioCtx) {
  const buffer = audioCtx.createBuffer(1, audioCtx.sampleRate, audioCtx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  return buffer;
}

// Master bus + the shared delay ("slapback echo") every lead note is sent
// into, plus a SEPARATE sfxGain bus for one-shot SFX (playDisconnect) so the
// SOUND slider scales them independently of the MUSIC slider — both feed the
// same DynamicsCompressor, which sits after them purely as a safety net:
// kick/snare/bass/lead/SFX can all land on the same instant and sum past 0dB
// without it.
function buildGraph() {
  masterGain = ctx.createGain();
  masterGain.gain.value = MASTER_VOLUME * volume;

  sfxGain = ctx.createGain();
  sfxGain.gain.value = MASTER_VOLUME * sfxVolume;

  const compressor = ctx.createDynamicsCompressor();
  masterGain.connect(compressor);
  sfxGain.connect(compressor);
  compressor.connect(ctx.destination);

  // Feedback delay tuned to a dotted-8th-ish tap (3 steps) with the repeats
  // darkened hard on each pass — echoes decaying into murk rather than a
  // bright shimmer, so the trail reads as the sound dying away in a large
  // empty space instead of a pop-song slapback.
  delay = ctx.createDelay(1.0);
  delay.delayTime.value = STEP_DURATION * 3;
  const feedback = ctx.createGain();
  feedback.gain.value = 0.4;
  const delayFilter = ctx.createBiquadFilter();
  delayFilter.type = "lowpass";
  delayFilter.frequency.value = 1100;
  delay.connect(delayFilter).connect(feedback).connect(delay);
  delay.connect(masterGain);

  noiseBuffer = buildNoiseBuffer(ctx);
}

// --- Voices ------------------------------------------------------------------
// Every voice below builds and tears down its own node graph per hit — Web
// Audio nodes are one-shot (an OscillatorNode/AudioBufferSourceNode can only
// ever be started once), so there is no pool to reuse across notes the way
// the game's sprite/entity pools work.

function scheduleKick(t) {
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
  osc.connect(gain).connect(masterGain);
  osc.start(t);
  osc.stop(t + 0.55);
}

// A low, decaying boom rather than a bright pop-song snare crack — bandpassed
// noise tuned an octave-plus lower (500Hz vs. a snare's ~1800Hz) with a longer
// tail, layered under a sine "thump" for body. Reads as a war-drum hit.
function scheduleBoom(t) {
  const src = ctx.createBufferSource();
  src.buffer = noiseBuffer;
  const band = ctx.createBiquadFilter();
  band.type = "bandpass";
  band.frequency.value = 500;
  band.Q.value = 0.7;
  const noiseGain = ctx.createGain();
  noiseGain.gain.setValueAtTime(0.4, t);
  noiseGain.gain.exponentialRampToValueAtTime(0.001, t + 0.5);
  src.connect(band).connect(noiseGain).connect(masterGain);
  src.start(t);
  src.stop(t + 0.55);

  const osc = ctx.createOscillator();
  osc.type = "sine";
  osc.frequency.setValueAtTime(110, t);
  osc.frequency.exponentialRampToValueAtTime(50, t + 0.3);
  const thumpGain = ctx.createGain();
  thumpGain.gain.setValueAtTime(0.5, t);
  thumpGain.gain.exponentialRampToValueAtTime(0.001, t + 0.45);
  osc.connect(thumpGain).connect(masterGain);
  osc.start(t);
  osc.stop(t + 0.5);
}

// A faint high-passed tick, not a driving 8th-note pulse — see scheduleStep
// for how sparingly this gets called. Constant hi-hat motion is what made the
// old beat feel busy/upbeat; this is just enough texture to keep the bars
// from feeling frozen.
function scheduleHat(t) {
  const src = ctx.createBufferSource();
  src.buffer = noiseBuffer;
  const high = ctx.createBiquadFilter();
  high.type = "highpass";
  high.frequency.value = 9000;
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0.07, t);
  gain.gain.exponentialRampToValueAtTime(0.001, t + 0.04);
  src.connect(high).connect(gain).connect(masterGain);
  src.start(t);
  src.stop(t + 0.05);
}

function scheduleBass(t, freq) {
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
  osc.connect(filter).connect(gain).connect(masterGain);
  osc.start(t);
  osc.stop(t + dur + 0.02);
}

// A sustained chord held for the whole bar, replacing the old arpeggio —
// continuous 16th-note motion is what read as "fun"; a slow-swelling drone
// underneath everything else reads as dread instead. Two detuned saws per
// chord tone (same cheap thickening trick the old lead used), summed through
// one dark lowpass and a slow attack/release envelope.
function schedulePad(t, freqs, dur) {
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
  gain.connect(masterGain);
  gain.connect(delay);

  for (const freq of freqs) {
    for (const detuneCents of [0, -6]) {
      const osc = ctx.createOscillator();
      osc.type = "sawtooth";
      osc.frequency.value = freq;
      osc.detune.value = detuneCents;
      osc.connect(filter);
      osc.start(t);
      osc.stop(t + dur + 0.05);
    }
  }
}

// A single quiet stinger, not a running melody — see scheduleStep for how
// rarely this fires. A triangle wave rather than the pad/bass's saws, so it
// reads as a distant bell tolling over the drone instead of another synth
// layer competing with it.
function scheduleAccent(t, freq) {
  const dur = SECONDS_PER_BEAT * 1.5;
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0.0001, t);
  gain.gain.exponentialRampToValueAtTime(0.12, t + 0.05);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);

  const filter = ctx.createBiquadFilter();
  filter.type = "lowpass";
  filter.frequency.value = 1400;
  filter.connect(gain);
  gain.connect(masterGain);
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
function scheduleStep(step, t) {
  const bar = Math.floor(step / STEPS_PER_BAR) % PROGRESSION.length;
  const stepInBar = step % STEPS_PER_BAR;
  const chord = PROGRESSION[bar];

  if (stepInBar === 0 || stepInBar === 8) {
    scheduleKick(t);
    scheduleBoom(t);
  }
  if (stepInBar === 4 || stepInBar === 12) scheduleHat(t); // a faint tick in the open beats, not a pulse

  if (stepInBar % 4 === 0) scheduleBass(t, noteFreq(chord.bass));

  if (stepInBar === 0) schedulePad(t, chord.pad.map(noteFreq), STEPS_PER_BAR * STEP_DURATION);

  if (stepInBar === 10 && bar % 2 === 1) scheduleAccent(t, noteFreq(chord.accent));
}

function scheduler() {
  while (nextStepTime < ctx.currentTime + SCHEDULE_AHEAD_TIME) {
    scheduleStep(currentStep, nextStepTime);
    nextStepTime += STEP_DURATION;
    currentStep = (currentStep + 1) % TOTAL_STEPS;
  }
}

// Call once, from inside a user-gesture-driven state change (see header). A
// second call is a no-op — the loop this starts runs for the rest of the page
// life; setVolume() is how it goes quiet, not a stop/restart.
function start() {
  if (started) return;
  started = true;
  ctx = new (window.AudioContext || window.webkitAudioContext)();
  if (ctx.state === "suspended") ctx.resume();
  buildGraph();
  nextStepTime = ctx.currentTime + 0.1;
  currentStep = 0;
  timerId = setInterval(scheduler, LOOKAHEAD_MS);
}

// Mirrors menu.js's MUSIC volume (0..1). Safe to call before start() (just
// updates `volume` for buildGraph() to pick up); after start(), ramps
// masterGain rather than snapping it, so a drag on the menu's volume bar
// doesn't click on every step.
function setVolume(level) {
  volume = level;
  if (!ctx) return;
  const t = ctx.currentTime;
  masterGain.gain.cancelScheduledValues(t);
  masterGain.gain.setValueAtTime(masterGain.gain.value, t);
  masterGain.gain.linearRampToValueAtTime(MASTER_VOLUME * volume, t + 0.15);
}

// Mirrors menu.js's SOUND level (0..1) — same contract as setVolume() above,
// just for the sfxGain bus one-shot SFX (playDisconnect) route through
// instead of masterGain, so SOUND and MUSIC scale independently.
function setSfxVolume(level) {
  sfxVolume = level;
  if (!ctx) return;
  const t = ctx.currentTime;
  sfxGain.gain.cancelScheduledValues(t);
  sfxGain.gain.setValueAtTime(sfxGain.gain.value, t);
  sfxGain.gain.linearRampToValueAtTime(MASTER_VOLUME * sfxVolume, t + 0.15);
}

// --- One-shot SFX -------------------------------------------------------
// The first (and so far only) sound effect: the player's own connection
// dropping (game/disconnect.js). A noise burst under a fast downward-sweeping
// tone — the feed cutting to static while the carrier loses lock — rather
// than an explosion thump, because the car isn't destroyed, the LINK is (see
// disconnect.js's header). Built the same one-shot-node way every voice above
// is; only exists once start() has run (ctx/sfxGain/noiseBuffer are all
// module state built by buildGraph(), see the header), so main.js must only
// call this after the player has actually started a game. Routes through
// sfxGain, not masterGain — see setSfxVolume — so it scales with menu.js's
// SOUND level rather than MUSIC.
//
// Both envelopes below trail out to roughly disconnect.js's CAR_GLITCH_END
// (~1.4s into its 2.6s sequence) rather than the sequence's own opening beat —
// sized to the SEQUENCE'S pacing, not a generic short "hit" length, so the
// sound doesn't go quiet a fifth of the way through a moment that's still
// visibly unfolding.
function playDisconnect() {
  if (!ctx) return;
  const t = ctx.currentTime;

  // The dropout: band-passed noise, gated into a burst rather than the held
  // white-noise wash a snare hit uses.
  const src = ctx.createBufferSource();
  src.buffer = noiseBuffer;
  const band = ctx.createBiquadFilter();
  band.type = "bandpass";
  band.frequency.value = 2200;
  band.Q.value = 0.6;
  const noiseGain = ctx.createGain();
  noiseGain.gain.setValueAtTime(0.5, t);
  noiseGain.gain.exponentialRampToValueAtTime(0.001, t + 1.1);
  src.connect(band).connect(noiseGain).connect(sfxGain);
  src.start(t);
  src.stop(t + 1.15);

  // The carrier losing lock: a square wave sweeping down almost three octaves
  // under the static — the "signal dying" tell, not a boom.
  const osc = ctx.createOscillator();
  osc.type = "square";
  osc.frequency.setValueAtTime(660, t);
  osc.frequency.exponentialRampToValueAtTime(90, t + 1.3);
  const toneGain = ctx.createGain();
  toneGain.gain.setValueAtTime(0.001, t);
  toneGain.gain.exponentialRampToValueAtTime(0.3, t + 0.03);
  toneGain.gain.exponentialRampToValueAtTime(0.001, t + 1.3);
  osc.connect(toneGain).connect(sfxGain);
  osc.start(t);
  osc.stop(t + 1.35);
}

export function createMusic() {
  return { start, setVolume, setSfxVolume, playDisconnect };
}
