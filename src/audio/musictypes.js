// Track-backend configuration, as data — mirrors soundtypes.js's own
// convention (see that file's header): gameplay/mix tuning lives in one
// small file so it can be retuned without touching the code that reads it.
// Everything trackmusic.js and tools/serve.js need to agree on about WHERE
// the music lives, and everything trackmusic.js needs to know about HOW
// LOUD it should be, is collected here.
//
// A NODE-SAFE FILE ON PURPOSE. This is imported by tools/serve.js (a Node
// server) as well as trackmusic.js (browser-only) — see MUSIC_DIR/
// MUSIC_LISTING_URL below, the single source of truth for the path both
// sides have to agree on. Nothing here may reference `window`, `document`,
// or any Web Audio global, the same DOM-free contract context.js's own
// header documents for the rest of this audio layer's data files.

// Relative to the repo root. tools/serve.js's GET /api/music lists exactly
// this directory (see that file), and trackmusic.js fetches track bytes
// from the same path — so a change here only ever needs to happen in one
// place for both sides to stay in sync.
export const MUSIC_DIR = "assets/music";

// The directory-listing endpoint's URL — see tools/serve.js's own handler.
// A plain constant rather than deriving it from MUSIC_DIR because the two
// are conceptually different things (a filesystem path vs. an API route)
// that only happen to want the word "music" in both today; deriving one
// from the other would make a future rename of either look like it should
// change the other too, when it doesn't have to.
export const MUSIC_LISTING_URL = "/api/music";

// trackmusic.js's OWN gain trim (0..1), applied on trackmusic's own gain
// node BEFORE the signal reaches context.js's getMusicBus() — see that
// module's header for why this can't just be context.js's musicGain (the
// MUSIC slider, shared by both backends, has no opinion about which one is
// currently feeding it). A recorded track and the procedural synth loop
// were never mixed against each other, so they will not sit at the same
// perceived loudness by coincidence; this is where that gets corrected.
// Start conservative — recorded/mastered material tends to read louder
// than a synthesized pad at the same nominal gain — and retune once a real
// track has actually been checked by ear against the procedural loop.
export const TRACK_GAIN = 0.8;

// Per-filename overrides, keyed by the exact name tools/serve.js's listing
// endpoint returns (the DECODED filename — see trackmusic.js's own header
// on where percent-encoding happens and why it's never part of the key
// here). Empty by default; a specific track that turns out too loud or
// too quiet once auditioned gets one entry here rather than a re-export or
// a special case in trackmusic.js. `title`, alongside `gain`, is the same
// idea applied to the SYS LOG announcement (main.js's onTrackChange, wired
// through trackmusic.js's own onTrackChange seam — see that file's header):
// trackDisplayName()'s automatic name derivation reads a raw filename
// fine most of the time, but an awkward one can be given a proper name
// here instead of renaming the file on disk.
export const TRACK_OVERRIDES = {
  // "under_chrome.ogg": { gain: 0.9, title: "UNDER CHROME" },
};

// The gain trackmusic.js should actually use for `name` — its own override
// if one exists, else the blanket TRACK_GAIN above.
export function trackGainFor(name) {
  const override = TRACK_OVERRIDES[name];
  return override?.gain ?? TRACK_GAIN;
}

// The SYS LOG display name for `name` — its own override title if one
// exists, else the filename itself, stripped of its extension, with
// underscores read as word breaks and everything upper-cased to match the
// console's own all-caps register (engine/console.js's render, links.js's
// callsigns): "under_chrome.ogg" -> "UNDER CHROME".
export function trackDisplayName(name) {
  const override = TRACK_OVERRIDES[name];
  if (override?.title) return override.title;
  return name.replace(/\.[^.]+$/, "").replace(/_/g, " ").toUpperCase();
}

// Defensive config validation, exercised by the invariant tests so a typo
// (a gain outside 0..1, an empty path) fails loudly in `npm test` rather
// than silently producing a NaN gain or a broken listing URL at runtime.
// Takes its subject as parameters (defaulting to this file's own exports)
// rather than only ever validating the live module state, so a test can
// feed it a deliberately-broken config and check the error comes back
// without having to mutate this file's real exports to do it.
export function validateMusicConfig({
  musicDir = MUSIC_DIR,
  listingUrl = MUSIC_LISTING_URL,
  trackGain = TRACK_GAIN,
  overrides = TRACK_OVERRIDES,
} = {}) {
  const errors = [];
  if (!musicDir || typeof musicDir !== "string") errors.push("MUSIC_DIR must be a non-empty string");
  if (!listingUrl || typeof listingUrl !== "string" || !listingUrl.startsWith("/")) {
    errors.push("MUSIC_LISTING_URL must be a non-empty, root-relative path");
  }
  if (!(trackGain >= 0 && trackGain <= 1)) errors.push(`TRACK_GAIN ${trackGain} must be in 0..1`);
  for (const [name, cfg] of Object.entries(overrides)) {
    if (!(cfg.gain >= 0 && cfg.gain <= 1)) errors.push(`TRACK_OVERRIDES["${name}"].gain ${cfg.gain} must be in 0..1`);
  }
  return errors;
}
