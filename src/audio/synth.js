// Phase 8's audio facade — the only file main.js imports from. Everything
// this used to do directly (own the AudioContext, schedule the music loop,
// play the one SFX) now lives in three focused modules this just wires
// together, so a future call site never has to know the split happened:
//
//   context.js   the AudioContext + permanent bus graph, ducking, the voice
//                limiter — see its header for the bus diagram
//   music.js     the scheduled synthwave loop, unchanged to the ear
//   soundtypes.js + sfx.js   the SFX catalogue and its player, `play(id)`
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

export function createMusic() {
  return { start, setVolume, setSfxVolume, playDisconnect, play };
}
