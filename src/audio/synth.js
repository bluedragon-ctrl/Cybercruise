// Phase 8's audio facade — the only file main.js imports from. Everything
// this used to do directly (own the AudioContext, schedule the music loop,
// play the one SFX) now lives in a handful of focused modules this just
// wires together, so a future call site never has to know the split
// happened:
//
//   context.js   the AudioContext + permanent bus graph, ducking, the voice
//                limiter — see its header for the bus diagram
//   proceduralmusic.js + trackmusic.js   TWO interchangeable music
//                backends — see "Music backend selection" below
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
// actually starts the chosen music backend's scheduler/playback. main.js
// also calls setVolume() / setSfxVolume() to mirror menu.js's MUSIC and
// SOUND levels respectively. This module never reads menu.js or
// localStorage itself — same wiring pattern as fireShot/dropMine in
// main.js, where the owning module (menu.js) stays ignorant of the system
// it's wired into.
//
// IMPORTANT BROWSER CONTRACT: an AudioContext is born (or stays) "suspended"
// unless created/resumed inside the aftermath of a real user gesture — see
// startContext()'s call site. Calling it from a keydown-driven handler (as
// main.js does) satisfies that; calling it at module load would not, and the
// whole engine would silently produce no sound. Nothing in context.js,
// proceduralmusic.js, trackmusic.js, soundtypes.js or sfx.js constructs an
// AudioContext at import time either — see context.js's own header on the
// same rule.
//
// --- Music backend selection ------------------------------------------------
//
// Two backends implement the exact same interface this facade already
// relied on before either existed as a separate concept — literally just
// the two things any call site below ever asks "the music" to do:
// start(delaySeconds) and disturb(amount). Nothing wider is assumed
// anywhere in this file on purpose (see MUSIC_BACKEND_METHODS below), so a
// future third backend, or a rewrite of either existing one, only ever has
// to honour those two calls.
//
//   proceduralmusic.js   the original synthesized loop (Phase 8's own
//                         proceduralmusic.js, renamed). ALWAYS available — nothing
//                         about it can be "missing" the way a file can.
//   trackmusic.js         recorded Ogg Vorbis tracks from assets/music/.
//                         Depends on a directory listing fetch, a track
//                         actually being present, and it successfully
//                         decoding — none of which are guaranteed.
//
// Selection is resolved ONCE, lazily, by resolveBackend() below, the first
// time anything asks the facade to actually start playing — and never
// re-evaluated after that, even if a track finishes decoding moments later
// or a later track in the playlist fails. WHY FROZEN: swapping backends
// mid-run would mean the music instantaneously jumping from a recorded
// track to the synth loop (or back) with no transition, which reads as a
// bug no matter what triggers it. A run either got a working track backend
// from the start or it didn't — see trackmusic.js's own isAvailable() for
// what "working" means, and its header for why an empty/missing/failed
// music directory is a normal state, not an error, that this fallback
// exists for.
//
// AVAILABILITY, NOT READINESS. resolveBackend() keys the choice off
// trackmusic.js's isAvailable() (a soundtrack EXISTS — the directory
// listing came back with at least one track), not its isReady() (a track
// has actually finished decoding). Those used to be the same question here
// and shouldn't have been: the listing is a small JSON fetch, typically
// long resolved before the player has finished navigating the menu, but
// decoding several MB of Ogg is not — a player who presses START GAME
// promptly was losing that race and getting the procedural loop for the
// whole session despite a perfectly good soundtrack sitting on disk. See
// trackmusic.js's own header for the isReady()/isAvailable() split this
// fixed, and jackIn() below for how a "track" choice made before the first
// buffer exists is still made safe (trackmusic.js's start() awaits the
// SAME in-flight decode rather than assuming it's already done).
//
// Availability itself can take a moment to be KNOWN, even though it's fast
// once known — see jackIn()'s own comment on the bounded wait that covers
// the (rare) case where the listing hasn't resolved yet when START GAME is
// confirmed.
import * as context from "./context.js";
import * as proceduralmusic from "./proceduralmusic.js";
import * as trackmusic from "./trackmusic.js";
import { play as playSfx, JACK_IN_DURATION } from "./sfx.js";
import * as sustainedfx from "./sustainedfx.js";

// Documents the interface both backends implement — not enforced by the
// language, just the two names every call site below (and the invariant
// tests, which assert both backend modules actually export exactly these
// as functions) agree to.
export const MUSIC_BACKEND_METHODS = ["start", "disturb"];

