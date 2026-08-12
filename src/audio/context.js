// Phase 8 audio infrastructure — the ONE place that owns the AudioContext and
// the permanent bus graph everything else (proceduralmusic.js, sfx.js) plugs into.
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
//   music voices ──> musicGain ──> musicFilter ──> duckGain ──> musicDropGain ──> compressor ──> destination
//   sfx voices   ──> sfxGain   ──────────────────────────────> sfxDropGain ──────────────────────────^
//
// musicFilter (Phase 8 step 4) is a lowpass whose cutoff main.js's update
// loop tracks against player speed — see setMusicCutoff()/speedToMusicCutoff()
// below. It sits BETWEEN musicGain and duckGain deliberately, its own node,
// touching only `.frequency` — never `.gain` — so it can never fight the two
// existing users of this same bus for control of one AudioParam:
//   - proceduralmusic.js's disturb() touches the CURRENTLY-SOUNDING PAD'S OWN filter
//     (schedulePad's per-bar `currentPadFilter`, a completely different node
//     from this one) plus that pad's own oscillator detune. A speed-driven
//     cutoff here and a transient hit-driven dip on the pad's own filter
//     compose by simple arithmetic — the pad's content passes through BOTH
//     filters in series, each free to move on its own schedule, neither
//     ever calling cancelScheduledValues() on the other's AudioParam.
//   - Phase 8 step 5's sector-transition re-sync DOES reuse musicFilter's own
//     `.frequency` — a deliberate departure from the "give every effect its
//     own node" precedent sfxDropGain sets, because the task brief is
//     explicit that this one has to COMPOSE with the speed mapping rather
//     than sit in series with it: "collapse the cutoff" only means something
//     relative to wherever the speed mapping currently has it, not a fixed
//     absolute target. See the "Cutoff composition" section below (composeMusicCutoff /
//     planSetMusicCutoff / planBeginSectorTransition) for how the two stay
//     out of each other's way on the ONE shared AudioParam instead: a
//     base+multiplicative-offset split, with a single pair of functions
//     that ever calls cancelScheduledValues()/rampToValueAtTime() on it.
//
// musicDropGain is the music path's analogue of sfxDropGain, and exists for
// exactly one reason: the disconnect fade (fadeMusicForDisconnect() /
// restoreMusicAfterDisconnect() below) needs to ramp the whole music path to
// silence and back WITHOUT fighting setMusicVolume() for musicGain's own
// AudioParam. It used to ride musicGain directly, which meant the MUSIC
// slider and the disconnect fade both called cancelScheduledValues() on the
// same param and whichever ran last won outright — nudging the MUSIC bar on
// the gameover screen (main.js's own menu handling) audibly pulled the music
// back up out of the silence the disconnect had just faded it into. Its own
// node means the fade never has to know or care what the MUSIC slider is
// doing, exactly as sfxDropGain never has to know about the SOUND slider.
//
// duckGain sits ONLY on the music path. Ducking sfx against itself would be
// nonsense — the sound causing the duck would be dipping its own volume out
// from under itself — so sfxGain never feeds duckGain; it gets its own
// analogous stage, sfxDropGain, for exactly one purpose (see dropSfxBus()
// below): Phase 8 step 3's hull_hiss dropout effect, a brief near-total cut
// of the WHOLE sfx path standing in for "the deck's feed itself hiccups" at
// critically low hull. Every sfx voice — one-shot (sfx.js) AND sustained
// (audio/sustained.js) — connects to sfxGain first, so both ride this dip
// together, which is the point: a dropout has to read as the FEED cutting
// out, not as one quiet background texture stuttering.
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

// Phase 8 step 4's speed-linked filter reads player.js's own speed range
// rather than a second hand-picked band — the same "reuse the game's own
// figure instead of a number that can quietly drift from it" reasoning
// sustainedfx.js's SHIELD_DRONE_FADE_WINDOW already applies to
// player.js's SHIELD_EXPIRING. A pure-data import of two constants, not a
// live read of player state — this file still never touches a Player
// instance, exactly as the rest of context.js never touches game state.
import { MIN_SPEED, MAX_SPEED } from "../game/player.js";

const MASTER_VOLUME = 0.6; // overall mix level; every bus below is balanced against this, unchanged from the old synth.js

