// The SECOND voice lifecycle, alongside sfx.js's one-shot play(). Every other
// sound is a one-shot: allocate nodes, schedule, return a duration, forget. This
// is for sounds with no duration at all — a hiss that tracks hull, a drone that
// lasts as long as a shield, a scrape that lasts as long as contact. Those don't
// fit the one-shot contract:
//
//   - no duration, so context.js's commitVoiceDuration is meaningless for them
//   - they must NEVER be stolen by the one-shot voice limiter: a hiss evicted
//     mid-firefight and never returning is hard to notice and confusing to hear,
//     since nothing about losing a voice slot LOOKS wrong on screen
//   - they need LEVEL CHANGES over time, not retriggering — hull_hiss gets
//     louder as hull falls, it does not replay
//
// THE FIX: build each sustained voice's graph exactly ONCE, the first time it is
// acquired, and leave it running silently (gain 0) for the rest of the page's
// life. Web Audio sources are one-shot — an Oscillator/AudioBufferSource can
// only ever be started once — so the only way to make a sound sustained is to
// never stop its source and move its GAIN instead. Going quiet is a ramp to
// zero, never a stop(), which is what makes acquire() idempotent and
// release()-then-acquire() free.
//
// SEPARATE FROM CONTEXT.JS'S VOICE LIMITER rather than an extension of it. The
// limiter rations a scarce, self-expiring resource (GLOBAL_VOICE_CAP one-shot
// slots) under contention from a growing catalogue. A sustained voice is
// neither: there are exactly three, fixed by sustainedtypes.js, and none expires
// on its own. Routing them through requestVoice() would mean teaching the
// limiter about voices that never age out — the one thing its design assumes.
// This registry has nothing to steal and nothing to expire, and cannot be
// starved by combat SFX however busy the fight gets.
//
// THE PURE/STATEFUL SPLIT mirrors context.js's planDuck()/duck(): plan*()
// functions are plain data in, plain data out, so test/invariants.test.js can
// exercise the registry's rules (idempotent acquire, ramp-on-change, release
// reuses rather than rebuilds) under plain Node. acquire()/setLevel()/release()
// are the only things here that touch a real AudioContext.
//
// SOUND-SPECIFIC GRAPHS (what hull_hiss/shield_drone/wall_scrape actually
// sound like) live in sustainedfx.js, mirroring sfx.js/soundtypes.js's own
// split: this file owns the LIFECYCLE only — build-once, gain-ramp,
// registry — and knows nothing about bandpass filters or tremolo LFOs.

import { isStarted, getCtx, getSfxBus } from "./context.js";
import { sustainedTypeById } from "./sustainedtypes.js";

const DEFAULT_RAMP = 0.5; // seconds — hull_hiss's own figure; every caller may override
const DEFAULT_RELEASE = 0.5;

// --- Pure registry bookkeeping ----------------------------------------
//
// `state` is a plain { [id]: { level } } map — never a Web Audio node in
// sight. This is the WHOLE decision layer: whether an id is already tracked
// (so acquiring it again is a no-op) and whether a requested level actually
// differs from the last one (so setLevel is a no-op on repeat, per the
// design brief's "ramp on change, do not set every frame").

// Idempotent: acquiring an id already in `state` returns the SAME reference
// back (not just an equal one) — a caller can tell "nothing changed" with
// `===`, which is exactly how the stateful acquire() below decides whether
// there's a graph to build.
export function planAcquire(state, id) {
  if (state[id]) return state;
  return { ...state, [id]: { level: 0 } };
}

// Returns { state, changed }. `changed` is false — and `state` is the SAME
// object passed in — when `value` matches what's already tracked, which is
// the whole mechanism behind "ramp on change, do not set every frame": a
// caller polling this every game tick (hull_hiss's own contract) only pays
// for a Web Audio ramp on the ticks where the target actually moved.
export function planSetLevel(state, id, value) {
  const entry = state[id];
  if (entry && entry.level === value) return { state, changed: false };
  return { state: { ...state, [id]: { level: value } }, changed: true };
}

// Release is just "set to 0" — the registry has no separate notion of
// on/off, only a level. Reacquiring a released id finds it still in `state`
// (release never deletes the entry) at level 0, which is what makes
// "release-then-acquire reuses the graph" true all the way down to the pure
// layer, not just the Web Audio one.
export function planRelease(state, id) {
  return planSetLevel(state, id, 0);
}

// --- Stateful wrapper: the real Web Audio graphs -----------------------

let registryState = {}; // mirrors the pure bookkeeping above, kept in sync by every call below
const nodes = {}; // id -> { gain: GainNode } — built once per id, ever; see the header

// Lazily builds `id`'s graph the FIRST time it's called (never at import
// time — same AudioContext contract as everything else in audio/, see
// context.js's header) and returns the same persistent handle on every
// subsequent call. A silent no-op (returns null) before start() — same
// contract as sfx.js's play(). Exported so sustainedfx.js's per-voice
// update*() functions can call it directly when they need more than level
// control (none currently do; every graph today only needs the gain node
// this hands back).
export function acquire(id) {
  if (!isStarted()) return null;
  registryState = planAcquire(registryState, id);
  if (nodes[id]) return nodes[id]; // already built — see the header on why this never rebuilds

  const ctx = getCtx();
  const gain = ctx.createGain();
  gain.gain.value = 0; // silent until the first setLevel() raises it
  gain.connect(getSfxBus());

  const entry = sustainedTypeById(id);
  if (entry && entry.generator) entry.generator(ctx, gain); // builds the persistent source(s) into `gain` — see sustainedfx.js

  const node = { gain };
  nodes[id] = node;
  return node;
}

// Ramps `id`'s gain toward `value` over `rampSeconds` — never snaps, so a
// value polled every frame (hull_hiss's hull fraction, shield_drone's
// countdown) doesn't click. Lazily acquires `id` first, so a caller never
// has to sequence "acquire, then setLevel" by hand. A no-op before start(),
// and a no-op if `value` matches what's already tracked (see planSetLevel).
export function setLevel(id, value, rampSeconds = DEFAULT_RAMP) {
  if (!isStarted()) return;
  const node = acquire(id);
  if (!node) return;

  const plan = planSetLevel(registryState, id, value);
  registryState = plan.state;
  if (!plan.changed) return;

  const ctx = getCtx();
  const t = ctx.currentTime;
  node.gain.gain.cancelScheduledValues(t);
  node.gain.gain.setValueAtTime(node.gain.gain.value, t);
  node.gain.gain.linearRampToValueAtTime(value, t + Math.max(0.001, rampSeconds));
}

// Sugar for setLevel(id, 0, ...) — ramps to silence rather than stopping any
// node, so the SAME graph is what a later acquire()/setLevel() finds still
// running (see the header).
export function release(id, rampSeconds = DEFAULT_RELEASE) {
  setLevel(id, 0, rampSeconds);
}

// Releases every sustained voice that has ever been acquired. Called by
// sustainedfx.js's own reset() (in turn called from main.js's newGame()) —
// see that function's header for why a fresh run must never inherit a hiss,
// drone or scrape still ramping down from the run that just ended.
export function releaseAll(rampSeconds) {
  for (const id of Object.keys(nodes)) release(id, rampSeconds);
}