// Pure: the decision resolveBackend() makes on every call. `alreadySelected`
// is null before the first decision this page life, or "track"/"procedural"
// once frozen (see the header above); `available` is trackmusic.js's own
// isAvailable() — a soundtrack EXISTS, not necessarily that it has finished
// decoding yet (see trackmusic.js's header on the isReady()/isAvailable()
// split, and its start()/attemptStart() for why committing to "track" ahead
// of the decode is safe). Exported for the invariant tests, which can't
// construct a real trackmusic state (that requires fetch + decodeAudioData,
// unavailable under plain Node — see trackmusic.js's own header) but CAN
// exercise this decision directly: track when available, procedural when
// not (which covers "listing failed" and "directory empty" alike —
// trackmusic.js's isAvailable() collapses both to the same false), and —
// the important one — an ALREADY-frozen choice never changes even if
// `available` flips. Note this now resolves to "track" for the THIRD state
// the old trackReady boolean used to collapse into "procedural": a listing
// that came back with tracks but whose first one hasn't decoded yet —
// see the invariant tests below for that case made explicit.
export function chooseBackend(alreadySelected, available) {
  if (alreadySelected) return alreadySelected;
  return available ? "track" : "procedural";
}

let selectedBackendName = null; // null until resolveBackend()'s first call this page life — see chooseBackend()'s own header

function resolveBackend() {
  selectedBackendName = chooseBackend(selectedBackendName, trackmusic.isAvailable());
  return selectedBackendName === "track" ? trackmusic : proceduralmusic;
}

// The last-resort guard for trackmusic.js's one truly-fatal case: EVERY
// track in the directory failing to decode, discovered only after start()
// already committed to the track backend (see resolveBackend() above and
// trackmusic.js's own attemptStart()). Registered ONCE, here, at module
// scope — not per-run — because backend selection itself is a once-per-
// page-life decision (see the module header); there's nothing to re-arm.
//
// Why this doesn't violate the freeze contract: that contract is about an
// AUDIBLE mid-run swap (see the module header's own reasoning) — this fires
// strictly before trackmusic.js has ever played a single sample this run
// (attemptStart() only reaches the exhaustion branch when it found nothing
// playable, ever), so there is no "already sounding thing" for procedural
// to audibly replace. Flipping selectedBackendName here reflects that: the
// run genuinely ends up on procedural, and getSelectedBackendName() (the
// SFX gallery's own introspection) should say so.
trackmusic.onExhausted(() => {
  console.error(
    "[audio] every track in assets/music/ failed to decode — falling back to procedural music (nothing had played yet this run, so this is not a mid-run swap)"
  );
  selectedBackendName = "procedural";
  proceduralmusic.start(0); // no riser to line up with any more — this fires well after jackIn()'s own timing budget has already been spent walking the playlist, so start as soon as possible rather than trying to reconstruct a delay against a moment now in the past
});

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
//     own confirm — it starts the chosen backend's playback, timed against
//     the jack_in riser it also plays. See its own comment for why the two
//     concerns don't collapse back into one function despite both now
//     running from the very same keypress on a typical first-ever session.
//
// This is also the earliest legal moment to kick off trackmusic.js's own
// preload() (fetch the listing, start decoding the first track) — a real
// AudioContext has to exist first (decodeAudioData is one of its methods),
// and starting any later would waste however long the player spends on the
// menu screen before confirming START GAME. See trackmusic.js's own header
// for why that head start matters: decoding is streamed one track ahead,
// never all at once, so the FIRST track's decode is the one thing on the
// critical path between "player presses START GAME" and "track backend is
// ready" — everything after it happens in the background regardless.
//
// Returns preload()'s promise so a caller with no menu-screen idle time to
// lean on (the SFX gallery, which goes straight from this call to
// startMusicLoop() — see its own header on why) can `await` it first,
// giving the track backend a real chance to be ready before resolveBackend()
// makes its one-time decision. main.js ignores the return value entirely:
// context.start() itself still runs synchronously, in the same gesture-
// handling tick, which is all the browser's autoplay-gesture rule actually
// requires (see the module header) — awaiting the rest is optional.
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

// How long jackIn() (below) will wait for trackmusic.js's listing fetch to
// settle before giving up and treating a soundtrack as unavailable. Bounded
// deliberately, not a round number: the listing endpoint (tools/serve.js's
// GET /api/music) does one readdir() over a local directory and returns a
// tiny JSON array — on a loopback HTTP connection that's a low-single-digit-
// millisecond round trip in the normal case, no disk latency worth
// measuring for a folder of a handful of files. 300ms is roughly two orders
// of magnitude of headroom above that for a slow first request (TCP
// handshake, an unusually loaded machine), while still leaving well over a
// second of JACK_IN_DURATION's 1.5s budget for the chosen backend to start
// against — see waitForTrackAvailability() and jackIn() below for how that
// remaining budget is preserved rather than silently shortened.
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

