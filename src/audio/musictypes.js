// Track-backend configuration, as data — mirrors soundtypes.js's own
// convention (see that file's header): gameplay/mix tuning lives in one
// small file so it can be retuned without touching the code that reads it.
// Everything trackmusic.js and tools/serve.js need to agree on about WHERE
// the music lives, and everything trackmusic.js needs to know about HOW
// LOUD it should be, is collected here.
//
// A NODE-SAFE FILE ON PURPOSE. This is imported by tools/musicmanifest.js (a
// Node script) as well as trackmusic.js (browser-only) — see MUSIC_DIR/
// MUSIC_LISTING_URL below, the single source of truth for the paths the
// generator and the player have to agree on. Nothing here may reference
// `window`, `document`, or any Web Audio global, the same DOM-free contract
// context.js's own header documents for the rest of this audio layer's data
// files.

// Where the soundtrack lives. BOTH constants below are RELATIVE, with no
// leading slash, and that is load-bearing rather than incidental: a relative
// URL resolves against the page's own address, so the game works served from
// a domain root (tools/serve.js at localhost) AND from a subdirectory (a
// GitHub Pages project site at /Cybercruise/, an itch.io game frame) with no
// per-host configuration. A root-absolute "/assets/music" would resolve to
// the DOMAIN root on those hosts — outside the site entirely — and every
// track would 404. validateMusicConfig() below enforces this.
//
// tools/musicmanifest.js lists exactly this directory when it generates the
// manifest, and trackmusic.js fetches track bytes from the same path, so a
// change here only ever needs to happen in one place for both sides to stay
// in sync.
export const MUSIC_DIR = "assets/music";

// The generated track listing — tools/musicmanifest.js writes this file,
// trackmusic.js and the SFX gallery read it. See that generator's header for
// why the listing is a committed static file rather than the live server
// endpoint it used to be (short version: static hosts have no endpoints).
//
// A plain constant rather than deriving it from MUSIC_DIR because the two
// are conceptually different things (the directory of audio vs. the one
// metadata file describing it) that only happen to share a prefix today;
// deriving one from the other would make a future move of either look like
// it should move the other too, when it doesn't have to. musicmanifest.js
// takes the BASENAME of this to decide what to write, so the two cannot
// drift apart into "generates tracks.json, fetches listing.json".
export const MUSIC_LISTING_URL = "assets/music/tracks.json";

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

// The sample rate music is DECODED at, in Hz — the single biggest lever on
// this game's memory footprint, and the reason this constant exists at all.
//
// decodeAudioData expands compressed audio to Float32 PCM at the sample rate
// of the context doing the decoding, which is where the cost hides: measured
// on the published build, chase.ogg is 2.6MB on disk and 71MB decoded at
// 48kHz, and under_chrome.ogg is 3.8MB on disk and 110MB decoded. Since
// trackmusic.js deliberately keeps the current track AND the stream-ahead
// decoded at once (see its header), the soundtrack alone was holding
// 140-220MB resident for a whole session — on top of everything the game
// itself allocates, and with a fresh buffer of that size allocated (and the
// outgoing one collected) at every track change, mid-gameplay.
//
// RE-ENCODING THE SOURCE FILES AT A LOWER RATE WOULD NOT HELP: decodeAudioData
// resamples to the DECODING CONTEXT's rate regardless of what the file says,
// so a 24kHz .ogg still expands to 48kHz PCM in a 48kHz context. Decoding in
// an OfflineAudioContext at this rate is what actually halves it, and the
// resulting buffer plays back fine in the game's own 48kHz context —
// AudioBufferSourceNode resamples on the fly, and keeps .detune, .loop and
// sample-accurate .start() exactly as trackmusic.js already uses them. That
// full-fidelity playback path is why this is a memory fix and not a rewrite.
//
// THE TRADE IS TREBLE. 24kHz can only represent frequencies up to 12kHz
// (Nyquist), so cymbals and synth sheen lose their top end; the pads, bass
// and drums this soundtrack is mostly made of are untouched. 24000 is the
// starting point rather than the settled answer — it is meant to be checked
// by ear against the procedural backend, the same way TRACK_GAIN above is,
// with 32000 (16kHz ceiling, ~1.5x the memory) as the fallback if the mix
// reads dull. Decoding also gets SLOWER at a reduced rate, not faster
// (~560ms vs ~356ms for chase.ogg — the resample is extra work), which
// doesn't stall rendering because decodeAudioData runs off the main thread;
// it is the allocation and collection of the buffer that the main thread
// pays for, and that is what this halves.
export const TRACK_DECODE_SAMPLE_RATE = 24000;

// The bounds validateMusicConfig() holds TRACK_DECODE_SAMPLE_RATE to. The Web
// Audio spec permits 3000..768000, but this range is the useful one: below
// 8000 the music is telephone-grade to the point of being a bug, and above
// 48000 it would be spending MORE memory than decoding natively ever did,
// which is the exact opposite of why this knob exists.
export const TRACK_DECODE_RATE_MIN = 8000;
export const TRACK_DECODE_RATE_MAX = 48000;

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
  decodeSampleRate = TRACK_DECODE_SAMPLE_RATE,
  overrides = TRACK_OVERRIDES,
} = {}) {
  const errors = [];
  if (!musicDir || typeof musicDir !== "string") errors.push("MUSIC_DIR must be a non-empty string");
  if (typeof musicDir === "string" && musicDir.startsWith("/")) {
    errors.push("MUSIC_DIR must be relative (no leading slash) so the game works from a subdirectory");
  }
  if (!listingUrl || typeof listingUrl !== "string" || listingUrl.startsWith("/")) {
    errors.push("MUSIC_LISTING_URL must be a non-empty, RELATIVE path (no leading slash) so the game works from a subdirectory");
  }
  if (!(trackGain >= 0 && trackGain <= 1)) errors.push(`TRACK_GAIN ${trackGain} must be in 0..1`);
  if (!(decodeSampleRate >= TRACK_DECODE_RATE_MIN && decodeSampleRate <= TRACK_DECODE_RATE_MAX)) {
    errors.push(
      `TRACK_DECODE_SAMPLE_RATE ${decodeSampleRate} must be in ${TRACK_DECODE_RATE_MIN}..${TRACK_DECODE_RATE_MAX} Hz`,
    );
  }
  for (const [name, cfg] of Object.entries(overrides)) {
    if (!(cfg.gain >= 0 && cfg.gain <= 1)) errors.push(`TRACK_OVERRIDES["${name}"].gain ${cfg.gain} must be in 0..1`);
  }
  return errors;
}