let ctx = null;
let musicGain = null;
let musicFilter = null;
let sfxGain = null;
let sfxDropGain = null;
let duckGain = null;
let musicDropGain = null;
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

  // See the header: sfxDropGain is sfxGain's own analogue of duckGain, used
  // for exactly one thing today (dropSfxBus() below) — undipped (1) until
  // that first fires.
  sfxDropGain = ctx.createGain();
  sfxDropGain.gain.value = 1;

  duckGain = ctx.createGain();
  duckGain.gain.value = 1; // undipped until the first duck() call

  // See the header: musicDropGain is musicGain's own analogue of sfxDropGain,
  // used for exactly one thing (the disconnect fade below) — open (1) until
  // fadeMusicForDisconnect() first pulls it down.
  musicDropGain = ctx.createGain();
  musicDropGain.gain.value = 1;

  // Phase 8 step 4's speed-linked lowpass — see the header's bus diagram for
  // why this is its own node, between musicGain and duckGain. Starts at
  // MUSIC_CUTOFF_MAX (brightest) rather than MUSIC_CUTOFF_MIN: nothing has
  // called setMusicCutoff() yet at this point (main.js's first "playing"
  // tick does that), and defaulting bright means the music sounds exactly as
  // it always did until the speed tracking actually engages, rather than
  // opening every run artificially dulled for a frame or two.
  musicFilter = ctx.createBiquadFilter();
  musicFilter.type = "lowpass";
  musicFilter.frequency.value = MUSIC_CUTOFF_MAX;

  const compressor = ctx.createDynamicsCompressor();
  musicGain.connect(musicFilter);
  musicFilter.connect(duckGain);
  duckGain.connect(musicDropGain);
  musicDropGain.connect(compressor);
  sfxGain.connect(sfxDropGain);
  sfxDropGain.connect(compressor);
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

// --- Speed-linked music filter -----------------------------------------
//
// "Slower means duller." Deliberately NARROW — the design brief is explicit
// that this must be FELT, not heard as an effect ("if it is audible as a
// filter sweep it is too wide") — and it stays well inside every source
// voice's own headroom: proceduralmusic.js's pad rests at 900Hz, the bass at 350Hz,
// the accent at 1400Hz, so MUSIC_CUTOFF_MIN sitting exactly at the pad's own
// resting point means a dead crawl caps the WHOLE bus no darker than the pad
// already always is, and MUSIC_CUTOFF_MAX stays comfortably under the
// catalogue's ~5kHz noise rolloff. What actually moves across that ~1700Hz
// span is the harmonic SHEEN a lowpass filter's own gentle rolloff always
// leaves leaking above a source's nominal cutoff (a sawtooth's upper
// partials, the accent's own upper harmonics) — real, audible "openness",
// narrow enough not to read as a sweep.
export const MUSIC_CUTOFF_MIN = 900; // Hz, at MIN_SPEED
export const MUSIC_CUTOFF_MAX = 2600; // Hz, at MAX_SPEED

// Pure: player speed (world units/sec, player.js's own MIN_SPEED..MAX_SPEED
// band) -> lowpass cutoff (Hz). Clamped at both ends, so a caller never has
// to clamp `speed` first — a value outside the band (nothing in the game
// produces one, but a slider on the SFX gallery could) still returns a
// cutoff inside [MUSIC_CUTOFF_MIN, MUSIC_CUTOFF_MAX] rather than
// extrapolating past it. Exported for the invariant tests, which check the
// mapping stays inside its stated range for every input, 0 and MAX_SPEED
// included — the same "pure function first" split every other driver in
// this audio layer (planDuck, hullHissLevel, dreadPulseRate, ...) already
// follows.
export function speedToMusicCutoff(speed) {
  const t = Math.max(0, Math.min(1, (speed - MIN_SPEED) / (MAX_SPEED - MIN_SPEED)));
  return MUSIC_CUTOFF_MIN + t * (MUSIC_CUTOFF_MAX - MUSIC_CUTOFF_MIN);
}

const MUSIC_CUTOFF_RAMP = 0.25; // seconds — never snaps; see setMusicVolume's own ramp for the same reasoning (a sudden AudioParam jump reads as a click, not a change)

