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

const BPM = 100; // classic synthwave tempo band (90-120)
const SECONDS_PER_BEAT = 60 / BPM;
const STEP_DURATION = SECONDS_PER_BEAT / 4; // 16th-note grid — the finest unit anything below schedules on

const LOOKAHEAD_MS = 25; // setInterval tick period — small enough that a 100ms window is never skipped entirely
const SCHEDULE_AHEAD_TIME = 0.1; // seconds — how far past ctx.currentTime we pre-schedule each tick

const MASTER_VOLUME = 0.6; // overall mix level; everything downstream is balanced against this

// --- Music: i-VI-III-VII in A minor, one bar (4 beats) per chord ------------
//
// The single most recognisable synthwave chord loop. MIDI note numbers (69 =
// A4 = 440Hz, see noteFreq()) rather than raw Hz, so the intervals stay
// legible — e.g. `lead` is a plain root-3rd-5th-octave arpeggio up the chord.
const A2 = 45, C3 = 48, F2 = 41, G2 = 43;
const A3 = 57, C4 = 60, E4 = 64, A4 = 69;
const F3 = 53, F4 = 65;
const C5 = 72, G4 = 67;
const G3 = 55, B3 = 59, D4 = 62;

const PROGRESSION = [
  { bass: A2, lead: [A3, C4, E4, A4] }, // i   — Am
  { bass: F2, lead: [F3, A3, C4, F4] }, // VI  — F
  { bass: C3, lead: [C4, E4, G4, C5] }, // III — C
  { bass: G2, lead: [G3, B3, D4, G4] }, // VII — G
];
const STEPS_PER_BAR = 16;
const TOTAL_STEPS = STEPS_PER_BAR * PROGRESSION.length; // one full loop = 4 bars = 64 steps = 9.6s at BPM 100

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
  // darkened on each pass, the classic gated-synth "trailing echo" rather than
  // a literal repeat.
  delay = ctx.createDelay(1.0);
  delay.delayTime.value = STEP_DURATION * 3;
  const feedback = ctx.createGain();
  feedback.gain.value = 0.35;
  const delayFilter = ctx.createBiquadFilter();
  delayFilter.type = "lowpass";
  delayFilter.frequency.value = 2000;
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
  // A fast pitch drop (150Hz -> 45Hz) is most of what reads as "kick drum" —
  // the amplitude envelope alone would sound more like a dull thud.
  osc.frequency.setValueAtTime(150, t);
  osc.frequency.exponentialRampToValueAtTime(45, t + 0.15);
  gain.gain.setValueAtTime(0.9, t);
  gain.gain.exponentialRampToValueAtTime(0.001, t + 0.35);
  osc.connect(gain).connect(masterGain);
  osc.start(t);
  osc.stop(t + 0.4);
}

function scheduleSnare(t) {
  const src = ctx.createBufferSource();
  src.buffer = noiseBuffer;
  const band = ctx.createBiquadFilter();
  band.type = "bandpass";
  band.frequency.value = 1800;
  band.Q.value = 0.8;
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0.5, t);
  gain.gain.exponentialRampToValueAtTime(0.001, t + 0.2);
  src.connect(band).connect(gain).connect(masterGain);
  src.start(t);
  src.stop(t + 0.25);
}

function scheduleHat(t, accent) {
  const src = ctx.createBufferSource();
  src.buffer = noiseBuffer;
  const high = ctx.createBiquadFilter();
  high.type = "highpass";
  high.frequency.value = 8000;
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(accent ? 0.22 : 0.12, t);
  gain.gain.exponentialRampToValueAtTime(0.001, t + 0.05);
  src.connect(high).connect(gain).connect(masterGain);
  src.start(t);
  src.stop(t + 0.06);
}

function scheduleBass(t, freq) {
  const osc = ctx.createOscillator();
  osc.type = "sawtooth";
  osc.frequency.value = freq;
  const filter = ctx.createBiquadFilter();
  filter.type = "lowpass";
  filter.frequency.value = 600;
  const gain = ctx.createGain();
  // Fires every other 16th-note step (see scheduleStep), so an 8th-note-long
  // envelope with a little air before the next hit reads as a pluck rather
  // than a held drone.
  const dur = STEP_DURATION * 2 * 0.85;
  gain.gain.setValueAtTime(0.0001, t);
  gain.gain.exponentialRampToValueAtTime(0.35, t + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  osc.connect(filter).connect(gain).connect(masterGain);
  osc.start(t);
  osc.stop(t + dur + 0.02);
}

function scheduleLead(t, freq) {
  const dur = STEP_DURATION * 2 * 0.9;
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0.0001, t);
  gain.gain.exponentialRampToValueAtTime(0.18, t + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);

  const filter = ctx.createBiquadFilter();
  filter.type = "lowpass";
  filter.frequency.value = 2200;
  filter.Q.value = 4;
  filter.connect(gain);
  gain.connect(masterGain);
  gain.connect(delay); // feeds the shared echo bus so the arpeggio trails off between hits

  // Two saws a few cents apart, not one — the classic cheap way to "detune"
  // a lead into sounding like more than a single bare oscillator.
  for (const detuneCents of [0, -6]) {
    const osc = ctx.createOscillator();
    osc.type = "sawtooth";
    osc.frequency.value = freq;
    osc.detune.value = detuneCents;
    osc.connect(filter);
    osc.start(t);
    osc.stop(t + dur + 0.02);
  }
}

// One bar = 16 steps = 4 beats. Bass and lead interlock on alternating 16th
// steps (never simultaneously) so the arpeggio has room to read as two voices
// instead of turning into mush — see scheduleBass/scheduleLead's envelopes,
// tuned assuming they get every other step to themselves.
function scheduleStep(step, t) {
  const bar = Math.floor(step / STEPS_PER_BAR) % PROGRESSION.length;
  const stepInBar = step % STEPS_PER_BAR;
  const chord = PROGRESSION[bar];

  if (stepInBar % 4 === 0) scheduleKick(t);
  if (stepInBar === 4 || stepInBar === 12) scheduleSnare(t); // beats 2 and 4
  if (stepInBar % 2 === 0) scheduleHat(t, stepInBar % 4 === 0); // 8th notes, accented on the beat

  if (stepInBar % 2 === 0) {
    // Even steps (the 8th-note grid): bass, alternating root/octave-up for
    // the pumping two-note bassline synthwave basslines lean on.
    const octaveUp = stepInBar % 4 === 2;
    scheduleBass(t, noteFreq(chord.bass) * (octaveUp ? 2 : 1));
  } else {
    // Odd steps, the gaps the bass leaves: lead, cycling the chord's 4-note
    // arpeggio twice per bar.
    const idx = Math.floor(stepInBar / 2) % chord.lead.length;
    scheduleLead(t, noteFreq(chord.lead[idx]));
  }
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
