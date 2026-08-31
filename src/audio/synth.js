// The audio facade — the only file main.js imports from. It wires together:
//
//   context.js   the AudioContext + permanent bus graph, ducking, the voice
//                limiter — see its header for the bus diagram
//   proceduralmusic.js + trackmusic.js   two interchangeable music backends —
//                see "Music backend selection" below
//   soundtypes.js + sfx.js   the SFX catalogue and its player, `play(id)`
//   sustainedtypes.js + sustained.js + sustainedfx.js   the second voice
//                lifecycle: voices (shield_drone, wall_scrape, dread_pulse) that
//                live for a whole run instead of one-shot-and-forget
//
// main.js owns WHEN this plays, and that "when" is TWO moments:
// startContext() fires on the FIRST keydown of any kind, anywhere, so the
// menu's SOUND/MUSIC sliders can preview before a run has begun; jackIn() fires
// once, on START GAME's confirm, and starts the chosen backend's playback.
// main.js also calls setVolume()/setSfxVolume() to mirror menu.js's MUSIC and
// SOUND levels. This module never reads menu.js or localStorage itself.
//
// IMPORTANT BROWSER CONTRACT: an AudioContext is born (or stays) "suspended"
// unless created/resumed in the aftermath of a real user gesture. Calling it
// from a keydown handler satisfies that; calling it at module load would not,
// and the whole engine would silently produce no sound. Nothing in context.js,
// proceduralmusic.js, trackmusic.js, soundtypes.js or sfx.js constructs an
// AudioContext at import time either.
//
// --- Music backend selection ------------------------------------------------
//
// Both backends implement the only thing any call site here asks of "the
// music": start(delaySeconds). Nothing wider is assumed anywhere in this
// file on purpose (see MUSIC_BACKEND_METHODS below).
//
//   proceduralmusic.js   the synthesized loop. ALWAYS available.
//   trackmusic.js        recorded Ogg Vorbis tracks from assets/music/. Depends
//                        on a directory listing fetch, a track being present,
//                        and it decoding — none of which are guaranteed.
//
// Selection is resolved ONCE, lazily, by resolveBackend(), the first time
// anything asks the facade to play — and never re-evaluated, even if a track
// finishes decoding moments later or a later track fails. WHY FROZEN: swapping
// backends mid-run means the music jumping between a recorded track and the
// synth loop with no transition, which reads as a bug whatever triggers it.
//
// AVAILABILITY, NOT READINESS. resolveBackend() keys off trackmusic.js's
// isAvailable() (a soundtrack EXISTS — the listing came back with at least one
// track), not isReady() (a track has finished decoding). The listing is a small
// JSON fetch, usually resolved before the player has finished with the menu;
// decoding several MB of Ogg is not, so keying off readiness loses that race for
// any player who presses START GAME promptly and gives them the procedural loop
// for the whole session despite a good soundtrack on disk. A "track" choice made
// before the first buffer exists is still safe — trackmusic.js's start() awaits
// the same in-flight decode rather than assuming it is done.
import * as context from "./context.js";
import * as proceduralmusic from "./proceduralmusic.js";
import * as trackmusic from "./trackmusic.js";
import { play as playSfx, JACK_IN_DURATION } from "./sfx.js";
import * as sustainedfx from "./sustainedfx.js";

// Documents the interface both backends implement — not enforced by the
// language, just the name every call site below (and the invariant tests,
// which assert both backend modules actually export exactly these as
// functions) agrees to.
export const MUSIC_BACKEND_METHODS = ["start"];

// Pure: the decision resolveBackend() makes on every call. `alreadySelected` is
// null before the first decision this page life, or "track"/"procedural" once
// frozen; `available` is trackmusic.js's isAvailable(). Exported for the
// invariant tests, which can't construct a real trackmusic state (that needs
// fetch + decodeAudioData, unavailable under plain Node) but can exercise this
// directly — including the case that matters most, that an already-frozen choice
// never changes even if `available` flips.
export function chooseBackend(alreadySelected, available) {
  if (alreadySelected) return alreadySelected;
  return available ? "track" : "procedural";
}

let selectedBackendName = null; // null until resolveBackend()'s first call this page life — see chooseBackend()'s own header

function resolveBackend() {
  selectedBackendName = chooseBackend(selectedBackendName, trackmusic.isAvailable());
  return selectedBackendName === "track" ? trackmusic : proceduralmusic;
}

// The last-resort guard for trackmusic.js's one truly-fatal case: EVERY track in
// the directory failing to decode, discovered only after start() already
// committed to the track backend. Registered once at module scope, not per run,
// because backend selection is a once-per-page-life decision.
//
// This does not violate the freeze contract, which is about an AUDIBLE mid-run
// swap: it fires strictly before trackmusic.js has played a single sample this
// run, so there is no sounding thing for procedural to replace. Flipping
// selectedBackendName here reflects that the run genuinely ends up on procedural.
trackmusic.onExhausted(() => {
  console.error(
    "[audio] every track in assets/music/ failed to decode — falling back to procedural music (nothing had played yet this run, so this is not a mid-run swap)"
  );
  selectedBackendName = "procedural";
  proceduralmusic.start(0); // no riser to line up with any more — this fires well after jackIn()'s own timing budget has already been spent walking the playlist, so start as soon as possible rather than trying to reconstruct a delay against a moment now in the past
});