// --- Cutoff composition: base (speed) x offset (sector transition) --------
//
// Phase 8 step 5 gives a SECOND system a reason to move musicFilter.frequency:
// a sector crossing (main.js's own edge-detector on sectors.glitching())
// wants to collapse the filter to a dull ~300Hz over ~300ms and reopen it
// over ~1.5s, "a re-sync". If that transition and the speed mapping below
// both called cancelScheduledValues()/rampToValueAtTime() on the SAME
// AudioParam independently, whichever ran last would win outright — main.js
// polls updateMusicCutoff() every "playing" tick, so a single such poll
// landing mid-transition would silently cut the reopen ramp short.
//
// THE FIX, the same shape context.js's own duck accumulator already uses
// for an analogous "many callers, one shared node" problem (see planDuck's
// own header): the speed mapping becomes a BASE value (Hz, what
// speedToMusicCutoff already produces), the transition becomes a
// MULTIPLICATIVE OFFSET (0..1, 1 = fully released/no effect) applied on top,
// and exactly one pair of functions below (planSetMusicCutoff /
// planBeginSectorTransition, plus their stateful wrappers setMusicCutoff /
// beginSectorTransition) ever calls into the AudioParam. While a transition
// is in flight, an incoming speed update updates the TRACKED base but is not
// written to the node at all — the transition's own scheduled ramp is left
// completely alone, and the freshest base takes over smoothly the moment the
// transition's reopen ramp finishes.
//
// MULTIPLICATIVE, NOT A SECOND ABSOLUTE TARGET, and NOT CLAMPED to
// [MUSIC_CUTOFF_MIN, MUSIC_CUTOFF_MAX] the way speedToMusicCutoff's own
// output is — that band exists to bound the SPEED mapping specifically (see
// its own comment above), and the whole point of a sector transition is to
// read as darker than the music ever gets in ordinary play, which requires
// going below MUSIC_CUTOFF_MIN on purpose. composeMusicCutoff instead floors
// at MUSIC_CUTOFF_FLOOR, a much lower, purely defensive bound (matching
// proceduralmusic.js's own disturb() floor on the pad's unrelated filter) that exists
// only to stop a BiquadFilter's frequency from ever being driven to
// something degenerate, not to preserve the speed band's own headroom.
export const MUSIC_CUTOFF_FLOOR = 150; // Hz — an absolute safety floor, well under any speed-linked base or transition target either system produces
export const SECTOR_COLLAPSE_OFFSET = 300 / MUSIC_CUTOFF_MIN; // ~0.33 — anchored to MUSIC_CUTOFF_MIN (900) so a collapse starting from the darkest the speed base ever gets lands at the design's own "~300Hz" target; a collapse starting from a brighter base (higher speed) lands proportionally brighter than 300Hz but still reads as a hard collapse relative to wherever it started — a FIXED absolute 300Hz target would instead mean two collapses at different speeds sound like two different DEPTHS of collapse, which is the wrong thing to vary with player speed
export const SECTOR_COLLAPSE_ATTACK = 0.3; // seconds — collapse time, per the design brief
export const SECTOR_COLLAPSE_RELEASE = 1.5; // seconds — reopen time, per the design brief

// Pure: composes a base cutoff (Hz) with a multiplicative offset (0..1) and
// floors the result. Exported for the invariant tests, which check this
// stays sane (never negative, never absurd) across the full range of bases
// and offsets either caller can produce — see context.js's header on why the
// floor is MUSIC_CUTOFF_FLOOR rather than MUSIC_CUTOFF_MIN.
export function composeMusicCutoff(base, offset) {
  return Math.max(MUSIC_CUTOFF_FLOOR, base * offset);
}

// Pure: the decision setMusicCutoff() below has to make on every call —
// whether this speed update is allowed to touch the AudioParam right now, or
// must instead just update the tracked base for whenever the transition (if
// any) releases. `state` is { cutoffBase, lastCutoffTarget, transitionEndTime }
// (transitionEndTime is 0 when no transition has ever run). `now` is
// ctx.currentTime. Exported for the invariant tests — see context.js's
// header for why this mirrors planDuck/planVoiceRequest's own pure/stateful
// split.
export function planSetMusicCutoff(state, freq, now) {
  const withBase = { ...state, cutoffBase: freq };
  if (now < state.transitionEndTime) {
    // The transition currently owns the node — remember the new base (so
    // whatever ramp runs next uses it) but request no write. This is the
    // one branch that makes "a speed update mid-transition does not cancel
    // the transition" true: no cancelScheduledValues() call is ever reached
    // for a suppressed write, because the stateful wrapper below only calls
    // it when `write` is true.
    return { state: withBase, write: false };
  }
  if (freq === state.lastCutoffTarget) {
    return { state, write: false }; // unchanged target, no transition in the way — the ordinary "nothing to do" no-op setMusicCutoff always had
  }
  return { state: { ...withBase, lastCutoffTarget: freq }, write: true, target: freq };
}

