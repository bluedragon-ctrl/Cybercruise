// Phase 8 audio infrastructure — the ONE place that owns the AudioContext and
// the permanent bus graph everything else (music.js, sfx.js) plugs into.
// Splitting this out of the old monolithic synth.js so that adding sound #31
// later never means touching graph wiring again: the graph is built exactly
// once, here, and every voice — music or SFX — just connects to a bus this
// module hands out.
//
// IMPORTANT BROWSER CONTRACT, inherited from the old synth.js and still load-
// bearing: an AudioContext is born (or stays) "suspended" unless created or
// resumed in the immediate aftermath of a real user gesture. start() is the
// only thing allowed to call `new AudioContext()`, and it must only ever be
// called from inside a gesture-driven handler (today: main.js's START GAME
// keypress). Nothing in this module may construct or touch an AudioContext at
// import time — that is what keeps this file safe to `import` from Node tests
// with no DOM at all (see test/invariants.test.js's own header on the same
// rule for input.js).
//
// --- Bus graph -----------------------------------------------------------
//
//   music voices ──> musicGain ──> duckGain ──> compressor ──> destination
//   sfx voices   ──> sfxGain   ───────────────────────────^
//
// duckGain sits ONLY on the music path. Ducking sfx against itself would be
// nonsense — the sound causing the duck would be dipping its own volume out
// from under itself — so sfxGain bypasses it entirely and joins straight into
// the compressor, same as musicGain's post-duck signal does.
//
// The shared feedback delay (an echo unit, not a bus) taps off of and feeds
// back into musicGain, exactly as the old synth.js's single masterGain did —
// so echoes still ride the MUSIC slider and still get ducked along with
// everything else in the music path. SFX reach it too (via each catalogue
// entry's `delaySend`), but only as a SEND into the same shared unit; the
// delay's own output routing doesn't change per sender. One echo unit shared
// by everyone, the way one outboard delay pedal would be shared on a mixing
// desk, rather than a private delay per sound.
//
// The DynamicsCompressor stays exactly where the old synth.js put it: the
// final safety net after every bus has summed, not a creative effect — kick,
// boom, bass, pad and any number of SFX can land on the same instant and this
// is what stops that from clipping.

const MASTER_VOLUME = 0.6; // overall mix level; every bus below is balanced against this, unchanged from the old synth.js

let ctx = null;
let musicGain = null;
let sfxGain = null;
let duckGain = null;
let delay = null;
let noiseBuffer = null;

let musicVolume = 1; // mirrors menu.js's MUSIC level (0..1); settable before start() too, see setMusicVolume()
let sfxVolume = 1; // mirrors menu.js's SOUND level (0..1); settable before start() too, see setSfxVolume()

export function isStarted() {
  return ctx !== null;
}

export function getCtx() {
  return ctx;
}

// The bus a music voice (kick, boom, hat, bass, pad, accent) connects to.
export function getMusicBus() {
  return musicGain;
}

// The bus an SFX voice's per-call gain node (built by sfx.js's play())
// connects to — see the header for why this bypasses duckGain.
export function getSfxBus() {
  return sfxGain;
}

// The shared feedback delay's INPUT — connect a voice here (scaled by
// whatever send level that voice wants) to put it through the echo. Its
// output is wired once, in buildGraph(), and never exposed separately.
export function getDelay() {
  return delay;
}

// One second of shared white noise — see the old synth.js's buildNoiseBuffer
// for why this is generated once and sliced with a gain envelope per hit
// rather than rebuilt per voice.
export function getNoiseBuffer() {
  return noiseBuffer;
}