// Builds the bus graph alone. main.js calls this on the FIRST keydown of any
// kind, anywhere, before START GAME is confirmed, because the menu's SOUND/MUSIC
// sliders need a live context to preview against. Any real keypress satisfies
// the browser's autoplay-gesture requirement — it need not be a mapped game
// action — so the first one is the earliest LEGAL point, and starting later
// would leave menu audio silent for as long as the player spent on the cursor.
//
// It is also the earliest legal moment for trackmusic.js's preload() (fetch the
// listing, start decoding the first track): decodeAudioData is a method on a
// real AudioContext, so one has to exist first. Decoding is streamed one track
// ahead, so the FIRST track's decode is the only thing on the critical path
// between START GAME and a ready track backend.
//
// Returns preload()'s promise so a caller with no menu idle time to lean on (the
// SFX gallery) can await it before resolveBackend() makes its one-time decision.
// main.js ignores the return value: context.start() runs synchronously in the
// same gesture-handling tick, which is all the autoplay rule requires.
function startContext() {
  context.start();
  return trackmusic.preload();
}

// Used by the SFX gallery (src/demo/sfxgallery.js) — a dev tool with no
// jack_in ceremony of its own, no menu screen, and no reason to delay the
// scheduler's first downbeat against anything. Resolves and starts whichever
// backend won (see resolveBackend() above) at its default offset.
function startMusicLoop() {
  resolveBackend().start();
}

// How long jackIn() waits for trackmusic.js's listing fetch to settle before
// treating a soundtrack as unavailable. The listing endpoint (tools/serve.js's
// GET /api/music) is one readdir() and a tiny JSON array — low single-digit ms
// over loopback — so 300ms is two orders of magnitude of headroom for a slow
// first request, while still leaving over a second of JACK_IN_DURATION's 1.5s
// budget for the chosen backend to start against.
const TRACK_LISTING_TIMEOUT_MS = 300;

// Resolves once trackmusic.js's listing question is answered — either
// because whenListingSettled() actually settled, or because
// TRACK_LISTING_TIMEOUT_MS ran out first, whichever comes first. Resolves
// to `true` when the timeout won that race (so jackIn() knows to log the
// malfunction — a listing fetch that never comes back is not the normal
// "empty music folder" state trackmusic.js's own header documents staying
// silent about, see resolveBackend()'s "AVAILABILITY, NOT READINESS" note),
// `false` when the listing genuinely settled in time.
function waitForTrackAvailability() {
  return new Promise((resolve) => {
    let settled = false;
    trackmusic.whenListingSettled().then(() => {
      if (settled) return;
      settled = true;
      resolve(false);
    });
    setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve(true);
    }, TRACK_LISTING_TIMEOUT_MS);
  });
}

// THE START GAME transition. Bundles two things that must never drift apart:
// the jack_in riser, and the chosen backend's first-note offset, both keyed off
// the SAME sfx.js export (JACK_IN_DURATION) — so main.js's call site is just
// `music.jackIn()` with no number of its own to let drift from the sound it
// lines up with. Called once per page life in practice: CONTINUE and RESTART
// both resume against playback that has been going since this fired. This is
// also the call that FREEZES backend selection for the rest of the page life;
// everything before it only reads trackmusic.js's availability.
//
// THE RISER MUST FIRE SYNCHRONOUSLY, in this gesture-handling tick (see the
// module's BROWSER CONTRACT note), which is why playSfx("jack_in") runs first
// with no await ahead of it — what follows is a `.then()` continuation, so
// jackIn() returns immediately after queuing the riser.
//
// The wait exists because availability can genuinely be UNKNOWN at this instant
// (a very fast player, or a slow first fetch). `ctxTimeAtJackIn` captures
// ctx.currentTime BEFORE any waiting, so the wait is subtracted from
// JACK_IN_DURATION's budget rather than added on top: the first note still
// lands at ctxTimeAtJackIn + JACK_IN_DURATION, flooring at 0 rather than going
// negative in the worst case.
//
// THE VISUAL JACK-IN IS NOT TIMED AGAINST THIS. game/jackin.js runs its own,
// longer ceremony (its CONNECT_DURATION, and its header says why), and it also
// runs on RESTART, which this deliberately does not — so the two are kept
// independent rather than one being handed the other's clock.
function jackIn() {
  // THE SAME NO-THROW CONTRACT every other entry point in this layer honours
  // (see the module header, and context.js's own). Nothing below this line is
  // safe without a live context — getCtx() returns null before start() — and
  // this was the one function in the facade that read it unguarded. It's
  // reachable the moment START GAME can be confirmed by anything that isn't a
  // keypress: main.js only calls startContext() from a keydown listener, while
  // menu.js already hit-tests the mouse for its volume bars, so a clickable
  // row 0 would have turned this into a TypeError on the first click rather
  // than a silent no-op.
  if (!context.isStarted()) return;
  playSfx("jack_in");
  const ctxTimeAtJackIn = context.getCtx().currentTime;
  waitForTrackAvailability().then((timedOut) => {
    if (timedOut) {
      console.warn(
        `[audio] track listing didn't resolve within ${TRACK_LISTING_TIMEOUT_MS}ms of START GAME — falling back to procedural music this run`
      );
    }
    const remaining = Math.max(0, JACK_IN_DURATION - (context.getCtx().currentTime - ctxTimeAtJackIn));
    resolveBackend().start(remaining);
  });
}

