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
// main.js owns WHEN this plays. Phase 8 step 5 splits that "when" into TWO
// moments (see startContext()/jackIn() below for the full reasoning):
// startContext() fires on the FIRST keydown of any kind, anywhere, so the
// menu's own SOUND/MUSIC sliders can preview before a run has even begun;
// jackIn() still only fires once, on START GAME's own confirm, and is what
// actually starts music.js's scheduler. main.js also calls setVolume() /
// setSfxVolume() to mirror menu.js's MUSIC and SOUND levels respectively.
// This module never reads menu.js or localStorage itself — same wiring
// pattern as fireShot/dropMine in main.js, where the owning module (menu.js)
// stays ignorant of the system it's wired into.
//
// IMPORTANT BROWSER CONTRACT: an AudioContext is born (or stays) "suspended"
// unless created/resumed inside the aftermath of a real user gesture — see
// startContext()'s call site. Calling it from a keydown-driven handler (as
// main.js does) satisfies that; calling it at module load would not, and the
// whole engine would silently produce no sound. Nothing in context.js,
// music.js, soundtypes.js or sfx.js constructs an AudioContext at import
// time either — see context.js's own header on the same rule.

import * as context from "./context.js";
import * as music from "./music.js";
import { play as playSfx, JACK_IN_DURATION } from "./sfx.js";
import * as sustainedfx from "./sustainedfx.js";

// Phase 8 step 5, PROBLEM 1: the AudioContext and the music SCHEDULER now
// start at two different moments, where the old combined start() (both, in
// one call, on START GAME) used to cover both.
//
//   - startContext() builds the bus graph alone. main.js calls this on the
//     FIRST keydown of any kind, anywhere — before START GAME is ever
//     confirmed — because the SOUND/MUSIC sliders on the menu screen need a
//     live context to preview against (menu_adjust), and START GAME itself
//     is the earliest point the OLD code ever built one. Any keydown is a
//     valid user gesture for the browser's autoplay-gesture requirement
//     (see context.js's own header) — it doesn't have to be a mapped game
//     action, just a real keypress — so the first one, whichever it is, is
//     the earliest LEGAL point, and starting any later would leave menu
//     audio silent for however long the player spent just moving the cursor
//     first.
//   - jackIn() (below) is what still only ever fires once, on START GAME's
//     own confirm — it starts music.js's SCHEDULER, timed against the
//     jack_in riser it also plays. See its own comment for why the two
//     concerns don't collapse back into one function despite both now
//     running from the very same keypress on a typical first-ever session.
function startContext() {
  context.start();
}

// Used by the SFX gallery (src/demo/sfxgallery.js) — a dev tool with no
// jack_in ceremony of its own, no menu screen, and no reason to delay the
// scheduler's first downbeat against anything. Plain sugar for
// music.js's own start() at its default offset, kept as a named facade
// method rather than exporting music.js's start() directly so every call
// site still only ever imports this one file (see the module header).
function startMusicLoop() {
  music.start();
}

// THE START GAME transition. Bundles two things that must never drift apart
// (see soundtypes.js's own jack_in entry and music.js's start() header):
// the jack_in riser, and the music scheduler's own first-step offset, both
// keyed off the SAME sfx.js export (JACK_IN_DURATION) — so main.js's call
// site is just `music.jackIn()`, with no number of its own to accidentally
// mistype or let drift from the sound it's supposed to line up with. Only
// ever called once per page life in practice: menu.js's "start" mode (see
// its own header) only opens before the very first game, so this is the
// ONE call site that ever starts the scheduler — CONTINUE (pause) and
// RESTART (gameover) both resume a run against a scheduler that's already
// been running continuously since this fired.
function jackIn() {
  playSfx("jack_in");
  music.start(JACK_IN_DURATION);
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

// The player's connection dropping (game/disconnect.js's sequence). Phase 8
// step 5's disconnect polish folds in one more thing: the music bus now
// fades to silence context.js's own DISCONNECT_FADE seconds BEFORE the SFX's
// own static begins, "so the drop lands in a hole" per the design brief,
// rather than the TV-switching-off sound landing under music still audibly
// playing. fadeMusicForDisconnect() ramps musicGain starting NOW; the SFX
// itself is scheduled DISCONNECT_FADE seconds into the future via
// opts.startDelay (sfx.js's play(), see its own header) — both timed off the
// SAME ctx.currentTime instant this call makes, so the two can never drift
// apart the way two independently-scheduled calls could.
function playDisconnect() {
  context.fadeMusicForDisconnect();
  playSfx("disconnect", { startDelay: context.DISCONNECT_FADE });
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

// Phase 8 step 5's sector-transition re-sync: the gong (soundtypes.js's
// sector_shift) plus the musicFilter collapse/reopen (context.js's
// beginSectorTransition — see its own header, and the "Cutoff composition"
// section above it, for how that composes with the speed-linked filter
// rather than fighting it). Bundled into one call for the same reason
// jackIn() bundles the riser with the scheduler's own start-offset: main.js's
// edge-detector on sectors.glitching() has exactly one thing to call, and
// the gong and the filter collapse can never fire out of step with each
// other by construction.
function triggerSectorTransition() {
  playSfx("sector_shift");
  context.beginSectorTransition();
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

// Everything main.js's newGame() needs cleaned up before a fresh run starts,
// bundled into the one call it makes. Three concerns, each with its own
// reason a stale run mustn't leak into a new one:
//   - sustainedfx.reset() releases every sustained voice, so a fresh run
//     never inherits a hiss/drone/scrape from the run that just ended — see
//     that function's own header for why this also has to be more than just
//     "silence everything".
//   - context.resetMusicCutoffTransition() cancels a sector-transition
//     collapse/reopen that was still mid-flight when the player died (a
//     crossing and a death can land in the same run's final seconds) and
//     snaps the tracked base/offset state back to "released" — otherwise the
//     NEXT run's first speed-driven setMusicCutoff() call would find a
//     transitionEndTime still in its future and silently suppress its own
//     write (see context.js's own planSetMusicCutoff).
//   - context.restoreMusicAfterDisconnect() ramps musicGain back up from the
//     silence playDisconnect() faded it into — "music restored from the
//     disconnect silence" per the design brief. A harmless no-op the very
//     first time this runs (module load's own newGame() call, before any
//     disconnect has ever faded anything).
// Renamed from resetSustained() (Phase 8 step 3) now that it covers more
// than the sustained-voice registry alone.
function resetForNewRun() {
  sustainedfx.reset();
  context.resetMusicCutoffTransition();
  context.restoreMusicAfterDisconnect();
}

export function createMusic() {
  return {
    startContext, startMusicLoop, jackIn, setVolume, setSfxVolume, playDisconnect, play, disturb,
    triggerSectorTransition,
    updateHullHiss, updateShieldDrone, updateWallScrape,
    updateDreadPulse, updateMusicCutoff, resetForNewRun,
  };
}