// THE START GAME transition. Bundles two things that must never drift apart
// (see soundtypes.js's own jack_in entry and each backend's own start()
// header): the jack_in riser, and the chosen backend's own first-note
// offset, both keyed off the SAME sfx.js export (JACK_IN_DURATION) — so
// main.js's call site is just `music.jackIn()`, with no number of its own
// to accidentally mistype or let drift from the sound it's supposed to line
// up with. Only ever called once per page life in practice: menu.js's
// "start" mode (see its own header) only opens before the very first game,
// so this is the ONE call site that ever starts either backend — CONTINUE
// (pause) and RESTART (gameover) both resume a run against playback that's
// already been going continuously since this fired. This is also the call
// that FREEZES backend selection for the rest of the page life (see
// resolveBackend()'s own header) — everything before this point (menu
// previews, the preload triggered by startContext()) only ever reads
// trackmusic.js's availability, never commits to it.
//
// THE RISER MUST STILL FIRE SYNCHRONOUSLY, in this same gesture-handling
// tick — see the module's own BROWSER CONTRACT note. That's why
// playSfx("jack_in") runs before anything else here, with no `await` ahead
// of it: what follows (waiting, possibly, for the listing) is a `.then()`
// continuation, not a blocking await, so jackIn() itself still returns
// immediately after queuing the riser.
//
// The wait exists because availability can genuinely be UNKNOWN at this
// exact moment (a very fast player, or a slow first fetch) — see
// resolveBackend()'s own header on why guessing either way here would be
// wrong. `ctxTimeAtJackIn` captures ctx.currentTime BEFORE any waiting, so
// that whatever the wait costs is subtracted from JACK_IN_DURATION's own
// budget rather than added on top of it: the backend's first note still
// lands at ctxTimeAtJackIn + JACK_IN_DURATION, same as if there'd been no
// wait at all, right up until TRACK_LISTING_TIMEOUT_MS itself would exceed
// that budget (it doesn't, by design — see its own comment), at which
// point the remaining delay simply floors at 0 rather than going negative.
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

// The SYS LOG track announcement's seam — forwards straight to
// trackmusic.js's own onTrackChange (see that file's header), the same
// one-line forward every other capability in this facade gets, so main.js
// never has to import an audio backend directly. main.js calls this once,
// at module scope, right after createMusic() — see its own call site.
//
// PROCEDURAL NEVER FIRES THIS, deliberately, not an oversight: the synth
// loop is one continuous voice with no "track" to hand off between (see
// proceduralmusic.js's own header — the whole progression loops forever
// once start() schedules it), so there is nothing here for it to report.
// The alternative — announcing it once at jackIn() and then never again for
// the rest of the run — would read as a feed that connects once and then
// silently drops, which is exactly the confusion the design brief calls
// out. Saying nothing, always, for this backend is the one choice that
// stays true every single run: whenever this DOES fire, the player is
// listening to a recorded track, full stop.
function onTrackChange(fn) {
  return trackmusic.onTrackChange(fn);
}

// Dev-only override for the SFX gallery's A/B panel (src/demo/
// sfxgallery.js) — main.js never calls this. Forces resolveBackend()'s
// otherwise-automatic choice, so the comparison the design brief actually
// asks for ("procedural and track can be A/B'd against the same SFX") can
// be driven deliberately instead of left to whichever backend happened to
// be available first. Must be called before startMusicLoop()/jackIn() —
// resolveBackend() only ever consults `selectedBackendName` once, same
// frozen-per-run contract as the automatic path; forcing "track" when
// there's genuinely nothing to play (an empty assets/music/, the common
// case for anyone who cloned the repo without copying music in) now means
// trackmusic.js's own attemptStart() finds the playlist empty, reports
// itself exhausted, and this facade's onExhausted handler (above) starts
// procedural instead and logs why — no longer the silent no-op this used
// to be back when the backend was only ever chosen after isReady() was
// already true.
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

// The player's connection dropping (game/disconnect.js's sequence). Phase 8
// step 5's disconnect polish folds in one more thing: the music bus now
// fades to silence context.js's own DISCONNECT_FADE seconds BEFORE the SFX's
// own static begins, "so the drop lands in a hole" per the design brief,
// rather than the TV-switching-off sound landing under music still audibly
// playing. fadeMusicForDisconnect() ramps musicDropGain starting NOW; the SFX
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

// Phase 8 step 3's music-disturbance seam — exposed here rather than main.js
// importing a backend module directly, same reason every other capability
// in this facade is forwarded one call at a time. Forwards to WHICHEVER
// backend is already selected (never resolveBackend() — see its own
// header): if nothing has started playing yet there is nothing to
// disturb, so this is a harmless no-op rather than a reason to prematurely
// freeze the selection a moment before jackIn()/startMusicLoop() would have
// anyway.
function disturb(amount) {
  if (selectedBackendName === "track") trackmusic.disturb(amount);
  else if (selectedBackendName === "procedural") proceduralmusic.disturb(amount);
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
    startContext, startMusicLoop, jackIn, setVolume, setSfxVolume, playDisconnect, play, disturb,
    triggerSectorTransition,
    updateHullHiss, updateShieldDrone, updateWallScrape,
    updateDreadPulse, updateMusicCutoff, resetForNewRun,
    setBackendPreference, getSelectedBackendName, currentTrackName,
    onTrackChange,
  };
}