// The SYS LOG track announcement's seam — forwards to trackmusic.js's
// onTrackChange, so main.js never imports an audio backend directly.
//
// PROCEDURAL NEVER FIRES THIS, deliberately: the synth loop is one continuous
// voice with no track to hand off between, so there is nothing to report.
// Announcing once at jackIn() and never again would read as a feed that
// connects and then silently drops. Saying nothing for this backend keeps one
// thing always true: whenever this DOES fire, the player is on a recorded track.
function onTrackChange(fn) {
  return trackmusic.onTrackChange(fn);
}

// Dev-only override for the SFX gallery's A/B panel — main.js never calls this.
// Forces resolveBackend()'s otherwise-automatic choice so the two backends can
// be compared against the same SFX. Must be called BEFORE startMusicLoop() or
// jackIn(), since resolveBackend() consults `selectedBackendName` only once.
// Forcing "track" against an empty assets/music/ is safe: trackmusic.js reports
// itself exhausted and the onExhausted handler above starts procedural and logs
// why.
function setBackendPreference(pref) {
  if (pref === "track") selectedBackendName = "track";
  else if (pref === "procedural") selectedBackendName = "procedural";
  else selectedBackendName = null; // "auto" (or anything else) — let resolveBackend() decide normally
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

// The player's connection dropping (game/disconnect.js's sequence). The music
// bus fades to silence DISCONNECT_FADE seconds BEFORE the static begins, so the
// drop lands in a hole rather than under music still audibly playing.
// fadeMusicForDisconnect() ramps from NOW; the SFX is scheduled DISCONNECT_FADE
// into the future via opts.startDelay — both timed off the SAME ctx.currentTime
// instant, so the two can never drift apart.
function playDisconnect() {
  context.fadeMusicForDisconnect();
  playSfx("disconnect", { startDelay: context.DISCONNECT_FADE });
}

// The general SFX entry point — e.g. `music.play("kick_hit")`.
function play(id, opts) {
  playSfx(id, opts);
}

// The sector-transition re-sync: the gong (soundtypes.js's sector_shift) plus
// the musicFilter collapse/reopen (context.js's beginSectorTransition). Bundled
// into one call so main.js's edge-detector on sectors.glitching() has exactly one
// thing to call and the two can never fire out of step.
function triggerSectorTransition() {
  playSfx("sector_shift");
  context.beginSectorTransition();
}

// The sustained-voice drivers — main.js calls these once per "playing" tick.
// Each is a thin forward to sustainedfx.js; see its header for what drives each.
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
//     never inherits a drone/scrape/pulse from the run that just ended — see
//     that function's own header for why this also has to be more than just
//     "silence everything".
//   - context.resetMusicCutoffTransition() cancels a sector-transition
//     collapse/reopen that was still mid-flight when the player died (a
//     crossing and a death can land in the same run's final seconds) and
//     snaps the tracked base/offset state back to "released" — otherwise the
//     NEXT run's first speed-driven setMusicCutoff() call would find a
//     transitionEndTime still in its future and silently suppress its own
//     write (see context.js's own planSetMusicCutoff).
//   - context.restoreMusicAfterDisconnect() re-opens musicDropGain from the
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

// Dev-only, alongside setBackendPreference() above — lets the SFX gallery
// show which backend actually ended up playing ("auto" can resolve either
// way depending on whether a track had finished decoding in time) and,
// when it's the track backend, which file. main.js never calls either.
function getSelectedBackendName() {
  return selectedBackendName;
}
function currentTrackName() {
  return trackmusic.currentTrackName();
}

export function createMusic() {
  return {
    startContext, startMusicLoop, jackIn, setVolume, setSfxVolume, playDisconnect, play,
    triggerSectorTransition,
    updateShieldDrone, updateWallScrape,
    updateDreadPulse, updateMusicCutoff, resetForNewRun,
    setBackendPreference, getSelectedBackendName, currentTrackName,
    onTrackChange,
  };
}