// Pure: the decision beginSectorTransition() below makes once, at the
// instant a crossing fires. Captures the CURRENT base as the reopen target —
// deliberately a snapshot taken now, not a live read repeated when the
// reopen ramp itself starts 300ms later, because Web Audio's own
// linearRampToValueAtTime() has no way to re-target a ramp that's already
// scheduled; retargeting the reopen to a base that moves DURING the collapse
// would require a second JS-timer-scheduled call partway through, adding
// exactly the kind of scheduling jitter this whole scheme exists to avoid.
// The practical effect: the music reopens to "whatever speed the player was
// doing at the moment of the crossing", which reads fine and is still well
// within the design brief's own requirement — the transition survives a
// mid-flight speed update without being cancelled, it just doesn't chase a
// SECOND speed change that happens while it's already reopening.
export function planBeginSectorTransition(state, now) {
  const collapseTarget = composeMusicCutoff(state.cutoffBase, SECTOR_COLLAPSE_OFFSET);
  const transitionEndTime = now + SECTOR_COLLAPSE_ATTACK + SECTOR_COLLAPSE_RELEASE;
  return {
    state: { ...state, transitionEndTime, lastCutoffTarget: state.cutoffBase },
    collapseTarget,
    reopenTarget: state.cutoffBase,
    collapseAt: now + SECTOR_COLLAPSE_ATTACK,
    transitionEndTime,
  };
}

let cutoffState = { cutoffBase: MUSIC_CUTOFF_MAX, lastCutoffTarget: null, transitionEndTime: 0 }; // cutoffBase mirrors musicFilter's own build-time default (see buildGraph)

// Called once per "playing" tick from main.js's update loop (via synth.js's
// updateMusicCutoff facade), with whatever speedToMusicCutoff(player.speed)
// comes out to. Ramps rather than snaps, and is a no-op when `freq` matches
// the last WRITTEN target or a sector transition currently owns the node —
// see planSetMusicCutoff above for the actual decision.
export function setMusicCutoff(freq) {
  if (!ctx) return;
  const t = ctx.currentTime;
  const plan = planSetMusicCutoff(cutoffState, freq, t);
  cutoffState = plan.state;
  if (!plan.write) return;
  musicFilter.frequency.cancelScheduledValues(t);
  musicFilter.frequency.setValueAtTime(musicFilter.frequency.value, t);
  musicFilter.frequency.linearRampToValueAtTime(plan.target, t + MUSIC_CUTOFF_RAMP);
}

// Called once per sector crossing (synth.js's triggerSectorTransition facade,
// itself called from main.js's edge-detector on sectors.glitching()).
// Schedules BOTH legs of the re-sync as one pair of ramps — the collapse and
// the reopen — up front, so nothing in between (including a same-tick
// setMusicCutoff() call, which planSetMusicCutoff will now suppress writing
// for the transition's own duration) can interrupt them.
export function beginSectorTransition() {
  if (!ctx) return;
  const t = ctx.currentTime;
  const plan = planBeginSectorTransition(cutoffState, t);
  cutoffState = plan.state;
  musicFilter.frequency.cancelScheduledValues(t);
  musicFilter.frequency.setValueAtTime(musicFilter.frequency.value, t);
  musicFilter.frequency.linearRampToValueAtTime(plan.collapseTarget, t + SECTOR_COLLAPSE_ATTACK);
  musicFilter.frequency.linearRampToValueAtTime(plan.reopenTarget, plan.transitionEndTime);
}

// Called from main.js's newGame() (via synth.js's resetForNewRun facade) —
// a fresh run must never inherit a collapse still reopening from a sector
// crossing the LAST run happened to die during. Cancels whatever ramp is in
// flight and snaps the tracked state back to "released", so the very next
// setMusicCutoff() call (main.js's first "playing" tick) writes a fresh,
// un-suppressed ramp rather than finding a stale transitionEndTime still in
// its future.
export function resetMusicCutoffTransition() {
  cutoffState = { cutoffBase: MUSIC_CUTOFF_MAX, lastCutoffTarget: null, transitionEndTime: 0 };
  if (!ctx) return;
  const t = ctx.currentTime;
  musicFilter.frequency.cancelScheduledValues(t);
  musicFilter.frequency.setValueAtTime(MUSIC_CUTOFF_MAX, t);
}

