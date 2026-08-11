// The SFX generator functions, plus play(id, opts) — the single entry point
// every future call site uses to trigger a catalogued sound (soundtypes.js).
// play() is the piece that turns a catalogue entry into an actual Web Audio
// voice: it asks context.js's voice limiter for a slot, builds this sound's
// own little gain/delay-send subgraph off the shared buses, ducks the music
// if asked to, and only then calls the generator. Everything about MIXING a
// sound lives here, once — a new generator function never has to know about
// gain, ducking, delay sends or voice stealing; it just builds oscillators/
// noise into the `dest` node it's handed and reports how long it runs.
//
// A GENERATOR'S CONTRACT: `(ctx, dest, time, opts) => durationSeconds`.
//   ctx      the live AudioContext (context.js's getCtx()) — never null here,
//            play() already checked before calling in
//   dest     a GainNode already at this sound's catalogue `gain` level and
//            already connected to sfxGain (and, if delaySend > 0, already
//            tapped into the shared delay too) — connect straight to this,
//            nothing else
//   time     the ctx.currentTime this voice should start at
//   opts     whatever play()'s caller passed through, generator-specific
//   returns  how many seconds this voice needs before it's silent — the ONE
//            piece of information context.js's voice limiter can't know on
//            its own (see its header on why the slot API is two steps)

import {
  isStarted, getCtx, getSfxBus, getDelay, getNoiseBuffer,
  duck, requestVoice, commitVoiceDuration,
} from "./context.js";
import { soundTypeById, registerGenerator } from "./soundtypes.js";

// --- Generators ----------------------------------------------------------

// The player's own connection dropping (game/disconnect.js). A noise burst
// under a fast downward-sweeping tone — the feed cutting to static while the
// carrier loses lock — rather than an explosion thump, because the car isn't
// destroyed, the LINK is (see disconnect.js's header). Moved verbatim from
// the old synth.js's playDisconnect, just re-pointed at `dest` instead of a
// module-level sfxGain.
//
// Both envelopes below trail out to roughly disconnect.js's CAR_GLITCH_END
// (~1.4s into its 2.6s sequence) rather than the sequence's own opening beat —
// sized to the SEQUENCE'S pacing, not a generic short "hit" length, so the
// sound doesn't go quiet a fifth of the way through a moment that's still
// visibly unfolding. The returned duration matches that trail so the voice
// limiter frees this slot right as the last of it fades, not early.
function generateDisconnect(ctx, dest, t) {
  const noiseBuffer = getNoiseBuffer();

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
  src.connect(band).connect(noiseGain).connect(dest);
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
  osc.connect(toneGain).connect(dest);
  osc.start(t);
  osc.stop(t + 1.35);

  return 1.35;
}

registerGenerator("disconnect", generateDisconnect);

// --- play() ----------------------------------------------------------------
//
// Looks up `id` in the catalogue, asks context.js's voice limiter whether it
// may play right now, and if so builds this call's own gain (+ optional
// delay send) off the shared buses before handing control to the generator.
// A no-op — never a throw — if audio hasn't started yet (context.js's
// isStarted()), if `id` isn't in the catalogue, or if the voice limiter says
// no room: every one of those is a normal, expected outcome (a sound played
// before START GAME, a typo'd id during development, a rapid-fire weapon
// that just lost a steal), not an error condition worth crashing a frame
// over.
export function play(id, opts) {
  if (!isStarted()) return;
  const entry = soundTypeById(id);
  if (!entry || !entry.generator) return;

  const accepted = requestVoice(id, {
    priority: entry.priority,
    maxConcurrent: entry.maxConcurrent,
    minInterval: entry.minInterval,
  });
  if (!accepted) return;

  const ctx = getCtx();
  const t = ctx.currentTime;

  // This call's own gain stage, at the catalogue's mix level, feeding the
  // shared sfx bus — every generator connects to THIS, never to getSfxBus()
  // directly, so a per-sound gain never has to be re-derived inside the
  // generator itself.
  const dest = ctx.createGain();
  dest.gain.value = entry.gain;
  dest.connect(getSfxBus());

  if (entry.delaySend > 0) {
    const send = ctx.createGain();
    send.gain.value = entry.delaySend;
    dest.connect(send).connect(getDelay());
  }

  if (entry.duck > 0) duck(entry.duck);

  const duration = entry.generator(ctx, dest, t, opts);
  commitVoiceDuration(id, entry.priority, duration);
}