function buildNoiseBuffer(audioCtx) {
  const buffer = audioCtx.createBuffer(1, audioCtx.sampleRate, audioCtx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  return buffer;
}

function buildGraph() {
  musicGain = ctx.createGain();
  musicGain.gain.value = MASTER_VOLUME * musicVolume;

  sfxGain = ctx.createGain();
  sfxGain.gain.value = MASTER_VOLUME * sfxVolume;

  duckGain = ctx.createGain();
  duckGain.gain.value = 1; // undipped until the first duck() call

  const compressor = ctx.createDynamicsCompressor();
  musicGain.connect(duckGain);
  duckGain.connect(compressor);
  sfxGain.connect(compressor);
  compressor.connect(ctx.destination);

  // Feedback delay tuned to a dotted-8th-ish tap (3 sixteenth-note steps at
  // the music's own 78 BPM grid) with the repeats darkened hard on each pass
  // — echoes decaying into murk rather than a bright shimmer, so the trail
  // reads as the sound dying away in a large empty space instead of a
  // pop-song slapback. Unchanged from the old synth.js.
  const SECONDS_PER_BEAT = 60 / 78;
  const STEP_DURATION = SECONDS_PER_BEAT / 4;
  delay = ctx.createDelay(1.0);
  delay.delayTime.value = STEP_DURATION * 3;
  const feedback = ctx.createGain();
  feedback.gain.value = 0.4;
  const delayFilter = ctx.createBiquadFilter();
  delayFilter.type = "lowpass";
  delayFilter.frequency.value = 1100;
  delay.connect(delayFilter).connect(feedback).connect(delay);
  delay.connect(musicGain);

  noiseBuffer = buildNoiseBuffer(ctx);
}

// Call once, from inside a user-gesture-driven state change (see header). A
// second call is a no-op — the graph this builds lives for the rest of the
// page life; setMusicVolume()/setSfxVolume() are how the mix moves, not a
// rebuild.
export function start() {
  if (ctx) return;
  ctx = new (window.AudioContext || window.webkitAudioContext)();
  if (ctx.state === "suspended") ctx.resume();
  buildGraph();
}

// Mirrors menu.js's MUSIC volume (0..1). Safe to call before start() (just
// updates `musicVolume` for buildGraph() to pick up); after start(), ramps
// musicGain rather than snapping it, so a drag on the menu's volume bar
// doesn't click on every step. Unchanged behaviour from the old synth.js's
// setVolume().
export function setMusicVolume(level) {
  musicVolume = level;
  if (!ctx) return;
  const t = ctx.currentTime;
  musicGain.gain.cancelScheduledValues(t);
  musicGain.gain.setValueAtTime(musicGain.gain.value, t);
  musicGain.gain.linearRampToValueAtTime(MASTER_VOLUME * musicVolume, t + 0.15);
}

// Mirrors menu.js's SOUND level (0..1) — same contract as setMusicVolume()
// above, just for the sfxGain bus every SFX voice routes through, so SOUND
// and MUSIC scale independently. Unchanged behaviour from the old synth.js's
// setSfxVolume().
export function setSfxVolume(level) {
  sfxVolume = level;
  if (!ctx) return;
  const t = ctx.currentTime;
  sfxGain.gain.cancelScheduledValues(t);
  sfxGain.gain.setValueAtTime(sfxGain.gain.value, t);
  sfxGain.gain.linearRampToValueAtTime(MASTER_VOLUME * sfxVolume, t + 0.15);
}

// --- Ducking ---------------------------------------------------------------
//
// A sound with `duck > 0` (soundtypes.js) should dip the music bus while it
// plays, the standard sidechain-compressor "pump" — fast in, slower out — so
// a gunshot or impact briefly clears space in the mix instead of fighting the
// pad/bass for the listener's attention. Modelled as an ATTACK straight down
// to the dip target followed by a RELEASE back to unity, rather than attack +
// hold + release: every sound in the ~30-entry catalogue this is being built
// for lives in the low band (see synth.js's header constraints), so a quick
// pump per hit reads as "something landed" without needing to track each
// sound's own tail length here. A sound whose tail genuinely needs a held
// duck can widen DUCK_RELEASE later; nothing about this shape forces a fixed
// duration on it.
//
// THE OVERLAP RULE — take the max, never multiply — is why this is split
// into a pure planDuck() below (just arithmetic over plain data, no ctx) and
// the tiny stateful wrapper duck() here that actually schedules the ramp.
// Two back-to-back hits must not dip the music twice as hard as either one
// alone: a rocket landing while a mine's boom is still dipping the pad should
// duck to the LOUDER of the two requested amounts, not their sum, or four or
// five near-simultaneous hits (very possible with a rapid-fire weapon) would
// silence the music bus entirely. Concretely: each duck() call adds a
// {amount, end} record to a small list, planDuck() drops any record whose
// window has already elapsed, and the dip actually applied is
// Math.max(...stillActive.map(d => d.amount)) — one MAX over whatever is
// still live, recomputed fresh on every call, rather than any kind of
// running total.
export const DUCK_ATTACK = 0.08; // seconds
export const DUCK_RELEASE = 0.4; // seconds
export const MAX_DUCK_DB = 4; // the deepest dip a duck=1 sound can produce

function dbToGain(db) {
  return Math.pow(10, db / 20);
}

// Pure: `active` is the list of not-yet-expired duck records BEFORE this
// call; returns the list AFTER adding this request (still just data) and the
// gain-bus TARGET (0..1 fraction of MAX_DUCK_DB) that should now be in
// effect. Exported for the invariant tests — see test/invariants.test.js —
// to exercise the max-not-stack rule without an AudioContext.
export function planDuck(active, amount, now) {
  const live = active.filter((d) => d.end > now);
  const next = [...live, { amount, end: now + DUCK_ATTACK + DUCK_RELEASE }];
  const target = Math.max(...next.map((d) => d.amount));
  return { active: next, target };
}

let duckActive = [];

// Stateful wrapper around planDuck(): called by sfx.js's play() for any
// catalogue entry with duck > 0. A silent no-op before start(), same
// contract as every other entry point here — see the header.
export function duck(amount) {
  if (!ctx || amount <= 0) return;
  const t = ctx.currentTime;
  const result = planDuck(duckActive, amount, t);
  duckActive = result.active;
  const targetGain = dbToGain(-MAX_DUCK_DB * result.target);
  duckGain.gain.cancelScheduledValues(t);
  duckGain.gain.setValueAtTime(duckGain.gain.value, t);
  duckGain.gain.linearRampToValueAtTime(targetGain, t + DUCK_ATTACK);
  duckGain.gain.linearRampToValueAtTime(1, t + DUCK_ATTACK + DUCK_RELEASE);
}

// --- Voice limiter -----------------------------------------------------
//
// Web Audio nodes are one-shot — an OscillatorNode/AudioBufferSourceNode can
// only ever be started once — so there is no pool of live voices to inspect
// the way the game's own sprite/entity pools work. What this tracks instead
// is a plain array of {id, priority, start, end} records: bookkeeping about
// what's ALREADY been granted a slot and when it's due to fall silent, not
// references to the nodes themselves. A voice "frees its slot" simply by its
// `end` timestamp being in the past the next time anyone asks for a new one
// — see the `.filter((v) => v.end > now)` below — rather than any callback
// or timer running when it actually finishes. That is also why this is a
// TWO-STEP API (planVoiceRequest then commitVoice): at the moment a sound
// asks for a slot, the caller (sfx.js's play()) doesn't yet know how long the
// voice will last — that only comes back once the catalogue entry's
// generator function has actually built the voice and returned its duration
// — so the accept/steal decision (which never needs the NEW voice's own
// duration, only the existing ones') happens first, and the new voice is
// only added to the bookkeeping once its real duration is known.
//
// STEALING ORDER, and why it's in this order specifically:
//   1. minInterval — cheapest check, and the one most likely to fire on a
//      rapid-fire weapon machine-gunning the same id every frame. Rejecting
//      here means a spammed id never even competes for a slot, so it can't
//      steal FROM ITSELF (its own earlier instance) just to be immediately
//      re-stolen by the next spam a frame later.
//   2. per-id cap (maxConcurrent) — a sound that's allowed to overlap itself
//      (e.g. up to 3 impact hits at once) steals its OWN oldest instance
//      once it's over its personal budget, regardless of what else is
//      playing. This runs before the global check so a sound's self-inflicted
//      steal never has to fight another sound's priority for the privilege.
//   3. global cap — only once both of the above are satisfied does this
//      sound have to compete against everything ELSE currently playing. It
//      steals the single lowest-priority active voice; if the INCOMING sound
//      is itself the lowest priority (or tied for it), stealing would just
//      be evicting something to make room for something no more important —
//      so it's dropped instead, exactly the case the spec calls out
//      ("if the incoming sound's priority is the lowest, drop it instead").
export const GLOBAL_VOICE_CAP = 10;

// Pure: `active` is the current list of live voice records, `lastTrigger` is
// a plain {id: seconds} map of when each id last WON a slot. `request` is
// {id, priority, maxConcurrent, minInterval}. Returns the accept/reject
// decision plus the (possibly stolen-from) new `active`/`lastTrigger` — never
// mutates its inputs, so tests can replay a sequence of calls against known
// starting states. Exported for the invariant tests to exercise every
// stealing rule without an AudioContext.
export function planVoiceRequest(active, lastTrigger, request, now) {
  const live = active.filter((v) => v.end > now);

  const last = lastTrigger[request.id];
  if (last !== undefined && now - last < request.minInterval) {
    return { accepted: false, active: live, lastTrigger };
  }

  let next = live;
  const sameId = next.filter((v) => v.id === request.id);
  if (sameId.length >= request.maxConcurrent) {
    const oldest = sameId.reduce((a, b) => (a.start <= b.start ? a : b));
    next = next.filter((v) => v !== oldest);
  }

  if (next.length >= GLOBAL_VOICE_CAP) {
    const lowest = next.reduce((a, b) => (a.priority <= b.priority ? a : b));
    if (request.priority <= lowest.priority) {
      return { accepted: false, active: next, lastTrigger };
    }
    next = next.filter((v) => v !== lowest);
  }

  return {
    accepted: true,
    active: next,
    lastTrigger: { ...lastTrigger, [request.id]: now },
  };
}

// Pure: appends the now-known voice (with its real duration) to `active`.
// Split from planVoiceRequest() for exactly the reason explained above —
// exported alongside it so tests can exercise slot release (a voice's `end`
// passing) without needing the accept/reject machinery in the same call.
export function commitVoice(active, request, now, duration) {
  return [...active, { id: request.id, priority: request.priority, start: now, end: now + duration }];
}

let voiceActive = [];
let voiceLastTrigger = {};

// Stateful wrapper around planVoiceRequest(): returns whether `id` may play
// right now, given `maxConcurrent`/`minInterval`/`priority` from its
// catalogue entry (soundtypes.js). Always false before start() — see the
// header's no-throw contract.
export function requestVoice(id, { priority, maxConcurrent, minInterval }) {
  if (!ctx) return false;
  const now = ctx.currentTime;
  const result = planVoiceRequest(voiceActive, voiceLastTrigger, { id, priority, maxConcurrent, minInterval }, now);
  voiceActive = result.active;
  voiceLastTrigger = result.lastTrigger;
  return result.accepted;
}

// Stateful wrapper around commitVoice(): call once requestVoice() has
// returned true AND the generator has actually run, so `duration` is real.
export function commitVoiceDuration(id, priority, duration) {
  if (!ctx) return;
  voiceActive = commitVoice(voiceActive, { id, priority }, ctx.currentTime, duration);
}