// --- Disconnect polish: the music bus fades to silence ahead of the SFX ---
//
// "Cut the music to silence ~200ms before the static begins, so the drop
// lands in a hole" (design brief). Implemented as a head start rather than a
// real setTimeout: fadeMusicForDisconnect() ramps musicDropGain toward silence
// starting NOW, and synth.js's playDisconnect() schedules generateDisconnect
// itself DISCONNECT_FADE seconds into the future (sfx.js's play() opts.startDelay)
// — both scheduled off the SAME ctx.currentTime instant, so the two can never
// drift apart the way two independently-timed calls could.
//
// ON musicDropGain, NOT musicGain — see the module header's own note on that
// node. musicGain is the MUSIC SLIDER'S param (setMusicVolume above), and
// these two ramps used to share it: a MUSIC-row adjust on the gameover screen
// then cancelled the disconnect fade and pulled the music back up out of the
// silence it was supposed to be lying in. Two effects, two nodes, no shared
// AudioParam — the same rule sfxDropGain follows against setSfxVolume().
//
// A RAMP, never a stop of anything — proceduralmusic.js's scheduler keeps
// scheduling notes into the silence the whole time (see the module header's
// own "going quiet is a volume ramp, never a teardown"), and trackmusic.js's
// own source keeps playing through it; restoreMusicAfterDisconnect() below
// just re-opens the SAME node, so whatever was already sounding is simply
// audible again, no restart, no seam.
export const DISCONNECT_FADE = 0.2; // seconds — the head start; sfx.js's generateDisconnect is delayed to start exactly this far into the future

export function fadeMusicForDisconnect() {
  if (!ctx) return;
  const t = ctx.currentTime;
  musicDropGain.gain.cancelScheduledValues(t);
  musicDropGain.gain.setValueAtTime(musicDropGain.gain.value, t);
  musicDropGain.gain.linearRampToValueAtTime(0.0001, t + DISCONNECT_FADE);
}

// Called from main.js's newGame() (via synth.js's resetForNewRun facade) —
// "music restored from the disconnect silence" per the design brief. Re-opens
// musicDropGain to unity (NOT to the MUSIC slider's level — that's musicGain's
// job, and this node knows nothing about it), the same ramp-not-snap shape
// every other AudioParam move in this file uses.
export function restoreMusicAfterDisconnect() {
  if (!ctx) return;
  const t = ctx.currentTime;
  musicDropGain.gain.cancelScheduledValues(t);
  musicDropGain.gain.setValueAtTime(musicDropGain.gain.value, t);
  musicDropGain.gain.linearRampToValueAtTime(1, t + 0.15);
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
// RAISED FROM AN INITIAL 4dB — at 4, even soundtypes.js's own duck=1 entry
// (kill_neutral) only dipped the music bus ~37% in amplitude, which combat
// playtesting found wasn't enough headroom for SFX to read clearly against
// a busy music passage (the pad alone sums SIX detuned oscillators — see
// proceduralmusic.js's schedulePad — so the music bus routinely carries more
// simultaneous signal than any one-shot SFX does). 8dB gives a duck=1
// sound roughly 60% amplitude reduction, genuinely audible without being a
// hard mute.
export const MAX_DUCK_DB = 8; // the deepest dip a duck=1 sound can produce

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

// --- SFX bus dropout -----------------------------------------------------
//
// A brief, near-total dip of the WHOLE sfx path — see the header's bus
// diagram for why this rides its own gain stage rather than sfxGain
// directly: sfxGain's level is also being ramped by setSfxVolume() whenever
// the SOUND slider moves, and fighting that ramp for the same AudioParam
// (via the cancelScheduledValues() every ramp here already needs) risks a
// dropout and a slider drag stepping on each other. A dedicated node means
// this never has to know or care what the SOUND slider is doing.
//
// LINEAR, HARD-EDGED ramps rather than the exponential curves the rest of
// this file uses for hits and ducks — those want to read as a NATURAL decay;
// this wants to read as a CUT, the feed dropping out and snapping back, so a
// fast, straight-line edge on both sides is the right shape, not a softened
// one.
const DROPOUT_EDGE = 0.008; // seconds — fast enough to read as a cut, not a fade

export function dropSfxBus(depthGain, holdSeconds) {
  if (!ctx) return;
  const t = ctx.currentTime;
  const edge = Math.min(DROPOUT_EDGE, holdSeconds / 2); // never let the edges overlap on a very short hold
  sfxDropGain.gain.cancelScheduledValues(t);
  sfxDropGain.gain.setValueAtTime(sfxDropGain.gain.value, t);
  sfxDropGain.gain.linearRampToValueAtTime(depthGain, t + edge);
  sfxDropGain.gain.setValueAtTime(depthGain, t + holdSeconds - edge);
  sfxDropGain.gain.linearRampToValueAtTime(1, t + holdSeconds);
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
