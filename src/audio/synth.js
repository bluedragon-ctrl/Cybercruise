// Phase 8's audio facade — the only file main.js imports from. Everything
// this used to do directly (own the AudioContext, schedule the music loop,
// play the one SFX) now lives in three focused modules this just wires
// together, so a future call site never has to know the split happened:
//
//   context.js   the AudioContext + permanent bus graph, ducking, the voice
//                limiter — see its header for the bus diagram
//   music.js     the scheduled synthwave loop, plus Phase 8 step 3's
//                disturb() seam for a heavy hit briefly souring the pad
//   soundtypes.js + sfx.js   the SFX catalogue and its player, `play(id)`
//   sustainedtypes.js + sustained.js + sustainedfx.js   Phase 8 step 3's
//                second voice lifecycle — sustained voices (hull_hiss,
//                shield_drone, wall_scrape) that live for the whole run
//                instead of one-shot-and-forget; see sustained.js's header
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
// the whole engine would silently produce no sound. Nothing in context.js,
// music.js, soundtypes.js or sfx.js constructs an AudioContext at import
// time either — see context.js's own header on the same rule.

import * as context from "./context.js";
import * as music from "./music.js";
import { play as playSfx } from "./sfx.js";
import * as sustainedfx from "./sustainedfx.js";

// Starts the AudioContext (context.js) and then the music scheduler
// (music.js) — in that order, since music.js's start() reads context.js's
// bus graph and needs it to already exist. A second call is a no-op, the
// same contract both underlying start()s already have individually.
function start() {
  context.start();
  music.start();
}

// Mirrors menu.js's MUSIC volume (0..1) — forwarded straight to context.js,
// which owns the bus this actually adjusts.
function setVolume(level) {
  context.setMusicVolume(level);
}

// Mirrors menu.js's SOUND level (0..1) — forwarded straight to context.js.
function setSfxVolume(level) {
  context.setSfxVolume(level);
}

// The one SFX call site this game has needed so far. Now just sugar over
// play("disconnect") — kept as its own method (rather than making main.js
// call play("disconnect") directly) so main.js's call site reads the same as
// it did before the split.
function playDisconnect() {
  playSfx("disconnect");
}

// New: the general entry point future SFX call sites will use once
// soundtypes.js grows past "disconnect" — e.g. `music.play("kick_hit")`.
function play(id, opts) {
  playSfx(id, opts);
}

// Phase 8 step 3's music-disturbance seam (music.js's own disturb()) —
// exposed here rather than main.js importing music.js directly, same reason
// every other capability in this facade is forwarded one call at a time.
function disturb(amount) {
  music.disturb(amount);
}

// Phase 8 step 3's sustained-voice drivers — main.js calls these once per
// "playing" tick (see its own update()). Each is a thin forward to
// sustainedfx.js; see that file's own header for what drives each one.
function updateHullHiss(dt, hullFrac, glitching) {
  sustainedfx.updateHullHiss(dt, hullFrac, glitching);
}
function updateShieldDrone(shieldTime) {
  sustainedfx.updateShieldDrone(shieldTime);
}
function updateWallScrape(contact) {
  sustainedfx.updateWallScrape(contact);
}
// Phase 8 step 4's dread_pulse driver — `tailThreat` is traffic.js's own
// tailThreat() result (a plain {gap, closing} pair, or null), unchanged all
// the way through to sustainedfx.js. See that file's own header for why the
// query lives in traffic.js rather than here.
function updateDreadPulse(dt, tailThreat) {
  sustainedfx.updateDreadPulse(dt, tailThreat);
}

// Phase 8 step 4's speed-linked music filter — forwards straight to
// context.js, which owns both the BiquadFilter node itself and the pure
// speed->cutoff mapping (speedToMusicCutoff). Kept as two separate calls
// here (map, then set) rather than a single context.js function, so the
// pure mapping stays independently testable — see context.js's own comment.
function updateMusicCutoff(speed) {
  context.setMusicCutoff(context.speedToMusicCutoff(speed));
}

// Releases every sustained voice — main.js calls this from newGame(), so a
// fresh run never inherits a hiss/drone/scrape from the run that just ended.
// See sustainedfx.js's own reset() for why this also has to be more than
// just "silence everything".
function resetSustained() {
  sustainedfx.reset();
}

export function createMusic() {
  return {
    start, setVolume, setSfxVolume, playDisconnect, play, disturb,
    updateHullHiss, updateShieldDrone, updateWallScrape,
    updateDreadPulse, updateMusicCutoff, resetSustained,
  };
}
